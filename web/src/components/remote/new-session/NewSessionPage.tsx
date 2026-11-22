import clsx from 'clsx'
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { useIsMobile } from '../../../app/viewport.js'
import { useTranslate } from '../../../i18n/index.js'
import { useNewSessionStore } from '../../../services/remote/newSessionStore.js'
import {
  IconBrowseOutline16,
  IconSettingsOutline16,
  IconThinkOutline16,
  IconWarningOutline16,
} from '../../base/icons.js'
import { OptionPill, QuietChip, TipLine } from './chips.js'
import { NewSessionSheets, modelItemLabel } from './NewSessionSheets.js'
import styles from './NewSessionPage.module.css'

/**
 * 新建会话**页**（W6 起；R15 改为「发消息即建会话」）。
 *
 * 形态：**真实视图**（`RemoteChatView` 里 `view: 'chat' | 'new-session'` 的另一半）——
 * 平板/桌面铺满右侧内容区（左侧会话列表照旧在），手机整屏覆盖。没有遮罩、没有滑入动画。
 *
 * 层级照 dsh-Go（`chat/empty_state.dart` + `chat/new_chat_options.dart` + `chat_screen.dart`
 * 里 `sessionId == null` 的那一支）：**输入条才是这一屏的主角**，这里只是安静地递几个起点：
 *
 * ```
 *  ←  新建会话                             ← 顶部一行：返回 + 标题
 *
 *                  ⌒)                     ← 40px 淡装饰（dsh-Go 的鲸尾）
 *              开一段新对话                ← 大标题（22/28，displaySmall）
 *         选好工作区和模型，第一条消息发出时建会话   ← 一句说明
 *
 *               准备在哪工作                 ← 小节标签
 *       ( ▣ 在「deepseek-tablet」中   ⌄ )    ← 工作区大胶囊（这一页的主选择）
 *
 *   ( ◍ V4.1 Flash · 高 ⌄ ) ( ⚒ 工作模式 ⌄ )  ← 一排小胶囊：模型(含思考强度) / 权限 / 预设
 *   ( ⛨ 工作区可写 ⌄ )
 *
 *           💡 发送后会自动创建会话…          ← 提示行
 *  ────────────────────────────────────
 *  ┌────────────────────────────────┐
 *  │ 给 DeepSeek 发消息，回车发送…      ↑ │  ← 与会话页同一个输入框（footer 由外部传入）
 *  └────────────────────────────────┘
 * ```
 *
 * R15 的关键变化：**没有「创建并开始」按钮了**。旧版要先点按钮建会话、再进会话发消息；
 * 用户点名要照 dsh-Go —— 选好选项直接在底下发，发出去了才建会话。所以这一页不再有自己的
 * 底部操作栏，输入框由 `RemoteChatView` 用**会话页同一份 JSX** 传进来（`footer` prop），
 * 设计风格天然一致；发送走 `newSessionStore.createAndSend(text)`。
 *
 * 每个选项点开一个**短列表**（`NewSessionSheets`），而不是页面上的下拉框 —— 这是 dsh-Go 的做法。
 */
