/**
 * 工具卡片的**纯展示逻辑**：工具名 → 视觉类别 → 图标 / 动词 / 一行摘要。
 *
 * 数据层（`services/remote/adapter.ts`）已经把远端事件归约成 `ToolActivity`：
 * `toolName` / `toolKey` / `summary` / `arguments` / `callDetail` / `resultDetail` / `images`。
 * 这里**不重算**任何归约结果，只做“怎么读给人看”的翻译，所以整个文件是纯函数、可单测。
 *
 * 分类依据（不是自己编的）：
 *   - `ds-harness-remote` 的 `screens/chat-process.ts → toolActivity()`（官方
 *     `ui-chat/process-activity.ts` 的类别表）；
 *   - dsh-Go 的 `ui/common/tool_glyph.dart → ToolGlyphs.toneFor()/iconFor()/labelFor()`
 *     （工具名 → 类别、图标、默认动词三张表）。
 * 两边一致的部分直接照搬；上游没有的（例如「联网」单独成一类）按我们的数据面补。
 */

/** 工具的视觉类别。决定图标、配色和摘要规则。 */
export type ToolKind =
  | 'shell'
  | 'read'
  | 'readImage'
  | 'write'
  | 'edit'
  | 'search'
  | 'web'
  | 'task'
  | 'agent'
  | 'other'

/** 名称里可能带前缀（`mcp__github__search`、`dsh-tool-bash`），只取最后一段比较。 */
const shortName = (name: string): string => {
  const lowered = name.toLowerCase()
  const tail = lowered.split(/[./]/u).at(-1)
  return tail === undefined || tail.length === 0 ? lowered : tail
}

const SHELL = new Set(['bash', 'pwsh', 'exec_command', 'run_command', 'write_stdin', 'shell', 'terminal'])
const READ = new Set(['read', 'view_file', 'read_file', 'open_file'])
const WRITE = new Set(['write', 'write_file', 'create_file'])
const EDIT = new Set(['edit', 'edit_file', 'apply_patch', 'patch', 'str_replace_editor', 'multiedit'])
const SEARCH = new Set(['grep', 'glob', 'search', 'find_files', 'list_files'])
const WEB = new Set(['web_search', 'web_fetch', 'webfetch', 'fetch'])
const JOB = new Set(['job_output', 'job_list', 'job_kill'])
const TASK = new Set(['todo_write', 'create_goal', 'get_goal', 'update_goal', 'ask_user_question', 'request_user_input'])
const AGENT = new Set([
  'subagent',
  'subagent_fork',
  'send_message',
  'interrupt_agent',
  'list_agents',
  'list_subagent_models',
  'workflow',
  'ralph',
  'skill',
])

/**
 * `ToolActivity.toolKey ?? toolName` → 类别。
 *
 * `str_replace_editor` 是唯一一个**按参数**分流的：`view` 是读、`create` 是写、
 * 其余是编辑（与上游 `toolActivity()` 同一套规则）。
 */
export const toolKindOf = (name: string, args: Record<string, unknown> | undefined): ToolKind => {
  const key = shortName(name)
  if (key === 'str_replace_editor') {
    const command = args?.['command']
    if (command === 'view') return 'read'
    if (command === 'create') return 'write'
    return 'edit'
  }
  if (key === 'read_image' || key === 'view_image') return 'readImage'
  if (SHELL.has(key) || key.startsWith('terminal_')) return 'shell'
  if (JOB.has(key)) return 'shell'
  if (READ.has(key)) return 'read'
  if (WRITE.has(key)) return 'write'
  if (EDIT.has(key)) return 'edit'
  if (SEARCH.has(key) || key.endsWith('_inspect')) return 'search'
  if (WEB.has(key)) return 'web'
  if (TASK.has(key)) return 'task'
  if (AGENT.has(key) || key.startsWith('subagent_')) return 'agent'
  // 没有 toolKey 的历史数据只剩展示标题（Host 给的中文名），按文字兜底。
  if (/命令|终端|shell|bash|pwsh/iu.test(name)) return 'shell'
  if (/读|read/iu.test(name)) return 'read'
  if (/写|write/iu.test(name)) return 'write'
  if (/编辑|edit|patch/iu.test(name)) return 'edit'
  if (/搜索|检索|查找|grep|glob|search/iu.test(name)) return 'search'
  if (/联网|网页|web|http/iu.test(name)) return 'web'
  if (/任务|待办|todo|goal/iu.test(name)) return 'task'
  if (/子代理|subagent|代理/iu.test(name)) return 'agent'
  return 'other'
}

/** 参数是不是“代码型”的（命令行、路径、模式串）：摘要用等宽字体。 */
export const isCodeSummary = (kind: ToolKind): boolean =>
  kind === 'shell' || kind === 'read' || kind === 'readImage' || kind === 'write' || kind === 'edit' || kind === 'search'

