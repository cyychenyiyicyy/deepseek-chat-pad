/**
 * 产物卡自测（S5，tsx，不联网、不起服务、不碰 DOM）。
 *
 * 跑法（workdir = projects\deepseek-tablet\web）：
 *   npx tsx src/services/remote/__selftest__/artifact.selftest.mts
 *
 * 覆盖：
 *   A. **真实形状**的 `deliverables/presented` 事件解析 —— fixture 逐字节抄自本机
 *      `~/.dsh/sessions/…/session.v4.jsonl.zstd`（session `22c08e43-…`，turn 28，
 *      seq 8201（tool/call）→ 8202（deliverables/presented）→ 8203（tool/result））。
 *      走两条真实通路：`session/follow` 增量（`reduceFollowItem`）与快照（`reduceSnapshot`）。
 *   B. `present` 参数兜底 + 事件升级：同一个 callId 只留一行，事件到了就换成权威路径。
 *   C. **非产物工具不误判**：`write` / `edit` / `apply_patch` / `read` / `bash` / `grep` /
 *      `ui_render` 一律不长产物行；`present` 参数坏 / 空 / 缺 `files` 也不长。
 *   D. 卡片分组：挂载下标 = 该轮最后一行；未结束的轮不返回；同路径去重；会话级去重。
 *   E. 卡片渲染分支：`artifactGroupAtIndex`（挂不挂）与 `visibleArtifactFiles`
 *      （收起 4 个 / 展开全部）+ 标题单复数口径。
 */

import {
  applyFollowEvent,
  createTranscriptState,
  reduceFollowItem,
  reduceSnapshot,
  type ArtifactActivity,
  type ChatItem,
} from '../adapter.js'
import {
  ALL_ARTIFACT_LIMIT,
  artifactFileOf,
  artifactGroupAtIndex,
  artifactKindOf,
  hasHiddenArtifacts,
  sessionArtifacts,
  toWorkspaceRelative,
  turnArtifacts,
  visibleArtifactFiles,
} from '../artifacts.js'

/* ── 极简断言器（与 adapter.selftest.mts 同款） ─────────────────────────── */

