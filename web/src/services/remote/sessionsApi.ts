/**
 * 远端 DSH 的**业务端点层**（`harness.remote.call` / `harness.remote.stream.open` 的 endpoint 封装）。
 *
 * 只做四件事：拼参数、发 RPC、拆官方 envelope、把错误码变成可读文案。
 * 不持有连接、不存状态（那是 `store.ts`），不碰传输（那是 `core/`）。
 *
 * ## 1. 参数包装（写错就是 `METHOD_NOT_FOUND` / `gateway/arguments-invalid`）
 *
 * 加密通道上能发的顶层方法只有固定集合；业务端点必须当成 `harness.remote.call` 的
 * `endpoint` 参数，且 `payload` 固定是 `{ args: <端点自己的参数对象> }`：
 *
 * ```json
 * { "endpoint": "session/list", "payload": { "args": { "_request": {} } } }
 * ```
 *
 * 证据：`docs/protocol.md:767-783`（请求示例）、`packages/client-core/src/harness-alpha-client.ts:1181-1183`
 * （`callValue()` 统一包 `{args}`）、`packages/plugin/src/harness-remote-bridge.ts:63-70`（schema）。
 * 开流同理：`harness.remote.stream.open` 的 `{streamId, endpoint, payload:{args}}` 由 `core/rpcMux.ts`
 * 负责补 `streamId`，本文件只把 `{args}` 交进去。
 *
 * ## 2. 用到的端点（P0+P1「能聊天」）
 *
 * | 函数 | 端点 | 类型 | 参数（args 内部） | 依据 |
 * |---|---|---|---|---|
 * | `listSessions` | `session/list` | call | `{_request:{}}` | input-B §2.2 |
 * | `openFollow` | `session/follow` | **stream** | `{request:{address,maxMessages,assistantStream}}` | §2.3 |
 * | `pageHistory` | `session/page` | call | `{request:{address,throughSeq,beforeSeq,maxMessages}}` | §2.3 |
 * | `sendPrompt` | `session/prompt` | call | `{request:{requestId,sessionId,mode,content,clientTimeZone}}` | §2.4 |
 * | `cancelSession` | `session/cancel` | call | `{request:{sessionId}}` | §2.4 |
 * | `respondApproval` | `$events/result` | call | `{clientId,eventId,outcome}` | §2.6 |
 * | `openEvents` | `$events` | **stream** | `{}` → `{args:{}}` | §2.5 |
 *
 * ## 3. 三条硬约束
 *
 * - **审批只允许 `allowed-once` / `rejected`**（v1 安全不变量 8，`docs/protocol.md:2021`）；
 *   UI 层的 `allow_once|deny` 是语义别名，只在这里翻译，别往线上传 `allow_session`。
 * - **`PERMISSION_NOT_PENDING` 表示句柄已失效**，不要重试（§2.6：断线后审批句柄失效，禁止重放）。
 * - **`session/list` 可能被 Host 截断**（2048 行预算，input-B §2.2），返回的行数不代表全部。
 */

import { RemoteApiError } from './serverApi.js'

/* ────────────────────────────────────────────────────────────────────────
 * 一、传输依赖（结构类型：`core/index.ts` 的 `SecureLink` 天然满足）
 * ──────────────────────────────────────────────────────────────────────── */

/** 本文件只需要这两个能力；`SecureLink` 结构上兼容。 */
export interface RemoteCallTarget {
  rpc<T = unknown>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T>
  openStream(endpoint: string, payload: unknown, opts?: { timeoutMs?: number }): Promise<RemoteStreamHandle>
}

/** 流的句柄（`core/rpcMux.ts` 的 `RemoteStreamHandle` 结构镜像）。 */
export interface RemoteStreamHandle {
  readonly streamId: string
  close(): Promise<void>
}

/* ────────────────────────────────────────────────────────────────────────
 * 二、方法名 / 端点常量
 * ──────────────────────────────────────────────────────────────────────── */

/** 三个载体方法（顶层 RPC，`params` 不再包 `{endpoint,payload}`）。 */
export const RemoteMethods = {
  call: 'harness.remote.call',
  streamOpen: 'harness.remote.stream.open',
  streamClose: 'harness.remote.stream.close',
} as const

/** 业务端点（`harness.remote.call` 的 `endpoint`）。 */
export const RemoteEndpoints = {
  sessionList: 'session/list',
  sessionFollow: 'session/follow',
  sessionPage: 'session/page',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel',
  events: '$events',
  eventsResult: '$events/result',
} as const

