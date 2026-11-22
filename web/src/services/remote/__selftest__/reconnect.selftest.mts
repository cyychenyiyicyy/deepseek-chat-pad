/**
 * 掉线自愈（R10）自测：**「连接断了」和「凭据失效」彻底分开**。
 *
 * 跑法（workdir = projects\deepseek-tablet\web）：
 *   npx tsx src/services/remote/__selftest__/reconnect.selftest.mts
 *
 * 覆盖（对应任务书「自测」那一行）：
 *   A. 分诊表逐条（`classifyFailure` / `classifyCloseCode` / `parseLinkCloseDetail`）
 *     A1 网络类（超时 / CONNECTION_FAILED / CONNECTION_REPLACED / TRANSPORT_CLOSED / 5xx）
 *        → 自动重连、中性语气、**不提凭据**；
 *     A2 WS close code 1006 / 4001 / 4009 / 1013 → 自动重连；4002 → 先刷新；4003 → 重连；
 *        4004 → 设备撤销（终止）；
 *     A3 401 / TOKEN_EXPIRED / AUTH_REQUIRED → 先刷新再重连；
 *     A4 真需要重新登录的码 → need-login（终止）；
 *     A5 设备撤销 / 身份不符 / 会员到期 / 版本不兼容 → blocked（终止，不重连）；
 *     A6 `navigator.onLine === false` 优先于任何错误码（不能因此说凭据失效）；
 *     A7 未知码 → 当网络故障（可重试），绝不默认判凭据；
 *     A8 用户主动取消 → 静默（不重连也不弹错）。
 *   B. 退避序列（`backoffDelayMs` + `planRecoveryStep` 整条驱动）
 *     B1 1s / 2s / 4s / 8s / 16s，上限 30s；
 *     B2 连续网络失败只重试 5 次，第 6 次停（中性，不升级成「凭据」）；
 *     B3 回前台/用户点一次（`immediate`）第一次不等退避。
 *   C. refresh 只试一次（`planRecoveryStep` + `advanceRecoveryState`）
 *     C1 第一次撞 401 → `refresh:true`；刷新后再撞 401 → 停成 need-login（**不再刷新**）；
 *     C2 「远端说 token 过期但本地还没标过期」也能触发刷新（不必等本地时钟）。
 *   D. store 级：过期的 accessToken + 有效的 refreshToken → 先刷新、用新 token 继续连，
 *      且失败后**不清任何凭据**（D1/D2）。
 *   E. store 级：回前台（`onAppForeground()`）立刻重连，不等定时器；失败落中性态（E1）；
 *      `disconnect()` 能立刻叫停正在跑的退避（E2）。
 *   F. store 级：真需要重新登录时才是红字（F1：refresh token 过期 → SESSION_EXPIRED +
 *      **保留** last-session / 账号）。
 *
 * 不联网：REST 全部用注入的全局 fetch 桩；localStorage 用内存实现（Node 里没有 webstorage）。
 * 结尾按仓库约定设置真实退出码。
 */

import {
  backoffDelayMs,
  classifyCloseCode,
  classifyFailure,
  INITIAL_RECOVERY_STATE,
  MAX_RECONNECT_ATTEMPTS,
  parseLinkCloseDetail,
  planRecoveryStep,
  RECONNECT_MAX_DELAY_MS,
  advanceRecoveryState,
  type FailureInput,
  type RecoveryState,
} from '../reconnect.js'
import { ACCOUNT_STORAGE_KEY, loadAccounts, upsertAccount, type RemoteAccount } from '../storage.js'
import { readLastSession, writeLastSession, type LastSession } from '../autoConnect.js'

/* ── 最小断言器（与其它 selftest 同一套写法） ─────────────────────────── */

const checks: Array<{ name: string; run: () => Promise<void> }> = []
const check = (name: string, run: () => Promise<void>): void => {
  checks.push({ name, run })
}

const fail = (message: string): never => {
  throw new Error(message)
}

const assertEqual = (actual: unknown, expected: unknown, label: string): void => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) fail(`${label}：期望 ${e}，实际 ${a}`)
}

const assertTrue = (value: boolean, label: string): void => {
  if (!value) fail(label)
}

const assertContains = (haystack: string, needle: string, label: string): void => {
  if (!haystack.includes(needle)) fail(`${label}：期望包含 ${JSON.stringify(needle)}，实际 ${JSON.stringify(haystack)}`)
}

/** 中性文案里**不许**出现这些词（出现就是又回到「凭据失效」那条老路上了） */
const CREDENTIAL_WORDS = ['凭据失效', '重新登录', '登录已过期', '需要重新登录']
const assertNoCredentialWord = (text: string, label: string): void => {
  for (const word of CREDENTIAL_WORDS) {
    if (text.includes(word)) fail(`${label}：中性文案里出现了「${word}」——${JSON.stringify(text)}`)
  }
}

/* ── 内存版 localStorage（Node 里没有 webstorage） ───────────────────── */

class MemoryStorage {
  private readonly data = new Map<string, string>()

