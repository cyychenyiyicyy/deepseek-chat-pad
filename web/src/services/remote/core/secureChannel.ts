/**
 * DSH Secure Channel（客户端 = Noise IK initiator）+ Control 面握手。
 *
 * 依据 `docs/protocol.md`：
 *   §10.1 Control WS / §10.3 hello+hello.ack
 *   §11   connect.request → connect.accepted → transport.selected
 *   §12.1 Noise_IK_25519_ChaChaPoly_SHA256，prologue = DSH-REMOTE|v=1|connection|host|client
 *   §12.2 secure.handshake（step 1/2）relay 转发
 *   §12.3 transport frame：>48 KiB 必须切成 DSHF 分片，单消息上限 4 MiB，Noise 单消息 ≤ 65535 B
 *   §13   relay frame（base64url ciphertext + 每方向严格递增 counter）
 *   §22   Control heartbeat（默认 25 s 间隔 / 75 s 断开）
 *
 * 结构对照 `packages/plugin/src/client-secure-transport.ts` + `packages/webrtc/src/index.ts`
 * 的 `RelayTransport`，但剔除了 Node 依赖（无 `node:*` / `Buffer` / `process`），只用浏览器全局。
 *
 * 本文件只做「控制面 + 加密通道」，RPC 关联/流/心跳判定在 `rpcMux.ts`。
 */

import {
  NoiseIkSession,
  createNoisePrologue,
  fromBase64Url,
  toBase64Url,
} from '../../../vendor/dsh-remote/crypto/index.js'
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  MAX_CONTROL_FRAME_BYTES,
  MAX_RELAY_FRAME_BYTES,
  MAX_SECURE_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  SecureMessageCodec,
  acceptNegotiatedCapabilities,
  createControlFrame,
  createRelayDataFrame,
  decodeControlFrame,
  decodeRelayDataFrame,
  encodeControlFrame,
  encodeRelayDataFrame,
  type ConnectAcceptedPayload,
  type ControlErrorPayload,
  type ControlFrame,
  type ControlFrameByteLimits,
  type ControlFrameType,
  type HelloAckPayload,
  type RelayPayload,
  type SecureHandshakePayload,
  type SelectedTransport,
  type SignalIcePayload,
  type SignalPayload,
} from '../../../vendor/dsh-remote/protocol/index.js'
import type { BridgeSocket } from './bridgeSocket.js'
import { RtcTransport, RtcUnavailable, type RtcMode } from './rtcTransport.js'
import {
  LinkErrorCodes,
  RemoteLinkError,
  asRemoteLinkError,
  errorMessage,
  readErrorCode,
} from './errors.js'

/** relay is the baseline for servers without WebRTC support. */
export const CLIENT_HELLO_CAPABILITIES: readonly string[] = ['transport.relay']
const RTC_CAPABILITIES = ['transport.lan', 'transport.p2p', 'transport.turn']

/** 等 hello.ack 的预算（Server 侧 hello 超时是 5 s，这里留一倍余量）。 */
const DEFAULT_HELLO_TIMEOUT_MS = 10_000
/** 等 connect.accepted 的预算（Host 要做一次 REST 设备校验）。 */
const DEFAULT_CONNECT_TIMEOUT_MS = 20_000
/** Noise IK 握手预算（与 `client-secure-transport.ts` 一致）。 */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000
/** 握手帧长度上限：IK 的 message 2 只有 ~96 B，给足余量但要挡住异常大帧。 */
const MAX_HANDSHAKE_FRAME_CHARS = 4_096
/**
 * relay counter 的软上限。§12.3 要求「达到 Noise 实现建议的消息/字节阈值时 rekey 或重建
 * connection」：P0 不实现 rekey，因此触顶直接报错，由上层重建连接。
 */
const MAX_RELAY_COUNTER = 0xff_ff_ff_ff

/** deviceId 的宽松校验（§4.2：ULID 或 UUID；这里只挡住空串与明显异常的输入）。 */
const DEVICE_ID_PATTERN = /^[0-9A-Za-z_-]{8,128}$/
/** §7：identityKey 必须是 32 字节 X25519 公钥的规范无 padding base64url（43 字符）。 */
const IDENTITY_KEY_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/

export type SecureChannelPhase =
  | 'idle'
  | 'bridge-open'
  | 'control-ready'
  | 'secure'
  | 'closed'

export interface SecureChannelDevice {
  /** 本机 deviceId（必须与 `clientDeviceId` 相同）。 */
  deviceId: string
  /** X25519 私钥（base64url，32 字节）。 */
  privateKey: string
  /** X25519 公钥（base64url，32 字节）。 */
  publicKey: string
}

export interface SecureChannelOptions {
  bridge: BridgeSocket
  /** 本机 device access token（只放 hello payload，绝不进 URL/日志）。 */
  accessToken: string
  device: SecureChannelDevice
  /** 目标 Host 的 deviceId。 */
  hostDeviceId: string
  /** 本机 client deviceId（Noise prologue 与 relay targetDeviceId 都用它）。 */
  clientDeviceId: string
  /**
   * 目标 Host 的静态 X25519 公钥（§12.1 pinning）。
   * 来源：`GET /api/v1/devices/{hostDeviceId}` 的 `identityKey`（列表接口不返回它，见 §9）。
   */
  hostIdentityKey?: string
  /** 已有 connectionId 时跳过 connect.request（服务端仍持有该链路时可用）。 */
  connectionId?: string
  /** hello payload 里上报的客户端版本（可选字段）。 */
  clientVersion?: string
  helloTimeoutMs?: number
  connectTimeoutMs?: number
  handshakeTimeoutMs?: number
  rtc?: { mode: RtcMode; iceServers: (connectionId: string) => Promise<RTCIceServer[]>; timeoutMs?: number }
  relayBridge?: (url: string) => BridgeSocket
  /** 阶段推进通知（`bridge-open` / `control-ready` / `secure`）。 */
  onPhase?: (phase: Exclude<SecureChannelPhase, 'idle' | 'closed'>, detail?: string) => void
  /** 每收到一个合法 Control 帧回调一次（心跳统计用，不含业务明文）。 */
  onControlFrame?: (type: ControlFrameType, payload: unknown) => void
  /** 通道关闭（`undefined` 表示本地正常关闭）。 */
  onClose?: (error?: RemoteLinkError) => void
}

