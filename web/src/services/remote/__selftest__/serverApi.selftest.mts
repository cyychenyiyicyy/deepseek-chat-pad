/**
 * `serverApi.ts` 的形状 / 错误映射 / 刷新重试单测（mock fetch，不联网）。
 *
 * 跑法（workdir = projects\deepseek-tablet\web）：
 *   npx tsx src/services/remote/__selftest__/serverApi.selftest.mts
 *
 * 这里刻意**不**用 node:test：本文件的唯一职责是「请求长什么样、错误怎么映射」，
 * 自带一个最小断言器就够了，也不用再引额外运行时。
 * 结尾按仓库约定 `process.exit(failures === 0 ? 0 : 1)`，红了必须真的红。
 */

import {
  RemoteApiError,
  getDevice,
  getPresence,
  listDeviceMemberships,
  listDevices,
  login,
  normalizeServerUrl,
  refreshToken,
  registerDevice,
  revokeDeviceMembership,
  withRefreshRetry,
  type FetchLike,
} from '../serverApi.js'

/* ── 最小断言器 ───────────────────────────────────────────────────────── */

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

const assertContains = (haystack: string, needle: string, label: string): void => {
  if (!haystack.includes(needle)) fail(`${label}：${JSON.stringify(haystack)} 里没有 ${JSON.stringify(needle)}`)
}

const codeOfError = (error: unknown): string => {
  if (error instanceof RemoteApiError) return error.code
  if (typeof error === 'object' && error !== null && 'code' in error) return String((error as { code: unknown }).code)
  return '<no code>'
}

/** 断言抛出指定 code 的 RemoteApiError，并把错误原样返回便于继续断言 */
const assertThrowsCode = async (
  run: () => Promise<unknown>,
  expected: string,
  label: string,
): Promise<RemoteApiError> => {
  try {
    await run()
  } catch (error) {
    const actual = codeOfError(error)
    if (actual !== expected) fail(`${label}：期望 code=${expected}，实际 ${actual}（${(error as Error).message}）`)
    return error as RemoteApiError
  }
  return fail(`${label}：期望抛错，但调用成功了`)
}

/* ── mock fetch ───────────────────────────────────────────────────────── */

interface CapturedRequest {
  /** 实际请求的地址：走代理时是 /__ds_proxy */
  url: string
  /** 解码后的目标地址（X-DS-Target） */
  target: string
  path: string
  method: string
  /** 解码后的透传头（X-DS-Headers） */
  headers: Record<string, string>
  body: unknown
}

interface MockResponse {
  status?: number
  body?: unknown
  /** 直接给字符串（模拟非 JSON 响应体） */
  raw?: string
  /** 让 fetch 自己抛（模拟网络错） */
  throwError?: Error
}

type Handler = (request: CapturedRequest) => MockResponse

const decodeBase64Url = (value: string): string => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

const createMock = (handler: Handler): { fetchImpl: FetchLike; calls: CapturedRequest[] } => {
  const calls: CapturedRequest[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    const rawHeaders = (init.headers ?? {}) as Record<string, string>
    const target = decodeBase64Url(String(rawHeaders['X-DS-Target']))
    const request: CapturedRequest = {
      url,
      target,
      path: new URL(target).pathname,
      method: String(rawHeaders['X-DS-Method']),
      headers: JSON.parse(decodeBase64Url(String(rawHeaders['X-DS-Headers']))) as Record<string, string>,
      body: init.body === null || init.body === undefined ? undefined : JSON.parse(String(init.body)),
    }
    calls.push(request)
    const result = handler(request)
    if (result.throwError !== undefined) throw result.throwError
    const text = result.raw ?? (result.body === undefined ? '' : JSON.stringify(result.body))
    return new Response(text, { status: result.status ?? 200, headers: { 'Content-Type': 'application/json' } })
  }
  return { fetchImpl, calls }
}

/* ── 固定数据 ─────────────────────────────────────────────────────────── */

const SERVER = { url: 'https://dsh.r2049.cn' }
const ACCOUNT_TOKEN = 'account-token-0123456789'
const DEVICE_ID = '0192f3a4-5b6c-7d8e-9f01-23456789abcd'
const IDENTITY_KEY = 'A'.repeat(43) // 32 个 0 字节的规范 base64url

