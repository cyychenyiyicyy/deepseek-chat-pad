/**
 * S4「消息串会话」回归自测（routing.ts + adapter 回显对齐 + cache 桶键）。
 *
 * 跑法（workdir = projects\deepseek-tablet\web）：
 *   npx tsx src/services/remote/__selftest__/session-routing.selftest.mts
 *
 * ── 这份自测钉的是什么 ──────────────────────────────────────────────────
 * 真机症状：「在这个会话里发了一条消息，切到另一个会话，它显示我刚发出的消息
 * （其实没发出去）；有的会话根本没有工具调用过程，只显示我发送的消息」。
 *
 * 根因不是某一条 if 写错，而是**没有「会话归属」这个概念**：
 * `ActiveSession` 只有一个 `transcript` 槽位，所有帧都往「当前活动会话」里写。
 *
 * 修法照 dsh-Go 的 Dart 实现翻（对照表见 `routing.ts` 文件头）：
 *   A. 帧归属：`belongsToSession`（= `session_api.dart:1086-1102` 的 `when … == sessionId`）
 *   B. 每会话一份 transcript：`commitSessionTranscript` / `trimSessionTranscripts`
 *      （= `transcript.dart:159` 的 `ChatTranscript` + `chat_state.dart:465`）
 *   C. follow 代际：`newFollowEpoch` / `followEpochIsCurrent`
 *      （= `session_api.dart:1169-1176` + `chat_state.dart:535-545`）
 *   D. 乐观行回显：`isOptimisticEcho`（= `chat_state.dart:1288-1297` 的 `_dropEchoed`，
 *      再补上我们这边缺的 sessionId 维度）
 *
 * 覆盖任务书要求的五件事：
 *   1. A 会话发消息 → 切到 B → A 的回显帧到达 → **只**落到 A；
 *   2. A 的 follow 流帧在 B 打开期间到达 → 不污染 B；
 *   3. 快照恢复（重连）只写自己那个会话；
 *   4. 缓存桶键正确（A 的内容不会被写进 B 的桶）；
 *   5. 同一 `requestRpcId` 在两个会话里各自对齐。
 * 另加：每会话登记表的上限淘汰、调试计数 `__dsDebug.sessionDrops` 的行为。
 *
 * 不联网：localStorage 是内存实现，fetch 是桩（全程不该有人调它）。
 */

/** 只导入类型（静态 type-only import 会在编译期被抹掉，不影响下面的「先装全局再 import」）。 */
import type { ChatItem, ChatMessage, NativeSessionEvent, RemoteTranscriptState } from '../adapter.js'
import type { FollowEpochTicket } from '../routing.js'

/* ── 最小断言器（与其它 selftest 同一套写法） ─────────────────────────── */

const checks: Array<{ name: string; run: () => Promise<void> | void }> = []
const check = (name: string, run: () => Promise<void> | void): void => {
  checks.push({ name, run })
}

const fail = (message: string): never => {
  throw new Error(message)
}

const assertEqual = (actual: unknown, expected: unknown, label: string): void => {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left !== right) fail(`${label}：期望 ${right}，实际 ${left}`)
}

const assertTrue = (value: boolean, label: string): void => {
  if (!value) fail(label)
}

/* ── 控制台：默认**不打日志**是这次的硬要求，所以全程盯着它 ─────────────
 * 自测自己的 PASS/FAIL 走 `realLog`，不计入 `logCalls`。
 */
const realLog = console.log
const realWarn = console.warn
const realError = console.error
let logCalls = 0
console.log = (...args: unknown[]): void => {
  logCalls += 1
  realLog(...args)
}
console.warn = (...args: unknown[]): void => {
  logCalls += 1
  realWarn(...args)
}
console.error = (...args: unknown[]): void => {
  logCalls += 1
  realError(...args)
}

/* ── 内存版 localStorage（cache.ts 在模块初始化时会读一次） ───────────── */

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

/** fetch 桩：这批代码不该发任何请求，发了就让自测失败（而不是静默挂住）。 */
let fetchCalls = 0
;(globalThis as unknown as Record<string, unknown>).fetch = (async () => {
  fetchCalls += 1
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
}) as unknown as typeof fetch

/* ── 被测模块（先装好全局再 import） ───────────────────────────────────── */

