/**
 * 把数据层已经格式化好的工具结果**再翻译成结构化的块**，供卡片按类型渲染。
 *
 * 上游数据形状（`services/remote/adapter.ts`，只读、不动）：
 *   `ToolActivity.callDetail`   `{ text, format: 'code' | 'markdown' }`
 *   `ToolActivity.resultDetail` 同上；terminal 结果是 `输出…\nexit: 0`，read 结果是
 *                               `path · 共 N 行\n12 | 内容`，diff 结果是
 *                               `文件: p\n\n--- 修改前 ---\n…\n\n+++ 修改后 +++\n…`，
 *                               search 是 `path\n12: 行内容` 或每行一个路径，
 *                               web 是 `HTTP 200\nurl` 或 `答案\n\n标题\nurl\n摘要`。
 *
 * 这些字符串是**给人看的文本**，不是 JSON。所以这里用形状解析（而不是回头去读原始事件，
 * 那会等于重写数据层）。解析失败一律返回 undefined，由调用方退回纯文本显示 —— 绝不猜。
 */

export interface DiffLine {
  kind: 'add' | 'del' | 'same'
  text: string
}

export interface DiffBlock {
  path: string
  /** 旧文件不存在（adapter 写 `(新文件)`） */
  created: boolean
  lines: DiffLine[]
  added: number
  removed: number
}

export interface ReadWindow {
  path?: string
  totalLines?: string
  firstLine: number
  lines: { number: number; text: string }[]
}

export interface SearchGroup {
  path: string
  hits: { line?: number; text: string }[]
}

export interface WebSource {
  title?: string
  url: string
  snippet?: string
}

export interface WebResult {
  /** `fetch` = 一次抓取（状态码 + URL）；`search` = 查询（答案 + 来源） */
  shape: 'fetch' | 'search'
  status?: string
  url?: string
  answer?: string
  sources: WebSource[]
}

export interface TerminalInfo {
  cwd?: string
  command?: string
  output: string
  exit?: string
  signal?: string
}

const FETCH_STATUS = /^HTTP \d{3}$/u
const HIT_LINE = /^(\d+): ?(.*)$/u
const EXIT_LINE = /^exit: (-?\d+)$/u
const SIGNAL_LINE = /^signal: (.+)$/u
const TOTAL_LINES = /共 (\d+) 行/u

const isBlank = (line: string): boolean => line.trim().length === 0

const dropTrailingBlank = (lines: string[]): string[] => {
  const copy = [...lines]
  while (copy.length > 0 && isBlank(copy[copy.length - 1] as string)) copy.pop()
  return copy
}

/* ────────────────────────────── terminal ────────────────────────────── */

/**
 * 命令行在 `callDetail`（adapter 写 `cwd: …` + `$ 命令`），输出与退出码在 `resultDetail`。
 * 退出码/signal 是 adapter 追加在**末尾**的两行，所以从尾部摘，剩下的才是真正输出。
 */
export const parseTerminal = (
  callText: string | undefined,
  resultText: string | undefined
): TerminalInfo | undefined => {
  if (callText === undefined && resultText === undefined) return undefined
  const info: TerminalInfo = { output: '' }
  for (const line of callText?.split('\n') ?? []) {
    if (line.startsWith('cwd: ')) info.cwd = line.slice(5).trim()
    else if (line.startsWith('$ ')) info.command = line.slice(2)
  }
  const lines = resultText === undefined ? [] : resultText.split('\n')
  while (lines.length > 0) {
    const last = lines[lines.length - 1] as string
    const exit = EXIT_LINE.exec(last)
    if (exit !== null) {
      info.exit = exit[1]
      lines.pop()
      continue
    }
    const signal = SIGNAL_LINE.exec(last)
    if (signal !== null) {
      info.signal = signal[1]
      lines.pop()
      continue
    }
    break
  }
  info.output = lines.join('\n')
  return info
}

/* ────────────────────────────── diff ────────────────────────────── */

/**
 * 行级 diff。真正的 LCS 动态规划，只用在**单块**上且两边都 ≤ 400 行；
 * 超过就退化成「先全删、后全加」（仍能看出改了什么，不卡界面）。
 */
