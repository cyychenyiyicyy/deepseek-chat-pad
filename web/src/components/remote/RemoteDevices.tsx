import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import type { DeviceChange } from '../../services/remote/connection.js'
import { isRemoteApiError, type DeviceMembership } from '../../services/remote/serverApi.js'
import { describeRemoteError, type RemoteCallTarget } from '../../services/remote/sessionsApi.js'
import { changeRemoteDevice, listRemoteMemberships, useRemoteStore } from '../../services/remote/store.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import styles from './RemoteManagementDialog.module.css'

export default function RemoteDevices({ target, onClose }: { target: RemoteCallTarget; onClose: () => void }) {
  const t = useTranslate()
  const hosts = useRemoteStore((state) => state.hosts)
  const activeId = useRemoteStore((state) => state.hostId)
  const [deviceId, setDeviceId] = useState(activeId ?? '')
  const host = hosts.find((row) => row.deviceId === deviceId)
  const [editor, setEditor] = useState<'rename' | 'revokeHost' | 'revokeSelf' | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [memberships, setMemberships] = useState<DeviceMembership[] | null>(null)
  const [membershipError, setMembershipError] = useState('')
  const [unpair, setUnpair] = useState<DeviceMembership | null>(null)
  const inFlight = useRef(false)

  useEffect(() => {
    let cancelled = false
    void listRemoteMemberships(target).then((result) => {
      if (!cancelled) setMemberships(result)
    }, (failure) => {
      if (cancelled) return
      const unavailable = isRemoteApiError(failure) && (failure.status === 404 || failure.status === 405)
      setMembershipError(unavailable ? t('remoteMembershipsUnavailable') : describeRemoteError(failure).text)
    })
    return () => { cancelled = true }
  }, [target, t])

  async function apply(change: DeviceChange) {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      await changeRemoteDevice(target, change)
      setEditor(null)
      setUnpair(null)
      if (change.kind === 'unpair' || change.kind === 'revokeHost') {
        setMemberships((items) => items?.filter((item) => item.peer.deviceId !== change.deviceId) ?? null)
      }
    } catch (failure) {
      setError(describeRemoteError(failure).text)
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <Modal expanded title={t('remoteManageDevices')} onClose={onClose} closable className={styles.modal} mainClassName={styles.body}>
      <div className={styles.layout} aria-busy={busy}>
        <label className={styles.field}>
          {t('remoteDeviceHost')}
          <select value={host?.deviceId ?? ''} disabled={busy || editor !== null || unpair !== null}
            onChange={(event) => { setDeviceId(event.target.value); setError('') }}>
            <option value="">{t('remoteDeviceChooseHost')}</option>
            {hosts.map((row) => <option key={row.deviceId} value={row.deviceId}>{row.name}</option>)}
          </select>
        </label>
        {editor === null && unpair === null && <div className={styles.actions}>
          <Button variant="outlined" size="m" disabled={!host || busy} onClick={() => {
            setName(host?.name ?? '')
            setError('')
            setEditor('rename')
          }}>{t('sessionItemMenuRenameOption')}</Button>
          <Button variant="outlined" size="m" disabled={!host || busy} onClick={() => {
            setError('')
            setEditor('revokeHost')
          }}>{t('remoteRevokeHost')}</Button>
          <Button variant="outlined" size="m" disabled={busy} onClick={() => {
            setError('')
            setEditor('revokeSelf')
          }}>{t('remoteRevokeSelf')}</Button>
        </div>}
        {editor === 'rename' && host && (
          <form className={styles.layout} onSubmit={(event) => {
            event.preventDefault()
            if (name.trim()) void apply({ kind: 'rename', deviceId: host.deviceId, name })
          }}>
            <label className={styles.field}>
              {t('remoteDeviceName')}
              <input value={name} maxLength={128} required disabled={busy} onChange={(event) => setName(event.target.value)} />
            </label>
            <div className={styles.actions}>
              <Button type="submit" variant="primary" size="m" disabled={busy || !name.trim()}>{t('sessionItemMenuRenameOption')}</Button>
              <Button variant="outlined" size="m" disabled={busy} onClick={() => setEditor(null)}>{t('cancel')}</Button>
            </div>
          </form>
        )}
        {(editor === 'revokeSelf' || (editor === 'revokeHost' && host)) && (
          <section className={styles.section}>
            <p>{editor === 'revokeSelf' ? t('remoteRevokeSelfConfirm') : t('remoteRevokeHostConfirm', { host: host?.name ?? deviceId })}</p>
            <div className={styles.actions}>
              <Button variant="primary" size="m" disabled={busy} onClick={() => {
                if (editor === 'revokeSelf') void apply({ kind: 'revokeSelf' })
                else if (host) void apply({ kind: 'revokeHost', deviceId: host.deviceId })
              }}>{t(editor === 'revokeSelf' ? 'remoteRevokeSelf' : 'remoteRevokeHost')}</Button>
              <Button variant="outlined" size="m" disabled={busy} onClick={() => setEditor(null)}>{t('cancel')}</Button>
            </div>
          </section>
        )}
        {editor !== null && editor !== 'revokeSelf' && !host && (
          <Button variant="outlined" size="m" disabled={busy} onClick={() => setEditor(null)}>{t('cancel')}</Button>
        )}
        <section className={styles.section}>
          <h3>{t('remoteMemberships')}</h3>
          {membershipError ? <p role="status">{membershipError}</p>
            : memberships === null ? <p role="status">{t('workspacePaneLoading')}</p>
              : memberships.length === 0 ? <p>{t('remoteMembershipsEmpty')}</p> : null}
          {memberships?.map((membership) => {
            const name = membership.peer.name || membership.peer.deviceId
            return <div key={membership.membershipId} className={styles.row}>
              <div>{name}{membership.peer.platform && <small>{membership.peer.platform}</small>}</div>
              <Button variant="outlined" size="m" disabled={busy || editor !== null || unpair !== null}
                onClick={() => { setError(''); setUnpair(membership) }}>{t('remoteUnpair')}</Button>
            </div>
          })}
          {unpair && <div className={styles.section}>
            <p>{t('remoteUnpairConfirm', { device: unpair.peer.name || unpair.peer.deviceId })}</p>
            <div className={styles.actions}>
              <Button variant="primary" size="m" disabled={busy}
                onClick={() => void apply({ kind: 'unpair', deviceId: unpair.peer.deviceId })}>{t('remoteUnpair')}</Button>
              <Button variant="outlined" size="m" disabled={busy} onClick={() => setUnpair(null)}>{t('cancel')}</Button>
            </div>
          </div>}
        </section>
        {error && <div role="alert">{error}</div>}
      </div>
    </Modal>
  )
}
