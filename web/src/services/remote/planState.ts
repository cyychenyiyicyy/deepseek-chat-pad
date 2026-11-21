/**
 * 任务进度与计划（R11）：**todo 列表**、**plan 模式状态**、**计划正文**三件事的只读状态源。
 *
 * ```
 *  session/control（投影流） ──┐
 *                            ├─► planState.ts ──► components/remote/plan/**
 *  useRemoteStore.items ──────┘（只读订阅）
 * ```
 *
 * ## 数据从哪来（这一节是调研结论，改代码前先读）
 *
 * | 要什么 | 权威来源 | 形状 | 依据 |
 * |---|---|---|---|
 * | todo 列表 | `session/control` 投影 `values.todos` | `{content,status}[]`，`status ∈ pending\|in_progress\|completed`，**整表替换 / 最后一条生效** | `@deepseek-ai/dsh-api-remotes` 的 `SessionSummary` 投影 schema（`todos` 字段的 zod `.describe()` 明写「the latest `todo/write` snapshot … whole-value rule … last-wins」） |
 * | plan 模式状态 | `session/control` 投影 `values.plan` | `{active: boolean, pending: boolean}` | `@deepseek-ai/dsh-plan-mode/src/types.ts` 的 `PlanProjection`（`SessionProjectionMap.plan`） |
 * | 计划正文 | 时间线里 `exit_plan_mode` 工具调用的 `args.plan`，或 plan-review 提问的 `detail` | markdown 字符串 | `@deepseek-ai/dsh-plan-mode/src/index.ts`：`interaction.ask({questions:[{id:'plan-review', detail: args.plan, intent:{kind:'plan-review', approve:'Approve', callId}}]})` |
 *
 * 三条都是**真机上拿得到**的：前两项在 `session/control` 的 `projection` 帧里，
 * 第三项跟着 `session/follow` 的 `tool/call` / `user-questions/request` 一起到。
 * 没有任何字段是本地编出来的 —— 服务端不给就是空。
 *
 * ## 为什么要自己开一条 `session/control`
 *
 * `store.ts` 已经开了一条，但它的 sink 是内部的（`routeStream` 里内部 sink 优先），
 * 外部接收器收不到帧；而按本任务的边界，`store.ts` / `sessionControls.ts` 都不许改。
 * 所以这里用 `sessionsApi.lastRemoteTarget()`（`workspacePaneStore.ts` 用的同一个口子）
 * 自己开一条只读的投影流，**只取 `todos` 与 `plan` 两个键**。
 *
 * 这是一条「边界内的替代实现」，代价是多一条流（协议上限 16 条/连接，投影帧很小）。
 * 正确的长期做法是在 `sessionControls.applyProjection()` 里补两行把 `todos` / `plan`
 * 一起投影出来 —— 那属于该文件的所有者，本任务不碰。
 *
 * ## 三条纪律
 *
 * 1. **拿不到就不渲染**：`todos` 空 → 进度卡整块不渲染（不占位、不显示「0/0」）；
 *    `plan` 投影不在 → plan 模式一律按「未激活」处理，不猜。
 * 2. **不闪不跳**：投影是整表替换，这里只做「内容相同就不 setState」的等价判断，
 *    进度条宽度用 CSS transition，行的高亮跟着 `in_progress` 走。
 * 3. **折叠状态记在本地**：用户收起就一直是收起的，新 todo 到达**不会**自动展开。
 */

import { create } from 'zustand'

import type { ChatItem } from './adapter.js'
import type { StreamEventPayload } from './core/index.js'
import { lastRemoteTarget, type RemoteCallTarget } from './sessionsApi.js'
import { registerRemoteStreamSink, useRemoteStore } from './store.js'

/* ────────────────────────────────────────────────────────────────────────
 * 一、常量
 * ──────────────────────────────────────────────────────────────────────── */

/** 投影流端点（与 `store.ts` 开的是同一个；这里只要 `todos` / `plan` 两个键）。 */
const CONTROL_ENDPOINT = 'session/control'

/** 开流的预算：`session/control` 首帧就是 baseline，很快。 */
const OPEN_TIMEOUT_MS = 30_000

/**
 * 从时间线里找计划正文/兜底 todo 时往前看的条数上限。
 *
 * 有投影时根本走不到这里；这条路径只在「Host 没有 `session/control`」时兜底，
 * 所以不需要扫整段历史 —— 200 条足够覆盖最近几轮。
 */
