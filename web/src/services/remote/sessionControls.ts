/**
 * 会话内控制（W2）：**模型切换 / 权限预设 / 斜杠命令 / 排队插话 / 用户提问作答 / 会话信息**。
 *
 * ```
 *  UI (components/remote/chat-controls/**)
 *        │  读写
 *        ▼
 *  sessionControls.ts  ──callEndpoint──►  harness.remote.call  ──►  Host 端点
 *        ▲                                   （{endpoint, payload:{args}}）
 *        │  bind / applyControlFrame / ingestEventsItem
 *  store.ts（连接、session/follow、$events、session/control 的流）
 * ```
 *
 * ## 为什么单独一个文件
 *
 * `store.ts` 已经 1800 行、且是别的并行任务（W1 新建会话）依赖的**稳定面**；会话内控制这一批
 * 新增 6 个端点 + 一套提问状态机，塞回去会把「连接编排」和「会话内交互」搅在一起。这里按
 * `plan-功能对齐分批.md` 的分工约定独占一个文件：`sessionsApi.ts` 只加**函数**不动（它归 W1），
 * `store.ts` 只加**挂载点**（`bindSessionControls` / `applyControlFrame` / `ingestEventsItem`）。
 *
 * ## 端点依据（都为 `harness.remote.call` 的 `endpoint`，`args` 是本文件拼的对象）
 *
 * | 端点 | 类型 | args | 返回 | 依据 |
 * |---|---|---|---|---|
 * | `session/modelCatalog` | call | `{}` | `{default,routableProviders?,groups,failures?}` | `harness-alpha-client.ts:446-466` |
 * | `session/selectModel` | call | `{request:{sessionId,provider,model,reasoningEffort?}}` | `{selected}` | 同上 `:469-484` |
 * | `permissionPresets/catalog` | call | `{}` | `{options:[{value,name,description?}]}` | `docs/protocol.md:1280-1283` |
 * | `commands/list` | call | `{agentId}`（退化 `{}`） | `[{name,description?,input?}]` | allowlist `harness-remote-bridge.ts:130`；形状见 `acp/virtual-harness.ts:1308` |
 * | `commands/execute` | call | `{agentId,line,submittedAttachments:[]}` | `{result:{kind,text?}}` | `harness-alpha-client.ts:485-511` |
 * | `session/updateQueue` | call | `{request:{sessionId,itemId,action:{kind}}}` | `{accepted:true}` | `:946-949` |
 * | `userQuestions/attachWait` | **stream** | `{agentId,callId}` | 首帧 `{remainingMs}` | `harness-questions.ts:155-180` |
 * | `userQuestions/answer` | call | `{agentId,callId,answer:{answers:[{id,selected[],custom?}]}}` | `true` | `harness-questions.ts:111-136` |
 * | `session/control` | **stream**（`store.ts` 开） | `{}` | `baseline` / `projection` | `harness-alpha-client.ts:1439-1520` |
 * | `$events/result` | call | `{clientId,eventId,outcome}` | — | `harness-alpha-client.ts:1168-1178` |
 *
 * ## 三条纪律（都是从上游实现里抄来的硬约束）
 *
 * 1. **能力缺失 ≠ 错误**：`METHOD_NOT_FOUND` / `CAPABILITY_NOT_SUPPORTED` 只把对应入口标成
 *    `unavailable`（UI 隐藏），**不写 `store.error`**、不弹红条。
 * 2. **禁重放**：断线时提问的 claim 一律释放（关 `attachWait`），本地计时器清掉，**不补发答案**。
 * 3. **两条应答通道别混**：限时窗口内（`questionState === 'open'` 且本地未过期）走
 *    `$events/result`；只有 Host 投影把状态推进到 `continued` 之后才允许 `userQuestions/answer`
 *    补答（`docs/protocol.md:1168`、`harness-questions.ts:117-131`）。
 */

import { create } from 'zustand'

import type { StreamEventPayload } from './core/index.js'
import { RemoteApiError, isRemoteApiError } from './serverApi.js'
import { callEndpoint, type RemoteCallTarget, type RemoteStreamHandle } from './sessionsApi.js'

/* ────────────────────────────────────────────────────────────────────────
 * 一、端点常量（全部可在上表里对上）
 * ──────────────────────────────────────────────────────────────────────── */

const ENDPOINTS = {
  modelCatalog: 'session/modelCatalog',
  selectModel: 'session/selectModel',
  permissionCatalog: 'permissionPresets/catalog',
  commandsList: 'commands/list',
  commandsExecute: 'commands/execute',
  updateQueue: 'session/updateQueue',
  questionAttachWait: 'userQuestions/attachWait',
  questionAnswer: 'userQuestions/answer',
  eventsResult: '$events/result',
} as const

/** `session/control` 由 `store.ts` 打开（它持有 sink 路由），这里只常量对齐用。 */
export const CONTROL_STREAM_ENDPOINT = 'session/control'

/** 一次 unary 的预算：都很快，超过 30s 说明链路出问题了。 */
const CALL_TIMEOUT_MS = 30_000
/** `commands/execute` 里 `/compact` 可能要跑几分钟（官方也是单独放宽的）。 */
const COMMAND_TIMEOUT_MS = 30_000
const COMPACT_TIMEOUT_MS = 30 * 60_000
/** `attachWait` 开流的预算（首帧就是 `{remainingMs}`，很快）。 */
const CLAIM_TIMEOUT_MS = 30_000
/** 认领成功后等首帧 `remainingMs` 的兜底：超时按「普通瀑布」处理（没有倒计时，但能答）。 */
const CLAIM_FRAME_TIMEOUT_MS = 5_000

/**
 * 「这台 Host 没有这个能力」的错误码集合。
 *
 * `gateway/*` 是 Typert 内层码；`UNSUPPORTED` 是客户端库自己的（`client-core` 的命令找不到时抛的）。
 * 命中它们只降级不报错；其它错误码照旧写 `error`（那是真出事了）。
 */
const UNSUPPORTED_CODES = new Set([
  'METHOD_NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'CAPABILITY_NOT_SUPPORTED',
  'FEATURE_NOT_SUPPORTED',
  'UNSUPPORTED',
  'gateway/method-not-found',
  'gateway/unknown-method',
])

/** 这个错误是不是「Host 没有这个能力」。 */
export const isUnsupportedError = (error: unknown): boolean => {
  if (isRemoteApiError(error)) return UNSUPPORTED_CODES.has(error.code)
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && UNSUPPORTED_CODES.has(code)
}

/** 取错误码（未知就给 `''`，UI 只用它分流）。 */
export const codeOf = (error: unknown): string => {
  if (isRemoteApiError(error)) return error.code
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : ''
}

/** 取可读文案（Host 的 message 优先，其次本地的兜底中文）。 */
export const textOf = (error: unknown, fallback: string): string => {
  const message = (error as { message?: unknown } | null)?.message
  return typeof message === 'string' && message.length > 0 ? message : fallback
}

/* ────────────────────────────────────────────────────────────────────────
 * 二、纯解析（可单独自测：`__selftest__/sessionControls.selftest.mts`）
 * ──────────────────────────────────────────────────────────────────────── */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/* ── 模型 ─────────────────────────────────────────────────────────────── */

export interface RemoteModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** `modelCatalog.groups[].models[].reasoning.efforts[]` 的一项。 */
export interface RemoteModelEffort {
  id: string
  name: string
  description?: string
}

/** 一个可选模型（上游 `ModelCatalogModel`）。 */
export interface RemoteModelEntry {
  id: string
  name: string
  description?: string
  efforts: RemoteModelEffort[]
  defaultEffort?: string
}

/** 一个 provider 分组（上游 `ModelProviderGroup`）。 */
export interface RemoteModelGroup {
  id: string
  name: string
  models: RemoteModelEntry[]
}

/** 拉目录时某个 provider 失败了（上游 `failures`，只展示，不隐藏入口）。 */
export interface RemoteModelFailure {
  id: string
  name: string
  message: string
}

/** `session/modelCatalog` 的归一化结果。 */
export interface RemoteModelCatalog {
  /** Host 的默认模型（`default`）；投影里的当前值优先于它。 */
  defaultModel: RemoteModelSelection
  /** `default` 是否在可路由的 provider 里（缺字段时按「组非空」推定，与上游一致）。 */
  routable: boolean
  groups: RemoteModelGroup[]
  failures: RemoteModelFailure[]
}

