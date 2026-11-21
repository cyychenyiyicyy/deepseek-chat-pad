/**
 * 多方式登录自测：`serverApi` 的 OAuth/扫码部分 + `oauth.ts` 的登录编排 + `qr.ts`。
 *
 * 跑法（workdir = projects\deepseek-tablet\web）：
 *   npx tsx src/services/remote/__selftest__/oauth.selftest.mts
 *
 * 覆盖（对应任务书第 6 条）：
 *   1. providers 解析 + 老 Server 的 404 回退；
 *   2. `startUrl` 拼接（`return_to`）、同源 / 站内路径校验；
 *   3. QR 状态机：pending → complete、expired、本地过期、超时、取消（abort）、瞬时错误重试；
 *   4. 原生桥三种结果：正常打开 / 非壳环境（404）/ 2xx-HTML 假成功；
 *   5. 扫码 mode 完全不需要原生桥（普通浏览器里可用的那条路）；
 *   6. 账号 token → `/auth/me` → `/devices/register` 的落盘路径（`connection.loginWithAccountToken`）；
 *   7. 二维码渲染（data URL / SVG / 空内容 / 超容量）。
 *
 * 不联网：REST 走 mock 的 `/__ds_proxy`（解 `X-DS-Target` / `X-DS-Headers`），
 * 原生桥走 mock 的 `/__ds_auth/*`。结尾按仓库约定设置真实退出码。
 */

import { RemoteClientImpl } from '../connection.js'
import {
  NATIVE_AUTH_CLOSE_PATH,
  NATIVE_AUTH_OPEN_PATH,
  NATIVE_AUTH_STATE_PATH,
  authPageState,
  closeAuthPage,
  completeProviderLogin,
  openAuthPage,
  pollProviderLogin,
  probeAuthBridge,
  signInWithProvider,
  signInWithQrToken,
  startProviderLogin,
  waitForProviderLogin,
} from '../oauth.js'
import { qrDataUrl, qrModuleCount, qrSvgTag } from '../qr.js'
import {
  RemoteApiError,
  accountMe,
  health,
  oauthProviders,
  oauthStartUrl,
  pollOAuthQrLogin,
  startOAuthQrLogin,
  type FetchLike,
  type OAuthProvider,
} from '../serverApi.js'

/* ── 最小断言器（与 serverApi.selftest 同一套写法） ───────────────────── */

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

const codeOfError = (error: unknown): string => (error instanceof RemoteApiError ? error.code : '<no code>')

const assertThrowsCode = async (run: () => Promise<unknown>, expected: string, label: string): Promise<RemoteApiError> => {
  try {
    await run()
  } catch (error) {
    const actual = codeOfError(error)
    if (actual !== expected) fail(`${label}：期望 code=${expected}，实际 ${actual}（${(error as Error).message}）`)
    return error as RemoteApiError
  }
  return fail(`${label}：期望抛错，但调用成功了`)
}

/* ── mock：一条走 `/__ds_proxy`，一条走 `/__ds_auth/*` ───────────────── */

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

interface MockResponse {
  status?: number
  body?: unknown
  /** 直接给字符串（模拟 HTML / 非 JSON） */
  raw?: string
  /** 让 fetch 自己抛（模拟网络错） */
  throwError?: Error
}

const decodeBase64Url = (value: string): string => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
}

const toResponse = (result: MockResponse): Response => {
  if (result.throwError !== undefined) throw result.throwError
  const text = result.raw ?? (result.body === undefined ? '' : JSON.stringify(result.body))
  return new Response(text, { status: result.status ?? 200, headers: { 'Content-Type': 'application/json' } })
}

interface MockOptions {
  /** REST（`/__ds_proxy`）响应 */
  handler: (request: ProxiedRequest) => MockResponse
  /** 原生桥（`/__ds_auth/*`）响应；不给 = 一律 404（= 非壳环境） */
  native?: (call: NativeCall) => MockResponse
}

const createMock = (options: MockOptions) => {
  const proxyCalls: ProxiedRequest[] = []
  const nativeCalls: NativeCall[] = []

  const fetchImpl: FetchLike = async (url, init) => {
    if (url.startsWith('/__ds_auth/')) {
      const call: NativeCall = {
        path: url,
        method: String(init.method ?? 'GET'),
        headers: { ...((init.headers ?? {}) as Record<string, string>) },
        body: init.body === null || init.body === undefined ? undefined : JSON.parse(String(init.body)),
      }
      nativeCalls.push(call)
      return toResponse(options.native?.(call) ?? { status: 404, raw: 'Not Found' })
    }

    const headers = (init.headers ?? {}) as Record<string, string>
    const target = decodeBase64Url(String(headers['X-DS-Target']))
    const request: ProxiedRequest = {
      target,
      path: new URL(target).pathname,
      method: String(headers['X-DS-Method']),
      headers: JSON.parse(decodeBase64Url(String(headers['X-DS-Headers']))) as Record<string, string>,
      body: init.body === null || init.body === undefined ? undefined : JSON.parse(String(init.body)),
    }
    proxyCalls.push(request)
    return toResponse(options.handler(request))
  }

  const deps = { nativeFetch: fetchImpl, api: { fetch: fetchImpl } }
  return { fetchImpl, deps, proxyCalls, nativeCalls }
}

