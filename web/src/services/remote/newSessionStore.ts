/**
 * **新建会话 / 工作区 / 会话管理**的独立 zustand 数据层（W1）。
 *
 * ```
 *  new-session/**  ──►  useNewSessionStore  ──►  sessionsApi.ts  ──►  harness.remote.call
 *                              │                     ▲
 *                              └──► useRemoteStore.getState()（只读：phase / sessions / openSession）
 * ```
 *
 * ## 为什么要另起一个 store
 *
 * `store.ts` 由 W2 独占（它要加会话内控制的状态），而这一批（新建会话面板、工作区、
 * 归档 / 置顶 / 改名 / 派生 / 搜索）的状态与它几乎没有交集：面板开没开、选了哪个工作区、
 * 目录浏览到哪，都不该让整个远程页重渲染。两个 store 只通过**只读**接口耦合：
 *
 * - 连接是否可用：`useRemoteStore.getState().phase === 'ready'`；
 * - 拿连接对象：`sessionsApi.lastRemoteTarget()`（调用观察者，见那边的注释）；
 * - 建完会话：`useRemoteStore.getState().openSession(id)` 真正进会话。
 *
 * ## 工作区列表从哪来（这批唯一的妥协，必须写清楚）
 *
 * 官方拿工作区列表只有一条路：`workspace/follow` 是个 **stream**，读首帧 `baseline`。
 * 流的帧只从 `core/rpcMux.ts` 的**连接级** `onStreamEvent` 出来，而那个回调是 `store.ts`
 * 建链时固定的（它按 `streamId` 路由到自己私有的 `sinks` 表）。本批不许改 `store.ts` /
 * `core/**`，所以外部打不开第二条流的接收端 —— 这是本文件唯一的功能降级。
 *
 * 处理方式：
 *   1. `sessionsApi.openWorkspaceFollow` / `parseWorkspaceBaseline` 已按协议写好并自测覆盖，
 *      只等有人把帧递进来；
 *   2. `registerWorkspaceBaselineReader()` 是给那一步留的**扩展点**：谁来提供「读 baseline」的
 *      实现（W2 给 store.ts 加通用 sink，或 store.ts 加一行 additive export），注入即可，
 *      本文件其余部分一行都不用改；
 *   3. 没有 reader 时退回**派生列表**：用 `session/list` 每行的 `workspaceId` + `cwd` 归并出
 *      工作区（路径取最近一条会话的 `cwd`，标题取路径末段），外加本次 `workspace/create`
 *      刚建出来的那几个。代价：**没有任何会话的工作区不会出现在下拉里**。
 *
 * 「归档 / 置顶」的初值同理：全集只有 `workspace/follow` 给，所以初值取自 `session/list` 行上的
 * `pinned` 投影与本代连接里 RPC 的返回值；一旦某个 RPC 给过权威全集，就以它为准
 * （`workspace/archiveSession` 等返回的都是**整套 id 列表**）。
 *
 * ## 三条纪律
 *
 * 1. **能力门禁，不弹窗**：`workspace/*`、`session/create`、`directoryPicker/list`、
 *    `permissionPresets/catalog`、`agentPresets/list`、`session/search` 任一拿不到
 *    （版本差异 / 索引未开 / 被 allowlist 剔除），对应 UI 直接隐藏，面板里只留一行静态说明。
 * 2. **搜索一定有线可退**：远端搜索索引默认关闭（Host 侧 `openAt: never`，失败是
 *    `gateway/internal`），一失败就切本地按标题过滤，并把 `capabilities.search` 标 false。
 * 3. **不吞 mutation 的结论**：归档 / 置顶 / 改名 / 派生以 Host 返回为准覆盖本地，失败写
 *    `actionError`（列表里一行红字，不弹窗），成功则补一次 `refreshSessions()`。
 *
 * 端点与字段依据：`sessionsApi.ts` 头部表格、`input-B-rpc-surface.md` §2.1/§2.2/§2.4/§2.8/§2.10。
 */

import { create } from 'zustand'

import {
  applyPermissionPreset,
  archiveSession,
  createSession,
  createWorkspace,
  describeRemoteError,
  fetchAgentPresets,
  fetchDefaultModel,
  fetchPermissionCatalog,
  forkSession,
  lastRemoteTarget,
  listDirectory,
  listSessions,
  normalizeWorkspacePath,
  openWorkspaceFollow,
  pinSession,
  renameSession,
  searchSessions,
  unarchiveSession,
  unpinSession,
  type RemoteAgentPreset,
  type RemoteCallTarget,
  type RemoteDirectoryListing,
  type RemoteModelSelection,
  type RemotePermissionOption,
  type RemoteSearchHit,
  type RemoteSessionRow,
  type RemoteWorkspace,
  type RemoteWorkspaceList,
} from './sessionsApi.js'
import { useRemoteStore } from './store.js'

/* ────────────────────────────────────────────────────────────────────────
 * 一、对外形状
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 这台 Host 在**这一代连接**上支持哪些能力。
 *
 * 初值「先信任、失败即关」：只有真的收到 `METHOD_NOT_FOUND` / `METHOD_NOT_ALLOWED` /
 * `CAPABILITY_NOT_SUPPORTED` 才关掉。按版本号猜能力是协议明令禁止的
 * （`docs/protocol.md:930-935`、input-B §1.4.1）。
 */
