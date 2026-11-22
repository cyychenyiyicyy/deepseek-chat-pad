import { create } from 'zustand'
import {
  decodeText,
  errorCodeOf,
  fileKindOf,
  isMissingEndpoint,
  isScopeRejection,
  listWorkspaceFiles,
  readWorkspaceBytesRange,
  readWorkspaceImage,
  readWorkspaceText,
  statWorkspaceFile,
  MAX_INLINE_UPLOAD_BYTES,
  MAX_WORKSPACE_UPLOAD_BYTES,
  TEXT_PREVIEW_BYTES,
  TEXT_PREVIEW_MAX_BYTES,
  type UploadPhase,
  type WorkspaceEntry,
  type WorkspaceFileKind,
} from '../../../services/remote/filesApi.js'
import { useNewSessionStore } from '../../../services/remote/newSessionStore.js'
import { describeRemoteError, lastRemoteTarget, workspaceReferenceToken } from '../../../services/remote/sessionsApi.js'
import {
  isUploadUnavailable,
  outcomeReference,
  planUpload,
  readRemoteCapabilities,
  readRemoteTransport,
  uploadAttachment,
  uploadErrorReasonOf,
  workspaceUploadLimitBytes,
  type UploadStrategy,
  type UploadUnavailableReason,
} from '../../../services/remote/upload.js'
import { compressImageFile, isCompressibleImage } from '../../../services/remote/imageCompress.js'
import { useRemoteStore } from '../../../services/remote/store.js'

/**
 * 工作区文件面板 + 会话附件上传的**界面状态**（zustand，只在界面层用）。
 *
 * 为什么状态放在 `components/` 而不是 `services/`：任务边界里 `store.ts` 归 W2 独占、
 * 不许新增 action，而这块状态又必须跨「抽屉 / 目录树 / 预览 / 输入区附件条」共享。
 * 所以照 W1 的做法（`newSessionStore.ts` 自己一个 store），这里再起一个**纯界面** store：
 * 它只读 `useRemoteStore` / `useNewSessionStore` 的公开字段，谁也回去改。
 *
 * 三条纪律：
 *  1. **一次一目录**：`list` 只按需拉当前展开的那层（懒加载），不递归、不预取。
 *  2. **大文件不整块进内存**：文本按 256 KiB 分块累加（上限 4 MiB 封顶），
 *     图片按 `readWorkspaceBytesRange()` 的 512 KiB 分块拼，超过 8 MiB 直接拒。
 *  3. **blob URL 必须释放**：图片预览被替换 / 关闭 / 换会话时立刻 `revokeObjectURL`。
 *
 * ## 附件上传（R15：分级 + 不再拿 405 关 UI）
 *
 * 上传不再直连 `fileUploads/upload`，而是 `services/remote/upload.ts` 的 `uploadAttachment()`：
 * 先试会话附件收据，被拒（`METHOD_NOT_ALLOWED` / `METHOD_NOT_FOUND` / 405 / 旧 codec）就自动
 * 降级到 `workspace.upload.open|chunk|commit|abort`。两种结果在这张表里各占一列：
 *
 * | 通道 | 成功凭据 | 发送时怎么进消息 |
 * |---|---|---|
 * | `receipt` | `receiptId` | `{type:'file', receiptId}`（老路径） |
 * | `workspace` | `{name, path}` | 正文 `@name` 引用（`readyReceipts()` 出令牌，`sendPrompt()` 落成引用） |
 *
 * **`uploadSupported` 的三态（别再退回两态）**：
 *  - `null` = 还没试过 ⇒ 「+」照常渲染（先信任，与 `newSessionStore` 同一套）；
 *  - `true` = 至少一条通道成功过；
 *  - `false` = **两条**都明确不可用（`UPLOAD_UNAVAILABLE`）⇒ 按钮变**不可用**并带可读原因，
 *    **不是**直接不渲染 —— 静默消失正是「用户以为 + 坏了」的根因。
 */

/* ────────────────────────────────────────────────────────────────────────
 * 一、状态形状
 * ──────────────────────────────────────────────────────────────────────── */

/** 一层目录的缓存。 */
export interface DirNode {
  entries: WorkspaceEntry[]
  loaded: boolean
  loading: boolean
  error: string | null
  truncated: boolean
}

/** 文本预览（分块累加）。 */
export interface TextPreview {
  kind: 'text'
  path: string
  status: 'loading' | 'ready' | 'error'
  /** 已解码的正文（每次追加都整体重解，避免 UTF-8 多字节被分块切断）。 */
  text: string
  /** 已读到的原始字节（「加载更多」从它的长度接着读；不留就保证不了偏移正确）。 */
  bytes: Uint8Array
  /** 已读字节数（`bytes` 模式下的游标；`lines` 模式恒为 0）。 */
  bytesRead: number
  eof: boolean
  totalBytes?: number
  loadingMore: boolean
  /** `bytes` = `readBytes` 分块；`lines` = 老 Host 的 `read` 单页退路。 */
  mode: 'bytes' | 'lines'
  error?: string
}

