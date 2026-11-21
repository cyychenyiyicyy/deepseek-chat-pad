/**
 * [S3] 全局运行态：**不打开会话，也要知道谁在跑。**
 *
 * ## 为什么需要它
 *
 * 真机反馈（S3）：「进 App 后有一个正在进行中的会话，它不会自动识别到，也不会有实时通知，
 * 必须要等我点进去它才发现，而且发送按钮没有变成终止按钮」。
 *
 * 根因不是按钮写错了，而是**信号在哪里**：`store.streaming` 只由当前会话的
 * `session/follow` 增量推导（`runningForFollowItem()` 看 `turn/start` / `turn/end`），
 * 而「打开一个已经在跑的会话」时，`turn/start` 早就过去了 —— follow 首帧只给历史记录，
 * 于是 `streaming` 一直是 false：按钮不变停止、通知里也没有它。
 *
 * 这一层把「谁在跑」从**打开的会话**提到**整台 Host**：三条来源互相校正，
 * 任何一条到了都能把状态摆正。
 *
 * ## 三条来源（优先级从高到低）
 *
 * | 来源 | 时机 | 拿到什么 | 可信度 |
 * |---|---|---|---|
 * | `session/list` 行的 `running` | 连接建立 / 每次刷新 / 切 Host | 每个根会话的权威布尔值 | 最高（Host 自己算的） |
 * | `$events` 的 `api-session/*` 增量 | 常驻 | `status{added,removed,status,activity,error}` | 高（实时增量） |
 * | `session/control` 投影（`turn` / `turnState` / `activeTurnId` / `status`） | 打开会话后 | 当前会话的回合状态 | 中（老 Host 可能没有这些键；**有就以它为准**，因为它是投影不是事件） |
 *
 * 三者都只做一件事：把 `byId[sessionId].running` 摆正。**没有第四条来源**，
 * 也**不做本地推断**（比如「时间线里有 running 的工具就当在跑」）—— 那种推断会在
 * 工具卡住的会话上永远亮着。
 *
 * ## 断线 / 重连
 *
 * `resetLiveSessions()` 在断开时整块清掉（旧连接的状态一条都不留）；
 * 重连成功后 `reconcileLiveWithList()` 按 `session/list` **对账**：
 *   - 列表说 `running:true` → 立刻算在跑（这就是「刚进 App 就能看到」的那一条）；
 *   - 列表说 `running:false` → 立刻熄掉（**不留过期 running**）；
 *   - 列表里已经没有的会话 → 熄掉，且没有待审批就整条删掉。
 *
 * ## 与既有状态的关系（重要）
 *
 * `store.pendingInteractions`（R9 红点）与 `store.notifySignals`（R6 通知）都**已经**在
 * 各自记账，这一层**不合并**它们 —— 三个注册表各自独立、互为冗余，谁漏了一条不会让
 * 功能整块瞎掉。列表上那个数字取两者的大值（见 `RemoteSessionList` 的注释）。
 */

import { create } from 'zustand'
import { forwardedSessionEvent } from './adapter.js'

/** 一条会话的运行态（界面只读它） */
export interface SessionLive {
  /** 这一轮在跑（`turn/start` 之后、`turn/end` 之前） */
  running: boolean
  /**
   * 正在调用的工具展示名（如「读取 README.md」）。
   *
   * **只有当前打开的会话才有**：别的会话 Host 不转发工具名（`api-session/status`
   * 只有一个布尔值），所以列表上别的会话显示「运行中」而略掉工具名 —— 宁可不显示，
   * 也不显示一个上个回合残留的工具名。停下来的那一刻就清掉。
   */
  tool?: string
  /** 这个会话上等着的待审批**条数**（按 eventId 去重；活动会话也计，通知要用） */
  approval: number
  /** 最近一次信号的时间（没有 `activity` 事件时用事件到达时间） */
  updatedAt: number
}

export interface LiveSessionsState {
  byId: Record<string, SessionLive>
  /** 最近一次按 `session/list` 对账的时间（0 = 这一代连接还没对过账） */
  reconciledAt: number
}

export const INITIAL_LIVE_STATE: LiveSessionsState = { byId: {}, reconciledAt: 0 }