export interface NewSessionCapabilities {
  /** 工作区列表可用（下拉、归档、置顶都依赖它）。 */
  workspace: boolean
  /** `session/create` 可用。 */
  create: boolean
  /** `directoryPicker/list` 可用（「浏览目录」）。 */
  directory: boolean
  /** 权限预设可用（`permissionPresets/catalog` + `commands/execute`）。 */
  permission: boolean
  /** agent preset 可用（`agentPresets/list`）。 */
  agentPreset: boolean
  /** 远端 `session/search` 可用（false ⇒ 本地按标题过滤）。 */
  search: boolean
  /** 会话管理可用（`session/rename|fork`、`workspace/*Session` 这一组）。 */
  manage: boolean
}

const CAPABILITIES_OFF: NewSessionCapabilities = {
  workspace: false,
  create: false,
  directory: false,
  permission: false,
  agentPreset: false,
  search: false,
  manage: false,
}

const CAPABILITIES_ON: NewSessionCapabilities = {
  workspace: true,
  create: true,
  directory: true,
  permission: true,
  agentPreset: true,
  search: true,
  manage: true,
}

/** 工作区列表的来源（`derived` 时「没有会话的工作区」列不出来，见文件头）。 */
export type WorkspaceSource = 'follow' | 'derived'

export interface NewSessionSearchState {
  query: string
  searching: boolean
  /** 命中的结果；`null` = 还没搜过。 */
  hits: RemoteSearchHit[] | null
  /** 命中来自本地过滤（远端搜索不可用）。 */
  local: boolean
}

export interface RenameTarget {
  sessionId: string
  title: string
}

/** 会话列表一行的最小投影（`session/list` 的行都能折成它）。 */
export interface SessionListRow {
  id: string
  title?: string
  workspaceId?: string
  cwd?: string
  updatedAt?: number
  pinned?: boolean
  parentSessionId?: string
  origin?: string
}

export interface NewSessionState {
  /** 面板是否展开。 */
  open: boolean
  /** 首轮加载中（工作区 / 预设）。 */
  loading: boolean
  /** 面板级错误（中文，显示在面板里，不弹窗）。 */
  error: string | null
  /** 非致命提醒（例如「会话建好了但权限预设没生效」）。 */
  notice: string | null
  capabilities: NewSessionCapabilities

  workspaces: RemoteWorkspace[]
  workspaceSource: WorkspaceSource
  /** 最近一次 `session/list` 的原始行（本地搜索与派生工作区都用它）。 */
  rows: RemoteSessionRow[]
  archivedSessionIds: string[]
  pinnedSessionIds: string[]
  /** 选中的工作区；`null` = 让 Host 用它自己的 cwd。 */
  selectedWorkspaceId: string | null

  permissionOptions: RemotePermissionOption[]
  permissionDefault: string
  /** 选中的权限预设；空串 = 不额外设置（沿用 Host 默认）。 */
  selectedPermission: string
  /** 这一代连接上权限目录是否已经问过。 */
  permissionLoaded: boolean

  agentPresets: RemoteAgentPreset[]
  /** 选中的 agent preset；空串 = 继承 Host 默认。 */
  selectedAgentPreset: string
  /** 这一代连接上 agent preset 名册是否已经问过。 */
  agentPresetsLoaded: boolean

  /** Host 默认模型（**只读展示**；模型切换归 W2）。 */
  defaultModel: RemoteModelSelection | null

  creating: boolean
  /** 刚建出来的会话 id（成功后打开它；自测也断言这个）。 */
  lastCreatedSessionId: string | null

  /* ── 新建工作区（路径表单 + 目录浏览） ── */
  pathFormOpen: boolean
  pathDraft: string
  pathError: string | null
  directory: RemoteDirectoryListing | null
  directoryLoading: boolean
  directoryError: string | null

  /* ── 会话列表条目操作 ── */
  menuSessionId: string | null
  renameTarget: RenameTarget | null
  busySessionId: string | null
  actionError: string | null

  search: NewSessionSearchState

