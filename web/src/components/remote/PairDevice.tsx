import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  claimPairing, inspectPairingScan, pairingFingerprint, parsePairingScan, type PairingOffer, type PairingScan,
} from '../../services/remote/devicePairing.js'
import { loadOrCreateIdentity } from '../../services/remote/identity.js'
import { isRemoteApiError } from '../../services/remote/serverApi.js'
import { connectPairedDevice } from '../../services/remote/store.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import styles from './RemoteManagementDialog.module.css'

type BarcodeReader = new (options: { formats: string[] }) => {
  detect(source: ImageBitmap): Promise<Array<{ rawValue: string }>>
}

export default function PairDevice({ onClose }: { onClose: () => void }) {
  const t = useTranslate()
  const [input, setInput] = useState('')
  const [scan, setScan] = useState<PairingScan | null>(null)
  const [offer, setOffer] = useState<PairingOffer | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const life = useRef<{
    open: boolean; busy: boolean; close: (() => Promise<void>) | null; timer: ReturnType<typeof setTimeout> | null
  }>({ open: true, busy: false, close: null, timer: null })
  const detector = (globalThis as { BarcodeDetector?: BarcodeReader }).BarcodeDetector

  useEffect(() => {
    const status = life.current
    status.open = true
    return () => {
      status.open = false
      if (status.timer !== null) clearTimeout(status.timer)
      if (status.close) void status.close().catch(() => undefined)
    }
  }, [])

  const displayError = (failure: unknown, fallback = t('remotePairingFailed')) =>
    isRemoteApiError(failure) ? `${fallback} (${failure.code})` : fallback

  function parse(value: string) {
    try {
      const result = parsePairingScan(value)
      setInput('')
      setError('')
      setScan(result)
    } catch (failure) {
      setError(displayError(failure, t('remotePairingInvalidCode')))
    }
  }

  async function run(job: () => Promise<void>) {
    const status = life.current
    if (status.busy) return
    status.busy = true
    setBusy(true)
    setError('')
    try {
      await job()
    } catch (failure) {
      if (status.open) setError(displayError(failure))
    } finally {
      status.busy = false
      if (status.open) setBusy(false)
    }
  }

  async function readImage(file: File) {
    if (!detector) return
    await run(async () => {
      const bitmap = await createImageBitmap(file)
      try {
        const candidates = await new detector({ formats: ['qr_code'] }).detect(bitmap)
        if (life.current.open) parse(candidates[0]?.rawValue ?? '')
      } finally {
        bitmap.close()
      }
    })
  }

  async function waitForHost(selected: PairingOffer) {
    const status = life.current
    const pairing = await claimPairing(selected, loadOrCreateIdentity())
    if (!status.open) {
      await pairing.cancel()
      return
    }
    status.close = pairing.cancel
    setCode(pairing.code)
    let deadline = pairing.deadline
    let delay = 2_500
    async function poll() {
      if (!status.open) return
      try {
        if (Date.now() > deadline) throw new Error('Pairing expired')
        if (document.visibilityState === 'visible') {
          const result = await pairing.status()
          if (!status.open) return
          if (result.state === 'complete') {
            status.close = null
            await connectPairedDevice(selected, result.account)
            if (status.open) onClose()
            return
          }
          deadline = result.deadline
          delay = 2_500
        }
      } catch (failure) {
        if (!status.open) return
        if (isRemoteApiError(failure) && (failure.retryable || failure.status === 429) && Date.now() <= deadline) {
          delay = Math.min(10_000, delay * 2)
        } else {
          setCode('')
          setError(displayError(failure))
          return
        }
      }
      if (status.open) status.timer = setTimeout(() => void poll(), delay)
    }
    status.timer = setTimeout(() => void poll(), delay)
  }

  return (
    <Modal title={t('remotePairDevice')} onClose={onClose} closable className={styles.modal} mainClassName={styles.body}>
      <div className={styles.layout} aria-busy={busy}>
        {scan === null ? (
          <form className={styles.layout} onSubmit={(event) => { event.preventDefault(); parse(input) }}>
            <p>{t('remotePairingCodeHelp')}</p>
            <label className={styles.field}>
              {t('remotePairingCodeInput')}
              <textarea maxLength={4096} autoComplete="off" spellCheck={false} value={input} disabled={busy}
                onChange={(event) => setInput(event.target.value)} />
            </label>
            {detector && (
              <label className={styles.field}>
                {t('remotePairingCapture')}
                <input type="file" accept="image/*" capture="environment" disabled={busy} onChange={(event) => {
                  const file = event.currentTarget.files?.[0]
                  event.currentTarget.value = ''
                  if (file) void readImage(file)
                }} />
              </label>
            )}
            <div className={styles.actions}>
              <Button variant="primary" size="m" type="submit" disabled={busy || input.trim() === ''}>{t('remotePairingContinue')}</Button>
            </div>
          </form>
        ) : (
          <section className={styles.section}>
            <p className={styles.path}>{scan.server.url}</p>
            {offer === null ? (
              <div className={styles.actions}>
                <Button variant="primary" size="m" disabled={busy} onClick={() => void run(async () => {
                  const result = await inspectPairingScan(scan)
                  if (life.current.open) setOffer(result)
                })}>{t('remotePairingConfirmServer')}</Button>
              </div>
            ) : (
              <>
                <h3 className={styles.path}>{offer.host.name || offer.host.deviceId}</h3>
                <p>{t('remotePairingFingerprint')}</p>
                <code className={styles.path}>{pairingFingerprint(offer)}</code>
                {code ? (
                  <>
                    <p>{t('remotePairingVerificationHelp')}</p>
                    <output className={styles.verificationCode}>{code}</output>
                  </>
                ) : (
                  <div className={styles.actions}>
                    <Button variant="primary" size="m" disabled={busy} onClick={() => void run(() => waitForHost(offer))}>
                      {t('remotePairingConfirmHost')}
                    </Button>
                  </div>
                )}
              </>
            )}
          </section>
        )}
        {error && <div role="alert">{error}</div>}
      </div>
    </Modal>
  )
}
