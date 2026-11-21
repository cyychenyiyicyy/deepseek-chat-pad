/**
 * 审批卡 / 提问卡共用的**纯逻辑**（无 React、无 CSS、无 store）：
 *
 *   1. 审批「要做什么」的要点提取与**按类型裁剪**（命令原文 / 文件路径 / 网址）；
 *   2. 风险分类（读 / 写 / 删 / 外网），卡片据此换语气与按钮颜色；
 *   3. 决策集合（v1 只有 `allow_once` / `deny`；Host 若给 `allow_session` 一律丢弃）；
 *   4. 提问的字数上限与提交校验；
 *   5. 会话列表红点的**按 eventId 去重**计数（审批与提问各一）。
 *
 * 为什么单独成文件：这些规则要能被 `__selftest__` 直接 import 断言，而卡片本体（`.tsx`）
 * 会连带拉进 React 与 CSS Modules，`node`/`tsx` 里 import 不了。所以规则留在这里，
 * 组件只做「读 store + 画 JSX」。
 *
 * 依赖方向：本文件只 import `services/remote/adapter.ts` 的**类型**和
 * `tool/toolMeta.ts` 的纯函数；反过来没有任何模块 import 本文件的渲染部分。
 */

import type { ApprovalOutcome, ChatItem, ToolActivity } from '../../../services/remote/adapter.js'
import { oneLine, parseArguments, pickString, toolKindOf, type ToolKind } from '../tool/toolMeta.js'

/* ──────────────────────────── 一、审批：决策集合 ──────────────────────────── */

/**
 * v1 允许的应答值（`input-B-rpc-surface.md` §2.6：TS 客户端只发这两个）。
 *
 * **禁止 `allow_session` / session grant**：协议安全不变量 8 写死了 v1 只能「允许一次」。
 * 所以这里不是「暂时没做」，而是**不允许做**——Host 就算在请求里带了这类选项，
 * 也只能被丢弃（见 `approvalAllowsOnce`）。
 */
export const APPROVAL_DECISIONS = ['allow_once', 'deny'] as const
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number]

/**
 * Host 若显式给了可选决定（`request.options` / `request.decisions`），
 * 只保留 v1 允许的两种；返回 `undefined` 表示「Host 没说，按默认两种都行」。
 *
 * `allow_session`、`always`、`allow_always` 之类**不会**出现在返回值里 —— 也就不可能被渲染成按钮。
 */
export const normalizeApprovalOptions = (raw: unknown): ApprovalDecision[] | undefined => {
  if (!Array.isArray(raw)) return undefined
  const kept = raw.filter((value): value is ApprovalDecision =>
    value === 'allow_once' || value === 'deny')
  return kept.length > 0 ? [...new Set(kept)] : undefined
}

/** 能不能显示「允许一次」：Host 没给选项时默认可以；给了但没 `allow_once` 就不给点。 */
export const approvalAllowsOnce = (options: readonly ApprovalDecision[] | undefined): boolean =>
  options === undefined || options.includes('allow_once')

/* ──────────────────────────── 二、审批：终态判据 ──────────────────────────── */

export type ApprovalStatus = 'pending' | 'allowed' | 'rejected' | 'cancelled' | 'expired'

/** 展示状态：`unavailable` 与 `cancelled` 都是「这条已经作废」，但文案不同。 */
export const approvalStatusOf = (outcome: ApprovalOutcome | undefined): ApprovalStatus => {
  if (outcome === 'allowed-once') return 'allowed'
  if (outcome === 'rejected') return 'rejected'
  if (outcome === 'cancelled') return 'cancelled'
  if (outcome === 'unavailable') return 'expired'
  return 'pending'
}

export const isApprovalTerminal = (outcome: ApprovalOutcome | undefined): boolean =>
  approvalStatusOf(outcome) !== 'pending'

/**
 * Host 回 `PERMISSION_NOT_PENDING` / `AGENT_BUSY` 时，该不该把这张卡降级成「已失效」。
 *
 * 只有**还没结论**的才降。双击或重连后的第二次提交也会拿到 `PERMISSION_NOT_PENDING`，
 * 但那条其实已经 allowed-once 了 —— 再降级会把一次成功的「允许」显示成失败。
 */
