/**
 * 工作区列表（S2）自测：`workspace/follow` 常驻流 + 两份数据合并 + 老 Host 降级。
 *
 * 跑法（workdir = projects\deepseek-tablet\web）：
 *   npx tsx src/services/remote/__selftest__/workspaces.selftest.mts
 *
 * 覆盖（对应任务书的四条自测要求）：
 *   A. **baseline 解析**：首帧逐字段、老 Host 缺 `pinnedSessionIds`、非 baseline 帧 → null；
 *      增量帧（upsert / remove / 认不出）的分类。
 *   B. **合并去重**：follow 权威（同 id 时字段以它为准）、派生只补空字段、
 *      同 id / 同路径两层去重、派生独有的追加在尾部、标题兜底、老 Host 的排序观感。
 *   C. **流关闭重开**：ensure 开流 → 收 baseline；`closed` 帧 → 摘接收器 + 排重开 →
 *      定时器到点重开并再收一份 baseline；`METHOD_NOT_FOUND` → `unsupported` 不重试；
 *      网络错误 → 退避重试；断线（isReady=false）不重开。
 *   D. **老 Host 回退 / store 集成**：baseline 落到 store（含没有会话的工作区）；
 *      增量 upsert / remove；老 Host 只丢列表不丢 UI（`capabilities.workspace` 仍为 true）；
 *      `loadInventory` 在 `workspace/follow` 不可用时仍给出派生列表。
 *
 * 结尾按仓库约定设置真实退出码。
 */

import { observeRemoteTarget, parseWorkspaceBaseline, parseWorkspaceFrame, type RemoteCallTarget, type RemoteStreamHandle } from '../sessionsApi.js'
import { useNewSessionStore } from '../newSessionStore.js'
import { useRemoteStore } from '../store.js'
import {
  createWorkspaceSyncer,
  deriveWorkspacesFromSessions,
  mergeWorkspaceInventory,
  uninstallWorkspaceSync,
  workspaceTitleFromPath,
  type WorkspaceSyncPush,
} from '../workspaces.js'
import type { StreamEventPayload } from '../core/index.js'

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

const assertTrue = (value: boolean, label: string): void => {
  if (!value) fail(label)
}

const tick = async (ms = 0): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

/* ── 内存版 localStorage（store.ts 启动时要读盘） ──────────────────────── */

class MemoryStorage {
  private readonly data = new Map<string, string>()

  get length(): number {
    return this.data.size
  }

  clear(): void {
    this.data.clear()
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.data.delete(key)
  }

  setItem(key: string, value: string): void {
    this.data.set(key, String(value))
  }
}

;(globalThis as unknown as Record<string, unknown>).localStorage = new MemoryStorage()

/* ────────────────────────────────────────────────────────────────────────
 * A. baseline 与增量帧的解析
 * ──────────────────────────────────────────────────────────────────────── */

check('A1：workspace/follow 首帧 baseline 逐字段解析，非 baseline 一律 null', async () => {
  const baseline = parseWorkspaceBaseline({
    type: 'baseline',
    value: {
      items: [
        {
          workspaceId: 'ws-1',
          path: 'C:\\Users\\me\\harness workspace',
          title: 'harness workspace',
          sessionIds: ['s1', 's2'],
          createdAt: '2026-11-01T00:00:00.000Z',
          updatedAt: '2026-11-02T00:00:00.000Z',
        },
        // 没有会话的工作区：这正是旧版派生列表列不出来的那一类
        { workspaceId: 'ws-empty', path: '/home/me/code/empty', title: '', sessionIds: [] },
      ],
      archivedSessionIds: ['s9'],
      pinnedSessionIds: ['s1'],
    },
  })
  assertEqual(baseline?.items.length, 2, '两个工作区')
  assertEqual(baseline?.items[0]?.path, 'C:\\Users\\me\\harness workspace', 'path 原样保留（Windows 反斜杠）')
  assertEqual(baseline?.items[1]?.sessionIds, [], '没有会话的工作区照样在 items 里')
  assertEqual(baseline?.archivedSessionIds, ['s9'], '归档全集')
  assertEqual(baseline?.pinnedSessionIds, ['s1'], '置顶全集')

  // 老 Host 没有 pinnedSessionIds / archivedSessionIds
  const bare = parseWorkspaceBaseline({ type: 'baseline', value: { items: [] } })
  assertEqual(bare?.pinnedSessionIds, [], '缺 pinnedSessionIds → 空数组')
  assertEqual(bare?.archivedSessionIds, [], '缺 archivedSessionIds → 空数组')

  // 帧形状不对：不能拿半截数据往上画
  assertEqual(parseWorkspaceBaseline({ type: 'workspace-updated', value: { items: [] } }), null, '非 baseline 帧')
  assertEqual(parseWorkspaceBaseline({ type: 'baseline' }), null, '缺 value')
  assertEqual(parseWorkspaceBaseline(null), null, 'null 帧')
})

