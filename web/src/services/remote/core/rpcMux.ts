/**
 * Secure Channel 之上的 RPC 多路复用层。
 *
 * 依据 `docs/protocol.md`：
 *   §15 Remote Message Envelope（rpc.request / rpc.response / rpc.error / event）
 *   §16 RPC（每个 request 恰好一个 response 或 error；按 requestId 关联；超时后丢弃晚到响应）
 *   §20 Events（harness.remote.frame / harness.remote.stream.closed）
 *   §22 Ping/Pong（Control 心跳默认 25 s，75 s 无有效 pong 即断开）
 *   §24 默认限制（同连接 pending RPC 128、同连接 stream 16）
 *
 * 结构对照 `packages/client-core/src/index.ts`（RemoteClientCore）+ `remote-gateway.ts`（流）。
 */

import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_DISCONNECT_MS,
  MAX_ALPHA_STREAMS_PER_CONNECTION,
  MAX_PENDING_RPC_PER_CONNECTION,
  createRpcRequest,
  decodeMessage,
  type EventPayload,
  type RemoteMessage,
  type RpcErrorPayload,
  type RpcMethod,
  type RpcResponsePayload,
} from '../../../vendor/dsh-remote/protocol/index.js'
import {
  LinkErrorCodes,
  RemoteLinkError,
  asRemoteLinkError,
  errorMessage,
} from './errors.js'

/** 单次 RPC 的默认预算（与 `RemoteClientCore` 的默认一致）。 */
export const DEFAULT_RPC_TIMEOUT_MS = 30_000
/** 关流 RPC 的预算：链路已在收尾时不能等满整条默认超时。 */
const STREAM_CLOSE_TIMEOUT_MS = 5_000
/** `setTimeout` 的上限（2^31-1 ms）。 */
const MAX_TIMER_MS = 2_147_483_647
/** 心跳阈值下限（与参考实现一致：`max(15 s, interval × 3)`）。 */
const MIN_HEARTBEAT_TIMEOUT_MS = 15_000
/** 迟到帧的 stream id 记忆上限（丢掉关流后仍在路上的帧，不打扰上层）。 */
const MAX_RECENT_CLOSED_STREAMS = 64

const STREAM_CLOSE_REASONS = new Set(['cancelled', 'completed', 'failed', 'peer-disconnected'])

/** 流被远端终止的原因（§20 的固定枚举）。 */
export type StreamCloseReason = 'cancelled' | 'completed' | 'failed' | 'peer-disconnected'

/** `harness.remote.frame`：流的一个 item。`hasValue=false` 表示这一拍没有数据（§20）。 */
export interface StreamFrameEvent {
  type: 'frame'
  hasValue: boolean
  value?: unknown
  /** `harness.remote.stream.transfer.v1` 的分块描述（未声明该能力时不会出现）。 */
  transfer?: unknown
}

/** `harness.remote.stream.closed`：流结束（或被本地 close 掉）。 */
export interface StreamClosedEvent {
  type: 'closed'
  reason: StreamCloseReason
  failure?: { code: string; message: string; details?: unknown }
}

export type StreamEventPayload = StreamFrameEvent | StreamClosedEvent

/** `openStream()` 的返回值。 */
export interface RemoteStreamHandle {
  readonly streamId: string
  /** 关流：本地先按 `cancelled` 收尾，再尽力通知 Host（失败不抛）。 */
  close(): Promise<void>
}

export interface RpcCallOptions {
  /** 单次调用预算；非法值回落到默认值（不抛错，避免 UI 因一个笔误炸掉）。 */
  timeoutMs?: number
  /** 取消：以 `RPC_ABORTED` 拒绝。 */
  signal?: AbortSignal
}

export interface HeartbeatConfig {
  /** ping 间隔；缺省用 hello.ack 的 `heartbeatIntervalMs`（25 s）。 */
  intervalMs?: number
  /** 断开阈值；缺省 `max(15 s, intervalMs × 3)`（默认 75 s，§22）。 */
  timeoutMs?: number
  /** 发 Control ping（不回 pong 也算断开，见 §22）。 */
  sendPing?: (nonce: string) => void
  onTimeout: (error: RemoteLinkError) => void
}