const routing = await import('../routing.js')
const adapterModule = await import('../adapter.js')
const cache = await import('../cache.js')

const {
  acceptCacheWrite,
  belongsToSession,
  commitSessionTranscript,
  followEpochIsCurrent,
  historyOwnerIsCurrent,
  isOptimisticEcho,
  noteSessionDrop,
  resetSessionDrops,
  sessionDropSnapshot,
  trimSessionTranscripts,
} = routing

const {
  addOptimisticUserMessage,
  applyFollowEvent,
  clearSendState,
  createTranscriptState,
  parseSnapshot,
  reduceFollowItem,
  reduceSnapshot,
} = adapterModule

const { readTimelineCache, writeTimelineCache } = cache

/* ── 夹具 ─────────────────────────────────────────────────────────────── */

const SERVER = 'https://dsh.r2049.cn'
const HOST = 'host-a'
const SESS_A = 'sess-A'
const SESS_B = 'sess-B'
const T0 = 1_760_000_000_000

const bucket = (over: Partial<{ serverUrl: string; hostDeviceId: string; now: number }> = {}) => ({
  serverUrl: SERVER,
  hostDeviceId: HOST,
  now: T0,
  ...over,
})

/** 工牌：直接写字面量，避免 `newFollowEpoch` 的 +1 语义在测试里绕人。 */
const ticketOf = (sessionId: string, epoch: number): FollowEpochTicket => ({ sessionId, epoch })

/** 一条持久事件（`adapter.ts` 头部的线格式）。 */
const eventOf = (type: string, seq: number, data: Record<string, unknown>): NativeSessionEvent => ({
  type,
  seq,
  time: T0 + seq,
  data,
})

/** `session/follow` 的增量帧（`reduceFollowItem` 的入参）。 */
const followFrame = (event: NativeSessionEvent): unknown => ({ type: 'event', event })

/** 用户消息回显：`source.kind = 'user'` + `source.rpcId`（Host 用它对齐乐观行）。 */
const userEcho = (seq: number, rpcId: string, text: string, messageId = `m-${seq}`): NativeSessionEvent =>
  eventOf('user/message', seq, {
    message: { id: messageId, source: { kind: 'user', rpcId }, content: [{ type: 'text', text }] },
  })

/** 工具调用事件：用来证明「工具过程」不会被搬到别的会话。 */
const toolCall = (seq: number, callId: string): NativeSessionEvent =>
  eventOf('tool/call', seq, { callId, toolName: 'read_file', args: {}, turn: '1', step: '1' })

const assistantMessage = (seq: number, text: string): NativeSessionEvent =>
  eventOf('assistant/message', seq, {
    message: { id: `a-${seq}`, content: [{ type: 'text', text }] },
    turn: '1',
    step: '1',
  })

const transcript = (items: ChatItem[] = []): RemoteTranscriptState => ({
  ...createTranscriptState(),
  items,
})

const messageOf = (items: readonly ChatItem[], rpcId: string): ChatMessage | undefined =>
  items.find((item): item is ChatMessage => item.kind === 'message' && item.requestRpcId === rpcId)

const idsOf = (state: RemoteTranscriptState | undefined): string[] => (state?.items ?? []).map(item => item.id)

/**
 * 仿 store 的 follow sink（`openSessionFlow` 的 `onValue`），顺序与实现一致：
 *   ① 代际校验（Dart `_canControl`）→ ② 读自己那份 → ③ 归约 → ④ 按会话落格。
 */
const landFollowFrame = (
  registry: Map<string, RemoteTranscriptState>,
  ticket: FollowEpochTicket,
  cursor: { sessionId: string | null; epoch: number },
  event: NativeSessionEvent,
): { landed: boolean; shown: boolean } => {
  if (!followEpochIsCurrent(ticket, cursor)) return { landed: false, shown: false }
  const current = registry.get(ticket.sessionId) ?? createTranscriptState()
  const next = reduceFollowItem(current, followFrame(event), ticket.sessionId)
  const result = commitSessionTranscript(registry, ticket.sessionId, cursor.sessionId, next)
  return { landed: result.stored, shown: result.shown }
}

/* ════════════════════════════════════════════════════════════════════════
 * A. 帧归属：只有「自带 sessionId 且与目标会话严格相等」才收
 *    （Dart `session_api.dart:1086-1102` 的 `when x.sessionId == sessionId`）
 * ════════════════════════════════════════════════════════════════════════ */

