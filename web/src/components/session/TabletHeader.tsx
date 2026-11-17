import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import { IconMenuOutline20, IconNewChatOutline20, IconStopFill16 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { newChat } from '../../services/chat/store.js'
import { stopReadAloud } from '../../services/speech/readAloud.js'
import { setSiderCollapsed, useSettings } from '../../services/settings.js'
import styles from './TabletHeader.module.css'

/**
 * 平板 / 桌面顶栏：左侧菜单按钮控制侧栏开合（带动效），右侧是停止朗读与新对话。
 * 与官方平板端一致：按钮常驻，标题居中偏左。
 */
export const TabletHeader = ({ title, compact = false }: { title?: string; compact?: boolean }) => {
  const t = useTranslate()
  const collapsed = useSettings((state) => state.siderCollapsed)

  return (
    <div className={clsx(styles.header, compact && styles.compact)}>
      <IconButton
        size="xl"
        tone="primary"
        icon={<IconMenuOutline20 />}
        tooltip={collapsed ? t('expandSiderbarButton') : t('collapseSiderbarButton')}
        aria-label={collapsed ? t('expandSiderbarButton') : t('collapseSiderbarButton')}
        onClick={() => setSiderCollapsed(!collapsed)}
      />
      <div className={styles.title}>{title ?? ''}</div>
      <div className={styles.actions}>
        <IconButton
          size="m"
          tone="primary"
          icon={<IconStopFill16 />}
          tooltip={t('stopReadingAloud')}
          aria-label={t('stopReadingAloud')}
          onClick={stopReadAloud}
        />
        <IconButton
          size="m"
          tone="primary"
          icon={<IconNewChatOutline20 />}
          tooltip={t('newChat')}
          aria-label={t('newChat')}
          onClick={newChat}
        />
      </div>
    </div>
  )
}