/** 图片预览（blob URL 由这里持有并负责释放）。 */
export interface ImagePreview {
  kind: 'image'
  path: string
  status: 'loading' | 'ready' | 'error'
  url?: string
  mimeType?: string
  bytes?: number
  error?: string
}

/** 二进制占位（PDF / Office / 压缩包…）。 */
export interface BinaryPreview {
  kind: 'binary'
  path: string
  status: 'ready'
  bytes?: number
  /** 文件头一行（十六进制），让「这是二进制」有点证据。 */
  head?: string
}

export type PreviewState = TextPreview | ImagePreview | BinaryPreview

/** `openAt()` 的三种结论（见接口注释）。 */
export type OpenAtResult = 'ok' | 'missing' | 'unavailable'

/** 输入区里待发送的附件。 */
export interface DraftAttachment {
  id: string
  name: string
  size: number
  mediaType?: string
  status: 'uploading' | 'done' | 'error'
  /** 0..1（编码阶段映射到 0–0.3，真在飞/在传 0.3–0.9，完成 1）。 */
  progress: number
  phase?: UploadPhase
  /** 走的是哪条通道（R15；`undefined` = 还没成功过，界面按「上传中」显示）。 */
  strategy?: UploadStrategy
  /** `receipt` 通道的收据（发送时进 `{type:'file', receiptId}`）。 */
  receiptId?: string
  /** `workspace` 通道落盘后的路径（`./name`；发送时转成正文 `@name`）。 */
  remotePath?: string
  /** 界面直接显示的引用写法（`@a.png`），失败时为空。 */
  reference?: string
  error?: string
  /** 重试用的原始字节（失败时留着；成功后释放）。 */
  bytes?: Uint8Array
  /** 正在客户端压缩（图片），界面据此说「压缩中…」而不是干等。 */
  compressing?: boolean
  /** 压缩前的原始体积（有值 = 这张图被压过，界面可以标「已压缩 6.1MB → 1.2MB」）。 */
  compressedFrom?: number
  /** 压缩的说明（没压 / 压了也超限的原因；只进日志与 tooltip，不阻断上传）。 */
  compressionNote?: string
}

export interface WorkspacePaneState {
  /** 抽屉 / sheet 是否展开。 */
  open: boolean
  /** `false` = Host 没有工作区文件端点 ⇒ 入口按钮与抽屉**整块隐藏**。`null` = 还没探过。 */
  filesSupported: boolean | null
  /**
   * `false` = **两条**上传通道都明确不可用（`UPLOAD_UNAVAILABLE`）；`null` = 还没试过；`true` = 至少一条成功过。
   *
   * 单次失败**不再**把它置 `false`（R15）：`fileUploads/upload` 回 405 只说明那条路不认。
   */
  uploadSupported: boolean | null
  /** `uploadSupported === false` 时的可读原因（按钮 tooltip / 附件条的提示都用它）。 */
  uploadUnavailableReason: string | null
  /** 同上的稳定原因码（界面据此翻 i18n；`null` = 不是「没通道」这类失败）。 */
  uploadUnavailableCode: UploadUnavailableReason | null
  /** 会话作用域（= `workspaceFileScopeId`）。 */
  scopeId: string | null
  /** 顶部显示的工作区路径（会话工作区 / cwd；空串 = Host 没告诉我们）。 */
  rootPath: string
  rootSource: 'workspace' | 'cwd' | 'unknown'
  /** 目录缓存：key = 相对路径（根是 `''`）。 */
  nodes: Record<string, DirNode>
  /** 展开的目录。 */
  expanded: Record<string, boolean>
  /** 错误（抽屉内的整块错误条，不是每行的）。 */
  error: string | null
  /** 当前预览（`null` = 在浏览目录）。 */
  preview: PreviewState | null
  /** 输入区附件条。 */
  attachments: DraftAttachment[]
  /** 附件区的一句话错误（上传失败原因）。 */
  uploadError: string | null

