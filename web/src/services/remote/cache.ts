/**
 * 远程 DSH：**本地缓存（cache-first）** —— 会话列表 + 会话内容（R8）。
 *
 * 用户真机反馈：「先把之前已经获取到的会话列表缓存下来，打开的时候就不用每次重新获取」
 * 「从云端自动合并最新的会话列表，会话内容也是用合并的」。这个文件就是那份缓存与合并规则，
 * 只做**纯数据**（不碰 React、不发请求、不认识连接），接线在 `store.ts`。
 *
 * ## 为什么是 localStorage 而不是 SQLite
 *
 * 本机侧（`services/chat/db.ts`）用的是 SQLite / IndexedDB：它存的是**本机会话**（长期、可增删、
 * 要事务）。远程缓存是另一回事 —— 只求「下次打开先有一屏可看」，丢了只影响观感，
 * 而且网页包会被整体替换，所以：
 *
 * - 只用 `localStorage`（同步、零依赖、没有 migration 机制）；
 * - **带版本号前缀**（`…v1`），字段一变就整块丢弃，**不写迁移逻辑**（任务书要求）；
 * - 一切读写都包在 try/catch 里：隐私模式 / 配额满 / 半截 JSON 都只是「没有缓存」。
 *
 * ## 键与分桶
 *
 * | 键 | 内容 | 为什么分桶 |
 * |---|---|---|
 * | `dsp.remote.sessions-cache.v1` | 每个桶一份会话列表 | 一台手机可能连多台 Host / 多个服务器，列表不能串味 |
 * | `dsp.remote.messages-cache.v1` | 每个桶内每个会话最近 N 条 | 同上；内容比列表大，单独一个键，坏一个不连累另一个 |
 *
 * 生产缓存按服务器、主机设备、公钥及本机账号设备分桶。旧缓存缺少可验证的归属，
 * 在主机重新同步历史之前，不用于显示时间线或恢复待确认消息。
 *
 * ## 合并规则（两套，各自一张表）
 *
 * ### 会话列表 —— `mergeSessionLists()`
 *
 * | 情况 | 结果 |
 * |---|---|
 * | 两边都有（按 `id`） | 以服务端为准；`title` / `updatedAt` / `workspaceId` 服务端有就用服务端的 |
 * | 服务端没给 `pinned` | **保留本地的**（本地置顶不被一次列表刷新抹掉） |
 * | 只有服务端有 | 直接进列表（新会话） |
 * | 只有本地有（第一轮） | 保留 + 打 `missingAt` + 进 `ghostSessionIds`（UI 标「已不存在」，**不立刻删**，避免抖动闪一下） |
 * | 只有本地有（上一轮已经标过） | **这一轮清掉**（连续两轮服务端都没有 = 真的没了） |
 *
 * ### 会话内容 —— `mergeTimelineItems()`
 *
 * | 情况 | 结果 |
 * |---|---|
 * | 同 `id` | 用服务端那份（连位置一起用服务端的顺序） |
 * | 本地乐观行（有 `requestRpcId`）且服务端已经回显同一个 `requestRpcId` | 丢掉本地行（已被取代） |
 * | 本地乐观行（有 `requestRpcId` / `sendState`）服务端没有 | 保留，接在服务端窗口**后面**（还在飞 / 失败要给人看） |
 * | 本地行比服务端窗口更旧（`nativeSeq` 更小，或没有 seq 但 `createdAt` 更早） | 保留在**头部**（上翻过的历史页不丢），顺序照旧 |
 * | 其余本地行（窗口外的残留） | 丢掉（服务端窗口是权威） |
 *
 * ## 加载态
 *
 * 判定全部收成纯函数（`sessionListViewState()` / `timelineViewState()` / `timelineHintState()`），
 * 组件只负责把相位画出来，自测逐条摆过。核心一条纪律：
 *
 * > **首次拉取没结束之前，绝不显示「没有内容」** —— 那是歧义（用户以为真没消息），
 * > 不是事实。只有 `settled`（首次拉取确实结束）之后才允许空态。
 */

