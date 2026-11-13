import { AsyncLocalStorage } from 'node:async_hooks'
import type { GitDirectoryIndex } from './git-directory-index.js'
import type { GitReadDependencies, GitDependencyList } from '../experimental/private-git/contracts.js'
import { matchesFileSelection, mayContainSelectedFiles, fileSelectionKey, type FileListSelection } from './file-list-selection.js'
export type { FileListSelection } from './file-list-selection.js'
import { observedFileBytes, observedFileList } from './file-read-observation.js'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { GitSnapshot, GitChange, GitReceipt, RepoConnection, GitReadPlan, GitOperationChannel } from '../experimental/private-git/contracts.js'
import { GitConflictError } from '../experimental/private-git/github.js'
import { GitCommitOutcomeUnknownError, type GitCommitOperation, type GitCommitResolution } from '../experimental/private-git/contracts.js'

export type FileChange = ({ path: string; content: string | null; bytes?: never } | { path: string; bytes: Uint8Array; content?: never }) & { /** Explicit Git directory deletion; ordinary null still means file deletion. */ deleteTree?: true }
export interface FileEntry { path: string; version: string; bytes?: number; empty?: boolean }
export interface FilesSnapshot { readonly revision: string; /** Physical views identify an observation scope, not an immutable database state. */ readonly consistency?: 'physical-live'; release(): Promise<void> }
export interface FileReadPlan {
  files?: readonly string[]; directories?: readonly string[]; signal?: AbortSignal; isolatePathErrors?: boolean
}
export interface FileCommitOptions {
  beforeAttempt?: () => void | Promise<void>
  /** Existing command owner may continue only while its original operation is provably unsent. */
  resumeUnsent?: true
  onAttempt?: (operation: GitCommitOperation) => void
  replayReceipt?: { path: string; content: string }
  /** Discovery indexes must be refreshed before evaluating a different HEAD. */
  reevaluateOnConflict?: boolean
}
export interface FileReceipt { revision: string; replay: boolean; operationId?: string; /** Current observation only; not a persisted command acknowledgement. */ observationOnly?: true }
/** One explicit discovery round. No TTL, credentials, publication authority or
 * ambient async context. Consumers own separate leases at the same immutable H. */
