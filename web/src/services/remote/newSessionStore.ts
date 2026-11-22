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
 * ## 工作区列表从哪来（S2 起：`workspace/follow` 是权威）
 *
 * ```
 *  workspace/follow（常驻流，services/remote/workspaces.ts）──► hostWorkspaces ─┐
 *                                                                              ├─► workspaces（合并）
 *  session/list ──► deriveWorkspacesFromSessions() ──────────► derivedWorkspaces ┘
 * ```
 *
 * - **权威**：`workspace/follow` 首帧 `baseline` 给的 `items`（input-B §2.1）—— 它包含
 *   **没有会话的工作区**，也能给出每个工作区的会话数与归档 / 置顶全集；
 * - **补缺**：派生的那份只用来补 follow 行里缺的 `path` / 显示名；同工作区按
 *   `workspaceId` 与路径两层去重（规则在 `mergeWorkspaceInventory`）；
 * - **降级**：老 Host 回 `METHOD_NOT_FOUND` 时静默退回派生列表（`workspaceFollow:'unsupported'`），
 *   **不**把工作区 UI 收起来 —— 用户反馈的那句「没有识别到我用过的工作区」就是旧版把
 *   整个下拉藏掉造成的连带伤害。
 *
 * 流的生命周期（开 / 关 / 重开 / 重试）全在 `workspaces.ts`；本文件只负责**收数据**：
 * `applyWorkspaceBaseline()`（baseline）与 `applyWorkspaceFrame()`（增量）。
 *
 * 「归档 / 置顶」的初值也是同一套：baseline 给全集就标成权威（`pinnedAuthoritative`），
 * 没给就在 `session/list` 的行上按 `pinned` 投影猜（老 Host）。
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

import { translate } from '../../i18n/index.js'
import {
  applyPermissionPreset,
  applySessionModel,
  archiveSession,
  createSession,
  createWorkspace,
  describeRemoteError,
  fetchAgentPresets,
  fetchModelCatalog,
  fetchPermissionCatalog,
  findRemoteModel,
  forkSession,
  lastRemoteTarget,
  listDirectory,
  listSessions,
  normalizeWorkspacePath,
  pinSession,
  renameSession,
  searchSessions,
  unarchiveSession,
  unpinSession,
  type RemoteAgentPreset,
  type RemoteCallTarget,
  type RemoteDirectoryListing,
  type RemoteModelCatalog,
  type RemoteModelEntry,
  type RemoteModelSelection,
  type RemotePermissionOption,
  type RemoteSearchHit,
  type RemoteSessionRow,
  type RemoteWorkspace,
  type RemoteWorkspaceFrame,
  type RemoteWorkspaceList,
} from './sessionsApi.js'
import { useRemoteStore } from './store.js'
import {
  deriveWorkspacesFromSessions,
  ensureWorkspaceStream,
  installWorkspaceSync,
  isMissingEndpointError,
  mergeWorkspaceInventory,
  type WorkspaceFollowStatus,
  type WorkspaceSyncFailure,
} from './workspaces.js'

/* 工作区列表的纯函数住在 `workspaces.ts`（同步器那边也要用），这里按老名字再导出一次：
 * `new-session.selftest.mts` 与个别 UI 都是从这个模块 import 的。 */
export { deriveWorkspacesFromSessions, mergeWorkspaceInventory, workspaceTitleFromPath } from './workspaces.js'

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
  /**
   * `workspace/create` 可用（「新建工作区」这一行）。
   *
   * 与 `workspace` 分开：老 Host 常常「有工作区表、没有 create」，那时列表照常显示，
   * 只把「新建工作区」收起来 —— 不能因为少一个 create 就把整个选择器藏掉。
   */
  workspaceCreate: boolean
  /** `session/create` 可用。 */
  create: boolean
  /** `directoryPicker/list` 可用（「浏览目录」）。 */
  directory: boolean
  /** 权限预设可用（`permissionPresets/catalog` + `commands/execute`）。 */
  permission: boolean
  /** agent preset 可用（`agentPresets/list`）。 */
  agentPreset: boolean
  /** 模型目录可用（`session/modelCatalog` + `session/selectModel`）。 */
  model: boolean
  /** 远端 `session/search` 可用（false ⇒ 本地按标题过滤）。 */
  search: boolean
  /** 会话管理可用（`session/rename|fork`、`workspace/*Session` 这一组）。 */
  manage: boolean
}

