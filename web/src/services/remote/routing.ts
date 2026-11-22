/**
 * 会话路由（帧归属判定）。
 *
 * ── 这份文件的来源 ──────────────────────────────────────────────────────
 * 按用户要求，规则**照 dsh-Go 的 Dart 实现逐段翻译**，不再自己发明。对应关系：
 *
 * | dsh-Go（Dart）                                              | 这里（TS）                                  |
 * |-------------------------------------------------------------|---------------------------------------------|
 * | `session_api.dart:1086-1102` `_forwardHost` 的 `when x.sessionId == sessionId` | `belongsToSession()`        |
 * | `session_api.dart:1325` `_checkHistoryOwner(epoch)`          | `historyOwnerIsCurrent()`                   |
 * | `session_api.dart:1169-1176` `_epoch = SessionFollowEpoch()` | `newFollowEpoch()` + `followEpochIsCurrent()` |
 * | `remote_account.dart:690-691` `bool isCurrent() => epoch == …` | `followEpochIsCurrent()` 的 `isCurrent` 语义 |
 * | `chat_state.dart:535-545` `_currentOperation` / `_requireCurrent` | `followEpochIsCurrent()` + `flowIsCurrent()`（store） |
 * | `chat_state.dart:1288-1297` `_dropEchoed`（按 `requestId` 对齐） | `isOptimisticEcho()`（再叠 sessionId，见下）  |
 * | `transcript.dart:159` `class ChatTranscript`（**每会话一份**）  | `store.ts` 的 `ActiveSession.transcripts`（`Map<sessionId, transcript>`） |
 * | `transcript.dart:418-425` `ChatTranscript.prependHistory`      | `store.ts` `loadOlderFlow` 的归属守卫        |
 *
 * 唯一必须在**调用点**补的是「会话维度」：Dart 里 `ChatController` 每个会话一个实例
 * （`chat_state.dart:462-465`），`_pending` / `_transcript` / `sessionId` 都是这个实例的
 * 字段，所以「这条数据属于哪个会话」由**对象身份**决定，代码里不需要再比一次。
 * 我们是**单 store、单活动会话**（见 `store.ts` 的 `ActiveSession`），没有那个天然隔离，
 * 所以把 Dart 里靠对象身份表达的约束，改成显式比较 sessionId —— 语义相同，只是写法不同。
 *
 * ── 纪律 ────────────────────────────────────────────────────────────────
 *   1. 帧只认**自带 sessionId 且与目标会话严格相等**的（Dart 的 `when … == sessionId`）；
 *   2. 丢弃不静默：记进 `__dsDebug.sessionDrops`，但**默认不打日志**
 *      （这条路径每帧都走，刷日志等于给真机主线程加负载）；
 *   3. 全是纯函数 + 一个模块级计数器：不依赖 React / store / 网络，tsx 自测可反复调用。
 */

/* ────────────────────────────────────────────────────────────────────────
 * 一、帧归属（Dart：`_forwardHost` 的 `when … sessionId == sessionId`）
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 这条帧是不是**这个会话**的。
 *
 * 对应 `session_api.dart:1086-1102`：Host 级事件（审批 / 提问 / 状态 / 错误 / 移除）
 * 全部在 `_forwardHost` 里用 `when x.sessionId == sessionId` 挡一遍，**不匹配的直接落到
 * `default: break`** —— 也就是丢掉。这里是同一件事。
 *
 * 两个都必须是非空字符串且相等：
 *   - 会话还没开（`null`）→ 任何帧都没有归宿；
 *   - 帧不带 `sessionId` → **认不出是谁的就当别人的**（fail-closed）。
 *     写松成 `undefined == null` 之类的松比较，「不知道」就变成「都收」，而「都收」
 *     正是串台的入口。
 */
export const belongsToSession = (
  sessionId: string | null | undefined,
  eventSessionId: string | null | undefined,
): boolean =>
  typeof sessionId === 'string' &&
  sessionId.length > 0 &&
  sessionId === eventSessionId

