/**
 * 输入区（R4）自测：发送/停止切换、排队区增删、steer 调用、胶囊折叠与思考强度选择。
 *
 * 跑法（workdir = projects\deepseek-tablet\web）：
 *   npx tsx src/components/remote/composer/__selftest__/composer.selftest.mts
 *
 * 分三层（每层都尽量跑**真代码**，只有链路是假的）：
 *   A. 纯状态机（`composerState.ts`）：按钮形态（含 S3 的「在跑时看输入框」与全局运行态校正
 *      `composerLiveView`）、回车意图、提示文案；
 *   B. 真 store（`sessionControls.ts` + 假 `RemoteCallTarget`）：排队区增删与 steer / remove
 *      的端点与参数、`session/selectModel` 的 `reasoningEffort`、能力降级；
 *   C. 纯几何（`effortLevels.ts`）：档位解析、胶囊折叠、滑条下标 / 比例 / 磁吸。
 *
 * 结尾按仓库约定设置真实退出码（`process.exit(failures === 0 ? 0 : 1)`），
 * 并且**先删旧报告**（`report.txt`）—— 崩在半路时磁盘上不该留上一次的结论。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  canSubmit,
  composerHint,
  composerIntent,
  composerLiveView,
  composerView,
  hasDraftContent,
  queuePreviewText,
  queueRowState,
  type ComposerSignals,
} from '../composerState.js'
import {
  activeEffortIdOf,
  effortIndex,
  effortLevelsOf,
  effortNameOf,
  effortRatioOf,
  magnetizeRatio,
  modelPillText,
  ratioToIndex,
  showsEffortSlider,
} from '../effortLevels.js'
import { dispatchPrompt, supportsPromptMode } from '../promptMode.js'
import type { StreamEventPayload } from '../../../../services/remote/core/index.js'
import {
  applyControlFrame,
  bindSessionControls,
  selectControlSession,
  showsModelCapsule,
  showsQueueDock,
  unbindSessionControls,
  useChatControls,
  type RemoteModelCatalog,
} from '../../../../services/remote/sessionControls.js'
import type { RemoteCallTarget, RemoteStreamHandle } from '../../../../services/remote/sessionsApi.js'

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

/** 让 fire-and-forget 的 promise 链跑完 */
const tick = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/* ── 假链路（只记调用，不做网络） ──────────────────────────────────────── */

type Reply = { ok: true; value?: unknown } | { ok: false; code: string; message?: string }

const harness = (replies: Record<string, Reply> = {}) => {
  const calls: Array<{ endpoint: string; args: Record<string, unknown> }> = []
  const target: RemoteCallTarget = {
    rpc: async <T,>(method: string, params?: unknown): Promise<T> => {
      if (method !== 'harness.remote.call') return {} as T
      const envelope = params as { endpoint: string; payload: { args: Record<string, unknown> } }
      calls.push({ endpoint: envelope.endpoint, args: envelope.payload.args })
      const reply = replies[envelope.endpoint]
      if (reply === undefined) return { ok: true, value: {} } as T
      if (reply.ok) return (reply.value === undefined ? { ok: true } : { ok: true, value: reply.value }) as T
      return { ok: false, error: { code: reply.code, message: reply.message ?? reply.code } } as T
    },
    openStream: async (): Promise<RemoteStreamHandle> => ({
      streamId: 'stream-shot',
      close: async (): Promise<void> => undefined,
    }),
  }
  return {
    target,
    calls,
    lastArgs: (endpoint: string): Record<string, unknown> | undefined =>
      [...calls].reverse().find((call) => call.endpoint === endpoint)?.args,
  }
}

const bind = (fake: ReturnType<typeof harness>): void => {
  bindSessionControls({
    target: fake.target,
    registerStreamSink: (_streamId: string, _onPayload: (payload: StreamEventPayload) => void) => () => undefined,
    eventClientId: () => 'client-test',
  })
}

