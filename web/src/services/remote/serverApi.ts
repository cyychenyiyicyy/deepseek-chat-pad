/**
 * Chat Pad 远程 DSH：REST 层（登录 / 设备注册 / token 刷新 / 设备发现）。
 *
 * 三条硬约束：
 *   1. **一律走本地代理** `POST /__ds_proxy`，头见 `services/api/transport.ts`：
 *      `X-DS-Target` = base64url(完整 https URL)、`X-DS-Method`、`X-DS-Headers` = base64url(JSON)。
 *      WebView 直连远端会撞 CORS；原生壳的代理只放行 https。
 *   2. **token 不进 URL / 不进日志**（docs/protocol.md §8.2、§10.3）：只放 Authorization 头，
 *      而头本身被编码进 `X-DS-Headers`，不出现在任何打印里。
 *   3. **401 最多刷新重试一次**，且只对只读 GET 用（仓库 AGENTS.md 架构 1 节：禁重放 mutation）。
 *
 * 协议依据：docs/protocol.md §6（REST 通用格式）、§7（Device Descriptor）、
 * §8.1/§8.2（注册 / refresh）、§9（设备发现与分页）。
 * 参考实现：ds-harness-remote `apps/browser/src/server-api.ts`（结构照抄，去掉 Node 依赖）。
 */

import type { AccountDeviceDescriptor, DeviceTokenPair } from '../../vendor/dsh-remote/protocol/index.js'

import { isIdentityKey, toBase64Url } from './identity.js'
import type { RemoteServer } from './storage.js'

/** 原生壳代理路径（`LocalServer` 里挂的同源端点） */
export const DEFAULT_PROXY_PATH = '/__ds_proxy'

/** 单次 REST 调用超时；refresh 与设备列表都用这个，避免 UI 永久转圈 */
export const DEFAULT_TIMEOUT_MS = 15_000

/** 设备分页上限（docs/protocol.md §9：limit 1–100，默认 50） */
const DEFAULT_PAGE_LIMIT = 50
const MAX_PAGE_LIMIT = 100
const MAX_PAGES = 20

/** 官方托管 Server 的注册需要邀请码（docs/plugin-integration.md:79） */
const INVITE_MESSAGE =
  '这台服务器注册新账号需要邀请码。请先在官方站点（https://dsh.r2049.cn）用邀请码注册账号，再用邮箱密码登录。' +
  '（TODO：邀请码输入与 /api/v1/auth/register 的字段未在协议里定稿，见 docs/plugin-integration.md:79，P0 不做）'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/* ── 错误 ─────────────────────────────────────────────────────────────── */

/**
 * 远程 DSH 的**唯一**错误类型：REST 失败与控制面握手失败共用（后者 `status` 为空）。
 * UI 只需要认 `code` + `message`，不用区分 HTTP 还是 WS。
 */
export class RemoteApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
    readonly retryable = false,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'RemoteApiError'
  }
}

export const isRemoteApiError = (value: unknown): value is RemoteApiError => value instanceof RemoteApiError

const errorCodeOf = (value: unknown): string | undefined =>
  isRemoteApiError(value) ? value.code : undefined

/* ── 依赖注入（单测 / 浏览器直连调试） ───────────────────────────────── */

export interface ServerApiDeps {
  /** 测试注入用；缺省用浏览器全局 fetch（这里自己收窄签名，避开 DOM/Node 两套 fetch 类型的冲突） */
  fetch?: FetchLike
  /** 代理路径；缺省 `/__ds_proxy` */
  proxyPath?: string
  /** 超时毫秒；缺省 15s */
  timeoutMs?: number
  /**
   * 直连模式（默认 **关闭**）：只在桌面浏览器 `pnpm dev` 里手工联调时打开，
   * WebView 里必须走代理。打开后 `proxyPath` 被忽略。
   */
  allowDirect?: boolean
}

/** 只用到 fetch 的最小切面：URL 固定是字符串，其余同标准 RequestInit */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

/* ── 地址归一化 ───────────────────────────────────────────────────────── */

/**
 * 归一化服务器地址：保留可能的反代路径前缀（`REMOTE_PUBLIC_URL` 允许带 path），
 * 去掉尾部斜杠、query 与 fragment。只接受 https（本机 localhost 允许 http 做自建调试）。
 */
export const normalizeServerUrl = (input: string): string => {
  const trimmed = input.trim()
  if (trimmed.length === 0) throw new RemoteApiError('INVALID_ARGUMENT', '服务器地址不能为空')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new RemoteApiError('INVALID_ARGUMENT', `不是合法的服务器地址：${trimmed}`)
  }
  const localHttp = url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)
  if (url.protocol !== 'https:' && !localHttp) {
    throw new RemoteApiError('INVALID_ARGUMENT', '远程 DSH 必须用 https://（只有本机 localhost 调试允许 http://）')
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new RemoteApiError('INVALID_ARGUMENT', '服务器地址里不能带用户名密码')
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

const targetUrl = (base: string, path: string, query?: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== '') search.set(key, String(value))
  }
  const suffix = search.toString()
  return `${base}${path}${suffix.length > 0 ? `?${suffix}` : ''}`
}