const tokenPair = {
  accessToken: 'access-token-0123456789',
  accessTokenExpiresAt: 1786000000000,
  refreshToken: 'refresh-token-0123456789',
  refreshTokenExpiresAt: 1789000000000,
}

const descriptor = {
  deviceId: DEVICE_ID,
  name: 'Chat Pad',
  role: 'client' as const,
  platform: 'web',
  identityKey: IDENTITY_KEY,
  clientVersion: '0.1.1',
}

/* ── 用例 ─────────────────────────────────────────────────────────────── */

check('login：走 /__ds_proxy，三个 X-DS-* 头可解，body 只有 email/password', async () => {
  const mock = createMock(() => ({ body: { token: ACCOUNT_TOKEN, expiresAt: 1786000000000, account: 'u@example.com' } }))
  const result = await login(SERVER, ' u@example.com ', 'p@ss', { fetch: mock.fetchImpl })

  assertEqual(mock.calls.length, 1, '请求次数')
  const call = mock.calls[0]!
  assertEqual(call.url, '/__ds_proxy', '实际请求地址（必须走本地代理）')
  assertEqual(call.target, 'https://dsh.r2049.cn/api/v1/auth/login', 'X-DS-Target')
  assertEqual(call.method, 'POST', 'X-DS-Method')
  assertEqual(call.body, { email: 'u@example.com', password: 'p@ss' }, 'body')
  assertEqual(call.headers.Authorization, undefined, '登录不该带 Authorization')
  assertEqual(call.headers['Content-Type'], 'application/json', 'Content-Type')
  assertEqual(result.token, ACCOUNT_TOKEN, '账号 token')
  assertEqual(result.expiresAt, 1786000000000, 'expiresAt')
})

check('normalizeServerUrl：去尾部斜杠 / 去 query / 拒绝 http 远端', async () => {
  assertEqual(normalizeServerUrl(' https://dsh.r2049.cn/ '), 'https://dsh.r2049.cn', '尾部斜杠')
  assertEqual(normalizeServerUrl('https://host.example/prefix/?x=1'), 'https://host.example/prefix', '保留反代前缀')
  assertEqual(normalizeServerUrl('http://localhost:8080'), 'http://localhost:8080', 'localhost 允许 http')
  await assertThrowsCode(async () => normalizeServerUrl('http://dsh.example.com'), 'INVALID_ARGUMENT', '远端 http')
  await assertThrowsCode(async () => normalizeServerUrl('ftp://x'), 'INVALID_ARGUMENT', '非 http(s)')
  await assertThrowsCode(async () => normalizeServerUrl(''), 'INVALID_ARGUMENT', '空地址')
})

check('registerDevice：Bearer 账号 token，body 是 {v:1, device}', async () => {
  const mock = createMock(() => ({ body: tokenPair }))
  const pair = await registerDevice(SERVER, ACCOUNT_TOKEN, descriptor, { fetch: mock.fetchImpl })

  const call = mock.calls[0]!
  assertEqual(call.target, 'https://dsh.r2049.cn/api/v1/devices/register', 'X-DS-Target')
  assertEqual(call.headers.Authorization, `Bearer ${ACCOUNT_TOKEN}`, 'Authorization')
  assertEqual(call.body, { v: 1, device: descriptor }, 'body')
  // 逐字段比，避免依赖 JSON 键顺序
  assertEqual(pair.accessToken, tokenPair.accessToken, 'accessToken')
  assertEqual(pair.refreshToken, tokenPair.refreshToken, 'refreshToken')
  assertEqual(pair.accessTokenExpiresAt, tokenPair.accessTokenExpiresAt, 'accessTokenExpiresAt')
  assertEqual(pair.refreshTokenExpiresAt, tokenPair.refreshTokenExpiresAt, 'refreshTokenExpiresAt')
})

check('registerDevice：缺账号 token 直接 AUTH_REQUIRED，不发请求', async () => {
  const mock = createMock(() => ({ body: tokenPair }))
  await assertThrowsCode(
    async () => registerDevice(SERVER, '', descriptor, { fetch: mock.fetchImpl }),
    'AUTH_REQUIRED',
    '空 token',
  )
  assertEqual(mock.calls.length, 0, '请求次数')
})