/** 一份够用的模型目录：`deepseek-chat` 没有档位，`deepseek-reasoner` 三档且默认 medium */
const CATALOG: RemoteModelCatalog = {
  defaultModel: { provider: 'deepseek', model: 'deepseek-chat' },
  routable: true,
  groups: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-chat', name: 'DeepSeek Chat', efforts: [] },
        {
          id: 'deepseek-reasoner',
          name: 'DeepSeek Reasoner',
          efforts: [
            { id: 'low', name: '低' },
            { id: 'medium', name: '中' },
            { id: 'high', name: '高' },
          ],
          defaultEffort: 'medium',
        },
      ],
    },
  ],
  failures: [],
}

/** 一组基础信号（每个用例只覆盖自己关心的字段） */
const baseSignals = (overrides: Partial<ComposerSignals> = {}): ComposerSignals => ({
  ready: true,
  sessionId: 'sess-1',
  streaming: false,
  sendMode: 'steer',
  stopTimedOut: false,
  queueLength: 0,
  draft: '',
  attachments: 0,
  attachmentsBusy: false,
  knownCommand: false,
  slashTyping: false,
  ...overrides,
})

/* ─────────────────────────── A. 发送 / 停止切换 ─────────────────────────── */

check('A1 空闲 + 有草稿：主按钮是发送且可点', async () => {
  const view = composerView(baseSignals({ draft: '你好' }))
  assertEqual(view.primary, 'send', 'primary')
  assertTrue(view.primaryEnabled, '主按钮应可点')
  assertEqual(view.secondaryAction, null, '空闲时没有第二颗钮')
  assertEqual(view.modeToggleVisible, false, '空闲时没有插话/排队切换')
  assertEqual(view.busy, false, '空闲时 busy 必须是 false')
  assertEqual(view.running, false, '空闲时 running 为 false')
})

check('A2 空闲 + 草稿为空：主按钮仍是发送但禁用', async () => {
  const view = composerView(baseSignals())
  assertEqual(view.primary, 'send', 'primary')
  assertEqual(view.primaryEnabled, false, '没有内容时不可点')
  assertEqual(hasDraftContent('   ', 0), false, '纯空白不算内容')
  assertEqual(canSubmit(baseSignals()), false, 'canSubmit 同上')
})

check('A3 在跑 + 草稿为空：主位变停止（这就是「它在干活」）', async () => {
  const view = composerView(baseSignals({ streaming: true }))
  assertEqual(view.primary, 'stop', '运行中且没内容时主按钮必须是停止')
  assertEqual(view.primaryEnabled, true, '停止永远可点（Host 空闲也回 accepted）')
  assertEqual(view.secondaryAction, 'send', '第二颗钮是发送（有内容才可点）')
  assertEqual(view.secondaryEnabled, false, '没内容时发送不可点')
  assertEqual(view.modeToggleVisible, true, '运行中给插话/排队切换')
  assertEqual(view.busy, true, 'busy 为真')
})

check('A4 [S3] 在跑 + 有草稿：主位变发送，停止让到第二颗钮', async () => {
  const signals = baseSignals({ streaming: true, draft: '顺便改一下标题' })
  const view = composerView(signals)
  assertEqual(view.primary, 'send', '有内容时主按钮是发送（用户要求）')
  assertTrue(view.primaryEnabled, '主按钮可点')
  assertEqual(view.secondaryAction, 'stop', '停止在第二颗钮上，永远可点')
  assertTrue(view.secondaryEnabled, '停止永远可点')
  assertEqual(view.modeToggleVisible, true, '插话/排队切换保留')
  assertEqual(composerIntent(signals), 'steer', '默认插话（与 dsh-Go 一致）')
})

check('A4b 切成「排队」：同一个发送键改走 queue', async () => {
  const signals = baseSignals({ streaming: true, draft: '顺便改一下标题', sendMode: 'queue' })
  assertEqual(composerIntent(signals), 'queue', '排队')
  assertEqual(composerView(signals).primary, 'send', '主位仍是发送，只是 mode 变了')
})

