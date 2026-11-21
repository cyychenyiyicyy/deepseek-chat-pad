import clsx from 'clsx'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate, type TranslationKey } from '../../../i18n/index.js'
import type { ChatImage, ToolActivity, ToolDisplayDetail } from '../../../services/remote/adapter.js'
import {
  IconCheckOutline16,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconCloseOutline16,
  IconPhotoErrorFill20,
  IconWarningOutline16,
} from '../../base/icons.js'
import { CodeBlock } from '../../markdown/CodeBlock.js'
import { Markdown } from '../../markdown/Markdown.js'
import { readToolOpen, takeAutoOpen, writeToolOpen } from './toolCardState.js'
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

  const [open, setOpen] = useState(() => readToolOpen(item.id))
  // running 第一次出现时自动展开一次；之后（含用户收起过）不再自动弹开
  useEffect(() => {
    if (item.state !== 'running') return
    if (!takeAutoOpen(item.id)) return
    setOpen(true)
    writeToolOpen(item.id, true)
  }, [item.id, item.state])

  const failed = item.state === 'failed'
  const hasDetail = item.callDetail !== undefined || item.resultDetail !== undefined
  const toggle = () => {
    if (!hasDetail) return
    const next = !open
    setOpen(next)
    writeToolOpen(item.id, next)
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

      {item.state === 'running' && !open ? (
        <div className={styles.skeleton} aria-hidden="true">
          <div className={styles.skeletonBar} />
          <div className={styles.skeletonBar} />
        </div>
      ) : null}

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
 * 工具结果里的图片：**常驻**在摘要下面（不展开也能看到），点击进全屏查看层。
 *
 * 数据形态（`ChatImage`，见 `services/remote/adapter.ts` 的 `messageImages()`）：
 *   - `uri`：`data:image/png;base64,…`（结果块里带内联像素时才有）；
 *   - `attachmentId` + `sessionId`：持久引用。Web 端**没有**按 attachmentId 取字节的接口
 *     （`sessionsApi.ts` 只有 prompt 上传），所以只有它的时候画占位方块 + 文件名，
 *     不画空框、也不假装加载。
 */
const ToolImageStrip = ({ images }: { images: ChatImage[] }) => {
  const [preview, setPreview] = useState<ChatImage | undefined>(undefined)
  return (
    <>
      <div className={styles.images}>
        {images.map((image, index) => (
          <Thumbnail
            key={`${image.attachmentId ?? image.name ?? 'image'}:${index}`}
            image={image}
            onOpen={() => setPreview(image)}
          />
        ))}
      </div>
      {preview === undefined ? null : <ImageViewer image={preview} onClose={() => setPreview(undefined)} />}
    </>
  )
}

const Thumbnail = ({ image, onOpen }: { image: ChatImage; onOpen: () => void }) => {
  const t = useTranslate()
  const [broken, setBroken] = useState(false)
  const label = image.name ?? t('remoteToolImage')
  const src = image.uri
  return (
    <button
      type="button"
      className={styles.thumb}
      onClick={src === undefined || broken ? undefined : onOpen}
      aria-label={label}
      disabled={src === undefined || broken}
    >
      {src !== undefined && !broken ? (
        <img className={styles.thumbImage} src={src} alt={label} onError={() => setBroken(true)} />
      ) : (
        <span className={styles.thumbPlaceholder}>
          <IconPhotoErrorFill20 />
          <span className={styles.thumbName}>{label}</span>
        </span>
      )}
    </button>
  )
}

/** 全屏查看层：点击任意位置关闭（也响应 Esc）。portal 到 body，避免被时间线裁掉。 */
const ImageViewer = ({ image, onClose }: { image: ChatImage; onClose: () => void }) => {
  const t = useTranslate()
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  const label = image.name ?? t('remoteToolImage')
  return createPortal(
    <div className={styles.viewer} role="dialog" aria-modal="true" aria-label={label} onClick={onClose}>
      <button type="button" className={styles.viewerClose} aria-label={t('close')} onClick={onClose}>
        <IconCloseOutline16 />
      </button>
      {image.uri === undefined ? null : (
        <img className={styles.viewerImage} src={image.uri} alt={label} onClick={(event) => event.stopPropagation()} />
      )}
      <span className={styles.viewerCaption}>{label}</span>
    </div>,
    document.body
  )
}
