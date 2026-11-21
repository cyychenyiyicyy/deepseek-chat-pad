import clsx from 'clsx'
import type { ReactNode } from 'react'
import type { TranslationKey } from '../../../i18n/index.js'
import { IconChevronDownOutline14, IconThinkOutline16 } from '../../base/icons.js'
import styles from './NewSessionPanel.module.css'

/**
 * 新建会话页的三档控件 —— 尺寸全部照 dsh-Go 的 `empty_actions.dart` 搬过来：
 *
 * | 控件 | 高 | 左右内边距 | 字号 | 图标 | 底色 |
 * |---|---|---|---|---|---|
 * | `QuietChip`（工作区） | 36 | 14 | 14（bodyMedium） | 16 + 6 | 7% 白（暗）/ 5% 墨（亮） |
 * | `SetupItem`（选项行：模型 / 助手 / 权限） | 32 | 8 | 13 | 14 + 5 | 无（按下才亮） |
 * | `PrimaryPill`（创建并进入） | 36 | 18 | 14 / 600 | — | 品牌色 |
 *
 * 这三档是**刻意分层的**：工作区是「这次对话在哪」，选项行是「这次对话怎么跑」，
 * 只有主操作是实心按钮 —— dsh-Go 的原话是「a row of them reads as this chat's settings
 * rather than as more buttons」。
 */

/** 工作区胶囊：安静底 + 图标 + 一行字 + 可选的下拉箭头。 */
export const QuietChip = ({
  icon,
  label,
  onClick,
  ariaLabel,
  disabled = false,
  className,
}: {
  icon: ReactNode
  label: string
  onClick?: () => void
  ariaLabel?: string
  disabled?: boolean
  className?: string
}) => (
  <button
    type="button"
    className={clsx(styles.chip, className)}
    aria-label={ariaLabel ?? label}
    disabled={disabled || onClick === undefined}
    onClick={onClick}
  >
    <span className={styles.chipIcon} aria-hidden>
      {icon}
    </span>
    <span className={styles.chipLabel}>{label}</span>
    <span className={styles.chipChevron} aria-hidden>
      <IconChevronDownOutline14 />
    </span>
  </button>
)

/**
 * 选项行里的**胶囊**（模型 / 权限预设 / agent preset 三个一排）。
 *
 * 与工作区胶囊的区别只有尺寸：这排是 34px / 13 号、更淡一点的底，读起来是「这次对话的设置」，
 * 而工作区那枚是 36px / 14 号，是「在哪工作」这个大选择。
 */
export const OptionPill = ({
  icon,
  label,
  onClick,
  ariaLabel,
  disabled = false,
}: {
  icon: ReactNode
  label: string
  onClick?: () => void
  ariaLabel?: string
  disabled?: boolean
}) => (
  <button
    type="button"
    className={styles.optionPill}
    aria-label={ariaLabel ?? label}
    disabled={disabled || onClick === undefined}
    onClick={onClick}
  >
    <span className={styles.optionPillIcon} aria-hidden>
      {icon}
    </span>
    <span className={styles.optionPillLabel}>{label}</span>
    <span className={styles.optionPillChevron} aria-hidden>
      <IconChevronDownOutline14 />
    </span>
  </button>
)

/** 主操作：实心胶囊（dsh-Go 的 `EmptyPrimaryPill`）。 */
export const PrimaryPill = ({
  label,
  onClick,
  disabled = false,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
}) => (
  <button type="button" className={styles.primaryPill} disabled={disabled} onClick={onClick}>
    {label}
  </button>
)

/** 分段控件的一项（思考强度用；dsh-Go 的 `SegmentedPill`）。 */
export const SegmentedPill = <T extends string>({
  segments,
  selected,
  onSelect,
  ariaLabel,
}: {
  segments: { value: T; label: string }[]
  selected: T
  onSelect: (value: T) => void
  ariaLabel?: string
}) => (
  <div className={styles.segments} role="radiogroup" aria-label={ariaLabel}>
    {segments.map((segment) => (
      <button
        key={segment.value}
        type="button"
        role="radio"
        aria-checked={segment.value === selected}
        className={clsx(styles.segment, segment.value === selected && styles.segmentActive)}
        onClick={() => onSelect(segment.value)}
      >
        {segment.label}
      </button>
    ))}
  </div>
)

/** 提示行（dsh-Go 的 `TipLine`）：一枚小图标 + 一行灰字。 */
export const TipLine = ({ text }: { text: string }) => (
  <div className={styles.tip}>
    <span className={styles.tipIcon} aria-hidden>
      <IconThinkOutline16 />
    </span>
    <span className={styles.tipText}>{text}</span>
  </div>
)

/**
 * 思考强度的可读名：协议词（off/low/high/max…）不直接给人看。
 *
 * 与 dsh-Go 的 `effortLabel()`（`model_sheet.dart:51-60`）同一张表；Host 自己给了 `name`
 * 而档位又不在表里时用 Host 的名字，最后才退回原始 id。
 */
const EFFORT_KEYS: Record<string, TranslationKey> = {
  off: 'effortOff',
  none: 'effortOff',
  on: 'effortOn',
  minimal: 'effortMinimal',
  low: 'effortLow',
  medium: 'effortMedium',
  high: 'effortHigh',
  xhigh: 'effortXHigh',
  max: 'effortMax',
  ultra: 'effortUltra',
}

export const effortText = (
  t: (key: TranslationKey) => string,
  id: string,
  name?: string,
): string => {
  const key = EFFORT_KEYS[id]
  if (key !== undefined) return t(key)
  return name !== undefined && name.length > 0 ? name : id
}