/* ── 固定数据 ─────────────────────────────────────────────────────────── */

const SERVER = { url: 'https://dsh.r2049.cn' }
const BASE = 'https://dsh.r2049.cn'
const ACCOUNT_TOKEN = 'account-token-0123456789'
/** 24 字符的一次性账号 token（扫码 complete 时服务器给的） */
const QR_TOKEN = 'qr-account-token-0123456789'
const SCAN_URL = `${BASE}/api/v1/auth/qr/abc123`
const QR_ID = 'q'.repeat(24)

const ZHIHU: OAuthProvider = {
  id: 'zhihu',
  displayName: '知乎',
  startUrl: '/api/v1/auth/oauth/start',
  qrStartUrl: '/api/v1/auth/oauth/qr/start?provider=zhihu',
}

/** 不支持扫码的 provider（没有 qrStartUrl） */
const GITHUB: OAuthProvider = {
  id: 'github',
  displayName: 'GitHub',
  startUrl: '/api/v1/auth/oauth/github/start',
}

const qrSessionBody = (patch: Record<string, unknown> = {}) => ({
  qrId: QR_ID,
  scanUrl: SCAN_URL,
  expiresIn: 600,
  provider: 'zhihu',
  ...patch,
})

const tokenPair = {
  accessToken: 'access-token-0123456789',
  accessTokenExpiresAt: 1786000000000,
  refreshToken: 'refresh-token-0123456789',
  refreshTokenExpiresAt: 1789000000000,
}

/** 一条「正常登录」的 REST 应答：qr/start → qr poll → me → devices/register */
const happyHandler =
  (pollSteps: unknown[]): MockOptions['handler'] =>
  (request) => {
    if (request.path === '/health') return { body: { status: 'ok' } }
    if (request.path === '/api/v1/auth/oauth/qr/start') return { body: qrSessionBody() }
    if (request.path.startsWith('/api/v1/auth/oauth/qr/')) {
      const next = pollSteps.shift()
      return next === undefined ? { body: { status: 'pending' } } : { body: next }
    }
    if (request.path === '/api/v1/auth/me') return { body: { account: 'u@example.com' } }
    if (request.path === '/api/v1/devices/register') return { body: tokenPair }
    return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'unexpected path' } } }
  }

/* ── 1. 健康检查 / providers / startUrl ───────────────────────────────── */

check('health：只认 {status:"ok"}，其余按可重试失败处理', async () => {
  const ok = createMock({ handler: () => ({ body: { status: 'ok' } }) })
  await health(SERVER, { fetch: ok.fetchImpl })
  assertEqual(ok.proxyCalls[0]!.target, `${BASE}/health`, '目标地址')
  assertEqual(ok.proxyCalls[0]!.method, 'GET', '方法')

  const bad = createMock({ handler: () => ({ body: { status: 'degraded' } }) })
  const error = await assertThrowsCode(() => health(SERVER, { fetch: bad.fetchImpl }), 'CONNECTION_FAILED', 'status 不是 ok')
  assertEqual(error.retryable, true, '探活失败可重试')

  const broken = createMock({ handler: () => ({ status: 500, raw: '' }) })
  await assertThrowsCode(() => health(SERVER, { fetch: broken.fetchImpl }), 'SERVER_ERROR', '500')
})

check('oauthProviders：解析 items，qrStartUrl 可缺省（= 不支持扫码）', async () => {
  const mock = createMock({
    handler: () => ({
      body: {
        items: [
          { id: 'zhihu', displayName: '知乎', startUrl: '/api/v1/auth/oauth/start', qrStartUrl: '/api/v1/auth/oauth/qr/start?provider=zhihu' },
          { id: 'github', displayName: 'GitHub', startUrl: '/api/v1/auth/oauth/github/start' },
        ],
      },
    }),
  })
  const providers = await oauthProviders(SERVER, { fetch: mock.fetchImpl })
  assertEqual(
    providers.map((item) => item.id),
    ['zhihu', 'github'],
    'provider id 顺序',
  )
  assertEqual(providers[1]!.qrStartUrl, undefined, 'github 没有 qrStartUrl')
})

check('oauthProviders：坏条目一律拒（跨源 startUrl / 空 displayName / 重复 id / 带 % 的路径）', async () => {
  const cases: Array<{ label: string; item: unknown }> = [
    { label: '跨源 startUrl', item: { id: 'zhihu', displayName: '知乎', startUrl: 'https://evil.example/api/v1/auth/oauth/start' } },
    { label: '空 displayName', item: { id: 'zhihu', displayName: ' ', startUrl: '/api/v1/auth/oauth/start' } },
    { label: '非法 id', item: { id: 'bad id', displayName: 'x', startUrl: '/api/v1/auth/oauth/start' } },
    { label: '路径遍历', item: { id: 'zhihu', displayName: '知乎', startUrl: '/api/v1/auth/../oauth/start' } },
    { label: '协议相对 qrStartUrl', item: { id: 'zhihu', displayName: '知乎', startUrl: '/api/v1/auth/oauth/start', qrStartUrl: '//evil.example/api/v1/auth/oauth/qr/start' } },
  ]
  for (const item of cases) {
    const mock = createMock({ handler: () => ({ body: { items: [item.item] } }) })
    await assertThrowsCode(() => oauthProviders(SERVER, { fetch: mock.fetchImpl }), 'INVALID_RESPONSE', item.label)
  }
  const duplicate = createMock({
    handler: () => ({
      body: {
        items: [
          { id: 'zhihu', displayName: '知乎', startUrl: '/api/v1/auth/oauth/start' },
          { id: 'zhihu', displayName: '知乎 2', startUrl: '/api/v1/auth/oauth/start' },
        ],
      },
    }),
  })
  await assertThrowsCode(() => oauthProviders(SERVER, { fetch: duplicate.fetchImpl }), 'INVALID_RESPONSE', '重复 id')
})

