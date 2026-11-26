import clsx from 'clsx'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  IconBrowseOutline16,
  IconArrowBack24,
  IconChevronRightOutline14,
  IconDarkOutline16,
  IconDataOutline16,
  IconDownloadOutline16,
  IconFollowsystemOutline16,
  IconLightOutline16,
  IconLinkOutline16,
  IconSettingsOutline16,
  IconUploadOutline14,
} from '../base/icons.js'
import {
  BackupError,
  clearHistory,
  exportHistory,
  importHistory,
} from '../../services/chat/backup.js'
import { currentBackend } from '../../services/chat/db.js'
import { useIsMobile } from '../../app/viewport.js'
import { useChatStore } from '../../services/chat/store.js'
import { regionCodes, getRegionName, provinces } from '../../services/location.js'
import {
  isChineseBrowser,
  DEFAULT_THEME_COLOR,
  setLocale,
  setLocation,
  setSearchBackend,
  setTavilyKey,
  SCALE_MAX,
  SCALE_MIN,
  setThemePreference,
  setThemeColor,
  setUiScale,
  useSettings,
  type ThemePreference,
} from '../../services/settings.js'
import { translate, useTranslate, type TranslationKey, type TranslationMessage } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { ApiKeyField, useApiKeyEditor } from './ApiKeyField.js'
import { BackgroundPermissions } from './BackgroundPermissions.js'
import { closeSettings, setSettingsSection, showSettingsList, useSettingsDialog, type SettingsSection } from './settingsDialogState.js'
import type { ImportProgress } from '../../services/chat/history/importArchive.js'
import { formatFileSize } from '../../utils/format.js'
import { ModelPanel } from '../models/ModelPanel.js'
import { RemoteSettingsPanel } from '../remote/RemoteSettingsPanel.js'
import { UpdatePanel } from './UpdatePanel.js'
import styles from './Settings.module.css'

export const SettingsPage = () => {
  const open = useSettingsDialog((state) => state.open)
  return open ? <SettingsContent /> : null
}

const sections: { value: SettingsSection; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'general',
    label: 'settingDialogAsideGeneralOptionLabel',
    icon: <IconSettingsOutline16 />,
  },
  { value: 'models', label: 'settingDialogAsideModelsOptionLabel', icon: <IconBrowseOutline16 /> },
  { value: 'remote', label: 'settingDialogAsideRemoteOptionLabel', icon: <IconLinkOutline16 /> },
  { value: 'data', label: 'settingDialogAsideDataOptionLabel', icon: <IconDataOutline16 /> },
]