  get length(): number {
    return this.data.size
  }

  clear(): void {
    this.data.clear()
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.data.delete(key)
  }

  setItem(key: string, value: string): void {
    this.data.set(key, String(value))
  }
}

let storage = new MemoryStorage()

const resetStorage = (): void => {
  storage = new MemoryStorage()
  ;(globalThis as unknown as Record<string, unknown>).localStorage = storage
}

resetStorage()

/* ── 固定数据 ─────────────────────────────────────────────────────────── */

const BASE = 'https://dsh.r2049.cn'
const EMAIL = 'u@example.com'
const ACCESS_TOKEN = 'access-token-0123456789'
const REFRESH_TOKEN = 'refresh-token-0123456789'
const NOW = 1_786_000_000_000
const realNow = (): number => Date.now()

const account = (patch: Partial<RemoteAccount> = {}): RemoteAccount => ({
  email: EMAIL,
  accessToken: ACCESS_TOKEN,
  refreshToken: REFRESH_TOKEN,
  deviceId: '01JDEVICE0000000000000000',
  scope: 'device',
  serverUrl: BASE,
  accessTokenExpiresAt: realNow() + 3_600_000,
  refreshTokenExpiresAt: realNow() + 7_200_000,
  loginMethod: 'password',
  ...patch,
})

const session = (patch: Partial<LastSession> = {}): LastSession => ({
  serverUrl: BASE,
  email: EMAIL,
  hostDeviceId: '01JHOST00000000000000000',
  hostName: '书房 Mac',
  capabilities: ['harness.remote.v3'],
  transport: 'relay',
  savedAt: NOW,
  ...patch,
})

const seedAccount = (patch: Partial<RemoteAccount> = {}): RemoteAccount => upsertAccount(account(patch))

const seedSession = (patch: Partial<LastSession> = {}): LastSession => {
  const saved = writeLastSession(session(patch))
  if (saved === null) throw new Error('seedSession：写入失败')
  return saved
}

/* ── 全局 fetch 桩 ───────────────────────────────────────────────────── */
/*
 * 注意：WebView 里所有 REST 都走原生代理（`POST /__ds_proxy`，真目标写在
 * `X-DS-Target`、真头写在 `X-DS-Headers`，两者都是 base64url）。
 * 所以桩必须**解码**才能知道「这是哪个接口、带的是哪个 token」。
 */

const decodeBase64Url = (value: string): string => {
  const normalized = value.replace(/-/gu, '+').replace(/_/gu, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  return Buffer.from(padded, 'base64').toString('utf8')
}

const headerValue = (init: RequestInit, name: string): string => {
  const headers = (init.headers ?? {}) as Record<string, string>
  return headers[name] ?? headers[name.toLowerCase()] ?? ''
}

/** `X-DS-Target`（base64url 的绝对地址）→ 我们关心的那一段路径 */
const targetPathOf = (init: RequestInit): string => {
  const raw = headerValue(init, 'X-DS-Target')
  if (raw.length === 0) return ''
  try {
    const target = decodeBase64Url(raw)
    const url = new URL(target)
    return `${url.pathname}${url.search}`
  } catch {
    return ''
  }
}

/** `X-DS-Headers`（base64url 的 JSON）里的 Authorization */
const authOf = (init: RequestInit): string => {
  const raw = headerValue(init, 'X-DS-Headers')
  if (raw.length === 0) return headerValue(init, 'Authorization')
  try {
    const parsed = JSON.parse(decodeBase64Url(raw)) as Record<string, string>
    return parsed.Authorization ?? parsed.authorization ?? ''
  } catch {
    return ''
  }
}

interface FetchStub {
  calls: number
  /** 只数**走原生代理的远端 REST**（`/__ds_proxy`）：原生保活 / 通知端点不算「连接尝试」 */
  remoteCalls: number
  paths: string[]
  auths: string[]
  restore: () => void
}

const stubFetch = (reply: (path: string, init: RequestInit) => Response | null): FetchStub => {
  const original = globalThis.fetch
  const state: FetchStub = {
    calls: 0,
    remoteCalls: 0,
    paths: [],
    auths: [],
    restore: () => {
      globalThis.fetch = original
    },
  }
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const options = init ?? {}
    const target = targetPathOf(options)
    const path = target || String(input)
    state.calls += 1
    if (target.length > 0) state.remoteCalls += 1
    state.paths.push(path)
    state.auths.push(authOf(options))
    const response = reply(path, options)
    if (response === null) throw new TypeError(`fetch failed: ${path}`)
    return response
  }) as typeof fetch
  return state
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** 壳环境标记（`isNativeShell()` 读的是调用时的全局对象） */
const enterShell = (): void => {
  ;(globalThis as unknown as Record<string, unknown>).window = { __DS_NATIVE__: {} }
}

const leaveShell = (): void => {
  delete (globalThis as unknown as Record<string, unknown>).window
}

