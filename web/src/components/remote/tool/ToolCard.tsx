import clsx from 'clsx'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate, type TranslationKey } from '../../../i18n/index.js'
import type { ChatImage, ToolActivity, ToolDisplayDetail } from '../../../services/remote/adapter.js'
import { downloadFromUrl } from '../../../services/remote/download.js'
import {
  isRemoteAborted,
  isRemoteNotReady,
  toolImageLoader,
  type AttachmentReference,
} from '../../../services/remote/filesApi.js'
import {
  IconCheckOutline16,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconCloseOutline16,
  IconDownloadOutline16,
  IconPhotoErrorFill20,
  IconRefreshOutline16,
  IconWarningOutline16,
} from '../../base/icons.js'
import { CodeBlock } from '../../markdown/CodeBlock.js'
import { Markdown } from '../../markdown/Markdown.js'
import { followToolItem, readToolOpen, toggleToolOpen, type ToolCardOpenView } from './toolCardState.js'
import {
  argumentRows,
  computeLineDiff,
  parseDiffs,
  parseRead,
  parseSearch,
  parseTerminal,
  parseWeb,
  type ArgRow,
  type DiffBlock,
  type SearchGroup,
} from './toolDetail.js'
import { iconKindFor, ToolIcon } from './toolIcons.js'
import {
  isCodeSummary,
  languageForPath,
  oneLine,
  parseArguments,
  pickString,
  summarizeTool,
  toolKindOf,
  type ToolKind,
} from './toolMeta.js'
import styles from './ToolCard.module.css'

/**
 * 一张工具卡：**一行摘要 + 点开详情**。
 *
 * 设计来源（详见 `work/2026-11-21-chatpad接入DSH远程/input-L2-工具卡.md`）：
 *   - dsh-Go `ui/chat/widgets/tool_row.dart`：32dp 单行（图标块 + 动词 + · + 摘要 + 状态尾巴），
 *     点开在下方长出「代码井」；
 *   - `ds-harness-remote` `screens/chat/messages.tsx → ToolRow`：无详情的行不可点，
 *     详情按 `调用 / 结果` 两段给，长文本折在可展开的井里。
 *
 * 两处刻意不同：
 *   1. **图片不进折叠区** —— 用户明确说「图片要能看到」，所以缩略图常驻在摘要下面；
 *   2. 详情按**结果类型**渲染（终端 / 读 / diff / 搜索 / 联网 / 键值表），而不是把
 *      数据层拼好的那一坨文本原样倒出来。
 *
 * 数据全部来自 `ToolActivity`（数据层已经归约好），这里不碰 `services/**`。
 */

/** 长文本默认只露这么多行，剩下的折进「展开全部」 */
const PREVIEW_LINES = 14
/** 搜索结果默认只露这么多个文件分组 */
const PREVIEW_GROUPS = 5

const VERBS: Record<ToolKind, TranslationKey> = {
  shell: 'remoteToolVerbShell',
  read: 'remoteToolVerbRead',
  readImage: 'remoteToolVerbReadImage',
  write: 'remoteToolVerbWrite',
  edit: 'remoteToolVerbEdit',
  search: 'remoteToolVerbSearch',
  web: 'remoteToolVerbWeb',
  task: 'remoteToolVerbTask',
  agent: 'remoteToolVerbAgent',
  other: 'remoteToolVerbOther',
}