export interface SecureChannelStats {
  /** 出站 relay 帧数（= Noise transport message 数）。 */
  readonly relayFramesSent: number
  readonly relayFramesReceived: number
  readonly controlFramesSent: number
  readonly controlFramesReceived: number
  /** 已发送的明文总字节（分片前）。 */
  readonly plaintextBytesSent: number
  /** 已收到的明文总字节（重组后）。 */
  readonly plaintextBytesReceived: number
  /** 最近一个入站 relay 帧的 counter（§13 只用于诊断，权威依据是 Noise 自身状态）。 */
  readonly lastInboundCounter: number | undefined
  /** 下一个出站 counter。 */
  readonly nextCounter: number
}

export class SecureChannel {
  private readonly bridge: BridgeSocket
  private readonly options: SecureChannelOptions
  private readonly codecOut = new SecureMessageCodec()
  private readonly codecIn = new SecureMessageCodec()
  private readonly messageHandlers = new Set<(plaintext: Uint8Array) => void>()
  private readonly unsubscribes: Array<() => void> = []

  private noise: NoiseIkSession | undefined
  private channelPhase: SecureChannelPhase = 'idle'
  private connectionId: string | undefined
  private controlLimits: ControlFrameByteLimits = {}
  private negotiatedCapabilities: readonly string[] = []
  private heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS
  private counter = 0
  private lastInboundCounter: number | undefined
  private closeError: RemoteLinkError | undefined
  private startPromise: Promise<void> | undefined
  private closed = false
  private rtc: RtcTransport | undefined
  private transportMode: SelectedTransport = 'relay'
  private rtcWaiter: Deferred<SelectedTransport> | undefined
  private rtcTimeoutMs = 0
  private rtcTransports: SelectedTransport[] = []
  private pendingRtcFrames: Uint8Array[] = []
  private relayAssignment: { url: string; ticket: string; epoch?: number } | undefined
  private relayBridge: BridgeSocket | undefined
  private relayWaiter: Deferred<void> | undefined

  private helloWaiter: Deferred<void> | undefined
  private acceptedWaiter: Deferred<string> | undefined
  private step2Waiter: Deferred<Uint8Array> | undefined

  private relayFramesSent = 0
  private relayFramesReceived = 0
  private controlFramesSent = 0
  private controlFramesReceived = 0
  private plaintextBytesSent = 0
  private plaintextBytesReceived = 0

  constructor(options: SecureChannelOptions) {
    this.bridge = options.bridge
    this.options = options
    this.connectionId = options.connectionId
    if (!DEVICE_ID_PATTERN.test(options.device.deviceId)) {
      throw new RemoteLinkError(LinkErrorCodes.INVALID_MESSAGE, 'deviceId 不合法的 device 参数。')
    }
    if (options.device.deviceId !== options.clientDeviceId) {
      throw new RemoteLinkError(
        LinkErrorCodes.INVALID_MESSAGE,
        'device.deviceId 必须等于 clientDeviceId（Noise prologue 与 relay target 都依赖它）。',
      )
    }
    // 桥的事件订阅必须在 start() 之前挂好，避免 open 后的第一帧丢失。
    this.unsubscribes.push(this.bridge.onText(text => this.handleControlText(text)))
    this.unsubscribes.push(this.bridge.onBinary(bytes => this.handleUnexpectedBinary(bytes)))
    this.unsubscribes.push(this.bridge.onClose(info => {
      this.fail(new RemoteLinkError(
        info.detailCode ?? LinkErrorCodes.TRANSPORT_CLOSED,
        `原生桥关闭：${info.reason}${info.code === 0 ? '' : `（code=${info.code}）`}`,
      ))
    }))
  }

  get phase(): SecureChannelPhase {
    return this.channelPhase
  }

  get connection(): string | undefined {
    return this.connectionId
  }

  get transport(): SelectedTransport {
    return this.transportMode
  }

  private get helloCapabilities(): readonly string[] {
    return [...CLIENT_HELLO_CAPABILITIES, ...(this.options.rtc ? RTC_CAPABILITIES : []),
      ...(this.options.relayBridge ? ['transport.relay.attach'] : [])]
  }

  /** hello.ack 协商出来的能力集合（§10.3：只能使用这个集合里的能力）。 */
  get capabilities(): readonly string[] {
    return this.negotiatedCapabilities
  }

  /** hello.ack 给的心跳间隔（§22，默认 25 s）。 */
  get heartbeatInterval(): number {
    return this.heartbeatIntervalMs
  }

  get isSecure(): boolean {
    return this.channelPhase === 'secure' && !this.closed
  }

  get error(): RemoteLinkError | undefined {
    return this.closeError
  }