/** 全局运行态（页面里唯一一份；与 `useRemoteStore` 平行，互不 setState 对方） */
export const useLiveSessions = create<LiveSessionsState>(() => INITIAL_LIVE_STATE)

/* ────────────────────────────────────────────────────────────────────────
 * 一、纯归约（自测直接喂事件、断言状态；不碰网络不碰时间）
 * ──────────────────────────────────────────────────────────────────────── */

/** 对账用的一行（`session/list` 的投影，只取这层用得到的字段） */
export interface LiveListRow {
  sessionId: string
  running?: boolean
  updatedAt?: number
}

export type LiveInput =
  /** `api-session/status`：这一轮开始 / 结束 */
  | { kind: 'status'; sessionId: string; running: boolean; at: number }
  /** `api-session/activity`：只有时间戳，用来排序 */
  | { kind: 'activity'; sessionId: string; at: number }
  /** `api-session/added`：新根会话（行里可能带 `running`） */
  | { kind: 'added'; sessionId: string; running?: boolean; at: number }
  /** `api-session/removed`：整条删掉 */
  | { kind: 'removed'; sessionId: string }
  /** 当前会话时间线里最后一个 running 的工具（没有就 `undefined` = 清掉） */
  | { kind: 'tool'; sessionId: string; tool?: string; at: number }
  /** 待审批条数（由 eventId 记账算出**绝对值**，重复投递不会翻倍） */
  | { kind: 'approval'; sessionId: string; count: number; at: number }
  /** `session/list` 全量对账 */
  | { kind: 'list'; rows: readonly LiveListRow[]; at: number }

const EMPTY_RECORD: SessionLive = { running: false, approval: 0, updatedAt: 0 }

/** 取一条（没有就给一个共享的只读空记录，调用方不必到处判 undefined） */
export const liveRecordOf = (state: LiveSessionsState, sessionId: string): SessionLive =>
  state.byId[sessionId] ?? EMPTY_RECORD

const sameRecord = (a: SessionLive, b: SessionLive): boolean =>
  a.running === b.running && a.tool === b.tool && a.approval === b.approval && a.updatedAt === b.updatedAt

/**
 * 写一条（值没变就**原样返回 state**）。
 *
 * 为什么要比引用：这张表挂在 zustand 上，列表每行都订阅着它 —— 一次无变化的
 * `setState` 会让整张列表重渲染，而 `api-session/activity` 这种事件可能每秒好几条。
 */
const put = (state: LiveSessionsState, sessionId: string, next: SessionLive): LiveSessionsState => {
  const prev = state.byId[sessionId]
  if (prev !== undefined && sameRecord(prev, next)) return state
  return { ...state, byId: { ...state.byId, [sessionId]: next } }
}

const drop = (state: LiveSessionsState, sessionId: string): LiveSessionsState => {
  if (state.byId[sessionId] === undefined) return state
  const byId = { ...state.byId }
  delete byId[sessionId]
  return { ...state, byId }
}

/** 其它字段保留，只把 `running` 摆正（停下来的时候顺手清掉工具名） */
const withRunning = (
  state: LiveSessionsState,
  sessionId: string,
  running: boolean,
  at: number,
): LiveSessionsState => {
  const prev = liveRecordOf(state, sessionId)
  return put(state, sessionId, {
    running,
    ...(running && prev.tool !== undefined ? { tool: prev.tool } : {}),
    approval: prev.approval,
    updatedAt: Math.max(prev.updatedAt, at),
  })
}

/**
 * 一条输入 → 新状态（**纯函数**：同样的输入与状态一定得到同样的输出）。
 *
 * `at` 由调用方给（自测可注入，生产是 `Date.now()`）—— 这层不自己读时钟。
 */
