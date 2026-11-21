/**
 * 远端 DSH 的**工作区文件浏览**与**会话附件**端点层。
 *
 * 与 `sessionsApi.ts` 同一层：只拼参数、发 `harness.remote.call`、拆官方 envelope、
 * 把失败变成可读原因。**不持有连接、不存 UI 状态**（那是 `components/remote/workspace/**`
 * 里的面板 store）。
 *
 * ## 一、参数包装（与其它端点完全一样）
 *
 * ```json
 * { "endpoint": "workspaceFiles/list",
 *   "payload": { "args": { "workspaceFileScopeId": "<sessionId>", "path": "." } } }
 * ```
 *
 * `workspaceFileScopeId` 就是**会话 id**：Host 用它定位会话工作区根（cwd）并做物理包含性检查
 * （input-B §2.8.1、`docs/protocol.md:1290-1297`）。参数形状逐字照官方 RN 客户端
 * `packages/app-core/src/services/session-tools.ts:164-186`：
 *
 * | 端点 | args | 返回 |
 * |---|---|---|
 * | `workspaceFiles/list` | `{workspaceFileScopeId, path}`（根目录用 `"."`） | `{path, entries:[{name,type,size?}], truncated}` |
 * | `workspaceFiles/stat` | `{workspaceFileScopeId, path}` | `{absolutePath, version, bytes?}` |
 * | `workspaceFiles/read` | `{workspaceFileScopeId, path, range:{offset,limit}}`（**行号从 1 起**） | `{absolutePath, version, text, offset, lines, eof}` |
 * | `workspaceFiles/readBytes` | `{workspaceFileScopeId, path, range:{offset,length}}`（**字节偏移**） | `{absolutePath, version, bytes?, offset, eof, data:<base64>}` |
 * | `workspaceFiles/changes` | `{workspaceFileScopeId, path}` | 变更元信息（本批只透传，不订阅） |
 *
 * ## 二、三条必须照做的限制（写错就是白跑或 OOM）
 *
 * 1. **`readBytes` 单次上限 4 MiB**（`harness-remote-bridge.ts:241`，input-B 附录 B）。
 *    所以 `readWorkspaceBytes()` 会把 `length` 夹到 4 MiB，超过就抛而不是被 Host 拒。
 * 2. **transfer chunk 512 KiB**（input-B 附录 B）：大文件一律 `readWorkspaceBytesRange()`
 *    按 512 KiB 分块拼，别一次要完 —— 那条路只在 Host 宣告 `harness.remote.transfer.v1`
 *    时才存在，本文件不赌它。
 * 3. **`read`/`stat` 严格限制在会话工作区根内**：`..`、绝对路径、越界符号链接都会被拒，
 *    `rpc.error.details.reason` 给稳定分类（`outside-root|symlink|not-found|too-large|…`）
 *    且**不回显路径**。所以客户端这边先做一遍**保守**的相对路径校验（`assertRelativePath`），
 *    让明显越界的调用连网都不发。
 *
 * ## 三、上传：为什么是两段式进度
 *
 * `fileUploads/upload` 是**单帧 base64**（`{agentId, request:{data,name}}` → `{receiptId, file}`，
 * 见 `docs/protocol.md`、Dart `session_api.dart:497-510`），协议上没有字节级回执，
 * 所以进度只能分三段：`encoding`（本地 base64，有真实进度）→ `uploading`（单帧在飞，不定进度）
 * → `done`。真要字节级进度得等 P2 的 `workspace.upload.v1`（chunk + ack）。
 * 单帧建议上限 30 MiB（`session_api.dart:475-478`：base64 会把内存放大几倍）。
 *
 * ## 四、能力门禁
 *
 * 工作区文件与附件上传都**没有专属 capability 字符串**（input-B §1.4.2），只能按调用结果判断：
 * Host 没有端点时回 `METHOD_NOT_FOUND` / `METHOD_NOT_ALLOWED`，`isMissingEndpoint()` 认这几个码，
 * 面板据此把整块 UI 收起来（与 `newSessionStore.ts` 的「先信任、失败即关」同一套）。
 */

import { RemoteApiError, isRemoteApiError } from './serverApi.js'
import { callEndpoint, lastRemoteTarget, type RemoteCallTarget } from './sessionsApi.js'
import { useRemoteStore } from './store.js'

/* ────────────────────────────────────────────────────────────────────────
 * 一、常量与端点
 * ──────────────────────────────────────────────────────────────────────── */

/** 业务端点（`harness.remote.call` 的 `endpoint`）。 */
export const WorkspaceFileEndpoints = {
  list: 'workspaceFiles/list',
  stat: 'workspaceFiles/stat',
  read: 'workspaceFiles/read',
  readBytes: 'workspaceFiles/readBytes',
  changes: 'workspaceFiles/changes',
  /** 会话附件上传（拿 receiptId）。 */
  upload: 'fileUploads/upload',
  /** 按 attachmentId 读会话附件内容（工具卡图片靠它）。 */
  attachment: 'session/attachment',
} as const

/** `readBytes` 的单次上限：Host 硬限制（input-B 附录 B）。 */
export const MAX_READ_BYTES = 4 * 1024 * 1024
/** 大文件分块大小：与 transfer chunk 同值，留出 envelope 余量（input-B 附录 B）。 */
export const READ_CHUNK_BYTES = 512 * 1024
/** 文本预览首屏预算：任务书要求「前 256 KiB」。 */
export const TEXT_PREVIEW_BYTES = 256 * 1024
/** 文本预览可以一直「加载更多」到多少字节（再往上就没意义了）。 */
export const TEXT_PREVIEW_MAX_BYTES = 4 * 1024 * 1024
/** `workspaceFiles/read` 的每页行数（官方客户端就是 200）。 */
export const TEXT_PAGE_LINES = 200
/** 图片预览默认上限（RN 侧同值；超过就只说「太大」不做解码）。 */
export const MAX_IMAGE_PREVIEW_BYTES = 8 * 1024 * 1024
/** `fileUploads/upload` 单帧上限：base64 内联，再大就换 `workspace.upload.v1`（P2）。 */
export const MAX_INLINE_UPLOAD_BYTES = 30 * 1024 * 1024
/** 读文件的默认超时（4 MiB base64 在 Relay 上可能要几秒）。 */
const READ_TIMEOUT_MS = 60_000
/** 上传的默认超时：官方 HTTP 路由给到 10 分钟，这里给 3 分钟（Relay 单帧）。 */
const UPLOAD_TIMEOUT_MS = 180_000

/** 「这台 Host 没有这个端点」——能力门禁只看这几个码（与 `newSessionStore.ts` 同集合）。 */
const MISSING_ENDPOINT_CODES = new Set([
  'METHOD_NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'CAPABILITY_NOT_SUPPORTED',
  'UNSUPPORTED',
  'FEATURE_NOT_SUPPORTED',
])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const stringOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const numberOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

