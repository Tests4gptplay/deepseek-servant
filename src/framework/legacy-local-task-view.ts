import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { StoragePort } from '../contracts/ports.js'
import type { FrameworkClientTask } from './client-contracts.js'
import { canonicalLocalLocation } from './local-location.js'
import { withLegacySqliteSnapshot, type LegacySqliteEntry } from './legacy-sqlite-reader.js'
import { readLocalUpgradeCompleted } from './local-upgrade-completion.js'
import { localTaskUpgradeKey } from './local-upgrade-task.js'
import { parseTaskMetadata } from './task-index.js'
import { taskArchiveReadPath, taskArchiveCleanup, type TaskArchiveState } from './task-archive.js'
import { paths, type TaskMetadata, type MemberStatus } from './task-files.js'

export interface PendingLocalTaskView {
  task: TaskMetadata
  members: FrameworkClientTask['members']
  historyCleared: boolean
}
const parse = <T>(bytes: Uint8Array): T => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as T
async function taskRestored(directory: string, storage: StoragePort, taskId: string): Promise<boolean> {
  const state = await storage.get<{ kind: string; directory: string; taskId: string; status: string; materialsRestored?: true }>(localTaskUpgradeKey(directory, taskId))
  return state?.kind === 'dss-once-task-layout' && state.directory === directory && state.taskId === taskId && (state.status === 'complete' || state.materialsRestored === true)
}
/** Read-only presentation of exact original v44 Task identities. Current
 * physical/history rows win. Each completed one-time Task retires its source
 * view, and verified full conversion bypasses SQL entirely. No read schedules
 * restoration, reopens a Task, scans unrelated rows or creates a SQL writer. */
export async function pendingLocalTaskViews(directory: string, storage: StoragePort, current: ReadonlySet<string>,
  error: (error: Error) => void, signal?: AbortSignal, selected?: readonly string[]): Promise<PendingLocalTaskView[]> {
  const root = await canonicalLocalLocation(directory, true)
  if (await readLocalUpgradeCompleted(root, storage)) return []
  const pendingSelected = selected === undefined ? undefined : (await Promise.all(selected.map(async id => await taskRestored(root, storage, id) ? undefined : id))).filter((id): id is string => id !== undefined)
  if (pendingSelected?.length === 0) return []
  const sourcePath = join(root, 'dss-files.sqlite')
  try { await lstat(sourcePath) } catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []; throw cause }
  return withLegacySqliteSnapshot(sourcePath, async source => {
    const result: PendingLocalTaskView[] = []
    const read = async <T>(path: string): Promise<T | undefined> => {
      const value = await source.read(path)
      if (value?.kind === 'issue') throw new Error(value.issue.message)
      return value === undefined ? undefined : parse<T>(value.bytes)
    }
    const entries = pendingSelected === undefined ? source.entries('tasks/') : (async function* () {
      for (const taskId of pendingSelected!) { const entry = await source.read(paths.task(taskId)); if (entry) yield entry }
    })() as AsyncIterable<LegacySqliteEntry>
    for await (const entry of entries) {
      signal?.throwIfAborted()
      if (entry.kind === 'issue') { error(new Error(entry.issue.message)); continue }
      if (!/^tasks\/[^/]+\.json$/.test(entry.path)) continue
      const taskId = entry.path.slice('tasks/'.length, -5)
      if (current.has(taskId)) continue
      try {
        if (pendingSelected === undefined && await taskRestored(root, storage, taskId)) continue
        const task = parseTaskMetadata(entry.path, entry.bytes)
        const archive = await read<TaskArchiveState>(taskArchiveReadPath(task) + '/state.json')
        if (archive && (archive.version !== 1 || archive.taskId !== taskId || !archive.lifecycles)) throw new Error('Original Task archive identity differs: ' + taskId)
        const cleanup = taskArchiveCleanup(archive, task)
        const members = await Promise.all((task.members ?? [task.owner]).map(async name => {
          const stored = await read<MemberStatus>(paths.memberStatus(taskId, name))
          return { name, status: task.status === 'complete' && task.route === 'P' && name === task.owner ? 'complete'
            : stored?.state ?? (cleanup && ['files-cleaned', 'released'].includes(cleanup.phase) ? 'cleared' : 'unknown') }
        }))
        result.push({ task, members, historyCleared: cleanup?.historyCleared === true })
      } catch (cause) { signal?.throwIfAborted(); error(new Error('Cannot read original Task ' + entry.path, { cause })) }
    }
    return result
  }, { signal })
}

/** The caller is the original Task result button, never a general SQL file
 * fallback. Validate its exact recorded membership before reading any body. */
