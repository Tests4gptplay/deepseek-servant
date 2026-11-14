import { GitRecordIndex } from './git-record-index.js'
import type { GitReadDependencies } from '../experimental/private-git/contracts.js'
import { createHash } from 'node:crypto'
import type { StoragePort } from '../contracts/ports.js'
import { FilesConflictError, FilesOutcomeUnknownError, GitFiles, withSnapshot, withWriteOperation, withFileDependencies, type FileChange, type FilesSnapshot, type FilesStore, type FilesReadRound, type GitOperationRecord, type GitOperationStore } from './transactions.js'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const segment = (text: string) => encodeURIComponent(text).replaceAll('.', '%2E')
type PublicationGuard = () => void | Promise<void>
interface Envelope { version: 1; key: string; value: unknown }
export interface AuthorityContentFault { path: string; key?: string; value?: unknown; reason: string; contentVersion?: string }
export interface AuthorityDiscoveryKey { key?: string }
class AuthorityContentError extends Error {}
type ContentFaultHandler = (fault: AuthorityContentFault) => readonly string[] | void
/** Volatile transport reconciliation only. Command identity/result lives in Git.
 * This cache is never a restart authority and is cleared with its connection. */
export class SessionGitOperations implements GitOperationStore {
  private readonly rows = new Map<string, GitOperationRecord>()
  private readonly references = new Map<string, number>()
  private readonly retiring = new Map<string, 'unused' | 'settled'>()
  private readonly dispatched = new Set<string>()
  private closed = false
  constructor(private readonly confirmed?: (operationId: string) => void) {}
  async save(record: GitOperationRecord): Promise<void> {
    if (this.closed) return
    this.rows.set(record.operation.id, structuredClone(record)); this.releaseRetired(record.operation.id)
    if (record.resolution?.status === 'confirmed') this.confirmed?.(record.operation.id)
  }
  async get(id: string): Promise<GitOperationRecord | undefined> { return structuredClone(this.rows.get(id)) }
  async list(): Promise<GitOperationRecord[]> { return structuredClone([...this.rows.values()]) }
  /** References are local ownership only: they never queue or admit a write. */
  retain(id: string): () => void {
    if (this.closed) return () => {}
    this.references.set(id, (this.references.get(id) ?? 0) + 1)
    let released = false
    return () => {
      if (released || this.closed) return
      released = true
      const remaining = (this.references.get(id) ?? 1) - 1
      if (remaining) this.references.set(id, remaining)
      else this.references.delete(id)
      this.releaseRetired(id)
    }
  }
  isUndispatched(id: string): boolean {
    const row = this.rows.get(id)
    return !this.closed && this.references.has(id) && !!row && !this.dispatched.has(id)
      && (!row.resolution || row.resolution.status === 'pending')
  }
  markDispatched(id: string): void {
    if (this.closed) return
    this.dispatched.add(id)
    // Another owner may still dispatch the same preparation after one caller
    // abandoned it. Its uncertain outcome must then retain the original facts.
    if (this.retiring.get(id) === 'unused') this.retiring.delete(id)
  }
  retire(id: string, onlyUnsent = false): void {
    if (this.closed || onlyUnsent && this.dispatched.has(id)) return
    if (!onlyUnsent || !this.retiring.has(id)) this.retiring.set(id, onlyUnsent ? 'unused' : 'settled')
    this.releaseRetired(id)
  }
  private releaseRetired(id: string): void {
    if (this.retiring.has(id) && !this.references.has(id)) { this.rows.delete(id); this.retiring.delete(id); this.dispatched.delete(id) }
  }
  async delete(id: string): Promise<void> { this.retire(id) }
  clear(): void { this.rows.clear(); this.references.clear(); this.retiring.clear(); this.dispatched.clear() }
  close(): void { this.closed = true; this.clear() }
}
/** Remote authority, not a write-back mirror. Every acknowledged set is a Git CAS.
 * It deliberately bypasses FrameworkTransactions to avoid journal recursion. */
