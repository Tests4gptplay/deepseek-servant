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
  /** Consumed native probe identities already handled in this execution. */
  resetInputs?: string[]
  /** Cycles already reset by a verified native input in this exact execution.
   * Other consumed notices from those cycles are superseded, not new resets. */
  resetCycles?: number[]
  /** Retained until the scheduler durably accepts responsibility for this action. */
  pending?: ScheduledObservation
}
export interface ObservationResetResult {
  reset: boolean
  status: 'reset' | 'already-handled' | 'superseded'
}
/** Host-owned durable metadata, not business body storage or a new role signal. */
export interface ExecutionObservationStore {
  get(workId: string): Promise<StoredExecutionObservation | undefined>
  set(workId: string, value: StoredExecutionObservation, expected: StoredExecutionObservation | undefined): Promise<void>
  list(): Promise<StoredExecutionObservation[]>
  delete?(workId: string, expected: StoredExecutionObservation): Promise<void>
  released?(identity: WorkIdentity): Promise<boolean>
}
export interface ObservationScheduler {
  /** Idempotent by id; resolve after durable arrangement, not after model completion. */
  arrange(pending: ScheduledObservation): Promise<void>
}
interface Binding { identity: WorkIdentity; agent: OwnedDshAgent; unsubscribe: () => void; active: boolean; progress?: DshProgress }

/** Uses the Host's existing tick; no extra background timer or document scanning. */
export class ExecutionObservations {
  private readonly bindings = new Map<string, Binding>()
  private readonly tails = new Map<string, Promise<void>>()
  private readonly arrangements = new Map<string, Promise<void>>()
  private readonly checks = new Map<string, Promise<void>>()
  /** An unresolved publication may have committed remotely. Keep its failure
   * until that exact responsibility is durably accepted, including shutdown. */
  private readonly arrangementFailures = new Map<string, unknown>()
  constructor(private readonly store: ExecutionObservationStore, private readonly scheduler: ObservationScheduler,
    private readonly onError: (error: unknown) => void, private readonly now = Date.now) {}

