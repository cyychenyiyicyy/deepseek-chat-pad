import clsx from 'clsx'
import { useLayoutEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss } from './anchored.js'
import styles from './Menu.module.css'

export type MenuOption = {
  key: string
  label: string
  icon: ReactNode
  danger?: boolean
  onSelect: () => void
}

/** 点击触发，向下展开；点外部或 Esc 关闭 */
export const Menu = ({
  options,
  children,
}: {
  options: MenuOption[]
  children: (props: { open: boolean; toggle: () => void }) => ReactNode
}) => {
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)
  // 左侧对齐并再左移 5px，让菜单文字与触发元素图标对齐
  const { anchorRef, floatingRef, position } = useAnchoredPosition<HTMLSpanElement, HTMLDivElement>(
    open,
    { align: 'start', alignOffset: -5, offset: 4 }
  )
  useDismiss(open, [anchorRef, floatingRef], close)
  useLayoutEffect(() => {
    if (open) floatingRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [floatingRef, open])

  const closeWithFocus = () => {
    close()
    anchorRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }

  return (
    <>
      <span ref={anchorRef} className={styles.anchor}>
        {children({ open, toggle: () => setOpen((value) => !value) })}
      </span>
      {open
        ? createPortal(
            <div
              ref={floatingRef}
              className={styles.menu}
              style={position ?? undefined}
              role="menu"
              onKeyDown={(event) => {
                if (event.key === 'Escape' || event.key === 'Tab') {
                  closeWithFocus()
                  if (event.key === 'Escape') {
                    event.stopPropagation()
                    event.preventDefault()
                  }
                  return
                }
                const items = Array.from(event.currentTarget.querySelectorAll('button'))
                const current = items.findIndex((item) => item === document.activeElement)
                let next: number
                switch (event.key) {
                  case 'ArrowDown': next = (current + 1) % items.length; break
                  case 'ArrowUp': next = (current + items.length - 1) % items.length; break
                  case 'Home': next = 0; break
                  case 'End': next = items.length - 1; break
                  default: return
                }
                event.preventDefault()
                items[next]?.focus()
              }}
            >
              {options.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={clsx(styles.option, option.danger && styles.danger)}
                  onClick={() => {
                    closeWithFocus()
                    option.onSelect()
                  }}
                >
                  <span className={styles.icon}>{option.icon}</span>
                  {option.label}
                </button>
              ))}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
