import { LocalFiles } from './local-files.js'
import { FrameworkTaskIndex } from './task-index.js'
import { randomUUID, createHash } from 'node:crypto'
import type { StoragePort } from '../contracts/ports.js'
import { signalWorkerId, parseDirectSignal } from './role-tools.js'
import { cleanupRecordPath, type CleanupRecord } from './cleaner.js'
import type { RecoveryRole } from './recovery.js'
import type { FrameworkTransactions } from './command-transactions.js'
import { discoverInbox, initializeTask, taskIdentity, paths, readJson, type TaskMetadata } from './task-files.js'
import { FilesConflictError, GitFiles, type FileEntry, type FilesSnapshot, type FilesStore } from './transactions.js'

export interface RoleWake {
  id: string
  role: RecoveryRole
  taskId?: string
  workerId?: string
  sources: Array<{ path: string; version: string }>
  reason: 'notification' | 'business-complete' | 'startup-recovery' | 'helper' | 'observation' | 'user-resume'
  context?: Record<string, unknown>
}
export interface HostLoopActions {
  /** Resolve after durable scheduling, never after a model turn. */
  wake(request: RoleWake): Promise<boolean | void>
  /** Admit newly persisted discovery only after the borrowed view is released. Never waits for a model turn. */
  admitDiscovered?(): Promise<void>
  executing(role: RecoveryRole, taskId?: string, workerId?: string): boolean
  /** Normal total completion ends business roles, not Foreground or Recorder. */
  sealBusiness(task: TaskMetadata): Promise<void>
  clean(task: TaskMetadata, snapshot: FilesSnapshot): Promise<boolean | void>
  /** Release only this Host's associations after authoritative shared file cleanup. */
  releaseTask(taskId: string): Promise<void>
  /** Full startup scan and batch arrangement must finish before ordinary polling. */
  startup(): Promise<void>
  /** Local execution metadata only; must not wait for remote Files operations. */
  observeLocal?(): Promise<void>
  /** Schedule owned maintenance without joining unrelated remote work. */
  observe(): Promise<void>
  /** Borrow this poll's view; do not release it or reuse it after writes. */
  discover?(snapshot: FilesSnapshot): Promise<void>
  /** This Task owns its fixed state checks; another Task cannot hold this view. */
  discoverTask?(task: TaskMetadata, snapshot: FilesSnapshot): Promise<void>
  discoveryInterrupted?(): void
  error(error: unknown): void
  changed?(): void
}
interface InitialAssignment { taskId: string; owner: string; members: string[] }
interface LoopRecord {
  initial: Record<string, InitialAssignment>
  completed: Record<string, { sealed?: boolean; Foreground?: boolean; Recorder?: boolean; released?: boolean }>
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const singleton = (role: RecoveryRole) => role === 'Foreground' || role === 'Organizer' || role === 'Helper'

/** One-second discovery targets entry files, this member's Inbox/state and global short signals. */
export class FrameworkHostLoop {
  private readonly taskLanes = new Map<string, { metadata: FrameworkTaskIndex; running?: Promise<void> }>()
  private readonly sourceOperations = new Map<string, Promise<void>>()
  private saving: Promise<void> = Promise.resolve()
  private readonly seenSources = new Map<string, string>()
  private record: LoopRecord = { initial: {}, completed: {} }
  private timer?: ReturnType<typeof setTimeout>
  private running?: Promise<Promise<void>[]>
  private observing?: Promise<void>
  private connected = false
  private stopping = false
  private readonly key: string
  constructor(readonly files: FilesStore, private readonly transactions: FrameworkTransactions,
    private readonly storage: StoragePort, private readonly identity: { member: string; primary: boolean; scope: string },
    private readonly members: () => readonly string[], private readonly actions: HostLoopActions) {
    this.key = 'framework-host/' + digest(identity.scope)
  }
  async start(): Promise<void> {
    if (this.connected) return
    this.stopping = false
    this.record = await this.storage.get<LoopRecord>(this.key) ?? { initial: {}, completed: {} }
    if (this.stopping) return
    await this.actions.startup()
    if (this.stopping) return
    this.connected = true
    const first = this.poll()
    // Startup recovery has finished. Keep the same driver alive while the first
    // remote poll is pending, but do not report startup complete before it settles.
    this.schedule()
    try { await first } catch (error) { this.actions.error(error) }
  }
  private schedule(): void {
    if (!this.connected) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.drive().catch(this.actions.error).finally(() => this.schedule())
    }, 1_000)
  }
  async stop(): Promise<void> {
    this.stopping = true
    this.connected = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const settled = await Promise.allSettled([this.observing, this.running, ...this.sourceOperations.values(), ...[...this.taskLanes.values()].map(lane => lane.running)])
    const failures = settled.filter((item): item is PromiseRejectedResult => item.status === 'rejected').map(item => item.reason)
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Host loop operations did not settle successfully')
  }
  private observeLocal(): Promise<void> {
    if (this.stopping) return Promise.resolve()
    if (this.observing) return this.observing
    const operation = Promise.resolve().then(() => { if (!this.stopping) return this.actions.observeLocal?.() }).catch(error => this.actions.error(error))
    this.observing = operation
    void operation.finally(() => { if (this.observing === operation) this.observing = undefined }).catch(() => {})
    return operation
  }
  /** Timer driver never queues another remote poll behind an unresolved one. */
  private async drive(): Promise<void> {
    await this.observeLocal()
    if (this.stopping || this.running) return
    const owned = this.remotePoll()
    void owned.catch(error => this.actions.error(error))
  }
  /** Explicit callers still await the actual remote poll, not just admission. */
  async poll(): Promise<void> {
    await this.observeLocal()
    const owned = await this.remotePoll()
    // Preserve failures even if an independent lane settled before the root
    // directory pass returned and removed it from the active ownership map.
    const settled = await Promise.allSettled([...new Set([...owned, ...this.sourceOperations.values(), ...[...this.taskLanes.values()].map(lane => lane.running)])])
    const failures = settled.filter((item): item is PromiseRejectedResult => item.status === 'rejected').map(item => item.reason)
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Owned discovery failed')
  }
  private remotePoll(): Promise<Promise<void>[]> {
    if (this.stopping) return Promise.resolve([])
    if (this.running) return this.running
    const operation = Promise.resolve().then(() => this.stopping ? [] : this.runPoll())
    this.running = operation
    void operation.finally(() => { if (this.running === operation) this.running = undefined }).catch(() => {})
    return operation
  }
  private save(): Promise<void> {
    // Task/source lanes share this durable Host record; snapshot it at the ordered write.
    const write = this.saving.catch(() => {}).then(() => this.storage.set(this.key, structuredClone(this.record)))
    this.saving = write
    return write
  }
  private async wake(role: RecoveryRole, snapshot: FilesSnapshot, sources: FileEntry[], taskId?: string, workerId?: string): Promise<boolean> {
    if (this.stopping || !sources.length || this.actions.executing(role, singleton(role) ? undefined : taskId, workerId)) return false
    return (await this.actions.wake({ id: digest(JSON.stringify([role, taskId, workerId, snapshot.revision, sources.map(source => source.path)])),
      role, taskId, workerId, sources: sources.map(({ path, version }) => ({ path, version })), reason: 'notification' })) !== false
  }
  private async runPoll(): Promise<Promise<void>[]> {
    const owned: Promise<void>[] = []
    try { await this.actions.observe() } catch (error) { this.actions.error(error) }
    if (this.stopping) return owned
    const snapshot = await this.files.snapshot().catch(error => { this.actions.discoveryInterrupted?.(); throw error })
    let scheduled = false
    try {
      if (this.stopping) return owned
      try { await this.actions.discover?.(snapshot) } catch (error) { this.actions.error(error) }
      if (this.stopping) return owned
      const entries = await this.files.listDirectory(snapshot, 'tasks/')
      const taskEntries = entries.filter(entry => /^tasks\/[^/]+\.json$/.test(entry.path))
      const present = new Set(taskEntries.map(entry => entry.path))
      for (const [path, lane] of this.taskLanes) if (!present.has(path) && !lane.running) this.taskLanes.delete(path)
      for (const entry of taskEntries) {
        this.startTask(entry, snapshot.revision)
        const operation = this.taskLanes.get(entry.path)?.running
        if (operation) owned.push(operation)
      }
      if (this.stopping) return owned
      if (this.identity.primary) {
        for (const entry of entries.filter(entry => /_(P|O)\.md$/.test(entry.path))) {
          const operation = this.startSource(entry, snapshot.revision)
          if (operation) owned.push(operation)
        }
      }
      const global = await this.files.listDirectory(snapshot, 'state/')
      if (this.identity.primary) scheduled = await this.wake('Foreground', snapshot, global.filter(entry => entry.path.split('/').at(-1)!.startsWith('Foreground_'))) || scheduled
      for (const source of global) {
        const direct = parseDirectSignal(source.path.split('/').at(-1)!)
        if (!direct || direct.member !== this.identity.member) continue
        scheduled = await this.wake(direct.role, snapshot, [source], undefined, direct.role === 'Worker' ? direct.id : undefined) || scheduled
      }
    } finally {
      await snapshot.release()
      // The poll owns this admission through its existing running promise. Close
      // can drain accepted work, but cannot admit new work after view release.
      if (scheduled && !this.stopping) await this.actions.admitDiscovered?.()
    }
    return owned
  }
  private startSource(entry: FileEntry, revision: string): Promise<void> | undefined {
    if (this.stopping) return
    const pending = this.sourceOperations.get(entry.path)
    if (pending) return pending
    if (this.seenSources.get(entry.path) === entry.version) return
    const operation = Promise.resolve().then(async () => {
      if (this.stopping) return
      const snapshot = this.files instanceof GitFiles ? await this.files.at(revision) : await this.files.snapshot()
      try {
        if (this.stopping) return
        const current = snapshot.revision === revision ? entry
          : (await this.files.listDirectory(snapshot, 'tasks/')).find(item => item.path === entry.path)
        if (!current || this.seenSources.get(current.path) === current.version || this.stopping) return
        const sourceTask = taskIdentity(await this.files.read(snapshot, current.path) ?? '')
        if (this.stopping) return
        if (sourceTask) {
          const cleanup = this.files instanceof LocalFiles
            ? await readJson<CleanupRecord & { historyCleared?: boolean }>(this.files, snapshot, cleanupRecordPath(sourceTask)) : undefined
          if (this.record.completed[sourceTask]?.released || cleanup?.phase === 'released' && cleanup.historyCleared === true) {
            this.seenSources.set(current.path, current.version)
            return
          }
        }
        if (this.stopping) return
        const command = 'initialize:' + digest(current.path + ':' + current.version)
        const assignment = this.record.initial[command] ??= { taskId: randomUUID(), owner: this.identity.member, members: [...this.members()] }
        // Reaffirm the same assignment before dispatch, including after a failed
        // prior save. Never use an in-memory-only Task identity for initialization.
        await this.save()
        if (this.stopping) return
        try {
          await this.transactions.run(command, { source: current.path, ...assignment }, { snapshot, expectedRevision: snapshot.revision, reevaluate: true },
            async checked => (await initializeTask(this.files, checked, current.path, assignment.owner, assignment.members, assignment.taskId)).changes)
        } catch (error) { if (error instanceof FilesConflictError) return; throw error }
        this.seenSources.set(current.path, current.version)
        // Ordinary discovery reads the committed Task on a subsequent view.
        // Initialization never emits business wakes from its pre-commit view.
      } finally { await snapshot.release() }
    })
    this.sourceOperations.set(entry.path, operation)
    void operation.catch(error => this.actions.error(error)).finally(() => {
      if (this.sourceOperations.get(entry.path) === operation) this.sourceOperations.delete(entry.path)
    })
    return operation
  }
  private startTask(entry: FileEntry, revision: string): void {
    if (this.stopping) return
    let lane = this.taskLanes.get(entry.path)
    if (!lane) {
      lane = { metadata: new FrameworkTaskIndex(this.files, error => this.actions.error(error), () => this.actions.changed?.()) }
      this.taskLanes.set(entry.path, lane)
    }
    if (lane.running) return
    const owned = lane
    const operation = Promise.resolve().then(async () => {
      if (this.stopping) return
      const snapshot = this.files instanceof GitFiles ? await this.files.at(revision) : await this.files.snapshot()
      let scheduled = false
      try {
        if (this.stopping) return
        // A task lane never borrows a poll view that another Task can hold open.
        // Git reopens the listed commit without another HEAD read. Refresh the
        // entry only when an independent Local view advanced before acquisition.
        const current = snapshot.revision === revision ? entry
          : (await this.files.listDirectory(snapshot, 'tasks/')).find(item => item.path === entry.path)
        if (!current) return
        const [task] = await owned.metadata.list(snapshot, [current])
        if (!task || this.stopping) return
        await this.actions.discoverTask?.(task, snapshot)
        if (!this.stopping) scheduled = await this.scanTask(task, current, snapshot)
      } finally {
        await snapshot.release()
        if (scheduled && !this.stopping) await this.actions.admitDiscovered?.()
      }
    })
    owned.running = operation
    void operation.catch(error => this.actions.error(error)).finally(() => { if (owned.running === operation) owned.running = undefined })
  }
  private async scanTask(task: TaskMetadata, entry: FileEntry, snapshot: FilesSnapshot): Promise<boolean> {
    let scheduled = false, manuallyCleared = false
    try {
      if (this.files instanceof LocalFiles && !this.record.completed[task.taskId]?.released) {
        const cleanup = await readJson<CleanupRecord & { historyCleared?: boolean }>(this.files, snapshot, cleanupRecordPath(task.taskId))
        manuallyCleared = cleanup?.version === 1 && cleanup.taskId === task.taskId && cleanup.phase === 'released' && cleanup.historyCleared === true
      }
      await (async () => {
        if (this.stopping) return
        if (this.record.completed[task.taskId]?.released) return
        if (manuallyCleared) {
          await this.actions.releaseTask(task.taskId)
          const completion = this.record.completed[task.taskId] ??= {}
          completion.released = true
          await this.save()
          return
        }
        if (task.status === 'complete') {
          const completion = this.record.completed[task.taskId] ??= {}
          if (completion.released) return
          if (!completion.sealed) {
            try { await this.actions.sealBusiness(task); completion.sealed = true; await this.save() }
            catch (error) { this.actions.error(error) }
          }
          if (this.identity.primary && task.owner === this.identity.member) {
            for (const role of ['Foreground', 'Recorder'] as const) if (!completion[role]) {
              if (this.stopping) return
              try {
              const created = await this.actions.wake({ id: 'complete:' + task.taskId + ':' + role, role, taskId: task.taskId,
                sources: [{ path: paths.task(task.taskId), version: entry.version }], reason: 'business-complete' })
              scheduled = created !== false || scheduled
              completion[role] = true; await this.save()
              } catch (error) { this.actions.error(error) }
            }
            // The cleaner also resumes a committed deletion whose local release was interrupted.
            if (!this.stopping && await this.actions.clean(task, snapshot)) { completion.released = true; await this.save() }
          } else {
            try {
              const cleanup = await readJson<CleanupRecord>(this.files, snapshot, cleanupRecordPath(task.taskId))
              if (cleanup?.version === 1 && cleanup.taskId === task.taskId
                && (cleanup.phase === 'files-cleaned' || cleanup.phase === 'released')) {
                await this.actions.releaseTask(task.taskId)
                completion.released = true
                await this.save()
              }
            } catch (error) { this.actions.error(error) }
          }
          return
        }
        if (task.status !== 'running') return
        const changes = await discoverInbox(this.files, snapshot, task.taskId, this.identity.member)
        if (changes.length) {
          if (this.stopping) return
          try {
            await this.transactions.run('inbox:' + task.taskId + ':' + digest(JSON.stringify(changes)), changes.map(({ path, content }) => ({ path, hash: digest(content ?? '') })),
              { snapshot, expectedRevision: snapshot.revision, reevaluate: true }, async () => changes)
          } catch (error) { if (error instanceof FilesConflictError) return; throw error }
          return
        }
        const signals = await this.files.listDirectory(snapshot, paths.state(this.identity.member, task.taskId))
        scheduled = await this.wake('Planner', snapshot, signals.filter(entry => entry.path.split('/').at(-1)!.startsWith('Planner_')), task.taskId) || scheduled
        for (const source of signals.filter(entry => entry.path.split('/').at(-1)!.startsWith('Worker_'))) {
          const child = signalWorkerId(source.path.split('/').at(-1)!)
          if (!child) continue
          scheduled = await this.wake('Worker', snapshot, [source], task.taskId, child) || scheduled
        }
        if (this.identity.primary && task.owner === this.identity.member && task.route === 'O') {
          const organizer = signals.filter(entry => entry.path.split('/').at(-1)!.startsWith('Organizer_'))
          for (const member of task.members ?? this.members()) {
            const path = paths.state(member, task.taskId) + '/complete'
            const memberSignals = member === this.identity.member ? signals : await this.files.listDirectory(snapshot, paths.state(member, task.taskId))
            const completion = memberSignals.find(entry => entry.path === path)
            if (completion) organizer.push(completion)
          }
          scheduled = await this.wake('Organizer', snapshot, organizer, task.taskId) || scheduled
        }
      })()
    } catch (error) { this.actions.error(error) }
    return scheduled
  }
}
