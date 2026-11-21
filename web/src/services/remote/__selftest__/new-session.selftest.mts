/**
 * 新建会话 / 工作区 / 会话管理（W1）自测。
 *
 * 跑法（workdir = projects\deepseek-tablet\web）：
 *   npx tsx src/services/remote/__selftest__/new-session.selftest.mts
 *
 * 覆盖（对应任务书的四条自测要求 + 端点契约）：
 *   A. `workspace/follow` baseline 解析
 *     1. 正常 baseline：items / archivedSessionIds / pinnedSessionIds 逐字段；
 *     2. 缺 `pinnedSessionIds`（老 Host）→ 空数组；非 baseline 帧 → `null`；
 *     3. 行缺 `workspaceId` 丢掉、`sessionIds` 里的非字符串过滤掉；
 *     4. `deriveWorkspacesFromSessions` 的派生规则（按 workspaceId 归组、取最新 cwd、
 *        剔掉子会话、标题取路径末段）；
 *     5. `normalizeWorkspacePath`：相对路径 / NUL / 空 → `WORKSPACE_PATH_INVALID`，
 *        POSIX / Windows 盘符 / UNC → 通过（input-B §2.1 的绝对路径边界）。
 *   B. `session/create` 的参数形状与老 Host 降级
 *     6. 请求体严格是 `{request:{workspaceId,agentPreset}}`（端点 + 包装一层都不能错）；
 *     7. 老 Host 的 strictCodec 回 `gateway/arguments-invalid` → 自动退回不带 preset 的
 *        第二次调用 + `agentPresets/select`（照 `remote-session-tools.ts:301-342`）；
 *     8. `agentPresets/select` 失败但会话已建出来 → 仍返回 sessionId（preset 只是没生效）；
 *     9. 返回缺 `sessionId` → `INVALID_RESPONSE`；
 *    10. `session/search`：空查询不发请求、>500 字符 → `INVALID_ARGUMENT`。
 *   C. store 级（注入假 target + 假 phase，全程不联网）
 *    11. 连接就绪后 `openPanel()`：工作区 / 权限目录 / agent preset / 默认模型都进 state；
 *    12. `createAndOpen()`：`session/create` 带 workspaceId，权限预设走 `/permission <preset>`，
 *        最后 `openSession(newId)`；
 *    13. 能力缺失（一律 `METHOD_NOT_FOUND`）：所有能力关掉、`createAndOpen()` 不发 create；
 *    14. 搜索本地回退：远端 `gateway/internal` ⇒ `search.local === true` 且命中来自标题。
 *   D. 会话管理端点
 *    15. 归档 / 取消归档 / 置顶 / 取消置顶 的端点、参数与「整套 id 列表」覆盖；
 *    16. `session/rename` 返回标题覆盖本地行；`session/fork` 的端点与 `openSession` 收尾。
 *
 * 结尾按仓库约定设置真实退出码（`pnpm run type` 之外的一道闸）。
 */

import {
  archiveSession,
  createSession,
  fetchAgentPresets,
  fetchDefaultModel,
  fetchPermissionCatalog,
  forkSession,
  lastRemoteTarget,
  listDirectory,
  normalizeWorkspacePath,
  observeRemoteTarget,
  parseWorkspaceBaseline,
  pinSession,
  searchSessions,
  unpinSession,
  unarchiveSession,
  type RemoteCallTarget,
  type RemoteStreamHandle,
} from '../sessionsApi.js'
import {
  deriveWorkspacesFromSessions,
  filterSessionsLocally,
  toSessionListRow,
  useNewSessionStore,
  workspaceTitleFromPath,
} from '../newSessionStore.js'
import { useRemoteStore } from '../store.js'

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

