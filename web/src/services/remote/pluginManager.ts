import { RemoteApiError } from './serverApi.js'
import type { HostHttpTarget } from './hostHttpActions.js'
import type { MarketPackage } from './pluginMarket.js'
import { callEndpoint, lastRemoteTarget, type RemoteCallTarget } from './sessionsApi.js'

export interface HostPlugin {
  kind: 'bundle' | 'plugin'
  id: string
  label: string
  enabled: boolean
  readOnly: boolean
  version?: string
  removable?: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isRemoteTransport = (value: unknown): boolean =>
  typeof value === 'string' && /^(ds-harness-remote|dsh-remote)(\/|$)/.test(value)

export function relayPluginInstallCommand(item: MarketPackage): string | undefined {
  if (!item.spec || isRemoteTransport(item.name)) return undefined
  // Support common Host shells and keep URL fragments and ampersands inside a single argument.
  if (!/^[a-z0-9@.\/_:+#&-]+$/iu.test(item.spec)) return undefined
  return 'dsh plugin --profile web add "' + item.spec + '"'
}

export function relayPluginRemoveCommand(plugin: HostPlugin): string | undefined {
  if (plugin.kind !== 'bundle' || !plugin.removable || isRemoteTransport(plugin.id) ||
      !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu.test(plugin.id)) return undefined
  return 'dsh plugin --profile web remove ' + plugin.id
}

function parsePlugin(value: unknown, kind: HostPlugin['kind']): HostPlugin[] {
  if (!isRecord(value)) return []
  const id = kind === 'bundle' ? value.name : value.entryId
  if (typeof id !== 'string' || id.length === 0 || id.length > 4096) return []
  if (isRemoteTransport(id) || isRemoteTransport(value.moduleName)) return []
  if (kind === 'bundle' && Array.isArray(value.rows)
    && value.rows.some((row) => isRecord(row) && isRemoteTransport(row.moduleName))) return []
  return [{
    kind,
    id,
    label: typeof value.moduleName === 'string' && value.moduleName ? value.moduleName : id,
    enabled: value.enabled === true,
    readOnly: value.readOnlyReason !== undefined || value.availability === 'missing' || typeof value.enabled !== 'boolean',
    version: typeof value.version === 'string' ? value.version : undefined,
    removable: kind === 'bundle' && value.removable === true,
  }]
}

function assertCurrent(target: RemoteCallTarget) {
  if (lastRemoteTarget() !== target) {
    throw new RemoteApiError('PEER_OFFLINE', 'The originating Host connection closed.')
  }
}

export async function listHostPlugins(target: RemoteCallTarget): Promise<HostPlugin[]> {
  assertCurrent(target)
  const [bundles, plugins] = await Promise.all([
    callEndpoint<unknown>(target, 'pluginManager/listBundles', {}),
    callEndpoint<unknown>(target, 'pluginManager/listPlugins', {}),
  ])
  assertCurrent(target)
  if (!Array.isArray(bundles) || !Array.isArray(plugins)) {
    throw new RemoteApiError('INVALID_MESSAGE', 'The Host returned an invalid plugin inventory.')
  }
  return [...bundles.flatMap((row) => parsePlugin(row, 'bundle')), ...plugins.flatMap((row) => parsePlugin(row, 'plugin'))]
}

export async function setHostPluginEnabled(target: RemoteCallTarget, plugin: HostPlugin, enabled: boolean) {
  assertCurrent(target)
  if (plugin.readOnly || isRemoteTransport(plugin.id) || isRemoteTransport(plugin.label)) {
    throw new RemoteApiError('PERMISSION_DENIED', 'This plugin is managed on the Host.')
  }
  const result = plugin.kind === 'bundle'
    ? await callEndpoint<unknown>(target, 'pluginManager/setBundleEnabled', { name: plugin.id, enabled })
    : await callEndpoint<unknown>(target, 'pluginManager/setPluginEnabled', { id: plugin.id, enabled })
  assertCurrent(target)
  return parseOperation(result)
}

const MANAGER_TIMEOUT = 300_000

async function hostManagerCall(target: HostHttpTarget, method: string, args: Record<string, unknown>) {
  assertCurrent(target)
  const result = await callEndpoint<unknown>(target, 'pluginManager/' + method, args, MANAGER_TIMEOUT)
  assertCurrent(target)
  return result
}

export async function installHostPlugin(target: HostHttpTarget, item: MarketPackage, requestId: string, approvedBuilds?: string[]) {
  if (!item.spec || isRemoteTransport(item.name)) {
    throw new RemoteApiError('PERMISSION_DENIED', 'This package is unavailable for installation.')
  }
  return parseInstall(await hostManagerCall(target, 'installBundle', {
    spec: item.spec,
    options: { requestId, enabled: true, saveExact: true,
      ...(item.registry ? { registry: item.registry } : {}),
      ...(approvedBuilds?.length ? { approvedBuilds } : {}) },
  }))
}

export async function recoverHostPluginInstall(target: HostHttpTarget, requestId: string) {
  const result = await hostManagerCall(target, 'waitForInstall', { requestId })
  return result === null ? null : parseInstall(result)
}

export async function cancelHostPluginInstall(target: HostHttpTarget, requestId: string) {
  const result = await hostManagerCall(target, 'cancelInstall', { requestId })
  if (isRecord(result) && ['cancelled', 'too-late', 'not-running'].includes(String(result.status))) return String(result.status)
  throw new RemoteApiError('INVALID_MESSAGE', 'The Host did not confirm cancellation.')
}

export async function removeHostPlugin(target: HostHttpTarget, plugin: HostPlugin) {
  if (plugin.kind !== 'bundle' || !plugin.removable || isRemoteTransport(plugin.id)) {
    throw new RemoteApiError('PERMISSION_DENIED', 'This package cannot be removed here.')
  }
  return parseOperation(await hostManagerCall(target, 'removeBundle', { name: plugin.id }))
}

export class HostPluginBuildsRequired extends Error {
  constructor(readonly packages: string[]) {
    super('The Host requested approval to run dependency build scripts.')
  }
}

export class HostPluginOperationError extends RemoteApiError {}

function parseInstall(result: unknown) {
  if (isRecord(result) && result.application === 'failed' && Array.isArray(result.pendingBuilds)) {
    const packages = result.pendingBuilds
    if (packages.length > 0 && packages.length <= 200 && packages.every((name) =>
      typeof name === 'string' && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu.test(name))) {
      throw new HostPluginBuildsRequired([...new Set<string>(packages)])
    }
  }
  return parseOperation(result)
}

function parseOperation(result: unknown): string {
  if (!isRecord(result) || typeof result.application !== 'string' || !result.application) {
    throw new RemoteApiError('INVALID_MESSAGE', 'The Host returned an invalid plugin change result.')
  }
  if (result.application === 'failed') {
    const failure = isRecord(result.error) ? result.error : {}
    throw new HostPluginOperationError(
      typeof failure.code === 'string' ? failure.code : 'UNKNOWN_ERROR',
      typeof failure.diagnostic === 'string' && failure.diagnostic ? failure.diagnostic : 'The Host could not change the plugin.',
    )
  }
  return result.application
}
