import { RemoteApiError } from './serverApi.js'
import { callEndpoint, lastRemoteTarget, sendPrompt, type RemoteCallTarget } from './sessionsApi.js'

export interface ScheduleTimeDraft {
  kind: 'after' | 'at' | 'every' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'cron'
  date: string
  time: string
  timeZone: string
  seconds: string
  weekdays: number[]
  monthDays: number[]
  expression: string
}

type ZonedTime = { time: string; time_zone: string }
type ScheduleTiming =
  | { kind: 'at'; at: ZonedTime & { date: string } }
  | { kind: 'every'; every_seconds: number }
  | { kind: 'daily'; daily: ZonedTime }
  | { kind: 'weekly'; weekly: ZonedTime & { weekdays: number[] } }
  | { kind: 'cron'; cron: { expression: string; time_zone: string } }
type ScheduleCreateTiming = ScheduleTiming | { kind: 'after'; after_seconds: number }

export interface ScheduleTask {
  id: string
  title: string
  prompt: string
  kind: string
  sessionId?: string
  active: boolean
  scheduledAt?: string
  deliveredAt?: string
  target?: Record<string, unknown>
  involvedSessionIds: string[]
  updatedAt?: string
  record: Record<string, unknown>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const string = (value: unknown) => typeof value === 'string' && value ? value : undefined

function parseTask(value: unknown): ScheduleTask | undefined {
  if (!isRecord(value) || !string(value.id)) return undefined
  const { sessionId: legacySession, lastDelivery, status, ...record } = value
  const target = isRecord(value.target) ? value.target : undefined
  if (target && target.kind !== 'session' && target.kind !== 'new' && target.kind !== 'new_once') return undefined
  const sessionId = target ? string(target.sessionId) : string(legacySession)
  if (!sessionId && !target) return undefined
  const title = string(value.title)
  const prompt = string(value.prompt) ?? ''
  return {
    id: value.id as string,
    title: title?.trim() || prompt.split('\n')[0]?.trim() || String(value.id),
    prompt,
    sessionId,
    active: target ? status === 'active' : status !== 'inactive',
    kind: string(value.kind) ?? 'at',
    scheduledAt: string(value.scheduledAt),
    deliveredAt: isRecord(lastDelivery) ? string(lastDelivery.deliveredAt) : undefined,
    target,
    involvedSessionIds: Array.isArray(value.involvedSessionIds)
      ? value.involvedSessionIds.filter((id): id is string => typeof id === 'string') : [],
    updatedAt: string(value.updatedAt),
    record,
  }
}

function assertConnected(target: RemoteCallTarget) {
  if (lastRemoteTarget() !== target) throw new RemoteApiError('RPC_ABORTED', 'The original Host connection closed.')
}

async function callSchedule(target: RemoteCallTarget, operation: string, request?: Record<string, unknown>) {
  assertConnected(target)
  const value = await callEndpoint<unknown>(target, 'schedule/' + operation, request ? { request } : {})
  assertConnected(target)
  if (isRecord(value) && typeof value.code === 'string') {
    throw new RemoteApiError(value.code, string(value.message) ?? value.code)
  }
  return value
}

export async function listSchedules(target: RemoteCallTarget) {
  const value = await callSchedule(target, 'catalog')
  const rows = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.items) ? value.items : undefined
  if (!rows) throw new RemoteApiError('INVALID_MESSAGE', 'The Host did not return a schedule catalog.')
  return rows.flatMap((row) => parseTask(row) ?? [])
}

export function scheduleDraft(task?: ScheduleTask): ScheduleTimeDraft | undefined {
  const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const record = task?.record
  const kind = task?.kind ?? 'daily'
  const allowed = ['after', 'at', 'every', 'daily', 'weekly', 'cron']
  if (!allowed.includes(kind)) return undefined
  const draft: ScheduleTimeDraft = {
    kind: kind === 'after' ? 'at' : kind as ScheduleTimeDraft['kind'],
    date: '', time: string(record?.time) ?? '09:00', timeZone: string(record?.timeZone) ?? deviceZone,
    seconds: String(record?.everySeconds ?? 3600), weekdays: [], monthDays: [1],
    expression: string(record?.expression) ?? '0 9 * * 1-5',
  }
  if (Array.isArray(record?.weekdays)) {
    draft.weekdays = record.weekdays.filter((day): day is number => Number.isInteger(day) && day >= 1 && day <= 7)
  }
  if (draft.kind === 'at' && task?.scheduledAt) {
    const instant = new Date(task.scheduledAt)
    if (Number.isFinite(instant.getTime())) {
      try {
        const parts = new Intl.DateTimeFormat('en-CA', {
          timeZone: draft.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
        }).formatToParts(instant)
        const fields = Object.fromEntries(parts.map(({ type, value }) => [type, value]))
        draft.date = [fields.year, fields.month, fields.day].join('-')
        draft.time = [fields.hour, fields.minute, fields.second].join(':')
        if (instant.getUTCMilliseconds()) draft.time += '.' + String(instant.getUTCMilliseconds()).padStart(3, '0')
      } catch {
        // A manually corrected zone and time can still be saved.
      }
    }
  }
  return draft
}

