import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { jobIsCurrent, openJobStream, readJobFrame, readJobList, stopJob, type RemoteJob, type RemoteJobScope } from '../../services/remote/jobs.js'
import { describeRemoteError } from '../../services/remote/sessionsApi.js'
import { subscribeRemoteStream } from '../../services/remote/store.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import styles from './RemoteManagementDialog.module.css'

const OUTPUT_LIMIT = 128 * 1024
const LIVE = new Set(['running', 'stopping'])

export default function RemoteJobs({ scope, onClose }: { scope: RemoteJobScope; onClose: () => void }) {
  const t = useTranslate()
  const [rows, setRows] = useState<RemoteJob[] | null>(null)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const fail = (failure: unknown) => setError(describeRemoteError(failure).text)
    return subscribeRemoteStream(scope.target, openJobStream(scope), (payload) => {
      if (!jobIsCurrent(scope)) return
      if (payload.type === 'closed') {
        if (payload.failure) fail(payload.failure)
        else if (payload.reason !== 'completed') setError(t('remoteJobsDisconnected'))
        else setRows((previous) => previous ?? [])
        return
      }
      const list = payload.hasValue ? readJobList(payload.value) : undefined
      if (list) setRows(list)
    }, fail)
  }, [scope, revision, t])

  const job = rows?.find((row) => row.id === selected)
  return (
    <Modal title={t('remoteJobs')} onClose={onClose} closable className={styles.modal} mainClassName={styles.body}>
      {job ? <JobOutput key={job.id} scope={scope} job={job} onBack={() => setSelected(null)} /> : (
        <div className={styles.layout}>
          {error && <div role="alert">{error}</div>}
          {rows === null && !error && <p role="status">{t('workspacePaneLoading')}</p>}
          {rows?.length === 0 && <p>{t('remoteJobsEmpty')}</p>}
          {[true, false].map((live) => {
            const group = rows?.filter((row) => LIVE.has(row.status) === live)
            if (!group?.length) return null
            return <section className={styles.section} key={String(live)}>
              <h3>{t(live ? 'remoteJobsRunning' : 'remoteJobsEnded')}</h3>
              {group.map((row) => (
                <div className={styles.row} key={row.id}>
                  <div>{row.label}<small>{t(jobStatus[row.status])}{row.progress ? ' · ' + row.progress : ''}</small></div>
                  <Button variant="outlined" size="m" onClick={() => setSelected(row.id)}>{t('remoteJobOutput')}</Button>
                </div>
              ))}
            </section>
          })}
          <div className={styles.actions}>
            <Button variant="outlined" size="m" onClick={() => {
              setError('')
              setRevision((value) => value + 1)
            }}>{t('remoteTerminalRefresh')}</Button>
          </div>
        </div>
      )}
    </Modal>
  )
}

const jobStatus = {
  running: 'remoteJobRunning',
  stopping: 'remoteJobStopping',
  completed: 'remoteJobCompleted',
  killed: 'remoteJobKilled',
  failed: 'remoteJobFailed',
} as const

function JobOutput({ scope, job, onBack }: { scope: RemoteJobScope; job: RemoteJob; onBack: () => void }) {
  const t = useTranslate()
  const [detail, setDetail] = useState<RemoteJob | null>(null)
  const [output, setOutput] = useState({ text: '', trimmed: false })
  const [confirm, setConfirm] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const inFlight = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const id = job.id
  useEffect(() => {
    const lifetime = new AbortController()
    controller.current = lifetime
    const fail = (failure: unknown) => setError(describeRemoteError(failure).text)
    const release = subscribeRemoteStream(scope.target, openJobStream(scope, id), (payload) => {
      if (!jobIsCurrent(scope)) return
      if (payload.type === 'closed') {
        if (payload.failure) fail(payload.failure)
        else if (payload.reason !== 'completed') setError(t('remoteJobsDisconnected'))
        return
      }
      const frame = payload.hasValue ? readJobFrame(payload.value) : undefined
      if (frame?.kind === 'job' && frame.job.id === id) setDetail(frame.job)
      if (frame?.kind === 'output') setOutput((previous) => {
        const text = previous.text + frame.text
        return { text: text.slice(-OUTPUT_LIMIT), trimmed: previous.trimmed || frame.trimmed || text.length > OUTPUT_LIMIT }
      })
    }, fail)
    return () => {
      lifetime.abort()
      release()
    }
  }, [scope, id, t])

  const current = !LIVE.has(job.status) ? job : detail ?? job
  async function stop() {
    if (inFlight.current || current.status !== 'running') return
    const lifetime = controller.current
    inFlight.current = true
    setStopping(true)
    setConfirm(false)
    setError('')
    setNotice('')
    try {
      const outcome = await stopJob(scope, id)
      if (lifetime?.signal.aborted || !jobIsCurrent(scope)) return
      setNotice(t(outcome === 'requested' ? 'remoteJobStopRequested' : 'remoteJobAlreadyEnded'))
    } catch (failure) {
      if (!lifetime?.signal.aborted && jobIsCurrent(scope)) setError(describeRemoteError(failure).text)
    } finally {
      inFlight.current = false
      if (!lifetime?.signal.aborted) setStopping(false)
    }
  }

  return <div className={styles.layout}>
    <div className={styles.actions}>
      <Button variant="outlined" size="m" onClick={onBack}>{t('chatControlsBack')}</Button>
      {current.status === 'running' && !confirm && <Button variant="outlined" size="m"
        disabled={stopping || notice !== ''} onClick={() => setConfirm(true)}>{t('remoteJobStop')}</Button>}
    </div>
    <h3 className={styles.path}>{current.label}</h3>
    <p>{t(jobStatus[current.status])}{current.detail ? ' · ' + current.detail : ''}</p>
    {confirm && <section className={styles.section}>
      <p>{t('remoteJobStopConfirm')}</p>
      <div className={styles.actions}>
        <Button variant="primary" size="m" onClick={() => void stop()}>{t('remoteJobStop')}</Button>
        <Button variant="outlined" size="m" onClick={() => setConfirm(false)}>{t('cancel')}</Button>
      </div>
    </section>}
    {notice && <p role="status">{notice}</p>}
    {error && <div role="alert">{error}</div>}
    {output.trimmed && <p role="status">{t('remoteJobOutputTrimmed')}</p>}
    <pre className={styles.output} tabIndex={0} aria-label={t('remoteJobOutput')}>{output.text}</pre>
  </div>
}
