import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Button, IconSparkleRegular, Input, Menu, SegmentedControl, StateDot, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { AssistantSettings } from '../contracts/assistant.js'
import type { GoalInput } from '../contracts/task.js'
import type { ServantView, TaskView } from '../contracts/views.js'
import type { SkillRecord, SkillVersion } from '../contracts/knowledge.js'
import type { ServantNotice, ServantSnapshot, ServantSource } from './source.js'
import type { ServantLocaleKey } from './locales.js'
import { RetentionPanel } from './retention-panel.js'
import css from './page.module.css'

type Translate = PropsLocale<'dsh.servant'>['t']
type Tab = 'conversation' | 'tasks' | 'knowledge' | 'settings'

export interface ServantInjected {
  hooks: { servant: HostObservable<ServantSnapshot> }
  onRefresh: ServantSource['refresh']
  onSend: ServantSource['send']
  onConfigure: ServantSource['configure']
  onControl: ServantSource['control']
  onPriority: ServantSource['priority']
  onReconcile: ServantSource['reconcile']
  onAnswer: ServantSource['answer']
  onRevise: ServantSource['revise']
  onKnowledge: ServantSource['knowledge']
  onRetention: ServantSource['retention']
  onOpenArtifact: (taskId: string, artifactId: string) => Promise<void>
}

export type ServantPageProps = PropsRuntime<'main'> & InjectFace<ServantInjected> & PropsLocale<'dsh.servant'>
type ServantActions = Omit<ServantInjected, 'hooks'>

/** The independent assistant page presents actual Host records and Session messages. */
export function ServantPage(props: ServantPageProps) {
  const { t } = props
  const snapshot = props.useServant(value => value)
  const [tab, setTab] = useState<Tab>('conversation')
  const value = snapshot.value
  return <section className={css.page} aria-label={t('title')}>
    <header className={css.heading}>
      <div className={css.identity}>
        <span className={css.avatar}><IconSparkleRegular size={24} /></span>
        <div><h1>{value?.assistant.settings.name || t('title')}</h1><p>{t('subtitle')}</p></div>
      </div>
      <div className={css.headerStatus}>
        {value && <span className={css.status}><StateDot state={snapshot.status === 'error' ? 'error' : value.runtime.status === 'running' ? 'done' : 'warning'} />
          {t(snapshot.status === 'error' ? 'runtime.unavailable' : `runtime.${value.runtime.status}`)}</span>}
        <Button size="sm" onClick={() => { void props.onRefresh() }} disabled={snapshot.status === 'loading'}>{t('runtime.refresh')}</Button>
      </div>
    </header>
    <div className={css.navigation}>
      <SegmentedControl id="servant-tabs" label={t('tabs.label')} value={tab} onChange={setTab}
        options={(['conversation', 'tasks', 'knowledge', 'settings'] as const).map(value => ({ value, label: t(`tabs.${value}`) }))} />
      {value && <div className={css.workspaceSummary}>
        <span>{value.workspaces.find(workspace => workspace.id === value.assistant.workspace.id)?.title ?? value.assistant.workspace.directory}</span>
        <span>{t('runtime.seats', { count: value.runtime.workerSeats })}</span>
      </div>}
    </div>
    {snapshot.status === 'error' && <div className={css.notice} role="alert">
      <div><p>{t('runtime.error')}</p>{value && <p>{t('runtime.retained')}</p>}<p className={css.errorDetail}>{snapshot.error}</p></div>
      <Button size="sm" onClick={() => { void props.onRefresh() }}>{t('runtime.retry')}</Button>
    </div>}
    {value?.runtime.message && <p className={css.notice} role="status">{value.runtime.message}</p>}
    {!value && snapshot.status === 'loading' && <div className={css.empty} role="status" aria-label={t('runtime.loading')}><StateDot state="ongoing" size={26} /></div>}
    {value && <div id={`servant-tabs-${tab}-panel`} role="tabpanel" aria-labelledby={`servant-tabs-${tab}`} className={css.content}>
      {tab === 'conversation' && <Conversation value={value} busy={snapshot.pending.includes('send')} onSend={props.onSend} t={t} />}
      {tab === 'tasks' && <Tasks value={value} pending={snapshot.pending} actions={props} t={t} />}
      {tab === 'knowledge' && <Knowledge value={value} pending={snapshot.pending} onKnowledge={props.onKnowledge} t={t} />}
      {tab === 'settings' && <div className={css.settingsColumn}><Settings value={value} busy={snapshot.pending.includes('configure')} onSave={props.onConfigure} t={t} />
        <RetentionPanel preview={snapshot.retention} outcome={snapshot.lastCleanup} busy={snapshot.pending.includes('retention')} onRetention={props.onRetention} t={t} /></div>}
    </div>}
  </section>
}