  /* ── 动作 ── */
  /** 会话变化时绑定作用域（换会话要清空目录缓存与预览）。 */
  bind(sessionId: string | null): Promise<void>
  /** 重新从 `session/list` 的投影里取一次工作区路径（打开抽屉时补一次，避免显示成「未知」）。 */
  resolveRoot(): void
  openPane(): Promise<void>
  closePane(): void
  /** 重新拉一层（不传 = 根）。 */
  refresh(path?: string): Promise<void>
  toggleDir(path: string): Promise<void>
  openFile(path: string): Promise<void>
  /**
   * 「按路径打开预览」—— 交付文件面板（`artifacts/**`）点一个 chip 就走这里：
   * 抽屉自己打开、作用域自己绑、文件不存在时**返回 `'missing'`** 而不去读一个空文件。
   *
   * 返回值就是给调用方的全部结论：`ok` 已经在预览 / `missing` 文件已不存在 /
   * `unavailable` 还没连上或这台 Host 没有文件端点（调用方据此说一句人话，不自己猜）。
   */
  openAt(path: string): Promise<OpenAtResult>
  closePreview(): void
  loadMoreText(): Promise<void>
  /* ── 附件 ── */
  pickFiles(files: readonly File[]): Promise<void>
  retryAttachment(id: string): Promise<void>
  removeAttachment(id: string): void
  clearAttachments(): void
}

/* ────────────────────────────────────────────────────────────────────────
 * 二、内部工具
 * ──────────────────────────────────────────────────────────────────────── */

/** 当前可用的连接目标（`NULL` = 还没连上 / 连接换代）。 */
const targetOrNull = () => (useRemoteStore.getState().phase === 'ready' ? lastRemoteTarget() : null)

/** 会话的工作区路径：先看 `workspace/follow` 的路径，再退回行的 `cwd`。 */
const rootForSession = (sessionId: string): { path: string; source: 'workspace' | 'cwd' | 'unknown' } => {
  const { rows, workspaces } = useNewSessionStore.getState()
  const row = rows.find((item) => item.sessionId === sessionId)
  if (row?.workspaceId !== undefined) {
    const workspace = workspaces.find((item) => item.workspaceId === row.workspaceId)
    if (workspace !== undefined && workspace.path.length > 0) {
      return { path: workspace.path, source: 'workspace' }
    }
  }
  if (row?.cwd !== undefined && row.cwd.length > 0) return { path: row.cwd, source: 'cwd' }
  return { path: '', source: 'unknown' }
}

/** Host 的越界 / 权限拒绝里那几个稳定分类 → 人话（`docs/protocol.md:1294-1296`）。 */
const SCOPE_REASON_TEXT: Record<string, string> = {
  'scope-missing': '会话还没有可用工作区（Host 没定位到 cwd）',
  'authority-unavailable': 'Host 侧的文件读取通道不可用',
  'root-invalid': '会话工作区根不合法',
  'outside-root': '这个路径在会话工作区之外，Host 拒绝了',
  symlink: '这个路径是越界的符号链接，Host 拒绝了',
  'not-regular-file': '这不是一个普通文件（可能是设备或管道）',
  // 交付文件面板（`artifacts/**`）点开后最常见的失败：一句确定的话，别让人对着一行「不见了」猜
  'not-found': '文件已不存在',
  'too-large': '文件太大，Host 拒绝读出',
  io: 'Host 读文件时出错了',
}

/** 文件不存在（Host 的 `scope-rejected` + `reason: 'not-found'`）。 */
const isNotFoundError = (error: unknown): boolean => {
  if (!isScopeRejection(error)) return errorCodeOf(error) === 'not_found'
  const details = (error as { details?: Record<string, unknown> }).details
  return details?.['reason'] === 'not-found'
}

/** 把任意失败变成一句人话（中文），不改数据层的错误码。 */
export const describeFileError = (error: unknown): string => {
  if (isScopeRejection(error) && typeof error === 'object' && error !== null) {
    const details = (error as { details?: Record<string, unknown> }).details ?? {}
    const reason = typeof details.reason === 'string' ? details.reason : ''
    const text = SCOPE_REASON_TEXT[reason]
    if (text !== undefined) return text
  }
  const code = errorCodeOf(error)
  if (code === 'REMOTE_NOT_READY') return '还没连上远端主机'
  if (code === 'WORKSPACE_IMAGE_TOO_LARGE') return '图片太大，没法预览'
  if (code === 'WORKSPACE_IMAGE_UNSUPPORTED') return '这个文件不是可预览的图片'
  if (code === 'RPC_ABORTED') return '已取消'
  return describeRemoteError(error).text
}

/** 预览被替换 / 关闭时把 blob URL 还回去（内存纪律：任务书点名要求）。 */
const releasePreview = (preview: PreviewState | null): void => {
  if (preview !== null && preview.kind === 'image' && preview.url !== undefined) {
    URL.revokeObjectURL(preview.url)
  }
}

const emptyNode = (): DirNode => ({ entries: [], loaded: false, loading: false, error: null, truncated: false })

