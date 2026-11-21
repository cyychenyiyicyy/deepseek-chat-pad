import clsx from 'clsx'
import { useEffect, useMemo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconLinkOutline16,
  IconPanelLeftOutline16,
  IconSearchOutline16,
  IconSettingsOutline16,
  NewChatIcon,
} from '../base/icons.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { groupSessions } from '../../services/chat/sessionGroups.js'
import { forgetPin, togglePin, usePins } from '../../services/chat/pins.js'
import { newChat, removeSession, useChatStore } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { enterRemoteMode, useRemoteMode } from '../remote/RemoteModeSwitch.js'
import { closeMobileSider, useMobileSider } from './mobileSiderState.js'
import { SessionItem } from './SessionItem.js'
import styles from './Sider.module.css'

/**
 * 展开的侧边栏：搜索框、新建对话、按时间分组的会话列表、底部模型与设置入口。
 * 移动端放在抽屉里，收起按钮关闭抽屉。
 */
/** 一屏先渲染这么多，其余点「显示更多」再补 —— 会话几百条时首屏才不卡 */
const LIST_PAGE = 60

export const Sider = ({ mobile = false }: { mobile?: boolean }) => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeId)
  const [now, setNow] = useState(Date.now)
  const [keyword, setKeyword] = useState('')
  const [limit, setLimit] = useState(LIST_PAGE)
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)

  const [deletePending, setDeletePending] = useState(false)

  const pinnedIds = usePins((state) => state.ids)
  const remoteMode = useRemoteMode((state) => state.mode)
  const groups = useMemo(() => {
    const pinned = new Set(pinnedIds)
    const all = groupSessions(sessions, now, t, (id) => pinned.has(id))
    const query = keyword.trim().toLowerCase()
    if (!query) return all
    return all
      .map((group) => ({
        ...group,
        sessions: group.sessions.filter((session) => (session.title || '').toLowerCase().includes(query)),
      }))
      .filter((group) => group.sessions.length > 0)
  }, [sessions, now, t, keyword, pinnedIds])

  /** 按 limit 铺开所有分组，剩下的留给「显示更多」 */
  const totalSessions = groups.reduce((count, group) => count + group.sessions.length, 0)
  let budget = limit
  const visibleGroups = groups
    .map((group) => {
      const take = Math.min(budget, group.sessions.length)
      budget -= take
      return { ...group, sessions: group.sessions.slice(0, take) }
    })
    .filter((group) => group.sessions.length > 0)
  const hiddenCount = Math.max(0, totalSessions - Math.min(limit, totalSessions))

  // 搜索词变了就回到第一页
  useEffect(() => setLimit(LIST_PAGE), [keyword])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      clearTimeout(timer)
      const time = Date.now()
      setNow(time)
      const midnight = new Date(time).setHours(24, 0, 0, 0)
      timer = setTimeout(refresh, midnight - time)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    }
    refresh()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', refresh)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  return (
    <div className={clsx(styles.sider, mobile && styles.mobile)}>
      <div className={styles.top}>
        <div className={styles.appName}>{t('appName')}</div>
        <IconButton
          size="m"
          icon={<IconPanelLeftOutline16 />}
          tooltip={t('collapseSiderbarButton')}
          tooltipPlacement="bottom"
          onClick={() => (mobile ? closeMobileSider() : setSiderCollapsed(true))}
        />
      </div>

      <label className={styles.search}>
        <span className={styles.searchIcon}>
          <IconSearchOutline16 />
        </span>
        <input
          className={styles.searchInput}
          value={keyword}
          placeholder={t('siderSearchPlaceholder')}
          onChange={(event) => setKeyword(event.target.value)}
        />
      </label>

      <button
        type="button"
        className={styles.newChat}
        onClick={() => {
          newChat()
          closeMobileSider()
        }}
      >
        <span className={styles.newChatIcon}>
          <NewChatIcon />
        </span>
        {t('newChat')}
      </button>

      <div className={styles.listWrap}>
        <div className={styles.list}>
          {visibleGroups.map((group) => (
            <div key={group.key} className={styles.section}>
              <div className={styles.sectionHeader}>
                {group.label}
                {group.key === 'pinned' ? ` · ${group.sessions.length}` : null}
              </div>
              {group.sessions.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  active={session.id === activeId}
                  pinned={pinnedIds.includes(session.id)}
                  onTogglePin={() => togglePin(session.id)}
                  onDelete={() => setDeleting(session)}
                />
              ))}
            </div>
          ))}
          {hiddenCount > 0 ? (
            <button
              type="button"
              className={styles.loadMore}
              onClick={() => setLimit((value) => value + LIST_PAGE)}
            >
              {t('siderLoadMore', { count: hiddenCount })}
            </button>
          ) : null}
        </div>
      </div>

      <div className={styles.bottom}>
        {/*
          远程入口：这里只切模式，**不做任何探测**。原生桥的能力探测放在
          `RemoteModeSwitch` / 会话页里，等用户真的点进去才发起 —— `index.html` 的
          8 秒看门狗会把启动路径上的慢请求当成坏包回滚。
        */}
        <button
          type="button"
          className={clsx(styles.settings, remoteMode === 'remote' && styles.settingsActive)}
          aria-pressed={remoteMode === 'remote'}
          onClick={() => {
            enterRemoteMode()
            closeMobileSider()
          }}
        >
          <span className={styles.settingsIcon}>
            <IconLinkOutline16 />
          </span>
          <span className={styles.settingsLabel}>{t('remoteModeRemote')}</span>
        </button>
        <button type="button" className={styles.settings} onClick={() => openSettings('models')}>
          <span className={styles.settingsIcon}>
            <IconSettingsOutline16 />
          </span>
          <span className={styles.settingsLabel}>{t('siderModelEntry')}</span>
        </button>
        <button type="button" className={styles.settings} onClick={() => openSettings('general')}>
          <span className={styles.settingsIcon}>
            <IconSettingsOutline16 />
          </span>
          <span className={styles.settingsLabel}>{t('settings')}</span>
        </button>
      </div>


      {deleting ? (
        <Modal
          title={t('deleteSessionModalContentTitle')}
          onClose={() => {
            if (!deletePending) {
              setDeleting(null)
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={deletePending} onClick={() => setDeleting(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={deletePending}
                onClick={async () => {
                  setDeletePending(true)
                  try {
                    if (await removeSession(deleting.id)) {
                      forgetPin(deleting.id)
                      setDeleting(null)
                    } else {
                      showToast({ key: 'sessionDeleteFailed', type: 'error' })
                    }
                  } finally {
                    setDeletePending(false)
                  }
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('deleteSessionWithFilesDescription')}
        </Modal>
      ) : null}
    </div>
  )
}

/**
 * 移动端抽屉：常驻挂载，靠 transform 与遮罩透明度做进出场动画，
 * 关闭时延后隐藏，保证滑出动画能播完。
 */
export const MobileSider = () => {
  const open = useMobileSider((state) => state.open)
  return (
    <div className={clsx(styles.drawerLayer, open && styles.drawerOpen)} aria-hidden={!open}>
      <div className={styles.drawerMask} onClick={closeMobileSider} />
      <div className={styles.drawer}>
        <Sider mobile />
      </div>
    </div>
  )
}
