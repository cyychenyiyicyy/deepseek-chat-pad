/** 模型元信息（由 tools/build-catalog.mjs 从 models.dev 裁剪而来） */
export type ModelMeta = {
  id: string
  name: string
  /** 上下文窗口 */
  ctx: number | null
  /** 最大输出 */
  out: number | null
  /** 输入模态：text / image / pdf / audio / video */
  in: string[]
  /** 支持附件 */
  attach?: 1
  /** 支持思考 */
  reason?: 1
  /** 支持工具调用 */
  tool?: 1
  /** 思考开关类型：toggle（开关） / effort（档位） */
  ropt?: string[]
  /** 不接受 temperature */
  noTemp?: 1
  /** [输入, 输出] 价格，美元 / 百万 token */
  cost?: [number, number]
  rel?: string
  status?: string
  open?: 1
}

/** 厂商端点 + 兼容协议 */
export type ProviderMeta = {
  id: string
  name: string
  /** 对话接口的 base URL */
  api: string
  compat: 'openai' | 'anthropic'
  /** 官方文档里约定的环境变量名，仅用于提示 */
  env?: string
  models?: ModelMeta[]
}

type CatalogPayload = { version: number; generatedAt: string; core: ProviderMeta[] }
type DirectoryPayload = { version: number; providers: ProviderMeta[] }

const json = (name: string) => new URL(`catalog/${name}`, document.baseURI).href

let coreTask: Promise<ProviderMeta[]> | null = null
let dirTask: Promise<ProviderMeta[]> | null = null

/** 内置的常用厂商目录（离线可用，首屏立刻能选模型） */
export const loadCoreProviders = (): Promise<ProviderMeta[]> => {
  coreTask ??= (async () => {
    // index.html 里的 catalog.js 会预先挂好全局变量，省掉一次网络往返
    const preloaded = (window as { __MODEL_CATALOG__?: CatalogPayload }).__MODEL_CATALOG__
    if (preloaded?.core) return preloaded.core
    try {
      const res = await fetch(json('catalog.json'))
      if (!res.ok) return []
      return ((await res.json()) as CatalogPayload).core ?? []
    } catch {
      return []
    }
  })()
  return coreTask
}

/** 全部厂商的端点目录（用于「填 Base URL 自动识别厂商」） */
export const loadProviderDirectory = (): Promise<ProviderMeta[]> => {
  dirTask ??= (async () => {
    const preloaded = (window as { __PROVIDER_DIR__?: DirectoryPayload }).__PROVIDER_DIR__
    if (preloaded?.providers) return preloaded.providers
    try {
      const res = await fetch(json('providers.json'))
      if (!res.ok) return []
      return ((await res.json()) as DirectoryPayload).providers ?? []
    } catch {
      return []
    }
  })()
  return dirTask
}

/** 去掉末尾斜杠、协议差异，便于比较 */
const normalize = (url: string) => url.trim().replace(/\/+$/, '').toLowerCase()

const hostOf = (url: string) => {
  try {
    return new URL(url.includes('://') ? url : `https://${url}`).host.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * 按用户填的 Base URL 找厂商：先精确匹配（含 /v1 等路径），再退化到域名匹配。
 * models.dev 的 api 字段常带版本路径，用户可能只填域名，所以两级都要试。
 */
export const matchProvider = (baseUrl: string, directory: ProviderMeta[]): ProviderMeta | null => {
  const target = normalize(baseUrl)
  if (!target) return null
  const withProtocol = target.includes('://') ? target : `https://${target}`
  const exact = directory.find((p) => normalize(p.api) === withProtocol)
  if (exact) return exact

  const targetHost = hostOf(withProtocol)
  if (!targetHost) return null
  const sameHost = directory.filter((p) => hostOf(p.api) === targetHost)
  if (sameHost.length === 0) return null
  // 同域名可能有多个版本（如 minimax 与 minimax-cn），取路径最长且被包含的那个
  const ranked = sameHost
    .map((p) => ({ p, api: normalize(p.api) }))
    .filter(({ api }) => withProtocol.startsWith(api) || api.startsWith(withProtocol))
    .sort((a, b) => b.api.length - a.api.length)
  return ranked[0]?.p ?? sameHost[0]
}

/** 把 base URL 补成对话接口地址：允许用户只填域名 */
export const normalizeBaseUrl = (input: string): string => {
  const trimmed = input.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

/** OpenAI 兼容的模型列表地址；Anthropic 兼容的是 /v1/models */
export const modelsUrl = (baseUrl: string, compat: 'openai' | 'anthropic'): string => {
  const base = normalizeBaseUrl(baseUrl)
  if (compat === 'anthropic') {
    return /\/v1$/.test(base) ? `${base}/models` : `${base}/v1/models`
  }
  return /\/v\d+$/.test(base) ? `${base}/models` : `${base}/v1/models`
}

/** 对话接口地址：兼容用户填「带版本」与「不带版本」两种写法 */
export const chatUrl = (baseUrl: string, compat: 'openai' | 'anthropic'): string => {
  const base = normalizeBaseUrl(baseUrl)
  const versioned = /\/v\d+$/.test(base) ? base : `${base}/v1`
  return compat === 'anthropic' ? `${versioned}/messages` : `${versioned}/chat/completions`
}

/** 上下文窗口显示成 128K / 1M 这样的短记法 */
export const formatContext = (tokens: number | null | undefined): string => {
  if (!tokens) return ''
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`
  return String(tokens)
}

/**
 * 在本地目录里查某个模型的元信息。
 * strict 为 true 时只认指定厂商，用于「多家厂商有同名模型」时避免张冠李戴。
 */
export const findModelMeta = (
  providers: ProviderMeta[],
  providerId: string,
  modelId: string,
  options: { strict?: boolean } = {}
): ModelMeta | null => {
  const provider = providers.find((p) => p.id === providerId)
  const model = provider?.models?.find((m) => m.id === modelId)
  if (model) return model
  if (options.strict) return null
  // 用户手里的模型名常带厂商前缀（如 openrouter 的 "deepseek/deepseek-chat"）
  const tail = modelId.includes('/') ? modelId.slice(modelId.lastIndexOf('/') + 1) : ''
  if (!tail) return null
  for (const p of providers) {
    const hit = p.models?.find((m) => m.id === tail)
    if (hit) return hit
  }
  return null
}
