import { PhysicalLocalFiles, PhysicalLocalPublicationRequiredError } from './physical-local-files.js'
import { readTaskHistoryIdentity } from './task-history.js'
import { retainPendingTaskCommandProofs } from './task-command-paths.js'
import { createHash } from 'node:crypto'
import { encodeJson, paths, readJson, taskLifecycle, type TaskMetadata } from './task-files.js'
import { GitFiles, FilesConflictError, withWriteOperation, withFileDependencies, filePath, type FileChange, type FilesSnapshot, type FilesStore } from './transactions.js'

export type TaskArchiveIdentity = Pick<TaskMetadata, 'taskId'> & Partial<Pick<TaskMetadata, 'sourcePath' | 'archiveFolder' | 'lifecycleId' | 'children' | 'parent' | 'route' | 'owner' | 'status' | 'resultPaths' | 'workspaceResults'>>
export interface TaskArchiveHostFacts {
  sealed?: true
  /** Existing runtime guard is durable before transient teardown finishes. */
  runtimeReleased?: true
  /** This Host completed its own teardown; a peer Host cannot set this fact. */
  released?: true
  resolvedSafetyFaultIds?: string[]
}
export interface TaskArchiveCleanup {
  phase: 'files-cleaned' | 'released'
  /** Legacy deletion inventory. Current Git writes discard it in their existing publication. */
  deletedPaths?: string[]
  /** Existing explicit local history-clear disposition, not ordinary Cleaner authority. */
  historyCleared?: true
}
export interface TaskArchiveLifecycle {
  hosts?: Record<string, TaskArchiveHostFacts>
  cleanup?: TaskArchiveCleanup
}
/** Existing mechanical facts: Git stores lifecycles in its current Task metadata;
 * Local retains its own state path. Recorder's long-term prose/catalog stay separate. */
export interface TaskArchiveState {
  version: 1
  taskId: string
  lifecycles: Record<string, TaskArchiveLifecycle>
}
export function taskArchiveHostKey(authorityRoot: string | undefined, scope: string, instanceUUID?: string): string {
  if (!authorityRoot && !instanceUUID) throw new Error('Local task state requires the actual Host instance UUID.')
  return JSON.stringify(authorityRoot ? [authorityRoot, scope] : ['local', scope, instanceUUID])
}
export const taskArchivePath = (task: TaskArchiveIdentity): string => paths.archive(task)
/** Read-only historical presentation. This is never a backend Task admission,
 * cleanup continuation, write destination, or old-runtime recovery route. */
export const taskArchiveReadPath = (task: TaskArchiveIdentity): string => task.archiveFolder ? paths.archive(task) : paths.archive(task.taskId)
export const taskArchiveStatePath = (task: TaskArchiveIdentity): string => taskArchivePath(task) + '/state.json'

export async function readTaskArchiveIdentity(files: FilesStore, snapshot: FilesSnapshot, task: TaskArchiveIdentity | string): Promise<TaskArchiveIdentity> {
  if (typeof task !== 'string') return task
  const metadata = await readJson<TaskMetadata>(files, snapshot, paths.task(task))
  if (metadata && metadata.taskId !== task) throw new Error('Task archive metadata identity differs: ' + task)
  if (metadata) return metadata
  const history = await readTaskHistoryIdentity(files, snapshot, task)
  if (!history) throw new Error('Task identity is missing; an archive location cannot be inferred from Task ID: ' + task)
  return history
}
/** A Task-ID runtime write never resolves through historical identity. An
 * already-owned cleanup may pass its exact captured identity explicitly. */
