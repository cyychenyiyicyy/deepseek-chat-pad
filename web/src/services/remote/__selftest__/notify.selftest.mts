/**
 * 通知中心（R6）自测：`notify.ts` 的合并/去重/重试/降级/裁剪，`store.ts` 的状态映射与
 * 桥的生命周期（ready 才推、断开清整组、done 30s 清理、切会话清上一条、回前台不清）。
 *
 * 跑法（workdir = projects\deepseek-tablet\web）：
 *   npx tsx src/services/remote/__selftest__/notify.selftest.mts
 *
 * 覆盖清单：
 *   A. notify.ts（每个用例一个独立实例，注入 fetch / 小窗口定时器）
 *     1. 去抖合并：窗口内 3 次调用 → 1 次 POST，载荷以最后一次为准，3 个 promise 都 resolve；
 *     2. 浅比较：同样的载荷再推 → 不再 POST；
 *     3. 内容变了（工具名）→ 再 POST；
 *     4. 失败重试 2 次（共 3 次尝试）后静默，promise 不 reject；一直失败也不抛；
 *     5. POST 404 → 整块降级：之后的 push 一个请求都不打；
 *     6. 探测：404 / 200+HTML → `supported:false`；200 JSON → supported/granted/posted；
 *     7. 隐私裁剪：脏字段（text/output/arguments）被白名单丢掉、单行截断、非法 state 丢弃、
 *        items 上限 24、activeSessionId 透传；
 *     8. clearWork 的请求体形状（带/不带 sessionId）；
 *     9. reset() 丢掉还没发的合并帧。
 *   B. store.ts 的纯函数
 *    10. 审批 → approval（工具名 + 一句话，不带 reason 原文）；
 *    11. 流式但没工具 → running + 「正在回复…」；
 *    12. 工具名 + 路径摘要 → 「读取 README.md」；命令行摘要**不**进 tool；
 *    13. 一轮结束（seeing running）→ done；没跑过（打开历史）→ null；
 *    14. turnEnd 失败 → error；
 *    15. 快照拼装：approval 最前、其余按活动时间倒序、activeSessionId、24 条上限、空 → null。
 *   C. store 集成（真 store + 真单例 notifier + 假 fetch/document/30s 定时器）
 *    16. phase=ready + 进行中 → 一帧含活动会话（running / 工具短名）；
 *    17. 别的会话 status=running → 进快照（按活动时间排序）；
 *    18. 一轮结束 → done 帧 + 30s 定时器；到点 → `clearWork(sessionId)`，且之后快照里不再有它；
 *    19. `visibilitychange → visible` **不**清通知（只补推，内容没变则不重复发）；
 *    20. 断开（phase 离开 ready）→ `clearWork()`（整组，不带 sessionId）。
 *
 * 不联网：所有 fetch 都是桩；localStorage 用内存实现；30s 定时器被截获后手动触发。
 */

import type { FetchLike } from '../serverApi.js'

/* ── 最小断言器（与其它 selftest 同一套写法） ─────────────────────────── */

const checks: Array<{ name: string; run: () => Promise<void> | void }> = []
const check = (name: string, run: () => Promise<void> | void): void => {
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

const assertTrue = (value: boolean, label: string): void => {
  if (!value) fail(label)
}

const assertContains = (haystack: string, needle: string, label: string): void => {
  if (!haystack.includes(needle)) fail(`${label}：${JSON.stringify(haystack)} 里没有 ${JSON.stringify(needle)}`)
}

const assertAbsent = (haystack: string, needle: string, label: string): void => {
  if (haystack.includes(needle)) fail(`${label}：${JSON.stringify(haystack)} 里不该出现 ${JSON.stringify(needle)}`)
}

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

const objectOf = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(`不是一个对象：${JSON.stringify(value)}`)
  }
  return value as Record<string, unknown>
}

const itemsOf = (body: Record<string, unknown>): Record<string, unknown>[] => {
  const items = body.items
  if (!Array.isArray(items)) return fail('body.items 不是数组')
  return (items as unknown[]).map(item => objectOf(item))
}

