/**
 * 远端 DSH 的 **zustand 单例数据层**（Chat Pad「远程 DSH」U2 的 UI 直接消费这一层）。
 *
 * ```
 *  UI (U2)  ──►  useRemoteStore  ──►  sessionsApi.ts  ──►  harness.remote.call / stream.open
 *                     │                                        ▲
 *                     └──────────►  adapter.ts  ◄──  core/ (Noise + RPC + 流)  ◄── 原生桥
 *                                  （线格式 → ChatItem）
 * ```
 *
 * ## 这个文件负责什么
 *
 * 1. **连接编排**：`connect(serverUrl,email,password)` = REST 登录 → 注册设备 → 列 Host
 *    → `createSecureLink()` → `RemoteClient.connect()`（内部就是 `harness.transport.describe`）
 *    → 打开 `$events` 并等 `ready`（拿 `clientId`，审批要用）→ 拉会话列表。
 * 2. **三个会话动作**：`refreshSessions()` / `openSession(id)` / `loadOlder()`。
 * 3. **聊天动作**：`send(text)`（乐观上屏 + `session/prompt`）/ `cancel()` / `respondApproval()`。
 * 4. **把每一帧归约成 `items: ChatItem[]`**（真正干活的是 `adapter.ts`）。
 *
 * ## 三条纪律
 *
 * - **不持久化**：远程会话不落 SQLite / IndexedDB / localStorage（方案 §4.3-②），
 *   连上就有、断开就没了。账号 token 是 S3 的 `storage.ts` 的事，这里不碰。
 * - **不吞错、也不乱抛**：所有 action 都在内部 `catch`，把可读错误写进 `state.error`
 *   （`{code, message}`，`code` 是机器码、`message` 是中文），需要文案键时用
 *   `describeRemoteError()`。UI 用 `fireAndForget(() => store.getState().x())` 调用不会炸。
 * - **单例**：同一页面只有一个活动连接（模块级 `active`）。`connect()` 会先拆掉旧的。
 *
 * ## 与契约的偏差（都在 `input-J4-远程数据层.md` 里列了）
 *
 * - `RemoteState` 的形状与契约**逐字段一致**；
 * - `hasMore` / `loadingOlder` 没塞进契约接口，另开一个极小的 `useRemotePaging`
 *   （U2 想显示「加载更早」的可用状态时用它，不用也不影响）；
 * - `transport` 恒为 `'relay'`：P0 只用控制通道 Relay（`core/index.ts` 的 `SecureLink.transport`）。
 */

import { create } from 'zustand'

import {
  buildLinkOptions,
  createRemoteClient,
  type RemoteAccount,
  type RemoteClient,
  type RemoteHost,
  type RemoteServer,
} from './connection.js'
import { createSecureLink, type SecureLink, type StreamEventPayload } from './core/index.js'
import {
  requestBatteryExemption as requestBatteryExemptionApi,
  stopKeepAlive,
  syncKeepAlive,
  unsupportedKeepAlive,
  type KeepAliveSnapshot,
} from './keepAlive.js'
import {
  clearPendingLogin,
  closeAuthPage,
  pollProviderLogin as pollProviderLoginApi,
  readPendingLogin,
  resumePendingLogin as resumePendingLoginApi,
  startProviderLogin as startProviderLoginApi,
} from './oauth.js'
import {
  RemoteApiError,
  isRemoteApiError,
  normalizeServerUrl,
  oauthProviders as oauthProvidersApi,
  type OAuthProvider,
} from './serverApi.js'
import { loadServers } from './storage.js'
import {
  DEFAULT_HISTORY_PAGE_SIZE,
  cancelSession,
  describeRemoteError,
  listSessions,
  newRequestId,
  openEvents,
  openFollow,
  pageHistory,
  parseSessionRow,
  respondApproval as respondApprovalApi,
  sendPrompt,
  type ApprovalDecision,
  type RemotePromptAttachment,
  type RemoteSessionRow,
  type RemoteStreamHandle,
} from './sessionsApi.js'
import {
  addOptimisticUserMessage,
  createTranscriptState,
  eventClientIdOf,
  foldHistory,
  forwardedSessionEvent,
  hasVisibleMessageText,
  historyEntriesFromRecords,
  markSendState,
  oldestSeqOfItems,
  parseSnapshot,
  pendingApprovals as pendingApprovalsOf,
  prependHistory,
  reduceEventsItem,
  reduceFollowItem,
  reduceSnapshot,
  resolveApprovalItem,
  runningForFollowItem,
  type ChatItem,
  type ForwardedSessionEvent,
  type RemoteTranscriptState,
} from './adapter.js'

/** 把 adapter 的 `ChatItem` 家族转出去：U2 渲染消息时只需要 import 这一个入口。 */
export type {
  ApprovalActivity,
  AskUserQuestionItem,
  AskUserQuestionOption,
  ChatImage,
  ChatItem,
  ChatMessage,
  QuestionActivity,
  ToolActivity,
  ToolDisplayDetail,
} from './adapter.js'
export { describeRemoteError, remoteErrorText } from './sessionsApi.js'
export type { RemoteErrorInfo, RemotePromptAttachment } from './sessionsApi.js'
/** 原生登录桥能力探测（UI 决定「显示第三方登录」还是「提示更新 App」时用；也可直接 import `oauth.js`） */
export { probeAuthBridge } from './oauth.js'
export type { AuthBridgeStatus, AuthPageState } from './oauth.js'

/* ────────────────────────────────────────────────────────────────────────
 * 一、契约形状（U2 按这个写 UI，别改字段名）
 * ──────────────────────────────────────────────────────────────────────── */

/** 会话列表的一行（远端权威数据的精简投影）。 */
export interface RemoteSessionSummary {
  id: string
  title: string
  workspaceId?: string
  updatedAt?: number
  pinned?: boolean
}

/**
 * [契约之外的附加] 一种登录方式（UI 拿来渲染「用 xx 登录」按钮）。
 *
 * 只保留 UI 需要的三项：`id` 回传给 `startProviderLogin`，
 * `canQr` 决定要不要显示扫码入口（服务器没给 `qrStartUrl` 就扫不了）。
 */
export interface RemoteOAuthProviderSummary {
  id: string
  displayName: string
  canQr: boolean
}

/**
 * [契约之外的附加] 当前登录会话（浏览器授权 / 扫码共用同一份）。
 *
 * 两种入口都是「服务端建一个 QR 会话 → 本机轮询 → complete 时领一次性 token」，
 * 区别只在 `mode`：`browser` 把 `scanUrl` 交给原生容器打开（K2 起默认**系统浏览器**），
 * `qr` 把它画成二维码。
 *
 * `status` 由数据层推进：`pending` → `complete` / `expired` / `cancelled` / `error`。
 * `expiresAt` 是**本地**算的（服务器仍是权威），可以用来画倒计时。
 */
export interface RemoteProviderLoginState {
  providerId: string
  mode: 'browser' | 'qr'
  qrId: string
  /** 授权页地址，同时也是二维码内容（服务器给的 `scanUrl`，已过同源校验） */
  scanUrl: string
  expiresAt: number
  status: 'pending' | 'complete' | 'expired' | 'cancelled' | 'error'
}

/**
 * [契约之外的附加] 「有一次登录还没完成」的跨进程视图（= `dsp.remote.pending-login.v1` 的摘要）。
 *
 * **它不代表连接**，只代表「用户去浏览器里授权了，我们还在等他回来」。进程被杀再启动时
 * 由 `resumeLogin()` 从 localStorage 恢复出来，所以 UI 只要看到非 null 就可以直接渲染
 * 「等待授权…（剩余 mm:ss）」——用 `expiresAt` 自己算倒计时。
 */
export interface RemotePendingLogin {
  providerId: string
  mode: 'browser' | 'qr'
  /** 会话过期时刻（本地时钟；服务器仍是权威） */
  expiresAt: number
}

