import { gzip } from 'fflate'
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { prepareRequest } from '../api/transport.js'
import { translate } from '../../i18n/index.js'
import { decodeConversationShare, MAX_CONVERSATION_FILE } from './conversationShare.js'
import { fromBase64Url, isIdentityKey, toBase64Url } from './identity.js'

const ORIGIN = 'https://go.dshtui.com'
const ID = /^[0-9A-Za-z]{10}$/u
const TOKEN = /^[0-9A-Za-z_-]{16,128}$/u
const MAGIC = new TextEncoder().encode('DSG1')
const MAX_BLOB = 20 * 1024 * 1024

export const HOSTED_TTLS = ['7d', '30d', 'forever'] as const
export type HostedTtl = typeof HOSTED_TTLS[number]

export interface HostedConversationLink {
  id: string
  key: string
  deleteToken: string
  title: string
  created: number
  expiry: string | null
}

interface ShareDatabase extends DBSchema {
  keys: { key: string; value: CryptoKey }
  links: { key: string; value: { iv: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer } }
}

let opening: Promise<IDBPDatabase<ShareDatabase>> | undefined
function shareDb() {
  return opening ??= openDB<ShareDatabase>('chat-pad-remote-shares', 1, {
    upgrade(db) {
      db.createObjectStore('keys')
      db.createObjectStore('links')
    },
  }).catch((error: unknown) => {
    opening = undefined
    throw error
  })
}

async function storageKey(db: IDBPDatabase<ShareDatabase>): Promise<CryptoKey> {
  const existing = await db.get('keys', 'links')
  if (existing) return existing
  const generated = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const tx = db.transaction('keys', 'readwrite')
  const concurrent = await tx.store.get('links')
  if (!concurrent) await tx.store.add(generated, 'links')
  await tx.done
  return concurrent ?? generated
}

export function hostedConversationUrl(link: Pick<HostedConversationLink, 'id' | 'key'>): string {
  return ORIGIN + '/c/' + link.id + '#k=' + link.key
}

function expiryOf(link: HostedConversationLink): number {
  return link.expiry === null ? Infinity : Date.parse(link.expiry)
}

export async function listHostedConversations(): Promise<HostedConversationLink[]> {
  const db = await shareDb()
  const key = await storageKey(db)
  const transaction = db.transaction('links')
  const [ids, records] = await Promise.all([transaction.store.getAllKeys(), transaction.store.getAll()])
  const links = await Promise.all(records.map(async (record, index) => {
    const id = ids[index]
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv, additionalData: new TextEncoder().encode(id) }, key, record.ciphertext)
    return JSON.parse(new TextDecoder().decode(plain)) as HostedConversationLink
  }))
  const now = Date.now()
  return links.filter((link) => expiryOf(link) > now).sort((a, b) => b.created - a.created)
}

async function hostedRequest(path: string, init: RequestInit, signal = AbortSignal.timeout(90_000)): Promise<Response> {
  const request = await prepareRequest(ORIGIN + '/api/v1/c' + path, init)
  if (!request.proxied) throw new Error(translate('remoteHostedNative'))
  try {
    return await fetch(request.url, {
      method: request.method, headers: request.headers, body: request.body,
      signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
    })
  } catch (error) {
    if (signal.aborted && signal.reason instanceof DOMException && signal.reason.name === 'AbortError') throw error
    throw new Error(translate('remoteHostedNetwork'))
  }
}

async function readCapped(stream: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!stream) throw new Error(translate('remoteHostedInvalid'))
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel().catch(() => undefined)
        throw new Error(translate('remoteHostedTooLarge'))
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function hostedFailure(response: Response): Error {
  switch (response.status) {
    case 404: return new Error(translate('remoteHostedGone'))
    case 413: return new Error(translate('remoteHostedTooLarge'))
    case 429: return new Error(translate('remoteHostedRateLimited'))
    default: return new Error(translate('remoteHostedRejected', { status: response.status }))
  }
}

