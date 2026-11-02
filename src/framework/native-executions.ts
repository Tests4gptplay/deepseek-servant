import { DshAgentCreationCancelled } from '../adapters/dsh/host-types.js'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-jobs'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { DshAgentGateway } from '../adapters/dsh/agents.js'
import type { DshAgentRequest, DshAgentRole, OwnedDshAgent } from '../adapters/dsh/host-types.js'
import type { WorkIdentity } from './recovery.js'
import type { ExecutionObservations, ScheduledObservation } from './execution-observation.js'

const nativeRole = { Foreground: 'foreground', Organizer: 'organizer', Planner: 'planner', Worker: 'worker', Recorder: 'recorder', Helper: 'helper' } satisfies Record<WorkIdentity['role'], DshAgentRole>
interface Opening { identity: WorkIdentity; sessionId: string; controller: AbortController; settled: Promise<void>; result?: StopResult; detail?: string; cancellation?: Promise<StopResult> }
interface Execution { identity: WorkIdentity; agent: OwnedDshAgent; stopping: boolean; unsettled: Set<string>; unconfirmed?: string; off?: () => void; stopEvidence?: () => void }
export type StopResult = { status: 'stopped' } | { status: 'superseded' } | { status: 'unconfirmed'; reason: string; jobs: string[] }

export interface NativeStopEvidence {
  workId: string
  executionId: string
  agentId: string
  sessionId: string
  jobs: string[]
  /** stopping survives a crash before the actual native dispose promise settles. */
  phase: 'stopping' | 'disposed'
  reason?: string
}
export interface NativeStopEvidenceHooks { save(evidence: NativeStopEvidence): Promise<void> }

/** Exceptional stop recovery only. Session history is not a live OS-process probe.
 * Absence never clears a remembered job; only the exact owner's producer-reported
 * settlement does. A disposed/quiescent native execution is still required in
 * addition to this producer evidence before reporting a successful stop.
 */
export function pendingNativeStopJobs(owner: string, events: readonly SessionEvent[], knownJobs: readonly string[] = []): string[] {
  const jobs = new Set(knownJobs)
  for (const event of events) {
    if (event.type === 'job/registered' && event.data.owner === owner) jobs.add(event.data.jobId)
    if (event.type === 'job/settled' && event.data.owner === owner) {
      if (event.data.producerReported === true) jobs.delete(event.data.jobId)
      else jobs.add(event.data.jobId)
    }
  }
  return [...jobs].sort()
}