import type { ChatItem } from './adapter.js'

/* ────────────────────────────────────────────────────────────────────────
 * 一、常量
 * ──────────────────────────────────────────────────────────────────────── */

/** 缓存结构版本。**只在键名里体现**：读到的 `v` 不等于它就整块丢弃，不做迁移。 */
export const CACHE_VERSION = 1
/** 会话列表缓存键（任务书指定的键名） */
export const SESSIONS_CACHE_KEY = 'dsp.remote.sessions-cache.v1'
/** 会话内容缓存键（同批次新增；键名同规矩带版本后缀） */
export const TIMELINE_CACHE_KEY = 'dsp.remote.messages-cache.v1'

/**
 * 缓存 TTL：24h。
 *
 * 注意语义 —— **过期不等于删**：超时的缓存照样先显示（比空白强），只是 UI 会标注「缓存」，
 * 并且列表/内容一旦被服务端数据覆盖就恢复正常。真正删只有三条路：版本号不对、
 * 连续两轮服务端列表里都没有这个会话、用户清 App 数据。
 */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000
/** 单会话最多缓存多少条（任务书：200） */
export const TIMELINE_MAX_ITEMS = 200
/** 单会话最多缓存多少字节（任务书：1 MiB；按 UTF-8 字节算，从**最新**一条往前累加） */
export const TIMELINE_MAX_BYTES = 1024 * 1024
/** 最多保留几个桶（多服务器 / 多 Host 时会顺带清理最旧的） */
export const MAX_BUCKETS = 4
/** 每个桶最多缓存几个会话（内容比列表大得多，只留最近打开的） */
export const MAX_TIMELINES_PER_BUCKET = 4

/* ────────────────────────────────────────────────────────────────────────
 * 二、类型
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 缓存里的一行会话。
 *
 * 字段是 `store.ts` 的 `RemoteSessionSummary` 的结构超集：多出来的只有 `missingAt`
 * （「服务端列表里没有它」的第一次观测时刻）。这里**不 import store 的类型** ——
 * `store.ts` 已经 import 本文件，反过来 import 会成环（`import/no-cycle` 是 error）。
 */
export interface CachedSessionRow {
  id: string
  title: string
  workspaceId?: string
  updatedAt?: number
  pinned?: boolean
  /** 第一次发现「服务端列表里没有它」的时刻；有值时这一行是幽灵行，下一轮清掉 */
  missingAt?: number
}

/** 列表 / 内容各自的加载相位（组件只读这个，不自己拼条件） */
export type SessionListPhase = 'content' | 'skeleton' | 'empty' | 'idle'
export type TimelinePhase = 'content' | 'skeleton' | 'empty' | 'failed'
/** 内容区顶部那条细提示：none 不显示 / syncing「正在同步…」/ failed「没同步上」 */
export type TimelineHint = 'none' | 'syncing' | 'failed'

/**
 * 缓存相关的**只读投影**（`store.ts` 的 `state.cacheStatus`）。
 *
 * 为什么集中成一个对象：UI 要判的只有这几件事（列表从哪来、内容从哪来、拉完没有），
 * 散成六七个布尔字段会让人反复读错；一个对象也方便一次性 patch。
 */
export interface RemoteCacheStatus {
  /** 列表是缓存直出（服务端列表还没到） */
  sessionsFromCache: boolean
  /** 列表缓存已超 TTL（先显示，但标注「缓存」） */
  sessionsStale: boolean
  /** 正在后台拉 `session/list` */
  sessionsSyncing: boolean
  /** 服务端至少给过一次列表（= 空态可信） */
  sessionsSynced: boolean
  /** 服务端列表里没有、本地缓存还在的会话（UI 标「已不存在」，下一轮清理） */
  ghostSessionIds: string[]
  /** 内容来自缓存（`session/follow` 快照还没到） */
  timelineFromCache: boolean
  /** 当前会话首次拉取未完成（→ 骨架屏；**绝不**显示空态） */
  timelineLoading: boolean
  /** 当前会话首次拉取已结束（成功或失败；只有它为 true 时「空」才是事实） */
  timelineSettled: boolean
  /** 当前会话首次拉取失败（有缓存时顶部挂一条提示 + 重试） */
  timelineFailed: boolean
}

