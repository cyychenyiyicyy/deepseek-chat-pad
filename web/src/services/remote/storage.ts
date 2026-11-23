/**
 * Chat Pad 远程 DSH：服务器 / 账号 / token 的持久化。
 *
 * 为什么 token 只在这一处：
 *   - 协议要求 refresh 后**原子替换**本地 token，且不得进日志、URL、query
 *     （docs/protocol.md §8.2、§10.3）；散落几处读写必然出现「半新半旧」。
 *   - 集成层（设置页 / UI）只拿 `RemoteAccount` 对象，不直接碰 localStorage。
 *
 * localStorage 键（全部带版本后缀，将来改结构不炸旧数据）：
 *   dsp.remote.servers.v1       服务器列表        { v, items: RemoteServer[] }
 *   dsp.remote.accounts.v1      账号 + 设备 token  { v, items: RemoteAccount[] }
 *   dsp.remote.pinned-hosts.v1  Host 公钥 pin     { v, servers: { [url]: PinnedHost[] } }
 *
 * 为什么要 pin 公钥（docs/protocol.md §9、plugin-integration.md:260）：
 *   同一 deviceId 的 identityKey 变了必须**拒绝覆盖并拒绝连接**，所以 pin 只在首次
 *   见到该 Host 时写入，之后只做比对；pin 按服务器分组，换服务器不会串味。
 *
 * 与契约（plan-P0P1-实施契约.md §4）的关系：
 *   `RemoteServer` / `RemoteAccount` 的必填字段与契约完全一致；这里的额外字段全部
 *   optional，只会更宽松，不会让按契约写的代码无法赋值。
 */

export interface RemoteServer {
  /** 归一化后的服务器地址，例如 `https://dsh.r2049.cn`（不含尾部斜杠 / query） */
  url: string
  /** 给用户看的名字；缺省用 host */
  label?: string
  lastUsedAt?: number
}

/**
 * 登录方式（多方式登录的唯一分类口径）：
 *   `password` 邮箱密码 / `oauth` 浏览器跳转 OAuth / `qr` 手机扫码。
 *
 * 只用于展示与排障（设置页写「上次用的是哪种方式」）；凭据类型不随它变 ——
 * 三种方式最终都换回同一种「设备 token pair」。
 */
export type LoginMethod = 'password' | 'oauth' | 'qr' | 'pairing'

export interface RemoteAccount {
  email: string
  /**
   * 设备 access token。
   * 注意：`scope === 'account'` 阶段这里是**站点账号 token**（只用于注册设备），
   * 注册成功后会被设备 token pair 覆盖。字段名沿用契约，没有第二个 accessToken。
   */
  accessToken: string
  /** 设备 refresh token；`scope === 'account'` 阶段为空串（账号 token 没有 refresh，见 docs/plugin-integration.md:139） */
  refreshToken: string
  /** 已注册的设备 ID；`scope === 'account'` 阶段为空串 */
  deviceId: string
  /** 账号 token（未注册设备）还是设备 token（已注册）；缺省按 device 处理 */
  scope?: 'account' | 'device'
  serverUrl?: string
  accessTokenExpiresAt?: number
  refreshTokenExpiresAt?: number
  /** 注册时用的设备名，便于设置页显示 */
  deviceName?: string
  /**
   * [附加字段] 这条记录是怎么登进来的（`password` / `oauth` / `qr`）。
   * 可选：老数据没有它，读出来照样可用；三类凭据本身没有区别。
   */
  loginMethod?: LoginMethod
  updatedAt?: number
}

export interface PinnedHost {
  deviceId: string
  identityKey: string
  name?: string
  pinnedAt: number
}

export const SERVER_STORAGE_KEY = 'dsp.remote.servers.v1'
export const ACCOUNT_STORAGE_KEY = 'dsp.remote.accounts.v1'
export const PINNED_HOST_STORAGE_KEY = 'dsp.remote.pinned-hosts.v1'
const ADAPTIVE_TRANSPORT_KEY = 'dsp.remote.adaptive-transport.v1'
const COMPACT_HISTORY_KEY = 'dsp.remote.compact-history.v1'

interface ListEnvelope<T> {
  v: number
  items: T[]
}

