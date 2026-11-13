import { randomUUID } from 'node:crypto'
import { lstat, mkdir } from 'node:fs/promises'
import { canonicalLocalLocation } from './local-location.js'
import { LocalRecordFiles, type LocalCaptureSource, type LocalRecordFingerprint, type LocalRecordUpdate, type LocalRecordReplacement, type PreparedLocalReport, type PreparedLocalAppend } from './local-record-files.js'
export { LocalTaskRecordParentMissing } from './local-record-files.js'
import { matchesFileSelection, fileSelectionKey } from './file-list-selection.js'
import { observedFileBytes, observedFileList, fileReadFingerprint } from './file-read-observation.js'
import { directoryPrefix, filePath, validateChanges, type FileChange, type FileCommitOptions,
  type FileEntry, type FileListSelection, type FileReadPlan, type FileReceipt, type FilesSnapshot, type FilesStore } from './transactions.js'

/** A business operation still requiring SQL/Git atomic publication must be
 * migrated explicitly; sequential physical writes are not a transaction. This
 * development boundary is never a production fallback or admission policy. */
export class PhysicalLocalPublicationRequiredError extends Error {
  constructor(readonly operation: string) {
    super('Physical Local publication is not implemented for ' + operation + '. Use its explicit single-file operation or business continuation; no files were written.')
    this.name = 'PhysicalLocalPublicationRequiredError'
  }
}

/** Existing logical categories map directly below the selected Local root.
 * A view owns cancellation/lifetime only, not a database revision or immutable
 * whole-directory image. Every read observes its actual requested physical file.
 * Ordinary writes use replace/append/delete directly. update is reserved for a
 * real read-modify-write on that SAME file; there is no global writer queue,
 * directory scan, content version comparison, command journal or receipt file.
 */
export class PhysicalLocalFiles implements FilesStore {
  readonly kind = 'local-physical' as const
  readonly directory: string
  private readonly records: LocalRecordFiles
  private readonly views = new WeakMap<FilesSnapshot, { signal?: AbortSignal }>()
  private closed = false
  private readonly pending = new Set<Promise<unknown>>()
  private closing?: Promise<void>

