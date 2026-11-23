/**
 * S2 传输核自测（Node 可跑）：`pnpm exec tsx src/services/remote/core/__selftest__/secure-link.selftest.mts`
 *
 * 覆盖（契约 §5 要求 + 关键不变量）：
 *   1. 分片重组：> 48 KiB 的明文（双向），并验证确实被切成多片
 *   2. requestId 并发关联（乱序应答）
 *   3. 超时（RPC_TIMEOUT）与「晚到响应丢弃」
 *   4. 流式帧路由（多流隔离 + closed + 关流后迟到帧丢弃）
 *   5. close 清理（pending 拒绝 + 流按 peer-disconnected 收尾）
 *   6. 心跳超时（§22 的 25 s/75 s 判定，这里用毫秒级参数）
 *   7. 超过 4 MiB 的明文被拒绝且不影响通道
 *   8. 协议违规（relay targetDeviceId 不匹配）→ 关链
 *   9. 原生桥控制帧（connect/open/error/close）与 DSH Control 帧不互相误判
 *  10. hello.ack 未协商 transport.relay → CAPABILITY_NOT_SUPPORTED
 *  11. 缺 hostIdentityKey → PEER_IDENTITY_MISMATCH（契约缺口 fail-closed）
 *
 * 用的是内存 socket 对 + 一个假 Host（Server 侧 Control 转发 + Noise responder + RPC 应答），
 * 不依赖网络、不依赖 Node 专有模块（只用到 process.exit 结算退出码）。
 */

import {
  NoiseIkSession,
  createNoisePrologue,
  fromBase64Url,
  generateKeyPair,
  toBase64Url,
} from '../../../../vendor/dsh-remote/crypto/index.js'
import {
  PROTOCOL_VERSION,
  SECURE_FRAGMENT_CHUNK_BYTES,
  SecureMessageCodec,
  createControlFrame,
  createEvent,
  createRelayDataFrame,
  decodeControlFrame,
  decodeMessage,
  decodeRelayDataFrame,
  encodeControlFrame,
  encodeRelayDataFrame,
  type ConnectRequestPayload,
  type ControlFrameType,
  type HelloPayload,
  type RelayPayload,
  type RemoteMessage,
  type SecureHandshakePayload,
  type TransportSelectedPayload,
} from '../../../../vendor/dsh-remote/protocol/index.js'
import { createBridgeSocket, type BridgeCloseInfo, type BridgePhase, type BridgeSocket } from '../bridgeSocket.js'
import { RemoteLinkError } from '../errors.js'
import { createSecureLinkWithBridge, type SecureLink, type SecureLinkOptions } from '../index.js'
import type { StreamEventPayload } from '../rpcMux.js'

// ── 测试框架（极简） ────────────────────────────────────────────────────────

interface TestCase {
  name: string
  run: () => Promise<void>
}

const cases: TestCase[] = []
const failures: string[] = []
const TEST_TIMEOUT_MS = 15_000

function test(name: string, run: () => Promise<void>): void {
  cases.push({ name, run })
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left !== right) throw new Error(`${message}（actual=${left} expected=${right}）`)
}

