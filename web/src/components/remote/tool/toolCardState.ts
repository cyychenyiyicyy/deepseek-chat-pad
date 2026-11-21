/**
 * 工具卡的展开状态记忆（按 item id）。
 *
 * 为什么放在模块作用域而不是 React state / zustand：`RemoteChatView` 的时间线是**整段重渲**，
 * 而且切一次模式（本地 ↔ 远程）组件会卸载重建。用户滚动回看时工具卡不该自动收回去，
 * 所以状态必须活在组件树之外，且不能进持久化（这是临时视图状态，不进存储层）。
 *
 * 三条规则（对应验收要求）：
 *   1. 默认收起；
 *   2. `running` 首次出现时自动展开一次 —— 用 `autoOpened` 记一笔，用户手动收起后不再弹开；
 *   3. 之后完全跟着点击走，滚动、换行、重渲染都不影响。
 */

const expanded = new Map<string, boolean>()
const autoOpened = new Set<string>()

/** 读一次记忆（不订阅：卡片自己的 state 才是渲染源）。 */
export const readToolOpen = (id: string): boolean => expanded.get(id) === true

/** 记一次用户/自动决定的展开状态。 */
export const writeToolOpen = (id: string, open: boolean): void => {
  expanded.set(id, open)
}

/** `running → 自动展开` 只做一次；返回 false 表示这一行已经自动展开过。 */
export const takeAutoOpen = (id: string): boolean => {
  if (autoOpened.has(id)) return false
  autoOpened.add(id)
  return true
}

/** 只给自测用：清空记忆，避免用例之间互相污染。 */
export const resetToolCardMemory = (): void => {
  expanded.clear()
  autoOpened.clear()
}
