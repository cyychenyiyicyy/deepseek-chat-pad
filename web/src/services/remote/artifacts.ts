/**
 * 交付文件（产物）：把 adapter 落好的 `ArtifactActivity` 按「轮」聚成该渲染的卡片数据。
 *
 * ## 这里**不做**识别
 *
 * 上一轮（R12）这一层是从 `write` / `edit` / `apply_patch` 的工具参数里**猜**产物，
 * 那是错的：DSH 本来就有产物产出 —— 每轮结束前 Agent 调用官方 **`present`** 工具声明
 * 交付文件，Host 把结果落成一条 **`deliverables/presented`** 会话事件，
 * 官方 Web 客户端与 dsh-Go 都读这一条。证据链：
 *
 * | 环节 | 出处 |
 * |---|---|
 * | 工具定义 + 参数 schema | `@deepseek-ai/dsh-tool-present/src/index.ts:39-58` |
 * | 落库事件 | 同文件 `101-109`：`session.append('deliverables/presented', { turn, callId, files })` |
 * | 事件类型注册 | `@deepseek-ai/dsh-session/src/known-event-types.ts:36` |
 * | 事件负载类型 | `@deepseek-ai/dsh-tool-present/src/types.ts:12-16` |
 * | 官方客户端读取 | `@deepseek-ai/dsh-client-ui-deliverables/src/client/turn-deliverables.ts:191-201`、`261-265` |
 * | 官方卡片 | 同包 `src/client/Deliverables.tsx:20`（收起阈值 4）、`45-49`、`56-59`、`108-128` |
 * | dsh-Go 读取 | `app/lib/state/artifacts.dart:389`（`presentedByTurn(events)`）、`396-407` |
 * | dsh-Go 卡片 | `app/lib/ui/chat/widgets/artifact_card.dart:30-41`（ASCII 结构）、`52`、`65-70` |
 *
 * 所以本文件只做三件**纯函数**的事：展开 `PresentedFile` 成可渲染行、按轮分组定挂载点、
 * 会话级去重（给卡片里的「全部」用）。没有任何「工具名像不像写文件」的启发式。
 *
 * 这个文件是纯函数（没有 React、没有网络、没有 store）。
 * 单测在 `__selftest__/artifacts.selftest.mts`；界面在 `components/remote/artifact/**`。
 */

import type { ArtifactActivity, ChatItem, PresentedFile } from './adapter.js'

/* ────────────────────────────────────────────────────────────────────────
 * 一、类型
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 产物种类 —— 与 dsh-Go 的 `ArtifactKind`（`app/lib/state/artifacts.dart:18-46`）
 * 同一套分类，只少了 `other` 之外的平台概念。
 */
export type ArtifactKind =
  | 'image'
  | 'pdf'
  | 'document'
  | 'spreadsheet'
  | 'slides'
  | 'archive'
  | 'audio'
  | 'video'
  | 'web'
  | 'markdown'
  | 'text'
  | 'other'

/** 一条产物（`PresentedFile` + 由路径推出的展示信息）。 */
export interface ArtifactFile {
  /** 原样保留 `present` 声明的路径（Host 已按工作目录解析过）。 */
  path: string
  /** 文件名（最后一段）。 */
  name: string
  /** 大写扩展名（`''` = 没有）。 */
  extension: string
  kind: ArtifactKind
  /** 模型写的说明（`present` 的 `description`）。 */
  description?: string
  /** 声明的是一行 http(s) 外链而不是本地文件时，这里是那个 URL。 */
  url?: string
}

/** 一轮的产物 + 卡片该挂在时间线的哪一行后面。 */
export interface TurnArtifacts {
  /** 分组键（`turn:<id>`），也是 React key。 */
  key: string
  /** 原生 turn id（数字轮次转成字符串）。 */
  turn: string
  /** 卡片挂在这一行之后（`items` 的下标，**不含**产物占位行本身）。 */
  endIndex: number
  /** 这一轮结束了没有（看到 `turn/end`）。没结束不显示卡片 —— 与 dsh-Go `deriveArtifacts` 一致。 */
  settled: boolean
  /** 本轮声明的交付文件（首次出现顺序，同路径只留最新一份）。 */
  files: ArtifactFile[]
}