/** 轮询等一个条件（重连是异步的：不 sleep 就只能靠它） */
const waitFor = async (predicate: () => boolean, timeoutMs: number, label: string): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  fail(`${label}：等 ${timeoutMs}ms 还没满足`)
}

/* ── store（必须在 localStorage 装好之后再加载） ─────────────────────── */

const storeModule = await import('../store.js')
const { useRemoteStore, describeRemoteRecovery } = storeModule

const resetStore = (): void => {
  useRemoteStore.setState({
    phase: 'idle',
    error: null,
    transport: null,
    streaming: false,
    autoConnect: { state: 'idle' },
    reconnect: { status: 'idle', attempt: 0, maxAttempts: MAX_RECONNECT_ATTEMPTS },
    lastSession: null,
    activeSessionId: null,
    sessions: [],
  })
}

/* ══════════════════════════════════════════════════════════════════════
 * A. 分诊表逐条
 * ══════════════════════════════════════════════════════════════════════ */

const verdict = (input: FailureInput) => classifyFailure(input)

check('A1 网络类：自动重连 + 中性语气 + 一个字都不提凭据', async () => {
  const networkish: FailureInput[] = [
    { code: 'NETWORK_ERROR' },
    { code: 'RPC_TIMEOUT' },
    { code: 'CONNECTION_FAILED' },
    { code: 'CONNECTION_REPLACED' },
    { code: 'TRANSPORT_CLOSED' },
    { code: 'SECURE_CHANNEL_FAILED' },
    { code: 'HOST_OFFLINE' },
    { code: 'UPSTREAM_TIMEOUT' },
    { code: 'EVENT_STREAM_CLOSED' },
    { code: 'HTTP_500', status: 503 },
    { status: 502 },
    { code: '', status: 504 },
  ]
  for (const input of networkish) {
    const v = verdict(input)
    assertTrue(v.auto, `${JSON.stringify(input)} 应该自动重连，实际 kind=${v.kind}`)
    assertEqual(v.tone, 'neutral', `${JSON.stringify(input)} 的语气`)
    assertEqual(v.needLogin, false, `${JSON.stringify(input)} 不该要人重新登录`)
    assertEqual(v.needsRefresh, false, `${JSON.stringify(input)} 不该先刷新`)
  }
})

check('A2 WS close code：1006/4001/4009 重连，4002 先刷新，4003 重连，4004 设备撤销', async () => {
  for (const closeCode of [1006, 1001, 1011, 1012, 1013, 4001, 4009]) {
    const v = verdict({ code: 'TRANSPORT_CLOSED', closeCode })
    assertTrue(v.auto, `close ${closeCode} 应该自动重连`)
    assertEqual(v.kind, 'unreachable', `close ${closeCode} 的种类`)
  }
  // 4002：协议 §22 明确「走刷新流程」——这是**可自愈**的，不是凭据失效
  const expired = verdict({ code: 'TRANSPORT_CLOSED', closeCode: 4002 })
  assertEqual(expired.kind, 'token-expired', 'close 4002')
  assertEqual(expired.needsRefresh, true, 'close 4002 要先刷新')
  assertTrue(expired.auto, 'close 4002 会自动重连')
  assertEqual(expired.tone, 'neutral', 'close 4002 是中性事件')
  // 4003：被另一台设备抢占 —— 任务书要求仍自动重连（有退避，不会造成风暴）
  assertTrue(verdict({ closeCode: 4003 }).auto, 'close 4003 自动重连')
  // 4004：设备被撤销 —— 唯一一个「close 码直接定性」的终止态
  const revoked = verdict({ closeCode: 4004 })
  assertEqual(revoked.kind, 'blocked', 'close 4004')
  assertEqual(revoked.auto, false, 'close 4004 不重连')
  assertEqual(revoked.code, 'DEVICE_REVOKED', 'close 4004 的码')
  // 拿不到任何信息也不许判凭据
  assertEqual(verdict({}).kind, 'unreachable', '空输入按网络故障')
  assertEqual(classifyCloseCode(undefined), null, '没有 close code 时返回 null')
})

check('A3 token 过期类：先自动刷新，再重连（不当成需要重新登录）', async () => {
  for (const input of [
    { code: 'TOKEN_EXPIRED' },
    { code: 'AUTH_REQUIRED' },
    { code: 'AUTH_INVALID' },
    { status: 401 },
    { status: 403 },
    { code: 'SESSION_EXPIRED' },
  ] satisfies FailureInput[]) {
    const v = verdict(input)
    assertEqual(v.kind, 'token-expired', `${JSON.stringify(input)} 的种类`)
    assertEqual(v.needsRefresh, true, `${JSON.stringify(input)} 应该先刷新`)
    assertTrue(v.auto, `${JSON.stringify(input)} 刷新之后要继续连`)
    assertEqual(v.tone, 'neutral', `${JSON.stringify(input)} 在中性语气里（刷新是后台动作）`)
  }
})

