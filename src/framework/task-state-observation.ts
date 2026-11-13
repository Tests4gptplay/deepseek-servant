import { randomUUID } from 'node:crypto'
import { prepareTaskStates, unreadTaskMetadata, type TaskControl } from './execution-control.js'
import type { TaskMetadata } from './task-files.js'
import type { FileEntry } from './transactions.js'
import type { FrameworkTaskStateCursor, FrameworkTaskStateUpdate, FrameworkMode } from './client-contracts.js'

interface ObservedRound {
  generation: number
  ordinal: number
  revision?: string
  resolve?: ReturnType<typeof prepareTaskStates>
  waiting: Map<string, Set<string>>
  dirty: Set<string>
  processing?: Promise<void>
  listed?: Set<string>
  tasks: Map<string, TaskMetadata>
  emitted: Map<string, string>
}

/** Display-only copies of completed reads. This class has no FilesStore, timers,
 * network operations or write authority. An update is a partial Task projection. */
export class FrameworkTaskStateObservation {
  private readonly owner = randomUUID()
  private generation = 0
  private sequence = 0
  private latestLocalListing?: ObservedRound
  private latestRound = 0
  private createdRounds = 0
  private readonly rounds = new WeakMap<object, ObservedRound>()
  constructor(private readonly emit: (update: FrameworkTaskStateUpdate) => void, private readonly error: (error: unknown) => void = () => {}, private readonly mode: FrameworkMode = 'git') {}
  /** A new authoritative UI read fences older Host rounds. New rounds may still
   * publish while that read/action response is pending; the client retains them. */
  viewBoundary(): FrameworkTaskStateCursor {
    this.generation++; this.sequence = 0
    return { owner: this.owner, generation: this.generation }
  }
  begin(round: object): ObservedRound {
    let observed = this.rounds.get(round)
    if (!observed) {
      observed = { generation: this.generation, ordinal: ++this.createdRounds, tasks: new Map(), emitted: new Map(), waiting: new Map(), dirty: new Set() }
      this.rounds.set(round, observed)
    }
    return observed
  }
  controls(round: object, revision: string | undefined, values: readonly TaskControl[]): void {
    const observed = this.rounds.get(round)
    if (!observed || observed.generation !== this.generation || observed.ordinal < this.latestRound) return
    // Merely creating an unused/signal-only round cannot retire a live Task
    // reader. Advance only when the existing control read actually succeeds.
    this.latestRound = observed.ordinal
    observed.revision = revision
    observed.resolve = prepareTaskStates(structuredClone(values))
  }
  listed(round: object, revision: string, entries: readonly FileEntry[]): void {
    const observed = this.rounds.get(round)
    if (this.mode === 'local' && observed?.generation === this.generation) {
      observed.revision = revision
      observed.listed = new Set(entries.map(entry => entry.path))
      if (!this.latestLocalListing || observed.ordinal >= this.latestLocalListing.ordinal) this.latestLocalListing = observed
      return
    }
    if (!observed || !this.current(observed) || !observed.resolve) return
    if (observed.revision !== revision) return
    observed.listed = new Set(entries.map(entry => entry.path))
  }
  private current(observed: ObservedRound): boolean {
    return observed.generation === this.generation && observed.ordinal === this.latestRound
  }
  async task(round: object, revision: string, task: TaskMetadata): Promise<void> {
    // Local publishes only after its independent physical control read.
    if (this.mode !== 'git') return
    const observed = this.rounds.get(round)
    if (!observed || !this.current(observed) || observed.revision !== revision || !observed.resolve) return
    // Git bodies are immutable within their revision. Local observations use
    // localTask after the runtime completes their independent control read.
    if (!observed.tasks.has(task.taskId)) {
      observed.tasks.set(task.taskId, structuredClone(task))
      observed.dirty.add(task.taskId)
      for (const id of observed.waiting.get(task.taskId) ?? []) observed.dirty.add(id)
      observed.waiting.delete(task.taskId)
    }
    if (!observed.processing) {
      observed.processing = this.drain(observed, revision).finally(() => { observed.processing = undefined })
    }
    await observed.processing
  }
  /** A completed Local evaluation of metadata read by the Task lane. No
   * reads or shared processing queue live here. Another Task's newer round
   * cannot discard this completion; the UI generation still fences old reads.
   * The runtime's per-Task read owner rejects superseded metadata inputs. */
  localTask(round: object, revision: string, task: TaskMetadata, control: TaskControl | undefined): void {
    const observed = this.rounds.get(round)
    if (this.mode !== 'local' || !observed || observed.generation !== this.generation) return
    const listed = this.latestLocalListing
    if (listed?.generation === this.generation && listed.ordinal > observed.ordinal && !listed.listed?.has('tasks/' + task.taskId + '.json')) return
    const value = { taskId: task.taskId, ...(task.lifecycleId ? { lifecycleId: task.lifecycleId } : {}), status: task.status, control: control?.intent }
    const signature = JSON.stringify(value)
    if (observed.emitted.get(task.taskId) === signature) return
    observed.emitted.set(task.taskId, signature)
    this.emit({ owner: this.owner, generation: observed.generation, sequence: ++this.sequence, localRevision: revision, task: value })
  }
  private async drain(observed: ObservedRound, revision: string): Promise<void> {
    while (this.current(observed) && observed.dirty.size) {
      const id = observed.dirty.values().next().value!
      observed.dirty.delete(id)
      const task = observed.tasks.get(id)!
      try {
        const states = await observed.resolve!([task], async ancestor => {
          const known = observed.tasks.get(ancestor)
          if (known) return known
          if (observed.listed && !observed.listed.has('tasks/' + ancestor + '.json')) return undefined
          let waiting = observed.waiting.get(ancestor)
          if (!waiting) observed.waiting.set(ancestor, waiting = new Set())
          waiting.add(id)
          return unreadTaskMetadata
        })
        if (!this.current(observed) || observed.tasks.get(id) !== task || !states.has(id)) continue
        const control = states.get(id)
        const value = { taskId: task.taskId, ...(task.lifecycleId ? { lifecycleId: task.lifecycleId } : {}), status: task.status, control: control?.intent }
        const signature = JSON.stringify(value)
        if (observed.emitted.get(id) === signature) continue
        observed.emitted.set(id, signature)
        this.emit({ owner: this.owner, generation: observed.generation, sequence: ++this.sequence, gitRevision: revision, task: value })
      } catch (error) {
        // Malformed display metadata must not stop unrelated business lanes.
        try { this.error(error) } catch { /* reporting must remain isolated too */ }
      }
    }
  }
}
