import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { toSessionSummary, type Session, type SessionSummary } from './types.js'
import * as dbNative from './dbNative.js'
import { migrationEnd, migrationProgress, migrationStart } from './migrationState.js'

/** IndexedDB 存储结构版本；新增或调整存储、索引时递增。 */
const DB_VERSION = 11

/** 文件原件按附件的本地 id 存储，所有引用同一 id 的消息共用一份；用于缩略图、打开查看，以及没有 serverId 时补传。 */
export type StoredFile = {
  id: string
  blob: Blob
}

/** 文件引用留在摘要中，删除会话时通过索引判断原件是否仍被引用。 */
type StoredSessionSummary = SessionSummary & { fileIds: string[] }

interface ChatDB extends DBSchema {
  /** 当前使用的会话，界面读写都在这里 */
  sessions: { key: string; value: Session }
  sessionSummaries: {
    key: string
    value: StoredSessionSummary
    indexes: { fileIds: string }
  }
  /** 当前使用的文件原件 */
  files: { key: string; value: StoredFile }
  /**
   * 历史导入的暂存：导入过程中会话与原件只写入这两个存储，`sessions` / `files` 保持不变；
   * 全部校验通过后在一个事务中替换正式数据并清空暂存，失败时只清空暂存。
   */
  sessionsStaging: { key: string; value: Session }
  filesStaging: { key: string; value: StoredFile }
}

let dbPromise: Promise<IDBPDatabase<ChatDB>> | null = null

const storedSummary = (session: Session): StoredSessionSummary => ({
  ...toSessionSummary(session),
  fileIds: [
    ...new Set(
      session.messages.flatMap((message) =>
        message.role === 'user' ? message.files.map((file) => file.id) : []
      )
    ),
  ],
})

const abortTransaction = (tx: { abort(): void }) => {
  try {
    tx.abort()
  } catch {
    // 事务已因请求失败中止。
  }
}

// 每个操作拿到连接后立即创建事务；IndexedDB 按创建顺序执行范围重叠的事务，读取总能看到之前发起的写入。
const getDB = () =>
  (dbPromise ??= openDB<ChatDB>('chat-demo', DB_VERSION, {
    upgrade(db, _oldVersion, _newVersion, tx) {
      // 初始化当前格式需要的存储与索引，不迁移旧消息。
      for (const name of ['sessions', 'files', 'sessionsStaging', 'filesStaging'] as const) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id' })
        }
      }
      const summaries = db.objectStoreNames.contains('sessionSummaries')
        ? tx.objectStore('sessionSummaries')
        : db.createObjectStore('sessionSummaries', { keyPath: 'id' })
      if (!summaries.indexNames.contains('fileIds')) {
        summaries.createIndex('fileIds', 'fileIds', { multiEntry: true })
      }
    },
  }).catch((error: unknown) => {
    // 打开失败后允许界面重试，避免一直复用已拒绝的 Promise。
    dbPromise = null
    throw error
  }))

// ---------------------------------------------------------------- IndexedDB 实现
// 下面这一组是换原生 SQLite 之前的原实现，逐字保留（重命名成 idb* 只为和原生实现区分）。
// 页面在没有原生壳时走这里；原生迁移失败时也退回这里，行为与升级前完全一致。

const idbLoadSessionSummaries = async (): Promise<SessionSummary[]> =>
  (await (await getDB()).getAll('sessionSummaries')).map(toSessionSummary)

const idbLoadSession = async (id: string): Promise<Session | undefined> =>
  (await getDB()).get('sessions', id)

const idbSaveSession = async (session: Session, files: StoredFile[] = []): Promise<void> => {
  const summary = storedSummary(session)
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries', 'files'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        for (const file of files) {
          await tx.objectStore('files').put(file)
        }
        await tx.objectStore('sessions').put(session)
        await tx.objectStore('sessionSummaries').put(summary)
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

