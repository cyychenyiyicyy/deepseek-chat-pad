/**
 * 远程 DSH：**原生通知中心**（`/__ds_notify/*`，原生侧 `RemoteNotifyHandler.java`）。
 *
 * ## 为什么需要它
 *
 * 页面在后台会被 WebView 冻结（`pauseTimers`），Web Notification 在 WebView 里又根本没实现，
 * 所以「退到后台时告诉用户：谁在跑、在调什么工具、跑完了、等你审批」只有原生
 * `NotificationManager` 一条路。这一层只做两件事：把状态**整理成快照**、把网络调用
 * **去抖 + 去重**；渲染与通知 id 全交给原生。
 *
 * ## 原生契约（与 `RemoteNotifyHandler.java` 逐字段对齐）
 *
 * | 端点 | 方法 | 语义 |
 * |---|---|---|
 * | `/__ds_notify/work`      | POST | 全量快照 `{items:[{sessionId,title,state,tool?,detail?,ts}],activeSessionId?}` |
 * | `/__ds_notify/clear`     | POST | `{sessionId?}`：带 id 清这个会话，不带清全部工作通知 |
 * | `/__ds_notify/state.json`| GET  | 能力探测 `{ok,granted,posted:[ids],…}` |
 *
 * ⚠️ **探测必须用带 `.json` 的路径**：旧 APK 没有这些路由，请求会掉进静态资源的 SPA 兜底
 * （最后一段没扩展名就回 `index.html`），对 `/__ds_notify/state` 会回 **200 + HTML**。
 * 带点的路径不触发回落 —— 旧 APK 真 404、新 APK 真 JSON（与 `permissions.ts` 同一套理由）。
 *
 * ## 三条纪律
 *
 * 1. **只发摘要，不发正文**：`detail` 是一句话（如「调用了 读取 README.md」），
 *    正文 / 工具输出 / 参数原文一律不进通知 —— 既为隐私，也为体积（锁屏可见）。
 * 2. **合并 + 去重**：200~400ms 内多次调用只发一次（以最后一次为准）；载荷与上次**逐字段
 *    浅比较**，没变化就不发 —— 原生那边虽然有 digest 去重，但少发一次就少一次唤醒。
 * 3. **失败静默**：任何失败都不抛、不影响远程连接（通知是锦上添花）。网络类失败重试 2 次；
 *    404 / HTML / 形状不对 = 旧 APK，**整块禁用**，不再骚扰。
 *
 * ## 生命周期（这一层只管「发」，不管「留多久」）
 *
 * - `pushWorkState()` 进去是**当前态**快照，原生按快照对齐通知栏（进行中合并成一条汇总，
 *   完成 / 出错 / 待审批各一条事件通知）；
 * - 「已完成的通知挂 30s 再清」属于业务生命周期，由 `store.ts` 的桥负责（它同时要把这条
 *   从后续快照里摘掉，否则原生会按同 id 再画回来）；
 * - `reset()` 丢掉还没发的合并帧（断开连接时用，防止晚到的帧把已清掉的通知又弹回来）。
 */

import type { FetchLike } from './serverApi.js'

/** 推一份当前态快照（POST，幂等） */
export const NOTIFY_WORK_PATH = '/__ds_notify/work'
/** 清通知（POST，幂等）：带 `sessionId` 清这个会话，不带清全部 */
export const NOTIFY_CLEAR_PATH = '/__ds_notify/clear'
/** 能力探测（GET；**必须带 `.json`**，见文件头） */
export const NOTIFY_STATE_PATH = '/__ds_notify/state.json'

/** 合并窗口：这段时间内的多次 `pushWorkState()` 合成一次请求（任务书要求 200~400ms） */
export const NOTIFY_DEBOUNCE_MS = 250
/** 单次原生调用的超时：本地端口正常是毫秒级，3s 已经非常宽裕 */
export const NOTIFY_TIMEOUT_MS = 3_000

/** 一次最多认这么多条（与原生 `MAX_ITEMS` 一致；正常只会推 1 条） */
export const NOTIFY_MAX_ITEMS = 24
/** 字段硬上限：与原生 `MAX_TITLE_CHARS` / `MAX_TOOL_CHARS` 对齐，`detail` 我们自己收得更紧 */
export const NOTIFY_SESSION_ID_MAX = 128
export const NOTIFY_TITLE_MAX = 80
export const NOTIFY_TOOL_MAX = 40
export const NOTIFY_DETAIL_MAX = 120

/** 通知的四态（原生 `STATE_*` 字面量，改这里要同步改原生） */
export type WorkState = 'running' | 'done' | 'error' | 'approval'

