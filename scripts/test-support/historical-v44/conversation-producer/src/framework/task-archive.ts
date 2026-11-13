import { retainPendingTaskCommandProofs } from './task-command-paths.js'
import { createHash } from 'node:crypto'
import { encodeJson, paths, readJson, taskLifecycle, type TaskMetadata } from './task-files.js'
import { GitFiles, FilesConflictError, withWriteOperation, withFileDependencies, filePath, type FileChange, type FilesSnapshot, type FilesStore } from './transactions.js'

export type TaskArchiveIdentity = Pick<TaskMetadata, 'taskId'> & Partial<Pick<TaskMetadata, 'sourcePath' | 'archiveFolder' | 'lifecycleId' | 'children'>>
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
  /** Temporary deletion inventory; after cleanup only unsettled original-Host command proofs remain. */
  deletedPaths?: string[]
  /** Existing explicit local history-clear disposition, not ordinary Cleaner authority. */
  historyCleared?: true
}
export interface TaskArchiveLifecycle {
  hosts?: Record<string, TaskArchiveHostFacts>
  cleanup?: TaskArchiveCleanup
}
/** Mechanical state only. Recorder's independently owned retention catalog and
 * AI-authored records.md are never read, parsed or rewritten by this helper. */
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
  if (!metadata) throw new Error('Task metadata is missing; an archive location cannot be inferred from Task ID: ' + task)
  return metadata
}
function validRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
export async function readTaskArchiveState(files: FilesStore, snapshot: FilesSnapshot, task: TaskArchiveIdentity | string): Promise<TaskArchiveState | undefined> {
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
  const identity = await readTaskArchiveIdentity(files, snapshot, task)
  const current = await readTaskArchiveState(files, snapshot, identity) ?? { version: 1, taskId: identity.taskId, lifecycles: {} }
  const next = update(structuredClone(current))
  if (next.version !== 1 || next.taskId !== identity.taskId) throw new Error('A state update cannot change Task identity.')
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
    return facts.released ? compactTaskArchiveCleanup(current, task) : current
  })
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
  evaluate: (snapshot: FilesSnapshot, task: TaskArchiveIdentity, state: TaskArchiveState) => Promise<{ state?: TaskArchiveState; changes?: FileChange[]; result: R; write: boolean }> | { state?: TaskArchiveState; changes?: FileChange[]; result: R; write: boolean },
  beforeAttempt?: () => void | Promise<void>): Promise<R> {
  return withWriteOperation(files, async () => {
    let retrySnapshot: FilesSnapshot | undefined
    try { for (;;) {
      await beforeAttempt?.()
      const snapshot = retrySnapshot ?? await files.snapshot()
      retrySnapshot = undefined
      try {
        const identity = await readTaskArchiveIdentity(files, snapshot, task)
        const current = await readTaskArchiveState(files, snapshot, identity) ?? { version: 1 as const, taskId: identity.taskId, lifecycles: {} }
        const decision = await withFileDependencies(files, snapshot, () => Promise.resolve(evaluate(snapshot, identity, structuredClone(current))))
        if (!decision.write) return decision.result
        if (!decision.state || decision.state.version !== 1 || decision.state.taskId !== identity.taskId) throw new Error('A state update cannot change Task identity.')
        const path = taskArchiveStatePath(identity), content = encodeJson(decision.state)
        const changes = [{ path, content }, ...(decision.changes ?? [])]
        if (JSON.stringify(current) === JSON.stringify(decision.state) && !decision.changes?.length) return decision.result
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
