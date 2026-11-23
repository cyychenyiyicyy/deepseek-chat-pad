import { useMemo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import type { ChatItem, ToolActivity } from '../../services/remote/adapter.js'
import { sessionArtifacts, turnArtifactsOf } from '../../services/remote/artifacts.js'
import { usePlanState } from '../../services/remote/planState.js'
import { stripDsml } from '../../services/api/dsml.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { Markdown } from '../markdown/Markdown.js'
import { ArtifactTile } from './artifact/ArtifactCard.js'
import artifactStyles from './artifact/Artifact.module.css'
import { SessionInfoPanel } from './chat-controls/SessionInfoPanel.js'
import { aggregateUsage, formatTokens } from './chat-controls/usage.js'
import styles from './RemoteManagementDialog.module.css'
import { ToolCard } from './tool/ToolCard.js'

const tabs = ['remoteDetailsTrace', 'remoteDetailsChanges', 'remoteDetailsFiles', 'remoteDetailsProgress', 'remoteDetailsContext'] as const
type DetailTab = typeof tabs[number]

export default function RemoteSessionDetails({ items, sessionId, title, onClose, onGoal }: {
  items: readonly ChatItem[]
  sessionId: string
  title: string
  onClose(): void
  onGoal(): void
}) {
  const t = useTranslate()
  const [tab, setTab] = useState<DetailTab>(tabs[0])
  const todos = usePlanState((state) => state.sessionId === sessionId ? state.todos : undefined)
  const plan = usePlanState((state) => state.sessionId === sessionId ? state.planText : null)
  const { trace, changes, files, usageRows, usage } = useMemo(() => {
    const turns = new Map<string, ChatItem[]>()
    const changes: ToolActivity[] = []
    for (const item of items) {
      if (item.sessionId !== sessionId) continue
      if (item.kind === 'tool' && (item.resultDetail?.kind === 'diff' || item.callDetail?.kind === 'diff')) changes.push(item)
      if (item.turn !== undefined) {
        const turn = turns.get(item.turn) ?? []
        turn.push(item)
        turns.set(item.turn, turn)
      }
    }
    return { trace: Array.from(turns).reverse(), changes, files: sessionArtifacts(turnArtifactsOf(items)), usage: aggregateUsage(items),
      usageRows: [...turns].reverse().flatMap(([turn, rows]) => {
        const usage = aggregateUsage(rows)
        return usage ? [{ turn, count: usage.totalTokens ?? usage.inputTokens + usage.outputTokens }] : []
      }).slice(0, 12) }
  }, [items, sessionId])

  return <Modal title={t('remoteSessionDetails')} onClose={onClose} closable className={styles.modal} mainClassName={styles.body}>
    <div className={styles.layout}>
      <nav className={styles.actions} aria-label={t('remoteSessionDetails')}>
        {tabs.map((item) => <Button key={item} size="m" variant={tab === item ? 'primary' : 'outlined'}
          aria-pressed={tab === item} onClick={() => setTab(item)}>{t(item)}</Button>)}
      </nav>
      {tab === 'remoteDetailsTrace' && (trace.length ? trace.map(([turn, rows]) => {
        const end = rows.findLast((row) => row.turnEnd !== undefined)?.turnEnd
        return <details className={styles.status} key={turn}>
          <summary>{t('remoteDetailsTurn', { turn })}{end && ' · ' + t(
            end.reason === 'completed' ? 'remoteDetailsCompleted' : end.reason === 'failed' ? 'remoteDetailsFailed' : 'remoteDetailsStopped',
          )}</summary>
          {rows.map((item) => item.kind === 'tool' ? <ToolCard item={item} key={item.id} />
            : item.kind === 'message' && item.role !== 'system' && !item.context && !item.usageOnly && item.text.trim()
              ? <div key={item.id} className={styles.path}>
                <Markdown content={stripDsml(item.text)} loading={false} cacheKey={item.id} disableLink={false} />
              </div> : null)}
        </details>
      }) : <p>{t('remoteDetailsEmpty')}</p>)}
      {tab === 'remoteDetailsChanges' && (changes.length
        ? changes.map((tool) => <ToolCard item={tool} key={tool.id} />) : <p>{t('remoteDetailsEmptyChanges')}</p>)}
      {tab === 'remoteDetailsFiles' && (files.length
        ? <ul className={artifactStyles.list}>{files.map((file) => <ArtifactTile file={file} key={file.path} onOpened={onClose} />)}</ul>
        : <p>{t('remoteDetailsEmptyFiles')}</p>)}
      {tab === 'remoteDetailsProgress' && <>
        <div className={styles.actions}><Button variant="outlined" size="m" onClick={onGoal}>{t('remoteSessionGoal')}</Button></div>
        {todos?.length ? <ul>{todos.map((todo, index) => <li key={index}>
          {todo.status === 'completed' ? '✓ ' : todo.status === 'in_progress' ? '◉ ' : '○ '}{todo.content}
        </li>)}</ul> : null}
        {plan ? <Markdown content={plan.text} loading={false} cacheKey={sessionId} disableLink={false} /> : <p>{t('planViewEmpty')}</p>}
      </>}
      {tab === 'remoteDetailsContext' && <>
        <SessionInfoPanel sessionId={sessionId} title={title} usage={usage} onNavigate={onClose} />
        {usageRows.length > 0 && <section className={styles.section}>
          <h3>{t('remoteDetailsTurnUsage')}</h3>
          {usageRows.map(({ turn, count }) => <div className={styles.row} key={turn}>
            {t('remoteDetailsTurn', { turn })}<span>{formatTokens(count)}</span>
          </div>)}
        </section>}
      </>}
    </div>
  </Modal>
}
