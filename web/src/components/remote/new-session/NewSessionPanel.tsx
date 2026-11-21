import clsx from 'clsx'
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useIsMobile } from '../../../app/viewport.js'
import { useTranslate } from '../../../i18n/index.js'
import { useNewSessionStore } from '../../../services/remote/newSessionStore.js'
import { useRemoteStore } from '../../../services/remote/store.js'
import {
  IconBrowseOutline16,
  IconCloseOutline16,
  IconRefreshOutline16,
  IconSettingsOutline16,
  IconThinkOutline16,
  IconWarningOutline16,
} from '../../base/icons.js'
import { OptionPill, PrimaryPill, QuietChip, TipLine } from './chips.js'
import { ModelFailureNote, NewSessionSheets, modelItemLabel } from './NewSessionSheets.js'
import styles from './NewSessionPanel.module.css'

/**
 * 新建会话面板（W1）。排版按 dsh-Go 的新对话空态（`chat/empty_state.dart` +
 * `chat/new_chat_options.dart` + `chat/model_sheet.dart`）的层级搬过来 —— **居中一列，不是表单卡片**：
 *
 * ```
 *                  ⌒)                       ← 40px 淡装饰（dsh-Go 的鲸尾）
 *                新建会话                   ← 大标题（22/28）
 *          选好工作区和模型，建完就能直接聊      ← 一句说明（14，tertiary）
 *
 *              准备在哪工作                   ← 小节标签
 *      ( ▣ 在「deepseek-tablet」中      ⌄ )   ← 大选择：工作区（36px 胶囊，点开是抽屉）
 *
 *   ( ◍ V4 Pro · 高 ⌄ ) ( ⚒ 工作模式 ⌄ )      ← 一排三个胶囊：模型(含思考强度) / 权限 / 预设
 *   ( ⛨ 工作区可写 ⌄ )
 *
 *          💡 建好后可以直接发消息…             ← 提示行（12，tertiary）
 *
 *   ─────────────────────────────────────
 *      [ 取消 ]        [ 创建并开始 ]        ← 底部吸底：次要 + 主操作
 * ```
 *
 * 每个选项点开一个**短列表**（`NewSessionSheets`：工作区抽屉 / 模型网格 + 思考强度分段 /
 * 预设行 / 权限行），而不是页面上的下拉框 —— 这是 dsh-Go 的做法，也是「旧版看着不像它」的主因。
 *
 * 形态：平板/桌面 = 右侧停靠一列；手机（<768px）= 整屏 sheet；两者同一套层级、按钮都吸底。
 */
export const NewSessionPanel = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const open = useNewSessionStore((state) => state.open)
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
  const modelApply = useNewSessionStore((state) => state.modelApply)
  const createdSessionId = useNewSessionStore((state) => state.createdSessionId)
  const sheet = useNewSessionStore((state) => state.sheet)
  const phase = useRemoteStore((state) => state.phase)

  const close = (): void => useNewSessionStore.getState().closePanel()

  // 连接就绪时补一次「能力 + 工作区」探测（空态按钮的可见性依赖它；自带等连接对象的重试）。
  useEffect(() => {
    if (phase !== 'ready') return
    void Promise.resolve(useNewSessionStore.getState().probeCapabilities()).catch(() => undefined)
  }, [phase])

  // Esc：先关 sheet，再关面板
  useEffect(() => {
    if (!open) return undefined
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
  }, [open])

  if (!open) return null

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
  const failure = modelApply.status === 'failed' ? modelApply.error ?? t('newSessionModelFailed') : null
  const canCreate = capabilities.create && !creating && createdSessionId === null

  return createPortal(
    <div
      className={clsx(styles.overlay, isMobile && styles.overlayMobile)}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <aside
        className={clsx(styles.panel, isMobile ? styles.panelMobile : styles.panelSide)}
        role="dialog"
        aria-modal="true"
        aria-label={t('newSessionTitle')}
      >
        <button type="button" className={styles.closeButton} aria-label={t('newSessionClose')} onClick={close}>
          <IconCloseOutline16 />
        </button>

        <div className={styles.column}>
          {/* ── 顶部：标题 + 一句说明 ── */}
          <div className={styles.hero} aria-hidden>
            {/* 一条很淡的鲸尾（dsh-Go 空态的那个装饰）：一根尾柄分向两侧 */}
            <svg width={44} height={40} viewBox="0 0 44 40" fill="none">
              <path
                d="M22 8.5c0 7.2-1.1 12-4.4 15.9-2.6 3.1-6.2 5.2-10.6 5.8 1.7 2.4 4.1 3.6 7.1 3.6 3.5 0 6.4-1.7 7.9-4.5 1.5 2.8 4.4 4.5 7.9 4.5 3 0 5.4-1.2 7.1-3.6-4.4-.6-8-2.7-10.6-5.8C23.1 20.5 22 15.7 22 8.5Z"
                fill="currentColor"
              />
            </svg>
          </div>
          <div className={styles.heroTitle}>{t('newSessionTitle')}</div>
          <div className={styles.heroSubtitle}>{t('newSessionSubtitle')}</div>

          {/* ── 中间：准备在哪工作（大选择） ── */}
          {capabilities.workspace ? (
            <div className={styles.workspaceSection}>
              <div className={styles.sectionLabel}>{t('newSessionWhereToWork')}</div>
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

          {/* ── 一排三个胶囊：模型(含思考强度) / 权限预设 / agent preset ── */}
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

          {/* ── 提示行 ── */}
          <TipLine text={t('newSessionTip')} />

          {notice !== null ? <div className={styles.notice}>{notice}</div> : null}
          {error !== null ? <div className={styles.error}>{error}</div> : null}
          {loading ? <div className={styles.hint}>{t('newSessionLoading')}</div> : null}
        </div>

        {/* ── 底部吸底：失败时换成两条明确的出路，否则是「取消 / 创建并开始」 ── */}
        <div className={styles.footer}>
          {failure !== null ? (
            <ModelFailureNote
              message={failure}
              onRetry={() => {
                void useNewSessionStore.getState().retryModelApply()
              }}
              onSkip={() => {
                void useNewSessionStore.getState().skipModelAndOpen()
              }}
            />
          ) : (
            <div className={styles.footerButtons}>
              <button type="button" className={styles.secondaryPill} onClick={close}>
                {t('cancel')}
              </button>
              {createdSessionId === null ? null : (
                <span className={styles.spinner} aria-hidden>
                  <IconRefreshOutline16 />
                </span>
              )}
              <PrimaryPill
                label={creating ? t('newSessionCreating') : t('newSessionCreate')}
                disabled={!canCreate}
                onClick={() => {
                  void useNewSessionStore.getState().createAndOpen()
                }}
              />
            </div>
          )}
          {!capabilities.create ? <div className={styles.hint}>{t('newSessionCreateUnsupported')}</div> : null}
        </div>

        {sheet !== null ? <NewSessionSheets /> : null}
      </aside>
    </div>,
    document.body,
  )
}