  getStats(): SecureChannelStats {
    return {
      relayFramesSent: this.relayFramesSent,
      relayFramesReceived: this.relayFramesReceived,
      controlFramesSent: this.controlFramesSent,
      controlFramesReceived: this.controlFramesReceived,
      plaintextBytesSent: this.plaintextBytesSent,
      plaintextBytesReceived: this.plaintextBytesReceived,
      lastInboundCounter: this.lastInboundCounter,
      nextCounter: this.counter,
    }
  }

  /** 订阅重组后的明文帧（每条 = 一个完整的 Remote message JSON）。 */
  onMessage(handler: (plaintext: Uint8Array) => void): () => void {
    this.messageHandlers.add(handler)
    return () => this.messageHandlers.delete(handler)
  }

  /**
   * 建链：原生桥 → hello → connect → transport.selected → Noise IK。
   * 幂等（重复调用返回同一个 Promise）；失败后 `phase` 落到 `closed`。
   */
  start(): Promise<void> {
    this.startPromise ??= this.run()
    return this.startPromise
  }

  /** 发一帧明文 JSON（内部负责分片 + 加密 + relay 封装）。 */
  sendEnvelope(envelope: unknown): void {
    this.requireSecure()
    let json: unknown
    try {
      json = JSON.stringify(envelope)
    } catch (error) {
      throw new RemoteLinkError(
        LinkErrorCodes.INVALID_MESSAGE,
        `明文帧无法序列化为 JSON：${errorMessage(error)}`,
        { cause: error },
      )
    }
    if (typeof json !== 'string' || json.length === 0) {
      throw new RemoteLinkError(LinkErrorCodes.INVALID_MESSAGE, '明文帧序列化结果为空（不是可发送的 JSON）。')
    }
    this.sendPlaintext(new TextEncoder().encode(json))
  }

  /** 发一帧明文二进制（一般给 `sendEnvelope` 用）。 */
  sendPlaintext(plaintext: Uint8Array): void {
    this.requireSecure()
    if (plaintext.byteLength > MAX_SECURE_MESSAGE_BYTES) {
      throw new RemoteLinkError(
        LinkErrorCodes.FRAME_TOO_LARGE,
        `明文帧 ${plaintext.byteLength} B 超过 §12.3 的 ${MAX_SECURE_MESSAGE_BYTES} B 重组上限。`,
      )
    }
    const noise = this.noise
    const connectionId = this.connectionId
    if (noise === undefined || connectionId === undefined) {
      throw new RemoteLinkError(LinkErrorCodes.TRANSPORT_CLOSED, '安全通道尚未就绪。')
    }
    let fragments: Uint8Array[]
    try {
      // §12.3：> 48 KiB 先切 DSHF 分片，再逐片加密。
      fragments = this.codecOut.encode(plaintext)
    } catch (error) {
      throw new RemoteLinkError(LinkErrorCodes.FRAME_TOO_LARGE, errorMessage(error) || '明文帧分片失败。', {
        cause: error,
      })
    }
    for (const fragment of fragments) {
      if (this.counter > MAX_RELAY_COUNTER) {
        this.fail(new RemoteLinkError(
          LinkErrorCodes.SECURE_CHANNEL_FAILED,
          'relay counter 已达上限，按 §12.3 需要重建连接（P0 不实现 rekey）。',
        ))
        throw new RemoteLinkError(LinkErrorCodes.SECURE_CHANNEL_FAILED, 'relay counter 已用尽。')
      }
      let ciphertext: Uint8Array
      try {
        ciphertext = noise.encrypt(fragment)
      } catch (error) {
        const failure = new RemoteLinkError(
          LinkErrorCodes.SECURE_CHANNEL_FAILED,
          `Noise 加密失败：${errorMessage(error)}`,
          { cause: error },
        )
        this.fail(failure)
        throw failure
      }
      try {
        if (this.rtc === undefined) {
          const payload: RelayPayload = {
            connectionId,
            targetDeviceId: this.options.hostDeviceId,
            counter: this.counter,
            ciphertext: toBase64Url(ciphertext),
          }
          if (this.relayBridge) this.sendRelayData('relay', { ...payload })
          else this.sendControl('relay', payload)
          this.relayFramesSent += 1
        } else {
          this.rtc.send(ciphertext)
        }
      } catch (error) {
        const failure = asRemoteLinkError(error, LinkErrorCodes.TRANSPORT_CLOSED)
        this.fail(failure)
        throw failure
      }
      this.counter += 1
    }
    this.plaintextBytesSent += plaintext.byteLength
  }

  /** 发一条 Control ping（§22；心跳监控用，pong 由 Server 回）。 */
  sendPing(nonce: string): void {
    if (this.closed) return
    this.sendControl('ping', { nonce })
  }

  /** 正常关闭（幂等）。 */
  close(): void {
    if (this.closed) return
    this.teardown()
    this.options.onClose?.(undefined)
  }

  /** 由上层（RPC 层/心跳）判定失败时主动收尾，保留原始错误码。 */
  abort(error: RemoteLinkError): void {
    this.fail(error)
  }

  // ── 建链流程 ──────────────────────────────────────────────────────────────