/* ── 请求内核 ─────────────────────────────────────────────────────────── */

type HttpMethod = 'GET' | 'POST' | 'DELETE'

interface RequestOptions {
  method: HttpMethod
  /** 设备 / 账号 access token；只放 Authorization 头 */
  token?: string
  body?: unknown
  query?: Record<string, string | number | undefined>
}

const encoder = new TextEncoder()

const defaultFetch: FetchLike = (input, init) => fetch(input, init)

const resolveFetch = (deps: ServerApiDeps): FetchLike => deps.fetch ?? defaultFetch

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const messageOf = (value: unknown): string =>
  value instanceof Error ? value.message : typeof value === 'string' ? value : '未知错误'

const utf8Length = (value: string): number => encoder.encode(value).length

/** 把一次调用折成实际发出的请求：WebView 里是 `POST /__ds_proxy`，直连调试时是原请求 */
const buildTransport = (
  base: string,
  path: string,
  options: RequestOptions,
  deps: ServerApiDeps,
): { url: string; init: RequestInit } => {
  const target = targetUrl(base, path, options.query)
  const headers: Record<string, string> = { Accept: 'application/json' }
  let body: string | undefined
  if (options.body !== undefined) {
    body = JSON.stringify(options.body)
    headers['Content-Type'] = 'application/json'
  }
  if (options.token !== undefined) headers.Authorization = `Bearer ${options.token}`

  if (deps.allowDirect === true) {
    return {
      url: target,
      init: { method: options.method, headers, body: body ?? null, cache: 'no-store', credentials: 'same-origin' },
    }
  }

  // 原生代理只认这三个头，目标头由它自己按 X-DS-Headers 还原（见 services/api/transport.ts:92-102）
  return {
    url: deps.proxyPath ?? DEFAULT_PROXY_PATH,
    init: {
      method: 'POST',
      headers: {
        'X-DS-Target': toBase64Url(encoder.encode(target)),
        'X-DS-Method': options.method,
        'X-DS-Headers': toBase64Url(encoder.encode(JSON.stringify(headers))),
      },
      body: body ?? null,
      cache: 'no-store',
      credentials: 'omit',
    },
  }
}

/** 服务器错误体 → 统一错误（docs/protocol.md §6：`{error:{code,message,requestId?,retryable?,details?}}`） */
const mapHttpError = (status: number, body: unknown): RemoteApiError => {
  const envelope = isRecord(body) && isRecord(body.error) ? body.error : undefined
  const serverCode = typeof envelope?.code === 'string' ? envelope.code : undefined
  const serverMessage = typeof envelope?.message === 'string' ? envelope.message : undefined
  const retryable = envelope?.retryable === true
  const details = isRecord(envelope?.details) ? envelope.details : undefined
  const code = serverCode ?? ''

  if (status === 401) {
    // 空响应 / 非 JSON：协议 §8.2 明确不得据此判定设备授权失效，保留凭据退避重试
    if (serverCode === undefined) {
      return new RemoteApiError('AUTH_REQUIRED', '登录状态已失效（服务器返回 401，且没有可解析的错误体）', status, true)
    }
    return new RemoteApiError(serverCode, describeAuthFailure(serverCode, serverMessage), status, retryable, details)
  }

  if (status === 403) {
    if (isInviteSignal(code, serverMessage)) {
      return new RemoteApiError('INVITE_REQUIRED', INVITE_MESSAGE, status, false, details)
    }
    if (serverCode !== undefined) {
      return new RemoteApiError(serverCode, serverMessage ?? '没有权限执行该操作（403）', status, retryable, details)
    }
    return new RemoteApiError('FORBIDDEN', '没有权限执行该操作（403）', status, false)
  }

  if (status === 429) {
    return new RemoteApiError(serverCode ?? 'RATE_LIMITED', serverMessage ?? '请求太频繁，稍后再试', status, true, details)
  }
  if (status === 503) {
    // refresh 恢复数据异常 / 数据库繁忙是可重试的（docs/protocol.md §8.2）
    return new RemoteApiError(serverCode ?? 'SERVER_UNAVAILABLE', serverMessage ?? '服务器暂时不可用，稍后重试', status, true, details)
  }
  if (status >= 500) {
    // 5xx 默认按可重试处理（协议把 503 明确定义为可重试）；服务器显式说 retryable:false 才不重试
    const canRetry = envelope?.retryable !== false
    return new RemoteApiError(serverCode ?? 'SERVER_ERROR', serverMessage ?? `服务器内部错误（${status}）`, status, canRetry, details)
  }
  if (status === 404) {
    return new RemoteApiError(serverCode ?? 'NOT_FOUND', serverMessage ?? '接口不存在（404），可能服务器版本不匹配', status, false, details)
  }
  if (serverCode !== undefined) {
    return new RemoteApiError(serverCode, serverMessage ?? `请求失败（${status}）`, status, retryable, details)
  }
  return new RemoteApiError('HTTP_ERROR', `请求失败（${status}）`, status, false)
}

