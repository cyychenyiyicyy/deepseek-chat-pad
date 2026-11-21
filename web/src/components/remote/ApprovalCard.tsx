import { useTranslate } from '../../i18n/index.js'
import { IconWarningOutline16 } from '../base/icons.js'
import { Button } from '../base/Button.js'
import styles from './ApprovalCard.module.css'

/**
 * 审批卡片：远端 Host 要执行一次工具调用，必须由人来点「允许一次 / 拒绝」。
 *
 * 纯展示组件 —— 决定值由调用方（`RemoteChatView`）映射到数据层的
 * `respondApproval(eventId, decision)`，这里不碰 `services/**`，
 * 也就不会因为数据层的错误码/枚举调整而连带改界面。
 */
export const ApprovalCard = ({
  title,
  detail,
  busy = false,
  onAllow,
  onReject,
}: {
  title: string
  detail?: string
  /** 数据层仍在处理上一条决定时禁用按钮，避免重复应答 */
  busy?: boolean
  onAllow: () => void
  onReject: () => void
}) => {
  const t = useTranslate()
  return (
    <div className={styles.card} role="group" aria-label={title}>
      <div className={styles.head}>
        <span className={styles.icon}>
          <IconWarningOutline16 />
        </span>
        <div className={styles.title}>{title}</div>
      </div>
      {detail ? <div className={styles.detail}>{detail}</div> : null}
      <div className={styles.actions}>
        <Button variant="outlined" size="m" disabled={busy} onClick={onReject}>
          {t('remoteApprovalReject')}
        </Button>
        <Button variant="primary" size="m" disabled={busy} onClick={onAllow}>
          {t('remoteApprovalAllowOnce')}
        </Button>
      </div>
    </div>
  )
}