/** `session/follow` / `session/page` 的默认窗口（官方默认 60，见 client-core:793）。 */
export const DEFAULT_HISTORY_PAGE_SIZE = 60

/** 单次 unary 调用的默认预算；流开的预算要给足（首帧可能是 4 MiB 的 snapshot）。 */
const DEFAULT_CALL_TIMEOUT_MS = 30_000
const STREAM_OPEN_TIMEOUT_MS = 30_000

/* ────────────────────────────────────────────────────────────────────────
 * 三、错误：码 → 中文文案 + i18n key
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 给 UI 的错误描述。
 * `code` 是**机器码**（原样来自 Host / 链路层，UI 用它分流），
 * `i18nKey` 是**文案键**（i18n 表还没加这些键时可直接显示 `text`）。
 */
export interface RemoteErrorInfo {
  code: string
  i18nKey: string
  /** 中文可读文案（已经带上 Host 的原始 message，便于定位）。 */
  text: string
}

interface ErrorText {
  key: string
  text: string
}

/**
 * 已知错误码的中文文案。要求映射的四个在 §2.2 里点名过：
 * `METHOD_NOT_FOUND` / `CAPABILITY_NOT_SUPPORTED` / `RPC_TIMEOUT` / `PERMISSION_NOT_PENDING`。
 */
