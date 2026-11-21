/**
 * 远程 DSH：**掉线自愈**的纯策略层（分诊 / 退避 / 重连状态机）。
 *
 * ## 这个文件为什么存在（真机 bug 的根因）
 *
 * 用户原话：「如果放后台很久重新打开就会显示什么凭据失效啥的，但是重启一下就好了」
 * 「又说什么连接失败，连接失败你就刷新一下就好了呀……自动重新连一下就好了呀」。
 *
 * 两句抱怨是**同一个根因**的两面：
 *
 * 1. App 在后台时进程被冻结 → 页面心跳（25 s）停摆 → 服务端 75 s 后踢掉连接，
 *    或 token 在后台期间过期（服务端按 §22 用 `4002` / `heartbeat timeout` 关闭）。
 * 2. 回前台时**没有任何代码去重连**（`store.foregroundFlow()` 只续登录 / 补轮询 / 自检保活），
 *    于是界面停在 `phase: 'error'` +「连接失败」，或者更糟：把「连接断了」误判成
 *    「凭据失效」，还会顺手删掉 `last-session`（重启后自然就连不回来）。
 * 3. 重启之所以「莫名其妙地好了」：重启把整条链路重建了一遍 —— 凭据本来是好的。
 *
 * ## 职责边界（**纯函数，不碰网络、不碰 store**）
 *
 * | 概念 | 函数 |
 * |---|---|
 * | 一条错误/关闭原因该怎么定性 | `classifyFailure()` / `classifyCloseCode()` |
 * | 把 `onState('closed', detail)` 的字符串拆成 code + closeCode | `parseLinkCloseDetail()` |
 * | 第 n 次重连等多久 | `backoffDelayMs()` |
 * | 下一步是「重试 / 先 refresh 再重试 / 停止」 | `planRecoveryStep()` |
 *
 * `store.ts` 只负责「按 step 去 sleep + 建链 + 回填结果」，判定全部在这里，
 * 所以 `__selftest__/reconnect.selftest.mts` 能把分诊表与退避序列逐条钉住。
 *
 * ## 分诊表（**这就是「凭据失效」和「连接断了」的分界线**）
 *
 * | 输入 | kind | 动作 | 用户看到 |
 * |---|---|---|---|
 * | 本机没网（`navigator.onLine === false`）/ `NETWORK_ERROR` | `offline` | 退避重连 | 「网络已断开」中性 |
 * | 超时 / `CONNECTION_FAILED` / `CONNECTION_REPLACED` / `TRANSPORT_CLOSED` / WS 1006 / 4001 / 4009 / 5xx | `unreachable` | 退避重连 | 「正在重连…（第 N 次）」中性 |
 * | `TOKEN_EXPIRED` / 401 / 4002 / `AUTH_REQUIRED` | `token-expired` | **先 refresh 再重连**（每次恢复只刷一次） | 「正在重连…」中性 |
 * | refresh 也 401/过期 / `AUTH_INVALID` / `SESSION_EXPIRED` / 没有 refreshToken | `need-login` | 停止 | 「登录已过期，请重新登录」 |
 * | `DEVICE_REVOKED` / `DEVICE_OWNERSHIP_REQUIRED` / 4004 / `MEMBERSHIP_REQUIRED` / `PEER_IDENTITY_MISMATCH` / `HOST_IDENTITY_MISSING` / `IDENTITY_MISMATCH` / `NO_HOST` | `blocked` | 停止 | 具体码 + 中文说明（真需要人处理） |
 * | 协议/版本不兼容（`UNSUPPORTED_VERSION` / `METHOD_NOT_FOUND` / `HARNESS_VERSION_INCOMPATIBLE` / `INVALID_MESSAGE` / `CAPABILITY_NOT_SUPPORTED`） | `blocked` | 停止 | 同上 |
 *
 * **纪律**：`offline` / `unreachable` / `token-expired` 这三类**永远**不产生「凭据失效」字样，
 * 也永远不会触发清凭据（清凭据只允许发生在用户点「退出登录」时）。
 */

