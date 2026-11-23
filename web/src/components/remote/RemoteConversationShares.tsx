import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { isNativeShellSync } from '../../services/api/transport.js'
import { decodeConversationShare, DSH_CONVERSATION_MIME, MAX_CONVERSATION_FILE } from '../../services/remote/conversationShare.js'
import { hostedConversationUrl, listHostedConversations, readHostedConversation, revokeHostedConversation, type HostedConversationLink } from '../../services/remote/hostedConversation.js'
import { describeRemoteError } from '../../services/remote/sessionsApi.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { ConversationReplay } from './ConversationReplay.js'
import styles from './RemoteManagementDialog.module.css'

export default function RemoteConversationShares({ onClose }: { onClose: () => void }) {
  const t = useTranslate()
  const native = isNativeShellSync()
  const [links, setLinks] = useState<HostedConversationLink[]>()
  const [confirm, setConfirm] = useState<HostedConversationLink>()
  const [value, setValue] = useState('')
  const [copied, setCopied] = useState('')
  const [replay, setReplay] = useState<Awaited<ReturnType<typeof decodeConversationShare>>>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const lifetime = useRef<AbortController>()
  const running = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    if (native) {
      void listHostedConversations().then((result) => {
        if (!controller.signal.aborted) setLinks(result)
      }).catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(describeRemoteError(failure).text)
      })
    }
    return () => controller.abort()
  }, [native])

  async function run(action: (signal: AbortSignal) => Promise<void>) {
    const signal = lifetime.current?.signal
    if (!signal || signal.aborted || running.current) return
    running.current = true
    setBusy(true)
    setError('')
    try { await action(signal) }
    catch (failure) { if (!signal.aborted) setError(describeRemoteError(failure).text) }
    finally {
      running.current = false
      if (!signal.aborted) setBusy(false)
    }
  }

  return <Modal closable onClose={onClose} title={replay?.title || t('remoteHostedManage')} className={styles.modal} mainClassName={styles.body}>
    {replay ? <ConversationReplay backLabel={t('remoteHostedBack')} messages={replay.messages.map((message, index) => ({
      ...message, id: 'shared-message-' + index, label: t(message.role === 'user' ? 'remoteExportPrompt' : 'remoteExportReply'),
    }))} onBack={() => setReplay(undefined)} /> : <div className={styles.layout} aria-busy={busy}>
      {error && <p role="alert">{error}</p>}
      <label className={styles.field}>{t('remoteHostedOpenFile')}
        <input type="file" accept={'.dshgo,' + DSH_CONVERSATION_MIME} disabled={busy} onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (!file) return
          void run(async (signal) => {
            if (file.size > MAX_CONVERSATION_FILE) throw new Error(t('remoteHostedTooLarge'))
            const decoded = await decodeConversationShare(new Uint8Array(await file.arrayBuffer()))
            if (!decoded.messages.length) throw new Error(t('remoteHostedNoMessages'))
            if (!signal.aborted) setReplay(decoded)
          })
        }} />
      </label>
      {native && <>
        <form className={styles.section} onSubmit={(event) => {
          event.preventDefault()
          void run(async (signal) => {
            const decoded = await readHostedConversation(value, signal)
            if (!decoded.messages.length) throw new Error(t('remoteHostedNoMessages'))
            if (!signal.aborted) { setReplay(decoded); setValue('') }
          })
        }}>
          <label className={styles.field}>{t('remoteHostedUrl')}
            <input value={value} onChange={(event) => setValue(event.currentTarget.value)} disabled={busy} spellCheck={false} maxLength={256} />
          </label>
          <div className={styles.actions}>
            <Button type="submit" variant="outlined" size="m" disabled={busy || !value.trim()}>{t('remoteHostedOpen')}</Button>
          </div>
        </form>
        <section className={styles.section}>
          <h3>{t('remoteHostedSaved')}</h3>
          {links?.length === 0 && <p>{t('remoteHostedNoLinks')}</p>}
          {links?.map((link) => <article key={link.id} className={styles.row}>
            <div>
              <strong>{link.title}</strong>
              <small>{link.expiry === null ? t('remoteHostedTtl_forever') : new Date(link.expiry).toLocaleDateString()}</small>
            </div>
            <div className={styles.actions}>
              <Button variant="outlined" size="m" disabled={busy} onClick={() => void run(async (signal) => {
                await navigator.clipboard.writeText(hostedConversationUrl(link))
                if (!signal.aborted) setCopied(link.id)
              })}>{t(copied === link.id ? 'remoteExportCopied' : 'remoteHostedCopy')}</Button>
              <Button variant="outlined" size="m" disabled={busy || confirm?.id === link.id} onClick={() => setConfirm(link)}>
                {t('remoteHostedRevoke')}
              </Button>
            </div>
          </article>)}
        </section>
        {confirm && <section className={styles.section}>
          <p>{t('remoteHostedConfirm', { title: confirm.title })}</p>
          <div className={styles.actions}>
            <Button variant="primary" size="m" disabled={busy} onClick={() => void run(async (signal) => {
              await revokeHostedConversation(confirm)
              const remaining = await listHostedConversations()
              if (!signal.aborted) { setLinks(remaining); setConfirm(undefined) }
            })}>{t('remoteHostedRevoke')}</Button>
            <Button variant="outlined" size="m" disabled={busy} onClick={() => setConfirm(undefined)}>{t('cancel')}</Button>
          </div>
        </section>}
      </>}
    </div>}
  </Modal>
}
