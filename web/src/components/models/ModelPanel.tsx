import clsx from 'clsx'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '../base/Button.js'
import { IconBrowseOutline16, IconRefreshOutline16, IconTrashOutline16 } from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import { openSettings } from '../settings/settingsDialogState.js'
import {
  formatContext,
  loadCoreProviders,
  loadProviderDirectory,
  matchProvider,
  normalizeBaseUrl,
  type ProviderMeta,
} from '../../services/models/catalog.js'
import { enrichModels, fetchEndpointModels, fetchOnlineMeta } from '../../services/models/remote.js'
import {
  newProviderId,
  removeProvider,
  upsertProvider,
  useModelState,
  type ModelEntry,
  type ProviderConfig,
} from '../../services/models/store.js'
import settingsStyles from '../settings/Settings.module.css'
import styles from './ModelSettings.module.css'

type Form = { id: string | null; name: string; api: string; apiKey: string }

const EMPTY_FORM: Form = { id: null, name: '', api: '', apiKey: '' }

/** 密钥只显示后四位，避免截图泄露 */
const maskKey = (key: string) => (key.length <= 8 ? '••••' : `••••${key.slice(-4)}`)

/**
 * 设置页的「模型服务」分组：内置 DeepSeek + 自定义端点。
 *
 * 添加端点时填 Base URL 与 Key，点「获取模型列表」即调用该端点的 /models，
 * 再用内置目录（必要时 models.dev）补全上下文、价格、是否支持思考等元信息。
 * 同一家厂商可以有多个端点，同一个模型也可以分属不同厂商，列表按厂商分别展示。
 */
