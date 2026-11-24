import { lazy, Suspense, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { openDshWeb, supportsDshWeb } from '../../services/remote/dshWeb.js'
import { describeRemoteError, lastRemoteTarget, type RemoteCallTarget } from '../../services/remote/sessionsApi.js'
import { useRemoteStore } from '../../services/remote/store.js'
import { DSH_WEB_CAPABILITY } from '../../vendor/dsh-remote/protocol/dsh-web.js'
import {
  IconBrowseOutline16,
  IconChevronRightOutline14,
  IconDataOutline16,
  IconLinkOutline16,
  IconSettingsOutline16,
  IconThinkOutline16,
} from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import { useRemoteAvailability } from './RemoteModeSwitch.js'
import styles from './RemoteWorkspaceTools.module.css'

const SessionBackups = lazy(() => import('./SessionBackups.js'))
const RemoteConversationShares = lazy(() => import('./RemoteConversationShares.js'))
const HostPlugins = lazy(() => import('./HostPlugins.js'))
const HostWorkspaces = lazy(() => import('./HostWorkspaces.js'))
const RemoteDevices = lazy(() => import('./RemoteDevices.js'))
const RemoteSchedules = lazy(() => import('./RemoteSchedules.js'))
const RemoteHostSettings = lazy(() => import('./RemoteHostSettings.js'))

const hostTools = [
  { kind: 'workspaces', label: 'remoteManageWorkspaces', Icon: IconBrowseOutline16 },
  { kind: 'schedules', label: 'remoteSchedules', Icon: IconDataOutline16 },
  { kind: 'plugins', label: 'remoteHostPlugins', Icon: IconSettingsOutline16 },
  { kind: 'configuration', label: 'remoteHostConfiguration', Icon: IconSettingsOutline16 },
  { kind: 'providers', label: 'remoteHostModels', Icon: IconThinkOutline16 },
  { kind: 'devices', label: 'remoteManageDevices', Icon: IconLinkOutline16 },
] as const

type HostTool = (typeof hostTools)[number]['kind']
type Tool = { kind: HostTool; target: RemoteCallTarget } | { kind: 'backups' | 'shares' }

export const RemoteWorkspaceTools = ({ onOpenConnection }: { onOpenConnection?: () => void }) => {
  const t = useTranslate()
  const { availability } = useRemoteAvailability()
  const ready = useRemoteStore((state) => state.phase === 'ready')
  const transport = useRemoteStore((state) => state.transport)
  const capabilities = useRemoteStore((state) => state.capabilities)
  const hostName = useRemoteStore((state) => state.lastSession?.hostName)
  const target = ready ? lastRemoteTarget() : null
  const [tool, setTool] = useState<Tool | null>(null)
  const [openingWeb, setOpeningWeb] = useState(false)
  const close = () => setTool(null)

  if (availability !== 'ready') {
    return onOpenConnection ? <p className={styles.hint}>{t(
      availability === 'probing' ? 'remoteCheckingAvailability' :
        availability === 'outdated' ? 'remoteBridgeOutdated' : 'remoteRequiresApp',
    )}</p> : null
  }

  return (
    <div className={styles.tools}>
      {onOpenConnection || target ? (
        <section className={styles.group} aria-label={t('remoteWorkspaceHost')}>
          <div className={styles.groupHeading}>
            <h3>{t('remoteWorkspaceHost')}</h3>
            {target && hostName ? <span>{hostName}</span> : null}
          </div>
          <div className={styles.rows}>
            {onOpenConnection ? (
              <ToolRow label="remoteConnectionTitle" Icon={IconLinkOutline16} onClick={onOpenConnection} />
            ) : null}
            {target && hostTools.filter(({ kind }) => kind !== 'devices' || transport !== 'ssh').map(({ kind, label, Icon }) => (
              <ToolRow key={kind} label={label} Icon={Icon} onClick={() => setTool({ kind, target })} />
            ))}
            {ready && capabilities.includes(DSH_WEB_CAPABILITY) && supportsDshWeb() ? (
              <ToolRow label="remoteOpenDshWeb" Icon={IconLinkOutline16} disabled={openingWeb} onClick={() => {
                setOpeningWeb(true)
                void openDshWeb().catch((error) => showToast(describeRemoteError(error).text)).finally(() => setOpeningWeb(false))
              }} />
            ) : null}
          </div>
          {!target && onOpenConnection ? <p className={styles.hint}>{t('remoteWorkspaceHostRequired')}</p> : null}
        </section>
      ) : null}
      <section className={styles.group} aria-label={t('remoteWorkspaceData')}>
        <div className={styles.groupHeading}><h3>{t('remoteWorkspaceData')}</h3></div>
        <div className={styles.rows}>
          <ToolRow label="remoteSessionBackups" Icon={IconDataOutline16} onClick={() => setTool({ kind: 'backups' })} />
          <ToolRow label="remoteHostedManage" Icon={IconLinkOutline16} onClick={() => setTool({ kind: 'shares' })} />
        </div>
      </section>
      <Suspense fallback={null}>
        {tool?.kind === 'backups' && <SessionBackups onClose={close} />}
        {tool?.kind === 'shares' && <RemoteConversationShares onClose={close} />}
        {tool && 'target' in tool && tool.target === target ? (
          <>
            {tool.kind === 'workspaces' && <HostWorkspaces target={target} onClose={close} />}
            {tool.kind === 'plugins' && <HostPlugins target={target} onClose={close} />}
            {tool.kind === 'devices' && <RemoteDevices target={target} onClose={close} />}
            {tool.kind === 'schedules' && <RemoteSchedules target={target} onClose={close} />}
            {(tool.kind === 'configuration' || tool.kind === 'providers') && (
              <RemoteHostSettings key={tool.kind} mode={tool.kind} target={target} onClose={close} />
            )}
          </>
        ) : null}
      </Suspense>
    </div>
  )
}

const ToolRow = ({ label, Icon, onClick, disabled }: {
  label: TranslationKey
  Icon: typeof IconBrowseOutline16
  onClick: () => void
  disabled?: boolean
}) => {
  const t = useTranslate()
  return (
    <button type="button" className={styles.row} disabled={disabled} onClick={onClick}>
      <span className={styles.icon} aria-hidden="true"><Icon /></span>
      <span>{t(label)}</span>
      <span className={styles.chevron} aria-hidden="true"><IconChevronRightOutline14 /></span>
    </button>
  )
}
