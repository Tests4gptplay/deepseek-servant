// Reconstructed from the 55fe host bundle's task-workspace runtime module.
// Runtime behavior is retained; TypeScript types/imports/exports are reconstructed.
import type { Stats } from 'node:fs'
import { lstat, mkdir, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ensureWriteDirectory } from './write-directories.js'
import { paths, readJson, encodeJson, taskLifecycle, isTerminalTask, type TaskMetadata } from './task-files.js'
import { PhysicalLocalFiles } from './physical-local-files.js'
import { readTaskArchiveState, taskArchiveHostFacts } from './task-archive.js'
import { linkedChild } from './task-relations.js'
import { readTaskReferenceIdentity } from './task-history.js'
import { FilesConflictError, GitFiles, withWriteOperation, withSnapshot, type FilesSnapshot, type FilesStore } from './transactions.js'
import { isPhysicalWorkspaceReference, taskSourceName, taskWorkspaceFolder, type PhysicalWorkspaceReference } from './workspace-paths.js'

export interface TaskWorkspaceLocation {
  taskId: string
  rootTaskId: string
  folder: string
  directory: string
}

const contained = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return rel === '' || !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep)
}

export class TaskWorkspaces {
  private readonly roots = new Map<string, string>()
  private readonly bindings = new Map<string, Promise<string | undefined>>()
  constructor(readonly files: FilesStore, public root: string, readonly owner = '', readonly instanceUUID = '', private readonly archiveHostKey?: string) {}
  select(root: string): void { this.root = root }
  rootFor(taskId: string): string { return this.roots.get(taskId) ?? this.root }
  rememberRoot(taskId: string, root = this.root): void { if (!this.roots.has(taskId)) this.roots.set(taskId, root) }
  remember(location: TaskWorkspaceLocation): void {
    this.rememberRoot(location.rootTaskId, dirname(location.directory))
    this.rememberRoot(location.taskId, dirname(location.directory))
  }
  knownTasks(): string[] { return [...this.roots.keys()] }
  hasBinding(taskId: string): boolean { return this.roots.has(taskId) }
  release(taskId: string): void { this.roots.delete(taskId) }
  /** Only this exact Task metadata owns this Host's binding. Other Tasks and
   * Cleaner never join this promise or inspect a separate locator. */
  private bindSelected(task: TaskMetadata, preferred: string): Promise<string | undefined> {
    const active = this.bindings.get(task.taskId)
    if (active) return active
    const choose = (current: TaskMetadata | undefined): { root?: string; next?: TaskMetadata } => {
      if (!current) return {}
      if (current.taskId !== task.taskId || taskLifecycle(current) !== taskLifecycle(task))
        throw new Error('Task lifecycle changed before its Host workspace binding.')
      const root = current.hostWorkspaces?.[this.instanceUUID]
      return root === undefined ? { root: preferred, next: { ...current, hostWorkspaces: { ...current.hostWorkspaces, [this.instanceUUID]: preferred } } } : { root }
    }
    const operation = (async () => {
      if (this.files instanceof PhysicalLocalFiles) return this.files.update(paths.task(task.taskId), bytes => {
        const current = bytes === undefined ? undefined : JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as TaskMetadata
        const selected = choose(current)
        return { value: selected.root, ...(selected.next ? { content: encodeJson(selected.next) } : {}) }
      })
      return withWriteOperation(this.files, async () => {
        let retry: FilesSnapshot | undefined
        try { for (;;) {
          const snapshot = retry ?? await this.files.snapshot(); retry = undefined
          try {
            const current = await readJson<TaskMetadata>(this.files, snapshot, paths.task(task.taskId)), selected = choose(current)
            if (!selected.next) return selected.root
            if (this.archiveHostKey) {
              const facts = taskArchiveHostFacts(await readTaskArchiveState(this.files, snapshot, current!), current!, this.archiveHostKey)
              if (facts?.runtimeReleased || facts?.released) return undefined
            }
            try {
              await this.files.commit(snapshot, [{ path: paths.task(task.taskId), content: encodeJson(selected.next) }], 'DSS Host Task workspace ' + task.taskId,
                { reevaluateOnConflict: true })
              return selected.root
            } catch (error) {
              if (!(error instanceof FilesConflictError)) throw error
              if (this.files instanceof GitFiles) retry = this.files.takeConflictSnapshot(error)
            }
          } finally { await snapshot.release() }
        } } finally { await retry?.release() }
      })
    })()
    this.bindings.set(task.taskId, operation)
    void operation.finally(() => { if (this.bindings.get(task.taskId) === operation) this.bindings.delete(task.taskId) }).catch(() => {})
    return operation
  }
  async bind(taskId: string, preferred = this.rootFor(taskId), observed?: (task: TaskMetadata) => void): Promise<TaskWorkspaceLocation | undefined> {
    return withSnapshot(this.files, async snapshot => {
      const selected = await readJson<TaskMetadata>(this.files, snapshot, paths.task(taskId))
      if (!selected) return undefined
      return this.locateSelected(taskId, snapshot, false, selected, preferred, false, observed)
    })
  }

