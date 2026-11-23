import assert from 'node:assert/strict'
import { DshHttpLink } from '../httpLink.js'
import { callEndpoint } from '../../sessionsApi.js'
import type { StreamEventPayload } from '../rpcMux.js'

let sendFrame: (text: string) => void = () => {}
let drop: () => void = () => {}
const events: [string, StreamEventPayload][] = []
const sent: Record<string, unknown>[] = []
let disposed = 0
const link = new DshHttpLink({
  async openMux(onFrame, onClose) {
    sendFrame = onFrame
    drop = onClose
    return { send: (text) => sent.push(JSON.parse(text)), close: () => {} }
  },
  async request(path, init) {
    const request = JSON.parse(String(init.body))
    assert.equal(path, '/api/' + request.method)
    assert.equal(init.method, 'POST')
    assert.equal(request.type, 'client-request')
    switch (request.method) {
      case 'workspaceFiles/readBytes': {
        const form = new FormData()
        form.set('metadata', JSON.stringify({
          type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: { data: null } },
          attachments: [{ path: ['data'], codec: 'bytes', part: 'binary0' }],
        }))
        form.set('binary0', new Blob([new Uint8Array([0, 23, 255])]), 'binary')
        return new Response(form)
      }
      case 'session/mismatch': return Response.json({ type: 'server-response', rpcId: 'elsewhere', result: { ok: true } })
      case 'session/stale':
        return await new Promise<Response>((resolve) => {
          init.signal?.addEventListener('abort', () => resolve(Response.json({
            type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: 'wrong host' },
          })), { once: true })
        })
      case 'session/forbidden': return new Response(null, { status: 403 })
      default: return Response.json({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: request.payload.args } })
    }
  },
  close: () => { disposed += 1 },
}, { onStreamEvent: (id, event) => events.push([id, event]) })

await link.ready()
assert.equal(link.state, 'secure')
assert.deepEqual(await callEndpoint(link, 'session/list', { _request: {} }), { _request: {} })
assert.deepEqual(await callEndpoint(link, 'workspaceFiles/readBytes', {}), { data: 'ABf/' })
await assert.rejects(callEndpoint(link, 'session/mismatch', {}), { code: 'INVALID_MESSAGE' })
await assert.rejects(callEndpoint(link, 'session/forbidden', {}), { code: 'AUTH_REQUIRED' })
await assert.rejects(callEndpoint(link, 'session/../list', {}), { code: 'METHOD_NOT_ALLOWED' })
const eventsStream = await link.openStream('$events', { args: {} })
const session = await link.openStream('session/follow', { args: { request: { sessionId: 'a' } } })
assert.deepEqual(sent[0], { type: 'open', streamId: eventsStream.streamId, endpoint: '$events', payload: { args: {} } })
sendFrame(JSON.stringify({ type: 'item', streamId: session.streamId, value: { sessionId: 'a' } }))
await session.close()
sendFrame(JSON.stringify({ type: 'item', streamId: session.streamId, value: { sessionId: 'b' } }))
assert.deepEqual(sent.at(-1), { type: 'cancel', streamId: session.streamId })
assert.deepEqual(events, [[session.streamId, { type: 'frame', hasValue: true, value: { sessionId: 'a' } }]])
const late = callEndpoint(link, 'session/stale', {})
await Promise.resolve()
await Promise.resolve()
drop()
await assert.rejects(late, { code: 'RPC_ABORTED' })
assert.deepEqual(events.at(-1), [eventsStream.streamId, { type: 'closed', reason: 'peer-disconnected' }])
link.close()
assert.equal(disposed, 1)
console.log('13 PASS / 0 FAIL / 13 TOTAL')