const attachmentId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

/* ────────────────────────────────────────────────────────────────────────
 * 三、store
 * ──────────────────────────────────────────────────────────────────────── */

export const useWorkspacePane = create<WorkspacePaneState>(() => ({
  open: false,
  filesSupported: null,
  uploadSupported: null,
  uploadUnavailableReason: null,
  uploadUnavailableCode: null,
  scopeId: null,
  rootPath: '',
  rootSource: 'unknown',
  nodes: {},
  expanded: {},
  error: null,
  preview: null,
  attachments: [],
  uploadError: null,

  bind: async (sessionId: string | null): Promise<void> => {
    const state = useWorkspacePane.getState()
    if (sessionId === state.scopeId) return
    // 换会话：目录缓存、预览、展开状态全丢（它们是上一个会话的工作区）
    releasePreview(state.preview)
    /*
     * 上传通道的「试过没有」**不跟着会话清**：它记在 `upload.ts` 里、按连接（target 引用）
     * 隔离，换连接自动重来。清得太勤的代价是：每换一次会话都要把一个大文件重新 base64
     * 编码一遍才发现 `fileUploads/upload` 不认（0.5.22 上必然如此）。
     */
    const root = sessionId === null ? { path: '', source: 'unknown' as const } : rootForSession(sessionId)
    useWorkspacePane.setState({
      scopeId: sessionId,
      rootPath: root.path,
      rootSource: root.source,
      nodes: {},
      expanded: {},
      preview: null,
      error: null,
      uploadError: null,
    })
    if (sessionId !== null && state.open && state.filesSupported !== false) await useWorkspacePane.getState().refresh('')
  },

  resolveRoot: (): void => {
    const scope = useWorkspacePane.getState().scopeId
    if (scope === null) return
    const root = rootForSession(scope)
    useWorkspacePane.setState({ rootPath: root.path, rootSource: root.source })
  },

  openPane: async (): Promise<void> => {
    useWorkspacePane.setState({ open: true, error: null })
    /*
     * 打开时补一次会话清单：工作区路径来自 `session/list` 行的投影（`cwd` / `workspaceId`），
     * 而用户点「工作区」之前那些行可能还没拉过。这一个调用本身有「同一条连接只拉一次」的缓存，
     * 所以在抽屉开关之间反复点不会反复请求。
     */
    await useNewSessionStore.getState().ensureWorkspaceFlags()
    useWorkspacePane.getState().resolveRoot()
    await useWorkspacePane.getState().refresh('')
  },

  closePane: (): void => {
    // 关闭抽屉 = 预览用完：图片的 blob URL 立刻还回去（再打开重新读，几十 KiB 换个内存干净）
    const state = useWorkspacePane.getState()
    releasePreview(state.preview)
    useWorkspacePane.setState({ open: false, error: null, preview: null })
  },

  refresh: async (path = ''): Promise<void> => {
    const state = useWorkspacePane.getState()
    if (state.filesSupported === false) return
    const target = targetOrNull()
    const scope = state.scopeId
    if (target === null || scope === null) {
      useWorkspacePane.setState({ error: '还没连上远端主机' })
      return
    }
    useWorkspacePane.setState((current) => ({
      nodes: { ...current.nodes, [path]: { ...(current.nodes[path] ?? emptyNode()), loading: true, error: null } },
      error: null,
    }))
    try {
      const listing = await listWorkspaceFiles(target, scope, path)
      useWorkspacePane.setState((current) => ({
        filesSupported: true,
        nodes: {
          ...current.nodes,
          [path]: {
            entries: listing.entries,
            loaded: true,
            loading: false,
            error: null,
            truncated: listing.truncated,
          },
        },
      }))
    } catch (error) {
      if (isMissingEndpoint(error)) {
        // Host 没有这个端点：整块 UI 收起来（入口按钮也跟着消失），不弹红条
        useWorkspacePane.setState({ filesSupported: false, nodes: {}, expanded: {}, preview: null })
        return
      }
      useWorkspacePane.setState((current) => ({
        nodes: {
          ...current.nodes,
          [path]: { ...(current.nodes[path] ?? emptyNode()), loading: false, error: describeFileError(error) },
        },
      }))
    }
  },

  toggleDir: async (path: string): Promise<void> => {
    const state = useWorkspacePane.getState()
    const isOpen = state.expanded[path] === true
    useWorkspacePane.setState((current) => ({
      expanded: { ...current.expanded, [path]: !isOpen },
    }))
    if (isOpen) return
    const node = useWorkspacePane.getState().nodes[path]
    if (node === undefined || (!node.loaded && !node.loading)) await useWorkspacePane.getState().refresh(path)
  },

  openFile: async (path: string): Promise<void> => {
    const state = useWorkspacePane.getState()
    const target = targetOrNull()
    const scope = state.scopeId
    if (target === null || scope === null) {
      useWorkspacePane.setState({ error: '还没连上远端主机' })
      return
    }
    releasePreview(state.preview)
    const kind: WorkspaceFileKind = fileKindOf(path)
    if (kind === 'binary') {
      // 二进制：先 stat 拿大小（拿不到就只显示占位），绝不去读正文
      useWorkspacePane.setState({ preview: { kind: 'binary', path, status: 'ready' } })
      try {
        const stat = await statWorkspaceFile(target, scope, path)
        useWorkspacePane.setState((current) => ({
          preview: current.preview !== null && current.preview.path === path && current.preview.kind === 'binary'
            ? { ...current.preview, ...(stat.bytes === undefined ? {} : { bytes: stat.bytes }) }
            : current.preview,
        }))
      } catch {
        // 拿不到大小不影响「这是二进制」的结论
      }
      return
    }
    if (kind === 'image') {
      useWorkspacePane.setState({ preview: { kind: 'image', path, status: 'loading' } })
      try {
        const image = await readWorkspaceImage(target, scope, path)
        // 只把这一张图拷进 ArrayBuffer 交 Blob，避免把整个底层缓冲（可能带别的东西）挂上去
        const buffer = image.bytes.buffer.slice(
          image.bytes.byteOffset,
          image.bytes.byteOffset + image.bytes.byteLength,
        ) as ArrayBuffer
        const url = URL.createObjectURL(new Blob([buffer], { type: image.mimeType }))
        useWorkspacePane.setState({
          preview: { kind: 'image', path, status: 'ready', url, mimeType: image.mimeType, bytes: image.bytes.byteLength },
        })
      } catch (error) {
        useWorkspacePane.setState({
          preview: { kind: 'image', path, status: 'error', error: describeFileError(error) },
        })
      }
      return
    }
    useWorkspacePane.setState({
      preview: {
        kind: 'text',
        path,
        status: 'loading',
        text: '',
        bytes: new Uint8Array(0),
        bytesRead: 0,
        eof: false,
        loadingMore: false,
        mode: 'bytes',
      },
    })
    try {
      const range = await readWorkspaceBytesRange(target, scope, path, 0, TEXT_PREVIEW_BYTES)
      useWorkspacePane.setState({
        preview: {
          kind: 'text',
          path,
          status: 'ready',
          text: decodeText(range.data),
          bytes: range.data,
          bytesRead: range.data.byteLength,
          eof: range.eof,
          loadingMore: false,
          mode: 'bytes',
          ...(range.totalBytes === undefined ? {} : { totalBytes: range.totalBytes }),
        },
      })
    } catch (error) {
      if (!isMissingEndpoint(error)) {
        useWorkspacePane.setState({
          preview: {
            kind: 'text',
            path,
            status: 'error',
            text: '',
            bytes: new Uint8Array(0),
            bytesRead: 0,
            eof: true,
            loadingMore: false,
            mode: 'bytes',
            error: describeFileError(error),
          },
        })
        return
      }
      // 老 Host 没有 `readBytes`：退回 `read` 的单页（没有「加载更多」）
      try {
        const page = await readWorkspaceText(target, scope, path)
        useWorkspacePane.setState({
          preview: {
            kind: 'text',
            path,
            status: 'ready',
            text: page.text,
            bytes: new Uint8Array(0),
            bytesRead: 0,
            eof: page.eof,
            loadingMore: false,
            mode: 'lines',
          },
        })
      } catch (fallbackError) {
        useWorkspacePane.setState({
          preview: {
            kind: 'text',
            path,
            status: 'error',
            text: '',
            bytes: new Uint8Array(0),
            bytesRead: 0,
            eof: true,
            loadingMore: false,
            mode: 'lines',
            error: describeFileError(fallbackError),
          },
        })
      }
    }
  },

  openAt: async (path: string): Promise<OpenAtResult> => {
    // 抽屉还没绑会话（例如交付文件面板挂在时间线里、`bind` 还没跑完）：先补一次作用域
    if (useWorkspacePane.getState().scopeId === null) {
      const active = useRemoteStore.getState().activeSessionId
      if (active === null) return 'unavailable'
      await useWorkspacePane.getState().bind(active)
    }
    const state = useWorkspacePane.getState()
    if (state.filesSupported === false) return 'unavailable'
    const target = targetOrNull()
    const scope = state.scopeId
    if (target === null || scope === null) return 'unavailable'
    /*
     * 先 `stat` 一次再读：`readBytes` 对不存在的文件只会回一个笼统的错误，
     * 而「文件已不存在」是这一条路径最常见的失败（模型改了名 / 用户删了）。
     * 一次 stat 换一句确定的话，比让预览停在半截加载上强。
     */
    try {
      await statWorkspaceFile(target, scope, path)
    } catch (error) {
      if (isNotFoundError(error)) return 'missing'
      // 其它错误（权限 / 太大 / 通道抽风）不在这里拦：交给 openFile 报它自己的原因
    }
    releasePreview(state.preview)
    useWorkspacePane.setState({ open: true, error: null, preview: null })
    await useWorkspacePane.getState().openFile(path)
    return 'ok'
  },

  closePreview: (): void => {
    releasePreview(useWorkspacePane.getState().preview)
    useWorkspacePane.setState({ preview: null })
  },

  loadMoreText: async (): Promise<void> => {
    const state = useWorkspacePane.getState()
    const preview = state.preview
    if (preview === null || preview.kind !== 'text' || preview.status !== 'ready') return
    if (preview.mode !== 'bytes' || preview.eof || preview.loadingMore) return
    if (preview.bytesRead >= TEXT_PREVIEW_MAX_BYTES) {
      // 封顶：不再放「加载更多」，避免把整份大文件拖进内存
      useWorkspacePane.setState({ preview: { ...preview, eof: true } })
      return
    }
    const target = targetOrNull()
    const scope = state.scopeId
    if (target === null || scope === null) return
    useWorkspacePane.setState({ preview: { ...preview, loadingMore: true } })
    try {
      const limit = Math.min(TEXT_PREVIEW_BYTES, TEXT_PREVIEW_MAX_BYTES - preview.bytesRead)
      const range = await readWorkspaceBytesRange(target, scope, preview.path, preview.bytesRead, limit)
      // 用累计的原始字节拼，再用整体重解：多字节字符被分块切断时不会出现半个字
      const merged = new Uint8Array(preview.bytes.byteLength + range.data.byteLength)
      merged.set(preview.bytes, 0)
      merged.set(range.data, preview.bytes.byteLength)
      useWorkspacePane.setState((current) => {
        const now = current.preview
        if (now === null || now.kind !== 'text' || now.path !== preview.path) return {}
        return {
          preview: {
            ...now,
            text: decodeText(merged),
            bytes: merged,
            bytesRead: merged.byteLength,
            eof: range.eof || range.data.byteLength === 0,
            loadingMore: false,
            ...(range.totalBytes === undefined ? {} : { totalBytes: range.totalBytes }),
          },
        }
      })
    } catch (error) {
      useWorkspacePane.setState((current) => {
        const now = current.preview
        if (now === null || now.kind !== 'text' || now.path !== preview.path) return {}
        return { preview: { ...now, loadingMore: false, error: describeFileError(error) } }
      })
    }
  },

  pickFiles: async (files: readonly File[]): Promise<void> => {
    if (files.length === 0) return
    // 先占位（每个文件一条「上传中」），再按顺序上传：单帧上传并发没有收益，反而抢带宽
    const queued: DraftAttachment[] = []
    const tooLarge: DraftAttachment[] = []
    for (const file of files) {
      const entry: DraftAttachment = {
        id: attachmentId(),
        name: file.name,
        size: file.size,
        ...(file.type.length === 0 ? {} : { mediaType: file.type }),
        status: 'uploading',
        progress: 0,
      }
      /*
       * 本地提前判死只对**压不了的类型**生效：图片先交给压缩（手机照片 6–15 MiB，
       * 压完通常 1–2 MiB，relay 的 20 MiB 天花板就够用了）。这里以前对图片也一刀切，
       * 于是「传张照片提示太大」——正是用户报的那个问题。
       */
      if (!isCompressibleImage(file) && uploadTooLargeHint(file.size)) {
        queued.push({ ...entry, status: 'error', error: '这个文件超过本条连接的上传上限' })
        tooLarge.push(entry)
        continue
      }
      queued.push(entry)
    }
    useWorkspacePane.setState((current) => ({
      attachments: [...current.attachments, ...queued],
      uploadError: tooLarge.length > 0 ? '有文件超过本条连接的上传上限，已标红' : null,
    }))
    for (let index = 0; index < files.length; index += 1) {
      const entry = queued[index]
      const file = files[index]
      if (entry === undefined || file === undefined) continue
      if (entry.status === 'error') continue
      await uploadOne(entry.id, file)
    }
  },

  retryAttachment: async (id: string): Promise<void> => {
    const state = useWorkspacePane.getState()
    const entry = state.attachments.find((item) => item.id === id)
    if (entry === undefined || entry.bytes === undefined) return
    const bytes = entry.bytes
    useWorkspacePane.setState((current) => ({
      attachments: current.attachments.map((item) =>
        item.id === id
          ? {
              ...item,
              status: 'uploading',
              progress: 0,
              error: undefined,
              // 上一次的凭据/通道结论全部作废：重试会重新走一遍分级链
              receiptId: undefined,
              remotePath: undefined,
              reference: undefined,
              strategy: undefined,
            }
          : item,
      ),
      uploadError: null,
    }))
    await uploadBytes(id, { name: entry.name, bytes, ...(entry.mediaType === undefined ? {} : { mediaType: entry.mediaType }) }, entry.size)
  },

  removeAttachment: (id: string): void => {
    useWorkspacePane.setState((current) => ({
      attachments: current.attachments.filter((item) => item.id !== id),
    }))
  },

  clearAttachments: (): void => {
    useWorkspacePane.setState({ attachments: [], uploadError: null })
  },
}))

