/**
 * Chat Pad 远程 DSH：多方式登录之 **provider 登录（QR 会话 + 浏览器 / 扫码完成）**。
 *
 * ## 为什么不是「重定向 + 自定义 scheme 回调」
 *
 * 服务端只认 `dshremote://oauth` 一种自定义 scheme，其他 scheme / 外部 URL 一律被归一化成
 * `/app`（`docs/plugin-integration.md:110-112`，防开放重定向）；而 `dshremote` 是官方
 * RN / Go 客户端的 scheme，Chat Pad 声明它就会**抢回调**（同机装了官方 App 会弹选择器）。
 * 服务端也没有 loopback 回调。所以 `return_to` 这条路径在 Chat Pad 上不可用。
 *
 * ## 正式流程（与 dsh-Go 同款，`remote_account.dart:510-591`）
 *
 * ```
 *  POST {qrStartUrl} {}                     ← 建一次「登录会话」，两种入口共用
 *        │  {qrId, scanUrl, expiresIn}
 *        ├── mode='browser' → POST /__ds_auth/open {url, serverUrl, mode:'external'}
 *        │       默认交给**系统浏览器**完成授权（见「为什么默认是系统浏览器」）
 *        └── mode='qr'      → 把 scanUrl 渲染成二维码，用另一台设备扫
 *        ▼
 *  每 ~2s GET /api/v1/auth/oauth/qr/{qrId}
 *        │  pending → expired / complete（账号 token 只返回一次）
 *        ▼
 *  POST /__ds_auth/close                    ← 浏览器模式收尾（external 下是 no-op，幂等）
 *        ▼
 *  GET /api/v1/auth/me → POST /api/v1/devices/register → 设备 token pair
 * ```
 *
 * 两种入口**共用同一个 qrId 与同一套轮询**：浏览器模式是「本机授权」，扫码模式是
 * 「另一台已登录该站的设备扫一下授权」，产物完全一样。
 *
 * ## 为什么默认是系统浏览器（K2）
 *
 * 应用内 WebView 打开第三方授权页有两个真机问题：① Google 这类 provider 直接拒
 * `disallowed_useragent`；② 用户在 WebView 里授权完、回 App 的那一步经常被系统回收进程。
 * 所以原生容器默认改成 `external`（`Intent.ACTION_VIEW`），`inline` 只作为可选覆盖项保留。
 *
 * ⚠️ **`external` 之后 `state.open` 恒为 `false`，不能再拿它判断「用户取消了」**：
 * 系统浏览器不在壳的窗口栈里，原生拿不到「页面已关闭」这个信号，`/__ds_auth/open` 会回
 * `{ok:true, open:false, mode:'external', launched:true}`。取消只能靠用户点「取消登录」，
 * 或者等轮询拿到 `expired` / 本地超时。`authPageState().open === false` 同理。
 *
 * ## 会话可恢复（App 被系统杀掉也不丢登录）
 *
 * 「切到系统浏览器 → 回后台」时 Android 常直接把 WebView 进程杀掉，页面内存状态全丢；
 * 但**服务端会话独立于 App 进程**（`qrId` 还在、没过期就能继续轮询拿到 token）。所以只要把
 * 「待完成会话」落盘就能续上：
 *
 * ```
 *  发起登录 ──► localStorage['dsp.remote.pending-login.v1']
 *    │            = {serverUrl, providerId, mode, qrId, scanUrl, startedAt, expiresAt}
 *    ├──► 系统浏览器里授权             │
 *    ▼                                ▼
 *  （进程可能被杀）        resumePendingLogin()  ← App 启动、visibilitychange→visible 都调
 *                                   │
 *                     pending / 网络瞬断 ──► 继续轮询（会话在服务端，不随进程死掉）
 *                     complete          ──► 落账号 + 注册设备 + 删键
 *                     expired / 超时    ──► 删键 + 返回原因
 *                     401 / 404         ──► 删键 + 终止（qrId 已作废，重试无意义）
 * ```
 *
 * 键里**只有 qrId / scanUrl 这类非敏感字段**，token 一律不进这个键（token 只走
 * `storage.ts`）。`resumePendingLogin()` 幂等：并发调用只有一个轮询在飞，后到者拿同一个 Promise。
 *
 * ## 原生容器契约（J7 已落地：`android/.../RemoteAuthHandler.java`）
 *
 * | 端点 | 方法 | body | 返回 |
 * |---|---|---|---|
 * | `/__ds_auth/open`  | POST | `{url, title?, serverUrl?, allowHost?, mode?}` | `{ok,open,mode,id,url,launched?}` |
 * | `/__ds_auth/close` | POST | `{}` | `{ok,open:false,closed}`（幂等） |
 * | `/__ds_auth/state` | GET  | – | `{ok,open,mode,id,url,title,lastRedirect}` |
 *
 * 原生态的三条硬约束（页面侧必须遵守，自测里都钉住了）：
 *   1. **只收 https**：http 回 400 `https_required`；
 *   2. **必须带 `serverUrl`**：原生态用它做严格同源校验；不带的话自建 / LAN 服务器会吃
 *      403 `private_host_rejected`（它不给自己当「任意网页打开器」）；
 *   3. **POST 必须声明 `application/json`**（CSRF 闸门），否则 415。
 *
 * 非壳环境（普通浏览器）这些端点不存在 → 报 **「只能在 App 内使用」**（`OAUTH_UNAVAILABLE`）；
 * 在壳里却 404（旧 APK 没有这套端点）→ 报 **「请更新 App」**（`OAUTH_BRIDGE_UPDATE_REQUIRED`），
 * **绝不**挂着转圈。注意：`mode='qr'` 不需要原生桥（二维码可以在任何环境画出来），
 * 只有 `mode='browser'` 依赖它。
 *
 * ## 边界
 *
 * - 本文件只碰**一个** localStorage 键：`dsp.remote.pending-login.v1`（待完成会话，
 *   **非敏感**：只有 qrId / scanUrl / 过期时刻）。账号与设备 token 的落盘仍然统一走
 *   `connection.loginWithAccountToken()`；`resumePendingLogin()` 的默认落地会复用
 *   `storage.upsertAccount()`（与前者同键同字段），因为它要在**没有连接**的情况下
 *   也能把账号拿到手。
 * - 本文件**不碰 Noise / WebSocket**：建链是 `store.ts` 的事。
 * - token 只作为返回值与 `Authorization` 头存在：不进 URL、不进日志、不进错误信息，
 *   也**不进** `dsp.remote.pending-login.v1`。
 */

import type { AccountDeviceDescriptor, DeviceTokenPair } from '../../vendor/dsh-remote/protocol/index.js'