/* ── 常量 ─────────────────────────────────────────────────────────────── */

/** 一次恢复最多尝试几次（含首次）。用完就停，等用户点「立即重连」或回到前台。 */
export const MAX_RECONNECT_ATTEMPTS = 5

/** 退避基数：第 1 次 1 s，第 2 次 2 s，第 3 次 4 s ……（指数退避） */
export const RECONNECT_BASE_DELAY_MS = 1_000

/** 退避上限（协议 §22 建议 30 s 量级：宁可拉长，也不在服务端刚恢复时制造请求洪峰） */
export const RECONNECT_MAX_DELAY_MS = 30_000

/* ── 分类 ─────────────────────────────────────────────────────────────── */

/**
 * 失败的种类（决定 UI 语气与是否自愈）：
 *
 * - `offline`       本机没网 → 中性，退避重连；
 * - `unreachable`   服务端/主机不可达 → 中性，退避重连；
 * - `token-expired` 只是 token 过期 → 先 refresh 再重连（**不是**凭据失效）；
 * - `need-login`    真需要重新登录（refresh 都不行了）；
 * - `blocked`       设备被撤销 / 身份不符 / 会员到期 / 协议不兼容：**人得处理**。
 */
export type FailureKind = 'offline' | 'unreachable' | 'token-expired' | 'need-login' | 'blocked'

/** 待分诊的一条失败（`store.ts` 把 `RemoteApiError` / 关闭原因折成这个形状） */
export interface FailureInput {
  /** 机器码（协议 §23 或本机补充码） */
  code?: string | null
  /** HTTP 状态（拿得到才有） */
  status?: number | null
  /** WebSocket close code（4001 / 4002 / 4003 / 4004 / 4009 / 1006 …） */
  closeCode?: number | null
  /** 可读原因（只用于展示，**不参与**分类 —— 文案会变，码不会） */
  message?: string | null
  /** `navigator.onLine`；`false` 直接判离线（比任何错误码都可靠） */
  online?: boolean | null
}

/** 分诊结论 */
export interface FailureVerdict {
  kind: FailureKind
  /** 用来展示/记账的码（关闭码会被翻译成协议码） */
  code: string
  /** 要不要自动重连 */
  auto: boolean
  /** 重连前是否应该先 `POST /auth/refresh` */
  needsRefresh: boolean
  /** 是否真的需要用户重新登录 */
  needLogin: boolean
  /** UI 语气：`neutral` = 中性提示（正在重连），`error` = 需要人处理 */
  tone: 'neutral' | 'error'
  /** 用户主动取消 / 并发冲突：既不自愈也**不报错**，界面原样复位 */
  silent: boolean
}

/** 网络/传输类：可重试，**绝不**提示凭据问题 */
const NETWORK_CODES: ReadonlySet<string> = new Set([
  'NETWORK_ERROR',
  'NETWORK_UNREACHABLE',
  'TIMEOUT',
  'RPC_TIMEOUT',
  'CONNECT_TIMEOUT',
  'CONNECTION_FAILED',
  // 4003：被另一台设备抢占。协议要求 Host 侧「停止抢占」，客户端侧仍可自动重连
  //（用户很可能只是换了台设备又切回来），重连不会造成抢占风暴（有退避）。
  'CONNECTION_REPLACED',
  'CONNECTION_NOT_FOUND',
  'TRANSPORT_CLOSED',
  'SECURE_CHANNEL_FAILED',
  'HOST_OFFLINE',
  'RELAY_UNAVAILABLE',
  'TURN_UNAVAILABLE',
  'P2P_FAILED',
  'UPSTREAM_FAILED',
  'UPSTREAM_TIMEOUT',
  'EVENT_STREAM_CLOSED',
  'EVENT_STREAM_NOT_READY',
  'STREAM_CLOSED',
  'OFFLINE',
  'FETCH_FAILED',
])

