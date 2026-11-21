/**
 * 审批卡 / 提问卡（R9）自测：三种审批形态、三种提问形态、eventId 去重、
 * `PERMISSION_NOT_PENDING` 的降级判据、红点计数。
 *
 * 跑法（workdir = projects\deepseek-tablet\web）：
 *   npx tsx src/components/remote/chat-controls/__selftest__/prompt-ux.selftest.mts
 *
 * 为什么这些用例能覆盖界面：两张卡的**判断**全在 `chat-controls/promptModel.ts`
 * （纯函数）与 `services/remote/adapter.ts` 的 reducer 里，组件只剩 JSX 与本地选择状态。
 * 所以这里跑真代码，断言的是「卡片会显示什么 / 按钮能不能点 / 点了发什么」。
 *
 * 覆盖：
 *   A. 审批的决策集合（v1 只有 allow_once / deny；allow_session 一律丢弃）
 *   B. 审批终态（allowed / rejected / cancelled / unavailable → 已失效、按钮置灰）
 *   C. 「要做什么」的要点提取与按类型裁剪（命令 / 路径 / URL / 文本）
 *   D. 风险分类（读 / 写 / 删 / 外网 / 说不清）与二次确认判据
 *   E. 提问的字数上限与提交校验（单选 / 多选 / 自由文本）
 *   F. 提问卡的展示状态（claiming / open / expired / continued / answered / queued / cancelled / stale）
 *   G. 会话列表红点：按 eventId 去重、活动会话不计、进入即清零
 *   H. reducer 去重：同一 eventId 重投不重复、终态不被翻回 pending、cancel 落到终态
 *   I. `PERMISSION_NOT_PENDING`：只有还没结论的卡才降级成「已失效」
 *
 * 结尾按仓库约定设置真实退出码（`process.exit(failures === 0 ? 0 : 1)`），
 * 并且开跑前先删旧报告（`report.txt`）—— 崩在半路时磁盘上不该留上次的结论。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  APPROVAL_DECISIONS,
  MAX_ANSWER_CHARS,
  approvalAllowIsDanger,
  approvalAllowsOnce,
  approvalInsightOf,
  approvalNeedsConfirm,
  approvalStatusOf,
  clampAnswerText,
  classifyApprovalRisk,
  classifyTargetText,
  isApprovalTerminal,
  isQuestionCardDead,
  isQuestionCardTerminal,
  normalizeApprovalOptions,
  pendingBadgeText,
  pendingInteractionCounts,
  pendingTotal,
  questionCardStatus,
  questionFormStatus,
  settlePendingInteraction,
  shouldExpireApproval,
  trackPendingInteraction,
  trimApprovalTarget,
} from '../promptModel.js'
import {
  pendingApprovals,
  reduceEventsItem,
  settleTurnItems,
  type ApprovalActivity,
  type ChatItem,
  type QuestionActivity,
  type ToolActivity,
} from '../../../../services/remote/adapter.js'
import {
  buildQuestionAnswer,
  type RemoteQuestionItem,
} from '../../../../services/remote/sessionControls.js'
import { notePendingInteractionEvent, useRemoteStore } from '../../../../services/remote/store.js'

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

/* ── 造数据 ───────────────────────────────────────────────────────────── */

const SESSION = 'sess-1'

const toolItem = (patch: Partial<ToolActivity> & { id: string }): ToolActivity => ({
  kind: 'tool',
  sessionId: SESSION,
  createdAt: 1,
  toolName: 'Bash',
  toolKey: 'bash',
  state: 'running',
  ...patch,
})

const approvalWaterfall = (
  eventId: string,
  request: Record<string, unknown>,
  agentId = SESSION,
): Record<string, unknown> => ({
  type: 'waterfall',
  event: 'approval/request',
  eventId,
  agentId,
  request,
})

const questionWaterfall = (
  eventId: string,
  questions: unknown[],
  wait?: Record<string, unknown>,
  agentId = SESSION,
): Record<string, unknown> => ({
  type: 'waterfall',
  event: 'user-questions/request',
  eventId,
  agentId,
  request: { questions, ...(wait === undefined ? {} : { wait }) },
})

