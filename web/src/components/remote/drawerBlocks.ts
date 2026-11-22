/**
 * 远程会话抽屉列表的分块 / 筛选 / 行尾标记 —— 全部纯函数（抽屉重设计）。
 *
 * 照 dsh-Go 抽屉三件套的语义抽出来，JSX 里不再写这些 if：
 *   - session_tile.dart:71-80 —— 行尾「至多一个」标记，优先级 待确认 > 运行中
 *     （其后接 ChatPad 自己的两个尾注：ghost「已不存在」>「已归档」小标）；
 *   - drawer_list.dart:116-160 —— 分块：置顶 → 今天 / 昨天 / 近 7 天 / 更早 →
 *     已归档沉底（块结构见 `DrawerBlock`）；状态筛选生效时不再分小节，
 *     拍平成一块（drawer_list.dart:121-122 的 `FilteredBlock`）；
 *   - drawer_filter_bar.dart:29-39 —— 胶囊只在列表确有会话（或已开着筛选）时出现，
 *     计数拼在标签后（渲染条件的另一半在组件里：搜索时不出现）。
 *
 * 状态判据与组件原来的口径逐条对齐（原 RemoteSessionList.tsx 的 [S3]/[R9] 注释）：
 *   running = `liveById[id]?.running === true`（`liveSessions.ts` 归约出的权威布尔值，
 *             没有本地推断，列表说熄就熄）；
 *   pending = 非活动会话 && `Math.max(pendingInteractions[id] 总数, live.approval ?? 0) > 0`
 *             —— 两条独立记账取大（任一条漏了事件，标记也不会消失）；
 *   排序 = 归档沉底 > 置顶浮顶 > updatedAt 倒序（组件原 sort 的同一顺序）。
 *
 * 纯函数不碰 store / i18n：时钟由调用方注入（`now`，自测不依赖真实时间），
 * 小节文案以 i18n key 给出（`labelKey`），由组件翻译。
 */

/** 状态筛选胶囊的三个档（drawer_filter_bar.dart 的 DrawerFilter 去掉 ChatPad 没有的「未读」） */
export type DrawerFilter = 'all' | 'running' | 'pending'

/** 日期分桶（drawer_list.dart:155-158 的 DayBlock 四桶） */
export type DayBucket = 'today' | 'yesterday' | 'week' | 'earlier'

/**
 * 行尾「至多一个」标记。前两个照 session_tile.dart:71-80 的优先级；
 * ghost / archived 是 ChatPad 的行尾尾注（[R8] 缓存的「已不存在」小标、
 * 归档行尾的「已归档」小标），只在没有待确认 / 运行标记时顶上。
 */
export type RowMarker = 'pending' | 'running' | 'ghost' | 'archived'

/** 会话列表一行进来的最小形状（`RemoteSessionSummary` / 搜索命中都结构兼容） */
export interface DrawerSessionInput {
  id: string
  title?: string
  /** 秒级时间戳 / 毫秒时间戳 / ISO 字符串都认（与组件原 `toMillis` 同一套归一） */
  updatedAt?: number | string
  /** 服务端行的 `pinned` 投影（本地置顶集之外的第二来源） */
  pinned?: boolean
}

/** `liveSessions.ts` 的 `SessionLive` 最小投影（running / approval 两项就够） */
export interface DrawerLiveInput {
  running?: boolean
  approval?: number
}

/** `promptModel.ts` 的 `PendingInteractionCount` 最小投影（审批 + 提问） */
export interface DrawerPendingInput {
  approval?: number
  question?: number
}

/** 折算好的一行（排序 / 分块 / 标记判定都已做完） */
export interface DrawerRow {
  id: string
  /** 原样标题；空串由组件回退成「未命名会话」（i18n 是组件的事） */
  title: string
  /** 归一成毫秒；认不出 → 0（排序沉底、分桶进「更早」） */
  updatedAt: number
  pinned: boolean
  archived: boolean
  /** [R8] 服务端这次没给、缓存里还有的行（标「已不存在」而不是闪没） */
  ghost: boolean
  /** 状态判据本身（筛选命中用），与 marker 分开：命中可以同时为真，标记只显示一个 */
  running: boolean
  pending: boolean
  /** 行尾「至多一个」标记（`rowMarkerOf` 的结果） */
  marker: RowMarker | null
}

export type DrawerBlockKind = 'pinned' | 'day' | 'archived' | 'filtered'

/**
 * 块标题（eyebrow）的 i18n key —— 字面量联合：组件 `t()` 直接受，
 * key 改名时类型检查会提醒（纯函数自己不 import i18n，只约定字符串）。
 */
export type DrawerBlockLabelKey =
  | 'remoteDrawerPinned'
  | 'remoteDrawerToday'
  | 'remoteDrawerYesterday'
  | 'remoteDrawerWeek'
  | 'remoteDrawerEarlier'
  | 'newSessionArchivedTag'

