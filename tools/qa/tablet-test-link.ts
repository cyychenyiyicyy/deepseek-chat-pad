import type { SecureLink, SecureLinkOptions, StreamEventPayload } from '../../web/src/services/remote/core/index.js'
import { RemoteLinkError } from '../../web/src/services/remote/core/errors.js'
import { gzipSync, strToU8 } from '../../web/node_modules/fflate'

type Args = {
  workspaceFileScopeId?: string
  path?: string
  id?: string
  agentId?: string
  sessionId?: string
  attachmentId?: string
  title?: string
  data?: string
  ns?: string
  ref?: string
  value?: string
  refs?: string[]
  expectedRevision?: number
  ops?: Array<{ path: string[]; op: 'set' | 'unset'; value?: unknown }>
  request?: { requestId?: string; sessionId?: string; id?: string; objective?: string; maxGoalRounds?: number; messageId?: string; rating?: string; action?: string; patch?: Record<string, unknown>; name?: string; path?: string; title?: string; prompt?: string; expectedUpdatedAt?: string; address?: { sessionId?: string }; beforeSeq?: number; content?: Array<{ type: string; text?: string }> }
}

export const telemetry = {
  calls: [] as Array<{ endpoint: string; args: Args }>,
  closed: [] as string[],
  sendOutcome: 'timeout' as 'timeout' | 'echo-timeout' | 'reject' | 'success',
  createDelay: 0,
  showFeedbackReply: false,
  scheduleCreateUnsupported: false,
  snapshotWrongSession: false,
  snapshotDelay: 0,
  snapshotClosed: 0,
  snapshotSession: '',
  failingUpload: '',
  linkAttempts: [] as Array<string>,
  linkFailures: [] as Array<string>,
  slowUpload: '',
  emitWorkspace: undefined as ((value: unknown) => void) | undefined,
  emitWorkspaceFile: undefined as ((path: string, value: unknown) => void) | undefined,
  workspaceFiles: ['before.txt'],
  workspaceText: 'Before change',
  historyEnabled: false,
  historyDelay: 0,
  forkFixture: false,
  voiceReply: false,
  voiceStream: false,
  finishVoice: undefined as (() => void) | undefined,
}

const userMessage = (id: string, text: string, seq: number) => ({
  type: 'event', event: { type: 'user/message', seq, time: Date.now(),
    data: { message: { id, source: { kind: 'user' }, content: [{ type: 'text', text }] } } },
})
const invisibleEvent = (seq: number) => ({ type: 'event', event: { type: 'fixture/invisible', seq, time: Date.now() } })
const forkEvents = ['permission/preset', 'sandbox/mode', 'approval/policy', 'agent/inbox/spliced',
  'turn/start', 'agent/inbox/spliced', 'step/start', 'system/message'].map((type, seq) =>
  ({ type: 'event', event: { type, seq, time: Date.now(), data: {} } }))

const documentFixture = (() => {
  const content = '0.1 0.2 0.3 rg 0 0 140 200 re f'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 140 200] /Contents 5 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 140] /Contents 5 0 R >>',
    '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = objects.map((object, index) => {
    const offset = pdf.length
    pdf += (index + 1) + ' 0 obj\n' + object + '\nendobj\n'
    return offset.toString().padStart(10, '0') + ' 00000 n '
  })
  return pdf + 'xref\n0 6\n0000000000 65535 f \n' + offsets.join('\n') +
    '\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + pdf.length + '\n%%EOF\n'
})()