/* ── 被 import 的模块（顺序很重要：先装全局再加载 store） ─────────────── */

const notifyModule = await import('../notify.js')
const { createWorkNotifier, normalizeWorkPush, sameWorkPush, NOTIFY_MAX_ITEMS, NOTIFY_DEBOUNCE_MS } = notifyModule
type WorkItem = import('../notify.js').WorkItem
type WorkPush = import('../notify.js').WorkPush

/* ── 内存版 localStorage（store.ts 在模块初始化时会读一次） ───────────── */

const memory = new Map<string, string>()
const localStorageStub = {
  getItem: (key: string): string | null => memory.get(key) ?? null,
  setItem: (key: string, value: string): void => {
    memory.set(key, String(value))
  },
  removeItem: (key: string): void => {
    memory.delete(key)
  },
  clear: (): void => memory.clear(),
  key: (index: number): string | null => [...memory.keys()][index] ?? null,
  get length(): number {
    return memory.size
  },
}
;(globalThis as unknown as Record<string, unknown>).localStorage = localStorageStub

/* ── 假 document：只用来验证 visibilitychange 的回前台行为 ─────────────── */

const visibilityHandlers = new Set<() => void>()
let visibilityDispatches = 0
const fakeDocument = {
  visibilityState: 'visible',
  addEventListener: (type: string, handler: () => void): void => {
    if (type === 'visibilitychange') visibilityHandlers.add(handler)
  },
  removeEventListener: (type: string, handler: () => void): void => {
    if (type === 'visibilitychange') visibilityHandlers.delete(handler)
  },
}
;(globalThis as unknown as Record<string, unknown>).document = fakeDocument

const dispatchVisibility = (): void => {
  visibilityDispatches += 1
  for (const handler of [...visibilityHandlers]) handler()
}

/* ── 截获 30s 定时器（`done` 通知的自动清理），其余定时器照常 ──────────── */

const longTimers: Array<() => void> = []
const realSetTimeout = globalThis.setTimeout.bind(globalThis)
const captureLong = 30_000
;(globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
  handler: (...args: unknown[]) => void,
  ms?: number,
  ...args: unknown[]
) => {
  if (ms === captureLong && typeof handler === 'function') {
    longTimers.push(() => handler(...args))
    // 返回一个「几乎永远不会触发」的真定时器：`clearTimeout` 对它照常有效
    return realSetTimeout(() => undefined, 2_147_483_647)
  }
  return realSetTimeout(handler, ms, ...args)
}) as unknown as typeof setTimeout

const fireLongTimers = (): void => {
  const pending = longTimers.splice(0)
  for (const timer of pending) timer()
}

/* ── 假 fetch：统一记账，按需改返回值 ─────────────────────────────────── */

interface RecordedCall {
  path: string
  body: Record<string, unknown> | undefined
}

const calls: RecordedCall[] = []
let reply: (path: string) => { status: number; body: unknown } = () => ({
  status: 200,
  body: { ok: true, granted: true, posted: [] },
})
const fetchStub: FetchLike = async (input, init) => {
  const body = typeof init.body === 'string' ? objectOf(JSON.parse(init.body)) : undefined
  calls.push({ path: input, body })
  const result = reply(input)
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { 'Content-Type': 'application/json' },
  })
}
;(globalThis as unknown as Record<string, unknown>).fetch = fetchStub

const workCalls = (): RecordedCall[] => calls.filter(call => call.path === notifyModule.NOTIFY_WORK_PATH)
const clearCalls = (): RecordedCall[] => calls.filter(call => call.path === notifyModule.NOTIFY_CLEAR_PATH)
const lastWorkBody = (): Record<string, unknown> => {
  const last = workCalls().at(-1)
  if (last === undefined || last.body === undefined) return fail('还没有任何 /work 请求')
  return last.body
}
const lastClearBody = (): Record<string, unknown> => {
  const last = clearCalls().at(-1)
  if (last === undefined || last.body === undefined) return fail('还没有任何 /clear 请求')
  return last.body
}

