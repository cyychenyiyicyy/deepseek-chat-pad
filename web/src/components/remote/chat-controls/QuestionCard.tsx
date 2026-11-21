import { useEffect, useState } from 'react'
import { useTranslate } from '../../../i18n/index.js'
import type { QuestionActivity } from '../../../services/remote/adapter.js'
import {
  allQuestionsAnswered,
  questionKey,
  useChatControls,
  type RemoteQuestionItem,
} from '../../../services/remote/sessionControls.js'
import { Button } from '../../base/Button.js'
import { IconCheckOutline16, IconWarningOutline16 } from '../../base/icons.js'
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
 * 选项语义照官方 `screens/chat/messages.tsx:706-800`：
 *  - 单选：选一个；**自定义文本与选项互斥**（填了文本就清掉选项，取消选项时不清文本）；
 *  - 多选：可多选，且允许同时补一句自定义文本；
 *  - 每条问题都给了选择或文本才允许提交。
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
  const active = deadline !== undefined && state?.phase === 'open'
  useEffect(() => {
    if (!active) return undefined
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [active, deadline])

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

  const toggle = (question: RemoteQuestionItem, label: string): void => {
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

  const terminal = state?.phase === 'answered' || state?.phase === 'queued' || state?.phase === 'cancelled'
  if (terminal) {
    const text =
      state?.phase === 'answered'
        ? t('chatControlsQuestionAnswered')
        : state?.phase === 'queued'
          ? t('chatControlsQuestionQueued')
          : t('chatControlsQuestionCancelled')
    return (
      <div className={styles.resolved} role="status">
        <span className={state?.phase === 'cancelled' ? styles.resolvedIconMuted : styles.resolvedIcon}>
          {state?.phase === 'cancelled' ? <IconWarningOutline16 /> : <IconCheckOutline16 />}
        </span>
        {text}
      </div>
    )
  }

  const claiming = state === undefined || state.phase === 'claiming'
  const answerable = !claiming && !windowClosed && state?.submitting !== true
  const ready = allQuestionsAnswered(questions, selected, custom)
  const headline =
    state?.phase === 'continued'
      ? t('chatControlsQuestionContinued')
      : windowClosed
        ? t('chatControlsQuestionExpired')
        : remaining === undefined
          ? t('chatControlsQuestionClaiming')
          : t('chatControlsQuestionRemaining', { seconds: remaining })

  return (
    <div className={styles.card} role="group" aria-label={t('chatControlsQuestionTitle')}>
      <div className={styles.head}>
        <span className={styles.icon} aria-hidden>
          <IconWarningOutline16 />
        </span>
        <div className={styles.headCopy}>
          <div className={styles.title}>{t('chatControlsQuestionTitle')}</div>
          <div className={windowClosed && state?.phase !== 'continued' ? styles.subtitleWarn : styles.subtitle}>
            {claiming ? t('chatControlsQuestionClaiming') : headline}
          </div>
        </div>
      </div>

      {questions.map((question) => (
        <div className={styles.block} key={question.id}>
          <div className={styles.question}>{question.question}</div>
          {question.detail === undefined ? null : <div className={styles.detail}>{question.detail}</div>}
          {question.options.map((option) => {
            const chosen = (selected[question.id] ?? []).includes(option.label)
            return (
              <button
                key={option.label}
                type="button"
                className={chosen ? `${styles.option} ${styles.optionChosen}` : styles.option}
                aria-pressed={chosen}
                disabled={!answerable}
                onClick={() => toggle(question, option.label)}
              >
                <span className={chosen ? `${styles.dot} ${styles.dotChosen}` : styles.dot} aria-hidden>
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
          <textarea
            className={styles.custom}
            rows={2}
            placeholder={t('chatControlsQuestionCustom')}
            aria-label={t('chatControlsQuestionCustomAria', { question: question.question })}
            value={custom[question.id] ?? ''}
            disabled={!answerable}
            onChange={(event) => {
              const text = event.target.value
              // 单选：一旦开始写自定义文本就清掉选项（与官方语义一致）
              if (!question.multiSelect && text.trim().length > 0) {
                setSelected((current) => ({ ...current, [question.id]: [] }))
              }
              setCustom((current) => ({ ...current, [question.id]: text }))
            }}
          />
        </div>
      ))}

      {state?.error === undefined ? null : <div className={styles.error}>{state.error}</div>}

      <div className={styles.actions}>
        <Button
          variant="primary"
          size="m"
          disabled={key === null || !answerable || !ready}
          onClick={() => {
            if (key === null) return
            void answerQuestion(key, selected, custom)
          }}
        >
          {state?.submitting === true ? t('chatControlsQuestionSubmitting') : t('chatControlsQuestionSubmit')}
        </Button>
      </div>
    </div>
  )
}
