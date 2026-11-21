import { useCallback, useState } from 'react'
import { useTranslate } from '../../../i18n/index.js'
import {
  commandLineOf,
  useChatControls,
  type ChatControlsState,
} from '../../../services/remote/sessionControls.js'
import { IconChevronRightOutline14, IconEllipsisOutline16 } from '../../base/icons.js'
import styles from './Controls.module.css'
import { Popover } from './Popover.js'
import { SessionInfoPanel } from './SessionInfoPanel.js'
import type { RemoteUsage } from '../../../services/remote/sessionControls.js'

type MenuView = 'menu' | 'commands' | 'info'

/**
 * 顶栏最右侧的 `⋯` 菜单：**命令列表 / 会话信息 / 清空队列**。
 *
 * 三个入口各自独立降级（`METHOD_NOT_FOUND` → 那一项直接不渲染，不是整块消失）：
 *  - 命令：`commands/list` 拉不到 → 不显示「命令」；
 *  - 清空队列：`session/updateQueue` 不支持、或队列本来就空 → 不显示；
 *  - 会话信息：只要有投影或胶囊数据就显示。
 *
 * 「命令」点开是**浏览 + 回填输入框**（`/name `），不是直接执行 —— 带参数的命令
 * （`/permission read-only`、`/compact`）必须让用户自己补完，回车时才由输入区执行。
 */
export const ChatMenu = ({
  sessionId,
  title,
  usage,
  onInsertCommand,
}: {
  sessionId: string | null
  title: string | null
  usage: RemoteUsage | null
  /** 把 `/name ` 填回输入框（并聚焦），菜单随即关闭 */
  onInsertCommand: (line: string) => void
}) => {
  const t = useTranslate()
  const commands = useChatControls((state) => state.commands)
  const commandAccess = useChatControls((state) => state.commandAccess)
  const loadingCommands = useChatControls((state) => state.loadingCommands)
  const loadCommands = useChatControls((state) => state.loadCommands)
  const queue = useChatControls((state) => state.queue)
  const queueAccess = useChatControls((state) => state.queueAccess)
  const clearQueue = useChatControls((state) => state.clearQueue)
  const [view, setView] = useState<MenuView>('menu')
  const [confirmClear, setConfirmClear] = useState(false)

  const showsCommands = commandAccess !== 'unavailable'
  const showsClear = queueAccess !== 'unavailable' && queue.length > 0

  const reset = useCallback(() => {
    setView('menu')
    setConfirmClear(false)
  }, [])

  const insert = useCallback(
    (line: string, close: () => void) => {
      close()
      onInsertCommand(line)
    },
    [onInsertCommand],
  )

  return (
    <Popover
      label={t('chatControlsMenu')}
      align="end"
      width={320}
      maxHeight={460}
      onOpenChange={(open) => {
        if (!open) {
          reset()
          return
        }
        void loadCommands()
      }}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          className={open ? `${styles.iconPill} ${styles.pillActive}` : styles.iconPill}
          aria-label={t('chatControlsMenu')}
          aria-expanded={open}
          onClick={toggle}
        >
          <IconEllipsisOutline16 />
        </button>
      )}
    >
      {({ close }) =>
        view === 'info' ? (
          <>
            <button
              type="button"
              className={styles.row}
              aria-label={t('chatControlsBack')}
              onClick={() => setView('menu')}
            >
              <span aria-hidden>←</span>
              <span className={styles.rowName}>{t('chatControlsMenuInfo')}</span>
            </button>
            <div className={styles.divider} />
            <SessionInfoPanel sessionId={sessionId} title={title} usage={usage} />
          </>
        ) : view === 'commands' ? (
          <>
            <button
              type="button"
              className={styles.row}
              aria-label={t('chatControlsBack')}
              onClick={() => setView('menu')}
            >
              <span aria-hidden>←</span>
              <span className={styles.rowName}>{t('chatControlsCommandsTitle')}</span>
            </button>
            <div className={styles.panelBody}>
              {loadingCommands && commands.length === 0 ? (
                <div className={styles.empty}>{t('chatControlsCommandsLoading')}</div>
              ) : null}
              {!loadingCommands && commands.length === 0 ? (
                <div className={styles.empty}>{t('chatControlsCommandsEmpty')}</div>
              ) : null}
              {commands.map((command) => (
                <button
                  key={command.name}
                  type="button"
                  className={styles.row}
                  onClick={() => insert(commandLineOf(command), close)}
                >
                  <span className={styles.rowCopy}>
                    <span className={styles.rowName}>
                      /{command.name}
                      {command.hint === undefined ? '' : ` ${command.hint}`}
                    </span>
                    {command.description === undefined ? null : (
                      <span className={styles.rowHint}>{command.description}</span>
                    )}
                  </span>
                  <span className={styles.rowTail} aria-hidden>
                    <IconChevronRightOutline14 />
                  </span>
                </button>
              ))}
            </div>
            <div className={styles.hint}>{t('chatControlsCommandsHint')}</div>
          </>
        ) : (
          <div className={styles.panelBody}>
            {showsCommands ? (
              <button type="button" className={styles.row} onClick={() => setView('commands')}>
                <span className={styles.rowCopy}>
                  <span className={styles.rowName}>{t('chatControlsMenuCommands')}</span>
                  <span className={styles.rowHint}>{t('chatControlsMenuCommandsHint')}</span>
                </span>
                <span className={styles.rowTail} aria-hidden>
                  <IconChevronRightOutline14 />
                </span>
              </button>
            ) : null}
            <button type="button" className={styles.row} onClick={() => setView('info')}>
              <span className={styles.rowCopy}>
                <span className={styles.rowName}>{t('chatControlsMenuInfo')}</span>
                <span className={styles.rowHint}>{t('chatControlsMenuInfoHint')}</span>
              </span>
              <span className={styles.rowTail} aria-hidden>
                <IconChevronRightOutline14 />
              </span>
            </button>
            {showsClear ? (
              confirmClear ? (
                <div className={styles.actions}>
                  <button type="button" className={styles.row} onClick={() => setConfirmClear(false)}>
                    {t('chatControlsCancel')}
                  </button>
                  <button
                    type="button"
                    className={`${styles.row} ${styles.rowDanger}`}
                    onClick={() => {
                      setConfirmClear(false)
                      close()
                      void clearQueue()
                    }}
                  >
                    {t('chatControlsMenuClearQueueConfirm', { count: queue.length })}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className={`${styles.row} ${styles.rowDanger}`}
                  onClick={() => setConfirmClear(true)}
                >
                  <span className={styles.rowName}>
                    {t('chatControlsMenuClearQueue', { count: queue.length })}
                  </span>
                </button>
              )
            ) : null}
          </div>
        )
      }
    </Popover>
  )
}

/**
 * `⋯` 该不该出现：命令、队列、会话信息**三条全废**时才隐藏。
 *
 * 单条不可用只隐藏那一项（见组件里的 `showsCommands` / `showsClear`）——
 * 「Host 没有斜杠命令」不该把「清空队列」一起藏了。
 */
export const showsChatMenu = (state: ChatControlsState): boolean =>
  state.commandAccess !== 'unavailable' ||
  (state.queueAccess !== 'unavailable' && state.queue.length > 0) ||
  state.projectionAccess !== 'unavailable'

export const useShowsChatMenu = (): boolean => useChatControls(showsChatMenu)
