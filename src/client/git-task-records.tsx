import type { TaskView } from '../contracts/views.js'
import type { ServantLocaleKey } from './locales.js'
type Props = { remote: NonNullable<TaskView['remote']>; t: (key: ServantLocaleKey) => string; className?: string; emptyClassName?: string }

/** Git lifecycle records are not Local physical owners or Local file artifacts. */
export function GitExecutionRecords({ remote, t, className, emptyClassName }: Props) {
  return <>{remote.executions?.map(execution => <div key={execution.executionId} className={className}>
    <a href={execution.recordsUrl} target="_blank" rel="noreferrer">{t(`role.${execution.role}`)} · {t(execution.state === 'active' ? 'tasks.gitExecutionOpen' : 'tasks.gitExecutionClosed')}</a>
    <code>{execution.executionId}</code><span>{execution.participantId} / {execution.instanceId}</span>
  </div>)}{!remote.archived && !remote.executions?.length && <p className={emptyClassName}>{t('tasks.noGitExecutions')}</p>}</>
}
export function GitResultDocuments({ remote, t, className, emptyClassName }: Props) {
  return <>{remote.results?.map(result => <a key={result.executionId} className={className} href={result.recordsUrl} target="_blank" rel="noreferrer">
    <span>{t('tasks.acceptedResultDocument')} · {result.childId}</span><code>{result.path}</code>
  </a>)}{!remote.archived && (remote.projectionUpdating || !remote.results?.length) && <p className={emptyClassName}>{t(remote.projectionUpdating ? 'tasks.gitResultsUpdating' : 'tasks.noAcceptedResults')}</p>}</>
}