export const ToolCard = ({ item }: { item: ToolActivity }) => {
  const t = useTranslate()
  const args = useMemo(() => parseArguments(item.arguments), [item.arguments])
  const kind = toolKindOf(item.toolKey ?? item.toolName, args)
  // diff 只算一次：摘要里的 `+N −M` 和详情里的染色都用这一份
  const blocks = useMemo(
    () =>
      kind === 'edit' || kind === 'write'
        ? (parseDiffs(item.resultDetail?.text) ?? diffsFromArgs(kind, args))
        : undefined,
    [kind, args, item.resultDetail?.text]
  )
  const diffStats = useMemo(
    () =>
      blocks === undefined
        ? undefined
        : {
            added: blocks.reduce((sum, block) => sum + block.added, 0),
            removed: blocks.reduce((sum, block) => sum + block.removed, 0),
          },
    [blocks]
  )
  const summary = summarizeTool(
    {
      kind,
      args,
      summary: item.summary,
      result: item.resultDetail?.text,
      hostTitle: item.toolName,
      toolKey: item.toolKey,
      ...(diffStats === undefined ? {} : { diffStats }),
    },
    (which) => t(VERBS[which]),
    {
      itemCount: (count) => t('remoteToolItemCount', { count }),
      exitCode: (code) => t('remoteToolExitCode', { code }),
      lineCount: (count) => t('remoteToolLineCount', { count }),
    }
  )

  // 折叠状态：**默认收起**，只有点击才展开（没有任何「自动展开一次」）。
  // 状态按 item id 记在 `toolCardState` 里；同一条 item 上新帧到达时这里不会动它，
  // 只有 id 变了（列表复用组件实例）才回记忆里读 —— 见 `followToolItem`。
  const [view, setView] = useState<ToolCardOpenView>(() => ({
    id: item.id,
    open: readToolOpen(item.id),
  }))
  const current = followToolItem(view, item.id)
  if (current !== view) setView(current)
  const open = current.open

  const failed = item.state === 'failed'
  const hasDetail = item.callDetail !== undefined || item.resultDetail !== undefined
  const toggle = () => {
    if (!hasDetail) return
    setView({ id: item.id, open: toggleToolOpen(item.id) })
  }

  const rawName = item.toolKey ?? item.toolName
  const expandedLabel = t(open ? 'remoteToolCollapse' : 'remoteToolExpand', { name: rawName })

  return (
    <div className={clsx(styles.card, open && styles.cardOpen)}>
      <button
        type="button"
        className={clsx(styles.header, !hasDetail && styles.headerStatic)}
        onClick={toggle}
        aria-expanded={hasDetail ? open : undefined}
        aria-label={hasDetail ? expandedLabel : undefined}
        disabled={!hasDetail}
      >
        <span className={clsx(styles.glyph, failed && styles.glyphFailed)}>
          <ToolIcon kind={iconKindFor(kind)} />
        </span>
        <span className={styles.verb}>{summary.verb}</span>
        {summary.detail === undefined ? null : (
          <>
            <span className={styles.dot} aria-hidden="true">
              ·
            </span>
            <span
              className={clsx(
                styles.tip,
                isCodeSummary(kind) && styles.tipCode,
                failed && styles.tipFailed
              )}
            >
              {summary.detail}
            </span>
          </>
        )}
        {summary.extra === undefined ? null : <span className={styles.extra}>{summary.extra}</span>}
        <span className={styles.trail}>
          {item.state === 'running' ? <span className={styles.spinner} aria-hidden="true" /> : null}
          {item.state === 'finished' ? (
            <span className={styles.done} aria-hidden="true">
              <IconCheckOutline16 />
            </span>
          ) : null}
          {failed ? (
            <>
              <span className={styles.failed} aria-hidden="true">
                <IconWarningOutline16 />
              </span>
              <span className={styles.failedText}>{t('remoteToolFailed')}</span>
            </>
          ) : null}
        </span>
        {hasDetail ? (
          <span className={styles.chevron} aria-hidden="true">
            {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
          </span>
        ) : null}
      </button>

      {/* 运行中的「还在跑」信号只放在头部转圈里：收起状态下不再长出一条骨架，
          否则一屏十几个工具调用会被这些没有内容的横条顶得很长（真机反馈）。 */}
      {open ? (
        <ToolDetailBody item={item} kind={kind} args={args} failed={failed} blocks={blocks} />
      ) : null}

      {item.images !== undefined && item.images.length > 0 ? (
        <ToolImageStrip images={item.images} />
      ) : null}
    </div>
  )
}

/* ────────────────────────────── 详情主体 ────────────────────────────── */

const ToolDetailBody = ({
  item,
  kind,
  args,
  failed,
  blocks,
}: {
  item: ToolActivity
  kind: ToolKind
  args: Record<string, unknown> | undefined
  failed: boolean
  /** edit / write 的行级 diff（ToolCard 已经算过，这里直接复用） */
  blocks: DiffBlock[] | undefined
}) => {
  const t = useTranslate()
  const result = item.resultDetail?.text
  const sections: ReactNode[] = []

  if (item.state === 'running' && item.resultDetail === undefined) {
    sections.push(<div key="running" className={styles.empty}>{t('remoteToolRunningHint')}</div>)
  }

  if (failed) {
    sections.push(
      <Section key="error" label={t('remoteToolSectionError')}>
        <pre className={clsx(styles.code, styles.codeWrap)}>{errorText(item) ?? t('remoteToolNoDetail')}</pre>
      </Section>
    )
  }

  if (kind === 'shell') {
    const terminal = parseTerminal(item.callDetail?.text, result)
    if (terminal?.command !== undefined) {
      sections.push(
        <Section key="command" label={t('remoteToolSectionCommand')}>
          <div className={styles.command}>
            <span className={styles.promptSign}>$</span>
            <span className={styles.commandText}>{terminal.command}</span>
          </div>
          {terminal.cwd === undefined ? null : (
            <span className={styles.metaLine}>{t('remoteToolCwd', { path: terminal.cwd })}</span>
          )}
        </Section>
      )
    }
    if (terminal !== undefined && terminal.output.trim().length > 0 && !failed) {
      sections.push(
        <Section key="output" label={t('remoteToolSectionOutput')}>
          <CollapsibleText text={terminal.output} wrap />
        </Section>
      )
    }
    if (terminal?.output.trim().length === 0 && !failed && item.state !== 'running') {
      sections.push(<div key="noOutput" className={styles.empty}>{t('remoteToolNoOutput')}</div>)
    }
  } else if (kind === 'read' || kind === 'readImage') {
    const window = parseRead(result)
    const path = window?.path ?? pickString(args, ['file_path', 'path'])
    if (path !== undefined || window?.totalLines !== undefined) {
      sections.push(
        <Section key="file" label={t('remoteToolSectionFile')}>
          <div className={styles.group}>
            <span className={styles.groupPath}>{path ?? ''}</span>
            {window?.totalLines === undefined ? null : (
              <span className={styles.metaLine}>{t('remoteToolLineCount', { count: window.totalLines })}</span>
            )}
          </div>
        </Section>
      )
    }
    if (window !== undefined) {
      sections.push(
        <Section key="content" label={t('remoteToolSectionContent')}>
          <LineWell
            lines={window.lines.map((line) => ({ number: line.number, text: line.text }))}
          />
        </Section>
      )
    } else if (result !== undefined && result.trim().length > 0) {
      sections.push(
        <Section key="raw" label={t('remoteToolSectionResult')}>
          {kind === 'readImage' ? (
            <span className={styles.metaLine}>{result}</span>
          ) : (
            <CollapsibleText text={result} wrap />
          )}
        </Section>
      )
    }
  } else if (kind === 'write' || kind === 'edit') {
    const path = pickString(args, ['file_path', 'path'])
    const content = kind === 'write' ? pickString(args, ['content', 'file_text']) : undefined
    if (path !== undefined || blocks !== undefined) {
      sections.push(
        <Section key="file" label={t('remoteToolSectionFile')}>
          <div className={styles.group}>
            <span className={styles.groupPath}>{path ?? blocks?.[0]?.path ?? ''}</span>
          </div>
        </Section>
      )
    }
    if (blocks !== undefined) {
      sections.push(
        <Section key="changes" label={t('remoteToolSectionChanges')}>
          <DiffWell blocks={blocks} />
        </Section>
      )
    }
    if (content !== undefined) {
      sections.push(
        <Section key="content" label={t('remoteToolSectionContent')}>
          <CodeBlock code={content} infostring={languageForPath(path)} />
        </Section>
      )
    }
  } else if (kind === 'search') {
    const groups = parseSearch(result)
    if (groups !== undefined) {
      sections.push(
        <Section key="hits" label={t('remoteToolSectionResult')}>
          <SearchWell groups={groups} />
        </Section>
      )
    }
  } else if (kind === 'web') {
    const web = parseWeb(result)
    const query = pickString(args, ['query', 'q'])
    if (query !== undefined) {
      sections.push(
        <Section key="query" label={t('remoteToolSectionQuery')}>
          <span className={styles.commandText}>{query}</span>
        </Section>
      )
    }
    if (web?.shape === 'fetch') {
      sections.push(
        <Section key="fetch" label={t('remoteToolSectionResult')}>
          <div className={styles.group}>
            {web.status === undefined ? null : <span className={styles.metaLine}>{web.status}</span>}
            {web.url === undefined || web.url.length === 0 ? null : (
              <a className={styles.sourceLink} href={web.url} target="_blank" rel="noreferrer noopener">
                {web.url}
              </a>
            )}
          </div>
        </Section>
      )
    } else if (web !== undefined) {
      if (web.answer !== undefined) {
        sections.push(
          <Section key="answer" label={t('remoteToolSectionAnswer')}>
            <div className={styles.markdownBody}>
              <Markdown
                content={web.answer}
                loading={false}
                cacheKey={`${item.id}:web`}
                disableLink={false}
              />
            </div>
          </Section>
        )
      }
      if (web.sources.length > 0) {
        sections.push(
          <Section key="sources" label={t('remoteToolSectionSources')}>
            <WebSources sources={web.sources} />
          </Section>
        )
      }
    }
  } else if (kind === 'task') {
    const todos = args?.['todos']
    if (Array.isArray(todos)) {
      sections.push(
        <Section key="todos" label={t('remoteToolSectionTasks')}>
          <TodoList todos={todos} />
        </Section>
      )
    }
  }

  // 兜底：不是上面任何一个分支、但结果里有 markdown 文本 → 用同一个 Markdown 渲染
  const handled = kind === 'shell' || kind === 'read' || kind === 'readImage' || kind === 'write'
    || kind === 'edit' || kind === 'search' || kind === 'web' || (kind === 'task' && Array.isArray(args?.['todos']))
  if (!handled && item.resultDetail !== undefined) {
    sections.push(
      <Section key="result" label={t('remoteToolSectionResult')}>
        {item.resultDetail.format === 'markdown' ? (
          <div className={styles.markdownBody}>
            <Markdown
              content={item.resultDetail.text}
              loading={false}
              cacheKey={`${item.id}:result`}
              disableLink={false}
            />
          </div>
        ) : (
          <CollapsibleText text={item.resultDetail.text} wrap />
        )}
      </Section>
    )
  }

  const argRows = argumentRows(args, ARG_KEYS_ALREADY_SHOWN)
  if (argRows.length > 0) {
    sections.push(
      <Section key="params" label={t('remoteToolSectionParams')}>
        <ArgTable rows={argRows} />
      </Section>
    )
  }

  if (item.callDetail !== undefined && sections.length === 0) {
    sections.push(
      <Section key="call" label={t('remoteToolSectionCall')}>
        <CollapsibleText detail={item.callDetail} wrap />
      </Section>
    )
  }

  if (sections.length === 0) {
    return <div className={styles.body}><span className={styles.empty}>{t('remoteToolNoDetail')}</span></div>
  }
  return <div className={styles.body}>{sections}</div>
}

/** 参数表里不再重复的键：它们已经在上面自己的小节里出现过 */
const ARG_KEYS_ALREADY_SHOWN = [
  'command',
  'cmd',
  'script',
  'file_path',
  'path',
  'file',
  'target',
  'pattern',
  'regex',
  'query',
  'q',
  'url',
  'uri',
  'content',
  'file_text',
  'old_string',
  'new_string',
  'old_str',
  'new_str',
  'todos',
  'description',
  'prompt',
  'objective',
]

const errorText = (item: ToolActivity): string | undefined => {
  const text = item.resultDetail?.text.trim()
  if (text !== undefined && text.length > 0) return text
  return item.summary?.trim()
}

/** 有 `--- 修改前 ---` 的结果就用它；否则退回参数里的 old/new 自己算一遍。 */
const diffsFromArgs = (
  kind: ToolKind,
  args: Record<string, unknown> | undefined
): DiffBlock[] | undefined => {
  const path = pickString(args, ['file_path', 'path']) ?? ''
  const before = kind === 'edit' ? pickString(args, ['old_string', 'old_str']) : undefined
  const after =
    kind === 'edit'
      ? pickString(args, ['new_string', 'new_str'])
      : pickString(args, ['content', 'file_text'])
  if (after === undefined) return undefined
  const lines = computeLineDiff(before ?? '', after)
  return [
    {
      path,
      created: before === undefined,
      lines,
      added: lines.filter((line) => line.kind === 'add').length,
      removed: lines.filter((line) => line.kind === 'del').length,
    },
  ]
}

/* ────────────────────────────── 小部件 ────────────────────────────── */

const Section = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className={styles.section}>
    <span className={styles.sectionLabel}>{label}</span>
    {children}
  </div>
)

