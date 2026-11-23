import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { callEndpoint, describeRemoteError, lastRemoteTarget } from '../../services/remote/sessionsApi.js'
import type { TerminalScope } from '../../services/remote/terminal.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import styles from './RemoteManagementDialog.module.css'

type PromptTool = 'skills' | 'references'
type Category = 'files' | 'sessions'
type Choice = { id: string; label: string; text: string; detail?: string; path?: string; directory?: boolean }

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

function readChoices(value: unknown, tool: PromptTool, category: Category): Choice[] {
  const rows = tool === 'skills' ? record(value)?.skills : value
  if (!Array.isArray(rows)) return []
  return rows.flatMap((value) => {
    const row = record(value)
    if (!row) return []
    if (tool === 'skills') {
      if (typeof row.name !== 'string' || !/^[^\s/]+$/u.test(row.name)) return []
      return { id: row.name, label: '/' + row.name, text: '/' + row.name + ' ',
        detail: [row.description, row.whenToUse].filter((value): value is string => typeof value === 'string' && !!value).join('\n'),
        path: typeof row.path === 'string' ? row.path : undefined }
    }
    if (category === 'sessions') {
      if (typeof row.sessionId !== 'string' || typeof row.mention !== 'string' ||
          !/^@\[(?:\\.|[^\\\]\r\n])*\]\(dsh-session:[A-Za-z0-9_-]+\)$/u.test(row.mention)) return []
      const title = row.displayTitle ?? row.label
      return { id: row.sessionId, label: typeof title === 'string' ? title : row.sessionId,
        text: row.mention + ' ', detail: typeof row.cwd === 'string' ? row.cwd : undefined }
    }
    if (typeof row.path !== 'string' || !row.path || /["\u0000-\u001f\u007f-\u009f]/u.test(row.path)) return []
    const directory = row.kind === 'directory'
    const path = directory && !row.path.endsWith('/') ? row.path + '/' : row.path
    const mention = /\s/u.test(path) ? '@"' + path + '"' : '@' + path
    return { id: path, label: path, text: mention + ' ', directory }
  })
}

export default function RemotePromptTools({ scope, tool, allowCurrentSkill, onClose, onUse }: {
  scope: TerminalScope
  tool: PromptTool
  allowCurrentSkill: boolean
  onClose: () => void
  onUse: (text: string, fresh: boolean, path?: string) => void
}) {
  const t = useTranslate()
  const [category, setCategory] = useState<Category>('files')
  const [query, setQuery] = useState('')
  const [choices, setChoices] = useState<Choice[] | null>(null)
  const [error, setError] = useState('')
  const current = () => scope.current() && lastRemoteTarget() === scope.target
  const serverQuery = tool === 'skills' ? '' : query.trim()

  useEffect(() => {
    let alive = true
    setChoices(null)
    setError('')
    const endpoint = tool === 'skills' ? 'skills/list'
      : category === 'files' ? 'fileReferences/list' : 'sessionReferenceResolver/candidates'
    const args = tool === 'skills' ? { request: { sessionId: scope.sessionId } }
      : { agentId: scope.sessionId, query: serverQuery }
    const timer = setTimeout(() => {
      if (!current()) return
      void callEndpoint<unknown>(scope.target, endpoint, args).then((value) => {
        if (alive && current()) setChoices(readChoices(value, tool, category))
      }, (failure) => {
        if (alive && current()) setError(describeRemoteError(failure).text)
      })
    }, serverQuery ? 180 : 0)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [tool, category, serverQuery, scope])

  const needle = tool === 'skills' ? query.trim().toLocaleLowerCase() : ''
  const visible = choices?.filter((choice) => [choice.label, choice.detail].some((value) =>
    value?.toLocaleLowerCase().includes(needle)))
  const use = (choice: Choice, fresh = false) => {
    if (!current()) return
    onClose()
    onUse(choice.text, fresh, choice.path)
  }

  return <Modal title={t(tool === 'skills' ? 'remoteSkills' : 'remoteReferences')}
    onClose={onClose} closable className={styles.modal} mainClassName={styles.body}>
    <div className={styles.layout}>
      {tool === 'references' && <label className={styles.field}>{t('remoteReferenceKind')}
        <select value={category} onChange={(event) => {
          setChoices(null)
          setCategory(event.target.value === 'sessions' ? 'sessions' : 'files')
          setQuery('')
        }}>
          <option value="files">{t('remoteReferenceFiles')}</option>
          <option value="sessions">{t('remoteReferenceSessions')}</option>
        </select>
      </label>}
      <label className={styles.field}>{t('remotePromptToolSearch')}
        <input type="search" value={query} onChange={(event) => {
          if (tool === 'references' && event.target.value.trim() !== serverQuery) setChoices(null)
          setQuery(event.target.value)
        }} />
      </label>
      {error && <p role="alert">{error}</p>}
      {!error && visible === undefined && <p role="status">{t('workspacePaneLoading')}</p>}
      {visible?.length === 0 && <p>{t('remotePromptToolEmpty')}</p>}
      {visible?.map((choice) => <div className={styles.row} key={choice.id}>
        <div className={styles.path}>{choice.label}{choice.detail && <small>{choice.detail}</small>}</div>
        <div className={styles.actions}>
          {choice.directory && <Button variant="outlined" size="m" onClick={() => {
            setChoices(null)
            setQuery(choice.label)
          }}>{t('remoteReferenceBrowse')}</Button>}
          {(tool !== 'skills' || allowCurrentSkill) && <Button variant="outlined" size="m" onClick={() => use(choice)}>
            {t(tool === 'skills' ? 'remoteSkillUseHere' : 'remoteReferenceInsert')}
          </Button>}
          {tool === 'skills' && <Button variant="outlined" size="m" onClick={() => use(choice, true)}>
            {t('remoteSkillUseNew')}
          </Button>}
        </div>
      </div>)}
    </div>
  </Modal>
}
