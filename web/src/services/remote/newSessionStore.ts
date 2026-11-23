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

import { createId } from '../../utils/id.js'
import { translate } from '../../i18n/index.js'
import { readNewSessionDelivery, readNewSessionFiles, writeNewSessionDelivery, writeNewSessionFiles } from '../../components/remote/workspace/attachmentDraftDb.js'
import { outcomeToken, readRemoteTransport, uploadAttachment, workspaceUploadLimitBytes } from './upload.js'
import { compressImageFile, isCompressibleImage } from './imageCompress.js'
import { RemoteApiError } from './serverApi.js'
import {
  applyPermissionPreset,
  applySessionModel,
  archiveSession,
  createSession,
  createWorkspace,
  callEndpoint,
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
  parseWorkspace,
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
  type RemotePromptAttachment,
  type RemoteSearchHit,
  type RemoteSessionRow,
  type RemoteWorkspace,
  type RemoteWorkspaceFrame,
  type RemoteWorkspaceList,
} from './sessionsApi.js'
import { remoteDraftOwner, remoteSessionSelectionVersion, useRemoteStore } from './store.js'
import {
  emptyWorkspacePreferences,
  readWorkspacePreferences,
  writeWorkspacePreferences,
  type WorkspacePreferences,
} from './workspacePreferences.js'
import {
  deriveWorkspacesFromSessions,
  ensureWorkspaceStream,
  installWorkspaceSync,
  isMissingEndpointError,
  mergeWorkspaceInventory,
  workspacePathKey,
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

/**
 * [R17] 新对话页的**本地附件草稿**（还没上传，只是记着用户选了什么）。
 *
 * 为什么不立刻上传：两条上传通道（`fileUploads/upload` / `workspace.upload.*`）
 * 都是**会话级**的（`uploadAttachment(target, sessionId, …)`），而这一页还没有会话。
 * 所以照 dsh-Go 的做法（`ChatScreen._drafts`）：先存本地草稿，`createAndSend`
 * 建完会话之后再逐个上传、拿收据、随第一条消息发出去。
 */
export interface NewSessionDraftFile {
  id: string
  /** 展示名（Host 会做同样的消毒，这里只用于界面） */
  name: string
  size: number
  /** `File.type`；空串的存 undefined（与 workspacePaneStore 同一口径） */
  mediaType?: string
  /** 原始文件对象，发送时才读字节 */
  file: File
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
  pinnedAuthoritative: boolean
  /** 选中的工作区；`null` = 让 Host 用它自己的 cwd。 */
  selectedWorkspaceId: string | null

  /**
   * 会话列表的工作区筛选（R15，照 dsh-Go 的 `WorkspaceSwitcher` 抽屉作用域）：
   * `null` = 全部工作区。放在这个 store 是因为列表可能被反复挂载（手机抽屉 ↔ 平板常驻），
   * 本地 state 会跟着丢；跟 `selectedWorkspaceId` 一样换连接时在 `loadInventory` 里复位。
   */
  listWorkspaceFilter: string | null
  workspacePreferences: WorkspacePreferences

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

  /* ── [R17] 新对话页的本地附件草稿（见 NewSessionDraftFile 的注释） ── */
  draftFiles: NewSessionDraftFile[]

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
  pinWorkspace(workspaceId: string, pinned: boolean): void
  groupWorkspace(workspaceId: string, name: string): void
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
  createAndSend(text: string, options?: {
    signal: AbortSignal
    onDispatch(sessionId: string, before: Set<string>, requestId: string | undefined): void
  }): Promise<boolean>
  /** [R17] 新对话页选了文件 → 本地草稿（不上传；`createAndSend` 建完会话才传）。 */
  addDraftFiles(files: readonly File[]): void
  /** [R17] 从草稿里移除一个附件。 */
  removeDraftFile(id: string): void
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
  fork(sessionId: string, atSeq?: number): Promise<string | null>
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
let workspacePreferencesOwner: string | null = null

function saveWorkspacePreferences(preferences: WorkspacePreferences) {
  if (inventoryTarget === null || targetFor() !== inventoryTarget) return
  writeWorkspacePreferences(workspacePreferencesOwner, preferences)
  useNewSessionStore.setState({ workspacePreferences: preferences })
}
/** `refresh()` 单飞。 */
let refreshInFlight: { target: RemoteCallTarget; task: Promise<void> } | null = null
/** 搜索请求序号：慢的旧请求不许覆盖新结果。 */
let searchSeq = 0
let panelVersion = 0
let directorySeq = 0
/** 这一代连接上 `workspace/follow` 的 baseline 是否已经到过（决定 `workspaceSource`）。 */
let baselineReceived = false
/** First-send setup and upload receipts belong to the verified Host and the created session. */
interface PendingFirstSend {
  sessionId: string
  configuration: string
  receipts: Map<string, string>
}

type DraftHost = string | RemoteCallTarget
const pendingFirstSends = new Map<DraftHost, PendingFirstSend | null>()
let deliveryGeneration = 0

async function restorePendingFirstSend(owner: DraftHost): Promise<PendingFirstSend | null> {
  if (!pendingFirstSends.has(owner) && typeof owner === 'string' && typeof indexedDB !== 'undefined') {
    const generation = deliveryGeneration
    const saved = await readNewSessionDelivery(owner).catch(() => undefined)
    if (generation === deliveryGeneration && !pendingFirstSends.has(owner)) {
      pendingFirstSends.set(owner, saved ? { ...saved, receipts: new Map(saved.receipts) } : null)
    }
  }
  return pendingFirstSends.get(owner) ?? null
}

async function savePendingFirstSend(owner: DraftHost, delivery: PendingFirstSend | null): Promise<void> {
  pendingFirstSends.set(owner, delivery)
  if (typeof owner !== 'string' || typeof indexedDB === 'undefined') return
  const generation = deliveryGeneration
  const isCurrent = () => generation === deliveryGeneration && pendingFirstSends.get(owner) === delivery
  await writeNewSessionDelivery(owner, delivery === null ? null : { ...delivery, receipts: [...delivery.receipts] }, isCurrent)
    .catch(() => undefined)
}
const draftFilesByHost = new Map<string | RemoteCallTarget, NewSessionDraftFile[]>()
const draftFileReads = new Map<string, Promise<void>>()
const draftHostKey = () => remoteDraftOwner() ?? targetFor()
const assignDraftFiles = (key: string | RemoteCallTarget, draftFiles: NewSessionDraftFile[]): void => {
  if (draftFiles.length === 0) draftFilesByHost.delete(key)
  else draftFilesByHost.set(key, draftFiles)
  if (key === draftHostKey()) useNewSessionStore.setState({ draftFiles })
}

const loadDraftFiles = (key = draftHostKey()): NewSessionDraftFile[] =>
  key === null ? [] : draftFilesByHost.get(key) ?? []

function restoreNewSessionFiles(owner = draftHostKey()): Promise<void> | undefined {
  if (typeof owner !== 'string' || typeof indexedDB === 'undefined') return
  const pending = draftFileReads.get(owner)
  if (pending !== undefined) return pending
  const read = readNewSessionFiles(owner).then((restored) => {
    if (draftFileReads.get(owner) !== read || restored.length === 0) return
    const drafts = loadDraftFiles(owner)
    const ids = new Set(drafts.map((file) => file.id))
    assignDraftFiles(owner, [...restored.filter((file) => !ids.has(file.id)), ...drafts])
  }).catch(() => undefined)
  draftFileReads.set(owner, read)
  return read
}

function saveDraftFiles(draftFiles: NewSessionDraftFile[], key = draftHostKey()) {
  if (key === null) return
  assignDraftFiles(key, draftFiles)
  if (typeof key !== 'string') return
  const read = restoreNewSessionFiles(key)
  if (read === undefined) return
  const isCurrent = () => draftFileReads.get(key) === read
  void read.then(async () => {
    if (isCurrent()) await writeNewSessionFiles(key, loadDraftFiles(key), isCurrent)
  }).catch(() => undefined)
}

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
    onBaseline: (list) => {
      const target = targetFor()
      if (target === null) return
      bindInventoryTarget(target)
      useNewSessionStore.getState().applyWorkspaceBaseline(list)
    },
    onDelta: (frame) => useNewSessionStore.getState().applyWorkspaceFrame(frame),
    onStatus: (status, failure) => {
      const target = targetFor()
      if (target === null) return
      bindInventoryTarget(target)
      useNewSessionStore.getState().setWorkspaceFollowStatus(status, failure)
    },
  })
}

