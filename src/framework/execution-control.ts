import { taskArchiveHostKey, taskArchiveHostFacts, readTaskArchiveState } from './task-archive.js'
import { PhysicalLocalFiles } from './physical-local-files.js'
import { GitAuthorityStore } from './git-authority.js'
import { withSnapshot, type FileChange, type FilesSnapshot, type FilesStore } from './transactions.js'
import { paths, readJson, taskLifecycle, taskLifecycleKey, type TaskMetadata } from './task-files.js'
import { linkedChild } from './task-relations.js'
import { createHash } from 'node:crypto'
import type { StoragePort } from '../contracts/ports.js'

export type TaskControlIntent = 'running' | 'paused' | 'cancelled'
/** A retained d19 Host-local control needs user repair, not semantic Helper work. */
export class LegacyLocalControlReadError extends Error {}
export interface TaskControl {
  taskId: string
  lifecycleId?: string
  intent: TaskControlIntent
  commandId: string
  requestedAt: string
}
export interface ExecutionStopRequest {
  workId: string
  executionId: string
  taskId?: string
  lifecycleId?: string
}
export interface ExecutionStopResult {
  state: 'stopped' | 'unconfirmed' | 'superseded'
  detail?: string
  jobs?: string[]
}
export interface ExecutionStopControl extends ExecutionStopRequest {
  commandId: string
  requestedAt: string
  result?: ExecutionStopResult
}
interface Controls {
  version: 1
  tasks: Record<string, TaskControl>
  executions: Record<string, ExecutionStopControl>
  commands: Record<string, ControlCommand>
}
type LocalOwner = { taskId: string; lifecycleId?: string } | { executionId: string }
type PhysicalControlOwner = LocalOwner | { commandId: string }
interface LocalControls extends Controls { owner: LocalOwner }
interface PhysicalTaskControls extends Controls { taskId: string }
interface ControlCommand { signature: string; value: TaskControl | ExecutionStopControl; resumeHandled?: true }
interface LocalCommand { signature: string; value: TaskControl | ExecutionStopControl; predecessor?: string; resumeHandled?: true }
const emptyControls = (): Controls => ({ version: 1, tasks: {}, executions: {}, commands: {} })
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
// Access, runtime and maintenance share exact-record write ownership. Git keeps
// its existing whole-document transaction. Local Task/execution records do not
// borrow each other's I/O lane.
const controlWrites = new WeakMap<StoragePort, Map<string, Promise<void>>>()
// The previous-format file has one owner per connected StoragePort/scope. Read
// that exact historical fact once; ordinary current commands never reread it.
// No derived index or additional discovery is persisted. An uncertain mutation
// of the original file invalidates this shared fact before it can be reused.
const previousControls = new WeakMap<StoragePort, Map<string, { read?: Promise<Controls> }>>()
const reportedOldLocalControls = new WeakMap<StoragePort, Set<string>>()

/** Explicit local user-control intentions. This layer neither starts/stops an
 * Agent nor edits Task business completion, remote signals or recovery markers.
 * Runtime ownership and actual native stop confirmation remain their own duties.
 */
