/**
 * 附件上传分级策略（R15）自测。
 *
 * 跑法（workdir = projects\deepseek-tablet\web）：
 *   npx tsx src/services/remote/__selftest__/upload.selftest.mts
 *
 * 覆盖任务书点名要自测的五项，逐条对上：
 *   A. **分级判定表**：`planUpload()` 的每一行（含 20 MiB / 1 GiB 两条上限）。
 *   B. **405 不隐藏 UI**：`fileUploads/upload` 回 `METHOD_NOT_ALLOWED` 时自动降级，
 *      入口保持可用（`uploadSupported !== false`），chip 带上工作区路径与引用。
 *   C. **chunk 顺序与 abort**：offset 严格递增、ack 校验、失败必 abort、commit 不脏跑。
 *   D. **20 MiB 上限**：Relay 上本地先拦（不发任何 RPC）；LAN/P2P 才给 1 GiB。
 *   E. **引用落进消息**：工作区路径 → `@name` / `@"a b.png"`，`file` 块里不出现假收据。
 *   F. 名字消毒 / uploadId 形状（Host 的 zod 不认就直接 `UPLOAD_INVALID_NAME`）。
 *
 * 结尾按仓库约定设置真实退出码。
 */

import {
  MAX_INLINE_UPLOAD_BYTES,
  MAX_WORKSPACE_UPLOAD_BYTES,
  MAX_WORKSPACE_UPLOAD_BYTES_DIRECT,
} from '../filesApi.js'
import { observeRemoteTarget, sendPrompt, workspaceReferenceToken, type RemoteCallTarget } from '../sessionsApi.js'
import { useRemoteStore } from '../store.js'
import {
  isUploadUnavailable,
  newUploadId,
  outcomeReference,
  outcomeToken,
  planUpload,
  resetUploadStrategy,
  sanitizeWorkspaceUploadName,
  uploadAttachment,
  uploadErrorReasonOf,
  uploadStrategyMemory,
  workspaceUploadLimitBytes,
} from '../upload.js'
import { readyReceipts, useWorkspacePane } from '../../../components/remote/workspace/workspacePaneStore.js'

/* ── 最小断言器（与其它 selftest 同一套写法） ─────────────────────────── */

const checks: Array<{ name: string; run: () => Promise<void> }> = []
const check = (name: string, run: () => Promise<void>): void => {
  checks.push({ name, run })
}

const fail = (message: string): never => {
  throw new Error(message)
}

const assertEqual = (actual: unknown, expected: unknown, label: string): void => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) fail(`${label}：期望 ${e}，实际 ${a}`)
}

const assertTrue = (value: unknown, label: string): void => {
  if (value !== true) fail(`${label}：期望 true，实际 ${JSON.stringify(value)}`)
}

const assertFalse = (value: unknown, label: string): void => {
  if (value !== false) fail(`${label}：期望 false，实际 ${JSON.stringify(value)}`)
}

const assertThrows = async (run: () => unknown | Promise<unknown>, label: string, code?: string): Promise<unknown> => {
  try {
    await run()
  } catch (error) {
    const actual = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : ''
    if (code !== undefined && actual !== code) fail(`${label}：期望错误码 ${code}，实际 ${actual || '(无码)'}`)
    return error
  }
  return fail(`${label}：应当抛错，但没有抛`)
}

/* ── 内存版 localStorage（store / 设置初始化要读盘） ──────────────────── */

class MemoryStorage {
  private readonly data = new Map<string, string>()

  get length(): number {
    return this.data.size
  }

  clear(): void {
    this.data.clear()
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.data.delete(key)
  }

  setItem(key: string, value: string): void {
    this.data.set(key, String(value))
  }
}

;(globalThis as unknown as Record<string, unknown>).localStorage = new MemoryStorage()

/* ── 假 target：既能发 Gateway 调用，也能发顶层 `workspace.upload.*` ──── */

type Reply =
  | { ok: true; value?: unknown }
  | { ok: false; code: string; message?: string }

interface RecordedCall {
  method: string
  endpoint?: string
  args?: unknown
  params?: unknown
}

type Layer = Record<string, Reply | ((args: unknown, call: number) => Reply | Promise<Reply>)>

