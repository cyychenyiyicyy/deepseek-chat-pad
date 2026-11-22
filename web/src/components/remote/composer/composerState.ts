/**
 * 输入区（composer）的**纯状态机**：一个「现在这个按钮该长什么样、回车会发生什么」的判定。
 *
 * 为什么单独抽出来：这一批的需求全是「状态之间的切换」
 * （空闲 ↔ 工作中、发送 ↔ 停止、插话 ↔ 排队、停止超时回退），
 * 写在 `RemoteChatView` 里就只能靠读 JSX 猜；抽成纯函数后
 * `__selftest__/composer.selftest.mts` 可以直接把每种组合摆一遍。
 *
 * 四条硬规则（来自用户真机反馈 + R1 调研结论 + S3 复核，动之前先看这里）：
 *
 *  1. **在跑时主按钮看输入框**（S3 改的就是这一条）—— 空输入是「停止」、有内容
 *     「发送」；不在跑永远是发送。裁决只有一处：`resolveComposerView()`。
 *  2. **在跑时照样能发** —— 默认 `mode:'steer'`（插话，与 dsh-Go 一致），
 *     切到「排队」就是 `mode:'queue'`。两条都走 `session/prompt` 的同一个端点，
 *     不另开接口（R1 §「运行中发送走 prompt 的 mode」）。主位被停止占着时，
 *     发送是第二颗钮；主位是发送时，第二颗钮换成停止。
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

/** 主位之外的第二颗钮（运行中才有）：主位是停止时给「照样能发」，主位是发送时给「照样能停」 */
export type ComposerSecondary = 'send' | 'stop'

/** 回车 / 点发送时**真正要做**的事 */
export type ComposerIntent = 'send' | 'steer' | 'queue' | 'command' | 'none'

export interface ComposerSignals {
  /** 数据面是否 ready（`phase === 'ready'`） */
  ready: boolean
  /** 当前会话；`null` 时不能发（`newChat` 除外 —— 那一发就是「建会话 + 发消息」） */
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
  /**
   * [R15] 新对话页（dsh-Go 的 `sessionId == null` 空态）：这一条输入不是发进现有会话，
   * 而是「建会话 → 应用选项 → 把消息发出去」。此时 `sessionId` 传 `null`，
   * `canSubmit` 单独放行。默认 false，旧调用与自测不用改。
   */
  newChat?: boolean
  /** [R15] 新对话正在创建（`newSessionStore.creating`）：主按钮先灰住，防连点 */
  creating?: boolean
}

export interface ComposerView {
  /** 「正在工作」：生成中，或队列里还有待发消息 */
  busy: boolean
  /** 这次裁决用的「在跑」值（= `streaming`，或全局运行态校正后的值） */
  running: boolean
  primary: ComposerPrimary
  /** 主按钮是否可点（停止永远可点：Host 空闲时 `session/cancel` 也回 accepted） */
  primaryEnabled: boolean
  /** 主位之外的第二颗钮；`null` = 不渲染 */
  secondaryAction: ComposerSecondary | null
  /** 第二颗钮是否可点 */
  secondaryEnabled: boolean
  /** 运行中才出现的「插话 / 排队」切换 */
  modeToggleVisible: boolean
  hintKey: TranslationKey
  hintParams?: Record<string, number>
  /**
   * 这次裁决吃进去的原始信号。
   *
   * 为什么放在 view 里：`ComposerRow` 只拿到 view（截图脚本也直接喂假 view），
   * 而它还要用**全局运行态**再裁一次（`composerLiveView`）—— 没有原始信号就重算不了。
   * UI 一律读上面那些结论字段，**不要**自己拿 signals 判规则。
   */
  signals: ComposerSignals
}

/** 有没有可发的内容（纯文本或已完成上传的附件） */
export const hasDraftContent = (draft: string, attachments: number): boolean =>
  draft.trim().length > 0 || attachments > 0

/**
 * 能不能发：连接 ready + 有会话（或新对话页）+ 有内容 + 附件都传完了。
 *
 * [R15] `newChat` 那一支是「发送 = 建会话 + 发消息」，不要求已有会话；
 * 创建中（`creating`）先灰住，防止连点出两个会话。
 */
export const canSubmit = (signals: ComposerSignals): boolean =>
  signals.ready &&
  (signals.newChat === true || signals.sessionId !== null) &&
  !(signals.newChat === true && signals.creating === true) &&
  !signals.attachmentsBusy &&
  hasDraftContent(signals.draft, signals.attachments)

