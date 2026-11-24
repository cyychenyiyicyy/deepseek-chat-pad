import clsx from 'clsx'
import { memo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconEditOutline16,
  IconEllipsisOutline16,
  IconNewChatOutline20,
  IconPinOutline16,
  IconTrashOutline16,
} from '../base/icons.js'
import { renameSession, selectSession } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { IconButton } from '../base/IconButton.js'
import { Menu } from '../base/Menu.js'
import { closeMobileSider } from './mobileSiderState.js'
import styles from './SessionItem.module.css'

export const SessionItem = memo(function SessionItem({
  session,
  active,
  pinned,
  onTogglePin,
  onDelete,
}: {
  session: SessionSummary
  active: boolean
  pinned: boolean
  onTogglePin: () => void
  onDelete: () => void
}) {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  const displayTitle = session.title || t('untitledChat')

  if (editing) {
    const finish = (title: string) => {
      setEditing(false)
      if (title.trim() && title.trim() !== displayTitle) {
        renameSession(session.id, title.trim())
      }
    }
    return (
      <input
        className={styles.renameInput}
        aria-label={t('sessionItemMenuRenameOption')}
        defaultValue={displayTitle}
        autoFocus
        onFocus={(event) => event.target.select()}
        onBlur={(event) => finish(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            finish(event.currentTarget.value)
          } else if (event.key === 'Escape') {
            setEditing(false)
          }
        }}
      />
    )
  }

  return (
    <div className={clsx(styles.item, active && styles.active)}>
      <button
        type="button"
        className={styles.select}
        aria-current={active ? 'true' : undefined}
        title={displayTitle}
        onClick={() => {
          selectSession(session.id)
          closeMobileSider()
        }}
      >
        <span className={styles.itemIcon} aria-hidden="true">
          {pinned ? <IconPinOutline16 /> : <IconNewChatOutline20 />}
        </span>
        <span className={styles.title}>{displayTitle}</span>
      </button>
      <div className={styles.action}>
        <Menu
          options={[
            {
              key: 'pin',
              label: pinned ? t('sessionItemMenuUnpinOption') : t('sessionItemMenuPinOption'),
              icon: <IconPinOutline16 />,
              onSelect: onTogglePin,
            },
            {
              key: 'rename',
              label: t('sessionItemMenuRenameOption'),
              icon: <IconEditOutline16 />,
              onSelect: () => setEditing(true),
            },
            {
              key: 'delete',
              label: t('delete'),
              icon: <IconTrashOutline16 />,
              danger: true,
              onSelect: onDelete,
            },
          ]}
        >
          {({ open, toggle }) => (
            <IconButton
              icon={<IconEllipsisOutline16 />}
              aria-label={t('more')}
              aria-haspopup="menu"
              aria-expanded={open}
              onClick={toggle}
            />
          )}
        </Menu>
      </div>
    </div>
  )
})