/** 解析 `{provider,model,reasoningEffort?}`（非空才算）。 */
export const parseModelSelection = (value: unknown): RemoteModelSelection | null => {
  if (!isRecord(value)) return null
  const provider = asString(value.provider)
  const model = asString(value.model)
  if (provider === undefined || model === undefined) return null
  const effort = asString(value.reasoningEffort)
  return { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
}

/**
 * 投影里的模型选择：官方形状是 `{next?, lastUsed?}`（`codex.ts:253`），
 * 也容忍直接给 `{provider,model}`（老 Host / 别的后端）。
 */
export const modelSelectionOfProjection = (value: unknown): RemoteModelSelection | null => {
  if (!isRecord(value)) return null
  const direct = parseModelSelection(value)
  if (direct !== null) return direct
  return parseModelSelection(value.next) ?? parseModelSelection(value.lastUsed)
}

/** `session/modelCatalog` 归一化；形状不对返回 `null`（调用方据此判「老 Host」）。 */
export const parseModelCatalog = (value: unknown): RemoteModelCatalog | null => {
  if (!isRecord(value)) return null
  const defaultModel = parseModelSelection(value.default) ?? parseModelSelection(value.current)
  if (defaultModel === null && !Array.isArray(value.groups)) return null
  const groups = asArray(value.groups)
    .flatMap<RemoteModelGroup>((rawGroup) => {
      if (!isRecord(rawGroup)) return []
      const id = asString(rawGroup.id)
      if (id === undefined) return []
      const models = asArray(rawGroup.models).flatMap<RemoteModelEntry>((rawModel) => {
        if (!isRecord(rawModel)) return []
        const modelId = asString(rawModel.id)
        if (modelId === undefined) return []
        const reasoning = isRecord(rawModel.reasoning) ? rawModel.reasoning : undefined
        const efforts = asArray(reasoning?.efforts).flatMap<RemoteModelEffort>((rawEffort) => {
          if (!isRecord(rawEffort)) return []
          const effortId = asString(rawEffort.id)
          if (effortId === undefined) return []
          const description = asString(rawEffort.description)
          return [{ id: effortId, name: asString(rawEffort.name) ?? effortId, ...(description === undefined ? {} : { description }) }]
        })
        const defaultEffort = asString(reasoning?.defaultEffort)
        const description = asString(rawModel.description)
        return [{
          id: modelId,
          name: asString(rawModel.name) ?? modelId,
          ...(description === undefined ? {} : { description }),
          efforts,
          ...(defaultEffort === undefined ? {} : { defaultEffort }),
        }]
      })
      return [{ id, name: asString(rawGroup.name) ?? id, models }]
    })
    .filter((group) => group.models.length > 0)
  const failures = asArray(value.failures).flatMap<RemoteModelFailure>((rawFailure) => {
    if (!isRecord(rawFailure)) return []
    const id = asString(rawFailure.id)
    if (id === undefined) return []
    return [{
      id,
      name: asString(rawFailure.name) ?? id,
      message: asString(rawFailure.message) ?? '拉取模型列表失败',
    }]
  })
  const routableProviders = Array.isArray(value.routableProviders)
    ? value.routableProviders.filter((item): item is string => typeof item === 'string')
    : undefined
  const base = defaultModel ?? (groups[0]?.models[0] === undefined
    ? null
    : { provider: groups[0].id, model: groups[0].models[0].id })
  if (base === null) return null
  return {
    defaultModel: base,
    routable: routableProviders === undefined ? groups.length > 0 : routableProviders.includes(base.provider),
    groups,
    failures,
  }
}

/** 当前模型在这个分组里的那一行（拿它的 `efforts` / `name`）。 */
export const findModelEntry = (
  catalog: RemoteModelCatalog | null,
  selection: RemoteModelSelection | null,
): { group: RemoteModelGroup; model: RemoteModelEntry } | null => {
  if (catalog === null || selection === null) return null
  const group = catalog.groups.find((item) => item.id === selection.provider)
  if (group === undefined) return null
  const model = group.models.find((item) => item.id === selection.model)
  return model === undefined ? null : { group, model }
}

/** 胶囊上显示的名字：优先目录里的显示名，其次 `provider/model`。 */
export const modelDisplayName = (
  catalog: RemoteModelCatalog | null,
  selection: RemoteModelSelection | null,
): string | null => {
  if (selection === null) return null
  const found = findModelEntry(catalog, selection)
  return found === null ? selection.model : found.model.name
}

/* ── 权限预设 ─────────────────────────────────────────────────────────── */

export interface RemotePermissionOption {
  value: string
  name: string
  description?: string
}

/**
 * `permissionPresets/catalog` 归一化。
 *
 * 形状是 `{options:[{value,name,description?}]}`（`docs/protocol.md:1280-1283`），
 * 裸数组也照收（老 Host / 直接透传的部署）。
 */
export const parsePermissionCatalog = (value: unknown): RemotePermissionOption[] => {
  const rows = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.options)
      ? value.options
      : []
  return rows.flatMap<RemotePermissionOption>((row) => {
    if (!isRecord(row)) return []
    const optionValue = asString(row.value) ?? asString(row.id)
    if (optionValue === undefined) return []
    const description = asString(row.description)
    return [{
      value: optionValue,
      name: asString(row.name) ?? optionValue,
      ...(description === undefined ? {} : { description }),
    }]
  })
}

/** 投影 `permissions = {currentValue, options?}`（`services/session-permissions.ts:5-15`）。 */
export const permissionProjectionOf = (
  value: unknown,
): { currentValue: string; options: RemotePermissionOption[] } | null => {
  if (!isRecord(value)) return null
  const currentValue = asString(value.currentValue)
  if (currentValue === undefined) return null
  return { currentValue, options: parsePermissionCatalog(value.options) }
}

/**
 * 从会话投影的 `values` 里取**当前权限预设** —— 多路兼容。
 *
 * 为什么不能只认一个位置：这个值在不同版本里落的地方不一样，认错就等于「没拿到」
 * （界面上表现为「权限模式显示的和实际用的不一样」）。四路依次试：
 *
 *   ① `values.permission` 是字符串 —— Host 的会话级预设（`session/create` 同名字段：
 *      dsh-Go `new_chat_modes.dart:75` 的 `'permission': permission`）；
 *   ② `values.permission.{preset|currentValue}` —— 包成对象时；
 *   ③ `values.permissions.currentValue` —— client-core 的 `session/permissions` 投影；
 *   ④ `values.permissionPreset` —— 某些版本把 dsh_client 的派生字段直接摊进 values。
 *
 * 一条都取不到就返回 `undefined`：**绝不猜默认值**（猜错正是「显示与实际不一致」的来源）。
 */
export const permissionPresetOfValues = (values: Record<string, unknown>): string | undefined => {
  const direct = asString(values.permission)
  if (direct !== undefined) return direct
  if (isRecord(values.permission)) {
    const nested = asString(values.permission.preset) ?? asString(values.permission.currentValue)
    if (nested !== undefined) return nested
  }
  if (isRecord(values.permissions)) {
    const current = asString(values.permissions.currentValue) ?? asString(values.permissions.preset)
    if (current !== undefined) return current
  }
  return asString(values.permissionPreset)
}

/*
 * 权限预设的**按会话缓存**。
 *
 * 为什么需要它（而 `projectionCache` 不够）：
 *   1. 权限可以从三个地方来 —— `session/follow` 快照的 projections、`session/control`
 *      的帧、用户刚点的 `/permission`；三者到达顺序不固定，必须收敛到同一个值；
 *   2. `session/control` 打不开的老 Host 上只有快照那一份 —— 不缓存就永远是 null
 *      （界面显示默认，实际不是）；
 *   3. 切走再切回：`applyProjection()` 只读投影缓存，权限若是从快照来的就丢了。
 *
 * `seq` 是防旧覆盖用的：dsh-Go 的 `SessionPanelsController` 给每个 key 记 `_keySeq`
 * （`session_detail_state.dart:96-99`），乱序帧比新值旧就不许写。
 */
const presetBySession = new Map<string, string>()
const presetSeqBySession = new Map<string, number>()

/** 记一条权限预设（快照 / control 帧 / 切换成功都走这里）。`seq` 给了就防旧覆盖。 */
export const noteSessionPermissionPreset = (sessionId: string, preset: string | undefined, seq?: number): void => {
  if (preset === undefined || preset.length === 0) return
  if (seq !== undefined) {
    const known = presetSeqBySession.get(sessionId)
    if (known !== undefined && seq < known) return
    presetSeqBySession.set(sessionId, seq)
  }
  presetBySession.set(sessionId, preset)
  if (sessionId === currentSessionId) {
    useChatControls.setState({ currentPermission: preset, permissionAccess: 'available' })
  }
}

/** 某个会话已知的权限预设（没有就是 `undefined`；排障/自测用）。 */
export const permissionPresetOfSession = (sessionId: string): string | undefined => presetBySession.get(sessionId)

/**
 * 把 `session/follow` 快照里的 `projections` 收进来（**权限的权威种子**）。
 *
 * 形状有三种，逐层兜（都是实际见过的）：
 *   - `{permissionPreset, asOfSeq, values}`（dsh_client 的 `SessionProjections`）；
 *   - `{values: {permission: …}}`；
 *   - `{[sessionId]: {asOfSeq, values}}`（`session/control` 的 baseline 用过这种）。
 */
