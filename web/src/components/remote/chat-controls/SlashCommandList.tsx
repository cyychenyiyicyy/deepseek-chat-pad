import { useEffect, useRef } from 'react'
import { useTranslate } from '../../../i18n/index.js'
import type { RemoteSlashCommand } from '../../../services/remote/sessionControls.js'
import styles from './SlashCommandList.module.css'

/**
 * 输入区上方的**斜杠命令补全**列表。
 *
 * 纯展示：过滤、选中下标、回车执行都由输入区（`RemoteChatView`）管 —— 键盘焦点在
 * `<textarea>` 上，列表只是它的延伸（`role="listbox"` + `aria-activedescendant`）。
 *
 * 为什么不做成浮层：移动端软键盘会把它顶走；贴在输入框上方属于「同一块区域」，
 * 高度由内容决定（最多 5 行，超出滚动）。
 */
export const SlashCommandList = ({
  commands,
  activeIndex,
  onPick,
  onHover,
  listId,
}: {
  commands: readonly RemoteSlashCommand[]
  activeIndex: number
  onPick: (command: RemoteSlashCommand) => void
  /** 鼠标移到某一行时同步高亮（键盘与指针不要各高亮一行） */
  onHover: (index: number) => void
  /** `aria-controls` / `aria-activedescendant` 用的 id 前缀 */
  listId: string
}) => {
  const t = useTranslate()
  const activeRef = useRef<HTMLButtonElement | null>(null)

  // 键盘上下移动时把选中行滚进可视区（列表自身是滚动容器，`scrollIntoView` 会连带滚页面，必须用块级滚动）
  useEffect(() => {
    const el = activeRef.current
    const container = el?.parentElement
    if (!el || !container) return
    const top = el.offsetTop
    const bottom = top + el.offsetHeight
    if (top < container.scrollTop) container.scrollTop = top
    else if (bottom > container.scrollTop + container.clientHeight) {
      container.scrollTop = bottom - container.clientHeight
    }
  }, [activeIndex])

  if (commands.length === 0) {
    return (
      <div className={styles.empty} role="status">
        {t('chatControlsSlashEmpty')}
      </div>
    )
  }

  return (
    <div className={styles.list} role="listbox" id={listId} aria-label={t('chatControlsCommandsTitle')}>
      {commands.map((command, index) => {
        const active = index === activeIndex
        return (
          <button
            key={command.name}
            ref={active ? activeRef : null}
            type="button"
            role="option"
            id={`${listId}-${index}`}
            aria-selected={active}
            className={active ? `${styles.row} ${styles.rowActive}` : styles.row}
            // 用 pointerdown 而不是 click：click 之前 textarea 会先失焦，光标位置就丢了
            onPointerDown={(event) => {
              event.preventDefault()
              onPick(command)
            }}
            onMouseEnter={() => onHover(index)}
          >
            <span className={styles.name}>
              /{command.name}
              {command.hint === undefined ? null : <span className={styles.hint}>{command.hint}</span>}
            </span>
            {command.description === undefined ? null : (
              <span className={styles.description}>{command.description}</span>
            )}
          </button>
        )
      })}
      <div className={styles.footer}>{t('chatControlsSlashHint')}</div>
    </div>
  )
}