const TIMELINE_SCAN_LIMIT = 200

/** 折叠偏好的键（与 `storage.ts` 的 `dsp.remote.*` 同一命名空间；纯 UI 偏好，不进凭据）。 */
export const PLAN_PROGRESS_COLLAPSED_KEY = 'dsp.remote.plan.progress-collapsed.v1'

/** 官方工具名：模型提交计划用的那个工具。 */
export const EXIT_PLAN_MODE_TOOL = 'exit_plan_mode'
/** 官方工具名：todo 整表写入。 */
export const TODO_WRITE_TOOL = 'todo_write'

/* ────────────────────────────────────────────────────────────────────────
 * 二、纯解析（单测入口：`__selftest__/planState.selftest.mts`）
 * ──────────────────────────────────────────────────────────────────────── */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

export type PlanTodoStatus = 'pending' | 'in_progress' | 'completed'

/** 一条待办（官方 `TodoItem` 的最小面）。 */
export interface PlanTodo {
  content: string
  status: PlanTodoStatus
}

/** `plan` 投影值（官方 `PlanProjection`）。 */
export interface PlanModeProjection {
  active: boolean
  pending: boolean
}

/** 一帧投影里我们关心的两件事（`undefined` = 这一帧没提到它，保持原值）。 */
export interface ProjectionPatch {
  todos?: PlanTodo[]
  mode?: PlanModeProjection | null
}

/** 计划正文（从时间线派生）。 */
export interface PlanText {
  text: string
  /** plan-review 提问里的那个 callId（`exit_plan_mode` 的调用 id），拿不到就没有。 */
  callId?: string
  /** 正文的首个 markdown 标题（面板标题用它，与官方 `firstHeading()` 同一规则）。 */
  heading?: string
}

/**
 * 归一化 todo 列表。
 *
 * 官方投影是严格的 `{content,status}`；这里额外容忍 `title` / `label` 与
 * `done` / `running` 这类别名，理由与 `packages/plugin` 的 `normalizeAcpTodos()` 相同：
 * ACP 后端（cursor 等）的 todo 形状不一样，而客户端只该有一套渲染。
 * 内容为空的行**丢掉**（官方 `todo_write` 也会拒绝空 content）。
 */
export const parsePlanTodos = (value: unknown): PlanTodo[] => {
  if (!Array.isArray(value)) return []
  const out: PlanTodo[] = []
  for (const row of value) {
    if (!isRecord(row)) continue
    const raw = asString(row.content) ?? asString(row.title) ?? asString(row.label)
    const content = raw?.trim() ?? ''
    if (content.length === 0) continue
    const status = row.status
    out.push({
      content,
      status:
        status === 'completed' || status === 'done'
          ? 'completed'
          : status === 'in_progress' || status === 'inProgress' || status === 'running'
            ? 'in_progress'
            : 'pending',
    })
  }
  return out
}

/** 解析 `plan` 投影；`active` 不是布尔就不认（形状不对 = 这台 Host 没有 plan 能力）。 */
export const parsePlanMode = (value: unknown): PlanModeProjection | null => {
  if (!isRecord(value) || typeof value.active !== 'boolean') return null
  return { active: value.active, pending: value.pending === true }
}

/**
 * 「此刻是否真的在 plan 模式」。
 *
 * 官方徽章的判据（`dsh-client-ui-plan` README）：有效目标 = `pending ? !active : active`。
 * 为什么不是直接读 `active`：`/plan` 的选择在**下一个被接受的轮内 pre-step** 之前只是
 * 待生效（`pending: true`），此时 `active` 还是旧值 —— 直接读会让徽章晚一步。
 */
export const planModeActive = (mode: PlanModeProjection | null): boolean =>
  mode === null ? false : mode.pending ? !mode.active : mode.active

/** 取真正的目标态（`pending` 时是 `!active`）。 */
export const planModeTarget = (mode: PlanModeProjection | null): boolean =>
  mode === null ? false : mode.pending ? !mode.active : mode.active

/** 折叠态标题要用的进度摘要。 */
export interface PlanProgress {
  done: number
  total: number
  /** 正在做的那几条（并行的计划可能多于一条）。 */
  active: PlanTodo[]
  /** `3/7` —— 只算数量，不带单位（单位在 i18n 里）。 */
  text: string
}