/** 长文本：默认露出前 N 行，超出的折进「展开全部」。滚动容器限高。 */
const CollapsibleText = ({
  text,
  detail,
  wrap = false,
}: {
  text?: string
  detail?: ToolDisplayDetail
  wrap?: boolean
}) => {
  const t = useTranslate()
  const body = text ?? detail?.text ?? ''
  const lines = useMemo(() => body.split('\n'), [body])
  const [showAll, setShowAll] = useState(false)
  const truncated = lines.length > PREVIEW_LINES
  const shown = truncated && !showAll ? lines.slice(0, PREVIEW_LINES).join('\n') : body
  return (
    <>
      <pre className={clsx(styles.code, wrap && styles.codeWrap)}>{shown}</pre>
      {truncated ? (
        <button type="button" className={styles.more} onClick={() => setShowAll((value) => !value)}>
          {t(showAll ? 'remoteToolShowLess' : 'remoteToolShowAll', { count: lines.length })}
        </button>
      ) : detail?.truncated === true ? (
        <span className={styles.metaLine}>{t('remoteToolTruncated')}</span>
      ) : null}
    </>
  )
}

/** 读文件的行号井（`12 | 内容`） */
const LineWell = ({ lines }: { lines: { number: number; text: string }[] }) => {
  const t = useTranslate()
  const [showAll, setShowAll] = useState(false)
  const truncated = lines.length > PREVIEW_LINES
  const shown = truncated && !showAll ? lines.slice(0, PREVIEW_LINES) : lines
  return (
    <>
      <div className={styles.lines}>
        {shown.map((line) => (
          <div key={line.number} className={styles.line}>
            <span className={styles.lineNumber}>{line.number}</span>
            <span className={styles.lineText}>{line.text}</span>
          </div>
        ))}
      </div>
      {truncated ? (
        <button type="button" className={styles.more} onClick={() => setShowAll((value) => !value)}>
          {t(showAll ? 'remoteToolShowLess' : 'remoteToolShowAll', { count: lines.length })}
        </button>
      ) : null}
    </>
  )
}