/** 列表的一块：置顶 / 一个日期桶 / 已归档 / 状态筛选的拍平块 */
export interface DrawerBlock {
  kind: DrawerBlockKind
  /** eyebrow 的 i18n key（filtered 块没有小节标题） */
  labelKey?: DrawerBlockLabelKey
  /** day 块的桶名（labelKey 之外再给一个稳定标识，自测用） */
  bucket?: DayBucket
  /** filtered 块的筛选名 */
  filter?: Exclude<DrawerFilter, 'all'>
  rows: DrawerRow[]
}

/** 分块的输入 */
export interface DrawerBlocksInput {
  sessions: readonly DrawerSessionInput[]
  pinnedIds: readonly string[]
  archivedIds: readonly string[]
  /** [R8] 缓存里还有、服务端这次没给的行 */
  ghostIds?: readonly string[]
  liveById: Readonly<Record<string, DrawerLiveInput>>
  pendingInteractions: Readonly<Record<string, DrawerPendingInput>>
  /** 活动会话的待确认不计（用户已经在这个会话里；与 [R9] 红点同一口径） */
  activeSessionId: string | null
  filter: DrawerFilter
  /** 时钟注入（分桶按它算；跨午夜重渲染自然翻篇） */
  now: number
}

/** 拍平行的输入（搜索视图用：不分桶，保持命中顺序） */
export type DrawerRowsInput = Omit<DrawerBlocksInput, 'filter' | 'now'> & {
  /** true = 保持输入顺序（搜索命中按相关性排，别按时间倒序重排） */
  preserveOrder?: boolean
}

const DAY_MS = 86_400_000

/**
 * `updatedAt` 归一成毫秒（秒 / 毫秒 / ISO 字符串；认不出 → undefined）。
 * 原样挪自 RemoteSessionList.tsx：列表缓存与 `session/list` 的时间口径不一致，
 * 两边都要靠它摆平。
 */
const toMillis = (value: number | string | undefined): number | undefined => {
  if (value === undefined) return undefined
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  if (!Number.isFinite(value)) return undefined
  return value < 1e12 ? value * 1000 : value
}

