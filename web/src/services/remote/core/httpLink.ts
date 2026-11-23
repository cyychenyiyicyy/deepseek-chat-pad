import { encodeBase64 } from '../filesApi.js'
import { RemoteApiError } from '../serverApi.js'
import { RemoteMethods } from '../sessionsApi.js'
import type { SecureLinkState } from './index.js'
import { newRemoteId, type RemoteStreamHandle, type RpcCallOptions, type StreamEventPayload } from './rpcMux.js'

const MAX_STREAMS = 192
const MAX_FRAME_CHARS = 16 * 1024 * 1024
const DEFAULT_CALL_TIMEOUT = 30_000
const MUX_OPEN_TIMEOUT = 95_000

export interface DshHttpBackend {
  request(path: string, init: RequestInit, timeoutMs: number): Promise<Response>
  openMux(onFrame: (frame: string) => void, onClose: () => void): Promise<{ send(frame: string): void; close(): void }>
  close(): void
}

type HttpLinkOptions = {
  onStreamEvent(streamId: string, event: StreamEventPayload): void
  onState?(state: SecureLinkState, detail?: string): void
}

export class DshHttpLink {
  readonly transport = 'ssh'
  private phase: SecureLinkState = 'connecting'
  private readonly startup: Promise<void>
  private readonly requests = new AbortController()
  private readonly streams = new Set<string>()
  private mux?: Awaited<ReturnType<DshHttpBackend['openMux']>>

  constructor(private readonly backend: DshHttpBackend, private readonly options: HttpLinkOptions) {
    this.startup = this.start()
    void this.startup.catch(() => undefined)
  }

  get state(): SecureLinkState { return this.phase }

  ready(): Promise<void> { return this.startup }

  async rpc<T = unknown>(method: string, params?: unknown, options: RpcCallOptions = {}): Promise<T> {
    if (method !== RemoteMethods.call || !isRecord(params) || typeof params.endpoint !== 'string' ||
      !isRecord(params.payload) || !isRecord(params.payload.args)) {
      throw new RemoteApiError('METHOD_NOT_ALLOWED', 'This call requires the DSH Remote relay carrier.')
    }
    const endpoint = params.endpoint
    validateEndpoint(endpoint)
    const rpcId = newRemoteId()
    const response = await this.request('/api/' + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: params.payload }),
      ...(options.signal ? { signal: options.signal } : {}),
    }, options.timeoutMs)
    if (!response.ok) throw httpFailure(response.status)
    let envelope: unknown
    try {
      envelope = response.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data')
        ? await decodeBinaryResponse(response)
        : await response.json()
    } catch (error) {
      if (this.requests.signal.aborted || options.signal?.aborted) throw closed()
      throw error instanceof RemoteApiError ? error : invalidReply()
    }
    if (this.state !== 'secure' || options.signal?.aborted) throw closed()
    if (!isRecord(envelope) || envelope.type !== 'server-response' || envelope.rpcId !== rpcId ||
      !isRecord(envelope.result) || typeof envelope.result.ok !== 'boolean' ||
      (!envelope.result.ok && !isRecord(envelope.result.error))) throw invalidReply()
    return envelope.result as T
  }

  async openStream(endpoint: string, payload: unknown): Promise<RemoteStreamHandle> {
    validateEndpoint(endpoint)
    if (!isRecord(payload) || !isRecord(payload.args)) throw invalidReply()
    await this.ready()
    if (this.streams.size >= MAX_STREAMS) throw new RemoteApiError('FRAME_TOO_LARGE', 'The Host stream limit was reached.')
    const streamId = newRemoteId()
    this.streams.add(streamId)
    try {
      this.write({ type: 'open', streamId, endpoint, payload })
    } catch (error) {
      this.streams.delete(streamId)
      throw error
    }
    return {
      streamId,
      close: async () => {
        if (this.streams.delete(streamId) && this.state === 'secure') this.write({ type: 'cancel', streamId })
      },
    }
  }

  async request(path: string, init: RequestInit, timeoutMs = DEFAULT_CALL_TIMEOUT): Promise<Response> {
    await this.ready()
    if (this.phase !== 'secure') throw closed()
    const signal = init.signal ? AbortSignal.any([this.requests.signal, init.signal]) : this.requests.signal
    const response = await this.backend.request(path, { ...init, signal }, timeoutMs)
    if (signal.aborted) {
      void response.body?.cancel().catch(() => undefined)
      throw closed()
    }
    return response
  }

  close(): void { this.finish() }

  private async start(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const opening = this.backend.openMux((frame) => this.receive(frame), () => this.finish('CONNECTION_FAILED'))
      void opening.then((mux) => { if (this.phase === 'closed') mux.close() }).catch(() => undefined)
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RemoteApiError('RPC_TIMEOUT', 'The Host stream did not open.')), MUX_OPEN_TIMEOUT)
      })
      const mux = await Promise.race([opening, deadline])
      if (this.phase === 'closed') {
        mux.close()
        throw closed()
      }
      this.mux = mux
      this.phase = 'secure'
      this.options.onState?.('secure')
    } catch (error) {
      this.finish('CONNECTION_FAILED')
      throw error
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private write(frame: Record<string, unknown>): void {
    if (this.phase !== 'secure' || !this.mux) throw closed()
    this.mux.send(JSON.stringify(frame))
  }

  private receive(raw: string): void {
    if (this.phase !== 'secure') return
    let frame: unknown
    try {
      if (raw.length > MAX_FRAME_CHARS) throw invalidReply()
      frame = JSON.parse(raw)
      if (!isRecord(frame) || typeof frame.streamId !== 'string' || !frame.streamId ||
        (frame.type !== 'item' && frame.type !== 'end' && frame.type !== 'error')) throw invalidReply()
    } catch {
      this.finish('INVALID_MESSAGE')
      return
    }
    const streamId = frame.streamId
    if (!this.streams.has(streamId)) return
    if (frame.type === 'item') {
      this.options.onStreamEvent(streamId, { type: 'frame', hasValue: Object.hasOwn(frame, 'value'), value: frame.value })
      return
    }
    this.streams.delete(streamId)
    if (frame.type === 'end') {
      this.options.onStreamEvent(streamId, { type: 'closed', reason: 'completed' })
      return
    }
    const error = isRecord(frame.error) ? frame.error : {}
    this.options.onStreamEvent(streamId, {
      type: 'closed', reason: 'failed',
      failure: {
        code: typeof error.code === 'string' ? error.code : 'INTERNAL_ERROR',
        message: typeof error.message === 'string' ? error.message : 'The Host closed the stream.',
        details: error.details,
      },
    })
  }

  private finish(detail?: string): void {
    if (this.phase === 'closed') return
    this.phase = 'closed'
    this.requests.abort()
    try {
      this.mux?.close()
    } finally {
      this.backend.close()
    }
    const streams = [...this.streams]
    this.streams.clear()
    for (const id of streams) this.options.onStreamEvent(id, { type: 'closed', reason: 'peer-disconnected' })
    this.options.onState?.('closed', detail)
  }
}

