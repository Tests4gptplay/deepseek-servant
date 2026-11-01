import type { DshProgress } from '../adapters/dsh/progress.js'
import type { OwnedDshAgent } from '../adapters/dsh/host-types.js'
import { createObservation, dueObservation, rebindObservation, recordProgress, canConsumeRecovery,
  completeHealthyObservationCycle, type HealthyCycleEvidence,
  type ObservationAction, type ObservationState, type WorkIdentity, type MemberIdentity } from './recovery.js'

export interface ScheduledObservation {
  id: string
  action: ObservationAction
  cycleStartedAt: number
  checkedAt: number
  progressAt: number
}
export interface StoredExecutionObservation {
  observation: ObservationState
  executing: boolean
  consumedRecoveries?: string[]
  completedHealthyCycles?: string[]
  /** Retained until the scheduler durably accepts responsibility for this action. */
  pending?: ScheduledObservation
}
/** Host-owned durable metadata, not business body storage or a new role signal. */
export interface ExecutionObservationStore {
  get(workId: string): Promise<StoredExecutionObservation | undefined>
  set(workId: string, value: StoredExecutionObservation): Promise<void>
  list(): Promise<StoredExecutionObservation[]>
}
export interface ObservationScheduler {
  /** Idempotent by id; resolve after durable arrangement, not after model completion. */
  arrange(pending: ScheduledObservation): Promise<void>
}
interface Binding { identity: WorkIdentity; agent: OwnedDshAgent; unsubscribe: () => void; active: boolean; progress?: DshProgress }

/** Uses the Host's existing tick; no extra background timer or document scanning. */
export class ExecutionObservations {
  private readonly bindings = new Map<string, Binding>()
  private tail: Promise<void> = Promise.resolve()
  constructor(private readonly store: ExecutionObservationStore, private readonly scheduler: ObservationScheduler,
    private readonly onError: (error: unknown) => void, private readonly now = Date.now) {}

  private queue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
  private active(binding: Binding): boolean {
    const state = binding.agent.observe().state
    return state === 'running' || state === 'waiting'
  }
  private current(binding: Binding): boolean { return this.bindings.get(binding.identity.workId) === binding }