  private async run(): Promise<void> {
    try {
      this.validateIdentityKey()
      await this.bridge.open()
      this.setPhase('bridge-open')

      // §10.3 hello：role/deviceId/accessToken/protocols/capabilities。
      const helloAck = new Deferred<void>()
      this.helloWaiter = helloAck
      this.sendControl('hello', {
        role: 'client',
        deviceId: this.options.clientDeviceId,
        accessToken: this.options.accessToken,
        protocols: [PROTOCOL_VERSION],
        capabilities: [...this.helloCapabilities],
        ...(this.options.clientVersion === undefined ? {} : { clientVersion: this.options.clientVersion }),
      })
      await withTimeout(
        helloAck.promise,
        this.options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS,
        () => new RemoteLinkError(LinkErrorCodes.CONNECTION_FAILED, '等待 hello.ack 超时。'),
      )
      this.helloWaiter = undefined

      const rtc = this.options.rtc
      const preferred: SelectedTransport[] = rtc?.mode === 'turn' ? ['turn'] : ['lan', 'p2p', 'turn']
      const direct = rtc === undefined || this.connectionId !== undefined ? []
        : preferred.filter(mode => this.negotiatedCapabilities.includes(`transport.${mode}`))
      this.rtcTransports = direct
      if (this.connectionId === undefined) {
        const accepted = new Deferred<string>()
        this.acceptedWaiter = accepted
        this.sendControl('connect.request', {
          hostDeviceId: this.options.hostDeviceId,
          preferredTransports: [...direct, 'relay'],
        })
        this.connectionId = await withTimeout(
          accepted.promise,
          this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
          () => new RemoteLinkError(LinkErrorCodes.CONNECTION_FAILED, '等待 connect.accepted 超时。'),
        )
        this.acceptedWaiter = undefined
      }

      if (rtc && direct.length > 0) {
        const mode = direct.includes('lan') || direct.includes('p2p') ? 'direct' : 'turn'
        this.transportMode = await this.openRtc(rtc, mode, direct)
      } else if (this.relayAssignment) {
        await this.openRelay(this.relayAssignment)
      }

      // §11：Initiator 必须先发 transport.selected，再开始 Noise 握手。
      this.sendControl('transport.selected', {
        connectionId: this.connectionId,
        targetDeviceId: this.options.hostDeviceId,
        transport: this.transportMode,
      })
      this.setPhase('control-ready')

      await this.runHandshake()
      for (const frame of this.pendingRtcFrames) this.receiveCiphertext(frame)
      this.pendingRtcFrames = []
      this.setPhase('secure')
    } catch (error) {
      const failure = asRemoteLinkError(error, LinkErrorCodes.CONNECTION_FAILED)
      this.fail(failure)
      throw failure
    }
  }

  private async openRelay(assignment: NonNullable<SecureChannel['relayAssignment']>): Promise<void> {
    const connectionId = this.requireConnectionId()
    const endpoint = new URL(assignment.url)
    if (endpoint.protocol !== 'wss:' || endpoint.username || endpoint.password || endpoint.hash || !this.options.relayBridge) {
      throw new RemoteLinkError(LinkErrorCodes.RELAY_UNAVAILABLE, 'Relay node URL is unavailable or invalid.')
    }
    const bridge = this.options.relayBridge(endpoint.href)
    this.relayBridge = bridge
    const ready = new Deferred<void>()
    this.relayWaiter = ready
    this.unsubscribes.push(bridge.onClose(() => {
      this.fail(new RemoteLinkError(LinkErrorCodes.TRANSPORT_CLOSED, 'Relay data socket closed.'))
    }))
    this.unsubscribes.push(bridge.onBinary(bytes => this.handleUnexpectedBinary(bytes)))
    this.unsubscribes.push(bridge.onText(text => {
      try {
        const frame = decodeRelayDataFrame(text, this.controlLimits)
        switch (frame.type) {
          case 'relay.ready':
            if (frame.payload.connectionId !== connectionId || (assignment.epoch !== undefined && frame.payload.epoch !== assignment.epoch)) {
              throw new RemoteLinkError(LinkErrorCodes.INVALID_MESSAGE, 'Relay node confirmed another connection.')
            }
            ready.resolve()
            break
          case 'ping':
            this.sendRelayData('pong', frame.payload)
            break
          case 'relay':
            this.onRelayFrame(frame.payload as unknown as RelayPayload)
            break
          case 'secure.handshake':
            this.onHandshakeFrame(frame.payload as unknown as SecureHandshakePayload)
            break
          case 'relay.detach':
            this.fail(new RemoteLinkError(LinkErrorCodes.TRANSPORT_CLOSED, 'Relay node detached the connection.'))
            break
          case 'error':
            this.onControlError(frame.payload as unknown as ControlErrorPayload)
            break
        }
      } catch (error) {
        this.fail(asRemoteLinkError(error, LinkErrorCodes.INVALID_MESSAGE))
      }
    }))
    const attaching = async () => {
      await bridge.open()
      this.sendRelayData('relay.attach', {
        connectionId, deviceId: this.options.clientDeviceId, peerDeviceId: this.options.hostDeviceId, ticket: assignment.ticket,
      })
    }
    try {
      await withTimeout(Promise.all([attaching(), ready.promise]), 8000,
        () => new RemoteLinkError(LinkErrorCodes.RELAY_UNAVAILABLE, 'Relay node attach timed out.'))
    } finally {
      this.relayWaiter = undefined
    }
  }

  private sendRelayData(type: string, payload: Record<string, unknown>): void {
    if (this.closed || !this.relayBridge) throw new RemoteLinkError(LinkErrorCodes.TRANSPORT_CLOSED, 'Relay data socket closed.')
    this.relayBridge.sendText(encodeRelayDataFrame(createRelayDataFrame(type, payload), this.controlLimits))
  }