check('A5 在跑 + 附件还在上传：主位可点但发不出去（灰）', async () => {
  const view = composerView(baseSignals({ streaming: true, draft: 'x', attachmentsBusy: true }))
  assertEqual(view.primary, 'send', '有草稿 → 主位是发送')
  assertEqual(view.primaryEnabled, false, '收据没到手不给发')
  assertEqual(composerIntent(baseSignals({ streaming: true, draft: 'x', attachmentsBusy: true })), 'none', 'intent')
})

check('A6 在跑 + 已知斜杠命令：命令不算「可发内容」，主位仍是停止', async () => {
  const signals = baseSignals({ streaming: true, draft: '/compact', knownCommand: true })
  const view = composerView(signals)
  assertEqual(view.primary, 'stop', '生成中命令发不出去，主位留给停止')
  assertEqual(view.secondaryAction, null, '命令不插话也不排队')
  assertEqual(view.modeToggleVisible, false, '命令没有 mode 可切')
  assertEqual(composerIntent(signals), 'none', '生成中执行命令会被 Host 拒，干脆不发')
})

check('A7 队列还有条目（streaming 已回 false）：仍然算工作中', async () => {
  const view = composerView(baseSignals({ streaming: false, queueLength: 2 }))
  assertEqual(view.busy, true, '队列非空 = 还在工作')
  assertEqual(view.running, false, '但这一轮没在跑')
  assertEqual(view.primary, 'send', '没在跑就是发送（停止是给「正在生成」留的）')
})

check('A8 未就绪 / 没选会话：谁都发不出去', async () => {
  assertEqual(composerIntent(baseSignals({ ready: false, draft: 'x' })), 'none', '未就绪')
  assertEqual(composerIntent(baseSignals({ sessionId: null, draft: 'x' })), 'none', '没会话')
  assertEqual(composerView(baseSignals({ ready: false, draft: 'x' })).primaryEnabled, false, '按钮禁用')
})

check('A8b [R15] 新对话页：没会话也能发（发送=建会话）；创建中灰住', async () => {
  const chat = baseSignals({ sessionId: null, newChat: true, draft: '帮我看看这个' })
  assertEqual(canSubmit(chat), true, 'newChat 放行「没有会话」这一条')
  assertEqual(composerIntent(chat), 'send', '意图就是发送（建会话由 submit 那边分流）')
  const view = composerView(chat)
  assertEqual(view.primary, 'send', '主按钮是发送')
  assertEqual(view.primaryEnabled, true, '可点')
  assertEqual(view.secondaryAction, null, '没有第二颗钮（那里没有流可停）')
  assertEqual(composerHint(chat).key, 'newSessionComposerHint', '提示说「发出后自动创建会话」')

  // 空草稿照旧发不出去
  assertEqual(composerIntent(baseSignals({ sessionId: null, newChat: true })), 'none', '空草稿 none')

  // 创建中：主按钮灰住，防连点出两个会话
  const creating = baseSignals({ sessionId: null, newChat: true, draft: '再发一条', creating: true })
  assertEqual(canSubmit(creating), false, 'creating 期间 canSubmit false')
  assertEqual(composerView(creating).primaryEnabled, false, '主按钮禁用')
  assertEqual(composerHint(creating).key, 'newSessionCreating', '提示换成「正在创建…」')

  // knownCommand / slash 都被调用方压成 false；就算漏进来，newChat 分支也只认「发送文本」
  assertEqual(
    composerIntent(baseSignals({ sessionId: null, newChat: true, draft: '/compact', knownCommand: true })),
    'send',
    'newChat 分支不看 knownCommand —— 斜杠行当普通文本发',
  )
})

check('A9 停止 10s 无回执：主按钮还原成发送 + 提示换掉', async () => {
  const signals = baseSignals({ streaming: true, stopTimedOut: true })
  const view = composerView(signals)
  assertEqual(view.primary, 'send', '停止被还原（不让用户对着没反应的键）')
  assertEqual(view.secondaryAction, 'stop', '还想停的话第二颗钮还在')
  assertEqual(composerHint(signals).key, 'composerHintStopTimeout', '提示必须解释刚才发生了什么')
})

