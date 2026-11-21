/**
 * 附件上传的**分级策略**（R15 定案）：先试会话附件收据，不行就自动降级到工作区上传。
 *
 * ## 一、为什么要有这个文件（一段必须留档的事实）
 *
 * 我们原来只有一条通道：`fileUploads/upload`（`filesApi.uploadSessionFile`），
 * 早期调研（`input-B` §2.8.2(a)）说它在远端可用——那份材料对**新版本 Host 成立**，
 * 对我们真正连的 Host **不成立**：
 *
 * | 事实 | 证据 |
 * |---|---|
 * | 我们连的 Host 插件是 `ds-harness-remote@0.5.22` | `%USERPROFILE%\.dsh\profiles\desktop\node_modules\ds-harness-remote\package.json` |
 * | 它的 Gateway allowlist **没有** `fileUploads/upload` | 同包 `dist/harness-remote-bridge.js:59-145` |
 * | 不在 allowlist → `RpcError('METHOD_NOT_ALLOWED')` | 同文件 `:446-447` |
 * | 它的**顶层方法表**里有 `workspace.upload.open\|chunk\|commit\|abort` | 同包 `dist/rpc-router.js:40-43`、`dist/workspace-upload.js` |
 * | `hostCapabilities()` **恒**含 `workspace.upload.v1` | 同包 `dist/service.js:374` |
 * | `fileUploads/upload` 是 **0.6.x** 才进 allowlist 的 | `ds-harness-remote@0.6.6` 的 `harness-remote-bridge.ts:172` |
 * | dsh-Go 客户端也早就只走工作区上传 | `dsh_remote/lib/src/carrier/tunnel_carrier.dart:191,250-256,650-700` |
 *
 * 结论：**0.5.22 上唯一能用的上传是 `workspace.upload.*`**。收据那条路留着是因为
 * 升级到 0.6.x 后它会自动接上（`fileUploads/upload` 一下就能用，不需要改代码）。
 *
 * ## 二、分级链（`planUpload()` 是可断言的纯函数，自测逐条覆盖）
 *
 * ```
 * ① fileUploads/upload            → 收据 {receiptId}          → 消息里 {type:'file', receiptId}
 *    ↓ METHOD_NOT_FOUND / METHOD_NOT_ALLOWED / 405 /
 *      gateway/arguments-invalid / FEATURE_NOT_SUPPORTED …
 * ② workspace.upload.open|chunk|commit|abort                     → 工作区路径 ./name
 *    ↓ 任何一步失败 → workspace.upload.abort（幂等清理）
 *    ↓ 拿到 path → 消息正文追加 `@name`（官方 RN 客户端的做法）
 * ③ 两条都不可用 → 抛 `UPLOAD_UNAVAILABLE`（带可读原因 + 稳定 reason），
 *    界面据此把「+」标成不可用并**把原因显示出来**（绝不静默收起）。
 * ```
 *
 * ## 三、写这条链时必须守的硬边界（照 0.5.22 的 `dist/workspace-upload.js`）
 *
 * 1. `uploadId` 是 **UUID**，open 之前生成，每次重传都换新的（commit 超时 = 结果未知，
 *    不能重放同一 uploadId）。
 * 2. `chunk.data` 是**规范 base64**（Host 会逐字对比 `Buffer.toString('base64')`）：
 *    padding 不能省、不能带空白；解码后 ≤ `chunkBytes`（0.5.22 恒 65536）。
 * 3. `offset` 必须严格等于上一块的 `receivedBytes`；`receivedBytes` 对不上就是协议错误，
 *    立刻停止并 abort（不能跳块、不能重发）。
 * 4. `totalBytes` 上限：LAN / P2P **1 GiB**，Relay / TURN / 未知 **20 MiB**；本地先拦。
 * 5. 失败**一律 abort**（幂等），绝不自动重传；同一个文件重试 = 新 `uploadId` + 新名字。
 *
 * ## 四、引用（工作区路径怎么进消息）
 *
 * 工作区上传拿到的是 `{name, path}`，`session/prompt` 的 `file` 块只认 `receiptId`，
 * 所以走**正文引用**：`@a.png` / `@"a b.png"`（`sessionsApi.formatWorkspaceReference()`，
 * 与 RN `formatUploadedFilesReferencePrompt()` 同规则）。界面侧用
 * `workspaceReferenceToken(path)` 把它塞进 `readyReceipts()`，由 `sendPrompt()` 转成正文。
 */

