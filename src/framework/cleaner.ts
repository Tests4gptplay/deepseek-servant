import { planTaskArchiveCleanup, readTaskArchiveState, taskArchiveCleanup } from './task-archive.js'
import { PhysicalLocalFiles } from './physical-local-files.js'
import { taskFamily } from './task-relations.js'
import { FrameworkTransactions } from './command-transactions.js'
import { filePath, FilesOutcomeUnknownError, withWriteOperation, type FileChange, type FilesSnapshot, type FilesStore } from './transactions.js'
import { paths, readJson, taskIdentity, taskLifecycle, taskLifecycleKey, taskWorkingRoots, type TaskMetadata } from './task-files.js'

export interface CleanupRecord {
  version: 1
  taskId: string
  lifecycleId?: string
  phase: 'files-cleaned' | 'released'
  deletedPaths: string[]
}
export type CleanupResult = { status: 'not-requested' } | { status: 'awaiting-observation' } | { status: 'released' | 'deleted'; record: CleanupRecord }
/** One lifecycle's derived view of the sole program state, not another record. */
export async function readTaskCleanupRecord(files: FilesStore, snapshot: FilesSnapshot, selected: TaskMetadata | string): Promise<CleanupRecord & { historyCleared?: true } | undefined> {
  const task = typeof selected === 'string' ? await readJson<TaskMetadata>(files, snapshot, paths.task(selected)) : selected
  if (!task) return undefined
  if (typeof selected === 'string' && task.taskId !== selected) throw new Error('Task cleanup metadata identity differs: ' + selected)
  const cleanup = taskArchiveCleanup(await readTaskArchiveState(files, snapshot, task), task)
  if (!cleanup) return undefined
  return { version: 1, taskId: task.taskId, ...(task.lifecycleId ? { lifecycleId: task.lifecycleId } : {}),
    phase: cleanup.phase, deletedPaths: cleanup.deletedPaths ?? [], ...(cleanup.historyCleared ? { historyCleared: true as const } : {}) }
}
export const readCleanupRecord = readTaskCleanupRecord
const assertCleanupLifecycle = (task: { lifecycleId?: string }, value: { lifecycleId?: string }): void => {
  if (taskLifecycle(task) !== taskLifecycle(value)) throw new Error('Task lifecycle changed; the prior Cleaner cannot modify this Task round.')
}
interface CleanupPublication { id: string; request: unknown; changes: readonly FileChange[]; record: CleanupRecord }
const unknownPublication = (error: unknown): boolean => error instanceof FilesOutcomeUnknownError
/** One Task lane's existing Host poll. It owns the snapshot until clean returns;
 * paths and content dependencies belong to that same immutable observation. */
export interface CleanupObservation {
  snapshot: FilesSnapshot
  startedAt: number
  task: TaskMetadata
  /** The already-known reciprocal total task tree, never a whole-store scan. */
  family?: TaskMetadata[]
  status: 'not-requested' | 'delete' | 'files-cleaned'
  record?: CleanupRecord
  publication?: CleanupPublication
  error?: unknown
}
/** Called by Host discovery, never by Cleaner. The fixed Task working roots
 * use the trees/snapshot already owned by this poll. Recorder's archive and
 * skills are outside this cleanup plan and are never inspected here. */
export async function observeCleanup(files: FilesStore, snapshot: FilesSnapshot, task: TaskMetadata, startedAt: number, allowPlanning = true): Promise<CleanupObservation> {
  const observed: CleanupObservation = { snapshot, startedAt, task, status: 'not-requested' }
  try {
    if (task.parent) return observed
    const cleaner = paths.state(task.owner, task.taskId) + '/Cleaner'
    if (files instanceof PhysicalLocalFiles) {
      // The Host accepts this original notice and remembers the known family
      // before removing its containing directory. No archive proof, terminal
      // predicate, file inventory or second poll grants this work.
      if (!allowPlanning || await files.read(snapshot, cleaner) === undefined) return observed
      observed.family = await taskFamily(files, snapshot, task.taskId)
      observed.task = observed.family[0] ?? task
      observed.status = 'delete'
      return observed
    }
    const recordPath = paths.task(task.taskId)
    await files.prefetch?.(snapshot, { files: [recordPath, ...(allowPlanning ? [cleaner] : [])] })
    const saved = await readCleanupRecord(files, snapshot, task)
    // Only committed deletion facts support continuation without a new signal.
    // Everything else leaves the existing Recorder signal as the sole trigger.
    const record = saved && ['files-cleaned', 'released'].includes(saved.phase) ? saved as CleanupRecord : undefined
    if (!record && (!allowPlanning || await files.read(snapshot, cleaner) === undefined)) return observed
    const current = await readJson<TaskMetadata>(files, snapshot, paths.task(task.taskId))
    if (!current || current.taskId !== task.taskId || current.owner !== task.owner) throw new Error('Cleanup target must match the notified Task and its principal.')
    assertCleanupLifecycle(task, current); observed.task = current
    const family = await taskFamily(files, snapshot, current.taskId)
    observed.family = family.length ? family : [current]
    if (record) {
      assertCleanupLifecycle(current, record)
      if (record.version !== 1) throw new Error('Cleanup state is invalid.')
      if (record.taskId !== task.taskId) throw new Error('Cleanup state belongs to another Task.')
      // Older released records are deletion evidence, never a substitute for
      // this Host's own association release.
      observed.record = record; observed.status = 'files-cleaned'
    }
    if (record) return observed
    // Recorder's exact Task tree owns these directory entries. Removing a tree
    // entry rebuilds only ancestors; there is no descendant file inventory.
    const roots = [...new Set(observed.family.flatMap(taskWorkingRoots))]
    const changes: FileChange[] = roots.map(path => ({ path, content: null, deleteTree: true }))
    // Shared request files are outside those directories and may be reused by
    // another Task. Keep only the existing identity check for that exact file.
    for (const member of observed.family) if (/^tasks\/[^/]+_(P|O)\.md$/.test(member.sourcePath)) {
      const source = await files.read(snapshot, filePath(member.sourcePath))
      if (source !== undefined && taskIdentity(source) === member.taskId) changes.push({ path: member.sourcePath, content: null })
    }
    const cleanup: CleanupRecord = { version: 1, taskId: task.taskId, phase: 'files-cleaned',
      ...(task.lifecycleId ? { lifecycleId: task.lifecycleId } : {}), deletedPaths: roots }
    // This is the existing Task command retirement fact, in the same commit as
    // deletion. It is not a Cleaner role state or a saved file-by-file inventory.
    const facts = await Promise.all(observed.family.map(member =>
      planTaskArchiveCleanup(files, snapshot, member, { phase: 'files-cleaned' })))
    observed.status = 'delete'; observed.record = cleanup
    observed.publication = { id: 'cleanup:' + taskLifecycleKey(current) + ':files:' + snapshot.revision,
      request: { taskId: task.taskId, owner: task.owner }, changes: [...changes, ...facts], record: cleanup }
  } catch (error) { observed.error = error }
  return observed
}

