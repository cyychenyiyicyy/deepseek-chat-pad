import { useState } from 'react'
import { useTranslate } from '../../../i18n/index.js'
import {
  artifactGroupAtIndex,
  hasHiddenArtifacts,
  visibleArtifactFiles,
  type ArtifactFile,
  type TurnArtifacts,
} from '../../../services/remote/artifacts.js'
import { FileIcon } from '../../files/FileIcon.js'
import styles from './Artifact.module.css'
import { IconArtifactsOutline16, IconExternalLinkOutline14 } from './artifactGlyphs.js'
import { openArtifactFile } from './artifactOpen.js'

/**
 * 一轮结束时的**产物卡** —— 官方 `present` 交付的文件，长在这一轮消息下方。
 *
 * 结构照搬官方 Web 客户端（`@deepseek-ai/dsh-client-ui-deliverables/src/client/Deliverables.tsx`）
 * 与 dsh-Go（`app/lib/ui/chat/widgets/artifact_card.dart:30-41` 的注释里那张 ASCII 图）：
 *
 * ```
 * ┌──────────────────────────────────────┐
 * │ ▣ 交付了 3 个文件                     │
 * │ [▦] 季度销售报告.pdf                 │
 * │     季度汇总                          │
 * │ [▤] trend.png                        │
 * │     PNG                               │
 * │ 全部 6 个文件 ⌄                       │
 * └──────────────────────────────────────┘
 * ```
 *
 * 三个刻意的决定：
 *
 * 1. **只画官方的 `present` 交付**。从 `write` / `edit` 参数里猜产物的那套（R12）已删除：
 *    DSH 本来就有产物产出，猜出来的东西和原生机制必然对不上。
 * 2. **收起阈值 4**，与官方 `COLLAPSED_PRESENTED_COUNT = 4`（`Deliverables.tsx:20`）
 *    和 dsh-Go `ArtifactCard.shownCount = 4`（`artifact_card.dart:52`）一致；
 *    「全部 N 个」就是**会话级清单的入口**，不再单独做一套目录。
 * 3. **没有产物就不渲染**（`group === undefined` 直接 `null`）：读类工具、失败的
 *    `present`、还没结束的轮都不会长这个卡片。
 */

/** 挂载点：`items[index]` 是这一轮最后一行可见内容时，把这一轮的产物卡画在它下面。 */
export const ArtifactTurnTail = ({
  index,
  groups,
}: {
  /** 当前渲染到的时间线下标。 */
  index: number
  /** 已经算好的分组（`turnArtifactsOf(items)`）；时间线多条行共用一次计算结果。 */
  groups: readonly TurnArtifacts[]
}) => {
  const group = artifactGroupAtIndex(groups, index)
  return group === undefined ? null : <ArtifactCard group={group} />
}

/** 一张产物卡（时间线里 / 测试里都直接用这个）。 */
export const ArtifactCard = ({ group }: { group: TurnArtifacts }) => {
  const t = useTranslate()
  const [expanded, setExpanded] = useState(false)
  const files = group.files
  const collapsible = hasHiddenArtifacts(files)
  const shown = visibleArtifactFiles(files, expanded)
  const title = files.length === 1 ? t('artifactTitleOne') : t('artifactTitle', { count: files.length })

  return (
    <section className={styles.card} aria-label={title} data-artifact-card data-artifact-turn={group.turn}>
      <div className={styles.head}>
        <span className={styles.glyph} aria-hidden>
          <IconArtifactsOutline16 />
        </span>
        <span className={styles.title}>{title}</span>
      </div>
      <ul className={styles.list}>
        {shown.map((file) => (
          <ArtifactTile key={file.path} file={file} />
        ))}
      </ul>
      {collapsible ? (
        <button
          type="button"
          className={styles.more}
          aria-expanded={expanded}
          aria-label={t(expanded ? 'artifactCollapseAria' : 'artifactShowAllAria', { count: files.length })}
          data-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <span>{expanded ? t('artifactCollapse') : t('artifactShowAll', { count: files.length })}</span>
          <span className={styles.moreChevron} aria-hidden />
        </button>
      ) : null}
    </section>
  )
}

/**
 * 一个交付文件一行：类型图标 + 文件名 + 说明（没有说明就显示大写扩展名）。
 *
 * 点整行 = 打开它（`openArtifactFile`）：本地文件走工作区抽屉预览，外链走浏览器。
 * 说明那一行按官方的 `cardDescription()`（`PresentedFileCard.tsx:13-16`）去掉
 * 结尾的括注 —— 模型常把 `（2.88MB，已签名）` 这类噪音缀在说明后面。
 */
export const ArtifactTile = ({ file }: { file: ArtifactFile }) => {
  const t = useTranslate()
  const [busy, setBusy] = useState(false)
  const metadata = file.extension.length > 0 ? file.extension : t('artifactFile')
  const description = stripTrailingNote(file.description)
  const meta = description ?? metadata
  const external = file.url !== undefined

  const open = (): void => {
    if (busy) {
      return
    }
    setBusy(true)
    void openArtifactFile(file).finally(() => setBusy(false))
  }

  return (
    <li className={styles.row}>
      <button
        type="button"
        className={styles.rowButton}
        title={file.path}
        data-busy={busy}
        data-external={external}
        onClick={open}
      >
        <span className={styles.rowIcon} aria-hidden>
          <FileIcon ext={artifactExtension(file)} />
        </span>
        <span className={styles.rowBody}>
          <span className={styles.rowName}>{file.name}</span>
          <span className={styles.rowMeta}>
            <span className={styles.rowMetaText}>{meta}</span>
            <span className={styles.rowHint}>{t(external ? 'artifactOpenLink' : 'artifactPreview')}</span>
          </span>
        </span>
        {external ? (
          <span className={styles.rowExternal} aria-hidden>
            <IconExternalLinkOutline14 />
          </span>
        ) : null}
      </button>
    </li>
  )
}

/** `FileIcon` 只认大写扩展名；没有扩展名就传空串（它会退到「其它文件」图标）。 */
const artifactExtension = (file: ArtifactFile): string => file.extension

/** 去掉说明结尾的括注（中英文括号都算），只剩空就返回 `undefined`（回落到扩展名）。 */
const stripTrailingNote = (description: string | undefined): string | undefined => {
  if (description === undefined) {
    return undefined
  }
  const trimmed = description.replace(/\s*(?:\([^()]*\)|（[^（）]*）)\s*$/u, '').trim()
  return trimmed.length === 0 ? undefined : trimmed
}
