import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import type { ApprovalOutcome } from '../../services/remote/adapter.js'
import { Button } from '../base/Button.js'
import { IconCheckOutline16, IconWarningOutline16 } from '../base/icons.js'
import {
  approvalAllowIsDanger,
  approvalNeedsConfirm,
  approvalStatusOf,
  type ApprovalDecision,
  type ApprovalRisk,
  type ApprovalTarget,
} from './chat-controls/promptModel.js'
import styles from './ApprovalCard.module.css'

/**
 * 审批卡片（权限允许）：Host 要执行一次工具调用，必须由人点「允许一次 / 拒绝」。
 *
 * 三条硬约束（`input-B-rpc-surface.md` §2.6）：
 *   1. **只有两种决定**：`allow_once` / `deny`；v1 禁止 `allow_session`（session grant），
 *      Host 就算给了这类选项也不渲染（`approvalAllowsOnce`）。
 *   2. **一次只应答一次**：点完按钮立刻禁用，等 `respondApproval` 回来；
 *      重复提交只会换来 `PERMISSION_NOT_PENDING`，把「已允许」覆盖成「已失效」。
 *   3. **危险操作二次确认**：写 / 删 / 外网先点一下变成「确认允许」，再点才发出去。
 *
 * 卡片是纯展示组件：决定值交给调用方（`RemoteChatView` → `respondApproval(eventId, …)`），
 * 这里不碰 `services/**`，数据层改错误码不会连带改界面。
 */

/** 二次确认的有效窗口：超时收回，免得「上一次点的确认状态」留着给别人误按。 */
const CONFIRM_WINDOW_MS = 10_000

