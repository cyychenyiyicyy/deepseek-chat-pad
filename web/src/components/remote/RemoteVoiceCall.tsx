import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { TTS_SAMPLE_RATE } from '../../services/api/speech.js'
import { stripDsml } from '../../services/api/dsml.js'
import { isQuestionTerminal, useChatControls } from '../../services/remote/sessionControls.js'
import { lastRemoteTarget } from '../../services/remote/sessionsApi.js'
import { useRemoteStore } from '../../services/remote/store.js'
import type { TerminalScope } from '../../services/remote/terminal.js'
import { useSettings } from '../../services/settings.js'
import { playSpeech } from '../../services/speech/playPcm.js'
import { describeReadAloudError, stopReadAloud } from '../../services/speech/readAloud.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { useVoiceInput } from '../chatInput/useVoiceInput.js'
import { VoiceButton } from '../chatInput/VoiceButton.js'
import styles from './RemoteManagementDialog.module.css'

type VoicePhase = 'idle' | 'waiting' | 'speaking'
const RESPONSE_TIMEOUT_MS = 90_000
const SENTENCE_BOUNDARY = /(?:[。！？!?]+|\.(?=\s|$)|\n+)/gu

export interface NewVoiceCall {
  target: TerminalScope['target']
  current(): boolean
  start(text: string, signal: AbortSignal, onDispatch: (turn: VoiceTurn) => void): Promise<boolean>
}

interface VoiceTurn {
  scope: TerminalScope
  before: Set<string>
  requestId: string | undefined
}

