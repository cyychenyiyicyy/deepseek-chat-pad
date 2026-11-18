/**
 * 思考强度档位。
 *
 * 取值来源是 models.dev 每个模型的 reasoning_options：
 *   - { type: 'toggle' }                     → 只有开/关两档
 *   - { type: 'effort', values: [...] }      → 具体档位，如 low / high / max
 * 两者都有时（DeepSeek 就是这种）滑块最左是「关闭」，往右是各档位。
 */
import type { TranslationKey } from '../../i18n/index.js'
import type { ModelMeta } from './catalog.js'

export type EffortLevel = {
  /** 发送给接口的档位值；off/on 是本地语义 */
  value: string
  labelKey: TranslationKey
}

const LEVEL_LABEL: Record<string, TranslationKey> = {
  off: 'effortOff',
  on: 'effortOn',
  none: 'effortOff',
  minimal: 'effortMinimal',
  low: 'effortLow',
  medium: 'effortMedium',
  high: 'effortHigh',
  xhigh: 'effortXHigh',
  max: 'effortMax',
  ultra: 'effortUltra',
}

const labelOf = (value: string): TranslationKey => LEVEL_LABEL[value] ?? 'effortHigh'

/** 根据模型元信息推导可用的档位列表；不支持思考的模型返回空数组 */
export const buildEffortLevels = (meta: ModelMeta | null | undefined): EffortLevel[] => {
  if (!meta?.reason) {
    return []
  }
  const values = (meta.effort ?? []).filter((value) => value !== 'none')
  const hasToggle = Boolean(meta.ropt?.includes('toggle')) || (meta.effort ?? []).includes('none')

  const levels: EffortLevel[] = []
  if (hasToggle) {
    levels.push({ value: 'off', labelKey: labelOf('off') })
  }
  for (const value of values) {
    levels.push({ value, labelKey: labelOf(value) })
  }
  // 只有开关的模型（如 kimi-k2.6）：off / on
  if (!hasToggle && values.length === 0) {
    levels.push({ value: 'off', labelKey: labelOf('off') }, { value: 'on', labelKey: labelOf('on') })
  }
  return levels
}

/**
 * 把保存的档位落到当前模型上：
 * 模型换过之后原来的档位可能不存在（比如从 max 换到只有 off/on 的模型），
 * 这里就近取值，保证滑块永远落在合法位置上。
 */
export const resolveEffortIndex = (levels: EffortLevel[], current: string): number => {
  if (levels.length === 0) return 0
  const exact = levels.findIndex((level) => level.value === current)
  if (exact >= 0) return exact
  if (current === 'off') return 0
  // 未知档位：退到中间偏上一档，至少不会静默变成关闭
  return Math.max(0, levels.length - 2)
}

/**
 * DeepSeek 的档位映射（官方文档）：minimal/low → low，medium/high/xhigh → high，max/ultra → max。
 * Anthropic 兼容格式用 output_config.effort，只接受 low / high / max。
 */
const DEEPSEEK_EFFORT: Record<string, string> = {
  minimal: 'low',
  low: 'low',
  medium: 'high',
  high: 'high',
  xhigh: 'high',
  max: 'max',
  ultra: 'max',
}

export const deepseekEffort = (value: string): string => DEEPSEEK_EFFORT[value] ?? 'high'

/** 是否要在请求里带档位（off / on 不带宽窄参数） */
export const isExplicitEffort = (value: string): boolean => value !== 'off' && value !== 'on'