check('A4 真需要重新登录：只有这些码才升级成「登录已过期」', async () => {
  for (const code of ['REFRESH_TOKEN_EXPIRED', 'REFRESH_FAILED', 'NO_CREDENTIAL', 'ACCOUNT_AUTH_REQUIRED']) {
    const v = verdict({ code })
    assertEqual(v.kind, 'need-login', `${code} 的种类`)
    assertEqual(v.needLogin, true, `${code} 需要人重新登录`)
    assertEqual(v.auto, false, `${code} 不该自动重连`)
    assertEqual(v.tone, 'error', `${code} 才是红字`)
  }
})

check('A5 设备撤销 / 身份不符 / 会员到期 / 版本不兼容：终止且不重连', async () => {
  const blocked = [
    'DEVICE_REVOKED',
    'DEVICE_OWNERSHIP_REQUIRED',
    'MEMBERSHIP_REQUIRED',
    'PEER_IDENTITY_MISMATCH',
    'HOST_IDENTITY_MISSING',
    'IDENTITY_MISMATCH',
    'NO_HOST',
    'UNSUPPORTED_VERSION',
    'METHOD_NOT_FOUND',
    'HARNESS_VERSION_INCOMPATIBLE',
  ]
  for (const code of blocked) {
    const v = verdict({ code })
    assertEqual(v.kind, 'blocked', `${code} 的种类`)
    assertEqual(v.auto, false, `${code} 不该自动重连`)
    assertEqual(v.tone, 'error', `${code} 需要人处理`)
  }
  // 撤销 ≠ 登录过期：文案得不一样（提示重新注册设备）
  assertEqual(verdict({ code: 'DEVICE_REVOKED' }).needLogin, false, '设备撤销不是「登录过期」')
})

check('A6 没网优先于任何错误码：不能因为断网就说凭据有问题', async () => {
  const v = verdict({ code: 'AUTH_INVALID', status: 401, online: false })
  assertEqual(v.kind, 'offline', 'online:false 一律离线')
  assertTrue(v.auto, '离线要等网络回来再连')
  assertEqual(v.needsRefresh, false, '离线不该去打刷新（会白撞一次 401）')
  assertEqual(v.tone, 'neutral', '离线是中性事件')
})

check('A7 未知错误码：按网络故障重试，绝不默认判成凭据问题', async () => {
  const v = verdict({ code: 'SOME_NEW_SERVER_CODE' })
  assertEqual(v.kind, 'unreachable', '未知码的种类')
  assertTrue(v.auto, '未知码先重试')
  assertEqual(v.tone, 'neutral', '未知码不该红字')
  assertEqual(v.needLogin, false, '未知码不该要人重新登录')
})

check('A8 用户主动取消 / 并发冲突：静默停止（不重连、不弹错）', async () => {
  for (const code of ['RPC_ABORTED', 'CONNECT_BUSY', 'CANCELLED']) {
    const v = verdict({ code })
    assertEqual(v.auto, false, `${code} 不该重连`)
    assertEqual(v.silent, true, `${code} 应该静默`)
  }
})

check('A9 parseLinkCloseDetail：把 onState 的字符串拆成 code + closeCode', async () => {
  const heartbeat = parseLinkCloseDetail('TRANSPORT_CLOSED: 原生桥关闭：heartbeat timeout（code=4009）')
  assertEqual(heartbeat.code, 'TRANSPORT_CLOSED', '心跳超时的失败码')
  assertEqual(heartbeat.closeCode, 4009, '心跳超时的 close code')
  assertEqual(verdict(heartbeat).kind, 'unreachable', '4009 是网络故障')

  const credential = parseLinkCloseDetail('TRANSPORT_CLOSED: 原生桥关闭：凭据失效（code=4002）')
  assertEqual(credential.closeCode, 4002, '凭据过期的 close code')
  assertEqual(verdict(credential).needsRefresh, true, '4002 必须先刷新')

  const timeout = parseLinkCloseDetail('CONNECTION_FAILED: 等待 hello.ack 超时。')
  assertEqual(timeout.code, 'CONNECTION_FAILED', '握手超时的失败码')
  assertEqual(timeout.closeCode, undefined, '没有 close code')
  assertEqual(parseLinkCloseDetail(undefined), {}, '没有 detail')
  assertEqual(parseLinkCloseDetail('').code, undefined, '空串')
  // 只有一句话、没有 code: 前缀时也要能吃
  assertEqual(parseLinkCloseDetail('原生桥关闭：server shutdown（code=4001）').closeCode, 4001, '裸原因里的 close code')
})

/* ══════════════════════════════════════════════════════════════════════
 * B. 退避序列
 * ══════════════════════════════════════════════════════════════════════ */

const networkFailure: FailureInput = { code: 'CONNECTION_FAILED' }