export const noteSnapshotProjections = (sessionId: string, projections: unknown): void => {
  if (!isRecord(projections)) return
  const direct = asString(projections.permissionPreset)
  if (direct !== undefined) {
    noteSessionPermissionPreset(sessionId, direct)
    return
  }
  const blocks: unknown[] = []
  if (isRecord(projections.values)) blocks.push(projections.values)
  if (isRecord(projections[sessionId])) blocks.push(projections[sessionId])
  blocks.push(projections)
  for (const block of blocks) {
    if (!isRecord(block)) continue
    const values = isRecord(block.values) ? block.values : block
    const preset = permissionPresetOfValues(values)
    if (preset !== undefined) {
      noteSessionPermissionPreset(sessionId, preset)
      return
    }
  }
}

/** `/permission <preset>` 的合法 preset 形状（与 `sessionsApi.ts:1335`、client-core 同一判据）。 */
export const PERMISSION_PRESET_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const permissionDisplayName = (
  options: readonly RemotePermissionOption[],
  value: string | null,
): string | null => {
  if (value === null) return null
  return options.find((item) => item.value === value)?.name ?? value
}

/* ── 斜杠命令 ─────────────────────────────────────────────────────────── */

export interface RemoteSlashCommand {
  /** 命令名（不带 `/`）。 */
  name: string
  description?: string
  /** 参数提示（`input.hint`），补全后显示成 `/<name> <hint>`。 */
  hint?: string
}

/**
 * `commands/list` 归一化。
 *
 * 上游返回的是**裸数组**（`acp/virtual-harness.ts:1308-1345` 的 `AcpAvailableCommand[]`，
 * 即 `{name, description?, input?:{hint?}}`）；`{commands:[...]}` 也照收，免得不同 Host 包装不一。
 */
export const parseCommandList = (value: unknown): RemoteSlashCommand[] => {
  const rows = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.commands)
      ? value.commands
      : []
  const seen = new Set<string>()
  return rows.flatMap<RemoteSlashCommand>((row) => {
    if (!isRecord(row)) return []
    const rawName = asString(row.name) ?? asString(row.command)
    if (rawName === undefined) return []
    // Host 可能给带 `/` 的名字，统一去掉；空名/重复名丢掉（补全列表不能有重复项）
    const name = rawName.replace(/^\/+/, '').trim()
    if (name.length === 0 || seen.has(name)) return []
    seen.add(name)
    const description = asString(row.description)
    const input = isRecord(row.input) ? row.input : undefined
    const hint = asString(input?.hint) ?? asString(row.hint)
    return [{
      name,
      ...(description === undefined ? {} : { description }),
      ...(hint === undefined ? {} : { hint }),
    }]
  })
}

/**
 * 输入框内容是否在「打斜杠命令」。返回查询串（可能是 `''` = 刚敲了 `/`），否则 `null`。
 *
 * 规则（与官方 composer 一致）：**整行输入**只由 `/` + 非空白字符组成才算命令；
 * 已经带了空格（`/permission read-only`）或前面有正文时就当成普通消息，不弹补全。
 */
export const slashQuery = (draft: string): string | null => {
  const trimmed = draft.trimStart()
  if (!trimmed.startsWith('/')) return null
  const body = trimmed.slice(1)
  if (/\s/.test(body)) return null
  return body
}

/** 按查询串过滤命令：前缀匹配优先，其次是名字里包含（都大小写不敏感）。 */
export const filterCommands = (
  commands: readonly RemoteSlashCommand[],
  query: string,
): RemoteSlashCommand[] => {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return [...commands]
  const prefix = commands.filter((command) => command.name.toLowerCase().startsWith(needle))
  const contains = commands.filter(
    (command) =>
      !command.name.toLowerCase().startsWith(needle) &&
      command.name.toLowerCase().includes(needle),
  )
  return [...prefix, ...contains]
}

/** 选中一条命令后填回输入框的文本：`/name `（有 hint 时把 hint 作为占位提示，不真的写进去）。 */
export const commandLineOf = (command: RemoteSlashCommand): string => `/${command.name} `

/* ── 排队（`inbox` 投影） ─────────────────────────────────────────────── */

/** 队列里的一条待发消息（上游 `InboxQueuedItem`）。 */
export interface RemoteQueueItem {
  /** Host 队列条目 id —— `session/updateQueue` 的 `itemId`。 */
  id?: string
  /** 与 `session/prompt.requestId` 对齐的 rpcId（用来和本地乐观行对账）。 */
  rpcId?: string
  preview: string
}

/**
 * 只有**用户自己写的**条目才进队列条（上游 `OWN_QUEUE_KINDS`）：
 * `next-step` 是 Agent 内部续跑用的输入，不该让用户看见/插队。
 */
const OWN_QUEUE_KINDS = new Set(['user', 'schedule', 'user-question-reply'])

/**
 * `projections.values.inbox` → 队列条目（只取 `next-turn`）。
 *
 * 依据：上游 `state/message-helpers.ts:46-88`。Host 侧 `inbox` 形状是
 * `{ 'next-step': [...], 'next-turn': [{id, source:{kind,rpcId}, content:[{type:'text',text}]}] }`。
 */
export const parseInboxQueue = (inbox: unknown): RemoteQueueItem[] => {
  if (!isRecord(inbox) || !Array.isArray(inbox['next-turn'])) return []
  return asArray(inbox['next-turn']).flatMap<RemoteQueueItem>((row) => {
    if (!isRecord(row)) return [{ preview: '' }]
    const source = isRecord(row.source) ? row.source : undefined
    const sourceKind = asString(source?.kind)
    if (sourceKind !== undefined && !OWN_QUEUE_KINDS.has(sourceKind)) return []
    const id = asString(row.id)
    const rpcId = asString(source?.rpcId)
    const preview = asArray(row.content)
      .flatMap((block) =>
        isRecord(block) && block.type === 'text' && typeof block.text === 'string'
          ? [block.text]
          : [],
      )
      .join(' ')
    return [{
      ...(id === undefined ? {} : { id }),
      ...(rpcId === undefined ? {} : { rpcId }),
      preview,
    }]
  })
}

/* ── 会话信息（`session/control` 的其它投影键） ───────────────────────── */

export interface RemoteUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/**
 * 投影里若带 `usage` 就用它（不同 Host 的键名不完全一样，凡是常见的都认），否则 `null`。
 *
 * **不猜语义**：只接受 `inputTokens/outputTokens` 这种我们确定含义的键；
 * 都没有时返回 `null`，由 UI 退回到「按时间线里的 `assistant/message.usage` 汇总」。
 */
export const usageOfProjection = (value: unknown): RemoteUsage | null => {
  if (!isRecord(value)) return null
  const input = typeof value.inputTokens === 'number' ? value.inputTokens : undefined
  const output = typeof value.outputTokens === 'number' ? value.outputTokens : undefined
  if (input === undefined || output === undefined) return null
  const optional = (key: string): number | undefined =>
    typeof value[key] === 'number' ? (value[key] as number) : undefined
  const total = optional('totalTokens')
  const cacheRead = optional('cacheReadTokens')
  const cacheWrite = optional('cacheWriteTokens')
  return {
    inputTokens: input,
    outputTokens: output,
    ...(total === undefined ? {} : { totalTokens: total }),
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
  }
}

/* ── 用户提问 ─────────────────────────────────────────────────────────── */

export interface RemoteQuestionOption {
  label: string
  description?: string
}

/** 一条问题（官方 `AskUserQuestionItem` 的子集）。 */
export interface RemoteQuestionItem {
  id: string
  question: string
  detail?: string
  header?: string
  options: RemoteQuestionOption[]
  multiSelect: boolean
}

/** `userQuestions/answer` 的单条答案（官方 `HarnessQuestionAnswer`）。 */
export interface RemoteQuestionAnswerItem {
  id: string
  selected: string[]
  custom?: string
}

export interface RemoteQuestionAnswer {
  answers: RemoteQuestionAnswerItem[]
}

/** 提问卡片的状态机（`phase` 只往前走，不回头）。 */
export type QuestionPhase =
  /** 刚收到 waterfall，正在开 `attachWait`（还不知道剩余时间） */
  | 'claiming'
  /** 窗口内可答（有 deadline 就会到点变 expired） */
  | 'open'
  /** 本地窗口已过：只能在 Host 投影推进到 `continued` 之后补答 */
  | 'expired'
  /** Host 投影说 `continued`：走 `userQuestions/answer` 补答 */
  | 'continued'
  /** 答完了（`answered` = 限时窗口内答的；`queued` = continued 后补答的） */
  | 'answered'
  | 'queued'
  /** Host 撤销 / 已被别处处理 / 已失效 */
  | 'cancelled'

