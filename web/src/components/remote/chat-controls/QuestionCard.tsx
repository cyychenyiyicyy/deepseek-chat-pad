import { useEffect, useState } from 'react'
import { useTranslate } from '../../../i18n/index.js'
import type { QuestionActivity } from '../../../services/remote/adapter.js'
import {
  questionKey,
  useChatControls,
  type RemoteQuestionItem,
} from '../../../services/remote/sessionControls.js'
import { Button } from '../../base/Button.js'
import { IconCheckOutline16, IconWarningOutline16 } from '../../base/icons.js'
import {
  MAX_ANSWER_CHARS,
  clampAnswerText,
  isQuestionCardDead,
  isQuestionCardTerminal,
  questionCardStatus,
  questionFormStatus,
} from './promptModel.js'
import styles from './QuestionCard.module.css'

/**
 * 时间线里的**用户提问卡**（`$events` 的 waterfall `user-questions/request`）。
 *
 * 状态机不在组件里，在 `sessionControls` 的 store 里（`RemoteQuestionState.phase`）：
 * ```
 * claiming ──attachWait 首帧──► open ──窗口到期──► expired
 *                                │                   └─投影 continued─► continued
 *                                └─$events/result──────► answered
 *  continued ──userQuestions/answer──► queued
 *  （任意阶段）Host cancel / 投影 settled ──► cancelled
 * ```
 * 组件只做三件事：本地记「选了哪几项 / 自定义文本」、画倒计时、把答案交给 `answerQuestion()`。
 *
 * 三种形态（选项语义照官方 `screens/chat/messages.tsx:706-800`）：
 *  - **单选**：选一个；**自定义文本与选项互斥**（填了文本就清掉选项，取消选项时不清文本）；
 *  - **多选**：可多选，且允许同时补一句自定义文本（提交时多个 label 一起进 `selected[]`）；
 *  - **自由输入**：没有选项时只能写字，`MAX_ANSWER_CHARS` 上限 + 逐条提交校验。
 *
 * 终态**不删卡片**：答过就留「已回答 + 你选了什么」，超时/撤回/没有句柄就留「已失效」并置灰，
 * 这样回看时间线能知道当时问了什么、我答了什么。
 */
