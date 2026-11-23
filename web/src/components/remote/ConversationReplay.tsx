import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import type { ConversationShareMessage } from '../../services/remote/conversationShare.js'
import { Button } from '../base/Button.js'
import { Markdown } from '../markdown/Markdown.js'
import styles from './RemoteManagementDialog.module.css'

export interface ReplayMessage extends Pick<ConversationShareMessage, 'thinking' | 'tools' | 'images'> {
  id: string
  label: string
  text: string
  time: number
}

const formatTime = (ms: number) => {
  const seconds = Math.floor(ms / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function ConversationReplay({ messages, onBack, backLabel }: { messages: readonly ReplayMessage[]; onBack: () => void; backLabel?: string }) {
  const t = useTranslate()
  const [position, setPosition] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const scroll = useRef<HTMLDivElement>(null)
  const frames = useMemo(() => {
    let start = 0
    return messages.map((message, index) => {
      const previous = messages[index - 1]
      // Preserve short pauses and compress long periods of inactivity.
      if (previous !== undefined) start += Math.min(4_000, Math.max(550, (message.time - previous.time) || 0))
      return { ...message, start }
    })
  }, [messages])
  const duration = (frames.at(-1)?.start ?? 0) + 950
  const visibleCount = frames.findLastIndex((message) => message.start <= position) + 1

  useEffect(() => {
    if (!playing) return undefined
    let lastTime = performance.now()
    const ticker = window.setInterval(() => {
      const now = performance.now()
      const delta = Math.min(250, now - lastTime) * speed
      lastTime = now
      setPosition((current) => Math.min(current + delta, duration))
    }, 70)
    return () => window.clearInterval(ticker)
  }, [playing, duration, speed])

  useEffect(() => { if (position >= duration) setPlaying(false) }, [position, duration])

  useEffect(() => {
    if (scroll.current !== null) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [visibleCount])

  return <div className={styles.layout}>
    <div className={styles.actions}>
      <Button variant="outlined" size="m" onClick={onBack}>{backLabel ?? t('remoteReplayBack')}</Button>
      <Button variant="primary" size="m" onClick={() => {
        if (position >= duration) setPosition(0)
        setPlaying((current) => !current)
      }}>{t(playing ? 'remoteReplayPause' : 'remoteReplayPlay')}</Button>
      <Button variant="outlined" size="m" aria-label={t('remoteReplaySpeed', { speed })}
        onClick={() => setSpeed((current) => current === 4 ? 1 : current * 2)}>{speed}×</Button>
    </div>
    <label className={styles.replayProgress}>
      <span>{t('remoteReplayPosition')}</span>
      <input type="range" min={0} max={duration} step={1} value={Math.round(position)}
        onChange={(event) => setPosition(event.currentTarget.valueAsNumber)} />
      <span>{formatTime(position)} / {formatTime(duration)}</span>
    </label>
    <div ref={scroll} className={styles.replayMessages}>
      {frames.slice(0, visibleCount).map((message) => <article className={styles.replayMessage} key={message.id}>
        <strong>{message.label}</strong>
        {message.tools?.map((tool, index) => <details key={index}>
          <summary>{tool.name}{tool.summary ? ` · ${tool.summary}` : ''}</summary>
          <pre className={styles.output}>{tool.result}</pre>
        </details>)}
        {message.thinking && <details><summary>{t('remoteExportThinking')}</summary><pre className={styles.output}>{message.thinking}</pre></details>}
        {message.images?.map((entry, index) => <img className={styles.replayImage} key={index} src={entry.src} alt={entry.name ?? ''} loading="lazy" />)}
        <Markdown content={message.text} loading={false} cacheKey={message.id} disableLink />
      </article>)}
    </div>
  </div>
}
