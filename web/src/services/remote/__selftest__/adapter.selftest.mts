/**
 * 远程数据层自测（tsx，不联网、不起服务）。
 *
 * 跑法（workdir = projects\deepseek-tablet\web）：
 *   npx tsx src/services/remote/__selftest__/adapter.selftest.mts
 *
 * 覆盖：
 *   1. `session/follow` 快照 → `ChatItem[]`（V3 记录形状照 fixture
 *      `packages/plugin/tests/fixtures/session-v3-snapshot.json`）
 *   2. 增量帧：`turn/start` / `assistant-stream`（start→chunk→end）/ `tool-call-delta`
 *      / `tool/result` / `assistant/message` / `turn/end`
 *   3. `$events`：`ready` / `emit` / `waterfall approval/request` / `cancel`
 *   4. 参数包装（input-B §0.3）：`session/list` / `session/prompt` / `session/follow` /
 *      `session/page` / `$events/result` 的 args 形状
 *   5. 错误码 → 中文文案（`METHOD_NOT_FOUND` / `CAPABILITY_NOT_SUPPORTED` /
 *      `RPC_TIMEOUT` / `PERMISSION_NOT_PENDING`）与官方 envelope 拆包
 */

import {
  createTranscriptState,
  eventClientIdOf,
  forwardedSessionEvent,
  hasVisibleMessageText,
  historyEntriesFromRecords,
  markSendState,
  oldestSeqOfItems,
  parseSnapshot,
  pendingApprovals,
  reduceEventsItem,
  reduceFollowItem,
  reduceSnapshot,
  resolveApprovalItem,
  runningForFollowItem,
  addOptimisticUserMessage,
  type ChatItem,
  type ChatMessage,
  type ToolActivity,
} from '../adapter.js'
import {
  cancelSession,
  describeRemoteError,
  listSessions,
  openFollow,
  openEvents,
  pageHistory,
  respondApproval,
  sendPrompt,
  type RemoteCallTarget,
} from '../sessionsApi.js'
import { useRemotePaging, useRemoteStore } from '../store.js'
import { forkPointBeforePrompt, messageActionPoints } from '../messageActions.js'

/* ── 极简断言器（与 connection.selftest.mts 同款） ─────────────────────── */

const checks: Array<{ name: string; run: () => Promise<void> }> = []
const check = (name: string, run: () => Promise<void>): void => {
  checks.push({ name, run })
}

const fail = (message: string): never => {
  throw new Error(message)
}

const assertEqual = (actual: unknown, expected: unknown, label: string): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}

const assertTrue = (value: boolean, label: string): void => {
  if (!value) fail(label)
}

const assertContains = (haystack: string, needle: string, label: string): void => {
  if (!haystack.includes(needle)) fail(`${label}：${JSON.stringify(haystack)} 不包含 ${JSON.stringify(needle)}`)
}

const codeOfError = (error: unknown): string =>
  typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : '<none>'

const sessionId = 'sess-1'

const messageRows = (items: ChatItem[]): ChatMessage[] =>
  items.flatMap(item => (item.kind === 'message' ? [item] : []))

const toolRows = (items: ChatItem[]): ToolActivity[] =>
  items.flatMap(item => (item.kind === 'tool' ? [item] : []))

/* ── fixture：V3 快照（形状照 packages/plugin/tests/fixtures/session-v3-snapshot.json） ── */