check('A2：增量帧只认得出 upsert / remove，其余忽略', async () => {
  // ① 帧里带 workspace 对象
  const viaWorkspace = parseWorkspaceFrame({
    type: 'workspace/added',
    workspace: { workspaceId: 'ws-9', path: '/new', title: 'new', sessionIds: ['s1'] },
  })
  assertEqual(viaWorkspace, {
    kind: 'upsert',
    workspace: { workspaceId: 'ws-9', path: '/new', title: 'new', sessionIds: ['s1'] },
  }, 'upsert：{workspace}')

  // ② 帧里带 value 对象
  assertEqual(
    parseWorkspaceFrame({ type: 'workspace/updated', value: { workspaceId: 'ws-9', sessionIds: ['s2'] } }),
    { kind: 'upsert', workspace: { workspaceId: 'ws-9', path: '', title: '', sessionIds: ['s2'] } },
    'upsert：{value}',
  )

  // ③ 帧本身就是一行 WorkspaceView
  assertEqual(
    parseWorkspaceFrame({ workspaceId: 'ws-7', path: '/plain', title: 'plain', sessionIds: [] }),
    { kind: 'upsert', workspace: { workspaceId: 'ws-7', path: '/plain', title: 'plain', sessionIds: [] } },
    'upsert：裸对象',
  )

  // ④ 删除的两种写法
  assertEqual(parseWorkspaceFrame({ type: 'workspace/removed', workspaceId: 'ws-9' }), { kind: 'remove', workspaceId: 'ws-9' }, 'remove：type + workspaceId')
  assertEqual(parseWorkspaceFrame({ type: 'workspace', workspaceId: 'ws-8', removed: true }), { kind: 'remove', workspaceId: 'ws-8' }, 'remove：removed:true')

  // ⑤ 认不出 / 没有 id 的一律 ignore（宁可晚一拍，也不画错的工作区）
  assertEqual(parseWorkspaceFrame({ type: 'baseline', value: { items: [] } }), { kind: 'ignore' }, 'baseline 不走增量')
  assertEqual(parseWorkspaceFrame({ type: 'workspace/removed' }), { kind: 'ignore' }, '删除帧缺 id')
  assertEqual(parseWorkspaceFrame({ type: 'ping' }), { kind: 'ignore' }, '未知帧')
  assertEqual(parseWorkspaceFrame(null), { kind: 'ignore' }, 'null 帧')
})

/* ────────────────────────────────────────────────────────────────────────
 * B. 合并与去重
 * ──────────────────────────────────────────────────────────────────────── */

