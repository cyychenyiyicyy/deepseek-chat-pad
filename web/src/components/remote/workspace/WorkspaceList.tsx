import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../../i18n/index.js'
import { useNewSessionStore } from '../../../services/remote/newSessionStore.js'
import { workspaceSections } from '../../../services/remote/workspacePreferences.js'
import {
  IconBrowseOutline16,
  IconCheckOutline16,
  IconCopyOutline16,
} from '../../base/icons.js'
import styles from './WorkspaceList.module.css'

/**
 * **工作区列表**（S2）—— 新建会话页的工作区抽屉与工作区文件抽屉的切换列表共用这一份。
 *
 * 每一行给四件事（用户反馈里点名要的）：
 *   1. **名字**：`title`（空的由数据层兜底成路径末段，绝不显示空白行）；
 *   2. **路径**：一格小按钮，点一下复制到剪贴板（复制成功 / 失败都在原地显示一下）；
 *   3. **会话数**：`workspace/follow` 给的就是权威（0 个也会显示「还没有会话」），
 *      派生列表里的数只当参考（不知道就干脆不显示）；
 *   4. **是否当前**：右侧一个勾 + `aria-current`。
 *
 * 为什么不用现成的 `Select`：它只支持一行纯文本，塞不下「路径可复制 + 会话数 + 当前」，
 * 也没法表达「这个工作区还没有会话，切不过去」。这里是列表，不是下拉框。
 */
export interface WorkspaceListItem {
  workspaceId: string
  /** 显示名（数据层已兜底，不会是空串）。 */
  title: string
  /** 绝对路径（可能为空：Host 没给 path 也没会话 cwd）。 */
  path: string
  /** 会话数；`undefined` = 不知道（派生列表里没有它），UI 不显示。 */
  sessionCount?: number
  /** 会话数是不是权威（`workspace/follow` 给的）：是的话 0 也要说「还没有会话」。 */
  countKnown?: boolean
  /** 这一项是不是当前选中的工作区。 */
  current?: boolean
  /** 不能选中（例如工作区文件抽屉里「没有会话的工作区」切不过去）。 */
  disabled?: boolean
  /** 禁用 / 补充说明（一行小字）。 */
  hint?: string
}

/**
 * 复制到剪贴板：优先 `navigator.clipboard`，退回 `execCommand`（Http / 老 WebView 都能用）。
 *
 * 为什么给 `navigator.clipboard` 加超时：在无头浏览器 / 没有用户激活的上下文里，
 * `writeText()` 可能**既不 resolve 也不 reject**（等一个永远不会给的权限决定），
 * 那样按钮会一直停在「没反应」。800ms 没有结论就当它不可用，走兜底。
 */
const CLIPBOARD_TIMEOUT_MS = 800

const copyViaClipboard = async (text: string): Promise<boolean> => {
  try {
    if (typeof navigator === 'undefined' || navigator.clipboard === undefined) return false
    const write = navigator.clipboard.writeText(text)
    // 竞速之后仍要挂一个 catch：否则超时先到、write 后 reject 会变成 unhandledRejection
    void write.catch(() => undefined)
    return await Promise.race([
      write.then(() => true, () => false),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), CLIPBOARD_TIMEOUT_MS)
      }),
    ])
  } catch {
    return false
  }
}