/** 本地时区的自然日 0 点（分桶按自然日切，不按 24h 滚动窗口） */
const startOfLocalDay = (t: number): number => {
  const date = new Date(t)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/**
 * 日期分桶：今天 / 昨天 / 近 7 天 / 更早。
 *
 * 「近 7 天」= 含今天在内的 7 个自然日窗口（第 7 天的 0 点仍算 week，
 * 第 8 天的 0 点起算 earlier）。未来时间（时钟漂移）宽容地算今天；
 * 无效时间沉到「更早」。
 */
export const dayBucketOf = (updatedAt: number, now: number): DayBucket => {
  if (!Number.isFinite(updatedAt)) return 'earlier'
  const todayStart = startOfLocalDay(now)
  if (updatedAt >= todayStart) return 'today'
  const days = Math.floor((todayStart - startOfLocalDay(updatedAt)) / DAY_MS)
  if (days <= 1) return 'yesterday'
  if (days <= 6) return 'week'
  return 'earlier'
}

/** 待确认总数（与 `promptModel.ts` 的 `pendingTotal` 同口径：approval + question，缺省 0） */
const pendingCountOf = (count: DrawerPendingInput | undefined): number =>
  count === undefined ? 0 : (count.approval ?? 0) + (count.question ?? 0)

/**
 * 行尾「至多一个」标记（session_tile.dart:71-80 的优先级）：
 * 待确认 > 运行中，其后接 ChatPad 的两个尾注：ghost「已不存在」>「已归档」小标。
 * ghost 比「已归档」优先：它是下一轮刷新就会消失的临时态，值得先说。
 */
export const rowMarkerOf = (row: {
  running: boolean
  pending: boolean
  archived: boolean
  ghost: boolean
}): RowMarker | null => {
  if (row.pending) return 'pending'
  if (row.running) return 'running'
  if (row.ghost) return 'ghost'
  if (row.archived) return 'archived'
  return null
}

/**
 * 把输入折算成拍平的行（排序：归档沉底 > 置顶浮顶 > updatedAt 倒序 ——
 * 组件原来 `sorted` 的同一顺序）。搜索视图 `preserveOrder: true` 保持命中顺序。
 */
export const buildDrawerRows = (input: DrawerRowsInput): DrawerRow[] => {
  const pinnedSet = new Set(input.pinnedIds)
  const archivedSet = new Set(input.archivedIds)
  const ghostSet = new Set(input.ghostIds ?? [])
  const rows: DrawerRow[] = input.sessions.map((session) => {
    const live = input.liveById[session.id]
    const running = live?.running === true
    /*
     * 待确认：两条独立记账取大 —— [R9] 的 `pendingInteractions`（审批+提问）与
     * S3 的 `live.approval`（只算审批）。两条都靠同样的信号销账，取大是为了
     * 「任一条漏了事件，标记也不会消失」。活动会话不计（用户已经在这个会话里）。
     */
    const pending =
      session.id !== input.activeSessionId &&
      Math.max(pendingCountOf(input.pendingInteractions[session.id]), live?.approval ?? 0) > 0
    const archived = archivedSet.has(session.id)
    const ghost = ghostSet.has(session.id)
    return {
      id: session.id,
      title: session.title ?? '',
      updatedAt: toMillis(session.updatedAt) ?? 0,
      pinned: pinnedSet.has(session.id) || session.pinned === true,
      archived,
      ghost,
      running,
      pending,
      marker: rowMarkerOf({ running, pending, archived, ghost }),
    }
  })
  if (input.preserveOrder === true) return rows
  rows.sort((a, b) => {
    if (a.archived !== b.archived) return a.archived ? 1 : -1
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return b.updatedAt - a.updatedAt
  })
  return rows
}

/** day 块的固定顺序与文案 key（今天 → 昨天 → 近 7 天 → 更早） */
const DAY_ORDER: readonly DayBucket[] = ['today', 'yesterday', 'week', 'earlier']
const DAY_LABEL_KEYS: Record<DayBucket, DrawerBlockLabelKey> = {
  today: 'remoteDrawerToday',
  yesterday: 'remoteDrawerYesterday',
  week: 'remoteDrawerWeek',
  earlier: 'remoteDrawerEarlier',
}

/**
 * 抽屉分块（drawer_list.dart:116-160）：
 *
 *   filter='all'      → 置顶（eyebrow「置顶」）→ 今天 / 昨天 / 近 7 天 / 更早
 *                        （eyebrow 小节标题）→ 已归档（沉底，保持「取消归档原地可点」）。
 *                        空块不出现（没有「今天」的会话就不说「今天」）。
 *   filter='running' / 'pending' → 分小节拍平成**一块**（drawer_list.dart:121-122 的
 *                        FilteredBlock），纯按 updatedAt 倒序；命中为空也返回这一块，
 *                        组件凭空 rows 给「没有在跑的 / 没有待确认的」空态。
 */
export const buildDrawerBlocks = (input: DrawerBlocksInput): DrawerBlock[] => {
  const rows = buildDrawerRows(input)
  if (input.filter !== 'all') {
    const matched = input.filter === 'running'
      ? rows.filter((row) => row.running)
      : rows.filter((row) => row.pending)
    // 拍平视图不再「归档沉底 / 置顶浮顶」：按时间倒序读起来就是「刚才还在动的那几条」
    matched.sort((a, b) => b.updatedAt - a.updatedAt)
    return [{ kind: 'filtered', filter: input.filter, rows: matched }]
  }

  const blocks: DrawerBlock[] = []
  const pinnedRows = rows.filter((row) => row.pinned && !row.archived)
  if (pinnedRows.length > 0) {
    blocks.push({ kind: 'pinned', labelKey: 'remoteDrawerPinned', rows: pinnedRows })
  }
  const dayRows = rows.filter((row) => !row.pinned && !row.archived)
  // `rows` 已按 updatedAt 倒序排过，`filter` 保序 ⇒ 桶内自然保持倒序
  for (const bucket of DAY_ORDER) {
    const bucketRows = dayRows.filter((row) => dayBucketOf(row.updatedAt, input.now) === bucket)
    if (bucketRows.length > 0) {
      blocks.push({ kind: 'day', bucket, labelKey: DAY_LABEL_KEYS[bucket], rows: bucketRows })
    }
  }
  const archivedRows = rows.filter((row) => row.archived)
  if (archivedRows.length > 0) {
    // 归档块也给一个 eyebrow（「已归档」复用既有 key）：分块节奏统一，
    // 一眼看出「以下是归档区」；行内的降透明度与行尾小标照旧。
    blocks.push({ kind: 'archived', labelKey: 'newSessionArchivedTag', rows: archivedRows })
  }
  return blocks
}

/**
 * 状态筛选胶囊的计数（drawer_filter_bar.dart:33-39）：对**当前列表全集**算
 * （工作区筛选后的每一行，含归档行），不是对命中子集算 —— 筛选开着时拼在标签后
 * （「运行中 2」「待确认 1」），让用户在下单前就知道有几条。
 */
export const drawerFilterCounts = (
  input: Omit<DrawerBlocksInput, 'filter' | 'now'>,
): { running: number; pending: number } => {
  const rows = buildDrawerRows(input)
  return {
    running: rows.filter((row) => row.running).length,
    pending: rows.filter((row) => row.pending).length,
  }
}
