/**
 * 远程页的「界面状态」快照 —— S1：切后台回来不再整页重来。
 *
 * ## 它解决什么
 *
 * 用户在真机上反馈「稍微退出去、重新进一下，它就容易刷新」。刷新之后三样东西没了：
 * 当前会话、时间线滚动位置、输入框里没发出去的草稿。前两样还能靠 `cache.ts` 的
 * 缓存直出补回来（会话列表 / 会话内容都在 `localStorage` 里），**草稿是没法从任何
 * 服务端状态推回来的** —— 它只存在于这一屏的内存里。
 *
 * 所以这里把「重载之后必须还在」的纯界面状态单独存一份：
 *
 * | 字段 | 恢复后看起来 |
 * |---|---|
 * | `activeSessionId` | 还是刚才那个会话（连上之前就先铺它的缓存） |
 * | `drafts` | 输入框里的字还在（按会话分键） |
 * | `timeline` | 时间线停在刚才的位置（不是跳回底部） |
 * | `sessionsScrollTop` | 会话列表的滚动位置（挂载点在 `RemoteSessionList`） |
 * | `mode` | 本机 / 远程的镜像（盘上那份仍是权威，见下） |
 *
 * ## 为什么两层（`sessionStorage` + 原生中转箱）
 *
 * `sessionStorage` 的寿命是**浏览上下文**：
 *
 * - 页面被重新加载（同一个 WebView）→ 还在。这是「页面内重载」这一档的恢复来源；
 * - WebView 被销毁重建（渲染进程被系统回收，壳会就地换一个 WebView，见
 *   `MainActivity.rebuildWebViewInPlace()`）→ **浏览器会清空它**。
 *
 * 第二档才是真机上最常见的那一档，只靠 `sessionStorage` 等于没做。所以同时推一份给
 * 原生壳的 `window.DSNativeUi`（`MainActivity.UiStateRelay`）：它挂在 Activity 上、
 * **只进内存不落盘**，换 WebView 不会丢，Activity 重建 / 退出应用就没了 ——
 * 正好是「这一次运行内有效」的语义，不会像 `localStorage` 那样跨启动残留、
 * 也不会把一个会话的草稿串到下一次会话里。
 *
 * 三层优先级（`resolveDraftRestore()`，自测逐条摆过）：
 *
 *     草稿（sessionStorage）> 缓存（原生中转箱 / 内存镜像）> 空
 *
 * ## 纪律
 *
 * 1. **只存纯界面状态**：不存 token、不存消息正文（正文归 `cache.ts`，它有自己的
 *    配额与裁剪策略；这里再存一份只会把 5 MB 的配额吃掉）；
 * 2. **坏数据当没有**：版本对不上 / JSON 坏了就当读不到，顺手删键；
 * 3. **写失败不抛**：隐私模式、配额满、原生桥不在 —— 一律静默退化成「这次不恢复」。
 *    恢复是锦上添花，不该让任何一条正常路径失败（与 `cache.ts` / `autoConnect.ts` 同一个原则）。
 */

/* ────────────────────────────────────────────────────────────────────────
 * 一、常量与形状
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 快照结构版本。**改结构就 +1**。
 *
 * 键名后缀（`.v1`）和这个字段必须一起改：前者防「旧数据被新代码按新结构解析」，
 * 后者防「有人手工改了键名但结构没换」。两处任何一个对不上都当没有快照（不迁移）。
 */
export const UI_STATE_VERSION = 1

/** `sessionStorage` 键（后缀的 `v1` 与 `UI_STATE_VERSION` 同步） */
export const UI_STATE_KEY = 'dsp.remote.ui-state.v1'

/** 单条草稿上限（字符）：够一段长说明，又不至于让每次按键都写几十 KB */
export const MAX_DRAFT_CHARS = 8_192

/** 最多记住几条草稿（按会话分键；超出的丢最旧的） */
export const MAX_DRAFTS = 4

/** 滚动位置上限（防御脏数据：负数 / NaN / 1e9 一律收紧） */
export const MAX_SCROLL_TOP = 10_000_000

/**
 * 推给原生中转箱的最小间隔（毫秒）。
 *
 * 草稿是逐字符改的，每次都过一遍 JNI 没有意义；真正的兜底是 `flushUiState()`
 * （切后台 / 页面卸载前立刻推一次，那才是「再没有下一次机会」的时刻）。
 */