/* ────────────────────────────────────────────────────────────────────────
 * 二、路径 → 展示信息
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 扩展名 → 种类。照抄 dsh-Go `app/lib/state/artifacts.dart:48-61` 的 `_kinds` 表
 * （官方 Web 客户端用 `FileTypeIcon`，分类口径一致）。
 */
const KINDS: Readonly<Record<string, ArtifactKind>> = {
  // 图片
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image',
  heic: 'image', heif: 'image', avif: 'image', tif: 'image', tiff: 'image', ico: 'image', svg: 'image',
  pdf: 'pdf',
  // 文档
  doc: 'document', docx: 'document', odt: 'document', rtf: 'document', pages: 'document',
  wps: 'document', epub: 'document',
  // 表格
  xls: 'spreadsheet', xlsx: 'spreadsheet', ods: 'spreadsheet', csv: 'spreadsheet',
  tsv: 'spreadsheet', numbers: 'spreadsheet', et: 'spreadsheet',
  // 演示
  ppt: 'slides', pptx: 'slides', odp: 'slides', key: 'slides', dps: 'slides',
  // 压缩包
  zip: 'archive', tar: 'archive', gz: 'archive', tgz: 'archive', bz2: 'archive',
  xz: 'archive', '7z': 'archive', rar: 'archive', zst: 'archive', apk: 'archive',
  // 音频
  mp3: 'audio', wav: 'audio', m4a: 'audio', aac: 'audio', flac: 'audio', ogg: 'audio',
  opus: 'audio', amr: 'audio', mid: 'audio', midi: 'audio',
  // 视频
  mp4: 'video', mov: 'video', webm: 'video', mkv: 'video', avi: 'video', m4v: 'video', '3gp': 'video',
  // 网页 / 文本
  html: 'web', htm: 'web', mhtml: 'web',
  md: 'markdown', markdown: 'markdown',
  txt: 'text', log: 'text',
}

/** 文件名（最后一段，`/` 与 `\` 都认）。 */
export const artifactNameOf = (path: string): string => {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at < 0 ? path : path.slice(at + 1)
}

/** 大写扩展名（`''` = 没有）；`dot <= 0` 时算没有（`.gitignore` 不是扩展名）。 */
export const artifactExtensionOf = (path: string): string => {
  const name = artifactNameOf(path)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toUpperCase()
}

/** 扩展名 → 种类（未知一律 `other`）。 */
export const artifactKindOf = (path: string): ArtifactKind => KINDS[artifactExtensionOf(path).toLowerCase()] ?? 'other'

/** 一行 http(s) 外链？`present` 只收本地文件，这个分支是给「Host 把外链也塞进 files」兜底的。 */
const isHttpUrl = (value: string): boolean => /^https?:\/\//iu.test(value.trim())

