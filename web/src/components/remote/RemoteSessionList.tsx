import clsx from 'clsx'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { useNewSessionStore } from '../../services/remote/newSessionStore.js'
import type { RemoteSearchHit } from '../../services/remote/sessionsApi.js'
import { useRemoteStore } from '../../services/remote/store.js'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import { IconButton } from '../base/IconButton.js'
import { IconCloseOutline16, IconEllipsisOutline16, IconPinOutline16, IconRefreshOutline16, IconSearchOutline16 } from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import { formatDate } from '../../utils/format.js'
import styles from './RemoteSessionList.module.css'

/**
 * 远程会话列表 —— 侧栏里那份列表的远程版，外加**会话管理**（W1）：
 *
 *   - 顶部搜索框 → `session/search`（Host 的索引默认是关的 ⇒ 自动退回本地标题匹配）；
 *   - 每条右侧「⋯」/ 长按 / 右键 → 重命名、置顶、归档、派生；
 *   - 归档的会话**不隐藏**，而是排到末尾并标「已归档」，这样「取消归档」原地就能点
 *     （dsh-Go 有独立的已归档页，本批没有那个页面，隐藏了就没有回头路）。
 *
 * 能力门禁：`capabilities.manage` 为 false 时「⋯」与长按/右键全部不渲染；
 * `phase !== 'ready'` 时同理（没有连接就没有远端可操作的东西）。
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** 搜索输入的防抖（打字时不要每键一发） */
const SEARCH_DEBOUNCE_MS = 250
/** 长按多久算「要菜单」（触摸设备） */
const LONG_PRESS_MS = 480

/** 数据层方法可能同步抛、也可能返回 rejected 的 promise；两者都只反映到 store 的 error */
const fireAndForget = (action: () => unknown) => {
  try {
    void Promise.resolve(action()).catch(() => undefined)
  } catch {
    // 同步抛错已由数据层写入状态，这里吞掉即可
  }
}