  private async openRtc(options: NonNullable<SecureChannelOptions['rtc']>, mode: RtcMode,
    negotiated: readonly string[]): Promise<SelectedTransport> {
    const connectionId = this.requireConnectionId()
    const targetDeviceId = this.options.hostDeviceId
    const waiter = new Deferred<SelectedTransport>()
    this.rtcWaiter = waiter
    const setup = async (): Promise<SelectedTransport> => {
      const servers = await options.iceServers(connectionId)
      if (this.closed) throw this.closeError ?? new RemoteLinkError(LinkErrorCodes.TRANSPORT_CLOSED, 'WebRTC negotiation closed.')
      const iceServers = servers.flatMap(server => {
        const urls = typeof server.urls === 'string' ? [server.urls] : server.urls
        const usable = urls.filter(url => mode === 'direct' ? /^stuns?:/i.test(url) : /^turns?:/i.test(url))
        return usable.length > 0 ? [{ ...server, urls: usable }] : []
      })
      if (mode === 'turn' && iceServers.length === 0) throw new RtcUnavailable('No TURN server is available.')
      try {
        this.rtc = new RtcTransport({
          mode,
          iceServers,
          offer: sdp => this.sendControl('signal.offer', { connectionId, targetDeviceId, sdp }),
          candidate: candidate => this.sendControl('signal.ice', { connectionId, targetDeviceId, candidate }),
          ciphertext: bytes => {
            if (this.noise?.complete) {
              this.receiveCiphertext(bytes)
            } else if (this.step2Waiter && this.pendingRtcFrames.length < 16) {
              this.pendingRtcFrames.push(bytes)
            } else {
              throw new RemoteLinkError(LinkErrorCodes.SECURE_CHANNEL_FAILED, 'WebRTC ciphertext arrived before Noise was ready.')
            }
          },
          failed: error => this.fail(error),
        })
        const path = await this.rtc.open()
        if (negotiated.includes(path)) return path
        if (path === 'lan' && negotiated.includes('p2p')) return 'p2p'
        if (path === 'p2p' && negotiated.includes('lan')) return 'lan'
        throw new RtcUnavailable('The WebRTC path was not negotiated.')
      } catch (error) {
        if (error instanceof RemoteLinkError) throw error
        throw new RtcUnavailable('WebRTC could not negotiate a data channel.')
      }
    }
    try {
      const timeoutMs = Math.min(15_000, Math.max(options.timeoutMs ?? 4_000, this.rtcTimeoutMs))
      return await withTimeout(Promise.race([setup(), waiter.promise]), timeoutMs, () => new RtcUnavailable('WebRTC connection timed out.'))
    } finally {
      this.rtcWaiter = undefined
    }
  }

  private async runHandshake(): Promise<void> {
    const connectionId = this.requireConnectionId()
    const hostIdentityKey = this.options.hostIdentityKey
    if (hostIdentityKey === undefined) {
      // 契约 §3 的 SecureLinkOptions 原本没有这个字段，缺失时 fail-closed 而不是猜。
      throw new RemoteLinkError(
        LinkErrorCodes.PEER_IDENTITY_MISMATCH,
        '缺少 Host 静态公钥：请先用 GET /api/v1/devices/{hostDeviceId} 取 identityKey 并作为 hostIdentityKey 传入。',
      )
    }
    let noise: NoiseIkSession
    try {
      noise = new NoiseIkSession({
        role: 'initiator',
        localPrivateKey: this.options.device.privateKey,
        localPublicKey: this.options.device.publicKey,
        remotePublicKey: hostIdentityKey,
        prologue: createNoisePrologue(connectionId, this.options.hostDeviceId, this.options.clientDeviceId),
      })
    } catch (error) {
      throw new RemoteLinkError(
        readErrorCode(error) ?? LinkErrorCodes.SECURE_CHANNEL_FAILED,
        `Noise IK 初始化失败：${errorMessage(error)}`,
        { cause: error },
      )
    }
    this.noise = noise
    const step2 = new Deferred<Uint8Array>()
    this.step2Waiter = step2
    try {
      // §12.2：step 1 由 initiator 发出，经 Control 帧转给 Host。
      this.sendHandshake(1, noise.writeHandshake())
      const data = await withTimeout(
        step2.promise,
        this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
        () => new RemoteLinkError(LinkErrorCodes.SECURE_CHANNEL_FAILED, 'Noise IK 握手超时（等不到 step 2）。'),
      )
      noise.readHandshake(data)
      if (!noise.complete) {
        throw new RemoteLinkError(LinkErrorCodes.SECURE_CHANNEL_FAILED, 'Noise IK 握手未完成。')
      }
    } catch (error) {
      const failure = error instanceof RemoteLinkError
        ? error
        : new RemoteLinkError(
            readErrorCode(error) === LinkErrorCodes.PEER_IDENTITY_MISMATCH
              ? LinkErrorCodes.PEER_IDENTITY_MISMATCH
              : LinkErrorCodes.SECURE_CHANNEL_FAILED,
            `Noise IK 握手失败：${errorMessage(error)}`,
            { cause: error },
          )
      noise.destroy()
      this.noise = undefined
      throw failure
    } finally {
      this.step2Waiter = undefined
    }
  }

  // ── 入站 ──────────────────────────────────────────────────────────────────

  private handleControlText(text: string): void {
    if (this.closed) return
    let frame: ControlFrame
    try {
      frame = decodeControlFrame(text, this.controlLimits)
    } catch (error) {
      const message = errorMessage(error)
      // decodeControlFrame 的越限文案里带 "limit/exceeds"，映射成 §23 的 FRAME_TOO_LARGE。
      const limitHit = /limit|exceeds/i.test(message)
      this.fail(new RemoteLinkError(
        limitHit ? LinkErrorCodes.FRAME_TOO_LARGE : LinkErrorCodes.INVALID_MESSAGE,
        `Control 帧解码失败：${message || '不是合法 JSON'}`,
        { cause: error },
      ))
      return
    }
    this.controlFramesReceived += 1
    this.options.onControlFrame?.(frame.type, frame.payload)
    try {
      this.dispatchControl(frame)
    } catch (error) {
      this.fail(asRemoteLinkError(error, LinkErrorCodes.INVALID_MESSAGE))
    }
  }