const ERROR_TEXTS: Record<string, ErrorText> = {
  // ── 协议 / 方法面 ──
  METHOD_NOT_FOUND: {
    key: 'remote.error.methodNotFound',
    text: '远端没有这个接口：DSH 版本可能过旧，或该能力没装。协议要求 fail-closed，本机不会偷偷降级',
  },
  CAPABILITY_NOT_SUPPORTED: {
    key: 'remote.error.capabilityNotSupported',
    text: '远端没有声明这项能力（capability 未协商成功），请升级 Host 或换一台',
  },
  METHOD_NOT_ALLOWED: {
    key: 'remote.error.methodNotAllowed',
    text: '远端不允许这样调用（方法名或载体用错了）',
  },
  INVALID_MESSAGE: {
    key: 'remote.error.invalidMessage',
    text: '两边的协议帧对不上（字段不合法），这通常是版本不匹配',
  },
  UNSUPPORTED_VERSION: {
    key: 'remote.error.unsupportedVersion',
    text: '远端协议版本与本机不兼容',
  },
  FRAME_TOO_LARGE: {
    key: 'remote.error.frameTooLarge',
    text: '要发/要收的帧超过体积上限',
  },
  RESPONSE_TOO_LARGE: {
    key: 'remote.error.responseTooLarge',
    text: '响应超过 4 MiB，需要走 transfer 分块（P0 暂不支持）',
  },
  RATE_LIMITED: {
    key: 'remote.error.rateLimited',
    text: '请求太频繁或并发数超限，请稍后重试',
  },
  REQUEST_CONFLICT: {
    key: 'remote.error.requestConflict',
    text: '同一请求发生冲突（可能重复提交了）',
  },
  // ── 时间 / 超时 ──
  RPC_TIMEOUT: {
    key: 'remote.error.rpcTimeout',
    text: '远端在预期时间内没有响应，请检查网络后重试',
  },
  RPC_ABORTED: {
    key: 'remote.error.rpcAborted',
    text: '请求已取消',
  },
  // ── 审批 / 权限 ──
  PERMISSION_NOT_PENDING: {
    key: 'remote.error.permissionNotPending',
    text: '这条审批已经失效（可能已在别处处理、已超时，或重连后句柄作废）。请刷新会话',
  },
  PERMISSION_DENIED: {
    key: 'remote.error.permissionDenied',
    text: '远端拒绝了这次操作（权限不足）',
  },
  AGENT_BUSY: {
    key: 'remote.error.agentBusy',
    text: 'Agent 正忙（子会话必须通过父会话寻址，或当前轮还没结束）',
  },
  // ── 会话 ──
  SESSION_NOT_FOUND: {
    key: 'remote.error.sessionNotFound',
    text: '会话不存在（可能已被删除或归档）',
  },
  SESSION_NOT_READY: {
    key: 'remote.error.sessionNotReady',
    text: '会话还没准备好（Host 正在加载），请稍后再试',
  },
  FULL_RESYNC_REQUIRED: {
    key: 'remote.error.fullResyncRequired',
    text: '时间线需要整体重同步（请重新打开会话）',
  },
  // ── 鉴权 ──
  AUTH_REQUIRED: { key: 'remote.error.authRequired', text: '需要重新登录（缺少或失效的凭证）' },
  AUTH_INVALID: { key: 'remote.error.authInvalid', text: '账号或密码不正确' },
  ACCOUNT_AUTH_REQUIRED: { key: 'remote.error.accountAuthRequired', text: '账号 token 无效，需要重新登录' },
  TOKEN_EXPIRED: { key: 'remote.error.tokenExpired', text: '登录已过期，需要刷新或重新登录' },
  DEVICE_REVOKED: { key: 'remote.error.deviceRevoked', text: '这台设备已被撤销，需要重新注册设备' },
  DEVICE_OWNERSHIP_REQUIRED: { key: 'remote.error.deviceOwnershipRequired', text: '设备归属校验失败，需要重新注册设备' },
  PEER_IDENTITY_MISMATCH: {
    key: 'remote.error.peerIdentityMismatch',
    text: '远端 Host 的身份公钥与本机 pin 的不一致，已拒绝连接（这是安全拦截，不是网络问题）',
  },
  // ── 连接 ──
  HOST_OFFLINE: { key: 'remote.error.hostOffline', text: '目标主机不在线' },
  CONNECTION_FAILED: { key: 'remote.error.connectionFailed', text: '连接失败，可以重试（协议允许重建 Noise 后重连）' },
  CONNECTION_REPLACED: { key: 'remote.error.connectionReplaced', text: '连接被另一台设备抢占，本机已停止重连' },
  CONNECTION_NOT_FOUND: { key: 'remote.error.connectionNotFound', text: '连接已不存在（服务端已清理）' },
  SECURE_CHANNEL_FAILED: { key: 'remote.error.secureChannelFailed', text: '安全通道建立/解密失败（Noise 握手没通过）' },
  TRANSPORT_CLOSED: { key: 'remote.error.transportClosed', text: '连接已断开' },
  RELAY_UNAVAILABLE: { key: 'remote.error.relayUnavailable', text: '中继不可用' },
  // ── 本地（不是远端给的码：本机在发请求之前就拦住了） ──
  NOT_CONNECTED: { key: 'remote.error.notConnected', text: '还没有连接到远端主机' },
  NO_HOST: { key: 'remote.error.noHost', text: '这个账号下没有可连接的 Host' },
  HOST_IDENTITY_MISSING: {
    key: 'remote.error.hostIdentityMissing',
    text: '拿不到目标主机的身份公钥（Noise IK 必需）',
  },
  IDENTITY_MISMATCH: { key: 'remote.error.identityMismatch', text: '本机设备身份与已注册的 deviceId 不一致' },
  EVENT_STREAM_NOT_READY: {
    key: 'remote.error.eventsNotReady',
    text: '远端事件流还没就绪，审批暂时应答不了',
  },
  EVENT_STREAM_CLOSED: { key: 'remote.error.eventsClosed', text: '远端事件流已关闭（审批与目录增量都收不到了）' },
  STREAM_CLOSED: { key: 'remote.error.streamClosed', text: '远端流已关闭' },
  SESSION_NOT_OPEN: { key: 'remote.error.sessionNotOpen', text: '还没有打开会话' },
  // ── 其它 ──
  HARNESS_UNAVAILABLE: { key: 'remote.error.harnessUnavailable', text: '远端 Harness 不可用' },
  HARNESS_VERSION_INCOMPATIBLE: {
    key: 'remote.error.harnessVersionIncompatible',
    text: '远端 Harness 版本与本机不兼容',
  },
  INTERNAL_ERROR: { key: 'remote.error.internal', text: '远端内部错误' },
  UNKNOWN_ERROR: { key: 'remote.error.unknown', text: '未知错误' },
  INVALID_ARGUMENT: { key: 'remote.error.invalidArgument', text: '参数不合法' },
  INVALID_RESPONSE: { key: 'remote.error.invalidResponse', text: '远端返回的数据不符合协议' },
  TIMEOUT: { key: 'remote.error.timeout', text: '请求超时' },
  NETWORK_ERROR: { key: 'remote.error.network', text: '网络不可用，请检查连接' },
}

