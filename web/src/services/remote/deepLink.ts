/**
 * 远程 DSH：**点通知直达会话**（R14，原生侧 `MainActivity` + `RemoteNotifyHandler`）。
 *
 * ## 链路
 *
 * ```
 * 通知被点
 *   ├─ App 已在前台 ─► MainActivity.onNewIntent ─► 收进进程内信箱 ─► 推 window 'ds:deeplink'
 *   ├─ App 在后台   ─► onNewIntent ─► 同上（回前台时 visibilitychange 还会补一拍）
 *   └─ 进程被杀     ─► onCreate 读 getIntent() ─► 同上（页面启动那一拍取走）
 *                                                    │
 *   GET /__ds_notify/open.json ──► {ok,pendingSessionId,hasPending,rev}   ← **读后清空**
 *                                                    │
 *                                    enterRemoteMode() ─► 等连接 ready ─► openSession(id)
 * ```
 *
 * ## 三条纪律
 *
 * 1. **读后清空 = 幂等**：原生那边的信箱一被取走就没了，所以「启动 + 每次回前台 + 原生推事件」
 *    这三处都可以无脑拉一次，不会把用户反复拽回同一个会话。页面这一层再加一道
 *    `rev|sessionId` 去重，防的是「原生推事件」与「visibilitychange」在同一瞬间各拉一次。
 * 2. **等连接，不抢跑**：点通知进来时远程连接通常还没建立（App 冷启动 → 自动恢复要 refresh
 *    token + 建链）。所以拿到 id 后先切到远程页，再等 `phase === 'ready'`（上限
 *    {@link DEEP_LINK_READY_TIMEOUT_MS}）；等不到就说「还没连上电脑」，绝不静默失败。
 * 3. **会话不在就说人话**：列表是「缓存先铺、服务端后合并」的（R8），手上这份缺行不代表
 *    会话没了 —— 所以先就地查，查不到强制同步一次，两次都没有才提示「会话已不存在」。
 *
 * ## 为什么探测必须用带 `.json` 的路径
 *
 * 旧 APK 没有这条路由，请求会掉进静态资源的 SPA 兜底（最后一段没扩展名就回 `index.html`），
 * 对 `/__ds_notify/open` 会回 **200 + 一段 HTML**。带点的路径不触发回落：旧 APK 真 404、
 * 新 APK 真 JSON（与 `notify.ts` / `permissions.ts` 同一套理由）。判到 404 / HTML 就
 * **整块禁用**，不在普通浏览器里每次回前台都白打一次。
 */

import { showToast } from '../../components/base/toastState.js'
import { translate } from '../../i18n/index.js'
import type { FetchLike } from './serverApi.js'

/** 原生端点（`RemoteNotifyHandler.java` 的 `PATH_OPEN_PROBE`） */
export const DEEP_LINK_OPEN_PATH = '/__ds_notify/open.json'
/** 原生在「App 已经在前台时点通知」推的 window 事件（`MainActivity.notifyPageDeepLink`） */
export const DEEP_LINK_EVENT = 'ds:deeplink'
/** 等连接 ready 的预算：自动恢复里 refresh token + 建链的实测耗时在 15 s 以内 */
export const DEEP_LINK_READY_TIMEOUT_MS = 20_000
/** 等 ready 的轮询间隔（本地状态，不打网络） */
export const DEEP_LINK_READY_POLL_MS = 400
/** 单次原生调用的超时：本地回环端口是毫秒级，3 s 已经非常宽裕 */
export const DEEP_LINK_TIMEOUT_MS = 3_000

const defaultFetch: FetchLike = (input, init) => fetch(input, init)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/* ────────────────────────────────────────────────────────────────────────
 * 一、读原生信箱
 * ──────────────────────────────────────────────────────────────────────── */

/** 这个环境有没有「点通知直达」（旧 APK / 普通浏览器没有） */
export type DeepLinkProbe =
  | {
      supported: true
      /** 待打开的会话 id（空串 = 这次没有） */
      pendingSessionId: string
      /** 原生累计投递次数（排障用：区分「同一条读了两次」与「又来了一条新的」） */
      rev: number
    }
  | { supported: false; reason: 'no-endpoint' | 'unreachable' }

/** 只用到 fetch 的最小切面（自测注入；生产留空走页面全局 fetch，同源即可） */
export interface DeepLinkFetchDeps {
  fetch?: FetchLike
}

interface RawReply {
  status: number
  json: unknown
}

/**
 * 打一次原生端点。**永不抛**：连不上 / 超时 / 非 JSON 都折成 `null`。
 *
 * 带 `credentials:'omit'`：同源本地端口，别让 WebView 的 cookie 策略拖住这次请求；
 * 带 `cache:'no-store'`：这条 GET 有副作用（读后清空），任何一层都不能缓存。
 */