  async locate(taskId: string, snapshot?: FilesSnapshot, omitUnknownTerminal = false): Promise<TaskWorkspaceLocation | undefined> {
    return (snapshot ? await this.locateSelected(taskId, snapshot, true, undefined, undefined, omitUnknownTerminal) : await withSnapshot(this.files, view => this.locateSelected(taskId, view, true, undefined, undefined, omitUnknownTerminal)))
  }
  private async locateSelected(taskId: string, snapshot: FilesSnapshot, historical: boolean, knownSelected?: TaskMetadata, bindRoot?: string, omitUnknownTerminal = false, observed?: (task: TaskMetadata) => void): Promise<TaskWorkspaceLocation | undefined> {
    const read = async (id: string) => {
      const value = historical ? await readTaskReferenceIdentity(this.files, snapshot, id)
        : await readJson<TaskMetadata>(this.files, snapshot, paths.task(id))
      if (!historical && value) observed?.(value as TaskMetadata)
      return value
    }
    const selected = knownSelected ?? await read(taskId)
    if (!selected || selected.taskId !== taskId) throw new Error('Task workspace metadata is unavailable: ' + taskId)
    if (!historical && knownSelected) observed?.(knownSelected)
    let task = selected
    const visited = new Set([taskId])
    while (task.parent && !(task.workspaceRootTaskId && task.workspaceFolder)) {
      const parentId = task.parent.taskId, parent = await read(parentId)
      if (!parent || !linkedChild(parent, task) || parent.taskId !== parentId || visited.has(parentId))
        throw new Error('Task workspace parent association is invalid.')
      visited.add(parentId)
      task = parent
    }
    const rootTaskId = task.workspaceRootTaskId ?? task.taskId
    const folder = task.workspaceFolder ?? taskWorkspaceFolder(taskSourceName(task.sourcePath), task.taskId)
    if (folder !== taskWorkspaceFolder(folder.slice(0, -(rootTaskId.length + 1)), rootTaskId))
      throw new Error('Invalid persisted Task workspace directory.')
    const own = (task as TaskMetadata).hostWorkspaces?.[this.instanceUUID]
    const knownRoot = own ?? this.roots.get(rootTaskId) ?? this.roots.get(taskId)
    // An outward terminal/history view is not a new assignment under today's default.
    // Keep real own-Host locations, but do not require another archive read.
    if (omitUnknownTerminal && knownRoot === undefined && (isTerminalTask(selected)
      || 'kind' in selected && selected.kind === 'task-history')) return undefined
    let root = knownRoot ?? bindRoot ?? this.root
    if (!isAbsolute(root)) throw new Error('Choose an absolute local task workspace directory.')
    if (bindRoot !== undefined && this.instanceUUID && own === undefined) {
      const saved = await this.bindSelected(task as TaskMetadata, root)
      if (saved === undefined) return undefined
      root = saved
    }
    if (bindRoot !== undefined || own !== undefined) { this.roots.set(rootTaskId, root); this.roots.set(taskId, root) }
    if (!isAbsolute(root)) throw new Error('Choose an absolute local task workspace directory.')
    return { taskId, rootTaskId, folder, directory: join(root, folder) }
  }

  /** Validate a retained execution's exact local cwd without scanning or guessing folders. */
  async retained(taskId: string, cwd: string, rootTaskId = taskId): Promise<TaskWorkspaceLocation | undefined> {
    const selectedRoot = this.rootFor(rootTaskId)
    if (!isAbsolute(cwd) || !isAbsolute(selectedRoot) || !contained(selectedRoot, cwd))
      throw new Error('Retained workspace is outside the selected local root.')
    const folder = relative(selectedRoot, cwd).split(sep)[0]
    if (!folder || !folder.endsWith('_' + rootTaskId) || folder !== taskWorkspaceFolder(folder.slice(0, -(rootTaskId.length + 1)), rootTaskId))
      throw new Error('Retained workspace does not identify the selected Task.')
    const directory = join(selectedRoot, folder)
    const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (!info) return undefined
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('Retained workspace must be an ordinary directory, not a symbolic link.')
    const root = await realpath(selectedRoot), actual = await realpath(directory)
    if (!contained(root, actual) || root === actual) throw new Error('Retained workspace escapes the selected local root.')
    return { taskId, rootTaskId, folder, directory: actual }
  }

