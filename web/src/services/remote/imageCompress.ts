/**
 * 图片压缩：把「太大传不上去」的图片压到这条连接给得起的体积以内。
 *
 * ## 为什么要它
 *
 * 真机反馈：「有的文件上传会提示大小，太大了」。手机照片动辄 6–15 MiB，而远程上传的天花板
 * 是**传输路径**决定的（`filesApi.ts`：Relay/TURN 工作区上传 20 MiB、会话附件单帧 30 MiB；
 * 只有 LAN/P2P 才给到 1 GiB）。一张 12 MiB 的原图在 relay 上就只能失败 ——
 * 但它压到 1–2 MiB 之后画质对聊天完全够用。**能压就压，别让用户自己去改图片。**
 *
 * ## 纪律
 *
 * 1. **只在真的需要时压**：本来就低于阈值、且长边不夸张的图，一个字节都不动（不损失画质、
 *    不浪费时间）。
 * 2. **压不动就原样返回**（解码失败 / 老 WebView 没有 canvas）：让上传链自己去撞上限，
 *    绝不因为「我压不了」而拦下文件。
 * 3. 输出格式优先 WebP（同画质体积小 25–35%），浏览器不支持就退回 JPEG；PNG 带透明通道时
 *    退成 WebP（支持 alpha），JPEG 不支持 alpha 会被填黑 —— 所以**不做 PNG→JPEG**。
 * 4. 文件名跟着扩展名一起改（Host 会按扩展名判 mediaType），避免「名字是 .png、内容是 jpeg」。
 * 5. 所有浏览器 API 都 `typeof` 守卫（仓库约定：注入到 WebView 的代码不许假定 API 存在）。
 */

/** 能被 canvas 重新编码的图片类型（GIF 会丢动画、SVG/HEIC 解码不了，一律不碰）。 */
const COMPRESSIBLE = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp'])

/** 长边逐级尝试（从大到小；够用就停）。 */
const EDGE_STEPS = [2560, 2048, 1600, 1280, 1024, 800] as const
/** 画质逐级尝试。 */
const QUALITY_STEPS = [0.9, 0.82, 0.74, 0.66, 0.58] as const

/** 低于这个体积、且长边不超过首档的图，不压（再压只会掉画质）。 */
export const COMPRESS_TRIGGER_BYTES = 1_500_000

export interface ImageCompressResult {
  /** 要上传的内容（压缩成功 = 压缩后的 blob；否则就是原文件）。 */
  blob: Blob
  /** 上传用的文件名（压缩后扩展名会跟着换）。 */
  name: string
  mediaType: string
  originalBytes: number
  bytes: number
  /** 真的压过（体积变了）才 true。 */
  compressed: boolean
  /** 压不了 / 压了也不够小的说明（仅用于日志，不阻断上传）。 */
  note?: string
}

export const isCompressibleImage = (file: { type: string; name: string }): boolean => {
  const type = file.type.toLowerCase()
  if (COMPRESSIBLE.has(type)) return true
  // 有些 Android WebView 给不出 MIME：退回看扩展名
  return /\.(?:jpe?g|png|webp)$/iu.test(file.name)
}

/** 把文件名换成目标格式的扩展名（`照片.HEIC` → `照片.webp`）。 */
const renameForFormat = (name: string, mediaType: string): string => {
  const extension = mediaType === 'image/webp' ? '.webp' : '.jpg'
  const stem = name.replace(/\.[^./\\]*$/u, '')
  return `${stem.length > 0 ? stem : 'image'}${extension}`
}

/** 解码成可绘制源（优先 `createImageBitmap`，老 WebView 退回 `<img>`）。 */
const loadSource = async (
  file: File,
): Promise<{ source: CanvasImageSource; width: number; height: number; release: () => void } | null> => {
  const createBitmap = typeof createImageBitmap === 'function' ? createImageBitmap : undefined
  if (createBitmap !== undefined) {
    try {
      const bitmap = await createBitmap(file)
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() }
    } catch {
      // 落到 <img> 那条路（某些 WebView 对 HEIC/大图会在这里抛）
    }
  }
  if (typeof Image === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return null
  }
  const url = URL.createObjectURL(file)
  const image = new Image()
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('图片解码失败'))
      image.src = url
    })
  } catch {
    URL.revokeObjectURL(url)
    return null
  }
  const width = image.naturalWidth || image.width
  const height = image.naturalHeight || image.height
  if (width <= 0 || height <= 0) {
    URL.revokeObjectURL(url)
    return null
  }
  return { source: image, width, height, release: () => URL.revokeObjectURL(url) }
}

