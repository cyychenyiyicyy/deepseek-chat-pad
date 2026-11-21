/**
 * Chat Pad 远程 DSH：账号 → 设备 → Host 发现 → 控制面连接 的状态机。
 *
 * 分层与归属（plan-P0P1-实施契约.md §3/§4）：
 *   S1 原生桥   页面 `ws://127.0.0.1:<port>/__ds_remote/ws` + `{type:"connect",url,headers}`
 *   S2 传输核   `createSecureLink()`：hello / connect.request / secure.handshake(Noise) /
 *               分片重组 / requestId 关联 / ping-pong 心跳（契约 §3 明确归 S2）
 *   S3 **本文件** REST 账号与设备、Host 发现与公钥 pin、控制面阶段与状态广播，
 *               以及安全通道建立后的能力探测（harness.transport.describe）
 *
 * 逐帧时序见 `docs/protocol.md` §10.3（hello/hello.ack）、§11（connect.request /
 * connect.accepted / transport.selected）、§12.2（secure.handshake step1/2）、§17（能力协商）。
 * 本文件只在 S2 的 `SecureLink` 之上做编排，**不自己发控制帧、不自己实现传输**。
 */

import { MAX_REMOTE_CAPABILITY_ENTRIES } from '../../vendor/dsh-remote/protocol/index.js'

import { DEFAULT_PLATFORM, deviceDescriptor, loadOrCreateIdentity, type DeviceIdentity } from './identity.js'
import {
  RemoteApiError,
  accountMe,
  getDevice,
  getPresence,
  listDevices,
  login as loginApi,
  needsReauth,
  normalizeServerUrl,
  registerDevice as registerDeviceApi,
  withRefreshRetry,
  type ServerApiDeps,
  type ServerDeviceRecord,
} from './serverApi.js'
import {
  describeAccount,
  loadAccounts,
  pinHostIdentityKey,
  removeAccount,
  removeServer,
  upsertAccount,
  upsertServer,
  type LoginMethod,
  type RemoteAccount,
  type RemoteServer,
} from './storage.js'

/**
 * 契约 §4 的 `RemoteServer` / `RemoteAccount` 由 `storage.ts` 定义（它俩要落盘），
 * 这里按契约从 connection.ts 再导出一次，UI 只 import 这个文件即可。
 */
export type { LoginMethod, RemoteAccount, RemoteServer }

/* ── S2 接口副本（core/index.ts 就绪前的占位） ───────────────────────── */

/**
 * 与契约 §3 完全一致的 `SecureLink` 结构副本。
 *
 * 为什么要复制：S2 正在并行实现 `web/src/services/remote/core/index.ts`，
 * 直接 import 一个还不存在的模块会让 `pnpm run type` 崩掉。
 * S2 落地后把这里删掉、改成
 *   `import type { SecureLink, SecureLinkOptions } from './core/index.js'`
 * 即可 —— 本文件对它的用法只有契约里那几个成员，结构类型自动兼容。
 */
export interface SecureLink {
  readonly state: 'closed' | 'connecting' | 'open' | 'secure'
  /** 等安全通道就绪（Noise 完成 + transport.selected） */
  ready(): Promise<void>
  /** 发一帧明文 JSON（内部负责压缩 / 分片 / 加密） */
  sendFrame(frame: unknown): void
  /** 请求-响应：自动分配 requestId、超时、错误映射 */
  rpc<T = unknown>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T>
  /** 开流：返回 streamId，帧通过 onStreamEvent 回调 */
  openStream(endpoint: string, payload: unknown): Promise<{ streamId: string; close(): Promise<void> }>
  close(): void
}

/** 与契约 §3 的 `SecureLinkOptions` 一致（`buildLinkOptions` 用） */
export interface SecureLinkOptions {
  /** wss://… 控制通道，例如 `wss://dsh.r2049.cn/ws/v1/connect` */
  url: string
  /** Authorization / Origin；由 S1 桥注入（Server 把 Origin 硬绑 PUBLIC_URL，见契约 §6 风险 1） */
  headers: Record<string, string>
  device: { deviceId: string; privateKey: string; publicKey: string }
  hostDeviceId: string
  clientDeviceId: string
  connectionId?: string
  onState?: (state: 'connecting' | 'open' | 'secure' | 'closed', detail?: string) => void
  onFrame?: (frame: unknown) => void
  onStreamEvent?: (streamId: string, payload: unknown) => void
}

