import clsx from 'clsx'
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { useTranslate } from '../../../i18n/index.js'
import { useSessionLive } from '../../../services/remote/liveSessions.js'
import {
  showsModelCapsule,
  showsPermissionCapsule,
  useChatControls,
} from '../../../services/remote/sessionControls.js'
import { IconSendOutline16, IconStopFill16 } from '../../base/icons.js'
import { ModelCapsule } from '../chat-controls/ModelCapsule.js'
import { PermissionCapsule } from '../chat-controls/PermissionCapsule.js'
import styles from './Composer.module.css'
import { composerLiveView, type ComposerView, type PromptMode } from './composerState.js'

/**
 * 输入框内部最下面那一行：**模型胶囊 + 权限胶囊 + 提示 + 插话/排队 + 发送 / 停止**。
 *
 * 形状按 dsh-Go 的「两行形态」：第一行是输入（textarea），第二行左侧是
 * 「模型 · 思考强度」胶囊、右边是权限胶囊，最右是发送/停止（R1 §「布局参考」）。
 * 这一行取代了原来顶栏右侧的 `SessionControlsBar`（顶栏现在只剩标题 + transport 徽标 + `⋯`）。
 *
 * 按钮规则（S3 复核后，原文见 `composerState.ts` 的 `resolveComposerView`）：
 * ```
 * 在跑 + 输入框为空 → [＋] [胶囊]   [插话|排队]        [→ 灰] [■]      ← 主位是停止
 * 在跑 + 有内容      → [＋] [胶囊]   [插话|排队]        [■]     [↑]      ← 主位是发送
 * 空闲               → [＋] [胶囊]                       [↑]
 * ```
 * 第二颗钮永远在「另一个动作」上：主位被停止占了就放发送，主位是发送就放停止。
 *
 * **运行态从两处来**：`view.running`（`store.streaming`）与**全局运行态**
 * （`liveSessions.ts`，`session/list` + `$events` 得来）。后者是「用户带着一个已经在跑的
 * 会话进 App」时唯一知道它在跑的东西 —— 少了它，按钮就永远停在发送。
 *
 * 三条布局约束（对应「移动端要能用」这条验收）：
 *  1. `.pills` 自己 `flex-wrap` —— 窄屏时模型胶囊和权限胶囊**换行**，不是被挤成省略号；
 *  2. `.hint` 在 <768px 隐藏（说明性文案，手机上没有位置），
 *     但「生成中 / 停止超时」那条仍然显示，因为它说的是「你点的东西发生了什么事」；
 *  3. `.actions` 永不收缩，停止/发送按钮位置固定 —— 用户按肌肉记忆点它。
 *
 * 能力门禁照旧在渲染层判（`showsModelCapsule` / `showsPermissionCapsule`）：
 * Host 缺哪个就只少哪个，两个都没有时中间那块整块不占位。
 */
