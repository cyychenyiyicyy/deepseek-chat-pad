/**
 * 老 WebView 的 SSE 兜底通道。
 *
 * `fetch` 的流式响应（`response.body`）要 Chrome 105+ 才支持。国产平板、老安卓 9 设备上
 * 系统 WebView 常停留在 74–100，此时 `response.body` 是 undefined，整个对话会直接不可用。
 * 这里用 XMLHttpRequest 的 `onprogress` 增量读 `responseText`，效果等价：一样边收边解析。
 */
import { ApiError } from './error.js'
import { ServerSentEventDecoder, type ServerSentEvent } from './sse.js'
import type { PreparedRequest } from './transport.js'

/** 当前环境是否支持 fetch 流式响应 */
export const supportsStreamResponse = (): boolean =>
  typeof Response !== 'undefined' && 'body' in Response.prototype && typeof ReadableStream !== 'undefined'

/**
 * 用 XHR 增量读取 SSE。只有在不支持 fetch 流时才使用。
 * 接收已经准备好的请求（可能已改写成同源代理），因此与 fetch 路径共用同一套鉴权与路由逻辑。
 */
export async function* readServerSentEventsXhr(
  request: PreparedRequest,
  signal: AbortSignal
): AsyncGenerator<ServerSentEvent> {
  const decoder = new ServerSentEventDecoder()
  const queue: ServerSentEvent[] = []
  const xhr = new XMLHttpRequest()

  let offset = 0
  let settled = false
  let failure: Error | null = null
  let wake: (() => void) | null = null
  const notify = () => {
    const resume = wake
    wake = null
    resume?.()
  }

  const drain = (final: boolean) => {
    let text = ''
    try {
      text = xhr.responseText
    } catch {
      return
    }
    if (text.length > offset) {
      queue.push(...decoder.push(text.slice(offset)))
      offset = text.length
    }
    if (final) queue.push(...decoder.end())
  }

  xhr.open(request.method, request.url, true)
  xhr.responseType = 'text'
  for (const [name, value] of Object.entries(request.headers)) {
    try {
      xhr.setRequestHeader(name, value)
    } catch {
      // 少数头浏览器不允许设置，忽略即可
    }
  }

  xhr.onprogress = () => {
    drain(false)
    notify()
  }
  xhr.onload = () => {
    if (xhr.status < 200 || xhr.status >= 300) {
      failure = new ApiError('http', xhr.responseText || xhr.statusText, xhr.status)
    } else {
      drain(true)
    }
    settled = true
    notify()
  }
  xhr.onerror = () => {
    failure = new ApiError('network', '网络请求失败')
    settled = true
    notify()
  }
  xhr.ontimeout = () => {
    failure = new ApiError('network', '请求超时')
    settled = true
    notify()
  }
  xhr.onabort = () => {
    settled = true
    notify()
  }

  const onAbort = () => {
    try {
      xhr.abort()
    } catch {
      // 已经结束时 abort 会抛，忽略
    }
  }
  if (signal.aborted) {
    throw new ApiError('network', '请求已取消')
  }
  signal.addEventListener('abort', onAbort, { once: true })

  try {
    xhr.send((request.body as XMLHttpRequestBodyInit | null) ?? null)
    for (;;) {
      if (queue.length > 0) {
        yield queue.shift() as ServerSentEvent
        continue
      }
      if (failure) throw failure
      if (settled || signal.aborted) return
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
    if (!settled) {
      try {
        xhr.abort()
      } catch {
        // 忽略
      }
    }
  }
}
