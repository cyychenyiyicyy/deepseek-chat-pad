/**
 * 登录会话可恢复（K2）+ 原生保活（K1）自测：`oauth.ts` 的 pending-login + `keepAlive.ts`。
 *
 * 跑法（workdir = projects\deepseek-tablet\web）：
 *   npx tsx src/services/remote/__selftest__/login-resume.selftest.mts
 *
 * 覆盖（对应任务书第 4 条）：
 *   1. pending 写入 / 读取：`dsp.remote.pending-login.v1` 字段齐全、**不含 token**；
 *   2. 过期清理：本地时钟已过期 → 一个请求都不打，直接清理并返回原因；
 *   3. complete 落盘：轮询拿到 token → `/auth/me` → `/devices/register` → 账号落盘 → 删键；
 *   4. 网络失败重试不丢会话：`NETWORK_ERROR` 连着两次，盘上的会话**没被删**，之后照样完成；
 *   5. 并发调用只跑一个轮询：两个 `resumePendingLogin()` 拿到同一个结果，请求数不翻倍；
 *   6. 取消后不再轮询：abort → `cancelled` + 清键 + 之后请求数不再增长；
 *   7. 401 / 404 → 终止并清理（qrId 已作废，重试没有意义）；
 *   8. 连败超限 / 落地回调失败 → `failed` + 清键；
 *   9. 新会话不被旧恢复流程误删（`clearPendingLoginIf` 的语义）；
 *  10. 原生授权容器：默认 `mode:'external'`、`open:false` 不算失败、`no_browser` 回退 inline；
 *  11. 原生保活：探测必须用 `.json`（HTML 200 视为不支持）、`shouldRun && !running` 才补 start。
 *
 * 不联网：REST 走 mock 的 `/__ds_proxy`，原生桥走 mock 的 `/__ds_auth/*` 与
 * `/__ds_keepalive/*`；localStorage 用内存实现（Node 里没有 webstorage）。
 * 结尾按仓库约定设置真实退出码。
 */

import { probeKeepAlive, syncKeepAlive, KEEPALIVE_START_PATH, KEEPALIVE_STATE_PATH } from '../keepAlive.js'
import {
  NATIVE_AUTH_OPEN_PATH,
  PENDING_LOGIN_STORAGE_KEY,
  isResumingPendingLogin,
  readPendingLogin,
  resumePendingLogin,
  startProviderLogin,
  writePendingLogin,
  type PendingLoginRecord,
  type ProviderLoginSession,
  type ResumeLoginResult,
} from '../oauth.js'
import {
  RemoteApiError,
  type FetchLike,
  type OAuthProvider,
  type ServerApiDeps,
} from '../serverApi.js'

/* ── 最小断言器（与 oauth.selftest 同一套写法） ───────────────────────── */

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

const assertTrue = (value: boolean, label: string): void => {
  if (!value) fail(label)
}

const assertContains = (haystack: string, needle: string, label: string): void => {
  if (!haystack.includes(needle)) fail(`${label}：${JSON.stringify(haystack)} 里没有 ${JSON.stringify(needle)}`)
}

const assertAbsent = (haystack: string, needle: string, label: string): void => {
  if (haystack.includes(needle)) fail(`${label}：${JSON.stringify(haystack)} 里不该出现 ${JSON.stringify(needle)}`)
}

/* ── 内存版 localStorage（Node 里没有 webstorage） ───────────────────── */

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

let storage = new MemoryStorage()

/** 每个 check 前重装一次：identity / 账号 / pending-login 全部从干净状态开始 */
const resetStorage = (): void => {
  storage = new MemoryStorage()
  ;(globalThis as unknown as Record<string, unknown>).localStorage = storage
}

const storageDump = (): string => {
  const parts: string[] = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key !== null) parts.push(`${key}=${storage.getItem(key) ?? ''}`)
  }
  return parts.join('\n')
}

/* ── mock：REST（/__ds_proxy）+ 原生授权（/__ds_auth/*）+ 保活（/__ds_keepalive/*） ── */

interface ProxiedRequest {
  target: string
  path: string
  method: string
  headers: Record<string, string>
  body: unknown
}

interface NativeCall {
  path: string
  method: string
  headers: Record<string, string>
  body: unknown
}

interface MockReply {
  status?: number
  body?: unknown
  raw?: string
  throwError?: Error
}

const decodeBase64Url = (value: string): string => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
}