export const shouldExpireApproval = (items: readonly ChatItem[], approvalId: string): boolean =>
  items.some(item => item.kind === 'approval' && item.approvalId === approvalId && item.outcome === undefined)

/* ──────────────────────── 三、审批：要点提取与按类型裁剪 ──────────────────────── */

/** 要点是什么东西：命令行 / 文件路径 / 网址 / 普通文本。决定等宽字体与裁剪规则。 */
export type TargetKind = 'command' | 'path' | 'url' | 'text'

export interface ApprovalTarget {
  /** 展示文本（已按类型裁剪） */
  text: string
  /** `code` = 等宽（命令 / 路径 / URL），`text` = 正文 */
  format: 'code' | 'text'
  kind: TargetKind
  /** 原文更长，被裁了 */
  truncated: boolean
}

/** 命令行最多留 4 行 / 320 字：再长就不是「一句话说清」了，展开看的是工具卡。 */
const MAX_COMMAND_LINES = 4
const MAX_COMMAND_CHARS = 320
/** 路径留整条（少一段就可能指错文件），只限长度 */
const MAX_PATH_CHARS = 240
/** 网址去掉 `#fragment`（对「要访问什么」没有信息量），再限长度 */
const MAX_URL_CHARS = 200
const MAX_TEXT_CHARS = 240

const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//iu

/** 文本本身像什么（工具种类未知时的兜底，例如要点来自 Host 的 `reason`）。 */
export const classifyTargetText = (text: string): TargetKind => {
  const trimmed = text.trim()
  if (URL_RE.test(trimmed) || /^www\./iu.test(trimmed)) return 'url'
  // 纯路径：以盘符 / 根 / 家目录开头，且整条里没有空白（有空白更可能是一条命令）
  if (/^(?:[a-z]:[\\/]|\/|~[\\/]|\.\.?[\\/])/iu.test(trimmed) && !/\s/u.test(trimmed)) return 'path'
  if (/\s/u.test(trimmed)) return 'command'
  return 'text'
}

/** 工具的视觉类别 → 要点类别（`shell` 是命令、读写是路径、web 是网址）。 */
export const targetKindOfTool = (kind: ToolKind): TargetKind => {
  if (kind === 'shell') return 'command'
  if (kind === 'read' || kind === 'readImage' || kind === 'write' || kind === 'edit') return 'path'
  if (kind === 'web') return 'url'
  return 'text'
}

/**
 * 按类型裁剪：命令保留前几行、网址去 fragment、路径只限长。
 *
 * 「按类型裁剪」不是美观问题：命令砍掉换行会把两条命令粘成一条（读起来像另一条命令），
 * 所以命令保留行结构、只在行数与总字数上收口；路径反过来必须单行化（换行会把后半段藏起来）。
 */
export const trimApprovalTarget = (raw: string, kind: TargetKind): ApprovalTarget => {
  const trimmed = raw.trim()
  if (kind === 'command') {
    const lines = trimmed.split(/\r?\n/u).filter((line) => line.trim().length > 0)
    const head = lines.slice(0, MAX_COMMAND_LINES).join('\n')
    const text = head.length > MAX_COMMAND_CHARS ? head.slice(0, MAX_COMMAND_CHARS) : head
    return { text, format: 'code', kind, truncated: text !== trimmed }
  }
  if (kind === 'url') {
    const noFragment = (trimmed.split('#')[0] ?? trimmed).trim()
    const text = noFragment.length > MAX_URL_CHARS ? noFragment.slice(0, MAX_URL_CHARS) : noFragment
    // 去掉 `#fragment` 不算「裁剪」：那一段对「要访问什么」没有信息量
    return { text, format: 'code', kind, truncated: text !== noFragment }
  }
  const flat = oneLine(trimmed)
  const limit = kind === 'path' ? MAX_PATH_CHARS : MAX_TEXT_CHARS
  const text = flat.length > limit ? flat.slice(0, limit) : flat
  return {
    text,
    format: kind === 'path' ? 'code' : 'text',
    kind,
    // 单行化也算裁剪：卡片里不再显示原来的换行
    truncated: text !== trimmed,
  }
}

