import clsx from 'clsx'
import type { TranslationKey } from '../../../i18n/index.js'
import { useTranslate } from '../../../i18n/index.js'
import { formatSize } from '../../../services/attachments.js'
import { fileKindOf, joinRelativePath, type WorkspaceEntry, type WorkspaceFileKind } from '../../../services/remote/filesApi.js'
import { FileIcon } from '../../files/FileIcon.js'
import { useWorkspacePane } from './workspacePaneStore.js'
import styles from './WorkspacePane.module.css'

/** 一层最多画这么多行（Host 侧目录本身会截断到 1000 项；这里再兜一层渲染成本）。 */
const MAX_ROWS = 300

/** 预览种类 → i18n key（显式映射，别用模板串拼 key：`TranslationKey` 是字面量联合）。 */
const KIND_LABEL: Record<WorkspaceFileKind, TranslationKey> = {
  text: 'workspacePaneKindText',
  image: 'workspacePaneKindImage',
  binary: 'workspacePaneKindBinary',
}

/**
 * 目录树的一层（**懒加载**：展开才 `list`，一次只拉一层）。
 *
 * 排序与官方 RN 侧一致：目录在前、同类按名称。
 * 文件点击 → `openFile()`（文本 / 图片 / 二进制三种预览）。
 */
export const WorkspaceTree = ({ path, depth }: { path: string; depth: number }) => {
  const t = useTranslate()
  const node = useWorkspacePane((state) => state.nodes[path])

  if (node === undefined) return null
  if (node.loading && node.entries.length === 0) {
    return <div className={styles.notice}>{t('workspacePaneLoading')}</div>
  }
  if (node.error !== null) return <div className={styles.error}>{node.error}</div>
  if (node.entries.length === 0) return <div className={styles.notice}>{t('workspacePaneEmptyDir')}</div>

  const sorted = sortEntries(node.entries)
  const shown = sorted.slice(0, MAX_ROWS)
  return (
    <>
      <div role="tree" aria-label={t('workspacePaneTitle')}>
        {shown.map((entry) => (
          <TreeRow key={entry.name} parent={path} entry={entry} depth={depth} />
        ))}
      </div>
      {sorted.length > shown.length || node.truncated ? (
        <div className={styles.notice}>{t('workspacePaneTruncated', { count: shown.length })}</div>
      ) : null}
    </>
  )
}

const sortEntries = (entries: readonly WorkspaceEntry[]): WorkspaceEntry[] =>
  [...entries].sort((a, b) => {
    const folderDelta = Number(b.type === 'directory') - Number(a.type === 'directory')
    return folderDelta !== 0 ? folderDelta : a.name.localeCompare(b.name, 'zh-Hans-CN')
  })

const TreeRow = ({ parent, entry, depth }: { parent: string; entry: WorkspaceEntry; depth: number }) => {
  const path = joinRelativePath(parent, entry.name)
  const isDir = entry.type === 'directory'
  const expanded = useWorkspacePane((state) => state.expanded[path] === true)

  return (
    <>
      <button
        type="button"
        role="treeitem"
        aria-expanded={isDir ? expanded : undefined}
        className={clsx(styles.row, isDir && styles.rowDir)}
        style={{ paddingLeft: 10 + depth * 14 }}
        onClick={() => {
          if (isDir) {
            void useWorkspacePane.getState().toggleDir(path)
            return
          }
          void useWorkspacePane.getState().openFile(path)
        }}
      >
        <span className={clsx(styles.glyph, isDir && styles.glyphDir)} aria-hidden>
          {isDir ? <Chevron expanded={expanded} /> : <FileGlyph name={entry.name} />}
        </span>
        <span className={styles.rowName} title={path}>
          {entry.name}
        </span>
        {entry.size === undefined ? null : <span className={styles.rowSize}>{formatSize(entry.size)}</span>}
        {isDir ? null : <KindTag name={entry.name} />}
      </button>
      {isDir && expanded ? <WorkspaceTree path={path} depth={depth + 1} /> : null}
    </>
  )
}

const KindTag = ({ name }: { name: string }) => {
  const t = useTranslate()
  return <span className={styles.rowKind}>{t(KIND_LABEL[fileKindOf(name)])}</span>
}

/** 折叠箭头：展开时转 90°（纯 CSS 过渡，不引第三方图标）。 */
const Chevron = ({ expanded }: { expanded: boolean }) => (
  <svg
    className={clsx(styles.chevron, expanded && styles.chevronOpen)}
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    aria-hidden
  >
    <path
      d="M4.5 2.5L8 6l-3.5 3.5"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

/**
 * 文件图标：复用本机侧的 `FileIcon`（按扩展名给 PDF / 表格 / 图片 / 通用图标）。
 * 目录用的是上面的内联 `Chevron` —— `components/base/icons.tsx` 里没有文件夹图标，
 * 而那个文件不在本批可改范围（并行任务也在动它），所以箭头留在这里画。
 */
const FileGlyph = ({ name }: { name: string }) => {
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toUpperCase() : ''
  return <FileIcon ext={ext} />
}
