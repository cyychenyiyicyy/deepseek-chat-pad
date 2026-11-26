import { create } from 'zustand'
import { useTranslate } from '../../i18n/index.js'
import { Modal } from '../base/Modal.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { HostPicker } from './HostSwitcher.js'
import { enterRemoteMode } from './RemoteModeSwitch.js'
import { RemoteWorkspaceTools } from './RemoteWorkspaceTools.js'
import styles from './RemoteWorkspaceTools.module.css'

type WorkspaceDialog = 'host' | 'tools'

const useWorkspaceDialog = create<{ dialog: WorkspaceDialog | null }>(() => ({ dialog: null }))

const close = () => useWorkspaceDialog.setState({ dialog: null })

const openConnection = () => {
  close()
  openSettings('remote')
}

export const openRemoteWorkspaceDialog = (dialog: WorkspaceDialog | 'connection') => {
  if (dialog === 'connection') openConnection()
  else useWorkspaceDialog.setState({ dialog })
}

export const RemoteWorkspaceDialog = () => {
  const t = useTranslate()
  const dialog = useWorkspaceDialog((state) => state.dialog)
  if (dialog === null) return null

  return (
    <Modal
      title={t(dialog === 'host' ? 'hostSwitchLabel' : 'remoteWorkspaceTools')}
      className={dialog === 'host' ? styles.hostDialog : styles.dialog}
      closable
      onClose={close}
    >
      {dialog === 'host'
        ? <HostPicker onClose={close} onManage={() => {
            enterRemoteMode()
            openConnection()
          }} />
        : <RemoteWorkspaceTools onOpenConnection={openConnection} />}
    </Modal>
  )
}
