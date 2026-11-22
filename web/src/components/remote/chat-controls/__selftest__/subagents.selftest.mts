/**
 * [R16 子代理] `subagents.ts`（会话信息面板「子代理」一节）自测。
 *
 * 跑法（workdir = projects\deepseek-tablet\web）：
 *   npx tsx src/components/remote/chat-controls/__selftest__/subagents.selftest.mts
 *
 * 覆盖（任务书的四条要求）：
 *   A. 筛选：只留 `parentSessionId === 当前会话` 的行（origin 缺失 / 带值都认，
 *      根会话与别的父会话一律不要）；
 *   B. 时间戳三种形态：秒级 × 1000、毫秒级原样、ISO 走 `Date.parse`
 *      （认不出的字符串 / NaN → `undefined`）；
 *   C. 排序：按 `updatedAt` 倒序，缺时间的排最后；
 *   D. title 缺省：空串 / undefined → `undefined`（占位文案由 UI 兜底）；
 *   E. 空输入：rows 空数组、sessionId 为 null / 空串 → 都是空数组。
 *
 * 纯函数不碰 store / 网络，所以不需要 `new-session.selftest.mts` 那套 localStorage
 * 与假 target 的铺垫；断言器仍是同一套写法。
 *
 * 结尾按仓库约定设置真实退出码（`process.exit(failures === 0 ? 0 : 1)`）。
 */

import { subagentChildrenOf, type SubagentRowInput } from '../subagents.js'

/* ── 最小断言器（与其它 selftest 同一套写法） ─────────────────────────── */

const checks: Array<{ name: string; run: () => Promise<void> }> = []
const check = (name: string, run: () => Promise<void>): void => {
  checks.push({ name, run })
}

const fail = (message: string): never => {
  throw new Error(message)
}

const assertEqual = (actual: unknown, expected: unknown, label: string): void => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) fail(`${label}：期望 ${e}，实际 ${a}`)
}

/* ── 造数据 ───────────────────────────────────────────────────────────── */

const PARENT = 'sess-parent'

/** 摆一行 `session/list` 风格的输入（缺省字段按需补）。 */
const row = (patch: Partial<SubagentRowInput> & { sessionId: string }): SubagentRowInput => ({
  title: `任务 ${patch.sessionId}`,
  ...patch,
})

/* ────────────────────────────────────────────────────────────────────────
 * A. 筛选
 * ──────────────────────────────────────────────────────────────────────── */

check('A1：只留 parentSessionId === 当前会话 的行（不看 origin）', async () => {
  const children = subagentChildrenOf(
    [
      row({ sessionId: 'c-1', parentSessionId: PARENT }), // origin 缺失也算
      row({ sessionId: 'c-2', parentSessionId: PARENT, updatedAt: 5 }),
      row({ sessionId: 'c-3', parentSessionId: PARENT, updatedAt: 7, origin: 'subagent' }), // origin 带值也认
      row({ sessionId: 'c-other', parentSessionId: 'sess-other' }), // 别的会话的子代理
      row({ sessionId: 'root-1' }), // 根会话
    ],
    PARENT,
  )
  assertEqual(children.map((child) => child.id), ['c-3', 'c-2', 'c-1'], '三行命中（c-3 较新排前）')
  // 投影形状逐字段：只带 id / title / updatedAt，不带 origin / cwd 之类的原始字段
  assertEqual(children[0], { id: 'c-3', title: '任务 c-3', updatedAt: 7_000 }, '投影的最小形状（秒 ×1000）')
})

/* ────────────────────────────────────────────────────────────────────────
 * B. 时间戳三种形态
 * ──────────────────────────────────────────────────────────────────────── */

