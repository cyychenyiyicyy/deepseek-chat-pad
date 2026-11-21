/**
 * 工具卡图片 loader（R2 修裂图）自测。
 *
 * 跑法（workdir = projects\deepseek-tablet\web）：
 *   npx tsx src/services/remote/__selftest__/tool-image.selftest.mts
 *
 * 任务书点名的三组 uri 分支，加上真机上出问题的那些前缀，逐条断言：
 *   A. **uri 分类**（`classifyToolImageUri`）—— `data:` 的 MIME/base64/空载荷细分、
 *      `blob:`、`http(s):`、`file:`、相对路径（`a.png` / `/a.png` / `//host/a.png` /
 *      `C:\a.png` / `content://`）、空值。分类错了就会把不该进 `<img>` 的值塞进去 = 裂图。
 *   B. **loader 行为**（`toolImageLoader`）—— data: 直通不发请求、只有 attachmentId 时补
 *      字节并转 data URL、缓存命中/`force` 重取、失败不缓存因此重试真的会重发、
 *      相对路径且没有 attachmentId 时**抛错而不是画空框**、相对路径但有 attachmentId 时
 *      以 id 为准、没连上 `REMOTE_NOT_READY`、取消 `RPC_ABORTED`。
 *   C. **并发与去重**——同一 attachment 的并发调用只发一次请求；多个不同 attachment
 *      同时在飞时不超过 `TOOL_IMAGE_CONCURRENCY`。
 *
 * 结尾按仓库约定设置真实退出码（红了必须真红）。
 */

import {
  classifyToolImageUri,
  clearToolImageCache,
  isRemoteAborted,
  isRemoteNotReady,
  isToolImageUriUsable,
  loadToolImage,
  resetAttachmentSupport,
  toolImageLoaderStats,
  TOOL_IMAGE_CONCURRENCY,
} from '../filesApi.js'
import { lastRemoteTarget, observeRemoteTarget, type RemoteCallTarget } from '../sessionsApi.js'
import { useRemoteStore } from '../store.js'

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

/** 断言抛错，并把错误交回给用例继续检查（错误码 / details）。 */
const catchError = async (
  run: () => unknown | Promise<unknown>,
  label: string,
): Promise<{ code?: string; message?: string; details?: unknown }> => {
  try {
    await run()
  } catch (error) {
    const record = error as { code?: string; message?: string; details?: unknown }
    return record
  }
  return fail(`${label}：应当抛错，但没有抛`)
}

/* ── 内存版 localStorage（`store.ts` 启动时要读盘） ───────────────────── */

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

/* ── 假 target ────────────────────────────────────────────────────────── */

type Reply =
  | { ok: true; value?: unknown }
  | { ok: false; code: string; message?: string }

interface FakeTarget {
  target: RemoteCallTarget
  calls: string[]
  /** 同时在飞的峰值（并发用例断言用） */
  peak: number
  active: number
}

/**
 * 造一条假连接。
 *
 * `replies[endpoint]` 可以是一个函数 `(callIndex) => Reply`；再给 `delayMs` 让请求
 * 真的「花时间」，并发用例才观测得到峰值。
 */
const fakeTarget = (
  replies: Record<string, Reply | ((callIndex: number) => Reply)> = {},
  options: { delayMs?: number } = {},
): FakeTarget => {
  const calls: string[] = []
  const seen = new Map<string, number>()
  const state: FakeTarget = {
    calls,
    peak: 0,
    active: 0,
    target: {
      rpc: async <T,>(method: string, params?: unknown): Promise<T> => {
        if (method !== 'harness.remote.call') {
          calls.push(method)
          return {} as T
        }
        const envelope = params as { endpoint: string }
        const endpoint = envelope.endpoint
        const count = (seen.get(endpoint) ?? 0) + 1
        seen.set(endpoint, count)
        calls.push(endpoint)
        state.active += 1
        state.peak = Math.max(state.peak, state.active)
        try {
          if (options.delayMs !== undefined) {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, options.delayMs)
            })
          }
          const configured = replies[endpoint]
          const reply: Reply = configured === undefined
            ? { ok: true, value: {} }
            : typeof configured === 'function' ? configured(count) : configured
          if (reply.ok) return (reply.value === undefined ? { ok: true } : { ok: true, value: reply.value }) as T
          return { ok: false, error: { code: reply.code, message: reply.message ?? reply.code } } as T
        } finally {
          state.active -= 1
        }
      },
      openStream: async () => {
        throw new Error('本自测不开流')
      },
    },
  }
  return state
}

