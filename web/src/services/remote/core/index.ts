/**
 * S2 传输核对外入口（契约 `work/2026-11-21-chatpad接入DSH远程/plan-P0P1-实施契约.md` §3）。
 *
 * 分层（自下而上）：
 *
 *   bridgeSocket.ts  本机原生桥（页面 ⇄ S1 的 `ws://127.0.0.1:<port>/__ds_remote/ws`）
 *   secureChannel.ts Control 面握手（hello → connect → transport.selected）+ Noise IK + 分片/加密
 *   rpcMux.ts        requestId 关联 / 超时 / 错误码 / 流 / 心跳
 *   index.ts         `createSecureLink(options) → SecureLink`
 *
 * 使用（S3 视角）：
 *
 *   const link = createSecureLink({
 *     url: 'wss://dsh.r2049.cn/ws/v1/connect',        // §10.1 的固定路径
 *     headers: { Authorization: `Bearer ${deviceAccessToken}`, Origin: 'https://dsh.r2049.cn' },
 *     device: { deviceId, privateKey, publicKey },     // 本机 client 身份（X25519）
 *     clientDeviceId: deviceId,
 *     hostDeviceId: host.deviceId,
 *     hostIdentityKey: host.identityKey,               // 见下方「契约缺口」
 *     onState: (state, detail) => …,
 *     onStreamEvent: (streamId, payload) => …,
 *   })
 *   await link.ready()                                  // Noise 完成 + transport.selected 已发
 *   const caps = await link.rpc('harness.transport.describe', {})
 *
 * **契约缺口（必须由调用方补上）**：`plan-P0P1-实施契约.md` §3 的 `SecureLinkOptions` 没有
 * Host 静态公钥字段，但 §12.1 的 Noise IK *必须* 预先知道 responder 的 static public key。
 * 本实现新增可选字段 `hostIdentityKey`：缺失时 `ready()` 以 `PEER_IDENTITY_MISMATCH` 失败
 * （fail-closed，不猜）。取值方式与官方 Client 一致：
 *   `GET /api/v1/devices/{hostDeviceId}`（设备 Bearer）→ `identityKey`
 * （列表接口 `GET /api/v1/devices` 明确不返回 identityKey，见 protocol.md §9）。
 */

import { createBridgeSocket, type BridgeSocket } from './bridgeSocket.js'
import { LinkErrorCodes, RemoteLinkError, asRemoteLinkError } from './errors.js'
import {
  RpcMux,
  type RemoteStreamHandle,
  type RpcCallOptions,
  type StreamEventPayload,
} from './rpcMux.js'
import { SecureChannel, type SecureChannelOptions, type SecureChannelStats } from './secureChannel.js'
import type { SelectedTransport } from '../../../vendor/dsh-remote/protocol/index.js'

/** `SecureLink.state` 的取值（契约 §3）。 */
export type SecureLinkState = 'closed' | 'connecting' | 'open' | 'secure'

export interface SecureLinkOptions {
  /** 远端 DSH Control WS（`wss://<server>/ws/v1/connect`，见 protocol.md §10.1）。 */
  url: string
  /** 交给原生桥的请求头：`Authorization` 与 `Origin`（契约 §2 / §6 风险 1、2）。 */
  headers: Record<string, string>
  /** 本机 client 身份（X25519，base64url）。 */
  device: { deviceId: string; privateKey: string; publicKey: string }
  /** 目标 Host 的 deviceId。 */
  hostDeviceId: string
  /** 本机 client deviceId（必须等于 `device.deviceId`）。 */
  clientDeviceId: string
  /** 已有 connectionId 时跳过 connect.request。 */
  connectionId?: string
  /** 状态变化通知（只报变化，不报初始值）。 */
  onState?: (state: SecureLinkState, detail?: string) => void
  /** 本层没有内部消费掉的已解密明文帧（见 rpcMux.ts 的说明）。 */
  onFrame?: (frame: unknown) => void
  /** 流事件：`{type:'frame'}` 或 `{type:'closed'}`。 */
  onStreamEvent?: (streamId: string, payload: StreamEventPayload) => void