export const applyLiveInput = (state: LiveSessionsState, input: LiveInput): LiveSessionsState => {
  switch (input.kind) {
    case 'status':
      return withRunning(state, input.sessionId, input.running, input.at)
    case 'activity': {
      const prev = state.byId[input.sessionId]
      // 时间戳没有推进就不动（`api-session/activity` 可能比列表里的 `updatedAt` 还旧）
      if (prev !== undefined && prev.updatedAt >= input.at) return state
      return put(state, input.sessionId, { ...(prev ?? EMPTY_RECORD), updatedAt: input.at })
    }
    case 'added': {
      const prev = liveRecordOf(state, input.sessionId)
      const running = input.running ?? prev.running
      return put(state, input.sessionId, {
        running,
        ...(running && prev.tool !== undefined ? { tool: prev.tool } : {}),
        approval: prev.approval,
        updatedAt: Math.max(prev.updatedAt, input.at),
      })
    }
    case 'removed':
      return drop(state, input.sessionId)
    case 'tool': {
      const prev = liveRecordOf(state, input.sessionId)
      // 工具名没变就别动：这是 `store.items` 每帧都会喂进来的东西
      if (prev.tool === input.tool) return state
      return put(state, input.sessionId, {
        ...prev,
        ...(input.tool === undefined ? { tool: undefined } : { tool: input.tool }),
        updatedAt: Math.max(prev.updatedAt, input.at),
      })
    }
    case 'approval': {
      const prev = liveRecordOf(state, input.sessionId)
      return put(state, input.sessionId, {
        ...prev,
        approval: input.count,
        updatedAt: Math.max(prev.updatedAt, input.at),
      })
    }
    case 'list': {
      const known = new Map(input.rows.map((row) => [row.sessionId, row] as const))
      const byId: Record<string, SessionLive> = {}
      // ① 列表里有的：以列表的 `running` 为准（老 Host 不给这个字段时保持原样）
      for (const [sessionId, row] of known) {
        const prev = state.byId[sessionId]
        const running = typeof row.running === 'boolean' ? row.running : prev?.running ?? false
        const updatedAt = Math.max(row.updatedAt ?? 0, prev?.updatedAt ?? 0, running ? input.at : 0)
        const record: SessionLive = {
          running,
          ...(running && prev?.tool !== undefined ? { tool: prev.tool } : {}),
          approval: prev?.approval ?? 0,
          updatedAt: running && updatedAt === 0 ? input.at : updatedAt,
        }
        // 一条全空的记录（没在跑、没待审批、没时间）没有信息量，不进表
        if (record.running || record.approval > 0 || record.updatedAt > 0) byId[sessionId] = record
      }
      // ② 列表里没有的：**必须熄掉**（否则会永远亮着一个已经不存在的 running）。
      //    但有待审批的留着 —— 那是子会话 / 被截断的行，通知里还要用；清空交给 cancel / removed。
      for (const [sessionId, record] of Object.entries(state.byId)) {
        if (known.has(sessionId)) continue
        if (record.approval > 0) byId[sessionId] = { ...record, running: false, tool: undefined }
      }
      return { byId, reconciledAt: input.at }
    }
    default:
      return state
  }
}

/** 汇总：几个在跑 / 几个待审批（列表顶部那句「2 个会话在跑」用它） */
export const liveCountsOf = (
  state: LiveSessionsState,
  exceptSessionId: string | null = null,
): { running: number; approval: number } => {
  let running = 0
  let approval = 0
  for (const [sessionId, record] of Object.entries(state.byId)) {
    if (sessionId === exceptSessionId) continue
    if (record.running) running += 1
    if (record.approval > 0) approval += 1
  }
  return { running, approval }
}

/* ────────────────────────────────────────────────────────────────────────
 * 二、事件解析（`$events` / `session/control`）
 * ──────────────────────────────────────────────────────────────────────── */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * 待审批的 eventId 记账（`eventId → sessionId`）。
 *
 * 为什么自己做一份而不是借 `store.pendingInteractions`：那一份**把活动会话排除在外**
 * （红点用），而通知需要「活动会话也有几条待审批」。两份记账互相独立，
 * 两边都靠同三个信号销账（`cancel` / `status running=false` / `removed`）。
 */
const approvalOwners = new Map<string, string>()

const approvalCountOf = (sessionId: string): number => {
  let count = 0
  for (const owner of approvalOwners.values()) if (owner === sessionId) count += 1
  return count
}

const dispatch = (input: LiveInput): void => {
  const state = useLiveSessions.getState()
  const next = applyLiveInput(state, input)
  if (next !== state) useLiveSessions.setState(next)
}

const now = (): number => Date.now()