/* ── 会话时间线的假数据 ───────────────────────────────────────────────── */

type ChatMessage = import('../store.js').ChatMessage
type ToolActivity = import('../store.js').ToolActivity
type ApprovalActivity = import('../store.js').ApprovalActivity
type ChatItem = import('../store.js').ChatItem

const message = (id: string, sessionId: string, createdAt: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  kind: 'message',
  id,
  sessionId,
  createdAt,
  role: 'assistant',
  text: '这段正文不该出现在通知里',
  ...extra,
})

const tool = (
  id: string,
  sessionId: string,
  createdAt: number,
  toolName: string,
  summary: string,
  state: 'running' | 'finished' = 'running',
): ToolActivity => ({ kind: 'tool', id, sessionId, createdAt, toolName, summary, state })

const approval = (id: string, sessionId: string, createdAt: number, approvalId: string, toolName: string): ApprovalActivity => ({
  kind: 'approval',
  id,
  sessionId,
  createdAt,
  approvalId,
  toolName,
})

const endedTurn = (sessionId: string, createdAt: number, reason: 'completed' | 'stopped' | 'failed', time: number): ChatMessage =>
  message(`turn-end-${sessionId}-${time}`, sessionId, createdAt, { text: '', turnEnd: { reason, time } })

const workItem = (overrides: Partial<WorkItem> & Pick<WorkItem, 'sessionId' | 'state'>): WorkItem => ({
  title: '会话一',
  ts: 1_000,
  ...overrides,
})

/* ════════════════════════════════════════════════════════════════════════
 * A. notify.ts
 * ════════════════════════════════════════════════════════════════════════ */

const recorder = (): { fetch: FetchLike; calls: RecordedCall[] } => {
  const seen: RecordedCall[] = []
  const fetch: FetchLike = async (input, init) => {
    seen.push({
      path: input,
      body: typeof init.body === 'string' ? objectOf(JSON.parse(init.body)) : undefined,
    })
    return new Response(JSON.stringify({ ok: true, granted: true, posted: [] }), { status: 200 })
  }
  return { fetch, calls: seen }
}

check('A1 合并去抖：窗口内多次 push 只发一次，载荷以最后一次为准', async () => {
  const { fetch, calls: seen } = recorder()
  const notifier = createWorkNotifier({ fetch, debounceMs: 20 })
  const first = notifier.pushWorkState({ items: [workItem({ sessionId: 's1', state: 'running', tool: '工具A' })] })
  const second = notifier.pushWorkState({ items: [workItem({ sessionId: 's1', state: 'running', tool: '工具B' })] })
  const third = notifier.pushWorkState({ items: [workItem({ sessionId: 's1', state: 'running', tool: '工具C' })] })
  await Promise.all([first, second, third])
  assertEqual(seen.length, 1, '只发一次')
  const body = objectOf(seen[0]?.body)
  const items = itemsOf(body)
  assertEqual(items.length, 1, '条数')
  assertEqual(items[0]?.tool, '工具C', '以最后一次调用为准')
  assertEqual(NOTIFY_DEBOUNCE_MS >= 200 && NOTIFY_DEBOUNCE_MS <= 400, true, '默认合并窗口在 200~400ms')
})

check('A2 浅比较：载荷没变就不重复发；变了才发', async () => {
  const { fetch, calls: seen } = recorder()
  const notifier = createWorkNotifier({ fetch, debounceMs: 5 })
  const push: WorkPush = { items: [workItem({ sessionId: 's1', state: 'running', tool: '读取 README.md' })], activeSessionId: 's1' }
  await notifier.pushWorkState(push)
  await notifier.pushWorkState({ items: [workItem({ sessionId: 's1', state: 'running', tool: '读取 README.md' })], activeSessionId: 's1' })
  assertEqual(seen.length, 1, '同样的载荷不重复发')
  await notifier.pushWorkState({ items: [workItem({ sessionId: 's1', state: 'running', tool: '执行 构建' })], activeSessionId: 's1' })
  assertEqual(seen.length, 2, '内容变了要发')
  assertEqual(objectOf(seen[1]?.body).activeSessionId, 's1', 'activeSessionId 透传')
})