export interface RemoteState {
  /**
   * `waiting-auth` 是 K2 新增的：用户在系统浏览器里授权，本机**没有连接**，只是在轮询
   * `/api/v1/auth/oauth/qr/{qrId}`。它与 `authing`（正在换 token / 注册设备）的区别在于
   * 用户什么都做不了，只能等或取消 —— UI 据此显示倒计时而不是「正在连接」。
   */
  phase: 'idle' | 'authing' | 'connecting' | 'ready' | 'error' | 'waiting-auth'
  capabilities: string[]
  transport: 'relay' | 'lan' | 'p2p' | 'turn' | null
  error: { code: string; message: string } | null
  sessions: RemoteSessionSummary[]
  activeSessionId: string | null
  items: ChatItem[]
  streaming: boolean
  pendingApprovals: { eventId: string; title: string; detail?: string }[]
  connect(serverUrl: string, email: string, password: string): Promise<void>
  disconnect(): void
  refreshSessions(): Promise<void>
  openSession(id: string): Promise<void>
  loadOlder(): Promise<void>
  send(text: string): Promise<void>
  cancel(): Promise<void>
  respondApproval(eventId: string, decision: 'allow_once' | 'deny'): Promise<void>

  /* ── [多方式登录] 契约之外的附加字段与动作 ───────────────────────────
   * `connect()` 保持原样（邮箱密码 → 连接）；下面这组是另外两种入口。
   * 三者最终都汇到同一条建链路径（establishSession），所以 UI 只需要盯 `phase`。 */

  /** 这台服务器支持哪些登录方式（`loadOAuthProviders()` 拉取；空数组 = 只开邮箱密码） */
  oauthProviders: RemoteOAuthProviderSummary[]
  /** 当前登录会话（`null` = 没在登录）；浏览器授权与扫码共用 */
  qr: RemoteProviderLoginState | null
  /** 待完成登录（跨进程可恢复；`null` = 没有）。UI 据此渲染「等待授权…（剩余 mm:ss）」 */
  pendingLogin: RemotePendingLogin | null
  /**
   * 原生保活服务状态（K1）。`null` = 还没探测过；`supported:false` = 这个环境没有这套端点
   * （普通浏览器 / 旧 APK）。UI 用它提示「通知权限没给」「没豁免电池优化」。
   */
  keepAlive: KeepAliveSnapshot | null
  /** 拉一次登录方式列表；不传 serverUrl 时用最近用过的服务器 */
  loadOAuthProviders(serverUrl?: string): Promise<void>
  /** 邮箱密码登录 + 连接（与 `connect()` 完全同一条路径，serverUrl 缺省取最近用过的） */
  loginWithPassword(email: string, password: string, serverUrl?: string): Promise<void>
  /**
   * 发起 provider 登录：`POST {qrStartUrl}` 建会话 →
   *   `browser`：原生容器用**系统浏览器**打开 `scanUrl`
   *   `qr`：什么都不打开，`qr.scanUrl` 交给 UI 画二维码
   * 之后由 UI 每 2s 调一次 `pollProviderLogin()`。
   */
  startProviderLogin(providerId: string, mode: 'browser' | 'qr', serverUrl?: string): Promise<void>
  /** 登录轮询（单拍）：`pending` 不动；`complete` 自动换设备账号并建链；超时/过期望 UI 重开 */
  pollProviderLogin(): Promise<void>
  /**
   * 续上一次没完成的登录（App 启动 / 从浏览器切回前台时调用）。
   *
   * 幂等 + 并发安全：读 `dsp.remote.pending-login.v1`，没过期就继续轮询；`complete` 时
   * 自动落账号 + 注册设备 + 建链。没有待完成会话时什么都不做（不会弹错误）。
   */
  resumeLogin(): Promise<void>
  /**
   * 回到前台（`visibilitychange → visible`）时的一次性补齐：
   *   ① `resumeLogin()`；② 立刻补一拍登录轮询（后台定时器被系统节流，别等 2s）；
   *   ③ 保活服务自检（系统可能在后台杀掉它，`shouldRun && !running` 就补一次 start）。
   * 三件事都幂等 + 静默，重复触发不会多发请求，也不会抛。
   */
  onAppForeground(): Promise<void>
  /** 重新探测原生保活状态（需要时顺手拉起来）；失败静默 —— 保活不该影响连接 */
  refreshKeepAlive(): Promise<void>
  /**
   * 拉起「忽略电池优化」授权页。
   * ⚠️ **只能在用户点击里调**（Android 10+ 禁止后台弹 Activity）。
   */
  requestBatteryExemption(): Promise<void>
  /** 取消登录：停轮询、清持久化、关授权页，会话标成 `cancelled` */
  cancelProviderLogin(): Promise<void>
}

/**
 * [契约之外的附加] 上翻分页的可用状态。
 *
 * 契约里的 `RemoteState` 没有 `hasMore`，但 UI 需要知道「还有没有更早的历史」才能
 * 决定要不要显示「加载更早」。独立成第二个小 store，避免动契约接口。
 */
export interface RemotePagingState {
  /** `session/follow` 快照 / `session/page` 说的「还有更早的」。 */
  hasMore: boolean
  /** 正在上翻（UI 用来禁用按钮、避免重复请求）。 */
  loadingOlder: boolean
}

export const useRemotePaging = create<RemotePagingState>(() => ({ hasMore: false, loadingOlder: false }))

/* ────────────────────────────────────────────────────────────────────────
 * 二、内部上下文（不进 zustand：连接句柄与游标不该触发重渲染）
 * ──────────────────────────────────────────────────────────────────────── */

/** 一条流的消费端：`core/rpcMux.ts` 只有 link 级回调，所以按 streamId 自己分发。 */
interface StreamSink {
  onValue(value: unknown): void
  onClosed(reason: string, failure?: { code?: string; message?: string }): void
}

interface ActiveSession {
  client: RemoteClient
  server: RemoteServer
  account: RemoteAccount
  host: RemoteHost
  link: SecureLink
  capabilities: string[]
  /** 当前打开的会话 id（`null` = 还没开会话）。 */
  sessionId: string | null
  transcript: RemoteTranscriptState
  hasMore: boolean
  follow: RemoteStreamHandle | null
  events: RemoteStreamHandle | null
  /** `$events` 的 `ready.clientId`（应答审批必须带）。 */
  eventClientId: string | null
  sinks: Map<string, StreamSink>
  /** 句柄还没拿到、帧先到了的流：按 streamId 缓冲，注册 sink 时再倒出来。 */
  unrouted: Map<string, StreamEventPayload[]>
  /** 收尾标记：`link.onState('closed')` 不能把主动断开报成错误。 */
  closing: boolean
}

/** 唯一的活动连接。 */
let active: ActiveSession | null = null

/* ── 多方式登录的模块级上下文（不进 zustand：不是渲染数据） ───────────── */

/** 上一次拉到的登录方式（含 `startUrl` / `qrStartUrl`，这两项只在本模块用） */
let providerCache: { serverUrl: string; items: OAuthProvider[] } | null = null
/** 当前登录会话属于哪台服务器（qrId 只在那台 baseUrl 上有效，换服务器必须重新建） */
let loginServerUrl: string | null = null
/** 账号 token 只能领一次：拿到 `complete` 之后绝不允许再 poll（服务器不会再给第二个） */
let loginTokenClaimed = false

/**
 * 登录轮询的单拍互斥（Promise 而不是布尔：调用方可以等它落地）。
 *
 * 为什么必须是 Promise：`resumeLogin()` 在启动时可能正好撞上一次 UI 定时器发起的单拍，
 * 而 `complete` 的账号 token **只能领一次** —— 两个轮询同时在飞，后到者会拿到
 * 「complete 但没有 token」，把一次成功的登录判成失败。所以恢复流程要先等这一拍结束。
 */
