/**
 * 交付文件面板用的小图标（16px 线框，颜色跟 `currentColor`）。
 *
 * 为什么不放进 `components/base/icons.tsx`：那个文件是所有界面的公共图标表，
 * 这一次只新增交付文件（R12）要用的两个，放在自己的目录里，
 * 别人的图标改动就不会跟这里抢同一份文件。
 */

/** 交付文件：两张叠起来的纸（「这次跑完之后给你的东西」）。 */
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

/** 文件已不存在：一张纸 + 一道斜杠。 */
export const IconMissingFileOutline14 = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
    <path
      d="M5.2 2.1h3.1L10.6 4.3v3.4M8.6 11.4H5.2a.9.9 0 0 1-.9-.9V3a.9.9 0 0 1 .9-.9"
      stroke="currentColor"
      strokeWidth="1.15"
      strokeLinejoin="round"
      strokeLinecap="round"
    />
    <path d="M2 2l10 10" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" />
  </svg>
)