check('A3 网络失败：重试 2 次（共 3 次尝试）后静默，promise 不 reject', async () => {
  let attempts = 0
  const fetch: FetchLike = async () => {
    attempts += 1
    throw new TypeError('boom')
  }
  const notifier = createWorkNotifier({ fetch, debounceMs: 5, retryDelaysMs: [5, 5] })
  await notifier.pushWorkState({ items: [workItem({ sessionId: 's1', state: 'running' })] })
  assertEqual(attempts, 3, '1 次 + 2 次重试')
  // 失败不记为「已发过」：同样的载荷再来一次还会重试（上一轮尝试失败，本来就该重试）
  await notifier.pushWorkState({ items: [workItem({ sessionId: 's1', state: 'running' })] })
  assertEqual(attempts, 6, '失败之后同样的载荷仍然会重试')
  assertContains(notifier.describe(), 'failed=', 'describe 里能看到失败次数')
})

check('A4 404 降级：POST 一次 404 之后一个请求都不发', async () => {
  let requests = 0
  const fetch: FetchLike = async () => {
    requests += 1
    return new Response('not found', { status: 404 })
  }
  const notifier = createWorkNotifier({ fetch, debounceMs: 5 })
  await notifier.pushWorkState({ items: [workItem({ sessionId: 's1', state: 'running' })] })
  assertEqual(requests, 1, '第一次尝试一次')
  await notifier.pushWorkState({ items: [workItem({ sessionId: 's1', state: 'done' })] })
  await notifier.clearWork()
  assertEqual(requests, 1, '降级之后 push/clear 都不再打原生端点')
  const capability = await notifier.probeNotify()
  assertEqual(capability.supported, false, '探测也不支持')
  assertEqual(capability.reason, 'no-endpoint', '原因 = 端点不存在')
})

check('A5 探测：200+HTML（旧 APK 的 SPA 兜底）判定为不支持', async () => {
  let path = ''
  const fetch: FetchLike = async (input) => {
    path = input
    return new Response('<!doctype html><html><body>app</body></html>', { status: 200 })
  }
  const notifier = createWorkNotifier({ fetch })
  const capability = await notifier.probeNotify()
  assertEqual(path, '/__ds_notify/state.json', '探测必须用带 .json 的路径')
  assertEqual(capability.supported, false, 'HTML → 不支持')
  assertEqual(capability.reason, 'no-endpoint', '原因')
})

check('A6 探测：正常 JSON 逐字段解析', async () => {
  const fetch: FetchLike = async () =>
    new Response(JSON.stringify({ ok: true, granted: true, posted: [11, 12], groupKey: 'chatpad' }), { status: 200 })
  const notifier = createWorkNotifier({ fetch })
  const capability = await notifier.probeNotify()
  assertEqual(capability.supported, true, 'supported')
  assertEqual(capability.granted, true, 'granted')
  assertEqual(capability.posted, [11, 12], 'posted 只留数字')
})

