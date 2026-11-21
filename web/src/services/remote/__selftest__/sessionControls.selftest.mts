/**
 * 会话内控制（W2）自测：模型 / 权限 / 斜杠命令 / 排队 / 用户提问 / 能力降级。
 *
 * 跑法（workdir = projects\deepseek-tablet\web）：
 *   npx tsx src/services/remote/__selftest__/sessionControls.selftest.mts
 *
 * 覆盖（对应任务书的五条自测要求）：
 *   A. 模型分组解析
 *     1. `session/modelCatalog` 完整形状（两组 / efforts / failures / routableProviders）；
 *     2. 缺 `default` 时用第一组第一个模型兜底；形状不合规 → `null`；
 *     3. 显示名解析与「找不到就回落到 model id」；
 *     4. 投影 `modelSelection` 的三种形状（`next` / `lastUsed` / 直接对象）。
 *   B. 斜杠命令过滤
 *     5. `commands/list` 归一化（裸数组 / `{commands}` / 去掉前导 `/` / 去重 / 丢空名）；
 *     6. `slashQuery`：`/`、`/per`、`/per x`、`hi /x`、前导空格；
 *     7. `filterCommands` 前缀优先、大小写不敏感、空查询原样。
 *   C. 队列三操作（`session/updateQueue` 的 steer / remove + 清空 + 能力缺失）
 *     8. `inbox` 投影解析：只取 `next-turn`、过滤非本级来源、拼接 preview；
 *     9. `steer` 的端点与参数形状（`{request:{sessionId,itemId,action:{kind}}}`）+ 本地摘除；
 *    10. `remove` 同上；`queue-item-not-found` 只摘除不写 error；
 *    11. `clearQueue()` 逐条 remove；
 *    12. `METHOD_NOT_FOUND` → `queueAccess:'unavailable'` 且队列条隐藏。
 *   D. 提问状态机（`attachWait` / `$events/result` / `userQuestions/answer` / 到期 / cancel）
 *    13. waterfall 解析：限时（`wait.timed`+`callId`）/ 非限时 / 别的会话 / 非提问；
 *    14. 到达 → `claiming` → 开 `userQuestions/attachWait` → 首帧 `{remainingMs}` → `open` + deadline；
 *    15. 窗口内作答走 `$events/result`（`kind:'result'` + `answers`），不走 `answer` 端点；
 *    16. 投影 `continued` → 作答改走 `userQuestions/answer`，阶段 `queued`；
 *    17. 投影 `settled` → 阶段 `answered`，不再可答；
 *    18. `{type:'cancel'}` → 阶段 `cancelled` 且作答不再发请求；
 *    19. 窗口到期 → 阶段 `expired` + 回一组 `ASK_TIMED_OUT`；过期后作答被拒；
 *    20. 没有 `attachWait`（`METHOD_NOT_FOUND`）→ `questionAccess:'unavailable'`，
 *        仍退回普通瀑布用 `$events/result` 应答。
 *   E. 能力门禁
 *    21. 所有端点 `METHOD_NOT_FOUND` → 三个入口全隐藏（`shows*` 全 false）；
 *    22. 正常数据 → 模型 / 权限 / 队列入口都可见；`probe()` 重复调用不重复拉取。
 *
 * 结尾按仓库约定设置真实退出码（`process.exit(failures === 0 ? 0 : 1)`）。
 */

import type { StreamEventPayload } from '../core/index.js'
import {
  allQuestionsAnswered,
  applyControlFrame,
  bindSessionControls,
  buildQuestionAnswer,
  commandLineOf,
  filterCommands,
  findModelEntry,
  ingestEventsItem,
  isQuestionTerminal,
  isUnsupportedError,
  modelDisplayName,
  parseCommandList,
  parseInboxQueue,
  parseModelCatalog,
  parsePermissionCatalog,
  parseQuestionWaterfall,
  permissionDisplayName,
  permissionProjectionOf,
  questionKey,
  selectControlSession,
  showsCommandCompletion,
  showsModelCapsule,
  showsPermissionCapsule,
  showsQueueDock,
  slashQuery,
  unbindSessionControls,
  useChatControls,
  usageOfProjection,
  CONTROL_STREAM_ENDPOINT,
} from '../sessionControls.js'
import type { RemoteCallTarget, RemoteStreamHandle } from '../sessionsApi.js'

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

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/** 让若干轮微任务先跑完（`void claimQuestion()` 是 fire-and-forget） */
const tick = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
  await sleep(0)
}

/* ── 假 target + 假流注册器 ───────────────────────────────────────────── */

type Reply = { ok: true; value?: unknown } | { ok: false; code: string; message?: string }

interface RecordedCall {
  endpoint: string
  args: Record<string, unknown>
}

interface StreamEntry {
  streamId: string
  endpoint: string
  handler: ((payload: StreamEventPayload) => void) | null
  closed: boolean
}

interface Harness {
  target: RemoteCallTarget
  calls: RecordedCall[]
  streams: StreamEntry[]
  /** 某端点被调用了几次 */
  count(endpoint: string): number
  /** 最近一次该端点的 args */
  lastArgs(endpoint: string): Record<string, unknown> | undefined
  /** 往某条流推一帧（模拟 Host → Client） */
  push(streamId: string, payload: StreamEventPayload): void
  /** 该端点的下一次应答改掉（按次数队列） */
  rewrite(endpoint: string, reply: Reply): void
}

