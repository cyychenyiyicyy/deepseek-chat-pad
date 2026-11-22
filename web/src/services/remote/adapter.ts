/**
 * 远端 DSH 事件 → 本地可渲染 `ChatItem` 的归约层（Chat Pad「远程 DSH」数据层 · S4）。
 *
 * ## 来源与许可（改这个文件前先读）
 *
 * 本文件的主体归约逻辑**逐行搬运**自上游 `ds-harness-remote`（MIT）：
 *
 *   - `packages/app-core/src/state/event-reducer.ts`（844 行，零 RN 依赖）
 *     → `foldHistory` / `applyNativeEvent` / `settleTurnItems` / `reduceNativeEvent` /
 *       `addUserMessage` / `addAssistantMessage` / `applyAssistantChunk` / `applyToolCall` /
 *       `addApproval` / `resolveApproval` / `addQuestion` / `resolveQuestion` / `requestTurn` /
 *       `toolCallDetail` / `toolResultDetail` / `messageImages` / `nativeUsage` …
 *   - `packages/app-core/src/state/message-helpers.ts`
 *     → `mergeHistoryAndLive` / `insertTerminalLocalMessages` / `oldestSeq` / `prependHistory`
 *   - `packages/client-core/src/harness-alpha-client.ts`（线格式翻译的参考实现）
 *     → `historyEntriesFromRecords` / `entriesFromFollowValue` / `entriesFromChunkRun` /
 *       `expandAssistantStreamRecords` / `assistantStreamAttempt` / `nextTransientSeq` /
 *       `routeWaterfall` / `normalizeSurfaceOp`
 *
 * ```
 * MIT License
 *
 * Copyright (c) 2026 DSH Remote contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * ```
 *
 * ## 移植时只做了三类改动（都以 `[ChatPad 移植]` 标注）
 *
 * 1. import 改成本地类型：上游 `../types` 的 `ChatItem` 家族在本文件顶部原样重定义
 *    （**不要去改 `services/chat/types.ts`**，那是本地会话的另一套数据结构）。
 * 2. 把 RN 客户端的 mux 私有帧形状换成远端协议的真实线格式，翻译层在本文件下半部分
 *    （`RemoteTranscriptState` / `reduceSnapshot` / `reduceFollowItem` / `reduceEventsItem`）：
 *
 *    | 上游（RN mux）                                   | 远端协议（本文处理） |
 *    |---|---|
 *    | `MuxStreamFrame{rpcId, payload:{type:'session/event',sessionId,event,view}}` | `session/follow` item `{type:'event',event,view?}` |
 *    | `payload.type:'approval/requested'`              | `$events` item `{type:'waterfall',event:'approval/request',eventId,agentId,request}` |
 *    | `payload.type:'question/requested'`              | `$events` item `{type:'waterfall',event:'user-questions/request',…}` |
 *    | `payload.type:'approval/resolved' / 'question/resolved'` | `$events` item `{type:'cancel',eventId}` |
 *    | `applyMuxFrame()`                                | `reduceFollowItem()`（改名的唯一一处，见下） |
 *
 * 3. 新增 `tool-call-delta` 增量归约（`applyToolCallDelta`）：上游只在持久化的
 *    `tool/call` / `tool/result` 事件上建工具行，ChatPad 想在参数还在流式到达时就显示卡片。
 *
 * 其余函数名与原注释**刻意保留**，便于和上游逐行对照；改逻辑时请同步改两边。
 * 协议依据：`docs/protocol.md` §18（Harness 历史/事件）、§19（assistant-stream）、
 * `work/2026-11-21-chatpad接入DSH远程/input-B-rpc-surface.md` §2.3/§2.5/§2.6。
 */

/* ────────────────────────────────────────────────────────────────────────
 * 一、本地类型（上游 packages/app-core/src/types.ts 的 ChatItem 家族子集）
 * ──────────────────────────────────────────────────────────────────────── */

import { isOptimisticEcho } from './routing.js'

/** `ChatItem` 的公共字段（上游 `ChatItemBase`）。 */
export interface ChatItemBase {
  id: string
  sessionId: string
  createdAt: number
  /** 权威事件坐标；乐观行 / 无时间戳的帧上没有。 */
  nativeSeq?: number
  nativeTime?: number
  /** 首次出现的位置；工具结果更新同一行时保留。 */
  nativeOrderSeq?: number
  /** 最近一次更新（含瞬态 chunk 的小数 seq）。 */
  nativeRevisionSeq?: number
  turn?: string
  /** 权威的 turn/end 证据；该事件不会替换任何回复序列。 */
  turnEnd?: { reason: 'completed' | 'stopped' | 'failed'; time: number; detail?: string }
}

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** 图片展示信息；持久引用仍绑定到它所属的会话。 */
export interface ChatImage {
  attachmentId?: string
  sessionId?: string
  uri?: string
  name?: string
  mediaType?: string
  /** 编码后的字节长度（0.2.2 的读取契约要求带上）。 */
  bytes?: number
  width?: number
  height?: number
}

export interface ToolDisplayDetail {
  text: string
  format: 'code' | 'markdown'
  truncated?: boolean
}

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

export interface ChatMessage extends ChatItemBase {
  kind: 'message'
  role: 'user' | 'assistant' | 'system'
  text: string
  /** 原生 turn id：同一轮的多段 reasoning 靠它合并。 */
  replyGroup?: string
  reasoning?: string
  images?: ChatImage[]
  streaming?: boolean
  streamingPhase?: 'reasoning' | 'text'
  /** `session/prompt` 的 requestId，用来把乐观用户消息和 Host 回显对账。 */
  requestRpcId?: string
  /**
   * 本地乐观用户消息的投递状态：
   * `queued` 已发出待回显；`failed` Host 拒绝（保留重试材料）；
   * `unconfirmed` 超时/断线，结果未知；`canceled` 远端已不存在。
   */
  sendState?: 'queued' | 'failed' | 'unconfirmed' | 'canceled'
  /** 投递失败的可读原因（唯一的错误展示面）。 */
  sendError?: string
  /** Host inbox 已接纳这条本地 prompt（不得再回落到本地队列）。 */
  queuedAdopted?: boolean
  /** 上下文 / 系统注入行（不作为对话正文展示）。 */
  context?: boolean
  /** 只有 usage、没有可见内容的 assistant 行（用于按轮汇总 token）。 */
  usageOnly?: true
  usage?: {
    inputTokens: number
    outputTokens: number
    totalTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
  }
}

export interface ToolActivity extends ChatItemBase {
  kind: 'tool'
  toolName: string
  /** 官方工具名（与展示标题分开）。 */
  toolKey?: string
  images?: ChatImage[]
  arguments?: string
  summary?: string
  callDetail?: ToolDisplayDetail
  resultDetail?: ToolDisplayDetail
  /** 完整的原生结果元数据；不要截断进 ToolDisplayDetail。 */
  uiResultMeta?: unknown
  state: 'running' | 'finished' | 'failed'
}

export interface ApprovalActivity extends ChatItemBase {
  kind: 'approval'
  approvalId: string
  toolName: string
  callId?: string
  reason?: string
  /** `$events` 的 eventId（同时充当审批应答的 `$events/result.eventId`）。 */
  frameRpcId?: string
  outcome?: ApprovalOutcome
  /**
   * Host 若显式给了可选决定，这里只保留 v1 允许的两种。
   *
   * `allow_session` / session grant **一律丢弃**（协议安全不变量 8、`AGENTS.md` 的
   * Harness Carrier 节）：v1 只允许「允许一次 / 拒绝」。不给「保留但标灰」这种中间态，
   * 因为灰按钮仍然暗示「这条路存在」。
   */
  options?: ApprovalOption[]
}

/** v1 允许的审批决定（`$events/result` 的 `outcome.value`）。 */
export type ApprovalOption = 'allow_once' | 'deny'

/** 把 Host 给的决定列表按 v1 白名单过一遍；保留为空时返回 `undefined`（= 按默认两种处理）。 */
const approvalOptionsOf = (raw: unknown): ApprovalOption[] | undefined => {
  if (!Array.isArray(raw)) return undefined
  const kept = raw.filter((value): value is ApprovalOption => value === 'allow_once' || value === 'deny')
  return kept.length === 0 ? undefined : [...new Set(kept)]
}

/** 限时问答的可选项（对应官方 `AskUserQuestionOption`）。 */
export interface AskUserQuestionOption {
  label: string
  description?: string
}

/** 一条问题（对应官方 `AskUserQuestionItem`）。 */
export interface AskUserQuestionItem {
  id: string
  question: string
  detail?: string
  header?: string
  options?: AskUserQuestionOption[]
  multiSelect?: boolean
  intent?: { kind: 'plan-review'; approve: string }
}

export interface QuestionActivity extends ChatItemBase {
  kind: 'question'
  callId?: string
  questionState?: 'open' | 'continued'
  deadline?: number
  frameRpcId?: string
  questions: AskUserQuestionItem[]
  outcome?: 'answered' | 'cancelled' | 'queued'
}

/**
 * `present` 交付的一份文件 —— 官方 `PresentedFile` 的逐字段镜像
 * （`@deepseek-ai/dsh-tool-present/src/types.ts:5-10`）。
 */
export interface PresentedFile {
  /** 绝对路径，或相对 Session 工作目录的路径（Host 已按工作目录解析过）。 */
  path: string
  /** 模型给的说明（可选）。 */
  description?: string
}

/**
 * 一轮结束时 Agent **用官方 `present` 工具声明的交付文件**（「产物」）。
 *
 * 数据来源是 Session 日志里那条 **`deliverables/presented`** 事件
 * （`@deepseek-ai/dsh-tool-present/src/index.ts:101-109` 落库，
 * 事件签名见同包 `src/types.ts:12-16`），不是从别的工具参数里猜出来的：
 *
 * ```
 * { type: 'deliverables/presented', seq, time,
 *   data: { turn: 28, callId: 'call_…', files: [{ path, description }] } }
 * ```
 *
 * 官方 Web 客户端（`@deepseek-ai/dsh-client-ui-deliverables` 的
 * `turn-deliverables.ts:191-201`）与 dsh-Go（`app/lib/state/artifacts.dart:389`
 * 的 `presentedByTurn(events)`）读的是同一条事件。
 */
export interface ArtifactActivity extends ChatItemBase {
  kind: 'artifact'
  /** `present` 的 callId；同一轮调用多次就是多行。 */
  callId?: string
  /** 声明交付的文件（保持模型给的顺序，同路径去重）。 */
  files: PresentedFile[]
  /**
   * 这一行是怎么来的：
   *  - `event`：官方 `deliverables/presented` 事件（权威；`path` 已是 Host 解析值）；
   *  - `arguments`：`present` 的 `tool/call.arguments`（事件还没送达时的兜底，同 callId 会被事件覆盖）。
   */
  source: 'event' | 'arguments'
}

/** 会话时间线里可渲染的一行。与上游 `ChatItem` 一致，外加官方交付事件。 */
export type ChatItem = ChatMessage | ToolActivity | ApprovalActivity | QuestionActivity | ArtifactActivity

/** 原生会话事件（上游 `NativeSessionEvent` 的结构镜像；协议 §2.3 Session V3）。 */
export interface NativeSessionEvent {
  type: string
  seq: number
  time: number
  data: Record<string, unknown>
  sourceEventSeqs?: number[]
  surfaceOp?:
    | 'append'
    | { op: 'replace'; start: number; end: number }
    | { op: 'replace'; startSeq: number; endSeq: number }
  ignorable?: true
}

/** 一条历史记录：事件 + 可选的渲染视图（工具卡片的 `for:'call'|'result'`）。 */
export interface HistoryEntry {
  event: NativeSessionEvent
  view?: { for: 'call' | 'result'; view: unknown }
}

type UnknownRecord = Record<string, unknown>

