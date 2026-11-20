/**
 * 会话存储的原生实现：走 Android 本地壳提供的 `/__ds_db` 接口（SQLite）。
 *
 * 接口与 Java 侧的 DbHandler 一一对应：
 *   GET  /__ds_db/state            探测 + 迁移校验
 *   GET  /__ds_db/summaries        会话列表（只读摘要，不碰消息表）
 *   GET  /__ds_db/session?id=      打开单个会话；404 表示不存在
 *   POST /__ds_db/session          写会话（会话 + 全部消息行）
 *   POST /__ds_db/rename           改标题
 *   POST /__ds_db/delete           删会话
 *   POST /__ds_db/file?id=         附件原件（原始字节）
 *   GET  /__ds_db/file?id=         读回原件
 *   POST /__ds_db/import           迁移用批量导入
 *
 * 在普通浏览器里这些接口不存在，`probe()` 返回 false，`db.ts` 会继续走 IndexedDB。
 * 所有请求都带 `cache: 'no-store'`：本地壳的响应不该被 WebView 缓存。
 *
 * 迁移铁律（见 native-sqlite-design.md 第四、五节）：
 *   - IndexedDB 永不删除，它同时是迁移源和回滚后备；
 *   - 迁移按 id upsert，重复执行不产生重复数据；
 *   - 迁移后必须校验（会话总数 + 抽查 3 个会话的消息数），不一致就算失败；
 *   - 失败只在控制台留痕、返回 false，绝不抛给界面。
 */
import { toSessionSummary, type Session, type SessionSummary } from './types.js'

const BASE = '/__ds_db'

/** 迁移成功的本地标记；值是迁移时间（便于排查） */
const MIGRATED_KEY = 'chat-demo:native-migrated'

/** 迁移时的会话批大小：一批一个事务 */
const SESSION_BATCH = 20
/** 附件分批上传，避免一次开几十个请求把本地服务挤满 */
const FILE_BATCH = 8
/** 迁移后抽查的会话数 */
const SAMPLE_SESSIONS = 3
/**
 * 单个 import 请求的体积上限（字符数近似）。
 * 原生侧对请求体有 32MB 硬上限，超了会 413；会话特别长时按体积再拆一刀，宁可多跑几个请求。
 */
const MAX_BATCH_CHARS = 6 * 1024 * 1024

/** `/__ds_db/state` 的响应 */
export type NativeState = {
  schemaVersion: number
  sessions: number
  messages: number
  files: number
  migrated: boolean
}

/**
 * 附件记录。结构与 `db.ts` 的 `StoredFile` 一致；这里独立声明是为了不反向依赖 db.ts
 * （那会形成 db.ts → dbNative.ts → db.ts 的循环引用）。
 */
export type NativeFile = { id: string; blob: Blob }

/**
 * 迁移的数据来源：由 `db.ts` 把 IndexedDB 的读接口注进来。
 * 这样 dbNative 不必自己再开一个 IndexedDB 连接（库名/版本只有 db.ts 一处真源）。
 */
export type MigrationSource = {
  summaries: () => Promise<SessionSummary[]>
  loadSession: (id: string) => Promise<Session | undefined>
  loadFile: (id: string) => Promise<Blob | undefined>
}

// ---------------------------------------------------------------- HTTP 小工具

const request = (path: string, init?: RequestInit): Promise<Response> =>
  fetch(`${BASE}${path}`, { cache: 'no-store', ...init })

/** 非 2xx 一律抛错，由调用方（db.ts / 迁移流程）决定是退回 IDB 还是原样上报 */
const ensureOk = async (response: Response, label: string): Promise<void> => {
  if (response.ok) {
    return
  }
  const body = (await response.json().catch(() => null)) as { error?: string } | null
  throw new Error(`[native] ${label} HTTP ${response.status}${body?.error ? ` ${body.error}` : ''}`)
}

/** 读 JSON 接口；`ok !== true` 也当失败（接口约定的失败形状） */
const readJson = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await request(path, init)
  await ensureOk(response, path)
  const body = (await response.json()) as T & { ok?: boolean; error?: string }
  if (body.ok !== true) {
    throw new Error(`[native] ${path} ${body.error ?? 'failed'}`)
  }
  return body
}

const postJson = async (path: string, payload: unknown): Promise<void> => {
  await readJson<unknown>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // 已经序列化好的（超大的 import 批次）直接用，避免再 stringify 一遍
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  })
}

// ---------------------------------------------------------------- 读

/** 读原生状态；接口不可用（浏览器 / 老版本壳 / 404）返回 null。 */
const readState = async (): Promise<NativeState | null> => {
  try {
    const body = await readJson<Partial<NativeState>>('/state')
    return {
      schemaVersion: Number(body.schemaVersion ?? 0),
      sessions: Number(body.sessions ?? 0),
      messages: Number(body.messages ?? 0),
      files: Number(body.files ?? 0),
      migrated: body.migrated === true,
    }
  } catch {
    return null
  }
}