export class ExecutionControls {
  private readonly key: string
  private readonly scope: string
  private readonly releaseHostKey?: string
  private readonly writes: Map<string, Promise<void>>
  /** Git scoped request address. Physical Local roles select taskRecordPath instead. */
  readonly recordPath: string
  constructor(private readonly storage: StoragePort, scope: string, private readonly now = () => new Date().toISOString(), private readonly files?: FilesStore, private readonly releaseAuthority: StoragePort = storage, instanceUUID?: string, private readonly reportOldLocalControl?: (error: Error, taskId?: string) => void, private readonly oldLocalControlRecovered?: (taskId?: string) => void) {
    this.scope = scope
    this.releaseHostKey = files ? taskArchiveHostKey(releaseAuthority instanceof GitAuthorityStore ? releaseAuthority.root : undefined, scope, instanceUUID) : undefined
    this.key = 'framework-user-controls/' + hash(scope)
    let writes = controlWrites.get(storage)
    if (!writes) controlWrites.set(storage, writes = new Map())
    this.writes = writes
    this.recordPath = (storage instanceof GitAuthorityStore ? storage.root : 'technical/authority/' + hash('shared') + '/') + this.key + '.json'
  }
  /** Task controls are ordinary Task-period material, retired by its whole root. */
  taskRecordPath(taskId: string): string {
    return this.files instanceof PhysicalLocalFiles ? paths.run(taskId) + '/control.json' : this.recordPath
  }
  private physicalTaskState(taskId: string, bytes: Uint8Array | undefined): PhysicalTaskControls {
    if (bytes === undefined) return { ...emptyControls(), taskId }
    const state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as PhysicalTaskControls
    if (!state || state.taskId !== taskId
      || !state.tasks || !state.executions || !state.commands
      || [state.tasks, state.executions, state.commands].some(value => typeof value !== 'object' || Array.isArray(value)))
      throw new Error('Task control file does not match its original Task: ' + taskId)
    return state
  }
  private physicalTaskWriteKey(taskId: string, owner?: PhysicalControlOwner): string {
    const file = (this.files as PhysicalLocalFiles).directory + '\0' + this.taskRecordPath(taskId)
    return owner === undefined ? file : file + '\0' + JSON.stringify('commandId' in owner ? ['command', owner.commandId]
      : 'executionId' in owner ? ['execution', owner.executionId] : ['task', taskLifecycleKey(owner)])
  }
  private physicalTaskRead(taskId: string, snapshot?: FilesSnapshot, owner?: PhysicalControlOwner): Promise<PhysicalTaskControls> {
    const files = this.files as PhysicalLocalFiles
    const read = async (view: FilesSnapshot) => this.physicalTaskState(taskId, await files.readBytes(view, this.taskRecordPath(taskId)))
    // A business read waits only its original logical owner's accepted write.
    // The one-time whole Task discovery may join this file's last writer.
    return (this.writes.get(this.physicalTaskWriteKey(taskId, owner)) ?? Promise.resolve())
      .then(() => snapshot ? read(snapshot) : withSnapshot(files, read))
  }
  private oldLocalControlIssue(reason: unknown, taskId?: string): void {
    if (!this.reportOldLocalControl) return
    const detail = reason instanceof Error ? reason.message : String(reason)
    const key = this.key + '\0' + (taskId ?? '') + '\0' + detail
    let reported = reportedOldLocalControls.get(this.storage)
    if (!reported) reportedOldLocalControls.set(this.storage, reported = new Set())
    if (reported.has(key)) return
    reported.add(key)
    try { this.reportOldLocalControl(new LegacyLocalControlReadError('Original Host-local Task control could not be read for '
      + (taskId ?? 'the selected Local scope') + '; the retained original was not changed. Correct that retained record and restart the DSS Host to retry: ' + detail, { cause: reason }), taskId) }
    catch { /* Reporting cannot block unrelated Tasks. */ }
  }
  private clearOldLocalControlIssue(taskId?: string): void {
    const reported = reportedOldLocalControls.get(this.storage), prefix = this.key + '\0' + (taskId ?? '') + '\0'
    if (!reported || ![...reported].some(key => key.startsWith(prefix))) return
    try { this.oldLocalControlRecovered?.(taskId) }
    catch { return /* Display failure preserves the unresolved diagnostic for retry. */ }
    for (const key of reported) if (key.startsWith(prefix)) reported.delete(key)
  }
  private async oldLocalTaskHold(identity: { taskId: string; lifecycleId?: string }, task: () => Promise<TaskMetadata | undefined>): Promise<TaskControl | undefined> {
    if (!(this.files instanceof PhysicalLocalFiles) || taskLifecycle(identity) || !this.storage.readLegacyLocalControls) return
    let saved: unknown
    try { saved = await this.storage.readLegacyLocalControls(this.scope) }
    catch (error) { this.oldLocalControlIssue(error); return }
    if (saved === undefined) return
    if (!saved || typeof saved !== 'object' || Array.isArray(saved) || (saved as Controls).version !== 1
      || !(saved as Controls).tasks || typeof (saved as Controls).tasks !== 'object' || Array.isArray((saved as Controls).tasks)
      || !(saved as Controls).commands || typeof (saved as Controls).commands !== 'object' || Array.isArray((saved as Controls).commands)) {
      this.oldLocalControlIssue('Invalid original scoped control envelope.'); return
    }
    this.clearOldLocalControlIssue()
    const state = saved as Controls, candidate = state.tasks[hash(identity.taskId)]
    if (candidate === undefined) return
    if (!candidate || candidate.taskId !== identity.taskId || taskLifecycle(candidate)
      || !['running', 'paused', 'cancelled'].includes(candidate.intent)
      || typeof candidate.commandId !== 'string' || !candidate.commandId || typeof candidate.requestedAt !== 'string'
      || state.commands[hash(candidate.commandId)]?.signature !== JSON.stringify(['task', identity.taskId, candidate.intent])
      || JSON.stringify(state.commands[hash(candidate.commandId)]?.value) !== JSON.stringify(candidate)) {
      this.oldLocalControlIssue('The addressed original Task command does not match its saved identity.', identity.taskId); return
    }
    this.clearOldLocalControlIssue(identity.taskId)
    if (candidate.intent === 'running') return
    const current = await task()
    if (!current || current.taskId !== identity.taskId || taskLifecycle(current) || current.status !== 'running') return
    return { ...candidate, intent: 'paused' }
  }
  private physicalTaskUpdate<T>(taskId: string,
    decide: (state: PhysicalTaskControls) => Promise<{ value: T; write?: boolean }> | { value: T; write?: boolean },
    owners: readonly PhysicalControlOwner[] = []): Promise<T> {
    const files = this.files as PhysicalLocalFiles
    const operation = files.updateInExistingDirectory(this.taskRecordPath(taskId), async bytes => {
      const state = this.physicalTaskState(taskId, bytes), decision = await decide(state)
      return { value: decision.value, ...(decision.write ? { content: JSON.stringify(state) + '\n' } : {}) }
    }, undefined, true)
    // The existing file layer still serializes mutations. These transient
    // aliases only preserve original Task/execution/command read ownership;
    // neither business reads nor unrelated executions join the whole file.
    const keys = [this.physicalTaskWriteKey(taskId), ...owners.map(owner => this.physicalTaskWriteKey(taskId, owner))]
    const settled = operation.then(() => {}, () => {})
    for (const key of keys) this.writes.set(key, settled)
    void settled.then(() => { for (const key of keys) if (this.writes.get(key) === settled) this.writes.delete(key) })
    // Return the original operation's value or error, not its settled alias.
    return operation
  }
  private physicalTaskCommand<T extends TaskControl | ExecutionStopControl>(commandId: string, signature: string,
    target: { taskId: string; lifecycleId?: string; executionId?: string }, create: () => T, apply: (state: Controls, value: T) => void,
    beforeWrite?: () => Promise<void>, beforeAttempt?: () => void | Promise<void>): Promise<T> {
    return this.physicalTaskUpdate(target.taskId, async state => {
      const key = hash(commandId), recorded = state.commands[key]
      if (recorded) {
        if (recorded.signature !== signature) throw new Error('Control command identity has different arguments.')
        return { value: structuredClone(recorded.value as T) }
      }
      // Keep each entry's original validation: Service already selected its
      // Task, while Foreground supplies its existing write-time callback.
      await beforeWrite?.()
      // Execution stop uses the Runtime's already verified current owner. A
      // missing Task metadata file cannot revoke that native stop authority.
      await beforeAttempt?.()
      const value = create()
      apply(state, value)
      state.commands[key] = { signature, value }
      return { value: structuredClone(value), write: true }
    }, [target.executionId ? { executionId: target.executionId } : target, { commandId }])
  }
  /** One known Task's original pending requests, not a directory/index scan. */
  async pendingTaskStops(taskId: string): Promise<ExecutionStopControl[]> {
    if (!(this.files instanceof PhysicalLocalFiles)) throw new Error('Physical Task control discovery requires Local files.')
    return Object.values((await this.physicalTaskRead(taskId)).executions).filter(value => value.result === undefined)
  }
  private async load(snapshot?: FilesSnapshot): Promise<Controls> {
    const saved = snapshot && this.storage instanceof GitAuthorityStore
      ? await this.storage.getAt<Controls>(snapshot, this.key) : await this.storage.get<Controls>(this.key)
    return saved ? structuredClone(saved) : { version: 1, tasks: {}, executions: {}, commands: {} }
  }
  private previousControlFact(): { read?: Promise<Controls> } {
    let scopes = previousControls.get(this.storage)
    if (!scopes) previousControls.set(this.storage, scopes = new Map())
    let fact = scopes.get(this.key)
    if (!fact) scopes.set(this.key, fact = {})
    return fact
  }
  private loadPreviousControls(): Promise<Controls> {
    const fact = this.previousControlFact()
    if (!fact.read) {
      const read = this.storage.get<Controls>(this.key).then(saved => saved ? structuredClone(saved) : emptyControls())
      fact.read = read
      void read.catch(() => { if (fact.read === read) fact.read = undefined })
    }
    return fact.read
  }
  private serialKey<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.writes.get(key) ?? Promise.resolve()).then(operation)
    const settled = result.then(() => {}, () => {})
    this.writes.set(key, settled)
    void settled.then(() => { if (this.writes.get(key) === settled) this.writes.delete(key) })
    return result
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> { return this.serialKey(this.key, operation) }
  private localKey(owner: LocalOwner): string {
    return this.key + ('executionId' in owner ? '/executions/' + hash(owner.executionId) : '/tasks/' + hash(taskLifecycleKey(owner)))
  }
  private localCommandKey(commandId: string): string { return this.key + '/commands/' + hash(commandId) }
  private async localState(owner: LocalOwner): Promise<LocalControls> {
    const key = this.localKey(owner), saved = await this.storage.get<LocalControls>(key)
    if (saved) return structuredClone(saved)
    // The exact previous-format document remains readable. Import only the
    // addressed owner's rows on its first write; do not migrate/scan other Tasks.
    const legacy = await this.loadPreviousControls(), state: LocalControls = { ...emptyControls(), owner }
    const belongs = (value: TaskControl | ExecutionStopControl) => 'executionId' in owner
      ? 'executionId' in value && value.executionId === owner.executionId
      : !('executionId' in value) && value.taskId === owner.taskId && taskLifecycle(value) === taskLifecycle(owner)
    state.tasks = Object.fromEntries(Object.entries(legacy.tasks).filter(([, value]) => belongs(value)))
    state.executions = Object.fromEntries(Object.entries(legacy.executions).filter(([, value]) => belongs(value)))
    state.commands = Object.fromEntries(Object.entries(legacy.commands).filter(([, row]) => belongs(row.value)))
    return state
  }
  private localRead<T>(owner: LocalOwner, operation: (state: LocalControls) => Promise<T> | T): Promise<T> {
    return (this.writes.get(this.localKey(owner)) ?? Promise.resolve()).then(async () => operation(await this.localState(owner)))
  }
  private localCommand<T extends TaskControl | ExecutionStopControl>(commandId: string, signature: string, owner: LocalOwner,
    create: () => T, apply: (state: LocalControls, value: T) => void, current: (state: LocalControls) => T | undefined,
    beforeWrite?: () => Promise<void>, beforeAttempt?: () => void | Promise<void>): Promise<T> {
    const commandKey = this.localCommandKey(commandId), key = hash(commandId)
    return this.serialKey(commandKey, () => this.serialKey(this.localKey(owner), async () => {
      const state = await this.localState(owner)
      const recorded = state.commands[key]
      const claim = await this.storage.get<LocalCommand>(commandKey)
        ?? (await this.loadPreviousControls()).commands[key]
      if (claim && claim.signature !== signature || recorded && recorded.signature !== signature)
        throw new Error('Control command identity has different arguments.')
      if (recorded) return structuredClone(recorded.value as T)
      await beforeWrite?.(); await beforeAttempt?.()
      const selected: LocalCommand = claim ?? { signature, value: create(), ...(current(state) ? { predecessor: current(state)!.commandId } : {}) }
      if (!claim) await this.storage.set(commandKey, selected)
      // The command record may survive an interrupted Task write. A newer
      // command can proceed; replaying the older one must never overwrite it.
      if (current(state)?.commandId === selected.predecessor) apply(state, selected.value as T)
      state.commands[key] = { signature, value: selected.value }
      await beforeAttempt?.()
      await this.storage.set(this.localKey(owner), state)
      return structuredClone(selected.value as T)
    }))
  }
  private async localTaskStates(targets: readonly (string | { taskId: string; lifecycleId?: string })[], snapshot?: FilesSnapshot, observed?: (task: TaskMetadata) => void): Promise<ReadonlyMap<string, TaskControl | undefined>> {
    const read = async (view?: FilesSnapshot) => {
      const metadata = new Map<string, Promise<TaskMetadata | undefined>>()
      const controls = new Map<string, Promise<TaskControl | undefined>>()
      // Family callers already read these exact metadata in their owned view.
      // Share them, and all subsequent exact reads, for this evaluation only.
      for (const target of targets) if (typeof target !== 'string' && 'route' in target && 'status' in target)
        metadata.set(target.taskId, Promise.resolve(target as TaskMetadata))
      const task = (id: string) => {
        let promise = metadata.get(id)
        if (!promise) metadata.set(id, promise = this.files && view ? readJson<TaskMetadata>(this.files, view, paths.task(id)).then(task => { if (task) observed?.(task); return task }) : Promise.resolve(undefined))
        return promise
      }
      const control = (identity: { taskId: string; lifecycleId?: string }) => {
        const key = taskLifecycleKey(identity)
        let promise = controls.get(key)
        if (!promise) controls.set(key, promise = (this.files instanceof PhysicalLocalFiles
          ? this.physicalTaskRead(identity.taskId, view, identity).then(async state => state.tasks[hash(key)]
            ?? await this.oldLocalTaskHold(identity, () => task(identity.taskId)))
          : this.localRead(identity, state => state.tasks[hash(key)])).then(value => value?.intent === 'cancelled' ? { ...value, intent: 'paused' as const } : value))
        return promise
      }
      return new Map(await Promise.all(targets.map(async target => {
        const identity = typeof target === 'string' ? { taskId: target } : target
        let effective = await control(identity)
        if (effective?.intent === 'paused' || !this.files || !view) return [identity.taskId, effective] as const
        let child = await task(identity.taskId)
        if (!child || child.taskId !== identity.taskId || taskLifecycle(child) !== taskLifecycle(identity)) return [identity.taskId, effective] as const
        const visited = new Set([identity.taskId])
        while (child.parent) {
          const parent = await task(child.parent.taskId)
          if (!parent || parent.taskId !== child.parent.taskId || !linkedChild(parent, child)) break
          if (visited.has(parent.taskId)) throw new Error('Task parent association is cyclic: ' + parent.taskId)
          visited.add(parent.taskId)
          const inherited = await control(parent)
          if (inherited?.intent === 'paused') { effective = inherited; break }
          child = parent
        }
        return [identity.taskId, effective] as const
      })))
    }
    return snapshot || !this.files ? read(snapshot) : withSnapshot(this.files, read)
  }
  /** This is the original control command's completion fact, not another
   * publication receipt. Local resume may retire its temporary plan afterward. */
  async resumeHandled(commandId: string, target: { taskId: string; lifecycleId?: string }): Promise<boolean> {
    if (this.files instanceof PhysicalLocalFiles) {
      const command = (await this.physicalTaskRead(target.taskId, undefined, { commandId })).commands[hash(commandId)]
      if (!command) return false
      if (command.value.commandId !== commandId || command.value.taskId !== target.taskId || taskLifecycle(command.value) !== taskLifecycle(target)
        || !('intent' in command.value) || command.value.intent !== 'running') throw new Error('Resume command identity differs.')
      return command.resumeHandled === true
    }
    const key = this.localCommandKey(commandId)
    await this.writes.get(key)
    const command = await this.storage.get<LocalCommand>(key)
    if (!command) return false
    if (command.value.commandId !== commandId || command.value.taskId !== target.taskId || taskLifecycle(command.value) !== taskLifecycle(target)
      || !('intent' in command.value) || command.value.intent !== 'running') throw new Error('Resume command identity differs.')
    return command.resumeHandled === true
  }
  async finishResume(commandId: string, target: { taskId: string; lifecycleId?: string }): Promise<void> {
    if (this.files instanceof PhysicalLocalFiles) return this.physicalTaskUpdate(target.taskId, state => {
      const command = state.commands[hash(commandId)]
      if (!command || command.value.commandId !== commandId || command.value.taskId !== target.taskId || taskLifecycle(command.value) !== taskLifecycle(target)
        || !('intent' in command.value) || command.value.intent !== 'running') throw new Error('Resume command identity differs.')
      if (command.resumeHandled) return { value: undefined }
      command.resumeHandled = true
      return { value: undefined, write: true }
    }, [{ commandId }])
    const key = this.localCommandKey(commandId)
    await this.serialKey(key, async () => {
      let command = await this.storage.get<LocalCommand>(key)
      if (!command) {
        const record = (await this.localState(target)).commands[hash(commandId)]
        if (record) command = { ...record }
      }
      if (!command || command.value.commandId !== commandId || command.value.taskId !== target.taskId || taskLifecycle(command.value) !== taskLifecycle(target)
        || !('intent' in command.value) || command.value.intent !== 'running') throw new Error('Resume command identity differs.')
      if (!command.resumeHandled) await this.storage.set(key, { ...command, resumeHandled: true })
    })
  }

  /** Reads wait for writes accepted before the call, but never become a writer
   * barrier themselves. Fixed-view validation can run inside a mutation. */
  private readAfterWrites<T>(operation: () => Promise<T>, snapshot?: FilesSnapshot): Promise<T> {
    return snapshot ? operation() : (this.writes.get(this.key) ?? Promise.resolve()).then(operation)
  }
  /** The unchanged Git whole-document publication contract. Local callers use exact owners. */
  private mutate<T>(change: (state: Controls) => { result: T; write: boolean }, prepareGit?: () => void, owner?:string, fingerprint = '', allowEvolution = false, replayAfterConfirmed = true, beforeWrite?: (snapshot?: FilesSnapshot) => Promise<void>, beforeAttempt?: () => void | Promise<void>): Promise<T> {
    const authority = this.storage as GitAuthorityStore
    return this.serial(() => authority.updateOwned<Controls, T>(this.key, JSON.stringify([this.key,owner]), async (saved, snapshot) => {
      const state = saved ?? { version: 1, tasks: {}, executions: {}, commands: {} }
      const decision = change(state)
      if (decision.write) await beforeWrite?.(snapshot)
      return { ...decision, value: state }
    }, fingerprint, allowEvolution, replayAfterConfirmed, prepareGit, beforeAttempt))
  }

  private async assertNotReleased(target: { taskId?: string; lifecycleId?: string }, snapshot?: FilesSnapshot): Promise<void> {
    if (!target.taskId || !this.files || !this.releaseHostKey) return
    const read = async (view: FilesSnapshot) => taskArchiveHostFacts(await readTaskArchiveState(this.files!, view, target.taskId!), target, this.releaseHostKey!)
    const seal = snapshot ? await read(snapshot) : await withSnapshot(this.files, read)
    if (seal?.runtimeReleased) throw new Error('The selected Task runtime is already released.')
  }
  /** Use only for the authenticated user's explicit action. Caller checks scope. */
  setTask(commandId: string, taskId: string, intent: TaskControlIntent, lifecycleId = '', beforeWrite?: (snapshot?: FilesSnapshot) => Promise<void>, beforeAttempt?: () => void | Promise<void>, published?: (records: readonly TaskControl[], task?: TaskMetadata) => void, publicationTask?: () => TaskMetadata | undefined): Promise<TaskControl> {
    let publishedRecords: readonly TaskControl[] | undefined
    let publicationContext: { requestedAt: string; task?: TaskMetadata } | undefined
    let requestedAt: string | undefined
    const signature = JSON.stringify(['task', taskId, intent, ...(lifecycleId ? [lifecycleId] : [])])
    if (this.files instanceof PhysicalLocalFiles) return this.physicalTaskCommand(commandId, signature, { taskId, lifecycleId },
      () => ({ taskId, ...(lifecycleId ? { lifecycleId } : {}), intent, commandId, requestedAt: this.now() }),
      (state, value) => { state.tasks[hash(taskLifecycleKey(value))] = value },
      beforeWrite, beforeAttempt)
    if (!(this.storage instanceof GitAuthorityStore)) return this.localCommand(commandId, signature, { taskId, lifecycleId },
      () => ({ taskId, ...(lifecycleId ? { lifecycleId } : {}), intent, commandId, requestedAt: this.now() }),
      (state, value) => { state.tasks[hash(taskLifecycleKey(value))] = value }, state => state.tasks[hash(taskLifecycleKey({ taskId, lifecycleId }))],
      async () => { await this.assertNotReleased({ taskId, lifecycleId }); await beforeWrite?.() }, beforeAttempt)
    return this.mutate(state => {
      const key = hash(commandId)
      const old = state.commands[key]
      if (old) {
        if (old.signature !== signature) throw new Error('Control command identity has different arguments.')
        if (published) publishedRecords = structuredClone(Object.values(state.tasks))
        return { result: old.value as TaskControl, write: false }
      }
      const value: TaskControl = { taskId, ...(lifecycleId ? { lifecycleId } : {}), intent, commandId, requestedAt: requestedAt ??= this.now() }
      state.tasks[hash(taskLifecycleKey(value))] = value
      state.commands[key] = { signature, value }
      if (published) publishedRecords = structuredClone(Object.values(state.tasks))
      return { result: value, write: true }
    }, () => { publicationContext = (this.storage as GitAuthorityStore).ownedContext(JSON.stringify([this.key,'command:'+commandId]), () => ({ requestedAt: this.now() })); requestedAt = publicationContext.requestedAt }, 'command:'+commandId, signature, false, true, async snapshot => { await this.assertNotReleased({ taskId, lifecycleId }, snapshot); await beforeWrite?.(snapshot); if (publicationContext && publicationTask) publicationContext.task = publicationTask() }, beforeAttempt).then(value => {
      if (publishedRecords) published?.(publishedRecords, publicationContext?.task)
      return value
    })
  }
  /** Preserve an old reversible cancellation command on replay after the terminal-cancel upgrade. */
  priorTaskCommand(commandId: string, snapshot?: FilesSnapshot, target?: { taskId: string; lifecycleId?: string }): Promise<TaskControl | undefined> {
    if (this.files instanceof PhysicalLocalFiles) {
      if (!target) throw new Error('Local Task command reads require their original Task identity.')
      return this.physicalTaskRead(target.taskId, snapshot, { commandId }).then(state => {
        const record = state.commands[hash(commandId)]
        if (!record) return undefined
        if (!record.signature.startsWith('["task",') || record.value.taskId !== target.taskId || taskLifecycle(record.value) !== taskLifecycle(target))
          throw new Error('Control command identity has different arguments.')
        return structuredClone(record.value as TaskControl)
      })
    }
    if (!(this.storage instanceof GitAuthorityStore)) return (this.writes.get(this.localCommandKey(commandId)) ?? Promise.resolve()).then(async () => {
      const record = await this.storage.get<LocalCommand>(this.localCommandKey(commandId)) ?? (await this.loadPreviousControls()).commands[hash(commandId)]
      if (!record) return undefined
      if (!record.signature.startsWith('["task",')) throw new Error('Control command identity has different arguments.')
      return structuredClone(record.value as TaskControl)
    })
    return this.readAfterWrites(async () => {
      const record = (await this.load(snapshot)).commands[hash(commandId)]
      if (!record) return undefined
      if (!record.signature.startsWith('["task",')) throw new Error('Control command identity has different arguments.')
      return structuredClone(record.value as TaskControl)
    }, snapshot)
  }
  /** An ended Local owner needs no new stop row. Preserve the exact original
   * command's signature and incomplete claim instead of treating it as new. */
  async acknowledgeLocalReleasedExecutionStop(commandId: string, target: ExecutionStopRequest): Promise<void> {
    if (this.storage instanceof GitAuthorityStore) throw new Error('Released Local stop acknowledgement requires Local controls.')
    const commandKey = this.localCommandKey(commandId), key = hash(commandId)
    if (this.files instanceof PhysicalLocalFiles && target.taskId) {
      const recorded = (await this.physicalTaskRead(target.taskId, undefined, { commandId })).commands[key]
      const expected = JSON.stringify(['execution-stop', target.workId, target.executionId, target.taskId, ...(target.lifecycleId ? [target.lifecycleId] : [])])
      if (recorded && recorded.signature !== expected) throw new Error('Control command identity has different arguments.')
      return
    }
    const signature = JSON.stringify(['execution-stop', target.workId, target.executionId, target.taskId ?? null, ...(target.lifecycleId ? [target.lifecycleId] : [])])
    await this.writes.get(commandKey)
    const claim = () => this.storage.get<LocalCommand>(commandKey).then(value => value ?? this.loadPreviousControls().then(state => state.commands[key]))
    const check = (value: { signature: string } | undefined) => {
      if (value && value.signature !== signature) throw new Error('Control command identity has different arguments.')
    }
    const original = await claim()
    if (!original) return
    check(original)
    const recorded = await this.localRead({ executionId: target.executionId }, state => state.commands[key])
    check(recorded)
    if (recorded) return
    // Final release deletes claims before the owner. A claim observed before
    // that deletion must not become a false incomplete result after it.
    const retained = await claim()
    check(retained)
    if (retained) throw new Error('The original stop command remains incomplete: its claim has no accepted owner record.')
  }
  requestExecutionStop(commandId: string, target: ExecutionStopRequest): Promise<ExecutionStopControl> {
    let requestedAt: string | undefined
    const signature = JSON.stringify(['execution-stop', target.workId, target.executionId, target.taskId ?? null, ...(target.lifecycleId ? [target.lifecycleId] : [])])
    if (this.files instanceof PhysicalLocalFiles && target.taskId) return this.physicalTaskCommand(commandId, signature, target as ExecutionStopRequest & { taskId: string },
      () => ({ ...target, commandId, requestedAt: this.now() }),
      (state, value) => { state.executions[hash(target.executionId)] = value })
    if (!(this.storage instanceof GitAuthorityStore)) return this.localCommand(commandId, signature, { executionId: target.executionId },
      () => ({ ...target, commandId, requestedAt: this.now() }),
      (state, value) => { state.executions[hash(target.executionId)] = value }, state => state.executions[hash(target.executionId)],
      () => this.assertNotReleased(target))
    return this.mutate(state => {
      const key = hash(commandId)
      const old = state.commands[key]
      if (old) {
        if (old.signature !== signature) throw new Error('Control command identity has different arguments.')
        return { result: old.value as ExecutionStopControl, write: false }
      }
      const value: ExecutionStopControl = { ...target, commandId, requestedAt: requestedAt ??= this.now() }
      state.executions[hash(target.executionId)] = value
      state.commands[key] = { signature, value }
      return { result: value, write: true }
    }, () => { requestedAt = (this.storage as GitAuthorityStore).ownedContext(JSON.stringify([this.key,'command:'+commandId]), () => this.now()) }, 'command:'+commandId, signature, false, true, snapshot => this.assertNotReleased(target, snapshot))
  }
  /** Records the real native outcome; requesting a stop is never proof it stopped. */
  settleExecution(commandId: string, target: string | ExecutionStopRequest, result: ExecutionStopResult): Promise<ExecutionStopControl | undefined> {
    const executionId = typeof target === 'string' ? target : target.executionId
    if (this.files instanceof PhysicalLocalFiles && typeof target !== 'string' && target.taskId) return this.physicalTaskUpdate(target.taskId, state => {
      const current = state.executions[hash(executionId)]
      if (!current || current.commandId !== commandId) return { value: current }
      if (current.taskId !== target.taskId || taskLifecycle(current) !== taskLifecycle(target)) throw new Error('Stop result belongs to another Task lifecycle.')
      const value = { ...current, result: structuredClone(result) }
      state.executions[hash(executionId)] = value
      const receipt = state.commands[hash(commandId)]
      if (receipt) receipt.value = value
      return { value, write: true }
    }, [{ executionId }])
    if (!(this.storage instanceof GitAuthorityStore)) {
      const owner = { executionId }
      return this.serialKey(this.localKey(owner), async () => {
        const state = await this.localState(owner), key = hash(executionId), current = state.executions[key]
        if (!current || current.commandId !== commandId) return current
        const value = { ...current, result: structuredClone(result) }
        state.executions[key] = value
        const receipt = state.commands[hash(commandId)]
        if (receipt) receipt.value = value
        await this.storage.set(this.localKey(owner), state)
        return value
      })
    }
    return this.mutate(state => {
      const key = hash(executionId), current = state.executions[key]
      if (!current || current.commandId !== commandId) return { result: current, write: false }
      if (this.storage instanceof GitAuthorityStore && current.result?.state === 'stopped') return { result: current, write: false }
      const value: ExecutionStopControl = { ...current, result: structuredClone(result) }
      state.executions[key] = value
      const receipt = state.commands[hash(commandId)]
      if (receipt) receipt.value = value
      return { result: value, write: true }
    }, undefined, 'settle:'+JSON.stringify([commandId,executionId]), JSON.stringify(result), true)
  }
  private async effectiveTasks(state: Controls, targets: readonly (string | { taskId: string; lifecycleId?: string })[], snapshot?: FilesSnapshot, observed?: (task: TaskMetadata) => void): Promise<ReadonlyMap<string, TaskControl | undefined>> {
    const records = Object.values(state.tasks), held = new Set(records.filter(value => value.intent !== 'running').map(value => value.taskId))
    // Keep the original no-parent-read fast path; extracting the pure resolver
    // must not create a snapshot when no other Task can confer a pause.
    if (!this.files || !targets.some(target => held.size > (held.has(typeof target === 'string' ? target : target.taskId) ? 1 : 0)))
      return effectiveTaskStates(records, targets)
    const read = async (view: FilesSnapshot) => {
      const metadata = new Map<string, Promise<TaskMetadata | undefined>>()
      return effectiveTaskStates(Object.values(state.tasks), targets, id => {
        let value = metadata.get(id)
        if (!value) { value = readJson<TaskMetadata>(this.files!, view, paths.task(id)).then(task => { if (task) observed?.(task); return task }); metadata.set(id, value) }
        return value
      })
    }
    return snapshot ? read(snapshot) : withSnapshot(this.files, read)
  }
  task(taskId: string, lifecycleId = '', observed?: (task: TaskMetadata) => void): Promise<TaskControl | undefined> {
    if (!(this.storage instanceof GitAuthorityStore)) return this.localTaskStates([{ taskId, lifecycleId }], undefined, observed).then(states => states.get(taskId))
    return this.readAfterWrites(async () => (await this.effectiveTasks(await this.load(), [{ taskId, lifecycleId }], undefined, observed)).get(taskId))
  }
  /** One view reads controls from the same authoritative snapshot as its tasks. */
  taskStates(targets: readonly (string | { taskId: string; lifecycleId?: string })[], snapshot?: FilesSnapshot): Promise<ReadonlyMap<string, TaskControl | undefined>> {
    if (!(this.storage instanceof GitAuthorityStore)) return this.localTaskStates(targets, snapshot)
    return this.readAfterWrites(async () => this.effectiveTasks(await this.load(snapshot), targets, snapshot), snapshot)
  }
  execution(target: string | ExecutionStopRequest, snapshot?: FilesSnapshot): Promise<ExecutionStopControl | undefined> {
    const executionId = typeof target === 'string' ? target : target.executionId
    if (this.files instanceof PhysicalLocalFiles && typeof target !== 'string' && target.taskId) return this.physicalTaskRead(target.taskId, snapshot, { executionId }).then(state => {
      const current = state.executions[hash(executionId)]
      if (current && (current.taskId !== target.taskId || taskLifecycle(current) !== taskLifecycle(target))) throw new Error('Stop request belongs to another Task lifecycle.')
      return current
    })
    if (!(this.storage instanceof GitAuthorityStore)) return this.localRead({ executionId }, state => state.executions[hash(executionId)])
    return this.readAfterWrites(async () => (await this.load(snapshot)).executions[hash(executionId)], snapshot)
  }
  /** Only undispatched requests; unconfirmed results stay visible for diagnosis. */
  pendingStops(snapshot?: FilesSnapshot, observedTasks?: (tasks: readonly TaskControl[]) => void): Promise<ExecutionStopControl[]> {
    if (!(this.storage instanceof GitAuthorityStore)) return (async () => {
      const state = structuredClone(await this.loadPreviousControls())
      const [tasks, executions] = await Promise.all([
        observedTasks ? this.storage.list<LocalControls>(this.key + '/tasks/') : Promise.resolve([]),
        this.storage.list<LocalControls>(this.key + '/executions/')
      ])
      for (const { value } of tasks) {
        if ('executionId' in value.owner) continue
        delete state.tasks[hash(taskLifecycleKey(value.owner))]
        Object.assign(state.tasks, value.tasks)
      }
      for (const { value } of executions) {
        if (!('executionId' in value.owner)) continue
        delete state.executions[hash(value.owner.executionId)]
        Object.assign(state.executions, value.executions)
      }
      observedTasks?.(structuredClone(Object.values(state.tasks)))
      return Object.values(state.executions).filter(value => value.result === undefined && (!(this.files instanceof PhysicalLocalFiles) || !value.taskId))
    })()
    return this.readAfterWrites(async () => {
      const state = await this.load(snapshot)
      observedTasks?.(structuredClone(Object.values(state.tasks)))
      return Object.values(state.executions).filter(value => value.result === undefined)
    }, snapshot)
  }
  async taskHeld(taskId?: string, lifecycleId = '', observed?: (task: TaskMetadata) => void): Promise<boolean> {
    if (!taskId) return false
    const value = await this.task(taskId, lifecycleId, observed)
    return value?.intent === 'paused' || value?.intent === 'cancelled'
  }
  /** Git cleanup participates in the existing task seal's exact snapshot/CAS.
   * Call only when that snapshot does not already contain its terminal seal. */
  async releaseChangesAt(snapshot: FilesSnapshot, taskId: string, lifecycleId = ''): Promise<FileChange[]> {
    if (!(this.storage instanceof GitAuthorityStore)) throw new Error('Atomic task release requires Git authority.')
    const state = await this.load(snapshot)
    const before = JSON.stringify(state), taskKey = taskLifecycleKey({ taskId, lifecycleId })
    const plan = this.storage.ownedContext(JSON.stringify([this.key, 'sealed-release:' + taskKey]), () => ({
      task: structuredClone(state.tasks[hash(taskKey)]),
      commands: Object.fromEntries(Object.entries(state.commands).filter(([, row]) => row.value.taskId === taskId && (row.value.lifecycleId ?? '') === lifecycleId)),
      executions: Object.fromEntries(Object.entries(state.executions).filter(([, value]) => value.taskId === taskId && (value.lifecycleId ?? '') === lifecycleId).map(([key, value]) => [key, structuredClone(value)]))
    }))
    if (JSON.stringify(state.tasks[hash(taskKey)]) === JSON.stringify(plan.task)) delete state.tasks[hash(taskKey)]
    for (const [key, value] of Object.entries(plan.executions)) {
      const current = state.executions[key]
      if (current && current.commandId === value.commandId && current.workId === value.workId && current.executionId === value.executionId
        && current.taskId === value.taskId && current.lifecycleId === value.lifecycleId && current.requestedAt === value.requestedAt) delete state.executions[key]
    }
    for (const [key, value] of Object.entries(plan.commands)) if (JSON.stringify(state.commands[key]) === JSON.stringify(value)) delete state.commands[key]
    return JSON.stringify(state) === before ? [] : [this.storage.change(this.key, state)]
  }
  /** Local cleanup has no remote uncertain-commit replay. Git cleanup must be
   * atomic with the existing durable task seal, never a standalone mutation. */
  releaseTask(taskId: string, lifecycleId = '', executionIds: readonly string[] = []): Promise<void> {
    if (this.storage instanceof GitAuthorityStore) return Promise.reject(new Error('Git task controls must be released atomically with the task seal.'))
    // Physical Task controls retire with the original whole Task directory.
    // No SDK fallback/import or per-execution history cleanup belongs here.
    if (this.files instanceof PhysicalLocalFiles) return Promise.resolve()
    const owner = { taskId, lifecycleId }
    return (async () => {
      if (!this.storage.delete) throw new Error('Control storage does not support runtime retirement.')
      const legacy = await this.loadPreviousControls()
      const executions = new Set([...executionIds, ...Object.values(legacy.executions).filter(value => value.taskId === taskId && taskLifecycle(value) === lifecycleId).map(value => value.executionId)])
      // This one original file really is shared. Retire only its selected rows
      // before removing their new owner records, so no old intent can reappear.
      // Ordinary current-format controls never write or queue behind this file.
      await this.serial(async () => {
        const saved = await this.loadPreviousControls()
        if (!Object.keys(saved.tasks).length && !Object.keys(saved.executions).length && !Object.keys(saved.commands).length) return
        const state = structuredClone(saved), belongs = (value: TaskControl | ExecutionStopControl) => value.taskId === taskId && taskLifecycle(value) === lifecycleId
        for (const [key, value] of Object.entries(state.tasks)) if (belongs(value)) delete state.tasks[key]
        for (const [key, value] of Object.entries(state.executions)) if (belongs(value)) delete state.executions[key]
        for (const [key, row] of Object.entries(state.commands)) if (belongs(row.value)) delete state.commands[key]
        if (JSON.stringify(state) !== JSON.stringify(saved)) {
          const fact = this.previousControlFact()
          try {
            if (!Object.keys(state.tasks).length && !Object.keys(state.executions).length && !Object.keys(state.commands).length) await this.storage.delete!(this.key)
            else await this.storage.set(this.key, state)
            fact.read = Promise.resolve(state)
          } catch (error) { fact.read = undefined; throw error }
        }
      })
      await Promise.all([owner, ...[...executions].map(executionId => ({ executionId }))].map(target => this.serialKey(this.localKey(target), async () => {
        const state = await this.storage.get<LocalControls>(this.localKey(target))
        if (!state) return
        if ('executionId' in target && Object.values(state.executions).some(value => value.taskId !== taskId || taskLifecycle(value) !== lifecycleId)) return
        // Completed receipts retire with their exact owner. A command claim
        // whose owner write never completed is unresolved evidence, not a
        // completed receipt to guess away during cleanup.
        await Promise.all(Object.values(state.commands).map(row => this.storage.delete!(this.localCommandKey(row.value.commandId))))
        await this.storage.delete!(this.localKey(target))
      })))
    })()
  }
}

