import clsx from 'clsx'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { stripDsml } from '../../services/api/dsml.js'
import type {
  ApprovalActivity,
  ApprovalOutcome,
  ChatItem,
  ChatMessage,
  QuestionActivity,
  ToolActivity,
} from '../../services/remote/adapter.js'
import { useRemoteStore } from '../../services/remote/store.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { IconMenuOutline20, IconSendOutline16, IconStopFill16 } from '../base/icons.js'
import { Markdown } from '../markdown/Markdown.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { openMobileSider } from '../sider/mobileSiderState.js'
import { ApprovalCard } from './ApprovalCard.js'
import { useRemoteAvailability } from './RemoteModeSwitch.js'
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

const ALLOW: ApprovalDecision = 'allow_once'
const REJECT: ApprovalDecision = 'deny'

/** 距底部小于该值时视为「在底部」，新内容到达后继续跟随 */
const STICKY_THRESHOLD = 40
/** 距顶部小于该值时自动往前拉一屏历史 */
const LOAD_OLDER_THRESHOLD = 80

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
  const approvals = useRemoteStore((state) => state.pendingApprovals)
  const error = useRemoteStore((state) => state.error)
  // 原生桥探测：只在远程会话页挂载时发生（启动路径上没有任何探测）
  const { availability, retry } = useRemoteAvailability()

  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const stickyRef = useRef(true)
  const scrollTopRef = useRef(0)
  const olderPendingRef = useRef(false)
  const itemCountRef = useRef(0)

  const ready = phase === 'ready'
  const bridgeReady = availability === 'ready'
  const activeTitle =
    sessions.find((session) => session.id === activeSessionId)?.title ?? t('remoteSessionUntitled')

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

  const canSend = ready && activeSessionId !== null && !streaming && draft.trim().length > 0

  const send = useCallback(() => {
    if (!ready || streaming) return
    const text = draft.trim()
    if (text.length === 0) return
    // 乐观清空：与本地输入框一致，发出去就不再占着输入框；失败原因由数据层写回时间线
    setDraft('')
    fireAndForget(() => useRemoteStore.getState().send(text))
  }, [draft, ready, streaming])

  const respond = useCallback((eventId: string, decision: ApprovalDecision) => {
    fireAndForget(() => useRemoteStore.getState().respondApproval(eventId, decision))
  }, [])

  const lastIndex = items.length - 1

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
            {t(phase === 'error' ? 'remotePhaseError' : 'remoteNotConnected')}
          </div>
          <div className={styles.centerHint}>
            {error ? `${error.code}: ${error.message}` : t('remoteNotConnectedHint')}
          </div>
          <Button variant="primary" size="m" onClick={() => openSettings('remote')}>
            {t('remoteOpenSettings')}
          </Button>
        </div>
      ) : activeSessionId === null ? (
        <div className={styles.centerState}>
          <div className={styles.centerTitle}>{t('remotePickSession')}</div>
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
              {items.length === 0 ? (
                <div className={styles.placeholder}>{t('remoteTimelineEmpty')}</div>
              ) : (
                <button
                  type="button"
                  className={styles.loadOlder}
                  onClick={() => fireAndForget(() => useRemoteStore.getState().loadOlder())}
                >
                  {t('remoteLoadOlder')}
                </button>
              )}
              {items.map((item, index) => (
                <RemoteRow key={item.id} item={item} live={streaming && index === lastIndex} />
              ))}
            </div>
          </div>

          <div className={styles.footer}>
            {approvals.length > 0 ? (
              <div className={styles.approvals}>
                {approvals.map((approval) => (
                  <ApprovalCard
                    key={approval.eventId}
                    title={approval.title}
                    detail={approval.detail}
                    busy={false}
                    onAllow={() => respond(approval.eventId, ALLOW)}
                    onReject={() => respond(approval.eventId, REJECT)}
                  />
                ))}
              </div>
            ) : null}

            <div className={styles.inputWrapper}>
              <textarea
                ref={textareaRef}
                className={styles.textarea}
                rows={2}
                value={draft}
                placeholder={t('remoteInputPlaceholder')}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault()
                    send()
                  }
                }}
              />
              <div className={styles.inputRow}>
                <span className={styles.inputHint}>
                  {streaming ? t('remoteSending') : t('remoteInputHint')}
                </span>
                {streaming ? (
                  <button
                    type="button"
                    className={styles.sendButton}
                    aria-label={t('remoteStop')}
                    onClick={() => fireAndForget(() => useRemoteStore.getState().cancel())}
                  >
                    <IconStopFill16 />
                  </button>
                ) : (
                  <button
                    type="button"
                    className={clsx(styles.sendButton, !canSend && styles.sendDisabled)}
                    aria-label={t('send')}
                    aria-disabled={!canSend}
                    onClick={send}
                  >
                    <IconSendOutline16 />
                  </button>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/* ────────────────────────────── 时间线的一行 ────────────────────────────── */

const RemoteRow = ({ item, live }: { item: ChatItem; live: boolean }) => {
  if (item.kind === 'message') return <MessageRow item={item} live={live} />
  if (item.kind === 'tool') return <ToolRow item={item} />
  if (item.kind === 'approval') return <ApprovalRow item={item} />
  return <QuestionRow item={item} />
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

/** 工具调用压成一行：名字 + 状态 + 首行摘要 */
const ToolRow = ({ item }: { item: ToolActivity }) => {
  const t = useTranslate()
  const detail = item.resultDetail?.text ?? item.summary ?? item.arguments ?? ''
  const stateLabel =
    item.state === 'running'
      ? t('remoteToolRunning')
      : item.state === 'failed'
        ? t('remoteToolFailed')
        : t('remoteToolFinished')
  return (
    <div className={styles.activityRow}>
      <span className={styles.activityName}>{item.toolName}</span>
      <span className={clsx(styles.activityState, item.state === 'failed' && styles.activityFailed)}>
        {stateLabel}
      </span>
      {detail.length > 0 ? (
        <span className={styles.activityDetail}>{shorten(detail, 160)}</span>
      ) : null}
    </div>
  )
}

/** 已经处理过的审批留在时间线上，作为一条不可再点的记录 */
const ApprovalRow = ({ item }: { item: ApprovalActivity }) => {
  const t = useTranslate()
  return (
    <div className={styles.activityRow}>
      <span className={styles.activityName}>{t('remoteApprovalTitle')}</span>
      <span className={styles.activityState}>{item.toolName}</span>
      {item.reason === undefined ? null : (
        <span className={styles.activityDetail}>{shorten(item.reason, 160)}</span>
      )}
      <span
        className={clsx(
          styles.activityOutcome,
          item.outcome === 'rejected' && styles.activityFailed
        )}
      >
        {t(outcomeLabel(item.outcome))}
      </span>
    </div>
  )
}

/** 远端 Agent 的提问（P0 只读展示；应答走问答通道，不在本期范围） */
const QuestionRow = ({ item }: { item: QuestionActivity }) => (
  <div className={styles.activityRow}>
    <span className={styles.activityName}>question</span>
    <span className={styles.activityDetail}>
      {item.questions.map((question) => question.question).join(' / ')}
    </span>
  </div>
)

const outcomeLabel = (outcome: ApprovalOutcome | undefined): TranslationKey => {
  if (outcome === 'allowed-once') return 'remoteApprovalAllowed'
  if (outcome === 'rejected') return 'remoteApprovalRejected'
  if (outcome === 'cancelled') return 'remoteApprovalCancelled'
  if (outcome === 'unavailable') return 'remoteApprovalUnavailable'
  return 'remoteApprovalPending'
}

type Translate = ReturnType<typeof useTranslate>

/** 顶栏的通道徽标：拿到说明在跑，没拿到就是连接中/未连接 */
const transportLabel = (t: Translate, transport: string | null, ready: boolean): string => {
  if (transport === 'relay') return t('remoteTransportRelay')
  if (transport === 'lan') return t('remoteTransportLan')
  if (transport === 'p2p') return t('remoteTransportP2p')
  if (transport === 'turn') return t('remoteTransportTurn')
  return ready ? t('remoteTransportUnknown') : t('remotePhaseIdle')
}

/** 单行摘要：折行交给 CSS，超长在这里截断 */
const shorten = (text: string, limit: number): string => {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine
}
