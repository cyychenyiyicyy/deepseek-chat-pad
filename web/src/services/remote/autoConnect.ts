/**
 * 远程 DSH：**上次连接**的持久化 + 「重启后要不要自动连回去」的判定。
 *
 * ## 为什么需要它
 *
 * `storage.ts` 里一直存着设备 token pair（`dsp.remote.accounts.v1`），所以「重启后要重新登录」
 * **不是凭据没存**，而是**启动时没有任何代码去用它**：`store.ts` 只有 `resumeLogin()`
 * （续「登录过程中」的 QR 会话），于是 App 一起来 `phase === 'idle'`，远程页显示「未连接」、
 * 设置页把邮箱密码表单原样摆出来 —— 用户只能再输一次密码。
 *
 * 这个文件补的是**缺的那一半**：记住「上次连的是哪台 Host」，把「用哪条凭据、要不要先刷新」
 * 算成一个计划（`planAutoConnect`），真正的建链交给 `store.ts` 的 `establishSession()`。
 *
 * ## 数据形状（`dsp.remote.last-session.v1`）
 *
 * ```json
 * { "serverUrl":"https://dsh.r2049.cn", "email":"a@b.c",
 *   "hostDeviceId":"01J...", "hostName":"书房 Mac",
 *   "capabilities":["harness.remote.v3"], "transport":"relay", "savedAt":1786000000000 }
 * ```
 *
 * **没有 token**（token 的唯一归属仍是 `storage.ts`，见那里的文件头）。`serverUrl` + `email`
 * 只是「哪一条账号记录」的指针；`hostDeviceId` 让下次优先连回**同一台** Host，而不是
 * 「列表里第一台在线的」。
 *
 * ## 纪律
 *
 * 1. **非敏感**：只有服务器 / 邮箱 / Host 标识 / 能力快照。写盘失败（配额满 / 隐私模式）
 *    只返回 `null`，绝不抛 —— 恢复连接是锦上添花，不该让登录失败。
 * 2. **坏数据当没有**：解析失败**顺手删键**，否则每次启动都会白跑一遍恢复流程。
 * 3. **过期判定只是抄近路**：服务器仍是权威。只有「refresh token 明确过期」才直接判死；
 *    时间字段缺失一律按「没过期、去试一次」处理（试失败会落到 `SESSION_EXPIRED`）。
 */

import type { RemoteAccount } from './storage.js'

/** localStorage 键：上次成功连接的会话（跨进程恢复用） */
export const LAST_SESSION_STORAGE_KEY = 'dsp.remote.last-session.v1'

/**
 * access token 提前量：剩余寿命少于这个值就先刷新再用。
 *
 * 为什么要提前：拿一个「还剩 3 秒」的 token 去握 Noise 手，握手 + 拉列表很可能已经跨过
 * 到期点，表现成「第一次连不上、再点一次就好了」—— 这正是用户最烦的那种玄学失败。
 */
export const ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000

/** 秒与毫秒的分界：现在的毫秒时间戳是 1.7e12 量级，秒是 1.7e9 量级 */
const MILLISECOND_THRESHOLD = 1e12

/** 能力清单的落盘上限（与协议 `MAX_REMOTE_CAPABILITY_ENTRIES` 同量级，防脏数据撑爆） */
const MAX_CAPABILITY_ENTRIES = 256

/** 上次成功连接的会话（`dsp.remote.last-session.v1` 的内容） */
export interface LastSession {
  /** 归一化后的服务器地址（`normalizeServerUrl` 的产物） */
  serverUrl: string
  /** 账号主键（与 `storage.accountKey` 一起定位那一条 `RemoteAccount`） */
  email: string
  /** 上次连上的 Host；下次优先连它 */
  hostDeviceId: string
  /** Host 的显示名（只用于界面文案，服务器仍是权威） */
  hostName: string
  /** 上次协商出来的能力清单（诊断用；连线时会重新协商，不拿它做判断） */
  capabilities?: string[]
  /** 上次实际选中的传输（诊断用） */
  transport?: string
  /** 写入时刻（毫秒），排障时用来判断「这条记录有多旧」 */
  savedAt: number
}

/** 写盘入参（`savedAt` 缺省取当前时刻） */
export interface LastSessionInput {
  serverUrl: string
  email: string
  hostDeviceId: string
  hostName: string
  capabilities?: readonly string[]
  transport?: string
  savedAt?: number
}

/* ── 小工具 ───────────────────────────────────────────────────────────── */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

const isPositiveTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0