interface FakeTarget {
  target: RemoteCallTarget
  calls: RecordedCall[]
}

const fakeTarget = (layers: { endpoints?: Layer; methods?: Layer } = {}): FakeTarget => {
  const calls: RecordedCall[] = []
  const seen = new Map<string, number>()
  const replyOf = async (layer: Layer | undefined, key: string, input: unknown): Promise<Reply> => {
    const count = (seen.get(key) ?? 0) + 1
    seen.set(key, count)
    const configured = layer?.[key]
    if (configured === undefined) return { ok: true, value: {} }
    return typeof configured === 'function' ? await configured(input, count) : configured
  }
  const target: RemoteCallTarget = {
    rpc: async <T,>(method: string, params?: unknown): Promise<T> => {
      if (method !== 'harness.remote.call') {
        // 顶层方法（`workspace.upload.*`）：没有 `{ok,value}` 壳，错误直接抛
        calls.push({ method, params })
        const reply = await replyOf(layers.methods, method, params)
        if (reply.ok) return (reply.value ?? {}) as T
        throw Object.assign(new Error(reply.message ?? reply.code), { code: reply.code })
      }
      const envelope = params as { endpoint: string; payload: { args: unknown } }
      calls.push({ method, endpoint: envelope.endpoint, args: envelope.payload.args })
      const reply = await replyOf(layers.endpoints, envelope.endpoint, envelope.payload.args)
      // Gateway 的失败是 `{ok:false, error:{code,message}}`（`sessionsApi.unwrapEnvelope` 只认这个形状）
      if (reply.ok) return (reply.value === undefined ? { ok: true } : { ok: true, value: reply.value }) as T
      return { ok: false, error: { code: reply.code, message: reply.message ?? reply.code } } as T
    },
    openStream: async () => {
      throw new Error('本自测不开流')
    },
  }
  return { target, calls }
}

const callsTo = (fake: FakeTarget, method: string): RecordedCall[] =>
  fake.calls.filter((call) => call.method === method)

const endpointCalls = (fake: FakeTarget, endpoint: string): RecordedCall[] =>
  fake.calls.filter((call) => call.endpoint === endpoint)

/* ── 造字节 / 会话 ───────────────────────────────────────────────────── */

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text)

const ramp = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length)
  for (let index = 0; index < length; index += 1) bytes[index] = index % 251
  return bytes
}

const base64Of = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')

const CAPABILITY_ON = ['harness.remote.v3', 'workspace.upload.v1']
const CAPABILITY_OFF = ['harness.remote.v3']

/** 把 store 摆成「已连上、Host 声明了工作区上传」。 */
const connect = (fake: FakeTarget, options: { capabilities?: readonly string[]; transport?: string } = {}): void => {
  resetUploadStrategy()
  observeRemoteTarget(fake.target)
  useRemoteStore.setState({
    phase: 'ready',
    capabilities: [...(options.capabilities ?? CAPABILITY_ON)],
    transport: (options.transport ?? 'relay') as 'lan' | 'p2p' | 'relay' | 'turn',
  })
  useWorkspacePane.setState({
    scopeId: 's-1',
    uploadSupported: null,
    uploadUnavailableReason: null,
    uploadUnavailableCode: null,
    uploadError: null,
    attachments: [],
  })
}