const checks: Array<{ name: string; run: () => void }> = []
const check = (name: string, run: () => void): void => {
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

const assertUndefined = (value: unknown, label: string): void => {
  if (value !== undefined) fail(`${label}：期望 undefined，实际 ${JSON.stringify(value)}`)
}

/* ── 真实 fixture（本机 session 22c08e43-… turn 28，逐字段照抄） ─────────── */

const SESSION = 's-ekko'
const APK = 'C:\\Users\\Administrator\\Desktop\\harness workspace\\work\\2026-11-08-ekko平板app打包\\result-EkkoPad-v1.0.1.apk'
const CALL_ID = 'call_00_w4lkgkjrootsj1cl9xbaon5k'

/** seq 8201：`tool/call`，`present` 的参数（`arguments` 是 JSON **字符串**）。 */
const PRESENT_CALL = {
  type: 'tool/call',
  seq: 8201,
  time: 1_794_105_195_926,
  data: {
    turn: 28,
    step: 47,
    callId: CALL_ID,
    name: 'present',
    arguments: JSON.stringify({
      files: [{ description: 'Ekko Pad v1.0.1 — 平板客户端 APK（2.88MB，v2/v3 已签名，可直接安装）', path: APK }],
    }),
  },
}

/** seq 8202：`deliverables/presented` —— 官方交付事件，权威来源。 */
const PRESENTED_EVENT = {
  type: 'deliverables/presented',
  seq: 8202,
  time: 1_794_105_195_943,
  data: {
    turn: 28,
    callId: CALL_ID,
    files: [
      { description: 'Ekko Pad v1.0.1 — 平板客户端 APK（2.88MB，v2/v3 已签名，可直接安装）', path: APK },
    ],
  },
}

/** seq 8203：`tool/result` —— 只有一行文本 `Presented <path>`，**没有**结构化的 files。 */
const PRESENT_RESULT = {
  type: 'tool/result',
  seq: 8203,
  time: 1_794_105_195_943,
  data: {
    turn: 28,
    step: 47,
    message: {
      role: 'tool',
      source: { kind: 'tool', callId: CALL_ID },
      toolCallId: CALL_ID,
      content: [{ type: 'text', text: `Presented ${APK}` }],
      isError: false,
      id: '3f5a46d5-51ca-4f36-b103-743e688a2f58',
    },
  },
}

const TURN_END = {
  type: 'turn/end',
  seq: 8204,
  time: 1_794_105_195_950,
  data: { turn: 28, reason: { kind: 'completed' } },
}

/** 一条 follow item（真实线格式：`{type:'event', event, view?}`）。 */
const followEvent = (event: unknown): unknown => ({ type: 'event', event })

/** 把一串事件喂进 `session/follow` 的增量归约，返回时间线。 */
const viaFollow = (events: readonly unknown[]): ChatItem[] => {
  let state = createTranscriptState()
  for (const event of events) state = reduceFollowItem(state, followEvent(event), SESSION)
  return state.items
}

/** 把一串事件喂进 `session/follow` 的首帧快照，返回时间线。 */
const viaSnapshot = (events: readonly unknown[]): ChatItem[] => {
  const state = reduceSnapshot(
    { hasMore: false, records: events.map((event) => ({ type: 'event', event })), cursor: 0 },
    SESSION,
  )
  return state.items
}

const artifactsOf = (items: readonly ChatItem[]): ArtifactActivity[] =>
  items.filter((item): item is ArtifactActivity => item.kind === 'artifact')

const pathsOf = (item: ArtifactActivity): string[] => item.files.map((file) => file.path)

/* ── A. 真实形状的产物事件 ─────────────────────────────────────────────── */

check('A1 follow：present → deliverables/presented 落成一行 kind:artifact（callId / turn / 路径都对）', () => {
  const items = viaFollow([PRESENT_CALL, PRESENTED_EVENT, PRESENT_RESULT])
  const rows = artifactsOf(items)
  assertEqual(rows.length, 1, '只落一行产物')
  const row = rows[0]!
  assertEqual(row.kind, 'artifact', 'kind')
  assertEqual(row.id, `presented:${CALL_ID}`, 'id 用 callId')
  assertEqual(row.callId, CALL_ID, 'callId')
  assertEqual(row.turn, '28', 'turn（数字转成字符串）')
  assertEqual(row.source, 'event', '来源升级成权威事件')
  assertEqual(pathsOf(row), [APK], '路径')
  assertEqual(row.files[0]?.description, 'Ekko Pad v1.0.1 — 平板客户端 APK（2.88MB，v2/v3 已签名，可直接安装）', '说明')
  assertEqual(row.nativeSeq, 8202, 'nativeSeq 是事件坐标')
})

check('A2 快照：records 里的 deliverables/presented 同样解出一行（历史/重连路径）', () => {
  const items = viaSnapshot([PRESENT_CALL, PRESENTED_EVENT, PRESENT_RESULT])
  const rows = artifactsOf(items)
  assertEqual(rows.length, 1, '快照也落一行')
  assertEqual(rows[0]?.source, 'event', '快照取到的是权威事件')
  assertEqual(pathsOf(rows[0]!), [APK], '路径')
})

check('A3 tool/result 的文本「Presented <path>」不会被当成第二条产物', () => {
  const items = viaFollow([PRESENT_CALL, PRESENTED_EVENT, PRESENT_RESULT])
  assertEqual(artifactsOf(items).length, 1, '结果事件不新增产物行')
  assertEqual(items.filter((item) => item.kind === 'tool').length, 1, '工具行照常只有一行')
})

check('A4 只有事件（历史窗口里 tool/call 被翻页截掉）也能出产物', () => {
  const items = viaFollow([PRESENTED_EVENT, TURN_END])
  const rows = artifactsOf(items)
  assertEqual(rows.length, 1, '单靠事件也能出')
  assertEqual(rows[0]?.source, 'event', '权威来源')
})

check('A5 多文件 + 同路径重复：顺序保留、同路径只留**最新**一份（官方 presentedForClosing 口径）', () => {
  const items = viaFollow([
    {
      type: 'deliverables/presented',
      seq: 101,
      time: 1000,
      data: {
        turn: 3,
        callId: 'c-1',
        files: [
          { path: '/ws/a.pdf', description: 'A' },
          { path: '/ws/b.xlsx' },
          { path: '/ws/a.pdf', description: 'A（改过）' },
        ],
      },
    },
  ])
  // 原始行的 files 保留 Host 给的顺序（adapter 不做去重，去重是读侧的事）
  assertEqual(pathsOf(artifactsOf(items)[0]!), ['/ws/a.pdf', '/ws/b.xlsx', '/ws/a.pdf'], '原始顺序不动')
  // 卡片上看到的是去重后的一份（位置按首次出现，内容取最新）
  const group = turnArtifacts(items, { includeUnsettled: true })[0]!
  assertEqual(group.files.map((file) => file.path), ['/ws/a.pdf', '/ws/b.xlsx'], '同路径合并、顺序保留')
  assertEqual(group.files[0]?.description, 'A（改过）', '同路径留最新那份')
})

/* ── B. present 参数兜底 ───────────────────────────────────────────────── */

check('B1 只有 tool/call（事件还没到）：参数兜底成一行，callId 相同', () => {
  const items = viaFollow([PRESENT_CALL])
  const rows = artifactsOf(items)
  assertEqual(rows.length, 1, '参数兜底出一行')
  assertEqual(rows[0]?.source, 'arguments', '来源是参数')
  assertEqual(rows[0]?.callId, CALL_ID, 'callId 取自 tool/call')
  assertEqual(pathsOf(rows[0]!), [APK], '路径来自参数')
})

check('B2 参数兜底 + 事件到达：同一行升级，不出现两行', () => {
  const items = viaFollow([PRESENT_CALL, PRESENTED_EVENT])
  const rows = artifactsOf(items)
  assertEqual(rows.length, 1, '同 callId 只有一行')
  assertEqual(rows[0]?.source, 'event', '升级成权威来源')
})

check('B3 事件后到、参数重复投递（重连重放）：不会把权威行降级回参数', () => {
  let items = viaFollow([PRESENT_CALL, PRESENTED_EVENT])
  // 重连后 window 里只剩 tool/call，Host 又投一次
  items = applyFollowEvent(items, PRESENT_CALL as never, SESSION, undefined, false)
  const rows = artifactsOf(items)
  assertEqual(rows.length, 1, '仍是一行')
  assertEqual(rows[0]?.source, 'event', '权威来源没被降级')
})

/* ── C. 非产物工具不误判 ───────────────────────────────────────────────── */

const toolCall = (seq: number, name: string, args: Record<string, unknown>, callId = `c-${seq}`) => ({
  type: 'tool/call',
  seq,
  time: 1_000 + seq,
  data: { turn: 9, step: 1, callId, name, arguments: JSON.stringify(args) },
})

const toolResult = (seq: number, callId = `c-${seq - 1}`) => ({
  type: 'tool/result',
  seq,
  time: 1_000 + seq,
  data: {
    turn: 9,
    step: 1,
    message: {
      role: 'tool',
      source: { kind: 'tool', callId },
      toolCallId: callId,
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
      id: `r-${seq}`,
    },
  },
})

check('C1 写类 / 读类 / 终端 / UI 工具一律不长产物行', () => {
  const items = viaFollow([
    toolCall(11, 'write', { file_path: '/ws/report.md', content: '# hi' }),
    toolResult(12),
    toolCall(13, 'edit', { file_path: '/ws/report.md', old_string: 'hi', new_string: 'ho' }),
    toolResult(14),
    toolCall(15, 'apply_patch', { input: '*** Add File: /ws/x.ts\n+1\n' }),
    toolResult(16),
    toolCall(17, 'read', { file_path: '/ws/a.ts' }),
    toolResult(18),
    toolCall(19, 'bash', { command: 'touch /ws/a.pdf' }),
    toolResult(20),
    toolCall(21, 'grep', { pattern: 'x' }),
    toolResult(22),
    toolCall(23, 'ui_render', { root: 'r', components: [{ id: 'r', type: 'text', text: 'hi' }] }),
    toolResult(24),
  ])
  assertEqual(artifactsOf(items).length, 0, '没有 present 就没有产物')
  assertEqual(turnArtifacts(items).length, 0, '分组也是空的')
})

check('C2 present 参数坏 / 空 / 缺 files：不长行（绝不猜）', () => {
  const cases: Array<[string, string]> = [
    ['坏 JSON', '{"files": ['],
    ['不是对象', '"files"'],
    ['空数组', '{"files": []}'],
    ['缺 files', '{}'],
    ['files 不是数组', '{"files": "a.pdf"}'],
    ['路径是空串', '{"files": [{"path": "  "}]}'],
    ['路径不是字符串', '{"files": [{"path": 42}]}'],
  ]
  for (const [label, raw] of cases) {
    const items = viaFollow([
      { type: 'tool/call', seq: 31, time: 1_031, data: { turn: 1, step: 1, callId: 'c-x', name: 'present', arguments: raw } },
    ])
    assertEqual(artifactsOf(items).length, 0, `${label} 不该出产物`)
  }
})

check('C3 deliverables/presented 形状不合法：整条忽略（不半截渲染）', () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ['turn 是 0', { turn: 0, callId: 'c', files: [{ path: '/a.pdf' }] }],
    ['turn 是小数', { turn: 1.5, callId: 'c', files: [{ path: '/a.pdf' }] }],
    ['turn 缺失', { callId: 'c', files: [{ path: '/a.pdf' }] }],
    ['callId 空', { turn: 1, callId: '', files: [{ path: '/a.pdf' }] }],
    ['files 不是数组', { turn: 1, callId: 'c', files: { path: '/a.pdf' } }],
  ]
  for (const [label, data] of bad) {
    const items = viaFollow([{ type: 'deliverables/presented', seq: 41, time: 1_041, data }])
    assertEqual(artifactsOf(items).length, 0, `${label} 整条忽略`)
  }
})

