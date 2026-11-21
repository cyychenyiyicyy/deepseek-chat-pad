/**
 * 本机原生 WebSocket 桥的浏览器侧客户端。
 *
 * 契约：`work/2026-11-21-chatpad接入DSH远程/plan-P0P1-实施契约.md` §2（S1 实现、S2 消费）。
 *
 * 为什么要这层桥：浏览器不能给 WebSocket 带 `Authorization` / `Origin` 头
 * （契约 §6 风险 1、2），所以页面只连本机原生桥
 * `ws://127.0.0.1:<LocalServer 端口>/__ds_remote/ws`，由原生侧带着 header 去连远端
 * `wss://…`。device access token 只出现在桥的 `connect` 帧里，**绝不进 URL、不落日志**。
 *
 * 桥控制帧（原生 → 页面）：
 *   {"type":"open"}                                  远端已连上，后续帧开始透传
 *   {"type":"error","code":"…","message":"…"}        连接失败（随后原生会关连接）
 *   {"type":"close","code":1000,"reason":"…"}        远端已关闭
 *
 * 页面 → 原生：`{"type":"connect","url","headers"}` 与 `{"type":"close"}`；其余一律透传。
 *
 * 帧类型判定：桥控制帧只在 **同时** 满足下列三条时才成立 ——
 *   (a) `type` ∈ {open, error, close}；
 *   (b) 对象里没有 `v` 字段；
 *   (c) 对象里没有 `payload` 字段。
 * DSH 的 Control 帧（§10.2）恒带 `v` / `timestamp` / `payload`，其中也有 `type:"error"`，
 * 因此这条规则能把它和桥的 `{"type":"error","code":…}` 区分开，不会互相吃掉。
 */

import { MAX_RELAY_FRAME_BYTES } from '../../../vendor/dsh-remote/protocol/index.js'
import { LinkErrorCodes, RemoteLinkError, errorMessage } from './errors.js'

/** 桥控制帧路径（与契约 §2 一致，S1 的 `LocalServer.dispatch()` 按此挂载）。 */
export const BRIDGE_WS_PATH = '/__ds_remote/ws'

/** 原生桥回 `{"type":"open"}` 的默认预算（含 TCP 连接 + 远端 TLS/WS 握手）。 */
const DEFAULT_OPEN_TIMEOUT_MS = 15_000

/** `WebSocket.OPEN` 的数值；不直接引用全局常量，避免无 WebSocket 的运行时在 import 期就炸。 */
const WS_OPEN = 1

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

const BRIDGE_CONTROL_TYPES = new Set(['open', 'error', 'close'])

export type BridgePhase = 'idle' | 'connecting' | 'open' | 'closed'

/** 桥关闭的原因（原生 close 帧，或本层判定的失败）。 */
export interface BridgeCloseInfo {
  /** 原生 close 帧的 code；本地主动关闭为 1000，未给出为 0。 */
  code: number
  /** 可读原因（原生 reason，或本层给出的描述；**不含** token/密钥）。 */
  reason: string
  /** 桥/链路层错误码：原生 error 帧的 `code`，或本层补充的码。 */
  detailCode?: string
}

export interface BridgeSocketOptions {
  /** 远端 DSH Control WS 地址（`wss://<server>/ws/v1/connect`）。 */
  url: string
  /** 交给原生桥的请求头（`Authorization` / `Origin`）。 */
  headers: Record<string, string>
  /** 本机原生桥地址；缺省按当前页面地址推导（`ws://127.0.0.1:<location.port>/__ds_remote/ws`）。 */
  bridgeUrl?: string
  /** 等原生桥 `{"type":"open"}` 的超时。 */
  openTimeoutMs?: number
  /** 单帧上限（契约 §2：1 MiB，与 `MAX_RELAY_FRAME_BYTES` 一致）。 */
  maxFrameBytes?: number
}

type TextHandler = (text: string) => void
type BinaryHandler = (bytes: Uint8Array) => void
type CloseHandler = (info: BridgeCloseInfo) => void

/**
 * 原生桥的抽象。上层（`SecureChannel`）只依赖这个接口，
 * 因此自测可以换成内存 socket 对（`__selftest__`），不需要真的起 WebSocket。
 */
export interface BridgeSocket {
  readonly phase: BridgePhase
  /** 连本机桥并等 `{"type":"open"}`；失败时 reject（不会触发 close 回调）。 */
  open(): Promise<void>
  sendText(text: string): void
  sendBinary(bytes: Uint8Array): void
  /** 注册透传的文本帧；返回退订函数。 */
  onText(handler: TextHandler): () => void
  /** 注册透传的二进制帧；返回退订函数。 */
  onBinary(handler: BinaryHandler): () => void
  /** 注册关闭事件（只在已经 `open` 之后触发）；返回退订函数。 */
  onClose(handler: CloseHandler): () => void
  close(): void
}

