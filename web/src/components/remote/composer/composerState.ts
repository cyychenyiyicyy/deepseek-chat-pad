/**
 * 输入区（composer）的**纯状态机**：一个「现在这个按钮该长什么样、回车会发生什么」的判定。
 *
 * 为什么单独抽出来：这一批的需求全是「状态之间的切换」
 * （空闲 ↔ 工作中、发送 ↔ 停止、插话 ↔ 排队、停止超时回退），
 * 写在 `RemoteChatView` 里就只能靠读 JSX 猜；抽成纯函数后
 * `__selftest__/composer.selftest.mts` 可以直接把每种组合摆一遍。
 *
 * 四条硬规则（来自用户真机反馈 + R1 调研结论，动之前先看这里）：
 *
 *  1. **工作中同一个位置必须变「停止」** —— 主按钮只看 `streaming`，不看草稿有没有内容
 *     （`primary` 的判定顺序：`stopTimedOut ? 回到发送 : streaming ? 'stop' : knownCommand ? 'command' : 'send'`）。
 *  2. **工作中照样能发** —— 默认 `mode:'steer'`（插话，与 dsh-Go 一致），
 *     切到「排队」就是 `mode:'queue'`。两条都走 `session/prompt` 的同一个端点，
 *     不另开接口（R1 §「运行中发送走 prompt 的 mode」）。因为主按钮被停止占了，
 *     运行中另给一个**次要发送键 + 插话/排队切换**。
 *  3. **停止要有超时出口** —— `session/cancel` 10 秒没有回执就把按钮还原成发送，
 *     否则用户会以为整页卡死（照 dsh-Go 的 10s 行为）。
 *  4. **排队条只表示「还在等」** —— `queueLength > 0` 也算「工作中」：
 *     `store.ts` 的 `sendFlow` 在发送失败时会把 `streaming` 置回 false（它自己的乐观值），
 *     但队列里还有条目，界面不该退回「空闲」形态。
 *
 * 这里不 import 任何运行时模块：`TranslationKey` 只是类型（`import type` 会被擦掉），
 * 所以自测可以在 node 里直接跑，不必拉起 i18n / settings。
 */

import type { TranslationKey } from '../../../i18n/index.js'

/** `session/prompt` 的 `mode`：`steer` = 插话（打断当前回答），`queue` = 排到下一轮 */
export type PromptMode = 'steer' | 'queue'

/** 主按钮（输入区右下角那个圆钮）的形态 */
export type ComposerPrimary = 'send' | 'stop' | 'command'

/** 回车 / 点发送时**真正要做**的事 */
export type ComposerIntent = 'send' | 'steer' | 'queue' | 'command' | 'none'

export interface ComposerSignals {
  /** 数据面是否 ready（`phase === 'ready'`） */
  ready: boolean
  /** 当前会话；`null` 时不能发 */
  sessionId: string | null
  /** `store.streaming`：这一轮正在生成 */
  streaming: boolean
  /** 运行中发送用的 mode（用户选的；默认 `'steer'`） */
  sendMode: PromptMode
  /** 停止请求 10s 超时：主按钮从停止还原成发送（否则用户以为卡死） */
  stopTimedOut: boolean
  /** Host 的 inbox 投影条数（`session/control` 的 `inbox['next-turn']`） */
  queueLength: number
  /** 输入框草稿 */
  draft: string
  /** 已经拿到收据、可以随消息发出去的附件数 */
  attachments: number
  /** 还有附件在上传（收据没到手，这时不能发） */
  attachmentsBusy: boolean
  /** 草稿整行是一条已知斜杠命令（`sessionControls.isKnownCommand`） */
  knownCommand: boolean
  /** 草稿正在打斜杠命令（只影响提示文案） */
  slashTyping: boolean
}

export interface ComposerView {
  /** 「正在工作」：生成中，或队列里还有待发消息 */
  busy: boolean
  primary: ComposerPrimary
  /** 主按钮是否可点（停止永远可点：Host 空闲时 `session/cancel` 也回 accepted） */
  primaryEnabled: boolean
  /** 生成中另给的次要发送键（主位被停止占着） */
  secondarySendVisible: boolean
  secondarySendEnabled: boolean
  /** 生成中才出现的「插话 / 排队」切换 */
  modeToggleVisible: boolean
  hintKey: TranslationKey
  hintParams?: Record<string, number>
}

