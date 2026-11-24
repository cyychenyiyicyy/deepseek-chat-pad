import clsx from 'clsx'
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { sessionListViewState } from '../../services/remote/cache.js'
import { describeRemoteError, lastRemoteTarget, type RemoteSearchHit } from '../../services/remote/sessionsApi.js'
import { forgetDeletedRemoteSession, useRemoteStore } from '../../services/remote/store.js'
import { deleteHostSession, hostHttpTarget, supportsSessionDeletion, type HostHttpTarget } from '../../services/remote/hostHttpActions.js'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import {
  IconBrowseOutline16,
  IconChevronDownOutline14,
  IconCloseOutline16,
  IconEllipsisOutline16,
  IconNewChatOutline20,
  IconRefreshOutline16,
  IconSearchOutline16,
} from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { closeMobileSider } from '../sider/mobileSiderState.js'
// [S3] 全局运行态：不打开会话也要知道谁在跑（`session/list` + `$events` 汇总而来）
import { useLiveSessions } from '../../services/remote/liveSessions.js'
/*
 * [D] 抽屉重设计（照 dsh-Go）：分块 / 状态筛选 / 行尾标记的判定全部抽成纯函数，
 * JSX 里只画不判（自测覆盖见 __selftest__/drawer-blocks.selftest.mts）。
 */
import {
  buildDrawerBlocks,
  buildDrawerRows,
  drawerFilterCounts,
  type DrawerFilter,
  type DrawerRow,
  type RowMarker,
} from './drawerBlocks.js'
import { useNewSessionStore, workspaceTitleFromPath } from '../../services/remote/newSessionStore.js'
import { workspaceSections } from '../../services/remote/workspacePreferences.js'
import { sessionBelongsToWorkspace } from './workspace/workspaceItems.js'
import styles from './RemoteSessionList.module.css'
/**
 * 远程会话列表 —— 侧栏里那份列表的远程版，外加**会话管理**（W1）：
 *
 *   - 顶部搜索框 → `session/search`（Host 的索引默认是关的 ⇒ 自动退回本地标题匹配）；
 *   - 每条右侧「⋯」/ 长按 / 右键 → 重命名、置顶、归档、派生；
 *   - 归档的会话**不隐藏**，而是沉底标「已归档」（[D] 起多了一行小节标题，行尾
 *     小标照旧），这样「取消归档」原地就能点（dsh-Go 有独立的已归档页，本批
 *     没有那个页面，隐藏了就没有回头路）。
 *   - [D] 列表结构照 dsh-Go 抽屉（drawer_list.dart / session_tile.dart）：
 *     置顶 → 今天 / 昨天 / 近 7 天 / 更早 → 已归档；状态筛选胶囊（全部 / 运行中 /
 *     待确认，drawer_filter_bar.dart）替代了原顶部那句「N 个会话在跑」汇总——
 *     同样的信息，胶囊还顺便成了筛选入口；一行只有标题 + **至多一个**行尾标记
 *     （待确认文字 > 运行中呼吸圆点；时间 / 工具名那行 meta 按原稿删掉）。
 *
 * 能力门禁：`capabilities.manage` 为 false 时「⋯」与长按/右键全部不渲染；
 * `phase !== 'ready'` 时同理（没有连接就没有远端可操作的东西）。
 */

/** 搜索输入的防抖（打字时不要每键一发） */
const SEARCH_DEBOUNCE_MS = 250
/** 长按多久算「要菜单」（触摸设备） */
const LONG_PRESS_MS = 480

/** [D] 状态筛选胶囊的三个档（drawer_filter_bar.dart：全部 / 运行中 / 待确认） */
const FILTER_OPTIONS: ReadonlyArray<{
  id: DrawerFilter
  labelKey: 'remoteDrawerFilterAll' | 'remoteDrawerFilterRunning' | 'remoteDrawerFilterPending'
}> = [
  { id: 'all', labelKey: 'remoteDrawerFilterAll' },
  { id: 'running', labelKey: 'remoteDrawerFilterRunning' },
  { id: 'pending', labelKey: 'remoteDrawerFilterPending' },
]

