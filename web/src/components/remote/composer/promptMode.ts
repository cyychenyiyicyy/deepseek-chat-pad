/**
 * 运行中发送的 `mode`（steer / queue）—— 与数据层之间的**唯一接缝**。
 *
 * R1 调研结论（`input-R1-作曲器与通知调研.md`）：运行中发消息不另开接口，
 * 就是 `session/prompt` 的 `mode`：
 *
 * ```
 * session/prompt { request: { requestId, sessionId, mode: 'steer' | 'queue', content } }
 * ```
 *
 *  - `steer` = 插话：打断当前回答、把这句话塞进去（dsh-Go 默认）；
 *  - `queue` = 排队：等这一轮结束再发（RN 默认）。
 *
 * ## 为什么这里是「能力探测」而不是直接调用
 *
 * `services/remote/store.ts` 的发送入口目前是 `send(text: string)`，
 * `sendFlow` 调 `sessionsApi.sendPrompt(..., { requestId })`，`mode` 落在默认值 `'queue'`；
 * 而 `store.ts` / `sessionsApi.ts` / `sessionControls.ts` 都**不在本任务的改动范围**里，
 * `active`（含 `link`）又是 `store.ts` 的模块私有变量、没有导出 target getter，
 * 所以本文件没有第二条路去自己发一条 steer 的 `session/prompt`。
 *
 * 于是按 `plan` 的分工约定做成**前向兼容**：
 *  - 数据层补上 `sendWithMode(text, mode)`（或让 `send` 接受 `{mode}` 第二参数）后，
 *    这里自动走 steer，**本文件与界面都不用再改**；
 *  - 没补之前退回 `send()`（= Host 的 queue 语义），并把「实际用的是 queue」回给界面，
 *    界面据此把「插话」标成降级态（不谎报）。
 *
 * 报告 `input-R4-输入区改造.md` 里写了给数据层的最小补丁。
 */

import type { PromptMode } from './composerState.js'

/** 数据层可能提供的、带 mode 的发送入口（还没有就当作 undefined） */
interface ModeAwareSender {
  send(text: string): unknown
  sendWithMode?: (text: string, mode: PromptMode) => unknown
}

/** 这个 sender 能不能指定 mode（`false` = 只能走 Host 默认的 queue） */
export const supportsPromptMode = (sender: unknown): boolean =>
  typeof (sender as ModeAwareSender | null)?.sendWithMode === 'function'

/**
 * 发一条**纯文本**消息，返回实际采用的 mode。
 *
 * - 返回 `'steer'`：真的以 steer 发出去了；
 * - 返回 `'queue'`：以 queue 发出去了（用户选的 / 或 steer 不受支持时的降级）；
 * - 返回 `null`：sender 形状不认识（没发出去，调用方不该清空草稿）。
 *
 * 带附件的发送（`sendRemoteMessage`）没有 mode 参数，那边一律走 queue ——
 * 数据层补上 `sendWithMode` 之后可以把附件块一起塞进同一个 `content`。
 */
export const dispatchPrompt = (sender: unknown, text: string, mode: PromptMode): PromptMode | null => {
  const target = sender as ModeAwareSender | null
  if (target === null || typeof target !== 'object' || typeof target.send !== 'function') return null
  if (mode === 'steer' && typeof target.sendWithMode === 'function') {
    void target.sendWithMode(text, 'steer')
    return 'steer'
  }
  void target.send(text)
  return 'queue'
}