/** A missing read is not proof of a missing Task. Display consumers may omit that
 * result until existing discovery supplies the ancestor, without doing more I/O. */
export const unreadTaskMetadata = Symbol('unread task metadata')
export async function effectiveTaskStates(
  records: readonly TaskControl[],
  targets: readonly (string | { taskId: string; lifecycleId?: string })[],
  metadata?: (id: string) => Promise<TaskMetadata | undefined | typeof unreadTaskMetadata>,
): Promise<ReadonlyMap<string, TaskControl | undefined>> {
  return prepareTaskStates(records)(targets, metadata)
}

/** Index one already-read control document once; resolution remains I/O-free
 * unless the caller explicitly supplies its existing metadata reader. */
export function prepareTaskStates(records: readonly TaskControl[]) {
  const controls = new Map(records.map(value => [taskLifecycleKey(value), value.intent === 'cancelled' ? { ...value, intent: 'paused' as const } : value]))
  const held = new Set([...controls.values()].filter(value => value.intent !== 'running').map(value => value.taskId))
  return async (
    targets: readonly (string | { taskId: string; lifecycleId?: string })[],
    metadata?: (id: string) => Promise<TaskMetadata | undefined | typeof unreadTaskMetadata>,
  ): Promise<ReadonlyMap<string, TaskControl | undefined>> => {
    const selected = new Map(targets.map(target => {
      const task = typeof target === 'string' ? { taskId: target } : target
      return [task.taskId, task] as const
    }))
    const result = new Map([...selected].map(([id, task]) => [id, controls.get(taskLifecycleKey(task))]))
    const candidates = [...result.keys()].filter(id => held.size > (held.has(id) ? 1 : 0))
    if (!metadata || !candidates.length) return result
    await Promise.all(candidates.map(async id => {
      let child = await metadata(id), effective = result.get(id)
      if (child === unreadTaskMetadata) { result.delete(id); return }
      if (!child || child.taskId !== id || taskLifecycle(child) !== taskLifecycle(selected.get(id)!)) return
      const visited = new Set([id])
      while (child.parent) {
        const parentId = child.parent.taskId, parent = await metadata(parentId)
        if (parent === unreadTaskMetadata) { result.delete(id); return }
        if (!parent || parent.taskId !== parentId || !linkedChild(parent, child)) break
        if (visited.has(parentId)) throw new Error('Task parent association is cyclic: ' + parentId)
        visited.add(parentId)
        const inherited = controls.get(taskLifecycleKey(parent))
        // Running an intermediate package cannot release an ancestor's pause.
        if (inherited?.intent === 'paused' && effective?.intent !== 'paused') effective = inherited
        child = parent
      }
      result.set(id, effective)
    }))
    return result
  }
}
