import { ApiError } from './error.js'
import { apiFetch, prepareRequest } from './transport.js'
import { readServerSentEvents, type ServerSentEvent } from './sse.js'
import { readServerSentEventsXhr, supportsStreamResponse } from './sse-xhr.js'
import type { MessageStreamEvent, StopReason } from './types.js'

/** 发给 OpenAI 兼容端点的消息；内容可以是纯文本或文本 + 图片 */
export type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export type OpenAITool = {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export type OpenAIToolCall = { id: string; name: string; arguments: string }

export type OpenAIMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | OpenAIContentPart[] }
  | {
      role: 'assistant'
      content: string | null
      tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
    }
  | { role: 'tool'; tool_call_id: string; content: string }

export type OpenAIStreamOptions = {
  apiKey: string
  url: string
  model: string
  messages: OpenAIMessage[]
  /** 开启思考；仅对支持该参数的端点发送 */
  thinking?: boolean
  /** 不接受该参数的模型（models.dev 的 temperature: false） */
  noTemperature?: boolean
  /** 厂商要求的额外请求头，例如 OpenCode 的 x-opencode-session */
  extraHeaders?: Record<string, string>
  /** 声明给模型的工具；模型自行决定是否调用 */
  tools?: OpenAITool[]
  /** 收集本轮模型发起的工具调用（不产出给界面） */
  toolCallsOut?: OpenAIToolCall[]
  /** 思考强度：OpenAI 兼容字段 reasoning_effort */
  reasoningEffort?: string
  signal: AbortSignal
}

const STOP_REASON: Record<string, StopReason> = {
  stop: 'end_turn',
  length: 'max_tokens',
  content_filter: 'refusal',
  tool_calls: 'tool_use',
}

const randomHex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('')

type Chunk = {
  id?: string
  model?: string
  choices?: {
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: {
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }[]
    }
    finish_reason?: string | null
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_cache_hit_tokens?: number
    prompt_cache_miss_tokens?: number
  }
  error?: { message?: string }
}

/**
 * 把 OpenAI 兼容端点的 SSE 流翻译成应用内部的 Messages 事件序列。
 *
 * UI 与持久化只认识 thinking / text / server_tool_use 这几类块，翻译成同一套事件后，
 * 渲染、续写、导出、历史回放都不用改。
 */
export async function* streamOpenAI(options: OpenAIStreamOptions): AsyncGenerator<MessageStreamEvent> {
  const {
    apiKey,
    url,
    model,
    messages,
    thinking,
    noTemperature,
    extraHeaders,
    tools,
    toolCallsOut,
    reasoningEffort,
    signal,
  } = options
  const payload: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  }
  // 思考开关是 DeepSeek 的扩展字段；其他厂商收到未知字段可能直接 400，因此只在开启时附带
  if (thinking) payload.thinking = { type: 'enabled' }
  if (reasoningEffort) payload.reasoning_effort = reasoningEffort
  if (noTemperature) delete payload.temperature
  if (tools && tools.length > 0) {
    payload.tools = tools
    // 交给模型自己决定是否调用，不强制
    payload.tool_choice = 'auto'
  }

  const init: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      Accept: 'text/event-stream',
      ...(extraHeaders ?? {}),
    },
    body: JSON.stringify(payload),
    signal,
  }

  // 老 WebView 没有 fetch 流式响应，改走 XHR 增量通道
  if (!supportsStreamResponse()) {
    yield* translate(readServerSentEventsXhr(await prepareRequest(url, init), signal), model, toolCallsOut)
    return
  }

  const response = await apiFetch(url, init)
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let message = text || response.statusText
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } }
      if (parsed.error?.message) message = parsed.error.message
    } catch {
      /* 非 JSON 错误体直接展示原文 */
    }
    throw new ApiError('http', message, response.status)
  }
  if (!response.body) {
    throw new ApiError('protocol', '当前 WebView 不支持流式响应，请更新系统 WebView')
  }
  yield* translate(readServerSentEvents(response.body, signal), model, toolCallsOut)
}