export interface FilesReadRound {
  /** Independent lease of this exact observed poll; caller releases it. */
  acquireSnapshot(): Promise<FilesSnapshot>
  withSnapshot<T>(operation: (snapshot: FilesSnapshot) => Promise<T>): Promise<T>
  once<T>(owner: object, key: string, read: () => Promise<T>): Promise<T>
}
export interface FilesStore {
  /** Fixed operation lanes; stores without transport pools retain their contract. */
  withChannel?<T>(channel: GitOperationChannel, operation: () => Promise<T>): Promise<T>
  withWriteOperation?<T>(operation: () => Promise<T>): Promise<T>
  /** One owned callback; no credential/session survives its completion. */
  withReadOperation?<T>(operation: () => Promise<T>): Promise<T>
  snapshot(plan?: FileReadPlan): Promise<FilesSnapshot>
  prefetch?(snapshot: FilesSnapshot, plan: FileReadPlan): Promise<void>
  read(snapshot: FilesSnapshot, path: string): Promise<string | undefined>
  readBytes(snapshot: FilesSnapshot, path: string): Promise<Uint8Array | undefined>
  list(snapshot: FilesSnapshot, prefix: string, selection?: FileListSelection): Promise<FileEntry[]>
  listDirectory(snapshot: FilesSnapshot, prefix: string, selection?: FileListSelection): Promise<FileEntry[]>
  listDirectoryNames?(snapshot: FilesSnapshot, prefix: string, selection?: FileListSelection): Promise<string[]>
  commit(snapshot: FilesSnapshot, changes: readonly FileChange[], message: string, options?: FileCommitOptions): Promise<FileReceipt>
}
export class FilesConflictError extends Error {
  constructor(readonly expectedRevision: string, options?: ErrorOptions) {
    super('Storage changed since the checked snapshot; read and evaluate the business conditions again.', options)
    this.name = 'FilesConflictError'
  }
}
export class FilesOutcomeUnknownError extends Error {
  constructor(readonly operationId: string, options?: ErrorOptions) {
    super('Commit result is uncertain; resolve the same persisted operation before retrying.', options)
    this.name = 'FilesOutcomeUnknownError'
  }
}
export function filePath(path: string): string {
  if (!path || /[\\\0\r\n]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Use a relative file path inside the DSS storage root.')
  }
  return path
}
export function directoryPrefix(prefix: string): string {
  return prefix === '' ? '' : filePath(prefix.replace(/\/$/, '')) + '/'
}
export function validateChanges(changes: readonly FileChange[]): void {
  const paths = new Set<string>()
  for (const change of changes) {
    filePath(change.path)
    if (change.deleteTree !== undefined && (change.deleteTree !== true || change.content !== null)) throw new Error('A directory deletion must explicitly carry null content.')
    if (change.bytes !== undefined ? !(change.bytes instanceof Uint8Array) || change.content !== undefined : typeof change.content !== 'string' && change.content !== null) throw new Error('A change must carry text, bytes, or a deletion, never mixed representations.')
    if (paths.has(change.path)) throw new Error('A transaction cannot write the same path twice: ' + change.path)
    paths.add(change.path)
  }
}
export function withOperationChannel<T>(store: FilesStore, channel: GitOperationChannel, operation: () => Promise<T>): Promise<T> {
  return store.withChannel ? store.withChannel(channel, operation) : operation()
}
/** Keep predicate reads, retry and reconciliation in the selected writer pool. */
export function withWriteOperation<T>(store: FilesStore, operation: () => Promise<T>): Promise<T> {
  return store.withWriteOperation ? store.withWriteOperation(operation) : withOperationChannel(store, 'write', operation)
}
export function withFileDependencies<T>(store: FilesStore, snapshot: FilesSnapshot, action: () => Promise<T>): Promise<T> {
  return store instanceof GitFiles ? store.withDependencyCapture(snapshot, action) : action()
}
export function withReadOperation<T>(store: FilesStore, operation: () => Promise<T>): Promise<T> {
  return store.withReadOperation ? store.withReadOperation(operation) : operation()
}
export async function withSnapshot<T>(store: FilesStore, operation: (snapshot: FilesSnapshot) => Promise<T>, plan?: FileReadPlan): Promise<T> {
  const owned = async () => {
    const snapshot = await store.snapshot(plan)
    try { return await operation(snapshot) } finally { await snapshot.release() }
  }
  return withReadOperation(store, owned)
}
export interface GitOperationRecord {
  operation: GitCommitOperation
  resolution?: GitCommitResolution
}
/** Transport reconciliation cache. Git authority callers keep it session-only;
 * durable command replay is represented by the remote atomic receipt. */
export interface GitOperationStore {
  save(record: GitOperationRecord): Promise<void>
  get(id: string): Promise<GitOperationRecord | undefined>
  list(): Promise<GitOperationRecord[]>
  /** Optional session-only ownership; durable/custom stores retain their policy. */
  retain?(id: string): () => void
  /** Actual dispatch ownership, used only to preserve uncertain metadata. */
  markDispatched?(id: string): void
  /** Existing owned session facts only; absence or recovered uncertainty is not proof. */
  isUndispatched?(id: string): boolean
  /** Retire after actual users release; abandoned preparation cannot erase a dispatch. */
  retire?(id: string, onlyUnsent?: boolean): void
  /** Release a resolved operation from a session-only reconciliation cache. */
  delete?(id: string): Promise<void>
}

/** Reads use immutable Git snapshots; writes validate actual dependencies before
 * atomic ref publication. Production and current transport fixtures use Dulwich Git. */