const toResponse = (result: MockReply): Response => {
  if (result.throwError !== undefined) throw result.throwError
  const text = result.raw ?? (result.body === undefined ? '' : JSON.stringify(result.body))
  return new Response(text, { status: result.status ?? 200, headers: { 'Content-Type': 'application/json' } })
}

interface MockOptions {
  /** REST（`/__ds_proxy`）响应 */
  handler?: (request: ProxiedRequest) => MockReply
  /** 原生授权容器（`/__ds_auth/*`）；缺省 404 = 非壳环境 */
  native?: (call: NativeCall) => MockReply
  /** 原生保活（`/__ds_keepalive/*`）；缺省 404 = 没有这套端点 */
  keepAlive?: (call: NativeCall) => MockReply
}

const createMock = (options: MockOptions) => {
  const proxyCalls: ProxiedRequest[] = []
  const nativeCalls: NativeCall[] = []
  const keepAliveCalls: NativeCall[] = []

  const parseBody = (init: RequestInit): unknown =>
    init.body === null || init.body === undefined ? undefined : JSON.parse(String(init.body))

  const fetchImpl: FetchLike = async (url, init) => {
    if (url.startsWith('/__ds_auth/')) {
      const call: NativeCall = {
        path: url,
        method: String(init.method ?? 'GET'),
        headers: { ...((init.headers ?? {}) as Record<string, string>) },
        body: parseBody(init),
      }
      nativeCalls.push(call)
      return toResponse(options.native?.(call) ?? { status: 404, raw: 'Not Found' })
    }
    if (url.startsWith('/__ds_keepalive/')) {
      const call: NativeCall = {
        path: url,
        method: String(init.method ?? 'GET'),
        headers: { ...((init.headers ?? {}) as Record<string, string>) },
        body: parseBody(init),
      }
      keepAliveCalls.push(call)
      return toResponse(options.keepAlive?.(call) ?? { status: 404, raw: 'Not Found' })
    }

    const headers = (init.headers ?? {}) as Record<string, string>
    const target = decodeBase64Url(String(headers['X-DS-Target']))
    const request: ProxiedRequest = {
      target,
      path: new URL(target).pathname,
      method: String(headers['X-DS-Method']),
      headers: JSON.parse(decodeBase64Url(String(headers['X-DS-Headers']))) as Record<string, string>,
      body: parseBody(init),
    }
    proxyCalls.push(request)
    return toResponse(options.handler?.(request) ?? { status: 404, raw: '' })
  }

  const deps = { nativeFetch: fetchImpl, api: { fetch: fetchImpl } as ServerApiDeps }
  return { fetchImpl, deps, proxyCalls, nativeCalls, keepAliveCalls }
}

/* ── 固定数据 ─────────────────────────────────────────────────────────── */

const BASE = 'https://dsh.r2049.cn'
const QR_ID = 'q'.repeat(24)
const SCAN_URL = `${BASE}/api/v1/auth/qr/abc123`
const QR_TOKEN = 'qr-account-token-0123456789'
const DEVICE_ACCESS_TOKEN = 'access-token-0123456789'

const ZHIHU: OAuthProvider = {
  id: 'zhihu',
  displayName: '知乎',
  startUrl: '/api/v1/auth/oauth/start',
  qrStartUrl: '/api/v1/auth/oauth/qr/start?provider=zhihu',
}

const tokenPair = {
  accessToken: DEVICE_ACCESS_TOKEN,
  accessTokenExpiresAt: 1786000000000,
  refreshToken: 'refresh-token-0123456789',
  refreshTokenExpiresAt: 1789000000000,
}

const QR_SESSION_PATH = '/api/v1/auth/oauth/qr/start'
const QR_POLL_PATH = `/api/v1/auth/oauth/qr/${QR_ID}`

/** 「正常登录」的 REST 应答；`poll` 决定每次轮询返回什么 */
const happyHandler =
  (poll: () => MockReply): NonNullable<MockOptions['handler']> =>
  (request) => {
    if (request.path === '/health') return { body: { status: 'ok' } }
    if (request.path === QR_SESSION_PATH) return { body: { qrId: QR_ID, scanUrl: SCAN_URL, expiresIn: 600 } }
    if (request.path === QR_POLL_PATH) return poll()
    if (request.path === '/api/v1/auth/me') return { body: { account: 'u@example.com' } }
    if (request.path === '/api/v1/devices/register') return { body: tokenPair }
    return { status: 404, body: { error: { code: 'NOT_FOUND', message: `unexpected ${request.path}` } } }
  }