  private dispatchControl(frame: ControlFrame): void {
    switch (frame.type) {
      case 'hello.ack':
        this.onHelloAck(frame.payload as HelloAckPayload)
        return
      case 'connect.accepted':
        this.onConnectAccepted(frame.payload as ConnectAcceptedPayload)
        return
      case 'connect.rejected':
        this.onConnectRejected(frame.payload as { code?: unknown; message?: unknown })
        return
      case 'error':
        this.onControlError(frame.payload as ControlErrorPayload)
        return
      case 'relay':
        if (this.rtc === undefined && this.relayBridge === undefined) this.onRelayFrame(frame.payload as RelayPayload)
        return
      case 'secure.handshake':
        this.onHandshakeFrame(frame.payload as SecureHandshakePayload)
        return
      case 'ping':
        // §22：pong 必须回显 nonce。
        this.sendControl('pong', frame.payload as { nonce: string })
        return
      case 'pong':
        return
      case 'transport.selected':
        // §11：Responder 也会上报一条，仅作通知；我们是 initiator，以自己的选择为准。
        return
      case 'signal.answer': {
        const signal = frame.payload as SignalPayload
        if (this.isCurrentSignal(signal)) void this.rtc?.answer(signal.sdp)
        return
      }
      case 'signal.ice': {
        const signal = frame.payload as SignalIcePayload
        if (this.isCurrentSignal(signal)) this.rtc?.candidate(signal.candidate)
        return
      }
      case 'signal.offer':
        return
      default:
        throw new RemoteLinkError(
          LinkErrorCodes.INVALID_MESSAGE,
          `secure channel 收到不允许的 Control 帧类型：${String(frame.type)}`,
        )
    }
  }

  private isCurrentSignal(signal: { connectionId: string; targetDeviceId: string }): boolean {
    return signal.connectionId === this.connectionId && signal.targetDeviceId === this.options.clientDeviceId
  }

  private onHelloAck(payload: HelloAckPayload): void {
    const waiter = this.helloWaiter
    if (waiter === undefined) {
      throw new RemoteLinkError(LinkErrorCodes.INVALID_MESSAGE, '收到了重复的 hello.ack。')
    }
    if (payload.protocol !== PROTOCOL_VERSION) {
      throw new RemoteLinkError(
        LinkErrorCodes.UNSUPPORTED_VERSION,
        `Server 选择了不支持的协议版本：${String(payload.protocol)}`,
      )
    }
    const maxControlFrameBytes = payload.maxControlFrameBytes
    const maxRelayFrameBytes = payload.maxRelayFrameBytes
    if (!Number.isSafeInteger(maxControlFrameBytes) || maxControlFrameBytes <= 0
      || maxControlFrameBytes > MAX_CONTROL_FRAME_BYTES) {
      throw new RemoteLinkError(
        LinkErrorCodes.INVALID_MESSAGE,
        `hello.ack 的 maxControlFrameBytes 非法（必须 ≤ ${MAX_CONTROL_FRAME_BYTES}）。`,
      )
    }
    if (!Number.isSafeInteger(maxRelayFrameBytes) || maxRelayFrameBytes <= 0
      || maxRelayFrameBytes > MAX_RELAY_FRAME_BYTES) {
      throw new RemoteLinkError(
        LinkErrorCodes.INVALID_MESSAGE,
        `hello.ack 的 maxRelayFrameBytes 非法（必须 ≤ ${MAX_RELAY_FRAME_BYTES}）。`,
      )
    }
    if (Number.isSafeInteger(payload.heartbeatIntervalMs) && payload.heartbeatIntervalMs > 0) {
      this.heartbeatIntervalMs = payload.heartbeatIntervalMs
    }
    this.controlLimits = { maxControlFrameBytes, maxRelayFrameBytes }
    try {
      // §10.3：hello.ack.capabilities 是交集，Server 不能返回没宣告过的能力。
      this.negotiatedCapabilities = acceptNegotiatedCapabilities([...this.helloCapabilities], payload.capabilities)
      if (payload.webrtcEnabled === false) {
        this.negotiatedCapabilities = this.negotiatedCapabilities.filter(capability => !RTC_CAPABILITIES.includes(capability))
      }
    } catch (error) {
      throw new RemoteLinkError(
        LinkErrorCodes.CAPABILITY_NOT_SUPPORTED,
        `Server 返回了未协商的能力集合：${errorMessage(error)}`,
        { cause: error },
      )
    }
    if (!this.negotiatedCapabilities.includes('transport.relay')) {
      throw new RemoteLinkError(
        LinkErrorCodes.CAPABILITY_NOT_SUPPORTED,
        'Server 没有协商出必须的 transport.relay。',
      )
    }
    this.rtcTimeoutMs = payload.webrtcFallbackTimeoutMs ?? 0
    waiter.resolve()
  }

