import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import {
  IconDarkOutline16,
  IconLightOutline16,
  IconMenuOutline20,
  IconNewChatOutline20,
} from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { newChat } from '../../services/chat/store.js'
import { setSiderCollapsed, setThemePreference, useSettings } from '../../services/settings.js'
import { useTheme } from '../../app/theme.js'
import styles from './TabletHeader.module.css'

/**
 * 平板 / 桌面顶栏：左侧菜单按钮控制侧栏开合（带动效），
 * 右侧是深浅色切换与新对话。
 */
export const TabletHeader = ({ title, compact = false }: { title?: string; compact?: boolean }) => {
  const t = useTranslate()
  const collapsed = useSettings((state) => state.siderCollapsed)
  const theme = useTheme()

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
          icon={theme === 'dark' ? <IconLightOutline16 /> : <IconDarkOutline16 />}
          tooltip={theme === 'dark' ? t('themeToLight') : t('themeToDark')}
          aria-label={theme === 'dark' ? t('themeToLight') : t('themeToDark')}
          onClick={() => setThemePreference(theme === 'dark' ? 'light' : 'dark')}
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