/**
 * `$events` 的每一条 item 都过这里（`store.ts` 的 `$events` sink 调）。
 *
 * 认四种形状：
 *   - `emit` 的 `api-session/status|removed|activity|added`（`adapter.forwardedSessionEvent()`）；
 *   - waterfall `approval/request`（记一条待审批，按 eventId 去重）；
 *   - `{type:'cancel', eventId}`（Host 撤回审批）；
 *   - `api-session/status running=false` 同时清掉这个会话的待审批（这一轮结束了）。
 *
 * 异常一律吞掉：运行态只是界面提示，不能打断 `$events` 的分发。
 */
export const noteLiveEventsItem = (value: unknown): void => {
  try {
    const forwarded = forwardedSessionEvent(value)
    if (forwarded !== undefined) {
      switch (forwarded.kind) {
        case 'status': {
          const at = now()
          if (!forwarded.running) {
            clearApprovalsOf(forwarded.sessionId, at)
          }
          dispatch({ kind: 'status', sessionId: forwarded.sessionId, running: forwarded.running, at })
          return
        }
        case 'removed':
          clearApprovalsOf(forwarded.sessionId, now())
          dispatch({ kind: 'removed', sessionId: forwarded.sessionId })
          return
        case 'activity':
          dispatch({ kind: 'activity', sessionId: forwarded.sessionId, at: forwarded.updatedAt })
          return
        case 'added':
          dispatch({
            kind: 'added',
            sessionId: forwarded.sessionId,
            ...(isRecord(forwarded.session) && typeof forwarded.session.running === 'boolean'
              ? { running: forwarded.session.running }
              : {}),
            at: now(),
          })
          return
        default:
          return
      }
    }
    const record = isRecord(value) ? value : null
    if (record === null || typeof record.type !== 'string') return
    if (record.type === 'cancel') {
      if (typeof record.eventId === 'string') clearApprovalByEvent(record.eventId)
      return
    }
    if (record.type !== 'waterfall' || record.event !== 'approval/request') return
    const eventId = typeof record.eventId === 'string' ? record.eventId : ''
    const sessionId = typeof record.agentId === 'string' ? record.agentId : ''
    if (eventId.length === 0 || sessionId.length === 0) return
    // 重投（重连时 Host 会用同一个 eventId 重发）不翻倍
    if (approvalOwners.has(eventId)) return
    approvalOwners.set(eventId, sessionId)
    dispatch({ kind: 'approval', sessionId, count: approvalCountOf(sessionId), at: now() })
  } catch {
    // 静默：运行态是锦上添花
  }
}

const clearApprovalByEvent = (eventId: string): void => {
  const owner = approvalOwners.get(eventId)
  if (owner === undefined) return
  approvalOwners.delete(eventId)
  dispatch({ kind: 'approval', sessionId: owner, count: approvalCountOf(owner), at: now() })
}

const clearApprovalsOf = (sessionId: string, at: number): void => {
  let changed = false
  approvalOwners.forEach((owner, eventId) => {
    if (owner !== sessionId) return
    approvalOwners.delete(eventId)
    changed = true
  })
  if (changed) dispatch({ kind: 'approval', sessionId, count: 0, at })
}

/**
 * 从 `session/control` 投影里读运行态（**有就以它为准**）。
 *
 * 这台 Host 会把 `turn` / `turnState` / `activeTurnId` / `status` 放进
 * `projections.values`（`harness-remote-bridge` 的白名单里就有这几个键），
 * 但**老 Host 可能一个都没有**，所以这里全部按「能解析出来才用」写：
 * 解析不出来就返回 `undefined`，让 `$events` / `session/list` 决定。
 */
const RUNNING_STATES = new Set(['running', 'active', 'in_progress', 'in-progress', 'busy', 'working', 'pending'])
const IDLE_STATES = new Set(['idle', 'done', 'completed', 'complete', 'finished', 'failed', 'cancelled', 'canceled', 'ended', 'stopped', 'aborted'])

/** 判定一个状态字符串（大小写不敏感；不认识的词一律 `undefined` = 没有结论） */
const stateVerdict = (raw: unknown): boolean | undefined => {
  if (typeof raw !== 'string') return undefined
  const normalized = raw.trim().toLowerCase()
  if (RUNNING_STATES.has(normalized)) return true
  if (IDLE_STATES.has(normalized)) return false
  return undefined
}