  /* ── 动作 ── */
  openPanel(): void
  closePanel(): void
  /** 面板打开时的一次性加载（工作区 + 预设 + 默认模型）。 */
  refresh(): Promise<void>
  /** 只刷「会话清单 + 工作区/标记」，列表挂载时静默调用（不拉预设）。 */
  ensureWorkspaceFlags(): Promise<void>
  /**
   * 连接就绪后**探测能力**：等第一帧业务调用把连接对象记下来（`lastRemoteTarget()`），
   * 再走一遍 `refresh()`。空态里的「新建会话」按钮要靠它才知道能不能显示。
   */
  probeCapabilities(): Promise<void>
  selectWorkspace(workspaceId: string | null): void
  selectPermission(preset: string): void
  selectAgentPreset(preset: string): void
  togglePathForm(open?: boolean): void
  setPathDraft(path: string): void
  /** 浏览一层目录（不传 `path` = 家目录）。Host 不支持就把浏览关掉（能力门禁）。 */
  browse(path?: string): Promise<void>
  /** 把路径表单里的路径注册成工作区；成功返回新工作区。 */
  submitWorkspacePath(): Promise<RemoteWorkspace | null>
  /** 目录浏览器里点「用这个目录」：填进表单并顺手注册。 */
  adoptBrowsedDirectory(path: string): Promise<RemoteWorkspace | null>
  /** 「创建并进入」：`session/create` →（必要时）`/permission <preset>` → `openSession(id)`。 */
  createAndOpen(): Promise<string | null>
  /** 搜会话：先试远端 `session/search`，不可用就本地按标题过滤。 */
  runSearch(query: string): Promise<void>
  clearSearch(): void
  setMenu(sessionId: string | null): void
  beginRename(sessionId: string, title: string): void
  updateRenameDraft(title: string): void
  cancelRename(): void
  commitRename(): Promise<void>
  /** 置顶 / 取消置顶（按当前 `pinnedSessionIds` 自动判断方向）。 */
  togglePin(sessionId: string): Promise<void>
  /** 归档 / 取消归档（按当前 `archivedSessionIds` 自动判断方向）。 */
  toggleArchive(sessionId: string): Promise<void>
  fork(sessionId: string): Promise<void>
}

/* ────────────────────────────────────────────────────────────────────────
 * 二、内部工具
 * ──────────────────────────────────────────────────────────────────────── */

/** 「这台 Host 没有这个端点」——能力门禁只看这几个码。 */
const MISSING_ENDPOINT_CODES = new Set([
  'METHOD_NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'CAPABILITY_NOT_SUPPORTED',
  'UNSUPPORTED',
  'FEATURE_NOT_SUPPORTED',
])

const codeOf = (error: unknown): string => {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code.length > 0) return code
  }
  return ''
}

const isMissingEndpoint = (error: unknown): boolean => MISSING_ENDPOINT_CODES.has(codeOf(error))

const errorText = (error: unknown): string => describeRemoteError(error).text

/**
 * 取当前可用的连接目标。
 *
 * 两个条件缺一不可：
 *   1. `phase === 'ready'`（否则 `lastRemoteTarget()` 可能是上一代连接的死引用）；
 *   2. 那个引用存在（建链后第一次业务调用之前它还是 `null`）。
 */
const targetFor = (): RemoteCallTarget | null => {
  if (useRemoteStore.getState().phase !== 'ready') return null
  return lastRemoteTarget()
}

/* ── 单飞 / 代际（模块级：不进 zustand，避免无谓重渲染） ── */

/** 当前这批数据属于哪一条连接（换了连接就要重来）。 */
let inventoryTarget: RemoteCallTarget | null = null
/** `refresh()` 单飞。 */
let refreshInFlight: Promise<void> | null = null
/** 搜索请求序号：慢的旧请求不许覆盖新结果。 */
let searchSeq = 0
/** 置顶全集是否已经由 RPC 给过（给过就不再从 `session/list` 猜）。 */
let pinnedAuthoritative = false

/**
 * `workspace/follow` 的读取器扩展点。
 *
 * 谁能让某条流的帧落进自己的回调，谁就能把它注册进来（当前没人注册，所以走派生列表）。
 * 契约：读**首帧** `{type:'baseline', value}` 后立即关流；解析失败返回 `null`。
 */
export type WorkspaceBaselineReader = (target: RemoteCallTarget) => Promise<RemoteWorkspaceList | null>

let workspaceBaselineReader: WorkspaceBaselineReader | null = null

/** 注入 / 卸载「读 workspace/follow baseline」的实现（不传 = 退回派生列表）。 */
export const registerWorkspaceBaselineReader = (reader: WorkspaceBaselineReader | null): void => {
  workspaceBaselineReader = reader
}

/**
 * 读 `workspace/follow` 的 baseline。
 *
 * 没有注入 reader 时只做**能力探测**：开流成功后立刻关流（帧由 `store.ts` 的连接级回调
 * 消费，这里拿不到内容），并返回 `null` 让上层走派生列表。开流失败则原样抛出，
 * 由 `loadInventory` 判定是不是「没有这个端点」。
 */
const probeWorkspaceStream = async (target: RemoteCallTarget): Promise<RemoteWorkspaceList | null> => {
  if (workspaceBaselineReader !== null) return await workspaceBaselineReader(target)
  const handle = await openWorkspaceFollow(target)
  // 每连接最多 16 条 stream（input-B §2.0）：这里只是探测，别白占名额。
  await Promise.resolve(handle.close()).catch(() => undefined)
  return null
}

/** `path` → 显示标题（POSIX / Windows 都认），与 dsh-Go 的 `workspaceTitle()` 同一规则。 */
export const workspaceTitleFromPath = (path: string): string => {
  const parts = path.split(/[\\/]+/).filter((part) => part.length > 0)
  if (parts.length === 0) return path
  const last = parts[parts.length - 1]
  return last === undefined || last.length === 0 ? path : last
}

