/**
 * 任务进度与计划（R11）自测：数据来源解析 / 进度派生 / 折叠记忆 / 无数据不渲染 / plan 模式判定。
 *
 * 跑法（workdir = projects\deepseek-tablet\web）：
 *   npx tsx src/services/remote/__selftest__/planState.selftest.mts
 *
 * 覆盖（对应任务书四条自测要求）：
 *   A. 投影解析（数据从哪来）
 *     1. `baseline` 帧：`values.todos` + `values.plan` 一起抠出来；
 *     2. `projection` 帧的两种形状（`changes[]` / `key+value`）；
 *     3. 别的会话的投影帧一律忽略；`todos` 为 `null` → 空列表（官方「首次写入前是 null」）；
 *     4. 形状不对的 todo 行（缺 content / 空 content / 非对象）丢掉；
 *     5. 别名容忍（`title` / `done` / `running`）与严格值一致；
 *     6. 同一个 key 的重复帧（内容相同）不触发 setState（`sameTodos` 的等价判据）。
 *   B. plan 模式判定
 *     7. `{active:true,pending:false}` → 激活；`{active:false,...}` → 不激活；
 *     8. `pending:true` 时有效目标是 `!active`（官方徽章判据，两个方向都摆）；
 *     9. `plan` 键缺失 / 不是对象 / `active` 不是布尔 → 一律「未激活」（不猜）。
 *   C. 进度派生（纯函数，逐条摆过）
 *    10. 3/7 的完成数、进行中条目、`text` 格式；
 *    11. 全完成 / 全待办两种边界的折叠态文案分支；
 *    12. 进度条比例（0 / 1 / 中间值，总数为 0 时不除零）。
 *   D. 计划正文（只在时间线里，投影没有）
 *    13. plan-review 提问的 `detail` 优先（比工具调用更靠近末尾）；
 *    14. 只有 `exit_plan_mode` 工具调用时用它（`args.plan`，JSON 半截也要扛住）；
 *    15. 两者都没有 → `null`（**不编内容**）；
 *    16. 首个 markdown 标题（`firstHeading` 规则：任意级别、取第一行）。
 *   E. 折叠记忆（用户收起就别自动展开）
 *    17. 默认收起；`setCollapsed(false)` 落盘；新 todo 到达**不会**改动折叠值；
 *    18. `reset()`（切会话 / 重连）保留折叠偏好，只清数据。
 *   F. 无数据不渲染 / 门禁
 *    19. 没有 todo → `showsPlanProgress` false；没有 plan 投影 → `showsPlanEntry` false；
 *    20. 两者都没有 → `showsPlanDock` false（整块不占位）；
 *    21. 投影不可用时用 `todo_write` 工具参数兜底，且不覆盖投影来源。
 *   G. 同步器（真开一条流）
 *    22. `bindPlanSync` + `installPlanSync` 会 openStream `session/control` 并收帧；
 *    23. 断线（`phase` 不是 ready）→ 关流 + 数据清空 + 折叠偏好还在。
 *
 * 结尾按仓库约定设置真实退出码（`process.exit(failures === 0 ? 0 : 1)`）。
 */

import type { ChatItem } from '../adapter.js'
import type { StreamEventPayload } from '../core/index.js'
import type { RemoteCallTarget, RemoteStreamHandle } from '../sessionsApi.js'
import {
  PLAN_PROGRESS_COLLAPSED_KEY,
  activePlanTodo,
  bindPlanSync,
  closePlanSync,
  firstPlanHeading,
  installPlanSync,
  parsePlanMode,
  parsePlanTodos,
  planModeActive,
  planModeTarget,
  planProgressOf,
  planProgressRatio,
  planTextFromItems,
  readCollapsedPref,
  sameTodos,
  showsPlanDock,
  showsPlanEntry,
  showsPlanProgress,
  todosFromItems,
  uninstallPlanSync,
  usePlanState,
} from '../planState.js'
import { useRemoteStore } from '../store.js'

/* ── 最小断言器（与其它 selftest 同一套写法） ─────────────────────────── */

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

const assertTrue = (value: unknown, label: string): void => {
  if (value !== true) fail(`${label}：期望 true，实际 ${JSON.stringify(value)}`)
}