/**
 * 造一个假链路。默认所有端点回 `{ok:true,value:{}}`；
 * `openStream()` 默认成功（返回一条可手工推帧的假流），`failStreams` 里的端点按指定错误码拒绝
 * —— 「Host 没有 `userQuestions/attachWait`」在线上就是 `stream.open` 直接 `METHOD_NOT_FOUND`。
 */
const harness = (replies: Record<string, Reply> = {}, failStreams: Record<string, string> = {}): Harness => {
  const calls: RecordedCall[] = []
  const streams: StreamEntry[] = []
  const current: Record<string, Reply> = { ...replies }
  const target: RemoteCallTarget = {
    rpc: async <T,>(method: string, params?: unknown): Promise<T> => {
      if (method !== 'harness.remote.call') return {} as T
      const envelope = params as { endpoint: string; payload: { args: Record<string, unknown> } }
      calls.push({ endpoint: envelope.endpoint, args: envelope.payload.args })
      const reply = current[envelope.endpoint]
      if (reply === undefined) return { ok: true, value: {} } as T
      if (reply.ok) return (reply.value === undefined ? { ok: true } : { ok: true, value: reply.value }) as T
      return { ok: false, error: { code: reply.code, message: reply.message ?? reply.code } } as T
    },
    openStream: async (endpoint: string): Promise<RemoteStreamHandle> => {
      const failure = failStreams[endpoint]
      if (failure !== undefined) throw Object.assign(new Error(failure), { code: failure })
      const entry: StreamEntry = { streamId: `stream-${streams.length + 1}`, endpoint, handler: null, closed: false }
      streams.push(entry)
      return {
        streamId: entry.streamId,
        close: async (): Promise<void> => {
          entry.closed = true
          entry.handler?.({ type: 'closed', reason: 'cancelled' })
          entry.handler = null
        },
      }
    },
  }
  return {
    target,
    calls,
    streams,
    count: (endpoint) => calls.filter((call) => call.endpoint === endpoint).length,
    lastArgs: (endpoint) => [...calls].reverse().find((call) => call.endpoint === endpoint)?.args,
    push: (streamId, payload) => {
      const entry = streams.find((item) => item.streamId === streamId)
      // 用 `throw` 而不是 `fail()`：TS 对 never 返回值的收窄在对象字面量里不生效
      if (entry === undefined) throw new Error(`没有这条流：${streamId}`)
      entry.handler?.(payload)
    },
    rewrite: (endpoint, reply) => {
      current[endpoint] = reply
    },
  }
}

/**
 * 把 harness 接到 `sessionControls` 上（模拟 `store.ts` 的 `bindSessionControls`）。
 *
 * `registerStreamSink` 就是 `store.ts` 那个 API 的替身：句柄还没返回就到的帧先缓冲，
 * 注册时倒出来 —— 与真实现同语义，测试里才能覆盖「首帧比 sink 早到」的情形。
 */
const bind = (fake: Harness, options: { clientId?: string | null } = {}): void => {
  const buffered = new Map<string, StreamEventPayload[]>()
  bindSessionControls({
    target: fake.target,
    registerStreamSink: (streamId, onPayload) => {
      const entry = fake.streams.find((item) => item.streamId === streamId)
      if (entry === undefined) throw new Error(`注册了一个不存在的流：${streamId}`)
      entry.handler = onPayload
      for (const payload of buffered.get(streamId) ?? []) onPayload(payload)
      buffered.delete(streamId)
      return () => {
        entry.handler = null
      }
    },
    eventClientId: () => options.clientId ?? 'client-test',
  })
}

/** 一条提问 waterfall（形状照 `harness-questions.ts` 与 adapter 的 `QuestionActivity`）。 */
const questionWaterfall = (
  overrides: {
    sessionId?: string
    eventId?: string
    callId?: string
    timed?: boolean
    multiSelect?: boolean
  } = {},
): Record<string, unknown> => ({
  type: 'waterfall',
  event: 'user-questions/request',
  eventId: overrides.eventId ?? 'evt-1',
  agentId: overrides.sessionId ?? 'sess-1',
  request: {
    ...(overrides.timed === false
      ? {}
      : { wait: { timed: true, callId: overrides.callId ?? 'call-1' } }),
    questions: [
      {
        id: 'q1',
        header: '权限',
        question: '这次要用哪种权限跑？',
        options: [
          { label: '只读', description: '只允许读取' },
          { label: '工作区可写', description: '允许改工作区内文件' },
        ],
        multiSelect: overrides.multiSelect === true,
      },
    ],
  },
})

/* ── A. 模型分组解析 ─────────────────────────────────────────────────── */

const CATALOG = {
  default: { provider: 'deepseek', model: 'deepseek-chat' },
  routableProviders: ['deepseek', 'openai'],
  groups: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-chat', name: 'DeepSeek Chat' },
        {
          id: 'deepseek-reasoner',
          name: 'DeepSeek Reasoner',
          description: '带长思考',
          reasoning: {
            defaultEffort: 'medium',
            efforts: [
              { id: 'low', name: '低' },
              { id: 'medium', name: '中', description: '默认' },
            ],
          },
        },
      ],
    },
    {
      id: 'openai',
      name: 'OpenAI',
      models: [{ id: 'gpt-test', name: 'GPT Test' }],
    },
  ],
  failures: [{ id: 'broken', name: 'Broken', message: '拉取失败：401' }],
}