/** 有没有可发的内容（纯文本或已完成上传的附件） */
export const hasDraftContent = (draft: string, attachments: number): boolean =>
  draft.trim().length > 0 || attachments > 0

/** 能不能发：连接 ready + 选中会话 + 有内容 + 附件都传完了 */
export const canSubmit = (signals: ComposerSignals): boolean =>
  signals.ready &&
  signals.sessionId !== null &&
  !signals.attachmentsBusy &&
  hasDraftContent(signals.draft, signals.attachments)

/**
 * 回车 / 点发送该干什么（`none` = 什么都不做）。
 *
 * 「运行中」只有两种合法动作：`steer`（插话）与 `queue`（排队）——
 * 都是 `session/prompt` 的 `mode`，客户端不需要别的接口。
 */
export const composerIntent = (signals: ComposerSignals): ComposerIntent => {
  if (signals.knownCommand) {
    // 命令不排队也不插话：生成中执行 `/compact` 这类命令会被 Host 拒掉，干脆别发
    if (signals.streaming) return 'none'
    if (!signals.ready || signals.sessionId === null || signals.draft.trim().length === 0) return 'none'
    return 'command'
  }
  if (!canSubmit(signals)) return 'none'
  if (signals.streaming) return signals.sendMode === 'steer' ? 'steer' : 'queue'
  return 'send'
}

export const composerView = (signals: ComposerSignals): ComposerView => {
  const content = canSubmit(signals)
  const busy = signals.streaming || signals.queueLength > 0
  // 停止超时：把主按钮还给发送，用户不会卡在一个点了没反应的停止键上
  const showStop = signals.streaming && !signals.stopTimedOut
  const primary: ComposerPrimary = showStop
    ? 'stop'
    : signals.knownCommand
      ? 'command'
      : 'send'
  const primaryEnabled = showStop
    ? true
    : signals.knownCommand
      ? signals.ready && signals.sessionId !== null && signals.draft.trim().length > 0
      : content
  // 生成中：主位是停止，所以另给一个发送键 + 插话/排队切换（命令例外）
  const secondarySendVisible = signals.streaming && !signals.knownCommand
  const hint = composerHint(signals)
  return {
    busy,
    primary,
    primaryEnabled,
    secondarySendVisible,
    secondarySendEnabled: secondarySendVisible && content,
    modeToggleVisible: secondarySendVisible,
    hintKey: hint.key,
    ...(hint.params === undefined ? {} : { hintParams: hint.params }),
  }
}

/** 输入区下沿那行小字：它同时承担「刚才发生了什么」的说明 */
export const composerHint = (
  signals: ComposerSignals,
): { key: TranslationKey; params?: Record<string, number> } => {
  // 停止超时是最高优先级：用户点的最后一个东西没反应，必须先解释
  if (signals.streaming && signals.stopTimedOut) return { key: 'composerHintStopTimeout' }
  if (signals.streaming) {
    if (signals.queueLength > 0) {
      return { key: 'composerHintQueued', params: { count: signals.queueLength } }
    }
    return { key: signals.sendMode === 'steer' ? 'composerHintBusySteer' : 'composerHintBusy' }
  }
  if (signals.slashTyping) return { key: 'chatControlsSlashTyping' }
  return { key: 'remoteInputHint' }
}

/* ── 排队区（QueueDock）的行状态 ──────────────────────────────────────── */

export interface QueueRowState {
  /** 正在处理这一条（steer / remove 的请求还没回） */
  busy: boolean
  /** 这一行能不能点（有一条在飞时全部禁用，避免 Host 侧顺序抖动） */
  enabled: boolean
  /** 有没有 Host 的条目 id：没有就只显示预览，不给按钮 */
  actionable: boolean
}

export const queueRowState = (
  item: { id?: string },
  busyId: string | null,
): QueueRowState => ({
  busy: item.id !== undefined && busyId === item.id,
  enabled: item.id !== undefined && busyId === null,
  actionable: item.id !== undefined,
})

/** 排队行的一行预览：折叠空白、超长截断；空正文（图片 / 附件消息）给占位文案 */
export const queuePreviewText = (
  preview: string,
  placeholder: string,
  limit = 96,
): string => {
  const oneLine = preview.replace(/\s+/g, ' ').trim()
  if (oneLine.length === 0) return placeholder
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine
}