/* ────────────────────────────────────────────────────────────────────────
 * 四、上传（内部）
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 进度映射：编码 0–0.3 → 真正在传 0.3–0.9（按已确认字节）→ 完成 1。
 *
 * `receipt` 通道没有字节级回执，`uploading` 那一拍 `sentBytes === totalBytes`（0.9），
 * 所以对老通道的表现与改版前一致；`workspace` 通道每一块都有 ack，进度是真的。
 */
const progressOf = (phase: UploadPhase, done: number, total: number): number => {
  if (phase === 'done') return 1
  if (total <= 0) return 0
  const ratio = Math.min(1, Math.max(0, done / total))
  if (phase === 'uploading') return 0.3 + ratio * 0.6
  return ratio * 0.3
}

const patchAttachment = (id: string, patch: Partial<DraftAttachment>): void => {
  useWorkspacePane.setState((current) => ({
    attachments: current.attachments.map((item) => (item.id === id ? { ...item, ...patch } : item)),
  }))
}

const uploadOne = async (id: string, file: File): Promise<void> => {
  let payload: Blob = file
  let name = file.name
  let mediaType = file.type
  let size = file.size
  /*
   * 图片先压再传（`imageCompress.ts` 的注释写了为什么）：
   *   - 目标体积取**工作区上限的 85%**（工作区通道是 relay 上唯一的通道，留点余量）；
   *   - 压不动 / 压了还超 → 原样上传，让上传链按原规则去试，绝不因为压缩失败而拦下文件。
   */
  if (isCompressibleImage(file)) {
    patchAttachment(id, { compressing: true, progress: 0 })
    try {
      const target = Math.floor(workspaceUploadLimitBytes(readRemoteTransport()) * 0.85)
      const result = await compressImageFile(file, target)
      if (result.compressed) {
        payload = result.blob
        name = result.name
        mediaType = result.mediaType
        size = result.bytes
        patchAttachment(id, {
          name,
          size,
          mediaType,
          compressedFrom: result.originalBytes,
          compressionNote: undefined,
        })
      } else if (result.note !== undefined) {
        patchAttachment(id, { compressionNote: result.note })
      }
    } catch {
      // 压缩是优化：任何意外都退回原图，不影响上传
    } finally {
      patchAttachment(id, { compressing: false })
    }
  }
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await payload.arrayBuffer())
  } catch {
    patchAttachment(id, { status: 'error', progress: 0, error: '读不到这个文件（本地读取失败）' })
    return
  }
  await uploadBytes(id, { name, bytes, ...(mediaType.length === 0 ? {} : { mediaType }) }, size)
}