check('B1：follow 权威 —— 同 id 时字段以它为准，派生只补空', async () => {
  const merged = mergeWorkspaceInventory(
    [
      { workspaceId: 'ws-1', path: '', title: '', sessionIds: ['s1'] },
      { workspaceId: 'ws-2', path: '/host/only', title: 'Host 起的名字', sessionIds: [] },
    ],
    [
      { workspaceId: 'ws-1', path: '/derived/one', title: '派生名', sessionIds: ['s1', 's2'] },
      { workspaceId: 'ws-2', path: '/derived/two', title: '派生名二', sessionIds: ['s3'] },
    ],
  )
  assertEqual(merged.map((item) => item.workspaceId), ['ws-1', 'ws-2'], '两行，顺序按 follow')
  assertEqual(merged[0]?.path, '/derived/one', 'follow 的 path 空 → 用派生的补')
  assertEqual(merged[0]?.title, '派生名', 'title 也补上')
  assertEqual(merged[0]?.sessionIds, ['s1', 's2'], 'sessionIds 取并集（follow 的在前）')
  assertEqual(merged[1]?.path, '/host/only', 'follow 有 path 就不被派生覆盖')
  assertEqual(merged[1]?.title, 'Host 起的名字', 'follow 有 title 就不被派生覆盖')
  assertEqual(merged[1]?.sessionIds, ['s3'], '会话 id 并集')
})

check('B2：两层去重 —— 同 id、同路径（不同 id）都只留一行', async () => {
  const merged = mergeWorkspaceInventory(
    [
      { workspaceId: 'ws-a', path: '/home/me/code', title: 'code', sessionIds: ['s1'] },
      { workspaceId: 'ws-b', path: '/home/me/code/', title: 'code（重复注册）', sessionIds: ['s2'] },
    ],
    [],
  )
  assertEqual(merged.length, 1, '同一个目录挂了两个 id → 合成一行')
  assertEqual(merged[0]?.workspaceId, 'ws-a', '留下先出现的那一行（follow 的顺序）')
  assertEqual(merged[0]?.sessionIds, ['s1', 's2'], '会话 id 并集')
  assertEqual(merged[0]?.title, 'code', '标题用先出现的那个')

  // Windows 盘符 + 大小写 + 结尾分隔符都算同一个目录
  const windows = mergeWorkspaceInventory(
    [
      { workspaceId: 'ws-w1', path: 'C:\\Code\\App', title: 'App', sessionIds: [] },
      { workspaceId: 'ws-w2', path: 'c:/code/app/', title: 'App2', sessionIds: [] },
    ],
    [],
  )
  assertEqual(windows.length, 1, 'Windows 路径归一化后是同一个工作区')
})

check('B3：派生独有的追加在尾部；标题兜底为路径末段', async () => {
  const merged = mergeWorkspaceInventory(
    [{ workspaceId: 'ws-host', path: '/srv/host', title: 'host', sessionIds: [] }],
    [
      { workspaceId: 'ws-host', path: '/srv/host', title: 'host', sessionIds: ['s9'] },
      { workspaceId: 'ws-orphan', path: '/srv/orphan', title: '', sessionIds: ['s8'] },
      { workspaceId: 'ws-nopath', path: '', title: '', sessionIds: [] },
    ],
  )
  assertEqual(merged.map((item) => item.workspaceId), ['ws-host', 'ws-orphan', 'ws-nopath'], 'follow 在前、派生独有在后')
  assertEqual(merged[1]?.title, 'orphan', 'title 空 → 路径末段')
  assertEqual(merged[2]?.title, 'ws-nopath', '连 path 都没有 → workspaceId（绝不显示空白行）')
})

check('B4：没有 follow（老 Host）时按标题排序，与旧派生列表观感一致', async () => {
  const rows = [
    { sessionId: 's1', workspaceId: 'ws-b', cwd: '/x/beta', updatedAt: 10 },
    { sessionId: 's2', workspaceId: 'ws-a', cwd: '/x/alpha', updatedAt: 20 },
    { sessionId: 's3', workspaceId: 'ws-a', cwd: '/x/alpha', updatedAt: 5, parentSessionId: 's2' },
    { sessionId: 's4', cwd: '/x/none', updatedAt: 30 },
  ]
  const derived = deriveWorkspacesFromSessions(rows)
  assertEqual(derived.map((item) => item.workspaceId), ['ws-a', 'ws-b'], '派生按标题排序')
  assertEqual(derived[0]?.sessionIds, ['s2'], '子会话不进会话清单')
  assertEqual(workspaceTitleFromPath('/x/alpha'), 'alpha', '路径末段')
  assertEqual(mergeWorkspaceInventory([], derived).map((item) => item.title), ['alpha', 'beta'], '合并没有 follow 时也按标题排序')
})

