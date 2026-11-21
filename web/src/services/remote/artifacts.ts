/**
 * 交付文件（artifacts）：**从工具调用里读产物**，再按「一轮 / 整个会话」聚合。
 *
 * ## 为什么是「读」而不是「收」
 *
 * 远端协议里没有「产物」这个字段（`docs/protocol.md` §18 的 `session/follow` 只有
 * `tool/call` / `tool/result` 这类事件）。所以这一层**不新建数据面**，只把数据层
 * （`services/remote/adapter.ts`，只读）已经归约好的 `ToolActivity` 再读一遍：
 * 工具名 → 是不是写类；参数 / diff 文本 → 写到哪个文件。
 *
 * 依据（两边一致的部分直接照搬，不自己编）：
 *   - `tool/**` 的类别表 `toolKindOf()`（官方 `ui-chat/process-activity.ts` + dsh-Go
 *     `tool_glyph.dart` 的同一套工具名 → 类别映射）；
 *   - dsh-Go `app/lib/state/artifacts.dart → _createdPath()`：`write` / `str_replace_editor`
 *     按参数取 `file_path`，拿不到才退 `path`；**读类工具永不产生产物**。
 *
 * ## 抽取规则（三条，都是「有证据才认」）
 *
 * | 来源 | 认什么 | 说明 |
 * |---|---|---|
 * | 参数 | 写类工具的 `file_path` / `path` / … 字符串参数，或 `files: []` 数组 | 参数是流式拼起来的 JSON；解析失败就换下一条来源，**不猜** |
 * | diff | `callDetail` / `resultDetail` 里 adapter 拼好的 `文件: <路径>` 块 | 编辑类工具即使参数截断，结果里也有同一份路径（`toolDetail.parseDiffs` 已经会解析） |
 * | patch | `*** Add File:` / `*** Update File:` / `*** Move to:` 标记行 | 只认这三种显式标记；`*** Delete File:` **不算产物**（文件被删了） |
 *
 * 写类判定：`toolKindOf()` 给出 `write` / `edit` 即算；其余（MCP 这类没有登记在类别表里的
 * 工具）只有当**工具名里出现明确的写动词**（write / create / edit / patch / save 的整词，
 * `mcp__fs__write_file` 这种也算）且参数里有像路径的值时才认。读类、搜索类、终端一律不认
 * ——终端命令里出现的路径属于「猜」，宁可少列也不给错。
 *
 * ## 三条纪律
 *
 * 1. **只有 `state === 'finished'` 的工具算数**：失败 / 还在跑的工具没有产物可交付。
 * 2. **一轮没结束就不显示**（`settled` 见 `turnArtifactGroups`）：流式进行中冒出来的
 *    「本次产出」会跟着每一步抖动，等 `turn/end`（或后面又开了新一轮）再给。
 * 3. **绝不返回半截路径**：`looksLikeFilePath()` 把 URL / data: / 多行 / 超长 /
 *    目录（结尾 `/`）全挡在外面，抽不到就整块不渲染。
 *
 * 这个文件是**纯函数**（没有 React、没有网络、没有 store）：单测在
 * `__selftest__/artifacts.selftest.mts`；界面在 `components/remote/artifacts/**`。
 */

import { parseDiffs } from '../../components/remote/tool/toolDetail.js'
import { parseArguments, toolKindOf } from '../../components/remote/tool/toolMeta.js'
import type { ChatItem, ToolActivity } from './adapter.js'

/* ────────────────────────────────────────────────────────────────────────
 * 一、类型
 * ──────────────────────────────────────────────────────────────────────── */

/** 这个文件是「新建出来的」还是「改出来的」。 */
export type ArtifactOrigin = 'created' | 'modified'

/** 路径是从哪儿抽到的（报告 / 单测用它自证「没瞎猜」）。 */
export type ArtifactSource = 'args' | 'diff' | 'patch'

/** 一个产物文件（同一路径在**一轮**里只出现一次）。 */
export interface ArtifactFile {
  /** 归一化后的路径（`\` → `/`，去掉行号后缀；相对 / 绝对都保留原样）。 */
  path: string
  /** 文件名（最后一段）。 */
  name: string
  /** 相对目录（`''` = 当前目录 / 不知道）。 */
  dir: string
  origin: ArtifactOrigin
  source: ArtifactSource
  /** 产出它的工具名（`write` / `apply_patch` …），界面 hover 用。 */
  toolKey: string
  /** 工具行 id（React key 与「同一个工具只算一次」的依据）。 */
  itemId: string
  /** 首次出现的时间（毫秒；只用于排序，不展示）。 */
  at: number
}