  async ensure(taskId: string, snapshot?: FilesSnapshot): Promise<TaskWorkspaceLocation> {
    const location = snapshot ? await this.locateSelected(taskId, snapshot, false, undefined, this.rootFor(taskId))
      : await this.bind(taskId)
    if (!location) throw new Error('Task workspace metadata is unavailable: ' + taskId)
    return this.ensurePrepared(location)
  }
  async ensurePrepared(location: TaskWorkspaceLocation): Promise<TaskWorkspaceLocation> {
    const root = await ensureWriteDirectory(dirname(location.directory))
    const destination = join(root, location.folder)
    const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink()))
      throw new Error('Task workspace path is not an ordinary directory.')
    await mkdir(destination, { recursive: true })
    const actual = await realpath(destination), kind = await lstat(destination)
    if (!kind.isDirectory() || kind.isSymbolicLink()) throw new Error('Task workspace path is not an ordinary directory.')
    if (!contained(root, actual) || actual === root) throw new Error('Task workspace escapes its selected root.')
    return { ...location, directory: actual }
  }

  async file(reference: unknown, selectedRoot = this.root): Promise<string> {
    if (!isPhysicalWorkspaceReference(reference))
      throw new Error('A physical file requires its exact absolute path and producing Host identity.')
    if (!this.instanceUUID || reference.instanceUUID !== this.instanceUUID)
      throw new Error('This physical result belongs to another Host instance; its path must not be opened on this computer.')
    if (!isAbsolute(reference.path)) throw new Error('The physical result path is not native to this Host.')
    const root = await realpath(selectedRoot), path = await realpath(reference.path)
    if (path !== reference.path) throw new Error('The exact physical result path changed; inspect the original before opening it.')
    if (!contained(root, path) || root === path)
      throw new Error('Physical result is outside the selected workspace root; it was not relocated.')
    return path
  }

  /** Registers no upload: the existing file or directory and its absolute path stay unchanged. */
  async reference(taskId: string, sourcePath: string, cwd: string, snapshot?: FilesSnapshot): Promise<PhysicalWorkspaceReference & { nativePath: string; bytes: number }> {
    const nativePath = await realpath(resolve(cwd, sourcePath))
    const reference = { path: nativePath, taskId, owner: this.owner, instanceUUID: this.instanceUUID }
    const info = await this.validateReference(reference, snapshot)
    return { ...reference, nativePath, bytes: info.size }
  }

  /** Publication checks task ownership and its boundary; later reads need no live Task. */
  async validate(reference: PhysicalWorkspaceReference, snapshot?: FilesSnapshot): Promise<void> {
    await this.validateReference(reference, snapshot)
  }
  private async validateReference(reference: PhysicalWorkspaceReference, snapshot?: FilesSnapshot): Promise<Stats> {
    if (!snapshot) return withSnapshot(this.files, view => this.validateReference(reference, view))
    // This records a verified physical location, not an immutable native-file
    // snapshot. Task ownership and directory ancestry below are ordinary tracked
    // Git/Local reads; unrelated storage writes do not invalidate this location.
    if (!this.owner || reference.owner !== this.owner) throw new Error('Physical result producer differs from this Host member.')
    if (!reference.taskId) throw new Error('Recording a physical result requires its Task association.')
    const selected = await readJson<TaskMetadata>(this.files, snapshot, paths.task(reference.taskId))
    if (!selected || selected.taskId !== reference.taskId || ![selected.owner, ...selected.members ?? []].includes(reference.owner))
      throw new Error('Physical result ownership does not match its Task.')
    const location = (await this.locateSelected(reference.taskId, snapshot, false, selected))!
    const path = await this.file(reference, dirname(location.directory)), directory = await realpath(location.directory)
    if (!contained(directory, path) || path === directory) throw new Error('Save actual material inside this Task workspace before linking it.')
    const info = await stat(path)
    if (!info.isFile() && !info.isDirectory()) throw new Error('Workspace material must be an existing regular file or directory.')
    return info
  }
}