/** 两份数据合并 + 「选中的工作区还在不在」这条一致性修补。 */
const workspacePatch = (
  state: NewSessionState,
  host: readonly RemoteWorkspace[],
  derived: readonly RemoteWorkspace[],
): Partial<NewSessionState> => {
  const hostIds = new Set(host.map((workspace) => workspace.workspaceId))
  const fallback = baselineReceived
    ? derived.filter((workspace) => hostIds.has(workspace.workspaceId)).map((workspace) => ({ ...workspace, sessionIds: [] }))
    : derived
  const workspaces = mergeWorkspaceInventory(host, fallback)
  const selected = state.selectedWorkspaceId
  const keepSelected = selected === null || workspaces.some((item) => item.workspaceId === selected)
  return {
    hostWorkspaces: [...host],
    derivedWorkspaces: [...derived],
    workspaces,
    ...(keepSelected ? {} : { selectedWorkspaceId: null }),
  }
}

export type WorkspaceChange =
  | { kind: 'rename'; title: string }
  | { kind: 'remove' }
  | { kind: 'reorder'; beforeWorkspaceId?: string }

function orderWorkspaces(workspaces: readonly RemoteWorkspace[], workspaceIds: readonly string[]): RemoteWorkspace[] {
  const byId = new Map(workspaces.map((workspace) => [workspace.workspaceId, workspace]))
  const ordered: RemoteWorkspace[] = []
  for (const id of workspaceIds) {
    const workspace = byId.get(id)
    if (workspace === undefined) continue
    ordered.push(workspace)
    byId.delete(id)
  }
  return [...ordered, ...byId.values()]
}

