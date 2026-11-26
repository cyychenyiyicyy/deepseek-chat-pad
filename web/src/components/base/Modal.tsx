import clsx from 'clsx'
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { IconCloseOutline16 } from './icons.js'
import { IconButton } from './IconButton.js'
import styles from './Modal.module.css'

/** 当前打开的弹窗，后打开的在末尾；叠放时 Esc 只关闭最上层 */
const openModals: HTMLElement[] = []
const tabbableSelector = 'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"], summary'

/** 遮罩 + 居中卡片，Esc / 点遮罩关闭 */
export const Modal = ({
  title,
  children,
  footer,
  closable = footer == null,
  expanded = false,
  className,
  mainClassName,
  onClose,
}: {
  title: ReactNode
  children?: ReactNode
  footer?: ReactNode
  /** 标题栏右侧显示关闭按钮 */
  closable?: boolean
  /** Multi-step tasks get a full-screen dialog on handheld windows. */
  expanded?: boolean
  className?: string
  /** 内容区的 class */
  mainClassName?: string
  onClose: () => void
}) => {
  const t = useTranslate()
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const [trigger] = useState(() => document.activeElement)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const root = document.getElementById('root')
    openModals.push(dialog)
    const previous = openModals.at(-2)
    previous?.toggleAttribute('inert', true)
    root?.setAttribute('inert', '')
    if (!dialog.contains(document.activeElement)) dialog.focus({ preventScroll: true })

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || openModals.at(-1) !== dialog) return
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
      }
      if (event.key !== 'Tab') return
      const elements = Array.from(dialog.querySelectorAll<HTMLElement>(tabbableSelector)).filter(
        (element) => element.tabIndex >= 0 && !element.matches(':disabled') &&
          !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
          element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible'
      )
      const current = document.activeElement
      const index = elements.findIndex((element) => element === current)
      if (index < 0 || (event.shiftKey ? index === 0 : index === elements.length - 1)) {
        event.preventDefault()
        const next = (event.shiftKey ? elements.at(-1) : elements[0]) ?? dialog
        next.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      const wasTop = openModals.at(-1) === dialog
      openModals.splice(openModals.indexOf(dialog), 1)
      document.removeEventListener('keydown', onKeyDown)
      const nextDialog = openModals.at(-1)
      if (!nextDialog) root?.removeAttribute('inert')
      if (!wasTop) return
      nextDialog?.removeAttribute('inert')
      queueMicrotask(() => {
        if (openModals.at(-1) !== nextDialog) return
        if (trigger instanceof HTMLElement && trigger.isConnected && (!nextDialog || nextDialog.contains(trigger))) {
          trigger.focus({ preventScroll: true })
        } else {
          nextDialog?.focus({ preventScroll: true })
        }
      })
    }
  }, [trigger])

  return createPortal(
    <div
      className={styles.overlay}
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        className={clsx(styles.content, className)}
        data-expanded={expanded || undefined}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className={styles.header}>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          {closable ? (
            <IconButton
              className={styles.close}
              size="xl"
              tone="primary"
              icon={<IconCloseOutline16 />}
              aria-label={t('close')}
              onClick={onClose}
            />
          ) : null}
        </div>
        {children ? <div className={clsx(styles.main, mainClassName)}>{children}</div> : null}
        {footer ? <div className={styles.footer}>{footer}</div> : null}
      </div>
    </div>,
    document.body
  )
}
