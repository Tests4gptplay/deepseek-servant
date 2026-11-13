import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { fileReadFingerprint, observesFileReads } from './file-read-observation.js'
import { fileSelectionKey, type FileListSelection } from './file-list-selection.js'
import { canonicalLocalLocation } from './local-location.js'
import { localFilesWorkerSource } from './local-files-worker.js'
import { directoryPrefix, filePath, FilesConflictError, validateChanges,
  type FileChange, type FileEntry, type FileReceipt, type FilesSnapshot, type FilesStore, type FileReadPlan,
  type GitOperationRecord, type GitOperationStore } from './transactions.js'
import type { GitOperationChannel } from '../experimental/private-git/contracts.js'

interface DatabaseIdentity { dev: string; ino: string }
type ReaderLane = 'read' | 'foreground-read' | 'refresh' | 'host-poll' | 'write' | 'foreground-write'
interface RemoteError { name: string; message: string; stack?: string; code?: string; errcode?: number; errstr?: string; expectedRevision?: string }
const fromWorker = (value: RemoteError): Error => {
  const error = value.name === 'FilesConflictError' ? new FilesConflictError(value.expectedRevision!)
    : value.name === 'LocalCommitOutcomeUnknownError' ? new LocalCommitOutcomeUnknownError(value.message) : new Error(value.message)
  if (value.name !== 'FilesConflictError') error.name = value.name
  if (value.stack) error.stack = value.stack
  for (const key of ['code', 'errcode', 'errstr'] as const) if (value[key] !== undefined) Object.assign(error, { [key]: value[key] })
  return error
}
/** Loss of a writer acknowledgement is not proof that SQLite rolled back. The
 * command's existing atomic receipt remains the recovery authority after reopen. */
