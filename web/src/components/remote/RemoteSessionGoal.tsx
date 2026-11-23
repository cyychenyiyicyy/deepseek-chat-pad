import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useChatControls } from '../../services/remote/sessionControls.js'
import { callEndpoint, describeRemoteError, lastRemoteTarget } from '../../services/remote/sessionsApi.js'
import type { TerminalScope } from '../../services/remote/terminal.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import styles from './RemoteManagementDialog.module.css'

type Phase = 'active' | 'paused' | 'blocked' | 'complete'
type Action = 'create' | 'edit' | 'pause' | 'resume' | 'complete' | 'clear'
type Goal = {
  id: string
  revision: number
  objective: string
  phase: Phase
  rounds: number
  maxRounds: number | undefined
  reason?: string
}

const object = (value: unknown) => value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
function parseGoal(projection: unknown): Goal | null {
  const value = object(projection)
  const goal = object(value?.goal) ?? value
  const phase = goal?.phase
  if (!goal || typeof goal.id !== 'string' || typeof goal.revision !== 'number' ||
    typeof goal.objective !== 'string' || (phase !== 'active' && phase !== 'paused' && phase !== 'blocked' && phase !== 'complete')) return null
  const reason = object(goal.blockedReason)?.message
  return { id: goal.id, revision: goal.revision, objective: goal.objective, phase,
    rounds: typeof value?.roundsStarted === 'number' ? value.roundsStarted : 0,
    maxRounds: typeof goal.maxGoalRounds === 'number' ? goal.maxGoalRounds : undefined,
    reason: typeof reason === 'string' ? reason : undefined }
}