/** 从工具调用的参数里挑「这次要动什么」（**未裁剪**的原文，风险分类要用整段）。 */
const rawTargetOf = (tool: ToolActivity): { raw: string; kind: TargetKind } | undefined => {
  const args = parseArguments(tool.arguments)
  // `str_replace_editor` 这类名字带前缀的工具，类别要按 `toolKey` 算（与工具卡一致）
  const kind = toolKindOf(tool.toolKey ?? tool.toolName, args)
  const picked = kind === 'shell'
    ? pickString(args, ['command', 'cmd', 'script', 'input'])
    : kind === 'read' || kind === 'readImage' || kind === 'write' || kind === 'edit'
      ? pickString(args, ['file_path', 'path', 'target_file', 'notebook_path', 'filePath'])
      : kind === 'web'
        ? pickString(args, ['url', 'href', 'query', 'q'])
        : pickString(args, ['command', 'file_path', 'path', 'url', 'query', 'pattern', 'prompt'])
  if (picked !== undefined) return { raw: picked, kind: targetKindOfTool(kind) }
  // 参数是半截 JSON / 没有参数：退回数据层已经算好的调用摘要（同样是一行要点）
  const fallback = tool.callDetail?.text ?? tool.summary
  if (fallback === undefined || fallback.trim().length === 0) return undefined
  return { raw: fallback, kind: classifyTargetText(fallback) }
}

/** 同一个 callId 的工具调用（`tool/call` 可能早于也可能晚于审批 waterfall）。 */
const toolForCall = (items: readonly ChatItem[], callId: string | undefined): ToolActivity | undefined => {
  if (callId === undefined || callId.length === 0) return undefined
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item === undefined || item.kind !== 'tool') continue
    if (item.id === callId || item.id.endsWith(`:${callId}`)) return item
  }
  return undefined
}

/**
 * 「这条审批要做什么」+「风险多大」。
 *
 * 数据来源按可信度排序：
 *   1. 同 `callId` 的**工具调用参数**（命令原文 / 文件路径 / URL，最准确）；
 *   2. Host 给的 `reason`（人类可读的一句话，通常是「运行命令」这种，不含参数）。
 *
 * WHY: 审批 waterfall 本身只带 `{toolName, callId, reason}`（协议 §2.6），
 * 命令原文得从时间线里的工具调用取；所以这个函数必须在**渲染时**跑，不能焊进 reducer ——
 * `tool/call` 可能比审批晚到。
 *
 * 风险用**未裁剪**的原文算（裁剪只影响展示）：一条 `rm -rf` 在第 5 行也还是删除。
 */
export const approvalInsightOf = (
  items: readonly ChatItem[],
  approval: { toolName: string; toolKey?: string; callId?: string; reason?: string },
): { target?: ApprovalTarget; risk: ApprovalRisk } => {
  const tool = toolForCall(items, approval.callId)
  const raw = tool === undefined ? undefined : rawTargetOf(tool)
  if (raw !== undefined) {
    return {
      target: trimApprovalTarget(raw.raw, raw.kind),
      risk: classifyApprovalRisk({
        toolName: tool?.toolName ?? approval.toolName,
        ...(shouldPassToolKey(tool ?? approval)),
        target: raw.raw,
        ...(approval.reason === undefined ? {} : { reason: approval.reason }),
      }),
    }
  }
  if (approval.reason !== undefined && approval.reason.trim().length > 0) {
    return {
      target: trimApprovalTarget(approval.reason, classifyTargetText(approval.reason)),
      risk: classifyApprovalRisk({
        toolName: approval.toolName,
        ...(shouldPassToolKey(approval)),
        target: approval.reason,
      }),
    }
  }
  return {
    risk: classifyApprovalRisk({ toolName: approval.toolName, ...(shouldPassToolKey(approval)) }),
  }
}

/** `toolKey` 只在有值时才往参数里塞（`exactOptionalPropertyTypes` 下不接受显式 `undefined`）。 */
const shouldPassToolKey = (input: { toolKey?: string }): { toolKey?: string } =>
  input.toolKey === undefined ? {} : { toolKey: input.toolKey }

/* ──────────────────────────── 四、审批：风险分类 ──────────────────────────── */