check('A1 同会话收；不同会话 / 空 / null / undefined 一律丢（fail-closed）', async () => {
  assertTrue(belongsToSession(SESS_A, SESS_A), '同会话要收')
  assertTrue(!belongsToSession(SESS_A, SESS_B), '别的会话必须丢')
  assertTrue(!belongsToSession(SESS_B, SESS_A), '反向同理')
  assertTrue(!belongsToSession(null, SESS_A), '还没开会话：帧没有归宿')
  assertTrue(!belongsToSession(SESS_A, null), '帧不带 sessionId：认不出，当别人的处理')
  assertTrue(!belongsToSession(SESS_A, undefined), '帧不带 sessionId（undefined）同样丢')
  assertTrue(!belongsToSession('', ''), '两个空串不算命中（避免「都没开」被当成一致）')
  assertTrue(!belongsToSession(undefined, undefined), '都缺就都丢')
})

check('A2 缓存桶键判据与帧归属同一套（A 的内容不许写进 B 的桶）', async () => {
  assertTrue(acceptCacheWrite(SESS_A, SESS_A), '同会话可写')
  assertTrue(!acceptCacheWrite(SESS_B, SESS_A), '内容属于 A、桶是 B → 拒绝')
  assertTrue(!acceptCacheWrite(SESS_A, null), '内容没有归属 → 拒绝（宁可不写）')
})

/* ════════════════════════════════════════════════════════════════════════
 * ① A 会话发消息 → 切到 B → A 的回显帧到达 → 只落到 A
 * ════════════════════════════════════════════════════════════════════════ */

check('①-1 A 发消息：乐观行带 A 的 sessionId 与 requestRpcId', async () => {
  const optimistic = addOptimisticUserMessage([], SESS_A, '你好', 'req-1')
  const row = messageOf(optimistic, 'req-1')
  assertTrue(row !== undefined, '乐观行上屏')
  assertEqual(row?.sessionId, SESS_A, '行上带着 A 的 sessionId')
  assertEqual(row?.sendState, 'queued', '还没被受理 = 发送中')
})

check('①-2 切到 B 之后 A 的回显到达：只落 A，B 一个字都不变', async () => {
  const aItems = addOptimisticUserMessage([], SESS_A, '你好', 'req-1')
  const bItem: ChatMessage = {
    kind: 'message', id: 'b-1', sessionId: SESS_B, role: 'assistant', text: 'B 的旧内容', createdAt: T0,
  }
  const registry = new Map<string, RemoteTranscriptState>([
    [SESS_A, transcript(aItems)],
    [SESS_B, transcript([bItem])],
  ])
  // 此刻用户在 B；A 的 follow 流（工牌仍是切走前那张）把回显推来了
  const staleA = ticketOf(SESS_A, 1)
  const cursorOnB = { sessionId: SESS_B, epoch: 3 }
  const landed = landFollowFrame(registry, staleA, cursorOnB, userEcho(10, 'req-1', '你好'))
  assertEqual(landed, { landed: false, shown: false }, 'A 的帧在 B 打开期间必须被丢掉')
  assertEqual(idsOf(registry.get(SESS_B)), ['b-1'], 'B 的时间线完全没变')
  assertEqual(idsOf(registry.get(SESS_A)), ['local:req-1'], 'A 那边仍停在乐观行（没被这条帧动过）')

  // 反向对照：同一帧在 A 是活动会话时**应该**落进 A
  const ticketA = ticketOf(SESS_A, 2)
  const landedA = landFollowFrame(registry, ticketA, { sessionId: SESS_A, epoch: 2 }, userEcho(10, 'req-1', '你好'))
  assertEqual(landedA, { landed: true, shown: true }, 'A 自己开着时正常落 A')
  const aRow = messageOf(registry.get(SESS_A)?.items ?? [], 'req-1')
  assertEqual(aRow?.id, 'm-10', '乐观行被权威行替换（按 requestRpcId 对齐）')
  assertEqual(aRow?.sessionId, SESS_A, '替换后仍属于 A')
  assertEqual(idsOf(registry.get(SESS_B)), ['b-1'], 'B 依然一个字都没变')
})