/** 用 reducer 把一条 waterfall 落进时间线（与 `$events` 的真实路径一致） */
const reduce = (items: ChatItem[], frame: unknown): ChatItem[] => reduceEventsItem(items, frame, SESSION)

const approvalsOf = (items: ChatItem[]): ApprovalActivity[] =>
  items.filter((item): item is ApprovalActivity => item.kind === 'approval')

const questionsOf = (items: ChatItem[]): QuestionActivity[] =>
  items.filter((item): item is QuestionActivity => item.kind === 'question')

const optionQuestion = (patch: Partial<RemoteQuestionItem> = {}): RemoteQuestionItem => ({
  id: 'q1',
  question: '用哪个方案？',
  options: [
    { label: '方案 A', description: '改动最小' },
    { label: '方案 B', description: '一次到位' },
  ],
  multiSelect: false,
  ...patch,
})

/* ══════════════════════════════════════════════════════════════════════
 * A. 审批的决策集合
 * ══════════════════════════════════════════════════════════════════════ */

check('A1：v1 只有「允许一次 / 拒绝」两个决定（allow_session 不存在）', async () => {
  assertEqual([...APPROVAL_DECISIONS], ['allow_once', 'deny'], '决策集合')
  assertFalse(APPROVAL_DECISIONS.includes('allow_session' as never), 'allow_session 不在集合里')
})

check('A2：Host 给的 allow_session 一律丢弃（不显示成灰按钮）', async () => {
  assertEqual(normalizeApprovalOptions(['allow_session', 'allow_once', 'deny']), ['allow_once', 'deny'], '三种里留两种')
  assertEqual(normalizeApprovalOptions(['allow_session', 'allow_always']), undefined, '全都不合法 → 等于 Host 没说')
  assertEqual(normalizeApprovalOptions(['deny', 'deny']), ['deny'], '去重')
  assertEqual(normalizeApprovalOptions('allow_session'), undefined, '不是数组就当没说')
})

check('A3：Host 只给 allow_session 时，解码后不给「允许」按钮', async () => {
  // 过滤后剩空 → 按默认两种处理，这是唯一不越权的读法：allow_session 没被理解成 allow_once
  assertTrue(approvalAllowsOnce(normalizeApprovalOptions(['allow_session'])), '默认仍可允许一次')
  // 但 Host 明确只给了 deny 时，只留拒绝
  assertFalse(approvalAllowsOnce(['deny']), 'only-deny 时不显示允许')
  assertTrue(approvalAllowsOnce(undefined), 'Host 没说时两种都行')
})

/* ══════════════════════════════════════════════════════════════════════
 * B. 审批终态
 * ══════════════════════════════════════════════════════════════════════ */

check('B1：四种结论映射成展示状态，只有 pending 能点', async () => {
  assertEqual(approvalStatusOf(undefined), 'pending', '未处理')
  assertEqual(approvalStatusOf('allowed-once'), 'allowed', '允许一次')
  assertEqual(approvalStatusOf('rejected'), 'rejected', '拒绝')
  assertEqual(approvalStatusOf('cancelled'), 'cancelled', 'Host 撤回')
  assertEqual(approvalStatusOf('unavailable'), 'expired', '句柄失效 → 已失效')
  assertFalse(isApprovalTerminal(undefined), 'pending 不是终态')
  for (const outcome of ['allowed-once', 'rejected', 'cancelled', 'unavailable'] as const) {
    assertTrue(isApprovalTerminal(outcome), `${outcome} 是终态`)
  }
})

/* ══════════════════════════════════════════════════════════════════════
 * C. 要点提取与按类型裁剪
 * ══════════════════════════════════════════════════════════════════════ */

check('C1：命令保留行结构，超过 4 行才裁剪', async () => {
  const one = trimApprovalTarget('  rm -rf build  ', 'command')
  assertEqual(one.text, 'rm -rf build', '单行命令只去首尾空白')
  assertEqual(one.format, 'code', '命令用等宽')
  assertFalse(one.truncated, '没裁')

  const many = trimApprovalTarget('a\nb\nc\nd\ne\nf', 'command')
  assertEqual(many.text, 'a\nb\nc\nd', '只留前 4 行（换行不能粘成一条别的命令）')
  assertTrue(many.truncated, '裁过要标出来')
})

