import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { changeHostWorkspace, reorderHostWorkspaceSession, useNewSessionStore, type WorkspaceChange } from '../../services/remote/newSessionStore.js'
import { describeRemoteError, type RemoteCallTarget } from '../../services/remote/sessionsApi.js'
import { useRemoteStore } from '../../services/remote/store.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import styles from './RemoteManagementDialog.module.css'

export default function HostWorkspaces({ target, onClose }: { target: RemoteCallTarget; onClose: () => void }) {
  const t = useTranslate()
  const workspaces = useNewSessionStore((state) => state.hostWorkspaces)
  const preferences = useNewSessionStore((state) => state.workspacePreferences)
  const sessions = useRemoteStore((state) => state.sessions)
  const [workspaceId, setWorkspaceId] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [editor, setEditor] = useState<{ kind: 'rename' | 'remove' | 'group'; id: string; title: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const index = workspaces.findIndex((workspace) => workspace.workspaceId === workspaceId)
  const current = workspaces[index]
  const sessionIndex = current?.sessionIds.indexOf(sessionId) ?? -1
  const edit = editor?.id === current?.workspaceId ? editor : null
  const pinned = preferences.pinned.includes(workspaceId)
  const group = Object.hasOwn(preferences.groups, workspaceId) ? preferences.groups[workspaceId] : ''
  const groupNames = [...new Set(Object.values(preferences.groups))]

  useEffect(() => {
    void useNewSessionStore.getState().ensureWorkspaceFlags()
  }, [])

  async function update(action: () => Promise<void>) {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      await action()
      setEditor(null)
    } catch (failure) {
      setError(describeRemoteError(failure).text)
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  function change(operation: WorkspaceChange) {
    if (current !== undefined) void update(() => changeHostWorkspace(target, current.workspaceId, operation))
  }

  function moveSession(beforeSessionId?: string) {
    if (current !== undefined && sessionIndex >= 0) {
      void update(() => reorderHostWorkspaceSession(target, current.workspaceId, sessionId, beforeSessionId))
    }
  }

  return (
    <Modal expanded title={t('remoteManageWorkspaces')} onClose={onClose} closable className={styles.modal} mainClassName={styles.body}>
      <div className={styles.layout} aria-busy={busy}>
        {workspaces.length === 0 ? <p>{t('remoteHostWorkspacesEmpty')}</p> : (
          <label className={styles.field}>
            {t('newSessionWorkspace')}
            <select disabled={busy} value={current?.workspaceId ?? ''} onChange={(event) => {
              setWorkspaceId(event.target.value)
              setSessionId('')
              setEditor(null)
              setError('')
            }}>
              <option value="">{t('remoteBackupChooseWorkspace')}</option>
              {workspaces.map((workspace) => (
                <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.title || workspace.path || workspace.workspaceId}</option>
              ))}
            </select>
          </label>
        )}
        {current && <>
          <p className={styles.path}>{current.path}</p>
          <div className={styles.actions}>
            <Button variant="outlined" size="m" disabled={busy || index === 0 || edit !== null}
              onClick={() => void change({ kind: 'reorder', beforeWorkspaceId: workspaces[index - 1]?.workspaceId })}>
              {t('remoteWorkspaceMoveUp')}
            </Button>
            <Button variant="outlined" size="m" disabled={busy || index >= workspaces.length - 1 || edit !== null}
              onClick={() => void change({ kind: 'reorder', beforeWorkspaceId: workspaces[index + 2]?.workspaceId })}>
              {t('remoteWorkspaceMoveDown')}
            </Button>
            <Button variant="outlined" size="m" disabled={busy || edit !== null} onClick={() => {
              setError('')
              setEditor({ kind: 'rename', id: current.workspaceId, title: current.title })
            }}>{t('sessionItemMenuRenameOption')}</Button>
            <Button variant="outlined" size="m" disabled={busy || edit !== null} onClick={() => {
              setError('')
              setEditor({ kind: 'remove', id: current.workspaceId, title: current.title })
            }}>{t('remoteWorkspaceRemove')}</Button>
            <Button variant="outlined" size="m" disabled={busy || edit !== null}
              onClick={() => useNewSessionStore.getState().pinWorkspace(current.workspaceId, !pinned)}>
              {t(pinned ? 'remoteWorkspaceUnpin' : 'remoteWorkspacePin')}
            </Button>
            <Button variant="outlined" size="m" disabled={busy || edit !== null} onClick={() => {
              setError('')
              setEditor({ kind: 'group', id: current.workspaceId, title: group })
            }}>{t('remoteWorkspaceEditGroup')}</Button>
          </div>
          {current.sessionIds.length > 1 && edit === null && <section className={styles.section}>
            <label className={styles.field}>{t('remoteWorkspaceSessionOrder')}
              <select disabled={busy} value={sessionIndex >= 0 ? sessionId : ''}
                onChange={(event) => { setSessionId(event.currentTarget.value); setError('') }}>
                <option value="">{t('remoteBackupChooseSession')}</option>
                {current.sessionIds.map((id) => <option key={id} value={id}>
                  {sessions.find((session) => session.id === id)?.title || id}
                </option>)}
              </select>
            </label>
            <div className={styles.actions}>
              <Button variant="outlined" size="m" disabled={busy || sessionIndex <= 0}
                onClick={() => moveSession(current.sessionIds[sessionIndex - 1])}>{t('remoteWorkspaceSessionUp')}</Button>
              <Button variant="outlined" size="m" disabled={busy || sessionIndex < 0 || sessionIndex === current.sessionIds.length - 1}
                onClick={() => moveSession(current.sessionIds[sessionIndex + 2])}>{t('remoteWorkspaceSessionDown')}</Button>
            </div>
          </section>}
        </>}
        {edit?.kind === 'rename' && (
          <form className={styles.layout} onSubmit={(event) => {
            event.preventDefault()
            if (edit.title.trim()) void change({ kind: 'rename', title: edit.title })
          }}>
            <label className={styles.field}>
              {t('remoteWorkspaceTitle')}
              <input disabled={busy} value={edit.title} maxLength={80} required
                onChange={(event) => setEditor({ ...edit, title: event.target.value })} />
            </label>
            <div className={styles.actions}>
              <Button type="submit" variant="primary" size="m" disabled={busy || !edit.title.trim()}>{t('sessionItemMenuRenameOption')}</Button>
              <Button variant="outlined" size="m" disabled={busy} onClick={() => setEditor(null)}>{t('cancel')}</Button>
            </div>
          </form>
        )}
        {edit?.kind === 'remove' && (
          <section className={styles.section}>
            <p>{t('remoteWorkspaceRemoveConfirm', { title: edit.title || current?.path || edit.id })}</p>
            <div className={styles.actions}>
              <Button variant="primary" size="m" disabled={busy} onClick={() => void change({ kind: 'remove' })}>{t('remoteWorkspaceRemove')}</Button>
              <Button variant="outlined" size="m" disabled={busy} onClick={() => setEditor(null)}>{t('cancel')}</Button>
            </div>
          </section>
        )}
        {edit?.kind === 'group' && (
          <form className={styles.layout} onSubmit={(event) => {
            event.preventDefault()
            useNewSessionStore.getState().groupWorkspace(edit.id, edit.title)
            setEditor(null)
          }}>
            <label className={styles.field}>
              {t('remoteWorkspaceGroupName')}
              <input value={edit.title} maxLength={80} list="remote-workspace-groups"
                onChange={(event) => setEditor({ ...edit, title: event.currentTarget.value })} />
            </label>
            <datalist id="remote-workspace-groups">
              {groupNames.map((name) => <option key={name} value={name} />)}
            </datalist>
            <div className={styles.actions}>
              <Button type="submit" variant="primary" size="m">{t('newSessionRenameSave')}</Button>
              {group && <Button variant="outlined" size="m" onClick={() => {
                useNewSessionStore.getState().groupWorkspace(edit.id, '')
                setEditor(null)
              }}>{t('remoteWorkspaceClearGroup')}</Button>}
              <Button variant="outlined" size="m" onClick={() => setEditor(null)}>{t('cancel')}</Button>
            </div>
          </form>
        )}
        {error && <div role="alert">{error}</div>}
      </div>
    </Modal>
  )
}
