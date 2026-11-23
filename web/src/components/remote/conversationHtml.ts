import { shareImageUrl } from '../../services/remote/conversationShare.js'
import type { ReplayMessage } from './ConversationReplay.js'

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

export function renderConversationHtml(title: string, thinkingLabel: string, messages: readonly ReplayMessage[]): Blob {
  const parts = [`<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; font: 1rem/1.6 system-ui; }
  body { max-inline-size: 52rem; margin: 2.5rem auto; padding-inline: 1.25rem; color: CanvasText; background: Canvas; }
  h1 { line-height: 1.2; overflow-wrap: anywhere; }
  article { margin-block: 1rem; padding: 1rem 1.25rem; border: 1px solid GrayText; border-radius: .75rem; }
  article h2 { margin: 0 0 .5rem; font-size: 1rem; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; margin-block: .65rem; font: inherit; }
  summary { cursor: pointer; }
  img { display: block; object-fit: contain; max-inline-size: 100%; max-block-size: 28rem; margin-block: .75rem; }
</style>
<main><h1>${escapeHtml(title)}</h1>`]
  for (const message of messages) {
    parts.push(`<article><h2>${escapeHtml(message.label)}</h2>`)
    for (const tool of message.tools ?? []) {
      const label = [tool.name, tool.summary].filter(Boolean).join(' · ')
      parts.push(`<details><summary>${escapeHtml(label)}</summary><pre>${escapeHtml(tool.result)}</pre></details>`)
    }
    if (message.thinking) {
      parts.push(`<details><summary>${escapeHtml(thinkingLabel)}</summary><pre>${escapeHtml(message.thinking)}</pre></details>`)
    }
    for (const image of message.images ?? []) {
      if (shareImageUrl(image.src)) parts.push(`<img alt="${escapeHtml(image.name ?? '')}" src="${image.src}" loading="lazy">`)
    }
    if (message.text) parts.push(`<pre>${escapeHtml(message.text)}</pre>`)
    parts.push('</article>')
  }
  parts.push('</main>')
  return new Blob(parts, { type: 'text/html;charset=utf-8' })
}
