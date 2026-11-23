import { useRef, useState, type FormEvent } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useRemoteStore } from '../../services/remote/store.js'
import { forgetSshProfile, sshProfileKey, sshProfiles, type SshHostInput } from '../../services/remote/sshHost.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { enterRemoteMode } from './RemoteModeSwitch.js'
import styles from './RemoteManagementDialog.module.css'

export default function SshHostDialog({ onClose }: { onClose(): void }) {
  const t = useTranslate()
  const [profiles, setProfiles] = useState(sshProfiles)
  const [profileKey, setProfileKey] = useState(() => profiles[0] ? sshProfileKey(profiles[0]) : '')
  const profile = profiles.find((row) => sshProfileKey(row) === profileKey)
  const [mode, setMode] = useState<SshHostInput['mode']>(profile?.mode ?? 'managed')
  const [auth, setAuth] = useState<'password' | 'privateKey'>(profile?.keyAuth ? 'privateKey' : 'password')
  const [useSaved, setUseSaved] = useState(profile?.savedCredentials === true)
  const [forget, setForget] = useState(false)
  const [localError, setLocalError] = useState('')
  const [busy, setBusy] = useState(false)
  const keyText = useRef<HTMLTextAreaElement>(null)
  const error = useRemoteStore((state) => state.error)

  function select(key: string) {
    const row = profiles.find((item) => sshProfileKey(item) === key)
    setProfileKey(key)
    setMode(row?.mode ?? 'managed')
    setAuth(row?.keyAuth ? 'privateKey' : 'password')
    setUseSaved(row?.savedCredentials === true)
    setForget(false)
    setLocalError('')
  }

  async function removeProfile() {
    if (!profile || busy) return
    setBusy(true)
    try {
      await forgetSshProfile(profile)
      setProfiles(sshProfiles())
      select('')
    } catch {
      setLocalError(t('remoteSshStorageError'))
    } finally {
      setBusy(false)
    }
  }

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const data = new FormData(event.currentTarget)
    const field = (name: string) => String(data.get(name) ?? '')
    setBusy(true)
    try {
      const connected = await useRemoteStore.getState().connectSsh(useSaved && profile ? {
        host: profile.host, port: profile.port, user: profile.user, fingerprint: profile.fingerprint,
        mode: profile.mode, remotePort: profile.remotePort, useSavedCredentials: true,
      } : {
        host: field('host'), port: Number(field('port')), user: field('user'), fingerprint: field('fingerprint'), mode,
        rememberCredentials: data.has('remember'),
        ...(auth === 'password' ? { password: field('password') } : { privateKey: field('key'), passphrase: field('passphrase') }),
        ...(mode === 'attach' ? { remotePort: Number(field('remotePort')), launchToken: field('launchToken') } : {}),
      })
      if (connected) {
        enterRemoteMode()
        onClose()
      }
    } finally {
      setBusy(false)
    }
  }

  function close() {
    if (busy) useRemoteStore.getState().disconnect()
    onClose()
  }

  return (
    <Modal title={t('remoteSshHost')} onClose={close} className={styles.modal} mainClassName={styles.body}>
      <div className={styles.layout}>
      {profiles.length > 0 && <label className={styles.field}>{t('remoteSshSavedHosts')}
        <select value={profileKey} disabled={busy} onChange={(event) => select(event.target.value)}>
          <option value="">{t('remoteSshAddHost')}</option>
          {profiles.map((row) => <option key={sshProfileKey(row)} value={sshProfileKey(row)}>
            {row.user + ' @ ' + row.host + ':' + row.port + (row.mode === 'attach' ? ' / ' + row.remotePort : '')}
          </option>)}
        </select>
      </label>}
      {profile?.savedCredentials && <label>
        <input type="checkbox" checked={useSaved} disabled={busy} onChange={(event) => setUseSaved(event.target.checked)} />
        {' '}{t('remoteSshUseSavedCredentials')}
      </label>}
      <form key={profileKey} className={styles.layout} onSubmit={(event) => void connect(event)}>
        {!useSaved && <>
        <label className={styles.field}>{t('remoteSshAddress')}
          <input name="host" required maxLength={253} defaultValue={profile?.host} autoCapitalize="none" spellCheck={false} disabled={busy} />
        </label>
        <div className={styles.sshFields}>
          <label className={styles.field}>{t('remoteSshPort')}
            <input type="number" name="port" required defaultValue={profile?.port ?? 22} min={1} max={65535} disabled={busy} />
          </label>
          <label className={styles.field}>{t('remoteSshUser')}
            <input name="user" required maxLength={128} defaultValue={profile?.user} autoCapitalize="none" spellCheck={false} disabled={busy} />
          </label>
        </div>
        <label className={styles.field}>{t('remoteSshFingerprint')}
          <input name="fingerprint" placeholder="SHA256:…" required maxLength={52} defaultValue={profile?.fingerprint}
            autoCapitalize="none" autoComplete="off" spellCheck={false} disabled={busy} />
          <small>{t('remoteSshFingerprintHelp')}</small>
        </label>
        <label className={styles.field}>{t('remoteSshAuthentication')}
          <select value={auth} onChange={(event) => setAuth(event.target.value === 'privateKey' ? 'privateKey' : 'password')} disabled={busy}>
            <option value="password">{t('remoteSshPassword')}</option>
            <option value="privateKey">{t('remoteSshPrivateKey')}</option>
          </select>
        </label>
        {auth === 'password' ? (
          <label className={styles.field}>{t('remoteSshPassword')}
            <input name="password" type="password" required autoComplete="off" maxLength={1024} disabled={busy} />
          </label>
        ) : (
          <>
            <label className={styles.field}>{t('remoteSshPrivateKey')}
              <textarea ref={keyText} name="key" required maxLength={24000} autoCapitalize="none" autoComplete="off" spellCheck={false} disabled={busy} />
            </label>
            <label className={styles.field}>{t('remoteSshImportKey')}
              <input type="file" disabled={busy} onChange={(event) => {
                const file = event.currentTarget.files?.[0]
                const textarea = keyText.current
                event.currentTarget.value = ''
                if (!file || !textarea) return
                setLocalError('')
                if (file.size > 24000) {
                  setLocalError(t('remoteSshKeyTooLarge'))
                  return
                }
                void file.text().then((key) => {
                  if (keyText.current === textarea) textarea.value = key
                }).catch(() => setLocalError(t('remoteSshKeyUnreadable')))
              }} />
            </label>
            <label className={styles.field}>{t('remoteSshPassphrase')}
              <input type="password" name="passphrase" autoComplete="off" maxLength={1024} disabled={busy} />
            </label>
          </>
        )}
        <label className={styles.field}>{t('remoteSshWebMode')}
          <select value={mode} onChange={(event) => setMode(event.target.value === 'attach' ? 'attach' : 'managed')} disabled={busy}>
            <option value="managed">{t('remoteSshManaged')}</option>
            <option value="attach">{t('remoteSshAttach')}</option>
          </select>
        </label>
        {mode === 'attach' && (
          <div className={styles.sshFields}>
            <label className={styles.field}>{t('remoteSshWebPort')}
              <input type="number" name="remotePort" required defaultValue={profile?.remotePort ?? 3080} min={1} max={65535} disabled={busy} />
            </label>
            <label className={styles.field}>{t('remoteSshLaunchToken')}
              <input name="launchToken" type="password" required autoComplete="off" maxLength={2048} disabled={busy} />
            </label>
          </div>
        )}
        <label><input type="checkbox" name="remember" disabled={busy} /> {' '}{t('remoteSshRememberCredentials')}</label>
        </>}
        {error && <p role="alert" className={styles.status}>{t('remoteSshConnectError')} ({error.code})</p>}
        {localError && <p role="alert">{localError}</p>}
        {forget && <section className={styles.status}>
          <p>{t('remoteSshForgetConfirm')}</p>
          <div className={styles.actions}>
            <Button type="button" variant="danger" disabled={busy} onClick={() => void removeProfile()}>{t('remoteSshForget')}</Button>
            <Button type="button" variant="outlined" disabled={busy} onClick={() => setForget(false)}>{t('cancel')}</Button>
          </div>
        </section>}
        <div className={styles.actions}>
          <Button type="submit" variant="primary" disabled={busy}>{t(busy ? 'remoteSshConnecting' : 'remoteSshConnect')}</Button>
          <Button type="button" variant="outlined" onClick={close}>{t('cancel')}</Button>
          {profile && !forget && <Button type="button" variant="outlined" disabled={busy} onClick={() => setForget(true)}>
            {t('remoteSshForget')}
          </Button>}
        </div>
      </form>
      </div>
    </Modal>
  )
}