export default function RemoteSessionGoal({ scope, onClose }: { scope: TerminalScope; onClose: () => void }) {
  const t = useTranslate()
  const projection = useChatControls((state) => state.goalProjection)
  const [goal, setGoal] = useState<Goal | null | undefined>(() => projection === undefined ? undefined : parseGoal(projection))
  const [editor, setEditor] = useState<'create' | 'edit' | null>(null)
  const [objective, setObjective] = useState('')
  const [roundCap, setRoundCap] = useState('')
  const [confirm, setConfirm] = useState<'complete' | 'clear' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const alive = useRef(false)
  const inFlight = useRef(false)
  const version = useRef(0)
  const editBase = useRef<Goal | null>(null)
  const current = () => alive.current && scope.current() && lastRemoteTarget() === scope.target

  async function refresh() {
    const started = version.current
    const raw = await callEndpoint<unknown>(scope.target, 'session/projections', { request: { sessionId: scope.sessionId } })
    if (!current() || version.current !== started) return
    if (!raw) throw new Error(t('remoteGoalUnavailable'))
    setGoal(parseGoal(object(object(raw)?.values)?.goal))
  }

  async function run(job: () => Promise<void>) {
    if (!current() || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError('')
    try { await job() }
    catch (failure) {
      if (current()) setError(describeRemoteError(failure).text)
    } finally {
      inFlight.current = false
      if (current()) setBusy(false)
    }
  }

  useEffect(() => {
    alive.current = true
    if (projection === undefined) void run(refresh)
    return () => { alive.current = false }
  }, [scope])

  useEffect(() => {
    if (projection === undefined || !current()) return
    ++version.current
    setGoal(parseGoal(projection))
  }, [projection])

  const cap = roundCap.trim() ? Number(roundCap) : undefined
  const valid = !!objective.trim() && (cap === undefined || (Number.isSafeInteger(cap) && cap > 0))
  const mutate = (action: Action, base: Goal | null = goal ?? null) => run(async () => {
    if (action !== 'create' && !base) return
    const args = {
      agentId: scope.sessionId,
      ...(action === 'create' ? {} : { ref: { id: base!.id, revision: base!.revision } }),
      ...(action === 'create' || action === 'edit' ? { request: {
        objective: objective.trim(), ...(cap === undefined ? {} : { maxGoalRounds: cap }),
      } } : {}),
    }
    const started = version.current
    const result = await callEndpoint<unknown>(scope.target, 'goals/' + action, args)
    if (!current()) return
    setEditor(null)
    setConfirm(null)
    if (version.current !== started) return
    if (action === 'create') {
      await refresh()
    } else if (action === 'clear') {
      setGoal(null)
    } else {
      const next = parseGoal(result)
      if (next) setGoal(next)
      else await refresh()
    }
  })

  const begin = (action: 'create' | 'edit') => {
    editBase.current = action === 'edit' ? goal ?? null : null
    setObjective(editBase.current?.objective ?? '')
    setRoundCap(editBase.current?.maxRounds ? String(editBase.current.maxRounds) : '')
    setEditor(action)
    setError('')
    setConfirm(null)
  }

  return <Modal title={t('remoteSessionGoal')} closable onClose={onClose} className={styles.modal} mainClassName={styles.body}>
    <div className={styles.layout} aria-busy={busy}>
      {error && <p role="alert">{error}</p>}
      {busy && goal === undefined && <p role="status">{t('workspacePaneLoading')}</p>}
      {editor ? <form className={styles.layout} onSubmit={(event) => {
        event.preventDefault()
        if (valid) void mutate(editor, editBase.current)
      }}>
        <label className={styles.field}>{t('remoteGoalObjective')}
          <textarea value={objective} required disabled={busy} onChange={(event) => setObjective(event.target.value)} />
        </label>
        <label className={styles.field}>{t('remoteGoalMaxRounds')}
          <input type="number" min="1" step="1" value={roundCap} disabled={busy}
            onChange={(event) => setRoundCap(event.target.value)} />
        </label>
        <div className={styles.actions}>
          <Button variant="primary" size="m" type="submit" disabled={!valid || busy}>{t('remoteScheduleSave')}</Button>
          <Button variant="outlined" size="m" disabled={busy} onClick={() => setEditor(null)}>{t('cancel')}</Button>
        </div>
      </form> : <>
        {goal === null && <p>{t('remoteGoalEmpty')}</p>}
        {goal && <>
          <div className={styles.section}>
            <p>{t(goal.phase === 'active' ? 'remoteGoalActive' : goal.phase === 'paused' ? 'remoteGoalPaused'
              : goal.phase === 'blocked' ? 'remoteGoalBlocked' : 'remoteGoalComplete')}</p>
            <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{goal.objective}</p>
            <p>{t('remoteGoalRounds', { count: goal.rounds })}{goal.maxRounds ? ' / ' + goal.maxRounds : ''}</p>
            {goal.reason && <p>{goal.reason}</p>}
          </div>
          {confirm && <p>{t(confirm === 'clear' ? 'remoteGoalConfirmClear' : 'remoteGoalConfirmComplete')}</p>}
          <div className={styles.actions}>
            {goal.phase !== 'complete' && <>
              <Button variant="outlined" size="m" disabled={busy} onClick={() => begin('edit')}>{t('remoteHostEditSetting')}</Button>
              {goal.phase === 'active' && <Button variant="outlined" size="m" disabled={busy}
                onClick={() => void mutate('pause')}>{t('remoteGoalPause')}</Button>}
              <Button variant="outlined" size="m" disabled={busy} onClick={() => void mutate('resume')}>{t('remoteGoalResume')}</Button>
              <Button variant="outlined" size="m" disabled={busy} onClick={() => {
                if (confirm === 'complete') void mutate('complete')
                else setConfirm('complete')
              }}>{t('remoteGoalFinish')}</Button>
            </>}
            <Button variant="outlined" size="m" disabled={busy} onClick={() => {
              if (confirm === 'clear') void mutate('clear')
              else setConfirm('clear')
            }}>{t('remoteGoalClear')}</Button>
          </div>
        </>}
        <div className={styles.actions}>
          {(goal === null || goal?.phase === 'complete') && <Button variant="primary" size="m" disabled={busy}
            onClick={() => begin('create')}>{t('remoteGoalCreate')}</Button>}
          <Button variant="outlined" size="m" disabled={busy} onClick={() => void run(refresh)}>{t('remoteTerminalRefresh')}</Button>
        </div>
      </>}
    </div>
  </Modal>
}
