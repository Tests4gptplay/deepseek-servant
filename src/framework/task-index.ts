import { isPhysicalWorkspaceReference, taskWorkspaceFolder } from './workspace-paths.js'
import type { TaskMetadata } from './task-files.js'
import { filePath, type FileEntry, type FilesSnapshot, type FilesStore } from './transactions.js'

type CachedTask = { version: string; value?: TaskMetadata }
const segment = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.includes('/')) return false
  try { filePath(value); return true } catch { return false }
}
const logicalPath = (value: unknown): value is string => {
  if (typeof value !== 'string') return false
  try { filePath(value); return true } catch { return false }
}
export function parseTaskMetadata(path: string, bytes: Uint8Array | undefined): TaskMetadata {
  if (bytes === undefined) throw new Error('Listed Task record is missing from its snapshot.')
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Task record must be an object.')
  const task = value as Partial<TaskMetadata>
  if (task.version !== 1 || !segment(task.taskId)
    || task.lifecycleId !== undefined && !segment(task.lifecycleId)
    || path !== 'tasks/' + task.taskId + '.json' || !['P', 'O'].includes(task.route ?? '')
    || !['running', 'complete', 'cancelled'].includes(task.status ?? '') || !segment(task.owner) || !logicalPath(task.sourcePath)
    || task.members !== undefined && (!Array.isArray(task.members) || !task.members.every(segment))
    || task.workspaceRootTaskId !== undefined && !segment(task.workspaceRootTaskId)
    || task.workspaceFolder !== undefined && (typeof task.workspaceFolder !== 'string'
      || task.workspaceFolder !== taskWorkspaceFolder(task.workspaceFolder.slice(0, -((task.workspaceRootTaskId ?? task.taskId).length + 1)), task.workspaceRootTaskId ?? task.taskId))
    || task.workspaceResults !== undefined && (!Array.isArray(task.workspaceResults) || !task.workspaceResults.every(path => {
      return isPhysicalWorkspaceReference(path) || logicalPath(path) // Keep old recorded text inert, without resolving it.
    }))
    || task.resultPaths !== undefined && (!Array.isArray(task.resultPaths) || !task.resultPaths.every(logicalPath))) {
    throw new Error('Invalid Task metadata or Task/file identity mismatch.')
  }
  return task as TaskMetadata
}

/** Directory metadata is the change detector. No global Task正文 watcher, timer,
 * online-member filter or stale-value fallback is introduced by this cache. */
export class FrameworkTaskIndex {
  private readonly cache = new Map<string, CachedTask>()
  private visible = '[]'
  constructor(private readonly files: FilesStore, private readonly error: (error: Error) => void,
    private readonly changed?: () => void) {}

  /** Reuse only bodies retained by the original index. No read or discovery. */
  observed(taskId: string): TaskMetadata | undefined { return this.cache.get('tasks/' + taskId + '.json')?.value }
  /** An existing Host listing invalidates stale startup bodies without loading
   * replacements. The original Task lane still owns each replacement read. */
  invalidate(entries: readonly FileEntry[]): void {
    const versions = new Map(entries.map(entry => [entry.path, entry.version]))
    for (const [path, cached] of this.cache) if (versions.get(path) !== cached.version) this.cache.delete(path)
  }
  async list(snapshot: FilesSnapshot, entries?: readonly FileEntry[], signal?: AbortSignal): Promise<TaskMetadata[]> {
    // Enumeration errors remain an actual storage error; never mistake them for
    // deletion of every Task. Only a successfully listed snapshot evicts entries.
    const listed = entries ?? await this.files.listDirectory(snapshot, 'tasks/', { nameSuffix: '.json' })
    const direct = listed.filter(entry => /^tasks\/[^/]+\.json$/.test(entry.path)).sort((a, b) => a.path.localeCompare(b.path))
    const present = new Set(direct.map(entry => entry.path))
    for (const path of this.cache.keys()) if (!present.has(path)) this.cache.delete(path)
    const result: TaskMetadata[] = [], visible: Array<[string, string]> = []
    await this.files.prefetch?.(snapshot, { signal, isolatePathErrors: true, files: direct.filter(entry => this.cache.get(entry.path)?.version !== entry.version).map(entry => entry.path) })
    for (const entry of direct) {
      let cached = this.cache.get(entry.path)
      if (cached?.version !== entry.version) {
        // A changed or unreadable record must never reuse its previous valid T.
        this.cache.delete(entry.path)
        let bytes: Uint8Array | undefined
        try { bytes = await this.files.readBytes(snapshot, entry.path) } catch (cause) {
          this.error(new Error('Cannot read Task ' + entry.path, { cause }))
          continue // IO/network failure is retried, even at the same blob version.
        }
        cached = { version: entry.version }
        try { cached.value = parseTaskMetadata(entry.path, bytes) } catch (cause) {
          // Exact malformed content is deterministic at this version. Keep only
          // its negative result, not any previously valid Task body.
          this.error(new Error('Invalid Task ' + entry.path, { cause }))
        }
        this.cache.set(entry.path, cached)
      }
      if (cached?.value) { result.push(structuredClone(cached.value)); visible.push([entry.path, entry.version]) }
    }
    const signature = JSON.stringify(visible)
    if (signature !== this.visible) { this.visible = signature; this.changed?.() }
    return result
  }
}