/** 一轮回复的产物 + 面板该挂在时间线的哪个下标后面。 */
export interface ArtifactGroup {
  /** 分组键：有 `turn` 用 `turn:<id>`，否则 `row:<首个 item id>`。 */
  key: string
  /** 该组最后一个 item 的下标（面板就挂在这个 item 之后）。 */
  endIndex: number
  /** 这一轮结束了吗（见 `computeGroups`）。 */
  settled: boolean
  files: ArtifactFile[]
}

/* ────────────────────────────────────────────────────────────────────────
 * 二、路径规则
 * ──────────────────────────────────────────────────────────────────────── */

/** 参数里可能出现在「写到哪」位置的键（顺序即优先级，先命中先用）。 */
export const PATH_ARG_KEYS = [
  'file_path',
  'filePath',
  'path',
  'file',
  'target_file',
  'notebook_path',
  'absolute_path',
  'output_path',
] as const

/** 可能出现在「一次写多个」位置的键（只认字符串数组）。 */
export const PATH_ARRAY_KEYS = ['files', 'paths'] as const

/** 工具名里出现这些**整词**才算「写类」（没有登记在类别表里的 MCP 工具走这条）。 */
const WRITE_VERB_TOKENS = new Set(['write', 'writes', 'create', 'creates', 'edit', 'edits', 'patch', 'patches', 'save'])

/** 名字里带这些词的是「建目录 / 删文件」：不是交付物（建目录没有文件可看）。 */
const NOT_ARTIFACT_TOKENS = new Set([
  'directory',
  'directories',
  'dir',
  'folder',
  'folders',
  'mkdir',
  'delete',
  'remove',
  'rm',
  'rmdir',
  'unlink',
])

/** 行号后缀：`src/a.ts:12` / `src/a.ts:12:3`（Windows 盘符 `C:/` 不在匹配范围内）。 */
const LINE_SUFFIX = /:\d+(?::\d+)?$/u
const DRIVE_PREFIX = /^[A-Za-z]:\//u
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//iu
/** patch 文本里的显式标记（`*** Delete File:` 刻意不在表里：删掉的文件不是产物）。 */
const PATCH_MARKER = /^\*\*\* (?:Add|Update) File: (.+)$/u
const PATCH_MOVE = /^\*\*\* Move to: (.+)$/u