/**
 * 到期时刻归一化：服务器可能给**毫秒**（官方示例 `1786000000000`）也可能给秒。
 *
 * 小于 `MILLISECOND_THRESHOLD` 的值按秒理解（×1000）；缺失 / 非法返回 `undefined`
 * —— 调用方据此走「不知道就别猜，去试一次」。
 */
export const toEpochMs = (value: number | undefined): number | undefined => {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return undefined
  }
  return value < MILLISECOND_THRESHOLD ? Math.round(value * 1000) : value
}

/**
 * 到期了没有。
 *
 * `expiresAt` 缺失 → **不算过期**（服务器才是权威，别拿一个猜测的过期把用户挡在门外）。
 * `skewMs` 是提前量：`expiresAt - now <= skewMs` 就当过期。
 */
export const isExpiredAt = (expiresAt: number | undefined, now: number = Date.now(), skewMs = 0): boolean => {
  const at = toEpochMs(expiresAt)
  if (at === undefined) {
    return false
  }
  return at - now <= skewMs
}

/**
 * 当前环境是不是「有原生桥的 Chat Pad 壳」。
 *
 * 只在**自动恢复**这条路径上当作闸门：普通浏览器没有 `/__ds_proxy`，连也连不上，
 * 白打一轮网络请求还会把「上次连接失败」的提示摆出来 —— 那边本来就有「只能在 App 内使用」
 * 的降级文案。
 *
 * 读的是**调用时**的全局对象（不是模块加载时）：自测可以临时替换 `navigator.userAgent`。
 */
export const isNativeShell = (): boolean => {
  const scope = globalThis as { navigator?: { userAgent?: unknown }; window?: { __DS_NATIVE__?: unknown } }
  const bridge = scope.window?.__DS_NATIVE__
  if (bridge !== undefined && bridge !== null) {
    return true
  }
  const ua = scope.navigator?.userAgent
  return typeof ua === 'string' && ua.includes('DeepSeekTablet/')
}

/* ── 读写 ─────────────────────────────────────────────────────────────── */

/**
 * localStorage 取用点：隐私模式 / 配额满 / 非浏览器环境（例如 tsx 自测）返回 null，
 * 上层一律降级成「这次不恢复」，**绝不抛**。
 */
const sessionStore = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

const normalizeCapabilities = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined
  }
  const items: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) {
      continue
    }
    items.push(entry)
    if (items.length >= MAX_CAPABILITY_ENTRIES) {
      break
    }
  }
  return items.length === 0 ? undefined : items
}

/** 一条记录的结构校验（坏数据返回 null，由调用方决定删除） */
export const parseLastSession = (value: unknown): LastSession | null => {
  if (!isRecord(value)) {
    return null
  }
  const { serverUrl, email, hostDeviceId, hostName, savedAt } = value
  if (!nonEmpty(serverUrl) || !nonEmpty(email)) {
    return null
  }
  if (typeof hostDeviceId !== 'string' || typeof hostName !== 'string') {
    return null
  }
  if (!isPositiveTime(savedAt)) {
    return null
  }
  const capabilities = normalizeCapabilities(value.capabilities)
  const transport = nonEmpty(value.transport) ? value.transport : undefined
  return {
    serverUrl: serverUrl.trim(),
    email: email.trim(),
    hostDeviceId,
    hostName,
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(transport === undefined ? {} : { transport }),
    savedAt,
  }
}

/**
 * 读上次连接。
 *
 * 坏数据会被**顺手删掉**：留着只会让每次启动都白跑一遍恢复流程。
 */
export const readLastSession = (): LastSession | null => {
  const ls = sessionStore()
  if (ls === null) {
    return null
  }
  try {
    const raw = ls.getItem(LAST_SESSION_STORAGE_KEY)
    if (raw === null) {
      return null
    }
    const record = parseLastSession(JSON.parse(raw) as unknown)
    if (record === null) {
      ls.removeItem(LAST_SESSION_STORAGE_KEY)
      return null
    }
    return record
  } catch {
    // JSON 坏了 / localStorage 抛错：当没有（不删键也行，下次写入会覆盖）
    try {
      ls.removeItem(LAST_SESSION_STORAGE_KEY)
    } catch {
      // 清不掉不影响本次结论
    }
    return null
  }
}