/**
 * 缓存桶键校验（Dart 没有缓存层，这是我们自己的：`cache.ts` 按
 * `serverUrl + hostDeviceId + sessionId` 分桶）。
 *
 * 判据与 `belongsToSession` 相同，单独起名是为了让调用点说清楚「我在校验桶键」——
 * 写错桶比画错时间线更难发现：下次打开才看见，而且那时缓存已经当真了。
 */
export const acceptCacheWrite = (
  bucketSessionId: string | null | undefined,
  contentSessionId: string | null | undefined,
): boolean => belongsToSession(bucketSessionId, contentSessionId)

/**
 * 乐观行 / 回显对齐：`requestRpcId` 相同**不够**，必须同会话。
 *
 * Dart 的做法（`chat_state.dart:1288-1297` `_dropEchoed`）是拿回显事件里的
 * `requestId` 去 `_pending` 里删 —— 而 `_pending` 属于某个 `ChatController`，
 * 也就是天然带上了 sessionId（`chat_state.dart:462-476`）。
 * 我们的 `transcript.items` 是单一列表，所以必须显式带上 sessionId，
 * 否则「A 的乐观行落在 B 的列表里」会被 B 的回显认领，行就真的换了会话。
 */
export const isOptimisticEcho = (
  item: { sessionId?: string | undefined; requestRpcId?: string | undefined },
  sessionId: string,
  requestRpcId: string,
): boolean =>
  item.requestRpcId === requestRpcId &&
  typeof item.sessionId === 'string' &&
  item.sessionId === sessionId

/* ────────────────────────────────────────────────────────────────────────
 * 二、每会话一份 transcript 的登记表
 *     （Dart：`ChatController` 手里的那个 `ChatTranscript`，`chat_state.dart:465`）
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 登记表形状：`sessionId → 该会话的 transcript`。
 *
 * dsh-Go 那边每个会话一个 `ChatController`，`_transcript` 是它的字段 —— 一个会话
 * **不可能**拿到另一个会话的 transcript。我们是单连接单活动会话，所以用这张表
 * 把同样的隔离显式表达出来：写的时候只按 frame 自带的 sessionId 落格。
 */
export type SessionTranscriptRegistry<T> = Map<string, T>

export interface CommitTranscriptResult {
  /** 内容已经归到它自己的格子（无论当前显示的是不是它） */
  stored: boolean
  /** 同时推给了屏幕 —— 只有当它就是活动会话时 */
  shown: boolean
}

/**
 * 把一次归约结果提交到**它自己那个会话**的格子（`ChatTranscript.apply()` 的等价物）。
 *
 * 三条规则，一一对应 Dart 的结构：
 *   1. sessionId 为空 → 无处安放，丢弃（`stored:false`）；
 *   2. 一律写进 `registry[sessionId]` —— 哪怕此刻显示的是别的会话；
 *   3. 只有 `sessionId === activeSessionId` 才「当面」（`shown:true`），调用方据此决定要不要刷新 UI。
 *
 * 第 2 条是串台的结构性解药：孤儿 follow 流的帧只会更新**它自己那个会话**的格子，
 * 不可能再落进「当时正好开着的会话」。
 */
export const commitSessionTranscript = <T>(
  registry: SessionTranscriptRegistry<T>,
  sessionId: string,
  activeSessionId: string | null,
  next: T,
): CommitTranscriptResult => {
  if (sessionId.length === 0) {
    return { stored: false, shown: false }
  }
  registry.set(sessionId, next)
  return { stored: true, shown: sessionId === activeSessionId }
}

/**
 * 淘汰最久没用的格子，把表压到 `limit` 以内；返回被删掉的会话 id。
 *
 * dsh-Go 的 controller 跟着页面活，数量由用户开过多少会话决定；我们的表挂在连接上，
 * 长时间用会一直涨，所以要有个上限。**永远不淘汰活动会话**（正在看的那份不能掉）。
 */
