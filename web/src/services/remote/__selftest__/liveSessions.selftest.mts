/**
 * [S3] 全局运行态自测：**不打开会话也知道谁在跑**，以及断线 / 重连怎么清账。
 *
 * 跑法（workdir = projects\deepseek-tablet\web）：
 *   npx tsx src/services/remote/__selftest__/liveSessions.selftest.mts
 *
 * 分两层：
 *   A. 纯归约（`applyLiveInput` / `liveCountsOf` / `runningOfProjection`）：
 *      事件 → 状态，喂什么就断言什么，不碰 zustand、不碰时钟；
 *   B. 真 store（`noteLiveEventsItem` / `noteLiveControlFrame` / `reconcileLiveWithList`）：
 *      喂 `$events` 与 `session/control` 的**真实形状**，断言 store 里的结论。
 *
 * 结尾按仓库约定设置真实退出码，并且**先删旧报告**（`report.txt`）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { forwardedSessionEvent } from '../adapter.js'
import { deriveOtherWorkItem } from '../notify.js'
import {
  applyLiveInput,
  describeLive,
  INITIAL_LIVE_STATE,
  liveCountsOf,
  liveNotifyOthers,
  liveRecordOf,
  liveRunningOf,
  noteLiveControlFrame,
  noteLiveEventsItem,
  noteLiveTool,
  reconcileLiveWithList,
  resetLiveSessions,
  runningOfProjection,
  useLiveSessions,
  type LiveInput,
  type LiveSessionsState,
} from '../liveSessions.js'

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

const assertTrue = (value: boolean, label: string): void => {
  if (!value) fail(label)
}

/** 依次吞一串输入（与 store 的 `dispatch` 同一条路） */
const feed = (state: LiveSessionsState, inputs: readonly LiveInput[]): LiveSessionsState =>
  inputs.reduce((acc, input) => applyLiveInput(acc, input), state)

/** 每条用例开局把真 store 清干净 */
const reset = (): void => {
  useLiveSessions.setState({ byId: {}, reconciledAt: 0 })
}

/* ─────────────────────────── A. 纯归约 ─────────────────────────── */

check('A1 status：在跑 / 停下，停下时工具名跟着清掉', async () => {
  let state = applyLiveInput(INITIAL_LIVE_STATE, { kind: 'status', sessionId: 's1', running: true, at: 100 })
  assertEqual(liveRecordOf(state, 's1').running, true, '在跑')
  state = applyLiveInput(state, { kind: 'tool', sessionId: 's1', tool: '读取 README.md', at: 120 })
  assertEqual(liveRecordOf(state, 's1').tool, '读取 README.md', '工具名记下来')
  state = applyLiveInput(state, { kind: 'status', sessionId: 's1', running: false, at: 200 })
  assertEqual(liveRecordOf(state, 's1'), { running: false, approval: 0, updatedAt: 200 }, '停下来：running=false 且工具名消失')
})

check('A2 无变化的输入返回**原对象**（列表每行都订阅着它，不能白渲染）', async () => {
  const base = applyLiveInput(INITIAL_LIVE_STATE, { kind: 'status', sessionId: 's1', running: true, at: 100 })
  assertTrue(applyLiveInput(base, { kind: 'status', sessionId: 's1', running: true, at: 100 }) === base, '重复的 status')
  assertTrue(applyLiveInput(base, { kind: 'activity', sessionId: 's1', at: 50 }) === base, '更旧的时间戳')
  assertTrue(applyLiveInput(base, { kind: 'removed', sessionId: 'nope' }) === base, '删不存在的会话')
  assertTrue(applyLiveInput(base, { kind: 'tool', sessionId: 's1', tool: undefined, at: 200 }) === base, '工具名没变')
})

