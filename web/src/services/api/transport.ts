/**
 * 原生壳的传输层。
 *
 * 页面运行在 WebView 里时，所有 API 请求都发到本地壳的 `/__ds_proxy`，由 Java 侧
 * 用 OkHttp 转发。这样做的原因：
 *   1. 绕开 CORS —— 几十家模型的端点不可能都允许浏览器来源；
 *   2. 不受「混合内容」限制；
 *   3. 流式响应由原生侧边收边转，WebView 只消费同源的一条 SSE。
 *
 * 在普通浏览器里打开时（本地开发 / 网页部署）直接 fetch，行为不变。
 */

type NativeBridge = { __DS_NATIVE__?: { version?: string }; __DS_PROXY__?: string }

const bridge = () => window as unknown as NativeBridge

/** 原生壳会在 User-Agent 里追加这个标记；也可以用全局变量显式声明 */
const NATIVE_UA = 'DeepSeekTablet/'

/** 是否运行在 Android 壳里 */
export const isNativeShell = (): boolean =>
  Boolean(bridge().__DS_NATIVE__) || (typeof navigator !== 'undefined' && navigator.userAgent.includes(NATIVE_UA))

/** 壳提供的代理路径；未运行在壳里时返回 null */
const proxyPath = (): string | null => {
  if (!isNativeShell()) return null
  return bridge().__DS_PROXY__ ?? '/__ds_proxy'
}

const encodeHeader = (value: string): string => {
  // base64url，避免请求头里出现非 ASCII
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** 已决定路由的请求：原生壳里是「同源代理 + X-DS-* 头」，浏览器里就是原始请求 */
export type PreparedRequest = {
  url: string
  method: string
  headers: Record<string, string>
  body: BodyInit | null
  /** 是否被改写成代理请求 */
  proxied: boolean
}

/** 把一次 API 调用折叠成实际要发出的请求（fetch 与 XHR 两条通道共用） */
export const prepareRequest = (url: string, init: RequestInit = {}): PreparedRequest => {
  const headers = new Headers(init.headers ?? {})
  const method = (init.method ?? 'GET').toUpperCase()
  const body = (init.body as BodyInit | null | undefined) ?? null
  const plain: Record<string, string> = {}
  headers.forEach((value, key) => {
    plain[key] = value
  })

  const proxy = proxyPath()
  if (!proxy) {
    return { url, method, headers: plain, body, proxied: false }
  }

  // 只保留需要透传的头；Content-Length 等由原生侧重新计算
  delete plain['host']
  delete plain['content-length']

  return {
    url: proxy,
    method: 'POST',
    headers: {
      'X-DS-Target': encodeHeader(url),
      'X-DS-Method': method,
      'X-DS-Headers': encodeHeader(JSON.stringify(plain)),
    },
    body,
    proxied: true,
  }
}

/**
 * 带 API Key 的请求统一走这里。
 * 原生壳内会改写成同源的 POST /__ds_proxy，目标地址和鉴权头放在自定义头里。
 */
export const apiFetch = (url: string, init: RequestInit = {}): Promise<Response> => {
  const prepared = prepareRequest(url, init)
  return fetch(prepared.url, {
    method: prepared.method,
    headers: prepared.headers,
    body: prepared.body,
    signal: init.signal ?? null,
    // 不缓存，SSE 与上传都必须拿到实时响应
    cache: 'no-store',
    credentials: prepared.proxied ? 'omit' : 'same-origin',
  })
}

/** GET 便捷写法 */
export const apiGet = (url: string, headers: Record<string, string> = {}) =>
  apiFetch(url, { method: 'GET', headers })
