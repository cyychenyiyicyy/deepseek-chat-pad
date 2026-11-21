/**
 * 重启后自动恢复登录（K4）+ 权限中心（`/__ds_keepalive/permissions.json`）自测。
 *
 * 跑法（workdir = projects\deepseek-tablet\web）：
 *   npx tsx src/services/remote/__selftest__/last-session.selftest.mts
 *
 * 覆盖（对应任务书 A/B 两条 + 「自测覆盖」那一行）：
 *   A. last-session 持久化
 *     1. 写入 / 读回字段齐全、**不含任何 token**；
 *     2. 坏 JSON / 缺字段 → `null` 且键被删（留着只会每次启动白跑一遍）；
 *     3. 能力清单过滤（非字符串条目丢掉）；
 *     4. 秒 / 毫秒两种到期时间的归一化 + 提前量；
 *     5. `planAutoConnect` 的每个分支（无记录 / 账号没了 / 没注册设备 / refresh 过期 /
 *        需要刷新 / 直接连 / 没 refresh 又过期）。
 *   B. 自动连接的真实分支（store 级，网络用注入的 fetch 制造确定性失败）
 *     6. 没有 last-session → 一个请求都不打；
 *     7. token 有效但连不上 → `failed`，**不写 `error`**、相位回 `idle`、last-session 留着可重试；
 *     8. refresh token 过期 → `SESSION_EXPIRED` + 清 last-session + **账号邮箱保留**；
 *     9. `disconnect()`（临时断开）**不清** last-session / 账号；`signOut()` 两样都清。
 *   C. 权限中心
 *    10. `permissions.json` 404 → `null`（整节不显示）；
 *    11. 200 + HTML（旧 APK 的静态兜底）→ `null`；`{ok:false}` → `null`；
 *    12. 正常快照逐字段解析 + 缺字段取安全默认值；
 *    13. `POST /open` 的请求形状、`{ok:false,fallback}`、HTTP 500、连不上；
 *    14. `POST /notify` 的 `{enabled}` 形状。
 *
 * 不联网：REST / 原生桥全部用注入的 fetch；localStorage 用内存实现（Node 里没有 webstorage）。
 * 结尾按仓库约定设置真实退出码。
 */

import {
  ACCESS_TOKEN_REFRESH_SKEW_MS,
  LAST_SESSION_STORAGE_KEY,
  clearLastSession,
  describeLastSession,
  isExpiredAt,
  planAutoConnect,
  readLastSession,
  toEpochMs,
  writeLastSession,
  type LastSession,
} from '../autoConnect.js'
import {
  KEEPALIVE_NOTIFY_PATH,
  PERMISSIONS_OPEN_PATH,
  PERMISSIONS_PATH,
  openPermissionTarget,
  parsePermissions,
  probePermissions,
  requestNotificationPermission,
  setNotificationsEnabled,
} from '../permissions.js'
import { RemoteApiError, type FetchLike } from '../serverApi.js'
import { ACCOUNT_STORAGE_KEY, loadAccounts, upsertAccount, type RemoteAccount } from '../storage.js'

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
  if (a !== e) {
    fail(`${label}：期望 ${e}，实际 ${a}`)
  }
}

const assertTrue = (value: boolean, label: string): void => {
  if (!value) {
    fail(label)
  }
}

const assertContains = (haystack: string, needle: string, label: string): void => {
  if (!haystack.includes(needle)) {
    fail(`${label}：${JSON.stringify(haystack)} 里没有 ${JSON.stringify(needle)}`)
  }
}

const assertAbsent = (haystack: string, needle: string, label: string): void => {
  if (haystack.includes(needle)) {
    fail(`${label}：${JSON.stringify(haystack)} 里不该出现 ${JSON.stringify(needle)}`)
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

/** 每个 check 前重装一次：身份 / 账号 / last-session 全部从干净状态开始 */
const resetStorage = (): void => {
  storage = new MemoryStorage()
  ;(globalThis as unknown as Record<string, unknown>).localStorage = storage
}

resetStorage()

const storageDump = (): string => {
  const parts: string[] = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key !== null) {
      parts.push(`${key}=${storage.getItem(key) ?? ''}`)
    }
  }
  return parts.join('\n')
}