check('A3 activity 只推时间；added 带 running；removed 整条删掉', async () => {
  let state = feed(INITIAL_LIVE_STATE, [
    { kind: 'activity', sessionId: 's1', at: 10 },
    { kind: 'activity', sessionId: 's1', at: 30 },
  ])
  assertEqual(liveRecordOf(state, 's1').updatedAt, 30, '取更大的时间戳')
  assertEqual(liveRecordOf(state, 's1').running, false, 'activity 不改运行态')
  state = applyLiveInput(state, { kind: 'added', sessionId: 's2', running: true, at: 40 })
  assertEqual(liveRecordOf(state, 's2').running, true, 'added 行里带 running 就用它')
  state = applyLiveInput(state, { kind: 'removed', sessionId: 's1' })
  assertEqual(state.byId['s1'], undefined, 'removed 之后表里没有它')
})

check('A4 [核心] list 对账：刚连上就能认出「两个在跑」，且不留过期 running', async () => {
  // 上一代连接留下的脏数据：s3 停在 running，s4 已经不在了
  const dirty = feed(INITIAL_LIVE_STATE, [
    { kind: 'status', sessionId: 's3', running: true, at: 10 },
    { kind: 'status', sessionId: 's4', running: true, at: 10 },
  ])
  const state = applyLiveInput(dirty, {
    kind: 'list',
    rows: [
      { sessionId: 's1', running: true, updatedAt: 1000 },
      { sessionId: 's2', running: true, updatedAt: 900 },
      { sessionId: 's3', running: false, updatedAt: 800 },
      { sessionId: 'idle', updatedAt: 700 },
    ],
    at: 2000,
  })
  assertEqual(liveCountsOf(state), { running: 2, approval: 0 }, '列表里两个在跑')
  assertEqual(liveRecordOf(state, 's3').running, false, '列表说停了就必须熄掉')
  assertEqual(state.byId['s4'], undefined, '列表里没有的会话整条删掉（不许留着过期 running）')
  assertEqual(state.reconciledAt, 2000, '对账时间')
})

check('A5 list 对账：不认识 `running` 字段的老 Host 保持原状态（不误熄）', async () => {
  const running = feed(INITIAL_LIVE_STATE, [{ kind: 'status', sessionId: 's1', running: true, at: 10 }])
  const state = applyLiveInput(running, { kind: 'list', rows: [{ sessionId: 's1' }], at: 20 })
  assertEqual(liveRecordOf(state, 's1').running, true, '没有 running 字段就不改')
})

check('A6 list 对账：有待审批的会话即使不在列表里也留着（子会话 / 被截断的行）', async () => {
  const withApproval = feed(INITIAL_LIVE_STATE, [
    { kind: 'status', sessionId: 'sub', running: true, at: 10 },
    { kind: 'approval', sessionId: 'sub', count: 1, at: 20 },
  ])
  const state = applyLiveInput(withApproval, { kind: 'list', rows: [{ sessionId: 'other', running: false, updatedAt: 5 }], at: 30 })
  assertEqual(liveRecordOf(state, 'sub'), { running: false, approval: 1, updatedAt: 20 }, '留着审批、熄掉 running')
})

check('A7 汇总：两个在跑 + 一个待审批；活动会话可以排除在外', async () => {
  const state = feed(INITIAL_LIVE_STATE, [
    { kind: 'status', sessionId: 's1', running: true, at: 10 },
    { kind: 'status', sessionId: 's2', running: true, at: 10 },
    { kind: 'status', sessionId: 's3', running: false, at: 10 },
    { kind: 'approval', sessionId: 's3', count: 1, at: 20 },
  ])
  assertEqual(liveCountsOf(state), { running: 2, approval: 1 }, '汇总')
  assertEqual(liveCountsOf(state, 's1'), { running: 1, approval: 1 }, '排除活动会话')
})

/* ─────────────────────────── B. 真 store：$events ─────────────────────────── */