/** 把 OpenAI 的分片翻译成内部事件；两条传输通道共用这一段 */
async function* translate(
  events: AsyncIterable<ServerSentEvent>,
  model: string,
  toolCallsOut?: OpenAIToolCall[]
): AsyncGenerator<MessageStreamEvent> {
  /** 模型可能边想边发多个工具调用，按 index 累积 */
  const pendingTools = new Map<number, OpenAIToolCall>()
  const messageId = randomHex(16)
  let started = false
  let blockIndex = 0
  /** 当前打开的块：null 表示没有，text / thinking 表示类型 */
  let open: 'text' | 'thinking' | null = null
  let finishReason: string | null = null
  let usage:
    | {
        input_tokens: number
        cache_read_input_tokens: number
        cache_creation_input_tokens: number
        output_tokens: number
      }
    | undefined

  const head = (): MessageStreamEvent => ({
    type: 'message_start',
    message: { id: messageId, model, usage: undefined },
  })

  const closeOpen = function* (): Generator<MessageStreamEvent> {
    if (open) {
      yield { type: 'content_block_stop', index: blockIndex }
      blockIndex += 1
      open = null
    }
  }

  const openBlock = function* (kind: 'text' | 'thinking'): Generator<MessageStreamEvent> {
    open = kind
    yield {
      type: 'content_block_start',
      index: blockIndex,
      content_block:
        kind === 'text'
          ? { type: 'text', text: '' }
          : { type: 'thinking', thinking: '', signature: '' },
    }
  }

  for await (const { data } of events) {
    if (data === '[DONE]') break
    let chunk: Chunk
    try {
      chunk = JSON.parse(data) as Chunk
    } catch {
      continue
    }
    if (chunk.error?.message) {
      throw new ApiError('stream', chunk.error.message)
    }
    if (!started) {
      started = true
      yield head()
    }
    if (chunk.usage) {
      usage = {
        input_tokens: chunk.usage.prompt_cache_miss_tokens ?? chunk.usage.prompt_tokens ?? 0,
        cache_read_input_tokens: chunk.usage.prompt_cache_hit_tokens ?? 0,
        cache_creation_input_tokens: 0,
        output_tokens: chunk.usage.completion_tokens ?? 0,
      }
    }

    const choice = chunk.choices?.[0]
    if (!choice) continue
    const delta = choice.delta ?? {}

    if (delta.tool_calls) {
      for (const part of delta.tool_calls) {
        const index = part.index ?? 0
        const current = pendingTools.get(index) ?? { id: '', name: '', arguments: '' }
        if (part.id) current.id = part.id
        if (part.function?.name && !current.name) current.name = part.function.name
        if (part.function?.arguments) current.arguments += part.function.arguments
        pendingTools.set(index, current)
      }
    }

    // 思考增量与正文增量分别落在不同的块里，切换时先收尾上一块
    if (delta.reasoning_content) {
      if (open !== 'thinking') {
        yield* closeOpen()
        yield* openBlock('thinking')
      }
      yield {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
      }
    }
    if (delta.content) {
      if (open !== 'text') {
        yield* closeOpen()
        yield* openBlock('text')
      }
      yield {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'text_delta', text: delta.content },
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason
  }

  if (toolCallsOut && pendingTools.size > 0) {
    for (const call of [...pendingTools.values()]) {
      // 部分端点不回 id，补一个本地的，供后续 tool 消息引用
      if (!call.id) call.id = `call_${randomHex(6)}`
      toolCallsOut.push(call)
    }
  }

  if (!started) {
    // 空响应：给前端一个空回复，避免一直转圈
    yield head()
  }
  yield* closeOpen()
  yield {
    type: 'message_delta',
    delta: { stop_reason: STOP_REASON[finishReason ?? ''] ?? 'end_turn', stop_sequence: null },
    ...(usage ? { usage } : {}),
  }
  yield { type: 'message_stop' }
}

/** 拉取 OpenAI 兼容端点的模型列表 */
export const listOpenAIModels = async (
  url: string,
  apiKey: string,
  signal?: AbortSignal
): Promise<string[]> => {
  const res = await apiFetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal,
  })
  if (!res.ok) {
    throw new ApiError('http', (await res.text().catch(() => '')) || res.statusText, res.status)
  }
  const body = (await res.json()) as { data?: { id?: string }[] }
  const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id))
  return ids.sort((a, b) => a.localeCompare(b))
}