const describeAuthFailure = (code: string, serverMessage?: string): string => {
  switch (code) {
    case 'AUTH_INVALID':
      return serverMessage ?? '邮箱或密码不正确'
    case 'ACCOUNT_AUTH_REQUIRED':
      return '账号 token 无效或已过期，需要重新登录'
    case 'TOKEN_EXPIRED':
      return 'access token 已过期，需要刷新'
    case 'DEVICE_REVOKED':
      return '这台设备已被撤销，需要重新注册设备'
    case 'DEVICE_OWNERSHIP_REQUIRED':
      return '设备归属校验失败（token 不属于该 deviceId）'
    case 'AUTH_REQUIRED':
      return serverMessage ?? '需要登录'
    default:
      return serverMessage ?? `认证失败（${code}）`
  }
}

const isInviteSignal = (code: string, serverMessage?: string): boolean =>
  /invit|邀请/i.test(code) || (serverMessage !== undefined && /invit|邀请/i.test(serverMessage))

const request = async <T>(
  base: string,
  path: string,
  options: RequestOptions,
  deps: ServerApiDeps,
): Promise<T> => {
  const { url, init } = buildTransport(base, path, options, deps)
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  let response: Response
  try {
    response = await resolveFetch(deps)(url, { ...init, signal: controller.signal })
  } catch (error) {
    if (timedOut) {
      throw new RemoteApiError('TIMEOUT', `请求超时（${timeoutMs}ms）：${path}`, undefined, true, { path })
    }
    // 代理没起来 / 断网：这是「网络错」，不是「账号错」
    throw new RemoteApiError(
      'NETWORK_ERROR',
      '连不上本地代理（/__ds_proxy）或远端服务器，请检查网络与壳进程',
      undefined,
      true,
      { path, cause: messageOf(error) },
    )
  } finally {
    clearTimeout(timer)
  }

  let text = ''
  try {
    text = await response.text()
  } catch (error) {
    if (timedOut) {
      throw new RemoteApiError('TIMEOUT', `读取响应超时：${path}`, undefined, true, { path })
    }
    throw new RemoteApiError('NETWORK_ERROR', `读取响应失败：${path}`, undefined, true, { path, cause: messageOf(error) })
  }

  let body: unknown
  if (text.length > 0) {
    try {
      body = JSON.parse(text)
    } catch {
      // 非 JSON 错误体：交给 mapHttpError 按状态码兜底（协议 §8.2 要求不据此判设备失效）
      body = undefined
    }
  }

  if (!response.ok) throw mapHttpError(response.status, body)
  return body as T
}

/* ── 响应校验 ─────────────────────────────────────────────────────────── */

const invalidResponse = (what: string): RemoteApiError =>
  new RemoteApiError('INVALID_RESPONSE', `服务器返回的${what}格式不符合协议`, undefined, false)

/**
 * token pair 校验（docs/protocol.md §8.1）：两个 token 的 UTF-8 长度 16–8192，
 * 两个到期时间必须是正安全整数。
 */
export const parseTokenPair = (value: unknown): DeviceTokenPair => {
  if (!isRecord(value)) throw invalidResponse('token pair')
  const { accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt } = value
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') throw invalidResponse('token pair')
  const accessBytes = utf8Length(accessToken)
  const refreshBytes = utf8Length(refreshToken)
  if (accessBytes < 16 || accessBytes > 8192 || refreshBytes < 16 || refreshBytes > 8192) {
    throw invalidResponse('token pair（token 长度越界）')
  }
  if (!isPositiveSafeInteger(accessTokenExpiresAt) || !isPositiveSafeInteger(refreshTokenExpiresAt)) {
    throw invalidResponse('token pair（到期时间非法）')
  }
  return { accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt }
}

const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

/* ── 登录 ─────────────────────────────────────────────────────────────── */

export interface AccountLoginResult {
  /** 站点账号 token（**只用来注册设备**，docs/plugin-integration.md:195） */
  token: string
  expiresAt?: number
  account?: string
  isAdmin?: boolean
}

/**
 * POST /api/v1/auth/login（docs/protocol.md §9 前置；docs/plugin-integration.md:50-70）
 *
 * 账号 token **没有 refresh 接口**，过期只能重新登录（docs/plugin-integration.md:139-140）。
 */