const request = async (deps: DeepLinkFetchDeps, path: string): Promise<RawReply | null> => {
  const fetchLike = deps.fetch ?? defaultFetch
  const canAbort = typeof AbortController !== 'undefined'
  const controller = canAbort ? new AbortController() : null
  const timer =
    controller === null ? null : setTimeout(() => controller.abort(), DEEP_LINK_TIMEOUT_MS)
  try {
    const response = await fetchLike(path, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      ...(controller === null ? {} : { signal: controller.signal }),
    })
    let text = ''
    try {
      text = await response.text()
    } catch {
      text = ''
    }
    let json: unknown
    if (text.length > 0) {
      try {
        json = JSON.parse(text)
      } catch {
        // 可能是 SPA 的 index.html（旧 APK 的静态兜底）：当成「不是这个端点」
        json = undefined
      }
    }
    return { status: response.status, json }
  } catch {
    return null
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * 拉一次「待打开的会话」。
 *
 * ⚠️ **这条 GET 会消费掉一次投递**（原生读后清空），所以调用方必须是「真的要用它」的地方，
 * 不能拿它当只读探测反复打。
 */
export const readPendingSession = async (deps: DeepLinkFetchDeps = {}): Promise<DeepLinkProbe> => {
  const reply = await request(deps, DEEP_LINK_OPEN_PATH)
  if (reply === null) {
    // 端点可能存在，只是这次没打通（本地端口理论上不会）：**不**禁用，下次回前台还能试
    return { supported: false, reason: 'unreachable' }
  }
  if (reply.status === 404 || reply.status === 405) {
    return { supported: false, reason: 'no-endpoint' }
  }
  if (reply.status !== 200) {
    return { supported: false, reason: 'unreachable' }
  }
  const body = reply.json
  // HTML / 形状不对 / 原生自己报错：都当成「没有这个端点」（旧 APK）
  if (!isRecord(body) || body.ok === false) {
    return { supported: false, reason: 'no-endpoint' }
  }
  const pending = typeof body.pendingSessionId === 'string' ? body.pendingSessionId.trim() : ''
  const rev = typeof body.rev === 'number' && Number.isFinite(body.rev) ? body.rev : 0
  return { supported: true, pendingSessionId: pending, rev }
}

/* ────────────────────────────────────────────────────────────────────────
 * 二、控制器（依赖注入：自测不需要真连接）
 * ──────────────────────────────────────────────────────────────────────── */

/** 连接/列表的最小切面（生产 = `useRemoteStore.getState()`） */
export interface DeepLinkSnapshot {
  phase: string
  activeSessionId: string | null
  sessions: readonly { id: string }[]
}

/** 数据层动作（生产 = 远程 store 的方法；自测注入桩，断言「有没有真的去开」） */
export interface DeepLinkStoreFacade {
  snapshot: () => DeepLinkSnapshot
  openSession: (sessionId: string) => Promise<void> | void
  refreshSessions: () => Promise<void> | void
}

export interface DeepLinkDeps {
  store: DeepLinkStoreFacade
  fetch?: FetchLike
  now?: () => number
  /** 定时器（自测注入；生产 = `setTimeout`） */
  schedule?: (fn: () => void, ms: number) => unknown
  /** 提示文案（生产 = `showToast`；自测注入桩，断言提示了哪一句） */
  toast?: (message: string) => void
  /** 切到远程模式（生产 = 懒加载 `RemoteModeSwitch.enterRemoteMode`） */
  enterRemoteMode?: () => void
}

export interface DeepLinkController {
  /** 拉一次并处理（启动 / 回前台 / 原生推事件都调它；并发只跑一趟） */
  poll: () => Promise<void>
  /** 处理一个已知的会话 id（`poll` 内部用；自测直接调它） */
  handle: (sessionId: string, rev: number) => Promise<void>
  /** 装监听（幂等）：`visibilitychange` + 原生事件 + 启动一拍 */
  install: () => void
  /** 端点是否真的存在（`null` = 还没探过） */
  supported: () => boolean | null
  /** 排障用的一行摘要（不含会话内容） */
  describe: () => string
}

const defaultSchedule = (fn: () => void, ms: number): unknown => setTimeout(fn, ms)

/**
 * 懒加载「切到远程模式」。
 *
 * 为什么不静态 import `RemoteModeSwitch.tsx`：那个模块带着 `.module.css`，
 * 一旦被服务层静态依赖，Node 侧的自测（`__selftest__/*.selftest.mts`）就再也加载不了
 * 这个文件。动态 import 只在**真的收到 deep link** 时才求值，两边都不亏。
 */
const defaultEnterRemoteMode = (): void => {
  void import('../../components/remote/RemoteModeSwitch.js')
    .then((module) => {
      module.enterRemoteMode()
    })
    .catch(() => undefined)
}

/** 会话列表里有没有这一行（列表可能还是缓存，见文件头第 3 条纪律） */
const hasSession = (rows: readonly { id: string }[], sessionId: string): boolean =>
  rows.some((row) => row.id === sessionId)

/** 去重表上限：一次点通知只有一条；留 16 条足够覆盖「连着点几下」 */
const SEEN_LIMIT = 16

/**
 * 造一个控制器。**生产只有一个**（`installDeepLink()` 的单例），自测各造各的。
 */
export const createDeepLinkController = (deps: DeepLinkDeps): DeepLinkController => {
  const now = deps.now ?? Date.now
  const schedule = deps.schedule ?? defaultSchedule
  const toast = deps.toast ?? showToast
  const switchMode = deps.enterRemoteMode ?? defaultEnterRemoteMode

  /** 已经处理过的 `rev|sessionId`（同一次投递不重复开） */
  const seen: string[] = []
  let polling: Promise<void> | null = null
  let installed = false
  let supported: boolean | null = null

  const remember = (key: string): void => {
    seen.push(key)
    if (seen.length > SEEN_LIMIT) seen.shift()
  }

  /**
   * 等连接就绪。**按 `phase` 判**，不看 `sessions` 是否为空（缓存直出时列表非空但没连上）。
   *
   * `now()` 与 `schedule()` 都是注入的：自测可以手动推时钟、手动触发每一拍。
   */
  const waitReady = async (): Promise<boolean> => {
    if (deps.store.snapshot().phase === 'ready') return true
    const deadline = now() + DEEP_LINK_READY_TIMEOUT_MS
    while (now() < deadline) {
      await new Promise<void>((resolve) => {
        schedule(() => resolve(), DEEP_LINK_READY_POLL_MS)
      })
      if (deps.store.snapshot().phase === 'ready') return true
    }
    return deps.store.snapshot().phase === 'ready'
  }

  const handle = async (sessionId: string, rev: number): Promise<void> => {
    const id = sessionId.trim()
    if (id.length === 0) return
    // 先切到远程页：用户点的是远程通知，落到本机对话里会莫名其妙。
    // 切模式是同步的 UI 状态（懒加载模块内部同步写 zustand），不等它落地。
    switchMode()
    const key = `${rev}|${id}`
    if (seen.includes(key)) return
    if (deps.store.snapshot().activeSessionId === id) {
      // 用户已经在这个会话里（例如点了「待审批」那条通知）：只记一笔，别再开一次
      remember(key)
      return
    }
    if (!(await waitReady())) {
      toast(translate('deepLinkNotConnected'))
      return
    }
    let rows = deps.store.snapshot().sessions
    if (!hasSession(rows, id)) {
      try {
        await deps.store.refreshSessions()
      } catch {
        // 同步失败就按手上这份判定（下面会提示「会话已不存在」，比沉默强）
      }
      rows = deps.store.snapshot().sessions
    }
    if (!hasSession(rows, id)) {
      toast(translate('deepLinkSessionMissing'))
      return
    }
    try {
      await deps.store.openSession(id)
    } catch {
      // `openSession` 内部已经把失败写进 `state.error`：这里只保证 deep link 流程不炸
    }
    remember(key)
  }

  const poll = async (): Promise<void> => {
    if (polling !== null) return polling
    polling = (async () => {
      const probe = await readPendingSession({ fetch: deps.fetch })
      if (!probe.supported) {
        // 旧 APK / 普通浏览器：真 404 或 HTML 回落 → 整块禁用（别每次回前台都白打一次）。
        // `unreachable` 不动这个开关：那只是这一次没打通。
        if (probe.reason === 'no-endpoint') supported = false
        return
      }
      supported = true
      if (probe.pendingSessionId.length === 0) return
      await handle(probe.pendingSessionId, probe.rev)
    })()
      .catch(() => undefined)
      .finally(() => {
        polling = null
      })
    return polling
  }

  const onVisibilityChange = (): void => {
    // 只看「变可见」：切到后台的那一次没有任何要补的东西
    if (document.visibilityState !== 'visible') return
    void poll()
  }

  const onNativeDeepLink = (): void => {
    // App 已经在前台时点通知：原生推一个空事件，具体 id 还是走 open.json 取
    void poll()
  }

  const install = (): void => {
    if (installed) return
    installed = true
    // 浏览器专有 API 一律 typeof 守卫（自测 / 未来 Web Worker 里没有 document）
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onVisibilityChange)
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener(DEEP_LINK_EVENT, onNativeDeepLink)
    }
    // 启动一拍：推到当前任务之后，别在模块初始化路径上打网络（启动看门狗只有 8 s）
    schedule(() => {
      void poll()
    }, 0)
  }

  return {
    poll,
    handle,
    install,
    supported: () => supported,
    describe: (): string =>
      `installed=${installed} supported=${supported === null ? '?' : String(supported)} seen=${seen.length}`,
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * 三、生产单例（挂载点：`store.ts` 末尾 —— 它在 App 启动时必被加载）
 * ──────────────────────────────────────────────────────────────────────── */

let singleton: DeepLinkController | null = null

/**
 * 装一次（幂等）。由 `store.ts` 在模块末尾调用：那里是**最早**、也最不依赖界面的位置 ——
 * `App → RemoteChatView → store` 这条链保证它在首屏就会执行，用户哪怕当前在「本机」模式，
 * 点通知也能被接住并切过去。
 */
export const installDeepLink = (deps: DeepLinkDeps): DeepLinkController => {
  if (singleton !== null) return singleton
  singleton = createDeepLinkController(deps)
  singleton.install()
  return singleton
}

/** 当前单例（没装 = `null`） */
export const currentDeepLink = (): DeepLinkController | null => singleton
