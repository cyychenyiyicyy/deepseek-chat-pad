/**
 * 远程 DSH：**原生保活服务**（`/__ds_keepalive/*`，原生侧 K1 已落地）。
 *
 * ## 为什么需要它
 *
 * 远程连接的心跳是页面里的定时器（`core/` 的 Noise/WS 层）。用户切到**系统浏览器**去
 * 完成授权时，WebView 进后台、定时器被系统冻结，**服务端 75 秒就把这条连接踢了**；
 * 回来看到的是「已断开」。原生的前台服务（`RemoteKeepAliveService`）接管这段时间的心跳，
 * 页面侧只要在「连上了」时把它拉起来、在「真断开」时停掉即可。
 *
 * ## 接口（原生契约）
 *
 * | 端点 | 方法 | 语义 |
 * |---|---|---|
 * | `/__ds_keepalive/start`          | POST | 幂等；远程 `phase==='ready'` 时调一次，之后每次重连成功也调 |
 * | `/__ds_keepalive/stop`           | POST | 用户主动断开 / 退出登录 / 终态 closed |
 * | `/__ds_keepalive/state.json`     | GET  | `{ok,running,shouldRun,notificationsGranted,batteryExempt,sdkInt}` |
 * | `/__ds_keepalive/battery`        | POST | 拉起「忽略电池优化」授权页（**只能在用户点击里调**） |
 *
 * ⚠️ **探测必须用带 `.json` 的路径**：旧 APK 的静态兜底会把无扩展名的未知路径回落成
 * `index.html` 且回 **200** —— 拿 `/__ds_keepalive/state` 探测会把「不支持」误判成「支持」。
 * 即便用了 `.json`，这里也还再验一次响应体形状（`ok` 是布尔且不是 HTML）。
 *
 * ## 三条纪律
 *
 * 1. **失败静默**：这些调用失败绝不能影响远程连接 —— 保活是锦上添花，连接是主线。
 * 2. **只在用户点击里要电池豁免**：Android 10+ 禁止后台弹 Activity，后台调只会白跑。
 * 3. **绝不在 `pagehide` / `beforeunload` / `onPause` 里 stop**：切后台正是需要它的时候。
 */

import type { FetchLike } from './serverApi.js'

/** 拉起保活服务（POST，幂等） */
export const KEEPALIVE_START_PATH = '/__ds_keepalive/start'
/** 停掉保活服务（POST，幂等） */
export const KEEPALIVE_STOP_PATH = '/__ds_keepalive/stop'
/** 探测 + 读取状态（GET；**必须带 `.json`**，见文件头） */
export const KEEPALIVE_STATE_PATH = '/__ds_keepalive/state.json'
/** 「忽略电池优化」授权页（POST；只能由用户点击触发） */
export const KEEPALIVE_BATTERY_PATH = '/__ds_keepalive/battery'

/** 原生保活服务的快照（`supported:false` = 当前环境没有这套端点） */
export interface KeepAliveSnapshot {
  /** 原生态支持（`state.json` 探测通过） */
  supported: boolean
  /** 服务此刻在跑 */
  running: boolean
  /** 服务「应该」在跑（原生根据远程连接状态算的） */
  shouldRun: boolean
  /** 通知权限已给？（没有的话前台服务容易被国产 ROM 杀） */
  notificationsGranted: boolean
  /** 已豁免电池优化？ */
  batteryExempt: boolean
  /** 原生 SDK（排障用：通知/前台服务的分支大多是 26 / 33） */
  sdkInt?: number
}

export interface KeepAliveDeps {
  /** 只用到 fetch 的最小切面（自测注入；生产留空走页面全局 fetch，同源即可） */
  fetch?: FetchLike
}

const defaultFetch: FetchLike = (input, init) => fetch(input, init)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** `supported:false` 的快照：非壳环境 / 旧 APK 统一用它（UI 据此不显示保活提示） */
export const unsupportedKeepAlive = (): KeepAliveSnapshot => ({
  supported: false,
  running: false,
  shouldRun: false,
  notificationsGranted: false,
  batteryExempt: false,
})

interface NativeReply {
  status: number
  body: unknown
  text: string
}

