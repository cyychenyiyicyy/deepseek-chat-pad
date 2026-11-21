import clsx from 'clsx'
import { useEffect } from 'react'
import { create } from 'zustand'
import { useTranslate } from '../../i18n/index.js'
import styles from './RemoteModeSwitch.module.css'

/**
 * 「本机 / 远程」双态切换。
 *
 * 远程模式依赖 `services/remote/core` 的本机原生桥（`/__ds_remote/ws`，由
 * `android/.../RemoteWsHandler.java` 提供），只有 Chat Pad App（Android 壳）里才有这条通道。
 * 浏览器预览 / `rspack serve` 下没有，所以这里照 `services/api/transport.ts` 的 `detectShell()`
 * 范式做一次**按需**能力探测：探不到就禁用「远程」并给一句解释。
 *
 * 两条纪律（见 `work/2026-11-21-chatpad接入DSH远程/input-C-chatpad-integration.md` §7.2-③）：
 *   1. **绝不在启动路径上探测** —— `web/src/index.html` 的 8 秒看门狗会把慢启动当成坏包回滚，
 *      所以探测只在本模块的 hook 首次挂载时发生（用户点进远程模式 / 打开远程设置才挂载）。
 *   2. **探测失败必须降级**，不能让模块顶层抛错把起始页带崩（`getUserMedia` 的教训）。
 */

/** 对话模式：本机（现有链路）或远程（远端 DSH 主机）。 */
export type ChatMode = 'local' | 'remote'

type RemoteModeState = { mode: ChatMode }

/** 会话级状态，不落盘：刷新页面回到本机模式，避免用户莫名其妙连着一台远端主机。 */
export const useRemoteMode = create<RemoteModeState>(() => ({ mode: 'local' }))

export const setChatMode = (mode: ChatMode) => useRemoteMode.setState({ mode })

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
      // 探测自身出错一律按「浏览器里」处理：禁用入口，绝不抛给上层
      value = 'browser'
    }
    useRemoteAvailabilityState.setState({ value })
  })()
  return probe
}

/**
 * 远程桥可用性。**首次挂载时**才发起探测（调用点必须永远是用户触发的界面）。
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

/**
 * 双态切换控件。`hint` 为假时不在控件下方重复解释（设置面板自带整块说明）。
 */
export const RemoteModeSwitch = ({ hint = true }: { hint?: boolean }) => {
  const t = useTranslate()
  const mode = useRemoteMode((state) => state.mode)
  const { availability, retry } = useRemoteAvailability()
  // 已经身处远程模式时不置灰（否则当前态看起来像坏了）；切过去之前才要求桥可用
  const remoteDisabled = availability !== 'ready' && mode !== 'remote'

  return (
    <div className={styles.wrapper}>
      <div role="group" aria-label={t('remoteModeLabel')} className={styles.switch}>
        <button
          type="button"
          aria-pressed={mode === 'local'}
          className={clsx(styles.option, mode === 'local' && styles.optionActive)}
          onClick={exitRemoteMode}
        >
          {t('remoteModeLocal')}
        </button>
        <button
          type="button"
          aria-pressed={mode === 'remote'}
          aria-disabled={remoteDisabled}
          disabled={remoteDisabled}
          className={clsx(styles.option, mode === 'remote' && styles.optionActive)}
          onClick={enterRemoteMode}
        >
          {t('remoteModeRemote')}
        </button>
      </div>
      {hint && availability === 'browser' ? (
        <div className={styles.hint}>{t('remoteRequiresApp')}</div>
      ) : null}
      {hint && availability === 'outdated' ? (
        <div className={styles.hint}>
          {t('remoteBridgeOutdated')}
          <button type="button" className={styles.retry} onClick={retry}>
            {t('retry')}
          </button>
        </div>
      ) : null}
    </div>
  )
}