check('A7 隐私裁剪：白名单字段、单行截断、非法 state 丢弃、条数上限', async () => {
  const { fetch, calls: seen } = recorder()
  const notifier = createWorkNotifier({ fetch, debounceMs: 5 })
  const dirty = {
    sessionId: '  s1  ',
    title: '标'.repeat(200),
    state: 'running',
    tool: '工'.repeat(100),
    detail: `第一行\n第二行 ${'细'.repeat(200)}`,
    ts: 1_700_000_000_000,
    text: '这是正文，绝不能进通知',
    output: '这是工具输出，也不能进',
    arguments: '{"command":"rm -rf /"}',
    resultDetail: { text: 'secret' },
  } as unknown as WorkItem
  const badState = { ...dirty, state: 'thinking' } as unknown as WorkItem
  const noSession = { ...dirty, sessionId: '   ' } as unknown as WorkItem
  await notifier.pushWorkState({ items: [dirty, badState, noSession], activeSessionId: '  s1  ' })
  const body = objectOf(seen.at(-1)?.body)
  const items = itemsOf(body)
  assertEqual(items.length, 1, '非法 state / 空 sessionId 被丢掉')
  const item = items[0] ?? {}
  assertEqual(Object.keys(item).sort(), ['detail', 'sessionId', 'state', 'title', 'tool', 'ts'], '只保留白名单字段')
  assertEqual(item.sessionId, 's1', 'sessionId 去空白')
  assertEqual(body.activeSessionId, 's1', 'activeSessionId 去空白')
  const title = String(item.title)
  const tool = String(item.tool)
  const detail = String(item.detail)
  assertTrue([...title].length <= 80, `title 截到 80 字：${title.length}`)
  assertTrue([...tool].length <= 40, `tool 截到 40 字：${tool.length}`)
  assertTrue([...detail].length <= 120, `detail 截到 120 字：${detail.length}`)
  assertAbsent(detail, '\n', 'detail 必须单行')
  const serialized = JSON.stringify(body)
  assertAbsent(serialized, '这是正文', '正文不能进载荷')
  assertAbsent(serialized, '这是工具输出', '工具输出不能进载荷')
  assertAbsent(serialized, 'rm -rf', '工具参数不能进载荷')

  const many: WorkItem[] = []
  for (let index = 0; index < 30; index += 1) {
    many.push(workItem({ sessionId: `s${index}`, state: 'running' }))
  }
  await notifier.pushWorkState({ items: many })
  assertEqual(itemsOf(objectOf(seen.at(-1)?.body)).length, NOTIFY_MAX_ITEMS, '条数上限')
  assertEqual(normalizeWorkPush({ items: [] }), null, '空载荷返回 null')
})

check('A8 clearWork 请求体：带/不带 sessionId', async () => {
  const { fetch, calls: seen } = recorder()
  const notifier = createWorkNotifier({ fetch, debounceMs: 5 })
  await notifier.clearWork('s1')
  assertEqual(seen.at(-1)?.path, '/__ds_notify/clear', '路径')
  assertEqual(objectOf(seen.at(-1)?.body), { sessionId: 's1' }, '带 sessionId')
  await notifier.clearWork()
  assertEqual(objectOf(seen.at(-1)?.body), {}, '不带 = 清全部')
})

check('A9 reset() 丢掉还没发的合并帧（不产生请求，promise 也放行）', async () => {
  const { fetch, calls: seen } = recorder()
  const notifier = createWorkNotifier({ fetch, debounceMs: 40 })
  const pending = notifier.pushWorkState({ items: [workItem({ sessionId: 's1', state: 'running' })] })
  notifier.reset()
  await pending
  await sleep(60)
  assertEqual(seen.length, 0, '被 reset 丢掉的帧不发')
})

check('A10 sameWorkPush：逐字段比较（不看键序）', () => {
  const a: WorkPush = { items: [workItem({ sessionId: 's1', state: 'running', tool: 'x' })], activeSessionId: 's1' }
  const b: WorkPush = { activeSessionId: 's1', items: [{ ts: 1_000, title: '会话一', state: 'running', tool: 'x', sessionId: 's1' }] }
  assertEqual(sameWorkPush(a, b), true, '字段全同 → true')
  const c: WorkPush = { items: [workItem({ sessionId: 's1', state: 'running', tool: 'x' })], activeSessionId: 's2' }
  assertEqual(sameWorkPush(a, c), false, 'activeSessionId 变了 → false')
})

check('A11 probeNotify 不缓存 granted（用户中途关了渠道要立刻看得到）', async () => {
  let granted = true
  const fetch: FetchLike = async () => new Response(JSON.stringify({ ok: true, granted, posted: [] }), { status: 200 })
  const notifier = createWorkNotifier({ fetch })
  assertEqual((await notifier.probeNotify()).granted, true, '第一次')
  granted = false
  assertEqual((await notifier.probeNotify()).granted, false, '第二次现探（不缓存）')
})

/* ════════════════════════════════════════════════════════════════════════
 * B. store.ts 的纯函数（load 之前要把全局桩装好）
 * ════════════════════════════════════════════════════════════════════════ */

