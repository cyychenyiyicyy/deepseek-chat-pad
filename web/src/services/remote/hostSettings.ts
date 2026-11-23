import { RemoteApiError } from './serverApi.js'
import { callEndpoint, describeRemoteError, lastRemoteTarget, type RemoteCallTarget } from './sessionsApi.js'

export interface HostSettingsSection {
  ns: string
  revision: number
  writable: boolean
  schema: unknown
  value: Record<string, unknown>
  user: Record<string, unknown>
  secrets: Array<{ path: string[]; configured: boolean }>
}

export type SettingsOperation = { op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] }
export type SettingType = 'text' | 'number' | 'boolean' | 'enum' | 'json' | 'secret'

export interface SettingField {
  path: string[]
  type: SettingType
  label: string
  description?: string
  options?: Array<string | number | boolean>
  readOnly: boolean
  value: unknown
  override: boolean
  configured: boolean
}

export interface HostModelRoute {
  route: string
  label: string
  api?: string
  baseURL?: string
  credentialRef: string
  override: boolean
  profile?: Record<string, unknown>
  modelOverrides: Record<string, unknown>
  ownedModelOverrides: string[]
}

export const validProviderRoute = (value: string) => /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(value)
export const validCredentialRef = (value: string) => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(value)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const record = (value: unknown) => isRecord(value) ? value : {}
const own = (value: unknown, key: string) => isRecord(value) && Object.hasOwn(value, key) ? value[key] : undefined
const string = (value: unknown) => typeof value === 'string' && value.trim() ? value : undefined
const safeKey = (key: string) => key.length > 0 && key !== '__proto__' && key !== 'constructor' && key !== 'prototype'
const pathsEqual = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((part, i) => part === b[i])
const pathStartsWith = (path: readonly string[], parent: readonly string[]) => parent.every((part, i) => part === path[i])

function parseSection(value: unknown, writable: boolean): HostSettingsSection | undefined {
  if (!isRecord(value) || typeof value.ns !== 'string' || !safeKey(value.ns) ||
      typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision)) return undefined
  const ns = value.ns
  if (/^(?:dsh-remote|ds-harness-remote)(?:$|\/)/u.test(ns)) return undefined
  const slots = Array.isArray(value.secrets) ? value.secrets : []
  return {
    ns, revision: value.revision, writable: writable && value.writable !== false, schema: value.schema,
    value: record(value.value), user: record(value.user),
    secrets: slots.flatMap((slot) => isRecord(slot) && Array.isArray(slot.path) && slot.path.every((key) => typeof key === 'string')
      ? [{ path: slot.path as string[], configured: slot.set === true || slot.configured === true }] : []),
  }
}

function assertCurrent(target: RemoteCallTarget) {
  if (lastRemoteTarget() !== target) throw new RemoteApiError('RPC_ABORTED', 'The originating Host connection closed.')
}

async function settingsCall(target: RemoteCallTarget, endpoint: string, args: Record<string, unknown> = {}) {
  assertCurrent(target)
  const value = await callEndpoint<unknown>(target, endpoint, args)
  assertCurrent(target)
  return value
}

export async function describeHostSettings(target: RemoteCallTarget) {
  const value = await settingsCall(target, 'settings/describe')
  if (!isRecord(value) || !Array.isArray(value.namespaces)) {
    throw new RemoteApiError('INVALID_MESSAGE', 'The Host did not return a settings catalog.')
  }
  return value.namespaces.flatMap((row) => parseSection(row, value.writable !== false) ?? [])
}

export async function mutateHostSettings(target: RemoteCallTarget, section: HostSettingsSection, ops: SettingsOperation[]) {
  if (!section.writable || !ops.length || ops.some(({ path }) => !path.length || !path.every(safeKey))) {
    throw new RemoteApiError('PERMISSION_DENIED', 'This setting is read-only.')
  }
  let result: unknown
  try {
    result = await settingsCall(target, 'settings/mutate', { ns: section.ns, ops, expectedRevision: section.revision })
  } catch (failure) {
    const { code } = describeRemoteError(failure)
    throw new RemoteApiError(code, code)
  }
  if (isRecord(result) && result.ok === false) {
    const code = string(record(result.error).code) ?? 'FAILED'
    throw new RemoteApiError(code, code)
  }
  const view = isRecord(result) && result.ok === true ? result.value : result
  const next = parseSection(view, section.writable)
  if (next?.ns !== section.ns) throw new RemoteApiError('INVALID_MESSAGE', 'The Host did not confirm this settings update.')
  return next
}