export default function RemoteVoiceCall({ scope: existingScope, draft, onClose }: {
  scope?: TerminalScope
  draft?: NewVoiceCall
  onClose: () => void
}) {
  const t = useTranslate()
  const [phase, setPhase] = useState<VoicePhase>('idle')
  const [transcript, setTranscript] = useState('')
  const [reply, setReply] = useState('')
  const [message, setMessage] = useState('')
  const [handsFree, setHandsFree] = useState(true)
  const [listenAgain, setListenAgain] = useState(false)
  const context = useRef<AudioContext | null>(null)
  const operation = useRef<AbortController | null>(null)
  const starting = useRef(false)
  const [createdScope, setCreatedScope] = useState<TerminalScope>()
  const scope = existingScope ?? createdScope
  const voice = useVoiceInput((text) => { void send(text) })
  const activeSessionId = useRemoteStore((state) => state.activeSessionId)
  const remotePhase = useRemoteStore((state) => state.phase)
  const streaming = useRemoteStore((state) => state.streaming)
  const waitingApproval = useRemoteStore((state) => state.pendingApprovals.length > 0)
  const synchronized = useRemoteStore((state) => state.cacheStatus.timelineSettled && !state.cacheStatus.timelineFailed)
  const questions = useChatControls((state) => state.questions)
  const openQuestions = Object.entries(questions).filter(([, question]) =>
    question.sessionId === scope?.sessionId && !isQuestionTerminal(question.phase))
  const question = openQuestions.length === 1 ? openQuestions[0] : undefined
  const questionItem = question?.[1].questions.length === 1 && question[1].phase === 'open' && !question[1].submitting
    ? question[1].questions[0] : undefined
  const canSpeak = scope === undefined ? draft?.current() === true : synchronized && !waitingApproval &&
    (questionItem !== undefined || (!streaming && openQuestions.length === 0))
  const current = () => {
    const owner = scope ?? draft
    return owner?.current() === true && lastRemoteTarget() === owner.target
  }

  useEffect(() => {
    if ((remotePhase !== 'ready' || !starting.current) && !current()) onClose()
  }, [activeSessionId, remotePhase, scope, draft, onClose])

  useEffect(() => () => {
    operation.current?.abort()
    void context.current?.close().catch(() => undefined)
    context.current = null
  }, [])

  useEffect(() => {
    if (voice.status !== 'recording' || !handsFree) return
    const audio = new Float32Array(512)
    let voiceFrames = 0
    let lastSpeech = 0
    const timer = window.setInterval(() => {
      const analyser = voice.getAnalyser()
      if (!analyser) return
      analyser.getFloatTimeDomainData(audio)
      const amplitude = Math.sqrt(audio.reduce((sum, sample) => sum + sample ** 2, 0) / audio.length)
      if (amplitude > 0.018) {
        voiceFrames += 1
        lastSpeech = performance.now()
      }
      if (voiceFrames >= 4 && performance.now() - lastSpeech >= 850) {
        window.clearInterval(timer)
        void voice.toggle()
      }
    }, 65)
    return () => window.clearInterval(timer)
  }, [handsFree, voice.status, voice.getAnalyser, voice.toggle])

  useEffect(() => {
    if (!listenAgain || phase !== 'idle' || voice.status !== 'idle') return
    setListenAgain(false)
    if (handsFree && canSpeak && current()) void voice.toggle()
  }, [listenAgain, phase, voice.status, canSpeak, handsFree])

  async function send(text: string) {
    if (!current() || !canSpeak || operation.current !== null) return
    const audio = context.current
    if (!audio || audio.state === 'closed') return
    const controller = new AbortController()
    operation.current = controller
    const signal = controller.signal
    let turn: VoiceTurn | undefined
    const isLive = () => (turn ? turn.scope.current() && lastRemoteTarget() === turn.scope.target : current()) &&
      !signal.aborted && operation.current === controller
    setTranscript(text)
    setReply('')
    setMessage('')
    setPhase('waiting')
    try {
      let sent = false
      if (scope !== undefined) {
        const before = new Set(useRemoteStore.getState().items.map((item) => item.id))
        let requestId: string | undefined
        if (questionItem !== undefined && question !== undefined) {
          sent = await useChatControls.getState().answerQuestion(question[0], {}, { [questionItem.id]: text })
        } else {
          const delivery = useRemoteStore.getState().sendToSession(scope.target, scope.sessionId, text, [])
          const pending = useRemoteStore.getState().items.findLast((item) =>
            item.kind === 'message' && item.role === 'user' && item.sessionId === scope.sessionId && !before.has(item.id))
          if (pending?.kind === 'message') requestId = pending.requestRpcId
          sent = await delivery && requestId !== undefined
        }
        turn = { scope, before, requestId }
      } else if (draft !== undefined) {
        starting.current = true
        sent = await draft.start(text, signal, (dispatched) => { turn = dispatched })
        starting.current = false
        if (sent && turn && isLive()) setCreatedScope(turn.scope)
      }
      if (!sent || !turn) {
        if (isLive()) setMessage(t('remoteVoiceCallDeliveryFailed'))
        return
      }
      if (!isLive()) return
      const { apiKey, ttsVoice } = useSettings.getState()
      let queuedPrefix = ''
      let playback = Promise.resolve()
      const queueSpeech = (text: string, done: boolean) => {
        if (!text.startsWith(queuedPrefix)) {
          // 流式回复被改写（DSML / think 标记回退）时前缀会对不上：
          // 收缩到两者的公共前缀继续读，别让后半段永远不朗读。
          let common = 0
          while (common < queuedPrefix.length && common < text.length && queuedPrefix[common] === text[common]) common++
          queuedPrefix = queuedPrefix.slice(0, common)
        }
        const remainder = text.slice(queuedPrefix.length)
        const lastBoundary = done ? undefined : Array.from(remainder.matchAll(SENTENCE_BOUNDARY)).at(-1)
        const end = done ? remainder.length : lastBoundary ? lastBoundary.index + lastBoundary[0].length : 0
        const slice = remainder.slice(0, end)
        const readable = slice.trim()
        if (!readable) return
        queuedPrefix += slice
        playback = playback.then(async () => {
          if (!isLive()) return
          await playSpeech(audio, { apiKey: apiKey ?? '', text: readable, voice: ttsVoice, signal,
            onPlaying: () => { if (isLive()) setPhase('speaking') } })
        }).catch((error: unknown) => {
          if (isLive()) showToast(describeReadAloudError(error))
        })
      }
      const replyText = await waitForReply({ ...turn, signal, onReply: (value) => {
        if (!isLive()) return
        setReply(value)
        queueSpeech(value, false)
      } })
      if (!isLive()) return
      if (!replyText) {
        setMessage(t('remoteVoiceCallNoReply'))
        return
      }
      queueSpeech(replyText, true)
      await playback
      if (isLive()) setListenAgain(true)
    } catch (error) {
      if (isLive()) showToast(describeReadAloudError(error))
    } finally {
      starting.current = false
      if (operation.current === controller) {
        const shouldReset = isLive()
        operation.current = null
        if (shouldReset) setPhase('idle')
        else if (!signal.aborted) onClose()
      }
    }
  }

  function interrupt() {
    if (!current() && !starting.current) return
    operation.current?.abort()
    operation.current = null
    setListenAgain(false)
    setPhase('idle')
    if (scope && streaming && !waitingApproval) void useRemoteStore.getState().cancel()
  }

  return <Modal title={t('remoteVoiceCall')} onClose={onClose} closable className={styles.modal} mainClassName={styles.body}>
    <div className={styles.layout}>
      <label className={styles.actions}>
        <input type="checkbox" checked={handsFree} onChange={(event) => setHandsFree(event.currentTarget.checked)} />
        {t('remoteVoiceCallHandsFree')}
      </label>
      <p role="status">{message || t(phase === 'waiting' ? 'remoteVoiceCallWaiting'
        : phase === 'speaking' ? 'remoteVoiceCallSpeaking' : canSpeak ? 'remoteVoiceCallReady' : 'remoteVoiceCallBlocked')}</p>
      {questionItem && <p>{questionItem.question}</p>}
      {transcript && <p className={styles.path}>{transcript}</p>}
      {reply && <p className={styles.path}>{reply}</p>}
      <div className={styles.actions}>
        <VoiceButton status={voice.status} seconds={voice.seconds}
          disabled={!voice.available || phase !== 'idle' || (voice.status === 'idle' && !canSpeak)}
          onClick={() => {
            if (!current()) return
            if (voice.status === 'idle') {
              setMessage('')
              stopReadAloud()
              context.current ??= new AudioContext({ sampleRate: TTS_SAMPLE_RATE })
              void context.current.resume().catch(() => undefined)
            }
            void voice.toggle()
          }} />
        {phase !== 'idle' && <Button variant="outlined" size="m" onClick={interrupt}>{t('remoteVoiceCallInterrupt')}</Button>}
        <Button variant="outlined" size="m" onClick={onClose}>{t('remoteVoiceCallEnd')}</Button>
      </div>
    </div>
  </Modal>
}