check('oauthProviders：404 回退到 per-provider status（只列 configured:true，缺的跳过）', async () => {
  const mock = createMock({
    handler: (request) => {
      if (request.path === '/api/v1/auth/oauth/providers') return { status: 404, body: { error: { code: 'NOT_FOUND' } } }
      if (request.path === '/api/v1/auth/oauth/status') return { body: { configured: true } }
      if (request.path === '/api/v1/auth/oauth/github/status') return { body: { configured: false } }
      return { status: 404, raw: '' }
    },
  })
  const providers = await oauthProviders(SERVER, { fetch: mock.fetchImpl })
  assertEqual(providers.map((item) => item.id), ['zhihu'], '只列 configured 的那个')
  assertEqual(providers[0]!.startUrl, '/api/v1/auth/oauth/start', '回退时 startUrl 是站内路径')
  assertEqual(providers[0]!.qrStartUrl, '/api/v1/auth/oauth/qr/start?provider=zhihu', '回退时扫码路径')
  assertEqual(
    mock.proxyCalls.map((call) => call.path),
    ['/api/v1/auth/oauth/providers', '/api/v1/auth/oauth/status', '/api/v1/auth/oauth/github/status'],
    '请求顺序',
  )
})

check('oauthProviders：404 回退时遇到 5xx 不能被当成「没配置」', async () => {
  const mock = createMock({
    handler: (request) => {
      if (request.path === '/api/v1/auth/oauth/providers') return { status: 404, raw: '' }
      return { status: 503, raw: '' }
    },
  })
  await assertThrowsCode(() => oauthProviders(SERVER, { fetch: mock.fetchImpl }), 'SERVER_UNAVAILABLE', '回退遇到 503')
})

check('oauthStartUrl：拼 return_to，保留已有 query，拒绝站外 startUrl', async () => {
  assertEqual(
    oauthStartUrl(SERVER, ZHIHU),
    `${BASE}/api/v1/auth/oauth/start?return_to=dshremote%3A%2F%2Foauth`,
    'return_to 编码后拼上',
  )
  const withQuery: OAuthProvider = { id: 'zhihu', displayName: '知乎', startUrl: '/api/v1/auth/oauth/start?x=1' }
  const url = new URL(oauthStartUrl(BASE, withQuery))
  assertEqual(url.searchParams.get('x'), '1', '原有参数保留')
  assertEqual(url.searchParams.get('return_to'), 'dshremote://oauth', 'return_to 原值')

  await assertThrowsCode(
    () => Promise.resolve(oauthStartUrl(SERVER, { ...ZHIHU, startUrl: 'https://evil.example/api/v1/auth/x' })),
    'INVALID_ARGUMENT',
    '跨源 startUrl',
  )
})

/* ── 2. 扫码会话（服务器侧） ──────────────────────────────────────────── */

check('startOAuthQrLogin：POST 站内 qrStartUrl，body 是 {}', async () => {
  const mock = createMock({ handler: () => ({ body: qrSessionBody() }) })
  const session = await startOAuthQrLogin(SERVER, ZHIHU, { fetch: mock.fetchImpl })
  assertEqual(mock.proxyCalls[0]!.target, `${BASE}/api/v1/auth/oauth/qr/start?provider=zhihu`, '目标地址')
  assertEqual(mock.proxyCalls[0]!.method, 'POST', '方法')
  assertEqual(mock.proxyCalls[0]!.body, {}, 'body 必须是空对象')
  assertEqual(session.qrId, QR_ID, 'qrId')
  assertEqual(session.scanUrl, SCAN_URL, 'scanUrl')
  assertEqual(session.expiresIn, 600, 'expiresIn')
})