const MAX_TOOL_DETAIL_CHARS = 64_000
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const DATA_IMAGE_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/u

/* ────────────────────────────────────────────────────────────────────────
 * 二、归约主体（搬运自 event-reducer.ts，函数名一致）
 * ──────────────────────────────────────────────────────────────────────── */

/** Fold a native history event window into ordered chat items. */
export function foldHistory(events: HistoryEntry[], sessionId: string, captureContext = false): ChatItem[] {
  let items: ChatItem[] = []
  for (const entry of events) {
    items = applyNativeEvent(items, entry.event, sessionId, entry.view, captureContext)
  }
  return items
}

/**
 * [ChatPad 移植] 上游这里是 `applyMuxFrame(current, frame: MuxStreamFrame, captureContext)`。
 * 远端协议没有 mux：一个 `session/follow` 的 item 就是一条事件，所以这里只保留
 * “把一条原生事件叠到时间线上”这件事，改名 `applyFollowEvent`，并让协议线格式的
 * 翻译（`reduceFollowItem`）负责拆 item。
 */
export function applyFollowEvent(
  current: ChatItem[],
  event: NativeSessionEvent,
  sessionId: string,
  view?: HistoryEntry['view'],
  captureContext = false,
): ChatItem[] {
  return applyNativeEvent(current, event, sessionId, view, captureContext)
}

/**
 * Project the Harness turn lifecycle carried by one native event into the session
 * list state. The message reducer intentionally ignores lifecycle events, but
 * the UI still needs `turn/end` to clear its generating indicator after a
 * completed or cancelled turn.
 *
 * [ChatPad 移植] 上游签名是 `sessionRunningForMuxFrame(frame)`，这里收窄成按事件判断。
 */
export function sessionRunningForEvent(event: NativeSessionEvent): boolean | undefined {
  if (event.type === 'turn/start') return true
  if (event.type === 'turn/end') return false
  return undefined
}

function applyNativeEvent(
  current: ChatItem[], event: NativeSessionEvent, sessionId: string, view?: HistoryEntry['view'], captureContext = false,
): ChatItem[] {
  if (event.type === 'turn/end') {
    const turn = replyGroup(event.data)
    if (turn === undefined) return current
    const reasonData = event.data.reason
    const kind = isRecord(reasonData) ? reasonData.kind : reasonData
    const reason: 'completed' | 'stopped' | 'failed' = kind === 'completed' ? 'completed'
      : kind === 'aborted' || kind === 'interrupted' ? 'stopped'
        : 'failed'
    // Keep the Host's failure detail (auth errors, rate limits, …): a turn that
    // fails before any output must still be visible with its reason (F14).
    // Official shape: `error: { kind: 'error', error: LlmFailure }` and hook
    // interruptions carry `reason: { reason }` — dig into both.
    const detail = turnEndDetail(reasonData)
    const settled: ChatItem[] = settleTurnItems(current, turn).map(item => item.turn === turn || (item.kind === 'message' && item.replyGroup === turn)
      ? { ...item, turnEnd: { reason, time: event.time, ...(detail === undefined ? {} : { detail }) } } : item)
    // User bubbles do not render turn-end state, and context/usage-only rows are hidden.
    // A turn with only those rows still needs a process row to carry the failure.
    const owned = settled.some(item => (item.kind !== 'message' || (item.role === 'assistant' && !item.context && !item.usageOnly))
      && (item.turn === turn || (item.kind === 'message' && item.replyGroup === turn)))
    // Only a real failure payload (kind 'failed'/'error') warrants the
    // synthetic row: a bare/legacy turn/end without `reason` must not be
    // rendered as a failure, and a stopped turn is user-initiated.
    if (owned || reason !== 'failed' || !isRecord(reasonData)) return settled
    const failureRow: ChatMessage = {
      kind: 'message',
      id: `turn-failure:${turn}`,
      sessionId,
      role: 'assistant',
      text: '',
      createdAt: event.time,
      turn,
      turnEnd: { reason, time: event.time, ...(detail === undefined ? {} : { detail }) },
    }
    return [...settled, failureRow]
  }
  if (event.type === 'turn/start') return reduceNativeEvent(current, event, sessionId, view)
  const contextEvent = event.type === 'system/message' || event.type === 'developer/message' || (event.type === 'user/message' && !isHumanUserMessage(event.data))
  const next = captureContext && contextEvent
    ? current.some(item => item.id === messageId(event.data)) ? current : [...current, {
        kind: 'message' as const, id: messageId(event.data), sessionId, role: 'system' as const,
        context: event.type !== 'system/message', text: messageText(event.data), createdAt: event.time,
      }]
    : reduceNativeEvent(current, event, sessionId, view)
  const time = typeof event.time === 'number' && Number.isFinite(event.time) && event.time > 0 ? event.time : undefined
  const usage = nativeUsage(event.data)
  const eventTurn = replyGroup(event.data)
  return next.map(item => {
    if (current.includes(item)) {
      if (eventTurn !== undefined && item.turn === undefined && (item.kind === 'approval' || item.kind === 'question') && item.outcome === undefined) {
        return { ...item, turn: eventTurn }
      }
      return item
    }
    const previous = current.find(old => old.id === item.id)
    const previousSeq = previous?.nativeRevisionSeq ?? previous?.nativeSeq
    if (previousSeq !== undefined && event.seq <= previousSeq) return previous!
    return {
      ...item,
      ...(Number.isSafeInteger(event.seq) && event.seq >= 0 ? { nativeSeq: event.seq } : {}),
      ...(Number.isFinite(event.seq) && event.seq >= 0 ? { nativeOrderSeq: item.nativeOrderSeq ?? event.seq } : {}),
      ...(Number.isFinite(event.seq) && event.seq >= 0 ? { nativeRevisionSeq: event.seq } : {}),
      ...(time === undefined ? {} : { createdAt: time, nativeTime: time }),
      ...(eventTurn === undefined ? {} : { turn: item.turn ?? eventTurn }),
      ...(item.kind === 'message' && usage !== undefined ? { usage } : {}),
    }
  })
}

/** Best-effort Host failure detail from the official turn/end reason shape. */
function turnEndDetail(reasonData: unknown): string | undefined {
  if (!isRecord(reasonData)) return stringValue(reasonData)
  const error = reasonData.error
  if (isRecord(error)) {
    const nested = error.error
    return stringValue(error.message ?? (isRecord(nested) ? nested.message ?? nested.error : nested) ?? error.reason)
  }
  const reason = reasonData.reason
  return stringValue(reasonData.message ?? reasonData.detail
    ?? (isRecord(reason) ? reason.reason ?? reason.message : reason))
}