/* ────────────────────────────────────────────────────────────────────────
 * C. 流：开 / 关 / 重开 / 重试 / 老 Host
 * ──────────────────────────────────────────────────────────────────────── */

interface Harness {
  syncer: ReturnType<typeof createWorkspaceSyncer>
  push: {
    baselines: Array<{ items: unknown[]; archivedSessionIds: string[]; pinnedSessionIds: string[] }>
    deltas: unknown[]
    statuses: string[]
  }
  /** 投一帧给最近一次注册的接收器 */
  emit(payload: StreamEventPayload): void
  /** 手动跑到点的重开定时器 */
  fireTimers(): void
  opens: number
  sinksRegistered: number
  sinksReleased: number
  closed: number
  ready: boolean
  delayOf: number[]
}

/**
 * 一个可手动驱动的同步器：`open` / 定时器 / 帧投递全部由测试控制。
 * `openReplies` 依次决定每次开流的结果（`'ok'` / 错误码）。
 */
const harness = (openReplies: Array<'ok' | string> = ['ok']): Harness => {
  const state: Harness = {
    syncer: null as never,
    push: { baselines: [], deltas: [], statuses: [] },
    emit: () => undefined,
    fireTimers: () => undefined,
    opens: 0,
    sinksRegistered: 0,
    sinksReleased: 0,
    closed: 0,
    ready: true,
    delayOf: [],
  }
  let listener: ((payload: StreamEventPayload) => void) | null = null
  const timers: Array<{ handler: () => void; delay: number }> = []
  state.emit = (payload) => listener?.(payload)
  state.fireTimers = () => {
    const pending = timers.splice(0, timers.length)
    for (const timer of pending) timer.handler()
  }
  const push: WorkspaceSyncPush = {
    onBaseline: (list) => state.push.baselines.push(list as never),
    onDelta: (frame) => state.push.deltas.push(frame),
    onStatus: (status) => state.push.statuses.push(status),
  }
  state.syncer = createWorkspaceSyncer({
    open: async (): Promise<RemoteStreamHandle> => {
      const reply = openReplies[Math.min(state.opens, openReplies.length - 1)] ?? 'ok'
      state.opens += 1
      if (reply !== 'ok') {
        const error = new Error(reply) as Error & { code: string }
        error.code = reply
        throw error
      }
      return {
        streamId: `ws-stream-${state.opens}`,
        close: async (): Promise<void> => {
          state.closed += 1
        },
      }
    },
    registerSink: (_streamId, onPayload) => {
      state.sinksRegistered += 1
      listener = onPayload
      return () => {
        state.sinksReleased += 1
        listener = null
      }
    },
    target: () => ({} as RemoteCallTarget),
    isReady: () => state.ready,
    push,
    setTimeout: (handler, ms) => {
      timers.push({ handler, delay: ms })
      state.delayOf.push(ms)
      return timers.length
    },
    clearTimeout: (handle) => {
      const index = Number(handle) - 1
      if (index >= 0 && index < timers.length) timers.splice(index, 1)
    },
  })
  return state
}