check('startOAuthQrLogin：qrId 太短 / expiresIn 非法 / scanUrl 跨源 / provider 不一致都拒', async () => {
  const cases: Array<{ label: string; body: unknown }> = [
    { label: 'qrId 太短', body: qrSessionBody({ qrId: 'short' }) },
    { label: 'expiresIn=0', body: qrSessionBody({ expiresIn: 0 }) },
    { label: 'scanUrl 跨源', body: qrSessionBody({ scanUrl: 'https://evil.example/api/v1/auth/qr/x' }) },
    { label: 'scanUrl 协议相对', body: qrSessionBody({ scanUrl: '//evil.example/api/v1/auth/qr/x' }) },
    { label: 'provider 不一致', body: qrSessionBody({ provider: 'github' }) },
  ]
  for (const item of cases) {
    const mock = createMock({ handler: () => ({ body: item.body }) })
    await assertThrowsCode(() => startOAuthQrLogin(SERVER, ZHIHU, { fetch: mock.fetchImpl }), 'INVALID_RESPONSE', item.label)
  }
  const mock = createMock({ handler: () => ({ body: qrSessionBody() }) })
  await assertThrowsCode(() => startOAuthQrLogin(SERVER, GITHUB, { fetch: mock.fetchImpl }), 'INVALID_ARGUMENT', '不支持扫码')
  assertEqual(mock.proxyCalls.length, 0, '不支持扫码时不该发请求')
})

check('pollOAuthQrLogin：pending / expired / complete 三态，complete 必须有 token', async () => {
  const pending = createMock({ handler: () => ({ body: { status: 'pending' } }) })
  assertEqual(await pollOAuthQrLogin(SERVER, QR_ID, { fetch: pending.fetchImpl }), { status: 'pending' }, 'pending')

  const expired = createMock({ handler: () => ({ body: { status: 'expired' } }) })
  assertEqual(await pollOAuthQrLogin(SERVER, QR_ID, { fetch: expired.fetchImpl }), { status: 'expired' }, 'expired')

  const complete = createMock({ handler: () => ({ body: { status: 'complete', token: QR_TOKEN } }) })
  assertEqual(
    await pollOAuthQrLogin(SERVER, QR_ID, { fetch: complete.fetchImpl }),
    { status: 'complete', token: QR_TOKEN },
    'complete',
  )
  assertEqual(complete.proxyCalls[0]!.path, `/api/v1/auth/oauth/qr/${QR_ID}`, '路径里的 qrId')

  for (const body of [{ status: 'complete' }, { status: 'complete', token: 'short' }, { status: 'unknown' }]) {
    const mock = createMock({ handler: () => ({ body }) })
    await assertThrowsCode(() => pollOAuthQrLogin(SERVER, QR_ID, { fetch: mock.fetchImpl }), 'INVALID_RESPONSE', JSON.stringify(body))
  }
})

check('accountMe：Bearer 账号 token，返回账号名', async () => {
  const mock = createMock({ handler: () => ({ body: { account: 'u@example.com' } }) })
  const me = await accountMe(SERVER, ACCOUNT_TOKEN, { fetch: mock.fetchImpl })
  assertEqual(me.account, 'u@example.com', 'account')
  assertEqual(mock.proxyCalls[0]!.headers.Authorization, `Bearer ${ACCOUNT_TOKEN}`, 'Authorization')
  const bad = createMock({ handler: () => ({ body: { account: '' } }) })
  await assertThrowsCode(() => accountMe(SERVER, ACCOUNT_TOKEN, { fetch: bad.fetchImpl }), 'INVALID_RESPONSE', '空账号名')
})

/* ── 3. 原生授权页（browser mode） ────────────────────────────────────── */

check('startProviderLogin(browser)：建会话 → 原生 /__ds_auth/open {url,serverUrl,mode}', async () => {
  const mock = createMock({
    handler: happyHandler([]),
    native: () => ({ body: { ok: true, open: true, mode: 'inline', id: 1, url: SCAN_URL } }),
  })
  const session = await startProviderLogin(BASE, ZHIHU, 'browser', { deps: mock.deps, title: '知乎登录' })
  assertEqual(session.mode, 'browser', 'mode')
  assertEqual(session.qrId, QR_ID, 'qrId')
  assertEqual(session.scanUrl, SCAN_URL, 'scanUrl')
  assertTrue(session.expiresAt > Date.now() + 500_000, 'expiresAt 按秒换算成毫秒')

  const open = mock.nativeCalls.filter((call) => call.path === NATIVE_AUTH_OPEN_PATH)
  assertEqual(open.length, 1, 'open 只调一次')
  assertEqual(open[0]!.method, 'POST', 'open 是 POST')
  // 原生态：url + serverUrl（同源闸门）+ title + mode；缺 serverUrl 时自建服务器会 403
  assertEqual(
    open[0]!.body,
    { url: SCAN_URL, serverUrl: BASE, title: '知乎登录', mode: 'inline' },
    'open 的 body',
  )
  assertContains(String(open[0]!.headers['Content-Type'] ?? ''), 'application/json', 'CSRF 闸门要求的 Content-Type')
  // 探活 → 建会话（顺序固定）
  assertEqual(
    mock.proxyCalls.map((call) => call.path),
    ['/health', '/api/v1/auth/oauth/qr/start'],
    'REST 顺序（先探活再建会话）',
  )
})