/** 初值（`store.ts` 的 `INITIAL_STATE` 用；每次都要一份新对象，别共享引用被改） */
export const emptyCacheStatus = (): RemoteCacheStatus => ({
  sessionsFromCache: false,
  sessionsStale: false,
  sessionsSyncing: false,
  sessionsSynced: false,
  ghostSessionIds: [],
  timelineFromCache: false,
  timelineLoading: false,
  timelineSettled: false,
  timelineFailed: false,
})

/* ────────────────────────────────────────────────────────────────────────
 * 三、存储适配（localStorage；一切异常都退化成「没有缓存」）
 * ──────────────────────────────────────────────────────────────────────── */

interface CacheStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0

const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** 浏览器里拿 localStorage；SSR / 原生容器 / 隐私模式拿不到就返回 null（不抛）。 */
const resolveStorage = (): CacheStorage | null => {
  try {
    const scope = globalThis as { localStorage?: CacheStorage }
    return scope.localStorage ?? null
  } catch {
    return null
  }
}

const readRoot = (key: string): Record<string, unknown> | null => {
  const storage = resolveStorage()
  if (storage === null) return null
  let raw: string | null
  try {
    raw = storage.getItem(key)
  } catch {
    return null
  }
  if (raw === null || raw.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed.v !== CACHE_VERSION) {
    // 版本号不对 = 网页包换过一版：直接丢掉，**不迁移**（任务书要求）
    try {
      storage.removeItem(key)
    } catch {
      // 删不掉也没关系：下次读到同样会丢
    }
    return null
  }
  return parsed
}

const writeRoot = (key: string, root: Record<string, unknown>): boolean => {
  const storage = resolveStorage()
  if (storage === null) return false
  try {
    storage.setItem(key, JSON.stringify(root))
    return true
  } catch {
    // 配额满（内容缓存最常见）：写失败就算了，缓存是可丢的
    return false
  }
}

/** UTF-8 字节数（不分配、不依赖 TextEncoder）：预算按**真实落盘字节**算才有意义。 */
const utf8Bytes = (text: string): number => {
  let bytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x80) {
      bytes += 1
    } else if (code < 0x800) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // 代理对：两个 UTF-16 单元拼一个 4 字节码位
      bytes += 4
      index += 1
    } else {
      bytes += 3
    }
  }
  return bytes
}

/* ────────────────────────────────────────────────────────────────────────
 * 四、桶
 * ──────────────────────────────────────────────────────────────────────── */

/** Normalize the origin while retaining case-sensitive reverse proxy paths. */
export const cacheBucketId = (serverUrl: string, hostDeviceId: string, owner?: string): string => {
  const address = serverUrl.trim().replace(/\/+$/u, '')
  const normalized = address.replace(/^[a-z][a-z\d+.-]*:\/\/[^/]+/iu, (origin) => origin.toLowerCase())
  return owner === undefined ? `${normalized}|${hostDeviceId.trim()}` : JSON.stringify([normalized, hostDeviceId.trim(), owner])
}

export interface CacheBucket {
  serverUrl: string
  hostDeviceId: string
  owner?: string
  /** 缺省取当前时刻 */
  now?: number
}

interface BucketRecord {
  serverUrl: string
  hostDeviceId: string
  owner?: string
  savedAt: number
  sessions: unknown
}