/** diff：增行绿底、删行红底，未变的行只做上下文 */
const DiffWell = ({ blocks }: { blocks: DiffBlock[] }) => (
  <div className={styles.diff}>
    {blocks.map((block, index) => (
      <div key={`${block.path}:${index}`}>
        {blocks.length > 1 ? <div className={styles.diffFile}>{block.path}</div> : null}
        {block.lines.map((line, lineIndex) => (
          <div
            key={lineIndex}
            className={clsx(
              styles.diffLine,
              line.kind === 'add' && styles.diffAdd,
              line.kind === 'del' && styles.diffDel
            )}
          >
            <span className={styles.diffSign}>{line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}</span>
            <span className={styles.diffText}>{line.text}</span>
          </div>
        ))}
      </div>
    ))}
  </div>
)

/** 搜索结果：路径分组 + 命中行（行号 + 内容） */
const SearchWell = ({ groups }: { groups: SearchGroup[] }) => {
  const t = useTranslate()
  const [showAll, setShowAll] = useState(false)
  const truncated = groups.length > PREVIEW_GROUPS
  const shown = truncated && !showAll ? groups.slice(0, PREVIEW_GROUPS) : groups
  return (
    <>
      {shown.map((group, index) => (
        <div key={`${group.path}:${index}`} className={styles.group}>
          <span className={styles.groupPath}>{group.path}</span>
          {group.hits.length === 0
            ? null
            : group.hits.map((hit, hitIndex) => (
                <div key={hitIndex} className={styles.hit}>
                  <span className={styles.hitLine}>{hit.line ?? ''}</span>
                  <span className={styles.hitText}>{hit.text}</span>
                </div>
              ))}
        </div>
      ))}
      {truncated ? (
        <button type="button" className={styles.more} onClick={() => setShowAll((value) => !value)}>
          {t(showAll ? 'remoteToolShowLess' : 'remoteToolShowAll', { count: groups.length })}
        </button>
      ) : null}
    </>
  )
}

