/**
 * 从厂商端点拉模型列表，并用本地目录补全元信息。
 *
 * 流程正好对上用户的操作：
 *   填 Base URL + API Key → GET {base}/models 拿到模型 id → 本地目录里查元信息
 *   → 查不到的再去 models.dev 全量数据里找一次（按需触发，结果缓存 7 天）。
 */
import { listOpenAIModels } from '../api/openai.js'
import { apiFetch } from '../api/transport.js'
import {
  findModelMeta,
  loadCoreProviders,
  loadProviderDirectory,
  matchProvider,
  modelsUrl,
  type ModelMeta,
  type ProviderMeta,
} from './catalog.js'
import type { ModelEntry } from './store.js'

const INDEX_KEY = 'chat-demo:model-meta-index'
const INDEX_TTL = 7 * 24 * 60 * 60 * 1000

type MetaIndex = Record<string, { at: number; models: ModelEntry[] }>

const readIndex = (): MetaIndex => {
  try {
    return JSON.parse(localStorage.getItem(INDEX_KEY) ?? '{}') as MetaIndex
  } catch {
    return {}
  }
}

const writeIndex = (index: MetaIndex) => {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(index))
  } catch {
    // 容量不足时放弃缓存，不影响本次使用
  }
}

/** Anthropic 兼容端点的模型列表（GET /v1/models） */
const listAnthropicModels = async (url: string, apiKey: string, signal?: AbortSignal) => {
  const res = await apiFetch(url, {
    method: 'GET',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      Accept: 'application/json',
    },
    signal,
  })
  if (!res.ok) throw new Error((await res.text().catch(() => '')) || res.statusText)
  const body = (await res.json()) as { data?: { id?: string; display_name?: string }[] }
  return (body.data ?? [])
    .filter((m): m is { id: string; display_name?: string } => Boolean(m.id))
    .map((m) => ({ id: m.id, name: m.display_name || m.id }))
}

/** 端点自己的能力报告；它通常不带上下文窗口、是否支持思考等信息 */
export const fetchEndpointModels = async (
  config: { api: string; compat: 'openai' | 'anthropic'; apiKey: string },
  signal?: AbortSignal
): Promise<{ id: string; name: string }[]> => {
  const url = modelsUrl(config.api, config.compat)
  if (config.compat === 'anthropic') return listAnthropicModels(url, config.apiKey, signal)
  const ids = await listOpenAIModels(url, config.apiKey, signal)
  return ids.map((id) => ({ id, name: id }))
}

/**
 * 用本地目录给模型补元信息。
 * 优先认「同一家厂商」的元数据，其次认 Base URL 匹配到的厂商，最后才按模型名全局兜底——
 * 多家厂商暴露同名模型时（如 openrouter 与 deepinfra 都有 deepseek-chat），前两级能保证不串。
 */
export const enrichModels = (
  providerId: string,
  api: string,
  models: { id: string; name: string }[],
  providers: ProviderMeta[] = []
): ModelEntry[] => {
  const merged = new Map<string, ProviderMeta>()
  for (const p of providers) merged.set(p.id, p)
  const list = [...merged.values()]
  const matched = matchProvider(api, list)
  return models.map((m) => {
    const meta: ModelMeta | null =
      findModelMeta(list, providerId, m.id, { strict: true }) ??
      (matched ? findModelMeta(list, matched.id, m.id, { strict: true }) : null) ??
      findModelMeta(list, providerId, m.id)
    return meta ? { id: m.id, name: meta.name || m.name, meta } : { id: m.id, name: m.name }
  })
}

/** 完整流程：拉列表 + 本地补全 */
export const loadProviderModels = async (
  config: { id: string; api: string; compat: 'openai' | 'anthropic'; apiKey: string },
  signal?: AbortSignal
): Promise<ModelEntry[]> => {
  const [core, directory, remote] = await Promise.all([
    loadCoreProviders(),
    loadProviderDirectory(),
    fetchEndpointModels(config, signal),
  ])
  // 目录里 core 带模型元信息，其余只有端点；合并后查表更全
  const pool: ProviderMeta[] = [...core, ...directory.filter((d) => !core.some((c) => c.id === d.id))]
  return enrichModels(config.id, config.api, remote, pool)
}

/**
 * 本地目录没有这家厂商的元信息时，从 models.dev 拉全量数据里对应的一段。
 * 全量 JSON 有 6MB 左右，只在用户明确点「在线补全」时调用，并按厂商缓存 7 天。
 */
export const fetchOnlineMeta = async (
  providerId: string,
  api: string,
  signal?: AbortSignal
): Promise<ModelEntry[]> => {
  const index = readIndex()
  const cached = index[providerId]
  if (cached && Date.now() - cached.at < INDEX_TTL) return cached.models

  const res = await apiFetch('https://models.dev/api.json', { method: 'GET', signal })
  if (!res.ok) throw new Error(`models.dev 返回 ${res.status}`)
  const all = (await res.json()) as Record<
    string,
    { id: string; name: string; api?: string; models?: Record<string, unknown> }
  >

  const hostOf = (url: string) => {
    try {
      return new URL(url).host.toLowerCase()
    } catch {
      return ''
    }
  }

  const targetHost = hostOf(api)
  const entry =
    all[providerId] ??
    Object.values(all).find((p) => p.api && hostOf(p.api) === targetHost) ??
    null
  if (!entry?.models) return []

  const models: ModelEntry[] = Object.values(entry.models).map((raw) => {
    const m = raw as {
      id: string
      name: string
      limit?: { context?: number; output?: number }
      modalities?: { input?: string[] }
      attachment?: boolean
      reasoning?: boolean
      tool_call?: boolean
      reasoning_options?: { type: string; values?: string[] }[]
      temperature?: boolean
      cost?: { input?: number; output?: number }
      release_date?: string
      status?: string
      open_weights?: boolean
    }
    const meta: ModelMeta = {
      id: m.id,
      name: m.name,
      ctx: m.limit?.context ?? null,
      out: m.limit?.output ?? null,
      in: m.modalities?.input ?? ['text'],
      ...(m.attachment ? { attach: 1 as const } : {}),
      ...(m.reasoning ? { reason: 1 as const } : {}),
      ...(m.tool_call ? { tool: 1 as const } : {}),
      ...(m.reasoning_options?.length ? { ropt: m.reasoning_options.map((o) => o.type) } : {}),
      ...(() => {
        const values = (m.reasoning_options ?? [])
          .filter((o) => o.type === 'effort')
          .flatMap((o) => o.values ?? [])
        return values.length > 0 ? { effort: values } : {}
      })(),
      ...(m.temperature === false ? { noTemp: 1 as const } : {}),
      ...(m.cost ? { cost: [m.cost.input ?? 0, m.cost.output ?? 0] as [number, number] } : {}),
      ...(m.release_date ? { rel: m.release_date } : {}),
      ...(m.status ? { status: m.status } : {}),
      ...(m.open_weights ? { open: 1 as const } : {}),
    }
    return { id: m.id, name: m.name, meta }
  })

  writeIndex({ ...index, [providerId]: { at: Date.now(), models } })
  return models
}