function localizedLabel(value: unknown, locale: string): string | undefined {
  if (typeof value === 'string') return string(value)
  const labels = record(value)
  return string(labels[locale]) ?? string(labels[locale.slice(0, 2)]) ?? string(labels.en) ?? string(labels.zh)
}

export function settingsFields(section: Omit<HostSettingsSection, 'revision'>, locale: string): SettingField[] {
  const root = record(section.schema)
  const refs = isRecord(root.refs) ? root.refs : undefined
  const read = (input: unknown) => refs ? record(own(refs, String(input))) : record(input)
  const fields: SettingField[] = []
  const start = refs ? root.uid : root
  function walk(raw: unknown, path: string[], value: unknown, user: unknown, seen: ReadonlySet<unknown>, disabled = false) {
    if (path.length > 12 || seen.has(raw) || fields.length >= 500) return
    const node = read(raw)
    const meta = record(node.meta)
    if (meta.hidden === true) return
    const branch = new Set([...seen, raw])
    const readOnly = disabled || meta.disabled === true
    if (node.type === 'lazy' || node.type === 'transform') {
      walk(node.inner, path, value, user, branch, readOnly)
      return
    }
    if (node.type === 'intersect' && Array.isArray(node.list)) {
      for (const child of node.list) walk(child, path, value, user, branch, readOnly)
      return
    }
    if (node.type === 'union' && Array.isArray(node.list) && isRecord(value)) {
      const candidates = node.list.filter((child) => {
        const candidate = read(child)
        if (candidate.type !== 'object') return false
        const constants = Object.entries(record(candidate.dict)).filter(([, field]) => read(field).type === 'const')
        return constants.length > 0 && constants.every(([key, field]) => Object.is(value[key], read(field).value))
      })
      if (candidates.length === 1) {
        walk(candidates[0], path, value, user, branch, readOnly)
        return
      }
    }
    if (node.type === 'object') {
      for (const [key, child] of Object.entries(record(node.dict))) {
        if (safeKey(key)) walk(child, [...path, key], own(value, key), own(user, key), branch, readOnly)
      }
      return
    }
    if (node.type === 'dict' && isRecord(value)) {
      for (const key of Object.keys(value)) {
        if (safeKey(key)) walk(node.inner, [...path, key], value[key], own(user, key), branch, readOnly)
      }
      return
    }
    if (!path.length || fields.some((field) => pathsEqual(field.path, path))) return
    const secret = section.secrets.find((slot) => pathsEqual(slot.path, path))
    const options = node.type === 'union' && Array.isArray(node.list)
      ? node.list.map(read).filter((item) => item.type !== 'const' || item.value !== null) : []
    const enumLike = options.length > 0 && options.every((item) => item.type === 'const' &&
      (typeof item.value === 'string' || typeof item.value === 'number' || typeof item.value === 'boolean'))
    let type: SettingType
    if (meta.role === 'secret' || secret) type = 'secret'
    else if (node.type === 'string') type = 'text'
    else if (node.type === 'number' || node.type === 'bitset') type = 'number'
    else if (node.type === 'boolean') type = 'boolean'
    else if (enumLike) type = 'enum'
    else if (options.length === 1 && options[0]?.type === 'string') type = 'text'
    else if (options.length === 1 && options[0]?.type === 'number') type = 'number'
    else if (options.length === 1 && options[0]?.type === 'boolean') type = 'boolean'
    else if (node.type === 'array' && ['number', 'string', 'boolean'].includes(String(read(node.inner).type))
      && !section.secrets.some((slot) => pathStartsWith(slot.path, path))) type = 'json'
    else return
    fields.push({
      path, type, value: type === 'secret' ? undefined : value, readOnly: !section.writable || readOnly,
      label: localizedLabel(meta.title, locale) ?? path.join(' › '),
      description: localizedLabel(meta.description, locale), override: user !== undefined,
      configured: secret?.configured === true,
      ...(enumLike ? { options: options.map((item) => item.value as string | number | boolean) } : {}),
    })
  }
  walk(start, [], section.value, section.user, new Set())
  return fields
}

