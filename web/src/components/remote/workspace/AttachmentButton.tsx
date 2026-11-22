import clsx from 'clsx'
import { useRef } from 'react'
import { useTranslate } from '../../../i18n/index.js'
import { IconPaperclipOutline16 } from '../../base/icons.js'
import { showToast } from '../../base/toastState.js'
import { uploadReasonText } from './uploadCopy.js'
import { useWorkspacePane } from './workspacePaneStore.js'
import styles from './AttachmentTray.module.css'

/** 长按判定的毫秒数：短于这个的按下就是普通点击 */
const LONG_PRESS_MS = 550

/** 原生桥：只有 `MainActivity` 注册了才会是对象（旧 APK 上是 undefined） */
type PickerBridge = { reset?: () => void }

/**
 * 输入框旁的「+」：选文件 → 上传（带进度）→ 凭据进附件条。
 *
 * [R17] `onFiles` 给**还没会话**的宿主用（新对话页）：文件只进它的草稿列表，
 * 不走 `workspacePaneStore` 的上传（那两条通道都是会话级的，没会话传不了）。
 * 不传 `onFiles` 时行为与原来完全一致（选中即上传）。
 *
 * ## 能力门禁（R15 改过，别再退回两态）
 *
 * `uploadSupported` 是三态的：
 *   - `null`（还没试过）→ 照常渲染 —— 没有专属 capability 能提前问，只能「先信任、失败即关」；
 *   - `true`（至少一条通道成功过）→ 照常；
 *   - `false`（**两条**都明确不可用）→ **仍然渲染**，但标成不可用：`aria-disabled` +
 *     tooltip 写原因 + 点一下弹 toast 说原因。
 *
 * 为什么不「不渲染就完事」：`fileUploads/upload` 在 Host 0.5.22 上会回 `METHOD_NOT_ALLOWED`，
 * 老代码把这一下当成「Host 不支持上传」直接把按钮收掉 —— 用户看到的就是「+ 坏了 / 不见了」，
 * 而这台 Host 其实能通过 `workspace.upload.*` 传文件。**静默消失是 bug，不是降级。**
 *
 * `<input type=file>` 必须留在同一棵子树：`useMobileViewport()` 的
 * `textarea, input:not([type="file"])` 选择器已经把文件输入排除在「跟随软键盘」之外。
 *
 * **长按 = 换文件来源**（R7）：原生把上次选的来源记在 `SharedPreferences` 里，下次直接走它；
 * 长按这里会调 `window.DSNativePicker.reset()` 清掉记忆，于是下一次点「+」重新弹来源面板。
 * 桥本身是可选的（`typeof` 守卫），没有它也只是「换不了来源」，不影响选文件。
 */
export const AttachmentButton = ({
  disabled = false,
  onFiles,
}: {
  disabled?: boolean
  /** [R17] 自管草稿的宿主（新对话页）：选中只入草稿，不上传 */
  onFiles?: (files: File[]) => void
}) => {
  const t = useTranslate()
  const supported = useWorkspacePane((state) => state.uploadSupported)
  const unavailableReason = useWorkspacePane((state) => state.uploadUnavailableReason)
  const unavailableCode = useWorkspacePane((state) => state.uploadUnavailableCode)
  const inputRef = useRef<HTMLInputElement>(null)
  const longPressTimer = useRef(0)

  const cancelLongPress = (): void => {
    if (longPressTimer.current !== 0) {
      window.clearTimeout(longPressTimer.current)
      longPressTimer.current = 0
    }
  }

  const startLongPress = (): void => {
    cancelLongPress()
    longPressTimer.current = window.setTimeout(() => {
      longPressTimer.current = 0
      const bridge = (globalThis as { DSNativePicker?: PickerBridge }).DSNativePicker
      if (typeof bridge?.reset !== 'function') return
      try {
        bridge.reset()
        showToast({ key: 'downloadPickerReset' })
      } catch {
        // 桥内部抛错不能把「+」弄坏（旧 APK / 桥还没就绪）
      }
    }, LONG_PRESS_MS)
  }

  const blocked = supported === false
  const reasonText = uploadReasonText(unavailableCode, unavailableReason)

  const onPick = (): void => {
    if (blocked) {
      // 不可用也要**说出原因**（这是「+ 坏了」这个 bug report 的正解）
      showToast({ key: 'uploadRemoteUnavailableToast', params: { reason: reasonText } })
      return
    }
    inputRef.current?.click()
  }

  return (
    <>
      <button
        type="button"
        className={clsx(styles.plus, blocked && styles.plusBlocked)}
        aria-label={blocked ? `${t('workspacePaneAttach')} — ${reasonText}` : t('workspacePaneAttach')}
        title={blocked ? reasonText : t('workspacePaneAttach')}
        aria-disabled={blocked}
        data-upload-state={blocked ? 'unavailable' : supported === true ? 'available' : 'unknown'}
        disabled={disabled}
        onPointerDown={blocked ? undefined : startLongPress}
        onPointerUp={cancelLongPress}
        onPointerLeave={cancelLongPress}
        onPointerCancel={cancelLongPress}
        onClick={onPick}
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
          if (onFiles !== undefined) {
            onFiles(files)
            return
          }
          void useWorkspacePane.getState().pickFiles(files)
        }}
      />
    </>
  )
}