export interface RpcMuxOptions {
  /** 明文帧发送（由 `SecureChannel.sendEnvelope` 注入）。 */
  send: (envelope: unknown) => void
  onStreamEvent?: (streamId: string, payload: StreamEventPayload) => void
  /** 本层没有内部消费掉的明文帧（未注册 stream 的帧、未知事件、未知消息类型）。 */
  onUnhandledFrame?: (frame: unknown) => void
  /** 协议违规：调用方必须关闭 secure channel（fail-closed）。 */
  onFatal?: (error: RemoteLinkError) => void
  rpcTimeoutMs?: number
}

interface PendingCall {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  removeAbort?: () => void
}

interface StreamEntry {
  streamId: string
  closed: boolean
}

export class RpcMux {
  private readonly pending = new Map<string, PendingCall>()
  private readonly streams = new Map<string, StreamEntry>()
  private readonly recentlyClosed = new Set<string>()
  private readonly options: RpcMuxOptions
  private readonly defaultTimeoutMs: number
  private heartbeat: HeartbeatMonitor | undefined
  private closed = false
  private closeError: RemoteLinkError | undefined

  constructor(options: RpcMuxOptions) {
    this.options = options
    this.defaultTimeoutMs = normalizeTimeoutMs(options.rpcTimeoutMs) ?? DEFAULT_RPC_TIMEOUT_MS
  }

  get isClosed(): boolean {
    return this.closed
  }

  get pendingCount(): number {
    return this.pending.size
  }

  get streamCount(): number {
    return this.streams.size
  }

