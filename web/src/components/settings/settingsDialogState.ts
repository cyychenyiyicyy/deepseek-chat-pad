import { create } from 'zustand'
import { useSettings } from '../../services/settings.js'

/** 设置弹窗的分组：通用设置 / 模型服务 / 远程 DSH / 数据管理 */
export type SettingsSection = 'general' | 'models' | 'remote' | 'data'

/**
 * 设置弹窗：侧边栏底部、没有 API Key 时的操作与 401 提示都可以打开；section 为当前分组。
 *
 * `section` 故意放在 store 里（而不是组件内的 useState）：别的面板要能**把用户带到另一个分组**
 * —— 例如「远程 DSH」面板只留一句「后台与权限在通用设置里」，点一下就得真的切过去
 * （挂载时读一次的写法在这里会失效：弹窗已经开着，重新 open 不会重建组件）。
 */
export const useSettingsDialog = create(() => ({
  open: false,
  section: 'general' as SettingsSection,
}))

export const openSettings = (section: SettingsSection) =>
  useSettingsDialog.setState({ open: true, section })

/** 切换分组（弹窗内的导航与「跳到别处」的入口共用同一条写入路径） */
export const setSettingsSection = (section: SettingsSection) =>
  useSettingsDialog.setState({ section })

export const closeSettings = () => useSettingsDialog.setState({ open: false })

/** 没有 API Key 时打开设置并选中 API Key 所在的「数据管理」，返回是否已有 Key */
export const ensureApiKey = () => {
  if (useSettings.getState().apiKey) {
    return true
  }
  openSettings('data')
  return false
}