const CAPABILITIES_OFF: NewSessionCapabilities = {
  workspace: false,
  workspaceCreate: false,
  create: false,
  directory: false,
  permission: false,
  agentPreset: false,
  model: false,
  search: false,
  manage: false,
}

const CAPABILITIES_ON: NewSessionCapabilities = {
  workspace: true,
  workspaceCreate: true,
  create: true,
  directory: true,
  permission: true,
  agentPreset: true,
  model: true,
  search: true,
  manage: true,
}

/** 工作区列表的来源（`derived` 时「没有会话的工作区」列不出来，见文件头）。 */
export type WorkspaceSource = 'follow' | 'derived'
/**
 * 面板里会展开的「短列表」（照 dsh-Go 的做法：每个选项点开一个小 sheet）。
 *
 * - `workspace`：工作区列表（末行「新建工作区」）
 * - `newWorkspace`：新建工作区（路径 + 目录浏览）
 * - `model`：模型卡片网格 + 思考强度分段
 * - `preset` / `permission`：agent preset / 权限预设
 */
export type NewSessionSheet = 'workspace' | 'newWorkspace' | 'model' | 'preset' | 'permission'

/** 用户选定的模型（`null` = 继承 Host 默认，不产生任何写操作）。 */
export interface ModelPick {
  provider: string
  model: string
  /** 选定的思考强度；`undefined` = 用模型声明的默认。 */
  effort?: string
}

/** 「建完之后设模型」的结果，失败时面板停在这里等用户决定（重试 / 跳过）。 */
export interface ModelApplyState {
  status: 'idle' | 'applying' | 'failed'
  /** 失败原因（中文，直接显示）。 */
  error?: string
  /** 最终生效的那条路（诊断用，也会在报告里写清）。 */
  via?: 'select' | 'initialize'
  /**
   * `selectModel` 里「新对话默认」那一步的结果：`failed` 时会额外给一句提示
   * （会话模型已经切好了，只是下次新建的默认没存上 —— 两件事不能混为一谈）。
   */
  defaultSave?: 'failed'
}

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

  /**
   * 给 UI 用的工作区列表 = `mergeWorkspaceInventory(hostWorkspaces, derivedWorkspaces)`。
   *
   * 直接读它（新建会话页、工作区抽屉都读它）；两个来源各自存在下面两个字段里。
   */
  workspaces: RemoteWorkspace[]
  /** **权威**：`workspace/follow` 的 `baseline.items`（老 Host 没有这个端点 ⇒ 一直是空）。 */
  hostWorkspaces: RemoteWorkspace[]
  /** 从 `session/list` 派生的那份（只补 `path` / 显示名；没 baseline 时它就是全部）。 */
  derivedWorkspaces: RemoteWorkspace[]
  workspaceSource: WorkspaceSource
  /** `workspace/follow` 这条流的状态（`unsupported` = 老 Host，走派生列表且不收起 UI）。 */
  workspaceFollow: WorkspaceFollowStatus
  /** 最近一次 `session/list` 的原始行（本地搜索与派生工作区都用它）。 */
  rows: RemoteSessionRow[]
  archivedSessionIds: string[]
  pinnedSessionIds: string[]
  /** 选中的工作区；`null` = 让 Host 用它自己的 cwd。 */
  selectedWorkspaceId: string | null

  /**
   * 会话列表的工作区筛选（R15，照 dsh-Go 的 `WorkspaceSwitcher` 抽屉作用域）：
   * `null` = 全部工作区。放在这个 store 是因为列表可能被反复挂载（手机抽屉 ↔ 平板常驻），
   * 本地 state 会跟着丢；跟 `selectedWorkspaceId` 一样换连接时在 `loadInventory` 里复位。
   */
  listWorkspaceFilter: string | null

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

  /** Host 的模型目录（`session/modelCatalog`）：`null` = 拿不到，就不显示模型这一项。 */
  modelCatalog: RemoteModelCatalog | null
  /** 这一代连接上模型目录是否已经问过。 */
  modelCatalogLoaded: boolean
  /** 用户选定的模型；`null` = 继承 Host 默认（不产生写操作）。 */
  modelPick: ModelPick | null
  /** 「建完之后设模型」的进度（诊断信息：走哪条路、defaultSave 有没有失败）。 */
  modelApply: ModelApplyState

  /** 当前展开的短列表（`null` = 都在收起状态）。 */
  sheet: NewSessionSheet | null

  creating: boolean
  /** 刚建出来的会话 id（成功后打开它；自测也断言这个）。 */
  lastCreatedSessionId: string | null

  /* ── 新建工作区（路径表单 + 目录浏览） ── */
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
  /** 收到 `workspace/follow` 的 `baseline`（权威全量：items + 归档 / 置顶全集）。 */
  applyWorkspaceBaseline(list: RemoteWorkspaceList): void
  /** 收到一帧增量（upsert / remove）；认不出的帧不会走到这里。 */
  applyWorkspaceFrame(frame: RemoteWorkspaceFrame): void
  /** 流状态变了：`unsupported` ⇒ 老 Host，静默退回派生列表（**不收起 UI**）。 */
  setWorkspaceFollowStatus(status: WorkspaceFollowStatus, failure?: WorkspaceSyncFailure): void
  /**
   * 连接就绪后**探测能力**：等第一帧业务调用把连接对象记下来（`lastRemoteTarget()`），
   * 再走一遍 `refresh()`。空态里的「新建会话」按钮要靠它才知道能不能显示。
   */
  probeCapabilities(): Promise<void>
  selectWorkspace(workspaceId: string | null): void
  /** 会话列表按工作区筛选（`null` = 全部）。 */
  selectListWorkspace(filter: string | null): void
  selectPermission(preset: string): void
  selectAgentPreset(preset: string): void
  /** 展开 / 收起一个短列表（`null` 全部收起）。 */
  openSheet(sheet: NewSessionSheet | null): void
  /** 选模型（`effort` 不给就用模型声明的默认档位）。 */
  pickModel(provider: string, model: string, effort?: string): void
  /** 选思考强度（对当前生效的模型）。 */
  pickEffort(effort: string): void
  setPathDraft(path: string): void
  /** 浏览一层目录（不传 `path` = 家目录）。Host 不支持就把浏览关掉（能力门禁）。 */
  browse(path?: string): Promise<void>
  /** 把路径表单里的路径注册成工作区；成功返回新工作区。 */
  submitWorkspacePath(): Promise<RemoteWorkspace | null>
  /** 目录浏览器里点「用这个目录」：填进表单并顺手注册。 */
  adoptBrowsedDirectory(path: string): Promise<RemoteWorkspace | null>
  /**
   * [R15] 「发消息即建会话」（dsh-Go `_ensureSession` 的做法）：`session/create`（带工作区 /
   * agent preset）→（必要时）`/permission <preset>` →（必要时）`session/selectModel` →
   * 退回 `session/initializeDefaultModel` → `openSession(id)` → **把这条消息发出去**。
   *
   * 模型应用失败**不再拦住消息**：记一句 notice（由界面 toast 出来）继续发，
   * Host 用默认模型接住 —— 旧版「停在失败页等重试 / 跳过」那条死路已删。
   * 返回 `false` = 会话没建出来（原因已写进 `error`，界面把草稿还给用户）。
   */
  createAndSend(text: string): Promise<boolean>
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
/** 这一代连接上 `workspace/follow` 的 baseline 是否已经到过（决定 `workspaceSource`）。 */
let baselineReceived = false