function Conversation({ value, busy, onSend, t }: { value: ServantView, busy: boolean, onSend: ServantSource['send'], t: Translate }) {
  const [draft, setDraft] = useState({ id: crypto.randomUUID(), text: '' })
  const bottom = useRef<HTMLDivElement>(null)
  const send = async () => {
    if (!draft.text.trim() || busy) return
    const submitted = draft
    if (await onSend(submitted.id, submitted.text)) setDraft(current => current.id === submitted.id ? { id: crypto.randomUUID(), text: '' } : current)
  }
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }) }, [value.messages.length])
  return <div className={css.conversation}>
    <div className={css.messages} role="log" aria-live="polite">
      {!value.messages.length && <div className={css.welcome}><IconSparkleRegular size={32} /><h2>{t('conversation.empty')}</h2><p>{t('conversation.hint')}</p></div>}
      {value.messages.map(message => <article key={message.id} className={`${css.message} ${message.role === 'user' ? css.userMessage : ''}`}>
        <div className={css.messageAuthor}>{message.role === 'user' ? t('conversation.you') : value.assistant.settings.name || t('conversation.assistant')}</div>
        <div className={css.messageText}>{message.text}</div>
      </article>)}
      {value.assistant.pendingInputs.length > 0 && <p className={css.muted} role="status">{t('conversation.pending')}</p>}
      {value.assistant.pendingInputs.filter(input => input.error).map(input => <p key={input.messageId} className={css.errorDetail} role="alert">{input.error}</p>)}
      <div ref={bottom} />
    </div>
    <div className={css.composer}>
      <textarea aria-label={t('conversation.input')} placeholder={t('conversation.placeholder')} value={draft.text}
        onChange={event => { setDraft({ id: crypto.randomUUID(), text: event.target.value }) }}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() } }} />
      <div className={css.composerFooter}><span>{t('conversation.keyboard')}</span><Button variant="primary" disabled={busy || !draft.text.trim()} onClick={() => { void send() }}>{t(busy ? 'conversation.sending' : 'conversation.send')}</Button></div>
    </div>
    <p className={css.footnote}>{t('conversation.background')}</p>
  </div>
}

function Tasks({ value, pending, actions, t }: { value: ServantView, pending: string[], actions: ServantActions, t: Translate }) {
  const [selectedId, setSelectedId] = useState<string>()
  const selected = value.tasks.find(task => task.id === selectedId)
  if (!value.tasks.length) return <Empty title={t('tasks.empty')} detail={t('tasks.hint')} />
  return <div className={`${css.taskLayout} ${selected ? css.hasSelection : ''}`}>
    <div className={css.taskList} aria-label={t('tasks.current')}>
      {value.tasks.map(task => {
        const children = Object.values(task.children)
        const accepted = children.filter(child => child.status === 'accepted').length
        return <button key={task.id} type="button" className={`${css.taskRow} ${selectedId === task.id ? css.selected : ''}`} onClick={() => { setSelectedId(task.id) }} aria-pressed={selectedId === task.id}>
          <span className={css.taskRowTitle}>{task.goal.objective}</span>
          <span className={css.rowMeta}><StateDot state={task.phase === 'completed' ? 'done' : task.phase === 'cancelled' ? 'idle' : task.control === 'paused' || task.phase === 'waiting' ? 'warning' : 'ongoing'} />
            {t(`phase.${task.phase}`)}{children.length > 0 && <span>{accepted} / {children.length}</span>}</span>
        </button>
      })}
    </div>
    {selected && <TaskDetails key={selected.id} task={selected} busy={pending.includes(`task:${selected.id}`)} actions={actions} onBack={() => { setSelectedId(undefined) }} t={t} />}
  </div>
}