const TERMINAL_PHASES = new Set<QuestionPhase>(['answered', 'queued', 'cancelled'])

export const isQuestionTerminal = (phase: QuestionPhase): boolean => TERMINAL_PHASES.has(phase)

/** 一条提问在 store 里的运行时状态（UI 读它渲染倒计时/按钮可用性）。 */
export interface RemoteQuestionState {
  /** 会话 id（只保留当前会话的）。 */
  sessionId: string
  /** `$events` 的 eventId（限时问答的应答句柄，同时是 rpcId）。 */
  eventId?: string
  callId?: string
  questions: RemoteQuestionItem[]
  /** 投影说它在 `open` 还是 `continued`。 */
  questionState: 'open' | 'continued'
  phase: QuestionPhase
  /** 本地算出的截止时刻（`attachWait` 首帧的 `remainingMs`；拿不到就不设）。 */
  deadline?: number
  /** 限时认领成功了吗（`false` = Host 没有 `attachWait`，按普通 waterfall 处理）。 */
  timed: boolean
  /** 正在提交（按钮禁用，防重复）。 */
  submitting?: boolean
  /** 提交失败的可读原因。 */
  error?: string
}

/** waterfall `user-questions/request` 的解析结果（不是这类 item 就 `null`）。 */
export interface ParsedQuestionWaterfall {
  sessionId: string
  eventId: string
  /** 只有 `request.wait.timed === true` 且带 `callId` 才是限时问答。 */
  callId?: string
  timed: boolean
  questions: RemoteQuestionItem[]
}

export const parseQuestionItems = (raw: unknown): RemoteQuestionItem[] =>
  asArray(raw).flatMap<RemoteQuestionItem>((row) => {
    if (!isRecord(row)) return []
    const id = asString(row.id) ?? asString(row.questionId)
    if (id === undefined) return []
    const question = asString(row.question) ?? asString(row.text)
    if (question === undefined) return []
    const options = asArray(row.options).flatMap<RemoteQuestionOption>((option) => {
      if (!isRecord(option)) return []
      const label = asString(option.label) ?? asString(option.value)
      if (label === undefined) return []
      const description = asString(option.description)
      return [{ label, ...(description === undefined ? {} : { description }) }]
    })
    const detail = asString(row.detail) ?? asString(row.description)
    const header = asString(row.header)
    return [{
      id,
      question,
      ...(detail === undefined ? {} : { detail }),
      ...(header === undefined ? {} : { header }),
      options,
      multiSelect: row.multiSelect === true,
    }]
  })

/**
 * 解析 `$events` 的 `user-questions/request` waterfall。
 *
 * 与 `adapter.reduceEventsItem()` 的分工：**它**负责往时间线里落一行 `QuestionActivity`，
 * **这里**负责「能不能应答、怎么应答」（需要 `wait.timed` / `wait.callId` 这两个 adapter 不关心的字段）。
 */
export const parseQuestionWaterfall = (item: unknown, activeSessionId: string | null): ParsedQuestionWaterfall | null => {
  if (!isRecord(item) || item.type !== 'waterfall') return null
  if (item.event !== 'user-questions/request') return null
  const eventId = asString(item.eventId)
  const sessionId = asString(item.agentId)
  if (eventId === undefined || sessionId === undefined) return null
  if (activeSessionId !== null && sessionId !== activeSessionId) return null
  if (!isRecord(item.request)) return null
  const request = item.request
  const wait = isRecord(request.wait) ? request.wait : undefined
  const callId = asString(wait?.callId)
  const timed = wait?.timed === true && callId !== undefined
  return {
    sessionId,
    eventId,
    ...(callId === undefined ? {} : { callId }),
    timed,
    questions: parseQuestionItems(request.questions),
  }
}

/** 提问在 store 里的键：有 `callId` 用它（投影与 `answer` 都用它），否则用 eventId。 */
export const questionKey = (input: { callId?: string; eventId?: string }): string | null =>
  input.callId !== undefined && input.callId.length > 0
    ? `timed:${input.callId}`
    : input.eventId === undefined || input.eventId.length === 0
      ? null
      : `event:${input.eventId}`

/** 把 UI 的选择整理成线上 `answer` 形状（空选择且无自定义的一条直接丢掉）。 */
export const buildQuestionAnswer = (
  questions: readonly RemoteQuestionItem[],
  selected: Record<string, string[]>,
  custom: Record<string, string>,
): RemoteQuestionAnswer => ({
  answers: questions.flatMap<RemoteQuestionAnswerItem>((question) => {
    const picks = (selected[question.id] ?? []).filter((item) => item.length > 0)
    const text = (custom[question.id] ?? '').trim()
    if (picks.length === 0 && text.length === 0) return []
    return [{
      id: question.id,
      selected: picks,
      ...(text.length === 0 ? {} : { custom: text }),
    }]
  }),
})

/** 每条问题都给了选择或自定义文本才能提交（上游 `allAnswered` 的同一判据）。 */
export const allQuestionsAnswered = (
  questions: readonly RemoteQuestionItem[],
  selected: Record<string, string[]>,
  custom: Record<string, string>,
): boolean =>
  questions.every(
    (question) =>
      (selected[question.id] ?? []).length > 0 || (custom[question.id] ?? '').trim().length > 0,
  )

/* ────────────────────────────────────────────────────────────────────────
 * 三、模块级上下文（连接句柄 / 流 / 定时器 / 投影缓存，都不进 zustand）
 * ──────────────────────────────────────────────────────────────────────── */

/** `store.ts` 交进来的依赖（**反向注入**，避免 store ⇄ sessionControls 循环 import）。 */
export interface SessionControlsDeps {
  /** 当前安全通道（`SecureLink` 结构上兼容 `RemoteCallTarget`）。 */
  target: RemoteCallTarget
  /**
   * 按 streamId 注册接收器（就是 `store.ts` 的 `registerRemoteStreamSink`）。
   * `attachWait` 的帧必须靠它才能到达这里 —— `store.ts` 只认识它自己开的那几条流。
   */
  registerStreamSink: (streamId: string, onPayload: (payload: StreamEventPayload) => void) => () => void
  /** `$events` 的 clientId（`$events/result` 必带）；`null` = 还没 ready。 */
  eventClientId: () => string | null
}

let deps: SessionControlsDeps | null = null

/** 每个会话一条 `attachWait` 的句柄（按提问 key）。 */
const waitStreams = new Map<string, RemoteStreamHandle>()
/** 限时窗口的本地定时器（按提问 key）。 */
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * 投影缓存：`sessionId → {key: value}`。
 *
 * 为什么不直接放 zustand：`session/control` 的 baseline 一次给**所有会话**的投影，
 * 而界面只关心当前会话。把全量的放 zustand 会让每次投影帧都触发无关重渲染；
 * 这里只缓存原始值，`selectControlSession()` 时才投影成界面字段。
 */
const projectionCache = new Map<string, Record<string, unknown>>()
let currentSessionId: string | null = null

/** 正在飞的探测由各 `load*` 自己的 `loadingXxx` 兜住（单飞：胶囊一挂载就会探一轮） */

/* ────────────────────────────────────────────────────────────────────────
 * 四、store
 * ──────────────────────────────────────────────────────────────────────── */

/** 三态能力：`unknown` 还没探测过（先按「有」渲染，探测失败再隐藏）。 */
export type ControlAvailability = 'unknown' | 'available' | 'unavailable'

export interface ChatControlsState {
  /* ── 能力门禁（UI 据此隐藏入口，不报错） ── */
  modelAccess: ControlAvailability
  permissionAccess: ControlAvailability
  commandAccess: ControlAvailability
  queueAccess: ControlAvailability
  questionAccess: ControlAvailability
  /** `session/control` 投影流本身（没有它就没有标题 / 模型 / 权限 / 队列的权威值） */
  projectionAccess: ControlAvailability

  /* ── 数据 ── */
  modelCatalog: RemoteModelCatalog | null
  /** 当前模型：投影 > `selectModel` 的返回值 > 目录默认值 */
  currentModel: RemoteModelSelection | null
  permissions: RemotePermissionOption[]
  /** 投影给的当前预设；没有投影时为 `null`（胶囊显示「Host 默认」） */
  currentPermission: string | null
  commands: RemoteSlashCommand[]
  queue: RemoteQueueItem[]
  questions: Record<string, RemoteQuestionState>
  /** 投影里的 `title`（顶栏标题用它覆盖列表里的旧值） */
  title: string | null
  /** 投影里的 `usage`（没有就由 UI 用时间线汇总） */
  usage: RemoteUsage | null

  /* ── 忙碌 / 错误 ── */
  loadingModel: boolean
  loadingPermission: boolean
  loadingCommands: boolean
  /** 正在处理的队列条目 id（`steer` / `remove` 按钮据此禁用） */
  queueBusy: string | null
  error: { code: string; message: string } | null

