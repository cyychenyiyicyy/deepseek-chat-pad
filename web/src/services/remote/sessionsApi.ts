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
 * W1（新建会话 / 工作区 / 会话管理，见 `newSessionStore.ts`）追加的端点：
 *
 * | 函数 | 端点 | 类型 | 参数（args 内部） | 依据 |
 * |---|---|---|---|---|
 * | `openWorkspaceFollow` | `workspace/follow` | **stream** | `{}` → 首帧 `{type:'baseline',value}` | §2.1 |
 * | `createWorkspace` | `workspace/create` | call | `{request:{path}}` | §2.1 |
 * | `listDirectory` | `directoryPicker/list` | call | `{path?}` | §2.8.1 |
 * | `createSession` | `session/create` | call | `{request:{workspaceId?,cwd?,sessionId?,agentPreset?}}` | §2.4 |
 * | `renameSession` | `session/rename` | call | `{request:{sessionId,title}}` | §2.4 |
 * | `forkSession` | `session/fork` | call | `{request:{sessionId,atSeq?}}` | §2.4 |
 * | `searchSessions` | `session/search` | call | `{request:{query}}` | §2.2 |
 * | `archiveSession` / `unarchiveSession` | `workspace/archiveSession` / `workspace/unarchiveSession` | call | `{request:{sessionId,stopActivity?}}` / `{request:{sessionId}}` | §2.1 |
 * | `pinSession` / `unpinSession` | `workspace/pinSession` / `workspace/unpinSession` | call | `{request:{sessionId}}` | §2.1 |
 * | `fetchPermissionCatalog` | `permissionPresets/catalog` | call | `{}` | §2.10 |
 * | `fetchAgentPresets` | `agentPresets/list` | call | `{}` | §2.10 |
 * | `fetchModelCatalog` | `session/modelCatalog` | call | `{}` | §2.10（**只读**：模型切换归 W2） |
 * | `applyPermissionPreset` | `commands/execute` | call | `{agentId,line:'/permission <preset>',submittedAttachments:[]}` | §2.10（切预设只能走这条） |
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
  // ── W1：工作区 / 新建会话 / 会话管理（input-B §2.1、§2.2、§2.4、§2.10） ──
  workspaceFollow: 'workspace/follow',
  workspaceCreate: 'workspace/create',
  workspaceArchiveSession: 'workspace/archiveSession',
  workspaceUnarchiveSession: 'workspace/unarchiveSession',
  workspacePinSession: 'workspace/pinSession',
  workspaceUnpinSession: 'workspace/unpinSession',
  directoryPickerList: 'directoryPicker/list',
  sessionCreate: 'session/create',
  sessionRename: 'session/rename',
  sessionFork: 'session/fork',
  sessionSearch: 'session/search',
  permissionCatalog: 'permissionPresets/catalog',
  agentPresetsList: 'agentPresets/list',
  agentPresetsSelect: 'agentPresets/select',
  modelCatalog: 'session/modelCatalog',
  commandsExecute: 'commands/execute',
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
  SESSION_WRITER_HELD: {
    key: 'remote.error.sessionWriterHeld',
    text: '这个会话正被另一处占用（另一个进程正持有写入权），不能接管',
  },
  // ── 工作区 / 会话管理（W1） ──
  WORKSPACE_NOT_FOUND: {
    key: 'remote.error.workspaceNotFound',
    text: '远端没有这个工作区（可能已被删除），请重新选一个',
  },
  WORKSPACE_PATH_INVALID: {
    key: 'remote.error.workspacePathInvalid',
    text: '工作区路径必须是绝对路径，且不能包含 NUL 字符',
  },
  COMMAND_FAILED: {
    key: 'remote.error.commandFailed',
    text: '远端拒绝了这条命令（斜杠命令执行失败）',
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
  observeRemoteTarget(target)
  const result = await target.rpc<unknown>(
    RemoteMethods.call,
    { endpoint, payload: { args } },
    { timeoutMs },
  )
  return unwrapEnvelope<T>(endpoint, result)
}