const snapshotFixture = {
  type: 'snapshot',
  cursor: 4,
  throughSeq: 4,
  hasMore: true,
  header: { version: 3, sessionId, agentPreset: 'ptc', delegationDepth: 0 },
  assistantStream: { revision: 0 },
  records: [
    { type: 'event', event: { type: 'turn/start', seq: 1, time: 1_000, data: { turn: 1 } } },
    {
      type: 'event',
      event: {
        type: 'user/message',
        seq: 2,
        time: 1_010,
        data: {
          turn: 1,
          message: {
            id: 'msg-user-1',
            role: 'user',
            source: { kind: 'user', rpcId: 'rpc-0' },
            content: [{ type: 'text', text: '你好，帮我看看目录' }],
          },
        },
      },
    },
    {
      type: 'event',
      event: {
        type: 'assistant/message',
        seq: 3,
        time: 1_020,
        data: {
          turn: 1,
          step: 1,
          usage: { inputTokens: 120, outputTokens: 40 },
          message: {
            id: 'msg-asst-1',
            role: 'assistant',
            content: [{ type: 'text', text: '目录里有两个文件。' }],
          },
        },
      },
    },
    { type: 'event', event: { type: 'turn/end', seq: 4, time: 1_030, data: { turn: 1, reason: { kind: 'completed' } } } },
  ],
}

/* ── 1. 快照 ──────────────────────────────────────────────────────────── */

check('快照：turn/start + user/message + assistant/message + turn/end → 2 行，turn 已收尾', async () => {
  const snapshot = parseSnapshot(snapshotFixture)
  assertTrue(snapshot !== null, 'parseSnapshot 应认出 snapshot')
  const state = reduceSnapshot(snapshot!, sessionId)
  const messages = messageRows(state.items)
  assertEqual(messages.length, 2, '两条消息行')
  assertEqual(messages[0]?.role, 'user', '第一条是用户')
  assertEqual(messages[0]?.text, '你好，帮我看看目录', '用户文本')
  assertEqual(messages[0]?.requestRpcId, 'rpc-0', '用户行保留 requestRpcId（乐观行对账用）')
  assertEqual(messages[1]?.role, 'assistant', '第二条是助手')
  assertEqual(messages[1]?.text, '目录里有两个文件。', '助文本')
  assertEqual(messages[1]?.turnEnd?.reason, 'completed', 'turn/end 已落到行上')
  assertEqual(messages[1]?.turnEnd?.seq, 4, '从回复分叉使用权威的回合边界')
  assertEqual(state.cursor, 4, '游标 = 最大 seq')
  assertEqual(state.transient, 0, '快照没有瞬态 chunk')
})

check('快照：host 不给 snapshot 时 parseSnapshot 返回 null（调用方按协议报错）', async () => {
  assertEqual(parseSnapshot({ type: 'event', event: {} }), null, 'type ≠ snapshot')
  assertEqual(parseSnapshot(null), null, 'null')
})

check('消息分叉仅取每轮最后一条回复，重答使用原问题之前的完整边界', async () => {
  const snapshot = parseSnapshot(snapshotFixture)!
  const [firstPrompt, firstReply] = messageRows(reduceSnapshot(snapshot, sessionId).items)
  const nextPrompt: ChatMessage = { ...firstPrompt, id: 'next-prompt', nativeSeq: 6, turnEnd: undefined }
  const middleReply: ChatMessage = { ...firstReply, id: 'middle', nativeSeq: 7, turnEnd: { reason: 'completed', time: 2_000, seq: 9 } }
  const finalReply: ChatMessage = { ...middleReply, id: 'final', nativeSeq: 8 }
  const actions = messageActionPoints([firstPrompt, firstReply, nextPrompt, middleReply, finalReply])
  assertEqual([...actions.branch], [['msg-asst-1', 4], ['final', 9]], '只接受权威完成边界')
  assertEqual(actions.regenerate?.prompt.id, nextPrompt.id, '重答选中原问题')
  assertEqual(messageActionPoints([firstReply, { ...nextPrompt, hasFiles: true }, finalReply]).regenerate,
    undefined, '带文件的原问题不能静默丢附件重发')
})

