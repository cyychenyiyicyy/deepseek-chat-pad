import clsx from 'clsx'
import type { ReactNode } from 'react'
import { useTranslate } from '../../../i18n/index.js'
import {
  useNewSessionStore,
  effectiveModelEntry,
  effectiveModelSelection,
  type ModelPick,
} from '../../../services/remote/newSessionStore.js'
import { shortModelName, type RemoteModelCatalog, type RemoteModelEntry } from '../../../services/remote/sessionsApi.js'
import { Button } from '../../base/Button.js'
import {
  IconBrowseOutline16,
  IconCheckOutline16,
  IconCloseOutline16,
  IconRefreshOutline16,
  IconSettingsOutline16,
  IconWarningOutline16,
} from '../../base/icons.js'
import { DirectoryBrowser } from './DirectoryBrowser.js'
import { SegmentedPill, effortText } from './chips.js'
import styles from './NewSessionPanel.module.css'

/**
 * 新建会话页的**短列表**（照 dsh-Go：每个选项点开一个小 sheet，而不是页面上一排下拉框）。
 *
 * 层级取自 `model_sheet.dart` / `new_chat_options.dart` 的 `_ChoiceSheet`：
 *   标题栏（标题 + 关闭）→ 可滚动的行 / 卡片 → 可选的底部主操作。
 * 单个 sheet 都不做「确认再生效」：点中即改（和 dsh-Go 一致），只有模型那个带了
 * 一个「完成」按钮，因为它的选择是「模型 + 思考强度」两件事。
 */
export const NewSessionSheets = () => {
  const sheet = useNewSessionStore((state) => state.sheet)
  if (sheet === null) return null
  if (sheet === 'workspace') return <WorkspaceSheet />
  if (sheet === 'newWorkspace') return <NewWorkspaceSheet />
  if (sheet === 'model') return <ModelSheet />
  if (sheet === 'preset') return <PresetSheet />
  return <PermissionSheet />
}

/** sheet 的外壳：点遮罩关闭 + 卡片贴面板底部（dsh-Go 的 bottom sheet 位置）。 */
const SheetFrame = ({
  title,
  onClose,
  children,
  footer,
  testId,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  testId?: string
}) => (
  <div
    className={styles.sheetBackdrop}
    onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}
  >
    <div className={styles.sheet} role="dialog" aria-modal="true" aria-label={title} data-testid={testId}>
      <div className={styles.sheetHeader}>
        <span className={styles.sheetTitle}>{title}</span>
        <button type="button" className={styles.sheetClose} aria-label={title} onClick={onClose}>
          <IconCloseOutline16 />
        </button>
      </div>
      <div className={styles.sheetBody}>{children}</div>
      {footer === undefined ? null : <div className={styles.sheetFooter}>{footer}</div>}
    </div>
  </div>
)

/** 一行可选值：图标 + 标题（+ 副标题 + 右侧 meta）+ 选中勾。 */
const ChoiceRow = ({
  icon,
  title,
  subtitle,
  meta,
  selected = false,
  disabled = false,
  onClick,
}: {
  icon?: ReactNode
  title: string
  subtitle?: string
  meta?: string
  selected?: boolean
  disabled?: boolean
  onClick?: () => void
}) => (
  <button
    type="button"
    className={clsx(styles.choiceRow, selected && styles.choiceRowSelected)}
    aria-pressed={selected}
    disabled={disabled}
    onClick={onClick}
  >
    {icon === undefined ? null : (
      <span className={styles.choiceIcon} aria-hidden>
        {icon}
      </span>
    )}
    <span className={styles.choiceMain}>
      <span className={styles.choiceTitle}>{title}</span>
      {subtitle === undefined || subtitle.length === 0 ? null : (
        <span className={styles.choiceSubtitle}>{subtitle}</span>
      )}
    </span>
    {meta === undefined ? null : <span className={styles.choiceMeta}>{meta}</span>}
    <span className={clsx(styles.choiceCheck, selected && styles.choiceCheckOn)} aria-hidden>
      {selected ? <IconCheckOutline16 /> : null}
    </span>
  </button>
)

