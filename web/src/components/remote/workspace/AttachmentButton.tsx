import { useRef } from 'react'
import { useTranslate } from '../../../i18n/index.js'
import { IconPaperclipOutline16 } from '../../base/icons.js'
import { useWorkspacePane } from './workspacePaneStore.js'
import styles from './AttachmentTray.module.css'

/**
 * 输入框旁的「+」：选文件 → `fileUploads/upload`（带进度）→ 收据进附件条。
 *
 * 门禁：`uploadSupported === false`（Host 回过 `METHOD_NOT_FOUND`）时**整个按钮不渲染**；
 * `null`（还没试过）时先画出来 —— 与 `newSessionStore` 的「先信任、失败即关」同一条约定，
 * 否则第一次点之前没有任何办法知道 Host 有没有这个端点（它没有专属 capability）。
 *
 * `<input type=file>` 必须留在同一棵子树：`useMobileViewport()` 的
 * `textarea, input:not([type="file"])` 选择器已经把文件输入排除在「跟随软键盘」之外。
 */
export const AttachmentButton = ({ disabled = false }: { disabled?: boolean }) => {
  const t = useTranslate()
  const supported = useWorkspacePane((state) => state.uploadSupported)
  const inputRef = useRef<HTMLInputElement>(null)
  if (supported === false) return null
  return (
    <>
      <button
        type="button"
        className={styles.plus}
        aria-label={t('workspacePaneAttach')}
        title={t('workspacePaneAttach')}
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        <IconPaperclipOutline16 />
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        aria-hidden
        tabIndex={-1}
        onChange={(event) => {
          const files = [...(event.target.files ?? [])]
          // 清空 value：同一个文件改了内容再选一次也要能触发 change
          event.target.value = ''
          if (files.length === 0) return
          void useWorkspacePane.getState().pickFiles(files)
        }}
      />
    </>
  )
}
