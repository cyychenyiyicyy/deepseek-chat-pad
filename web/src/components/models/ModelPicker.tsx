import clsx from 'clsx'
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import { IconCheckOutline16, IconChevronDownOutline14, IconSettingsOutline16 } from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import { ensureCatalog, resolveActiveModel } from '../../services/models/resolve.js'
import { setActiveModel, useModelState, DEEPSEEK_MODELS, type ModelEntry } from '../../services/models/store.js'
import type { ProviderMeta } from '../../services/models/catalog.js'
import { formatContext } from '../../services/models/catalog.js'
import { ModelSettings } from './ModelSettings.js'
import styles from './ModelPicker.module.css'

/** 上下文窗口显示成 128K / 1M 这样的短记法 */
export { formatContext }

type Group = { key: string; name: string; providerId: string; models: ModelEntry[] }

/**
 * 输入框里的模型选择器：显示当前模型名，点开按厂商分组列出全部模型，支持搜索。
 * 与侧栏、设置页共用同一份模型配置。
 */
export const ModelPicker = () => {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [catalog, setCatalog] = useState<ProviderMeta[]>([])
  const { providers, active } = useModelState()

  useEffect(() => {
    void ensureCatalog().then(setCatalog)
  }, [])

  const current = useMemo(() => resolveActiveModel(catalog), [catalog, active, providers])

  const groups: Group[] = useMemo(() => {
    const deepseek: Group = {
      key: 'deepseek',
      name: 'DeepSeek',
      providerId: 'deepseek',
      models: DEEPSEEK_MODELS.map((entry) => {
        const meta = catalog.find((p) => p.id === 'deepseek')?.models?.find((m) => m.id === entry.id)
        return meta ? { ...entry, meta, name: meta.name || entry.name } : entry
      }),
    }
    return [deepseek, ...providers.map((p) => ({ key: p.id, name: p.name, providerId: p.id, models: p.models }))]
  }, [providers, catalog])

  const keyword = query.trim().toLowerCase()
  const filtered = useMemo(
    () =>
      groups
        .map((group) => ({
          ...group,
          models: keyword
            ? group.models.filter(
                (m) => m.name.toLowerCase().includes(keyword) || m.id.toLowerCase().includes(keyword)
              )
            : group.models,
        }))
        .filter((group) => group.models.length > 0),
    [groups, keyword]
  )

  const { anchorRef, floatingRef, position } = useAnchoredPosition<HTMLButtonElement, HTMLDivElement>(open, {
    align: 'start',
    offset: 8,
    maxHeight: 460,
    minSpace: 220,
  })
  useDismiss(open, [anchorRef, floatingRef], () => setOpen(false), { captureEscape: true })

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={clsx(styles.trigger, open && styles.open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('modelSelectTitle')}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.name}>{current.model.name}</span>
        <span className={styles.arrow}>
          <IconChevronDownOutline14 />
        </span>
      </button>

      {open && !settingsOpen
        ? createPortal(
            <div
              ref={floatingRef}
              className={styles.panel}
              style={position ?? undefined}
              role="listbox"
              aria-label={t('modelSelectTitle')}
            >
              <div className={styles.searchRow}>
                <input
                  className={styles.search}
                  placeholder={t('modelSearchPlaceholder')}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  autoFocus
                />
              </div>
              <div className={styles.list}>
                {filtered.length === 0 ? (
                  <div className={styles.empty}>{keyword ? t('modelNoMatch') : t('modelNoModels')}</div>
                ) : (
                  filtered.map((group) => (
                    <div key={group.key} className={styles.group}>
                      <div className={styles.groupName}>{group.name}</div>
                      {group.models.map((model) => {
                        const selected =
                          group.providerId === active.providerId && model.id === active.modelId
                        return (
                          <div
                            key={`${group.providerId}:${model.id}`}
                            role="option"
                            aria-selected={selected}
                            className={clsx(styles.item, selected && styles.itemActive)}
                            onClick={() => {
                              setActiveModel(group.providerId, model.id)
                              setOpen(false)
                            }}
                          >
                            <span className={styles.itemName}>{model.name}</span>
                            {model.meta?.ctx ? (
                              <span className={styles.itemMeta}>
                                {formatContext(model.meta.ctx)} {t('modelContextSuffix')}
                              </span>
                            ) : null}
                            {selected ? <IconCheckOutline16 /> : null}
                          </div>
                        )
                      })}
                    </div>
                  ))
                )}
              </div>
              <button
                type="button"
                className={styles.manage}
                onClick={() => {
                  setOpen(false)
                  setSettingsOpen(true)
                }}
              >
                <IconSettingsOutline16 />
                {t('modelManage')}
              </button>
            </div>,
            document.body
          )
        : null}

      {settingsOpen ? <ModelSettings onClose={() => setSettingsOpen(false)} /> : null}
    </>
  )
}