check('编辑首轮、后续轮次和插话时保留紧邻输入之前的持久事件', async () => {
  const types = [
    'permission/preset', 'sandbox/mode', 'approval/policy', 'agent/inbox/spliced',
    'turn/start', 'agent/inbox/spliced', 'step/start', 'system/message',
    'user/message', 'session/title', 'assistant/message', 'step/end', 'turn/end',
    'agent/inbox/spliced', 'turn/start', 'agent/inbox/spliced', 'step/start',
    'user/message', 'assistant/message', 'step/end', 'step/start',
    'agent/inbox/spliced', 'user/message',
  ]
  const history = historyEntriesFromRecords(types.map((type, seq) => ({
    type: 'event', event: { type, seq, time: seq, data: {} },
  })))
  assertEqual(forkPointBeforePrompt(history, 8), 2, '启动设置保留在新会话')
  assertEqual(forkPointBeforePrompt(history.slice(12, 17), 17), 12, '后续轮次保留上一轮结束')
  assertEqual(forkPointBeforePrompt(history, 22), 19, '插话前保留同回合已完成的步骤')
  assertEqual(forkPointBeforePrompt(history.filter(({ event }) => event.seq !== 15), 17),
    undefined, '历史缺帧时不猜测截断位置')
})

/* ── 2. 增量帧 ────────────────────────────────────────────────────────── */

const followStream = (): ReturnType<typeof reduceFollowItem> => {
  let state = reduceSnapshot(parseSnapshot(snapshotFixture)!, sessionId)
  state = reduceFollowItem(state, { type: 'event', event: { type: 'turn/start', seq: 5, time: 2_000, data: { turn: 2 } } }, sessionId)
  state = reduceFollowItem(state, {
    type: 'assistant-stream',
    frame: { type: 'start', attemptId: 'att-1', turn: 2, step: 1, startedAfterSeq: 5 },
  }, sessionId)
  return state
}

check('增量：assistant-stream 的 reasoning/text chunk 合成一行 stream 流式助手消息', async () => {
  let state = followStream()
  state = reduceFollowItem(state, {
    type: 'assistant-stream',
    frame: { type: 'chunk', attemptId: 'att-1', index: 0, time: 2_100, chunk: { type: 'reasoning-delta', text: '想一想' } },
  }, sessionId)
  state = reduceFollowItem(state, {
    type: 'assistant-stream',
    frame: { type: 'chunk', attemptId: 'att-1', index: 1, time: 2_110, chunk: { type: 'text-delta', text: '答案' } },
  }, sessionId)
  const streaming = messageRows(state.items).filter(item => item.streaming === true)
  assertEqual(streaming.length, 1, '只有一行流式消息')
  assertEqual(streaming[0]?.id, 'stream:2:1', '流式行 id 按 turn:step 合成')
  assertEqual(streaming[0]?.reasoning, '想一想', 'reasoning 累积')
  assertEqual(streaming[0]?.text, '答案', 'text 累积（text-delta 的字段名是 text）')
  assertEqual(streaming[0]?.streamingPhase, 'text', '最后一段是正文')
  assertTrue(state.transient === 2, '两个瞬态 chunk')
})

check('增量：乱序 / 重复 index 的 chunk 被丢弃（不污染正文）', async () => {
  let state = followStream()
  state = reduceFollowItem(state, {
    type: 'assistant-stream',
    frame: { type: 'chunk', attemptId: 'att-1', index: 0, time: 2_100, chunk: { type: 'text-delta', text: 'A' } },
  }, sessionId)
  const before = state.items.length
  const skipped = reduceFollowItem(state, {
    type: 'assistant-stream',
    frame: { type: 'chunk', attemptId: 'att-1', index: 5, time: 2_120, chunk: { type: 'text-delta', text: '跳号' } },
  }, sessionId)
  assertEqual(skipped.items.length, before, '跳号的 chunk 不产生新行')
  assertEqual(messageRows(skipped.items).at(-1)?.text, 'A', '正文没被跳号的 chunk 追加')
})