/** `updatedAt` 可能是秒级时间戳、毫秒时间戳或 ISO 字符串，统一成毫秒 */
const toMillis = (value: number | string | undefined): number | undefined => {
  if (value === undefined) return undefined
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  if (!Number.isFinite(value)) return undefined
  return value < 1e12 ? value * 1000 : value
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前 / 日期 */
const relativeTime = (
  t: ReturnType<typeof useTranslate>,
  updatedAt: number | string | undefined
): string => {
  const time = toMillis(updatedAt)
  if (time === undefined) return ''
  const diff = Date.now() - time
  if (diff < 0) return t('remoteTimeJustNow')
  if (diff < MINUTE) return t('remoteTimeJustNow')
  if (diff < HOUR) return t('remoteTimeMinutes', { count: Math.floor(diff / MINUTE) })
  if (diff < DAY) return t('remoteTimeHours', { count: Math.floor(diff / HOUR) })
  const days = Math.floor(diff / DAY)
  if (days === 1) return t('remoteTimeYesterday')
  if (days < 7) return t('remoteTimeDays', { count: days })
  return formatDate(time) ?? ''
}

interface RowView {
  id: string
  title: string
  time?: string
  updatedAt: number
  pinned: boolean
  archived: boolean
}

export const RemoteSessionList = ({
  className,
  onSelect,
}: {
  className?: string
  /** 移动端抽屉选中会话后自动收起 */
  onSelect?: (id: string) => void
}) => {
  const t = useTranslate()
  const sessions = useRemoteStore((state) => state.sessions)
  const activeSessionId = useRemoteStore((state) => state.activeSessionId)
  const phase = useRemoteStore((state) => state.phase)
  const capabilities = useNewSessionStore((state) => state.capabilities)
  const archivedIds = useNewSessionStore((state) => state.archivedSessionIds)
  const pinnedIds = useNewSessionStore((state) => state.pinnedSessionIds)
  const menuSessionId = useNewSessionStore((state) => state.menuSessionId)
  const busySessionId = useNewSessionStore((state) => state.busySessionId)
  const actionError = useNewSessionStore((state) => state.actionError)
  const search = useNewSessionStore((state) => state.search)
  const renameTarget = useNewSessionStore((state) => state.renameTarget)

  const ready = phase === 'ready'
  const canManage = ready && capabilities.manage

  /** 搜索框自己的草稿（store 里那份是「已经发出去/正在搜」的），防抖后再写回 store */
  const [draft, setDraft] = useState(search.query)
  useEffect(() => {
    setDraft(search.query)
  }, [search.query])
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const trimmed = draft.trim()
      if (trimmed === useNewSessionStore.getState().search.query.trim()) return
      if (trimmed.length === 0) useNewSessionStore.getState().clearSearch()
      else fireAndForget(() => useNewSessionStore.getState().runSearch(trimmed))
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [draft])

  // 挂载时静默拉一次工作区/归档/置顶（列表要按它们排序与标注）
  useEffect(() => {
    if (!ready) return
    fireAndForget(() => useNewSessionStore.getState().ensureWorkspaceFlags())
  }, [ready])

  /** 菜单锚点（长按/右键/⋯ 落在哪一行） */
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  const menuOpen = menuSessionId !== null
  const anchored = useAnchoredPosition<HTMLElement, HTMLDivElement>(menuOpen, {
    align: 'end',
    maxHeight: 320,
    measureKey: menuSessionId,
  })
  if (menuOpen && menuAnchor !== null) anchored.anchorRef.current = menuAnchor
  useDismiss(menuOpen, [anchored.floatingRef, anchored.anchorRef], () => {
    useNewSessionStore.getState().setMenu(null)
  })

  const openMenu = (id: string, anchor: HTMLElement | null): void => {
    setMenuAnchor(anchor)
    useNewSessionStore.getState().setMenu(useNewSessionStore.getState().menuSessionId === id ? null : id)
  }

  const archivedSet = new Set(archivedIds)
  const pinnedSet = new Set(pinnedIds)
  const searching = search.query.trim().length > 0

  const sorted: RowView[] = sessions
    .map((session) => ({
      id: session.id,
      title: session.title || t('remoteSessionUntitled'),
      ...(relativeTime(t, session.updatedAt) === '' ? {} : { time: relativeTime(t, session.updatedAt) }),
      updatedAt: toMillis(session.updatedAt) ?? 0,
      pinned: pinnedSet.has(session.id) || session.pinned === true,
      archived: archivedSet.has(session.id),
    }))
    .sort((a, b) => {
      // 归档的沉到最后；置顶的浮到最前；其余按更新时间倒序
      if (a.archived !== b.archived) return a.archived ? 1 : -1
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return b.updatedAt - a.updatedAt
    })

  /** 搜索结果 → 行（远端命中的会话可能不在当前列表里：用 snippet 顶上，仍可点进去） */
  const hitRows: RowView[] = searching
    ? (search.hits ?? []).map((hit: RemoteSearchHit) => {
      const known = sessions.find((session) => session.id === hit.sessionId)
      return {
        id: hit.sessionId,
        title: known?.title ?? (hit.snippet.length > 0 ? hit.snippet : hit.sessionId),
        ...(known === undefined ? {} : { time: relativeTime(t, known.updatedAt) }),
        updatedAt: toMillis(known?.updatedAt) ?? 0,
        pinned: pinnedSet.has(hit.sessionId) || known?.pinned === true,
        archived: archivedSet.has(hit.sessionId),
      }
    })
    : []

  const rows = searching ? hitRows : sorted
  const menuRow = menuSessionId === null ? undefined : rows.find((row) => row.id === menuSessionId)

  return (
    <div className={clsx(styles.wrap, className)}>
      {ready ? (
        <div className={styles.searchRow}>
          <span className={styles.searchIcon} aria-hidden>
            <IconSearchOutline16 />
          </span>
          <input
            className={styles.searchInput}
            value={draft}
            type="search"
            spellCheck={false}
            autoComplete="off"
            placeholder={t('newSessionSearchPlaceholder')}
            aria-label={t('newSessionSearchPlaceholder')}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return
              setDraft('')
              useNewSessionStore.getState().clearSearch()
            }}
          />
          {draft.length > 0 ? (
            <IconButton
              size="xs"
              tone="tertiary"
              icon={<IconCloseOutline16 />}
              aria-label={t('newSessionClose')}
              onClick={() => {
                setDraft('')
                useNewSessionStore.getState().clearSearch()
              }}
            />
          ) : null}
        </div>
      ) : null}

      {search.local && searching ? <div className={styles.listHint}>{t('newSessionSearchLocal')}</div> : null}
      {actionError !== null ? <div className={styles.listError}>{actionError}</div> : null}

      <div className={styles.list}>
        {rows.length === 0 ? (
          <div className={styles.empty}>
            {searching
              ? t(search.searching ? 'newSessionSearching' : 'newSessionSearchEmpty')
              : t(phase === 'ready' ? 'remoteSessionEmpty' : 'remotePhaseIdle')}
          </div>
        ) : (
          rows.map((row) => {
            const active = row.id === activeSessionId
            const busy = busySessionId === row.id
            return (
              <div
                key={row.id}
                className={clsx(styles.row, row.archived && styles.rowArchived)}
                onContextMenu={(event) => {
                  if (!canManage) return
                  event.preventDefault()
                  openMenu(row.id, event.currentTarget)
                }}
                onTouchStart={(event) => {
                  if (!canManage) return
                  const element = event.currentTarget
                  const timer = window.setTimeout(() => openMenu(row.id, element), LONG_PRESS_MS)
                  const clear = (): void => window.clearTimeout(timer)
                  element.addEventListener('touchend', clear, { once: true })
                  element.addEventListener('touchmove', clear, { once: true })
                  element.addEventListener('touchcancel', clear, { once: true })
                }}
              >
                <button
                  type="button"
                  aria-current={active ? 'true' : undefined}
                  className={clsx(styles.item, active && styles.itemActive)}
                  onClick={() => {
                    fireAndForget(() => useRemoteStore.getState().openSession(row.id))
                    onSelect?.(row.id)
                  }}
                >
                  <span className={styles.itemMain}>
                    <span className={styles.itemTitle}>
                      {row.pinned ? (
                        <span className={styles.pinMark} aria-hidden>
                          <IconPinOutline16 />
                        </span>
                      ) : null}
                      {row.title}
                    </span>
                    <span className={styles.itemMeta}>
                      {row.archived ? <span className={styles.archivedTag}>{t('newSessionArchivedTag')}</span> : null}
                      {busy ? (
                        <span className={styles.itemBusy} aria-hidden>
                          <IconRefreshOutline16 />
                        </span>
                      ) : null}
                      {row.time ? <span className={styles.itemTime}>{row.time}</span> : null}
                    </span>
                  </span>
                </button>
                {canManage ? (
                  <IconButton
                    size="xs"
                    tone="tertiary"
                    className={styles.moreButton}
                    icon={<IconEllipsisOutline16 />}
                    aria-label={t('newSessionSessionActions')}
                    onClick={(event) => openMenu(row.id, event.currentTarget.parentElement)}
                  />
                ) : null}
              </div>
            )
          })
        )}
      </div>

      {menuOpen && menuRow !== undefined
        ? createPortal(
          <div ref={anchored.floatingRef} className={styles.menu} style={anchored.position ?? undefined} role="menu">
            <MenuRow
              label={t('newSessionMenuRename')}
              onSelect={() => useNewSessionStore.getState().beginRename(menuRow.id, menuRow.title)}
            />
            <MenuRow
              label={t(menuRow.pinned ? 'newSessionMenuUnpin' : 'newSessionMenuPin')}
              onSelect={() => fireAndForget(() => useNewSessionStore.getState().togglePin(menuRow.id))}
            />
            <MenuRow
              label={t(menuRow.archived ? 'newSessionMenuUnarchive' : 'newSessionMenuArchive')}
              onSelect={() => fireAndForget(() => useNewSessionStore.getState().toggleArchive(menuRow.id))}
            />
            <MenuRow
              label={t('newSessionMenuFork')}
              onSelect={() => fireAndForget(() => useNewSessionStore.getState().fork(menuRow.id))}
            />
          </div>,
          document.body,
        )
        : null}

      {renameTarget !== null ? <RenameDialog /> : null}
    </div>
  )
}

