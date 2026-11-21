import { useTranslate } from '../../../i18n/index.js'
import { showsQueueDock, useChatControls } from '../../../services/remote/sessionControls.js'
import { IconCloseOutline16, IconRightUpOutline14 } from '../../base/icons.js'
import { queuePreviewText, queueRowState } from '../composer/composerState.js'
import styles from './QueueDock.module.css'

/**
 * 输入区上方的**排队提示条**：正在生成时发出去的消息会进 Host 的 `inbox`（`next-turn`），
 * 这里把它们列出来，每条可以「立即发送（steer）」或「删除（remove）」。
 *
 * 数据来自 `session/control` 的 `projections.values.inbox`（上游 `state/message-helpers.ts:46-88`），
 * 动作是 `session/updateQueue`（`{request:{sessionId,itemId,action:{kind}}}`）。
 *
 * 三条纪律：
 *  1. **只在有条目时出现**（`showsQueueDock`）——它是输入区的一部分，不占正文的地方；
 *  2. **一条在飞时整条禁用**：Host 侧的队列顺序是有意义的，并发发两条 `updateQueue`
 *     会让「谁先插队」变得不可预期（`sessionControls.updateQueueItem` 内部也单飞）；
 *  3. **能力门禁**：`updateQueue` 不可用（`METHOD_NOT_FOUND`）时整条不渲染 ——
 *     只读的队列列表反而会让人误以为按钮坏了。
 */
export const QueueDock = () => {
  const t = useTranslate()
  const queue = useChatControls((state) => state.queue)
  const busy = useChatControls((state) => state.queueBusy)
  const updateQueueItem = useChatControls((state) => state.updateQueueItem)
  const visible = useChatControls(showsQueueDock)

  if (!visible) return null

  const title = t('chatControlsQueueTitle', { count: queue.length })

  return (
    <div className={styles.dock} role="group" aria-label={title}>
      <div className={styles.head}>
        <span className={styles.title}>{title}</span>
      </div>
      <div className={styles.rows}>
        {queue.map((item, index) => {
          const row = queueRowState(item, busy)
          const preview = queuePreviewText(item.preview, t('chatControlsQueuePending'))
          return (
            <div className={styles.row} key={item.id ?? `local-${index}`} aria-busy={row.busy}>
              <span className={styles.index} aria-hidden>
                {index + 1}
              </span>
              <span className={styles.preview} title={preview}>
                {preview}
              </span>
              {row.actionable ? (
                <>
                  <button
                    type="button"
                    className={styles.steer}
                    aria-label={t('chatControlsQueueSteer')}
                    aria-busy={row.busy}
                    disabled={!row.enabled}
                    onClick={() => void updateQueueItem(item.id as string, 'steer')}
                  >
                    <IconRightUpOutline14 />
                    <span className={styles.steerText}>{t('chatControlsQueueSteer')}</span>
                  </button>
                  <button
                    type="button"
                    className={styles.remove}
                    aria-label={t('chatControlsQueueRemove')}
                    disabled={!row.enabled}
                    onClick={() => void updateQueueItem(item.id as string, 'remove')}
                  >
                    <IconCloseOutline16 />
                  </button>
                </>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
