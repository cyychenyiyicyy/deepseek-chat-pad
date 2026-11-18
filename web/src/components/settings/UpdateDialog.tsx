import { useState } from 'react'
import clsx from 'clsx'
import { Modal } from '../base/Modal.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import { useTranslate } from '../../i18n/index.js'
import {
  applyWebUpdate,
  compareVersion,
  downloadApk,
  formatSize,
  installApk,
  markUpdatePending,
  readUpdateState,
  type UpdateProgress,
} from '../../services/update.js'
import { closeUpdateDialog, useUpdateDialog } from './updateDialogState.js'
import styles from './UpdateDialog.module.css'

/**
 * 更新弹窗：启动时自动弹出，设置页「检查更新」也打开同一个。
 *
 * 关键点：网页包「装好了」不再靠内存里的一个标志位判断 ——
 * 下载完成后会重新读一次原生状态，只有 webVersion 真的等于目标版本才算成功，
 * 否则如实报错。这样「中途退出再进来」就不会出现假的「更新完成」。
 */
export const UpdateDialog = () => {
  const t = useTranslate()
  const { open, release, state, notice } = useUpdateDialog()
  const [busy, setBusy] = useState<'' | 'web' | 'apk'>('')
  const [progress, setProgress] = useState<UpdateProgress | null>(null)
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)

  if (!open) {
    return null
  }

  const appVersion = state?.appVersion ?? ''
  const webVersion = state?.webVersion ?? appVersion
  const hasWeb =
    Boolean(release?.webUrl) && Boolean(release) && compareVersion(release!.version, webVersion) > 0
  const hasApk =
    Boolean(release?.apkUrl) && Boolean(release) && compareVersion(release!.version, appVersion) > 0

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
    setFailed(false)
    setMessage('')
    setProgress(null)
    markUpdatePending(release.version)
    try {
      await applyWebUpdate(release.webUrl, setProgress)
      // 下载流程回报完成后，再核对一次原生状态，避免假成功
      const after = await readUpdateState()
      if (after?.webVersion !== release.version) {
        setFailed(true)
        setMessage(t('updateVerifyFailed', { version: release.version }))
        return
      }
      setMessage(t('updateApplied', { version: release.version }))
      window.location.reload()
    } catch (error) {
      setFailed(true)
      setMessage(t('updateFailed', { message: error instanceof Error ? error.message : String(error) }))
    } finally {
      setBusy('')
    }
  }

  const runApk = async () => {
    if (!release?.apkUrl) return
    setBusy('apk')
    setFailed(false)
    setMessage('')
    setProgress(null)
    try {
      await downloadApk(release.apkUrl, setProgress)
      const installed = await installApk()
      if (installed) {
        setMessage(t('updateApkDownloaded'))
      } else {
        setFailed(true)
        setMessage(t('updateInstallFailed'))
      }
    } catch (error) {
      setFailed(true)
      setMessage(t('updateFailed', { message: error instanceof Error ? error.message : String(error) }))
    } finally {
      setBusy('')
    }
  }

  const percent = progress?.phase === 'download' ? (progress.percent ?? 0) : null
  const phaseText =
    progress?.phase === 'unzip'
      ? t('updatePhaseUnzip')
      : progress?.phase === 'download'
        ? t('updatePhaseDownload', { percent: percent ?? 0 })
        : busy === 'web'
          ? t('updatePhaseConnecting')
          : busy === 'apk'
            ? t('updatePhaseConnecting')
            : ''

  return (
    <Modal
      title={
        release && (hasWeb || hasApk)
          ? t('updateDialogTitle', { version: release.version })
          : t('updateUpToDate')
      }
      closable
      className={styles.dialog}
      onClose={() => {
        if (busy) return
        closeUpdateDialog()
      }}
      footer={
        <div className={styles.footer}>
          {busy === '' && hasWeb ? (
            <Button variant="primary" size="m" onClick={() => void runWeb()}>
              {t('updateWebButton', { size: formatSize(release?.webSize ?? 0) })}
            </Button>
          ) : null}
          {busy === '' && hasApk ? (
            <Button variant="outlined" size="m" onClick={() => void runApk()}>
              {t('updateApkButton', { size: formatSize(release?.apkSize ?? 0) })}
            </Button>
          ) : null}
          {busy === '' && release?.apkUrl ? (
            <Button variant="outlined" size="m" onClick={() => void copyLink(release.apkUrl)}>
              {t('updateCopyLink')}
            </Button>
          ) : null}
          <Button variant="outlined" size="m" disabled={Boolean(busy)} onClick={closeUpdateDialog}>
            {t('updateLater')}
          </Button>
        </div>
      }
    >
      <div className={styles.body}>
        {notice ? <div className={styles.notice}>{notice}</div> : null}

        <div className={styles.versions}>
          <span>{t('updateCurrentVersions', { app: appVersion, web: webVersion })}</span>
          {release ? <span className={styles.latest}>{t('updateLatest', { version: release.version })}</span> : null}
        </div>

        {release?.notes ? (
          <div className={styles.section}>
            <div className={styles.sectionTitle}>{t('updateNotesLabel')}</div>
            <div className={styles.notes}>{release.notes}</div>
          </div>
        ) : null}

        {busy !== '' || message ? (
          <div className={styles.section}>
            {busy !== '' ? (
              <>
                <div className={styles.progressHead}>
                  <span>{phaseText}</span>
                  {percent !== null ? <span className={styles.percent}>{percent}%</span> : null}
                </div>
                <div className={styles.progress}>
                  <div
                    className={clsx(styles.progressFill, percent === null && styles.progressIndeterminate)}
                    style={percent === null ? undefined : { width: `${percent}%` }}
                  />
                </div>
              </>
            ) : null}
            {message ? <div className={clsx(styles.message, failed && styles.error)}>{message}</div> : null}
          </div>
        ) : null}
      </div>
    </Modal>
  )
}