check('A1 parseModelCatalog：分组 / efforts / failures / routable', async () => {
  const catalog = parseModelCatalog(CATALOG)
  assertTrue(catalog !== null, '完整形状不该返回 null')
  if (catalog === null) return
  assertEqual(catalog.defaultModel, { provider: 'deepseek', model: 'deepseek-chat' }, '默认模型')
  assertTrue(catalog.routable, 'routableProviders 命中 → routable true')
  assertEqual(
    catalog.groups.map((group) => [group.id, group.name, group.models.length]),
    [
      ['deepseek', 'DeepSeek', 2],
      ['openai', 'OpenAI', 1],
    ],
    '分组结构',
  )
  const reasoner = catalog.groups[0]?.models[1]
  assertEqual(reasoner?.efforts.map((effort) => effort.id), ['low', 'medium'], '思考强度列表')
  assertEqual(reasoner?.defaultEffort, 'medium', '默认思考强度')
  assertEqual(catalog.failures[0]?.message, '拉取失败：401', 'failures 文案')
})

check('A2 parseModelCatalog：缺 default 用首项兜底 / 形状不合规返回 null', async () => {
  const fallback = parseModelCatalog({
    groups: [{ id: 'p', name: 'P', models: [{ id: 'm', name: 'M' }] }],
  })
  assertEqual(fallback?.defaultModel, { provider: 'p', model: 'm' }, '兜底默认模型')
  assertTrue(fallback?.routable === true, '没有 routableProviders 时按「组非空」推定')

  assertEqual(parseModelCatalog({}), null, '空对象')
  assertEqual(parseModelCatalog({ default: { provider: '', model: 'x' } }), null, 'provider 为空')
  assertEqual(parseModelCatalog(null), null, 'null')
  // 组里所有模型都非法 → 整组丢掉
  const empty = parseModelCatalog({ default: { provider: 'p', model: 'm' }, groups: [{ id: 'p', models: [{}] }] })
  assertEqual(empty?.groups.length, 0, '非法模型被丢掉')
})

check('A3 显示名：优先目录里的 name，找不到回落 model id', async () => {
  const catalog = parseModelCatalog(CATALOG)
  assertEqual(
    modelDisplayName(catalog, { provider: 'openai', model: 'gpt-test' }),
    'GPT Test',
    '目录里的显示名',
  )
  assertEqual(
    modelDisplayName(catalog, { provider: 'gone', model: 'unknown-model' }),
    'unknown-model',
    '找不到分组时回落 model id',
  )
  assertEqual(modelDisplayName(catalog, null), null, '没有当前模型')
  assertEqual(findModelEntry(catalog, null), null, 'findModelEntry(null)')
})

check('A4 投影 modelSelection 的三种形状', async () => {
  const { modelSelectionOfProjection } = await import('../sessionControls.js')
  assertEqual(
    modelSelectionOfProjection({ next: { provider: 'a', model: 'b' } }),
    { provider: 'a', model: 'b' },
    'next',
  )
  assertEqual(
    modelSelectionOfProjection({ lastUsed: { provider: 'a', model: 'b', reasoningEffort: 'low' } }),
    { provider: 'a', model: 'b', reasoningEffort: 'low' },
    'lastUsed',
  )
  assertEqual(
    modelSelectionOfProjection({ provider: 'a', model: 'b' }),
    { provider: 'a', model: 'b' },
    '直接对象',
  )
  assertEqual(modelSelectionOfProjection(undefined), null, 'undefined')
  assertEqual(modelSelectionOfProjection({ next: { provider: 'a' } }), null, '缺 model')
})

/* ── B. 斜杠命令过滤 ─────────────────────────────────────────────────── */

check('B5 parseCommandList：裸数组 / {commands} / 去前缀 / 去重 / 丢空名', async () => {
  const fromArray = parseCommandList([
    { name: 'permission', description: '切权限', input: { hint: '<preset>' } },
    { name: '/compact', description: '压缩历史' },
    { name: 'permission', description: '重复项' },
    { description: '没有名字' },
    { name: '   ' },
  ])
  assertEqual(
    fromArray.map((command) => [command.name, command.hint ?? null]),
    [
      ['permission', '<preset>'],
      ['compact', null],
    ],
    '裸数组归一化',
  )
  const fromObject = parseCommandList({ commands: [{ name: 'status' }] })
  assertEqual(fromObject.map((command) => command.name), ['status'], '{commands} 包装')
  assertEqual(parseCommandList({ nope: [] }), [], '不认识的对象 → 空')
})

check('B6 slashQuery：只有整行 /名字 才算命令', async () => {
  assertEqual(slashQuery('/'), '', '刚敲一个斜杠')
  assertEqual(slashQuery('/per'), 'per', '正在打名字')
  assertEqual(slashQuery('   /per'), 'per', '前导空格容忍')
  assertEqual(slashQuery('/permission read-only'), null, '已经带参数 → 不再补全')
  assertEqual(slashQuery('你好 /per'), null, '正文里的斜杠不是命令')
  assertEqual(slashQuery('hello'), null, '普通文本')
  assertEqual(slashQuery(''), null, '空串')
})