/* ── 固定数据 ─────────────────────────────────────────────────────────── */

const BASE = 'https://dsh.r2049.cn'
const EMAIL = 'u@example.com'
const ACCESS_TOKEN = 'access-token-0123456789'
const REFRESH_TOKEN = 'refresh-token-0123456789'
/** 纯函数测试用的「当前时刻」（固定值：planAutoConnect 的时间由参数给，不读系统钟） */
const NOW = 1_786_000_000_000
/** store 级测试用的真实「现在」：store 内部用的是 Date.now()，固定时间戳会立刻过期 */
const realNow = (): number => Date.now()

const account = (patch: Partial<RemoteAccount> = {}): RemoteAccount => ({
  email: EMAIL,
  accessToken: ACCESS_TOKEN,
  refreshToken: REFRESH_TOKEN,
  deviceId: '01JDEVICE0000000000000000',
  scope: 'device',
  serverUrl: BASE,
  // store 级测试走的是真实 Date.now()，所以默认值必须相对**现在**算（固定时间戳会立刻过期）
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

/** 把一条账号写进 localStorage（store 只认盘上的那份） */
const seedAccount = (patch: Partial<RemoteAccount> = {}): RemoteAccount => upsertAccount(account(patch))

/** 把一条 last-session 写进 localStorage */
const seedSession = (patch: Partial<LastSession> = {}): LastSession => {
  const saved = writeLastSession(session(patch))
  if (saved === null) {
    throw new Error('seedSession：写入失败')
  }
  return saved
}

/* ── 全局 fetch 桩：让「真实 store 流程」也能确定性地失败 / 数请求 ─────── */

interface FetchStub {
  calls: number
  paths: string[]
  restore: () => void
}

/**
 * 替换 `globalThis.fetch`。
 *
 * store 走的是 `serverApi` 的默认 fetch（不做依赖注入），所以这里只能换全局的；`reply` 返回
 * `null` 表示「像断网一样抛」，用来钉住「失败不弹错」那条分支。
 */
const stubFetch = (reply: (url: string) => Response | null): FetchStub => {
  const original = globalThis.fetch
  const state: FetchStub = {
    calls: 0,
    paths: [],
    restore: () => {
      globalThis.fetch = original
    },
  }
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    state.calls += 1
    state.paths.push(url)
    const response = reply(url)
    if (response === null) {
      throw new TypeError(`fetch failed: ${url}`)
    }
    return response
  }) as typeof fetch
  return state
}

/** 壳环境标记（`isNativeShell()` 读的是调用时的全局对象） */
const enterShell = (): void => {
  ;(globalThis as unknown as Record<string, unknown>).window = { __DS_NATIVE__: {} }
}

const leaveShell = (): void => {
  delete (globalThis as unknown as Record<string, unknown>).window
}

/* ── store（必须在 localStorage 装好之后再加载） ─────────────────────── */

const storeModule = await import('../store.js')
const { useRemoteStore, describeRemoteRecovery } = storeModule

/** 把 store 复位成「刚启动」的样子（相位 / 错误 / 自动恢复状态） */
const resetStore = (): void => {
  useRemoteStore.setState({
    phase: 'idle',
    error: null,
    transport: null,
    streaming: false,
    autoConnect: { state: 'idle' },
    lastSession: null,
  })
}

/* ══════════════════════════════════════════════════════════════════════
 * A. last-session 持久化
 * ══════════════════════════════════════════════════════════════════════ */

check('last-session 写入 / 读回：字段齐全且不含任何 token', async () => {
  resetStorage()
  const saved = seedSession()
  assertEqual(saved.serverUrl, BASE, 'serverUrl')
  assertEqual(saved.hostDeviceId, session().hostDeviceId, 'hostDeviceId')
  const read = readLastSession()
  assertEqual(read?.email, EMAIL, 'email')
  assertEqual(read?.capabilities, ['harness.remote.v3'], 'capabilities')
  assertEqual(read?.transport, 'relay', 'transport')

  const dump = storageDump()
  assertAbsent(dump, ACCESS_TOKEN, 'last-session 落盘内容')
  assertAbsent(dump, REFRESH_TOKEN, 'last-session 落盘内容')
  assertAbsent(dump, 'accessToken', 'last-session 落盘内容')
  assertAbsent(describeLastSession(read), ACCESS_TOKEN, 'describeLastSession')
  assertContains(storage.getItem(LAST_SESSION_STORAGE_KEY) ?? '', 'hostDeviceId', '键名写对了')
})