let pollInFlight: Promise<void> | null = null
/** 恢复流程（`resumeLogin()`）：同一时刻只有一个，后到者拿同一个 Promise */
let resumeInFlight: Promise<void> | null = null
/** 恢复流程的取消开关（用户点「取消登录」/ 断开 / 重新发起时 abort） */
let resumeAbort: AbortController | null = null
/**
 * 登录会话代际：取消 / 重新发起时自增。
 *
 * 异步流程收尾时如果代际已经变了，就**不许**再改 state —— 否则「上一代的超时/取消」会把
 * 用户刚刚发起的新一轮登录覆盖成 cancelled。
 */
let loginGeneration = 0

/** 停掉恢复流程（只发信号；真正的收尾在流程自己的 finally 里） */
const abortResume = (): void => {
  loginGeneration += 1
  const controller = resumeAbort
  resumeAbort = null
  controller?.abort()
}

/** `$events` 等到 `ready` 的预算（超时即认为这条连接不可用：审批应答没有 clientId）。 */
const EVENTS_READY_TIMEOUT_MS = 10_000
/** 等 `session/follow` 首帧快照的预算（首帧可能很大，给足；参考 client-core 的 60 s）。 */
const SNAPSHOT_TIMEOUT_MS = 60_000

const INITIAL_STATE = {
  phase: 'idle' as const,
  capabilities: [] as string[],
  transport: null,
  error: null,
  sessions: [] as RemoteSessionSummary[],
  activeSessionId: null,
  items: [] as ChatItem[],
  streaming: false,
  pendingApprovals: [] as { eventId: string; title: string; detail?: string }[],
  oauthProviders: [] as RemoteOAuthProviderSummary[],
  qr: null as RemoteProviderLoginState | null,
  pendingLogin: null as RemotePendingLogin | null,
  keepAlive: null as KeepAliveSnapshot | null,
}

/* ────────────────────────────────────────────────────────────────────────
 * 三、小工具
 * ──────────────────────────────────────────────────────────────────────── */

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  // 调用方可能只 await 一次或干脆不 await：挂个空 catch，避免 unhandledRejection。
  void promise.catch(() => undefined)
  return { promise, resolve, reject }
}

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, code: string, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RemoteApiError(code, `${label}（${timeoutMs}ms）`)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

const toTransport = (value: string): RemoteState['transport'] =>
  value === 'relay' || value === 'lan' || value === 'p2p' || value === 'turn' ? value : null

/** 把错误写进 `state.error`（不动 phase：操作级失败，连接还在）。 */
const fail = (error: unknown): void => {
  const info = describeRemoteError(error)
  useRemoteStore.setState({ error: { code: info.code, message: info.text } })
}

/** 把错误写进 `state.error` + 把 phase 打到 error（连接级失败）。 */
const failConnection = (error: unknown): void => {
  const info = describeRemoteError(error)
  useRemoteStore.setState({
    error: { code: info.code, message: info.text },
    phase: 'error',
    transport: null,
    streaming: false,
  })
}

/* ── 多方式登录的错误文案 ─────────────────────────────────────────────
 * `sessionsApi.ts` 的 `ERROR_TEXTS` 只收录远端协议码；OAuth / 扫码是**本地**流程，
 * 码（`OAUTH_…` / `QR_…` / `NATIVE_BRIDGE_…`）在那边一律落到「未分类」。
 * 这些码的中文 message 就是数据层自己写的，直接用它，别让 UI 显示成未分类错误。 */

const SIGN_IN_ERROR_CODES = new Set([
  'OAUTH_UNAVAILABLE',
  'OAUTH_BRIDGE_UPDATE_REQUIRED',
  'OAUTH_CANCELLED',
  'OAUTH_TIMEOUT',
  'OAUTH_FAILED',
  'OAUTH_ABORTED',
  'OAUTH_PROVIDER_UNKNOWN',
  'NATIVE_BRIDGE_UNAVAILABLE',
  'NATIVE_BRIDGE_ERROR',
  'QR_UNSUPPORTED',
  'QR_NOT_STARTED',
  'QR_EXPIRED',
  'QR_TIMEOUT',
  'SERVER_NOT_CONFIGURED',
  'CONNECT_BUSY',
  // 这两个不是「本地发明」的码，但文案表里没有它们；serverApi 的 message 已经够清楚
  'INVALID_ARGUMENT',
  'CONNECTION_FAILED',
  'NOT_FOUND',
])

const signInErrorInfo = (error: unknown): { code: string; message: string } => {
  const info = describeRemoteError(error)
  const own = error instanceof RemoteApiError ? error.message.trim() : ''
  return {
    code: info.code,
    message: SIGN_IN_ERROR_CODES.has(info.code) && own.length > 0 ? own : info.text,
  }
}

/** 失败即「没登上」：写错误并把 phase 打到 error（登录级错误）。 */
const failSignIn = (error: unknown): void => {
  const { code, message } = signInErrorInfo(error)
  useRemoteStore.setState({ error: { code, message }, phase: 'error', transport: null, streaming: false })
}

/** 只记一笔、不动 phase：扫码轮询碰到网络抖动时用，别把用户的等待画面打断。 */
const noteSignInError = (error: unknown): void => {
  useRemoteStore.setState({ error: signInErrorInfo(error) })
}

const setPaging = (hasMore: boolean, loadingOlder: boolean): void => {
  useRemotePaging.setState({ hasMore, loadingOlder })
}

/** 把归约后的时间线推给 UI（同时重算待审批列表）。 */
const syncItems = (session: ActiveSession): void => {
  const items = session.transcript.items
  useRemoteStore.setState({ items, pendingApprovals: pendingApprovalsOf(items) })
}

const requireSession = (): ActiveSession => {
  if (active === null) {
    throw new RemoteApiError('NOT_CONNECTED', '先在设置里填写服务器与账号并连接')
  }
  return active
}

/* ── 流的分发（按 streamId） ───────────────────────────────────────────── */

const deliver = (sink: StreamSink, payload: StreamEventPayload): void => {
  if (payload.type === 'frame') {
    // `hasValue:false` 是「这一拍没有数据」，不是流结束（docs/protocol.md:1200-1201）。
    if (!payload.hasValue) return
    sink.onValue(payload.value)
    return
  }
  sink.onClosed(payload.reason, payload.failure)
}

const routeStream = (session: ActiveSession, streamId: string, payload: StreamEventPayload): void => {
  const sink = session.sinks.get(streamId)
  if (sink !== undefined) {
    deliver(sink, payload)
    return
  }
  // 句柄还没返回、帧先到：按 streamId 缓冲（这个 id 由 `core/rpcMux.ts` 生成并复用，能对上）。
  const buffered = session.unrouted.get(streamId)
  if (buffered === undefined) session.unrouted.set(streamId, [payload])
  else buffered.push(payload)
}

const openWithSink = async (
  session: ActiveSession,
  open: () => Promise<RemoteStreamHandle>,
  sink: StreamSink,
): Promise<RemoteStreamHandle> => {
  const handle = await open()
  session.sinks.set(handle.streamId, sink)
  const buffered = session.unrouted.get(handle.streamId)
  if (buffered !== undefined) {
    session.unrouted.delete(handle.streamId)
    for (const payload of buffered) deliver(sink, payload)
  }
  return handle
}

const closeStreamQuietly = async (session: ActiveSession, handle: RemoteStreamHandle | null): Promise<void> => {
  if (handle === null) return
  session.sinks.delete(handle.streamId)
  try {
    await handle.close()
  } catch {
    // 关流失败不影响本地收尾：链路可能已经断了。
  }
}

/* ── 会话列表投影 ─────────────────────────────────────────────────────── */

/** Host 的 `SessionSummary` → 契约的 `RemoteSessionSummary`（子会话不进列表）。 */
const toSummary = (row: RemoteSessionRow): RemoteSessionSummary => ({
  id: row.sessionId,
  // 标题可能来自 `projections.values.title`（Host 0.2.2 不再把 title 放在行上）；
  // 占位文案先写死中文，等 i18n 加 `remoteSessionUntitled` 再换。
  title: row.title ?? '(未命名会话)',
  ...(row.workspaceId === undefined ? {} : { workspaceId: row.workspaceId }),
  ...(row.updatedAt === undefined ? {} : { updatedAt: row.updatedAt }),
  ...(row.pinned === undefined ? {} : { pinned: row.pinned }),
})