check('A10 [S3] 全局运行态：streaming 还没跟上也要认出「它在跑」', async () => {
  // 用户带着一个已经在跑的会话进 App：`turn/start` 早过去了，streaming 是 false
  const idleLooking = baseSignals({ streaming: false })
  assertEqual(composerView(idleLooking).primary, 'send', '只看 streaming 时是发送（旧的 bug 现场）')
  assertEqual(composerLiveView(composerView(idleLooking), true).primary, 'stop', '全局运行态说在跑 → 停止')
  // 反过来：全局运行态说停了，主位必须回到发送
  const running = composerView(baseSignals({ streaming: true }))
  assertEqual(composerLiveView(running, false).primary, 'send', '运行态说停了 → 发送')
  // 同一个值不造新对象（每帧都会调它）
  assertTrue(composerLiveView(running, true) === running, '值没变就返回原对象')
  // 有草稿时同样是发送
  const typing = composerView(baseSignals({ streaming: false, draft: '我在打字' }))
  assertEqual(composerLiveView(typing, true).primary, 'send', '有内容就是发送')
  assertEqual(composerLiveView(typing, true).secondaryAction, 'stop', '停止让到第二颗钮')
})

/* ─────────────────────────── B. 回车意图 / 提示条 ─────────────────────────── */

check('B1 回车意图：send / steer / queue / command / none', async () => {
  assertEqual(composerIntent(baseSignals({ draft: '你好' })), 'send', '空闲发消息')
  assertEqual(composerIntent(baseSignals({ draft: '你好', streaming: true })), 'steer', '生成中默认插话')
  assertEqual(
    composerIntent(baseSignals({ draft: '你好', streaming: true, sendMode: 'queue' })),
    'queue',
    '切排队后走 queue',
  )
  assertEqual(composerIntent(baseSignals({ draft: '/status', knownCommand: true })), 'command', '空闲执行命令')
  assertEqual(composerIntent(baseSignals({ draft: '/status', knownCommand: true, streaming: true })), 'none', '生成中不执行')
  assertEqual(composerIntent(baseSignals({ draft: '', attachments: 1 })), 'send', '只有附件也能发')
})

check('B2 提示文案：插话 / 排队 / 已排队 / 打斜杠 / 默认', async () => {
  assertEqual(composerHint(baseSignals({ streaming: true })).key, 'composerHintBusySteer', '生成中默认插话')
  assertEqual(
    composerHint(baseSignals({ streaming: true, sendMode: 'queue' })).key,
    'composerHintBusy',
    '切成排队后的文案',
  )
  assertEqual(
    composerHint(baseSignals({ streaming: true, queueLength: 2 })),
    { key: 'composerHintQueued', params: { count: 2 } },
    '生成中且队列非空',
  )
  assertEqual(composerHint(baseSignals({ slashTyping: true })).key, 'chatControlsSlashTyping', '打斜杠')
  assertEqual(composerHint(baseSignals()).key, 'remoteInputHint', '默认')
})

/* ─────────────────────────── B3. 发送通道（mode 探测） ─────────────────────────── */

/** 记录 send / sendWithMode 的假 store */
const fakeStore = (withMode: boolean) => {
  const calls: Array<{ kind: 'send' | 'mode'; text: string; mode?: string }> = []
  const store: { send(text: string): Promise<void>; sendWithMode?(text: string, mode: string): Promise<void> } = {
    send: async (text: string): Promise<void> => {
      calls.push({ kind: 'send', text })
    },
  }
  if (withMode) {
    store.sendWithMode = async (text: string, mode: string): Promise<void> => {
      calls.push({ kind: 'mode', text, mode })
    }
  }
  return { store, calls }
}

check('B3 数据层支持 sendWithMode → 真的以 steer 发出去', async () => {
  const { store, calls } = fakeStore(true)
  assertEqual(supportsPromptMode(store), true, '能力探测')
  assertEqual(dispatchPrompt(store, '插一句', 'steer'), 'steer', '返回实际 mode')
  await tick()
  assertEqual(calls, [{ kind: 'mode', text: '插一句', mode: 'steer' }], '走 sendWithMode')
})