const assertFalse = (value: unknown, label: string): void => {
  if (value !== false) fail(`${label}：期望 false，实际 ${JSON.stringify(value)}`)
}

/* ── localStorage 垫片（node 里没有；planState 的读写都要能容错） ───────── */

class MemoryStorage {
  private readonly map = new Map<string, string>()

  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }

  removeItem(key: string): void {
    this.map.delete(key)
  }
}

const storage = new MemoryStorage()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })

/* ── 测试夹具 ─────────────────────────────────────────────────────────── */

const SESSION = 'session-1'
const OTHER = 'session-2'

const resetPlan = (sessionId: string | null = SESSION): void => {
  usePlanState.getState().reset(sessionId)
}

const baselineFrame = (values: Record<string, unknown>, sessionId = SESSION): unknown => ({
  type: 'baseline',
  value: { projections: { [sessionId]: { asOfSeq: 12, values } } },
})

const todosOf = (): Array<{ content: string; status: string }> =>
  usePlanState.getState().todos.map((todo) => ({ content: todo.content, status: todo.status }))

/** 一条 `exit_plan_mode` 工具调用（`arguments` 是 JSON 文本，与真机一致）。 */
const exitToolItem = (plan: string, id = 'tool-exit'): ChatItem => ({
  kind: 'tool',
  id,
  sessionId: SESSION,
  createdAt: 1,
  toolName: 'ExitPlanMode',
  toolKey: 'exit_plan_mode',
  arguments: JSON.stringify({ plan }),
  state: 'finished',
})

/** 一条 plan-review 提问（`detail` 就是计划正文，`intent` 标记这是计划评审）。 */
const planReviewItem = (plan: string, callId = 'call-1'): ChatItem => ({
  kind: 'question',
  id: 'question:plan-review',
  sessionId: SESSION,
  createdAt: 2,
  callId,
  questions: [
    {
      id: 'plan-review',
      question: 'Approve this plan and leave plan mode?',
      header: 'Plan review',
      detail: plan,
      options: [{ label: 'Approve' }, { label: 'Keep planning' }],
      intent: { kind: 'plan-review', approve: 'Approve', callId },
    } as never,
  ],
})

/** 一条 `todo_write` 工具调用（兜底路径）。 */
const todoWriteItem = (todos: unknown[], id = 'tool-todo'): ChatItem => ({
  kind: 'tool',
  id,
  sessionId: SESSION,
  createdAt: 3,
  toolName: 'TodoWrite',
  toolKey: 'todo_write',
  arguments: JSON.stringify({ todos }),
  state: 'finished',
})

/* ── A. 投影解析 ─────────────────────────────────────────────────────── */

check('1. baseline 帧一次抠出 todos + plan', async () => {
  resetPlan()
  usePlanState.getState().applyControlFrame(
    baselineFrame({
      title: '示例会话',
      todos: [
        { content: '读协议', status: 'completed' },
        { content: '改输入区', status: 'in_progress' },
        { content: '补截图', status: 'pending' },
      ],
      plan: { active: true, pending: false },
    }),
  )
  assertEqual(todosOf(), [
    { content: '读协议', status: 'completed' },
    { content: '改输入区', status: 'in_progress' },
    { content: '补截图', status: 'pending' },
  ], 'baseline 的 todos')
  assertEqual(usePlanState.getState().mode, { active: true, pending: false }, 'baseline 的 plan')
  assertEqual(usePlanState.getState().access, 'available', '拿到投影后能力可用')
  assertEqual(usePlanState.getState().todosSource, 'projection', '来源应标成 projection')
})

check('2. projection 帧的两种形状', async () => {
  resetPlan()
  usePlanState.getState().applyControlFrame({
    type: 'projection',
    sessionId: SESSION,
    seq: 13,
    changes: [{ key: 'todos', val: [{ content: 'A', status: 'pending' }] }],
  })
  assertEqual(todosOf(), [{ content: 'A', status: 'pending' }], 'changes[] 形状')
  usePlanState.getState().applyControlFrame({
    type: 'projection',
    sessionId: SESSION,
    seq: 14,
    key: 'todos',
    value: [{ content: 'B', status: 'completed' }],
  })
  assertEqual(todosOf(), [{ content: 'B', status: 'completed' }], 'key+value 形状（整表替换）')
  usePlanState.getState().applyControlFrame({
    type: 'projection',
    sessionId: SESSION,
    seq: 15,
    key: 'plan',
    value: { active: false, pending: true },
  })
  assertEqual(usePlanState.getState().mode, { active: false, pending: true }, 'plan 键单独更新')
})

