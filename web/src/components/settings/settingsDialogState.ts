import { create } from 'zustand'
import { useSettings } from '../../services/settings.js'

export type SettingsSection = 'general' | 'models' | 'remote' | 'data'

const settingsHash = '#settings'
const readLocation = () => {
  const { hash } = window.location
  const value = hash.startsWith(settingsHash + '/') ? hash.slice(settingsHash.length + 1) : ''
  const section = value === 'general' || value === 'models' || value === 'remote' || value === 'data'
    ? value : null
  return { open: hash === settingsHash || section !== null, section }
}

export const useSettingsDialog = create(readLocation)

let dismissing = false
window.addEventListener('popstate', () => {
  dismissing = false
  useSettingsDialog.setState(readLocation())
})

export const openSettings = (section?: SettingsSection) => {
  if (dismissing) return
  if (!useSettingsDialog.getState().open) {
    window.history.pushState({ settingsDepth: 1 }, '', settingsHash)
    useSettingsDialog.setState(readLocation())
  }
  if (section) setSettingsSection(section)
}

export const setSettingsSection = (section: SettingsSection) => {
  const current = useSettingsDialog.getState()
  if (dismissing || !current.open || current.section === section) return
  const url = settingsHash + '/' + section
  const depth = window.history.state?.settingsDepth ?? 0
  if (depth === 1) window.history.pushState({ settingsDepth: 2 }, '', url)
  else window.history.replaceState(window.history.state, '', url)
  useSettingsDialog.setState(readLocation())
}

export const showSettingsList = () => {
  if (dismissing || !useSettingsDialog.getState().section) return
  if (window.history.state?.settingsDepth === 2) {
    dismissing = true
    window.history.back()
  } else {
    window.history.replaceState(window.history.state, '', settingsHash)
    useSettingsDialog.setState(readLocation())
  }
}

export const closeSettings = () => {
  if (dismissing || !useSettingsDialog.getState().open) return
  const depth = window.history.state?.settingsDepth ?? 0
  if (depth > 0) {
    dismissing = true
    window.history.go(-depth)
  } else {
    const url = new URL(window.location.href)
    url.hash = ''
    window.history.replaceState(window.history.state, '', url)
    useSettingsDialog.setState(readLocation())
  }
}

/** 没有 API Key 时打开设置并选中 API Key 所在的「数据管理」，返回是否已有 Key */
export const ensureApiKey = () => {
  if (useSettings.getState().apiKey) {
    return true
  }
  openSettings('data')
  return false
}
