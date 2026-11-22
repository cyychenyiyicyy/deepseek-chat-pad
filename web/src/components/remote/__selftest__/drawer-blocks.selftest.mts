/**
 * 抽屉分块纯函数（drawerBlocks.ts）自测。
 *
 * 跑法（workdir = projects\deepseek-tablet\web）：
 *   npx tsx src/components/remote/__selftest__/drawer-blocks.selftest.mts
 *
 * 覆盖（照 dsh-Go 抽屉的语义逐条摆）：
 *   1.  `dayBucketOf` 的自然日边界：今天 0 点 / 昨天 / 第 7 天 / 更早，
 *       外加未来时间（时钟漂移宽容）与无效时间（沉「更早」）；
 *   2.  `buildDrawerRows`：归档沉底 > 置顶浮顶 > updatedAt 倒序（组件原 sort 的同一口径）；
 *   3.  状态判据：running 只认 `liveById[id]?.running === true`；待确认取大
 *       （`pendingInteractions` 总数 vs `live.approval`）且活动会话不计；
 *   4.  `rowMarkerOf`：行尾「至多一个」标记的优先级 —— 待确认 > 运行中（session_tile.dart:71-80）
 *       > ghost「已不存在」>「已归档」小标；
 *   5.  `buildDrawerBlocks('all')`：置顶 → 今天 / 昨天 / 近 7 天 / 更早 → 已归档沉底，
 *       空块不出现、置顶块内倒序；
 *   6.  `buildDrawerBlocks(filter)`：命中拍平成一块（drawer_list.dart 的 FilteredBlock）、
 *       归档 running 行照命中、纯按时间倒序；
 *   7.  空会话的各空态形状：'all' → []（原空态文案），'running' / 'pending' →
 *       一个空 rows 的 filtered 块（组件凭它给「没有在跑的 / 没有待确认的」）；
 *   8.  `drawerFilterCounts`：对全集（含归档行）计数，供胶囊拼「运行中 2」「待确认 1」。
 *
 * 结尾按仓库约定设置真实退出码（`pnpm run type` 之外的一道闸）。
 */

import {
  buildDrawerBlocks,
  buildDrawerRows,
  dayBucketOf,
  drawerFilterCounts,
  rowMarkerOf,
  type DrawerBlocksInput,
  type DrawerSessionInput,
} from '../drawerBlocks.js'

/* ── 最小断言器（与 new-session.selftest.mts 同一套写法） ───────────────── */

