import { encodeJson, paths, readJson, type TaskMetadata } from './task-files.js'
import { filePath, type FileChange, type FilesSnapshot, type FilesStore } from './transactions.js'
import { isPhysicalWorkspaceReference, taskWorkspaceFolder } from './workspace-paths.js'

/** Recorder-owned historical facts. This is deliberately not runnable Task
 * metadata: members, role state, controls and cleanup responsibility never live
 * here. The original source supplies the same title the existing UI displayed. */
export interface TaskHistoryIdentity extends Pick<TaskMetadata, 'taskId' | 'route' | 'sourcePath' | 'owner' | 'status'
  | 'lifecycleId' | 'parent' | 'children' | 'resultPaths' | 'workspaceResults' | 'workspaceRootTaskId' | 'workspaceFolder'> {
  version: 1
  kind: 'task-history'
  archiveFolder: string
  /** Explicit user history removal still preserves delivered artifact links. */
  historyCleared?: true
}
/** Exact Task-ID lookup, inside the existing archive category. It does not
 * flatten the actual nested archive directories or create another setting. */
export const taskHistoryPath = (taskId: string): string => 'archives/task-identities/' + paths.task(taskId).slice('tasks/'.length)

const segment = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.includes('/')) return false
  try { filePath(value); return true } catch { return false }
}
function parseHistory(value: unknown, taskId: string): TaskHistoryIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid archived Task identity: ' + taskId)
  const task = value as TaskHistoryIdentity
  if (task.version !== 1 || task.kind !== 'task-history' || task.taskId !== taskId || !segment(task.taskId)
    || !['P', 'O'].includes(task.route) || !['running', 'complete', 'cancelled'].includes(task.status)
    || !segment(task.owner) || typeof task.sourcePath !== 'string' || typeof task.archiveFolder !== 'string'
    || task.lifecycleId !== undefined && !segment(task.lifecycleId)
    || task.workspaceRootTaskId !== undefined && !segment(task.workspaceRootTaskId)
    || task.workspaceFolder !== undefined && typeof task.workspaceFolder !== 'string'
    || task.parent !== undefined && (!segment(task.parent.taskId) || !segment(task.parent.owner) || !segment(task.parent.objectiveId))
    || task.children !== undefined && (!Array.isArray(task.children) || task.children.some(child => !segment(child.taskId) || !segment(child.member) || !segment(child.objectiveId)))
    || task.resultPaths !== undefined && (!Array.isArray(task.resultPaths) || task.resultPaths.some(path => typeof path !== 'string'))
    || task.workspaceResults !== undefined && (!Array.isArray(task.workspaceResults) || task.workspaceResults.some(path => !isPhysicalWorkspaceReference(path) && typeof path !== 'string'))
    || task.historyCleared !== undefined && task.historyCleared !== true) throw new Error('Invalid archived Task identity: ' + taskId)
  filePath(task.sourcePath); paths.archive(task)
  if (task.workspaceFolder !== undefined) {
    const root = task.workspaceRootTaskId ?? task.taskId
    if (task.workspaceFolder !== taskWorkspaceFolder(task.workspaceFolder.slice(0, -(root.length + 1)), root))
      throw new Error('Invalid archived Task workspace identity: ' + taskId)
  }
  for (const path of task.resultPaths ?? []) filePath(path)
  for (const path of task.workspaceResults ?? []) if (typeof path === 'string') filePath(path)
  return task
}
export async function readTaskHistoryIdentity(files: FilesStore, snapshot: FilesSnapshot, taskId: string): Promise<TaskHistoryIdentity | undefined> {
  const value = await readJson<unknown>(files, snapshot, taskHistoryPath(taskId))
  return value === undefined ? undefined : parseHistory(value, taskId)
}
/** User-visible references only. Host/task admission must keep reading current
 * tasks/<id>.json and must never use archived facts to restart an execution. */
