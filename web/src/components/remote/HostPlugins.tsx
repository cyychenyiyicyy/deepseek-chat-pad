import { lazy, Suspense, useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { hostHttpTarget } from '../../services/remote/hostHttpActions.js'
import { listHostPlugins, relayPluginRemoveCommand, removeHostPlugin, setHostPluginEnabled, type HostPlugin } from '../../services/remote/pluginManager.js'
import { describeRemoteError, lastRemoteTarget, type RemoteCallTarget } from '../../services/remote/sessionsApi.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { CopyButton } from '../messages/CopyButton.js'
import styles from './RemoteManagementDialog.module.css'

const HostPluginMarket = lazy(() => import('./HostPluginMarket.js'))

interface Props {
  target: RemoteCallTarget
  onClose: () => void
}

export default function HostPlugins({ target, onClose }: Props) {
  const t = useTranslate()
  const [plugins, setPlugins] = useState<HostPlugin[] | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [application, setApplication] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [marketOpen, setMarketOpen] = useState(false)
  const [remove, setRemove] = useState<HostPlugin | null>(null)
  const [command, setCommand] = useState('')
  const http = hostHttpTarget(target)

  useEffect(() => {
    let active = true
    void listHostPlugins(target).then((rows) => {
      if (active) setPlugins(rows)
    }, (failure: unknown) => {
      if (active) setError(describeRemoteError(failure).text)
    }).finally(() => {
      if (active) setBusy(false)
    })
    return () => { active = false }
  }, [refresh, target])

  async function toggle(plugin: HostPlugin) {
    if (busy) return
    setBusy(true)
    setError('')
    setApplication('')
    try {
      const result = await setHostPluginEnabled(target, plugin, !plugin.enabled)
      setApplication(result)
      setPlugins(null)
      setRefresh((revision) => revision + 1)
    } catch (failure) {
      setError(describeRemoteError(failure).text)
      // The result may have been lost after the Host received the request.
      setPlugins(null)
      setBusy(false)
    }
  }

  async function confirmRemoval() {
    if (!http || !remove || busy || lastRemoteTarget() !== target) return
    setBusy(true)
    setError('')
    setApplication('')
    try {
      setApplication(await removeHostPlugin(http, remove))
    } catch (failure) {
      setError(describeRemoteError(failure).text)
    } finally {
      setRemove(null)
      setPlugins(null)
      setRefresh((revision) => revision + 1)
    }
  }

  return (
    <Modal expanded title={t('remoteHostPlugins')} onClose={onClose} closable className={styles.modal} mainClassName={styles.body}>
      <div className={styles.layout} aria-busy={busy}>
        <div className={styles.actions}>
          {!marketOpen && <Button variant="outlined" size="m" disabled={busy} onClick={() => {
            setBusy(true)
            setError('')
            setRefresh((revision) => revision + 1)
          }}>{t('remotePluginsRefresh')}</Button>}
          {<Button variant="outlined" size="m" disabled={Boolean(remove)} aria-pressed={marketOpen}
            onClick={() => setMarketOpen((visible) => !visible)}>
            {t(marketOpen ? 'remotePluginInventory' : 'remotePluginMarket')}
          </Button>}
        </div>
        {marketOpen && <Suspense fallback={<p role="status">{t('workspacePaneLoading')}</p>}>
          <HostPluginMarket target={target} installed={plugins ?? []}
            onChange={() => setRefresh((revision) => revision + 1)} />
        </Suspense>}
        {!marketOpen && <>
        {error && <div role="alert">{error}</div>}
        {application && <div role="status">{t('remotePluginResult', { result: application })}</div>}
        {command && <section className={styles.status}>
          <p>{t('remotePluginRunOnHost')}</p>
          <div className={styles.actions}><code>{command}</code><CopyButton text={command} /></div>
        </section>}
        {remove && <section className={styles.status}>
          <p>{t('remotePluginRemovePrompt', { name: remove.label })}</p>
          <div className={styles.actions}>
            <Button variant="danger" size="m" disabled={busy} onClick={() => void confirmRemoval()}>{t('remotePluginRemove')}</Button>
            <Button variant="outlined" size="m" disabled={busy} onClick={() => setRemove(null)}>{t('cancel')}</Button>
          </div>
        </section>}
        {plugins?.length === 0 && <p>{t('remotePluginsEmpty')}</p>}
        {(['bundle', 'plugin'] as const).map((kind) => {
          const rows = plugins?.filter((plugin) => plugin.kind === kind) ?? []
          if (rows.length === 0) return null
          return (
            <section key={kind} className={styles.section}>
              <h3>{t(kind === 'bundle' ? 'remotePluginBundles' : 'remotePluginEntries')}</h3>
              {rows.map((plugin) => (
                <div className={styles.row} key={plugin.id}>
                  <div>
                    {plugin.label}
                    <small>{t(plugin.enabled ? 'remotePluginOn' : 'remotePluginOff')}</small>
                  </div>
                  <div className={styles.actions}>
                    {plugin.readOnly ? <small>{t('remotePluginReadOnly')}</small> : (
                      <Button variant="outlined" size="m" disabled={busy || Boolean(remove)} onClick={() => void toggle(plugin)}>
                        {t(plugin.enabled ? 'remotePluginDisable' : 'remotePluginEnable')}
                      </Button>
                    )}
                    {http && plugin.removable && <Button variant="outlined" size="m" disabled={busy || Boolean(remove)}
                      onClick={() => setRemove(plugin)}>{t('remotePluginRemove')}</Button>}
                    {!http && relayPluginRemoveCommand(plugin) && <Button variant="outlined" size="m" disabled={busy}
                      onClick={() => setCommand(relayPluginRemoveCommand(plugin) ?? '')}>{t('remotePluginRemoveCommand')}</Button>}
                  </div>
                </div>
              ))}
            </section>
          )
        })}
        </>}
      </div>
    </Modal>
  )
}
