import { ensureApiKey } from '../../components/settings/settingsDialogState.js'
import { showToast } from '../../components/base/toastState.js'
import { useModelState } from './store.js'

/**
 * 发送前确认当前模型可用：
 * DeepSeek 走原有的 Key 校验（会顺手弹出设置），自定义端点只检查自己的 Key。
 */
export const ensureActiveModelReady = (): boolean => {
  const { active, providers } = useModelState.getState()
  if (active.providerId === 'deepseek') return ensureApiKey()

  const provider = providers.find((p) => p.id === active.providerId)
  if (!provider) {
    showToast({ key: 'modelDeepseekKeyMissing', type: 'error' })
    return false
  }
  if (!provider.apiKey) {
    showToast({ key: 'modelProviderKeyRequired', type: 'error' })
    return false
  }
  return true
}

/** 当前选择是否用了内置 DeepSeek（联网搜索、附件上传只支持它） */
export const isDeepseekActive = (): boolean =>
  useModelState.getState().active.providerId === 'deepseek'
