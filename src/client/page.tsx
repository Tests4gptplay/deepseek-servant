import { useEffect, useLayoutEffect, useId, useRef, useState, type ReactNode } from 'react'
import {
  Button, IconSparkleRegular, IconSettingsOutlineRegular, Input, Menu, Modal, SegmentedControl, StateDot, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

declare const __SERVANT_STATUS_ICON_DATA_URI__: string
declare const __SERVANT_ICON_DATA_URI__: string
declare const __SERVANT_WELCOME_CHARACTER_DATA_URI__: string
declare const __SERVANT_TASK_EMPTY_CHARACTER_DATA_URI__: string
import { illustrationFor, showCornerIllustration, type IllustrationPage } from './illustrations.js'
import type { AssistantSettings } from '../contracts/assistant.js'
import type { GoalInput, ModelRoute } from '../contracts/task.js'
import type { ServantView, TaskView } from '../contracts/views.js'
import type { SkillRecord, SkillVersion } from '../contracts/knowledge.js'
import type { ServantNotice, ServantSnapshot, ServantSource } from './source.js'
import type { ServantLocaleKey } from './locales.js'
import { RetentionPanel } from './retention-panel.js'
import { ModelPicker } from './model-picker.js'
import { HistoryDatePicker } from './date-picker.js'
import { PresetPicker, type ServantPreset } from './preset-picker.js'
import type { ServantModels } from './models.js'
import { isAutoModel, resolveModelRoute } from '../domain/model-route.js'
import css from './page.module.css'

type Translate = PropsLocale<'dsh.servant'>['t']
type Tab = 'conversation' | 'tasks'

export interface ServantInjected {
  hooks: { servant: HostObservable<ServantSnapshot>; models: HostObservable<ServantModels> }
  onRefreshModels: () => Promise<void>
  onLoadPresets: () => Promise<readonly ServantPreset[]>
  onPickDirectory?: () => Promise<string | null>
  onRefresh: ServantSource['refresh']
  onHistoryPage: ServantSource['historyPage']
  onSend: ServantSource['send']
  onConfigure: ServantSource['configure']
  onConfigureRuntime: ServantSource['configureRuntime']
  onControl: ServantSource['control']
  onPriority: ServantSource['priority']
  onReconcile: ServantSource['reconcile']
  onAnswer: ServantSource['answer']
  onRevise: ServantSource['revise']
  onKnowledge: ServantSource['knowledge']
  onRetention: ServantSource['retention']
  onMoveRecords: ServantSource['moveRecords']
  onExportRecords: ServantSource['exportRecords']
  onOpenRecords: () => Promise<void>
  onOpenArtifact: (taskId: string, artifactId: string) => Promise<void>
}

export type ServantPageProps = PropsRuntime<'main'> & InjectFace<ServantInjected> & PropsLocale<'dsh.servant'>
type ServantActions = Omit<ServantInjected, 'hooks'>

/** The independent assistant page presents actual Host records and Session messages. */
export function ServantPage(props: ServantPageProps) {
  const { t } = props
  const snapshot = props.useServant(value => value)
  const [tab, setTab] = useState<Tab>('conversation')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const models = props.useModels(value => value)
  const value = snapshot.value
  const showCorner = !!value && showCornerIllustration(tab === 'conversation' ? value.messages.length > 0 : value.tasks.length > 0, value.assistant.settings)
  return <section className={css.page} aria-label={t('title')}>
    <header className={css.heading}>
      <div className={css.identity}>
        <img className={css.avatar} src={__SERVANT_ICON_DATA_URI__} alt="" />
        <div><h1>{value?.assistant.settings.name || t('title')}</h1><p>{t('subtitle')}</p></div>
      </div>
      <div className={css.headerStatus}>
        {value && <span className={css.status}><StateDot state={snapshot.status === 'error' ? 'error' : value.runtime.status === 'running' ? 'done' : 'warning'} />
          {t(snapshot.status === 'error' ? 'runtime.unavailable' : `runtime.${value.runtime.status}`)}</span>}
        <Button size="sm" onClick={() => { void props.onRefresh() }} disabled={snapshot.status === 'loading'}>{t('runtime.refresh')}</Button>
        <Button size="sm" aria-label={t('settings.open')} title={t('settings.open')} onClick={() => setSettingsOpen(true)} disabled={!value}><IconSettingsOutlineRegular size={18} /></Button>
      </div>
    </header>
    <div className={css.navigation}>
      <SegmentedControl id="servant-tabs" label={t('tabs.label')} value={tab} onChange={setTab}
        options={(['conversation', 'tasks'] as const).map(value => ({ value, label: t(`tabs.${value}`) }))} />
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
    {value && <div id={`servant-tabs-${tab}-panel`} role="tabpanel" aria-labelledby={`servant-tabs-${tab}`} className={`${css.content} ${showCorner ? css.contentWithCorner : ''} `}>
      {tab === 'conversation' && <Conversation value={value} busy={snapshot.pending.includes('send')} onSend={props.onSend} t={t}
        models={models} modelBusy={snapshot.pending.includes('configure')} onRefreshModels={props.onRefreshModels}
        history={snapshot.history} historyBusy={snapshot.status === 'loading'} onHistoryPage={props.onHistoryPage}
        onModelChange={route => props.onConfigure(value.assistant.revision, { ...value.assistant.settings, foreground: route })} />}
      {tab === 'tasks' && <Tasks value={value} pending={snapshot.pending} actions={props} t={t} />}
    </div>}
    {value && showCorner && <div className={css.cornerArt} aria-hidden="true">
      <PageIllustration page={tab} settings={value.assistant.settings} corner />
    </div>}
    {value && <Modal open={settingsOpen} onClose={() => setSettingsOpen(false)} title={t('settings.open')} closeLabel={t('settings.close')}
      className={css.settingsModal} contentClassName={css.settingsModalContent}>
      <ServantSettingsContent snapshot={snapshot} models={models} actions={props} t={t} />
    </Modal>}
  </section>
}

export type ServantSettingsProps = InjectFace<ServantInjected> & PropsLocale<'dsh.servant'>

/** Both entry points use the same observable and configuration actions. */
export function ServantSettingsPage(props: ServantSettingsProps) {
  const snapshot = props.useServant(value => value)
  const models = props.useModels(value => value)
  return <section className={css.globalSettings} aria-label={props.t('settings.open')}>
    <h2>{props.t('panel')}</h2>
    <ServantSettingsContent snapshot={snapshot} models={models} actions={props} t={props.t} />
  </section>
}

function ServantSettingsContent({ snapshot, models, actions, t }: {
  snapshot: ServantSnapshot; models: ServantModels; actions: ServantActions; t: Translate
}) {
  const [tab, setTab] = useState<'settings' | 'knowledge'>('settings')
  const id = useId()
  const value = snapshot.value
  return <div className={css.settingsSurface}>
    {snapshot.status === 'error' && <div className={css.notice} role="alert">
      <p className={css.errorDetail}>{snapshot.error}</p>
      <Button size="sm" onClick={() => { void actions.onRefresh() }}>{t('runtime.retry')}</Button>
    </div>}
    {!value && snapshot.status === 'loading' && <div className={css.empty} role="status" aria-label={t('runtime.loading')}><StateDot state="ongoing" size={26} /></div>}
    {value && <>
      <SegmentedControl id={id} label={t('settings.open')} value={tab} onChange={setTab}
        options={(['settings', 'knowledge'] as const).map(value => ({ value, label: t(`tabs.${value}`) }))} />
      <div id={`${id}-${tab}-panel`} role="tabpanel" aria-labelledby={`${id}-${tab}`} className={css.settingsBody}>
        {tab === 'settings' ? <div className={css.settingsColumn}>
          <Settings value={value} busy={snapshot.pending.includes('configure')} onSave={actions.onConfigure} t={t}
            models={models} onRefreshModels={actions.onRefreshModels} onLoadPresets={actions.onLoadPresets} onPickDirectory={actions.onPickDirectory} />
          <WorkerSeatsSettings value={value} busy={snapshot.pending.includes('configureRuntime')} onSave={actions.onConfigureRuntime} t={t} />
          <RetentionPanel stats={snapshot.storageStats} preview={snapshot.retention} outcome={snapshot.lastCleanup} busy={snapshot.pending.includes('retention')}
            recordStorage={value.recordStorage} moving={snapshot.pending.includes('moveRecords')} onMoveRecords={actions.onMoveRecords}
            onPickDirectory={actions.onPickDirectory} onRetention={actions.onRetention} onOpenRecords={actions.onOpenRecords} t={t} />
          <section className={css.experimental} aria-labelledby={`${id}-experimental`}>
            <h3 id={`${id}-experimental`}>{t('experimental.title')}</h3>
            <div className={css.experimentalGroups}>
              <IllustrationSettings value={value} busy={snapshot.pending.includes('configure')} onSave={actions.onConfigure} t={t} />
            </div>
          </section>
        </div> : <Knowledge value={value} pending={snapshot.pending} onKnowledge={actions.onKnowledge} t={t} />}
      </div>
    </>}
  </div>
}

function Conversation({ value, busy, onSend, models, modelBusy, onModelChange, onRefreshModels, history, historyBusy, onHistoryPage, t }: {
  value: ServantView; busy: boolean; onSend: ServantSource['send']; models: ServantModels; modelBusy: boolean
  onModelChange(route: ModelRoute): Promise<boolean>; onRefreshModels(): Promise<void>; t: Translate
  history: ServantSnapshot['history']; historyBusy: boolean; onHistoryPage: ServantSource['historyPage']
}) {
  const [draft, setDraft] = useState({ id: crypto.randomUUID(), text: '' })
  const messages = useRef<HTMLDivElement>(null)
  const followBottom = useRef(true)
  const previousTop = useRef(0)
  const prepend = useRef<{ height: number; top: number; first?: string }>()
  const firstMessage = value.messages[0]?.ref ?? value.messages[0]?.id
  const needsAuto = isAutoModel(value.assistant.settings.foreground)
  const modelReady = !needsAuto || models.current !== null
  const send = async () => {
    if (!draft.text.trim() || busy || modelBusy || !modelReady) return
    const submitted = draft
    if (await onSend(submitted.id, submitted.text, resolveModelRoute(value.assistant.settings.foreground, models.current ?? undefined))) setDraft(current => current.id === submitted.id ? { id: crypto.randomUUID(), text: '' } : current)
  }
  const loadOlder = () => {
    const element = messages.current
    if (!element || historyBusy || prepend.current || !value.conversationBefore) return
    followBottom.current = false
    prepend.current = { height: element.scrollHeight, top: element.scrollTop, first: firstMessage }
    void onHistoryPage('older')
  }
  const navigateHistory: ServantSource['historyPage'] = async (action, date) => {
    prepend.current = undefined
    followBottom.current = true
    await onHistoryPage(action, date)
  }
  const onScroll = () => {
    const element = messages.current
    if (!element) return
    const upward = element.scrollTop < previousTop.current
    previousTop.current = element.scrollTop
    if (prepend.current) prepend.current.top = element.scrollTop
    followBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48
    if (upward && element.scrollTop < element.clientHeight / 2) loadOlder()
  }
  // Prepending variable-height rows needs a pixel delta before paint to keep the same text under the reader.
  useLayoutEffect(() => {
    const element = messages.current
    if (!element) return
    if (prepend.current && firstMessage !== prepend.current.first) {
      element.scrollTop = prepend.current.top + element.scrollHeight - prepend.current.height
      prepend.current = undefined
    } else if (followBottom.current) element.scrollTop = element.scrollHeight
    if (!historyBusy) prepend.current = undefined
    previousTop.current = element.scrollTop
  }, [value.messages, historyBusy, firstMessage])
  return <div className={css.conversation}>
    <nav className={css.historyNavigation} aria-label={t('conversation.history')}>
      <Button size="sm" disabled={historyBusy || !value.conversationBefore} onClick={loadOlder}>{t('conversation.older')}</Button>
      {history.canGoNewer && <Button size="sm" disabled={historyBusy} onClick={() => { void navigateHistory('newer') }}>{t('conversation.newer')}</Button>}
      <HistoryDatePicker value={history.date ?? ''} disabled={historyBusy} t={t}
        onPick={date => { void navigateHistory('date', date) }} />
      {(history.before || history.date) && <Button size="sm" disabled={historyBusy} onClick={() => { void navigateHistory('latest') }}>{t('conversation.latest')}</Button>}
      {historyBusy && history.before && <span className={css.muted} role="status">{t('conversation.loadingOlder')}</span>}
    </nav>
    <div ref={messages} className={css.messages} role="log" aria-live="polite" aria-busy={historyBusy}
      onScroll={onScroll} onWheel={event => {
        if (event.deltaY < 0 && event.currentTarget.scrollTop < event.currentTarget.clientHeight / 2) loadOlder()
      }}>
      {!value.messages.length && history.date && <p className={css.muted}>{t('conversation.noHistory')}</p>}
      {!value.messages.length && !history.date && <div className={css.welcome}><PageIllustration page="conversation" settings={value.assistant.settings} /><h2>{t('conversation.empty')}</h2><p>{t('conversation.hint')}</p></div>}
      {value.messages.map(message => <article key={message.ref ?? message.id} className={`${css.message} ${message.role === 'user' ? css.userMessage : ''}`}>
        {(message.role !== 'user' || Boolean(value.assistant.settings.userName)) &&
          <div className={css.messageAuthor}>{message.role === 'user' ? value.assistant.settings.userName : value.assistant.settings.name || t('conversation.assistant')}</div>}
        <div className={css.messageText}>{message.text}</div>
      </article>)}
      {value.assistant.pendingInputs.length > 0 && <p className={css.muted} role="status">{t('conversation.pending')}</p>}
      {value.assistant.pendingInputs.filter(input => input.error).map(input => <p key={input.messageId} className={css.errorDetail} role="alert">{input.error}</p>)}
    </div>
    <div className={css.composer}>
      <textarea aria-label={t('conversation.input')} placeholder={t('conversation.placeholder')} value={draft.text}
        onChange={event => { setDraft({ id: crypto.randomUUID(), text: event.target.value }) }}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() } }} />
      <div className={css.composerFooter}><span className={css.composerHint}>{t('conversation.keyboard')}</span>
        <div className={css.composerActions}><ModelPicker value={value.assistant.settings.foreground} models={models} composer
          onChange={route => { void onModelChange(route) }} onRefresh={onRefreshModels} disabled={busy || modelBusy} label={t('settings.foreground')} t={t} />
          <Button variant="primary" disabled={busy || modelBusy || !modelReady || !draft.text.trim()} onClick={() => { void send() }}>{t(busy ? 'conversation.sending' : 'conversation.send')}</Button>
        </div>
      </div>
      {!modelReady && <p className={css.muted} role="status">{models.error ?? t('model.loading')}</p>}
    </div>
    <p className={css.footnote}>{t('conversation.background')}</p>
  </div>
}

