import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { qrDataUrl } from '../../services/remote/qr.js'
import { loadAccounts, loadServers, type LoginMethod } from '../../services/remote/storage.js'
import { probeAuthBridge, useRemoteStore, type AuthBridgeStatus } from '../../services/remote/store.js'
import { Button } from '../base/Button.js'
import { useRemoteAvailability } from './RemoteModeSwitch.js'
import styles from './RemoteSettingsPanel.module.css'

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
 *   - **轮询在 UI 侧排**：`startProviderLogin()` 只负责建会话（browser 模式顺带打开授权页），
 *     之后由本组件的 2s 定时器调 `pollProviderLogin()`；启动路径上**不等结果、不轮询**，
 *     否则一次失败的登录会把设置弹窗卡住十几秒。
 *   - 状态区把 `phase / transport / capabilities` 与**错误原文**（`code: message`）都摊开，
 *     远程链路的失败原因没法靠一句「连接失败」定位。
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
  return 'remoteLoginMethodPassword'
}

export const RemoteSettingsPanel = () => {
  const t = useTranslate()
  const phase = useRemoteStore((state) => state.phase)
  const transport = useRemoteStore((state) => state.transport)
  const capabilities = useRemoteStore((state) => state.capabilities)
  const error = useRemoteStore((state) => state.error)
  const providers = useRemoteStore((state) => state.oauthProviders)
  const qr = useRemoteStore((state) => state.qr)
  const { availability, retry } = useRemoteAvailability()
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

  const busy = phase === 'authing' || phase === 'connecting' || starting !== null
  const connected = phase === 'ready'
  const blocked = availability !== 'ready'
  const bridgeProbing = bridge === 'probing'
  const appOnly = bridge === 'missing' || bridge === 'outdated'
  /** 第三方入口能否点：桥就绪 + 没有登录在跑 + 没连上（探测中一律先禁着，不猜） */
  const canStartProvider = !bridgeProbing && !appOnly && !busy && !connected
  const canConnect = !busy && !connected && !blocked && email.trim().length > 0 && password.length > 0

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
    if (bridge !== 'ready') { return }
    fireAndForget(() =>
      useRemoteStore.getState().loadOAuthProviders(serverRef.current.trim() === '' ? DEFAULT_SERVER : serverRef.current.trim()),
    )
  }, [bridge])

  /* ── 3. 登录轮询：只在「有一个 pending 的登录会话」时跑，2s 一拍 ─────
   * 停止条件全由状态驱动，不需要额外的取消标志：
   *   - `complete` / `expired` / `cancelled` / `error` → `status` 不再是 pending；
   *   - 连上之后 `phase === 'ready'`，`qr` 早就是 complete；
   *   - 组件卸载（用户关掉设置弹窗）→ cleanup 里 clearInterval，绝不留后台定时器。 */
  const qrPending = qr !== null && qr.status === 'pending'
  useEffect(() => {
    if (!qrPending) { return undefined }
    const timer = setInterval(() => {
      fireAndForget(() => useRemoteStore.getState().pollProviderLogin())
    }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [qrPending])

  /* ── 4. 二维码倒计时：只在「有一个在等的会话」时每秒推一次
   *     `complete` / `expired` / `cancelled` 之后倒计时就没有意义了（也不会再画二维码），
   *     定时器必须一起停掉：否则设置弹窗开着的时候会每秒白白重渲染一次。 ── */
  const qrId = qr?.qrId ?? null
  const qrTicking = qr !== null && qr.status === 'pending'
  useEffect(() => {
    if (qrId === null || !qrTicking) { return undefined }
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), COUNTDOWN_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [qrId, qrTicking])

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
    if (phase !== 'ready') { return null }
    const url = server.trim() === '' ? DEFAULT_SERVER : server.trim()
    const items = loadAccounts()
    return items.find((item) => item.serverUrl === url) ?? items[0] ?? null
  }, [phase, server])

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

  /* ── 活动登录会话的展示 ─────────────────────────────────────────────── */

  // 浏览器授权：只在 pending 时提示「已打开登录页…」，授权成功自动切到连接态
  const browsing = qr !== null && qr.mode === 'browser' && qr.status === 'pending'
  // 扫码：`qr.mode === 'qr'` 才画二维码（浏览器模式的 scanUrl 已经交给原生容器了）
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

      <Field label={t('remoteServerLabel')}>
        <input
          className={styles.input}
          type="url"
          value={server}
          disabled={busy || connected}
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
              disabled={busy || connected}
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
              disabled={busy || connected}
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

          {connected ? null : (
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
          )}
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

      {/* ── 浏览器授权等待中：文案 + 取消（授权页在原生容器里，这边只等轮询） ── */}
      {browsing ? (
        <div className={styles.waiting} role="status">
          <span className={styles.waitingText}>
            {t('remoteLoginPageOpened')}
            {qr === null ? '' : ` · ${providerName(qr.providerId)}`}
          </span>
          <Button variant="outlined" size="s" onClick={cancelLogin}>
            {t('remoteLoginCancel')}
          </Button>
        </div>
      ) : null}

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

      {/* ── 已连接：账号 / 登录方式 + 刷新会话 / 断开 ── */}
      {connected ? (
        <div className={styles.accountCard}>
          <div className={styles.status}>
            <StatusChip label={t('remoteAccount')} value={account?.email ?? '—'} />
            <StatusChip label={t('remoteLoginMethodLabel')} value={t(loginMethodLabel(account?.loginMethod))} />
          </div>
          <div className={styles.actions}>
            <Button
              variant="outlined"
              size="m"
              onClick={() => fireAndForget(() => useRemoteStore.getState().refreshSessions())}
            >
              {t('remoteRefreshSessions')}
            </Button>
            <Button variant="outlined" size="m" onClick={disconnect}>
              {t('remoteDisconnect')}
            </Button>
          </div>
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
    </div>
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
