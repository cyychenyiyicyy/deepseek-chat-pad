import { create } from 'zustand'
import type { ReleaseInfo, UpdateState } from '../../services/update.js'

type UpdateDialogState = {
  open: boolean
  release: ReleaseInfo | null
  state: UpdateState | null
  /** 上次更新没完成 / 网页包已换但页面还是旧的，需要额外提示 */
  notice: string | null
  /** 检查更新本身失败（网络或仓库原因）时的原因 */
  error: string | null
}

/** 更新弹窗的开关状态：启动时自动检查、设置页手动检查都走这里 */
export const useUpdateDialog = create<UpdateDialogState>(() => ({
  open: false,
  release: null,
  state: null,
  notice: null,
  error: null,
}))

export const openUpdateDialog = (payload: {
  release: ReleaseInfo | null
  state: UpdateState | null
  notice?: string | null
  error?: string | null
}) => useUpdateDialog.setState({ open: true, ...payload })

export const closeUpdateDialog = () => useUpdateDialog.setState({ open: false })
