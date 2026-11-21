/**
 * 产物卡用的图标（16px / 14px 线框，颜色跟 `currentColor`）。
 *
 * 为什么不放进 `components/base/icons.tsx`：那是所有界面的公共图标表，
 * 这次只新增产物卡要用的几枚，放在自己的目录里，别人的图标改动就不会跟这里抢同一份文件。
 */

/** 产物：两张叠起来的纸（「这一轮交给你的东西」）。 */
export const IconArtifactsOutline16 = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
    <path
      d="M6.1 2.4h3.9L12.6 5v6.1a1 1 0 0 1-1 1H6.1a1 1 0 0 1-1-1V3.4a1 1 0 0 1 1-1Z"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinejoin="round"
    />
    <path d="M9.9 2.5V5.1h2.6" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    <path
      d="M3.4 5.3a1 1 0 0 0-1 1v6.3a1 1 0 0 0 1 1h5.2"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinejoin="round"
      strokeLinecap="round"
    />
  </svg>
)

/** 外链：方框里一支箭头（点开走浏览器）。 */
export const IconExternalLinkOutline14 = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
    <path d="M8.4 2.2h3.4v3.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M11.6 2.4 6.6 7.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    <path
      d="M11.2 8.6v2.4a.8.8 0 0 1-.8.8H3a.8.8 0 0 1-.8-.8V3.6A.8.8 0 0 1 3 2.8h2.4"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)
