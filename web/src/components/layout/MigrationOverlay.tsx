import { useEffect } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { migrationDismiss, useMigration } from '../../services/chat/migrationState.js'
import styles from './MigrationOverlay.module.css'

/**
 * 迁移进度层。
 *
 * 老用户首次启动会把会话从 IndexedDB 搬到原生 SQLite，期间会话列表要等它跑完。
 * 以前这段是静默的，看起来就像应用卡死；现在显式显示阶段与进度。
 * 失败时说明「已继续使用原存储、数据安全」，不让用户以为数据丢了。
 */
export const MigrationOverlay = () => {
  const t = useTranslate()
  const { phase, done, total, visible } = useMigration()

  // 成功提示自动消失；失败必须用户手动确认
  useEffect(() => {
    if (phase !== 'done') {
      return
    }
    const timer = setTimeout(migrationDismiss, 1400)
    return () => clearTimeout(timer)
  }, [phase])

  if (!visible || phase === 'idle') {
    return null
  }

  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null
  const label =
    phase === 'prepare'
      ? t('migrationPrepare')
      : phase === 'sessions'
        ? t('migrationSessions', { done, total })
        : phase === 'files'
          ? t('migrationFiles', { done, total })
          : phase === 'verify'
            ? t('migrationVerify')
            : phase === 'done'
              ? t('migrationDone')
              : t('migrationFailed')

  return (
    <div className={styles.backdrop} role="alertdialog" aria-busy={phase !== 'done' && phase !== 'failed'}>
      <div className={styles.card}>
        {phase === 'failed' ? (
          <>
            <div className={styles.title}>{t('migrationFailedTitle')}</div>
            <div className={styles.detail}>{t('migrationFailedDetail')}</div>
            <button type="button" className={styles.button} onClick={migrationDismiss}>
              {t('migrationGotIt')}
            </button>
          </>
        ) : (
          <>
            <div className={styles.spinner} aria-hidden="true" />
            <div className={styles.title}>{label}</div>
            <div className={styles.bar}>
              <div
                className={styles.fill}
                style={{ width: percent === null ? '35%' : `${percent}%` }}
                data-indeterminate={percent === null ? 'true' : 'false'}
              />
            </div>
            <div className={styles.hint}>{t('migrationHint')}</div>
          </>
        )}
      </div>
    </div>
  )
}
