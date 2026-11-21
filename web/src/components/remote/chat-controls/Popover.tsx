import { useCallback, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss, type Align } from '../../base/anchored.js'
import styles from './Popover.module.css'

/**
 * 顶栏胶囊用的**轻量浮层**（不使用 `base/Menu`：那个只会渲染一列 `MenuOption`）。
 *
 * 定位与关闭行为复用 `base/anchored.ts` 的 `useAnchoredPosition` / `useDismiss`
 * ——与 `Menu` / `Select` / `Tooltip` 完全同一套，翻面、视口收口、Esc、点外部关闭都一致。
 *
 * `width` 是上限；`maxHeight` 给了才会按视口剩余空间收缩并允许内部滚动。
 * 浮层 portal 到 `document.body`：会话页的顶栏是 `overflow: hidden` 的 flex 容器，留在里面会被切掉。
 */
export const Popover = ({
  trigger,
  children,
  align = 'end',
  width = 300,
  maxHeight = 420,
  label,
  onOpenChange,
}: {
  /** 渲染触发元素；`open` 用来给胶囊加高亮态 */
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode
  /** 浮层内容；`close` 用来在选中某一行后收起 */
  children: (props: { close: () => void }) => ReactNode
  align?: Align
  width?: number
  maxHeight?: number
  /** 无障碍名：浮层本身是 dialog，名字取触发元素上的文案 */
  label: string
  /** 打开/关闭时通知外部（模型胶囊要在这时补一次目录拉取） */
  onOpenChange?: (open: boolean) => void
}) => {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => {
    setOpen(false)
    onOpenChange?.(false)
  }, [onOpenChange])
  const toggle = useCallback(() => {
    setOpen((value) => {
      onOpenChange?.(!value)
      return !value
    })
  }, [onOpenChange])
  const { anchorRef, floatingRef, position } = useAnchoredPosition<HTMLSpanElement, HTMLDivElement>(
    open,
    { align, alignOffset: 0, offset: 6, maxHeight, minSpace: 140 },
  )
  useDismiss(open, [anchorRef, floatingRef], close)

  return (
    <>
      <span ref={anchorRef} className={styles.anchor}>
        {trigger({ open, toggle })}
      </span>
      {open
        ? createPortal(
            <div
              ref={floatingRef}
              className={styles.panel}
              style={{ ...position, width }}
              role="dialog"
              aria-label={label}
            >
              {children({ close })}
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