const SettingsContent = () => {
  const t = useTranslate()
  const singlePane = useIsMobile()
  const section = useSettingsDialog((state) => state.section)
  const selected = section ?? 'general'
  const detail = sections.find((item) => item.value === selected)!
  const heading = useRef<HTMLHeadingElement>(null)
  useLayoutEffect(() => {
    heading.current?.focus({ preventScroll: true })
  }, [singlePane ? section : null])

  const apiKeyEditor = useApiKeyEditor()
  const historyImport = useHistoryImport()
  const historyDelete = useHistoryDelete()
  const replacingHistory = useChatStore((state) => state.importingHistory)
  const historyBusy = historyImport.busy || historyDelete.busy || replacingHistory
  const showList = !singlePane || section === null
  return (
    <>
      <main className={styles.page} aria-labelledby="settings-title" data-settings-page>
        <header className={styles.appBar}>
          <IconButton
            size="xl"
            tone="primary"
            icon={<IconArrowBack24 />}
            aria-label={t(singlePane && section ? 'settingsBackToList' : 'settingsBackToChat')}
            onClick={singlePane && section ? showSettingsList : closeSettings}
          />
          <h1 id="settings-title" tabIndex={-1} ref={heading}>
            {t(singlePane && section ? detail.label : 'settings')}
          </h1>
        </header>
        <div className={clsx(styles.panes, singlePane && styles.singlePane)}>
          {showList ? (
            <nav aria-label={t('settings')} className={styles.navigation}>
              {sections.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  aria-current={!singlePane && selected === item.value ? 'page' : undefined}
                  className={styles.navItem}
                  onClick={() => setSettingsSection(item.value)}
                >
                  <span className={styles.navIcon} aria-hidden="true">{item.icon}</span>
                  <span>{t(item.label)}</span>
                  <span className={styles.navChevron} aria-hidden="true"><IconChevronRightOutline14 /></span>
                </button>
              ))}
            </nav>
          ) : null}
          {!singlePane || section ? (
            <div key={selected} className={styles.content} data-settings-content>
              {!singlePane ? <h2 className={styles.paneTitle}>{t(detail.label)}</h2> : null}
              {selected === 'general' ? (
                <>
                  <SettingsGroup label={t('settingsAppearanceGroup')}>
                    <ThemeSetting />
                    <ThemeColorSetting />
                    <ScaleSetting />
                    <LocaleSetting />
                  </SettingsGroup>
                  <SettingsGroup label={t('settingsSearchGroup')}>
                    <SearchSetting />
                    <LocationSetting />
                  </SettingsGroup>
                  <SettingsGroup label={t('settingsAppGroup')}>
                    <UpdatePanel />
                    <BackgroundPermissions />
                    <VersionSetting />
                  </SettingsGroup>
                </>
              ) : selected === 'models' ? (
                <ModelPanel onOpenSection={setSettingsSection} />
              ) : selected === 'remote' ? (
                <RemoteSettingsPanel />
              ) : (
                <SettingsGroup label={t('settingDialogAsideDataOptionLabel')} hideLabel>
                  <StorageSetting />
                  <ApiKeyField editor={apiKeyEditor} />
                  <ImportHistory historyImport={historyImport} disabled={historyBusy} />
                  <ExportHistory disabled={historyBusy} />
                  <SettingCell
                    label={t('deleteAllSessions')}
                    status={null}
                    action={
                      <Button
                        variant="dangerOutlined"
                        size="m"
                        className={styles.cellButton}
                        disabled={historyBusy}
                        onClick={historyDelete.open}
                      >
                        {t('delete')}
                      </Button>
                    }
                  />
                </SettingsGroup>
              )}
            </div>
          ) : null}
        </div>
      </main>
      {historyImport.file ? <ImportConfirm historyImport={historyImport} /> : null}
      {historyDelete.opened ? <DeleteAllConfirm historyDelete={historyDelete} /> : null}
    </>
  )
}

const SettingsGroup = ({ label, hideLabel, children }: { label: string; hideLabel?: boolean; children: ReactNode }) => (
  <section className={styles.group} aria-label={label}>
    {hideLabel ? null : <div className={styles.groupLabel}>{label}</div>}
    <div className={styles.groupItems}>{children}</div>
  </section>
)

/** 删除确认保留在设置之上；失败可重试，成功只关闭确认弹窗。 */
const DeleteAllConfirm = ({
  historyDelete,
}: {
  historyDelete: ReturnType<typeof useHistoryDelete>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('deleteAllSessionsModalTitle')}
      onClose={historyDelete.cancel}
      footer={
        <div className={styles.deleteActions} aria-busy={historyDelete.busy}>
          <Button
            variant="outlined"
            autoFocus
            disabled={historyDelete.busy}
            onClick={historyDelete.cancel}
          >
            {t('cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={historyDelete.busy}
            onClick={() => void historyDelete.confirm()}
          >
            {t(historyDelete.busy ? 'historyDeleting' : 'deleteAllSessions')}
          </Button>
        </div>
      }
    >
      {t('deleteAllSessionsModalDescription')}
    </Modal>
  )
}

const useHistoryDelete = () => {
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const deleting = useRef(false)

  const confirm = async () => {
    if (deleting.current) {
      return
    }
    deleting.current = true
    setBusy(true)
    try {
      await clearHistory()
      setOpened(false)
      showToast({ key: 'historyDeleted' })
    } catch {
      showToast({ key: 'historyDeleteFailed', type: 'error' })
    } finally {
      deleting.current = false
      setBusy(false)
    }
  }

  return {
    opened,
    busy,
    open: () => setOpened(true),
    cancel: () => {
      if (!deleting.current) {
        setOpened(false)
      }
    },
    confirm,
  }
}

const LocationSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const location = useSettings((state) => state.location)
  const province =
    location?.region === 'CN'
      ? provinces.find((item) => item.code === location.province)
      : undefined

  return (
    <SettingCell
      label={t('settingsLocation')}
      status={null}
      className={styles.locationCell}
      action={
        <div className={styles.locationSelectors}>
          {isChineseBrowser() ? (
            <>
              <Select
                ariaLabel={t('settingsLocationProvince')}
                className={styles.provinceSelect}
                value={province?.code ?? ''}
                placeholder={t('settingsLocationProvince')}
                options={provinces.map((item) => ({ value: item.code, label: item.name }))}
                onChange={(value) => {
                  if (value !== province?.code) {
                    setLocation({ region: 'CN', province: value })
                  }
                }}
              />
              <Select
                ariaLabel={t('settingsLocationCity')}
                className={styles.citySelect}
                value={province ? (location?.city ?? '') : ''}
                disabled={!province?.cities.length}
                placeholder={t('settingsLocationCity')}
                options={
                  province?.cities.map((item) => ({ value: item.code, label: item.name })) ?? []
                }
                onChange={(value) => {
                  if (province) {
                    setLocation({ region: 'CN', province: province.code, city: value })
                  }
                }}
              />
            </>
          ) : (
            <Select
              ariaLabel={t('settingsLocationRegion')}
              className={styles.regionSelect}
              value={location?.region ?? ''}
              placeholder={t('settingsLocationRegion')}
              options={regionCodes
                .map((code) => ({ value: code, label: getRegionName(code, locale) }))
                .sort((a, b) => a.label.localeCompare(b.label, locale))}
              onChange={(value) => setLocation({ region: value })}
            />
          )}
        </div>
      }
    />
  )
}

const LocaleSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  return (
    <SettingCell
      label={t('settingsLocalePreference')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsLocalePreference')}
          value={locale}
          options={[
            { value: 'zh-CN', label: t('settingsLocaleZhCN'), lang: 'zh-CN' },
            { value: 'en-US', label: t('settingsLocaleEnUS'), lang: 'en' },
          ]}
          onChange={setLocale}
        />
      }
    />
  )
}

/**
 * 联网搜索后端：DeepSeek 官方接口跑在自己服务端，Tavily 用用户自己的 Key。
 * 与对话模型无关 —— 换模型不影响这里的设置。
 */
const SearchSetting = () => {
  const t = useTranslate()
  const backend = useSettings((state) => state.searchBackend)
  const tavilyKey = useSettings((state) => state.tavilyKey)
  return (
    <SettingCell
      label={t('settingsSearchBackend')}
      description={t('settingsSearchBackendHint')}
      status={null}
      action={
        <div className={styles.searchBackend}>
          <Select
            ariaLabel={t('settingsSearchBackend')}
            value={backend}
            options={[
              { value: 'exa', label: t('settingsSearchExa') },
              { value: 'deepseek', label: 'DeepSeek' },
              { value: 'tavily', label: 'Tavily' },
            ]}
            onChange={(value) => setSearchBackend(value as 'exa' | 'deepseek' | 'tavily')}
          />
          {backend === 'tavily' ? (
            <input
              className={styles.searchKey}
              type="password"
              placeholder={t('settingsTavilyKeyPlaceholder')}
              value={tavilyKey}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) => setTavilyKey(event.target.value)}
            />
          ) : null}
        </div>
      }
    />
  )
}

/** 应用版本：和发布页的版本号一致，方便对照 */
const VersionSetting = () => {
  const t = useTranslate()
  return (
    <SettingCell
      label={t('appVersion')}
      description={`v${__APP_VERSION__}`}
      status={null}
      action={<span />}
    />
  )
}

/**
 * 当前会话存储后端。老用户升级后会先自动迁移到原生 SQLite，迁移成功才显示原生；
 * 浏览器打开、原生接口不可用、迁移校验没通过时仍是 IndexedDB —— 行为与升级前一致。
 */
const StorageSetting = () => {
  const t = useTranslate()
  const backend = currentBackend()
  return (
    <SettingCell
      label={t('settingsStorageBackend')}
      description={t(
        backend === 'native'
          ? 'settingsStorageBackendNative'
          : backend === 'indexeddb'
            ? 'settingsStorageBackendIndexedDb'
            : 'settingsStorageBackendPending'
      )}
      status={null}
      action={<span />}
    />
  )
}

/** 整体界面缩放：滑杆 80%–130%，拖动即生效 */
const ScaleSetting = () => {
  const t = useTranslate()
  const uiScale = useSettings((state) => state.uiScale)
  return (
    <SettingCell
      label={t('settingsUiScale')}
      description={t('settingsUiScaleHint')}
      status={null}
      action={
        <div className={styles.scaleControl}>
          <input
            className={styles.scaleRange}
            type="range"
            min={Math.round(SCALE_MIN * 100)}
            max={Math.round(SCALE_MAX * 100)}
            step={5}
            value={Math.round(uiScale * 100)}
            aria-label={t('settingsUiScale')}
            onChange={(event) => setUiScale(Number(event.target.value) / 100)}
          />
          <span className={styles.scaleValue}>{Math.round(uiScale * 100)}%</span>
          <Button variant="outlined" size="s" onClick={() => setUiScale(1)}>
            {t('settingsUiScaleReset')}
          </Button>
        </div>
      }
    />
  )
}