/**
 * 「只是 token 过期」：先 refresh 再重连。
 *
 * 注意 `AUTH_INVALID` 也在这里 —— 在**设备凭据**语境下它通常表示 bearer 过期/被轮换，
 * 而协议 §8.2 的刷新流程正是处理这个。刷新成功后这里就再也不会被用到；
 * 刷新之后再撞到它会被 `planRecoveryStep()` 升级成 `need-login`（refresh 只试一次）。
 */
const REFRESHABLE_AUTH_CODES: ReadonlySet<string> = new Set([
  'TOKEN_EXPIRED',
  'AUTH_REQUIRED',
  'AUTH_INVALID',
  'UNAUTHORIZED',
  'TOKEN_INVALID',
  'ACCESS_TOKEN_EXPIRED',
  'SESSION_EXPIRED',
])

/** 真需要重新登录（refresh 也没救） */
const NEED_LOGIN_CODES: ReadonlySet<string> = new Set([
  'ACCOUNT_AUTH_REQUIRED',
  'REFRESH_FAILED',
  'REFRESH_TOKEN_INVALID',
  'REFRESH_TOKEN_EXPIRED',
  'NO_CREDENTIAL',
  'LOGIN_REQUIRED',
])

/** 需要人处理（撤销 / 归属 / 会员 / 身份 / 没有可连主机） */
const BLOCKED_CODES: ReadonlySet<string> = new Set([
  'DEVICE_REVOKED',
  'DEVICE_OWNERSHIP_REQUIRED',
  'DEVICE_NOT_FOUND',
  'MEMBERSHIP_REQUIRED',
  'PEER_IDENTITY_MISMATCH',
  'HOST_IDENTITY_MISSING',
  'IDENTITY_MISMATCH',
  'NO_HOST',
])

/** 协议/版本不兼容：重试没有意义（得升级 App 或 Host） */
const INCOMPATIBLE_CODES: ReadonlySet<string> = new Set([
  'UNSUPPORTED_VERSION',
  'METHOD_NOT_FOUND',
  'HARNESS_VERSION_INCOMPATIBLE',
  'INVALID_MESSAGE',
  'CAPABILITY_NOT_SUPPORTED',
  'FRAME_TOO_LARGE',
  'RESPONSE_TOO_LARGE',
  'INVALID_RESPONSE',
])

/** 用户主动取消 / 并发冲突 / 没东西可恢复：不是失败，**不要**重连、也**不要**弹提示 */
const ABORTED_CODES: ReadonlySet<string> = new Set([
  'RPC_ABORTED',
  'ABORTED',
  'CANCELLED',
  'CONNECT_BUSY',
  'NO_SESSION',
])

const verdictOf = (
  kind: FailureKind,
  code: string,
  patch: Partial<Pick<FailureVerdict, 'auto' | 'needsRefresh' | 'needLogin' | 'tone' | 'silent'>> = {},
): FailureVerdict => ({
  kind,
  code,
  auto: patch.auto ?? false,
  needsRefresh: patch.needsRefresh ?? false,
  needLogin: patch.needLogin ?? false,
  tone: patch.tone ?? 'error',
  silent: patch.silent ?? false,
})

/** 4002：协议 §22 明说「凭据失效 → 走刷新流程」，所以它是**可自愈**的 */
export const CLOSE_CREDENTIAL_EXPIRED = 4002
/** 4003：连接被替换（协议要求 Host 停止抢占；客户端可以重连） */
export const CLOSE_CONNECTION_REPLACED = 4003
/** 4004：设备被撤销（**永不**保留、不得重连） */
export const CLOSE_DEVICE_REVOKED = 4004

