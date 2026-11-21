/**
 * 工具卡折叠状态机自测（R2：默认全部收起）。
 *
 * 跑法（workdir = projects\deepseek-tablet\web）：
 *   npx tsx src/components/remote/tool/__selftest__/toolCardState.selftest.mts
 *
 * 用户原话：「新的工具卡片，如果出现新的，应该默认收起，每一个都默认收起，只有要看才点开」。
 * 所以这里断言的就是那三条规则：
 *   A. **默认收起** —— 没点过的 id 一律 `false`，包括 running、包括带图片的（状态机不认识状态）；
 *   B. **只有点击才展开** —— `toggleToolOpen` 一次开、再一次关，且写进记忆；
 *   C. **新帧不弹开** —— `followToolItem` 同一个 id 原样返回（引用相等 = 组件不用改 state），
 *      哪怕记忆表被别人改成 `true`；只有 id 变了才回记忆里读，读不到就收起。
 * 另外守两条回归线：模块里**不再有** `takeAutoOpen`（自动展开的入口已删），
 * 记忆在「组件卸载重建」之后仍然生效。
 */

import * as toolCardState from '../toolCardState.js'
import {
  followToolItem,
  readToolOpen,
  resetToolCardMemory,
  toggleToolOpen,
  toolCardMemorySnapshot,
  writeToolOpen,
  type ToolCardOpenView,
} from '../toolCardState.js'

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

const assertTrue = (value: unknown, label: string): void => {
  if (value !== true) fail(`${label}：期望 true，实际 ${JSON.stringify(value)}`)
}

const assertFalse = (value: unknown, label: string): void => {
  if (value !== false) fail(`${label}：期望 false，实际 ${JSON.stringify(value)}`)
}

/* ══════════════════════════════════════════════════════════════════════
 * A. 默认收起
 * ══════════════════════════════════════════════════════════════════════ */

check('A1：没点过的 id 一律收起（默认折叠）', async () => {
  resetToolCardMemory()
  assertFalse(readToolOpen('tool-1'), '全新的 id')
  assertFalse(readToolOpen('tool-running'), '运行中的 id 也没用过 —— 状态机不认识 state')
  assertFalse(readToolOpen('tool-image'), '带图片的 id 也一样')
  assertEqual(toolCardMemorySnapshot().size, 0, '没点过就不该往记忆里写东西')
})

check('A2：模块里不再有「自动展开」入口（takeAutoOpen / autoOpened 已删除）', async () => {
  assertFalse(Object.hasOwn(toolCardState, 'takeAutoOpen'), 'takeAutoOpen 必须已经删掉')
  assertFalse('autoOpened' in toolCardState, 'autoOpened 集合也必须已经删掉')
  assertTrue(Object.hasOwn(toolCardState, 'toggleToolOpen'), 'toggleToolOpen 是新入口')
  assertTrue(Object.hasOwn(toolCardState, 'followToolItem'), 'followToolItem 是新入口')
})

/* ══════════════════════════════════════════════════════════════════════
 * B. 只有点击才展开
 * ══════════════════════════════════════════════════════════════════════ */

check('B1：toggleToolOpen 开 → 关，并写进记忆', async () => {
  resetToolCardMemory()
  assertTrue(toggleToolOpen('tool-a'), '第一次点击：展开')
  assertTrue(readToolOpen('tool-a'), '记忆里是展开')
  assertFalse(toggleToolOpen('tool-a'), '第二次点击：收起')
  assertFalse(readToolOpen('tool-a'), '记忆里是收起')

  writeToolOpen('tool-b', true)
  assertTrue(readToolOpen('tool-b'), 'writeToolOpen 写入生效')
  assertFalse(readToolOpen('tool-c'), '别的 id 不受影响')
})

