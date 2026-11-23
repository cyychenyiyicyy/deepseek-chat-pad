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
 * 5. **重启后自动连回来**（K4）：`autoConnectNow()` 读 `dsp.remote.last-session.v1`，
 *    按 `autoConnect.planAutoConnect()` 的判定静默重连（必要时先刷 token）。
 *
 * ## 三条纪律
 *
 * - **远程会话内容不落盘**：远程会话记录不写 SQLite / IndexedDB（方案 §4.3-②），连上就有、
 *   断开就没了。落盘的只有 S3 的凭据（`storage.ts`）与「上次连的是哪台 Host」
 *   （`autoConnect.ts` 的 `dsp.remote.last-session.v1`，**不含 token**）。
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
  clearLastSession,
  describeLastSession,
  isNativeShell,
  planAutoConnect,
  readLastSession,
  writeLastSession,
  type LastSession,
} from './autoConnect.js'
import {
  advanceRecoveryState,
  classifyFailure,
  INITIAL_RECOVERY_STATE,
  MAX_RECONNECT_ATTEMPTS,
  parseLinkCloseDetail,
  planRecoveryStep,
  type FailureInput,
  type FailureKind,
  type RecoveryState,
  type RecoveryStep,
} from './reconnect.js'
import {
  buildLinkOptions,
  createRemoteClient,
  type DeviceChange,
  type RemoteAccount,
  type RemoteClient,
  type RemoteConnectResult,
  type RemoteHost,
  type RemoteServer,
} from './connection.js'
import { createSecureLink, type SecureLink, type StreamEventPayload } from './core/index.js'
import type { RtcMode } from './core/rtcTransport.js'
import { isRemoteLinkError, LinkErrorCodes } from './core/errors.js'
import { installDeepLink } from './deepLink.js'
import { loadIdentity, loadOrCreateIdentity } from './identity.js'
import type { PairingOffer } from './devicePairing.js'
import type { SshHostInput } from './sshHost.js'

/** session/prompt 的发送模式：steer 插话、queue 排队（见 input-R1）。 */
type RemotePromptMode = 'queue' | 'steer'
import {
  requestBatteryExemption as requestBatteryExemptionApi,
  stopKeepAlive,
  syncKeepAlive,
  unsupportedKeepAlive,
  type KeepAliveSnapshot,
} from './keepAlive.js'
import {
  clearWork,
  deriveOtherWorkItem,
  NOTIFY_MAX_ITEMS,
  probeNotify,
  pushWorkState,
  resetNotify,
  type WorkItem,
  type WorkPush,
  type WorkState,
} from './notify.js'
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
  refreshToken as refreshTokenApi,
  type OAuthProvider,
} from './serverApi.js'
import {
  applyControlFrame,
  bindSessionControls,
  CONTROL_STREAM_ENDPOINT,
  ingestEventsItem,
  noteControlUnavailable,
  noteSessionPermissionPreset,
  noteSnapshotProjections,
  queuedPromptIds,
  selectControlSession,
  unbindSessionControls,
} from './sessionControls.js'
import { findAccount, findPinnedHost, loadAccounts, loadAdaptiveTransport, loadCompactHistory, loadServers, pinHostIdentityKey, removeAccount, upsertAccount, upsertServer } from './storage.js'
import { getConnectionIceServers } from './serverApi.js'
/*
 * [R9 红点] 待处理交互的记账规则放在 `chat-controls/promptModel.ts`（纯函数、有自测）。
 * 这里 import 过来只为了**同一份规则**：没有 React / CSS / store 的依赖，
 * 数据层引用它不会把界面拖进来；反过来 promptModel 也不 import 本文件（无环）。
 */
