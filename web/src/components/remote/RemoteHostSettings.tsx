import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import { hostHttpTarget } from '../../services/remote/hostHttpActions.js'
import {
  describeHostCredential, describeHostSettings, discoverHostModels, listHostModelRoutes, mutateHostSettings,
  setHostCredential, settingsFields, validCredentialRef, validProviderRoute,
  type HostModelRoute, type HostSettingsSection, type SettingField, type SettingsOperation,
} from '../../services/remote/hostSettings.js'
import { listPluginConfig, readPluginConfig, writePluginConfig, type PluginConfig, type PluginConfigSummary } from '../../services/remote/pluginConfig.js'
import { describeRemoteError, lastRemoteTarget, type RemoteCallTarget } from '../../services/remote/sessionsApi.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import styles from './RemoteManagementDialog.module.css'

const MODEL_SECTION = 'llm-pi-ai'
const APIS = ['openai-completions', 'openai-responses', 'anthropic-messages']
type Save = (...operations: SettingsOperation[]) => Promise<void>

export default function RemoteHostSettings({ target, mode, onClose }: {
  target: RemoteCallTarget; mode: 'configuration' | 'providers'; onClose: () => void
}) {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const [sections, setSections] = useState<HostSettingsSection[] | null>(null)
  const [configEntries, setConfigEntries] = useState<PluginConfigSummary[] | null>(null)
  const [pluginConfig, setPluginConfig] = useState<PluginConfig | null>(null)
  const [selected, setSelected] = useState('')
  const [routes, setRoutes] = useState<HostModelRoute[]>([])
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [fieldEdit, setFieldEdit] = useState<SettingField | null>(null)
  const [routeEdit, setRouteEdit] = useState<HostModelRoute | 'new' | null>(null)
  const [editingOverrides, setEditingOverrides] = useState(false)
  const [credential, setCredential] = useState('')
  const mounted = useRef(false)
  const running = useRef(false)
  const current = () => mounted.current && lastRemoteTarget() === target
  const http = mode === 'configuration' ? hostHttpTarget(target) : null
  const section = sections?.find((item) => item.ns === (mode === 'providers' ? MODEL_SECTION : selected))
  const config = configEntries ? pluginConfig : section
  const fields = config && mode === 'configuration' ? settingsFields(config, locale) : []
  const credentials = pluginConfig?.secrets.filter((slot) => slot.writable && slot.credentialRef && validCredentialRef(slot.credentialRef)) ?? []
  const route = routes.find((item) => item.route === selected)

  async function selectPlugin(entries: PluginConfigSummary[], id: string) {
    setSelected(id)
    setPluginConfig(null)
    if (!http || !entries.some((entry) => entry.entryId === id && entry.configurable)) return
    const next = await readPluginConfig(http, id)
    if (current()) setPluginConfig(next)
  }

  async function refresh() {
    if (http) {
      const entries = await listPluginConfig(http, locale)
      if (!current()) return
      setConfigEntries(entries)
      if (entries) {
        const next = entries.find((entry) => entry.entryId === selected) ?? entries.find((entry) => entry.configurable) ?? entries[0]
        await selectPlugin(entries, next?.entryId ?? '')
        return
      }
      setPluginConfig(null)
    }
    const next = await describeHostSettings(target)
    if (!current()) return
    setSections(next)
    if (mode === 'configuration') {
      setSelected((id) => next.some((row) => row.ns === id) ? id : next[0]?.ns ?? '')
      return
    }
    const catalog = await listHostModelRoutes(target, next.find((item) => item.ns === MODEL_SECTION))
    if (!current()) return
    setRoutes(catalog)
    setSelected((id) => catalog.some((row) => row.route === id) ? id : catalog[0]?.route ?? '')
  }

  async function run(job: () => Promise<void>) {
    if (!current() || running.current) return
    running.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await job()
    } catch (failure) {
      if (current()) setError(describeRemoteError(failure).text)
    } finally {
      running.current = false
      if (current()) setBusy(false)
    }
  }

  useEffect(() => {
    mounted.current = true
    void run(refresh)
    return () => { mounted.current = false }
  }, [target, mode])

  const save: Save = (...operations) => run(async () => {
    if (http && configEntries && pluginConfig) {
      try {
        const next = await writePluginConfig(http, pluginConfig, operations)
        if (!current()) return
        setPluginConfig(next)
        setFieldEdit(null)
        setNotice(t('remoteHostSettingSaved'))
      } catch (failure) {
        if (current()) {
          setFieldEdit(null)
          await selectPlugin(configEntries, pluginConfig.ns).catch(() => undefined)
        }
        throw failure
      }
      return
    }
    if (!section) return
    const next = await mutateHostSettings(target, section, operations)
    if (!current()) return
    setSections((items) => items?.map((item) => item.ns === next.ns ? next : item) ?? [next])
    setFieldEdit(null)
    setRouteEdit(null)
    setEditingOverrides(false)
    setNotice(t('remoteHostSettingSaved'))
    await refresh()
  })

  return (
    <Modal expanded title={t(mode === 'configuration' ? 'remoteHostConfiguration' : 'remoteHostModels')}
      onClose={onClose} closable className={styles.modal} mainClassName={styles.body}>
      <div className={styles.layout} aria-busy={busy}>
        {error && <div role="alert">{error}</div>}
        {notice && <p role="status">{notice}</p>}
        {sections === null && busy && <p role="status">{t('workspacePaneLoading')}</p>}
        {credential && <CredentialEditor target={target} initialRef={credential} fixedRef={configEntries !== null} onBack={() => {
          setCredential('')
          if (configEntries) void run(() => selectPlugin(configEntries, selected))
        }} />}
        {fieldEdit && <FieldEditor field={fieldEdit} busy={busy} onSave={save} onBack={() => setFieldEdit(null)} />}
        {routeEdit && <RouteEditor target={target} route={routeEdit} busy={busy} onSave={save} onBack={() => setRouteEdit(null)} />}
        {editingOverrides && route && <ModelOverrideEditor route={route} target={target}
          busy={busy} onSave={save} onBack={() => setEditingOverrides(false)} />}
        {!credential && !fieldEdit && !routeEdit && !editingOverrides && <>
          <div className={styles.actions}>
            <Button variant="outlined" size="m" disabled={busy} onClick={() => void run(refresh)}>{t('remoteTerminalRefresh')}</Button>
            {mode === 'providers' && <>
              <Button variant="primary" size="m" disabled={busy || !section?.writable} onClick={() => setRouteEdit('new')}>{t('remoteHostModelNew')}</Button>
              <Button variant="outlined" size="m" disabled={busy} onClick={() => setCredential(route?.credentialRef ?? 'DEEPSEEK_API_KEY')}>
                {t('remoteHostCredentials')}
              </Button>
            </>}
          </div>
          <label className={styles.field}>{t(mode === 'configuration' ? 'remoteHostNamespace' : 'remoteHostModelRoute')}
            <select value={selected} disabled={busy} onChange={(event) => {
              const id = event.target.value
              if (configEntries) void run(() => selectPlugin(configEntries, id))
              else setSelected(id)
            }}>
              {!selected && <option value="">{t('remoteHostSettingsEmpty')}</option>}
              {mode === 'configuration'
                ? configEntries
                  ? configEntries.map((entry) => <option key={entry.entryId} value={entry.entryId}>{entry.label}</option>)
                  : sections?.map((item) => <option key={item.ns} value={item.ns}>{item.ns}</option>)
                : routes.map((item) => <option key={item.route} value={item.route}>{item.label}</option>)}
            </select>
          </label>
          {fields.map((field) => {
            const credentialRef = credentials.find((slot) => JSON.stringify(slot.path) === JSON.stringify(field.path))?.credentialRef
            return (
            <div className={styles.row} key={JSON.stringify(field.path)}>
              <div>
                {field.label}
                {field.description && <small>{field.description}</small>}
                <small>{field.type === 'secret' ? t(field.configured ? 'remoteHostCredentialSet' : 'remoteHostCredentialMissing')
                  : field.value === undefined ? '—' : JSON.stringify(field.value)}</small>
              </div>
              {credentialRef && <Button variant="outlined" size="m" disabled={busy}
                onClick={() => setCredential(credentialRef)}>{t('remoteHostCredentials')}</Button>}
              {field.type !== 'secret' && <Button variant="outlined" size="m" disabled={busy || field.readOnly}
                onClick={() => setFieldEdit(field)}>{t('remoteHostEditSetting')}</Button>}
            </div>
            )
          })}
          {mode === 'configuration' && (config || configEntries) && !busy && !fields.length && <p>{t('remoteHostSettingsEmpty')}</p>}
          {mode === 'providers' && route && <div className={styles.section}>
            {route.baseURL && <p className={styles.path}>{route.baseURL}</p>}
            {route.api && <p>{route.api}</p>}
            <div className={styles.actions}>
              <Button variant="outlined" size="m" disabled={busy || !section?.writable}
                onClick={() => setRouteEdit(route)}>{t('remoteHostEditSetting')}</Button>
              <Button variant="outlined" size="m" disabled={busy || !section?.writable}
                onClick={() => setEditingOverrides(true)}>{t('remoteHostModelOverrides')}</Button>
            </div>
          </div>}
        </>}
      </div>
    </Modal>
  )
}

