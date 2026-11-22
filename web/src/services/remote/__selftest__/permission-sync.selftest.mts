/**
 * [R19] 权限模式「显示 = 实际」自测。
 *
 * 真机症状（用户原话）：「权限模式就和实际用的显示的不一样」。
 * 根因不是 UI，是数据层只认一个字段位置：
 *   以前 `applyProjection()` 只读 `values.permissions.currentValue`，取不到就写 `null`
 *   —— 于是 Host 把预设放在 `values.permission`（会话级单值）时，界面永远显示「默认」。
 *   另外 `session/follow` 快照里的 `projections`（老 Host 上唯一来源）和日志事件
 *   `permission/preset`（会话进行中改权限只留这一条）都没被读。
 *
 * 跑法（workdir = projects\deepseek-tablet\web）：
 *   npx tsx src/services/remote/__selftest__/permission-sync.selftest.mts
 *
 * 覆盖：
 *   A. `permissionPresetOfValues()` 四路来源（Host 的 `permission` 单值 / 对象 /
 *      client-core 的 `permissions.currentValue` / 摊平的 `permissionPreset`）
 *   B. 取不到就是 `undefined` —— **绝不猜默认值**
 *   C. `noteSnapshotProjections()` 三种快照形状
 *   D. `permissionPresetOfFollowItem()`：`permission/preset` 的 data / 顶层两种写法
 *   E. `session/control` 帧：没有权限键的投影**不许**把已知值冲成 null
 *   F. `seq` 防旧覆盖（乱序帧比已知值旧就不写）
 */

import { permissionPresetOfFollowItem } from '../adapter.js'
import {
  applyControlFrame,
  noteSessionPermissionPreset,
  noteSnapshotProjections,
  permissionPresetOfSession,
  permissionPresetOfValues,
  selectControlSession,
  useChatControls,
} from '../sessionControls.js'

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

/* ══════════════════════════════════════════════════════════════════════
 * A/B. 四路来源 + 不猜默认
 * ══════════════════════════════════════════════════════════════════════ */

check('A1 Host 的会话级单值：values.permission 是字符串', async () => {
  assertEqual(
    permissionPresetOfValues({ permission: 'read-only' }),
    'read-only',
    '这是 dsh-Go `new_chat_modes.dart:75` 那一路（session/create 也用同名字段）',
  )
})

check('A2 包成对象：values.permission.preset / currentValue', async () => {
  assertEqual(permissionPresetOfValues({ permission: { preset: 'workspace-write' } }), 'workspace-write', 'preset')
  assertEqual(
    permissionPresetOfValues({ permission: { currentValue: 'danger-full-access' } }),
    'danger-full-access',
    'currentValue',
  )
})

check('A3 client-core 投影：values.permissions.currentValue', async () => {
  assertEqual(permissionPresetOfValues({ permissions: { currentValue: 'auto' } }), 'auto', '老路径仍在')
})

check('A4 摊平字段：values.permissionPreset', async () => {
  assertEqual(permissionPresetOfValues({ permissionPreset: 'custom' }), 'custom', '派生字段也认')
})

check('B1 一个都取不到 → undefined（绝不猜默认值）', async () => {
  assertEqual(permissionPresetOfValues({}), undefined, '空 values')
  assertEqual(permissionPresetOfValues({ permission: null }), undefined, 'null 不算')
  assertEqual(permissionPresetOfValues({ permission: {} }), undefined, '空对象不算')
  assertEqual(permissionPresetOfValues({ permission: 3 }), undefined, '非字符串不算')
  assertEqual(
    permissionPresetOfValues({ title: '周报', modelSelection: { next: {} } }),
    undefined,
    '别的投影键存在也不能当成权限',
  )
})

/* ══════════════════════════════════════════════════════════════════════
 * C. 快照 projections 的三种形状
 * ══════════════════════════════════════════════════════════════════════ */

check('C1 SessionProjections 型：{permissionPreset, asOfSeq, values}', async () => {
  noteSnapshotProjections('snap-1', { asOfSeq: 12, permissionPreset: 'read-only', values: { permission: 'auto' } })
  assertEqual(permissionPresetOfSession('snap-1'), 'read-only', '顶层 permissionPreset 优先')
})

check('C2 values 型：{values:{permission:"workspace-write"}}', async () => {
  noteSnapshotProjections('snap-2', { asOfSeq: 3, values: { permission: 'workspace-write' } })
  assertEqual(permissionPresetOfSession('snap-2'), 'workspace-write', '从 values 里读到')
})

