import { useEffect, useState } from 'react'
import { Button } from '../base/Button.js'
import { useTranslate } from '../../i18n/index.js'
import {
  fetchLatestRelease,
  isUpdateSupported,
  readUpdateState,
  type UpdateState,
} from '../../services/update.js'
import { openUpdateDialog } from './updateDialogState.js'
import styles from './Settings.module.css'

/**
 * 设置页的更新入口：只负责显示当前版本并提供「检查更新」。
 * 具体内容（更新日志、下载、进度）都在同一个更新弹窗里 ——
 * 这里放不下整份说明，塞在设置行里会挤成一团。
 */
export const UpdatePanel = () => {
  const t = useTranslate()
  const [supported, setSupported] = useState<boolean | null>(null)
  const [state, setState] = useState<UpdateState | null>(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const ok = await isUpdateSupported()
      if (cancelled) return
      setSupported(ok)
      if (!ok) return
      const current = await readUpdateState()
      if (!cancelled) setState(current)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (supported === false) {
    return null
  }

  const check = async () => {
    setChecking(true)
    try {
      const [current, latest] = await Promise.all([readUpdateState(), fetchLatestRelease()])
      setState(current)
      openUpdateDialog({ release: latest, state: current, notice: null })
    } finally {
      setChecking(false)
    }
  }

  const versions = state
    ? t('updateCurrentVersions', {
        app: state.appVersion || '-',
        web: state.webVersion ?? state.appVersion ?? '-',
      })
    : ''

  return (
    <div className={styles.cell + ' ' + styles.row}>
      <div className={styles.text}>
        <div className={styles.label}>{t('updateTitle')}</div>
        <div className={styles.description}>
          {t('updateRowDescription')}
          {versions ? <span className={styles.updateVersions}>{versions}</span> : null}
        </div>
      </div>
      <div className={styles.updateActions}>
        <Button variant="outlined" size="m" disabled={checking} onClick={() => void check()}>
          {checking ? t('updateChecking') : t('updateCheckButton')}
        </Button>
      </div>
    </div>
  )
}