/**
 * 一条任务快照。
 *
 * **字段是白名单**：只有下面六个键会被序列化（`sanitizeWorkItem()` 重新建对象）。
 * 调用方哪怕塞了 `text` / `output` / `arguments` 之类的字段，也到不了原生、更到不了锁屏。
 */
export interface WorkItem {
  /** 远端会话 id（`sessionId`） */
  sessionId: string
  /** 会话标题（通知标题的主要成分） */
  title: string
  state: WorkState
  /** 正在调用的工具名（只有展示名，不带参数） */
  tool?: string
  /** 一句话摘要，**不是正文**：如「调用了 读取 README.md」 */
  detail?: string
  /** 事件时间（原生用它做 digest，同一条事件 ts 稳定才不会反复响铃） */
  ts: number
}

/** 一次推送的载荷（= 原生 `/work` 的请求体） */
export interface WorkPush {
  items: WorkItem[]
  /** 当前活动会话：原生点汇总通知时带它回 App */
  activeSessionId?: string
}

/** 探测失败的原因（只用于排障与「要不要粘住不支持」的判断） */
export type NotifyProbeReason = 'no-endpoint' | 'unreachable' | 'bad-response'

/** 原生通知能力（`/__ds_notify/state.json` 的投影） */
export interface NotifyCapability {
  /** 端点真的存在（旧 APK = false） */
  supported: boolean
  /** 通知权限 + 渠道是否可见（原生 `granted`） */
  granted: boolean
  /** 原生已发出的通知 id（诊断用） */
  posted: number[]
  /** `supported:false` 时的原因；`unreachable` = 这次没打通（可以过几秒再试） */
  reason?: NotifyProbeReason
}

export interface NotifyDeps {
  /** 只用到 fetch 的最小切面（自测注入；生产留空走页面全局 fetch，同源即可） */
  fetch?: FetchLike
  /** 时间源（自测注入；生产 = `Date.now`） */
  now?: () => number
  /** 定时器（自测注入；生产 = `setTimeout`） */
  schedule?: (fn: () => void, ms: number) => unknown
  /** 取消定时器（自测注入；生产 = `clearTimeout`） */
  cancel?: (handle: unknown) => void
  /** 合并窗口（自测可调小） */
  debounceMs?: number
  /** 失败重试的等待时间（长度 = 重试次数，默认 2 次；自测可调小） */
  retryDelaysMs?: readonly number[]
}

/** 通知器（单例见文件底部的 `notify`；自测可以 `createWorkNotifier()` 各造一个） */
export interface WorkNotifier {
  /** 推一份快照（合并去抖；返回的 Promise 在这**一批**发完/被跳过之后 resolve，永不 reject） */
  pushWorkState(push: WorkPush): Promise<void>
  /** 清这个会话的通知；不传 = 清全部工作通知（含进行中汇总） */
  clearWork(sessionId?: string): Promise<void>
  /** 探一次原生能力；404 / HTML / 形状不对 → `supported:false`（不会缓存「不可达」） */
  probeNotify(): Promise<NotifyCapability>
  /** 丢掉还没发的合并帧、撤销所有定时器（断开连接时用） */
  reset(): void
  /** 排障用的一行摘要（日志 / 自测断言，不含任何会话内容） */
  describe(): string
}

interface ResolvedDeps {
  fetch: FetchLike
  now: () => number
  schedule: (fn: () => void, ms: number) => unknown
  cancel: (handle: unknown) => void
  retryDelays: readonly number[]
}

const defaultFetch: FetchLike = (input, init) => fetch(input, init)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isWorkState = (value: unknown): value is WorkState =>
  value === 'running' || value === 'done' || value === 'error' || value === 'approval'

/**
 * 字段清洗：**单行化 + 截断**。
 *
 * 控制字符（含换行 / 制表）一律换成空格 —— 通知栏里的换行会被系统渲染成多行，
 * 既难看也等于把「多行正文」偷偷塞进标题。按**码点**截断，避免把 emoji 切成半个。
 */
const cleanText = (value: unknown, max: number): string => {
  if (typeof value !== 'string') return ''
  let single = ''
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    single += code < 0x20 || code === 0x7f ? ' ' : char
  }
  const collapsed = single.replace(/\s+/gu, ' ').trim()
  const chars = [...collapsed]
  return chars.length <= max ? collapsed : chars.slice(0, max).join('')
}

/**
 * 一条快照的清洗（白名单重建）。
 *
 * `state` 不在四态里、`sessionId` 空 → 整条丢掉（原生也会丢，但那算 `ignored`，
 * 我们干脆不浪费带宽）。
 */
