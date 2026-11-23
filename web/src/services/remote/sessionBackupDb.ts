import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { RemoteApiError } from './serverApi.js'
import type { SessionImportResult, SessionRestoreRequest, SessionTransferData, SessionTransferPeer } from './sessionTransfer.js'

export interface SessionBackup {
  id: string
  title: string
  sessionId: string
  throughSeq: number
  createdAt: number
  totalBytes: number
  sha256: string
}

export interface SessionRestoreRecord extends SessionRestoreRequest {
  backupId: string
  peer: SessionTransferPeer
  createdAt: number
  result?: SessionImportResult
}

interface BackupDatabase extends DBSchema {
  metadata: { key: string; value: SessionBackup }
  snapshots: { key: string; value: { iv: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer } }
  keys: { key: string; value: CryptoKey }
  restores: {
    key: string
    value: SessionRestoreRecord
    indexes: { backupId: string }
  }
}

let opening: Promise<IDBPDatabase<BackupDatabase>> | undefined
function backupDb() {
  return (opening ??= openDB<BackupDatabase>('chat-pad-remote-backups', 1, {
    upgrade(db) {
      db.createObjectStore('metadata', { keyPath: 'id' })
      db.createObjectStore('snapshots')
      db.createObjectStore('keys')
      db.createObjectStore('restores', { keyPath: 'requestId' }).createIndex('backupId', 'backupId')
    },
  }).catch((error: unknown) => {
    opening = undefined
    throw error
  }))
}

const keyName = 'session-snapshots'
async function snapshotKey(db: IDBPDatabase<BackupDatabase>): Promise<CryptoKey> {
  const existing = await db.get('keys', keyName)
  if (existing) return existing
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const tx = db.transaction('keys', 'readwrite')
  const concurrent = await tx.store.get(keyName)
  if (!concurrent) await tx.store.add(key, keyName)
  await tx.done
  return concurrent ?? key
}

const additionalData = (backup: SessionBackup) =>
  new TextEncoder().encode(JSON.stringify([backup.id, backup.sessionId, backup.totalBytes, backup.sha256]))

export async function saveSessionBackup(backup: SessionBackup, data: SessionTransferData) {
  const db = await backupDb()
  const key = await snapshotKey(db)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: additionalData(backup) }, key, data.bytes)
  const tx = db.transaction(['metadata', 'snapshots'], 'readwrite')
  await Promise.all([
    tx.objectStore('metadata').add(backup),
    tx.objectStore('snapshots').add({ iv, ciphertext }, backup.id),
    tx.done,
  ])
}

export async function openSessionBackup(backup: SessionBackup): Promise<SessionTransferData> {
  const db = await backupDb()
  const [snapshot, key] = await Promise.all([db.get('snapshots', backup.id), db.get('keys', keyName)])
  if (!snapshot || !key) throw new RemoteApiError('SESSION_BACKUP_MISSING', 'The backup or its storage key is unavailable')
  const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: snapshot.iv, additionalData: additionalData(backup) },
    key, snapshot.ciphertext)
  return { bytes: new Uint8Array(bytes), sha256: backup.sha256 }
}

export async function listSessionBackups() {
  const db = await backupDb()
  const [backups, restores] = await Promise.all([db.getAll('metadata'), db.getAll('restores')])
  return { backups: backups.sort((a, b) => b.createdAt - a.createdAt), restores: restores.sort((a, b) => b.createdAt - a.createdAt) }
}

export function sameBackupHost(a: SessionTransferPeer, b: SessionTransferPeer): boolean {
  return a.serverUrl === b.serverUrl && a.hostId === b.hostId && a.hostIdentity === b.hostIdentity
}

export function sameBackupPeer(a: SessionTransferPeer, b: SessionTransferPeer): boolean {
  return sameBackupHost(a, b) && a.deviceId === b.deviceId
}

export async function reserveSessionRestore(record: SessionRestoreRecord) {
  const db = await backupDb()
  const tx = db.transaction(['restores', 'metadata'], 'readwrite')
  const restores = tx.objectStore('restores')
  const [backup, existing] = await Promise.all([
    tx.objectStore('metadata').get(record.backupId),
    restores.index('backupId').getAll(record.backupId),
  ])
  if (!backup || existing.some((item) => item.result === undefined && sameBackupHost(item.peer, record.peer))) {
    await tx.done
    throw new RemoteApiError('SESSION_RESTORE_PENDING', 'An earlier restore must be checked before trying again')
  }
  await Promise.all([restores.add(record), tx.done])
}

export async function saveSessionRestoreResult(record: SessionRestoreRecord, result: SessionImportResult) {
  await (await backupDb()).put('restores', { ...record, result })
}

export async function forgetSessionRestore(record: SessionRestoreRecord) {
  await (await backupDb()).delete('restores', record.requestId)
}

export async function deleteSessionBackup(backupId: string) {
  const db = await backupDb()
  const tx = db.transaction(['snapshots', 'metadata', 'restores'], 'readwrite')
  const restores = tx.objectStore('restores')
  const records = await restores.index('backupId').getAll(backupId)
  if (records.some((record) => record.result === undefined)) {
    await tx.done
    throw new RemoteApiError('SESSION_RESTORE_PENDING', 'An earlier restore still needs to be checked')
  }
  await Promise.all([
    tx.objectStore('metadata').delete(backupId),
    tx.objectStore('snapshots').delete(backupId),
    ...records.map((record) => restores.delete(record.requestId)),
    tx.done,
  ])
}