/** 上传失败 → 一句人话（附件的错误码映射；`UPLOAD_UNAVAILABLE` 再带上原因）。 */
const describeUploadError = (error: unknown): string => {
  const code = errorCodeOf(error)
  if (code === 'UPLOAD_TOO_LARGE') {
    return error instanceof Error && error.message.length > 0
      ? error.message
      : `文件太大：这条连接的上传上限是工作区 ${MAX_WORKSPACE_UPLOAD_BYTES / 1024 / 1024} MiB / 会话附件 ${MAX_INLINE_UPLOAD_BYTES / 1024 / 1024} MiB`
  }
  if (code === 'UPLOAD_LIMIT') return 'Host 侧上传配额/并发已满（每个连接最多 2 个活动上传），稍后重试'
  if (code === 'UPLOAD_INVALID_NAME') return '文件名不被 Host 接受（含非法字符或保留名），改个名字再传'
  if (code === 'UPLOAD_WORKSPACE_UNAVAILABLE') return '这个会话没有可写的工作区目录，Host 拒绝了落盘'
  if (code === 'UPLOAD_INCOMPLETE') return '文件没有传完就被提交了，重试一次'
  if (code === 'UPLOAD_NOT_FOUND') return '这次上传在 Host 侧已经失效（可能超时被清理），重试一次'
  if (isUploadUnavailable(error)) {
    const reason = uploadErrorReasonOf(error)
    const text = error instanceof Error && error.message.length > 0 ? error.message : ''
    if (reason === 'too-large' && text.length === 0) return '文件太大，这条连接传不了'
    return text.length > 0 ? text : '这台 Host 暂时发不了附件'
  }
  return describeFileError(error)
}