  /** 请求-响应：自动分配 requestId、超时、错误码直传（§16）。 */
  async rpc<T = unknown>(method: string, params?: unknown, options?: RpcCallOptions): Promise<T> {
    if (this.closed) throw this.closeFailure()
    const signal = options?.signal
    if (signal?.aborted) {
      throw new RemoteLinkError(LinkErrorCodes.RPC_ABORTED, `RPC ${method} 在发出前已被取消。`)
    }
    if (this.pending.size >= MAX_PENDING_RPC_PER_CONNECTION) {
      throw new RemoteLinkError(
        LinkErrorCodes.RATE_LIMITED,
        `同连接 pending RPC 已达 §24 上限（${MAX_PENDING_RPC_PER_CONNECTION}）。`,
      )
    }
    const timeoutMs = normalizeTimeoutMs(options?.timeoutMs) ?? this.defaultTimeoutMs
    const request = createRpcRequest(method as RpcMethod, params === undefined ? {} : params)
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        // 超时后条目立即移除：晚到的 response/error 按 §16 直接丢弃。
        this.rejectPending(request.id, new RemoteLinkError(
          LinkErrorCodes.RPC_TIMEOUT,
          `RPC ${method} 在 ${timeoutMs}ms 内没有 response/error。`,
        ))
      }, timeoutMs)
      const call: PendingCall = {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      }
      if (signal !== undefined) {
        const onAbort = () => {
          if (this.pending.get(request.id) !== call) return
          this.rejectPending(request.id, new RemoteLinkError(
            LinkErrorCodes.RPC_ABORTED,
            `RPC ${method} 已被取消。`,
            { cause: signal.reason },
          ))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        call.removeAbort = () => signal.removeEventListener('abort', onAbort)
      }
      this.pending.set(request.id, call)
      // 发出失败（如超限）必须当场结算，不能挂在 pending 里等超时。
      try {
        this.options.send(request)
      } catch (error) {
        this.rejectPending(request.id, asRemoteLinkError(error, LinkErrorCodes.TRANSPORT_CLOSED))
      }
    })
  }

  /** 透传发送一帧明文 JSON（`SecureLink.sendFrame`）。 */
  sendEnvelope(envelope: unknown): void {
    if (this.closed) throw this.closeFailure()
    this.options.send(envelope)
  }

  /**
   * 开流（§20 / §16）。
   *
   * `streamId` 由客户端生成（UUID，§16.1 `payload.streamId`），数据通过
   * `onStreamEvent` 回调；Host 在 open RPC 返回前就已经注册了流，
   * 所以失败时也要尽力发一次 `harness.remote.stream.close` 释放槽位。
   */
  async openStream(endpoint: string, payload: unknown, options?: RpcCallOptions): Promise<RemoteStreamHandle> {
    if (this.closed) throw this.closeFailure()
    if (this.streams.size >= MAX_ALPHA_STREAMS_PER_CONNECTION) {
      throw new RemoteLinkError(
        LinkErrorCodes.RATE_LIMITED,
        `同连接 stream 已达 §24 上限（${MAX_ALPHA_STREAMS_PER_CONNECTION}）。`,
      )
    }
    const streamId = newRemoteId()
    const entry: StreamEntry = { streamId, closed: false }
    this.streams.set(streamId, entry)
    try {
      await this.rpc('harness.remote.stream.open', { streamId, endpoint, payload }, options)
    } catch (error) {
      this.streams.delete(streamId)
      void this.rpc('harness.remote.stream.close', { streamId }, { timeoutMs: STREAM_CLOSE_TIMEOUT_MS })
        .catch(() => undefined)
      throw error
    }
    return {
      streamId,
      close: async () => {
        await this.closeStream(streamId)
      },
    }
  }

  /** 收到一帧已解密的明文（由 `SecureChannel.onMessage` 驱动）。 */
  handlePlaintext(plaintext: Uint8Array): void {
    if (this.closed) return
    let message: RemoteMessage
    try {
      message = decodeMessage(plaintext)
    } catch (error) {
      if (this.answerLegacyPing(plaintext)) return
      this.fatal(new RemoteLinkError(
        LinkErrorCodes.INVALID_MESSAGE,
        `无法解析明文帧：${errorMessage(error) || '不是合法的 Remote message JSON'}`,
        { cause: error },
      ))
      return
    }
    switch (message.type) {
      case 'rpc.response':
        this.onResponse(message.payload as RpcResponsePayload)
        return
      case 'rpc.error':
        this.onError(message.payload as RpcErrorPayload)
        return
      case 'event':
        this.onEvent(message, message.payload as EventPayload)
        return
      default:
        // 未知但结构合法的类型交给上层（当前 schema 只放行 4 类，正常走不到这里）。
        this.unhandled(message)
    }
  }

  /** 开始心跳判定（在 secure channel 就绪后调用）。 */
  startHeartbeat(config: HeartbeatConfig): void {
    if (this.closed) return
    this.heartbeat?.stop()
    this.heartbeat = new HeartbeatMonitor(config)
    this.heartbeat.start()
  }

  /** 收到任何 Control 帧都算「对端还活着」（§22 的 75 s 判定）。 */
  touch(): void {
    this.heartbeat?.touch()
  }

  stopHeartbeat(): void {
    this.heartbeat?.stop()
    this.heartbeat = undefined
  }

  /** 关闭：拒绝所有 pending、按 `peer-disconnected` 收尾所有流（§21 的断开清理）。 */
  close(error?: RemoteLinkError): void {
    if (this.closed) return
    this.closed = true
    this.closeError = error ?? new RemoteLinkError(LinkErrorCodes.TRANSPORT_CLOSED, '远程链路已关闭。')
    this.stopHeartbeat()
    this.rejectAllPending(pending => new RemoteLinkError(
      this.closeError!.code,
      `RPC ${pending.method} 因链路关闭而终止：${this.closeError!.message}`,
      { cause: this.closeError },
    ))
    for (const entry of [...this.streams.values()]) {
      entry.closed = true
      this.emitStream(entry, { type: 'closed', reason: 'peer-disconnected' })
    }
    this.streams.clear()
  }

  get failure(): RemoteLinkError | undefined {
    return this.closeError
  }

  // ── 入站分发 ──────────────────────────────────────────────────────────────

  private onResponse(payload: RpcResponsePayload): void {
    const call = this.takePending(payload.requestId)
    if (call === undefined) return // 超时/取消后的晚到响应：丢弃（§16.2）
    call.resolve(payload.result)
  }

  private onError(payload: RpcErrorPayload): void {
    const call = this.takePending(payload.requestId)
    if (call === undefined) return
    call.reject(new RemoteLinkError(
      typeof payload.code === 'string' && payload.code.length > 0 ? payload.code : LinkErrorCodes.INTERNAL_ERROR,
      typeof payload.message === 'string' && payload.message.length > 0 ? payload.message : 'Host 返回了未命名的错误。',
      { retryable: payload.retryable === true, details: payload.details, fromHost: true },
    ))
  }

  private onEvent(message: RemoteMessage, payload: EventPayload): void {
    if (payload.event === 'harness.remote.frame') {
      this.onStreamFrame(message, payload.data)
      return
    }
    if (payload.event === 'harness.remote.stream.closed') {
      this.onStreamClosed(payload.data)
      return
    }
    // 其它事件（codex.app.* / agent.acp.* 等）本层不解析，交给上层投影。
    this.unhandled(message)
  }

  private onStreamFrame(message: RemoteMessage, data: unknown): void {
    if (!isRecord(data) || typeof data.streamId !== 'string') {
      this.fatal(new RemoteLinkError(LinkErrorCodes.INVALID_MESSAGE, 'harness.remote.frame 缺少 streamId。'))
      return
    }
    const entry = this.streams.get(data.streamId)
    if (entry === undefined) {
      if (this.recentlyClosed.has(data.streamId)) return // 关流后仍在路上的帧：丢弃
      this.unhandled(message)
      return
    }
    if (entry.closed) return
    this.emitStream(entry, {
      type: 'frame',
      hasValue: data.hasValue === true,
      ...(Object.hasOwn(data, 'value') ? { value: data.value } : {}),
      ...(Object.hasOwn(data, 'transfer') ? { transfer: data.transfer } : {}),
    })
  }

  private onStreamClosed(data: unknown): void {
    if (!isRecord(data) || typeof data.streamId !== 'string') {
      this.fatal(new RemoteLinkError(LinkErrorCodes.INVALID_MESSAGE, 'harness.remote.stream.closed 缺少 streamId。'))
      return
    }
    const reason = typeof data.reason === 'string' && STREAM_CLOSE_REASONS.has(data.reason)
      ? data.reason as StreamCloseReason
      : undefined
    if (reason === undefined) {
      this.fatal(new RemoteLinkError(
        LinkErrorCodes.INVALID_MESSAGE,
        `harness.remote.stream.closed 的 reason 非法：${String(data.reason)}`,
      ))
      return
    }
    const entry = this.streams.get(data.streamId)
    if (entry === undefined) {
      if (this.recentlyClosed.has(data.streamId)) return
      this.unhandled({ type: 'event', payload: { event: 'harness.remote.stream.closed', data } })
      return
    }
    this.streams.delete(data.streamId)
    entry.closed = true
    this.rememberClosed(data.streamId)
    const failure = isRecord(data.failure)
      ? {
          code: typeof data.failure.code === 'string' ? data.failure.code : LinkErrorCodes.INTERNAL_ERROR,
          message: typeof data.failure.message === 'string' ? data.failure.message : '远端流失败。',
          details: data.failure.details,
        }
      : undefined
    this.emitStream(entry, {
      type: 'closed',
      reason,
      ...(failure === undefined ? {} : { failure }),
    })
  }

  /**
   * §15 把 `ping` / `pong` 也列为 Remote message 类型，但 `packages/protocol` 的
   * `messageTypes` 只有 4 类（schema 解码会抛）。Host 当前不发 ping（§22：应用层
   * `connection.ping` 已退役），这里只做兼容：能认出来就回 pong，不因此关链。
   */
  private answerLegacyPing(plaintext: Uint8Array): boolean {
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
    } catch {
      return false
    }
    if (!text.includes('"ping"')) return false
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      return false
    }
    if (!isRecord(value) || value.type !== 'ping' || typeof value.id !== 'string') return false
    try {
      this.options.send({
        v: 1,
        id: newRemoteId(),
        type: 'pong',
        timestamp: Date.now(),
        payload: isRecord(value.payload) ? value.payload : {},
      })
      return true
    } catch {
      return false
    }
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  private async closeStream(streamId: string): Promise<void> {
    const entry = this.streams.get(streamId)
    if (entry === undefined) return
    this.streams.delete(streamId)
    this.rememberClosed(streamId)
    entry.closed = true
    // 本地消费方先按 cancelled 收尾，再去通知 Host（Host 也会回一条 stream.closed，届时已被吞掉）。
    this.emitStream(entry, { type: 'closed', reason: 'cancelled' })
    if (this.closed) return
    await this.rpc('harness.remote.stream.close', { streamId }, { timeoutMs: STREAM_CLOSE_TIMEOUT_MS })
      .catch(() => undefined)
  }

  private emitStream(entry: StreamEntry, payload: StreamEventPayload): void {
    try {
      this.options.onStreamEvent?.(entry.streamId, payload)
    } catch {
      // 上层回调异常不能打断入站分发（关链由它自己的状态机决定）。
    }
  }

  private unhandled(frame: unknown): void {
    try {
      this.options.onUnhandledFrame?.(frame)
    } catch {
      // 同上。
    }
  }

  private fatal(error: RemoteLinkError): void {
    this.close(error)
    try {
      this.options.onFatal?.(error)
    } catch {
      // 同样的道理：收尾失败不再扩散。
    }
  }

  private rememberClosed(streamId: string): void {
    this.recentlyClosed.add(streamId)
    if (this.recentlyClosed.size > MAX_RECENT_CLOSED_STREAMS) {
      const oldest = this.recentlyClosed.values().next()
      if (!oldest.done) this.recentlyClosed.delete(oldest.value)
    }
  }

  private takePending(requestId: string): PendingCall | undefined {
    const call = this.pending.get(requestId)
    if (call === undefined) return undefined
    this.pending.delete(requestId)
    clearTimeout(call.timer)
    call.removeAbort?.()
    return call
  }

  private rejectPending(requestId: string, error: Error): boolean {
    const call = this.takePending(requestId)
    if (call === undefined) return false
    call.reject(error)
    return true
  }

  private rejectAllPending(makeError: (call: PendingCall) => Error): void {
    for (const requestId of [...this.pending.keys()]) {
      const call = this.takePending(requestId)
      if (call !== undefined) call.reject(makeError(call))
    }
  }

  private closeFailure(): RemoteLinkError {
    return this.closeError ?? new RemoteLinkError(LinkErrorCodes.TRANSPORT_CLOSED, '远程链路已关闭。')
  }
}