/** Native handles remain Host-owned; no UI component owns execution or cancellation. */
export class NativeExecutions {
  private readonly openings = new Map<string, Opening>()
  private readonly unconfirmedOpenings = new Map<string, Opening>()
  private readonly executions = new Map<string, Execution>()
  private readonly operations = new Map<string, Promise<unknown>>()
  constructor(private readonly ctx: Context, private readonly gateway: DshAgentGateway, private readonly observations: ExecutionObservations,
    private readonly evidence?: NativeStopEvidenceHooks) {}
  private serial<T>(workId: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.operations.get(workId) ?? Promise.resolve()).catch(() => {}).then(operation)
    this.operations.set(workId, result)
    void result.finally(() => { if (this.operations.get(workId) === result) this.operations.delete(workId) }).catch(() => {})
    return result
  }
  open(identity: WorkIdentity, request: Omit<DshAgentRequest, 'role'>): Promise<OwnedDshAgent> {
    return this.serial(identity.workId, async () => {
      const unresolved = this.unconfirmedOpenings.get(identity.workId)
      if (unresolved) throw new Error(unresolved.result?.status === 'unconfirmed' ? unresolved.result.reason : 'Prior native creation stop is unconfirmed.')
      const current = this.executions.get(identity.workId)
      if (current) {
        if (current.unconfirmed) throw new Error(current.unconfirmed)
        if (current.identity.executionId === identity.executionId) return current.agent
        throw new Error('Stop the owned execution before opening its replacement.')
      }
      const controller = new AbortController()
      let finishOpening!: () => void
      const settled = new Promise<void>(resolve => { finishOpening = resolve })
      const opening: Opening = { identity: { ...identity }, sessionId: request.sessionId, controller, settled }
      this.openings.set(identity.workId, opening)
      const externalAbort = () => controller.abort(request.signal?.reason)
      request.signal?.addEventListener('abort', externalAbort, { once: true })
      if (request.signal?.aborted) externalAbort()
      let agent: OwnedDshAgent
      try {
        agent = await this.gateway.create({ ...request, signal: controller.signal, role: nativeRole[identity.role] })
      } catch (error) {
        if (controller.signal.aborted) {
          opening.result = error instanceof DshAgentCreationCancelled && error.executionStopped
            ? { status: 'stopped' }
            : { status: 'unconfirmed', reason: error instanceof Error ? error.message : String(error), jobs: [] }
          opening.detail = error instanceof Error ? error.message : String(error)
          // Hold successor admission until the cancellation owner has persisted
          // its result, including when native non-publication is confirmed.
          this.unconfirmedOpenings.set(identity.workId, opening)
        }
        throw error
      } finally {
        request.signal?.removeEventListener('abort', externalAbort)
        if (this.openings.get(identity.workId) === opening) this.openings.delete(identity.workId)
        finishOpening()
      }
      const execution: Execution = { identity: { ...identity }, agent, stopping: false, unsettled: new Set() }
      this.executions.set(identity.workId, execution)
      try {
        // Register while the Host is active. Root disposal cannot create new
        // Cordis effects, and may remove this listener before native teardown.
        execution.off = this.ctx.on('session/event', (session, event) => {
          if (session !== agent.actualAgent.session) return
          if (event.type === 'job/registered' && event.data.owner === agent.actualAgent.id) {
            execution.unsettled.add(event.data.jobId); execution.stopEvidence?.()
          }
          if (event.type === 'job/settled' && event.data.owner === agent.actualAgent.id) {
            if (event.data.producerReported === true) execution.unsettled.delete(event.data.jobId)
            else execution.unsettled.add(event.data.jobId)
            execution.stopEvidence?.()
          }
        })
        await this.observations.bind(identity, agent)
      }
      catch (error) {
        const stopped = await this.stopOwned(execution)
        if (stopped.status === 'unconfirmed') throw new AggregateError([error, new Error(stopped.reason)], 'Execution binding and native cleanup failed')
        throw error
      }
      return agent
    })
  }
  get(workId: string): OwnedDshAgent | undefined { return this.executions.get(workId)?.agent }
  /** Abort only the matching admission out of band, then join its actual factory/cleanup. */
  cancelOpening(workId: string, executionId: string, reason: unknown = new Error('Owned native creation cancelled.')): Promise<StopResult> {
    const opening = this.openings.get(workId) ?? this.unconfirmedOpenings.get(workId)
    if (!opening || opening.identity.executionId !== executionId) return Promise.resolve({ status: 'superseded' })
    if (opening.cancellation) return opening.cancellation
    const cancel = async (): Promise<StopResult> => {
      const evidence = (phase: NativeStopEvidence['phase'], detail?: string) => this.evidence?.save({ workId, executionId,
        agentId: opening.sessionId, sessionId: opening.sessionId, jobs: [], phase, ...(detail ? { reason: detail } : {}) })
      try {
        if (this.evidence) await evidence('stopping')
        opening.controller.abort(reason)
        await opening.settled
        // A factory ignoring cancellation can return a real handle. Keep the
        // ordinary serial stop responsible for that handle, never drop it.
        const current = this.executions.get(workId)
        if (current?.identity.executionId === executionId) return await this.serial(workId, () => this.stopOwned(current))
        const result = opening.result ?? { status: 'unconfirmed' as const, reason: 'Native creation cancellation has no quiescence evidence.', jobs: [] }
        if (result.status === 'stopped') {
          if (this.evidence) await evidence('disposed', opening.detail)
          this.unconfirmedOpenings.delete(workId)
        }
        return result
      } catch (error) {
        const result: StopResult = { status: 'unconfirmed', reason: error instanceof Error ? error.message : String(error), jobs: [] }
        this.unconfirmedOpenings.set(workId, opening)
        return result
      }
    }
    const result = cancel()
    opening.cancellation = result
    void result.finally(() => { if (opening.cancellation === result) opening.cancellation = undefined }).catch(() => {})
    return result
  }
  stop(workId: string, executionId: string, recoveryAction?: ScheduledObservation): Promise<StopResult> {
    const opening = this.openings.get(workId) ?? this.unconfirmedOpenings.get(workId)
    if (opening?.identity.executionId === executionId) {
      if (recoveryAction) return this.observations.mayApply(recoveryAction).then(applicable => applicable
        ? this.cancelOpening(workId, executionId) : { status: 'superseded' as const })
      return this.cancelOpening(workId, executionId)
    }
    return this.serial(workId, async () => {
      const current = this.executions.get(workId)
      if (!current || current.identity.executionId !== executionId) return { status: 'superseded' }
      return this.stopOwned(current, recoveryAction)
    })
  }
  private async stopOwned(current: Execution, recoveryAction?: ScheduledObservation): Promise<StopResult> {
    const { workId, executionId } = current.identity
    if (recoveryAction && !await this.observations.mayApply(recoveryAction)) return { status: 'superseded' }
    current.stopping = true
    const agent = current.agent.actualAgent
    const unsettled = current.unsettled
    const reconcileHistory = () => {
      const known = [...unsettled, ...current.agent.observe().jobs.filter(job => job.owner === agent.id
        && (job.status === 'running' || job.status === 'stopping')).map(job => String(job.id))]
      const recovered = pendingNativeStopJobs(String(agent.id), agent.session.snapshotEvents(), known)
      unsettled.clear()
      for (const id of recovered) unsettled.add(id)
    }
    const save = (phase: NativeStopEvidence['phase'], reason?: string) => this.evidence?.save({
      workId, executionId, agentId: String(agent.id), sessionId: current.agent.sessionId ?? String(agent.id),
      jobs: [...unsettled].sort(), phase, ...(reason === undefined ? {} : { reason }),
    }) ?? Promise.resolve()
    let updates = Promise.resolve(), persistenceFailure: unknown
    const queueEvidence = () => {
      // Capture this exact event's state before the next synchronous event changes
      // it. Host event dispatch does not await listeners: serialize writes and
      // drain them before acknowledging stop. The pre-dispose marker plus native
      // durable session history covers a crash before an event write finishes.
      const value: NativeStopEvidence = { workId, executionId, agentId: String(agent.id),
        sessionId: current.agent.sessionId ?? String(agent.id), jobs: [...unsettled].sort(), phase: 'stopping' }
      updates = updates.then(async () => { await this.evidence?.save(value) }).catch(error => { persistenceFailure = error })
    }
    // The listener is only live evidence. Native history remains authoritative
    // when root disposal removes all Host effects concurrently.
    const off = () => { current.off?.(); current.off = undefined }
    current.stopEvidence = queueEvidence
    try {
      reconcileHistory()
      // Mandatory durable intent precedes the first potentially destructive native
      // operation. If this fails, do not dispose or claim anything stopped.
      queueEvidence()
      await updates
      if (persistenceFailure !== undefined) throw persistenceFailure
      await this.observations.unbind(workId, executionId)
      await current.agent.dispose()
      off()
      await updates
      if (persistenceFailure !== undefined) throw persistenceFailure
      reconcileHistory()
      if (unsettled.size) {
        current.unconfirmed = 'Native teardown did not confirm producer settlement for owned jobs.'
        await save('stopping', current.unconfirmed)
        return { status: 'unconfirmed', reason: current.unconfirmed, jobs: [...unsettled] }
      }
      await save('disposed')
      this.executions.delete(workId)
      return { status: 'stopped' }
    } catch (error) {
      off()
      await updates
      current.unconfirmed = error instanceof Error ? error.message : String(error)
      // Retain the in-memory handle even if persistence itself failed. Never turn
      // an empty registry or failed acknowledgement into successful replacement.
      return { status: 'unconfirmed', reason: current.unconfirmed, jobs: [...unsettled] }
    } finally { current.stopEvidence = undefined; off(); current.stopping = false }
  }
}