/* ────────────────────────────────────────────────────────────────────────
 * 四·补、连接观察者（给 W1 的独立 store 复用现有连接，不动 store.ts）
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 本模块**观察**到的最近一次调用目标（= `store.ts` 里那个 `ActiveSession.link`）。
 *
 * 为什么需要：`store.ts` 的 `active` 是模块私有的，而 W1 的 `newSessionStore.ts`
 * 又必须能发 `workspace/follow` / `session/create` 这些端点。任务边界不允许改
 * `store.ts`（它由 W2 独占）也不允许新增 action，所以这里做一个**纯只读观察者**：
 * 业务层每次真正调用都会把 target 记下来，别人要用时拿走同一个引用即可。
 *
 * 用法纪律（`newSessionStore.ts` 已经这么做了）：
 *   - 只能在 `useRemoteStore.getState().phase === 'ready'` 时用它（否则是上一代连接的死引用）；
 *   - 只拿它发请求，不持有、不改、不 dispose（连接生命周期仍归 `store.ts`）。
 */
let observedTarget: RemoteCallTarget | null = null

/** 记一次调用目标（`callEndpoint` / 开流函数内部调用，业务代码不必手动调）。 */
export const observeRemoteTarget = (target: RemoteCallTarget | null): void => {
  observedTarget = target
}

/** 最近一次观察到的调用目标（没有过就返回 `null`）。 */
export const lastRemoteTarget = (): RemoteCallTarget | null => observedTarget

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
  observeRemoteTarget(target)
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
export const openEvents = async (target: RemoteCallTarget): Promise<RemoteStreamHandle> => {
  observeRemoteTarget(target)
  return await target.openStream(RemoteEndpoints.events, { args: {} }, { timeoutMs: STREAM_OPEN_TIMEOUT_MS })
}

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

/* ────────────────────────────────────────────────────────────────────────
 * 九、工作区 / 目录（`workspace/follow`、`workspace/create`、`directoryPicker/list`）
 *
 * 依据：input-B §2.1（工作区表）、§2.8.1（`directoryPicker/list`）。
 * 数据层只做「解析 + 调用」，不缓存任何东西 —— 缓存属于 `newSessionStore.ts`。
 * ──────────────────────────────────────────────────────────────────────── */

/** `WorkspaceView`（input-B §2.1，证据 `harness-alpha-client.ts:126-133`）。 */
export interface RemoteWorkspace {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
  createdAt?: string
  updatedAt?: string
}

/** `workspace/follow` 首帧 `baseline` 的解析结果。 */
export interface RemoteWorkspaceList {
  items: RemoteWorkspace[]
  archivedSessionIds: string[]
  /** 老 Host 可能没有这一项 —— 缺省是空数组，UI 不要据此判断「没置顶过」。 */
  pinnedSessionIds: string[]
}

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : []

/** 解析一行 `WorkspaceView`（缺 `workspaceId` 直接丢，与官方客户端同一判据）。 */
export const parseWorkspace = (value: unknown): RemoteWorkspace | null => {
  if (!isRecord(value) || typeof value.workspaceId !== 'string' || value.workspaceId.length === 0) return null
  return {
    workspaceId: value.workspaceId,
    path: typeof value.path === 'string' ? value.path : '',
    title: typeof value.title === 'string' ? value.title : '',
    sessionIds: stringList(value.sessionIds),
    ...(typeof value.createdAt === 'string' ? { createdAt: value.createdAt } : {}),
    ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}),
  }
}

/**
 * 解析 `workspace/follow` 的首帧。
 *
 * 首帧**必须**是 `{type:'baseline', value:{items, archivedSessionIds, pinnedSessionIds?}}`
 * （input-B §2.1，证据 `harness-alpha-client.ts:970-982`）；不是 baseline 就返回 `null`，
 * 调用方据此判定「这台 Host 的工作区流不可用」，而不是拿半截数据往上画。
 */
export const parseWorkspaceBaseline = (frame: unknown): RemoteWorkspaceList | null => {
  if (!isRecord(frame) || frame.type !== 'baseline' || !isRecord(frame.value)) return null
  const value = frame.value
  return {
    items: Array.isArray(value.items) ? value.items.flatMap((item) => {
      const parsed = parseWorkspace(item)
      return parsed === null ? [] : [parsed]
    }) : [],
    archivedSessionIds: stringList(value.archivedSessionIds),
    pinnedSessionIds: stringList(value.pinnedSessionIds),
  }
}

/**
 * 打开 `workspace/follow`（stream）。首帧是 baseline，之后是增量；
 * 只想拿列表时读完首帧就可以 `close()`（官方客户端 `workspaceList()` 就是这么做的）。
 */