import { RemoteApiError } from './serverApi.js'
import {
  MAX_INLINE_UPLOAD_BYTES,
  MAX_WORKSPACE_UPLOAD_BYTES,
  MAX_WORKSPACE_UPLOAD_BYTES_DIRECT,
  WORKSPACE_UPLOAD_CHUNK_BYTES,
  encodeBase64,
  errorCodeOf,
  shouldFallbackToWorkspaceUpload,
  uploadSessionFile,
  type UploadFileInput,
  type UploadPhase,
} from './filesApi.js'
import {
  WORKSPACE_UPLOAD_CAPABILITY,
  WorkspaceUploadMethods,
  callWorkspaceUpload,
  workspaceReferenceToken,
  type RemoteCallTarget,
} from './sessionsApi.js'
import { useRemoteStore } from './store.js'

/* ────────────────────────────────────────────────────────────────────────
 * 一、类型
 * ──────────────────────────────────────────────────────────────────────── */

/** 两条上传通道。 */
export type UploadStrategy = 'receipt' | 'workspace'

/** 上传进度（比 `filesApi.UploadProgress` 多带一个 `strategy`，界面才知道走的是哪条路）。 */
export interface UploadProgressEvent {
  phase: UploadPhase
  strategy: UploadStrategy
  /** 已经确认真实落地的字节（`workspace` 是 Host ack 的字节数，`receipt` 是整块发出）。 */
  sentBytes: number
  totalBytes: number
}

/** 上传结果：两种通道给出两种凭据。 */
export type UploadOutcome =
  | {
      strategy: 'receipt'
      /** `session/prompt` 的 `{type:'file', receiptId}` 用它。 */
      receiptId: string
      name?: string
      bytes?: number
      mediaType?: string
    }
  | {
      strategy: 'workspace'
      /** Host 回显的最终文件名（同名时可能是 `a (1).png`）。 */
      name: string
      /** 工作区相对路径，恒为 `./` + `name`；引用时去掉 `./`。 */
      path: string
      bytes: number
      mediaType?: string
    }

/** 一次上传可以带的选项。 */
export interface UploadAttachmentOptions {
  onProgress?: (event: UploadProgressEvent) => void
  timeoutMs?: number
  /** 日志出口（默认 `console.info`；页面 console 够真机排查用了）。 */
  log?: (line: string) => void
  /** 只用某一条通道（排障 / 自测）；正常不传。 */
  only?: UploadStrategy
  /** 覆盖能力清单（自测 / 特殊连接）；缺省读 `useRemoteStore`。 */
  capabilities?: readonly string[]
  /** 覆盖传输路径（自测）；缺省读 `useRemoteStore.transport`。 */
  transport?: string
}

/** 两条通道各自「试过没有」的结论（每个连接一份缓存）。 */
export interface UploadStrategyMemory {
  /** 上一次 `fileUploads/upload` 被拒的码（`undefined` = 没试过，或试成功过）。 */
  receiptUnavailableCode?: string
  /** `workspace.upload.*` 明确不可用（能力没声明 / 端点不存在）。 */
  workspaceUnavailable: boolean
}

/** 不可用的稳定原因码（界面翻成 i18n 文案）。 */
export type UploadUnavailableReason =
  | 'both-unavailable'
  | 'receipt-unavailable'
  | 'workspace-unavailable'
  | 'workspace-capability-missing'
  | 'too-large'

const UNAVAILABLE_MESSAGES: Record<UploadUnavailableReason, string> = {
  'both-unavailable': '这台 Host 既没有会话附件接口，也不支持工作区上传，暂时发不了附件',
  'receipt-unavailable': '会话附件接口不可用，工作区上传也没成功',
  'workspace-unavailable': 'Host 没有工作区上传能力（workspace.upload.v1）',
  'workspace-capability-missing': 'Host 没有声明 workspace.upload.v1，不能把文件写进工作区',
  'too-large': '文件太大：这条连接不支持这么大的上传',
}

