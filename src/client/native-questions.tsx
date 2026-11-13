import { Component, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { UiSession } from '@deepseek-ai/dsh-client-ui-session/client'
import type { PendingQuestion } from '@deepseek-ai/dsh-client-ui-user-questions/client'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { FrameworkClientExecution } from '../framework/client-contracts.js'
import { FrameworkMarkdown } from '../framework/client-markdown.js'

interface QuestionServices { uiSession?: UiSession; generation: number }
export interface NativeQuestionClient {
  subscribe(listener: () => void): () => void
  getSnapshot(): QuestionServices
}

/** Optional service lifetimes only. Original questions remain owned by their domain. */
export function createNativeQuestionClient(ctx: Context): NativeQuestionClient {
  const listeners = new Set<() => void>()
  let value: QuestionServices = { generation: 0 }
  const change = (patch: Partial<QuestionServices>) => { value = { ...value, generation: value.generation + 1, ...patch }; for (const listener of listeners) listener() }
  ctx.inject(['uiSession'], scope => {
    change({ uiSession: scope.uiSession })
    scope.effect(() => () => change({ uiSession: undefined }))
  })
  ctx.on('connection/reset', () => change({ generation: value.generation + 1 }))
  return { subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, getSnapshot: () => value }
}
const emptySubscribe = () => () => {}
const absent = () => undefined
const noFileOpen = () => {}
export function NativeQuestionRegion({ client, executions, zh }: { client: NativeQuestionClient; executions: readonly FrameworkClientExecution[]; zh: boolean }) {
  const services = useSyncExternalStore(client.subscribe, client.getSnapshot)
  return <NativeQuestionBoundary key={services.generation} zh={zh}><QuestionSessions services={services} executions={executions} zh={zh} /></NativeQuestionBoundary>
}
class NativeQuestionBoundary extends Component<{ children: ReactNode; zh: boolean }, { error?: string }> {
  state: { error?: string } = {}
  static getDerivedStateFromError(error: unknown) { return { error: error instanceof Error ? error.message : String(error) } }
  render() { return this.state.error ? <p role="alert">{this.props.zh ? '原生选择区暂不可用：' : 'Native questions are unavailable: '}{this.state.error}</p> : this.props.children }
}
function QuestionSessions({ services, executions, zh }: { services: QuestionServices; executions: readonly FrameworkClientExecution[]; zh: boolean }) {
  const seen = new Set<string>()
  const rows = executions.filter(row => row.sessionId && !seen.has(row.sessionId) && !!seen.add(row.sessionId))
  return <div data-dss-native-questions aria-label={zh ? '原生用户选择' : 'Native user questions'}>
    {rows.map(execution => <SessionQuestions key={execution.sessionId + ':' + services.generation} services={services} execution={execution} zh={zh} />)}
  </div>
}
function SessionQuestions({ services, execution, zh }: { services: QuestionServices; execution: FrameworkClientExecution; zh: boolean }) {
  const id = execution.sessionId as SessionId
  const statuses = useSyncExternalStore(services.uiSession?.sessionStatus.subscribe ?? emptySubscribe, services.uiSession?.sessionStatus.getSnapshot ?? absent)
  const pending = statuses?.get(id)?.pendingInteraction
  // The official live instance owns the original waterfall and its answer.
  const card = pending && (pending.kind === 'question' || pending.kind === 'plan-review') ? pending as PendingQuestion : undefined
  return card ? <LiveQuestion key={card.key} card={card} execution={execution} zh={zh} /> : null
}
function LiveQuestion({ card, execution, zh }: { card: PendingQuestion; execution: FrameworkClientExecution; zh: boolean }) {
  const state = useSyncExternalStore(card.subscribe, card.getSnapshot)
  useEffect(() => () => card.releaseFocus(), [card])
  if (state.closed || card.review) return null
  if (state.channel === 'none') return card.callId !== undefined ? <p role="status">{zh
    ? '此题当前没有可用答复通道。DSS 暂不独立加载超时后的题目；如原生卡片恢复可答复状态，仍可在此答复。'
    : 'This question has no answer channel right now. DSS does not load timed-out questions independently yet; if the native card becomes answerable, you can still answer here.'}</p> : null
  return <QuestionForm card={card} questions={card.questions} identity={card.key} role={execution.role} zh={zh}
    waitInfo={<p role="status">{state.state === 'continued' ? zh ? '已继续处理，可在此答复' : 'Work continued; you can still answer'
      : state.waitState === 'editing' || state.waitState === 'waiting' ? zh ? '等待你的答复' : 'Waiting for your answer'
      : state.countdown ? (zh ? '原生等待剩余 ' : 'Native wait remaining: ') + Math.ceil(state.countdown.remainingMs / 1000) + (zh ? ' 秒' : ' seconds') : ''}
      {state.countdown && state.waitState !== 'waiting' && state.waitState !== 'editing' && state.waitState !== 'continued' && <button type="button" onClick={() => card.takeTime()}>{zh ? '我需要更多时间' : 'Take more time'}</button>}
      {state.countdown && <span>{zh ? ' DSS 暂不独立加载超时后的题目；如原生卡片有答复通道，仍可在此答复。' : ' DSS does not load timed-out questions independently yet; if the native card has an answer channel, you can still answer here.'}</span>}</p>}
    disabled={execution.state === 'stopped' || execution.state === 'unconfirmed'}
    onFocus={() => card.holdFocus()} onBlur={() => card.releaseFocus()} onEdit={() => card.engage()}
    submit={answer => card.answer(answer)} />
}
type Draft = { selected: string[]; custom: string; skipped: boolean }
// A native card survives ordinary page-tab unmounts; keep its edited answer with it.
const cardDrafts = new WeakMap<PendingQuestion, Record<string, Draft>>()
function QuestionForm({ card, questions, identity, role, zh, submit, disabled, onFocus, onBlur, onEdit, waitInfo }: {
  card: PendingQuestion; questions: readonly AskUserQuestionItem[]; identity: string; role: string; zh: boolean; disabled?: boolean
  waitInfo?: ReactNode
  submit(answer: AskUserQuestionAnswer): Promise<void>; onFocus?(): void; onBlur?(): void; onEdit?(): void
}) {
  const tr = (cn: string, en: string) => zh ? cn : en
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => cardDrafts.get(card) ?? {})
  const [collapsed, setCollapsed] = useState(false)
  const [busy, setBusy] = useState(false), [submitted, setSubmitted] = useState(false), [error, setError] = useState('')
  const sending = useRef(false)
  const draft = (id: string): Draft => drafts[id] ?? { selected: [], custom: '', skipped: false }
  const edit = (id: string, update: Partial<Draft>) => {
    onEdit?.()
    const current = cardDrafts.get(card) ?? drafts
    const next = { ...current, [id]: { ...(current[id] ?? { selected: [], custom: '', skipped: false }), ...update } }
    cardDrafts.set(card, next)
    setDrafts(next)
  }
  const send = async () => {
    if (sending.current || submitted || disabled) return
    if (questions.some(question => { const value = draft(question.id); return !value.skipped && !value.selected.length && !value.custom.trim() })) {
      setError(tr('请回答每一题，或明确选择跳过。', 'Answer each question or explicitly choose Skip.')); return
    }
    sending.current = true; setBusy(true); setError('')
    try {
      await submit({ answers: questions.map(question => { const value = draft(question.id); return { id: question.id, selected: value.skipped ? [] : value.selected,
        ...(!value.skipped && value.custom.trim() ? { custom: value.custom.trim() } : {}) } }) })
      setSubmitted(true)
    } catch (error) { setError(String(error instanceof Error ? error.message : error)) }
    finally { sending.current = false; setBusy(false) }
  }
  return <section data-dss-question={identity} style={{ border: '1px solid var(--border-color, #8888)', borderRadius: 8, padding: 12, margin: '8px 0' }}
    onFocus={onFocus} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) onBlur?.() }}>
    <header><strong>{role} · {tr('等待你的选择', 'Your decision')}</strong>{' '}<button type="button" onClick={() => setCollapsed(value => !value)}>{collapsed ? tr('展开', 'Expand') : tr('收起', 'Collapse')}</button></header>
    <div hidden={collapsed}>
      {waitInfo}
      {questions.map(question => { const value = draft(question.id); return <fieldset key={question.id} disabled={busy || submitted || disabled}>
        <legend>{question.header ? question.header + ' · ' : ''}{question.question}</legend>
        {question.detail !== undefined && <FrameworkMarkdown text={question.detail} zh={zh} openFile={noFileOpen} />}
        {(question.options ?? []).map(option => <label key={option.label} style={{ display: 'block' }}>
          <input type={question.multiSelect ? 'checkbox' : 'radio'} name={identity + ':' + question.id} checked={value.selected.includes(option.label)}
            onChange={() => edit(question.id, { selected: question.multiSelect ? value.selected.includes(option.label) ? value.selected.filter(item => item !== option.label) : [...value.selected, option.label] : [option.label], custom: question.multiSelect ? value.custom : '', skipped: false })} />
          {option.label}{option.description ? ' · ' + option.description : ''}
        </label>)}
        <label style={{ display: 'block' }}>{tr('自定义答复', 'Custom answer')}<textarea value={value.custom} onChange={event => edit(question.id, { custom: event.target.value, selected: question.multiSelect ? value.selected : [], skipped: false })} /></label>
        <label><input type="checkbox" checked={value.skipped} onChange={event => edit(question.id, { skipped: event.target.checked, selected: [], custom: '' })} />{tr('跳过此题', 'Skip this question')}</label>
      </fieldset> })}
      {disabled && <p role="status">{tr('原执行已停止或尚未确认可用，不能在此提交。', 'The original execution is stopped or unconfirmed; answering is unavailable.')}</p>}
      {error && <p role="alert">{error}</p>}
      {submitted ? <p role="status">{tr('已提交原生答复', 'Native answer submitted')}</p> : <button type="button" disabled={busy || disabled} onClick={() => void send()}>{busy ? tr('正在提交', 'Submitting') : tr('提交选择', 'Submit answers')}</button>}
    </div>
  </section>
}