/**
 * `workspace/follow` 的**一次性**读取器扩展点（备用通道）。
 *
 * 现在的主通道是 `workspaces.ts` 里的常驻流（`installWorkspaceSync` / `ensureWorkspaceStream`），
 * 它会一路把 baseline 推给 `applyWorkspaceBaseline()`。这个扩展点是给「只想读一次」的场景
 * 留的：谁注册了它，`loadInventory` 就优先用它（读首帧后自行关流），没有注册就走常驻流。
 * 契约：解析失败返回 `null`（当作没读到，退回派生列表）。
 */
export type WorkspaceBaselineReader = (target: RemoteCallTarget) => Promise<RemoteWorkspaceList | null>

let workspaceBaselineReader: WorkspaceBaselineReader | null = null

/** 注入 / 卸载「一次性读 workspace/follow baseline」的实现（不传 = 走常驻流）。 */
export const registerWorkspaceBaselineReader = (reader: WorkspaceBaselineReader | null): void => {
  workspaceBaselineReader = reader
}

/** 把 `workspace/follow` 的常驻流接到本 store 上（幂等；不装就用派生列表）。 */
const installWorkspaceStream = (): void => {
  installWorkspaceSync({
    onBaseline: (list) => useNewSessionStore.getState().applyWorkspaceBaseline(list),
    onDelta: (frame) => useNewSessionStore.getState().applyWorkspaceFrame(frame),
    onStatus: (status, failure) => useNewSessionStore.getState().setWorkspaceFollowStatus(status, failure),
  })
}

