import clsx from 'clsx'
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { stripDsml } from '../../services/api/dsml.js'
import type {
  ApprovalActivity,
  ChatItem,
  ChatMessage,
  ToolActivity,
} from '../../services/remote/adapter.js'
import { useRemoteStore, sendRemoteMessage } from '../../services/remote/store.js'
import {
  timelineHintState,
  timelineViewState,
} from '../../services/remote/cache.js'
import type { RemotePromptAttachment } from '../../services/remote/sessionsApi.js'
import {
  commandLineOf,
  filterCommands,
  slashQuery,
  useChatControls,
} from '../../services/remote/sessionControls.js'
import { useNewSessionStore } from '../../services/remote/newSessionStore.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import {
  IconDataOutline16,
  IconMenuOutline20,
  IconNewChatOutline20,
} from '../base/icons.js'
import { Markdown } from '../markdown/Markdown.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { openMobileSider } from '../sider/mobileSiderState.js'
import { ApprovalCard } from './ApprovalCard.js'
import { ArtifactsInline } from './artifacts/ArtifactsInline.js'
import { SessionArtifactsEntry } from './artifacts/SessionArtifactsEntry.js'
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
import { dispatchPrompt, supportsPromptMode } from './composer/promptMode.js'
// [R14 多 Host] 顶栏的「当前电脑 + 切换下拉」（组件内部自己判显隐，这里只挂一个点）
import { HostSwitcher } from './HostSwitcher.js'
import { NewSessionPanel } from './new-session/NewSessionPanel.js'
import { PlanProgressDock } from './plan/PlanProgressDock.js'
import { useRemoteAvailability } from './RemoteModeSwitch.js'
import { ToolCard } from './tool/ToolCard.js'
import { AttachmentButton } from './workspace/AttachmentButton.js'
import { AttachmentTray } from './workspace/AttachmentTray.js'
import { WorkspacePane } from './workspace/WorkspacePane.js'
import { hasUploadingAttachment, readyReceipts, useWorkspacePane } from './workspace/workspacePaneStore.js'
import styles from './RemoteChatView.module.css'

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
  const sessions = useRemoteStore((state) => state.sessions)
  const activeSessionId = useRemoteStore((state) => state.activeSessionId)
  const items = useRemoteStore((state) => state.items)
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
  /** 工作区文件能力（W3）：Host 回过 `METHOD_NOT_FOUND` 后入口整块隐藏（`null` = 还没探过） */
  const filesSupported = useWorkspacePane((state) => state.filesSupported)
  const attachments = useWorkspacePane((state) => state.attachments)
  // 原生桥探测：只在远程会话页挂载时发生（启动路径上没有任何探测）
  const { availability, retry } = useRemoteAvailability()

  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
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

  const ready = phase === 'ready'

  /*
   * [R10] 掉线自愈的文案（**中性**）：连接断了不等于凭据失效 —— 后台待久了服务端会踢掉连接
   *（75 s 收不到心跳），这一支只显示「正在重连…（第 N 次）」或「暂时连不上服务器」，
   * **绝不**出现「凭据 / 登录过期」字样。真需要人处理的（登录过期 / 设备撤销 / 身份不符）
   * 不进这两支，继续走下面的红字分支。
   */
  const healing = reconnect.status === 'waiting' || reconnect.status === 'connecting'
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
  // 标题以 `session/control` 投影为最新（Host 会自动起名 / 用户可以改名），列表里的那份兜底
  const activeTitle =
    controlTitle !== null && controlTitle.length > 0
      ? controlTitle
      : (sessionsTitle ?? t('remoteSessionUntitled'))
  /** 时间线汇总的用量（投影没给 `usage` 时给「会话信息」面板兜底） */
  const usage = useMemo(() => aggregateUsage(items), [items])

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
   * 工作区文件抽屉的作用域（W3）：跟着「当前会话」走，`workspaceFileScopeId` 就是它。
   *
   * 没连上（或还没选会话）时绑 `null`，面板里的目录缓存与预览一律清掉 ——
   * 上一代连接的预览对象继续留着没有任何意义，还会把 blob URL 拖住。
   * 这里**不发请求**（工作区路径是读 `session/list` 的投影，目录树在抽屉打开时才拉），
   * 所以放在会话切换这种高频路径上也不会多打一次网络。
   */
  useEffect(() => {
    void useWorkspacePane.getState().bind(ready ? activeSessionId : null)
  }, [ready, activeSessionId])

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
    if (el.scrollTop < LOAD_OLDER_THRESHOLD && !olderPendingRef.current && items.length > 0) {
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
   * 附件路径暂时只能是 `queue`：`sendRemoteMessage` 还没有 mode 参数（见 `promptMode.ts`）。
   */
  const send = useCallback(
    (mode: PromptMode) => {
      if (!ready) return
      const text = draft.trim()
      const receipts = readyReceipts(useWorkspacePane.getState().attachments)
      if (text.length === 0 && receipts.length === 0) return
      const blocks: RemotePromptAttachment[] = receipts.map((receiptId) => ({ type: 'file', receiptId }))
      // 乐观清空：与本地输入框一致，发出去就不再占着输入框；失败原因由数据层写回时间线
      setDraft('')
      useWorkspacePane.getState().clearAttachments()
      if (blocks.length > 0) {
        // 附件入口（`sendRemoteMessage` = `store.sendFlow`）第三参就是 mode：
        // 数据层没接 mode 时传 undefined，退回 Host 默认的 queue
        const supportsMode = supportsPromptMode(useRemoteStore.getState())
        fireAndForget(() => sendRemoteMessage(text, blocks, supportsMode ? mode : undefined))
        return
      }
      const applied = dispatchPrompt(useRemoteStore.getState(), text, mode)
      // sender 形状不认识（数据层重构过）：把草稿还回去，别吞用户输入
      if (applied === null) setDraft(text)
    },
    [draft, ready],
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
    [executeCommand],
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
  }, [])

  const lastIndex = items.length - 1

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
  const signals = useMemo<ComposerSignals>(
    () => ({
      ready,
      sessionId: activeSessionId,
      streaming,
      sendMode: effectiveMode,
      stopTimedOut,
      queueLength,
      draft,
      attachments: readyReceipts(attachments).length,
      attachmentsBusy: hasUploadingAttachment(attachments),
      knownCommand,
      slashTyping: slashQuery(draft) !== null,
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
      knownCommand,
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
   */
  const submit = useCallback(() => {
    const intent = composerIntent(signals)
    if (intent === 'none') return
    if (intent === 'command') {
      runCommand(draft.trim())
      return
    }
    send(intent === 'steer' ? 'steer' : 'queue')
  }, [draft, runCommand, send, signals])

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

  return (
    <div className={styles.view}>
      {/*
        这一行不是「远程模式」的页面标题栏 —— 与 `SessionView` 的顶栏同高同位：
        左侧标题 = 当前会话，右侧 = 数据面通道徽标。模式下不再额外套一层页面。
      */}
      <div className={styles.header}>
        {isMobile ? (
          <IconButton
            size="m"
            tone="primary"
            icon={<IconMenuOutline20 />}
            aria-label={t('remoteListButton')}
            onClick={openMobileSider}
          />
        ) : null}
        <div className={styles.title}>{ready && activeSessionId !== null ? activeTitle : ''}</div>
        {/*
          工作区抽屉入口（W3）。门禁：`filesSupported === false`（Host 回 `METHOD_NOT_FOUND`）
          时**整个按钮消失**；`null`（还没探过）时先画出来 —— 端点没有专属 capability，
          不点一次没有别的办法知道。
        */}
        {ready && activeSessionId !== null && filesSupported !== false ? (
          <IconButton
            size="xs"
            tooltip={t('workspacePaneOpen')}
            icon={<IconDataOutline16 />}
            onClick={() => void useWorkspacePane.getState().openPane()}
          />
        ) : null}
        {/*
          交付文件（R12）：本次会话产出过的文件（写 / 改出来的）一个入口。
          放在 `⋯` 左边、与它同尺寸（26px 圆形）—— 菜单本体在 `chat-controls/**`，
          这一批不许碰那个目录，所以入口是顶栏的一个图标按钮（详见
          `input-R12-交付文件.md`）。会话还没产出过文件时组件自己返回 null。
        */}
        {ready && activeSessionId !== null ? (
          <SessionArtifactsEntry items={items} streaming={streaming} />
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
          />
        ) : null}
        {/*
          [R14 多 Host] 当前电脑 + 切换下拉。放在 transport 徽标左边：徽标说「怎么连的」，
          这里说「连的是哪台」，两件事挨着看最省事。没连过 / 没有任何 Host 时组件自己返回 null。
        */}
        <HostSwitcher />
        <span className={clsx(styles.badge, ready ? styles.badgeLive : styles.badgeIdle)}>
          {transportLabel(t, transport, ready)}
        </span>
      </div>

      {!bridgeReady ? (
        // 浏览器预览 / 旧 APK：说明「只能在 App 内用」，并给一次重试（装完 APK 回来即生效）
        <div className={styles.centerState}>
          <div className={styles.centerTitle}>
            {t(availability === 'outdated' ? 'remoteBridgeOutdated' : 'remoteRequiresApp')}
          </div>
          {availability === 'outdated' ? (
            <Button variant="outlined" size="m" onClick={retry}>
              {t('retry')}
            </Button>
          ) : null}
        </div>
      ) : !ready ? (
        <div className={styles.centerState}>
          <div className={styles.centerTitle}>
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
          </div>
          <div className={styles.centerHint}>
            {healing || reconnect.status === 'failed'
              ? healingHint
              : error
                ? `${error.code}: ${error.message}`
                : autoConnect.state === 'failed' && autoConnect.message !== undefined
                  ? autoConnect.message
                  : t('remoteNotConnectedHint')}
          </div>
          {/* 掉线自愈中 / 暂时连不上：给「立即重连」；真正的凭据问题不给重试按钮（重试没有意义） */}
          {healing ||
          reconnect.status === 'failed' ||
          (autoConnect.state === 'failed' &&
            reconnect.status !== 'blocked' &&
            reconnect.status !== 'need-login' &&
            autoConnect.code !== 'SESSION_EXPIRED') ? (
            <Button
              variant="primary"
              size="m"
              onClick={() => fireAndForget(() => useRemoteStore.getState().reconnectNow())}
            >
              {t(healing || reconnect.status === 'failed' ? 'reconnectNow' : 'remoteAutoConnectRetry')}
            </Button>
          ) : null}
          <Button variant="primary" size="m" onClick={() => openSettings('remote')}>
            {t('remoteOpenSettings')}
          </Button>
        </div>
      ) : activeSessionId === null ? (
        <div className={styles.centerState}>
          <div className={styles.centerTitle}>{t('remotePickSession')}</div>
          {/*
            「新建会话」入口（W1）。为什么只挂在**空态**：顶栏与输入区归 W2（会话内控制），
            而空态正是「这台 Host 上一个会话都还没打开」的时候 —— 用户唯一的下一步就是新建一个。
            能力门禁：Host 不支持 `session/create` 时（`capabilities.create === false`）不渲染，
            不弹错误对话框。
          */}
          {canCreateSession ? (
            <Button variant="primary" size="m" onClick={() => useNewSessionStore.getState().openPanel()}>
              <span className={styles.newSessionIcon} aria-hidden>
                <IconNewChatOutline20 />
              </span>
              {t('newSessionEntry')}
            </Button>
          ) : null}
          {isMobile ? (
            <Button variant="outlined" size="m" onClick={openMobileSider}>
              {t('remoteListButton')}
            </Button>
          ) : null}
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
              {items.length > 0 ? (
                <button
                  type="button"
                  className={styles.loadOlder}
                  onClick={() => fireAndForget(() => useRemoteStore.getState().loadOlder())}
                >
                  {t('remoteLoadOlder')}
                </button>
              ) : null}
              {timelinePhase !== 'skeleton'
                ? items.map((item, index) => (
                  /*
                   * 交付文件面板（R12）的**唯一挂载点**：每一行后面都问一句
                   * 「这一轮结束在这一行吗」——`ArtifactsInline` 自己在 services 的分组里
                   * 查 `endIndex`，查不到就返回 null（不产生空行）。抽不到产物时整块不渲染。
                   */
                  <Fragment key={item.id}>
                    <RemoteRow item={item} items={items} live={streaming && index === lastIndex} />
                    <ArtifactsInline items={items} index={index} streaming={streaming} />
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
              <AttachmentTray compact />
              <textarea
                ref={textareaRef}
                className={styles.textarea}
                rows={2}
                value={draft}
                placeholder={t('remoteInputPlaceholder')}
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
                  <AttachmentButton disabled={!ready || activeSessionId === null} />
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
      {/* 新建会话面板（W1）：自己 portal 到 body，这里只是挂载点（不占布局） */}
      <NewSessionPanel />
      {/* 工作区文件抽屉（W3）：同样自己 portal；未展开 / 不支持时内部直接 return null */}
      <WorkspacePane />
    </div>
  )
}

/* ────────────────────────────── 时间线的一行 ────────────────────────────── */

const RemoteRow = ({ item, items, live }: { item: ChatItem; items: ChatItem[]; live: boolean }) => {
  if (item.kind === 'message') return <MessageRow item={item} live={live} />
  if (item.kind === 'tool') return <ToolRow item={item} />
  // 审批卡就长在时间线里（不折进工具卡、也不吸在输入区上方）：命令原文、风险与按钮同一处
  if (item.kind === 'approval') return <ApprovalRow item={item} items={items} />
  // 提问不再是一行只读摘要：选项 / 自由输入 / 倒计时 / 提交全在卡片里（`chat-controls/QuestionCard`）
  return <QuestionCard item={item} />
}

/** 正文用现有的 Markdown 组件；用户行保持纯文本，避免被当成 markdown 解析 */
const MessageRow = ({ item, live }: { item: ChatMessage; live: boolean }) => {
  const t = useTranslate()
  // 上下文 / 只有 usage 的 assistant 行不属于对话正文
  if (item.context === true || item.usageOnly === true) return null
  const isUser = item.role === 'user'
  const text = stripDsml(item.text)
  const reasoning = item.reasoning === undefined ? '' : stripDsml(item.reasoning)
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
          <div className={styles.plainText}>{text}</div>
        ) : (
          <Markdown
            className="ds-assistant-message-main-content"
            content={text}
            loading={live && item.streaming === true}
            cacheKey={item.id}
            disableLink={false}
          />
        )}
        {item.images !== undefined && item.images.length > 0 ? (
          <div className={styles.meta}>
            {t('remoteImagesHint', { count: item.images.length })}
          </div>
        ) : null}
        {item.sendError === undefined ? null : (
          <div className={styles.sendError}>{item.sendError}</div>
        )}
      </div>
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