/* ── 对外数据形状（契约 §4） ──────────────────────────────────────────── */

export interface RemoteHost {
  deviceId: string
  name: string
  platform?: string
  online?: boolean
  identityKey?: string
  /** 附加：本机 pin 的公钥与服务器返回的不一致（该 Host 不可连接，见 docs/protocol.md §9） */
  identityMismatch?: boolean
}

export type RemoteStatus =
  | { phase: 'idle' }
  | { phase: 'authing' }
  | { phase: 'connecting' }
  | { phase: 'handshaking' }
  | { phase: 'ready'; capabilities: string[]; transport: string }
  | { phase: 'error'; code: string; message: string }

export interface RemoteConnectResult {
  capabilities: string[]
  transport: string
}

/** 附加选项：契约里 `connect` 只有 4 个参数，这里多一个可选参数（对契约签名保持可赋值） */
export interface ConnectOptions {
  /** 明确告知实际选中的传输（来自 `transport.selected`）；缺省从 link 上读，再退回 relay */
  transport?: string
  /** 等安全通道的超时，缺省 HANDSHAKE_TIMEOUT_MS */
  timeoutMs?: number
  /** 能力探测（describe）的超时，缺省 DESCRIBE_TIMEOUT_MS */
  describeTimeoutMs?: number
  signal?: AbortSignal
}

export interface RemoteClient {
  login(server: RemoteServer, email: string, password: string): Promise<RemoteAccount>
  /**
   * [多方式登录] 用「账号 token」换取设备账号并落盘：OAuth 回调 / 扫码拿到的都是这个 token。
   *
   * 与 `login()` + `registerDevice()` 走**同一条**设备注册与持久化路径：
   * 先 `GET /api/v1/auth/me` 拿账号名（也是 token 可用性的第一道验证），再注册设备、
   * 原子写入 `storage.ts`。返回的账号 `scope` 已经是 `device`，可以直接 `listHosts`。
   */
  loginWithAccountToken(server: RemoteServer, accountToken: string, method?: LoginMethod): Promise<RemoteAccount>
  /** 契约里 name 必填；这里放宽为可选（缺省 "Chat Pad"，仍满足契约调用方式） */
  registerDevice(server: RemoteServer, account: RemoteAccount, name?: string): Promise<RemoteAccount>
  listHosts(server: RemoteServer, account: RemoteAccount): Promise<RemoteHost[]>
  connect(
    server: RemoteServer,
    account: RemoteAccount,
    host: RemoteHost,
    link: SecureLink,
    options?: ConnectOptions,
  ): Promise<RemoteConnectResult>
  status(): RemoteStatus
  onStatus(fn: (status: RemoteStatus) => void): () => void
  /** 附加：断开并复位到 idle（不删本地凭据） */
  close(): void
  /** 附加：退出登录（清 token / pin，可留服务器记录） */
  logout(server: RemoteServer, account: RemoteAccount): Promise<void>
}

/* ── 常量 ─────────────────────────────────────────────────────────────── */

/** 控制面授权 + 传输选择 + Noise 的总等待（协议 §10.3：各阶段独立计时，这里给一个宽上限） */
const HANDSHAKE_TIMEOUT_MS = 30_000
/** `harness.transport.describe` 的等待；Host 侧同类探测预算是 5s，客户端给足余量 */
const DESCRIBE_TIMEOUT_MS = 10_000
/** 观察 link.state 的间隔：把 connecting → handshaking 的阶段切换报给 UI */
const LINK_POLL_MS = 120
/** Host presence / identityKey 的并发上限（协议 §9 允许 8，这里取 4 更保守） */
const HOST_PROBE_CONCURRENCY = 4
/** 拿不到 `transport.selected` 时的保守值：`hello.ack.capabilities` 缺失时客户端只能用 relay */
const TRANSPORT_FALLBACK = 'relay'

