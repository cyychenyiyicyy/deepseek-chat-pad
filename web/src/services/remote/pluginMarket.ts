import { apiFetch } from '../api/transport.js'
import { RemoteApiError } from './serverApi.js'

const MARKET_BASES = [
  'https://dl.dshtui.com/market/',
  'https://go.dshtui.com/market/',
  'https://ccch1mneyyy.github.io/dsh-go-market/',
]
const SUPPORTED_MARKET_APP_VERSION = [1n, 3n, 0n]
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[\w.-]+)?(?:\+[\w.-]+)?$/u
const INTEGRITY = /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/u
const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'
const HIGH_FLAGS = ['install-scripts', 'native-code']
const MEDIUM_FLAGS = ['shell', 'filesystem', 'obfuscated']

export interface MarketPackage {
  name: string
  version: string
  title: string
  summary: string
  category: string
  tier: 'official' | 'community' | 'unlisted'
  risk: 'low' | 'medium' | 'high' | 'unverified'
  flags: string[]
  blocked: string[]
  spec?: string
  registry?: string
  integrity?: string
  requiresApp?: string
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

const string = (value: unknown) => typeof value === 'string' ? value.trim() : ''
const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
const localized = (value: unknown, locale: string) => {
  const labels = record(value)
  return string(value) || string(labels[locale]) || string(labels[locale.slice(0, 2)]) || string(labels.en) || string(labels.zh)
}

function isNewerAppVersion(version: string): boolean {
  if (!VERSION.test(version)) return false
  const current = version.split(/[-+]/u, 1)[0].split('.').map((part) => BigInt(part))
  const difference = current.findIndex((part, index) => part !== SUPPORTED_MARKET_APP_VERSION[index])
  return difference >= 0 && current[difference] > SUPPORTED_MARKET_APP_VERSION[difference]
}

async function marketJson(url: string, signal: AbortSignal, optional = false): Promise<unknown> {
  const response = await apiFetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) })
  if (response.status === 404 && optional) return null
  if (!response.ok) throw new RemoteApiError('MARKET_UNAVAILABLE', 'The plugin catalog is unavailable.', response.status)
  if (Number(response.headers.get('content-length')) > 4 * 1024 * 1024) throw invalidCatalog()
  const body = await response.text()
  if (body.length > 4 * 1024 * 1024) throw invalidCatalog()
  return JSON.parse(body)
}

export async function fetchPluginMarket(locale: string, signal: AbortSignal): Promise<MarketPackage[]> {
  let error: unknown
  for (const base of MARKET_BASES) {
    try {
      const [index, safety] = await Promise.all([
        marketJson(base + 'index.json', signal),
        marketJson(base + 'dsh-go.json', signal, true),
      ])
      return parsePluginMarket(index, safety, locale)
    } catch (failure) {
      signal.throwIfAborted()
      error = failure
    }
  }
  throw error
}

export function parsePluginMarket(index: unknown, sidecar: unknown, locale: string): MarketPackage[] {
  const root = record(index)
  const side = record(sidecar)
  if (root.format !== 1 || !Array.isArray(root.plugins)) throw invalidCatalog()
  const listings = side.schema === 1 ? record(side.plugins) : {}
  const categories = record(record(root.metadata).categories)
  const seen = new Set<string>()
  return root.plugins.slice(0, 2000).flatMap((raw: unknown) => {
    const entry = record(raw)
    const name = string(entry.name)
    if (name.length > 214 || !PACKAGE.test(name) || seen.has(name) || !Array.isArray(entry.versions)) return []
    seen.add(name)
    const listing = record(Object.hasOwn(listings, name) ? listings[name] : undefined)
    const pinned = string(listing.version)
    const candidates = entry.versions.map(record).filter((value) => VERSION.test(string(value.version)))
    if (!candidates.length) return []
    const versionEntry = candidates.find((value) => value.version === pinned) ?? candidates[0]
    const version = String(versionEntry.version)
    const blocked = strings(listing.blockedVersions)
    const tier = version === pinned && (listing.tier === 'official' || listing.tier === 'community') ? listing.tier : 'unlisted'
    const safety = record(listing.risk)
    const flags = strings(safety.flags)
    let risk: MarketPackage['risk'] = 'unverified'
    if (tier !== 'unlisted' && Array.isArray(safety.flags) && flags.length === safety.flags.length) {
      if (safety.level === 'high' || flags.some((flag) => HIGH_FLAGS.includes(flag))) risk = 'high'
      else if (safety.level === 'medium' || flags.some((flag) => MEDIUM_FLAGS.includes(flag))) risk = 'medium'
      else if (safety.level === 'low') risk = 'low'
    }
    const category = string(record(entry.metadata).category)
    const categoryMeta = record(Object.hasOwn(categories, category) ? categories[category] : undefined)
    const requiresApp = string(record(listing.dshGo).minApp)
    const integrity = string(listing.integrity)
    const row: MarketPackage = {
      name, version, tier, risk, flags, blocked,
      title: localized(listing.title, locale) || localized(entry.title, locale) || name,
      summary: localized(listing.summary, locale) || localized(entry.description, locale),
      category: localized(categoryMeta.title, locale),
      ...(isNewerAppVersion(requiresApp) ? { requiresApp } : {}),
    }
    const source = record(versionEntry.source)
    if (risk !== 'unverified' && !blocked.includes(version) && !row.requiresApp &&
        (!requiresApp || VERSION.test(requiresApp))) {
      if (source.type === 'npm' && (source.registry === undefined || safeRegistry(source.registry))) {
        row.spec = name + '@' + version
        row.registry = safeRegistry(source.registry)
        if (INTEGRITY.test(integrity)) row.integrity = integrity
      } else if (source.type === 'git') {
        row.spec = gitSpec(source)
      }
    }
    return [row]
  })
}

function safeRegistry(raw: unknown): string | undefined {
  const url = safeHttps(raw)
  return url && (url.pathname.endsWith('/') ? url.href : url.href + '/')
}

function safeHttps(raw: unknown): URL | undefined {
  try {
    const url = new URL(string(raw))
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search ? url : undefined
  } catch { return undefined }
}

function gitSpec(source: Record<string, unknown>): string | undefined {
  const url = safeHttps(source.url)
  const commit = string(source.commit)
  const path = string(source.path)
  if (!url || !/^[0-9a-f]{40}$/iu.test(commit) || url.pathname.split('/').filter(Boolean).length < 2 ||
      /\.(?:tgz|tar\.gz)$/iu.test(url.pathname) ||
      (source.path !== undefined && (!path || !path.split('/').every((segment) =>
        /^[A-Za-z0-9_.-]+$/u.test(segment) && segment !== '.' && segment !== '..')))) return undefined
  const repo = url.href.replace(/\/$/u, '')
  return 'git+' + (repo.endsWith('.git') ? repo : repo + '.git') + '#' + commit + (path ? '&path:/' + path : '')
}

export async function verifyPluginIntegrity(item: MarketPackage, signal: AbortSignal): Promise<void> {
  if (!item.integrity) return
  const registry = item.registry ?? DEFAULT_REGISTRY
  const url = new URL(encodeURIComponent(item.name) + '/' + encodeURIComponent(item.version), registry)
  const metadata = record(await marketJson(url.href, signal))
  if (record(metadata.dist).integrity !== item.integrity) {
    throw new RemoteApiError('PLUGIN_INTEGRITY_MISMATCH', 'The package checksum differs from the plugin catalog.')
  }
}

function invalidCatalog() {
  return new RemoteApiError('INVALID_MESSAGE', 'The plugin catalog has an unsupported format.')
}