/** 数据层方法可能同步抛、也可能返回 rejected 的 promise；两者都只反映到 store 的 error */
const fireAndForget = (action: () => unknown) => {
  try {
    void Promise.resolve(action()).catch(() => undefined)
  } catch {
    // 同步抛错已由数据层写入状态，这里吞掉即可
  }
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
  const hostTarget = phase === 'ready' ? hostHttpTarget(lastRemoteTarget()) : null
  const [deletionSupport, setDeletionSupport] = useState<HostHttpTarget | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ target: HostHttpTarget; id: string; title: string } | null>(null)
  useEffect(() => {
    if (!hostTarget) return
    const abort = new AbortController()
    void supportsSessionDeletion(hostTarget, abort.signal).then((supported) => {
      if (supported && !abort.signal.aborted) setDeletionSupport(hostTarget)
    }).catch(() => undefined)
    return () => abort.abort()
  }, [hostTarget])
  /** [R8 缓存] 列表来源与同步态：缓存直出靠它标注「正在同步 / 缓存 / 已不存在」 */
  const cacheStatus = useRemoteStore((state) => state.cacheStatus)
  const capabilities = useNewSessionStore((state) => state.capabilities)
  const archivedIds = useNewSessionStore((state) => state.archivedSessionIds)
  const pinnedIds = useNewSessionStore((state) => state.pinnedSessionIds)
  const pinnedAuthoritative = useNewSessionStore((state) => state.pinnedAuthoritative)
  /** [R9] 别的会话里等着的审批 / 提问（活动会话不计，见 store 末尾「八」） */
  const pendingInteractions = useRemoteStore((state) => state.pendingInteractions)
  const menuSessionId = useNewSessionStore((state) => state.menuSessionId)
  const actionError = useNewSessionStore((state) => state.actionError)
  const search = useNewSessionStore((state) => state.search)
  const renameTarget = useNewSessionStore((state) => state.renameTarget)
  /* [R15] 工作区筛选（照 dsh-Go 抽屉的作用域）：列表按工作区收窄，多一个工作区才值得筛 */
  const workspaces = useNewSessionStore((state) => state.workspaces)
  const workspacePreferences = useNewSessionStore((state) => state.workspacePreferences)
  const workspaceSource = useNewSessionStore((state) => state.workspaceSource)
  const listWorkspaceFilter = useNewSessionStore((state) => state.listWorkspaceFilter)
  /*
   * [D] 状态筛选的当前档（drawer_filter_bar.dart 的 DrawerFilter）：本地 UI 态，
   * 只收窄这一屏的列表，不进 store（别的视图不关心，也不该跟着变）。
   */
  const [statusFilter, setStatusFilter] = useState<DrawerFilter>('all')

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

  /*
   * [R15] 工作区筛选的锚定菜单：与上面会话「⋯」菜单同一套基础设施
   * （`useAnchoredPosition` + `useDismiss` + body portal），视觉同款。
   */
  const [filterAnchor, setFilterAnchor] = useState<HTMLElement | null>(null)
  const [filterOpen, setFilterOpen] = useState(false)
  const filterAnchored = useAnchoredPosition<HTMLElement, HTMLDivElement>(filterOpen, {
    align: 'start',
    maxHeight: 320,
    measureKey: 'workspace-filter',
  })
  if (filterOpen && filterAnchor !== null) filterAnchored.anchorRef.current = filterAnchor
  useDismiss(filterOpen, [filterAnchored.floatingRef, filterAnchored.anchorRef], () => {
    setFilterOpen(false)
  })

  const searching = search.query.trim().length > 0

  /**
   * [R15] 工作区筛选的选项与生效值。
   *
   * 生效值要**核对存在**：换过连接 / 工作区被删之后 `listWorkspaceFilter` 可能指向
   * 一个已经不存在的 id，照筛就会得到一张凭空变空的列表 —— 那时当作没筛。
   * 显示名判定与 `workspaceItems.ts` 同一套（title → 路径末段 → id）。
   */
  const workspaceOptions = workspaces.map((workspace) => ({
    workspaceId: workspace.workspaceId,
    label:
      workspace.title.length > 0
        ? workspace.title
        : workspace.path.length > 0
          ? workspaceTitleFromPath(workspace.path)
          : workspace.workspaceId,
  }))
  const workspaceFilter =
    listWorkspaceFilter !== null && workspaceOptions.some((option) => option.workspaceId === listWorkspaceFilter)
      ? listWorkspaceFilter
      : null
  const workspaceFilterLabel =
    workspaceFilter === null
      ? t('newSessionWorkspaceFilterAll')
      : (workspaceOptions.find((option) => option.workspaceId === workspaceFilter)?.label ?? t('newSessionWorkspaceFilterAll'))
  const filterSections = filterOpen ? workspaceSections(workspaceOptions, workspacePreferences) : []

  /*
   * —— S3 全局运行态 ——
   *
   * 列表要回答「谁在跑」，而这个信息**不属于**任何单个会话的时间线：
   * 它来自 `session/list` 行的 `running` 与 Host 级 `$events`（`liveSessions.ts`）。
   * [D] 抽屉重设计后它只剩两块用法：① 标题行右侧的刷新图标；② 行尾的运行中呼吸
   * 圆点 / 待确认文字标签（判定在 drawerBlocks.ts）。原顶部那句「2 个会话在跑」
   * 汇总删掉了 —— 状态筛选胶囊把同样的信息表达得更好，还顺便成了筛选入口。
   *
   * 订阅整张表（而不是在 `.map` 里逐行订阅）：`liveSessions` 的归约保证「没变化就
   * 返回原对象」，所以这张表一天也换不了几次引用；在循环里调 hook 才是不允许的。
   */
  const liveById = useLiveSessions((state) => state.byId)

  /*
   * [D] 抽屉分块输入：工作区筛选后的全集（状态筛选在 buildDrawerBlocks 里做，
   * 两层筛选同时生效）。分块 / 行尾标记 / 胶囊计数全是 drawerBlocks.ts 的纯函数，
   * 判定口径与改造前逐条一致（running 看 liveById；待确认两条记账取大、活动会话不计）。
   */
  const workspaceMemberIds = workspaces.find((workspace) => workspace.workspaceId === workspaceFilter)?.sessionIds
  const authoritativeOrder = workspaceSource === 'follow' ? workspaceMemberIds : undefined
  const sessionsById = new Map(sessions.map((session) => [session.id, session]))
  const drawerInput = {
    sessions: workspaceFilter === null ? sessions : authoritativeOrder !== undefined
      ? authoritativeOrder.flatMap((id) => {
        const session = sessionsById.get(id)
        return session === undefined ? [] : [session]
      })
      : sessions.filter((session) => sessionBelongsToWorkspace(session, workspaceFilter, workspaceMemberIds)),
    preserveOrder: authoritativeOrder !== undefined,
    pinnedIds,
    pinnedAuthoritative,
    archivedIds,
    // [R8] 服务端这次没给、缓存里还有的行：标「已不存在」而不是闪一下消失
    ghostIds: cacheStatus.ghostSessionIds,
    liveById,
    pendingInteractions,
    activeSessionId,
  }
  const blocks = buildDrawerBlocks({ ...drawerInput, filter: statusFilter, now: Date.now() })
  const filterCounts = drawerFilterCounts(drawerInput)

  /** 搜索命中 → 抽屉行（远端命中的会话可能不在当前列表里：用 snippet 顶上，仍可点进去） */
  const searchRows = searching
    ? buildDrawerRows({
      ...drawerInput,
      sessions: (search.hits ?? []).map((hit: RemoteSearchHit) => {
        const known = sessions.find((session) => session.id === hit.sessionId)
        return {
          id: hit.sessionId,
          title:
            known !== undefined && known.title.length > 0
              ? known.title
              : hit.snippet.length > 0
                ? hit.snippet
                : hit.sessionId,
          ...(known?.updatedAt === undefined ? {} : { updatedAt: known.updatedAt }),
          ...(known?.pinned === true ? { pinned: true } : {}),
        }
      }),
      // 命中顺序 = 相关性顺序（dsh-Go 的搜索在抽屉外，本列表保持原有的命中序不重排）
      preserveOrder: true,
    })
    : []

  const rows = searching ? searchRows : blocks.flatMap((block) => block.rows)
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
  /**
   * [R20 排版] 两排胶囊合成一行后各自的出现条件（判据不变，只改位置）：
   *   - 工作区：多于一个工作区才有筛选的意义；
   *   - 状态：列表为空且停在「全部」时不出现；筛选还开着时**保留**（否则用户被空态困住）。
   */
  const showWorkspaceChip = workspaceOptions.length > 1
  const showStatusBar = drawerInput.sessions.length > 0 || statusFilter !== 'all'

  /** [D] 一行（session_tile.dart 的两块）：标题 + 行尾「至多一个」标记；判定都在纯函数里 */
  const renderRow = (row: DrawerRow) => {
    const active = row.id === activeSessionId
    return (
      <div
        key={row.id}
        className={clsx(
          styles.row,
          // 归档 / ghost 行整体降不透明度（dsh-Go 无此概念，是 ChatPad 既有行为）
          (row.archived || row.ghost) && styles.rowArchived,
        )}
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
            /*
             * [R15] 新对话页是**整页视图**（W6）：它开着的时候点会话，
             * `openSession` 只换 `activeSessionId`，内容区还被新对话页占着 ——
             * 用户看到的就是「点了没反应」。所以这里必须顺手把那页关掉。
             * `closePanel` 幂等、也不动 notice / 草稿，多关一次没有副作用。
             *
             * [R17] 没连上时（列表此时多半是缓存直出）：`openSession` 只会静默失败，
             * 错误写在右侧那一屏里，看起来还是「点了没反应」—— 先说一句人话再走。
             * 「假 ready」（链路悄悄断开、phase 撒谎）由 `requireSession` 纠正，
             * 不归这里管。
             */
            useNewSessionStore.getState().closePanel()
            if (useRemoteStore.getState().phase !== 'ready') {
              showToast(t('remoteDrawerNotConnected'))
              return
            }
            fireAndForget(() => useRemoteStore.getState().openSession(row.id))
            onSelect?.(row.id)
          }}
        >
          <span className={styles.itemTitle}>{row.title.length > 0 ? row.title : t('remoteSessionUntitled')}</span>
          {/* 行尾「至多一个」标记：session_tile.dart:71-80 的优先级已在 rowMarkerOf 判好 */}
          <RowMarkerBadge marker={row.marker} />
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
  }

  return (
    <div className={clsx(styles.wrap, className)}>
      {ready && capabilities.create ? (
        <button
          type="button"
          className={styles.newChat}
          onClick={() => {
            closeMobileSider()
            useNewSessionStore.getState().openPanel()
          }}
        >
          <span className={styles.newChatIcon} aria-hidden><IconNewChatOutline20 /></span>
          {t('composerNewChat')}
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
              if (event.key !== 'Escape' || draft.length === 0) return
              event.preventDefault()
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
          ) : (
            <IconButton
              size="xs"
              icon={<IconRefreshOutline16 />}
              tooltip={t('liveRefresh')}
              tooltipPlacement="bottom"
              onClick={() => fireAndForget(() => useRemoteStore.getState().refreshSessions())}
            />
          )}
        </div>
      ) : null}

      {/*
        [R20 排版] 工作区筛选 + 状态筛选**挤进同一行**。
        dsh-Go 是上下两行（`WorkspaceSwitcher` 一行、`DrawerFilterBar` 一行），但它的行高
        与留白比我们松、抽屉也更宽；在手机抽屉里两行胶囊会把列表顶端顶掉 60px。
        整行横向可滚，大字号也放得下；两层筛选仍然同时生效（状态在 `buildDrawerBlocks` 里做）。
        搜索中两排都不出现：命中列表本身就是一层筛选。
      */}
      {ready && !searching && (showWorkspaceChip || showStatusBar) ? (
        <div className={styles.filterRow}>
          {showWorkspaceChip ? (
            <button
              type="button"
              className={clsx(styles.filterChip, workspaceFilter !== null && styles.filterChipActive)}
              aria-label={t('newSessionWorkspaceFilterLabel')}
              aria-expanded={filterOpen}
              onClick={(event) => {
                setFilterAnchor(event.currentTarget)
                setFilterOpen(!filterOpen)
              }}
            >
              <span className={styles.filterIcon} aria-hidden>
                <IconBrowseOutline16 />
              </span>
              <span className={styles.filterLabel}>{workspaceFilterLabel}</span>
              <span className={styles.filterChevron} aria-hidden>
                <IconChevronDownOutline14 />
              </span>
            </button>
          ) : null}

          {showStatusBar ? (
            <div className={styles.filterBar} role="group" aria-label={t('remoteSessionStatusFilter')}>
              {FILTER_OPTIONS.map(({ id, labelKey }) => {
                const selected = statusFilter === id
                const count = id === 'running' ? filterCounts.running : id === 'pending' ? filterCounts.pending : 0
                return (
                  <button
                    key={id}
                    type="button"
                    className={clsx(
                      styles.filterChip,
                      styles.statusChip,
                      selected && styles.filterChipActive,
                    )}
                    aria-pressed={selected}
                    onClick={() => setStatusFilter(id)}
                  >
                    {t(labelKey)}
                    {selected && id !== 'all' ? ` ${count}` : ''}
                  </button>
                )
              })}
            </div>
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
          ) : statusFilter !== 'all' ? (
            // [D] 状态筛出了空：各自一句空态（胶囊还在，随时点回「全部」）
            <div className={styles.empty}>{t(statusFilter === 'running' ? 'remoteDrawerNoRunning' : 'remoteDrawerNoPending')}</div>
          ) : listPhase === 'skeleton' ? (
            // 缓存为空 + 正在拉：骨架，**不要**「远端还没有会话」（那是歧义）
            <ListSkeleton label={t('cacheListSkeleton')} />
          ) : workspaceFilter !== null ? (
            // [R15] 筛选开着而列表为空：说清楚是「这个工作区没有」，不是「远端没有」
            <div className={styles.empty}>{t('newSessionWorkspaceNoSessions')}</div>
          ) : (
            <div className={styles.empty}>{t(phase === 'ready' ? 'remoteSessionEmpty' : 'remotePhaseIdle')}</div>
          )
        ) : searching ? (
          // 搜索命中：拍平一行行（命中序，不重新分块）
          rows.map(renderRow)
        ) : (
          /*
           * [D] 分块渲染（drawer_list.dart:116-160）：置顶 → 今天 / 昨天 / 近 7 天 /
           * 更早 → 已归档。空块在纯函数里就没生成，这里不用再判。
           */
          blocks.map((block) => (
            <Fragment key={block.kind === 'day' ? `day-${block.bucket ?? 'x'}` : block.kind}>
              {block.labelKey !== undefined ? (
                <div className={styles.eyebrow} role="heading" aria-level={2}>
                  {t(block.labelKey)}
                </div>
              ) : null}
              {block.rows.map(renderRow)}
            </Fragment>
          ))
        )}
      </div>

      {menuOpen && menuRow !== undefined
        ? createPortal(
          <div ref={anchored.floatingRef} className={styles.menu} style={anchored.position ?? undefined} role="menu">
            <MenuRow
              label={t('newSessionMenuRename')}
              onSelect={() =>
                useNewSessionStore
                  .getState()
                  .beginRename(menuRow.id, menuRow.title.length > 0 ? menuRow.title : t('remoteSessionUntitled'))
              }
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
            {hostTarget && deletionSupport === hostTarget && !menuRow.ghost && <MenuRow
              label={t('remoteSessionDelete')}
              onSelect={() => setDeleteTarget({ target: hostTarget, id: menuRow.id, title: menuRow.title })}
            />}
          </div>,
          document.body,
        )
        : null}
      {deleteTarget && deleteTarget.target === hostTarget && <DeleteSessionDialog
        selection={deleteTarget} onClose={() => setDeleteTarget(null)}
      />}

      {/*
        [R15] 工作区筛选菜单：与「⋯」菜单同款外观。第一行永远是「全部工作区」，
        之后是每个工作区；当前生效的那行高亮（`menuitemradio`）。
      */}
      {filterOpen
        ? createPortal(
          <div
            ref={filterAnchored.floatingRef}
            className={styles.menu}
            style={filterAnchored.position ?? undefined}
            role="menu"
            aria-label={t('newSessionWorkspaceFilterLabel')}
          >
            <FilterRow
              label={t('newSessionWorkspaceFilterAll')}
              selected={workspaceFilter === null}
              onSelect={() => {
                useNewSessionStore.getState().selectListWorkspace(null)
                setFilterOpen(false)
              }}
            />
            {filterSections.map((section) => {
              const title = section.kind === 'pinned' ? t('remoteWorkspacePinnedSection')
                : section.name ?? (filterSections.length > 1 ? t('remoteWorkspaceOtherSection') : undefined)
              return (
                <div key={section.kind === 'group' ? `group:${section.name}` : section.kind} role="group" aria-label={title}>
                  {title && <div className={styles.menuGroupTitle} aria-hidden>{title}</div>}
                  {section.items.map((option) => (
                    <FilterRow
                      key={option.workspaceId}
                      label={option.label}
                      selected={workspaceFilter === option.workspaceId}
                      onSelect={() => {
                        useNewSessionStore.getState().selectListWorkspace(option.workspaceId)
                        setFilterOpen(false)
                      }}
                    />
                  ))}
                </div>
              )
            })}
          </div>,
          document.body,
        )
        : null}

      {renameTarget !== null ? <RenameDialog /> : null}
    </div>
  )
}