export async function listHostModelRoutes(target: RemoteCallTarget, section?: HostSettingsSection): Promise<HostModelRoute[]> {
  const catalog = await settingsCall(target, 'llm/listConfigurableProviders').catch((error: unknown) => {
    const { code } = describeRemoteError(error)
    if (section && ['METHOD_NOT_FOUND', 'METHOD_NOT_ALLOWED', 'CAPABILITY_NOT_SUPPORTED', 'gateway/not-found'].includes(code)) return []
    throw error
  })
  if (!Array.isArray(catalog)) throw new RemoteApiError('INVALID_MESSAGE', 'The Host did not return a model provider list.')
  const declared = record(section?.value.providers)
  const overrides = record(section?.user.providers)
  const builtIn = new Map(catalog.filter(isRecord).flatMap((item) => {
    const route = string(item.route ?? item.provider ?? item.id)
    return route && validProviderRoute(route) && (!item.settingsNs || item.settingsNs === 'llm-pi-ai')
      ? [[route, item] as const] : []
  }))
  const ids = new Set([...Object.keys(declared).filter(validProviderRoute), ...builtIn.keys()])
  return [...ids].map((route) => {
    const profile = record(own(declared, route))
    const userProfile = own(overrides, route)
    const item = builtIn.get(route)
    return {
      route, label: string(profile.displayName) ?? string(item?.displayName ?? item?.label) ?? route,
      api: string(profile.api ?? item?.api), baseURL: string(profile.baseURL ?? item?.defaultBaseURL ?? item?.baseURL),
      credentialRef: [profile.apiKeyEnv, item?.credentialRef, item?.apiKeyEnv].find(
        (value): value is string => typeof value === 'string' && validCredentialRef(value),
      ) ?? route.toUpperCase().replaceAll('-', '_') + '_API_KEY',
      override: Object.hasOwn(overrides, route),
      profile: isRecord(own(declared, route)) ? profile : undefined,
      modelOverrides: record(profile.modelOverrides),
      ownedModelOverrides: Object.keys(record(own(userProfile, 'modelOverrides'))).filter(safeKey),
    }
  })
}

export async function describeHostCredential(target: RemoteCallTarget, ref: string) {
  if (!validCredentialRef(ref)) throw new RemoteApiError('INVALID_ARGUMENT', 'Invalid credential reference.')
  const value = await settingsCall(target, 'credentials/describe', { refs: [ref] })
  const entry = own(value, ref)
  if (!isRecord(entry)) throw new RemoteApiError('INVALID_MESSAGE', 'The Host did not return credential status.')
  return { configured: entry.configured === true, writable: entry.writable === true, source: string(entry.source) }
}

export async function setHostCredential(target: RemoteCallTarget, ref: string, value?: string) {
  if (!validCredentialRef(ref) || (value !== undefined && !value.trim())) {
    throw new RemoteApiError('INVALID_ARGUMENT', 'Invalid credential reference or value.')
  }
  try {
    await settingsCall(target, value === undefined ? 'credentials/unset' : 'credentials/set', value === undefined ? { ref } : { ref, value })
  } catch (failure) {
    const { code } = describeRemoteError(failure)
    throw new RemoteApiError(code, code)
  }
}

export async function discoverHostModels(target: RemoteCallTarget, provider: string) {
  if (!validProviderRoute(provider)) throw new RemoteApiError('INVALID_ARGUMENT', 'Invalid provider route.')
  const value = await settingsCall(target, 'llm/discoverModels', { settingsNs: 'llm-pi-ai', request: { provider } })
  if (!Array.isArray(value)) throw new RemoteApiError('INVALID_MESSAGE', 'The Host did not return model inventory.')
  return value.flatMap((item) => isRecord(item) && typeof item.id === 'string' ? [item.id] : [])
}