/**
 * WebSocket close code → 分诊结论。
 *
 * 语义以 close reason 为准（protocol.md §22），但原生桥只透传 code+reason 字符串，
 * 没给结构化 reason，所以 code 是客户端能稳定拿到的唯一信号。未识别的 code 一律按
 * 「可重试的网络故障」处理：重试有上限（5 次）+ 退避，不会形成风暴，而对用户来说
 * 「多试几次」远好过「莫名其妙说凭据失效」。
 */
export const classifyCloseCode = (closeCode?: number | null): FailureVerdict | null => {
  if (closeCode === undefined || closeCode === null || !Number.isFinite(closeCode)) return null
  const code = Math.trunc(closeCode)
  if (code === CLOSE_DEVICE_REVOKED) return verdictOf('blocked', 'DEVICE_REVOKED')
  if (code === CLOSE_CREDENTIAL_EXPIRED) {
    return verdictOf('token-expired', 'TOKEN_EXPIRED', { auto: true, needsRefresh: true, tone: 'neutral' })
  }
  if (code === CLOSE_CONNECTION_REPLACED) {
    return verdictOf('unreachable', 'CONNECTION_REPLACED', { auto: true, tone: 'neutral' })
  }
  // 1000/1005/1006/1011/1012/1013、4001（心跳超时/优雅关闭）、4009（心跳超时）及其它：
  // 全部当作「对端不再应答」，与网络分区不可区分 → 可重试。
  return verdictOf('unreachable', `WS_${code}`, { auto: true, tone: 'neutral' })
}

/**
 * 一条失败 → 分诊结论。
 *
 * 优先级（**顺序就是语义**）：
 *   1. `online === false` → 离线（比任何错误码都可靠）；
 *   2. 明确的 close code（4004 / 4002 / 4003 …）；
 *   3. 明确的错误码（协议 §23）；
 *   4. 只有 HTTP 状态时按状态判（401 → 刷新、403 → 权限、5xx → 网络）；
 *   5. 什么都没有 → 当网络故障（可重连），**绝不**默认判成凭据问题。
 */
export const classifyFailure = (input: FailureInput): FailureVerdict => {
  if (input.online === false) {
    return verdictOf('offline', input.code ?? 'OFFLINE', { auto: true, tone: 'neutral' })
  }

  const closeVerdict = classifyCloseCode(input.closeCode)
  if (closeVerdict !== null) {
    // 关闭码只对「网络/凭据」有强语义；4004 之外的可疑情况交给错误码再细判
    if (closeVerdict.kind !== 'unreachable' || input.code === undefined || input.code === null) {
      return closeVerdict
    }
  }

  const code = (input.code ?? '').trim().toUpperCase()
  if (code.length > 0) {
    if (ABORTED_CODES.has(code)) return verdictOf('blocked', code, { auto: false, tone: 'neutral', silent: true })
    if (BLOCKED_CODES.has(code)) return verdictOf('blocked', code)
    if (INCOMPATIBLE_CODES.has(code)) return verdictOf('blocked', code)
    if (NEED_LOGIN_CODES.has(code)) return verdictOf('need-login', code, { needLogin: true })
    if (REFRESHABLE_AUTH_CODES.has(code)) {
      return verdictOf('token-expired', code, { auto: true, needsRefresh: true, tone: 'neutral' })
    }
    if (NETWORK_CODES.has(code)) return verdictOf('unreachable', code, { auto: true, tone: 'neutral' })
    // 未知码：不猜「凭据没了」，一律当网络故障（有上限 + 退避兜底）
  }

  const status = input.status
  if (typeof status === 'number' && Number.isFinite(status)) {
    if (status === 401) {
      return verdictOf('token-expired', code.length > 0 ? code : 'HTTP_401', {
        auto: true,
        needsRefresh: true,
        tone: 'neutral',
      })
    }
    if (status === 403) {
      // 403 既可能是「凭据没权限」也可能是「网关挡了」：不判凭据失效，先去刷新一次试试，
      // 刷新也过不去时 `planRecoveryStep()` 会升级成 need-login。
      return verdictOf('token-expired', code.length > 0 ? code : 'HTTP_403', {
        auto: true,
        needsRefresh: true,
        tone: 'neutral',
      })
    }
    if (status >= 500) {
      return verdictOf('unreachable', code.length > 0 ? code : `HTTP_${status}`, { auto: true, tone: 'neutral' })
    }
    if (status === 408 || status === 429) {
      return verdictOf('unreachable', code.length > 0 ? code : `HTTP_${status}`, { auto: true, tone: 'neutral' })
    }
    if (status === 400) return verdictOf('blocked', code.length > 0 ? code : 'HTTP_400')
  }

  return verdictOf('unreachable', code.length > 0 ? code : 'UNKNOWN_ERROR', { auto: true, tone: 'neutral' })
}