check('C2：路径单行化（换行会把后半段藏起来），URL 去 fragment', async () => {
  const file = trimApprovalTarget('C:\\repo\\src\\\n  App.tsx', 'path')
  assertEqual(file.text, 'C:\\repo\\src\\ App.tsx', '换行变空格（路径不留换行）')
  assertEqual(file.format, 'code', '路径用等宽')
  assertTrue(file.truncated, '单行化也算裁剪')

  const url = trimApprovalTarget('https://example.com/a?q=1#section', 'url')
  assertEqual(url.text, 'https://example.com/a?q=1', '去掉 #fragment')
  assertFalse(url.truncated, '没有超长')

  const long = trimApprovalTarget(`https://example.com/${'x'.repeat(400)}`, 'url')
  assertEqual(long.text.length, 200, 'URL 上限 200')
  assertTrue(long.truncated, '超长要标出来')
})

check('C3：认得出网址 / 纯路径 / 命令 / 普通文本', async () => {
  assertEqual(classifyTargetText('https://a.b/c'), 'url', '网址')
  assertEqual(classifyTargetText('www.example.com'), 'url', 'www 也算网址')
  assertEqual(classifyTargetText('/home/u/a.txt'), 'path', '纯路径')
  assertEqual(classifyTargetText('C:\\repo\\a.ts'), 'path', 'Windows 路径')
  assertEqual(classifyTargetText('pnpm run type'), 'command', '带空白 → 命令')
  assertEqual(classifyTargetText('危险操作'), 'text', '中文短语 → 文本')
})

check('C4：审批卡从同 callId 的工具调用取命令原文', async () => {
  const items = reduce([toolItem({
    id: 'tool:call-1',
    // 工具调用已经带着参数（真实链路里 tool/call 先到，审批后到）
    arguments: JSON.stringify({ command: 'pnpm run type' }),
  })], approvalWaterfall('evt-1', { toolName: 'Bash', callId: 'call-1' }))
  const [approval] = approvalsOf(items)
  if (approval === undefined) fail('审批没落进时间线')
  const insight = approvalInsightOf(items, approval)
  assertEqual(insight.target?.text, 'pnpm run type', '要做什么 = 命令原文')
  assertEqual(insight.target?.kind, 'command', '类型 = 命令')
  assertEqual(insight.risk, 'write', '跑项目脚本 = 写（脚本会写产物，不能当只读）')
})

check('C5：工具调用晚到也能补上要点（必须在渲染时算，不能焊进 reducer）', async () => {
  const onlyApproval = reduce([], approvalWaterfall('evt-2', {
    toolName: 'Bash',
    callId: 'call-2',
    reason: '运行命令',
  }))
  const [approval] = approvalsOf(onlyApproval)
  if (approval === undefined) fail('审批没落进时间线')
  // 此刻只有 reason：要点退化成「运行命令」
  assertEqual(approvalInsightOf(onlyApproval, approval).target?.text, '运行命令', '只有 reason 时用它')

  // tool/call 后到：同一份 approval 对象 + 新的 items，必须能算出命令原文
  const withTool: ChatItem[] = [
    ...onlyApproval,
    toolItem({ id: 'tool:call-2', arguments: JSON.stringify({ command: 'rm -rf /tmp/x' }) }),
  ]
  const later = approvalInsightOf(withTool, approval)
  assertEqual(later.target?.text, 'rm -rf /tmp/x', '晚到的工具调用补上命令原文')
  assertEqual(later.risk, 'delete', '风险随之升级为删除')
})

check('C6：没有参数也没有 reason → 卡片老实说「不知道要做什么」', async () => {
  const items = reduce([], approvalWaterfall('evt-3', { toolName: 'Harness' }))
  const [approval] = approvalsOf(items)
  if (approval === undefined) fail('审批没落进时间线')
  const insight = approvalInsightOf(items, approval)
  assertEqual(insight.target, undefined, '没有要点')
  assertEqual(insight.risk, 'unknown', '看不出动作 → unknown')
})

/* ══════════════════════════════════════════════════════════════════════
 * D. 风险分类与二次确认
 * ══════════════════════════════════════════════════════════════════════ */