check('C4 名字像 present 但不是（present_files / 拼错的）：不认', () => {
  for (const name of ['present_files', 'Present', 'presentation']) {
    const items = viaFollow([toolCall(51, name, { files: [{ path: '/ws/a.pdf' }] })])
    assertEqual(artifactsOf(items).length, 0, `${name} 不是官方 present`)
  }
})

/* ── D. 卡片分组 ───────────────────────────────────────────────────────── */

const MESSAGE = (seq: number, turn: number, text: string) => ({
  type: 'assistant/message',
  seq,
  time: 2_000 + seq,
  data: {
    turn,
    step: 1,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model' },
      id: `m-${seq}`,
    },
  },
})

check('D1 挂载下标 = 这一轮最后一行（不是 present 那一行）', () => {
  const items = viaFollow([
    PRESENT_CALL,
    PRESENTED_EVENT,
    PRESENT_RESULT,
    MESSAGE(8205, 28, '好了，APK 在附件里。'),
    TURN_END,
  ])
  const groups = turnArtifacts(items)
  assertEqual(groups.length, 1, '一轮一张卡')
  const group = groups[0]!
  assertEqual(group.turn, '28', 'turn')
  const anchor = items[group.endIndex]!
  assertEqual(anchor.kind, 'message', '挂在最后一条消息后面')
  assertEqual((anchor as { role?: string }).role, 'assistant', '是 assistant 的收尾消息')
  assertEqual(items[group.endIndex + 1], undefined, '后面没有别的内容了')
})