check('registerDevice：token 长度越界 / 到期时间非法 → INVALID_RESPONSE', async () => {
  const shortToken = createMock(() => ({ body: { ...tokenPair, accessToken: 'too-short' } }))
  await assertThrowsCode(
    async () => registerDevice(SERVER, ACCOUNT_TOKEN, descriptor, { fetch: shortToken.fetchImpl }),
    'INVALID_RESPONSE',
    'token 太短',
  )
  const badExpiry = createMock(() => ({ body: { ...tokenPair, accessTokenExpiresAt: -1 } }))
  await assertThrowsCode(
    async () => registerDevice(SERVER, ACCOUNT_TOKEN, descriptor, { fetch: badExpiry.fetchImpl }),
    'INVALID_RESPONSE',
    '到期时间为负',
  )
})

check('refreshToken：body 只有 {deviceId, refreshToken}，不带 Authorization', async () => {
  const mock = createMock(() => ({ body: tokenPair }))
  const pair = await refreshToken(SERVER, DEVICE_ID, 'old-refresh-token-0123', { fetch: mock.fetchImpl })

  const call = mock.calls[0]!
  assertEqual(call.target, 'https://dsh.r2049.cn/api/v1/auth/refresh', 'X-DS-Target')
  assertEqual(call.body, { deviceId: DEVICE_ID, refreshToken: 'old-refresh-token-0123' }, 'body')
  assertEqual(call.headers.Authorization, undefined, 'refresh 不带 Authorization')
  assertEqual(pair.accessToken, tokenPair.accessToken, '新 access token')
})

check('listDevices：默认读完所有页，cursor 正确透传，重复 deviceId 去重', async () => {
  const mock = createMock((request) => {
    if (request.target.includes('cursor=c2')) {
      return { body: { items: [{ deviceId: 'h2', role: 'host' }, { deviceId: 'h1', role: 'host' }], nextCursor: null } }
    }
    return { body: { items: [{ deviceId: 'h1', role: 'host', name: 'Workstation' }], nextCursor: 'c2' } }
  })
  const result = await listDevices(SERVER, tokenPair.accessToken, {}, { fetch: mock.fetchImpl })

  assertEqual(mock.calls.length, 2, '翻页次数')
  assertEqual(mock.calls[0]!.target.endsWith('/api/v1/devices?limit=50'), true, '第一页带 limit=50')
  assertEqual(mock.calls[1]!.target.endsWith('?limit=50&cursor=c2'), true, '第二页带 cursor')
  assertEqual(result.pages, 2, 'pages')
  assertEqual(result.items.map((item) => item.deviceId), ['h1', 'h2'], '去重后的 deviceId 顺序')
})

check('listDevices：缺 items 数组 → INVALID_RESPONSE（不能当成功空列表）', async () => {
  const mock = createMock(() => ({ body: { devices: [] } }))
  await assertThrowsCode(
    async () => listDevices(SERVER, tokenPair.accessToken, {}, { fetch: mock.fetchImpl }),
    'INVALID_RESPONSE',
    '缺 items',
  )
})

check('配对关系分页，用设备权限只解除指定的一条关系', async () => {
  const mock = createMock((request) => {
    if (request.method === 'DELETE') return { body: {} }
    if (request.target.includes('cursor=c2')) {
      return { body: { items: [{ membershipId: 'm2', peer: { deviceId: 'peer/two' } }], nextCursor: null } }
    }
    return { body: { items: [{ membershipId: 'm1', peer: { deviceId: 'peer-one' } }], nextCursor: 'c2' } }
  })
  const deps = { fetch: mock.fetchImpl }
  const rows = await listDeviceMemberships(SERVER, tokenPair.accessToken, deps)
  assertEqual(rows.map((item) => item.membershipId), ['m1', 'm2'], '读取两页')
  await revokeDeviceMembership(SERVER, tokenPair.accessToken, rows[1]!.peer.deviceId, deps)
  assertEqual(mock.calls[2]?.path, '/api/v1/device-memberships/peer%2Ftwo', '按对方设备编号解除配对')
  assertEqual(mock.calls[2]?.headers.Authorization, `Bearer ${tokenPair.accessToken}`, '使用设备 Bearer')
  await assertThrowsCode(() => revokeDeviceMembership(SERVER, tokenPair.accessToken, '..', deps), 'INVALID_ARGUMENT', '拒绝无效编号')
  assertEqual(mock.calls.length, 3, '无效编号未发请求')
})