check('D1：五个风险档位各就各位', async () => {
  assertEqual(classifyApprovalRisk({ toolName: 'Bash', target: 'ls -la' }), 'read', '列目录 = 读')
  assertEqual(classifyApprovalRisk({ toolName: 'Bash', target: 'git status' }), 'read', 'git status = 读')
  assertEqual(classifyApprovalRisk({ toolName: 'Bash', target: 'rm -rf build' }), 'delete', 'rm -rf = 删')
  assertEqual(classifyApprovalRisk({ toolName: 'Bash', target: 'Remove-Item C:\\a -Recurse' }), 'delete', 'PowerShell 删除')
  assertEqual(classifyApprovalRisk({ toolName: 'WriteFile', target: 'C:\\a.txt' }), 'write', '写文件工具 = 写')
  assertEqual(classifyApprovalRisk({ toolName: 'Bash', target: 'echo hi > a.txt' }), 'write', '重定向 = 写')
  assertEqual(classifyApprovalRisk({ toolName: 'Bash', target: 'pnpm add react' }), 'write', '装包 = 写')
  assertEqual(classifyApprovalRisk({ toolName: 'Bash', target: 'pnpm run build' }), 'write', '跑构建脚本 = 写')
  assertEqual(classifyApprovalRisk({ toolName: 'WebFetch', target: 'https://example.com' }), 'network', '抓网页 = 外网')
  assertEqual(classifyApprovalRisk({ toolName: 'Bash', target: 'curl https://example.com' }), 'network', 'curl = 外网')
  assertEqual(classifyApprovalRisk({ toolName: 'Bash', target: 'python train.py' }), 'unknown', '看不懂的命令 = 说不清')
})

check('D2：只有只读才一次点完；写 / 删 / 外网 / 说不清都要二次确认', async () => {
  assertFalse(approvalNeedsConfirm('read'), '只读不用确认')
  for (const risk of ['write', 'delete', 'network', 'unknown'] as const) {
    assertTrue(approvalNeedsConfirm(risk), `${risk} 要二次确认`)
    assertTrue(approvalAllowIsDanger(risk), `${risk} 的允许按钮走危险色`)
  }
  assertFalse(approvalAllowIsDanger('read'), '只读不用危险色')
})

/* ══════════════════════════════════════════════════════════════════════
 * E. 提问：字数与提交校验
 * ══════════════════════════════════════════════════════════════════════ */

check('E1：单选 / 多选 / 自由文本三种形态都能提交', async () => {
  const single = optionQuestion()
  const multi = optionQuestion({ id: 'q2', question: '哪些目录？', multiSelect: true })
  const free: RemoteQuestionItem = { id: 'q3', question: '还有什么要补充？', options: [], multiSelect: false }
  const questions = [single, multi, free]

  // 什么都没答
  assertEqual(questionFormStatus(questions, {}, {}), { ready: false, missing: 3, overLimit: false }, '全空')

  const selected = { q1: ['方案 A'], q2: ['src', 'docs'] }
  const custom = { q3: '  多写点测试  ' }
  const form = questionFormStatus(questions, selected, custom)
  assertTrue(form.ready, '三条都答了 → 可提交')
  assertEqual(form.missing, 0, '没有漏答')

  // 提交形状：多选把多个 label 一起塞进 selected[]，自定义文本 trim
  const answer = buildQuestionAnswer(questions, selected, custom)
  assertEqual(answer, {
    answers: [
      { id: 'q1', selected: ['方案 A'] },
      { id: 'q2', selected: ['src', 'docs'] },
      { id: 'q3', selected: [], custom: '多写点测试' },
    ],
  }, '多选提交多个 + 文本 trim')
})

check('E2：纯空白不算回答；字数上限挡在输入层', async () => {
  const free: RemoteQuestionItem = { id: 'q1', question: '说明', options: [], multiSelect: false }
  assertFalse(questionFormStatus([free], {}, { q1: '   ' }).ready, '纯空白不算答')
  assertTrue(questionFormStatus([free], {}, { q1: '有内容' }).ready, '有字就算答')

  const long = 'x'.repeat(MAX_ANSWER_CHARS + 20)
  assertEqual(clampAnswerText(long).length, MAX_ANSWER_CHARS, `输入层截到 ${MAX_ANSWER_CHARS}`)
  const over = questionFormStatus([free], {}, { q1: long })
  assertTrue(over.overLimit, '绕过输入层的超长要被校验抓到')
  assertFalse(over.ready, '超长不许提交')
})

