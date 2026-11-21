import clsx from 'clsx'
import { useTranslate } from '../../../i18n/index.js'
import { formatSize, getExtension } from '../../../services/attachments.js'
import { IconCloseFill14, IconRefreshOutline16 } from '../../base/icons.js'
import { FileIcon } from '../../files/FileIcon.js'
import { hasUploadingAttachment, useWorkspacePane, type DraftAttachment } from './workspacePaneStore.js'
import styles from './AttachmentTray.module.css'

/**
 * 输入框上方的附件条（会话附件上传，W3）。
 *
 * 一条 = 一个 `fileUploads/upload` 的结果：`uploading`（进度条）/ `done`（等发送）/
 * `error`（可重试 + 可读原因）。发送时由 `RemoteChatView` 把 `receiptId` 编成
 * `{type:'file', receiptId}`（`RemotePromptAttachment` 本来的形状）。
 *
 * 失败原因两条来源：
 *  - 本地（读不到文件 / 超过 30 MiB 单帧上限）；
 *  - Host（`UPLOAD_*` / `METHOD_NOT_FOUND`…）——`workspacePaneStore` 已经翻成人话。
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
  return (
    <div className={clsx(styles.chip, failed && styles.chipFailed)} title={attachment.error ?? attachment.name}>
      <span className={styles.chipIcon} aria-hidden>
        {/* 上传中转圈、其余显示文件类型（失败态靠红色描边 + 右侧重试按钮表达，避免一行两个刷新图标） */}
        {uploading ? <span className={styles.spinner} /> : <FileIcon ext={ext} />}
      </span>
      <span className={styles.chipText}>
        <span className={styles.chipName}>{attachment.name}</span>
        <span className={styles.chipMeta}>
          {failed
            ? attachment.error ?? t('workspacePaneAttachFailed')
            : uploading
              ? `${t('workspacePaneAttachUploading')} ${percent}%`
              : formatSize(attachment.size)}
        </span>
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