export async function pendingLocalTaskResult(directory: string, storage: StoragePort, taskId: string, path: string,
  signal?: AbortSignal): Promise<Uint8Array | undefined> {
  const root = await canonicalLocalLocation(directory, true)
  if (await readLocalUpgradeCompleted(root, storage)) return undefined
  if (await taskRestored(root, storage, taskId)) return undefined
  return withLegacySqliteSnapshot(join(root, 'dss-files.sqlite'), async source => {
    const original = await source.read(paths.task(taskId))
    if (original?.kind === 'issue') throw new Error(original.issue.message)
    if (!original) return undefined
    const task = parseTaskMetadata(paths.task(taskId), original.bytes)
    if (!task.resultPaths?.includes(path)) throw new Error('This path is not a recorded result of the selected original Task.')
    const result = await source.read(path)
    if (result?.kind === 'issue') throw new Error(result.issue.message)
    return result?.bytes
  }, { signal })
}

/** Access-lifetime presentation, not a source mirror. Ordinary UI invalidations
 * reuse one result/in-flight read. Only explicit refresh or actual upgrade
 * progress invalidates it. Individual Task completion never rescans all Tasks. */
export class PendingLocalTaskViewCache {
  private rows?: Map<string, PendingLocalTaskView>
  private pending?: Promise<void>
  private failure?: unknown
  private viewRead?: Promise<void>
  private readonly viewers = new Set<AbortSignal | undefined>()
  private readonly dirty = new Set<string>()
  private generation = 0
  private retired = false
  private readonly controller = new AbortController()
  constructor(private readonly directory: string, private readonly storage: StoragePort, private readonly error: (error: Error) => void, private readonly changed?: () => void) {}
  invalidate(taskId?: string): void {
    if (this.retired) return
    this.failure = undefined
    if (taskId !== undefined) { this.rows?.delete(taskId); this.dirty.add(taskId) }
    else { this.generation++; this.rows = undefined; this.dirty.clear() }
  }
  private reportReadError(error: Error): void {
    if (!this.controller.signal.aborted && !this.retired && (!this.viewRead || [...this.viewers].some(viewer => !viewer?.aborted))) this.error(error)
  }
  /** A panel reads the already available projection. Its initial source read
   * belongs to this Access, not to the foreground view's completion. */
  view(signal?: AbortSignal): { rows: PendingLocalTaskView[]; status?: 'loading' | 'failed' } {
    if (this.retired || this.controller.signal.aborted) return { rows: [] }
    if (!this.viewRead && this.failure === undefined && (!this.rows || this.dirty.size)) {
      const work = this.read().then(() => {}, error => {
        this.reportReadError(error instanceof Error ? error : new Error(String(error)))
      }).finally(() => {
        if (this.viewRead !== work) return
        this.viewRead = undefined
        const interested = [...this.viewers].some(viewer => !viewer?.aborted)
        this.viewers.clear()
        if (interested && !this.controller.signal.aborted && !this.retired) this.changed?.()
      })
      this.viewRead = work
      void work.catch(() => {})
    }
    if (this.viewRead && !signal?.aborted) this.viewers.add(signal)
    return { rows: [...this.rows?.values() ?? []], ...(this.viewRead ? { status: 'loading' as const }
      : this.failure !== undefined ? { status: 'failed' as const } : {}) }
  }
  read(): Promise<PendingLocalTaskView[]> {
    if (this.controller.signal.aborted) return Promise.reject(this.controller.signal.reason)
    if (this.retired) return Promise.resolve([])
    if (this.failure !== undefined) return Promise.reject(this.failure)
    if (this.pending) return this.pending.then(() => this.read())
    if (this.rows && !this.dirty.size) return Promise.resolve([...this.rows.values()])
    const selected = this.rows ? [...this.dirty] : undefined, generation = this.generation
    this.dirty.clear()
    const work = pendingLocalTaskViews(this.directory, this.storage, new Set(), error => this.reportReadError(error), this.controller.signal, selected).then(rows => {
      if (generation !== this.generation) return
      if (!selected) this.rows = new Map()
      else for (const id of selected) this.rows!.delete(id)
      for (const row of rows) this.rows!.set(row.task.taskId, row)
    }, error => { if (generation === this.generation) { this.failure = error; throw error } })
    this.pending = work
    void work.finally(() => { if (this.pending === work) this.pending = undefined }).catch(() => {})
    return work.then(() => this.read())
  }
  retire(): void {
    this.retired = true; this.generation++; this.rows = undefined; this.failure = undefined; this.dirty.clear(); this.viewers.clear()
  }
  async close(): Promise<void> {
    this.controller.abort(new Error('The original Task view access was closed.'))
    await Promise.allSettled([this.pending, this.viewRead])
    this.rows = undefined; this.dirty.clear(); this.viewers.clear()
  }
}
