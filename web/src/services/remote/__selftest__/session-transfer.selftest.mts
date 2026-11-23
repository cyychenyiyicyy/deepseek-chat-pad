import assert from 'node:assert/strict'
import { bytesToHex } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha256'
import { RemoteLinkError } from '../core/errors.js'
import {
  exportSessionSnapshots, querySessionRestore, restoreSessionSnapshot,
  SESSION_EXPORT, SESSION_IMPORT, SessionImportUnknown, type SessionTransferOwner,
} from '../sessionTransfer.js'

const bytes = new Uint8Array([0x1f, 0x8b, 1, 2, 3, 4])
const hash = bytesToHex(sha256(bytes))
const workspace = { kind: 'workspace', workspaceId: 'w' } as const
const request = { workspaceId: 'w', sourceSessionId: 's', batchId: 'b', requestId: 'r' }
const initialReplies: Record<string, unknown> = {
  'export.open': { handle: 'exp', chunkBytes: 3, sessions: [{ sessionId: 's', throughSeq: 12 }] },
  'import.open': { handle: 'imp', chunkBytes: 3, maxBytes: 8 },
  'import.commit': { sessionId: 'restored', workspaceAttached: false },
  'import.status': { status: 'completed', sessionId: 'restored', workspaceAttached: false },
}

function setup(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = []
  let current = true
  const replies = { ...initialReplies, ...overrides }
  const owner: SessionTransferOwner = {
    current: () => current,
    capabilities: [SESSION_EXPORT, SESSION_IMPORT],
    target: {
      async rpc<T>(name: string, value?: unknown): Promise<T> {
        const method = name.replace('session.transfer.', '')
        const args = value as Record<string, unknown>
        calls.push({ method, args })
        const configured = replies[method]
        if (configured instanceof Error) throw configured
        if (typeof configured === 'function') return configured(args) as T
        if (configured !== undefined) return configured as T
        if (method === 'export.read') {
          const offset = args.offset as number
          const data = Buffer.from(bytes.subarray(offset, offset + 3)).toString('base64')
          return { offset, data, ...(offset === 0 ? {} : { sha256: hash, totalBytes: bytes.length }) } as T
        }
        if (method === 'import.chunk') return { receivedBytes: Number(args.offset) + 3 } as T
        return undefined as T
      },
      async openStream() { throw new Error('unexpected stream') },
    },
  }
  return { owner, calls, retire: () => { current = false } }
}

const exported = setup()
await exportSessionSnapshots(exported.owner, workspace, async (entry, data) => {
  assert.deepEqual(entry, { sessionId: 's', throughSeq: 12 })
  assert.deepEqual(data, { bytes, sha256: hash })
})
assert.deepEqual(exported.calls.map(({ method }) => method), ['export.open', 'export.read', 'export.read', 'export.close'])
assert.deepEqual(exported.calls[0]?.args, { scope: workspace })

const corrupt = setup({ 'export.read': { offset: 0, data: 'AAAA', totalBytes: 3, sha256: hash } })
await assert.rejects(exportSessionSnapshots(corrupt.owner, workspace, async () => assert.fail()), { code: 'SESSION_TRANSFER_INTEGRITY' })
assert.equal(corrupt.calls.at(-1)?.method, 'export.close')

const restored = setup()
const result = await restoreSessionSnapshot(restored.owner, request, { bytes, sha256: hash }, async () => {
  assert.equal(restored.calls.at(-1)?.method, 'import.chunk')
})
assert.deepEqual(result, { sessionId: 'restored', workspaceAttached: false })
assert.deepEqual(restored.calls.at(-1)?.args, { handle: 'imp', requestId: 'r', totalBytes: 6, sha256: hash })

const retired = setup()
await assert.rejects(restoreSessionSnapshot(retired.owner, request, { bytes, sha256: hash }, async () => {
  retired.retire()
}), { code: 'RPC_ABORTED' })
assert.equal(retired.calls.at(-1)?.method, 'import.abort')
assert.ok(retired.calls.every(({ method }) => method !== 'import.commit'))

const timeout = setup({ 'import.commit': new RemoteLinkError('RPC_TIMEOUT', 'reply missing') })
await assert.rejects(restoreSessionSnapshot(timeout.owner, request, { bytes, sha256: hash }, async () => {}), SessionImportUnknown)
assert.equal(timeout.calls.at(-1)?.method, 'import.commit')
assert.deepEqual(await querySessionRestore(timeout.owner, request), result)
assert.deepEqual(timeout.calls.at(-1)?.args, { batchId: 'b', requestId: 'r' })

const rejected = setup({ 'import.commit': new RemoteLinkError('WORKSPACE_NOT_FOUND', 'deleted', { fromHost: true }) })
await assert.rejects(restoreSessionSnapshot(rejected.owner, request, { bytes, sha256: hash }, async () => {}), { code: 'WORKSPACE_NOT_FOUND' })
assert.equal(rejected.calls.at(-1)?.method, 'import.commit')
assert.equal(await querySessionRestore(setup({ 'import.status': { status: 'unknown' } }).owner, request), null)

const unsupported = setup()
await assert.rejects(exportSessionSnapshots({ ...unsupported.owner, capabilities: [] }, workspace, async () => {}), {
  code: 'FEATURE_NOT_SUPPORTED',
})
assert.equal(unsupported.calls.length, 0)

console.log('8 PASS / 0 FAIL / 8 TOTAL')
