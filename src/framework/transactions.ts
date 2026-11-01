import { createHash } from 'node:crypto'
import type { GitSnapshot } from '../experimental/private-git/contracts.js'
import { GitConflictError } from '../experimental/private-git/github.js'
import { GitHubRepository, GitCommitOutcomeUnknownError, type GitCommitOperation, type GitCommitResolution } from '../experimental/private-git/git-repository.js'

export type FileChange = { path: string; content: string | null; bytes?: never } | { path: string; bytes: Uint8Array; content?: never }
export interface FileEntry { path: string; version: string; bytes?: number; empty?: boolean }
export interface FilesSnapshot { readonly revision: string; release(): Promise<void> }
export interface FileReceipt { revision: string; replay: boolean; operationId?: string }
export interface FilesStore {
  snapshot(): Promise<FilesSnapshot>
  read(snapshot: FilesSnapshot, path: string): Promise<string | undefined>
  readBytes(snapshot: FilesSnapshot, path: string): Promise<Uint8Array | undefined>
  list(snapshot: FilesSnapshot, prefix: string): Promise<FileEntry[]>
  listDirectory(snapshot: FilesSnapshot, prefix: string): Promise<FileEntry[]>
  commit(snapshot: FilesSnapshot, changes: readonly FileChange[], message: string): Promise<FileReceipt>
}
export class FilesConflictError extends Error {
  constructor(readonly expectedRevision: string, options?: ErrorOptions) {
    super('Storage changed since the checked snapshot; read and evaluate the business conditions again.', options)
    this.name = 'FilesConflictError'
  }
}
export class FilesOutcomeUnknownError extends Error {
  constructor(readonly operationId: string, options?: ErrorOptions, readonly confirmed?: FileReceipt) {
    super(confirmed ? 'Commit succeeded but its local receipt could not be saved; retain the operation identity.'
      : 'Commit result is uncertain; resolve the same persisted operation before retrying.', options)
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
    if (change.bytes !== undefined ? !(change.bytes instanceof Uint8Array) || change.content !== undefined : typeof change.content !== 'string' && change.content !== null) throw new Error('A change must carry text, bytes, or a deletion, never mixed representations.')
    if (paths.has(change.path)) throw new Error('A transaction cannot write the same path twice: ' + change.path)
    paths.add(change.path)
  }
}
export async function withSnapshot<T>(store: FilesStore, operation: (snapshot: FilesSnapshot) => Promise<T>): Promise<T> {
  const snapshot = await store.snapshot()
  try { return await operation(snapshot) } finally { await snapshot.release() }
}
export interface GitOperationRecord {
  operation: GitCommitOperation
  resolution?: GitCommitResolution
}
/** Only operation identities and content hashes are persisted locally, never Git business bodies. */
export interface GitOperationStore {
  save(record: GitOperationRecord): Promise<void>
  get(id: string): Promise<GitOperationRecord | undefined>
  list(): Promise<GitOperationRecord[]>
}

