import clsx from 'clsx'
import { useTranslate } from '../../../i18n/index.js'
import { formatSize, getExtension } from '../../../services/attachments.js'
import { IconCloseFill14, IconRefreshOutline16 } from '../../base/icons.js'
import { FileIcon } from '../../files/FileIcon.js'
import { hasUploadingAttachment, useWorkspacePane, type DraftAttachment } from './workspacePaneStore.js'
import styles from './AttachmentTray.module.css'

/**
 * 输入框上方的附件条（会话附件上传，W3 / R15）。
 *
 * 一条 = 一次上传的结果，两种凭据在 chip 上要能**分开看**：
 *  - `receiptId`（`fileUploads/upload`）：发送时进 `{type:'file', receiptId}`；
 *  - `remotePath`（`workspace.upload.*`）：文件已经落在会话工作区，发送时正文追加 `@name`。
 *    这种 chip 的副标题写「已存到工作区 · @a.png」，让用户知道发出去的是什么。
 *
 * 三种状态不变：`uploading`（进度条）/ `done`（等发送）/ `error`（可重试 + 可读原因）。
 *
 * 失败原因两条来源：
 *  - 本地（读不到文件 / 超过上限）；
 *  - Host / 通道（`UPLOAD_*` / 两条通道都不可用）——`workspacePaneStore` 已经翻成人话。
 */
export const AttachmentTray = ({ compact = false }: { compact?: boolean }) => {
  const attachments = useWorkspacePane((state) => state.attachments)
  const uploadError = useWorkspacePane((state) => state.uploadError)
  if (attachments.length === 0 && uploadError === null) return null
  return (
    <div className={clsx(styles.tray, compact && styles.trayCompact)}>
      {attachments.map((attachment) => (
        <AttachmentChip key={attachment.id} attachment={attachment} />
      ))}
      {uploadError === null ? null : <div className={styles.error}>{uploadError}</div>}
    </div>
  )
}

const AttachmentChip = ({ attachment }: { attachment: DraftAttachment }) => {
  const t = useTranslate()
  const ext = getExtension(attachment.name)
  const failed = attachment.status === 'error'
  const uploading = attachment.status === 'uploading'
  const percent = Math.round(attachment.progress * 100)
  const inWorkspace = attachment.status === 'done' && attachment.remotePath !== undefined
  /** 被客户端压缩过就把「原体积 → 现体积」标出来，用户才知道传上去的不是原图 */
  const compressedTag =
    attachment.compressedFrom === undefined
      ? ''
      : ` · ${t('uploadCompressed', { from: formatSize(attachment.compressedFrom), to: formatSize(attachment.size) })}`
  const meta = failed
    ? attachment.error ?? t('workspacePaneAttachFailed')
    : attachment.compressing === true
      ? t('uploadCompressing')
      : uploading
        ? `${t('workspacePaneAttachUploading')} ${percent}%`
        : inWorkspace
          ? `${t('uploadRemoteWorkspaceSaved')}${attachment.reference === undefined ? '' : ` · ${attachment.reference}`}${compressedTag}`
          : `${formatSize(attachment.size)}${compressedTag}`
  return (
    <div
      className={clsx(styles.chip, failed && styles.chipFailed, inWorkspace && styles.chipWorkspace)}
      title={attachment.error ?? (inWorkspace && attachment.reference !== undefined ? t('uploadRemoteWorkspaceHint', { reference: attachment.reference }) : attachment.name)}
      data-upload-strategy={attachment.strategy ?? 'unknown'}
    >
      <span className={styles.chipIcon} aria-hidden>
        {/* 上传中转圈、其余显示文件类型（失败态靠红色描边 + 右侧重试按钮表达，避免一行两个刷新图标） */}
        {uploading ? <span className={styles.spinner} /> : <FileIcon ext={ext} />}
      </span>
      <span className={styles.chipText}>
        <span className={styles.chipName}>{attachment.name}</span>
        <span className={styles.chipMeta}>{meta}</span>
        {uploading ? (
          <span className={styles.progress}>
            <span className={styles.progressFill} style={{ width: `${Math.max(4, percent)}%` }} />
          </span>
        ) : null}
      </span>
      {failed ? (
        <button
          type="button"
          className={styles.chipAction}
          aria-label={t('workspacePaneAttachRetry')}
          onClick={() => void useWorkspacePane.getState().retryAttachment(attachment.id)}
        >
          <IconRefreshOutline16 />
        </button>
      ) : null}
      <button
        type="button"
        className={styles.chipRemove}
        aria-label={t('workspacePaneAttachRemove')}
        onClick={() => useWorkspacePane.getState().removeAttachment(attachment.id)}
      >
        <IconCloseFill14 />
      </button>
    </div>
  )
}

/** 有没有附件正在上传（发送按钮据此禁用：receiptId 还没到手）。 */
export const attachmentsBusy = (): boolean => hasUploadingAttachment(useWorkspacePane.getState().attachments)
