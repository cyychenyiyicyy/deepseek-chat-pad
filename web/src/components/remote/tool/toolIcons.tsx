/**
 * 工具类别图标。
 *
 * 两条来源，都为了一件事：**不引图标库**。
 *
 * 1. 直接复用官方 DSH 图标数据 —— `ds-harness-remote/packages/app-core/src/ui/
 *    official-menu-icon-data.ts` 里的 `referenceFile` / `edit` / `plan` 三份 artwork
 *    （与仓库 `components/base/icons.tsx` 同一套 16×16、1px 描边的官方图形语言）。
 * 2. 官方数据里没有的四类（终端、放大镜、地球、分支）按同一网格手绘：
 *    viewBox 16×16、stroke-width 1、`currentColor`，视觉重量和 1 保持一致。
 *
 * 为什么是数据表 + 一个渲染器，而不是十个 React 组件：与上游 `official-menu-icons.tsx`
 * 同样的理由 —— 新增类别只加一条数据，渲染逻辑（viewBox / 描边色 / 填充色）只有一处。
 */

/** 一段图形：`d` 必有；`stroke`/`fill` 为 `currentColor` 时跟随外层颜色。 */
interface ArtworkPath {
  d: string
  stroke?: 'currentColor'
  fill?: 'currentColor'
}

interface Artwork {
  viewBox: string
  strokeWidth: number
  paths: readonly ArtworkPath[]
}

/**
 * 官方 artwork（`referenceFile` / `edit` / `plan`）逐字节取自
 * `official-menu-icon-data.ts`；许可见该文件头部与 `docs/official-menu-icons.md`。
 */
