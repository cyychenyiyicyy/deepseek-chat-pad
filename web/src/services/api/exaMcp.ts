/**
 * Exa 的免费 MCP 搜索（`https://mcp.exa.ai/mcp`）。
 *
 * 它不需要 API Key。MCP 的 Streamable HTTP 正常流程是
 * `initialize` 拿到 `Mcp-Session-Id`，再带这个头调 `tools/call`；
 * 但本地代理只会透传白名单里的响应头，拿不到 `Mcp-Session-Id`。
 * 实测该服务端**接受无会话的 stateless 调用**（不握手直接 tools/call 也能返回结果），
 * 所以这里省掉握手：一次 POST，少一个往返、也少一类失败。
 *
 * 响应是 `text/event-stream`，每行 `data: {json}`；正文是一个 text 块，里面用
 *   `Title: ... / URL: ... / Published: ... / Author: ... / Highlights: ...`
 * 的形式装了多条结果，需要拆开再结构化成 SearchResult。
 */
import { ApiError } from './error.js'
import { apiFetch } from './transport.js'
import type { SearchResult } from './tools.js'

const MCP_URL = 'https://mcp.exa.ai/mcp'
const TIMEOUT_MS = 20000

type RpcMessage = {
  id?: number
  result?: unknown
  error?: { code: number; message: string }
}

/** 从 SSE 文本里取出 JSON-RPC 消息；也兼容直接回 JSON 的情况 */
const parseMessages = (text: string): RpcMessage[] => {
  const messages: RpcMessage[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) {
      continue
    }
    try {
      messages.push(JSON.parse(trimmed.slice(5).trim()) as RpcMessage)
    } catch {
      // 半截数据，忽略
    }
  }
  if (messages.length === 0) {
    try {
      const whole = JSON.parse(text) as RpcMessage
      if (whole && typeof whole === 'object') {
        messages.push(whole)
      }
    } catch {
      // 非 JSON，交给上层报错
    }
  }
  return messages
}

type ExaItem = { title: string; url: string; text: string }

/** 把「Title/URL/Highlights」文本块拆成多条结果 */
const parseResults = (text: string): ExaItem[] => {
  const items: ExaItem[] = []
  for (const chunk of text.split(/\n(?=Title:\s)/)) {
    const title = /^Title:\s*(.+)$/m.exec(chunk)?.[1]?.trim() ?? ''
    const url = /^URL:\s*(\S+)$/m.exec(chunk)?.[1]?.trim() ?? ''
    if (!url) {
      continue
    }
    const highlights = /Highlights:\s*([\s\S]*)$/.exec(chunk)?.[1]?.trim() ?? ''
    items.push({ title: title || url, url, text: highlights || chunk.trim() })
  }
  return items
}

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return null
  }
}

export const exaMcpSearch = async (
  query: string,
  options: { maxResults?: number; signal?: AbortSignal } = {}
): Promise<SearchResult[]> => {
  const count = Math.min(10, Math.max(1, options.maxResults ?? 8))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort)
  let text: string
  try {
    const res = await apiFetch(MCP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'web_search_exa', arguments: { query, numResults: count } },
      }),
      signal: controller.signal,
    })
    text = await res.text()
    if (!res.ok) {
      throw new ApiError('http', `Exa：${text.slice(0, 200) || res.statusText}`, res.status)
    }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }

  const reply = parseMessages(text).find((message) => message.result || message.error)
  if (reply?.error) {
    throw new ApiError('http', `Exa：${reply.error.message}`, 502)
  }
  const content = (reply?.result as { content?: { type?: string; text?: string }[] } | undefined)?.content
  const body = (content ?? [])
    .filter((part) => part.type === 'text' && part.text)
    .map((part) => part.text as string)
    .join('\n\n')
  if (!body) {
    return []
  }

  return parseResults(body).map((item) => ({
    title: item.title,
    url: item.url,
    snippet: item.text.slice(0, 200),
    summary: item.text,
    content: item.text,
    site_name: hostOf(item.url),
    site_icon: null,
    date: null,
    authority: 0,
    rerank_score: 0,
  }))
}
