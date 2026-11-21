import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { BalanceChip } from '../models/BalanceChip.js'
import { MobileHeader } from './MobileHeader.js'
import { TabletHeader } from './TabletHeader.js'
import styles from './Welcome.module.css'

/** 新对话：顶栏 + 问候语 + DeepSeek 余额 + 输入框 */
export const Welcome = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  return (
    <div className={styles.container}>
      {isMobile ? <MobileHeader /> : <TabletHeader />}
      <div className={styles.welcome}>
        <div className={styles.greeting}>{t('welcomeMessageChat250808')}</div>
        <div className={styles.balance}>
          <BalanceChip />
        </div>
        <ChatInput sessionId={null} />
        {isMobile ? <div className={styles.caveat}>{t('contentCaveat')}</div> : null}
      </div>
    </div>
  )
}