function validateEndpoint(endpoint: string) {
  const segments = endpoint.split('/')
  if (endpoint.length > 180 || segments.some((part) => !/^[A-Za-z0-9_$.-]+$/u.test(part) || part === '.' || part === '..')) {
    throw new RemoteApiError('METHOD_NOT_ALLOWED', 'Invalid Host endpoint.')
  }
}

async function decodeBinaryResponse(response: Response): Promise<Record<string, unknown>> {
  const fields = await response.formData()
  const metadata = fields.getAll('metadata')
  if (metadata.length !== 1) throw invalidReply()
  const envelope: unknown = JSON.parse(typeof metadata[0] === 'string' ? metadata[0] : await metadata[0].text())
  fields.delete('metadata')
  if (!isRecord(envelope) || !isRecord(envelope.result) || envelope.result.ok !== true ||
    !Array.isArray(envelope.attachments) || envelope.attachments.length < 1 || envelope.attachments.length > 128) {
    throw invalidReply()
  }
  const root = { value: envelope.result.value }
  for (const attachment of envelope.attachments) {
    if (!isRecord(attachment) || attachment.codec !== 'bytes' || typeof attachment.part !== 'string' ||
      !Array.isArray(attachment.path) || attachment.path.length > 32) throw invalidReply()
    const matching = fields.getAll(attachment.part)
    const blob = matching[0]
    if (matching.length !== 1 || typeof blob === 'string') throw invalidReply()
    fields.delete(attachment.part)
    let parent: Record<string, unknown> | unknown[] = root
    let key: string | number = 'value'
    for (const segment of attachment.path) {
      const child = ownValue(parent, key)
      if (Array.isArray(child) && typeof segment === 'number' && Number.isInteger(segment) && segment >= 0 && segment < child.length) {
        parent = child
      } else if (isRecord(child) && typeof segment === 'string' && Object.hasOwn(child, segment)) {
        parent = child
      } else {
        throw invalidReply()
      }
      key = segment
    }
    if (ownValue(parent, key) !== null) throw invalidReply()
    Reflect.set(parent, key, encodeBase64(new Uint8Array(await blob.arrayBuffer())))
  }
  if (!fields.keys().next().done) throw invalidReply()
  envelope.result.value = root.value
  return envelope
}

function ownValue(parent: Record<string, unknown> | unknown[], key: string | number): unknown {
  return Object.hasOwn(parent, key) ? Reflect.get(parent, key) : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalidReply() {
  return new RemoteApiError('INVALID_MESSAGE', 'The Host returned an invalid HTTP response.')
}

function closed() {
  return new RemoteApiError('RPC_ABORTED', 'The Host HTTP connection closed.')
}

export function httpFailure(status: number): RemoteApiError {
  const code = status === 401 || status === 403 ? 'AUTH_REQUIRED'
    : status === 404 || status === 405 || status === 501 ? 'METHOD_NOT_ALLOWED'
      : status === 408 || status === 504 ? 'RPC_TIMEOUT' : 'CONNECTION_FAILED'
  return new RemoteApiError(code, 'Host HTTP request failed (' + status + ').', status)
}
