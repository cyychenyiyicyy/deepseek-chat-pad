import { useEffect } from 'react'
import { useTranslate } from '../../../i18n/index.js'
import { useLiveSessions } from '../../../services/remote/liveSessions.js'
import { useNewSessionStore } from '../../../services/remote/newSessionStore.js'
import { useRemoteStore } from '../../../services/remote/store.js'
import {
  modelDisplayName,
  permissionDisplayName,
  useChatControls,
} from '../../../services/remote/sessionControls.js'
import styles from './Controls.module.css'
import { subagentChildrenOf } from './subagents.js'
import { formatTokens } from './usage.js'
import type { RemoteUsage } from '../../../services/remote/sessionControls.js'

/**
 * 数据层方法可能同步抛、也可能返回 rejected 的 promise；两者都只反映到 store 的
 * `state.error`（数据层自己写的），这里吞掉即可 —— 写法照 `RemoteSessionList.tsx` 的
 * 同名函数。
 */
const fireAndForget = (action: () => unknown) => {
  try {
    void Promise.resolve(action()).catch(() => undefined)
  } catch {
    // 同步抛错已由数据层写入状态，这里吞掉即可
  }
}

/**
 * 「会话信息」面板：标题 / 会话 id / 模型 / 权限预设 / 排队条数 / 用量 / 子代理。
 *
 * 数据来源分工写清楚（避免「怎么和别处显示的不一样」这类问题）：
 *  - 标题、模型、权限、队列、`usage` 投影 → `sessionControls` 的 store（`session/control` 投影）；
 *  - 用量兜底 → 调用方传进来的 `usage`（时间线汇总），投影没有时才用它；
 *  - [R16 子代理] → `useNewSessionStore.rows`（`session/list` 的**原始行**）：会话列表
 *    故意把子代理会话滤掉了（`store.ts` 的 `projectSessions`，照 dsh-Go
 *    `workspaces_state.dart:515`），这里反过来只挑 `parentSessionId === 当前会话`
 *    的那几行（dsh-Go 会话详情的「子代理」tab，`session_detail_page.dart`）。
 *
 * RPC 只有两处且都 fireAndForget：挂载时静默补一次 `ensureWorkspaceFlags()`（rows
 * 可能是旧快照），点子代理行时 `openSession` 进那个子会话。其余仍是只读展示。
 */