/** 直接塞一条「待完成会话」，模拟「App 被杀之前刚发起登录」 */
const seedPending = (patch: Partial<PendingLoginRecord> = {}): PendingLoginRecord => {
  const now = Date.now()
  const record: PendingLoginRecord = {
    serverUrl: BASE,
    providerId: ZHIHU.id,
    mode: 'browser',
    qrId: QR_ID,
    scanUrl: SCAN_URL,
    startedAt: now - 5_000,
    expiresAt: now + 600_000,
    ...patch,
  }
  assertTrue(writePendingLogin(record), '落盘成功')
  return record
}

const readAccounts = (): Array<Record<string, unknown>> => {
  const raw = storage.getItem('dsp.remote.accounts.v1')
  if (raw === null) return []
  return (JSON.parse(raw) as { items: Array<Record<string, unknown>> }).items
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 轮询等待条件成立（自测里只用于「等第一拍真的发出去」这种时序断言） */
const waitFor = async (predicate: () => boolean, label: string, budgetMs = 2_000): Promise<void> => {
  const deadline = Date.now() + budgetMs
  while (!predicate()) {
    if (Date.now() >= deadline) fail(`等待超时：${label}`)
    await sleep(2)
  }
}

/* ── 1. pending 写入 / 读取 ───────────────────────────────────────────── */

check('startProviderLogin(browser)：默认系统浏览器 + 立刻落盘待完成会话（不含 token）', async () => {
  resetStorage()
  const mock = createMock({
    handler: happyHandler(() => ({ body: { status: 'pending' } })),
    // 原生 v2 语义：external 同步返回，`open:false` 是正常现象
    native: () => ({ body: { ok: true, open: false, mode: 'external', launched: true, id: 1, url: SCAN_URL } }),
  })

  const session = await startProviderLogin(BASE, ZHIHU, 'browser', { deps: mock.deps, title: '知乎登录' })
  assertEqual(session.mode, 'browser', 'mode')
  assertEqual(session.qrId, QR_ID, 'qrId')
  assertEqual(session.notice, undefined, 'open:false 不是失败（不该有降级提示）')

  const open = mock.nativeCalls.filter((call) => call.path === NATIVE_AUTH_OPEN_PATH)
  assertEqual(open.length, 1, 'open 只调一次')
  assertEqual((open[0]!.body as { mode?: string }).mode, 'external', '默认把授权页交给系统浏览器')

  const record = readPendingLogin()
  assertTrue(record !== null, '盘上有待完成会话')
  assertEqual(record, {
    serverUrl: BASE,
    providerId: ZHIHU.id,
    mode: 'browser',
    qrId: QR_ID,
    scanUrl: SCAN_URL,
    startedAt: record!.startedAt,
    expiresAt: record!.expiresAt,
  }, '记录的字段')
  assertTrue(record!.expiresAt > record!.startedAt, 'expiresAt 在 startedAt 之后')
  assertTrue(record!.expiresAt - record!.startedAt >= 500_000, 'expiresIn 按秒换算成毫秒')

  // token 绝不落这个键（也不在任何 localStorage 值里出现）
  assertAbsent(storage.getItem(PENDING_LOGIN_STORAGE_KEY) ?? '', 'token', 'pending 键里不许出现 token')
  assertAbsent(storageDump(), QR_TOKEN, 'localStorage 里不许出现一次性账号 token')
})

check('readPendingLogin：坏数据当没有，并顺手删键', async () => {
  resetStorage()
  storage.setItem(PENDING_LOGIN_STORAGE_KEY, '{"v":1}')
  assertEqual(readPendingLogin(), null, '坏数据 → null')
  assertEqual(storage.getItem(PENDING_LOGIN_STORAGE_KEY), null, '坏键被删掉')

  // 缺字段 / 类型不对同样当没有
  for (const bad of [
    'null',
    '[]',
    JSON.stringify({ serverUrl: BASE, providerId: 'zhihu', mode: 'browser', qrId: '', scanUrl: SCAN_URL, startedAt: 1, expiresAt: 2 }),
    JSON.stringify({ serverUrl: BASE, providerId: 'zhihu', mode: 'weird', qrId: QR_ID, scanUrl: SCAN_URL, startedAt: 1, expiresAt: 2 }),
    JSON.stringify({ serverUrl: BASE, providerId: 'zhihu', mode: 'browser', qrId: QR_ID, scanUrl: SCAN_URL, startedAt: 5, expiresAt: 2 }),
  ]) {
    storage.setItem(PENDING_LOGIN_STORAGE_KEY, bad)
    assertEqual(readPendingLogin(), null, `坏记录 ${bad.slice(0, 24)} → null`)
  }
})

/* ── 2. 过期清理 / 无会话 ─────────────────────────────────────────────── */

check('resumePendingLogin：没有待完成会话 → none，一个请求都不打', async () => {
  resetStorage()
  const mock = createMock({ handler: happyHandler(() => ({ body: { status: 'pending' } })) })
  const result = await resumePendingLogin({ deps: mock.deps, intervalMs: 5 })
  assertEqual(result.status, 'none', 'status')
  assertEqual(mock.proxyCalls.length, 0, '零请求')
})

check('resumePendingLogin：本地已过期 → expired + 清键，一个请求都不打', async () => {
  resetStorage()
  seedPending({ startedAt: Date.now() - 20_000, expiresAt: Date.now() - 1_000 })
  const mock = createMock({ handler: happyHandler(() => ({ body: { status: 'pending' } })) })
  const result = await resumePendingLogin({ deps: mock.deps, intervalMs: 5 })
  assertEqual(result.status, 'expired', 'status')
  assertEqual(result.code, 'QR_EXPIRED', 'code')
  assertContains(result.message ?? '', '过期', '文案')
  assertEqual(readPendingLogin(), null, '键被清掉')
  assertEqual(mock.proxyCalls.length, 0, '过期不联网')
})

/* ── 3. complete 落盘 ─────────────────────────────────────────────────── */

check('resumePendingLogin：complete → 落账号 + 注册设备 + 清键（不建链）', async () => {
  resetStorage()
  seedPending()
  const mock = createMock({
    handler: happyHandler(() => ({ body: { status: 'complete', token: QR_TOKEN } })),
  })
  const result = await resumePendingLogin({ deps: mock.deps, intervalMs: 5 })
  assertEqual(result.status, 'complete', 'status')
  assertEqual(result.result?.account, 'u@example.com', '账号名')
  assertEqual(readPendingLogin(), null, '完成后清键')

  const accounts = readAccounts()
  assertEqual(accounts.length, 1, '账号落了 1 条')
  const account = accounts[0]!
  assertEqual(account.email, 'u@example.com', '账号主键')
  assertEqual(account.serverUrl, BASE, '服务器')
  assertEqual(account.scope, 'device', 'scope = device（已注册设备）')
  assertEqual(account.loginMethod, 'oauth', 'loginMethod = oauth')
  assertEqual(account.accessToken, DEVICE_ACCESS_TOKEN, '落的是设备 token（不是一次性账号 token）')
  assertTrue(typeof account.deviceId === 'string' && (account.deviceId as string).length > 0, 'deviceId 非空')

  // 账号 token 只在 Authorization 头里出现过（registerDevice 用的就是它）
  const register = mock.proxyCalls.find((call) => call.path === '/api/v1/devices/register')
  assertEqual(register?.headers.Authorization, `Bearer ${QR_TOKEN}`, '注册设备带的是账号 token')
  // 只打了一拍（complete 之后不许再 poll：token 只能领一次）
  assertEqual(mock.proxyCalls.filter((call) => call.path === QR_POLL_PATH).length, 1, 'complete 之后不再轮询')
})

/* ── 4. 网络失败重试不丢会话 ──────────────────────────────────────────── */

check('resumePendingLogin：网络瞬断继续轮询，会话原封不动（不丢）', async () => {
  resetStorage()
  seedPending()
  let polls = 0
  const mock = createMock({
    handler: happyHandler(() => {
      polls += 1
      if (polls <= 2) return { throwError: new Error('network down') }
      if (polls === 2) return { body: { status: 'pending' } }
      return polls === 3 ? { body: { status: 'pending' } } : { body: { status: 'complete', token: QR_TOKEN } }
    }),
  })

  // 第一次失败之后、恢复之前，盘上的会话必须还在
  const result = await resumePendingLogin({ deps: mock.deps, intervalMs: 5 })
  assertEqual(result.status, 'complete', '两次瞬断后仍然完成')
  assertTrue(polls >= 4, '确实重试了')
  assertEqual(readPendingLogin(), null, '完成后才清键')
})

check('resumePendingLogin：网络失败期间键一直在（App 再被杀也还能续）', async () => {
  resetStorage()
  seedPending()
  let polls = 0
  let keySeenWhileFailing: string | null = 'never'
  const mock = createMock({
    handler: happyHandler(() => {
      polls += 1
      if (polls === 1) {
        keySeenWhileFailing = storage.getItem(PENDING_LOGIN_STORAGE_KEY)
        return { throwError: new Error('network down') }
      }
      return { body: { status: 'pending' } }
    }),
  })

  const controller = new AbortController()
  const run = resumePendingLogin({ deps: mock.deps, intervalMs: 20, signal: controller.signal })
  await waitFor(() => polls >= 1, '第一拍')
  assertTrue(keySeenWhileFailing !== null && keySeenWhileFailing !== 'never', '请求失败时键还在')

  // 再等两拍：失败之后它继续轮，盘上的记录一直没被删（进程此刻被杀也还能续）
  await sleep(60)
  assertTrue(readPendingLogin() !== null, '失败重试期间键仍然在')
  assertTrue(polls >= 2, '瞬断之后确实又打了一拍')

  controller.abort()
  assertEqual((await run).status, 'cancelled', '收尾：取消（不留后台轮询）')
})

check('resumePendingLogin：连败超限 → failed + 清键', async () => {
  resetStorage()
  seedPending()
  let polls = 0
  const mock = createMock({
    handler: happyHandler(() => {
      polls += 1
      return { throwError: new Error('network down') }
    }),
  })
  const result = await resumePendingLogin({ deps: mock.deps, intervalMs: 5 })
  assertEqual(result.status, 'failed', 'status')
  assertEqual(polls, 4, '连续放 3 次，第 4 次终止（MAX_POLL_FAILURES=3）')
  assertEqual(readPendingLogin(), null, '失败也清键')
})

/* ── 5. 并发只跑一个轮询 ──────────────────────────────────────────────── */

check('resumePendingLogin：并发调用只跑一个轮询（两个调用拿到同一个结果）', async () => {
  resetStorage()
  seedPending()
  let polls = 0
  const mock = createMock({
    handler: happyHandler(() => {
      polls += 1
      return polls < 3 ? { body: { status: 'pending' } } : { body: { status: 'complete', token: QR_TOKEN } }
    }),
  })

  const options = { deps: mock.deps, intervalMs: 5 }
  const first = resumePendingLogin(options)
  const second = resumePendingLogin(options)
  const [a, b] = await Promise.all([first, second])
  assertTrue(a === b, '两个调用拿到同一个结果对象')
  assertEqual(a.status, 'complete', 'status')
  assertEqual(polls, 3, '只跑了一条轮询（2 次 pending + 1 次 complete）')
})

/* ── 6. 取消 ──────────────────────────────────────────────────────────── */

check('resumePendingLogin：取消 → cancelled + 清键 + 之后不再轮询', async () => {
  resetStorage()
  seedPending()
  let polls = 0
  const mock = createMock({
    handler: happyHandler(() => {
      polls += 1
      return { body: { status: 'pending' } }
    }),
  })

  const controller = new AbortController()
  const run = resumePendingLogin({ deps: mock.deps, intervalMs: 20, signal: controller.signal })
  await waitFor(() => polls >= 1, '第一拍')
  controller.abort()
  const result = await run
  assertEqual(result.status, 'cancelled', 'status')
  assertEqual(result.code, 'OAUTH_ABORTED', 'code')
  assertEqual(readPendingLogin(), null, '取消后清键（进程被杀也不会再续）')

  const settled = polls
  await sleep(120)
  assertEqual(polls, settled, '取消之后不再轮询')
})

check('resumePendingLogin：旧恢复流程不会删掉新会话（clearPendingLoginIf）', async () => {
  resetStorage()
  const stale = seedPending()
  const mock = createMock({
    handler: happyHandler(() => ({ body: { status: 'pending' } })),
  })
  const controller = new AbortController()
  const run = resumePendingLogin({ deps: mock.deps, intervalMs: 20, signal: controller.signal })
  await waitFor(() => mock.proxyCalls.length >= 1, '第一拍')

  // 用户中途重新发起登录：盘上换成新 qrId
  const fresh: PendingLoginRecord = { ...stale, qrId: 'n'.repeat(24), startedAt: Date.now(), expiresAt: Date.now() + 600_000 }
  assertTrue(writePendingLogin(fresh), '新记录落盘')

  controller.abort()
  const result = await run
  assertEqual(result.status, 'cancelled', '旧流程取消')
  assertEqual(readPendingLogin()?.qrId, fresh.qrId, '新会话还在（没被旧流程删掉）')
})

/* ── 7. 401 / 404 终止 ───────────────────────────────────────────────── */

check('resumePendingLogin：401 / 404 → 终止并清键（qrId 已作废，重试没意义）', async () => {
  for (const [status, code] of [[404, 'NOT_FOUND'], [401, 'AUTH_REQUIRED']] as const) {
    resetStorage()
    seedPending()
    let polls = 0
    const mock = createMock({
      handler: happyHandler(() => {
        polls += 1
        return { status, body: { error: { code, message: 'no such qr session' } } }
      }),
    })
    const result: ResumeLoginResult = await resumePendingLogin({ deps: mock.deps, intervalMs: 5 })
    assertEqual(result.status, 'failed', `${status} → failed`)
    assertEqual(result.code, code, `${status} 的机器码`)
    assertContains(result.message ?? '', '失效', `${status} 的文案`)
    assertEqual(polls, 1, `${status} 只打一次就终止`)
    assertEqual(readPendingLogin(), null, `${status} 也清键`)
  }
})

check('resumePendingLogin：complete 但落地失败 → failed + 清键（token 已经用掉了）', async () => {
  resetStorage()
  seedPending()
  const mock = createMock({
    handler: happyHandler(() => ({ body: { status: 'complete', token: QR_TOKEN } })),
  })
  const result = await resumePendingLogin({
    deps: mock.deps,
    intervalMs: 5,
    complete: () => {
      throw new RemoteApiError('DEVICE_REGISTER_FAILED', '服务器拒绝注册设备')
    },
  })
  assertEqual(result.status, 'failed', 'status')
  assertContains(result.message ?? '', '换取设备凭据失败', '文案讲清「授权成功但落不下去」')
  assertEqual(readPendingLogin(), null, '清键')
})

/* ── 8. 原生授权容器：mode 对齐 + no_browser 回退 ─────────────────────── */

check('startProviderLogin：no_browser → 回退 inline 重试一次，并带上降级提示', async () => {
  resetStorage()
  const modes: string[] = []
  const mock = createMock({
    handler: happyHandler(() => ({ body: { status: 'pending' } })),
    native: (call) => {
      const mode = String((call.body as { mode?: string }).mode ?? '')
      modes.push(mode)
      if (mode === 'external') return { status: 500, body: { ok: false, error: 'no_browser', suggestInline: true } }
      return { body: { ok: true, open: true, mode: 'inline', id: 2, url: SCAN_URL } }
    },
  })

  const session: ProviderLoginSession = await startProviderLogin(BASE, ZHIHU, 'browser', { deps: mock.deps })
  assertEqual(modes, ['external', 'inline'], '先 external，失败回退 inline')
  assertEqual(session.authMode, 'inline', '会话记录了实际方式')
  assertContains(session.notice ?? '', '已改用应用内登录', '降级要有可读提示')
  assertTrue(readPendingLogin() !== null, '回退成功 → 会话仍然可续（键还在）')
})

check('startProviderLogin：inline 也失败 → 清键并把错误抛给 UI', async () => {
  resetStorage()
  const mock = createMock({
    handler: happyHandler(() => ({ body: { status: 'pending' } })),
    native: () => ({ status: 500, body: { ok: false, error: 'no_browser', suggestInline: true } }),
  })
  try {
    await startProviderLogin(BASE, ZHIHU, 'browser', { deps: mock.deps })
    fail('应该抛错')
  } catch (error) {
    assertTrue(error instanceof RemoteApiError, '是 RemoteApiError')
    assertEqual((error as RemoteApiError).code, 'NATIVE_BRIDGE_ERROR', 'code')
  }
  assertEqual(readPendingLogin(), null, '打不开授权页就不留待完成会话')
})

check('startProviderLogin(qr)：也落盘（同一套恢复流程），但不碰原生桥', async () => {
  resetStorage()
  const mock = createMock({
    handler: happyHandler(() => ({ body: { status: 'pending' } })),
    native: () => ({ body: { ok: true } }),
  })
  const session = await startProviderLogin(BASE, ZHIHU, 'qr', { deps: mock.deps })
  assertEqual(session.mode, 'qr', 'mode')
  assertEqual(mock.nativeCalls.length, 0, 'qr 模式不碰原生桥')
  assertEqual(readPendingLogin()?.mode, 'qr', '盘上是 qr 会话')
})

/* ── 9. 原生保活（K1） ────────────────────────────────────────────────── */

check('keepAlive：探测必须用 state.json；HTML 200 一律当「不支持」', async () => {
  const html = createMock({
    keepAlive: () => ({ raw: '<!doctype html><html></html>' }),
  })
  assertEqual(await probeKeepAlive({ fetch: html.fetchImpl }), null, 'HTML 回落 → 不支持')
  assertEqual(html.keepAliveCalls[0]?.path, KEEPALIVE_STATE_PATH, '探的是带 .json 的路径')
  assertContains(KEEPALIVE_STATE_PATH, '.json', '契约要求带扩展名')

  const missing = createMock({ keepAlive: () => ({ status: 404, raw: 'Not Found' }) })
  assertEqual(await probeKeepAlive({ fetch: missing.fetchImpl }), null, '404 → 不支持')

  const ok = createMock({
    keepAlive: () => ({
      body: { ok: true, running: false, shouldRun: true, notificationsGranted: false, batteryExempt: false, sdkInt: 33 },
    }),
  })
  assertEqual(await probeKeepAlive({ fetch: ok.fetchImpl }), {
    supported: true,
    running: false,
    shouldRun: true,
    notificationsGranted: false,
    batteryExempt: false,
    sdkInt: 33,
  }, '正常快照')
})

check('keepAlive：shouldRun && !running 才补 start；running 时不重复拉起', async () => {
  const needsStart = createMock({
    keepAlive: (call) =>
      call.path === KEEPALIVE_START_PATH
        ? { body: { ok: true, running: true } }
        : { body: { ok: true, running: false, shouldRun: true, notificationsGranted: true, batteryExempt: true } },
  })
  const started = await syncKeepAlive({ fetch: needsStart.fetchImpl })
  assertEqual(started?.running, true, '补了一次 start → running')
  assertEqual(needsStart.keepAliveCalls.filter((call) => call.path === KEEPALIVE_START_PATH).length, 1, '只 start 一次')

  const alreadyRunning = createMock({
    keepAlive: () => ({ body: { ok: true, running: true, shouldRun: true, notificationsGranted: true, batteryExempt: true } }),
  })
  const snapshot = await syncKeepAlive({ fetch: alreadyRunning.fetchImpl })
  assertEqual(snapshot?.running, true, 'running')
  assertEqual(alreadyRunning.keepAliveCalls.filter((call) => call.path === KEEPALIVE_START_PATH).length, 0, '不该重复 start')

  const idle = createMock({
    keepAlive: () => ({ body: { ok: true, running: false, shouldRun: false, notificationsGranted: true, batteryExempt: true } }),
  })
  const idleSnapshot = await syncKeepAlive({ fetch: idle.fetchImpl })
  assertEqual(idleSnapshot?.shouldRun, false, 'shouldRun=false')
  assertEqual(idle.keepAliveCalls.filter((call) => call.path === KEEPALIVE_START_PATH).length, 0, '不该 start')
})

/* ── 跑 ───────────────────────────────────────────────────────────────── */

const main = async (): Promise<void> => {
  let failures = 0
  for (const item of checks) {
    const startedAt = Date.now()
    try {
      await item.run()
      console.log(`PASS  ${item.name}${describeDuration(startedAt)}`)
    } catch (error) {
      failures += 1
      console.error(`FAIL  ${item.name}${describeDuration(startedAt)}`)
      console.error(`      ${error instanceof Error ? error.message : String(error)}`)
    }
    // 每个 check 之后不许还挂着轮询：否则下一个 check 会拿到上一条的 in-flight Promise
    if (isResumingPendingLogin()) {
      failures += 1
      console.error('      [LEAK] 上一个检查结束时还有恢复流程在跑（会串到下一个检查）')
    }
  }
  console.log(`\n${checks.length - failures} PASS / ${failures} FAIL / ${checks.length} TOTAL`)
  // 红了必须真的红（仓库约定：检查脚本必须设置退出码）
  process.exit(failures === 0 ? 0 : 1)
}

const describeDuration = (startedAt: number): string => `  (${Date.now() - startedAt}ms)`

void main()