/** 画到 canvas 上并编码；返回 null = 这条 WebView 编不了这个格式。 */
const encode = async (
  source: CanvasImageSource,
  width: number,
  height: number,
  mediaType: string,
  quality: number,
): Promise<Blob | null> => {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (context === null) return null
  // 透明底：JPEG 必须填白，否则透明区域会变黑
  if (mediaType === 'image/jpeg') {
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, width, height)
  }
  context.drawImage(source, 0, 0, width, height)
  const toBlob = canvas.toBlob.bind(canvas)
  const blob = await new Promise<Blob | null>((resolve) => {
    toBlob((value) => resolve(value), mediaType, quality)
  })
  if (blob === null) return null
  // 浏览器不支持请求的格式时会静默回退成 PNG —— 那等于没压，按失败处理
  if (blob.type !== mediaType) return null
  return blob
}

/**
 * 压缩一张图片，尽量让结果 ≤ `maxBytes`。
 *
 * 返回的 `compressed` 只有**真的变小了**才为 true；任何一步失败都原样返回输入，
 * 让上传链按原来的规则去试（压缩是优化，不是前置条件）。
 */
export const compressImageFile = async (file: File, maxBytes: number): Promise<ImageCompressResult> => {
  const originalBytes = file.size
  const asIs: ImageCompressResult = {
    blob: file,
    name: file.name,
    mediaType: file.type.length > 0 ? file.type : 'application/octet-stream',
    originalBytes,
    bytes: originalBytes,
    compressed: false,
  }
  if (!isCompressibleImage(file)) return { ...asIs, note: '不是可压缩的图片类型' }
  if (originalBytes <= COMPRESS_TRIGGER_BYTES && maxBytes > originalBytes) {
    return { ...asIs, note: '体积本来就够小' }
  }
  const source = await loadSource(file)
  if (source === null) return { ...asIs, note: '解不开这张图（解码失败）' }
  try {
    const longest = Math.max(source.width, source.height)
    const preferWebp = await supportsWebp(source)
    const mediaType = preferWebp ? 'image/webp' : 'image/jpeg'
    let best: Blob | null = null
    for (const edge of EDGE_STEPS) {
      // 原图本来就更小：不要放大（放大只会更大更糊）
      const scale = Math.min(1, edge / longest)
      const width = Math.max(1, Math.round(source.width * scale))
      const height = Math.max(1, Math.round(source.height * scale))
      for (const quality of QUALITY_STEPS) {
        const blob = await encode(source.source, width, height, mediaType, quality)
        if (blob === null) {
          // 这个格式编不出来：换 JPEG 再试一次这一档，之后不再换
          if (mediaType !== 'image/jpeg') break
          return { ...asIs, note: '这个 WebView 没法重新编码图片' }
        }
        if (best === null || blob.size < best.size) best = blob
        if (blob.size <= maxBytes) {
          return finish(best ?? blob, file, mediaType, originalBytes)
        }
      }
      // 边长已经缩到头还超：别继续缩成马赛克，交给上传链报「太大」
      if (width <= 640 || height <= 640) break
    }
    return { ...asIs, note: `压到 ${best?.size ?? originalBytes} B 仍然超过上限 ${maxBytes} B` }
  } finally {
    source.release()
  }
}

const finish = (
  blob: Blob,
  file: File,
  mediaType: string,
  originalBytes: number,
): ImageCompressResult =>
  blob.size < originalBytes
    ? {
        blob,
        name: renameForFormat(file.name, mediaType),
        mediaType,
        originalBytes,
        bytes: blob.size,
        compressed: true,
      }
    : {
        blob: file,
        name: file.name,
        mediaType: file.type.length > 0 ? file.type : 'application/octet-stream',
        originalBytes,
        bytes: originalBytes,
        compressed: false,
        note: '压完反而更大，用原图',
      }

/** 这个 WebView 能不能编 WebP（编不出来就退 JPEG）。 */
const supportsWebp = async (source: { source: CanvasImageSource }): Promise<boolean> => {
  if (typeof document === 'undefined') return false
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const context = canvas.getContext('2d')
  if (context === null) return false
  try {
    context.drawImage(source.source as CanvasImageSource, 0, 0, 1, 1)
  } catch {
    return false
  }
  const toBlob = canvas.toBlob.bind(canvas)
  const blob = await new Promise<Blob | null>((resolve) => {
    toBlob((value) => resolve(value), 'image/webp', 0.8)
  })
  return blob !== null && blob.type === 'image/webp'
}
