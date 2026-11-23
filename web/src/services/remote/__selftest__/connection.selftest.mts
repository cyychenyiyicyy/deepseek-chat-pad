/**
 * `connection.ts` 状态机单测：用假 `SecureLink` 跑控制面阶段与能力协商。
 *
 * 跑法（workdir = projects\deepseek-tablet\web）：
 *   npx tsx src/services/remote/__selftest__/connection.selftest.mts
 *
 * 覆盖的是契约 §4 的对外行为，不碰网络：
 *   - 阶段序列 connecting → handshaking → ready / error
 *   - `harness.transport.describe` 必须在通道就绪后调用一次
 *   - fail-closed：describe 缺失 / v1+v3 冲突 / 没有 v1|v3 → 报错并关链路
 *   - 账号未注册设备、跨服务器混用、Host 公钥 pin 不一致 → 拒绝连接
 */

import {
  RemoteClientImpl,
  buildLinkOptions,
  controlChannelUrl,
  parseTransportDescription,
  type SecureLink,
} from '../connection.js'
import { createIdentity } from '../identity.js'
import { RemoteApiError } from '../serverApi.js'

/* ── 极简断言器 ───────────────────────────────────────────────────────── */

const checks: Array<{ name: string; run: () => Promise<void> }> = []
const check = (name: string, run: () => Promise<void>): void => {
  checks.push({ name, run })
}

const fail = (message: string): never => {
  throw new Error(message)
}

const assertEqual = (actual: unknown, expected: unknown, label: string): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}

const assertTrue = (value: boolean, label: string): void => {
  if (!value) fail(label)
}

const codeOfError = (error: unknown): string =>
  error instanceof RemoteApiError ? error.code : '<no code>'

const assertThrowsCode = async (run: () => Promise<unknown>, expected: string, label: string): Promise<void> => {
  try {
    await run()
  } catch (error) {
    const actual = codeOfError(error)
    if (actual !== expected) fail(`${label}：期望 code=${expected}，实际 ${actual}（${(error as Error).message}）`)
    return
  }
  fail(`${label}：期望抛错，但调用成功了`)
}

/* ── 假 SecureLink ────────────────────────────────────────────────────── */

interface FakeLinkOptions {
  state?: SecureLink['state']
  readyError?: Error
  describe?: unknown
  describeError?: Error
  configureHistory?: (params: unknown) => unknown
  transport?: string
}

const createFakeLink = (options: FakeLinkOptions = {}) => {
  const calls: string[] = []
  let closed = false
  let state: SecureLink['state'] = options.state ?? 'open'
  const link: SecureLink = {
    get state() {
      return state
    },
    async ready() {
      calls.push('ready')
      if (options.readyError !== undefined) throw options.readyError
      state = 'secure'
    },
    sendFrame() {
      calls.push('sendFrame')
    },
    async rpc<T = unknown>(method: string, params?: unknown): Promise<T> {
      calls.push(`rpc:${method}`)
      if (method === 'remote.history.configure') return options.configureHistory?.(params) as T
      if (options.describeError !== undefined) throw options.describeError
      return (options.describe ?? { capabilities: ['harness.remote.v1', 'transport.relay'] }) as T
    },
    async openStream() {
      calls.push('openStream')
      return { streamId: 'stream-1', close: async () => undefined }
    },
    close() {
      closed = true
      calls.push('close')
    },
    ...(options.transport === undefined ? {} : { transport: options.transport }),
  } as SecureLink
  return { link, calls, isClosed: () => closed }
}

/* ── 固定数据 ─────────────────────────────────────────────────────────── */

const SERVER = { url: 'https://dsh.r2049.cn' }
const DEVICE_ID = '0192f3a4-5b6c-7d8e-9f01-23456789abcd'
const HOST_ID = 'host-device-0001'
const IDENTITY_KEY = 'A'.repeat(43)

const account = {
  email: 'u@example.com',
  accessToken: 'access-token-0123456789',
  refreshToken: 'refresh-token-0123456789',
  deviceId: DEVICE_ID,
  scope: 'device' as const,
  serverUrl: 'https://dsh.r2049.cn',
}

const host = { deviceId: HOST_ID, name: 'Workstation', identityKey: IDENTITY_KEY }