export const login = async (
  server: RemoteServer,
  email: string,
  password: string,
  deps: ServerApiDeps = {},
): Promise<AccountLoginResult> => {
  const base = normalizeServerUrl(server.url)
  const user = email.trim()
  if (user.length === 0) throw new RemoteApiError('INVALID_ARGUMENT', '邮箱不能为空')
  if (password.length === 0) throw new RemoteApiError('INVALID_ARGUMENT', '密码不能为空')
  const body = await request(base, '/api/v1/auth/login', { method: 'POST', body: { email: user, password } }, deps)
  if (!isRecord(body) || typeof body.token !== 'string' || body.token.length === 0) {
    throw invalidResponse('登录响应（缺 token）')
  }
  const expiresAt = isPositiveSafeInteger(body.expiresAt) ? body.expiresAt : undefined
  return {
    token: body.token,
    expiresAt,
    account: typeof body.account === 'string' ? body.account : undefined,
    isAdmin: body.isAdmin === true,
  }
}

/* ── 设备注册 ─────────────────────────────────────────────────────────── */

/**
 * POST /api/v1/devices/register（docs/protocol.md §8.1）
 *
 * Authorization 用**账号** token；返回设备 token pair。
 * 错误：401 ACCOUNT_AUTH_REQUIRED / 403 DEVICE_OWNERSHIP_REQUIRED（plugin-integration.md:189-193）。
 */
export const registerDevice = async (
  server: RemoteServer,
  accountToken: string,
  device: AccountDeviceDescriptor,
  deps: ServerApiDeps = {},
): Promise<DeviceTokenPair> => {
  const base = normalizeServerUrl(server.url)
  if (accountToken.length === 0) {
    throw new RemoteApiError('AUTH_REQUIRED', '注册设备需要先登录（缺账号 token）')
  }
  const body = await request(
    base,
    '/api/v1/devices/register',
    { method: 'POST', token: accountToken, body: { v: 1, device } },
    deps,
  )
  return parseTokenPair(body)
}

/* ── token 刷新 ───────────────────────────────────────────────────────── */

/**
 * POST /api/v1/auth/refresh（docs/protocol.md §8.2）
 *
 * Server **必须轮换** refresh token，调用方拿到新 pair 后要**原子替换**本地存储；
 * 这里的返回值就是唯一真源，别在别处再留一份旧 token。
 */
export const refreshToken = async (
  server: RemoteServer,
  deviceId: string,
  currentRefreshToken: string,
  deps: ServerApiDeps = {},
): Promise<DeviceTokenPair> => {
  const base = normalizeServerUrl(server.url)
  if (deviceId.length === 0 || currentRefreshToken.length === 0) {
    throw new RemoteApiError('AUTH_REQUIRED', '缺少 deviceId / refreshToken，无法刷新')
  }
  const body = await request(
    base,
    '/api/v1/auth/refresh',
    { method: 'POST', body: { deviceId, refreshToken: currentRefreshToken } },
    deps,
  )
  return parseTokenPair(body)
}

/* ── 设备发现 ─────────────────────────────────────────────────────────── */

export interface ServerDeviceRecord {
  deviceId: string
  name?: string
  role?: string
  platform?: string
  online?: boolean
  lastSeenAt?: number
  harnessVersion?: string
  /** 只有 `getDevice` 会返回（列表接口明确不返回 identityKey，docs/protocol.md §9） */
  identityKey?: string
}

export interface ListDevicesOptions {
  limit?: number
  cursor?: string
  /** 默认 true：读完所有页（协议要求，禁止拿部分列表当成功） */
  all?: boolean
  maxPages?: number
}

export interface DeviceListResult {
  items: ServerDeviceRecord[]
  pages: number
}

const parseDeviceRecord = (value: unknown): ServerDeviceRecord | null => {
  if (!isRecord(value) || typeof value.deviceId !== 'string' || value.deviceId.length === 0) return null
  return {
    deviceId: value.deviceId,
    name: typeof value.name === 'string' ? value.name : undefined,
    role: typeof value.role === 'string' ? value.role : undefined,
    platform: typeof value.platform === 'string' ? value.platform : undefined,
    online: typeof value.online === 'boolean' ? value.online : undefined,
    lastSeenAt: isPositiveSafeInteger(value.lastSeenAt) ? value.lastSeenAt : undefined,
    harnessVersion: typeof value.harnessVersion === 'string' ? value.harnessVersion : undefined,
    identityKey: typeof value.identityKey === 'string' ? value.identityKey : undefined,
  }
}

const parseDevicePage = (value: unknown): { items: ServerDeviceRecord[]; nextCursor: string | null } => {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw invalidResponse('设备列表（缺 items 数组）')
  }
  const items: ServerDeviceRecord[] = []
  for (const entry of value.items) {
    const parsed = parseDeviceRecord(entry)
    if (parsed !== null) items.push(parsed)
  }
  const nextCursor = typeof value.nextCursor === 'string' && value.nextCursor.length > 0 ? value.nextCursor : null
  return { items, nextCursor }
}

/**
 * GET /api/v1/devices?limit&cursor（docs/protocol.md §9）
 *
 * 默认读完全部页：keyset 按 deviceId 升序，`nextCursor` 为空才停；
 * 老 Server 忽略 limit、一次给全量（没有 nextCursor）时也能正确收尾。
 * 串行翻页（协议允许 8 路并发，但设备数很小，串行更省事也更不容易漏）。
 */
