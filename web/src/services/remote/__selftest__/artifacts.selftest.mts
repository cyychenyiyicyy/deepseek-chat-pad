/**
 * 「任务完成后的交付文件」自测（R12）：`services/remote/artifacts.ts`。
 *
 * 跑法（workdir = projects\deepseek-tablet\web）：
 *   npx tsx src/services/remote/__selftest__/artifacts.selftest.mts
 *
 * 五层，全部跑真代码（不联网、不碰 DOM）：
 *   A. 路径规则：`looksLikeFilePath` / `normalizeArtifactPath`（URL、data:、目录、行号后缀）；
 *   B. 工具抽取：写 / 改 / 建 各类工具 → 产物；**读类 / 搜索类 / 终端 / 失败 / 进行中一律没有**；
 *   C. 按轮聚合：`turnArtifactGroups`（未结束的轮不出现、挂载下标、流式中不显示）；
 *   D. 会话汇总：`sessionArtifacts` 去重 + 时间倒序；
 *   E. 全部下载：`downloadArtifacts` 串行、进度、失败跳过、可中断。
 *
 * 结尾按仓库约定设置真实退出码，并且**先删旧报告**（崩在半路不留上一次的结论）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ChatItem, ChatMessage, ToolActivity } from '../adapter.js'
import {
  artifactsOfTool,
  artifactDirOf,
  artifactExtensionOf,
  artifactNameOf,
  downloadArtifacts,
  looksLikeFilePath,
  normalizeArtifactPath,
  pathsFromArgs,
  pathsFromDiffText,
  pathsFromPatchText,
  resetArtifactCaches,
  sessionArtifacts,
  toWorkspaceRelative,
  turnArtifactGroups,
} from '../artifacts.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// 目录里还有别的自测：报告名字带前缀，别互相覆盖
const REPORT = path.join(HERE, 'artifacts.report.txt')
try {
  fs.unlinkSync(REPORT)
} catch {
  /* 没有旧报告 */
}

/* ───────────────────────────── 最小断言器 ───────────────────────────── */

interface Row {
  level: 'PASS' | 'FAIL'
  name: string
  detail?: string
}

const results: Row[] = []

const expect = (condition: boolean, detail: string): void => {
  if (!condition) {
    throw new Error(detail)
  }
}

const equal = (actual: unknown, wanted: unknown, label: string): void => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(wanted)
  expect(a === b, `${label}：期望 ${b}，实际 ${a}`)
}