check('listDevices：all=false 只读一页', async () => {
  const mock = createMock(() => ({ body: { items: [{ deviceId: 'h1', role: 'host' }], nextCursor: 'c2' } }))
  const result = await listDevices(SERVER, tokenPair.accessToken, { all: false }, { fetch: mock.fetchImpl })
  assertEqual(mock.calls.length, 1, '请求次数')
  assertEqual(result.pages, 1, 'pages')
})

check('getDevice：identityKey 必须是 43 字符规范 base64url，deviceId 必须回显一致', async () => {
  const ok = createMock(() => ({ body: { deviceId: 'h1', role: 'host', identityKey: IDENTITY_KEY } }))
  const record = await getDevice(SERVER, tokenPair.accessToken, 'h1', { fetch: ok.fetchImpl })
  assertEqual(record.identityKey, IDENTITY_KEY, 'identityKey')

  const shortKey = createMock(() => ({ body: { deviceId: 'h1', role: 'host', identityKey: 'A'.repeat(40) } }))
  await assertThrowsCode(
    async () => getDevice(SERVER, tokenPair.accessToken, 'h1', { fetch: shortKey.fetchImpl }),
    'INVALID_RESPONSE',
    '公钥长度不对',
  )

  const wrongId = createMock(() => ({ body: { deviceId: 'h2', role: 'host', identityKey: IDENTITY_KEY } }))
  await assertThrowsCode(
    async () => getDevice(SERVER, tokenPair.accessToken, 'h1', { fetch: wrongId.fetchImpl }),
    'INVALID_RESPONSE',
    'deviceId 不匹配',
  )
})

check('getPresence：deviceId 回显不一致 → INVALID_RESPONSE', async () => {
  const mock = createMock(() => ({ body: { deviceId: 'other', online: true } }))
  await assertThrowsCode(
    async () => getPresence(SERVER, tokenPair.accessToken, 'h1', { fetch: mock.fetchImpl }),
    'INVALID_RESPONSE',
    'presence deviceId 不匹配',
  )
})

/* ── 错误映射 ─────────────────────────────────────────────────────────── */

check('错误映射：fetch 抛异常 → NETWORK_ERROR（retryable）', async () => {
  const mock = createMock(() => ({ throwError: new TypeError('Failed to fetch') }))
  const error = await assertThrowsCode(
    async () => login(SERVER, 'u@example.com', 'p', { fetch: mock.fetchImpl }),
    'NETWORK_ERROR',
    '网络错',
  )
  assertEqual(error.retryable, true, 'retryable')
  assertEqual(error.status, undefined, '网络错没有 HTTP 状态码')
})

check('错误映射：401 空响应体 → AUTH_REQUIRED（不判定设备失效，可退避重试）', async () => {
  const mock = createMock(() => ({ status: 401, raw: '' }))
  const error = await assertThrowsCode(
    async () => listDevices(SERVER, tokenPair.accessToken, {}, { fetch: mock.fetchImpl }),
    'AUTH_REQUIRED',
    '401 空体',
  )
  assertEqual(error.status, 401, 'status')
  assertEqual(error.retryable, true, 'empty 401 必须标可重试（docs/protocol.md §8.2）')
})

check('错误映射：401 非 JSON 体 → 仍按 AUTH_REQUIRED 兜底', async () => {
  const mock = createMock(() => ({ status: 401, raw: '<html>nope</html>' }))
  await assertThrowsCode(
    async () => listDevices(SERVER, tokenPair.accessToken, {}, { fetch: mock.fetchImpl }),
    'AUTH_REQUIRED',
    '401 非 JSON',
  )
})

check('错误映射：401 AUTH_INVALID 直传服务器错误码并给中文文案', async () => {
  const mock = createMock(() => ({ status: 401, body: { error: { code: 'AUTH_INVALID', message: 'bad credentials' } } }))
  const error = await assertThrowsCode(
    async () => login(SERVER, 'u@example.com', 'p', { fetch: mock.fetchImpl }),
    'AUTH_INVALID',
    '登录失败',
  )
  assertEqual(error.status, 401, 'status')
  assertEqual(error.message, 'bad credentials', '保留服务器 message')
})