export const computeLineDiff = (before: string, after: string): DiffLine[] => {
  const oldLines = before.length === 0 ? [] : before.split('\n')
  const newLines = after.length === 0 ? [] : after.split('\n')
  const rows = oldLines.length
  const cols = newLines.length
  if (rows === 0) return newLines.map((text) => ({ kind: 'add' as const, text }))
  if (cols === 0) return oldLines.map((text) => ({ kind: 'del' as const, text }))
  if (rows > 400 || cols > 400) {
    return [
      ...oldLines.map((text) => ({ kind: 'del' as const, text })),
      ...newLines.map((text) => ({ kind: 'add' as const, text })),
    ]
  }
  // 经典 LCS 长度表（(rows+1) × (cols+1)），倒推产出同序的 diff。
  const width = cols + 1
  const table = new Uint16Array((rows + 1) * width)
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        oldLines[i] === newLines[j]
          ? (table[(i + 1) * width + j + 1] as number) + 1
          : Math.max(table[(i + 1) * width + j] as number, table[i * width + j + 1] as number)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < rows && j < cols) {
    if (oldLines[i] === newLines[j]) {
      out.push({ kind: 'same', text: oldLines[i] as string })
      i += 1
      j += 1
    } else if ((table[(i + 1) * width + j] as number) >= (table[i * width + j + 1] as number)) {
      out.push({ kind: 'del', text: oldLines[i] as string })
      i += 1
    } else {
      out.push({ kind: 'add', text: newLines[j] as string })
      j += 1
    }
  }
  while (i < rows) {
    out.push({ kind: 'del', text: oldLines[i] as string })
    i += 1
  }
  while (j < cols) {
    out.push({ kind: 'add', text: newLines[j] as string })
    j += 1
  }
  return out
}

/**
 * 解析 adapter 的 `formatDiffs()` 输出。
 *
 * ```
 * 文件: src/a.ts
 *
 * --- 修改前 ---
 * 旧内容
 *
 * +++ 修改后 +++
 * 新内容
 * ```
 * 多文件时块与块之间也是空行；`oldText === null` 时 adapter 写 `(新文件)`。
 */
export const parseDiffs = (text: string | undefined): DiffBlock[] | undefined => {
  if (text === undefined || !text.includes('--- 修改前 ---')) return undefined
  const blocks: DiffBlock[] = []
  let path = ''
  let created = false
  let oldLines: string[] = []
  let newLines: string[] = []
  let mode: 'idle' | 'old' | 'new' = 'idle'
  const flush = (): void => {
    if (path.length === 0) return
    const lines = computeLineDiff(
      created ? '' : dropTrailingBlank(oldLines).join('\n'),
      dropTrailingBlank(newLines).join('\n')
    )
    blocks.push({
      path,
      created,
      lines,
      added: lines.filter((line) => line.kind === 'add').length,
      removed: lines.filter((line) => line.kind === 'del').length,
    })
    path = ''
    created = false
    oldLines = []
    newLines = []
    mode = 'idle'
  }
  for (const line of text.split('\n')) {
    if (line.startsWith('文件: ')) {
      flush()
      path = line.slice(4).trim()
      continue
    }
    if (line.trim() === '--- 修改前 ---') {
      mode = 'old'
      continue
    }
    if (line.trim() === '+++ 修改后 +++') {
      mode = 'new'
      continue
    }
    if (mode === 'old') {
      if (line === '(新文件)') created = true
      else oldLines.push(line)
    } else if (mode === 'new') {
      newLines.push(line)
    }
  }
  flush()
  return blocks.length === 0 ? undefined : blocks
}

/* ────────────────────────────── read ────────────────────────────── */

/** read 结果：`path · 共 N 行` + `12 | 内容` 行。 */
export const parseRead = (text: string | undefined): ReadWindow | undefined => {
  if (text === undefined) return undefined
  const lines = text.split('\n')
  const window: ReadWindow = { firstLine: 0, lines: [] }
  let index = 0
  const head = lines[0]
  // 表头是「路径 · 共 N 行」或只有其中一项；正文每行都以 `行号 | ` 开头。
  if (head !== undefined && !/^\d+ \| /u.test(head)) {
    const dot = head.lastIndexOf(' · ')
    const path = (dot === -1 ? head : head.slice(0, dot)).trim()
    if (path.length > 0) window.path = path
    const total = TOTAL_LINES.exec(head)?.[1]
    if (total !== undefined) window.totalLines = total
    index = 1
  }
  for (; index < lines.length; index += 1) {
    const line = lines[index] as string
    const match = /^(\d+) \| ?(.*)$/u.exec(line)
    if (match === null) continue
    const number = Number(match[1])
    if (window.lines.length === 0) window.firstLine = number
    window.lines.push({ number, text: match[2] ?? '' })
  }
  return window.lines.length === 0 ? undefined : window
}

