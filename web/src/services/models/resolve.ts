import { streamMessage } from '../api/client.js'
import { streamOpenAI, type OpenAIMessage } from '../api/openai.js'
import type { CreateMessageRequest, MessageParam, MessageStreamEvent } from '../api/types.js'
import { useSettings } from '../settings.js'
import { chatUrl, findModelMeta, loadCoreProviders, type ModelMeta, type ProviderMeta } from './catalog.js'
import { DEEPSEEK_MODELS, useModelState, type ModelEntry, type ProviderConfig } from './store.js'

/** 当前生效的厂商 + 模型 + 鉴权 */
export type ResolvedModel = {
  provider: ProviderConfig
  model: ModelEntry
  apiKey: string
  /** 对话接口的完整地址 */
  url: string
  meta: ModelMeta | null
  isDeepseek: boolean
}

/** 内置 DeepSeek 厂商，Key 取设置里的那一份 */
const deepseekProvider = (models: ModelEntry[]): ProviderConfig => ({
  id: 'deepseek',
  name: 'DeepSeek',
  api: 'https://api.deepseek.com',
  compat: 'anthropic',
  apiKey: '',
  models,
  fetchedAt: 0,
  builtin: true,
})

let coreCache: ProviderMeta[] | null = null

/** 读一次内置目录，用于补全模型元信息（上下文、是否支持思考等） */
export const ensureCatalog = async (): Promise<ProviderMeta[]> => {
  if (!coreCache) coreCache = await loadCoreProviders()
  return coreCache
}

/** DeepSeek 的两个内置模型补上目录里的元信息 */
const withCatalogMeta = (entries: ModelEntry[], catalog: ProviderMeta[]): ModelEntry[] =>
  entries.map((entry) => {
    const meta = findModelMeta(catalog, 'deepseek', entry.id)
    if (!meta) return entry
    return { ...entry, meta, name: meta.name || entry.name }
  })

/** 解析当前选择；provider 找不到时回落到 DeepSeek */
export const resolveActiveModel = (catalog: ProviderMeta[] = []): ResolvedModel => {
  const settings = useSettings.getState()
  const { providers, active } = useModelState.getState()
  const deepseek = deepseekProvider(withCatalogMeta(DEEPSEEK_MODELS, catalog))
  const custom = providers.find((p) => p.id === active.providerId)

  if (!custom) {
    const model =
      deepseek.models.find((m) => m.id === active.modelId) ?? deepseek.models[0] ?? { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' }
    return {
      provider: deepseek,
      model,
      apiKey: settings.apiKey ?? '',
      url: chatUrl(deepseek.api, 'anthropic'),
      meta: model.meta ?? null,
      isDeepseek: true,
    }
  }

  const model = custom.models.find((m) => m.id === active.modelId) ?? custom.models[0] ?? { id: '', name: '未选择模型' }
  return {
    provider: custom,
    model,
    apiKey: custom.apiKey,
    url: chatUrl(custom.api, custom.compat),
    meta: model.meta ?? null,
    isDeepseek: false,
  }
}

/** 把本应用的 Messages 结构降级成 OpenAI 兼容的纯文本消息 */
const toOpenAIMessages = (body: CreateMessageRequest): OpenAIMessage[] => {
  const messages: OpenAIMessage[] = [{ role: 'system', content: body.system }]
  for (const param of body.messages as MessageParam[]) {
    if (param.role === 'latest_reminder') continue
    if (param.role === 'user') {
      if (typeof param.content === 'string') {
        messages.push({ role: 'user', content: param.content })
        continue
      }
      const parts = param.content
        .map((block) => {
          if (block.type === 'text') return block.text
          // 自定义厂商下附件不参与请求（UI 已限制），这里给出可见占位，避免内容凭空消失
          return block.type === 'image' ? '［附件：图片］' : '［附件：文档］'
        })
        .join('\n')
      messages.push({ role: 'user', content: parts })
      continue
    }
    const text = param.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('')
    if (text) messages.push({ role: 'assistant', content: text })
  }
  return messages
}

/** 用首条提问生成会话标题，替代 DeepSeek 服务端的 title 扩展 */
const deriveTitle = (body: CreateMessageRequest): string => {
  for (let i = body.messages.length - 1; i >= 0; i -= 1) {
    const param = body.messages[i]
    if (param.role !== 'user') continue
    const text =
      typeof param.content === 'string'
        ? param.content
        : param.content.map((b) => (b.type === 'text' ? b.text : '')).join(' ')
    const clean = text.replace(/\s+/g, ' ').trim()
    if (clean) return clean.slice(0, 24)
  }
  return ''
}

/**
 * 发送对话请求，按当前选择的厂商走不同协议，对外统一产出 Messages 事件流。
 * 切换到自定义模型时，深度思考只在模型支持的情况下开启。
 */
export async function* streamChat(
  body: CreateMessageRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const catalog = await ensureCatalog()
  const resolved = resolveActiveModel(catalog)

  if (resolved.isDeepseek) {
    yield* streamMessage(resolved.apiKey, { ...body, model: resolved.model.id }, signal)
    return
  }

  if (!resolved.apiKey) {
    throw new Error('当前模型还没有填写 API Key')
  }

  const thinking = body.thinking.type === 'enabled' && Boolean(resolved.meta?.reason)
  const messages = toOpenAIMessages(body)
  // DeepSeek 的服务端工具（联网搜索 / 读链接）不能发给第三方端点，否则直接 400
  void body.tools

  const stream = streamOpenAI({
    apiKey: resolved.apiKey,
    url: resolved.url,
    model: resolved.model.id,
    messages,
    thinking,
    noTemperature: Boolean(resolved.meta?.noTemp),
    signal,
  })

  // 自定义厂商没有服务端标题，先补一条带标题的 message_delta，让会话列表有名字
  if (body.title?.enabled) {
    const title = deriveTitle(body)
    if (title) {
      yield {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null, title },
      }
    }
  }

  yield* stream
}