export const openWorkspaceFollow = async (
  target: RemoteCallTarget,
  options: { timeoutMs?: number } = {},
): Promise<RemoteStreamHandle> => {
  observeRemoteTarget(target)
  return await target.openStream(
    RemoteEndpoints.workspaceFollow,
    { args: {} },
    { timeoutMs: options.timeoutMs ?? STREAM_OPEN_TIMEOUT_MS },
  )
}

/** 把用户输入的工作区路径收敛成合法形态；不合法就抛 `WORKSPACE_PATH_INVALID`。 */
export const normalizeWorkspacePath = (raw: string): string => {
  const path = raw.trim()
  if (path.length === 0 || path.includes('\u0000')) {
    throw new RemoteApiError('WORKSPACE_PATH_INVALID', '工作区路径不能为空，也不能包含 NUL 字符')
  }
  // 「绝对路径」两条判据：POSIX 的 `/…`，或 Windows 的 `<盘符>:\…` / `\\server\share`。
  const absolute = path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
  if (!absolute) {
    throw new RemoteApiError('WORKSPACE_PATH_INVALID', '工作区路径必须是绝对路径')
  }
  return path
}

/**
 * 注册（必要时递归创建）一个工作区：`workspace/create`（call）。
 *
 * Host 的边界（input-B §2.1）：拒绝空路径 / NUL / 相对路径 / 根目录；创建失败时
 * **保留已建目录**，不递归清理。`created:false` 表示目录本来就在、或该路径已注册过。
 */
export const createWorkspace = async (
  target: RemoteCallTarget,
  path: string,
  options: { timeoutMs?: number } = {},
): Promise<{ workspace: RemoteWorkspace; created: boolean }> => {
  const normalized = normalizeWorkspacePath(path)
  const result = await callEndpoint<{ workspace?: unknown; created?: boolean }>(
    target,
    RemoteEndpoints.workspaceCreate,
    { request: { path: normalized } },
    options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
  )
  const workspace = parseWorkspace(result?.workspace)
  if (workspace === null) {
    throw new RemoteApiError('INVALID_RESPONSE', '远端返回的工作区形状不合法（缺 workspaceId）')
  }
  return { workspace, created: result?.created === true }
}

/** `directoryPicker/list` 的一行。 */
export interface RemoteDirectoryEntry {
  name: string
  path: string
  hidden: boolean
}

/** `directoryPicker/list` 的返回（input-B §2.8.1；Dart 侧还认 `home` / `truncated`）。 */
export interface RemoteDirectoryListing {
  /** 当前目录（Host 回显的绝对路径）。 */
  path: string
  /** 家目录（旧 Host 可能不给）。 */
  home?: string
  entries: RemoteDirectoryEntry[]
  /** 条目被截断（目录太大）。 */
  truncated: boolean
}

/**
 * 列一层目录：`directoryPicker/list`（call）。
 *
 * 不传 `path` 时 Host 返回家目录。Host 不支持这个端点时会以
 * `METHOD_NOT_FOUND` / `METHOD_NOT_ALLOWED` 失败 —— 调用方据此把「浏览目录」整块隐藏。
 */
export const listDirectory = async (
  target: RemoteCallTarget,
  path?: string,
  options: { timeoutMs?: number } = {},
): Promise<RemoteDirectoryListing> => {
  const args: Record<string, unknown> = path === undefined || path.length === 0 ? {} : { path }
  const result = await callEndpoint<Record<string, unknown>>(
    target,
    RemoteEndpoints.directoryPickerList,
    args,
    options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
  )
  if (typeof result?.path !== 'string' || !Array.isArray(result.entries)) {
    throw new RemoteApiError('INVALID_RESPONSE', '远端返回的目录列表不合法（缺 path / entries）')
  }
  return {
    path: result.path,
    ...(typeof result.home === 'string' ? { home: result.home } : {}),
    entries: result.entries.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.name !== 'string') return []
      return [{
        name: entry.name,
        path: typeof entry.path === 'string' ? entry.path : '',
        hidden: entry.hidden === true,
      }]
    }),
    truncated: result.truncated === true,
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * 十、新建会话 / 会话管理（`session/create|rename|fork|search`、`workspace/*Session`）
 *
 * 依据：input-B §2.4（会话动作表）、§2.2（`session/search`）、§2.1（归档/置顶）。
 * ──────────────────────────────────────────────────────────────────────── */