check('3. 别的会话 / todos:null', async () => {
  resetPlan()
  usePlanState.getState().applyControlFrame(baselineFrame({ todos: [{ content: 'X', status: 'pending' }] }, OTHER))
  assertEqual(usePlanState.getState().todos, [], '别的会话的 baseline 不该进来')
  assertEqual(usePlanState.getState().access, 'unknown', '没命中就还是 unknown')

  usePlanState.getState().applyControlFrame({
    type: 'projection',
    sessionId: OTHER,
    seq: 1,
    key: 'todos',
    value: [{ content: 'Y', status: 'pending' }],
  })
  assertEqual(usePlanState.getState().todos, [], '别的会话的 projection 帧不该进来')

  usePlanState.getState().applyControlFrame({
    type: 'projection',
    sessionId: SESSION,
    seq: 2,
    key: 'todos',
    value: null,
  })
  assertEqual(usePlanState.getState().todos, [], '官方「首次写入前是 null」→ 空列表')
})

check('4. 形状不对的 todo 行丢掉', async () => {
  assertEqual(
    parsePlanTodos([
      { content: '好的一行', status: 'completed' },
      { content: '', status: 'pending' },
      { content: '   ', status: 'pending' },
      { status: 'pending' },
      null,
      'string',
      { content: '状态不认识', status: 'weird' },
    ]),
    [
      { content: '好的一行', status: 'completed' },
      { content: '状态不认识', status: 'pending' },
    ],
    '空 content / 缺 content / 非对象都丢掉，未知状态按 pending',
  )
  assertEqual(parsePlanTodos('not-an-array'), [], '不是数组 → 空')
})

check('5. 别名容忍（title / done / running）', async () => {
  assertEqual(
    parsePlanTodos([
      { title: '用 title 当内容', status: 'done' },
      { label: '用 label 当内容', status: 'running' },
      { content: ' 前后空格要 trim ', status: 'inProgress' },
    ]),
    [
      { content: '用 title 当内容', status: 'completed' },
      { content: '用 label 当内容', status: 'in_progress' },
      { content: '前后空格要 trim', status: 'in_progress' },
    ],
    'ACP 后端的别名与官方值等价',
  )
})

check('6. 内容相同不触发 setState', async () => {
  resetPlan()
  const frame = baselineFrame({
    todos: [{ content: '读协议', status: 'completed' }],
    plan: { active: true, pending: false },
  })
  usePlanState.getState().applyControlFrame(frame)
  const before = usePlanState.getState()
  // 触发一次订阅计数：`set` 会换掉 state 对象，没换就说明没 setState
  let notifications = 0
  const unsubscribe = usePlanState.subscribe(() => {
    notifications += 1
  })
  for (let index = 0; index < 5; index += 1) {
    usePlanState.getState().applyControlFrame(
      baselineFrame({ todos: [{ content: '读协议', status: 'completed' }], plan: { active: true, pending: false } }),
    )
  }
  unsubscribe()
  assertEqual(notifications, 0, '重复的相同帧不该触发 5 次 setState')
  assertTrue(usePlanState.getState() === before, '状态对象原地不动')
  assertTrue(sameTodos(usePlanState.getState().todos, [{ content: '读协议', status: 'completed' }]), 'sameTodos 判等')
  assertFalse(sameTodos([{ content: 'a', status: 'pending' }], [{ content: 'a', status: 'completed' }]), '状态不同不算同')
  assertFalse(sameTodos([{ content: 'a', status: 'pending' }], []), '长度不同不算同')
})

/* ── B. plan 模式判定 ───────────────────────────────────────────────── */

check('7. active 直接映射', async () => {
  assertTrue(planModeActive({ active: true, pending: false }), 'active:true → 激活')
  assertFalse(planModeActive({ active: false, pending: false }), 'active:false → 不激活')
  assertTrue(planModeTarget({ active: true, pending: false }), '目标态同 active')
  assertFalse(planModeTarget({ active: false, pending: false }), '目标态同 active（false）')
})