export interface FrameworkGitRepository {
  withChannel?<T>(channel: GitOperationChannel, operation: () => Promise<T>): Promise<T>
  withWriteOperation?<T>(operation: () => Promise<T>): Promise<T>
  withReadOperation<T>(operation: () => Promise<T>): Promise<T>
  snapshot(afterWrite?: boolean, plan?: GitReadPlan): Promise<GitSnapshot>
  prefetch(snapshot: GitSnapshot, plan: GitReadPlan): Promise<void>
  at(revision: string): Promise<GitSnapshot>
  borrowSnapshot?(snapshot: GitSnapshot, signal: AbortSignal): GitSnapshot
  read(snapshot: GitSnapshot, path: string): Promise<string | undefined>
  readBytes(snapshot: GitSnapshot, path: string): Promise<Uint8Array | undefined>
  list(snapshot: GitSnapshot, prefix: string): Promise<void>
  listDirectory(snapshot: GitSnapshot, prefix: string): Promise<Array<{ path: string; sha: string; type: 'blob' | 'tree' | 'commit'; size?: number }>>
  directoryIndex?(snapshot: GitSnapshot, prefix: string, previous?: GitDirectoryIndex, options?: { recursive?: boolean }): Promise<GitDirectoryIndex>
  prepareCommit(snapshot: GitSnapshot, changes: readonly GitChange[], message: string): GitCommitOperation
  /** Opt in only when original-operation provenance and actual push are reported. */
  readonly reportsCommitDispatch?: true
  /** Checks the supplied unsent proof inside the existing same-operation queue. */
  readonly resumesUnsentCommits?: true
  commitPrepared(snapshot: GitSnapshot, changes: readonly GitChange[], message: string, operation: GitCommitOperation, onDispatch?: () => void, isUndispatched?: () => boolean): Promise<GitReceipt>
  resolveCommit(operation: GitCommitOperation): Promise<GitCommitResolution>
  takeConflictSnapshot?(error: unknown): GitSnapshot | undefined
  dependenciesEqual?(base: GitSnapshot, current: GitSnapshot, dependencies: GitReadDependencies): Promise<boolean>
  connect(): Promise<RepoConnection>
  ensureBranch(): Promise<GitSnapshot>
  cancel(reason?: unknown): void
  releaseCache(): Promise<void>
  releaseSnapshot?(snapshot: GitSnapshot): void
}