const bucketRecordOf = (root: Record<string, unknown>, bucketId: string): Record<string, unknown> | null => {
  const buckets = root.buckets
  if (!isRecord(buckets)) return null
  const entry = buckets[bucketId]
  if (!isRecord(entry) || typeof entry.serverUrl !== 'string' || typeof entry.hostDeviceId !== 'string') return null
  const owner = typeof entry.owner === 'string' ? entry.owner : undefined
  return cacheBucketId(entry.serverUrl, entry.hostDeviceId, owner) === bucketId ? entry : null
}

/** 把桶写回根对象，并顺手把超过 `MAX_BUCKETS` 的旧桶扔掉（按 `savedAt`）。 */
const putBucket = (key: string, bucketId: string, record: BucketRecord): void => {
  const root = readRoot(key) ?? { v: CACHE_VERSION, buckets: {} }
  const buckets = isRecord(root.buckets) ? { ...root.buckets } : {}
  buckets[bucketId] = record
  const ordered = Object.entries(buckets).sort(
    (left, right) => savedAtOf(right[1]) - savedAtOf(left[1]),
  )
  const kept: Record<string, unknown> = {}
  for (const [id, value] of ordered.slice(0, MAX_BUCKETS)) kept[id] = value
  writeRoot(key, { ...root, v: CACHE_VERSION, buckets: kept })
}

const savedAtOf = (value: unknown): number =>
  isRecord(value) && finiteNumber(value.savedAt) ? value.savedAt : 0

/* ────────────────────────────────────────────────────────────────────────
 * 五、会话列表缓存
 * ──────────────────────────────────────────────────────────────────────── */

export interface CachedSessions {
  sessions: CachedSessionRow[]
  savedAt: number
  /** 超过 TTL（仍然返回，交给 UI 标注「缓存」） */
  stale: boolean
}

const sessionRowOf = (value: unknown): CachedSessionRow | null => {
  if (!isRecord(value)) return null
  const id = value.id
  if (!nonEmptyString(id)) return null
  const row: CachedSessionRow = {
    id,
    title: typeof value.title === 'string' ? value.title : '',
  }
  if (typeof value.workspaceId === 'string' && value.workspaceId.length > 0) row.workspaceId = value.workspaceId
  if (finiteNumber(value.updatedAt)) row.updatedAt = value.updatedAt
  if (typeof value.pinned === 'boolean') row.pinned = value.pinned
  if (finiteNumber(value.missingAt)) row.missingAt = value.missingAt
  return row
}

/** 读一次列表缓存（没有 / 版本不对 / 坏 JSON 都返回 null）。 */
export const readSessionsCache = (bucket: CacheBucket): CachedSessions | null => {
  const root = readRoot(SESSIONS_CACHE_KEY)
  if (root === null) return null
  const record = bucketRecordOf(root, cacheBucketId(bucket.serverUrl, bucket.hostDeviceId, bucket.owner))
  if (record === null || !Array.isArray(record.sessions)) return null
  const sessions: CachedSessionRow[] = []
  for (const raw of record.sessions) {
    const row = sessionRowOf(raw)
    if (row !== null) sessions.push(row)
  }
  if (sessions.length === 0) return null
  const savedAt = savedAtOf(record)
  return { sessions, savedAt, stale: isStale(savedAt, bucket.now) }
}

const isStale = (savedAt: number, now: number | undefined): boolean =>
  savedAt <= 0 || (now ?? Date.now()) - savedAt > CACHE_TTL_MS

/** 写一份列表缓存（服务端列表合并之后调；`sessions` 里的 `missingAt` 会被原样保存）。 */
export const writeSessionsCache = (input: CacheBucket & { sessions: readonly CachedSessionRow[] }): void => {
  const now = input.now ?? Date.now()
  putBucket(SESSIONS_CACHE_KEY, cacheBucketId(input.serverUrl, input.hostDeviceId, input.owner), {
    serverUrl: input.serverUrl,
    hostDeviceId: input.hostDeviceId,
    owner: input.owner,
    savedAt: now,
    sessions: input.sessions,
  })
}

