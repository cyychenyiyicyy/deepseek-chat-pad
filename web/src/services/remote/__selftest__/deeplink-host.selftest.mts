/**
 * R14 自测：**点通知直达会话**（`deepLink.ts`）+ **多 Host 切换**（`store.ts` 的切换编排）。
 *
 * 跑法（workdir = projects\deepseek-tablet\web）：
 *   npx tsx src/services/remote/__selftest__/deeplink-host.selftest.mts
 *
 * 不联网：`fetch` / 定时器 / store 动作全部是桩；只有两处读**真模块**：
 *   - `deepLink.ts` 的控制器与回包解析（纯逻辑）；
 *   - `store.ts` 里被抽出来的纯函数（`toHostInfoList` / `resolveHostSwitchTarget` /
 *     `performHostSwitch` / `hostNameOf`）—— 真连接（Noise / WS）不在本文件覆盖范围内，
 *     这里保证的是**决策与回滚**：离线不许切、失败要回到原来那台、报告的状态顺序正确。
 *
 * 覆盖清单：
 *   A. 原生回包解析（6）
 *     1. 正常回包 → supported + pendingSessionId + rev；
 *     2. 空 id → supported 但没东西可开；
 *     3. 404 → no-endpoint（旧 APK）；
 *     4. 200 + HTML（SPA 兜底）→ no-endpoint；
 *     5. fetch 抛错 → unreachable（**不**禁用，下次回前台还能试）；
 *     6. 请求形状：路径 / GET / no-store / credentials=omit。
 *   B. 幂等（4）
 *     7. 原生「读后清空」：两次 poll，只有第一次拿到 id → openSession 只 1 次；
 *     8. 原生重复回同一条（rev 相同）→ 仍然只 1 次；
 *     9. `rev` 变了（用户又点了一次）→ 允许再开一次；
 *    10. 已经在这个会话里（activeSessionId 命中）→ 不再 openSession（但仍切远程模式）。
 *   C. 等连接 / 会话不在（4）
 *    11. 点通知时还没连上 → 先切远程模式，ready 之后才 openSession；
 *    12. 一直连不上 → toast「还没连上电脑」，不 openSession；
 *    13. 列表缺行 → 强制同步一次，仍缺 → toast「会话已不存在」；
 *    14. 列表缺行但同步后有 → 正常打开（缓存缺行 ≠ 会话不存在）。
 *   D. 多 Host（8）
 *    15. `toHostInfoList`：身份不符 → `online:false` + `identityMismatch:true`；无平台不带该字段；
 *    16. `resolveHostSwitchTarget`：未知 / 离线 / 身份不符 三个错误码；
 *    17. 离线目标：**不拆连接、不发连接**，报告 failed + HOST_OFFLINE；
 *    18. 同一台：不拆连接，报告 idle，返回 true；
 *    19. 切换成功：disconnect 一次 → connect(target) 一次，report 顺序 switching → idle；
 *    20. 切换失败：connect(target) 抛 → **自动连回原 Host**，报告 failed + rolledBackTo；
 *    21. 回滚也失败：报告 failed 但没有 rolledBackTo（连接停在 error，界面仍有「重试」）；
 *    22. `hostNameOf`：名字为空时回 id 前 8 位（永不空串）。
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
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) fail(`${label}：期望 ${e}，实际 ${a}`)
}

const assertTrue = (value: boolean, label: string): void => {
  if (!value) fail(label)
}

const assertContains = (haystack: string, needle: string, label: string): void => {
  if (!haystack.includes(needle)) fail(`${label}：${JSON.stringify(haystack)} 里没有 ${JSON.stringify(needle)}`)
}

/** 断言一段 async 代码抛出的错误码（`RemoteApiError` 的 code） */
const assertThrowsCode = async (run: () => unknown, expected: string, label: string): Promise<void> => {
  try {
    await run()
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    if (code !== expected) fail(`${label}：期望错误码 ${expected}，实际 ${String(code)}`)
    return
  }
  fail(`${label}：应该抛 ${expected}，但没有抛`)
}

