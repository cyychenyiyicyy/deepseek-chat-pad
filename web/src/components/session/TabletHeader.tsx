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
 *
 * 高度只有一种：`--ds-topbar-h` + 安全区（见 global.css），
 * 这样本机 / 远程两条路径、左右两栏的顶栏都在同一条水平线上。
 */
export const TabletHeader = ({ title }: { title?: string }) => {
  const t = useTranslate()
  const collapsed = useSettings((state) => state.siderCollapsed)
  const theme = useTheme()

  return (
    <div className={styles.header}>
      {collapsed ? (
        <IconButton
          size="xl"
          tone="primary"
          icon={<IconMenuOutline20 />}
          tooltip={t('expandSiderbarButton')}
          aria-expanded={false}
          aria-controls="desktop-session-sidebar"
          onClick={() => setSiderCollapsed(false)}
        />
      ) : null}
      <div className={styles.title}>{title ?? t('newChat')}</div>
      <div className={styles.actions}>
        <IconButton
          size="m"
          tone="primary"
          icon={theme === 'dark' ? <IconLightOutline16 /> : <IconDarkOutline16 />}
          tooltip={theme === 'dark' ? t('themeToLight') : t('themeToDark')}
          aria-label={theme === 'dark' ? t('themeToLight') : t('themeToDark')}
          onClick={() => setThemePreference(theme === 'dark' ? 'light' : 'dark')}
        />
        {collapsed ? (
          <IconButton
            size="m"
            tone="primary"
            icon={<IconNewChatOutline20 />}
            tooltip={t('newChat')}
            aria-label={t('newChat')}
            onClick={newChat}
          />
        ) : null}
      </div>
    </div>
  )
}