const positiveInteger = (value: string) => !value.trim() || (/^\d+$/u.test(value) &&
  Number.isSafeInteger(Number(value)) && Number(value) > 0)

function ModelOverrideEditor({ target, route, busy, onSave, onBack }: {
  target: RemoteCallTarget; route: HostModelRoute; busy: boolean; onSave: Save; onBack: () => void
}) {
  const t = useTranslate()
  const [modelId, setModelId] = useState('')
  const [discovered, setDiscovered] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const id = modelId.trim()
  const providerModels = Array.isArray(route.profile?.models) ? route.profile.models : []
  const choices = [...new Set([
    ...Object.keys(route.modelOverrides),
    ...providerModels.flatMap((model) => typeof model?.id === 'string' ? [model.id] : []),
    ...discovered,
  ])]
  const stored = Object.hasOwn(route.modelOverrides, id) ? route.modelOverrides[id] : undefined
  const override = stored !== null && typeof stored === 'object' && !Array.isArray(stored)
    ? stored as Record<string, unknown> : {}
  const path = ['providers', route.route, 'modelOverrides']
  const validId = id.length > 0 && !['__proto__', 'constructor', 'prototype'].includes(id)
  const remove = route.ownedModelOverrides.includes(id) ? () => {
    void onSave({ op: 'unset', path: route.ownedModelOverrides.length === 1 ? path : [...path, id] })
  } : undefined

  return <section className={styles.section} aria-label={t('remoteHostModelOverrides')}>
    <label className={styles.field}>{t('remoteHostModelId')}
      <input value={modelId} disabled={busy} list="remote-override-models" maxLength={256}
        onChange={(event) => setModelId(event.currentTarget.value)} />
    </label>
    <datalist id="remote-override-models">
      {choices.map((choice) => <option key={choice} value={choice} />)}
    </datalist>
    <div className={styles.actions}>
      <Button variant="outlined" size="m" disabled={loading || busy} onClick={() => {
        setLoading(true)
        setError('')
        void discoverHostModels(target, route.route).then(setDiscovered, (failure) => setError(describeRemoteError(failure).text))
          .finally(() => setLoading(false))
      }}>{t('remoteHostDiscoverModels')}</Button>
      <Button variant="outlined" size="m" disabled={busy} onClick={onBack}>{t('cancel')}</Button>
    </div>
    {error && <p role="alert">{error}</p>}
    {validId && <ModelOverrideFields key={id} previous={override} disabled={busy}
      onSave={(value) => void onSave({ op: 'set', path: [...path, id], value })} onReset={remove} />}
  </section>
}