check('B4 数据层还不支持 → 退回 send()（Host 的 queue 语义）并如实回报', async () => {
  const { store, calls } = fakeStore(false)
  assertEqual(supportsPromptMode(store), false, '能力探测')
  assertEqual(dispatchPrompt(store, '改一下', 'steer'), 'queue', '实际是 queue，不谎报 steer')
  await tick()
  assertEqual(calls, [{ kind: 'send', text: '改一下' }], '退回 send()')
})

check('B5 queue 模式 / sender 形状不认识', async () => {
  const { store, calls } = fakeStore(true)
  assertEqual(dispatchPrompt(store, 'x', 'queue'), 'queue', 'queue 不走 sendWithMode')
  await tick()
  assertEqual(calls, [{ kind: 'send', text: 'x' }], 'queue 就是 send()')
  assertEqual(dispatchPrompt(null, 'x', 'steer'), null, 'null sender')
  assertEqual(dispatchPrompt({}, 'x', 'steer'), null, '没有 send 的对象')
})

/* ─────────────────────────── C. 排队区增删 ─────────────────────────── */

/** 往 store 里推一帧 `inbox` 投影（等价于 Host 的 `session/control` 推队列） */
const pushInbox = (rows: Array<{ id: string; text: string }>): void => {
  applyControlFrame({
    type: 'projection',
    sessionId: 'sess-1',
    seq: 1,
    changes: [
      {
        key: 'inbox',
        val: {
          'next-step': [],
          'next-turn': rows.map((row) => ({
            id: row.id,
            source: { kind: 'user', rpcId: `rpc-${row.id}` },
            content: [{ type: 'text', text: row.text }],
          })),
        },
      },
    ],
  })
}

check('C1 投影推来两条 → 排队区两条（能力判定为可用）', async () => {
  const fake = harness()
  bind(fake)
  selectControlSession('sess-1')
  pushInbox([
    { id: 'q-1', text: '顺手把截图也换掉' },
    { id: 'q-2', text: '跑一遍 pnpm run type' },
  ])
  await tick()
  const state = useChatControls.getState()
  assertEqual(state.queue.map((item) => item.id), ['q-1', 'q-2'], '队列 id 顺序')
  assertEqual(state.queue[0]?.preview, '顺手把截图也换掉', 'preview')
  assertEqual(showsQueueDock(state), true, '有条目就显示')
})

/** `session/updateQueue` 的成功应答（`sessionControls` 要求 `accepted === true`） */
const QUEUE_ACCEPTED: Reply = { ok: true, value: { accepted: true } }

check('C2 steer：端点 / 参数形状正确，且本地立刻摘掉那一条', async () => {
  const fake = harness({ 'session/updateQueue': QUEUE_ACCEPTED })
  bind(fake)
  selectControlSession('sess-1')
  pushInbox([{ id: 'q-1', text: 'A' }, { id: 'q-2', text: 'B' }])
  await tick()
  const ok = await useChatControls.getState().updateQueueItem('q-1', 'steer')
  await tick()
  assertTrue(ok, 'steer 应成功')
  assertEqual(
    fake.lastArgs('session/updateQueue'),
    { request: { sessionId: 'sess-1', itemId: 'q-1', action: { kind: 'steer' } } },
    'steer 的 args',
  )
  assertEqual(useChatControls.getState().queue.map((item) => item.id), ['q-2'], '本地摘除 q-1')
  assertEqual(useChatControls.getState().queueBusy, null, 'busy 复位')
})

check('C3 remove：同一条通道，action.kind = remove', async () => {
  const fake = harness({ 'session/updateQueue': QUEUE_ACCEPTED })
  bind(fake)
  selectControlSession('sess-1')
  pushInbox([{ id: 'q-1', text: 'A' }, { id: 'q-2', text: 'B' }])
  await tick()
  assertTrue(await useChatControls.getState().updateQueueItem('q-2', 'remove'), 'remove 应成功')
  await tick()
  assertEqual(
    fake.lastArgs('session/updateQueue'),
    { request: { sessionId: 'sess-1', itemId: 'q-2', action: { kind: 'remove' } } },
    'remove 的 args',
  )
  assertEqual(useChatControls.getState().queue.map((item) => item.id), ['q-1'], '剩下的那条')
})