/** Maps logical paths once; the repository remains the authority for Git content and CAS. */
export class GitFiles implements FilesStore {
  private readonly conflictSnapshots = new WeakMap<FilesConflictError, GitSnapshot>()
  takeConflictSnapshot(error: FilesConflictError): FilesSnapshot | undefined {
    const native = this.conflictSnapshots.get(error)
    this.conflictSnapshots.delete(error)
    return native ? this.wrap(native) : undefined
  }
  private readonly capture = new AsyncLocalStorage<{ snapshot: FilesSnapshot } | undefined>()
  private readonly dependencies = new WeakMap<FilesSnapshot, { files: Set<string>; lists: GitDependencyList[] }>()
  /** Nested current-view reads use this command's immutable view and read set.
   * Explicit at(revision) reads retain their independent historical meaning. */
  async withDependencyCapture<T>(snapshot: FilesSnapshot, action: () => Promise<T>): Promise<T> {
    return this.capture.run({ snapshot }, action)
  }
  /** Session-only replay metadata for a command whose outcome is unresolved. */
  captureReads(snapshot: FilesSnapshot): GitReadDependencies {
    this.native(snapshot)
    const tracked = this.dependencies.get(snapshot)!
    return { files: [...tracked.files], lists: structuredClone(tracked.lists) }
  }
  restoreReads(snapshot: FilesSnapshot, saved: GitReadDependencies): void {
    this.native(snapshot)
    const tracked = this.dependencies.get(snapshot)!
    for (const path of saved.files) tracked.files.add(path)
    tracked.lists.push(...structuredClone(saved.lists))
  }
  async listDirectoryNames(snapshot: FilesSnapshot, prefix: string, selection?: FileListSelection): Promise<string[]> {
    this.dependencies.get(snapshot)?.lists.push({ prefix: 'dss-coop/' + directoryPrefix(prefix), recursive: false, namesOnly: true, ...(selection ? { selection: structuredClone(selection) } : {}) })
    const result = await this.repository.listDirectory(this.native(snapshot), 'dss-coop/' + directoryPrefix(prefix))
    return result.filter(entry => entry.type === 'blob').map(entry => entry.path.slice('dss-coop/'.length)).filter(path => matchesFileSelection(path, selection)).sort()
  }
  private readonly snapshots = new WeakMap<FilesSnapshot, GitSnapshot>()
  private readonly aliasSignals = new WeakMap<FilesSnapshot, AbortSignal>()
  private readonly observationOwners = new WeakMap<FilesSnapshot, FilesSnapshot>()
  // Only the first dispatch from the original live snapshot may retain native
  // preparation identity. Persisted clones and retries are never freshness proof.
  private readonly preparedOperations = new WeakMap<FilesSnapshot, Map<string, { original: GitCommitOperation; captured: GitCommitOperation; release?: () => void; consumed?: boolean }>>()
  constructor(readonly repository: FrameworkGitRepository, readonly operations: GitOperationStore) {}
  /** Retain only transport metadata needed by a still-live logical owner. */
  retainOperation(id: string): (() => void) | undefined { return this.operations.retain?.(id) }
  canResumeUnsent(id: string): boolean { return this.repository.resumesUnsentCommits === true && this.operations.isUndispatched?.(id) === true }
  withChannel<T>(channel: GitOperationChannel, operation: () => Promise<T>): Promise<T> {
    return this.repository.withChannel ? this.repository.withChannel(channel, operation) : operation()
  }
  withWriteOperation<T>(operation: () => Promise<T>): Promise<T> {
    const independent = () => this.capture.run(undefined, operation)
    return this.repository.withWriteOperation ? this.repository.withWriteOperation(independent) : this.withChannel('write', independent)
  }
  withReadOperation<T>(operation: () => Promise<T>): Promise<T> { return this.repository.withReadOperation(operation) }
  private wrap(native: GitSnapshot, borrowed = false, shared?: FilesSnapshot, signal?: AbortSignal): FilesSnapshot {
    const snapshot: FilesSnapshot = { revision: native.head, release: async () => { this.snapshots.delete(snapshot); for (const [id, preparation] of this.preparedOperations.get(snapshot) ?? []) { this.operations.retire?.(id, true); preparation.release?.() } this.preparedOperations.delete(snapshot); this.dependencies.delete(snapshot); this.observationOwners.delete(snapshot); this.aliasSignals.delete(snapshot); if (!borrowed) this.repository.releaseSnapshot?.(native) } }
    this.snapshots.set(snapshot, native)
    if (signal) this.aliasSignals.set(snapshot, signal)
    if (shared) this.observationOwners.set(snapshot, this.observationOwners.get(shared) ?? shared)
    this.dependencies.set(snapshot, shared ? this.dependencies.get(shared)! : { files: new Set(), lists: [] })
    return snapshot
  }
  private plan(plan: FileReadPlan) {
    return { signal: plan.signal, isolatePathErrors: plan.isolatePathErrors, files: plan.files?.map(path => 'dss-coop/' + filePath(path)),
      directories: plan.directories?.map(path => 'dss-coop/' + directoryPrefix(path).replace(/\/$/, '')) }
  }
  async snapshot(plan?: FileReadPlan): Promise<FilesSnapshot> {
    const owner = this.capture.getStore()
    if (owner) {
      const parent = this.native(owner.snapshot)
      const native = plan?.signal && this.repository.borrowSnapshot ? this.repository.borrowSnapshot(parent, plan.signal) : parent
      const snapshot = this.wrap(native, native === parent, owner.snapshot, plan?.signal)
      try { if (plan) await this.repository.prefetch(native, this.plan(plan)); return snapshot }
      catch (error) { await snapshot.release(); throw error }
    }
    return this.wrap(await this.repository.snapshot(false, plan && this.plan(plan)))
  }
  /** Explicit discovery sharing. Normal snapshot() does not borrow this view.
   * A caller holding its own poll lease may submit its actual dependencies;
   * publication/recovery still use the remote atomic protocol, never a cached
   * head as authority. No credentials survive an individual read callback. */
  readRound(channel?: GitOperationChannel): FilesReadRound {
    let view: Promise<GitSnapshot> | undefined
    const reads = new WeakMap<object, Map<string, Promise<unknown>>>()
    const acquireSnapshot = async (): Promise<FilesSnapshot> => {
      // Select only the immutable discovery snapshot's transport. Every lease
      // has its own dependency set and release, while preserving the actual
      // remote observation (unlike reopening an arbitrary historical commit).
      const acquire = () => this.withReadOperation(async () => {
        const current = await (view ??= this.repository.snapshot())
        await this.repository.prefetch(current, {})
        return current
      })
      const native = await (channel ? this.withChannel(channel, acquire) : acquire())
      return this.wrap(native, true)
    }
    return {
      acquireSnapshot,
      withSnapshot: async operation => {
        const snapshot = await acquireSnapshot()
        try { return await operation(snapshot) } finally { await snapshot.release() }
      },
      once: <T>(owner: object, key: string, read: () => Promise<T>): Promise<T> => {
        let entries = reads.get(owner)
        if (!entries) reads.set(owner, entries = new Map())
        let pending = entries.get(key)
        if (!pending) { pending = Promise.resolve().then(read); entries.set(key, pending) }
        return pending as Promise<T>
      },
    }
  }
  prefetch(snapshot: FilesSnapshot, plan: FileReadPlan): Promise<void> { return this.repository.prefetch(this.native(snapshot), this.plan(plan)) }
  async at(revision: string): Promise<FilesSnapshot> { return this.wrap(await this.repository.at(revision)) }
  private native(snapshot: FilesSnapshot): GitSnapshot {
    this.aliasSignals.get(snapshot)?.throwIfAborted()
    const native = this.snapshots.get(snapshot)
    if (!native) throw new Error('Snapshot was released or belongs to another store.')
    return native
  }
  read(snapshot: FilesSnapshot, path: string): Promise<string | undefined> {
    path = filePath(path)
    this.dependencies.get(snapshot)?.files.add('dss-coop/' + path)
    return this.repository.read(this.native(snapshot), 'dss-coop/' + path).then(text => {
      observedFileBytes(this.observationOwners.get(snapshot) ?? snapshot, path, text === undefined ? undefined : Buffer.from(text, 'utf8'))
      return text
    })
  }
  readBytes(snapshot: FilesSnapshot, path: string): Promise<Uint8Array | undefined> {
    path = filePath(path)
    this.dependencies.get(snapshot)?.files.add('dss-coop/' + path)
    return this.repository.readBytes(this.native(snapshot), 'dss-coop/' + path).then(bytes => {
      observedFileBytes(this.observationOwners.get(snapshot) ?? snapshot, path, bytes)
      return bytes
    })
  }
  async list(snapshot: FilesSnapshot, prefix: string, selection?: FileListSelection): Promise<FileEntry[]> {
    const native = this.native(snapshot), logical = directoryPrefix(prefix), remote = 'dss-coop/' + logical
    this.dependencies.get(snapshot)?.lists.push({ prefix: remote, recursive: true, ...(selection ? { selection: structuredClone(selection) } : {}) })
    let selectedEntries: Array<[string, string]>
    if (selection?.archiveScope || selection?.pathSegments) {
      // Exclude unrelated subtrees before traversal. The dependency verifier
      // uses the same archive boundary or exact command-path structure.
      selectedEntries = []
      const visit = async (directory: string): Promise<void> => {
        for (const entry of await this.repository.listDirectory(native, directory)) {
          const logicalPath = entry.path.slice('dss-coop/'.length)
          if (entry.type === 'tree') {
            if (mayContainSelectedFiles(logicalPath, selection)) await visit(entry.path)
          }
          else if (entry.type === 'blob') selectedEntries.push([entry.path, entry.sha])
        }
      }
      await visit(remote)
    } else {
      await this.repository.list(native, remote)
      selectedEntries = [...native.files].filter(([path]) => path.startsWith(remote))
    }
    const result = selectedEntries.map(([path, version]) => ({
      path: path.slice('dss-coop/'.length), version,
      ...(version === createHash(version.length === 64 ? 'sha256' : 'sha1').update('blob 0\0').digest('hex') ? { bytes: 0, empty: true } : { empty: false }),
    })).filter(entry => matchesFileSelection(entry.path, selection)).sort((a, b) => a.path.localeCompare(b.path))
    observedFileList(this.observationOwners.get(snapshot) ?? snapshot, 'list', logical + fileSelectionKey(selection), result)
    return result
  }
  async listDirectory(snapshot: FilesSnapshot, prefix: string, selection?: FileListSelection): Promise<FileEntry[]> {
    this.dependencies.get(snapshot)?.lists.push({ prefix: 'dss-coop/' + directoryPrefix(prefix), recursive: false, ...(selection ? { selection: structuredClone(selection) } : {}) })
    const entries = await this.repository.listDirectory(this.native(snapshot), 'dss-coop/' + directoryPrefix(prefix))
    const result = entries.filter(entry => entry.type === 'blob').map(entry => ({
      path: entry.path.slice('dss-coop/'.length), version: entry.sha,
      ...(entry.size === undefined ? {} : { bytes: entry.size }),
      empty: entry.size === 0 || entry.sha === createHash(entry.sha.length === 64 ? 'sha256' : 'sha1').update('blob 0\0').digest('hex'),
    })).filter(entry => matchesFileSelection(entry.path, selection)).sort((a, b) => a.path.localeCompare(b.path))
    observedFileList(this.observationOwners.get(snapshot) ?? snapshot, 'directory', directoryPrefix(prefix) + fileSelectionKey(selection), result)
    return result
  }
  private readonly discoveryIndexes = new Map<string, GitDirectoryIndex>()
  private readonly discoveryEntries = new WeakMap<object, readonly FileEntry[]>()
  /** Host discovery only. These candidates are not publication dependencies;
   * callers read selected business paths normally and reevaluate on conflict. */
  async discoverDirectory(snapshot: FilesSnapshot, prefix: string, recursive = true): Promise<readonly FileEntry[]> {
    const native = this.native(snapshot), remote = 'dss-coop/' + directoryPrefix(prefix)
    if (!this.repository.directoryIndex) {
      if (recursive) {
        await this.repository.list(native, remote)
        return Object.freeze([...native.files].filter(([path]) => path.startsWith(remote)).map(([path, version]) => Object.freeze({ path: path.slice('dss-coop/'.length), version })))
      }
      return Object.freeze((await this.repository.listDirectory(native, remote)).filter(entry => entry.type === 'blob')
        .map(entry => Object.freeze({ path: entry.path.slice('dss-coop/'.length), version: entry.sha })))
    }
    const key = JSON.stringify([remote, recursive])
    const index = await this.repository.directoryIndex(native, remote, this.discoveryIndexes.get(key), { recursive })
    // Completion order need not match HEAD order. Every returned view still
    // belongs to its requested snapshot; the next call reconciles that view.
    this.discoveryIndexes.set(key, index)
    const membership = index.directory ?? index
    let entries = this.discoveryEntries.get(membership)
    if (!entries) {
      entries = Object.freeze(index.entries.filter(entry => entry.type === 'blob').map(entry => Object.freeze({
        path: entry.path.slice('dss-coop/'.length), version: entry.sha,
        empty: entry.sha === createHash(entry.sha.length === 64 ? 'sha256' : 'sha1').update('blob 0\0').digest('hex'),
      })))
      this.discoveryEntries.set(membership, entries)
    }
    return entries
  }
  /** Read a changed candidate once to maintain the disposable Host index.
   * A selected record is subsequently read with read()/getAt() before writing. */
  readDiscovery(snapshot: FilesSnapshot, path: string): Promise<string | undefined> {
    return this.repository.read(this.native(snapshot), 'dss-coop/' + filePath(path))
  }
  async prepare(snapshot: FilesSnapshot, changes: readonly FileChange[], message: string): Promise<GitCommitOperation> {
    validateChanges(changes)
    const native = this.native(snapshot)
    const operation = this.repository.prepareCommit(native, changes.map(change => ({ ...change, path: 'dss-coop/' + change.path })), message)
    const captured = structuredClone(operation), release = this.retainOperation(operation.id)
    try {
      await this.operations.save({ operation })
      this.native(snapshot) // A released snapshot cannot regain preparation ownership.
      const prepared = this.preparedOperations.get(snapshot) ?? new Map()
      prepared.get(operation.id)?.release?.()
      prepared.set(operation.id, { original: operation, captured, release })
      this.preparedOperations.set(snapshot, prepared)
      return operation
    } catch (error) { this.operations.retire?.(operation.id, true); release?.(); throw error }
  }
  async commitPrepared(snapshot: FilesSnapshot, changes: readonly FileChange[], message: string, id: string, options?: FileCommitOptions): Promise<FileReceipt> {
    const releases = [this.retainOperation(id)]
    try { return await this.commitPreparedOwned(snapshot, changes, message, id, options, releases) }
    finally { for (const release of releases) release?.() }
  }
  private async commitPreparedOwned(snapshot: FilesSnapshot, changes: readonly FileChange[], message: string, id: string,
    options: FileCommitOptions | undefined, releases: Array<(() => void) | undefined>): Promise<FileReceipt> {
    const record = await this.operations.get(id)
    if (!record) throw new Error('No persisted operation: ' + id)
    const native = this.native(snapshot), prepared = this.preparedOperations.get(snapshot)
    const preparation = prepared?.get(id), fresh = preparation?.consumed ? undefined : preparation
    // Freshness is single-use, while the preparation's snapshot remains a real
    // owner for another already-prepared caller using this same snapshot.
    if (preparation) preparation.consumed = true
    const operation = fresh && !record.resolution
      && isDeepStrictEqual(fresh.captured, record.operation) && isDeepStrictEqual(fresh.captured, fresh.original)
      ? fresh.original : record.operation
    const captured = changes.map(change => change.bytes !== undefined ? { path: 'dss-coop/' + change.path, bytes: Buffer.from(change.bytes) } : { path: 'dss-coop/' + change.path, content: change.content, ...(change.deleteTree ? { deleteTree: true as const } : {}) })
    const tracked = this.dependencies.get(snapshot)
    const dependencies: GitReadDependencies | undefined = tracked
      ? { files: [...new Set([...tracked.files, ...captured.map(change => change.path)])].sort(), lists: structuredClone(tracked.lists) } : undefined
    let settledHead = record.resolution?.status === 'conflict' ? record.resolution.head : undefined
    if (settledHead !== undefined) {
      // A settled rejection is not dispatched again. Validate its immutable
      // payload/scope before using the same dependency reparent path below.
      const checked = this.repository.prepareCommit(native, captured, message)
      if (checked.id !== operation.id || checked.requestHash !== operation.requestHash
        || checked.expectedHead !== operation.expectedHead || checked.repositoryId !== operation.repositoryId
        || checked.repository !== operation.repository || checked.branch !== operation.branch
        || checked.directory !== operation.directory || checked.authorId !== operation.authorId
        || !isDeepStrictEqual(checked.writes, operation.writes)) throw new Error('Prepared Git operation was reused for different input or snapshot.')
    }
    // Original snapshot and payload remain immutable. Only a settled conflict
    // may produce a new persisted transport attempt at another parent.
    let current = native, attempt = operation, owned: GitSnapshot | undefined, predecessor: GitCommitOperation | undefined
    try {
      for (;;) {
        try { await options?.beforeAttempt?.() }
        catch (error) {
          // This replacement has never entered the native dispatcher. Its
          // owner still points at the proven conflict, so cancellation cannot
          // turn a later disconnect into a retry of an unstarted running beat.
          if (predecessor) { try { if (this.operations.retire) this.operations.retire(attempt.id, true); else await this.operations.delete?.(attempt.id) } catch { /* Undispatched metadata can be retained. */ } predecessor = undefined }
          throw error
        }
        const retiring = predecessor
        if (retiring) {
          try { options?.onAttempt?.(attempt) }
          catch (error) { options?.onAttempt?.(retiring); if (this.operations.retire) this.operations.retire(attempt.id, true); else await this.operations.delete?.(attempt.id); throw error }
          predecessor = undefined
        }
        try {
          try {
            if (settledHead !== undefined) throw new FilesConflictError(attempt.expectedHead)
            return await this.dispatch(current, captured, message, attempt, options?.resumeUnsent)
          }
          finally {
            // Retention only: the predecessor is already a proven conflict.
            // Failed reclamation must not relabel the actual attempt outcome.
            if (retiring) { try { await this.operations.delete?.(retiring.id) } catch { /* Keep the resolved metadata. */ } }
          }
        }
        catch (error) {
          if (!(error instanceof FilesConflictError)) throw error
          // This attempt is proven rejected; owners still holding its metadata
          // can resolve/reparent normally before its final reference is released.
          this.operations.retire?.(attempt.id)
          const cause = error.cause
          const provenHead = settledHead; settledHead = undefined
          let next = provenHead ? await this.repository.at(provenHead) : this.repository.takeConflictSnapshot?.(cause)
          if (!dependencies || !this.repository.dependenciesEqual) {
            if (next) this.repository.releaseSnapshot?.(next)
            throw error
          }
          // The native local contention hint has no remote observation. Acquire
          // one normally; all other proven conflicts reuse the push advertisement.
          next ??= await this.repository.snapshot()
          try {
            if (options?.replayReceipt) {
              const body = await this.repository.read(next, 'dss-coop/' + filePath(options?.replayReceipt.path))
              if (body !== undefined) {
                if (body !== options?.replayReceipt.content) throw new Error('A native command identity cannot be reused with different arguments.')
                this.operations.retire?.(attempt.id)
                return { revision: next.head, replay: true }
              }
            }
            if (options?.reevaluateOnConflict || !await this.repository.dependenciesEqual(native, next, dependencies)) {
              await this.operations.save({ operation: attempt, resolution: { status: 'conflict', head: next.head } })
              this.conflictSnapshots.set(error, next); next = undefined
              throw error
            }
            // Unchanged dependencies retain the original command and output.
            // A Git parent change is not a business retry; live cancellation
            // and connection ownership still bound every publication attempt.
            await options?.beforeAttempt?.()
            await this.operations.save({ operation: attempt, resolution: { status: 'conflict', head: next.head } })
            const replacement = this.repository.prepareCommit(next, captured, message)
            releases.push(this.retainOperation(replacement.id))
            await this.operations.save({ operation: replacement })
            predecessor = attempt
            if (owned) this.repository.releaseSnapshot?.(owned)
            current = owned = next; next = undefined
            attempt = replacement
          } finally { if (next) this.repository.releaseSnapshot?.(next) }
        }
      }
    } finally { if (owned) this.repository.releaseSnapshot?.(owned) }
  }
  async commit(snapshot: FilesSnapshot, changes: readonly FileChange[], message: string, options?: FileCommitOptions): Promise<FileReceipt> {
    const operation = await this.prepare(snapshot, changes, message)
    return this.commitPrepared(snapshot, changes, message, operation.id, options)
  }
  private async dispatch(native: GitSnapshot, changes: readonly FileChange[], message: string,
    operation: GitCommitOperation, resumeUnsent?: true): Promise<FileReceipt> {
    let receipt: FileReceipt
    try {
      const onDispatch = () => this.operations.markDispatched?.(operation.id)
      // Other repository implementations keep their conservative entry semantics.
      if (!this.repository.reportsCommitDispatch) onDispatch()
      if (resumeUnsent && !this.repository.resumesUnsentCommits) throw new GitCommitOutcomeUnknownError(operation)
      const result = await this.repository.commitPrepared(native, changes, message, operation, onDispatch,
        resumeUnsent ? () => this.operations.isUndispatched?.(operation.id) === true : undefined)
      receipt = { revision: result.commit, replay: result.replay, operationId: operation.id }
    } catch (error) {
      if (error instanceof GitConflictError) throw new FilesConflictError(operation.expectedHead, { cause: error })
      if (error instanceof GitCommitOutcomeUnknownError) throw new FilesOutcomeUnknownError(operation.id, { cause: error })
      throw error
    }
    await this.operations.save({ operation, resolution: { status: 'confirmed', commit: receipt.revision, head: receipt.revision } })
    this.operations.retire?.(operation.id)
    return receipt
  }
  /** Low-level transport replay without business dependency metadata. Actual
   * owners restore their captured reads and use commitPrepared instead. */
  async retryPrepared(id: string, changes: readonly FileChange[], message: string): Promise<FileReceipt> {
    validateChanges(changes)
    const release = this.retainOperation(id)
    try {
      const record = await this.operations.get(id)
      if (!record) throw new Error('No persisted operation: ' + id)
      const native = await this.repository.at(record.operation.expectedHead)
      const remote = changes.map(change => ({ ...change, path: 'dss-coop/' + change.path }))
      try { return await this.dispatch(native, remote, message, record.operation) } finally { this.repository.releaseSnapshot?.(native) }
    } finally { release?.() }
  }
  /** Check a persisted uncertain operation before deciding whether to retry or re-evaluate. */
  async resolve(id: string): Promise<GitCommitResolution> {
    const release = this.retainOperation(id)
    try {
      const record = await this.operations.get(id)
      if (!record) throw new Error('No persisted operation: ' + id)
      const resolution = await this.repository.resolveCommit(record.operation)
      await this.operations.save({ operation: record.operation, resolution })
      if (resolution.status === 'confirmed') this.operations.retire?.(id)
      return resolution
    } finally { release?.() }
  }
}