function ModelOverrideFields({ previous, disabled, onSave, onReset }: {
  previous: Record<string, unknown>; disabled: boolean
  onSave: (value: Record<string, unknown>) => void; onReset?: () => void
}) {
  const t = useTranslate()
  const initialName = typeof previous.name === 'string' ? previous.name : ''
  const initialContext = typeof previous.contextWindow === 'number' ? String(previous.contextWindow) : ''
  const initialOutput = typeof previous.maxTokens === 'number' ? String(previous.maxTokens) : ''
  const initialInput = Array.isArray(previous.input) && previous.input.includes('image') ? 'image'
    : Array.isArray(previous.input) && previous.input.includes('text') ? 'text' : ''
  const [name, setName] = useState(initialName)
  const [context, setContext] = useState(initialContext)
  const [output, setOutput] = useState(initialOutput)
  const [input, setInput] = useState(initialInput)
  const next = { ...previous }
  for (const [field, value, initial, nextValue] of [
    ['name', name, initialName, name.trim()],
    ['contextWindow', context, initialContext, Number(context)],
    ['maxTokens', output, initialOutput, Number(output)],
    ['input', input, initialInput, input === 'image' ? ['text', 'image'] : ['text']],
  ] as const) {
    if (value === initial) continue
    if (value.trim()) next[field] = nextValue
    else delete next[field]
  }
  const canSave = !disabled && positiveInteger(context) && positiveInteger(output) && Object.keys(next).length > 0 &&
    JSON.stringify(next) !== JSON.stringify(previous)
  return <form className={styles.layout} onSubmit={(event) => {
    event.preventDefault()
    if (canSave) onSave(next)
  }}>
    <label className={styles.field}>{t('remoteHostModelLabel')}
      <input value={name} disabled={disabled} onChange={(event) => setName(event.currentTarget.value)} />
    </label>
    <label className={styles.field}>{t('remoteHostModelContext')}
      <input inputMode="numeric" value={context} disabled={disabled} onChange={(event) => setContext(event.currentTarget.value)} />
    </label>
    <label className={styles.field}>{t('remoteHostModelOutput')}
      <input inputMode="numeric" value={output} disabled={disabled} onChange={(event) => setOutput(event.currentTarget.value)} />
    </label>
    <label className={styles.field}>{t('remoteHostModelInput')}
      <select value={input} disabled={disabled} onChange={(event) => setInput(event.currentTarget.value)}>
        <option value="">{t('newSessionAgentPresetInherit')}</option>
        <option value="text">{t('remoteHostModelText')}</option>
        <option value="image">{t('remoteHostModelTextImage')}</option>
      </select>
    </label>
    <div className={styles.actions}>
      <Button type="submit" variant="primary" size="m" disabled={!canSave}>{t('remoteScheduleSave')}</Button>
      {onReset && <Button variant="outlined" size="m" disabled={disabled}
        onClick={onReset}>{t('remoteHostResetSetting')}</Button>}
    </div>
  </form>
}