check('startProviderLogin(browser)：Google 自动走 mode:"external"（Google 拒绝 WebView）', async () => {
  const google: OAuthProvider = {
    id: 'google',
    displayName: 'Google',
    startUrl: '/api/v1/auth/oauth/google/start',
    qrStartUrl: '/api/v1/auth/oauth/qr/start?provider=google',
  }
  const mock = createMock({
    handler: (request) => {
      if (request.path === '/health') return { body: { status: 'ok' } }
      if (request.path === '/api/v1/auth/oauth/qr/start') return { body: qrSessionBody({ provider: 'google' }) }
      return { body: { ok: true } }
    },
    native: () => ({ body: { ok: true } }),
  })
  await startProviderLogin(BASE, google, 'browser', { deps: mock.deps })
  const open = mock.nativeCalls.find((call) => call.path === NATIVE_AUTH_OPEN_PATH)
  assertEqual((open?.body as { mode?: string }).mode, 'external', 'google → external')
})

check('startProviderLogin(browser)：/__ds_auth/open 404 → 「只能在 App 内使用」', async () => {
  const mock = createMock({ handler: happyHandler([]), native: () => ({ status: 404, raw: 'Not Found' }) })
  const error = await assertThrowsCode(
    () => startProviderLogin(BASE, ZHIHU, 'browser', { deps: mock.deps }),
    'OAUTH_UNAVAILABLE',
    '非壳环境',
  )
  assertContains(error.message, '只能在 App 内使用', '文案要讲清是「只能在 App 内使用」')
})

check('startProviderLogin(browser)：在壳里却 404（旧 APK）→ OAUTH_BRIDGE_UPDATE_REQUIRED', async () => {
  const mock = createMock({ handler: happyHandler([]), native: () => ({ status: 404, raw: 'Not Found' }) })
  // 模拟 WebView 里的壳标记（新 APK 才会注入 __DS_NATIVE__；旧 APK 只有 UA 标记）
  const target = globalThis as { window?: unknown }
  target.window = { __DS_NATIVE__: {} }
  try {
    const error = await assertThrowsCode(
      () => startProviderLogin(BASE, ZHIHU, 'browser', { deps: mock.deps }),
      'OAUTH_BRIDGE_UPDATE_REQUIRED',
      '旧 APK',
    )
    assertContains(error.message, '更新 App', '文案要提示更新 App')
  } finally {
    delete target.window
  }
})

check('startProviderLogin(browser)：2xx + HTML（SPA 回落）也按非壳环境处理', async () => {
  const mock = createMock({
    handler: happyHandler([]),
    native: () => ({ status: 200, raw: '<!doctype html><html><body>index</body></html>' }),
  })
  const error = await assertThrowsCode(
    () => startProviderLogin(BASE, ZHIHU, 'browser', { deps: mock.deps }),
    'OAUTH_UNAVAILABLE',
    '200 但不是 JSON',
  )
  assertContains(error.message, '只能在 App 内使用', '不能把 HTML 当成「已打开」')
})

check('startProviderLogin(browser)：原生 503（App 不在前台 / 没浏览器）→ NATIVE_BRIDGE_ERROR 可重试', async () => {
  const mock = createMock({
    handler: happyHandler([]),
    native: () => ({ status: 503, body: { ok: false, error: 'no_foreground_activity' } }),
  })
  const error = await assertThrowsCode(
    () => startProviderLogin(BASE, ZHIHU, 'browser', { deps: mock.deps }),
    'NATIVE_BRIDGE_ERROR',
    '原生桥 503',
  )
  assertEqual(error.retryable, true, '可重试')
  assertContains(error.message, '前台', '把 no_foreground_activity 翻成人话')
})

check('startProviderLogin(browser)：原生 400/403（https_required / private_host_rejected）带中文原因', async () => {
  const notHttps = createMock({
    handler: happyHandler([]),
    native: () => ({ status: 400, body: { ok: false, error: 'https_required' } }),
  })
  const e1 = await assertThrowsCode(
    () => startProviderLogin(BASE, ZHIHU, 'browser', { deps: notHttps.deps }),
    'NATIVE_BRIDGE_ERROR',
    'https_required',
  )
  assertContains(e1.message, 'https', '文案')
  assertEqual(e1.retryable, false, '400 不重试')

  const privateHost = createMock({
    handler: happyHandler([]),
    native: () => ({ status: 403, body: { ok: false, error: 'private_host_rejected' } }),
  })
  const e2 = await assertThrowsCode(
    () => startProviderLogin(BASE, ZHIHU, 'browser', { deps: privateHost.deps }),
    'NATIVE_BRIDGE_ERROR',
    'private_host_rejected',
  )
  assertContains(e2.message, 'serverUrl', '文案要点明要带 serverUrl')
})

check('startProviderLogin(browser)：ok:false 带上原生的错误码', async () => {
  const mock = createMock({
    handler: happyHandler([]),
    native: () => ({ body: { ok: false, error: 'no_browser' } }),
  })
  const error = await assertThrowsCode(
    () => startProviderLogin(BASE, ZHIHU, 'browser', { deps: mock.deps }),
    'OAUTH_FAILED',
    '原生拒绝打开',
  )
  assertContains(error.message, 'no_browser', '带出原因码')
})

check('startProviderLogin(qr)：不碰原生桥（普通浏览器里也能用），scanUrl 交给 UI', async () => {
  const mock = createMock({ handler: happyHandler([]) }) // native 缺省 = 一律 404
  const session = await startProviderLogin(BASE, ZHIHU, 'qr', { deps: mock.deps })
  assertEqual(session.mode, 'qr', 'mode')
  assertEqual(session.scanUrl, SCAN_URL, 'scanUrl')
  assertEqual(mock.nativeCalls.length, 0, 'qr 模式不该调原生桥')
})

