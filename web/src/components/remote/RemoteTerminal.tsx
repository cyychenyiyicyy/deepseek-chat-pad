import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { describeRemoteError } from '../../services/remote/sessionsApi.js'
import {
  attachTerminal, closeTerminal, createTerminal, currentTerminal, loadTerminalInventory,
  readTerminalFrame, renameTerminal, retainTerminal, type TerminalInfo, type TerminalScope,
} from '../../services/remote/terminal.js'
import { registerRemoteStreamSink } from '../../services/remote/store.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import styles from './RemoteManagementDialog.module.css'
import terminalStyles from './RemoteTerminal.module.css'

type Inventory = Awaited<ReturnType<typeof loadTerminalInventory>>

export default function RemoteTerminal({ scope, onClose }: { scope: TerminalScope; onClose: () => void }) {
  const t = useTranslate()
  const [inventory, setInventory] = useState<Inventory | null>(null)
  const [selected, setSelected] = useState('')
  const [shell, setShell] = useState('')
  const [editor, setEditor] = useState<'rename' | 'close' | null>(null)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const pending = useRef(false)
  const mounted = useRef(true)
  const current = inventory?.terminals.find((item) => item.id === selected)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  async function refresh() {
    const result = await loadTerminalInventory(scope)
    if (!mounted.current) return
    setInventory(result)
    setShell((previous) => result.shells.some((item) => item.path === previous) ? previous : '')
    setSelected((previous) => result.terminals.some((item) => item.id === previous) ? previous : result.terminals[0]?.id ?? '')
  }

  async function run(job: () => Promise<void>) {
    if (pending.current) return
    pending.current = true
    setError('')
    setBusy(true)
    try {
      await job()
    } catch (failure) {
      if (mounted.current) setError(describeRemoteError(failure).text)
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }

  useEffect(() => {
    void run(refresh)
  }, [scope])

  function update(info: TerminalInfo) {
    setInventory((previous) => previous && {
      ...previous, terminals: previous.terminals.map((row) => row.id === info.id ? info : row),
    })
  }

  return (
    <Modal expanded title={t('remoteTerminal')} onClose={onClose} closable className={terminalStyles.modal} mainClassName={styles.body}>
      <div className={styles.layout} aria-busy={busy}>
        <div className={terminalStyles.toolbar}>
          <label className={styles.field}>
            {t('remoteTerminalTabs')}
            <select value={current?.id ?? ''} disabled={busy || editor !== null} onChange={(event) => setSelected(event.target.value)}>
              {!current && <option value="">{t('remoteTerminalEmpty')}</option>}
              {inventory?.terminals.map((row) => <option key={row.id} value={row.id}>{row.title}</option>)}
            </select>
          </label>
          <label className={styles.field}>
            {t('remoteTerminalShell')}
            <select value={shell} disabled={busy || editor !== null} onChange={(event) => setShell(event.target.value)}>
              <option value="">{t('remoteTerminalDefaultShell')}</option>
              {inventory?.shells.map((row) => <option key={row.path} value={row.path}>{row.name}</option>)}
            </select>
          </label>
        </div>
        <div className={styles.actions}>
          <Button variant="primary" size="m" disabled={busy || !inventory || editor !== null} onClick={() => void run(async () => {
            const created = await createTerminal(scope, shell)
            await refresh()
            if (mounted.current) setSelected(created.id)
          })}>{t('remoteTerminalNew')}</Button>
          <Button variant="outlined" size="m" disabled={busy || editor !== null} onClick={() => void run(refresh)}>{t('remoteTerminalRefresh')}</Button>
          {current && editor === null && <>
            <Button variant="outlined" size="m" disabled={busy} onClick={() => {
              setTitle(current.title)
              setEditor('rename')
            }}>{t('sessionItemMenuRenameOption')}</Button>
            <Button variant="outlined" size="m" disabled={busy} onClick={() => setEditor('close')}>{t('remoteTerminalStop')}</Button>
          </>}
          {current && <Button variant="outlined" size="m" disabled={busy || editor !== null}
            onClick={() => setRetry((previous) => previous + 1)}>{t('remoteTerminalReattach')}</Button>}
        </div>
        {(current?.cwd || inventory?.environment.cwd) && <p className={styles.path}>{current?.cwd || inventory?.environment.cwd}</p>}
        {error && <div role="alert">{error}</div>}
        {editor === 'rename' && current && (
          <form className={styles.layout} onSubmit={(event) => {
            event.preventDefault()
            if (!title.trim()) return
            void run(async () => {
              await renameTerminal(scope, current.id, title.trim())
              await refresh()
              if (mounted.current) setEditor(null)
            })
          }}>
            <label className={styles.field}>
              {t('remoteTerminalTitle')}
              <input value={title} disabled={busy} maxLength={120} onChange={(event) => setTitle(event.target.value)} />
            </label>
            <div className={styles.actions}>
              <Button variant="primary" size="m" type="submit" disabled={busy || !title.trim()}>{t('sessionItemMenuRenameOption')}</Button>
              <Button variant="outlined" size="m" disabled={busy} onClick={() => setEditor(null)}>{t('cancel')}</Button>
            </div>
          </form>
        )}
        {editor === 'close' && current && <section className={styles.section}>
          <p>{t('remoteTerminalStopConfirm', { name: current.title })}</p>
          <div className={styles.actions}>
            <Button variant="primary" size="m" disabled={busy} onClick={() => void run(async () => {
              await closeTerminal(scope, current.id)
              await refresh()
              if (mounted.current) setEditor(null)
            })}>{t('remoteTerminalStop')}</Button>
            <Button variant="outlined" size="m" disabled={busy} onClick={() => setEditor(null)}>{t('cancel')}</Button>
          </div>
        </section>}
        {current && inventory && (
          <TerminalScreen key={JSON.stringify([current.id, retry])}
            id={current.id} scope={scope} environment={inventory.environment} onInfo={update} />
        )}
        {inventory?.terminals.map((row) => row.state === 'running' && (
          <RetainedTerminal key={row.id} id={row.id} scope={scope} />
        ))}
      </div>
    </Modal>
  )
}

function RetainedTerminal({ id, scope }: { id: string; scope: TerminalScope }) {
  useEffect(() => {
    if (!currentTerminal(scope)) return
    let release: (() => void) | undefined
    let disposed = false
    const stream = retainTerminal(scope, id)
    void stream.then((handle) => {
      if (disposed) {
        void handle.close().catch(() => undefined)
        return
      }
      // retain 流没人收帧时会一直堆在 store 的 unrouted 里（只有断连才释放）：
      // 挂一个空接收器让帧有去处，cleanup 时连同流一起关。
      release = registerRemoteStreamSink(handle.streamId, () => undefined)
    }, () => undefined)
    return () => {
      disposed = true
      release?.()
      void stream.then((handle) => { void handle.close().catch(() => undefined) }, () => undefined)
    }
  }, [scope, id])
  return null
}

function TerminalScreen({ id, scope, environment, onInfo }: {
  id: string
  scope: TerminalScope
  environment: Inventory['environment']
  onInfo: (info: TerminalInfo) => void
}) {
  const t = useTranslate()
  const mount = useRef<HTMLDivElement>(null)
  const infoRef = useRef(onInfo)
  infoRef.current = onInfo
  const [status, setStatus] = useState<'connecting' | 'readonly' | 'closed' | 'ready'>('connecting')
  const [error, setError] = useState('')
  const keyboard = useRef<((data: string) => void) | null>(null)
  const [ctrl, setCtrl] = useState(false)
  const [alt, setAlt] = useState(false)
  const modifier = useRef({ ctrl: false, alt: false })
  const { scrollback, maxCols, maxRows, maxInputBytes } = environment

  useEffect(() => {
    const element = mount.current
    if (element === null || !currentTerminal(scope)) return
    const attachment = attachTerminal(scope, id)
    let stopped = false
    let writable = false
    let sequence = -1
    let queue = Promise.resolve()
    let pendingBytes = 0
    let sizeSent = ''
    let release: (() => void) | undefined
    const fit = new FitAddon()
    const terminal = new Terminal({
      cursorBlink: true, scrollback, fontSize: 14,
      theme: { background: '#101827', foreground: '#e6edf7', cursor: '#80afff', selectionBackground: '#445e89' },
    })
    const encoder = new TextEncoder()
    terminal.loadAddon(fit)
    terminal.open(element)

    function send(action: () => Promise<unknown>) {
      queue = queue.then(async () => {
        if (stopped || !writable || !currentTerminal(scope)) return
        await action()
      }).catch((failure) => {
        if (!stopped) setError(describeRemoteError(failure).text)
      })
      return queue
    }
    const input = (data: string) => {
      if (!writable || stopped || !data) return
      let next = data
      if (data.length === 1) {
        const code = data.toUpperCase().charCodeAt(0)
        if (modifier.current.ctrl && code >= 64 && code <= 95) next = String.fromCharCode(code - 64)
      }
      if (modifier.current.alt) next = '\x1b' + next
      modifier.current = { ctrl: false, alt: false }
      setCtrl(false)
      setAlt(false)
      const bytes = encoder.encode(next).length
      if (bytes > maxInputBytes || pendingBytes + bytes > maxInputBytes * 4) {
        setError(t('remoteTerminalInputLimit'))
        return
      }
      pendingBytes += bytes
      void send(() => attachment.write(next)).then(() => { pendingBytes -= bytes })
    }
    keyboard.current = input
    const disposeInput = terminal.onData(input)
    function resize() {
      if (stopped || !writable) return
      const proposal = fit.proposeDimensions()
      if (!proposal) return
      const cols = Math.min(maxCols, proposal.cols)
      const rows = Math.min(maxRows, proposal.rows)
      const next = cols + '×' + rows
      if (sizeSent === next) return
      sizeSent = next
      terminal.resize(cols, rows)
      void send(() => attachment.resize(cols, rows))
    }
    const observer = new ResizeObserver(resize)
    observer.observe(element)

    function lost() {
      if (stopped) return
      writable = false
      setStatus('closed')
      void attachment.stream.then((handle) => handle.close(), () => undefined)
    }
    void attachment.stream.then(async (handle) => {
      if (stopped || !currentTerminal(scope)) {
        await handle.close()
        return
      }
      release = registerRemoteStreamSink(handle.streamId, (payload) => {
        if (stopped || !currentTerminal(scope)) return
        if (payload.type === 'closed') {
          if (payload.failure) setError(payload.failure.message)
          lost()
          return
        }
        const frame = payload.hasValue ? readTerminalFrame(payload.value) : undefined
        if (!frame) return
        if (frame.kind === 'output') {
          if (sequence < 0 || frame.sequence > sequence + 1) {
            lost()
          } else if (frame.sequence === sequence + 1) {
            sequence = frame.sequence
            terminal.write(frame.data)
          }
          return
        }
        if (frame.info.id !== id || (frame.kind === 'state' && sequence < 0)) return
        infoRef.current(frame.info)
        writable = frame.controllerId === attachment.attachmentId && frame.info.state === 'running'
        setStatus(writable ? 'ready' : 'readonly')
        if (frame.kind === 'snapshot') {
          sequence = frame.sequence
          terminal.reset()
          terminal.resize(frame.info.cols, frame.info.rows)
          terminal.write(frame.screen, resize)
        } else if (writable) {
          resize()
        }
      })
    }).catch((failure) => {
      if (stopped) return
      lost()
      setError(describeRemoteError(failure).text)
    })
    return () => {
      stopped = true
      keyboard.current = null
      observer.disconnect()
      disposeInput.dispose()
      release?.()
      terminal.dispose()
      void attachment.stream.then((handle) => handle.close(), () => undefined)
    }
  }, [scope, id, scrollback, maxCols, maxRows, maxInputBytes, t])

  const ready = status === 'ready'
  return (
    <section className={styles.section}>
      <div className={terminalStyles.screen} ref={mount} aria-label={t('remoteTerminal')} />
      <div className={terminalStyles.extraKeys} aria-label={t('remoteTerminalKeys')}>
        <button type="button" disabled={!ready} aria-pressed={ctrl} onClick={() => {
          modifier.current.ctrl = !ctrl
          setCtrl(!ctrl)
          mount.current?.querySelector('textarea')?.focus()
        }}>Ctrl</button>
        <button type="button" disabled={!ready} aria-pressed={alt} onClick={() => {
          modifier.current.alt = !alt
          setAlt(!alt)
          mount.current?.querySelector('textarea')?.focus()
        }}>Alt</button>
        {[
          ['Esc', '\x1b'], ['Tab', '\t'], ['↑', '\x1b[A'], ['↓', '\x1b[B'],
          ['←', '\x1b[D'], ['→', '\x1b[C'], ['Home', '\x1b[H'], ['End', '\x1b[F'],
        ].map(([label, input]) => (
          <button type="button" disabled={!ready} key={label} onClick={() => keyboard.current?.(input)}>{label}</button>
        ))}
      </div>
      {error && <div role="alert">{error}</div>}
      {status === 'readonly' && <p role="status">{t('remoteTerminalReadOnly')}</p>}
      {status === 'closed' && <p role="status">{t('remoteTerminalDisconnected')}</p>}
    </section>
  )
}
