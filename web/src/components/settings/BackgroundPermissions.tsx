import clsx from 'clsx'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import {
  describeOpenError,
  openPermissionTarget,
  probePermissions,
  requestNotificationPermission,
  type KeepAlivePermissions,
  type PermissionTarget,
} from '../../services/remote/permissions.js'
import { Button } from '../base/Button.js'
import styles from './BackgroundPermissions.module.css'

/**
 * 通用设置 →「后台与权限」。
 *
 * ## 为什么在通用设置里，而不是「远程 DSH」里
 *
 * 用户原话：「你这个保护不应该是放在远程连接里面，应该是放在通用设置里面，因为除了远程连接
 * 其他也需要保护」。通知权限 / 电池优化 / 自启动 / 精确定时 / 悬浮窗是**整个 App 的后台存活
 * 能力**（前台服务、定时提醒都吃这套），远程连接只是第一个用户；放在远程面板里既难找，
 * 又暗示「不连远程就不需要」。
 *
 * ## 数据从哪来（已定稿的原生契约）
 *
 * 全部来自 `GET /__ds_keepalive/permissions.json`（见 `services/remote/permissions.ts`）：
 *
 * | 行 | 判据 |
 * |---|---|
 * | 通知权限 | `notifications.granted`；`channelBlocked` 时额外提示「渠道被单独关闭」 |
 * | 电池优化 | `battery.exempt \|\| battery.ignored` |
 * | 自启动 | `autoStart.intentAvailable`（`manufacturer` 拼进标题）；不可用就降级应用详情 |
 * | 后台保活服务 | `foregroundService.running` / `shouldRun` 三态 |
 * | 精确定时 / 悬浮窗 | **只在 `declared:true` 时显示**（本 App 没申请就干脆不出现） |
 *
 * **旧 APK / 普通浏览器整节不显示**：探测失败（404 或回了 HTML）返回 `null`，
 * 这里直接 `return null`，绝不给用户看一排「未知」。
 *
 * ## 交互约定
 *
 * 1. 所有「去开启 / 去设置」都是**用户点击**才调 `POST /__ds_keepalive/open` ——
 *    Android 10+ 禁止后台弹 Activity，非点击路径只会静默失败。
 * 2. 原生 `degraded:true`（例如厂商自启动页不存在 → 打开了应用详情）要给一句
 *    「已打开应用详情页，请在里面手动设置」，否则用户以为点错了地方。
 * 3. 用户从系统设置回来时（`visibilitychange → visible`）**重新探一次**：
 *    权限状态是系统那边的真值，页面上没有任何本地缓存可以猜。
 */

/** 还没探完 / 探测结果（`null` = 这个环境没有权限中心，整节不显示） */
type Probe = KeepAlivePermissions | null | undefined

