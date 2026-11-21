/**
 * 工具卡的展开状态记忆（按 item id）。
 *
 * 为什么放在模块作用域而不是 React state / zustand：`RemoteChatView` 的时间线是**整段重渲**，
 * 而且切一次模式（本地 ↔ 远程）组件会卸载重建。用户滚动回看时工具卡不该自动收回去，
 * 所以状态必须活在组件树之外，且不能进持久化（这是临时视图状态，不进存储层）。
 *
 * 现在的规则只有三条（用户真机反馈后改的，见 `input-R2-工具卡修复.md`）：
 *
 *   1. **默认收起** —— 所有工具卡，含 `running`、含带图片的，一律折叠；
 *   2. **只有点击才展开** —— 没有任何「自动展开一次」的特例（旧的 `takeAutoOpen` 已删除：
 *      它会让每张运行中的卡自己弹开，一屏十几个工具调用时正文被顶到看不见）；
 *   3. **新帧不弹开** —— 同一条 item 反复到达新的事件帧（result / 图片 / 状态变化）时，
 *      展开状态跟着用户上次的选择走；只有 id 变了（列表复用组件实例）才回记忆里读，
 *      读不到就是收起。
 *
 * 第 3 条靠 `followToolItem()`：界面上把「当前显示的是哪条 item + 是否展开」当成一个原子
 * 状态，渲染期发现 id 变了就换一份 —— 这是 React 官方文档里的「props 变了就修正 state」
 * 写法，不额外触发提交，也不会在 effect 里再闪一帧。
 */

/** 一条 item 的折叠视图状态。`id` 是它属于哪条 item，`open` 是用户的选择。 */
export interface ToolCardOpenView {
  id: string
  open: boolean
}

const expanded = new Map<string, boolean>()

/** 读一次记忆（不订阅：卡片自己的 state 才是渲染源）。**没有记录 = 收起。** */
export const readToolOpen = (id: string): boolean => expanded.get(id) === true

/** 记一次用户决定的展开状态。 */
export const writeToolOpen = (id: string, open: boolean): void => {
  expanded.set(id, open)
}

/** 用户点了头部：翻一下并把结果记进记忆，返回**新的**展开状态。 */
export const toggleToolOpen = (id: string): boolean => {
  const next = readToolOpen(id) === false
  writeToolOpen(id, next)
  return next
}

/**
 * 渲染期修正：id 没变就原样返回（新帧不改变展开状态）；id 变了就以记忆为准（默认收起）。
 *
 * 返回值与入参**引用相等**时表示「不用改 state」，调用方据此决定要不要 `setState`。
 */
export const followToolItem = (view: ToolCardOpenView, id: string): ToolCardOpenView =>
  view.id === id ? view : { id, open: readToolOpen(id) }

/** 只给自测用：清空记忆，避免用例之间互相污染。 */
export const resetToolCardMemory = (): void => {
  expanded.clear()
}

/** 只给自测 / 排查用：记忆表的快照（副本，改了不影响内部）。 */
export const toolCardMemorySnapshot = (): Map<string, boolean> => new Map(expanded)
