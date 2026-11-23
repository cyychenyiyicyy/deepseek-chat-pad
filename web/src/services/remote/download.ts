/**
 * 远程 DSH：把图片 / 文件**保存到系统「下载」目录**（原生 `/__ds_download/*`，R7）。
 *
 * ## 为什么要有这一层
 *
 * 工作区预览与工具卡里的图片以前只能看：想留存只能长按截图。原生新开了三条路由，
 * 这里负责「怎么把字节交给原生 + 失败怎么给人话」：
 *
 * | 端点 | 方法 | 语义 |
 * |---|---|---|
 * | `/__ds_download/save`        | POST | `{name, mime, dataBase64}`；单文件 ≤ 32 MiB，超限 413 `too_large` |
 * | `/__ds_download/state.json`  | GET  | `{ok, canWrite, dir, sdkInt}`；**探测必须用带 `.json` 的这条** |
 * | `/__ds_download/permission`  | POST | Android 9 上申请存储写权限（29+ 直接回已授予） |
 *
 * ⚠️ **探测为什么用 `.json`**：旧 APK 的静态兜底会把无扩展名的未知路径回落成
 * `index.html` 且回 **200** —— 拿 `/__ds_download/state` 探测会把「不支持」误判成「支持」。
 *
 * ## 三条纪律
 *
 * 1. **32 MiB 是硬上限**：`localServer` 那侧还有一层请求体上限（48 MiB，base64 膨胀后）。
 *    超过就直接给可读原因，别把 44 MB 的 JSON 发出去再被 413。
 * 2. **Android 9 的权限只能用户点了才有**：第一次 `permission_denied` 时调
 *    `/__ds_download/permission` 弹系统框，然后**轮询 `canWrite` 再重试一次**；
 *    不要自己写 `requestPermissions`（页面拿不到 Activity）。
 * 3. **失败一定有人话**：`too_large` / `bad_name` / `permission_denied` / `io_error` 各有文案，
 *    未知原因退到「保存失败：<原始消息>」。
 */

import { showToast } from '../../components/base/toastState.js'
import { translate, type LinkedMessage, type TranslationKey } from '../../i18n/index.js'
import {
  baseNameOf,
  decodeBase64,
  encodeBase64,
  errorCodeOf,
  readWorkspaceBytesRange,
  statWorkspaceFile,
} from './filesApi.js'
import { lastRemoteTarget, type RemoteCallTarget } from './sessionsApi.js'
import type { FetchLike } from './serverApi.js'
import { useRemoteStore } from './store.js'

/** 保存一个文件（POST JSON）。 */
export const DOWNLOAD_SAVE_PATH = '/__ds_download/save'
/** 能力 + 状态（GET；**必须带 `.json`**，见文件头）。 */
export const DOWNLOAD_STATE_PATH = '/__ds_download/state.json'
/** Android 9 的存储写权限（POST） */
export const DOWNLOAD_PERMISSION_PATH = '/__ds_download/permission'

/** 单文件上限，与原生 `RemoteDownloadHandler.MAX_FILE_BYTES` 必须一致。 */
export const DOWNLOAD_MAX_BYTES = 32 * 1024 * 1024

/** 原生状态快照（`null` = 这个环境没有这套端点：非壳 / 旧 APK）。 */
export interface DownloadState {
  /** 现在能不能写「下载」目录（Android 9 上表示运行时权限是否已授予） */
  canWrite: boolean
  /** 展示用的目录（29+ 是 `Download`，28 是绝对路径） */
  dir: string
  /** 相对路径（`Download/`），文案里显示「下载/xxx」用 */
  relativePath: string
  /** 28 上才需要运行时权限 */
  needsPermission: boolean
  sdkInt?: number
}

/** 保存成功的结果。 */
export interface DownloadResult {
  /** 实际落盘的名字（同名时原生会加 ` (1)`） */
  displayName: string
  /** `content://media/external/downloads/...` 或 `file://...`（Android 9） */
  uri: string
  relativePath: string
}