check('精简历史只在支持的主机协商，且要求逐字段确认', async () => {
  const client = new RemoteClientImpl()
  const describe = { capabilities: ['harness.remote.v3', 'remote.history.compact.v1'] }
  for (const compact of [false, true]) {
    const { link, calls } = createFakeLink({ describe, configureHistory: (params) => {
      assertEqual(params, { compact }, '请求固定连接的历史模式')
      return { compact }
    } })
    const result = await client.connect(SERVER, account, host, link, { compactHistory: compact })
    assertEqual(result.compactHistory, compact, '模式经主机确认')
    assertEqual(calls, ['ready', 'rpc:harness.transport.describe', 'rpc:remote.history.configure'], '业务流之前协商')
  }
  const legacy = createFakeLink()
  const fallback = await client.connect(SERVER, account, host, legacy.link, { compactHistory: true })
  assertEqual(fallback.compactHistory, false, '旧版主机继续使用完整历史')
  assertEqual(legacy.calls, ['ready', 'rpc:harness.transport.describe'], '旧版没有额外的 RPC')
  const dropped = createFakeLink()
  const lostSupport = await client.connect(SERVER, account, host, dropped.link, { compactHistory: true, requireCompactHistory: true })
    .catch(codeOfError)
  assertEqual(lostSupport, 'HISTORY_MODE_CHANGED', '自动重连不可静默换模式')
  const invalid = createFakeLink({ describe, configureHistory: () => ({ compact: false, extra: 1 }) })
  const wrongEcho = await client.connect(SERVER, account, host, invalid.link).catch(codeOfError)
  assertEqual(wrongEcho, 'INVALID_MESSAGE', '拒绝未知确认格式')
  assertTrue(invalid.isClosed(), '异常连接已关闭')
})

/* ── 状态机 ───────────────────────────────────────────────────────────── */

check('connect 成功：connecting → handshaking → ready，且调了一次 describe', async () => {
  const client = new RemoteClientImpl()
  const phases: string[] = []
  client.onStatus((status) => phases.push(status.phase))
  const fake = createFakeLink({ describe: { capabilities: ['harness.remote.v3', 'transport.relay'] } })

  const result = await client.connect(SERVER, account, host, fake.link)

  assertEqual(result.capabilities, ['harness.remote.v3', 'transport.relay'], '能力')
  assertEqual(result.transport, 'relay', '传输方式')
  assertTrue(result.diagnostics.connectMs >= result.diagnostics.hostRequestMs, '请求耗时包含在握手内')
  assertTrue(result.diagnostics.measuredAt > 0, '保留测量时间')
  assertEqual(fake.calls.filter((call) => call === 'ready').length, 1, 'ready 调 1 次')
  assertEqual(fake.calls.filter((call) => call === 'rpc:harness.transport.describe').length, 1, 'describe 调 1 次')
  assertEqual(phases[0], 'connecting', '首帧状态')
  assertTrue(phases.includes('handshaking'), '必须经过 handshaking')
  assertEqual(phases.at(-1), 'ready', '末帧状态')
  assertEqual(client.status(), { phase: 'ready', capabilities: ['harness.remote.v3', 'transport.relay'], transport: 'relay' }, 'status()')
  assertTrue(!fake.isClosed(), '成功路径不该关链路')
})

check('connect 成功：link 暴露 transport 时用它（优先于 relay 兜底）', async () => {
  const client = new RemoteClientImpl()
  const fake = createFakeLink({ transport: 'p2p' })
  const result = await client.connect(SERVER, account, host, fake.link)
  assertEqual(result.transport, 'p2p', 'transport')
})

check('connect：显式 options.transport 优先', async () => {
  const client = new RemoteClientImpl()
  const fake = createFakeLink({ transport: 'p2p' })
  const result = await client.connect(SERVER, account, host, fake.link, { transport: 'lan' })
  assertEqual(result.transport, 'lan', 'transport')
})

check('connect：ready 拒绝 → error 状态 + 关链路', async () => {
  const client = new RemoteClientImpl()
  const fake = createFakeLink({ readyError: new RemoteApiError('SECURE_CHANNEL_FAILED', 'Noise 失败') })

  await assertThrowsCode(() => client.connect(SERVER, account, host, fake.link), 'SECURE_CHANNEL_FAILED', '握手失败')
  assertEqual(client.status().phase, 'error', '状态')
  assertTrue(fake.isClosed(), '失败必须关链路（fail-closed）')
})