export const trimSessionTranscripts = <T>(
  registry: SessionTranscriptRegistry<T>,
  activeSessionId: string | null,
  limit: number,
): string[] => {
  const removed: string[] = []
  while (registry.size > limit && limit >= 0) {
    let victim: string | undefined
    for (const key of registry.keys()) {
      if (key === activeSessionId) {
        continue
      }
      victim = key
      break
    }
    if (victim === undefined) {
      break
    }
    registry.delete(victim)
    removed.push(victim)
  }
  return removed
}

/* ────────────────────────────────────────────────────────────────────────
 * 三、follow 代际（Dart：`SessionFollowEpoch` + `_canControl` / `_requireCurrent`）
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 一条 follow 流开出去时领的「代际工牌」。
 *
 * 对应 `session_api.dart:1169/1176` 的 `_epoch = SessionFollowEpoch(generation: …)`
 * 与 `chat_state.dart:529-545` 的 `_canControl` / `_currentOperation`：
 * 每次开流领一个新 epoch，异步回来的每一段都先问「我这个 epoch 还是不是最新的」。
 *
 * 为什么必须比 epoch（而不只是比 sessionId）：`openSession` 是 async，用户连点
 * A→B 时两条流程会交错；`A→B→A` 绕回去时 sessionId 又对上了，只有 epoch 能证明
 * 「我这条流已经被顶掉了」。
 */
export interface FollowEpochTicket {
  sessionId: string
  epoch: number
}

/** 与工牌比对的「当下」：活动会话 + 当前最新 epoch。 */
export interface FollowEpochCursor {
  sessionId: string | null
  epoch: number
}

/** 领一张新工牌（`store.ts` 的 `newFlowTicket` 调用它取新 epoch）。 */
export const newFollowEpoch = (sessionId: string, currentEpoch: number): FollowEpochTicket => ({
  sessionId,
  epoch: currentEpoch + 1,
})

/**
 * 这张工牌还作不作数（Dart `isCurrent()`：会话没换、epoch 没被顶掉）。
 *
 * 返回 false 的流一律：不再写 transcript、不覆盖 `session.follow`、
 * 自己开出来的句柄立刻关掉 —— 否则就是一条永远收不到 `close` 的孤儿流，
 * 而孤儿流的每一帧都会落进「当时正好开着的会话」里（串台的真正来源）。
 */
export const followEpochIsCurrent = (
  ticket: FollowEpochTicket,
  cursor: FollowEpochCursor,
): boolean =>
  typeof ticket.sessionId === 'string' &&
  ticket.sessionId.length > 0 &&
  ticket.sessionId === cursor.sessionId &&
  ticket.epoch === cursor.epoch

/**
 * 「这一代是不是最新一代」（**只比 epoch，不比 sessionId**）。
 *
 * 为什么不能拿 `followEpochIsCurrent()` 做「开新流的让位判定」：那个函数问的是
 * 「我服务的会话还是不是当下这个会话」，要求 `ticket.sessionId === cursor.sessionId`。
 * 而 `openSessionFlow(id)` 做检查时**正要切过去** —— `session.sessionId` 还停在旧值
 *（刚连上是 `null`，否则是上一个会话），工牌里已经是**目标** id，一比较必然不等。
 * 于是每一次「点会话 / 从空态打开会话 / 重连后重开上次的会话」都被误判成
 * 「上一代的迟到流程」，静默 `return`。
 *
 * 真机表现（v1.13.0 起）：会话列表点了没反应，右侧永远停在「选择一个会话」；
 * 计数器上只有 `__dsDebug.sessionDrops.staleFlow` 一路涨。
 *
 * 这里问的是另一个问题：**我这一代还是不是最新一代**。连点 A→B 时 A 的 epoch 被 B
 * 顶掉 → false（旧流程照样作废，不会串台）；从空态打开 A、或重开当前会话 → true。
 */
export const followEpochTurnIsCurrent = (ticket: FollowEpochTicket, currentEpoch: number): boolean =>
  ticket.epoch === currentEpoch

