import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { hostNameOf, useRemoteStore } from '../../services/remote/store.js'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import { IconCheckOutline16, IconChevronDownOutline14, IconRefreshOutline16 } from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import styles from './HostSwitcher.module.css'

/**
 * 远程模式顶栏里的 **Host 下拉**（R14）。
 *
 * 背景：`connection.listHosts()` 早就把账号下所有 Host 连在线状态一起拉回来了，缓存也按
 * `serverUrl|hostDeviceId` 分好了桶 —— 缺的一直是让用户**主动换一台**的那个入口。这里就是它。
 *
 * 四条约定：
 *
 * 1. **只做展示与转发**：探测、校验、拆连接、回滚全在 `store.switchHost()` 里（`performHostSwitch`
 *    有自测）。这里连「能不能切」都不自己判断，只按 `online` / `identityMismatch` 决定是否禁用；
 * 2. **离线 / 身份不符标灰且不可点**，灰行下面直接写原因 —— 让用户点一下没反应、还不知道为什么，
 *    比不让点更糟；
 * 3. **切换中有明确的 loading**（「正在连接 电脑名…」）：顶栏这一粒是切走/切回期间唯一还在的
 *    可见入口，所以它必须自己说明「正在干什么」，不能只靠右侧页面那行状态；
 * 4. **失败只弹一次**：`hostSwitch.status === 'failed'` 时弹一条 toast（含「已回到 x」），
 *    紧接着 `dismissHostSwitch()` 把状态清回 `idle`，避免每次重渲染都弹。
 */

/** 数据层方法可能同步抛、也可能返回 rejected 的 promise；两者都只反映到 store 的 state */
const fireAndForget = (action: () => unknown) => {
  try {
    void Promise.resolve(action()).catch(() => undefined)
  } catch {
    // 同步抛错已由数据层写入状态，界面不重复提示
  }
}