/** 列表排序：置顶在前，其余按更新时间倒序（与 `store.ts` 的 `compareSummaries()` 同一口径）。 */
const compareRows = (left: CachedSessionRow, right: CachedSessionRow): number => {
  if ((left.pinned === true) !== (right.pinned === true)) return left.pinned === true ? -1 : 1
  return (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
}

export interface MergeSessionsInput {
  cached: readonly CachedSessionRow[]
  /** 服务端这次给的列表（已经过滤过子会话） */
  remote: readonly CachedSessionRow[]
  now: number
}

export interface MergeSessionsResult {
  sessions: CachedSessionRow[]
  /** 服务端没有、但本地还有（且这一轮保留）的会话 id */
  ghostSessionIds: string[]
}

/**
 * 会话列表合并（规则表见文件头）。纯函数：不读盘、不改入参。
 *
 * `ghostSessionIds` 只包含**这一轮保留下来**的幽灵行；上一轮已经标过的这一轮被清掉，
 * 所以「连续两轮没有」＝真的删了，一次网络抖动不会造成闪一下。
 */
export const mergeSessionLists = (input: MergeSessionsInput): MergeSessionsResult => {
  const localById = new Map(input.cached.map(row => [row.id, row]))
  const merged: CachedSessionRow[] = []
  const seen = new Set<string>()

  for (const row of input.remote) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    const local = localById.get(row.id)
    // 服务端为准；只有它没给的字段才回落到本地（pinned 最典型：本地置顶不能被抹掉）
    const next: CachedSessionRow = {
      id: row.id,
      title: row.title.length > 0 ? row.title : (local?.title ?? ''),
    }
    const workspaceId = row.workspaceId ?? local?.workspaceId
    if (workspaceId !== undefined) next.workspaceId = workspaceId
    const updatedAt = row.updatedAt ?? local?.updatedAt
    if (updatedAt !== undefined) next.updatedAt = updatedAt
    const pinned = row.pinned ?? local?.pinned
    if (pinned !== undefined) next.pinned = pinned
    // missingAt 不继承：它回到服务端列表里了
    merged.push(next)
  }

  const ghostSessionIds: string[] = []
  const walked = new Set<string>()
  for (const local of input.cached) {
    if (walked.has(local.id)) continue
    walked.add(local.id)
    if (seen.has(local.id)) continue
    if (local.missingAt !== undefined) continue // 上一轮标过 + 这一轮还是没有 → 清掉
    merged.push({ ...local, missingAt: input.now })
    ghostSessionIds.push(local.id)
  }

  merged.sort(compareRows)
  return { sessions: merged, ghostSessionIds }
}

/* ────────────────────────────────────────────────────────────────────────
 * 六、会话内容缓存
 * ──────────────────────────────────────────────────────────────────────── */

export interface CachedTimeline {
  items: ChatItem[]
  savedAt: number
  stale: boolean
}

const itemOf = (value: unknown): ChatItem | null => {
  if (!isRecord(value)) return null
  if (!nonEmptyString(value.id) || !nonEmptyString(value.sessionId)) return null
  if (!finiteNumber(value.createdAt)) return null
  const kind = value.kind
  if (kind !== 'message' && kind !== 'tool' && kind !== 'approval' && kind !== 'question') return null
  if (kind === 'message' && value.pendingPrompt !== undefined) {
    const prompt = value.pendingPrompt
    if (value.role !== 'user' || value.sendState !== 'unconfirmed' || !nonEmptyString(value.requestRpcId) ||
        value.id !== `local:${value.requestRpcId}` || !isRecord(prompt) ||
        (prompt.mode !== 'queue' && prompt.mode !== 'steer') || !Array.isArray(prompt.attachments) ||
        !prompt.attachments.every((part) => isRecord(part) && part.type === 'file' && nonEmptyString(part.receiptId))) {
      delete value.pendingPrompt
    }
  }
  // 结构由我们自己写入，这里只做「像不像一条时间线行」的把关：
  // 真坏了（旧版本残留 / 手改）就整条丢掉，宁可少一条也不要渲染时崩。
  return value as unknown as ChatItem
}