check('8. pending 时有效目标是取反（官方徽章判据）', async () => {
  assertTrue(planModeActive({ active: false, pending: true }), 'pending 进入：目标 = true')
  assertFalse(planModeActive({ active: true, pending: true }), 'pending 退出：目标 = false')
  assertTrue(planModeTarget({ active: false, pending: true }), 'planModeTarget 进入')
  assertFalse(planModeTarget({ active: true, pending: true }), 'planModeTarget 退出')
})

check('9. plan 键缺失 / 形状不对 → 一律未激活', async () => {
  resetPlan()
  assertEqual(usePlanState.getState().mode, null, '没有投影时是 null')
  assertFalse(planModeActive(null), 'null → 不激活')
  assertFalse(planModeActive(parsePlanMode({ active: 'yes', pending: false })), 'active 不是布尔 → null → 不激活')
  assertEqual(parsePlanMode({ active: true }), { active: true, pending: false }, '缺 pending 按 false')
  assertEqual(parsePlanMode(null), null, 'null 输入')
  assertEqual(parsePlanMode('x'), null, '字符串输入')
  assertEqual(parsePlanMode({}), null, '缺 active')
})

/* ── C. 进度派生 ────────────────────────────────────────────────────── */

const SEVEN = parsePlanTodos([
  { content: '读协议', status: 'completed' },
  { content: '定契约', status: 'completed' },
  { content: '改输入区', status: 'in_progress' },
  { content: '进度卡', status: 'pending' },
  { content: '计划面板', status: 'pending' },
  { content: '自测', status: 'pending' },
  { content: '截图', status: 'pending' },
])

check('10. 3/7 的完成数 / 进行中 / 文案', async () => {
  const progress = planProgressOf(SEVEN)
  assertEqual(progress.done, 2, '完成数')
  assertEqual(progress.total, 7, '总数')
  assertEqual(progress.text, '2/7', '折叠态计数文案')
  assertEqual(progress.active.map((todo) => todo.content), ['改输入区'], '进行中的条目')
  assertEqual(activePlanTodo(SEVEN)?.content, '改输入区', 'activePlanTodo 拿第一条')
})

check('11. 全完成 / 全待办 的边界', async () => {
  const allDone = planProgressOf(parsePlanTodos([
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'completed' },
  ]))
  assertEqual([allDone.done, allDone.total, allDone.text], [2, 2, '2/2'], '全完成')
  assertEqual(allDone.active, [], '全完成时没有进行中条目')

  const idle = planProgressOf(parsePlanTodos([{ content: 'a', status: 'pending' }]))
  assertEqual([idle.done, idle.total, idle.text], [0, 1, '0/1'], '全待办')
  assertEqual(activePlanTodo([{ content: 'a', status: 'pending' }]), null, '没有进行中 → null（折叠态说「等待开始」）')
})

check('12. 进度条比例（不除零）', async () => {
  assertEqual(planProgressRatio(planProgressOf([])), 0, '空列表 → 0')
  assertEqual(planProgressRatio(planProgressOf([{ content: 'a', status: 'completed' }])), 1, '1/1 → 1')
  assertEqual(planProgressRatio(planProgressOf(SEVEN)), 2 / 7, '2/7 → 2/7')
})

/* ── D. 计划正文 ───────────────────────────────────────────────────── */

const PLAN_MD = ['# 把任务进度显示出来', '', '## 步骤', '', '1. 读投影', '2. 画卡片'].join('\n')

check('13. plan-review 提问的 detail 优先', async () => {
  const fromQuestion = planTextFromItems([exitToolItem(PLAN_MD), planReviewItem(PLAN_MD, 'call-9')])
  assertEqual(fromQuestion?.text, PLAN_MD, '正文一致')
  assertEqual(fromQuestion?.callId, 'call-9', 'callId 来自 intent')
  assertEqual(fromQuestion?.heading, '把任务进度显示出来', '首个标题')
})

