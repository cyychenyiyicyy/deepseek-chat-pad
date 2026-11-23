import type { IceCandidatePayload, SelectedTransport } from '../../../vendor/dsh-remote/protocol/index.js'
import { LinkErrorCodes, RemoteLinkError } from './errors.js'

const CHUNK_BYTES = 8192
const HEADER_BYTES = 12
const MAGIC = 0x52544348 // RTCH
const MAX_CIPHERTEXT_BYTES = 65535
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024
const isRelay = (candidate: string) => /\btyp\s+relay\b/i.test(candidate)
const withoutRelay = (sdp: string) => sdp.split('\n')
  .filter(line => !(line.startsWith('a=candidate:') && isRelay(line))).join('\n')

export type RtcMode = 'direct' | 'turn'
export type RtcPath = Exclude<SelectedTransport, 'relay'>

export class RtcUnavailable extends RemoteLinkError {
  constructor(message: string) {
    super('WEBRTC_UNAVAILABLE', message)
  }
}

// SCTP messages larger than 8 KiB use the DSH RTCH header around Noise ciphertext.
export class RtcChunkCodec {
  private nextId = 1
  private current: { id: number; total: number; index: number; data: Uint8Array; expiresAt: number } | undefined

  encode(bytes: Uint8Array): Uint8Array<ArrayBuffer>[] {
    if (bytes.byteLength > MAX_CIPHERTEXT_BYTES) throw new Error('WebRTC ciphertext exceeds the Noise message limit.')
    if (bytes.byteLength <= CHUNK_BYTES) return [Uint8Array.from(bytes)]
    const total = Math.ceil(bytes.byteLength / CHUNK_BYTES)
    const id = this.nextId
    this.nextId = id === 0xffffffff ? 1 : id + 1
    const frames: Uint8Array<ArrayBuffer>[] = []
    for (let index = 0; index < total; index++) {
      const payload = bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES)
      const frame = new Uint8Array(HEADER_BYTES + payload.byteLength)
      const header = new DataView(frame.buffer)
      header.setUint32(0, MAGIC)
      header.setUint32(4, id)
      header.setUint16(8, index)
      header.setUint16(10, total)
      frame.set(payload, HEADER_BYTES)
      frames.push(frame)
    }
    return frames
  }

  decode(frame: ArrayBuffer): Uint8Array | undefined {
    const view = new DataView(frame)
    if (frame.byteLength < 4 || view.getUint32(0) !== MAGIC) {
      if (this.current || frame.byteLength > MAX_CIPHERTEXT_BYTES) throw new Error('Invalid WebRTC ciphertext sequence.')
      return new Uint8Array(frame)
    }
    if (frame.byteLength <= HEADER_BYTES) throw new Error('Invalid RTCH header.')
    const id = view.getUint32(4)
    const index = view.getUint16(8)
    const total = view.getUint16(10)
    const size = frame.byteLength - HEADER_BYTES
    const offset = CHUNK_BYTES * index
    if (id === 0 || total < 2 || index >= total || total > Math.ceil(MAX_CIPHERTEXT_BYTES / CHUNK_BYTES)
      || size > CHUNK_BYTES || offset + size > MAX_CIPHERTEXT_BYTES || (index < total - 1 && size !== CHUNK_BYTES)) {
      throw new Error('Invalid RTCH fragment.')
    }
    if (index === 0 && !this.current) {
      this.current = { id, total, index, data: new Uint8Array(Math.min(MAX_CIPHERTEXT_BYTES, total * CHUNK_BYTES)), expiresAt: Date.now() + 30_000 }
    }
    const current = this.current
    if (!current || current.id !== id || current.total !== total || current.index !== index || current.expiresAt < Date.now()) {
      throw new Error('Invalid RTCH fragment sequence.')
    }
    current.data.set(new Uint8Array(frame, HEADER_BYTES), offset)
    current.index++
    if (current.index < total) return undefined
    this.current = undefined
    return current.data.subarray(0, offset + size)
  }
}

interface RtcTransportOptions {
  mode: RtcMode
  iceServers: RTCIceServer[]
  offer: (sdp: string) => void
  candidate: (candidate: IceCandidatePayload) => void
  ciphertext: (bytes: Uint8Array) => void
  failed: (error: RemoteLinkError) => void
}

export class RtcTransport {
  private readonly peer: RTCPeerConnection
  private readonly channel: RTCDataChannel
  private readonly outgoing = new RtcChunkCodec()
  private readonly incoming = new RtcChunkCodec()
  private localCandidates: IceCandidatePayload[] | undefined = []
  private remoteCandidates: IceCandidatePayload[] | undefined = []
  private answering = false
  private closed = false
  private opened = false
  private rejectOpening: ((error: RemoteLinkError) => void) | undefined