check('增量：tool-call-delta 立刻建一张 running 工具卡并累积参数', async () => {
  let state = followStream()
  state = reduceFollowItem(state, {
    type: 'assistant-stream',
    frame: { type: 'chunk', attemptId: 'att-1', index: 0, time: 2_100, chunk: { type: 'tool-call-delta', id: 'call_9', name: 'run_code', argumentsDelta: '{"code":' } },
  }, sessionId)
  state = reduceFollowItem(state, {
    type: 'assistant-stream',
    frame: { type: 'chunk', attemptId: 'att-1', index: 1, time: 2_110, chunk: { type: 'tool-call-delta', id: 'call_9', argumentsDelta: '"ls"}' } },
  }, sessionId)
  const tools = toolRows(state.items)
  assertEqual(tools.length, 1, '一张工具卡')
  assertEqual(tools[0]?.id, 'call_9', '行 id 用 callId（后续 tool/result 才能并到同一行）')
  assertEqual(tools[0]?.toolName, 'run_code', '工具名')
  assertEqual(tools[0]?.arguments, '{"code":"ls"}', '参数增量拼接')
  assertEqual(tools[0]?.state, 'running', '状态 running')
})

check('增量：tool/result 并回同一张卡（finished + 结果详情）', async () => {
  let state = followStream()
  state = reduceFollowItem(state, {
    type: 'assistant-stream',
    frame: { type: 'chunk', attemptId: 'att-1', index: 0, time: 2_100, chunk: { type: 'tool-call-delta', id: 'call_9', name: 'run_code', argumentsDelta: '{"code":"ls"}' } },
  }, sessionId)
  state = reduceFollowItem(state, {
    type: 'event',
    event: {
      type: 'tool/result',
      seq: 6,
      time: 2_200,
      data: {
        callId: 'call_9',
        toolName: 'run_code',
        isError: false,
        message: { role: 'tool', toolCallId: 'call_9', content: [{ type: 'text', text: 'a.txt\nb.txt' }] },
      },
    },
  }, sessionId)
  const tools = toolRows(state.items)
  assertEqual(tools.length, 1, '没有多出第二张卡')
  assertEqual(tools[0]?.state, 'finished', '状态 finished')
  assertEqual(tools[0]?.resultDetail?.text, 'a.txt\nb.txt', '结果详情')
  assertEqual(tools[0]?.resultDetail?.format, 'markdown', '结果按 markdown 渲染')
})

check('增量：assistant/message 收编流式行，turn/end(aborted) 把流式标记清掉', async () => {
  let state = followStream()
  state = reduceFollowItem(state, {
    type: 'assistant-stream',
    frame: { type: 'chunk', attemptId: 'att-1', index: 0, time: 2_100, chunk: { type: 'text-delta', text: '半截' } },
  }, sessionId)
  state = reduceFollowItem(state, {
    type: 'event',
    event: {
      type: 'assistant/message',
      seq: 7,
      time: 2_300,
      data: { turn: 2, step: 1, message: { id: 'msg-asst-2', role: 'assistant', content: [{ type: 'text', text: '完整答案' }] } },
    },
  }, sessionId)
  const afterMessage = messageRows(state.items).filter(item => item.streaming === true)
  assertEqual(afterMessage.length, 0, '权威消息到达后不再有流式行')
  assertEqual(messageRows(state.items).at(-1)?.text, '完整答案', '以权威内容为准')

  state = reduceFollowItem(state, {
    type: 'event',
    event: { type: 'turn/end', seq: 8, time: 2_400, data: { turn: 2, reason: { kind: 'aborted' } } },
  }, sessionId)
  const turnRows = messageRows(state.items).filter(item => (item.turn ?? item.replyGroup) === '2')
  assertTrue(turnRows.length > 0, 'turn 2 有行')
  assertEqual(turnRows.at(-1)?.turnEnd?.reason, 'stopped', 'aborted → stopped')
})