function assertCode(error: unknown, code: string, message: string): void {
  assert(error instanceof RemoteLinkError, `${message}：期望 RemoteLinkError，实际是 ${String(error)}`)
  if (error.code !== code) throw new Error(`${message}：期望错误码 ${code}，实际 ${error.code}（${error.message}）`)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── 内存 bridge 对 ──────────────────────────────────────────────────────────

/** 一端；`send` 通过 microtask 投递给对端，模拟 WS 的异步投递顺序。 */
class MemoryBridge implements BridgeSocket {
  private bridgePhase: BridgePhase = 'open' // 内存桥视为原生桥已 open
  peer!: MemoryBridge
  readonly sentTexts: string[] = []
  readonly sentBinaries: Uint8Array[] = []
  private readonly textHandlers = new Set<(text: string) => void>()
  private readonly binaryHandlers = new Set<(bytes: Uint8Array) => void>()
  private readonly closeHandlers = new Set<(info: BridgeCloseInfo) => void>()

  get phase(): BridgePhase {
    return this.bridgePhase
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  sendText(text: string): void {
    if (this.bridgePhase !== 'open') throw new Error('内存桥已关闭')
    this.sentTexts.push(text)
    queueMicrotask(() => this.peer.deliverText(text))
  }

  sendBinary(bytes: Uint8Array): void {
    if (this.bridgePhase !== 'open') throw new Error('内存桥已关闭')
    this.sentBinaries.push(bytes)
    queueMicrotask(() => this.peer.deliverBinary(bytes))
  }

  onText(handler: (text: string) => void): () => void {
    this.textHandlers.add(handler)
    return () => this.textHandlers.delete(handler)
  }

  onBinary(handler: (bytes: Uint8Array) => void): () => void {
    this.binaryHandlers.add(handler)
    return () => this.binaryHandlers.delete(handler)
  }

  onClose(handler: (info: BridgeCloseInfo) => void): () => void {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  close(): void {
    if (this.bridgePhase === 'closed') return
    this.bridgePhase = 'closed'
    queueMicrotask(() => this.peer.deliverClose({ code: 1000, reason: 'peer closed' }))
  }

  private deliverText(text: string): void {
    if (this.bridgePhase === 'closed') return
    for (const handler of this.textHandlers) handler(text)
  }

  private deliverBinary(bytes: Uint8Array): void {
    if (this.bridgePhase === 'closed') return
    for (const handler of this.binaryHandlers) handler(bytes)
  }

  private deliverClose(info: BridgeCloseInfo): void {
    if (this.bridgePhase === 'closed') return
    this.bridgePhase = 'closed'
    for (const handler of this.closeHandlers) handler(info)
  }
}

function createMemoryBridgePair(): { page: BridgeSocket; host: BridgeSocket } {
  const page = new MemoryBridge()
  const host = new MemoryBridge()
  page.peer = host
  host.peer = page
  return { page, host }
}

// ── 假 Host（Server 转发 + Noise responder + RPC 应答） ──────────────────────

const HOST_DEVICE_ID = '01KHOST0000000000000000AA'
const CLIENT_DEVICE_ID = '01KCLNT0000000000000000AA'
const CONNECTION_ID = '01KCONN0000000000000000AA'

interface HostRpcRequest {
  id: string
  method: string
  params: unknown
}

class FakeHost {
  readonly hostKeys = generateKeyPair()
  readonly controlTypes: ControlFrameType[] = []
  readonly hellos: HelloPayload[] = []
  readonly transportSelections: TransportSelectedPayload[] = []
  readonly pongs: string[] = []
  readonly messages: RemoteMessage[] = []
  readonly requests: HostRpcRequest[] = []
  readonly streamOpens: Array<{ streamId: string; endpoint: string }> = []
  readonly streamCloses: string[] = []
  /** 只能是 transport.relay 之外的值，用来模拟协商失败。 */
  capabilitiesOverride: string[] | undefined
  /** 置 true 后假装对端彻底哑掉（连 ping 都不回），用于心跳超时用例。 */
  silent = false
  /** 返回 undefined 表示刻意不回应（超时用例）。 */
  onRpc: ((request: HostRpcRequest) => unknown | undefined) | undefined
  relayFramesReceived = 0
  relayFramesSent = 0
  partialFramesReceived = 0
  handshakeCompleted = false
  clientPublicKey = ''

  private readonly codecOut = new SecureMessageCodec()
  private readonly codecIn = new SecureMessageCodec()
  private noise: NoiseIkSession | undefined
  private counter = 0
  private relayAttached = false

  constructor(
    private readonly bridge: BridgeSocket,
    private readonly heartbeatIntervalMs = 25_000,
    private readonly independentRelay?: BridgeSocket,
  ) {
    bridge.onText(text => {
      void this.onControlText(text)
    })
    independentRelay?.onText(text => {
      const frame = decodeRelayDataFrame(text)
      if (frame.type === 'relay.attach') {
        assertEqual(frame.payload, { connectionId: CONNECTION_ID, deviceId: CLIENT_DEVICE_ID,
          peerDeviceId: HOST_DEVICE_ID, ticket: 'fixture-relay-ticket' }, 'relay attach authority')
        this.relayAttached = true
        independentRelay.sendText(encodeRelayDataFrame(createRelayDataFrame('relay.ready', { connectionId: CONNECTION_ID, epoch: 1 })))
      } else if (frame.type === 'relay') {
        this.onRelay(frame.payload as unknown as RelayPayload)
      }
    })
  }

  get helloPayloadFirst(): HelloPayload | undefined {
    return this.hellos[0]
  }

  /** 手动发一帧明文（用于流事件 / response / error）。 */
  sendEnvelope(envelope: unknown): void {
    const noise = this.noise
    assert(noise !== undefined, '假 Host 的 Noise 还没完成')
    const bytes = new TextEncoder().encode(JSON.stringify(envelope))
    for (const fragment of this.codecOut.encode(bytes)) {
      const ciphertext = noise.encrypt(fragment)
      const payload = {
        connectionId: CONNECTION_ID,
        targetDeviceId: CLIENT_DEVICE_ID,
        counter: this.counter,
        ciphertext: toBase64Url(ciphertext),
      }
      if (this.independentRelay) this.independentRelay.sendText(encodeRelayDataFrame(createRelayDataFrame('relay', payload)))
      else this.sendControl('relay', payload)
      this.counter += 1
      this.relayFramesSent += 1
    }
  }

  respond(requestId: string, result: unknown): void {
    this.sendEnvelope({ v: PROTOCOL_VERSION, id: cryptoId(), type: 'rpc.response', timestamp: Date.now(), payload: { requestId, result } })
  }

  respondError(requestId: string, code: string, message: string): void {
    this.sendEnvelope({ v: PROTOCOL_VERSION, id: cryptoId(), type: 'rpc.error', timestamp: Date.now(), payload: { requestId, code, message, retryable: false } })
  }

  emitStreamFrame(streamId: string, value: unknown): void {
    this.sendEnvelope(createEvent('harness.remote.frame', { streamId, hasValue: true, value }))
  }

  emitStreamClosed(streamId: string, reason: string): void {
    this.sendEnvelope(createEvent('harness.remote.stream.closed', { streamId, reason }))
  }

  /** 直接发一个不满足 §13 约束的 relay 帧（协议违规用例）。 */
  sendBadRelayFrame(): void {
    this.sendControl('relay', {
      connectionId: CONNECTION_ID,
      targetDeviceId: '01KOTHER000000000000000AA',
      counter: 999,
      ciphertext: 'AAAA',
    })
  }

  // ── Control 面 ───────────────────────────────────────────────────────────

  private onControlText(text: string): void {
    if (this.silent) return
    const frame = decodeControlFrame(text)
    this.controlTypes.push(frame.type)
    switch (frame.type) {
      case 'hello':
        this.hellos.push(frame.payload as HelloPayload)
        this.sendControl('hello.ack', {
          protocol: PROTOCOL_VERSION,
          serverVersion: 'selftest/0.0.0',
          connectionSessionId: '01KSESSION000000000000000',
          heartbeatIntervalMs: this.heartbeatIntervalMs,
          maxControlFrameBytes: 64 * 1024,
          maxRelayFrameBytes: 1024 * 1024,
          // §10.3：hello.ack.capabilities 是交集。
          capabilities: this.capabilitiesOverride ?? (frame.payload as HelloPayload).capabilities,
        })
        return
      case 'connect.request': {
        const payload = frame.payload as ConnectRequestPayload
        assert(payload.hostDeviceId === HOST_DEVICE_ID, 'connect.request 的 hostDeviceId 不对')
        this.sendControl('connect.accepted', {
          connectionId: CONNECTION_ID,
          ...(this.independentRelay ? { relayEndpoint: 'wss://relay.selftest.invalid/ws/v1/relay', relayTicket: 'fixture-relay-ticket', relayEpoch: 1 } : {}),
        })
        return
      }
      case 'transport.selected':
        if (this.independentRelay) assert(this.relayAttached, 'relay must be ready before selection')
        this.transportSelections.push(frame.payload as TransportSelectedPayload)
        return
      case 'secure.handshake':
        this.onHandshake(frame.payload as SecureHandshakePayload)
        return
      case 'relay':
        this.onRelay(frame.payload as RelayPayload)
        return
      case 'ping':
        this.sendControl('pong', frame.payload as { nonce: string })
        return
      case 'pong':
        this.pongs.push((frame.payload as { nonce: string }).nonce)
        return
      default:
        return // 其它控制帧（本用例不会出现）忽略
    }
  }

  private onHandshake(payload: SecureHandshakePayload): void {
    assert(payload.step === 1, '假 Host 只应该收到 step 1')
    assert(payload.targetDeviceId === HOST_DEVICE_ID, 'secure.handshake 的 targetDeviceId 不对')
    const noise = new NoiseIkSession({
      role: 'responder',
      localPrivateKey: this.hostKeys.privateKey,
      localPublicKey: this.hostKeys.publicKey,
      remotePublicKey: this.clientPublicKey,
      prologue: createNoisePrologue(CONNECTION_ID, HOST_DEVICE_ID, CLIENT_DEVICE_ID),
    })
    noise.readHandshake(fromBase64Url(payload.data))
    const reply = noise.writeHandshake()
    this.noise = noise
    this.handshakeCompleted = true
    this.sendControl('secure.handshake', {
      connectionId: CONNECTION_ID,
      targetDeviceId: CLIENT_DEVICE_ID,
      step: 2,
      data: toBase64Url(reply),
    })
  }

  private onRelay(payload: RelayPayload): void {
    this.relayFramesReceived += 1
    const noise = this.noise
    assert(noise !== undefined, '假 Host 在 Noise 完成前收到了 relay 帧')
    const plaintext = noise.decrypt(fromBase64Url(payload.ciphertext))
    const assembled = this.codecIn.decode(plaintext)
    if (assembled === undefined) {
      this.partialFramesReceived += 1
      return
    }
    const message = decodeMessage(assembled)
    this.messages.push(message)
    if (message.type !== 'rpc.request') return
    const request = message.payload as { method: string; params: unknown }
    const entry: HostRpcRequest = { id: message.id, method: request.method, params: request.params }
    this.requests.push(entry)
    if (request.method === 'harness.remote.stream.open') {
      const params = request.params as { streamId: string; endpoint: string }
      this.streamOpens.push({ streamId: params.streamId, endpoint: params.endpoint })
    }
    if (request.method === 'harness.remote.stream.close') {
      const params = request.params as { streamId: string }
      this.streamCloses.push(params.streamId)
    }
    const result = this.onRpc?.(entry)
    if (result !== undefined) this.respond(message.id, result)
  }

  private sendControl(type: ControlFrameType, payload: unknown): void {
    this.bridge.sendText(encodeControlFrame(createControlFrame(type, payload)))
  }
}

function cryptoId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return typeof uuid === 'string' ? uuid : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

// ── 组装一个可用的链路 ──────────────────────────────────────────────────────

interface Harness {
  link: SecureLink
  host: FakeHost
  page: BridgeSocket
  states: Array<{ state: string; detail?: string }>
  streamEvents: Array<{ streamId: string; payload: StreamEventPayload }>
  frames: unknown[]
}

async function createHarness(options: Partial<SecureLinkOptions> & {
  heartbeatIntervalMs?: number
  hostOptions?: { heartbeatIntervalMs?: number; capabilitiesOverride?: string[] }
  independentRelay?: boolean
} = {}): Promise<Harness> {
  const clientKeys = generateKeyPair()
  const { page, host: hostSide } = createMemoryBridgePair()
  const relay = options.independentRelay ? createMemoryBridgePair() : undefined
  const host = new FakeHost(hostSide, options.hostOptions?.heartbeatIntervalMs ?? 25_000, relay?.host)
  host.clientPublicKey = clientKeys.publicKey
  if (options.hostOptions?.capabilitiesOverride !== undefined) {
    host.capabilitiesOverride = options.hostOptions.capabilitiesOverride
  }
  const states: Array<{ state: string; detail?: string }> = []
  const streamEvents: Array<{ streamId: string; payload: StreamEventPayload }> = []
  const frames: unknown[] = []
  const link = createSecureLinkWithBridge({
    url: 'wss://selftest.invalid/ws/v1/connect',
    headers: { Authorization: 'Bearer selftest-token-0123456789', Origin: 'https://selftest.invalid' },
    device: { deviceId: CLIENT_DEVICE_ID, privateKey: clientKeys.privateKey, publicKey: clientKeys.publicKey },
    clientDeviceId: CLIENT_DEVICE_ID,
    hostDeviceId: HOST_DEVICE_ID,
    hostIdentityKey: host.hostKeys.publicKey,
    onState: (state, detail) => states.push({ state, ...(detail === undefined ? {} : { detail }) }),
    onStreamEvent: (streamId, payload) => streamEvents.push({ streamId, payload }),
    onFrame: frame => frames.push(frame),
    ...options,
    ...(relay ? { relayBridge: () => relay.page } : {}),
  }, page)
  return { link, host, page, states, streamEvents, frames }
}

async function readyHarness(options?: Parameters<typeof createHarness>[0]): Promise<Harness> {
  const harness = await createHarness(options)
  await harness.link.ready()
  return harness
}

// ── 用例 ──────────────────────────────────────────────────────────────────

test('independent relay attaches before Noise and carries the encrypted RPC', async () => {
  const { link, host } = await readyHarness({ independentRelay: true })
  try {
    host.onRpc = request => request.params
    assertEqual(await link.rpc('echo', { value: 'encrypted' }), { value: 'encrypted' }, 'independent relay round-trip')
    assert(!host.controlTypes.includes('relay'), 'ciphertext must not enter the control socket')
    assertEqual(host.relayFramesReceived, 1, 'node socket carries the ciphertext')
  } finally {
    link.close()
  }
})

test('1. 分片重组：>48 KiB 明文双向传输（并在途分片可数）', async () => {
  const { link, host } = await readyHarness()
  assertEqual(link.state, 'secure', 'ready() 后状态应为 secure')
  assertEqual(host.transportSelections.length, 1, '应恰好发出一条 transport.selected')
  assertEqual(host.transportSelections[0]?.transport, 'relay', 'transport.selected 应为 relay')

  const bigValue = 'A'.repeat(200_000)
  link.sendFrame({
    v: PROTOCOL_VERSION,
    id: 'big-frame',
    type: 'event',
    timestamp: Date.now(),
    payload: { event: 'harness.remote.frame', data: { streamId: 'x', hasValue: true, value: bigValue } },
  })
  await sleep(30)
  const inbound = host.messages.find(message => message.id === 'big-frame')
  assert(inbound !== undefined, '假 Host 没收到大帧')
  const inboundValue = (inbound.payload as { data: { value: string } }).data.value
  assertEqual(inboundValue.length, bigValue.length, '大帧长度应一致')
  assertEqual(inboundValue, bigValue, '大帧内容应逐字节一致')
  assert(
    host.relayFramesReceived >= Math.ceil(bigValue.length / SECURE_FRAGMENT_CHUNK_BYTES),
    `200 KB 明文应该被切成 ≥${Math.ceil(bigValue.length / SECURE_FRAGMENT_CHUNK_BYTES)} 个 relay 帧，实际 ${host.relayFramesReceived}`,
  )
  assert(host.partialFramesReceived >= 1, '应有中间分片（decode 返回 undefined）被计数')

  const outbound = 'B'.repeat(300_000)
  host.onRpc = () => ({ value: outbound })
  const result = await link.rpc<{ value: string }>('harness.remote.call', { endpoint: 'big', payload: {} })
  assertEqual(result.value.length, outbound.length, '回程大结果长度应一致')
  assert(result.value === outbound, '回程大结果内容应一致')
  assert(host.relayFramesSent >= 7, `300 KB 回程应被切成 ≥7 个 relay 帧，实际 ${host.relayFramesSent}`)
  link.close()
})

test('2. requestId 并发关联：24 个并发 RPC 乱序应答', async () => {
  const { link, host } = await readyHarness()
  const pending: Array<HostRpcRequest> = []
  host.onRpc = request => {
    pending.push(request)
    return undefined // 手动、乱序应答
  }
  const calls = Array.from({ length: 24 }, (_, index) =>
    link.rpc<{ n: number }>('harness.remote.call', { n: index }))
  await sleep(30)
  assertEqual(pending.length, 24, '假 Host 应收到 24 个请求')
  assertEqual(new Set(pending.map(request => request.id)).size, 24, 'requestId 必须互不相同')
  for (const request of [...pending].reverse()) {
    host.respond(request.id, { n: (request.params as { n: number }).n })
  }
  const results = await Promise.all(calls)
  assertEqual(results.map(item => item.n).sort((a, b) => a - b), Array.from({ length: 24 }, (_, i) => i), '每个请求应拿到自己的结果')
  await sleep(10)
  link.close()
})

test('3. 超时：RPC_TIMEOUT 且晚到响应被丢弃', async () => {
  const { link, host } = await readyHarness()
  host.onRpc = () => undefined
  const started = Date.now()
  let failure: unknown
  try {
    await link.rpc('harness.remote.slow', { a: 1 }, { timeoutMs: 60 })
  } catch (error) {
    failure = error
  }
  const elapsed = Date.now() - started
  assertCode(failure, 'RPC_TIMEOUT', '超时应抛 RPC_TIMEOUT')
  assert(elapsed >= 50 && elapsed < 2_000, `超时时间应在 60ms 量级，实际 ${elapsed}ms`)

  const request = host.requests.find(entry => entry.method === 'harness.remote.slow')
  assert(request !== undefined, '假 Host 应收到超时那条请求')
  host.respond(request.id, { late: true }) // 晚到响应：必须被丢弃
  await sleep(20)
  host.onRpc = () => ({ ok: true })
  const after = await link.rpc<{ ok: boolean }>('harness.remote.call', {})
  assertEqual(after.ok, true, '超时后的链路应继续可用')
  link.close()
})

test('4. 流式帧路由：多流隔离、closed、关流后迟到帧丢弃', async () => {
  const harness = await readyHarness()
  const { link, host, streamEvents, frames } = harness
  host.onRpc = () => ({}) // stream.open / stream.close 都回 {}
  const first = await link.openStream('session/follow', { args: { sessionId: 's-1' } })
  const second = await link.openStream('session/follow', { args: { sessionId: 's-2' } })
  assert(first.streamId !== second.streamId, '两条流应有不同的 streamId')
  await sleep(20)
  assertEqual(host.streamOpens.length, 2, '假 Host 应收到 2 次 stream.open')

  host.emitStreamFrame(first.streamId, 1)
  host.emitStreamFrame(second.streamId, 'a')
  host.emitStreamFrame(first.streamId, 2)
  host.emitStreamFrame(second.streamId, 'b')
  await sleep(30)
  const firstFrames = streamEvents.filter(item => item.streamId === first.streamId && item.payload.type === 'frame')
  const secondFrames = streamEvents.filter(item => item.streamId === second.streamId && item.payload.type === 'frame')
  assertEqual(firstFrames.map(item => (item.payload as { value: unknown }).value), [1, 2], '第一条流应只收到自己的帧')
  assertEqual(secondFrames.map(item => (item.payload as { value: unknown }).value), ['a', 'b'], '第二条流应只收到自己的帧')

  host.emitStreamClosed(first.streamId, 'completed')
  await sleep(20)
  const closed = streamEvents.filter(item => item.streamId === first.streamId && item.payload.type === 'closed')
  assertEqual(closed.length, 1, '第一条流应收到一次 closed')
  assertEqual((closed[0]!.payload as { reason: string }).reason, 'completed', 'closed 的 reason 应为 completed')

  host.emitStreamFrame(first.streamId, 3) // 关流之后的迟到帧
  await sleep(20)
  const lateFrames = streamEvents.filter(item => item.streamId === first.streamId && item.payload.type === 'frame')
  assertEqual(lateFrames.length, 2, '关流后的迟到帧不应再投递给上层')
  assertEqual(frames.length, 0, '被路由的帧不应再出现在 onFrame 里')

  await second.close()
  await sleep(20)
  assertEqual(host.streamCloses.length, 1, '关流应发 harness.remote.stream.close')
  const localClose = streamEvents.filter(item => item.streamId === second.streamId && item.payload.type === 'closed')
  assertEqual(localClose.length, 1, '本地关流应立刻回调 closed')
  assertEqual((localClose[0]!.payload as { reason: string }).reason, 'cancelled', '本地关流的 reason 应为 cancelled')
  link.close()
})

test('5. close 清理：pending 拒绝 + 流按 peer-disconnected 收尾', async () => {
  const harness = await readyHarness()
  const { link, host, streamEvents, states } = harness
  host.onRpc = () => ({}) // 先让 stream.open 成功
  const stream = await link.openStream('session/follow', { args: {} })
  host.onRpc = () => undefined // 之后不再回应，制造 pending
  const inflight = link.rpc('harness.remote.never', {})
  await sleep(20)

  link.close()
  assertEqual(link.state, 'closed', 'close() 后状态应为 closed')
  let failure: unknown
  try {
    await inflight
  } catch (error) {
    failure = error
  }
  assertCode(failure, 'TRANSPORT_CLOSED', '关闭时 pending RPC 应被拒绝')
  const closed = streamEvents.filter(item => item.streamId === stream.streamId && item.payload.type === 'closed')
  assertEqual(closed.length, 1, '关闭时打开的流应收到 closed')
  assertEqual((closed[0]!.payload as { reason: string }).reason, 'peer-disconnected', '断链的 reason 应为 peer-disconnected')
  assert(states.some(item => item.state === 'closed'), 'onState 应收到 closed')

  let afterFailure: unknown
  try {
    await link.rpc('harness.remote.call', {})
  } catch (error) {
    afterFailure = error
  }
  assertCode(afterFailure, 'TRANSPORT_CLOSED', '关闭后的 rpc 应被拒绝')
  assertEqual(link.state, 'closed', '关闭后状态应保持 closed')
})

test('6. 心跳超时：对端彻底静默后在阈值内断开（§22）', async () => {
  const harness = await createHarness({ heartbeatIntervalMs: 60, heartbeatTimeoutMs: 150 })
  await harness.link.ready()
  assertEqual(harness.link.state, 'secure', 'ready() 后应为 secure')
  // 对端从此连 ping 都不回（与网络分区不可区分），客户端也应主动断开。
  harness.host.silent = true
  const deadline = Date.now() + 3_000
  while (harness.link.state !== 'closed' && Date.now() < deadline) await sleep(20)
  assertEqual(harness.link.state, 'closed', '心跳超时后链路应关闭')
  const closed = harness.states.find(item => item.state === 'closed')
  assert(closed !== undefined, 'onState 应收到 closed')
  assert(
    (closed.detail ?? '').includes('CONNECTION_FAILED') && (closed.detail ?? '').includes('心跳'),
    `closed 的 detail 应说明心跳超时，实际：${String(closed.detail)}`,
  )
})

test('7. 上限：超过 4 MiB 的明文被拒绝且通道不受影响', async () => {
  const { link, host } = await readyHarness()
  host.onRpc = () => ({ ok: 1 })
  const oversized = 'C'.repeat(4 * 1024 * 1024 + 1_024)
  let failure: unknown
  try {
    link.sendFrame({ v: PROTOCOL_VERSION, id: 'huge', type: 'event', timestamp: Date.now(), payload: { data: oversized } })
  } catch (error) {
    failure = error
  }
  assertCode(failure, 'FRAME_TOO_LARGE', '超过 4 MiB 应抛 FRAME_TOO_LARGE')
  assertEqual(link.state, 'secure', '本地超限拒绝不应关闭通道')
  const result = await link.rpc<{ ok: number }>('harness.remote.call', {})
  assertEqual(result.ok, 1, '超限拒绝后链路应继续可用')
  link.close()
})

test('8. 协议违规：relay targetDeviceId 不匹配 → 关链并带 INVALID_MESSAGE', async () => {
  const harness = await readyHarness()
  harness.host.onRpc = () => ({ ok: true })
  harness.host.sendBadRelayFrame()
  const deadline = Date.now() + 2_000
  while (harness.link.state !== 'closed' && Date.now() < deadline) await sleep(10)
  assertEqual(harness.link.state, 'closed', '协议违规应关闭链路')
  const closed = harness.states.find(item => item.state === 'closed')
  assert(closed !== undefined, 'onState 应收到 closed')
  assert(
    (closed.detail ?? '').startsWith('INVALID_MESSAGE'),
    `closed 的 detail 应为 INVALID_MESSAGE，实际：${String(closed.detail)}`,
  )
})

test('9. 原生桥控制帧：connect → open → 透传 → close（且不误判 DSH 的 error 帧）', async () => {
  const sockets: FakeWebSocket[] = []
  const original = (globalThis as { WebSocket?: unknown }).WebSocket
  ;(globalThis as { WebSocket?: unknown }).WebSocket = class extends FakeWebSocket {
    constructor(url: string) {
      super(url)
      sockets.push(this)
    }
  }
  try {
    const bridge = createBridgeSocket({
      url: 'wss://selftest.invalid/ws/v1/connect',
      headers: { Authorization: 'Bearer selftest-token-0123456789', Origin: 'https://selftest.invalid' },
      bridgeUrl: 'ws://127.0.0.1:18080/__ds_remote/ws',
    })
    const texts: string[] = []
    const closes: BridgeCloseInfo[] = []
    bridge.onText(text => texts.push(text))
    bridge.onClose(info => closes.push(info))
    const opened = bridge.open()
    const socket = sockets[0]
    assert(socket !== undefined, '应该创建了 WebSocket')
    socket.fireOpen()
    assertEqual(
      JSON.parse(socket.sent[0]!) as unknown,
      {
        type: 'connect',
        url: 'wss://selftest.invalid/ws/v1/connect',
        headers: { Authorization: 'Bearer selftest-token-0123456789', Origin: 'https://selftest.invalid' },
      },
      '第一帧必须是 connect 控制帧',
    )
    socket.fireMessage('{"type":"open"}')
    await opened
    assertEqual(bridge.phase, 'open', 'open 后 phase 应为 open')

    // DSH Control 帧（带 v/payload，type 恰好也是 error）不能被当成桥控制帧。
    const dshError = JSON.stringify({
      v: 1,
      id: 'ctl-1',
      type: 'error',
      timestamp: Date.now(),
      payload: { code: 'INVALID_MESSAGE', message: 'x' },
    })
    socket.fireMessage(dshError)
    await sleep(5)
    assertEqual(texts, [dshError], 'DSH 的 error 帧应原样透传给上层')

    socket.fireMessage('{"type":"close","code":4009,"reason":"server shutdown"}')
    await sleep(5)
    assertEqual(closes.length, 1, '应收到一次 close 通知')
    assertEqual(closes[0]!.code, 4009, 'close code 应透传')
    assertEqual(closes[0]!.reason, 'server shutdown', 'close reason 应透传')
    assertEqual(bridge.phase, 'closed', 'close 后 phase 应为 closed')
  } finally {
    ;(globalThis as { WebSocket?: unknown }).WebSocket = original
  }
})

test('9b. 原生桥 open 前收到 error 帧 → open() 以该错误码 reject', async () => {
  const sockets: FakeWebSocket[] = []
  const original = (globalThis as { WebSocket?: unknown }).WebSocket
  ;(globalThis as { WebSocket?: unknown }).WebSocket = class extends FakeWebSocket {
    constructor(url: string) {
      super(url)
      sockets.push(this)
    }
  }
  try {
    const bridge = createBridgeSocket({
      url: 'wss://selftest.invalid/ws/v1/connect',
      headers: {},
      bridgeUrl: 'ws://127.0.0.1:18080/__ds_remote/ws',
    })
    const opened = bridge.open()
    const socket = sockets[0]
    assert(socket !== undefined, '应该创建了 WebSocket')
    socket.fireOpen()
    socket.fireMessage('{"type":"error","code":"FRAME_TOO_LARGE","message":"too big"}')
    let failure: unknown
    try {
      await opened
    } catch (error) {
      failure = error
    }
    assertCode(failure, 'FRAME_TOO_LARGE', 'open() 应带原生桥给的错误码失败')
    assertEqual(bridge.phase, 'closed', '失败后 phase 应为 closed')
  } finally {
    ;(globalThis as { WebSocket?: unknown }).WebSocket = original
  }
})

test('10. hello.ack 没协商 transport.relay → CAPABILITY_NOT_SUPPORTED', async () => {
  const harness = await createHarness({ hostOptions: { capabilitiesOverride: [] } })
  let failure: unknown
  try {
    await harness.link.ready()
  } catch (error) {
    failure = error
  }
  assertCode(failure, 'CAPABILITY_NOT_SUPPORTED', '未协商 relay 能力应 fail-closed')
  assertEqual(harness.link.state, 'closed', '失败后状态应为 closed')
})

test('11. 缺 hostIdentityKey → PEER_IDENTITY_MISMATCH（契约缺口 fail-closed）', async () => {
  const harness = await createHarness({ hostIdentityKey: undefined })
  let failure: unknown
  try {
    await harness.link.ready()
  } catch (error) {
    failure = error
  }
  assertCode(failure, 'PEER_IDENTITY_MISMATCH', '缺 Host 公钥应 fail-closed')
  assert(
    (failure as Error).message.includes('identityKey'),
    `错误信息应指明怎么补 identityKey，实际：${(failure as Error).message}`,
  )
  assertEqual(harness.link.state, 'closed', '失败后状态应为 closed')
})

// ── FakeWebSocket（只实现 bridgeSocket 用到的那一小部分） ────────────────────

class FakeWebSocket {
  static readonly OPEN = 1
  readyState = 0
  binaryType = 'blob'
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null
  readonly sent: string[] = []

  constructor(readonly url: string) {}

  send(data: unknown): void {
    if (typeof data !== 'string') throw new Error('FakeWebSocket 只支持文本')
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
  }

  fireOpen(): void {
    this.readyState = 1
    this.onopen?.()
  }

  fireMessage(data: unknown): void {
    this.onmessage?.({ data })
  }
}

// ── 跑全部用例 ────────────────────────────────────────────────────────────

async function runAll(): Promise<void> {
  console.log(`S2 secure-link selftest：${cases.length} 个用例\n`)
  for (const item of cases) {
    try {
      await withTimeout(item.run(), TEST_TIMEOUT_MS, item.name)
      console.log(`PASS  ${item.name}`)
    } catch (error) {
      const message = error instanceof Error ? `${error.message}` : String(error)
      failures.push(item.name)
      console.log(`FAIL  ${item.name}\n      ${message}`)
    }
  }
  const passed = cases.length - failures.length
  console.log(`\n结果：${passed} PASS / ${failures.length} FAIL / ${cases.length} 合计`)
  if (failures.length > 0) {
    console.log(`失败用例：\n${failures.map(name => `  - ${name}`).join('\n')}`)
  }
  process.exit(failures.length === 0 ? 0 : 1)
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`用例超时（${timeoutMs}ms）：${label}`)), timeoutMs)
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

void runAll()
