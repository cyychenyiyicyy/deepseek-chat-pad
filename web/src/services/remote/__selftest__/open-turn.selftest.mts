/**
 * [R18] 「远程模式点会话没反应、右侧一直停在『选择一个会话』」真根因自测。
 *
 * 跑法（workdir = projects\deepseek-tablet\web）：
 *   npx tsx src/services/remote/__selftest__/open-turn.selftest.mts
 *
 * 病症（v1.13.0 ~ v1.14.1，三次修复都没治到）：
 *   `openSessionFlow(id)` 在做「让位检查」时用的是 `flowIsCurrent(session, ticket)`，
 *   它内部的 `followEpochIsCurrent()` 要求 `ticket.sessionId === session.sessionId`。
 *   可此刻 `session.sessionId` 还停在**旧值**（刚连上是 `null`，否则是上一个会话），
 *   工牌里是**目标** id —— 必然不等 → 每一次点会话都被当成「上一代的迟到流程」静默
 *   `return`。界面因此永远停在空态；只有「重开当前那个会话」能过（两边恰好相等）。
 *
 * 覆盖：
 *   A1 空态第一次打开会话（sessionId=null → 目标）→ 判定必须是 true（旧实现在这里是 false）
 *   A2 从 A 切到 B → true
 *   A3 重开当前会话 → true
 *   A4 连点 A→B：A 的流程迟到恢复 → 必须 false（否则串台，这是代际存在的理由）
 *   A5 `followEpochIsCurrent()` 在 A1/A2 上确实是 false —— 钉住「不能拿它做开门判定」
 *   A6 源码守卫：`openSessionFlow()` 的开门检查用的是 `followEpochTurnIsCurrent`，
 *      不再是裸的 `flowIsCurrent`（防回归：本次教训就是自测绕过了真实路径）
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  followEpochIsCurrent,
  followEpochTurnIsCurrent,
  newFollowEpoch,
  type FollowEpochTicket,
} from '../routing.js'

/* ── 最小断言器（与其它 selftest 同一套写法） ─────────────────────────── */

const checks: Array<{ name: string; run: () => Promise<void> }> = []
const check = (name: string, run: () => Promise<void>): void => {
  checks.push({ name, run })
}

const fail = (message: string): never => {
  throw new Error(message)
}

const assertTrue = (value: boolean, label: string): void => {
  if (!value) fail(label)
}

const assertFalse = (value: boolean, label: string): void => {
  if (value) fail(label)
}

/* ── 复刻 store.ts 的两件小事 ─────────────────────────────────────────── */

/** store.ts 的 `newFlowTicket()`：领工牌并推进模块级 epoch */
let sessionEpoch = 0
const newFlowTicket = (sessionId: string): FollowEpochTicket => {
  const ticket = newFollowEpoch(sessionId, sessionEpoch)
  sessionEpoch = ticket.epoch
  return ticket
}

/** store.ts 的 `epochCursor()`：sessionId 取「当下活动的会话」（切换前还是旧值） */
const epochCursor = (currentSessionId: string | null): { sessionId: string | null; epoch: number } => ({
  sessionId: currentSessionId,
  epoch: sessionEpoch,
})

/* ══════════════════════════════════════════════════════════════════════
 * A. 开门（openSessionFlow）的让位判定
 * ══════════════════════════════════════════════════════════════════════ */

check('A1 空态第一次打开会话：判定为「我这一代是最新的」', async () => {
  sessionEpoch = 0
  // 现场：刚连上，sessionId 还是 null；用户点了 sess-A
  const ticket = newFlowTicket('sess-A')
  assertTrue(
    followEpochTurnIsCurrent(ticket, sessionEpoch),
    '从空态打开会话必须放行 —— 旧实现在这里判 false，真机就是「点了没反应」',
  )
})

