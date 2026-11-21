import clsx from 'clsx'
import { useState, type ReactNode } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { loadAccounts, loadServers } from '../../services/remote/storage.js'
import { useRemoteStore } from '../../services/remote/store.js'
import { Button } from '../base/Button.js'
import { useRemoteAvailability } from './RemoteModeSwitch.js'
import styles from './RemoteSettingsPanel.module.css'

/**
 * 设置里的「远程 DSH」一节：服务器地址 + 邮箱 + 密码 → 连接 / 断开，下面是状态区。
 *
 * 约定：
 *   - **密码不持久化**：只活在组件 state 里，随弹窗卸载一起消失（服务器与邮箱来自
 *     `services/remote/storage.ts` 已落盘的那一份，属于方便下次登录的预填，不含密码）。
 *   - 状态区把 `phase / transport / capabilities` 与**错误原文**（`code: message`）都摊开，
 *     远程链路的失败原因没法靠一句「连接失败」定位。
 *   - 非壳环境下 `connect` 必然失败，所以整块降级成「需要 App 内使用」的提示。
 */

/** 官方托管服务器（决策见 `plan-P0P1-实施契约.md` 第 3 行）。 */
const DEFAULT_SERVER = 'https://dsh.r2049.cn'

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

export const RemoteSettingsPanel = () => {
  const t = useTranslate()
  const phase = useRemoteStore((state) => state.phase)
  const transport = useRemoteStore((state) => state.transport)
  const capabilities = useRemoteStore((state) => state.capabilities)
  const error = useRemoteStore((state) => state.error)
  const { availability, retry } = useRemoteAvailability()
  // 预填上次用过的服务器与邮箱（storage 里已有的那份），没有就用默认值
  const [server, setServer] = useState(() => loadServers()[0]?.url ?? DEFAULT_SERVER)
  const [email, setEmail] = useState(() => loadAccounts()[0]?.email ?? '')
  // 密码只在这里，不进 localStorage、不进日志
  const [password, setPassword] = useState('')

  const busy = phase === 'authing' || phase === 'connecting'
  const connected = phase === 'ready'
  const blocked = availability !== 'ready'
  const canConnect = !busy && !connected && !blocked && email.trim().length > 0 && password.length > 0

  const connect = () => {
    const url = server.trim() === '' ? DEFAULT_SERVER : server.trim()
    fireAndForget(() => useRemoteStore.getState().connect(url, email.trim(), password))
  }

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
        />
      </Field>

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
              connect()
            }
          }}
        />
      </Field>

      <div className={styles.actions}>
        {connected ? (
          <Button
            variant="outlined"
            size="m"
            onClick={() => {
              setPassword('')
              fireAndForget(() => useRemoteStore.getState().disconnect())
            }}
          >
            {t('remoteDisconnect')}
          </Button>
        ) : (
          <Button variant="primary" size="m" disabled={!canConnect} onClick={connect}>
            {t(busy ? 'remoteConnecting' : 'remoteConnect')}
          </Button>
        )}
        <Button
          variant="outlined"
          size="m"
          disabled={!connected}
          onClick={() => fireAndForget(() => useRemoteStore.getState().refreshSessions())}
        >
          {t('remoteRefreshSessions')}
        </Button>
      </div>

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
