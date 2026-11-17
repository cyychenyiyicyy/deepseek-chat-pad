import { streamMessage } from '../api/client.js'
import { streamOpenAI, type OpenAIMessage } from '../api/openai.js'
import {
  deepseekFetch,
  deepseekSearch,
  extractUrls,
  formatFetchContext,
  formatSearchContext,
} from '../api/tools.js'
import type { SearchResult } from '../api/tools.js'
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
      deepseek.models.find((m) => m.id === active.modelId) ??
      deepseek.models[0] ?? { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' }
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

/**
 * 部分厂商要求客户端携带稳定会话标识。
 * OpenCode（opencode.ai）用它做路由优化与 prompt 缓存，缺了会返回
 * 「Request is missing x-opencode-session and cannot be routed efficiently」。
 */
const providerHeaders = (url: string, sessionId?: string): Record<string, string> => {
  const headers: Record<string, string> = {}
  try {
    const host = new URL(url).host
    if (host.includes('opencode.ai')) {
      // 同一个会话始终用同一个 id，刷新页面后仍然稳定
      headers['x-opencode-session'] = sessionId ?? 'deepseek-tablet-default'
    }
  } catch {
    // URL 非法时不做任何附加
  }
  return headers
}

/** 本轮最后一条用户消息的纯文本 */
const lastUserText = (body: CreateMessageRequest): string => {
  for (let i = body.messages.length - 1; i >= 0; i -= 1) {
    const param = body.messages[i]
    if (param.role !== 'user') continue
    if (typeof param.content === 'string') return param.content
    return param.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n')
  }
  return ''
}

/** 把本应用的 Messages 结构降级成 OpenAI 兼容的纯文本消息 */
const toOpenAIMessages = (body: CreateMessageRequest, extraContext = ''): OpenAIMessage[] => {
  const messages: OpenAIMessage[] = [{ role: 'system', content: body.system }]
  const list = body.messages as MessageParam[]
  // 额外上下文拼到最后一条用户消息后面
  const lastUserIndex = (() => {
    for (let i = list.length - 1; i >= 0; i -= 1) if (list[i].role === 'user') return i
    return -1
  })()

  list.forEach((param, index) => {
    if (param.role === 'latest_reminder') return
    if (param.role === 'user') {
      let text: string
      if (typeof param.content === 'string') {
        text = param.content
      } else {
        text = param.content
          .map((block) => {
            if (block.type === 'text') return block.text
            // 自定义厂商下附件不参与请求（UI 已提示），给出可见占位，避免内容凭空消失
            return block.type === 'image' ? '［附件：图片］' : '［附件：文档］'
          })
          .join('\n')
      }
      if (index === lastUserIndex && extraContext) {
        text = `${text}\n\n${extraContext}`
      }
      messages.push({ role: 'user', content: text })
      return
    }
    const text = param.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('')
    if (text) messages.push({ role: 'assistant', content: text })
  })

  if (lastUserIndex === -1 && extraContext) {
    messages.push({ role: 'user', content: extraContext })
  }
  return messages
}

/** 用首条提问生成会话标题，替代 DeepSeek 服务端的 title 扩展 */
const deriveTitle = (body: CreateMessageRequest): string => {
  const clean = lastUserText(body).replace(/\s+/g, ' ').trim()
  return clean.slice(0, 24)
}

const randomHex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('')

/**
 * 自定义模型下的服务端工具替代方案。
 *
 * DeepSeek 的 deepseek_web_search / deepseek_read_url 只在它自己的服务端跑，
 * 换成别家模型时改由客户端调用 DeepSeek 的 /v1/tools/search 与 /v1/tools/fetch 取回资料，
 * 再把这批资料拼进用户消息。返回的第二个值是给模型看的上下文。
 */
const collectDeepseekTools = async (
  body: CreateMessageRequest,
  apiKey: string,
  signal: AbortSignal
): Promise<{
  context: string
  calls: { id: string; query: string; results: SearchResult[] }[]
  pages: { url: string; title: string; content: string }[]
}> => {
  const wantsSearch = body.tools.some((tool) => tool.type === 'deepseek_web_search')
  const wantsRead = body.tools.some((tool) => tool.type === 'deepseek_read_url')
  const question = lastUserText(body).trim()
  const calls: { id: string; query: string; results: SearchResult[] }[] = []
  const pages: { url: string; title: string; content: string }[] = []
  const contexts: string[] = []

  if (!apiKey) return { context: '', calls, pages }

  if (wantsSearch && question) {
    try {
      const results = await deepseekSearch(apiKey, question.slice(0, 128), { count: 8, signal })
      if (results.length > 0) {
        const id = `srvtoolu_s_00_${randomHex(16)}`
        calls.push({ id, query: question.slice(0, 128), results })
        contexts.push(formatSearchContext(question.slice(0, 128), results))
      }
    } catch {
      // 搜索失败不阻断对话，模型照常回答
    }
  }

  if (wantsRead && question) {
    const urls = extractUrls(question, 3)
    for (const url of urls) {
      try {
        const page = await deepseekFetch(apiKey, url, signal)
        pages.push({ url, title: page.title, content: page.content })
      } catch {
        // 单个链接失败忽略
      }
    }
    if (pages.length > 0) contexts.push(formatFetchContext(pages))
  }

  return { context: contexts.join('\n\n'), calls, pages }
}

/** 搜索结果转成界面认识的服务端工具块内容 */
const toWebSearchContent = (results: SearchResult[]) =>
  results.map((item) => ({
    type: 'web_search_result' as const,
    title: item.title,
    url: item.url,
    snippet: item.snippet,
    site_name: item.site_name,
    site_icon: item.site_icon,
    encrypted_content: '',
    page_age: item.date,
  }))

/** 把搜索过程画成与 DeepSeek 一致的工具块，让界面照常显示来源卡片 */
function* searchBlocks(
  calls: { id: string; query: string; results: SearchResult[] }[]
): Generator<MessageStreamEvent> {
  let index = 0
  for (const call of calls) {
    yield {
      type: 'content_block_start',
      index,
      content_block: {
        type: 'server_tool_use',
        id: call.id,
        name: 'deepseek_web_search',
        input: { action: 'search', queries: [call.query] },
        caller: { type: 'direct' },
        kind: 'search',
      },
    }
    yield { type: 'content_block_stop', index }
    index += 1
    yield {
      type: 'content_block_start',
      index,
      content_block: {
        type: 'web_search_tool_result',
        tool_use_id: call.id,
        content: toWebSearchContent(call.results),
        kind: 'search',
      },
    }
    yield { type: 'content_block_stop', index }
    index += 1
  }
}

/**
 * 发送对话请求，按当前选择的厂商走不同协议，对外统一产出 Messages 事件流。
 * 自定义模型下，联网搜索与读链接改由 DeepSeek 的底层工具接口代劳。
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

  const settings = useSettings.getState()
  const thinking = body.thinking.type === 'enabled' && Boolean(resolved.meta?.reason)

  // DeepSeek 的两个工具接口与对话模型无关，先用它们把资料取齐
  const { context, calls } = await collectDeepseekTools(body, settings.apiKey ?? '', signal)
  if (calls.length > 0) {
    yield* searchBlocks(calls)
  }

  const messages = toOpenAIMessages(body, context)

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

  yield* streamOpenAI({
    apiKey: resolved.apiKey,
    url: resolved.url,
    extraHeaders: providerHeaders(resolved.url, body.clientSessionId),
    model: resolved.model.id,
    messages,
    thinking,
    noTemperature: Boolean(resolved.meta?.noTemp),
    signal,
  })
}