/** 两份数据合并 + 「选中的工作区还在不在」这条一致性修补。 */
const workspacePatch = (
  state: NewSessionState,
  host: readonly RemoteWorkspace[],
  derived: readonly RemoteWorkspace[],
): Partial<NewSessionState> => {
  const workspaces = mergeWorkspaceInventory(host, derived)
  const selected = state.selectedWorkspaceId
  const keepSelected = selected === null || workspaces.some((item) => item.workspaceId === selected)
  return {
    hostWorkspaces: [...host],
    derivedWorkspaces: [...derived],
    workspaces,
    ...(keepSelected ? {} : { selectedWorkspaceId: null }),
  }
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
 * 新会话收尾：刷列表 → 打开会话 → 关面板。
 *
 * `notice` 用来把「跳过了模型 / 权限没生效」这类**已完成但打了折扣**的事实带出去
 * （面板关了，用户还能在会话页看到它；不静默吞掉）。
 */
const finishOpen = async (sessionId: string, notice: string | null): Promise<void> => {
  useNewSessionStore.setState({
    creating: false,
    lastCreatedSessionId: sessionId,
    sheet: null,
    // `modelApply` 不在这里清：调用方刚写进去的 `via` / `defaultSave` 是诊断信息，
    // 留给下一次 `openPanel()` / `closePanel()` 复位（它不影响任何 UI 判定）。
  })
  refreshRemoteSessions()
  // 先刷列表再进会话：`openSession` 只依赖 id，但列表里有这一行体验才对。
  await Promise.resolve(useRemoteStore.getState().refreshSessions()).catch(() => undefined)
  await useRemoteStore.getState().openSession(sessionId)
  useNewSessionStore.setState({ open: false, notice })
}

/**
 * 建完之后核对模型到底生效了没（`projections.values.modelSelection`，`client-core:1929-1945`）。
 *
 * 老 Host 不投影这一项 → 跳过核对（不臆测）。投影对不上 → 返回一句人话给 `notice`。
 */
const verifyAppliedModel = async (
  target: RemoteCallTarget,
  sessionId: string,
  wanted: RemoteModelSelection,
): Promise<string | null> => {
  try {
    const rows = await listSessions(target)
    const row = rows.find((item) => item.sessionId === sessionId)
    const actual = row?.modelSelection
    if (actual === undefined) return null
    if (actual.provider !== wanted.provider || actual.model !== wanted.model) {
      return translate('newSessionModelNotConfirmed', { model: `${actual.provider}/${actual.model}` })
    }
    if (wanted.reasoningEffort !== undefined && actual.reasoningEffort !== undefined
      && actual.reasoningEffort !== wanted.reasoningEffort) {
      return translate('newSessionEffortNotConfirmed', { effort: actual.reasoningEffort })
    }
    return null
  } catch {
    return null
  }
}

/**
 * 会话管理类动作（改名 / 置顶 / 归档 / 派生）失败时的统一收尾。
 *
 * 两种失败分开处理：**没有这个端点** ⇒ 把 `manage` 关掉（列表里的「⋯」整块消失）；
 * 其它失败（网络、Host 拒绝）⇒ 只留一行 `actionError`，能力保持不变。
 */
const manageFailed = (error: unknown): void => {
  const missing = isMissingEndpointError(error)
  useNewSessionStore.setState({
    busySessionId: null,
    actionError: errorText(error),
    ...(missing ? { capabilities: { ...useNewSessionStore.getState().capabilities, manage: false } } : {}),
  })
}

const initialSearch: NewSessionSearchState = { query: '', searching: false, hits: null, local: false }
const initialModelApply: ModelApplyState = { status: 'idle' }

const INITIAL_STATE = {
  open: false,
  loading: false,
  error: null,
  notice: null,
  capabilities: CAPABILITIES_OFF,
  workspaces: [] as RemoteWorkspace[],
  hostWorkspaces: [] as RemoteWorkspace[],
  derivedWorkspaces: [] as RemoteWorkspace[],
  workspaceSource: 'derived' as WorkspaceSource,
  workspaceFollow: 'idle' as WorkspaceFollowStatus,
  rows: [] as RemoteSessionRow[],
  archivedSessionIds: [] as string[],
  pinnedSessionIds: [] as string[],
  selectedWorkspaceId: null,
  listWorkspaceFilter: null as string | null,
  permissionOptions: [] as RemotePermissionOption[],
  permissionDefault: '',
  selectedPermission: '',
  permissionLoaded: false,
  agentPresets: [] as RemoteAgentPreset[],
  selectedAgentPreset: '',
  agentPresetsLoaded: false,
  modelCatalog: null as RemoteModelCatalog | null,
  modelCatalogLoaded: false,
  modelPick: null as ModelPick | null,
  modelApply: initialModelApply,
  sheet: null as NewSessionSheet | null,
  creating: false,
  lastCreatedSessionId: null,
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

/* ── 模型选择的派生值（界面与「建后应用」共用同一套判断） ─────────────── */

/**
 * 当前生效的模型选择：用户选的那份，否则 Host 的默认。
 *
 * 注意两者语义不同：`modelPick === null` 表示「继承 Host 默认」—— 建完**不写**任何东西。
 */
export const effectiveModelSelection = (
  catalog: RemoteModelCatalog | null,
  pick: ModelPick | null,
): RemoteModelSelection | null => {
  if (pick !== null) {
    return { provider: pick.provider, model: pick.model, ...(pick.effort === undefined ? {} : { reasoningEffort: pick.effort }) }
  }
  return catalog?.default ?? null
}

/** 当前生效模型在目录里的那一行（拿不到就是 `undefined`）。 */
export const effectiveModelEntry = (
  catalog: RemoteModelCatalog | null,
  pick: ModelPick | null,
): RemoteModelEntry | undefined => findRemoteModel(catalog, effectiveModelSelection(catalog, pick))

/**
 * 要发给 Host 的选择：只包含**真正需要写**的部分。
 *
 * `null` = 继承 Host 默认（不调用任何模型端点）。
 */
export const modelSelectionToApply = (pick: ModelPick | null): RemoteModelSelection | null => {
  if (pick === null) return null
  return {
    provider: pick.provider,
    model: pick.model,
    ...(pick.effort === undefined ? {} : { reasoningEffort: pick.effort }),
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * 三、加载（清单 / 工作区 / 预设）
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 拉会话清单，并据此刷新工作区 / 归档 / 置顶。
 *
 * 一次 `session/list` 顺带解决三件事：本地搜索的语料、派生工作区、置顶初值；
 * 权威那份工作区由 `workspace/follow` 的常驻流推进来（没到 / 老 Host 就是派生的，见文件头）。
 */
const loadInventory = async (target: RemoteCallTarget): Promise<void> => {
  if (inventoryTarget !== target) {
    inventoryTarget = target
    pinnedAuthoritative = false
    baselineReceived = false
    useNewSessionStore.setState({
      capabilities: CAPABILITIES_ON,
      workspaces: [],
      hostWorkspaces: [],
      derivedWorkspaces: [],
      workspaceSource: 'derived',
      workspaceFollow: 'idle',
      rows: [],
      archivedSessionIds: [],
      pinnedSessionIds: [],
      selectedWorkspaceId: null,
      listWorkspaceFilter: null,
      permissionOptions: [],
      permissionDefault: '',
      permissionLoaded: false,
      agentPresets: [],
      agentPresetsLoaded: false,
      modelCatalog: null,
      modelCatalogLoaded: false,
      error: null,
    })
  }

  const rows = await listSessions(target)
  const state = useNewSessionStore.getState()
  const derived = deriveWorkspacesFromSessions(rows)
  let host = state.hostWorkspaces
  const patch: Partial<NewSessionState> = {
    rows,
    derivedWorkspaces: derived,
    capabilities: { ...state.capabilities, workspace: true },
  }
  if (!pinnedAuthoritative) {
    patch.pinnedSessionIds = rows.filter((row) => row.pinned === true).map((row) => row.sessionId)
  }

  if (workspaceBaselineReader !== null) {
    /*
     * 备用通道：有人注册了一次性 reader 就用它（读首帧后自己关流）。
     * 生产没人注册，走下面的常驻流。
     */
    try {
      const baseline = await workspaceBaselineReader(target)
      if (baseline !== null) {
        host = baseline.items
        baselineReceived = true
        patch.archivedSessionIds = baseline.archivedSessionIds
        if (baseline.pinnedSessionIds.length > 0) {
          patch.pinnedSessionIds = baseline.pinnedSessionIds
          pinnedAuthoritative = true
        }
      }
    } catch (error) {
      if (isMissingEndpointError(error)) patch.workspaceFollow = 'unsupported'
      else patch.error = errorText(error)
    }
  } else {
    installWorkspaceStream()
    // `listSessions()` 刚刚把连接对象记进观察者：现在 ensure 一定拿得到 target
    ensureWorkspaceStream()
  }

  patch.hostWorkspaces = host
  patch.workspaces = mergeWorkspaceInventory(host, derived)
  patch.workspaceSource = baselineReceived ? 'follow' : 'derived'
  patch.workspaceFollow = patch.workspaceFollow ?? useNewSessionStore.getState().workspaceFollow
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
    if (isMissingEndpointError(error)) {
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
    if (isMissingEndpointError(error)) {
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

/**
 * 模型目录（`session/modelCatalog`）：拿不到就整块隐藏。
 *
 * 目录里带每个模型支持的思考强度档位，所以「模型 + 思考强度」两个控件共用这一次请求。
 */
const loadModelCatalog = async (target: RemoteCallTarget): Promise<void> => {
  try {
    const catalog = await fetchModelCatalog(target)
    useNewSessionStore.setState({
      modelCatalog: catalog,
      modelCatalogLoaded: true,
      capabilities: {
        ...useNewSessionStore.getState().capabilities,
        model: catalog.models.length > 0,
      },
    })
  } catch (error) {
    if (isMissingEndpointError(error)) {
      useNewSessionStore.setState({
        modelCatalog: null,
        modelCatalogLoaded: true,
        capabilities: { ...useNewSessionStore.getState().capabilities, model: false },
      })
      return
    }
    // 网络类失败：不把能力关掉（下次打开面板还会再试），只在面板里记一笔
    useNewSessionStore.setState({ modelCatalogLoaded: true, error: errorText(error) })
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
      sheet: null,
      pathError: null,
      directory: null,
      directoryError: null,
      modelApply: initialModelApply,
    })
    void useNewSessionStore.getState().refresh()
  },

  closePanel: (): void => {
    useNewSessionStore.setState({
      open: false,
      menuSessionId: null,
      renameTarget: null,
      sheet: null,
      modelApply: initialModelApply,
    })
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
        const missing = isMissingEndpointError(error)
        /*
         * 注意**不要**动 `capabilities.workspace`：这里失败的是 `session/list`（清单）或
         * `session/create`，跟工作区列表不是一件事。工作区那套的可用性只由
         * `workspace/follow` 的结果（常驻流 → `workspaceFollow`）决定，
         * 老 Host 缺端点也只是退回派生列表，**不**把 UI 收起来（S2 的硬要求）。
         */
        useNewSessionStore.setState({
          error: errorText(error),
          ...(missing
            ? { capabilities: { ...useNewSessionStore.getState().capabilities, create: false } }
            : {}),
        })
      }
      // 三个可选能力各自独立：一个失败不影响其它
      await Promise.all([
        loadPermissionCatalog(target),
        loadAgentPresets(target),
        loadModelCatalog(target),
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

  /**
   * `workspace/follow` 的 `baseline`（权威全量）。
   *
   * 三件事一起做：items 落到 `hostWorkspaces`、归档 / 置顶换成 Host 的全集、
   * 和派生那份合并成 UI 读的 `workspaces`。**不动** `error`（静默）—— 基线到了就说明
   * 这条路是通的，之前那些网络错误不该继续挂在面板上；同时把工作区能力打开。
   */
  applyWorkspaceBaseline: (list: RemoteWorkspaceList): void => {
    baselineReceived = true
    const state = useNewSessionStore.getState()
    const patch: Partial<NewSessionState> = {
      ...workspacePatch(state, list.items, state.derivedWorkspaces),
      workspaceSource: 'follow',
      workspaceFollow: 'streaming',
      archivedSessionIds: list.archivedSessionIds,
      capabilities: { ...state.capabilities, workspace: true },
      error: null,
    }
    if (list.pinnedSessionIds.length > 0) {
      patch.pinnedSessionIds = list.pinnedSessionIds
      pinnedAuthoritative = true
    }
    useNewSessionStore.setState(patch)
  },

  /**
   * 一帧增量（upsert / remove）。
   *
   * 只改 `hostWorkspaces` 里对应那一行；解析不了形状的帧在 `workspaces.ts` 就被丢掉了，
   * 不会走到这里（宁可晚一拍，也不要把错的工作区画上去）。
   */
  applyWorkspaceFrame: (frame: RemoteWorkspaceFrame): void => {
    if (frame.kind === 'ignore') return
    const state = useNewSessionStore.getState()
    const host = frame.kind === 'remove'
      ? state.hostWorkspaces.filter((item) => item.workspaceId !== frame.workspaceId)
      : state.hostWorkspaces.some((item) => item.workspaceId === frame.workspace.workspaceId)
        ? state.hostWorkspaces.map((item) => (item.workspaceId === frame.workspace.workspaceId ? frame.workspace : item))
        : [...state.hostWorkspaces, frame.workspace]
    useNewSessionStore.setState(workspacePatch(state, host, state.derivedWorkspaces))
  },

  /**
   * 流状态变了。
   *
   * `unsupported` = 老 Host 没有 `workspace/follow`：**静默**退回派生列表，`capabilities.workspace`
   * 保持 true（工作区选择器照常显示），不写 `error`。这不是降级提示，是兼容路径。
   */
  setWorkspaceFollowStatus: (status: WorkspaceFollowStatus): void => {
    const state = useNewSessionStore.getState()
    if (status === 'unsupported') {
      useNewSessionStore.setState({
        workspaceFollow: 'unsupported',
        // 这条连接上没有 follow：权威来源就是派生的那份（哪怕上一代连接留下过 baseline）
        workspaceSource: 'derived',
        ...workspacePatch(state, [], state.derivedWorkspaces),
      })
      return
    }
    if (state.workspaceFollow === status) return
    useNewSessionStore.setState({ workspaceFollow: status })
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

  selectListWorkspace: (filter: string | null): void => {
    useNewSessionStore.setState({ listWorkspaceFilter: filter })
  },

  selectPermission: (preset: string): void => {
    useNewSessionStore.setState({ selectedPermission: preset })
  },

  selectAgentPreset: (preset: string): void => {
    useNewSessionStore.setState({ selectedAgentPreset: preset })
  },

  openSheet: (sheet: NewSessionSheet | null): void => {
    const current = useNewSessionStore.getState()
    // 换工作区时把目录浏览状态清掉：那是上一个路径的
    useNewSessionStore.setState({
      sheet,
      pathError: null,
      ...(sheet === 'newWorkspace' ? {} : { directory: null, directoryError: null }),
      ...(sheet === null ? { selectedWorkspaceId: current.selectedWorkspaceId } : {}),
    })
  },

  pickModel: (provider: string, model: string, effort?: string): void => {
    const state = useNewSessionStore.getState()
    const catalog = state.modelCatalog
    const entry = findRemoteModel(catalog, { provider, model })
    // 换模型时旧的档位可能不存在（例如从有 4 档的模型换到只有 2 档的）：只在「同模型」时才继承。
    const sameModel = state.modelPick?.provider === provider && state.modelPick.model === model
    const inherited = sameModel ? state.modelPick?.effort : undefined
    const keep = effort ?? inherited
    const valid = keep !== undefined && (entry?.efforts ?? []).some((item) => item.id === keep)
    useNewSessionStore.setState({
      modelPick: {
        provider,
        model,
        ...(valid ? { effort: keep } : {}),
      },
      sheet: null,
      modelApply: initialModelApply,
    })
  },

  pickEffort: (effort: string): void => {
    const state = useNewSessionStore.getState()
    const effective = effectiveModelSelection(state.modelCatalog, state.modelPick)
    if (effective === null) return
    useNewSessionStore.setState({
      modelPick: {
        provider: effective.provider,
        model: effective.model,
        ...(effort.length === 0 ? {} : { effort }),
      },
      modelApply: initialModelApply,
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
      if (isMissingEndpointError(error)) {
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
      /*
       * 新建出来的工作区进 `hostWorkspaces`（和 follow 的权威行放在一起）：
       * 下一次 `loadInventory` / 增量帧合并时它不会被派生结果挤掉，选中状态也不会丢。
       */
      const host = state.hostWorkspaces.some((item) => item.workspaceId === workspace.workspaceId)
        ? state.hostWorkspaces.map((item) => (item.workspaceId === workspace.workspaceId ? workspace : item))
        : [...state.hostWorkspaces, workspace]
      useNewSessionStore.setState({
        creating: false,
        ...workspacePatch(state, host, state.derivedWorkspaces),
        selectedWorkspaceId: workspace.workspaceId,
        sheet: null,
        pathDraft: '',
        pathError: null,
        directory: null,
        notice: null,
      })
      return workspace
    } catch (error) {
      if (isMissingEndpointError(error)) {
        // 没有 `workspace/create` ≠ 没有工作区列表：只收起「新建工作区」这一行（老 Host）
        useNewSessionStore.setState({
          creating: false,
          capabilities: { ...useNewSessionStore.getState().capabilities, workspaceCreate: false },
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

  createAndSend: async (text: string): Promise<boolean> => {
    const trimmed = text.trim()
    if (trimmed.length === 0) return false
    const target = targetFor()
    if (target === null) {
      useNewSessionStore.setState({
        error: describeRemoteError({ code: 'NOT_CONNECTED' }).text,
        capabilities: CAPABILITIES_OFF,
      })
      return false
    }
    const state = useNewSessionStore.getState()
    if (state.creating) return false
    if (!state.capabilities.create) {
      useNewSessionStore.setState({ error: translate('newSessionCreateUnsupported') })
      return false
    }

    useNewSessionStore.setState({
      creating: true,
      error: null,
      notice: null,
      modelApply: initialModelApply,
      sheet: null,
    })
    try {
      const created = await createSession(target, {
        ...(state.selectedWorkspaceId === null ? {} : { workspaceId: state.selectedWorkspaceId }),
        ...(state.selectedAgentPreset.length === 0 ? {} : { agentPreset: state.selectedAgentPreset }),
      })

      // ── ① 权限预设：只能通过 `/permission <preset>` 生效（input-B §2.10），必须在进会话前设好，
      //      免得第一轮就跑在错的权限下。失败不该让「新建」失败 —— 记成 notice。
      const wanted = state.selectedPermission
      let notice: string | null = null
      if (wanted.length > 0 && wanted !== state.permissionDefault) {
        try {
          await applyPermissionPreset(target, created.sessionId, wanted)
        } catch (error) {
          notice = `${describeRemoteError(error).text}（${translate('newSessionPermissionNotApplied')}）`
          if (isMissingEndpointError(error)) {
            useNewSessionStore.setState({
              capabilities: { ...useNewSessionStore.getState().capabilities, permission: false },
            })
          }
        }
      }
      if (state.selectedAgentPreset.length > 0 && created.agentPreset !== state.selectedAgentPreset) {
        notice = translate('newSessionPresetNotApplied')
      }

      // ── ② 模型 + 思考强度：`session/create` 没有这两个字段，只能建完后设
      //      （`session/selectModel` → 退回 `session/initializeDefaultModel`，见 sessionsApi）。
      //      失败**不再拦住消息**：记一句 notice 继续发，Host 用默认模型接住 ——
      //      会话已经建出来了，把用户拦回「选设置」那一步比用默认模型更糟。
      const selection = modelSelectionToApply(state.modelPick)
      if (selection !== null) {
        useNewSessionStore.setState({ modelApply: { status: 'applying' } })
        try {
          const applied = await applySessionModel(target, created.sessionId, selection)
          const mismatch = await verifyAppliedModel(target, created.sessionId, applied.selection)
          // `defaultSave` 失败 ≠ 会话模型没切：只是「新对话默认」没存上，单独提示一句。
          const defaultSaveFailed = applied.defaultSave?.status === 'failed'
          useNewSessionStore.setState({
            modelApply: {
              status: 'idle',
              via: applied.via,
              ...(defaultSaveFailed ? { defaultSave: 'failed' } : {}),
            },
          })
          notice = mismatch ?? notice ?? (defaultSaveFailed ? translate('newSessionDefaultSaveFailed') : null)
        } catch (error) {
          if (isMissingEndpointError(error)) {
            useNewSessionStore.setState({
              capabilities: { ...useNewSessionStore.getState().capabilities, model: false },
            })
          }
          useNewSessionStore.setState({ modelApply: { status: 'idle' } })
          notice = `${errorText(error)}（${translate('newSessionModelFallback')}）`
        }
      }

      // ── ③ 刷列表 → 进会话 → 关新建页（`finishOpen` 一手包，notice 随它带出去）。
      await finishOpen(created.sessionId, notice)

      // ── ④ 把第一条消息发出去。`finishOpen` 已经 `await openSession`（follow 快照到手），
      //      所以这里发是安全的；失败不回滚会话 —— 错误写在时间线那一行上，会话是真实存在的。
      try {
        await useRemoteStore.getState().send(trimmed)
      } catch {
        // `sendFlow` 自己把失败写进时间线与 `store.error`，这里不再重复提示
      }
      return true
    } catch (error) {
      if (isMissingEndpointError(error)) {
        useNewSessionStore.setState({
          creating: false,
          capabilities: { ...useNewSessionStore.getState().capabilities, create: false },
        })
        return false
      }
      useNewSessionStore.setState({ creating: false, error: errorText(error) })
      return false
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
      useNewSessionStore.setState({ actionError: translate('newSessionTitleRequired') })
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