check('①-3 串台现场还原：不校验归属直接归约，A 的消息真的会出现在 B 里', async () => {
  /*
   * 这条钉的是「为什么必须挡」：老代码的 sink 闭包写的是 `session.transcript`，
   * 切走之后那已经是 B 的列表了。这里照着那个写法做一次，作为回归对照。
   */
  const bItems: ChatItem[] = [{
    kind: 'message', id: 'b-1', sessionId: SESS_B, role: 'assistant', text: 'B 的旧内容', createdAt: T0,
  }]
  const polluted = applyFollowEvent(bItems, userEcho(10, 'req-1', 'A 发的'), SESS_B)
  assertEqual(polluted.length, 2, '不做归属校验 → A 的消息会出现在 B 里（复现症状）')
  assertEqual(polluted[1]?.sessionId, SESS_B, '还被标成 B 的会话（这正是用户看到的观感）')
  // 有了守卫：同一帧在 B 是活动会话时根本进不来
  const frameOwner = SESS_A
  assertTrue(!belongsToSession(SESS_B, frameOwner), '守卫判据把它挡在外面')
})

/* ════════════════════════════════════════════════════════════════════════
 * ② A 的 follow 流帧在 B 打开期间到达 → 不污染 B
 * ════════════════════════════════════════════════════════════════════════ */

check('②-1 代际：A 的工牌在切到 B 之后作废，A→B→A 绕回来也不复活', async () => {
  const tickA = ticketOf(SESS_A, 1)
  assertTrue(followEpochIsCurrent(tickA, { sessionId: SESS_A, epoch: 1 }), '当下有效')
  assertTrue(!followEpochIsCurrent(tickA, { sessionId: SESS_B, epoch: 1 }), '会话换了 → 作废')
  assertTrue(!followEpochIsCurrent(tickA, { sessionId: SESS_A, epoch: 2 }), '代际被顶掉 → 作废')
  // A→B→A：sessionId 又对上了，但 epoch 已经不是它那一代
  assertTrue(!followEpochIsCurrent(tickA, { sessionId: SESS_A, epoch: 3 }), '绕回 A 也不许复活旧流')
  const tickA2 = ticketOf(SESS_A, 3)
  assertTrue(followEpochIsCurrent(tickA2, { sessionId: SESS_A, epoch: 3 }), '只有最新那条流有效')
})

check('②-2 A 的 follow 帧在 B 打开期间到达：B 不长工具行，A 的过程留在 A', async () => {
  const aItems: ChatItem[] = [{
    kind: 'message', id: 'a-user', sessionId: SESS_A, role: 'user', text: '跑个命令', createdAt: T0,
  }]
  const bItems: ChatItem[] = [{
    kind: 'message', id: 'b-user', sessionId: SESS_B, role: 'user', text: 'B 的问题', createdAt: T0,
  }]
  const registry = new Map<string, RemoteTranscriptState>([
    [SESS_A, transcript(aItems)],
    [SESS_B, transcript(bItems)],
  ])
  const cursorOnB = { sessionId: SESS_B, epoch: 2 }
  const staleA = ticketOf(SESS_A, 1)
  assertEqual(
    landFollowFrame(registry, staleA, cursorOnB, toolCall(11, 'call-1')),
    { landed: false, shown: false },
    'A 的工具帧被丢',
  )
  assertEqual(
    landFollowFrame(registry, staleA, cursorOnB, assistantMessage(12, 'A 的答案')),
    { landed: false, shown: false },
    'A 的助手帧被丢',
  )
  assertEqual(idsOf(registry.get(SESS_B)), ['b-user'], 'B 里没有 A 的工具调用 / 答案')
  assertTrue(
    !(registry.get(SESS_B)?.items ?? []).some(item => item.kind === 'tool'),
    'B 不该凭空长出工具行（真机症状之一：有消息没过程）',
  )
  assertEqual(idsOf(registry.get(SESS_A)), ['a-user'], 'A 那边没被这条旧流写脏')
})

