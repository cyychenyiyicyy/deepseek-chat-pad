import { useEffect, useRef, useState } from 'react'
import { strToU8, zip } from 'fflate'
import { useTranslate } from '../../i18n/index.js'
import { stripDsml } from '../../services/api/dsml.js'
import { isNativeShellSync } from '../../services/api/transport.js'
import type { ChatItem } from '../../services/remote/adapter.js'
import { conversationShareTitle, DSH_CONVERSATION_MIME, encodeConversationShare, MAX_CONVERSATION_FILE, redactConversationShare, shareImageUrl, type ConversationShareMessage } from '../../services/remote/conversationShare.js'
import { saveGeneratedDownload } from '../../services/remote/download.js'
import { loadToolImage } from '../../services/remote/filesApi.js'
import { fetchHostSessionLog, hostHttpTarget } from '../../services/remote/hostHttpActions.js'
import { HOSTED_TTLS, hostedConversationUrl, publishHostedConversation, type HostedTtl } from '../../services/remote/hostedConversation.js'
import { exportSessionSnapshots, SESSION_EXPORT } from '../../services/remote/sessionTransfer.js'
import { describeRemoteError, lastRemoteTarget } from '../../services/remote/sessionsApi.js'
import type { TerminalScope } from '../../services/remote/terminal.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { ConversationReplay, type ReplayMessage } from './ConversationReplay.js'
import { renderConversationImage } from './conversationImage.js'
import styles from './RemoteManagementDialog.module.css'