/** 联网来源：标题 + 链接（新窗口打开）+ 摘要 */
const WebSources = ({ sources }: { sources: { title?: string; url: string; snippet?: string }[] }) => (
  <div className={styles.result}>
    {sources.map((source, index) => (
      <div key={`${source.url}:${index}`} className={styles.group}>
        {source.title === undefined ? null : <span className={styles.sourceTitle}>{source.title}</span>}
        <a className={styles.sourceLink} href={source.url} target="_blank" rel="noreferrer noopener">
          {source.url}
        </a>
        {source.snippet === undefined ? null : <span className={styles.sourceSnippet}>{source.snippet}</span>}
      </div>
    ))}
  </div>
)

/** 待办清单（`todo_write` 的参数就是结构化的 todos，直接按状态画） */
const TodoList = ({ todos }: { todos: unknown[] }) => (
  <div className={styles.result}>
    {todos.map((todo, index) => {
      if (typeof todo !== 'object' || todo === null) return null
      const row = todo as { content?: unknown; status?: unknown }
      const text = typeof row.content === 'string' ? oneLine(row.content) : ''
      const status = typeof row.status === 'string' ? row.status : ''
      const done = status === 'completed'
      return (
        <div key={index} className={styles.todoRow}>
          <span className={styles.todoSign}>{done ? '✓' : status === 'in_progress' ? '▸' : '·'}</span>
          <span className={clsx(styles.todoText, done && styles.todoDone)}>{text}</span>
        </div>
      )
    })}
  </div>
)

