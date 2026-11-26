import { useEffect, useLayoutEffect, useRef } from 'react'
import clsx from 'clsx'
import { useTranslate } from '../i18n/index.js'
import { setSiderCollapsed, useSettings } from '../services/settings.js'
import { useIsMobile, useMobileViewport } from './viewport.js'
import {
  bindChatPersistence,
  initChat,
  retrySaveSessions,
  selectSession,
  useChatStore,
} from '../services/chat/store.js'
import { SearchPanel } from '../components/search/SearchPanel.js'
import { closeSearchPanel } from '../components/search/searchPanelState.js'
import { SessionView } from '../components/session/SessionView.js'
import { MobileHeader } from '../components/session/MobileHeader.js'
import { Welcome } from '../components/session/Welcome.js'
import {
  clearUpdatePending,
  compareVersion,
  fetchLatestRelease,
  isUpdateSupported,
  readSkippedVersion,
  readUpdatePending,
  readUpdateState,
  resolveUpdateAction,
} from '../services/update.js'
import { openUpdateDialog } from '../components/settings/updateDialogState.js'
import { UpdateDialog } from '../components/settings/UpdateDialog.js'
import { MigrationOverlay } from '../components/layout/MigrationOverlay.js'
import { SettingsPage } from '../components/settings/SettingsDialog.js'
import { closeSettings, openSettings, showSettingsList, useSettingsDialog } from '../components/settings/settingsDialogState.js'
import { IconChat24, IconHistory24, IconSettingsOutline16 } from '../components/base/icons.js'
import { Toast } from '../components/base/Toast.js'
import { showToast } from '../components/base/toastState.js'
import { onUploadNotice } from '../services/attachments.js'
import { Button } from '../components/base/Button.js'
import { stopReadAloud } from '../services/speech/readAloud.js'
import { closeMobileSider, openMobileSider, useMobileSider } from '../components/sider/mobileSiderState.js'
import { MobileSider, Sider } from '../components/sider/Sider.js'
import { RemoteChatView } from '../components/remote/RemoteChatView.js'
import { useRemoteMode } from '../components/remote/RemoteModeSwitch.js'
import { RemoteWorkspaceDialog } from '../components/remote/RemoteWorkspaceDialog.js'
import { WorkspacePane } from '../components/remote/workspace/WorkspacePane.js'
import { TabletHeader } from '../components/session/TabletHeader.js'
import styles from './App.module.css'

/**
 * 平板 / 桌面侧栏的容器。
 * 侧栏始终挂载，收起时同时收窄容器宽度并把面板整体左移，
 * 两个属性用同一条缓动曲线，视觉上就是一次干净的滑出。
 */
const SiderSlot = ({ collapsed }: { collapsed: boolean }) => (
  <div
    id="desktop-session-sidebar"
    className={clsx(styles.siderSlot, collapsed && styles.siderSlotCollapsed)}
    aria-hidden={collapsed}
    ref={(node) => node?.toggleAttribute('inert', collapsed)}
  >
    <div className={styles.siderInner}>
      <Sider />
    </div>
  </div>
)