function Tasks({ value, pending, actions, t }: { value: ServantView, pending: string[], actions: ServantActions, t: Translate }) {
  const [selectedId, setSelectedId] = useState<string>()
  const selected = value.tasks.find(task => task.id === selectedId)
  if (!value.tasks.length) return <Empty title={t('tasks.empty')} detail={t('tasks.hint')} artwork={<PageIllustration page="tasks" settings={value.assistant.settings} />} />
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
    {ended && <Button size="sm" variant="outline" disabled={busy} onClick={() => { void actions.onExportRecords(task.id) }}>{t('tasks.exportRecords')}</Button>}
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
    <Field label={t('tasks.reconcileEvidence')}><textarea value={evidence} required disabled={busy}
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

function WorkerSeatsSettings({ value, busy, onSave, t }: { value: ServantView; busy: boolean; onSave: ServantSource['configureRuntime']; t: Translate }) {
  const [seats, setSeats] = useState(String(value.runtime.workerSeats))
  useEffect(() => { setSeats(String(value.runtime.workerSeats)) }, [value.runtimeSettings.revision, value.runtime.workerSeats])
  const number = Number(seats), valid = Number.isInteger(number) && number >= 1 && number <= 32
  return <form className={css.settings} onSubmit={event => { event.preventDefault(); if (valid) void onSave(value.runtimeSettings.revision, number) }}>
    <Field label={t('settings.workerSeats')}><Input type="number" min={1} max={32} step={1} required value={seats}
      disabled={busy} onChange={event => setSeats(event.target.value)} /></Field>
    <div className={css.actions}><Button type="submit" disabled={busy || !valid || number === value.runtime.workerSeats}>{t('settings.save')}</Button></div>
  </form>
}

function Settings({ value, busy, onSave, models, onRefreshModels, onLoadPresets, onPickDirectory, t }: {
  value: ServantView; busy: boolean; onSave: ServantSource['configure']; models: ServantModels; onRefreshModels(): Promise<void>
  onLoadPresets(): Promise<readonly ServantPreset[]>
  onPickDirectory?: () => Promise<string | null>; t: Translate
}) {
  const [settings, setSettings] = useState<AssistantSettings>(() => structuredClone(value.assistant.settings))
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [picking, setPicking] = useState(false)
  const [directoryError, setDirectoryError] = useState<string>()
  const customWorkspace = settings.workspaceDirectory !== undefined
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
    <Field label={t('settings.userName')}><Input value={settings.userName ?? ''} placeholder={t('settings.userNamePlaceholder')}
      onChange={event => { setSettings({ ...settings, userName: event.target.value }) }} /></Field>
    <ControlField label={t('settings.workspace')}><Menu open={workspaceOpen} portal className={css.menuAnchor} selectedId={customWorkspace ? 'custom' : settings.workspaceId ?? 'default'}
      anchor={<Button type="button" variant="outline" disabled={busy || picking} aria-label={t('settings.workspace')} aria-expanded={workspaceOpen} aria-haspopup="menu"
        onClick={() => { setWorkspaceOpen(!workspaceOpen) }}>{customWorkspace ? t('settings.customWorkspace') : selectedWorkspace?.title ?? t('settings.defaultWorkspace')}</Button>}
      items={[{ id: 'default', label: t('settings.defaultWorkspace') }, ...value.workspaces.map(workspace => ({ id: workspace.id, label: workspace.title || workspace.directory })),
        { type: 'separator', id: 'custom-divider' }, { id: 'custom', label: t('settings.customWorkspace') }]}
      onSelect={id => {
        setSettings({ ...settings, workspaceId: id === 'default' || id === 'custom' ? undefined : id,
          workspaceDirectory: id === 'custom' ? settings.workspaceDirectory ?? value.assistant.workspace.directory : undefined })
        setDirectoryError(undefined); setWorkspaceOpen(false)
      }} onClose={() => { setWorkspaceOpen(false) }} />
      {customWorkspace && <div className={css.customWorkspace}>
        <label className={css.directoryField}><span>{t('settings.customDirectory')}</span>
          <Input required value={settings.workspaceDirectory ?? ''} disabled={busy || picking}
            placeholder={t('settings.directoryPlaceholder')} onChange={event => { setSettings({ ...settings, workspaceDirectory: event.target.value }); setDirectoryError(undefined) }} />
        </label>
        {onPickDirectory && <Button type="button" variant="outline" disabled={busy || picking} onClick={() => {
          setPicking(true); setDirectoryError(undefined)
          void onPickDirectory().then(directory => {
            if (directory !== null) setSettings(current => ({ ...current, workspaceId: undefined, workspaceDirectory: directory }))
          }).catch(error => { setDirectoryError(error instanceof Error ? error.message : String(error)) }).finally(() => { setPicking(false) })
        }}>{t(picking ? 'settings.directoryPicking' : 'settings.browseDirectory')}</Button>}
        <p className={css.muted}>{t('settings.customWorkspaceHint')}</p>
        {directoryError && <p className={css.errorDetail} role="alert">{directoryError}</p>}
      </div>}
      <p className={css.muted}>{t('settings.workspaceHint')}</p><span className={css.muted}>{t('settings.currentDirectory')}</span><code>{value.assistant.workspace.directory}</code>
    </ControlField>
    <div className={css.runtimeControls}>
      <ControlField label={t('settings.preset')}><PresetPicker value={settings.presetId} onLoad={onLoadPresets}
        onChange={presetId => setSettings({ ...settings, presetId })} disabled={busy} t={t} />
        <p className={css.muted}>{t('mode.hint')}</p>
      </ControlField>
      <ControlField label={t('settings.background')}><ModelPicker value={settings.background} models={models}
        followModel={resolveModelRoute(settings.foreground, models.current ?? undefined)}
        onChange={route => setSettings({ ...settings, background: route })} onRefresh={onRefreshModels} disabled={busy} label={t('settings.background')} t={t} />
        <p className={css.muted}>{t('model.autoHint')}</p>
      </ControlField>
    </div>
    <p className={css.settingsHint}>{t('settings.modelHint')}</p>
    <div className={css.actions}><Button type="submit" variant="primary" disabled={busy || picking || !dirty || (customWorkspace && !settings.workspaceDirectory?.trim())}>{t('settings.save')}</Button>{dirty && <><Button type="button" disabled={busy || picking} onClick={() => { setDirectoryError(undefined); setSettings(structuredClone(value.assistant.settings)); setBaseline(JSON.stringify(value.assistant.settings)); setRevision(value.assistant.revision) }}>{t('tasks.discard')}</Button><span className={css.muted}>{t('settings.changed')}</span></>}</div>
  </form>
}

function PageIllustration({ page, settings, corner = false }: { page: IllustrationPage; settings: AssistantSettings; corner?: boolean }) {
  const artwork = illustrationFor(page, settings)
  return <img className={corner ? css.cornerCharacter : css.welcomeIcon}
    src={artwork === 'welcome' ? __SERVANT_WELCOME_CHARACTER_DATA_URI__ : __SERVANT_TASK_EMPTY_CHARACTER_DATA_URI__}
    alt="" draggable={false} data-servant-illustration={artwork} data-placement={corner ? 'corner' : 'center'} />
}
function IllustrationSettings({ value, busy, onSave, t }: { value: ServantView; busy: boolean; onSave: ServantSource['configure']; t: Translate }) {
  const settings = value.assistant.settings
  return <section className={css.experimentalCard} aria-label={t('experimental.illustrations')}>
    <h4>{t('experimental.illustrations')}</h4>
    <p className={css.muted}>{t('experimental.illustrationsHint')}</p>
    <label className={css.illustrationOption}>
      <span><strong>{t('experimental.showCorner')}</strong><small>{t('experimental.showCornerHint')}</small></span>
      <input type="checkbox" role="switch" aria-label={t('experimental.showCorner')} checked={settings.showCornerCharacter !== false} disabled={busy}
        onChange={event => { void onSave(value.assistant.revision, { ...settings, showCornerCharacter: event.target.checked }) }} />
    </label>
    <label className={css.illustrationOption}>
      <span><strong>{t('experimental.swapIllustrations')}</strong><small>{t('experimental.swapIllustrationsHint')}</small></span>
      <input type="checkbox" role="switch" aria-label={t('experimental.swapIllustrations')} checked={settings.swapPageIllustrations === true} disabled={busy}
        onChange={event => { void onSave(value.assistant.revision, { ...settings, swapPageIllustrations: event.target.checked }) }} />
    </label>
  </section>
}
function Empty({ title, detail, artwork }: { title: string, detail: string; artwork?: ReactNode }) {
  return <div className={`${css.empty} ${artwork ? css.illustratedEmpty : ''}`}>{artwork ?? <IconSparkleRegular size={28} />}<h2>{title}</h2><p>{detail}</p></div>
}
function Section({ title, children }: { title: string, children: ReactNode }) { return <section className={css.section}><h3>{title}</h3>{children}</section> }
// A compound menu is not a labelable form input: wrapping it in a label makes
// clicks on its hint/blank space activate the trigger again after dismissal.
function ControlField({ label, children }: { label: string, children: ReactNode }) {
  return <div className={css.field} role="group" aria-label={label}><span>{label}</span>{children}</div>
}
function Field({ label, children }: { label: string, children: ReactNode }) { return <label className={css.field}><span>{label}</span>{children}</label> }
function lines(text: string): string[] { return text.split('\n').map(line => line.trim()).filter(Boolean) }

interface ServantSidebarInjected {
  hooks: { servant: HostObservable<ServantSnapshot> }
  onReadDeliveries: ServantSource['readDeliveries']
}
export function ServantSidebarIcon({ size, active, useServant, onReadDeliveries, t }:
  PropsRuntime<'sidebar.panellist'> & InjectFace<ServantSidebarInjected> & PropsLocale<'dsh.servant'>) {
  const pending = useServant(value => JSON.stringify((value.value?.tasks ?? [])
    .filter(task => task.delivery?.status === 'delivered' && !task.delivery.readAt).map(task => task.id)))
  useEffect(() => {
    const ids = JSON.parse(pending) as string[]
    if (active && ids.length) void onReadDeliveries(ids)
  }, [active, pending, onReadDeliveries])
  return <span className={css.servantSidebarStatus} style={{ width: size, height: size }}>
    <span className={css.servantSidebarGlyph} aria-hidden="true" style={{
      width: size, height: size, maskImage: `url("${__SERVANT_STATUS_ICON_DATA_URI__}")`,
    }} />
    {!active && pending !== '[]' && <span className={css.servantCompletion} title={t('notice.completed')}><StateDot state="done" /></span>}
  </span>
}

export interface ServantNoticeInjected { hooks: { notice: HostObservable<ServantNotice | undefined> }, dismiss: () => void }
export type ServantNoticeProps = PropsRuntime<'shell.overlay'> & InjectFace<ServantNoticeInjected> & PropsLocale<'dsh.servant'>
export function ServantNoticeOverlay({ useNotice, dismiss, t }: ServantNoticeProps) {
  const notice = useNotice(value => value)
  if (!notice) return null
  const key: ServantLocaleKey = `notice.${notice.key}`
  return <Toast key={notice.sequence} text={`${t(key)}${notice.detail ? `：${notice.detail}` : ''}`} tone={notice.kind === 'success' ? 'success' : undefined} onDone={dismiss} />
}