check('C4 队列行状态：没有 id 不可点；有一条在飞时全禁用', async () => {
  assertEqual(queueRowState({ id: 'q-1' }, null), { busy: false, enabled: true, actionable: true }, '正常行')
  assertEqual(queueRowState({ id: 'q-1' }, 'q-1'), { busy: true, enabled: false, actionable: true }, '本条在飞')
  assertEqual(queueRowState({ id: 'q-2' }, 'q-1'), { busy: false, enabled: false, actionable: true }, '别的在飞')
  assertEqual(queueRowState({}, null), { busy: false, enabled: false, actionable: false }, '没有 id')
})

check('C5 排队行预览：折叠空白 / 空正文占位 / 超长截断', async () => {
  assertEqual(queuePreviewText('  改  一下\t标题 ', '（空）'), '改 一下 标题', '折叠空白')
  assertEqual(queuePreviewText('   ', '（空）'), '（空）', '空正文用占位')
  const long = 'x'.repeat(120)
  assertEqual(queuePreviewText(long, '（空）'), `${'x'.repeat(96)}…`, '按 96 字截断')
})

check('C6 updateQueue 不可用（METHOD_NOT_FOUND）：队列条整条隐藏', async () => {
  const fake = harness({ 'session/updateQueue': { ok: false, code: 'METHOD_NOT_FOUND' } })
  bind(fake)
  selectControlSession('sess-1')
  pushInbox([{ id: 'q-1', text: 'A' }])
  await tick()
  assertTrue(await useChatControls.getState().updateQueueItem('q-1', 'steer') === false, '应返回 false')
  await tick()
  const state = useChatControls.getState()
  assertEqual(state.queueAccess, 'unavailable', '能力标记为不可用')
  assertEqual(showsQueueDock(state), false, '队列条隐藏')
  assertEqual(state.error, null, '能力缺失不写错误')
})

/* ─────────────────────────── D. 胶囊折叠与思考强度 ─────────────────────────── */

