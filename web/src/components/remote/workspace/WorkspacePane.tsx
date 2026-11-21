import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useIsMobile } from '../../../app/viewport.js'
import { useTranslate } from '../../../i18n/index.js'
import { useNewSessionStore } from '../../../services/remote/newSessionStore.js'
import { downloadFromUrl, downloadWorkspacePath } from '../../../services/remote/download.js'
import { useRemoteStore } from '../../../services/remote/store.js'
import type { RemoteWorkspace } from '../../../services/remote/sessionsApi.js'
import { useAnchoredPosition, useDismiss } from '../../base/anchored.js'
import { IconButton } from '../../base/IconButton.js'
import { IconChevronDownOutline14, IconCloseOutline16, IconDownloadOutline16, IconRefreshOutline16 } from '../../base/icons.js'
import { FilePreview } from './FilePreview.js'
import { baseNameOf, parentRelativePath } from '../../../services/remote/filesApi.js'
import { WorkspaceList } from './WorkspaceList.js'
import { buildWorkspaceItems } from './workspaceItems.js'
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
  const hostWorkspaces = useNewSessionStore((state) => state.hostWorkspaces)
  const rows = useNewSessionStore((state) => state.rows)
  const activeSessionId = useRemoteStore((state) => state.activeSessionId)
  /** 工作区切换列表是否展开（S2：与新建会话页共用同一份合并后的列表） */
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const switcher = useAnchoredPosition<HTMLButtonElement, HTMLDivElement>(switcherOpen, {
    align: 'end',
    maxHeight: 320,
    minSpace: 160,
  })
  useDismiss(switcherOpen, [switcher.anchorRef, switcher.floatingRef], () => setSwitcherOpen(false), {
    captureEscape: true,
  })

  const close = (): void => useWorkspacePane.getState().closePane()
  const rootNode = nodes['']

  /**
   * 下载当前预览（文本 / 图片）。
   *
   * 只做「取字节 → 交给原生 /__ds_download/save」这一件事，文案与失败原因都在
   * `services/remote/download.ts` 里统一处理（toast 一次），这里只管按钮的忙碌态。
   * 图片优先用预览里已经建好的 blob URL（省一次远端往返），文本按整份文件重读。
   */
  const [downloading, setDownloading] = useState(false)
  const downloadPreview = (): void => {
    const current = useWorkspacePane.getState().preview
    if (current === null || downloading) return
    setDownloading(true)
    const scopeId = useWorkspacePane.getState().scopeId
    const task =
      current.kind === 'image' && current.url !== undefined
        ? downloadFromUrl(current.url, baseNameOf(current.path), current.mimeType)
        : downloadWorkspacePath(current.path, { scopeId })
    void task
      .catch(() => undefined)
      .then(() => setDownloading(false))
  }
  const downloadVisible =
    preview !== null && (preview.kind === 'text' || preview.kind === 'image') && preview.status !== 'loading'

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
   * 工作区切换（S2）：
   *   - 列表用 `useNewSessionStore.workspaces`（`workspace/follow` 权威 + 派生补缺的**合并结果**），
   *     所以「本机有这个工作区、但会话列表里恰好没有它的行」也能看见，并显示会话数；
   *   - `workspaceFiles/*` 只按**会话**工作区起作用，所以选项背后必须是「那个工作区里的一个会话」：
   *     优先 `session/list` 里最新的那条，其次 baseline 的 `sessionIds`；
   *   - 确实没有会话的工作区**照样列出来**（灰掉 + 一行说明），不能悄悄消失 —— 用户看不见它
   *     才会以为「它没识别到我的工作区」。
   */
  const sessionOfWorkspace = (workspace: RemoteWorkspace): string | undefined => {
    const fromRows = rows
      .filter((row) => row.workspaceId === workspace.workspaceId && row.parentSessionId === undefined)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]
    if (fromRows !== undefined) return fromRows.sessionId
    return workspace.sessionIds[0]
  }
  const workspaceOfSession = (sessionId: string | null): string | null => {
    if (sessionId === null) return null
    const row = rows.find((item) => item.sessionId === sessionId)
    if (row?.workspaceId !== undefined) return row.workspaceId
    return workspaces.find((workspace) => workspace.sessionIds.includes(sessionId))?.workspaceId ?? null
  }
  const currentWorkspaceId = workspaceOfSession(activeSessionId)
  const switchItems = buildWorkspaceItems({
    workspaces,
    hostWorkspaces,
    currentWorkspaceId,
    disabledOf: (workspace) => sessionOfWorkspace(workspace) === undefined,
    hintOf: (workspace) => (sessionOfWorkspace(workspace) === undefined ? t('workspaces.noSessionsHint') : undefined),
  })
  const switchable = workspaces.length > 1
  const currentWorkspace = workspaces.find((workspace) => workspace.workspaceId === currentWorkspaceId)
  const switchLabel = currentWorkspace === undefined
    ? t('workspaces.switch')
    : currentWorkspace.title.length > 0
      ? currentWorkspace.title
      : currentWorkspace.path

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
          {downloadVisible ? (
            <IconButton
              size="xs"
              tooltip={t('downloadAction')}
              icon={<IconDownloadOutline16 />}
              disabled={downloading}
              onClick={downloadPreview}
            />
          ) : null}
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
            <>
              <button
                ref={switcher.anchorRef}
                type="button"
                className={styles.switchTrigger}
                aria-haspopup="dialog"
                aria-expanded={switcherOpen}
                aria-label={t('workspaces.switch')}
                title={t('workspaces.switchHint')}
                onClick={() => setSwitcherOpen((open) => !open)}
              >
                <span className={styles.switchLabel}>{switchLabel}</span>
                <span className={styles.switchArrow} aria-hidden>
                  <IconChevronDownOutline14 />
                </span>
              </button>
              {switcherOpen
                ? createPortal(
                  <div
                    ref={switcher.floatingRef}
                    className={styles.switchMenu}
                    style={switcher.position ?? undefined}
                    role="dialog"
                    aria-label={t('workspaces.switch')}
                  >
                    <WorkspaceList
                      testId="workspace-switch-list"
                      label={t('workspaces.listLabel')}
                      items={switchItems}
                      onSelect={(item) => {
                        const workspace = workspaces.find((entry) => entry.workspaceId === item.workspaceId)
                        setSwitcherOpen(false)
                        if (workspace === undefined) return
                        const sessionId = sessionOfWorkspace(workspace)
                        if (sessionId === undefined) return
                        // 真切换：让 `workspaceFileScopeId` 跟着会话换到那个工作区（只换标题是骗人）
                        void Promise.resolve(useRemoteStore.getState().openSession(sessionId)).catch(() => undefined)
                      }}
                    />
                  </div>,
                  document.body,
                )
                : null}
            </>
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