const CLIENT_TRANSPORTS = ['lan', 'p2p', 'turn', 'relay'] as const

/* ── 小工具 ───────────────────────────────────────────────────────────── */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const codeOf = (value: unknown): string => {
  if (value instanceof RemoteApiError) return value.code
  if (isRecord(value) && typeof value.code === 'string') return value.code
  return 'UNKNOWN_ERROR'
}

const messageOf = (value: unknown): string => {
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  return '未知错误'
}

/** 把任意异常折成统一的 RemoteApiError（控制面错误码直传，不做改写） */
const toRemoteApiError = (value: unknown, fallbackCode = 'UNKNOWN_ERROR'): RemoteApiError => {
  if (value instanceof RemoteApiError) return value
  return new RemoteApiError(codeOf(value) || fallbackCode, messageOf(value))
}

const statusKey = (status: RemoteStatus): string => {
  switch (status.phase) {
    case 'ready':
      return `ready|${status.transport}|${status.capabilities.join(',')}`
    case 'error':
      return `error|${status.code}|${status.message}`
    default:
      return status.phase
  }
}

/**
 * 并发上限内把一组元素映射成结果（顺序保持）。
 * 用于「列 Host 时逐个补 presence + identityKey」，避免几十个设备同时打满服务器。
 */
const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await run(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * 解析 `harness.transport.describe` 的返回（docs/protocol.md §17:988-1006）。
 *
 * fail-closed：`harness.remote.v1` 与 `harness.remote.v3` 互斥，两个都没有就不许往下走
 * （契约 §6 风险 5：「拿不到 harness.remote.v1|v3 就 fail-closed 报错」）。
 */
export const parseTransportDescription = (value: unknown): string[] => {
  if (!isRecord(value) || !Array.isArray(value.capabilities)) {
    throw new RemoteApiError('INVALID_MESSAGE', 'Host 返回的 harness.transport.describe 缺少 capabilities 数组')
  }
  const raw = value.capabilities as unknown[]
  if (raw.length > MAX_REMOTE_CAPABILITY_ENTRIES) {
    throw new RemoteApiError('INVALID_MESSAGE', `Host 声明的 capability 条数超上限（>${MAX_REMOTE_CAPABILITY_ENTRIES}）`, undefined, false, {
      count: raw.length,
    })
  }
  const capabilities: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') {
      throw new RemoteApiError('INVALID_MESSAGE', 'Host 返回的 capabilities 里有非字符串条目')
    }
    capabilities.push(item)
  }
  const v1 = capabilities.includes('harness.remote.v1')
  const v3 = capabilities.includes('harness.remote.v3')
  if (v1 && v3) {
    throw new RemoteApiError('INVALID_MESSAGE', 'Host 同时声明了 harness.remote.v1 与 harness.remote.v3（协议禁止，二者互斥）')
  }
  if (!v1 && !v3) {
    throw new RemoteApiError(
      'HARNESS_VERSION_INCOMPATIBLE',
      'Host 没有声明 harness.remote.v1 或 harness.remote.v3，按协议 fail-closed 拒绝连接',
      undefined,
      false,
      { capabilities },
    )
  }
  return capabilities
}

/** 从 link 上尽力取实际传输；S2 若未暴露，只能退回协议允许的保守值 relay */
const resolveTransport = (link: SecureLink, options: ConnectOptions): string => {
  if (options.transport !== undefined && options.transport.length > 0) return options.transport
  const exposed = (link as { transport?: unknown }).transport
  if (typeof exposed === 'string' && exposed.length > 0) return exposed
  return TRANSPORT_FALLBACK
}

/* ── 实现 ─────────────────────────────────────────────────────────────── */

export interface RemoteClientOptions {
  /** REST 层注入点（单测 mock fetch / 直连调试）；生产留空走 `/__ds_proxy` */
  deps?: ServerApiDeps
}