check('D1 档位解析：选择里的值优先，其次模型的 defaultEffort', async () => {
  const levels = effortLevelsOf(CATALOG, { provider: 'deepseek', model: 'deepseek-reasoner' })
  assertEqual(levels.map((item) => item.id), ['low', 'medium', 'high'], '档位顺序')
  assertEqual(
    activeEffortIdOf(CATALOG, { provider: 'deepseek', model: 'deepseek-reasoner' }),
    'medium',
    '没选过就是 defaultEffort',
  )
  assertEqual(
    activeEffortIdOf(CATALOG, { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' }),
    'high',
    '投影/选择优先',
  )
  assertEqual(effortNameOf(levels, 'high'), '高', '档位显示名')
  assertEqual(showsEffortSlider(levels), true, '三档要画滑条')
})

check('D2 胶囊折叠：模型没声明档位时第二段整段不渲染', async () => {
  assertEqual(
    modelPillText(CATALOG, { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' }),
    { name: 'DeepSeek Reasoner', effortId: 'high', effortName: '高' },
    '有档位：模型 + 档位',
  )
  assertEqual(
    modelPillText(CATALOG, { provider: 'deepseek', model: 'deepseek-chat' }),
    { name: 'DeepSeek Chat', effortId: null, effortName: null },
    '无档位：只显示模型名',
  )
  // 目录还没到（首帧）：只回落到 model id，不显示半截档位
  assertEqual(
    modelPillText(null, { provider: 'acme', model: 'acme-large' }),
    { name: 'acme-large', effortId: null, effortName: null },
    '没有目录',
  )
  assertEqual(showsEffortSlider([]), false, '没有档位不画滑条')
})

check('D3 滑条几何：下标 / 比例 / 反解 / 磁吸', async () => {
  const levels = effortLevelsOf(CATALOG, { provider: 'deepseek', model: 'deepseek-reasoner' })
  assertEqual(effortIndex(levels, 'medium'), 1, 'index(medium)')
  assertEqual(effortIndex(levels, undefined), -1, '没解析出来是 -1')
  assertEqual(effortIndex(levels, 'nope'), -1, '未知档位是 -1')
  assertEqual(effortRatioOf(0, 3), 0, '最低档在 0')
  assertEqual(effortRatioOf(1, 3), 0.5, '中间档在 0.5')
  assertEqual(effortRatioOf(2, 3), 1, '最高档在 1')
  assertEqual(effortRatioOf(-1, 3), 0, '解析不出来停在起点')
  assertEqual(effortRatioOf(0, 1), 0, '单档不出现 NaN')
  assertEqual(ratioToIndex(0.4, 3), 1, '0.4 落在中档')
  assertEqual(ratioToIndex(1.4, 3), 2, '越界夹到最高档')
  assertEqual(ratioToIndex(-1, 3), 0, '越界夹到最低档')
  assertEqual(ratioToIndex(0.5, 0), 0, '零档不炸')
  // 磁吸：贴着档位时被往档位拉，中间区域保持原值
  assertTrue(Math.abs(magnetizeRatio(0.52, 3) - 0.5) < 0.03, '靠近中档被吸过去')
  assertEqual(magnetizeRatio(0.34, 3), 0.34, '离得远就不动')
  assertEqual(magnetizeRatio(0.7, 1), 0.7, '单档不做磁吸')
})

check('D4 真 selectModel：滑动档位带 reasoningEffort 发出去', async () => {
  const fake = harness()
  bind(fake)
  selectControlSession('sess-1')
  useChatControls.setState({ modelCatalog: CATALOG, modelAccess: 'available' })
  const ok = await useChatControls.getState().selectModel({
    provider: 'deepseek',
    model: 'deepseek-reasoner',
    reasoningEffort: 'high',
  })
  await tick()
  assertTrue(ok, 'selectModel 应成功')
  assertEqual(
    fake.lastArgs('session/selectModel'),
    { request: { sessionId: 'sess-1', provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' } },
    'session/selectModel 的 args',
  )
  assertEqual(
    useChatControls.getState().currentModel,
    { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' },
    '本地选中值跟上',
  )
})

check('D5 换模型不带旧档位：只发 provider + model', async () => {
  const fake = harness()
  bind(fake)
  selectControlSession('sess-1')
  useChatControls.setState({ modelCatalog: CATALOG, modelAccess: 'available' })
  await useChatControls.getState().selectModel({ provider: 'deepseek', model: 'deepseek-chat' })
  await tick()
  assertEqual(
    fake.lastArgs('session/selectModel'),
    { request: { sessionId: 'sess-1', provider: 'deepseek', model: 'deepseek-chat' } },
    '不能把上一个模型的档位带过去',
  )
})

/* ─────────────────────────── E. 能力降级 ─────────────────────────── */

check('E1 模型目录不可用：胶囊整块不渲染', async () => {
  const fake = harness({ 'session/modelCatalog': { ok: false, code: 'METHOD_NOT_FOUND' } })
  bind(fake)
  selectControlSession('sess-1')
  await useChatControls.getState().loadModelCatalog(true)
  await tick()
  assertEqual(useChatControls.getState().modelAccess, 'unavailable', '能力标记')
  assertEqual(showsModelCapsule(useChatControls.getState()), false, '胶囊隐藏')
  assertEqual(useChatControls.getState().error, null, '能力缺失不写错误')
})

/* ─────────────────────────── 跑 ─────────────────────────── */

const reportFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'report.txt')
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
    // 每个用例都从干净的 store 开始，避免用例之间互相污染
    unbindSessionControls()
  }
}
lines.push('', `总计 ${checks.length} 项，${checks.length - failures} PASS / ${failures} FAIL`)
fs.writeFileSync(reportFile, `${lines.join('\n')}\n`, 'utf8')
for (const line of lines) console.log(line)
process.exit(failures === 0 ? 0 : 1)