/** `workspace.upload.*` 的正常应答（按真实 0.5.22 的形状，并把 open 的 totalBytes 带到 commit）。 */
const workspaceUploadHost = (options: { failChunkAt?: number; chunkBytes?: number } = {}) => {
  const chunkBytes = options.chunkBytes ?? 65536
  const opened = new Map<string, { totalBytes: number; name: string }>()
  return {
    'workspace.upload.open': (async (params: unknown) => {
      const { uploadId, name, totalBytes } = params as { uploadId: string; name: string; totalBytes: number }
      opened.set(uploadId, { totalBytes, name })
      return { ok: true as const, value: { uploadId, chunkBytes } }
    }) as Layer[string],
    'workspace.upload.chunk': (async (params: unknown, call: number) => {
      if (options.failChunkAt !== undefined && call === options.failChunkAt) {
        return { ok: false as const, code: 'UPLOAD_INVALID_CHUNK', message: '这块被拒' }
      }
      const { uploadId, offset, data } = params as { uploadId: string; offset: number; data: string }
      const decoded = Buffer.from(data, 'base64')
      return { ok: true as const, value: { uploadId, receivedBytes: offset + decoded.byteLength } }
    }) as Layer[string],
    'workspace.upload.commit': (async (params: unknown) => {
      const { uploadId } = params as { uploadId: string }
      const entry = opened.get(uploadId)
      if (entry === undefined) return { ok: false as const, code: 'UPLOAD_NOT_FOUND' }
      return { ok: true as const, value: { name: entry.name, path: `./${entry.name}`, bytes: entry.totalBytes } }
    }) as Layer[string],
    'workspace.upload.abort': { ok: true as const, value: { aborted: true } } as Reply,
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * A. 分级判定表
 * ══════════════════════════════════════════════════════════════════════ */

check('A1：两条都新鲜 → 先 receipt、后 workspace', async () => {
  const plan = planUpload({ bytes: 200 * 1024, capabilities: CAPABILITY_ON, transport: 'relay' })
  assertEqual(plan.order, ['receipt', 'workspace'], '顺序')
  assertEqual(plan.reason, undefined, '不需要原因')
})

check('A2：receipt 被拒过 → 只剩 workspace', async () => {
  const plan = planUpload({ bytes: 200 * 1024, capabilities: CAPABILITY_ON, transport: 'relay', receiptUnavailableCode: 'METHOD_NOT_ALLOWED' })
  assertEqual(plan.order, ['workspace'], '只走工作区')
})

check('A3：Host 没声明 workspace.upload.v1（清单非空）→ 只剩 receipt', async () => {
  const plan = planUpload({ bytes: 200 * 1024, capabilities: CAPABILITY_OFF, transport: 'relay' })
  assertEqual(plan.order, ['receipt'], '只走收据')
})

check('A4：能力清单为空 = 未知（不是「没有」）→ 两条都留着', async () => {
  const plan = planUpload({ bytes: 200 * 1024, capabilities: [], transport: 'relay' })
  assertEqual(plan.order, ['receipt', 'workspace'], '未知不判死')
})

check('A5：>30 MiB 但工作区装得下（LAN/P2P）→ 只走 workspace', async () => {
  const bytes = 40 * 1024 * 1024
  const direct = planUpload({ bytes, capabilities: CAPABILITY_ON, transport: 'p2p' })
  assertEqual(direct.order, ['workspace'], 'P2P 40 MiB')
  assertEqual(workspaceUploadLimitBytes('p2p'), MAX_WORKSPACE_UPLOAD_BYTES_DIRECT, 'P2P 上限 1 GiB')
  const relay = planUpload({ bytes, capabilities: CAPABILITY_ON, transport: 'relay' })
  assertEqual(relay.order, [], 'Relay 40 MiB 两条都不行')
  assertEqual(relay.reason, 'too-large', '原因是太大')
})

check('A6：receipt 被拒 + 没有工作区能力 → 空计划（both-unavailable）', async () => {
  const plan = planUpload({
    bytes: 1024,
    capabilities: CAPABILITY_OFF,
    transport: 'relay',
    receiptUnavailableCode: 'METHOD_NOT_ALLOWED',
  })
  assertEqual(plan.order, [], '没有通道')
  assertEqual(plan.reason, 'workspace-capability-missing', '原因是缺能力')
})

check('A7：only 参数可以单向锁死（排障用）', async () => {
  assertEqual(planUpload({ bytes: 1024, capabilities: CAPABILITY_ON, transport: 'relay', only: 'workspace' }).order, ['workspace'], '只要 workspace')
  assertEqual(planUpload({ bytes: 1024, capabilities: CAPABILITY_ON, transport: 'relay', only: 'receipt' }).order, ['receipt'], '只要 receipt')
})

/* ══════════════════════════════════════════════════════════════════════
 * B. 405 / METHOD_NOT_ALLOWED 不隐藏 UI
 * ══════════════════════════════════════════════════════════════════════ */

check('B1：fileUploads/upload 回 METHOD_NOT_ALLOWED → 自动降级，入口保持可用', async () => {
  const bytes = bytesOf('PNGDATA')
  const fake = fakeTarget({
    endpoints: { 'fileUploads/upload': { ok: false, code: 'METHOD_NOT_ALLOWED' } },
    methods: workspaceUploadHost(),
  })
  connect(fake)
  const outcome = await uploadAttachment(fake.target, 's-1', { name: 'pic.png', bytes, mediaType: 'image/png' })
  assertEqual(outcome.strategy, 'workspace', '降级到工作区上传')
  assertEqual(endpointCalls(fake, 'fileUploads/upload').length, 1, '收据通道只试一次')
  assertEqual(callsTo(fake, 'workspace.upload.open').length, 1, 'open 一次')
  assertTrue(useWorkspacePane.getState().uploadSupported !== false, '入口没有被关掉')
})

check('B2：405（HTTP 码透传）同样触发降级', async () => {
  const fake = fakeTarget({
    endpoints: { 'fileUploads/upload': { ok: false, code: '405' } },
    methods: workspaceUploadHost(),
  })
  connect(fake)
  const outcome = await uploadAttachment(fake.target, 's-1', { name: 'a.txt', bytes: bytesOf('hello') })
  assertEqual(outcome.strategy, 'workspace', '405 也降级')
})

check('B3：gateway/arguments-invalid（老 Host 严格 codec）也降级', async () => {
  const fake = fakeTarget({
    endpoints: { 'fileUploads/upload': { ok: false, code: 'gateway/arguments-invalid' } },
    methods: workspaceUploadHost(),
  })
  connect(fake)
  const outcome = await uploadAttachment(fake.target, 's-1', { name: 'a.txt', bytes: bytesOf('hello') })
  assertEqual(outcome.strategy, 'workspace', '老 codec 也降级')
})

check('B4：两条都不可用 → UPLOAD_UNAVAILABLE（带原因），这是唯一该关入口的情况', async () => {
  const fake = fakeTarget({
    endpoints: { 'fileUploads/upload': { ok: false, code: 'METHOD_NOT_ALLOWED' } },
    methods: {
      'workspace.upload.open': { ok: false, code: 'FEATURE_NOT_SUPPORTED' },
    },
  })
  connect(fake)
  const error = await assertThrows(
    () => uploadAttachment(fake.target, 's-1', { name: 'a.txt', bytes: bytesOf('x') }),
    '两条都不行应抛',
    'UPLOAD_UNAVAILABLE',
  )
  assertTrue(isUploadUnavailable(error), 'isUploadUnavailable')
  assertEqual(uploadErrorReasonOf(error), 'workspace-unavailable', '原因码')
  // 记忆生效：下一次不再白试收据通道
  assertEqual(uploadStrategyMemory().receiptUnavailableCode, 'METHOD_NOT_ALLOWED', '记住了收据被拒')
  assertTrue(uploadStrategyMemory().workspaceUnavailable, '记住了工作区不可用')
})

check('B5：一次上传成功后，store 的 chip 带 remotePath + 引用，readyReceipts 出令牌', async () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  const fake = fakeTarget({
    endpoints: { 'fileUploads/upload': { ok: false, code: 'METHOD_NOT_ALLOWED' } },
    methods: workspaceUploadHost(),
  })
  connect(fake)
  const file = {
    name: 'pic.png',
    size: bytes.byteLength,
    type: 'image/png',
    arrayBuffer: async () => bytes.buffer.slice(0),
  } as unknown as File
  await useWorkspacePane.getState().pickFiles([file])
  const attachment = useWorkspacePane.getState().attachments[0]
  if (attachment === undefined) fail('附件没有进 store')
  assertEqual(attachment.status, 'done', '状态')
  assertEqual(attachment.strategy, 'workspace', '通道')
  assertEqual(attachment.remotePath, './pic.png', '工作区路径')
  assertEqual(attachment.reference, '@pic.png', '引用写法')
  assertEqual(readyReceipts(useWorkspacePane.getState().attachments), ['workspace-ref:./pic.png'], '发送凭据是引用令牌')
  assertEqual(useWorkspacePane.getState().uploadSupported, true, '入口可用')
  assertEqual(useWorkspacePane.getState().uploadError, null, '没有错误条')
})

/* ══════════════════════════════════════════════════════════════════════
 * C. chunk 顺序与 abort
 * ══════════════════════════════════════════════════════════════════════ */

check('C1：200 KiB 按 64 KiB 切 4 块，offset 严格递增、ack 逐块校验', async () => {
  const bytes = ramp(200 * 1024)
  const fake = fakeTarget({ methods: workspaceUploadHost() })
  connect(fake)
  const outcome = await uploadAttachment(fake.target, 's-1', { name: 'big.bin', bytes }, { only: 'workspace' })
  assertEqual(outcome.strategy, 'workspace', '通道')
  const chunks = callsTo(fake, 'workspace.upload.chunk')
  assertEqual(chunks.length, 4, '200 KiB / 64 KiB = 4 块')
  const offsets = chunks.map((call) => (call.params as { offset: number }).offset)
  assertEqual(offsets, [0, 65536, 131072, 196608], 'offset 顺序')
  // 每一块的 data 都必须是**规范** base64（Host 会逐字对比）
  const first = chunks[0]?.params as { data: string }
  assertEqual(first.data, base64Of(bytes.subarray(0, 65536)), '第一块 base64 与源字节一致')
  const open = callsTo(fake, 'workspace.upload.open')[0]?.params as { name: string; totalBytes: number; uploadId: string }
  assertEqual(open.totalBytes, bytes.byteLength, 'open 报总长')
  assertEqual(open.name, 'big.bin', 'open 报文件名')
  assertTrue(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(open.uploadId), `uploadId 是 UUIDv4：${open.uploadId}`)
})

check('C2：中间一块被拒 → 立刻 abort，且绝不 commit', async () => {
  const bytes = ramp(32 * 1024)
  const fake = fakeTarget({ methods: workspaceUploadHost({ failChunkAt: 1 }) })
  connect(fake)
  await assertThrows(
    () => uploadAttachment(fake.target, 's-1', { name: 'a.bin', bytes }, { only: 'workspace' }),
    'chunk 失败要抛',
    'UPLOAD_INVALID_CHUNK',
  )
  const aborts = callsTo(fake, 'workspace.upload.abort')
  assertEqual(aborts.length, 1, 'abort 一次')
  const open = callsTo(fake, 'workspace.upload.open')[0]?.params as { uploadId: string }
  assertEqual((aborts[0]?.params as { uploadId: string }).uploadId, open.uploadId, 'abort 用的是同一个 uploadId')
  assertEqual(callsTo(fake, 'workspace.upload.commit').length, 0, '没有 commit')
})

check('C3：open 就被拒（FEATURE_NOT_SUPPORTED）→ 不发 chunk、不 abort 未创建的上传', async () => {
  const fake = fakeTarget({ methods: { 'workspace.upload.open': { ok: false, code: 'FEATURE_NOT_SUPPORTED' } } })
  connect(fake)
  const error = await assertThrows(
    () => uploadAttachment(fake.target, 's-1', { name: 'a.bin', bytes: bytesOf('x') }, { only: 'workspace' }),
    'open 失败要抛',
    'UPLOAD_UNAVAILABLE',
  )
  assertEqual(uploadErrorReasonOf(error), 'workspace-unavailable', '原因码')
  assertEqual(callsTo(fake, 'workspace.upload.chunk').length, 0, '没有 chunk')
  assertEqual(callsTo(fake, 'workspace.upload.abort').length, 0, '没有 abort（还没 opened）')
})

check('C4：commit 的 path 不合规（不是 ./ 开头）→ 判协议错误', async () => {
  const fake = fakeTarget({
    methods: {
      ...workspaceUploadHost(),
      'workspace.upload.commit': { ok: true, value: { name: 'a.bin', path: '/etc/passwd', bytes: 3 } },
    },
  })
  connect(fake)
  await assertThrows(
    () => uploadAttachment(fake.target, 's-1', { name: 'a.bin', bytes: bytesOf('abc') }, { only: 'workspace' }),
    'path 不合规要抛',
    'INVALID_RESPONSE',
  )
  assertEqual(callsTo(fake, 'workspace.upload.abort').length, 1, '失败后 abort')
})

/* ══════════════════════════════════════════════════════════════════════
 * D. 20 MiB / 1 GiB 上限
 * ══════════════════════════════════════════════════════════════════════ */

check('D1：Relay 上 21 MiB → 本地就拦（一个 RPC 都不发），错误码 UPLOAD_TOO_LARGE', async () => {
  const bytes = new Uint8Array(21 * 1024 * 1024)
  const fake = fakeTarget({
    endpoints: { 'fileUploads/upload': { ok: false, code: 'METHOD_NOT_ALLOWED' } },
    methods: workspaceUploadHost(),
  })
  connect(fake, { transport: 'relay' })
  await assertThrows(
    () => uploadAttachment(fake.target, 's-1', { name: 'huge.bin', bytes }),
    '21 MiB 在 Relay 上传不了',
    'UPLOAD_TOO_LARGE',
  )
  assertEqual(fake.calls.length, 1, '只试了一次收据通道（然后被大小拦住）')
  assertEqual(endpointCalls(fake, 'fileUploads/upload').length, 1, '收据通道确实试过')
  assertEqual(callsTo(fake, 'workspace.upload.open').length, 0, '工作区通道没被调用')
})

check('D2：限额常量与传输路径绑定（relay/turn/未知 → 20 MiB；lan/p2p → 1 GiB）', async () => {
  assertEqual(workspaceUploadLimitBytes('relay'), MAX_WORKSPACE_UPLOAD_BYTES, 'relay')
  assertEqual(workspaceUploadLimitBytes('turn'), MAX_WORKSPACE_UPLOAD_BYTES, 'turn')
  assertEqual(workspaceUploadLimitBytes(undefined), MAX_WORKSPACE_UPLOAD_BYTES, '未知')
  assertEqual(workspaceUploadLimitBytes('lan'), MAX_WORKSPACE_UPLOAD_BYTES_DIRECT, 'lan')
  assertEqual(workspaceUploadLimitBytes('p2p'), MAX_WORKSPACE_UPLOAD_BYTES_DIRECT, 'p2p')
  assertEqual(MAX_WORKSPACE_UPLOAD_BYTES, 20 * 1024 * 1024, '20 MiB')
  assertEqual(MAX_INLINE_UPLOAD_BYTES, 30 * 1024 * 1024, '收据通道 30 MiB')
})

check('D3：P2P 上 21 MiB 走工作区通道（不会被大小拦）', async () => {
  const bytes = new Uint8Array(21 * 1024 * 1024)
  const fake = fakeTarget({ methods: workspaceUploadHost() })
  connect(fake, { transport: 'p2p' })
  const outcome = await uploadAttachment(fake.target, 's-1', { name: 'big.bin', bytes }, { only: 'workspace' })
  assertEqual(outcome.strategy, 'workspace', '通道')
  assertEqual((callsTo(fake, 'workspace.upload.open')[0]?.params as { totalBytes: number }).totalBytes, bytes.byteLength, '总长')
})

/* ══════════════════════════════════════════════════════════════════════
 * E. 引用落进消息
 * ══════════════════════════════════════════════════════════════════════ */

check('E1：引用令牌 → 正文 @path；file 块里不出现令牌', async () => {
  const fake = fakeTarget({})
  const token = workspaceReferenceToken('./a.png')
  await sendPrompt(fake.target, 's-1', '看看这张图', [{ type: 'file', receiptId: token }])
  const call = endpointCalls(fake, 'session/prompt')[0]
  const content = (call?.args as { request: { content: Array<Record<string, unknown>> } }).request.content
  assertEqual(content.length, 1, '只有文本块')
  assertEqual(content[0]?.['type'], 'text', '类型')
  assertEqual(content[0]?.['text'], '看看这张图\n\n@a.png', '引用接在正文后')
  assertFalse(JSON.stringify(content).includes('workspace-ref:'), '令牌不落到线上')
})

check('E2：没有正文时只发引用；带空白的文件名用 @"…"', async () => {
  const fake = fakeTarget({})
  await sendPrompt(fake.target, 's-1', '   ', [{ type: 'file', receiptId: workspaceReferenceToken('./my photo.png') }])
  const content = (endpointCalls(fake, 'session/prompt')[0]?.args as { request: { content: Array<Record<string, unknown>> } }).request.content
  assertEqual(content, [{ type: 'text', text: '@"my photo.png"' }], '空正文 + 带空白名')
})

check('E3：真收据与引用混发：收据进 file 块、引用进正文', async () => {
  const fake = fakeTarget({})
  await sendPrompt(fake.target, 's-1', 'hi', [
    { type: 'file', receiptId: 'rcpt-1' },
    { type: 'file', receiptId: workspaceReferenceToken('./a.png') },
  ])
  const content = (endpointCalls(fake, 'session/prompt')[0]?.args as { request: { content: Array<Record<string, unknown>> } }).request.content
  assertEqual(content[0], { type: 'file', receiptId: 'rcpt-1' }, '真收据')
  assertEqual(content[1], { type: 'text', text: 'hi\n\n@a.png' }, '正文带引用')
})

check('E4：outcomeToken / outcomeReference', async () => {
  assertEqual(
    outcomeToken({ strategy: 'receipt', receiptId: 'r-1' }),
    'r-1',
    '收据通道',
  )
  assertEqual(
    outcomeToken({ strategy: 'workspace', name: 'a.png', path: './a.png', bytes: 3 }),
    'workspace-ref:./a.png',
    '工作区通道',
  )
  assertEqual(outcomeReference({ strategy: 'workspace', name: 'a b.png', path: './a b.png', bytes: 3 }), '@"a b.png"', '带空白的引用')
  assertEqual(outcomeReference({ strategy: 'receipt', receiptId: 'r' }), null, '收据没有引用')
})

/* ══════════════════════════════════════════════════════════════════════
 * F. 名字消毒 / uploadId
 * ══════════════════════════════════════════════════════════════════════ */

check('F1：文件名消毒（Host 规则：≤220 字节、无非法字符、避开保留名）', async () => {
  assertEqual(sanitizeWorkspaceUploadName('C:\\tmp\\a.png'), 'a.png', 'Windows 目录')
  assertEqual(sanitizeWorkspaceUploadName('a<b>c:d"e|f?g*h.txt'), 'a_b_c_d_e_f_g_h.txt', '非法字符换下划线')
  assertEqual(sanitizeWorkspaceUploadName('trail. . '), 'trail', '尾部点/空格')
  assertEqual(sanitizeWorkspaceUploadName('con.txt'), '_con.txt', 'Windows 保留名')
  // 前导点先去掉了，所以 `.dsh-upload-` 这个 Host 前缀天然不会出现在结果开头
  assertEqual(sanitizeWorkspaceUploadName('.dsh-upload-abc.part'), 'dsh-upload-abc.part', '避开 Host 临时前缀')
  assertEqual(sanitizeWorkspaceUploadName('...'), 'file', '全是点 → 兜底名')
  const long = `${'报'.repeat(120)}.png`
  const safe = sanitizeWorkspaceUploadName(long)
  assertTrue(new TextEncoder().encode(safe).byteLength <= 220, `≤220 字节（实际 ${new TextEncoder().encode(safe).byteLength}）`)
  assertTrue(safe.endsWith('.png'), '保留扩展名')
})

check('F2：newUploadId() 是 UUIDv4（Host 用 z.string().uuid() 校验）', async () => {
  const uuid = newUploadId()
  assertTrue(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(uuid), `形状：${uuid}`)
  assertTrue(newUploadId() !== uuid, '两次不同')
})

/* ── 跑 ───────────────────────────────────────────────────────────────── */

const main = async (): Promise<void> => {
  let failures = 0
  for (const item of checks) {
    const startedAt = Date.now()
    try {
      await item.run()
      console.log(`PASS  ${item.name}  (${Date.now() - startedAt}ms)`)
    } catch (error) {
      failures += 1
      console.error(`FAIL  ${item.name}  (${Date.now() - startedAt}ms)`)
      console.error(`      ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  console.log(`\n${checks.length - failures} PASS / ${failures} FAIL / ${checks.length} TOTAL`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