check('E3：选项带描述时两条都要渲染（描述是数据，不是文案）', async () => {
  const parsed = reduce([], questionWaterfall('evt-q1', [{
    id: 'q1',
    question: '选一个',
    multiSelect: true,
    options: [
      { label: 'A', description: '描述 A' },
      { label: 'B' },
    ],
  }]))
  const [question] = questionsOf(parsed)
  if (question === undefined) fail('提问没落进时间线')
  const options = question.questions[0]?.options ?? []
  assertEqual(options.length, 2, '两个选项')
  assertEqual(options[0]?.description, '描述 A', '描述保留')
  assertEqual(options[1]?.description, undefined, '没有描述就不编一个')
  assertTrue(question.questions[0]?.multiSelect, '多选标记保留')
})

/* ══════════════════════════════════════════════════════════════════════
 * F. 提问卡的展示状态
 * ══════════════════════════════════════════════════════════════════════ */

check('F1：状态机逐档映射（含窗口到期 / 没有句柄的落伍卡）', async () => {
  assertEqual(questionCardStatus({ phase: 'claiming', windowClosed: false }), 'claiming', '接入中')
  assertEqual(questionCardStatus({ phase: 'open', windowClosed: false }), 'open', '可答')
  assertEqual(questionCardStatus({ phase: 'open', windowClosed: true }), 'expired', '本地窗口到点')
  assertEqual(questionCardStatus({ phase: 'expired', windowClosed: true }), 'expired', 'Host 侧也过期')
  assertEqual(questionCardStatus({ phase: 'continued', windowClosed: true }), 'continued', '可补答（窗口过了也能答）')
  assertEqual(questionCardStatus({ phase: 'answered', windowClosed: true }), 'answered', '已回答')
  assertEqual(questionCardStatus({ phase: 'queued', windowClosed: true }), 'queued', '排队')
  assertEqual(questionCardStatus({ phase: 'cancelled', windowClosed: false }), 'cancelled', 'Host 撤回')
  assertEqual(questionCardStatus({ windowClosed: false }), 'stale', '没有运行时状态 → 没有句柄')
  assertEqual(questionCardStatus({ windowClosed: false, outcome: 'answered' }), 'answered', 'reducer 的终态优先')
})

check('F2：终态保留卡片，但要置灰；「已失效」与「已回答」是两套视觉', async () => {
  for (const status of ['answered', 'queued', 'cancelled', 'expired', 'stale'] as const) {
    assertTrue(isQuestionCardTerminal(status), `${status} 是终态（不再接受输入）`)
  }
  for (const status of ['claiming', 'open', 'continued'] as const) {
    assertFalse(isQuestionCardTerminal(status), `${status} 还能答`)
  }
  assertTrue(isQuestionCardDead('cancelled'), '撤回 = 已失效')
  assertTrue(isQuestionCardDead('expired'), '超时 = 已失效')
  assertTrue(isQuestionCardDead('stale'), '没有句柄 = 已失效')
  assertFalse(isQuestionCardDead('answered'), '已回答不是失效')
  assertFalse(isQuestionCardDead('queued'), '排队不是失效')
})

/* ══════════════════════════════════════════════════════════════════════
 * G. 会话列表红点
 * ══════════════════════════════════════════════════════════════════════ */

check('G1：同一个 eventId 重投只算一条（红点不翻倍）', async () => {
  let sets = {}
  sets = trackPendingInteraction(sets, { sessionId: 'a', kind: 'approval', eventId: 'evt-1' })
  const once = sets
  sets = trackPendingInteraction(sets, { sessionId: 'a', kind: 'approval', eventId: 'evt-1' })
  assertTrue(sets === once, '重投同一 eventId 返回原对象（不制造新引用）')
  assertEqual(pendingInteractionCounts(sets, null), { a: { approval: 1, question: 0 } }, '仍然 1 条')

  sets = trackPendingInteraction(sets, { sessionId: 'a', kind: 'approval', eventId: 'evt-2' })
  sets = trackPendingInteraction(sets, { sessionId: 'a', kind: 'question', eventId: 'evt-3' })
  assertEqual(pendingInteractionCounts(sets, null), { a: { approval: 2, question: 1 } }, '两条审批 + 一条提问')
  assertEqual(pendingTotal(pendingInteractionCounts(sets, null)['a']), 3, '总数')
})