/** `session/create` 的入参（`request` 内部；input-B §2.4 + Dart `session_api.dart:335-352`）。 */
export interface CreateSessionInput {
  /** 挂到某个工作区（其 `path` 会成为会话 cwd）。 */
  workspaceId?: string
  /** 裸目录（没有工作区时用）。 */
  cwd?: string
  /** adopt / resume 一个已存会话（被别的进程占用会 `session/writer-held`）。 */
  sessionId?: string
  /** agent preset（助手模式）。老 Host 的 strictCodec 会拒，见 `createSession`。 */
  agentPreset?: string
}

export interface CreatedSession {
  sessionId: string
  /** Host 回显的 agent preset（老 Host 不回）。 */
  agentPreset?: string
}

/** 拼 `session/create` 的 `request`：只带**有值**的字段，空串一律当作「没选」。 */
export const createSessionRequest = (input: CreateSessionInput): Record<string, unknown> => {
  const request: Record<string, unknown> = {}
  if (input.workspaceId !== undefined && input.workspaceId.length > 0) request.workspaceId = input.workspaceId
  if (input.cwd !== undefined && input.cwd.trim().length > 0) request.cwd = input.cwd.trim()
  if (input.sessionId !== undefined && input.sessionId.length > 0) request.sessionId = input.sessionId
  if (input.agentPreset !== undefined && input.agentPreset.length > 0) request.agentPreset = input.agentPreset
  return request
}

/**
 * 解析 `session/create` 的返回值。
 *
 * 只认 Host **回显**的 `agentPreset`：老 Host 的旧 decoder 会静默丢掉这个字段，此时
 * 我们不能替它宣称「preset 生效了」（那会让界面报一个假的成功）。
 */
const parseCreatedSession = (result: unknown): CreatedSession => {
  if (!isRecord(result) || typeof result.sessionId !== 'string' || result.sessionId.length === 0) {
    throw new RemoteApiError('INVALID_RESPONSE', '远端没有返回新建会话的 sessionId')
  }
  const echoed = typeof result.agentPreset === 'string' && result.agentPreset.length > 0 ? result.agentPreset : undefined
  return { sessionId: result.sessionId, ...(echoed === undefined ? {} : { agentPreset: echoed }) }
}

/**
 * 建完会话后补选 agent preset（老 Host / 无回显时）。
 *
 * 会话此时是**空的**，`agentPresets/select` 允许在「第一轮开始之前」设置模式
 * （`PRESET_LOCKED` 就是这个限制）。失败不冒充成功：返回不带 `agentPreset` 的结果。
 */
const applyAgentPresetAfterCreate = async (
  target: RemoteCallTarget,
  created: CreatedSession,
  agentPreset: string | undefined,
  timeoutMs: number,
): Promise<CreatedSession> => {
  if (agentPreset === undefined || agentPreset.length === 0) return created
  if (created.agentPreset === agentPreset) return created
  if (created.agentPreset !== undefined) return created // Host 回显了别的值：以 Host 为准
  try {
    const committed = await selectAgentPreset(target, created.sessionId, agentPreset, { timeoutMs })
    return { ...created, agentPreset: committed }
  } catch {
    // 会话已经建出来了：preset 没生效不该让「新建」失败（UI 只提示这一项没应用）。
    return created
  }
}

/**
 * 新建会话：`session/create`（call）。
 *
 * **agent preset 的兼容路径**（照 Host 自己的 `remote-session-tools.ts:301-342` 写）：
 *   1. 直接带 `{workspaceId, agentPreset}`；
 *   2. 老 Host 的 strictCodec 会以 `gateway/arguments-invalid` 拒绝 —— 此时**还没有建出任何
 *      会话**，可以安全地退回 `{workspaceId}` 重试一次；
 *   3. Host 没回显 `agentPreset`（旧 decoder 静默丢字段）时补一次 `agentPresets/select`。
 * 第三条失败不改变「会话已建出来」这个事实，所以只把 `agentPreset` 标成没生效。
 */