function TaskDetails({ task, busy, actions, onBack, t }: { task: TaskView, busy: boolean, actions: ServantActions, onBack: () => void, t: Translate }) {
  const [editing, setEditing] = useState(false)
  const executions = Object.values(task.executions).filter(execution => execution.state === 'active' || execution.ownedJobIds.length || ['starting', 'running', 'stopping', 'unknown'].includes(execution.physicalState))
  const waits = Object.values(task.waits).filter(wait => wait.state === 'waiting')
  const artifacts = task.delivery?.artifacts ?? Object.values(task.reports).filter(report => report.disposition === 'accepted').flatMap(report => report.artifacts)
  const uniqueArtifacts = [...new Map(artifacts.map(artifact => [artifact.id, artifact])).values()]
  const ended = task.phase === 'completed' || task.control === 'cancelled'
  return <section className={css.taskDetail}>
    <div className={css.detailActions}><Button size="sm" onClick={onBack}>{t('tasks.back')}</Button><span className={css.badge}>{t(`control.${task.control}`)}</span></div>
    <h2>{task.goal.objective}</h2>
    {!ended && <div className={css.actions}>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => { void actions.onControl(task.id, task.control === 'paused' ? 'resume' : 'pause') }}>{t(task.control === 'paused' ? 'tasks.resume' : 'tasks.pause')}</Button>
      <Button size="sm" disabled={busy} onClick={() => { setEditing(true) }}>{t('tasks.edit')}</Button>
      <Button size="sm" disabled={busy} onClick={() => { void actions.onControl(task.id, 'cancel') }}>{t('tasks.cancel')}</Button>
    </div>}
    {!ended && <PriorityEditor key={`${task.id}:${task.priority}`} task={task} busy={busy} onSave={actions.onPriority} t={t} />}
    {editing && <GoalEditor task={task} busy={busy} onSave={actions.onRevise} onClose={() => { setEditing(false) }} t={t} />}
    {task.control !== 'running' && executions.length > 0 && <p className={css.notice}>{t('tasks.runningAfterPause')}</p>}
    {task.uncertainActionCount > 0 && <p className={css.notice}>{t('tasks.uncertainActions', { count: task.uncertainActionCount })}</p>}
    {task.goal.acceptanceCriteria.length > 0 && <Section title={t('tasks.criteria')}><ul>{task.goal.acceptanceCriteria.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</ul></Section>}
    {task.plan.strategy && <Section title={t('tasks.strategy')}><p>{task.plan.strategy}</p></Section>}
    <Section title={t('tasks.children')}>
      {Object.values(task.children).map(child => {
        const report = child.currentResultId ? task.reports[child.currentResultId] : undefined
        return <div key={child.id} className={css.child}><div className={css.rowBetween}><h4>{child.title}</h4><span className={css.badge}>{t(`child.${child.status}`)}</span></div>
          {report && <><p>{report.summary}</p>{report.frontier && child.status !== 'accepted' && <p className={css.muted}>{t('tasks.frontier')}：{report.frontier}</p>}</>}
        </div>
      })}
    </Section>
    {waits.length > 0 && <Section title={t('tasks.waits')}>{waits.map(wait => <div key={wait.id} className={css.wait}>
      <h4>{t(`wait.${wait.kind}`)}</h4><p>{wait.question || wait.reason}</p><p className={css.muted}>{t('tasks.waitCondition')}：{wait.condition}</p>
      {(wait.kind === 'user' || wait.kind === 'configuration') && <WaitAnswer busy={busy} onAnswer={answer => actions.onAnswer(task.id, wait.id, answer)} t={t} />}
    </div>)}</Section>}
    <Section title={t('tasks.deliverables')}>
      {task.delivery && <p>{task.delivery.summary}</p>}
      {!uniqueArtifacts.length && <p className={css.muted}>{t('tasks.noArtifacts')}</p>}
      {uniqueArtifacts.map(artifact => <button key={artifact.id} type="button" className={css.artifact} onClick={() => { void actions.onOpenArtifact(task.id, artifact.id) }}>
        <span>{artifact.description || t('tasks.openArtifact')}</span><code>{artifact.path}</code>
      </button>)}
    </Section>
    <Section title={t('tasks.execution')}>
      {!executions.length && <p className={css.muted}>{t('tasks.noExecution')}</p>}
      {executions.map(execution => <div key={execution.executionId}>
        <div className={css.execution}>
          <div><span>{t(`role.${execution.role}`)}</span><span className={css.muted}> · {t(`physical.${execution.physicalState}`)}</span>
            {execution.ownedJobIds.length > 0 && <code>{execution.ownedJobIds.join(', ')}</code>}</div>
          {execution.physicalState !== 'stopped' && <Button size="sm" disabled={busy || execution.stopRequested} onClick={() => { void actions.onControl(task.id, 'stop', execution.executionId) }}>{t('tasks.stop')}</Button>}
        </div>
        {execution.physicalState === 'unknown' && <ExecutionReconciliation executionId={execution.executionId} sessionId={execution.sessionId} busy={busy}
          onReconcile={evidence => actions.onReconcile(task.id, execution.executionId, evidence)} t={t} />}
      </div>)}
      <p className={css.muted}>{t('tasks.workspace')}：<code>{task.workspace.directory}</code></p>
    </Section>
  </section>
}

