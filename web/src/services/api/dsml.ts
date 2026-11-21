/**
 * DeepSeek 的 DSML 工具标记。
 *
 * 部分网关上的 DeepSeek 模型不返回标准的 tool_calls，而是把调用写成正文：
 *   <|DSML| calls><|DSML| invoke name="deepseek_web_search">
 *     <|DSML| parameter name="query" string="true">关键词</|DSML| parameter>
 *   </|DSML| invoke></|DSML| calls>
 * 前端的 OpenAI 解析器不认识，于是整段标记被当成回答显示给用户。
 * 这里负责把它解析成标准调用，以及在渲染时把它剔除。
 */
import type { OpenAIToolCall } from './openai.js'

const INVOKE = /<|DSML|\s*invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/\|DSML\|\s*invoke>/g
const PARAM = /<\|DSML\|\s*parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/\|DSML\|\s*parameter>/g

/** 从正文里解析出工具调用；没有标记时返回空数组 */
export const parseDsmlCalls = (text: string): OpenAIToolCall[] => {
  if (!text.includes('<|DSML|')) {
    return []
  }
  const calls: OpenAIToolCall[] = []
  for (const match of text.matchAll(INVOKE)) {
    const args: Record<string, string> = {}
    for (const param of match[2].matchAll(PARAM)) {
      args[param[1]] = param[2].trim()
    }
    calls.push({
      id: 'call_' + Math.random().toString(16).slice(2, 10),
      name: match[1],
      arguments: JSON.stringify(args),
    })
  }
  return calls
}

/** 渲染/保存时把标记剔掉：从第一个标记开始到结尾都没有可见内容 */
export const stripDsml = (text: string): string => {
  if (!text.includes('<|DSML|')) {
    return text
  }
  const index = text.indexOf('<|DSML|')
  return text.slice(0, index).trimEnd()
}