/** 解析 `ToolActivity.arguments`；流式未完成时是半截 JSON，返回 undefined。 */
export const parseArguments = (text: string | undefined): Record<string, unknown> | undefined => {
  if (text === undefined) return undefined
  const trimmed = text.trim()
  if (trimmed.length === 0 || trimmed[0] !== '{') return undefined
  try {
    const value: unknown = JSON.parse(trimmed)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** 参数里第一个非空字符串（`file_path` → `path` → …）。 */
export const pickString = (
  args: Record<string, unknown> | undefined,
  keys: readonly string[]
): string | undefined => {
  if (args === undefined) return undefined
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return undefined
}

/** 单行化：折行交给 CSS，这里只把连续空白压成空格。 */
export const oneLine = (text: string): string => text.replace(/\s+/gu, ' ').trim()

/** 路径只留最后两段（`src/app/App.tsx`），工作区前缀太长会把摘要挤没。 */
export const shortPath = (path: string): string => {
  const parts = path.split(/[\\/]/u).filter((part) => part.length > 0)
  if (parts.length <= 2) return parts.join('/')
  return parts.slice(-2).join('/')
}

/**
 * 摘要的角色：`verb` 是本地化动词（读取 / 运行 / 搜索），`detail` 是这次调用的要点
 * （`README.md`、`npm test`、`"vite"`），`extra` 是结果侧的补充（`退出码 0`、`12 条`）。
 * 三者分开，卡片才能分别用不同字号/字体（等宽只给 detail）。
 */
export interface ToolSummary {
  verb: string
  detail?: string
  extra?: string
}

/** 结果文本里最后一条 `exit: N`（adapter 的 terminal 结果格式）。 */
const EXIT_CODE = /^exit: (-?\d+)$/mu

export const exitCodeOf = (text: string | undefined): string | undefined =>
  text === undefined ? undefined : EXIT_CODE.exec(text)?.[1]

/**
 * 一行摘要。`t` 传进来而不是在模块里读全局，方便以后加语言时补词条。
 *
 * 规则按 dsh-Go `ToolView._summary()` + 上游 `processDetail()` 的次序：
 * 先按工具名取“该工具最像命令/路径/模式的那个参数”，再退到任何非空字符串参数。
 */
export const summarizeTool = (
  input: {
    kind: ToolKind
    args: Record<string, unknown> | undefined
    /** 数据层给的摘要（Host 的 description / cwd）；参数解析不出来时才用 */
    summary: string | undefined
    /** 结果文本（`resultDetail.text`），用来补「退出码 / 条数 / 行数」 */
    result: string | undefined
    /** Host 给的展示标题；与官方工具名不同才当作动词用 */
    hostTitle: string | undefined
    toolKey: string | undefined
    /** edit / write 的行级增删统计（调用方已经算过 diff，别在这里重算） */
    diffStats?: { added: number; removed: number }
  },
  verb: (kind: ToolKind) => string,
  words: {
    itemCount: (count: number) => string
    exitCode: (code: string) => string
    lineCount: (count: number) => string
  }
): ToolSummary => {
  const { kind, args, summary, result } = input
  const path = pickString(args, ['file_path', 'path', 'file', 'target'])
  switch (kind) {
    case 'shell': {
      const command = pickString(args, ['command', 'cmd', 'script'])
      const exit = exitCodeOf(result)
      return {
        verb: verb(kind),
        ...(command === undefined ? summary === undefined ? {} : { detail: oneLine(summary) } : { detail: oneLine(command) }),
        ...(exit === undefined ? {} : { extra: words.exitCode(exit) }),
      }
    }
    case 'read':
    case 'readImage': {
      const target = path === undefined ? undefined : shortPath(path)
      const lines = readLineCount(result)
      return {
        verb: verb(kind),
        ...(target === undefined ? summary === undefined ? {} : { detail: oneLine(summary) } : { detail: target }),
        ...(lines === undefined ? {} : { extra: words.lineCount(Number(lines)) }),
      }
    }
    case 'write':
    case 'edit': {
      const target = path === undefined ? undefined : shortPath(path)
      const stats = input.diffStats
      const extra =
        stats === undefined || (stats.added === 0 && stats.removed === 0)
          ? undefined
          : `+${stats.added} −${stats.removed}`
      return {
        verb: verb(kind),
        ...(target === undefined ? summary === undefined ? {} : { detail: oneLine(summary) } : { detail: target }),
        ...(extra === undefined ? {} : { extra }),
      }
    }
    case 'search': {
      const pattern = pickString(args, ['pattern', 'query', 'regex'])
      const where = path === undefined ? undefined : shortPath(path)
      const count = countSearchHits(result)
      const detail = pattern === undefined ? where : `"${pattern}"`
      return {
        verb: verb(kind),
        ...(detail === undefined ? {} : { detail }),
        ...(count === undefined ? {} : { extra: words.itemCount(count) }),
      }
    }
    case 'web': {
      const query = pickString(args, ['query', 'q'])
      const url = pickString(args, ['url', 'uri'])
      const detail = query ?? (url === undefined ? undefined : url.replace(/^https?:\/\//iu, ''))
      const count = query === undefined ? undefined : countWebSources(result)
      return {
        verb: verb(kind),
        ...(detail === undefined ? summary === undefined ? {} : { detail: oneLine(summary) } : { detail: oneLine(detail) }),
        ...(count === undefined ? {} : { extra: words.itemCount(count) }),
      }
    }
    case 'task': {
      const todos = args?.['todos']
      if (Array.isArray(todos)) {
        const done = todos.filter(
          (todo) => typeof todo === 'object' && todo !== null && (todo as { status?: unknown }).status === 'completed'
        ).length
        const active = todos.find(
          (todo) => typeof todo === 'object' && todo !== null && (todo as { status?: unknown }).status === 'in_progress'
        ) as { content?: unknown } | undefined
        const detail = typeof active?.content === 'string' ? oneLine(active.content) : undefined
        return { verb: verb(kind), detail: `${done}/${todos.length}${detail === undefined ? '' : ` · ${detail}`}` }
      }
      const goal = pickString(args, ['objective', 'title', 'question', 'description', 'name'])
      return { verb: verb(kind), ...(goal === undefined ? {} : { detail: oneLine(goal) }) }
    }
    case 'agent': {
      const detail = pickString(args, ['description', 'prompt', 'name', 'skill', 'message'])
      return { verb: verb(kind), ...(detail === undefined ? {} : { detail: oneLine(detail) }) }
    }
    default: {
      // 其他（MCP 等）：Host 给了非通用的展示标题就直接当名字，摘要仍取最像“在做什么”的参数。
      const detail = pickString(args, [
        'title',
        'description',
        'name',
        'query',
        'path',
        'url',
        'prompt',
        'action',
        'status',
      ])
      const fallback = summary === undefined ? undefined : oneLine(summary)
      return {
        verb: hostVerb(input.hostTitle, input.toolKey) ?? verb(kind),
        ...(detail === undefined
          ? fallback === undefined
            ? {}
            : { detail: fallback }
          : { detail: oneLine(detail) }),
      }
    }
  }
}

/** Host 给的展示标题（`toolName !== toolKey`）比本地动词更具体时用它。 */
const hostVerb = (hostTitle: string | undefined, toolKey: string | undefined): string | undefined => {
  if (hostTitle === undefined || hostTitle.length === 0 || hostTitle === 'Tool') return undefined
  if (toolKey !== undefined && hostTitle === toolKey) return undefined
  return oneLine(hostTitle)
}

/** read 结果头：`src/a.ts · 共 120 行`。 */
const readLineCount = (text: string | undefined): string | undefined => {
  if (text === undefined) return undefined
  return /共 (\d+) 行/u.exec(text)?.[1]
}

/**
 * 搜索命中的“条数”。
 *
 * 我们手上只有 adapter 格式化后的纯文本（`path\n12: line` 或每行一个路径），
 * 所以按形状数：带行号的匹配行数 > 非空行数。数不出来就返回 undefined，
 * 卡片不显示“· N 条”，不编数字。
 */
export const countSearchHits = (text: string | undefined): number | undefined => {
  if (text === undefined) return undefined
  let matched = 0
  let paths = 0
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    if (/^\d+: /u.test(line)) matched += 1
    else paths += 1
  }
  if (matched > 0) return matched
  // `shape: 'paths'`：每行一个路径，第一行也是路径（没有表头）。
  return paths > 0 ? paths : undefined
}

/** web_search 的来源条数：一行的开头是 URL 就算一条来源。 */
export const countWebSources = (text: string | undefined): number | undefined => {
  if (text === undefined) return undefined
  let count = 0
  for (const line of text.split('\n')) {
    if (/^https?:\/\//u.test(line.trim())) count += 1
  }
  return count > 0 ? count : undefined
}

/**
 * 文件扩展名 → 语法高亮语言名（交给 `components/markdown/CodeBlock` 的 `infostring`）。
 * 只覆盖常见的十几种；认不出来给 `plaintext`，CodeBlock 本来就对未知语言降级成纯文本。
 */
const LANGUAGES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  md: 'markdown',
  css: 'css',
  html: 'markup',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  sql: 'sql',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sh: 'bash',
  ps1: 'powershell',
  dart: 'dart',
  xml: 'markup',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
}

export const languageForPath = (path: string | undefined): string => {
  if (path === undefined) return 'plaintext'
  const ext = path.split('.').pop()?.toLowerCase()
  return ext === undefined ? 'plaintext' : (LANGUAGES[ext] ?? 'plaintext')
}