  private onConnectAccepted(payload: ConnectAcceptedPayload): void {
    const waiter = this.acceptedWaiter
    if (waiter === undefined) {
      throw new RemoteLinkError(LinkErrorCodes.INVALID_MESSAGE, '收到了意外的 connect.accepted（没有在等）。')
    }
    if (typeof payload.connectionId !== 'string' || payload.connectionId.length === 0) {
      throw new RemoteLinkError(LinkErrorCodes.INVALID_MESSAGE, 'connect.accepted 缺少 connectionId。')
    }
    if ((payload.relayEndpoint !== undefined || payload.relayTicket !== undefined) && this.rtcTransports.length === 0) {
      if (!this.options.relayBridge || !this.negotiatedCapabilities.includes('transport.relay.attach') || !payload.relayEndpoint || !payload.relayTicket) {
        throw new RemoteLinkError(LinkErrorCodes.RELAY_UNAVAILABLE, 'Server returned an unsupported relay assignment.')
      }
      this.relayAssignment = { url: payload.relayEndpoint, ticket: payload.relayTicket, epoch: payload.relayEpoch }
    }
    this.acceptedWaiter = undefined
    this.rtcTimeoutMs = payload.webrtcFallbackTimeoutMs ?? this.rtcTimeoutMs
    waiter.resolve(payload.connectionId)
  }

  private onConnectRejected(payload: { code?: unknown; message?: unknown }): void {
    const code = typeof payload.code === 'string' && payload.code.length > 0
      ? payload.code
      : LinkErrorCodes.CONNECTION_FAILED
    const message = typeof payload.message === 'string' && payload.message.length > 0
      ? payload.message
      : 'Host 拒绝了连接。'
    const failure = new RemoteLinkError(code, message)
    this.acceptedWaiter?.reject(failure)
    this.acceptedWaiter = undefined
    throw failure
  }

  private onControlError(payload: ControlErrorPayload): void {
    const failure = new RemoteLinkError(
      typeof payload.code === 'string' && payload.code.length > 0 ? payload.code : LinkErrorCodes.INVALID_MESSAGE,
      typeof payload.message === 'string' && payload.message.length > 0 ? payload.message : 'Server 返回错误。',
      { retryable: payload.retryable === true, details: { connectionId: payload.connectionId } },
    )
    // §11：带 connectionId 的错误只作用于那条逻辑连接，别的连接不受影响。
    if (typeof payload.connectionId === 'string'
      && this.connectionId !== undefined
      && payload.connectionId !== this.connectionId) {
      return
    }
    this.acceptedWaiter?.reject(failure)
    this.helloWaiter?.reject(failure)
    this.acceptedWaiter = undefined
    this.helloWaiter = undefined
    throw failure
  }

  private onRelayFrame(payload: RelayPayload): void {
    const connectionId = this.requireConnectionId()
    if (payload.connectionId !== connectionId) {
      throw new RemoteLinkError(LinkErrorCodes.INVALID_MESSAGE, 'relay 帧的 connectionId 与本连接不匹配。')
    }
    if (payload.targetDeviceId !== this.options.clientDeviceId) {
      throw new RemoteLinkError(LinkErrorCodes.INVALID_MESSAGE, 'relay 帧的 targetDeviceId 不是本机。')
    }
    if (!Number.isSafeInteger(payload.counter) || payload.counter < 0) {
      throw new RemoteLinkError(LinkErrorCodes.INVALID_MESSAGE, 'relay 帧的 counter 非法。')
    }
    if (typeof payload.ciphertext !== 'string') {
      throw new RemoteLinkError(LinkErrorCodes.INVALID_MESSAGE, 'relay 帧缺少 ciphertext。')
    }
    const ciphertext = fromBase64Url(payload.ciphertext)
    this.lastInboundCounter = payload.counter
    this.relayFramesReceived += 1
    this.receiveCiphertext(ciphertext)
  }

  private receiveCiphertext(ciphertext: Uint8Array): void {
    const noise = this.noise
    if (noise === undefined || !noise.complete) {
      throw new RemoteLinkError(LinkErrorCodes.SECURE_CHANNEL_FAILED, 'Noise 未完成前收到了加密数据。')
    }
    let message: Uint8Array | undefined
    try {
      // 重放 / 过旧 / 认证失败都从这里抛出（Noise 内部状态才是权威依据，§13）。
      const plaintext = noise.decrypt(ciphertext)
      message = this.codecIn.decode(plaintext)
    } catch (error) {
      throw new RemoteLinkError(
        LinkErrorCodes.SECURE_CHANNEL_FAILED,
        `Noise 解密或分片重组失败：${errorMessage(error)}`,
        { cause: error },
      )
    }
    if (message === undefined) return // 还在等后续分片
    this.plaintextBytesReceived += message.byteLength
    for (const handler of this.messageHandlers) handler(message)
  }

  private onHandshakeFrame(payload: SecureHandshakePayload): void {
    const connectionId = this.requireConnectionId()
    if (payload.connectionId !== connectionId) {
      throw new RemoteLinkError(LinkErrorCodes.INVALID_MESSAGE, 'secure.handshake 的 connectionId 不匹配。')
    }
    if (payload.targetDeviceId !== this.options.clientDeviceId) {
      throw new RemoteLinkError(LinkErrorCodes.INVALID_MESSAGE, 'secure.handshake 的 targetDeviceId 不是本机。')
    }
    if (payload.step !== 2) {
      // 我们是 initiator，step 1 只由自己发出。
      throw new RemoteLinkError(LinkErrorCodes.INVALID_MESSAGE, `Noise step ${String(payload.step)} 不该由 Host 发出。`)
    }
    if (typeof payload.data !== 'string' || payload.data.length > MAX_HANDSHAKE_FRAME_CHARS) {
      throw new RemoteLinkError(LinkErrorCodes.INVALID_MESSAGE, 'secure.handshake 的 data 长度非法。')
    }
    const noise = this.noise
    const waiter = this.step2Waiter
    if (noise === undefined || waiter === undefined) {
      throw new RemoteLinkError(LinkErrorCodes.INVALID_MESSAGE, '收到了意外的 secure.handshake。')
    }
    if (noise.complete) {
      throw new RemoteLinkError(LinkErrorCodes.INVALID_MESSAGE, 'Noise 已完成，拒绝重复的握手帧。')
    }
    // 这里只把原始字节交给 runHandshake 去读：Noise 的读时机必须由 initiator 自己的
    // 握手流程串起来，不能在两个地方各读一次（会触发 NOISE_ALREADY_READY）。
    waiter.resolve(fromBase64Url(payload.data))
  }

