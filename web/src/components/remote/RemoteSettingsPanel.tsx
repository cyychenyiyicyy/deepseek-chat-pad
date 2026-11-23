import clsx from 'clsx'
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { qrDataUrl } from '../../services/remote/qr.js'
import { openDshWeb, supportsDshWeb } from '../../services/remote/dshWeb.js'
import { DSH_WEB_CAPABILITY } from '../../vendor/dsh-remote/protocol/dsh-web.js'
import { describeRemoteError, lastRemoteTarget, type RemoteCallTarget } from '../../services/remote/sessionsApi.js'
import { loadAccounts, loadAdaptiveTransport, loadCompactHistory, loadServers, saveAdaptiveTransport, saveCompactHistory, type LoginMethod } from '../../services/remote/storage.js'
import { probeAuthBridge, useRemoteStore, type AuthBridgeStatus } from '../../services/remote/store.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { useRemoteAvailability } from './RemoteModeSwitch.js'
import styles from './RemoteSettingsPanel.module.css'

const SessionBackups = lazy(() => import('./SessionBackups.js'))
const RemoteConversationShares = lazy(() => import('./RemoteConversationShares.js'))
const HostPlugins = lazy(() => import('./HostPlugins.js'))
const HostWorkspaces = lazy(() => import('./HostWorkspaces.js'))
const RemoteDevices = lazy(() => import('./RemoteDevices.js'))
const RemoteSchedules = lazy(() => import('./RemoteSchedules.js'))
const RemoteHostSettings = lazy(() => import('./RemoteHostSettings.js'))
const PairDevice = lazy(() => import('./PairDevice.js'))
const SshHostDialog = lazy(() => import('./SshHostDialog.js'))

/**
 * 设置里的「远程 DSH」一节：服务器地址 + 登录方式 → 连接 / 断开，下面是状态区与账号摘要。
 *
 * 约定：
 *   - **密码不持久化**：只活在组件 state 里，随弹窗卸载一起消失（服务器与邮箱来自
 *     `services/remote/storage.ts` 已落盘的那一份，属于方便下次登录的预填，不含密码）。
 *   - **登录方式以数据层为准**：面板只渲染 `oauthProviders`（服务器声明的清单），
 *     不写死 GitHub / Google 之类的按钮；服务器没声明就是只有邮箱密码。
 *   - **第三方登录要过原生登录桥**：`probeAuthBridge()` 说这个环境没有桥（普通浏览器）
 *     或桥是旧 APK 时，整排第三方入口禁用并给出原因 —— 邮箱密码不受影响。
 *     注意 `probeAuthBridge()` 返回的是 `'ready' | 'missing' | 'outdated'`（不是布尔），
 *     `missing` = 不在壳里，`outdated` = 在壳里但 APK 太旧。
 *   - **授权页在系统浏览器里**（K2）：主按钮点下去会把授权页交给系统浏览器，所以用户
 *     「切走 → 回后台 → 进程可能被杀」。因此这里只做三件事：
 *       ① 挂载时调一次 `resumeLogin()`（续上被杀进程前的那次登录）；
 *       ② `visibilitychange → visible` 时再调一次，并**立刻补一拍**轮询
 *          （后台的 `setTimeout` 会被系统节流，2s 定时器可能整段停摆）；
 *       ③ 有 `pendingLogin` 就显示「等待授权…（剩余 mm:ss）」+ 取消。
 *     判断「授权成功」只看轮询结果，**绝不**看 `authPageState().open`（external 下恒 false）。
 *   - 状态区把 `phase / transport / capabilities` 与**错误原文**（`code: message`）都摊开，
 *     远程链路的失败原因没法靠一句「连接失败」定位。
 *   - **重启后自动恢复（K4）**：挂载时调一次 `autoConnectNow()`（幂等单飞，与远程页共用同一份
 *     实现），所以「上次连过」的用户打开设置页看到的是**账号摘要**而不是登录表单；恢复失败
 *     只显示一行「上次连接失败，点击重试」，不弹红条。
 *   - **保活 / 权限区已经搬走（K4）**：通知权限、电池优化、自启动、精确定时、悬浮窗都是
 *     「整个 App 的后台存活能力」，放在这里等于暗示「不连远程就不需要」。现在它们在
 *     「通用设置 → 后台与权限」（`components/settings/BackgroundPermissions.tsx`），
 *     这里只留一句小字 + 一个把用户带过去的按钮。
 */

/** 官方托管服务器（决策见 `plan-P0P1-实施契约.md` 第 3 行）。 */
const DEFAULT_SERVER = 'https://dsh.r2049.cn'

/** 登录轮询节奏：2s（与 `oauth.ts` 的 `DEFAULT_PROVIDER_POLL_INTERVAL_MS`、dsh-Go 同值）。 */
const POLL_INTERVAL_MS = 2_000

/** 二维码倒计时的刷新节奏：1s（只重画倒计时，不碰数据层）。 */
const COUNTDOWN_INTERVAL_MS = 1_000

/** 倒计时用到的「一秒多少毫秒」（`expiresAt` 是毫秒时间戳） */
const MILLIS_PER_SECOND = 1_000

/**
 * 数据层的方法可能同步抛（未连接 / 未就绪），也可能返回 rejected 的 promise；
 * 两者都只反映到 store 的 `error` 上，界面不重复弹提示。
 */