const storeModule = await import('../store.js')
const { useRemoteStore, deriveNotifyItem, assembleNotifySnapshot, noteRemoteNotifyItem, syncRemoteNotify, NOTIFY_DONE_TTL_MS } =
  storeModule

check('B1 审批 → approval（工具名 + 一句话，不带 reason 原文）', () => {
  const items: ChatItem[] = [approval('row-1', 's1', 900, 'evt-1', 'Bash')]
  const item = deriveNotifyItem({
    sessionId: 's1',
    title: '会话一',
    items,
    streaming: true,
    pendingApprovals: [{ eventId: 'evt-1', title: 'Bash', detail: 'rm -rf /tmp/x' }],
    previous: 'running',
  })
  assertEqual(item?.state, 'approval', 'state')
  assertEqual(item?.tool, 'Bash', 'tool')
  assertEqual(item?.detail, '等待你确认 Bash', 'detail 只放一句话')
  assertEqual(item?.ts, 900, 'ts 用审批行的创建时间（稳定）')
  assertAbsent(JSON.stringify(item), 'rm -rf', 'reason 原文不进通知')
})

check('B2 流式但还没有工具 → running + 「正在回复…」', () => {
  const item = deriveNotifyItem({
    sessionId: 's1',
    title: '会话一',
    items: [message('m1', 's1', 700, { streaming: true })],
    streaming: true,
    pendingApprovals: [],
    previous: null,
  })
  assertEqual(item?.state, 'running', 'state')
  assertEqual('tool' in (item ?? {}), false, '没有工具名')
  assertEqual(item?.detail, '正在回复…', 'detail')
})

check('B3 工具短名：路径摘要取文件名；命令全文不进 tool', () => {
  const pathItem = deriveNotifyItem({
    sessionId: 's1',
    title: '会话一',
    items: [tool('t1', 's1', 500, '读取', 'docs/README.md')],
    streaming: false,
    pendingApprovals: [],
    previous: null,
  })
  assertEqual(pathItem?.tool, '读取 README.md', '工具名 + 文件名')
  assertEqual(pathItem?.detail, '正在调用 读取 README.md', 'detail 一句话')
  const commandItem = deriveNotifyItem({
    sessionId: 's1',
    title: '会话一',
    items: [tool('t2', 's1', 500, '执行', 'npm run build --silent')],
    streaming: false,
    pendingApprovals: [],
    previous: null,
  })
  assertEqual(commandItem?.tool, '执行', '命令行全文被丢掉')
  assertAbsent(JSON.stringify(commandItem), 'npm run build', '命令原文不能进通知')
})

check('B4 一轮结束：看过 running 才发 done；打开历史不发', () => {
  const items: ChatItem[] = [message('m1', 's1', 700), endedTurn('s1', 800, 'completed', 5_000)]
  const done = deriveNotifyItem({
    sessionId: 's1',
    title: '会话一',
    items,
    streaming: false,
    pendingApprovals: [],
    previous: 'running',
  })
  assertEqual(done?.state, 'done', 'state')
  assertEqual(done?.detail, '这一轮已完成', 'detail')
  assertEqual(done?.ts, 5_000, 'ts 用 turn/end 的时间（稳定）')
  const history = deriveNotifyItem({
    sessionId: 's1',
    title: '会话一',
    items,
    streaming: false,
    pendingApprovals: [],
    previous: null,
  })
  assertEqual(history, null, '没跑过就不发（避免打开历史会话就弹完成）')
})

check('B5 turnEnd=failed → error', () => {
  const item = deriveNotifyItem({
    sessionId: 's1',
    title: '会话一',
    items: [endedTurn('s1', 800, 'failed', 6_000)],
    streaming: false,
    pendingApprovals: [],
    previous: 'running',
  })
  assertEqual(item?.state, 'error', 'state')
  assertEqual(item?.detail, '这一轮失败了', 'detail')
})