check('B7 filterCommands：前缀优先 / 大小写不敏感 / 空查询原样', async () => {
  const commands = parseCommandList([
    { name: 'compact' },
    { name: 'permission' },
    { name: 'model' },
    { name: 'my-permission' },
  ])
  assertEqual(
    filterCommands(commands, 'pe').map((command) => command.name),
    ['permission', 'my-permission'],
    '前缀优先，包含匹配排后面',
  )
  assertEqual(
    filterCommands(commands, 'PER').map((command) => command.name),
    ['permission', 'my-permission'],
    '大小写不敏感（my-permission 也含 per）',
  )
  assertEqual(filterCommands(commands, 'comp').map((command) => command.name), ['compact'], '前缀命中')
  assertEqual(filterCommands(commands, '').length, 4, '空查询 = 全部')
  assertEqual(filterCommands(commands, 'zzz'), [], '没有匹配')
  assertEqual(commandLineOf({ name: 'permission' }), '/permission ', '填回输入框的形状（带尾空格）')
})

/* ── C. 队列三操作 ───────────────────────────────────────────────────── */

const INBOX = {
  'next-step': [{ id: 'internal', source: { kind: 'agent' }, content: [{ type: 'text', text: '内部续跑' }] }],
  'next-turn': [
    {
      id: 'q-1',
      source: { kind: 'user', rpcId: 'rpc-1' },
      content: [{ type: 'text', text: '第一条排队消息' }],
    },
    {
      id: 'q-2',
      source: { kind: 'bot', rpcId: 'rpc-2' },
      content: [{ type: 'text', text: 'bot 转发的' }],
    },
    {
      id: 'q-3',
      source: { kind: 'user-question-reply', rpcId: 'rpc-3' },
      content: [
        { type: 'text', text: '回答：' },
        { type: 'text', text: '工作区可写' },
      ],
    },
    { id: 'q-4', source: { kind: 'user' }, content: [] },
  ],
}

check('C8 parseInboxQueue：只取 next-turn 的本级来源', async () => {
  const queue = parseInboxQueue(INBOX)
  assertEqual(
    queue.map((item) => [item.id, item.rpcId ?? null, item.preview]),
    [
      ['q-1', 'rpc-1', '第一条排队消息'],
      ['q-3', 'rpc-3', '回答： 工作区可写'],
      ['q-4', null, ''],
    ],
    'inbox 投影 → 队列条目（bot 来源被过滤、next-step 不出现）',
  )
  assertEqual(parseInboxQueue(undefined), [], '非对象 → 空')
  assertEqual(parseInboxQueue({ 'next-turn': 'nope' }), [], 'next-turn 不是数组 → 空')
})

check('C9 updateQueueItem(steer)：端点 / 参数 / 本地摘除', async () => {
  const fake = harness({ 'session/updateQueue': { ok: true, value: { accepted: true } } })
  bind(fake)
  selectControlSession('sess-1')
  applyControlFrame({ type: 'projection', sessionId: 'sess-1', key: 'inbox', value: INBOX })
  assertEqual(useChatControls.getState().queue.map((item) => item.id), ['q-1', 'q-3', 'q-4'], '投影进队列')

  const ok = await useChatControls.getState().updateQueueItem('q-1', 'steer')
  assertTrue(ok, 'steer 应成功')
  assertEqual(fake.count('session/updateQueue'), 1, '只发一次')
  assertEqual(
    fake.lastArgs('session/updateQueue'),
    { request: { sessionId: 'sess-1', itemId: 'q-1', action: { kind: 'steer' } } },
    'updateQueue 参数形状',
  )
  assertEqual(useChatControls.getState().queue.map((item) => item.id), ['q-3', 'q-4'], '本地立刻摘掉')
  assertEqual(useChatControls.getState().queueAccess, 'available', '成功即视为能力可用')
  unbindSessionControls()
})

check('C10 updateQueueItem(remove)：remove kind / 条目已消失只摘除不报错', async () => {
  const fake = harness({ 'session/updateQueue': { ok: true, value: { accepted: true } } })
  bind(fake)
  selectControlSession('sess-1')
  applyControlFrame({ type: 'projection', sessionId: 'sess-1', key: 'inbox', value: INBOX })

  await useChatControls.getState().updateQueueItem('q-1', 'remove')
  assertEqual(
    (fake.lastArgs('session/updateQueue') as { request: { action: unknown } }).request.action,
    { kind: 'remove' },
    'remove 的 action',
  )
  assertEqual(useChatControls.getState().queue.map((item) => item.id), ['q-3', 'q-4'], '摘掉 q-1')

  // Host 说这条已经不在队列里了（被抢先处理）：本地也摘掉，但**不写 error**
  fake.rewrite('session/updateQueue', { ok: false, code: 'session/queue-item-not-found', message: 'gone' })
  const ok = await useChatControls.getState().updateQueueItem('q-3', 'remove')
  assertTrue(!ok, '未命中条目应返回 false')
  assertEqual(useChatControls.getState().error, null, '不写操作级错误')
  assertEqual(useChatControls.getState().queue.map((item) => item.id), ['q-4'], '仍然摘掉')
  unbindSessionControls()
})