/**
 * 从 `session/list` 的行**派生**工作区列表（没有 `workspace/follow` 时的退路）。
 *
 * 规则：
 *   - 按 `workspaceId` 归组，只认有 `workspaceId` 的行（子会话先剔掉）；
 *   - `path` 取组内 `updatedAt` 最新那一行的 `cwd`（Host 把工作区路径落在会话 cwd 上）；
 *   - `title` 取路径末段（官方也是「标题为空就显示文件夹名」，见 dsh-Go `workspaceTitle`）；
 *   - `sessionIds` 按 `updatedAt` 倒序。
 *
 * 已知代价：没有任何会话的工作区列不出来（文件头与报告里都写了）。
 */
export const deriveWorkspacesFromSessions = (rows: readonly RemoteSessionRow[]): RemoteWorkspace[] => {
  const groups = new Map<string, RemoteSessionRow[]>()
  for (const row of rows) {
    if (row.workspaceId === undefined || row.workspaceId.length === 0) continue
    if (row.parentSessionId !== undefined || row.origin === 'subagent') continue
    const list = groups.get(row.workspaceId)
    if (list === undefined) groups.set(row.workspaceId, [row])
    else list.push(row)
  }
  const workspaces: RemoteWorkspace[] = []
  for (const [workspaceId, group] of groups) {
    const sorted = [...group].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    const latest = sorted[0]
    const path = latest?.cwd ?? ''
    workspaces.push({
      workspaceId,
      path,
      title: path.length > 0 ? workspaceTitleFromPath(path) : workspaceId,
      sessionIds: sorted.map((row) => row.sessionId),
    })
  }
  return workspaces.sort((a, b) => a.title.localeCompare(b.title))
}

/** 把 API 的行折成列表用的最小投影（搜索 / 归档判断共用）。 */
export const toSessionListRow = (row: RemoteSessionRow): SessionListRow => ({
  id: row.sessionId,
  ...(row.title === undefined ? {} : { title: row.title }),
  ...(row.workspaceId === undefined ? {} : { workspaceId: row.workspaceId }),
  ...(row.cwd === undefined ? {} : { cwd: row.cwd }),
  ...(row.updatedAt === undefined ? {} : { updatedAt: row.updatedAt }),
  ...(row.pinned === undefined ? {} : { pinned: row.pinned }),
  ...(row.parentSessionId === undefined ? {} : { parentSessionId: row.parentSessionId }),
  ...(row.origin === undefined ? {} : { origin: row.origin }),
})

/**
 * **本地搜索回退**：远端 `session/search` 不可用时只按标题 / 会话 id 做包含匹配。
 *
 * 为什么不做「正文搜索」：本地根本没有远端正文（远程会话不落盘，见 `store.ts` 纪律），
 * 假造一个正文搜索会让人以为搜过全部历史。返回形状与远端命中一致，UI 不用分叉。
 */
export const filterSessionsLocally = (
  rows: readonly SessionListRow[],
  query: string,
): RemoteSearchHit[] => {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return []
  return rows
    .filter((row) => row.parentSessionId === undefined && row.origin !== 'subagent')
    .filter((row) => {
      const title = (row.title ?? '').toLowerCase()
      return title.includes(needle) || row.id.toLowerCase().includes(needle)
    })
    .map((row) => ({ sessionId: row.id, snippet: row.title ?? '' }))
}

/** 会话列表变了（新建 / 归档 / 置顶 / 改名）之后补一次远端列表。 */
const refreshRemoteSessions = (): void => {
  void Promise.resolve(useRemoteStore.getState().refreshSessions()).catch(() => undefined)
}

/**
 * 会话管理类动作（改名 / 置顶 / 归档 / 派生）失败时的统一收尾。
 *
 * 两种失败分开处理：**没有这个端点** ⇒ 把 `manage` 关掉（列表里的「⋯」整块消失）；
 * 其它失败（网络、Host 拒绝）⇒ 只留一行 `actionError`，能力保持不变。
 */
const manageFailed = (error: unknown): void => {
  const missing = isMissingEndpoint(error)
  useNewSessionStore.setState({
    busySessionId: null,
    actionError: errorText(error),
    ...(missing ? { capabilities: { ...useNewSessionStore.getState().capabilities, manage: false } } : {}),
  })
}

const initialSearch: NewSessionSearchState = { query: '', searching: false, hits: null, local: false }

const INITIAL_STATE = {
  open: false,
  loading: false,
  error: null,
  notice: null,
  capabilities: CAPABILITIES_OFF,
  workspaces: [] as RemoteWorkspace[],
  workspaceSource: 'derived' as WorkspaceSource,
  rows: [] as RemoteSessionRow[],
  archivedSessionIds: [] as string[],
  pinnedSessionIds: [] as string[],
  selectedWorkspaceId: null,
  permissionOptions: [] as RemotePermissionOption[],
  permissionDefault: '',
  selectedPermission: '',
  permissionLoaded: false,
  agentPresets: [] as RemoteAgentPreset[],
  selectedAgentPreset: '',
  agentPresetsLoaded: false,
  defaultModel: null,
  creating: false,
  lastCreatedSessionId: null,
  pathFormOpen: false,
  pathDraft: '',
  pathError: null,
  directory: null,
  directoryLoading: false,
  directoryError: null,
  menuSessionId: null,
  renameTarget: null,
  busySessionId: null,
  actionError: null,
  search: initialSearch,
}

