import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Button, Input, Modal, SegmentedControl, StateDot, IconSettingsOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { FrameworkClientController, getFrameworkClientController, frameworkScopeKey, type FrameworkClientApi, type FrameworkClientSettings, type FrameworkClientModel, type FrameworkClientView, type FrameworkClientRole, type FrameworkLegacyTask } from './client-contracts.js'
import css from '../client/page.module.css'

declare const __SERVANT_ICON_DATA_URI__: string
declare const __SERVANT_WELCOME_CHARACTER_DATA_URI__: string
declare const __SERVANT_TASK_EMPTY_CHARACTER_DATA_URI__: string
export interface FrameworkPageProps {
  api: FrameworkClientApi
  language?: 'zh' | 'en'
  onOpenCredentials?: () => Promise<void>
  onPickDirectory?: () => Promise<string | null>
  onViewed?: (view: FrameworkClientView) => void
  modelControl?: (value: FrameworkClientModel | undefined, onChange: (value: FrameworkClientModel | undefined) => void, label: string) => ReactNode
  presetControl?: (value: string | undefined, onChange: (value: string | undefined) => void) => ReactNode
}
const roles: FrameworkClientRole[] = ['Foreground', 'Organizer', 'Planner', 'Worker', 'Recorder', 'Helper']
const blankSettings: FrameworkClientSettings = { name: 'DeepSeek Servant', userName: '', localDirectory: '', ownerRepo: '', repositoryDirectory: '', collaborationId: '', workerSeats: 0, workspace: '' }