check('B6 快照拼装：approval 最前 → 活动时间倒序 → activeSessionId → 上限 24', () => {
  const snapshot = assembleNotifySnapshot({
    activeSessionId: 's1',
    active: workItem({ sessionId: 's1', state: 'running', tool: '读取', ts: 1_000 }),
    activeUpdatedAt: 1_000,
    others: [
      { sessionId: 's2', title: '会话二', running: true, approvalTool: 'Bash', approvalTs: 3_000, updatedAt: 3_000 },
      { sessionId: 's3', title: '会话三', running: true, updatedAt: 5_000 },
      { sessionId: 's4', title: '会话四', running: false, updatedAt: 9_000 },
    ],
    finished: [workItem({ sessionId: 's0', state: 'done', ts: 500 })],
  })
  if (snapshot === null) return fail('不该是 null')
  assertEqual(snapshot.items.map(item => item.sessionId), ['s2', 's3', 's1', 's0'], 'approval 最前，其余按活动时间倒序')
  assertEqual(snapshot.activeSessionId, 's1', 'activeSessionId')
  assertEqual(snapshot.items[0]?.state, 'approval', '第一条是审批')
  assertEqual(snapshot.items[3]?.state, 'done', '结束事件排在最后')

  const many = Array.from({ length: 30 }, (_value, index) => ({
    sessionId: `x${index}`,
    title: '会话',
    running: true,
    updatedAt: index,
  }))
  const capped = assembleNotifySnapshot({ activeSessionId: null, active: null, activeUpdatedAt: 0, others: many, finished: [] })
  assertEqual(capped?.items.length, NOTIFY_MAX_ITEMS, '上限 24 条')
  assertEqual(assembleNotifySnapshot({ activeSessionId: null, active: null, activeUpdatedAt: 0, others: [], finished: [] }), null, '空 → null')
})

/* ════════════════════════════════════════════════════════════════════════
 * C. store 集成
 * ════════════════════════════════════════════════════════════════════════ */

/** 让「合并窗口 + 250ms 去抖」跑完，必要时再补一拍（幂等：内容没变不会重复发） */
const settle = async (): Promise<void> => {
  await sleep(220)
  await syncRemoteNotify()
  await sleep(30)
}

const resetCallLog = (): void => {
  calls.length = 0
}

const resetStore = (): void => {
  useRemoteStore.setState({
    phase: 'idle',
    activeSessionId: null,
    sessions: [],
    items: [],
    streaming: false,
    pendingApprovals: [],
    keepAlive: null,
    error: null,
  })
}

const s1 = { id: 's1', title: '会话一', updatedAt: 1_000 }
const s2 = { id: 's2', title: '会话二', updatedAt: 2_000 }

check('C1 ready + 进行中 → 推一帧（活动会话 / running / 工具短名）', async () => {
  resetCallLog()
  resetStore()
  await sleep(20)
  useRemoteStore.setState({
    phase: 'ready',
    activeSessionId: 's1',
    sessions: [s1, s2],
    items: [tool('t1', 's1', 1_000, '读取', 'docs/README.md')],
    streaming: true,
  })
  await settle()
  const body = lastWorkBody()
  const items = itemsOf(body)
  assertEqual(items.length, 1, '只有活动会话一条')
  assertEqual(items[0]?.sessionId, 's1', 'sessionId')
  assertEqual(items[0]?.state, 'running', 'state')
  assertEqual(items[0]?.tool, '读取 README.md', '工具短名')
  assertEqual(body.activeSessionId, 's1', 'activeSessionId')
  assertTrue(calls.some(call => call.path === '/__ds_notify/state.json'), '先探测再推')
})

check('C2 别的会话在跑 → 一起进快照（按最近活动时间排序）', async () => {
  resetCallLog()
  noteRemoteNotifyItem({ type: 'emit', event: 'api-session/status', args: ['s2', true] })
  await settle()
  const body = lastWorkBody()
  const items = itemsOf(body)
  assertEqual(items.map(item => item.sessionId), ['s2', 's1'], '活动时间倒序')
  assertEqual(items[0]?.state, 'running', 's2 是 running')
  assertEqual('tool' in (items[0] ?? {}), false, '别的会话没有工具信息，不装懂')
})