export const QuestionCard = ({ item }: { item: QuestionActivity }) => {
  const t = useTranslate()
  const key = questionKey({
    ...(item.callId === undefined ? {} : { callId: item.callId }),
    ...(item.frameRpcId === undefined ? {} : { eventId: item.frameRpcId }),
  })
  const state = useChatControls((current) => (key === null ? undefined : current.questions[key]))
  const answerQuestion = useChatControls((current) => current.answerQuestion)

  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const [custom, setCustom] = useState<Record<string, string>>({})
  const [now, setNow] = useState(() => Date.now())

  const deadline = state?.deadline
  const ticking = deadline !== undefined && state?.phase === 'open'
  useEffect(() => {
    if (!ticking) return undefined
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [ticking, deadline])

  const questions: RemoteQuestionItem[] =
    state?.questions !== undefined && state.questions.length > 0
      ? state.questions
      : item.questions.map((question) => ({
          id: question.id,
          question: question.question,
          ...(question.detail === undefined ? {} : { detail: question.detail }),
          ...(question.header === undefined ? {} : { header: question.header }),
          options: (question.options ?? []).map((option) => ({
            label: option.label,
            ...(option.description === undefined ? {} : { description: option.description }),
          })),
          multiSelect: question.multiSelect === true,
        }))

  const remainingMs = deadline === undefined ? undefined : Math.max(0, deadline - now)
  const remaining = remainingMs === undefined ? undefined : Math.ceil(remainingMs / 1000)
  const windowClosed = state?.phase === 'expired' || (remainingMs !== undefined && remainingMs === 0)

  const status = questionCardStatus({
    ...(state?.phase === undefined ? {} : { phase: state.phase }),
    windowClosed,
    ...(item.outcome === undefined ? {} : { outcome: item.outcome }),
  })
  const terminal = isQuestionCardTerminal(status)
  const dead = isQuestionCardDead(status)
  const answerable = !terminal && status !== 'claiming' && state?.submitting !== true
  const form = questionFormStatus(questions, selected, custom)

  const toggle = (question: RemoteQuestionItem, label: string): void => {
    if (!answerable) return
    const values = selected[question.id] ?? []
    const next = question.multiSelect
      ? values.includes(label)
        ? values.filter((value) => value !== label)
        : [...values, label]
      : values.includes(label)
        ? []
        : [label]
    // 单选的「自定义文本」和选项互斥：选中选项时清空文本（只是取消选择时不清，否则用户刚打的字没了）
    if (!question.multiSelect && next.length > 0) {
      setCustom((current) => ((current[question.id] ?? '') === '' ? current : { ...current, [question.id]: '' }))
    }
    setSelected((current) => ({ ...current, [question.id]: next }))
  }

  const headline =
    status === 'claiming'
      ? t('promptuxQuestionClaiming')
      : status === 'continued'
        ? t('promptuxQuestionContinued')
        : status === 'expired'
          ? t('promptuxQuestionExpired')
          : status === 'stale'
            ? t('promptuxQuestionStale')
            : status === 'answered'
              ? t('promptuxQuestionAnsweredHint')
              : status === 'queued'
                ? t('promptuxQuestionQueuedHint')
                : status === 'cancelled'
                  ? t('promptuxQuestionCancelledHint')
                  : remaining === undefined
                    ? t('promptuxQuestionOpen')
                    : t('promptuxQuestionRemaining', { seconds: remaining })

  const badge =
    status === 'answered'
      ? t('promptuxQuestionAnswered')
      : status === 'queued'
        ? t('promptuxQuestionQueued')
        : dead
          ? t('promptuxQuestionExpiredBadge')
          : undefined

  return (
    <div
      className={styles.card}
      role="group"
      aria-label={t('promptuxQuestionTitle')}
      data-status={status}
    >
      <div className={styles.head}>
        <span className={dead ? styles.iconMuted : styles.icon} aria-hidden>
          <IconWarningOutline16 />
        </span>
        <div className={styles.headCopy}>
          <div className={styles.title}>{t('promptuxQuestionTitle')}</div>
          <div className={status === 'expired' || status === 'stale' ? styles.subtitleWarn : styles.subtitle}>
            {headline}
          </div>
        </div>
        {badge === undefined ? null : (
          <span className={dead ? styles.statusDead : styles.statusDone} role="status">
            {dead ? <IconWarningOutline16 /> : <IconCheckOutline16 />}
            {badge}
          </span>
        )}
      </div>

      {questions.map((question, index) => {
        const values = selected[question.id] ?? []
        const text = custom[question.id] ?? ''
        const count = text.length
        return (
          <div className={styles.block} key={question.id}>
            <div className={styles.questionRow}>
              {questions.length > 1 ? <span className={styles.questionIndex}>{index + 1}</span> : null}
              <span className={styles.question}>{question.question}</span>
            </div>
            {question.detail === undefined ? null : <div className={styles.detail}>{question.detail}</div>}
            {question.options.length > 0 ? (
              <div className={styles.modeHint}>
                {question.multiSelect ? t('promptuxQuestionMultiHint') : t('promptuxQuestionSingleHint')}
              </div>
            ) : null}
            {question.options.map((option) => {
              const chosen = values.includes(option.label)
              return (
                <button
                  key={option.label}
                  type="button"
                  className={chosen ? `${styles.option} ${styles.optionChosen}` : styles.option}
                  aria-pressed={chosen}
                  disabled={!answerable}
                  onClick={() => toggle(question, option.label)}
                >
                  <span
                    className={
                      chosen
                        ? `${question.multiSelect ? styles.box : styles.dot} ${styles.markChosen}`
                        : question.multiSelect
                          ? styles.box
                          : styles.dot
                    }
                    aria-hidden
                  >
                    {chosen ? <IconCheckOutline16 /> : null}
                  </span>
                  <span className={styles.optionCopy}>
                    <span className={styles.optionLabel}>{option.label}</span>
                    {option.description === undefined ? null : (
                      <span className={styles.optionDescription}>{option.description}</span>
                    )}
                  </span>
                </button>
              )
            })}
            <div className={styles.customWrap}>
              <textarea
                className={styles.custom}
                rows={question.options.length > 0 ? 2 : 3}
                maxLength={MAX_ANSWER_CHARS}
                placeholder={
                  question.options.length > 0
                    ? t('promptuxQuestionCustomPlaceholder')
                    : t('promptuxQuestionFreePlaceholder')
                }
                aria-label={t('promptuxQuestionCustomAria', { question: question.question })}
                value={text}
                disabled={!answerable}
                onChange={(event) => {
                  const next = clampAnswerText(event.target.value)
                  // 单选：一旦开始写自定义文本就清掉选项（与官方语义一致）
                  if (!question.multiSelect && next.trim().length > 0) {
                    setSelected((current) => ({ ...current, [question.id]: [] }))
                  }
                  setCustom((current) => ({ ...current, [question.id]: next }))
                }}
              />
              {count > 0 ? (
                <div className={count >= MAX_ANSWER_CHARS ? styles.counterFull : styles.counter}>
                  {t('promptuxQuestionCounter', { count, max: MAX_ANSWER_CHARS })}
                </div>
              ) : null}
            </div>
          </div>
        )
      })}

      {state?.error === undefined ? null : <div className={styles.error}>{state.error}</div>}

      {terminal ? null : (
        <div className={styles.actions}>
          {answerable && !form.ready ? (
            <div className={styles.pendingHint}>
              {form.overLimit
                ? t('promptuxQuestionOverLimit', { max: MAX_ANSWER_CHARS })
                : t('promptuxQuestionMissing', { count: form.missing })}
            </div>
          ) : null}
          <Button
            variant="primary"
            size="m"
            className={styles.submit}
            disabled={key === null || !answerable || !form.ready}
            onClick={() => {
              if (key === null) return
              void answerQuestion(key, selected, custom)
            }}
          >
            {state?.submitting === true ? t('promptuxQuestionSubmitting') : t('promptuxQuestionSubmit')}
          </Button>
        </div>
      )}
    </div>
  )
}