import { DEFAULT_PLATFORM, deviceDescriptor, loadOrCreateIdentity, type DeviceIdentity } from './identity.js'
import {
  RemoteApiError,
  accountMe,
  health,
  isRemoteApiError,
  normalizeServerUrl,
  pollOAuthQrLogin,
  registerDevice,
  startOAuthQrLogin,
  type FetchLike,
  type OAuthProvider,
  type OAuthQrPollResult,
  type ServerApiDeps,
} from './serverApi.js'
import { upsertAccount } from './storage.js'

/* ── 原生容器端点（J7） ───────────────────────────────────────────────── */

/** 打开授权页面（POST `{url, serverUrl, title?, mode?}`；原生态只收 https 且要求 `application/json`） */
export const NATIVE_AUTH_OPEN_PATH = '/__ds_auth/open'
/** 关闭授权页面（POST `{}`；幂等） */
export const NATIVE_AUTH_CLOSE_PATH = '/__ds_auth/close'
/** 授权页面状态（GET `{ok,open,mode,id,url,title,lastRedirect}`；404 = 旧 APK） */
export const NATIVE_AUTH_STATE_PATH = '/__ds_auth/state'

/** 轮询节奏：2s（dsh-Go `loginPollInterval` 同值；再密要担心服务器按 IP 限流） */
export const DEFAULT_PROVIDER_POLL_INTERVAL_MS = 2_000
/** 等授权的总预算：3 分钟（与二维码自身的 `expiresIn` 取小） */
export const DEFAULT_PROVIDER_LOGIN_TIMEOUT_MS = 180_000
/** 轮询容忍的连续瞬时错误次数（网络抖动不该废掉一次登录） */
const MAX_POLL_FAILURES = 3
/** 账号 token 最小长度（上游 `api.ts` 对 complete 的同款下限） */
const MIN_ACCOUNT_TOKEN_LENGTH = 16

/**
 * 待完成登录会话的 localStorage 键（跨进程恢复用）。
 *
 * 只存 `{serverUrl, providerId, mode, qrId, scanUrl, startedAt, expiresAt}` ——
 * **没有 token**：token 只活在这一个进程的内存里，领到就落 `storage.ts` 的账号表。
 */
export const PENDING_LOGIN_STORAGE_KEY = 'dsp.remote.pending-login.v1'

/* ── 类型 ─────────────────────────────────────────────────────────────── */

/**
 * 授权入口：
 *   `browser` —— 本机用 Custom Tab / 外部浏览器完成授权（需要原生桥）；
 *   `qr`      —— 把 `scanUrl` 画成二维码，让另一台已登录该站的设备扫（不需要原生桥）。
 */
export type ProviderLoginMode = 'browser' | 'qr'

/** 一次 provider 登录会话（建会话的产物 + 本地算的过期时刻） */
export interface ProviderLoginSession {
  providerId: string
  mode: ProviderLoginMode
  /** ≥20 字符；轮询路径里的那个 id */
  qrId: string
  /** 授权页地址，同时也是二维码内容（已过同源校验） */
  scanUrl: string
  /** 本地算的过期时刻（毫秒；服务器仍是权威） */
  expiresAt: number
  /** 授权页**实际**用的打开方式（`qr` 模式没有；`no_browser` 回退时是 `inline`） */
  authMode?: AuthPageMode
  /** 需要让用户知道的一句话（例如「本机没有可用浏览器，已改用应用内登录」） */
  notice?: string
}

/**
 * 落盘的「待完成登录会话」（`dsp.remote.pending-login.v1` 的内容）。
 *
 * 加 `serverUrl` 与 `startedAt` 是必须的：qrId 只在**那台服务器**上有效（换服务器等于换一套
 * 账号体系），而 `startedAt` 让恢复流程能算出「这次等待到底等了多久」，不至于拿一个
 * 半路上的误判当超时。**不含 token** —— 这是它能进 localStorage 的前提。
 */
export interface PendingLoginRecord {
  /** 归一化后的服务器地址（`normalizeServerUrl` 的产物） */
  serverUrl: string
  providerId: string
  mode: ProviderLoginMode
  qrId: string
  scanUrl: string
  /** 发起时刻（毫秒） */
  startedAt: number
  /** 会话过期时刻（毫秒；服务器仍是权威） */
  expiresAt: number
}

export interface OAuthDeps {
  /** 原生桥 `/__ds_auth/*` 的 fetch（单测注入；生产留空走页面全局 fetch，同源即可） */
  nativeFetch?: FetchLike
  /** REST 层（`/__ds_proxy`）的注入，与 `serverApi` 同一套 */
  api?: ServerApiDeps
}

/** 设备注册相关的可选覆盖（正常走 localStorage 里的稳定身份） */
export interface DeviceSignInOptions {
  /** 已读到的本机身份（缺省 `loadOrCreateIdentity()`） */
  identity?: DeviceIdentity
  /** 设备名，缺省 "Chat Pad" */
  deviceName?: string
  /** 平台标识，缺省 `web` */
  platform?: string
  deps?: OAuthDeps
}

/** 一次多方式登录的产物：账号名 + 设备 id + 设备 token pair（尚未落盘） */
export interface OAuthSignInResult {
  /** 服务器给的账号名（`/api/v1/auth/me` 的 `account`，注册设备后是账号主键） */
  account: string
  deviceId: string
  tokens: DeviceTokenPair
}

export interface QrPollOptions {
  deps?: OAuthDeps
  /** 本地已知的过期时刻；到点直接判 expired，不再多打一次服务器 */
  expiresAt?: number
}

export interface WaitProviderLoginOptions extends QrPollOptions {
  /** 轮询间隔，默认 `DEFAULT_PROVIDER_POLL_INTERVAL_MS`（2s） */
  intervalMs?: number
  /** 总预算，默认 `DEFAULT_PROVIDER_LOGIN_TIMEOUT_MS`（3 分钟），与 `expiresAt` 取小 */
  timeoutMs?: number
  signal?: AbortSignal
  /** 每次判定为 pending 回调（UI 更新倒计时 / 「等待你在浏览器里完成授权…」） */
  onPending?: (elapsedMs: number) => void
}

/** `resumePendingLogin()` 的终态（`none` = 本来就没有待完成会话） */
export type ResumeLoginStatus = 'none' | 'complete' | 'expired' | 'timeout' | 'cancelled' | 'failed'

/** `resumePendingLogin()` 的结果：`status` 之外带上可直显的原因，便于 UI 分辨「过期」与「网络挂了」 */
export interface ResumeLoginResult {
  status: ResumeLoginStatus
  /** 命中的持久化会话（`none` 时没有） */
  record?: PendingLoginRecord
  /** 机器码（`QR_EXPIRED` / `QR_TIMEOUT` / `OAUTH_ABORTED` / 服务器返回的码…） */
  code?: string
  /** 中文原因，UI 可以原样显示 */
  message?: string
  /** `complete` 且走默认落地路径时的产物（账号已落盘，但**没有**建链） */
  result?: OAuthSignInResult
}