/**
 * 风险档位。语气与按钮颜色按它分：
 *   `read`   只读，不会改任何东西（不二次确认）；
 *   `write`  会写文件 / 初始化仓库 / 装包（二次确认）；
 *   `delete` 可能删数据且不可撤销（二次确认 + 错误色）；
 *   `network` 会把请求发到外网（二次确认）；
 *   `unknown` 看不出在干什么（二次确认，说不清就不放行）。
 */
export type ApprovalRisk = 'read' | 'write' | 'delete' | 'network' | 'unknown'

/** 删除类：`rm`（带不带 -rf 都算）、`rmdir`、Windows 的 `del` / `Remove-Item`、清库、清工作区。 */
const DELETE_RE = [
  /\brm\s+-[a-z]*[rf]/iu,
  /\brm\s+\S/u,
  /\brmdir\b/iu,
  /\b(?:del|erase)\s+/iu,
  /\bRemove-Item\b/iu,
  /\bgit\s+clean\b/iu,
  /\bgit\s+reset\s+--hard\b/iu,
  /\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b/iu,
  /\btruncate\b/iu,
  /\bshred\b/iu,
] as const

/** 写入类：重定向、`tee`、文件操作、移动、权限、装包、跑项目脚本、把改动落到仓库。 */
const WRITE_RE = [
  /(?:^|\s)>{1,2}\s*\S/u,
  /\btee\b/iu,
  /\b(?:mv|cp|mkdir|touch|chmod|chown|ln|install)\b/iu,
  /\bsed\s+-i\b/iu,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|get)\b/iu,
  /\b(?:pip|pip3|apt|apt-get|brew|gem)\s+(?:i|install|add)\b/iu,
  // `npm run build` / `pnpm test` 会跑项目自己的脚本（通常写产物），不能当只读
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|test|lint|format|type|start|dev|pack)\b/iu,
  /\b(?:make|cargo|gradle|mvn|dotnet|go)\s+(?:build|test|run|install|publish|pack)\b/iu,
  /\bgit\s+(?:add|commit|push|merge|rebase|checkout|switch|stash|tag|remote\s+add)\b/iu,
  /\bapply_patch\b/iu,
] as const

/** 外网类：抓取、远程登录、克隆、DNS 探测。 */
const NETWORK_RE = [
  /\b(?:curl|wget|nc|telnet|ftp|scp|rsync|ssh)\b/iu,
  /\bgit\s+clone\b/iu,
  /\b(?:ping|nslookup|dig|tracert|traceroute)\b/iu,
  URL_RE,
] as const

/** 明确只读的命令（第一条词命中才算）：列目录、看文件、查状态、跑只读的测试/查询。 */
const READ_ONLY_COMMAND_RE =
  /^\s*(?:ls|ll|dir|cat|head|tail|type|less|more|wc|file|stat|du|df|pwd|whoami|date|which|where|echo|env|printenv|grep|rg|find|findstr|git\s+(?:status|diff|log|show|branch|remote|rev-parse)|node\s+-v|npm\s+(?:ls|view|outdated)|pnpm\s+(?:ls|why)|python\s+-V|tsc\s+--noEmit)\b/iu

/** 先删、再写、再外网、再只读 —— 严重度从高到低，先命中的就是这一条的档位。 */
export const classifyApprovalRisk = (input: {
  toolName: string
  toolKey?: string
  /** 「要做什么」的原文（命令 / 路径 / URL），未裁剪 */
  target?: string
  reason?: string
}): ApprovalRisk => {
  const kind = toolKindOf(input.toolKey ?? input.toolName, undefined)
  const text = [input.target ?? '', input.reason ?? ''].join('\n')
  const firstLine = oneLine(input.target ?? input.reason ?? '')

  if (DELETE_RE.some((pattern) => pattern.test(text))) return 'delete'
  // 写文件 / 编辑文件类工具本身就是写入，不用看参数
  if (kind === 'write' || kind === 'edit') return 'write'
  // 联网工具（web_search / web_fetch）是外网访问；除非上面已经判成删除/写入
  if (WRITE_RE.some((pattern) => pattern.test(text))) return 'write'
  if (kind === 'web' || URL_RE.test(firstLine)) return 'network'
  if (NETWORK_RE.some((pattern) => pattern.test(text))) return 'network'
  if (kind === 'read' || kind === 'readImage' || kind === 'search') return 'read'
  if (kind === 'shell' || kind === 'other') {
    if (READ_ONLY_COMMAND_RE.test(firstLine)) return 'read'
    return 'unknown'
  }
  // task / agent：不直接动文件系统，但会牵出别的动作 —— 按「说不清」处理，二次确认不亏
  return 'unknown'
}