export const HostSwitcher = ({ className }: { className?: string }) => {
  const t = useTranslate()
  const hosts = useRemoteStore((state) => state.hosts)
  const hostId = useRemoteStore((state) => state.hostId)
  const phase = useRemoteStore((state) => state.phase)
  const hostSwitch = useRemoteStore((state) => state.hostSwitch)

  const [open, setOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const switching = hostSwitch.status === 'switching'

  const anchored = useAnchoredPosition<HTMLButtonElement, HTMLDivElement>(open, {
    align: 'end',
    maxHeight: 320,
    measureKey: `${hosts.length}:${hostId ?? ''}:${hostSwitch.status}`,
  })
  useDismiss(open, [anchored.anchorRef, anchored.floatingRef], () => setOpen(false))

  /*
   * 切换失败提示：`switchHost()` 已经把原因写进了 `hostSwitch`，这里只负责「说一次」。
   * 先弹再 dismiss —— 顺序反了的话下一帧就会看到 `idle`，提示就丢了。
   */
  useEffect(() => {
    if (hostSwitch.status !== 'failed') return
    const name = hostSwitch.targetName ?? hostSwitch.targetId ?? ''
    const reason = hostSwitch.message ?? hostSwitch.code ?? ''
    const rolledBack =
      hostSwitch.rolledBackTo === undefined ? '' : t('hostSwitchRolledBack', { name: hostSwitch.rolledBackTo })
    showToast(`${t('hostSwitchFailed', { name, reason })}${rolledBack}`)
    useRemoteStore.getState().dismissHostSwitch()
  }, [hostSwitch, t])

  /*
   * 切换一开始就把菜单收起来：否则切完之后它又会自己弹回来（`open` 一直是 true），
   * 用户会以为刚才那一下没生效。
   */
  useEffect(() => {
    if (switching) setOpen(false)
  }, [switching])

  /*
   * 还没有「当前这台」（从没连上 / 刚断开）：顶栏不占位。
   * 之所以敢藏：这个动作本身要求**已有一条活连接**（`switchHost()` 要拿 client/server/account），
   * 连不上时本来也切不了 —— 那种情况该走「重试连接 / 打开设置」，不是切主机。
   */
  if (!switching && hostId === null) return null

  const current = hosts.find((host) => host.deviceId === hostId)
  const currentName = hostId === null ? '' : hostNameOf(hosts, hostId)
  const busyName = hostSwitch.targetName ?? hostSwitch.targetId ?? t('hostSwitchLabel')
  const online = current?.online === true
  const label = switching
    ? t('hostSwitchConnecting', { name: busyName })
    : currentName.length > 0
      ? currentName
      : t('hostSwitchLabel')

  const refresh = (): void => {
    if (refreshing) return
    setRefreshing(true)
    void Promise.resolve(useRemoteStore.getState().refreshHosts()).finally(() => {
      setRefreshing(false)
    })
  }

  return (
    <div className={clsx(styles.wrap, className)}>
      <button
        ref={anchored.anchorRef}
        type="button"
        className={clsx(styles.trigger, switching && styles.triggerBusy, phase !== 'ready' && !switching && styles.triggerDim)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('hostSwitchLabel')}
        title={t('hostSwitchLabel')}
        disabled={switching}
        onClick={() => setOpen((value) => !value)}
      >
        <span
          className={clsx(styles.dot, online && !switching ? styles.dotOnline : styles.dotOffline)}
          aria-hidden
        />
        <span className={styles.triggerText}>{label}</span>
        <span className={styles.caret} aria-hidden>
          <IconChevronDownOutline14 />
        </span>
      </button>

      {open && !switching
        ? createPortal(
          <div
            ref={anchored.floatingRef}
            className={styles.menu}
            style={anchored.position ?? undefined}
            role="menu"
            aria-label={t('hostSwitchLabel')}
          >
            {hosts.length === 0 ? <div className={styles.empty}>{t('hostSwitchEmpty')}</div> : null}
            {hosts.map((host) => {
              const active = host.deviceId === hostId
              // 离线 / 身份不符 / 正在切：三种都不可点（原因写在灰行下面的小字里）
              const blocked = host.identityMismatch || !host.online
              const hint = host.identityMismatch
                ? t('hostSwitchIdentityHint')
                : host.online
                  ? ''
                  : t('hostSwitchOfflineHint')
              return (
                <button
                  key={host.deviceId}
                  type="button"
                  role="menuitem"
                  aria-current={active ? 'true' : undefined}
                  className={clsx(styles.row, blocked && styles.rowBlocked, active && styles.rowActive)}
                  title={hint.length > 0 ? hint : undefined}
                  disabled={blocked}
                  onClick={() => {
                    setOpen(false)
                    fireAndForget(() => useRemoteStore.getState().switchHost(host.deviceId))
                  }}
                >
                  <span
                    className={clsx(styles.dot, host.online && !host.identityMismatch ? styles.dotOnline : styles.dotOffline)}
                    aria-hidden
                  />
                  <span className={styles.rowMain}>
                    <span className={styles.rowName}>
                      {host.name.trim().length > 0 ? host.name : host.deviceId.slice(0, 8)}
                    </span>
                    <span className={styles.rowMeta}>
                      {active
                        ? t('hostSwitchCurrent')
                        : host.online && !host.identityMismatch
                          ? t('hostSwitchOnline')
                          : t('hostSwitchOffline')}
                      {host.platform !== undefined && host.platform.length > 0 ? ` · ${host.platform}` : ''}
                    </span>
                    {hint.length > 0 ? <span className={styles.rowHint}>{hint}</span> : null}
                  </span>
                  {active ? (
                    <span className={styles.check} aria-hidden>
                      <IconCheckOutline16 />
                    </span>
                  ) : null}
                </button>
              )
            })}
            <div className={styles.separator} role="separator" />
            <button type="button" className={styles.refresh} disabled={refreshing} onClick={refresh}>
              <span className={styles.refreshIcon} aria-hidden>
                <IconRefreshOutline16 />
              </span>
              {refreshing ? t('cacheSyncing') : t('hostSwitchRefresh')}
            </button>
          </div>,
          document.body,
        )
        : null}
    </div>
  )
}