export interface ResumePendingLoginOptions {
  deps?: OAuthDeps
  /**
   * `complete` 之后怎么落地。缺省 = `completeProviderLogin()` + `storage.upsertAccount()`
   * （只把账号与设备 token 落盘，**不建链**）；`store.ts` 会传一个「顺手建链」的实现。
   *
   * 注意：账号 token 只能领一次，这个回调抛错就等于这次登录失败（qrId 已经用掉了），
   * 所以实现里不要做「稍后重试」的假设。
   */
  complete?: (input: { record: PendingLoginRecord; token: string }) => Promise<OAuthSignInResult | void>
  /** 轮询间隔，默认 `DEFAULT_PROVIDER_POLL_INTERVAL_MS`（2s） */
  intervalMs?: number
  /**
   * 本次恢复的等待预算，默认 `DEFAULT_PROVIDER_LOGIN_TIMEOUT_MS`（3 分钟）。
   * **从调用时刻算起**（不是从 `startedAt`）：App 可能被杀了半小时才回来，
   * 那段时间不该算进「我们等了多久」；硬上限仍是会话自己的 `expiresAt`。
   */
  timeoutMs?: number
  signal?: AbortSignal
  /** 每次判定为 pending 回调（UI 刷倒计时） */
  onPending?: (elapsedMs: number) => void
  /** 时钟注入（自测用） */
  now?: () => number
}

/* ── 小工具 ───────────────────────────────────────────────────────────── */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const messageOf = (value: unknown): string =>
  value instanceof Error ? value.message : typeof value === 'string' ? value : '未知错误'

const defaultFetch: FetchLike = (input, init) => fetch(input, init)

const resolveNativeFetch = (deps: OAuthDeps): FetchLike => deps.nativeFetch ?? defaultFetch

/**
 * `expiresIn` 的单位在协议里**没有写死**（上游 App 从不读它，只当不透明字段）。
 * 官方示例是 600 —— 按毫秒算只有 0.6 秒，显然不合理，所以按「秒」理解；
 * 但防备服务器哪天改成毫秒：超过 24h 的一律按毫秒算。本地过期判断只是抄近路，
 * 真过期仍以服务器 `poll` 的 `expired` 为准。
 */
const qrExpiryMs = (expiresIn: number): number => (expiresIn > 86_400 ? expiresIn : expiresIn * 1000)

/**
 * 可被 abort 打断的等待。
 *
 * 为什么不用 `Promise.race`：race 里输掉的那个 timer 没人清，登录页反复开关会攒一堆
 * 空转定时器；这里显式 clearTimeout + removeEventListener。
 */
const sleep = (ms: number, signal?: AbortSignal): Promise<void> => {
  if (ms <= 0) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new RemoteApiError('OAUTH_ABORTED', '登录已取消'))
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      reject(new RemoteApiError('OAUTH_ABORTED', '登录已取消'))
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/* ── 待完成登录会话（跨进程恢复：`dsp.remote.pending-login.v1`） ──────── */

/**
 * localStorage 取用点：隐私模式 / 配额满 / 非浏览器环境（例如 tsx 自测）返回 null，
 * 上层一律降级成「只在本次进程内有效」，**绝不抛** —— 登录不该因为存不下而失败。
 */
const pendingStore = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

const isPositiveTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0

/** 一条记录的结构校验（坏数据一律当没有，不让它把整个登录流程带进沟里） */
const parsePendingLogin = (value: unknown): PendingLoginRecord | null => {
  if (!isRecord(value)) return null
  const { serverUrl, providerId, mode, qrId, scanUrl, startedAt, expiresAt } = value
  if (typeof serverUrl !== 'string' || serverUrl.length === 0) return null
  if (typeof providerId !== 'string' || providerId.length === 0) return null
  if (mode !== 'browser' && mode !== 'qr') return null
  if (typeof qrId !== 'string' || qrId.length === 0) return null
  if (typeof scanUrl !== 'string' || scanUrl.length === 0) return null
  if (!isPositiveTime(startedAt) || !isPositiveTime(expiresAt)) return null
  if (expiresAt < startedAt) return null
  return { serverUrl, providerId, mode, qrId, scanUrl, startedAt, expiresAt }
}

/**
 * 读待完成会话。
 *
 * 坏数据会被**顺手删掉**：留着只会让每次启动都白跑一遍恢复流程。
 */
export const readPendingLogin = (): PendingLoginRecord | null => {
  const ls = pendingStore()
  if (ls === null) return null
  try {
    const raw = ls.getItem(PENDING_LOGIN_STORAGE_KEY)
    if (raw === null) return null
    const record = parsePendingLogin(JSON.parse(raw) as unknown)
    if (record === null) {
      ls.removeItem(PENDING_LOGIN_STORAGE_KEY)
      return null
    }
    return record
  } catch {
    // 解析失败 / localStorage 抛错：当没有
    return null
  }
}

/** 写待完成会话；返回是否真的落盘（存不下也不报错，本次进程内仍然可续） */
export const writePendingLogin = (record: PendingLoginRecord): boolean => {
  const ls = pendingStore()
  if (ls === null) return false
  try {
    ls.setItem(PENDING_LOGIN_STORAGE_KEY, JSON.stringify(record))
    return true
  } catch {
    return false
  }
}

/** 清掉待完成会话（用户取消 / 已完成 / 已失效都走这里） */
export const clearPendingLogin = (): void => {
  const ls = pendingStore()
  if (ls === null) return
  try {
    ls.removeItem(PENDING_LOGIN_STORAGE_KEY)
  } catch {
    // 清不掉也不影响：内容本身是非敏感的，下次发起登录会覆盖它
  }
}

/**
 * 只在「当前键还是这次会话」时清。
 *
 * 为什么要这个：恢复流程是异步的，用户可能中途又点了一次登录（新 qrId 已经落盘）。
 * 老的恢复流程收尾时无条件删键，会把**新会话**删掉 —— 下次启动就续不上了。
 */
const clearPendingLoginIf = (qrId: string): void => {
  const current = readPendingLogin()
  if (current !== null && current.qrId !== qrId) return
  clearPendingLogin()
}

/** 记录 → 会话（两者只差 `serverUrl` / `startedAt`） */
export const pendingLoginSession = (record: PendingLoginRecord): ProviderLoginSession => ({
  providerId: record.providerId,
  mode: record.mode,
  qrId: record.qrId,
  scanUrl: record.scanUrl,
  expiresAt: record.expiresAt,
})

/** 会话 → 记录（发起登录时落盘用） */
export const pendingLoginRecordOf = (
  serverUrl: string,
  session: ProviderLoginSession,
  startedAt: number = Date.now(),
): PendingLoginRecord => ({
  serverUrl,
  providerId: session.providerId,
  mode: session.mode,
  qrId: session.qrId,
  scanUrl: session.scanUrl,
  startedAt,
  expiresAt: session.expiresAt,
})

