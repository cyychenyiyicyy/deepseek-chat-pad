import { useTranslate } from '../../../i18n/index.js'
import {
  modelDisplayName,
  permissionDisplayName,
  useChatControls,
} from '../../../services/remote/sessionControls.js'
import styles from './Controls.module.css'
import { formatTokens } from './usage.js'
import type { RemoteUsage } from '../../../services/remote/sessionControls.js'

/**
 * 「会话信息」面板：标题 / 会话 id / 模型 / 权限预设 / 排队条数 / 用量。
 *
 * 数据来源分工写清楚（避免「怎么和别处显示的不一样」这类问题）：
 *  - 标题、模型、权限、队列、`usage` 投影 → `sessionControls` 的 store（`session/control` 投影）；
 *  - 用量兜底 → 调用方传进来的 `usage`（时间线汇总），投影没有时才用它。
 *
 * 这里全是只读展示，不做任何 RPC。
 */
export const SessionInfoPanel = ({
  sessionId,
  title,
  usage,
}: {
  sessionId: string | null
  title: string | null
  /** 时间线汇总出来的用量（投影没给 `usage` 时用它） */
  usage: RemoteUsage | null
}) => {
  const t = useTranslate()
  const catalog = useChatControls((state) => state.modelCatalog)
  const currentModel = useChatControls((state) => state.currentModel)
  const permissions = useChatControls((state) => state.permissions)
  const currentPermission = useChatControls((state) => state.currentPermission)
  const queue = useChatControls((state) => state.queue)
  const projectionUsage = useChatControls((state) => state.usage)

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
      </div>
    </div>
  )
}
