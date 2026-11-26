import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useNewSessionStore } from '../../services/remote/newSessionStore.js'
import { describeRemoteError, newRequestId } from '../../services/remote/sessionsApi.js'
import {
  deleteSessionBackup, forgetSessionRestore, listSessionBackups, openSessionBackup, reserveSessionRestore,
  sameBackupHost, sameBackupPeer, saveSessionBackup, saveSessionRestoreResult,
  type SessionBackup, type SessionRestoreRecord,
} from '../../services/remote/sessionBackupDb.js'
import {
  exportSessionSnapshots, querySessionRestore, restoreSessionSnapshot,
  SESSION_EXPORT, SESSION_IMPORT, SessionImportUnknown, type SessionImportResult,
} from '../../services/remote/sessionTransfer.js'
import { sessionTransferConnection, useRemoteStore } from '../../services/remote/store.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import styles from './RemoteManagementDialog.module.css'

type Job = { cancelled: boolean; committing: boolean }

export default function SessionBackups({ onClose }: { onClose: () => void }) {
  const t = useTranslate()
  const phase = useRemoteStore((state) => state.phase)
  const hostId = useRemoteStore((state) => state.hostId)
  const caps = useRemoteStore((state) => state.capabilities)
  const sessions = useRemoteStore((state) => state.sessions)
  const workspaces = useNewSessionStore((state) => state.workspaces)
  const [data, setData] = useState<Awaited<ReturnType<typeof listSessionBackups>>>({ backups: [], restores: [] })
  const [workspaceId, setWorkspaceId] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [busy, setBusy] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [message, setMessage] = useState('')
  const job = useRef<Job | null>(null)
  const connected = phase === 'ready'
  const workspace = workspaces.find((item) => item.workspaceId === workspaceId)
  const connection = sessionTransferConnection()
  const visibleSessions = workspace ? sessions.filter((item) => workspace.sessionIds.includes(item.id)) : sessions
  const sourceId = visibleSessions.some((item) => item.id === sessionId) ? sessionId : ''

  useEffect(() => {
    let mounted = true
    void listSessionBackups().then((next) => {
      if (mounted) setData(next)
    }, (error) => {
      if (mounted) setMessage(describeRemoteError(error).text)
    })
    return () => {
      mounted = false
      if (job.current && !job.current.committing) job.current.cancelled = true
    }
  }, [])
  useEffect(() => {
    setWorkspaceId('')
    setSessionId('')
    if (connected) void useNewSessionStore.getState().ensureWorkspaceFlags()
  }, [connected, hostId])

  const run = async (fn: (running: Job) => Promise<void>) => {
    if (job.current) return
    const running = { cancelled: false, committing: false }
    job.current = running
    setMessage('')
    setBusy(true)
    try {
      await fn(running)
    } catch (error) {
      setMessage(error instanceof SessionImportUnknown ? t('remoteRestoreUnknown')
        : running.cancelled ? t('remoteBackupCancelled') : describeRemoteError(error).text)
    } finally {
      try {
        setData(await listSessionBackups())
      } catch (error) {
        setMessage((previous) => previous || describeRemoteError(error).text)
      }
      job.current = null
      setBusy(false)
      setCommitting(false)
    }
  }

  const save = () => void run(async (running) => {
    if (!connection || (!sourceId && !workspace)) return
    let count = 0
    const owner = { ...connection.owner, current: () => !running.cancelled && connection.owner.current() }
    const scope = sourceId ? { kind: 'session' as const, sessionId: sourceId }
      : { kind: 'workspace' as const, workspaceId }
    await exportSessionSnapshots(owner, scope, async (entry, snapshot) => {
      await saveSessionBackup({
        ...entry,
        id: newRequestId(),
        title: sessions.find((item) => item.id === entry.sessionId)?.title || entry.sessionId,
        createdAt: Date.now(),
        totalBytes: snapshot.bytes.length,
        sha256: snapshot.sha256,
      }, snapshot)
      count += 1
      setMessage(t('remoteBackupSaved', { count }))
    })
    setMessage(t('remoteBackupSaved', { count }))
  })

  const recordResult = async (pending: SessionRestoreRecord, result: SessionImportResult) => {
    setMessage(t(result.workspaceAttached ? 'remoteRestoreDone' : 'remoteRestoreDetached', { id: result.sessionId }))
    try {
      await saveSessionRestoreResult(pending, result)
    } catch {
      setMessage((previous) => [previous, t('remoteRestoreRecordFailed')].join(' '))
    }
    if (connection?.owner.current()) void useRemoteStore.getState().refreshSessions()
  }

  const restore = (backup: SessionBackup) => {
    if (!connection || !workspace || !window.confirm(t('remoteRestoreConfirm', { title: backup.title, workspace: workspace.title }))) return
    void run(async (running) => {
      const owner = { ...connection.owner, current: () => !running.cancelled && connection.owner.current() }
      const pending: SessionRestoreRecord = {
        peer: connection.peer, backupId: backup.id, sourceSessionId: backup.sessionId,
        createdAt: Date.now(), workspaceId, batchId: newRequestId(), requestId: newRequestId(),
      }
      const snapshot = await openSessionBackup(backup)
      let reserved = false
      let result: SessionImportResult
      try {
        result = await restoreSessionSnapshot(owner, pending, snapshot, async () => {
          await reserveSessionRestore(pending)
          reserved = true
          running.committing = true
          setCommitting(true)
        })
      } catch (error) {
        if (reserved && !(error instanceof SessionImportUnknown)) await forgetSessionRestore(pending)
        throw error
      }
      await recordResult(pending, result)
    })
  }

  const check = (pending: SessionRestoreRecord) => void run(async () => {
    if (!connection || !sameBackupPeer(pending.peer, connection.peer)) {
      setMessage(t('remoteRestoreOriginalDevice'))
      return
    }
    const result = await querySessionRestore(connection.owner, pending)
    if (result) await recordResult(pending, result)
    else setMessage(t('remoteRestoreUnknown'))
  })

  const pending = data.restores.filter((record) => record.result === undefined)
  return (
    <Modal expanded title={t('remoteSessionBackups')} onClose={onClose} closable className={styles.modal} mainClassName={styles.body}>
      <div className={styles.layout}>
        <p>{t('remoteBackupDescription')}</p>
        <label className={styles.field}>
          {t('remoteBackupWorkspace')}
          <select value={workspace?.workspaceId ?? ''} disabled={busy || !connected} onChange={(event) => {
            setWorkspaceId(event.target.value)
            setSessionId('')
          }}>
            <option value="">{t('remoteBackupChooseWorkspace')}</option>
            {workspaces.map((item) => <option key={item.workspaceId} value={item.workspaceId}>{item.title}</option>)}
          </select>
        </label>
        {connected && caps.includes(SESSION_EXPORT) && (
          <label className={styles.field}>
            {t('remoteBackupSource')}
            <select value={sourceId} disabled={busy} onChange={(event) => setSessionId(event.target.value)}>
              <option value="">{t(workspace ? 'remoteBackupAllSessions' : 'remoteBackupChooseSession')}</option>
              {visibleSessions.map((item) => <option key={item.id} value={item.id}>{item.title || item.id}</option>)}
            </select>
          </label>
        )}
        <div className={styles.actions}>
          {connected && caps.includes(SESSION_EXPORT) && (
            <Button variant="primary" size="m" onClick={save} disabled={busy || (!sourceId && !workspace)}>
              {t('remoteBackupSave')}
            </Button>
          )}
          {busy && !committing && <Button variant="outlined" size="s" onClick={() => {
            if (job.current) job.current.cancelled = true
          }}>{t('remoteLoginCancel')}</Button>}
        </div>
        {message && <div className={styles.status} role="status">{message}</div>}
        {pending.length > 0 && (
          <section className={styles.section}>
            <h3>{t('remoteRestorePending')}</h3>
            <p>{t('remoteRestorePendingHelp')}</p>
            {pending.map((record) => (
              <div className={styles.row} key={record.requestId}>
                <div>{data.backups.find((backup) => backup.id === record.backupId)?.title ?? record.sourceSessionId}</div>
                <div className={styles.actions}>
                  <Button variant="outlined" size="s" disabled={busy || !connection || !caps.includes(SESSION_IMPORT)}
                    onClick={() => check(record)}>{t('remoteRestoreCheck')}</Button>
                  <Button variant="outlined" size="s" disabled={busy} onClick={() => {
                    if (window.confirm(t('remoteRestoreReviewConfirm'))) void run(() => forgetSessionRestore(record))
                  }}>{t('remoteRestoreReviewed')}</Button>
                </div>
              </div>
            ))}
          </section>
        )}
        <section className={styles.section}>
          <h3>{t('remoteBackupsOnDevice')}</h3>
          {data.backups.length === 0 && <p>{t('remoteBackupsEmpty')}</p>}
          {data.backups.map((backup) => {
            const waiting = pending.some((record) => record.backupId === backup.id)
            const targetPending = !!connection && pending.some((record) =>
              record.backupId === backup.id && sameBackupHost(record.peer, connection.peer))
            const result = data.restores.find((record) => record.backupId === backup.id && record.result)?.result
            return (
              <div className={styles.row} key={backup.id}>
                <div>
                  <div>{backup.title}</div>
                  <small>{new Date(backup.createdAt).toLocaleString()} · {Math.ceil(backup.totalBytes / 1024)} KB</small>
                  {result && <small>{t(result.workspaceAttached ? 'remoteRestoreDone' : 'remoteRestoreDetached', { id: result.sessionId })}</small>}
                </div>
                <div className={styles.actions}>
                  {connected && caps.includes(SESSION_IMPORT) && (
                    <Button variant="outlined" size="s" disabled={busy || !workspace || targetPending}
                      onClick={() => restore(backup)}>{t('remoteBackupRestore')}</Button>
                  )}
                  <Button variant="outlined" size="s" disabled={busy || waiting} onClick={() => {
                    if (window.confirm(t('remoteBackupDeleteConfirm', { title: backup.title }))) {
                      void run(() => deleteSessionBackup(backup.id))
                    }
                  }}>{t('remoteBackupDelete')}</Button>
                </div>
              </div>
            )
          })}
        </section>
      </div>
    </Modal>
  )
}