/** Uses the existing DSS surfaces and native controls; all data/actions are Host RPCs. */
export function FrameworkPage(props: FrameworkPageProps) {
  const controller = getFrameworkClientController(props.api), snapshot = useSyncExternalStore(controller.subscribe, controller.snapshot)
  const view = snapshot.value, zh = props.language !== 'en', tr = (cn: string, en: string) => zh ? cn : en
  const [tab, setTab] = useState<'conversation' | 'tasks' | 'archives' | 'resources' | 'knowledge'>('conversation')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [error, setError] = useState('')
  const [selectedTask, setSelectedTask] = useState<string>()
  const [draft, setDraft] = useState('')
  const draftText = useRef('')
  const [recipient, setRecipient] = useState<'ai' | 'human'>('ai')
  const [replyTo, setReplyTo] = useState<string>()
  const [document, setDocument] = useState<Awaited<ReturnType<FrameworkClientApi['readFile']>>>()
  const [documentLoading, setDocumentLoading] = useState(false)
  const documentRequest = useRef(0)
  const [historyBusy, setHistoryBusy] = useState(false)
  const [historyDate, setHistoryDate] = useState('')
  const scope = view ? frameworkScopeKey(view.activeMode, view.collaborationId, view.storageScope) : ''
  const draftsByScope = useRef(new Map<string, { text: string; replyTo?: string; recipient: 'ai' | 'human' }>())
  const previousScope = useRef(scope)
  const onViewed = useRef(props.onViewed); onViewed.current = props.onViewed
  useEffect(() => controller.retainConnection(), [controller])
  useEffect(() => { if (view) onViewed.current?.(view) }, [view, view?.storageScope])
  useEffect(() => {
    if (previousScope.current === scope) return
    const saved = draftsByScope.current.get(scope) ?? (previousScope.current === '' ? draftsByScope.current.get('') : undefined)
    draftText.current = saved?.text ?? ''
    setDraft(saved?.text ?? ''); setReplyTo(saved?.replyTo); setRecipient(saved?.recipient ?? 'ai')
    setDocument(undefined); documentRequest.current++; setDocumentLoading(false); setSelectedTask(undefined)
    previousScope.current = scope
  }, [scope])
  const remember = (text: string, reply = replyTo, target = recipient) => { draftText.current = text; setDraft(text); setReplyTo(reply); setRecipient(target); draftsByScope.current.set(scope, { text, replyTo: reply, recipient: target }) }
  const run = (operation: Promise<unknown>) => { setError(''); void operation.catch(reason => setError(reason instanceof Error ? reason.message : String(reason))) }
  const send = () => {
    if (!view || !draftText.current.trim()) return
    const now = new Date()
    const input = { mode: view.activeMode, collaborationId: view.collaborationId, storageScope: view.storageScope, id: crypto.randomUUID(), createdAt: now.toISOString(), timezoneOffsetMinutes: -now.getTimezoneOffset(), text: draftText.current, recipient, replyTo, device: 'dsh-web' }
    // Retain first, then clear only this composer. Unknown sends remain separately retryable.
    controller.retain(input); draftText.current = ''; setDraft(''); setReplyTo(undefined); draftsByScope.current.set(scope, { text: '', recipient })
    run(controller.send(input))
  }
  const open = async (path: string) => {
    if (!view) return
    const request = ++documentRequest.current; setDocument(undefined); setDocumentLoading(true)
    try { const result = await props.api.readFile({ mode: view.activeMode, storageScope: view.storageScope, path }); if (request === documentRequest.current) setDocument(result) }
    catch (reason) { if (request === documentRequest.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (request === documentRequest.current) setDocumentLoading(false) }
  }
  const pending = snapshot.drafts.filter(item => frameworkScopeKey(item.input.mode, item.input.collaborationId, item.input.storageScope) === scope && (item.state !== 'confirmed' || !view?.messages.some(message => message.id === item.input.id)))
  const task = view?.tasks.find(item => item.taskId === selectedTask)
  const empty = !view || (tab === 'conversation' ? !view.messages.length : tab === 'tasks' ? !view.tasks.length : false)
  return <section className={css.page} aria-label="DeepSeek Servant">
    <header className={css.heading}><div className={css.identity}>
      <img className={css.avatar} src={__SERVANT_ICON_DATA_URI__} alt="" />
      <div><h1>{view?.settings.name || 'DeepSeek Servant'}</h1><p>{tr('对话、协作与持续执行', 'Conversation, collaboration and ongoing work')}</p></div>
    </div><div className={css.headerStatus}>
      <span className={css.status}><StateDot state={snapshot.error ? 'error' : snapshot.loading ? 'ongoing' : 'idle'} />{view?.connection.status ?? tr('未连接', 'Not connected')}</span>
      <Button size="sm" onClick={() => run(controller.refresh())}>{tr('刷新', 'Refresh')}</Button>
      <Button size="sm" aria-label={tr('设置', 'Settings')} onClick={() => setSettingsOpen(true)}><IconSettingsOutlineRegular size={18} /></Button>
    </div></header>
    <nav className={css.navigation}><div className={css.navigationControls}>
      <SegmentedControl id="framework-tabs" label={tr('页面', 'Pages')} value={tab} onChange={next => { setTab(next); if (next === 'archives') run(controller.refresh(true)) }} options={[
        { value: 'conversation', label: tr('会话', 'Conversation') }, { value: 'tasks', label: tr('任务', 'Tasks') },
        { value: 'knowledge', label: tr('知识', 'Knowledge') }, { value: 'archives', label: tr('成果档案', 'Archives') }, { value: 'resources', label: tr('资源', 'Resources') },
      ]} />
      <SegmentedControl id="framework-mode" label={tr('模式', 'Mode')} value={view?.activeMode ?? 'local'} onChange={mode => run(controller.selectMode(mode))}
        options={[{ value: 'local', label: 'Local' }, { value: 'git', label: 'DSS-cah' }]} />
      {view?.activeMode === 'git' && <span className={css.muted}>{tr('Git 协作模式', 'Git collaboration mode')}</span>}
    </div>{view && <span className={css.muted}>{view.collaborationId} · {view.connection.member}{view.connection.workerSeats !== undefined && <> · {tr('已生效席位', 'Applied seats')}: {view.connection.workerSeats}{view.connection.workerSeats !== view.settings.workerSeats && <> ({tr('已保存设置', 'Saved setting')}: {view.settings.workerSeats})</>}</>}</span>}</nav>
    {(error || snapshot.error || view?.connection.detail) && <div className={css.notice} role={error || snapshot.error ? 'alert' : 'status'}>{error || snapshot.error || view?.connection.detail}</div>}
    <div className={`${css.content} ${!empty && view?.settings.showCornerCharacter !== false ? css.contentWithCorner : ''}`}>
      {tab === 'conversation' && <div className={css.conversation}>
        <div className={css.historyNavigation}>{view?.pageBefore && <Button size="sm" disabled={historyBusy} onClick={() => {
          setHistoryBusy(true); run(controller.older(50).finally(() => setHistoryBusy(false)))
        }}>{tr('读取更早消息', 'Load earlier messages')}</Button>}
          <label>{tr('保存日期（UTC）', 'Saved date (UTC)')}<input type="date" aria-label={tr('保存日期（UTC）', 'Saved date (UTC)')} value={historyDate} onChange={event => setHistoryDate(event.target.value)} /></label>
          <Button size="sm" disabled={historyBusy || !historyDate} onClick={() => { setHistoryBusy(true); run(controller.navigateHistory({ date: historyDate, limit: 50 }).finally(() => setHistoryBusy(false))) }}>{tr('按日期读取', 'Browse date')}</Button>
          {view?.pageAfter && <Button size="sm" disabled={historyBusy} onClick={() => { setHistoryBusy(true); run(controller.navigateHistory({ date: view.historyDate, afterId: view.pageAfter, limit: 50 }).finally(() => setHistoryBusy(false))) }}>{tr('较新消息', 'Newer messages')}</Button>}
          <Button size="sm" disabled={historyBusy} onClick={() => { setHistoryDate(''); run(controller.latest()) }}>{tr('跳到最新', 'Jump to latest')}</Button>
        </div>
        <div className={css.messages} role="log" aria-live="polite">
          {empty && <div className={css.welcome}><img className={css.welcomeIcon} src={view?.settings.swapPageIllustrations ? __SERVANT_TASK_EMPTY_CHARACTER_DATA_URI__ : __SERVANT_WELCOME_CHARACTER_DATA_URI__} alt="" /><h2>{tr('从这里开始', 'Start here')}</h2></div>}
          {view?.messages.filter(message => message.role !== 'system' || message.source === 'deepseek-servant-status').map(message => <article key={message.id} className={`${css.message} ${message.role === 'user' ? css.userMessage : ''}`}>
            <div className={css.messageAuthor}>{message.participantId} · {message.role} · {message.createdAt}{message.device ? ' · ' + message.device : ''}{message.model ? ' · ' + message.model : ''}{message.modelVersion ? ' · ' + message.modelVersion : ''}</div>
            {message.replyTo && <p className={css.muted}>{tr('回复', 'Reply to')} {message.replyTo}</p>}
            <div className={css.messageText}>{message.text}</div>
            <Button size="sm" onClick={() => remember(draft, message.id)}>{tr('回复此条', 'Reply')}</Button>
          </article>)}
          {pending.map(item => <article className={css.message} key={item.input.id}><div className={css.messageText}>{item.input.text}</div>
            <p className={css.muted}>{item.state === 'confirmed' ? tr('消息已持久保存', 'Message durably saved') : item.state === 'sending' ? tr('正在提交', 'Submitting') : tr('尚未确认；保留原消息', 'Not confirmed; original message retained')}</p>
            {item.error && <p className={css.errorDetail} role="alert">{item.error}</p>}
            {item.state !== 'sending' && item.state !== 'confirmed' && <Button size="sm" onClick={() => run(controller.send(item.input))}>{tr('核对并重试原消息', 'Resolve and retry original')}</Button>}
          </article>)}
        </div>
        <div className={css.composer}><textarea aria-label={tr('消息', 'Message')} value={draft} onChange={event => remember(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send() } }} />
          {replyTo && <p className={css.muted}>{tr('回复', 'Reply to')} {replyTo} <Button size="sm" onClick={() => { setReplyTo(undefined); draftsByScope.current.set(scope, { text: draft, recipient }) }}>{tr('取消引用', 'Clear reply')}</Button></p>}
          <div className={css.composerFooter}><SegmentedControl id="framework-recipient" label={tr('收件方', 'Recipient')} value={recipient} onChange={target => remember(draft, replyTo, target)} options={[{ value: 'ai', label: 'AI' }, { value: 'human', label: tr('群聊', 'People') }]} />
            <Button variant="primary" disabled={!view || !draft.trim()} onClick={send}>{tr('发送', 'Send')}</Button></div>
        </div><p className={css.footnote}>{tr('切换页面或模式不停止已承接的后台工作。', 'Changing pages or mode does not stop accepted background work.')}</p>
      </div>}
      {tab === 'tasks' && <div className={`${css.taskLayout} ${task ? css.hasSelection : ''}`}><div className={css.taskList}>
        {empty && <div className={css.empty}><img className={css.welcomeIcon} src={view?.settings.swapPageIllustrations ? __SERVANT_WELCOME_CHARACTER_DATA_URI__ : __SERVANT_TASK_EMPTY_CHARACTER_DATA_URI__} alt="" /><h2>{tr('暂无任务', 'No tasks yet')}</h2></div>}
        {view?.tasks.map(item => <button key={item.taskId} className={`${css.taskRow} ${task?.taskId === item.taskId ? css.selected : ''}`} onClick={() => setSelectedTask(item.taskId)}>
          <span className={css.taskRowTitle}>{item.title}</span><span className={css.rowMeta}>{item.route} · {item.status} · {item.owner}</span><code>{item.taskId}</code>
        </button>)}</div>{task && <section className={css.taskDetail}><Button size="sm" onClick={() => setSelectedTask(undefined)}>{tr('返回', 'Back')}</Button><h2>{task.title}</h2>
          <p>{task.route === 'P' ? tr('Planner 规划与验收', 'Planner planning and acceptance') : tr('Organizer 分派与总验收', 'Organizer assignment and total acceptance')}</p>
          <section className={css.section}><h3>{tr('成员', 'Members')}</h3>{task.members.map(member => <div key={member.name} className={css.child}>{member.name} · {member.status}</div>)}</section>
          {view && <TaskControls key={scope + task.taskId} task={task} view={view} controller={controller} tr={tr} />}
          <RoleExecutions executions={task.executions} tr={tr} controller={controller} view={view} />
          <section className={css.section}><h3>{tr('成果与证据', 'Results and evidence')}</h3>{task.resultPaths.map(path => <button key={path} className={css.artifact} onClick={() => run(open(path))}><code>{path}</code></button>)}</section>
        </section>}</div>}
      {(tab === 'tasks' || tab === 'archives') && view && <LegacyTasks tasks={view.legacyTasks} controller={controller} mode={view.activeMode} storageScope={view.storageScope} open={open} tr={tr} />}
      {tab === 'knowledge' && view && <KnowledgePanel key={scope} api={props.api} view={view} tr={tr} />}
      {tab === 'archives' && <div className={css.knowledge}>{view?.archives.map(item => <section className={css.knowledgeCard} key={item.path}><h3>{item.title}</h3><code>{item.taskId}</code><button className={css.artifact} onClick={() => run(open(item.path))}>{item.path}</button></section>)}</div>}
      {tab === 'resources' && <div className={css.knowledge}>{view?.resources.map(resource => <section className={css.knowledgeCard} key={resource.instanceUUID ?? resource.name}><div className={css.rowBetween}><h3>{resource.name}</h3><span className={css.badge}>{resource.status}</span></div>
        <p>{tr('Worker 席位', 'Worker seats')}：{resource.workerSeats ?? tr('未知', 'Unknown')}</p><code>{resource.instanceUUID}</code>{resource.detail && <p>{resource.detail}</p>}</section>)}
        <RoleExecutions executions={view?.executions ?? []} tr={tr} controller={controller} view={view} /></div>}
    </div>
    {!empty && view?.settings.showCornerCharacter !== false && <div className={css.cornerArt} aria-hidden="true"><img className={css.cornerCharacter} src={__SERVANT_WELCOME_CHARACTER_DATA_URI__} alt="" /></div>}
    <Modal open={settingsOpen} onClose={() => setSettingsOpen(false)} title={tr('设置', 'Settings')} closeLabel={tr('关闭', 'Close')} className={css.settingsModal} contentClassName={css.settingsModalContent}>
      {settingsOpen && <FrameworkSettingsForm key={view?.activeMode ?? 'local'} {...props} controller={controller} view={view} />}
    </Modal>
    <Modal open={documentLoading || !!document} onClose={() => { documentRequest.current++; setDocument(undefined); setDocumentLoading(false) }} title={document?.path ?? tr('读取资料', 'Reading document')} closeLabel={tr('关闭', 'Close')} className={css.settingsModal} contentClassName={css.settingsModalContent}>
      {documentLoading && <StateDot state="ongoing" />}{document?.text !== undefined && <div className={css.messageText}>{document.text}</div>}
      {document?.downloadUrl && <a className={css.artifact} href={document.downloadUrl} download>{tr('下载原文件', 'Download original file')}</a>}
      {document?.binary && <div><p>{document.binary.bytes} bytes</p><code>SHA-256 {document.binary.sha256}</code><a className={css.artifact} href={document.binary.downloadUrl} download>{tr('下载附件', 'Download attachment')}</a></div>}
    </Modal>
  </section>
}
function RoleExecutions({ executions, tr, controller, view }: { controller: FrameworkClientController; view?: FrameworkClientView; executions: FrameworkClientView['tasks'][number]['executions']; tr: (cn: string, en: string) => string }) {
  return <section className={css.section}><h3>{tr('角色执行', 'Role executions')}</h3>{roles.map(role => <div key={role} className={css.child}><h4>{role}</h4>{executions.filter(execution => execution.role === role).map(execution => <div key={execution.executionId} className={css.execution}><div>{execution.member} {execution.workerId} · {execution.state}<code>{execution.executionId}</code>{execution.detail && <p>{execution.detail}</p>}{view && <ExecutionStop key={frameworkScopeKey(view.activeMode, view.collaborationId, view.storageScope) + execution.executionId} execution={execution} view={view} controller={controller} tr={tr} />}</div></div>)}
    {!executions.some(execution => execution.role === role) && <p className={css.muted}>{tr('暂无执行', 'No current execution')}</p>}</div>)}</section>
}
function FrameworkSettingsForm(props: FrameworkPageProps & { controller: FrameworkClientController; view?: FrameworkClientView }) {
  const { view, controller } = props, zh = props.language !== 'en', tr = (cn: string, en: string) => zh ? cn : en
  const [settings, setSettings] = useState(() => structuredClone(view?.settings ?? blankSettings))
  const [baseline, setBaseline] = useState(JSON.stringify(view?.settings ?? blankSettings))
  const revision = useRef(view?.revision)
  useEffect(() => {
    if (view && JSON.stringify(settings) === baseline) { setSettings(structuredClone(view.settings)); setBaseline(JSON.stringify(view.settings)); revision.current = view.revision }
  }, [view?.revision, view?.settings])
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const saveAttempt = useRef<{ fingerprint: string; commandId: string }>()
  const mode = view?.activeMode ?? 'local'
  return <form className={css.settingsSurface} onSubmit={event => {
    event.preventDefault(); setBusy(true); setError(''); setSaved(false)
    const fingerprint = JSON.stringify([mode, revision.current, settings])
    if (saveAttempt.current?.fingerprint !== fingerprint) saveAttempt.current = { fingerprint, commandId: crypto.randomUUID() }
    void controller.configure({ mode, commandId: saveAttempt.current.commandId, expectedRevision: revision.current, settings }).then(() => { setSaved(true); setBaseline(JSON.stringify(settings)); revision.current = controller.snapshot().value?.revision }, reason => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setBusy(false))
  }}><div className={css.settingsColumn}>
    {([['name', tr('名称', 'Name')], ['userName', tr('本地显示名称', 'Local display name')], ['collaborationId', tr('协作域', 'Collaboration')], ['workspace', tr('任务工作区', 'Task workspace')],
      ...(mode === 'local' ? [['localDirectory', tr('Local 数据目录', 'Local data directory')]] : [['ownerRepo', tr('Git 仓库 owner/repository', 'Git owner/repository')], ['repositoryDirectory', tr('仓库内目录', 'Repository directory')]])] as Array<[keyof FrameworkClientSettings, string]>).map(([key, label]) => <label className={css.field} key={key}><span>{label}</span><Input value={String(settings[key] ?? '')} onChange={event => setSettings({ ...settings, [key]: event.target.value })} /></label>)}
    {props.onPickDirectory && <Button type="button" disabled={busy} onClick={() => { setBusy(true); setError(''); void props.onPickDirectory!().then(workspace => { if (workspace !== null) setSettings(current => ({ ...current, workspace })) }, reason => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setBusy(false)) }}>{tr('选择任务工作区目录', 'Browse task workspace')}</Button>}
    <label className={css.field}><span>{tr('Worker 席位', 'Worker seats')}</span><Input type="number" min={0} step={1} value={settings.workerSeats} onChange={event => setSettings({ ...settings, workerSeats: Number(event.target.value) })} /></label>
    {props.modelControl && <div className={css.runtimeControls}><div className={css.field}><span>{tr('前台模型', 'Foreground model')}</span>{props.modelControl(settings.foreground, foreground => setSettings({ ...settings, foreground }), tr('前台模型', 'Foreground model'))}</div><div className={css.field}><span>{tr('后台模型', 'Background model')}</span>{props.modelControl(settings.background, background => setSettings({ ...settings, background }), tr('后台模型', 'Background model'))}</div></div>}
    {props.presetControl && <div className={css.field}><span>{tr('原生预设', 'Native preset')}</span>{props.presetControl(settings.presetId, presetId => setSettings({ ...settings, presetId }))}</div>}
    <label className={css.illustrationOption}><span>{tr('显示角落插画', 'Show corner illustration')}</span><input type="checkbox" checked={settings.showCornerCharacter !== false} onChange={event => setSettings({ ...settings, showCornerCharacter: event.target.checked })} /></label>
    <label className={css.illustrationOption}><span>{tr('交换页面插画', 'Swap page illustrations')}</span><input type="checkbox" checked={settings.swapPageIllustrations === true} onChange={event => setSettings({ ...settings, swapPageIllustrations: event.target.checked })} /></label>
    {mode === 'git' && <GitInvitation key={view?.storageScope ?? 'unresolved'} api={props.api} view={view} tr={tr} />}
    <div className={css.actions}><Button type="button" disabled={busy} onClick={() => { setBusy(true); setError(''); void controller.participation(!view?.connection.participating).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setBusy(false)) }}>{view?.connection.participating ? tr('退出协作后台', 'Leave collaboration background') : tr('开始协作后台', 'Start collaboration background')}</Button><Button type="submit" variant="primary" disabled={busy}>{tr('保存并连接', 'Save and connect')}</Button>{props.onOpenCredentials && mode === 'git' && <Button onClick={() => { void props.onOpenCredentials!().catch(reason => setError(reason instanceof Error ? reason.message : String(reason))) }}>{tr('Git 身份认证', 'Git authentication')}</Button>}</div>
    {error && <p className={css.errorDetail} role="alert">{error}</p>}{saved && <p className={css.muted} role="status">{tr('设置已保存，连接登记已读回。', 'Settings saved; connection registration read back.')}</p>}
  </div></form>
}