check('增量：turn/start / turn/end 能驱动「生成中」指示', async () => {
  assertEqual(runningForFollowItem({ type: 'event', event: { type: 'turn/start', seq: 5, time: 2_000, data: { turn: 2 } } }), true, 'turn/start → true')
  assertEqual(runningForFollowItem({ type: 'event', event: { type: 'turn/end', seq: 8, time: 2_400, data: { turn: 2 } } }), false, 'turn/end → false')
  assertEqual(runningForFollowItem({ type: 'assistant-stream', frame: { type: 'chunk' } }), undefined, '其它帧不管')
})

/* ── 3. $events（审批 / 提问 / 撤销） ──────────────────────────────────── */

check('$events：waterfall approval/request → ApprovalActivity + pendingApprovals', async () => {
  let items = followStream().items
  items = reduceEventsItem(items, {
    type: 'waterfall',
    event: 'approval/request',
    eventId: 'ev-1',
    agentId: sessionId,
    request: { toolName: 'run_code', callId: 'call_9', reason: '要执行一段代码' },
  }, sessionId)
  const approvals = items.flatMap(item => (item.kind === 'approval' ? [item] : []))
  assertEqual(approvals.length, 1, '一条审批行')
  assertEqual(approvals[0]?.id, 'approval:ev-1', '行 id 带 eventId')
  assertEqual(approvals[0]?.approvalId, 'ev-1', 'approvalId = waterfall eventId')
  assertEqual(approvals[0]?.toolName, 'run_code', '工具名')
  assertEqual(approvals[0]?.reason, '要执行一段代码', '原因')
  assertEqual(approvals[0]?.outcome, undefined, '还没处置')
  assertEqual(pendingApprovals(items), [{ eventId: 'ev-1', title: 'run_code', detail: '要执行一段代码' }], '待审批列表')
})

check('$events：其它会话的 waterfall 不串进当前时间线', async () => {
  const items = followStream().items
  const next = reduceEventsItem(items, {
    type: 'waterfall',
    event: 'approval/request',
    eventId: 'ev-2',
    agentId: 'other-session',
    request: { toolName: 'run_code' },
  }, sessionId)
  assertEqual(next, items, '不匹配的 agentId 一律忽略')
})

check('$events：cancel → 审批变 cancelled；本地应答 → allowed-once', async () => {
  let items = reduceEventsItem(followStream().items, {
    type: 'waterfall', event: 'approval/request', eventId: 'ev-3', agentId: sessionId, request: { toolName: 'write_file' },
  }, sessionId)
  items = reduceEventsItem(items, { type: 'cancel', eventId: 'ev-3' }, sessionId)
  const cancelled = items.flatMap(item => (item.kind === 'approval' ? [item] : []))[0]
  assertEqual(cancelled?.outcome, 'cancelled', 'cancel → cancelled')
  assertEqual(pendingApprovals(items).length, 0, 'cancel 后不再是待处理')

  const resolved = resolveApprovalItem(items, 'ev-3', 'allowed-once')
  const after = resolved.flatMap(item => (item.kind === 'approval' ? [item] : []))[0]
  assertEqual(after?.outcome, 'allowed-once', '本地应答落定')
})

check('$events：ready 取 clientId，emit 解析成目录增量', async () => {
  assertEqual(eventClientIdOf({ type: 'ready', clientId: 'client-1', host: { home: '/root' } }), 'client-1', 'ready → clientId')
  assertEqual(eventClientIdOf({ type: 'emit' }), undefined, '非 ready 无 clientId')
  assertEqual(
    forwardedSessionEvent({ type: 'emit', event: 'api-session/status', args: [sessionId, true] }),
    { kind: 'status', sessionId, running: true },
    'api-session/status',
  )
  assertEqual(
    forwardedSessionEvent({ type: 'emit', event: 'api-session/removed', args: [sessionId] }),
    { kind: 'removed', sessionId },
    'api-session/removed',
  )
  assertEqual(
    forwardedSessionEvent({ type: 'emit', event: 'approval/request', args: ['x'] }),
    undefined,
    '不认识的事件返回 undefined（不猜）',
  )
})