export async function changeHostWorkspace(target: RemoteCallTarget, workspaceId: string, change: WorkspaceChange) {
  const original = useNewSessionStore.getState()
  if (targetFor() !== target || !original.hostWorkspaces.some((item) => item.workspaceId === workspaceId)) {
    throw new RemoteApiError('NOT_FOUND', 'This workspace is no longer available on the connected Host.')
  }
  if (change.kind === 'rename') {
    const title = change.title.trim()
    if (!title || title.length > 80) throw new RemoteApiError('INVALID_ARGUMENT', 'Invalid workspace title.')
    const result = await callEndpoint<{ workspace?: unknown }>(target, 'workspace/rename', { request: { workspaceId, title } })
    if (targetFor() !== target) return
    const workspace = parseWorkspace(result?.workspace)
    if (workspace?.workspaceId !== workspaceId) throw new RemoteApiError('INVALID_MESSAGE', 'Invalid workspace response.')
    useNewSessionStore.getState().applyWorkspaceFrame({ kind: 'upsert', workspace })
  } else if (change.kind === 'remove') {
    await callEndpoint(target, 'workspace/delete', { request: { workspaceId } })
    if (targetFor() !== target) return
    useNewSessionStore.getState().applyWorkspaceFrame({ kind: 'remove', workspaceId })
    const preferences = useNewSessionStore.getState().workspacePreferences
    const groups = { ...preferences.groups }
    delete groups[workspaceId]
    saveWorkspacePreferences({ ...preferences, groups, pinned: preferences.pinned.filter((id) => id !== workspaceId) })
  } else {
    const { beforeWorkspaceId } = change
    const result = await callEndpoint<{ workspaceIds?: unknown }>(target, 'workspace/insertBefore', {
      request: { workspaceId, ...(beforeWorkspaceId === undefined ? {} : { beforeWorkspaceId }) },
    })
    if (targetFor() !== target) return
    if (!Array.isArray(result?.workspaceIds) || !result.workspaceIds.every((id: unknown) => typeof id === 'string')) {
      throw new RemoteApiError('INVALID_MESSAGE', 'Invalid workspace order.')
    }
    useNewSessionStore.getState().applyWorkspaceFrame({ kind: 'order', workspaceIds: result.workspaceIds })
  }
}