export const RELAY_PUSH_INTERVAL_MS = 250

/** 本机 / 远程（与 `RemoteModeSwitch.tsx` 的 `ChatMode` 同一套字面量） */
export type ChatMode = 'local' | 'remote'

/** 一份状态是从哪一层恢复出来的（诊断 / 自测用） */
export type RestoreSource = 'draft' | 'cache' | 'empty'

/** 时间线的滚动位置（属于某个会话：换会话不能拿旧位置去套新内容） */
export interface UiScrollMark {
  sessionId: string
  top: number
  owner?: string
}

/** 一份完整的界面状态快照 */
export interface RemoteUiState {
  /** 结构版本（必须等于 `UI_STATE_VERSION`） */
  v: number
  /** 本机 / 远程的**镜像**：盘上那份（`dsp.remote.mode.v1`）才是权威 */
  mode: ChatMode | null
  /** 重载后要回到的会话 */
  activeSessionId: string | null
  activeSessionOwner?: string
  /** 草稿：键是会话 id（`''` = 会话还没打开时打的字，见 `patchDraft`） */
  drafts: Record<string, string>
  /** 时间线滚动位置（只对 `sessionId` 那个会话有效） */
  timeline: UiScrollMark | null
  /** 会话列表的滚动位置（挂载点在 `RemoteSessionList`，见该文件的注释） */
  sessionsScrollTop: number
  /** 最后一次写入时刻（毫秒；排障时判断「这份有多旧」） */
  updatedAt: number
}

/** 初值（每次都要一份新对象，别共享引用被改） */
export const emptyUiState = (): RemoteUiState => ({
  v: UI_STATE_VERSION,
  mode: null,
  activeSessionId: null,
  drafts: {},
  timeline: null,
  sessionsScrollTop: 0,
  updatedAt: 0,
})

/* ────────────────────────────────────────────────────────────────────────
 * 二、收紧（任何来源的对象都先过这里）
 * ──────────────────────────────────────────────────────────────────────── */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0

/** 滚动位置：非法 / 负数 / 非有限数一律 null（调用方据此当「没存过」） */
const clampScroll = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null
  }
  return Math.min(Math.round(value), MAX_SCROLL_TOP)
}