/* ── 关闭原因的字符串解析 ─────────────────────────────────────────────── */

export interface LinkCloseDetail {
  /** `SecureLink` 给的失败码（`TRANSPORT_CLOSED` / `CONNECTION_FAILED` / `AUTH_INVALID` …） */
  code?: string
  /** 可读原因（**可能**含原生桥的原文；只用于展示） */
  message?: string
  /** 从原文里抠出来的 WebSocket close code（`（code=4002）`） */
  closeCode?: number
}

/**
 * 拆 `core/index.ts` 的 `onState('closed', detail)` 那个字符串。
 *
 * 两种真实形状：
 *   - `TRANSPORT_CLOSED: 原生桥关闭：heartbeat timeout（code=4009）`
 *   - `CONNECTION_FAILED: 等待 hello.ack 超时。`
 *
 * `core/` 不在本次可改范围，所以对方**不给**结构化关闭码；这里按格式解析，
 * 解析失败一律返回空对象（调用方按「未知 → 可重试」处理，绝不因此判凭据失效）。
 */
export const parseLinkCloseDetail = (detail?: string | null): LinkCloseDetail => {
  const raw = typeof detail === 'string' ? detail.trim() : ''
  if (raw.length === 0) return {}
  const result: LinkCloseDetail = {}
  const matched = /^([A-Za-z][A-Za-z0-9_]{1,63})\s*[:：]\s*([\s\S]*)$/u.exec(raw)
  if (matched !== null && matched[1] !== undefined) {
    result.code = matched[1]
    result.message = (matched[2] ?? '').trim()
  } else {
    result.message = raw
  }
  const closeCode = /\bcode\s*=\s*(\d{3,5})\b/iu.exec(raw)
  if (closeCode !== null && closeCode[1] !== undefined) {
    const parsed = Number(closeCode[1])
    if (Number.isFinite(parsed) && parsed > 0) result.closeCode = parsed
  }
  return result
}

/* ── 退避 ─────────────────────────────────────────────────────────────── */

/**
 * 第 `attempt` 次重连要等多久（1-based）。
 *
 * 1 s → 2 s → 4 s → 8 s → 16 s（上限 30 s）。**确定性的**（不加抖动）：
 * 单机客户端同一次掉线只有一个重连器，不存在风暴；确定性让自测能钉住序列。
 * 前台/用户主动触发的那一次不等（`planRecoveryStep({ immediate: true })`）。
 */
export const backoffDelayMs = (attempt: number): number => {
  const index = Number.isFinite(attempt) ? Math.max(1, Math.trunc(attempt)) : 1
  const delay = RECONNECT_BASE_DELAY_MS * 2 ** (index - 1)
  return Math.min(delay, RECONNECT_MAX_DELAY_MS)
}

/* ── 恢复状态机 ───────────────────────────────────────────────────────── */

/** 一次恢复流程的进度（`store.ts` 模块级持有；纯数据，便于自测驱动） */
export interface RecoveryState {
  /** 已经尝试过的次数 */
  attempt: number
  /** 本次恢复里 refresh 是否已经用过（协议要求「最多刷一次」，避免把 refresh 打穿） */
  refreshUsed: boolean
}

