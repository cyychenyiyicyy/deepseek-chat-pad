import { RemoteApiError } from './serverApi.js'
import { callEndpoint, lastRemoteTarget, type RemoteCallTarget } from './sessionsApi.js'

export interface RemoteJobScope {
  target: RemoteCallTarget
  sessionId: string
  current(): boolean
}

export interface RemoteJob {
  id: string
  label: string
  status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  progress?: string
  detail?: string
}

export type JobFrame = { kind: 'job'; job: RemoteJob } |
  { kind: 'output'; text: string; trimmed: boolean }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function jobIsCurrent(scope: RemoteJobScope) {
  return lastRemoteTarget() === scope.target && scope.current()
}

function assertCurrent(scope: RemoteJobScope) {
  if (!jobIsCurrent(scope)) throw new RemoteApiError('RPC_ABORTED', 'The original session is no longer selected.')
}

function parseJob(value: unknown): RemoteJob | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) return undefined
  const { status } = value
  if (status !== 'running' && status !== 'stopping' && status !== 'completed' && status !== 'killed' && status !== 'failed') {
    return undefined
  }
  return {
    id: value.id,
    label: typeof value.label === 'string' && value.label.trim() ? value.label : value.id,
    status,
    progress: typeof value.progress === 'string' ? value.progress : undefined,
    detail: typeof value.detail === 'string' ? value.detail : undefined,
  }
}

export function readJobList(value: unknown): RemoteJob[] | undefined {
  if (!isRecord(value) || value.type !== 'rows' || !Array.isArray(value.jobs)) return undefined
  return value.jobs.flatMap((row) => parseJob(row) ?? [])
}

export function readJobFrame(value: unknown): JobFrame | undefined {
  if (!isRecord(value)) return undefined
  if (value.type === 'opened' || value.type === 'status') {
    const job = parseJob(value.job)
    return job && { kind: 'job', job }
  }
  if (value.type !== 'output' || !Array.isArray(value.chunks)) return undefined
  const chunks = value.chunks.filter(isRecord)
  return {
    kind: 'output',
    text: chunks.map((chunk) => typeof chunk.text === 'string' ? chunk.text : '').join(''),
    trimmed: value.lossy === true || chunks.some((chunk) => chunk.gapBefore === true),
  }
}

export async function openJobStream(scope: RemoteJobScope, jobId?: string) {
  assertCurrent(scope)
  const endpoint = jobId === undefined ? 'job/list' : 'job/follow'
  const request = { sessionId: scope.sessionId, ...(jobId === undefined ? {} : { jobId }) }
  return scope.target.openStream(endpoint, { args: { request } })
}

export async function stopJob(scope: RemoteJobScope, jobId: string): Promise<'requested' | 'already-finished'> {
  assertCurrent(scope)
  const value = await callEndpoint<unknown>(scope.target, 'job/kill', { request: { sessionId: scope.sessionId, jobId } })
  assertCurrent(scope)
  if (!isRecord(value) || (value.outcome !== 'requested' && value.outcome !== 'already-finished')) {
    throw new RemoteApiError('INVALID_MESSAGE', 'The Host did not return a stop result.')
  }
  return value.outcome
}
