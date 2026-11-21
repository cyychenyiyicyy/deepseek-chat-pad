import clsx from 'clsx'
import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useIsMobile } from '../../../app/viewport.js'
import { useTranslate } from '../../../i18n/index.js'
import { useNewSessionStore } from '../../../services/remote/newSessionStore.js'
import { useRemoteStore } from '../../../services/remote/store.js'
import { Button } from '../../base/Button.js'
import { IconButton } from '../../base/IconButton.js'
import { IconBrowseOutline16, IconCloseOutline16, IconRefreshOutline16 } from '../../base/icons.js'
import { Select, type SelectOption } from '../../base/Select.js'
import { DirectoryBrowser } from './DirectoryBrowser.js'
import styles from './NewSessionPanel.module.css'

/**
 * 新建会话面板（W1）。
 *
 * 形态：
 *   - **平板 / 桌面**：右侧停靠的一列（固定宽度、贴右边、带投影），点遮罩关闭；
 *   - **手机**：整屏 sheet（顶栏有标题 + 关闭）。
 *
 * 内容顺序照 dsh-Go 的新建对话页：工作区 →（新建工作区）→ 模型（只读）→ 权限预设 → agent preset。
 * 每一项的可见性**只看能力门禁**（`useNewSessionStore.capabilities`）：Host 没有的端点就整块不渲染，
 * 不弹错误对话框（任务纪律）。
 *
 * 模型这一行是**只读**的：`session/modelCatalog` 的完整模型切换由 W2 负责，这里只显示
 * 「继承 Host 默认」到底继承的是谁（provider/model），让用户知道建出来的会话跑在哪个模型上。
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
  const workspaceSource = useNewSessionStore((state) => state.workspaceSource)
  const selectedWorkspaceId = useNewSessionStore((state) => state.selectedWorkspaceId)
  const pathFormOpen = useNewSessionStore((state) => state.pathFormOpen)
  const pathDraft = useNewSessionStore((state) => state.pathDraft)
  const pathError = useNewSessionStore((state) => state.pathError)
  const permissionOptions = useNewSessionStore((state) => state.permissionOptions)
  const selectedPermission = useNewSessionStore((state) => state.selectedPermission)
  const permissionDefault = useNewSessionStore((state) => state.permissionDefault)
  const agentPresets = useNewSessionStore((state) => state.agentPresets)
  const selectedAgentPreset = useNewSessionStore((state) => state.selectedAgentPreset)
  const defaultModel = useNewSessionStore((state) => state.defaultModel)
  const phase = useRemoteStore((state) => state.phase)

  const close = (): void => useNewSessionStore.getState().closePanel()

  /*
   * 连接就绪时补一次「能力 + 工作区」的探测。
   *
   * 为什么挂在这里而不是列表里：手机上会话列表在抽屉里，抽屉没打开时它根本没挂载，
   * 而**空态里的「新建会话」按钮**（`RemoteChatView`）要在这之前就知道 `capabilities.create`。
   * 本组件是远程页的常驻挂载点（关闭时 `return null`，但 effect 照跑），正好合适。
   * `probeCapabilities()` 自带「等连接对象出现」的重试，见那边的注释。
   */
  useEffect(() => {
    if (phase !== 'ready') return
    void Promise.resolve(useNewSessionStore.getState().probeCapabilities()).catch(() => undefined)
  }, [phase])

  // Esc 关闭（手机上等价于「返回」）
  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open])

  if (!open) return null

  const workspaceOptions: SelectOption<string>[] = [
    { value: '', label: t('newSessionWorkspaceDefault') },
    ...workspaces.map((workspace) => ({ value: workspace.workspaceId, label: workspace.title || workspace.path || workspace.workspaceId })),
  ]
  const permissionSelectOptions: SelectOption<string>[] = [
    { value: '', label: t('newSessionPermissionDefault') },
    ...permissionOptions.map((option) => ({ value: option.value, label: option.name })),
  ]
  const agentOptions: SelectOption<string>[] = [
    { value: '', label: t('newSessionAgentPresetInherit') },
    ...agentPresets
      .filter((preset) => preset.broken === undefined)
      .map((preset) => ({ value: preset.id, label: preset.name ?? preset.id })),
  ]

  const canCreate = capabilities.create && !creating
  const modelText =
    defaultModel === null
      ? t('newSessionModelUnknown')
      : `${defaultModel.provider} · ${defaultModel.model}${defaultModel.reasoningEffort === undefined ? '' : ` · ${defaultModel.reasoningEffort}`}`

  const body: ReactNode = (
    <>
      <div className={styles.header}>
        <div className={styles.title}>{t('newSessionTitle')}</div>
        <IconButton
          size="m"
          tone="primary"
          icon={<IconCloseOutline16 />}
          aria-label={t('newSessionClose')}
          onClick={close}
        />
      </div>

      <div className={styles.body}>
        {/* ── 工作区 ─────────────────────────────────────────────── */}
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <span className={styles.label}>{t('newSessionWorkspace')}</span>
            {capabilities.workspace ? (
              <button
                type="button"
                className={styles.linkButton}
                onClick={() => useNewSessionStore.getState().togglePathForm()}
              >
                {t('newSessionWorkspaceAdd')}
              </button>
            ) : null}
          </div>
          {capabilities.workspace ? (
            <>
              {workspaces.length === 0 ? (
                <div className={styles.hint}>{t('newSessionWorkspaceEmpty')}</div>
              ) : (
                <Select
                  value={selectedWorkspaceId ?? ''}
                  options={workspaceOptions}
                  onChange={(value) => useNewSessionStore.getState().selectWorkspace(value === '' ? null : value)}
                  ariaLabel={t('newSessionWorkspace')}
                  className={styles.select}
                />
              )}
              {workspaceSource === 'derived' && workspaces.length > 0 ? (
                <div className={styles.hint}>{t('newSessionWorkspaceDerivedHint')}</div>
              ) : null}
              {pathFormOpen ? <NewWorkspaceForm pathDraft={pathDraft} pathError={pathError} /> : null}
            </>
          ) : (
            <div className={styles.hint}>{t('newSessionWorkspaceUnsupported')}</div>
          )}
        </section>

        {/* ── 模型（只读） ────────────────────────────────────────── */}
        <section className={styles.section}>
          <span className={styles.label}>{t('newSessionModel')}</span>
          <div className={styles.readonlyRow}>
            <span className={styles.readonlyChip}>{t('newSessionModelInherit')}</span>
            <span className={styles.mono}>{modelText}</span>
          </div>
        </section>

        {/* ── 权限预设 ───────────────────────────────────────────── */}
        {capabilities.permission && permissionOptions.length > 0 ? (
          <section className={styles.section}>
            <span className={styles.label}>{t('newSessionPermission')}</span>
            <Select
              value={selectedPermission}
              options={permissionSelectOptions}
              onChange={(value) => useNewSessionStore.getState().selectPermission(value)}
              ariaLabel={t('newSessionPermission')}
              className={styles.select}
            />
            {permissionDefault.length > 0 && selectedPermission !== '' && selectedPermission !== permissionDefault ? (
              <div className={styles.hint}>
                {permissionOptions.find((option) => option.value === selectedPermission)?.description ?? ''}
              </div>
            ) : null}
          </section>
        ) : null}

        {/* ── agent preset ───────────────────────────────────────── */}
        {capabilities.agentPreset && agentPresets.length > 0 ? (
          <section className={styles.section}>
            <span className={styles.label}>{t('newSessionAgentPreset')}</span>
            <Select
              value={selectedAgentPreset}
              options={agentOptions}
              onChange={(value) => useNewSessionStore.getState().selectAgentPreset(value)}
              ariaLabel={t('newSessionAgentPreset')}
              className={styles.select}
            />
            {agentPresets.find((preset) => preset.id === selectedAgentPreset)?.description === undefined ? null : (
              <div className={styles.hint}>
                {agentPresets.find((preset) => preset.id === selectedAgentPreset)?.description ?? ''}
              </div>
            )}
          </section>
        ) : null}

        {!capabilities.create ? (
          <div className={styles.hint}>{t('newSessionCreateUnsupported')}</div>
        ) : null}
        {notice !== null ? <div className={styles.notice}>{notice}</div> : null}
        {error !== null ? <div className={styles.error}>{error}</div> : null}
      </div>

      <div className={styles.footer}>
        <span className={styles.footerHint}>
          {loading ? (
            <span className={styles.spin} aria-hidden>
              <IconRefreshOutline16 />
            </span>
          ) : null}
        </span>
        <Button variant="outlined" size="m" onClick={close}>
          {t('close')}
        </Button>
        <Button
          variant="primary"
          size="m"
          disabled={!canCreate}
          onClick={() => {
            void useNewSessionStore.getState().createAndOpen()
          }}
        >
          {creating ? t('newSessionCreating') : t('newSessionCreate')}
        </Button>
      </div>
    </>
  )

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
        {body}
      </aside>
    </div>,
    document.body,
  )
}