/**
 * 真正的上传：交给 `upload.ts` 的分级链（收据 → 工作区），这里只管三件界面事
 * ——进度、成功凭据（`receiptId` 或 `remotePath`）、失败原因。
 *
 * **单次失败不再隐藏入口**：只有 `UPLOAD_UNAVAILABLE`（两条通道都明确不可用）才把
 * `uploadSupported` 置 `false`，并把原因写进 `uploadUnavailableReason` 供按钮/附件条显示。
 */
const uploadBytes = async (
  id: string,
  payload: { name: string; bytes: Uint8Array; mediaType?: string },
  size: number,
): Promise<void> => {
  const target = targetOrNull()
  const scope = useWorkspacePane.getState().scopeId
  if (target === null || scope === null) {
    patchAttachment(id, { status: 'error', error: '还没连上远端主机', bytes: payload.bytes })
    return
  }
  patchAttachment(id, { bytes: payload.bytes, size })
  try {
    const outcome = await uploadAttachment(target, scope, payload, {
      onProgress: (progress) => {
        patchAttachment(id, {
          progress: progressOf(progress.phase, progress.sentBytes, progress.totalBytes),
          phase: progress.phase,
          strategy: progress.strategy,
        })
      },
    })
    const reference = outcomeReference(outcome)
    const done: Partial<DraftAttachment> = {
      status: 'done',
      progress: 1,
      strategy: outcome.strategy,
      bytes: undefined,
      error: undefined,
      ...(outcome.strategy === 'receipt'
        ? { receiptId: outcome.receiptId, remotePath: undefined, reference: undefined }
        : { remotePath: outcome.path, receiptId: undefined, ...(reference === null ? {} : { reference }) }),
      ...(outcome.name === undefined ? {} : { name: outcome.name }),
    }
    useWorkspacePane.setState((current) => ({
      uploadSupported: true,
      uploadUnavailableReason: null,
      uploadUnavailableCode: null,
      uploadError: null,
      attachments: current.attachments.map((item) => (item.id === id ? { ...item, ...done } : item)),
    }))
  } catch (error) {
    if (isUploadUnavailable(error)) {
      // 两条通道都不可用：把「+」标成不可用并给出原因（不静默消失）
      const reason = describeUploadError(error)
      useWorkspacePane.setState({
        uploadSupported: false,
        uploadUnavailableReason: reason,
        uploadUnavailableCode: uploadErrorReasonOf(error) ?? 'both-unavailable',
        uploadError: reason,
        attachments: useWorkspacePane.getState().attachments.filter((item) => item.id !== id),
      })
      return
    }
    const text = describeUploadError(error)
    useWorkspacePane.setState({ uploadError: text })
    patchAttachment(id, { status: 'error', progress: 0, error: text, bytes: payload.bytes })
  }
}

