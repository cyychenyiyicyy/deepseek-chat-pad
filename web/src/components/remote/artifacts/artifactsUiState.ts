import { create } from 'zustand'

/**
 * 交付文件面板的**纯界面状态**（三件事）：
 *
 * 1. `missing` —— 哪些路径刚才点开时发现已经不在了。同一份结论要同时出现在两个地方
 *    （时间线里那一轮的文件 chip、会话级抽屉里的一行），各自记一份的话，
 *    用户先点 chip 再翻列表会看到两种说法。
 * 2. `sessionOpen` —— 会话级抽屉的开合。放在 store 里而不是组件里，是为了让**任何入口**
 *    都能开同一个抽屉：顶栏那个图标按钮、以及将来 `⋯` 菜单里加的一行
 *    （见报告 §7 的合并补丁，只要一行 `openSession()`）。
 * 3. 换会话时 `reset()`：密码学上没关系的两个会话不该共享「已不存在」的结论。
 *
 * 只记路径、不记对象：文件被补回来（重新出现）时 `markPresent` 直接擦掉。
 */
interface ArtifactsUiState {
  /** 归一化路径 → true（已确认不存在） */
  missing: Record<string, true>
  /** 会话级抽屉是否展开 */
  sessionOpen: boolean
  markMissing(path: string): void
  markPresent(path: string): void
  /** 打开 / 关闭「本次会话的交付文件」抽屉 */
  openSession(): void
  closeSession(): void
  /** 换会话时清掉（上一个会话的文件状态对新会话没有意义） */
  reset(): void
}

export const useArtifactsUi = create<ArtifactsUiState>((set) => ({
  missing: {},
  sessionOpen: false,
  markMissing: (path: string): void => {
    set((state) => (state.missing[path] === true ? state : { missing: { ...state.missing, [path]: true } }))
  },
  markPresent: (path: string): void => {
    set((state) => {
      if (state.missing[path] !== true) return state
      const next = { ...state.missing }
      delete next[path]
      return { missing: next }
    })
  },
  openSession: (): void => set({ sessionOpen: true }),
  closeSession: (): void => set({ sessionOpen: false }),
  reset: (): void => set({ missing: {}, sessionOpen: false }),
}))