async function taskArchiveWriteIdentity(files: FilesStore, snapshot: FilesSnapshot, task: TaskArchiveIdentity | string): Promise<TaskArchiveIdentity> {
  if (typeof task !== 'string' && !(files instanceof GitFiles)) return task
  const id = typeof task === 'string' ? task : task.taskId
  const current = await readJson<TaskMetadata>(files, snapshot, paths.task(id))
  if (!current || current.taskId !== id) throw new Error('Current Task metadata is unavailable for runtime state: ' + id)
  return current
}
function validRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
export function taskMetadataRuntimeState(task: TaskMetadata): TaskArchiveState | undefined {
  if (task.runtimeState === undefined) return undefined
  if (!validRecord(task.runtimeState) || !validRecord(task.runtimeState.lifecycles)) throw new Error('Task runtime state format differs: ' + task.taskId)
  return { version: 1, taskId: task.taskId, lifecycles: task.runtimeState.lifecycles }
}
export async function readTaskArchiveState(files: FilesStore, snapshot: FilesSnapshot, task: TaskArchiveIdentity | string): Promise<TaskArchiveState | undefined> {
  if (files instanceof GitFiles) {
    const id = typeof task === 'string' ? task : task.taskId
    // Read this snapshot, not a caller's cached Task object. No archive fallback.
    const current = await readJson<TaskMetadata>(files, snapshot, paths.task(id))
    if (current && current.taskId !== id) throw new Error('Task runtime metadata identity differs: ' + id)
    return current ? taskMetadataRuntimeState(current) : undefined
  }
  const identity = await readTaskArchiveIdentity(files, snapshot, task)
  const state = await readJson<TaskArchiveState>(files, snapshot, taskArchiveStatePath(identity))
  if (!state) return undefined
  if (state.version !== 1 || state.taskId !== identity.taskId || !validRecord(state.lifecycles)) throw new Error('Task archive state identity or format differs: ' + identity.taskId)
  return state
}
export function taskArchiveLifecycle(state: TaskArchiveState | undefined, task: { lifecycleId?: string }): TaskArchiveLifecycle | undefined {
  const value = state?.lifecycles[taskLifecycle(task)]
  if (value !== undefined && !validRecord(value)) throw new Error('Selected Task archive lifecycle state is invalid.')
  return value
}
/** Validate only the operation's actual Host slot. A peer's unrelated malformed
 * row is preserved, not a new gate on this Host's stop/release responsibility. */
export function taskArchiveHostFacts(state: TaskArchiveState | undefined, task: { lifecycleId?: string }, hostKey: string): TaskArchiveHostFacts | undefined {
  const hosts = taskArchiveLifecycle(state, task)?.hosts
  if (hosts !== undefined && !validRecord(hosts)) throw new Error('Selected Task archive Host map is invalid.')
  const host = hosts?.[hostKey]
  if (host !== undefined && (!validRecord(host) || host.sealed !== undefined && host.sealed !== true
    || host.runtimeReleased !== undefined && host.runtimeReleased !== true || host.released !== undefined && host.released !== true
    || host.resolvedSafetyFaultIds !== undefined && (!Array.isArray(host.resolvedSafetyFaultIds) || host.resolvedSafetyFaultIds.some(id => typeof id !== 'string'))))
    throw new Error('Selected Task archive Host state is invalid.')
  return host
}
export function taskArchiveCleanup(state: TaskArchiveState | undefined, task: { lifecycleId?: string }): TaskArchiveCleanup | undefined {
  const cleanup = taskArchiveLifecycle(state, task)?.cleanup
  if (cleanup !== undefined && (!validRecord(cleanup) || !['files-cleaned', 'released'].includes(cleanup.phase as string)
    || cleanup.deletedPaths !== undefined && (!Array.isArray(cleanup.deletedPaths) || cleanup.deletedPaths.some(path => typeof path !== 'string'))
    || cleanup.historyCleared !== undefined && cleanup.historyCleared !== true)) throw new Error('Selected Task archive cleanup state is invalid.')
  return cleanup
}
/** Call inside the existing transaction's current snapshot. File dependencies
 * make peer Host updates conflict and reevaluate rather than overwrite peers. */