/* ── 先装 localStorage 桩，再加载 store（它在模块初始化时会读一次盘） ─── */

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

/*
 * 故意**不**装 `document` / `window`：`deepLink.install()` 与 store 的几条 `visibilitychange`
 * 订阅都有 `typeof` 守卫，这里正好顺带验证「没有浏览器环境也不会炸」。
 */

const storeModule = await import('../store.js')
const { performHostSwitch, resolveHostSwitchTarget, toHostInfoList, hostNameOf } = storeModule
type HostSwitchRuntime = import('../store.js').HostSwitchRuntime
type RemoteHostInfo = import('../store.js').RemoteHostInfo
type HostSwitchState = import('../store.js').HostSwitchState

const deepLinkModule = await import('../deepLink.js')
const { createDeepLinkController, readPendingSession, DEEP_LINK_OPEN_PATH, DEEP_LINK_READY_TIMEOUT_MS } =
  deepLinkModule
type DeepLinkDeps = import('../deepLink.js').DeepLinkDeps
type DeepLinkSnapshot = import('../deepLink.js').DeepLinkSnapshot

/* ── 假 fetch：按「第几次调用」给不同回包，并记下请求形状 ─────────────── */

interface FetchPlan {
  status: number
  /** 回包正文（字符串原样返回；用来模拟 JSON 与 HTML 两种） */
  body: string
}

interface FetchRecorder {
  fetch: (input: string, init: RequestInit) => Promise<Response>
  calls: Array<{ path: string; method: string; cache: string | undefined; credentials: string | undefined }>
  remaining: () => number
}

const recorderOf = (plans: FetchPlan[]): FetchRecorder => {
  const queue = [...plans]
  const calls: FetchRecorder['calls'] = []
  return {
    calls,
    remaining: () => queue.length,
    fetch: async (input: string, init: RequestInit): Promise<Response> => {
      calls.push({
        path: input,
        method: init.method ?? 'GET',
        cache: init.cache,
        credentials: init.credentials,
      })
      // 队列空了之后一直回「没有待处理」：模拟原生「读后清空」
      const plan = queue.shift() ?? { status: 200, body: JSON.stringify({ ok: true, pendingSessionId: '', rev: 0 }) }
      return new Response(plan.body, { status: plan.status })
    },
  }
}

const jsonReply = (pendingSessionId: string, rev: number): FetchPlan => ({
  status: 200,
  body: JSON.stringify({ ok: true, hasPending: pendingSessionId.length > 0, pendingSessionId, rev }),
})

/* ── 假定时器：每一拍 = 「5 秒后」 ─────────────────────────────────────── */

/**
 * `schedule` 立刻（微任务）执行，`now()` 按「第几拍 × 5s」推进。
 * 这样「等连接」的循环最多 4 拍就超时（4 × 5s = 20s = `DEEP_LINK_READY_TIMEOUT_MS`），
 * 不需要真的等 20 秒，也不需要手工泵事件循环。
 */
const timersOf = () => {
  let ticks = 0
  return {
    get ticks(): number {
      return ticks
    },
    now: (): number => ticks * 5_000,
    schedule: (fn: () => void): unknown => {
      ticks += 1
      queueMicrotask(fn)
      return ticks
    },
  }
}

/* ── 假 store 门面：记录「打开过谁 / 同步过几次」 ──────────────────────── */

interface FacadeOptions {
  /** 每拍都重新求值：用来模拟「建链中 → ready」 */
  phase?: () => string
  activeSessionId?: string | null
  /** 会话列表（每次求值，用来模拟「刷新之后才出现」） */
  sessions?: () => { id: string }[]
  /** `refreshSessions()` 被调用时跑一下（可以把列表换成有那一行的版本） */
  onRefresh?: () => void
}