/** 覆盖导入的二次确认，叠在设置弹窗上 */
const ImportConfirm = ({
  historyImport,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('historyImportConfirmTitle')}
      className={styles.importConfirm}
      onClose={historyImport.cancel}
      footer={
        <>
          <Button variant="outlined" size="m" autoFocus onClick={historyImport.cancel}>
            {t('cancel')}
          </Button>
          <Button variant="dangerOutlined" size="m" onClick={() => void historyImport.confirm()}>
            {t('historyImportConfirm')}
          </Button>
        </>
      }
    >
      <div className={styles.importConfirmText}>
        <div>{t('historyImportConfirmDescription')}</div>
        {historyImport.file ? (
          <div className={styles.importFileName}>
            {t('historyImportFileInfo', {
              name: historyImport.file.name,
              size: formatFileSize(historyImport.file.size),
            })}
          </div>
        ) : null}
      </div>
    </Modal>
  )
}

const themeOptions: { value: ThemePreference; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'light',
    label: 'avatarMenuSettingsDialogThemeSelectLightOption',
    icon: <IconLightOutline16 />,
  },
  {
    value: 'dark',
    label: 'avatarMenuSettingsDialogThemeSelectDarkOption',
    icon: <IconDarkOutline16 />,
  },
  {
    value: 'system',
    label: 'avatarMenuSettingsDialogThemeSelectSystemOption',
    icon: <IconFollowsystemOutline16 />,
  },
]

/**
 * 主题项：标题下方浅色 / 深色 / 跟随系统三个选块。
 * 与下方语言选项连续排列。
 */
const ThemeSetting = () => {
  const t = useTranslate()
  const themePreference = useSettings((state) => state.themePreference)
  const label = t('avatarMenuSettingsDialogThemeItemLabel')
  return (
    <div className={styles.theme}>
      {label}
      <div role="radiogroup" aria-label={label} className={styles.themeOptions}>
        {themeOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={themePreference === option.value}
            className={clsx(
              styles.themeOption,
              themePreference === option.value && styles.themeOptionSelected
            )}
            onClick={() => setThemePreference(option.value)}
          >
            {option.icon}
            {t(option.label)}
          </button>
        ))}
      </div>
    </div>
  )
}

const themeColors = [
  { value: DEFAULT_THEME_COLOR, label: 'settingsColorIndigo' },
  { value: '#1663ad', label: 'settingsColorBlue' },
  { value: '#a94264', label: 'settingsColorRose' },
  { value: '#925000', label: 'settingsColorAmber' },
] as const

const ThemeColorSetting = () => {
  const t = useTranslate()
  const color = useSettings((state) => state.themeColor)
  return (
    <div className={styles.cell}>
      <div className={styles.label}>{t('settingsThemeColor')}</div>
      <div className={styles.colorOptions} role="group" aria-label={t('settingsThemeColor')}>
        {themeColors.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            className={styles.colorOption}
            aria-pressed={color === value}
            onClick={() => setThemeColor(value)}
          >
            <span className={styles.colorSwatch} style={{ backgroundColor: value }} aria-hidden="true" />
            {t(label)}
          </button>
        ))}
      </div>
      <label className={styles.customColor}>
        <span>{t('settingsCustomColor')}</span>
        <input
          type="color"
          value={color}
          onChange={(event) => setThemeColor(event.currentTarget.value)}
        />
        <span className={styles.colorValue} aria-hidden="true">{color.toUpperCase()}</span>
      </label>
    </div>
  )
}

/** `reason` 为失败原因的文案 key，展示时按当前语言翻译后填入 `message` 参数。 */
type Status = (TranslationMessage & { error?: boolean; reason?: TranslationKey }) | null

/** 导出失败附带原因：预期的错误用对应文案作原因，其他错误用错误信息。 */
const errorStatus = (key: TranslationKey, error: unknown): Status => ({
  key,
  ...(error instanceof BackupError
    ? { reason: error.key }
    : { params: { message: error instanceof Error ? error.message : String(error) } }),
  error: true,
})

