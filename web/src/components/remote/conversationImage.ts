const WIDTH = 900
const PADDING = 44
const ROW_PADDING = 28
const LINE_HEIGHT = 30
const MAX_HEIGHT = 12_000

interface ImageMessage {
  label: string
  text: string
}

function wrapLines(context: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = []
  const fits = (value: string) => context.measureText(value).width <= width
  for (const paragraph of text.split(/\r?\n/u)) {
    let line = ''
    for (const token of paragraph.match(/\S+[^\S\r\n]*|[^\S\r\n]+/gu) ?? []) {
      if (fits(line + token)) {
        line += token
        continue
      }
      if (line) lines.push(line.trimEnd())
      line = ''
      if (fits(token)) {
        line = token.trimStart()
        continue
      }
      // Long links and writing without spaces still need to wrap inside the card.
      for (const character of token) {
        if (line && !fits(line + character)) {
          lines.push(line.trimEnd())
          line = ''
        }
        line += character
      }
    }
    lines.push(line.trimEnd())
  }
  return lines
}

export async function renderConversationImage(
  title: string, messages: readonly ImageMessage[], tooLarge: string, encodingFailed: string,
): Promise<Blob> {
  // Bound work even before measuring all the lines of the selected text.
  if (messages.reduce((total, message) => total + message.text.length, title.length) > 48_000) throw new Error(tooLarge)
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (context === null) throw new Error(encodingFailed)
  const theme = getComputedStyle(document.body)
  const color = (name: string, fallback: string) => theme.getPropertyValue('--dsw-alias-' + name).trim() || fallback
  const font = theme.getPropertyValue('--dsw-font-family').trim() || 'system-ui, sans-serif'
  const fontAt = (size: number, weight = 400) => `${weight} ${size}px ${font}`
  const cardWidth = WIDTH - PADDING * 2
  context.font = fontAt(32, 650)
  const titleLines = wrapLines(context, title, cardWidth)
  let height = PADDING * 2 + titleLines.length * 42
  context.font = fontAt(20)
  const cards: Array<{ label: string; lines: string[]; height: number }> = []
  for (const message of messages) {
    const lines = wrapLines(context, message.text, cardWidth - ROW_PADDING * 2)
    const cardHeight = ROW_PADDING * 2 + 28 + lines.length * LINE_HEIGHT
    height += cardHeight + 16
    if (height > MAX_HEIGHT) throw new Error(tooLarge)
    cards.push({ label: message.label, lines, height: cardHeight })
  }
  if (height > MAX_HEIGHT) throw new Error(tooLarge)
  canvas.width = WIDTH
  canvas.height = height
  context.fillStyle = color('bg-base', '#ffffff')
  context.fillRect(0, 0, WIDTH, height)
  context.textBaseline = 'top'
  context.font = fontAt(32, 650)
  const primary = color('label-primary', '#263148')
  const secondary = color('label-secondary', '#57647b')
  context.fillStyle = primary
  titleLines.forEach((line, index) => context.fillText(line, PADDING, PADDING + index * 42))
  let top = PADDING + titleLines.length * 42 + 16
  for (const card of cards) {
    context.fillStyle = color('interactive-bg-hover', '#f4f6fa')
    context.beginPath()
    context.roundRect(PADDING, top, cardWidth, card.height, 16)
    context.fill()
    const bodyLeft = PADDING + ROW_PADDING
    context.fillStyle = secondary
    context.font = fontAt(15, 650)
    context.fillText(card.label, bodyLeft, top + ROW_PADDING)
    context.fillStyle = primary
    context.font = fontAt(20)
    card.lines.forEach((line, index) => context.fillText(line, bodyLeft, top + ROW_PADDING + 28 + index * LINE_HEIGHT))
    top += card.height + 16
  }
  return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => {
    // Release the backing surface in WebViews with a small canvas budget.
    canvas.width = 0
    canvas.height = 0
    if (blob === null) reject(new Error(encodingFailed))
    else resolve(blob)
  }, 'image/png'))
}
