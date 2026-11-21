/**
 * 远程 DSH 链路层（S2）统一错误类型。
 *
 * 错误码分两类：
 * 1. `docs/protocol.md` §23 的标准码（`RPC_TIMEOUT` / `SECURE_CHANNEL_FAILED` /
 *    `INVALID_MESSAGE` / `FRAME_TOO_LARGE` / `PEER_IDENTITY_MISMATCH` …），**原样直传**，
 *    不做二次包装（契约 §3「错误码直传」）。
 * 2. 本层补充的码（`TRANSPORT_CLOSED` / `RPC_ABORTED` / `CONNECTION_FAILED` …），
 *    语义与 `packages/client-core/src/index.ts` 的 `RemoteClientError` 保持一致。
 *
 * 调用方只应按 `error.code` 分类，**不要匹配 message 文案**（文案会变，码不会）。
 */

/** 本层会用到的错误码常量（协议 §23 的标准码 + client-core 同义码）。 */
export const LinkErrorCodes = {
  /** 本地等待响应超时（§23 标准码；对端也可能主动返回它）。 */
  RPC_TIMEOUT: 'RPC_TIMEOUT',
  /** 调用方通过 AbortSignal 取消。 */
  RPC_ABORTED: 'RPC_ABORTED',
  /** 链路已关闭（本地 close、原生桥断开或整体失败）。 */
  TRANSPORT_CLOSED: 'TRANSPORT_CLOSED',
  /** Noise 认证/解密/重组失败：必须关闭 secure channel。 */
  SECURE_CHANNEL_FAILED: 'SECURE_CHANNEL_FAILED',
  /** 线协议违规（未知 frame 类型、字段不匹配、连接不匹配 …）。 */
  INVALID_MESSAGE: 'INVALID_MESSAGE',
  /** 超过 §24 的尺寸上限。 */
  FRAME_TOO_LARGE: 'FRAME_TOO_LARGE',
  /** hello.ack 没给出实现所需的能力（P0 只需要 transport.relay）。 */
  CAPABILITY_NOT_SUPPORTED: 'CAPABILITY_NOT_SUPPORTED',
  /** 协议版本不匹配。 */
  UNSUPPORTED_VERSION: 'UNSUPPORTED_VERSION',
  /** 缺少 device access token（只能走 hello payload，绝不进 URL）。 */
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  /** 同连接 pending/stream 数超过 §24 上限。 */
  RATE_LIMITED: 'RATE_LIMITED',
  /** 连接建立/心跳层面的失败（可重试）。 */
  CONNECTION_FAILED: 'CONNECTION_FAILED',
  /** 独立 Relay 数据面（relay.attach）未实现：P0 只用控制通道 relay。 */
  RELAY_UNAVAILABLE: 'RELAY_UNAVAILABLE',
  /** Host 静态身份公钥不匹配或缺失（§12.1 的 pinning）。 */
  PEER_IDENTITY_MISMATCH: 'PEER_IDENTITY_MISMATCH',
  /** 兜底。 */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const

/** 远程链路错误。`code` 可能是 §23 标准码，也可能是子系统扩展码（如 `CODEX_*`）。 */
export class RemoteLinkError extends Error {
  readonly code: string
  readonly details: unknown
  readonly retryable: boolean | undefined

  constructor(
    code: string,
    message: string,
    options: { details?: unknown; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'RemoteLinkError'
    this.code = code
    this.details = options.details
    this.retryable = options.retryable
  }
}

export function isRemoteLinkError(value: unknown): value is RemoteLinkError {
  return value instanceof RemoteLinkError
}

/** 读取任意 error-like 上的 `code` 字段（NoiseSessionError 也走这里）。 */
export function readErrorCode(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const code = (value as { code?: unknown }).code
  return typeof code === 'string' && code.length > 0 ? code : undefined
}

/** 把任意异常收敛成 RemoteLinkError，保留原始 `code`（拿不到时才用 fallback）。 */
export function asRemoteLinkError(
  value: unknown,
  fallbackCode: string = LinkErrorCodes.INTERNAL_ERROR,
  fallbackMessage?: string,
): RemoteLinkError {
  if (value instanceof RemoteLinkError) return value
  const code = readErrorCode(value) ?? fallbackCode
  const message = errorMessage(value) || fallbackMessage || '远程链路失败。'
  return new RemoteLinkError(code, message, { cause: value })
}

/** 安全地取错误文案（line/length 上不假设 error 形状）。 */
export function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  return ''
}
