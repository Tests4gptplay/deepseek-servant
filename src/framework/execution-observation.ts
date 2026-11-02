import type { DshProgress } from '../adapters/dsh/progress.js'
import type { OwnedDshAgent } from '../adapters/dsh/host-types.js'
import { createObservation, dueObservation, rebindObservation, recordProgress,
  type ObservationAction, type ObservationState, type WorkIdentity } from './recovery.js'

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
  /** Consumed native probe identities already applied in this execution. */
  resetInputs?: string[]
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
    if (identity.role === 'Foreground') {
      const prior = this.bindings.get(identity.workId)
      if (prior) await this.unbind(identity.workId, prior.identity.executionId)
      await this.queue(async () => {
        const saved = await this.store.get(identity.workId)
        if (saved?.observation.identity.role === 'Foreground' && saved.executing) await this.store.set(identity.workId, { ...saved, executing: false })
      })
      return
    }
    const old = this.bindings.get(identity.workId)
    old?.unsubscribe()
    const binding: Binding = { identity: { ...identity }, agent, unsubscribe: () => {}, active: false }
    this.bindings.set(identity.workId, binding)
    try {
      await this.queue(async () => {
        if (!this.current(binding)) return
        const saved = await this.store.get(identity.workId)
        if (!this.current(binding)) return
        const previous = saved && old?.progress && saved.observation.identity.executionId === old.identity.executionId
          ? recordProgress(saved.observation, old.progress.kind, old.progress.observedAt) : saved?.observation
        const observation = !previous ? createObservation(identity, this.now())
          : previous.identity.executionId !== identity.executionId || (!saved?.executing && this.active(binding))
            ? rebindObservation(previous, identity.executionId, this.now()) : previous
        const next: StoredExecutionObservation = { ...saved, observation, executing: this.active(binding) }
        if (saved?.observation.identity.executionId !== identity.executionId) {
          delete next.pending
          delete next.resetInputs
        }
        await this.store.set(identity.workId, next)
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
          if (binding.identity.role === 'Foreground' || !this.current(binding) || !saved?.executing || saved.observation.identity.executionId !== binding.identity.executionId) continue
          const due = saved.pending ? undefined : dueObservation(saved.observation, this.now())
          const pending = saved.pending ?? (due?.action ? {
            id: JSON.stringify([binding.identity.workId, binding.identity.executionId, due.state.cycleStartedAt, due.action.stage, due.state.lastProgressAt]), action: due.action,
            cycleStartedAt: due.state.cycleStartedAt, checkedAt: due.state.cycleStartedAt + due.action.elapsedMs,
            progressAt: due.state.lastProgressAt,
          } : undefined)
          if (!pending) continue
          const next: StoredExecutionObservation = { ...saved, observation: due?.state ?? saved.observation, pending }
          await this.store.set(binding.identity.workId, next)
          if (!this.current(binding) || !this.active(binding)) continue
          await this.scheduler.arrange(pending)
          delete next.pending
          await this.store.set(binding.identity.workId, next)
        } catch (error) { errors.push(error) }
      }
      if (errors.length) throw new AggregateError(errors, 'Observation arrangements failed')
    })
  }
  /** Re-check queued recovery against current execution and progress immediately before acting. */
  async mayApply(pending: ScheduledObservation): Promise<boolean> {
    const { action } = pending
    const binding = this.bindings.get(action.identity.workId)
    if (action.identity.role === 'Foreground' || !binding || binding.identity.executionId !== action.identity.executionId) return false
    const saved = await this.store.get(action.identity.workId)
    if (!this.current(binding) || !this.active(binding) || !saved
      || saved.observation.identity.executionId !== action.identity.executionId) return false
    const progressAt = Math.max(saved.observation.lastProgressAt, binding.progress?.observedAt ?? -Infinity)
    return saved.observation.cycleStartedAt === pending.cycleStartedAt
      && saved.observation.stage === action.stage && progressAt <= pending.progressAt
  }
  /** Only the runtime which proved that this action was not performed may defer it.
   * New native progress postpones the same phase; it is not an explicit cycle reset. */
  async deferUnperformed(pending: ScheduledObservation): Promise<void> {
    await this.queue(async () => {
      const identity = pending.action.identity
      const binding = this.bindings.get(identity.workId)
      const current = () => binding && this.current(binding) && this.active(binding)
        && (['workId', 'executionId', 'role', 'taskId', 'member', 'workerId'] as const).every(key => binding.identity[key] === identity[key])
      if (identity.role === 'Foreground' || !current()) return
      await this.synchronize(binding!)
      const saved = await this.store.get(identity.workId)
      if (!current() || !saved || saved.observation.identity.executionId !== identity.executionId
        || saved.observation.cycleStartedAt !== pending.cycleStartedAt
        || saved.observation.stage !== pending.action.stage
        || saved.observation.stageStartedAt !== pending.checkedAt
        || (saved.pending && saved.pending.id !== pending.id)) return
      const progress = binding!.progress
      const observation = progress ? recordProgress(saved.observation, progress.kind, progress.observedAt) : saved.observation
      if (observation.lastProgressAt <= pending.progressAt) return
      const next = { ...saved, observation: { ...observation,
        stage: (pending.action.stage - 1) as 0 | 1 | 2 } }
      delete next.pending
      await this.store.set(identity.workId, next)
      if (binding!.progress === progress) binding!.progress = undefined
    })
  }
  /** Runtime proves this native probe was consumed by this exact execution before
   * calling. Queued delivery is not that proof. Receipt and reset share one write,
   * so retrying a lost acknowledgement cannot reset a later observation cycle. */
  async reset(identity: WorkIdentity, probeInputId: string, cycleStartedAt: number): Promise<void> {
    await this.queue(async () => {
      const binding = this.bindings.get(identity.workId)
      const current = () => binding && this.current(binding) && this.active(binding)
        && (['workId', 'executionId', 'role', 'taskId', 'member', 'workerId'] as const).every(key => binding.identity[key] === identity[key])
      if (identity.role === 'Foreground' || !probeInputId || !current()) throw new Error('Observation reset requires the current active execution.')
      await this.synchronize(binding!)
      const saved = await this.store.get(identity.workId)
      if (!current() || !saved || saved.observation.identity.executionId !== identity.executionId) throw new Error('Observation reset requires the current active execution.')
      if (saved.resetInputs?.includes(probeInputId)) return
      if (saved.observation.cycleStartedAt !== cycleStartedAt) throw new Error('Observation reset belongs to an obsolete cycle.')
      const next = { ...saved, observation: createObservation(identity, this.now()),
        resetInputs: [...(saved.resetInputs ?? []), probeInputId] }
      delete next.pending
      await this.store.set(identity.workId, next)
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