function ExecutionReconciliation({ executionId, sessionId, busy, onReconcile, t }: {
  executionId: string, sessionId: string, busy: boolean, onReconcile: (evidence: string) => Promise<boolean>, t: Translate
}) {
  const [evidence, setEvidence] = useState('')
  return <form className={css.executionRecovery} onSubmit={event => {
    event.preventDefault()
    const submitted = evidence.trim()
    if (!submitted || busy) return
    void onReconcile(submitted).then(ok => { if (ok) setEvidence('') })
  }}>
    <p>{t('tasks.reconcileHint')}</p>
    <p className={css.muted}>{t('tasks.executionId')}<code>{executionId}</code></p>
    <p className={css.muted}>{t('tasks.sessionId')}<code>{sessionId}</code></p>
    <Field label={t('tasks.reconcileEvidence')}><textarea value={evidence} required maxLength={32000} disabled={busy}
      placeholder={t('tasks.reconcilePlaceholder')} onChange={event => { setEvidence(event.target.value) }} /></Field>
    <Button type="submit" size="sm" variant="outline" disabled={busy || !evidence.trim()}>{t('tasks.reconcileStopped')}</Button>
  </form>
}

function PriorityEditor({ task, busy, onSave, t }: { task: TaskView, busy: boolean, onSave: ServantSource['priority'], t: Translate }) {
  const [value, setValue] = useState(String(task.priority))
  const priority = Number(value)
  const canSave = value.trim() !== '' && Number.isSafeInteger(priority) && priority !== task.priority
  return <form className={css.priority} onSubmit={event => { event.preventDefault(); if (canSave && !busy) void onSave(task.id, priority) }}>
    <label><span>{t('tasks.priority')}</span><Input type="number" step={1} value={value} disabled={busy}
      onChange={event => { setValue(event.target.value) }} /></label>
    <Button type="submit" size="sm" disabled={busy || !canSave}>{t('tasks.savePriority')}</Button>
    <p className={css.muted}>{t('tasks.priorityHint')}</p>
  </form>
}

