import { isPhysicalLegacyPendingPath, resumePhysicalLegacyPublication } from './physical-legacy-publication.js'
import { resumePhysicalTaskRequirement } from './physical-task-dispatch.js'
import { compactTaskArchiveCleanup, taskArchiveHostKey, taskArchiveLifecycle, taskArchiveHostFacts, taskArchiveCleanup, taskArchiveStatePath, readTaskArchiveState, updateTaskArchiveState } from './task-archive.js'
import { readTaskHistoryIdentity, taskHistoryPath } from './task-history.js'
import { PhysicalLocalFiles } from './physical-local-files.js'
import { resumePhysicalTaskTerminalHandoff, isPhysicalForegroundPendingPath, resumePhysicalForegroundTaskNotice } from './physical-task-terminal.js'
import { GitAuthorityStore } from './git-authority.js'
import { FrameworkTaskIndex } from './task-index.js'
import { randomUUID, createHash } from 'node:crypto'
import type { StoragePort } from '../contracts/ports.js'
import { signalWorkerId, parseDirectSignal } from './role-tools.js'
import { observeCleanup, type CleanupObservation, type CleanupRecord } from './cleaner.js'
import type { RecoveryRole } from './recovery.js'
import { CommandInputsChangedError, type FrameworkTransactions } from './command-transactions.js'
import { initializeTask, preparePhysicalTask, taskIdentity, paths, foregroundTaskSignal, parseForegroundTaskSignal, readJson, encodeJson, isTerminalTask, taskLifecycle, taskLifecycleKey, type TaskMetadata, type TaskHostWorkspace } from './task-files.js'
import { FilesConflictError, FilesOutcomeUnknownError, GitFiles, withOperationChannel, withSnapshot, type FileChange, type FileEntry, type FilesSnapshot, type FilesStore, type FilesReadRound } from './transactions.js'

export interface RoleWake {
  id: string
  role: RecoveryRole
  taskId?: string
  lifecycleId?: string
  workerId?: string
  sources: Array<{ path: string; version: string }>
  reason: 'notification' | 'business-complete' | 'startup-recovery' | 'helper' | 'observation' | 'user-resume'
  context?: Record<string, unknown>
}
export interface TaskRoleNotification {
  role: 'Planner' | 'Worker' | 'Organizer'
  taskId: string
  lifecycleId?: string
  workerId?: string
  sources: RoleWake['sources']
  observation: object
}
export interface DirectRoleNotification {
  role: 'Planner' | 'Worker'
  directId: string
  workerId?: string
  sources: RoleWake['sources']
  observation: object
}
export interface HostLoopActions {
  physicalSignalSources?(path: string): Promise<readonly { path: string; version: string }[]>
  /** Optional display context only; returns the original owned operation promise. */
  operation?<T>(work: () => Promise<T>): Promise<T>
  /** Resolve after durable scheduling, never after a model turn. */
  wake(request: RoleWake): Promise<boolean | void>
  /** Admit newly persisted discovery only after the borrowed view is released. Never waits for a model turn. */
  admitDiscovered?(): Promise<void>
  /** Schedule owned online delivery without joining native admission/persistence. No wake, consumption or turn policy. */
  notifyForeground?(sources: RoleWake['sources']): Promise<void>
  /** Local conversation ownership from the existing STATE names and, only for
   * older physical names, this collaboration's original message index. */
  routeForegroundSignals?(sources: readonly FileEntry[]): Promise<FileEntry[]>
  /** Existing running Task discovery only; does not await native persistence. */
  notifyTask?(request: TaskRoleNotification): Promise<void>
  notifyDirect?(request: DirectRoleNotification): Promise<void>
  executing(role: RecoveryRole, taskId?: string, workerId?: string, directId?: string): boolean
  /** Normal total completion ends business roles, not Foreground or Recorder. */
  sealBusiness(task: TaskMetadata): Promise<void>
  cancelledBusinessStopped?(task: TaskMetadata): Promise<boolean>
  workspaceRoot?(taskId: string): string
  restoreWorkspaces?(initial: readonly { taskId: string; workspace?: TaskHostWorkspace }[]): void
  releaseWorkspace?(taskId: string): void
  initializeWorkspace?(task: TaskMetadata): Promise<void>
  clean(task: TaskMetadata, snapshot: FilesSnapshot, observation: CleanupObservation): Promise<boolean | void>
  /** Release only this Host's associations; Local cleanup calls this before directory removal, Git after shared cleanup. */
  releaseTask(taskId: string, lifecycleId?: string, selected?: TaskMetadata): Promise<void>
  /** Full startup scan and batch arrangement must finish before ordinary polling. */
  startup(): Promise<void>
  /** Local execution metadata only; must not wait for remote Files operations. */
  observeLocal?(round?: FilesReadRound): Promise<void>
  /** Schedule owned maintenance without joining unrelated remote work. */
  observe(round?: FilesReadRound, observation?: object): Promise<void>
  /** Borrow this poll's view; do not release it or reuse it after writes. */
  discover?(snapshot: FilesSnapshot): Promise<void>
  /** This Task owns its fixed state checks; another Task cannot hold this view. */
  discoverTask?(task: TaskMetadata, snapshot: FilesSnapshot): Promise<void | boolean>
  /** Register the round before any reader can fix its HEAD. */
  readRoundStarted?(round: object): void
  /** Existing discovery results only; display consumers must not open reads. */
  taskStateEntries?(entries: readonly FileEntry[], snapshot: FilesSnapshot, round: object): void
  taskStateObserved?(task: TaskMetadata, snapshot: FilesSnapshot, round: object): Promise<void>
  discoveryInterrupted?(): void
  error(error: unknown, role?: RecoveryRole): void
  changed?(): void
}
type TaskDispatch = (role: RecoveryRole, workerId: string | undefined, action: () => Promise<boolean>) => void
interface InitialAssignment {
  taskId: string; lifecycleId?: string; owner: string; members: string[]
  /** Existing Host reservation owns physical restart identity, not source version. */
  physicalSourcePath?: string
  workspace?: TaskHostWorkspace
  /** Operation-local preparation only; removed once publication is settled. */
  initialSignal?: { temporary: string; prepared?: true }
}
interface LoopRecord {
  initial: Record<string, InitialAssignment>
  completed: Record<string, { sealed?: boolean; released?: boolean; cleanup?: PhysicalCleanupResponsibility }>
}
/** Original Host responsibility while its exact total cleanup is unfinished.
 * It is removed, not archived, once metadata and release facts are retired. */