export default function RemoteConversationExport({ scope, title, items, capabilities, onClose }: {
  scope: TerminalScope
  title: string
  items: readonly ChatItem[]
  capabilities: readonly string[]
  onClose: () => void
}) {
  const t = useTranslate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [firstMessage, setFirstMessage] = useState(1)
  const [lastMessage, setLastMessage] = useState<number>()
  const [replay, setReplay] = useState<ReplayMessage[] | null>(null)
  const [sharing, setSharing] = useState(false)
  const [ttl, setTtl] = useState<HostedTtl>('30d')
  const [link, setLink] = useState('')
  const [includeThinking, setIncludeThinking] = useState(false)
  const [includeTools, setIncludeTools] = useState(false)
  const [includeImages, setIncludeImages] = useState(false)
  const running = useRef(false)
  const mounted = useRef(false)
  const logExport = useRef<AbortController | null>(null)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; logExport.current?.abort() }
  }, [scope.target, scope.sessionId])
  const current = () => mounted.current && scope.current() && lastRemoteTarget() === scope.target
  const httpTarget = hostHttpTarget(scope.target)
  const filename = 'dsh-chat-' + scope.sessionId.replace(/[^a-zA-Z0-9_-]/gu, '_').slice(0, 96)
  const messages = items.flatMap((item, index) => {
    if (item.kind !== 'message' || item.sessionId !== scope.sessionId || item.context || item.usageOnly ||
        item.streaming || item.role === 'system' || item.sendState !== undefined) return []
    const content = stripDsml(item.text).trim()
    if (!content && !item.images?.length && !item.reasoning) return []
    const role = t(item.role === 'user' ? 'remoteExportPrompt' : 'remoteExportReply')
    return [{ index, item, id: item.id, label: role, role: item.role, text: content, time: item.nativeTime ?? item.createdAt }]
  })
  const selectedEnd = Math.min(lastMessage ?? messages.length, messages.length)
  const selectedStart = Math.min(firstMessage, selectedEnd || 1)
  const selected = messages.slice(selectedStart - 1, selectedEnd)
  const text = selected.map((item) => '## ' + item.label + '\n\n' + item.text).join('\n\n')
  const sharedTitle = sharing ? conversationShareTitle(title) || t('remoteExportConversation') : ''
  const shared = sharing ? selected.map((item) => ({ ...item, text: redactConversationShare(item.text) })) : []

  async function prepareShare(): Promise<(ReplayMessage & ConversationShareMessage)[]> {
    const messages: (ReplayMessage & ConversationShareMessage)[] = []
    let previousIndex = selected[0]?.index ?? 0
    let bytes = 0
    const seen = new Set<string>()
    for (const message of selected) {
      if (!current()) throw new DOMException('Conversation changed', 'AbortError')
      const images: NonNullable<ConversationShareMessage['images']> = []
      if (includeImages && message.role === 'user') {
        for (const image of message.item.images?.slice(0, 20) ?? []) {
          if (image.sessionId && image.sessionId !== scope.sessionId) continue
          const src = await loadToolImage(image, scope.sessionId)
          if (!current()) throw new DOMException('Conversation changed', 'AbortError')
          if (!src || !shareImageUrl(src)) throw new Error(t('remoteExportImageFailed'))
          if (!seen.has(src)) { seen.add(src); bytes += src.length }
          if (bytes > MAX_CONVERSATION_FILE) throw new Error(t('remoteHostedTooLarge'))
          images.push({ src, ...(image.name ? { name: redactConversationShare(image.name) } : {}) })
        }
      }
      const tools = includeTools ? items.slice(previousIndex, message.index).flatMap((item) => {
        if (item.kind !== 'tool' || item.state === 'running' || item.sessionId !== scope.sessionId) return []
        return [{ name: redactConversationShare(item.toolName).slice(0, 80),
          summary: redactConversationShare(item.summary ?? '').slice(0, 400),
          result: redactConversationShare(item.resultDetail?.text ?? '').slice(0, 64_000),
          status: item.state === 'failed' ? 'failed' as const : 'ok' as const, time: item.nativeTime ?? item.createdAt }]
      }) : []
      previousIndex = message.index + 1
      messages.push({
        id: message.id, label: message.label, role: message.role, text: redactConversationShare(message.text), time: message.time,
        ...(includeThinking && message.item.reasoning ? { thinking: redactConversationShare(message.item.reasoning) } : {}),
        ...(images.length > 0 ? { images } : {}), ...(tools.length > 0 ? { tools } : {}),
      })
    }
    return messages
  }

  async function run(action: () => Promise<void>) {
    if (running.current || !current()) return
    running.current = true
    setBusy(true)
    setError('')
    try { await action() }
    catch (failure) {
      if (current() && !(failure instanceof DOMException && failure.name === 'AbortError')) {
        setError(describeRemoteError(failure).text)
      }
    } finally {
      running.current = false
      if (current()) setBusy(false)
    }
  }

  async function exportZip() {
    const files: Record<string, Uint8Array> = {}
    const sessions: Array<{ sessionId: string; throughSeq: number; sha256: string; file: string }> = []
    let total = 0
    await exportSessionSnapshots({ target: scope.target, capabilities, current }, {
      kind: 'session', sessionId: scope.sessionId,
    }, async (entry, snapshot) => {
      total += snapshot.bytes.byteLength
      if (total > 28 * 1024 * 1024) throw new Error(t('remoteExportTooLarge'))
      const file = 'sessions/' + (sessions.length + 1) + '.json.gz'
      files[file] = snapshot.bytes
      sessions.push({ ...entry, sha256: snapshot.sha256, file })
    })
    if (!current()) return
    if (!sessions.length) throw new Error(t('remoteExportEmpty'))
    files['manifest.json'] = strToU8(JSON.stringify({
      version: 1, format: 'dsh-session-transfer.v1+gzip', rootSessionId: scope.sessionId, sessions,
    }, null, 2))
    const bytes = await new Promise<Uint8Array>((resolve, reject) => zip(files, { level: 0 }, (failure, output) => {
      if (failure) reject(failure)
      else resolve(output)
    }))
    if (!current()) return
    await saveGeneratedDownload(new Blob([new Uint8Array(bytes)], { type: 'application/zip' }), filename + '.zip', current)
  }

  async function exportHostLog() {
    if (!httpTarget) return
    const controller = new AbortController()
    logExport.current = controller
    try {
      const blob = await fetchHostSessionLog(httpTarget, scope.sessionId, controller.signal)
      if (current()) {
        const name = 'dsh-session-' + scope.sessionId.replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 96) + '.zip'
        await saveGeneratedDownload(blob, name, () => current() && !controller.signal.aborted)
      }
    } finally {
      if (logExport.current === controller) logExport.current = null
    }
  }

  async function saveShareFile() {
    const file = await encodeConversationShare(sharedTitle, await prepareShare(), t('remoteHostedTooLarge'))
    if (current()) await saveGeneratedDownload(new Blob([file], { type: DSH_CONVERSATION_MIME }), filename + '.dshgo', current)
  }

  async function createLink() {
    const file = await encodeConversationShare(sharedTitle, await prepareShare(), t('remoteHostedTooLarge'))
    if (!current()) return
    const saved = await publishHostedConversation(file, sharedTitle, ttl, current)
    if (saved && current()) setLink(hostedConversationUrl(saved))
  }

  async function saveHtml() {
    const { renderConversationHtml } = await import('./conversationHtml.js')
    const prepared = await prepareShare()
    const blob = renderConversationHtml(sharedTitle, t('remoteExportThinking'), prepared)
    if (blob.size > 16 * 1024 * 1024) throw new Error(t('remoteHostedTooLarge'))
    if (current()) await saveGeneratedDownload(blob, filename + '.html', current)
  }

  const content = '# ' + title.replaceAll(/[\r\n]+/gu, ' ') + '\n\n' + text + '\n'
  return <Modal title={t(replay ? 'remoteReplay' : sharing ? 'remoteHostedShare' : 'remoteExportConversation')} closable onClose={onClose} className={styles.modal} mainClassName={styles.body}>
    {replay !== null ? <ConversationReplay messages={replay} onBack={() => setReplay(null)} /> : sharing ? (
      <div className={styles.layout} aria-busy={busy}>
        <div className={styles.actions}>
          <Button variant="outlined" size="m" disabled={busy} onClick={() => { setSharing(false); setLink(''); setError(''); setCopied(false) }}>
            {t('remoteReplayBack')}
          </Button>
          <Button variant="outlined" size="m" disabled={busy} onClick={() => void run(saveShareFile)}>{t('remoteHostedDownload')}</Button>
          <Button variant="outlined" size="m" disabled={busy} onClick={() => void run(saveHtml)}>{t('remoteExportHtml')}</Button>
          <Button variant="outlined" size="m" disabled={busy} onClick={() => void run(async () => {
            const prepared = await prepareShare()
            if (current()) setReplay(prepared)
          })}>{t('remoteReplay')}</Button>
        </div>
        {error && <p role="alert">{error}</p>}
        <p>{t('remoteHostedPreview')}</p>
        <div className={styles.actions}>
          <label><input type="checkbox" checked={includeThinking} disabled={busy}
            onChange={(event) => setIncludeThinking(event.currentTarget.checked)} /> {t('remoteExportThinking')}</label>
          <label><input type="checkbox" checked={includeTools} disabled={busy}
            onChange={(event) => setIncludeTools(event.currentTarget.checked)} /> {t('remoteExportTools')}</label>
          <label><input type="checkbox" checked={includeImages} disabled={busy}
            onChange={(event) => setIncludeImages(event.currentTarget.checked)} /> {t('remoteExportImages')}</label>
        </div>
        <pre className={styles.output}>{sharedTitle + '\n\n' + shared.map((message) => message.label + '\n' + message.text).join('\n\n')}</pre>
        {isNativeShellSync() ? link ? <div className={styles.layout}>
          <input aria-label={t('remoteHostedShare')} className={styles.status} value={link} readOnly onFocus={(event) => event.currentTarget.select()} />
          <div className={styles.actions}>
            <Button variant="outlined" size="m" disabled={busy} onClick={() => void run(async () => {
              await navigator.clipboard.writeText(link)
              if (current()) setCopied(true)
            })}>{t(copied ? 'remoteExportCopied' : 'remoteHostedCopy')}</Button>
          </div>
        </div> : <div className={styles.actions}>
          <label className={styles.field}>
            {t('remoteHostedExpiry')}
            <select value={ttl} disabled={busy} onChange={(event) => setTtl(event.currentTarget.value as HostedTtl)}>
              {HOSTED_TTLS.map((value) => <option key={value} value={value}>{t(`remoteHostedTtl_${value}`)}</option>)}
            </select>
          </label>
          <Button variant="outlined" size="m" disabled={busy} onClick={() => void run(createLink)}>{t('remoteHostedCreate')}</Button>
        </div> : <p>{t('remoteHostedNative')}</p>}
      </div>
    ) : <div className={styles.layout} aria-busy={busy}>
      <p>{t('remoteExportLoaded')}</p>
      {error && <p role="alert">{error}</p>}
      {messages.length > 1 && <div className={styles.actions}>
        <label className={styles.field}>
          {t('remoteExportFrom')}
          <input type="number" min={1} max={selectedEnd} step={1} value={selectedStart} disabled={busy}
            onChange={(event) => {
              const next = event.currentTarget.valueAsNumber
              if (Number.isInteger(next) && next >= 1 && next <= selectedEnd) setFirstMessage(next)
            }} />
        </label>
        <label className={styles.field}>
          {t('remoteExportTo', { total: messages.length })}
          <input type="number" min={selectedStart} max={messages.length} step={1} value={selectedEnd} disabled={busy}
            onChange={(event) => {
              const next = event.currentTarget.valueAsNumber
              if (Number.isInteger(next) && next >= selectedStart && next <= messages.length) setLastMessage(next)
            }} />
        </label>
      </div>}
      <div className={styles.actions}>
        <Button variant="outlined" size="m" disabled={busy || !text} onClick={() => void run(async () => {
          await navigator.clipboard.writeText(content)
          if (current()) setCopied(true)
        })}>{t(copied ? 'remoteExportCopied' : 'remoteExportCopy')}</Button>
        <Button variant="outlined" size="m" disabled={busy || !text} onClick={() => void run(() =>
          saveGeneratedDownload(new Blob([content], { type: 'text/markdown' }), filename + '.md', current))}>
          {t('remoteExportMarkdown')}
        </Button>
        <Button variant="outlined" size="m" disabled={busy || !text} onClick={() => void run(async () => {
          const image = await renderConversationImage(title, selected, t('remoteExportImageTooLarge'), t('remoteExportImageFailed'))
          if (current()) await saveGeneratedDownload(image, filename + '.png', current)
        })}>{t('remoteExportImage')}</Button>
        <Button variant="outlined" size="m" disabled={busy || !text} onClick={() => {
          if (current()) setReplay(selected)
        }}>{t('remoteReplay')}</Button>
        <Button variant="outlined" size="m" disabled={busy || !text} onClick={() => {
          if (current()) { setCopied(false); setError(''); setSharing(true) }
        }}>{t('remoteHostedShare')}</Button>
        {typeof navigator.share === 'function' && <Button variant="outlined" size="m" disabled={busy || !text}
          onClick={() => void run(() => navigator.share({ title, text: content }))}>{t('remoteExportShare')}</Button>}
        {capabilities.includes(SESSION_EXPORT) && <Button variant="outlined" size="m" disabled={busy}
          onClick={() => void run(exportZip)}>{t('remoteExportSnapshotZip')}</Button>}
        {httpTarget && <Button variant="outlined" size="m" disabled={busy}
          onClick={() => void run(exportHostLog)}>{t('remoteExportHostLog')}</Button>}
      </div>
      {text && <pre className={styles.output}>{content}</pre>}
    </div>}
  </Modal>
}