/** 原生存储是否可用：只有 `/__ds_db/state` 成功才算。 */
export const probe = async (): Promise<boolean> => (await readState()) !== null

export const loadSessionSummaries = async (): Promise<SessionSummary[]> => {
  const body = await readJson<{ sessions?: SessionSummary[] }>('/summaries')
  // 原生摘要里可能多带 rootMessageId 之类的字段，统一收成 SessionSummary 的四项
  return (body.sessions ?? []).map(toSessionSummary)
}

/** 打开会话；不存在返回 undefined（与 IndexedDB 版一致），由上层报「加载失败」。 */
export const loadSession = async (id: string): Promise<Session | undefined> => {
  const response = await request(`/session?id=${encodeURIComponent(id)}`)
  if (response.status === 404) {
    return undefined
  }
  await ensureOk(response, '/session')
  const body = (await response.json()) as { ok?: boolean; session?: Session; error?: string }
  if (body.ok !== true || !body.session) {
    throw new Error(`[native] /session ${body.error ?? 'failed'}`)
  }
  return body.session
}

/** 读回附件原件；不存在返回 undefined。MIME 走 X-DS-Mime 响应头带回来。 */
export const loadFile = async (id: string): Promise<Blob | undefined> => {
  const response = await request(`/file?id=${encodeURIComponent(id)}`)
  if (response.status === 404) {
    return undefined
  }
  await ensureOk(response, '/file')
  const type =
    response.headers.get('X-DS-Mime') ||
    response.headers.get('Content-Type') ||
    'application/octet-stream'
  return new Blob([await response.arrayBuffer()], { type })
}

// ---------------------------------------------------------------- 写

/** 会话引用到的附件 id（去重）；与 db.ts 里摘要用的派生规则一致。 */
const collectFileIds = (session: Session): string[] => [
  ...new Set(
    session.messages.flatMap((message) =>
      message.role === 'user' ? message.files.map((file) => file.id) : []
    )
  ),
]

/** 单个附件：请求体是原始字节，MIME 另走头（请求的 Content-Type 按契约固定 octet-stream）。 */
const uploadFile = async (file: NativeFile): Promise<void> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' }
  if (file.blob.type) {
    headers['X-DS-Mime'] = file.blob.type
  }
  const response = await request(`/file?id=${encodeURIComponent(file.id)}`, {
    method: 'POST',
    headers,
    body: file.blob,
  })
  await ensureOk(response, '/file')
}

/** 分批并发上传，失败向上抛（调用方按现有逻辑报错，不吞）。 */
const uploadAll = async (files: NativeFile[]): Promise<void> => {
  for (let index = 0; index < files.length; index += FILE_BATCH) {
    await Promise.all(files.slice(index, index + FILE_BATCH).map(uploadFile))
  }
}

/**
 * 写会话：先传原件再写会话。
 * 顺序很重要 —— 反过来一旦附件写失败，会话已经在库里、缩略图却永远缺，而且没有重试入口。
 */
export const saveSession = async (
  session: Session,
  files: NativeFile[] = []
): Promise<void> => {
  if (files.length > 0) {
    await uploadAll(files)
  }
  await postJson('/session', { session, fileIds: collectFileIds(session) })
}

export const renameSession = async (id: string, title: string): Promise<void> => {
  await postJson('/rename', { id, title })
}

export const deleteSession = async (sessionId: string): Promise<void> => {
  await postJson('/delete', { id: sessionId })
}

export const saveFiles = (files: NativeFile[]): Promise<void> => uploadAll(files)

// ---------------------------------------------------------------- 迁移

const readMigrated = (): boolean => {
  try {
    return window.localStorage.getItem(MIGRATED_KEY) !== null
  } catch {
    return false
  }
}

const writeMigrated = (): void => {
  try {
    window.localStorage.setItem(MIGRATED_KEY, new Date().toISOString())
  } catch {
    // 隐私模式写不进 localStorage：数据已经搬完，下次启动会重跑一遍（幂等，不会产生重复）
  }
}

/** 抽查用：会话数不够 3 个就全查。 */
const pickSamples = (summaries: SessionSummary[]): SessionSummary[] => {
  if (summaries.length <= SAMPLE_SESSIONS) {
    return summaries
  }
  const indexes = [0, Math.floor(summaries.length / 2), summaries.length - 1]
  return [...new Set(indexes)].map((index) => summaries[index])
}

/** 从 IndexedDB 侧取样，拿到每个会话应有的消息数。 */
const countSources = async (
  source: MigrationSource,
  samples: SessionSummary[]
): Promise<Map<string, number> | null> => {
  const counts = new Map<string, number>()
  for (const summary of samples) {
    const session = await source.loadSession(summary.id)
    if (!session) {
      return null
    }
    counts.set(summary.id, session.messages.length)
  }
  return counts
}