check('B1 $events api-session/status → store 里在跑 / 停下', async () => {
  reset()
  noteLiveEventsItem({ type: 'emit', event: 'api-session/status', args: ['s1', true] })
  assertEqual(liveRunningOf('s1'), true, 'status=true')
  noteLiveEventsItem({ type: 'emit', event: 'api-session/status', args: ['s1', false] })
  assertEqual(liveRunningOf('s1'), false, 'status=false')
  assertEqual(liveRunningOf(null), false, 'null 会话永远不在跑')
})

check('B2 $events 的 emit 形状解析（adapter 那一层）与这里一致', async () => {
  const status = forwardedSessionEvent({ type: 'emit', event: 'api-session/status', args: ['s9', true] })
  assertEqual(status, { kind: 'status', sessionId: 's9', running: true }, 'status 的解析结果')
  const removed = forwardedSessionEvent({ type: 'emit', event: 'api-session/removed', args: ['s9'] })
  assertEqual(removed, { kind: 'removed', sessionId: 's9' }, 'removed 的解析结果')
})

check('B3 待审批：同 eventId 重投不翻倍；cancel / 停下 / 删除都能销账', async () => {
  reset()
  const waterfall = (eventId: string): unknown => ({
    type: 'waterfall',
    event: 'approval/request',
    eventId,
    agentId: 's1',
    request: { toolName: 'Write' },
  })
  noteLiveEventsItem(waterfall('ev-1'))
  noteLiveEventsItem(waterfall('ev-1'))
  assertEqual(liveRecordOf(useLiveSessions.getState(), 's1').approval, 1, '同一 eventId 只算一条')
  noteLiveEventsItem(waterfall('ev-2'))
  assertEqual(liveRecordOf(useLiveSessions.getState(), 's1').approval, 2, '另一条 eventId 累加')
  noteLiveEventsItem({ type: 'cancel', eventId: 'ev-1' })
  assertEqual(liveRecordOf(useLiveSessions.getState(), 's1').approval, 1, 'Host 撤回销账')
  noteLiveEventsItem({ type: 'emit', event: 'api-session/status', args: ['s1', false] })
  assertEqual(liveRecordOf(useLiveSessions.getState(), 's1').approval, 0, '这一轮结束 → 全部销账')
})

check('B4 别的会话的审批也能进运行态（这就是通知里那条「谁在等你」）', async () => {
  reset()
  noteLiveEventsItem({ type: 'waterfall', event: 'approval/request', eventId: 'ev-x', agentId: 'other', request: {} })
  assertEqual(liveRecordOf(useLiveSessions.getState(), 'other').approval, 1, '不打开的会话也记账')
  noteLiveEventsItem({ type: 'emit', event: 'api-session/removed', args: ['other'] })
  assertEqual(useLiveSessions.getState().byId['other'], undefined, '会话被删 → 整条消失')
})

check('B5 工具名只由打开着的会话喂（别的会话 Host 不转发）', async () => {
  reset()
  noteLiveEventsItem({ type: 'emit', event: 'api-session/status', args: ['s1', true] })
  noteLiveTool('s1', '读取 README.md')
  assertEqual(liveRecordOf(useLiveSessions.getState(), 's1').tool, '读取 README.md', '记下来')
  noteLiveTool('s1', undefined)
  assertEqual(liveRecordOf(useLiveSessions.getState(), 's1').tool, undefined, '工具跑完就清掉')
  noteLiveTool(null, 'x')
  assertEqual(Object.keys(useLiveSessions.getState().byId).length, 1, '没有会话时什么都不做')
})

/* ─────────────────────────── C. 真 store：session/control ─────────────────────────── */