  async bind(identity: WorkIdentity, agent: OwnedDshAgent): Promise<void> {
    const old = this.bindings.get(identity.workId)
    old?.unsubscribe()
    const binding: Binding = { identity: { ...identity }, agent, unsubscribe: () => {}, active: false }
    this.bindings.set(identity.workId, binding)
    try {
      await this.queue(async () => {
        if (!this.current(binding)) return
        const saved = await this.store.get(identity.workId)
        const previous = saved && old?.progress && saved.observation.identity.executionId === old.identity.executionId
          ? recordProgress(saved.observation, old.progress.kind, old.progress.observedAt) : saved?.observation
        const observation = !previous ? createObservation(identity, this.now())
          : previous.identity.executionId !== identity.executionId || (!saved?.executing && this.active(binding))
            ? rebindObservation(previous, identity.executionId, this.now()) : previous
        await this.store.set(identity.workId, { observation, executing: this.active(binding), consumedRecoveries: saved?.consumedRecoveries ?? [], completedHealthyCycles: saved?.completedHealthyCycles ?? [],
          ...(saved?.observation.identity.executionId === identity.executionId && saved.pending ? { pending: saved.pending } : {}) })
      })
      if (!this.current(binding)) return
      binding.active = this.active(binding)
      const progress = agent.subscribeProgress(event => {
        if (!this.current(binding) || !this.active(binding)) return
        // Coalesce stream fragments into the Host tick's metadata write; never write per token.
        if (!binding.progress || event.observedAt >= binding.progress.observedAt) binding.progress = event
      })
      const status = agent.subscribe(() => {
        if (!this.current(binding)) return
        const active = this.active(binding)
        if (active === binding.active) return
        binding.active = active
        void this.queue(() => this.synchronize(binding)).catch(this.onError)
      }, true)
      binding.unsubscribe = () => { progress(); status() }
    } catch (error) {
      if (this.current(binding)) this.bindings.delete(identity.workId)
      binding.unsubscribe()
      throw error
    }
  }
  private async synchronize(binding: Binding): Promise<void> {
    if (!this.current(binding)) return
    const saved = await this.store.get(binding.identity.workId)
    if (!this.current(binding) || !saved || saved.observation.identity.executionId !== binding.identity.executionId) return
    const executing = this.active(binding)
    const progress = binding.progress
    if (executing === saved.executing && !progress) return
    let observation = progress ? recordProgress(saved.observation, progress.kind, progress.observedAt) : saved.observation
    if (executing && !saved.executing) observation = rebindObservation(observation, binding.identity.executionId, this.now())
    await this.store.set(binding.identity.workId, { ...saved, executing, observation })
    if (binding.progress === progress) binding.progress = undefined
  }
  /** Invalidate synchronously before native cancellation/disposal; stale callbacks cannot cross executions. */
  async unbind(workId: string, executionId: string): Promise<void> {
    const binding = this.bindings.get(workId)
    if (!binding || binding.identity.executionId !== executionId) return
    this.bindings.delete(workId)
    binding.unsubscribe()
    await this.queue(async () => {
      const saved = await this.store.get(workId)
      if (saved?.observation.identity.executionId === executionId) await this.store.set(workId, { ...saved, executing: false,
        observation: binding.progress ? recordProgress(saved.observation, binding.progress.kind, binding.progress.observedAt) : saved.observation })
    })
  }
  async tick(): Promise<void> {
    await this.queue(async () => {
      const errors: unknown[] = []
      for (const binding of this.bindings.values()) {
        try {
          await this.synchronize(binding)
          const saved = await this.store.get(binding.identity.workId)
          if (!this.current(binding) || !saved?.executing || saved.observation.identity.executionId !== binding.identity.executionId) continue
          const due = saved.pending ? undefined : dueObservation(saved.observation, this.now())
          const pending = saved.pending ?? (due?.action ? {
            id: JSON.stringify([binding.identity.workId, binding.identity.executionId, due.state.cycleStartedAt, due.action.stage]), action: due.action,
            cycleStartedAt: due.state.cycleStartedAt, checkedAt: due.state.cycleStartedAt + due.action.elapsedMs,
            progressAt: due.state.lastProgressAt,
          } : undefined)
          if (!pending) continue
          const next = { ...saved, observation: due?.state ?? saved.observation, pending }
          await this.store.set(binding.identity.workId, next)
          if (!this.current(binding) || !this.active(binding)) continue
          await this.scheduler.arrange(pending)
          await this.store.set(binding.identity.workId, { observation: next.observation, executing: next.executing, consumedRecoveries: next.consumedRecoveries ?? [], completedHealthyCycles: next.completedHealthyCycles ?? [] })
        } catch (error) { errors.push(error) }
      }
      if (errors.length) throw new AggregateError(errors, 'Observation arrangements failed')
    })
  }
  /** Re-check queued recovery against current execution and progress immediately before acting. */
  async mayApply(pending: ScheduledObservation): Promise<boolean> {
    const { action } = pending
    const binding = this.bindings.get(action.identity.workId)
    if (!binding || binding.identity.executionId !== action.identity.executionId) return false
    const saved = await this.store.get(action.identity.workId)
    if (!this.current(binding) || !this.active(binding) || !saved
      || saved.observation.identity.executionId !== action.identity.executionId) return false
    const progressAt = Math.max(saved.observation.lastProgressAt, binding.progress?.observedAt ?? -Infinity)
    return saved.observation.cycleStartedAt === pending.cycleStartedAt
      && saved.observation.stage === action.stage && progressAt <= pending.progressAt
  }
  /** Call only after the corresponding Planner's normal-chain consumption committed. */
  async recoveryConsumed(actor: WorkIdentity, member: MemberIdentity, receiptId?: string): Promise<void> {
    if (!canConsumeRecovery(actor, member)) throw new Error('Recovery consumption belongs to the corresponding Planner.')
    await this.queue(async () => {
      const now = this.now()
      for (const saved of await this.store.list()) {
        const identity = saved.observation.identity
        if (identity.taskId !== member.taskId || identity.member !== member.member
          || (identity.role !== 'Planner' && identity.role !== 'Worker')) continue
        if (receiptId && saved.consumedRecoveries?.includes(receiptId)) continue
        await this.store.set(identity.workId, { executing: saved.executing, observation: createObservation(identity, now),
          consumedRecoveries: receiptId ? [...(saved.consumedRecoveries ?? []), receiptId] : saved.consumedRecoveries ?? [],
          completedHealthyCycles: saved.completedHealthyCycles ?? [] })
      }
    })
  }
  /** Share the execution metadata writer with bind/progress/tick. The assessment
   * receipt is saved atomically with the reset, so a late retry cannot reset a
   * subsequent cycle after the caller lost its separate command acknowledgement. */
  async healthyCycle(workId: string, evidence: HealthyCycleEvidence, receiptId: string): Promise<void> {
    await this.queue(async () => {
      const binding = this.bindings.get(workId)
      if (binding) await this.synchronize(binding)
      const saved = await this.store.get(workId)
      if (!saved) throw new Error('Execution observation does not exist for this health assessment.')
      if (saved.completedHealthyCycles?.includes(receiptId)) return
      const observation = completeHealthyObservationCycle(saved.observation, this.now(), evidence)
      const next = { ...saved, observation,
        completedHealthyCycles: [...(saved.completedHealthyCycles ?? []), receiptId] }
      if (observation !== saved.observation) delete next.pending
      await this.store.set(workId, next)
    })
  }
  async flush(): Promise<void> {
    await this.queue(async () => { for (const binding of this.bindings.values()) await this.synchronize(binding) })
  }
  async dispose(): Promise<void> {
    for (const binding of [...this.bindings.values()]) await this.unbind(binding.identity.workId, binding.identity.executionId)
    await this.flush()
  }
}