export const createSession = async (
  target: RemoteCallTarget,
  input: CreateSessionInput,
  options: { timeoutMs?: number } = {},
): Promise<CreatedSession> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
  const request = createSessionRequest(input)
  try {
    const result = await callEndpoint<unknown>(target, RemoteEndpoints.sessionCreate, { request }, timeoutMs)
    return await applyAgentPresetAfterCreate(target, parseCreatedSession(result), input.agentPreset, timeoutMs)
  } catch (error) {
    const code = codeOf(error)
    if (input.agentPreset === undefined || input.agentPreset.length === 0 || code !== 'gateway/arguments-invalid') {
      throw error
    }
  }
  // 老 Host 不认识 agentPreset：去掉它重来一次（此时会话肯定还没建出来）。
  const fallback = await callEndpoint<unknown>(
    target,
    RemoteEndpoints.sessionCreate,
    { request: createSessionRequest({ ...input, agentPreset: undefined }) },
    timeoutMs,
  )
  return await applyAgentPresetAfterCreate(target, parseCreatedSession(fallback), input.agentPreset, timeoutMs)
}


/** 给还没开始第一轮的会话选 agent preset：`agentPresets/select`（call）。 */
export const selectAgentPreset = async (
  target: RemoteCallTarget,
  sessionId: string,
  agentPreset: string,
  options: { timeoutMs?: number } = {},
): Promise<string> => {
  const result = await callEndpoint<unknown>(
    target,
    RemoteEndpoints.agentPresetsSelect,
    { agentId: sessionId, agentPreset },
    options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
  )
  return typeof result === 'string' && result.length > 0 ? result : agentPreset
}

/** 改标题：`session/rename`（call）。返回 Host 落定的标题（它会固定住，自动起名停止）。 */
export const renameSession = async (
  target: RemoteCallTarget,
  sessionId: string,
  title: string,
  options: { timeoutMs?: number } = {},
): Promise<string> => {
  const result = await callEndpoint<{ title?: string }>(
    target,
    RemoteEndpoints.sessionRename,
    { request: { sessionId, title } },
    options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
  )
  return typeof result?.title === 'string' && result.title.length > 0 ? result.title : title
}

/** 派生会话：`session/fork`（call）。不给 `atSeq` 就从最近的完整轮派生。 */
export const forkSession = async (
  target: RemoteCallTarget,
  sessionId: string,
  atSeq?: number,
  options: { timeoutMs?: number } = {},
): Promise<string> => {
  const request: Record<string, unknown> = { sessionId }
  if (atSeq !== undefined && Number.isSafeInteger(atSeq) && atSeq >= 0) request.atSeq = atSeq
  const result = await callEndpoint<{ sessionId?: string }>(
    target,
    RemoteEndpoints.sessionFork,
    { request },
    options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
  )
  if (typeof result?.sessionId !== 'string' || result.sessionId.length === 0) {
    throw new RemoteApiError('INVALID_RESPONSE', '远端没有返回派生出来的 sessionId')
  }
  return result.sessionId
}

/** `session/search` 的一条命中（每个会话最多一条，Host 侧已是「最佳匹配优先」）。 */
export interface RemoteSearchHit {
  sessionId: string
  snippet: string
}

export interface RemoteSearchResult {
  items: RemoteSearchHit[]
  hasMore: boolean
}

/**
 * 远端搜索：`session/search`（call）。
 *
 * 注意（input-B §2.2 + Dart 注释）：这个索引在 Host 上是**可选开启**的，默认
 * `openAt: never`，调用会以 `gateway/internal`（"session search is disabled …"）失败，
 * 查询为空或超过 500 字符则 `gateway/bad-request`。所以调用方必须准备本地回退
 * （`newSessionStore.ts` 的 `searchRemoteSessionsLocally`）。
 */
export const searchSessions = async (
  target: RemoteCallTarget,
  query: string,
  options: { timeoutMs?: number } = {},
): Promise<RemoteSearchResult> => {
  const trimmed = query.trim()
  if (trimmed.length === 0) return { items: [], hasMore: false }
  if (trimmed.length > 500) {
    throw new RemoteApiError('INVALID_ARGUMENT', '搜索词最多 500 个字符')
  }
  const result = await callEndpoint<{ items?: unknown[]; hasMore?: boolean }>(
    target,
    RemoteEndpoints.sessionSearch,
    { request: { query: trimmed } },
    options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
  )
  return {
    items: Array.isArray(result?.items)
      ? result.items.flatMap((item) => {
        if (!isRecord(item) || typeof item.sessionId !== 'string' || item.sessionId.length === 0) return []
        return [{ sessionId: item.sessionId, snippet: typeof item.snippet === 'string' ? item.snippet : '' }]
      })
      : [],
    hasMore: result?.hasMore === true,
  }
}