const connect = (fake: FakeTarget): void => {
  observeRemoteTarget(fake.target)
  useRemoteStore.setState({ phase: 'ready' })
  if (lastRemoteTarget() !== fake.target) fail('连接目标没有登记成功')
}

const disconnect = (): void => {
  observeRemoteTarget(null)
  useRemoteStore.setState({ phase: 'idle' })
}

/* ── 造字节 ───────────────────────────────────────────────────────────── */

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const PNG_BASE64 = Buffer.from(PNG_BYTES).toString('base64')
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`

const attachmentReply = (id: string): Reply => ({
  ok: true,
  value: { attachment: { attachmentId: id, mediaType: 'image/png' }, data: PNG_BASE64 },
})

/* ══════════════════════════════════════════════════════════════════════
 * A. uri 分类
 * ══════════════════════════════════════════════════════════════════════ */

check('A1：data: 只有「图片 MIME + base64 + 非空载荷」才算能用', async () => {
  assertEqual(classifyToolImageUri(PNG_DATA_URL), 'data', '标准 PNG data URL')
  assertEqual(classifyToolImageUri('DATA:image/png;base64,AAA'), 'data', '大写 scheme 也认')
  assertEqual(
    classifyToolImageUri('data:image/jpeg;charset=utf-8;base64,/9j/4AAQ'),
    'data',
    '带额外参数的 data URL',
  )
  assertEqual(classifyToolImageUri('data:image/png;base64,AAA\n'), 'data', '尾部换行先 trim')
  assertEqual(classifyToolImageUri('data:image/svg+xml;base64,PHN2Zz4='), 'invalid-data', 'SVG 不在白名单')
  assertEqual(classifyToolImageUri('data:text/html;base64,PGI+'), 'invalid-data', '不是图片 MIME')
  assertEqual(classifyToolImageUri('data:image/png,abc'), 'invalid-data', '没有 ;base64')
  assertEqual(classifyToolImageUri('data:image/png;base64,'), 'invalid-data', '空载荷')
  assertEqual(classifyToolImageUri('data:image/png'), 'invalid-data', '没有逗号')
})

check('A2：绝对地址直通；file: 与相对路径都判为「不能直接进 <img>」', async () => {
  assertEqual(classifyToolImageUri('blob:http://127.0.0.1:18888/abc'), 'blob', 'blob URL')
  assertEqual(classifyToolImageUri('https://cdn.example.com/a.png'), 'http', 'https 绝对地址')
  assertEqual(classifyToolImageUri('HTTP://127.0.0.1:18888/a.png'), 'http', '大写 scheme')
  assertEqual(classifyToolImageUri('file:///C:/a.png'), 'file', 'file URL')
  assertEqual(classifyToolImageUri('screenshots/a.png'), 'relative', '相对路径')
  assertEqual(classifyToolImageUri('./a.png'), 'relative', '点前缀相对路径')
  assertEqual(classifyToolImageUri('/a.png'), 'relative', '根相对路径（会落到 127.0.0.1 的根）')
  assertEqual(classifyToolImageUri('//host/a.png'), 'relative', '协议相对（host 一定不对）')
  assertEqual(classifyToolImageUri('C:\\shots\\a.png'), 'relative', 'Windows 盘符')
  assertEqual(classifyToolImageUri('content://media/1'), 'relative', 'content: 协议')
  assertEqual(classifyToolImageUri(undefined), 'absent', '没有 uri')
  assertEqual(classifyToolImageUri(''), 'absent', '空串')
  assertEqual(classifyToolImageUri('   '), 'absent', '只有空白')
})

check('A3：isToolImageUriUsable 只有 data / blob / http 是 true', async () => {
  assertTrue(isToolImageUriUsable(PNG_DATA_URL), 'data 可用')
  assertTrue(isToolImageUriUsable('blob:x'), 'blob 可用')
  assertTrue(isToolImageUriUsable('https://a/b.png'), 'http 可用')
  assertFalse(isToolImageUriUsable('screenshots/a.png'), '相对路径不可用')
  assertFalse(isToolImageUriUsable('file:///C:/a.png'), 'file 不可用')
  assertFalse(isToolImageUriUsable('data:text/html;base64,PGI+'), '非图片 data 不可用')
  assertFalse(isToolImageUriUsable(undefined), '没有 uri 不可用')
})

/* ══════════════════════════════════════════════════════════════════════
 * B. loader 行为
 * ══════════════════════════════════════════════════════════════════════ */

check('B1：data: 直通，一个请求都不发', async () => {
  clearToolImageCache()
  resetAttachmentSupport()
  const fake = fakeTarget()
  connect(fake)
  assertEqual(await loadToolImage({ uri: PNG_DATA_URL, name: 'a.png' }), PNG_DATA_URL, '原样返回')
  assertEqual(fake.calls.length, 0, '没有发请求')
  assertEqual(await loadToolImage({ uri: 'https://a/b.png' }), 'https://a/b.png', 'http 直通')
  assertEqual(fake.calls.length, 0, 'http 也不发请求（浏览器自己取）')
})

check('B2：只有 attachmentId 时取字节 → data URL；命中缓存不再请求', async () => {
  clearToolImageCache()
  resetAttachmentSupport()
  const fake = fakeTarget({ 'session/attachment': attachmentReply('att-1') })
  connect(fake)
  const url = await loadToolImage({ attachmentId: 'att-1', sessionId: 's-1', name: 'a.png' })
  assertEqual(url, PNG_DATA_URL, '转成 data URL')
  assertEqual(fake.calls, ['session/attachment'], '只发了一次 attachment')
  assertEqual(await loadToolImage({ attachmentId: 'att-1', sessionId: 's-1' }), PNG_DATA_URL, '命中缓存')
  assertEqual(fake.calls.length, 1, '缓存命中不再请求')
  assertEqual(toolImageLoaderStats().cached, 1, '缓存里就这一张')
  assertEqual(toolImageLoaderStats().cachedBytes, PNG_BYTES.byteLength, '缓存字节数按原始字节算')
})

check('B3：失败不缓存 —— 重试真的会重发；force 覆盖已成功的缓存', async () => {
  clearToolImageCache()
  resetAttachmentSupport()
  // 第 1 次失败，第 2 次成功
  const fake = fakeTarget({
    'session/attachment': (call) =>
      call === 1 ? { ok: false, code: 'RPC_FAILED', message: 'Relay 掉了' } : attachmentReply('att-2'),
  })
  connect(fake)
  const first = await catchError(
    () => loadToolImage({ attachmentId: 'att-2', sessionId: 's-1' }),
    '第一次应当抛错',
  )
  assertEqual(first.code, 'RPC_FAILED', '错误码原样上抛')
  assertFalse(isRemoteNotReady({ code: 'RPC_FAILED' }), 'RPC_FAILED 不是「没连上」')
  assertEqual(await loadToolImage({ attachmentId: 'att-2', sessionId: 's-1' }), PNG_DATA_URL, '重试成功')
  assertEqual(fake.calls.length, 2, '失败没有被缓存，所以确实重发了')

  // force：跳过缓存重取一次
  assertEqual(
    await loadToolImage({ attachmentId: 'att-2', sessionId: 's-1' }, 's-1', { force: true }),
    PNG_DATA_URL,
    'force 也能拿到内容',
  )
  assertEqual(fake.calls.length, 3, 'force 重新请求了一次')
})

check('B4：没有 uri 也没有 attachmentId → null；相对路径无 attachmentId → 抛错（不画空框）', async () => {
  clearToolImageCache()
  resetAttachmentSupport()
  const fake = fakeTarget()
  connect(fake)
  assertEqual(await loadToolImage({ name: 'a.png' }), null, '没像素就是 null')
  assertEqual(await loadToolImage({ attachmentId: 'att-x' }), null, '没有会话作用域 → null（不去猜）')

  const relative = await catchError(
    () => loadToolImage({ uri: 'screenshots/a.png', name: 'a.png' }),
    '相对路径应当抛错',
  )
  assertEqual(relative.code, 'REMOTE_IMAGE_URI_UNUSABLE', '错误码')
  assertEqual((relative.details as { uriKind?: string }).uriKind, 'relative', 'details 里带分类')
  assertTrue(
    typeof relative.message === 'string' && relative.message.includes('127.0.0.1:18888'),
    '原因里点出会被解析成 127.0.0.1:18888',
  )

  const fileUri = await catchError(() => loadToolImage({ uri: 'file:///C:/a.png' }), 'file: 应当抛错')
  assertEqual((fileUri.details as { uriKind?: string }).uriKind, 'file', 'file: 的分类')

  const badData = await catchError(
    () => loadToolImage({ uri: 'data:text/html;base64,PGI+' }),
    '非图片 data URL 应当抛错',
  )
  assertEqual((badData.details as { uriKind?: string }).uriKind, 'invalid-data', '坏 data URL 的分类')
  assertEqual(fake.calls.length, 0, '判不合法时一个请求都不发')
})

check('B5：uri 是相对路径但有 attachmentId → 以 id 为准照样取回', async () => {
  clearToolImageCache()
  resetAttachmentSupport()
  const fake = fakeTarget({ 'session/attachment': attachmentReply('att-3') })
  connect(fake)
  assertEqual(
    await loadToolImage({ uri: 'screenshots/a.png', attachmentId: 'att-3', sessionId: 's-1' }),
    PNG_DATA_URL,
    '相对路径被忽略，按 attachmentId 取',
  )
  assertEqual(fake.calls, ['session/attachment'], '发了一次 attachment')
})

check('B6：没连上 → REMOTE_NOT_READY（界面画占位，不报错）；取消 → RPC_ABORTED', async () => {
  clearToolImageCache()
  resetAttachmentSupport()
  const fake = fakeTarget({ 'session/attachment': attachmentReply('att-4') })
  connect(fake)
  disconnect()
  const offline = await catchError(
    () => loadToolImage({ attachmentId: 'att-4', sessionId: 's-1' }),
    '没连上应当抛错',
  )
  assertEqual(offline.code, 'REMOTE_NOT_READY', '错误码')
  assertTrue(isRemoteNotReady(offline), 'isRemoteNotReady 认得它')
  assertEqual(fake.calls.length, 0, '没连上一个请求都不发')

  connect(fake)
  const controller = new AbortController()
  controller.abort()
  const aborted = await catchError(
    () => loadToolImage({ attachmentId: 'att-4', sessionId: 's-1' }, 's-1', { signal: controller.signal }),
    '已取消应当抛错',
  )
  assertEqual(aborted.code, 'RPC_ABORTED', '取消的错误码')
  assertTrue(isRemoteAborted(aborted), 'isRemoteAborted 认得它')
  assertFalse(isRemoteNotReady(aborted), '取消不是「没连上」')
  assertEqual(toolImageLoaderStats().active, 0, '取消后名额已归还')
})

/* ══════════════════════════════════════════════════════════════════════
 * C. 并发与去重
 * ══════════════════════════════════════════════════════════════════════ */

check('C1：同一 attachment 并发 5 次 → 只发 1 次请求', async () => {
  clearToolImageCache()
  resetAttachmentSupport()
  const fake = fakeTarget({ 'session/attachment': attachmentReply('att-5') }, { delayMs: 10 })
  connect(fake)
  const urls = await Promise.all(
    Array.from({ length: 5 }, () => loadToolImage({ attachmentId: 'att-5', sessionId: 's-1' })),
  )
  assertEqual(urls, [PNG_DATA_URL, PNG_DATA_URL, PNG_DATA_URL, PNG_DATA_URL, PNG_DATA_URL], '5 个都拿到同一张')
  assertEqual(fake.calls.length, 1, '在飞请求被合并')
  assertEqual(fake.peak, 1, '峰值并发 1')
  assertEqual(toolImageLoaderStats().inflight, 0, '在飞表已清空')
})

check(`C2：不同 attachment 并发 8 张 → 同时在飞不超过 ${TOOL_IMAGE_CONCURRENCY}`, async () => {
  clearToolImageCache()
  resetAttachmentSupport()
  const fake = fakeTarget({ 'session/attachment': attachmentReply('att-n') }, { delayMs: 12 })
  connect(fake)
  const urls = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      loadToolImage({ attachmentId: `att-${index}`, sessionId: 's-1' })),
  )
  assertEqual(urls.length, 8, '8 张都有结果')
  assertEqual(fake.calls.length, 8, '每张都真的取了一次')
  assertTrue(fake.peak <= TOOL_IMAGE_CONCURRENCY, `峰值并发 ${fake.peak} 不超过上限 ${TOOL_IMAGE_CONCURRENCY}`)
  assertEqual(toolImageLoaderStats().active, 0, '名额全部归还')
  assertEqual(toolImageLoaderStats().waiting, 0, '没有残留的等待者')
  assertEqual(toolImageLoaderStats().cached, 8, '8 张都进了缓存')
})

check('C3：clearToolImageCache 之后重新请求（换连接时用）', async () => {
  clearToolImageCache()
  resetAttachmentSupport()
  const fake = fakeTarget({ 'session/attachment': attachmentReply('att-6') })
  connect(fake)
  await loadToolImage({ attachmentId: 'att-6', sessionId: 's-1' })
  assertEqual(fake.calls.length, 1, '第一次请求')
  clearToolImageCache()
  assertEqual(toolImageLoaderStats().cached, 0, '缓存清空')
  await loadToolImage({ attachmentId: 'att-6', sessionId: 's-1' })
  assertEqual(fake.calls.length, 2, '清缓存后重新请求')
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
  // 红了必须真的红（仓库约定：检查脚本必须设置退出码）
  process.exit(failures === 0 ? 0 : 1)
}

await main()
