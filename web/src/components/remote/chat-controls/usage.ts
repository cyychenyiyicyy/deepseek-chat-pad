import type { ChatItem } from '../../../services/remote/adapter.js'
import type { RemoteUsage } from '../../../services/remote/sessionControls.js'

/**
 * 会话用量汇总。
 *
 * 两个来源（优先级从高到低）：
 *  1. `session/control` 投影里的 `usage`（Host 权威，但并非所有 Host 都推）；
 *  2. **时间线里每轮 `assistant/message.usage` 累加** —— 与上游 `screens/chat-process.ts:79-100`
 *     的 `aggregateTurnUsage` 同一套语义：`inputTokens` 是「本轮新读的输入」，所以直接相加即可；
 *     `cacheRead/cacheWrite` 有才加，缺的轮次按 0 处理（不拿它反推 input）。
 *
 * `usageOnly` 的静默账本行（只有 usage、没有正文的 assistant 行）也算进来 —— `adapter.ts:477-483`
 * 就是为了多步轮的 token 汇总不丢才保留它们的，汇总时当然要读。
 */
export const aggregateUsage = (items: readonly ChatItem[]): RemoteUsage | null => {
  let input = 0
  let output = 0
  let total = 0
  let cacheRead = 0
  let cacheWrite = 0
  let seen = false
  let hasTotal = false
  let hasCacheRead = false
  let hasCacheWrite = false
  for (const item of items) {
    if (item.kind !== 'message') continue
    const usage = item.usage
    if (usage === undefined) continue
    seen = true
    input += usage.inputTokens
    output += usage.outputTokens
    if (usage.totalTokens !== undefined) {
      total += usage.totalTokens
      hasTotal = true
    }
    if (usage.cacheReadTokens !== undefined) {
      cacheRead += usage.cacheReadTokens
      hasCacheRead = true
    }
    if (usage.cacheWriteTokens !== undefined) {
      cacheWrite += usage.cacheWriteTokens
      hasCacheWrite = true
    }
  }
  if (!seen) return null
  return {
    inputTokens: input,
    outputTokens: output,
    ...(hasTotal ? { totalTokens: total } : {}),
    ...(hasCacheRead ? { cacheReadTokens: cacheRead } : {}),
    ...(hasCacheWrite ? { cacheWriteTokens: cacheWrite } : {}),
  }
}

/** token 数的紧凑写法（1234 → `1.2k`，1234567 → `1.2M`）；小数字原样，便于对数。 */
export const formatTokens = (value: number): string => {
  if (!Number.isFinite(value) || value < 0) return '0'
  if (value < 1000) return String(Math.round(value))
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}
