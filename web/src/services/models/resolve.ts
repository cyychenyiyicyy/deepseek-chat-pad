import { ApiError, streamMessage } from '../api/client.js'
import { streamOpenAI, type OpenAIMessage, type OpenAITool, type OpenAIToolCall } from '../api/openai.js'
import { deepseekFetch, deepseekSearch, extractUrls, formatFetchContext, formatSearchContext } from '../api/tools.js'
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
      headers['x-opencode-session'] = sessionId ?? 'deepseek-tablet-default'
    }
  } catch {
    // URL 非法时不做任何附加
  }
  return headers
}

/**
 * 联网搜索改成「模型自己决定要不要搜」。
 *
 * DeepSeek 官方接口是由服务端工具完成的；换成第三方模型时，这里把搜索声明成
 * 一个 function tool 交给模型判断：只有它认为需要最新信息时才调用，
 * 然后客户端再调 DeepSeek 的 /v1/tools/search 取结果、回灌给模型续答。
 * 这样开着开关问「什么是闭包」不会白搜一轮。
 */
const SEARCH_TOOL: OpenAITool = {
  type: 'function',
  function: {
    name: 'deepseek_web_search',
    description:
      '联网搜索。仅当问题需要实时或最新信息时调用，例如：新闻、当前价格、天气、最新版本/发布、今天发生的事、需要核实的事实。常识与稳定知识不要调用。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词，简洁明确，可含 site: 等运算符' },
      },
      required: ['query'],
    },
  },
}

const readQuery = (args: string): string => {
  try {
    const parsed = JSON.parse(args) as { query?: string }
    return (parsed.query ?? '').trim().slice(0, 128)
  } catch {
    return args.trim().slice(0, 128)
  }
}

/** 端点不认识 tools 参数时（400/422），退化成不搜索重发一次 */
const isUnsupportedTools = (error: unknown): boolean =>
  error instanceof ApiError && (error.status === 400 || error.status === 422 || error.status === 404)

const randomHex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('')

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
 * 用户消息里出现链接时，先用 DeepSeek 的 /v1/tools/fetch 把正文抓回来。
 * 只在含链接时触发，不会每次都请求。
 */
const collectLinkContext = async (
  body: CreateMessageRequest,
  apiKey: string,
  signal: AbortSignal
): Promise<string> => {
  if (!apiKey) return ''
  const question = lastUserText(body)
  const urls = extractUrls(question, 3)
  if (urls.length === 0) return ''

  const pages: { url: string; title: string; content: string }[] = []
  for (const url of urls) {
    try {
      const page = await deepseekFetch(apiKey, url, signal)
      pages.push({ url, title: page.title, content: page.content })
    } catch {
      // 单个链接失败忽略，模型照常回答
    }
  }
  return formatFetchContext(pages)
}

/**
 * 发送对话请求，按当前选择的厂商走不同协议，对外统一产出 Messages 事件流。
 * 自定义模型下：链接由客户端抓取，联网搜索交给模型通过工具自行决定。
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

  const linkContext = await collectLinkContext(body, settings.apiKey ?? '', signal)
  const messages = toOpenAIMessages(body, linkContext)

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

  const options = {
    apiKey: resolved.apiKey,
    url: resolved.url,
    model: resolved.model.id,
    thinking,
    noTemperature: Boolean(resolved.meta?.noTemp),
    extraHeaders: providerHeaders(resolved.url, body.clientSessionId),
    signal,
  }

  const wantsSearch = body.tools.some((tool) => tool.type === 'deepseek_web_search')
  const deepseekKey = settings.apiKey ?? ''
  // 目录里没收录的模型也试一次：不认识 tools 会退化成不搜索
  const canUseTools = Boolean(resolved.meta?.tool) || !resolved.meta

  if (!wantsSearch || !deepseekKey || !canUseTools) {
    yield* streamOpenAI({ ...options, messages })
    return
  }

  // 第一轮：带上搜索工具，由模型决定用不用
  const calls: OpenAIToolCall[] = []
  try {
    yield* streamOpenAI({ ...options, messages, tools: [SEARCH_TOOL], toolCallsOut: calls })
  } catch (error) {
    if (isUnsupportedTools(error) && calls.length === 0) {
      // 端点不支持工具调用：直接不搜索重发
      yield* streamOpenAI({ ...options, messages })
      return
    }
    throw error
  }

  const searchCall = calls.find((call) => call.name === 'deepseek_web_search')
  // 模型判断不需要搜索，第一轮已经给出完整回答
  if (!searchCall) return

  const query = readQuery(searchCall.arguments) || lastUserText(body).slice(0, 128)
  const results = await deepseekSearch(deepseekKey, query, { count: 8, signal })
  if (results.length === 0) return

  // 让界面照常显示「搜索了哪些来源」
  yield* searchBlocks([{ id: searchCall.id || `call_${randomHex(6)}`, query, results }])

  messages.push({
    role: 'assistant',
    content: null,
    tool_calls: calls.map((call) => ({
      id: call.id,
      type: 'function' as const,
      function: { name: call.name, arguments: call.arguments },
    })),
  })
  for (const call of calls) {
    messages.push({
      role: 'tool',
      tool_call_id: call.id,
      content:
        call === searchCall
          ? formatSearchContext(query, results)
          : '（该工具未在本轮执行）',
    })
  }

  // 第二轮：不再声明工具，避免无限调用
  yield* streamOpenAI({ ...options, messages })
}
