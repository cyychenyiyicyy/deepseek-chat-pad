/**
 * 「保存到系统下载目录」自测（R7）：`services/remote/download.ts`。
 *
 * 跑法（workdir = projects\deepseek-tablet\web）：
 *   npx tsx src/services/remote/__selftest__/download.selftest.mts
 *
 * 三层，都跑**真代码**，只有 HTTP 是假的：
 *   A. 状态探测：`/__ds_download/state.json` 的形状校验（旧 APK 的 SPA 回落必须判成不支持）；
 *   B. 保存：请求体形状、413 / bad_name / 非 JSON 的降级、32 MiB 本地护栏；
 *   C. Android 9 权限流：`permission_denied` → 申请 → 轮询 `canWrite` → **重试一次**。
 *
 * 结尾按仓库约定设置真实退出码，并且**先删旧报告**（崩在半路不留上一次的结论）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { useToast } from '../../../components/base/toastState.js'
import {
  DOWNLOAD_MAX_BYTES,
  DOWNLOAD_PERMISSION_PATH,
  DOWNLOAD_SAVE_PATH,
  DOWNLOAD_STATE_PATH,
  DownloadError,
  downloadFromUrl,
  downloadWorkspacePath,
  fetchDownloadState,
  isDownloadSupported,
  saveToDownloads,
} from '../download.js'
import type { FetchLike } from '../serverApi.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// 目录里还有别的自测：报告名字带前缀，别互相覆盖
const REPORT = path.join(HERE, 'download.report.txt')
try {
  fs.unlinkSync(REPORT)
} catch {
  /* 没有旧报告 */
}

/* ── 运行环境垫片：toastState 用了 window.setTimeout ── */
const shim = globalThis as unknown as Record<string, unknown>
if (shim.window === undefined) {
  shim.window = {
    setTimeout: (handler: () => void, timeout?: number) => setTimeout(handler, timeout),
    clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
  }
}

type Recorded = { url: string; method: string; body: string }

interface FakeReply {
  status: number
  text: string
}

/** 按顺序回放一批响应，同时记录每次请求（断言请求体 / 顺序用）。 */
const makeFetch = (replies: FakeReply[]): { fetch: FetchLike; calls: Recorded[] } => {
  const calls: Recorded[] = []
  let index = 0
  const fake: FetchLike = async (input, init) => {
    const url = typeof input === 'string' ? input : String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = typeof init?.body === 'string' ? init.body : ''
    calls.push({ url, method, body })
    const reply = replies[Math.min(index, replies.length - 1)] ?? { status: 404, text: '' }
    index += 1
    return new Response(reply.text, { status: reply.status })
  }
  return { fetch: fake, calls }
}

const results: Array<{ level: 'PASS' | 'FAIL'; name: string; detail?: string }> = []
const check = async (name: string, run: () => Promise<void>): Promise<void> => {
  try {
    await run()
    results.push({ level: 'PASS', name })
  } catch (error) {
    results.push({
      level: 'FAIL',
      name,
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}

const expect = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message)
}

const expectRejects = async (run: () => Promise<unknown>, code: string): Promise<unknown> => {
  try {
    await run()
  } catch (error) {
    if (error instanceof DownloadError && error.code === code) return error
    throw new Error(`期望 DownloadError(${code})，实际是 ${String(error)}`)
  }
  throw new Error(`期望抛 DownloadError(${code})，但它成功了`)
}

const lastToast = (): unknown => useToast.getState().message

const base64Of = (text: string): string => Buffer.from(text, 'utf8').toString('base64')

const stateBody = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    ok: true,
    canWrite: true,
    dir: 'Download',
    relativePath: 'Download/',
    sdkInt: 34,
    needsPermission: false,
    ...overrides,
  })

const okSaveBody = (displayName: string, uri = 'content://media/external/downloads/42'): string =>
  JSON.stringify({ ok: true, uri, displayName, relativePath: 'Download/' })

/* ───────────────────────────── A. 状态探测 ───────────────────────────── */