/**
 * 回车 / 点发送该干什么（`none` = 什么都不做）。
 *
 * 「运行中」只有两种合法动作：`steer`（插话）与 `queue`（排队）——
 * 都是 `session/prompt` 的 `mode`，客户端不需要别的接口。
 * 新对话页永远是 `send`（那里没有流也没有命令 —— 命令需要会话才存在）。
 */
export const composerIntent = (signals: ComposerSignals): ComposerIntent => {
  if (signals.newChat === true) {
    if (!canSubmit(signals)) return 'none'
    return 'send'
  }
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

export const composerView = (signals: ComposerSignals): ComposerView =>
  resolveComposerView(signals, signals.streaming)

/**
 * 用**全局运行态**再裁一次（`ComposerRow` 里调）。
 *
 * 为什么需要它：`signals.streaming` 由当前会话的 `session/follow` 增量推导，
 * 而「用户带着一个已经在跑的会话进 App」时 `turn/start` 早过去了 —— 只看它，
 * 按钮就永远停在发送（用户反馈的第二条）。`liveSessions.ts` 把 `session/list` 的
 * `running` 与 `$events` 的 `api-session/*` 汇总成全局运行态，这里把它并进来：
 * **任一边说在跑就算在跑**（宁可多给一个停止键，也不能让人以为它没在干活）。
 *
 * 纯函数：同样的 (view, running) 一定得到同样的结果，`running` 没变时直接返回原对象
 * （列表/输入区每帧都会调它，不能白白造新对象）。
 */
export const composerLiveView = (view: ComposerView, running: boolean): ComposerView =>
  view.running === running ? view : resolveComposerView(view.signals, running)

/**
 * 按钮规则的唯一裁决处（其它地方**不要**再写一遍 if）。
 *
 * 规则（S3 用户明确要求，覆盖 R4 原来那条「工作中主位永远是停止」）：
 *   1. 在跑 + **输入框为空** → 主位是**停止**（这是「它正在干活」的信号）；
 *   2. 在跑 + **输入框有内容** → 主位是**发送**（走 steer / queue），停止改由第二颗钮承担；
 *   3. 不在跑 → 主位永远是发送；
 *   4. 斜杠命令不算「可发内容」：在跑时它发不出去（Host 会拒），所以主位仍是停止。
 *
 * 第 2 条为什么是「发送」而不是「停止」：用户的话是「我打完字了，就是想发出去」——
 * 打了一半的字被一个停止键占着主位，等于每次插话都要多按一次。停止放在第二颗钮上，
 * 位置固定、图标是 ■，不会找不到。
 */
const resolveComposerView = (signals: ComposerSignals, running: boolean): ComposerView => {
  const content = canSubmit(signals)
  const hasContent = hasDraftContent(signals.draft, signals.attachments)
  // 停止 10s 没回执就把主位还给发送：不让用户对着一个点了没反应的键
  const stopWins = running && !signals.stopTimedOut && (!hasContent || signals.knownCommand)
  const commandMode = signals.knownCommand && !running
  const primary: ComposerPrimary = stopWins ? 'stop' : commandMode ? 'command' : 'send'
  const primaryEnabled = stopWins
    ? true
    : commandMode
      ? signals.ready && signals.sessionId !== null && signals.draft.trim().length > 0
      : content
  // 第二颗钮：主位被停止占着时给发送；主位是发送时把停止放这里（运行中总得能停）
  const secondaryAction: ComposerSecondary | null =
    running && !signals.knownCommand ? (stopWins ? 'send' : 'stop') : null
  const hint = composerHint(signals)
  return {
    busy: running || signals.queueLength > 0,
    running,
    primary,
    primaryEnabled,
    secondaryAction,
    // 「照样能发」要真的有内容；「照样能停」永远可点
    secondaryEnabled: secondaryAction === 'stop' ? true : content,
    modeToggleVisible: running && !signals.knownCommand,
    hintKey: hint.key,
    ...(hint.params === undefined ? {} : { hintParams: hint.params }),
    signals,
  }
}

/** 输入区下沿那行小字：它同时承担「刚才发生了什么」的说明 */
export const composerHint = (
  signals: ComposerSignals,
): { key: TranslationKey; params?: Record<string, number> } => {
  // [R15] 新对话页的提示先说清「发出即创建」，创建中就说「正在创建」
  if (signals.newChat === true) {
    if (signals.creating === true) return { key: 'newSessionCreating' }
    return { key: 'newSessionComposerHint' }
  }
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