/** 已上传成功、可以带进 `session/prompt` 的凭据（收据 id 或工作区引用令牌）。 */
export const readyReceipts = (attachments: readonly DraftAttachment[]): string[] =>
  attachments.flatMap((item) => {
    if (item.status !== 'done') return []
    if (item.receiptId !== undefined) return [item.receiptId]
    // 工作区通道没有收据：用引用令牌穿过附件数组，由 `sendPrompt()` 落成正文 `@name`
    if (item.remotePath !== undefined) return [workspaceReferenceToken(item.remotePath)]
    return []
  })

/** 还有附件在传（发送按钮要等它们）。 */
export const hasUploadingAttachment = (attachments: readonly DraftAttachment[]): boolean =>
  attachments.some((item) => item.status === 'uploading')

/** 这次选择里最坏的那个文件会不会超过上限（给 `pickFiles` 做本地提示用；不发网络）。 */
export const uploadTooLargeHint = (size: number, transport: string = readRemoteTransport()): boolean => {
  const plan = planUpload({ bytes: size, capabilities: readRemoteCapabilities(), transport })
  return plan.order.length === 0 && plan.reason === 'too-large'
}

/** 当前连接上工作区上传的上限（界面提示用）。 */
export const currentWorkspaceUploadLimit = (): number => workspaceUploadLimitBytes(readRemoteTransport())