check('C1：ensure 开一条流、注册接收器，首帧 baseline 交给 push', async () => {
  const h = harness()
  h.syncer.ensure()
  await tick()
  assertEqual(h.opens, 1, '开了一次流')
  assertEqual(h.sinksRegistered, 1, '注册了一个接收器')
  assertEqual(h.syncer.status(), 'streaming', '状态 streaming')
  assertEqual(h.syncer.isOpen(), true, '流开着')

  // 同一时刻重复 ensure：不会再开第二条（每连接最多 16 条 stream）
  h.syncer.ensure()
  await tick()
  assertEqual(h.opens, 1, 'ensure 幂等')

  h.emit({ type: 'frame', hasValue: false })
  assertEqual(h.push.baselines.length, 0, 'hasValue:false 的一拍不算数据')

  h.emit({
    type: 'frame',
    hasValue: true,
    value: {
      type: 'baseline',
      value: {
        items: [{ workspaceId: 'ws-1', path: '/a', title: 'a', sessionIds: [] }],
        archivedSessionIds: [],
        pinnedSessionIds: ['s1'],
      },
    },
  })
  assertEqual(h.push.baselines.length, 1, 'baseline 推给了 store')
  assertEqual(h.push.baselines[0]?.pinnedSessionIds, ['s1'], '置顶全集一起带过去')

  h.emit({ type: 'frame', hasValue: true, value: { type: 'workspace/added', workspace: { workspaceId: 'ws-2', path: '/b' } } })
  assertEqual(h.push.deltas, [{ kind: 'upsert', workspace: { workspaceId: 'ws-2', path: '/b', title: '', sessionIds: [] } }], '增量交给 onDelta')
})

check('C2：流被关（closed 帧）→ 摘接收器 + 排重开 → 定时器到点重开后重收 baseline', async () => {
  const h = harness()
  h.syncer.ensure()
  await tick()
  h.emit({
    type: 'frame',
    hasValue: true,
    value: { type: 'baseline', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } },
  })
  assertEqual(h.push.baselines.length, 1, '第一次 baseline')

  h.emit({ type: 'closed', reason: 'peer-disconnected' })
  assertEqual(h.sinksReleased, 1, '接收器被摘掉（off()）')
  assertEqual(h.syncer.isOpen(), false, '流不再算开着')
  assertEqual(h.syncer.isReopenScheduled(), true, '排了一次重开')
  assertEqual(h.push.statuses.at(-1), 'idle', '状态回 idle（列表不清空，由 store 决定展示）')

  h.fireTimers()
  await tick()
  assertEqual(h.opens, 2, '重开成功（第二条流）')
  assertEqual(h.sinksRegistered, 2, '重新注册接收器')
  h.emit({
    type: 'frame',
    hasValue: true,
    value: {
      type: 'baseline',
      value: { items: [{ workspaceId: 'ws-again', path: '/again', title: 'again', sessionIds: [] }], archivedSessionIds: [] },
    },
  })
  assertEqual(h.push.baselines.length, 2, '重开后拿到新的 baseline')
  assertEqual(h.push.baselines[1]?.items.length, 1, '新 baseline 的内容')
})

check('C3：老 Host 的 METHOD_NOT_FOUND → unsupported，不重试、不再开流', async () => {
  const h = harness(['METHOD_NOT_FOUND'])
  h.syncer.ensure()
  await tick()
  assertEqual(h.syncer.status(), 'unsupported', '状态 unsupported')
  assertEqual(h.push.statuses.at(-1), 'unsupported', '把结论推给 store（它据此退回派生列表）')
  assertEqual(h.syncer.isReopenScheduled(), false, '不排重试（老 Host 重试也没用）')

  // 之后无论 ensure 多少次都不再开流
  h.syncer.ensure()
  await tick()
  assertEqual(h.opens, 1, '不再开流')
  // 断线再回来也不该翻案（这一代连接上它就是没有这个端点）
  h.ready = false
  h.syncer.reset()
  h.ready = true
  h.syncer.ensure()
  await tick()
  assertEqual(h.opens, 1, 'reset 之后仍不重试')
  assertEqual(h.syncer.status(), 'unsupported', '状态保持 unsupported')
})

