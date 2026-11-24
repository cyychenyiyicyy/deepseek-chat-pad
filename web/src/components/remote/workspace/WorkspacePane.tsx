import clsx from 'clsx'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useIsMobile } from '../../../app/viewport.js'
import { useTranslate } from '../../../i18n/index.js'
import { useNewSessionStore } from '../../../services/remote/newSessionStore.js'
import { downloadFromUrl, downloadWorkspacePath } from '../../../services/remote/download.js'
import { registerRemoteStreamSink, useRemoteStore } from '../../../services/remote/store.js'
import { lastRemoteTarget, type RemoteStreamHandle, type RemoteWorkspace } from '../../../services/remote/sessionsApi.js'
import { useSettings } from '../../../services/settings.js'
import { useAnchoredPosition, useDismiss } from '../../base/anchored.js'
import { IconButton } from '../../base/IconButton.js'
import { IconChevronDownOutline14, IconCloseOutline16, IconDownloadOutline16, IconRefreshOutline16 } from '../../base/icons.js'
import { FilePreview } from './FilePreview.js'
import { baseNameOf, parentRelativePath, watchWorkspacePath } from '../../../services/remote/filesApi.js'
import { WorkspaceList } from './WorkspaceList.js'
import { buildWorkspaceItems } from './workspaceItems.js'
import { useWorkspacePane } from './workspacePaneStore.js'
import { WorkspaceTree } from './WorkspaceTree.js'
import styles from './WorkspacePane.module.css'

const subscribeWidth = (onChange: () => void) => {
  window.addEventListener('resize', onChange)
  return () => window.removeEventListener('resize', onChange)
}

/** Workspace files for the active remote session. */
export const WorkspacePane = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const scale = useSettings((state) => state.uiScale)
  const wide = useSyncExternalStore(subscribeWidth, () => window.innerWidth / scale >= 1200)
  const docked = wide && !isMobile
  const newSessionOpen = useNewSessionStore((state) => state.open)
  const ready = useRemoteStore((state) => state.phase === 'ready')
  const open = useWorkspacePane((state) => state.open)
  const supported = useWorkspacePane((state) => state.filesSupported)
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

  const close = (): void => {
    setSwitcherOpen(false)
    useWorkspacePane.getState().closePane()
  }
  const visible = open && supported !== false && !newSessionOpen && ready
  const rootNode = nodes['']
  const watchTarget = visible ? lastRemoteTarget() : null
  const watchPath = preview?.path ?? ''

  useEffect(() => {
    if (watchTarget === null || activeSessionId === null) return undefined
    let stopped = false
    let stream: RemoteStreamHandle | undefined
    let unsubscribe: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const current = () => !stopped && lastRemoteTarget() === watchTarget &&
      useRemoteStore.getState().phase === 'ready' && useRemoteStore.getState().activeSessionId === activeSessionId
    const refresh = () => {
      if (!current()) return
      const workspace = useWorkspacePane.getState()
      if (!workspace.open || workspace.scopeId !== activeSessionId || (workspace.preview?.path ?? '') !== watchPath) return
      if (watchPath === '') void workspace.refresh()
      else void workspace.openFile(watchPath)
    }
    void watchWorkspacePath(watchTarget, activeSessionId, watchPath).then(async (opened) => {
      if (!current()) {
        await opened.close()
        return
      }
      stream = opened
      unsubscribe = registerRemoteStreamSink(opened.streamId, (frame) => {
        if (!current() || frame.type !== 'frame' || !frame.hasValue ||
          frame.value === null || typeof frame.value !== 'object' || !('kind' in frame.value)) return
        if (frame.value.kind === 'ready') {
          const workspace = useWorkspacePane.getState()
          const loading = watchPath === '' ? workspace.nodes['']?.loading : workspace.preview?.status === 'loading'
          if (loading) return
        } else if (frame.value.kind !== 'change') return
        clearTimeout(timer)
        timer = setTimeout(refresh, 120)
      })
    }).catch(() => undefined)
    return () => {
      stopped = true
      clearTimeout(timer)
      unsubscribe?.()
      if (stream !== undefined) void stream.close().catch(() => undefined)
    }
  }, [watchTarget, watchPath, activeSessionId])

  /**
   * 下载当前文件。
   *
   * 只做「取字节 → 交给原生 /__ds_download/save」这一件事，文案与失败原因都在
   * `services/remote/download.ts` 里统一处理（toast 一次），这里只管按钮的忙碌态。
   * 图片优先用预览里已经建好的 blob URL（省一次远端往返），文本按整份文件重读。
   */
  const [downloading, setDownloading] = useState(false)
  const downloadPreview = (): void => {
    const current = useWorkspacePane.getState().preview
    const scopeId = useWorkspacePane.getState().scopeId
    if (current === null || scopeId === null || downloading ||
      scopeId !== useRemoteStore.getState().activeSessionId) return
    setDownloading(true)
    const task =
      current.kind === 'image' && current.url !== undefined
        ? downloadFromUrl(current.url, baseNameOf(current.path), current.mimeType)
        : downloadWorkspacePath(current.path, { scopeId })
    void task
      .catch(() => undefined)
      .then(() => setDownloading(false))
  }
  const downloadVisible = preview !== null && preview.status !== 'loading'

  // Esc 关闭（手机上等价于「返回」）；预览优先退到目录
  useEffect(() => {
    if (!visible) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented ||
        document.querySelector('[role="dialog"][aria-modal="true"]:not([data-workspace-pane])')) return
      if (switcherOpen) {
        setSwitcherOpen(false)
        return
      }
      if (useWorkspacePane.getState().preview !== null) {
        useWorkspacePane.getState().closePreview()
        return
      }
      useWorkspacePane.getState().closePane()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [visible, switcherOpen])

  useEffect(() => () => useWorkspacePane.getState().closePane(), [])

  if (!visible) return null

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

  const panel = (
    <div
      className={clsx(styles.panel, docked ? styles.panelDocked : isMobile ? styles.panelMobile : styles.panelSide)}
      role={docked ? 'complementary' : 'dialog'}
      aria-modal={docked ? undefined : true}
      aria-label={t('workspacePaneTitle')}
      data-workspace-pane
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

    </div>
  )

  return docked ? panel : createPortal(
    <div
      className={clsx(styles.overlay, isMobile && styles.overlayMobile)}
      onClick={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      {panel}
    </div>,
    document.body,
  )
}
