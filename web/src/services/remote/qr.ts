/**
 * Chat Pad 远程 DSH：扫码登录的二维码渲染（纯前端、不碰 DOM、不碰 Node API）。
 *
 * 为什么用 `qrcode-generator`（v2.0.4，MIT，约 20KB，纯 JS、零依赖）：
 *   1. 它自带 `createDataURL()`，**不需要 canvas** —— WebView 里 canvas 不是每个
 *      Android 版本都稳（且拿不到 context 时会静默出空白图），而 `<img src="data:…">`
 *      在 4.4+ 全支持；
 *   2. 也自带 `createSvgTag()`，矢量渲染可选中；
 *   3. 同一份实现能在 `tsx`（Node）里跑，二维码单测不需要浏览器环境；
 *   4. MIT + 无传递依赖，比 `qrcode`（依赖 `dijkstrajs`/`pngjs` 等，走 Node Buffer 分支）
 *      更适合打进 WebView 包。
 *
 * 只导出两个渲染函数 + 一个模块数探测函数：UI 需要 `<img>` 就给 data URL，
 * 需要矢量 / 可缩放就给 SVG 字符串；矩阵细节不外泄，避免 UI 自己拼 canvas。
 */

import qrcode from 'qrcode-generator'

import { RemoteApiError } from './serverApi.js'

/** 纠错级别：M（15%）兼顾容量与容错。平板屏幕有反光、扫码距离远，别用 L。 */
export type QrErrorCorrection = 'L' | 'M' | 'Q' | 'H'

export interface QrRenderOptions {
  /** 每个模块的像素，默认 4（33 模块的典型 URL → 约 164px，设置页里够大） */
  cellSize?: number
  /** 静区（模块数），默认 4（QR 规范建议 ≥4，太小手机对不上） */
  margin?: number
  /** 纠错级别，默认 `M` */
  ecLevel?: QrErrorCorrection
}

/** 默认值集中一处，UI 想统一改大小只改这里 */
export const QR_DEFAULT_CELL_SIZE = 4
export const QR_DEFAULT_MARGIN = 4
export const QR_DEFAULT_EC_LEVEL: QrErrorCorrection = 'M'

const messageOf = (value: unknown): string =>
  value instanceof Error ? value.message : typeof value === 'string' ? value : '未知错误'

/**
 * 内容 → QR 模块矩阵（未渲染）。
 *
 * 空内容直接拒：扫一个空码没有任何意义，而 `addData('')` 在库里是合法调用，
 * 会产出一张「能扫但没有内容」的图 —— 那比报错更难排查。
 */
const buildQr = (text: string, options: QrRenderOptions) => {
  const value = text.trim()
  if (value.length === 0) throw new RemoteApiError('INVALID_ARGUMENT', '二维码内容不能为空')
  const qr = qrcode(0, options.ecLevel ?? QR_DEFAULT_EC_LEVEL)
  try {
    qr.addData(value)
    qr.make()
  } catch (error) {
    // 库在超容量时抛 "code length overflow"，这不是 bug，是内容（scanUrl）太长
    throw new RemoteApiError(
      'QR_TOO_LONG',
      `生成二维码失败（内容 ${value.length} 字符，可能超出容量）：${messageOf(error)}`,
      undefined,
      false,
      { length: value.length },
    )
  }
  return qr
}

/**
 * 生成 `data:image/gif;base64,…`，直接给 `<img src>`。
 *
 * 选 GIF 而不是 PNG：库的 `createDataURL()` 只有 GIF 实现，**不依赖 canvas**；
 * 1-bit 图形无损，扫码效果与 PNG 完全一致，体积还更小。
 */
export const qrDataUrl = (text: string, options: QrRenderOptions = {}): string =>
  buildQr(text, options).createDataURL(
    options.cellSize ?? QR_DEFAULT_CELL_SIZE,
    options.margin ?? QR_DEFAULT_MARGIN,
  )

/** 生成 SVG 标签（矢量、可任意缩放）；`scalable: true` 时不写死宽高，交给 CSS */
export const qrSvgTag = (text: string, options: QrRenderOptions & { scalable?: boolean } = {}): string =>
  buildQr(text, options).createSvgTag({
    cellSize: options.cellSize ?? QR_DEFAULT_CELL_SIZE,
    margin: options.margin ?? QR_DEFAULT_MARGIN,
    scalable: options.scalable !== false,
  })

/**
 * 模块数（含静区）：UI 想按容器宽度算 `cellSize` 时用它，
 * 例如 `Math.floor(availablePx / moduleCount)`。
 */
export const qrModuleCount = (text: string, options: QrRenderOptions = {}): number =>
  buildQr(text, options).getModuleCount() + (options.margin ?? QR_DEFAULT_MARGIN) * 2