function FieldEditor({ field, busy, onSave, onBack }: {
  field: SettingField; busy: boolean; onSave: Save; onBack: () => void
}) {
  const t = useTranslate()
  const [draft, setDraft] = useState(() => field.value === undefined ? ''
    : field.type === 'text' ? String(field.value) : JSON.stringify(field.value, null, 2))
  let value: unknown
  let valid = true
  try {
    value = field.type === 'text' ? draft : JSON.parse(draft)
    if (field.type === 'number') valid = typeof value === 'number' && Number.isFinite(value)
    if (field.type === 'json') valid = Array.isArray(value)
  } catch {
    valid = false
  }
  const options = field.type === 'boolean' ? [true, false] : field.options
  return <form className={styles.layout} onSubmit={(event) => {
    event.preventDefault()
    if (valid) void onSave({ op: 'set', path: field.path, value })
  }}>
    <label className={styles.field}>{field.label}
      {options ? <select value={draft} disabled={busy} onChange={(event) => setDraft(event.target.value)}>
        {!options.some((option) => JSON.stringify(option) === draft) && <option value="">—</option>}
        {options.map((option) => <option value={JSON.stringify(option)} key={JSON.stringify(option)}>
          {typeof option === 'boolean' ? t(option ? 'remotePluginOn' : 'remotePluginOff') : String(option)}
        </option>)}
      </select> : <textarea value={draft} disabled={busy} onChange={(event) => setDraft(event.target.value)} />}
    </label>
    <div className={styles.actions}>
      <Button type="submit" variant="primary" size="m" disabled={busy || !valid}>{t('remoteScheduleSave')}</Button>
      {field.override && <Button variant="outlined" size="m" disabled={busy}
        onClick={() => void onSave({ op: 'unset', path: field.path })}>{t('remoteHostResetSetting')}</Button>}
      <Button variant="outlined" size="m" disabled={busy} onClick={onBack}>{t('cancel')}</Button>
    </div>
  </form>
}

