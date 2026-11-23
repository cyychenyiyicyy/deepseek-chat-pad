import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  createSchedule, deleteSchedule, listSchedules, runSchedule, scheduleCreateArguments, scheduleDraft, scheduleHistory, scheduleTiming, updateSchedule,
  type ScheduleTask, type ScheduleTimeDraft,
} from '../../services/remote/schedules.js'
import { createSession, describeRemoteError, lastRemoteTarget, sendPrompt, type RemoteCallTarget } from '../../services/remote/sessionsApi.js'
import { useNewSessionStore } from '../../services/remote/newSessionStore.js'
import { useRemoteStore } from '../../services/remote/store.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import styles from './RemoteManagementDialog.module.css'

type History = Awaited<ReturnType<typeof scheduleHistory>>
const RULE_LABELS = {
  after: 'remoteScheduleAfter', at: 'remoteScheduleAt', every: 'remoteScheduleEvery',
  daily: 'remoteScheduleDaily', weekdays: 'remoteScheduleWeekdays', weekly: 'remoteScheduleWeekly',
  monthly: 'remoteScheduleMonthly', cron: 'remoteScheduleCron',
} as const
const LEGACY_CREATE_UNSUPPORTED = new Set([
  'METHOD_NOT_FOUND', 'METHOD_NOT_ALLOWED', 'CAPABILITY_NOT_SUPPORTED', 'FEATURE_NOT_SUPPORTED', 'gateway/not-found',
])
const WEEK = [1, 2, 3, 4, 5, 6, 7]
const MONTH = Array.from({ length: 31 }, (_, index) => index + 1)
const MONDAY = Date.UTC(2024, 0, 1)