const checks: Array<{ name: string; run: () => void }> = []
const check = (name: string, run: () => void): void => {
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

/* ── 时钟与输入工厂 ──────────────────────────────────────────────────────── */

/** 本地时区 2026-12-20 12:00（分桶按自然日，构造的边界全都相对它算） */
const NOW = new Date(2026, 11, 20, 12, 0, 0).getTime()
const at = (year: number, monthIndex: number, day: number): number =>
  new Date(year, monthIndex, day, 0, 0, 0).getTime()
/** 今天 / 昨天 / 第 7 天 / 第 8 天的 0 点（自然日边界） */
const TODAY_0 = at(2026, 11, 20)
const YESTERDAY_0 = at(2026, 11, 19)
const DAY7_0 = at(2026, 11, 14)
const DAY8_0 = at(2026, 11, 13)

const session = (
  id: string,
  updatedAt: number | string,
  extra: Partial<DrawerSessionInput> = {},
): DrawerSessionInput => ({
  id,
  title: `标题-${id}`,
  updatedAt,
  ...extra,
})

const baseInput = (
  sessions: readonly DrawerSessionInput[],
  extra: Partial<DrawerBlocksInput> = {},
): DrawerBlocksInput => ({
  sessions,
  pinnedIds: [],
  archivedIds: [],
  liveById: {},
  pendingInteractions: {},
  activeSessionId: null,
  filter: 'all',
  now: NOW,
  ...extra,
})

/* ────────────────────────────────────────────────────────────────────────
 * 1. dayBucketOf：自然日边界
 * ──────────────────────────────────────────────────────────────────────── */

check('1a：今天 0 点整（含）到未来都是「今天」', () => {
  assertEqual(dayBucketOf(TODAY_0, NOW), 'today', '今天 0 点整')
  assertEqual(dayBucketOf(NOW, NOW), 'today', 'now 本身')
  assertEqual(dayBucketOf(NOW + 3_600_000, NOW), 'today', '未来 1 小时（时钟漂移，宽容地算今天）')
})

check('1b：昨天 0 点整到今天 0 点前 1ms 都是「昨天」', () => {
  assertEqual(dayBucketOf(YESTERDAY_0, NOW), 'yesterday', '昨天 0 点整')
  assertEqual(dayBucketOf(TODAY_0 - 1, NOW), 'yesterday', '今天 0 点前 1ms（= 昨天 23:59:59.999）')
})

check('1c：第 7 天 0 点仍在「近 7 天」，第 8 天 0 点起算「更早」', () => {
  // 近 7 天 = 含今天在内的 7 个自然日（12-14 ~ 12-20）
  assertEqual(dayBucketOf(DAY7_0, NOW), 'week', '第 7 天 0 点（12-14）→ week')
  assertEqual(dayBucketOf(DAY7_0 - 1, NOW), 'earlier', '第 7 天 0 点前 1ms（= 第 8 天末）→ earlier')
  assertEqual(dayBucketOf(DAY8_0, NOW), 'earlier', '第 8 天 0 点（12-13）→ earlier')
  assertEqual(dayBucketOf(at(2026, 11, 18), NOW), 'week', '中间一天（12-18）也在 week')
})

check('1d：无效时间沉「更早」（认不出的 updatedAt 不能混进今天）', () => {
  assertEqual(dayBucketOf(Number.NaN, NOW), 'earlier', 'NaN')
  assertEqual(dayBucketOf(0, NOW), 'earlier', 'epoch（1970）')
})

/* ────────────────────────────────────────────────────────────────────────
 * 2. buildDrawerRows：排序口径 + 状态判据
 * ──────────────────────────────────────────────────────────────────────── */

check('2a：归档沉底 > 置顶浮顶 > updatedAt 倒序（组件原 sort 的同一口径）', () => {
  const rows = buildDrawerRows(baseInput([
    session('plain-old', 100),
    session('archived-new', 900),
    session('pinned-old', 100, { pinned: true }),
    session('plain-new', 900),
    session('pinned-new', 900),
  ], {
    pinnedIds: ['pinned-old', 'pinned-new'],
    archivedIds: ['archived-new'],
  }))
  assertEqual(rows.map((row) => row.id), [
    'pinned-new',
    'pinned-old',
    'plain-new',
    'plain-old',
    'archived-new',
  ], '置顶在前、归档在最后、其余按时间倒序')
})

check('2b：running 只认 liveById[id]?.running === true，列表说熄就熄', () => {
  const rows = buildDrawerRows(baseInput([session('r-on', 100), session('r-off', 200), session('r-none', 300)], {
    liveById: { 'r-on': { running: true }, 'r-off': { running: false } },
  }))
  assertEqual(rows.map((row) => row.running), [false, false, true], '只有 r-on 在跑')
  assertEqual(rows[2]?.marker, 'running', 'r-on 的行尾标记是运行圆点')
})

check('2c：待确认取大 —— pendingInteractions 与 live.approval 两条独立记账任一条 >0 都亮', () => {
  const rows = buildDrawerRows(baseInput([
    session('by-interactions', 100),
    session('by-live-approval', 200),
    session('both-zero', 300),
    session('active-here', 400),
  ], {
    pendingInteractions: {
      'by-interactions': { approval: 0, question: 2 },
      'both-zero': { approval: 0, question: 0 },
      'active-here': { approval: 1, question: 1 },
    },
    liveById: { 'by-live-approval': { approval: 1 }, 'active-here': { approval: 3 } },
    activeSessionId: 'active-here',
  }))
  assertEqual(rows.map((row) => row.pending), [false, false, true, true], '取大命中两条（行序 = updatedAt 倒序）')
  assertEqual(rows[3]?.marker, 'pending', '提问计数 >0 也算待确认')
  assertEqual(rows[2]?.marker, 'pending', 'live.approval 通道单独 >0 也算待确认')
  assertEqual(rows[1]?.marker, null, '两条都清零 → 没有标记')
  // 活动会话不计：用户已经在这个会话里，红点没有意义（[R9] 同一口径）
  assertEqual(rows[0]?.pending, false, '活动会话的待确认不计')
})

check('2d：活动会话照常显示运行圆点（不计的只有待确认）', () => {
  const rows = buildDrawerRows(baseInput([session('active-running', 100)], {
    liveById: { 'active-running': { running: true, approval: 5 } },
    pendingInteractions: { 'active-running': { approval: 2, question: 0 } },
    activeSessionId: 'active-running',
  }))
  assertEqual(rows[0]?.pending, false, '活动会话待确认不计')
  assertEqual(rows[0]?.running, true, '活动会话照常算在跑')
  assertEqual(rows[0]?.marker, 'running', '行尾是运行圆点，不是待确认')
})

check('2e：updatedAt 的秒级时间戳 / ISO 字符串 / 缺省都归一（组件原 toMillis 的口径）', () => {
  const seconds = 100_000_000 // 秒级 → 1973 年，但必须先乘 1000 才对
  const rows = buildDrawerRows(baseInput([
    session('sec', seconds),
    session('iso', '2026-12-20T08:00:00'),
    session('none', Number.NaN),
  ]))
  assertEqual(rows.find((row) => row.id === 'sec')?.updatedAt, seconds * 1000, '秒级 → 毫秒')
  assertEqual(dayBucketOf(rows.find((row) => row.id === 'iso')?.updatedAt ?? 0, NOW), 'today', 'ISO 字符串归一后是今天')
  assertEqual(rows.find((row) => row.id === 'none')?.updatedAt, 0, '认不出 → 0（排序沉底）')
})

check('2f：preserveOrder 保持输入顺序（搜索命中按相关性排，别按时间重排）', () => {
  const input = baseInput([session('hit-new', 900), session('hit-old', 100)])
  const rows = buildDrawerRows({ ...input, preserveOrder: true })
  assertEqual(rows.map((row) => row.id), ['hit-new', 'hit-old'], '顺序原样')
})

check('2g：ghost / archived 只降标注，不改排序位置（ghost 行还在自己的日期桶里）', () => {
  const rows = buildDrawerRows(baseInput([session('g1', 100), session('a1', 900)], {
    ghostIds: ['g1'],
    archivedIds: ['a1'],
  }))
  assertEqual(rows[0]?.ghost, true, 'g1 是 ghost')
  assertEqual(rows[0]?.marker, 'ghost', 'g1 行尾是「已不存在」')
  assertEqual(rows[1]?.archived, true, 'a1 归档沉底')
  assertEqual(rows[1]?.marker, 'archived', 'a1 行尾是「已归档」小标')
})

/* ────────────────────────────────────────────────────────────────────────
 * 3. rowMarkerOf：行尾「至多一个」标记的优先级（session_tile.dart:71-80）
 * ──────────────────────────────────────────────────────────────────────── */

check('3a：待确认 > 运行中 > ghost > 已归档，至多亮一个', () => {
  assertEqual(rowMarkerOf({ pending: true, running: true, ghost: false, archived: true }), 'pending', '全部为真 → 待确认')
  assertEqual(rowMarkerOf({ pending: false, running: true, ghost: true, archived: false }), 'running', '其次运行中')
  assertEqual(rowMarkerOf({ pending: false, running: false, ghost: true, archived: true }), 'ghost', 'ghost 优先于已归档（临时态先说）')
  assertEqual(rowMarkerOf({ pending: false, running: false, ghost: false, archived: true }), 'archived', '只剩已归档小标')
  assertEqual(rowMarkerOf({ pending: false, running: false, ghost: false, archived: false }), null, '干净行没有标记')
})

check('3b：既待确认又在跑的行，标记是「待确认」但两个状态布尔都为真（筛选能各自命中）', () => {
  const rows = buildDrawerRows(baseInput([session('both', 100)], {
    liveById: { both: { running: true, approval: 1 } },
    pendingInteractions: { both: { approval: 0, question: 1 } },
  }))
  assertEqual(rows[0]?.running, true, 'running 布尔为真')
  assertEqual(rows[0]?.pending, true, 'pending 布尔为真')
  assertEqual(rows[0]?.marker, 'pending', '行尾只显示「待确认」')
})

/* ────────────────────────────────────────────────────────────────────────
 * 4. buildDrawerBlocks('all')：置顶 → 日期桶 → 已归档沉底
 * ──────────────────────────────────────────────────────────────────────── */

check('4a：块顺序 置顶 → 今天 → 昨天 → 近 7 天 → 更早 → 已归档，空桶不出现', () => {
  const blocks = buildDrawerBlocks(baseInput([
    session('today-1', NOW),
    session('yesterday-1', YESTERDAY_0 + 3_600_000),
    session('week-1', DAY7_0 + 3_600_000),
    session('earlier-1', DAY8_0),
    session('pinned-1', NOW - 1),
    session('archived-1', NOW),
  ], {
    pinnedIds: ['pinned-1'],
    archivedIds: ['archived-1'],
  }))
  assertEqual(blocks.map((block) => block.kind), ['pinned', 'day', 'day', 'day', 'day', 'archived'], '六块按序')
  assertEqual(blocks.map((block) => block.bucket), [
    undefined,
    'today',
    'yesterday',
    'week',
    'earlier',
    undefined,
  ], '桶名 today → earlier（置顶与归档块没有桶）')
  assertEqual(blocks[0]?.labelKey, 'remoteDrawerPinned', '置顶块的 i18n key')
  assertEqual(blocks[1]?.labelKey, 'remoteDrawerToday', '今天块')
  assertEqual(blocks[2]?.labelKey, 'remoteDrawerYesterday', '昨天块')
  assertEqual(blocks[3]?.labelKey, 'remoteDrawerWeek', '近 7 天块')
  assertEqual(blocks[4]?.labelKey, 'remoteDrawerEarlier', '更早块')
  assertEqual(blocks[5]?.labelKey, 'newSessionArchivedTag', '归档块复用既有「已归档」key')
})

check('4b：每个日期桶内按 updatedAt 倒序；置顶块内同样倒序', () => {
  const blocks = buildDrawerBlocks(baseInput([
    session('today-older', TODAY_0 + 1_000),
    session('today-newer', TODAY_0 + 9_000_000),
    session('pin-older', 100, { pinned: true }),
    session('pin-newer', 200, { pinned: true }),
  ], { pinnedIds: ['pin-older', 'pin-newer'] }))
  const pinned = blocks.find((block) => block.kind === 'pinned')
  assertEqual(pinned?.rows.map((row) => row.id), ['pin-newer', 'pin-older'], '置顶块内倒序')
  const today = blocks.find((block) => block.bucket === 'today')
  assertEqual(today?.rows.map((row) => row.id), ['today-newer', 'today-older'], '今天桶内倒序')
})

check('4c：归档优先于置顶（置顶 + 归档的行沉到归档块，不进置顶块）', () => {
  const blocks = buildDrawerBlocks(baseInput([
    session('pin-archived', NOW),
    session('plain', NOW - 1),
  ], { pinnedIds: ['pin-archived'], archivedIds: ['pin-archived'] }))
  assertEqual(blocks.map((block) => block.kind), ['day', 'archived'], '置顶块没有出现（它唯一的行被归档了）')
  assertEqual(blocks[0]?.rows[0]?.id, 'plain', '普通行进日期桶')
  assertEqual(blocks[1]?.rows[0]?.id, 'pin-archived', '置顶 + 归档的行沉到归档块')
})

/* ────────────────────────────────────────────────────────────────────────
 * 5. buildDrawerBlocks(filter)：命中拍平成一块
 * ──────────────────────────────────────────────────────────────────────── */

check('5a：filter=running 只留在跑的行（含归档的在跑行），纯按时间倒序', () => {
  const blocks = buildDrawerBlocks(baseInput([
    session('idle-new', NOW),
    session('running-older', DAY7_0 + 3_600_000),
    session('running-archived', NOW),
    session('running-new', NOW - 1),
  ], {
    liveById: {
      'running-older': { running: true },
      'running-archived': { running: true },
      'running-new': { running: true },
    },
    archivedIds: ['running-archived'],
    filter: 'running',
  }))
  assertEqual(blocks.length, 1, '拍平成一块')
  assertEqual(blocks[0]?.kind, 'filtered', '块类型')
  assertEqual(blocks[0]?.filter, 'running', '块上记着筛选名')
  assertEqual(blocks[0]?.labelKey, undefined, '拍平块没有小节标题')
  assertEqual(blocks[0]?.rows.map((row) => row.id), [
    'running-archived',
    'running-new',
    'running-older',
  ], '归档的在跑行也命中，按 updatedAt 倒序')
})

check('5b：filter=pending 只留待确认行；活动会话不计（筛出来的是要去看的别的会话）', () => {
  const blocks = buildDrawerBlocks(baseInput([
    session('pending-a', NOW),
    session('pending-active', NOW - 1),
    session('idle', NOW - 2),
  ], {
    pendingInteractions: { 'pending-a': { approval: 1, question: 0 }, 'pending-active': { approval: 2, question: 0 } },
    activeSessionId: 'pending-active',
    filter: 'pending',
  }))
  assertEqual(blocks[0]?.rows.map((row) => row.id), ['pending-a'], '只有非活动的待确认行命中')
})

check('5c：既待确认又在跑的行，running 与 pending 两个筛选都能命中它', () => {
  const input = baseInput([session('both', NOW)], {
    liveById: { both: { running: true, approval: 1 } },
    pendingInteractions: { both: { approval: 1, question: 0 } },
  })
  const running = buildDrawerBlocks({ ...input, filter: 'running' })
  const pending = buildDrawerBlocks({ ...input, filter: 'pending' })
  assertEqual(running[0]?.rows.map((row) => row.id), ['both'], 'running 筛选命中')
  assertEqual(pending[0]?.rows.map((row) => row.id), ['both'], 'pending 筛选也命中（筛选按状态，不看行尾标记）')
})

/* ────────────────────────────────────────────────────────────────────────
 * 6. 空会话的各空态形状
 * ──────────────────────────────────────────────────────────────────────── */

check('6a：空会话 + all → 没有块（组件走原来的「还没有会话 / 未连接」空态）', () => {
  assertEqual(buildDrawerBlocks(baseInput([], { filter: 'all' })), [], '空列表没有块')
})

check('6b：空会话 + 筛选 → 一个空 rows 的 filtered 块（组件凭它给「没有在跑的 / 没有待确认的」）', () => {
  const running = buildDrawerBlocks(baseInput([], { filter: 'running' }))
  assertEqual(running, [{ kind: 'filtered', filter: 'running', rows: [] }], 'running 空态形状')
  const pending = buildDrawerBlocks(baseInput([], { filter: 'pending' }))
  assertEqual(pending, [{ kind: 'filtered', filter: 'pending', rows: [] }], 'pending 空态形状')
})

check('6c：有会话但筛不出命中 → 同样是空 rows 的 filtered 块', () => {
  const blocks = buildDrawerBlocks(baseInput([session('idle', NOW)], { filter: 'running' }))
  assertEqual(blocks, [{ kind: 'filtered', filter: 'running', rows: [] }], '没有在跑的')
})

/* ────────────────────────────────────────────────────────────────────────
 * 7. drawerFilterCounts：胶囊计数对全集算（含归档行）
 * ──────────────────────────────────────────────────────────────────────── */

check('7a：running / pending 计数含归档行，活动会话的待确认不计', () => {
  const counts = drawerFilterCounts(baseInput([
    session('running-archived', NOW),
    session('running-plain', NOW - 1),
    session('pending-plain', NOW - 2),
    session('pending-active', NOW - 3),
    session('idle', NOW - 4),
  ], {
    liveById: { 'running-archived': { running: true }, 'running-plain': { running: true } },
    pendingInteractions: { 'pending-plain': { approval: 0, question: 1 }, 'pending-active': { approval: 9, question: 0 } },
    archivedIds: ['running-archived'],
    activeSessionId: 'pending-active',
  }))
  assertEqual(counts, { running: 2, pending: 1 }, '胶囊拼「运行中 2」「待确认 1」')
})

check('7b：全是干净行 → 计数 0/0（胶囊不加数字，全部正常）', () => {
  assertEqual(drawerFilterCounts(baseInput([session('a', NOW), session('b', NOW - 1)])), {
    running: 0,
    pending: 0,
  }, '没有在跑的也没有待确认')
})

/* ── 跑 ───────────────────────────────────────────────────────────────── */

const main = (): void => {
  let failures = 0
  for (const item of checks) {
    const startedAt = Date.now()
    try {
      item.run()
      console.log(`PASS  ${item.name}  (${Date.now() - startedAt}ms)`)
    } catch (error) {
      failures += 1
      console.error(`FAIL  ${item.name}  (${Date.now() - startedAt}ms)`)
      console.error(`      ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  console.log(`\n${checks.length - failures} PASS / ${failures} FAIL / ${checks.length} TOTAL`)
  // 红了必须真的红（仓库约定：检查脚本必须设置退出码）
  process.exit(failures === 0 ? 0 : 1)
}

main()
