import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useIsMobile } from '../../../app/viewport.js'
import { useTranslate } from '../../../i18n/index.js'
import type { ChatItem } from '../../../services/remote/adapter.js'
import {
  artifactExtensionOf,
  downloadArtifacts,
  sessionArtifacts,
  type ArtifactFile,
} from '../../../services/remote/artifacts.js'
import { downloadWorkspacePath } from '../../../services/remote/download.js'
import { useRemoteStore } from '../../../services/remote/store.js'
import { showToast } from '../../base/toastState.js'
import { IconCloseOutline16, IconDownloadOutline16 } from '../../base/icons.js'
import { FileIcon } from '../../files/FileIcon.js'
import styles from './Artifacts.module.css'
import { useArtifactsUi } from './artifactsUiState.js'
import { IconArtifactsOutline16 } from './artifactsGlyphs.js'
import { artifactRelativePath, openArtifactFile } from './openArtifact.js'
import { useWorkspacePane } from '../workspace/workspacePaneStore.js'

/**
 * 会话级交付文件：顶栏的一个入口 + 一个抽屉（全会话产物，去重、按时间倒序）。
 *
 * 「入口放哪」这件事这里说明白：`⋯` 菜单本体在 `components/remote/chat-controls/**`，
 * 这一批改动**不许碰那个目录**（另一条线正在改审批/提问的交互）。所以入口做成顶栏里
 * 与 `⋯` 同尺寸（26px 圆形）的一个图标按钮，**紧挨在 `⋯` 左边**；抽屉里的一行行与
 * `⋯` 菜单的行同构，将来并进菜单只是把 `<SessionArtifactsPanel>` 挂到菜单里，
 * 不需要重写（见 `work/2026-11-21-chatpad接入DSH远程/input-R12-交付文件.md`）。
 *
 * 三条纪律：
 *  1. **没有产物就不画入口**（`files.length === 0` 时返回 `null`）：空会话的顶栏不该多一个按钮，
 *     点开也只能看到一句「还没有交付文件」，那是噪音。
 *  2. **全部下载是串行的**（`downloadArtifacts`），带进度、失败跳过并在末尾一句话汇总；
 *     每个文件都不弹 toast（`silent`），否则 10 个文件会刷 10 条。
 *  3. **文件已不存在**：点行 → `openArtifactFile` → 抽屉里那一行划掉 + 红字「文件已不存在」，
 *     并把状态记进 `useArtifactsUi`，时间线里的同名 chip 也会一起变红。
 */
export const SessionArtifactsEntry = ({
  items,
  streaming,
}: {
  items: readonly ChatItem[]
  streaming: boolean
}) => {
  const t = useTranslate()
  const files = sessionArtifacts(items, { streaming })
  /*
   * 抽屉的开合放在 `useArtifactsUi` 里（不是本地 state）：
   * 任何入口都能开同一个抽屉 —— 顶栏这个图标按钮、以及将来 `⋯` 菜单里加的一行，
   * 只需要 `useArtifactsUi.getState().openSession()`（见报告 §7 的合并补丁）。
   */
  const open = useArtifactsUi((state) => state.sessionOpen)
  const activeSessionId = useRemoteStore((state) => state.activeSessionId)

  /*
   * 换会话：把「已不存在」的标记清掉、抽屉收起。
   * 那些标记是路径级的（同一个工作区里 `README.md` 只有一个），换到别的会话后
   * 同名相对路径可能完全指另一个文件，留着就会红得莫名其妙。
   */
  useEffect(() => {
    useArtifactsUi.getState().reset()
  }, [activeSessionId])

  return (
    <>
      {/* 没有产物就不画入口（顶栏不该多一个点开是空列表的按钮）；
          但抽屉仍然受 `sessionOpen` 控制 —— 从 `⋯` 菜单打开时会给出空态说明 */}
      {files.length > 0 ? (
        <button
          type="button"
          className={styles.entry}
          aria-label={t('artifactsSessionOpen')}
          title={t('artifactsSessionOpenHint', { count: files.length })}
          onClick={() => useArtifactsUi.getState().openSession()}
        >
          <IconArtifactsOutline16 />
          <span className={styles.entryBadge} aria-hidden>
            {files.length > 99 ? '99+' : files.length}
          </span>
        </button>
      ) : null}
      {open ? (
        <SessionArtifactsDrawer files={files} onClose={() => useArtifactsUi.getState().closeSession()} />
      ) : null}
    </>
  )
}

/* ────────────────────────────── 抽屉 ────────────────────────────── */