check('connect：describe 返回 METHOD_NOT_FOUND（旧 Host）→ 拒绝连接', async () => {
  const client = new RemoteClientImpl()
  const fake = createFakeLink({ describeError: new RemoteApiError('METHOD_NOT_FOUND', 'no such method') })

  await assertThrowsCode(() => client.connect(SERVER, account, host, fake.link), 'METHOD_NOT_FOUND', '旧 Host')
  assertTrue(fake.isClosed(), '必须关链路')
})

check('connect：describe 超时 → 原始错误码直传 + 关链路', async () => {
  const client = new RemoteClientImpl()
  const fake = createFakeLink({ describeError: new RemoteApiError('RPC_TIMEOUT', 'timeout') })
  await assertThrowsCode(() => client.connect(SERVER, account, host, fake.link), 'RPC_TIMEOUT', 'describe 超时')
  assertTrue(fake.isClosed(), '必须关链路')
})

/* ── 能力解析（fail-closed） ──────────────────────────────────────────── */

check('parseTransportDescription：v1 与 v3 同时出现 → INVALID_MESSAGE', async () => {
  await assertThrowsCode(
    async () => parseTransportDescription({ capabilities: ['harness.remote.v1', 'harness.remote.v3'] }),
    'INVALID_MESSAGE',
    'v1+v3 冲突',
  )
})

check('parseTransportDescription：既没有 v1 也没有 v3 → HARNESS_VERSION_INCOMPATIBLE', async () => {
  await assertThrowsCode(
    async () => parseTransportDescription({ capabilities: ['harness.api.v1'] }),
    'HARNESS_VERSION_INCOMPATIBLE',
    '没有业务载体',
  )
})

check('parseTransportDescription：缺 capabilities / 非字符串 / 超 128 条 → INVALID_MESSAGE', async () => {
  await assertThrowsCode(async () => parseTransportDescription({}), 'INVALID_MESSAGE', '缺 capabilities')
  await assertThrowsCode(async () => parseTransportDescription(null), 'INVALID_MESSAGE', 'null')
  await assertThrowsCode(
    async () => parseTransportDescription({ capabilities: ['harness.remote.v1', 42] }),
    'INVALID_MESSAGE',
    '非字符串条目',
  )
  const overLimit = Array.from({ length: 129 }, (_, index) => `cap.${index}`)
  await assertThrowsCode(
    async () => parseTransportDescription({ capabilities: overLimit }),
    'INVALID_MESSAGE',
    '超条数上限',
  )
})

check('parseTransportDescription：正常值原样返回（顺序保留）', async () => {
  const capabilities = ['harness.remote.v3', 'transport.relay', 'fileviewer.read.v1']
  assertEqual(parseTransportDescription({ capabilities }), capabilities, 'capabilities')
})

/* ── 前置校验 ─────────────────────────────────────────────────────────── */

check('connect：账号还没注册设备 → AUTH_REQUIRED，且不碰链路', async () => {
  const client = new RemoteClientImpl()
  const fake = createFakeLink()
  await assertThrowsCode(
    () => client.connect(SERVER, { ...account, deviceId: '', scope: 'account' }, host, fake.link),
    'AUTH_REQUIRED',
    '未注册设备',
  )
  assertEqual(fake.calls.length, 0, '链路不该被调用')
})

check('connect：账号与服务器不匹配 → INVALID_ARGUMENT', async () => {
  const client = new RemoteClientImpl()
  const fake = createFakeLink()
  await assertThrowsCode(
    () => client.connect({ url: 'https://other.example' }, account, host, fake.link),
    'INVALID_ARGUMENT',
    '跨服务器',
  )
})

check('connect：Host 标记 identityMismatch → PEER_IDENTITY_MISMATCH', async () => {
  const client = new RemoteClientImpl()
  const fake = createFakeLink()
  await assertThrowsCode(
    () => client.connect(SERVER, account, { ...host, identityMismatch: true }, fake.link),
    'PEER_IDENTITY_MISMATCH',
    '公钥冲突',
  )
  assertEqual(fake.calls.length, 0, '链路不该被调用')
})

