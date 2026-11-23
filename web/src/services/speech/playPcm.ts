import { synthesize, TTS_SAMPLE_RATE, type TtsVoice } from '../api/speech.js'

export async function playSpeech(context: AudioContext, options: {
  apiKey: string
  text: string
  voice: TtsVoice
  signal: AbortSignal
  onPlaying?: () => void
}) {
  const { apiKey, text, voice, signal } = options
  const reader = (await synthesize(apiKey, text, voice, signal)).getReader()
  const cancel = () => { void reader.cancel().catch(() => undefined) }
  signal.addEventListener('abort', cancel, { once: true })
  const gain = context.createGain()
  gain.connect(context.destination)
  let nextStart = 0
  let pendingByte: number | undefined
  let lastEnded = Promise.resolve()
  try {
    signal.throwIfAborted()
    for (;;) {
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      const prefix = pendingByte === undefined ? 0 : 1
      const bytes = new Uint8Array(value.length + prefix)
      if (pendingByte !== undefined) bytes[0] = pendingByte
      bytes.set(value, prefix)
      const count = Math.floor(bytes.length / 2)
      pendingByte = bytes[count * 2]
      if (count === 0) continue
      const buffer = context.createBuffer(1, count, TTS_SAMPLE_RATE)
      const samples = buffer.getChannelData(0)
      const data = new DataView(bytes.buffer)
      for (let i = 0; i < count; i += 1) samples[i] = data.getInt16(i * 2, true) / 32768
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(gain)
      lastEnded = new Promise((resolve) => { source.onended = () => resolve() })
      const start = Math.max(nextStart, context.currentTime + (nextStart === 0 ? 0.08 : 0))
      source.start(start)
      if (nextStart === 0) options.onPlaying?.()
      nextStart = start + buffer.duration
    }
    let release: (() => void) | undefined
    try {
      await Promise.race([lastEnded, new Promise<void>((resolve) => {
        release = resolve
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', release, { once: true })
      })])
      signal.throwIfAborted()
    } finally {
      if (release) signal.removeEventListener('abort', release)
    }
  } finally {
    gain.disconnect()
    signal.removeEventListener('abort', cancel)
    cancel()
  }
}