/* ────────────────────────────────────────────────────────────────────────
 * 三、加载（清单 / 工作区 / 预设）
 * ──────────────────────────────────────────────────────────────────────── */

/** 合并：本次 `workspace/create` 建出来的工作区不能被派生结果覆盖掉。 */
const mergeWorkspaces = (
  current: readonly RemoteWorkspace[],
  derived: readonly RemoteWorkspace[],
): RemoteWorkspace[] => {
  const byId = new Map<string, RemoteWorkspace>()
  for (const workspace of derived) byId.set(workspace.workspaceId, workspace)
  for (const workspace of current) {
    const existing = byId.get(workspace.workspaceId)
    // 已有的更完整（有 path / title）就用已有的：派生出来的可能只有 workspaceId。
    if (existing === undefined) byId.set(workspace.workspaceId, workspace)
    else if (existing.path.length === 0 && workspace.path.length > 0) byId.set(workspace.workspaceId, workspace)
  }
  return [...byId.values()].sort((a, b) => a.title.localeCompare(b.title))
}

/**
 * 拉会话清单，并据此刷新工作区（有 reader 就用 `workspace/follow`，没有就派生）。
 *
 * 一次 `session/list` 顺带解决三件事：本地搜索的语料、派生工作区、置顶初值。
 */
const loadInventory = async (target: RemoteCallTarget): Promise<void> => {
  if (inventoryTarget !== target) {
    inventoryTarget = target
    pinnedAuthoritative = false
    useNewSessionStore.setState({
      capabilities: CAPABILITIES_ON,
      workspaces: [],
      workspaceSource: 'derived',
      rows: [],
      archivedSessionIds: [],
      pinnedSessionIds: [],
      selectedWorkspaceId: null,
      permissionOptions: [],
      permissionDefault: '',
      permissionLoaded: false,
      agentPresets: [],
      agentPresetsLoaded: false,
      defaultModel: null,
      error: null,
    })
  }

  const rows = await listSessions(target)
  const state = useNewSessionStore.getState()
  const patch: Partial<NewSessionState> = {
    rows,
    capabilities: { ...state.capabilities, workspace: true },
  }
  if (!pinnedAuthoritative) {
    patch.pinnedSessionIds = rows.filter((row) => row.pinned === true).map((row) => row.sessionId)
  }

  // 工作区：优先 workspace/follow 的 baseline，拿不到就派生（见文件头）。
  try {
    const baseline = await probeWorkspaceStream(target)
    if (baseline !== null) {
      const next = patch.capabilities ?? state.capabilities
      patch.capabilities = { ...next, workspace: true }
      patch.workspaces = mergeWorkspaces(state.workspaces, baseline.items)
      patch.workspaceSource = 'follow'
      patch.archivedSessionIds = baseline.archivedSessionIds
      if (baseline.pinnedSessionIds.length > 0) {
        patch.pinnedSessionIds = baseline.pinnedSessionIds
        pinnedAuthoritative = true
      }
    } else {
      patch.workspaces = mergeWorkspaces(state.workspaces, deriveWorkspacesFromSessions(rows))
      patch.workspaceSource = 'derived'
    }
  } catch (error) {
    if (isMissingEndpoint(error)) {
      // 连 workspace/follow 都没有：工作区这套整块隐藏；新建会话（Host 默认 cwd）仍可用。
      patch.capabilities = { ...(patch.capabilities ?? state.capabilities), workspace: false }
      patch.workspaces = []
    } else {
      // 网络类错误：保留已派生的结果，只在面板里记一笔
      patch.error = errorText(error)
      patch.workspaces = mergeWorkspaces(state.workspaces, deriveWorkspacesFromSessions(rows))
      patch.workspaceSource = 'derived'
    }
  }
  useNewSessionStore.setState(patch)

  // 只有一个工作区时顺手替用户选上；多个就保持「Host 默认」，不猜用户意图。
  const after = useNewSessionStore.getState()
  if (after.selectedWorkspaceId === null && after.workspaces.length === 1) {
    useNewSessionStore.setState({ selectedWorkspaceId: after.workspaces[0]?.workspaceId ?? null })
  }
}

/** 权限预设：拿不到（没有这个端点）就关掉这一项，其它项不受影响。 */
const loadPermissionCatalog = async (target: RemoteCallTarget): Promise<void> => {
  try {
    const catalog = await fetchPermissionCatalog(target)
    useNewSessionStore.setState({
      permissionOptions: catalog.options,
      permissionDefault: catalog.defaultPreset,
      permissionLoaded: true,
      capabilities: { ...useNewSessionStore.getState().capabilities, permission: catalog.options.length > 0 },
    })
  } catch (error) {
    if (isMissingEndpoint(error)) {
      useNewSessionStore.setState({
        permissionOptions: [],
        permissionLoaded: true,
        capabilities: { ...useNewSessionStore.getState().capabilities, permission: false },
      })
      return
    }
    useNewSessionStore.setState({ error: errorText(error) })
  }
}