async function removeShare(id: string, deleteToken: string): Promise<void> {
  if (!ID.test(id) || !TOKEN.test(deleteToken)) throw new Error(translate('remoteHostedInvalid'))
  const response = await hostedRequest('/' + id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + deleteToken } })
  if (response.status !== 204 && response.status !== 404) throw hostedFailure(response)
}

export async function revokeHostedConversation(link: HostedConversationLink): Promise<void> {
  await removeShare(link.id, link.deleteToken)
  await (await shareDb()).delete('links', link.id)
}

export async function publishHostedConversation(
  file: Uint8Array<ArrayBuffer>, title: string, ttl: HostedTtl, current: () => boolean,
): Promise<HostedConversationLink | undefined> {
  const db = await shareDb()
  const key = await storageKey(db)
  const secret = crypto.getRandomValues(new Uint8Array(32))
  const contentKey = await crypto.subtle.importKey('raw', secret, 'AES-GCM', false, ['encrypt'])
  const compressed = await new Promise<Uint8Array>((resolve, reject) => gzip(file, (error, bytes) => {
    if (error) reject(error)
    else resolve(bytes)
  }))
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, contentKey, new Uint8Array(compressed)))
  const blob = new Blob([MAGIC, nonce, encrypted])
  if (blob.size > MAX_BLOB) throw new Error(translate('remoteHostedTooLarge'))
  if (!current()) return undefined

  // Once the upload is dispatched, finish recording the revoke token even if
  // the user changes session or closes the dialog.
  const response = await hostedRequest('?ttl=' + ttl, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: blob,
  })
  if (response.status !== 201) throw hostedFailure(response)
  const reply: unknown = await response.json()
  if (typeof reply !== 'object' || reply === null || !('id' in reply) || typeof reply.id !== 'string' || !ID.test(reply.id) ||
      !('deleteToken' in reply) || typeof reply.deleteToken !== 'string' || !TOKEN.test(reply.deleteToken)) {
    throw new Error(translate('remoteHostedInvalid'))
  }
  const expiry = 'expiresAt' in reply && typeof reply.expiresAt === 'string' && Number.isFinite(Date.parse(reply.expiresAt)) ? reply.expiresAt : null
  const link = { id: reply.id, key: toBase64Url(secret), deleteToken: reply.deleteToken, title, created: Date.now(), expiry }
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(link.id) }, key,
      new TextEncoder().encode(JSON.stringify(link)))
    await db.put('links', { iv, ciphertext }, link.id)
  } catch (error) {
    try { await removeShare(link.id, link.deleteToken) }
    catch { throw new Error(translate('remoteHostedSaveAndRevokeFailed')) }
    throw error
  }
  return link
}

export async function readHostedConversation(value: string, signal: AbortSignal) {
  let url: URL
  try { url = new URL(value.trim().replace(/^dshgo:\/\//u, 'https://')) }
  catch { throw new Error(translate('remoteHostedInvalid')) }
  const id = /^\/c\/([0-9A-Za-z]{10})\/?$/u.exec(url.pathname)?.[1]
  const secret = new URLSearchParams(url.hash.slice(1)).get('k')
  if (url.origin !== ORIGIN || url.username || url.password || !id || !isIdentityKey(secret)) {
    throw new Error(translate('remoteHostedInvalid'))
  }
  const response = await hostedRequest('/' + id, {}, AbortSignal.any([signal, AbortSignal.timeout(90_000)]))
  if (!response.ok) throw hostedFailure(response)
  try {
    const bytes = await readCapped(response.body, MAX_BLOB)
    if (bytes.length < 32 || MAGIC.some((byte, index) => bytes[index] !== byte)) throw new Error('Invalid ciphertext')
    const key = await crypto.subtle.importKey('raw', new Uint8Array(fromBase64Url(secret)!), 'AES-GCM', false, ['decrypt'])
    const compressed = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(4, 16) }, key, bytes.subarray(16))
    const unzip = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))
    return await decodeConversationShare(await readCapped(unzip, MAX_CONVERSATION_FILE))
  } catch {
    throw new Error(translate('remoteHostedInvalid'))
  }
}
