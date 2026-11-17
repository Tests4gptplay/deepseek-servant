import { createElement, useEffect, useState, useSyncExternalStore, type ComponentType } from 'react'
import type { UserQuestionProjectionView } from '@deepseek-ai/dsh-user-questions/types'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PendingQuestion } from '@deepseek-ai/dsh-client-ui-user-questions/client'
import type { Context } from '@deepseek-ai/cordis'
import type { ISessions, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { UiSession } from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsRenderSlots, PropsRenderFactories, SessionProviderComponent, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { FrameworkClientExecution } from '../framework/client-contracts.js'

interface Services { uiSession?: UiSession; generation: number }
export interface NativeInteractionClient { subscribe(listener: () => void): () => void; getSnapshot(): Services }
export function createNativeInteractionClient(ctx: Context): NativeInteractionClient {
  const listeners = new Set<() => void>()
  let value: Services = { generation: 0 }
  const change = (patch: Partial<Services>) => { value = { ...value, ...patch, generation: value.generation + 1 }; for (const listener of listeners) listener() }
  ctx.inject(['uiSession'], scope => { change({ uiSession: scope.uiSession }); scope.effect(() => () => change({ uiSession: undefined })) })
  return { subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, getSnapshot: () => value }
}
declare module '@deepseek-ai/dsh-api-session-controller/client' { interface SessionReferenceSourceMap { 'deepseek-servant-interaction': unknown } }
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'deepseek-servant.interaction': { kind: 'single'; scope: 'session'; owner: {} }
    'deepseek-servant.question': { kind: 'single'; scope: 'session'; owner: { matched: PendingQuestion } }
    'deepseek-servant.plan-actions': { kind: 'list'; scope: 'session'; owner: import('@deepseek-ai/dsh-client-ui-slots').OwnerOf<'conversation.plan-review.actions'> }
  }
}
export type NativeInteractionSlots = PropsRenderSlots<'deepseek-servant.interaction'> & { SessionProvider: SessionProviderComponent }
export function registerNativeInteractions(ctx: Context): void {
  function Interaction({ sessionId, useSessionStatus, renderFactorySlot, renderSlot }: PropsRuntime<'deepseek-servant.interaction'> & PropsRenderFactories & PropsRenderSlots<'deepseek-servant.question'>) {
    const pending = useSessionStatus(value => value.get(sessionId)?.pendingInteraction)
    const sessions = ctx.get('sessions', true) as unknown as ISessions
    const questions = sessions.binding(sessionId)?.session.projections.faceOf('userQuestions')
    const projected = useSyncExternalStore(questions?.subscribe ?? emptySubscribe, questions?.getSnapshot ?? absent) as UserQuestionProjectionView | undefined
    const question = pending?.kind === 'question' || pending?.kind === 'plan-review' ? pending as PendingQuestion : undefined
    const approval = pending?.kind === 'approval' ? pending as import('@deepseek-ai/dsh-client-ui-approval/client').PendingApproval : undefined
    return <>{projected?.active.filter(row => question?.callId !== row.callId).map(row =>
      <button key={row.callId} type="button" onClick={() => ctx.get('userQuestionPanels')?.reveal(sessionId, row.callId)}>Open question: {row.questions[0]?.question ?? row.callId}</button>)}
      {question ? renderSlot('deepseek-servant.question', { matched: question }) : null}
      {approval ? renderFactorySlot('conversation.approval.card', {
        requestKey: approval.key,
        title: approval.displayReason ? ctx.locale.resolveText(approval.displayReason) : approval.reason ?? ctx.locale.bind('approval')('escalation', { toolName: approval.toolName }),
        ...(approval.callId === undefined ? {} : { callId: approval.callId }),
        canAnswer: () => approval.answerable,
        onAllow: () => approval.answer('allowed-once'), onReject: () => approval.answer('rejected'),
      }) : null}</>
  }
  ctx.slots.inject('deepseek-servant.interaction', () => {
    const disposeInteraction = ctx.slots.register({ name: 'deepseek-servant.interaction', children: { 'deepseek-servant.question': { kind: 'single', scope: 'session' } } }, Interaction)
    let original: import('@deepseek-ai/dsh-client-ui-slots').StoredEntry | undefined
    let disposeQuestion: (() => void) | undefined
    const syncQuestion = () => {
      const next = ctx.slots.entriesOfSlot('conversation.composer').find(entry => entry.locale === 'question' && entry.store !== undefined)
      if (next === original) return
      disposeQuestion?.(); disposeQuestion = undefined; original = next
      if (!next) return
      const NativeQuestion = next.component as ComponentType<Record<string, unknown>>
      function Question(props: Record<string, unknown> & PropsRenderSlots<'deepseek-servant.plan-actions'>) {
        const { renderSlot, ...rest } = props
        return createElement(NativeQuestion, { ...rest, renderSlot: (_key: string, owner: import('@deepseek-ai/dsh-client-ui-slots').OwnerOf<'conversation.plan-review.actions'>) => renderSlot('deepseek-servant.plan-actions', owner) })
      }
      // Reuse the exact native handle and injection: one draft instance per
      // Session, with the native card source and persistence, never a copy.
      disposeQuestion = ctx.slots.register({ name: 'deepseek-servant.question', locale: next.locale, store: next.store, inject: next.inject, children: { 'deepseek-servant.plan-actions': { kind: 'list', scope: 'session' } } } as never, Question)
    }
    const stop = ctx.slots.subscribe('conversation.composer', syncQuestion)
    syncQuestion()
    return () => { stop(); disposeQuestion?.(); disposeInteraction() }
  })
  ctx.slots.inject('deepseek-servant.plan-actions', () => {
    let originals: readonly import('@deepseek-ai/dsh-client-ui-slots').StoredEntry[] = []
    let disposers: Array<() => void> = []
    const sync = () => {
      const next = ctx.slots.entriesOfSlot('conversation.plan-review.actions')
      if (next.length === originals.length && next.every((entry, i) => entry === originals[i])) return
      for (const dispose of disposers) dispose()
      originals = next
      disposers = next.map((entry, i) => ctx.slots.register({ name: 'deepseek-servant.plan-actions', id: entry.options.id ?? String(i), order: entry.options.order, priority: entry.options.priority, locale: entry.locale, store: entry.store, inject: entry.inject } as never, entry.component as never))
    }
    const stop = ctx.slots.subscribe('conversation.plan-review.actions', sync)
    sync()
    return () => { stop(); for (const dispose of disposers) dispose() }
  })
}
const emptySubscribe = () => () => {}
const absent = () => undefined
export function NativeInteractions({ ctx, client, executions, zh, onlyPending = false, ...slots }: NativeInteractionSlots & { onlyPending?: boolean; ctx: Context; client: NativeInteractionClient; executions: readonly FrameworkClientExecution[]; zh: boolean }) {
  const services = useSyncExternalStore(client.subscribe, client.getSnapshot)
  const statuses = useSyncExternalStore(services.uiSession?.sessionStatus.subscribe ?? emptySubscribe, services.uiSession?.sessionStatus.getSnapshot ?? absent)
  const sessions = ctx.get('sessions', true) as unknown as ISessions
  const catalog = useSyncExternalStore(sessions.list.subscribe, sessions.list.getSnapshot)
  const seen = new Set<string>()
  return <>{executions.filter(row => {
    if (!row.sessionId) return false
    const binding = sessions.binding(row.sessionId as SessionId)
    return !binding?.session.getSnapshot().removed && (catalog.byId[row.sessionId as SessionId] || binding) && !seen.has(row.sessionId) && !!seen.add(row.sessionId) && (!onlyPending || statuses?.get(row.sessionId as SessionId)?.pendingInteraction)
  }).map(execution =>
    <section key={execution.sessionId + ':' + services.generation} aria-label={execution.role + (zh ? ' 待处理交互' : ' pending interaction')}><strong>{execution.role}</strong><InteractionSession ctx={ctx} execution={execution} {...slots}/></section>)}</>
}
function InteractionSession({ ctx, execution, renderSlot, SessionProvider }: NativeInteractionSlots & { ctx: Context; execution: FrameworkClientExecution }) {
  const [reference, setReference] = useState<SessionReference>()
  useEffect(() => {
    const sessions = ctx.get('sessions', true) as unknown as ISessions
    const owned = sessions.retain(execution.sessionId as SessionId, { source: 'deepseek-servant-interaction' })
    setReference(owned)
    return () => owned.release()
  }, [ctx, execution.sessionId])
  return reference ? <SessionProvider session={reference}>{renderSlot('deepseek-servant.interaction', {})}</SessionProvider> : null
}

/** Pending indicators use the already-published native status map; no Session is opened here. */
export function NativeTaskPending({ client, tasks, zh, onOpen, foreground, onForeground }: { foreground?: readonly FrameworkClientExecution[]; onForeground?: () => void; client: NativeInteractionClient; tasks: readonly import('../framework/client-contracts.js').FrameworkClientTask[]; zh: boolean; onOpen(taskId: string): void }) {
  const services = useSyncExternalStore(client.subscribe, client.getSnapshot)
  const statuses = useSyncExternalStore(services.uiSession?.sessionStatus.subscribe ?? emptySubscribe, services.uiSession?.sessionStatus.getSnapshot ?? absent)
  return <>{foreground?.some(row => statuses?.get(row.sessionId as SessionId)?.pendingInteraction) && <button type="button" onClick={onForeground}>{zh ? '前台 · 待你处理' : 'Foreground · Needs your response'}</button>}{tasks.filter(task => task.executions.some(row => statuses?.get(row.sessionId as SessionId)?.pendingInteraction)).map(task =>
    <button key={task.taskId} type="button" onClick={() => onOpen(task.taskId)}>{task.title} · {zh ? '待你处理' : 'Needs your response'}</button>)}</>
}