/* ────────────────────────────────────────────────────────────────────────
 * 二、常量 / 小工具
 * ──────────────────────────────────────────────────────────────────────── */

/** open / chunk / commit 的单次预算：64 KiB 一块在 Relay 上也就几百毫秒，给足但不吊死。 */
const WORKSPACE_CALL_TIMEOUT_MS = 60_000
/** abort 是收尾请求，不该拖住界面。 */
const ABORT_TIMEOUT_MS = 15_000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const numberOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

const stringOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

/** 默认日志出口：页面 console（真机排查时 `chrome://inspect` 直接看得到）。 */
export const logUpload = (line: string): void => {
  try {
    console.info(`[upload] ${line}`)
  } catch {
    // console 不可用（极老的 WebView）不影响上传本身
  }
}

/** 让出主线程：64 KiB 一块、几 MB 的文件会有几十块，别把界面卡死。 */
const yieldToUi = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

/** 是不是「这条通道不认」的码（见 `filesApi.shouldFallbackToWorkspaceUpload` 的表）。 */
const isWorkspaceUnsupported = (error: unknown): boolean => {
  const code = errorCodeOf(error)
  return code === 'FEATURE_NOT_SUPPORTED'
    || code === 'METHOD_NOT_FOUND'
    || code === 'METHOD_NOT_ALLOWED'
    || code === 'CAPABILITY_NOT_SUPPORTED'
    || code === 'UNSUPPORTED'
}

/* ────────────────────────────────────────────────────────────────────────
 * 三、能力 / 限额（都是纯函数，自测直接喂）
 * ──────────────────────────────────────────────────────────────────────── */

/** Host 在 `harness.transport.describe` 里声明的能力（连接没就绪时是空数组）。 */
export const readRemoteCapabilities = (): readonly string[] => {
  try {
    return useRemoteStore.getState().capabilities
  } catch {
    return []
  }
}

/** 当前传输路径（`'lan' | 'p2p' | 'turn' | 'relay'`；缺省当作 relay）。 */
export const readRemoteTransport = (): string => {
  try {
    return useRemoteStore.getState().transport ?? 'relay'
  } catch {
    return 'relay'
  }
}

/** 这条传输路径上 Host 允许的最大 `totalBytes`（协议 `:1653`）。 */
export const workspaceUploadLimitBytes = (transport: string | undefined): number =>
  transport === 'lan' || transport === 'p2p' ? MAX_WORKSPACE_UPLOAD_BYTES_DIRECT : MAX_WORKSPACE_UPLOAD_BYTES

/** Host 有没有声明 `workspace.upload.v1`。空清单 = 未知（不是「没有」）。 */
export const hasWorkspaceUploadCapability = (capabilities: readonly string[]): boolean =>
  capabilities.includes(WORKSPACE_UPLOAD_CAPABILITY)

/* ────────────────────────────────────────────────────────────────────────
 * 四、分级判定（纯函数 —— 任务书要求「逐条自测」的就是这张表）
 * ──────────────────────────────────────────────────────────────────────── */

export interface UploadPlanInput {
  bytes: number
  /** Host 声明的能力清单（空 = 未知）。 */
  capabilities: readonly string[]
  /** 传输路径（决定工作区上传上限）。 */
  transport?: string
  /** 上一次 `fileUploads/upload` 被拒的码（`undefined` = 没试过 / 曾经成功）。 */
  receiptUnavailableCode?: string
  /** `workspace.upload.*` 已确认不可用。 */
  workspaceUnavailable?: boolean
  /** 只用一条通道（排障 / 自测）。 */
  only?: UploadStrategy
}

export interface UploadPlan {
  /** 依次尝试的通道（空 = 两条都不行）。 */
  order: UploadStrategy[]
  /** `order` 为空时**必须**有可读原因。 */
  reason?: UploadUnavailableReason
  /** 给日志/界面用的一句话（中文）。 */
  detail: string
}