check('C3 按会话包一层型：{[sessionId]:{asOfSeq,values}}', async () => {
  noteSnapshotProjections('snap-3', { 'snap-3': { asOfSeq: 1, values: { permission: 'danger-full-access' } } })
  assertEqual(permissionPresetOfSession('snap-3'), 'danger-full-access', '按 sessionId 取块')
})

check('C4 快照里没有权限键：什么都不写（不覆盖已知值）', async () => {
  noteSessionPermissionPreset('snap-4', 'read-only')
  noteSnapshotProjections('snap-4', { asOfSeq: 2, values: { title: '只改了标题' } })
  assertEqual(permissionPresetOfSession('snap-4'), 'read-only', '已知值必须留着')
})

/* ══════════════════════════════════════════════════════════════════════
 * D. 日志事件 permission/preset
 * ══════════════════════════════════════════════════════════════════════ */

check('D1 permission/preset 事件：data.preset 与顶层 preset 都认', async () => {
  const inData = {
    type: 'event',
    event: { type: 'permission/preset', seq: 5, time: 1_000, data: { preset: 'read-only' } },
  }
  assertEqual(permissionPresetOfFollowItem(inData), 'read-only', 'data.preset')
  const flat = {
    type: 'event',
    event: { type: 'permission/preset', seq: 6, time: 1_000, data: {}, preset: 'auto' },
  }
  assertEqual(permissionPresetOfFollowItem(flat), 'auto', '顶层 preset')
  const other = {
    type: 'event',
    event: { type: 'assistant/message', seq: 7, time: 1_000, data: { text: 'hi' } },
  }
  assertEqual(permissionPresetOfFollowItem(other), undefined, '别的事件不给值')
  assertEqual(permissionPresetOfFollowItem(null), undefined, '坏帧不抛')
})

/* ══════════════════════════════════════════════════════════════════════
 * E. 没有权限键的 control 帧不许把已知值冲成 null（真机 bug 的现场）
 * ══════════════════════════════════════════════════════════════════════ */

check('E1 baseline 带权限 → 切会话显示它；再来一条无关投影 → 不能变回「默认」', async () => {
  applyControlFrame({
    type: 'baseline',
    value: {
      projections: {
        'ctl-1': { asOfSeq: 4, values: { permission: 'read-only', title: '整理三月对账单' } },
      },
    },
  })
  selectControlSession('ctl-1')
  assertEqual(useChatControls.getState().currentPermission, 'read-only', '进会话就应该显示真实的权限')

  // 之后来一条只带 title 的投影（很常见：模型/标题变了才推）：权限不能被清掉
  applyControlFrame({ type: 'projection', sessionId: 'ctl-1', seq: 5, changes: [{ key: 'title', val: '改了标题' }] })
  assertEqual(useChatControls.getState().currentPermission, 'read-only', '无关投影不许把权限冲掉')
  assertEqual(useChatControls.getState().title, '改了标题', 'title 照常更新')
})

check('E2 权限真的变了：投影跟上（显示 = 实际）', async () => {
  applyControlFrame({
    type: 'projection',
    sessionId: 'ctl-1',
    seq: 6,
    changes: [{ key: 'permission', val: 'danger-full-access' }],
  })
  assertEqual(useChatControls.getState().currentPermission, 'danger-full-access', '新值必须覆盖旧值')
})

/* ══════════════════════════════════════════════════════════════════════
 * F. seq 防旧覆盖
 * ══════════════════════════════════════════════════════════════════════ */

check('F1 乱序帧：比已知 seq 旧的值不许写回', async () => {
  selectControlSession('ctl-2')
  noteSessionPermissionPreset('ctl-2', 'auto', 20)
  noteSessionPermissionPreset('ctl-2', 'read-only', 10)
  assertEqual(permissionPresetOfSession('ctl-2'), 'auto', '旧帧（seq 10）不能盖掉 seq 20')

  noteSessionPermissionPreset('ctl-2', 'workspace-write', 21)
  assertEqual(permissionPresetOfSession('ctl-2'), 'workspace-write', '更新的帧照常写')
})

check('F2 空值 / 空串不写（坏帧不许把权限弄成空）', async () => {
  noteSessionPermissionPreset('ctl-2', undefined, 30)
  noteSessionPermissionPreset('ctl-2', '', 31)
  assertEqual(permissionPresetOfSession('ctl-2'), 'workspace-write', '空值不覆盖')
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