/** 子系统扩展码按前缀分流（`gateway/*` 是 Typert 内层，不是 v1 标准码）。 */
const PREFIX_TEXTS: ErrorText[] = [
  { key: 'remote.error.gatewayRejected', text: '远端网关拒绝了这次请求' },
]

const prefixText = (code: string): ErrorText | undefined =>
  code.startsWith('gateway/')
    ? PREFIX_TEXTS[0]
    : code.startsWith('CODEX_')
      ? { key: 'remote.error.codexRejected', text: 'CodeX 后端拒绝了这次请求' }
      : code.startsWith('FILE_VIEWER_')
        ? { key: 'remote.error.fileViewerRejected', text: '远端文件预览拒绝了这次请求' }
        : code.startsWith('UPLOAD_')
          ? { key: 'remote.error.uploadRejected', text: '远端上传被拒绝' }
          : undefined

/** 错误码 → 文案键 + 中文文案（未知码原样保留 `code`，文案给兜底句）。 */
export const remoteErrorInfo = (code: string): { i18nKey: string; text: string } => {
  const known = ERROR_TEXTS[code] ?? prefixText(code)
  if (known !== undefined) return { i18nKey: known.key, text: known.text }
  return {
    i18nKey: 'remote.error.unclassified',
    text: `远端返回了未分类的错误（${code}）`,
  }
}

const codeOf = (value: unknown): string | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const code = (value as { code?: unknown }).code
  return typeof code === 'string' && code.length > 0 ? code : undefined
}