  private handleUnexpectedBinary(bytes: Uint8Array): void {
    this.fail(new RemoteLinkError(
      LinkErrorCodes.INVALID_MESSAGE,
      `Relay WebSocket received a ${bytes.byteLength} B binary frame where JSON was expected.`,
    ))
  }

  // ── 发送与收尾 ────────────────────────────────────────────────────────────

  private sendControl(type: ControlFrameType, payload: unknown): void {
    if (this.closed) {
      throw new RemoteLinkError(LinkErrorCodes.TRANSPORT_CLOSED, '安全通道已关闭。')
    }
    let encoded: string
    try {
      encoded = encodeControlFrame(createControlFrame(type, payload), this.controlLimits)
    } catch (error) {
      const message = errorMessage(error)
      const limitHit = /limit|exceeds/i.test(message)
      const failure = new RemoteLinkError(
        limitHit ? LinkErrorCodes.FRAME_TOO_LARGE : LinkErrorCodes.INVALID_MESSAGE,
        `Control 帧编码失败（${type}）：${message}`,
        { cause: error },
      )
      this.fail(failure)
      throw failure
    }
    this.bridge.sendText(encoded)
    this.controlFramesSent += 1
  }

  private sendHandshake(step: 1 | 2, data: Uint8Array): void {
    this.sendControl('secure.handshake', {
      connectionId: this.requireConnectionId(),
      targetDeviceId: this.options.hostDeviceId,
      step,
      data: toBase64Url(data),
    })
  }

  private requireSecure(): void {
    if (this.closed) {
      throw new RemoteLinkError(LinkErrorCodes.TRANSPORT_CLOSED, '安全通道已关闭。')
    }
    if (!this.isSecure) {
      throw new RemoteLinkError(
        LinkErrorCodes.TRANSPORT_CLOSED,
        `安全通道尚未就绪（当前 phase=${this.channelPhase}）。`,
      )
    }
  }

  private requireConnectionId(): string {
    if (this.connectionId === undefined) {
      throw new RemoteLinkError(LinkErrorCodes.INVALID_MESSAGE, 'connectionId 尚未确定。')
    }
    return this.connectionId
  }

  private validateIdentityKey(): void {
    const key = this.options.hostIdentityKey
    if (key === undefined) return // 交给 runHandshake 报更准确的错
    if (!IDENTITY_KEY_PATTERN.test(key)) {
      throw new RemoteLinkError(
        LinkErrorCodes.PEER_IDENTITY_MISMATCH,
        'hostIdentityKey 不是 32 字节 X25519 公钥的规范 base64url（§7 / §12.1）。',
      )
    }
  }

  private setPhase(phase: Exclude<SecureChannelPhase, 'idle' | 'closed'>, detail?: string): void {
    if (this.channelPhase === phase) return
    this.channelPhase = phase
    this.options.onPhase?.(phase, detail)
  }

  private fail(error: RemoteLinkError, notify = true): void {
    if (this.closed) return
    this.closeError = error
    this.teardown()
    if (notify) this.options.onClose?.(error)
  }

  private teardown(): void {
    this.closed = true
    this.channelPhase = 'closed'
    const failure = this.closeError ?? new RemoteLinkError(LinkErrorCodes.TRANSPORT_CLOSED, '安全通道已关闭。')
    this.helloWaiter?.reject(failure)
    this.acceptedWaiter?.reject(failure)
    this.step2Waiter?.reject(failure)
    this.rtcWaiter?.reject(failure)
    this.relayWaiter?.reject(failure)
    this.rtc?.close()
    this.pendingRtcFrames = []
    this.helloWaiter = undefined
    this.acceptedWaiter = undefined
    this.step2Waiter = undefined
    this.noise?.destroy()
    this.noise = undefined
    this.codecIn.reset()
    this.codecOut.reset()
    this.messageHandlers.clear()
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe()
    try { this.relayBridge?.close() } catch { /* The relay socket may have closed already. */ }
    try {
      this.bridge.close()
    } catch {
      // 桥可能已经断了。
    }
  }
}

// ── 小工具 ────────────────────────────────────────────────────────────────

/** 可外部结算的 Promise（send 前后都要能拒，避免竞态）。 */
class Deferred<T> {
  private settled = false
  private resolveFn!: (value: T) => void
  private rejectFn!: (error: unknown) => void
  readonly promise: Promise<T>

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolveFn = resolve
      this.rejectFn = reject
    })
  }

  resolve(value: T): void {
    if (this.settled) return
    this.settled = true
    this.resolveFn(value)
  }

  reject(error: unknown): void {
    if (this.settled) return
    this.settled = true
    this.rejectFn(error)
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, makeError: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(makeError()), timeoutMs)
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error as Error)
      },
    )
  })
}