const assertThrowsCode = async (run: () => Promise<unknown>, code: string, label: string): Promise<void> => {
  try {
    await run()
  } catch (error) {
    const actual = (error as { code?: unknown }).code
    if (actual !== code) fail(`${label}：期望错误码 ${code}，实际 ${String(actual)}`)
    return
  }
  fail(`${label}：没有抛错（期望 ${code}）`)
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

/* ── 假 target：记录每一次 `harness.remote.call` / `stream.open` ─────── */

interface RecordedCall {
  method: string
  params: unknown
}

/** 一个端点的应答：`ok` 包成官方 envelope，`fail` 包成官方 error envelope。 */
type Reply =
  | { ok: true; value?: unknown }
  | { ok: false; code: string; message?: string }

interface FakeTarget {
  target: RemoteCallTarget
  calls: RecordedCall[]
  /** 按端点出应答；没配置的端点回 `{ok:true,value:{}}`。 */
  replyOf(endpoint: string): Reply
  streams: string[]
}

const fakeTarget = (replies: Record<string, Reply | ((args: unknown, call: number) => Reply)> = {}): FakeTarget => {
  const calls: RecordedCall[] = []
  const streams: string[] = []
  const seen = new Map<string, number>()
  const state: FakeTarget = {
    calls,
    streams,
    target: {
      rpc: async <T,>(method: string, params?: unknown): Promise<T> => {
        calls.push({ method, params })
        if (method !== 'harness.remote.call') {
          // 顶层方法：本批只发 `harness.remote.call`
          return {} as T
        }
        const envelope = params as { endpoint: string; payload: { args: unknown } }
        const endpoint = envelope.endpoint
        const count = (seen.get(endpoint) ?? 0) + 1
        seen.set(endpoint, count)
        const configured = replies[endpoint]
        const reply: Reply = configured === undefined
          ? { ok: true, value: {} }
          : typeof configured === 'function' ? configured(envelope.payload.args, count) : configured
        if (reply.ok) return (reply.value === undefined ? { ok: true } : { ok: true, value: reply.value }) as T
        return {
          ok: false,
          error: { code: reply.code, message: reply.message ?? reply.code },
        } as T
      },
      openStream: async (endpoint: string): Promise<RemoteStreamHandle> => {
        streams.push(endpoint)
        return {
          streamId: `stream-${endpoint}-${streams.length}`,
          close: async (): Promise<void> => undefined,
        }
      },
    },
    replyOf: (endpoint: string): Reply => {
      const configured = replies[endpoint]
      if (configured === undefined) return { ok: true, value: {} }
      return typeof configured === 'function' ? configured(undefined, 1) : configured
    },
  }
  return state
}

/** 取出第 n 次 `harness.remote.call` 的 `{endpoint, args}`（断言参数形状用）。 */
const callAt = (
  fake: FakeTarget,
  index: number,
): { endpoint: string; args: Record<string, unknown> } => {
  const call = fake.calls[index]
  if (call === undefined) return fail(`第 ${index} 次调用不存在（共 ${fake.calls.length} 次）`)
  const params = call.params as { endpoint: string; payload: { args: Record<string, unknown> } }
  return { endpoint: params.endpoint, args: params.payload.args }
}

/** 端点出现次数（判断「没有发请求」）。 */
const endpointCount = (fake: FakeTarget, endpoint: string): number =>
  fake.calls.filter((call) => (call.params as { endpoint?: string }).endpoint === endpoint).length

/** 把 store 拨到「已连接 + 有这个 target」的状态，并吞掉会打网络的 action。 */
const connectFake = (
  fake: FakeTarget,
  options: { sessionList?: unknown[] } = {},
): { opened: string[]; refreshed: number[] } => {
  const opened: string[] = []
  const refreshed: number[] = []
  observeRemoteTarget(fake.target)
  useRemoteStore.setState({
    phase: 'ready',
    capabilities: ['harness.remote.v3'],
    sessions: [],
    activeSessionId: null,
    items: [],
    error: null,
    openSession: async (id: string) => {
      opened.push(id)
    },
    refreshSessions: async () => {
      refreshed.push(Date.now())
    },
  })
  if (options.sessionList !== undefined) {
    // 用 session/list 的行喂给 store 的列表投影（`ensureWorkspaceFlags` 读的是它）
    useRemoteStore.setState({ sessions: [] })
  }
  return { opened, refreshed }
}

const resetNewSession = (): void => {
  useNewSessionStore.setState({
    open: false,
    loading: false,
    error: null,
    notice: null,
    workspaces: [],
    workspaceSource: 'derived',
    rows: [],
    archivedSessionIds: [],
    pinnedSessionIds: [],
    selectedWorkspaceId: null,
    selectedPermission: '',
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
    createdSessionId: null,
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
    capabilities: {
      workspace: true,
      create: true,
      directory: true,
      permission: true,
      agentPreset: true,
      model: true,
      search: true,
      manage: true,
    },
  })
}

/* ────────────────────────────────────────────────────────────────────────
 * A. workspace/follow baseline 与工作区派生
 * ──────────────────────────────────────────────────────────────────────── */

check('A1/A2：workspace/follow 首帧 baseline 逐字段解析，非 baseline 一律 null', async () => {
  const baseline = parseWorkspaceBaseline({
    type: 'baseline',
    value: {
      items: [
        {
          workspaceId: 'ws-1',
          path: '/home/me/code/dsh',
          title: 'dsh',
          sessionIds: ['s1', 's2'],
          createdAt: '2026-11-01T00:00:00.000Z',
          updatedAt: '2026-11-02T00:00:00.000Z',
        },
        { workspaceId: 'ws-2', path: '', title: '', sessionIds: [] },
      ],
      archivedSessionIds: ['s9'],
      pinnedSessionIds: ['s1'],
    },
  })
  assertEqual(baseline?.items.length, 2, '两个工作区')
  assertEqual(baseline?.items[0]?.workspaceId, 'ws-1', '第一行 workspaceId')
  assertEqual(baseline?.items[0]?.path, '/home/me/code/dsh', '第一行 path')
  assertEqual(baseline?.items[0]?.sessionIds, ['s1', 's2'], '第一行 sessionIds')
  assertEqual(baseline?.items[0]?.createdAt, '2026-11-01T00:00:00.000Z', '第一行 createdAt')
  assertEqual(baseline?.archivedSessionIds, ['s9'], '归档全集')
  assertEqual(baseline?.pinnedSessionIds, ['s1'], '置顶全集')

  // 老 Host 没有 pinnedSessionIds / archivedSessionIds
  const bare = parseWorkspaceBaseline({ type: 'baseline', value: { items: [] } })
  assertEqual(bare?.pinnedSessionIds, [], '缺 pinnedSessionIds → 空数组')
  assertEqual(bare?.archivedSessionIds, [], '缺 archivedSessionIds → 空数组')

  // 帧形状不对：不能把半截数据画到界面上
  assertEqual(parseWorkspaceBaseline({ type: 'workspace', value: { items: [] } }), null, '非 baseline 帧')
  assertEqual(parseWorkspaceBaseline({ type: 'baseline' }), null, '缺 value')
  assertEqual(parseWorkspaceBaseline(null), null, 'null 帧')
})

check('A3：坏行丢掉、非字符串 id 过滤', async () => {
  const parsed = parseWorkspaceBaseline({
    type: 'baseline',
    value: {
      items: [
        { path: '/no-id', title: 'x', sessionIds: [] },
        { workspaceId: '', path: '/empty-id', sessionIds: [] },
        { workspaceId: 'ws-ok', path: '/ok', title: 'ok', sessionIds: ['a', 42, null, 'b'] },
      ],
      archivedSessionIds: ['s1', 7, null],
    },
  })
  assertEqual(parsed?.items.length, 1, '只留有一行的合法的')
  assertEqual(parsed?.items[0]?.workspaceId, 'ws-ok', '留下的是 ws-ok')
  assertEqual(parsed?.items[0]?.sessionIds, ['a', 'b'], 'sessionIds 过滤非字符串')
  assertEqual(parsed?.archivedSessionIds, ['s1'], 'archivedSessionIds 过滤非字符串')
})

check('A4：deriveWorkspacesFromSessions 的归组 / 最新 cwd / 剔子会话规则', async () => {
  const derived = deriveWorkspacesFromSessions([
    { sessionId: 's1', workspaceId: 'ws-a', cwd: '/old/a', updatedAt: 100 },
    { sessionId: 's2', workspaceId: 'ws-a', cwd: '/new/a', updatedAt: 300 },
    { sessionId: 's3', workspaceId: 'ws-b', cwd: 'C:\\code\\b', updatedAt: 200 },
    // 子会话不进工作区的会话清单
    { sessionId: 's4', workspaceId: 'ws-a', cwd: '/new/a', updatedAt: 400, parentSessionId: 's2' },
    // 没有 workspaceId 的行不参与派生
    { sessionId: 's5', cwd: '/orphan', updatedAt: 500 },
  ])
  assertEqual(derived.map((item) => item.workspaceId).sort(), ['ws-a', 'ws-b'], '两个工作区')
  const a = derived.find((item) => item.workspaceId === 'ws-a')
  assertEqual(a?.path, '/new/a', 'A 的路径取最新一行的 cwd')
  assertEqual(a?.sessionIds, ['s2', 's1'], 'A 的会话按 updatedAt 倒序')
  assertEqual(a?.title, 'a', 'A 的标题取路径末段')
  const b = derived.find((item) => item.workspaceId === 'ws-b')
  assertEqual(b?.path, 'C:\\code\\b', 'Windows 路径原样保留')
  assertEqual(b?.title, 'b', 'Windows 路径末段')

  assertEqual(workspaceTitleFromPath('/'), '/', 'POSIX 根')
  assertEqual(workspaceTitleFromPath('/home/me/'), 'me', '尾部斜杠')
  assertEqual(workspaceTitleFromPath('C:\\'), 'C:', '盘符根')
})

check('A5：normalizeWorkspacePath 只放绝对路径、拒 NUL / 空 / 相对路径', async () => {
  assertEqual(normalizeWorkspacePath('  /home/me/code  '), '/home/me/code', 'POSIX 绝对路径（去空白）')
  assertEqual(normalizeWorkspacePath('C:\\code\\x'), 'C:\\code\\x', 'Windows 盘符')
  assertEqual(normalizeWorkspacePath('\\\\server\\share'), '\\\\server\\share', 'UNC')
  await assertThrowsCode(async () => normalizeWorkspacePath(''), 'WORKSPACE_PATH_INVALID', '空路径')
  await assertThrowsCode(async () => normalizeWorkspacePath('   '), 'WORKSPACE_PATH_INVALID', '全空白')
  await assertThrowsCode(async () => normalizeWorkspacePath('relative/dir'), 'WORKSPACE_PATH_INVALID', '相对路径')
  await assertThrowsCode(async () => normalizeWorkspacePath('/tmp/\u0000x'), 'WORKSPACE_PATH_INVALID', '含 NUL')
})

/* ────────────────────────────────────────────────────────────────────────
 * B. session/create 参数形状与降级
 * ──────────────────────────────────────────────────────────────────────── */

check('B6：session/create 的请求体严格是 {request:{workspaceId,agentPreset}}', async () => {
  const fake = fakeTarget({ 'session/create': { ok: true, value: { sessionId: 'new-1', agentPreset: 'work' } } })
  const created = await createSession(fake.target, { workspaceId: 'ws-1', agentPreset: 'work' })
  assertEqual(created, { sessionId: 'new-1', agentPreset: 'work' }, '返回值')
  const call = callAt(fake, 0)
  assertEqual(call.endpoint, 'session/create', '端点')
  assertEqual(call.args, { request: { workspaceId: 'ws-1', agentPreset: 'work' } }, 'args 形状')
  assertEqual(lastRemoteTarget(), fake.target, '调用被观察者记下来了（newSessionStore 靠它取连接）')
})

check('B7：老 Host 的 gateway/arguments-invalid → 去掉 preset 重试 + agentPresets/select', async () => {
  const fake = fakeTarget({
    'session/create': (_args, count) => count === 1
      ? { ok: false, code: 'gateway/arguments-invalid', message: 'unexpected property agentPreset' }
      : { ok: true, value: { sessionId: 'new-2' } },
    'agentPresets/select': { ok: true, value: 'work' },
  })
  const created = await createSession(fake.target, { workspaceId: 'ws-1', agentPreset: 'work' })
  assertEqual(created.sessionId, 'new-2', '第二次调用建出了会话')
  assertEqual(created.agentPreset, 'work', 'preset 通过 agentPresets/select 补上')
  assertEqual(callAt(fake, 0).args, { request: { workspaceId: 'ws-1', agentPreset: 'work' } }, '第一次带 preset')
  assertEqual(callAt(fake, 1).args, { request: { workspaceId: 'ws-1' } }, '第二次不带 preset')
  assertEqual(callAt(fake, 2).endpoint, 'agentPresets/select', '第三个请求是 agentPresets/select')
  assertEqual(callAt(fake, 2).args, { agentId: 'new-2', agentPreset: 'work' }, 'select 的参数')
})

check('B8：agentPresets/select 失败不影响「会话已建好」这个事实', async () => {
  const fake = fakeTarget({
    'session/create': { ok: true, value: { sessionId: 'new-3' } },
    'agentPresets/select': { ok: false, code: 'PRESET_LOCKED', message: 'session already started' },
  })
  const created = await createSession(fake.target, { workspaceId: 'ws-1', agentPreset: 'ptc' })
  assertEqual(created.sessionId, 'new-3', 'sessionId 仍然返回')
  // 没回显 preset 且 select 失败 ⇒ 不许谎报 preset 生效
  assertEqual(created.agentPreset, undefined, 'preset 没有被误报为生效')
})

check('B9/B10：返回缺 sessionId → INVALID_RESPONSE；session/search 的入参边界', async () => {
  const broken = fakeTarget({ 'session/create': { ok: true, value: { agentPreset: 'x' } } })
  await assertThrowsCode(
    async () => createSession(broken.target, { workspaceId: 'ws-1' }),
    'INVALID_RESPONSE',
    '缺 sessionId',
  )

  const empty = fakeTarget()
  assertEqual(await searchSessions(empty.target, '   '), { items: [], hasMore: false }, '空查询直接返回')
  assertEqual(empty.calls.length, 0, '空查询不发请求')

  const tooLong = fakeTarget()
  await assertThrowsCode(
    async () => searchSessions(tooLong.target, 'x'.repeat(501)),
    'INVALID_ARGUMENT',
    '>500 字符',
  )
  assertEqual(tooLong.calls.length, 0, '超长查询不发请求')

  const ok = fakeTarget({
    'session/search': { ok: true, value: { items: [{ sessionId: 's1', snippet: '…工具卡…' }, { bad: 1 }], hasMore: true } },
  })
  const result = await searchSessions(ok.target, ' 工具卡 ')
  assertEqual(callAt(ok, 0).args, { request: { query: '工具卡' } }, 'query 去空白')
  assertEqual(result, { items: [{ sessionId: 's1', snippet: '…工具卡…' }], hasMore: true }, '坏行丢掉')
})

/* ────────────────────────────────────────────────────────────────────────
 * C. store 级：加载 / 创建 / 能力缺失 / 搜索回退
 * ──────────────────────────────────────────────────────────────────────── */

/** 一套「什么都有」的假 Host 应答（含一条已归档、一条置顶的会话）。 */
const FULL_REPLIES: Record<string, Reply> = {
  'session/list': {
    ok: true,
    value: {
      items: [
        {
          sessionId: 's-1',
          updatedAt: 300,
          running: false,
          blank: false,
          projections: { values: { title: '工具卡看不清', workspaceId: 'ws-1', pinned: true } },
          cwd: '/home/me/code/dsh',
          agentPreset: 'ptc',
        },
        {
          sessionId: 's-2',
          updatedAt: 200,
          running: false,
          blank: false,
          projections: { values: { title: '新建会话要能做', workspaceId: 'ws-1' } },
          cwd: '/home/me/code/dsh',
        },
        {
          sessionId: 's-3',
          updatedAt: 100,
          running: false,
          blank: true,
          title: '另一个工作区',
          projections: { values: { workspaceId: 'ws-2' } },
          cwd: 'C:\\code\\other',
        },
      ],
    },
  },
  'permissionPresets/catalog': {
    ok: true,
    value: { options: [{ value: 'default', name: '默认' }, { value: 'danger-full-access', name: '完全放开' }], defaultPreset: 'default' },
  },
  'agentPresets/list': { ok: true, value: { presets: [{ id: 'ptc', name: 'PTC' }, { id: 'work', name: '工作模式' }] } },
  'session/modelCatalog': {
    ok: true,
    value: {
      default: { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'high' },
      groups: [
        {
          id: 'deepseek',
          name: 'DeepSeek',
          models: [
            {
              id: 'deepseek-v4',
              name: 'DeepSeek-V4',
              description: '通用',
              reasoning: {
                efforts: [
                  { id: 'low', name: '低' },
                  { id: 'high', name: '高' },
                  { id: 'max', name: '最高' },
                ],
                defaultEffort: 'high',
              },
            },
            { id: 'deepseek-v4-mini', name: 'DeepSeek-V4 Mini' },
          ],
        },
        {
          id: 'openai',
          name: 'OpenAI',
          models: [{ id: 'gpt-x', name: 'GPT X', reasoning_options: ['off', 'low', 'medium'] }],
        },
      ],
    },
  },
  'session/create': { ok: true, value: { sessionId: 's-new', agentPreset: 'work' } },
  'session/selectModel': {
    ok: true,
    value: { selected: { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'max' }, defaultSave: { status: 'saved' } },
  },
  'commands/execute': { ok: true, value: { result: { kind: 'success' } } },
}

check('C11：连接就绪后 refresh() 把工作区 / 预设 / 模型目录都装进 state', async () => {
  resetNewSession()
  const fake = fakeTarget(FULL_REPLIES)
  connectFake(fake)
  await useNewSessionStore.getState().refresh()

  const state = useNewSessionStore.getState()
  assertEqual(state.workspaces.map((item) => item.workspaceId), ['ws-1', 'ws-2'], '工作区由会话派生')
  assertEqual(state.workspaceSource, 'derived', '来源标记为 derived（没有 baseline reader）')
  assertEqual(state.rows.length, 3, '会话清单进了 rows')
  assertEqual(state.permissionOptions.map((option) => option.value), ['default', 'danger-full-access'], '权限选项')
  assertEqual(state.permissionDefault, 'default', 'Host 默认预设')
  assertEqual(state.agentPresets.map((preset) => preset.id), ['ptc', 'work'], 'agent preset 名册')
  assertEqual(state.modelCatalog?.default, { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'high' }, '默认模型')
  assertEqual(state.modelCatalog?.models.map((model) => `${model.provider}/${model.id}`), [
    'deepseek/deepseek-v4',
    'deepseek/deepseek-v4-mini',
    'openai/gpt-x',
  ], '模型目录摊平成一行行')
  assertEqual(
    state.modelCatalog?.models[0]?.efforts.map((effort) => effort.id),
    ['low', 'high', 'max'],
    '思考强度来自 reasoning.efforts',
  )
  assertEqual(state.modelCatalog?.models[0]?.defaultEffort, 'high', '模型的默认档位')
  // 老字段名 `reasoning_options` 也认（裸字符串数组）
  assertEqual(state.modelCatalog?.models[2]?.efforts.map((effort) => effort.id), ['off', 'low', 'medium'], 'reasoning_options 兼容')
  assertEqual(state.modelPick, null, '默认继承 Host（不产生写操作）')
  assertEqual(state.capabilities.model, true, '模型能力打开')
  assertEqual(state.capabilities.create, true, 'create 能力按「先信任」打开')
  assertTrue(fake.streams.includes('workspace/follow'), '探测过 workspace/follow（能力探测）')
  assertEqual(state.selectedWorkspaceId, null, '多个工作区时不替用户选')
  assertEqual(state.error, null, '没有残留错误')
})

check('C12：createAndOpen 走 session/create → /permission → selectModel → openSession(newId)', async () => {
  resetNewSession()
  const fake = fakeTarget(FULL_REPLIES)
  const observed = connectFake(fake)
  await useNewSessionStore.getState().refresh()

  useNewSessionStore.getState().selectWorkspace('ws-1')
  useNewSessionStore.getState().selectAgentPreset('work')
  useNewSessionStore.getState().selectPermission('danger-full-access')
  useNewSessionStore.getState().pickModel('deepseek', 'deepseek-v4', 'max')

  const created = await useNewSessionStore.getState().createAndOpen()
  assertEqual(created, 's-new', '返回新会话 id')

  const createCall = callAt(fake, fake.calls.findIndex((call) => (call.params as { endpoint?: string }).endpoint === 'session/create'))
  assertEqual(createCall.args, { request: { workspaceId: 'ws-1', agentPreset: 'work' } }, 'session/create 的参数（**没有** model 字段）')

  const commandCall = fake.calls
    .map((call) => call.params as { endpoint?: string; payload?: { args?: Record<string, unknown> } })
    .find((params) => params.endpoint === 'commands/execute')
  assertEqual(commandCall?.payload?.args, {
    agentId: 's-new',
    line: '/permission danger-full-access',
    submittedAttachments: [],
  }, '权限预设走 /permission 斜杠命令')

  const modelCall = callAt(
    fake,
    fake.calls.findIndex((call) => (call.params as { endpoint?: string }).endpoint === 'session/selectModel'),
  )
  assertEqual(modelCall.args, {
    request: { sessionId: 's-new', provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'max' },
  }, '模型 + 思考强度走 session/selectModel')

  assertEqual(observed.opened, ['s-new'], '建完就进会话')
  assertEqual(useNewSessionStore.getState().open, false, '建完关面板')
  assertEqual(useNewSessionStore.getState().lastCreatedSessionId, 's-new', '记住新建的 id')
  assertEqual(useNewSessionStore.getState().modelApply.status, 'idle', '模型应用成功')
  assertEqual(useNewSessionStore.getState().modelApply.via, 'select', '先走 selectModel')
})

check('C13：能力缺失时整块关掉，createAndOpen 一个 create 请求都不发', async () => {
  resetNewSession()
  const missing: Record<string, Reply> = {
    'session/list': { ok: false, code: 'METHOD_NOT_FOUND', message: 'no such endpoint' },
    'workspace/follow': { ok: false, code: 'METHOD_NOT_FOUND', message: 'no such endpoint' },
  }
  // 开流本身也要能被拒：这里让 openStream 抛 METHOD_NOT_FOUND
  const fake = fakeTarget(missing)
  fake.target.openStream = async (): Promise<RemoteStreamHandle> => {
    const error = new Error('no such endpoint') as Error & { code: string }
    error.code = 'METHOD_NOT_FOUND'
    throw error
  }
  const observed = connectFake(fake)
  await useNewSessionStore.getState().refresh()

  const state = useNewSessionStore.getState()
  assertEqual(state.capabilities.create, false, 'create 能力关掉')
  assertEqual(state.capabilities.workspace, false, '工作区能力关掉（UI 隐藏下拉）')
  assertEqual(state.workspaces, [], '没有工作区数据')
  assertTrue(state.error !== null, '面板里留一行说明（不是弹窗）')

  // UI 里「创建并进入」按钮此时是 disabled 的，点了也不该发请求
  const created = await useNewSessionStore.getState().createAndOpen()
  assertEqual(created, null, '不创建')
  assertEqual(endpointCount(fake, 'session/create'), 0, '没有发 session/create')
  assertEqual(observed.opened, [], '没有打开任何会话')
})

check('C14：远端搜索不可用 → 本地按标题匹配，并把 search 能力标 false', async () => {
  resetNewSession()
  const fake = fakeTarget({
    ...FULL_REPLIES,
    'session/search': { ok: false, code: 'gateway/internal', message: 'session search is disabled' },
  })
  connectFake(fake)
  await useNewSessionStore.getState().refresh()

  await useNewSessionStore.getState().runSearch('工具')
  const state = useNewSessionStore.getState()
  assertEqual(state.capabilities.search, false, '远端搜索能力关掉')
  assertEqual(state.search.local, true, '标记为本地命中')
  assertEqual(state.search.hits, [{ sessionId: 's-1', snippet: '工具卡看不清' }], '本地按标题命中')

  // 本地过滤本身：剔子会话、按标题/会话 id 匹配、忽略空白查询
  const rows = [
    { sessionId: 'a', title: 'Hello World' },
    { sessionId: 'b', title: '别的' },
    { sessionId: 'c', title: 'sub', parentSessionId: 'a' },
  ].map((row) => toSessionListRow(row as never))
  assertEqual(filterSessionsLocally(rows, 'hello').map((hit) => hit.sessionId), ['a'], '大小写不敏感的标题匹配')
  // 子会话一律不进列表，哪怕它的 id 正好命中查询词
  assertEqual(filterSessionsLocally(rows, 'c'), [], '子会话被剔掉')
  assertEqual(filterSessionsLocally(rows, '   '), [], '空白查询没有命中')
})

/* ────────────────────────────────────────────────────────────────────────
 * D. 会话管理端点
 * ──────────────────────────────────────────────────────────────────────── */

check('D15：归档 / 取消归档 / 置顶 / 取消置顶的端点、参数与全集覆盖', async () => {
  resetNewSession()
  const fake = fakeTarget({
    ...FULL_REPLIES,
    'workspace/archiveSession': { ok: true, value: { archivedSessionIds: ['s-2', 's-3'] } },
    'workspace/unarchiveSession': { ok: true, value: { archivedSessionIds: ['s-3'] } },
    'workspace/pinSession': { ok: true, value: { pinnedSessionIds: ['s-1', 's-2'] } },
    'workspace/unpinSession': { ok: true, value: { pinnedSessionIds: ['s-2'] } },
  })
  connectFake(fake)
  await useNewSessionStore.getState().refresh()

  await useNewSessionStore.getState().toggleArchive('s-2')
  assertEqual(
    callAt(fake, fake.calls.findIndex((call) => (call.params as { endpoint?: string }).endpoint === 'workspace/archiveSession')).args,
    { request: { sessionId: 's-2' } },
    '归档参数',
  )
  assertEqual(useNewSessionStore.getState().archivedSessionIds, ['s-2', 's-3'], '归档全集覆盖本地')

  await useNewSessionStore.getState().toggleArchive('s-2')
  assertEqual(useNewSessionStore.getState().archivedSessionIds, ['s-3'], '取消归档后自成全集')

  await useNewSessionStore.getState().togglePin('s-2')
  assertEqual(
    callAt(fake, fake.calls.findIndex((call) => (call.params as { endpoint?: string }).endpoint === 'workspace/pinSession')).args,
    { request: { sessionId: 's-2' } },
    '置顶参数',
  )
  assertEqual(useNewSessionStore.getState().pinnedSessionIds, ['s-1', 's-2'], '置顶全集覆盖本地')

  await useNewSessionStore.getState().togglePin('s-2')
  assertEqual(useNewSessionStore.getState().pinnedSessionIds, ['s-2'], '取消置顶后自成全集')

  // 直接调 API 的那几个也各断言一次参数形状
  const direct = fakeTarget({
    'workspace/archiveSession': { ok: true, value: { archivedSessionIds: ['x'] } },
    'workspace/unarchiveSession': { ok: true, value: { archivedSessionIds: [] } },
    'workspace/pinSession': { ok: true, value: { pinnedSessionIds: ['x'] } },
    'workspace/unpinSession': { ok: true, value: { pinnedSessionIds: [] } },
  })
  await archiveSession(direct.target, 's-1', { stopActivity: true })
  assertEqual(callAt(direct, 0).args, { request: { sessionId: 's-1', stopActivity: true } }, 'archive stopActivity')
  await unarchiveSession(direct.target, 's-1')
  assertEqual(callAt(direct, 1).args, { request: { sessionId: 's-1' } }, 'unarchive 参数')
  await pinSession(direct.target, 's-1')
  assertEqual(callAt(direct, 2).args, { request: { sessionId: 's-1' } }, 'pin 参数')
  await unpinSession(direct.target, 's-1')
  assertEqual(callAt(direct, 3).args, { request: { sessionId: 's-1' } }, 'unpin 参数')
})

check('D16：session/rename 覆盖本地标题；session/fork 建完直接进会话', async () => {
  resetNewSession()
  const fake = fakeTarget({
    ...FULL_REPLIES,
    'session/rename': { ok: true, value: { title: '改了名字', seq: 12 } },
    'session/fork': { ok: true, value: { sessionId: 's-fork' } },
  })
  const observed = connectFake(fake)
  await useNewSessionStore.getState().refresh()

  useNewSessionStore.getState().beginRename('s-2', '旧标题')
  useNewSessionStore.getState().updateRenameDraft('  改了名字  ')
  await useNewSessionStore.getState().commitRename()

  assertEqual(
    callAt(fake, fake.calls.findIndex((call) => (call.params as { endpoint?: string }).endpoint === 'session/rename')).args,
    { request: { sessionId: 's-2', title: '改了名字' } },
    'rename 参数（去首尾空白）',
  )
  const renamed = useNewSessionStore.getState().rows.find((row) => row.sessionId === 's-2')
  assertEqual(renamed?.title, '改了名字', '本地行标题被 Host 返回覆盖')
  assertEqual(useNewSessionStore.getState().renameTarget, null, '弹窗关掉')

  await useNewSessionStore.getState().fork('s-1')
  assertEqual(
    callAt(fake, fake.calls.findIndex((call) => (call.params as { endpoint?: string }).endpoint === 'session/fork')).args,
    { request: { sessionId: 's-1' } },
    'fork 参数（不给 atSeq 就是最近一轮）',
  )
  assertEqual(observed.opened, ['s-fork'], '派生完直接进新会话')

  const forked = await forkSession(fake.target, 's-1')
  assertEqual(forked, 's-fork', 'forkSession 返回新 id')
})

check('C18：probeCapabilities 先等连接对象出现，再一次性把能力打开（空态按钮靠它）', async () => {
  resetNewSession()
  // 连接对象还没被任何业务调用记下来（`store.ts` 里 phase=ready 早于第一次业务调用）
  observeRemoteTarget(null)
  useRemoteStore.setState({ phase: 'ready', openSession: async () => undefined, refreshSessions: async () => undefined })
  useNewSessionStore.setState({ capabilities: { workspace: false, create: false, directory: false, permission: false, agentPreset: false, model: false, search: false, manage: false } })

  const fake = fakeTarget(FULL_REPLIES)
  // 150ms 后才「出现」连接对象（模拟 $events / session/list 稍后才发出）
  const timer = setTimeout(() => {
    observeRemoteTarget(fake.target)
  }, 150)
  try {
    await useNewSessionStore.getState().probeCapabilities()
  } finally {
    clearTimeout(timer)
  }
  const state = useNewSessionStore.getState()
  assertEqual(state.rows.length, 3, '等到连接对象后拉到了清单')
  assertEqual(state.capabilities.create, true, '能力被打开（按钮才会出现）')
  assertTrue(endpointCount(fake, 'session/list') >= 1, '真的发过 session/list')

  // 完全没有连接（phase 不对）→ 静默放弃，能力保持关闭，不抛
  observeRemoteTarget(null)
  useRemoteStore.setState({ phase: 'idle' })
  resetNewSession()
  useNewSessionStore.setState({
    capabilities: { workspace: false, create: false, directory: false, permission: false, agentPreset: false, model: false, search: false, manage: false },
  })
  const startedAt = Date.now()
  await useNewSessionStore.getState().probeCapabilities()
  assertTrue(Date.now() - startedAt < 1_000, '没连接时不空转（立即收工）')
  assertEqual(useNewSessionStore.getState().capabilities.create, false, '没连接时能力保持关闭')
  assertEqual(useNewSessionStore.getState().rows, [], '没有清单')
})

check('D17：可选端点的解析（目录 / 权限目录 / agent preset / 默认模型）', async () => {
  const listing = fakeTarget({
    'directoryPicker/list': {
      ok: true,
      value: {
        path: '/home/me',
        home: '/home/me',
        entries: [{ name: 'code', path: '/home/me/code' }, { name: 'dark', path: '/home/me/.config', hidden: true }, { bad: 1 }],
        truncated: true,
      },
    },
  })
  assertEqual(await listDirectory(listing.target), {
    path: '/home/me',
    home: '/home/me',
    entries: [
      { name: 'code', path: '/home/me/code', hidden: false },
      { name: 'dark', path: '/home/me/.config', hidden: true },
    ],
    truncated: true,
  }, '目录列表解析')
  assertEqual(callAt(listing, 0).args, {}, '不传 path = 家目录（args 是空对象）')
  await listDirectory(listing.target, '/tmp')
  assertEqual(callAt(listing, 1).args, { path: '/tmp' }, '传了 path 就带上')

  const catalog = fakeTarget({
    'permissionPresets/catalog': { ok: true, value: { options: [{ value: 'default', name: '默认' }, { value: 42 }] } },
    'agentPresets/list': { ok: true, value: { presets: [{ id: 'ptc', isDefault: true }, { name: 'no-id' }] } },
    'session/modelCatalog': { ok: true, value: { default: { provider: 'x' } } },
  })
  assertEqual((await fetchPermissionCatalog(catalog.target)).options, [{ value: 'default', name: '默认' }], '权限目录过滤坏行')
  assertEqual((await fetchAgentPresets(catalog.target)).map((preset) => preset.id), ['ptc'], 'agent preset 过滤坏行')
  assertEqual(await fetchDefaultModel(catalog.target), null, '默认模型缺 model → null')
})

/* ────────────────────────────────────────────────────────────────────────
 * E. 模型 + 思考强度：建完之后怎么应用（本轮新增）
 * ──────────────────────────────────────────────────────────────────────── */

check('E19：selectModel 不可用 → 退回 initializeDefaultModel，会话照样进得去', async () => {
  resetNewSession()
  const fake = fakeTarget({
    ...FULL_REPLIES,
    'session/selectModel': { ok: false, code: 'METHOD_NOT_FOUND', message: 'no such endpoint' },
    'session/initializeDefaultModel': {
      ok: true,
      value: { selected: { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'max' } },
    },
  })
  const observed = connectFake(fake)
  await useNewSessionStore.getState().refresh()
  useNewSessionStore.getState().pickModel('deepseek', 'deepseek-v4', 'max')

  assertEqual(await useNewSessionStore.getState().createAndOpen(), 's-new', '仍然建成功')
  assertEqual(endpointCount(fake, 'session/selectModel'), 1, '先试了 selectModel')
  assertEqual(endpointCount(fake, 'session/initializeDefaultModel'), 1, '再退到 initializeDefaultModel')
  assertEqual(
    callAt(fake, fake.calls.findIndex((call) => (call.params as { endpoint?: string }).endpoint === 'session/initializeDefaultModel')).args,
    { request: { sessionId: 's-new', provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'max' } },
    'initializeDefaultModel 的参数形状',
  )
  assertEqual(useNewSessionStore.getState().modelApply.via, 'initialize', '记住走的是哪条路')
  assertEqual(observed.opened, ['s-new'], '照常进会话')
})

check('E20：两条模型路都失败 → 失败可见（面板停住）+ 跳过 / 重试 两条出路', async () => {
  resetNewSession()
  let selectModelOk = false
  const fake = fakeTarget({
    ...FULL_REPLIES,
    'session/selectModel': () => (selectModelOk
      ? { ok: true, value: { selected: { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'max' }, defaultSave: { status: 'saved' } } }
      : { ok: false, code: 'AGENT_BUSY', message: '不能切' }),
    'session/initializeDefaultModel': { ok: false, code: 'METHOD_NOT_FOUND', message: 'no such endpoint' },
  })
  const observed = connectFake(fake)
  await useNewSessionStore.getState().refresh()
  useNewSessionStore.setState({ open: true })
  useNewSessionStore.getState().pickModel('deepseek', 'deepseek-v4', 'max')

  const created = await useNewSessionStore.getState().createAndOpen()
  assertEqual(created, 's-new', '会话建出来了')
  const failed = useNewSessionStore.getState()
  assertEqual(failed.modelApply.status, 'failed', '失败状态可见')
  assertTrue((failed.modelApply.error ?? '').length > 0, '带上了原因')
  assertEqual(failed.createdSessionId, 's-new', '记住这个已建好的会话')
  assertEqual(failed.open, true, '面板**没有**关（让用户看见失败）')
  assertEqual(observed.opened, [], '还没进会话')

  // 重试一次就通
  selectModelOk = true
  await useNewSessionStore.getState().retryModelApply()
  assertEqual(observed.opened, ['s-new'], '重试成功后进会话')
  assertEqual(useNewSessionStore.getState().open, false, '这时才关面板')
  assertEqual(useNewSessionStore.getState().modelApply.status, 'idle', '状态复位')
})

check('E21：跳过模型选择 → 用默认模型直接进会话，并留一句提示', async () => {
  resetNewSession()
  const fake = fakeTarget({
    ...FULL_REPLIES,
    'session/selectModel': { ok: false, code: 'AGENT_BUSY', message: '不能切' },
    'session/initializeDefaultModel': { ok: false, code: 'METHOD_NOT_FOUND', message: 'no such endpoint' },
  })
  const observed = connectFake(fake)
  await useNewSessionStore.getState().refresh()
  useNewSessionStore.setState({ open: true })
  useNewSessionStore.getState().pickModel('deepseek', 'deepseek-v4')

  await useNewSessionStore.getState().createAndOpen()
  assertEqual(useNewSessionStore.getState().open, true, '失败后面板还开着')

  await useNewSessionStore.getState().skipModelAndOpen()
  assertEqual(observed.opened, ['s-new'], '跳过之后进会话')
  assertEqual(useNewSessionStore.getState().open, false, '面板关掉')
  assertEqual(useNewSessionStore.getState().createdSessionId, null, '失败态清掉')
})

check('E22：defaultSave 失败 ≠ 模型没切成：会话照常进，但提示「默认没存上」', async () => {
  resetNewSession()
  const fake = fakeTarget({
    ...FULL_REPLIES,
    'session/selectModel': {
      ok: true,
      value: {
        selected: { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'max' },
        defaultSave: { status: 'failed', message: 'settings locked' },
      },
    },
  })
  const observed = connectFake(fake)
  await useNewSessionStore.getState().refresh()
  useNewSessionStore.getState().pickModel('deepseek', 'deepseek-v4', 'max')

  await useNewSessionStore.getState().createAndOpen()
  assertEqual(observed.opened, ['s-new'], '模型切好了，会话照常进')
  assertEqual(useNewSessionStore.getState().modelApply.defaultSave, 'failed', '记住 defaultSave 失败了')
  const notice = useNewSessionStore.getState().notice ?? ''
  assertTrue(notice.length > 0, '有一句提示（不静默）')
  assertTrue(notice.includes('默认'), '提示里点名了「默认」')
})

check('E23：继承 Host 默认（modelPick=null）→ 一个模型端点都不发；切模型会清掉旧档位', async () => {
  resetNewSession()
  const fake = fakeTarget(FULL_REPLIES)
  const observed = connectFake(fake)
  await useNewSessionStore.getState().refresh()

  // 不选模型 = 继承 Host 默认
  await useNewSessionStore.getState().createAndOpen()
  assertEqual(observed.opened, ['s-new'], '照常进会话')
  assertEqual(endpointCount(fake, 'session/selectModel'), 0, '没有发 selectModel')
  assertEqual(endpointCount(fake, 'session/initializeDefaultModel'), 0, '也没有发 initializeDefaultModel')

  // 选模型 + 档位；换成没有档位的模型时旧档位必须丢掉（否则会发一个不存在的 effort）
  useNewSessionStore.getState().pickModel('deepseek', 'deepseek-v4', 'max')
  assertEqual(useNewSessionStore.getState().modelPick, { provider: 'deepseek', model: 'deepseek-v4', effort: 'max' }, '选模型 + 档位')
  useNewSessionStore.getState().pickModel('deepseek', 'deepseek-v4-mini')
  assertEqual(useNewSessionStore.getState().modelPick, { provider: 'deepseek', model: 'deepseek-v4-mini' }, '换模型丢掉旧档位')

  // 只点档位（没选模型时从「当前生效的模型」落成一份显式选择）
  useNewSessionStore.setState({ modelPick: null })
  useNewSessionStore.getState().pickEffort('low')
  assertEqual(useNewSessionStore.getState().modelPick, { provider: 'deepseek', model: 'deepseek-v4', effort: 'low' }, '点档位 = 显式选模型')
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