check('C1 投影解析：turn / turnState / activeTurnId / status 四种形状都认', async () => {
  assertEqual(runningOfProjection({ turn: 'running' }), true, 'turn 字符串')
  assertEqual(runningOfProjection({ turn: { status: 'done' } }), false, 'turn 对象')
  assertEqual(runningOfProjection({ turnState: 'in_progress' }), true, 'turnState')
  assertEqual(runningOfProjection({ turn: { state: 'busy' } }), true, 'turn.state')
  assertEqual(runningOfProjection({ activeTurnId: 'turn-7' }), true, 'activeTurnId 有值')
  assertEqual(runningOfProjection({ activeTurnId: null }), false, 'activeTurnId 空')
  assertEqual(runningOfProjection({ status: 'idle' }), false, 'status 字符串')
  assertEqual(runningOfProjection({ remoteStatusKnown: { status: 'running' } }), true, '嵌套 status')
  assertEqual(runningOfProjection({ title: 'x', modelSelection: {} }), undefined, '没有相关键 → 没有结论')
  assertEqual(runningOfProjection({ status: 'whatever' }), undefined, '认不出的词 → 没有结论')
})

check('C2 baseline 帧：整份投影里每个会话都校正一次', async () => {
  reset()
  noteLiveControlFrame({
    type: 'baseline',
    value: {
      projections: {
        s1: { values: { title: '甲', turn: 'running' } },
        s2: { values: { title: '乙', turn: { status: 'completed' } } },
      },
    },
  })
  assertEqual(liveRunningOf('s1'), true, 's1 在跑')
  assertEqual(liveRunningOf('s2'), false, 's2 停了')
})

check('C3 增量帧：只有 turn 相关的键会改结论，其它键跳过', async () => {
  reset()
  noteLiveEventsItem({ type: 'emit', event: 'api-session/status', args: ['s1', true] })
  // 标题变化不该动运行态
  noteLiveControlFrame({ type: 'projection', sessionId: 's1', changes: [{ key: 'title', val: '新标题' }] })
  assertEqual(liveRunningOf('s1'), true, '无关的键不动运行态')
  // turn/end 到了 → 熄掉
  noteLiveControlFrame({ type: 'projection', sessionId: 's1', changes: [{ key: 'turn', val: { status: 'done' } }] })
  assertEqual(liveRunningOf('s1'), false, '投影说这一轮结束了')
  // 单键形态（`{key, value}` 而不是 changes）
  noteLiveControlFrame({ type: 'projection', sessionId: 's1', key: 'activeTurnId', value: 'turn-9' })
  assertEqual(liveRunningOf('s1'), true, '单键形态也认')
})

check('C4 老 Host 没有这些投影键：一条都不改（fail-open，不误熄）', async () => {
  reset()
  noteLiveEventsItem({ type: 'emit', event: 'api-session/status', args: ['s1', true] })
  noteLiveControlFrame({ type: 'projection', sessionId: 's1', changes: [{ key: 'title', val: 'x' }, { key: 'usage', val: {} }] })
  assertEqual(liveRunningOf('s1'), true, '保持原样')
})

/* ─────────────────────────── D. 生命周期 ─────────────────────────── */

check('D1 list 对账入口 + reset：断开之后一条都不留', async () => {
  reset()
  reconcileLiveWithList([
    { sessionId: 's1', running: true, updatedAt: 100 },
    { sessionId: 's2', running: true, updatedAt: 200 },
  ])
  assertEqual(liveCountsOf(useLiveSessions.getState()), { running: 2, approval: 0 }, '两个在跑')
  assertTrue(describeLive().includes('running=2'), 'describe 里能看到 2')
  resetLiveSessions()
  assertEqual(useLiveSessions.getState().byId, {}, '断开后整块清空')
  assertEqual(useLiveSessions.getState().reconciledAt, 0, '对账时间也复位')
  assertEqual(describeLive(), 'live|sessions=0|running=0|approval=0|reconciled=no', 'describe')
})

check('D2 重连重建：先脏后对账，过期 running 一定熄掉', async () => {
  reset()
  // 模拟「上次连接残留在界面上」的 running（这次连接还没对账）
  noteLiveEventsItem({ type: 'emit', event: 'api-session/status', args: ['gone', true] })
  assertEqual(liveRunningOf('gone'), true, '脏数据在场')
  reconcileLiveWithList([{ sessionId: 'keep', running: false, updatedAt: 10 }])
  assertEqual(liveRunningOf('gone'), false, '对账之后过期 running 必须熄掉')
  assertEqual(useLiveSessions.getState().byId['gone'], undefined, '且整条被删掉')
})