const sanitizeWorkItem = (raw: WorkItem, now: () => number): WorkItem | null => {
  if (typeof raw !== 'object' || raw === null) return null
  const sessionId = cleanText(raw.sessionId, NOTIFY_SESSION_ID_MAX)
  if (sessionId.length === 0) return null
  if (!isWorkState(raw.state)) return null
  const title = cleanText(raw.title, NOTIFY_TITLE_MAX)
  const tool = cleanText(raw.tool, NOTIFY_TOOL_MAX)
  const detail = cleanText(raw.detail, NOTIFY_DETAIL_MAX)
  const stamp = typeof raw.ts === 'number' && Number.isFinite(raw.ts) && raw.ts > 0 ? Math.round(raw.ts) : now()
  return {
    sessionId,
    // 空标题给个占位：原生也会这么做（`title.isEmpty()` → 「会话」），这里先对齐
    title: title.length === 0 ? '会话' : title,
    state: raw.state,
    ...(tool.length === 0 ? {} : { tool }),
    ...(detail.length === 0 ? {} : { detail }),
    ts: stamp,
  }
}

/** 清洗 + 截条数；一条都不剩就返回 `null`（调用方直接跳过这次推送） */
export const normalizeWorkPush = (push: WorkPush, now: () => number = () => Date.now()): WorkPush | null => {
  const source = Array.isArray(push.items) ? push.items : []
  const items: WorkItem[] = []
  for (const raw of source) {
    const item = sanitizeWorkItem(raw, now)
    if (item === null) continue
    items.push(item)
    if (items.length >= NOTIFY_MAX_ITEMS) break
  }
  if (items.length === 0) return null
  const activeSessionId = cleanText(push.activeSessionId, NOTIFY_SESSION_ID_MAX)
  return { items, ...(activeSessionId.length === 0 ? {} : { activeSessionId }) }
}

/** 逐字段浅比较（载荷没变就不发；比 JSON 字符串比较更明确，也不受键序影响） */
export const sameWorkPush = (a: WorkPush, b: WorkPush): boolean => {
  if (a.activeSessionId !== b.activeSessionId) return false
  if (a.items.length !== b.items.length) return false
  return a.items.every((item, index) => {
    const other = b.items[index]
    if (other === undefined) return false
    return (
      item.sessionId === other.sessionId &&
      item.title === other.title &&
      item.state === other.state &&
      item.tool === other.tool &&
      item.detail === other.detail &&
      item.ts === other.ts
    )
  })
}

interface NativeReply {
  status: number
  body: unknown
  text: string
}

type ReplyKind = 'ok' | 'unsupported' | 'retry' | 'reject'

/**
 * 打一次原生端点。**永不抛**：连不上 / 超时 / 非 JSON 都折成 `null` 或纯文本，
 * 由 `classify()` 决定「重试 / 禁用 / 放弃」。
 */
