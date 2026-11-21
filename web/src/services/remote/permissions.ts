/**
 * 远程 DSH：**原生权限中心**（`/__ds_keepalive/permissions.json` + `/open` + `/notify`）。
 *
 * ## 为什么从「远程连接」搬到「通用设置」
 *
 * 用户原话：「你这个保护不应该是放在远程连接里面，应该是放在通用设置里面，因为除了远程连接
 * 其他也需要保护」。通知权限、电池优化、自启动、精确定时、悬浮窗、移动数据都不是「远程连接」
 * 的私有开关，而是**整个 App 的后台存活能力**（前台服务、定时提醒都吃这套）。所以读写的入口
 * 统一放在「通用设置 → 后台与权限」，远程设置面板只留一句小字指路。
 *
 * ## 原生契约（已定稿：`KeepAliveHandler.java` + `input-M1-权限中心.md`）
 *
 * ```
 * GET  /__ds_keepalive/permissions.json
 *   → { ok, sdkInt,
 *       notifications:{granted, canRequest, channelBlocked},
 *       foregroundService:{running, shouldRun},
 *       battery:{exempt, ignored},
 *       exactAlarm:{granted, needed, declared},   // declared=false → 本 App 没申请该权限
 *       overlay:{granted, declared},
 *       autoStart:{vendor, manufacturer, intentAvailable},
 *       appDetails:{intentAvailable},
 *       residentNotification:{enabled, canHide} }
 * POST /__ds_keepalive/open   { target }
 *   → { ok, launched, action, degraded?, fallback? }
 *     ⚠️ **业务失败也是 HTTP 200**（要读 ok / fallback，不能只看状态码）
 * POST /__ds_keepalive/notify { enabled: boolean }   // 只能改「后台保活」通知的文案/开关
 * ```
 *
 * ## 三条纪律
 *
 * 1. **`declared:false` 的项一律不显示**（`exactAlarm` / `overlay` 目前就是）：本 App 没在
 *    清单里申请那个权限，跳过去也只是一个没有本应用开关的系统页 —— 用户点进去只会更困惑。
 * 2. **旧 APK 兼容靠「整节不显示」**：`permissions.json` 404 或回了 HTML（旧壳的静态兜底会把
 *    未知路径回落成 `index.html` 且给 **200**）→ `probePermissions()` 返回 `null`，
 *    界面**整节不渲染**，绝不显示一排「未知」。
 * 3. **永不抛**：这些调用失败只影响「权限卡片能不能显示」，不能让设置页崩掉；
 *    `/open` **只能在用户点击里调**（Android 10+ 禁止后台弹 Activity）。
 */

import type { FetchLike } from './serverApi.js'

/** 一次读全：能开哪些权限、现在各自什么状态 */
export const PERMISSIONS_PATH = '/__ds_keepalive/permissions.json'
/** 拉起某个系统授权页（**只能由用户点击触发**） */
export const PERMISSIONS_OPEN_PATH = '/__ds_keepalive/open'
/** 打开 / 关闭「后台保活」常驻通知的文案开关（通知本身关不掉，`canHide` 恒 false） */
export const KEEPALIVE_NOTIFY_PATH = '/__ds_keepalive/notify'

/**
 * 可以跳转的系统页面（原生契约的 7 个 target）。
 *
 * `dataUsage` 是「移动数据 / 流量限制」页：国产 ROM 上「省电策略 + 流量限制」经常成对出现，
 * 原生额外给了这一页；UI 按需渲染（没有对应行时不显示按钮）。
 */
export type PermissionTarget =
  | 'notifications'
  | 'battery'
  | 'appDetails'
  | 'autoStart'
  | 'exactAlarm'
  | 'overlay'
  | 'dataUsage'

/** 原生权限快照（缺字段一律按「没给」处理，见 `parsePermissions`） */
export interface KeepAlivePermissions {
  /** 原生 SDK（Android 12 = 31；精确定时从 31 起要单独授权） */
  sdkInt?: number
  notifications: {
    granted: boolean
    /** 还能弹系统授权框（false = 只能去系统设置里手动开） */
    canRequest: boolean
    /** 通知**渠道**被单独关掉（总开关还开着，但「后台保活」渠道静音） */
    channelBlocked: boolean
    /** 本安装有没有申请这个权限（`false` = 本版没申请，界面不显示这一行） */
    declared: boolean
  }
  /** 前台保活服务：`shouldRun && !running` = 该跑却没跑（系统在后台杀了它） */
  foregroundService: { running: boolean; shouldRun: boolean }
  battery: { exempt: boolean; ignored: boolean; declared: boolean }
  /** `declared:false` → 本 App 没申请这个权限，界面不显示这一行 */
  exactAlarm: { granted: boolean; needed: boolean; declared: boolean }
  /** 同上：`declared:false` 不显示 */
  overlay: { granted: boolean; declared: boolean }
  /** 厂商自启动页（MIUI / EMUI / ColorOS…）；`intentAvailable:false` 时降级到应用详情 */
  autoStart: { vendor: string; manufacturer: string; intentAvailable: boolean }
  appDetails: { intentAvailable: boolean }
  /** 常驻通知：`enabled:false` = 文案降级成「后台保持」；`canHide` 恒 false（系统硬要求） */
  residentNotification: { enabled: boolean; canHide: boolean }
}