export class LocalCommitOutcomeUnknownError extends Error {
  constructor(cause: unknown) { super('Local writer ended before acknowledging the commit. Reopen storage and resolve the same command; its write outcome is unknown.', { cause }); this.name = 'LocalCommitOutcomeUnknownError' }
}
class LocalWorker {
  readonly worker: Worker
  readonly ready: Promise<void>
  readonly exited: Promise<void>
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void; method: string }>()
  private sequence = 0
  private failure?: Error
  private closing?: Promise<void>
  threadId?: number
  databaseIdentity?: DatabaseIdentity
  constructor(databasePath: string, writer: boolean, options: { requireExisting?: boolean; databaseIdentity?: DatabaseIdentity } = {}) {
    this.worker = new Worker(localFilesWorkerSource, { eval: true, workerData: { databasePath, writer, ...options }, name: writer ? 'dss-local-writer' : 'dss-local-reader' })
    let ready!: () => void, failed!: (reason: unknown) => void
    this.ready = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject })
    // Lazy readers can fail before the first awaited request reaches ready.
    void this.ready.catch(() => {})
    const fail = (error: Error) => {
      this.failure ??= error; failed(this.failure)
      for (const item of this.pending.values()) item.reject(item.method === 'commit' ? new LocalCommitOutcomeUnknownError(this.failure) : this.failure)
      this.pending.clear()
    }
    this.worker.on('error', fail)
    this.exited = new Promise(resolve => this.worker.once('exit', code => {
      if (code !== 0 || this.pending.size || !this.closing) fail(new Error('Local SQLite worker exited with code ' + code + '.'))
      resolve()
    }))
    this.worker.on('message', (message: { ready?: boolean; startupError?: RemoteError; threadId?: number; databaseIdentity?: DatabaseIdentity; id?: number; result?: unknown; error?: RemoteError }) => {
      if (message.startupError) { fail(fromWorker(message.startupError)); return }
      if (message.ready) { this.threadId = message.threadId; this.databaseIdentity = message.databaseIdentity; ready(); return }
      const item = this.pending.get(message.id!)
      if (!item) return
      this.pending.delete(message.id!)
      if (message.error) item.reject(fromWorker(message.error)); else item.resolve(message.result)
    })
  }
  async request<T>(method: string, args: unknown = {}, signal?: AbortSignal): Promise<T> {
    await this.ready
    signal?.throwIfAborted()
    if (this.failure) throw this.failure
    const cancellation = signal ? new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT) : undefined
    const abort = () => { if (cancellation) Atomics.store(new Int32Array(cancellation), 0, 1) }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      const result = await new Promise<T>((resolve, reject) => {
        const id = ++this.sequence
        this.pending.set(id, { resolve: value => resolve(value as T), reject, method })
        try { this.worker.postMessage({ id, method, args, cancellation }) }
        catch (error) { this.pending.delete(id); reject(error) }
      })
      // Snapshot cancellation after its reply is released by LocalFiles.snapshot.
      return result
    } catch (error) { if (signal?.aborted) throw signal.reason; throw error }
    finally { signal?.removeEventListener('abort', abort) }
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      try { await this.request('close'); await this.exited }
      catch (error) { await this.worker.terminate(); await this.exited; throw error }
    })()
  }
}
class LocalDatabase {
  readonly writer: LocalWorker
  // Access may delegate a foreground command to the runtime handle for this
  // same database. Preserve that async context without crossing database scopes
  // or joining concurrent foreground/background operations to one queue.
  readonly channel = new AsyncLocalStorage<GitOperationChannel>()
  private readonly readers = new Map<ReaderLane, LocalWorker>()
  private checkpointPending?: object
  constructor(readonly path: string, requireExisting: boolean) { this.writer = new LocalWorker(path, true, { requireExisting }) }
  write<T>(method: 'commit' | 'operationSave', args: unknown): Promise<T> {
    // A release can race the writer reply. Record admitted writes before sending
    // so that the last reader's release also covers an unacknowledged COMMIT.
    this.checkpointPending = {}
    return this.writer.request<T>(method, args)
  }
  async checkpointReleasedReader(): Promise<void> {
    const pending = this.checkpointPending
    if (!pending) return
    // Keep pending while in flight: another reader may be the last release that
    // lets a partial checkpoint finish. A new write replaces this token so an old
    // reply cannot clear its work. Read-only leases need no writer round trip.
    try {
      const complete = await this.writer.request<boolean>('checkpoint')
      if (complete && this.checkpointPending === pending) this.checkpointPending = undefined
    } catch (cause) {
      // Maintenance cannot change an acknowledged command's outcome. Keep the
      // failure visible and retry only at a later owned reader-release boundary.
      const warning = new Error('Local SQLite checkpoint failed; committed records remain authoritative and WAL reuse will be retried after a later snapshot release: ' + (cause instanceof Error ? cause.message : String(cause)), { cause })
      Object.assign(warning, { code: 'DSS_LOCAL_CHECKPOINT_FAILED' })
      process.emitWarning(warning)
    }
  }
  reader(lane: ReaderLane): LocalWorker {
    let reader = this.readers.get(lane)
    if (!reader) { reader = new LocalWorker(this.path, false, { databaseIdentity: this.writer.databaseIdentity }); this.readers.set(lane, reader) }
    return reader
  }
  async close(): Promise<void> {
    const results = await Promise.allSettled([...this.readers.values(), this.writer].map(worker => worker.close()))
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'Local SQLite workers did not close cleanly.')
  }
}
interface DatabaseOwner { database: LocalDatabase; references: number; closing?: Promise<void> }
// One physical SQLite writer per canonical database in this Host. Access and
// background owners share resources, never snapshot identities or read queues.
const databases = new Map<string, DatabaseOwner>()
// Remember successful opens for this process, even after workers close. This
// prevents a later open from treating a removed known database as a new install.
const knownDatabases = new Set<string>()
type ReadDependency = { kind: 'file'; path: string; version?: string | null }
  | { kind: 'list' | 'listDirectory'; prefix: string; selection?: FileListSelection; namesOnly?: boolean; entries?: Array<[string, string]> }
interface Lease { dependencies: Map<string, ReadDependency>; id: string; worker: LocalWorker; revision?: string; signal?: AbortSignal; released?: boolean; release?: Promise<void> }

/** SQLite's existing files/metadata/receipt format, WAL snapshots and atomic CAS
 * remain unchanged. Synchronous SQL, encoding and hashing run only in workers. */