const facadeOf = (options: FacadeOptions = {}) => {
  const opened: string[] = []
  let refreshes = 0
  const store = {
    snapshot: (): DeepLinkSnapshot => ({
      phase: options.phase === undefined ? 'ready' : options.phase(),
      activeSessionId: options.activeSessionId ?? null,
      sessions: options.sessions === undefined ? [] : options.sessions(),
    }),
    openSession: (sessionId: string): void => {
      opened.push(sessionId)
    },
    refreshSessions: (): void => {
      refreshes += 1
      options.onRefresh?.()
    },
  }
  return {
    store,
    opened,
    refreshes: () => refreshes,
  }
}

/** 造一个控制器（默认每拍重新求值的时钟 + 手动 schedule 之外的默认值都在这里统一） */
const controllerOf = (overrides: Partial<DeepLinkDeps> & { store: DeepLinkDeps['store'] }) => {
  const timers = timersOf()
  const toasts: string[] = []
  let modeSwitches = 0
  const controller = createDeepLinkController({
    now: timers.now,
    schedule: timers.schedule,
    toast: (message: string) => {
      toasts.push(message)
    },
    enterRemoteMode: () => {
      modeSwitches += 1
    },
    ...overrides,
    store: overrides.store,
  } as DeepLinkDeps)
  return {
    controller,
    timers,
    toasts,
    modeSwitches: () => modeSwitches,
  }
}

/* ════════════════════════════════════════════════════════════════════════
 * A. 原生回包解析
 * ════════════════════════════════════════════════════════════════════════ */

check('1. 正常回包 → supported / pendingSessionId / rev', async () => {
  const recorder = recorderOf([jsonReply('s-1', 7)])
  const result = await readPendingSession({ fetch: recorder.fetch })
  assertEqual(result, { supported: true, pendingSessionId: 's-1', rev: 7 }, '回包投影')
})

check('2. 空 id → supported 但没有要开的会话', async () => {
  const recorder = recorderOf([jsonReply('', 3)])
  const result = await readPendingSession({ fetch: recorder.fetch })
  assertEqual(result, { supported: true, pendingSessionId: '', rev: 3 }, '空 id 投影')
})

check('3. 404 → no-endpoint（旧 APK）', async () => {
  const recorder = recorderOf([{ status: 404, body: '' }])
  const result = await readPendingSession({ fetch: recorder.fetch })
  assertEqual(result, { supported: false, reason: 'no-endpoint' }, '404 判定')
})

check('4. 200 + HTML（SPA 兜底）→ no-endpoint', async () => {
  const recorder = recorderOf([{ status: 200, body: '<!doctype html><html><body>chat</body></html>' }])
  const result = await readPendingSession({ fetch: recorder.fetch })
  assertEqual(result, { supported: false, reason: 'no-endpoint' }, 'HTML 判定')
})

check('5. fetch 抛错 → unreachable（不禁用）', async () => {
  const result = await readPendingSession({
    fetch: () => Promise.reject(new Error('boom')),
  })
  assertEqual(result, { supported: false, reason: 'unreachable' }, '网络失败判定')
})

check('6. 请求形状：GET /__ds_notify/open.json + no-store + omit', async () => {
  const recorder = recorderOf([jsonReply('', 0)])
  await readPendingSession({ fetch: recorder.fetch })
  assertEqual(recorder.calls.length, 1, '只打一次')
  const call = recorder.calls[0]!
  assertEqual(call.path, DEEP_LINK_OPEN_PATH, '路径')
  assertEqual(call.path, '/__ds_notify/open.json', '路径常量')
  assertEqual(call.method, 'GET', '方法')
  assertEqual(call.cache, 'no-store', 'cache 策略')
  assertEqual(call.credentials, 'omit', 'cookie 策略')
})

/* ════════════════════════════════════════════════════════════════════════
 * B. 幂等
 * ════════════════════════════════════════════════════════════════════════ */