export const NewSessionPage = ({ footer }: { footer?: ReactNode }) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const loading = useNewSessionStore((state) => state.loading)
  const creating = useNewSessionStore((state) => state.creating)
  const error = useNewSessionStore((state) => state.error)
  const notice = useNewSessionStore((state) => state.notice)
  const capabilities = useNewSessionStore((state) => state.capabilities)
  const workspaces = useNewSessionStore((state) => state.workspaces)
  const selectedWorkspaceId = useNewSessionStore((state) => state.selectedWorkspaceId)
  const permissionOptions = useNewSessionStore((state) => state.permissionOptions)
  const selectedPermission = useNewSessionStore((state) => state.selectedPermission)
  const permissionDefault = useNewSessionStore((state) => state.permissionDefault)
  const agentPresets = useNewSessionStore((state) => state.agentPresets)
  const selectedAgentPreset = useNewSessionStore((state) => state.selectedAgentPreset)
  const modelCatalog = useNewSessionStore((state) => state.modelCatalog)
  const modelPick = useNewSessionStore((state) => state.modelPick)
  const sheet = useNewSessionStore((state) => state.sheet)

  /** 返回 = 关掉这个视图。会话本身在 store 里没动过，所以回去就是原来那一屏。 */
  const back = (): void => useNewSessionStore.getState().closePanel()

  /*
   * Esc：先收起短列表，再退回去。
   * 能力探测（`probeCapabilities`）不在这里做 —— 挂在 `RemoteChatView` 上，
   * 远程页一就绪就问一次；挂在「打开面板」里的话，「新建对话」按钮的可见性
   * 又依赖这次探测，入口就成了死结（见 `RemoteChatView` 里那段注释）。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (useNewSessionStore.getState().sheet !== null) {
        useNewSessionStore.getState().openSheet(null)
        return
      }
      useNewSessionStore.getState().closePanel()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  const workspace = workspaces.find((item) => item.workspaceId === selectedWorkspaceId)
  const workspaceLabel = workspace === undefined
    ? t('newSessionWorkspaceDefault')
    : t('newSessionWorkspaceIn', { name: workspace.title || workspace.path || workspace.workspaceId })
  const presetLabel = selectedAgentPreset.length === 0
    ? t('newSessionAgentPresetInherit')
    : agentPresets.find((preset) => preset.id === selectedAgentPreset)?.name ?? selectedAgentPreset
  const permissionLabel = selectedPermission.length === 0
    ? t('newSessionPermissionDefault')
    : permissionOptions.find((option) => option.value === selectedPermission)?.name ?? selectedPermission
  const modelLabel = modelItemLabel(t, modelCatalog, modelPick)
  const showModel = capabilities.model && (modelCatalog?.models.length ?? 0) > 0

  return (
    <section
      className={clsx(styles.page, isMobile && styles.pageMobile)}
      aria-label={t('newSession.pageTitle')}
      data-testid="new-session-page"
    >
      {/* ── 顶部一行：返回 + 标题（与左栏 logo 行、会话页顶栏同高同位） ── */}
      <div className={styles.topBar}>
        <button type="button" className={styles.backButton} aria-label={t('newSession.pageBack')} onClick={back}>
          <IconArrowLeftOutline20 />
        </button>
        <div className={styles.topTitle}>{t('newSession.pageTitle')}</div>
        {/*
          [R15] 创建中给一枚小转圈：页面上没有「创建并开始」按钮了，这个状态
          由输入框那边的提示文案（「正在创建…」）说，顶栏只留一个安静的角标。
        */}
        {creating ? (
          <span className={styles.creatingBadge} role="status">
            {t('newSessionCreating')}
          </span>
        ) : null}
      </div>

      {/* ── 中间：居中一列 ── */}
      <div className={styles.body}>
        <div className={styles.column}>
          <div className={styles.hero} aria-hidden>
            {/* 一条很淡的鲸尾（dsh-Go 空态的那个装饰）：一根尾柄分向两侧 */}
            <svg width={44} height={40} viewBox="0 0 44 40" fill="none">
              <path
                d="M22 8.5c0 7.2-1.1 12-4.4 15.9-2.6 3.1-6.2 5.2-10.6 5.8 1.7 2.4 4.1 3.6 7.1 3.6 3.5 0 6.4-1.7 7.9-4.5 1.5 2.8 4.4 4.5 7.9 4.5 3 0 5.4-1.2 7.1-3.6-4.4-.6-8-2.7-10.6-5.8C23.1 20.5 22 15.7 22 8.5Z"
                fill="currentColor"
              />
            </svg>
          </div>
          <h1 className={styles.headline}>{t('newSession.pageHeadline')}</h1>
          <div className={styles.subtitle}>{t('newSession.pageSubtitle')}</div>

          {/* ── 准备在哪工作（这一页的主选择） ── */}
          {capabilities.workspace ? (
            <div className={styles.workspaceSection}>
              <div className={styles.workspaceLabel}>{t('newSession.pageWhereToWork')}</div>
              <QuietChip
                className={styles.workspacePill}
                icon={<IconBrowseOutline16 />}
                label={workspaceLabel}
                ariaLabel={`${t('newSessionWorkspace')}: ${workspaceLabel}`}
                onClick={() => useNewSessionStore.getState().openSheet('workspace')}
              />
            </div>
          ) : (
            <div className={styles.hint}>{t('newSessionWorkspaceUnsupported')}</div>
          )}

          {/* ── 一排三个小胶囊：模型(含思考强度) / 权限预设 / agent preset ── */}
          <div className={styles.pillRow}>
            {showModel ? (
              <OptionPill
                icon={<IconThinkOutline16 />}
                label={modelLabel}
                ariaLabel={`${t('newSessionModel')}: ${modelLabel}`}
                onClick={() => useNewSessionStore.getState().openSheet('model')}
              />
            ) : null}
            {capabilities.permission && permissionOptions.length > 0 ? (
              <OptionPill
                icon={<IconWarningOutline16 />}
                label={permissionLabel}
                ariaLabel={`${t('newSessionPermission')}: ${permissionLabel}`}
                onClick={() => useNewSessionStore.getState().openSheet('permission')}
              />
            ) : null}
            {capabilities.agentPreset && agentPresets.length > 0 ? (
              <OptionPill
                icon={<IconSettingsOutline16 />}
                label={presetLabel}
                ariaLabel={`${t('newSessionAgentPreset')}: ${presetLabel}`}
                onClick={() => useNewSessionStore.getState().openSheet('preset')}
              />
            ) : null}
          </div>
          {permissionDefault.length > 0 && selectedPermission !== '' && selectedPermission !== permissionDefault ? (
            <div className={styles.hint}>
              {permissionOptions.find((option) => option.value === selectedPermission)?.description ?? ''}
            </div>
          ) : null}

          <TipLine text={t('newSession.pageTip')} />

          {notice !== null ? <div className={styles.notice}>{notice}</div> : null}
          {error !== null ? <div className={styles.error}>{error}</div> : null}
          {loading ? <div className={styles.hint}>{t('newSessionLoading')}</div> : null}
          {!capabilities.create ? <div className={styles.hint}>{t('newSessionCreateUnsupported')}</div> : null}
        </div>
      </div>

      {/* ── 底部：会话页同一个输入框（footer 由 RemoteChatView 传入） ── */}
      {footer !== undefined ? <div className={styles.composerSlot}>{footer}</div> : null}

      {sheet !== null ? <NewSessionSheets /> : null}
    </section>
  )
}

/**
 * 返回箭头（20px，描边）。
 *
 * 为什么自己在 `new-session/` 里画一个而不是加进 `base/icons.tsx`：这一批的可改范围只有
 * `new-session/**`、`RemoteChatView.tsx`、`RemoteSessionList.tsx` 与 i18n，`base/` 归别的任务；
 * 真到了要共用的那天，把它挪过去即可（其余 `base/icons.tsx` 的图标是填充路径，这个是描边）。
 */
const IconArrowLeftOutline20 = () => (
  <svg width={20} height={20} viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M16.25 10H4M4 10L9.5 4.5M4 10L9.5 15.5"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)