check('②-3 孤儿流的帧只更新它自己的格子，永远进不了当前会话', async () => {
  // 模拟「切会话时漏关了一条流」：工牌早过期，帧还在推
  const registry = new Map<string, RemoteTranscriptState>([
    [SESS_A, transcript()],
    [SESS_B, transcript([{
      kind: 'message', id: 'b-1', sessionId: SESS_B, role: 'assistant', text: 'B', createdAt: T0,
    }])],
  ])
  const orphan = ticketOf(SESS_A, 1)
  const cursorOnB = { sessionId: SESS_B, epoch: 5 }
  for (const seq of [20, 21, 22]) {
    assertEqual(
      landFollowFrame(registry, orphan, cursorOnB, toolCall(seq, `call-${seq}`)),
      { landed: false, shown: false },
      `孤儿帧 ${seq} 必须被丢`,
    )
  }
  assertEqual(idsOf(registry.get(SESS_B)).length, 1, 'B 一行都没多')
  // 就算将来有人绕过代际直接 commit，也只落 A 的格子
  const forced = commitSessionTranscript(registry, SESS_A, SESS_B, transcript([{
    kind: 'message', id: 'a-1', sessionId: SESS_A, role: 'assistant', text: 'A', createdAt: T0,
  }]))
  assertEqual(forced, { stored: true, shown: false }, '落到 A，但不显示（当前是 B）')
  assertEqual(idsOf(registry.get(SESS_B)).length, 1, 'B 仍然没变')
  assertEqual(idsOf(registry.get(SESS_A)), ['a-1'], 'A 自己的格子被更新了')
})

/* ════════════════════════════════════════════════════════════════════════
 * ③ 快照恢复（重连）只写自己那个会话
 * ════════════════════════════════════════════════════════════════════════ */

/** 一条最小合法快照（`parseSnapshot` 要求 `type:'snapshot'` + `records`）。 */
const snapshotOf = (tag: string): unknown => ({
  type: 'snapshot',
  cursor: 2,
  hasMore: false,
  records: [
    {
      type: 'event',
      event: {
        type: 'user/message',
        seq: 1,
        time: T0,
        data: {
          message: {
            id: `${tag}-u`,
            source: { kind: 'user' },
            content: [{ type: 'text', text: `${tag} 的问题` }],
          },
        },
      },
    },
    {
      type: 'event',
      event: {
        type: 'assistant/message',
        seq: 2,
        time: T0 + 1,
        data: {
          message: { id: `${tag}-a`, content: [{ type: 'text', text: `${tag} 的答案` }] },
          turn: '1',
          step: '1',
        },
      },
    },
  ],
})

check('③-1 快照归约带着会话 id：A 的快照产出 A 的行', async () => {
  const parsed = parseSnapshot(snapshotOf('A'))
  assertTrue(parsed !== null, '快照能解析')
  const state = reduceSnapshot(parsed!, SESS_A)
  assertEqual(state.items.map(item => item.id), ['A-u', 'A-a'], '行来自快照')
  assertTrue(state.items.every(item => item.sessionId === SESS_A), '每一行的 sessionId 都是 A')
})

check('③-2 重连恢复：旧工牌的 A 快照不许落到 B，新工牌只落 A', async () => {
  const registry = new Map<string, RemoteTranscriptState>([
    [SESS_A, transcript()],
    [SESS_B, transcript([{
      kind: 'message', id: 'b-keep', sessionId: SESS_B, role: 'assistant', text: 'B 的上下文', createdAt: T0,
    }])],
  ])
  const snapshot = reduceSnapshot(parseSnapshot(snapshotOf('A'))!, SESS_A)

  // ① 重连前那张旧工牌：A→B 已经把代际顶掉了 → 这份快照必须整份作废
  const oldTicket = ticketOf(SESS_A, 1)
  const cursorOnB = { sessionId: SESS_B, epoch: 4 }
  assertTrue(!followEpochIsCurrent(oldTicket, cursorOnB), '旧工牌作废，快照不会落地')
  assertEqual(idsOf(registry.get(SESS_B)), ['b-keep'], 'B 没被旧快照污染')

  // ② 真实路径：重连后开新流（新工牌）+ A 是活动会话 → 只落 A
  const freshTicket = ticketOf(SESS_A, 4)
  assertTrue(followEpochIsCurrent(freshTicket, { sessionId: SESS_A, epoch: 4 }), '新工牌有效')
  const landed = commitSessionTranscript(registry, freshTicket.sessionId, SESS_A, snapshot)
  assertEqual(landed, { stored: true, shown: true }, '快照落 A 并显示')
  assertEqual(idsOf(registry.get(SESS_A)), ['A-u', 'A-a'], 'A 有了快照内容')
  assertEqual(idsOf(registry.get(SESS_B)), ['b-keep'], 'B 完全没被碰')
  assertTrue(
    !(registry.get(SESS_B)?.items ?? []).some(item => item.sessionId === SESS_A),
    'B 里不存在属于 A 的行',
  )
})