check('C4：网络类开流失败 → 退避重试；断线时不排重试', async () => {
  const h = harness(['RPC_TIMEOUT', 'ok'])
  h.syncer.ensure()
  await tick()
  assertEqual(h.syncer.status(), 'idle', '失败后状态 idle')
  assertEqual(h.syncer.isReopenScheduled(), true, '排了重试')
  assertEqual(h.delayOf, [400], '第一次退避 400ms')

  h.fireTimers()
  await tick()
  assertEqual(h.opens, 2, '第二次开流')
  assertEqual(h.syncer.status(), 'streaming', '这次通了')
  assertEqual(h.delayOf, [400], '通了之后不再排延迟')

  // 断线：reset 后 isReady=false，ensure 什么都不做、也不排定时器
  const offline = harness(['RPC_TIMEOUT'])
  offline.ready = false
  offline.syncer.ensure()
  await tick()
  assertEqual(offline.opens, 0, '没连上就不开流')
  assertEqual(offline.syncer.isReopenScheduled(), false, '也不排重试')

  // 重连之后再 ensure 就能开（重连后重开）
  offline.ready = true
  offline.syncer.ensure()
  await tick()
  assertEqual(offline.opens, 1, '重连后开流')
})

check('C5：reset 关流 + 清定时器；已拿到的 baseline 不被清（由 store 保留列表）', async () => {
  const h = harness()
  h.syncer.ensure()
  await tick()
  h.emit({
    type: 'frame',
    hasValue: true,
    value: { type: 'baseline', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } },
  })
  h.emit({ type: 'closed', reason: 'failed' })
  assertEqual(h.syncer.isReopenScheduled(), true, '关流后挂了重开')

  h.syncer.reset()
  assertEqual(h.syncer.isReopenScheduled(), false, 'reset 清掉了定时器')
  assertEqual(h.syncer.isOpen(), false, '没有流了')
  assertEqual(h.syncer.status(), 'idle', '状态 idle')
  assertEqual(h.push.baselines.length, 1, '已经收到的 baseline 还在 push 的历史里（store 不会清列表）')
})

/* ────────────────────────────────────────────────────────────────────────
 * D. store 集成：baseline / 增量 / 老 Host 回退
 * ──────────────────────────────────────────────────────────────────────── */

const resetStore = (): void => {
  useNewSessionStore.setState({
    open: false,
    loading: false,
    error: null,
    notice: null,
    capabilities: {
      workspace: true,
      workspaceCreate: true,
      create: true,
      directory: true,
      permission: true,
      agentPreset: true,
      model: true,
      search: true,
      manage: true,
    },
    workspaces: [],
    hostWorkspaces: [],
    derivedWorkspaces: [],
    workspaceSource: 'derived',
    workspaceFollow: 'idle',
    rows: [],
    archivedSessionIds: [],
    pinnedSessionIds: [],
    selectedWorkspaceId: null,
    permissionOptions: [],
    permissionDefault: '',
    permissionLoaded: false,
    agentPresets: [],
    agentPresetsLoaded: false,
    selectedAgentPreset: '',
    modelCatalog: null,
    modelCatalogLoaded: false,
    modelPick: null,
    modelApply: { status: 'idle' },
    sheet: null,
    creating: false,
    lastCreatedSessionId: null,
    pathDraft: '',
    pathError: null,
    directory: null,
    directoryLoading: false,
    directoryError: null,
    menuSessionId: null,
    renameTarget: null,
    busySessionId: null,
    actionError: null,
    search: { query: '', searching: false, hits: null, local: false },
  })
}