/** 读一个会话的内容缓存（空 / 版本不对 / 坏 JSON 都返回 null，调用方按「没有缓存」处理）。 */
export const readTimelineCache = (bucket: CacheBucket & { sessionId: string }): CachedTimeline | null => {
  const root = readRoot(TIMELINE_CACHE_KEY)
  if (root === null) return null
  const record = bucketRecordOf(root, cacheBucketId(bucket.serverUrl, bucket.hostDeviceId, bucket.owner))
  if (record === null || !isRecord(record.sessions)) return null
  const entry = record.sessions[bucket.sessionId]
  if (!isRecord(entry) || !Array.isArray(entry.items)) return null
  const items: ChatItem[] = []
  for (const raw of entry.items) {
    const item = itemOf(raw)
    if (item !== null && item.sessionId === bucket.sessionId) items.push(item)
  }
  if (items.length === 0) return null
  const savedAt = savedAtOf(entry)
  return { items, savedAt, stale: isStale(savedAt, bucket.now) }
}

/** 落盘前洗一遍：瞬态字段去掉（缓存里的「流式」「发送中」都是假的）。 */
const scrubItem = (item: ChatItem): ChatItem => {
  if (item.kind !== 'message') return item
  const copy: ChatItem = { ...item }
  if (copy.kind === 'message') {
    delete copy.streaming
    delete copy.streamingPhase
    if (copy.sendState === 'queued') copy.sendState = 'unconfirmed'
    if (copy.pendingPrompt?.attachments.some((part) => part.type === 'image')) delete copy.pendingPrompt
  }
  return copy
}

/**
 * 裁剪：将已开始发送的持久化草稿视作结果待确认，
 * 再取最近 `TIMELINE_MAX_ITEMS` 条，最后从**最新往旧**累加字节，超 1 MiB 就停。
 *
 * 从最新往前留，是因为「一屏之内看得到的东西」比「翻到很上面才有的东西」重要得多。
 */
export const trimTimelineForCache = (items: readonly ChatItem[]): ChatItem[] => {
  const usable = items.filter(item => !(item.kind === 'message' && item.sendState === 'queued' && item.pendingPrompt === undefined))
  const spoiled = usable.map(scrubItem)
  const recent = spoiled.slice(Math.max(0, spoiled.length - TIMELINE_MAX_ITEMS))
  const kept: ChatItem[] = []
  let bytes = 0
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const item = recent[index]
    if (item === undefined) continue
    const size = utf8Bytes(JSON.stringify(item))
    // 第一条永远留下：宁可超一点点，也不要缓存成空表
    if (kept.length > 0 && bytes + size > TIMELINE_MAX_BYTES) break
    kept.unshift(item)
    bytes += size
  }
  return kept
}

export interface WriteTimelineInput extends CacheBucket {
  sessionId: string
  items: readonly ChatItem[]
  replaceEmpty?: boolean
}

/**
 * 写一个会话的内容缓存；返回真正落盘的条数（0 = 什么都没写）。
 *
 * 为什么返回条数：自测要看裁剪结果，`store.ts` 抽屉里也能顺手排障。
 * 同一桶内的会话按 `savedAt` 保留最近 `MAX_TIMELINES_PER_BUCKET` 个（LRU）。
 *
 * **配额满怎么办**：localStorage 通常只有 5 MB，而且会话列表和会话内容**共用**这一份配额。
 * 所以写失败时先退一步 —— 只留「当前这个会话」，把同桶的旧会话丢掉再写一次。
 * 宁可少缓存几个旧会话，也不能让写盘长期失败（那样连列表缓存都会一起写不进去）。
 */