/** Remove only the exact Task directories selected by Recorder's notice.
 * Host resources retire separately; Cleaner does not run a role state machine. */
export class FrameworkCleaner {
  private closed = false
  private readonly pending = new Map<string, CleanupPublication>()
  constructor(readonly files: FilesStore, readonly transactions: FrameworkTransactions) {}
  close(): void { this.closed = true; this.pending.clear() }
  clean(task: TaskMetadata, observation: CleanupObservation): Promise<CleanupResult> {
    if (this.closed) return Promise.resolve({ status: 'awaiting-observation' })
    if (this.files instanceof PhysicalLocalFiles) return this.cleanPhysical(this.files, task, observation)
    return withWriteOperation(this.files, () => this.cleanInChannel(task, observation))
  }
  private async cleanPhysical(files: PhysicalLocalFiles, task: TaskMetadata, observation: CleanupObservation): Promise<CleanupResult> {
    if (observation.error) throw observation.error
    if (task.parent || observation.status === 'not-requested') return { status: 'not-requested' }
    const family = observation.family ?? [observation.task]
    const record: CleanupRecord = { version: 1, taskId: task.taskId, lifecycleId: task.lifecycleId,
      phase: 'files-cleaned', deletedPaths: [] }
    const running = () => { if (this.closed) throw new Error('Task directory cleanup was interrupted.') }
    const removeWorkingDirectories = async () => {
      for (const member of family) for (const root of taskWorkingRoots(member)) {
        running()
        await files.removeDirectory(root, root === paths.run(member.taskId))
      }
    }
    running()
    // The fixed Cleaner only removes the directories named by Recorder's
    // request. Host resource retirement runs separately from this operation.
    await removeWorkingDirectories()
    for (const member of family) {
      running()
      // Only this shared source file needs its current Task identity; it is
      // outside the selected whole Task directories.
      if (/^tasks\/[^/]+_(P|O)\.md$/.test(member.sourcePath)) await files.update(member.sourcePath, bytes => {
        const own = bytes !== undefined && taskIdentity(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) === member.taskId
        return { value: undefined, ...(own ? { content: null } : {}) }
      })
      record.deletedPaths.push(...taskWorkingRoots(member))
    }
    return { status: 'released', record: { ...record, phase: 'released' } }
  }
  private async cleanInChannel(task: TaskMetadata, observation: CleanupObservation): Promise<CleanupResult> {
    const key = taskLifecycleKey(task), snapshot = observation.snapshot
    assertCleanupLifecycle(task, observation.task)
    const pending = this.pending.get(key), publication = pending ?? observation.publication
    if (publication) {
      if (!pending && observation.error) throw observation.error
      // Only an unresolved original Git publication remains owned here. A new
      // poll does not turn its result into success or change its deletion input.
      this.pending.set(key, publication)
      try {
        await this.transactions.runObservedFinalization(publication.id, publication.request, snapshot,
          async () => publication.changes, async checked => {
            if (checked === observation.snapshot) return observation.status === 'files-cleaned'
            const saved = await readTaskCleanupRecord(this.files, checked, task)
            return !!saved && taskLifecycle(saved) === taskLifecycle(task)
          })
        this.pending.delete(key)
      } catch (error) {
        // Ordinary pre-push failure can leave the original native attempt
        // owned. Keep its exact publication connected across the next poll;
        // only an already-released attempt permits a newly observed plan.
        if (!unknownPublication(error) && !this.transactions.ownsGitAttempt(publication.id)) this.pending.delete(key)
        throw error
      }
      // The actual commit acknowledgement (or original-operation resolution)
      // already confirms deletion. Do not wait for inventory or another poll.
      return { status: 'deleted', record: publication.record }
    }
    if (observation.error) throw observation.error
    if (observation.status === 'not-requested') return { status: 'not-requested' }
    return { status: 'deleted', record: observation.record! }
  }
}