check('B2：记忆活在组件树之外（卸载重建后仍然是用户的选择）', async () => {
  resetToolCardMemory()
  writeToolOpen('tool-keep', true)
  // 组件重建 = 重新初始化视图状态，再问一次记忆
  const remounted: ToolCardOpenView = { id: 'tool-keep', open: readToolOpen('tool-keep') }
  assertTrue(remounted.open, '滚动回来仍然是展开')
  resetToolCardMemory()
  assertEqual(readToolOpen('tool-keep'), false, 'reset 之后回到默认收起（只给自测用）')
})

/* ══════════════════════════════════════════════════════════════════════
 * C. 新帧不弹开
 * ══════════════════════════════════════════════════════════════════════ */

check('C1：同一个 id 上新帧到达 → 原样返回（引用相等，组件不改 state）', async () => {
  resetToolCardMemory()
  const view: ToolCardOpenView = { id: 'tool-x', open: false }
  const next = followToolItem(view, 'tool-x')
  assertTrue(next === view, '必须返回同一个对象，否则组件会多渲染一次')
  assertFalse(next.open, '用户收起着，新帧不能把它弹开')

  // 即使用户已经展开，新帧也只跟着当前 state 走
  const opened: ToolCardOpenView = { id: 'tool-x', open: true }
  assertTrue(followToolItem(opened, 'tool-x') === opened, '展开状态同样原样返回')

  // 记忆表被别人写成 true（例如上一轮的残留）也不影响当前这条 item 的显示
  writeToolOpen('tool-x', true)
  const stillCollapsed = followToolItem(view, 'tool-x')
  assertTrue(stillCollapsed === view, '仍然原样返回')
  assertFalse(stillCollapsed.open, '当前状态是收起就还是收起')
})

check('C2：换了 id（列表复用组件实例）→ 以记忆为准，读不到就是收起', async () => {
  resetToolCardMemory()
  const stale: ToolCardOpenView = { id: 'tool-old', open: true }
  const next = followToolItem(stale, 'tool-new')
  assertFalse(next === stale, '换了 id 必须给一份新的视图状态')
  assertEqual(next, { id: 'tool-new', open: false }, '新 id 默认收起')

  writeToolOpen('tool-known', true)
  assertEqual(followToolItem(stale, 'tool-known'), { id: 'tool-known', open: true }, '记忆里展开过的仍然展开')
})

check('C3：一整段「新工具不断出现」的序列 —— 新出现的都是收起', async () => {
  resetToolCardMemory()
  let view: ToolCardOpenView = { id: 'tool-1', open: readToolOpen('tool-1') }
  // 用户点开了第一条
  view = { id: 'tool-1', open: toggleToolOpen('tool-1') }
  assertTrue(view.open, '第一条被点开')

  // 后面又来了 5 条新工具（每条都是新的 id），全都不该展开
  for (let index = 2; index <= 6; index += 1) {
    const id = `tool-${index}`
    const candidate = followToolItem(view, id)
    if (candidate !== view) view = candidate
    assertFalse(view.open, `新出现的 ${id} 必须收起`)
    assertEqual(view.id, id, `视图状态换到 ${id}`)
  }

  // 用户回头点开第 3 条，再回来看第 1 条：两条各自的记忆都不受影响
  view = { id: 'tool-3', open: toggleToolOpen('tool-3') }
  assertTrue(view.open, '第 3 条被点开')
  const backToFirst = followToolItem(view, 'tool-1')
  assertTrue(backToFirst.open, '第一条仍然是展开的（用户之前点开过）')
  const backToThird = followToolItem(backToFirst, 'tool-3')
  assertTrue(backToThird.open, '第三条也仍然是展开的')
  assertEqual(toolCardMemorySnapshot().get('tool-4'), undefined, '没点过的不进记忆')
})

/* ── 跑 ───────────────────────────────────────────────────────────────── */

const main = async (): Promise<void> => {
  let failures = 0
  for (const item of checks) {
    const startedAt = Date.now()
    try {
      await item.run()
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

await main()