/* ── 原生桥 ───────────────────────────────────────────────────────────── */

interface NativeResponse {
  status: number
  text: string
  body: unknown
}

const nativeRequest = async (deps: OAuthDeps, path: string, init: RequestInit): Promise<NativeResponse> => {
  let response: Response
  try {
    response = await resolveNativeFetch(deps)(path, {
      ...init,
      cache: 'no-store',
      // 同源本地端口，不带 cookie：别让 WebView 的 cookie 策略把这次请求拖住
      credentials: 'omit',
    })
  } catch (error) {
    throw new RemoteApiError(
      'NATIVE_BRIDGE_UNAVAILABLE',
      '连不上 App 的原生登录桥（/__ds_auth/*），请确认壳进程在运行；浏览器里无法直接打开授权页',
      undefined,
      true,
      { path, cause: messageOf(error) },
    )
  }

  let text = ''
  try {
    text = await response.text()
  } catch (error) {
    throw new RemoteApiError('NATIVE_BRIDGE_UNAVAILABLE', `读取原生登录桥响应失败：${path}`, undefined, true, {
      path,
      cause: messageOf(error),
    })
  }

  let body: unknown
  if (text.length > 0) {
    try {
      body = JSON.parse(text)
    } catch {
      // 可能是 SPA 的 index.html：交给调用方按「非壳环境」处理
      body = undefined
    }
  }
  return { status: response.status, text, body }
}

/** 非壳环境判定：404 就是「这个页面不在 App 里」 */
const isMissingEndpoint = (response: NativeResponse): boolean => response.status === 404

const unavailableError = (path: string): RemoteApiError =>
  new RemoteApiError(
    'OAUTH_UNAVAILABLE',
    `OAuth 登录只能在 App 内使用（当前环境没有原生登录桥：${path} 不可用）`,
    undefined,
    false,
    { path },
  )

/**
 * 壳的 UA 标记（与 `services/api/transport.ts` 同值）。
 *
 * 用来区分两种 404：
 *   - 在壳里却 404 → **旧版 APK**（`/__ds_auth/*` 还没实现），提示「请更新 App」；
 *   - 不在壳里 → 「只能在 App 内使用」。
 */
const SHELL_UA_MARK = 'DeepSeekTablet/'

const isShellLikely = (): boolean => {
  if (typeof window === 'undefined') return false
  const bridge = (window as { __DS_NATIVE__?: unknown }).__DS_NATIVE__
  if (bridge !== undefined && bridge !== null) return true
  return typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string' && navigator.userAgent.includes(SHELL_UA_MARK)
}

const bridgeUpdateRequired = (path: string): RemoteApiError =>
  new RemoteApiError(
    'OAUTH_BRIDGE_UPDATE_REQUIRED',
    `当前 App 版本不支持应用内授权登录（原生登录桥缺少 ${path}），请更新 App 后再试`,
    undefined,
    false,
    { path },
  )

/** 原生桥的 `{ok:false,error:"<code>"}` → 可读中文（码本身留在 details 里，便于排障） */
const NATIVE_ERROR_TEXT: Record<string, string> = {
  https_required: '授权页地址必须是 https（原生容器已拒绝）',
  cross_origin_rejected: '授权页与服务器不是同一个源（原生容器已拒绝）',
  host_not_allowed: '原生容器不允许打开这个主机',
  private_host_rejected: '原生容器拒绝回环 / 内网地址：打开授权页时必须带上服务器地址（serverUrl）',
  json_content_type_required: '原生登录桥要求 application/json（页面内部错误）',
  url_required: '缺少授权页地址',
  url_too_long: '授权页地址过长',
  url_bad_char: '授权页地址含非法字符',
  url_invalid: '授权页地址不合法',
  userinfo_not_allowed: '授权页地址里不能带用户名密码',
  host_required: '授权页地址缺少主机',
  server_url_bad_char: '服务器地址含非法字符',
  server_url_invalid: '服务器地址不合法',
  server_url_https_required: '服务器地址必须是 https',
  invalid_json: '原生登录桥收到的请求体不是 JSON（页面内部错误）',
  payload_too_large: '请求体过大',
  no_foreground_activity: 'App 不在前台，无法打开登录页：请回到 App 再重试',
  no_browser: '这台设备上没有可用的浏览器',
  open_external_failed: '打不开系统浏览器',
  ui_timeout: '登录页打开超时，请重试',
  not_found: 'App 版本过旧：原生登录桥没有这个接口',
}

const nativeErrorDetail = (response: NativeResponse): string => {
  if (!isRecord(response.body) || typeof response.body.error !== 'string') return ''
  const code = response.body.error
  const text = NATIVE_ERROR_TEXT[code]
  return text === undefined ? `：${code}` : `：${text}（${code}）`
}

/** 原生回的错误码（`{ok:false,error:"no_browser"}` 里的那个），不是的话给空串 */
const nativeErrorCode = (response: NativeResponse): string =>
  isRecord(response.body) && typeof response.body.error === 'string' ? response.body.error : ''

/**
 * 原生响应判定。
 *
 * - 404：壳里 → `OAUTH_BRIDGE_UPDATE_REQUIRED`（旧 APK）；不在壳里 → `OAUTH_UNAVAILABLE`；
 * - 4xx/5xx：`NATIVE_BRIDGE_ERROR`，带上 `{ok:false,error}` 的中文解释（**码留在
 *   `details.nativeError`**：`no_browser` 要走「回退应用内 WebView」的分支）；
 * - 2xx + 非 JSON（静态托管的 `index.html` 回落）：按非壳环境处理 —— 绝不把 HTML 当「已打开」；
 * - 2xx + `{ok:false}`：`OAUTH_FAILED`。
 *
 * ⚠️ `open:false` 不是错误：`external`（系统浏览器）模式原生就是回 `open:false, launched:true`，
 * 这里**不看** `open`，只看 `ok` 与 HTTP 码。
 */
const assertNativePage = (response: NativeResponse, path: string): void => {
  if (isMissingEndpoint(response)) throw isShellLikely() ? bridgeUpdateRequired(path) : unavailableError(path)
  const detail = nativeErrorDetail(response)
  const nativeError = nativeErrorCode(response)
  if (response.status >= 500) {
    throw new RemoteApiError(
      'NATIVE_BRIDGE_ERROR',
      `App 原生登录桥返回 HTTP ${response.status}${detail}`,
      response.status,
      // `no_browser` 是确定性的（换台设备才会有浏览器），别让上层当成「过会儿重试就好」
      nativeError === 'no_browser' ? false : true,
      { path, nativeError },
    )
  }
  if (response.status >= 400) {
    throw new RemoteApiError(
      'NATIVE_BRIDGE_ERROR',
      `App 原生登录桥返回 HTTP ${response.status}${detail}`,
      response.status,
      false,
      { path, nativeError },
    )
  }
  if (response.body === undefined && response.text.trim().length > 0) {
    throw isShellLikely() ? bridgeUpdateRequired(path) : unavailableError(path)
  }
  if (isRecord(response.body) && response.body.ok === false) {
    throw new RemoteApiError('OAUTH_FAILED', `App 打不开授权页面${detail}`, undefined, false, {
      path,
      nativeError,
    })
  }
}