check('last-session 坏数据：坏 JSON / 缺字段都当没有，并把键删掉', async () => {
  resetStorage()
  storage.setItem(LAST_SESSION_STORAGE_KEY, '{ 这不是 json')
  assertEqual(readLastSession(), null, '坏 JSON')
  assertEqual(storage.getItem(LAST_SESSION_STORAGE_KEY), null, '坏 JSON 的键被删掉')

  // 缺 hostDeviceId：结构校验不过
  storage.setItem(LAST_SESSION_STORAGE_KEY, JSON.stringify({ serverUrl: BASE, email: EMAIL, savedAt: NOW }))
  assertEqual(readLastSession(), null, '缺字段')
  assertEqual(storage.getItem(LAST_SESSION_STORAGE_KEY), null, '缺字段的键被删掉')

  // savedAt 非法
  storage.setItem(LAST_SESSION_STORAGE_KEY, JSON.stringify({ ...session(), savedAt: 'now' }))
  assertEqual(readLastSession(), null, 'savedAt 非法')

  clearLastSession()
  assertEqual(storage.getItem(LAST_SESSION_STORAGE_KEY), null, 'clearLastSession')
})

check('last-session 能力清单：非字符串条目丢掉，空清单不落字段', async () => {
  resetStorage()
  const saved = writeLastSession({
    ...session(),
    capabilities: ['harness.remote.v3', 42 as unknown as string, '', 'x'],
  })
  assertEqual(saved?.capabilities, ['harness.remote.v3', 'x'], '过滤非字符串与空串')

  const empty = writeLastSession({ ...session(), capabilities: [] })
  assertEqual(empty?.capabilities, undefined, '空清单不写这个字段')
  assertAbsent(storage.getItem(LAST_SESSION_STORAGE_KEY) ?? '', 'capabilities', '空清单不落盘')
})

check('到期时间：秒 / 毫秒都认，提前量生效，缺失一律「不知道」', async () => {
  assertEqual(toEpochMs(1_786_000_000), 1_786_000_000_000, '秒 → 毫秒')
  assertEqual(toEpochMs(NOW), NOW, '毫秒原样')
  assertEqual(toEpochMs(undefined), undefined, '缺失')
  assertEqual(toEpochMs(0), undefined, '0 视为非法')

  assertEqual(isExpiredAt(undefined, NOW), false, '不知道就不算过期')
  assertEqual(isExpiredAt(NOW + 1_000, NOW), false, '还没到期')
  assertEqual(isExpiredAt(NOW - 1_000, NOW), true, '已到期')
  assertEqual(isExpiredAt(NOW + 30_000, NOW, ACCESS_TOKEN_REFRESH_SKEW_MS), true, '提前量内算过期')
  assertEqual(isExpiredAt(NOW + 3_600_000, NOW, ACCESS_TOKEN_REFRESH_SKEW_MS), false, '远离到期点')
})

check('planAutoConnect：无记录 / 账号没了 / 没注册设备 三种「不连」', async () => {
  assertEqual(planAutoConnect(null, [], NOW), { kind: 'none', reason: 'no-session' }, '没有记录')

  const noAccount = planAutoConnect(session(), [], NOW)
  assertEqual(noAccount.kind === 'none' ? noAccount.reason : noAccount.kind, 'no-account', '账号记录不在')

  const half = planAutoConnect(session(), [account({ scope: 'account', deviceId: '' })], NOW)
  assertEqual(half.kind === 'none' ? half.reason : half.kind, 'account-incomplete', '还没注册设备')

  const noToken = planAutoConnect(session(), [account({ accessToken: '' })], NOW)
  assertEqual(noToken.kind === 'none' ? noToken.reason : noToken.kind, 'account-incomplete', '没有 access token')
})