// ── 心跳 ──────────────────────────────────────────────────────────────────

/**
 * Control 心跳监控（§22）。
 *
 * 参考实现对「上界」的定义是 `max(15 s, interval × 3)`：默认 25 s 间隔 → 75 s 断开。
 * 这里用 `touch()` 记录最后一次收到 **任何** Control 帧的时间（Server 每 25 s 会发 ping，
 * 我们也按间隔发 ping 探测单向死亡），超过阈值即判定断开。
 */
export class HeartbeatMonitor {
  private timer: ReturnType<typeof setInterval> | undefined
  private lastActivityAt = 0
  private lastPingAt = 0
  private intervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS
  private timeoutMs = HEARTBEAT_DISCONNECT_MS
  private seq = 0
  private stopped = false

  constructor(private readonly config: HeartbeatConfig) {}

  get interval(): number {
    return this.intervalMs
  }

  get timeout(): number {
    return this.timeoutMs
  }

  start(): void {
    if (this.timer !== undefined) return
    this.stopped = false
    this.intervalMs = normalizeTimeoutMs(this.config.intervalMs) ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    this.timeoutMs = normalizeTimeoutMs(this.config.timeoutMs)
      ?? Math.max(MIN_HEARTBEAT_TIMEOUT_MS, this.intervalMs * 3)
    const now = Date.now()
    this.lastActivityAt = now
    this.lastPingAt = now
    // 用固定 tick 检查阈值：tick 不大于 5 s，也不大于间隔本身（测试里可以开到几十毫秒）。
    const tickMs = Math.max(25, Math.min(this.intervalMs, 5_000))
    this.timer = setInterval(() => this.check(), tickMs)
    // Node（自测）下不要让定时器吊住进程；浏览器没有 unref，可选链直接跳过。
    ;(this.timer as unknown as { unref?: () => void }).unref?.()
  }