check('14. 只有 exit_plan_mode 调用时用 args.plan（含半截 JSON）', async () => {
  const fromTool = planTextFromItems([exitToolItem(PLAN_MD)])
  assertEqual(fromTool?.text, PLAN_MD, '从工具参数拿到正文')
  assertEqual(fromTool?.callId, undefined, '没有 callId')
  // 流式中途的半截 JSON 不能抛
  const broken: ChatItem = {
    kind: 'tool',
    id: 'tool-broken',
    sessionId: SESSION,
    createdAt: 4,
    toolName: 'ExitPlanMode',
    toolKey: 'exit_plan_mode',
    arguments: '{"plan":"# 半截',
    state: 'running',
  }
  assertEqual(planTextFromItems([broken]), null, '半截 JSON → null，不抛')
})

check('15. 都没有 → null（不编内容）', async () => {
  assertEqual(planTextFromItems([]), null, '空时间线')
  assertEqual(planTextFromItems([todoWriteItem([{ content: 'a', status: 'pending' }])]), null, '只有 todo_write 时没有计划正文')
  // plan-review 但 detail 是空串：也不能当成正文
  const emptyDetail = planReviewItem('')
  assertEqual(planTextFromItems([emptyDetail]), null, 'detail 空串 → null')
})

check('16. 首个 markdown 标题', async () => {
  assertEqual(firstPlanHeading('# 一\n## 二'), '一', '取第一个')
  assertEqual(firstPlanHeading('前言\n\n### 三 级 标 题\n# 后面'), '三 级 标 题', '任意级别都算')
  assertEqual(firstPlanHeading('#'), undefined, '空标题不算')
  assertEqual(firstPlanHeading('没有标题\n正文'), undefined, '没有标题')
})

/* ── E. 折叠记忆 ───────────────────────────────────────────────────── */

check('17. 默认收起 / 用户展开后落盘 / 新 todo 不自动改', async () => {
  storage.removeItem(PLAN_PROGRESS_COLLAPSED_KEY)
  assertTrue(readCollapsedPref(), '默认收起（与官方 TodoPanel 一致）')
  resetPlan()
  usePlanState.setState({ collapsed: true })
  usePlanState.getState().setCollapsed(false)
  assertFalse(usePlanState.getState().collapsed, '用户展开生效')
  assertEqual(storage.getItem(PLAN_PROGRESS_COLLAPSED_KEY), '0', '展开落盘为 0')

  // 新 todo 到达：折叠值不能被改
  usePlanState.getState().applyControlFrame(
    baselineFrame({ todos: [{ content: '新任务', status: 'in_progress' }] }),
  )
  assertFalse(usePlanState.getState().collapsed, '新数据不该自动折叠/展开')

  usePlanState.getState().setCollapsed(true)
  assertEqual(storage.getItem(PLAN_PROGRESS_COLLAPSED_KEY), '1', '收起落盘为 1')
  // 手工改坏的值按默认（收起）处理
  storage.setItem(PLAN_PROGRESS_COLLAPSED_KEY, 'yes-please')
  assertTrue(readCollapsedPref(), '非法值 → 默认收起')
  storage.removeItem(PLAN_PROGRESS_COLLAPSED_KEY)
})

check('18. reset() 保留折叠偏好、只清数据', async () => {
  storage.removeItem(PLAN_PROGRESS_COLLAPSED_KEY)
  usePlanState.getState().setCollapsed(false)
  usePlanState.getState().applyControlFrame(
    baselineFrame({ todos: [{ content: 'a', status: 'pending' }], plan: { active: true, pending: false } }),
  )
  usePlanState.getState().reset(OTHER)
  assertFalse(usePlanState.getState().collapsed, '折叠偏好还在')
  assertEqual(usePlanState.getState().todos, [], 'todo 清空')
  assertEqual(usePlanState.getState().mode, null, 'plan 清了')
  assertEqual(usePlanState.getState().sessionId, OTHER, '会话换成新的')
  assertFalse(usePlanState.getState().panelOpen, '面板关掉')
  storage.removeItem(PLAN_PROGRESS_COLLAPSED_KEY)
})

/* ── F. 无数据不渲染 / 门禁 ─────────────────────────────────────────── */

check('19. 没有 todo / 没有 plan 投影 → 都不出现', async () => {
  resetPlan()
  assertFalse(showsPlanProgress(usePlanState.getState()), '没有 todo → 进度卡渲染 false')
  assertFalse(showsPlanEntry(usePlanState.getState()), '没有 plan 投影 → 入口 false')
  assertFalse(showsPlanDock(usePlanState.getState()), '两者都没有 → 整块不占位')
})