const formatDate = (value?: string) => {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function describeTiming(task: ScheduleTask) {
  const { record } = task
  return [record.afterSeconds ?? record.everySeconds, record.time, record.expression, record.timeZone,
    Array.isArray(record.weekdays) ? record.weekdays.join(', ') : undefined]
    .filter((value) => typeof value === 'number' || typeof value === 'string').join(' · ')
}

export default function RemoteSchedules({ target, onClose }: { target: RemoteCallTarget; onClose: () => void }) {
  const t = useTranslate()
  const sessionId = useRemoteStore((state) => state.activeSessionId)
  const sessions = useRemoteStore((state) => state.sessions)
  const workspaces = useNewSessionStore((state) => state.workspaces)
  const sessionRows = useNewSessionStore((state) => state.rows)
  const [deliverySession, setDeliverySession] = useState('')
  const [workspaceId, setWorkspaceId] = useState('')
  const draftDestination = useRef<{ workspaceId: string; sessionId: string } | null>(null)
  const [rows, setRows] = useState<ScheduleTask[] | null>(null)
  const [filter, setFilter] = useState<'all' | 'active' | 'ended'>('all')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [editor, setEditor] = useState<'create' | 'edit' | 'delete' | 'run' | null>(null)
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [timing, setTiming] = useState<ScheduleTimeDraft>()
  const originalTiming = useRef<ScheduleTimeDraft>()
  const [history, setHistory] = useState<History | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const mounted = useRef(false)
  const inFlight = useRef(false)
  const pendingCreate = useRef<{ sessionId: string; title: string; existing: Set<string> } | null>(null)
  const pendingTimer = useRef<number | null>(null)
  const [, bumpPending] = useState(0)
  const expirePending = () => {
    if (pendingTimer.current !== null) window.clearTimeout(pendingTimer.current)
    // Host 不支持 schedule/create 时退回「让模型去建」，我们等不到明确回执：
    // 一分钟内没在列表里认领就解除挂起，避免「新建」按钮永久禁用。
    pendingTimer.current = window.setTimeout(() => {
      pendingTimer.current = null
      if (!mounted.current || pendingCreate.current === null) return
      pendingCreate.current = null
      bumpPending((value) => value + 1)
    }, 60_000)
  }
  const current = () => mounted.current && lastRemoteTarget() === target

  async function refresh() {
    const items = await listSchedules(target)
    if (!current()) return
    setRows(items)
    const pending = pendingCreate.current
    const created = pending && items.find((item) => !pending.existing.has(item.id) && item.title === pending.title &&
      (item.sessionId === pending.sessionId || item.involvedSessionIds.includes(pending.sessionId)))
    if (created) {
      pendingCreate.current = null
      if (pendingTimer.current !== null) {
        window.clearTimeout(pendingTimer.current)
        pendingTimer.current = null
      }
      setNotice(t('remoteScheduleSaved'))
    }
  }

  async function run(action: () => Promise<void>) {
    if (!current() || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (failure) {
      if (current()) setError(describeRemoteError(failure).text)
    } finally {
      inFlight.current = false
      if (current()) setBusy(false)
    }
  }

  useEffect(() => {
    mounted.current = true
    void run(refresh)
    return () => {
      mounted.current = false
      if (pendingTimer.current !== null) window.clearTimeout(pendingTimer.current)
      pendingTimer.current = null
    }
  }, [target])

  const task = rows?.find((item) => item.id === selected)
  const rule = timing && scheduleTiming(timing)
  const timingChanged = editor === 'edit' && timing !== originalTiming.current &&
    JSON.stringify(rule) !== JSON.stringify(originalTiming.current && scheduleTiming(originalTiming.current))
  const canSubmit = title.trim() !== '' && prompt.trim() !== '' &&
    (editor !== 'create' || rule !== undefined) && (!timingChanged || (rule !== undefined && rule.kind !== 'after'))
  const subagents = new Set(sessionRows.filter((item) => item.parentSessionId).map((item) => item.sessionId))
  const destinations = sessions.filter((item) => !subagents.has(item.id))
  const query = search.trim().toLocaleLowerCase()
  const filtered = rows?.filter((row) => (filter === 'all' || row.active === (filter === 'active')) &&
    [row.title, row.prompt, row.kind, describeTiming(row)].some((value) => value.toLocaleLowerCase().includes(query)))

  function beginEdit(next: 'create' | 'edit') {
    setNotice('')
    setError('')
    setTitle(next === 'edit' ? task?.title ?? '' : '')
    setPrompt(next === 'edit' ? task?.prompt ?? '' : '')
    const initialTiming = scheduleDraft(next === 'edit' ? task : undefined)
    originalTiming.current = initialTiming
    setTiming(initialTiming)
    if (next === 'create') {
      setDeliverySession(destinations.find((item) => item.id === sessionId)?.id ?? destinations[0]?.id ?? '')
      setWorkspaceId('')
      draftDestination.current = null
    }
    setEditor(next)
  }

  function view(item: ScheduleTask) {
    setSelected(item.id)
    setHistory(null)
    setNotice('')
    void run(async () => {
      const result = await scheduleHistory(target, item)
      if (current()) setHistory(result)
    })
  }

  async function create() {
    if (!rule || pendingCreate.current || !current()) return
    const name = title.trim()
    const instruction = prompt.trim()
    let deliveryId = deliverySession
    if (!deliveryId) {
      const prior = draftDestination.current
      if (prior?.workspaceId === workspaceId) deliveryId = prior.sessionId
      else {
        const destination = await createSession(target, workspaceId ? { workspaceId } : {})
        if (!current()) return
        deliveryId = destination.sessionId
        draftDestination.current = { workspaceId, sessionId: deliveryId }
        void useRemoteStore.getState().refreshSessions()
      }
    }
    try {
      await createSchedule(target, deliveryId, name, instruction, rule)
      if (!current()) return
      setNotice(t('remoteScheduleSaved'))
    } catch (failure) {
      if (!LEGACY_CREATE_UNSUPPORTED.has(describeRemoteError(failure).code)) throw failure
      if (!current()) return
      const args = JSON.stringify({ title: name, prompt: instruction, ...scheduleCreateArguments(rule) })
      const request = t('remoteScheduleCreatePrompt', { args })
      if (useRemoteStore.getState().activeSessionId === deliveryId) {
        if (!await useRemoteStore.getState().sendToSession(target, deliveryId, request, [], 'queue')) return
      } else await sendPrompt(target, deliveryId, request, [], { mode: 'queue' })
      if (!current()) return
      pendingCreate.current = { sessionId: deliveryId, title: name, existing: new Set(rows?.map((item) => item.id)) }
      expirePending()
      setNotice(t('remoteSchedulePending'))
    }
    setEditor(null)
    await refresh()
  }

  function timingField<K extends keyof ScheduleTimeDraft>(key: K, value: ScheduleTimeDraft[K]) {
    setTiming((previous) => previous && { ...previous, [key]: value })
  }

  return (
    <Modal title={t('remoteSchedules')} onClose={onClose} closable className={styles.modal} mainClassName={styles.body}>
      <div className={styles.layout} aria-busy={busy}>
        {!task && editor === null && <div className={styles.actions}>
          <Button variant="primary" size="m" disabled={busy || rows === null || pendingCreate.current !== null}
            onClick={() => beginEdit('create')}>{t('remoteScheduleNew')}</Button>
          <Button variant="outlined" size="m" disabled={busy} onClick={() => void run(refresh)}>{t('remoteTerminalRefresh')}</Button>
        </div>}
        {error && <div role="alert">{error}</div>}
        {notice && <div className={styles.status} role="status">{notice}</div>}
        {editor === 'create' || editor === 'edit' ? (
          <form className={styles.layout} onSubmit={(event) => {
            event.preventDefault()
            if (!canSubmit) return
            void run(async () => {
              if (editor === 'create') {
                await create()
              } else if (task) {
                const changes = {
                  ...(title.trim() === task.title ? {} : { title: title.trim() }),
                  ...(prompt.trim() === task.prompt ? {} : { prompt: prompt.trim() }),
                }
                await updateSchedule(target, task, changes, timingChanged && rule?.kind !== 'after' ? rule : undefined)
                if (!current()) return
                setEditor(null)
                setNotice(t('remoteScheduleSaved'))
                await refresh()
              }
            })
          }}>
            {editor === 'create' && <label className={styles.field}>{t('remoteScheduleDestination')}
              <select value={deliverySession} onChange={(event) => setDeliverySession(event.target.value)} disabled={busy}>
                <option value="">{t('newSessionTitle')}</option>
                {destinations.map((item) => <option key={item.id} value={item.id}>{item.title || item.id}</option>)}
              </select>
            </label>}
            {editor === 'create' && !deliverySession && <label className={styles.field}>{t('remoteScheduleWorkspace')}
              <select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} disabled={busy}>
                <option value="">{t('remoteScheduleDefaultWorkspace')}</option>
                {workspaces.map((item) => <option key={item.workspaceId} value={item.workspaceId}>{item.title}</option>)}
              </select>
            </label>}
            <label className={styles.field}>{t('remoteScheduleTitle')}
              <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} required disabled={busy} />
            </label>
            <label className={styles.field}>{t('remoteSchedulePrompt')}
              <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={20000} required disabled={busy} />
            </label>
            {timing && <fieldset className={styles.layout} disabled={busy}>
              <legend>{t('remoteScheduleRule')}</legend>
              <label className={styles.field}>{t('remoteScheduleFrequency')}
                <select value={timing.kind} onChange={(event) => timingField('kind', event.target.value as ScheduleTimeDraft['kind'])}>
                  {Object.entries(RULE_LABELS).filter(([kind]) => kind !== 'after' || editor === 'create')
                    .map(([kind, label]) => <option key={kind} value={kind}>{t(label)}</option>)}
                </select>
              </label>
              {timing.kind === 'at' && <label className={styles.field}>{t('remoteScheduleDate')}
                <input type="date" required value={timing.date} onChange={(event) => timingField('date', event.target.value)} />
              </label>}
              {(timing.kind === 'at' || timing.kind === 'daily' || timing.kind === 'weekdays' ||
                timing.kind === 'weekly' || timing.kind === 'monthly') &&
                <label className={styles.field}>{t('remoteScheduleTime')}
                  <input type="time" step="any" value={timing.time}
                    onChange={(event) => timingField('time', event.target.value)} />
                </label>}
              {timing.kind === 'after' || timing.kind === 'every' ? (
                <label className={styles.field}>{t('remoteScheduleSeconds')}
                  <input type="number" min={timing.kind === 'every' ? 60 : 1} max={31536000} step="1"
                    value={timing.seconds} onChange={(event) => timingField('seconds', event.target.value)} />
                </label>
              ) : <label className={styles.field}>{t('remoteScheduleZone')}
                <input required value={timing.timeZone} onChange={(event) => timingField('timeZone', event.target.value)} />
              </label>}
              {timing.kind === 'weekly' && <div className={styles.actions}>
                {WEEK.map((day) => <label key={day}>
                  <input type="checkbox" checked={timing.weekdays.includes(day)} onChange={(event) =>
                    timingField('weekdays', event.target.checked ? [...timing.weekdays, day] : timing.weekdays.filter((value) => value !== day))} />
                  {new Date(MONDAY + (day - 1) * 86400000).toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' })}
                </label>)}
              </div>}
              {timing.kind === 'monthly' && <div className={styles.actions}>
                {MONTH.map((day) => <label key={day}>
                  <input type="checkbox" checked={timing.monthDays.includes(day)} onChange={(event) =>
                    timingField('monthDays', event.target.checked ? [...timing.monthDays, day] : timing.monthDays.filter((value) => value !== day))} />
                  {day}
                </label>)}
              </div>}
              {timing.kind === 'cron' && <label className={styles.field}>{t('remoteScheduleExpression')}
                <input value={timing.expression} required onChange={(event) => timingField('expression', event.target.value)} placeholder="0 9 * * 1-5" />
              </label>}
            </fieldset>}
            <div className={styles.actions}>
              <Button variant="primary" size="m" type="submit" disabled={busy || !canSubmit}>{t('remoteScheduleSave')}</Button>
              <Button variant="outlined" size="m" disabled={busy} onClick={() => setEditor(null)}>{t('cancel')}</Button>
            </div>
          </form>
        ) : task ? (
          <section className={styles.layout}>
            <div className={styles.actions}>
              <Button variant="outlined" size="m" disabled={busy} onClick={() => { setEditor(null); setSelected(null); setError(''); setNotice('') }}>
                {t('chatControlsBack')}
              </Button>
              {editor === null && <>
                <Button variant="outlined" size="m" disabled={busy || !task.active} onClick={() => beginEdit('edit')}>{t('remoteScheduleEdit')}</Button>
                <Button variant="outlined" size="m" disabled={busy || !task.active} onClick={() => setEditor('run')}>{t('remoteScheduleRun')}</Button>
                <Button variant="outlined" size="m" disabled={busy} onClick={() => setEditor('delete')}>{t('remoteScheduleDelete')}</Button>
              </>}
            </div>
            <h3 className={styles.path}>{task.title}</h3>
            <p>{describeTiming(task) || task.kind} · {formatDate(task.active ? task.scheduledAt : task.deliveredAt)}</p>
            <pre className={styles.output}>{task.prompt}</pre>
            {(editor === 'delete' || editor === 'run') && <div className={styles.section}>
              <p>{t(editor === 'delete' ? 'remoteScheduleDeleteConfirm' : 'remoteScheduleRunConfirm')}</p>
              <div className={styles.actions}>
                <Button variant="primary" size="m" disabled={busy} onClick={() => void run(async () => {
                  if (editor === 'delete') {
                    await deleteSchedule(target, task)
                    if (current()) setSelected(null)
                  } else {
                    await runSchedule(target, task)
                    if (current()) setNotice(t('remoteScheduleRunRequested'))
                  }
                  if (!current()) return
                  setEditor(null)
                  await refresh()
                  if (editor === 'run') setHistory(await scheduleHistory(target, task))
                })}>{t(editor === 'delete' ? 'remoteScheduleDelete' : 'remoteScheduleRun')}</Button>
                <Button variant="outlined" size="m" disabled={busy} onClick={() => setEditor(null)}>{t('cancel')}</Button>
              </div>
            </div>}
            <h3>{t('remoteScheduleHistory')}</h3>
            {history?.runs.length === 0 && <p>{t('remoteScheduleHistoryEmpty')}</p>}
            {history?.runs.map((entry, index) => <div className={styles.row} key={entry.key + ':' + index}>
              <div>{formatDate(entry.deliveredAt ?? entry.scheduledAt)}{entry.prompt && <small>{entry.prompt}</small>}</div>
            </div>)}
            {history?.pruned && <p>{t('remoteScheduleHistoryPruned')}</p>}
            {(!history || history.before) && <Button variant="outlined" size="m" disabled={busy} onClick={() => void run(async () => {
              const next = await scheduleHistory(target, task, history?.before)
              if (current()) setHistory({ ...next, runs: [...(history?.runs ?? []), ...next.runs] })
            })}>{t(history ? 'remoteScheduleMore' : 'remoteTerminalRefresh')}</Button>}
          </section>
        ) : (
          <section className={styles.layout}>
            <label className={styles.field}>{t('remoteScheduleSearch')}
              <input value={search} onChange={(event) => setSearch(event.target.value)} type="search" />
            </label>
            <label className={styles.field}>{t('remoteScheduleFilter')}
              <select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}>
                <option value="all">{t('remoteScheduleAll')}</option>
                <option value="active">{t('remoteScheduleActive')}</option>
                <option value="ended">{t('remoteJobsEnded')}</option>
              </select>
            </label>
            {rows === null && !error && <p role="status">{t('workspacePaneLoading')}</p>}
            {filtered?.length === 0 && <p>{t('remoteScheduleEmpty')}</p>}
            {filtered?.map((item) => <div className={styles.row} key={item.id}>
              <div>{item.title}<small>{formatDate(item.active ? item.scheduledAt : item.deliveredAt) || describeTiming(item) || item.kind}</small></div>
              <Button variant="outlined" size="m" disabled={busy} onClick={() => view(item)}>{t('remoteScheduleView')}</Button>
            </div>)}
          </section>
        )}
      </div>
    </Modal>
  )
}