export const ApprovalCard = ({
  toolName,
  target,
  reason,
  risk,
  outcome,
  allowsOnce = true,
  onAllow,
  onReject,
}: {
  /** 工具名（Host 给的原名或展示名） */
  toolName: string
  /** 「要做什么」：命令原文 / 文件路径 / URL（已按类型裁剪） */
  target?: ApprovalTarget
  /** Host 给的理由（可能是「运行命令」这种一句话） */
  reason?: string
  /** 风险档位，决定语气与按钮颜色 */
  risk: ApprovalRisk
  /** 终态：有值就不再可点（allowed-once / rejected / cancelled / unavailable） */
  outcome?: ApprovalOutcome
  /** Host 是否允许「允许一次」（false 时只留拒绝，绝不偷偷升级成 session 授权） */
  allowsOnce?: boolean
  onAllow: () => void | Promise<void>
  onReject: () => void | Promise<void>
}) => {
  const t = useTranslate()
  const status = approvalStatusOf(outcome)
  const interactive = status === 'pending'

  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)

  // 终态一到就收起「确认」状态：卡片已经不能点了，别把危险外观留着
  useEffect(() => {
    if (!interactive) setArmed(false)
  }, [interactive])

  useEffect(() => {
    if (!armed) return undefined
    const timer = window.setTimeout(() => setArmed(false), CONFIRM_WINDOW_MS)
    return () => window.clearTimeout(timer)
  }, [armed])

  const decide = async (decision: ApprovalDecision): Promise<void> => {
    if (!interactive || busy) return
    setBusy(true)
    try {
      await (decision === 'deny' ? onReject() : onAllow())
    } finally {
      setBusy(false)
      setArmed(false)
    }
  }

  const confirmFirst = interactive && approvalNeedsConfirm(risk)
  /*
   * 允许按钮的颜色：删除类**一直**红（它本身就是不可撤销的）；
   * 写 / 外网 / 说不清只在「确认」那一下变红 —— 平时用主色，别把每个写操作都画成事故。
   */
  const dangerAllow = risk === 'delete' || (armed && approvalAllowIsDanger(risk))

  const riskText =
    risk === 'delete'
      ? t('promptuxApprovalRiskDelete')
      : risk === 'write'
        ? t('promptuxApprovalRiskWrite')
        : risk === 'network'
          ? t('promptuxApprovalRiskNetwork')
          : risk === 'read'
            ? t('promptuxApprovalRiskRead')
            : t('promptuxApprovalRiskUnknown')

  const riskTone =
    risk === 'delete'
      ? styles.riskDelete
      : risk === 'write'
        ? styles.riskWrite
        : risk === 'network'
          ? styles.riskNetwork
          : risk === 'read'
            ? styles.riskRead
            : styles.riskUnknown

  const statusText =
    status === 'allowed'
      ? t('promptuxApprovalAllowedOnce')
      : status === 'rejected'
        ? t('promptuxApprovalRejected')
        : status === 'cancelled'
          ? t('promptuxApprovalCancelled')
          : status === 'expired'
            ? t('promptuxApprovalExpired')
            : undefined

  const allowLabel = armed
    ? t('promptuxApprovalConfirm')
    : busy
      ? t('promptuxApprovalBusy')
      : t('promptuxApprovalAllow')

  return (
    <div
      className={styles.card}
      role="group"
      aria-label={t('promptuxApprovalTitle')}
      data-status={status}
      data-risk={risk}
    >
      <div className={styles.head}>
        <span className={status === 'pending' ? styles.icon : styles.iconMuted} aria-hidden>
          <IconWarningOutline16 />
        </span>
        <div className={styles.headCopy}>
          <div className={styles.title}>{t('promptuxApprovalTitle')}</div>
          <div className={styles.toolRow}>
            <span className={styles.toolPill}>{toolName}</span>
            {allowsOnce ? null : <span className={styles.toolNote}>{t('promptuxApprovalOnlyDeny')}</span>}
          </div>
        </div>
        {statusText === undefined ? (
          <span className={styles.statusPending}>{t('promptuxApprovalPending')}</span>
        ) : (
          <span
            className={status === 'rejected' || status === 'expired' ? styles.statusDead : styles.statusDone}
            role="status"
          >
            {status === 'allowed' ? <IconCheckOutline16 /> : <IconWarningOutline16 />}
            {statusText}
          </span>
        )}
      </div>

      {target === undefined ? (
        <div className={styles.noTarget}>{t('promptuxApprovalNoTarget')}</div>
      ) : (
        <div className={styles.targetBlock}>
          <div className={styles.targetLabel}>
            {target.kind === 'command'
              ? t('promptuxApprovalTargetCommand')
              : target.kind === 'path'
                ? t('promptuxApprovalTargetPath')
                : target.kind === 'url'
                  ? t('promptuxApprovalTargetUrl')
                  : t('promptuxApprovalTargetText')}
          </div>
          <pre className={target.format === 'code' ? styles.targetCode : styles.targetText}>{target.text}</pre>
          {target.truncated ? <div className={styles.truncated}>{t('promptuxApprovalTruncated')}</div> : null}
        </div>
      )}

      {reason === undefined || reason.trim().length === 0 ? null : (
        <div className={styles.reason}>{reason}</div>
      )}

      {status === 'pending' ? <div className={riskTone}>{riskText}</div> : null}
      {status === 'expired' ? (
        <div className={styles.expiredHint}>{t('promptuxApprovalExpiredHint')}</div>
      ) : null}

      <div className={styles.actions}>
        <Button
          variant="outlined"
          size="m"
          className={styles.button}
          disabled={!interactive || busy}
          onClick={() => void decide('deny')}
        >
          {t('promptuxApprovalDeny')}
        </Button>
        {allowsOnce ? (
          <Button
            variant={dangerAllow ? 'danger' : 'primary'}
            size="m"
            className={styles.button}
            disabled={!interactive || busy}
            aria-live={armed ? 'polite' : undefined}
            onClick={() => {
              // 危险操作第一次点击只「上膛」：把手挪到同一个按钮再点一次才真的执行
              if (confirmFirst && !armed) {
                setArmed(true)
                return
              }
              void decide('allow_once')
            }}
          >
            {confirmFirst && armed ? t('promptuxApprovalConfirm') : allowLabel}
          </Button>
        ) : null}
      </div>
      {confirmFirst && armed ? <div className={styles.armedHint}>{t('promptuxApprovalConfirmHint')}</div> : null}
    </div>
  )
}