/** 未打开的会话也可重命名，只读取该会话，原子更新详情和列表。 */
const idbRenameSession = async (id: string, title: string): Promise<void> => {
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        const sessions = tx.objectStore('sessions')
        const session = await sessions.get(id)
        if (session) {
          session.title = title
          await sessions.put(session)
          await tx.objectStore('sessionSummaries').put(storedSummary(session))
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

/** 删除会话，仅清理已无会话引用的本地原件；远端文件不删。 */
const idbDeleteSession = async (sessionId: string): Promise<void> => {
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries', 'files'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        const summaries = tx.objectStore('sessionSummaries')
        const summary = await summaries.get(sessionId)
        await tx.objectStore('sessions').delete(sessionId)
        await summaries.delete(sessionId)
        for (const id of summary?.fileIds ?? []) {
          if ((await summaries.index('fileIds').count(id)) === 0) {
            await tx.objectStore('files').delete(id)
          }
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

const idbPutFiles = async (store: 'files' | 'filesStaging', files: StoredFile[]) => {
  const tx = (await getDB()).transaction(store, 'readwrite')
  await Promise.all([...files.map((file) => tx.store.put(file)), tx.done])
}

const idbSaveFiles = (files: StoredFile[]): Promise<void> => idbPutFiles('files', files)

const idbLoadFile = async (id: string): Promise<Blob | undefined> =>
  (await (await getDB()).get('files', id))?.blob

/** 清空导入暂存：开始导入前清除上次中断（如关闭页面）遗留的数据，导入失败后清除本次写入。 */
const idbClearStaging = async (): Promise<void> => {
  const tx = (await getDB()).transaction(['sessionsStaging', 'filesStaging'], 'readwrite')
  await Promise.all([
    tx.objectStore('sessionsStaging').clear(),
    tx.objectStore('filesStaging').clear(),
    tx.done,
  ])
}

const idbAddStagingSession = async (session: Session): Promise<void> => {
  await (await getDB()).add('sessionsStaging', session)
}

const idbSaveStagingFiles = (files: StoredFile[]): Promise<void> =>
  idbPutFiles('filesStaging', files)

/** 图片位于会话 JSON 之后；全部读完后回填具体 MIME，保留归档给出的 isImage 标识。 */
const idbUpdateStagingFileTypes = async (
  types: ReadonlyMap<string, string>
): Promise<void> => {
  const tx = (await getDB()).transaction('sessionsStaging', 'readwrite')
  await Promise.all([
    (async () => {
      for (let cursor = await tx.store.openCursor(); cursor; cursor = await cursor.continue()) {
        const session = cursor.value
        let changed = false
        for (const message of session.messages) {
          if (message.role !== 'user') {
            continue
          }
          for (const file of message.files) {
            const type = types.get(file.id) ?? ''
            if (file.mimeType !== type) {
              file.mimeType = type
              changed = true
            }
          }
        }
        if (changed) {
          await cursor.update(session)
        }
      }
    })(),
    tx.done,
  ])
}

/**
 * 导入完成后用暂存替换正式数据：同一事务中替换会话、摘要和原件，并清空暂存。
 * 逐条游标复制，同一时间只读取一条记录；事务失败时整体回滚，正式数据不变。
 */
const idbCommitStaging = async (): Promise<SessionSummary[]> => {
  const summaries: SessionSummary[] = []
  const tx = (await getDB()).transaction(
    ['sessions', 'sessionSummaries', 'files', 'sessionsStaging', 'filesStaging'],
    'readwrite'
  )
  const move = async (from: 'sessionsStaging' | 'filesStaging', to: 'sessions' | 'files') => {
    try {
      const target = tx.objectStore(to)
      await target.clear()
      if (to === 'sessions') {
        await tx.objectStore('sessionSummaries').clear()
      }
      for (
        let cursor = await tx.objectStore(from).openCursor();
        cursor;
        cursor = await cursor.continue()
      ) {
        await target.put(cursor.value)
        if (to === 'sessions') {
          const summary = storedSummary(cursor.value as Session)
          await tx.objectStore('sessionSummaries').put(summary)
          summaries.push(toSessionSummary(summary))
        }
      }
      await tx.objectStore(from).clear()
    } catch (error) {
      // 同步抛出的错误不会让事务自动回滚，需显式中止，避免只提交清空和部分移入。
      abortTransaction(tx)
      throw error
    }
  }
  await Promise.all([move('sessionsStaging', 'sessions'), move('filesStaging', 'files'), tx.done])
  // 直接返回本次提交的列表，调用方无需在替换成功后再发起可能失败的读取。
  return summaries
}

// ---------------------------------------------------------------- 后端选择
//
// 原生 SQLite 可用就用它，否则用 IndexedDB。选择只做一次，结果缓存；
// **不在模块顶层 await** —— 那样会阻塞首屏，第一次真正读写时才决出后端。

/** 回滚开关：`localStorage['chat-demo:native-store'] = 'off'` 强制走 IndexedDB */
const NATIVE_SWITCH_KEY = 'chat-demo:native-store'

export type StorageBackend = 'native' | 'indexeddb'

/** 两种实现共用的接口，对外导出的一律是这一层转发 */
type DbImpl = {
  loadSessionSummaries: () => Promise<SessionSummary[]>
  loadSession: (id: string) => Promise<Session | undefined>
  saveSession: (session: Session, files?: StoredFile[]) => Promise<void>
  renameSession: (id: string, title: string) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  saveFiles: (files: StoredFile[]) => Promise<void>
  loadFile: (id: string) => Promise<Blob | undefined>
}

const indexedDbImpl: DbImpl = {
  loadSessionSummaries: idbLoadSessionSummaries,
  loadSession: idbLoadSession,
  saveSession: idbSaveSession,
  renameSession: idbRenameSession,
  deleteSession: idbDeleteSession,
  saveFiles: idbSaveFiles,
  loadFile: idbLoadFile,
}

const nativeImpl: DbImpl = {
  loadSessionSummaries: dbNative.loadSessionSummaries,
  loadSession: dbNative.loadSession,
  saveSession: dbNative.saveSession,
  renameSession: dbNative.renameSession,
  deleteSession: dbNative.deleteSession,
  saveFiles: dbNative.saveFiles,
  loadFile: dbNative.loadFile,
}

let implPromise: Promise<DbImpl> | null = null
let backend: StorageBackend | 'pending' = 'pending'

const getImpl = (): Promise<DbImpl> => (implPromise ??= pickImpl())

const pickImpl = async (): Promise<DbImpl> => {
  migrationStart()
  const native = await useNative()
  migrationEnd(native)
  backend = native ? 'native' : 'indexeddb'
  return native ? nativeImpl : indexedDbImpl
}

const readSwitch = (): string | null => {
  try {
    return window.localStorage.getItem(NATIVE_SWITCH_KEY)
  } catch {
    // 读不到 localStorage（隐私模式）时按默认走，不影响功能
    return null
  }
}

/**
 * 探测 + 迁移：任一步不成立都退回 IndexedDB。
 * 迁移失败不标记、不抛给界面，下次启动重试；IndexedDB 的数据始终原地保留。
 */
const useNative = async (): Promise<boolean> => {
  if (!(await dbNative.probe())) {
    return false
  }
  if (readSwitch() === 'off') {
    return false
  }
  return dbNative.migrate(
    {
      summaries: idbLoadSessionSummaries,
      loadSession: idbLoadSession,
      loadFile: idbLoadFile,
    },
    // 迁移可能要跑好几秒，进度必须让用户看得见
    (progress) => migrationProgress(progress)
  )
}

/** 当前存储后端；第一次读写之前返回 pending（设置页据此显示「检测中」）。 */
export const currentBackend = (): StorageBackend | 'pending' => backend

// ---------------------------------------------------------------- 对外接口（签名与行为不变）

export const loadSessionSummaries = async (): Promise<SessionSummary[]> =>
  (await getImpl()).loadSessionSummaries()

export const loadSession = async (id: string): Promise<Session | undefined> =>
  (await getImpl()).loadSession(id)

export const saveSession = async (session: Session, files: StoredFile[] = []): Promise<void> =>
  (await getImpl()).saveSession(session, files)

export const renameSession = async (id: string, title: string): Promise<void> =>
  (await getImpl()).renameSession(id, title)

export const deleteSession = async (sessionId: string): Promise<void> =>
  (await getImpl()).deleteSession(sessionId)

export const saveFiles = async (files: StoredFile[]): Promise<void> =>
  (await getImpl()).saveFiles(files)

export const loadFile = async (id: string): Promise<Blob | undefined> =>
  (await getImpl()).loadFile(id)

// 导入暂存是瞬态数据，搬去原生收益为零、风险很高：这四个入口永远走 IndexedDB。

export const clearStaging = idbClearStaging

export const addStagingSession = idbAddStagingSession

export const saveStagingFiles = idbSaveStagingFiles

export const updateStagingFileTypes = idbUpdateStagingFileTypes

/**
 * 导入完成后用暂存替换正式数据：IndexedDB 的事务是权威结果，成功后再同步到原生。
 *
 * 原生同步失败只留痕：返回值与 IndexedDB 的内容才是用户可见的结果，
 * 不能因为原生库写不进去就让界面报「导入失败」。
 */
export const commitStaging = async (): Promise<SessionSummary[]> => {
  const summaries = await idbCommitStaging()
  await syncNative(summaries)
  return summaries
}

/**
 * 把「整体替换」的结果同步到原生库。
 *
 * 除了逐条写入，还要删掉原生侧本次没有保留下来的会话：导入/清空历史是整体替换语义，
 * 少删这一步，「删除全部会话」之后原生库里的旧会话会在下次启动重新冒出来。
 *
 * 只在后端已经确定是原生时才同步：这里**不主动触发探测/迁移**，
 * 免得在一个导入事务中间又跑一遍迁移（迁移由第一次读写负责，正常早就完成了）。
 */
const syncNative = async (summaries: SessionSummary[]): Promise<void> => {
  if (backend !== 'native') {
    return
  }
  try {
    const keep = new Set(summaries.map((summary) => summary.id))
    for (const existing of await dbNative.loadSessionSummaries()) {
      if (!keep.has(existing.id)) {
        await dbNative.deleteSession(existing.id)
      }
    }
    for (const summary of summaries) {
      const session = await idbLoadSession(summary.id)
      if (!session) {
        continue
      }
      const files: StoredFile[] = []
      for (const id of storedSummary(session).fileIds) {
        const blob = await idbLoadFile(id)
        if (blob) {
          files.push({ id, blob })
        }
      }
      await dbNative.saveSession(session, files)
    }
  } catch (error) {
    reportStorageError('sync native store')(error)
  }
}

/** 本地存储失败不打断对话，只在控制台留痕 */
export const reportStorageError = (action: string) => (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[storage] ${action} failed`, error)
}
