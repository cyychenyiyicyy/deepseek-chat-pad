import clsx from 'clsx'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { sessionListViewState } from '../../services/remote/cache.js'
import { useNewSessionStore } from '../../services/remote/newSessionStore.js'
import type { RemoteSearchHit } from '../../services/remote/sessionsApi.js'
import { useRemoteStore } from '../../services/remote/store.js'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import { IconButton } from '../base/IconButton.js'
import {
  IconCloseOutline16,
  IconEllipsisOutline16,
  IconNewChatOutline20,
  IconPinOutline16,
  IconRefreshOutline16,
  IconSearchOutline16,
} from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import { formatDate } from '../../utils/format.js'
// [R9] 红点数字（纯函数；规则与 store 的记账同一份）
import { pendingBadgeText, pendingTotal } from './chat-controls/promptModel.js'
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
  /** [R8 缓存] 服务端列表里已经没有它了（还留着这一屏，下一轮刷新清理） */
  ghost: boolean
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
  /** [R8 缓存] 列表来源与同步态：缓存直出靠它标注「正在同步 / 缓存 / 已不存在」 */
  const cacheStatus = useRemoteStore((state) => state.cacheStatus)
  const capabilities = useNewSessionStore((state) => state.capabilities)
  const archivedIds = useNewSessionStore((state) => state.archivedSessionIds)
  const pinnedIds = useNewSessionStore((state) => state.pinnedSessionIds)
  /** [R9] 别的会话里等着的审批 / 提问（活动会话不计，见 store 末尾「八」） */
  const pendingInteractions = useRemoteStore((state) => state.pendingInteractions)
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

  /*
   * [R8 缓存] 打开远程页 → **先渲染缓存**（不发请求、只读一次 localStorage）。
   * 之后 `session/list` 回来时由数据层合并（服务端为准、本地 pinned 保留），
   * 所以这里不需要等连接、也不需要自己发起刷新。幂等：已有实时列表时它什么都不做。
   */
  useEffect(() => {
    useRemoteStore.getState().hydrateCachedSessions()
  }, [])

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
  /* [R8] 服务端这次没给、但缓存里还有的会话：标「已不存在」而不是立刻消失（避免网络抖动闪一下） */
  const ghostSet = new Set(cacheStatus.ghostSessionIds)
  const searching = search.query.trim().length > 0

  const sorted: RowView[] = sessions
    .map((session) => ({
      id: session.id,
      title: session.title || t('remoteSessionUntitled'),
      ...(relativeTime(t, session.updatedAt) === '' ? {} : { time: relativeTime(t, session.updatedAt) }),
      updatedAt: toMillis(session.updatedAt) ?? 0,
      pinned: pinnedSet.has(session.id) || session.pinned === true,
      archived: archivedSet.has(session.id),
      ghost: ghostSet.has(session.id),
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
        ghost: false,
      }
    })
    : []

  const rows = searching ? hitRows : sorted
  /**
   * [R8 缓存] 列表相位（纯函数判定，见 `cache.ts`）：
   *   有行 → 内容（缓存直出也算内容，顶部小标说明来源）
   *   没行 + 没连上 → 原来那句「未连接」
   *   没行 + 正在拉 / 还没拉过 → **骨架**，绝不写「远端还没有会话」
   */
  const listPhase = sessionListViewState({
    rowCount: rows.length,
    ready,
    synced: cacheStatus.sessionsSynced,
    syncing: cacheStatus.sessionsSyncing,
  })
  /**
   * 缓存直出时那句小标到底该说什么：
   *   连接还在（authing/connecting/ready）→「正在同步…」；
   *   连接已经没了（idle/error）→ 只剩缓存，就老实说「缓存」。
   */
  const syncingNow =
    cacheStatus.sessionsSyncing || phase === 'authing' || phase === 'connecting' || phase === 'ready'
  const menuRow = menuSessionId === null ? undefined : rows.find((row) => row.id === menuSessionId)

  return (
    <div className={clsx(styles.wrap, className)}>
      {/*
        「新建对话」入口（R4）：用户真机反馈「新建对话没有按钮」——
        之前它只挂在时间线空态里，一旦有会话就再也找不到。这里是**会话列表顶部**，
        与搜索框同一列、视觉权重更高，任何时刻都在。
        能力门禁：Host 没有 `session/create`（`capabilities.create === false`）时不渲染。
      */}
      {ready && capabilities.create ? (
        <button
          type="button"
          className={styles.newChat}
          aria-label={t('composerNewChat')}
          onClick={() => useNewSessionStore.getState().openPanel()}
        >
          <span className={styles.newChatIcon} aria-hidden>
            <IconNewChatOutline20 />
          </span>
          <span className={styles.newChatText}>{t('composerNewChat')}</span>
        </button>
      ) : null}

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
      {/*
        [R8 缓存] 「正在同步」小标 / 「缓存」说明（与内容区那条细提示同款规矩）：
          - 连接还活着（connecting/ready/authing）→「正在同步…」= 真的在拉；
          - 连接已经没了（idle/error）→ 只标「缓存」：别谎称正在同步；
          - 超 TTL 的缓存照样显示，但后面跟一个「缓存」，说明它可能不是最新的。
      */}
      {!searching && cacheStatus.sessionsFromCache ? (
        <div className={styles.listHint} role="status">
          {syncingNow ? t('cacheSyncing') : t('cacheStaleTag')}
          {syncingNow && cacheStatus.sessionsStale ? ` · ${t('cacheStaleTag')}` : ''}
        </div>
      ) : null}

      <div className={styles.list}>
        {rows.length === 0 ? (
          searching ? (
            <div className={styles.empty}>{t(search.searching ? 'newSessionSearching' : 'newSessionSearchEmpty')}</div>
          ) : listPhase === 'skeleton' ? (
            // 缓存为空 + 正在拉：骨架，**不要**「远端还没有会话」（那是歧义）
            <ListSkeleton label={t('cacheListSkeleton')} />
          ) : (
            <div className={styles.empty}>{t(phase === 'ready' ? 'remoteSessionEmpty' : 'remotePhaseIdle')}</div>
          )
        ) : (
          rows.map((row) => {
            const active = row.id === activeSessionId
            const busy = busySessionId === row.id
            return (
              <div
                key={row.id}
                className={clsx(styles.row, (row.archived || row.ghost) && styles.rowArchived)}
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
                      {row.ghost ? (
                        <span className={styles.archivedTag}>{t('cacheSessionMissingTag')}</span>
                      ) : null}
                      {busy ? (
                        <span className={styles.itemBusy} aria-hidden>
                          <IconRefreshOutline16 />
                        </span>
                      ) : null}
                      {row.time ? <span className={styles.itemTime}>{row.time}</span> : null}
                      {/* [R9] 红点：别的会话有审批 / 提问等你处理（数字 >9 显示 9+） */}
                      {pendingTotal(pendingInteractions[row.id]) > 0 ? (
                        <span
                          className={styles.pendingDot}
                          aria-label={t('promptuxPendingBadge', {
                            count: pendingTotal(pendingInteractions[row.id]),
                          })}
                        >
                          {pendingBadgeText(pendingTotal(pendingInteractions[row.id]))}
                        </span>
                      ) : null}
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

/**
 * [R8 缓存] 列表骨架：缓存为空、又还没拿到 `session/list` 时用它。
 *
 * 为什么不用「远端还没有会话」：那句话是在**断言事实**，而此刻我们只是还没拿到列表 ——
 * 用户会以为会话丢了。灰条只表达「在等」，不表达结论。
 */
const ListSkeleton = ({ label }: { label: string }) => (
  <div className={styles.skeleton} role="status" aria-busy="true" aria-label={label}>
    <div className={styles.skeletonRow} data-width="88" />
    <div className={styles.skeletonRow} data-width="72" />
    <div className={styles.skeletonRow} data-width="92" />
    <div className={styles.skeletonRow} data-width="64" />
  </div>
)

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