function nativeUsage(data: UnknownRecord): ChatMessage['usage'] {
  const records = Array.isArray(data.stream) ? data.stream : []
  const last = [...records].reverse().find(row => isRecord(row) && row.type === 'chunk' && isRecord(row.chunk) && row.chunk.type === 'usage')
  const value = data.usage ?? (isRecord(last) && isRecord(last.chunk) ? last.chunk.usage : undefined)
  if (!isRecord(value)) return undefined
  const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
  if (!count(value.inputTokens) || !count(value.outputTokens)) return undefined
  const usage: NonNullable<ChatMessage['usage']> = { inputTokens: value.inputTokens, outputTokens: value.outputTokens }
  for (const key of ['totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const) {
    if (value[key] === undefined) continue
    if (!count(value[key])) return undefined
    usage[key] = value[key]
  }
  if (usage.reasoningTokens !== undefined && usage.reasoningTokens > usage.outputTokens) return undefined
  const knownPrompt = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  if (!Number.isSafeInteger(knownPrompt)) return undefined
  if (usage.totalTokens !== undefined && (usage.totalTokens < knownPrompt + usage.outputTokens
    || (usage.cacheReadTokens !== undefined && usage.cacheWriteTokens !== undefined && usage.totalTokens !== knownPrompt + usage.outputTokens))) return undefined
  if (usage.totalTokens === undefined && usage.cacheReadTokens !== undefined && usage.cacheWriteTokens !== undefined) {
    const total = knownPrompt + usage.outputTokens
    if (Number.isSafeInteger(total)) usage.totalTokens = total
  }
  return usage
}

function reduceNativeEvent(
  current: ChatItem[],
  event: NativeSessionEvent,
  sessionId: string,
  view?: HistoryEntry['view'],
): ChatItem[] {
  const data = isRecord(event.data) ? event.data : {}
  if (event.type === 'turn/end') return settleTurnItems(current, replyGroup(data))
  if (event.type === 'turn/start') {
    const turn = replyGroup(data)
    return turn === undefined ? current : settleTurnItems(current, undefined, turn)
  }
  if (event.type === 'user/message') return addUserMessage(current, data, sessionId)
  if (event.type === 'assistant/message') return addAssistantMessage(current, data, sessionId, event)
  if (event.type === 'assistant/chunk') return applyAssistantChunk(current, data, sessionId, event)
  if (event.type === 'assistant/attempt-abandoned') {
    const streamId = `stream:${stepKey(event)}`
    return current.some(item => item.kind === 'message' && item.streaming === true && item.id === streamId)
      ? current.filter(item => !(item.kind === 'message' && item.streaming === true && item.id === streamId))
      : current
  }
  if (event.type === 'tool/call') {
    // 同一 turn 里 `present` 的调用还要额外落一行产物（参数兜底，见 `applyPresentCall`）。
    return applyPresentCall(applyToolCall(current, data, sessionId, 'running', view), data, sessionId, event)
  }
  if (event.type === 'tool/result') return applyToolCall(current, data, sessionId, 'finished', view)
  // 官方交付事件（`present` 成功 → Host 落库），权威产物来源。
  if (event.type === 'deliverables/presented') return applyPresentedEvent(current, data, sessionId, event)
  return current
}

/** A closed turn must not leave stale streams or actionable approvals behind. */
export function settleTurnItems(current: ChatItem[], turn?: string, exceptTurn?: string): ChatItem[] {
  const hasOtherOwnedTurn = turn !== undefined && current.some(item => {
    const owner = item.turn ?? (item.kind === 'message' ? item.replyGroup : undefined)
    return owner !== undefined && owner !== turn
  })
  return current.map(item => {
    const owner = item.turn ?? (item.kind === 'message' ? item.replyGroup : undefined)
    if ((turn !== undefined && ((owner !== undefined && owner !== turn) || (owner === undefined && hasOtherOwnedTurn)))
      || (exceptTurn !== undefined && owner === exceptTurn)) return item
    // WHY: `$events` waterfalls can arrive before `turn/start` or `tool/call` on `session/follow`;
    // attach an unowned pending request to the active turn instead of cancelling it on turn open/reconcile.
    if (turn === undefined && exceptTurn !== undefined && owner === undefined
      && (item.kind === 'approval' || item.kind === 'question') && item.outcome === undefined) {
      return { ...item, turn: exceptTurn }
    }
    if (item.kind === 'message' && item.streaming) return { ...item, streaming: false, streamingPhase: undefined }
    // Without a result we cannot claim a tool succeeded.
    if (item.kind === 'tool' && item.state === 'running') return { ...item, state: 'failed' }
    if (item.kind === 'approval' && item.outcome === undefined) return { ...item, outcome: 'unavailable' }
    if (item.kind === 'question' && item.callId === undefined && item.outcome === undefined) return { ...item, outcome: 'cancelled' }
    return item
  })
}

function addUserMessage(current: ChatItem[], data: UnknownRecord, sessionId: string): ChatItem[] {
  // Harness also records model-facing plugin context (instructions, snapshots,
  // notices, and similar injected material) as `user/message`. Only the
  // explicit human source belongs in the conversation transcript.
  if (!isHumanUserMessage(data)) return current
  const id = messageId(data)
  const text = messageText(data)
  const persistedImages = messageImages(data, sessionId)
  if (text.length === 0 && persistedImages.length === 0) return current
  const rpcId = messageRequestRpcId(data)
  /*
   * [S4 串台修复] 乐观行对齐用 **(sessionId, requestRpcId) 二元组**，不是只比 rpcId。
   *
   * dsh-Go 的对应做法是 `chat_state.dart:1288-1297` `_dropEchoed`：拿回显事件里的
   * `requestId` 去 `_pending` 里删。而 `_pending` 是某个 `ChatController` 的字段
   * （`chat_state.dart:462-476`），天生带着 sessionId —— 所以那边「只比 requestId」
   * 其实等价于「(sessionId, requestId) 都对上」。
   *
   * 我们是一个 store、一份活动会话，没有那个天然隔离，必须把 sessionId 显式比一遍：
   * 否则一旦有历史遗留的「A 的乐观行留在 B 的列表里」，B 收到的回显会把它认领并替换，
   * 那条行就**真的是 A 的却显示在 B 里**，而 A 那边永远停在「发送中」。
   */
  const optimisticIndex = rpcId === undefined
    ? -1
    : current.findIndex(item => isOptimisticEcho(item, sessionId, rpcId))
  const optimistic = optimisticIndex < 0 ? undefined : current[optimisticIndex]
  const images = persistedImages.length > 0 ? persistedImages
    : optimistic?.kind === 'message' ? optimistic.images ?? [] : []
  const message: ChatMessage = {
    kind: 'message', id, sessionId, role: 'user', text, createdAt: now(data),
    ...(rpcId === undefined ? {} : { requestRpcId: rpcId }),
    ...(images.length === 0 ? {} : { images }),
  }
  if (optimisticIndex >= 0) {
    return current.map((item, index) => index === optimisticIndex ? message : item)
  }
  const existing = current.find(item => item.id === id)
  if (existing !== undefined) return current
  return [...current, message]
}

function isHumanUserMessage(data: UnknownRecord): boolean {
  const message = isRecord(data.message) ? data.message : data
  const source = isRecord(message.source) ? message.source : undefined
  return source?.kind === 'user'
}

function addAssistantMessage(current: ChatItem[], data: UnknownRecord, sessionId: string, event: NativeSessionEvent): ChatItem[] {
  const id = messageId(data)
  const text = messageText(data)
  const reasoning = messageReasoning(data)
  const images = messageImages(data, sessionId)
  const key = stepKey(event)
  const streamingIndex = current.findIndex(item =>
    item.kind === 'message' && item.streaming === true && item.id === `stream:${key}`)
  const streamed = streamingIndex < 0 ? undefined : current[streamingIndex]
  const finalText = hasVisibleMessageText(text)
    ? text
    : streamed?.kind === 'message' ? streamed.text : ''
  const finalReasoning = hasVisibleMessageText(reasoning)
    ? reasoning
    : streamed?.kind === 'message' ? streamed.reasoning : undefined
  const group = replyGroup(data) ?? (streamed?.kind === 'message' ? streamed.replyGroup : undefined)
  if (images.length === 0 && !hasVisibleMessageText(finalText) && !hasVisibleMessageText(finalReasoning ?? '')) {
    // Native assistant messages may contain only tool/content metadata. They
    // are not visible chat text, but when the step carries LLM usage we retain
    // a silent usage-only ledger row so multi-step turn totals stay accurate.
    if (group !== undefined && nativeUsage(data) !== undefined) {
      const ledger: ChatMessage = {
        kind: 'message', id, sessionId, role: 'assistant', text: '', createdAt: now(data),
        replyGroup: group, usageOnly: true,
      }
      if (streamingIndex >= 0) {
        return current.map((item, index) => index === streamingIndex ? ledger : item)
      }
      if (current.some(item => item.id === id)) return current
      return [...current, ledger]
    }
    if (streamingIndex < 0) return current
    return current.filter((_, index) => index !== streamingIndex)
  }
  const message: ChatMessage = {
    kind: 'message', id, sessionId, role: 'assistant', text: finalText, createdAt: now(data),
    ...(images.length === 0 ? {} : { images }),
    ...(group === undefined ? {} : { replyGroup: group }),
    ...(finalReasoning === undefined ? {} : { reasoning: finalReasoning }),
  }
  if (streamingIndex >= 0) {
    return current.map((item, index) => index === streamingIndex ? message : item)
  }
  const existing = current.find(item => item.id === id)
  if (existing !== undefined) return current
  return [...current, message]
}

function applyAssistantChunk(
  current: ChatItem[],
  data: UnknownRecord,
  sessionId: string,
  event: NativeSessionEvent,
): ChatItem[] {
  const chunk = isRecord(data.chunk) ? data.chunk : {}
  // [ChatPad 移植] 上游在这里直接 return；`tool-call-delta` 交给下面的补充实现。
  if (chunk.type === 'tool-call-delta') return applyToolCallDelta(current, chunk, sessionId, event)
  if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') return current
  const delta = typeof chunk.text === 'string' ? chunk.text : ''
  if (delta.length === 0) return current
  const key = stepKey(event)
  const streamId = `stream:${key}`
  const index = current.findIndex(item => item.id === streamId && item.kind === 'message')
  if (index < 0) {
    // Whitespace and format-control-only chunks are framing noise. Waiting for
    // visible text avoids creating an empty avatar/"Remote" row.
    if (!hasVisibleMessageText(delta)) return current
    return [...current, {
      kind: 'message', id: streamId, sessionId, role: 'assistant',
      ...(replyGroup(data) === undefined ? {} : { replyGroup: replyGroup(data) }),
      text: chunk.type === 'text-delta' ? delta : '',
      ...(chunk.type === 'reasoning-delta' ? { reasoning: delta } : {}),
      streaming: true,
      streamingPhase: chunk.type === 'reasoning-delta' ? 'reasoning' : 'text',
      createdAt: now(data),
    } satisfies ChatMessage]
  }
  return current.map((item, itemIndex) => itemIndex === index && item.kind === 'message'
    ? chunk.type === 'reasoning-delta'
      ? { ...item, reasoning: `${item.reasoning ?? ''}${delta}`, streaming: true, streamingPhase: 'reasoning' }
      : { ...item, text: `${item.text}${delta}`, streaming: true, streamingPhase: 'text' }
    : item)
}

/**
 * [ChatPad 补充] `tool-call-delta` 的增量归约（上游没有这一步）。
 *
 * 线格式（`packages/client-core/src/harness-alpha-client.ts:1854-1864` 的
 * `expandAssistantStreamRecords` 反推）：
 *   `{ type: 'tool-call-delta', index?, id?, name?, argumentsDelta }`
 * 已落库的等价块是 `{ type: 'tool-call-chunks', id?, name?, args: string[], dt, time0 }`，
 * 这里额外容忍 `deltas` / `delta` / `text` 三种历史字段名（见 input-B 附录 C 第 2 条）。
 *
 * 行的 id 优先用 `chunk.id`（即 callId），这样后面真正的 `tool/call` / `tool/result`
 * 事件会因为 id 相同而**合并到同一行**（`applyToolCall` 按 id 查已有行）。
 * 拿不到 callId 时用 `tool-pending:<turn>:<step>:<index>`，此时后续事件会另起一行
 * —— 属于已知降级（正式历史里 `tool/call` 一定带 callId）。
 */
function applyToolCallDelta(
  current: ChatItem[],
  chunk: UnknownRecord,
  sessionId: string,
  event: NativeSessionEvent,
): ChatItem[] {
  const callId = stringValue(chunk.callId) ?? stringValue(chunk.id)
  const index = typeof chunk.index === 'number' && Number.isFinite(chunk.index) ? String(chunk.index) : '0'
  const id = callId ?? `tool-pending:${stepKey(event)}:${index}`
  const delta = stringValue(chunk.argumentsDelta) ?? stringValue(chunk.delta)
    ?? stringValue(chunk.text) ?? stringValue(chunk.arguments) ?? ''
  const name = stringValue(chunk.name) ?? stringValue(chunk.toolName)
  const existing = current.find(item => item.id === id)
  if (existing?.kind === 'tool') {
    if (delta.length === 0 && name === undefined) return current
    return current.map(item => item.id === id && item.kind === 'tool'
      ? {
          ...item,
          ...(name === undefined ? {} : { toolName: name, toolKey: name }),
          ...(delta.length === 0 ? {} : { arguments: `${item.arguments ?? ''}${delta}` }),
          state: item.state === 'running' ? 'running' : item.state,
        }
      : item)
  }
  if (delta.length === 0 && name === undefined) return current
  const activity: ToolActivity = {
    kind: 'tool',
    id,
    sessionId,
    toolName: name ?? 'Tool',
    ...(name === undefined ? {} : { toolKey: name }),
    ...(delta.length === 0 ? {} : { arguments: delta }),
    state: 'running',
    createdAt: Number.isFinite(event.time) && event.time > 0 ? event.time : Date.now(),
  }
  return [...current, activity]
}

/** True when text contains something that can produce visible chat content. */
export function hasVisibleMessageText(text: string): boolean {
  return text.replace(/[\s\u00AD\u034F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/gu, '').length > 0
}

function applyToolCall(
  current: ChatItem[],
  data: UnknownRecord,
  sessionId: string,
  state: ToolActivity['state'],
  entryView?: HistoryEntry['view'],
): ChatItem[] {
  // Harness places the correlation id for a result on message.source. Using
  // only data.callId creates a second anonymous "Tool" row for every result.
  const message = isRecord(data.message) ? data.message : {}
  const source = isRecord(message.source) ? message.source : {}
  const id = stringValue(source.callId) ?? stringValue(data.callId) ?? stringValue(data.id) ?? localId('tool')
  const expectedView = state === 'running' ? 'call' : 'result'
  const view = entryView?.for === expectedView && isRecord(entryView.view) ? entryView.view : undefined
  const name = stringValue(view?.title) ?? stringValue(data.name) ?? stringValue(data.toolName) ?? 'Tool'
  const argumentsText = stringValue(data.arguments) ?? stringValue(data.argumentsDelta) ?? ''
  const summary = stringValue(view?.description) ?? stringValue(view?.cwd) ?? stringValue(data.summary)
  const detail = state === 'running'
    ? toolCallDetail(view, argumentsText)
    : toolResultDetail(view, data)
  const images = state === 'finished' ? messageImages(data, sessionId) : []
  const failed = state === 'finished' && toolResultFailed(data)
  const uiMeta = state === 'finished' && !failed && ['ui_render', 'ui_patch', 'ui_render_widget', 'ui_compose'].includes(stringValue(data.name) ?? stringValue(data.toolName) ?? (current.find(item => item.id === id && item.kind === 'tool') as ToolActivity | undefined)?.toolKey ?? '')
    ? data.meta : undefined
  const next: ToolActivity = {
    kind: 'tool',
    id,
    sessionId,
    toolName: name,
    // [ChatPad 移植] 上游这里还有 `remoteDetail`（远程工具详情跳转），ChatPad P0 没有那个页面，故略。
    ...(stringValue(data.name) ?? stringValue(data.toolName) ? { toolKey: stringValue(data.name) ?? stringValue(data.toolName) } : {}),
    ...(argumentsText.length > 0 ? { arguments: argumentsText } : {}),
    ...(summary === undefined ? {} : { summary }),
    ...(uiMeta === undefined ? {} : { uiResultMeta: uiMeta }),
    ...(state === 'running' && detail !== undefined ? { callDetail: detail } : {}),
    ...(state === 'finished' && detail !== undefined ? { resultDetail: detail } : {}),
    ...(images.length === 0 ? {} : { images }),
    state: failed ? 'failed' : state,
    createdAt: now(data),
  }
  const existing = current.find(item => item.id === id)
  if (existing?.kind !== 'tool') return [...current, next]
  return current.map(item => item.id === id && item.kind === 'tool'
    ? {
        ...item,
        toolName: name === 'Tool' ? item.toolName : name,
        ...(next.toolKey === undefined ? {} : { toolKey: next.toolKey }),
        ...(summary === undefined ? {} : { summary }),
        ...(next.callDetail === undefined ? {} : { callDetail: next.callDetail }),
        ...(next.resultDetail === undefined ? {} : { resultDetail: next.resultDetail }),
        // A new terminal result must not inherit an earlier success marker.
        ...(state === 'finished' ? { uiResultMeta: next.uiResultMeta } : {}),
        ...(state === 'finished' ? { images: next.images } : {}),
        state: next.state,
      }
    : item)
}

/* ────────────────────────────────────────────────────────────────────────
 * 交付文件（产物）：官方 `present` 工具 + `deliverables/presented` 事件
 *
 * 这一节**不猜产物**：只认两处官方数据 ——
 *   1. `deliverables/presented` 事件（权威，Host 落库）；
 *   2. `present` 工具的 `tool/call.arguments`（同 callId 的兜底，事件到了就替换）。
 * 写类工具（`write` / `edit` / `str_replace_editor`）在这条链路上**不产生**产物行：
 * 官方 Web 客户端把它们算进「本次改动的文件」（`workspace/changes` + `changed-files` 卡），
 * 与「交付给用户的文件」是两张卡（`dsh-client-ui-deliverables/src/client/turn-deliverables.ts:1-7`）。
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * `PresentedFile[]` 的收口校验（等价官方 `isPresentedFile()`，
 * `dsh-client-ui-deliverables/src/presented.ts:49-54`）：
 * `path` 必须是非空字符串，`description` 要么没有要么是字符串。
 *
 * **不在这里按路径去重**：官方 `presentedForClosing()`（`turn-deliverables.ts:261-265`）
 * 是「同路径留最新那份、位置按首次出现」，那一步在 `artifacts.ts` 的 `filesOf()` 里做。
 * 这里只负责「哪些条目算合法的 `PresentedFile`」。
 */
function presentedFiles(value: unknown): PresentedFile[] {
  if (!Array.isArray(value)) return []
  const files: PresentedFile[] = []
  for (const entry of value) {
    if (!isRecord(entry) || Array.isArray(entry)) continue
    const path = stringValue(entry.path)
    if (path === undefined || path.trim().length === 0) continue
    const description = stringValue(entry.description)
    files.push(description === undefined ? { path } : { path, description })
  }
  return files
}

/** 产物行的 id：同一个 `present` 调用只占一行（`arguments` 兜底与事件共用它）。 */
function presentedItemId(callId: string | undefined, turn: string | undefined, seq: number): string {
  if (callId !== undefined && callId.length > 0) return `presented:${callId}`
  return `presented:${turn ?? '?'}:${Number.isSafeInteger(seq) ? seq : 0}`
}

/**
 * 落一行 `ArtifactActivity`。
 *
 * 合并规则（唯一一处）：同一个 callId 只留一行 —— `present` 的 `tool/call`
 * 通常先到（兜底 `source:'arguments'`），随后 `deliverables/presented` 到达时
 * **整体替换**成 `source:'event'`（路径此时已是 Host 解析后的值）。反过来
 * （事件先到、参数后到）不会把权威行降级。
 */
function applyArtifact(
  current: ChatItem[],
  presented: { turn?: string; callId?: string; files: PresentedFile[]; source: ArtifactActivity['source'] },
  sessionId: string,
  event: NativeSessionEvent,
): ChatItem[] {
  if (presented.files.length === 0) return current
  const id = presentedItemId(presented.callId, presented.turn, event.seq)
  const existing = current.find(item => item.id === id)
  if (existing?.kind === 'artifact') {
    if (presented.source !== 'event' && existing.source === 'event') return current
    return current.map(item => item.id === id && item.kind === 'artifact'
      ? {
          ...item,
          files: presented.files,
          source: presented.source,
          ...(presented.turn === undefined ? {} : { turn: presented.turn }),
          ...(presented.callId === undefined ? {} : { callId: presented.callId }),
        }
      : item)
  }
  const activity: ArtifactActivity = {
    kind: 'artifact',
    id,
    sessionId,
    createdAt: Number.isFinite(event.time) && event.time > 0 ? event.time : Date.now(),
    ...(presented.turn === undefined ? {} : { turn: presented.turn }),
    ...(presented.callId === undefined ? {} : { callId: presented.callId }),
    files: presented.files,
    source: presented.source,
  }
  return [...current, activity]
}

/**
 * `deliverables/presented` 的归约。
 *
 * 事件形状（官方 `SessionEventMap` 扩展，`dsh-tool-present/src/types.ts:12-16`）：
 * `{ turn: number; callId: string; files: PresentedFile[] }`。校验照抄官方
 * `isPresentedData()`（`dsh-client-ui-deliverables/src/presented.ts:72-77`）：
 * `turn` 是 >= 1 的安全整数、`callId` 非空、`files` 是数组；不合格整条忽略。
 */
function applyPresentedEvent(
  current: ChatItem[],
  data: UnknownRecord,
  sessionId: string,
  event: NativeSessionEvent,
): ChatItem[] {
  const turn = data.turn
  if (typeof turn !== 'number' || !Number.isSafeInteger(turn) || turn < 1) return current
  const callId = stringValue(data.callId)
  if (callId === undefined || callId.length === 0) return current
  if (!Array.isArray(data.files)) return current
  return applyArtifact(
    current,
    { turn: String(turn), callId, files: presentedFiles(data.files), source: 'event' },
    sessionId,
    event,
  )
}

/**
 * `present` 的 `tool/call` 兜底：参数 schema 是 `{ files: [{ path, description? }] }`
 * （`@deepseek-ai/dsh-tool-present/src/index.ts:45-58`）。
 *
 * 为什么留着这条：远端 `session/follow` 的窗口可能从 `deliverables/presented`
 * **之后**开始（上翻/重连），此时权威事件不在窗口里，只有工具调用还在。
 * dsh-Go 的工具行也读这份参数（`app/lib/ui/chat/tool_view.dart:246-251`），
 * 所以这不是自创识别 —— 读的是同一个工具的公开 schema。
 */
function applyPresentCall(
  current: ChatItem[],
  data: UnknownRecord,
  sessionId: string,
  event: NativeSessionEvent,
): ChatItem[] {
  const name = stringValue(data.name) ?? stringValue(data.toolName)
  if (name !== 'present') return current
  const args = jsonObjectOf(data.arguments)
  const files = presentedFiles(args?.files)
  if (files.length === 0) return current
  const callId = stringValue(data.callId)
  return applyArtifact(current, {
    ...(replyGroup(data) === undefined ? {} : { turn: replyGroup(data) }),
    ...(callId === undefined ? {} : { callId }),
    files,
    source: 'arguments',
  }, sessionId, event)
}

/** 工具参数是模型流式拼出来的 JSON 字符串；解析不出来就当没有（绝不猜）。 */
function jsonObjectOf(value: unknown): UnknownRecord | undefined {
  if (isRecord(value) && !Array.isArray(value)) return value
  if (typeof value !== 'string' || value.length === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function toolCallDetail(view: UnknownRecord | undefined, argumentsText: string): ToolDisplayDetail | undefined {
  if (view !== undefined) {
    const card = stringValue(view.card)
    if (card === 'terminal') {
      const command = stringValue(view.title)
      const cwd = stringValue(view.cwd)
      const text = [cwd === undefined ? undefined : `cwd: ${cwd}`, command === undefined ? undefined : `$ ${command}`]
        .filter((value): value is string => value !== undefined).join('\n')
      const detail = boundedToolDetail(text, 'code')
      if (detail !== undefined) return detail
    }
    if (card === 'diff') {
      const detail = boundedToolDetail(formatDiffs(view.diffs), 'code')
      if (detail !== undefined) return detail
    }
    if (card === 'generic') {
      const rawInput = displayJson(view.rawInput)
      const content = contentBlocksText(view.content)
      const detail = boundedToolDetail([rawInput, content].filter(isVisibleString).join('\n\n'), content === undefined ? 'code' : 'markdown')
      if (detail !== undefined) return detail
    }
  }
  return boundedToolDetail(prettyJsonString(argumentsText), 'code')
}

function toolResultDetail(view: UnknownRecord | undefined, data: UnknownRecord): ToolDisplayDetail | undefined {
  if (view !== undefined) {
    const card = stringValue(view.card)
    if (card === 'terminal') {
      const output = stringValue(view.output)
      const exitCode = typeof view.exitCode === 'number' ? `exit: ${view.exitCode}` : undefined
      const signal = stringValue(view.signal)
      const detail = boundedToolDetail([output, exitCode, signal === undefined ? undefined : `signal: ${signal}`]
        .filter((value): value is string => value !== undefined).join('\n'), 'code')
      if (detail !== undefined) return detail
    }
    if (card === 'diff') {
      const detail = boundedToolDetail(formatDiffs(view.diffs), 'code')
      if (detail !== undefined) return detail
    }
    if (card === 'search') {
      const detail = boundedToolDetail(formatSearchResult(view), 'code')
      if (detail !== undefined) return detail
    }
    if (card === 'read') {
      const detail = boundedToolDetail(formatReadResult(view), 'code')
        ?? boundedToolDetail(contentBlocksText(view.content), 'markdown')
      if (detail !== undefined) return detail
    }
    if (card === 'web') {
      const detail = boundedToolDetail(formatWebResult(view), 'markdown')
      if (detail !== undefined) return detail
    }
    if (card === 'generic') {
      const detail = boundedToolDetail(contentBlocksText(view.content), 'markdown')
      if (detail !== undefined) return detail
    }
  }
  return boundedToolDetail(toolResultContentText(data), 'markdown')
}

function toolResultContentText(data: UnknownRecord): string | undefined {
  const message = isRecord(data.message) ? data.message : {}
  const blocks = Array.isArray(message.content) ? message.content : []
  const nested = blocks.flatMap(block => isRecord(block) && block.type === 'tool-result' && Array.isArray(block.content)
    ? block.content
    : [block])
  return contentBlocksText(nested)
}

function toolResultFailed(data: UnknownRecord): boolean {
  if (isRecord(data.error) || data.isError === true) return true
  const message = isRecord(data.message) ? data.message : {}
  if (message.isError === true) return true
  const blocks = Array.isArray(message.content) ? message.content : []
  return blocks.some(block => isRecord(block) && block.type === 'tool-result' && block.isError === true)
}

function contentBlocksText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  const chunks = value.flatMap(block => {
    if (!isRecord(block)) return []
    if ((block.type === 'text' || block.type === 'reasoning') && typeof block.text === 'string') return [block.text]
    if (block.type === 'image') return ['[图片]']
    if (block.type === 'tool-result') return [contentBlocksText(block.content) ?? '']
    const fallback = displayJson(block)
    return fallback === undefined ? [] : [fallback]
  }).filter(isVisibleString)
  return chunks.length === 0 ? undefined : chunks.join('\n\n')
}

function formatDiffs(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  const diffs = value.flatMap(item => {
    if (!isRecord(item)) return []
    const path = stringValue(item.path)
    const newText = stringValue(item.newText)
    if (path === undefined || newText === undefined) return []
    const oldText = item.oldText === null ? '(新文件)' : stringValue(item.oldText) ?? ''
    return [`文件: ${path}\n\n--- 修改前 ---\n${oldText}\n\n+++ 修改后 +++\n${newText}`]
  })
  return diffs.length === 0 ? undefined : diffs.join('\n\n')
}

function formatSearchResult(view: UnknownRecord): string | undefined {
  if (view.shape === 'paths' && Array.isArray(view.paths)) {
    return view.paths.filter((path): path is string => typeof path === 'string').join('\n')
  }
  if (view.shape !== 'matches' || !Array.isArray(view.files)) return undefined
  const files = view.files.flatMap(file => {
    if (!isRecord(file) || typeof file.path !== 'string' || !Array.isArray(file.matches)) return []
    const matches = file.matches.flatMap(match => isRecord(match) && typeof match.line === 'string'
      ? [`${typeof match.lineNumber === 'number' ? `${match.lineNumber}: ` : ''}${match.line}`]
      : [])
    return [`${file.path}\n${matches.join('\n')}`]
  })
  return files.length === 0 ? undefined : files.join('\n\n')
}

function formatReadResult(view: UnknownRecord): string | undefined {
  if (!Array.isArray(view.lines)) return undefined
  const path = stringValue(view.path)
  const lines = view.lines.flatMap(line => isRecord(line) && typeof line.text === 'string'
    ? [`${typeof line.number === 'number' ? `${line.number} | ` : ''}${line.text}`]
    : [])
  const header = [path, typeof view.totalLines === 'number' ? `共 ${view.totalLines} 行` : undefined]
    .filter((value): value is string => value !== undefined).join(' · ')
  return [header, lines.join('\n')].filter(isVisibleString).join('\n')
}

function formatWebResult(view: UnknownRecord): string | undefined {
  if (view.kind === 'fetch') {
    const url = stringValue(view.url)
    const status = typeof view.statusCode === 'number' ? `HTTP ${view.statusCode}` : undefined
    return [status, url].filter((value): value is string => value !== undefined).join('\n')
  }
  if (view.kind !== 'search' || !Array.isArray(view.sources)) return undefined
  const answer = stringValue(view.answer)
  const sources = view.sources.flatMap(source => {
    if (!isRecord(source) || typeof source.url !== 'string') return []
    return [[stringValue(source.title), source.url, stringValue(source.snippet)]
      .filter((value): value is string => value !== undefined).join('\n')]
  })
  return [answer, ...sources].filter(isVisibleString).join('\n\n')
}

function prettyJsonString(value: string): string | undefined {
  if (!isVisibleString(value)) return undefined
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

function displayJson(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function boundedToolDetail(text: string | undefined, format: ToolDisplayDetail['format']): ToolDisplayDetail | undefined {
  if (!isVisibleString(text)) return undefined
  if (text.length <= MAX_TOOL_DETAIL_CHARS) return { text, format }
  return { text: text.slice(0, MAX_TOOL_DETAIL_CHARS), format, truncated: true }
}

function isVisibleString(value: string | undefined): value is string {
  return value !== undefined && hasVisibleMessageText(value)
}

/**
 * [ChatPad 移植] 上游签名是 `addApproval(current, payload, frameRpcId)`，`payload` 里带
 * `approvalId` / `sessionId` / `toolName` / `callId` / `reason`。远端协议里这些字段来自
 * `$events` 的 waterfall（`eventId` 即 approvalId，`agentId` 即 sessionId），
 * 由 `reduceEventsItem` 组装成同一个形状后再调用。
 */
function addApproval(current: ChatItem[], payload: UnknownRecord, frameRpcId: string): ChatItem[] {
  const approvalId = stringValue(payload.approvalId)
  const sessionId = stringValue(payload.sessionId)
  if (approvalId === undefined || sessionId === undefined) return current
  const id = `approval:${approvalId}`
  const existing = current.find(item => item.id === id)
  const callId = stringValue(payload.callId)
  const turn = requestTurn(current, payload, callId)
  const options = approvalOptionsOf(payload.options ?? payload.decisions)
  const activity: ApprovalActivity = {
    kind: 'approval' as const,
    id,
    sessionId,
    approvalId,
    toolName: stringValue(payload.toolName) ?? 'Harness',
    ...(callId === undefined ? {} : { callId }),
    ...(turn === undefined ? {} : { turn }),
    ...(stringValue(payload.reason) === undefined ? {} : { reason: stringValue(payload.reason) }),
    ...(frameRpcId.length === 0 ? {} : { frameRpcId }),
    ...(options === undefined ? {} : { options }),
    createdAt: Date.now(),
  }
  if (existing === undefined) return [...current, activity]
  // 同一 eventId 只留一张卡（Host 断线重连会**重投同一 eventId**，见协议 §2.6）。
  // 已经有结论的（allowed-once / rejected / cancelled / unavailable）一律不再翻回 pending：
  // 「已失效」的卡片被重投拉回等待，用户会对着一条死句柄反复点。
  if (existing.kind === 'approval' && existing.outcome !== undefined) return current
  return current.map(item => item.id === id ? {
    ...activity,
    createdAt: item.createdAt,
    ...(item.turn !== undefined && activity.turn === undefined ? { turn: item.turn } : {}),
  } : item)
}

function resolveApproval(current: ChatItem[], payload: UnknownRecord): ChatItem[] {
  const approvalId = stringValue(payload.approvalId)
  const outcome = stringValue(payload.outcome)
  if (approvalId === undefined || outcome === undefined) return current
  if (outcome !== 'allowed-once' && outcome !== 'rejected' && outcome !== 'cancelled' && outcome !== 'unavailable') return current
  return current.map(item => item.kind === 'approval' && item.approvalId === approvalId
    ? { ...item, outcome: outcome as ApprovalOutcome }
    : item)
}

function addQuestion(current: ChatItem[], payload: UnknownRecord, frameRpcId: string): ChatItem[] {
  const sessionId = stringValue(payload.sessionId)
  const questions = Array.isArray(payload.questions) ? payload.questions : []
  if (sessionId === undefined || questions.length === 0) return current
  const id = `question:${frameRpcId || questions[0]?.id || localId('question')}`
  const existing = current.find(item => item.id === id)
  const callId = typeof payload.callId === 'string' ? payload.callId : undefined
  const turn = requestTurn(current, payload, callId)
  const activity: QuestionActivity = {
    kind: 'question',
    ...(callId === undefined ? {} : { callId }),
    ...(payload.questionState === 'open' || payload.questionState === 'continued' ? { questionState: payload.questionState } : {}),
    ...(typeof payload.deadline === 'number' ? { deadline: payload.deadline } : {}),
    id,
    sessionId,
    ...(turn === undefined ? {} : { turn }),
    ...(frameRpcId.length === 0 ? {} : { frameRpcId }),
    questions: questions as AskUserQuestionItem[],
    createdAt: Date.now(),
  }
  if (existing === undefined) return [...current, activity]
  return current.map(item => {
    if (item.id !== id) return item
    // 终态粘住（answered / queued / cancelled）：重投同一 eventId 不能把答过的卡翻回可答，
    // 也不能把 Host 已经撤回的那条重新弹出来让人答。
    if (item.kind === 'question' && item.outcome !== undefined) return item
    return {
      ...activity,
      createdAt: item.createdAt,
      ...(item.turn !== undefined && activity.turn === undefined ? { turn: item.turn } : {}),
    }
  })
}

/** Approval/question frames may omit their turn; use the active transcript owner. */
function requestTurn(current: ChatItem[], payload: UnknownRecord, callId?: string): string | undefined {
  const explicit = replyGroup(payload)
  if (explicit !== undefined) return explicit
  if (callId !== undefined) {
    const matched = current.find(item => item.kind === 'tool' && (item.id === callId || item.id.endsWith(`:${callId}`)))
    if (matched?.turn !== undefined) return matched.turn
  }
  for (let index = current.length - 1; index >= 0; index -= 1) {
    const item = current[index]!
    if (item.turnEnd !== undefined) return undefined
    const owner = item.turn ?? (item.kind === 'message' ? item.replyGroup : undefined)
    if (owner !== undefined) return owner
    if (item.kind === 'message' && item.role === 'user' && !item.context) return undefined
  }
  return undefined
}

function resolveQuestion(current: ChatItem[], payload: UnknownRecord): ChatItem[] {
  const questionRpcId = stringValue(payload.questionRpcId)
  const outcome = stringValue(payload.outcome)
  if (questionRpcId === undefined || outcome === undefined) return current
  return current.map(item => item.kind === 'question' && item.frameRpcId === questionRpcId
    ? { ...item, outcome: outcome === 'answered' ? 'answered' as const : outcome === 'queued' ? 'queued' as const : 'cancelled' as const }
    : item)
}

/* ── 消息字段抽取（event-reducer.ts 的私有工具，逐行搬运） ─────────────── */

function messageId(data: UnknownRecord): string {
  const message = isRecord(data.message) ? data.message : data
  return stringValue(message.id) ?? localId('message')
}

function messageText(data: UnknownRecord): string {
  const message = isRecord(data.message) ? data.message : data
  const content = Array.isArray(message.content) ? message.content : []
  return content.flatMap(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string'
    ? [block.text]
    : []).join('\n')
}

function messageReasoning(data: UnknownRecord): string {
  const message = isRecord(data.message) ? data.message : data
  const content = Array.isArray(message.content) ? message.content : []
  return content.flatMap(block => isRecord(block) && block.type === 'reasoning' && typeof block.text === 'string'
    ? [block.text]
    : []).join('\n')
}

function messageImages(data: UnknownRecord, sessionId: string): NonNullable<ChatMessage['images']> {
  const message = isRecord(data.message) ? data.message : data
  const content = Array.isArray(message.content) ? message.content : []
  const blocks = content.flatMap(block => isRecord(block) && block.type === 'tool-result' && Array.isArray(block.content) ? block.content : [block])
  return blocks.flatMap(block => {
    if (!isRecord(block) || block.type !== 'image') return []
    const attachment: Record<string, unknown> = isRecord(block.attachment) ? block.attachment : {}
    const attachmentId = stringValue(block.attachmentId) ?? stringValue(attachment.attachmentId)
    const uri = imageDataUri(block)
    if (uri === undefined && attachmentId === undefined) return []
    // Image attachments have been recorded under several field names across
    // Harness releases; accept whichever variant the Host persisted.
    const name = firstString(block, ['name']) ?? firstString(attachment, ['name', 'fileName'])
    const mediaType = firstString(block, ['mediaType'])
      ?? firstString(attachment, ['mediaType', 'mimeType', 'contentType'])
    const bytes = firstNumber(block, ['bytes'])
      ?? firstNumber(attachment, ['bytes', 'byteLength', 'size'])
    const width = firstNumber(block, ['width']) ?? firstNumber(attachment, ['width', 'imageWidth'])
    const height = firstNumber(block, ['height']) ?? firstNumber(attachment, ['height', 'imageHeight'])
    return [{
      ...(attachmentId === undefined ? {} : { attachmentId, sessionId }),
      ...(uri === undefined ? {} : { uri }),
      ...(name === undefined ? {} : { name }),
      ...(mediaType === undefined ? {} : { mediaType }),
      ...(bytes === undefined ? {} : { bytes }),
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
    }]
  })
}

/** Return the first string/number value found under any of the candidate keys. */
function firstString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringValue(source[key])
    if (value !== undefined) return value
  }
  return undefined
}
function firstNumber(source: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

function imageDataUri(block: UnknownRecord): string | undefined {
  const url = stringValue(block.url) ?? stringValue(block.uri)
  const parsed = url === undefined ? undefined : parseDataImageUrl(url)
  if (parsed !== undefined) return parsed
  const data = stringValue(block.data)
  const mediaType = stringValue(block.mediaType)
  if (data === undefined || mediaType === undefined || !IMAGE_MEDIA_TYPES.has(mediaType) || !isCanonicalBase64(data)) {
    return undefined
  }
  return `data:${mediaType};base64,${data}`
}

function parseDataImageUrl(value: string): string | undefined {
  const match = DATA_IMAGE_URL.exec(value)
  if (match === null) return undefined
  const mediaType = match[1]!
  const data = match[2]!
  if (!IMAGE_MEDIA_TYPES.has(mediaType) || !isCanonicalBase64(data)) return undefined
  return `data:${mediaType};base64,${data}`
}

function isCanonicalBase64(value: string): boolean {
  return value.length >= 4 && value.length % 4 === 0
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
}

function messageRequestRpcId(data: UnknownRecord): string | undefined {
  const message = isRecord(data.message) ? data.message : data
  const source = isRecord(message.source) ? message.source : undefined
  return source?.kind === 'user' ? stringValue(source.rpcId) : undefined
}

function historyView(value: unknown): HistoryEntry['view'] | undefined {
  if (!isRecord(value) || (value.for !== 'call' && value.for !== 'result')) return undefined
  return { for: value.for, view: value.view }
}

function stepKey(event: NativeSessionEvent): string {
  const data = isRecord(event.data) ? event.data : {}
  return `${keyPart(data.turn)}:${keyPart(data.step)}`
}

function replyGroup(data: UnknownRecord): string | undefined {
  const turn = data.turn
  return typeof turn === 'string' || typeof turn === 'number' ? String(turn) : undefined
}

function now(data: UnknownRecord): number {
  return typeof data.time === 'number' ? data.time : Date.now()
}

function keyPart(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '?'
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function localId(prefix: string): string {
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2)}`
}

/* ────────────────────────────────────────────────────────────────────────
 * 三、历史页合并（搬运自 message-helpers.ts）
 * ──────────────────────────────────────────────────────────────────────── */

/** True for local optimistic rows in a terminal/settled state without native ordering. */
export function isTerminalLocalMessage(item: ChatItem): boolean {
  return item.kind === 'message'
    && item.id.startsWith('local:')
    && item.nativeOrderSeq === undefined
    && item.nativeSeq === undefined
    && (item.sendState === 'failed' || item.sendState === 'unconfirmed' || item.sendState === 'canceled')
}

function authoritativeTimestamp(item: ChatItem): number | undefined {
  if (item.nativeTime !== undefined && Number.isFinite(item.nativeTime) && item.nativeTime > 0) return item.nativeTime
  if (item.nativeSeq === undefined && item.nativeOrderSeq === undefined && Number.isFinite(item.createdAt) && item.createdAt > 0) {
    return item.createdAt
  }
  return undefined
}

function isInFlightLocalMessage(item: ChatItem): boolean {
  return item.kind === 'message'
    && item.id.startsWith('local:')
    && item.nativeOrderSeq === undefined
    && item.nativeSeq === undefined
    && (item.sendState === undefined || item.sendState === 'queued')
}

/**
 * Re-insert settled/failed local messages near their original timestamp among
 * merged history items, keeping still-in-flight (`sending`/`queued`) optimistic
 * rows at the tail and preserving relative order when timestamps tie or are absent.
 */
export function insertTerminalLocalMessages(base: ChatItem[], terminalLocals: ChatItem[]): ChatItem[] {
  if (terminalLocals.length === 0) return base
  const orderedLocals = [...terminalLocals].sort((a, b) => {
    const left = Number.isFinite(a.createdAt) && a.createdAt > 0 ? a.createdAt : undefined
    const right = Number.isFinite(b.createdAt) && b.createdAt > 0 ? b.createdAt : undefined
    if (left === undefined && right === undefined) return 0
    if (left === undefined) return 1
    if (right === undefined) return -1
    return left - right
  })
  const output = [...base]
  for (const local of orderedLocals) {
    const localTime = Number.isFinite(local.createdAt) && local.createdAt > 0 ? local.createdAt : undefined
    const inFlightIndex = output.findIndex(isInFlightLocalMessage)
    const searchLimit = inFlightIndex === -1 ? output.length : inFlightIndex
    let insertAt = searchLimit
    if (localTime !== undefined) {
      for (let index = 0; index < searchLimit; index += 1) {
        const candidateTime = authoritativeTimestamp(output[index]!)
        if (candidateTime !== undefined && candidateTime > localTime) {
          insertAt = index
          break
        }
      }
    }
    output.splice(insertAt, 0, local)
  }
  return output
}

/**
 * Merge a history window with the live timeline. Duplicate ids are resolved in
 * favour of the row with the newer native revision, optimistic rows whose
 * prompt already echoed in history are dropped, and the result is ordered by
 * `nativeOrderSeq` with terminal local rows re-inserted by timestamp.
 */
export function mergeHistoryAndLive(history: ChatItem[], live: ChatItem[], throughSeq?: number): ChatItem[] {
  const liveById = new Map(live.map(item => [item.id, item]))
  const historyIds = new Set(history.map(item => item.id))
  const boundary = throughSeq ?? Math.max(-1, ...history.map(item => item.nativeSeq ?? item.nativeOrderSeq ?? -1))
  const requests = new Set(history.flatMap(item => item.kind === 'message' && item.requestRpcId !== undefined ? [item.requestRpcId] : []))
  const closedTurns = new Set(history.flatMap(item => {
    if (item.turnEnd === undefined) return []
    const owner = item.turn ?? (item.kind === 'message' ? item.replyGroup : undefined)
    return owner === undefined ? [] : [owner]
  }))
  const activeHistoryTurn = (() => {
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const item = history[index]!
      if (item.turnEnd !== undefined) return undefined
      const owner = item.turn ?? (item.kind === 'message' ? item.replyGroup : undefined)
      if (owner !== undefined) return owner
      if (item.kind === 'message' && item.role === 'user' && !item.context) return undefined
    }
    return undefined
  })()
  const resolveInteractionTurn = (item: Extract<ChatItem, { kind: 'approval' | 'question' }>): string | undefined => {
    if (item.callId !== undefined) {
      const matched = history.find(row => row.kind === 'tool' && row.id === item.callId)
      if (matched?.turn !== undefined) return matched.turn
    }
    if (item.outcome === undefined) {
      const runningTool = [...history].reverse().find(row => row.kind === 'tool' && row.state === 'running'
        && (item.kind === 'approval' || (row.toolKey ?? row.toolName) === 'ask_user_question'))
      if (runningTool?.turn !== undefined) return runningTool.turn
      if (activeHistoryTurn !== undefined && (item.turn === undefined || closedTurns.has(item.turn))) {
        return activeHistoryTurn
      }
    }
    return item.turn
  }
  const result = [
    ...history.map(item => {
      const cached = liveById.get(item.id)
      if (cached === undefined) return item
      const historySeq = item.nativeRevisionSeq ?? item.nativeSeq ?? item.nativeOrderSeq ?? -1
      const liveSeq = cached.nativeRevisionSeq ?? cached.nativeSeq ?? cached.nativeOrderSeq ?? -1
      const authoritative = liveSeq > historySeq ? cached : item
      return authoritative.kind === 'message' && cached.kind === 'message'
        ? { ...authoritative, ...(authoritative.role === 'user' && authoritative.images === undefined && cached.images !== undefined ? { images: cached.images } : {}) }
        : authoritative
    }),
    ...live.filter(item => {
      if (historyIds.has(item.id)) return false
      if (item.kind === 'message' && item.requestRpcId !== undefined && requests.has(item.requestRpcId)) return false
      // A follow snapshot replaces transient chunks already covered by its cursor.
      if (item.kind === 'message' && item.streaming && (item.nativeRevisionSeq ?? item.nativeSeq ?? item.nativeOrderSeq ?? Infinity) <= boundary) return false
      return true
    }).map(item => {
      if (item.kind !== 'approval' && item.kind !== 'question') return item
      const turn = resolveInteractionTurn(item)
      return turn === item.turn ? item : { ...item, ...(turn === undefined ? {} : { turn }) }
    }),
  ]
  const ordered: ChatItem[] = []
  const terminalLocals: ChatItem[] = []
  for (const item of result) {
    if (isTerminalLocalMessage(item)) terminalLocals.push(item)
    else ordered.push(item)
  }
  ordered.sort((a, b) => {
    const left = a.nativeOrderSeq ?? a.nativeSeq
    const right = b.nativeOrderSeq ?? b.nativeSeq
    if (left === undefined && right === undefined) return 0
    if (left === undefined) return 1
    if (right === undefined) return -1
    return left - right
  })
  return insertTerminalLocalMessages(ordered, terminalLocals)
}

/** Prepend an older history page in front of the current chat items, deduplicated by id. */
export function prependHistory(older: ChatItem[], current: ChatItem[]): ChatItem[] {
  return mergeHistoryAndLive(older, current)
}

/** Smallest event seq in a history page; drives the next `session/page` beforeSeq. */
export function oldestSeq(events: HistoryEntry[]): number | undefined {
  let oldest: number | undefined
  for (const entry of events) {
    const seq = entry.event.seq
    if (Number.isSafeInteger(seq)) oldest = oldest === undefined ? seq : Math.min(oldest, seq)
  }
  return oldest
}

/** [ChatPad 补充] 直接从已归约的行里取最旧的 seq（上翻分页要用）。 */
export function oldestSeqOfItems(items: ChatItem[]): number | undefined {
  let oldest: number | undefined
  for (const item of items) {
    const seq = item.nativeOrderSeq ?? item.nativeSeq
    if (seq !== undefined && Number.isSafeInteger(seq)) oldest = oldest === undefined ? seq : Math.min(oldest, seq)
  }
  return oldest
}

/* ────────────────────────────────────────────────────────────────────────
 * 四、线格式 → 事件（翻译层；参考 client-core/harness-alpha-client.ts）
 * ──────────────────────────────────────────────────────────────────────── */

/** V3 实时助手输出的当前 attempt（`assistant-stream` 的 `start` 起、`end` 止）。 */
export interface AssistantAttempt {
  attemptId: string
  startedAfterSeq: number
  turn: number
  step: number
  nextIndex: number
}

/** 一个会话时间线的归约状态：行 + follow 游标 + 当前流式 attempt。 */
export interface RemoteTranscriptState {
  items: ChatItem[]
  /** follow 的 durability 游标（`snapshot.cursor` / 最新 `event.seq`）。 */
  cursor: number
  /** 同一 cursor 内已收到的瞬态 chunk 数（合成小数 seq 用）。 */
  transient: number
  /** V3 的当前流式 attempt；`undefined` 表示当前没有流式输出。 */
  attempt?: AssistantAttempt
}

export function createTranscriptState(): RemoteTranscriptState {
  return { items: [], cursor: -1, transient: 0 }
}

/** `session/follow` 首帧（snapshot）的最小结构（input-B §2.3）。 */
export interface RemoteFollowSnapshot {
  cursor?: number
  throughSeq?: number
  hasMore: boolean
  records: unknown[]
  projections?: unknown
  assistantStream?: unknown
  /** `header.version === 3` 才是 V3 线格式。 */
  version?: number
}

/**
 * 解析 `session/follow` 的首帧。返回 `null` 表示这不是 snapshot
 * （调用方要按错误处理：Host 必须先给快照，见 client-core:844-847）。
 */
export function parseSnapshot(value: unknown): RemoteFollowSnapshot | null {
  if (!isRecord(value) || value.type !== 'snapshot') return null
  const cursor = typeof value.cursor === 'number' && Number.isFinite(value.cursor) ? value.cursor : undefined
  const throughSeq = typeof value.throughSeq === 'number' && Number.isFinite(value.throughSeq) ? value.throughSeq : undefined
  const header = isRecord(value.header) ? value.header : undefined
  return {
    ...(cursor === undefined ? {} : { cursor }),
    ...(throughSeq === undefined ? {} : { throughSeq }),
    hasMore: value.hasMore === true,
    records: Array.isArray(value.records) ? value.records : [],
    ...(value.projections === undefined ? {} : { projections: value.projections }),
    ...(value.assistantStream === undefined ? {} : { assistantStream: value.assistantStream }),
    ...(typeof header?.version === 'number' ? { version: header.version } : {}),
  }
}

/**
 * 用 snapshot 重置时间线（打开会话 / 重连后重开 follow 都走这里）。
 *
 * 语义是**全量重置**（snapshot 已经是该会话的权威窗口），所以不吃旧 state：
 * 调用方用返回值覆盖即可（`ctx.transcript = reduceSnapshot(snapshot, id)`）。
 *
 * 除了 fold 历史记录，还要把 **in-flight attempt 已经产出的 chunk** 补放一遍：
 * `assistantStream.activeAttempt.stream` + `nextIndex` 是中途打开会话时唯一能拿到
 * 半截回答的地方（对应 client-core `sessionHistory()` 里 855-872 行的回放）。
 */
export function reduceSnapshot(
  snapshot: RemoteFollowSnapshot,
  sessionId: string,
): RemoteTranscriptState {
  const entries = historyEntriesFromRecords(snapshot.records)
  let items = foldHistory(entries, sessionId, false)
  const cursorBase = snapshot.cursor ?? snapshot.throughSeq ?? -1
  let cursor = cursorBase
  for (const entry of entries) {
    if (Number.isSafeInteger(entry.event.seq)) cursor = Math.max(cursor, entry.event.seq)
  }
  let next: RemoteTranscriptState = { items, cursor, transient: 0 }
  const attempt = assistantStreamAttempt(readActiveAttempt(snapshot.assistantStream), 0)
  if (attempt !== undefined) {
    next = { ...next, attempt }
    const stream = readActiveStream(snapshot.assistantStream)
    const chunks = expandAssistantStreamRecords(stream)
    for (const member of chunks.slice(0, attempt.nextIndex)) {
      next = { ...next, transient: next.transient + 1 }
      items = applyFollowEvent(items, {
        type: 'assistant/chunk',
        seq: nextTransientSeq(next, attempt),
        time: member.time,
        data: { turn: attempt.turn, step: attempt.step, chunk: member.chunk },
      }, sessionId, undefined, true)
      next = { ...next, items }
    }
  }
  return { ...next, items }
}

/**
 * 叠一条 `session/follow` 的增量 item。
 *
 * 三类 item（input-B §2.5）：
 *   - `{type:'event', event, view?}`          → 持久事件（含 `turn/start`、`tool/result`…）
 *   - `{type:'chunks', event}`                → 落库后的 chunk 批（展开成多个 `assistant/chunk`）
 *   - `{type:'assistant-stream', frame}`      → V3 实时助手输出（start / chunk / end）
 */
export function reduceFollowItem(
  state: RemoteTranscriptState,
  item: unknown,
  sessionId: string,
): RemoteTranscriptState {
  if (!isRecord(item)) return state
  if (item.type === 'assistant-stream') return reduceAssistantStreamFrame(state, item.frame, sessionId)
  const entries = entriesFromFollowValue(item)
  if (entries.length === 0) return state
  let { items, cursor } = state
  let transient = state.transient
  for (const entry of entries) {
    if (Number.isSafeInteger(entry.event.seq)) {
      cursor = Math.max(cursor, entry.event.seq)
      transient = 0
    }
    items = applyFollowEvent(items, entry.event, sessionId, entry.view, true)
  }
  return { items, cursor, transient, ...(state.attempt === undefined ? {} : { attempt: state.attempt }) }
}

/**
 * `assistant-stream` 帧的归约（对应 client-core `entriesFromSessionFollow()`）。
 * 只有 `chunk` 会产出可见内容；`end` 且 `outcome.kind === 'abandoned'` 时清掉流式行。
 */
function reduceAssistantStreamFrame(
  state: RemoteTranscriptState,
  frame: unknown,
  sessionId: string,
): RemoteTranscriptState {
  if (!isRecord(frame) || typeof frame.type !== 'string') return state
  if (frame.type === 'start') {
    const attempt = assistantStreamAttempt(frame, 0)
    return attempt === undefined ? state : { ...state, attempt }
  }
  const attempt = state.attempt
  if (frame.type === 'end') {
    if (attempt !== undefined && frame.attemptId === attempt.attemptId) {
      const abandoned = isRecord(frame.outcome) && frame.outcome.kind === 'abandoned'
      // attempt 结束：清掉当前 attempt，transient 计数继续累加（同一 cursor 内不乱序）。
      const cleared: RemoteTranscriptState = { items: state.items, cursor: state.cursor, transient: state.transient + 1 }
      if (!abandoned) return cleared
      const items = applyFollowEvent(state.items, {
        type: 'assistant/attempt-abandoned',
        seq: nextTransientSeq(cleared, attempt),
        time: Date.now(),
        data: { turn: attempt.turn, step: attempt.step, attemptId: attempt.attemptId },
      }, sessionId, undefined, true)
      return { ...cleared, items }
    }
    return state
  }
  if (frame.type !== 'chunk' || attempt === undefined || frame.attemptId !== attempt.attemptId) return state
  // 乱序 / 重复的 chunk 直接丢掉：index 必须连续（client-core:1290-1294 同款校验）。
  if (frame.index !== attempt.nextIndex || typeof frame.time !== 'number' || !isRecord(frame.chunk)) return state
  const advanced: AssistantAttempt = { ...attempt, nextIndex: attempt.nextIndex + 1 }
  const next: RemoteTranscriptState = { ...state, attempt: advanced, transient: state.transient + 1 }
  const items = applyFollowEvent(state.items, {
    type: 'assistant/chunk',
    seq: nextTransientSeq(next, advanced),
    time: frame.time,
    data: { turn: advanced.turn, step: advanced.step, chunk: frame.chunk },
  }, sessionId, undefined, true)
  return { ...next, items }
}

/** 这条 follow item 是否代表 `turn/start` / `turn/end`（用来点亮/熄灭「生成中」）。 */
export function runningForFollowItem(item: unknown): boolean | undefined {
  const event = nativeEventOfFollowItem(item)
  return event === undefined ? undefined : sessionRunningForEvent(event)
}

/** 这条 follow item 里带的持久事件（没有就返回 `undefined`）。 */
export function nativeEventOfFollowItem(item: unknown): NativeSessionEvent | undefined {
  const entries = entriesFromFollowValue(item)
  const last = entries.at(-1)
  return last?.event
}

/**
 * 从一条 follow item 里取 `permission/preset` 事件（没有就 `undefined`）。
 *
 * 为什么必须看它：会话进行中改权限（界面点胶囊、Host 侧自动降级、或别的客户端改的）
 * 在日志里只留一条 `permission/preset` 事件。只靠 `session/control` 的投影的话，
 * 老 Host 不推那条流、或者帧来晚一步，界面就停在旧值 ——
 * 用户原话：「权限模式显示的和实际用的不一样」。权限以**日志事件**为准最稳，
 * dsh-Go 也是这么折的（`session_modes.dart` 的 `PermissionPresetChangedEvent`）。
 *
 * 形状：`{type:'permission/preset', data:{preset:'read-only'}}`；有些版本把 `preset`
 * 摊在事件顶层，两个位置都读。
 */
export function permissionPresetOfFollowItem(item: unknown): string | undefined {
  for (const entry of entriesFromFollowValue(item)) {
    if (entry.event.type !== 'permission/preset') continue
    const fromData = stringValue(entry.event.data.preset) ?? stringValue(entry.event.data.value)
    if (fromData !== undefined && fromData.length > 0) return fromData
  }
  /*
   * 顶层摊平的写法（`{type:'permission/preset', preset:'auto'}`）会被
   * `historyEntryFromEvent()` 规范化掉（它只保留 type/seq/time/data），所以这里从**原始帧**
   * 再读一次。少了这一步，只发顶层字段的 Host 改权限时界面不会跟。
   */
  if (isRecord(item) && isRecord(item.event) && item.event.type === 'permission/preset') {
    const flat = stringValue(item.event.preset) ?? stringValue(item.event.value)
    if (flat !== undefined && flat.length > 0) return flat
  }
  return undefined
}

/** `$events` 的 `ready` item（拿到 clientId 才能应答审批）。 */
export function eventClientIdOf(item: unknown): string | undefined {
  if (!isRecord(item) || item.type !== 'ready') return undefined
  return stringValue(item.clientId)
}

/** `$events` 的 `emit` 里被转发的会话目录事件（`remote.session.events.v1`）。 */
export type ForwardedSessionEvent =
  | { kind: 'added'; sessionId: string; session: unknown }
  | { kind: 'removed'; sessionId: string }
  | { kind: 'status'; sessionId: string; running: boolean }
  | { kind: 'activity'; sessionId: string; updatedAt: number }
  | { kind: 'error'; sessionId: string; message?: string }

/** 解析 `$events` 的 `emit` item；不是 `api-session/*` 就返回 `undefined`。 */
export function forwardedSessionEvent(item: unknown): ForwardedSessionEvent | undefined {
  if (!isRecord(item) || item.type !== 'emit' || typeof item.event !== 'string' || !Array.isArray(item.args)) return undefined
  const args = item.args
  const first = args[0]
  const sessionId = typeof first === 'string' ? first : isRecord(first) ? stringValue(first.sessionId) : undefined
  if (sessionId === undefined || sessionId.length === 0) return undefined
  switch (item.event) {
    case 'api-session/added':
      return { kind: 'added', sessionId, session: first }
    case 'api-session/removed':
      return { kind: 'removed', sessionId }
    case 'api-session/status':
      return typeof args[1] === 'boolean' ? { kind: 'status', sessionId, running: args[1] } : undefined
    case 'api-session/activity':
      return typeof args[1] === 'number' && Number.isFinite(args[1]) ? { kind: 'activity', sessionId, updatedAt: args[1] } : undefined
    case 'api-session/error':
      return { kind: 'error', sessionId, ...(typeof args[1] === 'string' ? { message: args[1] } : {}) }
    default:
      return undefined
  }
}

/**
 * 叠一条 `$events` 的 item（审批 / 提问 / 撤销）。
 *
 * 只处理需要在时间线上留痕的两类 waterfall（input-B §2.6、§2.7）：
 *   - `event:'approval/request'`      → `ApprovalActivity`（`eventId` 即 approvalId）
 *   - `event:'user-questions/request'` → `QuestionActivity`
 *   - `{type:'cancel', eventId}`      → 把对应行标成 `cancelled`
 *
 * `ready` / `emit` 不产生时间线内容（`emit` 的目录增量用 `forwardedSessionEvent()`）。
 *
 * `sessionId` 传当前打开的会话；`waterfall.agentId` 与它不一致的请求会被跳过
 * （P0 只展示当前会话；别的会话的 pending 审批会在下次打开该会话时由 Host 重投，
 * 见 §2.6「重连时 Host 会用同一 eventId 重投 pending waterfall」）。
 */
export function reduceEventsItem(items: ChatItem[], item: unknown, sessionId: string): ChatItem[] {
  if (!isRecord(item) || typeof item.type !== 'string') return items
  if (item.type === 'waterfall') {
    if (typeof item.eventId !== 'string' || typeof item.agentId !== 'string' || !isRecord(item.request)) return items
    if (item.agentId !== sessionId) return items
    const request = item.request
    if (item.event === 'approval/request') {
      return addApproval(items, {
        sessionId: item.agentId,
        approvalId: item.eventId,
        toolName: typeof request.toolName === 'string' ? request.toolName : 'Harness',
        ...(typeof request.callId === 'string' ? { callId: request.callId } : {}),
        ...(typeof request.reason === 'string' ? { reason: request.reason } : {}),
        // Host 若给了决定集合，交给 `approvalOptionsOf` 按 v1 白名单过滤（allow_session 丢掉）
        ...(request.options === undefined ? {} : { options: request.options }),
        ...(request.decisions === undefined ? {} : { decisions: request.decisions }),
      }, item.eventId)
    }
    if (item.event === 'user-questions/request') {
      const wait = isRecord(request.wait) ? request.wait : undefined
      return addQuestion(items, {
        sessionId: item.agentId,
        questions: Array.isArray(request.questions) ? request.questions : [],
        ...(typeof wait?.callId === 'string' ? { callId: wait.callId } : {}),
      }, item.eventId)
    }
    return items
  }
  if (item.type === 'cancel' && typeof item.eventId === 'string') {
    const next = resolveApproval(items, { approvalId: item.eventId, outcome: 'cancelled' })
    return resolveQuestion(next, { questionRpcId: item.eventId, outcome: 'cancelled' })
  }
  return items
}

/** 当前仍未处理的审批（给 store 的 `pendingApprovals` 用）。 */
export function pendingApprovals(items: ChatItem[]): { eventId: string; title: string; detail?: string }[] {
  return items.flatMap(item => item.kind === 'approval' && item.outcome === undefined
    ? [{ eventId: item.approvalId, title: item.toolName, ...(item.reason === undefined ? {} : { detail: item.reason }) }]
    : [])
}

/* ── 乐观用户消息（发送后立刻上屏，等 Host 用 requestRpcId 回显替换） ───── */

/**
 * 追加一条本地乐观用户消息。`requestRpcId` 必须是真正发给
 * `session/prompt.request.requestId` 的那个值 —— Host 回显的
 * `user/message.source.rpcId` 就是它，`addUserMessage()` 靠这个做替换。
 */
export function addOptimisticUserMessage(
  items: ChatItem[],
  sessionId: string,
  text: string,
  requestRpcId: string,
): ChatItem[] {
  const message: ChatMessage = {
    kind: 'message',
    id: `local:${requestRpcId}`,
    sessionId,
    role: 'user',
    text,
    createdAt: Date.now(),
    requestRpcId,
    sendState: 'queued',
  }
  return [...items, message]
}

/**
 * 发送已被 Host 接受：清掉本地挂起标记（`sendState` 缺省 = 正常消息）。
 *
 * 为什么必须有这一步：`steer`/插话路径下 Host 不一定会把这条用户消息回显，
 * 只留 `markSendState(..., 'failed')` 的话，成功的插话会永远停在「发送中」。
 */
export function clearSendState(items: ChatItem[], requestRpcId: string): ChatItem[] {
  return items.map(item => item.kind === 'message' && item.requestRpcId === requestRpcId
    ? { ...item, sendState: undefined }
    : item)
}

/** 标记某条乐观消息的投递状态（`failed` 时带上可读原因）。 */
export function markSendState(
  items: ChatItem[],
  requestRpcId: string,
  sendState: NonNullable<ChatMessage['sendState']>,
  sendError?: string,
): ChatItem[] {
  return items.map(item => item.kind === 'message' && item.requestRpcId === requestRpcId
    ? { ...item, sendState, ...(sendError === undefined ? { sendError: undefined } : { sendError }) }
    : item)
}

/** 把某条审批行标成最终结果（应答成功后本地先落定，不必等 Host 重投）。 */
export function resolveApprovalItem(items: ChatItem[], approvalId: string, outcome: ApprovalOutcome): ChatItem[] {
  return resolveApproval(items, { approvalId, outcome })
}

/* ────────────────────────────────────────────────────────────────────────
 * 五、线格式解析工具（搬运自 client-core/harness-alpha-client.ts）
 * ──────────────────────────────────────────────────────────────────────── */

/** `records[]` → 事件列表（snapshot 的 records 与 follow 的 item 共用同一套解码）。 */
export function historyEntriesFromRecords(records: unknown[]): HistoryEntry[] {
  return records.flatMap(record => {
    if (!isRecord(record)) return []
    if (record.type === 'event' && isRecord(record.event)) return historyEntryFromEvent(record.event, record.view)
    if (record.type === 'chunks' && isRecord(record.event)) return entriesFromChunkRun(record.event)
    return []
  })
}

function entriesFromFollowValue(value: unknown): HistoryEntry[] {
  if (!isRecord(value)) return []
  if (value.type === 'event' && isRecord(value.event)) return historyEntryFromEvent(value.event, value.view)
  if (value.type === 'chunks' && isRecord(value.event)) return entriesFromChunkRun(value.event)
  return []
}

function historyEntryFromEvent(event: Record<string, unknown>, view?: unknown): HistoryEntry[] {
  if (typeof event.type !== 'string' || typeof event.seq !== 'number' || typeof event.time !== 'number') return []
  const surfaceOp = normalizeSurfaceOp(event.surfaceOp)
  const normalizedView = historyView(view)
  return [{
    event: {
      type: event.type,
      seq: event.seq,
      time: event.time,
      data: isRecord(event.data) ? event.data : {},
      ...(Array.isArray(event.sourceEventSeqs) ? { sourceEventSeqs: event.sourceEventSeqs.filter((item): item is number => typeof item === 'number') } : {}),
      ...(surfaceOp === undefined ? {} : { surfaceOp }),
      ...(event.ignorable === true ? { ignorable: true } : {}),
    },
    ...(normalizedView === undefined ? {} : { view: normalizedView }),
  }]
}

function normalizeSurfaceOp(value: unknown): NativeSessionEvent['surfaceOp'] {
  if (value === 'append') return value
  if (!isRecord(value) || value.op !== 'replace') return undefined
  if (typeof value.startSeq === 'number' && typeof value.endSeq === 'number') {
    return { op: 'replace', startSeq: value.startSeq, endSeq: value.endSeq }
  }
  if (typeof value.start === 'number' && typeof value.end === 'number') {
    return { op: 'replace', start: value.start, end: value.end }
  }
  return undefined
}

/** 落库后的 `chunkrow/*` 批 → 多个 `assistant/chunk`（client-core `entriesFromChunkRun`）。 */
function entriesFromChunkRun(event: Record<string, unknown>): HistoryEntry[] {
  if (typeof event.type !== 'string' || typeof event.seq !== 'number' || typeof event.time !== 'number' || !isRecord(event.data)) return []
  const seq = event.seq
  const data = event.data
  const turn = typeof data.turn === 'number' ? data.turn : undefined
  const step = typeof data.step === 'number' ? data.step : undefined
  const chunkIndex = typeof data.index === 'number' ? data.index : undefined
  const base = {
    ...(turn === undefined ? {} : { turn }),
    ...(step === undefined ? {} : { step }),
  }
  const dt = Array.isArray(data.dt) ? data.dt.filter((item): item is number => typeof item === 'number') : []
  if (event.type === 'chunkrow/text-chunks' || event.type === 'chunkrow/reasoning-chunks') {
    const texts = Array.isArray(data.texts) ? data.texts.filter((item): item is string => typeof item === 'string') : []
    let time = event.time
    return texts.map((text, offset) => {
      if (offset > 0) time += dt[offset - 1] ?? 0
      return {
        event: {
          type: 'assistant/chunk',
          seq: seq + offset,
          time,
          data: {
            ...base,
            chunk: {
              type: event.type === 'chunkrow/text-chunks' ? 'text-delta' : 'reasoning-delta',
              ...(chunkIndex === undefined ? {} : { index: chunkIndex }),
              text,
            },
          },
        },
      }
    })
  }
  if (event.type !== 'chunkrow/tool-call-chunks') return []
  const args = Array.isArray(data.args) ? data.args.filter((item): item is string => typeof item === 'string') : []
  let time = event.time
  return args.map((text, offset) => {
    if (offset > 0) time += dt[offset - 1] ?? 0
    return {
      event: {
        type: 'assistant/chunk',
        seq: seq + offset,
        time,
        data: {
          ...base,
          chunk: {
            type: 'tool-call-delta',
            ...(chunkIndex === undefined ? {} : { index: chunkIndex }),
            ...(typeof data.id === 'string' ? { id: data.id } : {}),
            ...(typeof data.name === 'string' ? { name: data.name } : {}),
            argumentsDelta: text,
          },
        },
      },
    }
  })
}

function readActiveAttempt(assistantStream: unknown): Record<string, unknown> | undefined {
  if (!isRecord(assistantStream) || !isRecord(assistantStream.activeAttempt)) return undefined
  return assistantStream.activeAttempt
}

function readActiveStream(assistantStream: unknown): unknown[] {
  const attempt = readActiveAttempt(assistantStream)
  return attempt !== undefined && Array.isArray(attempt.stream) ? attempt.stream : []
}

function assistantStreamAttempt(value: Record<string, unknown> | undefined, defaultNextIndex?: number): AssistantAttempt | undefined {
  if (value === undefined) return undefined
  const nextIndex = typeof value.nextIndex === 'number' ? value.nextIndex : defaultNextIndex
  return typeof value.attemptId === 'string'
    && typeof value.startedAfterSeq === 'number'
    && typeof value.turn === 'number'
    && typeof value.step === 'number'
    && nextIndex !== undefined
    ? {
        attemptId: value.attemptId,
        startedAfterSeq: value.startedAfterSeq,
        turn: value.turn,
        step: value.step,
        nextIndex,
      }
    : undefined
}

/**
 * 瞬态 chunk 的合成 seq：`baseSeq + 1 - 1/(n+1)`。
 * 保持严格小于下一条持久事件（`baseSeq + 1`），这样 `applyNativeEvent` 的
 * 「旧 seq 不回退」判断仍然成立（client-core:1815-1818 同款算法）。
 */
function nextTransientSeq(state: RemoteTranscriptState, attempt: AssistantAttempt): number {
  const baseSeq = Math.max(state.cursor, attempt.startedAfterSeq)
  return baseSeq + 1 - 1 / (state.transient + 1)
}

/**
 * 把落库的 chunk 批展开成逐块 chunk（client-core `expandAssistantStreamRecords`）。
 *
 * 字段名在这里是**实证**的（不是猜的）：
 *   - `text-chunks`      → `{type:'text-delta', index?, text}`
 *   - `reasoning-chunks` → `{type:'reasoning-delta', index?, text}`
 *   - `tool-call-chunks` → `{type:'tool-call-delta', index?, id?, name?, argumentsDelta}`
 * 见 `packages/client-core/src/harness-alpha-client.ts:1820-1868`、
 * `docs/protocol.md` §19，以及 input-B 附录 C 第 2 条。
 */
export function expandAssistantStreamRecords(stream: unknown[]): Array<{ time: number; chunk: Record<string, unknown> }> {
  const chunks: Array<{ time: number; chunk: Record<string, unknown> }> = []
  for (const record of stream) {
    if (!isRecord(record) || typeof record.type !== 'string') continue
    if (record.type === 'chunk') {
      if (typeof record.time === 'number' && isRecord(record.chunk)) {
        chunks.push({ time: record.time, chunk: record.chunk })
      }
      continue
    }
    if (typeof record.time0 !== 'number') continue
    const dt = Array.isArray(record.dt) ? record.dt.filter((item): item is number => typeof item === 'number') : []
    const chunkIndex = typeof record.index === 'number' ? record.index : undefined
    if (record.type === 'text-chunks' || record.type === 'reasoning-chunks') {
      const texts = Array.isArray(record.texts) ? record.texts.filter((item): item is string => typeof item === 'string') : []
      let time = record.time0
      for (let offset = 0; offset < texts.length; offset += 1) {
        if (offset > 0) time += dt[offset - 1] ?? 0
        chunks.push({
          time,
          chunk: {
            type: record.type === 'text-chunks' ? 'text-delta' : 'reasoning-delta',
            ...(chunkIndex === undefined ? {} : { index: chunkIndex }),
            text: texts[offset]!,
          },
        })
      }
      continue
    }
    if (record.type === 'tool-call-chunks') {
      // 官方客户端读 `args`；更早的落库形状用过 `deltas`，两者都认。
      const args = Array.isArray(record.args)
        ? record.args.filter((item): item is string => typeof item === 'string')
        : Array.isArray(record.deltas)
          ? record.deltas.filter((item): item is string => typeof item === 'string')
          : []
      let time = record.time0
      for (let offset = 0; offset < args.length; offset += 1) {
        if (offset > 0) time += dt[offset - 1] ?? 0
        chunks.push({
          time,
          chunk: {
            type: 'tool-call-delta',
            ...(chunkIndex === undefined ? {} : { index: chunkIndex }),
            ...(typeof record.id === 'string' ? { id: record.id } : {}),
            ...(typeof record.name === 'string' ? { name: record.name } : {}),
            argumentsDelta: args[offset]!,
          },
        })
      }
    }
  }
  return chunks
}
