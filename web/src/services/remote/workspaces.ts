/**
 * **工作区列表的同步器（S2）**：一条常驻的 `workspace/follow` 流 + 两份数据的合并规则。
 *
 * ```
 *   workspace/follow ──► 常驻流（本文件） ──► useNewSessionStore
 *         │                  │                   ├─ hostWorkspaces（权威）
 *   session/list ──► 派生 ───┘                   ├─ derivedWorkspaces（补 cwd / 显示名）
 *                                                └─ workspaces = merge(host, derived)
 * ```
 *
 * ## 为什么必须走 `workspace/follow`
 *
 * 之前的工作区列表是**从 `session/list` 的 `workspaceId` + `cwd` 派生**的 —— 没有会话的
 * 工作区根本列不出来。用户反馈「它没有识别到我 DeepSeek 里面已经用过的工作区」就是这个原因：
 * Host 那边工作区是独立的一张表，只有 `workspace/follow` 的首帧 `baseline`
 * （`{items, archivedSessionIds, pinnedSessionIds?}`，input-B §2.1）给全量。
 *
 * ## 流的纪律（这一版新增）
 *
 * | 事件 | 动作 |
 * |---|---|
 * | 连接就绪（`phase` → `ready`） | `ensure()` 开流（一条，每连接最多 16 条 stream，别浪费名额） |
 * | 首帧 `baseline` | 交给 `push.onBaseline()`，退避计数清零 |
 * | 增量帧 | `parseWorkspaceFrame()` 认出 upsert / remove 就交给 `push.onDelta()`，认不出就忽略 |
 * | `closed` 帧 | **先 `off()` 摘掉接收器**，再按退避（0.4s / 1.2s / 3s / 8s…）重开 |
 * | 开流 `METHOD_NOT_FOUND` 等 | 标 `unsupported`：老 Host 没有这个端点 → **不重试**，`newSessionStore` 退回派生列表且**不收起 UI** |
 * | 其它开流失败（网络 / 超时） | 不改能力，按同一套退避重试（静默，不往面板写红字） |
 * | 连接断开 | `reset()`：关流、清定时器、状态回 `idle`（**不清**已拿到的列表） |
 *
 * 之所以「流关闭要在重连后重开」：Host 在通道抖动 / 会话切换后会主动 `stream.closed`，
 * 而 baseline 只在**开流那一刻**发一次；不重开就永远收不到后续增量，而且客户端会拿着
 * 一份越来越旧的权威列表画界面。
 *
 * ## 合并规则（`mergeWorkspaceInventory`）
 *
 * 1. **`hostWorkspaces`（follow）权威**：`workspaceId` / `path` / `title` / `sessionIds` 都以它为准；
 * 2. 派生的只用来**补缺**：follow 那一行 `path` 空 ← 用同 id 会话里最新的 `cwd`；
 *    `title` 空 ← 用派生标题 / 路径末段（官方也是「标题为空就显示文件夹名」）；
 * 3. **去重**两层：同 `workspaceId` 合成一行；同一个目录挂了两个 id（Host 重复注册）也合成一行，
 *    会话 id 取并集；
 * 4. 派生里有、follow 里没有的工作区（会话引用着它）**保留**并排在最后 —— 它们是真的，
 *    只是 Host 的基线里没有（例如基线未到 / 老 Host）。
 *
 * ## 为什么不把状态放在这里
 *
 * 本文件只做「开流 / 收帧 / 合并」这三件纯事，状态归 `newSessionStore.ts`（它才是 UI 的数据源）。
 * 代价是装流时要由那边把三个回调传进来（`WorkspaceSyncPush`），好处是**没有循环依赖**：
 *
 * ```
 *  newSessionStore.ts ──► workspaces.ts ──► store.ts / sessionsApi.ts
 * ```
 *
 * 反向没有边，所以 `useNewSessionStore` 不会在模块初始化阶段被本文件碰到（TDZ 的老坑）。
 */

import type { StreamEventPayload } from './core/index.js'
import {
  lastRemoteTarget,
  openWorkspaceFollow,
  parseWorkspaceBaseline,
  parseWorkspaceFrame,
  type RemoteCallTarget,
  type RemoteSessionRow,
  type RemoteStreamHandle,
  type RemoteWorkspace,
  type RemoteWorkspaceFrame,
  type RemoteWorkspaceList,
} from './sessionsApi.js'
import { registerRemoteStreamSink, useRemoteStore } from './store.js'