check('7. 读后清空：两次 poll 只开一次', async () => {
  const recorder = recorderOf([jsonReply('s-1', 1)])
  const facade = facadeOf({ sessions: () => [{ id: 's-1' }] })
  const { controller, modeSwitches } = controllerOf({ store: facade.store, fetch: recorder.fetch })
  await controller.poll()
  await controller.poll()
  assertEqual(recorder.calls.length, 2, '两次 poll 各打一次原生')
  assertEqual(facade.opened, ['s-1'], '只开一次')
  assertTrue(modeSwitches() >= 1, '拿到 id 后切到了远程模式')
})

check('8. 原生重复回同一条（rev 相同）→ 仍然只开一次', async () => {
  const recorder = recorderOf([jsonReply('s-1', 5), jsonReply('s-1', 5)])
  const facade = facadeOf({ sessions: () => [{ id: 's-1' }] })
  const { controller } = controllerOf({ store: facade.store, fetch: recorder.fetch })
  await controller.poll()
  await controller.poll()
  assertEqual(facade.opened, ['s-1'], '同一次投递不重复开')
})

check('9. rev 变了（用户又点了一次）→ 允许再开', async () => {
  const recorder = recorderOf([jsonReply('s-1', 5), jsonReply('s-1', 6)])
  const facade = facadeOf({ sessions: () => [{ id: 's-1' }] })
  const { controller } = controllerOf({ store: facade.store, fetch: recorder.fetch })
  await controller.poll()
  await controller.poll()
  assertEqual(facade.opened, ['s-1', 's-1'], '新的一次投递要真的开')
})

check('10. 已经在这个会话里 → 不再 openSession（但仍切远程模式）', async () => {
  const recorder = recorderOf([jsonReply('s-1', 9)])
  const facade = facadeOf({ activeSessionId: 's-1', sessions: () => [{ id: 's-1' }] })
  const { controller, modeSwitches } = controllerOf({ store: facade.store, fetch: recorder.fetch })
  await controller.poll()
  assertEqual(facade.opened, [], '不重复打开')
  assertEqual(modeSwitches(), 1, '模式切换照做')
})

/* ════════════════════════════════════════════════════════════════════════
 * C. 等连接 / 会话不存在
 * ════════════════════════════════════════════════════════════════════════ */

check('11. 还没连上 → 先切远程模式，ready 之后才 openSession', async () => {
  const timers = timersOf()
  const recorder = recorderOf([jsonReply('s-1', 1)])
  const order: string[] = []
  const facade = facadeOf({
    phase: () => (timers.ticks >= 2 ? 'ready' : 'connecting'),
    sessions: () => [{ id: 's-1' }],
  })
  const { controller } = controllerOf({
    store: {
      snapshot: () => {
        const snapshot = facade.store.snapshot()
        order.push(`phase=${snapshot.phase}`)
        return snapshot
      },
      openSession: (id: string) => {
        order.push(`open:${id}`)
        facade.store.openSession(id)
      },
      refreshSessions: facade.store.refreshSessions,
    },
    fetch: recorder.fetch,
    now: timers.now,
    schedule: timers.schedule,
  })
  await controller.poll()
  assertEqual(facade.opened, ['s-1'], 'ready 之后打开')
  assertTrue(order.filter((item) => item === 'phase=connecting').length >= 2, '确实等了两拍')
  assertEqual(order[order.length - 1], 'open:s-1', '最后一次是打开')
})

check('12. 一直连不上 → toast「还没连上电脑」，不开会话', async () => {
  const recorder = recorderOf([jsonReply('s-1', 1)])
  const facade = facadeOf({ phase: () => 'connecting', sessions: () => [{ id: 's-1' }] })
  const { controller, toasts } = controllerOf({ store: facade.store, fetch: recorder.fetch })
  await controller.poll()
  assertEqual(facade.opened, [], '不打开')
  assertEqual(toasts.length, 1, '只提示一次')
  assertContains(toasts[0]!, '还没连上电脑', '提示文案')
  assertTrue(DEEP_LINK_READY_TIMEOUT_MS > 0, '超时常量存在')
})