/* ────────────────────────────── search ────────────────────────────── */

/** 搜索命中：`path` 分组，下面 `12: 行内容`；`shape: 'paths'` 时只有路径没有命中行。 */
export const parseSearch = (text: string | undefined): SearchGroup[] | undefined => {
  if (text === undefined) return undefined
  const groups: SearchGroup[] = []
  for (const raw of text.split('\n')) {
    if (isBlank(raw)) continue
    const hit = HIT_LINE.exec(raw)
    if (hit !== null && groups.length > 0) {
      ;(groups[groups.length - 1] as SearchGroup).hits.push({ line: Number(hit[1]), text: hit[2] ?? '' })
      continue
    }
    // 不以 `行号: ` 开头 = 新的文件分组（`shape: 'paths'` 时每一行都是一个路径）。
    groups.push({ path: raw.trim(), hits: [] })
  }
  return groups.length === 0 ? undefined : groups
}

/* ────────────────────────────── web ────────────────────────────── */

const looksLikeSource = (lines: string[]): boolean =>
  lines.length > 0 && lines.length <= 3 && lines.some((line) => /^https?:\/\//u.test(line.trim()))

/** 联网结果：`fetch` 是状态码 + URL；`search` 是答案 + `标题/URL/摘要` 块。 */
export const parseWeb = (text: string | undefined): WebResult | undefined => {
  if (text === undefined) return undefined
  const chunks = text.split('\n\n')
  const first = chunks[0]?.split('\n') ?? []
  if (chunks.length === 1 && first.length >= 1 && FETCH_STATUS.test((first[0] ?? '').trim())) {
    return { shape: 'fetch', status: (first[0] ?? '').trim(), url: first.slice(1).join('\n').trim(), sources: [] }
  }
  const sourceChunks: string[][] = []
  while (chunks.length > 1) {
    const last = (chunks[chunks.length - 1] as string).split('\n')
    if (!looksLikeSource(last)) break
    sourceChunks.unshift(last)
    chunks.pop()
  }
  const answer = chunks.join('\n\n').trim()
  const sources: WebSource[] = []
  for (const chunk of sourceChunks) {
    const urlIndex = chunk.findIndex((line) => /^https?:\/\//u.test(line.trim()))
    if (urlIndex === -1) continue
    const title = chunk.slice(0, urlIndex).join(' ').trim()
    const snippet = chunk.slice(urlIndex + 1).join(' ').trim()
    sources.push({
      ...(title.length === 0 ? {} : { title }),
      url: (chunk[urlIndex] as string).trim(),
      ...(snippet.length === 0 ? {} : { snippet }),
    })
  }
  return {
    shape: 'search',
    ...(answer.length === 0 ? {} : { answer }),
    sources,
  }
}

/* ────────────────────────────── 参数表 ────────────────────────────── */

export interface ArgRow {
  key: string
  value: string
  /** 值很长（多行 / 大 JSON）：卡片里默认折行收窄 */
  long: boolean
}

const MAX_ARG_CHARS = 200

const displayValue = (value: unknown): string | undefined => {
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value) && value.every((item) => typeof item === 'string' || typeof item === 'number')) {
    return value.join(', ')
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return undefined
  }
}

/**
 * 参数键值表。**不直接倒 JSON 字符串**：一个键一行，值按类型展开，
 * 数组拼成逗号列表，对象/嵌套结构才退回缩进 JSON（并标记为长值）。
 */
export const argumentRows = (
  args: Record<string, unknown> | undefined,
  skip: readonly string[]
): ArgRow[] => {
  if (args === undefined) return []
  const rows: ArgRow[] = []
  for (const [key, value] of Object.entries(args)) {
    if (skip.includes(key)) continue
    const text = displayValue(value)
    if (text === undefined) continue
    const trimmed = text.trim()
    if (trimmed.length === 0) continue
    rows.push({
      key,
      value: trimmed.length > MAX_ARG_CHARS ? `${trimmed.slice(0, MAX_ARG_CHARS)}…` : trimmed,
      long: trimmed.includes('\n') || trimmed.length > 60,
    })
  }
  return rows
}