export class GitAuthorityStore implements StoragePort {
  private readonly writes = new Map<string, Promise<void>>()
  private readonly updates = new Set<Promise<unknown>>()
  private readonly ownedAttempts = new Map<string, { id: string; path: string; content: string; message: string; result: unknown; fingerprint: string; reads: GitReadDependencies; release?: () => void }>()
  private readonly ownedWrites = new Map<string, Promise<unknown>>()
  private readonly ownedContexts = new Map<string, unknown>()
  private readonly bodies = new Map<string, { version: string; key: string; value: unknown }>()
  private closed = false
  readonly root: string
  constructor(private readonly files: FilesStore, namespace: string) {
    this.root = 'technical/authority/' + hash(namespace) + '/'
  }
  private path(key: string): string {
    if (!key || key.includes('\0')) throw new Error('Authority key is empty or invalid.')
    return this.root + key.split('/').map(segment).join('/') + '.json'
  }
  private assertOpen(): void { if (this.closed) throw new Error('Git authority cache is closed.') }
  private decode(key: string, raw: string): unknown {
    let value: Envelope
    try { value = JSON.parse(raw) as Envelope }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; throw new AuthorityContentError(error.message) }
    if (!value || typeof value !== 'object' || value.version !== 1 || value.key !== key || !Object.hasOwn(value, 'value'))
      throw new AuthorityContentError('Git authority record identity mismatch: ' + key)
    return value.value
  }
  async getAt<T>(snapshot: FilesSnapshot, key: string): Promise<T | undefined> {
    this.assertOpen()
    const raw = await this.files.read(snapshot, this.path(key)); this.assertOpen()
    const value = raw === undefined ? undefined : this.decode(key, raw)
    return structuredClone(value) as T | undefined
  }
  async get<T>(key: string): Promise<T | undefined> {
    this.assertOpen()
    return withSnapshot(this.files, snapshot => this.getAt<T>(snapshot, key), { files: [this.path(key)] })
  }
  async list<T>(prefix: string): Promise<Array<{ key: string; value: T }>> {
    this.assertOpen()
    return withSnapshot(this.files, snapshot => this.listAt<T>(snapshot, prefix), { directories: [this.listRoot(prefix)] })
  }
  private listRoot(prefix: string): string {
    const directory = prefix.slice(0, prefix.lastIndexOf('/') + 1)
    return this.root + (directory ? directory.slice(0, -1).split('/').map(segment).join('/') + '/' : '')
  }
  async listInRound<T>(prefix: string, round: FilesReadRound): Promise<Array<{ key: string; value: T }>> {
    this.assertOpen()
    return round.withSnapshot(async snapshot => {
      const rows = await round.once(this, prefix, () => this.listAt<T>(snapshot, prefix))
      this.assertOpen()
      return structuredClone(rows)
    })
  }
  /** Only an explicit discovery caller may isolate individual content faults.
   * Transport, abort and missing immutable body failures remain outside parsing. */
  async listDiscovery<T>(prefix: string, onContentFault: ContentFaultHandler): Promise<Array<{ key: string; value: T }>> {
    this.assertOpen()
    return withSnapshot(this.files, snapshot => this.listAt<T>(snapshot, prefix, onContentFault), { directories: [this.listRoot(prefix)] })
  }
  private discoveryKey(path: string, prefix: string, reportPathFault = false): string | undefined {
    if (!path.endsWith('.json')) return
    let key: string
    try { key = path.slice(this.root.length, -5).split('/').map(decodeURIComponent).join('/') }
    catch (error) { if (!(error instanceof URIError)) throw error; throw new AuthorityContentError(error.message) }
    if (!key.startsWith(prefix)) return
    if (reportPathFault && (!key || key.includes('\0'))) throw new AuthorityContentError('Git authority path identity mismatch: ' + path)
    if (path !== this.path(key)) {
      if (!reportPathFault) return // Preserve ordinary discovery's existing alias behavior.
      throw new AuthorityContentError('Git authority path identity mismatch: ' + path)
    }
    return key
  }
  private contentFault(error: unknown, path: string, raw: string, key: string | undefined, handler?: ContentFaultHandler): readonly string[] {
    if (!(error instanceof AuthorityContentError) || !handler) throw error
    // Partial JSON is only a stop-responsibility clue, never accepted authority.
    let envelope: Envelope | undefined
    try { envelope = JSON.parse(raw) as Envelope } catch (failure) { if (!(failure instanceof SyntaxError)) throw failure }
    return handler({ path, ...(key ? { key } : {}), value: envelope?.value, reason: error.message, contentVersion: hash(raw) }) ?? []
  }
  async listAt<T>(snapshot: FilesSnapshot, prefix: string, onContentFault?: ContentFaultHandler): Promise<Array<{ key: string; value: T }>> {
    this.assertOpen()
    const entries = await this.files.list(snapshot, this.listRoot(prefix))
    const result: Array<{ key: string; value: T }> = []
    await this.files.prefetch?.(snapshot, { files: entries.filter(entry => entry.path.endsWith('.json') && this.bodies.get(entry.path)?.version !== entry.version).map(entry => entry.path) })
    this.assertOpen()
    for (const entry of entries) {
      if (!entry.path.endsWith('.json')) continue
      let key: string | undefined
      if (!onContentFault) { key = this.discoveryKey(entry.path, prefix); if (!key) continue }
      let cached = this.bodies.get(entry.path)
      if (cached?.version !== entry.version) {
        const raw = await this.files.read(snapshot, entry.path)
        this.assertOpen()
        if (raw === undefined) throw new Error('Listed Git authority record disappeared from its snapshot.')
        try {
          key ??= this.discoveryKey(entry.path, prefix, !!onContentFault)
          if (!key) continue
          cached = { version: entry.version, key, value: this.decode(key, raw) }
        } catch (error) { this.contentFault(error, entry.path, raw, key, onContentFault); continue }
        this.bodies.set(entry.path, cached)
      }
      if (cached.key.startsWith(prefix)) result.push({ key: cached.key, value: structuredClone(cached.value) as T })
    }
    const present = new Set(entries.map(entry => entry.path))
    for (const [path, cached] of this.bodies) if (cached.key.startsWith(prefix) && !present.has(path)) this.bodies.delete(path)
    this.assertOpen()
    return result
  }
  /** Explicit Host-local candidate index. Values locate exact authority keys;
   * consumers must reread selected rows before publication. */
  index<T>(prefix: string, groups: (value: T, key: string) => readonly string[]): GitRecordIndex<{ key: string }>
  index<T>(prefix: string, groups: (value: T, key: string) => readonly string[], onContentFault: ContentFaultHandler): GitRecordIndex<AuthorityDiscoveryKey>
  index<T>(prefix: string, groups: (value: T, key: string) => readonly string[], onContentFault?: ContentFaultHandler): GitRecordIndex<AuthorityDiscoveryKey> {
    if (!(this.files instanceof GitFiles)) throw new Error('Git discovery requires Git files.')
    return new GitRecordIndex<AuthorityDiscoveryKey>(this.files, this.listRoot(prefix), (path, text) => {
      let key: string | undefined, value: T
      try {
        key = this.discoveryKey(path, prefix, !!onContentFault)
        if (!key) return
        value = this.decode(key, text) as T
      } catch (error) {
        return { value: {}, groups: this.contentFault(error, path, text, key, onContentFault) }
      }
      // Consumer failures are not syntax/envelope failures and must not be hidden.
      return { value: { key }, groups: groups(value, key) }
    })
  }
  /** Indexed reads can discover previously unknown members at the next HEAD.
   * A proven CAS conflict therefore reruns the callback with that snapshot,
   * rather than reparenting a payload evaluated from the earlier candidate set. */
  updateIndexed<T, R>(key: string, evaluate: (current: T | undefined, snapshot: FilesSnapshot) => Promise<{ value?: T; result: R; write: boolean; changes?: FileChange[] }>, beforeAttempt?: PublicationGuard): Promise<R> {
    this.assertOpen()
    const operation = withWriteOperation(this.files, () => this.updateInner<T, R>(key, [], [], [],
      (current, _reads, _rows, _raw, snapshot) => evaluate(current, snapshot), beforeAttempt, true))
    this.updates.add(operation)
    void operation.finally(() => this.updates.delete(operation)).catch(() => {})
    return operation
  }
  /** The initial commit was admitted by assertOpen before entering FilesStore.
   * close drains that accepted attempt, but never admits a replacement after
   * a rejected CAS. Caller-specific live guards still run on every dispatch. */
  private publicationGuard(beforeAttempt?: PublicationGuard): PublicationGuard {
    let attempted = false
    return async () => {
      if (attempted) this.assertOpen()
      await beforeAttempt?.()
      if (attempted) this.assertOpen()
      attempted = true
    }
  }
  /** Evaluate and commit against one immutable snapshot; reevaluate only on a
   * proven conflict. Unknown commit outcomes are propagated unchanged. */
  update<T, R>(key: string, evaluate: (current: T | undefined) => { value?: T; result: R; write: boolean }, beforeAttempt?: PublicationGuard): Promise<R> {
    return this.updateWithReads<T, R>(key, [], current => evaluate(current), beforeAttempt)
  }
  updateWithReads<T, R>(key: string, readKeys: readonly string[], evaluate: (current: T | undefined, reads: ReadonlyMap<string, unknown>, snapshot: FilesSnapshot) => { value?: T; result: R; write: boolean; changes?: FileChange[] } | Promise<{ value?: T; result: R; write: boolean; changes?: FileChange[] }>, beforeAttempt?: PublicationGuard): Promise<R> {
    this.assertOpen()
    const operation = withWriteOperation(this.files, () => this.updateInner<T, R>(key, readKeys, [], [], (current, reads, _rows, _raw, snapshot) => evaluate(current, reads, snapshot), beforeAttempt))
    this.updates.add(operation)
    void operation.finally(() => this.updates.delete(operation)).catch(() => {})
    return operation
  }
  updateWithDirectories<T, R>(key: string, prefixes: readonly string[], evaluate: (current: T | undefined, rows: ReadonlyArray<{key: string; value: unknown}>, snapshot: FilesSnapshot) => { value?: T; result: R; write: boolean }, beforeAttempt?: PublicationGuard): Promise<R> {
    this.assertOpen()
    const operation = withWriteOperation(this.files, () => this.updateInner<T, R>(key, [], prefixes, [], (current, _reads, rows, _raw, snapshot) => evaluate(current, rows, snapshot), beforeAttempt))
    this.updates.add(operation)
    void operation.finally(() => this.updates.delete(operation)).catch(() => {})
    return operation
  }
  updateWithRawDirectories<T, R>(key: string, prefixes: readonly string[], rawPrefixes: readonly string[], evaluate: (current:T|undefined, rows:ReadonlyArray<{key:string;value:unknown}>, rawRows:ReadonlyArray<{path:string;body:string}>, snapshot:FilesSnapshot) => Promise<{value?:T;result:R;write:boolean; changes?:FileChange[]}> | {value?:T;result:R;write:boolean; changes?:FileChange[]}, beforeAttempt?: PublicationGuard): Promise<R> {
    this.assertOpen()
    const operation=withWriteOperation(this.files,()=>this.updateInner<T,R>(key,[],prefixes,rawPrefixes,(current,_reads,rows,rawRows,snapshot)=>evaluate(current,rows,rawRows,snapshot), beforeAttempt))
    this.updates.add(operation);void operation.finally(()=>this.updates.delete(operation)).catch(()=>{})
    return operation
  }
  private async updateInner<T, R>(key: string, readKeys: readonly string[], prefixes: readonly string[], rawPrefixes: readonly string[], evaluate: (current: T | undefined, reads: ReadonlyMap<string, unknown>, rows: ReadonlyArray<{key:string;value:unknown}>, rawRows:ReadonlyArray<{path:string;body:string}>, snapshot:FilesSnapshot) => Promise<{ value?: T; result: R; write: boolean; changes?: FileChange[] }> | { value?: T; result: R; write: boolean; changes?: FileChange[] }, beforeAttempt?: PublicationGuard, reevaluateOnConflict = false): Promise<R> {
    const path = this.path(key)
    // The changed-head check owns the next evaluation view; never fetch it twice.
    let retrySnapshot: FilesSnapshot | undefined
    try {
      for (;;) {
        this.assertOpen()
        const directories = prefixes.map(prefix => this.root + prefix.replace(/\/$/, '').split('/').map(segment).join('/') + '/')
        const recovered = retrySnapshot
        const snapshot = recovered ?? await this.files.snapshot({ files: [path, ...readKeys.map(key => this.path(key))], directories:[...directories,...rawPrefixes] })
        retrySnapshot = undefined
        try {
          if (recovered) await this.files.prefetch?.(snapshot, { files: [path, ...readKeys.map(key => this.path(key))], directories:[...directories,...rawPrefixes] })
          const raw = await this.files.read(snapshot, path)
          this.assertOpen()
          const current = raw === undefined ? undefined : structuredClone(this.decode(key, raw)) as T
          const reads = new Map<string, unknown>()
          for (const readKey of readKeys) {
            const body = await this.files.read(snapshot, this.path(readKey))
            reads.set(readKey, body === undefined ? undefined : structuredClone(this.decode(readKey, body)))
          }
          const rows: Array<{key:string;value:unknown}> = []
          for (let index = 0; index < directories.length; index++) {
            for (const entry of await this.files.list(snapshot, directories[index]!)) {
              if (!entry.path.endsWith('.json')) continue
              const foundKey = entry.path.slice(this.root.length, -5).split('/').map(decodeURIComponent).join('/')
              if (!foundKey.startsWith(prefixes[index]!) || entry.path !== this.path(foundKey)) continue
              const body = await this.files.read(snapshot, entry.path)
              if (body === undefined) throw new Error('Listed Git authority record disappeared from its snapshot.')
              rows.push({key:foundKey,value:structuredClone(this.decode(foundKey, body))})
            }
          }
          const rawRows: Array<{path:string;body:string}> = []
          for (const prefix of rawPrefixes) for (const entry of await this.files.list(snapshot,prefix)) {
            const body=await this.files.read(snapshot,entry.path)
            if (body === undefined) throw new Error('Listed Git business record disappeared from its snapshot.')
            rawRows.push({path:entry.path,body})
          }
          this.assertOpen()
          const decision = await withFileDependencies(this.files, snapshot, () => Promise.resolve(evaluate(current, reads, rows, rawRows, snapshot)))
          if (!decision.write) return decision.result
          if (decision.value === undefined) throw new Error('An authority update must write a defined value.')
          const content = JSON.stringify({ version: 1, key, value: decision.value } satisfies Envelope) + '\n'
          if (raw === content && !decision.changes?.length) return decision.result
          try {
            this.assertOpen()
            await this.files.commit(snapshot, [{ path, content }, ...(decision.changes ?? [])], 'DSS authority ' + hash(JSON.stringify([key, content])), { beforeAttempt: this.publicationGuard(beforeAttempt), ...(reevaluateOnConflict ? { reevaluateOnConflict: true } : {}) })
            return decision.result
          } catch (error) {
            if (!(error instanceof FilesConflictError)) throw error
            retrySnapshot = (this.files instanceof GitFiles ? this.files.takeConflictSnapshot(error) : undefined) ?? await this.files.snapshot({})
            if (retrySnapshot.revision === snapshot.revision) throw error
          }
        } finally { await snapshot.release() }
      }
    } finally { await retrySnapshot?.release() }
  }
  /** Decide among explicitly named authority targets using one raw business
   * record and one Git snapshot; callback must be pure. */
  updateRouted<R>(keys: readonly string[], rawPath: string, evaluate: (values: ReadonlyMap<string, unknown>, raw: string | undefined, snapshot: FilesSnapshot) => {target:string; value:unknown; result:R; write:boolean} | Promise<{target:string; value:unknown; result:R; write:boolean}>, beforeAttempt?: PublicationGuard): Promise<R> {
    this.assertOpen()
    const operation = withWriteOperation(this.files, () => this.updateRoutedInner(keys, rawPath, evaluate, beforeAttempt))
    this.updates.add(operation)
    void operation.finally(() => this.updates.delete(operation)).catch(() => {})
    return operation
  }
  private async updateRoutedInner<R>(keys: readonly string[], rawPath: string, evaluate: (values: ReadonlyMap<string, unknown>, raw: string | undefined, snapshot: FilesSnapshot) => {target:string; value:unknown; result:R; write:boolean} | Promise<{target:string; value:unknown; result:R; write:boolean}>, beforeAttempt?: PublicationGuard): Promise<R> {
    // The changed-head check owns the next evaluation view; never fetch it twice.
    let retrySnapshot: FilesSnapshot | undefined
    try {
      for (;;) {
        this.assertOpen()
        const recovered = retrySnapshot
        const snapshot = recovered ?? await this.files.snapshot({files:[rawPath,...keys.map(key=>this.path(key))]})
        retrySnapshot = undefined
        try {
          if (recovered) await this.files.prefetch?.(snapshot, {files:[rawPath,...keys.map(key=>this.path(key))]})
          const values = new Map<string,unknown>(), bodies = new Map<string,string | undefined>()
          for (const key of keys) {
            const body=await this.files.read(snapshot,this.path(key))
            bodies.set(key,body)
            values.set(key,body === undefined ? undefined : structuredClone(this.decode(key,body)))
          }
          const raw = await this.files.read(snapshot,rawPath)
          this.assertOpen()
          const decision=await withFileDependencies(this.files, snapshot, async () => evaluate(values,raw,snapshot))
          if (!keys.includes(decision.target)) throw new Error('Authority route selected an undeclared target.')
          if (!decision.write) return decision.result
          if (decision.value === undefined) throw new Error('An authority update must write a defined value.')
          const change=this.change(decision.target,decision.value)
          // The selected envelope was already read in this evaluation snapshot.
          // Match exact stored bytes, just as updateWithReads does, not object equality.
          if (bodies.get(decision.target) === change.content) return decision.result
          try {this.assertOpen();await this.files.commit(snapshot,[change],'DSS routed authority '+hash(JSON.stringify([decision.target,decision.value])), { beforeAttempt: this.publicationGuard(beforeAttempt) });return decision.result}
          catch(error) {if(!(error instanceof FilesConflictError)) throw error; retrySnapshot = (this.files instanceof GitFiles ? this.files.takeConflictSnapshot(error) : undefined) ?? await this.files.snapshot({}); if (retrySnapshot.revision === snapshot.revision) throw error}
        } finally {await snapshot.release()}
      }
    } finally { await retrySnapshot?.release() }
  }
  ownedContext<T>(owner: string, create: () => T): T {
    if (!this.ownedContexts.has(owner)) this.ownedContexts.set(owner, create())
    return this.ownedContexts.get(owner) as T
  }
  /** Volatile responsibility for a single logical update; uncertain dispatches
   * keep the original Git operation and never produce a replacement identity. */
  updateOwned<T, R>(key: string, owner: string, evaluate: (current: T | undefined, snapshot: FilesSnapshot) => {value?:T; result:R; write:boolean} | Promise<{value?:T; result:R; write:boolean}>, fingerprint = '', allowEvolution = false, replayAfterConfirmed = true, prepare?: () => void, beforeAttempt?: PublicationGuard): Promise<R> {
    this.assertOpen()
    const previous = this.ownedWrites.get(owner) ?? Promise.resolve()
    const work = previous.catch(() => {}).then(() => {prepare?.(); return withWriteOperation(this.files, () => this.updateOwnedInner(key, owner, evaluate, fingerprint, allowEvolution, replayAfterConfirmed, beforeAttempt))})
    const operation = work.then(value => {this.ownedContexts.delete(owner);return value}, error => {if (!this.ownedAttempts.has(owner)) this.ownedContexts.delete(owner);throw error})
    this.ownedWrites.set(owner, operation)
    this.updates.add(operation)
    void operation.finally(() => { this.updates.delete(operation); if(this.ownedWrites.get(owner) === operation) this.ownedWrites.delete(owner) }).catch(() => {})
    return operation
  }
  private releaseOwnedAttempt(owner: string): void {
    const attempt = this.ownedAttempts.get(owner)
    this.ownedAttempts.delete(owner)
    attempt?.release?.()
  }
  private async updateOwnedInner<T, R>(key: string, owner: string, evaluate: (current: T | undefined, snapshot: FilesSnapshot) => {value?:T; result:R; write:boolean} | Promise<{value?:T; result:R; write:boolean}>, fingerprint: string, allowEvolution: boolean, replayAfterConfirmed: boolean, beforeAttempt?: PublicationGuard): Promise<R> {
    const path = this.path(key)
    // The changed-head check owns the next evaluation view; never fetch it twice.
    let retrySnapshot: FilesSnapshot | undefined
    try {
      for (;;) {
        this.assertOpen()
        const pending = this.ownedAttempts.get(owner)
        if (pending) {
          if (pending.fingerprint !== fingerprint && !allowEvolution) throw new Error('An uncertain command identity has different arguments.')
          if (pending.path !== path || !(this.files instanceof GitFiles)) throw new Error('Owned authority update cannot resolve its original operation.')
          const resolution = await this.files.resolve(pending.id)
          if (resolution.status === 'confirmed') { this.releaseOwnedAttempt(owner); if (!replayAfterConfirmed) return pending.result as R; continue }
          if (resolution.status === 'unknown') throw new FilesOutcomeUnknownError(pending.id)
          const operation = await this.files.operations.get(pending.id)
          if (!operation) throw new Error('The owned authority update lost its original operation.')
          const original = await this.files.at(operation.operation.expectedHead)
          try {
            this.files.restoreReads(original, pending.reads)
            await this.files.commitPrepared(original, [{path,content:pending.content}], pending.message, pending.id, {
              beforeAttempt: this.publicationGuard(beforeAttempt),
              onAttempt: operation => {
                const release = this.files instanceof GitFiles ? this.files.retainOperation(operation.id) : undefined
                pending.release?.(); pending.id = operation.id; pending.release = release
              },
            })
            this.releaseOwnedAttempt(owner); if (!replayAfterConfirmed) return pending.result as R; continue
          } catch (error) {
            if (!(error instanceof FilesConflictError)) throw error
            // The original command is now proved unpublished and an actual
            // dependency changed. Its owner may evaluate those current facts.
            retrySnapshot = this.files.takeConflictSnapshot(error) ?? await this.files.snapshot({})
            this.releaseOwnedAttempt(owner)
          } finally { await original.release() }
        }
        const recovered = retrySnapshot
        const snapshot = recovered ?? await this.files.snapshot({files:[path]})
        retrySnapshot = undefined
        try {
          if (recovered) await this.files.prefetch?.(snapshot, {files:[path]})
          const raw = await this.files.read(snapshot,path)
          this.assertOpen()
          const decision = await withFileDependencies(this.files, snapshot, () => Promise.resolve(evaluate(raw === undefined ? undefined : structuredClone(this.decode(key,raw)) as T, snapshot)))
          if (!decision.write) return decision.result
          if (decision.value === undefined) throw new Error('An authority update must write a defined value.')
          const content = JSON.stringify({version:1,key,value:decision.value} satisfies Envelope) + '\n'
          if (raw === content) return decision.result
          const message = 'DSS authority ' + hash(JSON.stringify([key,content]))
          try { this.assertOpen(); await this.files.commit(snapshot,[{path,content}],message, { beforeAttempt: this.publicationGuard(beforeAttempt) }); return decision.result }
          catch (error) {
            if (error instanceof FilesOutcomeUnknownError) {
              if (this.files instanceof GitFiles) this.ownedAttempts.set(owner,{id:error.operationId,path,content,message,result:decision.result,fingerprint,reads:this.files.captureReads(snapshot),release:this.files.retainOperation(error.operationId)})
              throw error
            }
            if (!(error instanceof FilesConflictError)) throw error
            retrySnapshot = (this.files instanceof GitFiles ? this.files.takeConflictSnapshot(error) : undefined) ?? await this.files.snapshot({})
            if (retrySnapshot.revision === snapshot.revision) throw error
          }
        } finally { await snapshot.release() }
      }
    } finally { await retrySnapshot?.release() }
  }
  /** Add to the original business CAS when acceptance and responsibility must
   * be atomic; do not publish an authority set ahead of a checked business view. */
  change<T>(key: string, value: T): FileChange {
    this.assertOpen()
    return { path: this.path(key), content: JSON.stringify({ version: 1, key, value } satisfies Envelope) + '\n' }
  }
  deleteChange(key: string): FileChange { this.assertOpen(); return {path:this.path(key),content:null} }
  set<T>(key: string, value: T): Promise<void> {
    return this.compareAndSet(key, undefined, value)
  }
  /** Generic StoragePort writes can create or acknowledge identical content.
   * Replacements/deletions must carry this operation's exact prior value or use
   * an update callback. A discovery/UI read never grants overwrite permission. */
  compareAndSet<T>(key: string, expected: T | undefined, value: T): Promise<void> {
    if (value === undefined) throw new Error('An authority replacement must write a defined value.')
    const content = JSON.stringify({ version: 1, key, value } satisfies Envelope) + '\n'
    const prior = expected === undefined ? null : JSON.stringify({ version: 1, key, value: expected } satisfies Envelope) + '\n'
    return this.mutate(key, content, prior)
  }
  delete(key: string): Promise<void> { return this.compareAndDelete(key, undefined) }
  /** Retire exact owned files in the same CAS as their original responsibility. */
  compareAndDelete<T>(key: string, expected: T | undefined, ownedPaths: readonly string[] = []): Promise<void> {
    const prior = expected === undefined ? null : JSON.stringify({ version: 1, key, value: expected } satisfies Envelope) + '\n'
    return this.mutate(key, null, prior, ownedPaths)
  }
  private mutate(key: string, content: string | null, expected: string | null, ownedPaths: readonly string[] = []): Promise<void> {
    this.assertOpen()
    const path = this.path(key)
    const operation = (this.writes.get(key) ?? Promise.resolve()).catch(() => {}).then(() => withWriteOperation(this.files, async () => {
      // Both prior and desired content were captured when this operation was
      // submitted. Queuing never upgrades a stale caller to a later version.
      let retrySnapshot: FilesSnapshot | undefined
      try {
        for (;;) {
          this.assertOpen()
          const recovered = retrySnapshot
          const snapshot = recovered ?? await this.files.snapshot({ files: [path] })
          retrySnapshot = undefined
          try {
            if (recovered) await this.files.prefetch?.(snapshot, { files: [path] })
            const raw = await this.files.read(snapshot, path)
            if ((content === null && raw === undefined) || raw === content) return
            // An unobserved existing value is not permission for a blind overwrite.
            if ((raw ?? null) !== expected) throw new FilesConflictError(snapshot.revision)
            await withFileDependencies(this.files, snapshot, async () => {})
            try {
              await this.files.commit(snapshot, [{ path, content }, ...ownedPaths.map(path => ({ path, content: null }))], 'DSS authority ' + hash(JSON.stringify([key, content])), { beforeAttempt: this.publicationGuard() })
              return
            } catch (error) {
              if (!(error instanceof FilesConflictError)) throw error
              // Only a proven competing commit can trigger fresh evaluation. The
              // next loop must still prove this exact target value is unchanged.
              retrySnapshot = (this.files instanceof GitFiles ? this.files.takeConflictSnapshot(error) : undefined) ?? await this.files.snapshot({})
              if (retrySnapshot.revision === snapshot.revision) throw error
            }
          } finally { await snapshot.release() }
        }
      } finally { await retrySnapshot?.release() }
    }))
    this.writes.set(key, operation)
    void operation.finally(() => { if (this.writes.get(key) === operation) this.writes.delete(key) }).catch(() => {})
    return operation
  }
  async close(): Promise<void> {
    this.closed = true
    try {
      const results = await Promise.allSettled([...this.writes.values(), ...this.updates])
      const errors = results.filter((value): value is PromiseRejectedResult => value.status === 'rejected').map(value => value.reason)
      if (errors.length) throw new AggregateError(errors, 'Git authority writes did not settle.')
    } finally { this.writes.clear(); this.updates.clear(); for (const owner of this.ownedAttempts.keys()) this.releaseOwnedAttempt(owner); this.ownedWrites.clear(); this.ownedContexts.clear(); this.bodies.clear() }
  }
}

/** Explicit discovery list, never an ambient replacement for StoragePort reads.
 * A later write/role admission rechecks through the normal authority methods. */
export async function listAuthorityInRound<T>(storage: StoragePort, prefix: string, round?: FilesReadRound): Promise<Array<{ key: string; value: T }>> {
  if (!round || !(storage instanceof GitAuthorityStore)) return storage.list<T>(prefix)
  return storage.listInRound<T>(prefix, round)
}
