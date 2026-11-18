import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { IconCheckOutline16, IconChevronDownOutline14, IconChevronRightOutline14 } from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import { setThinkingEffort, useSettings } from '../../services/settings.js'
import { useTheme } from '../../app/theme.js'
import { ensureCatalog, resolveActiveModel } from '../../services/models/resolve.js'
import { setActiveModel, useModelState, DEEPSEEK_MODELS, type ModelEntry } from '../../services/models/store.js'
import { buildEffortLevels, resolveEffortIndex } from '../../services/models/effort.js'
import { effortPalette, PEAK_GRADIENT } from '../../services/models/effortPalette.js'
import { formatContext, type ProviderMeta } from '../../services/models/catalog.js'
import { Modal } from '../base/Modal.js'
import { Button } from '../base/Button.js'
import { openSettings } from '../settings/settingsDialogState.js'
import styles from './ModelCapsule.module.css'

/** Codex 弹层宽度：轨道 248 + 左右各 12 */
const PANEL_WIDTH = 272

type Group = { key: string; name: string; providerId: string; models: ModelEntry[] }

/**
 * 输入框里的模型胶囊：显示「模型名 · 思考强度」。
 *
 * 点开是 Codex 桌面版那张弹层 —— 上面是当前档位（带色的标题）与模型名，点它换模型；
 * 下面是按 Codex 尺寸复刻的滑条：轨道 26px / 圆角 16 / 旋钮 30px，
 * 拖动时旋钮连续跟手（不吸附），松手才吸附到最近档位。
 */