export async function planTaskArchiveState(files: FilesStore, snapshot: FilesSnapshot, task: TaskArchiveIdentity | string,
  update: (latest: TaskArchiveState) => TaskArchiveState): Promise<FileChange> {
  const identity = await taskArchiveWriteIdentity(files, snapshot, task)
  const current = (files instanceof GitFiles ? taskMetadataRuntimeState(identity as TaskMetadata) : await readTaskArchiveState(files, snapshot, identity))
    ?? { version: 1, taskId: identity.taskId, lifecycles: {} }
  const next = update(structuredClone(current))
  if (next.version !== 1 || next.taskId !== identity.taskId) throw new Error('A state update cannot change Task identity.')
  if (files instanceof GitFiles) {
    compactGitTaskArchiveCleanup(next, identity)
    return { path: paths.task(identity.taskId), content: encodeJson({ ...identity, runtimeState: { lifecycles: next.lifecycles } }) }
  }
  return { path: taskArchiveStatePath(identity), content: encodeJson(next) }
}
export async function planTaskArchiveHostFacts(files: FilesStore, snapshot: FilesSnapshot, task: TaskArchiveIdentity,
  hostKey: string, facts: TaskArchiveHostFacts): Promise<FileChange> {
  if (!hostKey) throw new Error('A task Host identity is required.')
  return planTaskArchiveState(files, snapshot, task, current => {
    const key = taskLifecycle(task), lifecycle = taskArchiveLifecycle(current, task) ?? {}, hosts = lifecycle.hosts ?? {}, own = taskArchiveHostFacts(current, task, hostKey) ?? {}
    const resolvedSafetyFaultIds = [...new Set([...(own.resolvedSafetyFaultIds ?? []), ...(facts.resolvedSafetyFaultIds ?? [])])].sort()
    current.lifecycles = { ...current.lifecycles, [key]: { ...lifecycle, hosts: { ...hosts, [hostKey]: { ...own,
      ...(facts.sealed ? { sealed: true as const } : {}), ...(facts.runtimeReleased ? { runtimeReleased: true as const } : {}), ...(facts.released ? { released: true as const } : {}),
      ...(resolvedSafetyFaultIds.length ? { resolvedSafetyFaultIds } : {}) } } } }
    return facts.released && !(files instanceof GitFiles) ? compactTaskArchiveCleanup(current, task) : current
  })
}
/** Reuse an already planned Git state write. The deletion fact remains; each
 * Host's released slot owns its teardown. Do not validate or preserve obsolete
 * inventories, and do not inspect other lifecycles or create a cleanup write. */
function compactGitTaskArchiveCleanup(state: TaskArchiveState, task: Pick<TaskArchiveIdentity, 'lifecycleId'>): void {
  const key = taskLifecycle(task), lifecycle = state.lifecycles[key], cleanup = lifecycle?.cleanup
  if (!cleanup || !['files-cleaned', 'released'].includes(cleanup.phase)) return
  const { deletedPaths: _deleted, ...fact } = cleanup
  state.lifecycles = { ...state.lifecycles, [key]: { ...lifecycle, cleanup: { ...fact, phase: 'files-cleaned' } } }
}
/** Compact only this lifecycle's completed cleanup inventory. Unsettled
 * command proofs belong to their original Host, not the first released Host. */
export function compactTaskArchiveCleanup(state: TaskArchiveState, task: Pick<TaskMetadata, 'taskId' | 'lifecycleId'>): TaskArchiveState {
  const key = taskLifecycle(task), lifecycle = taskArchiveLifecycle(state, task), cleanup = taskArchiveCleanup(state, task)
  if (!lifecycle || !cleanup || cleanup.phase !== 'released') return state
  const pending = retainPendingTaskCommandProofs(cleanup.deletedPaths ?? [], task, lifecycle.hosts)
  const { deletedPaths: _deleted, ...compact } = cleanup
  state.lifecycles = { ...state.lifecycles, [key]: { ...lifecycle, cleanup: { ...compact, ...(pending.length ? { deletedPaths: pending } : {}) } } }
  return state
}
export async function planTaskArchiveCleanup(files: FilesStore, snapshot: FilesSnapshot, task: TaskArchiveIdentity,
  cleanup: TaskArchiveCleanup): Promise<FileChange> {
  return planTaskArchiveState(files, snapshot, task, current => {
    const key = taskLifecycle(task), lifecycle = taskArchiveLifecycle(current, task) ?? {}, prior = taskArchiveCleanup(current, task)
    if (files instanceof GitFiles) {
      current.lifecycles = { ...current.lifecycles, [key]: { ...lifecycle, cleanup: { phase: 'files-cleaned',
        ...(prior?.historyCleared || cleanup.historyCleared ? { historyCleared: true as const } : {}) } } }
      return current
    }
    const released = prior?.phase === 'released' || cleanup.phase === 'released'
    const deletedPaths = [...new Set([...(prior?.deletedPaths ?? []), ...(cleanup.deletedPaths ?? [])])].sort()
    for (const path of deletedPaths) filePath(path)
    current.lifecycles = { ...current.lifecycles, [key]: { ...lifecycle, cleanup: { phase: released ? 'released' : 'files-cleaned',
      ...(deletedPaths.length ? { deletedPaths } : {}), ...(prior?.historyCleared || cleanup.historyCleared ? { historyCleared: true as const } : {}) } } }
    return compactTaskArchiveCleanup(current, task)
  })
}
/** Existing FilesStore compare-and-swap publication, without another journal or
 * receipt namespace. Only a proven conflict may reevaluate; UNKNOWN propagates. */
