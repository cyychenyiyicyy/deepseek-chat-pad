import { formatDate } from '../../utils/format.js'
import * as db from './db.js'
import { replaceHistory, useChatStore } from './store.js'
import type { ImportProgress } from './history/importArchive.js'
import type { Session } from './types.js'

import { BackupError } from './history/errors.js'

export { BackupError }

// 导入、导出与全部删除串行处理，避免读取归档时数据被清空或两个替换事务交错。
let backupQueue: Promise<unknown> = Promise.resolve()

const enqueueBackup = <T>(run: () => Promise<T>): Promise<T> => {
  const task = backupQueue.then(run)
  backupQueue = task.catch(() => {})
  return task
}

const backupFileName = (date: Date) => `deepseek_data-${formatDate(date)}.zip`

/** 导出为历史会话导出格式的 ZIP，可再次导入。 */
export const exportHistory = (): Promise<{ name: string; blob: Blob }> =>
  enqueueBackup(async () => {
    // 列表和已加载内容保留导出开始时的快照；未打开的会话逐条读取，不填满详情缓存。
    const { sessions, sessionCache } = useChatStore.getState()
    async function* readSessions(): AsyncGenerator<Session> {
      for (const summary of sessions) {
        const session = Object.hasOwn(sessionCache, summary.id)
          ? sessionCache[summary.id]
          : await db.loadSession(summary.id)
        if (!session) {
          throw new Error(`History session disappeared during export: ${summary.id}`)
        }
        // 详情读取期间可能重命名，归档标题与开始时的列表保持一致。
        yield { ...session, ...summary }
      }
    }
    const { exportArchive } = await import('./history/exportArchive.js')
    const now = new Date()
    const blob = await exportArchive(readSessions())
    return { name: backupFileName(now), blob }
  })

/**
 * 确认覆盖后调用：先检查 ZIP 格式与版本，校验失败时保留正在生成的回答；
 * 通过后从 ZIP 流式写入暂存，成功才替换原有会话与图片原件。返回导入的会话数。
 */
/** 超过这个大小就不进内存了，避免平板上直接 OOM */
const MAX_IMPORT_BYTES = 256 * 1024 * 1024

export const importHistory = (
  file: File,
  onProgress?: (progress: ImportProgress) => void
): Promise<number> =>
  enqueueBackup(async () => {
    const { checkArchiveFormat, importArchive } = await import('./history/importArchive.js')
    const { memorySource } = await import('./history/zipReader.js')

    if (file.size > MAX_IMPORT_BYTES) {
      throw new BackupError('backupTooLarge')
    }

    // 先把整个包顺序读进内存再解析。
    // ZIP 的中央目录解析是逐条目随机读，而 content:// 文件每次 slice 都要跨进程，
    // 条目一多就会越来越慢——60MB 的导出包足以卡到界面一直显示「已解析 0 个对话」。
    onProgress?.({ phase: 'reading', sessions: 0, files: 0 })
    const buffer = await file.arrayBuffer()
    const source = memorySource(buffer)

    await checkArchiveFormat(source, onProgress)
    return replaceHistory(() => importArchive(source, onProgress))
  })

/** 确认删除后调用：以空历史原子替换全部本地会话与附件，保留 API Key 和其他设置。 */
export const clearHistory = (): Promise<void> =>
  enqueueBackup(async () => {
    await replaceHistory(async () => {})
  })
