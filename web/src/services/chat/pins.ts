import { create } from 'zustand'

/**
 * 会话置顶。
 *
 * 存在 localStorage 而不是会话记录里：
 *   - 原生 SQLite 的摘要由壳自己拼，加字段得改 APK；置顶是纯展示偏好，不值得为它再发一版
 *   - 现有用户升级时不用迁移：IndexedDB / 原生库切换它都不受影响
 *   - 换存储、换设备（各自独立）都不会让置顶把会话"带走"
 *
 * 代价：不在会话数据里，导出备份不含它。可以接受。
 */
const KEY = 'chat-demo:pinned-sessions'

const read = (): string[] => {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

const write = (ids: string[]) => {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(ids))
  } catch {
    // 存储不可用：本次会话内仍然生效，只是重启后丢失
  }
}

type PinState = { ids: string[] }

export const usePins = create<PinState>(() => ({ ids: read() }))

export const isPinned = (id: string): boolean => usePins.getState().ids.includes(id)

export const togglePin = (id: string): boolean => {
  const current = usePins.getState().ids
  const pinned = !current.includes(id)
  const next = pinned ? [id, ...current] : current.filter((item) => item !== id)
  write(next)
  usePins.setState({ ids: next })
  return pinned
}

/** 删除会话时顺手清掉置顶，避免 id 越积越多 */
export const forgetPin = (id: string) => {
  const next = usePins.getState().ids.filter((item) => item !== id)
  if (next.length !== usePins.getState().ids.length) {
    write(next)
    usePins.setState({ ids: next })
  }
}