/* ────────────────────────────── 工作区 ────────────────────────────── */

const WorkspaceSheet = () => {
  const t = useTranslate()
  const workspaces = useNewSessionStore((state) => state.workspaces)
  const selectedWorkspaceId = useNewSessionStore((state) => state.selectedWorkspaceId)
  const workspaceSource = useNewSessionStore((state) => state.workspaceSource)
  const close = (): void => useNewSessionStore.getState().openSheet(null)

  return (
    <SheetFrame title={t('newSessionWorkspace')} onClose={close} testId="workspace-sheet">
      <ChoiceRow
        icon={<IconBrowseOutline16 />}
        title={t('newSessionWorkspaceDefault')}
        subtitle={t('newSessionWorkspaceDefaultHint')}
        selected={selectedWorkspaceId === null}
        onClick={() => {
          useNewSessionStore.getState().selectWorkspace(null)
          close()
        }}
      />
      {workspaces.map((workspace) => (
        <ChoiceRow
          key={workspace.workspaceId}
          icon={<IconBrowseOutline16 />}
          title={workspace.title || workspace.path || workspace.workspaceId}
          subtitle={workspace.path || undefined}
          selected={workspace.workspaceId === selectedWorkspaceId}
          onClick={() => {
            useNewSessionStore.getState().selectWorkspace(workspace.workspaceId)
            close()
          }}
        />
      ))}
      {workspaces.length === 0 ? <div className={styles.sheetHint}>{t('newSessionWorkspaceEmpty')}</div> : null}
      {workspaceSource === 'derived' && workspaces.length > 0 ? (
        <div className={styles.sheetHint}>{t('newSessionWorkspaceDerivedHint')}</div>
      ) : null}
      <div className={styles.sheetDivider} />
      <ChoiceRow
        icon={<IconSettingsOutline16 />}
        title={t('newSessionWorkspaceAdd')}
        onClick={() => useNewSessionStore.getState().openSheet('newWorkspace')}
      />
    </SheetFrame>
  )
}

/* ─────────────────────────── 新建工作区 ─────────────────────────── */

const NewWorkspaceSheet = () => {
  const t = useTranslate()
  const pathDraft = useNewSessionStore((state) => state.pathDraft)
  const pathError = useNewSessionStore((state) => state.pathError)
  const creating = useNewSessionStore((state) => state.creating)
  const directory = useNewSessionStore((state) => state.directory)
  const directoryLoading = useNewSessionStore((state) => state.directoryLoading)
  const directoryError = useNewSessionStore((state) => state.directoryError)
  const directoryCapable = useNewSessionStore((state) => state.capabilities.directory)
  const close = (): void => useNewSessionStore.getState().openSheet(null)

  return (
    <SheetFrame
      title={t('newSessionWorkspaceAdd')}
      onClose={close}
      testId="new-workspace-sheet"
      footer={
        <Button
          variant="primary"
          size="m"
          block
          disabled={creating || pathDraft.trim().length === 0}
          onClick={() => {
            void useNewSessionStore.getState().submitWorkspacePath()
          }}
        >
          {t('newSessionWorkspaceCreate')}
        </Button>
      }
    >
      <label className={styles.fieldLabel} htmlFor="new-session-workspace-path">
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
          <button
            type="button"
            className={styles.browseButton}
            aria-label={t('newSessionBrowse')}
            onClick={() => {
              void useNewSessionStore.getState().browse(directory?.path ?? (pathDraft.trim().length > 0 ? pathDraft.trim() : undefined))
            }}
          >
            <IconBrowseOutline16 />
          </button>
        ) : null}
      </div>
      {pathError !== null ? <div className={styles.sheetError}>{pathError}</div> : null}
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
      ) : (
        <div className={styles.sheetHint}>{t('newSessionDirectoryUnsupported')}</div>
      )}
    </SheetFrame>
  )
}

/* ────────────────────────────── 模型 ────────────────────────────── */