/** 纯派生：完成数 / 总数 / 进行中的条目。列表为空时 `text` 是 `0/0`（调用方本来就不渲染）。 */
export const planProgressOf = (todos: readonly PlanTodo[]): PlanProgress => {
  let done = 0
  const active: PlanTodo[] = []
  for (const todo of todos) {
    if (todo.status === 'completed') done += 1
    else if (todo.status === 'in_progress') active.push(todo)
  }
  return { done, total: todos.length, active, text: `${done}/${todos.length}` }
}

/** 进度条填充比例（0..1）；没有条目返回 0。 */
export const planProgressRatio = (progress: PlanProgress): number =>
  progress.total === 0 ? 0 : progress.done / progress.total

/** markdown 正文里第一个标题（1-6 级），与官方 `firstHeading()` 同一规则。 */
export const firstPlanHeading = (plan: string): string | undefined => {
  for (const line of plan.split(/\r?\n/)) {
    const matched = /^#{1,6}\s+(.+?)\s*$/.exec(line)
    if (matched !== null) return matched[1]
  }
  return undefined
}

/** 工具调用参数（`ToolActivity.arguments` 是 JSON 文本，流式中途可能半截）。 */
const toolArgsOf = (item: ChatItem): unknown => {
  if (item.kind !== 'tool' || item.arguments === undefined) return undefined
  try {
    return JSON.parse(item.arguments) as unknown
  } catch {
    return undefined
  }
}

const toolNameOf = (item: ChatItem): string | undefined => {
  if (item.kind !== 'tool') return undefined
  return item.toolKey ?? item.toolName
}

/**
 * 从时间线里取**最近一次**计划正文。
 *
 * 两个来源，就近的优先：
 *   1. plan-review 提问的 `detail`（`exit_plan_mode` 提交后 Host 立刻推的那条，最准）；
 *   2. `exit_plan_mode` 工具调用的 `args.plan`（回答完卡片消失后它还在历史里）。
 *
 * 注意：计划的完整 markdown **不在任何投影里**（官方也是从调用参数/历史里派生的），
 * 所以这一项必须读时间线。
 */
export const planTextFromItems = (items: readonly ChatItem[]): PlanText | null => {
  const start = Math.max(0, items.length - TIMELINE_SCAN_LIMIT)
  for (let index = items.length - 1; index >= start; index -= 1) {
    const item = items[index]
    if (item === undefined) continue
    if (item.kind === 'question') {
      for (const question of item.questions) {
        // `intent` 是 Host 原样带过来的（`adapter.ts` 只声明了 `kind` / `approve` 两个字段，
        // 真机上还带 `callId`）—— 这里按 unknown 读，不为了多一个字段去改 adapter 的类型
        const intent = question.intent as { kind?: string; callId?: string } | undefined
        if (intent?.kind !== 'plan-review') continue
        const text = typeof question.detail === 'string' ? question.detail.trim() : ''
        if (text.length === 0) continue
        const heading = firstPlanHeading(text)
        return {
          text,
          ...(typeof intent.callId === 'string' ? { callId: intent.callId } : {}),
          ...(heading === undefined ? {} : { heading }),
        }
      }
    }
    if (toolNameOf(item) !== EXIT_PLAN_MODE_TOOL) continue
    const args = toolArgsOf(item)
    if (!isRecord(args)) continue
    const text = typeof args.plan === 'string' ? args.plan.trim() : ''
    if (text.length === 0) continue
    const heading = firstPlanHeading(text)
    return { text, ...(heading === undefined ? {} : { heading }) }
  }
  return null
}

/**
 * 兜底 todo 来源：时间线里最近一次 `todo_write` 的 `args.todos`。
 *
 * 只有在**拿不到投影**（Host 没有 `session/control`，或流打不开）时才用。
 * 语义上与投影等价（投影本身就是「最后一条 `todo/write` 快照」），只是可能落后一条。
 */
export const todosFromItems = (items: readonly ChatItem[]): PlanTodo[] | null => {
  const start = Math.max(0, items.length - TIMELINE_SCAN_LIMIT)
  for (let index = items.length - 1; index >= start; index -= 1) {
    const item = items[index]
    if (item === undefined || toolNameOf(item) !== TODO_WRITE_TOOL) continue
    const args = toolArgsOf(item)
    if (!isRecord(args)) continue
    const todos = parsePlanTodos(args.todos)
    if (todos.length > 0) return todos
  }
  return null
}