const check = async (name: string, run: () => void | Promise<void>): Promise<void> => {
  try {
    await run()
    results.push({ level: 'PASS', name })
  } catch (error) {
    results.push({
      level: 'FAIL',
      name,
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}

/* ───────────────────────────── 造数据 ───────────────────────────── */

let tick = 1_000

const toolRow = (over: Partial<ToolActivity> = {}): ToolActivity => {
  tick += 1_000
  return {
    kind: 'tool',
    id: over.id ?? `tool-${tick}`,
    sessionId: 'session-1',
    createdAt: tick,
    toolName: 'write',
    state: 'finished',
    ...over,
  }
}

const messageRow = (over: Partial<ChatMessage> = {}): ChatMessage => {
  tick += 1_000
  return {
    kind: 'message',
    id: over.id ?? `msg-${tick}`,
    sessionId: 'session-1',
    createdAt: tick,
    role: 'assistant',
    text: 'done',
    ...over,
  }
}

const userRow = (text = '请生成报告'): ChatMessage =>
  messageRow({ role: 'user', text, id: `user-${tick}` })

const args = (value: Record<string, unknown>): string => JSON.stringify(value)

/* ───────────────────────────── A. 路径规则 ───────────────────────────── */

await check('A1 looksLikeFilePath：URL / data: / 目录 / 空 / 多行 都不认', () => {
  expect(looksLikeFilePath('src/a.ts') === true, '相对路径应认')
  expect(looksLikeFilePath('/home/u/a.ts') === true, '绝对路径应认')
  expect(looksLikeFilePath('https://example.com/a.ts') === false, 'URL 不该认')
  expect(looksLikeFilePath('data:image/png;base64,AAAA') === false, 'data URL 不该认')
  expect(looksLikeFilePath('src/components/') === false, '目录（结尾斜杠）不该认')
  expect(looksLikeFilePath('   ') === false, '空串不该认')
  expect(looksLikeFilePath('第一行\n第二行') === false, '多行不该认')
  expect(looksLikeFilePath('...') === false, '纯标点不该认')
  expect(looksLikeFilePath('a'.repeat(401)) === false, '超长不该认')
})

await check('A2 normalizeArtifactPath：反斜杠归一、去行号、去 ./、保 UNC', () => {
  equal(normalizeArtifactPath('src\\a.ts'), 'src/a.ts', '反斜杠')
  equal(normalizeArtifactPath('src/a.ts:12'), 'src/a.ts', '行号后缀')
  equal(normalizeArtifactPath('src/a.ts:12:3'), 'src/a.ts', '行列后缀')
  equal(normalizeArtifactPath('./out/report.md'), 'out/report.md', '当前目录前缀')
  equal(normalizeArtifactPath('C:\\proj\\out.txt'), 'C:/proj/out.txt', 'Windows 绝对路径')
  equal(normalizeArtifactPath('//host/share/a.txt'), '//host/share/a.txt', 'UNC 保留开头双斜杠')
  equal(normalizeArtifactPath('C:12'), 'C:12', '盘符相对路径不按行号拆')
  equal(normalizeArtifactPath('https://x/y.ts'), undefined, 'URL')
})

await check('A3 名称 / 目录 / 扩展名 拆分', () => {
  equal(artifactNameOf('out/2026/report.pdf'), 'report.pdf', '文件名')
  equal(artifactDirOf('out/2026/report.pdf'), 'out/2026', '目录')
  equal(artifactDirOf('report.pdf'), '', '根目录')
  equal(artifactExtensionOf('out/report.PDF'), 'PDF', '大写扩展名')
  equal(artifactExtensionOf('Makefile'), '', '没有扩展名')
})

await check('A4 toWorkspaceRelative：相对原样、绝对按 root 削前缀、越界/未知 root → null', () => {
  equal(toWorkspaceRelative('src/a.ts', '/home/u/proj'), 'src/a.ts', '相对路径')
  equal(toWorkspaceRelative('/home/u/proj/src/a.ts', '/home/u/proj'), 'src/a.ts', 'Posix 绝对')
  equal(toWorkspaceRelative('C:\\proj\\web\\a.ts', 'C:\\proj\\web'), 'a.ts', 'Windows 绝对')
  equal(toWorkspaceRelative('c:/PROJ/web/a.ts', 'C:/proj/web'), 'a.ts', '盘符大小写不敏感')
  equal(toWorkspaceRelative('/other/a.ts', '/home/u/proj'), null, '工作区之外')
  equal(toWorkspaceRelative('/home/u/proj/a.ts', ''), null, '不知道 root')
  equal(toWorkspaceRelative('/home/u/proj', '/home/u/proj'), null, 'root 本身不是文件')
})

/* ───────────────────────────── B. 工具抽取 ───────────────────────────── */

await check('B1 write（file_path）→ 新建产物；名称/目录正确', () => {
  const item = toolRow({
    toolName: 'write',
    toolKey: 'write',
    arguments: args({ file_path: 'work/2026-11-21/report.md', content: '# hi' }),
  })
  const files = artifactsOfTool(item)
  equal(files.length, 1, '数量')
  equal(files[0]?.path, 'work/2026-11-21/report.md', '路径')
  equal(files[0]?.name, 'report.md', '文件名')
  equal(files[0]?.dir, 'work/2026-11-21', '目录')
  equal(files[0]?.origin, 'created', '新建')
  equal(files[0]?.source, 'args', '来源')
})

await check('B2 write（path 键，短名带前缀）→ 产物；一次写多个 files[] → 全部', () => {
  const single = toolRow({ toolKey: 'write_file', toolName: 'Write File', arguments: args({ path: 'out/a.csv' }) })
  equal(artifactsOfTool(single).map((file) => file.path), ['out/a.csv'], 'path 键')

  const many = toolRow({
    toolKey: 'write_many',
    arguments: args({ files: ['out/a.txt', 'out/b.txt', 'https://x/y.txt'] }),
  })
  equal(artifactsOfTool(many).map((file) => file.path), ['out/a.txt', 'out/b.txt'], '数组里 URL 被丢掉')
})

await check('B3 edit：参数抽不到路径时，用结果 diff 里的「文件: …」', () => {
  const item = toolRow({
    toolKey: 'edit',
    toolName: 'edit',
    // 流式截断的半截 JSON：解析不出参数
    arguments: '{"file_pa',
    resultDetail: {
      format: 'code',
      text: '文件: src/app.ts\n\n--- 修改前 ---\nold\n\n+++ 修改后 +++\nnew',
    },
  })
  const files = artifactsOfTool(item)
  equal(files.length, 1, '数量')
  equal(files[0]?.path, 'src/app.ts', '路径')
  equal(files[0]?.origin, 'modified', '修改')
  equal(files[0]?.source, 'diff', '来源')
})

await check('B4 diff 里旧文件是「(新文件)」→ 记为新建', () => {
  const item = toolRow({
    toolKey: 'write',
    arguments: args({ file_path: 'out/new.md', content: 'x' }),
    resultDetail: { format: 'code', text: '文件: out/new.md\n\n--- 修改前 ---\n(新文件)\n\n+++ 修改后 +++\nx' },
  })
  const files = artifactsOfTool(item)
  equal(files.length, 1, '同一路径只算一次（args 先到）')
  equal(files[0]?.origin, 'created', '新建')
})

await check('B5 read / read_image / grep / glob / 终端：一个产物都不给', () => {
  const read = toolRow({ toolKey: 'read', toolName: 'read', arguments: args({ file_path: 'src/a.ts' }) })
  equal(artifactsOfTool(read), [], 'read')

  const readImage = toolRow({ toolKey: 'read_image', arguments: args({ file_path: 'a.png' }) })
  equal(artifactsOfTool(readImage), [], 'read_image')

  const grep = toolRow({ toolKey: 'grep', arguments: args({ pattern: 'x', path: 'src/a.ts' }) })
  equal(artifactsOfTool(grep), [], 'grep')

  const glob = toolRow({ toolKey: 'glob', arguments: args({ path: 'src/**/*.ts' }) })
  equal(artifactsOfTool(glob), [], 'glob')

  const bash = toolRow({ toolKey: 'bash', arguments: args({ command: 'echo hi > out/a.txt' }) })
  equal(artifactsOfTool(bash), [], '终端命令里的重定向不算产物（那是猜）')
})

await check('B6 失败 / 进行中的写工具不算产物', () => {
  const failed = toolRow({ toolKey: 'write', state: 'failed', arguments: args({ file_path: 'out/a.txt' }) })
  equal(artifactsOfTool(failed), [], '失败')
  const running = toolRow({ toolKey: 'write', state: 'running', arguments: args({ file_path: 'out/a.txt' }) })
  equal(artifactsOfTool(running), [], '进行中')
})

await check('B7 str_replace_editor 按 command 分流：view 是读，create 新建，str_replace 修改', () => {
  const view = toolRow({ toolKey: 'str_replace_editor', arguments: args({ command: 'view', path: 'src/a.ts' }) })
  equal(artifactsOfTool(view), [], 'view')

  const created = toolRow({
    toolKey: 'str_replace_editor',
    arguments: args({ command: 'create', path: 'src/new.ts', file_text: 'x' }),
  })
  equal(artifactsOfTool(created)[0]?.origin, 'created', 'create')

  const edited = toolRow({
    toolKey: 'str_replace_editor',
    arguments: args({ command: 'str_replace', path: 'src/a.ts', old_str: 'a', new_str: 'b' }),
  })
  equal(artifactsOfTool(edited)[0]?.origin, 'modified', 'str_replace')
})

await check('B8 apply_patch：只认 *** Add / *** Update / *** Move to，Delete 不算', () => {
  const patch = [
    '*** Begin Patch',
    '*** Add File: out/new.md',
    '+hello',
    '*** Update File: src/app.ts',
    '@@',
    '*** Move to: src/app2.ts',
    '*** Delete File: out/old.md',
    '*** End Patch',
  ].join('\n')
  const item = toolRow({ toolKey: 'apply_patch', arguments: args({ patch }) })
  equal(artifactsOfTool(item).map((file) => file.path), ['out/new.md', 'src/app.ts', 'src/app2.ts'], '路径')
})

await check('B9 名字里没有写动词的 MCP 工具 / 建目录 / 删除 → 不算', () => {
  const unknown = toolRow({ toolKey: 'mcp__github__search', arguments: args({ path: 'src/a.ts' }) })
  equal(artifactsOfTool(unknown), [], '未知 MCP 搜索工具')

  const writeLike = toolRow({ toolKey: 'mcp__fs__write_file', arguments: args({ path: 'out/a.txt' }) })
  equal(artifactsOfTool(writeLike).map((file) => file.path), ['out/a.txt'], '名字里带 write 的 MCP 工具')

  const mkdir = toolRow({ toolKey: 'create_directory', arguments: args({ path: 'src/components' }) })
  equal(artifactsOfTool(mkdir), [], '建目录')

  const del = toolRow({ toolKey: 'delete_file', arguments: args({ path: 'src/a.ts' }) })
  equal(artifactsOfTool(del), [], '删文件')
})

await check('B10 只给中文展示标题（没有 toolKey）时，仍按标题动词认', () => {
  const item = toolRow({ toolName: '写文件', toolKey: undefined, arguments: args({ file_path: 'out/日报.md' }) })
  equal(artifactsOfTool(item).map((file) => file.path), ['out/日报.md'], '中文标题')
})

await check('B11 子函数自证：pathsFromArgs / pathsFromDiffText / pathsFromPatchText', () => {
  equal(pathsFromArgs(undefined), [], '无参数')
  equal(pathsFromArgs({ file_path: 'a', path: 'b' }), ['a', 'b'], '两个键都在就直接两条（去重交给上层）')
  equal(pathsFromDiffText(undefined), [], '无 diff')
  equal(pathsFromDiffText('文件: a.ts\n\n--- 修改前 ---\n(新文件)\n\n+++ 修改后 +++\nx'), [{ path: 'a.ts', created: true }], 'diff 新建')
  equal(pathsFromPatchText('*** Delete File: a\n*** Add File: b'), ['b'], 'patch')
})

/* ───────────────────────────── C. 按轮聚合 ───────────────────────────── */

const writeItem = (id: string, file: string, turn?: string): ToolActivity =>
  toolRow({
    id,
    toolKey: 'write',
    turn,
    arguments: args({ file_path: file, content: 'x' }),
  })

await check('C1 两轮对话：只有已结束、且有产物的轮才有面板；endIndex 指向该轮最后一行', () => {
  resetArtifactCaches()
  const items: ChatItem[] = [
    userRow(),
    writeItem('t1', 'out/a.md', 'turn-1'),
    messageRow({ id: 'm1', turn: 'turn-1' }),
    userRow('再来一个'),
    writeItem('t2', 'out/b.md', 'turn-2'),
    messageRow({ id: 'm2', turn: 'turn-2', streaming: true }),
  ]
  const groups = turnArtifactGroups(items, { streaming: true })
  equal(groups.length, 1, '流式中只有第一轮（已经翻篇）算结束')
  equal(groups[0]?.endIndex, 2, '第一轮最后一行是 m1')
  equal(groups[0]?.files.map((file) => file.path), ['out/a.md'], '第一轮产物')
})

await check('C2 最后一轮：流式结束（streaming=false）后出现；turnEnd 一到即使 streaming 也能出现', () => {
  resetArtifactCaches()
  const base: ChatItem[] = [
    userRow(),
    writeItem('t1', 'out/a.md', 'turn-1'),
    messageRow({ id: 'm1', turn: 'turn-1', streaming: true }),
  ]
  equal(turnArtifactGroups(base, { streaming: true }).length, 0, '流式中不显示最后一轮')
  equal(turnArtifactGroups(base, { streaming: false }).length, 1, '不流式即视为落定')

  resetArtifactCaches()
  const ended: ChatItem[] = [
    userRow(),
    writeItem('t1', 'out/a.md', 'turn-1'),
    messageRow({
      id: 'm1',
      turn: 'turn-1',
      turnEnd: { reason: 'completed', time: 1 },
      streaming: true,
    }),
  ]
  equal(turnArtifactGroups(ended, { streaming: true }).length, 1, 'turn/end 是权威证据')
})

await check('C3 没有 turn 字段的历史数据：按用户消息切轮，且同一轮同名路径只算一次', () => {
  resetArtifactCaches()
  const items: ChatItem[] = [
    userRow(),
    writeItem('t1', 'out/a.md'),
    writeItem('t2', 'out/a.md'),
    messageRow({ id: 'm1' }),
    userRow('第二轮'),
    writeItem('t3', 'out/b.md'),
    messageRow({ id: 'm2' }),
  ]
  const groups = turnArtifactGroups(items, { streaming: false })
  equal(groups.length, 2, '两轮')
  equal(groups[0]?.files.length, 1, '同一轮重复路径去重')
  equal(groups[0]?.files[0]?.path, 'out/a.md', '第一轮路径')
  equal(groups[1]?.files[0]?.path, 'out/b.md', '第二轮路径')
})

await check('C4 一轮里有工具还在跑（turnEnd 没到）→ 不显示', () => {
  resetArtifactCaches()
  const items: ChatItem[] = [
    userRow(),
    writeItem('t1', 'out/a.md'),
    toolRow({ id: 'running', toolKey: 'bash', state: 'running' }),
  ]
  equal(turnArtifactGroups(items, { streaming: false }).length, 0, '有 running 工具不算落定')
})

await check('C5 已结束但没有产物的轮：不产生空面板', () => {
  resetArtifactCaches()
  const items: ChatItem[] = [userRow(), messageRow({ id: 'm1' })]
  equal(turnArtifactGroups(items, { streaming: false }), [], '空')
})

/* ───────────────────────────── D. 会话汇总 ───────────────────────────── */

await check('D1 会话汇总：跨轮去重（保留最新）、按时间倒序', () => {
  resetArtifactCaches()
  const first = writeItem('t1', 'out/a.md')
  const second = writeItem('t2', 'out/b.md')
  const third = toolRow({
    id: 't3',
    toolKey: 'edit',
    arguments: args({ file_path: 'out/a.md' }),
    resultDetail: { format: 'code', text: '文件: out/a.md\n\n--- 修改前 ---\nx\n\n+++ 修改后 +++\ny' },
  })
  const items: ChatItem[] = [
    userRow(),
    first,
    messageRow({ id: 'm1' }),
    userRow('第二轮'),
    second,
    third,
    messageRow({ id: 'm2' }),
  ]
  const files = sessionArtifacts(items, { streaming: false })
  equal(files.map((file) => file.path), ['out/a.md', 'out/b.md'], 'a.md 在第二轮被改过 ⇒ 最新，排最前')
  equal(files[0]?.at, third.createdAt, '时间取最近一次')
  equal(files[0]?.origin, 'modified', '最近一次是修改')
})

await check('D2 会话汇总只算已结束的轮（流式中的那一轮不进来）', () => {
  resetArtifactCaches()
  const items: ChatItem[] = [userRow(), writeItem('t1', 'out/a.md'), messageRow({ id: 'm1', streaming: true })]
  equal(sessionArtifacts(items, { streaming: true }), [], '流式中')
  resetArtifactCaches()
  equal(sessionArtifacts(items, { streaming: false }).length, 1, '落定后')
})

/* ───────────────────────────── E. 全部下载 ───────────────────────────── */

await check('E1 全部下载：严格串行、每次先报进度、失败跳过继续', async () => {
  const files = ['a.txt', 'b.txt', 'c.txt'].map((name, index) => ({
    path: `out/${name}`,
    name,
    dir: 'out',
    origin: 'created' as const,
    source: 'args' as const,
    toolKey: 'write',
    itemId: `t${index}`,
    at: index,
  }))
  const order: string[] = []
  const progress: number[] = []
  const inFlight: string[] = []
  let maxInFlight = 0
  const summary = await downloadArtifacts(files, {
    download: async (file) => {
      inFlight.push(file.path)
      maxInFlight = Math.max(maxInFlight, inFlight.length)
      order.push(file.path)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight.pop()
      if (file.name === 'b.txt') {
        throw new Error('boom')
      }
      return undefined
    },
    onProgress: (state) => progress.push(state.index),
  })
  equal(order, ['out/a.txt', 'out/b.txt', 'out/c.txt'], '顺序')
  equal(maxInFlight, 1, '串行（同一时刻最多一个在飞）')
  equal(progress, [0, 1, 2], '每个文件开始前报一次进度')
  equal(summary.saved.map((file) => file.name), ['a.txt', 'c.txt'], '失败被跳过，其余照存')
  equal(summary.failed.map((row) => row.file.name), ['b.txt'], '失败清单')
})

await check('E2 全部下载：shouldStop 之后不再发新请求', async () => {
  const files = ['a.txt', 'b.txt', 'c.txt'].map((name, index) => ({
    path: name,
    name,
    dir: '',
    origin: 'created' as const,
    source: 'args' as const,
    toolKey: 'write',
    itemId: `t${index}`,
    at: index,
  }))
  let calls = 0
  const summary = await downloadArtifacts(files, {
    download: () => {
      calls += 1
      return Promise.resolve()
    },
    shouldStop: () => calls >= 1,
  })
  equal(calls, 1, '只取了第一个')
  equal(summary.saved.length, 1, '已存的照实返回')
})

await check('E3 空列表：不报错、不信口开河', async () => {
  const summary = await downloadArtifacts([], { download: () => Promise.resolve() })
  equal(summary.saved, [], '空')
  equal(summary.failed, [], '空')
})

/* ───────────────────────────── 汇总 ───────────────────────────── */

const failures = results.filter((row) => row.level === 'FAIL')
const lines = results.map((row) =>
  row.level === 'PASS' ? `[PASS] ${row.name}` : `[FAIL] ${row.name} — ${row.detail ?? ''}`,
)
lines.push('', `总计 ${results.length} 项，${results.length - failures.length} PASS / ${failures.length} FAIL`)
const report = `${lines.join('\n')}\n`
fs.writeFileSync(REPORT, report, 'utf8')
process.stdout.write(report)
process.exit(failures.length === 0 ? 0 : 1)
