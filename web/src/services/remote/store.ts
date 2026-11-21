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
import { RemoteApiError, normalizeServerUrl } from './serverApi.js'
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

export interface RemoteState {
  phase: 'idle' | 'authing' | 'connecting' | 'ready' | 'error'
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

/* ── 动作实现 ─────────────────────────────────────────────────────────── */

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

    // 6. `$events` 必须先 ready（审批 / 目录增量都靠它）
    await openEventsStream(session)
    // 7. 首屏列表
    useRemoteStore.setState({ sessions: projectSessions(await listSessions(link)) })
  } catch (error) {
    await shutdown()
    failConnection(error)
  }
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