function LegacyTasks({ tasks, controller, mode, storageScope, open, tr }: { tasks: FrameworkLegacyTask[]; controller: FrameworkClientController; mode: 'local' | 'git'; storageScope?: string; open: (path: string) => Promise<void>; tr: (cn: string, en: string) => string }) {
  const [answers, setAnswers] = useState<Record<string, string>>({}), [busy, setBusy] = useState<string>(), [error, setError] = useState('')
  const attempts = useRef(new Map<string, { fingerprint: string; commandId: string }>())
  const act = (task: FrameworkLegacyTask, action: 'resume' | 'answer', waitId?: string) => {
    const key = JSON.stringify([mode, storageScope, task.migrationId, task.oldTaskId, waitId]), answer = action === 'answer' ? answers[key] ?? '' : undefined
    const fingerprint = JSON.stringify([key, action, answer]), prior = attempts.current.get(key)
    const commandId = prior?.fingerprint === fingerprint ? prior.commandId : crypto.randomUUID()
    attempts.current.set(key, { fingerprint, commandId }); setBusy(key); setError('')
    void controller.legacyControl({ mode, storageScope, commandId, migrationId: task.migrationId, oldTaskId: task.oldTaskId, action, waitId, answer })
      .catch(reason => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setBusy(undefined))
  }
  if (!tasks?.length) return null
  return <section className={css.knowledge}><h3>{tr('迁入的历史与接续', 'Imported history and continuation')}</h3>{error && <p className={css.errorDetail} role="alert">{error}</p>}
    {tasks.map(task => { const key = JSON.stringify([mode, storageScope, task.migrationId, task.oldTaskId]); return <section className={css.knowledgeCard} key={key}>
      <div className={css.rowBetween}><h4>{task.oldTaskId}</h4><span className={css.badge}>{task.continuation}</span></div><code>{task.taskId}</code>
      {task.issues?.map((issue, index) => <p key={index} className={css.errorDetail}>{issue}</p>)}
      <button className={css.artifact} onClick={() => { void open(task.recordPath) }}>{tr('打开完整原记录', 'Open complete original record')}<code>{task.recordPath}</code></button>
      {task.continuation === 'paused' && <Button disabled={busy === JSON.stringify([mode, storageScope, task.migrationId, task.oldTaskId, undefined])} onClick={() => act(task, 'resume')}>{tr('继续任务', 'Resume task')}</Button>}
      {task.continuation !== 'complete' && task.continuation !== 'cancelled' && (task.waits ?? []).map(wait => {
        const answerKey = JSON.stringify([mode, storageScope, task.migrationId, task.oldTaskId, wait.id])
        return <form key={wait.id} className={css.formCard} onSubmit={event => { event.preventDefault(); act(task, 'answer', wait.id) }}>
          <p className={css.messageText}>{wait.question}</p><code>{wait.memberIdentity} · {wait.id}</code>
          <label className={css.field}><span>{tr('回复这个问题', 'Answer this question')}</span><textarea value={answers[answerKey] ?? ''} onChange={event => setAnswers({ ...answers, [answerKey]: event.target.value })} /></label>
          <Button type="submit" disabled={busy === answerKey}>{tr('发送答复', 'Send answer')}</Button>
        </form>
      })}
      {task.continuation === 'wait-user' && !task.waits?.length && <p className={css.muted}>{tr('请打开原记录查看尚待解析的问题。', 'Open the original record to inspect unresolved questions.')}</p>}
    </section> })}
  </section>
}

