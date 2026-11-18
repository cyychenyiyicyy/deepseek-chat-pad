/**
 * 分体式更新。
 *
 * 网页包与 APK 分开更新：
 *   - 网页包（web-vX.zip）由原生壳下载解压后直接切换资源来源，刷新页面即生效，不用重装；
 *   - APK 由原生壳下载后拉起系统安装器。
 *
 * 接口由本地壳提供（同源，见 android 的 UpdateHandler）：
 *   GET  /__ds_update/state            当前 app / web 版本
 *   GET  /__ds_update/release          代理 GitHub 的 latest release
 *   POST /__ds_update/apply-web?url=   下载并切换网页包（SSE 进度）
 *   POST /__ds_update/download-apk?url= 下载安装包（SSE 进度）
 *   POST /__ds_update/install-apk      拉起安装器
 *
 * 在普通浏览器里这些端点不存在，`isUpdateSupported()` 返回 false，界面自动隐藏。
 */

const BASE = '/__ds_update'

export type UpdateState = {
  appVersion: string
  /** 已安装的网页包版本；没装过下载包时为 null */
  webVersion: string | null
  source: 'assets' | 'files'
}

export type ReleaseInfo = {
  version: string
  apkUrl: string | null
  apkSize: number
  webUrl: string | null
  webSize: number
  notes: string
}

export type UpdateProgress = {
  phase: 'download' | 'unzip' | 'done' | 'error'
  percent?: number
  message?: string
  webVersion?: string
  path?: string
}

const readJson = async <T,>(url: string): Promise<T> => {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }
  return (await res.json()) as T
}

/** 原生壳是否提供更新接口 */
export const isUpdateSupported = async (): Promise<boolean> => {
  try {
    const state = await readJson<{ ok?: boolean }>(`${BASE}/state`)
    return state.ok === true
  } catch {
    return false
  }
}

export const readUpdateState = async (): Promise<UpdateState | null> => {
  try {
    const state = await readJson<UpdateState & { ok?: boolean }>(`${BASE}/state`)
    return state.ok ? state : null
  } catch {
    return null
  }
}

/** 取最新 release；没有 release 时返回 null */
export const fetchLatestRelease = async (): Promise<ReleaseInfo | null> => {
  try {
    const info = await readJson<ReleaseInfo & { ok?: boolean; error?: string }>(`${BASE}/release`)
    return info.ok ? info : null
  } catch {
    return null
  }
}

/** 语义化版本比较：v1.10.0 > v1.9.9 */
export const compareVersion = (a: string, b: string): number => {
  const parse = (value: string) =>
    value
      .replace(/^v/i, '')
      .split(/[.\-+]/)
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isFinite(part) ? part : 0))
  const left = parse(a)
  const right = parse(b)
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) {
      return diff > 0 ? 1 : -1
    }
  }
  return 0
}

/**
 * 用 XHR 读 SSE 进度：老 WebView 也能用（fetch 流式要 Chrome 105+）。
 * 服务端每条事件都是一行 `data: {...}`。
 */
const runStream = (endpoint: string, url: string, onProgress: (progress: UpdateProgress) => void) =>
  new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${BASE}/${endpoint}?url=${encodeURIComponent(url)}`, true)
    xhr.responseType = 'text'
    let offset = 0
    let failure: string | null = null

    const consume = () => {
      let text = ''
      try {
        text = xhr.responseText
      } catch {
        return
      }
      const chunk = text.slice(offset)
      offset = text.length
      for (const line of chunk.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        try {
          const event = JSON.parse(trimmed.slice(5).trim()) as UpdateProgress
          onProgress(event)
          if (event.phase === 'error') failure = event.message ?? '更新失败'
        } catch {
          // 半行数据，等下一次读取
        }
      }
    }

    xhr.onprogress = consume
    xhr.onload = () => {
      consume()
      if (failure) {
        reject(new Error(failure))
        return
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`HTTP ${xhr.status}`))
        return
      }
      resolve()
    }
    xhr.onerror = () => reject(new Error('网络错误'))
    xhr.ontimeout = () => reject(new Error('请求超时'))
    xhr.send()
  })

/** 下载并切换网页包；成功后调用方刷新页面即可生效 */
export const applyWebUpdate = (url: string, onProgress: (progress: UpdateProgress) => void) =>
  runStream('apply-web', url, onProgress)

/** 下载 APK */
export const downloadApk = (url: string, onProgress: (progress: UpdateProgress) => void) =>
  runStream('download-apk', url, onProgress)

/** 拉起系统安装器 */
export const installApk = async (): Promise<boolean> => {
  try {
    const res = await fetch(`${BASE}/install-apk`, { method: 'POST' })
    const body = (await res.json()) as { ok?: boolean }
    return body.ok === true
  } catch {
    return false
  }
}

/** 让人能看懂的体积 */
export const formatSize = (bytes: number): string => {
  if (!bytes) return ''
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