/** 允许交给原生的三种形态：Blob / 裸字节 / base64（`atob` 那套字符串）。 */
export type DownloadSource = Blob | Uint8Array | ArrayBuffer | string

export interface SaveOptions {
  /** true = 不弹 toast（调用方自己处理），默认 false */
  silent?: boolean
  /** 注入 fetch（自测用）；生产留空走页面全局 fetch，同源即可 */
  fetch?: FetchLike
}

/** 保存失败：`code` 是原生错误码或本地分类，界面据此出人话。 */
export class DownloadError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'DownloadError'
    this.code = code
  }
}

export const isDownloadError = (error: unknown): error is DownloadError => error instanceof DownloadError

/* ────────────────────────────────────────────────────────────────────────
 * 一、原生调用
 * ──────────────────────────────────────────────────────────────────────── */

const defaultFetch: FetchLike = (input, init) => fetch(input, init)

interface NativeReply {
  status: number
  body: unknown
  text: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const stringOf = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

const numberOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 打一次原生端点。**永不抛**：连不上 / 超时 / 非 JSON 都折成 `null`，
 * 由调用方当成「这个环境没有这套能力」。
 */
const callNative = async (
  path: string,
  init: RequestInit,
  fetchLike: FetchLike | undefined,
  timeoutMs: number,
): Promise<NativeReply | null> => {
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer =
    controller === null
      ? 0
      : setTimeout(() => {
          try {
            controller.abort()
          } catch {
            /* 已经结束了 */
          }
        }, timeoutMs)
  try {
    const response = await (fetchLike ?? defaultFetch)(path, {
      ...init,
      cache: 'no-store',
      // 同源本地端口，不带 cookie：别让 WebView 的 cookie 策略把这次请求拖住
      credentials: 'omit',
      ...(controller === null ? {} : { signal: controller.signal }),
    })
    let text = ''
    try {
      text = await response.text()
    } catch {
      text = ''
    }
    let body: unknown
    if (text.length > 0) {
      try {
        body = JSON.parse(text)
      } catch {
        // 可能是 SPA 的 index.html（旧 APK 的静态兜底）：当成非 JSON
        body = undefined
      }
    }
    return { status: response.status, body, text }
  } catch {
    return null
  } finally {
    if (timer !== 0) clearTimeout(timer)
  }
}

/** 读一次原生状态；`null` = 这台设备上的这个版本还不支持。 */
export const fetchDownloadState = async (
  options: { fetch?: FetchLike } = {},
): Promise<DownloadState | null> => {
  const reply = await callNative(DOWNLOAD_STATE_PATH, { method: 'GET' }, options.fetch, 3000)
  if (reply === null || reply.status !== 200) return null
  const body = reply.body
  // 形状不对（HTML / 其它端点）：不支持
  if (!isRecord(body) || typeof body.ok !== 'boolean') return null
  const dir = stringOf(body.dir) ?? 'Download'
  return {
    canWrite: body.canWrite === true,
    dir,
    relativePath: stringOf(body.relativePath) ?? 'Download/',
    needsPermission: body.needsPermission === true,
    ...(numberOf(body.sdkInt) === undefined ? {} : { sdkInt: numberOf(body.sdkInt) as number }),
  }
}

/** 这个环境支持「保存到下载目录」吗（探测一次，供按钮做能力门禁）。 */
export const isDownloadSupported = async (options: { fetch?: FetchLike } = {}): Promise<boolean> =>
  (await fetchDownloadState(options)) !== null

/* ────────────────────────────────────────────────────────────────────────
 * 二、错误 → 人话
 * ──────────────────────────────────────────────────────────────────────── */

/** 原生错误码 → i18n key（顺序即优先级）。 */
const NATIVE_ERROR_KEYS: Readonly<Record<string, TranslationKey>> = {
  permission_denied: 'downloadDenied',
  too_large: 'downloadTooLarge',
  bad_name: 'downloadBadName',
  io_error: 'downloadIoError',
  bad_body: 'downloadBadBody',
  bad_request: 'downloadBadBody',
  // 旧 APK 上没有这条路由：405（非 GET 一律拒）/ 404 / not_found 都当成「这个版本不支持」
  method_not_allowed: 'downloadUnsupported',
  not_found: 'downloadUnsupported',
  unsupported: 'downloadUnsupported',
}

const toastOf = (error: unknown): LinkedMessage => {
  const code = isDownloadError(error) ? error.code : errorCodeOf(error)
  const key = NATIVE_ERROR_KEYS[code]
  if (key !== undefined) return { key, type: 'error' }
  const reason =
    error instanceof Error && error.message.length > 0 ? error.message : translate('downloadIoError')
  return { key: 'downloadFailed', params: { reason }, type: 'error' }
}

/** 给界面用的一句话原因（不弹 toast 的场合，例如内联错误条）。 */
export const describeDownloadError = (error: unknown): string => {
  const toast = toastOf(error)
  return translate(toast.key, toast.params)
}

/* ────────────────────────────────────────────────────────────────────────
 * 三、保存（核心）
 * ──────────────────────────────────────────────────────────────────────── */

/** 把三种输入折成 base64 + 字节数（字符串按 base64 原样透传）。 */
const toBase64 = async (source: DownloadSource): Promise<{ dataBase64: string; bytes: number }> => {
  if (typeof source === 'string') {
    // 已经是 base64：用一次 atob 数长度（`=` 补齐也算，别把上限估小了）
    const clean = source.replace(/\s+/gu, '')
    const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
    return { dataBase64: clean, bytes: Math.floor((clean.length * 3) / 4) - padding }
  }
  const bytes =
    source instanceof Uint8Array
      ? source
      : source instanceof ArrayBuffer
        ? new Uint8Array(source)
        : new Uint8Array(await source.arrayBuffer())
  return { dataBase64: encodeBase64(bytes), bytes: bytes.byteLength }
}

/**
 * 真正的保存动作：**不弹 toast**，失败抛 {@link DownloadError}。
 *
 * Android 9 上第一次 `permission_denied` 会走「申请 → 轮询 → 重试一次」，
 * 仍然不行才把错误抛出去（页面给「去系统设置里允许」的文案）。
 */
const saveRaw = async (
  source: DownloadSource,
  name: string,
  mime: string | undefined,
  options: SaveOptions,
): Promise<DownloadResult> => {
  const payload = await toBase64(source)
  if (payload.bytes > DOWNLOAD_MAX_BYTES) {
    throw new DownloadError('too_large', `文件 ${payload.bytes} 字节，超过下载上限 ${DOWNLOAD_MAX_BYTES}`)
  }
  const first = await postSave(payload, name, mime, options.fetch)
  if (first.ok) return first.result
  if (first.error !== 'permission_denied') throw new DownloadError(first.error, first.error)

  // Android 9：弹系统权限框，然后按状态轮询（权限框是异步的，用户可能要看几秒）
  const granted = await requestWritePermission(options.fetch)
  if (!granted) throw new DownloadError('permission_denied', '存储写权限没有授予')
  const retry = await postSave(payload, name, mime, options.fetch)
  if (retry.ok) return retry.result
  throw new DownloadError(retry.error, retry.error)
}

type SaveAttempt = { ok: true; result: DownloadResult } | { ok: false; error: string }

const postSave = async (
  payload: { dataBase64: string; bytes: number },
  name: string,
  mime: string | undefined,
  fetchLike: FetchLike | undefined,
): Promise<SaveAttempt> => {
  // 32 MiB 的 base64 要发 44 MB：给足时间（平板写 UFS 一般几百毫秒，慢卡可能几秒）
  const reply = await callNative(
    DOWNLOAD_SAVE_PATH,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        ...(mime === undefined || mime.length === 0 ? {} : { mime }),
        dataBase64: payload.dataBase64,
      }),
    },
    fetchLike,
    120_000,
  )
  if (reply === null) {
    // 连不上：非壳环境 / 本地服务没起来
    return { ok: false, error: 'unsupported' }
  }
  if (reply.status === 413) return { ok: false, error: 'too_large' }
  if (reply.status === 404 || reply.status === 405) return { ok: false, error: 'unsupported' }
  const body = reply.body
  if (!isRecord(body)) return { ok: false, error: reply.status === 200 ? 'unsupported' : 'io_error' }
  if (body.ok === true) {
    return {
      ok: true,
      result: {
        displayName: stringOf(body.displayName) ?? name,
        uri: stringOf(body.uri) ?? '',
        relativePath: stringOf(body.relativePath) ?? 'Download/',
      },
    }
  }
  return { ok: false, error: stringOf(body.error) ?? 'io_error' }
}