check('③-3 翻页归属（_checkHistoryOwner）：回来时会话换了就整页作废', async () => {
  const owner = ticketOf(SESS_A, 2)
  assertTrue(historyOwnerIsCurrent(owner, { sessionId: SESS_A, epoch: 2 }), '同一条 follow 上可以落')
  assertTrue(!historyOwnerIsCurrent(owner, { sessionId: SESS_B, epoch: 2 }), '切走了 → 这一页作废')
  assertTrue(!historyOwnerIsCurrent(owner, { sessionId: SESS_A, epoch: 9 }), '切回来但代际变了 → 也作废')
})

/* ════════════════════════════════════════════════════════════════════════
 * ④ 缓存桶键：A 的内容不会写进 B 的桶
 * ════════════════════════════════════════════════════════════════════════ */

check('④-1 两个会话各写各的桶，读的时候不会串', async () => {
  memory.clear()
  const aRow: ChatMessage = { kind: 'message', id: 'a-1', sessionId: SESS_A, role: 'user', text: 'A 的内容', createdAt: T0 }
  const bRow: ChatMessage = { kind: 'message', id: 'b-1', sessionId: SESS_B, role: 'user', text: 'B 的内容', createdAt: T0 }
  writeTimelineCache({ ...bucket(), sessionId: SESS_A, items: [aRow] })
  writeTimelineCache({ ...bucket(), sessionId: SESS_B, items: [bRow] })
  const readA = readTimelineCache({ ...bucket(), sessionId: SESS_A })
  const readB = readTimelineCache({ ...bucket(), sessionId: SESS_B })
  assertEqual(readA?.items.map(item => item.id), ['a-1'], 'A 桶里只有 A')
  assertEqual(readB?.items.map(item => item.id), ['b-1'], 'B 桶里只有 B')
  assertEqual(readA?.items[0]?.sessionId, SESS_A, 'A 桶内容的归属没变')
})

check('④-2 store 的写入守卫：桶与内容归属不一致就整份不写', async () => {
  memory.clear()
  // 先放一份 B 的旧内容，模拟「用户之前打开过 B」
  writeTimelineCache({
    ...bucket(),
    sessionId: SESS_B,
    items: [{ kind: 'message', id: 'b-old', sessionId: SESS_B, role: 'assistant', text: 'B 的旧内容', createdAt: T0 }],
  })
  // 「A 的内容 + B 的桶键」就是串台写法的样子；`persistTimelineNow` 正是用 acceptCacheWrite 挡它
  assertTrue(!acceptCacheWrite(SESS_B, SESS_A), '判据拒绝')
  const aItems: ChatItem[] = [{
    kind: 'message', id: 'a-new', sessionId: SESS_A, role: 'user', text: 'A 的新内容', createdAt: T0,
  }]
  // 复刻 store 的分支：判据不过就不写
  if (acceptCacheWrite(SESS_B, SESS_A)) writeTimelineCache({ ...bucket(), sessionId: SESS_B, items: aItems })
  const readB = readTimelineCache({ ...bucket(), sessionId: SESS_B })
  assertEqual(readB?.items.map(item => item.id), ['b-old'], 'B 的桶没被 A 的内容覆盖')
  assertTrue(!(readB?.items ?? []).some(item => item.sessionId === SESS_A), 'B 桶里不存在属于 A 的行')
  assertEqual(readTimelineCache({ ...bucket(), sessionId: SESS_A }), null, 'A 也没被顺手写一份错的')
})

/* ════════════════════════════════════════════════════════════════════════
 * ⑤ 同一 requestRpcId 在两个会话里各自对齐
 * ════════════════════════════════════════════════════════════════════════ */

