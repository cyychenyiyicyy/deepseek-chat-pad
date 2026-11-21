/**
 * 计划 / 任务进度这几个小图标。
 *
 * 为什么不复用 `components/base/icons.tsx`：那份是**产品图标集**（发送、附件、设置…），
 * 里面没有清单 / 计划这类语义图标；而这里要的是三态圆点（空心 / 转圈 / 打勾），
 * 与官方 `StateDot` 的视觉语义一一对应，自己画两个 path 比往公共图标表里塞更干净。
 *
 * 全部为 `currentColor`，颜色由外面的 CSS 决定（亮/暗主题各一套 token）。
 */

/** 清单（进度卡标题前的引导图标）。 */
export const IconChecklistOutline = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden focusable="false">
    <path
      d="M6 4.5h6.5M6 8h6.5M6 11.5h4"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
    />
    <path
      d="M2.6 4.2l.9.9 1.5-1.7"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle cx="3.4" cy="8" r=".8" fill="currentColor" />
    <circle cx="3.4" cy="11.5" r=".8" fill="currentColor" />
  </svg>
)

/** 计划文档（「查看计划」入口 / 面板标题）。 */
export const IconPlanOutline = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden focusable="false">
    <path
      d="M3.5 2.5h5.2L12.5 6v7.5a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1Z"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinejoin="round"
    />
    <path d="M8.5 2.7V6h3.6" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    <path d="M5.3 9h5.4M5.3 11.4h3.4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
  </svg>
)

/**
 * 一条待办的状态标记（与官方 `StateDot appearance="step"` 同一套语义）：
 *   - `completed`：实心圆 + 勾
 *   - `in_progress`：缺口圆环，**CSS 里转圈**（`animation: plan-spin`）
 *   - `pending`：空心圆环
 *
 * `-` 号那个 `aria-hidden` 由调用方控制：状态还有文字标签一起读，图标本身不重复播报。
 */
export const TodoGlyph = ({
  status,
  spinClassName,
}: {
  status: 'pending' | 'in_progress' | 'completed'
  /** 转圈动画的类名由调用方给（CSS Modules 的哈希类没法在这里写死）。 */
  spinClassName?: string
}) => {
  if (status === 'completed') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden focusable="false">
        <circle cx="8" cy="8" r="7" fill="currentColor" />
        <path
          d="M4.9 8.2l2.1 2.1 4.1-4.4"
          stroke="var(--dsw-alias-label-primary-foreground)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  if (status === 'in_progress') {
    return (
      <svg
        className={spinClassName}
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden
        focusable="false"
      >
        <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.8" opacity="0.22" />
        <circle
          cx="8"
          cy="8"
          r="6.2"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeDasharray="10 30"
        />
      </svg>
    )
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden focusable="false">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}