/** 按契约 §2 创建一个走本机原生桥的 `BridgeSocket`（只用浏览器 `WebSocket`）。 */
export function createBridgeSocket(options: BridgeSocketOptions): BridgeSocket {
  return new NativeBridgeSocket(options)
}

class NativeBridgeSocket implements BridgeSocket {
  private socket: WebSocket | undefined
  private bridgePhase: BridgePhase = 'idle'
  private openPromise: Promise<void> | undefined
  private resolveOpen: (() => void) | undefined
  private rejectOpen: ((error: Error) => void) | undefined
  private openTimer: ReturnType<typeof setTimeout> | undefined
  private closeEmitted = false
  private readonly maxFrameBytes: number
  private readonly textHandlers = new Set<TextHandler>()
  private readonly binaryHandlers = new Set<BinaryHandler>()
  private readonly closeHandlers = new Set<CloseHandler>()

  constructor(private readonly options: BridgeSocketOptions) {
    this.maxFrameBytes = options.maxFrameBytes ?? MAX_RELAY_FRAME_BYTES
    if (!Number.isSafeInteger(this.maxFrameBytes) || this.maxFrameBytes <= 0) {
      throw new RemoteLinkError(LinkErrorCodes.INVALID_MESSAGE, '直连桥的 maxFrameBytes 不是正整数。')
    }
    if (typeof options.url !== 'string' || !/^wss?:\/\//i.test(options.url)) {
      throw new RemoteLinkError(LinkErrorCodes.INVALID_MESSAGE, '直连桥的远端 url 必须是 wss:// 或 ws://。')
    }
  }

  get phase(): BridgePhase {
    return this.bridgePhase
  }

  open(): Promise<void> {
    if (this.bridgePhase === 'open') return Promise.resolve()
    if (this.bridgePhase === 'connecting' && this.openPromise !== undefined) return this.openPromise
    if (this.bridgePhase === 'closed') {
      return Promise.reject(new RemoteLinkError(LinkErrorCodes.TRANSPORT_CLOSED, '原生桥连接已关闭。'))
    }

    const bridgeUrl = this.resolveBridgeUrl()
    const timeoutMs = this.options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS
    this.bridgePhase = 'connecting'
    this.openPromise = new Promise<void>((resolve, reject) => {
      this.resolveOpen = resolve
      this.rejectOpen = reject
      let socket: WebSocket
      try {
        socket = new WebSocket(bridgeUrl)
      } catch (error) {
        this.bridgePhase = 'closed'
        this.resolveOpen = undefined
        this.rejectOpen = undefined
        reject(new RemoteLinkError(
          LinkErrorCodes.CONNECTION_FAILED,
          `无法连接本机原生桥（${bridgeUrl}）：${errorMessage(error) || 'WebSocket 构造失败'}`,
          { cause: error },
        ))
        return
      }
      this.socket = socket
      socket.binaryType = 'arraybuffer'
      this.openTimer = setTimeout(() => {
        this.fail(LinkErrorCodes.CONNECTION_FAILED, `原生桥 ${timeoutMs}ms 内没有回 {"type":"open"}`)
      }, timeoutMs)
      socket.onopen = () => {
        if (this.bridgePhase !== 'connecting') return
        try {
          // 第一帧必须是 connect 控制帧（契约 §2）。token 只在这里出现。
          socket.send(JSON.stringify({ type: 'connect', url: this.options.url, headers: this.options.headers }))
        } catch (error) {
          this.fail(LinkErrorCodes.CONNECTION_FAILED, `向原生桥发送 connect 帧失败：${errorMessage(error)}`)
        }
      }
      socket.onmessage = event => {
        void this.handleMessage(event.data as unknown)
      }
      socket.onerror = () => {
        this.fail(LinkErrorCodes.CONNECTION_FAILED, '原生桥 WebSocket 出错（网络或原生侧拒绝）。')
      }
      socket.onclose = event => {
        this.handleSocketClose(event.code, event.reason)
      }
    })
    return this.openPromise
  }

  sendText(text: string): void {
    const socket = this.requireOpen()
    if (text.length > this.maxFrameBytes) {
      // text.length 是 UTF-8 字节数的下界，先挡住明显超限的帧；权威字节校验在原生侧与
      // decodeControlFrame（§10.2 / §24）里。
      throw new RemoteLinkError(
        LinkErrorCodes.FRAME_TOO_LARGE,
        `出站文本帧超过 ${this.maxFrameBytes} 字节上限。`,
      )
    }
    socket.send(text)
  }