check('13. 列表缺行 → 同步一次仍缺 → toast「会话已不存在」', async () => {
  const recorder = recorderOf([jsonReply('s-404', 1)])
  const facade = facadeOf({ sessions: () => [{ id: 's-1' }] })
  const { controller, toasts } = controllerOf({ store: facade.store, fetch: recorder.fetch })
  await controller.poll()
  assertEqual(facade.refreshes(), 1, '强制同步一次')
  assertEqual(facade.opened, [], '不打开')
  assertEqual(toasts.length, 1, '提示一次')
  assertContains(toasts[0]!, '会话已不存在', '提示文案')
})

check('14. 同步之后列表里有 → 正常打开（缓存缺行 ≠ 不存在）', async () => {
  const recorder = recorderOf([jsonReply('s-2', 1)])
  let rows = [{ id: 's-1' }]
  const facade = facadeOf({
    sessions: () => rows,
    onRefresh: () => {
      rows = [{ id: 's-1' }, { id: 's-2' }]
    },
  })
  const { controller, toasts } = controllerOf({ store: facade.store, fetch: recorder.fetch })
  await controller.poll()
  assertEqual(facade.refreshes(), 1, '同步一次')
  assertEqual(facade.opened, ['s-2'], '同步后打开')
  assertEqual(toasts, [], '不该有提示')
})

/* ════════════════════════════════════════════════════════════════════════
 * D. 多 Host
 * ════════════════════════════════════════════════════════════════════════ */

/** 造一份「两台在线 + 一台离线 + 一台身份不符」的 Host 列表 */
const hostList = (): RemoteHostInfo[] =>
  toHostInfoList([
    { deviceId: 'dev-desk', name: '台式机', platform: 'win32', online: true },
    { deviceId: 'dev-pad', name: '平板', online: true },
    { deviceId: 'dev-off', name: '旧笔记本', online: false },
    { deviceId: 'dev-bad', name: '可疑主机', online: false, identityMismatch: true },
  ])

/**
 * 切换编排的桩：记录每一次 disconnect / connect，并可以让指定的 Host「连失败」。
 */
const runtimeOf = (options: {
  hosts?: RemoteHostInfo[]
  currentId?: string | null
  currentName?: string | null
  failFor?: string[]
}) => {
  const steps: string[] = []
  const reports: HostSwitchState[] = []
  const hosts = options.hosts ?? hostList()
  const failing = new Set(options.failFor ?? [])
  const runtime: HostSwitchRuntime = {
    hosts: () => hosts,
    currentHostId: () => options.currentId ?? null,
    currentHostName: () => options.currentName ?? null,
    disconnect: async () => {
      steps.push('disconnect')
    },
    connect: async (hostDeviceId: string) => {
      steps.push(`connect:${hostDeviceId}`)
      if (failing.has(hostDeviceId)) {
        const error = new Error(`连不上 ${hostDeviceId}`) as Error & { code: string }
        error.code = 'WS_CLOSED'
        throw error
      }
    },
    report: (state: HostSwitchState) => {
      reports.push(state)
    },
  }
  return { runtime, steps, reports }
}

check('15. toHostInfoList：身份不符按离线算、无平台不带字段', async () => {
  const list = hostList()
  assertEqual(list.length, 4, '四台都列出来（身份不符的也要让用户看见）')
  const bad = list.find((host) => host.deviceId === 'dev-bad')!
  assertEqual({ online: bad.online, mismatch: bad.identityMismatch }, { online: false, mismatch: true }, '身份不符')
  const pad = list.find((host) => host.deviceId === 'dev-pad')!
  assertEqual('platform' in pad, false, '没有平台就不带该字段')
  assertEqual(pad.online, true, '在线')
  const off = list.find((host) => host.deviceId === 'dev-off')!
  assertEqual(off.online, false, '离线')
})