/** 归档 / 取消归档 / 置顶 / 取消置顶 的返回都是「整套 id 列表」（Host 是权威）。 */
export interface SessionFlagResult {
  sessionIds: string[]
}

const sessionFlagCall = async (
  target: RemoteCallTarget,
  endpoint: string,
  request: Record<string, unknown>,
  key: 'archivedSessionIds' | 'pinnedSessionIds',
  timeoutMs: number,
): Promise<SessionFlagResult> => {
  const result = await callEndpoint<Record<string, unknown>>(target, endpoint, { request }, timeoutMs)
  return { sessionIds: stringList(result?.[key]) }
}

/** 归档会话：`workspace/archiveSession`（`stopActivity` 默认不传，交给 Host）。 */
export const archiveSession = async (
  target: RemoteCallTarget,
  sessionId: string,
  options: { stopActivity?: boolean; timeoutMs?: number } = {},
): Promise<SessionFlagResult> => {
  const request: Record<string, unknown> = { sessionId }
  if (options.stopActivity === true) request.stopActivity = true
  return await sessionFlagCall(
    target,
    RemoteEndpoints.workspaceArchiveSession,
    request,
    'archivedSessionIds',
    options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
  )
}

/** 取消归档：`workspace/unarchiveSession`。 */
export const unarchiveSession = async (
  target: RemoteCallTarget,
  sessionId: string,
  options: { timeoutMs?: number } = {},
): Promise<SessionFlagResult> =>
  await sessionFlagCall(
    target,
    RemoteEndpoints.workspaceUnarchiveSession,
    { sessionId },
    'archivedSessionIds',
    options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
  )

/** 置顶：`workspace/pinSession`。 */
export const pinSession = async (
  target: RemoteCallTarget,
  sessionId: string,
  options: { timeoutMs?: number } = {},
): Promise<SessionFlagResult> =>
  await sessionFlagCall(
    target,
    RemoteEndpoints.workspacePinSession,
    { sessionId },
    'pinnedSessionIds',
    options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
  )

/** 取消置顶：`workspace/unpinSession`。 */
export const unpinSession = async (
  target: RemoteCallTarget,
  sessionId: string,
  options: { timeoutMs?: number } = {},
): Promise<SessionFlagResult> =>
  await sessionFlagCall(
    target,
    RemoteEndpoints.workspaceUnpinSession,
    { sessionId },
    'pinnedSessionIds',
    options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
  )

/* ────────────────────────────────────────────────────────────────────────
 * 十一、预设 / 模型目录（只读）
 *
 * 三个都是「拿不到就隐藏对应 UI」的可选能力：Host 版本差异很大，缺一个不影响新建会话。
 * **模型切换归 W2**（`session/modelCatalog` 的完整用法在 `sessionControls.ts`），
 * 这里只取 `default` 一项给新建面板显示「继承 Host 默认」到底继承的是谁。
 * ──────────────────────────────────────────────────────────────────────── */

/** 一个权限预设（`permissionPresets/catalog` 的 `options[]`）。 */
export interface RemotePermissionOption {
  value: string
  name: string
  description?: string
}

export interface RemotePermissionCatalog {
  options: RemotePermissionOption[]
  /** Host 的默认预设（老 Host 可能不给）；空串 = 不知道。 */
  defaultPreset: string
}

const parsePermissionOptions = (value: unknown): RemotePermissionOption[] =>
  Array.isArray(value)
    ? value.flatMap((option) => {
      if (!isRecord(option) || typeof option.value !== 'string' || option.value.length === 0) return []
      return [{
        value: option.value,
        name: typeof option.name === 'string' && option.name.length > 0 ? option.name : option.value,
        ...(typeof option.description === 'string' ? { description: option.description } : {}),
      }]
    })
    : []

/**
 * 权限预设目录：`permissionPresets/catalog`（call，`args` 是空对象）。
 *
 * 反过来记住一条：这个端点**只解决「选项从哪来」**，切预设仍必须走
 * `commands/execute` 的 `/permission <preset>`（input-B §2.10）。
 */