check('D1：baseline 落到 store —— 没有会话的工作区也进列表，归档 / 置顶换成 Host 全集', async () => {
  resetStore()
  useNewSessionStore.setState({
    // 派生那份（如果有会话的话）；这里模拟「有会话的两个工作区」
    derivedWorkspaces: deriveWorkspacesFromSessions([
      { sessionId: 's1', workspaceId: 'ws-used', cwd: '/home/me/deepseek-tablet', updatedAt: 30 },
      { sessionId: 's2', workspaceId: 'ws-used', cwd: '/home/me/deepseek-tablet', updatedAt: 10 },
    ]),
  })
  useNewSessionStore.getState().applyWorkspaceBaseline({
    items: [
      // follow 只说「有 path」，title 留空 → 由派生 / 路径末段补
      { workspaceId: 'ws-used', path: '/home/me/deepseek-tablet', title: '', sessionIds: ['s1', 's2'] },
      // 没有会话的工作区：旧版派生列表根本列不出它
      { workspaceId: 'ws-empty', path: '/home/me/harness workspace', title: '', sessionIds: [] },
    ],
    archivedSessionIds: ['s-old'],
    pinnedSessionIds: ['s1'],
  })

  const state = useNewSessionStore.getState()
  assertEqual(state.workspaceSource, 'follow', '来源标记 follow')
  assertEqual(state.workspaceFollow, 'streaming', '流状态 streaming')
  assertEqual(state.workspaces.map((item) => item.workspaceId), ['ws-used', 'ws-empty'], '两个工作区（含没有会话的那个）')
  assertEqual(state.workspaces[0]?.title, 'deepseek-tablet', 'title 空 → 由路径补出来')
  assertEqual(state.workspaces[1]?.title, 'harness workspace', '没有会话的工作区也有名字')
  assertEqual(state.workspaces[1]?.sessionIds, [], '它的会话数就是 0')
  assertEqual(state.archivedSessionIds, ['s-old'], '归档全集来自 baseline')
  assertEqual(state.pinnedSessionIds, ['s1'], '置顶全集来自 baseline')
  assertEqual(state.error, null, 'baseline 到了就把错误清掉（静默）')
  assertEqual(state.capabilities.workspace, true, '工作区能力打开')
})

check('D2：增量 upsert / remove 只改 follow 那一份，合并结果跟着变', async () => {
  resetStore()
  useNewSessionStore.getState().applyWorkspaceBaseline({
    items: [{ workspaceId: 'ws-1', path: '/a', title: 'a', sessionIds: [] }],
    archivedSessionIds: [],
    pinnedSessionIds: [],
  })
  useNewSessionStore.getState().applyWorkspaceFrame({
    kind: 'upsert',
    workspace: { workspaceId: 'ws-2', path: '/b', title: 'b', sessionIds: ['s1'] },
  })
  assertEqual(useNewSessionStore.getState().workspaces.map((item) => item.workspaceId), ['ws-1', 'ws-2'], 'upsert 追加')
  assertEqual(useNewSessionStore.getState().workspaces[1]?.sessionIds, ['s1'], '带上了它的会话')

  useNewSessionStore.getState().applyWorkspaceFrame({ kind: 'remove', workspaceId: 'ws-1' })
  assertEqual(useNewSessionStore.getState().workspaces.map((item) => item.workspaceId), ['ws-2'], 'remove 删掉')
  assertEqual(useNewSessionStore.getState().hostWorkspaces.length, 1, 'host 那一份也删了')

  // 删掉的正好是当前选中的：选中态退回「Host 默认」，不留下一个不存在的工作区
  useNewSessionStore.setState({ selectedWorkspaceId: 'ws-2' })
  useNewSessionStore.getState().applyWorkspaceFrame({ kind: 'remove', workspaceId: 'ws-2' })
  assertEqual(useNewSessionStore.getState().selectedWorkspaceId, null, '选中的工作区没了 → 退回 Host 默认')
})