check('C3 一轮结束 → done + 30s 定时器；到点清这个会话，且快照里不再有它', async () => {
  resetCallLog()
  const before = longTimers.length
  useRemoteStore.setState({
    items: [tool('t1', 's1', 1_000, '读取', 'docs/README.md', 'finished'), endedTurn('s1', 1_100, 'completed', 1_500)],
    streaming: false,
  })
  await settle()
  const doneBody = lastWorkBody()
  assertTrue(itemsOf(doneBody).some(item => item.sessionId === 's1' && item.state === 'done'), '推了一帧 done')
  assertEqual(longTimers.length - before, 1, '挂了一个 30s 定时器')
  assertEqual(NOTIFY_DONE_TTL_MS, 30_000, '30s')

  fireLongTimers()
  await sleep(60)
  assertEqual(objectOf(lastClearBody()).sessionId, 's1', '到点清这个会话（不是整组）')
  await settle()
  assertAbsent(JSON.stringify(itemsOf(lastWorkBody())), '"sessionId":"s1"', '快照里已经摘掉 done')
})

check('C4 回前台（visibilitychange → visible）不清通知，只补推', async () => {
  resetCallLog()
  const clearsBefore = clearCalls().length
  dispatchVisibility()
  await settle()
  assertEqual(clearCalls().length, clearsBefore, '没有 /clear')
  assertEqual(visibilityDispatches, 1, '假 document 上的处理器被调用过')
})

check('C6 切走带待审批的会话 → 审批仍在快照里（原生按对账撤通知，漏掉就会被误撤）', async () => {
  resetCallLog()
  resetStore()
  await sleep(20)
  useRemoteStore.setState({
    phase: 'ready',
    activeSessionId: 's1',
    sessions: [s1, s2],
    items: [approval('a-row', 's1', 1_200, 'evt-9', 'Bash')],
    streaming: true,
    pendingApprovals: [{ eventId: 'evt-9', title: 'Bash' }],
  })
  await settle()
  let items = itemsOf(lastWorkBody())
  assertEqual(items.find(item => item.sessionId === 's1')?.state, 'approval', '活动会话有审批')

  // 切到 s2（它在跑）—— 审批还在，所以快照里必须继续出现 s1 的 approval
  useRemoteStore.setState({
    activeSessionId: 's2',
    streaming: true,
    pendingApprovals: [],
    items: [tool('t2', 's2', 1_300, '读取', 'docs/db.ts')],
  })
  await settle()
  items = itemsOf(lastWorkBody())
  assertEqual(items.find(item => item.sessionId === 's1')?.state, 'approval', '切走以后审批仍在')
  assertEqual(items[0]?.sessionId, 's1', '审批排最前')

  // 切回 s1 且审批已处理 → 信号清掉，快照里不再有 s1 的 approval
  useRemoteStore.setState({
    activeSessionId: 's1',
    streaming: true,
    pendingApprovals: [],
    items: [tool('t1', 's1', 1_400, '读取', 'docs/README.md')],
  })
  await settle()
  items = itemsOf(lastWorkBody())
  assertEqual(items.some(item => item.sessionId === 's1' && item.state === 'approval'), false, '处理完就摘掉')
  assertEqual(items.find(item => item.sessionId === 's1')?.state, 'running', 's1 回到 running')
})

check('C5 断开（phase 离开 ready）→ clearWork() 清整组', async () => {
  resetCallLog()
  useRemoteStore.setState({ phase: 'idle', activeSessionId: null })
  await sleep(80)
  assertEqual(objectOf(lastClearBody()), {}, '不带 sessionId = 清全部')
})

/* ── 跑 ───────────────────────────────────────────────────────────────── */

const main = async (): Promise<void> => {
  let failures = 0
  for (const item of checks) {
    try {
      await item.run()
      console.log(`PASS  ${item.name}`)
    } catch (error) {
      failures += 1
      console.error(`FAIL  ${item.name}`)
      console.error(`      ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  console.log(`\n${checks.length - failures} PASS / ${failures} FAIL / ${checks.length} TOTAL`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
