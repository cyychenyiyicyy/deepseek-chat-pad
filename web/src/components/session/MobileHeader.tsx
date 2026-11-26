import { IconLinkOutline16, IconNewChatOutline20 } from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import { newChat } from '../../services/chat/store.js'
import { IconButton } from '../base/IconButton.js'
import { openRemoteWorkspaceDialog } from '../remote/RemoteWorkspaceDialog.js'
import styles from './TabletHeader.module.css'

export const MobileHeader = ({ title }: { title?: string }) => {
  const t = useTranslate()
  return (
    <div className={styles.header}>
      <IconButton
        size="xl"
        tone="primary"
        icon={<IconLinkOutline16 />}
        aria-label={t('hostSwitchLabel')}
        aria-haspopup="dialog"
        onClick={() => openRemoteWorkspaceDialog('host')}
      />
      <div className={styles.title}>{title ?? t('appName')}</div>
      {title !== undefined && (
        <IconButton
          size="xl"
          tone="primary"
          icon={<IconNewChatOutline20 />}
          aria-label={t('newChat')}
          onClick={newChat}
        />
      )}
    </div>
  )
}