/** 按真实调用顺序把循环跑一遍，收集每一轮的延迟（不 sleep） */
const runSequence = (
  failureFor: (attempt: number) => FailureInput | null,
  options: { immediate?: boolean } = {},
): { delays: number[]; refreshes: boolean[]; stop: { code: string; needLogin: boolean; tone: string } | null } => {
  let state: RecoveryState = { ...INITIAL_RECOVERY_STATE }
  const delays: number[] = []
  const refreshes: boolean[] = []
  let failure: FailureInput | null = failureFor(0)
  let step = planRecoveryStep(state, failure, options)
  for (let guard = 0; guard < 20; guard += 1) {
    if (step.action === 'stop') {
      return { delays, refreshes, stop: { code: step.code, needLogin: step.needLogin, tone: step.tone } }
    }
    delays.push(step.delayMs)
    refreshes.push(step.refresh)
    state = advanceRecoveryState(state, step)
    failure = failureFor(state.attempt)
    step = planRecoveryStep(state, failure)
  }
  return { delays, refreshes, stop: null }
}

check('B1 指数退避：1s / 2s / 4s / 8s / 16s，上限 30s', async () => {
  assertEqual([1, 2, 3, 4, 5].map(backoffDelayMs), [1_000, 2_000, 4_000, 8_000, 16_000], '前 5 次')
  assertEqual(backoffDelayMs(6), 30_000, '第 6 次封顶 30s')
  assertEqual(backoffDelayMs(99), RECONNECT_MAX_DELAY_MS, '再远也是上限')
  assertEqual(backoffDelayMs(0), 1_000, '0 当第 1 次')
  assertEqual(backoffDelayMs(-3), 1_000, '负数当第 1 次')
})

check('B2 连续网络失败：只重试 5 次，第 6 次停在中性态（不升级成凭据问题）', async () => {
  const run = runSequence(() => networkFailure)
  assertEqual(run.delays, [1_000, 2_000, 4_000, 8_000, 16_000], '退避序列')
  assertEqual(run.refreshes, [false, false, false, false, false], '网络故障不该触发刷新')
  assertTrue(run.stop !== null, '5 次之后必须停')
  assertEqual(run.stop?.tone, 'neutral', '用完次数是中性态')
  assertEqual(run.stop?.needLogin, false, '用完次数不等于要重新登录')
  assertEqual(run.stop?.code, 'CONNECTION_FAILED', '停下来的码')
})

check('B3 回前台 / 用户点「立即重连」：第一次不等退避', async () => {
  const immediate = planRecoveryStep({ ...INITIAL_RECOVERY_STATE }, networkFailure, { immediate: true })
  assertEqual(immediate.action, 'retry', '动作')
  assertEqual(immediate.action === 'retry' ? immediate.delayMs : -1, 0, '第一次不等待')

  // 但从第二轮开始照样退避
  const second = planRecoveryStep({ attempt: 1, refreshUsed: false }, networkFailure, { immediate: true })
  assertEqual(second.action === 'retry' ? second.delayMs : -1, 2_000, '第二轮恢复退避')

  // 用户什么都没发生时的首轮（failure === null）：也是立即
  const kick = planRecoveryStep({ ...INITIAL_RECOVERY_STATE }, null)
  assertEqual(kick.action === 'retry' ? kick.delayMs : -1, 0, 'failure=null 的首轮立即')
})

/* ══════════════════════════════════════════════════════════════════════
 * C. refresh 只试一次
 * ══════════════════════════════════════════════════════════════════════ */

check('C1 refresh 只试一次：刷新后再撞 401 才叫「登录过期」', async () => {
  // 第一轮：TOKEN_EXPIRED → 先刷新
  const first = planRecoveryStep({ ...INITIAL_RECOVERY_STATE }, { code: 'TOKEN_EXPIRED' })
  assertEqual(first.action, 'retry', '第一轮动作')
  if (first.action !== 'retry') throw new Error('第一轮应该是 retry')
  assertEqual(first.refresh, true, '第一轮要先刷新')
  assertEqual(first.delayMs, 1_000, '第一轮退避 1s')

  const afterFirst = advanceRecoveryState({ ...INITIAL_RECOVERY_STATE }, first)
  assertEqual(afterFirst.refreshUsed, true, '刷新用掉了')

  // 第二轮：还是 401 → 停止，且**不再**刷新
  const second = planRecoveryStep(afterFirst, { code: 'TOKEN_EXPIRED', status: 401 })
  assertEqual(second.action, 'stop', '刷新之后还 401 就停')
  assertEqual(second.action === 'stop' ? second.needLogin : null, true, '这才叫需要重新登录')
  assertEqual(second.action === 'stop' ? second.tone : null, 'error', '这才是红字')

  // 整条序列里刷新只出现一次
  const run = runSequence(() => ({ code: 'TOKEN_EXPIRED', status: 401 }))
  assertEqual(run.refreshes, [true], '整条恢复里只刷新一次')
  assertEqual(run.delays, [1_000], '刷新 + 重连只打一轮')
})

