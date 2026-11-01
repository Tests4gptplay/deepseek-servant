import { LocalFiles } from './local-files.js'
import { FrameworkTaskIndex } from './task-index.js'
import { randomUUID, createHash } from 'node:crypto'
import type { StoragePort } from '../contracts/ports.js'
import { signalWorkerId, parseDirectSignal } from './role-tools.js'
import { cleanupRecordPath, type CleanupRecord } from './cleaner.js'
import type { RecoveryRole } from './recovery.js'
import type { FrameworkTransactions } from './command-transactions.js'
import { discoverInbox, initializeTask, taskIdentity, paths, readJson, type TaskMetadata } from './task-files.js'
import { FilesConflictError, type FileEntry, type FilesSnapshot, type FilesStore } from './transactions.js'

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
  wake(request: RoleWake): Promise<void>
  executing(role: RecoveryRole, taskId?: string, workerId?: string): boolean
  /** Normal total completion ends business roles, not Foreground or Recorder. */
  sealBusiness(task: TaskMetadata): Promise<void>
  clean(task: TaskMetadata, snapshot: FilesSnapshot): Promise<boolean | void>
  /** Release only this Host's associations after authoritative shared file cleanup. */
  releaseTask(taskId: string): Promise<void>
  /** Full startup scan and batch arrangement must finish before ordinary polling. */
  startup(): Promise<void>
  /** Existing loop owns heartbeat and execution observation checks. */
  observe(): Promise<void>
  /** Borrow this poll's post-maintenance view; do not release it or reuse it after writes. */
  discover?(snapshot: FilesSnapshot): Promise<void>
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
  private readonly metadata: FrameworkTaskIndex
  private readonly seenSources = new Map<string, string>()
  private record: LoopRecord = { initial: {}, completed: {} }
  private timer?: ReturnType<typeof setTimeout>
  private running?: Promise<void>
  private connected = false
  private stopping = false
  private readonly key: string
  constructor(readonly files: FilesStore, private readonly transactions: FrameworkTransactions,
    private readonly storage: StoragePort, private readonly identity: { member: string; primary: boolean; scope: string },
    private readonly members: () => readonly string[], private readonly actions: HostLoopActions) {
    this.key = 'framework-host/' + digest(identity.scope)
    this.metadata = new FrameworkTaskIndex(files, error => actions.error(error), () => actions.changed?.())
  }
  async start(): Promise<void> {
    if (this.connected) return
    this.stopping = false
    this.record = await this.storage.get<LoopRecord>(this.key) ?? { initial: {}, completed: {} }
    if (this.stopping) return
    await this.actions.startup()
    if (this.stopping) return
    this.connected = true
    try { await this.poll() } catch (error) { this.actions.error(error) }
    this.schedule()
  }
  private schedule(): void {
    if (!this.connected) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.poll().catch(this.actions.error).finally(() => this.schedule())
    }, 1_000)
  }
  async stop(): Promise<void> {
    this.stopping = true
    this.connected = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    await this.running
  }
  poll(): Promise<void> {
    if (this.stopping) return Promise.resolve()
    if (this.running) return this.running
    const operation = this.runPoll()
    this.running = operation
    void operation.finally(() => { if (this.running === operation) this.running = undefined }).catch(() => {})
    return operation
  }
  private async save(): Promise<void> { await this.storage.set(this.key, this.record) }
  private async wake(role: RecoveryRole, snapshot: FilesSnapshot, sources: FileEntry[], taskId?: string, workerId?: string): Promise<void> {
    if (this.stopping || !sources.length || this.actions.executing(role, singleton(role) ? undefined : taskId, workerId)) return
    await this.actions.wake({ id: digest(JSON.stringify([role, taskId, workerId, snapshot.revision, sources.map(source => source.path)])),
      role, taskId, workerId, sources: sources.map(({ path, version }) => ({ path, version })), reason: 'notification' })
  }
  private async runPoll(): Promise<void> {
    try { await this.actions.observe() } catch (error) { this.actions.error(error) }
    if (this.stopping) return
    const snapshot = await this.files.snapshot().catch(error => { this.actions.discoveryInterrupted?.(); throw error })
    try {
      try { await this.actions.discover?.(snapshot) } catch (error) { this.actions.error(error) }
      if (this.stopping) return
      const entries = await this.files.listDirectory(snapshot, 'tasks/')
      const tasks = await this.metadata.list(snapshot, entries)
      if (this.stopping) return
      const locallyReleased = new Set(Object.entries(this.record.completed).filter(([, value]) => value.released).map(([id]) => id))
      const manuallyCleared = new Set<string>(), unreadableCleanup = new Set<string>()
      if (this.files instanceof LocalFiles) for (const task of tasks) {
        if (this.record.completed[task.taskId]?.released) continue
        try {
          const cleanup = await readJson<CleanupRecord & { historyCleared?: boolean }>(this.files, snapshot, cleanupRecordPath(task.taskId))
          if (cleanup?.version === 1 && cleanup.taskId === task.taskId && cleanup.phase === 'released' && cleanup.historyCleared === true) manuallyCleared.add(task.taskId)
        } catch (error) { this.actions.error(error); unreadableCleanup.add(task.taskId) }
      }
      if (this.identity.primary) {
        for (const entry of entries.filter(entry => /_(P|O)\.md$/.test(entry.path))) {
          if (this.seenSources.get(entry.path) === entry.version) continue
          if (manuallyCleared.size || unreadableCleanup.size || locallyReleased.size) {
            const sourceTask = taskIdentity(await this.files.read(snapshot, entry.path) ?? '')
            if (sourceTask && (manuallyCleared.has(sourceTask) || unreadableCleanup.has(sourceTask) || locallyReleased.has(sourceTask))) {
              this.seenSources.set(entry.path, entry.version)
              continue
            }
          }
          const command = 'initialize:' + digest(entry.path + ':' + entry.version)
          let assignment = this.record.initial[command]
          if (!assignment) {
            assignment = { taskId: randomUUID(), owner: this.identity.member, members: [...this.members()] }
            this.record.initial[command] = assignment
            await this.save()
          }
          if (this.stopping) return
          let mutated: boolean | undefined
          try {
            await this.transactions.run(command, { source: entry.path, ...assignment }, { snapshot, expectedRevision: snapshot.revision, reevaluate: true },
              async checked => {
                const changes = (await initializeTask(this.files, checked, entry.path, assignment.owner, assignment.members, assignment.taskId)).changes
                mutated = changes.length > 0
                return changes
              })
          } catch (error) { if (error instanceof FilesConflictError) return; throw error }
          this.seenSources.set(entry.path, entry.version)
          if (mutated === false) continue
          // A mutation invalidates this poll's snapshot for later business decisions.
          return
        }
      }
      const global = await this.files.listDirectory(snapshot, 'state/')
      if (this.identity.primary) await this.wake('Foreground', snapshot, global.filter(entry => entry.path.split('/').at(-1)!.startsWith('Foreground_')))
      for (const source of global) {
        const direct = parseDirectSignal(source.path.split('/').at(-1)!)
        if (!direct || direct.member !== this.identity.member) continue
        await this.wake(direct.role, snapshot, [source], undefined, direct.role === 'Worker' ? direct.id : undefined)
      }
      for (const task of tasks) {
        if (this.stopping) return
        try {
        if (this.record.completed[task.taskId]?.released || unreadableCleanup.has(task.taskId)) continue
        if (manuallyCleared.has(task.taskId)) {
          await this.actions.releaseTask(task.taskId)
          const completion = this.record.completed[task.taskId] ??= {}
          completion.released = true
          await this.save()
          continue
        }
        if (task.status === 'complete') {
          const completion = this.record.completed[task.taskId] ??= {}
          if (completion.released) continue
          if (!completion.sealed) {
            try { await this.actions.sealBusiness(task); completion.sealed = true; await this.save() }
            catch (error) { this.actions.error(error) }
          }
          if (this.identity.primary && task.owner === this.identity.member) {
            for (const role of ['Foreground', 'Recorder'] as const) if (!completion[role]) {
              try {
              await this.actions.wake({ id: 'complete:' + task.taskId + ':' + role, role, taskId: task.taskId,
                sources: [{ path: paths.task(task.taskId), version: entries.find(entry => entry.path === paths.task(task.taskId))!.version }], reason: 'business-complete' })
              completion[role] = true; await this.save()
              } catch (error) { this.actions.error(error) }
            }
            // The cleaner also resumes a committed deletion whose local release was interrupted.
            if (await this.actions.clean(task, snapshot)) { completion.released = true; await this.save() }
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
          continue
        }
        if (task.status !== 'running') continue
        const changes = await discoverInbox(this.files, snapshot, task.taskId, this.identity.member)
        if (changes.length) {
          try {
            await this.transactions.run('inbox:' + task.taskId + ':' + digest(JSON.stringify(changes)), changes.map(({ path, content }) => ({ path, hash: digest(content ?? '') })),
              { snapshot, expectedRevision: snapshot.revision, reevaluate: true }, async () => changes)
          } catch (error) { if (error instanceof FilesConflictError) return; throw error }
          return
        }
        const signals = await this.files.listDirectory(snapshot, paths.state(this.identity.member, task.taskId))
        await this.wake('Planner', snapshot, signals.filter(entry => entry.path.split('/').at(-1)!.startsWith('Planner_')), task.taskId)
        for (const source of signals.filter(entry => entry.path.split('/').at(-1)!.startsWith('Worker_'))) {
          const child = signalWorkerId(source.path.split('/').at(-1)!)
          if (!child) continue
          await this.wake('Worker', snapshot, [source], task.taskId, child)
        }
        if (this.identity.primary && task.owner === this.identity.member && task.route === 'O') {
          const organizer = signals.filter(entry => entry.path.split('/').at(-1)!.startsWith('Organizer_'))
          for (const member of task.members ?? this.members()) {
            const path = paths.state(member, task.taskId) + '/complete'
            const memberSignals = member === this.identity.member ? signals : await this.files.listDirectory(snapshot, paths.state(member, task.taskId))
            const completion = memberSignals.find(entry => entry.path === path)
            if (completion) organizer.push(completion)
          }
          await this.wake('Organizer', snapshot, organizer, task.taskId)
        }
        } catch (error) { this.actions.error(error) }
      }
    } finally { await snapshot.release() }
  }
}
