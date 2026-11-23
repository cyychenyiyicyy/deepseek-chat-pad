import { createSecureLinkWithBridge, type BridgeSocket } from '../../web/src/services/remote/core/index.js'
import { RtcChunkCodec } from '../../web/src/services/remote/core/rtcTransport.js'
import { NoiseIkSession, createNoisePrologue, generateKeyPair, fromBase64Url, toBase64Url } from '../../web/src/vendor/dsh-remote/crypto/index.js'
import { PROTOCOL_VERSION, SecureMessageCodec, createControlFrame, decodeControlFrame, decodeMessage, encodeControlFrame,
  type ControlFrameType, type SignalIcePayload, type SignalPayload, type SecureHandshakePayload } from '../../web/src/vendor/dsh-remote/protocol/index.js'

export async function runRtcTransportQA() {
  const hostId = 'rtc-qa-host'
  const clientId = 'rtc-qa-client'
  const connectionId = 'rtc-qa-connection'
  const hostKeys = generateKeyPair()
  const clientKeys = generateKeyPair()
  const incoming = new RtcChunkCodec()
  const outgoing = new RtcChunkCodec()
  const inMessages = new SecureMessageCodec()
  const outMessages = new SecureMessageCodec()
  const host = new RTCPeerConnection()
  const frames: string[] = []
  let hostError = ''
  let forward: ((text: string) => void) | undefined
  let noise: NoiseIkSession | undefined
  let chunks = 0
  let credentialsId = ''
  const send = (type: ControlFrameType, payload: unknown) => queueMicrotask(() => forward?.(encodeControlFrame(createControlFrame(type, payload))))
  const guard = (fn: () => unknown) => {
    void Promise.resolve().then(fn).catch(error => { hostError = String(error) })
  }
  host.onicecandidate = ({ candidate }) => {
    if (candidate) send('signal.ice', { connectionId, targetDeviceId: clientId, candidate: candidate.toJSON() })
  }
  host.ondatachannel = ({ channel }) => {
    channel.binaryType = 'arraybuffer'
    channel.onmessage = ({ data }) => guard(() => {
      if (!noise || channel.label !== 'dsh' || !channel.ordered) throw new Error('Invalid data channel')
      chunks += 1
      const ciphertext = incoming.decode(data as ArrayBuffer)
      if (!ciphertext) return
      const message = inMessages.decode(noise.decrypt(ciphertext))
      if (!message) return
      const request = decodeMessage(message)
      const response = JSON.stringify({
        v: PROTOCOL_VERSION, id: crypto.randomUUID(), timestamp: Date.now(), type: 'rpc.response',
        payload: { requestId: request.id, result: (request.payload as { params: unknown }).params },
      })
      for (const fragment of outMessages.encode(new TextEncoder().encode(response))) {
        for (const frame of outgoing.encode(noise.encrypt(fragment))) channel.send(frame)
      }
    })
  }
  const bridge: BridgeSocket = {
    phase: 'open', async open() {}, close() { host.close() }, onBinary() { return () => {} }, onClose() { return () => {} }, sendBinary() {},
    onText(handler) { forward = handler; return () => { forward = undefined } },
    sendText(text) {
      const frame = decodeControlFrame(text)
      frames.push(frame.type)
      switch (frame.type) {
        case 'hello':
          send('hello.ack', { protocol: PROTOCOL_VERSION, serverVersion: 'qa', connectionSessionId: 'rtc-qa-control',
            heartbeatIntervalMs: 25_000, maxControlFrameBytes: 65536, maxRelayFrameBytes: 1048576,
            capabilities: ['transport.lan', 'transport.p2p', 'transport.relay'] })
          break
        case 'connect.request':
          send('connect.accepted', { connectionId })
          break
        case 'signal.offer':
          guard(async () => {
            await host.setRemoteDescription({ type: 'offer', sdp: (frame.payload as SignalPayload).sdp })
            const answer = await host.createAnswer()
            await host.setLocalDescription(answer)
            send('signal.answer', { connectionId, targetDeviceId: clientId, sdp: answer.sdp })
          })
          break
        case 'signal.ice':
          guard(() => host.addIceCandidate((frame.payload as SignalIcePayload).candidate))
          break
        case 'secure.handshake':
          noise = new NoiseIkSession({ role: 'responder', localPrivateKey: hostKeys.privateKey, localPublicKey: hostKeys.publicKey,
            remotePublicKey: clientKeys.publicKey, prologue: createNoisePrologue(connectionId, hostId, clientId) })
          noise.readHandshake(fromBase64Url((frame.payload as SecureHandshakePayload).data))
          send('secure.handshake', { connectionId, targetDeviceId: clientId, step: 2, data: toBase64Url(noise.writeHandshake()) })
          break
      }
    },
  }
  const link = createSecureLinkWithBridge({ url: 'wss://fixture.invalid/ws/v1/connect', headers: {},
    accessToken: 'fixture-device-token', device: { ...clientKeys, deviceId: clientId }, hostDeviceId: hostId,
    clientDeviceId: clientId, hostIdentityKey: hostKeys.publicKey,
    rtc: { mode: 'direct', async iceServers(id) { credentialsId = id; return [] }, timeoutMs: 8_000 } }, bridge)
  try {
    await link.ready()
    const payload = 'rtc-encrypted-payload'.repeat(3800)
    const result = await link.rpc<string>('fixture.echo', payload, { timeoutMs: 5_000 })
    return { transport: link.transport, roundTrip: payload === result, chunks, frames, credentialsId, hostError }
  } catch (error) {
    return { transport: link.transport, roundTrip: false, chunks, frames, credentialsId, hostError, error: String(error) }
  } finally {
    link.close()
    noise?.destroy()
  }
}