await check('A1 状态：正常形状 → canWrite / dir / sdkInt 都对', async () => {
  const fake = makeFetch([{ status: 200, text: stateBody() }])
  const state = await fetchDownloadState({ fetch: fake.fetch })
  expect(fake.calls[0]?.url === DOWNLOAD_STATE_PATH, `探测路径不是 state.json：${fake.calls[0]?.url}`)
  expect(fake.calls[0]?.method === 'GET', '状态探测必须是 GET')
  expect(state !== null, '正常形状不该是 null')
  expect(state?.canWrite === true, 'canWrite 应为 true')
  expect(state?.dir === 'Download', `dir 应为 Download，实际 ${state?.dir}`)
  expect(state?.relativePath === 'Download/', 'relativePath 默认值不对')
  expect(state?.sdkInt === 34, `sdkInt 应为 34，实际 ${state?.sdkInt}`)
  expect(state?.needsPermission === false, 'needsPermission 应为 false')
})

await check('A2 状态：旧 APK 的 SPA 回落（200 + HTML）判成不支持', async () => {
  const fake = makeFetch([{ status: 200, text: '<!doctype html><html><body>index</body></html>' }])
  expect((await fetchDownloadState({ fetch: fake.fetch })) === null, 'HTML 200 必须判成 null')
  const missing = makeFetch([{ status: 404, text: '{"ok":false,"error":"not_found"}' }])
  expect((await isDownloadSupported({ fetch: missing.fetch })) === false, '404 必须判成不支持')
})

/* ───────────────────────────── B. 保存 ───────────────────────────── */

await check('B1 保存：POST /save，body 带 name/mime/dataBase64，成功 toast 用实际文件名', async () => {
  const fake = makeFetch([{ status: 200, text: okSaveBody('shot.png') }])
  const result = await saveToDownloads('aGVsbG8=', 'shot.png', 'image/png', { fetch: fake.fetch })
  const call = fake.calls[0]
  expect(call !== undefined, '没有发出请求')
  expect(call?.url === DOWNLOAD_SAVE_PATH, `路径不对：${call?.url}`)
  expect(call?.method === 'POST', '保存必须是 POST')
  const body = JSON.parse(call?.body ?? '{}') as Record<string, unknown>
  expect(body.name === 'shot.png', `name 不对：${String(body.name)}`)
  expect(body.mime === 'image/png', `mime 不对：${String(body.mime)}`)
  expect(body.dataBase64 === 'aGVsbG8=', `dataBase64 不对：${String(body.dataBase64)}`)
  expect(result.displayName === 'shot.png', `displayName 不对：${result.displayName}`)
  expect(result.relativePath === 'Download/', 'relativePath 不对')
  const toast = lastToast() as { key?: string; params?: Record<string, unknown> } | null
  expect(toast?.key === 'downloadSaved', `成功 toast 的 key 不对：${String(toast?.key)}`)
  expect(toast?.params?.name === 'shot.png', '成功 toast 要带实际文件名')
})

await check('B2 保存：服务端 413 → too_large + 可读 toast', async () => {
  const fake = makeFetch([{ status: 413, text: '{"ok":false,"error":"too_large"}' }])
  await expectRejects(() => saveToDownloads('aGVsbG8=', 'big.bin', undefined, { fetch: fake.fetch }), 'too_large')
  const toast = lastToast() as { key?: string } | null
  expect(toast?.key === 'downloadTooLarge', `toast 应为 downloadTooLarge，实际 ${String(toast?.key)}`)
})

await check('B3 保存：原生 error 码 bad_name 原样上传给界面', async () => {
  const fake = makeFetch([{ status: 200, text: '{"ok":false,"error":"bad_name"}' }])
  await expectRejects(() => saveToDownloads('aGVsbG8=', '...', undefined, { fetch: fake.fetch }), 'bad_name')
  const toast = lastToast() as { key?: string } | null
  expect(toast?.key === 'downloadBadName', `toast 应为 downloadBadName，实际 ${String(toast?.key)}`)
})

await check('B4 保存：旧 APK 回 HTML（200）→ unsupported，不装成功', async () => {
  const fake = makeFetch([{ status: 200, text: '<html>index</html>' }])
  await expectRejects(() => saveToDownloads('aGVsbG8=', 'a.txt', undefined, { fetch: fake.fetch }), 'unsupported')
  const toast = lastToast() as { key?: string } | null
  expect(toast?.key === 'downloadUnsupported', `toast 应为 downloadUnsupported，实际 ${String(toast?.key)}`)
})

