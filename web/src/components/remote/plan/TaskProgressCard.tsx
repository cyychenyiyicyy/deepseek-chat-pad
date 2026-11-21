import clsx from 'clsx'
import { memo, useState } from 'react'

import { useTranslate } from '../../../i18n/index.js'
import {
  activePlanTodo,
  planProgressOf,
  planProgressRatio,
  usePlanState,
  type PlanTodo,
  type PlanTodoStatus,
} from '../../../services/remote/planState.js'
import { IconChevronDownOutline14, IconChevronRightOutline14 } from '../../base/icons.js'
import { IconChecklistOutline, TodoGlyph } from './planGlyphs.js'
import styles from './TaskProgressCard.module.css'

/**
 * 任务进度卡（会话顶部固定带里的那一块）。
 *
 * 数据：`session/control` 投影 `values.todos`（整表替换、最后一条生效），见 `planState.ts` 的调研表。
 *
 * ## 两种形态
 *
 * - **折叠**（默认）：一行 `任务进度 3/7 · 正在做：改输入区`，下面一条 3px 的进度条；
 * - **展开**：逐条列出，完成打勾 / 进行中转圈并高亮 / 待办灰；每条**可以再点开**
 *   看完整描述与状态（服务端只给 `content`，没有独立描述字段，所以点开 = 取消两行截断
 *   + 补一行「第 N 步 · 状态」）。
 *
 * ## 三条纪律
 *
 * 1. **没有 todo 就整块不渲染**（父组件已经用 `showsPlanProgress` 挡过一次，这里再兜一次）；
 * 2. **不自动展开**：折叠状态是用户的选择，落 `localStorage`（`planState` 的 `setCollapsed`），
 *    新 todo 到达、进度变化都不会把它弹开；
 * 3. **不闪不跳**：进度条宽度走 CSS `transition`，列表 key 用 `序号:内容`（状态变化不重建行）。
 */

/** 状态 → 文案 key（与官方 `todo.status.*` 一一对应）。 */
const STATUS_KEY = {
  completed: 'planProgressStatusDone',
  in_progress: 'planProgressStatusActive',
  pending: 'planProgressStatusPending',
} as const

/** 状态 → 图标颜色档（CSS 里按 `data-status` 走）。 */
const statusKeyOf = (status: PlanTodoStatus) => STATUS_KEY[status]

export const TaskProgressCard = memo(function TaskProgressCard() {
  const t = useTranslate()
  const todos = usePlanState((state) => state.todos)
  const collapsed = usePlanState((state) => state.collapsed)
  const setCollapsed = usePlanState((state) => state.setCollapsed)
  const todosSource = usePlanState((state) => state.todosSource)
  /** 展开到哪一条（点开看描述）；同一时刻只留一条，视觉上不打架 */
  const [openIndex, setOpenIndex] = useState<number | null>(null)

  if (todos.length === 0) return null

  const progress = planProgressOf(todos)
  const active = activePlanTodo(todos)
  const ratio = planProgressRatio(progress)
  const allDone = progress.done === progress.total

  /*
   * 折叠态第二段：优先「正在做：xxx」（并行的计划可能有好几条，这里只点名第一条，
   * 展开后能看到全部 —— 与官方 `planSummary()` 的处理一致）；没有进行中的就说清是哪种状态。
   */
  const nowText =
    active !== null
      ? t('planProgressNow', { text: active.content })
      : allDone
        ? t('planProgressAllDone')
        : t('planProgressIdle')

  return (
    <section
      className={styles.card}
      aria-label={t('planProgressTitle')}
      data-testid="plan-progress-card"
      data-todo-source={todosSource ?? 'none'}
    >
      <button
        type="button"
        className={styles.header}
        aria-expanded={!collapsed}
        aria-label={collapsed ? t('planProgressExpand') : t('planProgressCollapse')}
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className={styles.lead} aria-hidden>
          <IconChecklistOutline />
        </span>
        <span className={styles.title}>{t('planProgressTitle')}</span>
        <span className={styles.count}>{progress.text}</span>
        <span className={styles.sep} aria-hidden>
          ·
        </span>
        <span className={styles.now} title={nowText}>
          {nowText}
        </span>
        <span className={styles.chevron} aria-hidden>
          {collapsed ? <IconChevronRightOutline14 /> : <IconChevronDownOutline14 />}
        </span>
      </button>

      {/* 进度条：折叠态也在，宽度变化走 transition（不闪、不跳） */}
      <div className={styles.track} role="presentation">
        <div
          className={clsx(styles.fill, allDone && styles.fillDone)}
          style={{ width: `${Math.round(ratio * 1000) / 10}%` }}
        />
      </div>

      {collapsed ? null : (
        <ul className={styles.list}>
          {todos.map((todo, index) => (
            <TodoRow
              key={`${index}:${todo.content}`}
              todo={todo}
              index={index}
              total={todos.length}
              open={openIndex === index}
              onToggle={() => setOpenIndex((current) => (current === index ? null : index))}
            />
          ))}
        </ul>
      )}
    </section>
  )
})

const TodoRow = ({
  todo,
  index,
  total,
  open,
  onToggle,
}: {
  todo: PlanTodo
  index: number
  total: number
  open: boolean
  onToggle: () => void
}) => {
  const t = useTranslate()
  const status = t(statusKeyOf(todo.status))
  return (
    <li className={styles.item} data-status={todo.status} data-open={open ? '1' : '0'}>
      <button
        type="button"
        className={styles.itemButton}
        aria-expanded={open}
        aria-label={`${todo.content} · ${status}`}
        onClick={onToggle}
      >
        <span className={styles.glyph} role="img" aria-label={status}>
          <TodoGlyph status={todo.status} spinClassName={styles.spin} />
        </span>
        <span className={styles.itemText}>{todo.content}</span>
      </button>
      {open ? (
        <p className={styles.itemDetail}>
          {t('planProgressItemStep', { index: index + 1, total, status })}
        </p>
      ) : null}
    </li>
  )
}