export const writeTimelineCache = (input: WriteTimelineInput): number => {
  const trimmed = trimTimelineForCache(input.items.filter((item) => item.sessionId === input.sessionId))
  if (trimmed.length === 0 && input.replaceEmpty !== true) return 0
  const now = input.now ?? Date.now()
  const bucketId = cacheBucketId(input.serverUrl, input.hostDeviceId, input.owner)
  const root = readRoot(TIMELINE_CACHE_KEY) ?? { v: CACHE_VERSION, buckets: {} }
  const buckets = isRecord(root.buckets) ? { ...root.buckets } : {}
  const existing = bucketRecordOf(root, bucketId)
  const sessions = existing !== null && isRecord(existing.sessions) ? { ...existing.sessions } : {}
  if (trimmed.length > 0) {
    sessions[input.sessionId] = { savedAt: now, items: trimmed }
  } else {
    if (!Object.hasOwn(sessions, input.sessionId)) return 0
    delete sessions[input.sessionId]
  }

  /** 按 LRU 截到 `limit` 个会话后落盘；返回是否写成功。 */
  const writeWith = (limit: number): boolean => {
    const ordered = Object.entries(sessions).sort((left, right) => savedAtOf(right[1]) - savedAtOf(left[1]))
    const keptSessions: Record<string, unknown> = {}
    for (const [id, value] of ordered.slice(0, limit)) keptSessions[id] = value
    buckets[bucketId] = {
      serverUrl: input.serverUrl,
      hostDeviceId: input.hostDeviceId,
      owner: input.owner,
      savedAt: now,
      sessions: keptSessions,
    }
    const orderedBuckets = Object.entries(buckets).sort(
      (left, right) => savedAtOf(right[1]) - savedAtOf(left[1]),
    )
    const keptBuckets: Record<string, unknown> = {}
    for (const [id, value] of orderedBuckets.slice(0, MAX_BUCKETS)) keptBuckets[id] = value
    return writeRoot(TIMELINE_CACHE_KEY, { ...root, v: CACHE_VERSION, buckets: keptBuckets })
  }

  if (writeWith(MAX_TIMELINES_PER_BUCKET)) return trimmed.length
  // 配额满：只留当前会话再试一次（保住最重要的那一条）
  if (writeWith(1)) return trimmed.length
  return 0
}

/* ────────────────────────────────────────────────────────────────────────
 * 七、内容合并（服务端窗口 ⇄ 本地缓存 + 乐观行）
 * ──────────────────────────────────────────────────────────────────────── */

const seqOf = (item: ChatItem): number | undefined => {
  const seq = item.nativeOrderSeq ?? item.nativeSeq
  return typeof seq === 'number' && Number.isSafeInteger(seq) ? seq : undefined
}

const rpcIdOf = (item: ChatItem): string | undefined =>
  item.kind === 'message' && typeof item.requestRpcId === 'string' && item.requestRpcId.length > 0
    ? item.requestRpcId
    : undefined

const isLocalPrompt = (item: ChatItem): boolean =>
  item.kind === 'message' && item.role === 'user' &&
  item.id.startsWith('local:') && seqOf(item) === undefined

/**
 * 把「本地已有（缓存 + 乐观行）」并进服务端给的窗口。规则表见文件头。
 *
 * 返回的顺序 = 更早的历史（本地）→ 服务端窗口 → 未落定的乐观行（本地）。
 * 服务端窗口内部顺序**原样保留**（那是 Host 的时间线，不能重排）。
 */