check('startProviderLogin(qr)：provider 不支持扫码 → QR_UNSUPPORTED，不发请求', async () => {
  const mock = createMock({ handler: happyHandler([]) })
  await assertThrowsCode(() => startProviderLogin(BASE, GITHUB, 'qr', { deps: mock.deps }), 'QR_UNSUPPORTED', '无 qrStartUrl')
  assertEqual(mock.proxyCalls.length, 0, '不该发请求')
})

check('startProviderLogin：探活失败就不建会话（先分清「连不上」与「授权失败」）', async () => {
  const mock = createMock({
    handler: (request) => (request.path === '/health' ? { status: 500, raw: '' } : { body: qrSessionBody() }),
  })
  await assertThrowsCode(() => startProviderLogin(BASE, ZHIHU, 'qr', { deps: mock.deps }), 'SERVER_ERROR', '探活 500')
  assertEqual(mock.proxyCalls.length, 1, '只打了 /health')

  const skipped = createMock({ handler: happyHandler([]) })
  await startProviderLogin(BASE, ZHIHU, 'qr', { deps: skipped.deps, probeHealth: false })
  assertEqual(skipped.proxyCalls[0]!.path, '/api/v1/auth/oauth/qr/start', 'probeHealth:false 直接建会话')
})

/* ── 4. 轮询状态机 ────────────────────────────────────────────────────── */

check('pollProviderLogin：pending / complete 原样透传，本地时钟过期不再打服务器', async () => {
  const pending = createMock({ handler: () => ({ body: { status: 'pending' } }) })
  assertEqual(await pollProviderLogin(BASE, QR_ID, { deps: pending.deps }), { status: 'pending' }, 'pending')

  const complete = createMock({ handler: () => ({ body: { status: 'complete', token: QR_TOKEN } }) })
  assertEqual(
    await pollProviderLogin(BASE, QR_ID, { deps: complete.deps }),
    { status: 'complete', token: QR_TOKEN },
    'complete',
  )

  const stale = createMock({ handler: () => ({ body: { status: 'pending' } }) })
  assertEqual(
    await pollProviderLogin(BASE, QR_ID, { deps: stale.deps, expiresAt: Date.now() - 1 }),
    { status: 'expired' },
    '本地已过期',
  )
  assertEqual(stale.proxyCalls.length, 0, '过期的会话不该再打服务器')
})

check('waitForProviderLogin：pending → complete 拿到一次性 token', async () => {
  const mock = createMock({
    handler: happyHandler([{ status: 'pending' }, { status: 'pending' }, { status: 'complete', token: QR_TOKEN }]),
  })
  const token = await waitForProviderLogin(BASE, QR_ID, {
    deps: mock.deps,
    intervalMs: 5,
    timeoutMs: 5_000,
    expiresAt: Date.now() + 60_000,
  })
  assertEqual(token, QR_TOKEN, 'token')
  assertEqual(mock.proxyCalls.length, 3, '轮了 3 次')
})

check('waitForProviderLogin：expired → QR_EXPIRED', async () => {
  const mock = createMock({ handler: () => ({ body: { status: 'expired' } }) })
  await assertThrowsCode(
    () => waitForProviderLogin(BASE, QR_ID, { deps: mock.deps, intervalMs: 5, timeoutMs: 5_000 }),
    'QR_EXPIRED',
    '服务器说过期',
  )
})

check('waitForProviderLogin：一直 pending → QR_TIMEOUT', async () => {
  const mock = createMock({ handler: () => ({ body: { status: 'pending' } }) })
  const error = await assertThrowsCode(
    () => waitForProviderLogin(BASE, QR_ID, { deps: mock.deps, intervalMs: 5, timeoutMs: 30 }),
    'QR_TIMEOUT',
    '超时',
  )
  assertEqual(error.retryable, true, '超时可重试')
})

check('waitForProviderLogin：瞬时网络错最多放 3 次，之后仍能成功', async () => {
  let calls = 0
  const mock = createMock({
    handler: () => {
      calls += 1
      if (calls === 1) return { throwError: new TypeError('Failed to fetch') }
      return { body: { status: 'complete', token: QR_TOKEN } }
    },
  })
  const token = await waitForProviderLogin(BASE, QR_ID, { deps: mock.deps, intervalMs: 5, timeoutMs: 5_000 })
  assertEqual(token, QR_TOKEN, '抖动一次后照样拿到 token')
})

check('waitForProviderLogin：确定性错误（找不到 qrId）立刻抛，不重试', async () => {
  const mock = createMock({
    handler: () => ({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'unknown qr' } } }),
  })
  await assertThrowsCode(
    () => waitForProviderLogin(BASE, QR_ID, { deps: mock.deps, intervalMs: 5, timeoutMs: 5_000 }),
    'NOT_FOUND',
    '404',
  )
  assertEqual(mock.proxyCalls.length, 1, '只打一次')
})

