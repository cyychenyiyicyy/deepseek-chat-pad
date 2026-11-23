import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { useTranslate } from '../../../i18n/index.js'
import { useNewSessionStore } from '../../../services/remote/newSessionStore.js'
import { Button } from '../../base/Button.js'
import {
  IconBrowseOutline16,
  IconSettingsOutline16,
  IconThinkOutline16,
  IconWarningOutline16,
} from '../../base/icons.js'
import { OptionPill, QuietChip } from './chips.js'
import { NewSessionSheets, modelItemLabel } from './NewSessionSheets.js'
import styles from './NewSessionPage.module.css'

/** Configure the host workspace before sending the first prompt. */
export const NewSessionPage = ({ footer, modalOpen, onVoiceCall }: {
  footer?: ReactNode
  modalOpen?: boolean
  onVoiceCall?: () => void
}) => {
  const t = useTranslate()
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
    if (modalOpen) return
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
  }, [modalOpen])

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
      className={styles.page}
      aria-label={t('newSession.pageTitle')}
      data-testid="new-session-page"
    >
      {/* ── 顶部一行：返回 + 标题（与左栏 logo 行、会话页顶栏同高同位） ── */}
      <div className={styles.topBar}>
        <button type="button" className={styles.backButton} aria-label={t('newSession.pageBack')} onClick={back}>
          <IconArrowLeftOutline20 />
        </button>
        <div className={styles.topTitle}>{t('newSession.pageTitle')}</div>
        {onVoiceCall && <div className={styles.headerAction}>
          <Button variant="outlined" size="m" onClick={onVoiceCall}>{t('remoteVoiceCall')}</Button>
        </div>}
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
          {capabilities.workspace ? (
            <div className={styles.workspaceSection}>
              <h1 className={styles.workspaceLabel}>{t('newSession.pageWhereToWork')}</h1>
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

          {notice !== null ? <div className={styles.notice} role="status">{notice}</div> : null}
          {error !== null ? <div className={styles.error} role="alert">{error}</div> : null}
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
