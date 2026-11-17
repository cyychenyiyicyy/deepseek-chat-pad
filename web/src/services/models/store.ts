/**
 * 模型与厂商配置。
 *
 * 两类厂商：
 *   - deepseek：内置，Key 复用设置里的 DeepSeek Key（搜索、文件、余额都用它）
 *   - 自定义：用户填 Base URL + API Key，模型列表从端点自己拉，元信息用本地目录补全
 *
 * 这里只管「选了谁」，不碰网络；拉模型列表的逻辑在 models/remote.ts。
 */
import { create } from 'zustand'
import type { ModelMeta } from './catalog.js'

/** 一个可对话的模型：id 是端点认识的模型名，meta 是本地目录里的元信息 */
export type ModelEntry = {
  id: string
  name: string
  meta?: ModelMeta
}

export type ProviderConfig = {
  id: string
  name: string
  /** 对话 base URL，例如 https://api.minimax.io/anthropic/v1 */
  api: string
  compat: 'openai' | 'anthropic'
  /** 内置厂商的 Key 存在设置里，这里留空 */
  apiKey: string
  models: ModelEntry[]
  fetchedAt: number
  builtin?: boolean
}

export type ActiveModel = { providerId: string; modelId: string }

type ModelState = {
  providers: ProviderConfig[]
  active: ActiveModel
}

const KEY = 'chat-demo:model-state'
const DEFAULT_ACTIVE: ActiveModel = { providerId: 'deepseek', modelId: 'deepseek-flash' }

const read = (): ModelState => {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { providers: [], active: DEFAULT_ACTIVE }
    const parsed = JSON.parse(raw) as Partial<ModelState>
    const providers = Array.isArray(parsed.providers) ? parsed.providers : []
    const active =
      parsed.active && typeof parsed.active.providerId === 'string' && typeof parsed.active.modelId === 'string'
        ? parsed.active
        : DEFAULT_ACTIVE
    return { providers, active }
  } catch {
    return { providers: [], active: DEFAULT_ACTIVE }
  }
}

const persist = (state: ModelState) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    // 存储不可用时只在内存里生效
  }
}

export const useModelState = create<ModelState>(() => read())

const commit = (next: ModelState) => {
  persist(next)
  useModelState.setState(next)
}

export const setActiveModel = (providerId: string, modelId: string) =>
  commit({ ...useModelState.getState(), active: { providerId, modelId } })

/** 新增或覆盖一个自定义厂商 */
export const upsertProvider = (provider: ProviderConfig) => {
  const state = useModelState.getState()
  const index = state.providers.findIndex((p) => p.id === provider.id)
  const providers =
    index >= 0
      ? state.providers.map((p) => (p.id === provider.id ? provider : p))
      : [...state.providers, provider]
  commit({ ...state, providers })
}

export const removeProvider = (providerId: string) => {
  const state = useModelState.getState()
  const providers = state.providers.filter((p) => p.id !== providerId)
  const active =
    state.active.providerId === providerId ? { providerId: 'deepseek', modelId: 'deepseek-flash' } : state.active
  commit({ providers, active })
}

/** 只更新模型列表，保留其它字段 */
export const setProviderModels = (providerId: string, models: ModelEntry[], fetchedAt = Date.now()) => {
  const state = useModelState.getState()
  commit({
    ...state,
    providers: state.providers.map((p) => (p.id === providerId ? { ...p, models, fetchedAt } : p)),
  })
}

export const newProviderId = () =>
  `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/** DeepSeek 内置厂商的常量：Key 在设置里 */
export const DEEPSEEK_PROVIDER: Omit<ProviderConfig, 'apiKey' | 'models' | 'fetchedAt'> = {
  id: 'deepseek',
  name: 'DeepSeek',
  api: 'https://api.deepseek.com',
  compat: 'anthropic',
  builtin: true,
}

/** 内置的两个对话模型；元信息在目录可用时会被补上 */
export const DEEPSEEK_MODELS: ModelEntry[] = [
  { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
]