export const ModelPanel = () => {
  const t = useTranslate()
  const { providers } = useModelState()
  const deepseekKey = useSettings((state) => state.apiKey)
  const [form, setForm] = useState<Form>(EMPTY_FORM)
  const [pool, setPool] = useState<ProviderMeta[]>([])
  const [detected, setDetected] = useState<ProviderMeta | null>(null)
  const [compat, setCompat] = useState<'openai' | 'anthropic'>('openai')
  const [models, setModels] = useState<ModelEntry[]>([])
  const [busy, setBusy] = useState<'' | 'fetch' | 'online'>('')
  const [message, setMessage] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      const [core, directory] = await Promise.all([loadCoreProviders(), loadProviderDirectory()])
      setPool([...core, ...directory.filter((d) => !core.some((c) => c.id === d.id))])
    })()
  }, [])

  // 输入 Base URL 时实时识别厂商与兼容协议
  useEffect(() => {
    const base = normalizeBaseUrl(form.api)
    if (!base || pool.length === 0) {
      setDetected(null)
      return
    }
    const hit = matchProvider(base, pool)
    setDetected(hit)
    if (hit) setCompat(hit.compat)
    else if (/\/anthropic(\/|$)/.test(base)) setCompat('anthropic')
    else setCompat('openai')
  }, [form.api, pool])

  /** 同一个模型 id 出现在多家厂商时，行内标出厂商，避免看起来像重复项 */
  const duplicateIds = useMemo(() => {
    const counter = new Map<string, number>()
    for (const provider of providers) {
      for (const model of provider.models) {
        counter.set(model.id, (counter.get(model.id) ?? 0) + 1)
      }
    }
    return counter
  }, [providers])

  const fetchModels = async () => {
    const base = normalizeBaseUrl(form.api)
    if (!base) return setMessage(t('modelProviderUrlRequired'))
    if (!form.apiKey.trim()) return setMessage(t('modelProviderKeyRequired'))
    setBusy('fetch')
    setMessage('')
    try {
      const remote = await fetchEndpointModels({ api: base, compat, apiKey: form.apiKey.trim() })
      setModels(enrichModels(detected?.id ?? 'custom', base, remote, pool))
      setMessage(t('modelProviderFetched', { n: remote.length }))
    } catch (error) {
      setMessage(
        t('modelProviderFetchFailed', { msg: error instanceof Error ? error.message : String(error) })
      )
    } finally {
      setBusy('')
    }
  }

  const fillOnline = async () => {
    const base = normalizeBaseUrl(form.api)
    if (!base) return
    setBusy('online')
    setMessage('')
    try {
      const online = await fetchOnlineMeta(detected?.id ?? (form.name.trim() || 'custom'), base)
      if (online.length === 0) {
        setMessage(t('modelProviderOnlineFailed', { msg: 'models.dev 未收录该厂商' }))
        return
      }
      const merged = new Map(models.map((m) => [m.id, m]))
      for (const entry of online) {
        const existing = merged.get(entry.id)
        merged.set(entry.id, {
          ...existing,
          ...entry,
          name: entry.name || existing?.name || entry.id,
        })
      }
      setModels([...merged.values()])
      setMessage(t('modelProviderFetched', { n: online.length }))
    } catch (error) {
      setMessage(
        t('modelProviderOnlineFailed', { msg: error instanceof Error ? error.message : String(error) })
      )
    } finally {
      setBusy('')
    }
  }

  const save = () => {
    const base = normalizeBaseUrl(form.api)
    const name = form.name.trim() || detected?.name || '自定义端点'
    if (!base) return setMessage(t('modelProviderUrlRequired'))
    if (!form.apiKey.trim()) return setMessage(t('modelProviderKeyRequired'))
    const provider: ProviderConfig = {
      id: form.id ?? newProviderId(),
      name,
      api: base,
      compat,
      apiKey: form.apiKey.trim(),
      models,
      fetchedAt: Date.now(),
    }
    upsertProvider(provider)
    setForm(EMPTY_FORM)
    setModels([])
    setDetected(null)
    setMessage(t('modelProviderSaved'))
  }

  const startEdit = (provider: ProviderConfig) => {
    setForm({ id: provider.id, name: provider.name, api: provider.api, apiKey: provider.apiKey })
    setModels(provider.models)
    setMessage('')
  }

  const refresh = async (provider: ProviderConfig) => {
    setBusy('fetch')
    setMessage('')
    try {
      const remote = await fetchEndpointModels(provider)
      upsertProvider({
        ...provider,
        models: enrichModels(provider.id, provider.api, remote, pool),
        fetchedAt: Date.now(),
      })
    } catch (error) {
      setMessage(
        t('modelProviderFetchFailed', { msg: error instanceof Error ? error.message : String(error) })
      )
    } finally {
      setBusy('')
    }
  }

  const timeText = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
    []
  )

  return (
    <div className={styles.body}>
      <p className={styles.hint}>{t('modelSettingsDesc')}</p>

      {/* 内置 DeepSeek：搜索、文件解析、余额都走它的 Key */}
      <div className={settingsStyles.cell}>
        <div className={styles.cardTop}>
          <span className={settingsStyles.label}>DeepSeek</span>
          <span className={clsx(styles.badge, deepseekKey ? styles.badgeOk : styles.badgeWarn)}>
            {deepseekKey ? maskKey(deepseekKey) : t('modelProviderKeyRequired')}
          </span>
        </div>
        <div className={styles.cardSub}>deepseek-flash · deepseek-v4-pro</div>
        <div className={styles.cardActions}>
          <Button variant="outlined" size="s" onClick={() => openSettings('data')}>
            {t('settings')}
          </Button>
        </div>
      </div>

      <div className={styles.sectionTitle}>{t('modelProviderCustom')}</div>
      {providers.length === 0 ? <div className={styles.empty}>{t('modelProviderEmpty')}</div> : null}

      {providers.map((provider) => (
        <div key={provider.id} className={styles.card}>
          <div className={styles.cardTop}>
            <div className={styles.cardTitle}>{provider.name}</div>
            <span className={styles.badge}>
              {t('modelProviderModelCount', { n: provider.models.length })}
            </span>
          </div>
          <div className={styles.cardSub}>
            {provider.api} · {provider.compat === 'anthropic' ? 'Anthropic' : 'OpenAI'}
          </div>
          <div className={styles.cardSub}>
            {maskKey(provider.apiKey)} ·{' '}
            {t('modelProviderLastUsed', { time: timeText.format(provider.fetchedAt) })}
          </div>
          <div className={styles.cardActions}>
            <Button variant="outlined" size="s" disabled={busy !== ''} onClick={() => void refresh(provider)}>
              <IconRefreshOutline16 />
              {t('modelProviderUpdate')}
            </Button>
            <Button variant="outlined" size="s" onClick={() => startEdit(provider)}>
              {t('modelProviderEdit')}
            </Button>
            <Button variant="outlined" size="s" onClick={() => setConfirmDelete(provider.id)}>
              <IconTrashOutline16 />
              {t('modelProviderDelete')}
            </Button>
          </div>
          {confirmDelete === provider.id ? (
            <div className={styles.confirmRow}>
              <span>{t('modelProviderDeleteConfirm')}</span>
              <Button
                variant="danger"
                size="s"
                onClick={() => {
                  removeProvider(provider.id)
                  setConfirmDelete(null)
                }}
              >
                {t('delete')}
              </Button>
              <Button variant="outlined" size="s" onClick={() => setConfirmDelete(null)}>
                {t('cancel')}
              </Button>
            </div>
          ) : null}
          {provider.models.length > 0 ? (
            <div className={styles.modelList}>
              {provider.models.map((model) => (
                <div key={`${provider.id}:${model.id}`} className={styles.modelRow}>
                  <span className={styles.modelName}>{model.name}</span>
                  {model.meta?.ctx ? (
                    <span className={styles.modelMeta}>
                      {formatContext(model.meta.ctx)} {t('modelContextSuffix')}
                    </span>
                  ) : null}
                  {model.meta?.reason ? <span className={styles.tag}>{t('thinkingSwitch')}</span> : null}
                  {model.meta?.attach ? <span className={styles.tag}>{t('uploadFile')}</span> : null}
                  {(duplicateIds.get(model.id) ?? 0) > 1 ? (
                    <span className={styles.tag}>{provider.name}</span>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ))}

      <div className={styles.sectionTitle}>
        {form.id ? t('modelProviderEdit') : t('modelAddProvider')}
      </div>
      <div className={styles.form}>
        <label className={styles.field}>
          <span className={styles.label}>{t('modelProviderName')}</span>
          <input
            className={styles.input}
            value={form.name}
            placeholder={t('modelProviderNamePlaceholder')}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>{t('modelProviderBaseUrl')}</span>
          <input
            className={styles.input}
            value={form.api}
            placeholder={t('modelProviderBaseUrlPlaceholder')}
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => setForm({ ...form, api: event.target.value })}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>{t('modelProviderApiKey')}</span>
          <input
            className={styles.input}
            value={form.apiKey}
            placeholder={t('modelProviderApiKeyPlaceholder')}
            type="password"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
          />
        </label>

        {form.api ? (
          <div className={styles.detected}>
            {detected
              ? t('modelProviderDetected', {
                  name: detected.name,
                  compat: detected.compat === 'anthropic' ? 'Anthropic' : 'OpenAI',
                })
              : `${t('modelProviderUnknown')} · ${compat}`}
          </div>
        ) : null}

        <div className={styles.formActions}>
          <Button variant="outlined" size="m" disabled={busy !== ''} onClick={() => void fetchModels()}>
            <IconBrowseOutline16 />
            {busy === 'fetch' ? t('modelProviderFetching') : t('modelProviderFetch')}
          </Button>
          <Button
            variant="outlined"
            size="m"
            disabled={busy !== '' || models.length === 0}
            onClick={() => void fillOnline()}
          >
            {busy === 'online' ? t('modelProviderOnlineFilling') : t('modelProviderOnline')}
          </Button>
          <Button variant="primary" size="m" disabled={busy !== ''} onClick={save}>
            {t('modelProviderSave')}
          </Button>
        </div>

        {message ? <div className={styles.message}>{message}</div> : null}

        {models.length > 0 ? (
          <div className={styles.modelList}>
            {models.map((model) => (
              <div key={model.id} className={styles.modelRow}>
                <span className={styles.modelName}>{model.name}</span>
                {model.meta?.ctx ? (
                  <span className={styles.modelMeta}>
                    {formatContext(model.meta.ctx)} {t('modelContextSuffix')}
                  </span>
                ) : null}
                {model.meta?.reason ? <span className={styles.tag}>{t('thinkingSwitch')}</span> : null}
                {model.meta?.attach ? <span className={styles.tag}>{t('uploadFile')}</span> : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}