export const fetchPermissionCatalog = async (
  target: RemoteCallTarget,
  options: { timeoutMs?: number } = {},
): Promise<RemotePermissionCatalog> => {
  const result = await callEndpoint<{ options?: unknown; defaultPreset?: unknown }>(
    target,
    RemoteEndpoints.permissionCatalog,
    {},
    options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
  )
  return {
    options: parsePermissionOptions(result?.options),
    defaultPreset: typeof result?.defaultPreset === 'string' ? result.defaultPreset : '',
  }
}

/** 一个 agent preset（`agentPresets/list` 的 `presets[]`，证据 `client-core:756-771`）。 */
export interface RemoteAgentPreset {
  id: string
  name?: string
  description?: string
  isDefault: boolean
  /** 这个 preset 坏了（Host 报了原因），只展示、不选。 */
  broken?: string
}

/** agent preset 名册：`agentPresets/list`（call）。 */
export const fetchAgentPresets = async (
  target: RemoteCallTarget,
  options: { timeoutMs?: number } = {},
): Promise<RemoteAgentPreset[]> => {
  const result = await callEndpoint<{ presets?: unknown }>(
    target,
    RemoteEndpoints.agentPresetsList,
    {},
    options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
  )
  if (!Array.isArray(result?.presets)) return []
  return result.presets.flatMap((row) => {
    if (!isRecord(row) || typeof row.id !== 'string' || row.id.length === 0) return []
    return [{
      id: row.id,
      ...(typeof row.name === 'string' ? { name: row.name } : {}),
      ...(typeof row.description === 'string' ? { description: row.description } : {}),
      isDefault: row.isDefault === true,
      ...(typeof row.broken === 'string' ? { broken: row.broken } : {}),
    }]
  })
}

/** 模型选择（`{provider, model}` 的最小投影）。 */
export interface RemoteModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/**
 * Host 的默认模型：`session/modelCatalog`（call，`args` 是空对象）里只取 `default`。
 *
 * 拿不到 / 形状不对一律返回 `null`（新建面板就显示「继承 Host 默认」而不带具体名字）。
 * **不在这里做模型切换**：那是 W2 的 `sessionControls.ts`。
 */
export const fetchDefaultModel = async (
  target: RemoteCallTarget,
  options: { timeoutMs?: number } = {},
): Promise<RemoteModelSelection | null> => {
  const result = await callEndpoint<{ default?: unknown }>(
    target,
    RemoteEndpoints.modelCatalog,
    {},
    options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
  )
  if (!isRecord(result?.default)) return null
  const value = result.default
  if (typeof value.provider !== 'string' || typeof value.model !== 'string') return null
  if (value.provider.length === 0 || value.model.length === 0) return null
  return {
    provider: value.provider,
    model: value.model,
    ...(typeof value.reasoningEffort === 'string' ? { reasoningEffort: value.reasoningEffort } : {}),
  }
}

/** `/permission <preset>` 这条命令的合法 preset 形状（`client-core:745-749` 的同一判据）。 */
const PERMISSION_PRESET_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * 切某个会话的权限预设：`commands/execute`（call）的 `/permission <preset>`。
 *
 * 为什么不是独立 RPC：input-B §2.10 写得很明确 —— `permissionPresets/catalog` 只给选项，
 * 真正切预设只有斜杠命令这一条路（Host 侧也没有 `session/selectPermission` 端点）。
 * 返回 `kind:'error'` 时抛 `COMMAND_FAILED`（带 Host 的文案）。
 */
export const applyPermissionPreset = async (
  target: RemoteCallTarget,
  sessionId: string,
  preset: string,
  options: { timeoutMs?: number } = {},
): Promise<void> => {
  if (!PERMISSION_PRESET_PATTERN.test(preset)) {
    throw new RemoteApiError('INVALID_ARGUMENT', '权限预设名不合法（只允许小写字母、数字与连字符）')
  }
  const result = await callEndpoint<{ result?: { kind?: unknown; text?: unknown } }>(
    target,
    RemoteEndpoints.commandsExecute,
    { agentId: sessionId, line: `/permission ${preset}`, submittedAttachments: [] },
    options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
  )
  const kind = result?.result?.kind
  if (kind === 'error') {
    const text = typeof result?.result?.text === 'string' && result.result.text.length > 0
      ? result.result.text
      : '远端拒绝了权限预设'
    throw new RemoteApiError('COMMAND_FAILED', text)
  }
  if (kind !== 'success') {
    throw new RemoteApiError('INVALID_RESPONSE', '远端没有返回命令执行结果')
  }
}

