import clsx from 'clsx'
import { Fragment, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import { stripDsml } from '../../services/api/dsml.js'
import type {
  ApprovalActivity,
  ChatItem,
  ChatMessage,
  ToolActivity,
} from '../../services/remote/adapter.js'
import { historyEntriesFromRecords } from '../../services/remote/adapter.js'
import { useRemotePaging, useRemoteStore, hydrateCachedTimeline, remoteDraftOwner, remoteSessionSelectionVersion } from '../../services/remote/store.js'
import { RemoteVoiceInput } from './composer/RemoteVoiceInput.js'
import { loadToolImage } from '../../services/remote/filesApi.js'
import { forkPointBeforePrompt, isVisibleRemoteMessage, messageActionPoints } from '../../services/remote/messageActions.js'
import { TERMINAL_CAPABILITY, type TerminalScope } from '../../services/remote/terminal.js'
import {
  timelineHintState,
  timelineViewState,
} from '../../services/remote/cache.js'
import { describeRemoteError, lastRemoteTarget, pageHistory, type RemotePromptAttachment } from '../../services/remote/sessionsApi.js'
import {
  commandLineOf,
  filterCommands,
  slashQuery,
  useChatControls,
} from '../../services/remote/sessionControls.js'
import { useNewSessionStore } from '../../services/remote/newSessionStore.js'
/*
 * [S1 无感重载] 界面状态的存取（草稿 / 会话 / 滚动位置）。
 * 两层：`sessionStorage`（页面内重载）> 原生中转箱 / 内存镜像（WebView 被就地换掉）。
 */
import {
  flushUiState,
  loadBootUiState,
  patchActiveSession,
  patchDraft,
  patchMode,
  patchTimelineScroll,
  resolveActiveSession,
  resolveTimelineScroll,
} from '../../services/remote/uiState.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { showToast } from '../base/toastState.js'
import {
  IconDataOutline16,
  IconLinkOutline16,
  IconCloseOutline16,
  IconNewChatOutline20,
} from '../base/icons.js'
import { Markdown } from '../markdown/Markdown.js'
import { CopyButton } from '../messages/CopyButton.js'
import { ReadAloudButton } from '../messages/ReadAloudButton.js'
import { stopReadAloud, useReadAloud } from '../../services/speech/readAloud.js'
import { openRemoteWorkspaceDialog } from './RemoteWorkspaceDialog.js'
import { openMobileSider } from '../sider/mobileSiderState.js'
import { ApprovalCard } from './ApprovalCard.js'
// 产物卡：官方 `present` 交付的文件，长在「这一轮最后一行」的下方（S5）。
// 上一轮（R12）那套从写类工具参数里猜产物的组件（`./artifacts/**`）已按原生机制删除。
import { ArtifactTurnTail } from './artifact/ArtifactCard.js'
import { turnArtifactsOf } from '../../services/remote/artifacts.js'
import { ChatControlsError, SessionControlsBar } from './chat-controls/SessionControlsBar.js'
import { QuestionCard } from './chat-controls/QuestionCard.js'
import { approvalAllowsOnce, approvalInsightOf } from './chat-controls/promptModel.js'
import { QueueDock } from './chat-controls/QueueDock.js'
import { SlashCommandList } from './chat-controls/SlashCommandList.js'
import { aggregateUsage } from './chat-controls/usage.js'
import controlsStyles from './chat-controls/Controls.module.css'
import { ComposerRow, useComposerProbe } from './composer/ComposerRow.js'
import {
  composerHint,
  composerIntent,
  composerView,
  type ComposerSignals,
  type PromptMode,
} from './composer/composerState.js'
import { supportsPromptMode } from './composer/promptMode.js'
// [R14 多 Host] 顶栏的「当前电脑 + 切换下拉」（组件内部自己判显隐，这里只挂一个点）
import { NewSessionPage } from './new-session/NewSessionPage.js'
import type { NewVoiceCall } from './RemoteVoiceCall.js'
import { PlanProgressDock } from './plan/PlanProgressDock.js'
import { useRemoteAvailability, useRemoteMode } from './RemoteModeSwitch.js'
import { RemoteImageStrip, ToolCard } from './tool/ToolCard.js'
import { AttachmentButton } from './workspace/AttachmentButton.js'
import { AttachmentTray } from './workspace/AttachmentTray.js'
import { readyReceipts, useWorkspacePane, workspaceAttachmentOwner } from './workspace/workspacePaneStore.js'
import styles from './RemoteChatView.module.css'

const RemoteTerminal = lazy(() => import('./RemoteTerminal.js'))
const RemoteJobs = lazy(() => import('./RemoteJobs.js'))
const RemotePromptTools = lazy(() => import('./RemotePromptTools.js'))
const RemoteSessionGoal = lazy(() => import('./RemoteSessionGoal.js'))
const RemoteFeedback = lazy(() => import('./RemoteFeedback.js'))
const RemoteConversationExport = lazy(() => import('./RemoteConversationExport.js'))
const RemoteVoiceCall = lazy(() => import('./RemoteVoiceCall.js'))
const RemoteSessionDetails = lazy(() => import('./RemoteSessionDetails.js'))
type SessionTool = 'terminal' | 'jobs' | 'skills' | 'references' | 'goal' | 'feedback' | 'export' | 'voice' | 'details'

/**
 * 远程会话页：顶栏（transport 徽标 + 模式切换）+ 时间线 + 审批卡片 + 吸底输入框。
 *
 * 为什么不复用 `MessageList` / `AssistantMessage`：它们的入参是本地 `Session` / `Message`
 * （带分支树、搜索步骤、附件、朗读…），而远端给的是 `ChatItem[]`（消息 / 工具 / 审批 / 问答四类）。
 * 硬做一次 `ChatItem → Message` 的降维会把本地那套假设全带进来；这里改为直接按 `ChatItem`
 * 渲染，正文仍用**同一个** `Markdown` 组件（含代码块、公式、链接），视觉与本地会话一致。
 *
 * 决定值取**数据层自己的联合类型**（下面 `ApprovalDecision`），不在这里另抄一份枚举：
 * Harness v1 只允许 `allow_once | deny`（`docs/protocol.md`、`AGENTS.md` 的审批约束），
 * 和 `adapter.ts` 里展示用的 `ApprovalOutcome`（allowed-once / rejected）是两个概念。
 */
type ApprovalDecision = Parameters<
  ReturnType<typeof useRemoteStore.getState>['respondApproval']
>[1]

/** 距底部小于该值时视为「在底部」，新内容到达后继续跟随 */
const STICKY_THRESHOLD = 40
/** 距顶部小于该值时自动往前拉一屏历史 */
const LOAD_OLDER_THRESHOLD = 80
/**
 * [S1] 滚动位置落盘的节流间隔（毫秒）。
 *
 * 滚动事件一秒能来几十次，每次都写一遍 `sessionStorage` 纯属浪费；而 400ms 的丢失窗口
 * 在「切出去」这个场景里等于 0 —— 真正救命的是 `visibilitychange → hidden` 的那次 flush。
 */
const SCROLL_SAVE_INTERVAL_MS = 400
/**
 * [S1] 「等内容铺够再滚回去」的等待上限（毫秒）。
 *
 * 缓存是一批批来的：内容还没渲染出来时滚不到目标位置。等太久还不如别跳
 * （否则用户正看着上面，一屏刚加载完突然把位置拽走）。
 */
const SCROLL_RESTORE_TIMEOUT_MS = 4_000
/**
 * 停止请求的等待上限（与 dsh-Go 一致）：`session/cancel` 只回 `accepted`，
 * 真正的终态是 `turn/end.reason.kind='aborted'`；10 秒连回执都没有就把按钮还原，
 * 免得用户对着一个点了没反应的停止键。
 */
const STOP_TIMEOUT_MS = 10_000

/** 数据层方法可能同步抛、也可能返回 rejected 的 promise；两者都只反映到 store 的 error */
const fireAndForget = (action: () => unknown) => {
  try {
    void Promise.resolve(action()).catch(() => undefined)
  } catch {
    // 同步抛错已由数据层写入状态，界面不重复提示
  }
}

export const RemoteChatView = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const phase = useRemoteStore((state) => state.phase)
  const transport = useRemoteStore((state) => state.transport)
  const connectedHost = useRemoteStore((state) =>
    state.hosts.find((host) => host.deviceId === state.hostId)?.name || state.lastSession?.hostName
  )
  const sessions = useRemoteStore((state) => state.sessions)
  const activeSessionId = useRemoteStore((state) => state.activeSessionId)
  const hasMoreHistory = useRemotePaging((state) => state.hasMore)
  const loadingOlder = useRemotePaging((state) => state.loadingOlder)
  const allowsTerminal = useRemoteStore((state) => state.capabilities.includes(TERMINAL_CAPABILITY))
  const [sessionTool, setSessionTool] = useState<{ kind: SessionTool; scope: TerminalScope; messageId?: string } | null>(null)
  const [newVoiceCall, setNewVoiceCall] = useState<NewVoiceCall | null>(null)
  const closeNewVoiceCall = useCallback(() => setNewVoiceCall(null), [])
  const hostId = useRemoteStore((state) => state.hostId ?? state.lastSession?.hostDeviceId ?? null)
  const serverUrl = useRemoteStore((state) => state.activeServerUrl ?? state.lastSession?.serverUrl ?? null)
  const owner = JSON.stringify([serverUrl, hostId])
  const items = useRemoteStore((state) => state.items)
  const remoteCapabilities = useRemoteStore((state) => state.capabilities)
  const canReadAloud = useSettings((state) => Boolean(state.apiKey))
  useEffect(() => () => {
    if (useReadAloud.getState().messageId?.startsWith('remote:')) stopReadAloud()
  }, [serverUrl, hostId, activeSessionId])
  const streaming = useRemoteStore((state) => state.streaming)
  /** [R8 缓存] 内容来源 / 首次拉取是否结束：加载态三态与顶部提示全靠它 */
  const cacheStatus = useRemoteStore((state) => state.cacheStatus)
  const error = useRemoteStore((state) => state.error)
  /** 重启后自动恢复的进度（K4）：失败时给一个「重试」，不弹红条 */
  const autoConnect = useRemoteStore((state) => state.autoConnect)
  /** 掉线自愈的进度（R10）：连接断了就显示「正在重连…」，**不**说凭据失效 */
  const reconnect = useRemoteStore((state) => state.reconnect)
  /** 新建会话能力（W1）：Host 没有 `session/create` 时入口整块隐藏 */
  const canCreateSession = useNewSessionStore((state) => state.capabilities.create)
  /** [R15] 新对话「发送即建会话」进行中：输入框灰住、顶栏给角标 */
  const creatingSession = useNewSessionStore((state) => state.creating)
  /** [R17] 新对话页的附件草稿（未上传；`createAndSend` 建完会话才传） */
  const newDraftFiles = useNewSessionStore((state) => state.draftFiles)
  /*
   * ── 视图（W6）──────────────────────────────────────────────────────
   * `view` 是**真实切换**，不是浮在上面的层：进出都由 `newSessionStore.open` 驱动
   * （任何入口调 `openPanel()` 都算），所以列表 / 搜索 / 会话内控制那边一行都不用改，
   * 也不会出现「面板背后还压着会话列表」的观感。
   *
   * 返回 = `closePanel()`：`activeSessionId` 与时间线都还在 store 里没动过，
   * 所以回去就是原来那一个会话，不重新拉一次。
   *
   * 空态（这台 Host 一个会话都没有）直接进这一页（dsh-Go 的做法：新对话就是整屏空态）；
   * `autoEnteredRef` 保证只有一次 —— 用户按「返回」退出来之后，看到的是带大按钮的空态，
   * 不会立刻又被弹回去。
   */
  const newSessionOpen = useNewSessionStore((state) => state.open)
  const view: 'chat' | 'new-session' = newSessionOpen ? 'new-session' : 'chat'
  const autoEnteredRef = useRef(false)
  /** 工作区文件能力（W3）：Host 回过 `METHOD_NOT_FOUND` 后入口整块隐藏（`null` = 还没探过） */
  const filesSupported = useWorkspacePane((state) => state.filesSupported)
  const workspaceOpen = useWorkspacePane((state) => state.open)
  const allAttachments = useWorkspacePane((state) => state.attachments)
  const restoringAttachments = useWorkspacePane((state) => state.restoringAttachments)
  const attachmentOwner = workspaceAttachmentOwner()
  const attachments = useMemo(
    () => allAttachments.filter((attachment) =>
      attachment.owner === attachmentOwner && attachment.sessionId === activeSessionId),
    [activeSessionId, allAttachments, attachmentOwner],
  )
  // 原生桥探测：只在远程会话页挂载时发生（启动路径上没有任何探测）
  const { availability, retry } = useRemoteAvailability()

  /*
   * ── [S1 无感重载] 启动快照 ───────────────────────────────────────────
   * 页面重载 / WebView 被就地换掉之后，先把「上一次那一屏」取回来：
   *   - 草稿层：`sessionStorage`（同一个 WebView 里重新加载时还在）；
   *   - 缓存层：原生中转箱 / 内存镜像（换过 WebView 时浏览器已经把它清空了）。
   * 两层怎么选见 `uiState.ts` 的 `resolveDraftRestore()`（草稿 > 缓存 > 空）。
   *
   * 只读、同步、微秒级：**不 await、不阻塞首屏、也不需要等连接** —— 这是「恢复得快」
   * 的前提（等连接就绪再恢复，用户先看到的就是一屏空白）。
   */
  const bootUi = useMemo(() => loadBootUiState(), [])
  const [bootOwner] = useState(owner)
  const restoredSessionId = owner === bootOwner
    ? resolveActiveSession({ primary: bootUi.primary, fallback: bootUi.fallback, owner })
    : null
  const [drafts, setDrafts] = useState(() => new Map(Object.entries(
    (bootUi.primary ?? bootUi.fallback)?.drafts ?? {},
  )))
  const [initialHostId] = useState(hostId)
  const [initialServerUrl] = useState(serverUrl)
  const draftsRef = useRef(drafts)
  const writeDraft = useCallback((key: string, text: string, legacyKey: string | null = null) => {
    const next = new Map(draftsRef.current)
    if (legacyKey !== null) {
      next.delete(legacyKey)
      patchDraft(legacyKey, '')
    }
    if (text === '') next.delete(key)
    else next.set(key, text)
    draftsRef.current = next
    setDrafts(next)
    patchDraft(key, text)
  }, [])
  const draftSessionId = view === 'new-session' ? null : activeSessionId ?? restoredSessionId
  const savedSession = useRemoteStore((state) => state.lastSession)
  const draftPeer = useMemo(() => remoteDraftOwner(true), [phase, savedSession, hostId, serverUrl])
  const [initialDraftPeer] = useState(draftPeer)
  const previousScopedDraftKey = JSON.stringify([serverUrl, hostId, draftSessionId])
  const draftKey = draftPeer !== null ? JSON.stringify([draftPeer, draftSessionId]) :
    hostId === null ? draftSessionId ?? '' : previousScopedDraftKey
  const previousDraftKey = JSON.stringify([hostId, draftSessionId])
  const canRestoreLegacy = hostId !== null && hostId === initialHostId && serverUrl === initialServerUrl && draftPeer === initialDraftPeer
  const legacyDraftKey = !canRestoreLegacy ? null : drafts.has(previousScopedDraftKey) && draftKey !== previousScopedDraftKey ? previousScopedDraftKey
    : drafts.has(previousDraftKey) ? previousDraftKey
    : draftSessionId === restoredSessionId ? restoredSessionId ?? '' : null
  const draft = drafts.get(draftKey) ?? (legacyDraftKey === null ? '' : drafts.get(legacyDraftKey) ?? '')
  const setDraft = useCallback((text: string) => writeDraft(draftKey, text, legacyDraftKey),
    [draftKey, legacyDraftKey, writeDraft])
  const restoreDraft = useCallback((text: string) => {
    if (!draftsRef.current.has(draftKey)) setDraft(text)
  }, [draftKey, setDraft])
  /** 时间线要滚回的位置（`null` = 没有要恢复的；用掉一次就清空） */
  const pendingScrollRef = useRef<number | null>(
    resolveTimelineScroll({
      primary: bootUi.primary,
      fallback: bootUi.fallback,
      sessionId: restoredSessionId,
      owner: bootOwner,
    }),
  )
  /** 草稿 / 滚动位置该记在哪个会话名下（会话还没开起来时用恢复目标） */
  const scrollSavedAtRef = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const acceptDictation = (transcript: string) => {
    const input = textareaRef.current
    if (!input) return
    const text = input.value
    const start = input.selectionStart
    const end = input.selectionEnd
    setDraft(text.slice(0, start) + transcript + text.slice(end))
    requestAnimationFrame(() => {
      if (textareaRef.current !== input || !input.isConnected) return
      input.focus({ preventScroll: true })
      input.setSelectionRange(start + transcript.length, start + transcript.length)
    })
  }
  const stickyRef = useRef(true)
  const scrollTopRef = useRef(0)
  const olderPendingRef = useRef(false)
  const itemCountRef = useRef(0)

  /*
   * ── 会话内控制（W2）────────────────────────────────────────────────
   * 模型 / 权限 / 命令 / 队列 / 提问这五块的状态都在 `services/remote/sessionControls.ts`
   * （`session/control` 投影 + `$events` waterfall 归约出来），这里只读它与调它的动作。
   * 输入区自己额外管三件纯 UI 的事：补全高亮下标、补全是否被 Esc 关掉、命令执行结果的一行提示。
   */
  const controlTitle = useChatControls((state) => state.title)
  const slashCommands = useChatControls((state) => state.commands)
  const commandAccess = useChatControls((state) => state.commandAccess)
  const executeCommand = useChatControls((state) => state.executeCommand)
  /** 排队条数：输入区的「工作中」判定要把「队列里还有待发」也算进去（见 composerState） */
  const queueLength = useChatControls((state) => state.queue.length)
  const [commandCursor, setCommandCursor] = useState(0)
  const [commandDismissed, setCommandDismissed] = useState(false)
  const [commandResult, setCommandResult] = useState<string | null>(null)
  /** 运行中发送的方式：插话（steer，默认，与 dsh-Go 一致）/ 排队（queue） */
  const [sendMode, setSendMode] = useState<PromptMode>('steer')
  /** 停止请求 10s 没回执：主按钮从停止还原成发送 */
  const [stopTimedOut, setStopTimedOut] = useState(false)
  const [sendingKeys, setSendingKeys] = useState<ReadonlySet<string>>(() => new Set())
  const sendsInProgress = useRef(new Set<string>())

  const ready = phase === 'ready'
  const openSessionTool = (kind: SessionTool, messageId?: string) => {
    const target = lastRemoteTarget()
    if (!target || !activeSessionId) return
    const selection = remoteSessionSelectionVersion()
    setSessionTool({ kind, messageId, scope: {
      target,
      sessionId: activeSessionId,
      current: () => {
        const state = useRemoteStore.getState()
        return state.phase === 'ready' && state.activeSessionId === activeSessionId &&
          remoteSessionSelectionVersion() === selection && !useNewSessionStore.getState().open
      },
    } })
  }

  const openNewVoiceCall = () => {
    const target = lastRemoteTarget()
    if (!target) return
    let selection = remoteSessionSelectionVersion()
    const ownsSelection = () => useRemoteStore.getState().phase === 'ready' &&
      lastRemoteTarget() === target && remoteSessionSelectionVersion() === selection
    const current = () => ownsSelection() && useNewSessionStore.getState().open
    setNewVoiceCall({
      target,
      current,
      start: async (text, signal, onDispatch) => {
        if (!current()) return false
        const sent = await useNewSessionStore.getState().createAndSend(text, {
          signal,
          onDispatch: (sessionId, before, requestId) => {
            selection = remoteSessionSelectionVersion()
            onDispatch({ before, requestId, scope: {
              target, sessionId,
              current: () => ownsSelection() && useRemoteStore.getState().activeSessionId === sessionId,
            } })
          },
        })
        return sent
      },
    })
  }

  /*
   * [R10] 掉线自愈的文案（**中性**）：连接断了不等于凭据失效 —— 后台待久了服务端会踢掉连接
   *（75 s 收不到心跳），这一支只显示「正在重连…（第 N 次）」或「暂时连不上服务器」，
   * **绝不**出现「凭据 / 登录过期」字样。真需要人处理的（登录过期 / 设备撤销 / 身份不符）
   * 不进这两支，继续走下面的红字分支。
   */
  const healing = reconnect.status === 'waiting' || reconnect.status === 'connecting'
  const canReconnect = healing || reconnect.status === 'failed' ||
    (autoConnect.state === 'failed' && autoConnect.code !== 'SESSION_EXPIRED' &&
      reconnect.status !== 'blocked' && reconnect.status !== 'need-login')
  const healingTitle =
    reconnect.status === 'failed'
      ? t(reconnect.kind === 'offline' ? 'reconnectOffline' : 'reconnectFailed')
      : t('reconnectProgress', { attempt: Math.max(reconnect.attempt, 1), max: reconnect.maxAttempts })
  const healingHint =
    reconnect.status === 'failed'
      ? t(reconnect.kind === 'offline' ? 'reconnectOfflineHint' : 'reconnectFailedHint')
      : t('reconnectProgressHint')

  const bridgeReady = availability === 'ready'
  const sessionsTitle = sessions.find((session) => session.id === activeSessionId)?.title
  /*
   * [R16] 侧栏开合 + 子代理的来路。
   *
   * 开关：本机模式的侧栏开关在 `TabletHeader`；远程模式的顶栏原来没有这枚键，
   * 侧栏一收起就再也没有入口展开（真机反馈「收起了展不开」）。这里补同一枚。
   *
   * 来路：活动会话若是子代理（`session/list` 行上带 parentSessionId），顶栏给一条
   * 「‹ 上级对话」回去的路 —— dsh-Go `header_agents.dart:92` 的做法。rows 是快照，
   * 列表刷新时会更新；查不到就当普通会话，不画。
   */
  const sessionRows = useNewSessionStore((state) => state.rows)
  const subagentParentId = activeSessionId === null
    ? null
    : sessionRows.find((row) => row.sessionId === activeSessionId)?.parentSessionId ?? null
  const subagentParentTitle =
    subagentParentId === null
      ? ''
      : sessionRows.find((row) => row.sessionId === subagentParentId)?.title ?? ''
  // 标题以 `session/control` 投影为最新（Host 会自动起名 / 用户可以改名），列表里的那份兜底
  const activeTitle =
    controlTitle !== null && controlTitle.length > 0
      ? controlTitle
      : (sessionsTitle ?? t('remoteSessionUntitled'))
  /** 时间线汇总的用量（投影没给 `usage` 时给「会话信息」面板兜底） */
  const usage = useMemo(() => aggregateUsage(items), [items])
  /**
   * 产物卡的分组（每轮一份，`endIndex` = 该轮最后一行的下标）。
   *
   * 只认官方 `present` 交付（adapter 里的 `kind:'artifact'` 行），没产物时是空数组；
   * 未结束的轮不返回（与官方 turn-tail、dsh-Go `deriveArtifacts` 一致）。
   * `turnArtifactsOf` 自己按 `items` 引用记忆，这里再包一层 `useMemo` 只是让引用稳定。
   */
  const artifactGroups = useMemo(() => turnArtifactsOf(items), [items])

  // 新内容到达：仍贴着底部就继续跟随；条数变化时允许再拉一屏历史
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (itemCountRef.current !== items.length) {
      itemCountRef.current = items.length
      olderPendingRef.current = false
    }
    if (stickyRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [items, streaming])

  // 换会话：重置跟随状态并回到最新一屏
  useEffect(() => {
    stickyRef.current = true
    olderPendingRef.current = false
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [activeSessionId])

  /*
   * ── [S1 无感重载] 时间线滚回原处 ─────────────────────────────────────
   *
   * 必须排在上面那条「换会话就回到底部」**之后**（React 按声明顺序执行 effect），
   * 否则每次挂载都会被拽到底部。滚动位置只认同一个会话记下的那份
   * （`resolveTimelineScroll` 会检查 sessionId），换过会话就不用旧位置套新内容。
   *
   * 内容还没铺够（缓存是分批到的）就留着让下一次 `items` 变化再试；超过
   * `SCROLL_RESTORE_TIMEOUT_MS` 就不跳了 —— 隔了几秒再把用户的位置拽走比不恢复更糟。
   */
  useEffect(() => {
    const target = pendingScrollRef.current
    if (target === null) return
    if (activeSessionId === null || activeSessionId !== restoredSessionId) return
    const el = scrollRef.current
    if (!el) return
    if (el.scrollHeight - el.clientHeight < target) return
    el.scrollTop = target
    // 恢复成功之后**不再**贴底跟随：用户看的是中间那一段
    stickyRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_THRESHOLD
    pendingScrollRef.current = null
  }, [items, activeSessionId, restoredSessionId])

  useEffect(() => {
    if (pendingScrollRef.current === null) return undefined
    const timer = setTimeout(() => {
      pendingScrollRef.current = null
    }, SCROLL_RESTORE_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [])

  /*
   * ── [S1 无感重载] 会话恢复：先铺缓存，连上再真正打开 ─────────────────
   *
   * ① 缓存直出（**不依赖连接**）：`hydrateCachedTimeline` 只读一次 localStorage，
   *    把上一屏原样铺出来、顶部挂「正在同步…」。它内部是幂等 + 不抢的，可以放心调。
   * ② 连上之后再把会话真正打开（`openSession` 才会挂 follow 流、落定快照）。
   *    `restoreIntentRef` 只能用一次：之后用户点哪个会话就是哪个，绝不把他拽回旧会话。
   */
  const restoreIntentRef = useRef(true)

  useEffect(() => {
    if (restoredSessionId === null) return
    hydrateCachedTimeline(restoredSessionId)
  }, [restoredSessionId])

  useEffect(() => {
    if (owner !== bootOwner) restoreIntentRef.current = false
    if (!ready || !restoreIntentRef.current || restoredSessionId === null) return
    const target = restoredSessionId
    if (activeSessionId !== null && activeSessionId !== target) {
      // 用户自己开了别的会话：这次恢复意图作废
      restoreIntentRef.current = false
      return
    }
    // 列表还没到就等它（effect 依赖 sessions）；列表里没有这个会话就别去点它，
    // 那只会换来一条「会话不存在」的报错 —— 而它大概真的已经被删了
    if (sessions.length === 0) return
    if (!sessions.some((session) => session.id === target)) {
      restoreIntentRef.current = false
      return
    }
    restoreIntentRef.current = false
    fireAndForget(() => useRemoteStore.getState().openSession(target))
  }, [ready, activeSessionId, sessions, owner, bootOwner, restoredSessionId])

  /*
   * ── [S1 无感重载] 草稿 / 原生中转箱 ──────────────────────────────────
   *
   * 草稿**每次改动都写**（不 debounce）：正确性优先，一次几 KB 的同步写对平板毫无压力；
   * 而丢掉一次按键就是用户又要重打一遍。
   *
   * 推给原生中转箱（换 WebView 也不丢的那一层）由 `uiState` 内部限流；
   * 真正救命的是下面 `visibilitychange → hidden` 时的 `flushUiState()`：
   * 系统回收渲染进程发生在**切走之后**，那是最后一次能写的机会。
   */
  /*
   * 「重载后回哪个会话」必须跟着**当前会话**走。
   *
   * 只在挂载时写一次是不够的：用户从 A 点到 B、然后被系统回收，快照里还是 A，
   * 回来就跳到 A 去了 —— 那比不恢复更让人迷惑。`null`（断线 / 未选）不写：
   * 保留上一次的选择，重新连上时仍然回到那里。
   */
  useEffect(() => {
    if (activeSessionId !== null) patchActiveSession(activeSessionId, owner)
  }, [activeSessionId, owner])

  /*
   * [R15] 任何路径打开了会话（列表点击 / 通知直达 / 派生完进新会话），都要把「新对话」
   * 整页让出来：`openSession` 只改 `activeSessionId`，视图归 `newSessionStore.open` 管 ——
   * 不补这一刀，新对话页会一直挡在内容区前面（真机反馈：会话列表点了没反应）。
   * 列表那一侧行点击已经先关了一次；这里兜住其余入口。`closePanel` 幂等、不动 notice / 草稿，
   * 新建时保留输入区，等首条消息的发送结果。
   */
  useEffect(() => {
    if (activeSessionId === null) return
    const panel = useNewSessionStore.getState()
    if (!panel.open || (panel.creating && panel.lastCreatedSessionId === activeSessionId)) return
    panel.closePanel()
  }, [activeSessionId])

  useEffect(() => {
    // 本机 / 远程的镜像：盘上那份（`dsp.remote.mode.v1`，由 `RemoteModeSwitch` 写）仍是权威，
    // 这里只让快照能自洽（诊断时一眼看出这一屏是在哪个模式下丢的）
    patchMode(useRemoteMode.getState().mode)
    const unsubscribe = useRemoteMode.subscribe((state) => patchMode(state.mode))
    const flush = (): void => {
      const state = useRemoteStore.getState()
      const currentOwner = JSON.stringify([state.activeServerUrl ?? state.lastSession?.serverUrl ?? null,
        state.hostId ?? state.lastSession?.hostDeviceId ?? null])
      patchTimelineScroll(state.activeSessionId, scrollTopRef.current, currentOwner)
      flushUiState()
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flush()
    }
    if (typeof document === 'undefined') return unsubscribe
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', flush)
    return () => {
      unsubscribe()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', flush)
    }
  }, [])

  /*
   * 工作区文件抽屉的作用域（W3）：跟着「当前会话」走，`workspaceFileScopeId` 就是它。
   *
   * 没连上（或还没选会话）时绑 `null`，面板里的目录缓存与预览一律清掉 ——
   * 上一代连接的预览对象继续留着没有任何意义，还会把 blob URL 拖住。
   * 这里**不发请求**（工作区路径是读 `session/list` 的投影，目录树在抽屉打开时才拉），
   * 所以放在会话切换这种高频路径上也不会多打一次网络。
   */
  useEffect(() => {
    void useWorkspacePane.getState().bind(ready ? activeSessionId : null)
  }, [ready, activeSessionId, attachmentOwner])

  /*
   * 能力探测（W1/W6）挂在这里，而不是挂在「新建会话」那一页里。
   *
   * 为什么：入口的可见性取决于 `capabilities.create`，而那个值只有 `refresh()` 会给 ——
   * 旧版把它写在面板的 effect 里，于是「面板打开才探测、探测过才有入口」成了闭环，
   * 真机上「新建对话」按钮永远不出现。远程页一就绪就问一次，成本是一次 `session/list`
   * （`probeCapabilities` 自己单飞、且已有行时立刻返回）。
   */
  useEffect(() => {
    if (!ready) return
    fireAndForget(() => useNewSessionStore.getState().probeCapabilities())
  }, [ready])

  /*
   * 空态直达新建页：这台 Host 一个会话都没有时，用户唯一的下一步就是建一个。
   * 三个前提缺一不可，免得在「列表还没拉回来」「Host 不支持新建」时闪一下又消失：
   *   `sessionsSynced` —— `session/list` 回来过（不是「还没拿到」）；
   *   `sessions.length === 0` —— 确实没有；
   *   `canCreateSession` —— 确实能建。
   */
  useEffect(() => {
    if (!ready || newSessionOpen || autoEnteredRef.current) return
    if (!canCreateSession || !cacheStatus.sessionsSynced) return
    if (sessions.length > 0) return
    autoEnteredRef.current = true
    useNewSessionStore.getState().openPanel()
  }, [ready, newSessionOpen, canCreateSession, cacheStatus.sessionsSynced, sessions.length])

  /*
   * 启动 / 回到前台：① 恢复上次连接（K4）；② 续上一次没完成的登录（K2）。
   *
   * 为什么挂在这里而不是 `App.tsx`：任务书要求不改 App，而**远程模式的入口就是这里**
   * —— 用户切到远程页时这个组件才挂载，正好是「该连了」的时刻，也不会落在首屏关键路径上
   * （effect 里的异步调用，不 await、不阻塞渲染）。设置面板里挂了同一份（幂等单飞），
   * 两条入口谁先到都一样。
   *
   * 同时也补一次「回前台立即轮询」：后台的 `setTimeout` 会被系统节流，2s 定时器靠不住。
   */
  useEffect(() => {
    fireAndForget(() => useRemoteStore.getState().autoConnectNow())
    fireAndForget(() => useRemoteStore.getState().resumeLogin())
    // [R8 缓存] 先把上一次的会话列表铺上（幂等、只读 localStorage、不发请求）：
    // 列表组件在抽屉里可能是懒挂载的，所以这条也放在「远程页挂上」这个最早的时刻。
    useRemoteStore.getState().hydrateCachedSessions()
    if (typeof document === 'undefined') return undefined
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') return
      fireAndForget(() => useRemoteStore.getState().onAppForeground())
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_THRESHOLD
    if (nearBottom) {
      stickyRef.current = true
    } else if (el.scrollTop < scrollTopRef.current) {
      stickyRef.current = false
    }
    scrollTopRef.current = el.scrollTop
    // [S1] 滚动位置落盘（节流；切后台那一刻还有一次 `flushUiState()` 兜底）
    const now = Date.now()
    if (activeSessionId !== null && now - scrollSavedAtRef.current > SCROLL_SAVE_INTERVAL_MS) {
      scrollSavedAtRef.current = now
      patchTimelineScroll(activeSessionId, el.scrollTop, owner)
    }
    if (hasMoreHistory && el.scrollTop < LOAD_OLDER_THRESHOLD && !olderPendingRef.current && items.length > 0) {
      olderPendingRef.current = true
      fireAndForget(() => useRemoteStore.getState().loadOlder())
    }
  }

  /*
   * 发送：有附件就走 `sendRemoteMessage(text, attachments)`（`store.ts` 的唯一附件入口，
   * 契约里的 `send()` 只发文本），没有附件走 `dispatchPrompt`（`composer/promptMode.ts`）。
   *
   * 附件块形状是 `{type:'file', receiptId}`（`fileUploads/upload` 的收据）；
   * 正在上传的附件不能发（receiptId 还没到手），`composerView` 已经把按钮置灰了。
   *
   * **生成中也能发**（R4，R1 结论）：`session/prompt` 的 `mode` 决定语义 ——
   * `steer` = 插话（打断当前回答，dsh-Go 默认）/ `queue` = 排到下一轮。
   * 所以这里不再拦 `streaming`：原来那句 `if (!ready || streaming) return`
   * 正是「工作中发不出去」的根因。
   *
   * 文字和附件走同一个会话发送入口。
   */
  const send = useCallback(
    (mode: PromptMode) => {
      const target = lastRemoteTarget()
      const remote = useRemoteStore.getState()
      if (!ready || target === null || activeSessionId === null ||
          remote.hostId !== hostId || remote.activeSessionId !== activeSessionId ||
          sendsInProgress.current.has(draftKey)) return
      const text = draft.trim()
      const workspace = useWorkspacePane.getState()
      if (workspace.restoringAttachments || workspaceAttachmentOwner() !== attachmentOwner || workspace.scopeId !== activeSessionId ||
        workspace.attachmentTarget !== target) return
      const current = workspace.attachments.filter((attachment) =>
        attachment.owner === attachmentOwner && attachment.sessionId === activeSessionId)
      if (current.some((attachment) => attachment.status !== 'done')) return
      const receipts = readyReceipts(current)
      if (text.length === 0 && receipts.length === 0) return
      const blocks: RemotePromptAttachment[] = receipts.map((receiptId) => ({ type: 'file', receiptId }))
      sendsInProgress.current.add(draftKey)
      setSendingKeys(new Set(sendsInProgress.current))
      setDraft('')
      void remote.sendToSession(target, activeSessionId, text, blocks, mode).then((sent) => {
        if (!sent) {
          restoreDraft(draft)
          return
        }
        for (const attachment of current) {
          workspace.removeAttachment(attachment.id)
        }
      }).finally(() => {
        sendsInProgress.current.delete(draftKey)
        setSendingKeys(new Set(sendsInProgress.current))
      })
    },
    [activeSessionId, attachmentOwner, draft, draftKey, hostId, ready, restoreDraft, setDraft],
  )

  /*
   * 审批应答（R9）走文件末尾的 `respondApprovalNow()`：卡片在时间线里，
   * 组件不持有一份决策逻辑，只把 `approvalId`（= `$events` 的 eventId）交出去。
   */

  /* ── 斜杠命令（W2） ───────────────────────────────────────────────────
   * 规则（与官方 composer 一致，见 `sessionControls.slashQuery`）：整行只有 `/` + 名字时才弹补全；
   * 一旦有空格（`/permission read-only`）就当成「要在终端执行的那一行命令」，回车直接执行。
   * 不是已知命令的 `/xxx` 仍按普通消息发出去（不吞用户的输入）。 */

  const slashMatches = useMemo(() => {
    const query = slashQuery(draft)
    if (query === null || commandAccess !== 'available') return []
    return filterCommands(slashCommands, query)
  }, [commandAccess, draft, slashCommands])

  const completionOpen =
    slashQuery(draft) !== null &&
    commandAccess === 'available' &&
    slashCommands.length > 0 &&
    !commandDismissed

  // 查询串变了：高亮回到第一行、撤掉上一次的 Esc 关闭
  useEffect(() => {
    setCommandCursor(0)
    setCommandDismissed(false)
  }, [draft])

  const isKnownCommand = useCallback(
    (line: string): boolean => {
      const name = line.trim().replace(/^\/+/, '').split(/\s+/)[0] ?? ''
      return name.length > 0 && slashCommands.some((command) => command.name === name)
    },
    [slashCommands],
  )

  const runCommand = useCallback(
    (line: string) => {
      setDraft('')
      setCommandResult(null)
      void (async () => {
        const result = await executeCommand(line)
        // 成功的命令常常会回一句人话（`/permission` 回「当前 preset …」）；失败走错误条，不在这里重复
        if (result !== null && result.kind === 'success' && (result.text ?? '').length > 0) {
          setCommandResult(result.text ?? null)
        }
      })()
    },
    [executeCommand, setDraft],
  )

  // 结果行几秒后自己消失（它只是「刚才那条命令回了什么」，不是时间线内容）
  useEffect(() => {
    if (commandResult === null) return undefined
    const timer = window.setTimeout(() => setCommandResult(null), 4000)
    return () => window.clearTimeout(timer)
  }, [commandResult])

  /** `⋯` → 命令 → 把 `/name ` 填回输入框（光标落到末尾，方便补参数） */
  const insertCommand = useCallback((line: string) => {
    setDraft(line)
    const el = textareaRef.current
    if (el === null) return
    el.focus()
    const end = line.length
    // 受控组件：值更新后再落光标，放在下一帧
    window.requestAnimationFrame(() => el.setSelectionRange(end, end))
  }, [setDraft])

  const usePromptTool = (text: string, fresh: boolean, path?: string) => {
    if (fresh) {
      const state = useNewSessionStore.getState()
      const normalize = (value: string) => value.replaceAll('\\', '/')
      const workspace = path && state.workspaces.find((item) => item.sessionIds.includes(activeSessionId ?? '') &&
        item.path && normalize(path).startsWith(normalize(item.path).replace(/\/?$/u, '/')))
      const peer = remoteDraftOwner()
      if (!peer) return
      const freshKey = JSON.stringify([peer, null])
      const priorScopedKey = JSON.stringify([serverUrl, hostId, null])
      const oldKey = JSON.stringify([hostId, null])
      const legacyKey = canRestoreLegacy && draftsRef.current.has(priorScopedKey) ? priorScopedKey : canRestoreLegacy ? oldKey : null
      const previous = draftsRef.current.get(freshKey) ?? (legacyKey ? draftsRef.current.get(legacyKey) : undefined) ?? ''
      state.openPanel()
      if (workspace) state.selectWorkspace(workspace.workspaceId)
      writeDraft(freshKey, text + previous, legacyKey)
      window.requestAnimationFrame(() => {
        if (useNewSessionStore.getState().open && remoteDraftOwner() === peer) textareaRef.current?.focus()
      })
      return
    }
    const input = textareaRef.current
    if (sessionTool?.kind === 'skills') {
      insertCommand(text + draft)
      return
    }
    const start = input?.selectionStart ?? draft.length
    const end = input?.selectionEnd ?? start
    const lead = start > 0 && !/\s/u.test(draft[start - 1] ?? '') ? ' ' : ''
    const inserted = lead + text
    setDraft(draft.slice(0, start) + inserted + draft.slice(end))
    window.requestAnimationFrame(() => {
      if (input !== textareaRef.current) return
      input?.focus()
      input?.setSelectionRange(start + inserted.length, start + inserted.length)
    })
  }

  const lastIndex = items.length - 1
  const actionPoints = useMemo(() => messageActionPoints(items), [items])
  const messageActionInFlight = useRef(false)
  const [messageActionBusy, setMessageActionBusy] = useState(false)
  const sessionActionBusy = useNewSessionStore((state) => state.busySessionId !== null)
  const canForkMessage = ready && cacheStatus.timelineSettled && !cacheStatus.timelineFailed

  const forkMessage = async (kind: 'branch' | 'edit' | 'regenerate', item: ChatMessage) => {
    if (!canForkMessage || hostId === null || activeSessionId !== item.sessionId || messageActionInFlight.current) return
    const target = lastRemoteTarget()
    const peer = remoteDraftOwner()
    const selection = remoteSessionSelectionVersion()
    if (target === null || peer === null) return
    const isCurrent = () => lastRemoteTarget() === target &&
      remoteSessionSelectionVersion() === selection && !useNewSessionStore.getState().open &&
      useRemoteStore.getState().activeSessionId === item.sessionId
    if (!isCurrent()) return

    messageActionInFlight.current = true
    setMessageActionBusy(true)
    try {
      let cut = kind === 'branch' ? actionPoints.branch.get(item.id) : undefined
      if (kind !== 'branch' && item.nativeSeq !== undefined && item.nativeSeq > 0) {
        const history = await pageHistory(target, item.sessionId, {
          beforeSeq: item.nativeSeq, throughSeq: item.nativeSeq - 1,
        })
        if (!isCurrent()) return
        cut = forkPointBeforePrompt(historyEntriesFromRecords(history.records), item.nativeSeq)
      }
      if (cut === undefined) {
        showToast(t('remoteMessageNoEarlierHistory'))
        return
      }

      const original = stripDsml(item.text)
      const images: RemotePromptAttachment[] = []
      if (kind === 'regenerate') {
        for (const image of item.images ?? []) {
          if (!isCurrent()) return
          const source = await loadToolImage(image, item.sessionId)
          const data = source?.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/u)
          if (data === undefined || data === null) throw new Error(t('remoteMessageImageUnavailable'))
          images.push({ type: 'image', mediaType: data[1], data: data[2], ...(image.name ? { name: image.name } : {}) })
        }
      }
      if (!isCurrent()) return
      const forkId = await useNewSessionStore.getState().fork(item.sessionId, cut)
      if (forkId === null) return
      if (kind === 'edit') {
        if (lastRemoteTarget() !== target || remoteDraftOwner() !== peer) return
        writeDraft(JSON.stringify([peer, forkId]), original)
        window.requestAnimationFrame(() => {
          if (remoteDraftOwner() === peer && useRemoteStore.getState().activeSessionId === forkId) textareaRef.current?.focus()
        })
        showToast(t(item.hasFiles || item.images?.length ? 'remoteMessageForkReattach' : 'remoteMessageForked'))
      } else if (kind === 'regenerate') {
        await useRemoteStore.getState().sendToSession(target, forkId, original, images)
      } else {
        showToast(t('remoteMessageForked'))
      }
    } catch (error) {
      if (isCurrent()) showToast(describeRemoteError(error).text)
    } finally {
      messageActionInFlight.current = false
      setMessageActionBusy(false)
    }
  }
  const lastMessage = useMemo(() => items.findLast(
    (item) => item.kind === 'message' && !item.context && !item.usageOnly && stripDsml(item.text).trim() !== '',
  ), [items])
  const recoverMessage = ready && !streaming && queueLength === 0 &&
    cacheStatus.timelineSettled && !cacheStatus.timelineFailed && lastMessage?.kind === 'message' &&
    lastMessage.role === 'user' && !lastMessage.id.startsWith('local:') ? lastMessage.id : null
  const retryDelivery = (item: ChatMessage) => {
    const target = lastRemoteTarget()
    if (target === null || item.sessionId !== activeSessionId || item.requestRpcId === undefined) return
    fireAndForget(() => useRemoteStore.getState().retryPrompt(target, item.sessionId, item.requestRpcId!))
  }
  const reuseMessage = (text: string) => {
    if (draft.trim().length > 0 || text.trim().length === 0) return
    setDraft(text)
    textareaRef.current?.focus()
  }
  const quoteMessage = (text: string) => {
    const quote = text.trim().split(/\r?\n/).map((line) => `> ${line}`).join('\n')
    const current = draft.trimEnd()
    insertCommand(current.length > 0 ? `${current}\n\n${quote}\n\n` : `${quote}\n\n`)
  }

  /*
   * [R8 缓存] 加载态三态（判定全是纯函数，见 `services/remote/cache.ts`）：
   *   `timelinePhase` —— 主区域画什么：骨架 / 内容 / 空态 / 失败
   *   `timelineHint`  —— 顶部那条细提示：正在同步… / 没同步上（缓存还在）
   * 组件这里只读 store 的 `cacheStatus`，不自己拼「有没有拉完」的条件 ——
   * 那个判断一旦散落在各处，就一定会有人把「还没拉到」画成「没有内容」。
   */
  const timelinePhase = timelineViewState({
    itemCount: items.length,
    loading: cacheStatus.timelineLoading,
    settled: cacheStatus.timelineSettled,
    failed: cacheStatus.timelineFailed,
  })
  const timelineHint = timelineHintState({
    itemCount: items.length,
    fromCache: cacheStatus.timelineFromCache,
    settled: cacheStatus.timelineSettled,
    failed: cacheStatus.timelineFailed,
  })

  /*
   * ── 输入区状态机（R4）──────────────────────────────────────────────
   * 所有「按钮该长什么样 / 回车会做什么」都在 `composer/composerState.ts` 里判
   * （纯函数，自测逐条摆过）：这里只把实时信号喂进去，再把结果交给 `ComposerRow` 渲染。
   */
  const knownCommand = isKnownCommand(draft.trim())
  /** 数据层有没有「指定 mode 发送」的入口（没有就退回 Host 默认的 queue，见 promptMode.ts） */
  const modeSupported = supportsPromptMode(useRemoteStore.getState())
  const effectiveMode: PromptMode = modeSupported ? sendMode : 'queue'
  /*
   * [R15] 新对话页的信号整形：那一页**没有会话**（sessionId 一律给 null —— 哪怕 store 里
   * 还留着上一个会话，那一页的发送语义是「建新会话」，绝不能把消息发进旧会话）、
   * 没有流、没有命令；`creating` 期间主按钮灰住（防连点出两个会话）。
   */
  const signals = useMemo<ComposerSignals>(
    () => ({
      ready,
      sessionId: view === 'new-session' ? null : activeSessionId,
      streaming: view === 'new-session' ? false : streaming,
      sendMode: effectiveMode,
      stopTimedOut,
      queueLength: view === 'new-session' ? 0 : queueLength,
      draft,
      // [R17] 新对话页把「草稿附件数」当可发内容（空文本 + 有附件也是合法消息）
      attachments: view === 'new-session' ? newDraftFiles.length : readyReceipts(attachments).length,
      attachmentsBusy: view === 'new-session' ? false :
        restoringAttachments || sendingKeys.has(draftKey) || attachments.some((attachment) => attachment.status !== 'done'),
      knownCommand: view === 'new-session' ? false : knownCommand,
      slashTyping: view === 'new-session' ? false : slashQuery(draft) !== null,
      ...(view === 'new-session' ? { newChat: true, creating: creatingSession } : {}),
    }),
    [
      ready,
      activeSessionId,
      streaming,
      effectiveMode,
      stopTimedOut,
      queueLength,
      draft,
      attachments,
      restoringAttachments,
      draftKey,
      sendingKeys,
      knownCommand,
      view,
      creatingSession,
      newDraftFiles,
    ],
  )
  const composer = useMemo(() => composerView(signals), [signals])
  const hint = useMemo(() => {
    const resolved = composerHint(signals)
    return t(resolved.key, resolved.params)
  }, [signals, t])

  /**
   * 输入区唯一的提交入口（回车 / 主按钮 / 生成中的次要发送键）：
   * 已知斜杠命令 → 执行；其余 → 发消息（运行中按 `sendMode` 决定插话还是排队）。
   * 新对话页 → `createAndSend`：建会话 → 应用选项 → 进会话 → 把这条消息发出去（R15）。
   */
  const submit = useCallback(() => {
    /*
     * [R15] dsh-Go 的 `_ensureSession`：选好选项直接发，发出去了才建会话。
     * 乐观清空输入框；建不出来（原因已在页面那行红字上）就把草稿还回去。
     * 首条消息发送后会把这一页关掉，所以「权限没生效 / 模型没应用」这类打了折扣的
     * notice 在这里 toast 出来 —— 页面已经切走了，留在页面里没人看得见。
     */
    if (view === 'new-session') {
      const text = draft.trim()
      // [R17] 空文本 + 有附件草稿也是合法的首条消息（与聊天页同口径）
      if ((text.length === 0 && newDraftFiles.length === 0) || !ready || !canCreateSession || creatingSession) {
        return
      }
      setDraft('')
      void Promise.resolve(useNewSessionStore.getState().createAndSend(text)).then((sent) => {
        if (!sent) {
          restoreDraft(draft)
          return
        }
        const notice = useNewSessionStore.getState().notice
        if (notice !== null) showToast(notice)
      })
      return
    }
    const intent = composerIntent(signals)
    if (intent === 'none') return
    if (intent === 'command') {
      runCommand(draft.trim())
      return
    }
    send(intent === 'steer' ? 'steer' : 'queue')
  }, [draft, ready, view, canCreateSession, creatingSession, newDraftFiles, restoreDraft, runCommand, send, setDraft, signals])

  /**
   * 生成中：主按钮变停止（`session/cancel`）。
   *
   * 照 dsh-Go 加**10 秒超时**：`accepted:true` 只代表受理，真正的终态是 `turn/end.reason=aborted`；
   * 10 秒还没有回执就把按钮还原成发送（`stopTimedOut`），否则用户会以为整页卡死。
   */
  const stop = useCallback(() => {
    let settled = false
    const timer = window.setTimeout(() => {
      if (!settled) setStopTimedOut(true)
    }, STOP_TIMEOUT_MS)
    setStopTimedOut(false)
    void Promise.resolve(useRemoteStore.getState().cancel())
      .catch(() => undefined)
      .finally(() => {
        settled = true
        window.clearTimeout(timer)
      })
  }, [])

  // 这一轮结束：超时标记与计时器一起收掉（下次生成重新计）
  useEffect(() => {
    if (!streaming) setStopTimedOut(false)
  }, [streaming])

  // 输入区胶囊组要自己探一次（顶栏那边的 `probe()` 也还在，幂等）
  useComposerProbe(ready ? activeSessionId : null)

  /*
   * ── 新建会话整页（W6 / R15）────────────────────────────────────────────
   * 视图切换，不是叠层：这一支直接把「顶栏 + 时间线 + 输入框」整块换掉。
   * 会话本身（`activeSessionId` / `items` / 草稿）都在上层与 store 里，所以「返回」
   * 回来的是同一个会话，不需要重新 `openSession`。
   *
   * [R15] 输入框由**这里**传给 `NewSessionPage`（footer prop）：同一个 CSS module、
   * 同一个 `ComposerRow`、同一份回车规则 —— 两个视图的输入区天然长得一模一样。
   * 发送走 `submit()` 的 `createAndSend` 分支（建会话 + 发首条消息）。
   * 附件入口不出现：附件收据是「当前会话」作用域的（`workspacePaneStore.bind`），
   * 而这一页还没有会话 —— 传了也是发不出去的收据。
   */
  const newCallDialog = newVoiceCall && (
    <Suspense key="new-voice-call" fallback={null}>
      <RemoteVoiceCall draft={newVoiceCall} onClose={closeNewVoiceCall} />
    </Suspense>
  )
  if (view === 'new-session') {
    return (
      <div className={styles.view}>
        <NewSessionPage
          modalOpen={newVoiceCall !== null}
          onVoiceCall={canReadAloud && ready && canCreateSession && !creatingSession ? openNewVoiceCall : undefined}
          footer={
            <div className={styles.footer}>
              {/* [R17] 附件草稿条：新对话页的文件只入草稿，建完会话才上传 */}
              <NewSessionDrafts />
              <div className={styles.inputWrapper}>
                <textarea
                  ref={textareaRef}
                  className={styles.textarea}
                  rows={isMobile ? 1 : 2}
                  value={draft}
                  placeholder={t('newSessionComposerPlaceholder')}
                  aria-label={t('newSessionComposerPlaceholder')}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    // 新对话页没有斜杠命令（命令需要会话才存在），只有「回车发送」一条规则
                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault()
                      submit()
                    }
                  }}
                />
                <ComposerRow
                  view={composer}
                  hint={hint}
                  sendMode={sendMode}
                  modeSupported={modeSupported}
                  leading={
                    /*
                     * [R17] 附件入口：上传通道是会话级的，这里还没有会话 ——
                     * 选中的文件只进草稿，`createAndSend` 建完会话再传。
                     */
                    <>
                      <AttachmentButton key={draftKey} disabled={!ready || !canCreateSession}
                        onFiles={(files) => useNewSessionStore.getState().addDraftFiles(files)} />
                      {canReadAloud && ready && canCreateSession && <RemoteVoiceInput key={'new-voice:' + draftKey} onText={acceptDictation} />}
                    </>
                  }
                  onSubmit={submit}
                  onStop={stop}
                  onSecondarySend={submit}
                  onModeChange={setSendMode}
                />
              </div>
            </div>
          }
        />
        {newCallDialog}
      </div>
    )
  }

  return (
    <div className={styles.view}>
      {/*
        这一行不是「远程模式」的页面标题栏 —— 与 `SessionView` 的顶栏同高同位：
        左侧标题 = 当前会话，右侧 = 数据面通道徽标。模式下不再额外套一层页面。
      */}
      <div className={styles.header}>
        <IconButton
          size="xl"
          tone="primary"
          icon={<IconLinkOutline16 />}
          tooltip={t('hostSwitchLabel')}
          aria-haspopup="dialog"
          onClick={() => openRemoteWorkspaceDialog('host')}
        />
        <div className={styles.heading}>
          <div className={styles.title} title={activeSessionId === null ? undefined : activeTitle}>
            {activeSessionId === null ? t('remoteModeRemote') : activeTitle}
          </div>
          <div className={styles.connectionStatus}>
            <span className={clsx(styles.connectionDot, ready && styles.connectionLive)} aria-hidden />
            <span>{ready && connectedHost ? `${connectedHost} · ` : ''}{transportLabel(t, transport, ready)}</span>
          </div>
        </div>
        {ready && subagentParentId !== null ? (
          /* [R16] 子代理会话的来路（dsh-Go `header_agents.dart` 的「‹ 上级对话」） */
          <button
            type="button"
            className={styles.subagentBack}
            aria-label={t('remoteSubagentBack')}
            title={subagentParentTitle || t('remoteSubagentBack')}
            onClick={() => {
              if (subagentParentId === null) return
              fireAndForget(() => useRemoteStore.getState().openSession(subagentParentId))
            }}
          >
            <span className={styles.subagentBackGlyph} aria-hidden>
              ‹
            </span>
            <span className={styles.subagentBackText}>
              {subagentParentTitle.length > 0 ? subagentParentTitle : t('remoteSubagentBack')}
            </span>
          </button>
        ) : null}
        {/*
          工作区抽屉入口（W3）。门禁：`filesSupported === false`（Host 回 `METHOD_NOT_FOUND`）
          时**整个按钮消失**；`null`（还没探过）时先画出来 —— 端点没有专属 capability，
          不点一次没有别的办法知道。
        */}
        {ready && activeSessionId !== null && filesSupported !== false ? (
          <IconButton
            size="xl"
            tooltip={t('workspacePaneOpen')}
            aria-label={t('workspacePaneOpen')}
            aria-expanded={workspaceOpen}
            icon={<IconDataOutline16 />}
            onClick={() => {
              const workspace = useWorkspacePane.getState()
              if (workspace.open) workspace.closePane()
              else void workspace.openPane()
            }}
          />
        ) : null}
        {/*
          会话内控制（W2）：模型胶囊 / 权限预设胶囊 / `⋯` 菜单。
          三个入口各自按能力降级（Host 回 `METHOD_NOT_FOUND` 就只隐藏对应那个），
          组件内部自己判 `showsXxx`，这里不写条件 —— 免得顶栏堆一堆 &&。
        */}
        {ready && activeSessionId !== null ? (
          <SessionControlsBar
            sessionId={activeSessionId}
            title={controlTitle}
            usage={usage}
            onInsertCommand={insertCommand}
            actions={[
              { label: t('remoteSessionDetails'), open: () => openSessionTool('details') },
              { label: t('remoteExportConversation'), open: () => openSessionTool('export') },
              { label: t('remoteSessionGoal'), open: () => openSessionTool('goal') },
              { label: t('remoteSkills'), open: () => openSessionTool('skills') },
              { label: t('remoteReferences'), open: () => openSessionTool('references') },
              { label: t('remoteJobs'), open: () => openSessionTool('jobs') },
              { label: t('remoteWorkspaceTools'), open: () => openRemoteWorkspaceDialog('tools') },
              ...(canReadAloud && window.isSecureContext && typeof navigator.mediaDevices?.getUserMedia === 'function'
                ? [{ label: t('remoteVoiceCall'), open: () => openSessionTool('voice') }] : []),
              ...(allowsTerminal ? [{ label: t('remoteTerminal'), open: () => openSessionTool('terminal') }] : []),
            ]}
          />
        ) : null}
        {ready && canCreateSession && activeSessionId !== null ? (
          <IconButton
            size="xl"
            tone="primary"
            icon={<IconNewChatOutline20 />}
            tooltip={t('composerNewChat')}
            onClick={() => useNewSessionStore.getState().openPanel()}
          />
        ) : null}
      </div>

      {!bridgeReady ? (
        // 浏览器预览 / 旧 APK：说明「只能在 App 内用」，并给一次重试（装完 APK 回来即生效）
        <div className={styles.centerState}>
          <div className={styles.centerIcon} aria-hidden="true"><IconLinkOutline16 /></div>
          <h1 className={styles.centerTitle}>
            {t(availability === 'probing' ? 'remoteCheckingAvailability' : availability === 'outdated' ? 'remoteBridgeOutdated' : 'remoteRequiresApp')}
          </h1>
          {availability === 'outdated' ? (
            <Button variant="outlined" size="m" onClick={retry}>
              {t('retry')}
            </Button>
          ) : null}
        </div>
      ) : !ready ? (
        <div className={styles.centerState}>
          <div className={styles.centerIcon} aria-hidden="true"><IconLinkOutline16 /></div>
          <h1 className={styles.centerTitle}>
            {/* 自动恢复（K4）优先：它说的是「刚才为什么没连上」，比通用的「未连接」有用得多。
                掉线自愈（R10）再优先一层：那是**中性**的「正在重连」，不是失败。
                等待授权（系统浏览器里）是「正在登录」而不是「失败了」，别让用户以为要重来。 */}
            {healing || reconnect.status === 'failed'
              ? healingTitle
              : t(
                  autoConnect.state === 'failed'
                    ? autoConnect.code === 'SESSION_EXPIRED'
                      ? 'remoteSessionExpired'
                      : 'remoteAutoConnectFailed'
                    : phase === 'error'
                      ? 'remotePhaseError'
                      : phase === 'waiting-auth'
                        ? 'remotePhaseWaitingAuth'
                        : phase === 'connecting'
                          ? 'remotePhaseConnecting'
                          : 'remoteNotConnected',
                )}
          </h1>
          <div className={styles.centerHint}>
            {healing || reconnect.status === 'failed'
              ? healingHint
              : error
                ? `${error.code}: ${error.message}`
                : autoConnect.state === 'failed' && autoConnect.message !== undefined
                  ? autoConnect.message
                  : t('remoteNotConnectedHint')}
          </div>
          <div className={styles.centerActions}>
            {canReconnect ? (
              <Button
                variant="primary"
                size="l"
                onClick={() => fireAndForget(() => useRemoteStore.getState().reconnectNow())}
              >
                {t(healing || reconnect.status === 'failed' ? 'reconnectNow' : 'remoteAutoConnectRetry')}
              </Button>
            ) : null}
            <Button
              variant={canReconnect ? 'outlined' : 'primary'}
              size="l"
              onClick={() => openRemoteWorkspaceDialog('connection')}
            >
              {t('remoteConnectionTitle')}
            </Button>
          </div>
        </div>
      ) : activeSessionId === null ? (
        <div className={styles.centerState}>
          <div className={styles.centerIcon} aria-hidden="true"><IconNewChatOutline20 /></div>
          <h1 className={styles.centerTitle}>{t('remotePickSession')}</h1>
          <div className={styles.centerActions}>
          {/*
            「新建会话」入口（W1/W6）。为什么只挂在**空态**：顶栏与输入区归 W2（会话内控制），
            而空态正是「这台 Host 上一个会话都还没打开」的时候 —— 用户唯一的下一步就是新建一个。
            `openPanel()` 现在切的是 `view`（整页），所以点下去是换页，不是弹一层面板。
            能力门禁：Host 不支持 `session/create` 时（`capabilities.create === false`）不渲染，
            不弹错误对话框。
          */}
            {canCreateSession ? (
              <Button variant="primary" size="l" onClick={() => useNewSessionStore.getState().openPanel()}>
                <span className={styles.newSessionIcon} aria-hidden>
                  <IconNewChatOutline20 />
                </span>
                {t('newSessionEntry')}
              </Button>
            ) : null}
            {isMobile ? (
              <Button variant="outlined" size="l" onClick={openMobileSider}>
                {t('remoteListButton')}
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <>
          <div ref={scrollRef} className={styles.timeline} onScroll={onScroll}>
            <div className={styles.column}>
              {/*
                [R8 缓存] 内容区三种加载态（判定在 `cache.ts`，这里只画）：

                  skeleton  首次拉取没结束 → 骨架。**绝不**写「这个会话还没有消息」：
                            那是在断言事实，而我们只是还没拿到（用户真机反馈的原话）。
                  empty     只有「确认拉完了 + 服务端确实没有」才允许显示空态。
                  failed    拉失败了（不是空）：一行说明 + 重试，同样不许说「没有消息」。
              */}
              {timelinePhase === 'skeleton' ? (
                <div
                  className={styles.skeleton}
                  role="status"
                  aria-busy="true"
                  aria-label={t('cacheTimelineSkeleton')}
                >
                  <div className={styles.skeletonRow} data-width="60" aria-hidden />
                  <div className={styles.skeletonRow} data-width="88" aria-hidden />
                  <div className={styles.skeletonRow} data-width="74" aria-hidden />
                  <div className={styles.skeletonRow} data-width="92" aria-hidden />
                </div>
              ) : null}
              {/* 缓存直出：顶部一条细提示（不是在加载整页，只是还没和服务端对齐） */}
              {timelineHint === 'syncing' ? (
                <div className={styles.syncBar} role="status">
                  {t('cacheSyncing')}
                </div>
              ) : null}
              {/* 缓存还在、但这次没同步上：说清楚「你看的是缓存」，并给一次重试 */}
              {timelineHint === 'failed' ? (
                <div className={styles.syncBar} role="status">
                  {t('cacheTimelineFailed')}
                  <button
                    type="button"
                    className={styles.syncAction}
                    onClick={() => {
                      if (activeSessionId === null) return
                      fireAndForget(() => useRemoteStore.getState().openSession(activeSessionId))
                    }}
                  >
                    {t('retry')}
                  </button>
                </div>
              ) : null}
              {timelinePhase === 'empty' ? (
                <div className={styles.placeholder}>{t('remoteTimelineEmpty')}</div>
              ) : null}
              {timelinePhase === 'failed' ? (
                <div className={styles.placeholder}>
                  {t('cacheTimelineFailed')}
                  <button
                    type="button"
                    className={styles.syncAction}
                    onClick={() => {
                      if (activeSessionId === null) return
                      fireAndForget(() => useRemoteStore.getState().openSession(activeSessionId))
                    }}
                  >
                    {t('retry')}
                  </button>
                </div>
              ) : null}
              {ready && hasMoreHistory ? (
                <button
                  type="button"
                  className={styles.loadOlder}
                  disabled={loadingOlder}
                  aria-busy={loadingOlder}
                  onClick={() => fireAndForget(() => useRemoteStore.getState().loadOlder())}
                >
                  {t('remoteLoadOlder')}
                </button>
              ) : null}
              {timelinePhase !== 'skeleton'
                ? items.map((item, index) => (
                  /*
                   * 产物卡的**唯一挂载点**：每一行后面都问一句「这一轮结束在这一行吗」——
                   * `ArtifactTurnTail` 查 `turnArtifactsOf(items)` 里的 `endIndex`，
                   * 查不到就返回 null（不产生空行）。这一轮没有 `present` 声明时整块不渲染。
                   * 分组按 `items` 引用记忆过一次，所以这里每行调一次也只是一次查表。
                   */
                  <Fragment key={JSON.stringify([hostId, item.sessionId, item.id])}>
                    <RemoteRow
                      item={item}
                      items={items}
                      live={streaming && index === lastIndex}
                      quote={ready && item.sessionId === activeSessionId &&
                        (item.kind !== 'message' || item.sendState !== 'unconfirmed') ? quoteMessage : undefined}
                      reuse={draft.trim() === '' && item.kind === 'message' && item.role === 'user' &&
                        (item.id === recoverMessage || item.sendState === 'failed')
                        ? reuseMessage : undefined}
                      retry={canForkMessage && item.kind === 'message' && item.sessionId === activeSessionId &&
                        item.sendState === 'unconfirmed' && item.pendingPrompt !== undefined
                        ? () => retryDelivery(item) : undefined}
                      branch={canForkMessage && item.kind === 'message' && actionPoints.branch.has(item.id)
                        ? () => void forkMessage('branch', item) : undefined}
                      edit={canForkMessage && isVisibleRemoteMessage(item) && item.role === 'user' &&
                        item.nativeSeq !== undefined
                        ? () => void forkMessage('edit', item) : undefined}
                      regenerate={canForkMessage && !streaming && queueLength === 0 &&
                        actionPoints.regenerate?.replyId === item.id
                        ? () => void forkMessage('regenerate', actionPoints.regenerate!.prompt) : undefined}
                      feedback={ready && item.sessionId === activeSessionId && item.kind === 'message' &&
                        item.role === 'assistant' && item.nativeSeq !== undefined && !/^message:\d+:[a-z0-9]*$/u.test(item.id)
                        ? () => openSessionTool('feedback', item.id) : undefined}
                      readAloudId={canReadAloud && item.sessionId === activeSessionId && item.kind === 'message' &&
                        item.role === 'assistant' ? 'remote:' + JSON.stringify([serverUrl, hostId, item.sessionId, item.id]) : undefined}
                      actionBusy={messageActionBusy || sessionActionBusy}
                    />
                    <ArtifactTurnTail index={index} groups={artifactGroups} />
                  </Fragment>
                ))
                : null}
            </div>
          </div>

          {/* 任务进度 / 计划入口（R11）：时间线之下、输入框之上的固定带；没数据时整块不渲染 */}
          <PlanProgressDock />

          <div className={styles.footer}>
            {/* 会话内控制的操作级错误（切模型 / 执行命令 / 队列操作）：一条可关掉的行 */}
            <ChatControlsError />

            {/*

              审批卡不在这里（R9）：它挪进时间线了（`RemoteRow` 的 `approval` 分支）。
              同一个 eventId 只该有一组可点按钮 —— 两处各画一张，二次确认的状态会各走各的，
              用户也可能在吸底条上点完、又去时间线里点同一条（第二次必然 PERMISSION_NOT_PENDING）。
            */}

            {/* 排队消息（W2）：生成中发出去的消息进了 Host 的 inbox，这里给「立即发送 / 删除」 */}
            <QueueDock />

            {/* 斜杠命令补全（W2）：整行只有 `/`+名字时出现，回车执行、Tab 填回、Esc 关掉 */}
            {completionOpen ? (
              <SlashCommandList
                listId="remote-slash-commands"
                commands={slashMatches}
                activeIndex={Math.min(commandCursor, Math.max(0, slashMatches.length - 1))}
                onPick={(command) => runCommand(commandLineOf(command).trim())}
                onHover={setCommandCursor}
              />
            ) : null}

            {commandResult === null ? null : (
              <div className={controlsStyles.resultBar} role="status">
                {commandResult}
              </div>
            )}

            <div className={styles.inputWrapper}>
              {/* 附件条（W3）：上传中 / 已完成 / 失败重试都在这里，进输入框上方 */}
              <AttachmentTray compact attachments={attachments} />
              <textarea
                ref={textareaRef}
                className={styles.textarea}
                rows={isMobile && !draft.includes('\n') ? 1 : 2}
                value={draft}
                placeholder={t('remoteInputPlaceholder')}
                aria-label={t('remoteInputPlaceholder')}
                aria-controls={completionOpen ? 'remote-slash-commands' : undefined}
                aria-activedescendant={
                  completionOpen && slashMatches.length > 0
                    ? `remote-slash-commands-${Math.min(commandCursor, slashMatches.length - 1)}`
                    : undefined
                }
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  // 补全打开时：↑↓ 选、Enter 执行选中的命令、Tab 只填回、Esc 收起来
                  if (completionOpen) {
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      setCommandDismissed(true)
                      return
                    }
                    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && slashMatches.length > 0) {
                      event.preventDefault()
                      const step = event.key === 'ArrowDown' ? 1 : -1
                      setCommandCursor((current) => {
                        const size = slashMatches.length
                        return (current + step + size) % size
                      })
                      return
                    }
                    if (
                      event.key === 'Enter' &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing &&
                      slashMatches.length > 0
                    ) {
                      event.preventDefault()
                      const picked = slashMatches[Math.min(commandCursor, slashMatches.length - 1)]
                      if (picked !== undefined) runCommand(commandLineOf(picked).trim())
                      return
                    }
                    if (event.key === 'Tab' && slashMatches.length > 0) {
                      event.preventDefault()
                      const picked = slashMatches[Math.min(commandCursor, slashMatches.length - 1)]
                      if (picked !== undefined) insertCommand(commandLineOf(picked))
                      return
                    }
                  }
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault()
                    submit()
                  }
                }}
              />
              {/*
                输入区最下面那一行（R4）：模型 / 权限胶囊 + 提示 + 插话/排队 + 发送 / 停止。
                胶囊与按钮都在 `composer/**` 里（顶栏已经不渲染它们了）；这里只传状态与回调。
              */}
              <ComposerRow
                view={composer}
                hint={hint}
                sendMode={sendMode}
                modeSupported={modeSupported}
                leading={
                  /* 「+」选文件 → fileUploads/upload → 收据随消息发出（W3）。
                     生成中也允许先选文件：这些消息本来就是插话/排队发的。 */
                  <>
                    <AttachmentButton key={draftKey} disabled={!ready || activeSessionId === null} />
                    {canReadAloud && ready && activeSessionId !== null && <RemoteVoiceInput key={'voice:' + draftKey} onText={acceptDictation} />}
                  </>
                }
                onSubmit={submit}
                onStop={stop}
                onSecondarySend={submit}
                onModeChange={setSendMode}
              />
            </div>
          </div>
        </>
      )}
      {sessionTool && sessionTool.scope.current() && lastRemoteTarget() === sessionTool.scope.target && (
        <Suspense fallback={null}>
          {sessionTool.kind === 'terminal' && <RemoteTerminal scope={sessionTool.scope} onClose={() => setSessionTool(null)} />}
          {sessionTool.kind === 'jobs' && <RemoteJobs scope={sessionTool.scope} onClose={() => setSessionTool(null)} />}
          {sessionTool.kind === 'voice' && <RemoteVoiceCall scope={sessionTool.scope} onClose={() => setSessionTool(null)} />}
          {sessionTool.kind === 'goal' && <RemoteSessionGoal scope={sessionTool.scope} onClose={() => setSessionTool(null)} />}
          {sessionTool.kind === 'details' && <RemoteSessionDetails items={items} sessionId={sessionTool.scope.sessionId}
            title={activeTitle} onClose={() => setSessionTool(null)} onGoal={() => openSessionTool('goal')} />}
          {sessionTool.kind === 'export' && <RemoteConversationExport scope={sessionTool.scope} items={items}
            title={controlTitle || sessions.find((row) => row.id === activeSessionId)?.title || t('untitledChat')}
            capabilities={remoteCapabilities} onClose={() => setSessionTool(null)} />}
          {sessionTool.kind === 'feedback' && sessionTool.messageId !== undefined && (
            <RemoteFeedback scope={sessionTool.scope} messageId={sessionTool.messageId} onClose={() => setSessionTool(null)} />
          )}
          {(sessionTool.kind === 'skills' || sessionTool.kind === 'references') && (
            <RemotePromptTools scope={sessionTool.scope} tool={sessionTool.kind} onUse={usePromptTool}
              allowCurrentSkill={subagentParentId === null} onClose={() => setSessionTool(null)} />
          )}
        </Suspense>
      )}
      {newCallDialog}
    </div>
  )
}