/** 二次确认：只读的一次点完，其余都要「先点一次变成『确认允许』再点」。 */
export const approvalNeedsConfirm = (risk: ApprovalRisk): boolean => risk !== 'read'

/** 允许按钮用错误色的档位（删除一定用；写/外网在「确认」那一下用）。 */
export const approvalAllowIsDanger = (risk: ApprovalRisk): boolean =>
  risk === 'delete' || risk === 'write' || risk === 'network' || risk === 'unknown'

/* ──────────────────────────── 五、提问：字数与校验 ──────────────────────────── */

/** 自由输入上限。够写一两段说明，又不至于把 `answer` 撑成小作文。 */
export const MAX_ANSWER_CHARS = 500

export const clampAnswerText = (text: string): string =>
  text.length <= MAX_ANSWER_CHARS ? text : text.slice(0, MAX_ANSWER_CHARS)

export interface QuestionFormStatus {
  /** 每条问题都给了选择或文本（与 `allQuestionsAnswered` 同一判据） */
  ready: boolean
  /** 还没答的问题数 */
  missing: number
  /** 有输入超长（正常路径不会出现，`clampAnswerText` 已经挡在输入层） */
  overLimit: boolean
}

/** 提交校验：逐条看「有选择或有非空文本」，并复查字数。 */
export const questionFormStatus = (
  questions: readonly { id: string }[],
  selected: Readonly<Record<string, readonly string[] | undefined>>,
  custom: Readonly<Record<string, string | undefined>>,
): QuestionFormStatus => {
  let missing = 0
  let overLimit = false
  for (const question of questions) {
    const picks = (selected[question.id] ?? []).filter((item) => item.length > 0)
    const text = (custom[question.id] ?? '').trim()
    if (text.length > MAX_ANSWER_CHARS) overLimit = true
    if (picks.length === 0 && text.length === 0) missing += 1
  }
  return { ready: missing === 0 && !overLimit, missing, overLimit }
}

/* ────────────────────── 六、提问：卡片状态（含无句柄的落伍卡片） ────────────────────── */

/**
 * 卡片展示状态。与 store 的 `QuestionPhase` 一一对应，另外多一个 `stale`：
 * 时间线里有这条提问、但 store 里已经没有它的运行时状态（进程重启 / 历史回填），
 * 也就是**没有可应答的句柄**，只能显示「已失效」。
 */
export type QuestionCardStatus =
  | 'claiming'
  | 'open'
  | 'expired'
  | 'continued'
  | 'answered'
  | 'queued'
  | 'cancelled'
  | 'stale'

export const questionCardStatus = (input: {
  /** store 里的阶段（拿不到说明这条没有运行时状态） */
  phase?: string
  /** 本地倒计时已到 0（窗口结束） */
  windowClosed: boolean
  /** reducer 落在时间线上的终态 */
  outcome?: 'answered' | 'queued' | 'cancelled'
}): QuestionCardStatus => {
  if (input.phase === 'claiming') return 'claiming'
  if (input.phase === 'answered' || input.phase === 'queued' || input.phase === 'cancelled') {
    return input.phase
  }
  if (input.outcome === 'answered' || input.outcome === 'queued' || input.outcome === 'cancelled') {
    return input.outcome
  }
  // `continued` 在本地窗口结束**之后**仍然可以补答（Host 投影推进过），所以它比 windowClosed 优先
  if (input.phase === 'continued') return 'continued'
  if (input.phase === 'expired') return 'expired'
  if (input.windowClosed) return 'expired'
  if (input.phase === 'open') return 'open'
  // 有卡片、没状态：句柄已经没了（断线后未被重投 / 历史回填），不能装作还能答
  return 'stale'
}

/** 终态：不再接受输入（但卡片保留，把「答了什么」展示出来）。 */
export const isQuestionCardTerminal = (status: QuestionCardStatus): boolean =>
  status === 'answered' || status === 'queued' || status === 'cancelled' || status === 'expired' || status === 'stale'