/** 从任意 error-like 上取可读 message（`Error` / `{message}` / 字符串都认）。 */
const messageOf = (value: unknown): string => {
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null) {
    const message = (value as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return ''
}

/**
 * 把任意异常收敛成给 UI 的 `{ code, i18nKey, text }`。
 *
 * `text` 以中文文案开头，后面补 Host 的原始 message（便于定位，但绝不包含 token）。
 */
export const describeRemoteError = (error: unknown): RemoteErrorInfo => {
  const code = codeOf(error) ?? 'UNKNOWN_ERROR'
  const { i18nKey, text } = remoteErrorInfo(code)
  const raw = messageOf(error).trim()
  // 原始 message 只在「补充了信息」时才拼上去：重复、空、带 Bearer 的一律丢弃。
  const detail = raw.length === 0 || raw.includes('Bearer') || text.includes(raw) ? '' : `（${raw}）`
  return { code, i18nKey, text: `${text}${detail}` }
}

/** 方便 UI 直接问「这个码的中文是什么」。 */
export const remoteErrorText = (code: string): string => describeRemoteError({ code }).text

/* ────────────────────────────────────────────────────────────────────────
 * 四、工具
 * ──────────────────────────────────────────────────────────────────────── */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 客户端生成的请求 id（幂等键；协议 §4.2 推荐 UUIDv7/ULID）。 */
export const newRequestId = (): string => {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (typeof uuid === 'string' && uuid.length > 0) return uuid
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

/** 会话时区（`session/prompt.clientTimeZone`；拿不到就不传）。 */
export const clientTimeZone = (): string | undefined => {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof zone === 'string' && zone.length > 0 ? zone : undefined
  } catch {
    return undefined
  }
}

/**
 * 官方 `SessionAddress`（input-B §2.3）。
 * **子会话必须走父会话寻址**，否则会被 `session/agent-busy` 拒掉。
 */
export const sessionAddress = (
  sessionId: string,
  parentSessionId?: string,
): { kind: 'session'; sessionId: string } | { kind: 'subagent'; parentSessionId: string; childSessionId: string; mode: 'unknown' } =>
  parentSessionId === undefined
    ? { kind: 'session', sessionId }
    : { kind: 'subagent', parentSessionId, childSessionId: sessionId, mode: 'unknown' }

/**
 * `harness.remote.call` 的官方 envelope 拆包。
 *
 * Host 侧（`harness-remote-bridge`）返回 `{ok:true, value?}` 或 `{ok:false, error}`；
 * 直接返回裸值的老实现也照收（与 client-core `callValue()` 同一套判断）。
 */
const unwrapEnvelope = <T>(endpoint: string, result: unknown): T => {
  if (isRecord(result) && result.ok === true) return result.value as T
  if (isRecord(result) && result.ok === false && isRecord(result.error)) {
    const error = result.error
    throw new RemoteApiError(
      typeof error.code === 'string' && error.code.length > 0 ? error.code : 'INTERNAL_ERROR',
      typeof error.message === 'string' && error.message.length > 0 ? error.message : `远端拒绝了 ${endpoint}`,
      undefined,
      error.retryable === true,
      isRecord(error.details) ? error.details : undefined,
    )
  }
  return result as T
}

/** 一次业务调用：`harness.remote.call` + `{endpoint, payload:{args}}`。 */
export const callEndpoint = async <T>(
  target: RemoteCallTarget,
  endpoint: string,
  args: Record<string, unknown>,
  timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
): Promise<T> => {
  const result = await target.rpc<unknown>(
    RemoteMethods.call,
    { endpoint, payload: { args } },
    { timeoutMs },
  )
  return unwrapEnvelope<T>(endpoint, result)
}

/* ────────────────────────────────────────────────────────────────────────
 * 五、会话列表（`session/list`）
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 一行业务摘要。比 store 的 `RemoteSessionSummary` 多带 Host 侧的筛选依据
 * （`parentSessionId` / `origin` / `running` / `blank`），由 store 决定怎么投影。
 */
export interface RemoteSessionRow {
  sessionId: string
  title?: string
  workspaceId?: string
  updatedAt?: number
  running?: boolean
  blank?: boolean
  parentSessionId?: string
  origin?: string
  cwd?: string
  agentPreset?: string
  pinned?: boolean
}

/**
 * 解析 `SessionSummary`（input-B §2.2 的字段表）。
 *
 * 两个必须照做的 Host 行为：
 *   1. 标题投影：Harness 0.2.2 去掉了行上的 `title`，Host 会从
 *      `projections.values.title` 把它抬回行上 —— 但**客户端也应自己兜一层**，
 *      老 Host 可能只有投影。
 *   2. 行预算：超过 2048 行时 Host 只保留根会话并按 `updatedAt` 倒序截断，
 *      所以「拿到的行数」不等于「全部会话数」。
 */
export const parseSessionRow = (value: unknown): RemoteSessionRow | null => {
  if (!isRecord(value) || typeof value.sessionId !== 'string' || value.sessionId.length === 0) return null
  const projection = isRecord(value.projections) ? value.projections : undefined
  const values = projection !== undefined && isRecord(projection.values) ? projection.values : undefined
  const title = typeof value.title === 'string' && value.title.length > 0
    ? value.title
    : typeof values?.title === 'string' && values.title.length > 0 ? values.title : undefined
  const workspaceId = typeof values?.workspaceId === 'string'
    ? values.workspaceId
    : typeof value.workspaceId === 'string' ? value.workspaceId : undefined
  const pinned = typeof values?.pinned === 'boolean' ? values.pinned : undefined
  return {
    sessionId: value.sessionId,
    ...(title === undefined ? {} : { title }),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? { updatedAt: value.updatedAt } : {}),
    ...(typeof value.running === 'boolean' ? { running: value.running } : {}),
    ...(typeof value.blank === 'boolean' ? { blank: value.blank } : {}),
    ...(typeof value.parentSessionId === 'string' ? { parentSessionId: value.parentSessionId } : {}),
    ...(typeof value.origin === 'string' ? { origin: value.origin } : {}),
    ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}),
    ...(typeof value.agentPreset === 'string' ? { agentPreset: value.agentPreset } : {}),
    ...(pinned === undefined ? {} : { pinned }),
  }
}

/** `session/list`（call）。返回**可能被截断**的列表，顺序按 Host 给的来。 */
export const listSessions = async (target: RemoteCallTarget): Promise<RemoteSessionRow[]> => {
  // 参数是 `{_request:{}}`（不是空对象）：Host 的 schema 按 `_request` 收。
  const result = await callEndpoint<{ items?: unknown[] }>(target, RemoteEndpoints.sessionList, { _request: {} })
  const items = Array.isArray(result?.items) ? result.items : Array.isArray(result) ? result : []
  return items.flatMap(item => {
    const row = parseSessionRow(item)
    return row === null ? [] : [row]
  })
}

/* ────────────────────────────────────────────────────────────────────────
 * 六、历史（`session/follow` 快照 + `session/page` 上翻）
 * ──────────────────────────────────────────────────────────────────────── */

