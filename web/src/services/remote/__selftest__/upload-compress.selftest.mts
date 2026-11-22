/**
 * 图片压缩自测（R19）。
 *
 * 真机反馈：「有的文件上传会提示大小，太大了」。压缩是解法，但它必须**只能加分不能减分**：
 * 压不动的时候原样上传，绝不能因为压缩失败把文件拦下来。
 *
 * 跑法（workdir = projects\deepseek-tablet\web）：
 *   npx tsx src/services/remote/__selftest__/upload-compress.selftest.mts
 *
 * 覆盖：
 *   A. `isCompressibleImage()`：认 MIME，也认“没有 MIME 只有扩展名”的 Android WebView；
 *      GIF / HEIC / PDF / SVG 一律不碰（GIF 会丢动画，其余解码不了）。
 *   B. 压缩触发条件：小图不压（不损画质）。
 *   C. **环境不支持时原样返回**（node 里没有 canvas/DOM —— 正是老 WebView 的替身）：
 *      不抛、不报错、`compressed === false`，上传链照常往下走。
 *   D. 非图片（PDF）原样返回：超限判定是上传链的事，压缩不掺和。
 */

import { COMPRESS_TRIGGER_BYTES, compressImageFile, isCompressibleImage } from '../imageCompress.js'

/* ── 最小断言器（与其它 selftest 同一套写法） ─────────────────────────── */

const checks: Array<{ name: string; run: () => Promise<void> }> = []
const check = (name: string, run: () => Promise<void>): void => {
  checks.push({ name, run })
}

const fail = (message: string): never => {
  throw new Error(message)
}

const assertEqual = (actual: unknown, expected: unknown, label: string): void => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) fail(`${label}：期望 ${e}，实际 ${a}`)
}

const assertTrue = (value: boolean, label: string): void => {
  if (!value) fail(label)
}

const fileOf = (bytes: number, name: string, type: string): File =>
  new File([new Uint8Array(bytes)], name, { type })

/* ══════════════════════════════════════════════════════════════════════
 * A. 类型判定
 * ══════════════════════════════════════════════════════════════════════ */

check('A1 常见图片：按 MIME 认', async () => {
  assertTrue(isCompressibleImage({ type: 'image/jpeg', name: 'a.jpg' }), 'jpeg')
  assertTrue(isCompressibleImage({ type: 'image/png', name: 'a.png' }), 'png')
  assertTrue(isCompressibleImage({ type: 'image/webp', name: 'a.webp' }), 'webp')
})

check('A2 没有 MIME 的 Android WebView：按扩展名认', async () => {
  assertTrue(isCompressibleImage({ type: '', name: 'IMG_0042.JPG' }), '大写扩展名也要认')
  assertTrue(isCompressibleImage({ type: '', name: '截图.照片.png' }), '中文文件名')
})

check('A3 压不了的类型一律不碰', async () => {
  assertEqual(isCompressibleImage({ type: 'image/gif', name: '动图.gif' }), false, 'GIF 会丢动画')
  assertEqual(isCompressibleImage({ type: 'image/heic', name: 'IMG.heic' }), false, 'HEIC 解不了')
  assertEqual(isCompressibleImage({ type: 'application/pdf', name: '报告.pdf' }), false, 'PDF 不是图片')
  assertEqual(isCompressibleImage({ type: 'image/svg+xml', name: 'a.svg' }), false, 'SVG 不是位图')
})

/* ══════════════════════════════════════════════════════════════════════
 * B/C/D. 压缩入口的纪律
 * ══════════════════════════════════════════════════════════════════════ */

check('B1 小图不压：体积没超阈值就一个字节都不动', async () => {
  const small = fileOf(COMPRESS_TRIGGER_BYTES - 1, 'small.jpg', 'image/jpeg')
  const result = await compressImageFile(small, 20 * 1024 * 1024)
  assertEqual(result.compressed, false, '不该压')
  assertEqual(result.name, 'small.jpg', '名字不变')
  assertEqual(result.bytes, small.size, '体积不变')
  assertEqual(result.blob, small, '还是原来那个 File')
})

check('C1 环境不支持 canvas（老 WebView / node）：原样返回且不抛', async () => {
  const big = fileOf(COMPRESS_TRIGGER_BYTES + 4_000_000, 'big.jpg', 'image/jpeg')
  const result = await compressImageFile(big, 2 * 1024 * 1024)
  assertEqual(result.compressed, false, '压不了就压不了')
  assertEqual(result.blob, big, '必须原样返回 —— 上传链照常往下走')
  assertEqual(result.bytes, big.size, '体积不变')
  assertTrue((result.note ?? '').length > 0, '要给出原因（日志/排障用）')
})

check('C2 上限比图还小很多，也一样不抛（只是压不动）', async () => {
  const big = fileOf(COMPRESS_TRIGGER_BYTES * 4, 'huge.png', 'image/png')
  const result = await compressImageFile(big, 1024)
  assertEqual(result.compressed, false, '这条环境没有 canvas，本来就压不了')
  assertEqual(result.blob, big, '不阻断')
})

check('D1 PDF 完全不掺和（超限是上传链的判定）', async () => {
  const pdf = fileOf(COMPRESS_TRIGGER_BYTES * 3, '报告.pdf', 'application/pdf')
  const result = await compressImageFile(pdf, 1024 * 1024)
  assertEqual(result.compressed, false, '不压')
  assertEqual(result.blob, pdf, '原样返回')
  assertEqual(result.mediaType, 'application/pdf', '类型保持不变')
})

/* ── 跑 ───────────────────────────────────────────────────────────────── */

const main = async (): Promise<void> => {
  let failures = 0
  for (const item of checks) {
    try {
      await item.run()
      console.log(`PASS  ${item.name}`)
    } catch (error) {
      failures += 1
      console.error(`FAIL  ${item.name}`)
      console.error(`      ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  console.log(`\n${checks.length - failures} PASS / ${failures} FAIL / ${checks.length} TOTAL`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