  // ── 以下均为契约 §3 之外的可选扩展，S3 可以不传 ────────────────────────────
  /** 目标 Host 静态 X25519 公钥；Noise IK 必需（缺失即 fail-closed）。 */
  hostIdentityKey?: string
  /** 覆盖 hello payload 的 token；缺省取 `headers.Authorization` 的 Bearer。 */
  accessToken?: string
  /** 本机原生桥地址；缺省按 `location.port` 推导。 */
  bridgeUrl?: string
  /** hello payload 上报的客户端版本（可选字段）。 */
  clientVersion?: string
  helloTimeoutMs?: number
  connectTimeoutMs?: number
  handshakeTimeoutMs?: number
  rtc?: SecureChannelOptions['rtc']
  relayBridge?: SecureChannelOptions['relayBridge']
  useRelayNode?: boolean
  /** 单次 RPC 默认预算（默认 30 s）。 */
  rpcTimeoutMs?: number
  /** 心跳间隔；缺省用 hello.ack 的 `heartbeatIntervalMs`（25 s）。 */
  heartbeatIntervalMs?: number
  /** 心跳断开阈值；缺省 `max(15 s, interval × 3)`（默认 75 s，§22）。 */
  heartbeatTimeoutMs?: number
}

/** 契约 §3 的对外接口。 */
export interface SecureLink {
  readonly state: SecureLinkState
  readonly transport: SelectedTransport
  /** 等安全通道就绪（Noise 完成 + transport.selected 已发）。 */
  ready(): Promise<void>
  /** 发一帧明文 JSON（内部负责分片 + 加密）。 */
  sendFrame(frame: unknown): void
  /** 请求-响应：自动分配 requestId、超时、错误码直传。 */
  rpc<T = unknown>(method: string, params?: unknown, opts?: RpcCallOptions): Promise<T>
  /** 开流：帧通过 `onStreamEvent` 回调。 */
  openStream(endpoint: string, payload: unknown, opts?: RpcCallOptions): Promise<RemoteStreamHandle>
  close(): void
}

/** 按契约 §3 创建一个 secure link（内部自动开始建链，失败通过 `ready()` 暴露）。 */
export function createSecureLink(options: SecureLinkOptions): SecureLink {
  const bridge = createBridgeSocket({
    url: options.url,
    headers: options.headers,
    ...(options.bridgeUrl === undefined ? {} : { bridgeUrl: options.bridgeUrl }),
  })
  const relayBridge = options.useRelayNode && !options.relayBridge
    ? (url: string) => createBridgeSocket({ url, headers: {}, bridgeUrl: options.bridgeUrl, openTimeoutMs: 5000 })
    : options.relayBridge
  return new SecureLinkImpl({ ...options, relayBridge }, bridge)
}

/**
 * 用注入的 `BridgeSocket` 创建 secure link。
 *
 * 用途：① Node 自测用内存 socket 对替换原生桥；② 将来若把桥换成别的实现（例如直接
 * `wss://` + 代理），复用整条链路。生产路径请用 `createSecureLink`。
 */
export function createSecureLinkWithBridge(options: SecureLinkOptions, bridge: BridgeSocket): SecureLink {
  return new SecureLinkImpl(options, bridge)
}

class SecureLinkImpl implements SecureLink {
  private current: SecureLinkState = 'connecting'
  private readonly options: SecureLinkOptions
  private readonly channel: SecureChannel
  private readonly mux: RpcMux
  private readonly readyPromise: Promise<void>
  private closeReported = false