/** 参数键值表：一个键一行，长值用等宽 + 限高 */
const ArgTable = ({ rows }: { rows: ArgRow[] }) => (
  <div className={styles.args}>
    {rows.map((row) => (
      <div key={row.key} className={styles.argRow}>
        <span className={styles.argKey}>{row.key}</span>
        <span className={clsx(styles.argValue, row.long && styles.argValueLong)}>{row.value}</span>
      </div>
    ))}
  </div>
)

/* ────────────────────────────── 图片 ────────────────────────────── */

/**
 * 工具结果里的图片：**常驻**在摘要下面（卡片折叠着也能看到），点击进全屏查看层。
 *
 * 数据形态（`ChatImage`，见 `services/remote/adapter.ts` 里的 `messageImages()`）：
 *   - `uri`：`data:image/png;base64,…`（结果块里带内联像素时才有）；
 *   - `attachmentId` + `sessionId`：**持久引用**，没有像素 —— 走 `session/attachment`
 *     把它取回来（`services/remote/filesApi.ts` 的 `toolImageLoader`）。
 *
 * 三个必须守住的点（真机「裂图」事故的教训，见 `input-R2-工具卡修复.md`）：
 *   1. **绝不把没校验过的 uri 塞进 `<img>`** —— 相对路径会被解析成
 *      `http://127.0.0.1:18888/…`，`file:` 被 WebView 拦，两种都只会画出一张裂图；
 *      能不能用由 loader 判定，这里只认它返回的 `src`。
 *   2. **加载中给骨架**，成功才出 `<img>`，失败给「图标 + 文件名 + 重试」，不留空框。
 *   3. 没有连接（`REMOTE_NOT_READY`）就是**占位**，不报错、不闪红。
 */