export class RemoteClientImpl implements RemoteClient {
  private current: RemoteStatus = { phase: 'idle' }
  private readonly listeners = new Set<(status: RemoteStatus) => void>()
  private readonly deps: ServerApiDeps

  constructor(options: RemoteClientOptions = {}) {
    this.deps = options.deps ?? {}
  }

  /* 状态广播 ---------------------------------------------------------- */

  status(): RemoteStatus {
    return this.snapshot()
  }

  onStatus(fn: (status: RemoteStatus) => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private snapshot(): RemoteStatus {
    const current = this.current
    if (current.phase === 'ready') {
      return { phase: 'ready', capabilities: [...current.capabilities], transport: current.transport }
    }
    return { ...current }
  }

  private setStatus(next: RemoteStatus): void {
    if (statusKey(this.current) === statusKey(next)) return
    this.current = next
    for (const listener of [...this.listeners]) {
      try {
        listener(this.snapshot())
      } catch {
        // UI 回调抛异常不能打断状态机
      }
    }
  }

  private failStatus(error: unknown): void {
    this.setStatus({ phase: 'error', code: codeOf(error), message: messageOf(error) })
  }

  /* 账号 -------------------------------------------------------------- */

  /** 登录只拿站点账号 token：它**只**用来注册设备（docs/plugin-integration.md:195），没有 refresh */
  async login(server: RemoteServer, email: string, password: string): Promise<RemoteAccount> {
    const serverUrl = normalizeServerUrl(server.url)
    this.setStatus({ phase: 'authing' })
    try {
      const result = await loginApi({ url: serverUrl }, email, password, this.deps)
      const account: RemoteAccount = {
        email: (result.account ?? email).trim(),
        accessToken: result.token,
        refreshToken: '',
        deviceId: '',
        scope: 'account',
        serverUrl,
        accessTokenExpiresAt: result.expiresAt,
      }
      upsertServer(serverUrl, { lastUsedAt: Date.now() })
      const stored = upsertAccount(account)
      this.setStatus({ phase: 'idle' })
      return stored
    } catch (error) {
      this.failStatus(error)
      throw toRemoteApiError(error)
    }
  }

  /**
   * [多方式登录] 账号 token（OAuth 回调 / 扫码）→ 设备账号。
   *
   * 为什么放在这一层：`login()` 之后必须紧接着 `registerDevice()` 才能连 Host
   * （账号 token 只用于注册设备，没有 refresh，见 docs/plugin-integration.md:139-195）。
   * 多方式登录拿到 token 后要做的事与密码登录**完全一样**，所以：
   *
   *   1. `GET /api/v1/auth/me` 先验 token、拿账号名（同一 token 在 `devices/register`
   *      上失败会报 401 ACCOUNT_AUTH_REQUIRED，不好区分「token 坏了」还是「服务器抽风」）；
   *   2. 按 `login()` 同一套落盘（`upsertServer` + `upsertAccount`，先留账号记录，
   *      这样注册设备失败时下次还能重试，不用重新走一遍浏览器授权）；
   *   3. 直接复用 `this.registerDevice()` —— 同一份 X25519 身份、同一条错误映射、
   *      同一条 `upsertAccount` 落盘路径，避免出现「OAuth 注册的设备跟密码注册的不一样」。
   *
   * `method` 只写进 `RemoteAccount.loginMethod`（展示 / 排障用），不改变凭据类型。
   */
  async loginWithAccountToken(
    server: RemoteServer,
    accountToken: string,
    method: LoginMethod = 'oauth',
  ): Promise<RemoteAccount> {
    const serverUrl = normalizeServerUrl(server.url)
    const token = accountToken.trim()
    if (token.length === 0) {
      throw new RemoteApiError('AUTH_REQUIRED', '缺少账号 token：OAuth / 扫码登录没有返回凭据')
    }
    this.setStatus({ phase: 'authing' })
    let pending: RemoteAccount
    try {
      const profile = await accountMe({ url: serverUrl }, token, this.deps)
      pending = {
        email: profile.account,
        accessToken: token,
        refreshToken: '',
        deviceId: '',
        scope: 'account',
        serverUrl,
        loginMethod: method,
      }
      upsertServer(serverUrl, { lastUsedAt: Date.now() })
      upsertAccount(pending)
    } catch (error) {
      this.failStatus(error)
      throw toRemoteApiError(error)
    }
    // registerDevice 自己会 failStatus + 抛带宽码的错误；这里不重复包一层
    return this.registerDevice({ url: serverUrl }, pending)
  }

  /**
   * 注册本机设备身份，换回设备 token pair（docs/protocol.md §8.1）。
   * 身份来自 localStorage 里稳定的 X25519 私钥；同 deviceId 换公钥会被 Server 拒绝。
   */
  async registerDevice(server: RemoteServer, account: RemoteAccount, name?: string): Promise<RemoteAccount> {
    const serverUrl = normalizeServerUrl(server.url)
    this.assertServer(serverUrl, account)
    this.setStatus({ phase: 'authing' })
    try {
      if (account.accessToken.length === 0) {
        throw new RemoteApiError('AUTH_REQUIRED', '还没有登录：先 login 再 registerDevice')
      }
      const identity = loadOrCreateIdentity()
      const descriptor = deviceDescriptor('client', name, DEFAULT_PLATFORM, identity)
      const pair = await registerDeviceApi({ url: serverUrl }, account.accessToken, descriptor, this.deps)
      const next: RemoteAccount = {
        ...account,
        deviceId: descriptor.deviceId,
        accessToken: pair.accessToken,
        refreshToken: pair.refreshToken,
        accessTokenExpiresAt: pair.accessTokenExpiresAt,
        refreshTokenExpiresAt: pair.refreshTokenExpiresAt,
        scope: 'device',
        serverUrl,
        deviceName: descriptor.name,
      }
      upsertServer(serverUrl, { lastUsedAt: Date.now() })
      const stored = upsertAccount(next)
      this.setStatus({ phase: 'idle' })
      return stored
    } catch (error) {
      this.failStatus(error)
      throw toRemoteApiError(error)
    }
  }

  /**
   * 列出同账号下可连的 Host，并补齐 presence 与 identityKey（docs/protocol.md §9）。
   * 只有 `role === 'host'` 的条目会被返回；公钥与本机 pin 冲突的 Host 标记
   * `identityMismatch`（仍然列出，但不允许连接 —— 让用户看到「有台主机身份不对」）。
   */
  async listHosts(server: RemoteServer, account: RemoteAccount): Promise<RemoteHost[]> {
    const serverUrl = normalizeServerUrl(server.url)
    this.assertDeviceAccount(account, serverUrl)
    const result = await withRefreshRetry({
      server: { url: serverUrl },
      auth: { deviceId: account.deviceId, accessToken: account.accessToken, refreshToken: account.refreshToken },
      // 只读查询才允许刷新重试；这里绝不放大到 mutation
      run: (accessToken) => listDevices({ url: serverUrl }, accessToken, { all: true }, this.deps),
      onRefresh: (pair) => this.applyTokens(account, pair),
      deps: this.deps,
    }).catch((error: unknown) => {
      this.failStatus(error)
      throw toRemoteApiError(error)
    })

    const hosts = result.items.filter((item) => item.role === 'host')
    return mapWithConcurrency(hosts, HOST_PROBE_CONCURRENCY, (item) =>
      this.describeHost(serverUrl, account, item),
    )
  }

  private async describeHost(
    serverUrl: string,
    account: RemoteAccount,
    record: ServerDeviceRecord,
  ): Promise<RemoteHost> {
    const server = { url: serverUrl }
    // presence 读不到就按离线处理（fail-closed：列表快照不能冒充实时在线）
    const presence = await getPresence(server, account.accessToken, record.deviceId, this.deps).catch(() => null)
    // identityKey 只有设备详情接口会返回；读不到就不 pin，交给 S2 在 connect.incoming 里校验
    const detail = await getDevice(server, account.accessToken, record.deviceId, this.deps).catch(() => null)
    const identityKey = detail?.identityKey
    let mismatch = false
    if (identityKey !== undefined) {
      const pin = pinHostIdentityKey(serverUrl, {
        deviceId: record.deviceId,
        identityKey,
        name: record.name,
      })
      mismatch = pin.state === 'mismatch'
    }
    return {
      deviceId: record.deviceId,
      name: record.name ?? record.deviceId,
      platform: record.platform,
      online: mismatch ? false : presence?.online === true,
      identityKey: mismatch ? undefined : identityKey,
      identityMismatch: mismatch ? true : undefined,
    }
  }

  /* 连接 -------------------------------------------------------------- */

  /**
   * 完成控制面握手并协商能力。
   *
   * 阶段与逐帧归属（谁发的帧写在括号里）：
   *   1. `connecting`  —— 外部已 `createSecureLink(...)`；S2 经 S1 桥连 WS（S1 connect/open）
   *   2. (S2) → hello / ← hello.ack（拿 heartbeat / 帧上限 / capability 交集）
   *   3. (S2) → connect.request / ← connect.accepted（或 connect.rejected → 直接失败）
   *   4. (S2) → transport.selected（必须在 Noise 之前，docs/protocol.md §11:519-525）
   *   5. (S2) ↔ secure.handshake step1/2（Noise IK，交给 S2）
   *   6. `handshaking` —— `link.ready()` 返回后（S3）调 `harness.transport.describe` 协商能力
   *   7. `ready`       —— 产出 { capabilities, transport }；之后心跳 ping/pong 由 S2 维持（25s/75s）
   *
   * 任何一步失败都 **fail-closed**：关掉 link、广播 error、向上抛原始错误码。
   */
  async connect(
    server: RemoteServer,
    account: RemoteAccount,
    host: RemoteHost,
    link: SecureLink,
    options: ConnectOptions = {},
  ): Promise<RemoteConnectResult> {
    const serverUrl = normalizeServerUrl(server.url)
    this.assertDeviceAccount(account, serverUrl)
    this.assertHostUsable(serverUrl, host)
    if (options.signal?.aborted === true) throw new RemoteApiError('RPC_ABORTED', '连接已被取消')

    this.setStatus({ phase: 'connecting' })
    const stopWatch = this.watchLink(link)
    try {
      await this.withDeadline(
        link.ready(),
        options.timeoutMs ?? HANDSHAKE_TIMEOUT_MS,
        'SECURE_CHANNEL_FAILED',
        '等待 Noise 安全通道超时',
      )
      stopWatch()
      this.setStatus({ phase: 'handshaking' })
      const capabilities = await this.describe(link, options)
      const transport = resolveTransport(link, options)
      this.setStatus({ phase: 'ready', capabilities, transport })
      return { capabilities: [...capabilities], transport }
    } catch (error) {
      stopWatch()
      // 半开的链路必须断掉：认证完成前禁止发业务消息，也不能留着占用 Server 的 connection
      try {
        link.close()
      } catch {
        // link 自己已经炸了，close 失败无所谓
      }
      this.failStatus(error)
      throw toRemoteApiError(error)
    }
  }

  /** `harness.transport.describe`（docs/protocol.md §17）：通道建立后**必须先调**这一次 */
  private async describe(link: SecureLink, options: ConnectOptions): Promise<string[]> {
    let value: unknown
    try {
      value = await link.rpc<unknown>('harness.transport.describe', {}, {
        timeoutMs: options.describeTimeoutMs ?? DESCRIBE_TIMEOUT_MS,
      })
    } catch (error) {
      if (options.signal?.aborted === true) {
        throw new RemoteApiError('RPC_ABORTED', '连接已被取消')
      }
      const code = codeOf(error)
      // 旧 Host 没有这个方法：必须拒绝连接，不能按版本号猜着降级（docs/protocol.md §17:934-935）
      if (code === 'METHOD_NOT_FOUND') {
        throw new RemoteApiError(
          'METHOD_NOT_FOUND',
          '远端 Host 不支持 harness.transport.describe（DSH 版本过旧），按协议拒绝连接',
          undefined,
          false,
          { method: 'harness.transport.describe' },
        )
      }
      throw toRemoteApiError(error)
    }
    return parseTransportDescription(value)
  }

  /**
   * 把 `link.state` 的 connecting → open 报成 `handshaking`，
   * 让 UI 在漫长的 Noise 握手里也有话说（S2 未提供 onState 订阅时的兜底）。
   */
  private watchLink(link: SecureLink): () => void {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = (): void => {
      if (stopped) return
      if (link.state === 'open') this.setStatus({ phase: 'handshaking' })
      timer = setTimeout(tick, LINK_POLL_MS)
    }
    timer = setTimeout(tick, LINK_POLL_MS)
    return () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private async withDeadline<T>(
    promise: Promise<T>,
    timeoutMs: number,
    code: string,
    label: string,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new RemoteApiError(code, `${label}（${timeoutMs}ms）`, undefined, true))
      }, timeoutMs)
    })
    try {
      return await Promise.race([promise, timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /* 收尾 -------------------------------------------------------------- */

  close(): void {
    this.setStatus({ phase: 'idle' })
  }

  /** 退出登录：清本地 token + 该服务器的 Host pin；服务器记录保留（下次登录省得再填地址） */
  async logout(server: RemoteServer, account: RemoteAccount): Promise<void> {
    const serverUrl = normalizeServerUrl(server.url)
    removeAccount(serverUrl, account.email)
    account.accessToken = ''
    account.refreshToken = ''
    account.deviceId = ''
    this.setStatus({ phase: 'idle' })
    if (loadAccounts().length === 0) removeServer(serverUrl)
  }

  /* 内部校验 ---------------------------------------------------------- */

  private assertServer(serverUrl: string, account: RemoteAccount): void {
    if (account.serverUrl !== undefined && account.serverUrl !== serverUrl) {
      throw new RemoteApiError(
        'INVALID_ARGUMENT',
        `账号属于 ${account.serverUrl}，不能连接到 ${serverUrl}（登录/注册/refresh/WebSocket 不得跨域混用）`,
      )
    }
  }

  private assertDeviceAccount(account: RemoteAccount, serverUrl: string): void {
    this.assertServer(serverUrl, account)
    if ((account.scope ?? 'device') === 'account' || account.deviceId.length === 0) {
      throw new RemoteApiError('AUTH_REQUIRED', '账号还没注册设备：先 login，再 registerDevice，才能列出 Host 或连接')
    }
    if (account.accessToken.length === 0) {
      throw new RemoteApiError('AUTH_REQUIRED', '缺少设备 access token，需要重新登录')
    }
  }

  /** 连接前再核一次 Host 公钥：本机 pin 不一致必须拒绝（docs/protocol.md §9、plugin-integration.md:260） */
  private assertHostUsable(serverUrl: string, host: RemoteHost): void {
    if (host.identityMismatch === true) {
      throw new RemoteApiError(
        'PEER_IDENTITY_MISMATCH',
        `Host「${host.name}」的公钥与本机 pin 不一致，拒绝连接`,
        undefined,
        false,
        { deviceId: host.deviceId },
      )
    }
    if (host.identityKey === undefined) return
    const pin = pinHostIdentityKey(serverUrl, { deviceId: host.deviceId, identityKey: host.identityKey, name: host.name })
    if (pin.state === 'mismatch') {
      throw new RemoteApiError(
        'PEER_IDENTITY_MISMATCH',
        `Host「${host.name}」的公钥与本机 pin 不一致，拒绝连接`,
        undefined,
        false,
        { deviceId: host.deviceId },
      )
    }
  }

  /** 拿到新 pair：先原地更新调用方持有的 account，再原子落盘（token 只存一处） */
  private applyTokens(account: RemoteAccount, pair: { accessToken: string; refreshToken: string; accessTokenExpiresAt: number; refreshTokenExpiresAt: number }): void {
    account.accessToken = pair.accessToken
    account.refreshToken = pair.refreshToken
    account.accessTokenExpiresAt = pair.accessTokenExpiresAt
    account.refreshTokenExpiresAt = pair.refreshTokenExpiresAt
    upsertAccount(account)
  }
}

/* ── 工厂 ─────────────────────────────────────────────────────────────── */

export const createRemoteClient = (options: RemoteClientOptions = {}): RemoteClientImpl =>
  new RemoteClientImpl(options)

/* ── 给集成层拼 SecureLinkOptions（契约之外的小工具，省得 UI 自己拼头） ── */

export interface BuildLinkOptionsInput {
  server: RemoteServer
  account: RemoteAccount
  host: RemoteHost
  /** S2 的 `url`：`wss://<server>/ws/v1/connect` */
  controlUrl?: string
  connectionId?: string
  /** 显式给身份（正常从 localStorage 读；单测 / 已读过的调用方可以直接传） */
  identity?: DeviceIdentity
  onState?: SecureLinkOptions['onState']
  onFrame?: (frame: unknown) => void
  onStreamEvent?: (streamId: string, payload: unknown) => void
}

/** `wss://dsh.r2049.cn` → `wss://dsh.r2049.cn/ws/v1/connect`（docs/protocol.md §10.1） */
export const controlChannelUrl = (serverUrl: string): string => {
  const url = new URL(serverUrl)
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:'
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/ws/v1/connect`
  return url.toString()
}

/**
 * 拼 `createSecureLink()` 的入参。三处容易错的地方都在这里收口：
 *   1. `Origin` 必须由 S1 桥注入（Server 把它硬绑 DSH_SERVER_PUBLIC_URL，契约 §6 风险 1）；
 *   2. `Authorization` 只放头里，绝不进 URL（契约 §6 风险 2）；
 *   3. Noise 静态私钥必须与已注册的 deviceId 配对，对不上就报错而不是拿错身份去握手。
 */
export const buildLinkOptions = (input: BuildLinkOptionsInput): SecureLinkOptions => {
  const serverUrl = normalizeServerUrl(input.server.url)
  const identity = input.identity ?? loadOrCreateIdentity()
  if (input.account.deviceId.length > 0 && input.account.deviceId !== identity.deviceId) {
    throw new RemoteApiError(
      'IDENTITY_MISMATCH',
      '本地设备身份与已注册的 deviceId 不一致（可能是清了本地身份），需要重新注册设备',
      undefined,
      false,
      { registered: input.account.deviceId, local: identity.deviceId },
    )
  }
  return {
    url: input.controlUrl ?? controlChannelUrl(serverUrl),
    headers: { Authorization: `Bearer ${input.account.accessToken}`, Origin: serverUrl },
    device: { deviceId: identity.deviceId, privateKey: identity.privateKey, publicKey: identity.publicKey },
    hostDeviceId: input.host.deviceId,
    clientDeviceId: identity.deviceId,
    // Noise IK 的 initiator 必须预先知道对端静态公钥（protocol.md §12.1）；
    // 列表接口不返回 identityKey，只有 GET /api/v1/devices/{id} 有，缺失时 S2 fail-closed。
    ...(input.host.identityKey === undefined ? {} : { hostIdentityKey: input.host.identityKey }),
    connectionId: input.connectionId,
    onState: input.onState,
    onFrame: input.onFrame,
    onStreamEvent: input.onStreamEvent,
  }
}

/** 诊断用的安全摘要（**不含 token / 私钥**）；UI 想打日志只允许用这个 */
export const describeRemoteAccount = (account: RemoteAccount): string => describeAccount(account)

/** 控制面握手要用的能力清单（S2 的 hello 里应声明；这里导出给联调核对） */
export const CLIENT_HELLO_TRANSPORTS: readonly string[] = CLIENT_TRANSPORTS

/** 供 UI 判断「是否需要重新登录」（与 serverApi 同一套判定） */
export const isAuthExpired = (error: unknown): boolean => needsReauth(error)

export { RemoteApiError }
