import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconBrowseOutline16,
  IconArrowBack24,
  IconDataOutline16,
  IconNewChatOutline20,
  IconPanelLeftOutline16,
  IconSearchOutline16,
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
import { useRemoteMode } from '../remote/RemoteModeSwitch.js'
import { HostSwitcher } from '../remote/HostSwitcher.js'
import { RemoteSessionList } from '../remote/RemoteSessionList.js'
import { openRemoteWorkspaceDialog } from '../remote/RemoteWorkspaceDialog.js'
import { closeMobileSider, useMobileSider } from './mobileSiderState.js'
import { SessionItem } from './SessionItem.js'
import styles from './Sider.module.css'

/**
 * 展开的侧边栏：顶部「本机 / 远程」胶囊、搜索框、新建对话（远程模式换成远程会话列表）、
 * 按时间分组的会话列表与底部快捷入口。窄窗中整页显示历史。
 *
 * 两种模式共用这一份骨架：胶囊只决定列表读哪一份数据，右栏详情由 `App` 决定。
 */

/** 一屏先渲染这么多，其余点「显示更多」再补 —— 会话几百条时首屏才不卡 */
const LIST_PAGE = 60

export const Sider = ({ mobile = false }: { mobile?: boolean }) => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const ready = useChatStore((state) => state.ready)
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
        sessions: group.sessions.filter((session) => (session.title || t('untitledChat')).toLowerCase().includes(query)),
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
    <aside className={styles.sider} aria-label={t(remoteMode === 'remote' ? 'remoteListButton' : 'liveListTitle')}>
      <div className={styles.top}>
        <div className={styles.brand}>
          <span className={styles.brandIcon} aria-hidden="true"><IconNewChatOutline20 /></span>
          <span className={styles.appName}>{t('navHistory')}</span>
        </div>
        <IconButton
          size="xl"
          icon={mobile ? <IconArrowBack24 /> : <IconPanelLeftOutline16 />}
          tooltip={t(mobile ? 'settingsBackToChat' : 'collapseSiderbarButton')}
          tooltipPlacement="bottom"
          onClick={() => {
            if (mobile) {
              closeMobileSider()
              return
            }
            setSiderCollapsed(true)
            requestAnimationFrame(() => document.querySelector<HTMLElement>(
              'button[aria-controls="desktop-session-sidebar"]'
            )?.focus({ preventScroll: true }))
          }}
        />
      </div>

      {remoteMode === 'remote' ? (
        <RemoteSessionList
          className={styles.remoteList}
          onSelect={mobile ? closeMobileSider : undefined}
        />
      ) : (
        <>
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

          <label className={styles.search}>
            <span className={styles.searchIcon} aria-hidden="true">
              <IconSearchOutline16 />
            </span>
            <input
              type="search"
              className={styles.searchInput}
              aria-label={t('siderSearchPlaceholder')}
              value={keyword}
              placeholder={t('siderSearchPlaceholder')}
              onChange={(event) => setKeyword(event.target.value)}
            />
          </label>

          <div className={styles.listWrap}>
            <div className={styles.list}>
              {ready && totalSessions === 0 ? (
                <p className={styles.empty} role="status">
                  {t(keyword.trim() ? 'siderSearchEmpty' : 'siderHistoryEmpty')}
                </p>
              ) : null}
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
        </>
      )}

      <div className={styles.bottom}>
        <HostSwitcher onOpen={() => openRemoteWorkspaceDialog('host')} />
        {remoteMode === 'remote' ? (
          <IconButton size="xl" className={clsx(styles.bottomAction, styles.remoteTools)}
            icon={<><IconDataOutline16 /><span aria-hidden="true">{t('remoteWorkspaceToolsShort')}</span></>}
            tooltip={t('remoteWorkspaceTools')} onClick={() => openRemoteWorkspaceDialog('tools')} />
        ) : (
          <IconButton size="xl" className={styles.bottomAction}
            icon={<><IconBrowseOutline16 /><span aria-hidden="true">{t('siderModelEntry')}</span></>}
            tooltip={t('siderModelEntry')} onClick={() => openSettings('models')} />
        )}
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
    </aside>
  )
}

/** 单栏窗口中的会话列表。常驻挂载以保留搜索词和列表位置。 */
export const MobileSider = () => {
  const open = useMobileSider((state) => state.open)
  const drawer = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const trigger = document.activeElement
    drawer.current?.querySelector<HTMLElement>('button')?.focus()
    return () => {
      if (document.activeElement?.closest('[aria-modal="true"]')) return
      const target = trigger instanceof HTMLElement && trigger !== document.body && trigger.isConnected
        ? trigger
        : document.querySelector<HTMLElement>('button[aria-controls="mobile-session-drawer"]')
      target?.focus({ preventScroll: true })
    }
  }, [open])

  return (
    <div
      id="mobile-session-drawer"
      className={clsx(styles.drawerLayer, open && styles.drawerOpen)}
      aria-hidden={!open}
      ref={(node) => node?.toggleAttribute('inert', !open)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          closeMobileSider()
          event.preventDefault()
        }
      }}
    >
      <div className={styles.drawer} ref={drawer}>
        <Sider mobile />
      </div>
    </div>
  )
}