function GitInvitation({ api, view, tr }: { api: FrameworkClientApi; view?: FrameworkClientView; tr: (cn: string, en: string) => string }) {
  const [username, setUsername] = useState(''), [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(''), [error, setError] = useState('')
  const inFlight = useRef(false)
  const invite = () => {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setError(''); setNotice('')
    void api.invite({ mode: 'git', storageScope: view?.storageScope, username: username.trim() }).then(result => {
      setNotice(result.status === 'pending' ? tr('邀请待接受', 'Invitation pending') : tr('已加入仓库协作', 'Repository access accepted')); setConfirm(false); setUsername('')
    }, reason => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => { inFlight.current = false; setBusy(false) })
  }
  return <section className={css.section}>
    <h3>{tr('邀请协作者', 'Invite collaborator')}</h3><code>{view?.settings.ownerRepo}</code>
    <p className={css.muted}>{tr('接受邀请后可读写整个仓库；后台参与需对方自行启用。', 'Accepting grants read/write access to the whole repository; background participation must be enabled separately.')}</p>
    <label className={css.field}><span>{tr('GitHub 用户名', 'GitHub username')}</span><Input autoComplete="off" value={username} disabled={busy} onChange={event => { setUsername(event.target.value); setConfirm(false); setNotice(''); setError('') }} /></label>
    <div className={css.actions}>{confirm ? <><Button type="button" disabled={busy} onClick={invite}>{tr('确认邀请', 'Confirm invitation')}</Button><Button type="button" disabled={busy} onClick={() => setConfirm(false)}>{tr('取消', 'Cancel')}</Button></> : <Button type="button" disabled={!username.trim()} onClick={() => setConfirm(true)}>{tr('邀请写入协作者', 'Invite write collaborator')}</Button>}</div>
    <GitAuthorization api={api} view={view} tr={tr} />
    {notice && <p role="status">{notice}</p>}{error && <p className={css.errorDetail} role="alert">{error}</p>}
  </section>
}

function GitAuthorization({ api, view, tr }: { api: FrameworkClientApi; view?: FrameworkClientView; tr: (cn: string, en: string) => string }) {
  const [members, setMembers] = useState<Awaited<ReturnType<FrameworkClientApi['gitMembers']>>>()
  const [confirm, setConfirm] = useState<Parameters<FrameworkClientApi['gitMemberAction']>[0]>()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const refresh = () => api.gitMembers({ mode: 'git', storageScope: view?.storageScope }).then(setMembers)
  const run = (fn: () => Promise<unknown>) => { setBusy(true); setError(''); void fn().catch(reason => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setBusy(false)) }
  return <section className={css.section}><h4>{tr('仓库授权管理', 'Repository access management')}</h4>
    <p className={css.muted}>{tr('这是仓库访问授权，不是在线实例名单。', 'Repository access permissions, not online instances.')}</p>
    <Button type="button" disabled={busy} onClick={() => run(refresh)}>{tr('刷新仓库授权', 'Refresh repository access')}</Button>
    {members?.invitations.map(item => <div key={item.id}>{item.login} · {item.status} <Button type="button" disabled={busy} onClick={() => setConfirm({ mode: 'git', storageScope: view?.storageScope, action: 'cancelInvitation', invitationId: item.id })}>{tr('撤销邀请', 'Revoke invitation')}</Button></div>)}
    {members?.collaborators.map(item => <div key={item.id}>{item.login} · {item.status} <span>{Object.entries(item.permissions).filter(([, allowed]) => allowed).map(([permission]) => permission).join(', ')}</span> <Button type="button" disabled={busy} onClick={() => setConfirm({ mode: 'git', storageScope: view?.storageScope, action: 'remove', username: item.login })}>{tr('移除协作者', 'Remove collaborator')}</Button></div>)}
    {confirm && <div role="group"><p>{confirm.action === 'remove' ? confirm.username : members?.invitations.find(item => item.id === confirm.invitationId)?.login}</p><Button type="button" disabled={busy} onClick={() => run(async () => { await api.gitMemberAction(confirm); setConfirm(undefined); await refresh() })}>{tr('确认撤销授权', 'Confirm access removal')}</Button><Button type="button" disabled={busy} onClick={() => setConfirm(undefined)}>{tr('取消撤销', 'Cancel removal')}</Button></div>}
    {error && <p role="alert">{error}</p>}
  </section>
}
function TaskControls({ task, view, controller, tr }: { task: FrameworkClientView['tasks'][number]; view: FrameworkClientView; controller: FrameworkClientController; tr: (cn: string, en: string) => string }) {
  const [intent, setIntent] = useState<'running' | 'paused' | 'cancelled'>(), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const attempt = useRef<{ intent: string; commandId: string }>()
  if (task.status === 'complete') return null
  return <section className={css.section}><p>{tr('仅控制本端任务执行，不表示远端已停止。', 'Controls this Host only; remote execution may continue.')} · {task.control ?? 'running'}</p>
    <Button disabled={busy} onClick={() => setIntent(task.control === 'paused' || task.control === 'cancelled' ? 'running' : 'paused')}>{task.control === 'paused' || task.control === 'cancelled' ? tr('本端接续', 'Resume on this Host') : tr('本端暂停', 'Pause on this Host')}</Button>
    <Button disabled={busy} onClick={() => setIntent('cancelled')}>{tr('本端取消', 'Cancel on this Host')}</Button>
    {intent && <><p>{intent}</p><Button disabled={busy} onClick={() => { if (attempt.current?.intent !== intent) attempt.current = { intent, commandId: crypto.randomUUID() }; setBusy(true); setError(''); void controller.taskControl({ mode: view.activeMode, storageScope: view.storageScope, taskId: task.taskId, commandId: attempt.current.commandId, intent }).then(() => { setIntent(undefined); attempt.current = undefined }, reason => setError(String(reason))).finally(() => setBusy(false)) }}>{tr('确认本端操作', 'Confirm Host action')}</Button><Button disabled={busy} onClick={() => setIntent(undefined)}>{tr('返回', 'Back')}</Button></>}{error && <p role="alert">{error}</p>}
  </section>
}
function ExecutionStop({ execution, view, controller, tr }: { execution: FrameworkClientView['tasks'][number]['executions'][number]; view: FrameworkClientView; controller: FrameworkClientController; tr: (cn: string, en: string) => string }) {
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const command = useRef<string>()
  if (execution.state === 'stopped') return null
  return <div>{!confirm ? <Button disabled={busy} onClick={() => setConfirm(true)}>{tr('停止本端这次执行', 'Stop this Host execution')}</Button> : <><code>{execution.executionId}</code><Button disabled={busy} onClick={() => { command.current ??= crypto.randomUUID(); setBusy(true); setError(''); void controller.stopExecution({ mode: view.activeMode, storageScope: view.storageScope, commandId: command.current, workId: execution.workId, executionId: execution.executionId }).then(() => setConfirm(false), reason => setError(String(reason))).finally(() => setBusy(false)) }}>{tr('确认停止这次执行', 'Confirm execution stop')}</Button><Button disabled={busy} onClick={() => setConfirm(false)}>{tr('返回', 'Back')}</Button></>}{error && <p role="alert">{error}</p>}</div>
}

type KnowledgePending = { kind: 'edit'; input: Parameters<FrameworkClientApi['knowledgeEdit']>[0] } | { kind: 'status'; input: Parameters<FrameworkClientApi['knowledgeStatus']>[0] }
// Like conversation drafts, unresolved edits survive page remounts within this client.
const knowledgePending = new WeakMap<FrameworkClientApi, Map<string, KnowledgePending>>()
function KnowledgePanel({ api, view, tr }: { api: FrameworkClientApi; view: FrameworkClientView; tr: (cn: string, en: string) => string }) {
  const [catalog, setCatalog] = useState<Awaited<ReturnType<FrameworkClientApi['knowledgeList']>>>()
  const [selected, setSelected] = useState<Awaited<ReturnType<FrameworkClientApi['knowledgeRead']>>>()
  const [edit, setEdit] = useState<{ body: string; title?: string; description?: string; applicability?: string }>()
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [status, setStatus] = useState<'disabled' | 'retired'>(), [reason, setReason] = useState('')
  const editAttempt = useRef<{ fingerprint: string; input: Parameters<FrameworkClientApi['knowledgeEdit']>[0] }>()
  const statusAttempt = useRef<{ fingerprint: string; input: Parameters<FrameworkClientApi['knowledgeStatus']>[0] }>()
  const active = useRef(true), reading = useRef(0)
  const [, redraw] = useState(0)
  let pending = knowledgePending.get(api)
  if (!pending) { pending = new Map(); knowledgePending.set(api, pending) }
  const operations = pending
  const scope = { mode: view.activeMode, storageScope: view.storageScope }
  const refresh = () => api.knowledgeList(scope).then(value => { if (active.current) setCatalog(value) })
  const run = (action: () => Promise<unknown>) => { setBusy(true); setError(''); setNotice(''); void action().catch(error => { if (active.current) setError(error instanceof Error ? error.message : String(error)) }).finally(() => { if (active.current) setBusy(false) }) }
  useEffect(() => { active.current = true; run(refresh); return () => { active.current = false; reading.current++ } }, [])
  const read = (path: string) => run(async () => {
    const request = ++reading.current, result = await api.knowledgeRead({ ...scope, path })
    if (!active.current || request !== reading.current) return
    setSelected(result); setEdit(result.edit ? { ...result.edit } : undefined); setStatus(undefined); setReason(''); editAttempt.current = undefined; statusAttempt.current = undefined
  })
  const submit = async (operation: KnowledgePending) => {
    operations.set(operation.input.commandId, operation); redraw(value => value + 1)
    if (operation.kind === 'edit') await api.knowledgeEdit(operation.input)
    else await api.knowledgeStatus(operation.input)
    operations.delete(operation.input.commandId)
    if (active.current) redraw(value => value + 1)
    await refresh()
  }
  const save = () => {
    if (!selected || !edit) return
    const fingerprint = JSON.stringify([scope, selected.path, selected.revision, edit])
    if (editAttempt.current?.fingerprint !== fingerprint) editAttempt.current = { fingerprint, input: { ...scope, commandId: crypto.randomUUID(), path: selected.path, expectedRevision: selected.revision, ...edit, createdAt: new Date().toISOString() } }
    const input = editAttempt.current.input
    run(async () => { await submit({ kind: 'edit', input }); if (active.current) setNotice(tr('候选修改已保存；未自动启用。', 'Candidate saved; not automatically activated.')) })
  }
  const changeStatus = () => {
    if (!selected || !status) return
    const expectedRevision = catalog?.revision ?? selected.revision
    const fingerprint = JSON.stringify([scope, selected.path, status, reason])
    if (statusAttempt.current?.fingerprint !== fingerprint) statusAttempt.current = { fingerprint, input: { ...scope, commandId: crypto.randomUUID(), path: selected.path, expectedRevision, status, reason, updatedAt: new Date().toISOString() } }
    const input = statusAttempt.current.input
    run(async () => { await submit({ kind: 'status', input }); if (active.current) { setStatus(undefined); setNotice(tr('状态已保存，原文保留。', 'Status saved; original body retained.')) } })
  }
  return <section className={css.knowledge}><div className={css.actions}><h2>{tr('知识管理', 'Knowledge management')}</h2><Button disabled={busy} onClick={() => run(refresh)}>{tr('刷新知识', 'Refresh knowledge')}</Button></div>
    {error && <p role="alert" className={css.errorDetail}>{error}</p>}{notice && <p role="status">{notice}</p>}
    {[...operations.values()].filter(operation => operation.input.mode === scope.mode && operation.input.storageScope === scope.storageScope).map(operation => <article key={operation.input.commandId} className={css.knowledgeCard}><p>{tr('尚未确认的原操作', 'Unconfirmed original operation')} · {operation.kind}</p><code>{operation.input.path}</code><Button disabled={busy} onClick={() => run(() => submit(operation))}>{tr('核对并重试原知识操作', 'Resolve and retry original knowledge operation')}</Button></article>)}
    {catalog?.items.map(item => <article className={css.knowledgeCard} key={item.path}><h3>{item.name}</h3><p>{item.description}</p><code>{item.path}</code><p>{item.status} · {item.indexed ? tr('已索引', 'Indexed') : tr('未索引', 'Not indexed')}</p>
      {item.error && <p role="alert">{item.error}</p>}{item.versions?.map(version => <p key={version.version}>v{version.version} · {version.status} · {version.contentHash}</p>)}
      {item.candidates.map(candidate => <p key={candidate.path}>{tr('候选', 'Candidate')} · {candidate.createdAt}<code>{candidate.path}</code></p>)}
      <Button disabled={busy} onClick={() => read(item.path)}>{tr('查看与编辑', 'Read and edit')}</Button></article>)}
    {selected && <section className={css.formCard}><h3>{selected.path}</h3>{!edit ? <p>{tr('没有可编辑正文。', 'No editable body available.')}</p> : <>
      {(['title', 'description', 'applicability'] as const).filter(key => edit[key] !== undefined).map(key => <label className={css.field} key={key}><span>{key}</span><Input disabled={busy} value={edit[key] ?? ''} onChange={event => setEdit({ ...edit, [key]: event.target.value })} /></label>)}
      <label className={css.field}><span>{tr('知识正文', 'Knowledge body')}</span><textarea disabled={busy} value={edit.body} onChange={event => setEdit({ ...edit, body: event.target.value })} /></label>
      <Button disabled={busy} onClick={save}>{tr('保存候选修改', 'Save candidate edit')}</Button>
    </>}
      <div className={css.actions}><Button disabled={busy} onClick={() => setStatus('disabled')}>{tr('停用', 'Disable')}</Button><Button disabled={busy} onClick={() => setStatus('retired')}>{tr('退役', 'Retire')}</Button><Button disabled={busy} onClick={() => read(selected.path)}>{tr('重读原记录', 'Reload original record')}</Button></div>
      {status && <div><p>{status}</p><label className={css.field}><span>{tr('原因', 'Reason')}</span><Input disabled={busy} value={reason} onChange={event => setReason(event.target.value)} /></label><Button disabled={busy} onClick={changeStatus}>{tr('确认状态修改', 'Confirm status change')}</Button><Button disabled={busy} onClick={() => setStatus(undefined)}>{tr('取消', 'Cancel')}</Button></div>}
    </section>}
  </section>
}