/* ────────────────────────────────────────────────────────────────────────
 * 一、状态与回调
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * `workspace/follow` 这条流的状态。
 *
 * - `idle`：还没开 / 关了 / 正在重试（列表保留上一份，不清空）；
 * - `streaming`：流开着（baseline 可能还没到，此时列表仍是派生的）；
 * - `unsupported`：这台 Host 没有这个端点（老版本）→ 走派生列表，**UI 不收起**。
 */
export type WorkspaceFollowStatus = 'idle' | 'streaming' | 'unsupported'

/** 一次失败的可读描述（`missingEndpoint` = 老 Host 没有这个端点，不该当错误显示）。 */
export interface WorkspaceSyncFailure {
  code?: string
  message: string
  missingEndpoint: boolean
}

/** 同步器把数据推给 store 的三个入口（`newSessionStore.ts` 实现）。 */
export interface WorkspaceSyncPush {
  onBaseline(list: RemoteWorkspaceList): void
  onDelta(frame: RemoteWorkspaceFrame): void
  onStatus(status: WorkspaceFollowStatus, failure?: WorkspaceSyncFailure): void
}

/* ────────────────────────────────────────────────────────────────────────
 * 二、纯函数：标题 / 派生 / 合并
 * ──────────────────────────────────────────────────────────────────────── */

/** `path` → 显示标题（POSIX / Windows 都认），与 dsh-Go 的 `workspaceTitle()` 同一规则。 */
export const workspaceTitleFromPath = (path: string): string => {
  const parts = path.split(/[\\/]+/).filter((part) => part.length > 0)
  if (parts.length === 0) return path
  const last = parts[parts.length - 1]
  return last === undefined || last.length === 0 ? path : last
}

/**
 * 从 `session/list` 的行**派生**工作区列表（`workspace/follow` 拿不到时的退路）。
 *
 * 规则：
 *   - 按 `workspaceId` 归组，只认有 `workspaceId` 的行（子会话先剔掉）；
 *   - `path` 取组内 `updatedAt` 最新那一行的 `cwd`（Host 把工作区路径落在会话 cwd 上）；
 *   - `title` 取路径末段（官方也是「标题为空就显示文件夹名」，见 dsh-Go `workspaceTitle`）；
 *   - `sessionIds` 按 `updatedAt` 倒序。
 *
 * 已知代价：**没有任何会话的工作区列不出来** —— 这正是要接 `workspace/follow` 的原因。
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

/** 路径比较用的归一化（Windows 反斜杠 / 大小写 / 结尾分隔符都不该算两个目录）。 */
export const workspacePathKey = (path: string): string =>
  path.trim().replace(/\\/gu, '/').replace(/\/+$/u, '').toLowerCase()

const uniqueIds = (ids: readonly string[]): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

interface WorkspaceSlot {
  workspace: RemoteWorkspace
  /** `0` = follow 的权威行，`1` = 派生行（补缺用，不覆盖权威字段）。 */
  rank: number
}

/**
 * 合并两份工作区数据：**follow 权威**，派生只补 `path` / `title` 缺失，同工作区去重。
 *
 * - 同 `workspaceId`：合成一行；follow 那一行有值的字段不动，空字段用派生补；
 *   `sessionIds` 取并集（follow 的排在前面，顺序按 follow 给的原样）。
 * - 同路径（不同 id）：视为同一个目录，合成一行（保留先出现的那行 = follow 的），
 *   `sessionIds` 并集 —— 否则 UI 里会出现两个一模一样的路径。
 * - 顺序：先按 follow 的顺序（那是用户在 Host 上排的顺序），派生独有的追加在尾部；
 *   follow 完全没有数据（老 Host）时才按标题排序，与旧版派生列表的观感一致。
 * - `title` 最后兜底：空 → 路径末段 → `workspaceId`（绝不显示空白行）。
 */