export interface OpenFollowOptions {
  /** 首屏消息条数；缺省 60（官方默认）。 */
  maxMessages?: number
  /**
   * 是否要求 Host 推 V3 的实时助手输出（`assistant-stream`）。
   * 只有 `header.version === 3` / `harness.remote.v3` 才有意义。
   */
  assistantStream?: boolean
  /** 子会话的父会话 id（子会话必须走父会话寻址）。 */
  parentSessionId?: string
  timeoutMs?: number
}

/**
 * 打开会话：`session/follow` 开流。
 *
 * 返回的是**流句柄**，首帧（`{type:'snapshot'}`）从 `onStreamEvent` 回来，
 * 由调用方（store）用 `parseSnapshot()` 解析。注意 Host 可能把 snapshot 发在
 * `stream.open` 的 response 之前 —— `core/rpcMux.ts` 已按 streamId 路由，
 * 但调用方要能容忍「先收到帧、后 resolve」。
 */
export const openFollow = async (
  target: RemoteCallTarget,
  sessionId: string,
  options: OpenFollowOptions = {},
): Promise<RemoteStreamHandle> => {
  const request: Record<string, unknown> = {
    address: sessionAddress(sessionId, options.parentSessionId),
    maxMessages: options.maxMessages ?? DEFAULT_HISTORY_PAGE_SIZE,
  }
  if (options.assistantStream === true) request.assistantStream = true
  return await target.openStream(
    RemoteEndpoints.sessionFollow,
    { args: { request } },
    { timeoutMs: options.timeoutMs ?? STREAM_OPEN_TIMEOUT_MS },
  )
}

export interface HistoryPage {
  records: unknown[]
  hasMore: boolean
}

export interface PageHistoryOptions {
  /** 当前持有的最新 seq（follow 游标）。 */
  throughSeq?: number
  /** 只取「严格早于 beforeSeq」的旧页；通常是最旧一行的 seq。 */
  beforeSeq: number
  maxMessages?: number
  parentSessionId?: string
  timeoutMs?: number
}

/**
 * 上翻一页历史：`session/page`。
 *
 * 语义（input-B §2.3）：
 *   - 有 `beforeSeq` → 取「严格早于它」的旧页；
 *   - `throughSeq` 是最新持有的 seq（follow 游标），缺省用 `beforeSeq` 顶上。
 */
