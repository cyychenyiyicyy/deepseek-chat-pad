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
  /** 这次是否必须换 APK（CI 根据 android/ 是否变化判断） */
  apkRequired?: boolean
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

/** 当前网络：系统代理与是否 VPN。用于排查「开了代理却连不上」 */
export type NetworkInfo = { proxy: string | null; vpn: boolean }

export const readNetworkInfo = async (): Promise<NetworkInfo | null> => {
  try {
    const info = await readJson<NetworkInfo & { ok?: boolean }>(`${BASE}/net`)
    return info.ok ? { proxy: info.proxy ?? null, vpn: Boolean(info.vpn) } : null
  } catch {
    return null
  }
}

/**
 * 取最新 release。
 * error 为 null 表示「查询成功但没有可更新的 release」；
 * 有 error 时说明是网络/仓库原因，界面上要如实显示，而不是装作已经是最新。
 */
export const fetchLatestRelease = async (): Promise<{
  release: ReleaseInfo | null
  error: string | null
}> => {
  try {
    const res = await fetch(`${BASE}/release`, { cache: 'no-store' })
    const body = (await res.json().catch(() => null)) as
      | (ReleaseInfo & { ok?: boolean; error?: string })
      | null
    if (body?.ok) {
      return { release: body, error: null }
    }
    // no_release 不是错误，只是仓库还没发过版本
    if (body?.error === 'no_release') {
      return { release: null, error: null }
    }
    return { release: null, error: body?.error ?? `HTTP ${res.status}` }
  } catch (error) {
    return { release: null, error: error instanceof Error ? error.message : String(error) }
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

/* ---------------- 这次到底有没有东西可更 ----------------
 * 自动检查与更新弹窗必须用同一份判定，否则两边会跑偏：
 * 网页包单独更新后 APK 版本号永远落后于最新版，只比版本号会把「已经没东西可更」
 * 当成「有更新」，于是每次启动都弹一个只有「稍后」的「已是最新版本」。 */

export type UpdateAction = {
  /** 网页包可以就地更新 */
  hasWeb: boolean
  /** 需要换 APK（没有安装包资产、或 CI 标明这次不用换包时都不算） */
  hasApk: boolean
  /** 有真正能执行的动作 —— 启动时的自动检查只在这种情况下弹窗 */
  actionable: boolean
}

export type UpdateVersions = Pick<UpdateState, 'appVersion' | 'webVersion'>

export const resolveUpdateAction = (
  release: ReleaseInfo | null,
  state: UpdateVersions | null,
): UpdateAction => {
  if (!release) {
    return { hasWeb: false, hasApk: false, actionable: false }
  }
  const appVersion = state?.appVersion ?? ''
  // 没装过下载包时，网页版本就是内置的那份，跟 APK 版本同源
  const webVersion = state?.webVersion ?? appVersion
  const hasWeb = Boolean(release.webUrl) && compareVersion(release.version, webVersion) > 0
  const hasApk =
    Boolean(release.apkUrl) &&
    release.apkRequired !== false &&
    compareVersion(release.version, appVersion) > 0
  return { hasWeb, hasApk, actionable: hasWeb || hasApk }
}

/**
 * 弹窗该用什么口径说话：
 *   update    —— 这一版真的能装；
 *   notice    —— 没有可装的，但有「上次没装完 / 网页包已换需重载」要告诉用户；
 *   up-to-date —— 确实没事（只有手动检查才会看到）。
 */
export type UpdatePromptKind = 'update' | 'notice' | 'up-to-date'

export const resolveUpdatePromptKind = (
  release: ReleaseInfo | null,
  state: UpdateVersions | null,
  notice: string | null,
): UpdatePromptKind => {
  if (resolveUpdateAction(release, state).actionable) {
    return 'update'
  }
  return notice ? 'notice' : 'up-to-date'
}

/* ---------------- 跳过某个版本 ----------------
 * 「跳过此版本」后，启动时的自动检查不再为它弹窗；手动点「检查更新」仍然会显示。 */

const SKIP_KEY = 'chat-demo:update-skipped'

export const readSkippedVersion = (): string | null => {
  try {
    return localStorage.getItem(SKIP_KEY)
  } catch {
    return null
  }
}

export const skipVersion = (version: string) => {
  try {
    localStorage.setItem(SKIP_KEY, version)
  } catch {
    // 存储不可用时只是这次不生效
  }
}

export const clearSkippedVersion = () => {
  try {
    localStorage.removeItem(SKIP_KEY)
  } catch {
    // 忽略
  }
}

/* ---------------- 未完成更新记录 ----------------
 * 「下载中途退出」后重进应用，内存里的状态已经没了。把目标版本落盘，
 * 下次启动才能判断：到底是装上了，还是上次根本没装完。 */

const PENDING_KEY = 'chat-demo:update-pending'

export type PendingUpdate = { version: string; at: number }

export const markUpdatePending = (version: string) => {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify({ version, at: Date.now() } satisfies PendingUpdate))
  } catch {
    // 存储不可用时只是失去「中断检测」，不影响更新本身
  }
}

export const readUpdatePending = (): PendingUpdate | null => {
  try {
    const raw = localStorage.getItem(PENDING_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PendingUpdate>
    return typeof parsed.version === 'string' ? { version: parsed.version, at: parsed.at ?? 0 } : null
  } catch {
    return null
  }
}

export const clearUpdatePending = () => {
  try {
    localStorage.removeItem(PENDING_KEY)
  } catch {
    // 忽略
  }
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

/** 下载并切换网页包；完成后必须再核对一次 state 才算成功 */
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
