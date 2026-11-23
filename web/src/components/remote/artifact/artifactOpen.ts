/**
 * 「点开一个交付文件」的**唯一入口**：本地文件交给工作区抽屉预览，外链交给浏览器。
 *
 * 为什么单独一个文件：产物卡里的每一行、以及以后别处要复用这一动作的地方，
 * 都要做同一件事（路径映射 + 能力降级 + 一句人话）。三处各写一份，
 * 必然有一处忘了处理「文件已被删」或者「Host 根本不支持工作区文件」。
 *
 * 三种结局都说清楚，**绝不留白**（与 R12 的教训一致）：
 *  - 打开成功：抽屉里就是那份文件（图片 / 文本 / 二进制占位）；
 *  - 文件已不存在：toast 一句「文件已不存在」，**不**去读一个空文件（也就不会白屏）；
 *  - 映射不到工作区：说「不在本次会话的工作区里」—— 这不是错误，是这份文件本来就不在可预览范围。
 */

import type { ArtifactFile } from '../../../services/remote/artifacts.js'
import { toWorkspaceRelative } from '../../../services/remote/artifacts.js'
import { useNewSessionStore } from '../../../services/remote/newSessionStore.js'
import { lastRemoteTarget } from '../../../services/remote/sessionsApi.js'
import { remoteSessionSelectionVersion, useRemoteStore } from '../../../services/remote/store.js'
import { showToast } from '../../base/toastState.js'
import { useWorkspacePane } from '../workspace/workspacePaneStore.js'

/** `openArtifactFile()` 的结论：界面据此决定要不要重试 / 标灰。 */
export type ArtifactOpenResult = 'opened' | 'external' | 'missing' | 'outside' | 'unavailable'

/**
 * 工作区根路径（绝对）。
 *
 * 抽屉自己的 `rootPath` 是「打开抽屉时补一次」的；产物行可能在抽屉从没打开过时就被点，
 * 所以这里主动补一次（`ensureWorkspaceFlags` 在 store 里是**按连接只拉一次**的缓存调用，
 * `resolveRoot` 只读本地行，不会打网络）。
 */
const ensureWorkspaceRoot = async (isCurrent: () => boolean): Promise<string> => {
  if (useWorkspacePane.getState().rootPath.length === 0) {
    try {
      await useNewSessionStore.getState().ensureWorkspaceFlags()
    } catch {
      // 拉不到会话清单不影响「相对路径」这种最常见的情况
    }
    if (isCurrent()) useWorkspacePane.getState().resolveRoot()
  }
  return useWorkspacePane.getState().rootPath
}

/**
 * 打开一条产物。
 *
 * 外链（`file.url`）直接 `window.open`：`present` 只收本地普通文件，
 * 这个分支是给「Host 把外链塞进 files」兜底的，走浏览器比走工作区更诚实。
 */
export const openArtifactFile = async (file: ArtifactFile): Promise<ArtifactOpenResult> => {
  if (file.url !== undefined) {
    window.open(file.url, '_blank', 'noopener,noreferrer')
    return 'external'
  }
  const target = lastRemoteTarget()
  const sessionId = useRemoteStore.getState().activeSessionId
  const selection = remoteSessionSelectionVersion()
  if (target === null || sessionId === null) return 'unavailable'
  const isCurrent = () => lastRemoteTarget() === target &&
    remoteSessionSelectionVersion() === selection &&
    useRemoteStore.getState().activeSessionId === sessionId &&
    useWorkspacePane.getState().attachmentTarget === target &&
    useWorkspacePane.getState().scopeId === sessionId
  await useWorkspacePane.getState().bind(sessionId)
  if (!isCurrent()) return 'unavailable'
  // 能力门禁：Host 没有 `workspaceFiles/*`（`METHOD_NOT_FOUND`）时抽屉整块不存在，
  // 说「不支持」比说「没连上」诚实 —— 后者会让人一直点着重试。
  if (useWorkspacePane.getState().filesSupported === false) {
    showToast({ key: 'artifactUnsupported' })
    return 'unavailable'
  }
  const root = await ensureWorkspaceRoot(isCurrent)
  if (!isCurrent()) return 'unavailable'
  const relative = toWorkspaceRelative(file.path, root)
  if (relative === null) {
    showToast({ key: 'artifactOutsideWorkspace', params: { name: file.name } })
    return 'outside'
  }
  const result = await useWorkspacePane.getState().openAt(relative)
  if (!isCurrent()) return 'unavailable'
  if (result === 'ok') {
    return 'opened'
  }
  if (result === 'missing') {
    showToast({ key: 'artifactFileMissingToast', params: { name: file.name } })
    return 'missing'
  }
  showToast({ key: 'artifactPreviewUnavailable' })
  return 'unavailable'
}
