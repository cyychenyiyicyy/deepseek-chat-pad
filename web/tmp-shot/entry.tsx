/**
 * [S3] 截图入口：**真组件**（`RemoteSessionList` / `ComposerRow`）+ 假数据。
 *
 * 为什么不做一套假 DOM：这两个组件的排版（行高、省略号、脉冲点、按钮位置）正是要验的东西，
 * 手抄一份假界面就等于没验。所以这里 import 的是 src 里那份真组件，只把 store 的
 * 状态铺成「两个会话在跑 + 一个待审批」，然后按 `?shot=` 只渲染一屏。
 *
 * 跑法：`node tmp-shot/shoot.cjs`（见那个脚本头部的说明）。
 */

import { createRoot } from 'react-dom/client'
import '../src/app/theme.css'
import '../src/app/global.css'
import './shot.css'

import { setupTheme } from '../src/app/theme.js'
import { RemoteSessionList } from '../src/components/remote/RemoteSessionList.js'
import { ComposerRow } from '../src/components/remote/composer/ComposerRow.js'
import { composerView, type ComposerSignals } from '../src/components/remote/composer/composerState.js'
import { emptyCacheStatus } from '../src/services/remote/cache.js'
import { useLiveSessions } from '../src/services/remote/liveSessions.js'
import { useNewSessionStore } from '../src/services/remote/newSessionStore.js'
import { useRemoteStore } from '../src/services/remote/store.js'
import { useSettings } from '../src/services/settings.js'
import { useTranslate } from '../src/i18n/index.js'

const now = Date.now()

/** 三条会话：两个在跑（其中一个就是当前打开的）、一个在等审批 */
const SESSIONS = [
  { id: 's-live', title: '整理 3 月对账单并导出 CSV', updatedAt: now - 25_000 },
  { id: 's-run', title: '给 README 补一段安装说明', updatedAt: now - 4 * 60_000 },
  { id: 's-approve', title: 'refactor: 把 remote/store.ts 拆成三块', updatedAt: now - 52 * 60_000 },
  { id: 's-idle', title: '周报：本周做了哪些事', updatedAt: now - 26 * 60 * 60_000 },
  { id: 's-old', title: '表结构设计草稿', updatedAt: now - 4 * 24 * 60 * 60_000 },
]

const seed = (): void => {
  useSettings.setState({ locale: 'zh-CN', themePreference: 'light' } as never)
  useRemoteStore.setState({
    phase: 'ready',
    capabilities: ['harness.remote.v1', 'harness.remote.v3', 'session.create', 'session.manage'],
    sessions: SESSIONS,
    activeSessionId: 's-live',
    items: [],
    streaming: true,
    cacheStatus: { ...emptyCacheStatus(), sessionsSynced: true },
    // R9 红点口径（审批 + 提问）；S3 的运行态另外记一份，两边取大值
    pendingInteractions: { 's-approve': { approval: 1, question: 0 } },
  })
  useNewSessionStore.setState({
    capabilities: { create: true, manage: true, search: false, fork: false } as never,
    archivedSessionIds: [],
    pinnedSessionIds: [],
    menuSessionId: null,
    busySessionId: null,
    actionError: null,
    search: { query: '', searching: false, local: false, hits: [] } as never,
    renameTarget: null,
  })
  useLiveSessions.setState({
    reconciledAt: now,
    byId: {
      's-live': { running: true, tool: '读取 README.md', approval: 0, updatedAt: now - 25_000 },
      's-run': { running: true, approval: 0, updatedAt: now - 4 * 60_000 },
      's-approve': { running: false, approval: 1, updatedAt: now - 52 * 60_000 },
      's-idle': { running: false, approval: 0, updatedAt: now - 26 * 60 * 60_000 },
    },
  })
}

const signals = (overrides: Partial<ComposerSignals> = {}): ComposerSignals => ({
  ready: true,
  sessionId: 's-live',
  streaming: true,
  sendMode: 'steer',
  stopTimedOut: false,
  queueLength: 0,
  draft: '',
  attachments: 0,
  attachmentsBusy: false,
  knownCommand: false,
  slashTyping: false,
  ...overrides,
})

/** 假输入区外壳：让它看起来就是 App 里那个圆角输入框（时间线本身与 S3 无关） */
const ComposerShell = ({ draft, placeholder }: { draft: string; placeholder: string }) => {
  const t = useTranslate()
  const view = composerView(signals({ draft }))
  return (
    <div className="mockComposer">
      <div className="mockTextarea" data-empty={draft.length === 0 ? '1' : '0'}>
        {draft.length === 0 ? <span className="mockPlaceholder">{placeholder}</span> : draft}
      </div>
      <ComposerRow
        view={view}
        hint={t('composerHintBusySteer')}
        sendMode="steer"
        modeSupported
        leading={
          <button type="button" className="mockPlus" aria-label="+">
            ＋
          </button>
        }
        onSubmit={() => undefined}
        onStop={() => undefined}
        onSecondarySend={() => undefined}
        onModeChange={() => undefined}
      />
    </div>
  )
}

const Shot = () => {
  const t = useTranslate()
  const shot = new URLSearchParams(window.location.search).get('shot') ?? 'list'
  if (shot === 'list') {
    return (
      <div className="phone">
        <div className="sider">
          <div className="siderTop">{t('appName')}</div>
          <div className="modePill">
            <span>{t('remoteModeLocal')}</span>
            <span className="modePillActive">{t('remoteModeRemote')}</span>
          </div>
          <RemoteSessionList />
        </div>
      </div>
    )
  }
  return (
    <div className="phone">
      <div className="composerHost">
        {shot === 'send' ? (
          <ComposerShell draft="帮我把第三节压到一半长度，保留结论" placeholder={t('remoteInputPlaceholder')} />
        ) : (
          <ComposerShell draft="" placeholder={t('remoteInputPlaceholder')} />
        )}
      </div>
    </div>
  )
}

seed()
setupTheme()
createRoot(document.getElementById('root') as HTMLElement).render(<Shot />)