/**
 * [D] 行尾「至多一个」标记（session_tile.dart:71-80 的优先级已在 `rowMarkerOf`
 * 判好，这里只做显示映射）：待确认文字标签 > 运行中呼吸圆点 > ghost「已不存在」
 * /「已归档」小标。没有标记的行就是纯标题，行尾留白。
 */
const RowMarkerBadge = ({ marker }: { marker: RowMarker | null }) => {
  const t = useTranslate()
  if (marker === 'pending') {
    return <span className={styles.markerPending}>{t('remoteDrawerFilterPending')}</span>
  }
  if (marker === 'running') {
    return (
      <span className={styles.markerRunning} aria-label={t('liveRunning')}>
        <span className={styles.pulseDot} aria-hidden />
      </span>
    )
  }
  if (marker === 'ghost') {
    return <span className={styles.archivedTag}>{t('cacheSessionMissingTag')}</span>
  }
  if (marker === 'archived') {
    return <span className={styles.archivedTag}>{t('newSessionArchivedTag')}</span>
  }
  return null
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
function DeleteSessionDialog({ selection, onClose }: {
  selection: { target: HostHttpTarget; id: string; title: string }
  onClose: () => void
}) {
  const t = useTranslate()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [outcomeUnknown, setOutcomeUnknown] = useState(false)
  const submitted = useRef(false)
  const close = () => { if (!submitted.current) onClose() }
  async function confirm() {
    if (submitted.current || outcomeUnknown) return
    submitted.current = true
    setPending(true)
    setError('')
    const current = () => lastRemoteTarget() === selection.target
    try {
      await deleteHostSession(selection.target, selection.id, current)
      if (!current()) return
      forgetDeletedRemoteSession(selection.target, selection.id)
      onClose()
      fireAndForget(() => useRemoteStore.getState().refreshSessions())
    } catch (failure) {
      if (!current()) return
      const info = describeRemoteError(failure)
      if (info.code === 'DELETE_OUTCOME_UNKNOWN') {
        setOutcomeUnknown(true)
        setError(t('remoteSessionDeleteUnknown'))
        fireAndForget(() => useRemoteStore.getState().refreshSessions())
      } else {
        setError(info.text)
      }
    } finally {
      submitted.current = false
      if (current()) setPending(false)
    }
  }
  return <Modal title={t('remoteSessionDelete')} onClose={close} closable={!pending} footer={
    <>
      <Button variant="outlined" size="m" disabled={pending} onClick={onClose}>{t(outcomeUnknown ? 'close' : 'cancel')}</Button>
      {!outcomeUnknown && <Button variant="danger" size="m" disabled={pending} onClick={() => void confirm()}>{t('remoteSessionDelete')}</Button>}
    </>
  }>
    <p>{t('remoteSessionDeleteConfirm', { title: selection.title || t('remoteSessionUntitled') })}</p>
    {pending && <p role="status">{t('remoteSessionDeleting')}</p>}
    {error && <p role="alert">{error}</p>}
  </Modal>
}

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

/**
 * [R15] 工作区筛选菜单的一行：可选中态（`menuitemradio`）+ 选中高亮。
 * 与 `MenuRow` 分开是因为两者语义不同：这个菜单**点中即改即关**，不碰会话菜单的状态。
 */
const FilterRow = ({
  label,
  selected,
  onSelect,
}: {
  label: string
  selected: boolean
  onSelect: () => void
}) => (
  <div
    className={clsx(styles.menuOption, selected && styles.menuOptionSelected)}
    role="menuitemradio"
    aria-checked={selected}
    onClick={onSelect}
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