/**
 * 校验：会话总数 ≥ IndexedDB 侧的数量，且每个抽查会话的消息数与预期一致。
 *
 * @returns null 表示通过；否则返回失败原因（写进控制台）
 */
const verify = async (
  total: number,
  expected: ReadonlyMap<string, number>
): Promise<string | null> => {
  const state = await readState()
  if (!state) {
    return 'state_unavailable'
  }
  if (state.sessions < total) {
    return `sessions ${state.sessions} < ${total}`
  }
  for (const [id, count] of expected) {
    const session = await loadSession(id)
    if (!session) {
      return `missing ${id}`
    }
    if (session.messages.length !== count) {
      return `messages ${id} ${session.messages.length} != ${count}`
    }
  }
  return null
}

type Imported = {
  /** 每个会话应有的消息数（导入时的真值，校验直接用） */
  counts: Map<string, number>
  /** 需要搬的附件 id 全集 */
  fileIds: Set<string>
}

/**
 * 发一批会话。体积超标就二分再发：原生侧对请求体有 32MB 硬上限，
 * 长会话（一个会话几百 KB 的 JSON）凑满 20 个就可能顶到上限，被 413 拒掉会白白重跑一整轮迁移。
 */
const postSessions = async (sessions: Session[]): Promise<void> => {
  const payload = JSON.stringify({
    sessions,
    // file_ids 是会话自身的派生信息，随会话一起拼，二分时不用另外维护映射
    fileIdsById: Object.fromEntries(
      sessions.map((session) => [session.id, collectFileIds(session)])
    ),
  })
  if (sessions.length > 1 && payload.length > MAX_BATCH_CHARS) {
    const half = Math.ceil(sessions.length / 2)
    await postSessions(sessions.slice(0, half))
    await postSessions(sessions.slice(half))
    return
  }
  await postJson('/import', payload)
}

/** 分批导入会话；一批一个事务，失败整批回滚（下次启动重跑，按 id upsert 幂等）。 */
const importAll = async (
  source: MigrationSource,
  summaries: SessionSummary[]
): Promise<Imported> => {
  const counts = new Map<string, number>()
  const fileIds = new Set<string>()
  for (let index = 0; index < summaries.length; index += SESSION_BATCH) {
    const sessions: Session[] = []
    for (const summary of summaries.slice(index, index + SESSION_BATCH)) {
      const session = await source.loadSession(summary.id)
      if (!session) {
        throw new Error(`IndexedDB 里读不到会话 ${summary.id}`)
      }
      sessions.push(session)
      for (const id of collectFileIds(session)) {
        fileIds.add(id)
      }
      counts.set(summary.id, session.messages.length)
    }
    await postSessions(sessions)
  }
  return { counts, fileIds }
}

/** 搬运附件原件（分批）。本地没有原件的附件跳过：界面只展示文件名。 */
const uploadOriginals = async (
  source: MigrationSource,
  ids: Iterable<string>
): Promise<void> => {
  const list = [...ids]
  for (let index = 0; index < list.length; index += FILE_BATCH) {
    await Promise.all(
      list.slice(index, index + FILE_BATCH).map(async (id) => {
        const blob = await source.loadFile(id)
        if (blob) {
          await uploadFile({ id, blob })
        }
      })
    )
  }
}

/**
 * 把 IndexedDB 的会话与附件搬到原生库。
 *
 * @returns 成功（含「本来就迁移过」「新用户没有数据」）返回 true；任何一步失败返回 false，
 *          并且**不写标记**，下次启动重试。整个过程不抛异常给界面。
 */
export const migrate = async (source: MigrationSource): Promise<boolean> => {
  try {
    if (readMigrated()) {
      return true
    }
    const state = await readState()
    if (!state) {
      return false
    }
    const summaries = await source.summaries()
    if (summaries.length === 0) {
      // 新用户：IndexedDB 里没有会话，没有可搬的数据
      writeMigrated()
      return true
    }
    const samples = pickSamples(summaries)
    if (state.migrated) {
      // 原生侧已经搬过（上次 localStorage 没写成功、或标记被清掉）：先校验，通过就别再覆盖一遍
      const existing = await countSources(source, samples)
      if (existing && (await verify(summaries.length, existing)) === null) {
        writeMigrated()
        return true
      }
    }
    const imported = await importAll(source, summaries)
    await uploadOriginals(source, imported.fileIds)
    const expected = new Map<string, number>()
    for (const summary of samples) {
      expected.set(summary.id, imported.counts.get(summary.id) ?? -1)
    }
    const failure = await verify(summaries.length, expected)
    if (failure !== null) {
      // eslint-disable-next-line no-console
      console.warn(`[storage] 迁移校验未通过（${failure}），继续使用 IndexedDB`)
      return false
    }
    writeMigrated()
    // eslint-disable-next-line no-console
    console.info(`[storage] 已迁移 ${summaries.length} 个会话到原生 SQLite`)
    return true
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('[storage] 迁移到原生 SQLite 失败，继续使用 IndexedDB', error)
    return false
  }
}
