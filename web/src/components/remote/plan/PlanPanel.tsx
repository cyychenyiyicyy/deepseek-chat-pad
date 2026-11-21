import clsx from 'clsx'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { useIsMobile } from '../../../app/viewport.js'
import { useTranslate } from '../../../i18n/index.js'
import {
  planModeActive,
  planModeTarget,
  usePlanState,
} from '../../../services/remote/planState.js'
import { Button } from '../../base/Button.js'
import { IconButton } from '../../base/IconButton.js'
import { IconCloseOutline16, IconCopyOutline16 } from '../../base/icons.js'
import { Markdown } from '../../markdown/Markdown.js'
import styles from './PlanPanel.module.css'

/**
 * 计划面板：把 `exit_plan_mode` 提交的那份 markdown 正文完整读一遍。
 *
 * 为什么是抽屉而不是弹窗：正文是长 markdown（官方也是开右侧边栏标签页），
 * 抽屉能给出整屏高度且不挡住输入区；手机上退化成整屏 sheet。
 *
 * 正文来源只有时间线（`planState.planTextFromItems`）：
 *   - plan-review 提问的 `detail`（最准，Host 提交后立刻推）；
 *   - 兜底用 `exit_plan_mode` 工具调用的 `args.plan`。
 * 两者都拿不到 → 显示一句「还没有提交计划」，**不编内容**。
 *
 * 复制：优先 `navigator.clipboard`，老 WebView 退回 `document.execCommand('copy')`。
 */
export const PlanPanel = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const open = usePlanState((state) => state.panelOpen)
  const setPanelOpen = usePlanState((state) => state.setPanelOpen)
  const planText = usePlanState((state) => state.planText)
  const mode = usePlanState((state) => state.mode)

  /** `idle` → `copied` / `failed`（2 秒后自己回到 idle，不弹通知） */
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timerRef = useRef<number | null>(null)

  const close = useCallback(() => {
    setPanelOpen(false)
    setCopyState('idle')
  }, [setPanelOpen])

  // 视图一开就回 idle；关掉时清计时器，免得 2 秒后又 setState 一个已经卸载的组件
  useEffect(() => {
    if (!open) {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
      return undefined
    }
    setCopyState('idle')
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [open])

  // Esc 关抽屉（与其它面板一致）
  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [close, open])

  if (!open) return null

  const text = planText?.text ?? ''
  const title = planText?.heading ?? t('planViewTitle')
  const canCopy = text.length > 0
  // `pending` 时目标态是取反的：面板上顺手标一句「正在退出」，与入口胶囊一致
  const target = planModeTarget(mode)
  const stateHint = planModeActive(mode)
    ? mode?.pending === true
      ? target
        ? t('planModeEntering')
        : t('planModeLeaving')
      : mode?.active === true
        ? t('planModeOn')
        : t('planModeOff')
    : t('planModeOff')

  const copy = (): void => {
    if (!canCopy) return
    const done = (ok: boolean): void => {
      setCopyState(ok ? 'copied' : 'failed')
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        setCopyState('idle')
      }, 2000)
    }
    void writeClipboard(text)
      .then(done)
      .catch(() => done(false))
  }

  return createPortal(
    <div className={styles.overlay} role="presentation" onClick={close}>
      <div
        className={clsx(styles.panel, isMobile ? styles.panelMobile : styles.panelSide)}
        role="dialog"
        aria-modal="true"
        aria-label={t('planViewTitle')}
        data-testid="plan-panel"
        // 抽屉自己吞掉点击：点正文不该关面板
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.header}>
          <span className={styles.title} title={title}>
            {title}
          </span>
          <span className={styles.state} data-active={planModeActive(mode) ? '1' : '0'}>
            {stateHint}
          </span>
          <Button variant="outlined" size="s" onClick={copy} disabled={!canCopy}>
            <span className={styles.copyIcon} aria-hidden>
              <IconCopyOutline16 />
            </span>
            {copyState === 'copied'
              ? t('planViewCopied')
              : copyState === 'failed'
                ? t('planViewCopyFailed')
                : t('planViewCopy')}
          </Button>
          <IconButton size="xs" tooltip={t('planViewClose')} icon={<IconCloseOutline16 />} onClick={close} />
        </div>

        {canCopy ? (
          <div className={styles.body}>
            <Markdown
              className="ds-assistant-message-main-content"
              content={text}
              loading={false}
              cacheKey={`plan:${planText?.callId ?? text.length}`}
              disableLink={false}
            />
          </div>
        ) : (
          <div className={styles.empty}>{t('planViewEmpty')}</div>
        )}
      </div>
    </div>,
    document.body,
  )
}

/**
 * 写剪贴板。
 *
 * `navigator.clipboard` 在非安全上下文（WebView 里 `file://` / http 局域网地址）是 **undefined**，
 * 所以必须留一条 `execCommand` 的老路，否则「复制」在平板上点了没反应。
 */
const writeClipboard = async (text: string): Promise<boolean> => {
  const clipboard = globalThis.navigator?.clipboard
  if (clipboard !== undefined && typeof clipboard.writeText === 'function') {
    await clipboard.writeText(text)
    return true
  }
  if (typeof document === 'undefined') return false
  const area = document.createElement('textarea')
  area.value = text
  // 放到视口外，避免点开抽屉时页面抖一下
  area.setAttribute('readonly', 'readonly')
  area.style.position = 'fixed'
  area.style.top = '-1000px'
  area.style.opacity = '0'
  document.body.appendChild(area)
  try {
    area.select()
    return document.execCommand('copy')
  } finally {
    document.body.removeChild(area)
  }
}