/** 会话 id 做键之前统一收紧（脏数据里可能是超长串 / 空串） */
const normalizeId = (value: unknown): string | null => {
  if (!isNonEmptyString(value)) {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed.slice(0, 128)
}

const ownerOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= 1024 ? value : undefined

/** 草稿表：丢掉空串 / 非字符串，超出上限截断，最多保留 `MAX_DRAFTS` 条（最近的） */
const sanitizeDrafts = (value: unknown): Record<string, string> => {
  const result: Record<string, string> = Object.create(null)
  if (!isRecord(value)) {
    return result
  }
  const keys = Object.keys(value).slice(-MAX_DRAFTS)
  for (const rawKey of keys) {
    const text = value[rawKey]
    if (typeof text !== 'string' || text.length === 0) {
      continue
    }
    const key = rawKey.slice(0, 1024)
    result[key] = text.length > MAX_DRAFT_CHARS ? text.slice(0, MAX_DRAFT_CHARS) : text
  }
  return result
}

/**
 * 把任意来源的原始对象收紧成一份可信快照。
 *
 * 版本不对 / 不是对象 → `null`。**绝不半信半疑地用一半字段**：一个 v2 的快照里
 * `drafts` 可能换了形状，只取能认出来的部分等于用错误的数据去改界面。
 */
export const sanitizeUiState = (raw: unknown): RemoteUiState | null => {
  if (!isRecord(raw) || raw.v !== UI_STATE_VERSION) {
    return null
  }
  const mode = raw.mode === 'local' || raw.mode === 'remote' ? raw.mode : null
  const activeSessionOwner = ownerOf(raw.activeSessionOwner)
  const timelineRaw = raw.timeline
  let timeline: UiScrollMark | null = null
  if (isRecord(timelineRaw)) {
    const sessionId = normalizeId(timelineRaw.sessionId)
    const top = clampScroll(timelineRaw.top)
    if (sessionId !== null && top !== null) {
      const owner = ownerOf(timelineRaw.owner)
      timeline = { sessionId, top, ...(owner === undefined ? {} : { owner }) }
    }
  }
  return {
    v: UI_STATE_VERSION,
    mode,
    activeSessionId: normalizeId(raw.activeSessionId),
    ...(activeSessionOwner === undefined ? {} : { activeSessionOwner }),
    drafts: sanitizeDrafts(raw.drafts),
    timeline,
    sessionsScrollTop: clampScroll(raw.sessionsScrollTop) ?? 0,
    updatedAt:
      typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) && raw.updatedAt >= 0
        ? raw.updatedAt
        : 0,
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * 三、存储适配（sessionStorage / 原生中转箱 / 内存镜像；异常全部退化成「没有」）
 * ──────────────────────────────────────────────────────────────────────── */

/** `sessionStorage` 取用点：隐私模式 / 配额满 / 非浏览器环境（例如 tsx 自测）返回 null */
const pageStore = (): Storage | null => {
  try {
    return globalThis.sessionStorage ?? null
  } catch {
    return null
  }
}

/** 原生壳的中转箱（`MainActivity.UiStateRelay`；普通浏览器里不存在） */
interface NativeUiRelay {
  take?: () => unknown
  put?: (payload: string) => unknown
  clear?: () => unknown
}

const nativeRelay = (): NativeUiRelay | null => {
  const scope = globalThis as { DSNativeUi?: NativeUiRelay; window?: { DSNativeUi?: NativeUiRelay } }
  const relay = scope.DSNativeUi ?? scope.window?.DSNativeUi
  return isRecord(relay) ? (relay as NativeUiRelay) : null
}

/** 本页面上下文里最后写入的那份（`sessionStorage` 与原生桥都不可用时的唯一来源） */
let mirror: RemoteUiState | null = null

/** 原生桥推送的节流定时器 */
let relayTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 读 `sessionStorage` 那一份（**最高优先级**）。
 *
 * 版本对不上 / JSON 坏了 → 顺手删键：不删的话每次启动都会白读一遍坏数据，
 * 而且下次写入之前一直读不到（`cache.ts` 同一个处理）。
 */
export const readUiState = (): RemoteUiState | null => {
  const store = pageStore()
  if (store === null) {
    return null
  }
  let raw: string | null
  try {
    raw = store.getItem(UI_STATE_KEY)
  } catch {
    return null
  }
  if (raw === null || raw.length === 0) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = null
  }
  const state = sanitizeUiState(parsed)
  if (state === null) {
    try {
      store.removeItem(UI_STATE_KEY)
    } catch {
      // 删不掉也不影响本次：反正已经当没有了
    }
    return null
  }
  return state
}

/**
 * 读**兜底**那一份：原生中转箱 → 内存镜像。
 *
 * 这一层存在的原因只有一个：WebView 被就地换掉时 `sessionStorage` 会被浏览器清空，
 * 而 Activity 上的中转箱还在（见文件头「为什么两层」）。
 */
export const readUiRelayState = (): RemoteUiState | null => {
  const relay = nativeRelay()
  if (relay !== null && typeof relay.take === 'function') {
    try {
      const raw = relay.take()
      if (typeof raw === 'string' && raw.length > 0) {
        const state = sanitizeUiState(JSON.parse(raw))
        if (state !== null) {
          return state
        }
      }
    } catch {
      // 桥不可用 / JSON 坏：退到内存镜像（它也空就当没有）
    }
  }
  return mirror
}

/** 启动时要用的两份（`primary` = 草稿层，`fallback` = 缓存层） */
export interface BootUiState {
  primary: RemoteUiState | null
  fallback: RemoteUiState | null
}

/**
 * 一次性取出启动需要的两层快照。
 *
 * 只读、同步、微秒级（一次 `sessionStorage` + 一次 JS 桥调用）：可以直接挂在
 * 首次渲染路径上，不需要任何 `await` —— 这决定了「恢复」会不会把首屏拖慢。
 */
export const loadBootUiState = (): BootUiState => ({
  primary: readUiState(),
  fallback: readUiRelayState(),
})

/** 把内存里的那份推给原生中转箱（失败静默：桥不在就是普通浏览器 / 旧 APK） */
const pushRelay = (): void => {
  if (mirror === null) {
    return
  }
  const relay = nativeRelay()
  if (relay === null || typeof relay.put !== 'function') {
    return
  }
  try {
    relay.put(JSON.stringify(mirror))
  } catch {
    // 桥在页面重载后被回收（旧上下文）：不影响本页面继续用 sessionStorage
  }
}

/**
 * **立刻**把当前快照推到原生中转箱。
 *
 * 调用点只有一个语义：马上就再也没有机会了（切后台、页面卸载）。定时器那一份
 * （`RELAY_PUSH_INTERVAL_MS`）只负责压住「打字时每个字符推一次」的频率。
 */
export const flushUiState = (): void => {
  if (relayTimer !== null) {
    clearTimeout(relayTimer)
    relayTimer = null
  }
  pushRelay()
}

const scheduleRelayPush = (): void => {
  if (relayTimer !== null) {
    return
  }
  relayTimer = setTimeout(() => {
    relayTimer = null
    pushRelay()
  }, RELAY_PUSH_INTERVAL_MS)
}

/**
 * 合并写入（读-改-写）。
 *
 * 三层都写：内存镜像（同页面后续读取）、`sessionStorage`（页面内重载）、原生中转箱
 * （换 WebView）。任何一层失败都不抛 —— 返回的始终是一份可用的新快照。
 */
export const writeUiState = (patch: Partial<RemoteUiState>): RemoteUiState => {
  const base = mirror ?? readUiState() ?? readUiRelayState() ?? emptyUiState()
  const merged: unknown = { ...base, ...patch, v: UI_STATE_VERSION, updatedAt: Date.now() }
  const next = sanitizeUiState(merged) ?? emptyUiState()
  mirror = next
  const store = pageStore()
  if (store !== null) {
    try {
      store.setItem(UI_STATE_KEY, JSON.stringify(next))
    } catch {
      // 配额满 / 隐私模式：这一层失效，内存镜像与原生中转箱仍然有效
    }
  }
  scheduleRelayPush()
  return next
}

/* ────────────────────────────────────────────────────────────────────────
 * 四、按字段的写入口（调用方不需要自己拼合并）
 * ──────────────────────────────────────────────────────────────────────── */

/** 草稿的键：会话还没打开时用空串（连上之后那次写入会自动挪到会话 id 下） */
const draftKey = (sessionId: string | null): string => sessionId ?? ''

/**
 * 写一条草稿（空串 = 删掉这条）。
 *
 * 按会话分键而不是只留一条：用户在 A 里打了一半、切到 B 看消息、再切回来，草稿不该串。
 * 上限 `MAX_DRAFTS` 条，超出的由 `sanitizeDrafts()` 丢掉最旧的。
 */
export const patchDraft = (sessionId: string | null, text: string): RemoteUiState => {
  const base = mirror ?? readUiState() ?? readUiRelayState() ?? emptyUiState()
  const drafts: Record<string, string> = { ...base.drafts }
  const key = draftKey(sessionId)
  delete drafts[key]
  return writeUiState({ drafts: text === '' ? drafts : { ...drafts, [key]: text } })
}

/** 记下「重载后要回到哪个会话」（`null` = 没有会话可回，例如刚退出登录） */
export const patchActiveSession = (sessionId: string | null, owner?: string): RemoteUiState =>
  writeUiState({ activeSessionId: sessionId === null ? null : normalizeId(sessionId), activeSessionOwner: owner })

/** 记下本机 / 远程（只是镜像；盘上那份由 `RemoteModeSwitch` 写，仍是权威） */
export const patchMode = (mode: ChatMode): RemoteUiState => writeUiState({ mode })

/** 记下时间线的滚动位置（属于 `sessionId` 这个会话） */
export const patchTimelineScroll = (sessionId: string | null, top: number, owner?: string): RemoteUiState => {
  const normalized = sessionId === null ? null : normalizeId(sessionId)
  const clamped = clampScroll(top)
  if (normalized === null || clamped === null) {
    return mirror ?? emptyUiState()
  }
  return writeUiState({ timeline: { sessionId: normalized, top: clamped, owner } })
}

/** 记下会话列表的滚动位置（挂载点在 `RemoteSessionList`，见该文件的注释） */
export const patchSessionsScroll = (top: number): RemoteUiState => {
  const clamped = clampScroll(top)
  if (clamped === null) {
    return mirror ?? emptyUiState()
  }
  return writeUiState({ sessionsScrollTop: clamped })
}

/** 清空（退出登录 / 用户主动清状态；幂等） */
export const clearUiState = (): void => {
  mirror = null
  if (relayTimer !== null) {
    clearTimeout(relayTimer)
    relayTimer = null
  }
  const store = pageStore()
  if (store !== null) {
    try {
      store.removeItem(UI_STATE_KEY)
    } catch {
      // 删不掉就算了：版本与结构校验会挡住脏数据
    }
  }
  const relay = nativeRelay()
  if (relay !== null && typeof relay.clear === 'function') {
    try {
      relay.clear()
    } catch {
      // 桥不在了：本来也就没有要清的
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * 五、恢复优先级（纯函数；自测逐条摆过）
 * ──────────────────────────────────────────────────────────────────────── */

/** 某一层里这个会话的草稿（空串 / 不存在都算「没有」） */
const draftOf = (state: RemoteUiState | null, sessionId: string | null): string | null => {
  if (state === null) {
    return null
  }
  const key = draftKey(sessionId)
  if (!Object.prototype.hasOwnProperty.call(state.drafts, key)) {
    return null
  }
  const text = state.drafts[key]
  return typeof text === 'string' && text.length > 0 ? text : null
}

export interface DraftRestoreInput {
  /** 草稿层（`sessionStorage`） */
  primary: RemoteUiState | null
  /** 缓存层（原生中转箱 / 内存镜像） */
  fallback: RemoteUiState | null
  /** 要恢复哪个会话的草稿（启动时是快照里记下的那个） */
  sessionId: string | null
}

export interface DraftRestore {
  text: string
  /** `draft` = 草稿层命中；`cache` = 缓存层命中；`empty` = 都没有 */
  source: RestoreSource
}

/**
 * 输入框该填什么：**草稿 > 缓存 > 空**。
 *
 * 为什么是这个顺序：草稿层是「这次重载前输入框里真实的那串字」，缓存层是它在换
 * WebView 之前的副本 —— 前者永远更可信。
 */
export const resolveDraftRestore = (input: DraftRestoreInput): DraftRestore => {
  const fromPrimary = draftOf(input.primary, input.sessionId)
  if (fromPrimary !== null) {
    return { text: fromPrimary, source: 'draft' }
  }
  const fromFallback = draftOf(input.fallback, input.sessionId)
  if (fromFallback !== null) {
    return { text: fromFallback, source: 'cache' }
  }
  return { text: '', source: 'empty' }
}

export interface SessionRestoreInput {
  primary: RemoteUiState | null
  fallback: RemoteUiState | null
  owner?: string
}

/** 重载后该回到哪个会话（同样草稿层优先；两层都没有就 null = 什么都不恢复） */
export const resolveActiveSession = (input: SessionRestoreInput): string | null => {
  const matches = (state: RemoteUiState | null) =>
    state && (state.activeSessionOwner === undefined || state.activeSessionOwner === input.owner) ? state.activeSessionId : null
  return matches(input.primary) ?? matches(input.fallback)
}

export interface TimelineScrollInput extends SessionRestoreInput {
  sessionId: string | null
}

/**
 * 时间线该滚到哪（只认**同一个会话**记下的位置）。
 *
 * 换过会话就不能拿旧位置套新内容：那会把用户丢到一个和内容无关的高度上。
 */
export const resolveTimelineScroll = (input: TimelineScrollInput): number | null => {
  const sessionId = input.sessionId
  if (sessionId === null) {
    return null
  }
  const matches = (mark?: UiScrollMark | null) => mark?.sessionId === sessionId &&
    (mark.owner === undefined || mark.owner === input.owner) ? mark.top : null
  return matches(input.primary?.timeline) ?? matches(input.fallback?.timeline)
}

/** 会话列表该滚到哪（0 / 没存过 → null；同样草稿层优先，别被一个 0 挡在缓存层前面） */
export const resolveSessionsScroll = (input: SessionRestoreInput): number | null => {
  const primaryTop = input.primary?.sessionsScrollTop ?? 0
  if (primaryTop > 0) {
    return primaryTop
  }
  const fallbackTop = input.fallback?.sessionsScrollTop ?? 0
  return fallbackTop > 0 ? fallbackTop : null
}