check('20. 只有其中一样时也各管各的', async () => {
  resetPlan()
  usePlanState.getState().applyControlFrame(baselineFrame({ todos: [{ content: 'a', status: 'pending' }] }))
  assertTrue(showsPlanProgress(usePlanState.getState()), '有 todo → 进度卡出现')
  assertFalse(showsPlanEntry(usePlanState.getState()), 'plan 未激活 → 入口不出现')
  assertTrue(showsPlanDock(usePlanState.getState()), '有一半就占位')

  resetPlan()
  usePlanState.getState().applyControlFrame(baselineFrame({ plan: { active: true, pending: false } }))
  assertFalse(showsPlanProgress(usePlanState.getState()), '没有 todo → 进度卡不出现')
  assertTrue(showsPlanEntry(usePlanState.getState()), 'plan 激活 → 入口出现')
  assertTrue(showsPlanDock(usePlanState.getState()), '有一半就占位')
})

check('21. 投影不可用 → todo_write 兜底，且不覆盖投影来源', async () => {
  resetPlan(SESSION)
  const items = [todoWriteItem([
    { content: '从工具参数来', status: 'completed' },
    { content: '第二条', status: 'in_progress' },
  ])]
  assertEqual(
    todosFromItems(items)?.map((todo) => todo.content),
    ['从工具参数来', '第二条'],
    '从 todo_write 参数派生',
  )
  assertEqual(todosFromItems([]), null, '没有 todo_write → null')
  // 多条 todo_write 时取最近的一条（列表末尾优先）
  assertEqual(
    todosFromItems([todoWriteItem([{ content: '旧的', status: 'pending' }], 'tool-old'), todoWriteItem([{ content: '新的', status: 'completed' }], 'tool-new')])?.[0]?.content,
    '新的',
    '取最近一条',
  )
})

/* ── G. 同步器（真开一条 session/control） ──────────────────────────── */

check('22. 开 session/control 并收帧', async () => {
  resetPlan(SESSION)
  const sinks: Array<(payload: StreamEventPayload) => void> = []
  const opened: Array<{ endpoint: string; payload: unknown }> = []
  let closed = 0
  const target: RemoteCallTarget = {
    async rpc<T>(): Promise<T> {
      return undefined as T
    },
    async openStream(endpoint, payload): Promise<RemoteStreamHandle> {
      opened.push({ endpoint, payload })
      return {
        streamId: 'control-1',
        async close() {
          closed += 1
        },
      }
    },
  }
  bindPlanSync({
    target,
    registerStreamSink: (_streamId, onPayload) => {
      sinks.push(onPayload)
      return () => undefined
    },
  })
  // 让 store 处于「已连接 + 选中了这个会话」，同步器才会开流
  useRemoteStore.setState({ phase: 'ready', activeSessionId: SESSION })
  installPlanSync()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assertEqual(opened.length, 1, '开了一条流')
  assertEqual(opened[0]?.endpoint, 'session/control', '端点是 session/control')
  assertEqual(opened[0]?.payload, { args: {} }, 'args 形状与 store 一致')
  assertEqual(sinks.length, 1, '注册了一个接收器')

  sinks[0]?.({
    type: 'frame',
    hasValue: true,
    value: baselineFrame({
      todos: [{ content: '同步器收到的', status: 'completed' }],
      plan: { active: true, pending: false },
    }),
  })
  assertEqual(todosOf(), [{ content: '同步器收到的', status: 'completed' }], '帧进了 store')
  assertTrue(planModeActive(usePlanState.getState().mode), 'plan 也同步了')
  closePlanSync()
  uninstallPlanSync()
})

