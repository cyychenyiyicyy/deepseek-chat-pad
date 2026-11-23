import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { NewSessionDraftFile } from '../../../services/remote/newSessionStore.js'
import type { DraftAttachment } from './workspacePaneStore.js'

export interface NewSessionDeliveryDraft {
  sessionId: string
  configuration: string
  receipts: [string, string][]
}

interface AttachmentDraftRecord {
  id: string
  owner: string
  sessionId: string
  updatedAt: number
  attachment: DraftAttachment
}

interface AttachmentDraftDatabase extends DBSchema {
  drafts: {
    key: string
    value: AttachmentDraftRecord
    indexes: { scope: [string, string]; updatedAt: number }
  }
  newSessionDrafts: {
    key: string
    value: { owner: string; updatedAt: number; files: NewSessionDraftFile[] }
    indexes: { updatedAt: number }
  }
  newSessionDelivery: {
    key: string
    value: { owner: string; updatedAt: number; delivery: NewSessionDeliveryDraft }
    indexes: { updatedAt: number }
  }
}

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
let opening: Promise<IDBPDatabase<AttachmentDraftDatabase>> | undefined
let pruning: Promise<void> | undefined

function draftDb() {
  return opening ??= openDB<AttachmentDraftDatabase>('chat-pad-remote-attachment-drafts', 3, {
    upgrade(db, version) {
      if (version < 1) {
        const drafts = db.createObjectStore('drafts', { keyPath: 'id' })
        drafts.createIndex('scope', ['owner', 'sessionId'])
        drafts.createIndex('updatedAt', 'updatedAt')
      }
      if (version < 2) {
        const drafts = db.createObjectStore('newSessionDrafts', { keyPath: 'owner' })
        drafts.createIndex('updatedAt', 'updatedAt')
      }
      if (version < 3) {
        const delivery = db.createObjectStore('newSessionDelivery', { keyPath: 'owner' })
        delivery.createIndex('updatedAt', 'updatedAt')
      }
    },
  }).catch((error: unknown) => {
    opening = undefined
    throw error
  })
}

const draftStores = ['drafts', 'newSessionDrafts', 'newSessionDelivery'] as const

async function pruneDrafts(db: IDBPDatabase<AttachmentDraftDatabase>) {
  const transaction = db.transaction(draftStores, 'readwrite')
  const cutoff = IDBKeyRange.upperBound(Date.now() - RETENTION_MS)
  await Promise.all(draftStores.map(async (name) => {
    const store = transaction.objectStore(name)
    let cursor = await store.index('updatedAt').openKeyCursor(cutoff)
    while (cursor) {
      await store.delete(cursor.primaryKey)
      cursor = await cursor.continue()
    }
  }))
  await transaction.done
}

export async function readAttachmentDrafts(owner: string, sessionId: string): Promise<DraftAttachment[]> {
  const db = await draftDb()
  pruning ??= pruneDrafts(db).catch(() => { pruning = undefined })
  const cutoff = Date.now() - RETENTION_MS
  return (await db.getAllFromIndex('drafts', 'scope', [owner, sessionId]))
    .filter((record) => record.updatedAt > cutoff)
    .sort((a, b) => (a.attachment.pickedAt ?? a.updatedAt) - (b.attachment.pickedAt ?? b.updatedAt))
    .map((record) => record.attachment)
}

export async function writeAttachmentDraft(entry: DraftAttachment): Promise<void> {
  const attachment = entry.status === 'uploading' ? {
    ...entry, status: 'error' as const, progress: 0, phase: undefined, compressing: false, error: undefined,
  } : entry
  await (await draftDb()).put('drafts', {
    id: entry.id, owner: entry.owner, sessionId: entry.sessionId, updatedAt: Date.now(), attachment,
  })
}

export async function deleteAttachmentDraft(id: string): Promise<void> {
  await (await draftDb()).delete('drafts', id)
}

export async function clearAttachmentDrafts(): Promise<void> {
  const transaction = (await draftDb()).transaction(draftStores, 'readwrite')
  await Promise.all([...draftStores.map(name => transaction.objectStore(name).clear()), transaction.done])
}

export async function readNewSessionFiles(owner: string): Promise<NewSessionDraftFile[]> {
  const db = await draftDb()
  pruning ??= pruneDrafts(db).catch(() => { pruning = undefined })
  const draft = await db.get('newSessionDrafts', owner)
  return draft && draft.updatedAt > Date.now() - RETENTION_MS ? draft.files : []
}

export async function writeNewSessionFiles(owner: string, files: NewSessionDraftFile[], isCurrent: () => boolean): Promise<void> {
  const db = await draftDb()
  if (!isCurrent()) return
  if (files.length === 0) await db.delete('newSessionDrafts', owner)
  else await db.put('newSessionDrafts', { owner, files, updatedAt: Date.now() })
}

export async function readNewSessionDelivery(owner: string): Promise<NewSessionDeliveryDraft | undefined> {
  const db = await draftDb()
  pruning ??= pruneDrafts(db).catch(() => { pruning = undefined })
  const record = await db.get('newSessionDelivery', owner)
  return record && record.updatedAt > Date.now() - RETENTION_MS ? record.delivery : undefined
}

export async function writeNewSessionDelivery(owner: string, delivery: NewSessionDeliveryDraft | null, isCurrent: () => boolean): Promise<void> {
  const db = await draftDb()
  if (!isCurrent()) return
  if (delivery === null) await db.delete('newSessionDelivery', owner)
  else await db.put('newSessionDelivery', { owner, delivery, updatedAt: Date.now() })
}
