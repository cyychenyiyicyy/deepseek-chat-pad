import { useEffect } from 'react'
import { useTranslate } from '../../../i18n/index.js'
import {
  showsModelCapsule,
  showsPermissionCapsule,
  useChatControls,
  type ChatControlsState,
} from '../../../services/remote/sessionControls.js'
import type { RemoteUsage } from '../../../services/remote/sessionControls.js'
import { IconCloseOutline16 } from '../../base/icons.js'
import styles from './Controls.module.css'
import { ChatMenu, showsChatMenu, type ChatMenuAction } from './ChatMenu.js'

/**
 * 会话顶栏**右侧**的那一个入口：`⋯` 菜单。
 *
 * 这一批的改动（用户真机反馈「模型选择和权限选择应该挪到输入框里面」）：
 * 模型胶囊 / 权限胶囊已经搬到 `components/remote/composer/**`，顶栏只剩
 * 会话标题 + transport 徽标 + 这个 `⋯`。**没有删掉旧的 `SessionControlsBar` 行为**：
 * 探测（`probe()`）与能力门禁仍在这里跑一遍 —— 它幂等，输入区那边也挂了一次，
 * 两条入口谁先到都一样（顶栏先挂载，通常这里先探）。
 *
 * 能力门禁一律**在渲染层判**：`⋯` 里的三项（命令 / 会话信息 / 清空队列）各自独立降级，
 * Host 缺哪个就只少哪个，不互相牵连，也不报错。
 */
export const SessionControlsBar = ({
  sessionId,
  title,
  usage,
  onInsertCommand,
  actions,
}: {
  sessionId: string | null
  title: string | null
  /** 时间线汇总的用量（`session/control` 没给 `usage` 时给信息面板兜底） */
  usage: RemoteUsage | null
  /** `⋯` → 命令 → 把 `/name ` 填回输入框 */
  onInsertCommand: (line: string) => void
  actions?: readonly ChatMenuAction[]
}) => {
  const probe = useChatControls((state) => state.probe)
  const showsMenu = useChatControls(showsChatMenu)

  // 换会话 / 首次挂载：各入口各探一次（内部有「已有数据就不重复拉」的短路）
  useEffect(() => {
    void probe()
  }, [probe, sessionId])

  if (!showsMenu && !actions?.length) return null

  return (
    <div className={styles.bar}>
      <ChatMenu sessionId={sessionId} title={title} usage={usage} onInsertCommand={onInsertCommand} actions={actions} />
    </div>
  )
}

/**
 * 会话内控制的**错误条**：一条可关掉的行，贴在输入区上方。
 *
 * 为什么不写进 `store.error`：那条错误是「连接/发送」级别的红条，界面上已经有一处展示；
 * 这里是「切模型 / 执行命令 / 队列操作」这种操作级失败，混在一起会让人以为连接断了。
 */
export const ChatControlsError = () => {
  const t = useTranslate()
  const error = useChatControls((current) => current.error)
  const clearError = useChatControls((current) => current.clearError)
  if (error === null) return null
  return (
    <div className={styles.errorBar} role="alert">
      <span className={styles.errorText}>
        {t('chatControlsError', { text: error.message })}
        {error.code.length === 0 ? '' : ` · ${error.code}`}
      </span>
      <button type="button" className={styles.errorClose} aria-label={t('chatControlsDismiss')} onClick={clearError}>
        <IconCloseOutline16 />
      </button>
    </div>
  )
}

/** 选择器透出（UI 侧测试/截图脚本需要判断「这组控件在不在」时用）。 */
export const chatControlsVisible = (state: ChatControlsState): boolean =>
  showsModelCapsule(state) || showsPermissionCapsule(state) || showsChatMenu(state)
