import { useEffect } from 'react'
import { create } from 'zustand'

/** 主机选择器切换两个对话模式。远程页面和连接面板按需探测原生桥。 */
export type ChatMode = 'local' | 'remote'

type RemoteModeState = { mode: ChatMode }

/** 上次用的模式要落盘：否则每次冷启动都回到「本机」，
 *  「重启之后还得重新登录」的观感有一半来自这里 —— 用户上次连着远程，
 *  重开就该还在远程，并由 `autoConnectNow()` 用已存凭据静默接上。 */
const MODE_STORAGE_KEY = 'dsp.remote.mode.v1'

const readStoredMode = (): ChatMode => {
  try {
    return window.localStorage.getItem(MODE_STORAGE_KEY) === 'remote' ? 'remote' : 'local'
  } catch {
    return 'local'
  }
}
export const useRemoteMode = create<RemoteModeState>(() => ({ mode: readStoredMode() }))

export const setChatMode = (mode: ChatMode) => {
  useRemoteMode.setState({ mode })
  try {
    window.localStorage.setItem(MODE_STORAGE_KEY, mode)
  } catch {
    // 隐私模式/配额满：只影响下次启动的默认模式，不影响当前会话
  }
}

export const enterRemoteMode = () => setChatMode('remote')

export const exitRemoteMode = () => setChatMode('local')

/** 原生壳会在 User-Agent 里追加这个标记（与 `services/api/transport.ts:18` 保持一致）。 */
const NATIVE_UA = 'DeepSeekTablet/'
/** 壳的通用健康端点：每个壳版本都有，用来区分「在壳里」和「在浏览器里」。 */
const HEALTH_PATH = '__ds_health'
/** 远程桥的能力端点（`RemoteWsHandler.java:89,309-313` → `{ok:true,bridge:'remote-ws.v1',…}`）。 */
const BRIDGE_HEALTH_PATH = '__ds_remote/health'
const PROBE_TIMEOUT_MS = 3_000

export type RemoteAvailability =
  /** 还在探测 */
  | 'probing'
  /** 原生桥可用，远程模式能开 */
  | 'ready'
  /** 普通浏览器 / 开发服务器：没有原生通道 */
  | 'browser'
  /** 在壳里、但 APK 版本还没有 `/__ds_remote/*`（旧包只发网页更新时的降级） */
  | 'outdated'

type AvailabilityState = { value: RemoteAvailability }

const useRemoteAvailabilityState = create<AvailabilityState>(() => ({ value: 'probing' }))

/** 读一次 JSON 端点；超时、非 2xx、回来的不是 JSON（开发服务器会回 index.html）都算失败。 */
const probeJson = async (path: string): Promise<Record<string, unknown> | null> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(new URL(path, document.baseURI).href, {
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!response.ok) return null
    const body: unknown = await response.json()
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

const detectRemote = async (): Promise<RemoteAvailability> => {
  const bridge = (window as unknown as { __DS_NATIVE__?: unknown }).__DS_NATIVE__
  const shellHint = bridge !== undefined || navigator.userAgent.includes(NATIVE_UA)
  if (!shellHint) {
    // 没有壳的痕迹时仍给同源探测一次机会（UA 定制失效的历史问题，见 transport.ts:22-28）
    const health = await probeJson(HEALTH_PATH)
    if (health?.ok !== true) return 'browser'
  }
  const bridgeHealth = await probeJson(BRIDGE_HEALTH_PATH)
  return bridgeHealth?.ok === true ? 'ready' : 'outdated'
}

let probe: Promise<void> | null = null

/** 只探一次；并发调用共用同一个 promise。 */
const ensureProbed = (): Promise<void> => {
  probe ??= (async () => {
    let value: RemoteAvailability = 'browser'
    try {
      value = await detectRemote()
    } catch {
      // 探测自身出错一律按「浏览器里」处理：给出降级提示，绝不抛给上层
      value = 'browser'
    }
    useRemoteAvailabilityState.setState({ value })
  })()
  return probe
}

/**
 * 远程桥可用性。**首次挂载时**才发起探测 —— 调用点必须永远是用户触发的界面
 * （远程会话页 / 远程设置面板），不能是 App、Sider 这类启动即挂载的地方。
 * `retry` 用于「用户刚装完 APK 回来重试」的场景。
 */
export const useRemoteAvailability = (): {
  availability: RemoteAvailability
  retry: () => void
} => {
  const value = useRemoteAvailabilityState((state) => state.value)
  useEffect(() => {
    void ensureProbed()
  }, [])
  return {
    availability: value,
    retry: () => {
      probe = null
      useRemoteAvailabilityState.setState({ value: 'probing' })
      void ensureProbed()
    },
  }
}