import {
  pendingInteractionCounts,
  settlePendingInteraction,
  shouldExpireApproval,
  trackPendingInteraction,
  type PendingInteractionCount,
  type PendingInteractionSets,
} from '../../components/remote/chat-controls/promptModel.js'
import {
  DEFAULT_HISTORY_PAGE_SIZE,
  cancelSession,
  describeRemoteError,
  listSessions,
  newRequestId,
  observeRemoteTarget,
  openEvents,
  openFollow,
  pageHistory,
  parseSessionRow,
  remoteErrorText,
  respondApproval as respondApprovalApi,
  sendPrompt,
  type ApprovalDecision,
  type RemotePromptAttachment,
  type RemoteCallTarget,
  type RemoteSessionRow,
  type RemoteStreamHandle,
} from './sessionsApi.js'
import type { SessionTransferOwner, SessionTransferPeer } from './sessionTransfer.js'
import {
  addOptimisticUserMessage,
  createTranscriptState,
  eventClientIdOf,
  foldHistory,
  forwardedSessionEvent,
  hasVisibleMessageText,
  historyEntriesFromRecords,
  clearSendState,
  markSendState,
  oldestSeq,
  parseSnapshot,
  permissionPresetOfFollowItem,
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
import {
  emptyCacheStatus,
  mergeSessionLists,
  mergeTimelineItems,
  readSessionsCache,
  readTimelineCache,
  writeSessionsCache,
  writeTimelineCache,
  type CachedSessionRow,
  type RemoteCacheStatus,
} from './cache.js'
/*
 * [S4 串台修复] 帧归属规则只有一份，在 `routing.ts`（纯函数 + 自测），
 * 而且是**照 dsh-Go 的 Dart 实现翻译**过来的（对照表见该文件头部）。
 * 本文件只负责在正确的时机问它：这条帧是不是这个会话的、这条流还作不作数。
 */
import {
  belongsToSession,
  commitSessionTranscript,
  ensureSessionDebug,
  followEpochIsCurrent,
  followEpochTurnIsCurrent,
  historyOwnerIsCurrent,
  noteSessionDrop,
  newFollowEpoch,
  sessionDropSnapshot,
  trimSessionTranscripts,
  type FollowEpochTicket,
} from './routing.js'
/*
 * [S3 全局运行态] 「谁在跑」不再只由打开的会话决定： *   - `session/list` 行的 `running`（权威）+ `$events` 的 `api-session/*`（实时）
 *     + `session/control` 的 turn 投影（校正）三条来源都喂给 `liveSessions.ts`；
 *   - 本文件只做**接线**（哪里拿到信号就喂给它）+ 把结论同步回 `state.streaming`，
 *     判定规则全在那个文件里（纯函数 + 自测）。
 */
import {
  liveNotifyOthers,
  liveRunningOf,
  noteLiveControlFrame,
  noteLiveEventsItem,
  noteLiveTool,
  reconcileLiveWithList,
  resetLiveSessions,
  useLiveSessions,
} from './liveSessions.js' // —— S3 live ——

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

/**
 * [契约之外的附加] **重启后自动恢复连接**的进度（K4）。
 *
 * 这条状态专门表达「用户什么都没点，我们在后台试着连回去」：
 *   - `idle`       —— 没在恢复（没有 last-session，或本来就不在原生壳里）；
 *   - `connecting` —— 正在静默重连（首屏照常渲染，`phase` 同时是 `connecting`）；
 *   - `done`       —— 恢复成功（手动登录成功也记这里，两者都是「现在连上了」）；
 *   - `failed`     —— 上次连接没连上。**不写 `error`、不弹红条**，界面只显示一行
 *                     「上次连接失败，点击重试」；`code === 'SESSION_EXPIRED'` 时文案换成
 *                     「登录已过期，请重新登录」（此时 last-session 已清，账号邮箱还在）。
 */
export interface RemoteAutoConnectState {
  state: 'idle' | 'connecting' | 'done' | 'failed'
  /** 失败原因码（`SESSION_EXPIRED` = 凭据过期；其余是这次连接本身的失败码） */
  code?: string
  /** 失败时的可读说明（中文，诊断 / 兜底用；界面优先按 code 取 i18n 文案） */
  message?: string
}

/**
 * [契约之外的附加] **掉线自愈**的进度（R10）。
 *
 * 这一条专门回答用户那句「连接失败你就刷新一下就好了呀……自动重新连一下就好了呀」：
 * 连接断了是**中性事件**，界面显示「正在重连…（第 N 次）」，只有
 * `need-login` / `blocked` 这两种真的需要人处理的才配红字。
 *
 * | status | 含义 | 界面 |
 * |---|---|---|
 * | `idle` | 没在恢复 | 走原来的未连接文案 |
 * | `waiting` | 正在退避，马上要打第 `attempt` 次 | 「正在重连…（第 N/5 次）」中性 |
 * | `connecting` | 这一轮正在建链 / 刷 token | 同上 |
 * | `failed` | 5 次都失败（网络类） | 「暂时连不上服务器」+「立即重连」 |
 * | `need-login` | refresh 也过期了 | 「登录已过期，请重新登录」 |
 * | `blocked` | 设备撤销 / 身份不符 / 版本不兼容 | 展示具体码与说明 |
 *
 * `kind` 是给「区分三种失败态」用的：`offline`（没网）/ `unreachable`（服务端不可达）/
 * `need-login` / `blocked`。
 */
export interface RemoteReconnectState {
  status: 'idle' | 'waiting' | 'connecting' | 'failed' | 'need-login' | 'blocked'
  /** 第几次尝试（1-based；`waiting` 时是「马上要打的那一次」） */
  attempt: number
  maxAttempts: number
  /** `waiting` 时的预计重试时刻（诊断 / 将来画倒计时用） */
  nextRetryAt?: number
  /** 最后一次失败的机器码（`WS_4009` / `TOKEN_EXPIRED` / `DEVICE_REVOKED` …） */
  code?: string
  /** 失败种类（UI 区分「离线 / 不可达 / 要重新登录」） */
  kind?: FailureKind
}

/* ── [R14 多 Host 切换] ────────────────────────────────────────────────
 * 背景：`connection.listHosts()` 早就把账号下所有 Host 连 presence 一起拉回来了，
 * `pickHost()` 也早就有「上次那台优先」的优先级 —— 缺的一直是**用户主动换一台**的动作与入口。
 *
 * 三条纪律（与 `pickHost` 的注释同源）：
 *   1. **离线 / 身份不符的 Host 不许切**：前者连不上（白等一轮），后者是公钥 pin 冲突
 *      （Noise IK 会失败，且不能靠重试绕过）；
 *   2. **换 Host = 换一份数据**：会话列表、时间线、待处理交互全属于某台 Host。缓存按
 *      `serverUrl|hostDeviceId` 分桶（`cache.ts`），所以「连上新 Host 后自然读到它那一桶」，
 *      不需要手工清缓存 —— 但**界面上**那一份必须清掉，否则会点进新 Host 上不存在的会话；
 *   3. **失败必须回滚**：用户只是点了下拉里的另一台，不能把一段还能用的连接换成一块红字。 */

/** 一台可切换 Host 的 UI 投影（不带 `identityKey` —— 那是连接层的事，界面不该看见） */
export interface RemoteHostInfo {
  deviceId: string
  name: string
  platform?: string
  /** 在线且可连（身份不符的按离线算，见 `toHostInfoList`） */
  online: boolean
  /** 本机 pin 的公钥与服务器返回的不一致：仍然列出（让用户看见「有台主机身份不对」），但不可切换 */
  identityMismatch: boolean
}

/**
 * 切换 Host 的进度（UI 据此画「正在连接 电脑名…」与一次失败提示）。
 *
 * `status === 'failed'` 时**连接已经回滚到原 Host**（`rolledBackTo` 有名字就代表回滚成功）；
 * 回滚也失败时连接停在 `phase:'error'`，界面上那条「重试」仍然有效。
 */
export interface HostSwitchState {
  status: 'idle' | 'switching' | 'failed'
  /** 目标 Host（`idle` 时没有） */
  targetId?: string
  targetName?: string
  /** `failed` 的原因码（`HOST_OFFLINE` / `HOST_UNKNOWN` / `HOST_IDENTITY_MISMATCH` / `HOST_SWITCH_FAILED` / …） */
  code?: string
  /** `failed` 的可读原因（中文，直接可展示） */
  message?: string
  /** 回滚成功时连回去的那台 Host 名（提示文案里的「已回到 x」） */
  rolledBackTo?: string
}

export interface RemoteState {
  /**
   * `waiting-auth` 是 K2 新增的：用户在系统浏览器里授权，本机**没有连接**，只是在轮询
   * `/api/v1/auth/oauth/qr/{qrId}`。它与 `authing`（正在换 token / 注册设备）的区别在于
   * 用户什么都做不了，只能等或取消 —— UI 据此显示倒计时而不是「正在连接」。
   */
  phase: 'idle' | 'authing' | 'connecting' | 'ready' | 'error' | 'waiting-auth'
  capabilities: string[]
  transport: 'relay' | 'lan' | 'p2p' | 'turn' | 'ssh' | null
  error: { code: string; message: string } | null
  sessions: RemoteSessionSummary[]
  activeSessionId: string | null
  items: ChatItem[]
  streaming: boolean
  pendingApprovals: { eventId: string; title: string; detail?: string }[]
  /**
   * [R9 红点] 别的会话收到的**待处理交互**（审批 / 提问各几条），activity 会话不计。
   *
   * 派生规则（见文件末尾「七、待处理交互」）：
   *   - 来源：Host 级 `$events` 的 `approval/request` / `user-questions/request` waterfall，
   *     **按 eventId 去重**（重投不翻倍）；
   *   - 清零：`{type:'cancel', eventId}`、`api-session/status running=false`、
   *     `api-session/removed`、**进入该会话**（`openSession`）、本机应答完；
   *   - 活动会话永远不计（用户就在里面，卡片就在眼前）。
   *
   * 列表用它画「圆点 + 数字」，见 `RemoteSessionList`。
   */
  pendingInteractions: Record<string, PendingInteractionCount>
  /**
   * [R8 缓存] 列表 / 内容的**加载态与来源**（只读投影：UI 只读，别自己拼条件）。
   *
   * 语义与判定见 `cache.ts` 的 `sessionListViewState()` / `timelineViewState()` /
   * `timelineHintState()`；两条硬纪律：
   *   1. 缓存先铺（`…FromCache`）—— 打开远程页不必等 `session/list`；
   *   2. **首次拉取没结束之前不许显示「没有内容」**（`timelineSettled` 才是事实）。
   */
  cacheStatus: RemoteCacheStatus
  /**
   * 远程页打开时把上一次的会话列表先铺上（幂等）。
   *
   * 不阻塞首屏、不发请求：只读 `localStorage` 里按 `serverUrl+hostDeviceId` 分桶的那份缓存。
   * 没有缓存、已经拿到实时列表、或还没连过任何 Host 时什么都不做。
   */
  hydrateCachedSessions(): void
  connect(serverUrl: string, email: string, password: string): Promise<void>
  connectSsh(input: SshHostInput): Promise<boolean>
  /**
   * **临时断开**：拆连接、停保活、复位界面，但**保留** `dsp.remote.last-session.v1`
   * —— 下次启动仍然会自动连回来。要清凭据请用 `signOut()`。
   */
  disconnect(): void
  /**
   * **退出登录**：断开 + 清 `last-session` + 删掉本机的设备 token（`storage.removeAccount`）。
   * 与 `disconnect()` 的区别就是「下次还要不要自动连」。
   */
  signOut(): void
  refreshSessions(): Promise<void>
  openSession(id: string): Promise<void>
  loadOlder(): Promise<void>
  send(text: string): Promise<void>
  /** 运行中发消息：mode:'steer' 插话、'queue' 排队（默认沿用 send() 的 queue）。 */
  sendWithMode(text: string, mode: RemotePromptMode): Promise<void>
  sendToSession(
    target: RemoteCallTarget,
    sessionId: string,
    text: string,
    attachments: readonly RemotePromptAttachment[],
    mode?: RemotePromptMode,
  ): Promise<boolean>
  retryPrompt(target: RemoteCallTarget, sessionId: string, requestId: string): Promise<boolean>
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

  /* ── [重启后自动恢复] 契约之外的附加（K4） ─────────────────────────────
   * 三件事：读盘上那条 last-session、静默重连、失败给一次性重试。
   * 挂载点在 `RemoteChatView`（远程页）与 `RemoteSettingsPanel`（设置页），都是幂等单飞。 */

  /** 上次连上的会话（`dsp.remote.last-session.v1` 的投影；`null` = 没有可恢复的） */
  lastSession: LastSession | null
  /** 自动恢复的进度（失败**不写** `error`，只落这里，见 `RemoteAutoConnectState`） */
  autoConnect: RemoteAutoConnectState
  /**
   * 启动时静默恢复上次连接（**幂等单飞**，且每个进程只自动试一次）。
   *
   * 不阻塞首屏：调用方 `fireAndForget` 即可。分支见 `autoConnect.planAutoConnect()`：
   * 没有记录 → 什么都不做；凭据过期 → 清记录 + `failed/SESSION_EXPIRED`；
   * 需要刷 token → 先 `POST /api/v1/auth/refresh` 再连；其余直接连。
   */
  autoConnectNow(): Promise<void>
  /** 用户点「重试」：无视「本进程已试过」，再按 last-session 连一次（`disconnect()` 之后也用它重连） */
  retryAutoConnect(): Promise<void>

  /* ── [掉线自愈] 契约之外的附加（R10） ───────────────────────────────────
   * 后台太久会把连接踢掉（服务端 75 s 收不到心跳就断），这是**连接**的事，
   * 不是凭据的事：回前台 / 用户点一下都应该立刻自己连回来，不能让人重新登录。 */

  /** 掉线自愈的进度（`status === 'idle'` 表示没在恢复） */
  reconnect: RemoteReconnectState
  /**
   * 立刻走一轮恢复（**不等定时器**）：先按需 refresh，再重连；失败指数退避重试最多 5 次。
   *
   * 调用点：回前台（`visibilitychange` / `focus`）、用户点「立即重连」、
   * 以及连接意外关闭时的自动触发。幂等单飞；正在手动登录 / 已连上时什么都不做。
   */
  reconnectNow(): Promise<void>

  /* ── [R14 多 Host 切换] 契约之外的附加 ─────────────────────────────── */

  /** 账号下所有 Host（含在线状态）。`establishSession` 列 Host 时顺手记下，切换/刷新后更新 */
  hosts: RemoteHostInfo[]
  /** 当前连着的 Host（`null` = 还没连上） */
  hostId: string | null
  /** URL of the server that owns hostId, published with the successful handshake. */
  activeServerUrl: string | null
  connectionDiagnostics: RemoteConnectResult['diagnostics'] | null
  /** 切换进度（见 `HostSwitchState`：`switching` 画 loading，`failed` 弹一次原因） */
  hostSwitch: HostSwitchState
  /**
   * 换一台 Host：拆当前连接 → 用**同一个账号**连新 Host → 重载会话列表（缓存按桶自动生效）。
   *
   * 幂等 + 单飞；离线 / 身份不符 / 未知的 Host 直接拒绝（**不动**现有连接）；
   * 连接失败**回滚到原 Host**，结果与原因写进 `hostSwitch`。
   */
  switchHost(hostDeviceId: string): Promise<void>
  /** 重新探一遍 Host 在线状态（下拉里的「刷新」用；失败静默，手上那份列表仍然可用） */
  refreshHosts(): Promise<void>
  /** 关掉切换失败的提示（toast 弹过之后调，避免重复弹） */
  dismissHostSwitch(): void
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
  client: RemoteClient | null
  server: RemoteServer
  account: RemoteAccount
  host: RemoteHost
  link: Pick<SecureLink, 'state' | 'close' | 'rpc' | 'openStream'> & { readonly transport: string }
  capabilities: string[]
  compactHistory?: boolean
  /** 当前打开的会话 id（`null` = 还没开会话）。 */
  sessionId: string | null
  /**
   * `sessionId` 那一份 transcript（**当前正在显示的那份**）。
   *
   * 它只是 `transcripts` 里的一格 —— 写它之前一律先确认「这条数据属于同一个会话」。
   */
  transcript: RemoteTranscriptState
  /**
   * [S4] 每个会话一份 transcript（`sessionId → 归约状态`）。
   *
   * 照 dsh-Go `transcript.dart:159` 的 `class ChatTranscript` + `chat_state.dart:462-465`
   * 的「一个 ChatController 持有一份 ChatTranscript」翻过来：那边每个会话一个 controller，
   * 对象身份本身就是隔离；我们是单连接单活动会话，所以把「一份 per 会话」显式存成 map。
   *
   * 有了它，还在飞的旧 follow 流（切会话时没来得及关掉的那条）写快照 / 帧时，
   * 落进的是**它自己那个会话的格子**，而不是「当时正好开着的会话」—— 串台从结构上没了。
   * 上限 `MAX_SESSION_TRANSCRIPTS` 份，按最近使用淘汰（切走的会话回到它时直接接着用）。
   */
  transcripts: Map<string, RemoteTranscriptState>
  lastTimelineWrite: { sessionId: string; items: readonly ChatItem[] } | null
  hasMore: boolean
  follow: RemoteStreamHandle | null
  events: RemoteStreamHandle | null
  /** `session/control` 投影流（标题 / 模型 / 权限 / 队列 / 提问投影），拿得到才非 null。 */
  control: RemoteStreamHandle | null
  /** `$events` 的 `ready.clientId`（应答审批必须带）。 */
  eventClientId: string | null
  sinks: Map<string, StreamSink>
  /**
   * 外部（别的模块自己开的流）按 streamId 注册的接收器，见 `registerRemoteStreamSink`。
   * 与 `sinks` 分开存：内部审流 / 会话流的行为必须**逐字节不变**，内部永远优先。
   */
  listeners: Map<string, Set<(payload: StreamEventPayload) => void>>
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

/* ── 重启后自动恢复的模块级上下文（不进 zustand：不是渲染数据） ───────── */

/** 单飞：远程页与设置页可能同时挂载，只允许一条恢复流程在飞 */
let autoConnectInFlight: Promise<void> | null = null
/**
 * 本次进程是否已经**自动**试过一次。
 *
 * 为什么要有：挂载点不止一个（`RemoteChatView` + `RemoteSettingsPanel`），失败之后如果每个
 * 挂载点都再来一轮，就会出现「刚进来就一直重连、一直失败」的观感。失败后要用户点「重试」
 * （`retryAutoConnect()` 会把这里清掉）；`disconnect()` / `signOut()` 之后也不许再自动连。
 */
let autoConnectSettled = false

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
  pendingInteractions: {} as Record<string, PendingInteractionCount>,
  cacheStatus: emptyCacheStatus(),
  oauthProviders: [] as RemoteOAuthProviderSummary[],
  qr: null as RemoteProviderLoginState | null,
  pendingLogin: null as RemotePendingLogin | null,
  keepAlive: null as KeepAliveSnapshot | null,
  // 注意：`lastSession` 不在 INITIAL_STATE 里 —— 它属于**盘上的持久化状态**，不是界面状态。
  // `disconnect()`（临时断开）复位界面时必须把它读回来（见那里的注释）。
  autoConnect: { state: 'idle' } as RemoteAutoConnectState,
  reconnect: {
    status: 'idle',
    attempt: 0,
    maxAttempts: MAX_RECONNECT_ATTEMPTS,
  } as RemoteReconnectState,
  // [R14 多 Host] 断开 / 退出登录时一起复位（切 Host 不走 INITIAL_STATE，见 switchHostFlow）
  hosts: [] as RemoteHostInfo[],
  hostId: null as string | null,
  activeServerUrl: null as string | null,
  connectionDiagnostics: null,
  hostSwitch: { status: 'idle' } as HostSwitchState,
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

/** 取错误码（外部流 / 能力探测只关心「是不是不支持」，拿不到码就当未知）。 */
const errorCodeOf = (error: unknown): string | undefined => {
  if (isRemoteApiError(error)) return error.code
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && code.length > 0 ? code : undefined
}

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

/**
 * 把归约后的时间线推给 UI（同时重算待审批列表）。
 *
 * [S4] `ownerId` = 这批 items **属于哪个会话**。默认取此刻的活动会话（绝大多数调用点
 * 都是「刚归约完当前会话」）；异步流程回来后会话可能已经换了，那时必须显式传自己
 * 打开时那个 id —— 对不上就整批丢掉并计数。
 */
const syncItems = (session: ActiveSession, ownerId: string | null = session.sessionId): void => {
  if (ownerId === null || ownerId.length === 0) {
    // 会话还没开：没有可显示的东西
    noteSessionDrop('frame')
    return
  }
  if (session.sessionId !== ownerId) {
    // 有会话开着，但不是这批内容的会话：只进它自己的格子，别推给屏幕
    noteSessionDrop('staleFlow')
    return
  }
  const items = session.transcript.items
  useRemoteStore.setState({ items, pendingApprovals: pendingApprovalsOf(items) })
}

/** transcript 内存上限：切走过的会话回到它时直接接着用，但别无限攒（一台设备会翻很多会话）。 */
const MAX_SESSION_TRANSCRIPTS = 6

/** 淘汰最久没用的那一份（永远不动当前会话那份）。 */
const trimTranscripts = (session: ActiveSession): void => {
  trimSessionTranscripts(session.transcripts, session.sessionId, MAX_SESSION_TRANSCRIPTS)
}

/**
 * 往**某个会话**的 transcript 里提交一次归约结果。
 *
 * 这是 `transcript.dart` 的 `ChatTranscript.apply()/prependHistory()` 在我们这边的等价入口：
 *   - 有归属的会话就一定写进**它自己的格子**（`transcripts`），哪怕它已经不显示了；
 *   - 只有当它还是活动会话时，才同步给 UI（`session.transcript` + `state.items`）。
 *
 * 返回 `true` = 同时推给了屏幕。
 */
const commitTranscript = (
  session: ActiveSession,
  sessionId: string,
  next: RemoteTranscriptState,
): boolean => {
  const result = commitSessionTranscript(session.transcripts, sessionId, session.sessionId, next)
  if (!result.stored) {
    noteSessionDrop('frame')
    return false
  }
  if (!result.shown) {
    // 不当面：内容已经归到它自己那格了，回到那个会话时接着用（不串到当前会话）
    noteSessionDrop('staleFlow')
    return false
  }
  trimTranscripts(session)
  session.transcript = next
  syncItems(session, sessionId)
  return true
}

const requireSession = (): ActiveSession => {
  if (active === null) {
    /*
     * [R17 假 ready] phase 说 ready 但连接对象已经没了 —— 链路悄悄断开时留下的假象
     * （`handleLinkClosed` 的「自愈已在跑」分支曾直接 return、不动 phase；`shutdown`
     * 本身也不碰 phase）。不在这里纠正，界面就一切如常：列表照旧、右侧停在
     * 「选择一个会话」，而每个动作都只往**那一屏不显示的** `state.error` 里静默写错
     * —— 真机表现就是「点哪个会话都进不去」。
     */
    if (useRemoteStore.getState().phase === 'ready') {
      useRemoteStore.setState({ phase: 'error', streaming: false })
    }
    throw new RemoteApiError('NOT_CONNECTED', '先在设置里填写服务器与账号并连接')
  }
  return active
}

/* ── follow 代际（S4）：切会话时把上一代的异步流程全部作废 ────────────────
 *
 * 照 dsh-Go 的 `SessionFollowEpoch` / `_canControl` / `_requireCurrent` 翻：
 * 每次开流领一个新 epoch，异步回来的每一段先问「我这个 epoch 还是不是最新的」。
 *
 * 为什么需要「代际」而不只是比 sessionId：`openSessionFlow()` 是 async，用户在会话
 * 列表里连点 A→B 时两条流程会**交错**执行（`await closeStreamQuietly` / `await
 * openFollow` 都是让出点）。各自恢复执行时都会做三件危险的事：
 *   ① `session.follow = handle` —— 晚到的那条把句柄覆盖成**上一条会话**的流；
 *   ② 它的 sink 还在往 transcript 里写快照 / follow 帧；
 *   ③ 被覆盖掉的那条流从此再没人 `close()` —— 变成一条永远在推帧的孤儿流。
 * 代际号让「A→B→A」这种绕回去的情况也不会认错：回来时 epoch 已经变了，老流程照样作废。
 */
let sessionEpoch = 0

export function sessionTransferConnection(): { owner: SessionTransferOwner; peer: SessionTransferPeer } | null {
  const session = active
  if (session === null || useRemoteStore.getState().phase !== 'ready' || !session.host.identityKey) return null
  return {
    owner: {
      target: session.link,
      capabilities: session.capabilities,
      current: () => active === session && useRemoteStore.getState().phase === 'ready',
    },
    peer: {
      serverUrl: session.server.url,
      hostId: session.host.deviceId,
      hostIdentity: session.host.identityKey,
      deviceId: session.account.deviceId,
    },
  }
}

export function remoteDraftOwner(allowSaved = false): string | null {
  const peer = sessionTransferConnection()?.peer
  if (peer) return JSON.stringify([peer.serverUrl, peer.hostId, peer.hostIdentity, peer.deviceId])
  const saved = allowSaved ? useRemoteStore.getState().lastSession : null
  if (saved === null) return null
  const key = findPinnedHost(saved.serverUrl, saved.hostDeviceId)?.identityKey
  const device = findAccount(saved.serverUrl, saved.email)?.deviceId
  return key && device ? JSON.stringify([saved.serverUrl, saved.hostDeviceId, key, device]) : null
}

export async function changeRemoteDevice(target: RemoteCallTarget, change: DeviceChange) {
  const session = requireSession()
  if (!session.client || session.link !== target || ((change.kind === 'rename' || change.kind === 'revokeHost') &&
    !useRemoteStore.getState().hosts.some((host) => host.deviceId === change.deviceId))) {
    throw new RemoteApiError('NOT_FOUND', 'The device is unavailable on the selected account.')
  }
  const current = () => active === session
  const renamed = await session.client.manageDevice(session.server, session.account, change, current)
  if (change.kind === 'revokeHost' || change.kind === 'unpair') {
    const last = readLastSession()
    const activeHostRevoked = change.deviceId === session.host.deviceId &&
      (current() || (last?.serverUrl === session.server.url && last.email === session.account.email &&
        last.hostDeviceId === change.deviceId && (active === null || (
          active.server.url === session.server.url && active.account.deviceId === session.account.deviceId &&
          active.host.deviceId === change.deviceId
        ))))
    if (activeHostRevoked) {
      clearLastSession()
      useRemoteStore.getState().disconnect()
    } else if (current()) {
      useRemoteStore.setState((state) => ({ hosts: state.hosts.filter((host) => host.deviceId !== change.deviceId) }))
    }
    return
  }
  if (!current()) return
  if (change.kind === 'revokeSelf') {
    useRemoteStore.getState().signOut()
    return
  }
  if (renamed === undefined) return
  const state = useRemoteStore.getState()
  if (session.host.deviceId === change.deviceId) {
    session.host = { ...session.host, name: renamed }
    if (state.lastSession?.hostDeviceId === change.deviceId) {
      useRemoteStore.setState({ lastSession: writeLastSession({ ...state.lastSession, hostName: renamed }) })
    }
  }
  useRemoteStore.setState((currentState) => ({
    hosts: currentState.hosts.map((host) => host.deviceId === change.deviceId ? { ...host, name: renamed } : host),
  }))
}

export async function listRemoteMemberships(target: RemoteCallTarget) {
  const session = requireSession()
  if (!session.client || session.link !== target) throw new RemoteApiError('RPC_ABORTED', 'The originating connection closed.')
  const current = () => active === session
  const memberships = await session.client.listMemberships(session.server, session.account, current)
  if (!current()) throw new RemoteApiError('RPC_ABORTED', 'The originating connection closed.')
  return memberships
}

/** Changes on every session-open attempt, including leaving and returning to the same ID. */
export const remoteSessionSelectionVersion = (): number => sessionEpoch

/** 开一条新流程：领一张代际工牌，拿到的工牌只有最新那条流程能用。 */
const newFlowTicket = (sessionId: string): FollowEpochTicket => {
  const ticket = newFollowEpoch(sessionId, sessionEpoch)
  sessionEpoch = ticket.epoch
  return ticket
}

/** 工牌比对用的「当下」。 */
const epochCursor = (session: ActiveSession): { sessionId: string | null; epoch: number } => ({
  sessionId: session.sessionId,
  epoch: sessionEpoch,
})

/**
 * 「当下这条流」的工牌（**不推进代际**）。
 *
 * 给「本来就在当前流上、只是要等一个 RPC 回来」的动作用（翻页）：它们不该开新代际，
 * 只需要证明回来时世界还是原来那个（Dart `_checkHistoryOwner(epoch)`）。
 */
const currentFlowTicket = (sessionId: string): FollowEpochTicket => ({ sessionId, epoch: sessionEpoch })

/** 这张工牌现在还作不作数（连接换了 / 会话换了 / 代际被顶掉 → false）。 */
const flowIsCurrent = (session: ActiveSession, ticket: FollowEpochTicket): boolean =>
  active === session && followEpochIsCurrent(ticket, epochCursor(session))

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
  // 外部注册的接收器（`registerRemoteStreamSink`）：整包投递，含 `closed`；内部 sink 优先。
  if (routeToStreamListeners(session.listeners, streamId, payload)) return
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

/* ── 外部流订阅（给 W1 的 `workspace/follow` 等「自己开的流」用） ─────────
 *
 * 为什么需要：`link.onStreamEvent` 是**链路级**回调，所有流帧都先落到本文件的
 * `routeStream()`；而本文件只认识它自己开的那三条（`$events` / `session/follow` /
 * `session/control`）。别的模块自己 `openStream()` 之后拿到的帧，原先只能躺在
 * `unrouted` 缓冲里等一个永远不会来的 sink。
 *
 * 纪律：
 *   - **additive**：内部 `sinks` 仍优先（同 streamId 的两条审流 / 会话流行为不变）；
 *   - 取消函数**幂等**：重复调用只生效一次；
 *   - 流关闭时自动摘掉（`closed` 帧照样投给接收器一次）；
 *   - 没连上时返回**空取消函数**（不抛）：调用方可以无条件 `cleanup()`。
 */

/** 把一条流的所有外部接收器摘掉，并且（可选）先投一帧 `closed`。 */
const drainListeners = (session: ActiveSession, payload?: StreamEventPayload): void => {
  const buckets = [...session.listeners.values()]
  session.listeners.clear()
  if (payload === undefined) return
  for (const bucket of buckets) {
    for (const listener of bucket) {
      try {
        listener(payload)
      } catch {
        // 外部回调异常不影响收尾
      }
    }
  }
}

/** 外部接收器的集合类型（`ActiveSession.listeners` 的值） */
type StreamListener = (payload: StreamEventPayload) => void
type StreamListenerMap = Map<string, Set<StreamListener>>

/**
 * 把一帧投给某条流的外部接收器；返回 `true` 表示**被吃掉了**（调用方不要再缓冲）。
 *
 * 抽成导出函数是为了让「多条接收器各收一份 + 关闭即摘除」这段有单测
 * （`__selftest__/sessionControls.selftest.mts` 的 F 组），`routeStream()` 里只有一行调用 ——
 * 一份实现，不会出现「测试里对、线上不对」。
 */
export const routeToStreamListeners = (
  listeners: StreamListenerMap,
  streamId: string,
  payload: StreamEventPayload,
): boolean => {
  const bucket = listeners.get(streamId)
  if (bucket === undefined || bucket.size === 0) return false
  // 复制一份再遍历：回调里可能自己取消注册
  for (const listener of [...bucket]) {
    try {
      listener(payload)
    } catch {
      // 外部回调异常不能打断入站分发
    }
  }
  // 流关闭即摘掉全部接收器（一次性的东西不该留着下次连接误用）
  if (payload.type === 'closed') listeners.delete(streamId)
  return true
}

/**
 * 为任意 `streamId` 注册一个接收器；返回**幂等**的取消函数。
 *
 * ```ts
 * const handle = await link.openStream('workspace/follow', { args: {} })
 * const cancel = registerRemoteStreamSink(handle.streamId, (payload) => {
 *   if (payload.type === 'closed') { …, cancel(), 重开流 }
 *   else if (payload.hasValue) { … }
 * })
 * ```
 *
 * 同 streamId 允许多个接收器（**不抛错**，它们按注册顺序各收一份整包 payload）；
 * 卸载时机：自己调返回的函数，或流关闭 / 断开连接（都会自动摘掉）。
 */
export const registerRemoteStreamSink = (
  streamId: string,
  onPayload: (payload: StreamEventPayload) => void,
): (() => void) => {
  const session = active
  if (session === null || streamId.length === 0) return () => undefined
  let bucket = session.listeners.get(streamId)
  if (bucket === undefined) {
    bucket = new Set()
    session.listeners.set(streamId, bucket)
  }
  const listeners = bucket
  listeners.add(onPayload)

  let released = false
  const release = (): void => {
    if (released) return
    released = true
    listeners.delete(onPayload)
    // 只剩自己这一份了就整条删掉（避免按 streamId 无限堆积空集合）
    if (listeners.size === 0 && session.listeners.get(streamId) === listeners) {
      session.listeners.delete(streamId)
    }
  }

  // 帧比注册先到（`openStream()` 还没 resolve 时链路就把首帧推来了）：按顺序倒出来。
  const buffered = session.unrouted.get(streamId)
  if (buffered !== undefined) {
    session.unrouted.delete(streamId)
    for (const payload of buffered) {
      try {
        onPayload(payload)
      } catch {
        // 同 routeStream：外部回调异常不影响分发
      }
      if (payload.type === 'closed' || released) break
    }
  }
  return release
}

export function subscribeRemoteStream(
  target: RemoteCallTarget,
  opened: Promise<RemoteStreamHandle>,
  onPayload: StreamListener,
  onError: (error: unknown) => void,
): () => void {
  let disposed = false
  let close: (() => void) | undefined
  void opened.then((handle) => {
    const ownsStream = active?.link === target
    const release = ownsStream
      ? registerRemoteStreamSink(handle.streamId, (payload) => {
        if (!disposed && active?.link === target) onPayload(payload)
      })
      : undefined
    close = () => { void handle.close().catch(() => undefined).finally(() => release?.()) }
    if (disposed || !ownsStream) close()
  }, (error) => {
    if (!disposed && active?.link === target) onError(error)
  })
  return () => {
    if (disposed) return
    disposed = true
    close?.()
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

/* ── R8：cache-first 接线（缓存/合并的规则全在 `cache.ts`，这里只做读写时机） ── */

/** 内容落盘的合并窗口：follow 每帧都写会把主线程写花，攒 800ms 一拍足够。 */
const TIMELINE_PERSIST_DELAY_MS = 800

/** 攒着还没落盘的内容定时器（切会话 / 断开时先 flush，别丢最后几帧）。 */
let timelinePersistTimer: ReturnType<typeof setTimeout> | null = null

const patchCacheStatus = (patch: Partial<RemoteCacheStatus>): void => {
  useRemoteStore.setState({ cacheStatus: { ...useRemoteStore.getState().cacheStatus, ...patch } })
}

/** 只改「当前这个会话」的加载态：晚到的旧会话事件不许污染新会话。 */
const patchTimelineStatus = (sessionId: string, patch: Partial<RemoteCacheStatus>): void => {
  if (useRemoteStore.getState().activeSessionId !== sessionId) return
  patchCacheStatus(patch)
}

/**
 * 缓存分桶的键：**优先当前连接**（真权威），没连上时退回 `last-session`（缓存直出就靠它）。
 *
 * 两个来源都是 `serverUrl + hostDeviceId`，所以「先渲染缓存」与「连上之后合并」用的是同一个桶。
 */
const cacheBucketFor = (session: ActiveSession) => ({
  serverUrl: session.server.url,
  hostDeviceId: session.host.deviceId,
  owner: JSON.stringify([session.host.identityKey, session.account.deviceId, session.account.email]),
})

const timelineBucketFor = (session: ActiveSession) => {
  const bucket = cacheBucketFor(session)
  return session.compactHistory ? { ...bucket, owner: JSON.stringify([bucket.owner, 'compact']) } : bucket
}

export function forgetDeletedRemoteSession(target: RemoteCallTarget, id: string): void {
  const session = active
  if (!session || session.link !== target) return
  flushTimelinePersist()
  session.transcripts.delete(id)
  if (session.sessionId === id) {
    sessionEpoch += 1
    session.sessionId = null
    session.transcript = createTranscriptState()
    session.hasMore = false
    const follow = session.follow
    session.follow = null
    void closeStreamQuietly(session, follow)
    selectControlSession(null)
    setPaging(false, false)
    useRemoteStore.setState({
      activeSessionId: null, items: [], streaming: false, pendingApprovals: [],
      cacheStatus: { ...useRemoteStore.getState().cacheStatus, timelineSettled: false, timelineFailed: false, timelineFromCache: false },
    })
  }
  clearPendingInteractions({ sessionId: id })
  const bucket = cacheBucketFor(session)
  const sessions = useRemoteStore.getState().sessions.filter((item) => item.id !== id)
  writeSessionsCache({ ...bucket, sessions })
  writeTimelineCache({ ...timelineBucketFor(session), sessionId: id, items: [], replaceEmpty: true })
  useRemoteStore.setState({ sessions })
}

const cacheBucketNow = (): ReturnType<typeof cacheBucketFor> | null => {
  if (active !== null) return cacheBucketFor(active)
  const last = useRemoteStore.getState().lastSession ?? readLastSession()
  if (!last) return null
  const key = findPinnedHost(last.serverUrl, last.hostDeviceId)?.identityKey
  const device = findAccount(last.serverUrl, last.email)?.deviceId
  return key && device ? {
    serverUrl: last.serverUrl, hostDeviceId: last.hostDeviceId, owner: JSON.stringify([key, device, last.email]),
  } : null
}

/**
 * 服务端列表到手：**与本地缓存合并**（服务端为准、本地 pinned 保留、幽灵行打标）→ 落盘 → 进 state。
 *
 * 列表来源从此变成「实时」，`sessionsFromCache` / `sessionsStale` 清掉、`sessionsSynced` 置 true
 * —— 这也正是「空态可信」的开关（`sessionListViewState()` 靠它判 skeleton / empty）。
 */
const applyRemoteSessionRows = (rows: RemoteSessionRow[]): void => {
  const now = Date.now()
  /*
   * —— S3 live —— 列表是**权威对账**点：行的 `running` 是 Host 自己算的。
   * 刚进 App 时「有一个会话正在跑」就是靠这一句被认出来的
   * （在那之前只有 `session/follow` 才知道，而那个要先点进去）。
   */
  reconcileLiveWithList(
    rows.flatMap((row) =>
      row.parentSessionId === undefined && row.origin !== 'subagent'
        ? [{
          sessionId: row.sessionId,
          ...(row.running === undefined ? {} : { running: row.running }),
          ...(row.updatedAt === undefined ? {} : { updatedAt: row.updatedAt }),
        }]
        : [],
    ),
  )
  const bucket = cacheBucketNow()
  const remote: CachedSessionRow[] = projectSessions(rows)
  const cached = bucket === null ? [] : (readSessionsCache({ ...bucket, now })?.sessions ?? [])
  const merged = mergeSessionLists({ cached, remote, now })
  useRemoteStore.setState({
    sessions: merged.sessions,
    cacheStatus: {
      ...useRemoteStore.getState().cacheStatus,
      sessionsFromCache: false,
      sessionsStale: false,
      sessionsSyncing: false,
      sessionsSynced: true,
      ghostSessionIds: merged.ghostSessionIds,
    },
  })
  if (bucket !== null) writeSessionsCache({ ...bucket, sessions: merged.sessions, now })
}

const persistTimelineNow = (session: ActiveSession, sessionId: string, replaceEmpty = false): void => {
  const transcript = session.transcripts.get(sessionId)
  if (transcript === undefined) return
  const lastWrite = session.lastTimelineWrite
  if (!replaceEmpty && lastWrite?.sessionId === sessionId && lastWrite.items === transcript.items) return
  const written = writeTimelineCache({
    ...timelineBucketFor(session),
    sessionId,
    items: transcript.items,
    replaceEmpty,
    now: Date.now(),
  })
  // Other sessions' writes can evict this entry from the on-disk cache.
  session.lastTimelineWrite = written > 0 ? { sessionId, items: transcript.items } : null
}

const scheduleTimelinePersist = (session: ActiveSession, sessionId: string): void => {
  if (timelinePersistTimer !== null) clearTimeout(timelinePersistTimer)
  timelinePersistTimer = setTimeout(() => {
    timelinePersistTimer = null
    // 切走 / 断开之后这一拍就不写了（缓存归当前会话，别人不该被上一次的内容污染）
    if (active !== session || session.sessionId !== sessionId) return
    persistTimelineNow(session, sessionId)
  }, TIMELINE_PERSIST_DELAY_MS)
}

/** 立刻把还攒着的内容写盘（切会话 / 断开 / 退后台时调）。 */
const flushTimelinePersist = (): void => {
  if (timelinePersistTimer !== null) {
    clearTimeout(timelinePersistTimer)
    timelinePersistTimer = null
  }
  const session = active
  const sessionId = session?.sessionId ?? null
  if (session !== null && sessionId !== null) persistTimelineNow(session, sessionId)
}

/* ── 连建 ─────────────────────────────────────────────────────────────── */

type PickedHost = RemoteHost & { identityKey: string }

/**
 * 挑一台可连的 Host（在线优先）；公钥缺失直接 fail-closed —— Noise IK 没有它就握不上手。
 *
 * `preferredHostId` 来自 last-session：**上次连的是哪台就连回哪台**（多台 Host 时不能让
 * 「列表里第一台在线的」把用户悄悄换到另一台机器上）。
 */
const pickHost = (hosts: RemoteHost[], preferredHostId?: string): PickedHost => {
  const usable = hosts.filter(host => host.identityMismatch !== true)
  const preferred = preferredHostId === undefined ? undefined : usable.find(host => host.deviceId === preferredHostId)
  if (preferredHostId !== undefined && preferred === undefined) {
    const code = hosts.some(host => host.deviceId === preferredHostId) ? 'PEER_IDENTITY_MISMATCH' : 'HOST_UNKNOWN'
    throw new RemoteApiError(code, '原远程主机不可用，请在主机列表中重新选择')
  }
  if (usable.length === 0) {
    if (hosts.length > 0) {
      throw new RemoteApiError('PEER_IDENTITY_MISMATCH', '账号下主机的公钥都与本机 pin 的不一致，已拒绝连接')
    }
    throw new RemoteApiError('NO_HOST', '这个账号下没有可连接的 Host：请先在电脑上的 DSH 里开启远程访问并注册设备')
  }
  const picked = preferred ?? usable.find(host => host.online === true) ?? usable[0]!
  if (picked.identityKey === undefined || picked.identityKey.length === 0) {
    throw new RemoteApiError(
      'HOST_IDENTITY_MISSING',
      '拿不到目标主机的身份公钥（Noise IK 必需），请确认服务器能返回设备详情',
    )
  }
  return { ...picked, identityKey: picked.identityKey }
}

/* ── [R14 多 Host] 目标校验 / 切换编排（都在 `pickHost` 旁边：同一件事的另一半） ── */

/**
 * `connection.listHosts()` 的结果 → UI 投影。
 *
 * `online` 把 `identityMismatch` 也算成不可连：那台机器**列出来**是为了让用户知道
 * 「有一台主机身份不对」（pin 冲突要人工处理），但绝不允许点进去 —— Noise IK 会直接失败。
 */
export const toHostInfoList = (hosts: readonly RemoteHost[]): RemoteHostInfo[] =>
  hosts.map((host) => ({
    deviceId: host.deviceId,
    name: host.name,
    ...(host.platform === undefined ? {} : { platform: host.platform }),
    online: host.online === true && host.identityMismatch !== true,
    identityMismatch: host.identityMismatch === true,
  }))

/**
 * 切换前的**纯**校验：找不到 / 身份不符 / 离线都抛 `RemoteApiError`（带可读中文）。
 *
 * 抽成纯函数是为了让这三条「不该碰连接」的拒绝路径可以直接自测：最容易被实现成
 * 「先把连接拆了再说」，那样用户点一台离线主机会把一条好好的连接弄断。
 */
export const resolveHostSwitchTarget = (
  hosts: readonly RemoteHostInfo[],
  targetId: string,
): RemoteHostInfo => {
  const target = hosts.find((host) => host.deviceId === targetId)
  if (target === undefined) {
    throw new RemoteApiError('HOST_UNKNOWN', '账号下已经找不到这台主机了，刷新主机列表再试')
  }
  if (target.identityMismatch) {
    throw new RemoteApiError('HOST_IDENTITY_MISMATCH', '这台主机的公钥与本机记录的不一致，已拒绝连接')
  }
  if (!target.online) {
    throw new RemoteApiError('HOST_OFFLINE', '这台主机现在不在线：先在电脑上把远程访问打开')
  }
  return target
}

/** 列表里某台 Host 的展示名（找不到就用 id 前 8 位，永不返回空串） */
export const hostNameOf = (hosts: readonly RemoteHostInfo[], deviceId: string): string => {
  const host = hosts.find((item) => item.deviceId === deviceId)
  if (host !== undefined && host.name.trim().length > 0) return host.name.trim()
  return deviceId.slice(0, 8)
}

/** 切换流程需要的全部副作用（生产 = 真 store + 真连接；自测注入桩，见 deeplink-host.selftest） */
export interface HostSwitchRuntime {
  /** 当前已知的 Host 列表 */
  hosts: () => readonly RemoteHostInfo[]
  /** 当前连着的 Host（`null` = 没有连接） */
  currentHostId: () => string | null
  /** 当前 Host 的名字（回滚提示用） */
  currentHostName: () => string | null
  /** 拆掉现有连接（生产 = 写盘 + `shutdown()` + 清掉界面上那一份数据） */
  disconnect: () => Promise<void>
  /** 连到指定 Host（生产 = `establishSession({preferredHostId})`；**失败必须抛**） */
  connect: (hostDeviceId: string) => Promise<void>
  /** 把进度/结果写回界面状态 */
  report: (state: HostSwitchState) => void
}

/**
 * 切 Host 的完整流程：校验 → 拆 → 连 → **失败回滚**。
 *
 * @return true = 真的切过去了（或本来就在这台）
 *
 * 为什么回滚写在这里而不是交给界面：界面能做的只有「弹提示」，而「把原来那台连回来」
 * 需要一个还能用的 `client / server / account` —— 那是连接层的私有资产，只有这一层拿得到。
 */
export const performHostSwitch = async (
  runtime: HostSwitchRuntime,
  targetId: string,
): Promise<boolean> => {
  const previousId = runtime.currentHostId()
  const previousName = runtime.currentHostName()
  let target: RemoteHostInfo
  try {
    // 1. 静态校验：这一步**一行连接操作都不做**（离线 / 身份不符直接拒绝）
    target = resolveHostSwitchTarget(runtime.hosts(), targetId)
  } catch (error) {
    const info = describeRemoteError(error)
    runtime.report({
      status: 'failed',
      targetId,
      targetName: hostNameOf(runtime.hosts(), targetId),
      code: info.code,
      message: error instanceof RemoteApiError ? error.message : info.text,
    })
    return false
  }
  if (previousId === target.deviceId) {
    // 2. 已经在这台：当成「刷新一下」。**不拆连接** —— 拆了用户正在进行的对话就白断了
    runtime.report({ status: 'idle' })
    return true
  }
  runtime.report({ status: 'switching', targetId: target.deviceId, targetName: target.name })
  await runtime.disconnect()
  try {
    // 3. 连新 Host（成功时 establishSession 会把 `dsp.remote.last-session.v1` 改写成新那台）
    await runtime.connect(target.deviceId)
    runtime.report({ status: 'idle' })
    return true
  } catch (error) {
    // 4. 回滚：把原来那台连回来。连不回来也不算「更糟」——
    //    phase 已经是 error，界面那条「重试连接」照样有效。
    const info = describeRemoteError(error)
    let rolledBackTo: string | undefined
    if (previousId !== null) {
      try {
        await runtime.connect(previousId)
        rolledBackTo = previousName === null ? hostNameOf(runtime.hosts(), previousId) : previousName
      } catch {
        rolledBackTo = undefined
      }
    }
    runtime.report({
      status: 'failed',
      targetId: target.deviceId,
      targetName: target.name,
      code: info.code,
      message: error instanceof RemoteApiError ? error.message : info.text,
      ...(rolledBackTo === undefined || rolledBackTo.length === 0 ? {} : { rolledBackTo }),
    })
    return false
  }
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
      // —— S3 live —— 全局运行态：`api-session/*` 增量 + 别的会话的待审批（不打开的会话也要知道）
      noteLiveEventsItem(value)
      // [R6 通知] 记录 `api-session/status` 与其他会话的审批请求（只读，不改下面的分发）
      noteRemoteNotifyItem(value)
      // [R9 红点] 别的会话的待处理审批 / 提问（按 eventId 去重；活动会话不计）
      notePendingInteractionEvent(value)
      /*
       * [S4] `$events` 是**连接级**流：上面那几条都是「整个账号」的事（目录增量、通知、
       * 别处的红点），而下面这两条是**会话级**的 —— 只许进当前会话的时间线。
       *
       * 先把 owner 取出来用一次，后面不重复读 `session.sessionId`：一拍之内它不会变，
       * 但「读两次」的写法一旦将来有人在中间插了 await，两次就会指向不同会话。
       */
      const owner = session.sessionId
      // 会话内控制（W2）：`user-questions/request` 要在 `attachWait` 里抢窗口，
      // 所以和「落时间线」分开投喂 —— 时间线归 adapter，应答状态归 sessionControls。
      ingestEventsItem(value, owner)
      if (owner === null || owner.length === 0) {
        // 会话还没开（或刚切走）：这条帧没有归宿，别写进任何 transcript
        noteSessionDrop('frame')
      } else {
        // 基线取**这个会话自己**那份（Dart：`ChatTranscript` 是 controller 的字段）
        const base = session.transcripts.get(owner) ?? session.transcript
        // `reduceEventsItem` 内部按 `waterfall.agentId` 过滤：不带/不符的 item 原样返回
        const next = reduceEventsItem(base.items, value, owner)
        if (next !== base.items) commitTranscript(session, owner, { ...base, items: next })
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

/**
 * 打开 `session/control` 投影流（W2）：会话标题 / 模型 / 权限 / 队列（`inbox`）/ 提问投影
 * 全部从这一条流来（input-B §2.5，`harness-alpha-client.ts:1439-1471`）。
 *
 * **不 await、失败静默**：它是「补充信息」而不是连接前提（没有它照样能聊）。
 * `METHOD_NOT_FOUND` / `CAPABILITY_NOT_SUPPORTED` 时只把 UI 的信息入口关掉，不写 `state.error`。
 *
 * 注意 `session/control` 与 `$events` 是两条独立的流：前者是「状态投影」，后者是「需要应答的
 * waterfall」。两边都不做重放：断线后重新开流读 baseline（`docs/protocol.md:1854-1860`）。
 */
const openControlStream = async (session: ActiveSession): Promise<void> => {
  if (session.control !== null) return
  let closed = false
  const sink: StreamSink = {
    onValue: (value) => {
      // —— S3 live —— 投影是「打开会话后」唯一能校正运行态的东西（`turn` / `turnState` / `status`）
      noteLiveControlFrame(value)
      applyControlFrame(value)
      const id = session.sessionId
      if (active !== session || id === null) return
      const transcript = session.transcript
      const items = reconcileQueuedPrompts(transcript.items, id)
      if (items === transcript.items) return
      commitTranscript(session, id, { ...transcript, items })
      scheduleTimelinePersist(session, id)
    },
    onClosed: (reason, failure) => {
      closed = true
      session.control = null
      if (reason === 'failed') noteControlUnavailable(failure?.code)
    },
  }
  try {
    const handle = await openWithSink(
      session,
      () => session.link.openStream(CONTROL_STREAM_ENDPOINT, { args: {} }, { timeoutMs: 30_000 }),
      sink,
    )
    session.control = closed ? null : handle
  } catch (error) {
    noteControlUnavailable(errorCodeOf(error))
  }
}

/** 拆掉当前连接（幂等；主动断开时不能把 `closed` 报成错误）。 */
const shutdown = async (): Promise<void> => {
  const session = active
  active = null
  observeRemoteTarget(null)
  if (session === null) return
  session.closing = true
  unbindSessionControls()
  session.sinks.clear()
  session.unrouted.clear()
  // 外部接收器要先收到一次「连不上了」，否则它们会一直等一个永远不会来的帧
  drainListeners(session, { type: 'closed', reason: 'peer-disconnected' })
  await closeStreamQuietly(session, session.follow)
  await closeStreamQuietly(session, session.events)
  await closeStreamQuietly(session, session.control)
  session.follow = null
  session.events = null
  session.control = null
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

/* ── 上次连接（K4）：连上了就把「连的是谁」记下来 ───────────────────────
 * 只记非敏感字段（服务器 / 邮箱 / Host 标识 / 能力快照），token 仍然只在 `storage.ts`。
 * 写盘失败（配额满 / 隐私模式）**不影响连接结果**：这一次照常用，只是下次启动恢复不了。 */

interface RememberLastSessionInput {
  serverUrl: string
  account: Pick<RemoteAccount, 'email'>
  host: Pick<RemoteHost, 'deviceId' | 'name'>
  capabilities: readonly string[]
  transport: string
}

const rememberLastSession = (input: RememberLastSessionInput): void => {
  const saved = writeLastSession({
    serverUrl: input.serverUrl,
    email: input.account.email,
    hostDeviceId: input.host.deviceId,
    hostName: input.host.name,
    capabilities: input.capabilities,
    transport: input.transport,
  })
  // 连上了 = 这个进程的「自动恢复」有了结论：就算上一次是 fail，也已经是过去式
  autoConnectSettled = true
  useRemoteStore.setState({
    ...(saved === null ? {} : { lastSession: saved }),
    autoConnect: { state: 'done' },
  })
}

/** 连接收尾（临时断开与退出登录共用）：停连接、停保活、清「登录中」的会话、复位本地游标 */
const teardownConnection = (): void => {
  sshReconnectInput = null
  // R8：断线**保留**缓存（下次打开还要用它直出），但要把攒着的内容先写完
  flushTimelinePersist()
  void shutdown()
  setPaging(false, false)
  // [R10] 用户主动断开 = 放弃这次连接：正在跑的退避自愈必须立刻停手，
  // 否则它会「过几秒又自己连回来」，让「断开」这个动作看起来没生效。
  cancelReconnect()
  // 登录会话也跟着作废：浏览器授权页还开着的话顺手关掉（不 await：断开不该被原生桥拖住）
  if (useRemoteStore.getState().qr?.mode === 'browser') void closeAuthPage()
  abortResume()
  // 断开 = 主动放弃这次登录：盘上的待完成会话必须清掉，否则下次启动会自己续上
  clearPendingLogin()
  // 保活服务必须停（它守护的连接已经没了）
  stopKeepAliveFlow()
  // [R9 红点] 记账跟着连接作废（界面状态由 INITIAL_STATE 复位）
  resetPendingInteractions()
  // —— S3 live —— 运行态也一样：旧连接的「谁在跑」一条都不许留到下一次连接
  resetLiveSessions()
  loginServerUrl = null
  loginTokenClaimed = false
}

/* ── 动作实现 ─────────────────────────────────────────────────────────── */

const rtcRetryAfter = new Map<string, number>()
const RTC_RETRY_DELAY_MS = 45_000
let sshReconnectInput: SshHostInput | null = null
/** SSH 掉线重连的退避状态：成功连上后归零。 */
let sshReconnectAttempts = 0
let sshReconnectDelay = 1_000
const SSH_RECONNECT_MAX_ATTEMPTS = 8
let sshRestoreId: string | undefined

function createActiveSession(
  client: RemoteClient | null, server: RemoteServer, account: RemoteAccount, host: RemoteHost, link: ActiveSession['link'],
): ActiveSession {
  return {
    client, server, account, host, link,
    capabilities: [], sessionId: null, transcript: createTranscriptState(), transcripts: new Map(),
    lastTimelineWrite: null, hasMore: false, follow: null, events: null, control: null, eventClientId: null,
    sinks: new Map(), listeners: new Map(), unrouted: new Map(), closing: false,
  }
}

async function loadHostData(session: ActiveSession): Promise<void> {
  await openEventsStream(session)
  if (active !== session) return
  bindSessionControls({
    target: session.link,
    registerStreamSink: registerRemoteStreamSink,
    eventClientId: () => active === session ? session.eventClientId : null,
  })
  void openControlStream(session)
  patchCacheStatus({ sessionsSyncing: true })
  const rows = await listSessions(session.link)
  if (active === session) applyRemoteSessionRows(rows)
}

async function connectSshFlow(input: SshHostInput, restoreId?: string): Promise<boolean> {
  cancelReconnect()
  const generation = reconnectGeneration
  sshReconnectInput = input
  sshRestoreId = restoreId
  flushTimelinePersist()
  stopKeepAliveFlow()
  void closeAuthPage()
  abortResume()
  clearPendingLogin()
  await shutdown()
  if (generation !== reconnectGeneration) return false
  resetLiveSessions()
  resetPendingInteractions()
  setPaging(false, false)
  autoConnectSettled = true
  useRemoteStore.setState({ ...INITIAL_STATE, phase: 'connecting', autoConnect: { state: 'done' } })
  let session: ActiveSession | undefined
  try {
    const { createSshHost, rememberSshProfile, validateSshHost } = await import('./sshHost.js')
    if (generation !== reconnectGeneration) return false
    const profile = validateSshHost(input)
    const { deviceId } = loadOrCreateIdentity()
    const authority = profile.host.includes(':') ? '[' + profile.host + ']' : profile.host
    const server = { url: 'ssh://' + authority + ':' + profile.port }
    const host: RemoteHost = {
      deviceId: JSON.stringify([profile.user, profile.mode, profile.remotePort ?? 0]),
      name: profile.host, identityKey: profile.fingerprint, online: true,
    }
    const account: RemoteAccount = { email: profile.user, deviceId, accessToken: '', refreshToken: '' }
    const start = performance.now()
    const link = createSshHost(profile, {
      onStreamEvent: (id, event) => { if (session && active === session) routeStream(session, id, event) },
      onState: (state, detail) => {
        if (state !== 'closed' || !session || active !== session || session.closing || useRemoteStore.getState().phase !== 'ready') return
        sshRestoreId = session.sessionId ?? undefined
        flushTimelinePersist()
        void shutdown()
        failConnection(new RemoteApiError(detail ?? 'CONNECTION_FAILED', 'The DSH SSH connection closed.'))
        if (sshReconnectInput === profile && useRemoteStore.getState().phase === 'error' &&
          sshReconnectAttempts < SSH_RECONNECT_MAX_ATTEMPTS) {
          const retryGeneration = reconnectGeneration
          // 固定 1 秒会在一抖就重下一遍 SSH 登录 + 端口转发（managed 模式还要起进程）：
          // 按 1/2/4/…/30 秒退避，次数用完就把错误留在界面上等用户手动重连。
          const delay = sshReconnectDelay
          sshReconnectAttempts += 1
          sshReconnectDelay = Math.min(30_000, sshReconnectDelay * 2)
          setTimeout(() => {
            if (retryGeneration === reconnectGeneration && sshReconnectInput === profile) void connectSshFlow(profile, sshRestoreId)
          }, delay)
        }
      },
    })
    active = session = createActiveSession(null, server, account, host, link)
    await link.ready()
    if (active !== session) return false
    const measuredAt = Date.now()
    const connectMs = Math.round(performance.now() - start)
    session.capabilities = ['dsh.http.v1']
    observeRemoteTarget(link)
    useRemoteStore.setState({
      transport: 'ssh', capabilities: session.capabilities, hostId: host.deviceId,
      activeServerUrl: server.url, hosts: toHostInfoList([host]),
      connectionDiagnostics: { connectMs, secureChannelMs: connectMs, capabilityProbeMs: 0, hostRequestMs: 0, measuredAt },
    })
    await loadHostData(session)
    if (active !== session) return false
    sshReconnectInput = profile
    rememberSshProfile(profile)
    rememberLastSession({ serverUrl: server.url, account, host, capabilities: session.capabilities, transport: 'ssh' })
    useRemoteStore.setState({ phase: 'ready' })
    sshReconnectAttempts = 0
    sshReconnectDelay = 1_000
    if (restoreId && useRemoteStore.getState().sessions.some((row) => row.id === restoreId)) await openSessionFlow(restoreId)
    return active === session
  } catch (error) {
    if (generation !== reconnectGeneration || (session && active !== session)) return false
    await shutdown()
    if (generation === reconnectGeneration) {
      failConnection(error)
      const code = errorCodeOf(error)
      if (code === 'PEER_IDENTITY_MISMATCH' || code === 'SSH_AUTH_FAILED' || code === 'SSH_INVALID_KEY' ||
        code === 'SSH_DSH_LOGIN_FAILED' || code === 'INVALID_SSH_REQUEST') {
        sshReconnectInput = null
      }
    }
    return false
  }
}

/**
 * 登录拿到**设备账号**之后的全部动作：列 Host → 建安全通道 → 握手 → `$events` → 首屏列表，
 * 最后**记下这次连接**（`dsp.remote.last-session.v1`，下次启动据此自动连回来）。
 *
 * 为什么抽出来：`connect()`（邮箱密码）、浏览器授权、扫码登录、以及**重启后的自动恢复**
 * 最终都换回**同一个**设备账号，后面这段必须只有一份实现 —— 否则几条路会各自漂移
 * （审批要 `clientId`、首屏要约会话列表，漏一处就是「连上了但空白」；
 * 漏记 last-session 就是「重启又要重新登录」，也就是这个函数被拆出来修的那个 bug）。
 * `connect()` 的签名与对外行为一字未改，只是它的第 3-7 步搬进了这里。
 *
 * `options.preferredHostId`：自动恢复时优先连回上次那台 Host（见 `pickHost`）。
 */
const establishSession = async (
  client: RemoteClient,
  server: RemoteServer,
  device: RemoteAccount,
  options: { preferredHostId?: string; reconnectHistory?: boolean } = {},
): Promise<void> => {
  const compactHistory = options.reconnectHistory ?? loadCompactHistory()
  let sessionRef: ActiveSession | null = null
  try {
    // 3. 列 Host（内部已经补好 presence 与 identityKey pin）
    const listedHosts = await client.listHosts(server, device)
    /*
     * [R14 多 Host] 顺手把整份 Host 列表记进 state：切换下拉要显示「账号下还有哪几台、谁在线」，
     * 而这份数据本来就已经拉回来了（不多打一次网络 —— `listHosts` 内部还并发探活）。
     */
    useRemoteStore.setState({ hosts: toHostInfoList(listedHosts) })
    const host = pickHost(listedHosts, options.preferredHostId)

    useRemoteStore.setState({ phase: 'connecting' })

    // Each transport attempt has its own authorized connection and Noise session.
    const openLink = (mode?: RtcMode): SecureLink => {
      const link = createSecureLink({
        ...buildLinkOptions({ server, account: device, host }),
        hostIdentityKey: host.identityKey,
        useRelayNode: loadAdaptiveTransport(),
        ...(mode === undefined ? {} : {
          rtc: { mode, iceServers: (connectionId: string) => getConnectionIceServers(server, device.accessToken, connectionId) },
        }),
        onStreamEvent: (streamId, payload) => {
          if (sessionRef?.link === link) routeStream(sessionRef, streamId, payload)
        },
        onState: (state, detail) => {
          const current = active
          if (state !== 'closed' || current?.link !== link || current.closing) return
          if (useRemoteStore.getState().phase !== 'ready') return
          void shutdown()
          handleLinkClosed(detail, current.compactHistory)
        },
      })
      return link
    }

    const rtcEnabled = loadAdaptiveTransport() && typeof RTCPeerConnection === 'function'
    const retryKey = (mode: RtcMode) => JSON.stringify([server.url, device.deviceId, host.deviceId, host.identityKey, mode])
    const attemptModes: (RtcMode | undefined)[] = []
    if (rtcEnabled) {
      for (const mode of ['direct', 'turn'] as const) {
        if ((rtcRetryAfter.get(retryKey(mode)) ?? 0) <= Date.now()) attemptModes.push(mode)
      }
    }
    attemptModes.push(undefined)
    let link = openLink(attemptModes[0])

    const session = createActiveSession(client, server, device, host, link)
    active = session
    sessionRef = session

    // 5. 控制面握手 + `harness.transport.describe`（拿不到 v1|v3 就 fail-closed）
    const connectStarted = performance.now()
    let connected: Awaited<ReturnType<RemoteClient['connect']>> | undefined
    for (const [index, mode] of attemptModes.entries()) {
      try {
        connected = await client.connect(server, device, host, link, {
          ...(mode ? { timeoutMs: 57_000 } : {}),
          compactHistory,
          requireCompactHistory: options.reconnectHistory === true,
        })
        break
      } catch (error) {
        if (active !== session) return
        if (mode === undefined || errorCodeOf(error) !== 'WEBRTC_UNAVAILABLE') throw error
        const now = Date.now()
        for (const [key, retryAt] of rtcRetryAfter) if (retryAt <= now) rtcRetryAfter.delete(key)
        rtcRetryAfter.set(retryKey(mode), now + RTC_RETRY_DELAY_MS)
        link = session.link = openLink(attemptModes[index + 1])
      }
    }
    if (!connected) throw new RemoteApiError('CONNECTION_FAILED', '无法建立远程连接')
    if (active !== session) return
    session.capabilities = connected.capabilities
    session.compactHistory = connected.compactHistory === true
    observeRemoteTarget(link)
    useRemoteStore.setState({
      phase: 'ready',
      capabilities: [...connected.capabilities],
      transport: toTransport(connected.transport),
      error: null,
      // [R14 多 Host] 真的握上手才算「当前这台」：下拉里的对勾与「正在连接 x」都读它
      hostId: host.deviceId,
      activeServerUrl: server.url,
      connectionDiagnostics: rtcEnabled ? { ...connected.diagnostics, connectMs: Math.round(performance.now() - connectStarted) } : connected.diagnostics,
    })
    // 1-5 都过了就是「连上了」：立刻记下来（`$events` / 首屏列表再抖，下次启动也能恢复 ——
    // 那两步是被动拉数据，失败不该剥夺用户的「记住这台 Host」）
    rememberLastSession({
      serverUrl: server.url,
      account: device,
      host,
      capabilities: connected.capabilities,
      transport: connected.transport,
    })
    // 连上了就把原生保活拉起来：用户随时可能切到系统浏览器授权，页面定时器会被冻结。
    // 不 await：保活失败不该拖住首屏（也不该影响连接结果）。
    void refreshKeepAliveFlow()

    await loadHostData(session)
  } catch (error) {
    if (sessionRef !== null && active !== sessionRef) return
    // 已经 ready 之后才失败的（`$events` / 首屏）：保活服务不该继续守护一条死连接
    stopKeepAliveFlow()
    await shutdown()
    failConnection(error)
  }
}

/** 邮箱密码登录 → 设备注册 → 建链（`connect()` 的完整实现，行为保持不变）。 */
const connectOnce = async (serverUrl: string, email: string, password: string): Promise<void> => {
  sshReconnectInput = null
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
  if (active !== null) return
  try {
    await ensureOAuthProviders({ url: normalizeServerUrl(serverUrl ?? lastUsedServerUrl()) })
  } catch (error) {
    const { phase } = useRemoteStore.getState()
    if (active === null && (phase === 'idle' || phase === 'error')) noteSignInError(error)
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
    // [R10] 用户要重新登录了：正在跑的退避自愈必须让路（否则两条建链会互相覆盖 `active`）
    cancelReconnect()
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
 * 回到前台（`visibilitychange → visible` / `focus`）时的一次性补齐。
 *
 * 为什么四件事都要做：
 *   ① 用户可能刚从系统浏览器授权回来 → `resumeLogin()` 续上被杀进程前的那次登录；
 *   ② 后台的 `setTimeout` 会被系统节流，2s 轮询定时器可能整段停摆 → 立刻补一拍
 *      （恢复流程在跑时它自己会拍，这里会被单飞让路，不会多打）；
 *   ③ 系统可能在后台把保活服务杀掉 → 探一次，`shouldRun && !running` 就补一次 start；
 *   ④ **R10**：后台待久了连接已经被服务端踢掉（75 s 心跳超时 / 4002），
 *      `phase !== 'ready'` 且盘上有 last-session → **立刻**走一轮自愈。
 *      为什么不靠定时器：后台的 `setTimeout` 被冻结，回前台时才一起醒来；等它不如直接连。
 *
 * 四件事都是幂等 + 静默：这条路径会被反复触发，不能因为「本来就没事」而弹提示。
 */
const foregroundFlow = async (): Promise<void> => {
  await Promise.all([
    resumeLoginFlow().catch(() => undefined),
    pollProviderLoginFlow().catch(() => undefined),
    refreshKeepAliveFlow(),
    // 不等：自愈可能要退避重试几十秒，回前台的其它补齐不该被它拖住
    startReconnect({ reason: 'foreground', immediate: true }).catch(() => undefined),
  ])
}

/* ══════════════════════════════════════════════════════════════════════════
 * 掉线自愈（R10）：**「连接断了」和「凭据失效」彻底分开**
 *
 * 用户原话：「放后台很久重新打开就会显示什么凭据失效啥的，但是重启一下就好了」
 *          「连接失败你就刷新一下就好了呀……自动重新连一下就好了呀」。
 *
 * 设计（判定全在 `reconnect.ts` 的纯函数里，这里只负责按 step 去做）：
 *
 * ```
 * link 意外关闭 / 回前台时 phase≠ready / 用户点「立即重连」
 *    │
 *    ▼ classifyFailure(detail / error)
 *   ┌───────────────┬────────────────────┬──────────────────┬──────────────────┐
 *   │ offline       │ unreachable        │ token-expired    │ need-login/blocked│
 *   │ 没网          │ 超时/1006/4001/4009│ 401/4002/TOKEN_  │ 撤销/身份/会员/版本│
 *   ▼               ▼                    ▼                  ▼
 *  退避重连        退避重连           先 refresh 再重连     停止（红字 + 明确文案）
 *  1/2/4/8/16 s    1/2/4/8/16 s       每次恢复只刷一次      **不动** last-session / 账号
 *   │               │                    │
 *   └───────┬───────┴────────────────────┘
 *           ▼
 *     establishSession() ──成功──► restoreActiveSession()（顺手把上次开着的会话重开）
 *           │
 *        失败 → 回到分诊（最多 5 次）；5 次用完 = 「暂时连不上」+「立即重连」（中性，不多说一句凭据）
 * ```
 *
 * **纪律**：这条路径**永不**调用 `clearLastSession()` / `removeAccount()` / `clearRemoteStorage()`
 * —— 清凭据只允许发生在用户点「退出登录」时。这是用户那句「重启一下就好了」的根因：
 * 以前异步失败会顺手清掉 last-session，重启后连「上次连的是哪台」都没有了。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 恢复流程的模块级进度（不进 zustand：不是渲染数据） */
let recoveryState: RecoveryState = { ...INITIAL_RECOVERY_STATE }
/** 代际：`disconnect()` / 手动登录 / 重新发起恢复时自增，旧循环看到代数变了就收工 */
let reconnectGeneration = 0
/** 当前正在跑的重连循环（单飞） */
let reconnectInFlight: Promise<void> | null = null
/** 退避定时器（同一时刻只有一个循环，所以一个句柄就够） */
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
/**
 * 正在等退避的那个循环的「唤醒开关」。
 *
 * 为什么需要：`disconnect()` 会把定时器清掉，如果只 `clearTimeout`，那个 Promise
 * **永远不会 resolve** —— 等待中的循环会变成一个永远挂着的任务（泄漏，而且调试时看起来
 * 「有一次重连莫名其妙没跑」）。所以取消时要显式把它唤醒，让循环自己看到代数变了然后收工。
 */
let reconnectWake: (() => void) | null = null

const RECONNECT_NEED_LOGIN_MESSAGE = '上次的登录凭据已经过期，请重新登录'
const RECONNECT_OFFLINE_MESSAGE = '网络已断开；连上网络后会自动重连（凭据仍然有效）'
const RECONNECT_UNREACHABLE_MESSAGE = '连接中断了，暂时连不上服务器（凭据仍然有效）'
const RECONNECT_STARTUP_MESSAGE = '上次连接没成功，点「立即重连」再试一次（凭据仍然有效）'

const setReconnect = (patch: Partial<RemoteReconnectState>): void => {
  const previous = useRemoteStore.getState().reconnect
  const next: RemoteReconnectState = { ...previous, ...patch }
  if (
    next.status === previous.status &&
    next.attempt === previous.attempt &&
    next.code === previous.code &&
    next.kind === previous.kind &&
    next.nextRetryAt === previous.nextRetryAt
  ) {
    return
  }
  useRemoteStore.setState({ reconnect: next })
}

/** 停掉正在跑的恢复（幂等）：抬高代际 + 唤醒等待中的循环 + 复位进度 */
const cancelReconnect = (): void => {
  reconnectGeneration += 1
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  const wake = reconnectWake
  reconnectWake = null
  wake?.()
  // 旧循环会在下一次代际检查时自己退出；这里立刻放开单飞，新的恢复不用等它醒
  reconnectInFlight = null
  recoveryState = { ...INITIAL_RECOVERY_STATE }
}

/** 等退避；返回 `false` 表示「这一代已经作废了」（期间用户断开 / 重新发起过） */
const sleepOrAbort = (delayMs: number, generation: number): Promise<boolean> => {
  if (delayMs <= 0) return Promise.resolve(generation === reconnectGeneration)
  return new Promise<boolean>((resolve) => {
    reconnectWake = () => resolve(false)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      reconnectWake = null
      resolve(generation === reconnectGeneration)
    }, delayMs)
  })
}

/** 从 `state.error`（`{code,message}`）折出分诊用的形状 */
const failureFromErrorState = (error: { code: string; message: string } | null): FailureInput => ({
  code: error?.code ?? 'CONNECTION_FAILED',
  message: error?.message,
})

interface RecoveryRoundResult {
  ok: boolean
  failure: FailureInput | null
  /** 这一轮真的打了 `POST /auth/refresh`（刷新只允许一次，调用方据此记账） */
  refreshed: boolean
}

/**
 * 一次恢复尝试（**一轮**：可选先 refresh → `establishSession`）。
 *
 * 为什么把「refresh」也放进来：刷新后必须用**新**的 pair 建链（refresh token 会轮换，
 * 拿旧 token 去握手只会再撞一次 401 —— 那正是「第一次连不上、再点一次就好了」的来源）。
 *
 * 不删任何凭据：读盘失败 / 记录缺失只返回一条 need-login 级别的失败，让用户自己去设置页。
 */
/**
 * 一轮恢复的**串行闸门**。
 *
 * 为什么需要：启动恢复（挂载 effect）、回前台自愈、用户点「立即重连」可能同时到，
 * 而 `establishSession()` 是不可重入的（它会把模块级 `active` 覆盖掉、泄漏前一条连接）。
 * 这里让所有轮次排队执行：**串行**而不是「后到者复用前一人的结果」—— 复用一个**别的代际**
 * 的轮次会让新循环白白消耗一次尝试（还会带上一轮的失败码）。
 */
let recoveryGate: Promise<void> = Promise.resolve()

const runRecoveryRound = (options: { refreshFirst: boolean; reconnectHistory?: boolean }): Promise<RecoveryRoundResult> => {
  const task: Promise<RecoveryRoundResult> = recoveryGate.then(() => runRecoveryRoundOnce(options))
  recoveryGate = task.then(
    () => undefined,
    () => undefined,
  )
  return task
}

const runRecoveryRoundOnce = async (options: { refreshFirst: boolean; reconnectHistory?: boolean }): Promise<RecoveryRoundResult> => {
  const last = readLastSession()
  if (last === null) {
    // 没记住「连哪台」：什么都没得恢复（不是错误，静默）
    return { ok: false, failure: { code: 'NO_SESSION' }, refreshed: false }
  }
  const plan = planAutoConnect(last, loadAccounts(), Date.now())
  useRemoteStore.setState({ lastSession: last })
  if (plan.kind === 'none') {
    // 账号记录不在了 / 还没注册设备。**不删 last-session**（只有退出登录才删）：
    // 用户很可能只是「换了账号」，登录之后还能连回同一台 Host。
    return {
      ok: false,
      failure: { code: 'NO_CREDENTIAL', message: '本机没有可用的登录凭据，请重新登录' },
      refreshed: false,
    }
  }
  if (plan.kind === 'expired') {
    // refresh token 明确过期：再刷也没用，但**不删任何东西**，只报「要重新登录」
    return { ok: false, failure: { code: 'REFRESH_TOKEN_EXPIRED', message: RECONNECT_NEED_LOGIN_MESSAGE }, refreshed: false }
  }

  const server: RemoteServer = { url: plan.session.serverUrl }
  const client = createRemoteClient()
  let account = plan.account
  const wantRefresh = options.refreshFirst || plan.refresh
  if (wantRefresh) {
    if (account.refreshToken.length === 0) {
      return {
        ok: false,
        failure: { code: 'NO_CREDENTIAL', message: '本地没有可用于刷新的 refreshToken，请重新登录' },
        refreshed: false,
      }
    }
    try {
      // refresh token 会轮换：拿到新 pair 必须**原子替换**本地那一条（storage 是唯一真源）
      const pair = await refreshTokenApi(server, account.deviceId, account.refreshToken)
      account = upsertAccount({ ...account, ...pair })
    } catch (error) {
      /*
       * 刷新这一步自己失败了（401 / 过期 / 网络）。
       *
       * **必须**换成 `REFRESH_FAILED`，不能把原始的 `AUTH_INVALID` / 401 往上抛：
       * 那条 401 的分诊结果是「先刷新」，会变成「刷新失败 → 再去刷新」的死循环。
       * 刷新都失败了才是真的「登录过期」，这里一次性定性（`reconnect.ts` 的 need-login）。
       */
      const info = describeRemoteError(error)
      return {
        ok: false,
        failure: {
          code: 'REFRESH_FAILED',
          status: isRemoteApiError(error) ? (error.status ?? null) : null,
          message: info.text,
        },
        refreshed: true,
      }
    }
  }
  // `establishSession` 自己接住所有建链错误（不抛），失败信息在 state 里
  await establishSession(client, server, account, {
    preferredHostId: plan.session.hostDeviceId, reconnectHistory: options.reconnectHistory,
  })
  if (useRemoteStore.getState().phase === 'ready') return { ok: true, failure: null, refreshed: wantRefresh }
  return { ok: false, failure: failureFromErrorState(useRemoteStore.getState().error), refreshed: wantRefresh }
}

/**
 * 连回来之后把**上次开着的会话**重新打开。
 *
 * 为什么必须做：新连接是全新的 `ActiveSession`（`sessionId: null`、没有 follow 流），
 * 而 `state.activeSessionId` 还停在旧值 —— 用户会看到「会话还开着但发不出消息 / 时间线不更新」。
 */
const restoreActiveSession = async (): Promise<void> => {
  const state = useRemoteStore.getState()
  const id = state.activeSessionId
  if (id === null) return
  if (active === null) return
  if (!state.sessions.some(item => item.id === id)) return
  await openSessionFlow(id)
}

/**
 * 恢复停下时的**呈现**：这是「凭据失效 vs 连接断了」的分界在界面上的落点。
 *
 * | tone | 界面 |
 * |---|---|
 * | `neutral`（网络类 / 用完了 5 次） | 相位回 `idle`、**不写 `state.error`**、只给一行中性说明 +「立即重连」 |
 * | `error` + `needLogin` | 「登录已过期，请重新登录」（`autoConnect.code = SESSION_EXPIRED`） |
 * | `error` + blocked | 保留具体码与中文说明（设备撤销 / 身份不符 / 版本不兼容） |
 * | `silent` | 什么都不动（用户主动取消） |
 */
const presentRecoveryStop = (stop: {
  code: string
  failureKind: FailureKind
  needLogin: boolean
  tone: 'neutral' | 'error'
  silent: boolean
  /** 覆盖默认文案（启动失败与中途掉线说法不同） */
  message?: string
}): void => {
  if (stop.silent) {
    setReconnect({ status: 'idle', attempt: 0, code: undefined, kind: undefined, nextRetryAt: undefined })
    return
  }

  if (stop.tone === 'error') {
    const message = stop.needLogin
      ? stop.message ?? RECONNECT_NEED_LOGIN_MESSAGE
      : stop.message ?? remoteErrorText(stop.code)
    setReconnect({
      status: stop.needLogin ? 'need-login' : 'blocked',
      attempt: recoveryState.attempt,
      code: stop.code,
      kind: stop.failureKind,
      nextRetryAt: undefined,
    })
    useRemoteStore.setState({
      phase: 'error',
      error: { code: stop.code, message },
      transport: null,
      streaming: false,
      // 登录过期沿用旧的 `SESSION_EXPIRED` 码：远程页/设置页的「请重新登录」分支不必改
      autoConnect: stop.needLogin
        ? { state: 'failed', code: 'SESSION_EXPIRED', message }
        : { state: 'failed', code: stop.code, message },
    })
    return
  }

  // 中性：连不上而已，**凭据一个字都不能提**
  const message =
    stop.message ??
    (stop.failureKind === 'offline' ? RECONNECT_OFFLINE_MESSAGE : RECONNECT_UNREACHABLE_MESSAGE)
  setReconnect({
    status: 'failed',
    attempt: recoveryState.attempt,
    code: stop.code,
    kind: stop.failureKind,
    nextRetryAt: undefined,
  })
  useRemoteStore.setState({
    phase: 'idle',
    error: null,
    transport: null,
    streaming: false,
    autoConnect: { state: 'failed', code: stop.code, message },
  })
}

/** 分诊 → 下一轮；`step.action === 'stop'` 就落定 */
const runReconnectLoop = async (
  generation: number,
  initialFailure: FailureInput | null,
  immediate: boolean,
  reconnectHistory?: boolean,
): Promise<void> => {
  let failure = initialFailure
  let step: RecoveryStep = planRecoveryStep(recoveryState, failure, { immediate })

  for (;;) {
    if (generation !== reconnectGeneration) return

    if (step.action === 'stop') {
      presentRecoveryStop({
        code: step.code,
        failureKind: step.failureKind,
        needLogin: step.needLogin,
        tone: step.tone,
        silent: step.silent,
      })
      return
    }

    // 用户已经自己连上了 / 正在手动建链：这一轮没有意义，静默收工
    if (connecting || active !== null || useRemoteStore.getState().phase === 'ready') {
      if (active !== null || useRemoteStore.getState().phase === 'ready') {
        setReconnect({ status: 'idle', attempt: 0, code: undefined, kind: undefined, nextRetryAt: undefined })
      }
      return
    }

    if (step.delayMs > 0) {
      // 退避期间就把相位摆成 connecting：界面显示「正在重连…」而不是闪一下「未连接」
      const hint = failure === null ? null : classifyFailure(failure)
      setReconnect({
        status: 'waiting',
        attempt: step.attempt,
        code: hint?.code,
        kind: hint?.kind,
        nextRetryAt: Date.now() + step.delayMs,
      })
      useRemoteStore.setState({ phase: 'connecting', error: null, autoConnect: { state: 'connecting' } })
      const alive = await sleepOrAbort(step.delayMs, generation)
      if (!alive) return
    } else {
      const hint = failure === null ? null : classifyFailure(failure)
      setReconnect({
        status: 'connecting',
        attempt: step.attempt,
        code: hint?.code,
        kind: hint?.kind,
        nextRetryAt: undefined,
      })
      useRemoteStore.setState({ phase: 'connecting', error: null, autoConnect: { state: 'connecting' } })
    }

    const result = await runRecoveryRound({ refreshFirst: step.refresh, reconnectHistory })
    if (generation !== reconnectGeneration) return

    if (result.ok) {
      setReconnect({ status: 'idle', attempt: 0, code: undefined, kind: undefined, nextRetryAt: undefined })
      await restoreActiveSession()
      return
    }

    // 记账：refresh 用过一次就不许再用（哪怕这一轮的刷新是 `planAutoConnect` 决定要刷的）
    const advanced = advanceRecoveryState(recoveryState, step)
    recoveryState = { attempt: advanced.attempt, refreshUsed: advanced.refreshUsed || result.refreshed }
    failure = result.failure
    step = planRecoveryStep(recoveryState, failure)
  }
}

interface StartReconnectOptions {
  reconnectHistory?: boolean
  /** 触发原因（诊断用；不进状态） */
  reason: string
  /** 首轮不等退避（回前台 / 用户点击 / 刚掉线） */
  immediate?: boolean
  /** 触发这次恢复的那条失败（不回前台时由 link close 传入） */
  failure?: FailureInput | null
  /** 已经有一轮在跑时是否打断重开（用户点「立即重连」） */
  restart?: boolean
}

/**
 * 启动一轮恢复（单飞）。这个函数**永远不抛**，也永远不阻塞调用方。
 *
 * 什么时候什么都不做：非原生壳（没有 `/__ds_proxy`）、盘上没有 last-session、
 * 正在手动登录（`connecting`）或正在等授权（`waiting-auth`）。
 */
const startReconnect = (options: StartReconnectOptions): Promise<void> => {
  if (!isNativeShell()) return Promise.resolve()
  if (sshReconnectInput) {
    if (useRemoteStore.getState().phase === 'error' && options.reason === 'foreground') {
      return connectSshFlow(sshReconnectInput, sshRestoreId).then(() => undefined)
    }
    return Promise.resolve()
  }
  if (connecting) return Promise.resolve()
  const state = useRemoteStore.getState()
  // 掉线自愈时 `shutdown()` 已经把 active 清空，但 phase 可能还停在 ready（没有新状态到达）。
  // 只有「真的还有一条活连接」才该拦下重连，否则自愈会被自己的相位守卫吃掉。
  if (state.phase === 'ready' && active !== null) return Promise.resolve()
  if (state.phase === 'authing' || state.phase === 'waiting-auth') return Promise.resolve()
  /*
   * 这两种结论是**人**才能解决的（登录过期 / 设备撤销 / 身份不符）：
   * 回前台的自动重连不该一直去撞它们（只会反复失败 + 反复闪文案），
   * 但用户主动点「立即重连」/ 设置页的「重新连接」可以强来（`restart: true`）。
   */
  if (options.restart !== true && (state.reconnect.status === 'need-login' || state.reconnect.status === 'blocked')) {
    return Promise.resolve()
  }
  const saved = readLastSession()
  if (saved === null || saved.transport === 'ssh') return Promise.resolve()
  // 启动恢复正在飞：让它先落地（它自己会写 autoConnect 状态），别两条建链抢 `active`
  if (autoConnectInFlight !== null) return autoConnectInFlight.then(() => undefined)
  if (options.restart !== true && reconnectInFlight !== null) return reconnectInFlight

  cancelReconnect()
  const generation = reconnectGeneration
  const task: Promise<void> = runReconnectLoop(generation, options.failure ?? null, options.immediate === true, options.reconnectHistory)
    .catch(() => undefined)
    .finally(() => {
      if (reconnectInFlight === task) reconnectInFlight = null
    })
  reconnectInFlight = task
  return task
}

/**
 * 连接**意外**关闭的分诊入口（`SecureLink.onState('closed', detail)`）。
 *
 * `detail` 形如 `TRANSPORT_CLOSED: 原生桥关闭：heartbeat timeout（code=4009）` ——
 * 真实的失败码和 WS close code 都藏在这句话里（`core/` 不在本次可改范围，只能解析字符串）。
 */
const handleLinkClosed = (detail?: string, reconnectHistory?: boolean): void => {
  const parsed = parseLinkCloseDetail(detail)
  const failure: FailureInput = {
    code: parsed.code ?? 'TRANSPORT_CLOSED',
    closeCode: parsed.closeCode ?? null,
    message: parsed.message ?? null,
  }
  const verdict = classifyFailure(failure)

  // 没东西可恢复（没连过 / 只是浏览器预览）：保持旧行为，如实报错
  if (readLastSession() === null || !isNativeShell()) {
    failConnection(new RemoteApiError(verdict.code, parsed.message ?? remoteErrorText(verdict.code)))
    return
  }
  // 已经有一轮自愈在跑：这一轮的结果交给那个循环去分诊（别在这里再起一条）
  if (reconnectInFlight !== null) {
    /*
     * [R17 假 ready] `active` 已经被 onState 清掉了，phase 不能继续谎报 ready：
     * 在跑的那轮自愈会用自己的结果覆盖 phase；它回来之前界面必须按「未连接」讲实话，
     * 否则「点哪个会话都进不去、错误还看不见」就从这里开始。
     */
    if (useRemoteStore.getState().phase === 'ready') {
      useRemoteStore.setState({ phase: 'connecting', streaming: false })
    }
    return
  }
  if (!verdict.auto) {
    // 真需要人处理（设备撤销 / 身份不符 / 版本不兼容）：立刻落定成明确文案
    presentRecoveryStop({
      code: verdict.code,
      failureKind: verdict.kind,
      needLogin: verdict.needLogin,
      tone: verdict.tone,
      silent: verdict.silent,
    })
    return
  }
  /*
   * 掉线自愈：**不**用 `immediate`，按协议的退避来（1 s / 2 s / 4 s / 8 s / 16 s）。
   *
   * 为什么不立刻打第一枪：服务端重启 / 心跳超时要几秒才恢复，瞬间重试只会白撞一次，
   * 而且会给 Host 侧制造「刚断就连」的噪音。用户回前台或点「立即重连」时才是真的「现在就试」，
   * 那条路径传 `immediate: true`（第一次不等退避）。
   */
  void startReconnect({ reason: 'link-closed', failure, reconnectHistory })
}

/** 前台自愈监听是否已经装过（模块级副作用只装一次） */
let foregroundSelfHealInstalled = false

/**
 * 装上「回前台 / 重新获得焦点就自愈」的监听（幂等）。
 *
 * 为什么不能只靠 UI：远程页与设置面板各有一份 `visibilitychange` 监听，但**两个都没挂载**时
 * （比如用户停在别的页签、或 WebView 被系统回收后重建）就没人负责重连了。
 * 这里装在 store 模块上，随模块加载生效；`startReconnect()` 是单飞 + 幂等，
 * 与组件那份重复触发不会多打一次网络。
 *
 * 另外还监听 `focus`：Android WebView 从后台回来时，`visibilitychange` 有时不触发，
 * `focus` 更可靠 —— 两条都挂上，重复触发由单飞吸收。
 */
export const installForegroundSelfHeal = (): void => {
  if (foregroundSelfHealInstalled) return
  foregroundSelfHealInstalled = true
  const kick = (): void => {
    void startReconnect({ reason: 'foreground', immediate: true }).catch(() => undefined)
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return
      kick()
    })
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', kick)
    /*
     * 网络恢复就立刻重连（dsh-Go `network_watch.dart` 的 `networkKicks()` 同款）：
     * Wi-Fi ↔ 蜂窝、VPN 起落之后，旧 socket 绑的还是上一块网卡，等退避到点太慢，
     * 用户看到的是「明明有网了却还连不上」。`startReconnect()` 自带单飞与相位守卫，
     * 连接还好好的时候这一下不会多打网络。
     *
     * 只挂 `online`：`offline` 不该伪造失败 —— 链路自己会 close，然后由
     * `handleLinkClosed()` 分诊成中性的「网络断开」。
     */
    window.addEventListener('online', () => {
      rtcRetryAfter.clear()
      kick()
    })
  }
}

/* ── 重启后自动恢复（K4）：启动时**只试一次**，失败交给「立即重连」 ─────── */

/**
 * 启动时的一次恢复尝试（**单拍**，不进退避循环）。
 *
 * 为什么启动不做 5 次退避：首屏要快，且用户就在屏幕前——失败给一条
 * 「上次连接没成功，点立即重连」比静默重试 30 秒更诚实。真正的掉线自愈
 *（后台回来 / 链路中途断）才走 `startReconnect()` 的退避循环。
 *
 * 与旧实现的区别（都在 `R10`）：
 *   - **不再删 last-session**（凭据记录缺失 / expired 都只报「要重新登录」）；
 *   - 失败后用 `reconnect.ts` 分诊：网络类给中性文案，只有 need-login / blocked 才是红字。
 */
const runAutoConnect = async (force: boolean): Promise<void> => {
  if (!force && autoConnectSettled) return
  const current = useRemoteStore.getState()
  // 有别的建链在进行（手动登录 / 授权轮询 / 已经连上）：这条恢复流程没有意义
  if (connecting) return
  // 掉线自愈已经在跑：让它自己跑完（它比「启动只试一次」更有耐心）
  if (reconnectInFlight !== null) return
  /*
   * [R17] 原来这里是 `if (active !== null || current.phase === 'ready') return` ——
   * 「phase==='ready」这半句会把**假 ready**（断链把 active 清了、phase 没人纠正）锁死：
   * 自动恢复永远跳过，界面照常假装已连接。建链进行中的窗口由上面的 `connecting` 挡，
   * 那半句删掉是安全的，且是「假 ready」唯一的自愈出口之一。
   */
  if (active !== null) return
  if (current.phase === 'authing' || current.phase === 'waiting-auth') return
  // 普通浏览器没有 `/__ds_proxy`：连也连不上，还会把「上次连接失败」的提示摆出来。
  // 那边本来就有「只能在 App 内使用」的降级文案，这里直接不做。
  if (!isNativeShell()) return

  const session = readLastSession()
  if (session?.transport === 'ssh') return
  if (session === null) {
    useRemoteStore.setState({ lastSession: null, autoConnect: { state: 'idle' } })
    return
  }

  useRemoteStore.setState({ lastSession: session, autoConnect: { state: 'connecting' } })
  const plan = planAutoConnect(session, loadAccounts(), Date.now())
  if (plan.kind === 'none' || plan.kind === 'expired') {
    recoveryState = { ...INITIAL_RECOVERY_STATE }
    presentRecoveryStop({
      code: plan.kind === 'expired' ? 'REFRESH_TOKEN_EXPIRED' : 'NO_CREDENTIAL',
      failureKind: 'need-login',
      needLogin: true,
      tone: 'error',
      silent: false,
      message: RECONNECT_NEED_LOGIN_MESSAGE,
    })
    return
  }

  // 从现在起界面上是「正在恢复上次连接」：phase 也进 connecting，远程页不会闪一下「未连接」
  useRemoteStore.setState({ phase: 'connecting', error: null })
  const result = await runRecoveryRound({ refreshFirst: plan.refresh })
  if (result.ok) return

  const verdict = classifyFailure(result.failure ?? { code: 'CONNECTION_FAILED' })
  recoveryState = { attempt: 1, refreshUsed: plan.refresh }
  if (verdict.needLogin || verdict.tone === 'error') {
    presentRecoveryStop({
      code: verdict.code,
      failureKind: verdict.kind,
      needLogin: verdict.needLogin,
      tone: 'error',
      silent: false,
      message: result.failure?.message ?? undefined,
    })
    return
  }
  // 网络类：中性（「上次连接没成功」），不写 error、不删任何凭据
  presentRecoveryStop({
    code: verdict.code,
    failureKind: verdict.kind,
    needLogin: false,
    tone: 'neutral',
    silent: false,
    message: verdict.kind === 'offline' ? RECONNECT_OFFLINE_MESSAGE : RECONNECT_STARTUP_MESSAGE,
  })
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

export async function connectPairedDevice(offer: PairingOffer, account: RemoteAccount) {
  if (connecting || active !== null || useRemoteStore.getState().phase === 'waiting-auth') {
    throw new RemoteApiError('RPC_ABORTED', 'A different remote sign-in is already active.')
  }
  if (account.serverUrl !== offer.server.url || loadIdentity()?.deviceId !== account.deviceId) {
    throw new RemoteApiError('PAIRING_IDENTITY_MISMATCH', 'Pairing does not match this device.')
  }
  const pin = pinHostIdentityKey(offer.server.url, offer.host)
  if (pin.state === 'mismatch') throw new RemoteApiError('PEER_IDENTITY_MISMATCH', 'Host key changed.')
  upsertServer(offer.server.url)
  const stored = upsertAccount(account)
  if (!loadAccounts().some((entry) => entry.serverUrl === account.serverUrl && entry.deviceId === account.deviceId
    && entry.email === account.email && entry.refreshToken === account.refreshToken)) {
    throw new RemoteApiError('PAIRING_STORAGE_FAILED', 'The paired credentials could not be saved.')
  }
  const lastSession = writeLastSession({
    serverUrl: offer.server.url, email: account.email, hostDeviceId: offer.host.deviceId, hostName: offer.host.name,
  })
  connecting = true
  cancelReconnect()
  try {
    await shutdown()
    setPaging(false, false)
    useRemoteStore.setState({ ...INITIAL_STATE, phase: 'connecting', lastSession })
    await establishSession(createRemoteClient(), offer.server, stored, { preferredHostId: offer.host.deviceId })
  } finally {
    connecting = false
  }
}

const connectFlow = async (serverUrl: string, email: string, password: string): Promise<void> => {
  if (connecting) return
  connecting = true
  // [R10] 手动登录优先：把正在跑的掉线自愈停掉，别让它和这次登录抢 `active`
  cancelReconnect()
  try {
    await connectOnce(serverUrl, email, password)
  } finally {
    connecting = false
  }
}

/**
 * `autoConnectNow()` / `retryAutoConnect()` 的外壳：单飞 + 兜底。
 *
 * 这条路径永远不该把异常抛给界面（它挂在渲染后的 effect 里，抛了就是一次未捕获错误）。
 */
const autoConnectFlow = (force = false): Promise<void> => {
  if (autoConnectInFlight !== null) return autoConnectInFlight
  const task: Promise<void> = runAutoConnect(force)
    .catch(() => undefined)
    .finally(() => {
      autoConnectSettled = true
      if (autoConnectInFlight === task) autoConnectInFlight = null
    })
  autoConnectInFlight = task
  return task
}

const retryAutoConnectFlow = (): Promise<void> => {
  autoConnectSettled = false
  // [R10] 顺带把「上一次恢复留下的结论」清掉：界面上不该还挂着上一轮的 failed
  setReconnect({ status: 'idle', attempt: 0, code: undefined, kind: undefined, nextRetryAt: undefined })
  return autoConnectFlow(true)
}

/**
 * 「立即重连」（R10）：**不等定时器**，直接走一轮完整的自愈循环（退避 1/2/4/8/16 s，最多 5 次）。
 *
 * 与 `retryAutoConnect()` 的区别：
 *   - `retryAutoConnect()` 是**启动恢复**那条路（单拍、失败只落一行「上次连接没成功」）；
 *   - `reconnectNow()` 是**掉线自愈**那条路（会先 refresh、会退避重试、成功还会把上次的会话重开）。
 *
 * 两个入口都幂等，并且都在「已经连上 / 正在手动登录」时什么都不做。
 */
const reconnectNowFlow = (): Promise<void> => {
  autoConnectSettled = false
  return startReconnect({ reason: 'manual', immediate: true, restart: true })
}

/* ── [R14 多 Host] 切换 / 刷新 ──────────────────────────────────────────── */

/** 单飞：切换过程要拆连接，两次并发切换会把 `active` 撕成两半 */
let switchingHost = false

/**
 * 换一台 Host：拆当前连接 → 用**同一个账号**连新 Host → 重载会话列表。
 *
 * 为什么能复用 `establishSession`：它本来就是「拿到设备账号之后的全部动作」（列 Host →
 * 建安全通道 → 握手 → `$events` → 首屏列表 → 记 last-session），换 Host 只是把
 * `preferredHostId` 指过去 —— 于是「连上之后必须做的那几件事」不会因为切换而漏掉一件。
 */
const switchHostFlow = async (targetId: string): Promise<void> => {
  if (switchingHost) return
  const session = active
  if (session === null) {
    useRemoteStore.setState({
      hostSwitch: {
        status: 'failed',
        targetId,
        code: 'NOT_CONNECTED',
        message: '还没连上电脑，没法切换主机',
      },
    })
    return
  }
  switchingHost = true
  // 拆连接之后 `active` 会被清空，所以先把这条连接的三件套拍成快照：
  // 用**同一个账号**连新 Host 靠的就是它们（token 仍然只在 `storage.ts`，这里不复制凭据）
  const { client, server, account } = session
  if (!client) {
    switchingHost = false
    return
  }
  try {
    await performHostSwitch(
      {
        hosts: () => useRemoteStore.getState().hosts,
        currentHostId: () => active?.host.deviceId ?? null,
        currentHostName: () => active?.host.name ?? null,
        disconnect: async () => {
          // 缓存按 serverUrl|hostDeviceId 分桶：先把攒着的时间线写盘，再拆
          flushTimelinePersist()
          await shutdown()
          setPaging(false, false)
          /*
           * 换 Host = 换一份数据：会话列表 / 时间线 / 待处理交互都属于某台 Host，
           * 留在界面上只会让用户点进新 Host 上不存在的会话。
           * 缓存文件本身**不删**（切回去还要用），这里只清「当前这一屏」。
           */
          useRemoteStore.setState({
            // 旧连接已经拆了：界面不能再声称「就绪」（否则这几秒里点会话只会拿到 NOT_CONNECTED）
            phase: 'connecting',
            sessions: [],
            activeSessionId: null,
            items: [],
            streaming: false,
            pendingApprovals: [],
            pendingInteractions: {},
            cacheStatus: emptyCacheStatus(),
            error: null,
          })
          // —— S3 live —— 换 Host = 换一份运行态（否则新 Host 上会亮着旧 Host 的「运行中」）
          resetLiveSessions()
        },
        connect: async (hostDeviceId: string) => {
          await establishSession(client, server, account, { preferredHostId: hostDeviceId })
          const switched = active
          if (switched === null || switched.host.deviceId !== hostDeviceId) {
            const failure = useRemoteStore.getState().error
            if (failure !== null) throw new RemoteApiError(failure.code, failure.message)
            throw new RemoteApiError('HOST_SWITCH_FAILED', '没能连上这台主机')
          }
        },
        report: (state: HostSwitchState) => {
          useRemoteStore.setState({ hostSwitch: state })
        },
      },
      targetId,
    )
  } finally {
    switchingHost = false
  }
}

/** 重新探一遍 Host 在线状态（下拉里的刷新）。失败静默：手上那份列表仍然可用 */
const refreshHostsFlow = async (): Promise<void> => {
  const session = active
  if (!session?.client) return
  try {
    const rows = await session.client.listHosts(session.server, session.account)
    if (active === session) useRemoteStore.setState({ hosts: toHostInfoList(rows) })
  } catch {
    // 连通性抖动 / 服务器拒绝：保持原样（离线主机本来就灰着），不弹错
  }
}

const refreshSessionsFlow = async (): Promise<void> => {
  let session: ActiveSession
  try {
    session = requireSession()
  } catch (error) {
    fail(error)
    return
  }
  try {
    // R8：先把「正在同步」立起来（列表可能已经是缓存直出的一屏），合并完由 applyRemoteSessionRows 落定
    patchCacheStatus({ sessionsSyncing: true })
    const rows = await listSessions(session.link)
    if (active === session) applyRemoteSessionRows(rows)
  } catch (error) {
    if (active !== session) return
    patchCacheStatus({ sessionsSyncing: false })
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
  /*
   * [S4] 先领代际工牌，再做任何 await。
   *
   * 从这一刻起，**还在飞的上一条 `openSessionFlow`（以及它的 sink）全部作废**：
   * 它们恢复执行时会发现 `flowIsCurrent()` 为 false，于是既不会覆盖 `session.follow`、
   * 也不会往 `session.transcript` 写快照 / follow 帧，还会把自己刚开出来的流关掉。
   * 没有这一步，用户连点两次会话就能让两条流程交错，造成「孤儿 follow 流」——
   * 那条流永远收不到 `close`，之后每一帧都落进「当时正好开着的会话」里。
   */
  const ticket = newFlowTicket(id)
  // 切走之前先把手上的内容写盘（攒着的最后几帧别丢）
  flushTimelinePersist()
  const previousFollow = session.follow
  session.follow = null
  void closeStreamQuietly(session, previousFollow)
  // 老流的本地接收器已经移除，展示新会话不必等待主机确认关流。
  if (active !== session || !followEpochTurnIsCurrent(ticket, sessionEpoch)) {
    noteSessionDrop('staleFlow')
    return
  }
  session.sessionId = id
  const remembered = session.transcripts.get(id)
  /*
   * R8：**先铺缓存**。有缓存就立刻直出一屏（顶部挂「正在同步…」），
   * 没缓存才进骨架 —— 两种情况都**不**显示「这个会话还没有消息」。
   * `cursor` 给 -1：缓存不持有 follow 游标，真正的游标由快照的 `cursor` 决定。
   */
  const cachedTimeline = remembered ? null : readTimelineCache({
    ...timelineBucketFor(session),
    sessionId: id,
    now: Date.now(),
  })
  /*
   * [S4] 优先用**内存里这个会话自己的那份**（照 Dart：切走的 `ChatTranscript` 还在
   * controller 里，切回来接着用；只有从没打开过的会话才走磁盘缓存 → 骨架）。
   * 这条也让「切走 → 切回」不再闪一下缓存版。
   */
  const painted = remembered ?? (cachedTimeline === null
    ? createTranscriptState()
    : { items: cachedTimeline.items, cursor: -1, transient: 0 })
  session.transcripts.set(id, painted)
  trimTranscripts(session)
  session.transcript = painted
  session.hasMore = false
  // 会话内控制（W2）跟着切会话：投影 / 提问 / 队列都是「当前会话」的
  selectControlSession(id)
  /*
   * [R9 红点] **进入会话即清零**：列表上那条红点说的是「有东西等你点」，
   * 人都进来了，卡片就在时间线里，红点没有意义。
   * 注意这不等于「装作处理完」：真没应答的话卡片仍然在时间线里可点；
   * 而且 `pendingInteractionCounts` 本来就不计活动会话，所以不会立刻又亮回来。
   */
  clearPendingInteractions({ sessionId: id })
  /*
   * —— S3 live —— 打开会话时先按**全局运行态**把「生成中」摆正：
   * 打开一个已经在跑的会话时，`turn/start` 早就过去了，follow 首帧不会再有它，
   * 只看 follow 增量的话 `streaming` 永远是 false —— 用户反馈的「发送按钮不变停止」
   * 就是这一行没做的事。真实值随后由 `session/control` 投影与 `$events` 继续校正。
   */
  const liveRunning = liveRunningOf(id)
  // 「缓存直出」只在**确实用磁盘缓存画的**那一屏才算（内存里那份不算缓存）
  const fromCache = remembered === undefined && cachedTimeline !== null
  useRemoteStore.setState({
    activeSessionId: id,
    items: painted.items,
    streaming: liveRunning,
    pendingApprovals: [],
    error: null,
    cacheStatus: {
      ...useRemoteStore.getState().cacheStatus,
      timelineFromCache: fromCache,
      timelineLoading: remembered === undefined && cachedTimeline === null,
      timelineSettled: false,
      timelineFailed: false,
    },
  })
  setPaging(false, false)

  const ready = deferred<void>()
  let applied = false
  let closed = false
  /*
   * [S4] 这三条 sink 全都闭包着 `session`（**共享可变对象**）和 `id`（开流那一刻的会话）。
   * 切走之后 `session.transcript` 已经是别人的了，所以**每次落到 transcript 之前**
   * 都要用 `ticket` 验一遍：这是不是还是「我服务的那条流」。不验就是串台。
   */
  const sink: StreamSink = {
    onValue: (value) => {
      if (!flowIsCurrent(session, ticket)) {
        // 孤儿帧：这条流早该在切走时关掉了，还推说明上一代没被正确解绑 —— 丢弃
        noteSessionDrop('staleFlow')
        return
      }
      /*
       * 读**自己那一份** transcript（Dart：`ChatTranscript` 是 controller 的字段，
       * `apply()` 只动 `this`，永远不会去读别人的）。这里用登记的格子兜一层：
       * 就算 `session.transcript` 因为别的路径被换过，归约基线也不会变成别人的内容。
       */
      const current = session.transcripts.get(id) ?? session.transcript
      if (!applied) {
        const snapshot = parseSnapshot(value)
        if (snapshot === null) {
          ready.reject(new RemoteApiError('INVALID_MESSAGE', '远端没有先给 session/follow 快照（协议要求首帧必须是 snapshot）'))
          return
        }
        if (snapshot.sessionId !== undefined && snapshot.sessionId !== id) {
          ready.reject(new RemoteApiError('INVALID_MESSAGE', '收到其他会话的快照，请重试加载'))
          return
        }
        // R8：快照是权威窗口，但**不丢**本地已经画出来的东西 —— 同 id 服务端覆盖、
        // 乐观行按 requestRpcId 对齐、更早的历史页留在头部（`cache.mergeTimelineItems`）。
        /*
         * 权限预设：快照里的 `projections` 是权威种子（dsh-Go 的 `SessionProjections.permissionPreset`
         * 同一个来源）。老 Host 的 `session/control` 流可能根本打不开，只有这一份 ——
         * 不在这里收，界面就永远显示「默认」，与实际用的不一致。
         */
        noteSnapshotProjections(id, snapshot.projections)
        const followedPreset = permissionPresetOfFollowItem(value)
        if (followedPreset !== undefined) noteSessionPermissionPreset(id, followedPreset)
        const fresh = reduceSnapshot(snapshot, id)
        const retainEarlier = snapshot.hasMore && remembered !== undefined && remembered.cursor >= 0 &&
          remembered.cursor <= fresh.cursor
        const merged = mergeTimelineItems(current.items, fresh.items, retainEarlier)
        const previousAnchor = retainEarlier ? remembered.historyBeforeSeq : undefined
        const keepAnchor = previousAnchor !== undefined &&
          (fresh.historyBeforeSeq === undefined || previousAnchor <= fresh.historyBeforeSeq)
        const next = {
          ...fresh,
          items: reconcileQueuedPrompts(merged, id, snapshot.projections),
          ...(keepAnchor ? { historyBeforeSeq: previousAnchor, hasMoreHistory: remembered?.hasMoreHistory ?? snapshot.hasMore } : {}),
        }
        session.hasMore = next.hasMoreHistory === true
        applied = true
        // 只往 `id` 这个会话的格子里写（+ 它是活动会话时才推给屏幕）
        commitTranscript(session, id, next)
        setPaging(session.hasMore, false)
        patchTimelineStatus(id, { timelineFromCache: false, timelineLoading: false, timelineSettled: true })
        if (next.items.length === 0) persistTimelineNow(session, id, true)
        else scheduleTimelinePersist(session, id)
        ready.resolve()
        return
      }
      const next = reduceFollowItem(current, value, id)
      const running = runningForFollowItem(value)
      if (running !== undefined) useRemoteStore.setState({ streaming: running })
      // 会话进行中改权限只有一条 `permission/preset` 事件：跟上它，界面的胶囊才不会停在旧值
      const preset = permissionPresetOfFollowItem(value)
      if (preset !== undefined) noteSessionPermissionPreset(id, preset)
      commitTranscript(session, id, next)
      scheduleTimelinePersist(session, id)
    },
    onClosed: (reason, failure) => {
      closed = true
      /*
       * 只有**自己还是当前那条流**时才能动共享槽位：`session.follow` 可能已经被
       * 新一代的 openSessionFlow 换成了别人的句柄，这里清掉等于把新流「弄丢」。
       */
      if (!flowIsCurrent(session, ticket)) {
        noteSessionDrop('staleFlow')
        if (!applied) ready.reject(new RemoteApiError(failure?.code ?? 'STREAM_CLOSED', '会话流在快照之前就关闭了'))
        return
      }
      session.follow = null
      useRemoteStore.setState({ streaming: false })
      if (!applied) {
        // 首次拉取到此为止（失败也算「结束了」）：别再挂着骨架，也别谎报「没有消息」
        patchTimelineStatus(id, { timelineLoading: false, timelineSettled: true, timelineFailed: true })
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
    /*
     * [S4] 关键的一行：`await openFollow` 期间用户可能已经切走了。这时**绝不能**
     * `session.follow = handle` —— 那会把新一代的句柄顶掉，而自己这条流从此没人关，
     * 变成一条永久推帧的孤儿流（串台的源头）。自己开的流自己关。
     */
    if (!flowIsCurrent(session, ticket)) {
      noteSessionDrop('staleFlow')
      await closeStreamQuietly(session, handle)
      return
    }
    // 同上：缓冲帧里可能已经带了 `closed`，别把死句柄存回去。
    session.follow = closed ? null : handle
    await withTimeout(ready.promise, SNAPSHOT_TIMEOUT_MS, 'RPC_TIMEOUT', '等待会话快照超时')
  } catch (error) {
    // 只有自己仍是当前流才收尾共享槽位；否则关自己那份句柄就够了
    if (flowIsCurrent(session, ticket)) {
      await closeStreamQuietly(session, session.follow)
      session.follow = null
      patchTimelineStatus(id, { timelineLoading: false, timelineSettled: true, timelineFailed: true })
      fail(error)
      return
    }
    noteSessionDrop('staleFlow')
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
  /*
   * [S4] 翻页也领工牌（Dart `_checkHistoryOwner(epoch)`）：这次 `history` RPC 回来时，
   * 必须还是**同一个会话、同一条 follow**，否则这一页属于上一条会话，不能落到当前时间线。
   * 注意这里**不能** `newFlowTicket()` —— 那是「开新流」，会把当前 follow 的工牌顶掉。
   */
  const ticket = currentFlowTicket(id)
  const beforeSeq = session.transcript.historyBeforeSeq
  // 空快照没有可用于请求更早事件的锚点。
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
    /*
     * [S4] `pageHistory` 回来时会话可能已经换了。dsh-Go 在同一位置的做法是
     * `_checkHistoryOwner(epoch)`（`session_api.dart:1325`）：本次翻页领的 epoch
     * 必须还是当前那条 follow 的，否则这次结果整份作废。
     */
    if (active !== session || !historyOwnerIsCurrent(ticket, epochCursor(session))) {
      noteSessionDrop('staleAction')
      return
    }
    const entries = historyEntriesFromRecords(page.records).filter(({ event }) => event.seq < beforeSeq)
    const nextAnchor = oldestSeq(entries)
    session.hasMore = page.hasMore && nextAnchor !== undefined
    const older = foldHistory(entries, id, false)
    const transcript = session.transcript
    commitTranscript(session, id, {
      ...transcript,
      historyBeforeSeq: nextAnchor ?? beforeSeq,
      hasMoreHistory: session.hasMore,
      items: older.length > 0 ? prependHistory(older, transcript.items) : transcript.items,
    })
    if (older.length > 0) scheduleTimelinePersist(session, id)
  } catch (error) {
    if (active === session && historyOwnerIsCurrent(ticket, epochCursor(session))) fail(error)
  } finally {
    if (active === session && historyOwnerIsCurrent(ticket, epochCursor(session))) {
      setPaging(session.hasMore, false)
    }
  }
}

const reconcileQueuedPrompts = (items: ChatItem[], sessionId: string, projections?: unknown): ChatItem[] => {
  const pending = items.filter((item) => item.kind === 'message' && item.pendingPrompt !== undefined)
  if (pending.length === 0) return items
  const queue = queuedPromptIds(sessionId, projections)
  let next = items
  for (const item of pending) {
    if (item.kind === 'message' && item.sessionId === sessionId &&
        item.requestRpcId !== undefined && queue.has(item.requestRpcId)) {
      next = clearSendState(next, item.requestRpcId)
    }
  }
  return next
}

const deliveryOutcomeUnknown = (error: unknown): boolean => {
  const code = errorCodeOf(error)
  if (code === LinkErrorCodes.RPC_TIMEOUT) return true
  if (isRemoteApiError(error) || (isRemoteLinkError(error) && error.fromHost)) return false
  return code !== LinkErrorCodes.RATE_LIMITED && code !== LinkErrorCodes.FRAME_TOO_LARGE
}

const sendFlow = async (
  text: string,
  attachments: readonly RemotePromptAttachment[] = [],
  mode?: RemotePromptMode,
  owner?: { target: RemoteCallTarget; sessionId: string },
  retryId?: string,
): Promise<boolean> => {
  let session: ActiveSession
  try {
    session = requireSession()
  } catch (error) {
    fail(error)
    return false
  }
  const id = session.sessionId
  if (owner !== undefined && (owner.target !== session.link || owner.sessionId !== id ||
    useRemoteStore.getState().activeSessionId !== id)) {
    return false
  }
  if (id === null) {
    fail(new RemoteApiError('SESSION_NOT_OPEN', '先选一个会话再发消息'))
    return false
  }
  const retryItem = retryId === undefined ? undefined : session.transcript.items.find((item) =>
    item.kind === 'message' && item.sessionId === id && item.id === `local:${retryId}` &&
    item.sendState === 'unconfirmed' && item.pendingPrompt !== undefined,
  )
  if (retryId !== undefined && (retryItem?.kind !== 'message' || retryItem.pendingPrompt === undefined)) return false
  const promptText = retryItem?.kind === 'message' ? retryItem.text : text
  const prompt = retryItem?.kind === 'message' && retryItem.pendingPrompt !== undefined
    ? retryItem.pendingPrompt : { attachments, mode: mode ?? 'queue' as const }
  if (!hasVisibleMessageText(promptText) && prompt.attachments.length === 0) {
    fail(new RemoteApiError('INVALID_ARGUMENT', '消息不能为空'))
    return false
  }

  // 乐观上屏：requestId 同时是 `session/prompt` 的幂等键与 Host 回显的 `source.rpcId`，
  // `addUserMessage()` 靠它把这条本地行替换成权威行。
  const requestId = retryId ?? newRequestId()
  // [S4] 乐观行落进 `id` 自己的格子（Dart：`_pending` 是 ChatController 的字段，天然属于该会话）
  commitTranscript(session, id, {
    ...session.transcript,
    items: retryId === undefined
      ? addOptimisticUserMessage(session.transcript.items, id, promptText, requestId, prompt)
      : markSendState(session.transcript.items, requestId, 'queued'),
  })
  useRemoteStore.setState({ streaming: true, error: null })
  persistTimelineNow(session, id)

  try {
    await sendPrompt(session.link, id, promptText, prompt.attachments, {
      requestId,
      mode: prompt.mode,
    })
    /*
     * [S4] Host 已受理，但**此刻的活动会话可能已经不是 id 了**（用户发完就切走）。
     * 乐观行属于 `id`，回写也必须只回 `id`：否则 `clearSendState` 会跑在别人的
     * transcript 上，运气不好还会把 B 的内容当成 A 的写进缓存。
     *
     * 为什么这里比 sessionId 而不是比代际：A→B→A 切回来时，这条乐观行确实还是 A 的，
     * 落回 A 是对的（代际只用来挡「开流」这种抢共享槽位的动作）。
     */
    // Host 已受理：清掉「发送中」挂起标记。steer/插话不一定回显这条消息，
    // 不清的话它会永远停在发送中（真机反馈的 bug）。
    const transcript = session.transcripts.get(id)
    if (active === session && transcript !== undefined) {
      commitTranscript(session, id, { ...transcript, items: clearSendState(transcript.items, requestId) })
      persistTimelineNow(session, id)
    }
    return true
  } catch (error) {
    const unknown = retryId !== undefined || deliveryOutcomeUnknown(error)
    const info = describeRemoteError(error)
    const transcript = session.transcripts.get(id)
    if (active === session && transcript !== undefined) {
      const accepted = transcript.items.some((item) => item.kind === 'message' && item.sessionId === id &&
        item.requestRpcId === requestId && (item.id !== `local:${requestId}` || item.sendState === undefined))
      if (accepted) return true
      const queued = queuedPromptIds(id).has(requestId)
      commitTranscript(session, id, {
        ...transcript,
        items: queued ? clearSendState(transcript.items, requestId)
          : markSendState(transcript.items, requestId, unknown ? 'unconfirmed' : 'failed', info.text),
      })
      persistTimelineNow(session, id)
      if (belongsToSession(session.sessionId, id)) {
        useRemoteStore.setState({ streaming: liveRunningOf(id) })
        if (!unknown && !queued) fail(error)
      }
      if (queued) return true
    }
    // The caller consumes the composer. Retrying from the bubble keeps the original request ID.
    return unknown
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
  const id = session.sessionId
  if (id === null) return
  try {
    await cancelSession(session.link, id)
    // `accepted:true` 只代表已受理，真正的终态是 `turn/end.reason.kind = aborted`；
    // 所以这里**不**急着把 streaming 关掉（那会让人以为已经停了）。
  } catch (error) {
    if (active === session && belongsToSession(session.sessionId, id)) fail(error)
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
  /*
   * [S4] 应答属于**点下去那一刻的会话**。`respondApprovalApi` 回来时用户可能已经切走，
   * 这时把卡片落定到活动 transcript 就是改别人的审批卡。
   */
  const owner = session.sessionId
  if (owner === null) {
    fail(new RemoteApiError('SESSION_NOT_OPEN', '先选一个会话再应答审批'))
    return
  }
  try {
    await respondApprovalApi(session.link, { clientId: session.eventClientId, eventId, decision })
    if (active !== session) return
    if (!belongsToSession(session.sessionId, owner)) {
      noteSessionDrop('staleAction')
      clearPendingInteractions({ eventId })
      return
    }
    // 本地先落定，不必等 Host 回投（官方客户端也是这么做的）。
    commitTranscript(session, owner, {
      ...session.transcript,
      items: resolveApprovalItem(
        session.transcript.items,
        eventId,
        decision === 'allow_once' ? 'allowed-once' : 'rejected',
      ),
    })
    // [R9 红点] 本机应答完 = 这条不再「等你点」了
    clearPendingInteractions({ eventId })
  } catch (error) {
    if (active !== session) return
    if (belongsToSession(session.sessionId, owner)) fail(error)
    const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : ''
    // 句柄已失效：把卡片标成 unavailable（继续显示 pending 只会让人反复点）。
    if (code === 'PERMISSION_NOT_PENDING' || code === 'AGENT_BUSY') {
      /*
       * 只在**还没结论**的时候降级。双击/重连后的第二次提交会拿到
       * `PERMISSION_NOT_PENDING`，但那一条其实已经 allowed-once 了 ——
       * 再把它改成「已失效」会把一次成功的允许显示成失败（真实发生过）。
       */
      if (!belongsToSession(session.sessionId, owner)) {
        noteSessionDrop('staleAction')
        clearPendingInteractions({ eventId })
        return
      }
      if (shouldExpireApproval(session.transcript.items, eventId)) {
        commitTranscript(session, owner, {
          ...session.transcript,
          items: resolveApprovalItem(session.transcript.items, eventId, 'unavailable'),
        })
      }
      clearPendingInteractions({ eventId })
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * 四、单例 store
 * ──────────────────────────────────────────────────────────────────────── */

export const useRemoteStore = create<RemoteState>(() => ({
  ...INITIAL_STATE,
  // 启动时同步读一次盘（一次 localStorage 读取，微秒级）：远程页/设置页在自动恢复跑完之前
  // 就能显示「上次连的是哪台」，而不是先闪一下「未连接」。
  lastSession: readLastSession(),

  connect: async (serverUrl: string, email: string, password: string): Promise<void> => {
    await connectFlow(serverUrl, email, password)
  },
  connectSsh: connectSshFlow,

  disconnect: (): void => {
    teardownConnection()
    // 本次进程内不再自动恢复：用户是**主动**断开的，别过几秒又自己连回去
    autoConnectSettled = true
    // 临时断开：`dsp.remote.last-session.v1` **保留**（下次启动照常自动连回来）。
    // 复位界面时把它读回来，设置页才能显示「上次连接的账号 + 重新连接」。
    useRemoteStore.setState({ ...INITIAL_STATE, lastSession: readLastSession() })
  },

  signOut: (): void => {
    teardownConnection()
    const session = readLastSession()
    // 退出登录 = 不留凭据：删掉那条账号（设备 token pair 就在里面），再清 last-session
    if (session !== null) removeAccount(session.serverUrl, session.email)
    clearLastSession()
    autoConnectSettled = true
    useRemoteStore.setState({ ...INITIAL_STATE, lastSession: null })
  },

  autoConnectNow: async (): Promise<void> => {
    await autoConnectFlow(false)
  },

  retryAutoConnect: async (): Promise<void> => {
    await retryAutoConnectFlow()
  },

  reconnectNow: async (): Promise<void> => {
    if (sshReconnectInput) {
      const id = active?.sessionId
      await connectSshFlow(sshReconnectInput, id ?? sshRestoreId)
      return
    }
    await reconnectNowFlow()
  },

  refreshSessions: async (): Promise<void> => {
    await refreshSessionsFlow()
  },

  switchHost: async (hostDeviceId: string): Promise<void> => {
    await switchHostFlow(hostDeviceId)
  },

  refreshHosts: async (): Promise<void> => {
    await refreshHostsFlow()
  },

  dismissHostSwitch: (): void => {
    if (useRemoteStore.getState().hostSwitch.status === 'idle') return
    useRemoteStore.setState({ hostSwitch: { status: 'idle' } })
  },

  hydrateCachedSessions: (): void => {
    const state = useRemoteStore.getState()
    // 已经有实时列表 / 已经合并过服务端数据：缓存没有意义了，别拿旧的盖新的
    if (state.sessions.length > 0 || state.cacheStatus.sessionsSynced) return
    const bucket = cacheBucketNow()
    if (bucket === null) return
    const cached = readSessionsCache({ ...bucket, now: Date.now() })
    if (cached === null) return
    // 读盘期间可能已经有列表了（自动恢复很快）：再查一次
    const latest = useRemoteStore.getState()
    if (latest.sessions.length > 0 || latest.cacheStatus.sessionsSynced) return
    useRemoteStore.setState({
      sessions: cached.sessions,
      cacheStatus: {
        ...latest.cacheStatus,
        sessionsFromCache: true,
        sessionsStale: cached.stale,
        // 上一次跑就标过「已不存在」的行，这一屏也照样标着（下次合并时才真的清掉）
        ghostSessionIds: cached.sessions.filter(row => row.missingAt !== undefined).map(row => row.id),
      },
    })
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

  sendWithMode: async (text: string, mode: RemotePromptMode): Promise<void> => {
    await sendFlow(text, [], mode)
  },
  sendToSession: (target, sessionId, text, attachments, mode) =>
    sendFlow(text, attachments, mode, { target, sessionId }),
  retryPrompt: (target, sessionId, requestId) =>
    sendFlow('', [], undefined, { target, sessionId }, requestId),

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

/**
 * 诊断用：会话路由的丢弃计数（S4）。
 *
 * 真机排查「消息串会话」时先看这里：正常使用应该**恒为 0**。
 *   - `staleFlow` 涨：切会话太频繁，旧 follow 流的帧被挡下来了（说明修复在生效）；
 *   - `staleAction` 涨：发送 / 翻页 / 审批的异步结果回来时会话已经换了；
 *   - `cache` 涨：有内容想写进不属于它的缓存桶（被挡住）；
 *   - `frame` 涨：`$events` 帧到达时光没有活动会话（切会话的中间态）。
 *
 * 等价入口：`__dsDebug.sessionDrops`（同一个计数器；默认不打日志）。
 */
export const remoteSessionDrops = sessionDropSnapshot

// 模块加载即把 `__dsDebug.sessionDrops` 准备好：真机上不必先进过任何分支就能看
ensureSessionDebug()

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

/** 诊断用：自动恢复的状态 + 掉线自愈的进度 + 盘上那条 last-session（**不含 token**）。 */
export const describeRemoteRecovery = (): string => {
  const { autoConnect, reconnect } = useRemoteStore.getState()
  const tail = autoConnect.code === undefined ? '' : `|${autoConnect.code}`
  const healing =
    reconnect.status === 'idle'
      ? ''
      : `|${reconnect.status}:${reconnect.attempt}/${reconnect.maxAttempts}${reconnect.code === undefined ? '' : `:${reconnect.code}`}`
  return `${autoConnect.state}${tail}${healing}|${describeLastSession(readLastSession())}`
}

/** 上次连接的记录与自动恢复状态：UI 想直接 import 类型时走这里，不用碰 `autoConnect.ts`。 */
export type { LastSession } from './autoConnect.js'
export { readLastSession } from './autoConnect.js'

/* ────────────────────────────────────────────────────────────────────────
 * 六、通知中心（R6）：把「哪些会话在跑 / 在调什么工具」推给原生通知
 *
 * 原生契约见 `notify.ts` 头部（`/__ds_notify/{work,clear,state.json}`，实现是
 * `android/…/RemoteNotifyHandler.java`）。这里只做**状态翻译**与生命周期管理：
 *
 * | 证据 | state | tool | detail |
 * |---|---|---|---|
 * | 活动会话 `pendingApprovals` 非空 / 别的会话收到 `approval/request` | `approval` | 工具名 | 等待你确认 <工具名> |
 * | `streaming` 或时间线里有 `tool.state==='running'` | `running` | 最近工具名 + 短文件提示 | 正在调用 <工具名> |
 * | 这一轮刚结束（看过 running→停）且 `turnEnd.reason==='failed'` | `error` | — | 这一轮失败了 |
 * | 同上、不是 failed（completed / stopped） | `done` | — | 这一轮已完成（30s 后自动清） |
 *
 * 多会话口径（lead 拍板的方案 B）：
 *   - `items` = 当前活动会话 + 其他 `running` / 待审批会话，**上限 24 条**（原生 `MAX_ITEMS`）；
 *   - 排序：`approval` 最前，其余按最近活动时间倒序；
 *   - 原生把这些 running 条目合并成**一条**汇总通知（最多 3 行 + 「等 N 个任务」），
 *     所以通知栏永远不会被 20 个会话撑爆；
 *   - 全部结束 → 清整组；单个结束而还有别的在跑 → 只更新 items，不清组。
 *
 * 纪律：这一节只**读**既有状态，不改任何既有分支 —— 唯一一处插入是
 * `openEventsStream()` 的 `onValue` 里一行 `noteRemoteNotifyItem(value)`（只写本节私有记账）。
 * ──────────────────────────────────────────────────────────────────────── */

/** `done` 通知挂多久后自动清掉（任务书：30s）。到期还必须从后续快照里摘掉，否则原生会按同 id 画回来 */
export const NOTIFY_DONE_TTL_MS = 30_000
/** 状态合并窗口：把一轮 setState 攒成一拍（`notify.ts` 自己还有 250ms 合并窗口） */
const NOTIFY_SYNC_COALESCE_MS = 120
/** 探测失败（原生端点没打通）后的冷却：别每次状态变化都打一次 GET */
const NOTIFY_PROBE_RETRY_MS = 5_000
/** 会话没有标题时的兜底（原生对空标题也会给「会话」） */
const NOTIFY_UNTITLED = '(未命名会话)'
/** 工具名后面那个「短文件提示」的上限（原生 tool 字段总共 40 字符，得给工具名留位置） */
const NOTIFY_TOOL_HINT_MAX = 20

/* ── 6.1 其他会话的信号（`$events` 的 status / approval waterfall） ───────── */

interface NotifyApprovalSignal {
  eventId: string
  tool: string
  ts: number
}

interface NotifySessionSignal {
  running: boolean
  approval: NotifyApprovalSignal | null
}

/**
 * 会话 id → 「它现在在跑 / 在等审批」。
 *
 * **只服务通知**，不进 `RemoteSessionSummary`（契约不动）：`api-session/status` 只有
 * 一个 running 布尔值，`api-session/activity` 只有时间戳 —— 别的会话调了什么工具，
 * Host 根本没转发，所以别的会话的通知行只显示「标题 · 进行中」。
 */
const notifySignals = new Map<string, NotifySessionSignal>()

const notifySignalOf = (sessionId: string): NotifySessionSignal => {
  const existing = notifySignals.get(sessionId)
  if (existing !== undefined) return existing
  const created: NotifySessionSignal = { running: false, approval: null }
  notifySignals.set(sessionId, created)
  return created
}

const notifyRecordOf = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null

/**
 * `$events` 的每一条 item 都过这里（只读）：
 *   - `api-session/status`     → 别的会话「在跑 / 停了」（停了 = 这一轮结束，弹一条 done）；
 *   - `api-session/removed`    → 删掉记账 + 清这个会话的通知；
 *   - `approval/request`       → 任意会话的待审批（活动会话另有 `pendingApprovals`，以时间线为准）；
 *   - `{type:'cancel'}`        → 审批被撤回，摘掉。
 *
 * 异常一律吞掉：通知逻辑不许打断 `$events` 的分发。
 */
export const noteRemoteNotifyItem = (value: unknown): void => {
  try {
    const forwarded = forwardedSessionEvent(value)
    if (forwarded !== undefined) {
      applyNotifySignal(forwarded)
      scheduleRemoteNotifySync()
      return
    }
    if (applyNotifyApproval(value)) scheduleRemoteNotifySync()
  } catch {
    // 静默：通知只是锦上添花
  }
}

const applyNotifySignal = (event: ForwardedSessionEvent): void => {
  if (event.kind === 'status') {
    const signal = notifySignalOf(event.sessionId)
    const wasRunning = signal.running
    signal.running = event.running
    if (!event.running) signal.approval = null
    if (wasRunning && !event.running && event.sessionId !== useRemoteStore.getState().activeSessionId) {
      // 别的会话跑完了：只知道「结束了」不知道成没成 —— 按 done 弹一条（30s 后自动清）
      armNotifyFinished({
        sessionId: event.sessionId,
        title: notifyTitleOf(useRemoteStore.getState().sessions, event.sessionId),
        state: 'done',
        detail: '这一轮已完成',
        ts: Date.now(),
      })
    }
    return
  }
  if (event.kind === 'removed') {
    notifySignals.delete(event.sessionId)
    dropNotifyFinished(event.sessionId)
    clearNotifySession(event.sessionId)
  }
}

const applyNotifyApproval = (value: unknown): boolean => {
  const record = notifyRecordOf(value)
  if (record === null || typeof record.type !== 'string') return false
  if (record.type === 'cancel' && typeof record.eventId === 'string') {
    let changed = false
    for (const signal of notifySignals.values()) {
      if (signal.approval !== null && signal.approval.eventId === record.eventId) {
        signal.approval = null
        changed = true
      }
    }
    return changed
  }
  if (record.type !== 'waterfall' || record.event !== 'approval/request') return false
  const eventId = typeof record.eventId === 'string' ? record.eventId : ''
  const agentId = typeof record.agentId === 'string' ? record.agentId : ''
  if (eventId.length === 0 || agentId.length === 0) return false
  const request = notifyRecordOf(record.request)
  const tool = request !== null && typeof request.toolName === 'string' ? request.toolName.trim() : ''
  // 活动会话的审批以时间线为准（`buildNotifySnapshot` 会用 `pendingApprovals` 覆盖它）；
  // 这条记下来是为了「切走以后」仍然留在快照里（原生按对账撤通知，漏掉就会被误撤）
  notifySignalOf(agentId).approval = { eventId, tool, ts: Date.now() }
  return true
}

/* ── 6.2 时间线 → 一条通知条目（纯函数；自测直接覆盖这张映射表） ─────────── */

export interface NotifyActiveInput {
  sessionId: string
  title: string
  items: readonly ChatItem[]
  streaming: boolean
  pendingApprovals: readonly { eventId: string; title: string; detail?: string }[]
  /** 上一次给这个会话推过的状态：`done` / `error` 只在真的「跑过一轮」之后才发 */
  previous?: WorkState | null
}

/** 从后往前找最后一条满足条件的行（时间线是追加的，最近的在尾巴上） */
const notifyLatestItem = (items: readonly ChatItem[], match: (item: ChatItem) => boolean): ChatItem | undefined => {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item !== undefined && match(item)) return item
  }
  return undefined
}

/**
 * 工具条目的展示名 + 一个**安全的**短提示（只认文件名，不认命令行）。
 *
 * `summary` 是 Host 给的调用描述（`view.description` / `view.cwd` / `data.summary`），可能是
 * 命令行全文、绝对路径或一句人话。这里只接受**路径样式**的值并取其文件名，其余一律丢掉：
 * 通知栏（尤其锁屏）不适合放命令原文，长度也扛不住。
 */
const notifyToolLabel = (item: ChatItem): string => {
  if (item.kind !== 'tool') return ''
  const name = item.toolName.trim()
  const summary = item.summary?.trim() ?? ''
  const firstLine = summary.split(/[\r\n]/u)[0]?.trim() ?? ''
  const pathLike = firstLine.length > 0 && (/[/\\]/u.test(firstLine) || /^[\w.-]+\.\w{1,8}$/u.test(firstLine))
  const base = pathLike ? (firstLine.split(/[/\\]/u).filter(part => part.length > 0).at(-1) ?? '') : ''
  const hint = base.length > NOTIFY_TOOL_HINT_MAX ? base.slice(0, NOTIFY_TOOL_HINT_MAX) : base
  if (name.length === 0) return hint
  return hint.length === 0 ? name : `${name} ${hint}`
}

export const deriveNotifyItem = (input: NotifyActiveInput): WorkItem | null => {
  const { sessionId, title } = input
  const approval = input.pendingApprovals[0]
  if (approval !== undefined) {
    const row = notifyLatestItem(input.items, item => item.kind === 'approval' && item.approvalId === approval.eventId)
    const toolName = row !== undefined && row.kind === 'approval' ? row.toolName.trim() : approval.title.trim()
    const tool = toolName.length > 0 ? toolName : ''
    return {
      sessionId,
      title,
      state: 'approval',
      ...(tool.length === 0 ? {} : { tool }),
      detail: tool.length === 0 ? '有一个操作需要你确认' : `等待你确认 ${tool}`,
      ts: row?.createdAt ?? input.items[0]?.createdAt ?? Date.now(),
    }
  }
  const runningTool = notifyLatestItem(input.items, item => item.kind === 'tool' && item.state === 'running')
  const lastTool = notifyLatestItem(input.items, item => item.kind === 'tool')
  if (input.streaming || runningTool !== undefined) {
    const toolItem = runningTool ?? lastTool
    const tool = toolItem === undefined ? '' : notifyToolLabel(toolItem)
    return {
      sessionId,
      title,
      state: 'running',
      ...(tool.length === 0 ? {} : { tool }),
      detail: tool.length === 0 ? '正在回复…' : `正在调用 ${tool}`,
      ts: (toolItem ?? notifyLatestItem(input.items, () => true))?.createdAt ?? Date.now(),
    }
  }
  const ended = notifyLatestItem(input.items, item => item.turnEnd !== undefined)
  if (ended === undefined || ended.turnEnd === undefined) return null
  // 只有真的看过 running 才发结束：否则「打开一个有历史的会话」会平白弹一条完成通知
  if (input.previous !== 'running' && input.previous !== 'approval') return null
  const failed = ended.turnEnd.reason === 'failed'
  return {
    sessionId,
    title,
    state: failed ? 'error' : 'done',
    detail: failed ? '这一轮失败了' : '这一轮已完成',
    ts: ended.turnEnd.time,
  }
}

/* ── 6.3 快照拼装（纯函数；排序 / 上限 / activeSessionId 都在这里） ───────── */

export interface NotifyOtherSession {
  sessionId: string
  title: string
  running: boolean
  /** 待审批的工具名（只有别的会话走这里；活动会话用时间线） */
  approvalTool?: string
  /**
   * —— S3 live —— 待审批**条数**：来自全局运行态的记账（`liveSessions.ts`）。
   *
   * 为什么需要它：`approvalTool` 只有「走 `$events` waterfall 并且拿到 toolName」时才有，
   * 而重连后 Host 只重投 pending 的**那一类**信号不一定带工具名 —— 只知道「有几条在等你」
   * 也远好过整个会话从通知栏里消失。
   */
  approvalCount?: number
  approvalTs?: number
  /** —— S3 live —— 正在调用的工具展示名（只有当前打开的会话才有；别的会话 Host 不转发） */
  tool?: string
  /** 最近活动时间（排序用） */
  updatedAt: number
}

export interface NotifySnapshotInput {
  activeSessionId: string | null
  /** 活动会话当前的状态条目；`null` = 没在跑也没待审批 */
  active: WorkItem | null
  activeUpdatedAt: number
  others: readonly NotifyOtherSession[]
  /** 还挂在通知栏上的结束事件（done / error），生命周期由 6.5 维护 */
  finished: readonly WorkItem[]
}

/**
 * 拼一份原生认的快照。
 *
 * 排序 = 审批最前（按时间倒序）+ 其余按最近活动时间倒序；`activeSessionId` 决定点汇总通知
 * 落到哪个会话。超过 `NOTIFY_MAX_ITEMS` 截断（原生自己也只认 24 条）。
 */
export const assembleNotifySnapshot = (input: NotifySnapshotInput): WorkPush | null => {
  const approvals: { item: WorkItem; at: number }[] = []
  const rest: { item: WorkItem; at: number }[] = []
  if (input.active !== null) {
    if (input.active.state === 'approval') approvals.push({ item: input.active, at: input.active.ts })
    else rest.push({ item: input.active, at: input.activeUpdatedAt })
  }
  for (const other of input.others) {
    // [S3] 待审批：有工具名就说工具名，只知道条数也得把它说出来
    const approvalCount = other.approvalCount ?? (other.approvalTool !== undefined && other.approvalTool.length > 0 ? 1 : 0)
    if (approvalCount > 0) {
      const tool = other.approvalTool?.trim() ?? ''
      approvals.push({
        item: {
          sessionId: other.sessionId,
          title: other.title,
          state: 'approval',
          ...(tool.length === 0 ? {} : { tool }),
          detail: tool.length === 0 ? '有一个操作需要你确认' : `等待你确认 ${tool}`,
          ts: other.approvalTs ?? other.updatedAt,
        },
        at: other.approvalTs ?? other.updatedAt,
      })
      continue
    }
    if (!other.running) continue
    const tool = other.tool?.trim() ?? ''
    rest.push({
      // 映射本身在 `notify.ts`（`deriveOtherWorkItem`）：这条的**来源**是全局运行态，
      // 不是时间线，所以映射规则放在通知层而不是数据层。
      item: deriveOtherWorkItem({
        sessionId: other.sessionId,
        title: other.title,
        ...(tool.length === 0 ? {} : { tool }),
        ts: other.updatedAt,
      }),
      at: other.updatedAt,
    })
  }
  for (const item of input.finished) rest.push({ item, at: item.ts })
  approvals.sort((a, b) => b.at - a.at)
  rest.sort((a, b) => b.at - a.at)
  const items = [...approvals.map(entry => entry.item), ...rest.map(entry => entry.item)].slice(0, NOTIFY_MAX_ITEMS)
  if (items.length === 0) return null
  return { items, ...(input.activeSessionId === null ? {} : { activeSessionId: input.activeSessionId }) }
}

/* ── 6.4 小工具 ─────────────────────────────────────────────────────────── */

const notifyTitleOf = (sessions: readonly RemoteSessionSummary[], sessionId: string): string => {
  const title = sessions.find(item => item.id === sessionId)?.title.trim() ?? ''
  return title.length === 0 ? NOTIFY_UNTITLED : title
}

const notifyUpdatedAtOf = (sessions: readonly RemoteSessionSummary[], sessionId: string): number =>
  sessions.find(item => item.id === sessionId)?.updatedAt ?? 0

/* ── 6.5 结束事件（done / error）的生命周期 ─────────────────────────────── */

interface NotifyFinishedEntry {
  item: WorkItem
  timer: ReturnType<typeof setTimeout> | null
}

/**
 * 已经弹过、还挂在通知栏上的结束事件（sessionId → 条目）。
 *
 * 为什么要自己记账：原生按固定 id 画事件通知，**快照里再次出现同一条**会把它画回来。
 * 所以「30s 后清掉」必须同时做两件事：`clearWork(sessionId)` + 把它从后续快照里摘掉。
 */
const notifyFinished = new Map<string, NotifyFinishedEntry>()

/** 最近一次组好的快照：判断「还有没有进行中 / 待审批」，决定清单条还是清整组 */
let notifySnapshot: WorkPush | null = null

/** 清掉这个会话的通知（原生按固定 id 算，不依赖通知栏里现在有没有） */
const clearNotifySession = (sessionId: string): void => {
  // 这一轮还没推出去过任何东西：不用白打一次原生端点
  if (!notifyPosted || notifySupport === 'no') return
  void clearWork(sessionId)
}

const armNotifyFinished = (item: WorkItem): void => {
  const existing = notifyFinished.get(item.sessionId)
  if (existing !== undefined) {
    if (existing.item.state === item.state && existing.item.ts === item.ts) return
    if (existing.timer !== null) clearTimeout(existing.timer)
    notifyFinished.delete(item.sessionId)
  }
  const timer = item.state === 'done' ? setTimeout(() => { expireFinishedNotify(item.sessionId) }, NOTIFY_DONE_TTL_MS) : null
  notifyFinished.set(item.sessionId, { item, timer })
}

/** 摘掉结束条目；有的话顺手清掉原生那条（切走会话 / 重新开跑 / 会话被删时用） */
const dropNotifyFinished = (sessionId: string): void => {
  const existing = notifyFinished.get(sessionId)
  if (existing === undefined) return
  if (existing.timer !== null) clearTimeout(existing.timer)
  notifyFinished.delete(sessionId)
  clearNotifySession(sessionId)
}

/**
 * 结束通知的收尾（30s 定时器与自测都走这里）：从快照里摘掉 + 清掉原生那条。
 *
 * 如果别的会话还在跑/待审批，只清这个会话；全没了就清整组（任务书：全部结束后 clearWork()）。
 */
export const expireFinishedNotify = (sessionId: string): void => {
  const existing = notifyFinished.get(sessionId)
  if (existing === undefined) return
  if (existing.timer !== null) clearTimeout(existing.timer)
  notifyFinished.delete(sessionId)
  const running = notifySnapshot !== null && notifySnapshot.items.some(item => item.state === 'running' || item.state === 'approval')
  if (running || notifyFinished.size > 0) clearNotifySession(sessionId)
  else void clearWork()
  scheduleRemoteNotifySync()
}

/* ── 6.6 与 store 的桥：ready 才推、断开就清 ────────────────────────────── */

let notifyInstalled = false
/** 上一次给活动会话推过的状态（`done` / `error` 的「跑过一轮才算」靠它） */
let notifyPrevious: { sessionId: string; state: WorkState } | null = null
/** 原生能力：`no` 之后整块禁用（旧 APK 不会在运行中变新） */
let notifySupport: 'unknown' | 'yes' | 'no' = 'unknown'
let notifySupportProbe: Promise<boolean> | null = null
let notifySupportRetryAt = 0
let notifySyncTimer: ReturnType<typeof setTimeout> | null = null
/** 这一轮连接里是否真的推出去过东西（决定断开时要不要发 `/clear`） */
let notifyPosted = false

/**
 * 探一次原生能力（带冷却）。`unreachable`（这次没打通）不粘住，过 5s 还能再试；
 * 404 / HTML（旧 APK）粘住 `no`，之后一个请求都不发。
 */
const ensureNotifySupport = async (): Promise<boolean> => {
  if (notifySupport === 'yes') return true
  if (notifySupport === 'no') return false
  if (notifySupportProbe !== null) return notifySupportProbe
  if (Date.now() < notifySupportRetryAt) return false
  const probe = (async (): Promise<boolean> => {
    try {
      const capability = await probeNotify()
      if (capability.supported) {
        notifySupport = 'yes'
        return true
      }
      if (capability.reason === 'unreachable') {
        notifySupportRetryAt = Date.now() + NOTIFY_PROBE_RETRY_MS
        return false
      }
      notifySupport = 'no'
      return false
    } catch {
      notifySupportRetryAt = Date.now() + NOTIFY_PROBE_RETRY_MS
      return false
    } finally {
      notifySupportProbe = null
    }
  })()
  notifySupportProbe = probe
  return probe
}

export const scheduleRemoteNotifySync = (): void => {
  if (notifySyncTimer !== null) return
  notifySyncTimer = setTimeout(() => {
    notifySyncTimer = null
    void syncRemoteNotify()
  }, NOTIFY_SYNC_COALESCE_MS)
}

/**
 * [S3] `notifySignals`（R6 的记账）→ 交给快照的那一列。
 *
 * 它与全局运行态**同源冗余**：两边都吃 `api-session/status` / `approval/request`。
 * 区别只在初始条件 —— `notifySignals` 从「这一代连接收到的第一个 status」开始记账，
 * 所以「连上时它已经在跑」那种会话它永远不会知道；反过来它多带一个**工具名**
 * （waterfall 的 `request.toolName`），这正是运行态里没有的东西，于是两条都要保留。
 */
const signalsAsOthers = (
  activeSessionId: string | null,
  state: RemoteState,
): NotifyOtherSession[] => {
  const others: NotifyOtherSession[] = []
  for (const [sessionId, signal] of notifySignals) {
    if (sessionId === activeSessionId) continue
    if (!signal.running && signal.approval === null) continue
    others.push({
      sessionId,
      title: notifyTitleOf(state.sessions, sessionId),
      running: signal.running,
      ...(signal.approval === null ? {} : { approvalTool: signal.approval.tool, approvalTs: signal.approval.ts }),
      updatedAt: notifyUpdatedAtOf(state.sessions, sessionId),
    })
  }
  return others
}

const buildNotifySnapshot = (state: RemoteState, active: WorkItem | null): WorkPush | null => {
  const activeSessionId = state.activeSessionId
  /*
   * 活动会话的审批状态同步到信号表（而不是直接丢掉）：
   *   - 时间线里审批还在 → 信号也留着，**切走以后**这条待审批仍然在快照里（原生按「上次在、
   *     这次不在」对账，漏掉就会被当成已处理而撤掉通知）；
   *   - 时间线里没了（已处理 / 被撤回）→ 信号清掉，原生下一次对账自动撤通知。
   */
  if (activeSessionId !== null) {
    const signal = notifySignalOf(activeSessionId)
    if (active !== null && active.state === 'approval') {
      const approval = state.pendingApprovals[0]
      signal.approval = approval === undefined
        ? signal.approval
        : { eventId: approval.eventId, tool: active.tool ?? approval.title, ts: active.ts }
    } else {
      signal.approval = null
    }
  }
  const others: NotifyOtherSession[] = []
  /*
   * —— S3 live —— 别的会话 = **全局运行态** ∪ `notifySignals`（R6 的记账）。
   *
   * 为什么要有这条并集：`notifySignals` 只在「这一代连接里收到过 `api-session/status`」
   * 时才有条目，而用户反馈的正是「进 App 时它已经在跑」—— 那一轮 `status` 早发完了，
   * 于是通知里根本没有它。`liveSessions` 的初值来自 `session/list` 行的 `running`，
   * 所以「没打开过的运行中会话」这时才第一次出现在通知里。
   *
   * 两边都是**同源冗余**（都吃 `api-session/*` 与 waterfall），任一边漏了不会整体失效。
   * 合并规则（取 running 的或、审批取大值）在 `liveNotifyOthers()` 之外这里只做一次去重。
   */
  const liveOthers = liveNotifyOthers(useLiveSessions.getState(), {
    activeSessionId,
    titleOf: (sessionId) => notifyTitleOf(state.sessions, sessionId),
    updatedAtOf: (sessionId) => notifyUpdatedAtOf(state.sessions, sessionId),
  })
  const merged = new Map<string, NotifyOtherSession>()
  for (const other of [...liveOthers, ...signalsAsOthers(activeSessionId, state)]) {
    const existing = merged.get(other.sessionId)
    if (existing === undefined) {
      merged.set(other.sessionId, other)
      continue
    }
    // 两条来源都见过它：在跑的取「谁都说在跑」，审批取较大的条数
    merged.set(other.sessionId, {
      ...existing,
      // 工具名只有运行态那条有
      ...(existing.tool === undefined && other.tool !== undefined ? { tool: other.tool } : {}),
      ...(other.approvalTool === undefined ? {} : { approvalTool: other.approvalTool }),
      ...(other.approvalTs === undefined ? {} : { approvalTs: other.approvalTs }),
      running: existing.running || other.running,
      approvalCount: Math.max(existing.approvalCount ?? 0, other.approvalCount ?? 0),
      updatedAt: Math.max(existing.updatedAt, other.updatedAt),
    })
  }
  for (const other of merged.values()) others.push(other)
  const finished: WorkItem[] = []
  for (const entry of notifyFinished.values()) finished.push(entry.item)
  const activeItem = active !== null && (active.state === 'running' || active.state === 'approval') ? active : null
  return assembleNotifySnapshot({
    activeSessionId,
    active: activeItem,
    activeUpdatedAt: activeSessionId === null ? 0 : notifyUpdatedAtOf(state.sessions, activeSessionId),
    others,
    finished,
  })
}

/**
 * 组一帧并推给原生（**单飞**由 `scheduleRemoteNotifySync` 的 120ms 合并窗口 + `notify.ts`
 * 自己的 250ms 合并窗口共同保证）。任何异常都吞掉 —— 通知失败不许影响连接与聊天。
 */
export const syncRemoteNotify = async (): Promise<void> => {
  try {
    const state = useRemoteStore.getState()
    if (state.phase !== 'ready') return
    // 旧 APK 已经确认不支持：连状态翻译都不用做（也保证不产生任何请求）
    if (notifySupport === 'no') return
    const sessionId = state.activeSessionId
    const derived = sessionId === null ? null : deriveNotifyItem({
      sessionId,
      title: notifyTitleOf(state.sessions, sessionId),
      items: state.items,
      streaming: state.streaming,
      pendingApprovals: state.pendingApprovals,
      previous: notifyPrevious !== null && notifyPrevious.sessionId === sessionId ? notifyPrevious.state : null,
    })
    if (derived === null) {
      notifyPrevious = null
    } else {
      if (derived.state === 'done' || derived.state === 'error') {
        armNotifyFinished(derived)
      } else if (notifyFinished.has(derived.sessionId)) {
        // 又开始跑了：上一条「已完成 / 失败」必须撤掉，否则会和新汇总同时挂在通知栏
        dropNotifyFinished(derived.sessionId)
      }
      notifyPrevious = { sessionId: derived.sessionId, state: derived.state }
    }
    const snapshot = buildNotifySnapshot(state, derived)
    notifySnapshot = snapshot
    // 没有任何要展示的东西（没连上会话 / 这一轮还没开始）：**连探测都不做**，
    // 保证「没东西可通知」的环境（普通浏览器、还没开跑、别人的自测）一个请求都不打。
    if (snapshot === null) return
    // 注意：**不**看 `granted`（原生语义是「运行时权限 && 总闸 && 三条渠道都可见」，
    // 用户可能只是关了一条渠道）。关了渠道原生会静默丢弃，我们照常推、失败静默。
    if (!(await ensureNotifySupport())) return
    const latest = useRemoteStore.getState()
    if (latest.phase !== 'ready' || latest.activeSessionId !== state.activeSessionId) return
    await pushWorkState(snapshot)
    notifyPosted = true
  } catch {
    // 静默：通知是锦上添花
  }
}

/** 断开 / 退出登录：丢掉记账、清整组通知（先 `reset` 掉还没发的帧，免得晚到的帧又弹回来） */
export const stopRemoteNotify = async (): Promise<void> => {
  notifyPrevious = null
  notifySnapshot = null
  notifySignals.clear()
  for (const entry of notifyFinished.values()) {
    if (entry.timer !== null) clearTimeout(entry.timer)
  }
  notifyFinished.clear()
  if (notifySyncTimer !== null) {
    clearTimeout(notifySyncTimer)
    notifySyncTimer = null
  }
  resetNotify()
  // 这一轮**从没推出去过**任何东西（普通浏览器 / 还没开跑就断开）：不用发 `/clear`
  if (!notifyPosted) return
  notifyPosted = false
  if (notifySupport === 'no') return
  await clearWork()
}

const handleNotifyPhase = (phase: RemoteState['phase'], previousPhase: RemoteState['phase']): void => {
  if (phase === previousPhase) return
  if (phase === 'ready') {
    // 新连接：上一轮的状态与结束条目全部作废（通知在 stopRemoteNotify 里已经清过）
    notifyPrevious = null
    notifySnapshot = null
    scheduleRemoteNotifySync()
    return
  }
  if (previousPhase === 'ready') void stopRemoteNotify()
}

const handleNotifyActiveSession = (sessionId: string | null, previousId: string | null): void => {
  if (sessionId === previousId) return
  notifyPrevious = null
  // 切走的会话：**结束**通知不该跟过来（还在跑的会在快照里以「其他会话」出现；
  // 待审批的也不清 —— 那是要说给用户听的事）
  if (previousId !== null) dropNotifyFinished(previousId)
  if (sessionId !== null) scheduleRemoteNotifySync()
}

const onNotifyVisibility = (): void => {
  if (typeof document === 'undefined' || document.visibilityState !== 'visible') return
  // 回前台**不清**通知（用户很可能就是点通知回来的）：只把当前状态补推一拍，
  // 内容没变会被 `notify.ts` 的逐字段浅比较挡掉，不会重复弹。
  scheduleRemoteNotifySync()
}

/**
 * 装上桥（幂等）。挂载点在 store 模块本身：`phase → ready` 才开始推，离开 ready 清整组。
 *
 * 订阅里只做「调度」不做网络：真正的请求在 `syncRemoteNotify` 里，失败静默。
 */
export const installRemoteNotify = (): void => {
  if (notifyInstalled) return
  notifyInstalled = true
  useRemoteStore.subscribe((state, previous) => {
    try {
      if (state.phase !== previous.phase) handleNotifyPhase(state.phase, previous.phase)
      if (state.activeSessionId !== previous.activeSessionId) {
        handleNotifyActiveSession(state.activeSessionId, previous.activeSessionId)
      }
      if (state.sessions !== previous.sessions) scheduleRemoteNotifySync()
      if (
        state.items !== previous.items ||
        state.streaming !== previous.streaming ||
        state.pendingApprovals !== previous.pendingApprovals ||
        state.keepAlive !== previous.keepAlive
      ) {
        scheduleRemoteNotifySync()
      }
    } catch {
      // 订阅回调里抛错会把 zustand 的 setState 弄崩：全部吞掉
    }
  })
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onNotifyVisibility)
  }
}

installRemoteNotify()

/* ────────────────────────────────────────────────────────────────────────
 * 九、[S3 全局运行态] 接线：信号进（`liveSessions.ts`）→ 状态出（`state.streaming`）
 *
 * 为什么必须有这一段：按钮、提示语、通知三处读的都是 `state.streaming`，
 * 而它原来只由「当前会话的 follow 增量」推导 —— 也就是说**用户不点进去，谁在跑都不知道**。
 * 这一段把两边的方向接起来：
 *
 *   ① 时间线 → 运行态：打开着的会话调了什么工具（别的会话 Host 不转发工具名）；
 *   ② 运行态 → `state.streaming`：只在「当前会话的运行态真的翻转」时写一次，
 *      不是每帧都写 —— 否则会把 `sendFlow` 的乐观值洗掉（发送瞬间闪一下发送键）。
 *
 * 订阅挂在 store 模块上（不是某个页面），所以**任何页面**都成立；幂等。
 * ──────────────────────────────────────────────────────────────────────── */

const installLiveSessionBridge = (): void => {
  useRemoteStore.subscribe((state, previous) => {
    try {
      if (state.activeSessionId === null) return
      if (state.activeSessionId === previous.activeSessionId && state.items === previous.items) return
      // 时间线里最后一条还在 running 的工具 = 「它现在正在干什么」
      const runningTool = notifyLatestItem(state.items, (item) => item.kind === 'tool' && item.state === 'running')
      noteLiveTool(state.activeSessionId, runningTool === undefined ? undefined : notifyToolLabel(runningTool))
    } catch {
      // 订阅里抛错会把 zustand 的 setState 弄崩：全部吞掉
    }
  })
  useLiveSessions.subscribe((state, previous) => {
    try {
      const activeId = useRemoteStore.getState().activeSessionId
      if (activeId === null) return
      const before = previous.byId[activeId]?.running === true
      const next = state.byId[activeId]?.running === true
      if (before === next) return
      if (useRemoteStore.getState().streaming === next) return
      useRemoteStore.setState({ streaming: next })
    } catch {
      // 同上
    }
  })
}

installLiveSessionBridge()

/*
 * [R14] 点通知直达会话：装在 store 模块上，和上面两条同一个位置 ——
 * `App → RemoteChatView → store` 保证它在**首屏就会执行**，所以用户哪怕当前在「本机」模式，
 * 点通知也能被接住（deepLink 内部会 `enterRemoteMode()` 切过去）。
 *
 * `deepLink.ts` 不反向 import 本文件（那会成环）：它要的「现状 + 动作」全在这里注入，
 * 于是自测可以拿假 facade 直接打它的去重 / 等连接 / 会话不存在三条路径。
 */
installDeepLink({
  store: {
    snapshot: () => useRemoteStore.getState(),
    openSession: (sessionId: string) => useRemoteStore.getState().openSession(sessionId),
    refreshSessions: () => useRemoteStore.getState().refreshSessions(),
  },
})

/*
 * [R10] 回前台就自愈：装在 store 模块上（不是某个页面），所以**任何页面**回到前台都生效。
 * 幂等单飞，与远程页/设置面板自己的 `visibilitychange` 监听重复触发不会多打一次网络。
 */
installForegroundSelfHeal()


/* ────────────────────────────────────────────────────────────────────────
 * 七、R8 缓存：退到后台时把内容写完
 *
 * 为什么单独一小块：`scheduleTimelinePersist()` 攒 800ms 才落盘，而移动端
 * 「锁屏 / 切走 / 被系统回收」可能就发生在这 800ms 里 —— 用户下次打开看到的
 * 就是少最后一两句的缓存。`visibilitychange → hidden` 是最早、最稳的抢救点
 * （比 `pagehide` 兼容性好，也覆盖切到别的 App）。
 *
 * 只做**写**，不读不删：缓存的生命周期全在 `cache.ts` 与上面几个流程里。
 * ──────────────────────────────────────────────────────────────────────── */

const installTimelineCacheFlush = (): void => {
  /* istanbul ignore next -- 无 DOM 环境（自测 / SSR）直接不装 */
  if (typeof document === 'undefined') return
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushTimelinePersist()
  })
}

installTimelineCacheFlush()
/* ────────────────────────────────────────────────────────────────────────
 * 八、R9：待处理交互的记账（会话列表红点）
 *
 * 用户在 A 会话看 B 会话的审批 / 提问时，列表里 B 那行要有个红点（圆点 + 数字）。
 * 数据只有一处来源：Host 级 `$events`（`approval/request`、`user-questions/request`
 * 都带 `eventId` + `agentId`，重连会重投 —— 所以**按 eventId 去重**）。
 *
 * 规矩：
 *   - 活动会话**不计**（人就在里面，卡片在时间线上看得见）；
 *   - 进入会话即清零（`openSession`）—— 不然红点会一直挂着等你去点一个已经看过的卡片；
 *   - `cancel` / `status=false` / `removed` 三种结束信号都销账；
 *   - 记账规则本身是纯函数（`chat-controls/promptModel.ts`），这里只负责喂与折算。
 * ──────────────────────────────────────────────────────────────────────── */

/** 会话 id → 还有哪几条没处理的 eventId（审批一份、提问一份）。 */
let pendingSets: PendingInteractionSets = {}

const samePendingCounts = (
  left: Record<string, PendingInteractionCount>,
  right: Record<string, PendingInteractionCount>,
): boolean => {
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((key) => {
    const a = left[key]
    const b = right[key]
    return a !== undefined && b !== undefined && a.approval === b.approval && a.question === b.question
  })
}

/** 记账 → UI 计数（活动会话不计）。引用没变就不 setState，省掉列表的无谓重渲染。 */
const syncPendingInteractions = (): void => {
  const state = useRemoteStore.getState()
  const next = pendingInteractionCounts(pendingSets, state.activeSessionId)
  if (samePendingCounts(state.pendingInteractions, next)) return
  useRemoteStore.setState({ pendingInteractions: next })
}

/**
 * 销账。四种入口共用：
 *   `{eventId}`（Host cancel / 本机应答完）、`{sessionId}`（进入会话 / 会话消失 / 这一轮结束）。
 */
const clearPendingInteractions = (match: { eventId?: string; sessionId?: string }): void => {
  const next = settlePendingInteraction(pendingSets, match)
  if (next === pendingSets) return
  pendingSets = next
  syncPendingInteractions()
}

/** 断开 / 退出登录：记账整块复位（界面状态由 `INITIAL_STATE` 复位）。 */
const resetPendingInteractions = (): void => {
  pendingSets = {}
  if (Object.keys(useRemoteStore.getState().pendingInteractions).length > 0) {
    useRemoteStore.setState({ pendingInteractions: {} })
  }
}

/**
 * `$events` 的每条 item 都过这里（与 `noteRemoteNotifyItem` 并列，互不依赖）。
 *
 * 认两种形状：
 *   - waterfall `approval/request` / `user-questions/request` → 记一条（`eventId` 去重）；
 *   - `{type:'cancel', eventId}` / `api-session/status running=false` / `api-session/removed` → 销账。
 *
 * 异常一律吞掉：红点是锦上添花，不能打断 `$events` 的分发。
 *
 * 导出只为自测（与 `noteRemoteNotifyItem` 同一惯例）：界面不调它。
 */
export const notePendingInteractionEvent = (value: unknown): void => {
  try {
    const active = useRemoteStore.getState().activeSessionId
    const forwarded = forwardedSessionEvent(value)
    if (forwarded !== undefined) {
      if (forwarded.kind === 'removed' || (forwarded.kind === 'status' && !forwarded.running)) {
        clearPendingInteractions({ sessionId: forwarded.sessionId })
      }
      return
    }
    const record = notifyRecordOf(value)
    if (record === null || typeof record.type !== 'string') return
    if (record.type === 'cancel') {
      if (typeof record.eventId === 'string') clearPendingInteractions({ eventId: record.eventId })
      return
    }
    if (record.type !== 'waterfall') return
    if (typeof record.eventId !== 'string' || typeof record.agentId !== 'string') return
    // 活动会话不计：卡片就在时间线里，红点只会碍眼
    if (record.agentId === active) return
    const kind = record.event === 'approval/request'
      ? 'approval'
      : record.event === 'user-questions/request'
        ? 'question'
        : undefined
    if (kind === undefined) return
    const next = trackPendingInteraction(pendingSets, { sessionId: record.agentId, kind, eventId: record.eventId })
    if (next === pendingSets) return
    pendingSets = next
    syncPendingInteractions()
  } catch {
    // 静默：红点只是界面提示
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * 九、[S1 无感重载] 启动时用缓存铺时间线（不依赖连接）
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 重载之后**先把上一次那个会话的时间线铺上**，不等连接就绪。
 *
 * ## 为什么必须单独有这么一条
 *
 * `openSession(id)` 的第一步是 `requireSession()` —— 还没有活连接时它直接失败，
 * 于是「缓存直出」这条设计在「页面刚重载」这个最需要它的时刻恰好用不上：
 * 用户先看到一屏空白，直到握手成功、列表拉回、会话重开。
 *
 * 而缓存桶（`serverUrl + hostDeviceId`）**在连接之前就算得出来**：`cacheBucketNow()`
 * 没有活连接时会退回盘上那条 `last-session`。所以这里只读一次 `localStorage`，
 * 就能把上一屏原样铺出来，顶部挂「正在同步…」——`cacheStatus` 里
 * `timelineFromCache=true` + `timelineSettled=false` 正是那条提示的开关
 * （判定见 `cache.ts` 的 `timelineHintState()`）。
 *
 * ## 三条纪律
 *
 * 1. **不抢**：已经有会话开着、或时间线里已经有内容，就什么都不做（幂等、可重复调）；
 * 2. **不发请求**：一条网络都不打，只读盘；
 * 3. **不伪装成已同步**：`timelineSettled` 保持 false，界面才敢说「正在同步」而不是
 *    「这就是全部」。真正的快照由随后的 `openSession()` 落定。
 *
 * @param sessionId 要铺哪个会话（调用方从 `uiState` 快照里读到，见 `uiState.ts`）
 */
export const hydrateCachedTimeline = (sessionId: string): void => {
  if (sessionId.length === 0) return
  const state = useRemoteStore.getState()
  if (state.activeSessionId !== null || state.items.length > 0) return
  const bucket = active ? timelineBucketFor(active) : loadCompactHistory() ? null : cacheBucketNow()
  if (bucket === null) return
  const cached = readTimelineCache({ ...bucket, sessionId, now: Date.now() })
  if (cached === null || cached.items.length === 0) return
  // 读盘期间可能已经有会话开起来了（自动恢复很快）：再查一次，别拿缓存盖掉新的
  const latest = useRemoteStore.getState()
  if (latest.activeSessionId !== null || latest.items.length > 0) return
  useRemoteStore.setState({
    activeSessionId: sessionId,
    items: cached.items,
    streaming: false,
    cacheStatus: {
      ...latest.cacheStatus,
      timelineFromCache: true,
      timelineLoading: false,
      timelineSettled: false,
      timelineFailed: false,
    },
  })
  setPaging(false, false)
}