/** 两条 todo 列表是不是同一份（整表替换的投影会有大量完全相同的帧，别让它们触发重渲染）。 */
export const sameTodos = (left: readonly PlanTodo[], right: readonly PlanTodo[]): boolean => {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined || b === undefined) return false
    if (a.content !== b.content || a.status !== b.status) return false
  }
  return true
}

/* ────────────────────────────────────────────────────────────────────────
 * 三、折叠偏好（纯 UI，落 localStorage；读写都容错）
 * ──────────────────────────────────────────────────────────────────────── */

/** 用户上次是不是把进度卡收起来了（默认收起，与官方 TodoPanel 一致）。 */
export const readCollapsedPref = (): boolean => {
  try {
    const raw = globalThis.localStorage?.getItem(PLAN_PROGRESS_COLLAPSED_KEY)
    if (raw === null || raw === undefined) return true
    // 只认 `'1'` / `'0'`：别的值（老版本、手工改坏）按默认处理
    if (raw === '0') return false
    return true
  } catch {
    return true
  }
}

export const writeCollapsedPref = (collapsed: boolean): void => {
  try {
    globalThis.localStorage?.setItem(PLAN_PROGRESS_COLLAPSED_KEY, collapsed ? '1' : '0')
  } catch {
    // 存储被禁用（隐私模式 / WebView 限制）：只影响「下次打开还记不记得」，不影响当前交互
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * 四、store
 * ──────────────────────────────────────────────────────────────────────── */

/** 三态能力：`unknown` 还没连过投影流（先按「没有数据」渲染，不占位）。 */
export type PlanAccess = 'unknown' | 'available' | 'unavailable'

export interface PlanState {
  /** 当前绑定的会话（投影按它过滤；`null` = 没选会话）。 */
  sessionId: string | null
  access: PlanAccess
  /** 投影给的 todo 整表（`todosSource === 'projection'` 时是权威值）。 */
  todos: PlanTodo[]
  /** todo 是从哪来的：投影 / 时间线兜底 / 还没有。 */
  todosSource: 'projection' | 'tools' | null
  /** `plan` 投影（`null` = 这台 Host 没给 plan 键 ⇒ 不是 plan 模式）。 */
  mode: PlanModeProjection | null
  /** 计划正文（从时间线派生；与 `mode` 独立 —— 退出 plan 模式后正文还在历史里）。 */
  planText: PlanText | null
  /** 进度卡是否收起（用户说了算，落盘记忆；**不随数据自动变**）。 */
  collapsed: boolean
  /** 计划面板是否打开。 */
  panelOpen: boolean

  /** 用户点折叠/展开。 */
  setCollapsed(collapsed: boolean): void
  /** 面板开关。 */
  setPanelOpen(open: boolean): void
  /** 切会话 / 断线：清数据但**保留**折叠偏好。 */
  reset(sessionId: string | null, access?: PlanAccess): void
  /** 投喂一帧 `session/control`（测试与同步器共用）。 */
  applyControlFrame(frame: unknown): void
}

/** 内容没变就不 setState —— 整表替换的投影帧很多是重复的，避免无谓重渲染。 */
export const usePlanState = create<PlanState>((set, get) => ({
  sessionId: null,
  access: 'unknown',
  todos: [],
  todosSource: null,
  mode: null,
  planText: null,
  collapsed: readCollapsedPref(),
  panelOpen: false,

  setCollapsed: (collapsed: boolean): void => {
    if (get().collapsed === collapsed) return
    writeCollapsedPref(collapsed)
    set({ collapsed })
  },

  setPanelOpen: (open: boolean): void => {
    if (get().panelOpen === open) return
    set({ panelOpen: open })
  },

  reset: (sessionId: string | null, access: PlanAccess = 'unknown'): void => {
    // 折叠偏好不重置：那是用户的选择，跨会话/跨重连都该记住
    set({ sessionId, access, todos: [], todosSource: null, mode: null, planText: null, panelOpen: false })
  },

  applyControlFrame: (frame: unknown): void => {
    const patch = projectionPatchOf(frame, get().sessionId)
    if (patch === null) return
    const current = get()
    const nextTodos = patch.todos === undefined ? current.todos : patch.todos
    const nextSource = patch.todos === undefined ? current.todosSource : 'projection'
    const nextMode = patch.mode === undefined ? current.mode : patch.mode
    // 整表替换的投影里大量帧是完全一样的：内容相同就不 setState（不闪、不重渲染）
    if (
      sameTodos(nextTodos, current.todos) &&
      nextSource === current.todosSource &&
      samePlanMode(nextMode, current.mode)
    ) {
      return
    }
    set({
      todos: nextTodos,
      todosSource: nextSource,
      mode: nextMode,
      ...(current.access === 'available' ? {} : { access: 'available' as PlanAccess }),
    })
  },
}))

const samePlanMode = (left: PlanModeProjection | null, right: PlanModeProjection | null): boolean => {
  if (left === null || right === null) return left === right
  return left.active === right.active && left.pending === right.pending
}

/**
 * 从一帧 `session/control` 里抠出 `todos` / `plan`。
 *
 * 两种形状（协议 §2.5）：
 *   - `{type:'baseline', value:{projections:{<sessionId>:{values:{…}}}}}`
 *   - `{type:'projection', sessionId, changes:[{key,val}]}` 或 `{...key, value}`
 *
 * 返回**按会话分开**的补丁（baseline 一次给全部会话，projection 只给一个）：
 * 投影流是对整条连接共享的，切会话时不该重开流，靠这份缓存立刻换出另一份。
 */
export const projectionPatchesOf = (frame: unknown): Map<string, ProjectionPatch> | null => {
  if (!isRecord(frame)) return null
  if (frame.type === 'baseline') {
    const value = isRecord(frame.value) ? frame.value : undefined
    const projections = isRecord(value?.projections) ? value.projections : undefined
    if (projections === undefined) return null
    const out = new Map<string, ProjectionPatch>()
    for (const [sessionId, block] of Object.entries(projections)) {
      if (!isRecord(block) || !isRecord(block.values)) continue
      const patch = patchOfValues(block.values)
      if (patch !== null) out.set(sessionId, patch)
    }
    return out.size === 0 ? null : out
  }
  if (frame.type !== 'projection') return null
  const sessionId = asString(frame.sessionId)
  if (sessionId === undefined) return null
  const patch: ProjectionPatch = {}
  const accept = (key: string, value: unknown): void => {
    if (key === 'todos') patch.todos = parsePlanTodos(value)
    else if (key === 'plan') patch.mode = parsePlanMode(value)
  }
  if (Array.isArray(frame.changes)) {
    for (const change of frame.changes) {
      if (!isRecord(change) || typeof change.key !== 'string') continue
      accept(change.key, change.val)
    }
  } else if (typeof frame.key === 'string') {
    accept(frame.key, frame.value)
  }
  if (patch.todos === undefined && patch.mode === undefined) return null
  return new Map([[sessionId, patch]])
}

/** `todos` / `plan` 两个键在不在 values 里，各取各的（**不在就保持原值**，别当成空）。 */
const patchOfValues = (values: Record<string, unknown>): ProjectionPatch | null => {
  const hasTodos = Object.hasOwn(values, 'todos')
  const hasPlan = Object.hasOwn(values, 'plan')
  if (!hasTodos && !hasPlan) return null
  return {
    ...(hasTodos ? { todos: parsePlanTodos(values.todos) } : {}),
    ...(hasPlan ? { mode: parsePlanMode(values.plan) } : {}),
  }
}

/** 只取某个会话的那一份（自测与 `applyControlFrame` 用）。 */
export const projectionPatchOf = (frame: unknown, sessionId: string | null): ProjectionPatch | null => {
  if (sessionId === null) return null
  return projectionPatchesOf(frame)?.get(sessionId) ?? null
}

/* ────────────────────────────────────────────────────────────────────────
 * 五、同步器：自己开一条只读的 `session/control`
 * ──────────────────────────────────────────────────────────────────────── */

/** 注入点（自测用假实现；生产走 `lastRemoteTarget` + `registerRemoteStreamSink`）。 */
export interface PlanSyncDeps {
  target: RemoteCallTarget
  registerStreamSink: (streamId: string, onPayload: (payload: StreamEventPayload) => void) => () => void
}

interface PlanSyncHandle {
  close(): Promise<void>
}

let deps: PlanSyncDeps | null = null
let handle: PlanSyncHandle | null = null
let releaseSink: (() => void) | null = null
let opening: Promise<void> | null = null
let installed = false
let unsubscribe: (() => void) | null = null

/**
 * 按会话缓存的投影（`sessionId → {todos?, mode?}`）。
 *
 * 为什么要缓存：`session/control` 是**每连接一条**的，baseline 只在开流那一刻给一次。
 * 切会话时如果只看「最后一帧」，新会话的 todo 要等它下一次变更才出现（中间是空白）。
 * 这里把每一帧按会话收着，切过去立刻换出对应的那份 —— 与 `sessionControls.ts` 的
 * `projectionCache` 同一个思路，只是键少两个。
 *
 * 生命周期：断线（`phase` 不是 ready）时整份清掉，避免把上一代连接的值留在屏幕上。
 */
const projectionCache = new Map<string, ProjectionPatch>()

/** 测试/生产共用的绑定入口（重复调用会先释放上一代）。 */
export const bindPlanSync = (next: PlanSyncDeps): void => {
  deps = next
}

/** 释放当前流（断线时调；切会话**不**重开流，见 `projectionCache` 的说明）。 */
export const closePlanSync = (): void => {
  if (releaseSink !== null) {
    releaseSink()
    releaseSink = null
  }
  if (handle !== null) {
    const current = handle
    handle = null
    void current.close().catch(() => undefined)
  }
  opening = null
}

/** 断开全部（`store.ts` 断线时不需要它 —— 这里靠 store 的 phase 自己收）。 */
export const unbindPlanSync = (): void => {
  closePlanSync()
  deps = null
  projectionCache.clear()
  usePlanState.getState().reset(null)
}

/**
 * 投喂一帧 `session/control`（同步器与自测共用）。
 *
 * 顺序很重要：**先**按会话记进缓存（别的会话的帧也要收，切过去才有数据），
 * **再**只把当前会话的那份套到界面上。
 */
export const ingestControlFrame = (frame: unknown): void => {
  const patches = projectionPatchesOf(frame)
  if (patches === null) return
  for (const [sessionId, patch] of patches) {
    projectionCache.set(sessionId, { ...(projectionCache.get(sessionId) ?? {}), ...patch })
  }
  const state = usePlanState.getState()
  if (state.sessionId === null) return
  const cached = projectionCache.get(state.sessionId)
  if (cached === undefined) return
  usePlanState.setState({
    ...(cached.todos === undefined ? {} : { todos: cached.todos, todosSource: 'projection' as const }),
    ...(cached.mode === undefined ? {} : { mode: cached.mode }),
    access: 'available',
  })
}

/** 切会话：把缓存里那份立刻换上去（没有就保持空，等投影/兜底）。 */
const restoreCachedSession = (sessionId: string | null): void => {
  if (sessionId === null) return
  const cached = projectionCache.get(sessionId)
  if (cached === undefined) return
  usePlanState.setState({
    ...(cached.todos === undefined ? {} : { todos: cached.todos, todosSource: 'projection' as const }),
    ...(cached.mode === undefined ? {} : { mode: cached.mode }),
  })
}

/**
 * 打开投影流（单飞）。
 *
 * 打不开（Host 没有 `session/control` / 目标还没观察到 / 老连接）时把 `access` 标成
 * `unavailable`，并**回落到时间线**：`todo_write` 调用参数能给出同一份 todo。
 */
const openControlStream = async (sessionId: string | null): Promise<void> => {
  if (opening !== null) return opening
  // 已经在同一条连接上开着了：切会话不需要重开（缓存负责换数据）
  if (handle !== null) return
  if (deps === null) {
    // 生产路径：store 是唯一持有连接的地方，`lastRemoteTarget()` 是它公开的只读句柄
    const target = lastRemoteTarget()
    if (target === null) {
      usePlanState.getState().reset(sessionId, 'unknown')
      return
    }
    deps = { target, registerStreamSink: registerRemoteStreamSink }
  }
  const current = deps
  opening = (async () => {
    try {
      const stream = await current.target.openStream(CONTROL_ENDPOINT, { args: {} }, { timeoutMs: OPEN_TIMEOUT_MS })
      if (deps !== current) {
        void stream.close().catch(() => undefined)
        return
      }
      handle = stream
      releaseSink = current.registerStreamSink(stream.streamId, (payload) => {
        if (payload.type === 'closed') {
          // 流被 Host 关掉（重连 / 能力撤回）：不清空已拿到的数据，只标记能力未知，
          // 下一次 store phase 变化会重新开一条
          if (usePlanState.getState().access === 'available') {
            usePlanState.setState({ access: 'unknown' })
          }
          return
        }
        if (payload.type !== 'frame' || payload.hasValue !== true) return
        ingestControlFrame(payload.value)
      })
      usePlanState.setState({ access: 'available' })
    } catch {
      // 能力缺失 ≠ 错误：不写 store.error，标成 unavailable 让 UI 走时间线兜底
      usePlanState.setState({ access: 'unavailable' })
    } finally {
      opening = null
    }
  })()
  return opening
}

/** 会话或连接变了：该关的关、该换的换、该开的开。 */
const syncNow = (): void => {
  const state = useRemoteStore.getState()
  const sessionId = state.activeSessionId
  const ready = state.phase === 'ready'
  if (!ready || sessionId === null) {
    // 连接没了：流关掉、缓存作废（上一代连接的值不能留在屏幕上）
    closePlanSync()
    projectionCache.clear()
    usePlanState.getState().reset(sessionId, 'unknown')
    return
  }
  usePlanState.getState().reset(sessionId, 'unknown')
  restoreCachedSession(sessionId)
  void openControlStream(sessionId)
}

/**
 * 装一次同步器（幂等）：跟着 store 的 `phase` / `activeSessionId` / `items` 走。
 *
 * 为什么订阅 `items`：计划正文只在时间线里（`exit_plan_mode` 的参数），投影没有它。
 * 订阅里对 `items` 只做一次「最近 200 条」的倒扫，且**内容相同不 setState**。
 */
export const installPlanSync = (): void => {
  if (installed) return
  installed = true
  let lastItems: readonly ChatItem[] | null = null
  unsubscribe = useRemoteStore.subscribe((state, prev) => {
    if (state.phase !== prev.phase || state.activeSessionId !== prev.activeSessionId) {
      syncNow()
      lastItems = state.items
      updateFromTimeline(state.items, true)
      return
    }
    if (state.items !== lastItems) {
      lastItems = state.items
      updateFromTimeline(state.items, false)
    }
  })
  syncNow()
  updateFromTimeline(useRemoteStore.getState().items, true)
}

/** 拆掉同步器（只给自测用；线上不需要）。 */
export const uninstallPlanSync = (): void => {
  if (unsubscribe !== null) {
    unsubscribe()
    unsubscribe = null
  }
  installed = false
  unbindPlanSync()
}

/**
 * 用时间线刷新两件事：
 *   - 计划正文（投影里没有，只能这里拿）；
 *   - **投影不可用时的 todo 兜底**。
 *
 * `force` = 刚切会话/刚连上，即使内容没变也要重算一次。
 */
const updateFromTimeline = (items: readonly ChatItem[], force: boolean): void => {
  const state = usePlanState.getState()
  const planText = planTextFromItems(items)
  const samePlan =
    (planText === null && state.planText === null) ||
    (planText !== null && state.planText !== null && planText.text === state.planText.text && planText.callId === state.planText.callId)
  const patch: Partial<PlanState> = {}
  if (!samePlan || force) patch.planText = planText
  // 只有明确「这台 Host 没有投影」时才用时间线兜底；`unknown` 阶段先等投影，
  // 免得刚进会话时先闪一版粗的再被投影纠正
  if (state.todosSource !== 'projection' && state.access === 'unavailable') {
    const fallback = todosFromItems(items)
    const nextTodos = fallback ?? []
    const nextSource = fallback === null ? null : 'tools'
    if (!sameTodos(nextTodos, state.todos) || nextSource !== state.todosSource) {
      patch.todos = nextTodos
      patch.todosSource = nextSource
    }
  }
  if (Object.keys(patch).length > 0) usePlanState.setState(patch)
}

/* ────────────────────────────────────────────────────────────────────────
 * 六、只读选择器（UI 用，避免组件里重复写判断）
 * ──────────────────────────────────────────────────────────────────────── */

/** 进度卡该不该渲染：**没有 todo 就整块不渲染**（不占位）。 */
export const showsPlanProgress = (state: PlanState): boolean => state.todos.length > 0

/** 「查看计划」入口该不该渲染：只在 plan 模式下出现。 */
export const showsPlanEntry = (state: PlanState): boolean => planModeActive(state.mode)

/** 顶部那条固定带要不要占位置：两者都没有就什么都不画。 */
export const showsPlanDock = (state: PlanState): boolean =>
  showsPlanProgress(state) || showsPlanEntry(state)

/** 进行中的那条的文案（折叠态「正在做：xxx」用它）。 */
export const activePlanTodo = (todos: readonly PlanTodo[]): PlanTodo | null =>
  todos.find((todo) => todo.status === 'in_progress') ?? null