/**
 * 决定这次上传走哪些通道、按什么顺序。
 *
 * 判定表（自测 `upload.selftest.mts` 的 A 组逐条断言）：
 *
 * | 输入 | order |
 * |---|---|
 * | bytes ≤ 30 MiB，两条都没被拒 | `['receipt', 'workspace']` |
 * | 上一次 receipt 回了 405 / METHOD_NOT_ALLOWED | `['workspace']` |
 * | 能力清单里没有 `workspace.upload.v1`（非空清单） | `['receipt']` |
 * | bytes > 30 MiB，但 ≤ 工作区上限（LAN/P2P 1 GiB） | `['workspace']` |
 * | bytes > 30 MiB 且 > 工作区上限 | `[]`（`too-large`） |
 * | receipt 被拒 + 没有工作区能力 | `[]`（`both-unavailable`） |
 * | `only: 'workspace'` | `['workspace']`（不看 receipt 的记忆） |
 */
export const planUpload = (input: UploadPlanInput): UploadPlan => {
  const limit = workspaceUploadLimitBytes(input.transport)
  const capability = hasWorkspaceUploadCapability(input.capabilities)
  // 空清单 = 没探测到（连接早期 / describe 解析不全）：不据此判死，交给 Host 的 FEATURE_NOT_SUPPORTED
  const capabilityKnown = input.capabilities.length > 0
  const receiptPossible = input.only !== 'workspace'
    && input.receiptUnavailableCode === undefined
    && input.bytes <= MAX_INLINE_UPLOAD_BYTES
  const workspacePossible = input.only !== 'receipt'
    && input.workspaceUnavailable !== true
    && (capability || !capabilityKnown)
    && input.bytes <= limit
  const order: UploadStrategy[] = []
  if (receiptPossible) order.push('receipt')
  if (workspacePossible) order.push('workspace')
  const detail = describePlan(input, order, limit, capabilityKnown && !capability)
  return order.length === 0 ? { order, reason: reasonOf(input, limit, capabilityKnown && !capability), detail } : { order, detail }
}

const describePlan = (
  input: UploadPlanInput,
  order: readonly UploadStrategy[],
  limit: number,
  capabilityMissing: boolean,
): string => {
  if (order.length === 0) {
    if (input.bytes > limit && input.bytes > MAX_INLINE_UPLOAD_BYTES) return `${input.bytes} B 超过两条通道的上限`
    if (capabilityMissing) return 'Host 没有声明 workspace.upload.v1，会话附件通道也被拒过'
    return '两条上传通道都不可用'
  }
  const parts = order.map((item) => (item === 'receipt' ? 'fileUploads/upload' : 'workspace.upload.*'))
  return `按 ${parts.join(' → ')} 尝试（上限 ${limit} B）`
}

const reasonOf = (
  input: UploadPlanInput,
  limit: number,
  capabilityMissing: boolean,
): UploadUnavailableReason => {
  if (input.bytes > limit && input.bytes > MAX_INLINE_UPLOAD_BYTES) return 'too-large'
  if (capabilityMissing) return 'workspace-capability-missing'
  if (input.receiptUnavailableCode !== undefined && input.workspaceUnavailable === true) return 'both-unavailable'
  if (input.bytes > limit) return 'too-large'
  return 'both-unavailable'
}

/* ────────────────────────────────────────────────────────────────────────
 * 五、通道记忆（每个连接一份；换连接自动清空）
 * ──────────────────────────────────────────────────────────────────────── */

let memoryTarget: RemoteCallTarget | null = null
let memory: UploadStrategyMemory = { workspaceUnavailable: false }

/** 换连接 / 退出远程模式时清空（界面在 `bind()` 里调）。 */
export const resetUploadStrategy = (): void => {
  memoryTarget = null
  memory = { workspaceUnavailable: false }
}

/** 现在的记忆快照（排障 / 自测断言）。 */
export const uploadStrategyMemory = (): UploadStrategyMemory => ({ ...memory })

const memoryFor = (target: RemoteCallTarget): UploadStrategyMemory => {
  if (memoryTarget !== target) {
    memoryTarget = target
    memory = { workspaceUnavailable: false }
  }
  return memory
}

/* ────────────────────────────────────────────────────────────────────────
 * 六、上传入口
 * ──────────────────────────────────────────────────────────────────────── */