/* ─────────────────────────── E. 通知联动（真 store + 假 fetch） ─────────────────────────── */

/*
 * 这一段要 import 真的 `store.ts`，而它在模块初始化时会读一次 localStorage、
 * 挂一次 `visibilitychange`。所以桩必须在 `import()` **之前**装好
 * （与 `notify.selftest.mts` 同一套做法）。
 */
const memory = new Map<string, string>()
;(globalThis as unknown as Record<string, unknown>).localStorage = {
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
;(globalThis as unknown as Record<string, unknown>).document = {
  visibilityState: 'visible',
  addEventListener: (): void => undefined,
  removeEventListener: (): void => undefined,
}

/** 收集 `/__ds_notify/*` 的请求体 */
const notifyPosts: Array<{ path: string; body: unknown }> = []
;(globalThis as unknown as Record<string, unknown>).fetch = async (input: unknown, init?: { method?: string; body?: string }) => {
  const path = String(input)
  if (path.endsWith('/state.json')) {
    return new Response(JSON.stringify({ ok: true, granted: true, posted: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  if (init?.body !== undefined) notifyPosts.push({ path, body: JSON.parse(init.body) })
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
}

const storeModule = await import('../store.js')
const { useRemoteStore, syncRemoteNotify, noteRemoteNotifyItem } = storeModule

/** 等 `notify.ts` 的两级合并窗口（120ms + 250ms）把这一拍发出去 */
const flushNotify = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 500))
  await syncRemoteNotify()
  await new Promise((resolve) => setTimeout(resolve, 500))
}

check('E1 [核心] 通知 items 里必须有「没打开过的运行中会话」', async () => {
  reset()
  notifyPosts.length = 0
  useRemoteStore.setState({
    phase: 'ready',
    sessions: [
      { id: 's-active', title: '当前会话', updatedAt: 500 },
      { id: 's-bg', title: '后台那个会话', updatedAt: 900 },
    ],
    activeSessionId: 's-active',
    items: [],
    streaming: true,
    pendingApprovals: [],
    pendingInteractions: {},
  })
  // 连上时的第一帧 `session/list`：s-active 与 s-bg 都在跑（谁都没点开过 s-bg）
  reconcileLiveWithList([
    { sessionId: 's-active', running: true, updatedAt: 500 },
    { sessionId: 's-bg', running: true, updatedAt: 900 },
  ])
  await flushNotify()
  const work = notifyPosts.filter((post) => post.path.endsWith('/__ds_notify/work'))
  assertTrue(work.length > 0, '至少要推一帧 /work')
  const body = work.at(-1)?.body as { items?: Array<{ sessionId: string; state: string; detail?: string }> } | undefined
  const items = body?.items ?? []
  const bg = items.find((item) => item.sessionId === 's-bg')
  assertTrue(bg !== undefined, '没打开过的 s-bg 必须在 items 里（用户反馈的那一条）')
  assertEqual(bg?.state, 'running', '它的状态是运行中')
  assertEqual(bg?.detail, '正在回复…', '不知道工具名时如实说「正在回复」')
})

check('E2 待审批的会话进 items 时状态是 approval（哪怕它没在跑）', async () => {
  reset()
  notifyPosts.length = 0
  useRemoteStore.setState({
    phase: 'ready',
    sessions: [
      { id: 's-active', title: '当前会话', updatedAt: 500 },
      { id: 's-wait', title: '等我审批的会话', updatedAt: 800 },
    ],
    activeSessionId: 's-active',
    items: [],
    streaming: false,
    pendingApprovals: [],
    pendingInteractions: {},
  })
  reconcileLiveWithList([
    { sessionId: 's-active', running: false, updatedAt: 500 },
    { sessionId: 's-wait', running: false, updatedAt: 800 },
  ])
  // 生产里这条 waterfall 会被 `$events` 的 sink **同时**喂给两条路：
  //   - `noteRemoteNotifyItem`（R6）：带工具名，画「等待你确认 Bash」；
  //   - `noteLiveEventsItem`（S3）：只记条数，R6 那条漏了也不会丢。
  const waterfall = { type: 'waterfall', event: 'approval/request', eventId: 'evt-1', agentId: 's-wait', request: { toolName: 'Bash' } }
  noteRemoteNotifyItem(waterfall)
  noteLiveEventsItem(waterfall)
  await flushNotify()
  const work = notifyPosts.filter((post) => post.path.endsWith('/__ds_notify/work'))
  assertTrue(work.length > 0, '有东西要通知时才会推')
  const body = work.at(-1)?.body as { items?: Array<{ sessionId: string; state: string; tool?: string }> } | undefined
  const wait = (body?.items ?? []).find((item) => item.sessionId === 's-wait')
  assertEqual(wait?.state, 'approval', '状态是待审批')
  assertEqual(wait?.tool, 'Bash', '带上工具名')
})

check('E3 `liveNotifyOthers()`：活动会话不进「其它会话」，空会话不进快照', async () => {
  const state = feed(INITIAL_LIVE_STATE, [
    { kind: 'status', sessionId: 'active', running: true, at: 10 },
    { kind: 'status', sessionId: 'bg', running: true, at: 20 },
    { kind: 'approval', sessionId: 'wait', count: 1, at: 30 },
    { kind: 'activity', sessionId: 'idle', at: 40 },
  ])
  const others = liveNotifyOthers(state, {
    activeSessionId: 'active',
    titleOf: (id) => `标题:${id}`,
    updatedAtOf: () => 100,
  })
  assertEqual(others.map((item) => item.sessionId).sort(), ['bg', 'wait'], '活动会话与纯空闲会话都不在列')
  assertEqual(others.find((item) => item.sessionId === 'bg')?.updatedAt, 100, 'updatedAt 取较大值')
  assertEqual(others.find((item) => item.sessionId === 'wait')?.approvalCount, 1, '审批条数带出去')
})

check('E4 `deriveOtherWorkItem()`：有工具名说工具，没有就说「正在回复」', async () => {
  assertEqual(
    deriveOtherWorkItem({ sessionId: 's', title: '会话', tool: '读取 README.md', ts: 1000 }),
    { sessionId: 's', title: '会话', state: 'running', tool: '读取 README.md', detail: '正在调用 读取 README.md', ts: 1000 },
    '有工具名',
  )
  const before = Date.now()
  const { ts, ...item } = deriveOtherWorkItem({ sessionId: 's', title: '', ts: 0 })
  assertEqual(ts >= before && ts <= Date.now(), true, '没有时间时使用当前时钟')
  assertEqual(
    item,
    { sessionId: 's', title: '会话', state: 'running', detail: '正在回复…' },
    '没有工具名 / 没有标题 / 没有时间',
  )
})

/* ─────────────────────────── 跑 ─────────────────────────── */

const reportFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'report-live.txt')
fs.rmSync(reportFile, { force: true })

const lines: string[] = []
let failures = 0
for (const item of checks) {
  try {
    await item.run()
    lines.push(`[PASS] ${item.name}`)
  } catch (error) {
    failures += 1
    lines.push(`[FAIL] ${item.name} → ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    reset()
  }
}
lines.push('', `总计 ${checks.length} 项，${checks.length - failures} PASS / ${failures} FAIL`)
fs.writeFileSync(reportFile, `${lines.join('\n')}\n`, 'utf8')
for (const line of lines) console.log(line)
process.exit(failures === 0 ? 0 : 1)
