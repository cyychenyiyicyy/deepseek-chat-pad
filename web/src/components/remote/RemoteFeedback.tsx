import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { callEndpoint, describeRemoteError, lastRemoteTarget } from '../../services/remote/sessionsApi.js'
import { RemoteApiError } from '../../services/remote/serverApi.js'
import type { TerminalScope } from '../../services/remote/terminal.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import styles from './RemoteManagementDialog.module.css'

type Rating = 'positive' | 'negative'
type Feedback = { messageId: string; rating: Rating; version: string }

function parseFeedback(value: unknown): Feedback | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { messageId, rating, version } = value as Partial<Feedback>
  if (typeof messageId !== 'string' || typeof version !== 'string' || (rating !== 'positive' && rating !== 'negative')) return undefined
  return { messageId, version, rating }
}

export default function RemoteFeedback({ scope, messageId, onClose }: {
  scope: TerminalScope; messageId: string; onClose: () => void
}) {
  const t = useTranslate()
  const [currentRating, setCurrentRating] = useState<Feedback | null | undefined>(undefined)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const alive = useRef(false)
  const pending = useRef(false)
  const current = () => alive.current && scope.current() && lastRemoteTarget() === scope.target
  const address = { sessionId: scope.sessionId, messageId }

  async function read() {
    const result = await callEndpoint<{ items?: unknown }>(scope.target, 'messageFeedback/list', {
      request: { sessionId: scope.sessionId },
    })
    if (!Array.isArray(result?.items)) throw new RemoteApiError('INVALID_MESSAGE', 'The Host did not return message feedback.')
    return result.items.map(parseFeedback).find((item) => item?.messageId === messageId) ?? null
  }

  async function run(action: () => Promise<void>) {
    if (!current() || pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    try { await action() }
    catch (failure) {
      if (current()) setError(describeRemoteError(failure).text)
    } finally {
      pending.current = false
      if (current()) setBusy(false)
    }
  }

  useEffect(() => {
    alive.current = true
    void run(async () => {
      const rating = await read()
      if (current()) setCurrentRating(rating)
    })
    return () => { alive.current = false }
  }, [scope, messageId])

  const update = (rating?: Rating) => run(async () => {
    if (currentRating === undefined || (rating === undefined && currentRating === null)) return
    let failure: unknown
    try {
      await callEndpoint<unknown>(scope.target, rating ? 'messageFeedback/put' : 'messageFeedback/delete', { request: {
        ...address, ifVersion: currentRating?.version ?? null, ...(rating ? { rating } : {}),
      } })
    } catch (error) {
      failure = error
    }
    if (!current()) return
    const saved = await read()
    if (!current()) return
    setCurrentRating(saved)
    if (saved?.rating !== rating) {
      throw failure ?? new RemoteApiError('INVALID_MESSAGE', 'The Host did not confirm the feedback change.')
    }
  })

  return <Modal title={t('remoteFeedback')} onClose={onClose} closable className={styles.modal} mainClassName={styles.body}>
    <div className={styles.layout} aria-busy={busy}>
      {error && <p role="alert">{error}</p>}
      {busy && currentRating === undefined && <p role="status">{t('workspacePaneLoading')}</p>}
      <div className={styles.actions}>
        {(['positive', 'negative'] as const).map((rating) => <Button key={rating}
          variant={currentRating?.rating === rating ? 'primary' : 'outlined'} size="m" aria-pressed={currentRating?.rating === rating}
          disabled={busy || currentRating === undefined} onClick={() => void update(rating)}>
          {t(rating === 'positive' ? 'remoteFeedbackPositive' : 'remoteFeedbackNegative')}
        </Button>)}
        {currentRating && <Button variant="outlined" size="m" disabled={busy} onClick={() => void update()}>{t('remoteFeedbackClear')}</Button>}
      </div>
    </div>
  </Modal>
}