check('waitForProviderLogin：abort → OAUTH_ABORTED', async () => {
  const controller = new AbortController()
  const mock = createMock({ handler: () => ({ body: { status: 'pending' } }) })
  controller.abort()
  await assertThrowsCode(
    () =>
      waitForProviderLogin(BASE, QR_ID, {
        deps: mock.deps,
        intervalMs: 5,
        timeoutMs: 5_000,
        signal: controller.signal,
      }),
    'OAUTH_ABORTED',
    '取消',
  )
  assertEqual(mock.proxyCalls.length, 0, '已取消就不该再轮询')
})

/* ── 5. token → 设备（落盘路径） ──────────────────────────────────────── */

check('completeProviderLogin：accountMe → devices/register，返回 account/deviceId/tokens', async () => {
  const mock = createMock({ handler: happyHandler([]) })
  const result = await completeProviderLogin(BASE, QR_TOKEN, { deps: mock.deps, deviceName: 'Chat Pad' })
  assertEqual(result.account, 'u@example.com', 'account')
  assertEqual(
    mock.proxyCalls.map((call) => call.path),
    ['/api/v1/auth/me', '/api/v1/devices/register'],
    '请求顺序',
  )
  assertEqual(mock.proxyCalls[0]!.headers.Authorization, `Bearer ${QR_TOKEN}`, 'accountMe 用账号 token')
  assertEqual(mock.proxyCalls[1]!.headers.Authorization, `Bearer ${QR_TOKEN}`, '注册设备也用账号 token')
  assertEqual((mock.proxyCalls[1]!.body as { device: { role: string } }).device.role, 'client', 'role=client')
  assertEqual(result.tokens.accessToken, tokenPair.accessToken, '设备 access token')
  assertEqual(result.deviceId.length > 0, true, 'deviceId')
})

check('signInWithQrToken 是 completeProviderLogin 的别名；短 token 直接拒', async () => {
  assertEqual(signInWithQrToken, completeProviderLogin, '同一个函数')
  const mock = createMock({ handler: happyHandler([]) })
  await assertThrowsCode(() => signInWithQrToken(BASE, 'short', { deps: mock.deps }), 'INVALID_ARGUMENT', '太短')
  assertEqual(mock.proxyCalls.length, 0, '不该发请求')
})

check('connection.loginWithAccountToken：与密码登录同一条落盘路径（scope=device + loginMethod）', async () => {
  const mock = createMock({ handler: happyHandler([]) })
  const client = new RemoteClientImpl({ deps: { fetch: mock.fetchImpl } })
  const account = await client.loginWithAccountToken(SERVER, QR_TOKEN, 'qr')

  assertEqual(account.email, 'u@example.com', '账号名来自 /auth/me')
  assertEqual(account.scope, 'device', '注册完成后 scope=device')
  assertEqual(account.loginMethod, 'qr', 'loginMethod 落到记录上')
  assertEqual(account.refreshToken, tokenPair.refreshToken, '设备 refresh token')
  assertEqual(account.accessToken, tokenPair.accessToken, '设备 access token')
  assertEqual(account.serverUrl, BASE, 'serverUrl')
  assertTrue(account.deviceId.length > 0, 'deviceId 来自本机身份')
})

check('connection.loginWithAccountToken：空 token → AUTH_REQUIRED，不发请求', async () => {
  const mock = createMock({ handler: happyHandler([]) })
  const client = new RemoteClientImpl({ deps: { fetch: mock.fetchImpl } })
  await assertThrowsCode(() => client.loginWithAccountToken(SERVER, '   ', 'oauth'), 'AUTH_REQUIRED', '空 token')
  assertEqual(mock.proxyCalls.length, 0, '不该发请求')
})

/* ── 6. 一站式 signInWithProvider + 原生 close ───────────────────────── */

check('signInWithProvider(browser)：建会话 → 轮询 → 换设备 → 关授权页', async () => {
  const mock = createMock({
    handler: happyHandler([{ status: 'pending' }, { status: 'complete', token: QR_TOKEN }]),
    native: (call) => (call.path === NATIVE_AUTH_CLOSE_PATH ? { body: { ok: true } } : { body: { ok: true } }),
  })
  const result = await signInWithProvider(BASE, ZHIHU, 'browser', {
    deps: mock.deps,
    intervalMs: 5,
    timeoutMs: 5_000,
  })
  assertEqual(result.account, 'u@example.com', 'account')
  const nativePaths = mock.nativeCalls.map((call) => call.path)
  assertEqual(nativePaths, [NATIVE_AUTH_OPEN_PATH, NATIVE_AUTH_CLOSE_PATH], 'open → close')
  assertEqual(
    mock.proxyCalls.map((call) => call.path),
    ['/health', '/api/v1/auth/oauth/qr/start', `/api/v1/auth/oauth/qr/${QR_ID}`, `/api/v1/auth/oauth/qr/${QR_ID}`, '/api/v1/auth/me', '/api/v1/devices/register'],
    'REST 顺序',
  )
})