export const listDevices = async (
  server: RemoteServer,
  accessToken: string,
  options: ListDevicesOptions = {},
  deps: ServerApiDeps = {},
): Promise<DeviceListResult> => {
  const base = normalizeServerUrl(server.url)
  if (accessToken.length === 0) throw new RemoteApiError('AUTH_REQUIRED', '缺少设备 access token')
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT)
  const readAll = options.all !== false
  const maxPages = Math.max(options.maxPages ?? MAX_PAGES, 1)

  const seen = new Set<string>()
  const items: ServerDeviceRecord[] = []
  let cursor = options.cursor
  let pages = 0

  for (;;) {
    const page = parseDevicePage(
      await request(base, '/api/v1/devices', { method: 'GET', token: accessToken, query: { limit, cursor } }, deps),
    )
    pages += 1
    for (const item of page.items) {
      if (seen.has(item.deviceId)) continue
      seen.add(item.deviceId)
      items.push(item)
    }
    if (!readAll) break
    if (page.nextCursor === null || page.nextCursor === cursor) break
    if (pages >= maxPages) break
    cursor = page.nextCursor
  }

  return { items, pages }
}

/**
 * GET /api/v1/devices/{deviceId}（docs/protocol.md §9）
 *
 * 这是**唯一**能拿到 Host `identityKey` 的接口，客户端必须用它做本机 pin。
 * 返回的 deviceId 与请求不一致视为异常（防 IDOR / 代理串号）。
 */
export const getDevice = async (
  server: RemoteServer,
  accessToken: string,
  deviceId: string,
  deps: ServerApiDeps = {},
): Promise<ServerDeviceRecord> => {
  const base = normalizeServerUrl(server.url)
  if (accessToken.length === 0) throw new RemoteApiError('AUTH_REQUIRED', '缺少设备 access token')
  if (deviceId.length === 0) throw new RemoteApiError('INVALID_ARGUMENT', 'deviceId 不能为空')
  const record = await request(
    base,
    `/api/v1/devices/${encodeURIComponent(deviceId)}`,
    { method: 'GET', token: accessToken },
    deps,
  )
  const parsed = parseDeviceRecord(record)
  if (parsed === null) throw invalidResponse('设备详情')
  if (parsed.deviceId !== deviceId) throw invalidResponse('设备详情（deviceId 不匹配）')
  if (!isIdentityKey(parsed.identityKey)) throw invalidResponse('设备详情（identityKey 不是 43 字符 base64url）')
  return parsed
}

export interface DevicePresence {
  online: boolean
  lastSeenAt?: number
}

/**
 * GET /api/v1/devices/{deviceId}/presence（docs/protocol.md §9）
 *
 * 在线状态只认这个接口：列表快照里的 online 可能已经过期，不能当实时状态展示
 * （参考 apps/browser/src/server-api.ts:56-66 的 fail-closed 写法）。
 */
export const getPresence = async (
  server: RemoteServer,
  accessToken: string,
  deviceId: string,
  deps: ServerApiDeps = {},
): Promise<DevicePresence> => {
  const base = normalizeServerUrl(server.url)
  const body = await request(
    base,
    `/api/v1/devices/${encodeURIComponent(deviceId)}/presence`,
    { method: 'GET', token: accessToken },
    deps,
  )
  if (!isRecord(body) || body.deviceId !== deviceId || typeof body.online !== 'boolean') {
    throw invalidResponse('设备在线状态')
  }
  const lastSeenAt = isPositiveSafeInteger(body.lastSeenAt) ? body.lastSeenAt : undefined
  return { online: body.online, lastSeenAt }
}

/* ── 401 → 刷新一次 → 重试一次 ───────────────────────────────────────── */

export interface RefreshRetryInput<T> {
  server: RemoteServer
  auth: { deviceId: string; accessToken: string; refreshToken: string }
  /** 只会传只读查询进来（GET）；mutation / 审批 / 终端输入禁止走这条路 */
  run: (accessToken: string) => Promise<T>
  /** 拿到新 pair 后**原子替换**本地 token（storage 是唯一真源） */
  onRefresh: (pair: DeviceTokenPair) => void | Promise<void>
  deps?: ServerApiDeps
}

/** 401 是不是值得刷新一次再重试：明确「设备被撤销 / 归属不符」时不刷，直接失败 */
const shouldRefreshOn = (error: unknown): boolean => {
  if (!isRemoteApiError(error) || error.status !== 401) return false
  return error.code !== 'DEVICE_REVOKED' && error.code !== 'DEVICE_OWNERSHIP_REQUIRED'
}

/**
 * GET 遇 401 **最多刷新重试一次**（仓库 AGENTS.md 架构 1 节；docs/protocol.md §8.2）。
 *
 * 第二次仍然 401 就直接抛，不递归、不重放：上层要么提示重新登录，要么退避。
 */