/**
 * 拉起原生权限申请并等「真的能写了」。
 *
 * 为什么是轮询而不是等回调：权限框由系统弹，页面拿不到结果；`canWrite` 是唯一的真相。
 * 最多等 12 秒（用户点「允许」通常 1–2 秒，点「拒绝」会立刻返回 false）。
 */
const requestWritePermission = async (fetchLike: FetchLike | undefined): Promise<boolean> => {
  await callNative(
    DOWNLOAD_PERMISSION_PATH,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    fetchLike,
    5000,
  )
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    await sleep(500)
    const state = await fetchDownloadState({ ...(fetchLike === undefined ? {} : { fetch: fetchLike }) })
    if (state !== null && state.canWrite) return true
  }
  return false
}

/**
 * 保存到系统「下载」目录（成功/失败都会弹 toast）。
 *
 * @example
 * await saveToDownloads(new Blob([bytes], { type: 'image/png' }), 'shot.png', 'image/png')
 * await saveToDownloads(base64, 'report.md', 'text/markdown')
 */
export const saveToDownloads = async (
  source: DownloadSource,
  name: string,
  mime?: string,
  options: SaveOptions = {},
): Promise<DownloadResult> => {
  try {
    const result = await saveRaw(source, name, mime, options)
    if (options.silent !== true) {
      showToast({ key: 'downloadSaved', params: { name: result.displayName } })
    }
    return result
  } catch (error) {
    if (options.silent !== true) showToast(toastOf(error))
    throw error
  }
}