/** 错误的稳定码（没有就是空串）。 */
export const errorCodeOf = (error: unknown): string => {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code.length > 0) return code
  }
  return ''
}

/** Host 缺端点（⇒ 整块 UI 该隐藏）。 */
export const isMissingEndpoint = (error: unknown): boolean => MISSING_ENDPOINT_CODES.has(errorCodeOf(error))

/** Host 拒了但**不是**缺端点（范围/权限/大小），可以把原因显示给用户。 */
export const isScopeRejection = (error: unknown): boolean => {
  if (!isRemoteApiError(error)) return false
  const details = (error as { details?: unknown }).details
  if (!isRecord(details)) return false
  const reason = details.reason
  return typeof reason === 'string' && reason.length > 0
}

/* ────────────────────────────────────────────────────────────────────────
 * 二、路径：拼接与安全
 *
 * Host 侧会再判一次（realpath + 包含性），这里的目的**只是不让明显非法的调用上网**，
 * 以及给界面一个稳定的「显示路径」。两条都不能省：Host 的拒绝不回显路径，
 * 客户端自己算一遍才能在面包屑上把用户点到哪儿显示出来。
 * ──────────────────────────────────────────────────────────────────────── */

/** 非法相对路径的原因（`null` = 合法）。 */
export type PathRejection = 'empty' | 'absolute' | 'parent' | 'nul' | 'control'

/**
 * 判一条**相对**路径能不能拿去当 `path` 参数。
 *
 * 规则（都是「宁可拒」）：
 *   - 空 / 只有分隔符 → `empty`；
 *   - 盘符（`C:` / `C:/`）、UNC（`\\host`）、以 `/` 起头 → `absolute`；
 *   - 任何一段是 `..` → `parent`（**不做归一化放行**：`a/../../b` 也算越界，直接拒）；
 *   - NUL 或控制字符 → `nul` / `control`。
 */
export const rejectionOfRelativePath = (path: string): PathRejection | null => {
  if (path.length === 0) return 'empty'
  if (path.includes('\u0000')) return 'nul'
  // 控制字符（含跨平台坑人的 `\u0001`…`\u001f`），但放行 `\t`（文件名里可能有，Host 也认）
  if (/[\u0001-\u0008\u000b-\u001f\u007f]/u.test(path)) return 'control'
  const unified = path.replace(/\\/gu, '/')
  if (unified.startsWith('/')) return 'absolute'
  if (/^[A-Za-z]:/u.test(unified)) return 'absolute'
  const segments = unified.split('/').filter((segment) => segment.length > 0 && segment !== '.')
  if (segments.length === 0) return 'empty'
  if (segments.includes('..')) return 'parent'
  return null
}

/**
 * 把路径归一成 `/` 分隔、无 `./` 前缀、无重复/尾随分隔符的形式；不合法就抛。
 *
 * `'.'` / `'./'` 归一成空串（= 工作区根），由调用方决定要不要换成 `'.'`：
 * `pathArgument()` 就是干这个的（Host 的根目录写法是 `"."`）。
 */
export const normalizeRelativePath = (raw: string): string => {
  const unified = raw.replace(/\\/gu, '/')
  // 绝对路径必须在归一化**之前**拒：`/a` 归一会变成 `a`（因为空段被过滤），那就成了静默改语义
  if (unified.startsWith('/') || /^[A-Za-z]:/u.test(unified)) throw pathError(raw, 'absolute')
  const segments = unified.split('/').filter((segment) => segment.length > 0 && segment !== '.')
  const normalized = segments.join('/')
  if (normalized.length === 0) return ''
  const rejection = rejectionOfRelativePath(normalized)
  if (rejection !== null) throw pathError(raw, rejection)
  return normalized
}

/**
 * 拼出绝对显示路径：`root` + 相对路径。
 *
 * 只给**界面**用（面包屑 / 标题 / tooltip），不下发给 Host —— 下发的永远是相对路径。
 */
export const resolveWorkspacePath = (root: string, relative: string): string => {
  if (relative.length === 0) return root
  const safe = normalizeRelativePath(relative)
  if (safe.length === 0) return root
  // 分隔符跟着 root 走：Windows 根（`C:\code`）拼出来仍然是反斜杠，别混成 `C:\code\src/a.ts`
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  const base = /[\\/]$/u.test(root) ? root.slice(0, -1) : root
  const joined = `${base}${separator}${safetyJoin(safe).split('/').join(separator)}`
  if (!isInsideRoot(root, joined)) throw pathError(joined, 'parent')
  return joined
}

/** 绝对路径 → 相对路径；不在 root 里返回 `null`。 */
export const relativePathOf = (root: string, absolute: string): string | null => {
  const base = normalizeForCompare(root).replace(/\/+$/u, '')
  const candidate = normalizeForCompare(absolute)
  if (candidate === base) return ''
  if (!candidate.startsWith(`${base}/`)) return null
  return candidate.slice(base.length + 1)
}

/** 相对路径的上一级（根本身返回 `''`）。 */
export const parentRelativePath = (relative: string): string => {
  if (relative.length === 0) return ''
  const segments = relative.split('/').filter((segment) => segment.length > 0)
  return segments.slice(0, -1).join('/')
}

/** 拼一级子路径：`joinRelativePath('src', 'a.ts') === 'src/a.ts'`；父为空就是子本身。 */
export const joinRelativePath = (parent: string, name: string): string => {
  const safeName = name.replace(/\\/gu, '/').replace(/^\/+/u, '')
  if (parent.length === 0) return safeName
  return `${parent.replace(/\/+$/u, '')}/${safeName}`
}

/** 相对路径的末段（面包屑最后一段）。 */
export const baseNameOf = (relative: string): string => {
  const segments = relative.split('/').filter((segment) => segment.length > 0)
  return segments[segments.length - 1] ?? ''
}

/** 大小写与分隔符都归一后的比较用路径（Windows 大小写不敏感，统一按小写比）。 */
const normalizeForCompare = (path: string): string => {
  const unified = path.replace(/\\/gu, '/')
  const collapsed = unified.replace(/\/{2,}/gu, '/')
  const trimmed = collapsed.length > 1 && collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed
  // 盘符大小写不敏感；其余 Linux 上是敏感的 —— 但这里只用于「显示层包含性」判断，
  // 放宽到小写比较只会多拒不会漏放，安全方向正确。
  return /^[A-Za-z]:\//u.test(trimmed) ? trimmed.toLowerCase() : trimmed
}