check('23. 断线 → 数据清空、折叠偏好保留、流关掉', async () => {  const sinks: Array<(payload: StreamEventPayload) => void> = []
  let closed = 0
  bindPlanSync({
    target: {
      async rpc<T>(): Promise<T> {
        return undefined as T
      },
      async openStream(): Promise<RemoteStreamHandle> {
        return {
          streamId: 'control-2',
          async close() {
            closed += 1
          },
        }
      },
    },
    registerStreamSink: (_streamId, onPayload) => {
      sinks.push(onPayload)
      return () => undefined
    },
  })
  useRemoteStore.setState({ phase: 'ready', activeSessionId: SESSION })
  installPlanSync()
  await new Promise((resolve) => setTimeout(resolve, 30))
  sinks[0]?.({
    type: 'frame',
    hasValue: true,
    value: baselineFrame({ todos: [{ content: '断线前', status: 'in_progress' }] }),
  })
  assertEqual(usePlanState.getState().todos.length, 1, '断线前有数据')
  usePlanState.getState().setCollapsed(false)

  // 模拟断线：phase 不再是 ready
  useRemoteStore.setState({ phase: 'error' })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assertEqual(usePlanState.getState().todos, [], '断线清空 todo')
  assertEqual(usePlanState.getState().mode, null, '断线清空 plan')
  assertFalse(usePlanState.getState().collapsed, '折叠偏好保留（用户的选择不因断线丢失）')
  assertTrue(closed >= 1, '断线把流关掉了')
  uninstallPlanSync()
  useRemoteStore.setState({ phase: 'idle', activeSessionId: null })
  storage.removeItem(PLAN_PROGRESS_COLLAPSED_KEY)
})

check('24. 切会话：立刻换出缓存那份，且不重开流', async () => {
  storage.removeItem(PLAN_PROGRESS_COLLAPSED_KEY)
  const sinks: Array<(payload: StreamEventPayload) => void> = []
  let opened = 0
  bindPlanSync({
    target: {
      async rpc<T>(): Promise<T> {
        return undefined as T
      },
      async openStream(): Promise<RemoteStreamHandle> {
        opened += 1
        return { streamId: `control-${opened}`, async close() {} }
      },
    },
    registerStreamSink: (_streamId, onPayload) => {
      sinks.push(onPayload)
      return () => undefined
    },
  })
  usePlanState.getState().reset(SESSION, 'unknown')
  useRemoteStore.setState({ phase: 'ready', activeSessionId: SESSION })
  installPlanSync()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assertEqual(opened, 1, '只开了一条流（连接级，不是会话级）')

  // 一条 baseline 里同时带两个会话：第二个会话的数据也该进缓存
  sinks[0]?.({
    type: 'frame',
    hasValue: true,
    value: {
      type: 'baseline',
      value: {
        projections: {
          [SESSION]: { values: { todos: [{ content: '会话一的任务', status: 'in_progress' }], plan: { active: true, pending: false } } },
          [OTHER]: { values: { todos: [{ content: '会话二的任务', status: 'completed' }] } },
        },
      },
    },
  })
  assertEqual(todosOf().map((todo) => todo.content), ['会话一的任务'], '当前会话是会话一')
  assertTrue(planModeActive(usePlanState.getState().mode), '会话一在 plan 模式')

  // 切到会话二：不重开流，数据立刻换成缓存里的那份
  useRemoteStore.setState({ activeSessionId: OTHER })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assertEqual(opened, 1, '切会话不重开流')
  assertEqual(todosOf().map((todo) => todo.content), ['会话二的任务'], '切过去立刻有数据（不用等下一帧）')
  assertFalse(planModeActive(usePlanState.getState().mode), '会话二没有 plan 投影 → 未激活')

  // 切回会话一：还是从缓存换回来
  useRemoteStore.setState({ activeSessionId: SESSION })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assertEqual(todosOf().map((todo) => todo.content), ['会话一的任务'], '切回来也对')
  assertTrue(planModeActive(usePlanState.getState().mode), '会话一的 plan 状态也回来了')

  uninstallPlanSync()
  useRemoteStore.setState({ phase: 'idle', activeSessionId: null })
  storage.removeItem(PLAN_PROGRESS_COLLAPSED_KEY)
})

/* ── 跑完所有检查 ───────────────────────────────────────────────────── */
let failures = 0
for (const item of checks) {
  try {
    await item.run()
    console.log(`[PASS] ${item.name}`)
  } catch (error) {
    failures += 1
    console.log(`[FAIL] ${item.name}`)
    console.log(`       ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log('')
console.log(`${failures === 0 ? '[PASS]' : '[FAIL]'} planState.selftest — ${checks.length - failures}/${checks.length} 通过`)
process.exit(failures === 0 ? 0 : 1)