function RouteEditor({ target, route, busy, onSave, onBack }: {
  target: RemoteCallTarget; route: HostModelRoute | 'new'; busy: boolean; onSave: Save; onBack: () => void
}) {
  const t = useTranslate()
  const prior = route === 'new' ? undefined : route
  const [name, setName] = useState(prior?.route ?? '')
  const [label, setLabel] = useState(prior?.label ?? '')
  const [api, setApi] = useState(prior ? prior.api ?? '' : APIS[0]!)
  const [url, setUrl] = useState(prior?.baseURL ?? '')
  const [ref, setRef] = useState(prior?.credentialRef ?? '')
  const [models, setModels] = useState(() => JSON.stringify(prior?.profile?.models ?? [], null, 2))
  const [discovering, setDiscovering] = useState(false)
  const [found, setFound] = useState<string[] | null>(null)
  const [error, setError] = useState('')
  const [confirmReset, setConfirmReset] = useState(false)
  let modelList: unknown
  let base: URL | undefined
  try { modelList = JSON.parse(models) } catch { modelList = null }
  try { base = new URL(url) } catch { base = undefined }
  const validUrl = base && (base.protocol === 'https:' || base.protocol === 'http:') && !base.username && !base.password
  const validModels = Array.isArray(modelList) && modelList.every((model: unknown) =>
    model !== null && typeof model === 'object' && 'id' in model && typeof model.id === 'string' && model.id.trim())
  const valid = validProviderRoute(name) && validCredentialRef(ref) && validModels &&
    (prior ? (url === '' || validUrl) : validUrl && (modelList as unknown[]).length > 0)
  const path = ['providers', name]
  const deriveRef = (id: string) => id.toUpperCase().replaceAll('-', '_') + '_API_KEY'
  const profile = { displayName: label.trim(), api, baseURL: url.trim(), apiKeyEnv: ref, models: modelList }
  const changes: SettingsOperation[] = []
  if (prior) {
    const initial = {
      displayName: prior.label,
      api: prior.api ?? '',
      baseURL: prior.baseURL ?? '',
      apiKeyEnv: prior.credentialRef,
      models: prior.profile?.models ?? [],
    }
    for (const field of Object.keys(initial) as Array<keyof typeof initial>) {
      const value = profile[field]
      if (JSON.stringify(value) === JSON.stringify(initial[field])) continue
      changes.push(value === '' ? { op: 'unset', path: [...path, field] } : { op: 'set', path: [...path, field], value })
    }
  }

  return <form className={styles.layout} onSubmit={(event) => {
    event.preventDefault()
    if (!valid) return
    if (prior) {
      if (changes.length) void onSave(...changes)
      return
    }
    void onSave({ op: 'set', path, value: { ...profile, displayName: profile.displayName || name } })
  }}>
    <label className={styles.field}>{t('remoteHostModelRoute')}
      <input disabled={busy || prior !== undefined} value={name} required onChange={(event) => {
        if (!ref || ref === deriveRef(name)) setRef(deriveRef(event.target.value))
        setName(event.target.value)
      }} />
    </label>
    <label className={styles.field}>{t('remoteHostModelLabel')}<input value={label} disabled={busy} onChange={(event) => setLabel(event.target.value)} /></label>
    <label className={styles.field}>{t('remoteHostModelProtocol')}
      <select value={api} disabled={busy} onChange={(event) => setApi(event.target.value)}>
        {prior && <option value="">—</option>}
        {[...new Set([...APIS, ...(prior?.api ? [prior.api] : [])])].map((entry) => <option key={entry}>{entry}</option>)}
      </select>
    </label>
    <label className={styles.field}>Base URL<input type="url" disabled={busy} value={url} onChange={(event) => setUrl(event.target.value)} /></label>
    <label className={styles.field}>{t('remoteHostCredentialRef')}<input disabled={busy} required value={ref} onChange={(event) => setRef(event.target.value)} /></label>
    <label className={styles.field}>{t('remoteHostModelList')}<textarea disabled={busy} value={models} onChange={(event) => setModels(event.target.value)} /></label>
    {prior && <div className={styles.section}>
      <Button variant="outlined" size="m" disabled={discovering || busy} onClick={() => {
        setDiscovering(true)
        setError('')
        void discoverHostModels(target, prior.route).then(setFound, (failure) => setError(describeRemoteError(failure).text))
          .finally(() => setDiscovering(false))
      }}>{t('remoteHostDiscoverModels')}</Button>
      {found && <p className={styles.path}>{found.join(', ') || t('remoteHostSettingsEmpty')}</p>}
    </div>}
    {error && <p role="alert">{error}</p>}
    {confirmReset && <p>{t('remoteHostModelResetConfirm')}</p>}
    <div className={styles.actions}>
      <Button variant="primary" type="submit" size="m" disabled={!valid || busy || (!!prior && !changes.length)}>{t('remoteScheduleSave')}</Button>
      {prior?.override && <Button variant="outlined" size="m" disabled={busy} onClick={() => {
        if (confirmReset) void onSave({ op: 'unset', path })
        else setConfirmReset(true)
      }}>{t('remoteHostResetSetting')}</Button>}
      <Button variant="outlined" size="m" disabled={busy} onClick={onBack}>{t('cancel')}</Button>
    </div>
  </form>
}