const copyText = async (text: string): Promise<boolean> => {
  if (await copyViaClipboard(text)) return true
  try {
    if (typeof document === 'undefined') return false
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '0'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}

/** 复制状态：`id` 命中的那一行显示「已复制」/「复制失败」，1.4 秒后复原。 */
type CopyFeedback = { workspaceId: string; ok: boolean }

export const WorkspaceList = ({
  items,
  onSelect,
  emptyHint,
  label,
  testId = 'workspace-list',
}: {
  items: readonly WorkspaceListItem[]
  /** 选中一行（`disabled` 的行不会触发）。 */
  onSelect?: (item: WorkspaceListItem) => void
  /** 一条都没有时的一行说明（`undefined` 就不占位）。 */
  emptyHint?: string
  /** 无障碍名称（列表本身）。 */
  label: string
  testId?: string
}) => {
  const t = useTranslate()
  const preferences = useNewSessionStore((state) => state.workspacePreferences)
  const sections = workspaceSections(items, preferences)
  const [feedback, setFeedback] = useState<CopyFeedback | null>(null)
  const timerRef = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    },
    [],
  )

  const copy = (item: WorkspaceListItem): void => {
    if (item.path.length === 0) return
    void copyText(item.path).then((ok) => {
      setFeedback({ workspaceId: item.workspaceId, ok })
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        setFeedback(null)
      }, 1_400)
    })
  }

  return (
    <div className={styles.list} role="group" aria-label={label} data-testid={testId}>
      {sections.flatMap((section) => {
        const title = section.kind === 'pinned' ? t('remoteWorkspacePinnedSection')
          : section.name ?? (sections.length > 1 ? t('remoteWorkspaceOtherSection') : null)
        return [
          title === null ? null : (
            <div className={styles.sectionTitle} key={section.kind === 'group' ? `group:${title}` : section.kind}>
              {title}
            </div>
          ),
          ...section.items.map(renderItem),
        ]
      })}
      {items.length === 0 && emptyHint !== undefined ? (
        <div className={styles.empty}>{emptyHint}</div>
      ) : null}
    </div>
  )

  function renderItem(item: WorkspaceListItem) {
    const sessionCount = item.sessionCount
    const showCount = sessionCount !== undefined && (sessionCount > 0 || item.countKnown === true)
    const copied = feedback !== null && feedback.workspaceId === item.workspaceId
    return (
      <div
        key={`workspace:${item.workspaceId}`}
        className={clsx(
          styles.row,
          item.current === true && styles.rowCurrent,
          item.disabled === true && styles.rowDisabled,
        )}
        data-workspace-id={item.workspaceId}
        data-current={item.current === true ? '1' : undefined}
        data-no-sessions={item.countKnown === true && sessionCount === 0 ? '1' : undefined}
      >
        <span className={styles.icon} aria-hidden>
          <IconBrowseOutline16 />
        </span>
        <div className={styles.text}>
          <button
            type="button"
            className={styles.titleButton}
            aria-pressed={item.current === true}
            aria-current={item.current === true ? 'true' : undefined}
            disabled={item.disabled === true}
            onClick={() => {
              if (item.disabled === true) return
              onSelect?.(item)
            }}
          >
            <span className={styles.title}>{item.title}</span>
            {showCount ? (
              <span className={styles.count}>
                {sessionCount === 0
                  ? t('workspaces.noSessions')
                  : t('workspaces.sessionCount', { count: sessionCount ?? 0 })}
              </span>
            ) : null}
            {item.current === true ? (
              <span className={styles.current}>
                <span className={styles.currentGlyph} aria-hidden>
                  <IconCheckOutline16 />
                </span>
                {t('workspaces.current')}
              </span>
            ) : null}
          </button>
          {/*
            路径是**独立按钮**：点它只复制，不选中（否则想复制路径的人会被带去切工作区）。
            `title` 给全长，行内按 CSS 省略。
          */}
          {item.path.length === 0 ? null : (
            <button
              type="button"
              className={clsx(styles.pathButton, copied && styles.pathButtonActive)}
              title={item.path}
              aria-label={`${t('workspaces.copyPath')}: ${item.path}`}
              onClick={() => copy(item)}
            >
              <span className={styles.path}>{item.path}</span>
              <span className={styles.copyGlyph} aria-hidden>
                <IconCopyOutline16 />
              </span>
              {copied ? (
                <span className={styles.copyHint} role="status">
                  {feedback?.ok === true ? t('workspaces.copied') : t('workspaces.copyFailed')}
                </span>
              ) : null}
            </button>
          )}
          {item.hint === undefined ? null : <div className={styles.hint}>{item.hint}</div>}
        </div>
      </div>
    )
  }
}
