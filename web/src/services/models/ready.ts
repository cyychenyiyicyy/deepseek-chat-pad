import { ensureApiKey } from '../../components/settings/settingsDialogState.js'
import { showToast } from '../../components/base/toastState.js'
import { useSettings } from '../settings.js'
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

/**
 * 是否已经有任一可用凭据：DeepSeek 的 Key，或某个填了 Key 的自定义端点。
 * 首次启动时用它决定要不要弹设置，避免只想用第三方模型的人被强行要求填 DeepSeek Key。
 */
export const hasAnyCredential = (): boolean => {
  const { providers } = useModelState.getState()
  return Boolean(useSettings.getState().apiKey) || providers.some((p) => Boolean(p.apiKey))
}