interface PinEnvelope {
  v: number
  servers: Record<string, PinnedHost[]>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * localStorage 不可用（隐私模式 / 配额满 / 非浏览器环境）时返回 null，
 * 上层一律降级成「本次会话内有效」，不抛异常。
 */
const store = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export function loadAdaptiveTransport(): boolean {
  try { return store()?.getItem(ADAPTIVE_TRANSPORT_KEY) === 'true' } catch { return false }
}

export function saveAdaptiveTransport(enabled: boolean): boolean {
  try {
    const storage = store()
    if (!storage) return false
    storage.setItem(ADAPTIVE_TRANSPORT_KEY, String(enabled))
    return true
  } catch { return false }
}

export function loadCompactHistory(): boolean {
  try { return store()?.getItem(COMPACT_HISTORY_KEY) === 'true' } catch { return false }
}

export function saveCompactHistory(enabled: boolean): boolean {
  try {
    const storage = store()
    if (!storage) return false
    storage.setItem(COMPACT_HISTORY_KEY, String(enabled))
    return true
  } catch { return false }
}

const readItems = <T>(key: string, guard: (value: unknown) => value is T): T[] => {
  const ls = store()
  if (ls === null) return []
  try {
    const raw = ls.getItem(key)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || !Array.isArray(parsed.items)) return []
    return parsed.items.filter(guard)
  } catch {
    // 坏数据直接当空，不要让一条脏记录挡住整个连接流程
    return []
  }
}

const writeItems = <T>(key: string, items: T[]): boolean => {
  const ls = store()
  if (ls === null) return false
  const envelope: ListEnvelope<T> = { v: 1, items }
  try {
    ls.setItem(key, JSON.stringify(envelope))
    return true
  } catch {
    // 配额满：本次会话内的状态仍然可用，只是重启后丢失
    return false
  }
}

const isRemoteServer = (value: unknown): value is RemoteServer =>
  isRecord(value) && typeof value.url === 'string' && value.url.length > 0

const isRemoteAccount = (value: unknown): value is RemoteAccount =>
  isRecord(value) &&
  typeof value.email === 'string' &&
  typeof value.accessToken === 'string' &&
  typeof value.refreshToken === 'string' &&
  typeof value.deviceId === 'string'

const isPinnedHost = (value: unknown): value is PinnedHost =>
  isRecord(value) &&
  typeof value.deviceId === 'string' &&
  typeof value.identityKey === 'string' &&
  typeof value.pinnedAt === 'number'

/* ── 服务器 ───────────────────────────────────────────────────────────── */

export const loadServers = (): RemoteServer[] => readItems(SERVER_STORAGE_KEY, isRemoteServer)

export const saveServers = (servers: RemoteServer[]): boolean => writeItems(SERVER_STORAGE_KEY, servers)

/** 插入或更新一台服务器；返回落盘后的列表（最新的在最前）。 */
export const upsertServer = (url: string, patch: Omit<RemoteServer, 'url'> = {}): RemoteServer[] => {
  const next = loadServers()
  const index = next.findIndex((item) => item.url === url)
  const merged: RemoteServer = { ...(index >= 0 ? next[index] : { url }), url, ...patch }
  const without = next.filter((item) => item.url !== url)
  saveServers([merged, ...without])
  return [merged, ...without]
}

export const removeServer = (url: string): RemoteServer[] => {
  const next = loadServers().filter((item) => item.url !== url)
  saveServers(next)
  return next
}

/* ── 账号 ─────────────────────────────────────────────────────────────── */

/** 账号主键：同服务器 + 同邮箱算一条（换服务器等于换一套账号体系） */
export const accountKey = (account: Pick<RemoteAccount, 'email' | 'serverUrl'>): string =>
  `${account.serverUrl ?? ''}|${account.email}`

export const loadAccounts = (): RemoteAccount[] => readItems(ACCOUNT_STORAGE_KEY, isRemoteAccount)

export const saveAccounts = (accounts: RemoteAccount[]): boolean => writeItems(ACCOUNT_STORAGE_KEY, accounts)

export const findAccount = (serverUrl: string, email: string): RemoteAccount | null =>
  loadAccounts().find((item) => item.serverUrl === serverUrl && item.email === email) ?? null