export const mergeWorkspaceInventory = (
  hostItems: readonly RemoteWorkspace[],
  derivedItems: readonly RemoteWorkspace[],
): RemoteWorkspace[] => {
  const slots: WorkspaceSlot[] = []
  const byId = new Map<string, number>()
  const byPath = new Map<string, number>()

  const indexOf = (workspace: RemoteWorkspace): number | undefined => {
    const byIdIndex = byId.get(workspace.workspaceId)
    if (byIdIndex !== undefined) return byIdIndex
    const key = workspace.path.length > 0 ? workspacePathKey(workspace.path) : ''
    return key.length === 0 ? undefined : byPath.get(key)
  }

  const remember = (index: number, workspace: RemoteWorkspace): void => {
    byId.set(workspace.workspaceId, index)
    if (workspace.path.length > 0) byPath.set(workspacePathKey(workspace.path), index)
  }

  const add = (workspace: RemoteWorkspace, rank: number): void => {
    const found = indexOf(workspace)
    if (found === undefined) {
      slots.push({ workspace, rank })
      remember(slots.length - 1, workspace)
      return
    }
    const slot = slots[found]
    if (slot === undefined) return
    const base = slot.workspace
    const authoritativeFirst = slot.rank <= rank
    const createdAt = base.createdAt ?? workspace.createdAt
    const updatedAt = base.updatedAt ?? workspace.updatedAt
    const merged: RemoteWorkspace = {
      // id 用先出现的那一行（rank 小的 = follow）
      workspaceId: authoritativeFirst ? base.workspaceId : workspace.workspaceId,
      path: base.path.length > 0 ? base.path : workspace.path,
      title: base.title.length > 0 ? base.title : workspace.title,
      sessionIds: uniqueIds(authoritativeFirst
        ? [...base.sessionIds, ...workspace.sessionIds]
        : [...workspace.sessionIds, ...base.sessionIds]),
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(updatedAt === undefined ? {} : { updatedAt }),
    }
    slots[found] = { workspace: merged, rank: Math.min(slot.rank, rank) }
    remember(found, merged)
  }

  for (const workspace of hostItems) add(workspace, 0)
  for (const workspace of derivedItems) add(workspace, 1)

  const merged = slots.map(({ workspace }) => {
    const title = workspace.title.length > 0
      ? workspace.title
      : workspace.path.length > 0
        ? workspaceTitleFromPath(workspace.path)
        : workspace.workspaceId
    return { ...workspace, title }
  })
  return hostItems.length === 0 ? merged.sort((a, b) => a.title.localeCompare(b.title)) : merged
}

/* ────────────────────────────────────────────────────────────────────────
 * 三、错误分类
 * ──────────────────────────────────────────────────────────────────────── */

/** 这些码表示「这台 Host 没有这个端点」—— 老 Host 的降级判据（与 `newSessionStore` 共用）。 */
export const MISSING_ENDPOINT_CODES: ReadonlySet<string> = new Set([
  'METHOD_NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'CAPABILITY_NOT_SUPPORTED',
  'UNSUPPORTED',
  'FEATURE_NOT_SUPPORTED',
])

/** 从任意异常上取机器码（`RemoteApiError` / 链路错误都带 `code`）。 */
export const remoteErrorCode = (error: unknown): string => {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code.length > 0) return code
  }
  return ''
}

/** 这个异常是不是「没有这个端点」（老 Host）。 */
export const isMissingEndpointError = (error: unknown): boolean => MISSING_ENDPOINT_CODES.has(remoteErrorCode(error))