/* ── 原生授权页：open / close / state ─────────────────────────────────── */

/** 授权页打开方式（原生契约）：`external` = 系统浏览器（默认），`inline` = 应用内全屏 WebView */
export type AuthPageMode = 'inline' | 'external'

/*
 * 为什么现在默认 `external`：`google` 这类 provider 的登录页**拒绝 WebView**
 * （`disallowed_useragent`，见 `input-J6-登录方式调研.md` §6.2 / dsh-Go
 * `hosts_state.dart:509-510`），而应用内 WebView 还多一个真机坑 —— 用户在授权页里操作时
 * App 进程被系统回收，回来登录状态全丢。系统浏览器同时解掉这两个问题，代价是原生拿不到
 * 「授权页已关闭」这个信号（`/__ds_auth/state` 的 `open` 恒 false，**不能**据此判取消）。
 */

export interface OpenAuthPageInput {
  /** 授权页地址（必须是 https，且与 `serverUrl` 严格同源 —— 原生态也会再校验一次） */
  url: string
  /**
   * 目标服务器地址。**必传**：原生用它做严格同源校验；不传时原生退一步拒绝回环/内网地址，
   * 自建 / LAN 服务器会直接吃 `private_host_rejected`(403)。
   */
  serverUrl: string
  /** 窗口标题（原生截断到 48 字符） */
  title?: string
  /** `external`（默认，系统浏览器）/ `inline`（应用内 WebView） */
  mode?: AuthPageMode
  /** 额外允许的 host 名单（自建反代用；一般不用，原生态做白名单校验） */
  allowHost?: string
}

/**
 * 用原生容器打开授权页。
 *
 * 原生实现：`RemoteAuthHandler`（J7）。两种模式行为：
 *   - `external`（默认）：`Intent.ACTION_VIEW` 交给系统浏览器，响应 `{ok,open:false,mode,launched}`；
 *   - `inline`：应用内全屏 WebView + 标题栏与「关闭」按钮。
 *
 * 页面侧只做两件事：确保 `url` 是 https（原生对 http 直接 400 `https_required`），
 * 以及把 `serverUrl` 一起带上（原生态的同源闸门）。
 *
 * `open:false` **不**等于失败：`assertNativePage` 只认 `ok:false` 与 4xx/5xx。
 */
export const openAuthPage = async (input: OpenAuthPageInput, deps: OAuthDeps = {}): Promise<void> => {
  const url = input.url.trim()
  if (!/^https:\/\//i.test(url)) {
    // 与原生一致：只收 https（自建调试也用 https 反代或本机证书；原生对 http 回 400）
    throw new RemoteApiError('INVALID_ARGUMENT', '授权页地址必须是 https（原生容器不接受 http）')
  }
  const serverUrl = input.serverUrl.trim()
  if (!/^https:\/\//i.test(serverUrl)) {
    throw new RemoteApiError('INVALID_ARGUMENT', '服务器地址必须是 https')
  }
  const response = await nativeRequest(deps, NATIVE_AUTH_OPEN_PATH, {
    method: 'POST',
    // CSRF 闸门：原生态要求声明 application/json，否则 415
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url,
      serverUrl,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.mode === undefined ? {} : { mode: input.mode }),
      ...(input.allowHost === undefined ? {} : { allowHost: input.allowHost }),
    }),
  })
  assertNativePage(response, NATIVE_AUTH_OPEN_PATH)
}

/**
 * 关掉授权页（best-effort：失败只返回 false，不抛 —— 收尾动作不该再失败一次）。
 *
 * 三种情况会用它：用户取消、轮询拿到 complete、等待超时。原生侧幂等。
 */