check('C2 只在远端说 token 过期时才刷新；纯网络故障不刷新', async () => {
  const network = planRecoveryStep({ ...INITIAL_RECOVERY_STATE }, { code: 'NETWORK_ERROR' })
  assertEqual(network.action === 'retry' ? network.refresh : null, false, '网络故障不刷新')

  const unknown = planRecoveryStep({ ...INITIAL_RECOVERY_STATE }, { code: 'SOMETHING_NEW' })
  assertEqual(unknown.action === 'retry' ? unknown.refresh : null, false, '未知码不刷新')

  // 远端说过期、本地时钟还没到（服务器才是权威）→ 照样刷新
  const remote = planRecoveryStep({ ...INITIAL_RECOVERY_STATE }, { closeCode: 4002 })
  assertEqual(remote.action === 'retry' ? remote.refresh : null, true, 'close 4002 也要刷新')
})

/* ══════════════════════════════════════════════════════════════════════
 * D. store 级：过期的 accessToken + 有效 refreshToken
 * ══════════════════════════════════════════════════════════════════════ */

check('D1 access token 已过期但 refresh 能成：先刷新（用新 token 继续连），失败也不清凭据', async () => {
  resetStorage()
  resetStore()
  // access token 已经过期（提前量内），refresh token 还有效 → planAutoConnect 会说 refresh:true
  seedAccount({ accessTokenExpiresAt: realNow() - 1_000, refreshTokenExpiresAt: realNow() + 3_600_000 })
  seedSession()
  enterShell()

  const NEW_ACCESS = 'access-token-refreshed-42'
  const NEW_REFRESH = 'refresh-token-rotated-42'
  const stub = stubFetch((path) => {
    if (path.startsWith('/api/v1/auth/refresh')) {
      return jsonResponse({
        accessToken: NEW_ACCESS,
        refreshToken: NEW_REFRESH,
        accessTokenExpiresAt: realNow() + 3_600_000,
        refreshTokenExpiresAt: realNow() + 7_200_000,
      })
    }
    // 刷新之后紧接着列 Host：故意 500，钉住「刷新成功但建链失败」这条分支
    if (path.startsWith('/api/v1/devices')) return jsonResponse({ error: { code: 'INTERNAL_ERROR' } }, 500)
    return null
  })
  try {
    await useRemoteStore.getState().autoConnectNow()
    const state = useRemoteStore.getState()

    // 1. 刷新确实发生了，而且正是「先刷新」
    const refreshIdx = stub.paths.findIndex((path) => path.startsWith('/api/v1/auth/refresh'))
    assertTrue(refreshIdx === 0, `第一个请求必须是 refresh，实际 ${JSON.stringify(stub.paths)}`)

    // 2. 刷新之后用的是**新** token（旧 token 已经失效，拿它继续只会再撞一次 401）
    assertEqual(stub.auths[0], '', '刷新请求不带 Authorization（deviceId / refreshToken 在 body 里）')
    const devicesAuth = stub.auths[1]
    assertEqual(devicesAuth, `Bearer ${NEW_ACCESS}`, '刷新之后的请求必须用新 access token')

    // 3. 新 pair 原子落盘（refresh token 轮换了，存旧的会让下次刷新直接 401）
    const stored = loadAccounts()[0]
    assertEqual(stored?.accessToken, NEW_ACCESS, '落盘的 access token')
    assertEqual(stored?.refreshToken, NEW_REFRESH, '落盘的 refresh token')

    // 4. 失败是**中性**的：不判凭据、不删任何东西
    assertEqual(state.autoConnect.state, 'failed', '本次恢复失败')
    assertTrue(state.autoConnect.code !== 'SESSION_EXPIRED', `失败码不该是过期：${state.autoConnect.code}`)
    assertEqual(state.error, null, '中性失败不写 state.error')
    assertEqual(state.reconnect.status, 'failed', '自愈状态：暂时连不上')
    assertEqual(state.reconnect.kind, 'unreachable', '失败种类')
    assertNoCredentialWord(state.autoConnect.message ?? '', '自动恢复的说明')
    assertEqual(readLastSession() === null, false, 'last-session 必须留着')
    assertEqual(loadAccounts().length, 1, '账号凭据必须留着')
    assertContains(describeRemoteRecovery(), 'failed', '诊断摘要')
  } finally {
    // 收尾：把可能还在退避的重连叫停，别让它在下一个用例里继续打网络
    useRemoteStore.getState().disconnect()
    stub.restore()
    leaveShell()
  }
})