export const App = () => {
  // 报到：index.html 的看门狗据此判断这个网页包是不是坏包；
  // 同时写进 <html data-ds-booted>，让 CI 的启动冒烟能在 DOM 里断言「React 真的挂上了」
  useEffect(() => {
    ;(window as unknown as { __dsBooted?: boolean }).__dsBooted = true
    document.documentElement.dataset.dsBooted = '1'
  }, [])

  const t = useTranslate()
  const isMobile = useIsMobile()
  const settingsOpen = useSettingsDialog((state) => state.open)
  const drawerOpen = useMobileSider((state) => state.open)
  const locale = useSettings((state) => state.locale)
  // 移动端侧边栏以独立抽屉管理开合状态
  const siderCollapsed = useSettings((state) => state.siderCollapsed) && !isMobile
  const ready = useChatStore((state) => state.ready)
  const initError = useChatStore((state) => state.initError)
  const saveError = useChatStore((state) => Object.values(state.sessionSaveErrors).some(Boolean))
  const importingHistory = useChatStore((state) => state.importingHistory)
  const session = useChatStore((state) =>
    state.activeId !== null && Object.hasOwn(state.sessionCache, state.activeId)
      ? state.sessionCache[state.activeId]
      : undefined
  )
  const sessionLoadError = useChatStore((state) =>
    state.activeId === null ? false : state.sessionLoadErrors[state.activeId] === true
  )
  const streaming = useChatStore((state) =>
    state.activeId === null ? false : Object.hasOwn(state.streaming, state.activeId)
  )
  const activeId = useChatStore((state) => state.activeId)
  const uiScale = useSettings((state) => state.uiScale)
  useMobileViewport(uiScale)
  const autoCheckUpdate = useSettings((state) => state.autoCheckUpdate)
  // 本机 / 远程 双态：远程模式复用同一套壳，只是把内容区换成远端会话
  const chatMode = useRemoteMode((state) => state.mode)

  const settingsButton = useRef<HTMLButtonElement>(null)
  const previousSettingsOpen = useRef(false)
  useLayoutEffect(() => {
    if (previousSettingsOpen.current && !settingsOpen && document.activeElement === document.body) {
      settingsButton.current?.focus({ preventScroll: true })
    }
    previousSettingsOpen.current = settingsOpen
  }, [settingsOpen])

  useEffect(() => {
    if (!settingsOpen) return
    const onEscape = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== 'Escape') return
      event.preventDefault()
      if (isMobile && useSettingsDialog.getState().section) showSettingsList()
      else closeSettings()
    }
    window.addEventListener('keydown', onEscape)
    return () => window.removeEventListener('keydown', onEscape)
  }, [isMobile, settingsOpen])

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  // 整体缩放：改根元素的 zoom，布局、字号、点击区域一起生效
  useEffect(() => {
    document.documentElement.style.zoom = uiScale === 1 ? '' : String(uiScale)
  }, [uiScale])

  // 文件数、存储空间达到上限时，附件上只显示「上传失败」，原因用 toast 说明
  useEffect(() => onUploadNotice(showToast), [])
  useEffect(bindChatPersistence, [])

  // 搜索结果面板只属于当前会话
  useEffect(closeSearchPanel, [activeId])
  // 切换会话时停止朗读
  useEffect(stopReadAloud, [activeId])
  // 移动端选中会话、切换布局后收起抽屉
  useEffect(closeMobileSider, [activeId, isMobile])

  // 启动时检查一次更新：有新版本就弹窗（带完整更新日志），
  // 同时核对上次没装完的更新、以及「网页包已换但页面还是旧的」这两种情况
  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!autoCheckUpdate || !(await isUpdateSupported())) return
      const [current, result] = await Promise.all([readUpdateState(), fetchLatestRelease()])
      const latest = result.release
      if (cancelled || !current) return

      let notice: string | null = null
      const pending = readUpdatePending()
      if (pending) {
        clearUpdatePending()
        // 上次点了更新但没装成功：如实告知，别让它看起来像已完成
        if (current.webVersion !== pending.version) {
          notice = t('updateInterrupted', { version: pending.version })
        }
      }
      // 网页包已落盘但当前页面还是旧包 → 需要重新加载
      if (!notice && current.webVersion && compareVersion(current.webVersion, __APP_VERSION__) > 0) {
        notice = t('updateNeedsReload', { version: current.webVersion })
      }

      // 只认「真的有东西可装」，不能只比版本号：网页包单独更新后 APK 版本号永远落后，
      // 那种情况下 hasWeb / hasApk 都为 false，一弹窗就是一屏「已是最新版本」，每次启动都来一次。
      const action = resolveUpdateAction(latest, current)
      // 用户点过「跳过此版本」就不再为这个版本自动弹窗（有其它提示时仍然弹）
      const skipped = readSkippedVersion()
      const skipThis = Boolean(latest && skipped === latest.version && !notice)
      // 有可执行更新、或有「上次没装完 / 网页包已换需重载」要告知时才弹窗；
      // 检查本身失败（网络 / 限流）不打扰用户，设置页手动检查会如实显示原因。
      if (!skipThis && (action.actionable || Boolean(notice))) {
        openUpdateDialog({ release: latest, state: current, notice, error: result.error })
      } else if (result.error) {
        console.warn('[update] 启动检查更新失败：', result.error)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [t, autoCheckUpdate])

  useEffect(() => {
    void initChat()
  }, [])

  return (
    <>
      <div className={styles.frame} data-app-frame>
        <nav className={styles.navigation} aria-label={t('appName')}>
          <button
            type="button"
            aria-current={!settingsOpen && !drawerOpen ? 'page' : undefined}
            onClick={() => {
              closeSettings()
              closeMobileSider()
            }}
          >
            <span className={styles.navIcon}><IconChat24 /></span>
            {t('navChat')}
          </button>
          <button
            type="button"
            aria-current={drawerOpen && !settingsOpen ? 'page' : undefined}
            aria-controls={isMobile ? 'mobile-session-drawer' : 'desktop-session-sidebar'}
            aria-expanded={!settingsOpen && (isMobile ? drawerOpen : !siderCollapsed)}
            onClick={() => {
              closeSettings()
              if (isMobile) openMobileSider()
              else setSiderCollapsed(settingsOpen ? false : !siderCollapsed)
            }}
          >
            <span className={styles.navIcon}><IconHistory24 /></span>
            {t('navHistory')}
          </button>
          <button
            type="button"
            aria-current={settingsOpen ? 'page' : undefined}
            ref={settingsButton}
            onClick={() => openSettings()}
          >
            <span className={styles.navIcon}><IconSettingsOutline16 /></span>
            {t('settings')}
          </button>
        </nav>
        <div className={styles.chatSurface} hidden={settingsOpen}>
          {isMobile ? <MobileSider /> : <SiderSlot collapsed={siderCollapsed} />}
          <main className={styles.main} ref={(node) => node?.toggleAttribute('inert', isMobile && drawerOpen)}>
            {chatMode === 'local' && saveError ? (
              <div className={styles.saveError} role="alert">
                <span>{t('sessionSaveFailed')}</span>
                <Button
                  variant="outlined"
                  size="s"
                  disabled={importingHistory}
                  onClick={retrySaveSessions}
                >
                  {t('retry')}
                </Button>
              </div>
            ) : null}
            <div className={styles.content}>
              {chatMode === 'remote' ? (
                // 远程模式不另开页面：左栏仍是侧栏（列表换成远程会话），右栏换成远程会话页
                <div className={styles.remoteWorkspace}>
                  <div className={styles.remoteConversation}>
                    <RemoteChatView />
                  </div>
                  <WorkspacePane />
                </div>
              ) : !ready || (activeId !== null && !session) ? (
                <div className={styles.loadingView}>
                  {isMobile ? <MobileHeader /> : <TabletHeader />}
                  {(!ready ? initError : sessionLoadError) ? (
                    <div className={styles.loadingState} role="status" aria-live="polite">
                      <span>{t(!ready ? 'sessionListLoadFailed' : 'sessionLoadFailed')}</span>
                      <Button
                        variant="outlined"
                        size="m"
                        onClick={() => {
                          if (!ready) {
                            void initChat()
                          } else if (activeId !== null) {
                            selectSession(activeId)
                          }
                        }}
                      >
                        {t('retry')}
                      </Button>
                    </div>
                  ) : (
                    // 懒加载骨架：不写「正在加载对话」，界面先出来，数据到了再把内容填进去
                    <div className={styles.skeleton} aria-hidden="true">
                      <div className={styles.skeletonRow} data-width="60" />
                      <div className={styles.skeletonRow} data-width="88" />
                      <div className={styles.skeletonRow} data-width="74" />
                      <div className={styles.skeletonRow} data-width="92" />
                    </div>
                  )}
                </div>
              ) : session ? (
                <SessionView
                  session={session}
                  streaming={streaming}
                />
              ) : (
                <Welcome />
              )}
            </div>
          </main>
          <SearchPanel />
        </div>
        <SettingsPage />
      </div>
      <RemoteWorkspaceDialog />
      <UpdateDialog />
      <MigrationOverlay />
      <Toast />
    </>
  )
}