export const closeAuthPage = async (deps: OAuthDeps = {}): Promise<boolean> => {
  try {
    const response = await nativeRequest(deps, NATIVE_AUTH_CLOSE_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    return response.status < 400
  } catch {
    // 壳已经没了 / 本来就不在壳里：没什么可关的
    return false
  }
}

/** `GET /__ds_auth/state` 的结果（原生还会给 `lastRedirect`，页面只需要 `open`） */
export interface AuthPageState {
  open: boolean
  /** `inline` / `external`（原样透传，便于诊断） */
  mode?: string
  /** 原生记录的 `dshremote://…` 回跳（**不解析 token**，只给排障看） */
  lastRedirect?: string
}

/**
 * 授权页当前状态（诊断用）；非壳环境或旧 APK → `null`。
 *
 * ⚠️ **`open === false` 不代表用户取消了**：「用系统浏览器」（`mode:'external'`）时
 * 授权页根本不在壳的窗口栈里，原生只能恒回 `open:false`。判断登录是否成功**只看轮询结果**
 * （`complete` / `expired`），判断取消只看用户是否点了「取消登录」。
 *
 * 想区分「非壳」与「旧 APK」用 `probeAuthBridge()`。
 */
export const authPageState = async (deps: OAuthDeps = {}): Promise<AuthPageState | null> => {
  try {
    const response = await nativeRequest(deps, NATIVE_AUTH_STATE_PATH, { method: 'GET' })
    if (isMissingEndpoint(response) || !isRecord(response.body)) return null
    return {
      open: response.body.open === true,
      ...(typeof response.body.mode === 'string' ? { mode: response.body.mode } : {}),
      ...(typeof response.body.lastRedirect === 'string' && response.body.lastRedirect.length > 0
        ? { lastRedirect: response.body.lastRedirect }
        : {}),
    }
  } catch {
    return null
  }
}

/**
 * 原生登录桥能力探测：UI 用它决定「要不要显示第三方登录 / 提示更新 App」。
 *
 * | 结果 | 含义 | UI 建议 |
 * |---|---|---|
 * | `ready` | `/__ds_auth/state` 返回 JSON | 可显示「用 xx 登录」 |
 * | `missing` | 不在壳里 / 连不上 | 只显示邮箱密码 + 「只能在 App 内使用」提示 |
 * | `outdated` | 在壳里但端点 404 | 提示「请更新 App」（旧 APK 没有 `/__ds_auth/*`） |
 */
export type AuthBridgeStatus = 'ready' | 'missing' | 'outdated'

export const probeAuthBridge = async (deps: OAuthDeps = {}): Promise<AuthBridgeStatus> => {
  try {
    const response = await nativeRequest(deps, NATIVE_AUTH_STATE_PATH, { method: 'GET' })
    if (response.status === 404) return isShellLikely() ? 'outdated' : 'missing'
    if (response.status >= 400) return 'outdated'
    if (isRecord(response.body)) return 'ready'
    return isShellLikely() ? 'outdated' : 'missing'
  } catch {
    return 'missing'
  }
}

/* ── 建会话 / 轮询 / 收尾 ─────────────────────────────────────────────── */

export interface StartProviderLoginOptions {
  deps?: OAuthDeps
  /** 原生容器里授权页的标题（缺省「<provider> 登录」） */
  title?: string
  /** 登录前先探活（默认 **开启**：区分「连不上服务器」与「账号错」） */
  probeHealth?: boolean
  /**
   * 打开授权页的方式（`browser` 模式生效，原生态值）：
   *   `external`（**默认**）= 系统浏览器；`inline` = 应用内全屏 WebView（仅作为覆盖项保留）。
   * K2 起默认走系统浏览器：WebView 里第三方授权页会被 Google 之类拒绝，且回 App 时
   * 进程很容易被系统回收（登录状态随之丢光）。
   */
  authMode?: AuthPageMode
  /** 额外允许的 host（自建反代；一般不用） */
  allowHost?: string
}

/**
 * 原生容器默认用哪种方式打开授权页。
 *
 * `external` = 系统浏览器（K2 起默认）：原生侧返回 `{ok:true, open:false, mode:'external',
 * launched:true}`，**`open:false` 是正常现象**（见 `authPageState` 的注释）。
 *
 * 为什么显式传而不是「靠原生默认」：两台机器上的 APK 版本可能不一样（旧包默认 `inline`），
 * 显式传能让「页面说了算」；`mode` 只用原生认的两个值 —— `external`（别名 `browser` / `tab`）
 * 与 `inline`（别名 `webview`），别的值原生回 `400 bad_mode`。
 */
const defaultAuthMode = (): AuthPageMode => 'external'

/** 原生「这台设备没有可用浏览器」的错误码（`500 {ok:false,error:"no_browser",suggestInline:true}`） */
const NATIVE_NO_BROWSER = 'no_browser'

/** 这次失败是不是「系统浏览器打不开、但应用内 WebView 还能试一次」 */
const shouldFallbackToInline = (error: unknown): boolean =>
  isRemoteApiError(error) && error.details?.nativeError === NATIVE_NO_BROWSER

/**
 * 建一个 provider 登录会话。
 *
 * `browser` 模式会顺手让原生容器打开授权页（这一步失败就整体失败，非壳环境在这里报
 * 「只能在 App 内使用」，旧 APK 报「请更新 App」）；`qr` 模式只建会话，`scanUrl` 交给
 * UI 画二维码 —— 因此**普通浏览器里也能用扫码登录**（用另一台设备扫）。
 *
 * **顺序很关键**：会话建好就立刻落盘（`dsp.remote.pending-login.v1`），**然后**才打开
 * 授权页 —— 切到系统浏览器的那一瞬间 App 就进后台了，进程随时可能被系统杀掉；先开页后落盘
 * 等于把「最容易出事的窗口」留在了没有持久化的时候。
 *
 * 系统浏览器打不开（原生 `no_browser`）时**自动回退应用内 WebView 重试一次**，并在返回值
 * 的 `notice` 里带上「已改用应用内登录」——不吞掉这个降级，用户要知道授权页在哪。
 */
export const startProviderLogin = async (
  serverUrl: string,
  provider: OAuthProvider,
  mode: ProviderLoginMode = 'browser',
  options: StartProviderLoginOptions = {},
): Promise<ProviderLoginSession> => {
  const base = normalizeServerUrl(serverUrl)
  const deps = options.deps ?? {}
  const apiDeps = deps.api ?? {}

  if (mode === 'qr' && provider.qrStartUrl === undefined) {
    throw new RemoteApiError('QR_UNSUPPORTED', `「${provider.displayName}」不支持扫码登录，请改用浏览器登录`)
  }
  // 探活：连不上服务器时别让用户以为是「授权页打不开」
  if (options.probeHealth !== false) await health({ url: base }, apiDeps)

  const session = await startOAuthQrLogin({ url: base }, provider, apiDeps)
  const startedAt = Date.now()
  const expiresAt = startedAt + qrExpiryMs(session.expiresIn)
  const result: ProviderLoginSession = {
    providerId: provider.id,
    mode,
    qrId: session.qrId,
    scanUrl: session.scanUrl,
    expiresAt,
  }

  // 先落盘（App 下一秒就可能被杀）；老记录被直接覆盖 —— 同一台设备只续最后一次登录
  writePendingLogin(pendingLoginRecordOf(base, result, startedAt))

  if (mode === 'browser') {
    // 授权页没打开就没什么可轮询的：把失败抛给 UI，并且**别留**一个永远等不到的会话
    // （服务器侧会自己过期，不需要额外的 cancel 端点）
    const request = { url: session.scanUrl, title: options.title ?? `${provider.displayName} 登录` }
    // 原生态用它做严格同源校验：不传的话自建 / LAN 服务器会吃 private_host_rejected(403)
    const authMode = options.authMode ?? defaultAuthMode()
    try {
      await openAuthPage(
        {
          ...request,
          serverUrl: base,
          mode: authMode,
          ...(options.allowHost === undefined ? {} : { allowHost: options.allowHost }),
        },
        deps,
      )
    } catch (error) {
      if (authMode === 'external' && shouldFallbackToInline(error)) {
        // 这台设备没装浏览器（或系统不认这个 Intent）：退回应用内 WebView 再试一次。
        // 反过来说，`inline` 失败就是真失败，不再回退。
        try {
          await openAuthPage(
            { ...request, serverUrl: base, mode: 'inline', ...(options.allowHost === undefined ? {} : { allowHost: options.allowHost }) },
            deps,
          )
          result.notice = '本机没有可用浏览器，已改用应用内登录'
          result.authMode = 'inline'
        } catch (fallbackError) {
          clearPendingLoginIf(session.qrId)
          throw fallbackError
        }
      } else {
        clearPendingLoginIf(session.qrId)
        throw error
      }
    }
  }

  return result
}

/**
 * 扫一次（单拍）：UI 自己排 2s 节奏时用这个。
 *
 * 本地判过期优先于网络：二维码/链接已经过期就没必要再问服务器（服务器也会回 expired，
 * 但少一次请求就少一次被限流的机会）。
 */
export const pollProviderLogin = async (
  serverUrl: string,
  qrId: string,
  options: QrPollOptions = {},
): Promise<OAuthQrPollResult> => {
  if (options.expiresAt !== undefined && Date.now() >= options.expiresAt) return { status: 'expired' }
  return pollOAuthQrLogin({ url: normalizeServerUrl(serverUrl) }, qrId, options.deps?.api ?? {})
}

/**
 * 一直轮到出结果：`complete` 返回账号 token，`expired` 抛 `QR_EXPIRED`，超时抛 `QR_TIMEOUT`。
 *
 * 瞬时错误（网络 / 超时这类 `retryable`）最多连着放 `MAX_POLL_FAILURES` 次；
 * 404 之类的确定性错误立刻抛 —— 服务器不认识这个 qrId，重试没有意义。
 */
export const waitForProviderLogin = async (
  serverUrl: string,
  qrId: string,
  options: WaitProviderLoginOptions = {},
): Promise<string> => {
  const intervalMs = Math.max(options.intervalMs ?? DEFAULT_PROVIDER_POLL_INTERVAL_MS, 1)
  const timeoutMs = Math.max(options.timeoutMs ?? DEFAULT_PROVIDER_LOGIN_TIMEOUT_MS, 1)
  const startedAt = Date.now()
  const deadline = Math.min(startedAt + timeoutMs, options.expiresAt ?? Number.POSITIVE_INFINITY)
  let failures = 0

  for (;;) {
    if (options.signal?.aborted === true) throw new RemoteApiError('OAUTH_ABORTED', '登录已取消')

    let result: OAuthQrPollResult | undefined
    try {
      result = await pollProviderLogin(serverUrl, qrId, options)
      failures = 0
    } catch (error) {
      const transient = isRemoteApiError(error) && error.retryable === true
      if (!transient || failures >= MAX_POLL_FAILURES) throw error
      failures += 1
    }

    if (result !== undefined) {
      if (result.status === 'complete') return result.token
      if (result.status === 'expired') {
        throw new RemoteApiError('QR_EXPIRED', '登录已过期，请重新发起登录', undefined, false)
      }
    }

    const now = Date.now()
    if (now >= deadline) {
      throw new RemoteApiError(
        'QR_TIMEOUT',
        `等待授权超时（${Math.round(timeoutMs / 1000)} 秒），请重新发起登录`,
        undefined,
        true,
      )
    }
    options.onPending?.(now - startedAt)
    await sleep(Math.min(intervalMs, deadline - now), options.signal)
  }
}

/* ── 账号 token → 设备（两种入口共用） ───────────────────────────────── */

/**
 * 账号 token → `accountMe` → 注册设备。
 *
 * 为什么要先 `accountMe`：注册设备只需要 token，但界面要用账号名做记录主键
 * （同服务器 + 同账号算一条），并且**先验证 token 可用**才能给出可读错误
 * （401 在 `accountMe` 上比在 `devices/register` 上更容易解释）。
 *
 * 返回的是**尚未落盘**的结果；持久化请走 `connection.loginWithAccountToken()`。
 */
export const completeProviderLogin = async (
  serverUrl: string,
  accountToken: string,
  options: DeviceSignInOptions = {},
): Promise<OAuthSignInResult> => {
  const base = normalizeServerUrl(serverUrl)
  const token = accountToken.trim()
  if (token.length < MIN_ACCOUNT_TOKEN_LENGTH) {
    throw new RemoteApiError('INVALID_ARGUMENT', '登录拿到的账号 token 无效（太短）')
  }
  const apiDeps = options.deps?.api ?? {}
  const profile = await accountMe({ url: base }, token, apiDeps)
  const identity = options.identity ?? loadOrCreateIdentity()
  const descriptor: AccountDeviceDescriptor = deviceDescriptor(
    'client',
    options.deviceName,
    options.platform ?? DEFAULT_PLATFORM,
    identity,
  )
  const tokens = await registerDevice({ url: base }, token, descriptor, apiDeps)
  return { account: profile.account, deviceId: descriptor.deviceId, tokens }
}

/** `completeProviderLogin` 的别名：任务书里 `signInWithQrToken` 的语义（token 只能领一次）。 */
export const signInWithQrToken = completeProviderLogin

/**
 * 「点一下等结果」的便捷封装：建会话 →（浏览器模式打开授权页）→ 等结果 → 关授权页 → 换设备。
 *
 * UI 需要显示二维码 / 进度 / 取消按钮时**不要用这个**，用
 * `startProviderLogin` + `pollProviderLogin`（或 `waitForProviderLogin`）三步，
 * 好让用户看到「等待授权」「二维码过期，刷新」这些中间态。
 */
export const signInWithProvider = async (
  serverUrl: string,
  provider: OAuthProvider,
  mode: ProviderLoginMode = 'browser',
  options: StartProviderLoginOptions & WaitProviderLoginOptions & DeviceSignInOptions = {},
): Promise<OAuthSignInResult> => {
  const session = await startProviderLogin(serverUrl, provider, mode, options)
  try {
    const token = await waitForProviderLogin(serverUrl, session.qrId, {
      ...(options.deps === undefined ? {} : { deps: options.deps }),
      expiresAt: session.expiresAt,
      ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onPending === undefined ? {} : { onPending: options.onPending }),
    })
    return await completeProviderLogin(serverUrl, token, options)
  } finally {
    // 一步到位地登完了：别把待完成会话留在盘上（否则下次启动会去续一个已经完成的 qrId）
    clearPendingLoginIf(session.qrId)
    if (mode === 'browser') await closeAuthPage(options.deps)
  }
}

