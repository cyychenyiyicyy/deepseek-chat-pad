import clsx from 'clsx'
import { useTranslate } from '../../../i18n/index.js'
import { formatSize } from '../../../services/attachments.js'
import { baseNameOf, extensionOf } from '../../../services/remote/filesApi.js'
import { IconPhotoErrorFill20 } from '../../base/icons.js'
import { CodeBlock } from '../../markdown/CodeBlock.js'
import { FileIcon } from '../../files/FileIcon.js'
/* CodeBlock 自己的样式（`.md-code-block` 的底色 / 圆角 / 换行）在 `markdown.css` 里，
 * 而它平时是由 `Markdown.tsx` 顺手 import 的。预览这里直接复用 `CodeBlock`，
 * 就必须自己把那份全局样式带上 —— 否则拿到的是浏览器默认的 `<pre>`（不换行、没底色）。 */
import '../../markdown/markdown.css'
import { useWorkspacePane, type PreviewState } from './workspacePaneStore.js'
import styles from './WorkspacePane.module.css'

/**
 * 文件预览（三种形态，见任务书）：
 *
 * | 种类 | 怎么读 | 界面 |
 * |---|---|---|
 * | 文本 | `readBytes` 前 **256 KiB**，之后「加载更多」按 256 KiB 续读（封顶 4 MiB） | 代码块（≤64 KiB 走 `CodeBlock` 复用高亮与复制；更大就纯 `<pre>`，避免高亮阻塞主线程） |
 * | 图片 | `readBytes` 按 512 KiB 分块拼（`readWorkspaceImage`），超过 8 MiB 直接拒 | `<img>` + `URL.createObjectURL`（用完 / 换图 / 卸载都 revoke） |
 * | 二进制 | **只 `stat` 拿大小，不读正文** | 占位卡片 + 「不支持预览」说明 |
 *
 * 为什么首屏是 256 KiB 而不是整份：`readBytes` 单次上限 4 MiB、transfer chunk 512 KiB
 * （input-B 附录 B），一次性把大文件读进来既会被 Host 拒，也会把 WebView 内存打满。
 */
export const FilePreview = ({ preview }: { preview: PreviewState }) => {
  if (preview.kind === 'text') return <TextPreview preview={preview} />
  if (preview.kind === 'image') return <ImagePreviewState preview={preview} />
  return <BinaryPreviewState preview={preview} />
}

/* ────────────────────────────── 文本 ────────────────────────────── */

const TextPreview = ({ preview }: { preview: Extract<PreviewState, { kind: 'text' }> }) => {
  const t = useTranslate()
  const name = baseNameOf(preview.path)
  const canLoadMore = preview.mode === 'bytes' && !preview.eof && preview.status === 'ready'
  return (
    <div className={styles.preview}>
      <div className={styles.previewBar}>
        <span className={styles.previewName} title={preview.path}>
          {name}
        </span>
        <span className={styles.previewMeta}>{readLabel(preview, t)}</span>
      </div>
      {preview.status === 'loading' ? <div className={styles.notice}>{t('workspacePaneLoading')}</div> : null}
      {preview.error === undefined ? null : <div className={styles.error}>{preview.error}</div>}
      {preview.status === 'ready' ? (
        preview.text.length === 0 ? (
          <div className={styles.notice}>{t('workspacePanePreviewEmpty')}</div>
        ) : preview.text.length <= 64_000 ? (
          // 小文件复用聊天里的代码块：语法高亮 + 复制按钮都是现成的
          <CodeBlock code={preview.text} infostring={extensionOf(name) ?? 'text'} loading={preview.loadingMore} />
        ) : (
          <pre className={styles.pre}>{preview.text}</pre>
        )
      ) : null}
      {canLoadMore ? (
        <div className={styles.previewActions}>
          <button
            type="button"
            className={styles.moreButton}
            disabled={preview.loadingMore}
            onClick={() => void useWorkspacePane.getState().loadMoreText()}
          >
            {preview.loadingMore ? t('workspacePaneLoadingMore') : t('workspacePaneLoadMore')}
          </button>
        </div>
      ) : preview.status === 'ready' && preview.mode === 'bytes' ? (
        <div className={styles.previewActions}>
          <span className={styles.previewMeta}>{t('workspacePaneEndOfFile')}</span>
        </div>
      ) : null}
    </div>
  )
}

const readLabel = (
  preview: Extract<PreviewState, { kind: 'text' }>,
  t: ReturnType<typeof useTranslate>,
): string => {
  if (preview.mode === 'lines') {
    // 老 Host 的 `read` 单页：没有字节游标，只说「前 200 行」
    return t('workspacePaneTextLines', { lines: preview.text.split('\n').length })
  }
  if (preview.totalBytes === undefined) return t('workspacePaneTextReadUnknown', { bytes: formatSize(preview.bytesRead) })
  return t('workspacePaneTextRead', {
    bytes: formatSize(preview.bytesRead),
    total: formatSize(preview.totalBytes),
  })
}

/* ────────────────────────────── 图片 ────────────────────────────── */

const ImagePreviewState = ({ preview }: { preview: Extract<PreviewState, { kind: 'image' }> }) => {
  const t = useTranslate()
  return (
    <div className={styles.preview}>
      <div className={styles.previewBar}>
        <span className={styles.previewName} title={preview.path}>
          {baseNameOf(preview.path)}
        </span>
        <span className={styles.previewMeta}>
          {[preview.mimeType, preview.bytes === undefined ? undefined : formatSize(preview.bytes)]
            .filter((part): part is string => part !== undefined)
            .join(' · ')}
        </span>
      </div>
      {preview.status === 'loading' ? <div className={styles.notice}>{t('workspacePaneLoading')}</div> : null}
      {preview.error === undefined ? null : <div className={styles.error}>{preview.error}</div>}
      {preview.status === 'ready' && preview.url !== undefined ? (
        <div className={styles.imageHost}>
          <img className={styles.image} src={preview.url} alt={baseNameOf(preview.path)} />
        </div>
      ) : null}
    </div>
  )
}

/* ────────────────────────────── 二进制 ────────────────────────────── */

const BinaryPreviewState = ({ preview }: { preview: Extract<PreviewState, { kind: 'binary' }> }) => {
  const t = useTranslate()
  const dot = preview.path.lastIndexOf('.')
  const ext = dot > 0 ? preview.path.slice(dot + 1).toUpperCase() : ''
  return (
    <div className={clsx(styles.preview, styles.previewCenter)}>
      <div className={styles.binaryIcon} aria-hidden>
        <FileIcon ext={ext} />
      </div>
      <div className={styles.previewName} title={preview.path}>
        {baseNameOf(preview.path)}
      </div>
      <div className={styles.previewMeta}>
        {preview.bytes === undefined ? t('workspacePaneKindBinary') : formatSize(preview.bytes)}
      </div>
      <div className={styles.notice}>{t('workspacePanePreviewBinary')}</div>
      <div className={styles.previewHint}>
        <IconPhotoErrorFill20 />
        <span>{t('workspacePanePreviewBinaryHint')}</span>
      </div>
    </div>
  )
}