/** 两条通道都不可用（界面据此把入口标成不可用，并把 `message` 显示出来）。 */
export const isUploadUnavailable = (error: unknown): boolean => errorCodeOf(error) === 'UPLOAD_UNAVAILABLE'

/** `UPLOAD_UNAVAILABLE` 的稳定原因码（界面翻 i18n；别的错误返回 `undefined`）。 */
export const uploadErrorReasonOf = (error: unknown): UploadUnavailableReason | undefined => {
  if (!isUploadUnavailable(error)) return undefined
  const details = (error as { details?: unknown }).details
  const reason = isRecord(details) ? details['reason'] : undefined
  if (typeof reason !== 'string') return undefined
  if (reason === 'both-unavailable' || reason === 'receipt-unavailable' || reason === 'workspace-unavailable'
    || reason === 'workspace-capability-missing' || reason === 'too-large') {
    return reason
  }
  return undefined
}

const unavailableError = (reason: UploadUnavailableReason, detail: string): RemoteApiError =>
  new RemoteApiError(
    'UPLOAD_UNAVAILABLE',
    detail.length > 0 ? detail : UNAVAILABLE_MESSAGES[reason],
    undefined,
    false,
    { reason },
  )

/**
 * 上传一个附件（**界面唯一入口**）：先 `fileUploads/upload`，被拒就自动降级工作区上传。
 *
 * 抛出的错误分三类，界面要区别对待：
 *  - `UPLOAD_UNAVAILABLE`：两条通道都不行 ⇒ 入口确实用不了（`details.reason` 给原因码）；
 *  - `UPLOAD_TOO_LARGE` / `UPLOAD_LIMIT` / `UPLOAD_INVALID_NAME`…：这次文件不行，换文件；
 *  - 其它（超时 / 断线 / Host 内部错误）：重试。
 */
export const uploadAttachment = async (
  target: RemoteCallTarget,
  sessionId: string,
  file: UploadFileInput,
  options: UploadAttachmentOptions = {},
): Promise<UploadOutcome> => {
  const log = options.log ?? logUpload
  const totalBytes = file.bytes.byteLength
  if (totalBytes === 0) throw new RemoteApiError('INVALID_ARGUMENT', '这个文件是空的，没法上传')
  const capabilities = options.capabilities ?? readRemoteCapabilities()
  const transport = options.transport ?? readRemoteTransport()
  const memoryState = memoryFor(target)
  const plan = planUpload({
    bytes: totalBytes,
    capabilities,
    transport,
    ...(memoryState.receiptUnavailableCode === undefined ? {} : { receiptUnavailableCode: memoryState.receiptUnavailableCode }),
    workspaceUnavailable: memoryState.workspaceUnavailable,
    ...(options.only === undefined ? {} : { only: options.only }),
  })
  const label = `${file.name}（${totalBytes} B，传输 ${transport}）`
  log(`${label}：${plan.detail}`)
  if (plan.order.length === 0) {
    // 「太大」不是「没通道」：界面要能把「换个小文件」和「这台 Host 传不了」分开说
    if (plan.reason === 'too-large') {
      throw new RemoteApiError(
        'UPLOAD_TOO_LARGE',
        `${(totalBytes / 1024 / 1024).toFixed(1)} MiB 超过这条连接的上传上限（工作区 ${(workspaceUploadLimitBytes(transport) / 1024 / 1024).toFixed(0)} MiB / 会话附件 ${MAX_INLINE_UPLOAD_BYTES / 1024 / 1024} MiB）`,
      )
    }
    const error = unavailableError(plan.reason ?? 'both-unavailable', plan.detail)
    log(`放弃：${error.message}`)
    throw error
  }

  let lastError: unknown
  let lastStrategy: UploadStrategy | undefined
  for (const strategy of plan.order) {
    lastStrategy = strategy
    try {
      const outcome = strategy === 'receipt'
        ? await uploadViaReceipt(target, sessionId, file, options, log)
        : await uploadViaWorkspace(target, sessionId, file, options, log)
      if (strategy === 'receipt') memoryState.receiptUnavailableCode = undefined
      else memoryState.workspaceUnavailable = false
      const where = outcome.strategy === 'receipt' ? `receiptId=${outcome.receiptId}` : `path=${outcome.path}`
      log(`${label}：${strategy} 成功（${where}）`)
      return outcome
    } catch (error) {
      lastError = error
      const code = errorCodeOf(error) || '(无码)'
      if (strategy === 'receipt' && shouldFallbackToWorkspaceUpload(error)) {
        memoryState.receiptUnavailableCode = code
        const next = plan.order[plan.order.indexOf(strategy) + 1]
        if (next === undefined && totalBytes > workspaceUploadLimitBytes(transport)) {
          // 收据通道不认、工作区通道又装不下这个文件：说「太大」，别说「这台 Host 传不了」
          throw new RemoteApiError(
            'UPLOAD_TOO_LARGE',
            `${(totalBytes / 1024 / 1024).toFixed(1)} MiB 超过这条连接的上传上限（工作区 ${(workspaceUploadLimitBytes(transport) / 1024 / 1024).toFixed(0)} MiB / 会话附件 ${MAX_INLINE_UPLOAD_BYTES / 1024 / 1024} MiB）`,
          )
        }
        log(`${label}：fileUploads/upload 被拒（${code}）→ ${next === undefined ? '没有后备通道' : '自动降级到 workspace.upload.*'}`)
        continue
      }
      if (strategy === 'workspace' && isWorkspaceUnsupported(error)) {
        memoryState.workspaceUnavailable = true
        log(`${label}：workspace.upload.* 不可用（${code}）`)
        continue
      }
      log(`${label}：${strategy} 失败（${code}）${error instanceof Error ? ` ${error.message}` : ''}`)
      throw error
    }
  }
  const reason: UploadUnavailableReason = lastStrategy === 'receipt' ? 'receipt-unavailable' : 'workspace-unavailable'
  const detail = lastError instanceof Error && lastError.message.length > 0
    ? lastError.message
    : UNAVAILABLE_MESSAGES[reason]
  log(`${label}：两条通道都没成功（最后 ${errorCodeOf(lastError) || '(无码)'}）`)
  throw unavailableError(reason, detail)
}