check('错误映射：403 invite_required → INVITE_REQUIRED（可读中文 + 留 TODO）', async () => {
  const mock = createMock(() => ({ status: 403, body: { error: { code: 'invite_required', message: 'invite code required' } } }))
  const error = await assertThrowsCode(
    async () => registerDevice(SERVER, ACCOUNT_TOKEN, descriptor, { fetch: mock.fetchImpl }),
    'INVITE_REQUIRED',
    '邀请码缺失',
  )
  assertContains(error.message, '邀请码', '文案里要讲清是邀请码')
  assertContains(error.message, 'TODO', '留 TODO 给集成阶段')
})

check('错误映射：403 DEVICE_OWNERSHIP_REQUIRED 直传错误码', async () => {
  const mock = createMock(() => ({
    status: 403,
    body: { error: { code: 'DEVICE_OWNERSHIP_REQUIRED', message: 'not your device' } },
  }))
  await assertThrowsCode(
    async () => registerDevice(SERVER, ACCOUNT_TOKEN, descriptor, { fetch: mock.fetchImpl }),
    'DEVICE_OWNERSHIP_REQUIRED',
    '归属校验失败',
  )
})

check('错误映射：403 无错误体 → FORBIDDEN', async () => {
  const mock = createMock(() => ({ status: 403, raw: '' }))
  await assertThrowsCode(
    async () => registerDevice(SERVER, ACCOUNT_TOKEN, descriptor, { fetch: mock.fetchImpl }),
    'FORBIDDEN',
    '403 空体',
  )
})

check('错误映射：429 → RATE_LIMITED，500 → SERVER_ERROR，503 → 可重试', async () => {
  const limited = createMock(() => ({ status: 429, raw: '' }))
  const rateError = await assertThrowsCode(
    async () => login(SERVER, 'u@example.com', 'p', { fetch: limited.fetchImpl }),
    'RATE_LIMITED',
    '429',
  )
  assertEqual(rateError.retryable, true, '429 可重试')

  const broken = createMock(() => ({ status: 500, raw: '' }))
  const serverError = await assertThrowsCode(
    async () => login(SERVER, 'u@example.com', 'p', { fetch: broken.fetchImpl }),
    'SERVER_ERROR',
    '500',
  )
  assertEqual(serverError.retryable, true, '5xx 可重试')

  const busy = createMock(() => ({ status: 503, raw: '' }))
  const busyError = await assertThrowsCode(
    async () => refreshToken(SERVER, DEVICE_ID, 'old-refresh-token-0123', { fetch: busy.fetchImpl }),
    'SERVER_UNAVAILABLE',
    '503',
  )
  assertEqual(busyError.retryable, true, '503 可重试（docs/protocol.md §8.2）')
})

check('错误映射：200 但不是 JSON → INVALID_RESPONSE', async () => {
  const mock = createMock(() => ({ raw: 'not json' }))
  await assertThrowsCode(
    async () => login(SERVER, 'u@example.com', 'p', { fetch: mock.fetchImpl }),
    'INVALID_RESPONSE',
    '坏 JSON',
  )
})

check('错误映射：200 但缺 token → INVALID_RESPONSE', async () => {
  const mock = createMock(() => ({ body: { account: 'u@example.com' } }))
  await assertThrowsCode(
    async () => login(SERVER, 'u@example.com', 'p', { fetch: mock.fetchImpl }),
    'INVALID_RESPONSE',
    '缺 token',
  )
})

/* ── 刷新重试 ─────────────────────────────────────────────────────────── */

const auth = { deviceId: DEVICE_ID, accessToken: 'stale-access-token-0123', refreshToken: 'refresh-token-0123' }