/* ────────────────────────────── 时间线的一行 ────────────────────────────── */

/**
 * [R17] 新对话页的附件草稿条：名字 + 大小 + 移除。
 *
 * 与聊天页的 `AttachmentTray` 不是一回事：那边是「正在上传的进度」，这边只是
 * 「用户选了什么」——上传要等 `createAndSend` 建完会话才开始（两条通道都是会话级的）。
 */
const NewSessionDrafts = () => {
  const t = useTranslate()
  const drafts = useNewSessionStore((state) => state.draftFiles)
  if (drafts.length === 0) return null
  const sizeText = (size: number): string =>
    size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${Math.round(size / 1024)} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`
  return (
    <div className={styles.draftTray}>
      {drafts.map((item) => (
        <div key={item.id} className={styles.draftRow}>
          <span className={styles.draftName} title={item.name}>
            {item.name}
          </span>
          <span className={styles.draftSize}>{sizeText(item.size)}</span>
          <button
            type="button"
            className={styles.draftRemove}
            aria-label={`${t('newSessionDraftRemove')}: ${item.name}`}
            onClick={() => useNewSessionStore.getState().removeDraftFile(item.id)}
          >
            <IconCloseOutline16 />
          </button>
        </div>
      ))}
    </div>
  )
}

interface MessageRowActions {
  quote?: (text: string) => void
  reuse?: (text: string) => void
  retry?: () => void
  branch?: () => void
  edit?: () => void
  regenerate?: () => void
  feedback?: () => void
  readAloudId?: string
  actionBusy: boolean
}

const RemoteRow = ({ item, items, live, ...actions }: {
  item: ChatItem
  items: ChatItem[]
  live: boolean
} & MessageRowActions) => {
  if (item.kind === 'message') return <MessageRow item={item} live={live} {...actions} />
  if (item.kind === 'tool') return <ToolRow item={item} />
  // 审批卡就长在时间线里（不折进工具卡、也不吸在输入区上方）：命令原文、风险与按钮同一处
  if (item.kind === 'approval') return <ApprovalRow item={item} items={items} />
  // 产物行是**数据载体**：卡片由外层的 `ArtifactTurnTail` 挂在这一轮最后一行下面，
  // 它自己不成行（否则时间线里会多出一条「空行」）。
  if (item.kind === 'artifact') return null
  // 提问不再是一行只读摘要：选项 / 自由输入 / 倒计时 / 提交全在卡片里（`chat-controls/QuestionCard`）
  return <QuestionCard item={item} />
}

/** 正文用现有的 Markdown 组件；用户行保持纯文本，避免被当成 markdown 解析 */
const MessageRow = ({ item, live, quote, reuse, retry, branch, edit, regenerate, feedback, readAloudId, actionBusy }: {
  item: ChatMessage
  live: boolean
} & MessageRowActions) => {
  const t = useTranslate()
  // 上下文 / 只有 usage 的 assistant 行不属于对话正文
  if (item.context === true || item.usageOnly === true) return null
  const isUser = item.role === 'user'
  const text = stripDsml(item.text)
  const reasoning = item.reasoning === undefined ? '' : stripDsml(item.reasoning)
  const images = item.images
    ?.filter((image) => image.sessionId === undefined || image.sessionId === item.sessionId)
    .map((image) => ({ ...image, sessionId: item.sessionId })) ?? []
  return (
    <div className={clsx(styles.row, isUser && styles.rowUser)}>
      {reasoning.length > 0 ? (
        <details className={styles.reasoning}>
          <summary className={styles.reasoningSummary}>{t('remoteReasoning')}</summary>
          <Markdown
            content={reasoning}
            loading={false}
            cacheKey={`${item.id}:reasoning`}
            disableLink={false}
          />
        </details>
      ) : null}
      <div className={clsx(styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant)}>
        {isUser ? (
          <div className={styles.plainText}>{text || (item.hasFiles ? t('remoteMessageFile') : '')}</div>
        ) : (
          <Markdown
            className="ds-assistant-message-main-content"
            content={text}
            loading={live && item.streaming === true}
            cacheKey={item.id}
            disableLink={false}
          />
        )}
        {images.length > 0 ? <RemoteImageStrip images={images} lazy /> : null}
        {item.sendState === 'unconfirmed' ? (
          <div className={styles.sendError} role="status">
            {t('remotePromptUnconfirmed')}
            {item.sendError ? ` ${item.sendError}` : ''}
          </div>
        ) : item.sendError && <div className={styles.sendError}>{item.sendError}</div>}
        {retry && (
          <button type="button" className={styles.reuseMessage} onClick={retry}>
            {t('remotePromptRetry')}
          </button>
        )}
      </div>
      {item.role === 'system' || item.streaming || (text.trim() === '' && !edit && !branch && !regenerate) ? null : (
        <div className={styles.messageActions}>
          {text.trim() !== '' && <CopyButton text={text} />}
          {readAloudId && <ReadAloudButton messageId={readAloudId} text={text} />}
          {quote === undefined || text.trim() === '' ? null : (
            <button type="button" className={styles.reuseMessage} onClick={() => quote(text)}>
              {t('remoteQuoteMessage')}
            </button>
          )}
          {reuse === undefined ? null : (
            <button type="button" className={styles.reuseMessage} onClick={() => reuse(text)}>
              {t('remoteReuseMessage')}
            </button>
          )}
          {branch && (
            <button type="button" className={styles.reuseMessage} disabled={actionBusy} onClick={branch}>
              {t('remoteMessageBranch')}
            </button>
          )}
          {edit && (
            <button type="button" className={styles.reuseMessage} disabled={actionBusy} onClick={edit}>
              {t('remoteMessageEdit')}
            </button>
          )}
          {regenerate && (
            <button type="button" className={styles.reuseMessage} disabled={actionBusy} onClick={regenerate}>
              {t('remoteMessageRegenerate')}
            </button>
          )}
          {feedback && <button type="button" className={styles.reuseMessage} onClick={feedback}>{t('remoteFeedback')}</button>}
        </div>
      )}
    </div>
  )
}

/** 工具调用：一行摘要（图标 + 动词 + 要点 + 状态），点开按结果类型渲染详情。见 `tool/ToolCard`。 */
const ToolRow = ({ item }: { item: ToolActivity }) => <ToolCard item={item} />

/**
 * 审批卡（R9）：时间线里的一行，直接可点。
 *
 * 「要做什么」与风险等级都在**这里**算（不焊进 reducer）：审批 waterfall 只带
 * `{toolName, callId, reason}`，命令原文得从同 `callId` 的工具调用里取，
 * 而 `tool/call` 可能比审批晚到 —— 早算一次就会永远显示「不知道要做什么」。
 */
const ApprovalRow = ({ item, items }: { item: ApprovalActivity; items: ChatItem[] }) => {
  const insight = approvalInsightOf(items, item)
  return (
    <ApprovalCard
      toolName={item.toolName}
      {...(insight.target === undefined ? {} : { target: insight.target })}
      {...(item.reason === undefined ? {} : { reason: item.reason })}
      risk={insight.risk}
      {...(item.outcome === undefined ? {} : { outcome: item.outcome })}
      allowsOnce={approvalAllowsOnce(item.options)}
      onAllow={() => respondApprovalNow(item.approvalId, 'allow_once')}
      onReject={() => respondApprovalNow(item.approvalId, 'deny')}
    />
  )
}

/**
 * 审批应答：`approvalId` 就是 `$events` 的 `eventId`（协议 §2.6），
 * 数据层用它回 `$events/result`，与重连无关 —— 只要 `$events` 又 ready 了就能再答。
 * 失败不抛给卡片：错误统一进 store 的 `error`，卡片按 `outcome` 显示终态。
 */
const respondApprovalNow = (eventId: string, decision: ApprovalDecision): Promise<void> =>
  Promise.resolve(useRemoteStore.getState().respondApproval(eventId, decision)).catch(() => undefined)

type Translate = ReturnType<typeof useTranslate>

/** 顶栏的通道徽标：拿到说明在跑，没拿到就是连接中/未连接 */
const transportLabel = (t: Translate, transport: string | null, ready: boolean): string => {
  if (transport === 'relay') return t('remoteTransportRelay')
  if (transport === 'lan') return t('remoteTransportLan')
  if (transport === 'p2p') return t('remoteTransportP2p')
  if (transport === 'turn') return t('remoteTransportTurn')
  return ready ? t('remoteTransportUnknown') : t('remotePhaseIdle')
}