check('planAutoConnect：refresh 过期 / 需要刷新 / 直接连 / 没 refresh 又过期', async () => {
  const expired = planAutoConnect(session(), [account({ refreshTokenExpiresAt: NOW - 1 })], NOW)
  assertEqual(expired.kind, 'expired', 'refresh token 过期')
  assertEqual(expired.kind === 'expired' ? expired.reason : '', 'refresh-token-expired', '原因')

  const needRefresh = planAutoConnect(session(), [account({ accessTokenExpiresAt: NOW + 30_000 })], NOW)
  assertEqual(needRefresh.kind, 'connect', 'access 快到期的仍然要连')
  assertEqual(needRefresh.kind === 'connect' ? needRefresh.refresh : null, true, '先刷新再连')

  const valid = planAutoConnect(session(), [account()], NOW)
  assertEqual(valid.kind === 'connect' ? valid.refresh : null, false, 'token 有效直接连')

  const noRefreshToken = planAutoConnect(
    session(),
    [account({ accessTokenExpiresAt: NOW - 1, refreshToken: '' })],
    NOW,
  )
  assertEqual(noRefreshToken.kind, 'expired', '没有 refresh token 又过期')
  assertEqual(
    noRefreshToken.kind === 'expired' ? noRefreshToken.reason : '',
    'no-refresh-token',
    '原因',
  )

  // 账号与 last-session 的服务器 / 邮箱必须完全对上（换服务器等于换一套账号体系）
  const otherServer = planAutoConnect(session(), [account({ serverUrl: 'https://other.example' })], NOW)
  assertEqual(otherServer.kind === 'none' ? otherServer.reason : otherServer.kind, 'no-account', '服务器对不上')
})

/* ══════════════════════════════════════════════════════════════════════
 * B. 自动连接的真实分支（store 级）
 * ══════════════════════════════════════════════════════════════════════ */

check('autoConnect：没有 last-session 时一个请求都不打', async () => {
  resetStorage()
  resetStore()
  enterShell()
  const stub = stubFetch(() => null)
  try {
    await useRemoteStore.getState().retryAutoConnect()
    assertEqual(stub.calls, 0, '没有记录就不该发请求')
    assertEqual(useRemoteStore.getState().autoConnect.state, 'idle', '状态保持 idle')
    assertEqual(useRemoteStore.getState().phase, 'idle', '相位不变')
  } finally {
    stub.restore()
    leaveShell()
  }
})

check('autoConnect：账号凭据已经不在了 → 只报「要重新登录」，不删 last-session（R10 改）', async () => {
  resetStorage()
  resetStore()
  // 只有 last-session，没有账号（用户清了数据 / 换了账号）
  seedSession()
  enterShell()
  const stub = stubFetch(() => null)
  try {
    await useRemoteStore.getState().retryAutoConnect()
    assertEqual(stub.calls, 0, '账号都没了就不该打网络')
    // R10：铁律是「异步失败不删凭据」。以前这里会 clearLastSession()，
    // 结果是用户重新登录之后连「上次连的是哪台 Host」都没了（真机反馈的「莫名其妙」）。
    assertEqual(readLastSession() === null, false, 'last-session 必须留着（登录后还能连回同一台）')
    assertEqual(useRemoteStore.getState().autoConnect.state, 'failed', '要告诉用户得重新登录')
    assertEqual(useRemoteStore.getState().autoConnect.code, 'SESSION_EXPIRED', '失败码')
    assertEqual(useRemoteStore.getState().reconnect.status, 'need-login', '自愈状态')
  } finally {
    stub.restore()
    leaveShell()
  }
})

check('autoConnect：连不上时只落 failed，不写 error、不清 last-session（可重试）', async () => {
  resetStorage()
  resetStore()
  seedAccount()
  seedSession()
  enterShell()
  // 连不上（/__ds_proxy 直接失败）：serverApi 折成 NETWORK_ERROR
  const stub = stubFetch(() => null)
  try {
    await useRemoteStore.getState().retryAutoConnect()
    const state = useRemoteStore.getState()
    assertEqual(state.autoConnect.state, 'failed', '自动恢复失败')
    assertTrue(state.autoConnect.code !== 'SESSION_EXPIRED', `失败码不该是过期：${state.autoConnect.code}`)
    assertEqual(state.error, null, '失败不弹错（不写 state.error）')
    assertEqual(state.phase, 'idle', '相位回到 idle，而不是 error')
    assertEqual(readLastSession() === null, false, 'last-session 留着，等用户点重试')
    assertEqual(loadAccounts().length, 1, '账号凭据不能被动清掉')
    assertTrue(stub.calls > 0, '确实尝试过连接')
    assertContains(describeRemoteRecovery(), 'failed', '诊断摘要')
  } finally {
    stub.restore()
    leaveShell()
  }
})