export const ModelCapsule = () => {
  const t = useTranslate()
  const theme = useTheme()
  const [catalog, setCatalog] = useState<ProviderMeta[]>([])
  const [open, setOpen] = useState(false)
  const [listOpen, setListOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; bottom: number } | null>(null)
  const [listQuery, setListQuery] = useState('')
  /** 拖动中的连续位置（0–1）；null 表示没在拖 */
  const [dragPos, setDragPos] = useState<number | null>(null)

  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const railRef = useRef<HTMLDivElement>(null)

  const { providers, active } = useModelState()
  const effort = useSettings((state) => state.thinkingEffort)

  useEffect(() => {
    void ensureCatalog().then(setCatalog)
  }, [])

  const current = useMemo(() => resolveActiveModel(catalog), [catalog, active, providers])
  const levels = useMemo(() => buildEffortLevels(current.meta), [current.meta])
  const index = levels.length > 0 ? resolveEffortIndex(levels, effort) : -1
  const level = index >= 0 ? levels[index] : null
  const snapped = levels.length > 1 ? index / (levels.length - 1) : 0
  const pos = dragPos ?? snapped
  const palette = effortPalette(level?.value ?? 'off', theme === 'dark')

  const openPanel = () => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) {
      return
    }
    setPosition({
      left: Math.min(Math.max(8, rect.left), window.innerWidth - PANEL_WIDTH - 8),
      bottom: window.innerHeight - rect.top + 8,
    })
    setOpen(true)
  }

  // 点空白 / 改变窗口大小收起；浮窗内部的滚动不关（拖滑条时会被误触）
  useEffect(() => {
    if (!open) {
      return
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (target && !panelRef.current?.contains(target) && !triggerRef.current?.contains(target)) {
        setOpen(false)
      }
    }
    const onResize = () => setOpen(false)
    const onScroll = (event: Event) => {
      const target = event.target as Node | null
      if (target && panelRef.current?.contains(target)) {
        return
      }
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open])

  /** 指针横坐标 → 0–1 位置 */
  const ratioAt = (clientX: number) => {
    const rect = railRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) {
      return 0
    }
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
  }

  const moveTo = (next: number) => {
    if (levels.length < 2) {
      return
    }
    const level = levels[Math.min(levels.length - 1, Math.max(0, next))]
    if (level && level.value !== effort) {
      setThinkingEffort(level.value)
    }
  }

  /**
   * 拖动：手势由 document 持有（不做指针捕获），
   * 这样即使指针移出弹层再移回来也不会中断 —— Codex 就是这么处理的。
   */
  const startDrag = (event: React.PointerEvent) => {
    if (levels.length < 2) {
      return
    }
    event.preventDefault()
    setDragPos(ratioAt(event.clientX))

    const onMove = (moveEvent: PointerEvent) => {
      setDragPos(ratioAt(moveEvent.clientX))
    }
    const finish = (upEvent: PointerEvent) => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', finish)
      document.removeEventListener('pointercancel', finish)
      const ratio = ratioAt(upEvent.clientX)
      const next = levels[Math.round(ratio * (levels.length - 1))]
      if (next) {
        setThinkingEffort(next.value)
      }
      setDragPos(null)
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', finish)
    document.addEventListener('pointercancel', finish)
  }

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

  const keyword = listQuery.trim().toLowerCase()
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

  const railStyle = {
    '--pos': pos,
    '--fill': palette.fill,
    '--ink': palette.ink,
    '--track': palette.track,
  } as CSSProperties

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        onMouseDown={(event) => event.preventDefault()}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => (open ? setOpen(false) : openPanel())}
      >
        <span className={styles.triggerName}>{current.model.name}</span>
        {level ? (
          <span className={styles.triggerEffort} style={{ color: palette.ink }}>
            {t(level.labelKey)}
          </span>
        ) : null}
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
              aria-label={t('thinkingEffort')}
            >
              <button
                type="button"
                className={styles.modelLink}
                onClick={() => {
                  setOpen(false)
                  setListQuery('')
                  setListOpen(true)
                }}
              >
                <span className={styles.heading} style={{ color: palette.ink }}>
                  {level ? t(level.labelKey) : t('effortOff')}
                  <IconChevronRightOutline14 />
                </span>
                <span className={styles.modelName}>{current.model.name}</span>
              </button>

              {levels.length > 1 ? (
                <div
                  ref={railRef}
                  className={clsx(
                    styles.rail,
                    dragPos !== null && styles.railDragging,
                    palette.peak && styles.railPeak
                  )}
                  style={railStyle}
                  role="slider"
                  tabIndex={0}
                  aria-label={t('thinkingEffort')}
                  aria-valuemin={0}
                  aria-valuemax={levels.length - 1}
                  aria-valuenow={index}
                  aria-valuetext={level ? t(level.labelKey) : ''}
                  onPointerDown={startDrag}
                  onKeyDown={(event) => {
                    const delta =
                      event.key === 'ArrowRight' || event.key === 'ArrowUp'
                        ? 1
                        : event.key === 'ArrowLeft' || event.key === 'ArrowDown'
                          ? -1
                          : 0
                    if (delta !== 0) {
                      event.preventDefault()
                      moveTo(index + delta)
                      return
                    }
                    if (event.key === 'Home') {
                      event.preventDefault()
                      moveTo(0)
                    } else if (event.key === 'End') {
                      event.preventDefault()
                      moveTo(levels.length - 1)
                    }
                  }}
                >
                  <div
                    className={styles.fill}
                    style={
                      palette.peak
                        ? { background: PEAK_GRADIENT, backgroundSize: '300% 100%' }
                        : undefined
                    }
                  />
                  {levels.map((item, itemIndex) => (
                    <span
                      key={item.value}
                      className={clsx(
                        styles.dot,
                        Math.round(pos * (levels.length - 1)) >= itemIndex && styles.dotPassed
                      )}
                      style={{ '--tick': itemIndex / (levels.length - 1) } as CSSProperties}
                    />
                  ))}
                  <div className={styles.knob} />
                </div>
              ) : (
                <div className={styles.noEffort}>{t('thinkingEffortUnsupported')}</div>
              )}
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
              value={listQuery}
              onChange={(event) => setListQuery(event.target.value)}
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
