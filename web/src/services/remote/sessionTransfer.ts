import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import { z } from 'zod'
import { RemoteLinkError } from './core/errors.js'
import { decodeBase64, encodeBase64 } from './filesApi.js'
import { RemoteApiError } from './serverApi.js'
import type { RemoteCallTarget } from './sessionsApi.js'

export const SESSION_EXPORT = 'session.transfer.export.v1'
export const SESSION_IMPORT = 'session.transfer.import.v1'
const MAX_SESSION_BYTES = 8 * 1024 * 1024
const MAX_CHUNK_BYTES = 256 * 1024
const id = z.string().min(1)
const chunkSize = z.int().min(1).max(MAX_CHUNK_BYTES)
const digest = z.string().regex(/^[0-9a-f]{64}$/u)
const importResult = z.object({ sessionId: id, workspaceAttached: z.boolean() })

export type SessionTransferScope = { kind: 'session'; sessionId: string } | { kind: 'workspace'; workspaceId: string }
export type SessionImportResult = z.infer<typeof importResult>
export interface SessionTransferData {
  bytes: Uint8Array<ArrayBuffer>
  sha256: string
}
export interface SessionTransferPeer {
  serverUrl: string
  hostId: string
  hostIdentity: string
  deviceId: string
}
export interface SessionTransferOwner {
  target: RemoteCallTarget
  capabilities: readonly string[]
  current: () => boolean
}
export interface SessionRestoreRequest {
  workspaceId: string
  sourceSessionId: string
  batchId: string
  requestId: string
}

export class SessionImportUnknown extends Error {
  constructor(cause: unknown) {
    super('The restore was submitted but its outcome could not be confirmed.', { cause })
  }
}

function read<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new RemoteApiError('INVALID_RESPONSE', 'Invalid session transfer response')
  return result.data
}

function requireTransfer(owner: SessionTransferOwner, capability: string) {
  if (!owner.current()) throw new RemoteApiError('RPC_ABORTED', 'Session transfer cancelled')
  if (!owner.capabilities.includes(capability)) throw new RemoteApiError('FEATURE_NOT_SUPPORTED', 'Host does not support this transfer')
}

function verify(data: SessionTransferData) {
  if (data.bytes.length === 0 || data.bytes.length > MAX_SESSION_BYTES ||
    bytesToHex(sha256(data.bytes)) !== data.sha256) {
    throw new RemoteApiError('SESSION_TRANSFER_INTEGRITY', 'Session snapshot length or SHA-256 mismatch')
  }
}

async function discard(target: RemoteCallTarget, method: string, handle: string) {
  await target.rpc(method, { handle }, { timeoutMs: 5_000 }).catch(() => undefined)
}

const exportManifest = z.object({
  chunkBytes: chunkSize,
  sessions: z.array(z.object({ sessionId: id, throughSeq: z.int().min(-1) })).max(2048),
})
const exportChunk = z.object({
  offset: z.int().min(0),
  data: z.string(),
  totalBytes: z.int().positive().max(MAX_SESSION_BYTES).optional(),
  sha256: digest.optional(),
})