  private queue<T>(workId: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(workId) ?? Promise.resolve()).then(operation)
    const settled = result.then(() => undefined, () => undefined)
    this.tails.set(workId, settled)
    void settled.then(() => { if (this.tails.get(workId) === settled) this.tails.delete(workId) })
    return result
  }
  private active(binding: Binding): boolean {
    const observation = binding.agent.observe()
    return !observation.waitingForUser && (observation.state === 'running' || observation.state === 'waiting')
  }
  private current(binding: Binding): boolean { return this.bindings.get(binding.identity.workId) === binding }

  async bind(identity: WorkIdentity, agent: OwnedDshAgent): Promise<void> {
    if (identity.role === 'Foreground') {
      const prior = this.bindings.get(identity.workId)
      if (prior) await this.unbind(identity.workId, prior.identity.executionId)
      await this.queue(identity.workId, async () => {
        const saved = await this.store.get(identity.workId)
        if (saved?.observation.identity.role === 'Foreground' && saved.executing) await this.store.set(identity.workId, { ...saved, executing: false }, saved)
      })
      return
    }
    const old = this.bindings.get(identity.workId)
    old?.unsubscribe()
    const binding: Binding = { identity: { ...identity }, agent, unsubscribe: () => {}, active: false }
    this.bindings.set(identity.workId, binding)
    try {
      await this.queue(identity.workId, async () => {
        if (!this.current(binding)) return
        if (await this.store.released?.(identity)) {
          if (this.current(binding)) this.bindings.delete(identity.workId)
          return
        }
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
          delete next.resetCycles
        }
        await this.store.set(identity.workId, next, saved)
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
        void this.queue(identity.workId, () => this.synchronize(binding)).catch(this.onError)
      }, true)
      binding.unsubscribe = () => { progress(); status() }
    } catch (error) {
      if (this.current(binding)) this.bindings.delete(identity.workId)
      binding.unsubscribe()
      throw error
    }
  }
  private async synchronize(binding: Binding): Promise<StoredExecutionObservation | undefined> {
    if (!this.current(binding)) return
    const saved = await this.store.get(binding.identity.workId)
    if (!this.current(binding) || !saved || saved.observation.identity.executionId !== binding.identity.executionId) return
    const executing = this.active(binding)
    const progress = binding.progress
    if (executing === saved.executing && !progress) return saved
    let observation = progress ? recordProgress(saved.observation, progress.kind, progress.observedAt) : saved.observation
    if (executing && !saved.executing) observation = rebindObservation(observation, binding.identity.executionId, this.now())
    const next = { ...saved, executing, observation }
    await this.store.set(binding.identity.workId, next, saved)
    if (binding.progress === progress) binding.progress = undefined
    return next
  }
  /** Invalidate synchronously before native cancellation/disposal; stale callbacks cannot cross executions. */
  async unbind(workId: string, executionId: string): Promise<void> {
    const binding = this.bindings.get(workId)
    if (!binding || binding.identity.executionId !== executionId) return
    this.bindings.delete(workId)
    binding.unsubscribe()
    await this.queue(workId, async () => {
      const saved = await this.store.get(workId)
      if (saved?.observation.identity.executionId === executionId) await this.store.set(workId, { ...saved, executing: false,
        observation: binding.progress ? recordProgress(saved.observation, binding.progress.kind, binding.progress.observedAt) : saved.observation }, saved)
    })
  }
  /** Retire the exact work identities already owned by this Task's runtime.
   * No observation catalog scan or unrelated producer barrier is required. */
  async releaseTask(taskId: string, lifecycleId = '', workIds: readonly string[] = []): Promise<void> {
    const belongs = (identity: WorkIdentity) => identity.role !== 'Foreground'
      && identity.taskId === taskId && (identity.lifecycleId ?? '') === lifecycleId
    const selected = new Set(workIds)
    for (const binding of [...this.bindings.values()]) if (belongs(binding.identity)) {
      selected.add(binding.identity.workId)
      this.bindings.delete(binding.identity.workId)
      binding.unsubscribe()
    }
    await Promise.all([...selected].map(workId => this.queue(workId, async () => {
      const saved = await this.store.get(workId)
      if (!saved || !belongs(saved.observation.identity)) return
      if (!this.store.delete) throw new Error('Observation storage does not support runtime retirement.')
      await this.store.delete(workId, saved)
    })))
  }
  /** Each work publishes as soon as its own observation is ready. A slow
   * producer does not hold another work's binding, progress or scheduler. */
  async tick(waitForArrangement = true): Promise<void> {
    const operations = [...this.bindings.values()].map(binding => {
      const workId = binding.identity.workId, existing = this.checks.get(workId)
      if (existing) return existing
      const operation = (async () => {
      const pending = await this.queue(binding.identity.workId, async () => {
        const saved = await this.synchronize(binding)
        if (binding.identity.role === 'Foreground' || !this.current(binding) || !saved?.executing || saved.observation.identity.executionId !== binding.identity.executionId) return
        const due = saved.pending ? undefined : dueObservation(saved.observation, this.now())
        const pending = saved.pending ?? (due?.action ? {
          id: JSON.stringify([binding.identity.workId, binding.identity.executionId, due.state.cycleStartedAt, due.action.stage, due.state.lastProgressAt]), action: due.action,
          cycleStartedAt: due.state.cycleStartedAt, checkedAt: due.state.cycleStartedAt + due.action.elapsedMs,
          progressAt: due.state.lastProgressAt,
        } : undefined)
        if (!pending) return
        const next: StoredExecutionObservation = { ...saved, observation: due?.state ?? saved.observation, pending }
        await this.store.set(binding.identity.workId, next, saved)
        if (this.current(binding) && this.active(binding)) return pending
      })
      if (!pending) return
      const arrangement = this.arrange(binding, pending)
      if (waitForArrangement) await arrangement
      })()
      this.checks.set(workId, operation)
      void operation.catch(this.onError).finally(() => { if (this.checks.get(workId) === operation) this.checks.delete(workId) }).catch(() => {})
      return operation
    })
    // Host ticks retain per-work responsibilities above, rather than letting
    // one stalled metadata write suspend every later Host observation tick.
    if (!waitForArrangement) return
    const errors = (await Promise.allSettled(operations)).flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    errors.push(...(await Promise.allSettled([...this.arrangements.values()])).flatMap(result => result.status === 'rejected' ? [result.reason] : []))
    if (errors.length) throw new AggregateError(errors, 'Observation arrangements failed')
  }
  private arrange(binding: Binding, pending: ScheduledObservation): Promise<void> {
    const existing = this.arrangements.get(pending.id)
    if (existing) return existing
    const operation = Promise.resolve().then(async () => {
      if (!this.current(binding) || !this.active(binding)) return
      await this.scheduler.arrange(pending)
      // Publication may finish after newer progress, a reset, or a replacement.
      // Clear only this pending receipt; never replay its old metadata snapshot.
      await this.queue(binding.identity.workId, async () => {
        const saved = await this.store.get(binding.identity.workId)
        if (saved?.observation.identity.executionId !== binding.identity.executionId || saved.pending?.id !== pending.id) return
        const next = { ...saved }
        delete next.pending
        await this.store.set(binding.identity.workId, next, saved)
      })
      this.arrangementFailures.delete(pending.id)
    })
    this.arrangements.set(pending.id, operation)
    void operation.catch(error => {
      this.arrangementFailures.set(pending.id, error)
      this.onError(error)
    }).finally(() => { if (this.arrangements.get(pending.id) === operation) this.arrangements.delete(pending.id) }).catch(() => {})
    return operation
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
      && saved.observation.stage === action.stage && saved.observation.stageStartedAt === pending.checkedAt && progressAt <= pending.progressAt
  }
  /** Only the runtime which proved that this action was not performed may defer it.
   * New native progress postpones the same phase; it is not an explicit cycle reset. */
  async deferUnperformed(pending: ScheduledObservation): Promise<void> {
    await this.queue(pending.action.identity.workId, async () => {
      const identity = pending.action.identity
      const binding = this.bindings.get(identity.workId)
      const current = () => binding && this.current(binding) && (this.active(binding) || binding.agent.observe().waitingForUser === true)
        && (['workId', 'executionId', 'role', 'taskId', 'member', 'workerId'] as const).every(key => binding.identity[key] === identity[key])
      if (identity.role === 'Foreground' || !current()) return
      const saved = await this.synchronize(binding!)
      if (!current() || !saved || saved.observation.identity.executionId !== identity.executionId
        || saved.observation.cycleStartedAt !== pending.cycleStartedAt
        || saved.observation.stage !== pending.action.stage
        || saved.observation.stageStartedAt < pending.checkedAt
        || (saved.pending && saved.pending.id !== pending.id)) return
      const progress = binding!.progress
      const observation = progress ? recordProgress(saved.observation, progress.kind, progress.observedAt) : saved.observation
      const waiting = binding!.agent.observe().waitingForUser === true
      if (!waiting && observation.stageStartedAt === pending.checkedAt && observation.lastProgressAt <= pending.progressAt) return
      const next = { ...saved, observation: { ...observation,
        stage: (pending.action.stage - 1) as 0 | 1 | 2,
        ...(waiting ? { stageStartedAt: Math.max(observation.stageStartedAt, this.now()) } : {}) } }
      delete next.pending
      await this.store.set(identity.workId, next, saved)
      if (binding!.progress === progress) binding!.progress = undefined
    })
  }
  /** Runtime proves this native probe was consumed by this exact execution before
   * calling. Queued delivery is not that proof. Receipt and reset share one write,
   * so retrying a lost acknowledgement cannot reset a later observation cycle. */
  async reset(identity: WorkIdentity, probeInputId: string, cycleStartedAt: number): Promise<ObservationResetResult> {
    return this.queue(identity.workId, async () => {
      const binding = this.bindings.get(identity.workId)
      const current = () => binding && this.current(binding) && this.active(binding)
        && (['workId', 'executionId', 'role', 'taskId', 'member', 'workerId'] as const).every(key => binding.identity[key] === identity[key])
      if (identity.role === 'Foreground' || !probeInputId || !current()) throw new Error('Observation reset requires the current active execution.')
      const saved = await this.synchronize(binding!)
      if (!current() || !saved || saved.observation.identity.executionId !== identity.executionId) throw new Error('Observation reset requires the current active execution.')
      if (saved.resetInputs?.includes(probeInputId)) return { reset: false, status: 'already-handled' }
      if (saved.resetCycles?.includes(cycleStartedAt)) {
        // A probe and warning can both be consumed after they were queued in
        // one cycle. A verified sibling notice cannot reset the successor's
        // clock or remove its pending action. Record this no-op durably too.
        await this.store.set(identity.workId, { ...saved, resetInputs: [...(saved.resetInputs ?? []), probeInputId] }, saved)
        return { reset: false, status: 'superseded' }
      }
      if (saved.observation.cycleStartedAt !== cycleStartedAt) throw new Error('Observation reset belongs to an obsolete cycle.')
      const next = { ...saved, observation: createObservation(identity, this.now()),
        resetInputs: [...(saved.resetInputs ?? []), probeInputId], resetCycles: [...(saved.resetCycles ?? []), cycleStartedAt] }
      delete next.pending
      await this.store.set(identity.workId, next, saved)
      return { reset: true, status: 'reset' }
    })
  }
  async flush(): Promise<void> {
    await Promise.all([...this.bindings.values()].map(binding => this.queue(binding.identity.workId, () => this.synchronize(binding))))
  }
  async dispose(): Promise<void> {
    await Promise.all([...this.bindings.values()].map(binding => this.unbind(binding.identity.workId, binding.identity.executionId)))
    await Promise.allSettled([...this.checks.values()])
    await Promise.allSettled([...this.arrangements.values()])
    await this.flush()
    const failures = [...this.arrangementFailures.values()]
    if (failures.length) throw new AggregateError(failures, 'Observation publications did not settle cleanly')
  }
}