export const INITIAL_RECOVERY_STATE: RecoveryState = { attempt: 0, refreshUsed: false }

export type RecoveryStep =
  | {
      action: 'retry'
      /** 第几次尝试（1-based） */
      attempt: number
      /** 打之前等多久（0 = 立即） */
      delayMs: number
      /** 这一轮是否先 `POST /auth/refresh` */
      refresh: boolean
    }
  | {
      action: 'stop'
      attempt: number
      code: string
      failureKind: FailureKind
      needLogin: boolean
      tone: 'neutral' | 'error'
      /** 静默停止（用户取消 / 并发冲突）：不弹状态、不改相位 */
      silent: boolean
    }

export interface PlanRecoveryOptions {
  /** 前台恢复 / 用户点「立即重连」：第一次尝试不等退避 */
  immediate?: boolean
}

/**
 * 下一步该干什么（**唯一的判定点**，`store.ts` 的重连循环只读它）。
 *
 * | state | failure | 结果 |
 * |---|---|---|
 * | 任意 | `null`（用户/前台触发） | `retry`（immediate 时 delay 0） |
 * | 任意 | 不可自愈 | `stop` |
 * | attempt ≥ MAX | 可自愈 | `stop`（等用户点立即重连 / 下次回前台） |
 * | refreshUsed=false + 需要刷新 | 可自愈 | `retry` + `refresh:true`（**只这一次**） |
 * | refreshUsed=true + 需要刷新 | — | `stop`（`needLogin:true`：refresh 也过期了） |
 * | 其它可自愈 | — | `retry` + 指数退避 |
 */
export const planRecoveryStep = (
  state: RecoveryState,
  failure: FailureInput | null,
  options: PlanRecoveryOptions = {},
): RecoveryStep => {
  const immediate = options.immediate === true && state.attempt === 0

  // 没有具体失败（回前台 / 用户点「立即重连」/ 页面重建）：这就是一次「现在就试」，
  // 第一次不等退避；退避只用来应付「刚失败过」的情况。
  if (failure === null) {
    return { action: 'retry', attempt: state.attempt + 1, delayMs: 0, refresh: false }
  }

  const verdict = classifyFailure(failure)

  if (!verdict.auto) {
    return {
      action: 'stop',
      attempt: state.attempt,
      code: verdict.code,
      failureKind: verdict.kind,
      needLogin: verdict.needLogin,
      tone: verdict.tone,
      silent: verdict.silent,
    }
  }

  // 「先 refresh 再重连」只能用一次：refresh 之后还是 401/过期 → 这才叫「登录过期了」
  if (verdict.needsRefresh && state.refreshUsed) {
    return {
      action: 'stop',
      attempt: state.attempt,
      code: verdict.code,
      failureKind: 'need-login',
      needLogin: true,
      tone: 'error',
      silent: false,
    }
  }

  if (state.attempt >= MAX_RECONNECT_ATTEMPTS) {
    return {
      action: 'stop',
      attempt: state.attempt,
      code: verdict.code,
      failureKind: verdict.kind,
      needLogin: false,
      tone: 'neutral',
      silent: false,
    }
  }

  return {
    action: 'retry',
    attempt: state.attempt + 1,
    delayMs: immediate ? 0 : backoffDelayMs(state.attempt + 1),
    refresh: verdict.needsRefresh,
  }
}

/** 按 step 推进状态（重连器每轮结束后调一次；纯函数便于自测把整条序列跑出来） */
export const advanceRecoveryState = (
  state: RecoveryState,
  step: Extract<RecoveryStep, { action: 'retry' }>,
): RecoveryState => ({
  attempt: step.attempt,
  refreshUsed: state.refreshUsed || step.refresh,
})