check('autoConnect：refresh token 过期 → SESSION_EXPIRED，但 last-session / 邮箱都留着（R10 改）', async () => {
  resetStorage()
  resetStore()
  seedAccount({ refreshTokenExpiresAt: NOW - 1, accessTokenExpiresAt: NOW - 1 })
  seedSession()
  enterShell()
  const stub = stubFetch(() => null)
  try {
    await useRemoteStore.getState().retryAutoConnect()
    const state = useRemoteStore.getState()
    assertEqual(state.autoConnect.state, 'failed', 'failed')
    assertEqual(state.autoConnect.code, 'SESSION_EXPIRED', '失败码')
    // R10：凭据确实不能用了，但**删记录**不是我们的活 —— 只有用户点「退出登录」才清。
    // 留着才有「重新登录之后连回上次那台 Host」的可能。
    assertEqual(readLastSession() === null, false, 'last-session 留着')
    assertEqual(state.reconnect.status, 'need-login', '自愈状态：需要人处理')
    assertEqual(stub.calls, 0, '凭据已经过期，不该再打网络')
    const accounts = loadAccounts()
    assertEqual(accounts.length, 1, '账号还在（只是要重新登录）')
    assertEqual(accounts[0]?.email, EMAIL, '邮箱保留给登录表单预填')
  } finally {
    stub.restore()
    leaveShell()
  }
})

check('autoConnect：设置页与远程页都能挂（幂等单飞，不会并发打两次）', async () => {
  resetStorage()
  resetStore()
  seedAccount()
  seedSession()
  enterShell()
  const stub = stubFetch(() => null)
  try {
    // `retryAutoConnect()` 是「用户点重试」那条入口（清掉「本进程已试过」再跑一次），
    // 第二个调用进来时应该**加入**同一条在飞流程，而不是再起一条。
    const first = useRemoteStore.getState().retryAutoConnect()
    const second = useRemoteStore.getState().autoConnectNow()
    await Promise.all([first, second])
    const state = useRemoteStore.getState()
    assertEqual(state.autoConnect.state, 'failed', '两次调用只跑一条流程')
    // 第一次建链尝试只打一次 /__ds_proxy（失败即止），而不是两条并行流程各打一次
    const proxyCalls = stub.paths.filter((path) => path === '/__ds_proxy').length
    assertEqual(proxyCalls, 1, `只允许一次建链尝试，实际 ${proxyCalls}`)
  } finally {
    stub.restore()
    leaveShell()
  }
})

check('disconnect 不清 last-session/账号；signOut 两样都清', async () => {
  resetStorage()
  resetStore()
  seedAccount()
  seedSession()
  const stub = stubFetch(() => null)
  try {
    useRemoteStore.setState({ phase: 'ready', lastSession: readLastSession() })

    useRemoteStore.getState().disconnect()
    assertEqual(readLastSession() === null, false, '临时断开保留 last-session')
    assertEqual(loadAccounts().length, 1, '临时断开保留账号')
    assertEqual(useRemoteStore.getState().phase, 'idle', '相位复位')
    assertEqual(
      useRemoteStore.getState().lastSession?.email,
      EMAIL,
      '设置页仍能显示「上次连接的账号」',
    )

    useRemoteStore.getState().signOut()
    assertEqual(readLastSession(), null, '退出登录清 last-session')
    assertEqual(loadAccounts().length, 0, '退出登录删掉本机凭据')
    assertEqual(storage.getItem(ACCOUNT_STORAGE_KEY), JSON.stringify({ v: 1, items: [] }), '账号表清空')
  } finally {
    stub.restore()
  }
})