const compareSummaries = (a: RemoteSessionSummary, b: RemoteSessionSummary): number => {
  if ((a.pinned === true) !== (b.pinned === true)) return a.pinned === true ? -1 : 1
  return (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
}

/**
 * 列表投影：**先过滤子会话再排序**。
 *
 * Host 侧已有 2048 行的预算截断（input-B §2.2），所以「拿到的行不等于全部」这件事
 * 在这里体现为：列表可能就是不全的，别拿它做「该会话不存在」的判断。
 */
const projectSessions = (rows: RemoteSessionRow[]): RemoteSessionSummary[] =>
  rows
    .filter(row => row.parentSessionId === undefined && row.origin !== 'subagent')
    .map(toSummary)
    .sort(compareSummaries)

/** `$events` 里被转发的目录增量（`remote.session.events.v1`）。 */
const applyForwardedSessionEvent = (event: ForwardedSessionEvent): void => {
  const sessions = useRemoteStore.getState().sessions
  if (event.kind === 'removed') {
    useRemoteStore.setState({ sessions: sessions.filter(item => item.id !== event.sessionId) })
    return
  }
  if (event.kind === 'activity') {
    useRemoteStore.setState({
      sessions: sessions
        .map(item => (item.id === event.sessionId ? { ...item, updatedAt: event.updatedAt } : item))
        .sort(compareSummaries),
    })
    return
  }
  if (event.kind === 'added') {
    const row = parseSessionRow(event.session)
    if (row === null || row.parentSessionId !== undefined || row.origin === 'subagent') return
    if (sessions.some(item => item.id === row.sessionId)) return
    useRemoteStore.setState({ sessions: [...sessions, toSummary(row)].sort(compareSummaries) })
    return
  }
  // `status`（running 变化）在契约的 `RemoteSessionSummary` 里没有对应字段，P0 忽略；
  // `error` 由会话流自己的 turn/end 表达，这里也不抢展示。
}

/* ── 连建 ─────────────────────────────────────────────────────────────── */

type PickedHost = RemoteHost & { identityKey: string }

/** 挑一台可连的 Host（在线优先）；公钥缺失直接 fail-closed —— Noise IK 没有它就握不上手。 */
const pickHost = (hosts: RemoteHost[]): PickedHost => {
  const usable = hosts.filter(host => host.identityMismatch !== true)
  if (usable.length === 0) {
    if (hosts.length > 0) {
      throw new RemoteApiError('PEER_IDENTITY_MISMATCH', '账号下主机的公钥都与本机 pin 的不一致，已拒绝连接')
    }
    throw new RemoteApiError('NO_HOST', '这个账号下没有可连接的 Host：请先在电脑上的 DSH 里开启远程访问并注册设备')
  }
  const picked = usable.find(host => host.online === true) ?? usable[0]!
  if (picked.identityKey === undefined || picked.identityKey.length === 0) {
    throw new RemoteApiError(
      'HOST_IDENTITY_MISSING',
      '拿不到目标主机的身份公钥（Noise IK 必需），请确认服务器能返回设备详情',
    )
  }
  return { ...picked, identityKey: picked.identityKey }
}

/**
 * 打开 `$events` 并等到 `ready`。
 *
 * 为什么必须等：审批应答 `$events/result` 要带 `clientId`（input-B §2.6），
 * 而 `clientId` 只在 `$events` 的首条 `{type:'ready'}` 里出现。等不到就 fail-closed，
 * 免得用户点了「允许」才发现发不出去。
 */
const openEventsStream = async (session: ActiveSession): Promise<void> => {
  const ready = deferred<string>()
  let closed = false
  const sink: StreamSink = {
    onValue: (value) => {
      const clientId = eventClientIdOf(value)
      if (clientId !== undefined && session.eventClientId === null) {
        session.eventClientId = clientId
        ready.resolve(clientId)
      }
      const forwarded = forwardedSessionEvent(value)
      if (forwarded !== undefined) applyForwardedSessionEvent(forwarded)
      if (session.sessionId !== null) {
        const next = reduceEventsItem(session.transcript.items, value, session.sessionId)
        if (next !== session.transcript.items) {
          session.transcript = { ...session.transcript, items: next }
          syncItems(session)
        }
      }
    },
    onClosed: (reason) => {
      closed = true
      session.events = null
      session.eventClientId = null
      if (reason !== 'cancelled') {
        ready.reject(new RemoteApiError('EVENT_STREAM_CLOSED', '远端的事件流已关闭：审批与目录增量都收不到了'))
      }
    },
  }
  const handle = await openWithSink(session, () => openEvents(session.link), sink)
  // `openWithSink` 会把缓冲帧先倒出来：万一 `closed` 已经先到，别把死句柄存回去。
  session.events = closed ? null : handle
  await withTimeout(ready.promise, EVENTS_READY_TIMEOUT_MS, 'EVENT_STREAM_NOT_READY', '等待 $events ready 超时')
}

/** 拆掉当前连接（幂等；主动断开时不能把 `closed` 报成错误）。 */
const shutdown = async (): Promise<void> => {
  const session = active
  active = null
  if (session === null) return
  session.closing = true
  session.sinks.clear()
  session.unrouted.clear()
  await closeStreamQuietly(session, session.follow)
  await closeStreamQuietly(session, session.events)
  session.follow = null
  session.events = null
  session.eventClientId = null
  try {
    session.link.close()
  } catch {
    // 链路可能已经自己关了。
  }
}

/* ── 原生保活（K1）：连上就拉起，真断开就停 ─────────────────────────────
 * 为什么必须在**页面**侧做：远程连接的心跳是页面定时器。用户切到系统浏览器授权时
 * WebView 进后台、定时器被冻结，服务端 75 秒就把连接踢了 —— 原生前台服务在这段
 * 时间替我们维持心跳。纪律：失败静默（保活不该影响连接）、绝不在 `pagehide` /
 * `beforeunload` / `onPause` 里停（切后台正是需要它的时候）。 */

/** 状态只在真的变了才写（前台自检会被高频调用，别每次都触发重渲染） */
const sameKeepAlive = (a: KeepAliveSnapshot | null, b: KeepAliveSnapshot): boolean =>
  a !== null &&
  a.supported === b.supported &&
  a.running === b.running &&
  a.shouldRun === b.shouldRun &&
  a.notificationsGranted === b.notificationsGranted &&
  a.batteryExempt === b.batteryExempt &&
  a.sdkInt === b.sdkInt

const applyKeepAlive = (snapshot: KeepAliveSnapshot): void => {
  if (sameKeepAlive(useRemoteStore.getState().keepAlive, snapshot)) return
  useRemoteStore.setState({ keepAlive: snapshot })
}

/** 探测 +（需要时）拉起保活；非壳环境记成 `supported:false`，绝不抛 */
const refreshKeepAliveFlow = async (): Promise<void> => {
  try {
    const snapshot = await syncKeepAlive()
    applyKeepAlive(snapshot ?? unsupportedKeepAlive())
  } catch {
    // 原生端点抽风不该让连接流程背锅
  }
}

/** 真断开 / 退出登录：停保活（幂等；不 await，断开这条路径不该被原生调用拖住） */
const stopKeepAliveFlow = (): void => {
  void stopKeepAlive()
    .then((stopped) => {
      // 取**此刻**的快照：断开路径可能已经把 state 清成 INITIAL_STATE（`keepAlive: null`），
      // 那就不该再把旧快照写回去。
      const latest = useRemoteStore.getState().keepAlive
      if (stopped && latest !== null) applyKeepAlive({ ...latest, running: false })
    })
    .catch(() => undefined)
}

/* ── 动作实现 ─────────────────────────────────────────────────────────── */

/**
 * 登录拿到**设备账号**之后的全部动作：列 Host → 建安全通道 → 握手 → `$events` → 首屏列表。
 *
 * 为什么抽出来：`connect()`（邮箱密码）、浏览器授权、扫码登录最终都换回**同一个**
 * 设备账号，后面这段必须只有一份实现 —— 否则三条路会各自漂移（审批要 `clientId`、
 * 首屏要约会话列表，漏一处就是「连上了但空白」）。
 * `connect()` 的签名与对外行为一字未改，只是它的第 3-7 步搬进了这里。
 */
const establishSession = async (client: RemoteClient, server: RemoteServer, device: RemoteAccount): Promise<void> => {
  try {
    // 3. 列 Host（内部已经补好 presence 与 identityKey pin）
    const host = pickHost(await client.listHosts(server, device))

    useRemoteStore.setState({ phase: 'connecting' })

    // 4. 建安全通道。`hostIdentityKey` 是契约 §3 缺的必填项（Noise IK 的 responder 公钥，
    // 见 `core/index.ts` 头部「契约缺口」）。S3 的 `buildLinkOptions()` 运行时也会带这个字段，
    // 但它的 `SecureLinkOptions` **类型里没声明**（靠条件展开绕过了属性检查），
    // 所以这里显式再写一次：既补类型，也让「Noise 需要 Host 公钥」这件事在调用点可见。
    // `sessionRef` 先挂上：link 的回调可能在 session 对象建好之前就被触发（建链阶段），
    // 真正有流要分发时它一定已经指向本连接的上下文。
    let sessionRef: ActiveSession | null = null
    const link = createSecureLink({
      ...buildLinkOptions({ server, account: device, host }),
      hostIdentityKey: host.identityKey,
      onStreamEvent: (streamId, payload) => {
        if (sessionRef !== null) routeStream(sessionRef, streamId, payload)
      },
      onState: (state) => {
        if (state !== 'closed') return
        const current = active
        if (current === null || current.link !== link || current.closing) return
        // 建链成功后才算「意外断开」；建链期间的失败由 client.connect 自己抛。
        current.closing = true
        active = null
        // 不会自动重连了：把原生保活停掉，别留一个「守护着死连接」的前台服务
        stopKeepAliveFlow()
        failConnection(new RemoteApiError('TRANSPORT_CLOSED', '与远端主机的安全通道已断开'))
      },
    })

    const session: ActiveSession = {
      client,
      server,
      account: device,
      host,
      link,
      capabilities: [],
      sessionId: null,
      transcript: createTranscriptState(),
      hasMore: false,
      follow: null,
      events: null,
      eventClientId: null,
      sinks: new Map(),
      unrouted: new Map(),
      closing: false,
    }
    active = session
    sessionRef = session

    // 5. 控制面握手 + `harness.transport.describe`（拿不到 v1|v3 就 fail-closed）
    const connected = await client.connect(server, device, host, link)
    session.capabilities = connected.capabilities
    useRemoteStore.setState({
      phase: 'ready',
      capabilities: [...connected.capabilities],
      transport: toTransport(connected.transport),
      error: null,
    })
    // 连上了就把原生保活拉起来：用户随时可能切到系统浏览器授权，页面定时器会被冻结。
    // 不 await：保活失败不该拖住首屏（也不该影响连接结果）。
    void refreshKeepAliveFlow()

    // 6. `$events` 必须先 ready（审批 / 目录增量都靠它）
    await openEventsStream(session)
    // 7. 首屏列表
    useRemoteStore.setState({ sessions: projectSessions(await listSessions(link)) })
  } catch (error) {
    // 已经 ready 之后才失败的（`$events` / 首屏）：保活服务不该继续守护一条死连接
    stopKeepAliveFlow()
    await shutdown()
    failConnection(error)
  }
}

/** 邮箱密码登录 → 设备注册 → 建链（`connect()` 的完整实现，行为保持不变）。 */
const connectOnce = async (serverUrl: string, email: string, password: string): Promise<void> => {
  await shutdown()
  setPaging(false, false)
  useRemoteStore.setState({ ...INITIAL_STATE, phase: 'authing' })

  let server: RemoteServer
  try {
    server = { url: normalizeServerUrl(serverUrl) }
  } catch (error) {
    failConnection(error)
    return
  }

  const client = createRemoteClient()
  try {
    // 1. 账号 token（只用来注册设备，没有 refresh）
    const account = await client.login(server, email, password)
    // 2. 换设备 token pair（设备身份来自 `identity.ts` 的 localStorage 单例）
    const device = await client.registerDevice(server, account)
    // 3-7. 列 Host → 建链 → 握手 → `$events` → 首屏（与多方式登录共用）
    await establishSession(client, server, device)
  } catch (error) {
    await shutdown()
    failConnection(error)
  }
}

/* ── 多方式登录：登录方式发现 / 发起 / 轮询 / 取消 ─────────────────────── */

/** 最近用过的服务器地址（UI 没显式传 serverUrl 时的兜底）。 */
const lastUsedServerUrl = (): string => {
  const url = loadServers()[0]?.url
  if (url === undefined || url.length === 0) {
    throw new RemoteApiError('SERVER_NOT_CONFIGURED', '还没有服务器地址：先在设置里填写远程 DSH 服务器地址')
  }
  return url
}

/** 拉一次登录方式并同步到 state（同一台服务器只拉一次；换服务器自动失效）。 */
const ensureOAuthProviders = async (server: RemoteServer): Promise<OAuthProvider[]> => {
  const cached = providerCache
  if (cached !== null && cached.serverUrl === server.url) return cached.items
  const items = await oauthProvidersApi(server)
  providerCache = { serverUrl: server.url, items }
  useRemoteStore.setState({
    oauthProviders: items.map((item) => ({ id: item.id, displayName: item.displayName, canQr: item.qrStartUrl !== undefined })),
  })
  return items
}

const loadOAuthProvidersFlow = async (serverUrl?: string): Promise<void> => {
  try {
    await ensureOAuthProviders({ url: normalizeServerUrl(serverUrl ?? lastUsedServerUrl()) })
  } catch (error) {
    failSignIn(error)
  }
}

const loginWithPasswordFlow = async (email: string, password: string, serverUrl?: string): Promise<void> => {
  let url: string
  try {
    url = normalizeServerUrl(serverUrl ?? lastUsedServerUrl())
  } catch (error) {
    failSignIn(error)
    return
  }
  // 与 `connect()` 完全同一条路径：登录 → 注册设备 → 建链
  await connectFlow(url, email, password)
}

/**
 * 发起 provider 登录。
 *
 * 顺序很关键：
 *   1. 先拿 provider 列表（要 `qrStartUrl`，state 里只留了 UI 需要的那三项）；
 *   2. 建会话 —— `browser` 模式会在这里让原生容器用**系统浏览器**打开授权页，非壳环境
 *      **这一步就失败**（报「只能在 App 内使用」），不会留一个永远 pending 的登录；
 *   3. 把会话写进 state（同时 `oauth.js` 已经把它落盘，App 被杀也能续），之后由 UI 每 2s
 *      调 `pollProviderLogin()`。
 *
 * 发起新登录前会先把「上一轮恢复流程」abort 掉：否则旧的轮询可能在后面收尾时把新会话
 * 的状态覆盖掉（代际检查兜底，但不该指望它）。
 */
const startProviderLoginFlow = async (
  providerId: string,
  mode: 'browser' | 'qr',
  serverUrl?: string,
): Promise<void> => {
  try {
    const url = normalizeServerUrl(serverUrl ?? lastUsedServerUrl())
    const server: RemoteServer = { url }
    const providers = await ensureOAuthProviders(server)
    const provider = providers.find((item) => item.id === providerId)
    if (provider === undefined) {
      throw new RemoteApiError('OAUTH_PROVIDER_UNKNOWN', `这台服务器没有启用「${providerId}」登录方式`)
    }
    // 旧会话先收尾：同一时间只允许一个登录会话（旧 qrId 服务器侧会自己过期）
    abortResume()
    if (useRemoteStore.getState().qr?.mode === 'browser') await closeAuthPage()

    const session = await startProviderLoginApi(url, provider, mode)
    loginServerUrl = url
    loginTokenClaimed = false
    useRemoteStore.setState({
      qr: {
        providerId: session.providerId,
        mode,
        qrId: session.qrId,
        scanUrl: session.scanUrl,
        expiresAt: session.expiresAt,
        status: 'pending',
      },
      pendingLogin: { providerId: session.providerId, mode, expiresAt: session.expiresAt },
      // 系统浏览器打不开时会回退应用内 WebView（`session.notice`）：把这句话带到界面上
      ...(session.notice === undefined ? { error: null } : { error: { code: 'OAUTH_INLINE_FALLBACK', message: session.notice } }),
      ...(useRemoteStore.getState().phase === 'ready' ? {} : { phase: 'waiting-auth' as const }),
    })
  } catch (error) {
    failSignIn(error)
  }
}

/**
 * 登录轮询（单拍）。
 *
 * UI 自己排 2s 的节奏（与 dsh-Go / 上游 App 一致）：这样「用户切走页面」「权限弹窗」
 * 这些情况都能自然停下来。规则：
 *   - `pending`：什么都不改（瞬时网络错只记 `error`，不打断等待）；
 *   - `expired`：会话标 `expired`，UI 提示刷新；
 *   - `complete`：token **只领一次** → 立刻标记已领 → 换设备账号 → 建链；
 *   - 确定性错误：标 `error`。
 */
const pollProviderLoginOnce = async (): Promise<void> => {
  const state = useRemoteStore.getState()
  const login = state.qr
  if (login === null) {
    failSignIn(new RemoteApiError('QR_NOT_STARTED', '还没有发起登录：先选一种登录方式'))
    return
  }
  if (login.status !== 'pending' || loginTokenClaimed) return
  const serverUrl = loginServerUrl
  if (serverUrl === null) {
    failSignIn(new RemoteApiError('QR_NOT_STARTED', '登录会话已失效，请重新发起登录'))
    return
  }

  let result
  try {
    result = await pollProviderLoginApi(serverUrl, login.qrId, { expiresAt: login.expiresAt })
  } catch (error) {
    // 网络抖动不该把「等待授权」变成「登录失败」：只记错误，UI 继续轮
    // 但 401/404/410 例外：服务器已经不认这个 qrId 了，重试多少次都没用（与恢复流程同一套分类）
    const stale =
      isRemoteApiError(error) && (error.status === 401 || error.status === 404 || error.status === 410)
    if (isRemoteApiError(error) && error.retryable && !stale) {
      noteSignInError(error)
      return
    }
    // qrId 已经作废（401/404）：盘上那份也没用了，留着只会在下次启动白跑一次
    clearPendingLogin()
    useRemoteStore.setState({ qr: { ...login, status: 'error' }, pendingLogin: null })
    if (state.phase === 'waiting-auth') useRemoteStore.setState({ phase: 'idle' })
    failSignIn(error)
    return
  }

  if (result.status === 'pending') return
  if (result.status === 'complete') {
    // token 只返回一次，从这里开始禁止再 poll（换设备失败也只能重新发起登录）
    loginTokenClaimed = true
    clearPendingLogin()
    const claimed: RemoteProviderLoginState = { ...login, status: 'complete' }
    useRemoteStore.setState({ qr: claimed, pendingLogin: null })
    if (login.mode === 'browser') await closeAuthPage()
    await connectWithProviderToken(serverUrl, result.token, claimed, login.mode === 'qr' ? 'qr' : 'oauth')
    return
  }

  // expired：服务器说过期了（或本地时钟先到），提示 UI 刷新二维码 / 重新发起
  clearPendingLogin()
  useRemoteStore.setState({
    qr: { ...login, status: 'expired' },
    pendingLogin: null,
    ...(state.phase === 'waiting-auth' ? { phase: 'idle' as const } : {}),
  })
  if (login.mode === 'browser') await closeAuthPage()
}

/**
 * 轮询互斥：同一时刻只跑一次。
 *
 * 为什么需要：UI 的 2s 定时器 + 一次慢请求会叠出两次并发 poll，而 `complete` 的 token
 * **只能领一次** —— 第二个请求会拿到「complete 但没有 token」，反而把登录判成失败。
 *
 * 恢复流程（`resumeLogin()`）在跑的时候，单拍一律让路：它自己会按同样的节奏轮询，
 * 两边同时打服务器同样会抢 token。
 */
const pollProviderLoginFlow = async (): Promise<void> => {
  if (pollInFlight !== null || resumeInFlight !== null) return
  const task = pollProviderLoginOnce().finally(() => {
    if (pollInFlight === task) pollInFlight = null
  })
  pollInFlight = task
  await task
}

/**
 * 续上一次没完成的登录（K2 的核心）。
 *
 * 调用时机：面板挂载（App 启动 / 用户重新打开设置）、`visibilitychange → visible`
 * （用户从系统浏览器切回来）、以及面板的立即补拍。三条路径可能同时触发，所以：
 *
 *   - **幂等单飞**：`resumeInFlight` 非空时直接返回同一个 Promise；
 *   - **不和 UI 单拍抢**：起跑前若有一拍在飞，先等它落地（它会自己领走 token）；
 *   - **代际守卫**：收尾时若 `loginGeneration` 变了（用户取消 / 重新发起），不许再改 state。
 *
 * 没有待完成会话时**什么都不做**（不写 error、不动 phase）—— 它会被高频调用，
 * 不能因为「本来就没事」而弹提示。
 */
const runResumeLogin = async (): Promise<void> => {
  // 起跑前先让 UI 那一拍落地：`complete` 的 token 只能被一个轮询领走
  if (pollInFlight !== null) await pollInFlight.catch(() => undefined)

  const record = readPendingLogin()
  if (record === null) {
    if (useRemoteStore.getState().pendingLogin !== null) useRemoteStore.setState({ pendingLogin: null })
    return
  }

  const current = useRemoteStore.getState()
  if (current.phase === 'ready' || current.phase === 'authing' || current.phase === 'connecting') {
    // 已经连上 / 另一条登录正在跑：这条旧会话没有意义了（服务器侧会自己过期）
    clearPendingLogin()
    if (current.pendingLogin !== null) useRemoteStore.setState({ pendingLogin: null })
    return
  }

  const generation = loginGeneration
  const controller = new AbortController()
  resumeAbort = controller
  const pending: RemotePendingLogin = {
    providerId: record.providerId,
    mode: record.mode,
    expiresAt: record.expiresAt,
  }
  // 先把「等待授权」摆出来（同步段）：面板一挂载就能显示倒计时，不用等第一拍网络往返
  useRemoteStore.setState({
    phase: 'waiting-auth',
    pendingLogin: pending,
    error: null,
    qr: {
      providerId: record.providerId,
      mode: record.mode,
      qrId: record.qrId,
      scanUrl: record.scanUrl,
      expiresAt: record.expiresAt,
      status: 'pending',
    },
  })

  const outcome = await resumePendingLoginApi({
    signal: controller.signal,
    complete: async ({ record: hit, token }) => {
      // 与「本进程内轮询到 complete」走**同一条**落地路径（落账号 + 注册设备 + 建链）
      const claimed: RemoteProviderLoginState = {
        providerId: hit.providerId,
        mode: hit.mode,
        qrId: hit.qrId,
        scanUrl: hit.scanUrl,
        expiresAt: hit.expiresAt,
        status: 'complete',
      }
      await connectWithProviderToken(hit.serverUrl, token, claimed, hit.mode === 'qr' ? 'qr' : 'oauth')
    },
  })

  // 旧一代会话的收尾不许动新会话的状态
  if (generation !== loginGeneration) return

  const latest = useRemoteStore.getState()
  const mine = latest.qr?.qrId === record.qrId ? latest.qr : null
  const backToIdle = latest.phase === 'waiting-auth' ? { phase: 'idle' as const } : {}

  if (outcome.status === 'none' || outcome.status === 'complete') {
    // complete 的 phase/qr 已经由 `connectWithProviderToken` 接管
    if (latest.pendingLogin !== null) useRemoteStore.setState({ pendingLogin: null })
    return
  }

  if (outcome.status === 'cancelled') {
    useRemoteStore.setState({
      pendingLogin: null,
      ...(mine === null || mine.status !== 'pending' ? {} : { qr: { ...mine, status: 'cancelled' as const } }),
      ...backToIdle,
    })
    return
  }

  // expired / timeout / failed：会话已经没了（或 qrId 失效），清理 + 给出原因
  useRemoteStore.setState({
    pendingLogin: null,
    ...(mine === null ? {} : { qr: { ...mine, status: outcome.status === 'failed' ? ('error' as const) : ('expired' as const) } }),
    ...backToIdle,
  })
  noteSignInError(
    new RemoteApiError(outcome.code ?? 'QR_EXPIRED', outcome.message ?? '登录会话已失效，请重新发起登录'),
  )
}

/** `resumeLogin()` 的外壳：单飞 + 兜底（这条路径永远不该把异常抛给界面） */
const resumeLoginFlow = (): Promise<void> => {
  if (resumeInFlight !== null) return resumeInFlight
  const task: Promise<void> = runResumeLogin()
    .catch((error: unknown) => {
      noteSignInError(error)
    })
    .finally(() => {
      if (resumeInFlight === task) {
        resumeInFlight = null
        resumeAbort = null
      }
    })
  resumeInFlight = task
  return task
}

/**
 * 回到前台（`visibilitychange → visible`）时的一次性补齐。
 *
 * 为什么三件事都要做：
 *   ① 用户可能刚从系统浏览器授权回来 → `resumeLogin()` 续上被杀进程前的那次登录；
 *   ② 后台的 `setTimeout` 会被系统节流，2s 轮询定时器可能整段停摆 → 立刻补一拍
 *      （恢复流程在跑时它自己会拍，这里会被单飞让路，不会多打）；
 *   ③ 系统可能在后台把保活服务杀掉 → 探一次，`shouldRun && !running` 就补一次 start。
 *
 * 三件事都是幂等 + 静默：这条路径会被反复触发，不能因为「本来就没事」而弹提示。
 */
const foregroundFlow = async (): Promise<void> => {
  await Promise.all([
    resumeLoginFlow().catch(() => undefined),
    pollProviderLoginFlow().catch(() => undefined),
    refreshKeepAliveFlow(),
  ])
}

/** 领到 token 之后：换设备账号（`loginWithAccountToken` 负责落盘）→ 建链。 */
const connectWithProviderToken = async (
  serverUrl: string,
  accountToken: string,
  login: RemoteProviderLoginState,
  method: 'oauth' | 'qr',
): Promise<void> => {
  if (connecting) {
    failSignIn(new RemoteApiError('CONNECT_BUSY', '正在建立另一条连接，请稍后重新发起登录'))
    return
  }
  connecting = true
  try {
    await shutdown()
    setPaging(false, false)
    const providers = useRemoteStore.getState().oauthProviders
    useRemoteStore.setState({
      ...INITIAL_STATE,
      phase: 'authing',
      oauthProviders: providers,
      // 登录态要留着：UI 需要显示「登录成功，正在连接…」
      qr: login,
    })
    const server: RemoteServer = { url: serverUrl }
    const client = createRemoteClient()
    try {
      const account = await client.loginWithAccountToken(server, accountToken, method)
      await establishSession(client, server, account)
    } catch (error) {
      await shutdown()
      failSignIn(error)
    }
  } finally {
    connecting = false
  }
}

/**
 * 取消登录（K2 语义：**必须清持久化 + 停轮询**，否则下次启动还会续上一次「已取消」的登录）。
 *
 * 服务器侧的 qrId 不需要显式作废端点，它会自己过期；这里只做本地收尾。
 */
const cancelProviderLoginFlow = async (): Promise<void> => {
  const login = useRemoteStore.getState().qr
  const phase = useRemoteStore.getState().phase
  loginServerUrl = null
  // 先停轮询（abort 会让恢复流程以 `cancelled` 收尾），再删盘上的记录
  abortResume()
  clearPendingLogin()
  if (login === null) {
    useRemoteStore.setState({ pendingLogin: null, ...(phase === 'waiting-auth' ? { phase: 'idle' as const } : {}) })
    return
  }
  if (login.mode === 'browser') await closeAuthPage()
  useRemoteStore.setState({
    pendingLogin: null,
    qr: { ...login, status: 'cancelled' },
    ...(phase === 'waiting-auth' ? { phase: 'idle' as const } : {}),
  })
}

/** 建链互斥：连点两次不能并发建两条安全通道（第二条会覆盖 `active` 并泄漏第一条）。 */
let connecting = false

const connectFlow = async (serverUrl: string, email: string, password: string): Promise<void> => {
  if (connecting) return
  connecting = true
  try {
    await connectOnce(serverUrl, email, password)
  } finally {
    connecting = false
  }
}

const refreshSessionsFlow = async (): Promise<void> => {
  try {
    const session = requireSession()
    useRemoteStore.setState({ sessions: projectSessions(await listSessions(session.link)) })
  } catch (error) {
    fail(error)
  }
}

const openSessionFlow = async (id: string): Promise<void> => {
  let session: ActiveSession
  try {
    session = requireSession()
  } catch (error) {
    fail(error)
    return
  }
  await closeStreamQuietly(session, session.follow)
  session.follow = null
  session.sessionId = id
  session.transcript = createTranscriptState()
  session.hasMore = false
  useRemoteStore.setState({
    activeSessionId: id,
    items: [],
    streaming: false,
    pendingApprovals: [],
    error: null,
  })
  setPaging(false, false)

  const ready = deferred<void>()
  let applied = false
  let closed = false
  const sink: StreamSink = {
    onValue: (value) => {
      if (!applied) {
        const snapshot = parseSnapshot(value)
        if (snapshot === null) {
          ready.reject(new RemoteApiError('INVALID_MESSAGE', '远端没有先给 session/follow 快照（协议要求首帧必须是 snapshot）'))
          return
        }
        session.transcript = reduceSnapshot(snapshot, id)
        session.hasMore = snapshot.hasMore
        applied = true
        syncItems(session)
        setPaging(snapshot.hasMore, false)
        ready.resolve()
        return
      }
      session.transcript = reduceFollowItem(session.transcript, value, id)
      const running = runningForFollowItem(value)
      if (running !== undefined) useRemoteStore.setState({ streaming: running })
      syncItems(session)
    },
    onClosed: (reason, failure) => {
      closed = true
      session.follow = null
      useRemoteStore.setState({ streaming: false })
      if (!applied) {
        ready.reject(new RemoteApiError(failure?.code ?? 'STREAM_CLOSED', '会话流在快照之前就关闭了'))
        return
      }
      if (reason === 'failed') {
        fail(new RemoteApiError(failure?.code ?? 'INTERNAL_ERROR', failure?.message ?? '会话流失败'))
      }
    },
  }

  try {
    const handle = await openWithSink(
      session,
      () =>
        openFollow(session.link, id, {
          assistantStream: session.capabilities.includes('harness.remote.v3'),
        }),
      sink,
    )
    // 同上：缓冲帧里可能已经带了 `closed`，别把死句柄存回去。
    session.follow = closed ? null : handle
    await withTimeout(ready.promise, SNAPSHOT_TIMEOUT_MS, 'RPC_TIMEOUT', '等待会话快照超时')
  } catch (error) {
    await closeStreamQuietly(session, session.follow)
    session.follow = null
    fail(error)
  }
}

const loadOlderFlow = async (): Promise<void> => {
  let session: ActiveSession
  try {
    session = requireSession()
  } catch (error) {
    fail(error)
    return
  }
  const id = session.sessionId
  if (id === null) return
  if (!session.hasMore || useRemotePaging.getState().loadingOlder) return
  const beforeSeq = oldestSeqOfItems(session.transcript.items)
  // 没有任何带 seq 的行 = 没锚点，只能承认没有更早的（比乱发一个 beforeSeq 安全）。
  if (beforeSeq === undefined) {
    session.hasMore = false
    setPaging(false, false)
    return
  }
  setPaging(session.hasMore, true)
  try {
    const page = await pageHistory(session.link, id, {
      beforeSeq,
      ...(session.transcript.cursor >= 0 ? { throughSeq: session.transcript.cursor } : {}),
      maxMessages: DEFAULT_HISTORY_PAGE_SIZE,
    })
    session.hasMore = page.hasMore
    const older = foldHistory(historyEntriesFromRecords(page.records), id, false)
    if (older.length > 0) {
      session.transcript = { ...session.transcript, items: prependHistory(older, session.transcript.items) }
      syncItems(session)
    }
  } catch (error) {
    fail(error)
  } finally {
    setPaging(session.hasMore, false)
  }
}

const sendFlow = async (text: string, attachments: readonly RemotePromptAttachment[] = []): Promise<void> => {
  let session: ActiveSession
  try {
    session = requireSession()
  } catch (error) {
    fail(error)
    return
  }
  const id = session.sessionId
  if (id === null) {
    fail(new RemoteApiError('SESSION_NOT_OPEN', '先选一个会话再发消息'))
    return
  }
  if (!hasVisibleMessageText(text) && attachments.length === 0) {
    fail(new RemoteApiError('INVALID_ARGUMENT', '消息不能为空'))
    return
  }

  // 乐观上屏：requestId 同时是 `session/prompt` 的幂等键与 Host 回显的 `source.rpcId`，
  // `addUserMessage()` 靠它把这条本地行替换成权威行。
  const requestId = newRequestId()
  session.transcript = {
    ...session.transcript,
    items: addOptimisticUserMessage(session.transcript.items, id, text, requestId),
  }
  useRemoteStore.setState({ streaming: true, error: null })
  syncItems(session)

  try {
    await sendPrompt(session.link, id, text, attachments, { requestId })
  } catch (error) {
    // 失败**不删行**：把原因留在行上（契约要求「可读错误」给到 UI），同时写进 state.error。
    const info = describeRemoteError(error)
    session.transcript = {
      ...session.transcript,
      items: markSendState(session.transcript.items, requestId, 'failed', info.text),
    }
    useRemoteStore.setState({ streaming: false })
    syncItems(session)
    fail(error)
  }
}

const cancelFlow = async (): Promise<void> => {
  let session: ActiveSession
  try {
    session = requireSession()
  } catch (error) {
    fail(error)
    return
  }
  if (session.sessionId === null) return
  try {
    await cancelSession(session.link, session.sessionId)
    // `accepted:true` 只代表已受理，真正的终态是 `turn/end.reason.kind = aborted`；
    // 所以这里**不**急着把 streaming 关掉（那会让人以为已经停了）。
  } catch (error) {
    fail(error)
  }
}

const respondApprovalFlow = async (eventId: string, decision: ApprovalDecision): Promise<void> => {
  let session: ActiveSession
  try {
    session = requireSession()
  } catch (error) {
    fail(error)
    return
  }
  if (session.eventClientId === null) {
    fail(new RemoteApiError('EVENT_STREAM_NOT_READY', '还没拿到 $events 的 clientId'))
    return
  }
  try {
    await respondApprovalApi(session.link, { clientId: session.eventClientId, eventId, decision })
    // 本地先落定，不必等 Host 回投（官方客户端也是这么做的）。
    session.transcript = {
      ...session.transcript,
      items: resolveApprovalItem(
        session.transcript.items,
        eventId,
        decision === 'allow_once' ? 'allowed-once' : 'rejected',
      ),
    }
    syncItems(session)
  } catch (error) {
    fail(error)
    const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : ''
    // 句柄已失效：把卡片标成 unavailable（继续显示 pending 只会让人反复点）。
    if (code === 'PERMISSION_NOT_PENDING' || code === 'AGENT_BUSY') {
      session.transcript = {
        ...session.transcript,
        items: resolveApprovalItem(session.transcript.items, eventId, 'unavailable'),
      }
      syncItems(session)
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * 四、单例 store
 * ──────────────────────────────────────────────────────────────────────── */

export const useRemoteStore = create<RemoteState>(() => ({
  ...INITIAL_STATE,

  connect: async (serverUrl: string, email: string, password: string): Promise<void> => {
    await connectFlow(serverUrl, email, password)
  },

  disconnect: (): void => {
    void shutdown()
    setPaging(false, false)
    // 登录会话也跟着作废：浏览器授权页还开着的话顺手关掉（不 await：断开不该被原生桥拖住）
    if (useRemoteStore.getState().qr?.mode === 'browser') void closeAuthPage()
    abortResume()
    // 断开 = 主动放弃这次登录：盘上的待完成会话必须清掉，否则下次启动会自己续上
    clearPendingLogin()
    // 主动断开 / 退出登录：保活服务必须停（它守护的连接已经没了）
    stopKeepAliveFlow()
    loginServerUrl = null
    loginTokenClaimed = false
    useRemoteStore.setState({ ...INITIAL_STATE })
  },

  refreshSessions: async (): Promise<void> => {
    await refreshSessionsFlow()
  },

  openSession: async (id: string): Promise<void> => {
    await openSessionFlow(id)
  },

  loadOlder: async (): Promise<void> => {
    await loadOlderFlow()
  },

  send: async (text: string): Promise<void> => {
    await sendFlow(text)
  },

  cancel: async (): Promise<void> => {
    await cancelFlow()
  },

  respondApproval: async (eventId: string, decision: 'allow_once' | 'deny'): Promise<void> => {
    await respondApprovalFlow(eventId, decision)
  },

  loadOAuthProviders: async (serverUrl?: string): Promise<void> => {
    await loadOAuthProvidersFlow(serverUrl)
  },

  loginWithPassword: async (email: string, password: string, serverUrl?: string): Promise<void> => {
    await loginWithPasswordFlow(email, password, serverUrl)
  },

  startProviderLogin: async (providerId: string, mode: 'browser' | 'qr', serverUrl?: string): Promise<void> => {
    await startProviderLoginFlow(providerId, mode, serverUrl)
  },

  pollProviderLogin: async (): Promise<void> => {
    await pollProviderLoginFlow()
  },

  resumeLogin: async (): Promise<void> => {
    await resumeLoginFlow()
  },

  onAppForeground: async (): Promise<void> => {
    await foregroundFlow()
  },

  refreshKeepAlive: async (): Promise<void> => {
    await refreshKeepAliveFlow()
  },

  requestBatteryExemption: async (): Promise<void> => {
    // 只能在用户点击里调（Android 10+ 禁止后台弹 Activity）：失败静默，返回后重新探一次
    await requestBatteryExemptionApi().catch(() => false)
    await refreshKeepAliveFlow()
  },

  cancelProviderLogin: async (): Promise<void> => {
    await cancelProviderLoginFlow()
  },
}))

/* ────────────────────────────────────────────────────────────────────────
 * 五、给集成层的小工具（不属于契约，但省得 UI 自己拼）
 * ──────────────────────────────────────────────────────────────────────── */

/** 带附件发一条消息（P1 的收据 / 图片走这里；契约里的 `send()` 只发文本）。 */
export const sendRemoteMessage = sendFlow

/** 当前连接是否可用（`phase === 'ready'`）。 */
export const isRemoteReady = (): boolean => useRemoteStore.getState().phase === 'ready'

/** 会话列表里某一行（UI 想拿 `title` 做标题栏时用）。 */
export const findRemoteSession = (id: string): RemoteSessionSummary | undefined =>
  useRemoteStore.getState().sessions.find(item => item.id === id)

/** 诊断用：当前连接的安全摘要（**不含 token**）。 */
export const describeRemoteLink = (): string | null => {
  const session = active
  if (session === null) return null
  return `${session.server.url}#${session.host.deviceId.slice(0, 8)} transport=${session.link.transport} state=${session.link.state}`
}