check('D2 刷新本身 401：这时才判「登录已过期」，但仍然不删凭据', async () => {
  resetStorage()
  resetStore()
  seedAccount({ accessTokenExpiresAt: realNow() - 1_000, refreshTokenExpiresAt: realNow() + 3_600_000 })
  seedSession()
  enterShell()
  const stub = stubFetch((path) =>
    path.startsWith('/api/v1/auth/refresh')
      ? jsonResponse({ error: { code: 'AUTH_INVALID', message: 'refresh token 已失效' } }, 401)
      : null,
  )
  try {
    // `retryAutoConnect`（不是 `autoConnectNow`）：后者每个进程只自动跑一次，
    // 前面的用例已经把它用掉了（`autoConnectSettled`）。
    await useRemoteStore.getState().retryAutoConnect()
    const state = useRemoteStore.getState()
    assertEqual(state.autoConnect.state, 'failed', '恢复失败')
    assertEqual(state.autoConnect.code, 'SESSION_EXPIRED', '刷新 401 → 请重新登录')
    assertEqual(state.reconnect.status, 'need-login', '自愈状态：需要人处理')
    // 刷新失败被**一次性定性**成 REFRESH_FAILED（不能把裸 401 往上抛，否则会「刷新失败→再刷新」死循环）
    assertEqual(state.error?.code, 'REFRESH_FAILED', '错误码')
    assertContains(state.error?.message ?? '', 'refresh token 已失效', '原始 message 保留在说明里')
    // 铁律：异步失败**永不**删凭据
    assertEqual(readLastSession() === null, false, 'last-session 必须留着')
    assertEqual(loadAccounts().length, 1, '账号凭据必须留着')
    assertContains(storage.getItem(ACCOUNT_STORAGE_KEY) ?? '', '01JDEVICE', '账号表还在盘上')
  } finally {
    // 收尾：把可能还在退避的重连叫停，别让它在下一个用例里继续打网络
    useRemoteStore.getState().disconnect()
    stub.restore()
    leaveShell()
  }
})

/* ══════════════════════════════════════════════════════════════════════
 * E. store 级：回前台立即自愈
 * ══════════════════════════════════════════════════════════════════════ */

check('E1 回前台（onAppForeground）立刻重连，不等定时器；失败落中性态', async () => {
  resetStorage()
  resetStore()
  seedAccount()
  seedSession()
  enterShell()
  useRemoteStore.setState({ phase: 'idle', lastSession: readLastSession() })
  const stub = stubFetch(() => null)
  try {
    // 不 await：自愈会退避重试 5 次（加起来 31s），这里只等第一轮
    void useRemoteStore.getState().onAppForeground()
    await waitFor(() => stub.remoteCalls > 0, 2_000, '回前台应该立刻打一次远端请求')
    const firstAttemptCalls = stub.remoteCalls
    assertEqual(firstAttemptCalls, 1, '立即重连只打一次远端请求（不并发、也不等 1s 退避）')

    const during = useRemoteStore.getState()
    assertTrue(
      during.reconnect.status === 'waiting' || during.reconnect.status === 'connecting',
      `自愈状态应该是进行中，实际 ${during.reconnect.status}`,
    )
    // 尝试次数是一个「至少」的断言：自愈跑得很快，读状态时可能已经进入第 2 次退避
    assertTrue(during.reconnect.attempt >= 1, `尝试次数至少 1，实际 ${during.reconnect.attempt}`)
    assertEqual(during.reconnect.maxAttempts, MAX_RECONNECT_ATTEMPTS, '次数上限')
    assertEqual(during.error, null, '自愈期间不写 error（不弹红字）')
    assertEqual(during.autoConnect.state, 'connecting', '界面上是「正在恢复」')
    assertEqual(readLastSession() === null, false, '自愈期间不动 last-session')
  } finally {
    // 收尾：把可能还在退避的重连叫停，别让它在下一个用例里继续打网络
    useRemoteStore.getState().disconnect()
    stub.restore()
    leaveShell()
  }
})

check('E2 disconnect() 能立刻叫停正在退避的自愈（不会过几秒自己连回来）', async () => {
  resetStorage()
  resetStore()
  seedAccount()
  seedSession()
  enterShell()
  useRemoteStore.setState({ phase: 'idle', lastSession: readLastSession() })
  const stub = stubFetch(() => null)
  try {
    // 用「立即重连」按钮那条入口（`reconnectNow`）：它不依赖 visibilitychange 事件
    void useRemoteStore.getState().reconnectNow()
    try {
      await waitFor(() => stub.remoteCalls > 0, 2_000, '先让第一轮跑起来')
    } catch (error) {
      const now = useRemoteStore.getState()
      console.error(
        `      [diag] remoteCalls=${stub.remoteCalls} calls=${stub.calls} phase=${now.phase} reconnect=${JSON.stringify(now.reconnect)} autoConnect=${JSON.stringify(now.autoConnect)} paths=${JSON.stringify(stub.paths)} sess=${readLastSession() === null ? 'none' : 'ok'} accounts=${loadAccounts().length}`,
      )
      throw error
    }
    // 此刻应该停在退避里（第 1 轮失败 → 等 1s）
    await waitFor(() => useRemoteStore.getState().reconnect.status === 'waiting', 2_000, '应该进入退避等待')

    useRemoteStore.getState().disconnect()
    const after = useRemoteStore.getState()
    assertEqual(after.reconnect.status, 'idle', '断开后自愈必须复位')
    assertEqual(after.phase, 'idle', '相位复位')
    assertEqual(readLastSession() === null, false, '临时断开仍然保留 last-session')

    // 等 1.3s：如果退避没被叫停，这里会多打一次网络
    const callsAtDisconnect = stub.remoteCalls
    await new Promise<void>((resolve) => setTimeout(resolve, 1_300))
    assertEqual(stub.remoteCalls, callsAtDisconnect, '断开之后不许再打远端请求')
    assertEqual(useRemoteStore.getState().reconnect.status, 'idle', '自愈不会自己复活')
  } finally {
    // 收尾：把可能还在退避的重连叫停，别让它在下一个用例里继续打网络
    useRemoteStore.getState().disconnect()
    stub.restore()
    leaveShell()
  }
})

