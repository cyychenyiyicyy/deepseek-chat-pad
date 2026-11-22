/**
 * [R16 子代理] 会话信息面板（`SessionInfoPanel`）的「子代理」一节：
 * 列出**当前会话派出的子代理**，点一行进那个子会话。
 *
 * 与 dsh-Go 的对照（那边是会话详情页的「子代理」tab + lineage，`session_detail_page.dart`）：
 *   - 会话列表 / 抽屉**故意不显示**子代理会话（`store.ts` 的 `projectSessions`，照
 *     `workspaces_state.dart:515` 把 blank / subagent 会话排除出抽屉）；
 *   - 会话详情反过来**只挑** `parentSessionId === 当前会话` 的行 —— 同一份 `session/list`
 *     数据，列表扔掉的那几行正是这里要的。
 *
 * 为什么是纯函数：筛选 / 归一 / 排序规则只有一份，UI 与自测共用
 * （`__selftest__/subagents.selftest.mts`），不掺 React / store / 网络 / i18n。
 */

/**
 * 输入行的最小结构（`session/list` 的 `RemoteSessionRow` 天然满足；`SessionInfoPanel`
 * 直接把 `useNewSessionStore` 的 `rows` 喂进来，那边字段变了这里会先红）。
 * 与 `liveSessions.ts` 的 `LiveListRow` 同一套「投影输入」写法：只声明用得到的字段。
 */
export interface SubagentRowInput {
  sessionId: string
  title?: string
  parentSessionId?: string
  /**
   * 声明出来只是为了让自测能摆「`origin` 带值也认」的用例；**逻辑不读它**
   * （老 Host 可能缺这个字段，判定归属只看 `parentSessionId`）。
   */
  origin?: string
  /** Host 一律给数字，但历史形态可能混进 ISO 字符串（见 `toSubagentMillis`），这里放宽接受。 */
  updatedAt?: number | string
}

/** 子代理行的最小投影（UI 只需要这三样）。 */
export interface SubagentChild {
  id: string
  /**
   * 行上的标题；空串 / undefined 一律折成 `undefined` —— 占位文案
   * （`remoteSubagentUntitled`）是 UI 层的事，纯函数不掺 i18n。
   */
  title: string | undefined
  /** 统一成毫秒的更新时间（解析不出就 `undefined`）；只用于排序，UI 不显示它。 */
  updatedAt: number | undefined
}

/**
 * `updatedAt` → 毫秒（照 `RemoteSessionList.tsx` 的 `toMillis`：秒级（< 1e12）× 1000，
 * 毫秒级原样，ISO 字符串走 `Date.parse`；认不出的一律 `undefined`，不猜）。
 */
const toSubagentMillis = (value: number | string | undefined): number | undefined => {
  if (value === undefined) return undefined
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  if (!Number.isFinite(value)) return undefined
  return value < 1e12 ? value * 1000 : value
}

/**
 * 当前会话派出的子代理，按 `updatedAt` 倒序（最新的在最上）。
 *
 * 规则：
 *   - 只认 `parentSessionId === sessionId` 的行 —— **不看 `origin`**：老 Host 可能缺这个
 *     字段，`parentSessionId` 一条就足以判定归属（列表那边是「两个条件取与」，这里是
 *     「一条就够」，方向相反所以写法也相反）；
 *   - 没有时间的行排最后（多半是还没动过一轮的空会话）；
 *   - `sessionId` 为 null / 空串（面板没绑会话）返回空数组，UI 拿到后本节不渲染。
 */
export const subagentChildrenOf = (
  rows: readonly SubagentRowInput[],
  sessionId: string | null,
): SubagentChild[] => {
  if (sessionId === null || sessionId.length === 0) return []
  const children: SubagentChild[] = []
  for (const row of rows) {
    if (row.parentSessionId !== sessionId) continue
    children.push({
      id: row.sessionId,
      title: row.title === undefined || row.title.length === 0 ? undefined : row.title,
      updatedAt: toSubagentMillis(row.updatedAt),
    })
  }
  children.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  return children
}