check('D3：老 Host（没有 workspace/follow）→ 退回派生列表，UI 能力位保持 true', async () => {
  resetStore()
  useNewSessionStore.setState({
    hostWorkspaces: [],
    derivedWorkspaces: [
      { workspaceId: 'ws-derived', path: '/home/me/only', title: 'only', sessionIds: ['s1'] },
    ],
    workspaces: [{ workspaceId: 'ws-derived', path: '/home/me/only', title: 'only', sessionIds: ['s1'] }],
    workspaceSource: 'derived',
  })
  useNewSessionStore.getState().setWorkspaceFollowStatus('unsupported', {
    code: 'METHOD_NOT_FOUND',
    message: 'no such endpoint',
    missingEndpoint: true,
  })
  const state = useNewSessionStore.getState()
  assertEqual(state.workspaceFollow, 'unsupported', '状态 unsupported')
  assertEqual(state.capabilities.workspace, true, '**不收起**工作区 UI')
  assertEqual(state.error, null, '降级是静默的（不写红字）')
  assertEqual(state.workspaces.map((item) => item.workspaceId), ['ws-derived'], '派生列表照常可用')
  assertEqual(state.workspaceSource, 'derived', '来源标记 derived')
})

/* ── 假连接：`session/list` 正常，`workspace/follow` 缺端点 ────────────── */

const fakeTarget = (
  handlers: {
    sessionList?: { ok: boolean; value?: unknown; code?: string }
    workspaceFollow?: 'missing' | 'ok'
  } = {},
): { target: RemoteCallTarget; streams: string[] } => {
  const streams: string[] = []
  const target: RemoteCallTarget = {
    rpc: async <T,>(method: string, params?: unknown): Promise<T> => {
      if (method !== 'harness.remote.call') return {} as T
      const endpoint = (params as { endpoint?: string }).endpoint ?? ''
      if (endpoint === 'session/list') {
        const reply = handlers.sessionList ?? { ok: true, value: { items: [] } }
        if (reply.ok) return { ok: true, value: reply.value } as T
        return { ok: false, error: { code: reply.code ?? 'INTERNAL_ERROR', message: reply.code ?? 'x' } } as T
      }
      return { ok: true, value: {} } as T
    },
    openStream: async (endpoint: string): Promise<RemoteStreamHandle> => {
      streams.push(endpoint)
      if (handlers.workspaceFollow === 'missing') {
        const error = new Error('no such endpoint') as Error & { code: string }
        error.code = 'METHOD_NOT_FOUND'
        throw error
      }
      return { streamId: `fake-${streams.length}`, close: async (): Promise<void> => undefined }
    },
  }
  return { target, streams }
}

check('D4：loadInventory 在 workspace/follow 缺端点时仍给出派生列表，且能力不收起', async () => {
  uninstallWorkspaceSync()
  resetStore()
  const fake = fakeTarget({
    workspaceFollow: 'missing',
    sessionList: {
      ok: true,
      value: {
        items: [
          {
            sessionId: 's1',
            updatedAt: 20,
            running: false,
            blank: false,
            cwd: '/home/me/deepseek-tablet',
            projections: { values: { workspaceId: 'ws-1', title: '会话一' } },
          },
          {
            sessionId: 's2',
            updatedAt: 10,
            running: false,
            blank: false,
            cwd: '/home/me/other',
            projections: { values: { workspaceId: 'ws-2', title: '会话二' } },
          },
        ],
      },
    },
  })
  observeRemoteTarget(fake.target)
  useRemoteStore.setState({
    phase: 'ready',
    capabilities: ['harness.remote.v3'],
    sessions: [],
    activeSessionId: null,
    items: [],
    error: null,
    openSession: async () => undefined,
    refreshSessions: async () => undefined,
  })

  await useNewSessionStore.getState().refresh()
  // 开流是异步的：等它把 METHOD_NOT_FOUND 收成 unsupported
  await tick(30)

  const state = useNewSessionStore.getState()
  assertTrue(fake.streams.includes('workspace/follow'), '真的试过 workspace/follow')
  assertEqual(state.workspaceFollow, 'unsupported', '标成老 Host 不支持')
  assertEqual(state.capabilities.workspace, true, '工作区 UI 仍然可用（不收起）')
  assertEqual(state.workspaces.map((item) => item.workspaceId), ['ws-1', 'ws-2'], '派生列表照常给出')
  assertEqual(state.workspaceSource, 'derived', '来源标记 derived')
  uninstallWorkspaceSync()
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
