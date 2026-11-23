import { useEffect } from 'react'
import clsx from 'clsx'
import { useTranslate } from '../i18n/index.js'
import { useSettings } from '../services/settings.js'
import { useIsMobile, useMobileViewport, usePreventPageScroll } from './viewport.js'
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
import { ensureApiKey } from '../components/settings/settingsDialogState.js'
import { hasAnyCredential } from '../services/models/ready.js'
import {
  clearUpdatePending,
  compareVersion,
  fetchLatestRelease,
  isUpdateSupported,
  readSkippedVersion,
  readUpdatePending,
  readUpdateState,
} from '../services/update.js'
import { openUpdateDialog } from '../components/settings/updateDialogState.js'
import { UpdateDialog } from '../components/settings/UpdateDialog.js'
import { MigrationOverlay } from '../components/layout/MigrationOverlay.js'
import { SettingsDialog } from '../components/settings/SettingsDialog.js'
import { Toast } from '../components/base/Toast.js'
import { showToast } from '../components/base/toastState.js'
import { onUploadNotice } from '../services/attachments.js'
import { Button } from '../components/base/Button.js'
import { stopReadAloud } from '../services/speech/readAloud.js'
import { closeMobileSider } from '../components/sider/mobileSiderState.js'
import { MobileSider, Sider } from '../components/sider/Sider.js'
import { RemoteChatView } from '../components/remote/RemoteChatView.js'
import { useRemoteMode } from '../components/remote/RemoteModeSwitch.js'
import { WorkspacePane } from '../components/remote/workspace/WorkspacePane.js'
import { TabletHeader } from '../components/session/TabletHeader.js'
import styles from './App.module.css'

/**
 * 平板 / 桌面侧栏的容器。
 * 侧栏始终挂载，收起时同时收窄容器宽度并把面板整体左移，
 * 两个属性用同一条缓动曲线，视觉上就是一次干净的滑出。
 */
const SiderSlot = ({ collapsed }: { collapsed: boolean }) => (
  <div className={clsx(styles.siderSlot, collapsed && styles.siderSlotCollapsed)} aria-hidden={collapsed}>
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

  usePreventPageScroll(isMobile)

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

      const newer = latest
        ? Math.max(
            compareVersion(latest.version, current.appVersion),
            compareVersion(latest.version, current.webVersion ?? current.appVersion)
          )
        : -1
      // 用户点过「跳过此版本」就不再为这个版本自动弹窗（有其它提示时仍然弹）
      const skipped = readSkippedVersion()
      const skipThis = Boolean(latest && skipped === latest.version && !notice && !result.error)
      // 有新版本、有需要提示的状态、或者检查本身失败（网络问题）时才弹窗
      if (!skipThis && (newer > 0 || notice || result.error)) {
        openUpdateDialog({ release: latest, state: current, notice, error: result.error })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [t, autoCheckUpdate])

  useEffect(() => {
    void initChat()
    // 首次打开：完全没有凭据时才强制进设置，已配置自定义端点的人不必再填 DeepSeek Key
    if (!hasAnyCredential()) {
      ensureApiKey()
    }
  }, [])

  return (
    <>
      <div className={styles.frame}>
        {isMobile ? <MobileSider /> : <SiderSlot collapsed={siderCollapsed} />}
        <main className={styles.main}>
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
      <SettingsDialog />
      <UpdateDialog />
      <MigrationOverlay />
      <Toast />
    </>
  )
}
