/**
 * R8「缓存与合并」自测（cache.ts + store 接线 + adapter 组合）。
 *
 * 跑法（workdir = projects\deepseek-tablet\web）：
 *   npx tsx src/services/remote/__selftest__/cache.selftest.mts
 *
 * 覆盖任务书要求自测的五件事，另加键设计与加载态：
 *
 *   A. 缓存键与 TTL
 *      1. 键名带版本号（`dsp.remote.sessions-cache.v1` / `dsp.remote.messages-cache.v1`）、TTL 24h；
 *      2. 写进去读得回来（title / pinned / updatedAt / missingAt 一个不丢）；
 *      3. 版本号不对 → 读回 null，并把那条键删掉（**不迁移**）；
 *      4. TTL：23h 不陈旧、25h 标「陈旧」但**仍然给数据**（先显示、标注「缓存」）；
 *      5. 分桶：serverUrl 大小写/尾斜杠归一化后同桶，hostDeviceId 不同就不同桶。
 *   B. 会话列表合并（并集 / 同 id 覆盖 / pinned 保留 / 幽灵两轮清理）
 *      6. 并集：本地 2 行 + 服务端 2 行（1 行重合）→ 3 行；
 *      7. 同 id：服务端 title / updatedAt 覆盖本地；
 *      8. 服务端没给 pinned → 本地 pinned 保留；
 *      9. 服务端明确 pinned=false → 覆盖本地 true；
 *      10. 只有本地有（第一轮）→ 保留 + `missingAt` + 进 ghosts；
 *      11. 同上但第二轮还是没有 → 这一轮清掉；
 *      12. 幽灵复活（服务端又给了）→ `missingAt` 清掉、不在 ghosts；
 *      13. 排序：置顶在前，其余 updatedAt 倒序。
 *   C. 会话内容缓存（裁剪 / 上限 / 卫生）
 *      14. 写进去读得回来；
 *      15. 200 条上限：250 条只留最近 200 条（尾部）；
 *      16. 1 MiB 上限：超预算从**头部**丢，最新那条一定在；
 *      17. `queued` 乐观行不落盘，`failed` 保留（失败要给用户看到）；
 *      18. 瞬态字段（`streaming` / `streamingPhase`）落盘时被清掉；
 *      19. 同一桶最多 4 个会话（第 5 个把最旧的挤掉）。
 *   D. 会话内容合并（同 id 覆盖 / 乐观行对齐 / 翻页顺序）
 *      20. 同 id：服务端那份胜出（文本用服务端的）；
 *      21. 乐观行已被回显（同 requestRpcId）→ 丢弃，不重复；
 *      22. 乐观行还没回显 → 保留在**尾部**；
 *      23. 更早的历史页留在**头部**（nativeSeq 更小），顺序不变；
 *      24. 服务端窗口为空 → 只剩未落定的乐观行；
 *      25. 用**真实** `parseSnapshot` / `reduceSnapshot` 产出的窗口合并（端到端组合）。
 *   E. 加载态（骨架 / 缓存直出 / 空态 / 失败）
 *      26. `sessionListViewState`：内容 / 骨架 / 空 / 未连接；
 *      27. `timelineViewState`：**首次拉取没结束绝不 empty**；拉完才 empty；失败是 failed；
 *      28. `timelineHintState`：缓存直出 → syncing；有行但失败 → failed；拉完 → none。
 *   F. store 接线
 *      29. `hydrateCachedSessions()`：把缓存铺进 `sessions` + `cacheStatus`（含 ghost 标注）；
 *      30. 已经有实时列表 / 已同步过 → 不拿缓存盖回去。
 *
 * 不联网：localStorage 是内存实现，fetch 是桩（全程不该有人调它）。
 */

import type { ChatItem, ChatMessage, ToolActivity } from '../adapter.js'

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

const idsOf = (items: readonly ChatItem[]): string[] => items.map(item => item.id)

/* ── 内存版 localStorage（store.ts 在模块初始化时会读一次） ───────────── */

