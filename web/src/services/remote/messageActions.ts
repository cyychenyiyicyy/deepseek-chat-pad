import { stripDsml } from '../api/dsml.js'
import type { ChatItem, ChatMessage, HistoryEntry } from './adapter.js'

export function isVisibleRemoteMessage(item: ChatItem): item is ChatMessage {
  return item.kind === 'message' && item.role !== 'system' && !item.context && !item.usageOnly
    && (stripDsml(item.text).trim() !== '' || Boolean(item.images?.length) || item.hasFiles === true)
}

export function messageActionPoints(items: readonly ChatItem[]) {
  const branch = new Map<string, number>()
  const prompts = new Map<string, ChatMessage>()
  const replies = new Map<number, ChatMessage>()
  let last: ChatMessage | undefined
  let lastPrompt: ChatMessage | undefined
  for (const item of items) {
    if (!isVisibleRemoteMessage(item)) continue
    last = item
    const seq = item.nativeSeq
    if (seq === undefined || !Number.isSafeInteger(seq) || seq < 0) continue
    if (item.role === 'user') {
      lastPrompt = item
      continue
    }
    const end = item.turnEnd?.seq
    if (item.streaming || end === undefined || end <= seq || item.turnEnd?.reason !== 'completed') continue
    replies.set(end, item)
    if (lastPrompt !== undefined) prompts.set(item.id, lastPrompt)
  }
  for (const [end, reply] of replies) branch.set(reply.id, end)
  const prompt = last === undefined ? undefined : prompts.get(last.id)
  const regenerate = last !== undefined && branch.has(last.id) && last.turnEnd?.reason === 'completed' &&
    prompt !== undefined && !prompt.hasFiles ? { replyId: last.id, prompt } : undefined
  return { branch, regenerate }
}

const promptDeliveryEvents = new Set(['agent/inbox/spliced', 'turn/start', 'step/start', 'system/message'])

export function forkPointBeforePrompt(entries: readonly HistoryEntry[], promptSeq: number): number | undefined {
  const events = new Map(entries.map(({ event }) => [event.seq, event]))
  // A gap can hide a different fork point. Use the contiguous events directly preceding the prompt.
  for (let seq = promptSeq - 1; seq >= 0; seq -= 1) {
    const event = events.get(seq)
    if (!event) return undefined
    if (!promptDeliveryEvents.has(event.type)) return seq
  }
  return undefined
}