check('D2 未结束的轮不返回；turn/end 到了才返回', () => {
  const running = viaFollow([PRESENT_CALL, PRESENTED_EVENT])
  assertEqual(turnArtifacts(running).length, 0, '进行中不显示')
  assertEqual(turnArtifacts(running, { includeUnsettled: true }).length, 1, '显式要求时能给')

  const settled = viaFollow([PRESENT_CALL, PRESENTED_EVENT, TURN_END])
  assertEqual(turnArtifacts(settled).length, 1, '结束后显示')
})

check('D3 多轮：每轮各挂各的，顺序按时间线', () => {
  const items = viaFollow([
    PRESENT_CALL,
    PRESENTED_EVENT,
    TURN_END,
    MESSAGE(8300, 29, '第二轮'),
    {
      type: 'deliverables/presented',
      seq: 8301,
      time: 1_794_106_000_000,
      data: { turn: 29, callId: 'c-29', files: [{ path: '/ws/第二份.xlsx' }] },
    },
    { type: 'turn/end', seq: 8302, time: 1_794_106_000_100, data: { turn: 29, reason: { kind: 'completed' } } },
  ])
  const groups = turnArtifacts(items)
  assertEqual(groups.map((group) => group.turn), ['28', '29'], '两轮两张卡')
  assertTrue(groups[0]!.endIndex < groups[1]!.endIndex, '挂载点递增')
})

check('D4 没有 turn 的产物行不参与分组（不产生无主卡片）', () => {
  const orphan: ChatItem = {
    kind: 'artifact',
    id: 'presented:orphan',
    sessionId: SESSION,
    createdAt: 1,
    files: [{ path: '/ws/x.pdf' }],
    source: 'event',
  }
  assertEqual(turnArtifacts([orphan]).length, 0, '无 turn 不出卡')
})

check('D5 sessionArtifacts：新的在前，同一路径只留最新一轮的一份', () => {
  const items = viaFollow([
    PRESENT_CALL,
    PRESENTED_EVENT,
    TURN_END,
    { type: 'deliverables/presented', seq: 8400, time: 1_794_107_000_000, data: { turn: 30, callId: 'c-30', files: [{ path: '/ws/新.pdf' }, { path: APK }] } },
    { type: 'turn/end', seq: 8401, time: 1_794_107_000_100, data: { turn: 30, reason: { kind: 'completed' } } },
  ])
  const flat = sessionArtifacts(turnArtifacts(items))
  assertEqual(flat.map((file) => file.path), ['/ws/新.pdf', APK], '新的在前、路径去重')
})