export const runningOfProjection = (values: Record<string, unknown>): boolean | undefined => {
  for (const key of ['turn', 'turnState'] as const) {
    const verdict = runningOfTurnValue(values[key])
    if (verdict !== undefined) return verdict
  }
  if (typeof values.activeTurnId === 'string') return values.activeTurnId.length > 0
  if (values.activeTurnId === null) return false
  for (const key of ['status', 'remoteStatusKnown'] as const) {
    const raw = values[key]
    const direct = stateVerdict(raw)
    if (direct !== undefined) return direct
    if (isRecord(raw)) {
      const nested = stateVerdict(raw.status) ?? stateVerdict(raw.state)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/** `turn` / `turnState` 的两种形状：字符串枚举，或 `{status}` / `{state}` 对象 */
const runningOfTurnValue = (raw: unknown): boolean | undefined => {
  if (raw === null) return false
  const direct = stateVerdict(raw)
  if (direct !== undefined) return direct
  if (!isRecord(raw)) return undefined
  return stateVerdict(raw.status) ?? stateVerdict(raw.state)
}

/**
 * 投喂一帧 `session/control`（`store.ts` 的 `session/control` sink 调）。
 *
 * 两种形状与 `sessionControls.applyControlFrame()` 认的完全一样：
 *   - `{type:'baseline', value:{projections:{sessionId:{values}}}}`（整份）
 *   - `{type:'projection', sessionId, changes:[{key,val}]}` / `{...key,value}`（增量）
 *
 * 增量帧只有 `turn` 相关的键会改变结论，其余键直接跳过 —— 免得每帧都算一遍。
 */
export const noteLiveControlFrame = (value: unknown): void => {
  try {
    if (!isRecord(value)) return
    if (value.type === 'baseline') {
      const frame = isRecord(value.value) ? value.value : undefined
      const projections = frame !== undefined && isRecord(frame.projections) ? frame.projections : undefined
      if (projections === undefined) return
      for (const [sessionId, block] of Object.entries(projections)) {
        if (!isRecord(block) || !isRecord(block.values)) continue
        const running = runningOfProjection(block.values)
        if (running !== undefined) dispatch({ kind: 'status', sessionId, running, at: now() })
      }
      return
    }
    if (value.type !== 'projection') return
    const sessionId = typeof value.sessionId === 'string' ? value.sessionId : ''
    if (sessionId.length === 0) return
    const patch: Record<string, unknown> = {}
    if (Array.isArray(value.changes)) {
      for (const change of value.changes) {
        if (!isRecord(change) || typeof change.key !== 'string') continue
        if (!CONTROL_RUNNING_KEYS.has(change.key)) continue
        patch[change.key] = change.val
      }
    } else if (typeof value.key === 'string' && CONTROL_RUNNING_KEYS.has(value.key)) {
      patch[value.key] = value.value
    }
    if (Object.keys(patch).length === 0) return
    const running = runningOfProjection(patch)
    if (running !== undefined) dispatch({ kind: 'status', sessionId, running, at: now() })
  } catch {
    // 静默
  }
}

const CONTROL_RUNNING_KEYS = new Set(['turn', 'turnState', 'activeTurnId', 'status', 'remoteStatusKnown'])

/* ────────────────────────────────────────────────────────────────────────
 * 三、与 store 的接线（store.ts 只调这几个函数）
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * `session/list` 到手 → 全量对账。
 *
 * 这是「刚进 App 就能看到正在跑的会话」的那一条路：`session/list` 的行里
 * `running` 是 Host 自己算的，比任何增量事件都权威。
 */
export const reconcileLiveWithList = (rows: readonly LiveListRow[]): void => {
  try {
    dispatch({ kind: 'list', rows, at: now() })
  } catch {
    // 静默
  }
}

/** 当前打开的会话时间线里最后一个 running 的工具 → 记进运行态（别的会话拿不到工具名） */
export const noteLiveTool = (sessionId: string | null, tool: string | undefined): void => {
  if (sessionId === null) return
  try {
    dispatch({ kind: 'tool', sessionId, tool, at: now() })
  } catch {
    // 静默
  }
}

/** 某条会话现在算不算在跑（同步读，非 React 环境也能用） */
export const liveRunningOf = (sessionId: string | null): boolean =>
  sessionId === null ? false : liveRecordOf(useLiveSessions.getState(), sessionId).running

/** 断开 / 退出登录 / 切 Host：整块复位（旧连接的运行态一条都不留） */
export const resetLiveSessions = (): void => {
  approvalOwners.clear()
  const state = useLiveSessions.getState()
  if (Object.keys(state.byId).length === 0 && state.reconciledAt === 0) return
  useLiveSessions.setState({ byId: {}, reconciledAt: 0 })
}

/* ────────────────────────────────────────────────────────────────────────
 * 四、给通知层用：把运行态折成「别的会话」那一列
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 一条「其它会话」的通知输入（字段与 `store.ts` 的 `NotifyOtherSession` 逐字段对齐）。
 *
 * 为什么单独抽出来：这是 R6 那条链路上**唯一**能把「没打开过的运行中会话」带进
 * `items` 的地方（`notifySignals` 只记得这一代连接里收到过的 `status` 事件）。
 * 抽成纯函数后自测可以直接摆：`session/list` 说在跑 → 折出来的一定 `running:true`。
 */
export interface LiveNotifyOther {
  sessionId: string
  title: string
  running: boolean
  /** 待审批条数（>0 时通知层画 approval 条目） */
  approvalCount: number
  /** 待审批的工具名：只有 `notifySignals` 那条路知道，这里留空 */
  approvalTool?: string
  approvalTs?: number
  /** 正在调用的工具展示名（只有打开着的会话才有） */
  tool?: string
  updatedAt: number
}

/**
 * 运行态 → 「其它会话」列表（**不含**活动会话：活动会话走时间线那一条推导）。
 *
 * 注意四件事：
 *   1. 既没在跑、也没有待审批的会话直接丢掉（通知栏不是会话列表）；
 *   2. `title` 由调用方给（它才知道会话列表里有没有这一条 —— 子会话就没有）；
 *   3. `updatedAt` 取运行态与列表的较大值，排序才不会把刚动过的会话压到底下；
 *   4. 审批条目优先于运行中：同一条会话既在跑又等审批时，说的是「等你点」。
 */
export const liveNotifyOthers = (
  state: LiveSessionsState,
  input: {
    activeSessionId: string | null
    titleOf: (sessionId: string) => string
    updatedAtOf: (sessionId: string) => number
  },
): LiveNotifyOther[] => {
  const others: LiveNotifyOther[] = []
  for (const [sessionId, record] of Object.entries(state.byId)) {
    if (sessionId === input.activeSessionId) continue
    if (!record.running && record.approval <= 0) continue
    others.push({
      sessionId,
      title: input.titleOf(sessionId),
      running: record.running,
      approvalCount: record.approval,
      ...(record.tool === undefined ? {} : { tool: record.tool }),
      updatedAt: Math.max(record.updatedAt, input.updatedAtOf(sessionId)),
    })
  }
  return others
}

/* ── 界面选择器（返回值都是原始量或稳定引用，不会引发重渲染环） ─────────── */

/** 一条会话的运行态（稳定引用；没有就是 `undefined`） */
export const useSessionLive = (sessionId: string | null): SessionLive | undefined =>
  useLiveSessions((state) => (sessionId === null ? undefined : state.byId[sessionId]))

/** 汇总里的「N 个在跑」（不含传进来的那个会话） */
export const useLiveRunningCount = (exceptSessionId: string | null = null): number =>
  useLiveSessions((state) => liveCountsOf(state, exceptSessionId).running)

/** 汇总里的「N 个待审批」（不含传进来的那个会话） */
export const useLiveApprovalCount = (exceptSessionId: string | null = null): number =>
  useLiveSessions((state) => liveCountsOf(state, exceptSessionId).approval)

/** 排障摘要（自测 / 日志用，不含任何会话内容） */
export const describeLive = (): string => {
  const state = useLiveSessions.getState()
  const counts = liveCountsOf(state)
  return `live|sessions=${Object.keys(state.byId).length}|running=${counts.running}|approval=${counts.approval}|reconciled=${state.reconciledAt > 0 ? 'yes' : 'no'}`
}