/** `PresentedFile` → 可渲染行。 */
export const artifactFileOf = (file: PresentedFile): ArtifactFile => {
  const path = file.path.trim()
  const url = isHttpUrl(path) ? path : undefined
  const extension = url === undefined ? artifactExtensionOf(path) : ''
  return {
    path,
    name: url === undefined ? artifactNameOf(path) : (url.replace(/[?#].*$/u, '').split('/').at(-1) || url),
    extension,
    kind: url === undefined ? (KINDS[extension.toLowerCase()] ?? 'other') : 'web',
    ...(file.description === undefined || file.description.trim().length === 0
      ? {}
      : { description: file.description.trim() }),
    ...(url === undefined ? {} : { url }),
  }
}

/**
 * 把 `present` 声明的路径换成**会话工作区相对路径**（工作区文件端点只吃相对路径）。
 *
 * - 相对路径：原样（去掉 `./`）—— `present` 的相对路径是相对 Session 工作目录的，
 *   工作目录通常就是工作区根，这是绝大多数情况；
 * - 绝对路径：去掉 `root` 前缀（大小写不敏感，Windows 盘符与 `/home/...` 都覆盖）；
 * - 不在工作区里 / 不知道 root：`null` —— 界面据此说「不在会话工作区里」，不做第二次猜测。
 */
export const toWorkspaceRelative = (path: string, root: string): string | null => {
  const file = path.trim().replace(/\\/gu, '/')
  if (file.length === 0) {
    return null
  }
  const absolute = file.startsWith('/') || /^[A-Za-z]:\//u.test(file)
  if (!absolute) {
    const relative = file.replace(/^\.\//u, '')
    return relative.length === 0 ? null : relative
  }
  const base = root.trim().replace(/\\/gu, '/').replace(/\/+$/u, '')
  if (base.length === 0 || base.toLowerCase() === file.toLowerCase()) {
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
 * 三、按轮分组（卡片挂载点）
 * ──────────────────────────────────────────────────────────────────────── */

/** 时间线里所有产物行（`kind:'artifact'`）。 */
const artifactActivities = (items: readonly ChatItem[]): ArtifactActivity[] =>
  items.filter((item): item is ArtifactActivity => item.kind === 'artifact')

/** 一条产物行里声明的文件（顺序保留，同路径只留最新一份 —— 同官方 `presentedForClosing`）。 */
const filesOf = (item: ArtifactActivity): ArtifactFile[] => {
  const byPath = new Map<string, ArtifactFile>()
  for (const file of item.files) {
    const rendered = artifactFileOf(file)
    if (rendered.path.length === 0) {
      continue
    }
    byPath.set(rendered.path, rendered)
  }
  return [...byPath.values()]
}

/**
 * 这一行算不算「某一轮的最后一行可见内容」。
 *
 * 产物行本身是**数据载体**（不渲染成行，见 `RemoteChatView` 的 `RemoteRow`），
 * 所以定挂载点时要跳过它；否则卡片会挂在 `present` 那一刻的位置，
 * 而不是这一轮真正说话的地方。
 */
const holdsSlot = (item: ChatItem): boolean => item.kind !== 'artifact'

/**
 * 把时间线按轮聚成产物卡数据。
 *
 * - 只认 `kind:'artifact'`（官方 `deliverables/presented` / `present` 参数）；
 * - 挂载点是**该轮最后一个非产物行**的下标；
 * - `settled` 看这一轮有没有 `turn/end`；`includeUnsettled` 为 `false`（默认）时
 *   未结束的轮不返回 —— 与 dsh-Go `deriveArtifacts`（`artifacts.dart:360-364`）一致。
 *
 * 纯函数：同样的 `items` 一定得到同样结果，可以放心每行都调一次（`RemoteChatView` 就是这么做的）。
 */
export const turnArtifacts = (
  items: readonly ChatItem[],
  options: { includeUnsettled?: boolean } = {},
): TurnArtifacts[] => {
  const order: string[] = []
  const groups = new Map<string, TurnArtifacts>()
  const filesByTurn = new Map<string, Map<string, ArtifactFile>>()
  /** 没有可见行时退回的挂载点（产物行自己的下标）；见过任何一行就先记这里。 */
  const anyIndexByTurn = new Map<string, number>()

  for (const item of artifactActivities(items)) {
    if (item.turn === undefined) {
      continue
    }
    const turn = item.turn
    let bucket = filesByTurn.get(turn)
    if (bucket === undefined) {
      order.push(turn)
      groups.set(turn, { key: `turn:${turn}`, turn, endIndex: -1, settled: false, files: [] })
      bucket = new Map()
      filesByTurn.set(turn, bucket)
    }
    for (const file of filesOf(item)) {
      bucket.set(file.path, file)
    }
  }
  if (order.length === 0) {
    return []
  }

  for (const [index, item] of items.entries()) {
    if (item.turn === undefined) {
      continue
    }
    const group = groups.get(item.turn)
    if (group === undefined) {
      continue
    }
    if (holdsSlot(item)) {
      group.endIndex = index
    }
    anyIndexByTurn.set(item.turn, index)
    if (item.turnEnd !== undefined) {
      group.settled = true
    }
  }

  const out: TurnArtifacts[] = []
  for (const turn of order) {
    const group = groups.get(turn)
    if (group === undefined) {
      continue
    }
    const files = [...(filesByTurn.get(turn)?.values() ?? [])]
    if (files.length === 0) {
      continue
    }
    // 一轮里连一条可见行都没有（历史窗口只剩 `deliverables/presented`）时，
    // 退回挂在产物行自己的位置上 —— 那里 `RemoteRow` 返回 null，卡片就地补上，不留空白。
    if (group.endIndex < 0) {
      group.endIndex = anyIndexByTurn.get(turn) ?? -1
    }
    if (group.endIndex < 0) {
      continue
    }
    if (!group.settled && options.includeUnsettled !== true) {
      continue
    }
    out.push({ ...group, files })
  }
  return out
}

/** 卡片上「全部 N 个文件」展开之后要显示的文件（本轮全部；收起时由卡片自己截前 4 个）。 */
export const ALL_ARTIFACT_LIMIT = 4

/**
 * 卡片渲染分支 ①：这一行（下标）该不该挂产物卡。
 *
 * 挂载点判定是纯数据问题，所以放在 services 里、由单测直接盯 ——
 * 组件只负责「查到了就画」，不再自己写一遍 `find`。
 */
export const artifactGroupAtIndex = (
  groups: readonly TurnArtifacts[],
  index: number,
): TurnArtifacts | undefined => groups.find((group) => group.endIndex === index)

/**
 * 卡片渲染分支 ②：收起 / 展开时到底列哪些文件。
 *
 * 阈值与官方一致（`Deliverables.tsx:20` 的 `COLLAPSED_PRESENTED_COUNT = 4`、
 * dsh-Go `artifact_card.dart:52` 的 `shownCount = 4`）。
 */
export const visibleArtifactFiles = (
  files: readonly ArtifactFile[],
  expanded: boolean,
): ArtifactFile[] => (expanded || files.length <= ALL_ARTIFACT_LIMIT ? [...files] : files.slice(0, ALL_ARTIFACT_LIMIT))

/** 还有没有收起不看的部分（决定要不要画「全部 N 个文件」那一行）。 */
export const hasHiddenArtifacts = (files: readonly ArtifactFile[]): boolean => files.length > ALL_ARTIFACT_LIMIT

/**
 * `turnArtifacts()` 的**按引用记忆**版本：时间线每一行都会问一句「这一轮结束在这一行吗」，
 * 不记忆就是每帧 O(行数 × 事件数)。
 *
 * 记忆键是 `items` 的引用 —— 数据层每次归约都产出新数组，所以引用变了就重算，
 * 不会读到过期结果（与 R12 的 `turnArtifactGroups` 同一条纪律，只是换了数据来源）。
 */
const turnArtifactsCache = new WeakMap<readonly ChatItem[], TurnArtifacts[]>()

/** 带记忆的 `turnArtifacts(items)`（只缓存默认参数那一档）。 */
export const turnArtifactsOf = (items: readonly ChatItem[]): TurnArtifacts[] => {
  const cached = turnArtifactsCache.get(items)
  if (cached !== undefined) {
    return cached
  }
  const computed = turnArtifacts(items)
  turnArtifactsCache.set(items, computed)
  return computed
}

/**
 * 会话级去重：新的在前，同一路径只留最新那一轮的一份。
 *
 * 与 dsh-Go `session_artifacts.dart:19-26` 的 `latestArtifacts()` 同一口径。
 * 会话级清单**只由卡片里的「全部」入口承担**，不再单独做一套目录。
 */
export const sessionArtifacts = (groups: readonly TurnArtifacts[]): ArtifactFile[] => {
  const seen = new Set<string>()
  const out: ArtifactFile[] = []
  for (const group of [...groups].reverse()) {
    for (const file of group.files) {
      if (seen.has(file.path)) {
        continue
      }
      seen.add(file.path)
      out.push(file)
    }
  }
  return out
}