const SessionArtifactsDrawer = ({
  files,
  onClose,
}: {
  files: readonly ArtifactFile[]
  onClose: () => void
}) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const missing = useArtifactsUi((state) => state.missing)
  /** 能力门禁：`false` = 这台 Host 没有工作区文件端点（预览 / 下载都做不了） */
  const filesSupported = useWorkspacePane((state) => state.filesSupported)
  /** 进度：`null` = 没在下载；`{index,total}` = 正在取第 index 个（0 基） */
  const [progress, setProgress] = useState<{ index: number; total: number } | null>(null)
  /** 下载途中面板被关掉：下一个文件之前停下（不再读远端） */
  const openRef = useRef(true)

  useEffect(
    () => () => {
      openRef.current = false
    },
    [],
  )

  // Esc = 返回（与工作区抽屉同一套约定）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const close = (): void => {
    openRef.current = false
    onClose()
  }

  const downloadAll = (): void => {
    if (progress !== null) return
    void (async () => {
      const scopeId = useWorkspacePane.getState().scopeId
      const root = useWorkspacePane.getState().rootPath
      if (scopeId === null) {
        showToast({ key: 'artifactsPreviewUnavailable' })
        return
      }
      // 不在会话工作区里的文件没法整份读回来：先摘出去，最后一起算进「没成功」
      const relativeOf = new Map<string, string>()
      for (const file of files) {
        const relative = artifactRelativePath(file, root)
        if (relative !== null) {
          relativeOf.set(file.path, relative)
        }
      }
      const targets = files.filter((file) => relativeOf.has(file.path))
      const skipped = files.length - targets.length
      if (targets.length === 0) {
        showToast({ key: 'artifactsDownloadFailed', params: { count: skipped } })
        return
      }
      setProgress({ index: 0, total: targets.length })
      const summary = await downloadArtifacts(targets, {
        download: (file) => {
          const relative = relativeOf.get(file.path)
          if (relative === undefined) {
            return Promise.reject(new Error('missing target'))
          }
          // `silent`：单个文件成功不弹 toast，由这里最后汇总一次
          return downloadWorkspacePath(relative, { scopeId, silent: true })
        },
        onProgress: (state) => setProgress({ index: state.index, total: state.total }),
        shouldStop: () => !openRef.current,
      })
      setProgress(null)
      const failed = summary.failed.length + skipped
      if (failed === 0) {
        showToast({ key: 'artifactsDownloadDone', params: { count: summary.saved.length } })
        return
      }
      showToast({ key: 'artifactsDownloadFailed', params: { count: failed } })
    })()
  }

  const downloading = progress !== null
  const progressPercent =
    progress === null || progress.total === 0
      ? 0
      : Math.round(((progress.index + 0.5) / progress.total) * 100)

  return createPortal(
    <div className={clsx(styles.overlay, isMobile && styles.overlayMobile)} onClick={close}>
      <div
        className={clsx(styles.panel, isMobile ? styles.panelMobile : styles.panelSide)}
        role="dialog"
        aria-modal="true"
        aria-label={t('artifactsSessionTitle')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.drawerHead}>
          <div className={styles.drawerTitleWrap}>
            <div className={styles.drawerTitle}>{t('artifactsSessionTitle')}</div>
            <div className={styles.drawerSubtitle}>
              {t('artifactsSessionTotal', { count: files.length })}
            </div>
          </div>
          <button
            type="button"
            className={styles.entry}
            aria-label={t('artifactsClose')}
            onClick={close}
          >
            <IconCloseOutline16 />
          </button>
        </div>

        <div className={styles.drawerBar}>
          {filesSupported === false ? (
            <span className={styles.progressText}>{t('artifactsUnsupported')}</span>
          ) : (
            <button
              type="button"
              className={styles.downloadAll}
              disabled={downloading}
              onClick={downloadAll}
            >
              <IconDownloadOutline16 />
              {t('artifactsDownloadAll')}
            </button>
          )}
          {progress === null ? null : (
            <div className={styles.progressWrap}>
              <span className={styles.progressText}>
                {t('artifactsDownloading', {
                  done: Math.min(progress.index + 1, progress.total),
                  total: progress.total,
                })}
              </span>
              <div className={styles.progressTrack}>
                <div className={styles.progressFill} style={{ width: `${progressPercent}%` }} />
              </div>
            </div>
          )}
        </div>

        <div className={styles.list}>
          {files.length === 0 ? (
            <div className={styles.empty}>{t('artifactsSessionEmpty')}</div>
          ) : (
            files.map((file) => (
              <ArtifactListRow key={file.path} file={file} missing={missing[file.path] === true} />
            ))
          )}
        </div>

        <div className={styles.hint}>{t('artifactsSessionHint')}</div>
      </div>
    </div>,
    document.body,
  )
}

/** 抽屉里的一行：点它 = 在工作区里预览（与 chip 完全同一条路径）。 */
const ArtifactListRow = ({ file, missing }: { file: ArtifactFile; missing: boolean }) => {
  const t = useTranslate()
  const [busy, setBusy] = useState(false)
  const open = (): void => {
    // 标了「已不存在」也允许再点一次：文件可能被重新生成，让用户有路可走
    if (busy) return
    setBusy(true)
    void openArtifactFile(file).finally(() => setBusy(false))
  }
  return (
    <button
      type="button"
      className={styles.listRow}
      data-missing={missing}
      data-busy={busy}
      title={file.path}
      onClick={open}
    >
      <span className={styles.listIcon} aria-hidden>
        <FileIcon ext={artifactExtensionOf(file.path)} />
      </span>
      <span className={styles.listCopy}>
        <span className={styles.listName}>{file.name}</span>
        <span className={styles.listDir}>
          {file.dir.length === 0 ? t('artifactsRootDir') : file.dir}
        </span>
      </span>
      <span className={styles.listTail}>
        {missing ? (
          <span className={styles.listMissing}>{t('artifactsFileMissing')}</span>
        ) : (
          t(file.origin === 'created' ? 'artifactsOriginCreated' : 'artifactsOriginModified')
        )}
      </span>
    </button>
  )
}