check('C11 clearQueue：逐条 remove', async () => {
  const fake = harness({ 'session/updateQueue': { ok: true, value: { accepted: true } } })
  bind(fake)
  selectControlSession('sess-1')
  applyControlFrame({ type: 'projection', sessionId: 'sess-1', key: 'inbox', value: INBOX })
  await useChatControls.getState().clearQueue()
  assertEqual(fake.count('session/updateQueue'), 3, '三条各一次')
  assertEqual(
    fake.calls.map((call) => (call.args.request as { itemId: string }).itemId),
    ['q-1', 'q-3', 'q-4'],
    '顺序与队列一致',
  )
  assertEqual(useChatControls.getState().queue.length, 0, '清空后本地也空')
  unbindSessionControls()
})

check('C12 updateQueue 不支持 → queueAccess=unavailable 且队列条隐藏', async () => {
  const fake = harness({ 'session/updateQueue': { ok: false, code: 'METHOD_NOT_FOUND' } })
  bind(fake)
  selectControlSession('sess-1')
  applyControlFrame({ type: 'projection', sessionId: 'sess-1', key: 'inbox', value: INBOX })
  assertTrue(showsQueueDock(useChatControls.getState()), '先有队列条')
  const ok = await useChatControls.getState().updateQueueItem('q-1', 'steer')
  assertTrue(!ok, '不支持时返回 false')
  assertEqual(useChatControls.getState().queueAccess, 'unavailable', '能力标成不可用')
  assertTrue(!showsQueueDock(useChatControls.getState()), '队列条隐藏（不是显示一排坏按钮）')
  assertEqual(useChatControls.getState().error, null, '能力缺失不写错误')
  unbindSessionControls()
})

/* ── D. 提问状态机 ───────────────────────────────────────────────────── */

check('D13 parseQuestionWaterfall：限时 / 普通 / 别的会话 / 非提问', async () => {
  const timed = parseQuestionWaterfall(questionWaterfall(), 'sess-1')
  assertEqual(
    [timed?.callId ?? null, timed?.timed, timed?.questions[0]?.options.length],
    ['call-1', true, 2],
    '限时问答',
  )
  const plain = parseQuestionWaterfall(questionWaterfall({ timed: false }), 'sess-1')
  assertEqual([plain?.callId ?? null, plain?.timed], [null, false], '普通瀑布')
  assertEqual(parseQuestionWaterfall(questionWaterfall(), 'sess-2'), null, '别的会话的提问不接')
  assertEqual(parseQuestionWaterfall({ type: 'waterfall', event: 'approval/request' }, 'sess-1'), null, '审批不归这里')
  assertEqual(parseQuestionWaterfall(null, 'sess-1'), null, 'null')
})

check('D14 到达 → claiming → attachWait 首帧 → open + deadline', async () => {
  const fake = harness()
  bind(fake)
  selectControlSession('sess-1')
  ingestEventsItem(questionWaterfall(), 'sess-1')
  const key = questionKey({ callId: 'call-1' })
  assertTrue(key !== null, 'key 必须能算出来')
  if (key === null) return
  assertEqual(useChatControls.getState().questions[key]?.phase, 'claiming', '先进入 claiming')
  await tick()
  assertEqual(fake.streams.map((entry) => entry.endpoint), ['userQuestions/attachWait'], '开了 attachWait')
  const streamId = fake.streams[0]?.streamId
  if (streamId === undefined) return fail('没有 attachWait 流')
  fake.push(streamId, { type: 'frame', hasValue: true, value: { remainingMs: 5000 } })
  const state = useChatControls.getState().questions[key]
  assertEqual(state?.phase, 'open', '首帧后进入 open')
  assertTrue(state?.deadline !== undefined, '应记下截止时刻')
  assertTrue((state?.deadline ?? 0) > Date.now(), 'deadline 在未来')
  assertEqual(useChatControls.getState().questionAccess, 'available', '能认领 = 能力可用')
  unbindSessionControls()
})

check('D15 窗口内作答走 $events/result（不走 answer 端点）', async () => {
  const fake = harness()
  bind(fake, { clientId: 'client-42' })
  selectControlSession('sess-1')
  ingestEventsItem(questionWaterfall(), 'sess-1')
  await tick()
  fake.push(fake.streams[0]?.streamId ?? '', { type: 'frame', hasValue: true, value: { remainingMs: 5000 } })
  const key = questionKey({ callId: 'call-1' }) ?? ''
  const ok = await useChatControls.getState().answerQuestion(key, { q1: ['只读'] }, {})
  assertTrue(ok, '应提交成功')
  assertEqual(fake.count('userQuestions/answer'), 0, '窗口内不得走 answer 端点')
  assertEqual(
    fake.lastArgs('$events/result'),
    {
      clientId: 'client-42',
      eventId: 'evt-1',
      outcome: { kind: 'result', value: { answers: [{ id: 'q1', selected: ['只读'] }] } },
    },
    '$events/result 参数形状',
  )
  assertEqual(useChatControls.getState().questions[key]?.phase, 'answered', '阶段 answered')
  // 终态之后不再发请求
  const again = await useChatControls.getState().answerQuestion(key, { q1: ['只读'] }, {})
  assertTrue(!again, '已回答过就不再提交')
  unbindSessionControls()
})