/* ── 会话可恢复：resumePendingLogin（K2） ─────────────────────────────── */

/**
 * 轮询失败的三种性质（K2 的硬要求：瞬断继续、401/404 终止、其余终止）。
 *
 * | 类别 | 判据 | 处置 |
 * |---|---|---|
 * | `transient` | 没有 HTTP 状态且 `retryable`（`NETWORK_ERROR` / `TIMEOUT`）、5xx、429 | 会话还在，继续轮（连败超 `MAX_POLL_FAILURES` 才放弃） |
 * | `stale` | 401 / 404 / 410 | 服务器不认识这个 qrId（或它已作废），重试没有意义 → 终止并清理 |
 * | `fatal` | 其余确定性错误（参数 / 协议 / 被取消） | 终止并清理 |
 */
type PollFailureKind = 'transient' | 'stale' | 'fatal'

const classifyPollFailure = (error: unknown): PollFailureKind => {
  if (!isRemoteApiError(error)) return 'fatal'
  if (error.code === 'OAUTH_ABORTED') return 'fatal'
  const status = error.status
  if (status === 401 || status === 404 || status === 410) return 'stale'
  if (status === undefined) return error.retryable ? 'transient' : 'fatal'
  if (status === 429) return 'transient'
  if (status >= 500) return error.retryable ? 'transient' : 'fatal'
  return 'fatal'
}

/** 轮询失败的归类文案（UI 能直接显示的那种） */
const describeResumeFailure = (error: unknown, kind: PollFailureKind): string => {
  if (kind === 'transient') return `网络不稳定，重试 ${MAX_POLL_FAILURES} 次仍失败：${messageOf(error)}`
  if (kind === 'stale') return '这次登录会话已经失效（服务器不再认识它），请重新发起登录'
  return `续接登录失败：${messageOf(error)}`
}