  /* ── 动作 ── */
  /** 一次把所有入口探测一遍（挂载时调用；单飞 + 幂等） */
  probe(): Promise<void>
  loadModelCatalog(force?: boolean): Promise<void>
  selectModel(selection: RemoteModelSelection): Promise<boolean>
  loadPermissions(force?: boolean): Promise<void>
  selectPermission(preset: string): Promise<boolean>
  loadCommands(force?: boolean): Promise<void>
  /** 执行一条斜杠命令；返回 Host 的文案（失败时 `error` 里也有一份） */
  executeCommand(line: string): Promise<{ kind: 'success' | 'error'; text?: string } | null>
  updateQueueItem(itemId: string, action: 'steer' | 'remove'): Promise<boolean>
  clearQueue(): Promise<void>
  /** 提交一条提问的答案（内部按 phase 选 `$events/result` 或 `userQuestions/answer`） */
  answerQuestion(key: string, selected: Record<string, string[]>, custom: Record<string, string>): Promise<boolean>
  clearError(): void
}

const EMPTY_QUESTIONS: Record<string, RemoteQuestionState> = {}

const INITIAL_CONTROLS = {
  modelAccess: 'unknown' as ControlAvailability,
  permissionAccess: 'unknown' as ControlAvailability,
  commandAccess: 'unknown' as ControlAvailability,
  queueAccess: 'unknown' as ControlAvailability,
  questionAccess: 'unknown' as ControlAvailability,
  projectionAccess: 'unknown' as ControlAvailability,
  modelCatalog: null as RemoteModelCatalog | null,
  currentModel: null as RemoteModelSelection | null,
  permissions: [] as RemotePermissionOption[],
  currentPermission: null as string | null,
  commands: [] as RemoteSlashCommand[],
  queue: [] as RemoteQueueItem[],
  questions: EMPTY_QUESTIONS,
  title: null as string | null,
  usage: null as RemoteUsage | null,
  loadingModel: false,
  loadingPermission: false,
  loadingCommands: false,
  queueBusy: null as string | null,
  error: null as { code: string; message: string } | null,
}

export const useChatControls = create<ChatControlsState>(() => ({
  ...INITIAL_CONTROLS,

  probe: async (): Promise<void> => {
    await Promise.all([
      useChatControls.getState().loadModelCatalog(),
      useChatControls.getState().loadPermissions(),
      useChatControls.getState().loadCommands(),
    ])
  },

  loadModelCatalog: async (force = false): Promise<void> => {
    const state = useChatControls.getState()
    if (state.modelAccess === 'unavailable') return
    if (!force && (state.modelCatalog !== null || state.loadingModel)) return
    if (deps === null) return
    const target = deps.target
    useChatControls.setState({ loadingModel: true })
    try {
      const result = await callEndpoint<unknown>(target, ENDPOINTS.modelCatalog, {}, CALL_TIMEOUT_MS)
      const catalog = parseModelCatalog(result)
      if (catalog === null) {
        // 形状不对：Host 有这个端点但给不出目录 —— 按「不可用」隐藏，而不是显示半截列表
        useChatControls.setState({ modelAccess: 'unavailable', modelCatalog: null, loadingModel: false })
        return
      }
      const projected = useChatControls.getState().currentModel
      useChatControls.setState({
        modelAccess: 'available',
        modelCatalog: catalog,
        currentModel: projected ?? catalog.defaultModel,
        loadingModel: false,
        error: null,
      })
    } catch (error) {
      useChatControls.setState({
        loadingModel: false,
        ...(isUnsupportedError(error)
          ? { modelAccess: 'unavailable' as ControlAvailability, modelCatalog: null }
          : { error: { code: codeOf(error), message: textOf(error, '拉取模型列表失败') } }),
      })
    }
  },

  selectModel: async (selection: RemoteModelSelection): Promise<boolean> => {
    const sessionId = currentSessionId
    if (sessionId === null || deps === null) return false
    const target = deps.target
    try {
      const result = await callEndpoint<{ selected?: unknown }>(
        target,
        ENDPOINTS.selectModel,
        {
          request: {
            sessionId,
            provider: selection.provider,
            model: selection.model,
            ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
          },
        },
        CALL_TIMEOUT_MS,
      )
      // Host 是权威：它返回 `selected` 就用它，否则用我们发出去的那份
      const selected = parseModelSelection(result?.selected) ?? selection
      useChatControls.setState({ currentModel: selected, modelAccess: 'available', error: null })
      return true
    } catch (error) {
      if (isUnsupportedError(error)) {
        useChatControls.setState({ modelAccess: 'unavailable' })
        return false
      }
      useChatControls.setState({ error: { code: codeOf(error), message: textOf(error, '切换模型失败') } })
      return false
    }
  },

  loadPermissions: async (force = false): Promise<void> => {
    const state = useChatControls.getState()
    if (state.permissionAccess === 'unavailable') return
    if (!force && (state.permissions.length > 0 || state.loadingPermission)) return
    if (deps === null) return
    const target = deps.target
    useChatControls.setState({ loadingPermission: true })
    try {
      const result = await callEndpoint<unknown>(target, ENDPOINTS.permissionCatalog, {}, CALL_TIMEOUT_MS)
      const options = parsePermissionCatalog(result)
      useChatControls.setState({
        loadingPermission: false,
        // 空列表 = 这台 Host 没开放权限预设（不是错误，隐藏胶囊即可）
        permissionAccess: options.length > 0 ? 'available' : 'unavailable',
        permissions: options,
      })
    } catch (error) {
      useChatControls.setState({
        loadingPermission: false,
        ...(isUnsupportedError(error)
          ? { permissionAccess: 'unavailable' as ControlAvailability, permissions: [] }
          : { error: { code: codeOf(error), message: textOf(error, '拉取权限预设失败') } }),
      })
    }
  },

  selectPermission: async (preset: string): Promise<boolean> => {
    const sessionId = currentSessionId
    if (sessionId === null || deps === null) return false
    if (!PERMISSION_PRESET_PATTERN.test(preset)) {
      useChatControls.setState({ error: { code: 'INVALID_ARGUMENT', message: '权限预设名不合法' } })
      return false
    }
    const target = deps.target
    try {
      // 官方只有这一条路：`commands/execute` 的 `/permission <preset>`（input-B §2.10）
      const result = await executeCommandOn(target, sessionId, `/permission ${preset}`)
      if (result.kind === 'error') {
        useChatControls.setState({
          error: { code: 'COMMAND_FAILED', message: result.text ?? '远端拒绝了权限预设' },
        })
        return false
      }
      useChatControls.setState({ currentPermission: preset, error: null })
      // 同一条值也进按会话缓存：下一次不含权限键的投影/切会话不会把它冲掉
      noteSessionPermissionPreset(sessionId, preset)
      return true
    } catch (error) {
      if (isUnsupportedError(error)) {
        useChatControls.setState({ permissionAccess: 'unavailable' })
        return false
      }
      useChatControls.setState({ error: { code: codeOf(error), message: textOf(error, '切换权限预设失败') } })
      return false
    }
  },

  loadCommands: async (force = false): Promise<void> => {
    const state = useChatControls.getState()
    if (state.commandAccess === 'unavailable') return
    if (!force && (state.commands.length > 0 || state.loadingCommands)) return
    if (deps === null) return
    const target = deps.target
    useChatControls.setState({ loadingCommands: true })
    try {
      const commands = await fetchCommands(target, currentSessionId)
      useChatControls.setState({
        loadingCommands: false,
        commandAccess: commands.length > 0 ? 'available' : 'unavailable',
        commands,
      })
    } catch (error) {
      useChatControls.setState({
        loadingCommands: false,
        ...(isUnsupportedError(error)
          ? { commandAccess: 'unavailable' as ControlAvailability, commands: [] }
          : { error: { code: codeOf(error), message: textOf(error, '拉取命令列表失败') } }),
      })
    }
  },

  executeCommand: async (line: string): Promise<{ kind: 'success' | 'error'; text?: string } | null> => {
    const sessionId = currentSessionId
    if (sessionId === null || deps === null) return null
    try {
      const result = await executeCommandOn(deps.target, sessionId, line)
      if (result.kind === 'success') {
        useChatControls.setState({ error: null })
        // 权限/模型类命令会改投影（Host 也会自己推一遍）；低成本的本地预期先落上
        const permission = /^\/permission\s+(\S+)/.exec(line.trim())
        if (permission !== null && PERMISSION_PRESET_PATTERN.test(permission[1] ?? '')) {
          useChatControls.setState({ currentPermission: permission[1] })
        }
      } else {
        useChatControls.setState({
          error: { code: 'COMMAND_FAILED', message: result.text ?? '命令执行失败' },
        })
      }
      return result
    } catch (error) {
      if (isUnsupportedError(error)) {
        useChatControls.setState({ commandAccess: 'unavailable' })
        return null
      }
      useChatControls.setState({ error: { code: codeOf(error), message: textOf(error, '命令执行失败') } })
      return null
    }
  },

  updateQueueItem: async (itemId: string, action: 'steer' | 'remove'): Promise<boolean> => {
    const sessionId = currentSessionId
    if (sessionId === null || deps === null) return false
    if (useChatControls.getState().queueBusy !== null) return false
    const target = deps.target
    useChatControls.setState({ queueBusy: itemId })
    try {
      const result = await callEndpoint<{ accepted?: boolean }>(
        target,
        ENDPOINTS.updateQueue,
        { request: { sessionId, itemId, action: { kind: action } } },
        CALL_TIMEOUT_MS,
      )
      if (result?.accepted !== true) {
        useChatControls.setState({ error: { code: 'INVALID_RESPONSE', message: '远端没有确认队列操作' } })
        return false
      }
      useChatControls.setState({ queueAccess: 'available', error: null })
      // 本地先摘掉（Host 会推新的 `inbox` 投影，届时以投影为准）
      useChatControls.setState({
        queue: useChatControls.getState().queue.filter((item) => item.id !== itemId),
      })
      return true
    } catch (error) {
      if (isUnsupportedError(error)) {
        useChatControls.setState({ queueAccess: 'unavailable' })
        return false
      }
      const code = codeOf(error)
      // 条目已不在队列里（Host 抢先处理了）：把它从本地列表摘掉，别让人反复点
      if (code === 'gone' || /queue-item-not-found/i.test(code)) {
        useChatControls.setState({
          queue: useChatControls.getState().queue.filter((item) => item.id !== itemId),
        })
        return false
      }
      useChatControls.setState({ error: { code, message: textOf(error, '队列操作失败') } })
      return false
    } finally {
      useChatControls.setState({ queueBusy: null })
    }
  },

  clearQueue: async (): Promise<void> => {
    // 没有批量接口：逐条 remove（顺序发，避免 Host 侧队列顺序抖动）
    for (const item of [...useChatControls.getState().queue]) {
      if (item.id === undefined) continue
      await useChatControls.getState().updateQueueItem(item.id, 'remove')
    }
  },

  answerQuestion: async (
    key: string,
    selected: Record<string, string[]>,
    custom: Record<string, string>,
  ): Promise<boolean> => {
    const state = useChatControls.getState()
    const question = state.questions[key]
    if (question === undefined || deps === null) return false
    if (question.phase === 'claiming') return false
    if (isQuestionTerminal(question.phase)) return false
    const answer = buildQuestionAnswer(question.questions, selected, custom)
    if (answer.answers.length === 0) return false
    const target = deps.target
    useChatControls.setState((current) => ({
      questions: { ...current.questions, [key]: { ...question, submitting: true, error: undefined } },
    }))
    const fail = (code: string, message: string, nextPhase?: QuestionPhase): false => {
      useChatControls.setState((current) => {
        const latest = current.questions[key] ?? question
        return {
          questions: {
            ...current.questions,
            [key]: { ...latest, submitting: false, error: message, ...(nextPhase === undefined ? {} : { phase: nextPhase }) },
          },
          ...(code === 'QUESTION_EXPIRED' ? {} : { error: { code, message } }),
        }
      })
      return false
    }
    try {
      if (question.phase === 'continued') {
        // 只有投影说 `continued` 之后才准走这条补答通道
        const result = await callEndpoint<unknown>(
          target,
          ENDPOINTS.questionAnswer,
          {
            agentId: question.sessionId,
            callId: question.callId,
            answer,
          },
          CALL_TIMEOUT_MS,
        )
        if (result === false || (isRecord(result) && result.ok === true && result.value === false)) {
          return fail('PERMISSION_NOT_PENDING', '这条提问已经失效（可能已在别处回答或已超时）', 'cancelled')
        }
        finishQuestion(key, 'queued')
        return true
      }
      if (question.phase === 'expired') {
        return fail('QUESTION_EXPIRED', '问答窗口已经结束，等 Host 刷新提问状态', 'expired')
      }
      // `open`（含没有 attachWait 的普通瀑布）：走 `$events/result`
      const clientId = deps.eventClientId()
      if (clientId === null) return fail('EVENT_STREAM_NOT_READY', '事件流还没就绪，稍后再试')
      if (question.eventId === undefined) return fail('INVALID_RESPONSE', '这条提问没有可应答的句柄')
      await callEndpoint<unknown>(
        target,
        ENDPOINTS.eventsResult,
        { clientId, eventId: question.eventId, outcome: { kind: 'result', value: answer } },
        CALL_TIMEOUT_MS,
      )
      finishQuestion(key, 'answered')
      return true
    } catch (error) {
      const code = codeOf(error)
      if (code === 'PERMISSION_NOT_PENDING' || code === 'QUESTION_REPLY_REJECTED') {
        return fail(code, textOf(error, '这条提问已经失效'), 'cancelled')
      }
      if (isUnsupportedError(error)) {
        useChatControls.setState({ questionAccess: 'unavailable' })
        return fail(code === '' ? 'UNSUPPORTED' : code, textOf(error, '这台 Host 不支持在线回答问题'), 'cancelled')
      }
      return fail(code, textOf(error, '提交答案失败'))
    } finally {
      useChatControls.setState((current) => {
        const latest = current.questions[key]
        if (latest === undefined || latest.submitting !== true) return {}
        return { questions: { ...current.questions, [key]: { ...latest, submitting: false } } }
      })
    }
  },

  clearError: (): void => {
    useChatControls.setState({ error: null })
  },
}))