export const SessionInfoPanel = ({
  sessionId,
  title,
  usage,
  onNavigate,
}: {
  sessionId: string | null
  title: string | null
  /** 时间线汇总出来的用量（投影没给 `usage` 时用它） */
  usage: RemoteUsage | null
  /**
   * [R16 合并补] 点子代理行会跳进**另一个**会话 —— 面板（可能挂在 ⋯ 菜单里）该不该
   * 跟着关，只有宿主知道。宿主传 `close`，面板只管调用；不传就保持原状。
   */
  onNavigate?: () => void
}) => {
  const t = useTranslate()
  const catalog = useChatControls((state) => state.modelCatalog)
  const currentModel = useChatControls((state) => state.currentModel)
  const permissions = useChatControls((state) => state.permissions)
  const currentPermission = useChatControls((state) => state.currentPermission)
  const queue = useChatControls((state) => state.queue)
  const projectionUsage = useChatControls((state) => state.usage)

  /* [R16 子代理] `session/list` 的原始行（列表滤掉的那几行正是这里要的，规则在 subagents.ts） */
  const rows = useNewSessionStore((state) => state.rows)
  /*
   * [S3] 全局运行态：子代理还在跑 → 行尾脉冲点。订阅整张表而不是逐行订阅 ——
   * `liveSessions` 的归约保证「没变化就返回原引用」，这张表一天也换不了几次。
   */
  const liveById = useLiveSessions((state) => state.byId)
  const subagents = subagentChildrenOf(rows, sessionId)

  /*
   * rows 可能是旧快照（拉完列表之后 Host 又派了子代理，这里看不到）：面板挂载时静默
   * 补一次 `session/list`（`ensureWorkspaceFlags` 幂等单飞、失败即止 —— 拉不到就用手上的旧快照）。
   */
  useEffect(() => {
    fireAndForget(() => useNewSessionStore.getState().ensureWorkspaceFlags())
  }, [])

  const effectiveUsage = projectionUsage ?? usage
  const model = modelDisplayName(catalog, currentModel) ?? t('chatControlsModelDefault')
  const permission = permissionDisplayName(permissions, currentPermission) ?? t('chatControlsPermissionDefault')

  return (
    <div>
      <div className={styles.panelHead}>
        <span className={styles.panelTitle}>{t('chatControlsInfoTitle')}</span>
      </div>
      <div className={styles.panelBody}>
        <div className={styles.infoRow}>
          <span className={styles.infoLabel}>{t('chatControlsInfoSession')}</span>
          <span className={styles.infoValue}>{title === null || title.length === 0 ? t('remoteSessionUntitled') : title}</span>
        </div>
        <div className={styles.infoRow}>
          <span className={styles.infoLabel}>{t('chatControlsInfoSessionId')}</span>
          <span className={`${styles.infoValue} ${styles.infoMono}`}>{sessionId ?? '—'}</span>
        </div>
        <div className={styles.infoRow}>
          <span className={styles.infoLabel}>{t('chatControlsInfoModel')}</span>
          <span className={styles.infoValue}>{model}</span>
        </div>
        <div className={styles.infoRow}>
          <span className={styles.infoLabel}>{t('chatControlsInfoPermission')}</span>
          <span className={styles.infoValue}>{permission}</span>
        </div>
        <div className={styles.infoRow}>
          <span className={styles.infoLabel}>{t('chatControlsInfoQueue')}</span>
          <span className={styles.infoValue}>{t('chatControlsInfoQueueValue', { count: queue.length })}</span>
        </div>
        <div className={styles.infoRow}>
          <span className={styles.infoLabel}>{t('chatControlsInfoUsage')}</span>
          <span className={styles.infoValue}>
            {effectiveUsage === null
              ? t('chatControlsInfoUsageEmpty')
              : [
                  t('chatControlsInfoUsageInput', { count: formatTokens(effectiveUsage.inputTokens) }),
                  t('chatControlsInfoUsageOutput', { count: formatTokens(effectiveUsage.outputTokens) }),
                  ...(effectiveUsage.cacheReadTokens === undefined
                    ? []
                    : [t('chatControlsInfoUsageCache', { count: formatTokens(effectiveUsage.cacheReadTokens) })]),
                ].join(' · ')}
          </span>
        </div>
        {/* [R16 子代理] 这个会话派出的子代理；sessionId 为 null（面板没绑会话）整节不渲染 */}
        {sessionId === null ? null : (
          <>
            <div className={styles.divider} />
            <div className={styles.subagentHead}>
              <span className={styles.subagentHeadTitle}>{t('remoteSubagentsTitle')}</span>
              <span className={styles.subagentCount}>{t('remoteSubagentsCount', { count: subagents.length })}</span>
            </div>
            {subagents.length === 0 ? (
              <div className={styles.subagentEmpty}>{t('remoteSubagentsEmpty')}</div>
            ) : (
              subagents.map((subagent) => {
                const running = liveById[subagent.id]?.running === true
                return (
                  <button
                    key={subagent.id}
                    type="button"
                    className={styles.subagentRow}
                    aria-label={t('remoteSubagentOpen')}
                    title={subagent.title ?? t('remoteSubagentUntitled')}
                    onClick={() => {
                      // 先关面板再跳（点了就该看得见跳过去了；面板挂在 ⋯ 菜单里时由宿主收起）
                      onNavigate?.()
                      fireAndForget(() => useRemoteStore.getState().openSession(subagent.id))
                    }}
                  >
                    <span className={styles.subagentRowName}>
                      {subagent.title ?? t('remoteSubagentUntitled')}
                    </span>
                    {running ? (
                      <span className={styles.subagentRunning} title={t('liveRunning')} aria-hidden />
                    ) : null}
                  </button>
                )
              })
            )}
          </>
        )}
      </div>
    </div>
  )
}
