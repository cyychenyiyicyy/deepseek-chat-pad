import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import { hostHttpTarget } from '../../services/remote/hostHttpActions.js'
import {
  cancelHostPluginInstall, HostPluginBuildsRequired, HostPluginOperationError, installHostPlugin,
  recoverHostPluginInstall, relayPluginInstallCommand, removeHostPlugin, type HostPlugin,
} from '../../services/remote/pluginManager.js'
import { fetchPluginMarket, verifyPluginIntegrity, type MarketPackage } from '../../services/remote/pluginMarket.js'
import { describeRemoteError, lastRemoteTarget, type RemoteCallTarget } from '../../services/remote/sessionsApi.js'
import { remoteDraftOwner } from '../../services/remote/store.js'
import { Button } from '../base/Button.js'
import { CopyButton } from '../messages/CopyButton.js'
import styles from './RemoteManagementDialog.module.css'

function savedInstall(key: string) {
  try {
    const value = sessionStorage.getItem(key)
    return value && /^[A-Za-z0-9-]{36}$/u.test(value) ? value : ''
  } catch { return '' }
}

export default function HostPluginMarket({ target, installed, onChange }: {
  target: RemoteCallTarget
  installed: HostPlugin[]
  onChange(): void
}) {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const [owner] = useState(() => remoteDraftOwner())
  const storageKey = 'dsp.remote.plugin-install.v1:' + owner
  const [catalog, setCatalog] = useState<MarketPackage[] | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [search, setSearch] = useState('')
  const [tier, setTier] = useState('')
  const [selection, setSelection] = useState<MarketPackage | null>(null)
  const [builds, setBuilds] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [operation, setOperation] = useState<'checking' | 'installing' | 'recovering' | null>(null)
  const http = hostHttpTarget(target)
  const [requestId, setRequestId] = useState(() => owner && http ? savedInstall(storageKey) : '')
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const mounted = useRef(false)
  const active = () => mounted.current && lastRemoteTarget() === target
  const confirmation = selection && !requestId && !operation
  const command = confirmation && !http ? relayPluginInstallCommand(selection) : undefined
  const installedBundles = new Map(installed.filter((item) => item.kind === 'bundle').map((item) => [item.id, item]))
  const visible = catalog?.filter((item) => (!tier || item.tier === tier) &&
    [item.title, item.name, item.summary, item.category].some((value) => value.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())))

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void fetchPluginMarket(locale, controller.signal).then((rows) => {
      if (!controller.signal.aborted) setCatalog(rows)
    }, (failure: unknown) => {
      if (!controller.signal.aborted) setError(describeRemoteError(failure).text)
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [refresh, locale])

  function remember(id: string) {
    if (owner) {
      try {
        if (id) sessionStorage.setItem(storageKey, id)
        else sessionStorage.removeItem(storageKey)
      } catch { /* Storage may be unavailable. */ }
    }
    if (active()) setRequestId(id)
  }

  async function install(item: MarketPackage) {
    if (!http || operation || requestId || !active()) return
    setError('')
    setNotice('')
    setOperation('checking')
    let id = ''
    try {
      await verifyPluginIntegrity(item, AbortSignal.timeout(15_000))
      if (!active()) return
      const installed = installedBundles.get(item.name)
      if (installed && !builds.length) {
        await removeHostPlugin(http, installed)
        if (!active()) return
        onChange()
      }
      id = crypto.randomUUID()
      remember(id)
      setOperation('installing')
      const result = await installHostPlugin(http, item, id, builds)
      remember('')
      if (active()) {
        setNotice(t('remotePluginResult', { result }))
        setSelection(null)
        setBuilds([])
        onChange()
      }
    } catch (failure) {
      if (active()) {
        if (failure instanceof HostPluginBuildsRequired) {
          remember('')
          setBuilds(failure.packages)
        } else if (failure instanceof HostPluginOperationError) {
          remember('')
          setError(describeRemoteError(failure).text)
          onChange()
        } else {
          setError(id ? t('remotePluginInstallUnknown') : describeRemoteError(failure).text)
          if (id) setSelection(null)
        }
      }
    } finally {
      if (active()) setOperation(null)
    }
  }

  async function recover() {
    if (!http || !requestId || operation) return
    setOperation('recovering')
    setError('')
    setNotice('')
    try {
      const result = await recoverHostPluginInstall(http, requestId)
      remember('')
      if (active()) {
        setNotice(result ? t('remotePluginResult', { result }) : t('remotePluginInstallEnded'))
        onChange()
      }
    } catch (failure) {
      if (active()) {
        if (failure instanceof HostPluginOperationError || failure instanceof HostPluginBuildsRequired) {
          remember('')
          onChange()
        }
        setError(describeRemoteError(failure).text)
      }
    } finally {
      if (active()) setOperation(null)
    }
  }

  async function cancel() {
    if (!http || !requestId || cancelling) return
    setCancelling(true)
    setError('')
    try {
      const result = await cancelHostPluginInstall(http, requestId)
      if (!active()) return
      setNotice(t('remotePluginResult', { result }))
      if (result === 'cancelled') {
        remember('')
        onChange()
      }
    } catch (failure) {
      if (active()) setError(describeRemoteError(failure).text)
    } finally {
      if (active()) setCancelling(false)
    }
  }

  return <div className={styles.layout} aria-busy={loading || Boolean(operation)}>
    <div className={styles.actions}>
      <Button variant="outlined" size="m" disabled={loading} onClick={() => {
        setError('')
        setLoading(true)
        setRefresh((value) => value + 1)
      }}>{t('remotePluginsRefresh')}</Button>
      {requestId && <>
        <Button variant="outlined" size="m" disabled={Boolean(operation) || cancelling} onClick={() => void recover()}>
          {t('remotePluginInstallCheck')}
        </Button>
        <Button variant="outlined" size="m" disabled={cancelling} onClick={() => void cancel()}>
          {t('remotePluginInstallCancel')}
        </Button>
      </>}
    </div>
    {operation && <p role="status">{t('remotePluginWorking')}</p>}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {confirmation && <section className={styles.status}>
      <p>{command ? t('remotePluginRunOnHost') : t('remotePluginInstallPrompt', { name: selection.title, version: selection.version })}</p>
      {selection.flags.length > 0 && <p>{selection.flags.join(' · ')}</p>}
      {builds.length > 0 && <p>{t('remotePluginBuildsRequired', { packages: builds.join(', ') })}</p>}
      <div className={styles.actions}>
        {command && <><code>{command}</code><CopyButton text={command} /></>}
        {http && <Button variant="primary" size="m" onClick={() => void install(selection)}>
          {t(builds.length ? 'remotePluginBuildsApprove' : 'remotePluginInstallConfirm')}
        </Button>}
        <Button variant="outlined" size="m" onClick={() => { setBuilds([]); setSelection(null) }}>{t('cancel')}</Button>
      </div>
    </section>}
    <div className={styles.sshFields}>
      <label className={styles.field}>{t('remotePluginCatalogGroup')}
        <select value={tier} onChange={(event) => setTier(event.target.value)}>
          <option value="">{t('remotePluginCatalogAll')}</option>
          <option value="official">{t('remotePluginCatalogOfficial')}</option>
          <option value="community">{t('remotePluginCatalogCommunity')}</option>
        </select>
      </label>
      <label className={styles.field}>{t('remotePluginSearch')}
        <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} />
      </label>
    </div>
    {visible?.length === 0 && <p>{t('remotePluginsEmpty')}</p>}
    {visible?.map((item) => {
      const current = installedBundles.get(item.name)
      const installedVersion = current?.version
      const withdrawn = installedVersion && item.blocked.includes(installedVersion)
      return <div className={styles.row} key={item.name}>
        <div>
          <strong>{item.title}</strong>
          <small>{item.name} · {item.version}{item.category && ' · ' + item.category}</small>
          {item.summary && <small>{item.summary}</small>}
          {installedVersion && <small>{t('remotePluginInstalledVersion', { version: installedVersion })}</small>}
          {withdrawn && <small role="status">{t('remotePluginWithdrawn')}</small>}
          {item.requiresApp && <small>{t('remotePluginRequiresApp', { version: item.requiresApp })}</small>}
        </div>
        {item.spec && item.version !== installedVersion && (http ? !current || current.removable : relayPluginInstallCommand(item)) && <Button variant="outlined" size="m"
          disabled={Boolean(operation || requestId || selection)} onClick={() => setSelection(item)}>
          {t(http ? current ? 'remotePluginUpdate' : 'remotePluginInstall' : 'remotePluginInstallCommand')}
        </Button>}
      </div>
    })}
  </div>
}