/* ────────────────────────────────────────────────────────────────────────
 * 五、RPC 小工具
 * ──────────────────────────────────────────────────────────────────────── */

/** `commands/execute` 的薄封装：只做「拼 args + 解包 result」。 */
const executeCommandOn = async (
  target: RemoteCallTarget,
  sessionId: string,
  line: string,
): Promise<{ kind: 'success' | 'error'; text?: string }> => {
  const trimmed = line.trim()
  if (trimmed.length === 0) throw new RemoteApiError('INVALID_ARGUMENT', '命令不能为空')
  const timeoutMs = /^\/compact(?:\s|$)/.test(trimmed) ? COMPACT_TIMEOUT_MS : COMMAND_TIMEOUT_MS
  const result = await callEndpoint<{ result?: { kind?: unknown; text?: unknown } }>(
    target,
    ENDPOINTS.commandsExecute,
    { agentId: sessionId, line: trimmed, submittedAttachments: [] },
    timeoutMs,
  )
  const kind = result?.result?.kind
  const text = asString(result?.result?.text)
  if (kind !== 'success' && kind !== 'error') {
    throw new RemoteApiError('INVALID_RESPONSE', '远端没有返回命令执行结果')
  }
  return { kind, ...(text === undefined ? {} : { text }) }
}

/**
 * 拉命令列表。
 *
 * `commands/list` 的 args 上游没有权威文档（`harness-remote-bridge.ts:130` 只在 allowlist 里），
 * 两种实现都能在仓库里找到痕迹：`acp/virtual-harness.ts:1308` 的 `extractSessionId(args)` 说明它
 * **可能**接受 `agentId`，而 `requestArg(args)` 的调用点又暗示可以什么都不带。所以这里按
 * 「先带 `agentId`，被拒就退化成空对象」的顺序各试一次 —— 两次都失败才算不可用。
 */