/* ══════════════════════════════════════════════════════════════════════
 * C. 权限中心（旧 APK 兼容 + 请求形状）
 * ══════════════════════════════════════════════════════════════════════ */

const webFetch =
  (reply: (path: string, init: RequestInit) => { status?: number; body?: unknown; raw?: string }): FetchLike =>
  async (path, init) => {
    const result = reply(path, init)
    const text = result.raw ?? (result.body === undefined ? '' : JSON.stringify(result.body))
    return new Response(text, {
      status: result.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

check('权限快照：404 / HTML 200 / ok:false 一律「不支持」（整节不显示）', async () => {
  const missing = await probePermissions({ fetch: webFetch(() => ({ status: 404, raw: 'Not Found' })) })
  assertEqual(missing, null, '404')

  // 旧 APK：未知路径被静态兜底成 index.html，而且回 200
  const html = await probePermissions({
    fetch: webFetch(() => ({ status: 200, raw: '<!doctype html><html><body>App</body></html>' })),
  })
  assertEqual(html, null, 'HTML 200')

  const notOk = await probePermissions({ fetch: webFetch(() => ({ body: { ok: false, error: 'disabled' } })) })
  assertEqual(notOk, null, 'ok:false')

  const noOk = await probePermissions({ fetch: webFetch(() => ({ body: { notifications: { granted: true } } })) })
  assertEqual(noOk, null, '没有 ok 布尔')

  const offline = await probePermissions({
    fetch: async () => {
      throw new TypeError('fetch failed')
    },
  })
  assertEqual(offline, null, '连不上')
})

check('权限快照：逐字段解析，缺字段取安全默认值', async () => {
  // 真实响应形状（M1 报告的 Android 14 + 小米样例，含顶层镜像字段）
  const full = await probePermissions({
    fetch: webFetch((path) => {
      assertEqual(path, PERMISSIONS_PATH, '探测路径')
      return {
        body: {
          ok: true,
          sdkInt: 34,
          notifications: { granted: false, canRequest: true, channelBlocked: true, declared: true },
          foregroundService: { running: true, shouldRun: true },
          battery: { exempt: false, ignored: false, declared: true },
          exactAlarm: { needed: true, granted: false, declared: false },
          overlay: { granted: false, declared: false },
          autoStart: { vendor: 'xiaomi', intentAvailable: true, manufacturer: 'Xiaomi' },
          appDetails: { intentAvailable: true },
          residentNotification: { enabled: false, canHide: false },
          running: true,
          shouldRun: true,
          notificationsGranted: false,
          batteryExempt: false,
        },
      }
    }),
  })
  assertEqual(full?.sdkInt, 34, 'sdkInt')
  assertEqual(
    full?.notifications,
    { granted: false, canRequest: true, channelBlocked: true, declared: true },
    'notifications',
  )
  assertEqual(full?.foregroundService, { running: true, shouldRun: true }, 'foregroundService')
  assertEqual(full?.battery, { exempt: false, ignored: false, declared: true }, 'battery')
  assertEqual(full?.exactAlarm, { granted: false, needed: true, declared: false }, 'exactAlarm')
  assertEqual(full?.overlay, { granted: false, declared: false }, 'overlay')
  assertEqual(full?.autoStart, { vendor: 'xiaomi', manufacturer: 'Xiaomi', intentAvailable: true }, 'autoStart')
  assertEqual(full?.residentNotification, { enabled: false, canHide: false }, 'residentNotification')

  const sparse = await probePermissions({ fetch: webFetch(() => ({ body: { ok: true } })) })
  assertEqual(
    sparse?.notifications,
    { granted: false, canRequest: false, channelBlocked: false, declared: true },
    'notifications：核心行缺省可见、状态取未授予',
  )
  assertEqual(sparse?.battery, { exempt: false, ignored: false, declared: true }, 'battery 默认可见、未豁免')
  // declared 缺省 false：界面据此**不显示**这一行（本 App 没申请那个权限）
  assertEqual(sparse?.exactAlarm, { granted: false, needed: false, declared: false }, 'exactAlarm 默认未声明')
  assertEqual(sparse?.overlay, { granted: false, declared: false }, 'overlay 默认未声明')
  assertEqual(
    sparse?.autoStart,
    { vendor: '', manufacturer: '', intentAvailable: false },
    'autoStart 默认只能开应用详情',
  )
  assertEqual(sparse?.residentNotification, { enabled: false, canHide: false }, 'residentNotification 默认关不掉')
  assertEqual(sparse?.sdkInt, undefined, '没有 sdkInt 就不写')

  // 顶层镜像字段（与 /state 同名同义）在嵌套组缺失时兜底
  const mirrored = await probePermissions({
    fetch: webFetch(() => ({
      body: { ok: true, running: true, shouldRun: true, notificationsGranted: true, batteryExempt: true },
    })),
  })
  assertEqual(mirrored?.foregroundService, { running: true, shouldRun: true }, '顶层 running/shouldRun 兜底')
  assertEqual(mirrored?.notifications.granted, true, '顶层 notificationsGranted 兜底')
  assertEqual(mirrored?.battery.exempt, true, '顶层 batteryExempt 兜底')

  // 非布尔值不许被当成 true
  assertEqual(
    parsePermissions({ ok: true, notifications: { granted: 'yes', canRequest: 1, channelBlocked: 'no' } })?.notifications,
    { granted: false, canRequest: false, channelBlocked: false, declared: true },
    '非布尔值不采信',
  )
})

check('POST /open：请求形状 / 业务失败也是 200 / degraded / mode=request / HTTP 500 / 连不上', async () => {
  const seen: Array<{ path: string; body: unknown; method: string; contentType: string }> = []
  const ok = await openPermissionTarget('battery', {
    fetch: webFetch((path, init) => {
      seen.push({
        path,
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
        method: String(init.method),
        contentType: String((init.headers as Record<string, string>)['Content-Type']),
      })
      return {
        body: {
          target: 'battery',
          ok: true,
          launched: true,
          action: 'android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
          degraded: false,
        },
      }
    }),
  })
  assertEqual(
    ok,
    {
      ok: true,
      launched: true,
      degraded: false,
      action: 'android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
      target: 'battery',
    },
    'ok:true 的形状（含回显 target）',
  )
  assertEqual(seen[0]?.path, PERMISSIONS_OPEN_PATH, '路径')
  assertEqual(seen[0]?.method, 'POST', '方法')
  assertEqual(seen[0]?.body, { target: 'battery' }, '请求体')
  assertEqual(seen[0]?.contentType, 'application/json', 'Content-Type（原生的 CSRF 闸门）')

  // 原生降级：business 上算成功（打开了应用详情），但要带 degraded 让界面说明
  const degraded = await openPermissionTarget('autoStart', {
    fetch: webFetch(() => ({
      body: {
        target: 'autoStart',
        vendor: 'vivo',
        ok: true,
        launched: true,
        action: 'android.settings.APPLICATION_DETAILS_SETTINGS',
        degraded: true,
        fallback: 'appDetails',
      },
    })),
  })
  assertEqual(degraded.ok, true, '降级仍算成功')
  assertEqual(degraded.degraded, true, 'degraded')
  assertEqual(degraded.action, 'android.settings.APPLICATION_DETAILS_SETTINGS', 'action 原样带回')
  assertEqual(degraded.vendor, 'vivo', 'vendor 带回（自启动排障要用）')

  // **业务失败也是 HTTP 200**：必须读 ok / fallback，不能只看状态码
  const business = await openPermissionTarget('autoStart', {
    fetch: webFetch(() => ({
      status: 200,
      body: { target: 'autoStart', vendor: 'vivo', ok: false, launched: false, error: 'intent_unavailable', fallback: 'appDetails' },
    })),
  })
  assertEqual(
    business,
    {
      ok: false,
      launched: false,
      error: 'intent_unavailable',
      degraded: false,
      fallback: 'appDetails',
      target: 'autoStart',
      vendor: 'vivo',
    },
    'HTTP 200 + ok:false',
  )

  // `mode:'request'`：请求体多一个 mode，响应带 mode:'request'（弹窗真弹了）
  const requested = await openPermissionTarget('notifications', {
    fetch: webFetch((_path, init) => {
      assertEqual(
        init.body === undefined ? undefined : JSON.parse(String(init.body)),
        { target: 'notifications', mode: 'request' },
        'mode=request 的请求体',
      )
      return { body: { target: 'notifications', ok: true, launched: true, mode: 'request' } }
    }),
  }, { mode: 'request' })
  assertEqual(requested.mode, 'request', '弹窗真弹了')
  assertEqual(requested.ok, true, 'ok')

  // 弹不了 → 原生退回设置页，并标 requestUnavailable
  const fallbackToSettings = await requestNotificationPermission({
    fetch: webFetch(() => ({
      body: {
        target: 'notifications',
        ok: true,
        launched: true,
        mode: 'settings',
        requestUnavailable: true,
        action: 'android.settings.APP_NOTIFICATION_SETTINGS',
      },
    })),
  })
  assertEqual(fallbackToSettings.requestUnavailable, true, 'requestUnavailable')
  assertEqual(fallbackToSettings.mode, 'settings', '退回设置页')

  // exactAlarm 在 Android 11 及以下：notNeeded
  const notNeeded = await openPermissionTarget('exactAlarm', {
    fetch: webFetch(() => ({ body: { target: 'exactAlarm', ok: true, launched: false, notNeeded: true } })),
  })
  assertEqual(notNeeded.notNeeded, true, 'notNeeded')
  assertEqual(notNeeded.launched, false, '没跳页')

  // fallback 只认契约里的取值，别让被篡改的响应把用户带去任意 target
  const bogus = await openPermissionTarget('autoStart', {
    fetch: webFetch(() => ({ body: { ok: false, error: 'intent_unavailable', fallback: 'settings://evil' } })),
  })
  assertEqual(
    bogus,
    { ok: false, launched: false, error: 'intent_unavailable', degraded: false },
    '非白名单 fallback 丢掉',
  )

  const http500 = await openPermissionTarget('notifications', {
    fetch: webFetch(() => ({ status: 500, body: { ok: false } })),
  })
  assertEqual(http500.ok, false, 'HTTP 500')
  assertEqual(http500.error, 'http_500', '错误码')

  const offline = await openPermissionTarget('notifications', {
    fetch: async () => {
      throw new TypeError('fetch failed')
    },
  })
  assertEqual(offline, { ok: false, launched: false, degraded: false, error: 'bridge_unavailable' }, '连不上')
})

check('dataUsage 也在契约的 target 白名单里（原生给了 7 个）', async () => {
  const seen: unknown[] = []
  const result = await openPermissionTarget('dataUsage', {
    fetch: webFetch((_path, init) => {
      seen.push(init.body === undefined ? undefined : JSON.parse(String(init.body)))
      return { body: { ok: true, launched: true, action: 'data_usage' } }
    }),
  })
  assertEqual(result.ok, true, 'dataUsage 可以打开')
  assertEqual(seen, [{ target: 'dataUsage' }], '请求体')
})

check('POST /notify：请求体是 {enabled:boolean}', async () => {
  const bodies: unknown[] = []
  const ok = await setNotificationsEnabled(true, {
    fetch: webFetch((path, init) => {
      assertEqual(path, KEEPALIVE_NOTIFY_PATH, '路径')
      bodies.push(init.body === undefined ? undefined : JSON.parse(String(init.body)))
      return { body: { ok: true } }
    }),
  })
  assertEqual(ok, true, 'ok:true')
  assertEqual(bodies, [{ enabled: true }], '请求体')

  const rejected = await setNotificationsEnabled(false, {
    fetch: webFetch(() => ({ body: { ok: false } })),
  })
  assertEqual(rejected, false, 'ok:false → false')
})

check('权限模块永不抛：probe / open / notify 在断网时都只返回降级值', async () => {
  const boom: FetchLike = async () => {
    throw new RemoteApiError('NETWORK_ERROR', 'boom', undefined, true)
  }
  assertEqual(await probePermissions({ fetch: boom }), null, 'probe')
  assertEqual((await openPermissionTarget('overlay', { fetch: boom })).ok, false, 'open')
  assertEqual(await setNotificationsEnabled(true, { fetch: boom }), false, 'notify')
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
  // 红了必须真的红（仓库约定：检查脚本必须设置退出码）
  process.exit(failures === 0 ? 0 : 1)
}

await main()