check('16. resolveHostSwitchTarget：未知 / 离线 / 身份不符 三种拒绝', async () => {
  const hosts = hostList()
  await assertThrowsCode(() => resolveHostSwitchTarget(hosts, 'nope'), 'HOST_UNKNOWN', '未知 host')
  await assertThrowsCode(() => resolveHostSwitchTarget(hosts, 'dev-off'), 'HOST_OFFLINE', '离线 host')
  await assertThrowsCode(() => resolveHostSwitchTarget(hosts, 'dev-bad'), 'HOST_IDENTITY_MISMATCH', '身份不符')
  assertEqual(resolveHostSwitchTarget(hosts, 'dev-desk').deviceId, 'dev-desk', '在线的可以切')
})

check('17. 离线目标：不拆连接、不发连接，报告 HOST_OFFLINE', async () => {
  const { runtime, steps, reports } = runtimeOf({ currentId: 'dev-desk', currentName: '台式机' })
  const ok = await performHostSwitch(runtime, 'dev-off')
  assertEqual(ok, false, '返回失败')
  assertEqual(steps, [], '一行连接操作都不做')
  assertEqual(reports.length, 1, '只报告一次')
  assertEqual(reports[0]!.status, 'failed', '状态')
  assertEqual(reports[0]!.code, 'HOST_OFFLINE', '错误码')
  assertContains(reports[0]!.message ?? '', '不在线', '原因可读')
})

check('18. 切到当前这台：不拆连接，report idle，返回 true', async () => {
  const { runtime, steps, reports } = runtimeOf({ currentId: 'dev-desk' })
  const ok = await performHostSwitch(runtime, 'dev-desk')
  assertEqual(ok, true, '视为成功')
  assertEqual(steps, [], '不打断正在用的连接')
  assertEqual(reports, [{ status: 'idle' }], '回到 idle')
})

check('19. 切换成功：disconnect → connect(target)，report switching → idle', async () => {
  const { runtime, steps, reports } = runtimeOf({ currentId: 'dev-desk', currentName: '台式机' })
  const ok = await performHostSwitch(runtime, 'dev-pad')
  assertEqual(ok, true, '成功')
  assertEqual(steps, ['disconnect', 'connect:dev-pad'], '先拆后连')
  assertEqual(reports.map((item) => item.status), ['switching', 'idle'], '状态顺序')
  assertEqual(reports[0]!.targetName, '平板', 'switching 带目标名（loading 文案要用）')
})

check('20. 切换失败 → 自动连回原 Host，报告 rolledBackTo', async () => {
  const { runtime, steps, reports } = runtimeOf({
    currentId: 'dev-desk',
    currentName: '台式机',
    failFor: ['dev-pad'],
  })
  const ok = await performHostSwitch(runtime, 'dev-pad')
  assertEqual(ok, false, '失败')
  assertEqual(steps, ['disconnect', 'connect:dev-pad', 'connect:dev-desk'], '回滚到原 Host')
  const last = reports[reports.length - 1]!
  assertEqual(last.status, 'failed', '状态')
  assertEqual(last.code, 'WS_CLOSED', '错误码透传')
  assertEqual(last.rolledBackTo, '台式机', '已回到原 Host')
})

check('21. 回滚也失败 → 报告 failed 但没有 rolledBackTo', async () => {
  const { runtime, steps, reports } = runtimeOf({
    currentId: 'dev-desk',
    currentName: '台式机',
    failFor: ['dev-pad', 'dev-desk'],
  })
  const ok = await performHostSwitch(runtime, 'dev-pad')
  assertEqual(ok, false, '失败')
  assertEqual(steps, ['disconnect', 'connect:dev-pad', 'connect:dev-desk'], '两次都试过')
  const last = reports[reports.length - 1]!
  assertEqual(last.status, 'failed', '状态')
  assertEqual(last.rolledBackTo, undefined, '没有回滚成功')
})

check('22. hostNameOf：名字为空回 id 前 8 位', async () => {
  const hosts = toHostInfoList([{ deviceId: 'device-abcdefgh', name: '   ', online: true }])
  assertEqual(hostNameOf(hosts, 'device-abcdefgh'), 'device-a', '退化到 id 前缀')
  assertEqual(hostNameOf(hosts, 'missing'), 'missing', '找不到也回 id 前缀（短 id 原样）')
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