export function createSecureLink(options: SecureLinkOptions): SecureLink {
  const transportAttempt = options.rtc?.mode ?? 'relay'
  telemetry.linkAttempts.push(transportAttempt)
  const failure = telemetry.linkFailures.shift()
  let counter = 0
  let state: SecureLink['state'] = 'secure'
  let eventSeq = 2
  let terminalTitle = 'Fixture shell'
  const savedSessionsKey = `fixture.created.${options.hostDeviceId}`
  const createdSessions = JSON.parse(localStorage.getItem(savedSessionsKey) ?? '[]') as Array<{ sessionId: string; title: string; updatedAt: number }>
  const sessions = [{ sessionId: 'qa-a', title: 'Tablet workspace alpha', updatedAt: Date.now() },
    { sessionId: 'qa-b', title: 'Tablet workspace beta', updatedAt: Date.now() - 1000 }, ...createdSessions]
  const echoes = new Map<string, unknown[]>()
  const streamMap = new Map<string, { endpoint: string; args: Args }>()
  const terminalInfo = (attachmentId?: string) => ({
    id: 'term-fixture', title: terminalTitle, state: 'running', cwd: '/mock', cols: 80, rows: 24, controllerId: attachmentId,
  })
  const frame = (stream: string, value: unknown) => options.onStreamEvent?.(stream, { type: 'frame', hasValue: true, value } as StreamEventPayload)
  const job = { id: 'fixture-job', label: 'Fixture background job', status: 'running' }
  let credentialConfigured = false
  let modelOverrides: Record<string, unknown> = { 'base-model': { name: 'Base model', compat: { supportsCache: true } } }
  let feedback: { messageId: string; rating: string; version: string } | undefined
  const goals = new Map<string, { id: string; revision: number; objective: string; phase: string; maxGoalRounds?: number }>()
  const sections = [
    { ns: 'fixture-plugin', revision: 3,
      schema: { type: 'object', dict: { enabled: { type: 'boolean', meta: { title: 'Fixture behavior' } } } },
      value: { enabled: false }, user: {} },
    { ns: 'llm-pi-ai', revision: 8,
      value: { providers: { 'fixture-provider': {
        displayName: 'Fixture provider', api: 'openai-completions', baseURL: 'https://fixture.invalid/api',
        apiKeyEnv: 'FIXTURE_API_KEY', models: [{ id: 'base-model' }], defaultContextWindow: 32000,
        modelOverrides,
      } } }, user: { providers: { 'fixture-provider': { modelOverrides } } } },
  ]
  let schedules = [{
    id: 'fixture-schedule', target: { kind: 'session', sessionId: 'qa-a' }, involvedSessionIds: ['qa-a'],
    title: 'Fixture schedule', kind: 'daily', time: '09:00', timeZone: 'UTC',
    status: 'active', prompt: 'Fixture scheduled instruction', scheduledAt: '2026-12-01T09:00:00Z', updatedAt: '2026-11-22T09:00:00Z',
  }]
  return {
    get state() { return state },
    transport: 'relay',
    async ready() { if (failure) throw new RemoteLinkError(failure, 'Fixture link failure') },
    sendFrame() {},
    async rpc<T>(method: string, params?: unknown): Promise<T> {
      if (method === 'harness.transport.describe') return {
        capabilities: ['harness.remote.v3', 'harness.terminal.v1', 'session.transfer.export.v1'],
      } as T
      if (method === 'session.transfer.export.open') {
        const { scope } = params as { scope: { sessionId: string } }
        telemetry.snapshotSession = scope.sessionId
        if (telemetry.snapshotDelay) await new Promise((resolve) => setTimeout(resolve, telemetry.snapshotDelay))
        const sessionId = telemetry.snapshotWrongSession ? 'qa-b' : scope.sessionId
        return { handle: 'fixture-snapshot', chunkBytes: 256, sessions: [{ sessionId, throughSeq: 2 }] } as T
      }
      if (method === 'session.transfer.export.read') {
        const { sessionId, offset } = params as { sessionId: string; offset: number }
        const bytes = gzipSync(strToU8(JSON.stringify({ formatVersion: 1, sessionId, events: [] })))
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))
        return {
          offset, data: btoa(String.fromCharCode(...bytes)), totalBytes: bytes.length,
          sha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(''),
        } as T
      }
      if (method === 'session.transfer.export.close') {
        telemetry.snapshotClosed += 1
        return {} as T
      }
      const { endpoint, payload: { args } } = params as { endpoint: string; payload: { args: Args } }
      telemetry.calls.push({ endpoint, args })
      const ok = (value?: unknown) => ({ ok: true, value }) as T
      if (endpoint === 'session/list') return ok({ sessions, items: sessions })
      if (endpoint === 'workspace/create') {
        return ok({ workspace: { workspaceId: 'recent-folder', title: 'Recent project', path: args.request?.path,
          sessionIds: [] }, created: true })
      }
      if (endpoint === 'session/page' && telemetry.forkFixture && args.request?.beforeSeq === 8) {
        if (telemetry.historyDelay) await new Promise((resolve) => setTimeout(resolve, telemetry.historyDelay))
        return ok({ records: forkEvents, hasMore: false })
      }
      if (endpoint === 'session/fork' && telemetry.forkFixture && args.request?.atSeq === 2) {
        const sessionId = 'qa-edited-first'
        sessions.push({ sessionId, title: 'Edited first turn', updatedAt: Date.now() })
        return ok({ sessionId })
      }
      if (endpoint === 'session/page' && telemetry.historyEnabled) {
        if (telemetry.historyDelay) await new Promise((resolve) => setTimeout(resolve, telemetry.historyDelay))
        if (args.request?.beforeSeq === 12) return ok({ records: [invisibleEvent(11)], hasMore: true })
        return ok({ records: [userMessage('early-prompt', 'An earlier prompt from this Host', 8)], hasMore: false })
      }
      if (endpoint === 'workspaceFiles/list') return ok({ entries: telemetry.workspaceFiles.map((name) => ({ name, type: 'file' })) })
      const docPath = typeof args.path === 'string' && /\.(pdf|docx)$/u.test(args.path) ? args.path : undefined
      if (docPath !== undefined) {
        const source = { absolutePath: '/project/' + docPath, version: 'document-v1' }
        if (endpoint === 'workspaceFiles/stat') return ok({ ...source, bytes: documentFixture.length })
        if (endpoint === 'workspaceFiles/readBytes') return ok({ ...source, data: btoa(documentFixture),
          eof: true, offset: 0, bytes: documentFixture.length })
        if (endpoint === 'officeToPdf/render') return ok({ ...source, generation: 'fixture-1', data: btoa(documentFixture),
          bytes: documentFixture.length, eof: true, offset: 0, missingFonts: ['Fixture Sans'] })
      }
      if (endpoint === 'officeToPdf/generation') return ok('fixture-1')
      if (endpoint === 'workspaceFiles/readBytes') {
        return ok({ data: btoa(telemetry.workspaceText), eof: true, offset: 0, absolutePath: '/project/after.txt' })
      }
      if (endpoint === 'messageFeedback/list') return ok({ items: feedback ? [feedback] : [] })
      if (endpoint === 'messageFeedback/put' && args.request?.sessionId === 'qa-a' && args.request.messageId === 'fixture-feedback-reply') {
        feedback = { messageId: args.request.messageId, rating: args.request.rating ?? 'positive', version: 'fixture-revision-2' }
        return ok(feedback)
      }
      if (endpoint === 'messageFeedback/delete') {
        feedback = undefined
        return ok()
      }
      if (endpoint === 'skills/list') return ok({ skills: [{ name: 'fixture-skill', description: 'Fixture helper' }] })
      if (endpoint === 'fileReferences/list') return ok([{ kind: 'file', path: 'notes with spaces.md' }])
      if (endpoint === 'sessionReferenceResolver/candidates') return ok([
        { sessionId: 'qa-b', label: 'Fixture conversation', mention: '@[Fixture conversation](dsh-session:InFhLWIi)' },
      ])
      if (endpoint === 'session/projections') return ok({ values: { goal: { goal: goals.get(args.request?.sessionId ?? '') } } })
      if (endpoint.endsWith('/create') && endpoint.startsWith('goals/') && args.agentId) {
        const goal = { id: 'fixture-goal', revision: 1, objective: args.request?.objective ?? '',
          phase: 'active', maxGoalRounds: args.request?.maxGoalRounds }
        goals.set(args.agentId, goal)
        return ok({ ref: { id: goal.id, revision: goal.revision } })
      }
      if (endpoint === 'goals/pause' && args.agentId) {
        const goal = goals.get(args.agentId)
        if (goal) {
          ++goal.revision
          goal.phase = 'paused'
          return ok(goal)
        }
      }
      if (endpoint === 'session/create') {
        const sessionId = 'qa-created-' + sessions.length
        if (telemetry.createDelay) await new Promise((resolve) => setTimeout(resolve, telemetry.createDelay))
        const row = { sessionId, title: 'New fixture session', updatedAt: Date.now() }
        sessions.push(row)
        createdSessions.push(row)
        localStorage.setItem(savedSessionsKey, JSON.stringify(createdSessions))
        return ok({ sessionId })
      }
      if (endpoint === 'fileUploads/upload') {
        if (args.request?.name === telemetry.slowUpload) {
          await new Promise((resolve) => setTimeout(resolve, 1400))
        }
        if (args.request?.name === telemetry.failingUpload) {
          return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Fixture upload rejection' } } as T
        }
        return ok({ receiptId: args.agentId + ':' + args.request?.name })
      }
      if (endpoint === 'session/prompt' && args.request?.sessionId && args.request.requestId) {
        const request = args.request
        if (telemetry.sendOutcome === 'reject') return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Fixture rejection' } } as T
        if (telemetry.sendOutcome !== 'timeout') {
          const event = { type: 'event', event: { type: 'user/message', seq: ++eventSeq, time: Date.now(),
            data: { message: { id: request.requestId, source: { kind: 'user', rpcId: request.requestId }, content: request.content } } } }
          echoes.set(request.sessionId!, [...(echoes.get(request.sessionId!) ?? []), event])
          for (const [id, stream] of streamMap) {
            if (stream.endpoint === 'session/follow' && stream.args.sessionId === request.sessionId) frame(id, event)
          }
          if (telemetry.voiceReply) {
            const sessionId = request.sessionId!
            const emitReply = (type: string, data?: object) => {
              const item = { type: 'event', event: { type, seq: ++eventSeq, time: Date.now(), data } }
              echoes.set(sessionId, [...(echoes.get(sessionId) ?? []), item])
              for (const [id, stream] of streamMap) {
                if (stream.endpoint === 'session/follow' && stream.args.sessionId === sessionId) frame(id, item)
              }
            }
            setTimeout(() => {
              const message = (id: string, text: string) =>
                emitReply('assistant/message', { message: { id, content: [{ type: 'text', text }] } })
              const finish = () => {
                message('fixture-voice-reply', 'Only this call gets this reply')
                emitReply('turn/end')
              }
              if (telemetry.voiceStream) {
                emitReply('turn/start', { turn: 1 })
                message('fixture-voice-first', 'I have a first sentence.')
                telemetry.finishVoice = finish
              } else finish()
            }, 50)
          }
        }
        if (telemetry.sendOutcome !== 'success') throw new RemoteLinkError('RPC_TIMEOUT', 'Fixture timeout')
        return ok()
      }
      if (endpoint === 'terminal/list') return ok([terminalInfo()])
      if (endpoint === 'terminal/shells') return ok([{ name: 'Fixture shell', path: '/mock/sh' }])
      if (endpoint === 'terminal/environment') return ok({ maxCols: 100, maxRows: 50 })
      if (endpoint === 'terminal/resize') return ok()
      if (endpoint === 'terminal/write') {
        for (const [id, stream] of streamMap) if (stream.endpoint === 'terminal/follow') {
          frame(id, { type: 'output', sequence: 2, data: args.data })
        }
        return ok()
      }
      if (endpoint === 'terminal/rename') {
        terminalTitle = args.title ?? terminalTitle
        return ok()
      }
      if (endpoint === 'job/kill') {
        job.status = 'killed'
        for (const [id, stream] of streamMap) {
          if (stream.endpoint === 'job/list') frame(id, { type: 'rows', jobs: [job] })
          if (stream.endpoint === 'job/follow') frame(id, { type: 'status', job })
        }
        return ok({ outcome: 'requested' })
      }
      if (endpoint === 'schedule/catalog') return ok(schedules)
      if (endpoint === 'schedule/create') {
        if (telemetry.scheduleCreateUnsupported) return { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: endpoint } } as T
        const task = { ...schedules[0]!, id: 'new-fixture-task',
          target: { kind: 'session', sessionId: args.request?.sessionId ?? '' }, title: args.request?.title ?? '',
          prompt: args.request?.prompt ?? '' }
        schedules.push(task)
        return ok(task)
      }
      if (endpoint === 'schedule/history') return ok({ records: [{ deliveredAt: '2026-11-20T10:30:00Z', prompt: 'Fixture delivery' }] })
      if (endpoint === 'schedule/run') return ok()
      if (endpoint === 'schedule/edit') {
        const task = schedules.find((row) => row.id === args.request?.id)
        if (!task || args.request?.expectedUpdatedAt !== task.updatedAt) return ok({ code: 'schedule_conflict' })
        if (args.request.action === 'delete') {
          schedules = schedules.filter((row) => row !== task)
          return ok({ deleted: true })
        }
        const { timing, ...changes } = args.request.patch ?? {}
        if (timing && typeof timing === 'object' && 'kind' in timing) Object.assign(task, { kind: timing.kind })
        Object.assign(task, changes)
        return ok(task)
      }
      if (endpoint === 'settings/describe') return ok({ writable: true, namespaces: sections })
      if (endpoint === 'settings/mutate') {
        const section = sections.find((row) => row.ns === args.ns)
        const op = args.ops?.[0]
        if (!section || !op || section.revision !== args.expectedRevision) {
          return ok({ ok: false, error: { code: 'settings/conflict' } })
        }
        if (section.value.providers && op.path.join('/') === 'providers/fixture-provider/displayName'
            && typeof op.value === 'string') {
          section.value.providers['fixture-provider'].displayName = op.value
        } else if (section.value.providers && op.path[2] === 'modelOverrides') {
          if (op.op === 'set' && op.path[3]) modelOverrides[op.path[3]] = op.value
          else if (op.path[3]) delete modelOverrides[op.path[3]]
          else modelOverrides = {}
          section.value.providers['fixture-provider'].modelOverrides = modelOverrides
          if ('providers' in section.user && section.user.providers) {
            section.user.providers['fixture-provider'].modelOverrides = modelOverrides
          }
        } else if (op.path.join('/') === 'enabled' && typeof op.value === 'boolean') {
          section.value.enabled = op.value
        }
        ++section.revision
        return ok({ ok: true, value: section })
      }
      if (endpoint === 'llm/listConfigurableProviders') return ok([
        { provider: 'fixture-provider', displayName: 'Fixture provider', settingsNs: 'llm-pi-ai' },
        { provider: 'other-adapter', displayName: 'Other adapter', settingsNs: 'llm-other' },
      ])
      if (endpoint === 'llm/discoverModels') return ok([{ id: 'discovered-model' }])
      if (endpoint === 'credentials/describe') return ok({
        FIXTURE_API_KEY: { configured: credentialConfigured, writable: true },
      })
      if (endpoint === 'credentials/set' || endpoint === 'credentials/unset') {
        credentialConfigured = endpoint === 'credentials/set'
        return ok()
      }
      return { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: endpoint } } as T
    },
    async openStream(endpoint, payload) {
      const args = (payload as { args?: Args }).args ?? {}
      const id = 'fixture-' + ++counter
      streamMap.set(id, { endpoint, args })
      if (endpoint === 'workspace/follow') {
        telemetry.emitWorkspace = (value) => { if (streamMap.has(id)) frame(id, value) }
      }
      if (endpoint === 'workspaceFiles/changes') {
        telemetry.calls.push({ endpoint, args })
        telemetry.emitWorkspaceFile = (path, value) => {
          for (const [streamId, entry] of streamMap) {
            if (entry.endpoint === endpoint && entry.args.path === path) frame(streamId, value)
          }
        }
      }
      setTimeout(() => {
        if (!streamMap.has(id)) return
        if (endpoint === '$events') frame(id, { type: 'ready', clientId: 'fixture-client' })
        if (endpoint === 'workspaceFiles/changes') frame(id, { kind: 'ready' })
        if (endpoint === 'session/follow') {
          const sessionId = args.request?.address?.sessionId ?? 'unknown'
          streamMap.set(id, { endpoint, args: { sessionId } })
          const history = echoes.get(sessionId) ?? []
          const records = telemetry.showFeedbackReply && sessionId === 'qa-a' ? [...history, {
            type: 'event', event: { type: 'assistant/message', seq: ++eventSeq, time: Date.now(),
              data: { message: { id: 'fixture-feedback-reply', content: [{ type: 'text', text: 'Fixture reply with feedback\n\nAPI_KEY=test-secret-do-not-share' }] } } },
          }] : history
          const historyFixture = telemetry.historyEnabled && sessionId === 'qa-b'
          const firstPrompt = telemetry.forkFixture && sessionId === 'qa-a'
          frame(id, {
            type: 'snapshot', header: { sessionId, version: 3 }, cursor: historyFixture ? 13 : firstPrompt ? 8 : eventSeq,
            hasMore: historyFixture,
            records: historyFixture ? [invisibleEvent(12), userMessage('unanswered-prompt', 'Recover this older unanswered text', 13)]
              : firstPrompt ? [userMessage('first-prompt', 'Keep this first turn as a draft', 8)] : records,
          })
        }
        if (endpoint === 'terminal/follow') frame(id, { type: 'snapshot', sequence: 1, screen: 'fixture terminal output', info: terminalInfo(args.attachmentId) })
        if (endpoint === 'job/list') frame(id, { type: 'rows', jobs: [job] })
        if (endpoint === 'job/follow') {
          frame(id, { type: 'opened', job })
          frame(id, { type: 'output', chunks: [{ text: 'fixture job output', channel: 'stdout' }] })
        }
      }, 15)
      return { streamId: id, close: async () => { streamMap.delete(id); telemetry.closed.push(endpoint) } }
    },
    close() { state = 'closed'; options.onState?.('closed') },
  }
}