  constructor(directory: string) {
    this.records = new LocalRecordFiles(directory)
    this.directory = this.records.root
  }
  /** Acquire the selected physical root without opening an SQL writer. The
   * Host's one-time AI owns retained source conversion; this acquisition neither
   * waits for that work nor treats retained SQL/sidecars as ordinary files.
   * A previously selected missing root is not recreated as an empty store. */
  static async open(directory: string, options: { requireExisting?: boolean } = {}): Promise<PhysicalLocalFiles> {
    const root = await canonicalLocalLocation(directory, true)
    try {
      const info = await lstat(root)
      if (!info.isDirectory()) throw new Error('The selected Local record location is not a directory.')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (options.requireExisting) throw new Error('The existing Local directory is unavailable. No replacement store was created.')
      // A new selected root is actually acquired before its backend is saved.
      // No business file or substitute database is created here.
      await mkdir(root, { recursive: true })
      if (!(await lstat(root)).isDirectory()) throw new Error('The selected Local record location is not a directory.')
    }
    return new PhysicalLocalFiles(root)
  }
  private assertOpen(): void { if (this.closed) throw new Error('Physical Local storage is closed.') }
  private own<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen()
    const result = operation()
    this.pending.add(result)
    void result.finally(() => this.pending.delete(result)).catch(() => {})
    return result
  }
  private view(snapshot: FilesSnapshot): { signal?: AbortSignal } {
    const view = this.views.get(snapshot)
    if (!view) throw new Error('Physical read view was released or belongs to another store.')
    view.signal?.throwIfAborted()
    return view
  }
  async snapshot(plan?: FileReadPlan): Promise<FilesSnapshot> {
    this.assertOpen(); plan?.signal?.throwIfAborted()
    const snapshot: FilesSnapshot = {
      revision: 'local-view:' + randomUUID(), consistency: 'physical-live',
      release: async () => { this.views.delete(snapshot) },
    }
    this.views.set(snapshot, { signal: plan?.signal })
    return Object.freeze(snapshot)
  }
  /** Physical reads do not prefetch/cache bodies or turn a plan into a scan. */
  async prefetch(snapshot: FilesSnapshot, plan: FileReadPlan): Promise<void> {
    this.assertOpen(); this.view(snapshot); plan.signal?.throwIfAborted()
  }
  readBytes(snapshot: FilesSnapshot, path: string): Promise<Uint8Array | undefined> {
    return this.own(async () => {
      this.view(snapshot); filePath(path)
      const bytes = await this.records.readBytes(path)
      this.view(snapshot); observedFileBytes(snapshot, path, bytes)
      return bytes
    })
  }
  async read(snapshot: FilesSnapshot, path: string): Promise<string | undefined> {
    const bytes = await this.readBytes(snapshot, path)
    return bytes === undefined ? undefined : new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
  private listEntries(snapshot: FilesSnapshot, prefix: string, recursive: boolean, selection?: FileListSelection): Promise<FileEntry[]> {
    return this.own(async () => {
      this.view(snapshot)
      const logical = directoryPrefix(prefix), selected = selection && structuredClone(selection)
      // Archive children are skipped BEFORE recursion. A parent listing never
      // traverses an independent child's material merely to filter it afterward.
      const entries = await this.records.listMetadata(logical, recursive, selected?.archiveScope
        ? path => matchesFileSelection(path, { archiveScope: selected.archiveScope }) : undefined)
      this.view(snapshot)
      const result = entries.filter(entry => matchesFileSelection(entry.path, selected))
      observedFileList(snapshot, recursive ? 'list' : 'directory', logical + fileSelectionKey(selected), result)
      return result
    })
  }
  list(snapshot: FilesSnapshot, prefix: string, selection?: FileListSelection): Promise<FileEntry[]> { return this.listEntries(snapshot, prefix, true, selection) }
  listDirectory(snapshot: FilesSnapshot, prefix: string, selection?: FileListSelection): Promise<FileEntry[]> { return this.listEntries(snapshot, prefix, false, selection) }
  listDirectoryNames(snapshot: FilesSnapshot, prefix: string, selection?: FileListSelection): Promise<string[]> {
    return this.own(async () => {
      this.view(snapshot)
      const logical = directoryPrefix(prefix)
      const names = (await this.records.listDirectoryNames(logical)).filter(path => matchesFileSelection(path, selection))
      this.view(snapshot)
      fileReadFingerprint(snapshot, 'names:' + logical + fileSelectionKey(selection), JSON.stringify(names))
      return names
    })
  }
  fileMetadata(path: string): ReturnType<LocalRecordFiles['fileMetadata']> { return this.own(() => this.records.fileMetadata(path)) }
  fileInfo(path: string): Promise<{ bytes: number; version: string } | undefined> { return this.own(() => this.records.fileInfo(path)) }
  entryInfo(path: string): ReturnType<LocalRecordFiles['entryInfo']> { return this.own(() => this.records.entryInfo(path)) }
  readPrefix(path: string, length: number): Promise<Uint8Array | undefined> { return this.own(() => this.records.readPrefix(path, length)) }
  fingerprint(path: string, signal?: AbortSignal): Promise<LocalRecordFingerprint | undefined> { return this.own(() => this.records.fingerprint(path, signal)) }
  stageCopy(source: string, stage: string, signal?: AbortSignal): Promise<LocalRecordFingerprint | undefined> {
    return this.own(() => this.records.stageCopy(source, stage, signal))
  }
  stageRead(source: string, stage: string, openSource: () => Promise<LocalCaptureSource | undefined>, signal?: AbortSignal): Promise<LocalRecordFingerprint | undefined> {
    return this.own(() => this.records.stageRead(source, stage, openSource, signal))
  }
  renameIfAbsent(from: string, to: string): Promise<'renamed' | 'source-missing' | 'destination-exists'> {
    return this.own(() => this.records.renameIfAbsent(from, to))
  }
  replace(path: string, content: string | Uint8Array): Promise<void> { return this.own(() => this.records.replace(path, content)) }
  append(path: string, content: string | Uint8Array): Promise<void> { return this.own(() => this.records.append(path, content)) }
  delete(path: string): Promise<boolean> { return this.own(() => this.records.delete(path)) }
  createIfAbsent(path: string, content: string | Uint8Array): Promise<boolean> { return this.own(() => this.records.createIfAbsent(path, content)) }
  rename(from: string, to: string): Promise<boolean> { return this.own(() => this.records.rename(from, to)) }
  appendPrepared(path: string, stagePath: string, content: string, prepared: PreparedLocalAppend | undefined,
    markPrepared: (value: PreparedLocalAppend) => Promise<void>): Promise<void> {
    return this.own(() => this.records.appendPrepared(path, stagePath, content, prepared, markPrepared))
  }
  publishPreparedReport(path: string, stagePath: string, text: string, append: boolean,
    prepared: PreparedLocalReport | undefined, markPrepared: (value: PreparedLocalReport) => Promise<void>,
    missingStage: 'strict' | 'same-file-identity' = 'strict'): Promise<void> {
    return this.own(() => this.records.publishPreparedReport(path, stagePath, text, append, prepared, markPrepared, missingStage))
  }
  deleteObserved(path: string, observedVersion: string, beforeDelete?: () => void): Promise<boolean> {
    return this.own(() => this.records.deleteObserved(path, observedVersion, beforeDelete))
  }
  update<T>(path: string, decide: (current: Uint8Array | undefined) => LocalRecordUpdate<T>, signal?: AbortSignal): Promise<T> {
    return this.own(() => this.records.update(path, decide, signal))
  }
  updateAsync<T>(path: string, decide: (current: Uint8Array | undefined) => Promise<LocalRecordUpdate<T>>, signal?: AbortSignal): Promise<T> {
    return this.own(() => this.records.updateAsync(path, decide, signal))
  }
  updateInExistingDirectory<T>(path: string, decide: (current: Uint8Array | undefined) => Promise<LocalRecordReplacement<T>>, signal?: AbortSignal, coordinateRemoval = false): Promise<T> {
    return this.own(() => this.records.updateInExistingDirectory(path, decide, signal, coordinateRemoval))
  }
  removeDirectory(path: string, coordinateRemoval = false): Promise<void> {
    return this.own(() => this.records.removeDirectory(path, coordinateRemoval))
  }
  removeEmptyDirectory(path: string): Promise<boolean> { return this.own(() => this.records.removeEmptyDirectory(path)) }
  async commit(snapshot: FilesSnapshot, changes: readonly FileChange[], message: string, _options?: FileCommitOptions): Promise<FileReceipt> {
    this.assertOpen(); this.view(snapshot); validateChanges(changes)
    if (changes.length) throw new PhysicalLocalPublicationRequiredError(message)
    return { revision: snapshot.revision, replay: false, observationOnly: true }
  }
  /** Drain this handle's accepted operations only. Independent stores, files and
   * lanes are never included; no filesystem worker or process survives close. */
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    return this.closing = Promise.allSettled([...this.pending]).then(() => {})
  }
}