/** 去掉 `./` 前缀、折叠重复分隔符，只留展示用的正斜杠形态。 */
const tidyPath = (path: string): string => {
  let text = path.replace(/\\/gu, '/')
  // `a//b` → `a/b`；但 `//host/share`（UNC）保留开头那一个双斜杠
  const unc = text.startsWith('//')
  text = text.replace(/\/{2,}/gu, '/')
  if (unc) {
    text = `/${text}`
  }
  const collapsed = text.replace(/(^|\/)\.\//gu, '$1')
  return collapsed
}

/**
 * 这个值像不像一个**文件**路径。
 *
 * 全是「不像就别认」的判断：URL、data:、多行、超长、空、`.``..`、以 `/` 结尾的目录、
 * 带空格但不像路径的短语（例如模型把说明写进了 `path`）。抽不到就不显示，绝不猜。
 */
export const looksLikeFilePath = (value: string): boolean => {
  const text = value.trim()
  if (text.length === 0 || text.length > 400) {
    return false
  }
  if (/[\n\r\t]/u.test(text)) {
    return false
  }
  if (URL_LIKE.test(text) || text.startsWith('data:')) {
    return false
  }
  if (text === '.' || text === '..' || text.endsWith('/') || text.endsWith('\\')) {
    return false
  }
  // 必须带一个「像文件名」的字符，且不能是纯标点
  if (!/[A-Za-z0-9_.\-\\/]/u.test(text)) {
    return false
  }
  return /[A-Za-z0-9_]/u.test(text)
}

/** 归一化一个候选路径；不像路径就返回 `undefined`。 */
export const normalizeArtifactPath = (raw: string | undefined): string | undefined => {
  if (raw === undefined) {
    return undefined
  }
  let text = raw.trim()
  if (!looksLikeFilePath(text)) {
    return undefined
  }
  // 行号后缀：`src/a.ts:12` 去掉 `:12`；`C:12` 这种盘符相对路径不拆（head 只剩盘符）
  const suffix = LINE_SUFFIX.exec(text)
  if (suffix !== null) {
    const head = text.slice(0, text.length - suffix[0].length)
    if (head.length > 1) {
      text = head
    }
  }
  const tidy = tidyPath(text).replace(/^\.\//u, '')
  if (tidy.length === 0 || !looksLikeFilePath(tidy)) {
    return undefined
  }
  return tidy
}

/** 文件名（最后一段）。 */
export const artifactNameOf = (path: string): string => {
  const cut = path.lastIndexOf('/')
  return cut < 0 ? path : path.slice(cut + 1)
}

/** 相对目录（`''` = 当前目录）。 */
export const artifactDirOf = (path: string): string => {
  const cut = path.lastIndexOf('/')
  return cut <= 0 ? '' : path.slice(0, cut)
}

/** 大写扩展名（`''` = 没有）；图标按它挑。 */
export const artifactExtensionOf = (path: string): string => {
  const name = artifactNameOf(path)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toUpperCase()
}

/**
 * 把工具给的路径换成**会话工作区相对路径**（工作区文件端点只吃相对路径）。
 *
 * - 相对路径：原样（去掉 `./`）；
 * - 绝对路径：去掉 `root` 前缀（大小写不敏感，Windows 盘符与 `/home/...` 都覆盖）；
 * - 不在工作区里 / 不知道 root：`null` —— 界面据此说「不在会话工作区里」，不做第二次猜测。
 */
export const toWorkspaceRelative = (path: string, root: string): string | null => {
  const file = tidyPath(path.trim())
  if (file.length === 0) {
    return null
  }
  const absolute = file.startsWith('/') || DRIVE_PREFIX.test(file)
  if (!absolute) {
    const relative = file.replace(/^\.\//u, '')
    return relative.length === 0 ? null : relative
  }
  const base = tidyPath(root.trim()).replace(/\/+$/u, '')
  if (base.length === 0 || base === file) {
    return null
  }
  const prefix = `${base}/`
  if (file.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) {
    return null
  }
  const relative = file.slice(prefix.length)
  return relative.length === 0 ? null : relative
}

/* ────────────────────────────────────────────────────────────────────────
 * 三、从一个工具调用里抽路径
 * ──────────────────────────────────────────────────────────────────────── */

/** 工具名 → 整词小写片段（`mcp__fs__write_file` → `['mcp','fs','write','file']`）。 */
const nameTokens = (name: string): string[] =>
  name
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 0)

const hasWriteVerb = (name: string): boolean => nameTokens(name).some((token) => WRITE_VERB_TOKENS.has(token))

/** 建目录 / 删文件一类的工具：名字里有明确的反向动词，一律不算产物。 */
const isNotArtifactName = (name: string): boolean =>
  nameTokens(name).some((token) => NOT_ARTIFACT_TOKENS.has(token))

/** `str_replace_editor` 的 `command: 'create'`：这类「按参数分流」的工具新建还是修改看参数。 */
const createsFromArgs = (args: Record<string, unknown> | undefined): boolean => {
  if (args === undefined) {
    return false
  }
  const command = args['command']
  if (command === 'create' || command === 'create_file') {
    return true
  }
  return typeof args['content'] === 'string' || typeof args['file_text'] === 'string'
}

/** 参数里的候选路径（先标量键，再数组键）。 */
export const pathsFromArgs = (args: Record<string, unknown> | undefined): string[] => {
  if (args === undefined) {
    return []
  }
  const out: string[] = []
  for (const key of PATH_ARG_KEYS) {
    const value = args[key]
    if (typeof value !== 'string') {
      continue
    }
    const path = normalizeArtifactPath(value)
    if (path !== undefined) {
      out.push(path)
    }
  }
  for (const key of PATH_ARRAY_KEYS) {
    const value = args[key]
    if (!Array.isArray(value)) {
      continue
    }
    for (const entry of value) {
      if (typeof entry !== 'string') {
        continue
      }
      const path = normalizeArtifactPath(entry)
      if (path !== undefined) {
        out.push(path)
      }
    }
  }
  return out
}

/**
 * adapter 拼好的 diff 文本里的 `文件: <路径>` 块。
 *
 * `toolDetail.parseDiffs()` 是**只读复用**（它已经在工具卡里跑这份解析）：这里只要路径，
 * 所以把 `created`（旧文件不存在 → `(新文件)`）一并带出来，界面据此显示「新建 / 修改」。
 */
export const pathsFromDiffText = (
  text: string | undefined,
): { path: string; created: boolean }[] => {
  if (text === undefined || !text.includes('文件: ')) {
    return []
  }
  const blocks = parseDiffs(text)
  if (blocks === undefined) {
    return []
  }
  const out: { path: string; created: boolean }[] = []
  for (const block of blocks) {
    const path = normalizeArtifactPath(block.path)
    if (path !== undefined) {
      out.push({ path, created: block.created })
    }
  }
  return out
}

/** patch 文本（`*** Add File:` / `*** Update File:` / `*** Move to:`）里的路径。 */
export const pathsFromPatchText = (text: string | undefined): string[] => {
  if (text === undefined || !text.includes('*** ')) {
    return []
  }
  const out: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    const marked = PATCH_MARKER.exec(line) ?? PATCH_MOVE.exec(line)
    if (marked === null) {
      continue
    }
    const path = normalizeArtifactPath(marked[1])
    if (path !== undefined) {
      out.push(path)
    }
  }
  return out
}

/** 参数里所有长字符串（patch 体可能放在 `patch` / `input` / `content` 任何一个键里）。 */
const textArgs = (args: Record<string, unknown> | undefined): string[] => {
  if (args === undefined) {
    return []
  }
  const out: string[] = []
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value.includes('*** ')) {
      out.push(value)
    }
  }
  return out
}