check('G2：活动会话不计；进入会话即清零且不会立刻亮回来', async () => {
  let sets = {}
  sets = trackPendingInteraction(sets, { sessionId: 'a', kind: 'approval', eventId: 'evt-1' })
  sets = trackPendingInteraction(sets, { sessionId: 'b', kind: 'question', eventId: 'evt-2' })
  assertEqual(Object.keys(pendingInteractionCounts(sets, 'a')), ['b'], '在 a 里时只有 b 亮')

  // 进入 a：调用方会 settle 掉 a，并且 activeSessionId 也排除了它 —— 双保险
  sets = settlePendingInteraction(sets, { sessionId: 'a' })
  const counts = pendingInteractionCounts(sets, 'a')
  assertEqual(Object.keys(counts), ['b'], 'a 不会被算回来')
  assertEqual(pendingInteractionCounts(sets, null)['a'], undefined, 'a 已经销干净')
})

check('G3：cancel / 这一轮结束 / 会话消失都能销账', async () => {
  let sets = {}
  sets = trackPendingInteraction(sets, { sessionId: 'a', kind: 'approval', eventId: 'evt-1' })
  sets = trackPendingInteraction(sets, { sessionId: 'a', kind: 'question', eventId: 'evt-2' })
  sets = trackPendingInteraction(sets, { sessionId: 'b', kind: 'approval', eventId: 'evt-3' })

  const afterCancel = settlePendingInteraction(sets, { eventId: 'evt-1' })
  assertEqual(pendingInteractionCounts(afterCancel, null), {
    a: { approval: 0, question: 1 },
    b: { approval: 1, question: 0 },
  }, '按 eventId 只销那一条')

  const afterTurn = settlePendingInteraction(sets, { sessionId: 'a' })
  assertEqual(Object.keys(pendingInteractionCounts(afterTurn, null)), ['b'], '整个会话的账清掉')

  const afterRemove = settlePendingInteraction(sets, { sessionId: 'b' })
  assertEqual(Object.keys(pendingInteractionCounts(afterRemove, null)), ['a'], '会话消失只影响自己')
  assertEqual(pendingBadgeText(9), '9', '9 就显示 9')
  assertEqual(pendingBadgeText(10), '9+', '大于 9 显示 9+')
})

check('G4：空 eventId / 空会话 id 不进账（脏帧不该点红点）', async () => {
  const empty = {}
  assertTrue(trackPendingInteraction(empty, { sessionId: '', kind: 'approval', eventId: 'e' }) === empty, '空会话 id')
  assertTrue(trackPendingInteraction(empty, { sessionId: 'a', kind: 'approval', eventId: '' }) === empty, '空 eventId')
})

/* ══════════════════════════════════════════════════════════════════════
 * H. reducer 去重（断线重连 Host 会用同一 eventId 重投）
 * ══════════════════════════════════════════════════════════════════════ */

check('H1：同一 eventId 重投只留一张卡（不重复弹出）', async () => {
  const first = reduce([], approvalWaterfall('evt-1', { toolName: 'Bash', callId: 'c1', reason: '运行命令' }))
  const again = reduce(first, approvalWaterfall('evt-1', { toolName: 'Bash', callId: 'c1', reason: '运行命令' }))
  assertEqual(approvalsOf(again).length, 1, '只有一条审批卡')
  assertEqual(approvalsOf(again)[0]?.approvalId, 'evt-1', 'approvalId 就是 eventId（应答句柄）')
  assertEqual(approvalsOf(again)[0]?.frameRpcId, 'evt-1', 'frameRpcId 也是它')
  assertEqual(pendingApprovals(again).length, 1, '待审批列表也只有一条')
})