check('signInWithProvider：失败也要关授权页（finally）', async () => {
  const mock = createMock({
    handler: happyHandler([{ status: 'expired' }]),
    native: () => ({ body: { ok: true } }),
  })
  await assertThrowsCode(
    () => signInWithProvider(BASE, ZHIHU, 'browser', { deps: mock.deps, intervalMs: 5, timeoutMs: 5_000 }),
    'QR_EXPIRED',
    '过期',
  )
  assertTrue(
    mock.nativeCalls.some((call) => call.path === NATIVE_AUTH_CLOSE_PATH),
    '失败路径也要 close',
  )
})

check('closeAuthPage / authPageState：非壳环境不抛；壳里带出 mode / lastRedirect', async () => {
  const mock = createMock({ handler: happyHandler([]) })
  assertEqual(await closeAuthPage(mock.deps), false, 'close 在非壳环境返回 false')
  assertEqual(await authPageState(mock.deps), null, 'state 在非壳环境返回 null')

  const alive = createMock({
    handler: happyHandler([]),
    native: (call) =>
      call.path === NATIVE_AUTH_STATE_PATH
        ? { body: { ok: true, open: true, mode: 'inline', id: 3, url: SCAN_URL, title: '知乎登录', lastRedirect: '' } }
        : { body: { ok: true, open: false, closed: true } },
  })
  assertEqual((await authPageState(alive.deps))?.open, true, '壳里 open=true')
  assertEqual((await authPageState(alive.deps))?.mode, 'inline', 'mode 透传')
  assertEqual(await closeAuthPage(alive.deps), true, '壳里 close 成功')
  const close = alive.nativeCalls.find((call) => call.path === NATIVE_AUTH_CLOSE_PATH)
  assertEqual(close?.body, {}, 'close 带空 JSON body')
})

check('openAuthPage：只收 https，非 https 一个字节都不发', async () => {
  const mock = createMock({ handler: happyHandler([]), native: () => ({ body: { ok: true } }) })
  await assertThrowsCode(
    () => openAuthPage({ url: 'http://localhost:18888/login', serverUrl: 'http://localhost:18888' }, mock.deps),
    'INVALID_ARGUMENT',
    'http 授权页',
  )
  assertEqual(mock.nativeCalls.length, 0, '没发原生请求')

  const ok = createMock({ handler: happyHandler([]), native: () => ({ body: { ok: true } }) })
  await openAuthPage({ url: SCAN_URL, serverUrl: BASE, mode: 'external', allowHost: 'auth.example.com' }, ok.deps)
  assertEqual(
    ok.nativeCalls[0]!.body,
    { url: SCAN_URL, serverUrl: BASE, mode: 'external', allowHost: 'auth.example.com' },
    '可选字段透传',
  )
})

check('probeAuthBridge：ready / missing / outdated 三态（404 靠壳标记区分）', async () => {
  const ready = createMock({ handler: happyHandler([]), native: () => ({ body: { ok: true, open: false } }) })
  assertEqual(await probeAuthBridge(ready.deps), 'ready', '壳里可用')

  const outside = createMock({ handler: happyHandler([]) }) // 404
  assertEqual(await probeAuthBridge(outside.deps), 'missing', '不在壳里')

  const target = globalThis as { window?: unknown }
  target.window = { __DS_NATIVE__: {} }
  try {
    const oldApk = createMock({ handler: happyHandler([]) }) // 旧 APK 也 404
    assertEqual(await probeAuthBridge(oldApk.deps), 'outdated', '在壳里却 404 = 旧 APK')
  } finally {
    delete target.window
  }
})

/* ── 7. 二维码渲染 ────────────────────────────────────────────────────── */

check('qrDataUrl：输出 GIF data URL（不依赖 canvas）', async () => {
  const dataUrl = qrDataUrl(SCAN_URL)
  assertTrue(dataUrl.startsWith('data:image/gif;base64,'), '是 GIF data URL')
  const base64 = dataUrl.slice('data:image/gif;base64,'.length)
  const header = atob(base64.slice(0, 8))
  assertEqual(header.slice(0, 3), 'GIF', 'GIF 文件头')
  assertTrue(base64.length > 200, '内容非空')
})

check('qrSvgTag / qrModuleCount：矢量输出与尺寸换算', async () => {
  const svg = qrSvgTag(SCAN_URL, { cellSize: 3, margin: 2 })
  assertContains(svg, '<svg', 'SVG 标签')
  const modules = qrModuleCount(SCAN_URL, { margin: 4 })
  assertTrue(modules >= 21 + 8, '模块数 = QR 矩阵 + 两侧静区')
  assertEqual(Number.isInteger(modules), true, '是整数')
  // 同一个内容 + 同样的参数必须稳定（UI 会拿它算布局）
  assertEqual(qrModuleCount(SCAN_URL, { margin: 4 }), modules, '可重复')
})

check('qrDataUrl：空内容 / 超容量都给出可读错误', async () => {
  const empty = await assertThrowsCode(async () => qrDataUrl('   '), 'INVALID_ARGUMENT', '空内容')
  assertContains(empty.message, '不能为空', '文案')
  const tooLong = await assertThrowsCode(async () => qrDataUrl(`https://dsh.r2049.cn/${'x'.repeat(6000)}`), 'QR_TOO_LONG', '超容量')
  assertContains(tooLong.message, '二维码', '文案')
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