/**
 * 打一次原生端点。**永不抛**：连不上 / 超时 / 非 JSON 都折成 `null`，
 * 由调用方当成「这个环境没有保活服务」处理。
 */
const call = async (path: string, init: RequestInit, deps: KeepAliveDeps): Promise<NativeReply | null> => {
  try {
    const response = await (deps.fetch ?? defaultFetch)(path, {
      ...init,
      cache: 'no-store',
      // 同源本地端口，不带 cookie：别让 WebView 的 cookie 策略把这次请求拖住
      credentials: 'omit',
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
  }
}

/** 原生 `{ok:false,error}` 也算失败（HTTP 可能仍是 200） */
const okOf = (reply: NativeReply | null): boolean =>
  reply !== null && reply.status < 400 && isRecord(reply.body) && reply.body.ok !== false

/**
 * 探测保活能力 + 读状态。
 *
 * 返回 `null` 表示「这个环境没有保活服务」（非壳 / 旧 APK / 连不上）：
 * 调用方**不要**把它当异常，只当成「没有这个能力」。
 */
export const probeKeepAlive = async (deps: KeepAliveDeps = {}): Promise<KeepAliveSnapshot | null> => {
  const reply = await call(KEEPALIVE_STATE_PATH, { method: 'GET' }, deps)
  if (reply === null || reply.status !== 200) return null
  const body = reply.body
  // 形状不对（HTML / 其它端点）：不支持
  if (!isRecord(body) || typeof body.ok !== 'boolean') return null
  return {
    supported: true,
    running: body.running === true,
    shouldRun: body.shouldRun === true,
    notificationsGranted: body.notificationsGranted !== false,
    batteryExempt: body.batteryExempt === true,
    ...(typeof body.sdkInt === 'number' ? { sdkInt: body.sdkInt } : {}),
  }
}

/**
 * 拉起保活服务（幂等）。返回是否「确实在跑」——失败只返回 false，不抛。
 */
export const startKeepAlive = async (deps: KeepAliveDeps = {}): Promise<boolean> =>
  okOf(
    await call(KEEPALIVE_START_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }, deps),
  )

/** 停掉保活服务（幂等）。返回是否成功；失败只返回 false，不抛。 */
export const stopKeepAlive = async (deps: KeepAliveDeps = {}): Promise<boolean> =>
  okOf(
    await call(KEEPALIVE_STOP_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }, deps),
  )

/**
 * 拉起「忽略电池优化」授权页。
 *
 * ⚠️ 只能**在用户点击里**调用：Android 10+ 禁止后台弹 Activity，后台调只会静默失败。
 */
export const requestBatteryExemption = async (deps: KeepAliveDeps = {}): Promise<boolean> =>
  okOf(
    await call(KEEPALIVE_BATTERY_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }, deps),
  )

/**
 * 「回到前台 / 刚连上」时的一次性自检：
 * 探测 →（支持且 `shouldRun && !running`）补一次 start → 返回最新快照。
 *
 * 为什么不是简单的「每次 visible 都 start」：`start` 是幂等的，但每次都要起一次原生调用，
 * 而 `state.json` 一次就能告诉我们「要不要补」。两条都保留的意义在于
 * 系统可能在后台把服务杀掉（`running:false` 但 `shouldRun:true`）—— 这正是要补的场景。
 */
export const syncKeepAlive = async (deps: KeepAliveDeps = {}): Promise<KeepAliveSnapshot | null> => {
  const snapshot = await probeKeepAlive(deps)
  if (snapshot === null) return null
  if (!snapshot.shouldRun || snapshot.running) return snapshot
  const started = await startKeepAlive(deps)
  return started ? { ...snapshot, running: true } : snapshot
}

/** 安全摘要（**不含任何凭据**）：日志 / 排障用 */
export const describeKeepAlive = (snapshot: KeepAliveSnapshot | null): string => {
  if (snapshot === null) return 'keepalive|unsupported'
  const flags = [
    snapshot.supported ? 'supported' : 'unsupported',
    snapshot.running ? 'running' : 'stopped',
    snapshot.shouldRun ? 'should-run' : 'idle',
    snapshot.notificationsGranted ? 'notify' : 'no-notify',
    snapshot.batteryExempt ? 'battery-exempt' : 'battery-optimized',
  ]
  return `keepalive|${flags.join('|')}`
}