const ARTWORK = {
  /** 读文件：带两行文字的纸张 */
  file: {
    viewBox: '0 0 16 16',
    strokeWidth: 1,
    paths: [
      { d: 'M4.9375 5.90295H11.0625', stroke: 'currentColor' },
      { d: 'M4.9375 9.02991H8.27841', stroke: 'currentColor' },
      {
        d: 'M12.5 1.32617C13.3039 1.32617 14 1.95171 14 2.77637V13.2246C13.9996 14.0489 13.3036 14.6738 12.5 14.6738H3.5C2.69637 14.6738 2.00042 14.0489 2 13.2246V2.77637C2 1.95171 2.69613 1.32617 3.5 1.32617H12.5ZM3.5 2.32617C3.1993 2.32617 3 2.55186 3 2.77637V13.2246C3.00044 13.4489 3.19963 13.6738 3.5 13.6738H12.5C12.8004 13.6738 12.9996 13.4489 13 13.2246V2.77637C13 2.55186 12.8007 2.32617 12.5 2.32617H3.5Z',
        fill: 'currentColor',
      },
    ],
  },
  /** 编辑：纸上的一支笔 */
  edit: {
    viewBox: '0 0 16 16',
    strokeWidth: 1,
    paths: [
      {
        d: 'M8.85596 2.69971H4.19971C3.37141 2.69971 2.69992 3.37146 2.69971 4.19971V11.8003C2.69992 12.6285 3.37141 13.3003 4.19971 13.3003H11.8003C12.6283 13.2999 13.3001 12.6283 13.3003 11.8003V7.89893H14.3003V11.8003C14.3001 13.1806 13.1806 14.2999 11.8003 14.3003H4.19971C2.81913 14.3003 1.69992 13.1808 1.69971 11.8003V4.19971C1.69992 2.81918 2.81913 1.69971 4.19971 1.69971H8.85596V2.69971Z',
        fill: 'currentColor',
      },
      { d: 'M7.7849 8.23878L13.888 2.13574', stroke: 'currentColor' },
    ],
  },
  /** 任务 / 待办：带勾选与笔的计划纸 */
  plan: {
    viewBox: '0 0 16 16',
    strokeWidth: 1,
    paths: [
      { d: 'M4.9375 5.90295H11.0625', stroke: 'currentColor' },
      { d: 'M4.9375 9.02991H8.27841', stroke: 'currentColor' },
      {
        d: 'M12.5 1.32617C13.3039 1.32617 14 1.95171 14 2.77637V7.61328L13 8.68164V2.77637C13 2.55186 12.8007 2.32617 12.5 2.32617H3.5C3.1993 2.32617 3 2.55186 3 2.77637V13.2246C3.00044 13.4489 3.19963 13.6738 3.5 13.6738H8.32812L7.39258 14.6738H3.5C2.69637 14.6738 2.00042 14.0489 2 13.2246V2.77637C2 1.95171 2.69613 1.32617 3.5 1.32617H12.5Z',
        fill: 'currentColor',
      },
      {
        d: 'M8.97212 14.3693C9.17511 14.5723 9.37811 14.7753 9.5811 14.9783C9.67012 14.8953 9.75914 14.8123 9.84815 14.7293C11.4505 13.2352 13.0528 11.7411 14.6551 10.247C14.7441 10.164 14.8331 10.081 14.9221 9.99803C14.5989 9.6748 14.2756 9.35157 13.9524 9.02834C13.8694 9.11736 13.7864 9.20637 13.7034 9.29539C12.2093 10.8977 10.7152 12.5 9.22113 14.1023C9.13813 14.1913 9.05513 14.2803 8.97212 14.3693Z',
        fill: 'currentColor',
      },
      {
        d: 'M11.6323 13.7841C11.6323 14.0395 11.6323 14.295 11.6323 14.5504C11.6812 14.5523 11.7301 14.5543 11.779 14.5562C12.659 14.5913 13.539 14.6263 14.419 14.6614C14.4679 14.6633 14.5168 14.6653 14.5657 14.6672C14.5657 14.3339 14.5657 14.0006 14.5657 13.6672C14.5168 13.6692 14.4679 13.6711 14.419 13.6731C13.539 13.7081 12.659 13.7432 11.779 13.7783C11.7301 13.7802 11.6812 13.7821 11.6323 13.7841Z',
        fill: 'currentColor',
      },
    ],
  },
  /** 写文件：`file` 的纸张轮廓 + 中间一个加号（手绘，复用官方轮廓） */
  write: {
    viewBox: '0 0 16 16',
    strokeWidth: 1,
    paths: [
      {
        d: 'M12.5 1.32617C13.3039 1.32617 14 1.95171 14 2.77637V13.2246C13.9996 14.0489 13.3036 14.6738 12.5 14.6738H3.5C2.69637 14.6738 2.00042 14.0489 2 13.2246V2.77637C2 1.95171 2.69613 1.32617 3.5 1.32617H12.5ZM3.5 2.32617C3.1993 2.32617 3 2.55186 3 2.77637V13.2246C3.00044 13.4489 3.19963 13.6738 3.5 13.6738H12.5C12.8004 13.6738 12.9996 13.4489 13 13.2246V2.77637C13 2.55186 12.8007 2.32617 12.5 2.32617H3.5Z',
        fill: 'currentColor',
      },
      {
        d: 'M7.5 5.4C7.78 5.4 8 5.62 8 5.9V7.4H9.5C9.78 7.4 10 7.62 10 7.9C10 8.18 9.78 8.4 9.5 8.4H8V9.9C8 10.18 7.78 10.4 7.5 10.4C7.22 10.4 7 10.18 7 9.9V8.4H5.5C5.22 8.4 5 8.18 5 7.9C5 7.62 5.22 7.4 5.5 7.4H7V5.9C7 5.62 7.22 5.4 7.5 5.4Z',
        fill: 'currentColor',
      },
    ],
  },
  /** 终端：圆角窗口 + `>` 提示符 + 一条输出线（手绘） */
  shell: {
    viewBox: '0 0 16 16',
    strokeWidth: 1,
    paths: [
      {
        d: 'M3 2C2.17 2 1.5 2.67 1.5 3.5V12.5C1.5 13.33 2.17 14 3 14H13C13.83 14 14.5 13.33 14.5 12.5V3.5C14.5 2.67 13.83 2 13 2H3Z',
        stroke: 'currentColor',
      },
      { d: 'M4.4 6.1L6.3 8L4.4 9.9', stroke: 'currentColor' },
      { d: 'M8 10.2H11.4', stroke: 'currentColor' },
    ],
  },
  /** 搜索：放大镜（手绘） */
  search: {
    viewBox: '0 0 16 16',
    strokeWidth: 1,
    paths: [
      {
        d: 'M7.2 2.2C9.96 2.2 12.2 4.44 12.2 7.2C12.2 9.96 9.96 12.2 7.2 12.2C4.44 12.2 2.2 9.96 2.2 7.2C2.2 4.44 4.44 2.2 7.2 2.2Z',
        stroke: 'currentColor',
      },
      { d: 'M10.7 10.7L14.1 14.1', stroke: 'currentColor' },
    ],
  },
  /** 联网：地球（手绘） */
  web: {
    viewBox: '0 0 16 16',
    strokeWidth: 1,
    paths: [
      {
        d: 'M8 1.5C11.59 1.5 14.5 4.41 14.5 8C14.5 11.59 11.59 14.5 8 14.5C4.41 14.5 1.5 11.59 1.5 8C1.5 4.41 4.41 1.5 8 1.5Z',
        stroke: 'currentColor',
      },
      {
        d: 'M8 1.5C9.9 3.35 10.9 5.5 10.9 8C10.9 10.5 9.9 12.65 8 14.5C6.1 12.65 5.1 10.5 5.1 8C5.1 5.5 6.1 3.35 8 1.5Z',
        stroke: 'currentColor',
      },
      { d: 'M1.9 8H14.1', stroke: 'currentColor' },
    ],
  },
  /** 子代理：一条主干分出一个子节点（手绘） */
  agent: {
    viewBox: '0 0 16 16',
    strokeWidth: 1,
    paths: [
      { d: 'M4 4.2V11.8', stroke: 'currentColor' },
      { d: 'M5.2 7H10.8', stroke: 'currentColor' },
      {
        d: 'M4 1.8C4.66 1.8 5.2 2.34 5.2 3C5.2 3.66 4.66 4.2 4 4.2C3.34 4.2 2.8 3.66 2.8 3C2.8 2.34 3.34 1.8 4 1.8Z',
        fill: 'currentColor',
      },
      {
        d: 'M4 9.8C4.66 9.8 5.2 10.34 5.2 11C5.2 11.66 4.66 12.2 4 12.2C3.34 12.2 2.8 11.66 2.8 11C2.8 10.34 3.34 9.8 4 9.8Z',
        fill: 'currentColor',
      },
      {
        d: 'M12 5.8C12.66 5.8 13.2 6.34 13.2 7C13.2 7.66 12.66 8.2 12 8.2C11.34 8.2 10.8 7.66 10.8 7C10.8 6.34 11.34 5.8 12 5.8Z',
        fill: 'currentColor',
      },
    ],
  },
  /** 其他（MCP / 未知工具）：一枚四角星，中性的“一次动作” */
  other: {
    viewBox: '0 0 16 16',
    strokeWidth: 1,
    paths: [
      {
        d: 'M8 2.1C8.95 5.35 10.65 7.05 13.9 8C10.65 8.95 8.95 10.65 8 13.9C7.05 10.65 5.35 8.95 2.1 8C5.35 7.05 7.05 5.35 8 2.1Z',
        stroke: 'currentColor',
      },
    ],
  },
  /** 读图片：山与太阳（手绘） */
  image: {
    viewBox: '0 0 16 16',
    strokeWidth: 1,
    paths: [
      {
        d: 'M4 2C3.17 2 2.5 2.67 2.5 3.5V12.5C2.5 13.33 3.17 14 4 14H12C12.83 14 13.5 13.33 13.5 12.5V3.5C13.5 2.67 12.83 2 12 2H4Z',
        stroke: 'currentColor',
      },
      { d: 'M2.9 11.6L6.3 7.9L9.2 11L10.8 9.2L13.1 11.6', stroke: 'currentColor' },
      {
        d: 'M10.9 5.4C10.9 5.98 10.43 6.45 9.85 6.45C9.27 6.45 8.8 5.98 8.8 5.4C8.8 4.82 9.27 4.35 9.85 4.35C10.43 4.35 10.9 4.82 10.9 5.4Z',
        fill: 'currentColor',
      },
    ],
  },
} as const satisfies Record<string, Artwork>

export type ToolIconKind = keyof typeof ARTWORK

/**
 * 兜底：未知 kind 不漏渲染（而不是画一个空白方块）。
 * 每个 kind 都显式列出来，新增 `ToolKind` 时这里会报缺项。
 */
export const iconKindFor = (kind: string): ToolIconKind =>
  Object.hasOwn(ARTWORK, kind) ? (kind as ToolIconKind) : 'other'

/** 一个类别图标。尺寸默认 16，颜色跟随 `currentColor`（由卡片的 CSS 决定）。 */
export const ToolIcon = ({ kind, size = 16 }: { kind: ToolIconKind; size?: number }) => {
  const artwork: Artwork = ARTWORK[kind]
  return (
    <svg
      width={size}
      height={size}
      viewBox={artwork.viewBox}
      fill="none"
      strokeWidth={artwork.strokeWidth}
      aria-hidden="true"
      focusable="false"
    >
      {artwork.paths.map((path, index) => (
        <path
          key={index}
          d={path.d}
          {...(path.stroke === undefined ? {} : { stroke: 'currentColor' })}
          {...(path.fill === undefined ? {} : { fill: 'currentColor' })}
        />
      ))}
    </svg>
  )
}
