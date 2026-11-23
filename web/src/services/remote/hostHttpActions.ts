import { httpFailure } from './core/httpLink.js'
import { DOWNLOAD_MAX_BYTES } from './download.js'
import { RemoteApiError } from './serverApi.js'
import { callEndpoint, type RemoteCallTarget } from './sessionsApi.js'

export type HostHttpTarget = RemoteCallTarget & {
  request(path: string, init: RequestInit, timeoutMs?: number): Promise<Response>
}

export function hostHttpTarget(target: RemoteCallTarget | null): HostHttpTarget | null {
  if (target && 'request' in target && typeof target.request === 'function') return target as HostHttpTarget
  return null
}

export async function supportsSessionDeletion(target: HostHttpTarget, signal?: AbortSignal): Promise<boolean> {
  const response = await target.request('/dsh-go/v1/sessions/deletion', { method: 'GET', signal }, 8000)
  if ([404, 405, 501].includes(response.status)) return false
  if (!response.ok) throw httpFailure(response.status)
  if (!isJson(response)) return false
  const result = await response.json().catch(() => null)
  return result?.version === 1 && result.supported === true
}

export async function deleteHostSession(target: HostHttpTarget, sessionId: string, current: () => boolean): Promise<void> {
  if (!sessionId || sessionId.length > 256 || /[\x00-\x1f\x7f]/u.test(sessionId)) {
    throw new RemoteApiError('INVALID_MESSAGE', 'The conversation ID is invalid.')
  }
  if (!current()) throw new RemoteApiError('RPC_ABORTED', 'The connection changed.')
  const supported = await supportsSessionDeletion(target)
  if (!current()) throw new RemoteApiError('RPC_ABORTED', 'The connection changed.')
  if (!supported) throw new RemoteApiError('METHOD_NOT_ALLOWED', 'This Host does not support permanent deletion.')
  let result: Response | undefined
  try {
    result = await target.request('/dsh-go/v1/sessions/delete', {
      method: 'POST', body: JSON.stringify({ sessionId }),
    }, 30_000)
    if (result.ok && isJson(result)) {
      const reply = await result.json()
      if (reply?.deleted === true && reply?.sessionId === sessionId) return
    }
  } catch {
    throw new RemoteApiError('DELETE_OUTCOME_UNKNOWN', 'The Host did not confirm deletion.')
  }
  if (result.status >= 400 && result.status < 500 && result.status !== 408) throw httpFailure(result.status)
  throw new RemoteApiError('DELETE_OUTCOME_UNKNOWN', 'The Host did not confirm deletion.')
}

export async function createHostDirectory(target: HostHttpTarget, parent: string, name: string): Promise<string> {
  if (!parent || !name || name === '.' || name === '..' || name.length > 255 || /[/\\\x00-\x1f\x7f]/u.test(name)) {
    throw new RemoteApiError('INVALID_PATH', 'Enter one folder name.')
  }
  const value = await callEndpoint<unknown>(target, 'directoryPicker/createDirectory', { path: parent, name })
  if (typeof value !== 'string' || !value) {
    throw new RemoteApiError('INVALID_MESSAGE', 'The Host did not identify the new directory.')
  }
  return value
}

export async function fetchHostSessionLog(target: HostHttpTarget, sessionId: string, signal: AbortSignal): Promise<Blob> {
  const query = new URLSearchParams({ sessionId, includeDescendants: 'true' })
  const response = await target.request('/api/session.export?' + query, { method: 'GET', signal }, 300_000)
  if (!response.ok) throw httpFailure(response.status)
  const reader = response.body?.getReader()
  if (!reader) throw new RemoteApiError('INVALID_MESSAGE', 'The Host returned an empty ZIP file.')
  const parts: BlobPart[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > DOWNLOAD_MAX_BYTES) throw new RemoteApiError('FRAME_TOO_LARGE', 'The Host ZIP exceeds the download limit.')
      parts.push(new Uint8Array(value))
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  signal.throwIfAborted()
  const blob = new Blob(parts, { type: 'application/zip' })
  const magic = new Uint8Array(await blob.slice(0, 4).arrayBuffer())
  if (magic[0] !== 0x50 || magic[1] !== 0x4b || !((magic[2] === 3 && magic[3] === 4) || (magic[2] === 5 && magic[3] === 6))) {
    throw new RemoteApiError('INVALID_MESSAGE', 'The Host did not return a ZIP file.')
  }
  return blob
}

function isJson(response: Response) {
  return response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() === 'application/json'
}