/** Save generated content in the Android shell or through a browser download. */
export const saveGeneratedDownload = async (blob: Blob, name: string, current = () => true): Promise<void> => {
  const native = await isDownloadSupported()
  if (!current()) return
  if (native) {
    await saveToDownloads(blob, name, blob.type || undefined)
    return
  }
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 5_000)
}

/* ────────────────────────────────────────────────────────────────────────
 * 四、从 URL / 远端工作区取字节再保存
 * ──────────────────────────────────────────────────────────────────────── */

const DATA_URL_PATTERN = /^data:([^;,]*)(;base64)?,/iu

/** `blob:` / `data:` / `http(s):` → Blob（`blob:` 直接用 fetch，WebView 支持）。 */
const sourceFromUrl = async (url: string): Promise<{ source: DownloadSource; mime?: string }> => {
  const trimmed = url.trim()
  if (trimmed.length === 0) throw new DownloadError('bad_source', '没有可保存的内容地址')
  const dataMatch = DATA_URL_PATTERN.exec(trimmed)
  if (dataMatch !== null) {
    const mime = (dataMatch[1] ?? '').toLowerCase()
    const isBase64 = dataMatch[2] !== undefined
    const comma = trimmed.indexOf(',')
    const payload = comma < 0 ? '' : trimmed.slice(comma + 1)
    if (!isBase64) {
      // 非 base64 的 data URL（少见）：按 UTF-8 文本收下
      const bytes = new TextEncoder().encode(decodeURIComponent(payload))
      return { source: bytes, ...(mime.length === 0 ? {} : { mime }) }
    }
    return {
      source: decodeBase64(payload),
      ...(mime.length === 0 ? {} : { mime }),
    }
  }
  // blob: / http: / https: —— fetch 都能吃
  let response: Response
  try {
    response = await fetch(trimmed)
  } catch {
    throw new DownloadError('bad_source', '取不到这份内容')
  }
  const blob = await response.blob()
  const mime = blob.type.length > 0 ? blob.type : undefined
  return { source: blob, ...(mime === undefined ? {} : { mime }) }
}