check('D16 投影 continued → 作答走 userQuestions/answer，阶段 queued', async () => {
  const fake = harness()
  bind(fake)
  selectControlSession('sess-1')
  ingestEventsItem(questionWaterfall({ timed: false }), 'sess-1')
  await tick()
  const key = questionKey({ callId: 'call-1' }) ?? ''
  // 投影说 callId 已经 continued（Host 权威）
  applyControlFrame({
    type: 'projection',
    sessionId: 'sess-1',
    key: 'userQuestions',
    value: {
      active: [{ callId: 'call-1', state: 'continued', questions: [{ id: 'q1', question: '再确认一次?' }] }],
      settled: [],
    },
  })
  assertEqual(useChatControls.getState().questions[key]?.phase, 'continued', '阶段 continued')
  const ok = await useChatControls.getState().answerQuestion(key, { q1: ['工作区可写'] }, { q1: '附注' })
  assertTrue(ok, '补答应成功')
  assertEqual(fake.count('userQuestions/answer'), 1, '走 answer 端点')
  assertEqual(
    fake.lastArgs('userQuestions/answer'),
    {
      agentId: 'sess-1',
      callId: 'call-1',
      answer: { answers: [{ id: 'q1', selected: ['工作区可写'], custom: '附注' }] },
    },
    'answer 参数形状',
  )
  assertEqual(fake.count('$events/result'), 0, 'continued 之后不再走事件应答')
  assertEqual(useChatControls.getState().questions[key]?.phase, 'queued', '阶段 queued')
  unbindSessionControls()
})

check('D17 投影 settled → 阶段 answered 且不再可答', async () => {
  const fake = harness()
  bind(fake)
  selectControlSession('sess-1')
  ingestEventsItem(questionWaterfall(), 'sess-1')
  await tick()
  const key = questionKey({ callId: 'call-1' }) ?? ''
  applyControlFrame({
    type: 'projection',
    sessionId: 'sess-1',
    key: 'userQuestions',
    value: { active: [], settled: [{ callId: 'call-1' }] },
  })
  const state = useChatControls.getState().questions[key]
  assertEqual(state?.phase, 'answered', 'settled → answered')
  assertTrue(isQuestionTerminal(state?.phase ?? 'open'), '终态')
  const ok = await useChatControls.getState().answerQuestion(key, { q1: ['只读'] }, {})
  assertTrue(!ok, '终态后拒绝提交')
  assertEqual(fake.count('$events/result'), 0, '不发任何应答')
  unbindSessionControls()
})

check('D18 cancel → cancelled 且之后不发请求', async () => {
  const fake = harness()
  bind(fake)
  selectControlSession('sess-1')
  ingestEventsItem(questionWaterfall(), 'sess-1')
  await tick()
  ingestEventsItem({ type: 'cancel', eventId: 'evt-1' }, 'sess-1')
  const key = questionKey({ callId: 'call-1' }) ?? ''
  assertEqual(useChatControls.getState().questions[key]?.phase, 'cancelled', 'Host 撤销 → cancelled')
  const ok = await useChatControls.getState().answerQuestion(key, { q1: ['只读'] }, {})
  assertTrue(!ok, '已撤销不能答')
  assertEqual(fake.count('$events/result'), 0, '不发应答')
  unbindSessionControls()
})

check('D19 窗口到期 → expired + 回 ASK_TIMED_OUT；过期后作答被拒', async () => {
  const fake = harness()
  bind(fake, { clientId: 'client-7' })
  selectControlSession('sess-1')
  ingestEventsItem(questionWaterfall(), 'sess-1')
  await tick()
  // 给一个非常短的窗口，等本地定时器到点
  fake.push(fake.streams[0]?.streamId ?? '', { type: 'frame', hasValue: true, value: { remainingMs: 30 } })
  const key = questionKey({ callId: 'call-1' }) ?? ''
  assertEqual(useChatControls.getState().questions[key]?.phase, 'open', '先 open')
  await sleep(70)
  assertEqual(useChatControls.getState().questions[key]?.phase, 'expired', '到点变 expired')
  assertEqual(
    fake.lastArgs('$events/result'),
    {
      clientId: 'client-7',
      eventId: 'evt-1',
      outcome: {
        kind: 'rejected',
        error: { name: 'UserQuestionError', code: 'ASK_TIMED_OUT', message: '问答窗口已结束' },
      },
    },
    '到期回一组 ASK_TIMED_OUT（官方语义）',
  )
  const before = fake.count('$events/result')
  const ok = await useChatControls.getState().answerQuestion(key, { q1: ['只读'] }, {})
  assertTrue(!ok, '过期后作答被拒')
  assertEqual(fake.count('$events/result'), before, '过期后不再发应答')
  unbindSessionControls()
})