/** 「已失效」这一类（红色 / 灰色提示，与「已回答」区分开）。 */
export const isQuestionCardDead = (status: QuestionCardStatus): boolean =>
  status === 'cancelled' || status === 'expired' || status === 'stale'

/* ──────────────── 七、会话列表红点：按 eventId 去重的按会话计数 ──────────────── */

export type PendingKind = 'approval' | 'question'

/** 未处理交互的原始记账：`sessionId → { approval: [eventId…], question: [eventId…] }`。 */
export interface PendingInteractionSets {
  [sessionId: string]: { approval: string[]; question: string[] }
}

export interface PendingInteractionCount {
  approval: number
  question: number
}

/**
 * 记一条待处理交互。**按 eventId 去重**：Host 断线重连会重投同一条 waterfall
 * （协议 §2.6「重连时 Host 会用同一 eventId 重投 pending waterfall」），
 * 同一个 eventId 记两次就会让红点数字翻倍。
 *
 * 返回**新对象**；没有变化时返回原对象（zustand 靠引用相等跳过重渲染）。
 */
export const trackPendingInteraction = (
  sets: PendingInteractionSets,
  input: { sessionId: string; kind: PendingKind; eventId: string },
): PendingInteractionSets => {
  const { sessionId, kind, eventId } = input
  if (sessionId.length === 0 || eventId.length === 0) return sets
  const current = sets[sessionId] ?? { approval: [], question: [] }
  if (current[kind].includes(eventId)) return sets
  const nextBucket = { ...current, [kind]: [...current[kind], eventId] }
  return { ...sets, [sessionId]: nextBucket }
}

/**
 * 销掉一条待处理交互。三种入口都走这里：
 *   - 按 `eventId`（`{type:'cancel', eventId}` / 自己应答完）；
 *   - 按会话 + 种类（进入会话即清零、Host 说这一轮不跑了）；
 *   - 按会话（会话从列表里消失）。
 */
export const settlePendingInteraction = (
  sets: PendingInteractionSets,
  match: { eventId?: string; sessionId?: string; kind?: PendingKind },
): PendingInteractionSets => {
  let next = sets
  for (const [sessionId, bucket] of Object.entries(sets)) {
    if (match.sessionId !== undefined && sessionId !== match.sessionId) continue
    const kinds: PendingKind[] = match.kind === undefined ? ['approval', 'question'] : [match.kind]
    let approval = bucket.approval
    let question = bucket.question
    if (kinds.includes('approval')) {
      approval = match.eventId === undefined
        ? []
        : bucket.approval.filter((id) => id !== match.eventId)
    }
    if (kinds.includes('question')) {
      question = match.eventId === undefined
        ? []
        : bucket.question.filter((id) => id !== match.eventId)
    }
    if (approval === bucket.approval && question === bucket.question) continue
    if (next === sets) next = { ...sets }
    if (approval.length === 0 && question.length === 0) delete next[sessionId]
    else next[sessionId] = { approval, question }
  }
  return next
}

/**
 * 折算成 UI 用的计数。
 *
 * 规则一：**活动会话不计**——用户已经在里面了，卡片就在眼前，红点没有意义，
 * 也正好实现「进入会话即清零，且不会立刻亮回来」。
 * 规则二：只有还有 eventId 的会话才出现（销干净就消失）。
 */
export const pendingInteractionCounts = (
  sets: PendingInteractionSets,
  activeSessionId: string | null,
): Record<string, PendingInteractionCount> => {
  const counts: Record<string, PendingInteractionCount> = {}
  for (const [sessionId, bucket] of Object.entries(sets)) {
    if (sessionId === activeSessionId) continue
    const approval = bucket.approval.length
    const question = bucket.question.length
    if (approval === 0 && question === 0) continue
    counts[sessionId] = { approval, question }
  }
  return counts
}

export const pendingTotal = (count: PendingInteractionCount | undefined): number =>
  count === undefined ? 0 : count.approval + count.question

/** 红点数字：超过 9 就是 `9+`（再大也没有信息量，只有宽度）。 */
export const pendingBadgeText = (count: number): string => (count > 9 ? '9+' : String(count))