const fireAndForget = (action: () => unknown) => {
  try {
    void Promise.resolve(action()).catch(() => undefined)
  } catch {
    // 同步抛错已由数据层写入状态，这里吞掉即可
  }
}

/** 秒数 → `m:ss`（二维码有效期最多几分钟，不需要小时位） */
const formatCountdown = (totalSeconds: number): string => {
  const safe = Math.max(0, totalSeconds)
  const minutes = Math.floor(safe / 60)
  const seconds = safe % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** `loginMethod` → 文案 key；老数据没有这个字段时按邮箱密码显示 */
const loginMethodLabel = (method: LoginMethod | undefined): TranslationKey => {
  if (method === 'oauth') return 'remoteLoginMethodOauth'
  if (method === 'qr') return 'remoteLoginMethodQr'
  if (method === 'pairing') return 'remotePairDevice'
  return 'remoteLoginMethodPassword'
}

export const RemoteSettingsPanel = () => {
  const [showBackups, setShowBackups] = useState(false)
  const [showShares, setShowShares] = useState(false)
  const [showPairing, setShowPairing] = useState(false)
  const [showSsh, setShowSsh] = useState(false)
  const [sshAvailable, setSshAvailable] = useState(false)
  const [hostDialog, setHostDialog] = useState<{
    kind: 'plugins' | 'workspaces' | 'devices' | 'schedules' | 'configuration' | 'providers'
    target: RemoteCallTarget
  } | null>(null)
  const [openingWeb, setOpeningWeb] = useState(false)
  const [adaptiveTransport, setAdaptiveTransport] = useState(loadAdaptiveTransport)
  const [compactHistory, setCompactHistory] = useState(loadCompactHistory)
  const t = useTranslate()
  const phase = useRemoteStore((state) => state.phase)
  const transport = useRemoteStore((state) => state.transport)
  const capabilities = useRemoteStore((state) => state.capabilities)
  const error = useRemoteStore((state) => state.error)
  const providers = useRemoteStore((state) => state.oauthProviders)
  const qr = useRemoteStore((state) => state.qr)
  /** 待完成登录（可能是**上个进程**留下的：`resumeLogin()` 会把它从 localStorage 恢复出来） */
  const pendingLogin = useRemoteStore((state) => state.pendingLogin)
  /**
   * 原生保活服务的快照（K1）：`null` = 还没探过；`supported:false` = 这个环境没有这套端点
   * （普通浏览器 / 旧 APK）。**权限区已经不在这里渲染**（见文件头），这里只用于「回前台自检」。
   */
  const keepAlive = useRemoteStore((state) => state.keepAlive)
  /** 重启后的自动恢复进度（K4）：`failed` 时给一行「点击重试」 */
  const autoConnect = useRemoteStore((state) => state.autoConnect)
  /** 上次连上的会话（`null` = 没有可恢复的）：连接表单隐藏时也能显示「上次连的是谁」 */
  const lastSession = useRemoteStore((state) => state.lastSession)
  const { availability, retry } = useRemoteAvailability()
  useEffect(() => {
    let current = true
    if (availability === 'ready') {
      void import('../../services/remote/sshHost.js').then(({ supportsSshHost }) => supportsSshHost())
        .then((available) => { if (current) setSshAvailable(available) }).catch(() => undefined)
    }
    return () => { current = false }
  }, [availability])
  // 预填上次用过的服务器与邮箱（storage 里已有的那份），没有就用默认值
  const [server, setServer] = useState(() => loadServers()[0]?.url ?? DEFAULT_SERVER)
  const [email, setEmail] = useState(() => loadAccounts()[0]?.email ?? '')
  // 密码只在这里，不进 localStorage、不进日志
  const [password, setPassword] = useState('')
  /** 当前选中的登录方式：`'password'` 或某个 provider id（选中本身不发起登录） */
  const [method, setMethod] = useState<string>('password')
  /** 正在发起的动作（`'password'` / `'<providerId>:<mode>'`）：只驱动按钮 loading，不参与状态机 */
  const [starting, setStarting] = useState<string | null>(null)
  /** 原生登录桥：`'probing'` 是还没探完，探完才决定第三方入口能不能点 */
  const [bridge, setBridge] = useState<AuthBridgeStatus | 'probing'>('probing')
  /** 倒计时用的当前时刻（每 1s 推一次） */
  const [now, setNow] = useState(() => Date.now())
  // 定时器回调里要读「最新的」服务器地址，避免把 effect 依赖写成 server（每敲一个字都重排）
  const serverRef = useRef(server)
  serverRef.current = server

  const busy = phase === 'authing' || phase === 'connecting' || phase === 'waiting-auth' || starting !== null
  const connected = phase === 'ready'
  const currentTarget = connected ? lastRemoteTarget() : null
  const blocked = availability !== 'ready'
  const bridgeProbing = bridge === 'probing'
  const appOnly = bridge === 'missing' || bridge === 'outdated'
  /** 第三方入口能否点：桥就绪 + 没有登录在跑 + 没连上（探测中一律先禁着，不猜） */
  const canStartProvider = !bridgeProbing && !appOnly && !busy && !connected
  const canConnect = !busy && !connected && !blocked && email.trim().length > 0 && password.length > 0
  /** 正在静默恢复上次连接（K4）：这时不该显示登录表单，也不该说「未连接」 */
  const restoring = autoConnect.state === 'connecting' && !connected
  /** 上次连接失败且还能重试（凭据过期的会话已经被清掉，重试没有意义） */
  const restoreFailed = autoConnect.state === 'failed' && autoConnect.code !== 'SESSION_EXPIRED'
  /** 凭据过期：last-session 已清，账号邮箱还在，表单照常可填 */
  const sessionExpired = autoConnect.state === 'failed' && autoConnect.code === 'SESSION_EXPIRED'
  /** 有没有可恢复的「上次连接」（临时断开之后也还在，用来显示「重新连接」） */
  const reconnectable = lastSession !== null && lastSession.transport !== 'ssh' && !connected && !busy && !blocked

  const selected = providers.find((item) => item.id === method) ?? null
  const providerName = (id: string): string =>
    providers.find((item) => item.id === id)?.displayName ?? id

  /* ── 服务器地址（所有登录方式共用；空串回落到官方托管） ─────────────── */
  const currentServer = (): string => {
    const value = serverRef.current.trim()
    return value === '' ? DEFAULT_SERVER : value
  }

  /* ── 1. 探一次原生登录桥（用户打开设置页才算，不在启动路径上） ──────── */
  useEffect(() => {
    let alive = true
    void probeAuthBridge().then((status) => {
      if (alive) { setBridge(status) }
    })
    return () => {
      alive = false
    }
  }, [])

  /* ── 2. 桥可用时拉一次登录方式清单（清单来自服务器，不写死） ─────────── */
  useEffect(() => {
    if (bridge !== 'ready' || connected) return
    fireAndForget(() =>
      useRemoteStore.getState().loadOAuthProviders(serverRef.current.trim() === '' ? DEFAULT_SERVER : serverRef.current.trim()),
    )
  }, [bridge, connected])

  /* ── 3. 登录轮询：只在「有一个 pending 的登录会话」时跑，2s 一拍 ─────
   * 停止条件全由状态驱动，不需要额外的取消标志：
   *   - `complete` / `expired` / `cancelled` / `error` → `status` 不再是 pending；
   *   - 连上之后 `phase === 'ready'`，`qr` 早就是 complete；
   *   - 组件卸载（用户关掉设置弹窗）→ cleanup 里 clearInterval，绝不留后台定时器。
   * 恢复流程（`resumeLogin()`）在跑的时候数据层会自己让路（只允许一个轮询在飞）。 */
  const qrPending = qr !== null && qr.status === 'pending'
  useEffect(() => {
    if (!qrPending) { return undefined }
    const timer = setInterval(() => {
      fireAndForget(() => useRemoteStore.getState().pollProviderLogin())
    }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [qrPending])

  /* ── 3b. 会话恢复（K2 + K4）+ 回前台补拍 ─────────────────────────────
   * 用户授权时要切到系统浏览器，App 进后台，进程随时可能被系统杀掉。所以：
   *   ① 挂载就调一次 `autoConnectNow()`（K4）：上次连过的话这里**静默连回去**，
   *      用户看到的是账号摘要而不是登录表单 —— 「重启后要重新登录」就是缺了这一步；
   *   ② 再调一次 `resumeLogin()`：若是被杀进程前发起的那次登录，这里直接续上
   *      （`dsp.remote.pending-login.v1` 里有 qrId，服务端会话跟进程无关）；
   *   ③ `visibilitychange → visible`（用户从浏览器 / 系统设置切回来）调 `onAppForeground()`：
   *      续登录 + **立刻补一拍**轮询（后台的 setTimeout 会被系统节流，别等 2s 定时器）
   *      + 保活服务自检（系统可能在后台把它杀掉）。
   *   ④ 挂载顺带探一次保活（`refreshKeepAlive()`，只读 `state.json`）：连接建立后会用它
   *      把前台服务拉起来（权限状态本身在「通用设置 → 后台与权限」里展示）。
   * 四条路径都是幂等的（数据层单飞），重复触发不会多发请求；也都不 await —— 不挡首屏。 */
  useEffect(() => {
    fireAndForget(() => useRemoteStore.getState().autoConnectNow())
    fireAndForget(() => useRemoteStore.getState().resumeLogin())
    fireAndForget(() => useRemoteStore.getState().refreshKeepAlive())
    if (typeof document === 'undefined') { return undefined }
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') { return }
      fireAndForget(() => useRemoteStore.getState().onAppForeground())
      setNow(Date.now())
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  /* ── 4. 倒计时：`complete` / `expired` / `cancelled` 之后就没有意义了
   *     `pendingLogin` 也算在内 —— 它可能来自上个进程，倒计时必须跟着走。 ── */
  const qrId = qr?.qrId ?? null
  const qrTicking = qr !== null && qr.status === 'pending'
  const pendingExpiresAt = pendingLogin?.expiresAt ?? null
  const ticking = qrTicking || pendingExpiresAt !== null
  useEffect(() => {
    if (!ticking) { return undefined }
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), COUNTDOWN_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [ticking, qrId, pendingExpiresAt])

  /* ── 5. 二维码图片：只在 `mode === 'qr'` 时生成，渲染失败不炸整块面板 ── */
  const qrMode = qr?.mode ?? null
  const qrScanUrl = qr?.scanUrl ?? null
  const qrImage = useMemo(() => {
    if (qrMode !== 'qr' || qrScanUrl === null) { return null }
    try {
      // cellSize 4 + margin 4 → 164px：设置弹窗的内容区不高，二维码再大就会把
      // 「登录方式」和状态区挤到看不见；164px 在平板屏幕上照样扫得动。
      return qrDataUrl(qrScanUrl, { cellSize: 4, margin: 4 })
    } catch {
      // 登录链接过长 / 内容非法：给「改用浏览器登录」的文案，不把异常抛进渲染
      return null
    }
  }, [qrMode, qrScanUrl])

  /* ── 6. 登录成功后的账号摘要（数据层不把账号放进 state，读落盘的那一条） ── */
  const account = useMemo(() => {
    if (phase !== 'ready' || transport === 'ssh') { return null }
    const url = server.trim() === '' ? DEFAULT_SERVER : server.trim()
    const items = loadAccounts()
    return items.find((item) => item.serverUrl === url) ?? items[0] ?? null
  }, [phase, server, transport])

  /* ── 动作 ───────────────────────────────────────────────────────────── */

  const connectWithPassword = async (): Promise<void> => {
    setStarting('password')
    try {
      await useRemoteStore.getState().loginWithPassword(email.trim(), password, currentServer())
      // 连上了就不再留密码（密码本来就不落盘，这里只是少留一会儿）
      if (useRemoteStore.getState().phase === 'ready') { setPassword('') }
    } catch {
      // 数据层已把可读错误写进 state.error
    } finally {
      setStarting(null)
    }
  }

  const logInWithProvider = async (providerId: string, mode: 'browser' | 'qr'): Promise<void> => {
    setStarting(`${providerId}:${mode}`)
    try {
      await useRemoteStore.getState().startProviderLogin(providerId, mode, currentServer())
    } catch {
      // 同上：错误在 state.error 里
    } finally {
      setStarting(null)
    }
  }

  const cancelLogin = (): void => {
    fireAndForget(() => useRemoteStore.getState().cancelProviderLogin())
  }

  const disconnect = (): void => {
    setPassword('')
    fireAndForget(() => useRemoteStore.getState().disconnect())
  }

  /** 退出登录：清掉本机保存的凭据 + last-session（下次启动不再自动连） */
  const signOut = (): void => {
    setPassword('')
    fireAndForget(() => useRemoteStore.getState().signOut())
  }

  /** 按盘上的 last-session 再连一次（「上次连接失败」与「临时断开后重连」共用） */
  const reconnect = (): void => {
    fireAndForget(() => useRemoteStore.getState().retryAutoConnect())
  }

  /* ── 活动登录会话的展示 ─────────────────────────────────────────────── */

  /* 浏览器授权（系统浏览器）：
   *   - 首选 `pendingLogin`：它可能来自**上个进程**（用户授权时 App 被杀，回来就靠它续上）；
   *   - 退路是 `qr`：同一进程内刚发起、`pendingLogin` 还没来得及写（例如 localStorage 不可用）。
   * 判断「授权成功」只看轮询结果 —— `external` 模式下 `authPageState().open` 恒为 false，
   * 拿它当取消信号会在打开浏览器的瞬间误判。 */
  const loginMode = pendingLogin?.mode ?? (qr?.status === 'pending' ? qr.mode : null)
  const waitingExpiresAt = pendingLogin?.expiresAt ?? (qr?.status === 'pending' ? qr.expiresAt : null)
  const waitingSeconds = waitingExpiresAt === null ? 0 : Math.max(0, Math.ceil((waitingExpiresAt - now) / MILLIS_PER_SECOND))
  const waitingAuth = !connected && loginMode === 'browser' && waitingExpiresAt !== null && now < waitingExpiresAt
  const waitingProvider = pendingLogin?.providerId ?? qr?.providerId ?? null
  // 扫码：`qr.mode === 'qr'` 才画二维码（浏览器模式的 scanUrl 已经交给系统浏览器了）
  const scanning = qr !== null && qr.mode === 'qr' && qr.status !== 'complete' && qr.status !== 'cancelled'
  const expiredByClock = qr !== null && now >= qr.expiresAt
  const qrExpired = qr !== null && (qr.status === 'expired' || (qr.status === 'pending' && expiredByClock))
  const remainingSeconds =
    qr === null ? 0 : Math.max(0, Math.ceil((qr.expiresAt - now) / MILLIS_PER_SECOND))
  const cancelled = qr !== null && qr.status === 'cancelled'

  return (
    <div className={styles.panel}>
      {blocked ? (
        <div className={styles.notice} role="status">
          <div className={styles.noticeText}>
            {t(availability === 'outdated' ? 'remoteBridgeOutdated' : 'remoteRequiresApp')}
          </div>
          <Button variant="outlined" size="s" disabled={availability === 'probing'} onClick={retry}>
            {t('retry')}
          </Button>
        </div>
      ) : null}

      <div className={styles.intro}>
        <div className={styles.introTitle}>{t('remoteSettingsTitle')}</div>
        <div className={styles.description}>{t('remoteSettingsDesc')}</div>
      </div>

      {/* ── 重启后自动恢复（K4）：一条横幅说清「在干什么 / 为什么没连上」 ──────
       * 三态优先级：正在恢复 > 失败可重试 > 凭据过期 > 有记录但当前没连（临时断开后）。
       * 失败**不弹红条**（数据层也不写 `state.error`），这里只给一行字 + 一个按钮。 */}
      {restoring ? (
        <div className={styles.waiting} role="status">
          <span className={styles.waitingText}>{t('remoteAutoConnecting')}</span>
        </div>
      ) : restoreFailed ? (
        <div className={styles.waiting} role="status">
          <span className={styles.waitingText}>{t('remoteAutoConnectFailed')}</span>
          <Button variant="outlined" size="s" onClick={reconnect}>
            {t('remoteAutoConnectRetry')}
          </Button>
        </div>
      ) : sessionExpired ? (
        <div className={styles.errorText} role="status">
          {t('remoteSessionExpired')}
        </div>
      ) : reconnectable ? (
        <div className={styles.waiting} role="status">
          <span className={styles.waitingText}>
            {t('remoteLastSession')} · {lastSession.email} · {lastSession.hostName}
          </span>
          <Button variant="primary" size="s" onClick={reconnect}>
            {t('remoteReconnect')}
          </Button>
        </div>
      ) : null}

      {/* ── 登录表单：**连上了就整块不渲染**（K4 要求「切到远程页不出现登录表单」） ── */}
      {connected ? null : (
        <>
          <Field label={t('remoteServerLabel')}>
            <input
              className={styles.input}
              type="url"
              value={server}
              disabled={busy}
              placeholder={DEFAULT_SERVER}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) => setServer(event.target.value)}
              onBlur={() => {
                // 换了服务器就重拉登录方式（数据层按 serverUrl 缓存，这里只是提前把清单对齐）
                if (bridge !== 'ready') { return }
                fireAndForget(() =>
                  useRemoteStore.getState().loadOAuthProviders(server.trim() === '' ? DEFAULT_SERVER : server.trim()),
                )
              }}
            />
          </Field>

          {/* ── 登录方式：分段标签（选中不发起登录，避免误把用户弹到授权页） ── */}
          <div className={styles.methodBlock}>
            <div className={styles.label}>{t('remoteLoginMethodLabel')}</div>
            <div role="tablist" aria-label={t('remoteLoginMethodLabel')} className={styles.methods}>
              <button
                type="button"
                role="tab"
                aria-selected={method === 'password'}
                className={clsx(styles.method, method === 'password' && styles.methodActive)}
                disabled={busy}
                onClick={() => setMethod('password')}
              >
                {t('remoteLoginMethodPassword')}
              </button>
              {providers.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  role="tab"
                  aria-selected={method === provider.id}
                  className={clsx(styles.method, method === provider.id && styles.methodActive)}
                  disabled={!canStartProvider}
                  title={appOnly ? t('remoteLoginAppOnly') : undefined}
                  onClick={() => setMethod(provider.id)}
                >
                  {provider.displayName}
                </button>
              ))}
            </div>
            {appOnly ? (
              <div className={styles.description} role="status">
                {t(bridge === 'outdated' ? 'remoteLoginAppUpdate' : 'remoteLoginAppOnly')}
              </div>
            ) : null}
            {bridge === 'ready' && providers.length === 0 ? (
              <div className={styles.description}>{t('remoteLoginNoProviders')}</div>
            ) : null}
          </div>

      {/* ── 邮箱密码 ── */}
      {method === 'password' ? (
        <>
          <Field label={t('remoteEmailLabel')}>
            <input
              className={styles.input}
              type="email"
              value={email}
              disabled={busy}
              placeholder={t('remoteEmailPlaceholder')}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>

          <Field label={t('remotePasswordLabel')} description={t('remotePasswordHint')}>
            <input
              className={styles.input}
              type="password"
              value={password}
              disabled={busy}
              placeholder={t('remotePasswordPlaceholder')}
              autoComplete="off"
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing && canConnect) {
                  event.preventDefault()
                  void connectWithPassword()
                }
              }}
            />
          </Field>

          <div className={styles.actions}>
            <Button
              variant="primary"
              size="m"
              disabled={!canConnect}
              onClick={() => void connectWithPassword()}
            >
              {t(busy ? 'remoteConnecting' : 'remoteConnect')}
            </Button>
          </div>
        </>
      ) : selected === null ? (
        <div className={styles.description}>{t('remoteLoginNoProviders')}</div>
      ) : (
        /* ── 第三方登录：主按钮（浏览器授权）+ 旁边的扫码入口 ── */
        <div className={styles.loginPane}>
          <div className={styles.description}>{t('remoteLoginProviderHint')}</div>
          <div className={styles.actions}>
            <Button
              variant="primary"
              size="m"
              disabled={!canStartProvider}
              onClick={() => void logInWithProvider(selected.id, 'browser')}
            >
              {t(starting === `${selected.id}:browser` ? 'remoteLoginStarting' : 'remoteLoginWith', {
                provider: selected.displayName,
              })}
            </Button>
            {selected.canQr ? (
              <Button
                variant="outlined"
                size="m"
                disabled={!canStartProvider}
                onClick={() => void logInWithProvider(selected.id, 'qr')}
              >
                {t(starting === `${selected.id}:qr` ? 'remoteLoginStarting' : 'remoteLoginQr')}
              </Button>
            ) : null}
          </div>
        </div>
      )}

      {/* ── 浏览器授权等待中：已交给系统浏览器，这边只等轮询（可以随时取消） ── */}
      {waitingAuth ? (
        <div className={styles.waiting} role="status">
          <span className={styles.waitingText}>
            {t('remoteLoginPageOpened')}
            <span className={styles.waitingCountdown}>
              {t('remoteLoginWaitingAuth', { time: formatCountdown(waitingSeconds) })}
            </span>
            {waitingProvider === null ? '' : ` · ${providerName(waitingProvider)}`}
          </span>
          <Button variant="outlined" size="s" onClick={cancelLogin}>
            {t('remoteLoginCancel')}
          </Button>
        </div>
      ) : null}
      {waitingAuth ? <div className={styles.description}>{t('remoteLoginResumeHint')}</div> : null}

      {/* ── 扫码：二维码只在 `qr.mode === 'qr'` 时出现 ── */}
      {scanning && qr !== null ? (
        <div className={styles.qrBlock}>
          <div className={styles.qrImageBox}>
            {qrImage === null ? (
              <div className={styles.qrFallback}>{t('remoteLoginQrFailed')}</div>
            ) : (
              <img className={styles.qrImage} src={qrImage} alt={t('remoteLoginQrHint')} width={164} height={164} />
            )}
          </div>
          <div className={styles.qrMeta}>
            <div className={styles.qrTitle}>{providerName(qr.providerId)}</div>
            <div className={styles.qrHint}>{t('remoteLoginQrHint')}</div>
            {qrExpired ? (
              <div className={styles.qrExpired}>{t('remoteLoginQrExpired')}</div>
            ) : (
              <div className={styles.qrCountdown}>{t('remoteLoginQrRemaining', { time: formatCountdown(remainingSeconds) })}</div>
            )}
            <div className={styles.qrActions}>
              {qrExpired || qr.status === 'error' ? (
                <Button
                  variant="primary"
                  size="s"
                  disabled={!canStartProvider}
                  onClick={() => void logInWithProvider(qr.providerId, 'qr')}
                >
                  {t('remoteLoginQrRefresh')}
                </Button>
              ) : null}
              <Button variant="outlined" size="s" onClick={cancelLogin}>
                {t('remoteLoginCancel')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {cancelled ? <div className={styles.description}>{t('remoteLoginCancelled')}</div> : null}
        </>
      )}

      {/* ── 已连接：账号 / 登录方式 + 刷新会话 / 断开 / 退出登录 ── */}
      {connected ? (
        <div className={styles.accountCard}>
          <div className={styles.status}>
            <StatusChip label={t(transport === 'ssh' ? 'remoteSshUser' : 'remoteAccount')}
              value={account?.email ?? lastSession?.email ?? '—'} />
            <StatusChip
              label={t('remoteHostLabel')}
              value={lastSession?.hostName ?? '—'}
            />
            {transport !== 'ssh' && <StatusChip label={t('remoteLoginMethodLabel')} value={t(loginMethodLabel(account?.loginMethod))} />}
          </div>
          <div className={styles.actions}>
            <Button
              variant="outlined"
              size="m"
              onClick={() => fireAndForget(() => useRemoteStore.getState().refreshSessions())}
            >
              {t('remoteRefreshSessions')}
            </Button>
            <Button variant="outlined" size="m" onClick={disconnect}
              title={transport === 'ssh' ? undefined : t('remoteDisconnectHint')}>
              {t('remoteDisconnect')}
            </Button>
            {transport !== 'ssh' && <Button variant="outlined" size="m" onClick={signOut} title={t('remoteSignOutHint')}>
              {t('remoteSignOut')}
            </Button>}
          </div>
          {transport !== 'ssh' && <div className={styles.description}>{t('remoteDisconnectHint')}</div>}
        </div>
      ) : null}

      <div className={styles.status}>
        <StatusChip label={t('remoteStatus')} value={t(phaseLabel(phase))} error={phase === 'error'} />
        <StatusChip label={t('remoteTransport')} value={transportLabel(t, transport)} />
        <StatusChip label={t('remoteCapabilities')} value={capabilitySummary(t, capabilities)} />
      </div>
      {error ? (
        <div className={styles.errorText}>
          <span className={styles.errorCode}>{error.code}</span>
          <span>{error.message}</span>
        </div>
      ) : null}

      {availability === 'ready' && transport !== 'ssh' && typeof RTCPeerConnection === 'function' && (
        <Field label={t('remoteTransportPreference')} description={t('remoteTransportPreferenceHint')}>
          <select className={styles.input} aria-label={t('remoteTransportPreference')} disabled={busy}
            value={adaptiveTransport ? 'automatic' : 'relay'} onChange={(event) => {
              const automatic = event.currentTarget.value === 'automatic'
              if (saveAdaptiveTransport(automatic)) setAdaptiveTransport(automatic)
            }}>
            <option value="relay">{t('remoteTransportRelayFirst')}</option>
            <option value="automatic">{t('remoteTransportAutomatic')}</option>
          </select>
        </Field>
      )}
      {availability === 'ready' && transport !== 'ssh' && (
        <Field label={t('remoteCompactHistory')} description={t('remoteCompactHistoryHint')}>
          <input type="checkbox" aria-label={t('remoteCompactHistory')} checked={compactHistory} disabled={busy} onChange={(event) => {
            const enabled = event.currentTarget.checked
            if (saveCompactHistory(enabled)) setCompactHistory(enabled)
          }} />
        </Field>
      )}
      {connected && <ConnectionDetails key={JSON.stringify([lastSession?.serverUrl, lastSession?.hostDeviceId])} />}
      {availability === 'ready' && (
        <div className={styles.actions}>
          <Button variant="outlined" size="m" onClick={() => setShowBackups(true)}>{t('remoteSessionBackups')}</Button>
          <Button variant="outlined" size="m" onClick={() => setShowShares(true)}>{t('remoteHostedManage')}</Button>
          {sshAvailable && (
            <Button variant="outlined" size="m" disabled={busy || restoring} onClick={() => setShowSsh(true)}>
              {t(!connected && lastSession?.transport === 'ssh' ? 'remoteSshReconnect' : 'remoteSshHost')}
            </Button>
          )}
          {!connected && (
            <Button variant="outlined" size="m" disabled={busy || restoring} onClick={() => setShowPairing(true)}>
              {t('remotePairDevice')}
            </Button>
          )}
          {currentTarget && (
            <>
              <Button variant="outlined" size="m" onClick={() => setHostDialog({ kind: 'workspaces', target: currentTarget })}>{t('remoteManageWorkspaces')}</Button>
              <Button variant="outlined" size="m" onClick={() => setHostDialog({ kind: 'plugins', target: currentTarget })}>{t('remoteHostPlugins')}</Button>
              <Button variant="outlined" size="m" onClick={() => setHostDialog({ kind: 'configuration', target: currentTarget })}>{t('remoteHostConfiguration')}</Button>
              <Button variant="outlined" size="m" onClick={() => setHostDialog({ kind: 'providers', target: currentTarget })}>{t('remoteHostModels')}</Button>
              {transport !== 'ssh' && (
                <Button variant="outlined" size="m" onClick={() => setHostDialog({ kind: 'devices', target: currentTarget })}>{t('remoteManageDevices')}</Button>
              )}
              <Button variant="outlined" size="m" onClick={() => setHostDialog({ kind: 'schedules', target: currentTarget })}>{t('remoteSchedules')}</Button>
            </>
          )}
          {connected && capabilities.includes(DSH_WEB_CAPABILITY) && supportsDshWeb() && (
            <Button variant="outlined" size="m" disabled={openingWeb} onClick={() => {
              setOpeningWeb(true)
              void openDshWeb().catch((error) => showToast(describeRemoteError(error).text)).finally(() => setOpeningWeb(false))
            }}>{t('remoteOpenDshWeb')}</Button>
          )}
        </div>
      )}
      {showBackups && <Suspense fallback={null}><SessionBackups onClose={() => setShowBackups(false)} /></Suspense>}
      {showShares && <Suspense fallback={null}><RemoteConversationShares onClose={() => setShowShares(false)} /></Suspense>}
      {showPairing && <Suspense fallback={null}><PairDevice onClose={() => setShowPairing(false)} /></Suspense>}
      {showSsh && <Suspense fallback={null}><SshHostDialog onClose={() => setShowSsh(false)} /></Suspense>}
      {hostDialog && hostDialog.target === currentTarget && (
        <Suspense fallback={null}>
          {hostDialog.kind === 'workspaces' && <HostWorkspaces target={currentTarget} onClose={() => setHostDialog(null)} />}
          {hostDialog.kind === 'plugins' && <HostPlugins target={currentTarget} onClose={() => setHostDialog(null)} />}
          {hostDialog.kind === 'devices' && <RemoteDevices target={currentTarget} onClose={() => setHostDialog(null)} />}
          {hostDialog.kind === 'schedules' && <RemoteSchedules target={currentTarget} onClose={() => setHostDialog(null)} />}
          {(hostDialog.kind === 'configuration' || hostDialog.kind === 'providers') && (
            <RemoteHostSettings key={hostDialog.kind} mode={hostDialog.kind} target={currentTarget} onClose={() => setHostDialog(null)} />
          )}
        </Suspense>
      )}

      {/* ── 后台与权限：**已搬到通用设置**（K4）。这里只留一句小字 + 一个跳过去的入口：
       * 通知权限 / 电池优化 / 自启动 / 精确定时 / 悬浮窗属于整个 App 的后台存活能力，
       * 不只服务远程连接 —— 放在这里等于暗示「不连远程就不需要」。
       * 只在原生真的支持 `/__ds_keepalive/*` 时出现（浏览器 / 旧 APK 那边整节也不显示，
       * 指过去只会落空）。 */}
      {keepAlive !== null && keepAlive.supported ? (
        <>
          <div className={styles.actions}>
            <Button variant="outlined" size="s" onClick={() => openSettings('general')}>
              {t('remoteKeepAliveMovedAction')}
            </Button>
          </div>
          <div className={styles.description}>{t('remoteKeepAliveMovedHint')}</div>
        </>
      ) : null}
    </div>
  )
}

const ConnectionDetails = () => {
  const t = useTranslate()
  const diagnostics = useRemoteStore((state) => state.connectionDiagnostics)
  const transport = useRemoteStore((state) => state.transport)
  const [measurement, setMeasurement] = useState<'idle' | 'measuring' | 'failed'>('idle')

  const measure = async () => {
    const target = lastRemoteTarget()
    if (target === null || diagnostics === null) return
    setMeasurement('measuring')
    const start = performance.now()
    try {
      await target.rpc('harness.transport.describe', {}, { timeoutMs: 5_000 })
      if (lastRemoteTarget() !== target) return
      useRemoteStore.setState({
        connectionDiagnostics: {
          ...diagnostics,
          hostRequestMs: Math.round(performance.now() - start),
          measuredAt: Date.now(),
        },
      })
      setMeasurement('idle')
    } catch {
      if (lastRemoteTarget() === target) setMeasurement('failed')
    }
  }

  const time = (value: number | undefined) => value === undefined ? '—' : `${value} ms`
  const exportDiagnostics = async () => {
    if (!diagnostics) return
    const mime = 'application/json'
    const name = 'deepseek-chat-pad-connection.json'
    const blob = new Blob([JSON.stringify({
      schemaVersion: 1,
      transport: transport === 'relay' || transport === 'lan' || transport === 'p2p' || transport === 'turn' ? transport : 'unknown',
      connectMs: diagnostics.connectMs,
      secureChannelMs: diagnostics.secureChannelMs,
      capabilityProbeMs: diagnostics.capabilityProbeMs,
      hostRequestMs: diagnostics.hostRequestMs,
      measuredAt: new Date(diagnostics.measuredAt).toISOString(),
    }, null, 2)], { type: mime })
    const { saveGeneratedDownload } = await import('../../services/remote/download.js')
    await saveGeneratedDownload(blob, name).catch(() => undefined)
  }
  return (
    <details className={styles.connectionDetails}>
      <summary>{t('remoteConnectionDetails')}</summary>
      <div className={styles.status}>
        <StatusChip label={t('remoteConnectDuration')} value={time(diagnostics?.connectMs)} />
        <StatusChip label={t('remoteSecureChannelDuration')} value={time(diagnostics?.secureChannelMs)} />
        <StatusChip label={t('remoteCapabilityProbeDuration')} value={time(diagnostics?.capabilityProbeMs)} />
        <StatusChip label={t('remoteHostRequestDuration')} value={time(diagnostics?.hostRequestMs)} />
        <StatusChip label={t('remoteMeasurementTime')} value={diagnostics ? new Date(diagnostics.measuredAt).toLocaleTimeString() : '—'} />
      </div>
      <div className={styles.actions}>
        <Button variant="outlined" size="s" disabled={diagnostics === null || measurement === 'measuring'}
          onClick={() => void measure()}>
          {t(measurement === 'measuring' ? 'remoteMeasuring' : 'remoteMeasureConnection')}
        </Button>
        <Button variant="outlined" size="s" disabled={diagnostics === null} onClick={() => void exportDiagnostics()}>
          {t('remoteExportDiagnostics')}
        </Button>
      </div>
      {measurement === 'failed' && <div role="status" className={styles.description}>{t('remoteMeasureFailed')}</div>}
    </details>
  )
}

/** 一行「标签 + 值」，与设置里其它单元格同一套排版 */
const Field = ({
  label,
  description,
  children,
}: {
  label: string
  description?: string
  children: ReactNode
}) => (
  <div className={styles.field}>
    <div className={styles.fieldText}>
      <div className={styles.label}>{label}</div>
      {description ? <div className={styles.description}>{description}</div> : null}
    </div>
    <div className={styles.control}>{children}</div>
  </div>
)

/** 状态胶囊：一行三个，标签与值贴在一起，省出竖向空间给输入项 */
const StatusChip = ({
  label,
  value,
  error = false,
}: {
  label: string
  value: string
  error?: boolean
}) => (
  <span className={clsx(styles.chip, error && styles.chipError)}>
    <span className={styles.chipLabel}>{label}</span>
    <span className={styles.chipValue}>{value}</span>
  </span>
)

/** `phase` → 文案 key；未知取值按「未连接」处理（不猜状态） */
const phaseLabel = (phase: string): TranslationKey => {
  if (phase === 'authing') return 'remotePhaseAuthing'
  if (phase === 'waiting-auth') return 'remotePhaseWaitingAuth'
  if (phase === 'connecting') return 'remotePhaseConnecting'
  if (phase === 'ready') return 'remotePhaseReady'
  if (phase === 'error') return 'remotePhaseError'
  return 'remotePhaseIdle'
}

type Translate = ReturnType<typeof useTranslate>

/** 数据面通道的展示名；`null` 表示还没协商出来 */
const transportLabel = (t: Translate, transport: string | null): string => {
  if (transport === 'relay') return t('remoteTransportRelay')
  if (transport === 'lan') return t('remoteTransportLan')
  if (transport === 'p2p') return t('remoteTransportP2p')
  if (transport === 'turn') return t('remoteTransportTurn')
  if (transport === 'ssh') return 'SSH'
  return t('remoteTransportUnknown')
}

/** 能力摘要：最多列 3 项，多的折成 `+N`（完整列表留给将来的诊断面板） */
const capabilitySummary = (t: Translate, capabilities: string[]): string => {
  if (capabilities.length === 0) return t('remoteCapabilitiesEmpty')
  const head = capabilities.slice(0, 3).join(' · ')
  return capabilities.length > 3
    ? `${head} +${capabilities.length - 3}`
    : head
}