export const BackgroundPermissions = () => {
  const t = useTranslate()
  /** `undefined` = 首次探测中（先不渲染，避免旧 APK 闪一下再消失） */
  const [snapshot, setSnapshot] = useState<Probe>(undefined)
  /** 正在拉起哪个系统页（只驱动按钮 loading，状态以原生回读为准） */
  const [busy, setBusy] = useState<PermissionTarget | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  /** 原生降级 / 失败的一句话说明（例如「这个系统没有对应的设置页」） */
  const [note, setNote] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setRefreshing(true)
    try {
      setSnapshot(await probePermissions())
    } finally {
      setRefreshing(false)
    }
  }, [])

  // 挂载即探（设置弹窗打开时才算，不在启动关键路径上）
  useEffect(() => {
    void refresh()
  }, [refresh])

  // 从系统设置返回：权限状态可能已经变了，回来重探一次
  useEffect(() => {
    if (typeof document === 'undefined') {
      return undefined
    }
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') {
        void refresh()
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [refresh])

  /**
   * 拉起系统页 / 弹授权框。
   *
   * 顺序讲究：`notifications` 且 `canRequest` → 走 `mode:'request'`（直接弹系统运行时权限框，
   * 少跳一次设置）；弹不了（`requestUnavailable`）原生会自己退回设置页，界面如实说明。
   */
  const openTarget = async (target: PermissionTarget): Promise<void> => {
    if (busy !== null) {
      return
    }
    setBusy(target)
    setNote(null)
    try {
      const wantsRequest = target === 'notifications' && snapshot !== null && snapshot !== undefined && snapshot.notifications.canRequest
      const result = wantsRequest
        ? await requestNotificationPermission()
        : await openPermissionTarget(target)
      if (result.notNeeded === true) {
        setNote(t('settingsPermissionNotNeededDone'))
        return
      }
      // 弹窗真弹了：结果不会同步回来，回前台会重新探测
      if (result.ok && result.mode === 'request') {
        setNote(t('settingsPermissionNotificationsRequested'))
        return
      }
      if (result.ok && result.requestUnavailable === true) {
        setNote(t('settingsPermissionNotificationsSettingsFallback'))
        return
      }
      // 原生降级过（`degraded:true`）：说清「打开了哪一页、要手动做什么」
      if (result.degraded) {
        setNote(t('settingsPermissionDegraded'))
        return
      }
      if (result.ok) {
        return
      }
      // 业务失败（HTTP 200 + ok:false）也可能给了降级页：再试一次，别让按钮看起来没反应
      if (result.fallback !== undefined && result.fallback !== target) {
        const retried = await openPermissionTarget(result.fallback)
        setNote(
          retried.degraded || retried.ok
            ? t('settingsPermissionDegraded')
            : describeOpenError(retried.error ?? ''),
        )
        return
      }
      setNote(describeOpenError(result.error ?? 'intent_unavailable'))
    } finally {
      setBusy(null)
    }
  }

  const action = (target: PermissionTarget, labelKey: TranslationKey, variant: 'outlined' | 'primary' = 'outlined') => (
    <Button variant={variant} size="s" disabled={busy !== null} onClick={() => void openTarget(target)}>
      {t(labelKey)}
    </Button>
  )

  // 旧 APK（404 / HTML）或首次还没探完：整节不渲染
  if (snapshot === null || snapshot === undefined) {
    return null
  }

  const notificationsOk = snapshot.notifications.granted
  const batteryOk = snapshot.battery.exempt || snapshot.battery.ignored
  const service = snapshot.foregroundService
  /** 厂商名：优先 `manufacturer`（「Xiaomi」），退回 `vendor`；都没有就只写「自启动」 */
  const vendor = snapshot.autoStart.manufacturer.trim() || snapshot.autoStart.vendor.trim()
  const autoStartLabel =
    vendor.length === 0 ? t('settingsPermissionAutoStart') : t('settingsPermissionAutoStartVendor', { vendor })

  /** 服务三态：`running` → 运行中；`shouldRun && !running` → 该跑没跑；其余 → 未启动 */
  const serviceStatus = service.running
    ? t('settingsBackgroundServiceRunning')
    : service.shouldRun
      ? t('settingsBackgroundServiceEnabledIdle')
      : t('settingsBackgroundServiceInactive')

  return (
    <div className={styles.section} role="group" aria-label={t('settingsBackgroundTitle')}>
      <div className={styles.head}>
        <div className={styles.headText}>
          <div className={styles.title}>{t('settingsBackgroundTitle')}</div>
          <div className={styles.description}>
            {refreshing ? t('settingsBackgroundChecking') : t('settingsBackgroundHint')}
          </div>
        </div>
        <div className={styles.headActions}>
          <Button variant="outlined" size="s" disabled={refreshing || busy !== null} onClick={() => void refresh()}>
            {t('settingsBackgroundRefresh')}
          </Button>
        </div>
      </div>

      {/* 1. 通知权限：后台常驻服务靠它活命；渠道被单独关掉是最常见的「看着开了其实没开」
       * `declared:false` 时整行不显示（本版没申请这个权限，显示出来只会让人白点）。 */}
      {snapshot.notifications.declared ? (
        <Row
          label={t('settingsPermissionNotifications')}
          status={t(notificationsOk ? 'settingsPermissionGranted' : 'settingsPermissionDenied')}
          ok={notificationsOk}
          description={t('settingsPermissionNotificationsHint')}
          extra={
            notificationsOk
              ? snapshot.notifications.channelBlocked
                ? t('settingsPermissionNotificationsChannelBlocked')
                : null
              : snapshot.notifications.canRequest
                ? null
                : t('settingsPermissionNotificationsManual')
          }
          warn={notificationsOk && snapshot.notifications.channelBlocked}
          action={notificationsOk ? null : action('notifications', 'settingsPermissionNotificationsAction')}
        />
      ) : null}

      {/* 2. 电池优化：不豁免就会在锁屏时被系统冻结 */}
      {snapshot.battery.declared ? (
        <Row
          label={t('settingsPermissionBattery')}
          status={t(batteryOk ? 'settingsPermissionGranted' : 'settingsPermissionDenied')}
          ok={batteryOk}
          description={t('settingsPermissionBatteryHint')}
          action={batteryOk ? null : action('battery', 'settingsPermissionBatteryAction')}
        />
      ) : null}

      {/* 3. 自启动：厂商页（MIUI / EMUI / ColorOS…），没有就降级到应用详情。
       * 自启动没有「已授予」这种可读状态（原生只告诉能不能跳厂商页），所以状态写
       * 「可打开设置页 / 当前系统没有这个设置页」，别假装知道人家到底开没开。 */}
      <Row
        label={autoStartLabel}
        status={
          snapshot.autoStart.intentAvailable
            ? t('settingsPermissionAvailable')
            : t('settingsPermissionUnavailable')
        }
        ok={snapshot.autoStart.intentAvailable}
        description={t('settingsPermissionAutoStartHint')}
        extra={snapshot.autoStart.intentAvailable ? null : t('settingsPermissionAutoStartFallback', { vendor: vendor || 'Android' })}
        action={action('autoStart', 'settingsPermissionAutoStartAction')}
      />

      {/* 4. 后台保活服务：running / shouldRun 三态（不依赖上面任何权限） */}
      <Row
        label={t('settingsBackgroundService')}
        status={serviceStatus}
        ok={service.running}
        description={t('settingsBackgroundServiceHint')}
        extra={service.shouldRun && !service.running ? t('settingsBackgroundServiceKilled') : null}
        action={null}
      />

      {/* 5. 精确定时：**只在 `declared:true` 时出现**（本 App 没申请就干脆不显示） */}
      {snapshot.exactAlarm.declared ? (
        <Row
          label={t('settingsPermissionExactAlarm')}
          status={t(
            snapshot.exactAlarm.granted
              ? 'settingsPermissionGranted'
              : snapshot.exactAlarm.needed
                ? 'settingsPermissionNeeded'
                : 'settingsPermissionNotNeeded',
          )}
          ok={snapshot.exactAlarm.granted}
          description={t('settingsPermissionExactAlarmHint')}
          action={snapshot.exactAlarm.granted ? null : action('exactAlarm', 'settingsPermissionExactAlarmAction')}
        />
      ) : null}

      {/* 6. 悬浮窗（可选）：同样只在 `declared:true` 时出现 */}
      {snapshot.overlay.declared ? (
        <Row
          label={t('settingsPermissionOverlay')}
          status={t(snapshot.overlay.granted ? 'settingsPermissionGranted' : 'settingsPermissionDenied')}
          ok={snapshot.overlay.granted}
          description={t('settingsPermissionOverlayHint')}
          action={snapshot.overlay.granted ? null : action('overlay', 'settingsPermissionOverlayAction')}
        />
      ) : null}

      {note === null ? null : (
        <div className={styles.note} role="status">
          {note}
        </div>
      )}
    </div>
  )
}

/** 一行：权限名 + 状态 + 说明 + 一个按钮 */
const Row = ({
  label,
  status,
  ok,
  description,
  extra,
  warn = false,
  action,
}: {
  label: string
  status: string
  ok: boolean
  description: string
  extra?: string | null
  /** `extra` 是不是「要处理」的提示（用错误色），而不是补充说明 */
  warn?: boolean
  action: ReactNode | null
}) => (
  <div className={styles.row}>
    <div className={styles.rowText}>
      <div className={styles.label}>
        <span>{label}</span>
        <span className={clsx(styles.status, ok ? styles.statusOk : styles.statusWarn)}>{status}</span>
      </div>
      {extra === undefined || extra === null ? (
        <div className={styles.description}>{description}</div>
      ) : (
        <div className={clsx(styles.description, warn && styles.descriptionWarn)}>{extra}</div>
      )}
    </div>
    {action === null ? null : <div className={styles.rowAction}>{action}</div>}
  </div>
)