check('D20 没有 attachWait → 能力不可用，但普通瀑布仍能答', async () => {
  const fake = harness({}, { 'userQuestions/attachWait': 'METHOD_NOT_FOUND' })
  bind(fake)
  selectControlSession('sess-1')
  ingestEventsItem(questionWaterfall(), 'sess-1')
  await tick()
  const key = questionKey({ callId: 'call-1' }) ?? ''
  const state = useChatControls.getState().questions[key]
  assertEqual(state?.phase, 'open', '退回普通瀑布（open）')
  assertEqual(state?.timed, false, '标记为非限时')
  assertEqual(useChatControls.getState().questionAccess, 'unavailable', '能力标成不可用')
  const ok = await useChatControls.getState().answerQuestion(key, { q1: ['只读'] }, {})
  assertTrue(ok, '仍可用 $events/result 应答')
  assertEqual(fake.count('$events/result'), 1, '走事件应答')
  unbindSessionControls()
})

/* ── E. 能力门禁 ─────────────────────────────────────────────────────── */

check('E21 所有端点 METHOD_NOT_FOUND → 三个入口全隐藏', async () => {
  const notFound: Reply = { ok: false, code: 'METHOD_NOT_FOUND' }
  const fake = harness({
    'session/modelCatalog': notFound,
    'permissionPresets/catalog': notFound,
    'commands/list': notFound,
    'session/updateQueue': notFound,
  })
  bind(fake)
  selectControlSession('sess-1')
  await useChatControls.getState().probe()
  const state = useChatControls.getState()
  assertEqual(
    [state.modelAccess, state.permissionAccess, state.commandAccess],
    ['unavailable', 'unavailable', 'unavailable'],
    '三个有目录端点的能力都标成不可用',
  )
  // 队列没有「目录端点」：只有投影里有 `inbox`、或真点过一次 `updateQueue` 才知道支不支持。
  // 这里既没有投影也没点过，所以停在 `unknown`；关键在于**队列条不出现**（队列本身是空的）。
  assertEqual(state.queueAccess, 'unknown', '队列能力仍未知（没有可探测的端点）')
  assertTrue(!showsQueueDock(state), '队列条不出现')
  assertTrue(!showsModelCapsule(state), '模型胶囊隐藏')
  assertTrue(!showsPermissionCapsule(state), '权限胶囊隐藏')
  assertTrue(!showsCommandCompletion(state), '斜杠补全关闭')
  assertEqual(state.error, null, '能力缺失不写错误（不报错）')
  assertTrue(isUnsupportedError({ code: 'CAPABILITY_NOT_SUPPORTED' }), 'CAPABILITY_NOT_SUPPORTED 也算不支持')
  assertTrue(!isUnsupportedError({ code: 'INTERNAL_ERROR' }), '别的错误码不算不支持')
  unbindSessionControls()
})

check('E22 正常数据 → 入口可见；probe 重复调用不重复拉取', async () => {
  const fake = harness({
    'session/modelCatalog': { ok: true, value: CATALOG },
    'permissionPresets/catalog': {
      ok: true,
      value: {
        options: [
          { value: 'read-only', name: '只读' },
          { value: 'workspace-write', name: '工作区可写', description: '允许改工作区' },
        ],
      },
    },
    'commands/list': { ok: true, value: [{ name: 'permission', description: '切权限' }] },
  })
  bind(fake)
  selectControlSession('sess-1')
  await useChatControls.getState().probe()
  const state = useChatControls.getState()
  assertTrue(showsModelCapsule(state), '模型胶囊可见')
  assertTrue(showsPermissionCapsule(state), '权限胶囊可见')
  assertTrue(showsCommandCompletion(state), '斜杠补全可用')
  assertEqual(state.currentModel, { provider: 'deepseek', model: 'deepseek-chat' }, '默认模型进当前值')
  assertEqual(
    state.permissions.map((option) => option.value),
    ['read-only', 'workspace-write'],
    '权限预设列表',
  )
  // 第二次 probe：三个端点都不该再被调
  const before = fake.calls.length
  await useChatControls.getState().probe()
  assertEqual(fake.calls.length, before, 'probe 幂等（已有数据不重复拉）')
  unbindSessionControls()
})

check('E23 权限预设归一化 / 当前值 / 用量与信息投影', async () => {
  assertEqual(
    parsePermissionCatalog([{ id: 'ro', name: '只读' }]).map((option) => option.value),
    ['ro'],
    '裸数组 + id 兼容',
  )
  assertEqual(parsePermissionCatalog({ options: [{ name: '缺 value' }] }), [], '缺 value 丢掉')
  assertEqual(
    permissionProjectionOf({ currentValue: 'workspace-write', options: [{ value: 'read-only', name: '只读' }] })
      ?.currentValue,
    'workspace-write',
    '投影 currentValue',
  )
  assertEqual(permissionProjectionOf({ options: [] }), null, '缺 currentValue → null')
  assertEqual(permissionProjectionOf({ currentValue: 'custom' }), { currentValue: 'custom', options: [] }, '无选项')
  assertEqual(permissionDisplayName([{ value: 'a', name: 'A 名' }], 'a'), 'A 名', '显示名')
  assertEqual(permissionDisplayName([], 'b'), 'b', '找不到回落 value')

  const fake = harness()
  bind(fake)
  selectControlSession('sess-1')
  applyControlFrame({
    type: 'projection',
    sessionId: 'sess-1',
    key: 'usage',
    value: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 900 },
  })
  assertEqual(
    useChatControls.getState().usage,
    { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 900 },
    '用量投影',
  )
  assertEqual(usageOfProjection({ inputTokens: 1 }), null, '缺 outputTokens → null')
  applyControlFrame({ type: 'projection', sessionId: 'sess-1', key: 'title', value: '会话标题' })
  assertEqual(useChatControls.getState().title, '会话标题', '标题投影')
  unbindSessionControls()
})