/**
 * 「新建工作区」表单：路径输入 + 目录浏览。
 *
 * `directoryPicker/list` 是可选能力：`capabilities.directory` 为 false（Host 返回
 * `METHOD_NOT_FOUND` 之类）时连「浏览目录」按钮都不渲染，表单仍可手填绝对路径。
 */
const NewWorkspaceForm = ({ pathDraft, pathError }: { pathDraft: string; pathError: string | null }) => {
  const t = useTranslate()
  const creating = useNewSessionStore((state) => state.creating)
  const directory = useNewSessionStore((state) => state.directory)
  const directoryLoading = useNewSessionStore((state) => state.directoryLoading)
  const directoryError = useNewSessionStore((state) => state.directoryError)
  const directoryCapable = useNewSessionStore((state) => state.capabilities.directory)

  return (
    <div className={styles.pathForm}>
      <label className={styles.label} htmlFor="new-session-workspace-path">
        {t('newSessionWorkspacePathLabel')}
      </label>
      <div className={styles.pathRow}>
        <input
          id="new-session-workspace-path"
          className={styles.input}
          value={pathDraft}
          spellCheck={false}
          autoComplete="off"
          placeholder={t('newSessionWorkspacePathPlaceholder')}
          onChange={(event) => useNewSessionStore.getState().setPathDraft(event.target.value)}
        />
        {directoryCapable ? (
          <IconButton
            size="m"
            tone="tertiary"
            icon={<IconBrowseOutline16 />}
            aria-label={t('newSessionBrowse')}
            onClick={() => {
              void useNewSessionStore.getState().browse(directory?.path ?? (pathDraft.trim().length > 0 ? pathDraft.trim() : undefined))
            }}
          />
        ) : null}
      </div>
      {pathError !== null ? <div className={styles.error}>{pathError}</div> : null}
      {directoryCapable ? (
        <DirectoryBrowser
          listing={directory}
          loading={directoryLoading}
          error={directoryError}
          onBrowse={(path) => {
            void useNewSessionStore.getState().browse(path)
          }}
          onPick={(path) => {
            void useNewSessionStore.getState().adoptBrowsedDirectory(path)
          }}
        />
      ) : null}
      <div className={styles.pathActions}>
        <Button
          variant="primary"
          size="s"
          disabled={creating || pathDraft.trim().length === 0}
          onClick={() => {
            void useNewSessionStore.getState().submitWorkspacePath()
          }}
        >
          {t('newSessionWorkspaceCreate')}
        </Button>
      </div>
    </div>
  )
}
