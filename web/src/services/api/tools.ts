/**
 * DeepSeek 的「应用类」接口，与大模型解耦：
 *   POST /v1/tools/search   联网搜索
 *   POST /v1/tools/fetch    抓取网页正文（Markdown）
 *
 * 这两项由 DeepSeek 服务端执行，因此无论对话用的是哪家模型，都能用这两条接口
 * 先把资料取回来，再作为上下文拼进请求。
 */
import { ApiError } from './error.js'
import { apiFetch } from './transport.js'

export const DEEPSEEK_ORIGIN = 'https://api.deepseek.com'

export type SearchResult = {
  title: string
  url: string
  snippet: string
  summary: string
  content: string
  site_name: string | null
  site_icon: string | null
  date: string | null
  authority: number
  rerank_score: number
}

export type FetchedPage = { title: string; content: string }

const readError = async (res: Response): Promise<ApiError> => {
  const text = await res.text().catch(() => '')
  let message = text || res.statusText
  try {
    const body = JSON.parse(text) as { error?: { message?: string } }
    if (body.error?.message) message = body.error.message
  } catch {
    /* 非 JSON 错误体保留原文 */
  }
  return new ApiError('http', message, res.status)
}

/** 联网搜索；count 上限 50，needContent 打开会带整页正文（更贵） */
export const deepseekSearch = async (
  apiKey: string,
  query: string,
  options: { count?: number; needContent?: boolean; signal?: AbortSignal } = {}
): Promise<SearchResult[]> => {
  const res = await apiFetch(`${DEEPSEEK_ORIGIN}/v1/tools/search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
    body: JSON.stringify({
      query: query.slice(0, 128),
      count: options.count ?? 8,
      need_content: options.needContent ?? false,
    }),
    signal: options.signal,
  })
  if (!res.ok) throw await readError(res)
  const body = (await res.json()) as { results?: SearchResult[] }
  return body.results ?? []
}

/** 抓取网页，返回标题与 Markdown 正文 */
export const deepseekFetch = async (
  apiKey: string,
  url: string,
  signal?: AbortSignal
): Promise<FetchedPage> => {
  const res = await apiFetch(`${DEEPSEEK_ORIGIN}/v1/tools/fetch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
    body: JSON.stringify({ url }),
    signal,
  })
  if (!res.ok) throw await readError(res)
  return (await res.json()) as FetchedPage
}

/** 从用户这句话里抽出最多 limit 个 http(s) 链接 */
export const extractUrls = (text: string, limit = 3): string[] => {
  const found = text.match(/https?:\/\/[^\s<>"'）)】\]]+/g) ?? []
  const unique = [...new Set(found.map((url) => url.replace(/[.,;。，；]+$/, '')))]
  return unique.slice(0, limit)
}

/** 搜索结果整理成给任意模型看的上下文 */
export const formatSearchContext = (query: string, results: SearchResult[]): string => {
  if (results.length === 0) {
    return `【联网搜索】查询「${query}」没有找到结果。`
  }
  const lines = results.map((item, index) => {
    const when = item.date ? `（${item.date.slice(0, 10)}）` : ''
    return `[${index + 1}] ${item.title}${when}\n${item.url}\n${item.summary || item.snippet}`
  })
  return [
    '【联网搜索】以下是最新搜索结果。回答时优先依据这些资料，并在用到某条时标注来源编号（如 [1]）：',
    ...lines,
  ].join('\n\n')
}

/** 抓取到的网页整理成上下文 */
export const formatFetchContext = (pages: { url: string; title: string; content: string }[]): string => {
  if (pages.length === 0) return ''
  return [
    '【网页内容】以下是用户消息里链接的正文（由 DeepSeek 抓取）：',
    ...pages.map((page) => `—— ${page.title || page.url} (${page.url}) ——\n${page.content}`),
  ].join('\n\n')
}