export interface PermissionsDeps {
  /** 原生桥 `/__ds_keepalive/*` 的 fetch（自测注入；生产留空走页面全局 fetch，同源即可） */
  fetch?: FetchLike
}

/**
 * `/open` 的结果。
 *
 * ⚠️ **`ok:false` 也可能是 HTTP 200**（业务失败）：所以判定一律看 `ok`，不看状态码。
 * `degraded:true` 是原生主动降级（例如厂商自启动页不存在 → 打开了应用详情），
 * 界面要据此说一句「已打开应用详情页，请在里面手动设置」，否则用户以为点错了地方。
 *
 * `ok:true` 只代表**系统页发出去了**，不代表用户点了允许 —— 状态必须回前台重读。
 */
export interface OpenPermissionResult {
  ok: boolean
  /** 系统页真的被拉起来了（`notNeeded` 时为 false） */
  launched: boolean
  /** 原生回的错误码 / 说明（`ok:false` 时才有） */
  error?: string
  /** 实际打开的页面（原生 `action`，例如 `app_details` / `android.settings.*`） */
  action?: string
  /** 原生降级过（见文件头） */
  degraded: boolean
  /** 原生建议的降级页（`ok:false` 且还没降级时才有） */
  fallback?: PermissionTarget
  /** 回显的 target（自启动失败时配合 `vendor` 定位问题） */
  target?: PermissionTarget
  /** `autoStart` 的厂商（`xiaomi` / `huawei` / `oppo` / `vivo` / `samsung` / `other`） */
  vendor?: string
  /** `notifications` + `mode:'request'`：`request` = 弹窗真弹了；`settings` = 弹不了、退回设置页 */
  mode?: 'request' | 'settings'
  /** 上一种情况里「弹不了」（页面据此把「等弹窗回调」改成「等回前台重读」） */
  requestUnavailable?: boolean
  /** `exactAlarm` 在 Android 11 及以下：这个授权本来就不需要 */
  notNeeded?: boolean
}

const defaultFetch: FetchLike = (input, init) => fetch(input, init)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {})

const asBool = (value: unknown): boolean => value === true

const asString = (value: unknown): string => (typeof value === 'string' ? value : '')

/** 原生 bridge 错误码 → 中文（UI 只在拿不到降级页时才显示这句） */
const NATIVE_OPEN_ERROR_TEXT: Record<string, string> = {
  intent_unavailable: '这个系统没有对应的设置页',
  no_activity: 'App 不在前台，无法打开设置页',
  invalid_target: '未知的设置目标',
  not_found: 'App 版本过旧：没有这个接口',
}

/** 原生错误码 → 可直接显示的中文 */
export const describeOpenError = (code: string): string => NATIVE_OPEN_ERROR_TEXT[code] ?? code

interface NativeReply {
  status: number
  body: unknown
  text: string
}

/**
 * 打一次原生端点。**永不抛**：连不上 / 超时 / 非 JSON 都折成 `null`，
 * 由调用方当成「这个环境没有权限中心」处理。
 */
