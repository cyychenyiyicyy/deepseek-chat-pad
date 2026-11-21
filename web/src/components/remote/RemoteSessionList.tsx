import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import { useRemoteStore } from '../../services/remote/store.js'
import { IconPinOutline16, IconRefreshOutline16 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { formatDate } from '../../utils/format.js'
import styles from './RemoteSessionList.module.css'

/**
 * 远程会话列表：标题 + 相对时间 + 当前高亮。
 *
 * 只做「读 store + 调 openSession」一件事，所以既能当平板布局里的左栏，
 * 也能被会话页在移动端塞进抽屉（`className` 用来覆盖宽度/边框）。
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** 数据层方法可能同步抛、也可能返回 rejected 的 promise；两者都只反映到 store 的 error */
const fireAndForget = (action: () => unknown) => {
  try {
    void Promise.resolve(action()).catch(() => undefined)
  } catch {
    // 同步抛错已由数据层写入状态，这里吞掉即可
  }
}

/** `updatedAt` 可能是秒级时间戳、毫秒时间戳或 ISO 字符串，统一成毫秒 */
const toMillis = (value: number | string | undefined): number | undefined => {
  if (value === undefined) return undefined
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  if (!Number.isFinite(value)) return undefined
  return value < 1e12 ? value * 1000 : value
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前 / 日期 */
const relativeTime = (
  t: ReturnType<typeof useTranslate>,
  updatedAt: number | string | undefined
): string => {
  const time = toMillis(updatedAt)
  if (time === undefined) return ''
  const diff = Date.now() - time
  if (diff < 0) return t('remoteTimeJustNow')
  if (diff < MINUTE) return t('remoteTimeJustNow')
  if (diff < HOUR) return t('remoteTimeMinutes', { count: Math.floor(diff / MINUTE) })
  if (diff < DAY) return t('remoteTimeHours', { count: Math.floor(diff / HOUR) })
  const days = Math.floor(diff / DAY)
  if (days === 1) return t('remoteTimeYesterday')
  if (days < 7) return t('remoteTimeDays', { count: days })
  return formatDate(time) ?? ''
}

export const RemoteSessionList = ({
  className,
  onSelect,
}: {
  className?: string
  /** 移动端抽屉选中会话后自动收起 */
  onSelect?: (id: string) => void
}) => {
  const t = useTranslate()
  const sessions = useRemoteStore((state) => state.sessions)
  const activeSessionId = useRemoteStore((state) => state.activeSessionId)
  const phase = useRemoteStore((state) => state.phase)

  return (
    <div className={clsx(styles.panel, className)}>
      <div className={styles.header}>
        <span className={styles.headerTitle}>{t('remoteSessionListTitle')}</span>
        <IconButton
          size="xs"
          icon={<IconRefreshOutline16 />}
          tooltip={t('remoteRefreshSessions')}
          disabled={phase !== 'ready'}
          onClick={() => fireAndForget(() => useRemoteStore.getState().refreshSessions())}
        />
      </div>

      <div className={styles.list}>
        {sessions.length === 0 ? (
          <div className={styles.empty}>
            {t(phase === 'ready' ? 'remoteSessionEmpty' : 'remotePhaseIdle')}
          </div>
        ) : (
          sessions.map((session) => {
            const active = session.id === activeSessionId
            const time = relativeTime(t, session.updatedAt)
            return (
              <button
                key={session.id}
                type="button"
                aria-current={active ? 'true' : undefined}
                className={clsx(styles.item, active && styles.itemActive)}
                onClick={() => {
                  fireAndForget(() => useRemoteStore.getState().openSession(session.id))
                  onSelect?.(session.id)
                }}
              >
                <span className={styles.itemMain}>
                  <span className={styles.itemTitle}>
                    {session.pinned ? (
                      <span className={styles.pinMark} aria-hidden>
                        <IconPinOutline16 />
                      </span>
                    ) : null}
                    {session.title || t('remoteSessionUntitled')}
                  </span>
                  {time ? <span className={styles.itemTime}>{time}</span> : null}
                </span>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}