/** 每个工具行算一次就够（同一行的归约会重建对象，所以用 WeakMap 按对象缓存）。 */
const toolCache = new WeakMap<ToolActivity, ArtifactFile[]>()

const toArtifact = (
  item: ToolActivity,
  path: string,
  origin: ArtifactOrigin,
  source: ArtifactSource,
): ArtifactFile => ({
  path,
  name: artifactNameOf(path),
  dir: artifactDirOf(path),
  origin,
  source,
  toolKey: item.toolKey ?? item.toolName,
  itemId: item.id,
  at: Number.isFinite(item.createdAt) ? item.createdAt : 0,
})

/**
 * 一个工具调用产出的文件（可能 0 个，也可能一次写多个）。
 *
 * **读类工具一定返回 `[]`**（`toolKindOf` 给 `read` / `readImage` / `search` 时直接退出）。
 */
export const artifactsOfTool = (item: ToolActivity): ArtifactFile[] => {
  const cached = toolCache.get(item)
  if (cached !== undefined) {
    return cached
  }
  const files = computeArtifactsOfTool(item)
  toolCache.set(item, files)
  return files
}

const computeArtifactsOfTool = (item: ToolActivity): ArtifactFile[] => {
  // 失败 / 进行中的工具没有产物可交付
  if (item.state !== 'finished') {
    return []
  }
  const name = item.toolKey ?? item.toolName
  const args = parseArguments(item.arguments)
  const kind = toolKindOf(name, args)
  if (kind === 'read' || kind === 'readImage' || kind === 'search') {
    return []
  }
  const writeClass =
    (kind === 'write' || kind === 'edit' || hasWriteVerb(name)) && !isNotArtifactName(name)
  if (!writeClass) {
    return []
  }
  const origin: ArtifactOrigin =
    kind === 'write' || createsFromArgs(args) ? 'created' : 'modified'

  // 同一个工具里同一路径只算一次；先到的来源优先（args 比 diff 更直接）
  const seen = new Map<string, ArtifactFile>()
  const push = (path: string, sourceOrigin: ArtifactOrigin, source: ArtifactSource): void => {
    if (seen.has(path)) {
      return
    }
    seen.set(path, toArtifact(item, path, sourceOrigin, source))
  }
  for (const path of pathsFromArgs(args)) {
    push(path, origin, 'args')
  }
  for (const block of pathsFromDiffText(item.callDetail?.text)) {
    push(block.path, block.created ? 'created' : 'modified', 'diff')
  }
  for (const block of pathsFromDiffText(item.resultDetail?.text)) {
    push(block.path, block.created ? 'created' : 'modified', 'diff')
  }
  for (const text of textArgs(args)) {
    for (const path of pathsFromPatchText(text)) {
      push(path, origin, 'patch')
    }
  }
  // 兜底：结果是 patch 形态的文本（有的 Host 直接把 patch 回在结果里）
  for (const path of pathsFromPatchText(item.resultDetail?.text)) {
    push(path, origin, 'patch')
  }
  return [...seen.values()]
}