const ModelSheet = () => {
  const t = useTranslate()
  const catalog = useNewSessionStore((state) => state.modelCatalog)
  const pick = useNewSessionStore((state) => state.modelPick)
  const close = (): void => useNewSessionStore.getState().openSheet(null)
  const effective = effectiveModelSelection(catalog, pick)
  const entry = effectiveModelEntry(catalog, pick)
  const efforts = entry?.efforts ?? []
  const selectedEffort = entry === undefined
    ? undefined
    : pick?.effort ?? entry.defaultEffort ?? (pick === null ? catalog?.default?.reasoningEffort : undefined)

  // 按 provider 分组（Host 的 `groups[]` 在 API 层已经摊平成 `models[]`，这里再归一次组）
  const providers = new Map<string, { name: string; models: RemoteModelEntry[] }>()
  for (const model of catalog?.models ?? []) {
    const group = providers.get(model.provider)
    if (group === undefined) providers.set(model.provider, { name: model.providerName, models: [model] })
    else group.models.push(model)
  }

  return (
    <SheetFrame
      title={t('newSessionModel')}
      onClose={close}
      testId="model-sheet"
      footer={
        <Button variant="primary" size="m" block onClick={close}>
          {t('newSessionDone')}
        </Button>
      }
    >
      {[...providers.entries()].map(([provider, group]) => (
        <div key={provider} className={styles.modelGroup}>
          {providers.size > 1 ? <div className={styles.sectionLabel}>{group.name}</div> : null}
          <div className={styles.modelGrid}>
            {group.models.map((model) => {
              const selected = effective?.provider === model.provider && effective.model === model.id
              return (
                <button
                  key={`${model.provider}/${model.id}`}
                  type="button"
                  className={clsx(styles.modelCard, selected && styles.modelCardSelected)}
                  aria-pressed={selected}
                  onClick={() => useNewSessionStore.getState().pickModel(model.provider, model.id)}
                >
                  <span className={styles.modelCardTitle}>{shortModelName(model.name)}</span>
                  {model.description === undefined ? null : (
                    <span className={styles.modelCardSubtitle}>{model.description}</span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      ))}

      {efforts.length >= 2 ? (
        <>
          <div className={styles.sectionLabel}>{t('newSessionThinkingEffort')}</div>
          <SegmentedPill
            ariaLabel={t('newSessionThinkingEffort')}
            segments={efforts.map((effort) => ({
              value: effort.id,
              label: effortText(t, effort.id, effort.name),
            }))}
            selected={selectedEffort ?? efforts[0]?.id ?? ''}
            onSelect={(effort) => useNewSessionStore.getState().pickEffort(effort)}
          />
          {efforts.find((effort) => effort.id === selectedEffort)?.description === undefined ? null : (
            <div className={styles.sheetHint}>
              {efforts.find((effort) => effort.id === selectedEffort)?.description ?? ''}
            </div>
          )}
        </>
      ) : (
        <div className={styles.sheetHint}>{t('newSessionThinkingEffortUnsupported')}</div>
      )}
    </SheetFrame>
  )
}

/* ───────────────────────── agent preset ───────────────────────── */

const PresetSheet = () => {
  const t = useTranslate()
  const presets = useNewSessionStore((state) => state.agentPresets)
  const selected = useNewSessionStore((state) => state.selectedAgentPreset)
  const close = (): void => useNewSessionStore.getState().openSheet(null)

  return (
    <SheetFrame title={t('newSessionAgentPreset')} onClose={close} testId="preset-sheet">
      <ChoiceRow
        icon={<IconSettingsOutline16 />}
        title={t('newSessionAgentPresetInherit')}
        selected={selected.length === 0}
        onClick={() => {
          useNewSessionStore.getState().selectAgentPreset('')
          close()
        }}
      />
      {presets.map((preset) => (
        <ChoiceRow
          key={preset.id}
          icon={<IconSettingsOutline16 />}
          title={preset.name ?? preset.id}
          subtitle={preset.broken === undefined ? preset.description : t('newSessionUnavailable')}
          meta={preset.isDefault ? t('newSessionDefault') : undefined}
          selected={preset.id === selected}
          disabled={preset.broken !== undefined}
          onClick={() => {
            useNewSessionStore.getState().selectAgentPreset(preset.id)
            close()
          }}
        />
      ))}
    </SheetFrame>
  )
}

/* ────────────────────────── 权限预设 ────────────────────────── */

const PermissionSheet = () => {
  const t = useTranslate()
  const options = useNewSessionStore((state) => state.permissionOptions)
  const selected = useNewSessionStore((state) => state.selectedPermission)
  const hostDefault = useNewSessionStore((state) => state.permissionDefault)
  const close = (): void => useNewSessionStore.getState().openSheet(null)

  return (
    <SheetFrame title={t('newSessionPermission')} onClose={close} testId="permission-sheet">
      <ChoiceRow
        icon={<IconWarningOutline16 />}
        title={t('newSessionPermissionDefault')}
        subtitle={hostDefault.length === 0 ? undefined : hostDefault}
        selected={selected.length === 0}
        onClick={() => {
          useNewSessionStore.getState().selectPermission('')
          close()
        }}
      />
      {options.map((option) => (
        <ChoiceRow
          key={option.value}
          icon={<IconWarningOutline16 />}
          title={option.name}
          subtitle={option.description}
          meta={option.value === hostDefault ? t('newSessionDefault') : undefined}
          selected={option.value === selected}
          onClick={() => {
            useNewSessionStore.getState().selectPermission(option.value)
            close()
          }}
        />
      ))}
    </SheetFrame>
  )
}

/** 模型应用失败时的提示块（在面板正文里，不在 sheet 里）。 */
export const ModelFailureNote = ({ message, onRetry, onSkip }: { message: string; onRetry: () => void; onSkip: () => void }) => {
  const t = useTranslate()
  return (
    <div className={styles.failureCard} role="alert">
      <div className={styles.failureText}>{message}</div>
      <div className={styles.failureActions}>
        <button type="button" className={styles.failurePrimary} onClick={onRetry}>
          <span className={styles.inlineIcon} aria-hidden>
            <IconRefreshOutline16 />
          </span>
          {t('newSessionRetry')}
        </button>
        <button type="button" className={styles.failureSecondary} onClick={onSkip}>
          {t('newSessionSkipModel')}
        </button>
      </div>
    </div>
  )
}

/** 短列表里「模型」那一项要显示的字（`V4 Pro · 高`）。 */
export const modelItemLabel = (
  t: ReturnType<typeof useTranslate>,
  catalog: RemoteModelCatalog | null,
  pick: ModelPick | null,
): string => {
  const effective = effectiveModelSelection(catalog, pick)
  if (effective === null) return t('newSessionModelInherit')
  const entry = effectiveModelEntry(catalog, pick)
  const name = shortModelName(entry?.name ?? effective.model)
  const effort = effective.reasoningEffort ?? entry?.defaultEffort
  return effort === undefined
    ? name
    : `${name} · ${effortText(t, effort, entry?.efforts.find((item) => item.id === effort)?.name)}`
}

/** 思考强度的短标签（选项行上只用得到这一个）。 */
export const effortItemLabel = (
  t: ReturnType<typeof useTranslate>,
  catalog: RemoteModelCatalog | null,
  pick: ModelPick | null,
): string => {
  const effective = effectiveModelSelection(catalog, pick)
  const entry = effectiveModelEntry(catalog, pick)
  const effort = effective?.reasoningEffort ?? entry?.defaultEffort
  if (effort === undefined) return t('newSessionThinkingEffortDefault')
  return effortText(t, effort, entry?.efforts.find((item) => item.id === effort)?.name)
}

/** 诊断用：这个模型有没有可选的思考强度（决定选项行要不要显示「思考强度」这一项）。 */
export const modelHasEfforts = (
  catalog: RemoteModelCatalog | null,
  pick: ModelPick | null,
): boolean => (effectiveModelEntry(catalog, pick)?.efforts.length ?? 0) >= 2