const call = async (path: string, init: RequestInit, deps: PermissionsDeps): Promise<NativeReply | null> => {
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

/** `{ok:false}` 也算失败（HTTP 可能仍是 200） */
const okOf = (reply: NativeReply | null): boolean =>
  reply !== null && reply.status < 400 && isRecord(reply.body) && reply.body.ok !== false

/** 契约允许的全部 target（解析原生回包时用它白名单校验，挡住被篡改的 `fallback`） */
const PERMISSION_TARGETS: readonly PermissionTarget[] = [
  'notifications',
  'battery',
  'appDetails',
  'autoStart',
  'exactAlarm',
  'overlay',
  'dataUsage',
]

const isPermissionTarget = (value: unknown): value is PermissionTarget =>
  typeof value === 'string' && (PERMISSION_TARGETS as readonly string[]).includes(value)

/**
 * 形状解析：`ok` 必须是布尔（这是「真的拿到了快照」的唯一凭据）。
 *
 * 缺字段的默认值分两类，**故意不一致**：
 *   - `notifications` / `battery`（核心两行）→ 默认**可见**、状态取安全侧的「未授予」（`declared` 缺省
 *     `true`）：老原生版本不送 `declared`，而这两行是 App 的底线能力，不该因为字段缺失就消失；
 *   - `exactAlarm` / `overlay`（当前本版没申请）→ `declared` 缺省 **`false`**：没声明就不显示，
 *     免得用户点进一个没有本应用开关的系统页；
 *   - `autoStart.intentAvailable` → `false`（没声明就按「只能开应用详情」处理）；
 *   - `residentNotification.canHide` → `false`（前台服务通知本来关不掉）。
 *
 * 顶层还有 `running / shouldRun / notificationsGranted / batteryExempt` 四个**镜像字段**
 * （与 `/state` 同名同义）：嵌套组缺失时用它们兜底，通用设置只调这一个接口也能把三态渲染出来。
 */
export const parsePermissions = (value: unknown): KeepAlivePermissions | null => {
  if (!isRecord(value) || typeof value.ok !== 'boolean' || value.ok === false) {
    return null
  }
  const notifications = asRecord(value.notifications)
  const foregroundService = asRecord(value.foregroundService)
  const battery = asRecord(value.battery)
  const exactAlarm = asRecord(value.exactAlarm)
  const overlay = asRecord(value.overlay)
  const autoStart = asRecord(value.autoStart)
  const appDetails = asRecord(value.appDetails)
  const residentNotification = asRecord(value.residentNotification)
  const has = (group: Record<string, unknown>, key: string): boolean => Object.hasOwn(group, key)
  return {
    ...(typeof value.sdkInt === 'number' && Number.isFinite(value.sdkInt) ? { sdkInt: value.sdkInt } : {}),
    notifications: {
      granted: has(notifications, 'granted') ? asBool(notifications.granted) : asBool(value.notificationsGranted),
      canRequest: asBool(notifications.canRequest),
      channelBlocked: asBool(notifications.channelBlocked),
      // 缺省 true：老原生不送 declared，核心行不能因此消失
      declared: has(notifications, 'declared') ? asBool(notifications.declared) : true,
    },
    foregroundService: {
      running: has(foregroundService, 'running') ? asBool(foregroundService.running) : asBool(value.running),
      shouldRun: has(foregroundService, 'shouldRun') ? asBool(foregroundService.shouldRun) : asBool(value.shouldRun),
    },
    battery: {
      exempt: has(battery, 'exempt') ? asBool(battery.exempt) : asBool(value.batteryExempt),
      ignored: asBool(battery.ignored),
      declared: has(battery, 'declared') ? asBool(battery.declared) : true,
    },
    exactAlarm: {
      granted: asBool(exactAlarm.granted),
      needed: asBool(exactAlarm.needed),
      declared: asBool(exactAlarm.declared),
    },
    overlay: { granted: asBool(overlay.granted), declared: asBool(overlay.declared) },
    autoStart: {
      vendor: asString(autoStart.vendor),
      manufacturer: asString(autoStart.manufacturer),
      intentAvailable: asBool(autoStart.intentAvailable),
    },
    appDetails: { intentAvailable: asBool(appDetails.intentAvailable) },
    residentNotification: {
      enabled: asBool(residentNotification.enabled),
      canHide: asBool(residentNotification.canHide),
    },
  }
}

/**
 * 读一次权限快照。
 *
 * 返回 `null` = **这个环境没有权限中心**（普通浏览器 / 旧 APK / 连不上）：
 * 调用方**不要**把它当异常，直接整节不显示。
 */
export const probePermissions = async (deps: PermissionsDeps = {}): Promise<KeepAlivePermissions | null> => {
  const reply = await call(PERMISSIONS_PATH, { method: 'GET' }, deps)
  if (reply === null || reply.status !== 200) {
    return null
  }
  // 2xx + 非 JSON（静态兜底的 index.html）：按「没有这个端点」处理，绝不把 HTML 当快照
  return parsePermissions(reply.body)
}

/**
 * 拉起某个系统授权页。
 *
 * 判定只看 `ok`：**业务失败也是 HTTP 200**（原生契约）。`fallback` 原样带回给调用方，
 * 由 UI 决定要不要再试一次 —— **不要**在这里自动跳第二页：连着弹两个系统页面在真机上
 * 很容易被判成「界面在乱跳」，而且用户看不清第一个页面是哪个。
 *
 * `options.mode === 'request'` 只对 `notifications` 有意义：不跳设置页，直接借前台 Activity
 * 弹系统运行时权限框（`canRequest:true` 时优先用它，少一步跳转）。响应会带
 * `mode:'request'|'settings'` 与 `requestUnavailable`，界面据此决定提示语。
 */
export const openPermissionTarget = async (
  target: PermissionTarget,
  deps: PermissionsDeps = {},
  options: { mode?: 'request' } = {},
): Promise<OpenPermissionResult> => {
  const reply = await call(
    PERMISSIONS_OPEN_PATH,
    {
      method: 'POST',
      // 原生态用 Content-Type 做 CSRF 闸门（与 /__ds_auth/* 同一套写法）
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options.mode === undefined ? { target } : { target, mode: options.mode }),
    },
    deps,
  )
  if (reply === null) {
    return { ok: false, launched: false, degraded: false, error: 'bridge_unavailable' }
  }
  if (!isRecord(reply.body)) {
    return { ok: false, launched: false, degraded: false, error: `http_${reply.status}` }
  }
  const body = reply.body
  const action = asString(body.action)
  const fallback = body.fallback
  const echoedTarget = body.target
  const vendor = asString(body.vendor)
  const rawMode = body.mode
  const mode: 'request' | 'settings' | undefined =
    rawMode === 'request' ? 'request' : rawMode === 'settings' ? 'settings' : undefined
  const common = {
    degraded: body.degraded === true,
    ...(action.length === 0 ? {} : { action }),
    ...(isPermissionTarget(fallback) ? { fallback } : {}),
    ...(isPermissionTarget(echoedTarget) ? { target: echoedTarget } : {}),
    ...(vendor.length === 0 ? {} : { vendor }),
    ...(mode === undefined ? {} : { mode }),
    ...(body.requestUnavailable === true ? { requestUnavailable: true } : {}),
    ...(body.notNeeded === true ? { notNeeded: true } : {}),
  }
  if (body.ok === true && reply.status < 400) {
    return { ok: true, launched: body.launched !== false, ...common }
  }
  return {
    ok: false,
    launched: body.launched === true,
    error: asString(body.error) || (reply.status >= 400 ? `http_${reply.status}` : 'intent_unavailable'),
    ...common,
  }
}