check('withRefreshRetry：401 → 刷新一次 → 用新 token 重试成功', async () => {
  let deviceListCalls = 0
  const refreshed: string[] = []
  const mock = createMock((request) => {
    if (request.path === '/api/v1/auth/refresh') return { body: tokenPair }
    deviceListCalls += 1
    if (deviceListCalls === 1) return { status: 401, body: { error: { code: 'TOKEN_EXPIRED', message: 'expired' } } }
    return { body: { items: [{ deviceId: 'h1', role: 'host' }] } }
  })

  const result = await withRefreshRetry({
    server: SERVER,
    auth,
    run: (accessToken) => listDevices(SERVER, accessToken, {}, { fetch: mock.fetchImpl }),
    onRefresh: (pair) => {
      refreshed.push(pair.accessToken)
    },
    deps: { fetch: mock.fetchImpl },
  })

  assertEqual(deviceListCalls, 2, '设备列表被调 2 次')
  assertEqual(mock.calls.filter((call) => call.path === '/api/v1/auth/refresh').length, 1, 'refresh 调 1 次')
  assertEqual(refreshed, [tokenPair.accessToken], 'onRefresh 拿到新 pair')
  const listCalls = mock.calls.filter((call) => call.path === '/api/v1/devices')
  assertEqual(listCalls.at(-1)!.headers.Authorization, `Bearer ${tokenPair.accessToken}`, '重试用的是新 token')
  assertEqual(result.items.length, 1, '最终结果')
})

check('withRefreshRetry：两次都 401 → 只刷新一次就放弃（不递归）', async () => {
  let deviceListCalls = 0
  const mock = createMock((request) => {
    if (request.path === '/api/v1/auth/refresh') return { body: tokenPair }
    deviceListCalls += 1
    return { status: 401, body: { error: { code: 'TOKEN_EXPIRED', message: 'expired' } } }
  })

  await assertThrowsCode(
    () =>
      withRefreshRetry({
        server: SERVER,
        auth,
        run: (accessToken) => listDevices(SERVER, accessToken, {}, { fetch: mock.fetchImpl }),
        onRefresh: () => undefined,
        deps: { fetch: mock.fetchImpl },
      }),
    'TOKEN_EXPIRED',
    '二次 401',
  )
  assertEqual(deviceListCalls, 2, '最多重试一次')
  assertEqual(mock.calls.filter((call) => call.path === '/api/v1/auth/refresh').length, 1, 'refresh 只调 1 次')
})

check('withRefreshRetry：非 401（500）不刷新', async () => {
  const mock = createMock(() => ({ status: 500, raw: '' }))
  await assertThrowsCode(
    () =>
      withRefreshRetry({
        server: SERVER,
        auth,
        run: (accessToken) => listDevices(SERVER, accessToken, {}, { fetch: mock.fetchImpl }),
        onRefresh: () => undefined,
        deps: { fetch: mock.fetchImpl },
      }),
    'SERVER_ERROR',
    '500 不刷新',
  )
  assertEqual(mock.calls.filter((call) => call.path === '/api/v1/auth/refresh').length, 0, 'refresh 不该被调用')
})

check('withRefreshRetry：DEVICE_REVOKED 不刷新（直接失败）', async () => {
  const mock = createMock(() => ({ status: 401, body: { error: { code: 'DEVICE_REVOKED', message: 'revoked' } } }))
  await assertThrowsCode(
    () =>
      withRefreshRetry({
        server: SERVER,
        auth,
        run: (accessToken) => listDevices(SERVER, accessToken, {}, { fetch: mock.fetchImpl }),
        onRefresh: () => undefined,
        deps: { fetch: mock.fetchImpl },
      }),
    'DEVICE_REVOKED',
    '设备被撤销',
  )
  assertEqual(mock.calls.filter((call) => call.path === '/api/v1/auth/refresh').length, 0, 'refresh 不该被调用')
})

check('withRefreshRetry：本地没有 refreshToken → AUTH_REQUIRED，不发 refresh 请求', async () => {
  const mock = createMock(() => ({ status: 401, body: { error: { code: 'TOKEN_EXPIRED', message: 'expired' } } }))
  await assertThrowsCode(
    () =>
      withRefreshRetry({
        server: SERVER,
        auth: { ...auth, refreshToken: '' },
        run: (accessToken) => listDevices(SERVER, accessToken, {}, { fetch: mock.fetchImpl }),
        onRefresh: () => undefined,
        deps: { fetch: mock.fetchImpl },
      }),
    'AUTH_REQUIRED',
    '没有 refreshToken',
  )
  assertEqual(mock.calls.filter((call) => call.path === '/api/v1/auth/refresh').length, 0, 'refresh 不该被调用')
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
  // 红了必须真的红（仓库约定：检查脚本结尾必须设置退出码）
  process.exit(failures === 0 ? 0 : 1)
}

void main()
