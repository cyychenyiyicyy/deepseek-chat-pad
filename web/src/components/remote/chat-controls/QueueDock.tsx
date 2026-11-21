import { useTranslate } from '../../../i18n/index.js'
import { showsQueueDock, useChatControls } from '../../../services/remote/sessionControls.js'
import { IconCloseOutline16, IconRightUpOutline14 } from '../../base/icons.js'
import styles from './QueueDock.module.css'

/**
 * 输入区上方的**排队提示条**：正在生成时发出去的消息会进 Host 的 `inbox`（`next-turn`），
 * 这里把它们列出来，每条可以「立即发送（steer）」或「删除（remove）」。
 *
 * 数据来自 `session/control` 的 `projections.values.inbox`（上游 `state/message-helpers.ts:46-88`），
 * 动作是 `session/updateQueue`（`{request:{sessionId,itemId,action:{kind:'steer'|'remove'}}}`）。
 *
 * 能力门禁：`updateQueue` 不可用（`METHOD_NOT_FOUND`）时整条不渲染 —— 只读的队列列表
 * 反而会让人误以为按钮坏了。
 */
export const QueueDock = () => {
  const t = useTranslate()
  const queue = useChatControls((state) => state.queue)
  const busy = useChatControls((state) => state.queueBusy)
  const updateQueueItem = useChatControls((state) => state.updateQueueItem)
  const visible = useChatControls(showsQueueDock)

  if (!visible) return null

  return (
    <div className={styles.dock} role="group" aria-label={t('chatControlsQueueTitle', { count: queue.length })}>
      <div className={styles.head}>
        <span className={styles.title}>{t('chatControlsQueueTitle', { count: queue.length })}</span>
      </div>
      <div className={styles.rows}>
        {queue.map((item, index) => {
          const pending = item.id !== undefined && busy === item.id
          const disabled = item.id === undefined || busy !== null
          return (
            <div className={styles.row} key={item.id ?? `local-${index}`}>
              <span className={styles.preview} title={item.preview}>
                {item.preview.trim().length === 0 ? t('chatControlsQueuePending') : item.preview.trim()}
              </span>
              {item.id === undefined ? null : (
                <>
                  <button
                    type="button"
                    className={styles.steer}
                    aria-label={t('chatControlsQueueSteer')}
                    aria-busy={pending}
                    disabled={disabled}
                    onClick={() => void updateQueueItem(item.id as string, 'steer')}
                  >
                    <IconRightUpOutline14 />
                    <span className={styles.steerText}>{t('chatControlsQueueSteer')}</span>
                  </button>
                  <button
                    type="button"
                    className={styles.remove}
                    aria-label={t('chatControlsQueueRemove')}
                    disabled={disabled}
                    onClick={() => void updateQueueItem(item.id as string, 'remove')}
                  >
                    <IconCloseOutline16 />
                  </button>
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