  touch(): void {
    this.lastActivityAt = Date.now()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  private check(): void {
    if (this.stopped) return
    const now = Date.now()
    const elapsed = now - this.lastActivityAt
    if (elapsed >= this.timeoutMs) {
      this.stop()
      this.config.onTimeout(new RemoteLinkError(
        LinkErrorCodes.CONNECTION_FAILED,
        `Control 心跳超时：${elapsed}ms 没有收到任何 Control 帧（阈值 ${this.timeoutMs}ms，§22）。`,
      ))
      return
    }
    if (this.config.sendPing === undefined) return
    if (now - this.lastPingAt < this.intervalMs) return
    this.lastPingAt = now
    this.seq += 1
    try {
      this.config.sendPing(`hb-${this.seq}-${now.toString(36)}`)
    } catch {
      // 发不出去说明通道已经坏了：让下一轮阈值判定负责收尾。
    }
  }
}

// ── 工具 ──────────────────────────────────────────────────────────────────

function normalizeTimeoutMs(value: number | undefined): number | undefined {
  if (typeof value !== 'number') return undefined
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_MS) return undefined
  return value
}

/** 客户端生成的 stream/请求 id（§4.2：UUIDv7/ULID；这里优先用平台 randomUUID）。 */
export function newRemoteId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (typeof uuid === 'string' && uuid.length > 0) return uuid
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