/** ① 会话附件收据（单帧 base64）。 */
const uploadViaReceipt = async (
  target: RemoteCallTarget,
  sessionId: string,
  file: UploadFileInput,
  options: UploadAttachmentOptions,
  log: (line: string) => void,
): Promise<UploadOutcome> => {
  log(`fileUploads/upload：开始编码 ${file.bytes.byteLength} B`)
  const receipt = await uploadSessionFile(target, sessionId, file, {
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    onProgress: (progress) => {
      options.onProgress?.({
        phase: progress.phase,
        strategy: 'receipt',
        sentBytes: progress.sentBytes,
        totalBytes: progress.totalBytes,
      })
    },
  })
  return {
    strategy: 'receipt',
    receiptId: receipt.receiptId,
    ...(receipt.name === undefined ? {} : { name: receipt.name }),
    ...(receipt.bytes === undefined ? {} : { bytes: receipt.bytes }),
    ...(receipt.mediaType === undefined && file.mediaType === undefined
      ? {}
      : { mediaType: receipt.mediaType ?? (file.mediaType as string) }),
  }
}

/**
 * ② 工作区上传：`open` → `chunk`×N（顺序、带 ack 校验）→ `commit`；任何失败都 `abort`。
 *
 * 拿到 `{name, path}` 之后**不是**发收据，而是让调用方把路径当 `@` 引用带进消息。
 */
