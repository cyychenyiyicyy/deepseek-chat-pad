import { useRef } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { getDraft, setDraftText, useDrafts } from '../../services/chat/drafts.js'
import { useModelState } from '../../services/models/store.js'
import { useSettings } from '../../services/settings.js'
import {
  IconDataOutline16,
  IconEditOutline16,
  IconRightUpOutline14,
  IconThinkOutline16,
} from '../base/icons.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { BalanceChip } from '../models/BalanceChip.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { MobileHeader } from './MobileHeader.js'
import { TabletHeader } from './TabletHeader.js'
import styles from './Welcome.module.css'

const starters = [
  { label: 'welcomeDraft', prompt: 'welcomeDraftPrompt', Icon: IconEditOutline16 },
  { label: 'welcomeExplain', prompt: 'welcomeExplainPrompt', Icon: IconThinkOutline16 },
  { label: 'welcomePlan', prompt: 'welcomePlanPrompt', Icon: IconDataOutline16 },
] as const

export const Welcome = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const hasText = useDrafts((state) => Boolean(state.drafts.get(null)?.text.trim()))
  const hasDeepSeekKey = useSettings((state) => Boolean(state.apiKey))
  const hasCustomKey = useModelState((state) => state.providers.some((provider) => Boolean(provider.apiKey)))
  return (
    <div className={styles.container}>
      {isMobile ? <MobileHeader /> : <TabletHeader />}
      <div className={styles.viewport}>
        <div className={styles.welcome}>
          <div className={styles.intro}>
            <h1 className={styles.greeting}>{t('welcomeMessageChat250808')}</h1>
            <p className={styles.description}>{t('welcomeDescription')}</p>
            <BalanceChip />
            {!hasDeepSeekKey && !hasCustomKey ? (
              <button type="button" className={styles.setup} onClick={() => openSettings('models')}>
                {t('welcomeConfigureModel')}
                <span className={styles.arrow} aria-hidden="true"><IconRightUpOutline14 /></span>
              </button>
            ) : null}
          </div>
          <ChatInput sessionId={null} inputRef={inputRef} />
          <div className={styles.starters}>
            {starters.map(({ label, prompt, Icon }) => (
              <button
                key={label}
                type="button"
                className={styles.starter}
                disabled={hasText}
                onClick={() => {
                  if (!getDraft(null).text.trim()) setDraftText(null, t(prompt))
                  inputRef.current?.focus()
                }}
              >
                <span className={styles.starterIcon} aria-hidden="true"><Icon /></span>
                <span>{t(label)}</span>
                <span className={styles.arrow} aria-hidden="true"><IconRightUpOutline14 /></span>
              </button>
            ))}
          </div>
          <div className={styles.caveat}>{t('contentCaveat')}</div>
        </div>
      </div>
    </div>
  )
}