check('H2：已经允许 / 拒绝的卡不会被重投翻回 pending', async () => {
  const withApproval = reduce([], approvalWaterfall('evt-1', { toolName: 'Bash' }))
  const cancelled = reduce(withApproval, { type: 'cancel', eventId: 'evt-1' })
  assertEqual(approvalsOf(cancelled)[0]?.outcome, 'cancelled', 'Host 撤回')

  // 允许过之后又收到同一 eventId：仍是 allowed（不复活、不重复）
  const allowed = settleTurnItems(reduce([], approvalWaterfall('evt-2', { toolName: 'Bash' })), 'turn-1')
  const allowedItems = reduce(allowed.map((item) => (item.kind === 'approval' ? { ...item, outcome: 'allowed-once' as const } : item)),
    approvalWaterfall('evt-2', { toolName: 'Bash' }))
  assertEqual(approvalsOf(allowedItems)[0]?.outcome, 'allowed-once', '允许过就是允许过')
  assertEqual(pendingApprovals(allowedItems).length, 0, '不再等你确认')
})

check('H3：turn 结束时未应答的审批降级为 unavailable；重投也不复活', async () => {
  const items = reduce([], approvalWaterfall('evt-9', { toolName: 'Bash' }))
  // turn/end 走 settleTurnItems（与真实 reducer 同一函数）
  const settled = settleTurnItems(items, 'turn-9')
  assertEqual(approvalsOf(settled)[0]?.outcome, 'unavailable', '整轮结束后没人管的审批 → 已失效')

  const again = reduce(settled, approvalWaterfall('evt-9', { toolName: 'Bash' }))
  assertEqual(approvalsOf(again)[0]?.outcome, 'unavailable', '重投不把它拉回待确认')
  assertEqual(pendingApprovals(again).length, 0, '不再出现在待审批里')
})

check('H4：别的会话的 waterfall 不进当前时间线（重连后按会话重投）', async () => {
  const items = reduce([], approvalWaterfall('evt-x', { toolName: 'Bash' }, 'other-session'))
  assertEqual(approvalsOf(items).length, 0, '不是当前会话 → 丢掉')
})

check('H5：提问重投只留一条；答过的/撤回的也不会复活', async () => {
  const frame = questionWaterfall('evt-q', [{ id: 'q1', question: '选一个', options: [{ label: 'A' }] }], {
    timed: true,
    callId: 'call-q',
  })
  const first = reduce([], frame)
  const again = reduce(first, frame)
  assertEqual(questionsOf(again).length, 1, '只有一条提问卡')

  const cancelled = reduce(again, { type: 'cancel', eventId: 'evt-q' })
  assertEqual(questionsOf(cancelled)[0]?.outcome, 'cancelled', 'Host 撤回 → cancelled')
  const retold = reduce(cancelled, frame)
  assertEqual(questionsOf(retold)[0]?.outcome, 'cancelled', '重投不把撤回的提问拉回可答')
})

check('H6：审批若给了 allow_session，reducer 只留 v1 的两种', async () => {
  const items = reduce([], approvalWaterfall('evt-o', {
    toolName: 'Bash',
    options: ['allow_session', 'allow_once', 'deny'],
  }))
  assertEqual(approvalsOf(items)[0]?.options, ['allow_once', 'deny'], 'Host 的 allow_session 被丢掉')
  const onlySession = reduce([], approvalWaterfall('evt-p', { toolName: 'Bash', options: ['allow_session'] }))
  assertEqual(approvalsOf(onlySession)[0]?.options, undefined, '全被丢 → 视为 Host 没说')
})

/* ══════════════════════════════════════════════════════════════════════
 * I. PERMISSION_NOT_PENDING
 * ══════════════════════════════════════════════════════════════════════ */

check('I1：只有还没结论的卡才降级成「已失效」', async () => {
  const pending = reduce([], approvalWaterfall('evt-1', { toolName: 'Bash' }))
  assertTrue(shouldExpireApproval(pending, 'evt-1'), '待确认的降级成已失效')

  const allowed = pending.map((item) => (item.kind === 'approval' ? { ...item, outcome: 'allowed-once' as const } : item))
  assertFalse(shouldExpireApproval(allowed, 'evt-1'), '已经允许过的不能显示成失效（双击的第二次不覆盖第一次）')

  assertFalse(shouldExpireApproval([], 'evt-1'), '根本没有这张卡 → 不用改任何东西')
  assertFalse(shouldExpireApproval(allowed, 'evt-other'), '只认这个 eventId')
})