check('connect：已取消的 signal → RPC_ABORTED', async () => {
  const client = new RemoteClientImpl()
  const fake = createFakeLink()
  const controller = new AbortController()
  controller.abort()
  await assertThrowsCode(
    () => client.connect(SERVER, account, host, fake.link, { signal: controller.signal }),
    'RPC_ABORTED',
    '取消',
  )
})

/* ── 状态订阅 ─────────────────────────────────────────────────────────── */

check('onStatus：退订后不再收到通知；status() 返回快照（改了不影响内部）', async () => {
  const client = new RemoteClientImpl()
  const seen: string[] = []
  const unsubscribe = client.onStatus((status) => seen.push(status.phase))
  const fake = createFakeLink()
  await client.connect(SERVER, account, host, fake.link)
  const countAfterConnect = seen.length
  assertTrue(countAfterConnect > 0, '应收到通知')

  unsubscribe()
  client.close()
  assertEqual(seen.length, countAfterConnect, '退订后不该再收到')

  const snapshot = client.status()
  if (snapshot.phase === 'ready') snapshot.capabilities.push('tampered')
  const again = client.status()
  assertEqual(again.phase, 'idle', 'close 后回到 idle')
})

check('onStatus：回调抛异常不会打断状态机', async () => {
  const client = new RemoteClientImpl()
  client.onStatus(() => {
    throw new Error('UI 炸了')
  })
  const fake = createFakeLink()
  const result = await client.connect(SERVER, account, host, fake.link)
  assertEqual(result.transport, 'relay', '状态机仍然跑完')
})

/* ── buildLinkOptions / controlChannelUrl ─────────────────────────────── */

check('controlChannelUrl：https → wss + /ws/v1/connect，保留反代前缀', async () => {
  assertEqual(controlChannelUrl('https://dsh.r2049.cn'), 'wss://dsh.r2049.cn/ws/v1/connect', '根路径')
  assertEqual(controlChannelUrl('https://host.example/dsh'), 'wss://host.example/dsh/ws/v1/connect', '带前缀')
  assertEqual(controlChannelUrl('http://localhost:8080'), 'ws://localhost:8080/ws/v1/connect', '本机调试')
})

check('buildLinkOptions：Authorization 只进 headers、Origin 与服务器一致、wss 控制通道', async () => {
  const identity = createIdentity()
  const options = buildLinkOptions({
    server: SERVER,
    account: { ...account, deviceId: identity.deviceId },
    host,
    identity,
  })
  assertEqual(options.url, 'wss://dsh.r2049.cn/ws/v1/connect', '控制通道 URL')
  assertEqual(options.headers.Authorization, `Bearer ${account.accessToken}`, 'Authorization 头')
  assertEqual(options.headers.Origin, 'https://dsh.r2049.cn', 'Origin 必须与服务器一致')
  assertEqual(options.device, {
    deviceId: identity.deviceId,
    privateKey: identity.privateKey,
    publicKey: identity.publicKey,
  }, 'Noise 静态身份')
  assertEqual(options.hostDeviceId, HOST_ID, 'hostDeviceId')
  assertEqual(options.clientDeviceId, identity.deviceId, 'clientDeviceId')
  assertTrue(!options.url.includes(account.accessToken), 'token 绝不能进 URL')
})

check('buildLinkOptions：本地身份与已注册 deviceId 不一致 → IDENTITY_MISMATCH', async () => {
  const identity = createIdentity()
  let code = '<none>'
  try {
    buildLinkOptions({ server: SERVER, account, host, identity })
  } catch (error) {
    code = codeOfError(error)
  }
  assertEqual(code, 'IDENTITY_MISMATCH', '错误的身份必须拦住')
})

/* ── 跑 ───────────────────────────────────────────────────────────────── */

const main = async (): Promise<void> => {
  let failures = 0
  for (const item of checks) {
    try {
      await item.run()
      console.log(`PASS  ${item.name}`)
    } catch (error) {
      failures += 1
      console.error(`FAIL  ${item.name}`)
      console.error(`      ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  console.log(`\n${checks.length - failures} PASS / ${failures} FAIL / ${checks.length} TOTAL`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
