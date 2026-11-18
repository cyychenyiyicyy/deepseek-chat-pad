import { useEffect, useMemo, useState } from 'react'
import { IconCheckOutline16, IconChevronDownOutline14, IconSettingsOutline16 } from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import { Button } from '../base/Button.js'
import { useTranslate } from '../../i18n/index.js'
import { ensureCatalog, resolveActiveModel } from '../../services/models/resolve.js'
import {
  setActiveModel,
  useModelState,
  DEEPSEEK_MODELS,
  type ModelEntry,
  type ProviderConfig,
} from '../../services/models/store.js'
import { formatContext, type ProviderMeta } from '../../services/models/catalog.js'
import { openSettings } from '../settings/settingsDialogState.js'
import styles from './ModelPicker.module.css'

type Group = { key: string; name: string; providerId: string; models: ModelEntry[] }

/** DeepSeek 的两个内置模型补上目录元信息 */
const deepseekGroup = (catalog: ProviderMeta[]): Group => {
  const meta = catalog.find((p) => p.id === 'deepseek')?.models ?? []
  return {
    key: 'deepseek',
    name: 'DeepSeek',
    providerId: 'deepseek',
    models: DEEPSEEK_MODELS.map((entry) => {
      const hit = meta.find((m) => m.id === entry.id)
      return hit ? { ...entry, meta: hit, name: hit.name || entry.name } : entry
    }),
  }
}

const providerGroup = (provider: ProviderConfig): Group => ({
  key: provider.id,
  name: provider.name,
  providerId: provider.id,
  models: provider.models,
})

/**
 * 输入框里的模型选择器。
 *
 * 点开是一个居中的弹层（不是贴着按钮的浮层）——平板上的浮层定位容易受软键盘与
 * 视觉视口影响，点开却没反应；居中弹层只要点开就一定在视野里。
 * 列表按 provider 分组，同名模型会标出所属厂商。
 */
export const ModelPicker = () => {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [catalog, setCatalog] = useState<ProviderMeta[]>([])
  const { providers, active } = useModelState()

  useEffect(() => {
    void ensureCatalog().then(setCatalog)
  }, [])

  const current = useMemo(() => resolveActiveModel(catalog), [catalog, active, providers])

  const groups = useMemo(
    () => [deepseekGroup(catalog), ...providers.map(providerGroup)],
    [providers, catalog]
  )

  /** 同一个模型 id 出现在多家厂商时，行内标出厂商 */
  const duplicates = useMemo(() => {
    const counter = new Map<string, number>()
    for (const group of groups) {
      for (const model of group.models) counter.set(model.id, (counter.get(model.id) ?? 0) + 1)
    }
    return counter
  }, [groups])

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

  return (
    <>
      <button
        type="button"
        className={styles.trigger}
        aria-haspopup="dialog"
        aria-label={t('modelSelectTitle')}
        // 阻止默认行为，避免点击时把焦点交给输入框、连带弹出软键盘
        onMouseDown={(event) => event.preventDefault()}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => {
          // 先让当前输入框失焦，避免点开选择器时软键盘还挂着
          if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur()
          }
          setQuery('')
          setOpen(true)
        }}
      >
        <span className={styles.name}>{current.model.name}</span>
        <span className={styles.arrow}>
          <IconChevronDownOutline14 />
        </span>
      </button>

      {open ? (
        <Modal
          title={t('modelSelectTitle')}
          closable
          className={styles.dialog}
          onClose={() => setOpen(false)}
          footer={
            <div className={styles.footer}>
              <Button
                variant="outlined"
                size="m"
                onClick={() => {
                  setOpen(false)
                  openSettings('models')
                }}
              >
                <IconSettingsOutline16 />
                {t('modelManage')}
              </Button>
            </div>
          }
        >
          <div className={styles.dialogBody}>
            <input
              className={styles.search}
              placeholder={t('modelSearchPlaceholder')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className={styles.list} role="listbox" aria-label={t('modelSelectTitle')}>
              {filtered.length === 0 ? (
                <div className={styles.empty}>{keyword ? t('modelNoMatch') : t('modelNoModels')}</div>
              ) : (
                filtered.map((group) => (
                  <div key={group.key} className={styles.group}>
                    <div className={styles.groupName}>
                      {group.name}
                      <span className={styles.groupCount}>{group.models.length}</span>
                    </div>
                    {group.models.map((model) => {
                      const selected =
                        group.providerId === active.providerId && model.id === active.modelId
                      return (
                        <div
                          key={`${group.providerId}:${model.id}`}
                          role="option"
                          aria-selected={selected}
                          className={styles.item}
                          onClick={() => {
                            setActiveModel(group.providerId, model.id)
                            setOpen(false)
                          }}
                        >
                          <span className={styles.itemName}>{model.name}</span>
                          {(duplicates.get(model.id) ?? 0) > 1 ? (
                            <span className={styles.itemProvider}>{group.name}</span>
                          ) : null}
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
          </div>
        </Modal>
      ) : null}
    </>
  )
}