export const mergeTimelineItems = (
  local: readonly ChatItem[],
  fresh: readonly ChatItem[],
  retainEarlier = true,
): ChatItem[] => {
  if (local.length === 0) return [...fresh]
  if (fresh.length === 0) {
    // 服务端说这个窗口是空的：只保留还没落定的乐观行，其余都是过期缓存
    return local.filter(isLocalPrompt)
  }

  const freshIds = new Set(fresh.map(item => item.id))
  const freshRpcIds = new Set<string>()
  let oldestSeq: number | undefined
  let oldestTime = Number.POSITIVE_INFINITY
  for (const item of fresh) {
    const rpcId = rpcIdOf(item)
    if (rpcId !== undefined) freshRpcIds.add(rpcId)
    const seq = seqOf(item)
    if (seq !== undefined && (oldestSeq === undefined || seq < oldestSeq)) oldestSeq = seq
    if (item.createdAt < oldestTime) oldestTime = item.createdAt
  }

  const leading: ChatItem[] = []
  const trailing: ChatItem[] = []
  for (const item of local) {
    if (freshIds.has(item.id)) continue // 服务端权威覆盖同 id
    const rpcId = rpcIdOf(item)
    if (isLocalPrompt(item)) {
      if (rpcId === undefined || !freshRpcIds.has(rpcId)) trailing.push(item)
      continue
    }
    if (!retainEarlier) continue
    const seq = seqOf(item)
    const older = seq !== undefined && oldestSeq !== undefined ? seq < oldestSeq : item.createdAt < oldestTime
    if (older) leading.push(item)
  }

  return [...leading, ...fresh, ...trailing]
}

/* ────────────────────────────────────────────────────────────────────────
 * 八、加载态判定（纯函数；组件只画，自测逐条摆过）
 * ──────────────────────────────────────────────────────────────────────── */

export interface SessionListViewInput {
  /** 当前要显示多少行（合并后的列表长度） */
  rowCount: number
  /** 连接就绪（`phase === 'ready'`） */
  ready: boolean
  /** 服务端至少给过一次列表 */
  synced: boolean
  /** 正在拉列表 */
  syncing: boolean
}

/**
 * 会话列表的相位。
 *
 *    有行                       → content（缓存直出也是 content，靠顶部小标说明来源）
 *    没行 + 没连上              → idle    （保留原来的「未连接」，不要假装在加载）
 *    没行 + 正在/还没拉过       → skeleton（**不要**「远端还没有会话」）
 *    没行 + 服务端确认过        → empty
 */
export const sessionListViewState = (input: SessionListViewInput): SessionListPhase => {
  if (input.rowCount > 0) return 'content'
  if (!input.ready) return 'idle'
  if (!input.synced || input.syncing) return 'skeleton'
  return 'empty'
}

export interface TimelineViewInput {
  itemCount: number
  /** 首次拉取未完成 */
  loading: boolean
  /** 首次拉取已结束（成功或失败） */
  settled: boolean
  /** 首次拉取失败 */
  failed: boolean
}

/**
 * 会话内容的相位（**主区域**）。
 *
 *    有行                       → content
 *    没行 + 首次拉取没结束      → skeleton（骨架屏，绝不显示「这个会话还没有消息」）
 *    没行 + 拉完但失败了        → failed  （一行说明 + 重试；同样不是「没有消息」）
 *    没行 + 拉完且真没有        → empty   （**只有这一种情况**才允许说没有消息）
 */
export const timelineViewState = (input: TimelineViewInput): TimelinePhase => {
  if (input.itemCount > 0) return 'content'
  if (input.loading) return 'skeleton'
  if (input.failed) return 'failed'
  return input.settled ? 'empty' : 'skeleton'
}

export interface TimelineHintInput {
  itemCount: number
  fromCache: boolean
  settled: boolean
  failed: boolean
}

/**
 * 内容区顶部那条细提示。
 *
 *    有行 + 缓存直出且快照未到 → syncing（「正在同步…」）
 *    有行 + 拉失败了           → failed （「没同步上，先显示缓存」+ 重试）
 *    其余（没行时主区域自己会说）→ none
 */
export const timelineHintState = (input: TimelineHintInput): TimelineHint => {
  if (input.itemCount === 0) return 'none'
  if (input.failed) return 'failed'
  if (input.fromCache && !input.settled) return 'syncing'
  return 'none'
}