/** 默认落地：`/auth/me` → `devices/register` → 账号落盘（**不建链**，建链是 store 的事） */
const persistProviderLogin = async (
  record: PendingLoginRecord,
  token: string,
  deps: OAuthDeps,
): Promise<OAuthSignInResult> => {
  const result = await completeProviderLogin(record.serverUrl, token, { deps })
  // 与 `connection.loginWithAccountToken()` 同键同字段（scope=device + loginMethod），
  // 只是这里没有 `RemoteClient`：恢复流程的目标是「账号先拿到手」，连接由上层决定。
  upsertAccount({
    email: result.account,
    accessToken: result.tokens.accessToken,
    refreshToken: result.tokens.refreshToken,
    deviceId: result.deviceId,
    scope: 'device',
    serverUrl: record.serverUrl,
    loginMethod: record.mode === 'qr' ? 'qr' : 'oauth',
    accessTokenExpiresAt: result.tokens.accessTokenExpiresAt,
    refreshTokenExpiresAt: result.tokens.refreshTokenExpiresAt,
  })
  return result
}

/** 单飞：并发调用只跑一个轮询（后到者拿同一个 Promise） */
let resumeInFlight: Promise<ResumeLoginResult> | null = null

/**
 * abort 判定。
 *
 * 单独抽成函数而不是内联 `signal?.aborted === true`：TS 会把上一次比较的结果窄化进后面的
 * 分支（`false | undefined`），循环里再比一次就被判成「不可能成立」—— 而 abort 是异步发生的，
 * 恰恰会变。
 */
const signalAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true

/**
 * 续上一次没完成的登录（App 重启 / 从浏览器切回前台时调用）。
 *
 * 幂等 + 并发安全：实现了「只允许一个轮询在飞」—— 因为 `complete` 的账号 token
 * **只能领一次**，两个轮询同时打到服务器会让后到者拿到「complete 但没有 token」，
 * 反而把一次成功的登录判成失败。
 *
 * 终态都会**清理持久化**（除非期间已经有一次新的登录写了新 qrId）：
 *   - `complete`：`onComplete`/默认落地成功 → 删键；
 *   - `expired` / `timeout` / `cancelled` / `failed`：删键并返回原因。
 *
 * 网络瞬断不算失败：会话在服务端活得好好的，继续轮就是了（`MAX_POLL_FAILURES` 次连败才放弃）。
 */
export const resumePendingLogin = (options: ResumePendingLoginOptions = {}): Promise<ResumeLoginResult> => {
  if (resumeInFlight !== null) return resumeInFlight
  const task = runResumePendingLogin(options).finally(() => {
    resumeInFlight = null
  })
  resumeInFlight = task
  return task
}

/** 测试 / 诊断用：当前是否有恢复流程在跑（不暴露内部 Promise） */
export const isResumingPendingLogin = (): boolean => resumeInFlight !== null

const runResumePendingLogin = async (options: ResumePendingLoginOptions): Promise<ResumeLoginResult> => {
  const deps = options.deps ?? {}
  const now = options.now ?? Date.now
  const record = readPendingLogin()
  if (record === null) return { status: 'none' }

  /** 收尾：清键（只清自己这一条）+ 带上原因返回 */
  const finish = (result: ResumeLoginResult): ResumeLoginResult => {
    clearPendingLoginIf(record.qrId)
    return result
  }

  if (now() >= record.expiresAt) {
    return finish({
      status: 'expired',
      record,
      code: 'QR_EXPIRED',
      message: '这次登录已经过期（服务端会话失效），请重新发起登录',
    })
  }

  const intervalMs = Math.max(options.intervalMs ?? DEFAULT_PROVIDER_POLL_INTERVAL_MS, 1)
  const timeoutMs = Math.max(options.timeoutMs ?? DEFAULT_PROVIDER_LOGIN_TIMEOUT_MS, 1)
  const startedAt = now()
  // 预算从**本次恢复**算起：App 被杀了半小时不该算成「我们等了半小时」
  const deadline = Math.min(startedAt + timeoutMs, record.expiresAt)
  const complete = options.complete ?? ((input) => persistProviderLogin(input.record, input.token, deps))

  let failures = 0
  for (;;) {
    if (signalAborted(options.signal)) {
      return finish({ status: 'cancelled', record, code: 'OAUTH_ABORTED', message: '登录已取消' })
    }

    let polled: OAuthQrPollResult | undefined
    try {
      polled = await pollProviderLogin(record.serverUrl, record.qrId, { deps, expiresAt: record.expiresAt })
      failures = 0
    } catch (error) {
      const kind = classifyPollFailure(error)
      if (kind === 'transient' && failures < MAX_POLL_FAILURES) {
        // 网络瞬断：会话（和盘上的记录）原样保留，接着轮
        failures += 1
      } else {
        const aborted = signalAborted(options.signal)
        return finish({
          status: aborted ? 'cancelled' : 'failed',
          record,
          code: isRemoteApiError(error) ? error.code : 'OAUTH_FAILED',
          message: aborted ? '登录已取消' : describeResumeFailure(error, kind),
        })
      }
    }

    if (polled !== undefined) {
      if (polled.status === 'complete') {
        try {
          const done = await complete({ record, token: polled.token })
          return finish({
            status: 'complete',
            record,
            ...(done === undefined ? {} : { result: done }),
          })
        } catch (error) {
          // 账号 token 已经用掉了，重试同一个 qrId 拿不到第二个：只能让用户重来
          return finish({
            status: 'failed',
            record,
            code: isRemoteApiError(error) ? error.code : 'OAUTH_FAILED',
            message: `授权已完成，但换取设备凭据失败：${messageOf(error)}`,
          })
        }
      }
      if (polled.status === 'expired') {
        return finish({
          status: 'expired',
          record,
          code: 'QR_EXPIRED',
          message: '这次登录已经过期（服务端会话失效），请重新发起登录',
        })
      }
    }

    const stamp = now()
    if (stamp >= deadline) {
      return finish({
        status: 'timeout',
        record,
        code: 'QR_TIMEOUT',
        message: `等待授权超时（${Math.round(timeoutMs / 1000)} 秒），请重新发起登录`,
      })
    }
    options.onPending?.(stamp - startedAt)
    try {
      await sleep(Math.min(intervalMs, deadline - stamp), options.signal)
    } catch {
      // `sleep` 只会因为 abort 抛
      return finish({ status: 'cancelled', record, code: 'OAUTH_ABORTED', message: '登录已取消' })
    }
  }
}

/* ── 诊断 ─────────────────────────────────────────────────────────────── */

/**
 * 只允许打日志的摘要（**不含 token**）：UI 的登录状态栏 / 排障用。
 * 例如 `provider|browser|zhihu|https://dsh.r2049.cn`。
 */
export const describeProviderLogin = (
  mode: ProviderLoginMode,
  providerId: string,
  serverUrl: string,
): string => `provider|${mode}|${providerId}|${normalizeServerUrl(serverUrl)}`
