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
  uploadSessionFile,
  TEXT_PREVIEW_BYTES,
  TEXT_PREVIEW_MAX_BYTES,
  type UploadPhase,
  type WorkspaceEntry,
  type WorkspaceFileKind,
} from '../../../services/remote/filesApi.js'
import { useNewSessionStore } from '../../../services/remote/newSessionStore.js'
import { describeRemoteError, lastRemoteTarget } from '../../../services/remote/sessionsApi.js'
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

/** 输入区里待发送的附件。 */
export interface DraftAttachment {
  id: string
  name: string
  size: number
  mediaType?: string
  status: 'uploading' | 'done' | 'error'
  /** 0..1（编码阶段映射到 0–0.7，单帧在飞 0.9，完成 1）。 */
  progress: number
  phase?: UploadPhase
  receiptId?: string
  error?: string
  /** 重试用的原始字节（失败时留着；成功后释放）。 */
  bytes?: Uint8Array
}

export interface WorkspacePaneState {
  /** 抽屉 / sheet 是否展开。 */
  open: boolean
  /** `false` = Host 没有工作区文件端点 ⇒ 入口按钮与抽屉**整块隐藏**。`null` = 还没探过。 */
  filesSupported: boolean | null
  /** `false` = Host 没有 `fileUploads/upload` ⇒ 输入区「+」隐藏。`null` = 还没试过。 */
  uploadSupported: boolean | null
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
  'not-found': '这个文件或目录不见了',
  'too-large': '文件太大，Host 拒绝读出',
  io: 'Host 读文件时出错了',
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
    const root = sessionId === null ? { path: '', source: 'unknown' as const } : rootForSession(sessionId)
    useWorkspacePane.setState({
      scopeId: sessionId,
      rootPath: root.path,
      rootSource: root.source,
      nodes: {},
      expanded: {},
      preview: null,
      error: null,
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
    for (const file of files) {
      queued.push({
        id: attachmentId(),
        name: file.name,
        size: file.size,
        ...(file.type.length === 0 ? {} : { mediaType: file.type }),
        status: 'uploading',
        progress: 0,
      })
    }
    useWorkspacePane.setState((current) => ({
      attachments: [...current.attachments, ...queued],
      uploadError: null,
    }))
    for (let index = 0; index < files.length; index += 1) {
      const entry = queued[index]
      const file = files[index]
      if (entry === undefined || file === undefined) continue
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
        item.id === id ? { ...item, status: 'uploading', progress: 0, error: undefined } : item,
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

/** 单帧上传：编码阶段映射到 0–0.7，单帧在飞 0.9，完成 1。 */
const progressOf = (phase: UploadPhase, done: number, total: number): number => {
  if (phase === 'done') return 1
  if (phase === 'uploading') return 0.9
  if (total <= 0) return 0
  return Math.min(0.7, (done / total) * 0.7)
}

const patchAttachment = (id: string, patch: Partial<DraftAttachment>): void => {
  useWorkspacePane.setState((current) => ({
    attachments: current.attachments.map((item) => (item.id === id ? { ...item, ...patch } : item)),
  }))
}

const uploadOne = async (id: string, file: File): Promise<void> => {
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await file.arrayBuffer())
  } catch {
    patchAttachment(id, { status: 'error', progress: 0, error: '读不到这个文件（本地读取失败）' })
    return
  }
  await uploadBytes(
    id,
    { name: file.name, bytes, ...(file.type.length === 0 ? {} : { mediaType: file.type }) },
    file.size,
  )
}

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
    const receipt = await uploadSessionFile(target, scope, payload, {
      onProgress: (progress) => {
        patchAttachment(id, {
          progress: progressOf(progress.phase, progress.sentBytes, progress.totalBytes),
          phase: progress.phase,
        })
      },
    })
    useWorkspacePane.setState((current) => ({
      uploadSupported: true,
      attachments: current.attachments.map((item) =>
        item.id === id
          ? { ...item, status: 'done', progress: 1, receiptId: receipt.receiptId, bytes: undefined, error: undefined }
          : item,
      ),
    }))
  } catch (error) {
    if (isMissingEndpoint(error)) {
      // Host 没有 `fileUploads/upload`：收起「+」按钮，并把这条标成不可用
      useWorkspacePane.setState({
        uploadSupported: false,
        uploadError: '这台 Host 不支持会话附件上传',
        attachments: useWorkspacePane.getState().attachments.filter((item) => item.id !== id),
      })
      return
    }
    const text = describeFileError(error)
    useWorkspacePane.setState({ uploadError: text })
    patchAttachment(id, { status: 'error', progress: 0, error: text, bytes: payload.bytes })
  }
}

/** 已上传成功、可以带进 `session/prompt` 的收据。 */
export const readyReceipts = (attachments: readonly DraftAttachment[]): string[] =>
  attachments.flatMap((item) => (item.status === 'done' && item.receiptId !== undefined ? [item.receiptId] : []))

/** 还有附件在传（发送按钮要等它们）。 */
export const hasUploadingAttachment = (attachments: readonly DraftAttachment[]): boolean =>
  attachments.some((item) => item.status === 'uploading')
