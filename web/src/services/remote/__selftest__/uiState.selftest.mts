/**
 * S1「切后台回来不再整页重来」自测：`uiState.ts` 的存取、版本前缀与恢复优先级。
 *
 * 跑法（workdir = projects\deepseek-tablet\web）：
 *   npx tsx src/services/remote/__selftest__/uiState.selftest.mts
 *
 * 覆盖四组：
 *
 *   A. 存取与版本前缀
 *      1. 写进去读得回来（mode / activeSessionId / drafts / timeline / sessionsScrollTop）；
 *      2. 键名带版本后缀 `.v1`，payload 里 `v === UI_STATE_VERSION`（两处必须一致）；
 *      3. payload 版本不对（v=2）→ 读回 null，并**把键删掉**（不迁移）；
 *      4. 旧键名（`.v0`）里写的快照不会被新代码读到（键前缀就是硬隔离）；
 *      5. JSON 坏了 → null，同样删键；
 *      6. 脏数据收紧：负数 / NaN / 超大滚动位置、超长草稿截断、草稿条数上限、空草稿不入表。
 *   B. 恢复优先级（草稿 > 缓存 > 空）
 *      7. 两层都有 → `draft`，文本取草稿层；
 *      8. 只有缓存层 → `cache`；
 *      9. 都没有 → `empty` + 空串；
 *      10. 草稿记在**别的会话**名下 → 不串台（当空）；
 *      11. `resolveActiveSession`：草稿层优先 → 缓存层 → null；
 *      12. `resolveTimelineScroll`：只认同一个会话记下的位置；
 *      13. `resolveSessionsScroll`：0 / 没存过 → null。
 *   C. 兜底层（原生中转箱 / 内存镜像）
 *      14. `sessionStorage` 空、中转箱有 → 读到（换过 WebView 的那一档）；
 *      15. `flushUiState()` 之后中转箱里是最新那份；
 *      16. 中转箱 `put` 抛错 → 写入照样成功（不抛）；
 *      17. 中转箱 `take` 返回坏 JSON → 退到内存镜像。
 *   D. 边界
 *      18. 完全没有 `sessionStorage`（隐私模式 / 非浏览器）→ 写入不抛、内存镜像仍可读；
 *      19. `clearUiState()` 之后三层都读不到。
 *
 * 不联网、不碰 DOM：`sessionStorage` 与原生桥都是内存实现。
 */

/* ── 最小断言器（与其它 selftest 同一套写法） ─────────────────────────── */

const checks: Array<{ name: string; run: () => Promise<void> | void }> = []
const check = (name: string, run: () => Promise<void> | void): void => {
  checks.push({ name, run })
}

const fail = (message: string): never => {
  throw new Error(message)
}

const assertEqual = (actual: unknown, expected: unknown, label: string): void => {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left !== right) fail(`${label}：期望 ${right}，实际 ${left}`)
}

const assertTrue = (value: boolean, label: string): void => {
  if (!value) fail(label)
}

const assertNull = (value: unknown, label: string): void => {
  if (value !== null) fail(`${label}：期望 null，实际 ${JSON.stringify(value)}`)
}

/* ── 内存版 sessionStorage / 原生中转箱 ───────────────────────────────── */

const memory = new Map<string, string>()

const storageStub: Storage = {
  getItem: (key: string): string | null => memory.get(key) ?? null,
  setItem: (key: string, value: string): void => {
    memory.set(key, String(value))
  },
  removeItem: (key: string): void => {
    memory.delete(key)
  },
  clear: (): void => memory.clear(),
  key: (index: number): string | null => [...memory.keys()][index] ?? null,
  get length(): number {
    return memory.size
  },
}

/** 原生壳的中转箱（`MainActivity.UiStateRelay` 的页面侧投影） */
let relayPayload: string | null = null
let relayPutCalls = 0
let relayPutThrows = false
let relayTakeThrows = false

const relayStub = {
  take: (): string => {
    if (relayTakeThrows) throw new Error('bridge gone')
    return relayPayload ?? ''
  },
  put: (json: string): void => {
    relayPutCalls += 1
    if (relayPutThrows) throw new Error('bridge gone')
    relayPayload = json
  },
  clear: (): void => {
    relayPayload = null
  },
}

const globals = globalThis as unknown as Record<string, unknown>
globals.sessionStorage = storageStub
globals.DSNativeUi = relayStub

