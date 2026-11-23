import { httpFailure } from './core/httpLink.js'
import type { HostHttpTarget } from './hostHttpActions.js'
import type { HostSettingsSection, SettingsOperation } from './hostSettings.js'
import { RemoteApiError } from './serverApi.js'
import { lastRemoteTarget } from './sessionsApi.js'

const PATH = '/dsh-go/v1/plugin-config'
const validKey = (value: unknown): value is string => typeof value === 'string' && value.length > 0 &&
  value.length <= 512 && !['.', '..', '__proto__', 'constructor', 'prototype'].includes(value) && !/[\x00-\x1f\x7f]/u.test(value)

export interface PluginConfigSummary {
  entryId: string
  label: string
  configurable: boolean
}

export interface PluginConfig extends Omit<HostSettingsSection, 'revision'> {
  revision: string
  secrets: Array<{ path: string[]; configured: boolean; credentialRef?: string; writable: boolean }>
}

export async function listPluginConfig(target: HostHttpTarget, locale: string): Promise<PluginConfigSummary[] | null> {
  const response = await request(target, PATH, { method: 'GET' })
  const reply = await response.json().catch(() => null)
  if (response.status === 404 && !errorCode(reply)) return null
  if (!response.ok) throw configError(response, reply)
  const rows = Array.isArray(reply) ? reply : record(reply).entries
  if (!Array.isArray(rows)) throw invalid()
  return rows.slice(0, 1000).flatMap((row: unknown) => {
    const entry = record(row)
    if (!validKey(entry.entryId) || /^(?:dsh-remote|ds-harness-remote)(?:$|[/.:])/u.test(entry.entryId)) return []
    const labels = record(entry.label)
    const label = typeof entry.label === 'string' ? entry.label : labels[locale] ?? labels[locale.slice(0, 2)] ?? labels.en
    return [{ entryId: entry.entryId, label: typeof label === 'string' && label ? label : entry.entryId, configurable: entry.configurable === true }]
  })
}

export async function readPluginConfig(target: HostHttpTarget, id: string): Promise<PluginConfig> {
  return parse(await json(await request(target, entryPath(id), { method: 'GET' })), id)
}

export async function writePluginConfig(target: HostHttpTarget, entry: PluginConfig, ops: SettingsOperation[]): Promise<PluginConfig> {
  const secretPath = (path: string[]) => entry.secrets.some((secret) =>
    path.slice(0, Math.min(path.length, secret.path.length)).every((part, index) => part === secret.path[index]))
  if (!entry.writable || !ops.length || ops.some(({ path }) => !path.length || !path.every(validKey) || secretPath(path))) {
    throw new RemoteApiError('PERMISSION_DENIED', 'This plugin setting cannot be changed here.')
  }
  const response = await request(target, entryPath(entry.ns), {
    method: 'POST', body: JSON.stringify({ revision: entry.revision, ops }),
  }, 60_000)
  return parse(await json(response), entry.ns)
}

function entryPath(id: string): string {
  if (!validKey(id) || /^(?:dsh-remote|ds-harness-remote)(?:$|[/.:])/u.test(id)) throw invalid()
  return PATH + '/' + encodeURIComponent(id)
}

async function request(target: HostHttpTarget, path: string, init: RequestInit, timeout = 10_000) {
  if (lastRemoteTarget() !== target) throw new RemoteApiError('RPC_ABORTED', 'The Host connection changed.')
  const response = await target.request(path, init, timeout)
  if (lastRemoteTarget() !== target) throw new RemoteApiError('RPC_ABORTED', 'The Host connection changed.')
  return response
}

async function json(response: Response): Promise<unknown> {
  const data = await response.json().catch(() => null)
  if (!response.ok) throw configError(response, data)
  return data
}

function errorCode(data: unknown): string | undefined {
  const { code } = record(record(data).error ?? data)
  return typeof code === 'string' && /^[a-z-]{1,80}$/u.test(code) ? code : undefined
}

function configError(response: Response, data: unknown) {
  const code = errorCode(data)
  return code ? new RemoteApiError('plugin-config/' + code, code, response.status) : httpFailure(response.status)
}

function parse(data: unknown, id: string): PluginConfig {
  const payload = record(data)
  const entry = record(payload.entry ?? payload)
  if (entry.entryId !== id || entry.v !== 1 || typeof entry.revision !== 'string' || !entry.revision ||
    Object.keys(record(entry.schema)).length === 0) throw invalid()
  const secrets = Array.isArray(entry.secrets) ? entry.secrets.slice(0, 1000).flatMap((value: unknown) => {
    const slot = record(value)
    if (!Array.isArray(slot.path) || !slot.path.length || !slot.path.every(validKey)) return []
    const ref = slot.credentialRef ?? slot.ref ?? record(slot.binding).ref
    return [{ path: slot.path as string[], configured: slot.configured === true || slot.set === true,
      credentialRef: typeof ref === 'string' ? ref : undefined, writable: typeof ref === 'string' && slot.writable !== false }]
  }) : []
  return { ns: id, revision: entry.revision, writable: entry.writable === true, schema: entry.schema,
    value: record(entry.value), user: record(entry.user), secrets }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function invalid() {
  return new RemoteApiError('INVALID_MESSAGE', 'The Host returned invalid plugin configuration.')
}