/**
 * 保存一个图片 / 文件地址（预览里的 `blob:`、工具卡里的 `data:`）。
 *
 * @example await downloadFromUrl(preview.url, baseNameOf(preview.path), preview.mimeType)
 */
export const downloadFromUrl = async (
  url: string,
  name: string,
  mime?: string,
  options: SaveOptions = {},
): Promise<DownloadResult> => {
  try {
    const resolved = await sourceFromUrl(url)
    const result = await saveRaw(
      resolved.source,
      name,
      mime !== undefined && mime.length > 0 ? mime : resolved.mime,
      { ...options, silent: true },
    )
    if (options.silent !== true) {
      showToast({ key: 'downloadSaved', params: { name: result.displayName } })
    }
    return result
  } catch (error) {
    if (options.silent !== true) showToast(toastOf(error))
    throw error
  }
}

export interface WorkspaceDownloadOptions extends SaveOptions {
  /** 会话作用域（= `workspaceFileScopeId`）；界面层从 `useWorkspacePane` 传进来 */
  scopeId?: string | null
  /** 明确的远端目标（自测用） */
  target?: RemoteCallTarget
}

/**
 * 把工作区里的一个文件**整份**读下来再保存（文本 / 图片 / 二进制都走这条）。
 *
 * 为什么不复用预览里的字节：文本预览只读了前 256 KiB（还能「加载更多」），
 * 用户点「下载」要的是**整份文件**，不能拿一份半截内容去骗他。
 */
export const downloadWorkspacePath = async (
  path: string,
  options: WorkspaceDownloadOptions = {},
): Promise<DownloadResult> => {
  try {
    const target =
      options.target ?? (useRemoteStore.getState().phase === 'ready' ? lastRemoteTarget() : null)
    const scopeId = options.scopeId ?? null
    if (target === null || scopeId === null) {
      throw new DownloadError('not_connected', '还没连上远端主机')
    }
    // 先 stat：超过上限就别读了（一次 readBytes 只有 4 MiB，读 32 MiB 要 64 次往返）
    const stat = await statWorkspaceFile(target, scopeId, path, { timeoutMs: 15_000 })
    if (stat.bytes !== undefined && stat.bytes > DOWNLOAD_MAX_BYTES) {
      throw new DownloadError('too_large', `文件 ${stat.bytes} 字节，超过下载上限`)
    }
    const range = await readWorkspaceBytesRange(target, scopeId, path, 0, DOWNLOAD_MAX_BYTES, {
      timeoutMs: 60_000,
    })
    if (range.data.byteLength === 0) {
      throw new DownloadError('io_error', '这个文件是空的')
    }
    // 没读到结尾 = 半截文件，宁可不给也不能给错
    if (!range.eof || (stat.bytes !== undefined && range.data.byteLength < stat.bytes)) {
      throw new DownloadError('too_large', '文件没有被完整读到，已放弃保存')
    }
    const result = await saveRaw(range.data, baseNameOf(path), undefined, {
      ...options,
      silent: true,
    })
    if (options.silent !== true) {
      showToast({ key: 'downloadSaved', params: { name: result.displayName } })
    }
    return result
  } catch (error) {
    if (options.silent !== true) showToast(toastOf(error))
    throw error
  }
}