export const withRefreshRetry = async <T>(input: RefreshRetryInput<T>): Promise<T> => {
  try {
    return await input.run(input.auth.accessToken)
  } catch (error) {
    if (!shouldRefreshOn(error)) throw error
    if (input.auth.deviceId.length === 0 || input.auth.refreshToken.length === 0) {
      throw new RemoteApiError('AUTH_REQUIRED', 'access token 已失效，且本地没有可用于刷新的 refreshToken', 401)
    }
    const pair = await refreshToken(input.server, input.auth.deviceId, input.auth.refreshToken, input.deps ?? {})
    await input.onRefresh(pair)
    return await input.run(pair.accessToken)
  }
}

/** 给上层判断用：这条错误是不是「需要重新登录」 */
export const needsReauth = (error: unknown): boolean => {
  const code = errorCodeOf(error)
  return code === 'AUTH_REQUIRED' || code === 'AUTH_INVALID' || code === 'TOKEN_EXPIRED'
}

/* ═══════════════════════════════════════════════════════════════════════
 * 多方式登录：健康探活 / OAuth 提供方 / 扫码登录 / 账号资料
 *
 * 协议依据（已与上游 `ds-harness-remote` 核对）：
 *   `packages/app-core/src/services/api.ts` 的 health / oauthProviders /
 *   startOAuthQrLogin / pollOAuthQrLogin / accountMe，以及
 *   `services/login/oauth-redirect-channel.ts` 的 `return_to=dshremote://oauth`。
 *
 * 四条不变量：
 *   1. **OAuth / 扫码拿到的都只是「账号 token」**，它只能用来注册设备
 *      （`registerDevice`）——与邮箱密码登录拿到的是同一种东西，没有第二套凭据。
 *   2. **token 不进 URL、不进日志**：URL 里只允许出现 `return_to=dshremote://oauth`
 *      这种非敏感参数；token 只走 `Authorization` 头（头本身被 base64url 装进 `X-DS-Headers`）。
 *   3. **发现类响应必须过同源校验**：`startUrl` / `qrStartUrl` 只接受站内
 *      `/api/v1/auth/` 相对路径，`scanUrl` 必须与 baseUrl 同源且同一路径前缀 ——
 *      否则一条被篡改的发现响应就能把客户端变成开放请求转发器（上游同款校验）。
 *   4. **401 / 404 不吞**：老 Server 没有 providers 端点时按上游语义回退到
 *      per-provider 的 `status` 端点，其余错误一律原样上抛，不猜。
 * ═══════════════════════════════════════════════════════════════════════ */

/** OAuth 回调地址：官方 App 的固定 scheme（**Chat Pad 不用它**，见下面的说明） */
export const OAUTH_RETURN_TO = 'dshremote://oauth'

/** provider id 的形状（Server 决定取值，客户端只做形状校验） */
const OAUTH_PROVIDER_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/

/** 扫出来的二维码链接必须是「baseUrl + /」开头，挡住跨源与协议相对地址 */
const sameOriginScanUrl = (value: unknown, baseUrl: string): string | undefined => {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value)) return undefined
  try {
    const normalized = new URL(value).href
    return normalized.startsWith(`${baseUrl}/`) ? normalized : undefined
  } catch {
    return undefined
  }
}

/**
 * `startUrl` / `qrStartUrl` 只允许站内 `/api/v1/auth/` 相对路径。
 * 上游同名函数的逐条对应：控制字符、空白、反斜杠、`#`、`.`/`..`/百分号编码一律拒。
 */
