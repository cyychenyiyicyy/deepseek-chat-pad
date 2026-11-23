
import '../../web/src/polyfills.js'
import { createRoot } from 'react-dom/client'
import { App } from '../../web/src/app/App.js'
import { setupTheme } from '../../web/src/app/theme.js'
import { setApiKey, useSettings } from '../../web/src/services/settings.js'
import { useChatStore } from '../../web/src/services/chat/store.js'
import { useRemoteStore } from '../../web/src/services/remote/store.js'
import { observeRemoteTarget, type RemoteCallTarget } from '../../web/src/services/remote/sessionsApi.js'
import { listSessionBackups, openSessionBackup, saveSessionBackup } from '../../web/src/services/remote/sessionBackupDb.js'
import { closeSettings, openSettings } from '../../web/src/components/settings/settingsDialogState.js'
import { useNewSessionStore } from '../../web/src/services/remote/newSessionStore.js'
import { useChatControls } from '../../web/src/services/remote/sessionControls.js'
import { useWorkspacePane } from '../../web/src/components/remote/workspace/workspacePaneStore.js'
import { setChatMode } from '../../web/src/components/remote/RemoteModeSwitch.js'
import { telemetry } from './tablet-test-link.js'
import { runRtcTransportQA } from './tablet-rtc-qa.js'
import '../../web/src/app/theme.css'
import '../../web/src/app/global.css'

const sessionId = 'qa-a'
const otherId = 'qa-b'
const now = Date.now()
const sessions = [
  { id: sessionId, title: 'Tablet workspace alpha', updatedAt: now },
  { id: otherId, title: 'Tablet workspace beta', updatedAt: now - 1000 },
]
const itemsFor = (id: string) => [
  { id: 'user', sessionId: id, kind: 'message', role: 'user', text: 'My request for ' + id, createdAt: now },
  { id: 'assistant', sessionId: id, kind: 'message', role: 'assistant', text: 'A distinct response for ' + id, createdAt: now + 1000 },
] as const
const quiet = async () => {}
const calls: Array<{ endpoint: string; args: Record<string, unknown> }> = []
let pluginEnabled = false
let workspaces = [
  { workspaceId: 'folder', title: 'Tablet project', path: '/project', sessionIds: [sessionId, otherId] },
  { workspaceId: 'other-folder', title: 'Other project', path: '/other', sessionIds: [] },
]
const target: RemoteCallTarget = {
  async rpc<T>(_method: string, params?: unknown): Promise<T> {
    const { endpoint, payload: { args } } = params as {
      endpoint: string
      payload: { args: Record<string, unknown> }
    }
    calls.push({ endpoint, args })
    const succeed = (value?: unknown) => ({ ok: true, value }) as T
    if (endpoint === 'pluginManager/listBundles') return succeed([{ name: 'fixture-plugin', enabled: pluginEnabled }])
    if (endpoint === 'pluginManager/listPlugins') return succeed([
      { entryId: 'fixture-entry', moduleName: 'protected-plugin', enabled: true, readOnlyReason: 'management-required' },
    ])
    if (endpoint === 'pluginManager/setBundleEnabled') {
      pluginEnabled = args.enabled === true
      return succeed({ application: 'applied' })
    }
    const request = args.request as { workspaceId: string; title?: string; beforeWorkspaceId?: string; sessionId?: string; beforeSessionId?: string } | undefined
    if (endpoint === 'workspace/rename' && request) {
      workspaces = workspaces.map((item) => item.workspaceId === request.workspaceId ? { ...item, title: request.title ?? item.title } : item)
      return succeed({ workspace: workspaces.find((item) => item.workspaceId === request.workspaceId) })
    }
    if (endpoint === 'workspace/insertBefore' && request) {
      const item = workspaces.find((row) => row.workspaceId === request.workspaceId)
      if (!item) throw new Error('Missing workspace')
      workspaces = workspaces.filter((row) => row !== item)
      const before = workspaces.findIndex((row) => row.workspaceId === request.beforeWorkspaceId)
      workspaces.splice(before < 0 ? workspaces.length : before, 0, item)
      return succeed({ workspaceIds: workspaces.map((row) => row.workspaceId) })
    }
    if (endpoint === 'workspace/insertSessionBefore' && request?.sessionId) {
      const workspace = workspaces.find((row) => row.workspaceId === request.workspaceId)
      if (!workspace || !workspace.sessionIds.includes(request.sessionId)) throw new Error('Missing workspace session')
      const reordered = workspace.sessionIds.filter((id) => id !== request.sessionId)
      const before = request.beforeSessionId === undefined ? -1 : reordered.indexOf(request.beforeSessionId)
      reordered.splice(before < 0 ? reordered.length : before, 0, request.sessionId)
      const updated = { ...workspace, sessionIds: reordered }
      workspaces = workspaces.map((item) => item === workspace ? updated : item)
      return succeed({ workspace: updated })
    }
    if (endpoint === 'workspace/delete' && request) {
      workspaces = workspaces.filter((row) => row.workspaceId !== request.workspaceId)
      return succeed()
    }
    return { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: endpoint } } as T
  },
  async openStream() { throw new Error('Unexpected stream') },
}
if (new URLSearchParams(location.search).has('management')) observeRemoteTarget(target)
const integration = new URLSearchParams(location.search).has('integration')
useSettings.setState({ locale: 'en-US', themePreference: 'light', autoCheckUpdate: false })
setApiKey('fixture-only')
useChatStore.setState({ ready: true })
if (!integration) useRemoteStore.setState({
  phase: 'ready', hostId: 'test-host', transport: 'relay', sessions,
  activeSessionId: sessionId, items: [...itemsFor(sessionId)],
  autoConnectNow: quiet, onAppForeground: quiet, resumeLogin: quiet, refreshSessions: quiet,
  openSession: async (id) => { useRemoteStore.setState({ activeSessionId: id, items: [...itemsFor(id)] }) },
})
const refreshInventory = useNewSessionStore.getState().refresh
if (integration) {
  useRemoteStore.setState({ autoConnectNow: quiet, onAppForeground: quiet, resumeLogin: quiet })
}
useNewSessionStore.setState({
  capabilities: { ...useNewSessionStore.getState().capabilities, create: true, workspace: true },
  workspaces, hostWorkspaces: workspaces,
  probeCapabilities: quiet, refresh: quiet, ensureWorkspaceFlags: quiet,
})
useChatControls.setState({ probe: quiet })
const workspaceRefresh = useWorkspacePane.getState().refresh
useWorkspacePane.setState({
  open: false, filesSupported: true, rootPath: '/project', rootSource: 'unknown',
  refresh: quiet,
})
setChatMode(new URLSearchParams(location.search).has('local') ? 'local' : 'remote')
setupTheme()
createRoot(document.getElementById('root')!).render(<App />)
Object.assign(window, {
  fixture: {
    remote: useRemoteStore, workspace: useWorkspacePane, newSession: useNewSessionStore, settings: useSettings, refreshInventory, workspaceRefresh,
    openSettings, closeSettings, calls, listSessionBackups, openSessionBackup, saveSessionBackup, telemetry, runRtcTransportQA,
  },
})