export async function exportSessionSnapshots(
  owner: SessionTransferOwner,
  scope: SessionTransferScope,
  onSnapshot: (entry: { sessionId: string; throughSeq: number }, data: SessionTransferData) => Promise<void>,
) {
  const { target } = owner
  requireTransfer(owner, SESSION_EXPORT)
  const response = await target.rpc('session.transfer.export.open', { scope })
  const { handle } = read(z.object({ handle: id }), response)
  try {
    const { sessions, chunkBytes } = read(exportManifest, response)
    const ids = new Set(sessions.map((entry) => entry.sessionId))
    if (ids.size !== sessions.length || (scope.kind === 'session' &&
      sessions.some((entry) => entry.sessionId !== scope.sessionId))) {
      throw new RemoteApiError('INVALID_RESPONSE', 'The Host returned sessions outside the requested export.')
    }
    for (const entry of sessions) {
      const chunks: Uint8Array[] = []
      let offset = 0
      while (true) {
        requireTransfer(owner, SESSION_EXPORT)
        const result = read(exportChunk, await target.rpc('session.transfer.export.read', { handle, sessionId: entry.sessionId, offset }))
        if (result.offset !== offset || result.data.length > Math.ceil(chunkBytes / 3) * 4) {
          throw new RemoteApiError('INVALID_RESPONSE', 'Invalid session snapshot offset or chunk size')
        }
        const chunk = decodeBase64(result.data)
        if (chunk.length > chunkBytes || encodeBase64(chunk) !== result.data || offset + chunk.length > MAX_SESSION_BYTES) {
          throw new RemoteApiError('INVALID_RESPONSE', 'Invalid session snapshot encoding or size')
        }
        chunks.push(chunk)
        offset += chunk.length
        if (result.totalBytes !== undefined || result.sha256 !== undefined) {
          if (result.totalBytes !== offset || result.sha256 === undefined) {
            throw new RemoteApiError('SESSION_TRANSFER_INTEGRITY', 'Invalid session snapshot trailer')
          }
          const bytes = new Uint8Array(offset)
          let start = 0
          for (const part of chunks) {
            bytes.set(part, start)
            start += part.length
          }
          const data = { bytes, sha256: result.sha256 }
          verify(data)
          requireTransfer(owner, SESSION_EXPORT)
          await onSnapshot(entry, data)
          break
        }
        if (chunk.length === 0) throw new RemoteApiError('INVALID_RESPONSE', 'Session export did not advance')
      }
    }
  } finally {
    await discard(target, 'session.transfer.export.close', handle)
  }
}

export async function restoreSessionSnapshot(
  owner: SessionTransferOwner,
  request: SessionRestoreRequest,
  data: SessionTransferData,
  beforeCommit: () => Promise<void>,
): Promise<SessionImportResult> {
  const { target } = owner
  requireTransfer(owner, SESSION_IMPORT)
  verify(data)
  const opened = await target.rpc('session.transfer.import.open', {
    workspaceId: request.workspaceId,
    batchId: request.batchId,
    sourceSessionId: request.sourceSessionId,
    formatVersion: 1,
  })
  const { handle } = read(z.object({ handle: id }), opened)
  let committed = false
  try {
    const { chunkBytes, maxBytes } = read(z.object({ chunkBytes: chunkSize, maxBytes: z.int().min(1).max(MAX_SESSION_BYTES) }), opened)
    if (data.bytes.length > maxBytes) throw new RemoteApiError('LIMIT_EXCEEDED', 'Session snapshot is too large for this host')
    for (let offset = 0; offset < data.bytes.length; offset += chunkBytes) {
      requireTransfer(owner, SESSION_IMPORT)
      const chunk = data.bytes.subarray(offset, offset + chunkBytes)
      const ack = read(z.object({ receivedBytes: z.int() }), await target.rpc('session.transfer.import.chunk', {
        handle, offset, data: encodeBase64(chunk),
      }))
      if (ack.receivedBytes !== offset + chunk.length) throw new RemoteApiError('INVALID_RESPONSE', 'Invalid session import acknowledgement')
    }
    requireTransfer(owner, SESSION_IMPORT)
    await beforeCommit()
    requireTransfer(owner, SESSION_IMPORT)
    committed = true
    try {
      return read(importResult, await target.rpc('session.transfer.import.commit', {
        handle, requestId: request.requestId, totalBytes: data.bytes.length, sha256: data.sha256,
      }))
    } catch (error) {
      if (error instanceof RemoteLinkError && error.fromHost && error.code !== 'TRANSPORT_CLOSED') throw error
      throw new SessionImportUnknown(error)
    }
  } finally {
    if (!committed) await discard(target, 'session.transfer.import.abort', handle)
  }
}

export async function querySessionRestore(
  owner: SessionTransferOwner,
  request: Pick<SessionRestoreRequest, 'batchId' | 'requestId'>,
): Promise<SessionImportResult | null> {
  requireTransfer(owner, SESSION_IMPORT)
  const response = await owner.target.rpc('session.transfer.import.status', {
    batchId: request.batchId, requestId: request.requestId,
  })
  const { status } = read(z.object({ status: z.enum(['unknown', 'completed']) }), response)
  return status === 'unknown' ? null : read(importResult, response)
}