const call = async (
  path: string,
  init: { method: string; body?: string },
  deps: ResolvedDeps,
): Promise<NativeReply | null> => {
  const controller = typeof AbortController === 'undefined' ? null : new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    if (controller !== null) timer = setTimeout(() => controller.abort(), NOTIFY_TIMEOUT_MS)
    const response = await deps.fetch(path, {
      method: init.method,
      ...(init.body === undefined ? {} : { body: init.body, headers: { 'Content-Type': 'application/json' } }),
      cache: 'no-store',
      // 同源本地端口，不带 cookie：别让 WebView 的 cookie 策略把这次请求拖住
      credentials: 'omit',
      ...(controller === null ? {} : { signal: controller.signal }),
    })
    let text = ''
    try {
      text = await response.text()
    } catch {
      text = ''
    }
    let body: unknown
    if (text.length > 0) {
      try {
        body = JSON.parse(text)
      } catch {
        // 可能是 SPA 的 index.html（旧 APK 的静态兜底）：当成非 JSON
        body = undefined
      }
    }
    return { status: response.status, body, text }
  } catch {
    return null
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 判定一次回包：
 *   - `retry`       —— 连不上 / 5xx：过一会儿再试；
 *   - `unsupported` —— 404 / 405 / 200 的 HTML：旧 APK，整块禁用；
 *   - `reject`      —— 其它 4xx / `{ok:false}`：这次不发，但别禁用（可能是临时业务失败）。
 */
const classify = (reply: NativeReply | null, requireOk: boolean): ReplyKind => {
  if (reply === null) return 'retry'
  if (reply.status === 404 || reply.status === 405 || reply.status === 501) return 'unsupported'
  if (reply.status >= 500) return 'retry'
  if (reply.status < 200 || reply.status >= 300) return 'reject'
  // 旧 APK 的 SPA 兜底：200 + HTML（`/work` 打错也会掉到静态资源）
  if (reply.body === undefined && reply.text.trimStart().startsWith('<')) return 'unsupported'
  if (!isRecord(reply.body)) return 'unsupported'
  if (requireOk && reply.body.ok === false) return 'reject'
  return 'ok'
}

/**
 * 造一个通知器。
 *
 * 生产用文件底部的单例 `notify`；自测用这个工厂，每个实例独立记账、独立注入 fetch/定时器。
 */
export const createWorkNotifier = (overrides: NotifyDeps = {}): WorkNotifier => {
  const deps: ResolvedDeps = {
    fetch: overrides.fetch ?? defaultFetch,
    now: overrides.now ?? (() => Date.now()),
    schedule: overrides.schedule ?? ((fn, ms) => setTimeout(fn, ms)),
    cancel: overrides.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
    retryDelays: overrides.retryDelaysMs ?? [300, 800],
  }
  const debounceMs = overrides.debounceMs ?? NOTIFY_DEBOUNCE_MS

  /** 还没发出去的那一批（合并窗口内的多次调用以最后一次为准，waiters 全部挂在这里） */
  let pending: { push: WorkPush; waiters: (() => void)[] } | null = null
  let timer: unknown = null
  /** 上一次**成功发出**的载荷：逐字段浅比较用 */
  let lastSent: WorkPush | null = null
  /** 404 / HTML 之后整块禁用（旧 APK 不会在运行中变新） */
  let unsupported = false
  /** 探测结果（只记「支持 / 不支持」；`granted` 每次都现探 —— 渠道可能被用户随手关掉） */
  let support: 'unknown' | 'yes' | 'no' = 'unknown'
  /** 代际：`reset()` 自增，用来丢掉 reset 之前发起的重试 */
  let generation = 0
  /** 在飞的那一批（`clearWork()` 要等它落地，避免「清完又被旧帧画回来」） */
  let flushing: Promise<void> | null = null
  let sent = 0
  let skipped = 0
  let failed = 0

  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      deps.schedule(() => resolve(), ms)
    })

  /** 把一批的等待者全部放行（无论发没发出去，调用方都不该被挂住） */
  const settle = (batch: { push: WorkPush; waiters: (() => void)[] } | null): void => {
    if (batch === null) return
    for (const resolve of batch.waiters) resolve()
  }

  /** 停掉合并窗口的定时器并放行等待者（丢掉这一批） */
  const dropPending = (): void => {
    const batch = pending
    pending = null
    if (timer !== null) {
      deps.cancel(timer)
      timer = null
    }
    settle(batch)
  }

  /** 全清时丢掉整个待发批；按会话清时只摘掉这个会话（其余会话的帧继续发） */
  const dropPendingFor = (sessionId?: string): void => {
    if (pending === null) return
    if (sessionId === undefined) {
      dropPending()
      return
    }
    const kept = pending.push.items.filter(item => item.sessionId !== sessionId)
    if (kept.length === pending.push.items.length) return
    pending = { push: { items: kept, ...(pending.push.activeSessionId === undefined ? {} : { activeSessionId: pending.push.activeSessionId }) }, waiters: pending.waiters }
    if (kept.length === 0) dropPending()
  }

  const sendWork = async (push: WorkPush, gen: number): Promise<'ok' | 'unsupported' | 'failed'> => {
    const body = JSON.stringify({
      items: push.items,
      ...(push.activeSessionId === undefined ? {} : { activeSessionId: push.activeSessionId }),
    })
    for (let attempt = 0; attempt <= deps.retryDelays.length; attempt += 1) {
      if (attempt > 0) {
        const delay = deps.retryDelays[attempt - 1] ?? 0
        await sleep(delay)
      }
      if (gen !== generation) return 'failed'
      const kind = classify(await call(NOTIFY_WORK_PATH, { method: 'POST', body }, deps), true)
      if (kind === 'ok') return 'ok'
      if (kind === 'unsupported') return 'unsupported'
      if (kind === 'reject') return 'failed'
    }
    return 'failed'
  }

  /** 合并窗口到点：把这一批发出去（内容与上次相同就跳过） */
  const flush = async (): Promise<void> => {
    timer = null
    const batch = pending
    pending = null
    if (batch === null) return
    const gen = generation
    try {
      if (unsupported) return
      if (lastSent !== null && sameWorkPush(lastSent, batch.push)) {
        skipped += 1
        return
      }
      const result = await sendWork(batch.push, gen)
      if (gen !== generation) return
      if (result === 'ok') {
        lastSent = batch.push
        sent += 1
        return
      }
      if (result === 'unsupported') unsupported = true
      failed += 1
    } finally {
      settle(batch)
    }
  }

  const pushWorkState = (input: WorkPush): Promise<void> => {
    const now = deps.now
    const push = normalizeWorkPush(input, now)
    if (push === null) return Promise.resolve()
    if (unsupported) return Promise.resolve()
    return new Promise<void>((resolve) => {
      if (pending === null) {
        pending = { push, waiters: [resolve] }
      } else {
        // 合并：内容以最后一次为准，等待者全都挂上
        pending.push = push
        pending.waiters.push(resolve)
      }
      if (timer === null) {
        timer = deps.schedule(() => {
          const task = flush()
          flushing = task
          void task.finally(() => {
            if (flushing === task) flushing = null
          })
        }, debounceMs)
      }
    })
  }

  const clearWork = async (sessionId?: string): Promise<void> => {
    dropPendingFor(sessionId)
    // 在飞的那一批先落地：否则它可能比 /clear 晚到，把刚撤掉的通知又画回来
    const inFlight = flushing
    if (inFlight !== null) await inFlight.catch(() => undefined)
    if (unsupported) return
    const body = JSON.stringify(sessionId === undefined ? {} : { sessionId })
    const kind = classify(await call(NOTIFY_CLEAR_PATH, { method: 'POST', body }, deps), true)
    if (kind === 'unsupported') {
      unsupported = true
      return
    }
    if (kind !== 'ok') {
      failed += 1
      return
    }
    // 注意：**不**清 `lastSent` —— 清掉之后，一条在飞的旧快照（内容与上次相同）会被判定成
    // 「新变化」再发一遍，把刚撤掉的通知又画回来。断开重连由 `reset()` 负责忘掉。
    sent += 1
  }

  const probeNotify = async (): Promise<NotifyCapability> => {
    if (unsupported) return { supported: false, granted: false, posted: [], reason: 'no-endpoint' }
    // 每次都现探：`granted` 是「运行时权限 && 总闸 && 三条渠道都可见」，用户随手关一条渠道就变了，
    // 缓存它会让 UI 显示成已经开了（R3 §2.3 那类「假成功」的翻版）。
    const reply = await call(NOTIFY_STATE_PATH, { method: 'GET' }, deps)
    const kind = classify(reply, false)
    if (kind === 'unsupported') {
      unsupported = true
      support = 'no'
      return { supported: false, granted: false, posted: [], reason: 'no-endpoint' }
    }
    if (kind === 'retry') return { supported: false, granted: false, posted: [], reason: 'unreachable' }
    if (kind === 'reject' || reply === null || !isRecord(reply.body)) {
      return { supported: false, granted: false, posted: [], reason: 'bad-response' }
    }
    support = 'yes'
    const posted = Array.isArray(reply.body.posted)
      ? reply.body.posted.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
      : []
    return { supported: true, granted: reply.body.granted === true, posted }
  }

  const reset = (): void => {
    generation += 1
    dropPending()
    lastSent = null
  }

  const describe = (): string => {
    const state = unsupported ? 'unsupported' : support
    const pendingCount = pending === null ? 0 : pending.push.items.length
    return `notify|${state}|sent=${sent}|skipped=${skipped}|failed=${failed}|pending=${pendingCount}`
  }

  return { pushWorkState, clearWork, probeNotify, reset, describe }
}

/* ────────────────────────────────────────────────────────────────────────
 * 单例（生产用；store.ts 只 import 这几个函数，不需要知道工厂）
 * ──────────────────────────────────────────────────────────────────────── */

/** 页面里唯一的通知器（记账是进程级的，重复建实例会打破合并/去重语义） */
export const notify: WorkNotifier = createWorkNotifier()

/** 推一份快照（合并去抖；失败静默）。参数见 `WorkPush`。 */
export const pushWorkState = (push: WorkPush): Promise<void> => notify.pushWorkState(push)

/** 清这个会话的通知；不传 = 清全部工作通知。 */
export const clearWork = (sessionId?: string): Promise<void> => notify.clearWork(sessionId)

/** 探一次原生能力（404 / HTML → `supported:false`，调用方整块禁用）。 */
export const probeNotify = (): Promise<NotifyCapability> => notify.probeNotify()

/** 丢掉还没发的合并帧、撤销所有定时器（断开连接时用）。 */
export const resetNotify = (): void => notify.reset()

/** 排障摘要（不含任何会话内容）。 */
export const describeNotify = (): string => notify.describe()