check('B1：updatedAt 秒 / 毫秒 / ISO 统一成毫秒；认不出的折成 undefined', async () => {
  const iso = '2026-01-02T03:04:05.000Z'
  const children = subagentChildrenOf(
    [
      row({ sessionId: 'sec', parentSessionId: PARENT, updatedAt: 100 }), // 秒级
      row({ sessionId: 'ms', parentSessionId: PARENT, updatedAt: 1_700_000_000_000 }), // 毫秒级
      row({ sessionId: 'iso', parentSessionId: PARENT, updatedAt: iso }), // ISO 字符串
      row({ sessionId: 'bad-str', parentSessionId: PARENT, updatedAt: 'not-a-date' }),
      row({ sessionId: 'bad-num', parentSessionId: PARENT, updatedAt: Number.NaN }),
    ],
    PARENT,
  )
  const timeOf = new Map(children.map((child) => [child.id, child.updatedAt] as const))
  assertEqual(timeOf.get('sec'), 100_000, '秒级 × 1000')
  assertEqual(timeOf.get('ms'), 1_700_000_000_000, '毫秒级原样')
  // 固定 Z 时区的 ISO 串：Date.parse 的结果是常量，断言不随时钟漂
  assertEqual(timeOf.get('iso'), Date.parse(iso), 'ISO 走 Date.parse')
  assertEqual(timeOf.get('bad-str'), undefined, '认不出的字符串 → undefined')
  assertEqual(timeOf.get('bad-num'), undefined, 'NaN → undefined')
})

/* ────────────────────────────────────────────────────────────────────────
 * C. 排序
 * ──────────────────────────────────────────────────────────────────────── */

check('C1：按 updatedAt 倒序（最新的在最上），缺时间的排最后', async () => {
  const iso = '2026-01-02T03:04:05.000Z'
  const children = subagentChildrenOf(
    [
      row({ sessionId: 'old-sec', parentSessionId: PARENT, updatedAt: 100 }), // → 1970 年的毫秒
      row({ sessionId: 'new-iso', parentSessionId: PARENT, updatedAt: iso }), // → 2026 年
      row({ sessionId: 'no-time', parentSessionId: PARENT }), // 没有 updatedAt
      row({ sessionId: 'mid-ms', parentSessionId: PARENT, updatedAt: 1_700_000_000_000 }), // → 2023 年
    ],
    PARENT,
  )
  assertEqual(
    children.map((child) => child.id),
    ['new-iso', 'mid-ms', 'old-sec', 'no-time'],
    '最新在最上，没时间的垫底',
  )
})

/* ────────────────────────────────────────────────────────────────────────
 * D. title 缺省
 * ──────────────────────────────────────────────────────────────────────── */

check('D1：title 空串 / undefined 折成 undefined，正常标题原样保留', async () => {
  const children = subagentChildrenOf(
    [
      row({ sessionId: 'named', parentSessionId: PARENT, title: '检索：子代理交付自查' }),
      row({ sessionId: 'blank', parentSessionId: PARENT, title: '' }),
      row({ sessionId: 'missing', parentSessionId: PARENT, title: undefined }),
    ],
    PARENT,
  )
  const titleOf = new Map(children.map((child) => [child.id, child.title] as const))
  assertEqual(titleOf.get('named'), '检索：子代理交付自查', '正常标题保留')
  assertEqual(titleOf.get('blank'), undefined, '空串 → undefined（UI 兜底 remoteSubagentUntitled）')
  assertEqual(titleOf.get('missing'), undefined, 'undefined 原样（不猜标题）')
})

/* ────────────────────────────────────────────────────────────────────────
 * E. 空输入
 * ──────────────────────────────────────────────────────────────────────── */

check('E1：空输入 —— rows 空数组 / sessionId 为 null / 空串 → 都是空数组', async () => {
  assertEqual(subagentChildrenOf([], PARENT), [], 'rows 空数组')
  assertEqual(
    subagentChildrenOf([row({ sessionId: 'c-1', parentSessionId: PARENT })], null),
    [],
    'sessionId 为 null（面板没绑会话）',
  )
  assertEqual(
    subagentChildrenOf([row({ sessionId: 'c-1', parentSessionId: PARENT })], ''),
    [],
    'sessionId 为空串',
  )
})

/* ── 跑 ───────────────────────────────────────────────────────────────── */

const describeDuration = (startedAt: number): string => `  (${Date.now() - startedAt}ms)`

const main = async (): Promise<void> => {
  let failures = 0
  for (const item of checks) {
    const startedAt = Date.now()
    try {
      await item.run()
      console.log(`PASS  ${item.name}${describeDuration(startedAt)}`)
    } catch (error) {
      failures += 1
      console.error(`FAIL  ${item.name}${describeDuration(startedAt)}`)
      console.error(`      ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  console.log(`\n${checks.length - failures} PASS / ${failures} FAIL / ${checks.length} TOTAL`)
  // 红了必须真的红（仓库约定：检查脚本必须设置退出码）
  process.exit(failures === 0 ? 0 : 1)
}

await main()