check('⑤-1 同一 rpcId 在两个会话各有一条乐观行：判据按 (sessionId, rpcId) 分清', async () => {
  const aItems = addOptimisticUserMessage([], SESS_A, 'A 说的', 'req-same')
  const bItems = addOptimisticUserMessage([], SESS_B, 'B 说的', 'req-same')
  const aRow = messageOf(aItems, 'req-same')
  const bRow = messageOf(bItems, 'req-same')
  assertTrue(aRow !== undefined && bRow !== undefined, '两边都有乐观行')
  if (aRow === undefined || bRow === undefined) return
  assertTrue(isOptimisticEcho(aRow, SESS_A, 'req-same'), 'A 的行认 A')
  assertTrue(!isOptimisticEcho(aRow, SESS_B, 'req-same'), 'A 的行不许被 B 认领')
  assertTrue(isOptimisticEcho(bRow, SESS_B, 'req-same'), 'B 的行认 B')
  assertTrue(!isOptimisticEcho(bRow, SESS_A, 'req-same'), 'B 的行不许被 A 认领')
})

check('⑤-2 回显只认**本会话**的行：历史遗留的跨会话脏行不会被认领', async () => {
  /*
   * 造一份「旧版本串台留下的脏数据」：B 的列表里躺着一行标记为 A 的乐观行，
   * 而 B 这边的回显 requestRpcId 正好也是它。只比 rpcId 的话这行会被 B 认领并替换
   * —— 那条行就**真的是 A 的却显示在 B 里**，而 A 那边永远停在「发送中」。
   */
  const polluted: ChatItem[] = [
    { kind: 'message', id: 'b-1', sessionId: SESS_B, role: 'assistant', text: 'B 的内容', createdAt: T0 },
    {
      kind: 'message',
      id: 'local:req-legacy',
      sessionId: SESS_A,
      role: 'user',
      text: 'A 很久以前发的',
      createdAt: T0,
      requestRpcId: 'req-legacy',
      sendState: 'queued',
    },
  ]
  assertTrue(
    !isOptimisticEcho(polluted[1]!, SESS_B, 'req-legacy'),
    '判据不认领（行属于 A，B 没有权利替换它）',
  )
  const after = applyFollowEvent(polluted, userEcho(30, 'req-legacy', 'B 这边的新消息'), SESS_B)
  const legacyRow = messageOf(after, 'req-legacy')
  assertEqual(legacyRow?.id, 'local:req-legacy', '脏行原样留着，没被 B 认领')
  assertEqual(legacyRow?.sessionId, SESS_A, '它仍然标着 A（等快照合并去清洗）')
  assertEqual(legacyRow?.sendState, 'queued', '也不会被这次回显改成「已受理」')
  // B 自己的回显照常落成一条新行（sessionId = B）
  const fresh = after.filter(item => item.id === 'm-30')
  assertEqual(fresh.length, 1, 'B 的回显仍然正常落地')
  assertEqual(fresh[0]?.sessionId, SESS_B, '新落地的行属于 B')
})

check('⑤-3 同一 rpcId 在两个会话里各自对齐，互不认领', async () => {
  const aItems = addOptimisticUserMessage([], SESS_A, 'A 说的', 'req-same')
  const bItems = addOptimisticUserMessage([], SESS_B, 'B 说的', 'req-same')
  // 各自的流里各来一条同 rpcId 的回显：只认自己会话那一行
  const updatedA = applyFollowEvent(aItems, userEcho(30, 'req-same', 'A 说的'), SESS_A)
  const updatedB = applyFollowEvent(bItems, userEcho(40, 'req-same', 'B 说的'), SESS_B)
  assertEqual(messageOf(updatedA, 'req-same')?.id, 'm-30', 'A 的行对齐 A 的回显')
  assertEqual(messageOf(updatedA, 'req-same')?.sessionId, SESS_A, '替换后仍属于 A')
  assertEqual(messageOf(updatedB, 'req-same')?.id, 'm-40', 'B 的行对齐 B 的回显')
  assertEqual(updatedA.length, 1, 'A 的列表只被替换，没多出行')
  assertEqual(updatedB.length, 1, 'B 的列表也只被替换，没多出行')
  // 两个列表是两套数据，谁也改不到谁
  assertTrue(updatedA !== updatedB, '两条独立的时间线')
  // A 受理后清发送中，不影响 B 那一份
  const clearedA = clearSendState(aItems, 'req-same')
  assertEqual(messageOf(clearedA, 'req-same')?.sendState, undefined, 'A 受理后清掉发送中')
  assertEqual(messageOf(bItems, 'req-same')?.sendState, 'queued', 'B 不受 A 的受理影响')
})

