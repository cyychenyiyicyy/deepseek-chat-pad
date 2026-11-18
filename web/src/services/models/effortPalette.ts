/**
 * 思考强度滑条 —— 几何与配色按 Codex 桌面版逐像素复刻。
 *
 * 数据来源（MIT）：ABING1111/dsh-codex-model-effort-selector 的 docs/SPEC.md 与 client.js，
 * 那份规格是用录屏 93 帧量出来的：轨道 248×26、圆角 16、旋钮 30（比轨道高 4px）、
 * 填充宽 = (100% − 30px) × pos + 15px（正好停在旋钮圆心）、刻度点 4px 位于 top:11px，
 * 七档每档一色（蓝 216° → 紫 264°），浅/深两套色板各自求解。
 */

export type EffortBucket = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

const FILL_LIGHT: Record<EffortBucket, string> = {
  off: '#8a8a8f',
  minimal: '#4a8ef8',
  low: '#3a83f7',
  medium: '#4a72f2',
  high: '#5f5ce8',
  xhigh: '#7b48e8',
  max: '#914ef6',
}

const INK_LIGHT: Record<EffortBucket, string> = {
  off: '#707073',
  minimal: '#2b62bd',
  low: '#2f6fd0',
  medium: '#3a55b8',
  high: '#4a3fc0',
  xhigh: '#6a35c8',
  max: '#8b46ee',
}

const FILL_DARK: Record<EffortBucket, string> = {
  off: '#737378',
  minimal: '#3684ff',
  low: '#448dff',
  medium: '#6e90ff',
  high: '#928fff',
  xhigh: '#b18dff',
  max: '#bd91ff',
}

const INK_DARK: Record<EffortBucket, string> = {
  off: '#a9a9ae',
  minimal: '#73a9ff',
  low: '#76aafe',
  medium: '#8ba7ff',
  high: '#a4a2ff',
  xhigh: '#bc9cff',
  max: '#c39bff',
}

/** 轨道底色：浅色是实测的 #e8e7e8，深色是内嵌凹槽 #232324 */
const RAIL_LIGHT = '#e8e7e8'
const RAIL_DARK = '#232324'

/** 未知档位落在 low 与 high 之间 */
const FILL_FALLBACK = { light: '#3a83f7', dark: '#448dff' }
const INK_FALLBACK = { light: '#2f6fd0', dark: '#76aafe' }

/** 轨道按当前档位色染 22%，这样未填充部分也读得出「现在是哪一档」 */
const TRACK_TINT = 0.22

export const effortBucket = (value: string): EffortBucket | null => {
  const key = value.toLowerCase().trim()
  if (['off', 'none', '关闭'].includes(key)) return 'off'
  if (key === 'minimal') return 'minimal'
  if (key === 'low') return 'low'
  if (key === 'medium' || key === 'mid') return 'medium'
  if (key === 'high') return 'high'
  if (key === 'xhigh' || key === 'xhigh'.replace('x', 'extra-')) return 'xhigh'
  if (key === 'max' || key === 'ultra') return 'max'
  return null
}

const hexToRgb = (hex: string): [number, number, number] => {
  const clean = hex.replace('#', '')
  return [
    Number.parseInt(clean.slice(0, 2), 16),
    Number.parseInt(clean.slice(2, 4), 16),
    Number.parseInt(clean.slice(4, 6), 16),
  ]
}

const toHex = (value: number) => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0')

/** 把 fill 以 alpha 混到轨道底色上，等价于 Codex 的 22% 染色 */
const tint = (fill: string, base: string, amount: number): string => {
  const [fr, fg, fb] = hexToRgb(fill)
  const [br, bg, bb] = hexToRgb(base)
  return `#${toHex(fr * amount + br * (1 - amount))}${toHex(fg * amount + bg * (1 - amount))}${toHex(fb * amount + bb * (1 - amount))}`
}

export type EffortPalette = {
  fill: string
  ink: string
  track: string
  /** 最高档走紫罗兰流动渐变，并隐去刻度点 */
  peak: boolean
}

export const effortPalette = (value: string, dark: boolean): EffortPalette => {
  const bucket = effortBucket(value)
  const fill = bucket ? (dark ? FILL_DARK : FILL_LIGHT)[bucket] : dark ? FILL_FALLBACK.dark : FILL_FALLBACK.light
  const ink = bucket ? (dark ? INK_DARK : INK_LIGHT)[bucket] : dark ? INK_FALLBACK.dark : INK_FALLBACK.light
  return {
    fill,
    ink,
    track: tint(fill, dark ? RAIL_DARK : RAIL_LIGHT, TRACK_TINT),
    peak: bucket === 'max',
  }
}

/** 最高档的填充渐变：蓝 → 紫，与 Codex 的 Ultra 一致 */
export const PEAK_GRADIENT = 'linear-gradient(90deg, #3b83f6 0%, #6473fa 35%, #8d80fc 62%, #914ef6 100%)'