/*
 * `store.ts` 在模块初始化时会读 localStorage、挂 visibilitychange 监听（R9 通知 / R8 缓存
 * 落盘 / R14 直达），所以这两样必须在 **import store 之前** 装好（与 `cache.selftest.mts` 同一套做法）。
 * fetch 也装桩：E 组全程不该联网，调了就让它显形。
 */
const localMemory = new Map<string, string>()
const localStorageStub = {
  getItem: (key: string): string | null => localMemory.get(key) ?? null,
  setItem: (key: string, value: string): void => {
    localMemory.set(key, String(value))
  },
  removeItem: (key: string): void => {
    localMemory.delete(key)
  },
  clear: (): void => localMemory.clear(),
  key: (index: number): string | null => [...localMemory.keys()][index] ?? null,
  get length(): number {
    return localMemory.size
  },
}
globals.localStorage = localStorageStub

const fakeDocument = {
  visibilityState: 'visible',
  addEventListener: (): void => undefined,
  removeEventListener: (): void => undefined,
}
globals.document = fakeDocument

let fetchCalls = 0
globals.fetch = (async () => {
  fetchCalls += 1
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
}) as unknown as typeof fetch

const ui = await import('../uiState.js')
const timelineCache = await import('../cache.js')
const server = await import('../store.js')
const { pinHostIdentityKey, upsertAccount } = await import('../storage.js')

const {
  MAX_DRAFT_CHARS,
  MAX_DRAFTS,
  UI_STATE_KEY,
  UI_STATE_VERSION,
  clearUiState,
  emptyUiState,
  flushUiState,
  loadBootUiState,
  patchActiveSession,
  patchDraft,
  patchMode,
  patchSessionsScroll,
  patchTimelineScroll,
  readUiRelayState,
  readUiState,
  resolveActiveSession,
  resolveDraftRestore,
  resolveSessionsScroll,
  resolveTimelineScroll,
  sanitizeUiState,
  writeUiState,
} = ui

/** 每个用例都从干净的三层开始 */
const reset = (): void => {
  memory.clear()
  relayPayload = null
  relayPutCalls = 0
  relayPutThrows = false
  relayTakeThrows = false
  clearUiState()
}

/* ── A. 存取与版本前缀 ───────────────────────────────────────────────── */

check('A1 写进去读得回来（五个字段一个不丢）', () => {
  reset()
  patchMode('remote')
  patchActiveSession('sess-1')
  patchDraft('sess-1', '还没发出去的一段话')
  patchTimelineScroll('sess-1', 1234)
  patchSessionsScroll(256)
  const state = readUiState()
  assertEqual(state?.mode, 'remote', 'mode')
  assertEqual(state?.activeSessionId, 'sess-1', 'activeSessionId')
  assertEqual(state?.drafts['sess-1'], '还没发出去的一段话', 'drafts[sess-1]')
  assertEqual(state?.timeline, { sessionId: 'sess-1', top: 1234 }, 'timeline')
  assertEqual(state?.sessionsScrollTop, 256, 'sessionsScrollTop')
})

check('A2 键名带 .v1 版本后缀，payload 里 v 也必须是 1', () => {
  reset()
  patchActiveSession('sess-1')
  assertEqual(UI_STATE_KEY, 'dsp.remote.ui-state.v1', '键名')
  assertEqual(UI_STATE_VERSION, 1, '结构版本')
  const raw = memory.get(UI_STATE_KEY)
  assertTrue(raw !== undefined, '写盘用的就是带版本后缀的那个键')
  const parsed = JSON.parse(raw ?? '{}') as { v?: unknown }
  assertEqual(parsed.v, 1, 'payload.v')
})

check('A3 payload 版本不对 → 读回 null，并把键删掉（不迁移）', () => {
  reset()
  memory.set(UI_STATE_KEY, JSON.stringify({ ...emptyUiState(), v: 2, activeSessionId: 'sess-1' }))
  assertNull(readUiState(), '版本不符的快照')
  assertTrue(!memory.has(UI_STATE_KEY), '坏版本要顺手删键（否则每次启动都白读一遍）')
})

check('A4 旧键名（.v0）里的快照读不到：键前缀就是硬隔离', () => {
  reset()
  memory.set('dsp.remote.ui-state.v0', JSON.stringify({ ...emptyUiState(), activeSessionId: 'old' }))
  assertNull(readUiState(), '旧键名')
  assertTrue(memory.has('dsp.remote.ui-state.v0'), '别的版本键我们不动它')
})