const memory = new Map<string, string>()
const localStorageStub = {
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
;(globalThis as unknown as Record<string, unknown>).localStorage = localStorageStub

/** 假 document：store 的两处 visibilitychange 监听都要能挂上（我们一个都不触发）。 */
const fakeDocument = {
  visibilityState: 'visible',
  addEventListener: (): void => undefined,
  removeEventListener: (): void => undefined,
}
;(globalThis as unknown as Record<string, unknown>).document = fakeDocument

/** fetch 桩：这批代码不该发任何请求，发了就让自测失败（而不是静默挂住）。 */
let fetchCalls = 0
;(globalThis as unknown as Record<string, unknown>).fetch = (async () => {
  fetchCalls += 1
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
}) as unknown as typeof fetch

/* ── 被测模块（先装好全局再 import store） ─────────────────────────────── */

const cache = await import('../cache.js')
const adapter = await import('../adapter.js')
const storeModule = await import('../store.js')

const {
  CACHE_VERSION,
  SESSIONS_CACHE_KEY,
  TIMELINE_CACHE_KEY,
  CACHE_TTL_MS,
  TIMELINE_MAX_ITEMS,
  TIMELINE_MAX_BYTES,
  MAX_TIMELINES_PER_BUCKET,
  cacheBucketId,
  mergeSessionLists,
  mergeTimelineItems,
  readSessionsCache,
  readTimelineCache,
  sessionListViewState,
  timelineHintState,
  timelineViewState,
  writeSessionsCache,
  writeTimelineCache,
} = cache

const { useRemoteStore } = storeModule

const SERVER = 'https://dsh.r2049.cn'
const HOST = 'host-a'
const SESSION = 'sess-1'
const T0 = 1_760_000_000_000

const bucket = (over: Partial<{ serverUrl: string; hostDeviceId: string; now: number }> = {}) => ({
  serverUrl: SERVER,
  hostDeviceId: HOST,
  now: T0,
  ...over,
})

const clearCacheKeys = (): void => {
  memory.delete(SESSIONS_CACHE_KEY)
  memory.delete(TIMELINE_CACHE_KEY)
}

/* ── 时间线行的构造器 ─────────────────────────────────────────────────── */

const message = (
  id: string,
  createdAt: number,
  over: Partial<ChatMessage> = {},
): ChatMessage => ({ kind: 'message', id, sessionId: SESSION, createdAt, role: 'assistant', text: id, ...over })

const userMessage = (id: string, createdAt: number, over: Partial<ChatMessage> = {}): ChatMessage =>
  message(id, createdAt, { role: 'user', ...over })

const tool = (id: string, createdAt: number, seq: number): ToolActivity => ({
  kind: 'tool',
  id,
  sessionId: SESSION,
  createdAt,
  nativeSeq: seq,
  toolName: 'read_file',
  state: 'finished',
})

/* ════════════════════════════════════════════════════════════════════════
 * A. 键与 TTL
 * ════════════════════════════════════════════════════════════════════════ */

check('A1 键名带版本号、TTL 24h、上限常量与任务书一致', async () => {
  assertEqual(SESSIONS_CACHE_KEY, 'dsp.remote.sessions-cache.v1', '列表缓存键')
  assertEqual(TIMELINE_CACHE_KEY, 'dsp.remote.messages-cache.v1', '内容缓存键')
  assertEqual(CACHE_VERSION, 1, '版本号')
  assertEqual(CACHE_TTL_MS, 24 * 60 * 60 * 1000, 'TTL 24h')
  assertEqual(TIMELINE_MAX_ITEMS, 200, '单会话最多 200 条')
  assertEqual(TIMELINE_MAX_BYTES, 1024 * 1024, '单会话最多 1 MiB')
})

check('A2 写进去读得回来（字段一个不丢）', async () => {
  clearCacheKeys()
  writeSessionsCache({
    ...bucket(),
    sessions: [
      { id: 's-1', title: '把工具调用显示得详细一点', pinned: true, updatedAt: T0 - 1_000 },
      { id: 's-2', title: '远程会话的搜索怎么做', updatedAt: T0 - 9_000, workspaceId: 'ws-1' },
    ],
  })
  const cached = readSessionsCache(bucket())
  assertTrue(cached !== null, '应该有缓存')
  assertEqual(cached?.sessions.length, 2, '两行')
  assertEqual(cached?.sessions[0]?.title, '把工具调用显示得详细一点', '标题')
  assertEqual(cached?.sessions[0]?.pinned, true, 'pinned')
  assertEqual(cached?.sessions[1]?.workspaceId, 'ws-1', 'workspaceId')
  assertEqual(cached?.savedAt, T0, 'savedAt')
})

check('A3 版本号不对 → 读回 null 且键被删掉（不写迁移）', async () => {
  clearCacheKeys()
  memory.set(SESSIONS_CACHE_KEY, JSON.stringify({ v: 99, buckets: { x: { sessions: [{ id: 's-1', title: '旧' }] } } }))
  assertEqual(readSessionsCache(bucket()), null, '旧版本读不回来')
  assertEqual(memory.has(SESSIONS_CACHE_KEY), false, '旧版本的键被丢掉')
})

check('A4 TTL：23h 不陈旧，25h 标陈旧但照样给数据', async () => {
  clearCacheKeys()
  writeSessionsCache({ ...bucket({ now: T0 }), sessions: [{ id: 's-1', title: '先显示' }] })
  const fresh = readSessionsCache(bucket({ now: T0 + 23 * 60 * 60 * 1000 }))
  assertEqual(fresh?.stale, false, '23h 不陈旧')
  const stale = readSessionsCache(bucket({ now: T0 + 25 * 60 * 60 * 1000 }))
  assertEqual(stale?.stale, true, '25h 标陈旧')
  assertEqual(stale?.sessions.length, 1, '陈旧也先显示（不删）')
})

check('A5 分桶：URL 归一化后同桶，hostDeviceId 不同就不同桶', async () => {
  clearCacheKeys()
  assertEqual(
    cacheBucketId(`${SERVER}/`, HOST),
    cacheBucketId('HTTPS://DSH.R2049.CN', HOST),
    '尾斜杠 / 大小写归一化',
  )
  assertTrue(cacheBucketId(SERVER, HOST) !== cacheBucketId(SERVER, 'host-b'), '不同 Host 不同桶')
  writeSessionsCache({ ...bucket(), sessions: [{ id: 's-1', title: '只属于 host-a' }] })
  assertEqual(readSessionsCache(bucket({ hostDeviceId: 'host-b' })), null, '别的 Host 读不到')
})

/* ════════════════════════════════════════════════════════════════════════
 * B. 会话列表合并
 * ════════════════════════════════════════════════════════════════════════ */

check('B1 并集：同 id 合一行，其余各来一行', async () => {
  const merged = mergeSessionLists({
    cached: [
      { id: 's-1', title: '本地标题', updatedAt: T0 - 5_000 },
      { id: 's-2', title: '只有本地', updatedAt: T0 - 9_000 },
    ],
    remote: [
      { id: 's-1', title: '服务端标题', updatedAt: T0 - 1_000 },
      { id: 's-3', title: '只有服务端', updatedAt: T0 - 3_000 },
    ],
    now: T0,
  })
  assertEqual(merged.sessions.length, 3, '三行')
  assertEqual(merged.sessions.map(row => row.id).sort(), ['s-1', 's-2', 's-3'], 'id 并集')
})

check('B2 同 id：服务端 title / updatedAt 覆盖本地', async () => {
  const merged = mergeSessionLists({
    cached: [{ id: 's-1', title: '本地标题', updatedAt: T0 - 5_000 }],
    remote: [{ id: 's-1', title: '服务端标题', updatedAt: T0 - 1_000 }],
    now: T0,
  })
  assertEqual(merged.sessions[0]?.title, '服务端标题', '标题以服务端为准')
  assertEqual(merged.sessions[0]?.updatedAt, T0 - 1_000, 'updatedAt 以服务端为准')
  assertEqual(merged.ghostSessionIds, [], '没有幽灵')
})

check('B3 服务端没给 pinned → 本地 pinned 保留', async () => {
  const merged = mergeSessionLists({
    cached: [{ id: 's-1', title: '置顶的', pinned: true, updatedAt: T0 }],
    remote: [{ id: 's-1', title: '置顶的' }],
    now: T0,
  })
  assertEqual(merged.sessions[0]?.pinned, true, '本地置顶没被抹掉')
})

check('B4 服务端明确 pinned=false → 覆盖本地 true（云端才是权威）', async () => {
  const merged = mergeSessionLists({
    cached: [{ id: 's-1', title: '取消置顶了', pinned: true, updatedAt: T0 }],
    remote: [{ id: 's-1', title: '取消置顶了', pinned: false }],
    now: T0,
  })
  assertEqual(merged.sessions[0]?.pinned, false, '服务端的 false 要生效')
})

check('B5 只有本地有（第一轮）→ 保留 + 打 missingAt + 进 ghosts', async () => {
  const merged = mergeSessionLists({
    cached: [{ id: 's-9', title: '可能被删了', updatedAt: T0 - 1_000 }],
    remote: [{ id: 's-1', title: '还在' }],
    now: T0,
  })
  const ghost = merged.sessions.find(row => row.id === 's-9')
  assertTrue(ghost !== undefined, '第一轮不立刻删（避免抖动闪一下）')
  assertEqual(ghost?.missingAt, T0, '打上 missingAt')
  assertEqual(merged.ghostSessionIds, ['s-9'], '进 ghosts（UI 标「已不存在」）')
})

check('B6 第二轮服务端还是没有 → 这一轮清掉', async () => {
  const merged = mergeSessionLists({
    cached: [{ id: 's-9', title: '确认没了', missingAt: T0 - 1_000 }],
    remote: [{ id: 's-1', title: '还在' }],
    now: T0,
  })
  assertEqual(
    merged.sessions.some(row => row.id === 's-9'),
    false,
    '连续两轮没有就删',
  )
  assertEqual(merged.ghostSessionIds, [], '不再是幽灵')
})

check('B7 幽灵复活（服务端又给了）→ missingAt 清掉', async () => {
  const merged = mergeSessionLists({
    cached: [{ id: 's-9', title: '又回来了', missingAt: T0 - 1_000 }],
    remote: [{ id: 's-9', title: '又回来了' }],
    now: T0,
  })
  assertEqual(merged.sessions.length, 1, '一行')
  assertEqual(merged.sessions[0]?.missingAt, undefined, 'missingAt 不继承')
  assertEqual(merged.ghostSessionIds, [], '不是幽灵')
})

check('B8 排序：置顶在前，其余按 updatedAt 倒序', async () => {
  const merged = mergeSessionLists({
    cached: [],
    remote: [
      { id: 'old', title: '旧', updatedAt: T0 - 9_000 },
      { id: 'pin', title: '置顶', updatedAt: T0 - 99_000, pinned: true },
      { id: 'new', title: '新', updatedAt: T0 - 1_000 },
    ],
    now: T0,
  })
  assertEqual(merged.sessions.map(row => row.id), ['pin', 'new', 'old'], '顺序')
})

/* ════════════════════════════════════════════════════════════════════════
 * C. 会话内容缓存
 * ════════════════════════════════════════════════════════════════════════ */

check('C1 写进去读得回来（含顺序）', async () => {
  clearCacheKeys()
  const items = [message('m-1', T0 - 3_000), message('m-2', T0 - 2_000), tool('t-1', T0 - 1_000, 9)]
  const written = writeTimelineCache({ ...bucket(), sessionId: SESSION, items })
  assertEqual(written, 3, '写了三条')
  const cached = readTimelineCache({ ...bucket(), sessionId: SESSION })
  assertEqual(idsOf(cached?.items ?? []), ['m-1', 'm-2', 't-1'], '顺序不变')
  assertEqual(cached?.stale, false, '不陈旧')
})

check('C2 200 条上限：只留最近 200 条（尾部）', async () => {
  clearCacheKeys()
  const items: ChatItem[] = []
  for (let index = 0; index < 250; index += 1) items.push(message(`m-${index}`, T0 + index))
  writeTimelineCache({ ...bucket(), sessionId: SESSION, items })
  const cached = readTimelineCache({ ...bucket(), sessionId: SESSION })
  assertEqual(cached?.items.length, 200, '裁到 200')
  assertEqual(cached?.items[0]?.id, 'm-50', '留下的是尾部（m-50 … m-249）')
  assertEqual(cached?.items.at(-1)?.id, 'm-249', '最新那条在')
})

check('C3 1 MiB 上限：从头部丢，最新一条一定在', async () => {
  clearCacheKeys()
  const big = 'x'.repeat(64 * 1024)
  const items: ChatItem[] = []
  for (let index = 0; index < 40; index += 1) {
    items.push(message(`big-${index}`, T0 + index, { text: `${index}:${big}` }))
  }
  const written = writeTimelineCache({ ...bucket(), sessionId: SESSION, items })
  assertTrue(written > 0 && written < 40, `超预算要裁剪（写了 ${written} 条）`)
  const cached = readTimelineCache({ ...bucket(), sessionId: SESSION })
  assertEqual(cached?.items.at(-1)?.id, 'big-39', '最新一条留下')
  const total = JSON.stringify(cached?.items ?? []).length
  assertTrue(total < TIMELINE_MAX_BYTES * 1.1, `总字节受控（${total}）`)
})

check('C4 queued 乐观行不落盘、failed 保留', async () => {
  clearCacheKeys()
  const items: ChatItem[] = [
    message('m-1', T0 - 5_000),
    userMessage('local-queued', T0 - 4_000, { requestRpcId: 'rpc-a', sendState: 'queued' }),
    userMessage('local-failed', T0 - 3_000, { requestRpcId: 'rpc-b', sendState: 'failed', sendError: '发送失败' }),
  ]
  writeTimelineCache({ ...bucket(), sessionId: SESSION, items })
  const cached = readTimelineCache({ ...bucket(), sessionId: SESSION })
  assertEqual(idsOf(cached?.items ?? []), ['m-1', 'local-failed'], 'queued 丢掉、failed 留着')
  const failed = (cached?.items ?? []).find(item => item.id === 'local-failed')
  assertEqual(failed?.kind === 'message' ? failed.sendError : undefined, '发送失败', '失败原因也留着')
})

check('C5 瞬态字段（streaming）落盘时被清掉', async () => {
  clearCacheKeys()
  const items: ChatItem[] = [message('m-1', T0, { text: '正在写', streaming: true, streamingPhase: 'text' })]
  writeTimelineCache({ ...bucket(), sessionId: SESSION, items })
  const cached = readTimelineCache({ ...bucket(), sessionId: SESSION })
  const first = cached?.items[0]
  assertEqual(first?.kind === 'message' ? first.streaming : 'missing', undefined, 'streaming 清掉')
  assertEqual(first?.kind === 'message' ? first.streamingPhase : 'missing', undefined, 'streamingPhase 清掉')
  assertEqual(first?.kind === 'message' ? first.text : '', '正在写', '正文还在')
})

check('C6 同一桶最多 4 个会话（第 5 个把最旧的挤掉）', async () => {
  clearCacheKeys()
  for (let index = 0; index < MAX_TIMELINES_PER_BUCKET + 1; index += 1) {
    writeTimelineCache({
      ...bucket({ now: T0 + index }),
      sessionId: `s-${index}`,
      items: [message(`m-${index}`, T0 + index)],
    })
  }
  assertEqual(readTimelineCache({ ...bucket(), sessionId: 's-0' }), null, '最旧的被挤掉')
  assertTrue(readTimelineCache({ ...bucket(), sessionId: 's-4' }) !== null, '最新的在')
})

check('C7 配额满：先退成「只留当前会话」再写一次（别让写盘长期失败）', async () => {
  clearCacheKeys()
  // 先塞满两个会话
  writeTimelineCache({ ...bucket({ now: T0 }), sessionId: 's-a', items: [message('a-1', T0)] })
  writeTimelineCache({ ...bucket({ now: T0 + 1 }), sessionId: 's-b', items: [message('b-1', T0 + 1)] })
  // 再模拟「写的时候配额满了」：第一次 setItem 抛错，第二次放行
  const originalSetItem = localStorageStub.setItem
  let thrown = false
  localStorageStub.setItem = (key: string, value: string): void => {
    if (!thrown && key === TIMELINE_CACHE_KEY) {
      thrown = true
      throw new Error('QuotaExceededError')
    }
    originalSetItem(key, value)
  }
  try {
    const written = writeTimelineCache({
      ...bucket({ now: T0 + 2 }),
      sessionId: 's-c',
      items: [message('c-1', T0 + 2)],
    })
    assertEqual(written, 1, '还是写下去了')
  } finally {
    localStorageStub.setItem = originalSetItem
  }
  assertTrue(readTimelineCache({ ...bucket(), sessionId: 's-c' }) !== null, '当前会话保住了')
  assertEqual(readTimelineCache({ ...bucket(), sessionId: 's-a' }), null, '旧会话被让位（降级可接受）')
})

/* ════════════════════════════════════════════════════════════════════════
 * D. 会话内容合并
 * ════════════════════════════════════════════════════════════════════════ */

check('D1 同 id：服务端那份胜出', async () => {
  const local: ChatItem[] = [message('m-1', T0, { text: '缓存里的旧文本' })]
  const fresh: ChatItem[] = [message('m-1', T0, { text: '服务端的权威文本' })]
  const merged = mergeTimelineItems(local, fresh)
  assertEqual(merged.length, 1, '不重复')
  assertEqual(merged[0]?.kind === 'message' ? merged[0].text : '', '服务端的权威文本', '服务端覆盖')
})

check('D2 乐观行已被回显（同 requestRpcId）→ 丢弃', async () => {
  const local: ChatItem[] = [userMessage('local-1', T0 - 1_000, { requestRpcId: 'rpc-a', sendState: 'queued' })]
  const fresh: ChatItem[] = [userMessage('msg-user-1', T0 - 1_000, { requestRpcId: 'rpc-a' })]
  const merged = mergeTimelineItems(local, fresh)
  assertEqual(idsOf(merged), ['msg-user-1'], '只留服务端那条')
})

check('D3 乐观行还没回显 → 保留在尾部', async () => {
  const local: ChatItem[] = [
    message('m-1', T0 - 5_000),
    userMessage('local-1', T0, { requestRpcId: 'rpc-z', sendState: 'queued' }),
  ]
  const fresh: ChatItem[] = [message('m-1', T0 - 5_000), message('m-2', T0 - 2_000)]
  const merged = mergeTimelineItems(local, fresh)
  assertEqual(idsOf(merged), ['m-1', 'm-2', 'local-1'], '服务端窗口在前、乐观行在尾')
})

check('D4 更早的历史页留在头部，顺序不变', async () => {
  const local: ChatItem[] = [message('old-1', T0 - 9_000, { nativeSeq: 1 }), message('old-2', T0 - 8_000, { nativeSeq: 2 })]
  const fresh: ChatItem[] = [message('m-1', T0 - 5_000, { nativeSeq: 10 }), message('m-2', T0 - 2_000, { nativeSeq: 11 })]
  const merged = mergeTimelineItems(local, fresh)
  assertEqual(idsOf(merged), ['old-1', 'old-2', 'm-1', 'm-2'], '旧的在前、服务端窗口在后')
})

check('D5 服务端窗口为空 → 只剩未落定的乐观行', async () => {
  const local: ChatItem[] = [
    message('stale-1', T0 - 9_000),
    userMessage('local-1', T0, { requestRpcId: 'rpc-z', sendState: 'queued' }),
  ]
  const merged = mergeTimelineItems(local, [])
  assertEqual(idsOf(merged), ['local-1'], '过期缓存丢掉、在飞的留着')
})

check('D6 与真实快照组合：parseSnapshot → reduceSnapshot → merge', async () => {
  const fixture = {
    type: 'snapshot',
    cursor: 4,
    throughSeq: 4,
    hasMore: true,
    header: { version: 3, sessionId: SESSION },
    records: [
      { type: 'event', event: { type: 'turn/start', seq: 1, time: 1_000, data: { turn: 1 } } },
      {
        type: 'event',
        event: {
          type: 'user/message',
          seq: 2,
          time: 1_010,
          data: {
            turn: 1,
            message: {
              id: 'msg-user-1',
              role: 'user',
              source: { kind: 'user', rpcId: 'rpc-0' },
              content: [{ type: 'text', text: '你好' }],
            },
          },
        },
      },
      {
        type: 'event',
        event: {
          type: 'assistant/message',
          seq: 3,
          time: 1_020,
          data: {
            turn: 1,
            step: 1,
            message: { id: 'msg-asst-1', role: 'assistant', content: [{ type: 'text', text: '在的' }] },
          },
        },
      },
      { type: 'event', event: { type: 'turn/end', seq: 4, time: 1_030, data: { turn: 1, reason: { kind: 'completed' } } } },
    ],
  }
  const snapshot = adapter.parseSnapshot(fixture)
  assertTrue(snapshot !== null, 'parseSnapshot 认出快照')
  const fresh = adapter.reduceSnapshot(snapshot!, SESSION)
  // 本地：一条缓存里的旧用户行（同一个 rpcId，应被回显取代）+ 一条还没回显的乐观行
  const local: ChatItem[] = [
    userMessage('cached-user', 1_010, { requestRpcId: 'rpc-0', text: '你好' }),
    userMessage('local-pending', 1_040, { requestRpcId: 'rpc-9', sendState: 'queued', text: '再问一句' }),
  ]
  const merged = mergeTimelineItems(local, fresh.items)
  const ids = idsOf(merged)
  assertEqual(ids.includes('cached-user'), false, '被回显的缓存行丢掉')
  assertEqual(ids.at(-1), 'local-pending', '未回显的乐观行接在最后')
  assertEqual(ids.includes('msg-asst-1'), true, '服务端正文都在')
  assertEqual(merged.length, fresh.items.length + 1, '只多出那一条乐观行')
})

/* ════════════════════════════════════════════════════════════════════════
 * E. 加载态
 * ════════════════════════════════════════════════════════════════════════ */

check('E1 sessionListViewState：内容 / 骨架 / 空 / 未连接', async () => {
  assertEqual(
    sessionListViewState({ rowCount: 3, ready: false, synced: false, syncing: false }),
    'content',
    '有缓存行就是内容（哪怕还没连上）',
  )
  assertEqual(
    sessionListViewState({ rowCount: 0, ready: true, synced: false, syncing: true }),
    'skeleton',
    '正在拉 → 骨架（不是「没有会话」）',
  )
  assertEqual(
    sessionListViewState({ rowCount: 0, ready: true, synced: false, syncing: false }),
    'skeleton',
    '还没拉过 → 骨架',
  )
  assertEqual(
    sessionListViewState({ rowCount: 0, ready: true, synced: true, syncing: false }),
    'empty',
    '服务端确认过才允许空态',
  )
  assertEqual(
    sessionListViewState({ rowCount: 0, ready: false, synced: true, syncing: false }),
    'idle',
    '没连上保留「未连接」',
  )
})

check('E2 timelineViewState：首次拉取没结束绝不 empty', async () => {
  assertEqual(
    timelineViewState({ itemCount: 0, loading: true, settled: false, failed: false }),
    'skeleton',
    '首次拉取中 → 骨架',
  )
  assertEqual(
    timelineViewState({ itemCount: 0, loading: false, settled: false, failed: false }),
    'skeleton',
    '没 settled 也没有行 → 还是骨架（不许说没有消息）',
  )
  assertEqual(
    timelineViewState({ itemCount: 0, loading: false, settled: true, failed: false }),
    'empty',
    '确认拉完且为空 → 空态',
  )
  assertEqual(
    timelineViewState({ itemCount: 0, loading: false, settled: true, failed: true }),
    'failed',
    '失败是失败，不是空',
  )
  assertEqual(
    timelineViewState({ itemCount: 2, loading: true, settled: false, failed: false }),
    'content',
    '有缓存行 → 内容（骨架只在没行时出现）',
  )
})

check('E3 timelineHintState：缓存直出 / 没同步上 / 拉完', async () => {
  assertEqual(
    timelineHintState({ itemCount: 2, fromCache: true, settled: false, failed: false }),
    'syncing',
    '缓存直出 + 快照未到 → 正在同步…',
  )
  assertEqual(
    timelineHintState({ itemCount: 2, fromCache: false, settled: true, failed: false }),
    'none',
    '服务端内容 → 不挂提示',
  )
  assertEqual(
    timelineHintState({ itemCount: 2, fromCache: true, settled: true, failed: true }),
    'failed',
    '缓存还在但这次失败了 → 说清楚',
  )
  assertEqual(
    timelineHintState({ itemCount: 0, fromCache: true, settled: false, failed: false }),
    'none',
    '没行时由主区域说话，不重复',
  )
})

/* ════════════════════════════════════════════════════════════════════════
 * F. store 接线
 * ════════════════════════════════════════════════════════════════════════ */

const lastSession = {
  serverUrl: SERVER,
  email: 'me@example.com',
  hostDeviceId: HOST,
  hostName: '书桌',
  savedAt: T0,
}

check('F1 hydrateCachedSessions：缓存铺进 sessions + cacheStatus（含 ghost 标注）', async () => {
  clearCacheKeys()
  // 一份「上次跑完」的缓存：两行正常 + 一行上次就标过已不存在
  writeSessionsCache({
    ...bucket({ now: Date.now() }),
    sessions: [
      { id: 's-1', title: '上次的会话', pinned: true, updatedAt: T0 - 1_000 },
      { id: 's-2', title: '另一个', updatedAt: T0 - 2_000 },
      { id: 's-gone', title: '上次就没了', updatedAt: T0 - 3_000, missingAt: T0 - 500 },
    ],
  })
  useRemoteStore.setState({
    phase: 'connecting',
    sessions: [],
    activeSessionId: null,
    lastSession,
    cacheStatus: cache.emptyCacheStatus(),
  })
  useRemoteStore.getState().hydrateCachedSessions()
  const state = useRemoteStore.getState()
  assertEqual(state.sessions.length, 3, '三行缓存都铺上（不等 session/list）')
  assertEqual(state.sessions[0]?.id, 's-1', '置顶在前')
  assertEqual(state.cacheStatus.sessionsFromCache, true, '标记「来自缓存」→ UI 挂「正在同步」小标')
  assertEqual(state.cacheStatus.sessionsSynced, false, '还没跟服务端对过')
  assertEqual(state.cacheStatus.ghostSessionIds, ['s-gone'], '上次标过的还标着')
})

check('F2 hydrateCachedSessions：已有实时列表就不拿缓存盖回去', async () => {
  useRemoteStore.setState({
    sessions: [{ id: 'live-1', title: '实时列表' }],
    cacheStatus: { ...cache.emptyCacheStatus(), sessionsSynced: true },
  })
  useRemoteStore.getState().hydrateCachedSessions()
  assertEqual(useRemoteStore.getState().sessions.map(row => row.id), ['live-1'], '实时列表不被覆盖')
  assertEqual(useRemoteStore.getState().cacheStatus.sessionsFromCache, false, '不标成缓存')
})

check('F3 全程没发过任何网络请求', async () => {
  assertEqual(fetchCalls, 0, `缓存路径不该联网（实际 ${fetchCalls} 次）`)
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