const uploadViaWorkspace = async (
  target: RemoteCallTarget,
  sessionId: string,
  file: UploadFileInput,
  options: UploadAttachmentOptions,
  log: (line: string) => void,
): Promise<UploadOutcome> => {
  const totalBytes = file.bytes.byteLength
  const name = sanitizeWorkspaceUploadName(file.name)
  const uploadId = newUploadId()
  const scope = { sessionId, uploadId }
  const timeoutMs = options.timeoutMs ?? WORKSPACE_CALL_TIMEOUT_MS
  let opened = false
  const fail = (message: string, code = 'INVALID_RESPONSE'): RemoteApiError => new RemoteApiError(code, message)
  try {
    // ── open ──
    const openResult = await callWorkspaceUpload<unknown>(
      target,
      WorkspaceUploadMethods.open,
      { ...scope, name, totalBytes },
      timeoutMs,
    )
    opened = true
    if (!isRecord(openResult)) throw fail('workspace.upload.open 没有返回对象')
    if (openResult.uploadId !== uploadId) throw fail('workspace.upload.open 回显的 uploadId 对不上')
    const announced = numberOf(openResult.chunkBytes)
    if (announced === undefined || announced < 1) throw fail('workspace.upload.open 没有给出 chunkBytes')
    // Host 0.5.22 恒给 65536；给了更大的值也不信（协议上限就是 64 KiB，二进制扩展才 256 KiB）
    const chunkBytes = Math.min(Math.floor(announced), WORKSPACE_UPLOAD_CHUNK_BYTES)
    log(`workspace.upload.open：uploadId=${uploadId} name=${name} chunkBytes=${chunkBytes}`)
    options.onProgress?.({ phase: 'encoding', strategy: 'workspace', sentBytes: 0, totalBytes })

    // ── chunk（严格按 offset 递增）──
    let offset = 0
    while (offset < totalBytes) {
      const end = Math.min(offset + chunkBytes, totalBytes)
      // 只编码这一块：不能把整个文件一次展开成 base64（协议 `:1661`）
      const data = encodeBase64(file.bytes.subarray(offset, end))
      const ack = await callWorkspaceUpload<unknown>(
        target,
        WorkspaceUploadMethods.chunk,
        { ...scope, offset, data },
        timeoutMs,
      )
      if (!isRecord(ack)) throw fail('workspace.upload.chunk 没有返回对象')
      if (ack.uploadId !== uploadId) throw fail('workspace.upload.chunk 回显的 uploadId 对不上')
      if (ack.receivedBytes !== end) {
        throw fail(`workspace.upload.chunk 的 receivedBytes 不对：期望 ${end}，实际 ${String(ack.receivedBytes)}`)
      }
      offset = end
      options.onProgress?.({ phase: 'uploading', strategy: 'workspace', sentBytes: offset, totalBytes })
      await yieldToUi()
    }

    // ── commit ──
    const commitResult = await callWorkspaceUpload<unknown>(target, WorkspaceUploadMethods.commit, scope, timeoutMs)
    if (!isRecord(commitResult)) throw fail('workspace.upload.commit 没有返回对象')
    const finalName = stringOf(commitResult.name) ?? name
    const path = stringOf(commitResult.path) ?? `./${finalName}`
    const committedBytes = numberOf(commitResult.bytes) ?? totalBytes
    if (committedBytes !== totalBytes) throw fail(`commit 的字节数对不上：期望 ${totalBytes}，实际 ${committedBytes}`)
    if (!path.startsWith('./')) throw fail(`commit 回显的 path 不是工作区相对路径：${path}`)
    options.onProgress?.({ phase: 'done', strategy: 'workspace', sentBytes: totalBytes, totalBytes })
    return {
      strategy: 'workspace',
      name: finalName,
      path,
      bytes: totalBytes,
      ...(file.mediaType === undefined ? {} : { mediaType: file.mediaType }),
    }
  } catch (error) {
    // 任何失败都要收尾：Host 侧会留一个未提交临时文件，abort 是幂等的
    if (opened) {
      log(`workspace.upload.abort：清理 uploadId=${uploadId}`)
      void abortWorkspaceUpload(target, sessionId, uploadId, { log })
    }
    throw error
  }
}