/** 一张缩略图的加载状态。只有 `ready` 才有 `<img>`。 */
type ToolImageState =
  | { status: 'loading' }
  | { status: 'ready'; src: string }
  | { status: 'failed'; reason: string }
  | { status: 'empty'; kind: 'offline' | 'none' }

const ToolImageStrip = ({ images }: { images: ChatImage[] }) => {
  const [preview, setPreview] = useState<{ src: string; name: string } | undefined>(undefined)
  return (
    <>
      <div className={styles.images}>
        {images.map((image, index) => (
          <Thumbnail
            key={`${image.attachmentId ?? image.name ?? 'image'}:${index}`}
            image={image}
            onOpen={(src, name) => setPreview({ src, name })}
          />
        ))}
      </div>
      {preview === undefined ? null : (
        <ImageViewer src={preview.src} name={preview.name} onClose={() => setPreview(undefined)} />
      )}
    </>
  )
}

const Thumbnail = ({
  image,
  onOpen,
}: {
  image: ChatImage
  onOpen: (src: string, name: string) => void
}) => {
  const t = useTranslate()
  const [state, setState] = useState<ToolImageState>({ status: 'loading' })
  // 用户点了「重试」就 +1：既能重新发请求（loader 里配上 force），也能让 effect 重跑
  const [attempt, setAttempt] = useState(0)
  const label = image.name ?? t('remoteToolImage')

  // 数据层每帧都可能给出**新的对象**（`messageImages()` 每次调用都重建），但同一张图的
  // 字段不变 —— 把真正参与请求的几个字段钉成一份稳定引用，新帧就不会把图重新拉一遍。
  const reference = useMemo<AttachmentReference>(
    () => ({
      attachmentId: image.attachmentId,
      sessionId: image.sessionId,
      uri: image.uri,
      name: image.name,
      mediaType: image.mediaType,
      bytes: image.bytes,
      width: image.width,
      height: image.height,
    }),
    [
      image.attachmentId,
      image.sessionId,
      image.uri,
      image.name,
      image.mediaType,
      image.bytes,
      image.width,
      image.height,
    ]
  )

  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading' })
    toolImageLoader(reference, reference.sessionId, { signal: controller.signal, force: attempt > 0 })
      .then((src) => {
        if (controller.signal.aborted) return
        setState(src === null ? { status: 'empty', kind: 'none' } : { status: 'ready', src })
      })
      .catch((error: unknown) => {
        // 卸载 / 换图导致的取消：什么都不做（不是失败，不该弹重试）
        if (controller.signal.aborted || isRemoteAborted(error)) return
        // 没连上远端：画「未连接」占位，不报错
        if (isRemoteNotReady(error)) {
          setState({ status: 'empty', kind: 'offline' })
          return
        }
        setState({
          status: 'failed',
          // 只存**原始原因**（`RemoteApiError` 的中文消息，例如「地址是相对路径…」）；
          // 可见文案在渲染时翻译，effect 里不碰 `t`，换语言不会把图重新拉一遍
          reason: error instanceof Error ? error.message : '',
        })
      })
    return () => controller.abort()
  }, [reference, attempt])

  const body = ((): ReactNode => {
    if (state.status === 'ready') {
      return (
        <button
          type="button"
          className={styles.thumbButton}
          onClick={() => onOpen(state.src, label)}
          aria-label={t('remoteToolImageOpen', { name: label })}
        >
          <img
            className={styles.thumbImage}
            src={state.src}
            alt={label}
            // 像素坏掉（截断的 data URL / 地址 404）也不能留裂图：直接转失败占位
            onError={() => setState({ status: 'failed', reason: t('remoteToolImageFailed') })}
          />
        </button>
      )
    }
    if (state.status === 'loading') {
      return (
        <span className={styles.thumbSkeleton} aria-busy="true" aria-label={t('remoteToolImageLoading')}>
          <span className={styles.thumbSkeletonBar} />
          <span className={styles.thumbSkeletonBar} />
        </span>
      )
    }
    if (state.status === 'failed') {
      return (
        // 完整原因放 `title`（绝对路径 / 相对路径 / 非图片 data URL 之类），
        // 卡片里只留「加载失败 + 重试」，96px 的方块塞不下长句子
        <span className={styles.thumbPlaceholder} title={state.reason.length > 0 ? state.reason : undefined}>
          <span className={styles.thumbFailed} aria-hidden="true">
            <IconPhotoErrorFill20 />
          </span>
          <span className={styles.thumbName}>{label}</span>
          <span className={styles.thumbReason}>{t('remoteToolImageFailed')}</span>
          <button
            type="button"
            className={styles.thumbRetry}
            onClick={() => setAttempt((value) => value + 1)}
          >
            <IconRefreshOutline16 />
            {t('remoteToolImageRetry')}
          </button>
        </span>
      )
    }
    return (
      <span className={styles.thumbPlaceholder}>
        <span className={styles.thumbUnavailable} aria-hidden="true">
          <ToolIcon kind="image" />
        </span>
        <span className={styles.thumbName}>{label}</span>
        <span className={styles.thumbReason}>
          {t(state.kind === 'offline' ? 'remoteToolImageOffline' : 'remoteToolImageUnavailable')}
        </span>
      </span>
    )
  })()

  return <div className={styles.thumb}>{body}</div>
}