function GoalEditor({ task, busy, onSave, onClose, t }: { task: TaskView, busy: boolean, onSave: ServantSource['revise'], onClose: () => void, t: Translate }) {
  const [objective, setObjective] = useState(task.goal.objective)
  const [criteria, setCriteria] = useState(task.goal.acceptanceCriteria.join('\n'))
  const [constraints, setConstraints] = useState(task.goal.constraints.join('\n'))
  const revision = useRef(task.goal.revision)
  return <form className={css.formCard} onSubmit={event => { event.preventDefault(); const { revision: _revision, ...goal } = task.goal
    const changed: GoalInput = { ...goal, objective, constraints: lines(constraints), acceptanceCriteria: lines(criteria) }
    void onSave(task.id, revision.current, changed).then(ok => { if (ok) onClose() }) }}>
    <Field label={t('tasks.goal')}><textarea value={objective} onChange={event => { setObjective(event.target.value) }} required /></Field>
    <Field label={t('tasks.constraints')}><textarea value={constraints} placeholder={t('tasks.criteriaHint')} onChange={event => { setConstraints(event.target.value) }} /></Field>
    <Field label={t('tasks.criteria')}><textarea value={criteria} placeholder={t('tasks.criteriaHint')} onChange={event => { setCriteria(event.target.value) }} required /></Field>
    <div className={css.actions}><Button type="submit" size="sm" variant="primary" disabled={busy}>{t('tasks.save')}</Button><Button size="sm" onClick={onClose}>{t('tasks.discard')}</Button></div>
  </form>
}

function WaitAnswer({ busy, onAnswer, t }: { busy: boolean, onAnswer: (answer: string) => Promise<boolean>, t: Translate }) {
  const [answer, setAnswer] = useState('')
  return <form className={css.answer} onSubmit={event => { event.preventDefault(); void onAnswer(answer).then(ok => { if (ok) setAnswer('') }) }}>
    <Input aria-label={t('tasks.answerPlaceholder')} placeholder={t('tasks.answerPlaceholder')} value={answer} onChange={event => { setAnswer(event.target.value) }} />
    <Button type="submit" size="sm" disabled={busy || !answer.trim()}>{t('tasks.answer')}</Button>
  </form>
}

function Knowledge({ value, pending, onKnowledge, t }: { value: ServantView, pending: string[], onKnowledge: ServantSource['knowledge'], t: Translate }) {
  const [editing, setEditing] = useState<string>()
  if (!value.knowledge.length) return <Empty title={t('knowledge.empty')} detail={t('knowledge.hint')} />
  return <div className={css.knowledge}>
    {value.knowledge.map(record => {
      if (record.kind !== 'skill') return <section key={`${record.kind}:${record.id}`} className={css.knowledgeCard}>
        <span className={css.eyebrow}>{t(record.kind === 'project-fact' ? 'knowledge.facts' : 'knowledge.preferences')}</span><p>{record.text}</p>
        {record.kind === 'preference' && <p className={css.muted}>{record.applicability}</p>}
        <code className={css.source}>{record.kind === 'project-fact' ? record.sourceResultId : record.userSourceRef}</code>
      </section>
      const latest = record.versions.at(-1)!
      const version = record.versions.find(version => version.version === record.activeVersion) ?? latest
      const busy = pending.includes(`knowledge:${record.skillId}`)
      return <section key={record.skillId} className={css.knowledgeCard}>
        <div className={css.rowBetween}><h3>{version.title}</h3><span className={css.badge}>{t(`skill.${version.status}`)}</span></div>
        <p>{version.description}</p><p className={css.muted}>{t('knowledge.scope')}：{version.applicability}</p>
        <div className={css.skillStats}><span>{t('knowledge.version', { version: version.version })}</span><span>{t('knowledge.uses', { count: version.uses.length + (version.archivedUses ?? []).reduce((sum, item) => sum + item.observedLoads, 0) })}</span>
          <span>{t('knowledge.successes', { count: [...version.feedback, ...version.archivedFeedback ?? []].filter(item => item.outcome === 'success').length })}</span>
          <span>{t('knowledge.failures', { count: [...version.feedback, ...version.archivedFeedback ?? []].filter(item => item.outcome === 'failure').length })}</span></div>
        {latest.version !== version.version && <p className={css.muted}>{t('knowledge.version', { version: latest.version })} · {t(`skill.${latest.status}`)}</p>}
        <details><summary>{t('knowledge.body')}</summary>{version.bodyRetiredAt ? <p className={css.muted}>{t('knowledge.bodyRetired')}</p> : <pre className={css.skillBody}>{version.body}</pre>}</details>
        <details><summary>{t('knowledge.evidence')}</summary>{version.validations.map(validation => <p key={validation.validationId}>{validation.explanation}<code className={css.source}>{validation.resultId}</code></p>)}</details>
        <div className={css.actions}><Button size="sm" disabled={busy} onClick={() => { setEditing(record.skillId) }}>{t('knowledge.edit')}</Button>
          {version.status === 'active' && <Button size="sm" disabled={busy} onClick={() => { void onKnowledge({ action: 'disable', skillId: record.skillId, version: version.version, reason: t('knowledge.disabledReason') }) }}>{t('knowledge.disable')}</Button>}
          {version.status !== 'retired' && <Button size="sm" disabled={busy} onClick={() => { void onKnowledge({ action: 'retire', skillId: record.skillId, version: version.version, reason: t('knowledge.retiredReason') }) }}>{t('knowledge.retire')}</Button>}
        </div>
        {editing === record.skillId && <SkillEditor record={record} version={latest} busy={busy} onSave={onKnowledge} onClose={() => { setEditing(undefined) }} t={t} />}
      </section>
    })}
  </div>
}