function waitForReply({ scope, before, requestId, signal, onReply }: {
  scope: TerminalScope; before: Set<string>; requestId?: string; signal: AbortSignal; onReply(text: string): void
}): Promise<string> {
  return new Promise((resolve) => {
    let settle: ReturnType<typeof setTimeout> | undefined
    let text = ''
    const finish = (value: string) => {
      off()
      offControls()
      signal.removeEventListener('abort', abort)
      clearTimeout(expires)
      clearTimeout(settle)
      resolve(value)
    }
    const abort = () => finish('')
    const update = () => {
      if (signal.aborted || !scope.current() || lastRemoteTarget() !== scope.target) {
        abort()
        return
      }
      clearTimeout(settle)
      const state = useRemoteStore.getState()
      const index = requestId === undefined ? -1 : state.items.findIndex((item) =>
        item.kind === 'message' && item.requestRpcId === requestId && item.nativeSeq !== undefined)
      const items = requestId !== undefined && index < 0 ? [] : state.items.slice(index + 1)
      const replies: string[] = []
      let writing = false
      for (const item of items) {
        if (before.has(item.id) || item.sessionId !== scope.sessionId || item.kind !== 'message') continue
        if (item.role === 'user') break
        if (item.role !== 'assistant' || item.context || item.usageOnly) continue
        const spoken = stripDsml(item.text).trim()
        if (spoken) replies.push(spoken)
        writing ||= item.streaming === true
      }
      const next = replies.join('\n')
      if (text !== next) onReply(text = next)
      const paused = state.pendingApprovals.length > 0 || Object.values(useChatControls.getState().questions)
        .some((question) => question.sessionId === scope.sessionId && question.phase === 'open')
      if (paused || (text && !state.streaming && !writing)) {
        settle = setTimeout(() => finish(text), 250)
      }
    }
    const off = useRemoteStore.subscribe(update)
    const offControls = useChatControls.subscribe(update)
    const expires = setTimeout(() => finish(text), RESPONSE_TIMEOUT_MS)
    signal.addEventListener('abort', abort, { once: true })
    update()
  })
}
