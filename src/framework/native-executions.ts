import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-jobs'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { DshAgentGateway } from '../adapters/dsh/agents.js'
import type { DshAgentRequest, DshAgentRole, OwnedDshAgent } from '../adapters/dsh/host-types.js'
import type { WorkIdentity } from './recovery.js'
import type { ExecutionObservations, ScheduledObservation } from './execution-observation.js'

const nativeRole = { Foreground: 'foreground', Organizer: 'organizer', Planner: 'planner', Worker: 'worker', Recorder: 'recorder', Helper: 'helper' } satisfies Record<WorkIdentity['role'], DshAgentRole>
interface Execution { identity: WorkIdentity; agent: OwnedDshAgent; stopping: boolean; unsettled: Set<string>; unconfirmed?: string }
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
      const current = this.executions.get(identity.workId)
      if (current) {
        if (current.unconfirmed) throw new Error(current.unconfirmed)
        if (current.identity.executionId === identity.executionId) return current.agent
        throw new Error('Stop the owned execution before opening its replacement.')
      }
      const agent = await this.gateway.create({ ...request, role: nativeRole[identity.role] })
      const execution: Execution = { identity: { ...identity }, agent, stopping: false, unsettled: new Set() }
      this.executions.set(identity.workId, execution)
      try { await this.observations.bind(identity, agent) }
      catch (error) {
        const stopped = await this.stopOwned(execution)
        if (stopped.status === 'unconfirmed') throw new AggregateError([error, new Error(stopped.reason)], 'Execution binding and native cleanup failed')
        throw error
      }
      return agent
    })
  }
  get(workId: string): OwnedDshAgent | undefined { return this.executions.get(workId)?.agent }
  stop(workId: string, executionId: string, recoveryAction?: ScheduledObservation): Promise<StopResult> {
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
    // Owning Host scope survives Agent disposal. Only actual owner/session events
    // contribute; unowned jobs and copied session history cannot settle this work.
    const off = this.ctx.on('session/event', (session, event) => {
      if (session !== agent.session) return
      if (event.type === 'job/registered' && event.data.owner === agent.id) {
        unsettled.add(event.data.jobId); queueEvidence()
      }
      if (event.type === 'job/settled' && event.data.owner === agent.id) {
        if (event.data.producerReported === true) unsettled.delete(event.data.jobId)
        else unsettled.add(event.data.jobId)
        queueEvidence()
      }
    })
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
    } finally { off(); current.stopping = false }
  }
}