const isAuthEntryPath = (value: unknown): value is string => {
  if (typeof value !== 'string' || !value.startsWith('/api/v1/auth/')) return false
  if (/[\u0000-\u001f\u007f\s\\#]/u.test(value)) return false
  return !(value.split('?')[0] ?? '').split('/').some((segment) => segment === '.' || segment === '..' || segment.includes('%'))
}

/** Server 侧声明的 OAuth 提供方（`GET /api/v1/auth/oauth/providers` 的一项） */
export interface OAuthProvider {
  /** Server 决定的不透明 id（`zhihu` / `github` / …） */
  id: string
  displayName: string
  /** 站内相对路径；浏览器打开时拼成 `${baseUrl}${startUrl}?return_to=…` */
  startUrl: string
  /** 扫码登录的建会话路径；缺省 = 该 provider 不支持扫码 */
  qrStartUrl?: string
}

/** 扫码会话（`POST ${qrStartUrl}`） */
export interface OAuthQrSession {
  /** ≥20 字符；服务端一次性会话 id */
  qrId: string
  /** 二维码里要编的链接；必须与 baseUrl 同源 */
  scanUrl: string
  /** 有效期（秒） */
  expiresIn: number
}

/** 扫码轮询结果：`complete` 时 token **只返回一次**，之后同一 qrId 不会再给 */
export type OAuthQrPollResult = { status: 'pending' | 'expired' } | { status: 'complete'; token: string }

/** 老 Server 的回退清单（与上游 `oauthProviders()` 的 404 分支一致） */
const LEGACY_OAUTH_PROVIDERS = [
  {
    id: 'zhihu',
    displayName: '知乎',
    statusPath: '/api/v1/auth/oauth/status',
    startUrl: '/api/v1/auth/oauth/start',
    qrStartUrl: '/api/v1/auth/oauth/qr/start?provider=zhihu',
  },
  {
    id: 'github',
    displayName: 'GitHub',
    statusPath: '/api/v1/auth/oauth/github/status',
    startUrl: '/api/v1/auth/oauth/github/start',
    qrStartUrl: '/api/v1/auth/oauth/qr/start?provider=github',
  },
] as const

/**
 * GET /health（登录前先探活；docs/protocol.md §6 的通用 REST 只剩这一个匿名端点）
 *
 * 只看 `{status:'ok'}`；别的都算「这台服务器现在不能登录」，抛 `CONNECTION_FAILED`。
 */
export const health = async (server: RemoteServer, deps: ServerApiDeps = {}): Promise<void> => {
  const base = normalizeServerUrl(server.url)
  const body = await request(base, '/health', { method: 'GET' }, deps)
  if (!isRecord(body) || body.status !== 'ok') {
    throw new RemoteApiError('CONNECTION_FAILED', '服务器健康检查没通过（/health 没有返回 status: "ok"）', undefined, true)
  }
}

const parseOAuthProviders = (items: unknown[]): OAuthProvider[] => {
  const seen = new Set<string>()
  const providers: OAuthProvider[] = []
  for (const entry of items) {
    if (!isRecord(entry)) throw invalidResponse('OAuth 提供方列表')
    const { id, displayName, startUrl, qrStartUrl } = entry
    if (typeof id !== 'string' || !OAUTH_PROVIDER_ID.test(id) || seen.has(id)) throw invalidResponse('OAuth 提供方列表')
    if (typeof displayName !== 'string' || displayName.trim().length === 0 || displayName.length > 128) {
      throw invalidResponse('OAuth 提供方列表（displayName 非法）')
    }
    if (!isAuthEntryPath(startUrl)) throw invalidResponse('OAuth 提供方列表（startUrl 不是站内 auth 路径）')
    if (qrStartUrl !== undefined && qrStartUrl !== null && !isAuthEntryPath(qrStartUrl)) {
      throw invalidResponse('OAuth 提供方列表（qrStartUrl 不是站内 auth 路径）')
    }
    seen.add(id)
    providers.push({
      id,
      displayName,
      startUrl,
      ...(typeof qrStartUrl === 'string' ? { qrStartUrl } : {}),
    })
  }
  return providers
}

/** 老 Server：逐个问 per-provider 的 status 端点，`configured:true` 的才列（上游同款） */
const legacyOAuthProviders = async (base: string, deps: ServerApiDeps): Promise<OAuthProvider[]> => {
  const providers: OAuthProvider[] = []
  for (const legacy of LEGACY_OAUTH_PROVIDERS) {
    try {
      const status = await request(base, legacy.statusPath, { method: 'GET' }, deps)
      if (isRecord(status) && status.configured === true) {
        providers.push({
          id: legacy.id,
          displayName: legacy.displayName,
          startUrl: legacy.startUrl,
          qrStartUrl: legacy.qrStartUrl,
        })
      }
    } catch (error) {
      // 老 Server 连这个 provider 都没有：跳过；其余错误照抛（不能把「挂了」当「没配置」）
      if (isRemoteApiError(error) && error.status === 404) continue
      throw error
    }
  }
  return providers
}

/**
 * GET /api/v1/auth/oauth/providers（Server 声明的登录方式）。
 *
 * 404 → 回退到 per-provider 的 `status` 端点（只列 `configured:true`）；
 * 回退时 `startUrl` / `qrStartUrl` 是按上游约定拼出来的站内路径（见 `LEGACY_OAUTH_PROVIDERS`）。
 * 返回空数组是合法结果（= 这台服务器只开邮箱密码），**不是**错误。
 */
export const oauthProviders = async (server: RemoteServer, deps: ServerApiDeps = {}): Promise<OAuthProvider[]> => {
  const base = normalizeServerUrl(server.url)
  let body: unknown
  try {
    body = await request(base, '/api/v1/auth/oauth/providers', { method: 'GET' }, deps)
  } catch (error) {
    if (!isRemoteApiError(error) || error.status !== 404) throw error
    return legacyOAuthProviders(base, deps)
  }
  if (!isRecord(body) || !Array.isArray(body.items)) throw invalidResponse('OAuth 提供方列表（缺 items 数组）')
  return parseOAuthProviders(body.items as unknown[])
}

/**
 * 拼 OAuth 跳转地址：`${baseUrl}${provider.startUrl}?return_to=dshremote://oauth`
 *
 * ⚠️ **仅用于诊断 / 兜底**：Chat Pad 的正式流程走「QR 会话 + 轮询」
 * （`oauth.ts` 的 `startProviderLogin`），**不用** `return_to` 回调 ——
 * 服务端只认 `dshremote://oauth` 这一种自定义 scheme，其他 scheme 一律归一化成 `/app`
 * （`docs/plugin-integration.md:110-112`），而 `dshremote` 是官方 App 的 scheme，
 * 声明它会**抢回调**，且服务端没有 loopback 回调。
 *
 * 保留这个函数是为了：① 在外部浏览器里手工打开授权页排障；② 将来服务端支持
 * 别的回调形态时复用。`startUrl` 仍要过站内 `/api/v1/auth/` 校验 ——
 * 发现响应不可信，不能让页面被带去任意地址。
 */
export const oauthStartUrl = (server: RemoteServer | string, provider: OAuthProvider): string => {
  const base = normalizeServerUrl(typeof server === 'string' ? server : server.url)
  if (!isAuthEntryPath(provider.startUrl)) {
    throw new RemoteApiError('INVALID_ARGUMENT', `「${provider.displayName}」的登录入口不是站内 auth 路径，已拒绝跳转`)
  }
  const url = new URL(`${base}${provider.startUrl}`)
  url.searchParams.set('return_to', OAUTH_RETURN_TO)
  return url.toString()
}

/**
 * POST `${provider.qrStartUrl}`（body `{}`）→ 建一个短命的扫码会话。
 *
 * 校验：qrId ≥20 字符、expiresIn 是正安全整数、`provider` 回显（若有）必须一致、
 * scanUrl 必须与 baseUrl 同源（`sameOriginScanUrl`）。
 */
export const startOAuthQrLogin = async (
  server: RemoteServer,
  provider: OAuthProvider,
  deps: ServerApiDeps = {},
): Promise<OAuthQrSession> => {
  const base = normalizeServerUrl(server.url)
  if (provider.qrStartUrl === undefined) {
    throw new RemoteApiError('INVALID_ARGUMENT', `「${provider.displayName}」不支持扫码登录`)
  }
  const body = await request(base, provider.qrStartUrl, { method: 'POST', body: {} }, deps)
  if (!isRecord(body)) throw invalidResponse('扫码登录会话')
  const { qrId, expiresIn, scanUrl, provider: echoed } = body
  if (typeof qrId !== 'string' || qrId.length < 20) throw invalidResponse('扫码登录会话（qrId 太短）')
  if (!isPositiveSafeInteger(expiresIn)) throw invalidResponse('扫码登录会话（expiresIn 非法）')
  if (echoed !== undefined && echoed !== null && echoed !== provider.id) {
    throw invalidResponse('扫码登录会话（provider 与请求不一致）')
  }
  const safeScanUrl = sameOriginScanUrl(scanUrl, base)
  if (safeScanUrl === undefined) throw invalidResponse('扫码登录会话（scanUrl 与服务器不同源）')
  return { qrId, scanUrl: safeScanUrl, expiresIn }
}

/**
 * GET /api/v1/auth/oauth/qr/{qrId}（扫码轮询）
 *
 * `complete` 时 token 只返回一次：拿到就必须立刻走 `registerDevice`，**不许**再 poll。
 */
export const pollOAuthQrLogin = async (
  server: RemoteServer,
  qrId: string,
  deps: ServerApiDeps = {},
): Promise<OAuthQrPollResult> => {
  const base = normalizeServerUrl(server.url)
  const id = qrId.trim()
  if (id.length === 0) throw new RemoteApiError('INVALID_ARGUMENT', '扫码会话 id 不能为空')
  const body = await request(base, `/api/v1/auth/oauth/qr/${encodeURIComponent(id)}`, { method: 'GET' }, deps)
  if (!isRecord(body)) throw invalidResponse('扫码登录状态')
  if (body.status === 'pending' || body.status === 'expired') return { status: body.status }
  if (body.status !== 'complete' || typeof body.token !== 'string' || body.token.length < 16) {
    throw invalidResponse('扫码登录状态（complete 但没有有效 token）')
  }
  return { status: 'complete', token: body.token }
}

/**
 * GET /api/v1/auth/me（带**账号** token）→ `{account}`
 *
 * OAuth / 扫码拿到 token 后先调这个：既验证 token 可用，也拿到账号名（注册设备后它仍是
 * `RemoteAccount.email` 的主键，同服务器 + 同账号算一条记录）。
 */
export const accountMe = async (
  server: RemoteServer,
  accountToken: string,
  deps: ServerApiDeps = {},
): Promise<{ account: string }> => {
  const base = normalizeServerUrl(server.url)
  const token = accountToken.trim()
  if (token.length === 0) throw new RemoteApiError('AUTH_REQUIRED', '缺少账号 token，无法获取账号资料')
  const body = await request(base, '/api/v1/auth/me', { method: 'GET', token }, deps)
  if (!isRecord(body) || typeof body.account !== 'string' || body.account.trim().length === 0) {
    throw invalidResponse('账号资料')
  }
  return { account: body.account.trim() }
}
