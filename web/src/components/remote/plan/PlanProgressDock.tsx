import { useEffect } from 'react'

import { useTranslate } from '../../../i18n/index.js'
import {
  installPlanSync,
  planModeTarget,
  showsPlanEntry,
  showsPlanProgress,
  usePlanState,
} from '../../../services/remote/planState.js'
import { IconPlanOutline } from './planGlyphs.js'
import { PlanPanel } from './PlanPanel.js'
import { TaskProgressCard } from './TaskProgressCard.js'
import styles from './PlanProgressDock.module.css'

/**
 * 会话顶部那条**固定带**（时间线下方、输入框上方，`RemoteChatView` 里只有一个挂载点）。
 *
 * 里面只有两样东西，各自独立判断要不要出现：
 *   1. 「查看计划」入口 —— 只在 **plan 模式生效**时出现（`planState.showsPlanEntry`）；
 *   2. 任务进度卡 —— 只在**有 todo** 时出现（`showsPlanProgress`）。
 *
 * 两样都没有 → 整个组件 `return null`，**不占位**（这条是任务书硬要求：没有任务时整块不渲染）。
 *
 * 为什么在这里调 `installPlanSync()`：`RemoteChatView` 只允许加挂载点，所以「连一条
 * `session/control` 只读投影流」这件事必须由本组件自己负责。它是幂等的，卸载不主动拆
 * （连接生命周期跟着 `store` 的 `phase` 走，见 `planState.ts` 的 `syncNow`）。
 */
export const PlanProgressDock = () => {
  const t = useTranslate()
  const progressVisible = usePlanState(showsPlanProgress)
  const entryVisible = usePlanState(showsPlanEntry)
  const setPanelOpen = usePlanState((state) => state.setPanelOpen)
  const mode = usePlanState((state) => state.mode)
  const planText = usePlanState((state) => state.planText)

  useEffect(() => {
    installPlanSync()
  }, [])

  if (!progressVisible && !entryVisible) return null

  // `pending` 时目标态是取反的（`/plan` 还没落盘）：徽章文案要说清「正在进入」
  const pending = mode?.pending === true
  const target = planModeTarget(mode)
  const entryLabel = pending
    ? t(target ? 'planModeEntering' : 'planModeLeaving')
    : t('planViewOpen')

  return (
    <div className={styles.dock} data-testid="plan-progress-dock">
      {entryVisible ? (
        <button
          type="button"
          className={styles.entry}
          aria-label={t('planViewOpen')}
          aria-haspopup="dialog"
          data-testid="plan-view-entry"
          onClick={() => setPanelOpen(true)}
        >
          <span className={styles.entryIcon} aria-hidden>
            <IconPlanOutline />
          </span>
          <span className={styles.entryLabel}>{entryLabel}</span>
          {planText !== null && planText.heading !== undefined ? (
            <span className={styles.entryHeading} title={planText.heading}>
              {planText.heading}
            </span>
          ) : null}
        </button>
      ) : null}

      {progressVisible ? <TaskProgressCard /> : null}

      {/* 面板自己 portal 到 body：这里只是挂载点，不占布局 */}
      <PlanPanel />
    </div>
  )
}