  constructor(options: SecureLinkOptions, bridge: BridgeSocket) {
    this.options = options
    const accessToken = resolveAccessToken(options)
    // mux 需要往 channel 发，channel 的入站帧要喂给 mux：先建 channel（回调里用闭包取 mux）。
    let muxRef: RpcMux | undefined
    const channel = new SecureChannel({
      bridge,
      accessToken,
      device: options.device,
      hostDeviceId: options.hostDeviceId,
      clientDeviceId: options.clientDeviceId,
      ...(options.hostIdentityKey === undefined ? {} : { hostIdentityKey: options.hostIdentityKey }),
      ...(options.connectionId === undefined ? {} : { connectionId: options.connectionId }),
      ...(options.clientVersion === undefined ? {} : { clientVersion: options.clientVersion }),
      ...(options.helloTimeoutMs === undefined ? {} : { helloTimeoutMs: options.helloTimeoutMs }),
      ...(options.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: options.connectTimeoutMs }),
      ...(options.handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs: options.handshakeTimeoutMs }),
      ...(options.rtc === undefined ? {} : { rtc: options.rtc }),
      ...(options.relayBridge === undefined ? {} : { relayBridge: options.relayBridge }),
      onPhase: phase => {
        if (phase === 'bridge-open') this.emitState('open')
        else if (phase === 'secure') this.emitState('secure')
      },
      onControlFrame: () => muxRef?.touch(),
      onClose: error => this.handleChannelClose(error),
    })
    const mux = new RpcMux({
      send: envelope => channel.sendEnvelope(envelope),
      ...(options.onStreamEvent === undefined ? {} : { onStreamEvent: options.onStreamEvent }),
      ...(options.onFrame === undefined ? {} : { onUnhandledFrame: options.onFrame }),
      ...(options.rpcTimeoutMs === undefined ? {} : { rpcTimeoutMs: options.rpcTimeoutMs }),
      onFatal: error => channel.abort(error),
    })
    muxRef = mux
    channel.onMessage(plaintext => mux.handlePlaintext(plaintext))
    this.channel = channel
    this.mux = mux
    this.readyPromise = this.start()
    // 调用方可能只 await 一次或干脆不 await：这里挂一个空的 catch，避免 unhandled rejection。
    void this.readyPromise.catch(() => undefined)
  }

  get state(): SecureLinkState {
    return this.current
  }

  get transport(): SelectedTransport {
    return this.channel.transport
  }

  async ready(): Promise<void> {
    await this.readyPromise
  }

  sendFrame(frame: unknown): void {
    this.requireSecure('sendFrame')
    this.mux.sendEnvelope(frame)
  }

  async rpc<T = unknown>(method: string, params?: unknown, opts?: RpcCallOptions): Promise<T> {
    await this.readyPromise
    return await this.mux.rpc<T>(method, params, opts)
  }

  async openStream(endpoint: string, payload: unknown, opts?: RpcCallOptions): Promise<RemoteStreamHandle> {
    await this.readyPromise
    return await this.mux.openStream(endpoint, payload, opts)
  }

  close(): void {
    if (this.current === 'closed') return
    this.channel.close()
    // `channel.close()` 正常路径会回调 onClose → handleChannelClose；这里兜底一次幂等收尾。
    this.handleChannelClose(undefined)
  }

  /** 诊断用（不含任何密钥/token）。 */
  getStats(): SecureChannelStats {
    return this.channel.getStats()
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  private async start(): Promise<void> {
    try {
      await this.channel.start()
      this.mux.startHeartbeat({
        intervalMs: this.options.heartbeatIntervalMs ?? this.channel.heartbeatInterval,
        ...(this.options.heartbeatTimeoutMs === undefined ? {} : { timeoutMs: this.options.heartbeatTimeoutMs }),
        sendPing: nonce => this.channel.sendPing(nonce),
        // 心跳超时 = 连接故障（§22/§23 的 CONNECTION_FAILED），由 channel 统一收尾。
        onTimeout: error => this.channel.abort(error),
      })
    } catch (error) {
      const failure = asRemoteLinkError(error, LinkErrorCodes.CONNECTION_FAILED)
      this.handleChannelClose(failure)
      throw failure
    }
  }

  private handleChannelClose(error?: RemoteLinkError): void {
    this.mux.close(error)
    if (this.current === 'closed' && this.closeReported) return
    const detail = error === undefined ? undefined : `${error.code}: ${error.message}`
    this.current = 'closed'
    if (this.closeReported) return
    this.closeReported = true
    this.options.onState?.('closed', detail)
  }

  private emitState(state: SecureLinkState, detail?: string): void {
    if (this.current === state) return
    this.current = state
    this.options.onState?.(state, detail)
  }

  private requireSecure(action: string): void {
    if (this.current !== 'secure') {
      throw new RemoteLinkError(
        LinkErrorCodes.TRANSPORT_CLOSED,
        `${action} 需要安全通道已就绪（当前 state=${this.current}）。`,
      )
    }
  }
}

/**
 * hello payload 的 access token 只能来自 `headers.Authorization` 或显式 `accessToken`；
 * 绝不进 URL、绝不落日志（契约 §6 风险 2）。
 */
function resolveAccessToken(options: SecureLinkOptions): string {
  const explicit = options.accessToken
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  const headers = options.headers ?? {}
  const header = headers.Authorization ?? headers.authorization
  const matched = /^Bearer\s+(\S+)$/i.exec(typeof header === 'string' ? header : '')
  if (matched !== null && matched[1] !== undefined) return matched[1]
  throw new RemoteLinkError(
    LinkErrorCodes.AUTH_REQUIRED,
    '缺少设备 access token：请把 Bearer token 放进 headers.Authorization（推荐），或显式传 accessToken。',
  )
}

export { LinkErrorCodes, RemoteLinkError } from './errors.js'
export type { BridgeSocket, BridgeCloseInfo, BridgeSocketOptions } from './bridgeSocket.js'
export type {
  HeartbeatConfig,
  RemoteStreamHandle as RemoteStream,
  RpcCallOptions,
  StreamCloseReason,
  StreamClosedEvent,
  StreamEventPayload,
  StreamFrameEvent,
} from './rpcMux.js'
export type { SecureChannelStats, SecureChannelDevice } from './secureChannel.js'