export async function readTaskReferenceIdentity(files: FilesStore, snapshot: FilesSnapshot, taskId: string): Promise<TaskMetadata | TaskHistoryIdentity | undefined> {
  const current = await readJson<TaskMetadata>(files, snapshot, paths.task(taskId))
  if (current && current.taskId !== taskId) throw new Error('Task reference identity differs: ' + taskId)
  return current ?? readTaskHistoryIdentity(files, snapshot, taskId)
}
type CachedHistory = { version: string; value: TaskHistoryIdentity }
/** Access-owned body reuse only. Every view still enumerates the existing
 * directory; versions come from its physical metadata or immutable Git blobs. */
export class FrameworkTaskHistoryCache {
  private cache = new Map<string, CachedHistory>()
  private reading = 0
  constructor(private readonly files: FilesStore) {}

  async list(snapshot: FilesSnapshot, error: (error: Error) => void, signal?: AbortSignal): Promise<TaskHistoryIdentity[]> {
    signal?.throwIfAborted()
    const reading = ++this.reading
    // A failed enumeration cannot be treated as deletion. Each concurrent view
    // owns its result and replacement cache, never another view's mutable map.
    const entries = await this.files.listDirectory(snapshot, 'archives/task-identities/', { nameSuffix: '.json' })
    const previous = this.cache, next = new Map<string, CachedHistory>(), result: TaskHistoryIdentity[] = []
    for (const entry of entries) {
      signal?.throwIfAborted()
      if (!/^archives\/task-identities\/[^/]+\.json$/.test(entry.path)) continue
      let cached = previous.get(entry.path)
      if (cached?.version !== entry.version) {
        cached = undefined
        try {
          const task = await readTaskHistoryIdentity(this.files, snapshot, entry.path.slice('archives/task-identities/'.length, -5))
          if (task) cached = { version: entry.version, value: task }
        } catch (cause) { error(new Error('Cannot read archived Task ' + entry.path, { cause })) }
      }
      if (cached) { next.set(entry.path, cached); result.push(structuredClone(cached.value)) }
    }
    signal?.throwIfAborted()
    // Exact removals and failed reads disappear only after successful discovery.
    // Errors are retried even at the same version; no previous body is a fallback.
    // An older overlapping read may return its own view but cannot replace a
    // newer request's cache. This does not queue or delay either view.
    if (reading === this.reading) this.cache = next
    return result
  }
}
export async function listTaskHistory(files: FilesStore, snapshot: FilesSnapshot,
  error: (error: Error) => void, signal?: AbortSignal): Promise<TaskHistoryIdentity[]> {
  return new FrameworkTaskHistoryCache(files).list(snapshot, error, signal)
}
export function taskHistoryChange(task: TaskMetadata, resultPaths = task.resultPaths): FileChange {
  // Explicit projection: do not turn this into a spread of runtime metadata.
  const history: TaskHistoryIdentity = {
    version: 1, kind: 'task-history', taskId: task.taskId, route: task.route,
    sourcePath: task.sourcePath, owner: task.owner, status: task.status,
    archiveFolder: paths.archive(task).slice('archives/'.length),
    ...(task.lifecycleId ? { lifecycleId: task.lifecycleId } : {}),
    ...(task.parent ? { parent: structuredClone(task.parent) } : {}),
    ...(task.children ? { children: structuredClone(task.children) } : {}),
    ...(resultPaths ? { resultPaths: [...resultPaths] } : {}),
    ...(task.workspaceResults ? { workspaceResults: structuredClone(task.workspaceResults) } : {}),
    // Folder identity is historical; an absolute native root still needs its Host fact.
    ...(task.workspaceRootTaskId ? { workspaceRootTaskId: task.workspaceRootTaskId } : {}),
    ...(task.workspaceFolder ? { workspaceFolder: task.workspaceFolder } : {}),
  }
  return { path: taskHistoryPath(task.taskId), content: encodeJson(history) }
}