  constructor(private readonly options: RtcTransportOptions) {
    const direct = options.mode === 'direct'
    this.peer = new RTCPeerConnection({ iceServers: options.iceServers, iceTransportPolicy: direct ? 'all' : 'relay' })
    try {
      this.channel = this.peer.createDataChannel('dsh', { ordered: true })
    } catch (error) {
      this.peer.close()
      throw error
    }
    this.channel.binaryType = 'arraybuffer'
    this.channel.onmessage = ({ data }) => {
      if (this.closed) return
      try {
        if (!(data instanceof ArrayBuffer)) throw new Error('Expected a binary data channel message.')
        const bytes = this.incoming.decode(data)
        if (bytes) this.options.ciphertext(bytes)
      } catch (error) {
        this.options.failed(new RemoteLinkError(LinkErrorCodes.SECURE_CHANNEL_FAILED, 'Invalid WebRTC ciphertext.', { cause: error }))
      }
    }
    this.peer.onicecandidate = ({ candidate }) => {
      if (!candidate || this.closed || (direct && isRelay(candidate.candidate))) return
      const payload = candidate.toJSON()
      if (this.localCandidates) this.localCandidates.push(payload)
      else this.sendCandidate(payload)
    }
  }

  async open(): Promise<RtcPath> {
    const opened = new Promise<void>((resolve, reject) => {
      this.rejectOpening = reject
      this.channel.onopen = () => {
        this.opened = true
        this.rejectOpening = undefined
        resolve()
      }
      const failed = () => {
        if (this.closed) return
        if (this.opened) {
          this.options.failed(new RemoteLinkError(LinkErrorCodes.TRANSPORT_CLOSED, 'WebRTC data channel closed.'))
        } else {
          reject(new RtcUnavailable('WebRTC could not open a data channel.'))
        }
      }
      this.channel.onerror = failed
      this.channel.onclose = failed
      this.peer.onconnectionstatechange = () => {
        if (this.peer.connectionState === 'failed' || this.peer.connectionState === 'closed') failed()
      }
    })
    await Promise.all([opened, this.sendOffer()])
    if (this.options.mode === 'turn') return 'turn'
    const path = await this.selectedPath()
    if (path === 'turn') throw new RtcUnavailable('Direct ICE selected a relay candidate.')
    return path
  }

  private async sendOffer(): Promise<void> {
    const offer = await this.peer.createOffer()
    await this.peer.setLocalDescription(offer)
    if (this.closed || !offer.sdp) throw new RtcUnavailable('WebRTC did not produce an offer.')
    this.options.offer(this.options.mode === 'direct' ? withoutRelay(offer.sdp) : offer.sdp)
    const early = this.localCandidates ?? []
    this.localCandidates = undefined
    for (const candidate of early) this.sendCandidate(candidate)
  }

  private sendCandidate(candidate: IceCandidatePayload): void {
    try {
      this.options.candidate(candidate)
    } catch (error) {
      this.options.failed(new RemoteLinkError(LinkErrorCodes.TRANSPORT_CLOSED, 'Could not send WebRTC ICE candidate.', { cause: error }))
    }
  }

  async answer(sdp: string): Promise<void> {
    if (this.answering || !this.remoteCandidates || this.closed) return
    this.answering = true
    try {
      await this.peer.setRemoteDescription({ type: 'answer', sdp: this.options.mode === 'direct' ? withoutRelay(sdp) : sdp })
    } catch {
      if (!this.closed) this.options.failed(new RtcUnavailable('WebRTC answer was rejected.'))
      return
    }
    const early = this.remoteCandidates
    this.remoteCandidates = undefined
    for (const candidate of early) this.candidate(candidate)
  }

  candidate(candidate: IceCandidatePayload): void {
    if (this.closed || (this.options.mode === 'direct' && isRelay(candidate.candidate ?? ''))) return
    if (this.remoteCandidates) {
      if (this.remoteCandidates.length < 256) this.remoteCandidates.push(candidate)
      return
    }
    void this.peer.addIceCandidate(candidate).catch(() => undefined)
  }

  send(ciphertext: Uint8Array): void {
    if (this.channel.readyState !== 'open' || this.channel.bufferedAmount > MAX_BUFFERED_BYTES) {
      throw new RemoteLinkError(LinkErrorCodes.TRANSPORT_CLOSED, 'WebRTC data channel is unavailable.')
    }
    for (const frame of this.outgoing.encode(ciphertext)) this.channel.send(frame)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.rejectOpening?.(new RemoteLinkError(LinkErrorCodes.TRANSPORT_CLOSED, 'WebRTC transport closed.'))
    this.rejectOpening = undefined
    this.channel.close()
    this.peer.close()
  }

  private async selectedPath(): Promise<RtcPath> {
    let timer: number | undefined
    try {
      const stats = await Promise.race([
        this.peer.getStats(),
        new Promise<undefined>(resolve => { timer = window.setTimeout(resolve, 200) }),
      ])
      const transport = Array.from(stats?.values() ?? []).find(report => report.type === 'transport' && report.selectedCandidatePairId)
      const pair = stats?.get(transport?.selectedCandidatePairId)
      const local = stats?.get(pair?.localCandidateId)?.candidateType
      const remote = stats?.get(pair?.remoteCandidateId)?.candidateType
      if (local === 'relay' || remote === 'relay') return 'turn'
      if (local === 'host' && remote === 'host') return 'lan'
    } catch {
      // Candidate stats are optional in older WebViews.
    } finally {
      clearTimeout(timer)
    }
    return 'p2p'
  }
}