interface PhysicalCleanupResponsibility {
  family: Array<Pick<TaskMetadata, 'version' | 'taskId' | 'route' | 'sourcePath' | 'owner' | 'status'
    | 'lifecycleId' | 'archiveFolder' | 'members' | 'parent'>>
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const singleton = (role: RecoveryRole) => role === 'Foreground' || role === 'Helper'

/** Validate the addressed Helper signal name; its empty body is never routing evidence. */
export function helperSignalWakeHash(path: string, member: string): string | undefined {
  const prefix = 'state/Helper_' + encodeURIComponent(member).replaceAll('_', '%5F') + '_'
  if (!path.startsWith(prefix)) return
  const suffix = path.slice(prefix.length)
  return /^[a-f0-9]{64}$/.test(suffix) ? suffix : undefined
}

/** Locations only: current result/source references remain in authoritative records. */
const completionLocations = (taskId: string, task?: TaskMetadata) => ({ taskPath: paths.task(taskId), taskHistoryPath: taskHistoryPath(taskId),
  ...(task ? { archivePath: paths.archive(task), retentionPath: paths.archive(task) + '/retention.json' } : {}),
  facts: 'Consume this signal, then read current Task metadata or the archived Task identity and its result references. For Recorder, review current Cache links, retained originals and archive retention. Cleaner may have removed current metadata and working files; follow actual archive and retention references if an old path is absent.' })

/** One-second discovery targets entry files, this member's Inbox/state and global short signals. */
export class FrameworkHostLoop {
  private readonly taskLanes = new Map<string, { metadata: FrameworkTaskIndex; shape?: string; observed?: { version: string; task: TaskMetadata }; running?: Promise<void>; owned?: Promise<void> }>()
  /** Released Tasks keep only display metadata, outside the active task lanes. */
  private readonly releasedTaskMetadata = new Map<string, { version: string; task: TaskMetadata }>()
  private readonly taskOperations = new Set<Promise<void>>()
  private readonly physicalCleanupOperations = new Map<string, Promise<void>>()
  private readonly physicalReleaseOperations = new Map<string, Promise<void>>()
  private readonly physicalReleased = new Set<string>()
  /** A released native owner resumes only its original, persisted cleanup. */
  private readonly physicalCleanupAwaitingRelease = new Set<string>()
  private readonly taskRoleLanes = new Map<string, Promise<void>>()
  private readonly sourceOperations = new Map<string, Promise<void>>()
  /** Retain only an unresolved source command's original input, never a later
   * source version as a replacement for an uncertain publication. */
  private readonly sourceInitializations = new Map<string, { entry: FileEntry; revision: string }>()
  private saving: Promise<void> = Promise.resolve()
  private readonly pendingCompletion = new Map<string, Set<'sealed' | 'released'>>()
  private readonly seenSources = new Map<string, string>()
  private record: LoopRecord = { initial: {}, completed: {} }
  private timer?: ReturnType<typeof setTimeout>
  private running?: Promise<Promise<void>[]>
  private runningFlight?: { promise: Promise<Promise<void>[]>; owned: Promise<void>[] }
  private observing?: Promise<void>
  private signaling?: Promise<Promise<void>[]>
  private readonly signalLanes = new Map<string, Promise<void>>()
  private driving?: Promise<void>
  private firstPoll?: Promise<void>
  private connected = false
  private stopping = false
  private readonly key: string
  private readonly archiveHostKey: string
  constructor(readonly files: FilesStore, private readonly transactions: FrameworkTransactions,
    private readonly storage: StoragePort, private readonly identity: { member: string; primary: boolean; scope: string; instanceUUID?: string },
    private readonly members: () => readonly string[], private readonly actions: HostLoopActions) {
    this.key = 'framework-host/' + digest(identity.scope)
    this.archiveHostKey = taskArchiveHostKey(storage instanceof GitAuthorityStore ? storage.root : undefined, identity.scope, identity.instanceUUID)
  }
  hasTerminalTask(taskId: string, lifecycleId?: string): boolean {
    const key = taskLifecycleKey({ taskId, lifecycleId })
    return !!(this.record.completed[key]?.sealed || this.record.completed[key]?.released || this.pendingCompletion.get(key)?.size)
  }
  /** The original Recorder/Cleaner handoff already owns final resource close.
   * Read that existing in-memory responsibility, not directory absence or a
   * new terminal inference. Child Tasks are owned by their total Task family. */
  ownsPhysicalTaskCleanup(taskId: string, lifecycleId?: string): boolean {
    if (!(this.files instanceof PhysicalLocalFiles)) return false
    const matches = (task: TaskMetadata) => task.taskId === taskId && taskLifecycle(task) === (lifecycleId ?? '')
    if (this.record.completed[taskLifecycleKey({ taskId, lifecycleId })]?.cleanup?.family.some(matches)) return true
    return Object.values(this.record.completed).some(entry => entry.cleanup?.family.some(matches))
  }
  /** Existing per-Host completion authority; offline Local maintenance does
   * not start a poll or infer release from another Host's cleanup receipt. */
  async taskReleased(taskId: string, lifecycleId?: string): Promise<boolean> {
    return withSnapshot(this.files, async snapshot => {
      if (this.files instanceof PhysicalLocalFiles && !await readJson<TaskMetadata>(this.files, snapshot, paths.task(taskId))) {
        const history = await readTaskHistoryIdentity(this.files, snapshot, taskId)
        if (!history || taskLifecycle(history) !== (lifecycleId ?? '')) return false
        const own = await this.storage.get<LoopRecord>(this.key)
        return !Object.values(own?.completed ?? {}).some(entry => entry.cleanup?.family.some(task => task.taskId === taskId && taskLifecycle(task) === (lifecycleId ?? '')))
      }
      return taskArchiveHostFacts(await readTaskArchiveState(this.files, snapshot, taskId), { lifecycleId }, this.archiveHostKey)?.released === true
    })
  }
  async start(): Promise<void> {
    if (this.connected) return
    this.stopping = false
    this.record = await this.storage.get<LoopRecord>(this.key) ?? { initial: {}, completed: {} }
    if (this.stopping) return
    this.actions.restoreWorkspaces?.(Object.values(this.record.initial).filter(value => !this.record.completed[taskLifecycleKey(value)]?.released))
    await this.actions.startup()
    if (this.stopping) return
    this.connected = true
    const first = this.firstPoll = this.poll()
    // Recovery and its arrangements are complete. Ordinary discovery does not
    // gate connection startup, but remains owned for error reporting and stop.
    this.schedule()
    void first.catch(error => this.actions.error(error)).finally(() => {
      if (this.firstPoll === first) this.firstPoll = undefined
    }).catch(() => {})
  }
  private schedule(): void {
    if (!this.connected) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.driving) { if (!this.signaling) void this.signalPoll().catch(this.actions.error) }
      else {
        const flight = this.drive()
        this.driving = flight
        void flight.catch(this.actions.error).finally(() => { if (this.driving === flight) this.driving = undefined })
      }
      this.schedule()
    }, 1_000)
  }
  async stop(): Promise<void> {
    this.stopping = true
    this.connected = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const settled = await Promise.allSettled([this.firstPoll, this.observing, this.signaling, this.driving, this.running, ...this.signalLanes.values(), ...this.sourceOperations.values(), ...this.taskOperations])
    const failures = settled.filter((item): item is PromiseRejectedResult => item.status === 'rejected').map(item => item.reason)
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Host loop operations did not settle successfully')
  }
  private observeLocal(round?: FilesReadRound): Promise<void> {
    if (this.stopping) return Promise.resolve()
    if (this.observing) return this.observing
    const operation = Promise.resolve().then(() => { if (!this.stopping) return this.actions.observeLocal?.(round) }).catch(error => this.actions.error(error))
    this.observing = operation
    void operation.finally(() => { if (this.observing === operation) this.observing = undefined }).catch(() => {})
    return operation
  }
  /** Timer driver never queues another remote poll behind an unresolved one. */
  private async drive(): Promise<void> {
    const startedAt = performance.now()
    const round = this.files instanceof GitFiles ? this.files.readRound('host-poll') : undefined
    if (round) this.actions.readRoundStarted?.(round)
    if (!this.signaling) void this.signalPoll(round).catch(this.actions.error)
    await this.observeLocal(round)
    if (this.stopping || this.running) return
    const flight = this.remotePoll(round, startedAt)
    void flight.promise.catch(error => this.actions.error(error))
  }
  /** Explicit callers still await the actual remote poll, not just admission. */
  async poll(): Promise<void> {
    const startedAt = performance.now()
    const round = this.files instanceof GitFiles ? this.files.readRound('host-poll') : undefined
    if (round) this.actions.readRoundStarted?.(round)
    const previousFlight = this.runningFlight
    // Attach immediately so an older flight remains owned even if it settles
    // while the independent local observation is still pending.
    const previousResult = previousFlight ? Promise.allSettled([previousFlight.promise]) : Promise.resolve([])
    const prior = [...this.signalLanes.values(), ...this.sourceOperations.values(), ...this.taskOperations]
    const observation = this.observeLocal(round)
    const signal = this.signalPoll(round)
    let owned: Promise<void>[] = []
    let currentFlight: typeof previousFlight
    const remote = observation.then(() => {
      const flight = currentFlight = this.remotePoll(round, startedAt)
      return flight.promise.then(result => { owned = result; return result }, error => { owned = flight.owned; throw error })
    })
    const [[remoteResult, signalResult], previous] = await Promise.all([Promise.allSettled([remote, signal]), previousResult])
    const signals = signalResult.status === 'fulfilled' ? signalResult.value : []
    const settled = await Promise.allSettled([...new Set([...prior, ...(previousFlight?.owned ?? []), ...owned, ...signals])])
    const earlier = previousFlight && previousFlight !== currentFlight ? previous : []
    const failures = [remoteResult, signalResult, ...earlier, ...settled].flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Owned discovery failed')
  }

  private runOperation<T>(work: () => Promise<T>): Promise<T> { return this.actions.operation ? this.actions.operation(work) : work() }
  /** Only fixed discovery reads use this transport. Snapshot operations retain
   * their own lane; callbacks, role admission and business writes do not inherit it. */
  private pollingSnapshot(revision?: string): Promise<FilesSnapshot> {
    return withOperationChannel(this.files, 'host-poll', () => this.files instanceof GitFiles && revision
      ? this.files.at(revision) : this.files.snapshot())
  }
  /** Reobserve the already addressed entry in a new live Local view. This
   * replaces a sibling-directory enumeration, not an extra validation step.
   * Ordinary discovery still finds new sources; Git keeps its leased view. */
  private async currentTaskEntry(snapshot: FilesSnapshot, entry: FileEntry, revision: string): Promise<FileEntry | undefined> {
    if (snapshot.revision === revision) return entry
    if (this.files instanceof PhysicalLocalFiles) return this.files.fileMetadata(entry.path)
    return (await this.files.listDirectory(snapshot, 'tasks/', { paths: [entry.path] })).find(item => item.path === entry.path)
  }
  private remotePoll(round: FilesReadRound | undefined, startedAt: number): { promise: Promise<Promise<void>[]>; owned: Promise<void>[] } {
    if (this.stopping) return { promise: Promise.resolve([]), owned: [] }
    if (this.runningFlight) return this.runningFlight
    const owned: Promise<void>[] = []
    // Local's token only associates existing display reads. It is not a file
    // snapshot or a new polling loop; Git retains its actual readRound identity.
    const observation = round ?? {}
    if (!round) this.actions.readRoundStarted?.(observation)
    const promise = Promise.resolve().then(() => this.stopping ? owned : this.runOperation(() => this.runPoll(owned, round, observation, startedAt)))
    const flight = { promise, owned }
    this.running = promise
    this.runningFlight = flight
    void promise.finally(() => { if (this.runningFlight === flight) { this.running = undefined; this.runningFlight = undefined } }).catch(() => {})
    return flight
  }
  private save(): Promise<void> {
    // Task/source lanes share this durable Host record; snapshot it at the ordered write.
    const write = this.saving.catch(() => {}).then(async () => {
      const initial = Object.fromEntries(Object.entries(this.record.initial).filter(([, value]) => !this.record.completed[taskLifecycleKey(value)]?.released))
      const completed = this.files instanceof PhysicalLocalFiles
        ? Object.fromEntries(Object.entries(this.record.completed).filter(([, value]) => value.cleanup)) : {}
      await this.storage.set(this.key, { initial: structuredClone(initial), completed: structuredClone(completed) })
      // A workspace callback may finish after release while this write awaits.
      // Keep other Tasks' new reservations and forget only confirmed releases.
      for (const [key, value] of Object.entries(this.record.initial))
        if (this.record.completed[taskLifecycleKey(value)]?.released) delete this.record.initial[key]
    })
    this.saving = write
    return write
  }
  private acceptWorkspace(taskId: string): { workspace?: TaskHostWorkspace } {
    const root = this.actions.workspaceRoot?.(taskId)
    return root !== undefined && this.identity.instanceUUID ? { workspace: { instanceUUID: this.identity.instanceUUID, root } } : {}
  }
  /** Local's existing Host record reserves its identity before dispatch. Git
   * publishes the assignment with initialization in one transaction below. */
  private async reserveLocalAssignment(command: string, sourcePath?: string, sourceTask?: string): Promise<InitialAssignment> {
    if (this.files instanceof PhysicalLocalFiles && sourcePath) {
      // Adding the Task ID changes the source's physical observation version.
      // Reuse its ORIGINAL reservation, including when interruption happened
      // before that first source write. A completed old source is not a new task.
      const known = Object.values(this.record.initial).find(value => value.physicalSourcePath === sourcePath
        && (sourceTask ? value.taskId === sourceTask : !!value.initialSignal))
      if (known) { await this.save(); return known }
      const taskId = sourceTask ?? randomUUID()
      const proposal: InitialAssignment = { taskId, owner: this.identity.member, members: [...this.members()],
        physicalSourcePath: sourcePath,
        ...this.acceptWorkspace(taskId),
        initialSignal: { temporary: paths.state(this.identity.member, taskId) + '/.initial-signal-' + randomUUID() } }
      this.record.initial[command] = proposal
      await this.save()
      return proposal
    }
    const taskId = this.record.initial[command]?.taskId ?? randomUUID()
    const proposal = this.record.initial[command] ?? { taskId, owner: this.identity.member, members: [...this.members()], ...this.acceptWorkspace(taskId) }
    this.record.initial[command] = proposal
    await this.save()
    return proposal
  }
  private async sourceInitializationComplete(snapshot: FilesSnapshot, sourcePath: string, expectedTaskId: string): Promise<boolean> {
    if (taskIdentity(await this.files.read(snapshot, sourcePath) ?? '') !== expectedTaskId) return false
    const task = await readJson<TaskMetadata>(this.files, snapshot, paths.task(expectedTaskId))
    return task?.taskId === expectedTaskId && task.sourcePath === sourcePath
  }
  private async initializeGitSource(entry: FileEntry, source: string | undefined, command: string): Promise<TaskMetadata> {
    if (!(this.files instanceof GitFiles) || !(this.storage instanceof GitAuthorityStore)) throw new Error('Atomic Git initialization requires Git authority.')
    const files = this.files, records = this.storage
    const taskId = this.record.initial[command]?.taskId ?? randomUUID()
    const proposal = this.record.initial[command] ?? { taskId, owner: this.identity.member, members: [...this.members()], ...this.acceptWorkspace(taskId) }
    this.record.initial[command] = proposal
    let initialized: TaskMetadata | undefined
    const receipt = await this.transactions.runFinalization('atomic-source:' + command,
      { source: entry.path, version: entry.version }, { reevaluate: true }, async checked => {
        if (await files.read(checked, entry.path) !== source) throw new CommandInputsChangedError()
        const state = await records.getAt<LoopRecord>(checked, this.key) ?? { initial: {}, completed: {} }
        const assignment = state.initial[command] ?? proposal
        const plan = await initializeTask(files, checked, entry.path, assignment.owner, assignment.members, assignment.taskId, assignment.workspace)
        initialized = plan.value
        return [...plan.changes, records.change(this.key, { ...state, completed: {}, initial: {
          ...state.initial, [command]: { ...assignment, taskId: plan.value.taskId, ...(plan.value.lifecycleId ? { lifecycleId: plan.value.lifecycleId } : {}) }
        } })]
      }, async checked => {
        const assignment = (await records.getAt<LoopRecord>(checked, this.key))?.initial[command]
        const expectedTaskId = taskIdentity(source ?? '') ?? assignment?.taskId ?? proposal.taskId
        return this.sourceInitializationComplete(checked, entry.path, expectedTaskId)
      })
    if (receipt.replay || !initialized) {
      const committed = await files.at(receipt.revision)
      try {
        const taskId = taskIdentity(await files.read(committed, entry.path) ?? '')
        initialized = taskId ? await readJson<TaskMetadata>(files, committed, paths.task(taskId)) : undefined
      } finally { await committed.release() }
    }
    if (!initialized) throw new Error('Initialized Task metadata is unavailable for its workspace.')
    this.record.initial[command] = { ...proposal.workspace ? { workspace: proposal.workspace } : {}, taskId: initialized.taskId, ...(initialized.lifecycleId ? { lifecycleId: initialized.lifecycleId } : {}), owner: initialized.owner, members: initialized.members ?? [initialized.owner] }
    return initialized
  }
  /** The Host and runtime share one own-Host fact in the Task's program state.
   * Initial assignments are transient reservations, not a second terminal log. */
  private async persistCompletion(task: TaskMetadata, completion: NonNullable<LoopRecord['completed'][string]>, flag: 'sealed' | 'released'): Promise<void> {
    const taskId = taskLifecycleKey(task)
    let pending = this.pendingCompletion.get(taskId)
    if (!pending) this.pendingCompletion.set(taskId, pending = new Set())
    pending.add(flag)
    await updateTaskArchiveState(this.files, task.taskId, async (snapshot, identity, state) => {
      if (taskLifecycle(identity) !== taskLifecycle(task)) throw new Error('Task lifecycle changed before Host completion.')
      const lifecycle = taskArchiveLifecycle(state, task) ?? {}, hosts = lifecycle.hosts ?? {}, own = taskArchiveHostFacts(state, task, this.archiveHostKey) ?? {}
      let next = { ...state, lifecycles: { ...state.lifecycles, [taskLifecycle(task)]: { ...lifecycle, hosts: { ...hosts,
        [this.archiveHostKey]: { ...own, [flag]: true as const } } } } }
      if (flag === 'released' && !(this.files instanceof GitFiles)) next = compactTaskArchiveCleanup(next, task)
      const changes: FileChange[] = []
      let metadata: TaskMetadata | undefined
      if (flag === 'released' && this.storage instanceof GitAuthorityStore) {
        const currentTask = identity as TaskMetadata, own = this.identity.instanceUUID, bindings = currentTask.hostWorkspaces
        if (own && bindings?.[own] !== undefined) {
          const { hostWorkspaces: _locations, ...rest } = currentTask
          const { [own]: _released, ...remaining } = bindings
          metadata = { ...rest, ...(Object.keys(remaining).length ? { hostWorkspaces: remaining } : {}) }
        }
        const current = await this.storage.getAt<LoopRecord>(snapshot, this.key)
        if (current) {
          const initial = Object.fromEntries(Object.entries(current.initial).filter(([, value]) => taskLifecycleKey(value) !== taskId))
          const completed = { ...current.completed }; delete completed[taskId]
          if (JSON.stringify(initial) !== JSON.stringify(current.initial) || JSON.stringify(completed) !== JSON.stringify(current.completed))
            changes.push(this.storage.change(this.key, { ...current, initial, completed }))
        }
      }
      return { state: next, metadata, changes, result: undefined, write: JSON.stringify(next) !== JSON.stringify(state) || !!metadata || !!changes.length }
    })
    // The program-state commit already proved this own-Host fact. Cache it
    // before the separate Local acknowledgement, whose failure remains pending.
    completion[flag] = true
    this.record.completed[taskId] = { ...this.record.completed[taskId], ...completion }
    if (flag === 'released') for (const [key, value] of Object.entries(this.record.initial))
      if (taskLifecycleKey(value) === taskId) delete this.record.initial[key]
    if (!(this.storage instanceof GitAuthorityStore)) await this.save()
    pending.delete(flag)
    if (!pending.size) this.pendingCompletion.delete(taskId)
    if (flag === 'released') this.actions.releaseWorkspace?.(task.taskId)
  }
  private async settlePendingCompletion(task: TaskMetadata): Promise<void> {
    const key = taskLifecycleKey(task), pending = this.pendingCompletion.get(key)
    if (!pending) return
    const completion = this.record.completed[key] ??= {}
    for (const flag of [...pending]) await this.persistCompletion(task, completion, flag)
  }
  private async wake(role: RecoveryRole, snapshot: Pick<FilesSnapshot, 'revision'>, sources: FileEntry[], taskId?: string, workerId?: string, context?: Record<string, unknown>, lifecycleId?: string, observation?: object, directId?: string): Promise<boolean> {
    if (this.stopping || !sources.length) return false
    if (this.actions.executing(role, singleton(role) ? undefined : taskId, workerId, directId)) {
      const selected = sources.map(({ path, version }) => ({ path, version }))
      if (directId && observation && (role === 'Planner' || role === 'Worker'))
        await this.actions.notifyDirect?.({ role, directId, workerId, observation, sources: selected })
      else if (observation && taskId && (role === 'Planner' || role === 'Worker' || role === 'Organizer'))
        await this.actions.notifyTask?.({ role, taskId, lifecycleId, workerId, observation, sources: selected })
      return false
    }
    return (await this.actions.wake({ id: digest(JSON.stringify([role, taskId, lifecycleId, workerId, snapshot.revision, sources.map(source => source.path)])),
      role, taskId, ...(lifecycleId ? { lifecycleId } : {}), workerId, sources: sources.map(({ path, version }) => ({ path, version })), reason: 'notification', ...(context ? { context } : {}) })) !== false
  }
  private async runPoll(owned: Promise<void>[], round: FilesReadRound | undefined, observation: object, startedAt: number): Promise<Promise<void>[]> {
    try { await this.actions.observe(round, observation) } catch (error) { this.actions.error(error) }
    if (this.stopping) return owned
    const inspect = async (snapshot: FilesSnapshot) => {
      if (this.stopping) return owned
      try { await this.actions.discover?.(snapshot) } catch (error) { this.actions.error(error) }
      if (this.stopping) return owned
      const entries = this.files instanceof GitFiles
        ? await this.files.discoverDirectory(snapshot, 'tasks/', false)
        : await this.files.listDirectory(snapshot, 'tasks/')
      const taskEntries = entries.filter(entry => /^tasks\/[^/]+\.json$/.test(entry.path))
      // An interrupted original cleanup owns these exact Task IDs even when
      // some metadata was already deleted. No archive traversal or rediscovery
      // can reconstruct this authority, and unrelated Tasks keep their lanes.
      const cleaning = new Set<string>()
      if (this.files instanceof PhysicalLocalFiles) for (const [key, completion] of Object.entries(this.record.completed)) {
        if (!completion.cleanup) continue
        for (const task of completion.cleanup.family) cleaning.add(task.taskId)
        owned.push(this.continuePhysicalCleanup(key))
      }
      if (observation) this.actions.taskStateEntries?.(taskEntries, snapshot, observation)
      const present = new Set(taskEntries.map(entry => entry.path))
      for (const [path, lane] of this.taskLanes) if (!present.has(path) && !lane.running) this.taskLanes.delete(path)
      for (const path of this.releasedTaskMetadata.keys()) if (!present.has(path)) this.releasedTaskMetadata.delete(path)
      for (const entry of taskEntries) {
        if (cleaning.has(entry.path.slice('tasks/'.length, -5))) continue
        // An independent business scan may still own the Task lane. This round's
        // directory proves whether its already-parsed immutable body is still
        // exact at this H; reuse only that match, never a different/unknown blob.
        const released = this.releasedTaskMetadata.get(entry.path)
        if (released && released.version !== entry.version) this.releasedTaskMetadata.delete(entry.path)
        const lane = this.taskLanes.get(entry.path)
        const known = lane?.observed ?? (released?.version === entry.version ? released : undefined)
        // A busy/released Local lane already has this exact metadata. Enqueue
        // its independent display read here; idle lanes do so in startTask once.
        if (observation && known?.version === entry.version
          && (!(this.files instanceof PhysicalLocalFiles) || lane?.running || released?.version === entry.version)) {
          try { await this.actions.taskStateObserved?.(structuredClone(known.task), snapshot, observation) }
          catch (error) { this.actions.error(error) }
        }
        // A terminal Task remains active through Recorder, Cleaner, old native
        // producers and UNKNOWN recovery. Only this Host's completed release
        // removes its lane; a new metadata/lifecycle version enters normally.
        if (released?.version === entry.version) continue
        const operation = this.startTask(entry, snapshot.revision, observation, startedAt, round)
        if (operation) owned.push(operation)
      }
      if (this.stopping) return owned
      if (this.identity.primary) {
        for (const entry of entries.filter(entry => /_(P|O)\.md$/.test(entry.path))) {
          const operation = this.startSource(entry, snapshot.revision)
          if (operation) owned.push(operation)
        }
      }

      return owned
    }
    try {
      if (round) return await round.withSnapshot(inspect)
      const snapshot = await this.pollingSnapshot()
      try { return await inspect(snapshot) } finally { await snapshot.release() }
    } catch (error) { this.actions.discoveryInterrupted?.(); throw error }
  }
  /** Signals own their flight and lease; only the round HEAD is shared, never a wait on maintenance. */
  private signalPoll(round?: FilesReadRound): Promise<Promise<void>[]> {
    if (this.stopping) return Promise.resolve([])
    if (this.signaling) return this.signaling
    const operation = Promise.resolve().then(() => this.runOperation(() => this.runSignalPoll(round)))
    this.signaling = operation
    void operation.finally(() => { if (this.signaling === operation) this.signaling = undefined }).catch(() => {})
    return operation
  }
  private async runSignalPoll(round?: FilesReadRound): Promise<Promise<void>[]> {
    if (this.stopping) return []
    const observation = round ?? {}
    if (!round) this.actions.readRoundStarted?.(observation)
    const inspect = async (snapshot: FilesSnapshot) => ({ revision: snapshot.revision,
      global: this.stopping ? [] : await this.files.listDirectory(snapshot, 'state/') })
    const read = async () => {
      if (round) return round.withSnapshot(inspect)
      const snapshot = await this.pollingSnapshot()
      try { return await inspect(snapshot) } finally { await snapshot.release() }
    }
    const { revision, global } = await read()
    // Wakes carry immutable source identities, not a live/released view.
    const snapshot = { revision }
    if (this.stopping) return []
    // Each role has one ordered lane; an unrelated held/failing wake cannot
    // delay another role's admission. No lane borrows the released view.
    const lanes = new Map<string, Array<() => Promise<boolean>>>()
    const enqueue = (key: string, action: () => Promise<boolean>) => {
      const lane = lanes.get(key) ?? []
      lane.push(action); lanes.set(key, lane)
    }
    if (this.identity.primary && this.files instanceof PhysicalLocalFiles) {
      const files = this.files
      // Resume only a previously accepted legacy action discovered in this
      // existing state observation. This does not discover or route old work.
      for (const source of global.filter(entry => isPhysicalLegacyPendingPath(entry.path))) {
        enqueue('LegacyPublication:' + source.path, async () => {
          await resumePhysicalLegacyPublication(files, source.path, this.actions.physicalSignalSources)
          return false
        })
      }
      for (const source of global.filter(entry => isPhysicalForegroundPendingPath(entry.path))) {
        // Same global directory observation, independent existing signal lane.
        // Task cleanup does not own this pending Foreground publication.
        enqueue('ForegroundTaskPublication:' + source.path, async () => {
          const taskId = await resumePhysicalForegroundTaskNotice(files, source.path, this.actions.physicalSignalSources)
          if (!taskId) return false
          return withSnapshot(files, async current => {
            const target = foregroundTaskSignal(taskId)
            const signals = await files.listDirectory(current, 'state/', { paths: [target] })
            return this.wake('Foreground', current, signals, taskId, undefined, completionLocations(taskId))
          })
        })
      }
    }
    const foregroundUnrouted = global.filter(entry => entry.path.startsWith('state/Foreground_'))
    let foregroundSources: FileEntry[] | undefined
    if (this.identity.primary) enqueue('Foreground', async () => {
      // An older physical input may require its own conversation index. Keep
      // that read within Foreground's existing independent signal lane: it
      // cannot hold Helper, Task or Direct dispatch from this STATE round.
      foregroundSources = await (this.actions.routeForegroundSignals?.(foregroundUnrouted) ?? foregroundUnrouted)
      return false
    })
    if (this.identity.primary && this.actions.executing('Foreground')) {
      // Reuse this poll's complete STATE listing, including absence. Delivery
      // is separate from the unchanged inactive wake/admission path below.
      enqueue('Foreground', async () => {
        if (foregroundSources) await this.actions.notifyForeground?.(foregroundSources.map(({ path, version }) => ({ path, version })))
        return false
      })
    }
    if (this.identity.primary && foregroundUnrouted.some(entry => !parseForegroundTaskSignal(entry.path))) enqueue('Foreground', () =>
      this.wake('Foreground', snapshot, foregroundSources?.filter(entry => !parseForegroundTaskSignal(entry.path)) ?? []))
    if (this.identity.primary) for (const source of foregroundUnrouted) {
      const taskId = parseForegroundTaskSignal(source.path)
      if (!taskId) continue
      enqueue('Foreground', async () => {
        if (!foregroundSources?.some(entry => entry.path === source.path)) return false
        try { return await this.wake('Foreground', snapshot, [source], taskId, undefined, completionLocations(taskId)) }
        catch (error) { this.actions.error(error); return false }
      })
    }
    const helperPrefix = 'state/Helper_' + encodeURIComponent(this.identity.member).replaceAll('_', '%5F') + '_'
    for (const source of global.filter(entry => entry.path.startsWith(helperPrefix))) {
      const wakeHash = helperSignalWakeHash(source.path, this.identity.member)
      if (!wakeHash) { this.actions.error(new Error('Invalid Helper state signal: ' + source.path), 'Helper'); continue }
      enqueue('Helper:' + source.path, async () => {
        if (this.stopping || this.actions.executing('Helper')) return false
        try { return (await this.actions.wake({ id: wakeHash, role: 'Helper', reason: 'notification', sources: [{ path: source.path, version: source.version }] })) !== false }
        catch (error) { this.actions.error(error, 'Helper'); return false }
      })
    }
    for (const source of global) {
      const direct = parseDirectSignal(source.path.split('/').at(-1)!)
      if (!direct || direct.member !== this.identity.member) continue
      const workerId = direct.role === 'Worker' ? direct.id : undefined
      enqueue(direct.role + ':' + direct.id, () => this.wake(direct.role, snapshot, [source], undefined, workerId, undefined, undefined, observation, direct.id))
    }
    const owned: Promise<void>[] = []
    for (const [key, lane] of lanes) {
      const active = this.signalLanes.get(key)
      if (active) { owned.push(active); continue }
      const operation = Promise.resolve().then(() => this.runOperation(async () => {
        let scheduled = false
        const errors: unknown[] = []
        for (const dispatch of lane) {
          if (this.stopping) break
          try { scheduled = await dispatch() || scheduled } catch (error) { errors.push(error) }
        }
        if (scheduled && !this.stopping) {
          try { await this.actions.admitDiscovered?.() } catch (error) { errors.push(error) }
        }
        if (errors.length === 1) throw errors[0]
        if (errors.length) throw new AggregateError(errors, 'Signal lane failed')
      }))
      this.signalLanes.set(key, operation); owned.push(operation)
      void operation.catch(error => this.actions.error(error)).finally(() => { if (this.signalLanes.get(key) === operation) this.signalLanes.delete(key) })
    }
    return owned
  }

  private startSource(entry: FileEntry, revision: string): Promise<void> | undefined {
    if (this.stopping) return
    const pending = this.sourceOperations.get(entry.path)
    if (pending) return pending
    if (this.seenSources.get(entry.path) === entry.version) return
    const retained = this.sourceInitializations.get(entry.path)
    if (retained) { entry = retained.entry; revision = retained.revision }
    const operation = Promise.resolve().then(() => this.runOperation(async () => {
      if (this.stopping) return
      const snapshot = this.files instanceof GitFiles ? await this.files.at(revision) : await this.files.snapshot()
      try {
        if (this.stopping) return
        const current = await this.currentTaskEntry(snapshot, entry, revision)
        if (!current || this.seenSources.get(current.path) === current.version || this.stopping) return
        const source = await this.files.read(snapshot, current.path)
        const sourceTask = taskIdentity(source ?? '')
        if (this.stopping) return
        if (sourceTask && this.files instanceof PhysicalLocalFiles && Object.values(this.record.completed)
          .some(value => value.cleanup?.family.some(task => task.taskId === sourceTask && task.sourcePath === current.path))) return
        if (sourceTask && !retained) {
          if (this.files instanceof PhysicalLocalFiles) {
            const history = await readTaskHistoryIdentity(this.files, snapshot, sourceTask)
            if (history?.sourcePath === current.path) {
              this.seenSources.set(current.path, current.version)
              return
            }
          }
          const sourceMetadata = await readJson<TaskMetadata>(this.files, snapshot, paths.task(sourceTask))
          const sourceKey = taskLifecycleKey({ taskId: sourceTask, lifecycleId: sourceMetadata?.lifecycleId })
          const released = sourceMetadata && taskArchiveHostFacts(await readTaskArchiveState(this.files, snapshot, sourceMetadata), sourceMetadata, this.archiveHostKey)?.released
          if (released || this.record.completed[sourceKey]?.released) {
            this.seenSources.set(current.path, current.version)
            return
          }
          const physicalPending = this.files instanceof PhysicalLocalFiles && Object.values(this.record.initial)
            .some(value => value.taskId === sourceTask && value.physicalSourcePath === current.path && value.initialSignal)
          if (sourceMetadata && !physicalPending) {
            // An already-existing Task without our pending reservation is not
            // a request to send its consumed initial notification again.
            await this.actions.initializeWorkspace?.(sourceMetadata)
            this.seenSources.set(current.path, current.version)
            return
          }
        }
        if (this.stopping) return
        const command = 'initialize:' + digest(current.path + ':' + current.version)
        let initialized: TaskMetadata | undefined
        let assignment: InitialAssignment | undefined
        try {
          if (this.files instanceof GitFiles) {
            this.sourceInitializations.set(current.path, { entry: current, revision: snapshot.revision })
            initialized = await this.initializeGitSource(current, source, command)
            this.sourceInitializations.delete(current.path)
          } else if (this.files instanceof PhysicalLocalFiles) {
            const files = this.files
            assignment = await this.reserveLocalAssignment(command, current.path, sourceTask)
            if (this.stopping) return
            const signal = assignment.initialSignal
            if (signal && !signal.prepared) {
              initialized = await preparePhysicalTask(files, snapshot, current.path, assignment)
              assignment.owner = initialized.owner
              assignment.members = initialized.members ?? [initialized.owner]
              if (initialized.lifecycleId) assignment.lifecycleId = initialized.lifecycleId
              // Content and metadata are durable before even preparing a wake.
              await files.createIfAbsent(signal.temporary, '')
              signal.prepared = true
              try { await this.save() }
              catch (error) { delete signal.prepared; throw error }
            } else initialized = await readJson<TaskMetadata>(files, snapshot, paths.task(assignment.taskId))
            if (!initialized || initialized.taskId !== assignment.taskId || initialized.sourcePath !== current.path || initialized.parent)
              throw new Error('Prepared Task metadata is unavailable for its initial notification.')
            if (signal) {
              if (initialized.status === 'running') {
                const target = paths.state(initialized.owner, initialized.taskId)
                  + (initialized.route === 'P' ? '/Planner_Inbox' : '/Organizer_Task')
                // Only a durably prepared temporary may be absent here. Rename
                // consumed it, so even a since-consumed target is NOT re-emitted.
                await files.rename(signal.temporary, target)
              } else await files.delete(signal.temporary)
              delete assignment.initialSignal
              try { await this.save() }
              catch (error) { assignment.initialSignal = signal; throw error }
            }
          } else {
            assignment = await this.reserveLocalAssignment(command)
            if (this.stopping) return
            await this.transactions.runFinalization(command, { source: current.path, ...assignment }, { reevaluate: true },
              async checked => {
                if (await this.files.read(checked, current.path) !== source) throw new CommandInputsChangedError()
                const plan = await initializeTask(this.files, checked, current.path, assignment!.owner, assignment!.members, assignment!.taskId, assignment!.workspace)
                initialized = plan.value
                return plan.changes
              }, checked => this.sourceInitializationComplete(checked, current.path, sourceTask ?? assignment!.taskId))
          }
        } catch (error) {
          if (error instanceof FilesConflictError || error instanceof CommandInputsChangedError) { this.sourceInitializations.delete(current.path); return }
          if (!(error instanceof FilesOutcomeUnknownError)) this.sourceInitializations.delete(current.path)
          throw error
        }
        if (this.actions.initializeWorkspace) {
          if (!initialized) {
            const committed = await this.files.snapshot()
            try { initialized = await readJson<TaskMetadata>(this.files, committed, paths.task(sourceTask ?? assignment!.taskId)) }
            finally { await committed.release() }
          }
          if (!initialized) throw new Error('Initialized Task metadata is unavailable for its workspace.')
          await this.actions.initializeWorkspace(initialized)
        }
        if (!(this.files instanceof GitFiles) && !(this.files instanceof PhysicalLocalFiles) && initialized) {
          this.record.initial[command] = { taskId: initialized.taskId, ...(initialized.lifecycleId ? { lifecycleId: initialized.lifecycleId } : {}), owner: initialized.owner, members: initialized.members ?? [initialized.owner] }
          await this.save()
        }
        this.seenSources.set(current.path, current.version)
        // Ordinary discovery reads the committed Task on a subsequent view.
        // Initialization never emits business wakes from its pre-commit view.
      } finally { await snapshot.release() }
    }))
    this.sourceOperations.set(entry.path, operation)
    void operation.catch(error => this.actions.error(error)).finally(() => {
      if (this.sourceOperations.get(entry.path) === operation) this.sourceOperations.delete(entry.path)
    })
    return operation
  }
  /** Last actually parsed Task body, not a claim about an unread new blob.
   * Its lifecycle and reciprocal relationship remain attached to that body.
   * The original lane replaces it on a parsed update and retires on removal. */
  observedTask(taskId: string): TaskMetadata | undefined {
    return this.taskLanes.get(paths.task(taskId))?.observed?.task
  }
  private startTask(entry: FileEntry, revision: string, observation: object, startedAt: number, round?: FilesReadRound): Promise<void> | undefined {
    if (this.stopping) return
    let lane = this.taskLanes.get(entry.path)
    if (!lane) {
      lane = { metadata: new FrameworkTaskIndex(this.files, error => this.actions.error(error), this.actions.taskStateObserved ? undefined : () => this.actions.changed?.()) }
      this.taskLanes.set(entry.path, lane)
    }
    if (lane.running) return lane.owned
    const owned = lane, dispatches = new Map<string, Array<() => Promise<boolean>>>()
    const roleOperations: Promise<void>[] = []
    const enqueue: TaskDispatch = (role, workerId, action) => {
      const key = JSON.stringify([entry.path, role, workerId])
      const queue = dispatches.get(key) ?? []
      queue.push(action); dispatches.set(key, queue)
    }
    const scanning = Promise.resolve().then(() => this.runOperation(async () => {
      if (this.stopping) return
      const snapshot = round ? await round.acquireSnapshot() : await this.pollingSnapshot(revision)
      let scheduled = false
      try {
        if (this.stopping) return
        // A task lane never borrows a poll view that another Task can hold open.
        // Git borrows an independent lease of the actual poll observation. Refresh the
        // entry only when an independent Local view advanced before acquisition.
        const current = await this.currentTaskEntry(snapshot, entry, revision)
        if (!current) return
        const [task] = await owned.metadata.list(snapshot, [current])
        if (this.stopping) return
        if (!task) {
          // Preserve the original visible→invalid→visible structural invalidation
          // responsibility. Missing/invalid reads do not emit a Task state.
          const wasVisible = owned.shape !== undefined
          owned.shape = undefined; owned.observed = undefined
          if (wasVisible && this.actions.taskStateObserved) this.actions.changed?.()
          return
        }
        owned.observed = { version: current.version, task: structuredClone(task) }
        if (observation && this.actions.taskStateObserved) {
          // Status/control has its already-read projection. Only structural Task
          // changes keep the original full-view invalidation responsibility.
          const shape = JSON.stringify({ ...task, status: undefined, runtimeState: undefined })
          const changed = owned.shape !== shape; owned.shape = shape
          try { await this.actions.taskStateObserved(task, snapshot, observation) } catch (error) { this.actions.error(error) }
          if (changed) this.actions.changed?.()
        }
        const physicalCleanup = this.files instanceof PhysicalLocalFiles && !task.parent && task.owner === this.identity.member
          && await this.files.read(snapshot, paths.state(task.owner, task.taskId) + '/Cleaner') !== undefined
        if (!physicalCleanup && await this.actions.discoverTask?.(task, snapshot) === false) return
        if (!this.stopping) scheduled = await this.scanTask(task, snapshot, startedAt, enqueue, observation)
      } finally {
        await snapshot.release()
        if (!this.stopping) for (const [key, queue] of dispatches) {
          // An existing role flight owns its writes. Do not attach another
          // timer waiter, but let discovery and other roles keep progressing.
          if (this.taskRoleLanes.has(key)) continue
          const operation = Promise.resolve().then(() => this.runOperation(async () => {
            let admitted = false
            const errors: unknown[] = []
            for (const dispatch of queue) {
              if (this.stopping) break
              try { admitted = await dispatch() || admitted } catch (error) { errors.push(error) }
            }
            if (admitted && !this.stopping) {
              try { await this.actions.admitDiscovered?.() } catch (error) { errors.push(error) }
            }
            if (errors.length === 1) throw errors[0]
            if (errors.length) throw new AggregateError(errors, 'Task role discovery failed')
          }))
          this.taskRoleLanes.set(key, operation); roleOperations.push(operation)
          void operation.catch(error => this.actions.error(error)).finally(() => { if (this.taskRoleLanes.get(key) === operation) this.taskRoleLanes.delete(key) })
        }
        if (scheduled && !this.stopping) await this.actions.admitDiscovered?.()
      }
    }))
    // The metadata lane ends once reads are released and role flights are
    // registered. Explicit poll and stop still own every newly admitted write,
    // including a failed sibling that settled before a held one.
    const operation = scanning.then(async () => {
      const failures = (await Promise.allSettled(roleOperations)).flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (failures.length === 1) throw failures[0]
      if (failures.length) throw new AggregateError(failures, 'Task role discovery failed')
    }, async error => {
      const failures = (await Promise.allSettled(roleOperations)).flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (!failures.length) throw error
      throw new AggregateError([error, ...failures], 'Task discovery failed')
    })
    owned.running = scanning; owned.owned = operation; this.taskOperations.add(operation)
    void scanning.catch(error => this.actions.error(error)).finally(() => { if (owned.running === scanning) owned.running = undefined })
    // Errors are reported by their own scan/role flight immediately, not after
    // an unrelated held sibling. The aggregate retains disposal/poll evidence.
    void operation.finally(() => {
      this.taskOperations.delete(operation)
      const observed = owned.observed
      if (observed && this.record.completed[taskLifecycleKey(observed.task)]?.released
        && this.taskLanes.get(entry.path) === owned && owned.owned === operation && !owned.running) {
        this.releasedTaskMetadata.set(entry.path, observed)
        this.taskLanes.delete(entry.path)
      }
    }).catch(() => {})
    return operation
  }
  private async scanTask(task: TaskMetadata, snapshot: FilesSnapshot, startedAt: number, enqueue?: TaskDispatch, observation?: object): Promise<boolean> {
    const lifecycleKey = taskLifecycleKey(task)
    let scheduled = false
    try {
      if (this.files instanceof PhysicalLocalFiles && !task.parent && task.owner === this.identity.member) {
        // This existing Recorder notice takes precedence even after a partial
        // release. Mechanical/history state is not permission to clean it.
        const observed = await observeCleanup(this.files, snapshot, task, startedAt)
        if (observed.status !== 'not-requested' || observed.error) {
          if (observed.error) throw observed.error
          if (!this.stopping) {
            const completion = this.record.completed[lifecycleKey] ??= {}
            completion.cleanup ??= { family: (observed.family ?? [task]).map(member => ({
              version: 1, taskId: member.taskId, route: member.route, sourcePath: member.sourcePath,
              owner: member.owner, status: member.status, archiveFolder: paths.archive(member).slice('archives/'.length),
              ...(member.lifecycleId ? { lifecycleId: member.lifecycleId } : {}),
              ...(member.members ? { members: [...member.members] } : {}),
              ...(member.parent ? { parent: { ...member.parent } } : {}),
            })) }
            // Persist the existing Host's exact responsibility before any
            // full runtime metadata can disappear, including after restart.
            await this.save()
            await this.continuePhysicalCleanup(lifecycleKey)
          }
          return false
        }
      }
      // An existing Cleaner notice is independent of any unfinished terminal
      // notification phase. Resume only after that original cleanup priority.
      if (this.files instanceof PhysicalLocalFiles) {
        task = await resumePhysicalTaskRequirement(this.files, task, this.actions.physicalSignalSources)
        task = await resumePhysicalTaskTerminalHandoff(this.files, task, this.actions.physicalSignalSources)
      }
      const archiveState = await readTaskArchiveState(this.files, snapshot, task)
      const saved = taskArchiveHostFacts(archiveState, task, this.archiveHostKey)
      if (this.files instanceof PhysicalLocalFiles && !task.parent && task.owner === this.identity.member && saved?.released) {
        // unlink(Cleaner) can finish immediately before process exit, leaving
        // only its empty containing directory. Resume this final rmdir from
        // the existing own-Host release fact, never from signal absence alone.
        // A new file is preserved; it does not reopen Cleaner or gate a Task.
        try { await this.files.removeEmptyDirectory(paths.state(task.owner, task.taskId)) }
        catch (error) { if (!['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error }
      }
      let stateEntries: FileEntry[] | undefined
      const stateSignals = async () => stateEntries ??= await this.files.listDirectory(snapshot, paths.state(this.identity.member, task.taskId))
      if (saved) this.record.completed[lifecycleKey] = { ...this.record.completed[lifecycleKey], ...saved }
      // Cold restart can find the confirmed state after a failed Local Host
      // acknowledgement. Reuse this poll to retire that exact reservation.
      if (saved?.released && !(this.storage instanceof GitAuthorityStore)
        && Object.values(this.record.initial).some(value => taskLifecycleKey(value) === lifecycleKey)) await this.save()
      try { await this.settlePendingCompletion(task) } catch (error) { this.actions.error(error) }
      await (async () => {
        if (this.stopping) return
        if (this.record.completed[lifecycleKey]?.released) return
        // The root's actual Cleaner signal or committed cleanup continuation
        // is independent of business status. Reuse this Task's existing state
        // listing and archive observation; no whole-tree readiness scan.
        if (!(this.files instanceof PhysicalLocalFiles) && !task.parent && (taskArchiveCleanup(archiveState, task)
          || task.owner === this.identity.member && (await stateSignals()).some(entry => entry.path.split('/').at(-1) === 'Cleaner'))) {
          const observed = await observeCleanup(this.files, snapshot, task, startedAt, task.owner === this.identity.member)
          if (!this.stopping && await this.actions.clean(task, snapshot, observed)) {
            // Directory deletion is already confirmed. Each known Task owns
            // its native/command teardown independently of its siblings.
            const releases = [...observed.family ?? [task]].reverse().map(async member => {
              const own = this.record.completed[taskLifecycleKey(member)] ??= {}
              if (own.released) return
              await this.actions.releaseTask(member.taskId, member.lifecycleId, member)
              // A child never starts Cleaner. Its successful Host release can
              // persist immediately while another member remains unresolved.
              if (member.taskId !== task.taskId) await this.persistCompletion(member, own, 'released')
            })
            const outcomes = await Promise.allSettled(releases.map(operation => operation.catch(error => {
              // Report a failed member without waiting for a held sibling, but
              // keep this Task lane owning every accepted release until settled.
              this.actions.error(error)
              throw error
            })))
            if (outcomes.some(outcome => outcome.status === 'rejected')) return
            // This existing root fact retires the sole whole-family discovery
            // lane. Write it last, or a restart could strand unfinished children.
            await this.persistCompletion(task, this.record.completed[lifecycleKey] ??= {}, 'released')
          }
          return
        }
        if (isTerminalTask(task)) {
          const completion = this.record.completed[lifecycleKey] ??= {}
          let recorderReady = true
          if (task.status === 'cancelled') {
            if (!completion.sealed) {
              try { await this.actions.sealBusiness(task); await this.persistCompletion(task, completion, 'sealed') }
              catch (error) { this.actions.error(error); recorderReady = false }
            }
            try { if (!await this.actions.cancelledBusinessStopped?.(task)) recorderReady = false }
            catch (error) { this.actions.error(error); recorderReady = false }
          }
          // Cancellation stopping governs Recorder admission, not a Cleaner
          // handoff already published by that Recorder. The latter is trusted.
          if (recorderReady && !task.parent && task.owner === this.identity.member) {
            const signals = await stateSignals()
            for (const source of signals.filter(entry => entry.path.split('/').at(-1) === 'Recorder')) {
              scheduled = await this.wake('Recorder', snapshot, [source], task.taskId, undefined, completionLocations(task.taskId, task), task.lifecycleId) || scheduled
            }
          }
          if (completion.released) return
          if (!completion.sealed) {
            try { await this.actions.sealBusiness(task); await this.persistCompletion(task, completion, 'sealed') }
            catch (error) { this.actions.error(error) }
          }
          // Terminal children retain their work and Host associations. A stale
          // child Recorder/Cleaner signal cannot start per-child finalization.
          // Only the root's finalization owns the whole-tree cleanup boundary.
          if (task.parent) return
          return
        }
        if (task.status !== 'running') return
        const signals = await stateSignals()
        const dispatch = async (role: RecoveryRole, sources: FileEntry[], workerId?: string, context?: Record<string, unknown>) => {
          if (!sources.length) return false
          const action = () => this.wake(role, snapshot, sources, task.taskId, workerId, context, task.lifecycleId, observation)
          if (enqueue) { enqueue(role, workerId, action); return false }
          return action()
        }
        if (task.route === 'P') scheduled = await dispatch('Planner', signals.filter(entry => entry.path.split('/').at(-1)!.startsWith('Planner_'))) || scheduled
        for (const source of task.route === 'P' ? signals.filter(entry => entry.path.split('/').at(-1)!.startsWith('Worker_')) : []) {
          const child = signalWorkerId(source.path.split('/').at(-1)!)
          if (!child) continue
          scheduled = await dispatch('Worker', [source], child) || scheduled
        }
        if (task.owner === this.identity.member && task.route === 'O') {
          const context = (task: TaskMetadata) => ({
            taskMetadataPath: paths.task(task.taskId), sourcePath: task.sourcePath,
            organizerNotePath: paths.run(task.taskId) + '/Organizer_Note.md', dispatchPath: paths.run(task.taskId) + '/Dispatch.md',
            ...(task.parent ? { parent: task.parent } : {}), members: task.members ?? [task.owner],
          })
          scheduled = await dispatch('Organizer', signals.filter(entry => entry.path.split('/').at(-1)!.startsWith('Organizer_')), undefined, context(task)) || scheduled
        }
      })()
    } catch (error) { this.actions.error(error) }
    return scheduled
  }
  private continuePhysicalCleanup(key: string): Promise<void> {
    const existing = this.physicalCleanupOperations.get(key)
    if (existing) return existing
    const operation = Promise.resolve().then(() => this.runOperation(async () => {
      if (!(this.files instanceof PhysicalLocalFiles) || this.stopping) return
      const files = this.files, completion = this.record.completed[key], cleanup = completion?.cleanup
      if (!cleanup) return
      const task = cleanup.family[0]
      if (!task || task.parent || task.owner !== this.identity.member || taskLifecycleKey(task) !== key)
        throw new Error('Original Host cleanup responsibility differs from its total Task.')
      // Cleaner and native release own independent work. An accepted Cleaner
      // request removes its fixed working roots without waiting for release.
      // The existing same-Task file queue still orders accepted control writes.
      this.startPhysicalRelease(key, cleanup)
      if (!completion.released && !this.physicalCleanupAwaitingRelease.has(key)) {
        const cleaned = await withSnapshot(files, snapshot => this.actions.clean(task, snapshot, {
          snapshot, task, family: cleanup.family, startedAt: performance.now(), status: 'delete',
        }))
        if (!cleaned || this.stopping) return
        this.physicalCleanupAwaitingRelease.add(key)
      }
      // Task metadata and Host release responsibility outlive the clean itself
      // until the original native release has finished independently.
      if (!this.physicalReleased.has(key)) return
      this.physicalCleanupAwaitingRelease.delete(key)
      for (const member of [...cleanup.family].reverse()) {
        if (this.stopping) return
        await files.delete(taskArchiveStatePath(member))
        await files.update(paths.task(member.taskId), bytes => {
          if (bytes === undefined) return { value: undefined }
          const current = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as TaskMetadata
          if (current.taskId !== member.taskId || taskLifecycle(current) !== taskLifecycle(member))
            throw new Error('Task lifecycle changed before runtime metadata retirement: ' + member.taskId)
          return { value: undefined, content: null }
        })
      }
      if (!completion.released) {
        // The original Host fact is saved only after directory and metadata
        // removal. Resource retirement cannot erase unfinished deletion work.
        completion.released = true
        for (const [initialKey, value] of Object.entries(this.record.initial))
          if (cleanup.family.some(member => taskLifecycleKey(member) === taskLifecycleKey(value))) delete this.record.initial[initialKey]
        try { await this.save() } catch (error) { delete completion.released; throw error }
      }
      await this.finishPhysicalRelease(key, cleanup)
      this.actions.changed?.()
    }))
    this.physicalCleanupOperations.set(key, operation); this.taskOperations.add(operation)
    void operation.finally(() => {
      if (this.physicalCleanupOperations.get(key) === operation) this.physicalCleanupOperations.delete(key)
      this.taskOperations.delete(operation)
    }).catch(() => {})
    return operation
  }
  private startPhysicalRelease(key: string, cleanup: PhysicalCleanupResponsibility): void {
    if (this.physicalReleased.has(key) || this.physicalReleaseOperations.has(key)) return
    const operation = Promise.resolve().then(async () => {
      const outcomes = await Promise.allSettled(cleanup.family.map(task =>
        this.actions.releaseTask(task.taskId, task.lifecycleId, task)))
      const errors = outcomes.flatMap(value => value.status === 'rejected' ? [value.reason] : [])
      if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Host Task resources remain pending.')
      this.physicalReleased.add(key)
      // The Task scan returned while native release ran. Continue its exact
      // durable cleanup only after that short scan operation has left its lane.
      const current = this.physicalCleanupOperations.get(key)
      if (current) await current.catch(() => {})
      if (this.physicalCleanupAwaitingRelease.has(key) && !this.stopping)
        void this.continuePhysicalCleanup(key).catch(error => this.actions.error(error))
    })
    this.physicalReleaseOperations.set(key, operation)
    void operation.catch(error => this.actions.error(error)).finally(() => {
      if (this.physicalReleaseOperations.get(key) === operation) this.physicalReleaseOperations.delete(key)
    })
  }
  private async finishPhysicalRelease(key: string, cleanup: PhysicalCleanupResponsibility): Promise<void> {
    const latest = this.record.completed[key]
    if (!latest?.released || latest.cleanup !== cleanup || !this.physicalReleased.has(key)) return
    delete latest.cleanup
    try { await this.save() } catch (error) { latest.cleanup = cleanup; throw error }
    this.physicalReleased.delete(key)
    for (const task of cleanup.family) this.actions.releaseWorkspace?.(task.taskId)
  }

}