export async function reorderHostWorkspaceSession(
  target: RemoteCallTarget, workspaceId: string, sessionId: string, beforeSessionId?: string,
): Promise<void> {
  const workspace = useNewSessionStore.getState().hostWorkspaces.find((item) => item.workspaceId === workspaceId)
  if (targetFor() !== target || !workspace?.sessionIds.includes(sessionId) || beforeSessionId === sessionId ||
      (beforeSessionId !== undefined && !workspace.sessionIds.includes(beforeSessionId))) {
    throw new RemoteApiError('NOT_FOUND', 'The session or workspace is no longer available on the connected Host.')
  }
  const result = await callEndpoint<{ workspace?: unknown }>(target, 'workspace/insertSessionBefore', {
    request: { workspaceId, sessionId, ...(beforeSessionId === undefined ? {} : { beforeSessionId }) },
  })
  if (targetFor() !== target) return
  const updated = parseWorkspace(result?.workspace)
  const position = updated?.sessionIds.indexOf(sessionId) ?? -1
  if (updated?.workspaceId !== workspaceId || position < 0) {
    throw new RemoteApiError('INVALID_MESSAGE', 'Invalid workspace session order.')
  }
  if (updated.sessionIds[position + 1] !== beforeSessionId) {
    throw new RemoteApiError('UNAVAILABLE', translate('remoteWorkspaceSessionOrderUnavailable'))
  }
  const state = useNewSessionStore.getState()
  // A concurrent authoritative stream update can have newer membership or metadata than this reply.
  if (state.hostWorkspaces.find((item) => item.workspaceId === workspaceId) === workspace) {
    state.applyWorkspaceFrame({ kind: 'upsert', workspace: updated })
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
const openCreatedSession = async (
  target: RemoteCallTarget, sessionId: string, panel: number,
): Promise<boolean> => {
  if (targetFor() !== target) return false
  useNewSessionStore.setState({
    lastCreatedSessionId: sessionId,
    sheet: null,
    // `modelApply` 不在这里清：调用方刚写进去的 `via` / `defaultSave` 是诊断信息，
    // 留给下一次 `openPanel()` / `closePanel()` 复位（它不影响任何 UI 判定）。
  })
  refreshRemoteSessions()
  const opened = useRemoteStore.getState().openSession(sessionId)
  const selection = remoteSessionSelectionVersion()
  await opened
  if (targetFor() !== target || panelVersion !== panel || remoteSessionSelectionVersion() !== selection ||
    useRemoteStore.getState().activeSessionId !== sessionId) return false
  return true
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
  pinnedAuthoritative: false,
  selectedWorkspaceId: null,
  listWorkspaceFilter: null as string | null,
  workspacePreferences: emptyWorkspacePreferences,
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
  draftFiles: [] as NewSessionDraftFile[],
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
const bindInventoryTarget = (target: RemoteCallTarget): void => {
  if (inventoryTarget === target) return
  searchSeq += 1
  directorySeq += 1
  inventoryTarget = target
  workspacePreferencesOwner = remoteDraftOwner()
  baselineReceived = false
  const { open, loading } = useNewSessionStore.getState()
  useNewSessionStore.setState({
    ...INITIAL_STATE, open, loading,
    capabilities: CAPABILITIES_ON,
    workspacePreferences: readWorkspacePreferences(workspacePreferencesOwner),
    draftFiles: loadDraftFiles(),
  })
}

const loadInventory = async (target: RemoteCallTarget): Promise<void> => {
  bindInventoryTarget(target)
  const rows = await listSessions(target)
  if (targetFor() !== target) return
  const state = useNewSessionStore.getState()
  const derived = deriveWorkspacesFromSessions(rows)
  let host = state.hostWorkspaces
  const patch: Partial<NewSessionState> = {
    rows,
    derivedWorkspaces: derived,
    capabilities: { ...state.capabilities, workspace: true },
  }
  if (!state.pinnedAuthoritative) {
    patch.pinnedSessionIds = rows.filter((row) => row.pinned === true).map((row) => row.sessionId)
  }

  if (workspaceBaselineReader !== null) {
    /*
     * 备用通道：有人注册了一次性 reader 就用它（读首帧后自己关流）。
     * 生产没人注册，走下面的常驻流。
     */
    try {
      const baseline = await workspaceBaselineReader(target)
      if (targetFor() !== target) return
      if (baseline !== null) {
        host = baseline.items
        baselineReceived = true
        patch.archivedSessionIds = baseline.archivedSessionIds
        if (baseline.pinnedReported === true || baseline.pinnedSessionIds.length > 0) {
          patch.pinnedSessionIds = baseline.pinnedSessionIds
          patch.pinnedAuthoritative = true
        }
      }
    } catch (error) {
      if (targetFor() !== target) return
      if (isMissingEndpointError(error)) patch.workspaceFollow = 'unsupported'
      else patch.error = errorText(error)
    }
  } else {
    installWorkspaceStream()
    ensureWorkspaceStream()
  }

  Object.assign(patch, workspacePatch(useNewSessionStore.getState(), host, derived))
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
    if (targetFor() !== target) return
    useNewSessionStore.setState({
      permissionOptions: catalog.options,
      permissionDefault: catalog.defaultPreset,
      permissionLoaded: true,
      capabilities: { ...useNewSessionStore.getState().capabilities, permission: catalog.options.length > 0 },
    })
  } catch (error) {
    if (targetFor() !== target) return
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
    if (targetFor() !== target) return
    useNewSessionStore.setState({
      agentPresets: presets,
      agentPresetsLoaded: true,
      capabilities: { ...useNewSessionStore.getState().capabilities, agentPreset: presets.length > 0 },
    })
  } catch (error) {
    if (targetFor() !== target) return
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
    if (targetFor() !== target) return
    useNewSessionStore.setState({
      modelCatalog: catalog,
      modelCatalogLoaded: true,
      capabilities: {
        ...useNewSessionStore.getState().capabilities,
        model: catalog.models.length > 0,
      },
    })
  } catch (error) {
    if (targetFor() !== target) return
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
    panelVersion += 1
    useNewSessionStore.setState({
      open: true,
      lastCreatedSessionId: null,
      error: null,
      notice: null,
      actionError: null,
      sheet: null,
      pathError: null,
      directory: null,
      directoryError: null,
      modelApply: initialModelApply,
    })
    void restoreNewSessionFiles()
    void useNewSessionStore.getState().refresh()
  },

  closePanel: (): void => {
    panelVersion += 1
    directorySeq += 1
    useNewSessionStore.setState({
      open: false,
      menuSessionId: null,
      renameTarget: null,
      sheet: null,
      modelApply: initialModelApply,
      directoryLoading: false,
      creating: false,
    })
  },

  refresh: async (): Promise<void> => {
    const target = targetFor()
    if (target === null) {
      // 还没连上：能力全关（面板只显示一行「先连上」的说明），不报错
      useNewSessionStore.setState({ capabilities: CAPABILITIES_OFF, loading: false })
      return
    }
    if (refreshInFlight?.target === target) {
      await refreshInFlight.task
      return
    }
    useNewSessionStore.setState({ loading: true })
    const task = (async (): Promise<void> => {
      try {
        await loadInventory(target)
        if (targetFor() !== target) return
        useNewSessionStore.setState({
          capabilities: { ...useNewSessionStore.getState().capabilities, create: true },
        })
      } catch (error) {
        if (targetFor() !== target) return
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
      if (targetFor() === target) useNewSessionStore.setState({ loading: false })
    })()
    refreshInFlight = { target, task }
    try {
      await task
    } finally {
      if (refreshInFlight?.task === task) refreshInFlight = null
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
    if (list.pinnedReported === true || list.pinnedSessionIds.length > 0) {
      patch.pinnedSessionIds = list.pinnedSessionIds
      patch.pinnedAuthoritative = true
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
    if (frame.kind === 'pinned') {
      useNewSessionStore.setState({ pinnedSessionIds: frame.sessionIds, pinnedAuthoritative: true })
      return
    }
    if (frame.kind === 'archived') {
      useNewSessionStore.setState({ archivedSessionIds: frame.sessionIds })
      return
    }
    if (frame.kind === 'order') {
      useNewSessionStore.setState(workspacePatch(state,
        orderWorkspaces(state.hostWorkspaces, frame.workspaceIds), state.derivedWorkspaces))
      return
    }
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
      baselineReceived = false
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
    if (targetFor() !== null) await useNewSessionStore.getState().refresh()
  },

  selectWorkspace: (workspaceId: string | null): void => {
    useNewSessionStore.setState({ selectedWorkspaceId: workspaceId })
  },

  selectListWorkspace: (filter: string | null): void => {
    useNewSessionStore.setState({ listWorkspaceFilter: filter })
  },

  pinWorkspace: (workspaceId, pinned): void => {
    const { workspaces, workspacePreferences } = useNewSessionStore.getState()
    if (!workspaces.some((item) => item.workspaceId === workspaceId)) return
    const remaining = workspacePreferences.pinned.filter((id) => id !== workspaceId)
    saveWorkspacePreferences({ ...workspacePreferences, pinned: pinned ? [workspaceId, ...remaining] : remaining })
  },

  groupWorkspace: (workspaceId, name): void => {
    const { workspaces, workspacePreferences } = useNewSessionStore.getState()
    if (!workspaces.some((item) => item.workspaceId === workspaceId)) return
    const group = name.trim().slice(0, 80)
    const groups = { ...workspacePreferences.groups, [workspaceId]: group }
    if (!group) delete groups[workspaceId]
    saveWorkspacePreferences({ ...workspacePreferences, groups })
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
    const sequence = ++directorySeq
    const stillBrowsing = () => targetFor() === target && sequence === directorySeq
    useNewSessionStore.setState({ directoryLoading: true, directoryError: null })
    try {
      const listing = await listDirectory(target, path)
      if (!stillBrowsing()) return
      useNewSessionStore.setState({ directory: listing, directoryLoading: false })
    } catch (error) {
      if (!stillBrowsing()) return
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
    const panel = panelVersion
    const isCurrent = () => targetFor() === target && panelVersion === panel
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
      if (!isCurrent()) return null
      const state = useNewSessionStore.getState()
      const rememberedPath = workspace.path || path
      const previousDirectories = state.workspacePreferences.recentDirectories
      saveWorkspacePreferences({
        ...state.workspacePreferences,
        recentDirectories: [rememberedPath, ...previousDirectories.filter((recent) =>
          workspacePathKey(recent) !== workspacePathKey(rememberedPath))].slice(0, 8),
      })
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
      if (!isCurrent()) return null
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

  createAndSend: async (text, options): Promise<boolean> => {
    const trimmed = text.trim()
    const target = targetFor()
    const draftHost = draftHostKey() ?? target
    const panel = panelVersion
    const selection = remoteSessionSelectionVersion()
    const canContinue = () => !options?.signal.aborted && targetFor() === target && panelVersion === panel &&
      remoteSessionSelectionVersion() === selection
    if (target === null || draftHost === null) {
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
    const transport = readRemoteTransport()

    const configuration = JSON.stringify([
      state.selectedWorkspaceId, state.selectedAgentPreset, state.selectedPermission, state.modelPick,
    ])

    useNewSessionStore.setState({
      creating: true,
      error: null,
      notice: null,
      modelApply: initialModelApply,
      sheet: null,
    })
    try {
      const restored = restoreNewSessionFiles(draftHost)
      const pending = typeof draftHost === 'string'
        ? await Promise.all([restorePendingFirstSend(draftHost), restored]).then(result => result[0])
        : pendingFirstSends.get(draftHost) ?? null
      if (!canContinue() || draftHostKey() !== draftHost) return false
      const drafts = loadDraftFiles(draftHost)
      if (trimmed.length === 0 && drafts.length === 0) return false
      let destination = pending?.configuration === configuration ? pending : null
      let notice: string | null = null
      if (destination === null) {
        const created = await createSession(target, {
          ...(state.selectedWorkspaceId === null ? {} : { workspaceId: state.selectedWorkspaceId }),
          ...(state.selectedAgentPreset.length === 0 ? {} : { agentPreset: state.selectedAgentPreset }),
        })
        if (!canContinue()) return false
        destination = { sessionId: created.sessionId, configuration, receipts: new Map() }

        // ── ① 权限预设：只能通过 `/permission <preset>` 生效（input-B §2.10），必须在进会话前设好，
        //      免得第一轮就跑在错的权限下。失败不该让「新建」失败 —— 记成 notice。
        const wanted = state.selectedPermission
        if (wanted.length > 0 && wanted !== state.permissionDefault) {
          try {
            await applyPermissionPreset(target, created.sessionId, wanted)
          } catch (error) {
            if (!canContinue()) return false
            notice = `${describeRemoteError(error).text}（${translate('newSessionPermissionNotApplied')}）`
            if (isMissingEndpointError(error)) {
              useNewSessionStore.setState({
                capabilities: { ...useNewSessionStore.getState().capabilities, permission: false },
              })
            }
          }
        }
        if (!canContinue()) return false
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
            if (!canContinue()) return false
            const mismatch = await verifyAppliedModel(target, created.sessionId, applied.selection)
            if (!canContinue()) return false
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
            if (!canContinue()) return false
            if (isMissingEndpointError(error)) {
              useNewSessionStore.setState({
                capabilities: { ...useNewSessionStore.getState().capabilities, model: false },
              })
            }
            useNewSessionStore.setState({ modelApply: { status: 'idle' } })
            notice = `${errorText(error)}（${translate('newSessionModelFallback')}）`
          }
        }
        await savePendingFirstSend(draftHost, destination)
        if (!canContinue()) return false
      }

      /*
       * ── ②b 附件（R17）：两条上传通道都是**会话级**的（`uploadAttachment(target,
       *      sessionId, …)`），所以只能在这一刻传 —— dsh-Go 也是建完会话才把 `_drafts`
       *      落上去的。失败停在新对话页：红字 + 草稿都在、文本由调用方还回去，
       *      保留目标会话及已成功的上传，供同一主机重试。
       */
      const blocks: RemotePromptAttachment[] = []
      const { sessionId, receipts } = destination
      for (const draft of drafts) {
        const receipt = receipts.get(draft.id)
        if (receipt !== undefined) {
          blocks.push({ type: 'file', receiptId: receipt })
          continue
        }
        try {
          /*
           * 图片先压再传（与聊天页 `workspacePaneStore.uploadOne` 同一条策略）：
           * 手机照片 6–15 MiB 在 relay 上直接超限，压到 1–2 MiB 才传得上去。
           * 压不动就原样传，绝不因此拦下文件。
           */
          let payload: Blob = draft.file
          let name = draft.name
          let mediaType = draft.mediaType
          if (isCompressibleImage({ type: draft.mediaType ?? draft.file.type, name: draft.name })) {
            const cap = Math.floor(workspaceUploadLimitBytes(transport) * 0.85)
            const compressed = await compressImageFile(draft.file, cap)
            if (compressed.compressed) {
              payload = compressed.blob
              name = compressed.name
              mediaType = compressed.mediaType
            }
          }
          const bytes = new Uint8Array(await payload.arrayBuffer())
          if (!canContinue()) return false
          const outcome = await uploadAttachment(target, sessionId, {
            name,
            bytes,
            ...(mediaType === undefined ? {} : { mediaType }),
          })
          const receiptId = outcomeToken(outcome)
          if (!canContinue()) return false
          receipts.set(draft.id, receiptId)
          await savePendingFirstSend(draftHost, destination)
          if (!canContinue()) return false
          blocks.push({ type: 'file', receiptId })
        } catch (error) {
          if (!canContinue()) return false
          useNewSessionStore.setState({
            creating: false,
            error: translate('newSessionAttachmentFailed', {
              name: draft.name,
              reason: errorText(error),
            }),
          })
          return false
        }
      }

      // Keep the composer open through the first send so a rejection can restore its draft.
      if (!canContinue() || !(await openCreatedSession(target, sessionId, panel))) return false
      if (options?.signal.aborted) return false
      const openedSelection = remoteSessionSelectionVersion()
      const before = options && new Set(useRemoteStore.getState().items.map((item) => item.id))
      const delivery = useRemoteStore.getState().sendToSession(target, sessionId, trimmed, blocks)
      if (options && before) {
        const pending = useRemoteStore.getState().items.findLast((item) =>
          item.kind === 'message' && item.role === 'user' && item.sessionId === sessionId && !before.has(item.id))
        options.onDispatch(sessionId, before, pending?.kind === 'message' ? pending.requestRpcId : undefined)
      }
      const sent = await delivery
      const stillOpen = targetFor() === target && panelVersion === panel &&
        remoteSessionSelectionVersion() === openedSelection
      if (!sent) {
        if (stillOpen) useNewSessionStore.setState({ error: useRemoteStore.getState().error?.message ?? translate('remoteNotConnected') })
        return false
      }
      const sentIds = new Set(drafts.map((draft) => draft.id))
      if (pendingFirstSends.get(draftHost) === destination) {
        saveDraftFiles(loadDraftFiles(draftHost).filter((draft) => !sentIds.has(draft.id)), draftHost)
        await savePendingFirstSend(draftHost, null)
      }
      if (stillOpen) useNewSessionStore.setState({ open: false, notice })
      return true
    } catch (error) {
      if (targetFor() !== target || panelVersion !== panel) return false
      if (isMissingEndpointError(error)) {
        useNewSessionStore.setState({
          creating: false,
          capabilities: { ...useNewSessionStore.getState().capabilities, create: false },
        })
        return false
      }
      useNewSessionStore.setState({ creating: false, error: errorText(error) })
      return false
    } finally {
      if (targetFor() === target && panelVersion === panel) useNewSessionStore.setState({ creating: false })
    }
  },

  addDraftFiles: (files: readonly File[]): void => {
    const current = loadDraftFiles()
    const added = files
      .filter((file) => file.size > 0 || file.name.length > 0)
      .map((file) => ({
        id: createId(),
        name: file.name.length > 0 ? file.name : 'file',
        size: file.size,
        ...(file.type.length === 0 ? {} : { mediaType: file.type }),
        file,
      }))
    if (added.length === 0) return
    saveDraftFiles([...current, ...added])
    useNewSessionStore.setState({ error: null })
  },

  removeDraftFile: (id: string): void => {
    saveDraftFiles(loadDraftFiles().filter((item) => item.id !== id))
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

    const target = targetFor()
    const finish = (hits: RemoteSearchHit[], local: boolean): void => {
      if (seq !== searchSeq || targetFor() !== target) return
      useNewSessionStore.setState({ search: { query, searching: false, hits, local } })
    }

    if (target !== null && useNewSessionStore.getState().capabilities.search) {
      try {
        const result = await searchSessions(target, trimmed)
        finish(result.items, false)
        return
      } catch {
        // 索引没开（gateway/internal）、没这个端点、参数被拒 —— 一律降级到本地
        if (seq === searchSeq && targetFor() === target) {
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
      if (targetFor() !== target) return
      const state = useNewSessionStore.getState()
      useNewSessionStore.setState({
        busySessionId: null,
        renameTarget: null,
        rows: state.rows.map((row) => (row.sessionId === rename.sessionId ? { ...row, title: committed } : row)),
      })
      refreshRemoteSessions()
    } catch (error) {
      if (targetFor() === target) manageFailed(error)
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
      if (targetFor() !== target) return
      useNewSessionStore.setState({ busySessionId: null, pinnedSessionIds: result.sessionIds, pinnedAuthoritative: true })
      refreshRemoteSessions()
    } catch (error) {
      if (targetFor() === target) manageFailed(error)
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
      if (targetFor() !== target) return
      useNewSessionStore.setState({ busySessionId: null, archivedSessionIds: result.sessionIds })
      refreshRemoteSessions()
    } catch (error) {
      if (targetFor() === target) manageFailed(error)
    }
  },

  fork: async (sessionId: string, atSeq?: number): Promise<string | null> => {
    const target = targetFor()
    if (target === null || useNewSessionStore.getState().busySessionId !== null) return null
    if (atSeq !== undefined && (!Number.isSafeInteger(atSeq) || atSeq < 0)) return null
    const selection = remoteSessionSelectionVersion()
    const panel = panelVersion
    useNewSessionStore.setState({ busySessionId: sessionId, menuSessionId: null, actionError: null })
    try {
      const forkedId = await forkSession(target, sessionId, atSeq)
      if (targetFor() !== target) return null
      refreshRemoteSessions()
      if (remoteSessionSelectionVersion() !== selection || panelVersion !== panel ||
        useNewSessionStore.getState().open) return null
      const opened = useRemoteStore.getState().openSession(forkedId)
      const openedSelection = remoteSessionSelectionVersion()
      await opened
      return targetFor() === target && remoteSessionSelectionVersion() === openedSelection &&
        panelVersion === panel && useRemoteStore.getState().activeSessionId === forkedId ? forkedId : null
    } catch (error) {
      if (targetFor() === target) manageFailed(error)
      return null
    } finally {
      if (targetFor() === target && useNewSessionStore.getState().busySessionId === sessionId) {
        useNewSessionStore.setState({ busySessionId: null })
      }
    }
  },
}))

useRemoteStore.subscribe((state, previous) => {
  if (state.lastSession === null && previous.lastSession !== null) {
    deliveryGeneration++
    pendingFirstSends.clear()
    draftFileReads.clear()
    draftFilesByHost.clear()
    useNewSessionStore.setState({ draftFiles: [] })
  }
  if (state.phase !== previous.phase || state.hostId !== previous.hostId || state.activeServerUrl !== previous.activeServerUrl) {
    useNewSessionStore.setState({ draftFiles: loadDraftFiles() })
    if (useNewSessionStore.getState().open) void restoreNewSessionFiles()
  }
})