const SettingCell = ({
  label,
  description,
  status,
  action,
  className,
}: {
  label: string
  description?: string
  status: Status
  action: ReactNode
  className?: string
}) => {
  const t = useTranslate()
  return (
    <div className={clsx(styles.cell, styles.row, className)}>
      <div className={styles.text}>
        <div className={styles.label}>{label}</div>
        {status || description ? (
          <div className={clsx(styles.description, status?.error && styles.error)}>
            {status
              ? t(status.key, status.reason ? { message: t(status.reason) } : status.params)
              : description}
          </div>
        ) : null}
      </div>
      {action}
    </div>
  )
}

/**
 * 选文件后先提示覆盖；确认后检查格式并导入。
 * 导入过程回报进度；失败时展示具体原因（版本不符 / 格式不识别 / 内容不完整），
 * 不再一律吞成「导入失败」。
 */
const useHistoryImport = () => {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const importing = useRef(false)

  const confirm = async () => {
    if (!file || importing.current) {
      return
    }
    importing.current = true
    const picked = file
    setFile(null)
    setBusy(true)
    setStatus(null)
    setProgress(null)
    try {
      const count = await importHistory(picked, setProgress)
      setStatus({ key: count === 1 ? 'historyImportedOne' : 'historyImported', params: { count } })
    } catch (error) {
      const reason =
        error instanceof BackupError
          ? translate(error.key, error.params)
          : error instanceof Error
            ? error.message
            : String(error)
      setStatus({ key: 'historyImportFailedReason', error: true, params: { message: reason } })
    } finally {
      importing.current = false
      setBusy(false)
      setProgress(null)
    }
  }

  return {
    file,
    busy,
    status,
    progress,
    select: (picked: File) => {
      setStatus(null)
      setFile(picked)
    },
    cancel: () => setFile(null),
    confirm,
  }
}

/** 按导入阶段显示对应进度：读文件 / 检查 / 解析对话 / 处理附件 */
const importProgressText = (
  t: ReturnType<typeof useTranslate>,
  progress: ImportProgress | null
): string => {
  if (!progress) return t('historyImportChecking')
  if (progress.phase === 'reading') return t('historyImportReadingFile')
  if (progress.phase === 'check') return t('historyImportChecking')
  // 会话与附件在归档里的先后顺序不固定，谁在动就报谁
  if (progress.sessions === 0 && progress.files > 0) {
    return t('historyImportProgressFiles', { count: progress.files })
  }
  return t('historyImportProgress', { count: progress.sessions })
}

/** 导入 = 覆盖：用选中文件替换本地全部会话与附件。 */
const ImportHistory = ({
  historyImport,
  disabled,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
  disabled: boolean
}) => {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <SettingCell
      label={t('historyImport')}
      description={historyImport.busy ? importProgressText(t, historyImport.progress) : t('historyImportDescription')}
      status={historyImport.busy ? null : historyImport.status}
      action={
        historyImport.busy ? (
          <div className={styles.importBusy} aria-hidden>
            <span className={styles.importSpinner} />
          </div>
        ) : (
          <>
            <Button
              variant="outlined"
              size="m"
              className={clsx(styles.cellButton, styles.uploadButton)}
              disabled={disabled}
              onClick={() => inputRef.current?.click()}
            >
              <IconUploadOutline14 />
              {t('upload')}
            </Button>
            <input
              ref={inputRef}
              type="file"
              hidden
              onChange={(event) => {
                const picked = event.target.files?.[0]
                // 先清空值，保证同一文件再次选择也能触发 change
                event.target.value = ''
                if (picked) {
                  historyImport.select(picked)
                }
              }}
            />
          </>
        )
      }
    />
  )
}

/** 将全部会话及图片导出为 ZIP 文件并下载 */
const ExportHistory = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  const empty = useChatStore((state) => state.sessions.length === 0)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)

  const onExport = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const { name, blob } = await exportHistory()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (error) {
      setStatus(errorStatus('historyExportFailed', error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingCell
      label={t('exportAllLabel')}
      description={t('historyExportDescription')}
      status={status}
      action={
        <Button
          variant="outlined"
          size="m"
          className={styles.cellButton}
          disabled={disabled || busy || empty}
          onClick={() => void onExport()}
        >
          <IconDownloadOutline16 />
          {t('exportAllDownload')}
        </Button>
      }
    />
  )
}