/** 全屏查看层：点击任意位置关闭（也响应 Esc）。portal 到 body，避免被时间线裁掉。 */
const ImageViewer = ({ src, name, onClose }: { src: string; name: string; onClose: () => void }) => {
  const t = useTranslate()
  // 「下载」（R7）：把这一张图交给原生写进系统「下载」目录。
  // src 可能是 data:（结果块内联像素）或 blob:，两种 downloadFromUrl 都认。
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return createPortal(
    <div className={styles.viewer} role="dialog" aria-modal="true" aria-label={name} onClick={onClose}>
      <button type="button" className={styles.viewerClose} aria-label={t('close')} onClick={onClose}>
        <IconCloseOutline16 />
      </button>
      <button
        type="button"
        className={styles.viewerDownload}
        aria-label={t('downloadAction')}
        title={t('downloadAction')}
        disabled={saving}
        onClick={(event) => {
          // 不能让点击冒到遮罩上（那会立刻关掉查看层）
          event.stopPropagation()
          setSaving(true)
          void downloadFromUrl(src, name)
            .catch(() => undefined)
            .then(() => setSaving(false))
        }}
      >
        <IconDownloadOutline16 />
      </button>
      <img
        className={styles.viewerImage}
        src={src}
        alt={name}
        onClick={(event) => event.stopPropagation()}
      />
      <span className={styles.viewerCaption}>{name}</span>
    </div>,
    document.body
  )
}
