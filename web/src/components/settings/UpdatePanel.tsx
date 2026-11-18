import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Button } from '../base/Button.js'
import { IconDownloadOutline16, IconRefreshOutline16 } from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import { useTranslate } from '../../i18n/index.js'
import {
  applyWebUpdate,
  compareVersion,
  downloadApk,
  fetchLatestRelease,
  formatSize,
  installApk,
  isUpdateSupported,
  readUpdateState,
  type ReleaseInfo,
  type UpdateProgress,
  type UpdateState,
} from '../../services/update.js'
import styles from './Settings.module.css'

/**
 * 检查更新：网页包与 APK 分开处理。
 * 网页包下载后立即生效（刷新页面），APK 下载完再拉起系统安装器。
 * 浏览器里没有原生接口，这一整块会隐藏。
 */
export const UpdatePanel = () => {
  const t = useTranslate()
  const [supported, setSupported] = useState<boolean | null>(null)
  const [state, setState] = useState<UpdateState | null>(null)
  const [release, setRelease] = useState<ReleaseInfo | null>(null)
  const [busy, setBusy] = useState<'' | 'web' | 'apk'>('')
  const [progress, setProgress] = useState<UpdateProgress | null>(null)
  const [message, setMessage] = useState('')

  const load = async () => {
    const ok = await isUpdateSupported()
    setSupported(ok)
    if (!ok) return
    const [current, latest] = await Promise.all([readUpdateState(), fetchLatestRelease()])
    setState(current)
    setRelease(latest)
    if (!latest) setMessage(t('updateNoRelease'))
  }

  useEffect(() => {
    void load()
    // 只在挂载时检查一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (supported === false) {
    return null
  }

  const appVersion = state?.appVersion ?? ''
  const webVersion = state?.webVersion ?? appVersion
  const hasWeb = Boolean(release?.webUrl) && Boolean(release) && compareVersion(release!.version, webVersion) > 0
  const hasApk = Boolean(release?.apkUrl) && Boolean(release) && compareVersion(release!.version, appVersion) > 0

  const copyLink = async (url: string | null) => {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      showToast({ key: 'updateLinkCopied' })
    } catch {
      showToast({ key: 'updateLinkCopyFailed', type: 'error' })
    }
  }

  const runWeb = async () => {
    if (!release?.webUrl) return
    setBusy('web')
    setMessage('')
    setProgress(null)
    try {
      await applyWebUpdate(release.webUrl, setProgress)
      setMessage(t('updateWebDone'))
      // 网页包已经切换，重载即可用上新版
      setTimeout(() => window.location.reload(), 600)
    } catch (error) {
      setMessage(t('updateFailed', { message: error instanceof Error ? error.message : String(error) }))
    } finally {
      setBusy('')
    }
  }

  const runApk = async () => {
    if (!release?.apkUrl) return
    setBusy('apk')
    setMessage('')
    setProgress(null)
    try {
      await downloadApk(release.apkUrl, setProgress)
      setMessage(t('updateApkDownloaded'))
      const installed = await installApk()
      if (!installed) {
        setMessage(t('updateInstallFailed'))
      }
    } catch (error) {
      setMessage(t('updateFailed', { message: error instanceof Error ? error.message : String(error) }))
    } finally {
      setBusy('')
    }
  }

  const percent = progress?.phase === 'download' ? (progress.percent ?? 0) : null
  const description =
    message ||
    (hasWeb || hasApk
      ? t('updateAvailableDesc', { version: release?.version ?? '' })
      : t('updateUpToDate'))

  return (
    <div className={clsx(styles.cell, styles.row)}>
      <div className={styles.text}>
        <div className={styles.label}>{t('updateTitle')}</div>
        <div className={styles.description}>
          {description}
          {state ? (
            <span className={styles.updateVersions}>
              {t('updateCurrentVersions', {
                app: appVersion || '-',
                web: webVersion || '-',
              })}
            </span>
          ) : null}
        </div>
        {percent !== null ? (
          <div className={styles.updateProgress} aria-hidden>
            <div className={styles.updateProgressFill} style={{ width: `${percent}%` }} />
          </div>
        ) : null}
      </div>
      <div className={styles.updateActions}>
        {busy === '' && (hasWeb || hasApk) ? (
          <>
            {hasWeb ? (
              <Button variant="primary" size="m" onClick={() => void runWeb()}>
                <IconRefreshOutline16 />
                {t('updateWebButton', { size: formatSize(release?.webSize ?? 0) })}
              </Button>
            ) : null}
            {hasApk ? (
              <Button variant="outlined" size="m" onClick={() => void runApk()}>
                <IconDownloadOutline16 />
                {t('updateApkButton', { size: formatSize(release?.apkSize ?? 0) })}
              </Button>
            ) : null}
            {release?.apkUrl ? (
              <Button variant="outlined" size="m" onClick={() => void copyLink(release.apkUrl)}>
                {t('updateCopyLink')}
              </Button>
            ) : null}
          </>
        ) : null}
        {busy !== '' ? <span className={styles.updateBusy}>{t('updateBusy')}</span> : null}
        {busy === '' && !hasWeb && !hasApk ? (
          <Button variant="outlined" size="m" onClick={() => void load()}>
            {t('updateCheckButton')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