const fetchCommands = async (
  target: RemoteCallTarget,
  sessionId: string | null,
): Promise<RemoteSlashCommand[]> => {
  const attempts: Record<string, unknown>[] =
    sessionId === null ? [{}] : [{ agentId: sessionId }, {}]
  let lastError: unknown = null
  for (const args of attempts) {
    try {
      const result = await callEndpoint<unknown>(target, ENDPOINTS.commandsList, args, CALL_TIMEOUT_MS)
      return parseCommandList(result)
    } catch (error) {
      if (isUnsupportedError(error)) throw error
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new RemoteApiError('INVALID_RESPONSE', '拿不到命令列表')
}

/* ────────────────────────────────────────────────────────────────────────
 * 六、生命周期：store.ts 注入依赖 / 投喂投影 / 投喂提问
 * ──────────────────────────────────────────────────────────────────────── */

/** 连接建立后由 `store.ts` 调用（重复调用会先释放上一代资源）。 */
export const bindSessionControls = (input: SessionControlsDeps): void => {
  unbindSessionControls()
  deps = input
}

/**
 * 断开时由 `store.ts` 调用。
 *
 * 提问的 claim **必须在这里释放**：断线后句柄作废，官方要求「释放 claim、取消本地计时、
 * 禁止重放回复」（`harness-questions.ts:186-194`）。
 */
export const unbindSessionControls = (): void => {
  deps = null
  currentSessionId = null
  projectionCache.clear()
  for (const timer of expiryTimers.values()) clearTimeout(timer)
  expiryTimers.clear()
  for (const handle of waitStreams.values()) void handle.close().catch(() => undefined)
  waitStreams.clear()
  useChatControls.setState({ ...INITIAL_CONTROLS, questions: {} })
}

/**
 * 切到某个会话（`store.ts` 的 `openSession` / 关闭会话时调用）。
 *
 * 投影是按会话缓存的，切换时把当前会话的投影重新投影成界面字段；提问状态**只保留当前会话**的。
 */
export const selectControlSession = (sessionId: string | null): void => {
  currentSessionId = sessionId
  useChatControls.setState({ questions: sessionId === null ? {} : useChatControls.getState().questions })
  if (sessionId === null) {
    useChatControls.setState({
      title: null,
      currentModel: useChatControls.getState().modelCatalog?.defaultModel ?? null,
      currentPermission: null,
      queue: [],
      usage: null,
    })
    return
  }
  applyProjection(sessionId)
}

/**
 * 投喂一帧 `session/control`（`store.ts` 的 `session/control` sink 调用）。
 *
 * 两种形状（`harness-alpha-client.ts:1439-1471`）：
 *   - `{type:'baseline', value:{projections:{sessionId:{asOfSeq,values}}}}`
 *   - `{type:'projection', sessionId, seq, changes:[{key,val}]}` 或 `{...key,value}`
 */
export const applyControlFrame = (item: unknown): void => {
  if (!isRecord(item)) return
  if (item.type === 'baseline') {
    const value = isRecord(item.value) ? item.value : undefined
    const projections = isRecord(value?.projections) ? value.projections : undefined
    if (projections === undefined) return
    for (const [sessionId, block] of Object.entries(projections)) {
      if (!isRecord(block) || !isRecord(block.values)) continue
      projectionCache.set(sessionId, { ...(projectionCache.get(sessionId) ?? {}), ...block.values })
      // baseline 里的权限键可能不叫 `permissions`：用同一套多路解析收进按会话缓存
      const preset = permissionPresetOfValues(block.values)
      if (preset !== undefined) noteSessionPermissionPreset(sessionId, preset)
    }
    useChatControls.setState({ projectionAccess: 'available' })
    if (currentSessionId !== null) applyProjection(currentSessionId)
    return
  }
  if (item.type !== 'projection') return
  const sessionId = asString(item.sessionId)
  if (sessionId === undefined) return
  const cache = projectionCache.get(sessionId) ?? {}
  if (Array.isArray(item.changes)) {
    for (const change of item.changes) {
      if (!isRecord(change) || typeof change.key !== 'string') continue
      cache[change.key] = change.val
    }
  } else if (typeof item.key === 'string') {
    cache[item.key] = item.value
  } else {
    return
  }
  projectionCache.set(sessionId, cache)
  useChatControls.setState({ projectionAccess: 'available' })
  /*
   * 权限跟着帧更新，并带 `seq` 防旧覆盖（乱序帧比已知值旧就不许写回 ——
   * dsh-Go 的 `_keySeq` 同一个道理）。
   */
  const seq = typeof item.seq === 'number' ? item.seq : undefined
  const preset = permissionPresetOfValues(cache)
  if (preset !== undefined) noteSessionPermissionPreset(sessionId, preset, seq)
  if (sessionId === currentSessionId) applyProjection(sessionId)
}

/** `session/control` 打不开时由 `store.ts` 告知（能力缺失 ≠ 错误）。 */
export const noteControlUnavailable = (code?: string): void => {
  if (code !== undefined && !UNSUPPORTED_CODES.has(code) && code !== 'STREAM_CLOSED') return
  useChatControls.setState({ projectionAccess: 'unavailable' })
}

/** 把某个会话的投影投影成界面字段（投影变了 / 切会话时调）。 */
const applyProjection = (sessionId: string): void => {
  const values = projectionCache.get(sessionId) ?? {}
  const model = modelSelectionOfProjection(values.modelSelection)
  const permissions = permissionProjectionOf(values.permissions)
  /*
   * 权限预设：投影里有多路来源（见 `permissionPresetOfValues`），取不到就**沿用缓存**。
   * 这里以前写的是 `permissions?.currentValue ?? null` —— 只认 `permissions` 一个位置，
   * 而且取不到就清成 null：于是 Host 用的是 `permission` 键时，界面永远显示「默认」，
   * 用户看到的就是「权限模式跟实际用的不一样」。也顺带避免了「一次不含权限键的投影
   * 把刚点出来的值清掉」。
   */
  const preset = permissionPresetOfValues(values) ?? presetBySession.get(sessionId) ?? null
  if (preset !== null) presetBySession.set(sessionId, preset)
  const catalog = useChatControls.getState().modelCatalog
  useChatControls.setState({
    title: asString(values.title) ?? null,
    currentModel: model ?? useChatControls.getState().currentModel ?? catalog?.defaultModel ?? null,
    currentPermission: preset,
    permissions:
      permissions !== null && permissions.options.length > 0
        ? permissions.options
        : useChatControls.getState().permissions,
    queue: parseInboxQueue(values.inbox),
    usage: usageOfProjection(values.usage),
  })
  // 投影里的权限列表比 `permissionPresets/catalog` 更贴近会话：有它就说明能力可用
  if (permissions !== null) {
    useChatControls.setState({ permissionAccess: 'available' })
  }
  // 有 `inbox` 就说明这台 Host 有队列（能不能操作要等真点一次才知道）
  if (isRecord(values.inbox)) {
    useChatControls.setState((current) => ({
      queueAccess: current.queueAccess === 'unknown' ? 'available' : current.queueAccess,
    }))
  }
  if (isRecord(values.userQuestions)) reconcileQuestions(sessionId, values.userQuestions)
}

/**
 * 投喂一条 `$events` 的 item（`store.ts` 的 `$events` sink 调用）。
 *
 * 只关心两类：`waterfall user-questions/request`（登记提问、开 `attachWait`）与
 * `{type:'cancel', eventId}`（Host 撤销）。审批不在这里 —— 那条路 `store.ts` 已经有了。
 */
export const ingestEventsItem = (item: unknown, sessionId: string | null): void => {
  if (!isRecord(item)) return
  if (item.type === 'cancel' && typeof item.eventId === 'string') {
    cancelQuestionByEventId(item.eventId)
    return
  }
  const parsed = parseQuestionWaterfall(item, sessionId)
  if (parsed === null) return
  const key = questionKey({ ...(parsed.callId === undefined ? {} : { callId: parsed.callId }), eventId: parsed.eventId })
  if (key === null) return
  const existing = useChatControls.getState().questions[key]
  const next: RemoteQuestionState = {
    sessionId: parsed.sessionId,
    eventId: parsed.eventId,
    ...(parsed.callId === undefined ? {} : { callId: parsed.callId }),
    questions: parsed.questions,
    questionState: 'open',
    // 同一个 key 重投（重连后 Host 会用同一 eventId 重发）：保留已有的本地状态，别把倒计时重置
    phase: existing?.phase !== undefined && !isQuestionTerminal(existing.phase) ? existing.phase : 'claiming',
    timed: parsed.timed,
    ...(existing?.deadline === undefined ? {} : { deadline: existing.deadline }),
  }
  useChatControls.setState((current) => ({ questions: { ...current.questions, [key]: next } }))
  if (parsed.timed && parsed.callId !== undefined && existing === undefined) {
    void claimQuestion(key, parsed.sessionId, parsed.callId)
  }
}

/**
 * 认领一条限时提问（`userQuestions/attachWait`）。
 *
 * 首帧 `{remainingMs}` 是唯一可信的窗口时长；流关闭表示问题结束（正常收尾 / 已被别处答掉）。
 * 认领失败**不**把入口藏起来：老 Host 没有这个端点时还留着普通 waterfall 的应答路径。
 */
const claimQuestion = async (key: string, sessionId: string, callId: string): Promise<void> => {
  const current = deps
  if (current === null) return
  try {
    const handle = await current.target.openStream(
      ENDPOINTS.questionAttachWait,
      { args: { agentId: sessionId, callId } },
      { timeoutMs: CLAIM_TIMEOUT_MS },
    )
    if (deps !== current) {
      void handle.close().catch(() => undefined)
      return
    }
    waitStreams.set(key, handle)
    let opened = false
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const release = current.registerStreamSink(handle.streamId, (payload) => {
      if (payload.type === 'closed') {
        const registered = waitStreams.get(key)
        waitStreams.delete(key)
        if (registered?.streamId === handle.streamId) void registered.close().catch(() => undefined)
        // 流关闭 = 窗口结束（问题被答掉 / Host 收走了）：仍在可答态就标成 expired，
        // 让 UI 提示「等 Host 刷新」，而不是继续显示一个点了会报错的输入区。
        const state = useChatControls.getState().questions[key]
        if (state !== undefined && state.phase === 'open') {
          patchQuestion(key, { phase: 'expired' })
        }
        return
      }
      if (payload.type !== 'frame' || payload.hasValue !== true) return
      const value = payload.value
      if (!isRecord(value)) return
      const remaining = value.remainingMs
      if (typeof remaining !== 'number' || !Number.isFinite(remaining) || remaining < 0) return
      opened = true
      if (watchdog !== undefined) clearTimeout(watchdog)
      useChatControls.setState({ questionAccess: 'available' })
      patchQuestion(key, { phase: 'open', deadline: Date.now() + remaining })
      scheduleExpiry(key, remaining)
    })
    /*
     * 兜底：Host 认领成功但迟迟不给 `remainingMs`（老 Host / 异常）时，卡片不能永远停在
     * 「正在接入问答…」——超时后按**普通瀑布**处理（阶段 `open` + `timed:false`），
     * 答案仍走 `$events/result`，只是没有倒计时。
     */
    if (!opened) {
      watchdog = setTimeout(() => {
        const state = useChatControls.getState().questions[key]
        if (state === undefined || state.phase !== 'claiming') return
        patchQuestion(key, { phase: 'open', timed: false })
        // 这条流已经没用了：撤掉接收器并关掉（Host 端也会看到 claim 结束）
        release()
        void handle.close().catch(() => undefined)
      }, CLAIM_FRAME_TIMEOUT_MS)
    }
  } catch (error) {
    // `attachWait` 不存在：退回「普通瀑布」，用 `$events/result` 直接答（阶段改成 open 且无 deadline）
    if (isUnsupportedError(error)) {
      useChatControls.setState({ questionAccess: 'unavailable' })
    }
    patchQuestion(key, { phase: 'open', timed: false })
  }
}

/** 排一个本地倒计时：到点把提问标成 `expired` 并回一组 `ASK_TIMED_OUT`。 */
const scheduleExpiry = (key: string, remainingMs: number): void => {
  const existing = expiryTimers.get(key)
  if (existing !== undefined) clearTimeout(existing)
  const timer = setTimeout(() => {
    expiryTimers.delete(key)
    const state = useChatControls.getState().questions[key]
    if (state === undefined || state.phase !== 'open') return
    patchQuestion(key, { phase: 'expired' })
    // 官方在窗口到期时回 `{kind:'rejected', error:{code:'ASK_TIMED_OUT'}}`（不是用户答案，不算重放）
    const current = deps
    const clientId = current?.eventClientId() ?? null
    if (current === null || clientId === null || state.eventId === undefined) return
    void callEndpoint<unknown>(
      current.target,
      ENDPOINTS.eventsResult,
      {
        clientId,
        eventId: state.eventId,
        outcome: {
          kind: 'rejected',
          error: { name: 'UserQuestionError', code: 'ASK_TIMED_OUT', message: '问答窗口已结束' },
        },
      },
      CALL_TIMEOUT_MS,
    ).catch(() => undefined)
  }, Math.max(0, remainingMs))
  expiryTimers.set(key, timer)
}

const patchQuestion = (key: string, patch: Partial<RemoteQuestionState>): void => {
  useChatControls.setState((current) => {
    const state = current.questions[key]
    if (state === undefined) return {}
    return { questions: { ...current.questions, [key]: { ...state, ...patch } } }
  })
}

/** 一条提问落定：关 claim、清计时器、标终态。 */
const finishQuestion = (key: string, phase: QuestionPhase): void => {
  const timer = expiryTimers.get(key)
  if (timer !== undefined) {
    clearTimeout(timer)
    expiryTimers.delete(key)
  }
  const handle = waitStreams.get(key)
  if (handle !== undefined) {
    waitStreams.delete(key)
    void handle.close().catch(() => undefined)
  }
  patchQuestion(key, { phase, submitting: false, error: undefined })
}

const cancelQuestionByEventId = (eventId: string): void => {
  for (const [key, state] of Object.entries(useChatControls.getState().questions)) {
    if (state.eventId !== eventId) continue
    if (isQuestionTerminal(state.phase)) continue
    finishQuestion(key, 'cancelled')
  }
}

/**
 * Host 的 `userQuestions` 投影是提问状态的**权威**（`harness-questions.ts:67-109`）：
 *   `{active:[{callId, questions, state:'open'|'continued'}], settled:[{callId}]}`
 *
 * 三件事：`continued` → 允许 `userQuestions/answer` 补答；`settled` → 标成已答；
 * 投影里出现、但本地没有的（重连后只有投影）→ 补一条进来。
 */
const reconcileQuestions = (sessionId: string, value: unknown): void => {
  if (!isRecord(value) || !Array.isArray(value.active) || !Array.isArray(value.settled)) return
  const activeCallIds = new Set<string>()
  const updates: Record<string, RemoteQuestionState> = {}
  for (const row of asArray(value.active)) {
    if (!isRecord(row)) continue
    const callId = asString(row.callId)
    if (callId === undefined) continue
    const state = row.state === 'continued' ? 'continued' : 'open'
    activeCallIds.add(callId)
    const key = `timed:${callId}`
    const questions = parseQuestionItems(row.questions)
    const existing = useChatControls.getState().questions[key] ?? updates[key]
    if (existing !== undefined && isQuestionTerminal(existing.phase)) continue
    const next: RemoteQuestionState = {
      sessionId,
      ...(existing?.eventId === undefined ? {} : { eventId: existing.eventId }),
      callId,
      questions: questions.length > 0 ? questions : (existing?.questions ?? []),
      questionState: state,
      // `continued` 之后旧的限时窗口作废：清 deadline，走 `answer` 通道
      phase: state === 'continued' ? 'continued' : (existing?.phase ?? 'open'),
      timed: existing?.timed ?? true,
      ...(state === 'continued' || existing?.deadline === undefined ? {} : { deadline: existing.deadline }),
      ...(existing?.submitting === true ? { submitting: true } : {}),
    }
    if (state === 'continued') {
      // 投影推进到 continued：本地 claim 与倒计时都该收掉
      const timer = expiryTimers.get(key)
      if (timer !== undefined) {
        clearTimeout(timer)
        expiryTimers.delete(key)
      }
      const handle = waitStreams.get(key)
      if (handle !== undefined) {
        waitStreams.delete(key)
        void handle.close().catch(() => undefined)
      }
    }
    updates[key] = next
  }
  const settledCallIds = new Set(
    asArray(value.settled).flatMap((row) => {
      const callId = isRecord(row) ? asString(row.callId) : undefined
      return callId === undefined ? [] : [callId]
    }),
  )
  for (const callId of settledCallIds) {
    const key = `timed:${callId}`
    const existing = useChatControls.getState().questions[key]
    if (existing === undefined || isQuestionTerminal(existing.phase)) continue
    updates[key] = { ...existing, phase: 'answered', submitting: false }
  }
  // 不在 active 也不在 settled 的（Host 已清掉）：标成 cancelled，别留一张永远点不动的卡
  for (const [key, state] of Object.entries(useChatControls.getState().questions)) {
    if (state.sessionId !== sessionId) continue
    if (isQuestionTerminal(state.phase)) continue
    const callId = state.callId
    if (callId === undefined) continue
    if (activeCallIds.has(callId) || settledCallIds.has(callId)) continue
    updates[key] = { ...state, phase: 'cancelled' }
  }
  if (Object.keys(updates).length === 0) return
  useChatControls.setState((current) => ({ questions: { ...current.questions, ...updates } }))
}

/* ────────────────────────────────────────────────────────────────────────
 * 七、只读选择器（UI 用；避免在组件里重复写判断）
 * ──────────────────────────────────────────────────────────────────────── */

/** 顶栏胶囊该不该出现：只有明确 `unavailable` 才隐藏。 */
export const showsModelCapsule = (state: ChatControlsState): boolean =>
  state.modelAccess !== 'unavailable' && state.currentModel !== null

export const showsPermissionCapsule = (state: ChatControlsState): boolean =>
  state.permissionAccess !== 'unavailable' &&
  (state.permissions.length > 0 || state.currentPermission !== null)

/** 队列条：能力缺失 / 没排队时都不显示。 */
export const showsQueueDock = (state: ChatControlsState): boolean =>
  state.queueAccess !== 'unavailable' && state.queue.length > 0

/** 斜杠补全：命令列表拿不到就不弹。 */
export const showsCommandCompletion = (state: ChatControlsState): boolean =>
  state.commandAccess === 'available' && state.commands.length > 0

/** 时间线里的提问卡是否还能操作。 */
export const isQuestionAnswerable = (state: RemoteQuestionState): boolean =>
  !isQuestionTerminal(state.phase) && state.phase !== 'claiming' && state.submitting !== true