/** 显示路径 `candidate` 是否在 `root` 之内（纯字符串判定，安全方向：宁可 false）。 */
export const isInsideRoot = (root: string, candidate: string): boolean => {
  const base = normalizeForCompare(root).replace(/\/+$/u, '')
  const target = normalizeForCompare(candidate)
  return target === base || target.startsWith(`${base}/`)
}

/** 拼接时再挡一次：任何 `..` 段都不许出现在最终结果里。 */
const safetyJoin = (relative: string): string => {
  if (relative.replace(/\\/gu, '/').split('/').includes('..')) throw pathError(relative, 'parent')
  return relative
}

const pathError = (path: string, rejection: PathRejection): RemoteApiError =>
  new RemoteApiError(
    'WORKSPACE_PATH_INVALID',
    rejection === 'parent'
      ? '路径越界：工作区面板只允许访问会话工作区内的相对路径'
      : `路径不合法（${rejection}）：${path.slice(0, 120)}`,
  )

/** 参数里的 path 统一走这里：空串 → `"."`（Host 侧根目录的写法）。 */
const pathArgument = (path: string): string => {
  if (path.length === 0 || path === '.' || path === './') return '.'
  return normalizeRelativePath(path)
}

/* ────────────────────────────────────────────────────────────────────────
 * 三、列目录 / stat
 * ──────────────────────────────────────────────────────────────────────── */

/** `workspaceFiles/list` 的一行（官方 `WorkspaceDirectoryEntry`）。 */
export interface WorkspaceEntry {
  name: string
  type: 'file' | 'directory' | 'other'
  size?: number
}

/** 一层目录。 */
export interface WorkspaceListing {
  /** Host 回显的目录（相对 path，或绝对路径，取决于 Host 版本；显示用）。 */
  path: string
  entries: WorkspaceEntry[]
  /** 条目被截断（目录太大）。 */
  truncated: boolean
}

const parseEntryType = (value: unknown, name: string): WorkspaceEntry['type'] => {
  if (value === 'directory' || value === 'dir' || value === 'folder') return 'directory'
  if (value === 'file' || value === 'regular') return 'file'
  if (value === 'other' || value === 'symlink' || value === 'unknown') return 'other'
  // 没有 type 字段的老 Host：按尾部斜杠猜文件夹，其余当文件（保守：不递归展开）
  return name.endsWith('/') ? 'directory' : 'file'
}

/** 解析 `workspaceFiles/list` 的返回（容忍 `{entries}` 与裸数组两种形状）。 */
export const parseWorkspaceListing = (value: unknown, fallbackPath: string): WorkspaceListing => {
  const record = isRecord(value) ? value : {}
  const rawEntries = Array.isArray(value) ? value : Array.isArray(record.entries) ? record.entries : []
  const entries: WorkspaceEntry[] = []
  for (const raw of rawEntries) {
    if (!isRecord(raw)) continue
    const name = stringOf(raw.name)
    if (name === undefined) continue
    const size = numberOf(raw.size) ?? numberOf(raw.bytes)
    entries.push({
      name,
      type: parseEntryType(raw.type ?? raw.kind, name),
      ...(size === undefined ? {} : { size }),
    })
  }
  return {
    path: stringOf(record.path) ?? fallbackPath,
    entries,
    truncated: record.truncated === true,
  }
}

/**
 * 列一层目录：`workspaceFiles/list`（call）。
 *
 * `path` 用**相对会话工作区根**的写法，根目录传 `''` / `'.'`。
 * Host 没有这个端点时抛 `METHOD_NOT_FOUND`，调用方用 `isMissingEndpoint()` 收掉整块 UI。
 */
export const listWorkspaceFiles = async (
  target: RemoteCallTarget,
  scopeId: string,
  path = '',
  options: { timeoutMs?: number } = {},
): Promise<WorkspaceListing> => {
  const args = { workspaceFileScopeId: scopeId, path: pathArgument(path) }
  const result = await callEndpoint<unknown>(
    target,
    WorkspaceFileEndpoints.list,
    args,
    options.timeoutMs ?? READ_TIMEOUT_MS,
  )
  return parseWorkspaceListing(result, args.path)
}

/** 文件元信息（官方 `WorkspaceFileStat`）。 */
export interface WorkspaceFileStat {
  absolutePath?: string
  version?: string
  bytes?: number
}

/** 解析 `workspaceFiles/stat` 的返回。 */
export const parseWorkspaceFileStat = (value: unknown): WorkspaceFileStat => {
  const record = isRecord(value) ? value : {}
  const absolutePath = stringOf(record.absolutePath) ?? stringOf(record.path)
  const version = stringOf(record.version)
  const bytes = numberOf(record.bytes) ?? numberOf(record.size)
  return {
    ...(absolutePath === undefined ? {} : { absolutePath }),
    ...(version === undefined ? {} : { version }),
    ...(bytes === undefined ? {} : { bytes }),
  }
}

/** `workspaceFiles/stat`（call）。拿大小 / 版本，用来决定「要不要分块」。 */
export const statWorkspaceFile = async (
  target: RemoteCallTarget,
  scopeId: string,
  path: string,
  options: { timeoutMs?: number } = {},
): Promise<WorkspaceFileStat> => {
  const result = await callEndpoint<unknown>(
    target,
    WorkspaceFileEndpoints.stat,
    { workspaceFileScopeId: scopeId, path: pathArgument(path) },
    options.timeoutMs ?? READ_TIMEOUT_MS,
  )
  return parseWorkspaceFileStat(result)
}

/* ────────────────────────────────────────────────────────────────────────
 * 四、读文本（行页）
 * ──────────────────────────────────────────────────────────────────────── */

/** `workspaceFiles/read` 的一页。 */
export interface WorkspaceTextPage {
  text: string
  /** 本页第一行的行号（**从 1 起**）。 */
  offset: number
  /** 本页行数。 */
  lines: number
  eof: boolean
  absolutePath?: string
  version?: string
}

/** 解析 `workspaceFiles/read` 的返回。 */
export const parseWorkspaceTextPage = (value: unknown, fallbackOffset: number): WorkspaceTextPage => {
  const record = isRecord(value) ? value : {}
  const text = typeof record.text === 'string' ? record.text : ''
  const offset = numberOf(record.offset)
  const lines = numberOf(record.lines)
  return {
    text,
    offset: offset === undefined || offset === 0 ? fallbackOffset : offset,
    lines: lines ?? text.split('\n').length,
    eof: record.eof === true,
    ...(stringOf(record.absolutePath) === undefined ? {} : { absolutePath: stringOf(record.absolutePath) as string }),
    ...(stringOf(record.version) === undefined ? {} : { version: stringOf(record.version) as string }),
  }
}