function SkillEditor({ record, version, busy, onSave, onClose, t }: { record: SkillRecord, version: SkillVersion, busy: boolean, onSave: ServantSource['knowledge'], onClose: () => void, t: Translate }) {
  const [draft, setDraft] = useState({ title: version.title, description: version.description, body: version.body, applicability: version.applicability, sourceResultId: version.sourceResultIds[0] })
  const expectedVersion = useRef(version.version)
  return <form className={css.formCard} onSubmit={event => { event.preventDefault(); void onSave({ action: 'revise', skillId: record.skillId, expectedVersion: expectedVersion.current, ...draft }).then(ok => { if (ok) onClose() }) }}>
    <p className={css.muted}>{t('knowledge.editHint')}</p>
    {version.bodyRetiredAt && <p className={css.muted}>{t('knowledge.bodyRetired')}</p>}
    {(['title', 'description', 'applicability', 'body', 'sourceResultId'] as const).map(key => <Field key={key} label={t(({ title: 'knowledge.title', description: 'knowledge.description', applicability: 'knowledge.scope', body: 'knowledge.body', sourceResultId: 'knowledge.source' } as const)[key])}>
      {key === 'body' ? <textarea className={css.bodyEditor} required value={draft[key]} onChange={event => { setDraft({ ...draft, [key]: event.target.value }) }} />
        : <Input required value={draft[key]} onChange={event => { setDraft({ ...draft, [key]: event.target.value }) }} />}
    </Field>)}
    <div className={css.actions}><Button type="submit" size="sm" variant="primary" disabled={busy}>{t('knowledge.save')}</Button><Button size="sm" onClick={onClose}>{t('tasks.discard')}</Button></div>
  </form>
}

