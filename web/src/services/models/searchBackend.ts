/**
 * 联网搜索后端的选择。
 *
 * 两种来源：
 *   - deepseek：DeepSeek 官方的 /v1/tools/search（默认，用 DeepSeek Key）
 *   - tavily：用户自己的 Tavily Key
 *
 * 与对话模型无关：无论选哪家模型，搜索都按这里的设置走。
 */
import { deepseekSearch, type SearchResult } from '../api/tools.js'
import { tavilySearch } from '../api/tavily.js'
import { exaMcpSearch } from '../api/exaMcp.js'
import { useSettings } from '../settings.js'

export type SearchBackend = 'exa' | 'deepseek' | 'tavily'

/** 当前选的搜索后端是否已经配置好 Key */
export const hasSearchCredential = (): boolean => {
  const { searchBackend, tavilyKey, apiKey } = useSettings.getState()
  // Exa 的免费 MCP 端点不需要 Key
  if (searchBackend === 'exa') {
    return true
  }
  return searchBackend === 'tavily' ? Boolean(tavilyKey) : Boolean(apiKey)
}

/** 按设置执行一次搜索；两条路都返回统一的 SearchResult */
export const runSearch = async (
  query: string,
  signal?: AbortSignal,
  count = 8
): Promise<SearchResult[]> => {
  const { searchBackend, tavilyKey, apiKey } = useSettings.getState()
  if (searchBackend === 'exa') {
    return exaMcpSearch(query, { maxResults: count, signal })
  }
  if (searchBackend === 'tavily') {
    return tavilyKey ? tavilySearch(tavilyKey, query, { maxResults: count, signal }) : []
  }
  return apiKey ? deepseekSearch(apiKey, query, { count, signal }) : []
}

/** 搜索来源的名字，用于界面提示 */
export const searchBackendLabel = (backend: SearchBackend): string =>
  backend === 'exa' ? 'Exa' : backend === 'tavily' ? 'Tavily' : 'DeepSeek'
