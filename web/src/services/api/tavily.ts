/**
 * Tavily 搜索。
 *
 * 除了 DeepSeek 自带的 /v1/tools/search，再给一个可选的搜索后端：
 * 用户填自己的 Tavily API Key，走 `POST https://api.tavily.com/search`。
 * 返回结构统一成内部的 SearchResult，上层（工具调用 / 来源卡片）完全不用改。
 */
import { ApiError } from './error.js'
import { apiFetch } from './transport.js'
import type { SearchResult } from './tools.js'

const TAVILY_ENDPOINT = 'https://api.tavily.com/search'

type TavilyItem = {
  title?: string
  url?: string
  content?: string
  score?: number
  published_date?: string
}

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return null
  }
}

/** 连不上时重试一次：代理规则偶发抽风很常见，重试往往就过了 */
const requestSearch = async (
  apiKey: string,
  query: string,
  options: { maxResults?: number; signal?: AbortSignal }
): Promise<SearchResult[]> => {
  const res = await apiFetch(TAVILY_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      // 新版接口认 Bearer，旧版认 body 里的 api_key，两种都带上
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      // basic 够用且便宜；需要更深的抓取再换 advanced
      search_depth: 'basic',
      max_results: Math.min(10, Math.max(1, options.maxResults ?? 8)),
      include_answer: false,
      include_raw_content: false,
    }),
    signal: options.signal,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    let message = text || res.statusText
    try {
      const body = JSON.parse(text) as { detail?: { error?: string } | string; error?: string }
      const detail = body.detail
      if (typeof detail === 'string') message = detail
      else if (detail && typeof detail === 'object' && detail.error) message = detail.error
      else if (body.error) message = body.error
    } catch {
      /* 非 JSON 错误体直接展示原文 */
    }
    throw new ApiError('http', `Tavily：${message}`, res.status)
  }

  const body = (await res.json()) as { results?: TavilyItem[] }
  return (body.results ?? [])
    .filter((item): item is TavilyItem & { url: string } => Boolean(item.url))
    .map((item) => {
      const content = item.content ?? ''
      return {
        title: item.title ?? item.url,
        url: item.url,
        // 摘要给模型读，snippet 给界面显示
        snippet: content.slice(0, 200),
        summary: content,
        content,
        site_name: hostOf(item.url),
        site_icon: null,
        date: item.published_date ?? null,
        authority: 0,
        rerank_score: item.score ?? 0,
      }
    })
}

/**
 * 对外入口：网络层失败（本地代理返回的 upstream_failed / 连接被拒）重试一次。
 * 仍然失败时给出能直接照做的提示，而不是一句 upstream_failed。
 */
export const tavilySearch = async (
  apiKey: string,
  query: string,
  options: { maxResults?: number; signal?: AbortSignal } = {}
): Promise<SearchResult[]> => {
  try {
    return await requestSearch(apiKey, query, options)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const networkLike = /upstream_failed|连接|network|timeout|failed to connect|Unable to resolve/i.test(message)
    if (!networkLike || options.signal?.aborted) {
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
    try {
      return await requestSearch(apiKey, query, options)
    } catch (retryError) {
      const detail = retryError instanceof Error ? retryError.message : String(retryError)
      throw new Error(`连不上 api.tavily.com（${detail}）。如果开了代理，确认代理规则允许该域名；也可以先关掉代理再试。`)
    }
  }
}
