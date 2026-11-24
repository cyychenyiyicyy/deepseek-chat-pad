import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { hostNameOf, useRemoteStore } from '../../services/remote/store.js'
import {
  IconBrowseOutline16,
  IconCheckOutline16,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconLinkOutline16,
  IconRefreshOutline16,
} from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { showToast } from '../base/toastState.js'
import { closeMobileSider } from '../sider/mobileSiderState.js'
import { enterRemoteMode, exitRemoteMode, useRemoteMode } from './RemoteModeSwitch.js'
import styles from './HostSwitcher.module.css'

export const HostSwitcher = ({ onOpen }: { onOpen: () => void }) => {
  const t = useTranslate()
  const local = useRemoteMode((state) => state.mode === 'local')
  const hosts = useRemoteStore((state) => state.hosts)
  const hostId = useRemoteStore((state) => state.hostId)
  const lastHostName = useRemoteStore((state) => state.lastSession?.hostName)
  const ready = useRemoteStore((state) => state.phase === 'ready')
  const hostSwitch = useRemoteStore((state) => state.hostSwitch)
  const switching = hostSwitch.status === 'switching'

  useEffect(() => {
    if (hostSwitch.status !== 'failed') return
    const name = hostSwitch.targetName ?? hostSwitch.targetId ?? ''
    const reason = hostSwitch.message ?? hostSwitch.code ?? ''
    const rollback = hostSwitch.rolledBackTo ? t('hostSwitchRolledBack', { name: hostSwitch.rolledBackTo }) : ''
    showToast(`${t('hostSwitchFailed', { name, reason })}${rollback}`)
    useRemoteStore.getState().dismissHostSwitch()
  }, [hostSwitch, t])

  const label = local ? t('remoteModeLocal') :
    (hosts.find((host) => host.deviceId === hostId)?.name.trim() || lastHostName || t('remoteModeRemote'))
  const status = switching ? t('hostSwitchConnecting', { name: hostSwitch.targetName ?? hostSwitch.targetId ?? '' }) :
    local ? t('hostSwitchLocalShort') : t(ready ? 'remotePhaseReady' : 'hostSwitchDisconnected')

  return (
    <button className={styles.trigger} type="button" aria-haspopup="dialog" title={label} onClick={onOpen}>
      <span className={styles.icon} aria-hidden="true">
        {local ? <IconBrowseOutline16 /> : <IconLinkOutline16 />}
      </span>
      <span className={styles.copy}>
        <span className={styles.name}>{label}</span>
        <span className={styles.status}>
          {!local && <span className={ready ? styles.online : styles.offline} aria-hidden="true" />}
          {status}
        </span>
      </span>
      <span className={styles.caret} aria-hidden="true"><IconChevronDownOutline14 /></span>
      <span className={styles.srOnly}>{t('hostSwitchLabel')}</span>
    </button>
  )
}

export const HostPicker = ({ onClose, onManage }: { onClose: () => void; onManage: () => void }) => {
  const t = useTranslate()
  const local = useRemoteMode((state) => state.mode === 'local')
  const hosts = useRemoteStore((state) => state.hosts)
  const hostId = useRemoteStore((state) => state.hostId)
  const lastHostName = useRemoteStore((state) => state.lastSession?.hostName)
  const ready = useRemoteStore((state) => state.phase === 'ready')
  const switching = useRemoteStore((state) => state.hostSwitch.status === 'switching')
  const [refreshing, setRefreshing] = useState(false)
  const visibleHosts = ready ? hosts : []
  const currentIsListed = visibleHosts.some((host) => host.deviceId === hostId)

  const choose = (mode: 'local' | 'remote', target?: string) => {
    if (mode === 'local') {
      exitRemoteMode()
    } else {
      if (target && target !== hostId) void useRemoteStore.getState().switchHost(target).catch(() => undefined)
      enterRemoteMode()
    }
    onClose()
    closeMobileSider()
  }

  return (
    <div className={styles.picker}>
      <div className={styles.pickerList}>
        <button type="button" className={styles.row} aria-current={local ? 'true' : undefined} onClick={() => choose('local')}>
          <span className={styles.icon} aria-hidden="true"><IconBrowseOutline16 /></span>
          <span className={styles.copy}>
            <span className={styles.name}>{t('remoteModeLocal')}</span>
            <span className={styles.status}>{t('hostSwitchLocalHint')}</span>
          </span>
          {local && <span className={styles.check} aria-hidden="true"><IconCheckOutline16 /></span>}
        </button>
        {!currentIsListed && (
          <button type="button" className={styles.row} aria-current={!local ? 'true' : undefined} onClick={() => choose('remote')}>
            <span className={styles.icon} aria-hidden="true"><IconLinkOutline16 /></span>
            <span className={styles.copy}>
              <span className={styles.name}>{lastHostName || t('remoteModeRemote')}</span>
              <span className={styles.status}>{t(ready ? 'remotePhaseReady' : 'hostSwitchDisconnected')}</span>
            </span>
            {!local && <span className={styles.check} aria-hidden="true"><IconCheckOutline16 /></span>}
          </button>
        )}
        {visibleHosts.map((host) => {
          const current = !local && host.deviceId === hostId
          const disabled = switching || host.identityMismatch || (!host.online && host.deviceId !== hostId)
          const status = host.identityMismatch ? t('hostSwitchIdentityHint') :
            t(host.deviceId === hostId ? 'remotePhaseReady' : host.online ? 'hostSwitchOnline' : 'hostSwitchOffline')
          return (
            <button
              key={host.deviceId}
              type="button"
              className={styles.row}
              disabled={disabled}
              aria-current={current ? 'true' : undefined}
              onClick={() => choose('remote', host.deviceId)}
            >
              <span className={styles.icon} aria-hidden="true"><IconLinkOutline16 /></span>
              <span className={styles.copy}>
                <span className={styles.name}>{hostNameOf(hosts, host.deviceId)}</span>
                <span className={styles.status}>{status}</span>
              </span>
              {current && <span className={styles.check} aria-hidden="true"><IconCheckOutline16 /></span>}
            </button>
          )
        })}
      </div>
      <div className={styles.actions}>
        <button type="button" className={styles.manage} onClick={onManage}>
          {t('remoteConnectionTitle')}
          <IconChevronRightOutline14 />
        </button>
        {ready && visibleHosts.length > 0 && (
          <IconButton
            tooltip={t('hostSwitchRefresh')}
            icon={<IconRefreshOutline16 />}
            size="xl"
            disabled={refreshing || switching}
            onClick={() => {
              setRefreshing(true)
              void useRemoteStore.getState().refreshHosts().catch(() => undefined).finally(() => setRefreshing(false))
            }}
          />
        )}
      </div>
    </div>
  )
}