/* ── 4. 乐观消息 / 分页锚点 ───────────────────────────────────────────── */

check('乐观消息：addOptimisticUserMessage 可被 markSendState 标成 failed', async () => {
  const items = addOptimisticUserMessage([], sessionId, '在吗', 'rpc-7')
  assertEqual(items.length, 1, '一行')
  const optimistic = messageRows(items)[0]
  assertEqual(optimistic?.id, 'local:rpc-7', '本地行 id')
  assertEqual(optimistic?.sendState, 'queued', '初始 queued')
  const failed = markSendState(items, 'rpc-7', 'failed', '远端拒绝了')
  assertEqual(messageRows(failed)[0]?.sendState, 'failed', '标成 failed')
  assertEqual(messageRows(failed)[0]?.sendError, '远端拒绝了', '带可读原因')
})

check('分页锚点：oldestSeqOfItems 取最旧 seq（含 historyEntriesFromRecords 展开）', async () => {
  const state = reduceSnapshot(parseSnapshot(snapshotFixture)!, sessionId)
  // `turn/start` 不产生行。分页仍须从该事件起算，避免重复请求同一页。
  assertEqual(oldestSeqOfItems(state.items), 2, '最旧可见行 = 用户消息的 seq 2')
  assertEqual(state.historyBeforeSeq, 1, '分页锚点 = 最旧的持久事件')
  const entries = historyEntriesFromRecords(snapshotFixture.records)
  assertEqual(entries.length, 4, '四条记录都展开了')
  assertEqual(hasVisibleMessageText('  \u200b '), false, '纯空白/零宽不算可见文本')
  assertEqual(hasVisibleMessageText('hi'), true, '正常文本可见')
})

check('回显先于 RPC 超时时，迟到的发送错误不能标记主机消息', async () => {
  const items = messageRows(reduceSnapshot(parseSnapshot(snapshotFixture)!, sessionId).items)
  const echo = items.find((item) => item.role === 'user')!
  const accepted = [{ ...echo, requestRpcId: 'already-received' }]
  assertEqual(markSendState(accepted, 'already-received', 'unconfirmed', 'timeout'), accepted, 'Host 回显仍然已送达')
})

check('空状态：createTranscriptState 是干净的', async () => {
  const state = createTranscriptState()
  assertEqual(state.items.length, 0, '没有行')
  assertEqual(state.cursor, -1, '游标 -1')
  assertEqual(state.attempt, undefined, '没有 attempt')
})

/* ── 5. sessionsApi：参数包装（input-B §0.3） ─────────────────────────── */

interface RecordedCall {
  method: string
  params: unknown
}

interface RecordedStream {
  endpoint: string
  payload: unknown
}

const fakeTarget = (reply: unknown = { ok: true, value: {} }): {
  target: RemoteCallTarget
  calls: RecordedCall[]
  streams: RecordedStream[]
} => {
  const calls: RecordedCall[] = []
  const streams: RecordedStream[] = []
  const target: RemoteCallTarget = {
    rpc: async <T,>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params })
      if (reply instanceof Error) throw reply
      return reply as T
    },
    openStream: async (endpoint: string, payload: unknown) => {
      streams.push({ endpoint, payload })
      return { streamId: 'stream-1', close: async () => undefined }
    },
  }
  return { target, calls, streams }
}

check('session/list：走 harness.remote.call + {endpoint, payload:{args:{_request:{}}}}', async () => {
  const { target, calls } = fakeTarget({
    ok: true,
    value: { items: [{ sessionId: 's1', updatedAt: 5, projections: { values: { title: '远端会话' } } }] },
  })
  const rows = await listSessions(target)
  assertEqual(calls.length, 1, '一次调用')
  assertEqual(calls[0]?.method, 'harness.remote.call', '载体方法')
  assertEqual(
    calls[0]?.params,
    { endpoint: 'session/list', payload: { args: { _request: {} } } },
    '参数包装必须带 args._request',
  )
  assertEqual(rows[0]?.sessionId, 's1', 'sessionId')
  assertEqual(rows[0]?.title, '远端会话', '标题从 projections.values.title 兜底')
})