/** 菜单的一行（不是 `base/Menu`：那个只能点触发器打开，而这里要支持长按/右键） */
const MenuRow = ({ label, onSelect }: { label: string; onSelect: () => void }) => (
  <div
    className={styles.menuOption}
    role="menuitem"
    onClick={() => {
      // 先关菜单再执行：动作失败也不会把菜单留在屏幕上
      useNewSessionStore.getState().setMenu(null)
      onSelect()
    }}
  >
    {label}
  </div>
)

/** 重命名弹窗：`session/rename`（Host 落定标题后自动起名停止） */
const RenameDialog = () => {
  const t = useTranslate()
  const renameTarget = useNewSessionStore((state) => state.renameTarget)
  const busy = useNewSessionStore((state) => state.busySessionId)
  const inputRef = useRef<HTMLInputElement>(null)

  useLayoutEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  if (renameTarget === null) return null
  const commit = (): void => {
    fireAndForget(() => useNewSessionStore.getState().commitRename())
  }

  return (
    <Modal
      title={t('newSessionRenameTitle')}
      closable
      onClose={() => useNewSessionStore.getState().cancelRename()}
      footer={
        <>
          <button
            type="button"
            className={styles.dialogButton}
            onClick={() => useNewSessionStore.getState().cancelRename()}
          >
            {t('cancel')}
          </button>
          <button
            type="button"
            className={clsx(styles.dialogButton, styles.dialogButtonPrimary)}
            disabled={busy !== null || renameTarget.title.trim().length === 0}
            onClick={commit}
          >
            {t('newSessionRenameSave')}
          </button>
        </>
      }
    >
      <input
        ref={inputRef}
        className={styles.renameInput}
        value={renameTarget.title}
        spellCheck={false}
        autoComplete="off"
        aria-label={t('newSessionRenameTitle')}
        onChange={(event) => useNewSessionStore.getState().updateRenameDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return
          commit()
        }}
      />
    </Modal>
  )
}