/* ────────────────────────────────────────────────────────────────────────
 * 四、按轮 / 按会话聚合
 * ──────────────────────────────────────────────────────────────────────── */

/** 用户消息 = 新一轮的开始（上下文注入行不算）。 */
const isTurnBoundary = (item: ChatItem): boolean =>
  item.kind === 'message' && item.role === 'user' && item.context !== true

interface RawGroup {
  key: string
  endIndex: number
  files: ArtifactFile[]
  turnEnd: boolean
  running: boolean
}

const computeGroups = (items: readonly ChatItem[], streaming: boolean): ArtifactGroup[] => {
  const raw: RawGroup[] = []
  let current: RawGroup | undefined
  let turn: string | undefined

  const flush = (): void => {
    if (current !== undefined) {
      raw.push(current)
    }
    current = undefined
  }

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (item === undefined) {
      continue
    }
    const itemTurn = item.turn
    const starts =
      current === undefined ||
      isTurnBoundary(item) ||
      (itemTurn !== undefined && turn !== undefined && itemTurn !== turn)
    if (starts) {
      flush()
      turn = itemTurn
      current = {
        key: itemTurn === undefined ? `row:${item.id}` : `turn:${itemTurn}`,
        endIndex: index,
        files: [],
        turnEnd: false,
        running: false,
      }
    }
    if (current === undefined) {
      continue
    }
    if (turn === undefined && itemTurn !== undefined) {
      turn = itemTurn
      current.key = `turn:${itemTurn}`
    }
    current.endIndex = index
    if (item.turnEnd !== undefined) {
      current.turnEnd = true
    }
    if (item.kind === 'tool') {
      if (item.state === 'running') {
        current.running = true
      }
      const files = artifactsOfTool(item)
      for (const file of files) {
        if (!current.files.some((existing) => existing.path === file.path)) {
          current.files.push(file)
        }
      }
    }
  }
  flush()

  const groups: ArtifactGroup[] = []
  for (let index = 0; index < raw.length; index += 1) {
    const group = raw[index]
    if (group === undefined) {
      continue
    }
    // 后面还有内容 ⇒ 这一轮已经翻篇；最后一轮要么有 turn/end 证据，要么（不流式时）已经落定
    const settled =
      !group.running && (index < raw.length - 1 || group.turnEnd || !streaming)
    if (!settled || group.files.length === 0) {
      continue
    }
    groups.push({
      key: group.key,
      endIndex: group.endIndex,
      settled: true,
      files: group.files,
    })
  }
  return groups
}

interface GroupCache {
  items: readonly ChatItem[] | undefined
  streaming: boolean
  groups: ArtifactGroup[]
}

const groupCache: GroupCache = { items: undefined, streaming: false, groups: [] }

/**
 * 时间线里**每一轮**的产物（只含已结束、且确实有产物的轮）。
 *
 * 结果按 `endIndex` 升序；界面用它决定「这一行后面要不要挂面板」：
 * `group.endIndex === 当前下标` 就是挂载点。
 *
 * 内部按「items 引用 + streaming」做一次记忆：`RemoteChatView` 会给每一行都调用它，
 * 而 items 只在归约出新内容时换对象 —— 不记忆的话每帧都是 O(n²) 的工具解析。
 */
export const turnArtifactGroups = (
  items: readonly ChatItem[],
  options: { streaming?: boolean } = {},
): ArtifactGroup[] => {
  const streaming = options.streaming === true
  if (groupCache.items === items && groupCache.streaming === streaming) {
    return groupCache.groups
  }
  const groups = computeGroups(items, streaming)
  groupCache.items = items
  groupCache.streaming = streaming
  groupCache.groups = groups
  return groups
}