/* ════════════════════════════════════════════════════════════════════════
 * 附. 每会话登记表 + 调试计数
 * ════════════════════════════════════════════════════════════════════════ */

check('F1 登记表按会话落格；只有活动会话才「显示」', async () => {
  const registry = new Map<string, RemoteTranscriptState>()
  assertEqual(
    commitSessionTranscript(registry, SESS_A, SESS_B, transcript()),
    { stored: true, shown: false },
    '存进 A，但当前显示 B → 不当面',
  )
  assertEqual(
    commitSessionTranscript(registry, SESS_B, SESS_B, transcript()),
    { stored: true, shown: true },
    '当前就是 B → 当面',
  )
  assertEqual(
    commitSessionTranscript(registry, '', SESS_B, transcript()),
    { stored: false, shown: false },
    '空 sessionId 无处安放',
  )
  assertEqual([...registry.keys()].sort(), [SESS_A, SESS_B], '两张格子都在')
})

check('F2 上限：超出后淘汰最旧的，但永远不动活动会话', async () => {
  const registry = new Map<string, RemoteTranscriptState>()
  for (const id of ['s1', 's2', 's3', 's4']) commitSessionTranscript(registry, id, 's4', transcript())
  assertEqual(trimSessionTranscripts(registry, 's4', 2), ['s1', 's2'], '先淘汰最老的')
  assertEqual([...registry.keys()].sort(), ['s3', 's4'], '活动会话 s4 保住')
  assertEqual(trimSessionTranscripts(registry, 's4', 0), ['s3'], 'limit=0 也只能动非活动的')
  assertEqual([...registry.keys()], ['s4'], 's4 还在')
})

check('H1 计数默认全 0；记账逐项累加且 total 求和', async () => {
  resetSessionDrops()
  assertEqual(
    sessionDropSnapshot(),
    { frame: 0, staleFlow: 0, staleAction: 0, cache: 0, echo: 0, total: 0 },
    '默认全 0',
  )
  noteSessionDrop('frame')
  noteSessionDrop('staleFlow')
  noteSessionDrop('staleFlow')
  noteSessionDrop('cache')
  noteSessionDrop('staleAction')
  noteSessionDrop('echo')
  assertEqual(
    sessionDropSnapshot(),
    { frame: 1, staleFlow: 2, staleAction: 1, cache: 1, echo: 1, total: 6 },
    '逐项累加 + total',
  )
})

check('H2 __dsDebug.sessionDrops 是活视图（getter），reset 能清零', async () => {
  resetSessionDrops()
  const debug = (globalThis as unknown as { __dsDebug?: Record<string, unknown> }).__dsDebug
  assertTrue(debug !== undefined, '__dsDebug 已挂上')
  noteSessionDrop('frame')
  const live = debug?.sessionDrops as { frame: number; total: number }
  assertEqual(live.frame, 1, '读到的就是当下值')
  assertEqual(live.total, 1, 'total 同步')
  const reset = debug?.resetSessionDrops as (() => void) | undefined
  assertTrue(reset !== undefined, 'reset 入口可用')
  reset?.()
  assertEqual((debug?.sessionDrops as { total: number }).total, 0, 'reset 之后清零')
})

check('H3 记账全程不产生任何日志（默认静默）', async () => {
  logCalls = 0
  resetSessionDrops()
  for (let i = 0; i < 50; i += 1) noteSessionDrop('staleFlow')
  assertEqual(logCalls, 0, `记账不该产生日志（实际 ${logCalls} 次）`)
})

check('H4 全程没发过任何网络请求', async () => {
  assertEqual(fetchCalls, 0, `这批代码不该联网（实际 ${fetchCalls} 次）`)
})

/* ── 跑 ───────────────────────────────────────────────────────────────── */

const main = async (): Promise<void> => {
  let failures = 0
  for (const item of checks) {
    try {
      await item.run()
      realLog(`PASS  ${item.name}`)
    } catch (error) {
      failures += 1
      realError(`FAIL  ${item.name}`)
      realError(`      ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  realLog(`\n${checks.length - failures} PASS / ${failures} FAIL / ${checks.length} TOTAL`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
