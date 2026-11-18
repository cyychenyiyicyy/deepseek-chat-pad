import clsx from 'clsx'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
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

type Group = { key: string; name: string; providerId: string; models: ModelEntry[] }

/** 磁吸范围：档距的 18%，靠近档位时旋钮会被「吸」过去一点，松手才完全吸附 */
const MAGNET_RATIO = 0.18

/** 弹层高度（Codex 实测 104），用于打开时定位 */
const PANEL_HEIGHT = 104

/**
 * 输入框里的模型胶囊：显示「模型名 · 思考强度」。
 *
 * 点开是 Codex 桌面版那张弹层（几何与配色按录屏实测复刻）：
 * 上面是档位标题与模型名，点它换模型；下面是可以拖动/点按的滑条。
 * 弹层用「相对胶囊的绝对定位」，不做视口坐标换算 —— 这样界面缩放、软键盘都不会把它放歪。
 */
export const ModelCapsule = () => {
  const t = useTranslate()
  const theme = useTheme()
  const [catalog, setCatalog] = useState<ProviderMeta[]>([])
  const [open, setOpen] = useState(false)
  const [listOpen, setListOpen] = useState(false)
  const [listQuery, setListQuery] = useState('')
  /** 只在拖动开始/结束时变化，拖动过程中直接改 DOM，避免每移动一像素就重渲染 */
  const [dragging, setDragging] = useState(false)
  /** 弹层相对宿主的位置（两个 rect 相减得到，不依赖视口尺寸） */
  const [panelPos, setPanelPos] = useState<{ top: number; left: number } | null>(null)
  const hostRef = useRef<HTMLDivElement>(null)

  /** 拖动过程中当前的位置，不放进 state，避免每移动一像素就整棵树重渲染 */
  const posRef = useRef(0)
  const anchorRef = useRef<HTMLSpanElement>(null)
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
  const palette = effortPalette(level?.value ?? 'off', theme === 'dark')

  // 打开时量一次：用「胶囊 rect − 宿主 rect」定位，同一坐标系里相减，
  // 因此界面缩放（html zoom）与软键盘都不会让弹层跑偏
  useLayoutEffect(() => {
    if (!open) {
      setPanelPos(null)
      return
    }
    const anchor = anchorRef.current
    const host = hostRef.current
    if (!anchor || !host) {
      return
    }
    const anchorRect = anchor.getBoundingClientRect()
    const hostRect = host.getBoundingClientRect()
    const width = 272
    const height = host.firstElementChild instanceof HTMLElement
      ? host.firstElementChild.offsetHeight
      : PANEL_HEIGHT
    const left = Math.min(
      Math.max(8, anchorRect.left - hostRect.left),
      Math.max(8, hostRect.width - width - 8)
    )
    // 永远向上展开：贴住胶囊上沿再留 10px
    const top = Math.max(8, anchorRect.top - hostRect.top - height - 10)
    setPanelPos({ top, left })
  }, [open])

  // 点空白收起
  useEffect(() => {
    if (!open) {
      return
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (target && !panelRef.current?.contains(target) && !anchorRef.current?.contains(target)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open])

  /** 直接把位置写进 CSS 变量：跟手的关键，不经过 React 渲染 */
  const applyPos = (value: number) => {
    posRef.current = value
    railRef.current?.style.setProperty('--pos', String(value))
  }

  // 每次渲染后把拖动位置写回去：React 会用 style 里的 --pos 覆盖它
  useLayoutEffect(() => {
    if (dragging) {
      railRef.current?.style.setProperty('--pos', String(posRef.current))
    }
  })

  /** 指针横坐标 → 0–1，超出轨道时夹在两端 */
  const ratioAt = (clientX: number) => {
    const rail = railRef.current
    if (!rail) {
      return 0
    }
    const rect = rail.getBoundingClientRect()
    if (rect.width <= 0) {
      return 0
    }
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
  }

  /** 磁吸：离档位够近时把指针位置往档位拉，拖动过程中就有吸附感 */
  const magnetize = (raw: number) => {
    if (levels.length < 2) {
      return raw
    }
    const count = levels.length - 1
    const nearest = Math.round(raw * count) / count
    const distance = Math.abs(raw - nearest)
    const threshold = MAGNET_RATIO / count
    if (distance >= threshold) {
      return raw
    }
    const pull = 1 - distance / threshold
    return raw + (nearest - raw) * pull
  }

  const startDrag = (event: React.PointerEvent) => {
    if (levels.length < 2) {
      return
    }
    event.preventDefault()
    setDragging(true)
    applyPos(magnetize(ratioAt(event.clientX)))

    // 手势挂在 document 上：拖出弹层再拖回来也不会断
    const onMove = (moveEvent: PointerEvent) => {
      applyPos(magnetize(ratioAt(moveEvent.clientX)))
    }
    const finish = (upEvent: PointerEvent) => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', finish)
      document.removeEventListener('pointercancel', finish)
      const ratio = ratioAt(upEvent.clientX)
      // 松手才真正吸附到最近档位
      const next = levels[Math.round(ratio * (levels.length - 1))]
      if (next) {
        setThinkingEffort(next.value)
      }
      setDragging(false)
      applyPos(ratio)
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', finish)
    document.addEventListener('pointercancel', finish)
  }

  const moveTo = (next: number) => {
    if (levels.length < 2) {
      return
    }
    const target = levels[Math.min(levels.length - 1, Math.max(0, next))]
    if (target && target.value !== effort) {
      setThinkingEffort(target.value)
    }
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
    // 拖动中由 applyPos 直接改这个变量；静止时用当前档位
    '--pos': snapped,
    '--fill': palette.fill,
    '--track': palette.track,
  } as CSSProperties

  const passedIndex = Math.round(snapped * Math.max(0, levels.length - 1))

  return (
    <>
      <span ref={anchorRef} className={styles.anchor}>
        <button
          type="button"
          className={clsx(styles.trigger, open && styles.triggerOpen)}
          aria-haspopup="dialog"
          aria-expanded={open}
          onMouseDown={(event) => event.preventDefault()}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => setOpen((value) => !value)}
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

      </span>

      {open
        ? createPortal(
            <div ref={hostRef} className={styles.host}>
              <div
                ref={panelRef}
                className={styles.panel}
                role="dialog"
                aria-label={t('thinkingEffort')}
                style={panelPos ? { top: panelPos.top, left: panelPos.left } : { visibility: 'hidden' }}
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
                  dragging && styles.railDragging,
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
                    className={clsx(styles.dot, itemIndex <= passedIndex && styles.dotPassed)}
                    style={{ '--tick': itemIndex / (levels.length - 1) } as CSSProperties}
                  />
                ))}
                <div className={styles.knob} />
              </div>
                ) : (
                  <div className={styles.noEffort}>{t('thinkingEffortUnsupported')}</div>
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