/* ══════════════════════════════════════════════════════════════════════
 * F. store 级：真需要人处理才是红字
 * ══════════════════════════════════════════════════════════════════════ */

check('F1 refresh token 过期：红字「请重新登录」，但 last-session / 账号仍然保留', async () => {
  resetStorage()
  resetStore()
  seedAccount({ accessTokenExpiresAt: realNow() - 1_000, refreshTokenExpiresAt: realNow() - 1_000 })
  seedSession()
  enterShell()
  const stub = stubFetch(() => null)
  try {
    await useRemoteStore.getState().retryAutoConnect()
    const state = useRemoteStore.getState()
    assertEqual(state.autoConnect.state, 'failed', 'failed')
    assertEqual(state.autoConnect.code, 'SESSION_EXPIRED', '要用户重新登录')
    assertEqual(state.reconnect.status, 'need-login', '自愈状态')
    assertEqual(state.phase, 'error', '这才是红字相位')
    assertTrue(state.error !== null, '要给出可读错误')
    assertEqual(stub.calls, 0, '凭据已经不能用了，一个请求都不该打')
    // R10 铁律：异步失败不删凭据（以前这里会 clearLastSession，导致「重启也连不回来」）
    assertEqual(readLastSession() === null, false, 'last-session 必须留着')
    assertEqual(loadAccounts().length, 1, '账号凭据必须留着（邮箱还要给登录表单预填）')
    assertEqual(loadAccounts()[0]?.email, EMAIL, '邮箱')
  } finally {
    // 收尾：把可能还在退避的重连叫停，别让它在下一个用例里继续打网络
    useRemoteStore.getState().disconnect()
    stub.restore()
    leaveShell()
  }
})

/* ══════════════════════════════════════════════════════════════════════
 * G. [R17 假 ready]：链路悄悄断开留下 phase='ready' + active=null ——
 *    真机症状就是「点哪个会话都进不去，右侧永远停在『选择一个会话』」。
 * ══════════════════════════════════════════════════════════════════════ */

check('G1 假 ready 下点会话：requireSession 当场把 phase 纠正成 error（错误不再隐形）', async () => {
  resetStorage()
  resetStore()
  // 假 ready 的现场：phase 撒谎说连着（active 在自测里本来就是 null）
  useRemoteStore.setState({ phase: 'ready', activeSessionId: null })
  await useRemoteStore.getState().openSession('s-any')
  const state = useRemoteStore.getState()
  assertEqual(state.phase, 'error', '第一下点击就把假 ready 纠正掉')
  assertTrue(state.error !== null, '错误要写出来（右侧空态会显示它）')
  assertContains(state.error?.message ?? '', '连接', '错误说人话')
  assertEqual(state.activeSessionId, null, '会话当然没开成')
})

check('G2 假 ready 不再锁死自动恢复：autoConnect 会真的去试', async () => {
  resetStorage()
  resetStore()
  seedAccount()
  seedSession()
  enterShell()
  useRemoteStore.setState({ phase: 'ready', lastSession: readLastSession() })
  // fetch 全部失败 → 中性「连不上」：断言重点是「真的去试了」，不是失败长相
  const stub = stubFetch(() => null)
  try {
    // 旧版这里 `phase === 'ready'` 直接 return（一个请求都不打）—— 假 ready 被永久锁死
    await useRemoteStore.getState().retryAutoConnect()
    const state = useRemoteStore.getState()
    assertTrue(stub.calls > 0, `假 ready 也要真的去恢复（实际打了 ${stub.calls} 个请求）`)
    assertEqual(state.autoConnect.state, 'failed', '恢复按真实结果落定，而不是被跳过')
    assertEqual(state.reconnect.status, 'failed', '中性失败：暂时连不上')
    assertTrue(state.phase !== 'ready', `相位被真实结果接管（实际 ${state.phase}，绝不能继续假 ready）`)
  } finally {
    useRemoteStore.getState().disconnect()
    stub.restore()
    leaveShell()
  }
})

/* ── 跑 ───────────────────────────────────────────────────────────────── */

const describeDuration = (startedAt: number): string => `  (${Date.now() - startedAt}ms)`

const main = async (): Promise<void> => {
  let failures = 0
  for (const item of checks) {
    const startedAt = Date.now()
    try {
      await item.run()
      console.log(`PASS  ${item.name}${describeDuration(startedAt)}`)
    } catch (error) {
      failures += 1
      console.error(`FAIL  ${item.name}${describeDuration(startedAt)}`)
      console.error(`      ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  console.log(`\n${checks.length - failures} PASS / ${failures} FAIL / ${checks.length} TOTAL`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