export function scheduleTiming(draft: ScheduleTimeDraft): ScheduleCreateTiming | undefined {
  const seconds = Number(draft.seconds)
  if (draft.kind === 'after' || draft.kind === 'every') {
    if (!Number.isSafeInteger(seconds) || seconds < (draft.kind === 'every' ? 60 : 1) ||
        seconds > 31_536_000) return undefined
    return draft.kind === 'after' ? { kind: 'after', after_seconds: seconds } : { kind: 'every', every_seconds: seconds }
  }
  const zone = draft.timeZone.trim()
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone })
  } catch {
    return undefined
  }
  if (draft.kind === 'cron') {
    const expression = draft.expression.trim().replace(/\s+/gu, ' ')
    if (expression.split(' ').length !== 5) return undefined
    return { kind: 'cron', cron: { expression, time_zone: zone } }
  }
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?$/u.test(draft.time)) return undefined
  if (draft.kind === 'at') {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(draft.date)) return undefined
    return { kind: 'at', at: { date: draft.date, time: draft.time, time_zone: zone } }
  }
  if (draft.kind === 'daily') return { kind: 'daily', daily: { time: draft.time, time_zone: zone } }
  if (draft.kind === 'monthly') {
    const days = [...new Set(draft.monthDays)].sort((a, b) => a - b)
    if (!days.length || days.some((day) => !Number.isInteger(day) || day < 1 || day > 31)) return undefined
    const [hour, minute] = draft.time.split(':').map(Number)
    return { kind: 'cron', cron: { expression: `${minute} ${hour} ${days.join(',')} * *`, time_zone: zone } }
  }
  const weekdays = draft.kind === 'weekdays' ? [1, 2, 3, 4, 5] : [...new Set(draft.weekdays)].sort((a, b) => a - b)
  if (!weekdays.length || weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) return undefined
  return { kind: 'weekly', weekly: { time: draft.time, time_zone: zone, weekdays } }
}

export function scheduleCreateArguments({ kind: _kind, ...timing }: ScheduleCreateTiming) {
  return timing
}

export function createSchedule(target: RemoteCallTarget, sessionId: string, title: string, prompt: string, timing: ScheduleCreateTiming) {
  return callSchedule(target, 'create', { sessionId, title, prompt, ...scheduleCreateArguments(timing) })
}

function address(task: ScheduleTask) {
  return task.target ? { id: task.id } : { sessionId: task.sessionId, id: task.id }
}

export async function updateSchedule(
  target: RemoteCallTarget,
  task: ScheduleTask,
  changes: { title?: string; prompt?: string },
  timing?: ScheduleTiming,
) {
  if (Object.keys(changes).length === 0 && !timing) return
  const result = task.target
    ? await callSchedule(target, 'edit', {
      id: task.id, action: 'update', patch: { ...changes, ...(timing ? { timing } : {}) },
      expectedUpdatedAt: task.updatedAt ?? null,
    })
    : await callSchedule(target, 'update', { ...address(task), expected: task.record, ...changes, ...(timing ? { change: timing } : {}) })
  if (!isRecord(result) || (task.target ? result.id !== task.id : result.updated !== true && !isRecord(result.record))) {
    throw new RemoteApiError('INVALID_MESSAGE', 'The Host did not confirm the schedule update.')
  }
}

export async function deleteSchedule(target: RemoteCallTarget, task: ScheduleTask) {
  const result = task.target
    ? await callSchedule(target, 'edit', { id: task.id, action: 'delete', expectedUpdatedAt: task.updatedAt ?? null })
    : await callSchedule(target, 'delete', address(task))
  if (!isRecord(result) || result.deleted !== true) {
    throw new RemoteApiError('INVALID_MESSAGE', 'The Host did not confirm deletion.')
  }
}

export async function runSchedule(target: RemoteCallTarget, task: ScheduleTask) {
  if (task.target) {
    await callSchedule(target, 'run', { id: task.id })
    return
  }
  assertConnected(target)
  if (!task.sessionId || !task.prompt.trim()) throw new RemoteApiError('INVALID_ARGUMENT', 'This task has no prompt or conversation.')
  await sendPrompt(target, task.sessionId, task.prompt)
}

export async function scheduleHistory(target: RemoteCallTarget, task: ScheduleTask, before?: string) {
  const result = await callSchedule(target, 'history', { ...address(task), limit: 20, ...(before ? { before } : {}) })
  if (!isRecord(result) || !Array.isArray(result.records)) {
    throw new RemoteApiError('INVALID_MESSAGE', 'The Host did not return a schedule history.')
  }
  return {
    runs: result.records.filter(isRecord).map((item, index) => ({
      key: string(item.messageId) ?? String(index),
      scheduledAt: string(item.scheduledAt),
      deliveredAt: string(item.deliveredAt),
      prompt: string(item.prompt),
    })),
    before: string(result.nextBefore),
    pruned: result.earlierRecordsPruned === true || result.earlierRecordsUnavailable === true,
  }
}