/**
 * 翻页归属（Dart `session_api.dart:1325` `_checkHistoryOwner(epoch)`）：
 * `pageHistory` 回来时，发起它的那条 watch 必须还是当前那条。
 */
export const historyOwnerIsCurrent = (
  ownerTicket: FollowEpochTicket,
  cursor: FollowEpochCursor,
): boolean => followEpochIsCurrent(ownerTicket, cursor)

/* ────────────────────────────────────────────────────────────────────────
 * 四、丢弃计数（`__dsDebug.sessionDrops`）
 * ──────────────────────────────────────────────────────────────────────── */

/** 丢弃原因：每个字段对应一类入口，排查时先看哪个在涨。 */
export interface SessionDropCounters {
  /** 帧自带的 sessionId 与目标会话不符（`$events` / `session/follow` 入口） */
  frame: number
  /** 已被切走 / 重开：还在飞的旧 follow 流帧或它的收尾 */
  staleFlow: number
  /** 异步动作回来时会话已经换了（发送回写 / 翻页 / 审批落定） */
  staleAction: number
  /** 缓存桶写入的 sessionId 与内容归属不一致（宁可少写一屏，也不写错桶） */
  cache: number
  /** 回显的 sessionId 与乐观行不符（`(sessionId, requestRpcId)` 二元组没对齐） */
  echo: number
}

export interface SessionDrops extends SessionDropCounters {
  /** 上面几项之和（真机上先看它涨不涨，再逐项定位） */
  total: number
}

export type SessionDropKind = keyof SessionDropCounters

const zeroDrops = (): SessionDrops => ({ frame: 0, staleFlow: 0, staleAction: 0, cache: 0, echo: 0, total: 0 })

/** 当前页面的丢弃计数（模块级：随页面生命周期；重连不清零，方便累计观察） */
const drops = zeroDrops()

let debugInstalled = false

/**
 * 把计数器挂到 `globalThis.__dsDebug.sessionDrops`（**幂等**）。
 *
 * 真机排查用法：
 *   `__dsDebug.sessionDrops`        → 当下计数（getter，每次拿到的都是最新值）
 *   `__dsDebug.resetSessionDrops()` → 清零，再做一次复现动作
 *
 * 默认**不打任何日志**：这条路径每帧都会走。
 */
export const installSessionDebug = (): void => {
  if (debugInstalled) {
    return
  }
  debugInstalled = true
  const holder = globalThis as { __dsDebug?: Record<string, unknown> }
  if (holder.__dsDebug === undefined) {
    holder.__dsDebug = {}
  }
  const target = holder.__dsDebug
  try {
    Object.defineProperty(target, 'sessionDrops', {
      get: () => sessionDropSnapshot(),
      enumerable: true,
      configurable: true,
    })
    Object.defineProperty(target, 'resetSessionDrops', {
      value: () => resetSessionDrops(),
      enumerable: true,
      configurable: true,
      writable: true,
    })
  } catch {
    // 冻结的 globalThis（某些壳环境）：没有调试入口就没有，绝不能因此让连接流程抛错
  }
}

/** 记一次丢弃（顺带装好调试入口；不打日志）。 */
export const noteSessionDrop = (kind: SessionDropKind): void => {
  drops[kind] += 1
  drops.total += 1
  installSessionDebug()
}

/** 计数快照（拷贝：调用方改了也不影响内部状态）。 */
export const sessionDropSnapshot = (): SessionDrops => ({ ...drops })

/** 清零（真机复现前先清零，复现完看哪一项涨）。 */
export const resetSessionDrops = (): SessionDrops => {
  for (const key of Object.keys(drops) as Array<keyof SessionDrops>) {
    drops[key] = 0
  }
  return sessionDropSnapshot()
}

/** 入口预装：模块加载即把 `__dsDebug.sessionDrops` 准备好（零成本，不打印）。 */
export const ensureSessionDebug = (): void => {
  installSessionDebug()
}
