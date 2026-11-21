import clsx from 'clsx'
import { useTranslate } from '../../../i18n/index.js'
import type { RemoteDirectoryListing } from '../../../services/remote/sessionsApi.js'
import { IconChevronRightOutline14 } from '../../base/icons.js'
import styles from './NewSessionPage.module.css'

/**
 * 目录浏览（`directoryPicker/list`）。
 *
 * 只做一层：当前目录 + 子目录列表 + 「上一级」 + 「用这个目录」。为什么不做树：
 * Host 侧的 `directoryPicker/list` 本来就是单层接口（`{path?}` → `{path, entries}`），
 * 一层一层点下去正好符合远端权限边界（也不至于一次拉一棵大树）。
 *
 * **不支持就消失**：Host 没有这个端点时调用方（`NewSessionForm`）根本不会挂载本组件，
 * 这里只负责正常态与失败态，不自己探测能力。
 */
export const DirectoryBrowser = ({
  listing,
  loading,
  error,
  onBrowse,
  onPick,
}: {
  listing: RemoteDirectoryListing | null
  loading: boolean
  error: string | null
  onBrowse: (path: string | undefined) => void
  onPick: (path: string) => void
}) => {
  const t = useTranslate()
  const current = listing?.path ?? ''
  const parent = parentOf(current)
  const directories = (listing?.entries ?? []).filter((entry) => entry.path.length > 0)

  return (
    <div className={styles.browser}>
      <div className={styles.browserBar}>
        <button
          type="button"
          className={styles.browserUp}
          disabled={parent === undefined}
          onClick={() => onBrowse(parent)}
        >
          {t('newSessionBrowseUp')}
        </button>
        <span className={styles.browserPath} title={current}>
          {current}
        </span>
      </div>
      {loading ? <div className={styles.hint}>{t('newSessionBrowseLoading')}</div> : null}
      {error !== null ? <div className={styles.error}>{error}</div> : null}
      {!loading && listing !== null && directories.length === 0 ? (
        <div className={styles.hint}>{t('newSessionBrowseEmpty')}</div>
      ) : null}
      {directories.length > 0 ? (
        <div className={styles.browserList} role="listbox" aria-label={t('newSessionBrowse')}>
          {directories.map((entry) => (
            <div key={entry.path} className={clsx(styles.browserRow, entry.hidden && styles.browserRowHidden)}>
              <button
                type="button"
                className={styles.browserEntry}
                role="option"
                aria-selected={false}
                onClick={() => onBrowse(entry.path)}
              >
                <span className={styles.browserName}>{entry.name}</span>
                <span className={styles.browserChevron} aria-hidden>
                  <IconChevronRightOutline14 />
                </span>
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {current.length > 0 ? (
        <div className={styles.pathActions}>
          <button type="button" className={styles.linkButton} onClick={() => onPick(current)}>
            {t('newSessionBrowsePick')}
          </button>
        </div>
      ) : null}
    </div>
  )
}

/**
 * 上一级目录。POSIX 与 Windows 都按「最后一个分隔符之前」算；
 * 根（`/` 或 `C:\`）再往上没有意义，返回 `undefined`（按钮置灰）。
 */
export const parentOf = (path: string): string | undefined => {
  if (path.length === 0) return undefined
  const unified = path.replace(/\\/g, '/')
  const trimmed = unified.endsWith('/') && unified.length > 1 ? unified.slice(0, -1) : unified
  const cut = trimmed.lastIndexOf('/')
  if (cut < 0) return undefined
  if (cut === 0) return '/' // POSIX 根
  const parent = trimmed.slice(0, cut)
  // Windows 盘符根：`C:` → `C:/`
  return /^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent
}