const failureOf = (error: unknown, fallback: string): WorkspaceSyncFailure => {
  const code = remoteErrorCode(error)
  const raw = typeof error === 'object' && error !== null
    ? (error as { message?: unknown }).message
    : undefined
  const message = typeof raw === 'string' && raw.length > 0 ? raw : fallback
  return {
    ...(code.length === 0 ? {} : { code }),
    message,
    missingEndpoint: MISSING_ENDPOINT_CODES.has(code),
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * 四、同步器（可测：所有外部依赖都能注入）
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 重开延迟（毫秒）。第 n 次失败用第 n 个，用完就一直用最后一个：
 * 前两拍给得短（通道抖动通常立刻恢复），后面拉到 8 秒，绝不热循环。
 */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [400, 1_200, 3_000, 8_000]

/** 连续失败多少次就停下来等外部 `ensure()`（打开面板 / 重连都会再叫一次）。 */
const MAX_RETRY_ATTEMPTS = 6

export interface WorkspaceSyncDeps {
  /** 开一条 `workspace/follow`（生产 = `openWorkspaceFollow`）。 */
  open(target: RemoteCallTarget): Promise<RemoteStreamHandle>
  /** 按 `streamId` 注册帧接收器（生产 = `store.ts` 的 `registerRemoteStreamSink`）。 */
  registerSink(streamId: string, onPayload: (payload: StreamEventPayload) => void): () => void
  /** 当前可用的连接对象（`null` = 还没有 / 不是 ready）。 */
  target(): RemoteCallTarget | null
  /** 连接是否就绪（断开后不该再开流）。 */
  isReady(): boolean
  push: WorkspaceSyncPush
  retryDelaysMs?: readonly number[]
  setTimeout?(handler: () => void, ms: number): unknown
  clearTimeout?(handle: unknown): void
}

export interface WorkspaceSyncer {
  /** 连接 / 目标就绪时调用（幂等：已经开着、正在开、已判不支持时什么都不做）。 */
  ensure(): void
  /** 断线：关流 + 清定时器，状态回 `idle`（不清列表）。 */
  reset(): void
  /** 当前状态（自测断言用）。 */
  status(): WorkspaceFollowStatus
  /** 已经开过几次流（自测断言「关流后重开」用）。 */
  openCount(): number
  /** 现在有没有一条活着的流。 */
  isOpen(): boolean
  /** 有没有挂着一个「稍后重开」的定时器。 */
  isReopenScheduled(): boolean
}

/** 造一个同步器（生产 / 自测共用同一份实现：避免「测试里对、线上不对」）。 */
export const createWorkspaceSyncer = (deps: WorkspaceSyncDeps): WorkspaceSyncer => {
  const delays = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
  const schedule = deps.setTimeout ?? ((handler: () => void, ms: number): unknown => setTimeout(handler, ms))
  const cancel = deps.clearTimeout ?? ((handle: unknown): void => {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  })

  let handle: RemoteStreamHandle | null = null
  let release: (() => void) | null = null
  let opening = false
  let state: WorkspaceFollowStatus = 'idle'
  let attempts = 0
  let timer: unknown = null
  let opens = 0

  /** 摘接收器 + 关流（关流失败不影响收尾：链路可能已经断了）。 */
  const detach = (): void => {
    if (release !== null) {
      const off = release
      release = null
      off()
    }
    const current = handle
    handle = null
    if (current !== null) void Promise.resolve(current.close()).catch(() => undefined)
  }

  const clearTimer = (): void => {
    if (timer === null) return
    const pending = timer
    timer = null
    cancel(pending)
  }

  const scheduleReopen = (failure?: WorkspaceSyncFailure): void => {
    state = 'idle'
    deps.push.onStatus('idle', failure)
    // 已经挂着一个、或者连接没了：不排新的（重连时会由订阅重新 ensure）
    if (timer !== null || !deps.isReady()) return
    // 连续失败到上限就停（面板打开 / 重连都会再 ensure 一次，不会永远回不来）
    if (attempts >= MAX_RETRY_ATTEMPTS) return
    const delay = delays[Math.min(attempts, delays.length - 1)] ?? 0
    attempts += 1
    timer = schedule(() => {
      timer = null
      syncer.ensure()
    }, delay)
  }

  const onPayload = (payload: StreamEventPayload): void => {
    if (payload.type === 'closed') {
      /*
       * 流被 Host 关掉（通道抖动 / Host 主动收流）：接收器先摘掉，再排一次重开。
       * 注意 `routeToStreamListeners` 收到 closed 时已经把我们这条接收器从表里删了，
       * 但 `release()` 是幂等的，照调不误。
       */
      const current = handle
      handle = null
      if (release !== null) {
        const off = release
        release = null
        off()
      }
      if (current !== null) void Promise.resolve(current.close()).catch(() => undefined)
      scheduleReopen(payload.failure === undefined
        ? { message: `workspace/follow 已关闭（${payload.reason}）`, missingEndpoint: false }
        : failureOf(payload.failure, `workspace/follow 已关闭（${payload.reason}）`))
      return
    }
    if (payload.hasValue !== true) return // 这一拍没有数据（协议 §20）
    const baseline = parseWorkspaceBaseline(payload.value)
    if (baseline !== null) {
      attempts = 0 // 真的收到 baseline 了：退避计数清零
      state = 'streaming'
      deps.push.onBaseline(baseline)
      return
    }
    const frame = parseWorkspaceFrame(payload.value)
    if (frame.kind !== 'ignore') deps.push.onDelta(frame)
  }

  const open = (): void => {
    if (opening || handle !== null || state === 'unsupported' || !deps.isReady()) return
    const target = deps.target()
    if (target === null) {
      // 连接就绪但第一帧业务调用还没把连接对象记下来：按退避等一等（不是错误）
      scheduleReopen()
      return
    }
    opening = true
    opens += 1
    void (async (): Promise<void> => {
      try {
        const opened = await deps.open(target)
        if (!deps.isReady()) {
          // 开流期间断线了：这条流立刻作废（否则会挂在一条死连接上）
          void Promise.resolve(opened.close()).catch(() => undefined)
          return
        }
        handle = opened
        release = deps.registerSink(opened.streamId, onPayload)
        state = 'streaming'
        deps.push.onStatus('streaming')
      } catch (error) {
        const failure = failureOf(error, '打开 workspace/follow 失败')
        if (failure.missingEndpoint) {
          // 老 Host：这台机器没有这个端点。不重试，退回派生列表（UI 不收起）
          clearTimer()
          state = 'unsupported'
          deps.push.onStatus('unsupported', failure)
          return
        }
        scheduleReopen(failure)
      } finally {
        opening = false
      }
    })()
  }

  const syncer: WorkspaceSyncer = {
    ensure: (): void => {
      if (state === 'unsupported') return
      if (handle !== null || opening) return
      /*
       * 已经排了一个重开：外部显式 `ensure()` 比定时器更「急」（面板刚打开 / 刚拿到连接对象），
       * 所以撤掉定时器当场试一次 —— 免得用户等 8 秒才看到工作区。
       */
      clearTimer()
      open()
    },
    reset: (): void => {
      clearTimer()
      detach()
      attempts = 0
      opening = false
      if (state === 'unsupported') return
      state = 'idle'
    },
    status: (): WorkspaceFollowStatus => state,
    openCount: (): number => opens,
    isOpen: (): boolean => handle !== null,
    isReopenScheduled: (): boolean => timer !== null,
  }
  return syncer
}

/* ────────────────────────────────────────────────────────────────────────
 * 五、生产绑定：连到 `store.ts` 的连接上
 * ──────────────────────────────────────────────────────────────────────── */

let installed: WorkspaceSyncer | null = null
let unsubscribePhase: (() => void) | null = null

/**
 * 装上常驻流（幂等）。`push` 由 `newSessionStore.ts` 提供 —— 本文件不 import 那个 store，
 * 所以不存在循环依赖。
 */
export const installWorkspaceSync = (push: WorkspaceSyncPush): WorkspaceSyncer => {
  if (installed !== null) return installed
  const syncer = createWorkspaceSyncer({
    open: async (target: RemoteCallTarget): Promise<RemoteStreamHandle> => await openWorkspaceFollow(target),
    registerSink: (streamId, onPayload) => registerRemoteStreamSink(streamId, onPayload),
    // `lastRemoteTarget()` 是 `store.ts` 公开的只读句柄；只在 ready 时取（否则是上一代的死引用）
    target: () => (useRemoteStore.getState().phase === 'ready' ? lastRemoteTarget() : null),
    isReady: () => useRemoteStore.getState().phase === 'ready',
    push,
  })
  installed = syncer
  unsubscribePhase = useRemoteStore.subscribe((state, prev) => {
    if (state.phase === prev.phase) return
    // 重连（任何 → ready）就重开；断开就把流与定时器收掉
    if (state.phase === 'ready') syncer.ensure()
    else syncer.reset()
  })
  syncer.ensure()
  return syncer
}

/** 现在就要一条 baseline（`loadInventory` 拿到连接对象之后调；幂等）。 */
export const ensureWorkspaceStream = (): void => {
  installed?.ensure()
}

/** 连接断开时收流（`store.ts` 的 phase 订阅已经覆盖；这个入口留给自测 / 显式调用）。 */
export const resetWorkspaceStream = (): void => {
  installed?.reset()
}

/** 当前状态（`newSessionStore` 用它判断「要不要给老 Host 打补丁」。 */
export const workspaceStreamStatus = (): WorkspaceFollowStatus => installed?.status() ?? 'idle'

/** 拆掉绑定（只给自测用；线上不需要）。 */
export const uninstallWorkspaceSync = (): void => {
  if (unsubscribePhase !== null) {
    unsubscribePhase()
    unsubscribePhase = null
  }
  installed?.reset()
  installed = null
}
