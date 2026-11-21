import { useState } from 'react'
import { useTranslate } from '../../../i18n/index.js'
import type { ChatItem } from '../../../services/remote/adapter.js'
import { turnArtifactGroups, type ArtifactGroup } from '../../../services/remote/artifacts.js'
import { IconChevronDownOutline14 } from '../../base/icons.js'
import styles from './Artifacts.module.css'
import { ArtifactChip } from './ArtifactChip.js'
import { IconArtifactsOutline16 } from './artifactsGlyphs.js'

/**
 * 时间线里**一轮回复结束时**挂在它下面的那一块：「本次产出 N 个文件」+ 文件 chips。
 *
 * 三个刻意的决定：
 *
 * 1. **挂载点在这一行的后面**（`RemoteChatView` 的 `items.map` 里 `endIndex === index`
 *    就渲染），所以它天然跟着那一轮的消息走 —— 不吸底、不汇总到别处。
 * 2. **一行摘要默认展开、详情默认收起**：`inlineToggle` 控制 chips 的显示（默认展开，
 *    点一下收成一行标题），`inlineDetail` 是更细的竖排列表（目录 + 新建/修改，默认收起）。
 *    手机上 chips 横向滚动（CSS 里 `nowrap + overflow-x`），不换行挤压正文宽度。
 * 3. **抽不到产物就整块不渲染**（`group === undefined` 直接 `return null`）：
 *    读类工具、失败的写、还在跑的轮都不会长这个面板，页面不会凭空多一行「0 个文件」。
 */
export const ArtifactsInline = ({
  items,
  index,
  streaming,
}: {
  items: readonly ChatItem[]
  /** 当前渲染到的时间线下标（面板挂在这个 item 之后） */
  index: number
  streaming: boolean
}) => {
  // 分组结果在 services 里按「items 引用 + streaming」记忆：这里每行都调用也只是一次查表
  const groups = turnArtifactGroups(items, { streaming })
  const group = groups.find((candidate) => candidate.endIndex === index)
  if (group === undefined) {
    return null
  }
  return <ArtifactsInlinePanel group={group} />
}

const ArtifactsInlinePanel = ({ group }: { group: ArtifactGroup }) => {
  const t = useTranslate()
  // 「这一行」默认展开（chips 可见），「详情」默认收起
  const [open, setOpen] = useState(true)
  const [detail, setDetail] = useState(false)
  const count = group.files.length
  const title =
    count === 1 ? t('artifactsInlineTitleOne') : t('artifactsInlineTitle', { count })

  return (
    <section className={styles.inline} data-open={open} aria-label={title}>
      <div className={styles.inlineHead}>
        <button
          type="button"
          className={styles.inlineToggle}
          aria-expanded={open}
          title={t(open ? 'artifactsInlineCollapse' : 'artifactsInlineExpand')}
          onClick={() => setOpen(!open)}
        >
          <span className={styles.inlineGlyph} aria-hidden>
            <IconArtifactsOutline16 />
          </span>
          <span className={styles.inlineTitle}>{title}</span>
          <span className={styles.inlineChevron} aria-hidden>
            <IconChevronDownOutline14 />
          </span>
        </button>
        <button
          type="button"
          className={styles.inlineDetail}
          aria-expanded={detail}
          onClick={() => setDetail(!detail)}
        >
          {t('artifactsDetail')}
        </button>
      </div>

      {open ? (
        <div className={styles.chips}>
          {group.files.map((file) => (
            <ArtifactChip key={file.path} file={file} />
          ))}
        </div>
      ) : null}

      {detail ? (
        <ul className={styles.detailList}>
          {group.files.map((file) => (
            <li key={`${file.path}:detail`} className={styles.detailRow}>
              <span className={styles.detailName}>{file.name}</span>
              <span className={styles.detailDir}>
                {file.dir.length === 0 ? t('artifactsRootDir') : file.dir}
              </span>
              <span className={styles.detailOrigin}>
                {t(file.origin === 'created' ? 'artifactsOriginCreated' : 'artifactsOriginModified')}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