function Settings({ value, busy, onSave, t }: { value: ServantView, busy: boolean, onSave: ServantSource['configure'], t: Translate }) {
  const [settings, setSettings] = useState<AssistantSettings>(() => structuredClone(value.assistant.settings))
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [revision, setRevision] = useState(value.assistant.revision)
  const [baseline, setBaseline] = useState(JSON.stringify(value.assistant.settings))
  const dirty = JSON.stringify(settings) !== baseline
  const selectedWorkspace = value.workspaces.find(workspace => workspace.id === settings.workspaceId)
  useEffect(() => {
    if (value.assistant.revision <= revision) return
    const remote = JSON.stringify(value.assistant.settings)
    // Unrelated assistant changes can advance its revision while this form is
    // dirty. A concurrent settings change retains the original compare token.
    if (remote === baseline) setRevision(value.assistant.revision)
    else if (!dirty) { setSettings(structuredClone(value.assistant.settings)); setBaseline(remote); setRevision(value.assistant.revision) }
  }, [value.assistant.revision, value.assistant.settings, revision, baseline, dirty])
  return <form className={css.settings} onSubmit={event => { event.preventDefault(); const submitted = JSON.stringify(settings); void onSave(revision, settings).then(ok => { if (ok) setBaseline(submitted) }) }}>
    <Field label={t('settings.name')}><Input required value={settings.name} onChange={event => { setSettings({ ...settings, name: event.target.value }) }} /></Field>
    <Field label={t('settings.workspace')}><Menu open={workspaceOpen} portal selectedId={settings.workspaceId ?? 'default'}
      anchor={<Button variant="outline" onClick={() => { setWorkspaceOpen(!workspaceOpen) }}>{selectedWorkspace?.title ?? t('settings.defaultWorkspace')}</Button>}
      items={[{ id: 'default', label: t('settings.defaultWorkspace') }, ...value.workspaces.map(workspace => ({ id: workspace.id, label: workspace.title || workspace.directory }))]}
      onSelect={id => { setSettings({ ...settings, workspaceId: id === 'default' ? undefined : id }); setWorkspaceOpen(false) }} onClose={() => { setWorkspaceOpen(false) }} />
      <p className={css.muted}>{t('settings.workspaceHint')}</p><span className={css.muted}>{t('settings.currentDirectory')}</span><code>{value.assistant.workspace.directory}</code>
    </Field>
    <Field label={t('settings.preset')}><Input required value={settings.presetId} onChange={event => { setSettings({ ...settings, presetId: event.target.value }) }} /></Field>
    <div className={css.modelSettings}>{(['foreground', 'background'] as const).map(role => <fieldset key={role}><legend>{t(`settings.${role}`)}</legend>
      <Field label={t('settings.provider')}><Input placeholder={t('settings.hostDefault')} value={settings[role].provider ?? ''} onChange={event => { setSettings({ ...settings, [role]: { ...settings[role], provider: event.target.value || undefined } }) }} /></Field>
      <Field label={t('settings.model')}><Input placeholder={t('settings.hostDefault')} value={settings[role].model ?? ''} onChange={event => { setSettings({ ...settings, [role]: { ...settings[role], model: event.target.value || undefined } }) }} /></Field>
    </fieldset>)}</div>
    <p className={css.muted}>{t('settings.modelHint')}</p>
    <div className={css.actions}><Button type="submit" variant="primary" disabled={busy || !dirty}>{t('settings.save')}</Button>{dirty && <><Button disabled={busy} onClick={() => { setSettings(structuredClone(value.assistant.settings)); setBaseline(JSON.stringify(value.assistant.settings)); setRevision(value.assistant.revision) }}>{t('tasks.discard')}</Button><span className={css.muted}>{t('settings.changed')}</span></>}</div>
  </form>
}

function Empty({ title, detail }: { title: string, detail: string }) { return <div className={css.empty}><IconSparkleRegular size={28} /><h2>{title}</h2><p>{detail}</p></div> }
function Section({ title, children }: { title: string, children: ReactNode }) { return <section className={css.section}><h3>{title}</h3>{children}</section> }
function Field({ label, children }: { label: string, children: ReactNode }) { return <label className={css.field}><span>{label}</span>{children}</label> }
function lines(text: string): string[] { return text.split('\n').map(line => line.trim()).filter(Boolean) }

export function ServantSidebarIcon({ size }: PropsRuntime<'sidebar.panellist'>) { return <IconSparkleRegular size={size} /> }

export interface ServantNoticeInjected { hooks: { notice: HostObservable<ServantNotice | undefined> }, dismiss: () => void }
export type ServantNoticeProps = PropsRuntime<'shell.overlay'> & InjectFace<ServantNoticeInjected> & PropsLocale<'dsh.servant'>
export function ServantNoticeOverlay({ useNotice, dismiss, t }: ServantNoticeProps) {
  const notice = useNotice(value => value)
  if (!notice) return null
  const key: ServantLocaleKey = `notice.${notice.key}`
  return <Toast key={notice.sequence} text={`${t(key)}${notice.detail ? `：${notice.detail}` : ''}`} tone={notice.kind === 'success' ? 'success' : undefined} onDone={dismiss} />
}