interface SessionCache {
  items: readonly ChatItem[] | undefined
  streaming: boolean
  files: ArtifactFile[]
}

const sessionCache: SessionCache = { items: undefined, streaming: false, files: [] }

/**
 * 整个会话的产物：**按路径去重**、按最近一次出现的时间**倒序**（新的在前）。
 *
 * 「去重」保留最后一次那条（工具名 / 时间取最新的）；顺序按 `at` 降序，
 * 同一时刻再按路径升序 —— 保证两次渲染顺序稳定（否则列表会跳）。
 */
export const sessionArtifacts = (
  items: readonly ChatItem[],
  options: { streaming?: boolean } = {},
): ArtifactFile[] => {
  const streaming = options.streaming === true
  if (sessionCache.items === items && sessionCache.streaming === streaming) {
    return sessionCache.files
  }
  const byPath = new Map<string, ArtifactFile>()
  for (const group of turnArtifactGroups(items, options)) {
    for (const file of group.files) {
      const seen = byPath.get(file.path)
      byPath.set(file.path, seen === undefined ? file : { ...file, at: Math.max(seen.at, file.at) })
    }
  }
  const files = [...byPath.values()].sort((left, right) => {
    if (right.at !== left.at) {
      return right.at - left.at
    }
    return left.path.localeCompare(right.path)
  })
  sessionCache.items = items
  sessionCache.streaming = streaming
  sessionCache.files = files
  return files
}

/** 单测 / 换会话时清掉两块记忆（界面层不需要调用：items 一换引用就自动失效）。 */
export const resetArtifactCaches = (): void => {
  groupCache.items = undefined
  groupCache.streaming = false
  groupCache.groups = []
  sessionCache.items = undefined
  sessionCache.streaming = false
  sessionCache.files = []
}

/* ────────────────────────────────────────────────────────────────────────
 * 五、「全部下载」：串行、带进度、失败跳过
 * ──────────────────────────────────────────────────────────────────────── */

export interface ArtifactDownloadProgress {
  /** 正在取第几个（0 基） */
  index: number
  total: number
  file: ArtifactFile
}

export interface ArtifactDownloadSummary {
  saved: ArtifactFile[]
  failed: { file: ArtifactFile; error: unknown }[]
}

export interface ArtifactDownloadDeps {
  /**
   * 真正的存盘动作。界面层传 `downloadWorkspacePath(rel, { scopeId })`；
   * 自测传一个假的 —— 这一层不认识网络。
   */
  download: (file: ArtifactFile) => Promise<unknown>
  /** 开始取第 `index` 个之前回调一次（进度条 / 文案用） */
  onProgress?: (progress: ArtifactDownloadProgress) => void
  /** 返回 true 时在下一个文件之前停下（面板被关掉 / 换了会话） */
  shouldStop?: () => boolean
}

/**
 * 串行保存一批文件。
 *
 * 为什么串行：远端 `workspaceFiles/readBytes` 单次 4 MiB、走的是同一条加密通道，
 * 并发只会把带宽和内存同时打满；而且原生 `/__ds_download/save` 是「一次一文件」的
 * 同步写盘，排着队反而更快出结果。
 *
 * **失败不中断**：某个文件读不到（被删了 / 太大）就记下来继续下一个，
 * 结束由调用方一句话汇总（「已保存 4 个，2 个没成功」）。
 */
export const downloadArtifacts = async (
  files: readonly ArtifactFile[],
  deps: ArtifactDownloadDeps,
): Promise<ArtifactDownloadSummary> => {
  const saved: ArtifactFile[] = []
  const failed: { file: ArtifactFile; error: unknown }[] = []
  const total = files.length
  for (let index = 0; index < total; index += 1) {
    if (deps.shouldStop?.() === true) {
      break
    }
    const file = files[index]
    if (file === undefined) {
      continue
    }
    deps.onProgress?.({ index, total, file })
    try {
      await deps.download(file)
      saved.push(file)
    } catch (error) {
      failed.push({ file, error })
    }
  }
  return { saved, failed }
}