/** agent preset 名册：同样「拿不到就隐藏」。 */
const loadAgentPresets = async (target: RemoteCallTarget): Promise<void> => {
  try {
    const presets = await fetchAgentPresets(target)
    useNewSessionStore.setState({
      agentPresets: presets,
      agentPresetsLoaded: true,
      capabilities: { ...useNewSessionStore.getState().capabilities, agentPreset: presets.length > 0 },
    })
  } catch (error) {
    if (isMissingEndpoint(error)) {
      useNewSessionStore.setState({
        agentPresets: [],
        agentPresetsLoaded: true,
        capabilities: { ...useNewSessionStore.getState().capabilities, agentPreset: false },
      })
      return
    }
    useNewSessionStore.setState({ error: errorText(error) })
  }
}

/** 默认模型：纯展示，失败一律 `null`（面板就不带具体名字）。 */
const loadDefaultModel = async (target: RemoteCallTarget): Promise<void> => {
  try {
    useNewSessionStore.setState({ defaultModel: await fetchDefaultModel(target) })
  } catch {
    useNewSessionStore.setState({ defaultModel: null })
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * 四、store
 * ──────────────────────────────────────────────────────────────────────── */

export const useNewSessionStore = create<NewSessionState>(() => ({
  ...INITIAL_STATE,

  openPanel: (): void => {
    useNewSessionStore.setState({
      open: true,
      error: null,
      notice: null,
      actionError: null,
      pathFormOpen: false,
      pathError: null,
      directory: null,
      directoryError: null,
    })
    void useNewSessionStore.getState().refresh()
  },

  closePanel: (): void => {
    useNewSessionStore.setState({ open: false, menuSessionId: null, renameTarget: null })
  },

  refresh: async (): Promise<void> => {
    const target = targetFor()
    if (target === null) {
      // 还没连上：能力全关（面板只显示一行「先连上」的说明），不报错
      useNewSessionStore.setState({ capabilities: CAPABILITIES_OFF, loading: false })
      return
    }
    if (refreshInFlight !== null) {
      await refreshInFlight
      return
    }
    useNewSessionStore.setState({ loading: true })
    const task = (async (): Promise<void> => {
      try {
        await loadInventory(target)
        useNewSessionStore.setState({
          capabilities: { ...useNewSessionStore.getState().capabilities, create: true },
        })
      } catch (error) {
        const missing = isMissingEndpoint(error)
        useNewSessionStore.setState({
          error: errorText(error),
          ...(missing
            ? { capabilities: { ...useNewSessionStore.getState().capabilities, create: false, workspace: false } }
            : {}),
        })
      }
      // 三个可选能力各自独立：一个失败不影响其它
      await Promise.all([
        loadPermissionCatalog(target),
        loadAgentPresets(target),
        loadDefaultModel(target),
      ])
      useNewSessionStore.setState({ loading: false })
    })()
    refreshInFlight = task
    try {
      await task
    } finally {
      if (refreshInFlight === task) refreshInFlight = null
    }
  },

  ensureWorkspaceFlags: async (): Promise<void> => {
    const target = targetFor()
    if (target === null) return
    if (inventoryTarget === target && useNewSessionStore.getState().rows.length > 0) return
    try {
      await loadInventory(target)
    } catch {
      // 列表挂载时的静默加载：失败就算了（下拉里没有工作区，列表照常显示）
    }
  },

  probeCapabilities: async (): Promise<void> => {
    /*
     * 为什么要「等一下」：`store.ts` 里 `phase:'ready'` 是在握手完成后立刻写的，而连接对象
     * 要等第一次业务调用（`$events` / `session/list`）才会被本模块观察者记下来。
     * 空态按钮的可见性依赖 `capabilities.create`，所以这里按 300ms 一拍最多等 6 秒：
     *   - 拿到 target 且行也拉到了 → 成功收工；
     *   - 拿到 target 但端点不存在（`capabilities.create` 已被关掉）→ 立刻收工，别再打；
     *   - 全程拿不到 target（连接还没就绪 / 已断开）→ 静默放弃，按钮不显示。
     */
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (useNewSessionStore.getState().rows.length > 0) return
      // 连接没了（断开 / 还没连上）就别空转
      if (useRemoteStore.getState().phase !== 'ready') return
      if (targetFor() === null) {
        // 连接刚就绪、第一帧业务调用还没把连接对象记下来：继续等
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 300)
        })
        continue
      }
      await useNewSessionStore.getState().refresh()
      if (useNewSessionStore.getState().rows.length > 0) return
      // 拉过一次还是没行，且能力已被判定缺失（`METHOD_NOT_FOUND` 之类）→ 别再打
      if (!useNewSessionStore.getState().capabilities.create) return
    }
  },

  selectWorkspace: (workspaceId: string | null): void => {
    useNewSessionStore.setState({ selectedWorkspaceId: workspaceId })
  },

  selectPermission: (preset: string): void => {
    useNewSessionStore.setState({ selectedPermission: preset })
  },

  selectAgentPreset: (preset: string): void => {
    useNewSessionStore.setState({ selectedAgentPreset: preset })
  },

  togglePathForm: (open?: boolean): void => {
    const next = open ?? !useNewSessionStore.getState().pathFormOpen
    useNewSessionStore.setState({
      pathFormOpen: next,
      pathError: null,
      ...(next ? {} : { directory: null, directoryError: null }),
    })
  },

  setPathDraft: (path: string): void => {
    useNewSessionStore.setState({ pathDraft: path, pathError: null })
  },

  browse: async (path?: string): Promise<void> => {
    const target = targetFor()
    if (target === null) return
    if (!useNewSessionStore.getState().capabilities.directory) return
    useNewSessionStore.setState({ directoryLoading: true, directoryError: null })
    try {
      const listing = await listDirectory(target, path)
      useNewSessionStore.setState({ directory: listing, directoryLoading: false })
    } catch (error) {
      if (isMissingEndpoint(error)) {
        // Host 没有这个端点：整块隐藏，表单还能手填路径
        useNewSessionStore.setState({
          directory: null,
          directoryLoading: false,
          directoryError: null,
          capabilities: { ...useNewSessionStore.getState().capabilities, directory: false },
        })
        return
      }
      useNewSessionStore.setState({ directoryLoading: false, directoryError: errorText(error) })
    }
  },

  submitWorkspacePath: async (): Promise<RemoteWorkspace | null> => {
    const target = targetFor()
    if (target === null) return null
    let path: string
    try {
      path = normalizeWorkspacePath(useNewSessionStore.getState().pathDraft)
    } catch (error) {
      useNewSessionStore.setState({ pathError: errorText(error) })
      return null
    }
    useNewSessionStore.setState({ creating: true, pathError: null, error: null })
    try {
      const { workspace } = await createWorkspace(target, path)
      const state = useNewSessionStore.getState()
      useNewSessionStore.setState({
        creating: false,
        workspaces: mergeWorkspaces(state.workspaces, [workspace]),
        selectedWorkspaceId: workspace.workspaceId,
        pathFormOpen: false,
        pathDraft: '',
        pathError: null,
        directory: null,
        notice: null,
      })
      return workspace
    } catch (error) {
      if (isMissingEndpoint(error)) {
        useNewSessionStore.setState({
          creating: false,
          capabilities: { ...useNewSessionStore.getState().capabilities, workspace: false },
        })
        return null
      }
      useNewSessionStore.setState({ creating: false, pathError: errorText(error) })
      return null
    }
  },

  adoptBrowsedDirectory: async (path: string): Promise<RemoteWorkspace | null> => {
    useNewSessionStore.setState({ pathDraft: path })
    return await useNewSessionStore.getState().submitWorkspacePath()
  },

  createAndOpen: async (): Promise<string | null> => {
    const target = targetFor()
    if (target === null) {
      useNewSessionStore.setState({
        error: describeRemoteError({ code: 'NOT_CONNECTED' }).text,
        capabilities: CAPABILITIES_OFF,
      })
      return null
    }
    const state = useNewSessionStore.getState()
    if (state.creating || !state.capabilities.create) return null

    useNewSessionStore.setState({ creating: true, error: null, notice: null })
    try {
      const created = await createSession(target, {
        ...(state.selectedWorkspaceId === null ? {} : { workspaceId: state.selectedWorkspaceId }),
        ...(state.selectedAgentPreset.length === 0 ? {} : { agentPreset: state.selectedAgentPreset }),
      })

      // 权限预设只能通过 `/permission <preset>` 生效（input-B §2.10），且要在进会话前设好，
      // 免得第一轮就跑在错的权限下。它失败不该让「新建」失败 —— 记成 notice。
      const wanted = state.selectedPermission
      let notice: string | null = null
      if (wanted.length > 0 && wanted !== state.permissionDefault) {
        try {
          await applyPermissionPreset(target, created.sessionId, wanted)
        } catch (error) {
          notice = `${describeRemoteError(error).text}（会话已建好，权限预设未生效）`
          if (isMissingEndpoint(error)) {
            useNewSessionStore.setState({
              capabilities: { ...useNewSessionStore.getState().capabilities, permission: false },
            })
          }
        }
      }
      if (state.selectedAgentPreset.length > 0 && created.agentPreset !== state.selectedAgentPreset) {
        notice = '会话已建好，但 agent preset 没有生效'
      }

      useNewSessionStore.setState({ creating: false, lastCreatedSessionId: created.sessionId, notice })
      refreshRemoteSessions()
      // 先刷列表再进会话：`openSession` 只依赖 id，但列表里有这一行体验才对。
      await Promise.resolve(useRemoteStore.getState().refreshSessions()).catch(() => undefined)
      await useRemoteStore.getState().openSession(created.sessionId)
      useNewSessionStore.setState({ open: false })
      return created.sessionId
    } catch (error) {
      if (isMissingEndpoint(error)) {
        useNewSessionStore.setState({
          creating: false,
          capabilities: { ...useNewSessionStore.getState().capabilities, create: false },
        })
        return null
      }
      useNewSessionStore.setState({ creating: false, error: errorText(error) })
      return null
    }
  },

  runSearch: async (query: string): Promise<void> => {
    const seq = ++searchSeq
    const trimmed = query.trim()
    if (trimmed.length === 0) {
      useNewSessionStore.setState({ search: initialSearch })
      return
    }
    const current = useNewSessionStore.getState().search
    useNewSessionStore.setState({ search: { query, searching: true, hits: current.hits, local: current.local } })

    const finish = (hits: RemoteSearchHit[], local: boolean): void => {
      if (seq !== searchSeq) return
      useNewSessionStore.setState({ search: { query, searching: false, hits, local } })
    }

    const target = targetFor()
    if (target !== null && useNewSessionStore.getState().capabilities.search) {
      try {
        const result = await searchSessions(target, trimmed)
        finish(result.items, false)
        return
      } catch {
        // 索引没开（gateway/internal）、没这个端点、参数被拒 —— 一律降级到本地
        if (seq === searchSeq) {
          useNewSessionStore.setState({
            capabilities: { ...useNewSessionStore.getState().capabilities, search: false },
          })
        }
      }
    }
    // 本地回退：语料是最近一次 `session/list`（面板打开时刷过；没有就补一次）
    if (useNewSessionStore.getState().rows.length === 0) {
      await useNewSessionStore.getState().ensureWorkspaceFlags()
    }
    finish(
      filterSessionsLocally(useNewSessionStore.getState().rows.map(toSessionListRow), trimmed),
      true,
    )
  },

  clearSearch: (): void => {
    searchSeq += 1
    useNewSessionStore.setState({ search: initialSearch })
  },

  setMenu: (sessionId: string | null): void => {
    useNewSessionStore.setState({ menuSessionId: sessionId, actionError: null })
  },

  beginRename: (sessionId: string, title: string): void => {
    useNewSessionStore.setState({
      renameTarget: { sessionId, title },
      menuSessionId: null,
      actionError: null,
    })
  },

  updateRenameDraft: (title: string): void => {
    const target = useNewSessionStore.getState().renameTarget
    if (target === null) return
    useNewSessionStore.setState({ renameTarget: { ...target, title } })
  },

  cancelRename: (): void => {
    useNewSessionStore.setState({ renameTarget: null })
  },

  commitRename: async (): Promise<void> => {
    const target = targetFor()
    const rename = useNewSessionStore.getState().renameTarget
    if (target === null || rename === null) return
    const title = rename.title.trim()
    if (title.length === 0) {
      useNewSessionStore.setState({ actionError: '标题不能为空' })
      return
    }
    useNewSessionStore.setState({ busySessionId: rename.sessionId, actionError: null })
    try {
      const committed = await renameSession(target, rename.sessionId, title)
      const state = useNewSessionStore.getState()
      useNewSessionStore.setState({
        busySessionId: null,
        renameTarget: null,
        rows: state.rows.map((row) => (row.sessionId === rename.sessionId ? { ...row, title: committed } : row)),
      })
      refreshRemoteSessions()
    } catch (error) {
      manageFailed(error)
    }
  },

  togglePin: async (sessionId: string): Promise<void> => {
    const target = targetFor()
    if (target === null) return
    const pinned = useNewSessionStore.getState().pinnedSessionIds.includes(sessionId)
    useNewSessionStore.setState({ busySessionId: sessionId, menuSessionId: null, actionError: null })
    try {
      const result = pinned
        ? await unpinSession(target, sessionId)
        : await pinSession(target, sessionId)
      pinnedAuthoritative = true
      useNewSessionStore.setState({ busySessionId: null, pinnedSessionIds: result.sessionIds })
      refreshRemoteSessions()
    } catch (error) {
      manageFailed(error)
    }
  },

  toggleArchive: async (sessionId: string): Promise<void> => {
    const target = targetFor()
    if (target === null) return
    const archived = useNewSessionStore.getState().archivedSessionIds.includes(sessionId)
    useNewSessionStore.setState({ busySessionId: sessionId, menuSessionId: null, actionError: null })
    try {
      const result = archived
        ? await unarchiveSession(target, sessionId)
        : await archiveSession(target, sessionId)
      useNewSessionStore.setState({ busySessionId: null, archivedSessionIds: result.sessionIds })
      refreshRemoteSessions()
    } catch (error) {
      manageFailed(error)
    }
  },

  fork: async (sessionId: string): Promise<void> => {
    const target = targetFor()
    if (target === null) return
    useNewSessionStore.setState({ busySessionId: sessionId, menuSessionId: null, actionError: null })
    try {
      const forkedId = await forkSession(target, sessionId)
      useNewSessionStore.setState({ busySessionId: null })
      refreshRemoteSessions()
      // 派生出来的会话通常是空会话：直接进去接着聊（与 dsh-Go 一致）
      await Promise.resolve(useRemoteStore.getState().refreshSessions()).catch(() => undefined)
      await useRemoteStore.getState().openSession(forkedId)
    } catch (error) {
      manageFailed(error)
    }
  },
}))