check('A5 JSON 坏了 → null，同样删键', () => {
  reset()
  memory.set(UI_STATE_KEY, '{ 这不是 JSON')
  assertNull(readUiState(), '坏 JSON')
  assertTrue(!memory.has(UI_STATE_KEY), '坏 JSON 也要删键')
})

check('A6 脏数据收紧：滚动位置 / 草稿长度 / 草稿条数 / 空草稿', () => {
  reset()
  // 滚动位置：负数、NaN、超大都收紧
  assertEqual(sanitizeUiState({ ...emptyUiState(), sessionsScrollTop: -5 })?.sessionsScrollTop, 0, '负数收敛成 0')
  assertEqual(sanitizeUiState({ ...emptyUiState(), sessionsScrollTop: Number.NaN })?.sessionsScrollTop, 0, 'NaN 收敛成 0')
  const clamped = sanitizeUiState({ ...emptyUiState(), sessionsScrollTop: 1e12 })?.sessionsScrollTop
  assertEqual(clamped, 10_000_000, '超大值被夹到上限')
  // 草稿：超长截断、空串丢掉、条数上限
  const long = sanitizeUiState({ ...emptyUiState(), drafts: { a: 'x'.repeat(MAX_DRAFT_CHARS + 100) } })
  assertEqual(long?.drafts.a?.length, MAX_DRAFT_CHARS, '草稿被截断到上限')
  const empty = sanitizeUiState({ ...emptyUiState(), drafts: { a: '', b: 'kept' } })
  assertEqual(Object.keys(empty?.drafts ?? {}), ['b'], '空草稿不入表')
  const many: Record<string, string> = {}
  for (let index = 0; index < MAX_DRAFTS + 3; index += 1) many[`s${index}`] = `t${index}`
  const trimmed = sanitizeUiState({ ...emptyUiState(), drafts: many })?.drafts ?? {}
  assertEqual(Object.keys(trimmed).length, MAX_DRAFTS, `最多保留 ${MAX_DRAFTS} 条`)
  assertTrue(trimmed[`s${MAX_DRAFTS + 2}`] !== undefined, '保留的是最近的几条')
  // 非对象 / 没有版本字段
  assertNull(sanitizeUiState(null), 'null')
  assertNull(sanitizeUiState('x'), '字符串')
  assertNull(sanitizeUiState({}), '没有 v 字段')
})

/* ── B. 恢复优先级：草稿 > 缓存 > 空 ─────────────────────────────────── */

check('B7 两层都有 → 取草稿层，来源是 draft', () => {
  const primary = { ...emptyUiState(), activeSessionId: 'sess-1', drafts: { 'sess-1': '草稿层的字' } }
  const fallback = { ...emptyUiState(), activeSessionId: 'sess-1', drafts: { 'sess-1': '缓存层的字' } }
  const restored = resolveDraftRestore({ primary, fallback, sessionId: 'sess-1' })
  assertEqual(restored, { text: '草稿层的字', source: 'draft' }, '优先级')
})

check('B8 草稿层空、缓存层有 → 来源是 cache', () => {
  const fallback = { ...emptyUiState(), drafts: { 'sess-1': '缓存层的字' } }
  const restored = resolveDraftRestore({ primary: emptyUiState(), fallback, sessionId: 'sess-1' })
  assertEqual(restored, { text: '缓存层的字', source: 'cache' }, '退到缓存层')
})

check('B9 两层都没有 → 空串 + empty', () => {
  const restored = resolveDraftRestore({ primary: emptyUiState(), fallback: null, sessionId: 'sess-1' })
  assertEqual(restored, { text: '', source: 'empty' }, '什么都没有')
})

check('B10 草稿记在别的会话名下 → 不串台', () => {
  const primary = { ...emptyUiState(), drafts: { 'sess-2': '别的会话的字' } }
  const restored = resolveDraftRestore({ primary, fallback: null, sessionId: 'sess-1' })
  assertEqual(restored, { text: '', source: 'empty' }, '不能把 B 的草稿塞给 A')
  // 会话还没开起来（null）走空串那条键：互不影响
  const noSession = { ...emptyUiState(), drafts: { '': '还没开会话时的字' } }
  assertEqual(
    resolveDraftRestore({ primary: noSession, fallback: null, sessionId: null }),
    { text: '还没开会话时的字', source: 'draft' },
    '无会话键',
  )
  assertEqual(
    resolveDraftRestore({ primary: noSession, fallback: null, sessionId: 'sess-1' }),
    { text: '', source: 'empty' },
    '无会话键不串给具体会话',
  )
})