export async function updateTaskArchiveState<R>(files: FilesStore, task: TaskArchiveIdentity | string,
  evaluate: (snapshot: FilesSnapshot, task: TaskArchiveIdentity, state: TaskArchiveState) => Promise<{ state?: TaskArchiveState; metadata?: TaskMetadata; changes?: FileChange[]; result: R; write: boolean }> | { state?: TaskArchiveState; metadata?: TaskMetadata; changes?: FileChange[]; result: R; write: boolean },
  beforeAttempt?: () => void | Promise<void>): Promise<R> {
  if (files instanceof PhysicalLocalFiles) {
    const snapshot = await files.snapshot()
    try {
      const identity = await taskArchiveWriteIdentity(files, snapshot, task)
      return await files.updateAsync(taskArchiveStatePath(identity), async bytes => {
        await beforeAttempt?.()
        const current: TaskArchiveState = bytes === undefined ? { version: 1, taskId: identity.taskId, lifecycles: {} }
          : JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
        if (current.version !== 1 || current.taskId !== identity.taskId || !validRecord(current.lifecycles))
          throw new Error('Task archive state identity or format differs: ' + identity.taskId)
        const decision = await evaluate(snapshot, identity, structuredClone(current))
        if (!decision.write) return { value: decision.result }
        if (decision.changes?.length) throw new PhysicalLocalPublicationRequiredError('task state update with additional files')
        if (!decision.state || decision.state.version !== 1 || decision.state.taskId !== identity.taskId)
          throw new Error('A state update cannot change Task identity.')
        return { value: decision.result, ...(JSON.stringify(current) !== JSON.stringify(decision.state)
          ? { content: encodeJson(decision.state) } : {}) }
      })
    } finally { await snapshot.release() }
  }
  return withWriteOperation(files, async () => {
    let retrySnapshot: FilesSnapshot | undefined
    try { for (;;) {
      await beforeAttempt?.()
      const snapshot = retrySnapshot ?? await files.snapshot()
      retrySnapshot = undefined
      try {
        const identity = await taskArchiveWriteIdentity(files, snapshot, task)
        const current = (files instanceof GitFiles ? taskMetadataRuntimeState(identity as TaskMetadata) : await readTaskArchiveState(files, snapshot, identity))
          ?? { version: 1 as const, taskId: identity.taskId, lifecycles: {} }
        const decision = await withFileDependencies(files, snapshot, () => Promise.resolve(evaluate(snapshot, identity, structuredClone(current))))
        if (!decision.write) return decision.result
        if (!decision.state || decision.state.version !== 1 || decision.state.taskId !== identity.taskId) throw new Error('A state update cannot change Task identity.')
        if (JSON.stringify(current) === JSON.stringify(decision.state) && !decision.metadata && !decision.changes?.length) return decision.result
        if (files instanceof GitFiles) compactGitTaskArchiveCleanup(decision.state, identity)
        // The Host can release its workspace binding in this SAME Task write;
        // do not append a second stale metadata change over the new Host facts.
        const path = files instanceof GitFiles ? paths.task(identity.taskId) : taskArchiveStatePath(identity)
        const content = encodeJson(files instanceof GitFiles
          ? { ...(decision.metadata ?? identity), runtimeState: { lifecycles: decision.state.lifecycles } } : decision.state)
        const changes = [{ path, content }, ...(decision.changes ?? [])]
        try {
          await files.commit(snapshot, changes, 'DSS task state ' + createHash('sha256').update(JSON.stringify(changes)).digest('hex'), { beforeAttempt, reevaluateOnConflict: true })
          return decision.result
        } catch (error) {
          if (!(error instanceof FilesConflictError)) throw error
          if (files instanceof GitFiles) retrySnapshot = files.takeConflictSnapshot(error)
        }
      } finally { await snapshot.release() }
    } } finally { await retrySnapshot?.release() }
  })
}