/** 落盘一条账号（会打 updatedAt）；返回实际写入的对象 */
export const upsertAccount = (account: RemoteAccount): RemoteAccount => {
  const stamped: RemoteAccount = { ...account, updatedAt: Date.now() }
  const without = loadAccounts().filter((item) => accountKey(item) !== accountKey(account))
  saveAccounts([stamped, ...without])
  return stamped
}

export const removeAccount = (serverUrl: string, email: string): RemoteAccount[] => {
  const next = loadAccounts().filter((item) => !(item.serverUrl === serverUrl && item.email === email))
  saveAccounts(next)
  return next
}

/** 注销 / 换账号：三份数据一起清，避免留下用不了的 token */
export const clearRemoteStorage = (): void => {
  const ls = store()
  if (ls === null) return
  try {
    ls.removeItem(SERVER_STORAGE_KEY)
    ls.removeItem(ACCOUNT_STORAGE_KEY)
    ls.removeItem(PINNED_HOST_STORAGE_KEY)
  } catch {
    // 忽略：清不掉也不影响当前会话
  }
}

/* ── Host 公钥 pin（按服务器分组） ────────────────────────────────────── */

const readPinEnvelope = (): PinEnvelope => {
  const ls = store()
  if (ls === null) return { v: 1, servers: {} }
  try {
    const raw = ls.getItem(PINNED_HOST_STORAGE_KEY)
    if (raw === null) return { v: 1, servers: {} }
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || !isRecord(parsed.servers)) return { v: 1, servers: {} }
    const servers: Record<string, PinnedHost[]> = {}
    for (const [url, items] of Object.entries(parsed.servers)) {
      if (Array.isArray(items)) servers[url] = items.filter(isPinnedHost)
    }
    return { v: 1, servers }
  } catch {
    return { v: 1, servers: {} }
  }
}

const writePinEnvelope = (envelope: PinEnvelope): void => {
  const ls = store()
  if (ls === null) return
  try {
    ls.setItem(PINNED_HOST_STORAGE_KEY, JSON.stringify(envelope))
  } catch {
    // 配额满：本次会话内仍然生效
  }
}

/** 某台服务器下已 pin 的 Host（服务器地址已归一化，调用方需先归一化） */
export const loadPinnedHosts = (serverUrl: string): PinnedHost[] => readPinEnvelope().servers[serverUrl] ?? []

export const findPinnedHost = (serverUrl: string, deviceId: string): PinnedHost | null =>
  loadPinnedHosts(serverUrl).find((item) => item.deviceId === deviceId) ?? null

export type PinResult =
  | { state: 'pinned' }
  | { state: 'unchanged' }
  | { state: 'mismatch'; stored: string }

/**
 * 首次见到某个 Host 的公钥就 pin 住；之后只比对，不一致**绝不覆盖**
 * （docs/protocol.md §9：同 deviceId 换 key 必须拒绝连接）。
 */
export const pinHostIdentityKey = (
  serverUrl: string,
  host: { deviceId: string; identityKey: string; name?: string },
): PinResult => {
  const envelope = readPinEnvelope()
  const items = envelope.servers[serverUrl] ?? []
  const existing = items.find((item) => item.deviceId === host.deviceId)
  if (existing !== undefined) {
    return existing.identityKey === host.identityKey
      ? { state: 'unchanged' }
      : { state: 'mismatch', stored: existing.identityKey }
  }
  envelope.servers[serverUrl] = [
    ...items,
    { deviceId: host.deviceId, identityKey: host.identityKey, name: host.name, pinnedAt: Date.now() },
  ]
  writePinEnvelope(envelope)
  return { state: 'pinned' }
}

export const forgetPinnedHost = (serverUrl: string, deviceId: string): void => {
  const envelope = readPinEnvelope()
  const items = envelope.servers[serverUrl]
  if (items === undefined) return
  envelope.servers[serverUrl] = items.filter((item) => item.deviceId !== deviceId)
  writePinEnvelope(envelope)
}

/** 安全摘要：**只**给日志 / 诊断用，永远不含 token —— 唯一允许外传的账号表示 */
export const describeAccount = (
  account: Pick<RemoteAccount, 'email' | 'serverUrl' | 'deviceId' | 'scope'>,
): string => {
  const scope = account.scope ?? 'device'
  const device = account.deviceId ? account.deviceId.slice(0, 8) : '-'
  return `${account.email}@${account.serverUrl ?? '-'}#${device}(${scope})`
}