/**
 * 读一页文本：`workspaceFiles/read`（call，行页语义）。
 *
 * 面板的主路径其实是 `readWorkspaceBytes`（按字节切 256 KiB，才能对得上任务书），
 * 这个函数是**没有 `readBytes` 的老 Host** 的退路，也是 `read` 端点的自测面。
 */
export const readWorkspaceText = async (
  target: RemoteCallTarget,
  scopeId: string,
  path: string,
  offset = 1,
  limit = TEXT_PAGE_LINES,
  options: { timeoutMs?: number } = {},
): Promise<WorkspaceTextPage> => {
  const safeOffset = Number.isFinite(offset) && offset >= 1 ? Math.floor(offset) : 1
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 5000) : TEXT_PAGE_LINES
  const result = await callEndpoint<unknown>(
    target,
    WorkspaceFileEndpoints.read,
    {
      workspaceFileScopeId: scopeId,
      path: pathArgument(path),
      range: { offset: safeOffset, limit: safeLimit },
    },
    options.timeoutMs ?? READ_TIMEOUT_MS,
  )
  return parseWorkspaceTextPage(result, safeOffset)
}

/* ────────────────────────────────────────────────────────────────────────
 * 五、读字节（分块）
 * ──────────────────────────────────────────────────────────────────────── */

/** 一块字节。 */
export interface WorkspaceByteChunk {
  data: Uint8Array
  /** 这一块在文件里的起始字节偏移（Host 回显，用于校验）。 */
  offset: number
  eof: boolean
  /** 文件总字节数（老 Host 可能不给）。 */
  totalBytes?: number
  absolutePath?: string
  version?: string
}

/** 标准 base64 → 字节。非规范输入直接抛（防止把脏数据当图片画）。 */
export const decodeBase64 = (value: string): Uint8Array => {
  let binary: string
  try {
    binary = atob(value)
  } catch {
    throw new RemoteApiError('INVALID_RESPONSE', '远端返回的 base64 数据不合法')
  }
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** 字节 → 标准 base64（分块拼接，避免 `String.fromCharCode(...大数组)` 爆栈）。 */
export const encodeBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.byteLength)))
  }
  return btoa(binary)
}

/** 拼接若干块（测试与图片预览都用它，确保总长与预期一致）。 */
export const concatBytes = (chunks: readonly Uint8Array[], totalBytes?: number): Uint8Array => {
  const total = totalBytes ?? chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return offset === total ? bytes : bytes.subarray(0, offset)
}

/** 解析 `workspaceFiles/readBytes` 的返回（`data` 可能是 base64 或已被 Gateway 还原成字节）。 */
export const parseWorkspaceByteChunk = (
  value: unknown,
  expected: { offset: number; length: number },
): WorkspaceByteChunk => {
  const record = isRecord(value) ? value : {}
  const raw = record.data
  let data: Uint8Array
  if (raw instanceof Uint8Array) {
    data = raw
  } else if (typeof raw === 'string') {
    data = decodeBase64(raw)
  } else {
    throw new RemoteApiError('INVALID_RESPONSE', '远端返回的文件分块没有 data')
  }
  if (data.byteLength > expected.length) {
    throw new RemoteApiError('INVALID_RESPONSE', '远端返回的文件分块比请求的还大')
  }
  const offset = numberOf(record.offset)
  const eof = record.eof === true
  if (!eof && data.byteLength === 0) {
    throw new RemoteApiError('INVALID_RESPONSE', '远端在文件结尾之前返回了空分块')
  }
  return {
    data,
    offset: offset ?? expected.offset,
    eof,
    ...(numberOf(record.bytes) === undefined ? {} : { totalBytes: numberOf(record.bytes) as number }),
    ...(stringOf(record.absolutePath) === undefined ? {} : { absolutePath: stringOf(record.absolutePath) as string }),
    ...(stringOf(record.version) === undefined ? {} : { version: stringOf(record.version) as string }),
  }
}

/**
 * 读一块字节：`workspaceFiles/readBytes`（call）。
 *
 * `length` 会被夹到 `MAX_READ_BYTES`（4 MiB）；`0` 或负数直接抛。
 * 调用方要读大文件就用 `readWorkspaceBytesRange()`（512 KiB 一块）。
 */
export const readWorkspaceBytes = async (
  target: RemoteCallTarget,
  scopeId: string,
  path: string,
  offset: number,
  length: number,
  options: { timeoutMs?: number } = {},
): Promise<WorkspaceByteChunk> => {
  const safeOffset = Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : 0
  if (!Number.isFinite(length) || length <= 0) {
    throw new RemoteApiError('INVALID_ARGUMENT', 'readBytes 的 length 必须是正数')
  }
  const safeLength = Math.min(Math.floor(length), MAX_READ_BYTES)
  const result = await callEndpoint<unknown>(
    target,
    WorkspaceFileEndpoints.readBytes,
    {
      workspaceFileScopeId: scopeId,
      path: pathArgument(path),
      range: { offset: safeOffset, length: safeLength },
    },
    options.timeoutMs ?? READ_TIMEOUT_MS,
  )
  return parseWorkspaceByteChunk(result, { offset: safeOffset, length: safeLength })
}

/** 顺序读一段字节的结果。 */
export interface WorkspaceBytesResult {
  data: Uint8Array
  eof: boolean
  totalBytes?: number
  version?: string
}

/**
 * 顺序读一段字节：内部按 512 KiB 一块拉，**永不**单帧超过 4 MiB。
 *
 * - `limit` 是「最多读多少」（图片预览给 8 MiB，文本预览给 256 KiB + 累加）；
 * - 到 `limit` 还没 `eof` 就停（`eof:false`，调用方可以再要下一段）；
 * - `signal` 取消后立刻停，已读到的块丢弃（不返回半截数据）。
 */
