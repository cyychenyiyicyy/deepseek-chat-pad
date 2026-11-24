import { create } from 'zustand'
import { useTranslate } from '../../i18n/index.js'
import { Modal } from '../base/Modal.js'
import { HostPicker } from './HostSwitcher.js'
import { enterRemoteMode } from './RemoteModeSwitch.js'
import { RemoteSettingsPanel } from './RemoteSettingsPanel.js'
import { RemoteWorkspaceTools } from './RemoteWorkspaceTools.js'
import styles from './RemoteWorkspaceTools.module.css'

type WorkspaceDialog = 'host' | 'connection' | 'tools'

const useWorkspaceDialog = create<{ dialog: WorkspaceDialog | null }>(() => ({ dialog: null }))

export const openRemoteWorkspaceDialog = (dialog: WorkspaceDialog) => useWorkspaceDialog.setState({ dialog })

const close = () => useWorkspaceDialog.setState({ dialog: null })

export const RemoteWorkspaceDialog = () => {
  const t = useTranslate()
  const dialog = useWorkspaceDialog((state) => state.dialog)
  if (dialog === null) return null

  return (
    <Modal
      title={t(dialog === 'host' ? 'hostSwitchLabel' : dialog === 'connection' ? 'remoteConnectionTitle' : 'remoteWorkspaceTools')}
      className={dialog === 'host' ? styles.hostDialog : styles.dialog}
      closable
      onClose={close}
    >
      {dialog === 'host'
        ? <HostPicker onClose={close} onManage={() => {
            enterRemoteMode()
            openRemoteWorkspaceDialog('connection')
          }} />
        : dialog === 'connection'
        ? <RemoteSettingsPanel connectionOnly />
        : <RemoteWorkspaceTools onOpenConnection={() => openRemoteWorkspaceDialog('connection')} />}
    </Modal>
  )
}