check('session/prompt：requestId / mode / content / 时区都在 args.request 里', async () => {
  const { target, calls } = fakeTarget()
  await sendPrompt(target, 's1', '你好', [], { requestId: 'rpc-1' })
  const params = calls[0]?.params as { endpoint: string; payload: { args: { request: Record<string, unknown> } } }
  assertEqual(params.endpoint, 'session/prompt', 'endpoint')
  const request = params.payload.args.request
  assertEqual(request.requestId, 'rpc-1', 'requestId 幂等键')
  assertEqual(request.sessionId, 's1', 'sessionId')
  assertEqual(request.mode, 'queue', '默认排队')
  assertEqual(request.content, [{ type: 'text', text: '你好' }], 'content 形状')
})

check('session/prompt：空文本且无附件 → INVALID_ARGUMENT（不发给 Host）', async () => {
  const { target, calls } = fakeTarget()
  let code = '<none>'
  try {
    await sendPrompt(target, 's1', '', [])
  } catch (error) {
    code = codeOfError(error)
  }
  assertEqual(code, 'INVALID_ARGUMENT', '本地就拦住')
  assertEqual(calls.length, 0, '没有发请求')
})

check('session/follow：开流带 args.request.address + assistantStream', async () => {
  const { target, streams } = fakeTarget()
  await openFollow(target, 's1', { assistantStream: true })
  assertEqual(streams.length, 1, '开了一条流')
  assertEqual(streams[0]?.endpoint, 'session/follow', 'endpoint')
  assertEqual(
    streams[0]?.payload,
    { args: { request: { address: { kind: 'session', sessionId: 's1' }, maxMessages: 60, assistantStream: true } } },
    'follow 参数',
  )
})

check('$events：开流只用空 args（与 client-core 一致）', async () => {
  const { target, streams } = fakeTarget()
  await openEvents(target)
  assertEqual(streams[0]?.endpoint, '$events', 'endpoint')
  assertEqual(streams[0]?.payload, { args: {} }, '空 args')
})

check('session/page：上翻带 beforeSeq / throughSeq / address', async () => {
  const { target, calls } = fakeTarget({ ok: true, value: { records: [], hasMore: false } })
  const page = await pageHistory(target, 's1', { beforeSeq: 4, throughSeq: 9 })
  assertEqual(page.hasMore, false, 'hasMore')
  const params = calls[0]?.params as { endpoint: string; payload: { args: { request: Record<string, unknown> } } }
  assertEqual(params.endpoint, 'session/page', 'endpoint')
  assertEqual(
    params.payload.args.request,
    { address: { kind: 'session', sessionId: 's1' }, throughSeq: 9, beforeSeq: 4, maxMessages: 60 },
    'page 参数',
  )
})

check('session/cancel：accepted 不为 true 就报 INVALID_RESPONSE', async () => {
  const ok = fakeTarget({ ok: true, value: { accepted: true } })
  await cancelSession(ok.target, 's1')
  assertEqual((ok.calls[0]?.params as { endpoint: string }).endpoint, 'session/cancel', 'endpoint')

  const bad = fakeTarget({ ok: true, value: { accepted: false } })
  let code = '<none>'
  try {
    await cancelSession(bad.target, 's1')
  } catch (error) {
    code = codeOfError(error)
  }
  assertEqual(code, 'INVALID_RESPONSE', '未被受理')
})