check('B11 resolveActiveSession：草稿层 → 缓存层 → null', () => {
  assertEqual(
    resolveActiveSession({ primary: { ...emptyUiState(), activeSessionId: 'p' }, fallback: { ...emptyUiState(), activeSessionId: 'f' } }),
    'p',
    '草稿层优先',
  )
  assertEqual(
    resolveActiveSession({ primary: emptyUiState(), fallback: { ...emptyUiState(), activeSessionId: 'f' } }),
    'f',
    '退到缓存层',
  )
  assertNull(resolveActiveSession({ primary: emptyUiState(), fallback: null }), '都没有')
})

check('B12 resolveTimelineScroll：只认同一个会话的位置', () => {
  const primary = { ...emptyUiState(), timeline: { sessionId: 'sess-1', top: 900 } }
  assertEqual(resolveTimelineScroll({ primary, fallback: null, sessionId: 'sess-1' }), 900, '同会话命中')
  assertNull(resolveTimelineScroll({ primary, fallback: null, sessionId: 'sess-2' }), '换会话不套旧位置')
  assertNull(resolveTimelineScroll({ primary, fallback: null, sessionId: null }), '没有会话')
  const fallbackOnly = { ...emptyUiState(), timeline: { sessionId: 'sess-1', top: 300 } }
  assertEqual(
    resolveTimelineScroll({ primary: emptyUiState(), fallback: fallbackOnly, sessionId: 'sess-1' }),
    300,
    '退到缓存层',
  )
})

check('B13 resolveSessionsScroll：0 / 没存过 → null', () => {
  assertNull(resolveSessionsScroll({ primary: emptyUiState(), fallback: null }), '没存过')
  assertEqual(resolveSessionsScroll({ primary: { ...emptyUiState(), sessionsScrollTop: 120 }, fallback: null }), 120, '存过')
  assertEqual(
    resolveSessionsScroll({ primary: emptyUiState(), fallback: { ...emptyUiState(), sessionsScrollTop: 80 } }),
    80,
    '退到缓存层',
  )
})

/* ── C. 兜底层：原生中转箱 / 内存镜像 ─────────────────────────────────── */

check('C14 sessionStorage 空、中转箱有 → 读到（换过 WebView 那一档）', () => {
  reset()
  patchDraft('sess-1', '换 WebView 之前的草稿')
  flushUiState()
  assertTrue(relayPayload !== null, 'flush 之后中转箱里应该有东西')
  // 模拟「WebView 被就地换掉」：sessionStorage 被浏览器清空，中转箱还挂在 Activity 上
  memory.clear()
  assertNull(readUiState(), 'sessionStorage 那一层已经空了')
  const boot = loadBootUiState()
  assertNull(boot.primary, '草稿层没有')
  assertEqual(boot.fallback?.drafts['sess-1'], '换 WebView 之前的草稿', '缓存层捞得回来')
  assertEqual(
    resolveDraftRestore({ primary: boot.primary, fallback: boot.fallback, sessionId: 'sess-1' }),
    { text: '换 WebView 之前的草稿', source: 'cache' },
    '恢复来源标记为 cache',
  )
})

check('C15 flushUiState 之后中转箱里是最新那份', () => {
  reset()
  patchDraft('sess-1', '第一版')
  flushUiState()
  patchDraft('sess-1', '第二版')
  flushUiState()
  const relayed = JSON.parse(relayPayload ?? '{}') as { drafts?: Record<string, string> }
  assertEqual(relayed.drafts?.['sess-1'], '第二版', '中转箱里是最后一次写入')
})

check('C16 中转箱 put 抛错 → 写入照样成功', () => {
  reset()
  relayPutThrows = true
  patchDraft('sess-1', '桥坏了也要能存')
  flushUiState()
  assertEqual(readUiState()?.drafts['sess-1'], '桥坏了也要能存', 'sessionStorage 那层不受影响')
  assertEqual(readUiRelayState()?.drafts['sess-1'], '桥坏了也要能存', '内存镜像兜住')
})