export const ComposerRow = ({
  view,
  hint,
  sendMode,
  modeSupported,
  leading,
  onSubmit,
  onStop,
  onSecondarySend,
  onModeChange,
}: {
  view: ComposerView
  /** 提示文案（由 `composerHint` 的 key 翻好传进来） */
  hint: string
  /** 运行中发送用哪种 mode（插话 / 排队） */
  sendMode: PromptMode
  /** 数据层是否支持指定 mode（`composer/promptMode.ts` 的能力探测结果） */
  modeSupported: boolean
  /** 行首的附加按钮（附件 `+`） */
  leading?: ReactNode
  /** 主按钮：发送 / 执行命令 */
  onSubmit: () => void
  /** 生成中：主按钮变停止 */
  onStop: () => void
  /** 第二颗钮是发送时用（主位被停止占着） */
  onSecondarySend: () => void
  onModeChange: (mode: PromptMode) => void
}) => {
  const t = useTranslate()
  const showsModel = useChatControls(showsModelCapsule)
  const showsPermission = useChatControls(showsPermissionCapsule)
  const hasPills = showsModel || showsPermission
  /*
   * 全局运行态校正：`view.running` 是 `store.streaming`，只有「当前会话的 follow 增量」
   * 喂它；而打开一个已经在跑的会话时那条增量早就走完了。所以这里并上全局运行态
   * （`session/list` 的 `running` + `$events` 的 `api-session/*`）。
   */
  const liveRunning = useSessionLive(view.signals.sessionId)?.running === true
  const shown = composerLiveView(view, view.running || liveRunning)

  const primaryLabel =
    shown.primary === 'stop'
      ? t('remoteStop')
      : shown.primary === 'command'
        ? t('chatControlsRunCommand')
        : t('send')
  const secondaryLabel =
    shown.secondaryAction === 'stop'
      ? t('remoteStop')
      : sendMode === 'steer'
        ? t('composerSteerSendAria')
        : t('composerQueueSendAria')

  return (
    <div className={styles.row} data-composer-primary={shown.primary} data-composer-mode={sendMode}>
      {leading}
      {hasPills ? (
        <div className={styles.pills}>
          {showsModel ? <ModelCapsule /> : null}
          {showsPermission ? <PermissionCapsule /> : null}
        </div>
      ) : null}
      <span
        className={clsx(styles.hint, shown.busy && styles.hintBusy)}
        role="status"
        title={hint}
      >
        {hint}
      </span>
      <div className={styles.actions}>
        {shown.modeToggleVisible ? (
          <div className={styles.modeToggle} role="group" aria-label={t('composerModeAria')}>
            <button
              type="button"
              className={clsx(
                styles.modeOption,
                sendMode === 'steer' && styles.modeOptionActive,
                !modeSupported && styles.modeOptionDim,
              )}
              aria-pressed={sendMode === 'steer'}
              aria-label={t('composerSteerModeAria')}
              title={modeSupported ? t('composerSteerModeAria') : t('composerSteerUnsupported')}
              onClick={() => onModeChange('steer')}
            >
              {t('composerSteerMode')}
            </button>
            <button
              type="button"
              className={clsx(styles.modeOption, sendMode === 'queue' && styles.modeOptionActive)}
              aria-pressed={sendMode === 'queue'}
              aria-label={t('composerQueueModeAria')}
              title={t('composerQueueModeAria')}
              onClick={() => onModeChange('queue')}
            >
              {t('composerQueueMode')}
            </button>
          </div>
        ) : null}
        {shown.secondaryAction === 'send' ? (
          <button
            type="button"
            className={clsx(styles.secondary, !shown.secondaryEnabled && styles.disabled)}
            aria-label={secondaryLabel}
            aria-disabled={!shown.secondaryEnabled}
            title={secondaryLabel}
            onClick={onSecondarySend}
          >
            <IconSendOutline16 />
          </button>
        ) : null}
        {shown.secondaryAction === 'stop' ? (
          <button
            type="button"
            className={clsx(styles.secondary, styles.secondaryStop)}
            aria-label={secondaryLabel}
            title={secondaryLabel}
            onClick={onStop}
          >
            <IconStopFill16 />
          </button>
        ) : null}
        {shown.primary === 'stop' ? (
          <button
            type="button"
            className={clsx(styles.primary, styles.stop)}
            aria-label={t('remoteStop')}
            title={t('remoteStop')}
            onClick={onStop}
          >
            <IconStopFill16 />
          </button>
        ) : (
          <button
            type="button"
            className={clsx(styles.primary, !shown.primaryEnabled && styles.disabled)}
            aria-label={primaryLabel}
            aria-disabled={!shown.primaryEnabled}
            title={primaryLabel}
            onClick={onSubmit}
          >
            <IconSendOutline16 />
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * 输入区胶囊组自己的挂载点：`probe()` 挂在这里（模型目录 / 权限预设 / 命令列表各探一次）。
 *
 * 为什么不在 `ComposerRow` 里探：`ComposerRow` 是纯展示（截图脚本会直接喂假 view），
 * 把一次网络探测塞进去会让它没法单独渲染。
 */
export const useComposerProbe = (sessionId: string | null): void => {
  const probe = useChatControls((state) => state.probe)
  // 换会话 / 首次挂载：各入口探一次（内部有「已有数据就不重复拉」的短路）
  useEffect(() => {
    void probe()
  }, [probe, sessionId])
}