check('$events/result：allow_once → allowed-once，deny → rejected（v1 只允许这两个值）', async () => {
  const allow = fakeTarget()
  await respondApproval(allow.target, { clientId: 'c1', eventId: 'ev-1', decision: 'allow_once' })
  assertEqual(
    allow.calls[0]?.params,
    {
      endpoint: '$events/result',
      payload: { args: { clientId: 'c1', eventId: 'ev-1', outcome: { kind: 'result', value: 'allowed-once' } } },
    },
    '允许一次',
  )
  const deny = fakeTarget()
  await respondApproval(deny.target, { clientId: 'c1', eventId: 'ev-2', decision: 'deny' })
  const denyArgs = (deny.calls[0]?.params as { payload: { args: { outcome: { value: string } } } }).payload.args
  assertEqual(denyArgs.outcome.value, 'rejected', '拒绝')
})

check('$events/result：没有 clientId 时不发请求（fail-closed）', async () => {
  const { target, calls } = fakeTarget()
  let code = '<none>'
  try {
    await respondApproval(target, { clientId: '', eventId: 'ev-1', decision: 'allow_once' })
  } catch (error) {
    code = codeOfError(error)
  }
  assertEqual(code, 'EVENT_STREAM_NOT_READY', '缺 clientId 拦住')
  assertEqual(calls.length, 0, '没有发请求')
})

/* ── 6. 错误映射 / envelope 拆包 ──────────────────────────────────────── */

check('官方 envelope 的 ok:false 被拆成带 code 的错误', async () => {
  const { target } = fakeTarget({ ok: false, error: { code: 'PERMISSION_NOT_PENDING', message: 'gone' } })
  let code = '<none>'
  try {
    await listSessions(target)
  } catch (error) {
    code = codeOfError(error)
  }
  assertEqual(code, 'PERMISSION_NOT_PENDING', '码直传')
})

check('四个必答错误码都有中文文案 + i18n key', async () => {
  for (const code of ['METHOD_NOT_FOUND', 'CAPABILITY_NOT_SUPPORTED', 'RPC_TIMEOUT', 'PERMISSION_NOT_PENDING']) {
    const info = describeRemoteError({ code, message: '' })
    assertTrue(info.i18nKey.startsWith('remote.error.'), `${code} 有 i18n key`)
    assertTrue(/[\u4e00-\u9fa5]/u.test(info.text), `${code} 的文案是中文`)
  }
  assertContains(describeRemoteError({ code: 'PERMISSION_NOT_PENDING' }).text, '失效', 'PERMISSION_NOT_PENDING 的语义')
  assertContains(describeRemoteError({ code: 'METHOD_NOT_FOUND', message: 'no such method' }).text, 'no such method', '保留 Host 原始 message')
  assertEqual(describeRemoteError({ code: 'SOMETHING_NEW' }).code, 'SOMETHING_NEW', '未知码原样保留')
})

/* ── 7. store：没连上时的行为（不抛、留可读错误、状态不乱） ───────────── */

check('store：未连接时 send/openSession/respondApproval 都不抛，只在 state.error 留可读错误', async () => {
  const before = useRemoteStore.getState()
  assertEqual(before.phase, 'idle', '初始 idle')
  assertEqual(before.items, [], '初始没有行')
  assertEqual(before.error, null, '初始没有错误')

  await before.send('你好')
  const afterSend = useRemoteStore.getState()
  assertEqual(afterSend.error?.code, 'NOT_CONNECTED', 'send 的码')
  assertContains(afterSend.error?.message ?? '', '还没有连接', 'send 的中文文案')
  assertEqual(afterSend.phase, 'idle', '操作级失败不改 phase')
  assertEqual(afterSend.items.length, 0, '没连上就不该有乐观行')

  await afterSend.openSession('s1')
  assertEqual(useRemoteStore.getState().error?.code, 'NOT_CONNECTED', 'openSession 的码')

  await useRemoteStore.getState().respondApproval('ev-1', 'deny')
  assertEqual(useRemoteStore.getState().error?.code, 'NOT_CONNECTED', 'respondApproval 的码')

  useRemoteStore.getState().disconnect()
  assertEqual(useRemoteStore.getState().error, null, 'disconnect 清错误')
  assertEqual(useRemotePaging.getState().hasMore, false, '分页状态复位')
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