export class LocalFiles implements FilesStore {
  private readonly snapshots = new Map<FilesSnapshot, Lease>()
  private readonly accepted = new Set<Promise<unknown>>()
  private closed = false
  private closing?: Promise<void>
  private constructor(readonly directory: string, readonly databasePath: string, private readonly owner: DatabaseOwner) {}
  static async open(directory: string, options: { requireExisting?: boolean } = {}): Promise<LocalFiles> {
    const root = await canonicalLocalLocation(directory, true), databasePath = join(root, 'dss-files.sqlite')
    let owner = databases.get(databasePath)
    let createdOwner = false
    if (owner?.closing) { await owner.closing; return this.open(root, options) }
    if (!owner) {
      const requireExisting = options.requireExisting === true || knownDatabases.has(databasePath)
      // mkdir is appropriate only for a genuinely new store. It cannot recover
      // deleted SQLite contents, sidecars or an active unlinked writer.
      if (!requireExisting) await mkdir(root, { recursive: true })
      owner = databases.get(databasePath)
      if (!owner) {
        owner = { database: new LocalDatabase(databasePath, requireExisting), references: 0 }
        databases.set(databasePath, owner)
        createdOwner = true
      }
    }
    owner.references++
    try {
      await owner.database.writer.ready
      // A new worker confirms its final physical identity before ready. A later
      // owner still checks afresh rather than trusting that earlier handshake.
      if (!createdOwner) await owner.database.writer.request('verify')
      knownDatabases.add(databasePath)
      return new LocalFiles(root, databasePath, owner)
    }
    catch (error) {
      if (!--owner.references) { databases.delete(databasePath); await owner.database.close().catch(() => {}) }
      throw error
    }
  }
  private assertOpen(): void { if (this.closed) throw new Error('Local file storage is closed.') }
  private own<T>(action: () => Promise<T>): Promise<T> {
    let result: Promise<T>
    try { this.assertOpen(); result = action() } catch (error) { return Promise.reject(error) }
    this.accepted.add(result)
    void result.finally(() => this.accepted.delete(result)).catch(() => {})
    return result
  }
  async withChannel<T>(channel: GitOperationChannel, operation: () => Promise<T>): Promise<T> {
    this.assertOpen()
    if (!['read', 'write', 'foreground-read', 'foreground-write', 'refresh', 'host-poll', 'host-poll-write'].includes(channel)) throw new Error('Unknown Local operation channel.')
    return this.owner.database.channel.run(channel, operation)
  }
  withWriteOperation<T>(operation: () => Promise<T>): Promise<T> {
    const channel = this.owner.database.channel.getStore()
    return this.withChannel(channel?.startsWith('foreground-') ? 'foreground-write' : channel === 'host-poll-write' ? 'host-poll-write' : 'write', operation)
  }
  private readerLane(): ReaderLane {
    const channel = this.owner.database.channel.getStore()
    // Write predicates are reads, not SQLite's atomic writer. A large background
    // predicate must not occupy either foreground predicates or COMMIT dispatch.
    if (channel === 'foreground-write' || channel === 'write') return channel
    return channel?.startsWith('foreground-') ? 'foreground-read' : channel?.startsWith('host-poll') ? 'host-poll' : channel === 'refresh' ? 'refresh' : 'read'
  }
  snapshot(plan?: FileReadPlan): Promise<FilesSnapshot> {
    return this.own(async () => {
      plan?.signal?.throwIfAborted()
      const lease: Lease = { id: randomUUID(), worker: this.owner.database.reader(this.readerLane()), signal: plan?.signal, dependencies: new Map() }
      const { revision } = await lease.worker.request<{ revision: string }>('snapshot', { id: lease.id }, plan?.signal)
      lease.revision = revision
      const snapshot: FilesSnapshot = { revision, release: () => this.release(snapshot, lease) }
      this.snapshots.set(snapshot, lease)
      if (plan?.signal?.aborted) { await snapshot.release(); plan.signal.throwIfAborted() }
      return snapshot
    })
  }
  private release(snapshot: FilesSnapshot, lease: Lease): Promise<void> {
    if (lease.release) return lease.release
    lease.released = true
    return lease.release = lease.worker.request<void>('release', { id: lease.id })
      .then(() => this.owner.database.checkpointReleasedReader())
      .finally(() => this.snapshots.delete(snapshot))
  }
  private reader(snapshot: FilesSnapshot): Lease {
    this.assertOpen()
    const lease = this.snapshots.get(snapshot)
    if (!lease || lease.released) throw new Error('Snapshot was released or belongs to another store.')
    if (lease.revision !== snapshot.revision) throw new Error('Snapshot revision changed after acquisition.')
    lease.signal?.throwIfAborted()
    return lease
  }
  private readValue<T>(snapshot: FilesSnapshot, path: string, method: 'read' | 'readBytes'): Promise<T | undefined> {
    return this.own(async () => {
      const lease = this.reader(snapshot), checked = filePath(path)
      const key = 'file:' + checked
      if (!lease.dependencies.has(key)) lease.dependencies.set(key, { kind: 'file', path: checked })
      const result = await lease.worker.request<{ value: T | undefined; version: string | null }>(method, { id: lease.id, path: checked }, lease.signal)
      lease.signal?.throwIfAborted()
      lease.dependencies?.set('file:' + checked, { kind: 'file', path: checked, version: result.version })
      fileReadFingerprint(snapshot, 'file:' + checked, result.version ?? 'absent')
      return result.value
    })
  }
  read(snapshot: FilesSnapshot, path: string): Promise<string | undefined> { return this.readValue(snapshot, path, 'read') }
  readBytes(snapshot: FilesSnapshot, path: string): Promise<Uint8Array | undefined> { return this.readValue(snapshot, path, 'readBytes') }
  private listEntries(snapshot: FilesSnapshot, prefix: string, method: 'list' | 'listDirectory', selection?: FileListSelection): Promise<FileEntry[]> {
    return this.own(async () => {
      const lease = this.reader(snapshot), checked = directoryPrefix(prefix), selected = selection && structuredClone(selection)
      const key = (method === 'list' ? 'list:' : 'directory:') + checked + fileSelectionKey(selected)
      if (!lease.dependencies.has(key)) lease.dependencies.set(key, { kind: method, prefix: checked, ...(selected ? { selection: selected } : {}) })
      const result = await lease.worker.request<{ value: FileEntry[]; fingerprint?: string }>(method, { id: lease.id, prefix: checked, selection: selected, observe: observesFileReads(snapshot) }, lease.signal)
      lease.signal?.throwIfAborted()
      lease.dependencies?.set(key, { kind: method, prefix: checked, ...(selected ? { selection: selected } : {}), entries: result.value.map(entry => [entry.path, entry.version]) })
      if (result.fingerprint !== undefined) fileReadFingerprint(snapshot, key, result.fingerprint)
      return result.value
    })
  }
  list(snapshot: FilesSnapshot, prefix: string, selection?: FileListSelection): Promise<FileEntry[]> { return this.listEntries(snapshot, prefix, 'list', selection) }
  listDirectory(snapshot: FilesSnapshot, prefix: string, selection?: FileListSelection): Promise<FileEntry[]> { return this.listEntries(snapshot, prefix, 'listDirectory', selection) }
  listDirectoryNames(snapshot: FilesSnapshot, prefix: string, selection?: FileListSelection): Promise<string[]> {
    return this.own(async () => {
      const lease = this.reader(snapshot), checked = directoryPrefix(prefix), selected = selection && structuredClone(selection)
      const key = 'names:' + checked + fileSelectionKey(selected)
      lease.dependencies.set(key, { kind: 'listDirectory', prefix: checked, namesOnly: true, ...(selected ? { selection: selected } : {}) })
      const rows = await lease.worker.request<FileEntry[]>('listNames', { id: lease.id, prefix: checked, selection: selected }, lease.signal)
      lease.signal?.throwIfAborted()
      lease.dependencies.set(key, { kind: 'listDirectory', prefix: checked, namesOnly: true, ...(selected ? { selection: selected } : {}), entries: rows.map(row => [row.path, '']) })
      fileReadFingerprint(snapshot, key, JSON.stringify(rows.map(row => row.path)))
      return rows.map(row => row.path)
    })
  }
  commit(snapshot: FilesSnapshot, changes: readonly FileChange[], _message: string): Promise<FileReceipt> {
    return this.own(async () => {
      const lease = this.reader(snapshot)
      validateChanges(changes)
      // Capture before awaiting worker startup/queueing. Transfers must not detach
      // caller-owned bytes, which the exact command may need after a lost reply.
      const captured = structuredClone(changes)
      for (const change of captured) if (!lease.dependencies.has('file:' + change.path)) lease.dependencies.set('file:' + change.path, { kind: 'file', path: change.path })
      const unresolved = [...lease.dependencies.entries()].filter(([, value]) => value.kind === 'file' ? value.version === undefined : value.entries === undefined)
      if (unresolved.length) {
        const resolved = await lease.worker.request<ReadDependency[]>('dependencies', { id: lease.id, dependencies: unresolved.map(([, value]) => value) }, lease.signal)
        resolved.forEach((value, index) => lease.dependencies.set(unresolved[index]![0], value))
      }
      // Already-admitted commits drain during close; only this lease's own
      // release/cancellation may stop it after metadata capture.
      lease.signal?.throwIfAborted()
      if (lease.released || lease.revision !== snapshot.revision) throw new Error('Snapshot was released or changed during publication.')
      return this.owner.database.write<FileReceipt>('commit', { revision: snapshot.revision, changes: captured, dependencies: structuredClone([...lease.dependencies.values()]) })
    })
  }
  readonly operations: GitOperationStore = {
    save: record => this.own(() => this.owner.database.write('operationSave', { record: structuredClone(record) })),
    get: id => this.own(() => this.owner.database.writer.request<GitOperationRecord | undefined>('operationGet', { id })),
    list: () => this.own(() => this.owner.database.writer.request<GitOperationRecord[]>('operationList')),
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    return this.closing = (async () => {
      // Already admitted reads/writes own their result. Disposal must not turn a
      // queued accepted commit into an unacknowledged worker termination.
      await Promise.allSettled([...this.accepted])
      const results = await Promise.allSettled([...this.snapshots].map(([snapshot, lease]) => this.release(snapshot, lease)))
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (!--this.owner.references) {
        const operation = this.owner.database.close()
        this.owner.closing = operation
        try { await operation } catch (error) { failures.push(error) }
        finally { if (databases.get(this.databasePath) === this.owner) databases.delete(this.databasePath) }
      }
      if (failures.length) throw new AggregateError(failures, 'Local storage did not close cleanly.')
    })()
  }
}