/** 记下「这一次连上了」。返回实际落盘的对象；存不下时 `null`（本次进程内仍然可用） */
export const writeLastSession = (input: LastSessionInput): LastSession | null => {
  const record: LastSession = {
    serverUrl: input.serverUrl,
    email: input.email,
    hostDeviceId: input.hostDeviceId,
    hostName: input.hostName,
    ...(input.capabilities === undefined ? {} : { capabilities: normalizeCapabilities([...input.capabilities]) }),
    ...(input.transport === undefined || input.transport.length === 0 ? {} : { transport: input.transport }),
    savedAt: input.savedAt ?? Date.now(),
  }
  if (record.serverUrl.length === 0 || record.email.length === 0 || record.hostDeviceId.length === 0) {
    return null
  }
  const ls = sessionStore()
  if (ls === null) {
    return record
  }
  try {
    ls.setItem(LAST_SESSION_STORAGE_KEY, JSON.stringify(record))
  } catch {
    // 配额满：本次进程内仍能用，只是重启后恢复不了
  }
  return record
}

/** 清掉（退出登录 / 凭据过期 / 账号已不存在时调） */
export const clearLastSession = (): void => {
  const ls = sessionStore()
  if (ls === null) {
    return
  }
  try {
    ls.removeItem(LAST_SESSION_STORAGE_KEY)
  } catch {
    // 清不掉也不影响：下一次成功连接会覆盖它
  }
}

/** 安全摘要（**不含 token**）：日志 / 诊断用，最多只露 deviceId 前 8 位 */
export const describeLastSession = (record: LastSession | null): string => {
  if (record === null) {
    return 'last-session|none'
  }
  const host = record.hostDeviceId.length > 8 ? record.hostDeviceId.slice(0, 8) : record.hostDeviceId
  return `last-session|${record.email}@${record.serverUrl}#${host}|${record.transport ?? '-'}`
}

/* ── 决策 ─────────────────────────────────────────────────────────────── */

/**
 * 「这一条上次连接」该怎么办。纯函数（时间与账号都由调用方给），便于自测覆盖每个分支。
 *
 * | 情形 | 结果 | 调用方动作 |
 * |---|---|---|
 * | 没有记录 | `none/no-session` | 什么都不做 |
 * | 账号记录不在了 / 还没注册设备 | `none/no-account` / `none/account-incomplete` | 清掉记录（凭据已经没了，续不上） |
 * | refresh token 过期 / 没有 refresh 但 access 也过期 | `expired` | 清记录、留邮箱、提示「登录已过期，请重新登录」 |
 * | access token 快过期 / 已过期，refresh 还可用来 | `connect` + `refresh:true` | 先 `POST /auth/refresh` 再连 |
 * | access token 还有效 | `connect` + `refresh:false` | 直接连（401 还有一次刷新兜底） |
 */
export type AutoConnectPlan =
  | { kind: 'none'; reason: 'no-session' }
  | { kind: 'none'; reason: 'no-account' | 'account-incomplete'; session: LastSession }
  | { kind: 'expired'; reason: 'refresh-token-expired' | 'no-refresh-token'; session: LastSession; account: RemoteAccount }
  | { kind: 'connect'; session: LastSession; account: RemoteAccount; refresh: boolean }

/** 在账号表里找这条 last-session 对应的那条记录（同服务器 + 同邮箱） */
export const findLastSessionAccount = (
  session: LastSession,
  accounts: readonly RemoteAccount[],
): RemoteAccount | null =>
  accounts.find((item) => item.serverUrl === session.serverUrl && item.email === session.email) ?? null

export const planAutoConnect = (
  session: LastSession | null,
  accounts: readonly RemoteAccount[],
  now: number = Date.now(),
): AutoConnectPlan => {
  if (session === null) {
    return { kind: 'none', reason: 'no-session' }
  }
  const account = findLastSessionAccount(session, accounts)
  if (account === null) {
    return { kind: 'none', reason: 'no-account', session }
  }
  // 账号 token（`scope:'account'`）只用来注册设备，连不了 Host：这条记录是「登到一半」
  if ((account.scope ?? 'device') !== 'device' || account.deviceId.length === 0) {
    return { kind: 'none', reason: 'account-incomplete', session }
  }
  if (account.accessToken.length === 0) {
    return { kind: 'none', reason: 'account-incomplete', session }
  }

  // refresh token 明确过期：再试也没意义，直接判「要重新登录」
  if (isExpiredAt(account.refreshTokenExpiresAt, now)) {
    return { kind: 'expired', reason: 'refresh-token-expired', session, account }
  }

  const accessStale = isExpiredAt(account.accessTokenExpiresAt, now, ACCESS_TOKEN_REFRESH_SKEW_MS)
  if (!accessStale) {
    return { kind: 'connect', session, account, refresh: false }
  }
  // 要刷新但没有 refresh token：只能重新登录（账号 token 没有 refresh，见 serverApi.login 注释）
  if (account.refreshToken.length === 0) {
    return { kind: 'expired', reason: 'no-refresh-token', session, account }
  }
  return { kind: 'connect', session, account, refresh: true }
}