export const readWorkspaceBytesRange = async (
  target: RemoteCallTarget,
  scopeId: string,
  path: string,
  offset: number,
  limit: number,
  options: { timeoutMs?: number; signal?: AbortSignal; chunkBytes?: number } = {},
): Promise<WorkspaceBytesResult> => {
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new RemoteApiError('INVALID_ARGUMENT', 'readBytes 的 limit 必须是正数')
  }
  const chunkBytes = Math.min(Math.max(1, options.chunkBytes ?? READ_CHUNK_BYTES), MAX_READ_BYTES)
  const chunks: Uint8Array[] = []
  let read = 0
  let eof = false
  let totalBytes: number | undefined
  let version: string | undefined
  let cursor = Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : 0
  while (!eof && read < limit) {
    if (options.signal?.aborted === true) throw new RemoteApiError('RPC_ABORTED', '已取消读取')
    const want = Math.min(chunkBytes, limit - read)
    const chunk = await readWorkspaceBytes(target, scopeId, path, cursor, want, options)
    chunks.push(chunk.data)
    read += chunk.data.byteLength
    cursor += chunk.data.byteLength
    eof = chunk.eof
    if (chunk.totalBytes !== undefined) totalBytes = chunk.totalBytes
    if (chunk.version !== undefined) version = chunk.version
    // 空块 + 非 eof 已在 parse 里拒了；这里再兜一层，避免死循环
    if (chunk.data.byteLength === 0 && !eof) break
  }
  return {
    data: concatBytes(chunks, read),
    eof,
    ...(totalBytes === undefined ? {} : { totalBytes }),
    ...(version === undefined ? {} : { version }),
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * 六、文本解码 / 文件分类 / 图片 MIME
 * ──────────────────────────────────────────────────────────────────────── */

/** 判定「按文本预览」的扩展名（照官方 RN 清单裁到我们认得的那些）。 */
const TEXT_EXTENSIONS = new Set([
  'bat', 'c', 'cc', 'cfg', 'cmd', 'conf', 'cpp', 'cs', 'css', 'csv', 'cts', 'cxx',
  'fish', 'gql', 'go', 'graphql', 'h', 'hpp', 'htm', 'html', 'ini', 'java',
  'js', 'json', 'json5', 'jsonc', 'jsx', 'kt', 'kts', 'less', 'log', 'lua', 'm',
  'markdown', 'md', 'mdx', 'mjs', 'mts', 'php', 'pl', 'properties', 'ps1', 'py',
  'rb', 'rs', 'scss', 'sh', 'sql', 'svelte', 'svg', 'swift', 'tex', 'toml', 'ts',
  'tsv', 'tsx', 'txt', 'vue', 'xml', 'yaml', 'yml', 'zsh',
])

/** 没有扩展名也算文本的常见文件名。 */
const TEXT_NAMES = new Set([
  '.dockerignore', '.editorconfig', '.gitattributes', '.gitignore', '.nvmrc',
  'authors', 'changelog', 'copying', 'dockerfile', 'gemfile', 'jenkinsfile',
  'license', 'makefile', 'notice', 'procfile', 'rakefile', 'readme', 'vagrantfile',
])

/** 图片扩展名 → MIME（只放浏览器都能直接 `<img>` 的四种 + bmp/avif 这类先不给）。 */
const IMAGE_EXTENSION_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** 预览种类。`binary` 只给占位（含 PDF / Office / 压缩包）。 */
export type WorkspaceFileKind = 'text' | 'image' | 'binary'

/** 取小写扩展名（没有就 `undefined`）。 */
export const extensionOf = (name: string): string | undefined => {
  const base = name.replace(/\\/gu, '/').slice(name.replace(/\\/gu, '/').lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 && dot < base.length - 1 ? base.slice(dot + 1).toLowerCase() : undefined
}

/** 文件名 → 预览种类。 */
export const fileKindOf = (name: string): WorkspaceFileKind => {
  const extension = extensionOf(name)
  if (extension === undefined) {
    const base = name.replace(/\\/gu, '/').slice(name.replace(/\\/gu, '/').lastIndexOf('/') + 1).toLowerCase()
    return TEXT_NAMES.has(base) ? 'text' : 'binary'
  }
  if (IMAGE_EXTENSION_MIME[extension] !== undefined) return 'image'
  if (TEXT_EXTENSIONS.has(extension)) return 'text'
  return 'binary'
}

/** 嗅探图片魔术字节（`PNG / JPEG / GIF / WebP`）；认不出返回 `null`。 */
export const sniffImageMime = (bytes: Uint8Array): string | null => {
  const at = (index: number): number => bytes[index] ?? -1
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png'
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg'
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'image/gif'
  // RIFF....WEBP
  if (
    at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46
    && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50
  ) {
    return 'image/webp'
  }
  return null
}

/**
 * 图片的真实 MIME：**扩展名与内容必须一致**才算数。
 *
 * 两边不一致时返回 `null`（调用方显示「内容与扩展名不符」而不是画个破图），
 * 与官方 RN 客户端 `imagePreviewType()` 的判定方向一致（`workspace-file-preview.ts:234-254`）。
 */
export const resolveImageMime = (name: string, bytes: Uint8Array): string | null => {
  const sniffed = sniffImageMime(bytes)
  if (sniffed === null) return null
  const extension = extensionOf(name)
  if (extension === undefined) return sniffed
  const expected = IMAGE_EXTENSION_MIME[extension]
  if (expected === undefined) return null
  return expected === sniffed ? sniffed : null
}

/** 字节 → 文本（UTF-8，去掉 BOM，非法字节变 U+FFFD；不抛）。 */
export const decodeText = (bytes: Uint8Array): string => {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/* ────────────────────────────────────────────────────────────────────────
 * 七、图片预览
 * ──────────────────────────────────────────────────────────────────────── */

/** 图片预览的字节 + MIME（blob URL 由 UI 层建，读纯数据的部分留在这里）。 */
export interface WorkspaceImage {
  bytes: Uint8Array
  mimeType: string
  truncated: boolean
}

/**
 * 读一张图：先 `stat` 判大小（超过 `MAX_IMAGE_PREVIEW_BYTES` 直接拒），再分块读。
 *
 * 不建 blob URL、不碰 DOM —— 这些在 `components/remote/workspace/FilePreview.tsx`，
 * 那边负责 `URL.revokeObjectURL`（内存纪律见任务书）。
 */
export const readWorkspaceImage = async (
  target: RemoteCallTarget,
  scopeId: string,
  path: string,
  options: { timeoutMs?: number; signal?: AbortSignal; maxBytes?: number } = {},
): Promise<WorkspaceImage> => {
  const maxBytes = Math.min(options.maxBytes ?? MAX_IMAGE_PREVIEW_BYTES, MAX_READ_BYTES * 2)
  const stat = await statWorkspaceFile(target, scopeId, path, options)
  if (stat.bytes !== undefined && stat.bytes > maxBytes) {
    throw new RemoteApiError(
      'WORKSPACE_IMAGE_TOO_LARGE',
      `图片 ${stat.bytes} 字节，超过预览上限 ${maxBytes} 字节`,
    )
  }
  const range = await readWorkspaceBytesRange(target, scopeId, path, 0, maxBytes, options)
  if (range.data.byteLength === 0) {
    throw new RemoteApiError('INVALID_RESPONSE', '图片内容为空')
  }
  const mimeType = resolveImageMime(path, range.data)
  if (mimeType === null) {
    throw new RemoteApiError('WORKSPACE_IMAGE_UNSUPPORTED', '这个文件不是可预览的 PNG / JPEG / GIF / WebP')
  }
  const truncated = !range.eof || (stat.bytes !== undefined && stat.bytes > range.data.byteLength)
  if (truncated) throw new RemoteApiError('WORKSPACE_IMAGE_TOO_LARGE', '图片没有被完整读到，拒绝显示半张图')
  return { bytes: range.data, mimeType, truncated }
}

/* ────────────────────────────────────────────────────────────────────────
 * 八、变更（`workspaceFiles/changes`，可选）
 * ──────────────────────────────────────────────────────────────────────── */

/** 变更列表的宽松投影（字段随 Host 版本变，这里只挑稳定的）。 */
export interface WorkspaceChanges {
  path: string
  version?: string
  changes: Array<{ path: string; kind?: string; version?: string }>
}

export const parseWorkspaceChanges = (value: unknown, fallbackPath: string): WorkspaceChanges => {
  const record = isRecord(value) ? value : {}
  const rawList = Array.isArray(record.changes)
    ? record.changes
    : Array.isArray(record.entries) ? record.entries : []
  const changes = rawList.flatMap((raw) => {
    if (!isRecord(raw)) return []
    const path = stringOf(raw.path) ?? stringOf(raw.name)
    if (path === undefined) return []
    return [{
      path,
      ...(stringOf(raw.kind) === undefined ? {} : { kind: stringOf(raw.kind) as string }),
      ...(stringOf(raw.version) === undefined ? {} : { version: stringOf(raw.version) as string }),
    }]
  })
  return {
    path: stringOf(record.path) ?? fallbackPath,
    ...(stringOf(record.version) === undefined ? {} : { version: stringOf(record.version) as string }),
    changes,
  }
}

/**
 * 读变更：`workspaceFiles/changes`（call）。
 *
 * 本批**界面不订阅**它：一次 `list` 的成本比维护增量游标低，且老 Host 对这个端点的
 * `path` 参数做过兼容分支（input-B §2.8.1）。函数留在这里，给后续「自动刷新」用。
 */
export const readWorkspaceChanges = async (
  target: RemoteCallTarget,
  scopeId: string,
  path = '',
  options: { timeoutMs?: number } = {},
): Promise<WorkspaceChanges> => {
  const args = { workspaceFileScopeId: scopeId, path: pathArgument(path) }
  const result = await callEndpoint<unknown>(
    target,
    WorkspaceFileEndpoints.changes,
    args,
    options.timeoutMs ?? READ_TIMEOUT_MS,
  )
  return parseWorkspaceChanges(result, args.path)
}

/* ────────────────────────────────────────────────────────────────────────
 * 九、会话附件上传（`fileUploads/upload`）
 * ──────────────────────────────────────────────────────────────────────── */

/** 上传进度：编码（有真实进度）→ 单帧在飞（不定进度）→ 完成。 */
export type UploadPhase = 'encoding' | 'uploading' | 'done'

export interface UploadProgress {
  phase: UploadPhase
  /** 已处理的字节（`encoding` 阶段是已编码字节，`uploading` 阶段等于总长）。 */
  sentBytes: number
  totalBytes: number
}

/** 上传成功后的收据：`session/prompt` 的 `{type:'file',receiptId}` 用它。 */
export interface FileReceipt {
  receiptId: string
  /** Host 回显的文件行（形状随版本变，这里只挑稳定的几个）。 */
  name?: string
  bytes?: number
  mediaType?: string
}

/** 待上传的文件（浏览器侧 `File` → `Uint8Array` 由调用方做，纯数据留在这里）。 */
export interface UploadFileInput {
  name: string
  bytes: Uint8Array
  mediaType?: string
}

/** 文件名消毒：去掉路径分隔符 / 控制字符 / 首尾空白，并兜住「只剩空串」。 */
export const sanitizeUploadName = (raw: string): string => {
  const base = raw.replace(/\\/gu, '/').slice(raw.replace(/\\/gu, '/').lastIndexOf('/') + 1)
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/gu, '').replace(/^\.+/u, '').trim()
  return cleaned.length > 0 ? cleaned.slice(0, 200) : 'file'
}

/** 解析 `fileUploads/upload` 的返回。`receiptId` 缺了就是协议错误（不能假装成功）。 */
export const parseFileReceipt = (value: unknown): FileReceipt => {
  const record = isRecord(value) ? value : {}
  const receiptId = stringOf(record.receiptId)
  if (receiptId === undefined) {
    throw new RemoteApiError('INVALID_RESPONSE', 'Host 没有返回 receiptId，附件没法带进消息')
  }
  const file = isRecord(record.file) ? record.file : {}
  const name = stringOf(file.name) ?? stringOf(record.name)
  const bytes = numberOf(file.bytes) ?? numberOf(file.size)
  const mediaType = stringOf(file.mediaType) ?? stringOf(file.mimeType)
  return {
    receiptId,
    ...(name === undefined ? {} : { name }),
    ...(bytes === undefined ? {} : { bytes }),
    ...(mediaType === undefined ? {} : { mediaType }),
  }
}

/** 把一个文件编码成标准 base64；`onStep` 每 1 MiB 回调一次（真实进度）。 */
export const encodeFileBase64 = async (
  bytes: Uint8Array,
  onStep?: (done: number, total: number) => void,
): Promise<string> => {
  const step = 1024 * 1024
  if (bytes.byteLength <= step) {
    const encoded = encodeBase64(bytes)
    onStep?.(bytes.byteLength, bytes.byteLength)
    return encoded
  }
  const parts: string[] = []
  for (let offset = 0; offset < bytes.byteLength; offset += step) {
    const slice = bytes.subarray(offset, Math.min(offset + step, bytes.byteLength))
    parts.push(encodeBase64(slice))
    onStep?.(Math.min(offset + step, bytes.byteLength), bytes.byteLength)
    // 让出主线程：大文件编码别把界面卡死
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  return parts.join('')
}

/**
 * 上传一个会话附件：`fileUploads/upload`（call）→ `{receiptId, file}`。
 *
 * ```json
 * { "endpoint": "fileUploads/upload",
 *   "payload": { "args": { "agentId": "<sessionId>",
 *                          "request": { "data": "<base64>", "name": "a.png" } } } }
 * ```
 *
 * 拿到 `receiptId` 之后由 `sessionsApi.sendPrompt()` 放进
 * `content: [{type:'file', receiptId}]`（`RemotePromptAttachment` 已经是这个形状）。
 *
 * 失败一律抛 `RemoteApiError`：`UPLOAD_TOO_LARGE`（本地先拦）、`METHOD_NOT_FOUND`（Host 没有
 * 这个端点 ⇒ 整块上传 UI 收起）、其余原样上抛给界面显示可读原因。
 */
export const uploadSessionFile = async (
  target: RemoteCallTarget,
  sessionId: string,
  file: UploadFileInput,
  options: { timeoutMs?: number; onProgress?: (progress: UploadProgress) => void } = {},
): Promise<FileReceipt> => {
  const totalBytes = file.bytes.byteLength
  if (totalBytes === 0) throw new RemoteApiError('INVALID_ARGUMENT', '这个文件是空的，没法上传')
  if (totalBytes > MAX_INLINE_UPLOAD_BYTES) {
    throw new RemoteApiError(
      'UPLOAD_TOO_LARGE',
      `文件 ${(totalBytes / 1024 / 1024).toFixed(1)} MiB，超过单帧上传上限 ${MAX_INLINE_UPLOAD_BYTES / 1024 / 1024} MiB`,
    )
  }
  const name = sanitizeUploadName(file.name)
  const data = await encodeFileBase64(file.bytes, (done, total) => {
    options.onProgress?.({ phase: 'encoding', sentBytes: done, totalBytes: total })
  })
  options.onProgress?.({ phase: 'uploading', sentBytes: totalBytes, totalBytes })
  const result = await callEndpoint<unknown>(
    target,
    WorkspaceFileEndpoints.upload,
    { agentId: sessionId, request: { data, name } },
    options.timeoutMs ?? UPLOAD_TIMEOUT_MS,
  )
  const receipt = parseFileReceipt(result)
  options.onProgress?.({ phase: 'done', sentBytes: totalBytes, totalBytes })
  return receipt
}

/* ────────────────────────────────────────────────────────────────────────
 * 十、会话附件内容（`session/attachment`）—— 工具卡图片靠它
 * ──────────────────────────────────────────────────────────────────────── */

/** 读附件用的引用（`adapter.ts` 的 `ChatImage` 结构上兼容）。 */
export interface AttachmentReference {
  attachmentId?: string
  sessionId?: string
  uri?: string
  name?: string
  mediaType?: string
  bytes?: number
  width?: number
  height?: number
}

/** 读出来的附件。 */
export interface SessionAttachmentBytes {
  data: Uint8Array
  mimeType: string
  attachmentId?: string
  name?: string
}

/** 解析 `session/attachment` 的返回：`{attachment, data}`，`data` 是 base64 或字节。 */
export const parseSessionAttachment = (value: unknown, fallback: AttachmentReference): SessionAttachmentBytes => {
  const record = isRecord(value) ? value : {}
  const attachment = isRecord(record.attachment) ? record.attachment : {}
  const raw = record.data ?? record.bytes
  let data: Uint8Array
  if (raw instanceof Uint8Array) {
    data = raw
  } else if (typeof raw === 'string') {
    if (raw.length === 0) throw new RemoteApiError('INVALID_RESPONSE', 'Host 返回的附件内容为空')
    data = decodeBase64(raw)
  } else {
    throw new RemoteApiError('INVALID_RESPONSE', 'Host 返回的附件没有 data')
  }
  const declared = stringOf(attachment.mediaType)
    ?? stringOf(attachment.mimeType)
    ?? stringOf(attachment.contentType)
    ?? fallback.mediaType
  const sniffed = sniffImageMime(data)
  const mimeType = declared !== undefined && declared.startsWith('image/')
    ? declared
    : sniffed ?? declared ?? 'application/octet-stream'
  return {
    data,
    mimeType,
    ...(stringOf(attachment.attachmentId) === undefined && fallback.attachmentId === undefined
      ? {}
      : { attachmentId: stringOf(attachment.attachmentId) ?? (fallback.attachmentId as string) }),
    ...(stringOf(attachment.name) === undefined && fallback.name === undefined
      ? {}
      : { name: stringOf(attachment.name) ?? (fallback.name as string) }),
  }
}

/** 老 Host 的严格 codec 会拒掉完整引用：只认 `gateway/arguments-invalid|input-invalid` 时降级。 */
const ATTACHMENT_REFERENCE_REJECTIONS = new Set(['gateway/arguments-invalid', 'gateway/input-invalid'])

/** 一条连接的「附件完整引用是否支持」缓存（与 Dart 客户端同一策略，见 `session_api.dart:550-585`）。 */
let attachmentReferenceSupport: boolean | null = null

/** 换连接时清缓存（`RemoteChatView` 在 `activeSessionId` 变化时调用即可）。 */
export const resetAttachmentSupport = (): void => {
  attachmentReferenceSupport = null
}

/**
 * 读一个会话附件：`session/attachment`（call）。
 *
 * 参数有两种写法，**先试完整引用、被严格 codec 拒了再退回 `attachmentId`**
 * （Dart `session_api.dart:550-585` 的同款回退；只认两个明确的校验错误码，别的错直接抛）：
 *
 * ```json
 * { "request": { "sessionId": "…", "attachment": { "attachmentId": "…", "mediaType": "image/png" } } }
 * { "request": { "sessionId": "…", "attachmentId": "…" } }
 * ```
 */
export const readSessionAttachment = async (
  target: RemoteCallTarget,
  sessionId: string,
  reference: AttachmentReference | string,
  options: { timeoutMs?: number } = {},
): Promise<SessionAttachmentBytes> => {
  const ref: AttachmentReference = typeof reference === 'string' ? { attachmentId: reference } : reference
  const attachmentId = ref.attachmentId
  if (attachmentId === undefined || attachmentId.length === 0) {
    throw new RemoteApiError('INVALID_ARGUMENT', '这条附件没有 attachmentId，读不了内容')
  }
  const fullReference = {
    attachmentId,
    ...(ref.sessionId === undefined ? {} : { sessionId: ref.sessionId }),
    ...(ref.name === undefined ? {} : { name: ref.name }),
    ...(ref.mediaType === undefined ? {} : { mediaType: ref.mediaType }),
    ...(ref.bytes === undefined ? {} : { bytes: ref.bytes }),
    ...(ref.width === undefined ? {} : { width: ref.width }),
    ...(ref.height === undefined ? {} : { height: ref.height }),
  }
  const read = async (withFullReference: boolean): Promise<unknown> =>
    await callEndpoint<unknown>(
      target,
      WorkspaceFileEndpoints.attachment,
      {
        request: {
          sessionId,
          ...(withFullReference ? { attachment: fullReference } : { attachmentId }),
        },
      },
      options.timeoutMs ?? READ_TIMEOUT_MS,
    )

  let response: unknown
  if (attachmentReferenceSupport === false) {
    response = await read(false)
  } else {
    try {
      response = await read(true)
      attachmentReferenceSupport = true
    } catch (error) {
      const code = errorCodeOf(error)
      if (attachmentReferenceSupport === true || !ATTACHMENT_REFERENCE_REJECTIONS.has(code)) throw error
      response = await read(false)
      attachmentReferenceSupport = false
    }
  }
  return parseSessionAttachment(response, ref)
}

/* ────────────────────────────────────────────────────────────────────────
 * 十一、工具卡图片：`loadToolImage(item)`
 *
 * 工具/消息里的图片有两种形态（`adapter.ts` 的 `ChatImage`）：
 *   - `uri`：`data:image/png;base64,…` —— 结果块里带内联像素时才有，直接用；
 *   - `attachmentId` + `sessionId`：**持久引用**，没有像素 —— 必须走 `session/attachment`。
 *
 * 本函数就是补第二条路的：给 `components/remote/tool/**` 的封装位一个纯函数入口，
 * 内部做数据 URL 缓存（工具卡滚动时会反复渲染同一张图）。
 * ──────────────────────────────────────────────────────────────────────── */

/** 工具卡图片最多缓存几张 / 多少字节（超了就丢最旧的，避免历史长会话吃内存）。 */
const TOOL_IMAGE_CACHE_LIMIT = 24
const TOOL_IMAGE_CACHE_BYTES = 24 * 1024 * 1024

interface ToolImageCacheEntry {
  url: string
  bytes: number
}

const toolImageCache = new Map<string, ToolImageCacheEntry>()
const toolImageInflight = new Map<string, Promise<string | null>>()

/** 清缓存（换连接 / 退出远程模式时调）。 */
export const clearToolImageCache = (): void => {
  toolImageCache.clear()
  toolImageInflight.clear()
}

const rememberToolImage = (key: string, url: string, bytes: number): void => {
  toolImageCache.set(key, { url, bytes })
  let total = 0
  for (const entry of toolImageCache.values()) total += entry.bytes
  while (toolImageCache.size > TOOL_IMAGE_CACHE_LIMIT || (total > TOOL_IMAGE_CACHE_BYTES && toolImageCache.size > 1)) {
    const oldest = toolImageCache.keys().next()
    if (oldest.done === true) break
    const removed = toolImageCache.get(oldest.value)
    toolImageCache.delete(oldest.value)
    total -= removed?.bytes ?? 0
  }
}

/**
 * 工具/消息里一张图的真实内容：`uri` 直接返回，只有 `attachmentId` 时走 `session/attachment`
 * 并转成 `data:` URL。
 *
 * 返回 `null` 表示「这张图没有可显示的像素」（不是错误，工具卡画占位就行）。
 * 失败抛 `RemoteApiError`（调用方决定显示原因还是静默）。
 */
export const loadToolImage = async (
  image: AttachmentReference,
  sessionId?: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string | null> => {
  if (typeof image.uri === 'string' && image.uri.startsWith('data:')) return image.uri
  const attachmentId = image.attachmentId
  if (attachmentId === undefined || attachmentId.length === 0) return null
  const scope = sessionId ?? image.sessionId
  if (scope === undefined || scope.length === 0) return null
  const key = `${scope}:${attachmentId}`
  const cached = toolImageCache.get(key)
  if (cached !== undefined) return cached.url
  const inflight = toolImageInflight.get(key)
  if (inflight !== undefined) return await inflight
  const job = (async (): Promise<string | null> => {
    const target = lastTargetOrThrow()
    const attachment = await readSessionAttachment(target, scope, image, options)
    if (attachment.data.byteLength === 0) return null
    const url = `data:${attachment.mimeType};base64,${encodeBase64(attachment.data)}`
    rememberToolImage(key, url, attachment.data.byteLength)
    return url
  })()
  toolImageInflight.set(key, job)
  try {
    return await job
  } finally {
    toolImageInflight.delete(key)
  }
}

/**
 * 工具卡那批代码的接入点（**我不改 `components/remote/tool/**`**）。
 *
 * 约定的用法（`ToolCard.tsx` 的 `Thumbnail`，现在只读 `image.uri`）：
 *
 * ```tsx
 * const [src, setSrc] = useState(image.uri)
 * useEffect(() => {
 *   if (src !== undefined || image.attachmentId === undefined) return undefined
 *   let alive = true
 *   toolImageLoader(image, image.sessionId)
 *     .then((uri) => { if (alive && uri !== null) setSrc(uri) })
 *     .catch(() => undefined)
 *   return () => { alive = false }
 * }, [image, src])
 * ```
 *
 * `loadToolImage` 需要一条活连接：内部用 `lastRemoteTarget()`（`sessionsApi.ts` 的观察者），
 * 所以调用前必须 `phase === 'ready'`（否则抛 `REMOTE_NOT_READY`）。
 */
export const toolImageLoader = loadToolImage

const lastTargetOrThrow = (): RemoteCallTarget => {
  const target = targetForFiles()
  if (target === null) throw new RemoteApiError('REMOTE_NOT_READY', '还没连上远端主机，取不到附件内容')
  return target
}

/* ────────────────────────────────────────────────────────────────────────
 * 十二、连接目标（与 `newSessionStore.ts` 同一条纪律）
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 当前可用的连接目标（`loadToolImage` 这类「只给图、没处传 target」的入口用它）。
 *
 * 两个条件缺一不可（与 `newSessionStore.ts:286-296` 同一条纪律）：
 *   1. `phase === 'ready'` —— 否则 `lastRemoteTarget()` 可能是上一代连接的死引用；
 *   2. 那个引用存在 —— 建链后第一次业务调用之前它还是 `null`。
 *
 * 其余端点函数都**显式收 target**，只有工具卡那条路没有容器可传，才回落到这里。
 */
const targetForFiles = (): RemoteCallTarget | null => {
  if (useRemoteStore.getState().phase !== 'ready') return null
  return lastRemoteTarget()
}

/* ────────────────────────────────────────────────────────────────────────
 * 十三、能力探测
 * ──────────────────────────────────────────────────────────────────────── */

/** 一次探测的结论。 */
export type WorkspaceProbe =
  | { supported: true; listing: WorkspaceListing }
  | { supported: false; reason: string }

/**
 * 探一次「这台 Host 有没有工作区文件端点」。
 *
 * 没有专属 capability 字符串（input-B §1.4.2），只能真发一次 `list('.')`：
 *   - 成功 → `supported:true` + 顺手把根目录条目带回去（面板首屏不用再请求一次）；
 *   - `METHOD_NOT_FOUND` 之类 → `supported:false`，面板与入口按钮**整块隐藏**；
 *   - 其它错误（范围 / 权限 / 网络）→ 原样抛，由界面显示可读原因（**不能**当成「不支持」）。
 */
export const probeWorkspaceFiles = async (
  target: RemoteCallTarget,
  scopeId: string,
  options: { timeoutMs?: number } = {},
): Promise<WorkspaceProbe> => {
  try {
    const listing = await listWorkspaceFiles(target, scopeId, '', options)
    return { supported: true, listing }
  } catch (error) {
    if (isMissingEndpoint(error)) {
      return { supported: false, reason: errorCodeOf(error) || 'METHOD_NOT_FOUND' }
    }
    throw error
  }
}