/* ── E. 卡片渲染分支 ───────────────────────────────────────────────────── */

const group6 = (() => {
  const items = viaFollow([
    {
      type: 'deliverables/presented',
      seq: 8600,
      time: 1_794_108_000_000,
      data: {
        turn: 5,
        callId: 'c-5',
        files: Array.from({ length: 6 }, (_, index) => ({ path: `/ws/f${index}.pdf` })),
      },
    },
    { type: 'turn/end', seq: 8601, time: 1_794_108_000_100, data: { turn: 5, reason: { kind: 'completed' } } },
  ])
  return turnArtifacts(items)[0]!
})()

check('E1 artifactGroupAtIndex：只有挂载点那一行拿到分组，别处是 undefined', () => {
  assertTrue(artifactGroupAtIndex([group6], group6.endIndex) === group6, '挂载点命中')
  assertUndefined(artifactGroupAtIndex([group6], group6.endIndex + 1), '下一行没有')
  assertUndefined(artifactGroupAtIndex([group6], group6.endIndex - 1), '上一行没有')
  assertUndefined(artifactGroupAtIndex([], 0), '空分组没有')
})

check('E2 收起阈值 = 4（官方 COLLAPSED_PRESENTED_COUNT），展开才是全部', () => {
  assertEqual(ALL_ARTIFACT_LIMIT, 4, '阈值是 4')
  assertEqual(visibleArtifactFiles(group6.files, false).length, 4, '收起时 4 个')
  assertEqual(visibleArtifactFiles(group6.files, true).length, 6, '展开时全部')
  assertTrue(hasHiddenArtifacts(group6.files), '6 个要画「全部」那一行')
  assertEqual(hasHiddenArtifacts(group6.files.slice(0, 4)), false, '正好 4 个不画')
  assertEqual(hasHiddenArtifacts(group6.files.slice(0, 3)), false, '3 个不画')
  assertEqual(visibleArtifactFiles(group6.files.slice(0, 3), false).length, 3, '不足 4 个不截断')
})

/* ── F. 附带的纯函数（路径 / 种类 / 外链） ─────────────────────────────── */

check('F1 种类：按扩展名分到 image / pdf / spreadsheet / slides / other', () => {
  assertEqual(artifactKindOf('/a/报表.XLSX'), 'spreadsheet', 'XLSX')
  assertEqual(artifactKindOf('C:\\a\\deck.pptx'), 'slides', 'pptx（反斜杠路径）')
  assertEqual(artifactKindOf('/a/photo.png'), 'image', 'PNG')
  assertEqual(artifactKindOf('/a/报告.pdf'), 'pdf', 'PDF')
  assertEqual(artifactKindOf('/a/unknown.bin'), 'other', '未知')
  assertEqual(artifactKindOf('/a/Makefile'), 'other', '没有扩展名')
})

check('F2 toWorkspaceRelative：绝对路径去掉工作区根；不在里面 / 相对路径各自的说法', () => {
  const root = 'C:\\Users\\Administrator\\Desktop\\harness workspace'
  assertEqual(
    toWorkspaceRelative(APK, root),
    'work/2026-11-08-ekko平板app打包/result-EkkoPad-v1.0.1.apk',
    '工作区内的绝对路径',
  )
  assertEqual(toWorkspaceRelative('out/a.pdf', root), 'out/a.pdf', '相对路径原样')
  assertEqual(toWorkspaceRelative('./out/a.pdf', root), 'out/a.pdf', '去掉 ./')
  assertEqual(toWorkspaceRelative('/etc/passwd', root), null, '工作区外')
  assertEqual(toWorkspaceRelative(APK, ''), null, '不知道 root')
})

check('F3 artifactFileOf：外链走 url（不当作本地文件），说明为空串就当没有', () => {
  const external = artifactFileOf({ path: 'https://example.com/a/report.pdf' })
  assertEqual(external.url, 'https://example.com/a/report.pdf', '外链')
  assertEqual(external.name, 'report.pdf', '外链的文件名')
  assertEqual(external.kind, 'web', '外链算 web')

  const local = artifactFileOf({ path: '/ws/a.pdf', description: '   ' })
  assertUndefined(local.description, '空白说明丢掉')
  assertEqual(local.extension, 'PDF', '大写扩展名')
})

/* ── 跑 ───────────────────────────────────────────────────────────────── */
const main = (): void => {
  let failures = 0
  for (const item of checks) {
    try {
      item.run()
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

main()