function CredentialEditor({ target, initialRef, fixedRef = false, onBack }: {
  target: RemoteCallTarget; initialRef: string; fixedRef?: boolean; onBack: () => void
}) {
  const t = useTranslate()
  const [ref, setRef] = useState(initialRef)
  const [secret, setSecret] = useState('')
  const [status, setStatus] = useState<Awaited<ReturnType<typeof describeHostCredential>> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState(false)
  const valid = validCredentialRef(ref)
  const inFlight = useRef(false)

  useEffect(() => {
    let active = true
    if (!valid) return
    const timer = setTimeout(() => {
      void describeHostCredential(target, ref).then((value) => {
        if (active) setStatus(value)
      }, (failure) => {
        if (active) setError(describeRemoteError(failure).text)
      })
    }, 200)
    return () => { active = false; clearTimeout(timer) }
  }, [ref, target, valid])

  async function save(value?: string) {
    if (!valid || !status?.writable || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError('')
    setConfirm(false)
    try {
      await setHostCredential(target, ref, value)
      setSecret('')
      setStatus(await describeHostCredential(target, ref))
    } catch (failure) {
      setError(describeRemoteError(failure).text)
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return <form className={styles.layout} onSubmit={(event) => {
    event.preventDefault()
    if (secret.trim()) void save(secret)
  }}>
    <label className={styles.field}>{t('remoteHostCredentialRef')}
      <input value={ref} disabled={busy} readOnly={fixedRef} onChange={(event) => {
        setStatus(null)
        setError('')
        setSecret('')
        setConfirm(false)
        setRef(event.target.value)
      }} />
    </label>
    {status && <p role="status">{t(status.configured ? 'remoteHostCredentialSet' : 'remoteHostCredentialMissing')}
      {status.source && ' · ' + status.source}{!status.writable && ' · ' + t('remotePluginReadOnly')}</p>}
    <label className={styles.field}>{t('remoteHostCredentialValue')}
      <input type="password" autoComplete="new-password" value={secret} disabled={busy || !status?.writable}
        onChange={(event) => setSecret(event.target.value)} />
    </label>
    {confirm && <p>{t('remoteHostClearCredentialConfirm')}</p>}
    {error && <p role="alert">{error}</p>}
    <div className={styles.actions}>
      <Button variant="primary" type="submit" size="m" disabled={busy || !status?.writable || !secret.trim()}>{t('remoteScheduleSave')}</Button>
      <Button variant="outlined" size="m" disabled={busy || !status?.writable || !status.configured} onClick={() => {
        if (confirm) void save()
        else setConfirm(true)
      }}>{t('remoteHostClearCredential')}</Button>
      <Button variant="outlined" size="m" disabled={busy} onClick={onBack}>{t('chatControlsBack')}</Button>
    </div>
  </form>
}
