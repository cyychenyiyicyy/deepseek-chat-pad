import { RemoteApiError } from './serverApi.js'
import { callEndpoint, lastRemoteTarget, newRequestId, type RemoteCallTarget } from './sessionsApi.js'

export const TERMINAL_CAPABILITY = 'harness.terminal.v1'

export interface TerminalScope {
  target: RemoteCallTarget
  sessionId: string
  current(): boolean
}

export interface TerminalInfo {
  id: string
  title: string
  cwd: string
  cols: number
  rows: number
  state: 'running' | 'exited' | 'failed'
}

export type TerminalFrame =
  | { kind: 'snapshot'; info: TerminalInfo; sequence: number; screen: string; controllerId?: string }
  | { kind: 'output'; sequence: number; data: string }
  | { kind: 'state'; info: TerminalInfo; controllerId?: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function size(value: unknown, fallback: number, maximum: number) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback
}

function parseInfo(value: unknown): TerminalInfo | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) return undefined
  const shell = isRecord(value.shell) && typeof value.shell.name === 'string' ? value.shell.name : ''
  return {
    id: value.id,
    title: typeof value.title === 'string' && value.title.trim() ? value.title : shell || value.id,
    cwd: typeof value.cwd === 'string' ? value.cwd : '',
    cols: size(value.cols, 80, 500),
    rows: size(value.rows, 24, 200),
    state: value.state === 'exited' || value.state === 'failed' ? value.state : 'running',
  }
}

export function readTerminalFrame(value: unknown): TerminalFrame | undefined {
  if (!isRecord(value)) return undefined
  const sequence = typeof value.sequence === 'number' && Number.isSafeInteger(value.sequence) && value.sequence >= 0
    ? value.sequence : undefined
  if (value.type === 'output' && sequence !== undefined && typeof value.data === 'string') {
    return { kind: 'output', sequence, data: value.data }
  }
  if (value.type !== 'snapshot' && value.type !== 'state') return undefined
  const info = parseInfo(value.info)
  if (!info || !isRecord(value.info)) return undefined
  const controllerId = typeof value.info.controllerId === 'string' ? value.info.controllerId : undefined
  if (value.type === 'state') return { kind: 'state', info, controllerId }
  return sequence !== undefined && typeof value.screen === 'string'
    ? { kind: 'snapshot', info, sequence, screen: value.screen, controllerId } : undefined
}

export function currentTerminal(scope: TerminalScope) {
  return lastRemoteTarget() === scope.target && scope.current()
}

function checkScope(scope: TerminalScope) {
  if (!currentTerminal(scope)) throw new RemoteApiError('RPC_ABORTED', 'The terminal session has changed.')
}

async function callTerminal<T>(scope: TerminalScope, operation: string, args: Record<string, unknown>) {
  checkScope(scope)
  const result = await callEndpoint<T>(scope.target, `terminal/${operation}`, args)
  checkScope(scope)
  return result
}

export async function loadTerminalInventory(scope: TerminalScope) {
  const [terminals, shells, environment] = await Promise.all([
    callTerminal<unknown>(scope, 'list', { sessionId: scope.sessionId }),
    callTerminal<unknown>(scope, 'shells', { agentId: scope.sessionId }),
    callTerminal<unknown>(scope, 'environment', { agentId: scope.sessionId }),
  ])
  if (!Array.isArray(terminals) || !Array.isArray(shells)) {
    throw new RemoteApiError('INVALID_MESSAGE', 'The Host returned an invalid terminal inventory.')
  }
  const limits = isRecord(environment) ? environment : {}
  return {
    terminals: terminals.flatMap((item) => {
      const parsed = parseInfo(item)
      return parsed ? [parsed] : []
    }),
    shells: shells.flatMap((shell) => isRecord(shell) && typeof shell.path === 'string' && shell.path
      ? [{ path: shell.path, name: typeof shell.name === 'string' ? shell.name : shell.path }] : []),
    environment: {
      cwd: typeof limits.cwd === 'string' ? limits.cwd : '',
      maxCols: size(limits.maxCols, 500, 500),
      maxRows: size(limits.maxRows, 200, 200),
      maxInputBytes: size(limits.maxInputBytes, 65_536, 65_536),
      scrollback: size(limits.scrollback, 1000, 10_000),
    },
  }
}

export async function createTerminal(scope: TerminalScope, shellPath: string, id = newRequestId()) {
  const result = await callTerminal<unknown>(scope, 'create', {
    agentId: scope.sessionId,
    request: { id, cols: 80, rows: 24, ...(shellPath ? { shellPath } : {}) },
  })
  const info = parseInfo(result)
  if (info?.id !== id) throw new RemoteApiError('INVALID_MESSAGE', 'The Host returned the wrong terminal.')
  return info
}

export function renameTerminal(scope: TerminalScope, id: string, title: string) {
  return callTerminal(scope, 'rename', { agentId: scope.sessionId, id, title })
}

export function closeTerminal(scope: TerminalScope, id: string) {
  return callTerminal(scope, 'close', { agentId: scope.sessionId, id })
}

export function attachTerminal(scope: TerminalScope, id: string) {
  checkScope(scope)
  const attachmentId = newRequestId()
  const address = { agentId: scope.sessionId, id, attachmentId }
  return {
    attachmentId,
    stream: scope.target.openStream('terminal/follow', { args: address }),
    write: (data: string) => callTerminal(scope, 'write', { ...address, data }),
    resize: (cols: number, rows: number) => callTerminal(scope, 'resize', { ...address, cols, rows }),
  }
}

export function retainTerminal(scope: TerminalScope, id: string) {
  checkScope(scope)
  return scope.target.openStream('terminal/retain', { args: { sessionId: scope.sessionId, id } })
}