/** 清理一个未提交的工作区上传（幂等；失败只记日志，不影响主错误）。 */
export const abortWorkspaceUpload = async (
  target: RemoteCallTarget,
  sessionId: string,
  uploadId: string,
  options: { timeoutMs?: number; log?: (line: string) => void } = {},
): Promise<void> => {
  const log = options.log ?? logUpload
  try {
    await callWorkspaceUpload(target, WorkspaceUploadMethods.abort, { sessionId, uploadId }, options.timeoutMs ?? ABORT_TIMEOUT_MS)
  } catch (error) {
    log(`workspace.upload.abort 失败（可忽略）：${errorCodeOf(error) || String(error)}`)
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * 七、文件名 / uploadId（Host 的规则逐条照抄）
 * ──────────────────────────────────────────────────────────────────────── */

/** Windows 保留名（Host 也会拒，本地先改掉更友好）。 */
const RESERVED_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu

/** 名字里允许的字符：Host 拒 `/ \` 控制字符与 `<>:"|?*`（`dist/workspace-upload.js:228-232`）。 */
const NAME_REJECTED = /[/\\\u0000-\u001f\u007f<>:"|?*]/gu

/** 按 UTF-8 字节数截断（不能按字符截：220 **bytes**，一个汉字 3 字节）。 */
const truncateToBytes = (value: string, maxBytes: number): string => {
  const encoder = new TextEncoder()
  if (encoder.encode(value).byteLength <= maxBytes) return value
  let result = ''
  let used = 0
  for (const char of value) {
    const size = encoder.encode(char).byteLength
    if (used + size > maxBytes) break
    result += char
    used += size
  }
  return result
}

/**
 * 文件名 → Host `workspace.upload.open` 能接受的 `name`。
 *
 * 规则（`docs/protocol.md:1653-1655` + `dist/workspace-upload.js:228-232`）：
 * 只取末段；去控制字符；`<>:"|?* / \` → `_`；去掉尾部点/空格；避开 Windows 保留名；
 * 不许 `.dsh-upload-` 前缀；UTF-8 ≤ 220 字节（保留扩展名）。
 */
export const sanitizeWorkspaceUploadName = (raw: string): string => {
  const base = raw.replace(/\\/gu, '/').slice(raw.replace(/\\/gu, '/').lastIndexOf('/') + 1)
  let name = base.replace(/\u0000/gu, '').replace(NAME_REJECTED, '_').replace(/^\.+/u, '').trim()
  name = name.replace(/[. ]+$/u, '')
  if (name.length === 0) name = 'file'
  if (name.startsWith('.dsh-upload-')) name = `upload-${name.slice('.dsh-upload-'.length)}`
  if (RESERVED_NAMES.test(name)) name = `_${name}`
  // 保留扩展名做字节截断：`报告.png` → 截断后仍然是 `….png`
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot) : ''
  const stem = dot > 0 ? name.slice(0, dot) : name
  const maxStemBytes = Math.max(1, 220 - new TextEncoder().encode(extension).byteLength)
  const safeStem = truncateToBytes(stem, maxStemBytes).replace(/[. ]+$/u, '')
  const finalName = `${safeStem.length > 0 ? safeStem : 'file'}${extension}`
  return finalName.length > 0 ? finalName : 'file'
}

/** 新的 `uploadId`：Host 用 `z.string().uuid()` 校验，所以必须是 UUID。 */
export const newUploadId = (): string => {
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID()
  // 老 WebView 没有 randomUUID：用 getRandomValues 手搓 v4（RFC 4122 §4.4）
  const bytes = new Uint8Array(16)
  if (typeof cryptoApi?.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256)
  }
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/* ────────────────────────────────────────────────────────────────────────
 * 八、给界面用的小投影
 * ──────────────────────────────────────────────────────────────────────── */

/** 结果里的「可发送凭据」：收据 = receiptId；工作区 = 引用令牌（见 `sessionsApi` §六·补）。 */
export const outcomeToken = (outcome: UploadOutcome): string =>
  outcome.strategy === 'receipt' ? outcome.receiptId : workspaceReferenceToken(outcome.path)

/** 工作区结果的引用写法（`@a.png`）—— 只用于界面提示。 */
export const outcomeReference = (outcome: UploadOutcome): string | null => {
  if (outcome.strategy !== 'workspace') return null
  const clean = outcome.path.replace(/^\.\//u, '')
  return /[\s"]/u.test(clean) ? `@"${clean.replace(/"/gu, '\\"')}"` : `@${clean}`
}

/** 一句话说明这条附件是怎么上去的（i18n 用的键在 `workspacePaneStore` 里翻）。 */
export const outcomeSummary = (outcome: UploadOutcome): string =>
  outcome.strategy === 'receipt'
    ? `会话附件收据 ${outcome.receiptId}`
    : `工作区文件 ${outcome.path}（发送时以引用带上）`
