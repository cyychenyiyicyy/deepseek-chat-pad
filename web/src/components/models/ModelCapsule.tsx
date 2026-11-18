import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconCheckOutline16, IconChevronDownOutline14, IconChevronRightOutline14 } from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import { setThinkingEffort, useSettings } from '../../services/settings.js'
import { ensureCatalog, resolveActiveModel } from '../../services/models/resolve.js'
import { setActiveModel, useModelState, DEEPSEEK_MODELS, type ModelEntry } from '../../services/models/store.js'
import { buildEffortLevels, resolveEffortIndex } from '../../services/models/effort.js'
import { formatContext, type ProviderMeta } from '../../services/models/catalog.js'
import { Modal } from '../base/Modal.js'
import { Button } from '../base/Button.js'
import { openSettings } from '../settings/settingsDialogState.js'
import styles from './ModelCapsule.module.css'

const PANEL_WIDTH = 300

type Group = { key: string; name: string; providerId: string; models: ModelEntry[] }

/**
 * 输入框里的模型胶囊：显示「模型名 · 思考强度」，点开是一个小浮窗，
 * 里面既能换模型，也有一条可拖动的思考强度滑条（档位来自 models.dev）。
 */
export const ModelCapsule = () => {
  const t = useTranslate()
  const [catalog, setCatalog] = useState<ProviderMeta[]>([])
  const [open, setOpen] = useState(false)
  const [listOpen, setListOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; bottom: number } | null>(null)
  const [query, setQuery] = useState('')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)

  const { providers, active } = useModelState()
  const effort = useSettings((state) => state.thinkingEffort)

  useEffect(() => {
    void ensureCatalog().then(setCatalog)
  }, [])

  const current = useMemo(() => resolveActiveModel(catalog), [catalog, active, providers])
  const levels = useMemo(() => buildEffortLevels(current.meta), [current.meta])
  const index = levels.length > 0 ? resolveEffortIndex(levels, effort) : -1
  const level = index >= 0 ? levels[index] : null
  const percent = levels.length > 1 ? (index / (levels.length - 1)) * 100 : 0

  const openPanel = () => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) {
      return
    }
    // 贴按钮上方展开；只算固定宽度，不依赖浮层自身尺寸
    setPosition({
      left: Math.min(Math.max(8, rect.left), window.innerWidth - PANEL_WIDTH - 8),
      bottom: window.innerHeight - rect.top + 8,
    })
    setOpen(true)
  }

  // 点空白、滚动或改变窗口尺寸都收起
  useEffect(() => {
    if (!open) {
      return
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (
        target &&
        !panelRef.current?.contains(target) &&
        !triggerRef.current?.contains(target)
      ) {
        setOpen(false)
      }
    }
    const close = () => setOpen(false)
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [open])

  /** 按指针位置取最近的档位 */
  const commit = (clientX: number) => {
    const track = trackRef.current
    if (!track || levels.length < 2) {
      return
    }
    const rect = track.getBoundingClientRect()
    if (rect.width <= 0) {
      return
    }
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    const next = levels[Math.round(ratio * (levels.length - 1))]
    if (next && next.value !== effort) {
      setThinkingEffort(next.value)
    }
  }

  // 模型列表分组（与之前的弹窗一致）
  const groups: Group[] = useMemo(() => {
    const meta = catalog.find((provider) => provider.id === 'deepseek')?.models ?? []
    const deepseek: Group = {
      key: 'deepseek',
      name: 'DeepSeek',
      providerId: 'deepseek',
      models: DEEPSEEK_MODELS.map((entry) => {
        const hit = meta.find((model) => model.id === entry.id)
        return hit ? { ...entry, meta: hit, name: hit.name || entry.name } : entry
      }),
    }
    return [
      deepseek,
      ...providers.map((provider) => ({
        key: provider.id,
        name: provider.name,
        providerId: provider.id,
        models: provider.models,
      })),
    ]
  }, [providers, catalog])

  const keyword = query.trim().toLowerCase()
  const filtered = groups
    .map((group) => ({
      ...group,
      models: keyword
        ? group.models.filter(
            (model) =>
              model.name.toLowerCase().includes(keyword) || model.id.toLowerCase().includes(keyword)
          )
        : group.models,
    }))
    .filter((group) => group.models.length > 0)

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={clsx(styles.trigger, open && styles.triggerOpen)}
        aria-haspopup="dialog"
        aria-expanded={open}
        onMouseDown={(event) => event.preventDefault()}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => (open ? setOpen(false) : openPanel())}
      >
        <span className={styles.triggerName}>{current.model.name}</span>
        {level ? <span className={styles.triggerEffort}>{t(level.labelKey)}</span> : null}
        <span className={styles.triggerArrow}>
          <IconChevronDownOutline14 />
        </span>
      </button>

      {open && position
        ? createPortal(
            <div
              ref={panelRef}
              className={styles.panel}
              style={{ left: position.left, bottom: position.bottom, width: PANEL_WIDTH }}
              role="dialog"
              aria-label={t('modelSelectTitle')}
            >
              <button
                type="button"
                className={styles.modelRow}
                onClick={() => {
                  setOpen(false)
                  setQuery('')
                  setListOpen(true)
                }}
              >
                <span className={styles.rowLabel}>{t('modelSelectTitle')}</span>
                <span className={styles.rowValue}>{current.model.name}</span>
                <span className={styles.rowChevron}>
                  <IconChevronRightOutline14 />
                </span>
              </button>

              <div className={styles.effortBlock}>
                <div className={styles.effortHead}>
                  <span className={styles.rowLabel}>{t('thinkingEffort')}</span>
                  <span className={styles.effortValue}>{level ? t(level.labelKey) : t('effortOff')}</span>
                </div>
                {levels.length > 1 ? (
                  <div
                    ref={trackRef}
                    className={styles.track}
                    role="slider"
                    aria-label={t('thinkingEffort')}
                    aria-valuemin={0}
                    aria-valuemax={levels.length - 1}
                    aria-valuenow={index}
                    aria-valuetext={level ? t(level.labelKey) : ''}
                    tabIndex={0}
                    onPointerDown={(event) => {
                      draggingRef.current = true
                      event.currentTarget.setPointerCapture(event.pointerId)
                      commit(event.clientX)
                    }}
                    onPointerMove={(event) => {
                      if (draggingRef.current) {
                        commit(event.clientX)
                      }
                    }}
                    onPointerUp={(event) => {
                      draggingRef.current = false
                      try {
                        event.currentTarget.releasePointerCapture(event.pointerId)
                      } catch {
                        // 指针已经释放
                      }
                    }}
                    onPointerCancel={() => {
                      draggingRef.current = false
                    }}
                    onKeyDown={(event) => {
                      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
                      if (step === 0) return
                      event.preventDefault()
                      const next = levels[Math.min(levels.length - 1, Math.max(0, index + step))]
                      if (next) setThinkingEffort(next.value)
                    }}
                  >
                    <div className={styles.trackFill} style={{ width: `${percent}%` }} />
                    {levels.map((item, itemIndex) => (
                      <span
                        key={item.value}
                        className={clsx(
                          styles.tick,
                          itemIndex <= index && styles.tickOn
                        )}
                        style={{ left: `${(itemIndex / (levels.length - 1)) * 100}%` }}
                      />
                    ))}
                    <div className={styles.knob} style={{ left: `${percent}%` }} />
                  </div>
                ) : (
                  <div className={styles.effortHint}>{t('thinkingEffortUnsupported')}</div>
                )}
              </div>
            </div>,
            document.body
          )
        : null}

      {listOpen ? (
        <Modal
          title={t('modelSelectTitle')}
          closable
          className={styles.dialog}
          onClose={() => setListOpen(false)}
          footer={
            <div className={styles.footer}>
              <Button
                variant="outlined"
                size="m"
                onClick={() => {
                  setListOpen(false)
                  openSettings('models')
                }}
              >
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
                            setListOpen(false)
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
          </div>
        </Modal>
      ) : null}
    </>
  )
}