  sendBinary(bytes: Uint8Array): void {
    const socket = this.requireOpen()
    if (bytes.byteLength > this.maxFrameBytes) {
      throw new RemoteLinkError(
        LinkErrorCodes.FRAME_TOO_LARGE,
        `出站二进制帧超过 ${this.maxFrameBytes} 字节上限。`,
      )
    }
    // 复制成独立的 ArrayBuffer 再发：避免把底层大 buffer（带 offset 的视图）整块送出去。
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)
    socket.send(copy.buffer)
  }

  onText(handler: TextHandler): () => void {
    this.textHandlers.add(handler)
    return () => this.textHandlers.delete(handler)
  }

  onBinary(handler: BinaryHandler): () => void {
    this.binaryHandlers.add(handler)
    return () => this.binaryHandlers.delete(handler)
  }

  onClose(handler: CloseHandler): () => void {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  close(): void {
    const socket = this.socket
    const wasOpen = this.bridgePhase === 'open'
    if (wasOpen && socket !== undefined) {
      try {
        socket.send(JSON.stringify({ type: 'close' }))
      } catch {
        // 原生侧可能已经断了，close 帧发不出去也不影响本地收尾。
      }
      try {
        socket.close(1000, 'client close')
      } catch {
        // 同上。
      }
    }
    this.finish({ code: 1000, reason: 'client close' })
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  private requireOpen(): WebSocket {
    if (this.bridgePhase !== 'open' || this.socket === undefined) {
      throw new RemoteLinkError(LinkErrorCodes.TRANSPORT_CLOSED, '原生桥尚未打开。')
    }
    if (this.socket.readyState !== WS_OPEN) {
      throw new RemoteLinkError(LinkErrorCodes.TRANSPORT_CLOSED, '原生桥已不是打开状态。')
    }
    return this.socket
  }

  private async handleMessage(raw: unknown): Promise<void> {
    if (this.bridgePhase === 'closed') return
    if (typeof raw === 'string') {
      this.handleText(raw)
      return
    }
    if (raw instanceof ArrayBuffer) {
      this.handleBinary(new Uint8Array(raw))
      return
    }
    if (ArrayBuffer.isView(raw)) {
      this.handleBinary(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength))
      return
    }
    if (typeof Blob !== 'undefined' && raw instanceof Blob) {
      // binaryType 在个别 WebView 上会被忽略；统一收敛成 Uint8Array 交给上层。
      try {
        this.handleBinary(new Uint8Array(await raw.arrayBuffer()))
      } catch (error) {
        this.fail(LinkErrorCodes.INVALID_MESSAGE, `读取原生桥二进制帧失败：${errorMessage(error)}`)
      }
      return
    }
    this.fail(LinkErrorCodes.INVALID_MESSAGE, '原生桥返回了无法识别的帧类型。')
  }

  private handleText(text: string): void {
    if (text.length > this.maxFrameBytes) {
      this.fail(
        LinkErrorCodes.FRAME_TOO_LARGE,
        `原生桥入站帧超过 ${this.maxFrameBytes} 字节上限（契约 §2）。`,
      )
      return
    }
    const control = parseBridgeControl(text)
    if (this.bridgePhase === 'connecting') {
      // open 之前只接受桥控制帧；原生侧此时不该透传远端数据。
      if (control === undefined) {
        this.fail(LinkErrorCodes.INVALID_MESSAGE, '原生桥在 {"type":"open"} 之前透传了非控制帧。')
        return
      }
      this.applyBridgeControl(control)
      return
    }
    if (control !== undefined) {
      this.applyBridgeControl(control)
      return
    }
    for (const handler of this.textHandlers) handler(text)
  }

  private handleBinary(bytes: Uint8Array): void {
    if (this.bridgePhase !== 'open') {
      this.fail(LinkErrorCodes.INVALID_MESSAGE, '原生桥在 {"type":"open"} 之前透传了二进制帧。')
      return
    }
    if (bytes.byteLength > this.maxFrameBytes) {
      this.fail(LinkErrorCodes.FRAME_TOO_LARGE, `原生桥入站二进制帧超过 ${this.maxFrameBytes} 字节上限。`)
      return
    }
    for (const handler of this.binaryHandlers) handler(bytes)
  }

  private applyBridgeControl(frame: Record<string, unknown>): void {
    const type = frame.type
    if (type === 'open') {
      if (this.bridgePhase !== 'connecting') return
      this.clearOpenTimer()
      this.bridgePhase = 'open'
      const resolve = this.resolveOpen
      this.resolveOpen = undefined
      this.rejectOpen = undefined
      resolve?.()
      return
    }
    if (type === 'error') {
      const code = typeof frame.code === 'string' && frame.code.length > 0
        ? frame.code
        : LinkErrorCodes.CONNECTION_FAILED
      const message = typeof frame.message === 'string' && frame.message.length > 0
        ? frame.message
        : '原生桥返回了错误。'
      this.fail(code, `原生桥连接失败：${message}`)
      return
    }
    // type === 'close'
    const code = typeof frame.code === 'number' && Number.isSafeInteger(frame.code) ? frame.code : 0
    const reason = typeof frame.reason === 'string' && frame.reason.length > 0 ? frame.reason : '远端已关闭'
    this.finish({ code, reason, detailCode: LinkErrorCodes.TRANSPORT_CLOSED })
  }

  private handleSocketClose(code: number, reason: string): void {
    if (this.bridgePhase === 'closed') return
    this.finish({
      code: Number.isSafeInteger(code) ? code : 0,
      reason: reason.length > 0 ? reason : '原生桥 WebSocket 已关闭',
      detailCode: LinkErrorCodes.TRANSPORT_CLOSED,
    })
  }

  /** 本层判定失败：先按失败结算 `open()`，再走关闭通知。 */
  private fail(code: string, message: string): void {
    const wasOpen = this.bridgePhase === 'open'
    if (wasOpen) {
      this.finish({ code: 0, reason: message, detailCode: code })
      return
    }
    // open() 还没结算：reject 它，不触发 onClose（上层从 start() 的失败里就能拿到原因）。
    const reject = this.rejectOpen
    this.bridgePhase = 'closed'
    this.resolveOpen = undefined
    this.rejectOpen = undefined
    this.clearOpenTimer()
    this.disposeSocket()
    reject?.(new RemoteLinkError(code, message))
  }

  /** 收尾：幂等；已 open 过则通知一次 onClose。 */
  private finish(info: BridgeCloseInfo): void {
    const wasOpen = this.bridgePhase === 'open'
    const reject = this.bridgePhase === 'connecting' ? this.rejectOpen : undefined
    this.bridgePhase = 'closed'
    this.resolveOpen = undefined
    this.rejectOpen = undefined
    this.clearOpenTimer()
    this.disposeSocket()
    if (reject !== undefined) {
      reject(new RemoteLinkError(
        info.detailCode ?? LinkErrorCodes.TRANSPORT_CLOSED,
        `${info.reason}${info.code === 0 ? '' : `（code=${info.code}）`}`,
      ))
      return
    }
    if (!wasOpen || this.closeEmitted) return
    this.closeEmitted = true
    for (const handler of this.closeHandlers) handler(info)
  }

  private disposeSocket(): void {
    const socket = this.socket
    this.socket = undefined
    if (socket === undefined) return
    socket.onopen = null
    socket.onmessage = null
    socket.onerror = null
    socket.onclose = null
    try {
      socket.close()
    } catch {
      // 已经关掉就算了。
    }
  }

  private clearOpenTimer(): void {
    if (this.openTimer !== undefined) clearTimeout(this.openTimer)
    this.openTimer = undefined
  }

  private resolveBridgeUrl(): string {
    const explicit = this.options.bridgeUrl?.trim()
    if (explicit !== undefined && explicit.length > 0) {
      if (!/^wss?:\/\//i.test(explicit)) {
        throw new RemoteLinkError(LinkErrorCodes.INVALID_MESSAGE, 'bridgeUrl 必须是 ws:// 或 wss:// 地址。')
      }
      return explicit
    }
    // 页面本来就由 LocalServer 提供，所以 location.port 就是桥的端口。
    const location = (globalThis as { location?: { hostname?: string; port?: string } }).location
    const hostname = location?.hostname ?? ''
    const port = location?.port ?? ''
    if (port.length === 0 || !LOOPBACK_HOSTS.has(hostname)) {
      throw new RemoteLinkError(
        LinkErrorCodes.INVALID_MESSAGE,
        '无法从页面地址推导本机原生桥端口，请显式传入 bridgeUrl（如 ws://127.0.0.1:18080/__ds_remote/ws）。',
      )
    }
    // 原生桥是 LocalServer 上的普通 HTTP 升级，固定用 ws://。
    return `ws://127.0.0.1:${port}${BRIDGE_WS_PATH}`
  }
}

/** 桥控制帧判定（见文件头注释的三条规则）。 */
function parseBridgeControl(text: string): Record<string, unknown> | undefined {
  // 快速排除：业务帧都是 {"v":…}，只有控制帧以 {"type":" 开头。
  if (!text.startsWith('{"type":"')) return undefined
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.type !== 'string' || !BRIDGE_CONTROL_TYPES.has(record.type)) return undefined
  // DSH Control 帧一定带 v / payload（§10.2），桥控制帧一定不带。
  if (Object.hasOwn(record, 'v') || Object.hasOwn(record, 'payload')) return undefined
  return record
}
