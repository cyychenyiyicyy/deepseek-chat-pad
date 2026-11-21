import clsx from 'clsx'
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useIsMobile } from '../../../app/viewport.js'
import { useTranslate } from '../../../i18n/index.js'
import { useNewSessionStore } from '../../../services/remote/newSessionStore.js'
import { useRemoteStore } from '../../../services/remote/store.js'
import { IconButton } from '../../base/IconButton.js'
import { IconCloseOutline16, IconRefreshOutline16 } from '../../base/icons.js'
import { Select, type SelectOption } from '../../base/Select.js'
import { FilePreview } from './FilePreview.js'
import { baseNameOf, parentRelativePath } from '../../../services/remote/filesApi.js'
import { useWorkspacePane } from './workspacePaneStore.js'
import { WorkspaceTree } from './WorkspaceTree.js'
import styles from './WorkspacePane.module.css'

/**
 * 工作区文件抽屉（W3）。
 *
 * 形态与 `NewSessionPanel` 同一套约定：
 *   - **平板 / 桌面**：右侧一列（380px，左侧圆角 + 投影），会话页仍在左边可用；
 *   - **手机**：整屏 sheet（顶栏带返回 / 标题 / 关闭）。
 *
 * 结构：顶栏（标题 + 当前工作区路径 + 工作区切换 + 刷新 + 关闭）→ 路径面包屑 →
 * 目录树（懒加载，一次一目录）／文件预览（文本 / 图片 / 二进制占位）。
 *
 * 三个纪律：
 *  1. **能力门禁**：`filesSupported === false` 时**整个组件不渲染**（`RemoteChatView` 里连入口
 *     按钮都不画），所以这里不需要「不支持」的漂亮空态 —— 只有真正会发生的错误条；
 *  2. **切换工作区**是真切换：`workspaceFiles/*` 只按**会话**工作区起作用，所以选项背后是
 *     「那个工作区里最近的会话」，选中即 `openSession()`，文件作用域跟着走；
 *  3. **blob URL 必须释放**：预览被替换 / 关闭 / 换会话 / 卸载时都 `revokeObjectURL`。
 */
export const WorkspacePane = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const open = useWorkspacePane((state) => state.open)
  const supported = useWorkspacePane((state) => state.filesSupported)
  const scopeId = useWorkspacePane((state) => state.scopeId)
  const rootPath = useWorkspacePane((state) => state.rootPath)
  const rootSource = useWorkspacePane((state) => state.rootSource)
  const error = useWorkspacePane((state) => state.error)
  const preview = useWorkspacePane((state) => state.preview)
  const nodes = useWorkspacePane((state) => state.nodes)
  const workspaces = useNewSessionStore((state) => state.workspaces)
  const rows = useNewSessionStore((state) => state.rows)
  const activeSessionId = useRemoteStore((state) => state.activeSessionId)

  const close = (): void => useWorkspacePane.getState().closePane()
  const rootNode = nodes['']

  // Esc 关闭（手机上等价于「返回」）；预览优先退到目录
  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (useWorkspacePane.getState().preview !== null) {
        useWorkspacePane.getState().closePreview()
        return
      }
      close()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open])

  // 卸载（远程页被换掉）时把图片 blob URL 还回去
  useEffect(
    () => () => {
      const state = useWorkspacePane.getState()
      if (state.preview !== null && state.preview.kind === 'image' && state.preview.url !== undefined) {
        URL.revokeObjectURL(state.preview.url)
      }
    },
    [],
  )

  if (!open || supported === false) return null

  /*
   * 工作区切换：选项 = 有会话的工作区。选中后就 `openSession(最近的那个)`，
   * 让 `workspaceFileScopeId` 真的换到那个工作区 —— 不能只换标题（那是骗人）。
   */
  const workspaceOptions: SelectOption<string>[] = workspaces.flatMap((workspace) => {
    const sessions = rows
      .filter((row) => row.workspaceId === workspace.workspaceId && row.parentSessionId === undefined)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    const first = sessions[0]
    if (first === undefined) return []
    return [{
      value: first.sessionId,
      label: workspace.title.length > 0 ? workspace.title : workspace.path,
    }]
  })
  const currentValue = activeSessionId ?? ''
  const switchable = workspaceOptions.length > 1

  const displayPath = rootPath.length > 0 ? rootPath : t('workspacePaneUnknownRoot')
  const currentDir = preview !== null ? parentRelativePath(preview.path) : ''

  return createPortal(
    <div className={clsx(styles.overlay, isMobile && styles.overlayMobile)} onClick={close}>
      <div
        className={clsx(styles.panel, isMobile ? styles.panelMobile : styles.panelSide)}
        role="dialog"
        aria-modal="true"
        aria-label={t('workspacePaneTitle')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.header}>
          <div className={styles.headerText}>
            <div className={styles.title}>{t('workspacePaneTitle')}</div>
            <div className={styles.path} title={displayPath}>
              {displayPath}
            </div>
          </div>
          <IconButton
            size="xs"
            tooltip={t('workspacePaneRefresh')}
            icon={<IconRefreshOutline16 />}
            onClick={() => void useWorkspacePane.getState().refresh(currentDir)}
          />
          <IconButton
            size="xs"
            tooltip={t('workspacePaneClose')}
            icon={<IconCloseOutline16 />}
            onClick={close}
          />
        </div>

        <div className={styles.toolbar}>
          {switchable ? (
            <Select
              value={currentValue}
              options={workspaceOptions}
              ariaLabel={t('workspacePaneSwitchWorkspace')}
              placeholder={t('workspacePaneSwitchWorkspace')}
              onChange={(value) => {
                if (value.length === 0) return
                void Promise.resolve(useRemoteStore.getState().openSession(value)).catch(() => undefined)
              }}
            />
          ) : (
            <span className={styles.rootBadge}>{t('workspacePaneRoot')}</span>
          )}
          {preview === null ? (
            <span className={styles.dirLabel}>{t('workspacePaneFilesHere')}</span>
          ) : (
            <button
              type="button"
              className={styles.backButton}
              onClick={() => useWorkspacePane.getState().closePreview()}
            >
              {t('workspacePaneBack')} · {baseNameOf(preview.path)}
            </button>
          )}
        </div>

        {rootSource === 'unknown' ? (
          <div className={styles.notice}>{t('workspacePaneUnknownRootHint')}</div>
        ) : null}
        {error !== null ? <div className={styles.error}>{error}</div> : null}

        <div className={styles.body}>
          {preview !== null ? (
            <FilePreview preview={preview} />
          ) : rootNode === undefined || (rootNode.loading && !rootNode.loaded) ? (
            <div className={styles.notice}>{t('workspacePaneLoading')}</div>
          ) : rootNode.error !== null ? (
            <div className={styles.error}>{rootNode.error}</div>
          ) : rootNode.entries.length === 0 ? (
            <div className={styles.notice}>{t('workspacePaneEmptyDir')}</div>
          ) : (
            <WorkspaceTree path="" depth={0} />
          )}
        </div>

        {scopeId === null ? null : (
          <div className={styles.footer} title={scopeId}>
            {t('workspacePaneScope', { session: scopeId.slice(0, 8) })}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