check('E24 答案与提交流程的小工具', async () => {
  const questions = [
    { id: 'q1', question: 'A?', options: [], multiSelect: false },
    { id: 'q2', question: 'B?', options: [], multiSelect: true },
  ]
  assertEqual(
    buildQuestionAnswer(questions, { q1: ['x'], q2: [] }, { q2: '  自己写  ' }),
    { answers: [{ id: 'q1', selected: ['x'] }, { id: 'q2', selected: [], custom: '自己写' }] },
    '整理成线上形状（空选择 + 自定义文本保留，纯空的一条丢掉）',
  )
  assertEqual(buildQuestionAnswer(questions, {}, {}), { answers: [] }, '什么都没填 → 空')
  assertTrue(!allQuestionsAnswered(questions, { q1: ['x'] }, {}), 'q2 没填 → 不能提交')
  assertTrue(allQuestionsAnswered(questions, { q1: ['x'] }, { q2: 'y' }), '都填了 → 能提交')
})

check('E25 控制流端点常量与 store 绑定/解绑', async () => {
  assertEqual(CONTROL_STREAM_ENDPOINT, 'session/control', '投影流端点名')
  // 没绑定时所有动作都必须安静失败（返回 false / 不发请求）
  unbindSessionControls()
  assertEqual(await useChatControls.getState().updateQueueItem('x', 'steer'), false, '未连接 → false')
  assertEqual(await useChatControls.getState().selectModel({ provider: 'a', model: 'b' }), false, '未连接 → false')
  assertEqual(await useChatControls.getState().executeCommand('/compact'), null, '未连接 → null')
  assertEqual(await useChatControls.getState().answerQuestion('k', {}, {}), false, '未连接 → false')
})

/* ── F. 外部流订阅 API（store.ts 的 registerRemoteStreamSink） ─────────
 *
 * 这个 API 是给并行任务（W1 的 `workspace/follow`）用的：它自己 `openStream()` 之后，
 * 帧仍然先到 `store.ts` 的链路级回调，只有登记过才会被投递。
 * 路由核心 `routeToStreamListeners()` 是导出的纯函数，这里直接测它（不碰连接状态）；
 * 「未连接时返回空取消函数」则直接调真 API。
 */

check('F26 routeToStreamListeners：多接收器各收一份 / 关闭即摘除', async () => {
  const { routeToStreamListeners } = await import('../store.js')
  const seenA: string[] = []
  const seenB: string[] = []
  const listeners = new Map<string, Set<(payload: StreamEventPayload) => void>>()
  listeners.set('stream-w', new Set([
    (payload) => seenA.push(payload.type === 'frame' ? `frame:${JSON.stringify(payload.value)}` : `closed:${payload.reason}`),
    (payload) => seenB.push(payload.type === 'frame' ? 'frame' : 'closed'),
  ]))
  assertTrue(
    routeToStreamListeners(listeners, 'stream-w', { type: 'frame', hasValue: true, value: { a: 1 } }),
    '有接收器 → 这一帧被吃掉（不再缓冲）',
  )
  assertEqual(seenA, ['frame:{"a":1}'], '第一个接收器收到整包 value')
  assertEqual(seenB, ['frame'], '第二个接收器也收到（不独占）')
  assertTrue(
    routeToStreamListeners(listeners, 'stream-w', { type: 'closed', reason: 'completed' }),
    '关闭帧也要投递',
  )
  assertEqual(seenA[1], 'closed:completed', '接收器看到 close reason')
  assertTrue(!listeners.has('stream-w'), '流关闭后接收器被整批摘掉')
  assertTrue(
    !routeToStreamListeners(listeners, 'stream-w', { type: 'frame', hasValue: true, value: 1 }),
    '没有接收器 → 返回 false（调用方继续走缓冲/丢弃）',
  )
  assertTrue(
    !routeToStreamListeners(new Map(), 'nope', { type: 'frame', hasValue: false }),
    '不存在的流 → false',
  )
})

check('F27 registerRemoteStreamSink：未连接时返回幂等空取消函数（不抛）', async () => {
  const { registerRemoteStreamSink } = await import('../store.js')
  // 没连上（`active === null`）：绝不能抛，调用方可以无条件 cleanup
  const cancel = registerRemoteStreamSink('stream-x', () => undefined)
  cancel()
  cancel() // 幂等
  const empty = registerRemoteStreamSink('', () => undefined)
  empty()
})

/* ── 跑 ──────────────────────────────────────────────────────────────── */

const main = async (): Promise<void> => {
  let failures = 0
  for (const item of checks) {
    const startedAt = Date.now()
    try {
      await item.run()
      console.log(`PASS  ${item.name}  (${Date.now() - startedAt}ms)`)
    } catch (error) {
      failures += 1
      console.error(`FAIL  ${item.name}`)
      console.error(`      ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  console.log(`\n${checks.length - failures} PASS / ${failures} FAIL / ${checks.length} TOTAL`)
  // 红了必须真的红（仓库约定：检查脚本必须设置退出码）
  process.exit(failures === 0 ? 0 : 1)
}

await main()
