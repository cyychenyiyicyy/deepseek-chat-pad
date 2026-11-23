import { deflate, Inflate, strToU8, strFromU8 } from 'fflate'
import { fromBase64Url, toBase64Url } from './identity.js'

// DSH Go v1.3.0 conversation envelope and conversation schema.
export const DSH_CONVERSATION_MIME = 'application/vnd.dshgo+json'
export const MAX_CONVERSATION_FILE = 4 * 1024 * 1024
const MAX_BODY = 16 * 1024 * 1024
const MAX_ENTRIES = 20_000
const MAX_TEXT = 400_000

export interface ConversationShareMessage {
  role: 'user' | 'assistant'
  text: string
  time: number
  thinking?: string
  tools?: { name: string; summary: string; result: string; status: 'ok' | 'failed'; time: number }[]
  images?: { name?: string; src: string }[]
}

const rasterDataUrl = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z\d+/]+={0,2})$/u

export function shareImageUrl(src: string): boolean {
  return src.length <= MAX_CONVERSATION_FILE && rasterDataUrl.test(src)
}

export function redactConversationShare(text: string): string {
  const hidden = '••••••'
  return text
    .replace(/-----BEGIN [A-Z0-9 ]{0,50}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,50}PRIVATE KEY-----|$)/gu, hidden)
    .replace(/(\b(?:proxy-)?authorization["']?\s*[:=]\s*["']?(?:bearer|basic)\s+)[\w.~+/=-]+/giu, '$1' + hidden)
    .replace(/((?<![\w-])(?:[\w-]+[-_])?(?:api[-_]?key|secret|token|password|passwd|access[-_]?key|private[-_]?key)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;)}"']+)/giu, '$1' + hidden)
    .replace(/\b(?:sk[-_][\w-]{16,}|gh[porsu]_[a-z0-9]{36,}|github_pat_[\w-]{22,}|glpat-[\w-]{20,}|AIza[\w-]{35}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[\w-]{10,}|(?:npm|hf|whsec)_[a-z0-9]{24,}|eyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,})\b/giu, hidden)
    .replace(/(:\/\/[^\s/:@?#]+:)[^\s/@?#]+(?=@)/gu, '$1' + hidden)
    .replace(/\/data\/(?:user\/\d+|data)\/[\w.]+/gu, '…')
    .replace(/(?<![\w.~/-])\/(?:home|Users)\/[\w.-]+|\b[A-Za-z]:\\Users\\[^\\/\s"<>|:*?]+/giu, '~')
    .replace(/!\[([^\]\n]*)\]\((?:[^()\s]|\([^()\s]*\))+(?:\s+"[^"\n]*")?\)/gu, '$1')
    .replace(/<img\b[^>]*>/giu, '')
}

export function conversationShareTitle(title: string): string {
  return Array.from(redactConversationShare(title).replace(/\s+/gu, ' ').trim()).slice(0, 120).join('')
}

async function checksum(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes), 0, 6))
}

export async function encodeConversationShare(
  title: string, messages: readonly ConversationShareMessage[], sizeError: string,
): Promise<Uint8Array<ArrayBuffer>> {
  if (messages.length > MAX_ENTRIES || messages.some((item) => item.text.length > MAX_TEXT)) throw new Error(sizeError)
  const now = Date.now()
  const start = messages[0]?.time || now
  let time = 0
  const assets: Record<string, { type: string; data: string }> = {}
  const imageIds = new Map<string, string>()
  const entries: unknown[] = []
  let assetSize = 0
  const position = (at: number) => time = Math.max(time, Number.isFinite(at) ? Math.round(at - start) : 0)
  for (const message of messages) {
    for (const tool of message.tools ?? []) {
      entries.push({ type: 'tool', t: position(tool.time), name: tool.name, summary: tool.summary, result: tool.result, status: tool.status })
    }
    const images = []
    for (const image of message.images?.slice(0, 20) ?? []) {
      const parts = shareImageUrl(image.src) ? rasterDataUrl.exec(image.src) : null
      if (!parts) continue
      let id = imageIds.get(image.src)
      if (!id) {
        const raw = Uint8Array.from(atob(parts[2]!), char => char.charCodeAt(0))
        id = toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', raw), 0, 9))
        imageIds.set(image.src, id)
        if (!assets[id]) {
          assets[id] = { type: parts[1]!, data: parts[2]! }
          assetSize += parts[2]!.length
          if (assetSize >= MAX_CONVERSATION_FILE) throw new Error(sizeError)
        }
      }
      images.push({ id, name: image.name })
    }
    entries.push(message.role === 'user'
      ? { type: 'user', t: position(message.time), text: message.text, images }
      : { type: 'reply', t: position(message.time), text: message.text, think: message.thinking })
  }
  if (entries.length > MAX_ENTRIES) throw new Error(sizeError)
  const body = strToU8(JSON.stringify({
    v: 2, kind: 'conversation', schema: 1, title, app: 'DeepSeek Chat Pad', start: new Date(start).toISOString(),
    created: new Date(now).toISOString(), include: {
      thinking: messages.some(message => Boolean(message.thinking)), tools: messages.some(message => Boolean(message.tools?.length)),
    }, entries,
  }))
  if (body.length > MAX_BODY) throw new Error(sizeError)
  const [packed, sum] = await Promise.all([
    new Promise<Uint8Array>((resolve, reject) => deflate(body, { level: 6 }, (error, bytes) => {
      if (error) reject(error)
      else resolve(bytes)
    })),
    checksum(new Uint8Array(body)),
  ])
  if (packed.length > MAX_CONVERSATION_FILE * 3 / 4) throw new Error(sizeError)
  const file = new TextEncoder().encode(JSON.stringify({
    dshgo: 2, kind: 'conversation', name: title, code: toBase64Url(packed) + '.' + sum,
    ...(assetSize > 0 ? { assets } : {}),
  }) + '\n')
  if (file.length > MAX_CONVERSATION_FILE) throw new Error(sizeError)
  return file
}

export async function decodeConversationShare(file: Uint8Array): Promise<{ title: string; messages: ConversationShareMessage[] }> {
  if (file.length > MAX_CONVERSATION_FILE) throw new Error('Conversation share exceeds the file limit')
  const envelope: unknown = JSON.parse(strFromU8(file))
  if (typeof envelope !== 'object' || envelope === null || !('code' in envelope) || typeof envelope.code !== 'string') {
    throw new Error('Invalid conversation file')
  }
  const [encoded, sum, rest] = envelope.code.split('.', 3)
  const packed = encoded && rest === undefined && sum?.length === 8 ? fromBase64Url(encoded) : null
  if (!packed?.length) throw new Error('Invalid conversation code')
  const chunks: Uint8Array[] = []
  let size = 0
  const inflate = new Inflate((chunk) => {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('Conversation share exceeds the body limit')
    chunks.push(chunk)
  })
  // Limit each inflate step before accepting size and accumulating output.
  for (let offset = 0; offset < packed.length; offset += 4096) {
    inflate.push(packed.subarray(offset, offset + 4096), offset + 4096 >= packed.length)
  }
  const bytes = new Uint8Array(size)
  let cursor = 0
  for (const chunk of chunks) {
    bytes.set(chunk, cursor)
    cursor += chunk.length
  }
  if (await checksum(bytes) !== sum) throw new Error('Conversation share checksum mismatch')
  const body: unknown = JSON.parse(strFromU8(bytes))
  if (typeof body !== 'object' || body === null || !('kind' in body) || body.kind !== 'conversation' ||
      !('v' in body) || (body.v !== 1 && body.v !== 2) || !('schema' in body) || body.schema !== 1 ||
      !('start' in body) || typeof body.start !== 'string' || !('entries' in body) ||
      !Array.isArray(body.entries) || body.entries.length > MAX_ENTRIES) throw new Error('Unsupported conversation format')
  const start = Date.parse(body.start)
  if (!Number.isFinite(start)) throw new Error('Invalid conversation start')
  const title = 'title' in body && typeof body.title === 'string' ? body.title.slice(0, 120) : ''
  const assets = 'assets' in envelope && envelope.assets && typeof envelope.assets === 'object'
    ? envelope.assets as Record<string, { type?: unknown; data?: unknown }> : {}
  const verifiedImages = new Map<string, string | null>()
  const messages: ConversationShareMessage[] = []
  let tools: NonNullable<ConversationShareMessage['tools']> = []
  for (const entry of body.entries) {
    if (!entry || typeof entry !== 'object') continue
    const elapsed = typeof entry.t === 'number' && Number.isSafeInteger(entry.t) && entry.t >= 0 ? entry.t : 0
    const time = start + elapsed
    if (entry.type === 'tool' && typeof entry.name === 'string') {
      tools.push({ name: entry.name.slice(0, 80), summary: String(entry.summary ?? '').slice(0, 400),
        result: String(entry.result ?? '').slice(0, 64_000), status: entry.status === 'ok' ? 'ok' : 'failed', time })
      continue
    }
    if ((entry.type !== 'user' && entry.type !== 'reply') || typeof entry.text !== 'string') continue
    const images: NonNullable<ConversationShareMessage['images']> = []
    for (const image of Array.isArray(entry.images) ? entry.images.slice(0, 20) : []) {
      if (!image || typeof image.id !== 'string' || !/^[\w-]{12}$/.test(image.id)) continue
      if (!verifiedImages.has(image.id)) {
        const asset = assets[image.id]
        const src = typeof asset?.type === 'string' && typeof asset.data === 'string' ? `data:${asset.type};base64,${asset.data}` : ''
        let valid = false
        if (shareImageUrl(src)) {
          try {
            const raw = Uint8Array.from(atob(asset!.data as string), char => char.charCodeAt(0))
            valid = toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', raw), 0, 9)) === image.id
          } catch {
            // The file may contain an invalid or damaged asset.
          }
        }
        verifiedImages.set(image.id, valid ? src : null)
      }
      const src = verifiedImages.get(image.id)
      if (src) images.push({ src, ...(typeof image.name === 'string' ? { name: image.name.slice(0, 200) } : {}) })
    }
    messages.push({ role: entry.type === 'user' ? 'user' : 'assistant', text: entry.text.slice(0, MAX_TEXT), time,
      ...(typeof entry.think === 'string' ? { thinking: entry.think.slice(0, MAX_TEXT) } : {}),
      ...(tools.length > 0 ? { tools } : {}), ...(images.length > 0 ? { images } : {}),
    })
    tools = []
  }
  if (tools.length > 0) messages.push({ role: 'assistant', text: '', time: tools[0]!.time, tools })
  return { title, messages }
}