/**
 * 「去开启通知」：能在前台弹系统授权框就走 `mode:'request'`（少跳一次系统设置），
 * 否则退回普通设置页跳转（由调用方判断 `canRequest`）。
 */
export const requestNotificationPermission = async (deps: PermissionsDeps = {}): Promise<OpenPermissionResult> =>
  openPermissionTarget('notifications', deps, { mode: 'request' })

/**
 * 打开 / 关闭「后台保活」常驻通知的文案开关（`POST /__ds_keepalive/notify {enabled}`）。
 *
 * ⚠️ `canHide` 恒为 `false`：前台服务的通知是 Android 的硬要求，**关不掉**，这个开关只改文案
 * （「正在保持连接」↔「服务运行中」之类）。所以界面上不做「关掉通知」这种表述 ——
 * 见报告「未做项」：等原生把 `enabled` 的语义写进 M1 报告后再决定要不要暴露成可见开关。
 */
export const setNotificationsEnabled = async (enabled: boolean, deps: PermissionsDeps = {}): Promise<boolean> =>
  okOf(
    await call(
      KEEPALIVE_NOTIFY_PATH,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      },
      deps,
    ),
  )

/** 安全摘要（**不含任何凭据**）：排障用 */
export const describePermissions = (snapshot: KeepAlivePermissions | null): string => {
  if (snapshot === null) {
    return 'permissions|unsupported'
  }
  const flags = [
    snapshot.sdkInt === undefined ? 'sdk?' : `sdk${snapshot.sdkInt}`,
    snapshot.notifications.granted ? 'notify' : 'no-notify',
    snapshot.notifications.channelBlocked ? 'channel-blocked' : 'channel-ok',
    snapshot.battery.exempt || snapshot.battery.ignored ? 'battery-exempt' : 'battery-optimized',
    snapshot.exactAlarm.declared ? (snapshot.exactAlarm.granted ? 'alarm' : 'no-alarm') : 'alarm-undeclared',
    snapshot.overlay.declared ? (snapshot.overlay.granted ? 'overlay' : 'no-overlay') : 'overlay-undeclared',
    snapshot.autoStart.intentAvailable ? 'autostart' : 'no-autostart',
    snapshot.foregroundService.running ? 'service-running' : 'service-idle',
  ]
  return `permissions|${flags.join('|')}`
}
