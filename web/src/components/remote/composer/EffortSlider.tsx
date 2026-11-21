import clsx from 'clsx'
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { useTheme } from '../../../app/theme.js'
import { effortPalette, PEAK_GRADIENT } from '../../../services/models/effortPalette.js'
import type { RemoteModelEffort } from '../../../services/remote/sessionControls.js'
import {
  effortIndex,
  effortRatioOf,
  magnetizeRatio,
  ratioToIndex,
} from './effortLevels.js'
import styles from './EffortSlider.module.css'

/**
 * 思考强度滑条（远程版）：拖 / 点刻度 / ←→ 都能换档，松手才真正提交。
 *
 * 几何与配色照抄本机聊天那个选择器（`components/models/ModelCapsule.tsx` +
 * `services/models/effortPalette.ts`，那份规格是用 Codex 桌面版录屏量出来的）：
 * 轨道圆角 16、旋钮 30（比轨道高 4px）、填充宽 = (100% − 30px) × pos + 15px、
 * 刻度 4px 位于 top:11px。**只改了两处**：
 *
 *  1. 档位来源是 Host 逐模型给的 `efforts`（`RemoteModelEffort[]`），不是本地设置；
 *  2. 描边/轨道色用同一份 `effortPalette`，但 key 取的是 Host 的档位 id
 *     （`low` / `medium` / `high`…，命中不了的档位按 `low` 与 `high` 之间的中性色渲染）。
 *
 * 拖动过程中**不经过 React**（直接改 CSS 变量 `--pos`），否则每移动一像素就整树重渲染，
 * 平板上的手感会明显发涩。
 */
export const EffortSlider = ({
  levels,
  value,
  onPick,
  label,
  disabled = false,
}: {
  levels: readonly RemoteModelEffort[]
  /** 当前档位 id（`undefined` = 还没解析出来，滑条停在起点） */
  value: string | undefined
  onPick: (id: string) => void
  /** 无障碍名（就是「思考强度」） */
  label: string
  disabled?: boolean
}) => {
  const theme = useTheme()
  const [dragging, setDragging] = useState(false)
  /** 拖动过程中的位置（不放进 state，避免每移动一像素就重渲染） */
  const posRef = useRef(0)
  const railRef = useRef<HTMLDivElement>(null)

  const index = effortIndex(levels, value)
  const snapped = effortRatioOf(index, levels.length)
  const palette = effortPalette(value ?? 'off', theme === 'dark')
  const level = index >= 0 ? levels[index] : undefined
  const passedIndex = Math.round(snapped * Math.max(0, levels.length - 1))

  // 每次渲染后把拖动位置写回去（React 会用 style 里的 --pos 覆盖它）
  useLayoutEffect(() => {
    if (dragging) railRef.current?.style.setProperty('--pos', String(posRef.current))
  })

  /** 指针横坐标 → 0–1，超出轨道时夹在两端 */
  const ratioAt = (clientX: number): number => {
    const rail = railRef.current
    if (rail === null) return 0
    const rect = rail.getBoundingClientRect()
    if (rect.width <= 0) return 0
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
  }

  /** 直接把位置写进 CSS 变量：跟手的关键 */
  const applyPos = (next: number): void => {
    posRef.current = next
    railRef.current?.style.setProperty('--pos', String(next))
  }

  const startDrag = (event: React.PointerEvent): void => {
    if (disabled || levels.length < 2) return
    event.preventDefault()
    setDragging(true)
    applyPos(magnetizeRatio(ratioAt(event.clientX), levels.length))

    // 手势挂在 document 上：拖出滑条再拖回来也不会断
    const onMove = (moveEvent: PointerEvent): void => {
      applyPos(magnetizeRatio(ratioAt(moveEvent.clientX), levels.length))
    }
    const finish = (upEvent: PointerEvent): void => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', finish)
      document.removeEventListener('pointercancel', finish)
      const ratio = magnetizeRatio(ratioAt(upEvent.clientX), levels.length)
      const picked = levels[ratioToIndex(ratio, levels.length)]
      setDragging(false)
      applyPos(ratio)
      if (picked !== undefined && picked.id !== value) onPick(picked.id)
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', finish)
    document.addEventListener('pointercancel', finish)
  }

  const moveTo = (next: number): void => {
    if (disabled || levels.length < 2) return
    const target = levels[Math.min(levels.length - 1, Math.max(0, next))]
    if (target !== undefined && target.id !== value) onPick(target.id)
  }

  const railStyle = {
    '--pos': snapped,
    '--fill': palette.fill,
    '--track': palette.track,
  } as CSSProperties

  // 单档 / 无档位：滑条没意义，交给调用方决定要不要渲染，这里再兜一次
  if (levels.length < 2) return null

  return (
    <div
      ref={railRef}
      className={clsx(styles.rail, dragging && styles.railDragging, palette.peak && styles.railPeak)}
      style={railStyle}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-disabled={disabled}
      aria-valuemin={0}
      aria-valuemax={levels.length - 1}
      aria-valuenow={index}
      aria-valuetext={level?.name ?? ''}
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
        style={palette.peak ? { background: PEAK_GRADIENT, backgroundSize: '300% 100%' } : undefined}
      />
      {levels.map((item, itemIndex) => (
        <span
          key={item.id}
          className={clsx(styles.dot, itemIndex <= passedIndex && styles.dotPassed)}
          style={{ '--tick': itemIndex / (levels.length - 1) } as CSSProperties}
        />
      ))}
      <div className={styles.knob} />
    </div>
  )
}

/** 档位标签行：滑条下面一行小字（左端最低档、右端最高档），窄屏也不会挤 */
export const EffortEnds = ({ levels }: { levels: readonly RemoteModelEffort[] }) => {
  if (levels.length < 2) return null
  return (
    <div className={styles.ends} aria-hidden>
      <span>{levels[0]?.name}</span>
      <span>{levels[levels.length - 1]?.name}</span>
    </div>
  )
}