check('A2 从 A 切到 B：判定为 true', async () => {
  sessionEpoch = 0
  newFlowTicket('sess-A') // A 这一代已经落地（epoch 停在 A）
  const ticketB = newFlowTicket('sess-B')
  assertTrue(followEpochTurnIsCurrent(ticketB, sessionEpoch), '切到另一个会话必须放行')
})

check('A3 重开当前会话：判定为 true', async () => {
  sessionEpoch = 0
  newFlowTicket('sess-A')
  const again = newFlowTicket('sess-A')
  assertTrue(followEpochTurnIsCurrent(again, sessionEpoch), '重开当前会话要放行（刷新快照）')
})

check('A4 连点 A→B：A 的流程迟到恢复必须作废（代际仍生效）', async () => {
  sessionEpoch = 0
  const ticketA = newFlowTicket('sess-A')
  const ticketB = newFlowTicket('sess-B')
  // B 已经落地，epoch 停在 B 那一代
  assertFalse(followEpochTurnIsCurrent(ticketA, sessionEpoch), 'A 的迟到流程不能继续（否则会把会话抢回 A）')
  assertTrue(followEpochTurnIsCurrent(ticketB, sessionEpoch), 'B 的流程照常推进')
})

check('A5 `followEpochIsCurrent` 在 A1/A2 上就是 false —— 这正是 bug 的来源', async () => {
  sessionEpoch = 0
  // 空态 → sess-A：cursor 里 sessionId 还是 null
  const first = newFlowTicket('sess-A')
  assertFalse(
    followEpochIsCurrent(first, epochCursor(null)),
    '旧实现（比 sessionId）在空态打开会话时判 false —— 真机症状的数学解释',
  )
  // A → B：cursor 里 sessionId 还是 sess-A
  const second = newFlowTicket('sess-B')
  assertFalse(
    followEpochIsCurrent(second, epochCursor('sess-A')),
    '旧实现（比 sessionId）在切会话时判 false',
  )
  // 只有「重开当前会话」两边才恰好相等 —— 这也解释了为什么以前偶尔「再点一次就好了」
  const third = newFlowTicket('sess-B')
  assertTrue(followEpochIsCurrent(third, epochCursor('sess-B')), '重开当前会话时旧实现恰好能过')
})

/* ══════════════════════════════════════════════════════════════════════
 * B. 源码守卫：判定本身不改回去
 * ══════════════════════════════════════════════════════════════════════ */

check('B1 store.ts 的 openSessionFlow 用 followEpochTurnIsCurrent 做开门检查', async () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const storePath = resolve(here, '..', 'store.ts')
  const source = readFileSync(storePath, 'utf8')
  const start = source.indexOf('const openSessionFlow = async')
  assertTrue(start >= 0, '找不到 openSessionFlow（源码结构变了，更新这条用例）')
  // 取函数开头到「session.sessionId = id」之间那一段：开门检查就在这里面
  const assignAt = source.indexOf('session.sessionId = id', start)
  assertTrue(assignAt > start, '找不到 session.sessionId = id')
  const head = source.slice(start, assignAt)
  assertTrue(
    head.includes('followEpochTurnIsCurrent(ticket, sessionEpoch)'),
    '开门检查必须只比代际（followEpochTurnIsCurrent）——改回 flowIsCurrent 就会重现「点会话没反应」',
  )
  assertFalse(
    /if\s*\(\s*!flowIsCurrent\(session, ticket\)\s*\)\s*\{[\s\S]{0,80}staleFlow/u.test(head),
    '开门检查不许再用 flowIsCurrent（它比 sessionId，切换前必然不等）',
  )
})

/* ── 跑 ───────────────────────────────────────────────────────────────── */

const main = async (): Promise<void> => {
  let failures = 0
  for (const item of checks) {
    try {
      await item.run()
      console.log(`PASS  ${item.name}`)
    } catch (error) {
      failures += 1
      console.error(`FAIL  ${item.name}`)
      console.error(`      ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  console.log(`\n${checks.length - failures} PASS / ${failures} FAIL / ${checks.length} TOTAL`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
