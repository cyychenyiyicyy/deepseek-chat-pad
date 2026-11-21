/**
 * 「点开一个交付文件」的**唯一入口**：把工具给的路径换算成会话工作区相对路径，
 * 再交给工作区抽屉的 `openAt()`。
 *
 * 为什么单独一个文件：时间线里那一轮的 chip、顶栏「本次会话的交付文件」列表、
 * 以及「全部下载」，三处都要做同一件事（映射 + 缺失降级 + 一句人话），
 * 复制三份必然有一份忘了处理「文件已被删」。
 */

import { showToast } from '../../base/toastState.js'
import type { ArtifactFile } from '../../../services/remote/artifacts.js'
import { toWorkspaceRelative } from '../../../services/remote/artifacts.js'
import { useNewSessionStore } from '../../../services/remote/newSessionStore.js'
import { useRemoteStore } from '../../../services/remote/store.js'
import { useWorkspacePane } from '../workspace/workspacePaneStore.js'
import { useArtifactsUi } from './artifactsUiState.js'

/**
 * 工作区根路径（绝对）：交付文件里的路径可能是绝对的，必须知道 root 才能换成相对路径。
 *
 * 抽屉自己的 `rootPath` 是「打开抽屉时补一次」的；chip 可能在抽屉从没打开过时就被点，
 * 所以这里主动补一次（`ensureWorkspaceFlags` 在 store 里是**按连接只拉一次**的缓存调用，
 * `resolveRoot` 只读本地行，不会打网络）。
 */
const ensureWorkspaceRoot = async (): Promise<string> => {
  let pane = useWorkspacePane.getState()
  if (pane.scopeId === null) {
    const active = useRemoteStore.getState().activeSessionId
    if (active === null) return ''
    await pane.bind(active)
    pane = useWorkspacePane.getState()
  }
  if (pane.rootPath.length === 0) {
    try {
      await useNewSessionStore.getState().ensureWorkspaceFlags()
    } catch {
      // 拉不到会话清单不影响「相对路径」这种最常见的情况
    }
    useWorkspacePane.getState().resolveRoot()
  }
  return useWorkspacePane.getState().rootPath
}

/** 这个产物在当前会话工作区里的相对路径；映射不上返回 `null`。 */
export const artifactRelativePath = (file: ArtifactFile, root: string): string | null =>
  toWorkspaceRelative(file.path, root)

/**
 * 在工作区抽屉里打开这个文件的预览。
 *
 * 三种结局都说清楚，**绝不留白**：
 *  - 打开成功：抽屉里就是那份文件（图片 / 文本 / 二进制占位）；
 *  - 文件已不存在：chip 标红、toast 一句「文件已不存在」，**不**去读一个空文件（也就不会白屏）；
 *  - 根本映射不到工作区（工作区之外 / 不知道 root）：说「不在本次会话的工作区里」，
 *    这不是错误，是路径本身就不在可预览的范围内。
 */
export const openArtifactFile = async (file: ArtifactFile): Promise<void> => {
  // 能力门禁：Host 没有 `workspaceFiles/*`（`METHOD_NOT_FOUND`）时抽屉整块不存在，
  // 说「不支持」比说「没连上」诚实 —— 后者会让人一直点着重试。
  if (useWorkspacePane.getState().filesSupported === false) {
    showToast({ key: 'artifactsUnsupported' })
    return
  }
  const root = await ensureWorkspaceRoot()
  const relative = toWorkspaceRelative(file.path, root)
  if (relative === null) {
    showToast({ key: 'artifactsOutsideWorkspace', params: { name: file.name } })
    return
  }
  const result = await useWorkspacePane.getState().openAt(relative)
  if (result === 'ok') {
    useArtifactsUi.getState().markPresent(file.path)
    return
  }
  if (result === 'missing') {
    useArtifactsUi.getState().markMissing(file.path)
    showToast({ key: 'artifactsFileMissingToast', params: { name: file.name } })
    return
  }
  showToast({ key: 'artifactsPreviewUnavailable' })
}