await check('B5 保存：超过 32 MiB 的 base64 本地就挡掉，一个请求都不发', async () => {
  const fake = makeFetch([{ status: 200, text: okSaveBody('x.bin') }])
  // base64 长度 ×3/4 > 32 MiB
  const huge = 'A'.repeat(Math.ceil((DOWNLOAD_MAX_BYTES * 4) / 3) + 8)
  await expectRejects(() => saveToDownloads(huge, 'huge.bin', undefined, { fetch: fake.fetch }), 'too_large')
  expect(fake.calls.length === 0, `超限时不该发请求，实际发了 ${fake.calls.length} 次`)
})

await check('B6 保存：data: URL 的图片 → 原样取 base64 和 MIME', async () => {
  const payload = base64Of('not-really-a-png')
  const fake = makeFetch([{ status: 200, text: okSaveBody('pic.png') }])
  await downloadFromUrl(`data:image/png;base64,${payload}`, 'pic.png', undefined, {
    fetch: fake.fetch,
  })
  const body = JSON.parse(fake.calls[0]?.body ?? '{}') as Record<string, unknown>
  expect(body.dataBase64 === payload, 'data URL 的 base64 没有原样透传')
  expect(body.mime === 'image/png', `data URL 的 MIME 没取到：${String(body.mime)}`)
})

/* ───────────────────────────── C. Android 9 权限流 ───────────────────────────── */

await check('C1 权限流：403 permission_denied → 申请 → 轮询到 canWrite → 重试一次成功', async () => {
  const fake = makeFetch([
    // 第一次保存：没权限
    { status: 403, text: '{"ok":false,"error":"permission_denied"}' },
    // 申请权限
    { status: 200, text: stateBody({ canWrite: false, sdkInt: 28, needsPermission: true }) },
    // 轮询：第一次已授权
    { status: 200, text: stateBody({ canWrite: true, sdkInt: 28, needsPermission: true }) },
    // 重试保存
    { status: 200, text: okSaveBody('a.txt') },
  ])
  const result = await saveToDownloads('aGVsbG8=', 'a.txt', undefined, { fetch: fake.fetch })
  expect(result.displayName === 'a.txt', '重试后应成功')
  const urls = fake.calls.map((call) => `${call.method} ${call.url}`)
  expect(urls[0] === `POST ${DOWNLOAD_SAVE_PATH}`, `第一步应为 save，实际 ${urls[0]}`)
  expect(urls[1] === `POST ${DOWNLOAD_PERMISSION_PATH}`, `第二步应为 permission，实际 ${urls[1]}`)
  expect(urls.includes(`GET ${DOWNLOAD_STATE_PATH}`), '没有轮询 canWrite')
  expect(urls.filter((url) => url === `POST ${DOWNLOAD_SAVE_PATH}`).length === 2, '重试次数不是一次')
  const toast = lastToast() as { key?: string } | null
  expect(toast?.key === 'downloadSaved', `最终应是成功 toast，实际 ${String(toast?.key)}`)
})

/* ───────────────────────────── D. 工作区入口 ───────────────────────────── */

await check('D1 工作区下载：没连接 → not_connected，给「保存失败」而不是静默', async () => {
  await expectRejects(() => downloadWorkspacePath('a/b.txt', { scopeId: null }), 'not_connected')
  const toast = lastToast() as { key?: string } | null
  expect(toast?.key === 'downloadFailed', `toast 应为 downloadFailed，实际 ${String(toast?.key)}`)
})

/* ───────────────────────────── 汇总 ───────────────────────────── */

const failures = results.filter((row) => row.level === 'FAIL')
const lines = results.map((row) =>
  row.level === 'PASS' ? `[PASS] ${row.name}` : `[FAIL] ${row.name} — ${row.detail ?? ''}`,
)
lines.push('', `总计 ${results.length} 项，${results.length - failures.length} PASS / ${failures.length} FAIL`)
const report = `${lines.join('\n')}\n`
fs.writeFileSync(REPORT, report, 'utf8')
process.stdout.write(report)
process.exit(failures.length === 0 ? 0 : 1)
