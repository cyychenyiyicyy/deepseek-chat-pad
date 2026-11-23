import assert from 'node:assert/strict'
import { observeRemoteTarget, type RemoteCallTarget } from '../sessionsApi.js'
import { attachTerminal, createTerminal, loadTerminalInventory, readTerminalFrame, retainTerminal } from '../terminal.js'

const calls: unknown[] = []
const info = { id: 'terminal', title: 'Fixture Shell', cols: 80, rows: 24, state: 'running', controllerId: 'attachment' }
const target: RemoteCallTarget = {
  async rpc<T>(method: string, payload?: unknown) {
    calls.push([method, payload])
    const { endpoint } = payload as { endpoint: string }
    return {
      ok: true, value: endpoint === 'terminal/list' ? [info] : endpoint === 'terminal/shells' ? [{ path: '/bin/sh' }]
        : endpoint === 'terminal/environment' ? { maxInputBytes: 8 } : endpoint === 'terminal/create' ? info : undefined,
    } as T
  },
  async openStream(endpoint, payload) {
    calls.push([endpoint, payload])
    return { streamId: 'fixture-stream', close: async () => {} }
  },
}
observeRemoteTarget(target)
const scope = { target, sessionId: 'fixture-session', current: () => true }
assert.equal((await loadTerminalInventory(scope)).environment.maxInputBytes, 8)
assert.equal((await createTerminal(scope, '/bin/sh', 'terminal')).id, 'terminal')
assert.deepEqual(calls[3], ['harness.remote.call', {
  endpoint: 'terminal/create',
  payload: { args: { agentId: 'fixture-session', request: { id: 'terminal', cols: 80, rows: 24, shellPath: '/bin/sh' } } },
}])
const attachment = attachTerminal(scope, 'terminal')
await attachment.stream
assert.deepEqual(calls[4], ['terminal/follow', {
  args: { agentId: 'fixture-session', id: 'terminal', attachmentId: attachment.attachmentId },
}])
await attachment.write('fixture')
assert.deepEqual(calls[5], ['harness.remote.call', {
  endpoint: 'terminal/write',
  payload: { args: { agentId: 'fixture-session', id: 'terminal', attachmentId: attachment.attachmentId, data: 'fixture' } },
}])
await retainTerminal(scope, 'terminal')
assert.deepEqual(calls[6], ['terminal/retain', { args: { sessionId: 'fixture-session', id: 'terminal' } }])
assert.equal(readTerminalFrame({ type: 'snapshot', info, screen: 'test', sequence: 0 })?.kind, 'snapshot')
assert.equal(readTerminalFrame({ type: 'output', data: 'invalid', sequence: -1 }), undefined)
observeRemoteTarget(null)
await assert.rejects(attachment.write('stale'), { code: 'RPC_ABORTED' })
assert.equal(calls.length, 7)
console.log('10 PASS / 0 FAIL / 10 TOTAL')