export const pageHistory = async (
  target: RemoteCallTarget,
  sessionId: string,
  options: PageHistoryOptions,
): Promise<HistoryPage> => {
  const request: Record<string, unknown> = {
    address: sessionAddress(sessionId, options.parentSessionId),
    throughSeq: options.throughSeq ?? options.beforeSeq,
    beforeSeq: options.beforeSeq,
    maxMessages: options.maxMessages ?? DEFAULT_HISTORY_PAGE_SIZE,
  }
  const result = await callEndpoint<{ records?: unknown[]; hasMore?: boolean }>(
    target,
    RemoteEndpoints.sessionPage,
    { request },
    options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
  )
  return {
    records: Array.isArray(result?.records) ? result.records : [],
    hasMore: result?.hasMore === true,
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * 七、发消息 / 中断
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * `session/prompt` 的一个 content 块。
 * - `file` 的 `receiptId` 来自 `fileUploads/upload`（P1）；
 * - `image` 的 `data` 是**标准 base64**（不是 base64url）。
 */
export type RemotePromptAttachment =
  | { type: 'file'; receiptId: string }
  | { type: 'image'; mediaType: string; data: string; name?: string }

export interface SendPromptOptions {
  /** 幂等键；缺省在函数内生成。要与乐观行的 `requestRpcId` 对齐时必须传。 */
  requestId?: string
  /** `queue`（排队到下一轮，默认）或 `steer`（打断当前轮）。 */
  mode?: 'queue' | 'steer'
  timeoutMs?: number
}

/**
 * 发一条消息：`session/prompt`（call）。
 *
 * **返回空值**：真正的结果全部走 `session/follow` 的事件（`turn/start` → 流式 → `turn/end`）。
 * `requestId` 幂等：同 id 重试不会重复执行，并且会被回显成 `user/message.source.rpcId`。
 */
export const sendPrompt = async (
  target: RemoteCallTarget,
  sessionId: string,
  text: string,
  attachments: readonly RemotePromptAttachment[] = [],
  options: SendPromptOptions = {},
): Promise<void> => {
  const files = attachments.filter((item): item is Extract<RemotePromptAttachment, { type: 'file' }> => item.type === 'file')
  const images = attachments.filter((item): item is Extract<RemotePromptAttachment, { type: 'image' }> => item.type === 'image')
  const content: Record<string, unknown>[] = [
    ...files.map(file => ({ type: 'file', receiptId: file.receiptId })),
    ...(text.length === 0 ? [] : [{ type: 'text', text }]),
    ...images.map(image => ({
      type: 'image',
      mediaType: image.mediaType,
      data: image.data,
      ...(image.name === undefined ? {} : { name: image.name }),
    })),
  ]
  // content 必须含非空白文本或附件，否则 Host 回 `gateway/bad-request`（input-B §2.4）。
  if (content.length === 0) {
    throw new RemoteApiError('INVALID_ARGUMENT', '消息不能为空：至少要有文本或一个附件')
  }
  const timeZone = clientTimeZone()
  const request: Record<string, unknown> = {
    requestId: options.requestId ?? newRequestId(),
    sessionId,
    mode: options.mode ?? 'queue',
    content,
    ...(timeZone === undefined ? {} : { clientTimeZone: timeZone }),
  }
  await callEndpoint<unknown>(
    target,
    RemoteEndpoints.sessionPrompt,
    { request },
    options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
  )
}

/**
 * 中断当前轮：`session/cancel`（call）。
 *
 * `accepted:true` **只表示已受理**（空闲时也返回 true）；真正的终态是
 * `turn/end` 且 `reason.kind === 'aborted'`（input-B §2.4）。
 */
export const cancelSession = async (
  target: RemoteCallTarget,
  sessionId: string,
  options: { timeoutMs?: number } = {},
): Promise<void> => {
  const result = await callEndpoint<{ accepted?: boolean }>(
    target,
    RemoteEndpoints.sessionCancel,
    { request: { sessionId } },
    options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
  )
  if (result?.accepted !== true) {
    throw new RemoteApiError('INVALID_RESPONSE', '远端没有确认这次中断请求（accepted ≠ true）')
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * 八、事件流与审批应答
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 打开 `$events` 流（Host → Client 的 Cordis 事件流）。
 *
 * 首条 item 必须是 `{type:'ready', clientId}`：**没等到 ready 就不能发业务**
 * （审批应答要用 `clientId`），P0 因此把它当成建连的最后一关。
 */
export const openEvents = async (target: RemoteCallTarget): Promise<RemoteStreamHandle> =>
  await target.openStream(RemoteEndpoints.events, { args: {} }, { timeoutMs: STREAM_OPEN_TIMEOUT_MS })

/**
 * UI 的审批语义（契约 §5 只允许这两个）。
 * 线上的合法值见 `APPROVAL_OUTCOMES`：`allowed-once` / `rejected`。
 */
export type ApprovalDecision = 'allow_once' | 'deny'

/** `$events/result.outcome.value` 的合法值（v1 只有这两个，禁止 `allow_session`）。 */
export const APPROVAL_OUTCOMES = {
  allow_once: 'allowed-once',
  deny: 'rejected',
} as const

export interface RespondApprovalInput {
  /** `$events` 的 `ready` 里的 clientId。 */
  clientId: string
  /** waterfall 的 eventId（同时充当 approvalId / rpcId）。 */
  eventId: string
  decision: ApprovalDecision
  timeoutMs?: number
}

/**
 * 应答一次工具审批：`$events/result`（call）。
 *
 * ```json
 * { "endpoint": "$events/result",
 *   "payload": { "args": { "clientId": "…", "eventId": "…",
 *                          "outcome": { "kind": "result", "value": "allowed-once" } } } }
 * ```
 *
 * 失败分流：
 *   - `PERMISSION_NOT_PENDING` → 句柄已失效，**不要重试**（只清理本地 pending）；
 *   - `RPC_TIMEOUT` → 结果未知，同样不自动重放（禁止重放 mutation）。
 */
export const respondApproval = async (
  target: RemoteCallTarget,
  input: RespondApprovalInput,
): Promise<void> => {
  if (input.clientId.length === 0) {
    throw new RemoteApiError('EVENT_STREAM_NOT_READY', 'clientId 还没拿到')
  }
  await callEndpoint<unknown>(
    target,
    RemoteEndpoints.eventsResult,
    {
      clientId: input.clientId,
      eventId: input.eventId,
      outcome: { kind: 'result', value: APPROVAL_OUTCOMES[input.decision] },
    },
    input.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
  )
}
