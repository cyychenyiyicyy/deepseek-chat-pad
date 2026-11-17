import type { ReactNode } from 'react'

export type TooltipPlacement = 'top' | 'bottom'

/**
 * 悬停提示在触屏设备上没有意义：手指点一下就冒出来一坨说明文字，看起来像 bug。
 *
 * 这里刻意做成空实现——只渲染子元素，不显示任何悬浮描述。
 * 无障碍名称由调用方通过 aria-label 提供（IconButton 会自动用 tooltip 作为 aria-label）。
 * 保留原有 props 签名，避免逐个改动调用点。
 */
export const Tooltip = ({
  children,
}: {
  content?: ReactNode
  placement?: TooltipPlacement
  children: ReactNode
}) => <>{children}</>