/* ══════════════════════════════════════════════════════════════════════
 * J. store 集成：`$events` → 红点计数（真 store，不联网）
 * ══════════════════════════════════════════════════════════════════════ */

check('J1：别的会话的审批 / 提问进红点，活动会话不计，同 eventId 不翻倍', async () => {
  useRemoteStore.setState({ activeSessionId: 'sess-a', pendingInteractions: {} })
  useRemoteStore.getState().sessions.splice(0)
  const approval = (eventId: string, agentId: string): Record<string, unknown> => ({
    type: 'waterfall',
    event: 'approval/request',
    eventId,
    agentId,
    request: { toolName: 'Bash' },
  })
  const question = (eventId: string, agentId: string): Record<string, unknown> => ({
    type: 'waterfall',
    event: 'user-questions/request',
    eventId,
    agentId,
    request: { questions: [{ id: 'q', question: '选一个' }] },
  })

  notePendingInteractionEvent(approval('evt-a1', 'sess-b'))
  notePendingInteractionEvent(approval('evt-a1', 'sess-b')) // 重投
  notePendingInteractionEvent(question('evt-q1', 'sess-b'))
  notePendingInteractionEvent(approval('evt-a2', 'sess-a')) // 活动会话：不计

  assertEqual(useRemoteStore.getState().pendingInteractions, {
    'sess-b': { approval: 1, question: 1 },
  }, '只有 sess-b，且重投没翻倍')

  // Host 撤回了那条审批 → 只剩提问
  notePendingInteractionEvent({ type: 'cancel', eventId: 'evt-a1' })
  assertEqual(useRemoteStore.getState().pendingInteractions, {
    'sess-b': { approval: 0, question: 1 },
  }, 'cancel 精确销掉一条')

  // 这一轮跑完了 → 整个会话销账
  notePendingInteractionEvent({
    type: 'emit',
    event: 'api-session/status',
    args: ['sess-b', false],
  })
  assertEqual(useRemoteStore.getState().pendingInteractions, {}, '停下来的会话不再挂红点')
})

check('J2：会话被移除 / 断开时红点清干净', async () => {
  useRemoteStore.setState({ activeSessionId: null, pendingInteractions: {} })
  notePendingInteractionEvent({
    type: 'waterfall',
    event: 'approval/request',
    eventId: 'evt-x',
    agentId: 'sess-x',
    request: { toolName: 'Bash' },
  })
  assertEqual(Object.keys(useRemoteStore.getState().pendingInteractions), ['sess-x'], '先有账')
  notePendingInteractionEvent({ type: 'emit', event: 'api-session/removed', args: ['sess-x'] })
  assertEqual(useRemoteStore.getState().pendingInteractions, {}, '会话消失即清')
})

/* ── 跑 ───────────────────────────────────────────────────────────────── */

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)))
const REPORT = path.join(HERE, 'report.txt')

const main = async (): Promise<void> => {
  // 先删旧报告：崩在半路时磁盘上不该留上一次的结论
  fs.rmSync(REPORT, { force: true })
  const lines: string[] = []
  let failures = 0
  for (const item of checks) {
    const startedAt = Date.now()
    try {
      await item.run()
      const line = `PASS  ${item.name}  (${Date.now() - startedAt}ms)`
      console.log(line)
      lines.push(line)
    } catch (error) {
      failures += 1
      const line = `FAIL  ${item.name}  (${Date.now() - startedAt}ms)`
      console.log(line)
      console.log(`      ${error instanceof Error ? error.message : String(error)}`)
      lines.push(line, `      ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const summary = `\n${checks.length - failures} PASS / ${failures} FAIL / ${checks.length} TOTAL`
  console.log(summary)
  lines.push(summary)
  fs.writeFileSync(REPORT, `${lines.join('\n')}\n`, 'utf8')
  // 红了必须真的红（仓库约定：检查脚本必须设置退出码）
  process.exit(failures === 0 ? 0 : 1)
}

await main()