/** Maps logical paths once; the repository remains the authority for Git content and CAS. */
export class GitFiles implements FilesStore {
  private readonly snapshots = new WeakMap<FilesSnapshot, GitSnapshot>()
  constructor(readonly repository: GitHubRepository, readonly operations: GitOperationStore) {}
  private wrap(native: GitSnapshot): FilesSnapshot {
    const snapshot: FilesSnapshot = { revision: native.head, release: async () => { this.snapshots.delete(snapshot) } }
    this.snapshots.set(snapshot, native)
    return snapshot
  }
  async snapshot(): Promise<FilesSnapshot> { return this.wrap(await this.repository.snapshot()) }
  async at(revision: string): Promise<FilesSnapshot> { return this.wrap(await this.repository.at(revision)) }
  private native(snapshot: FilesSnapshot): GitSnapshot {
    const native = this.snapshots.get(snapshot)
    if (!native) throw new Error('Snapshot was released or belongs to another store.')
    return native
  }
  read(snapshot: FilesSnapshot, path: string): Promise<string | undefined> {
    return this.repository.read(this.native(snapshot), 'dss-coop/' + filePath(path))
  }
  readBytes(snapshot: FilesSnapshot, path: string): Promise<Uint8Array | undefined> {
    return this.repository.readBytes(this.native(snapshot), 'dss-coop/' + filePath(path))
  }
  async list(snapshot: FilesSnapshot, prefix: string): Promise<FileEntry[]> {
    const native = this.native(snapshot), logical = directoryPrefix(prefix), remote = 'dss-coop/' + logical
    await this.repository.list(native, remote)
    return [...native.files].filter(([path]) => path.startsWith(remote)).map(([path, version]) => ({
      path: path.slice('dss-coop/'.length), version,
      ...(version === createHash(version.length === 64 ? 'sha256' : 'sha1').update('blob 0\0').digest('hex') ? { bytes: 0, empty: true } : { empty: false }),
    })).sort((a, b) => a.path.localeCompare(b.path))
  }
  async listDirectory(snapshot: FilesSnapshot, prefix: string): Promise<FileEntry[]> {
    const entries = await this.repository.listDirectory(this.native(snapshot), 'dss-coop/' + directoryPrefix(prefix))
    return entries.filter(entry => entry.type === 'blob').map(entry => ({
      path: entry.path.slice('dss-coop/'.length), version: entry.sha,
      ...(entry.size === undefined ? {} : { bytes: entry.size }),
      empty: entry.size === 0 || entry.sha === createHash(entry.sha.length === 64 ? 'sha256' : 'sha1').update('blob 0\0').digest('hex'),
    })).sort((a, b) => a.path.localeCompare(b.path))
  }
  async prepare(snapshot: FilesSnapshot, changes: readonly FileChange[], message: string): Promise<GitCommitOperation> {
    validateChanges(changes)
    const native = this.native(snapshot)
    const operation = this.repository.prepareCommit(native, changes.map(change => ({ ...change, path: 'dss-coop/' + change.path })), message)
    await this.operations.save({ operation })
    return operation
  }
  async commitPrepared(snapshot: FilesSnapshot, changes: readonly FileChange[], message: string, id: string): Promise<FileReceipt> {
    const record = await this.operations.get(id)
    if (!record) throw new Error('No persisted operation: ' + id)
    return this.dispatch(this.native(snapshot), changes.map(change => ({ ...change, path: 'dss-coop/' + change.path })), message, record.operation)
  }
  async commit(snapshot: FilesSnapshot, changes: readonly FileChange[], message: string): Promise<FileReceipt> {
    const operation = await this.prepare(snapshot, changes, message)
    return this.commitPrepared(snapshot, changes, message, operation.id)
  }
  private async dispatch(native: GitSnapshot, changes: readonly FileChange[], message: string,
    operation: GitCommitOperation): Promise<FileReceipt> {
    let receipt: FileReceipt
    try {
      const result = await this.repository.commitPrepared(native, changes, message, operation)
      receipt = { revision: result.commit, replay: result.replay, operationId: operation.id }
    } catch (error) {
      if (error instanceof GitConflictError) throw new FilesConflictError(operation.expectedHead, { cause: error })
      if (error instanceof GitCommitOutcomeUnknownError) throw new FilesOutcomeUnknownError(operation.id, { cause: error })
      throw error
    }
    try {
      await this.operations.save({ operation, resolution: { status: 'confirmed', commit: receipt.revision, head: receipt.revision } })
    } catch (error) { throw new FilesOutcomeUnknownError(operation.id, { cause: error }, receipt) }
    return receipt
  }
  /** Explicit retry uses the original operation and snapshot, never a replacement identity. */
  async retryPrepared(id: string, changes: readonly FileChange[], message: string): Promise<FileReceipt> {
    validateChanges(changes)
    const record = await this.operations.get(id)
    if (!record) throw new Error('No persisted operation: ' + id)
    const native = await this.repository.at(record.operation.expectedHead)
    const remote = changes.map(change => ({ ...change, path: 'dss-coop/' + change.path }))
    return this.dispatch(native, remote, message, record.operation)
  }
  /** Check a persisted uncertain operation before deciding whether to retry or re-evaluate. */
  async resolve(id: string): Promise<GitCommitResolution> {
    const record = await this.operations.get(id)
    if (!record) throw new Error('No persisted operation: ' + id)
    const resolution = await this.repository.resolveCommit(record.operation)
    await this.operations.save({ operation: record.operation, resolution })
    return resolution
  }
}