check('C17 中转箱 take 返回坏 JSON → 退到内存镜像', () => {
  reset()
  patchDraft('sess-1', '镜像里的字')
  relayPayload = '{ 坏 JSON'
  assertEqual(readUiRelayState()?.drafts['sess-1'], '镜像里的字', '坏 JSON 不该让它返回 null')
})

/* ── D. 边界 ─────────────────────────────────────────────────────────── */

check('D18 完全没有 sessionStorage → 写入不抛、镜像仍可读', () => {
  reset()
  const saved = globals.sessionStorage
  delete globals.sessionStorage
  try {
    patchActiveSession('sess-9')
    patchDraft('sess-9', '隐私模式下打的字')
    assertNull(readUiState(), '这一层读不到')
    assertEqual(readUiRelayState()?.drafts['sess-9'], '隐私模式下打的字', '内存镜像顶住')
  } finally {
    globals.sessionStorage = saved
  }
})

check('D19 clearUiState 之后三层都读不到', () => {
  reset()
  patchActiveSession('sess-1')
  patchDraft('sess-1', '要清掉的')
  flushUiState()
  assertTrue(relayPayload !== null, '清之前中转箱里有东西')
  clearUiState()
  assertNull(readUiState(), 'sessionStorage')
  assertNull(readUiRelayState(), '中转箱 + 镜像')
  assertTrue(relayPayload === null, '中转箱被 clear')
  assertEqual(writeUiState({}).activeSessionId, null, '清完之后再写是空的')
})

/* ── E. store 接线：缓存直出在「连接之前」就生效 ──────────────────────── */

/**
 * `hydrateCachedTimeline()` 存在的唯一理由：`openSession()` 第一句是 `requireSession()`，
 * 没连上就失败 —— 于是「缓存直出」在**页面刚重载**这个最需要它的时刻恰好用不上。
 * 这一组证明：**在没有任何连接的情况下**，只读盘就能把上一屏铺出来，并且如实标成「正在同步」。
 */
check('E20 hydrateCachedTimeline：没连接也能把上一屏铺出来（标注"正在同步"）', async () => {
  reset()
  localMemory.clear()
  const serverUrl = 'https://dsh.example'
  const email = 'a@b.c'
  const hostDeviceId = 'host-1'
  const identityKey = 'B' + 'A'.repeat(42)
  const deviceId = 'ui-fixture-device'
  server.useRemoteStore.setState({
    lastSession: { serverUrl, email, hostDeviceId, hostName: '书房电脑', savedAt: Date.now() },
  })
  pinHostIdentityKey(serverUrl, { deviceId: hostDeviceId, identityKey })
  timelineCache.writeTimelineCache({
    serverUrl,
    hostDeviceId,
    owner: JSON.stringify([identityKey, deviceId, email]),
    sessionId: 'sess-1',
    now: Date.now(),
    items: [{ kind: 'message', id: 'm-1', sessionId: 'sess-1', createdAt: 1, role: 'user', text: '上一屏的内容' }],
  })
  // 此刻 phase 还是 idle：一条连接都没有
  assertEqual(server.useRemoteStore.getState().phase, 'idle', '前提：还没连上')
  server.hydrateCachedTimeline('sess-1')
  assertNull(server.useRemoteStore.getState().activeSessionId, '没有对应的设备记录时，缓存不显示')
  upsertAccount({ serverUrl, email, deviceId, accessToken: 'fixture-token', refreshToken: 'fixture-refresh', scope: 'device' })
  server.hydrateCachedTimeline('sess-1')
  const state = server.useRemoteStore.getState()
  assertEqual(state.activeSessionId, 'sess-1', '会话先回来了')
  assertEqual(state.items.length, 1, '内容先铺上了')
  assertEqual(state.cacheStatus.timelineFromCache, true, '标成缓存直出')
  assertEqual(state.cacheStatus.timelineSettled, false, '还没和服务端对齐（所以界面会说"正在同步"）')
  assertEqual(state.phase, 'idle', '全程没建连接')
})

check('E21 hydrateCachedTimeline 幂等 + 不抢：已经有会话就不动', async () => {
  reset()
  localMemory.clear()
  server.useRemoteStore.setState({ activeSessionId: 'sess-live', items: [] })
  server.hydrateCachedTimeline('sess-1')
  assertEqual(server.useRemoteStore.getState().activeSessionId, 'sess-live', '已有会话时不被缓存顶掉')
  assertEqual(fetchCalls, 0, '全程没发过任何网络请求')
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

void main()
