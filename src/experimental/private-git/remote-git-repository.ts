import { rebuildGitDirectoryIndex, type GitDirectoryIndex, type GitDirectoryIndexOptions } from '../../framework/git-directory-index.js'
import { matchesFileSelection, mayContainSelectedFiles } from '../../framework/file-list-selection.js'
import type { GitReadDependencies } from './contracts.js'
import { annotateFailure, failureDetails, type FailureDetails } from '../../diagnostics/failure-details.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { GitChange, GitFileChange, GitReceipt, GitRepository, GitSnapshot, RepoBinding, RepoConnection } from './contracts.js'
import { GitConflictError, GitHubClient, GitHubError, inspectPrivateRepo, repositoryPath, GITHUB_CLI_SETUP_REQUIRED,
  type GitHubFetch, type ResolvedToken, type TokenSource } from './github.js'
import { GitCommitOutcomeUnknownError, validCoopPath, type GitCommitOperation, type GitCommitResolution } from './contracts.js'
import type { GitReadPlan, GitOperationChannel } from './contracts.js'

import { GitBackendError, type GitObjectBackend, type GitObjectCommand } from './git-object-backend.js'
import { DulwichGitBackend, type DulwichGitOptions } from './dulwich-git-backend.js'

export interface RemoteGitOptions {
  dulwich?: DulwichGitOptions
  signal?: AbortSignal
  fetcher?: GitHubFetch
  /** Optional safe timing seam: no URL, token, arguments, input or content.
   * These are semantic operations; network/pack counts remain unknown. */
  onOperation?: (event: { channel: GitOperationChannel; operation: GitObjectCommand['op']; phase: 'start' | 'end'; elapsedMs?: number; success?: boolean; failureDetails?: FailureDetails; httpRequests: null; packBytes: null }) => void
  /** Growth trigger for background transport reclamation; not a hard cap on live snapshots. */
  cacheGrowthBytes?: number
  /** Isolated fixture seam. Production never changes its validated HTTPS endpoint. */
  remoteUrl?: (connection: RepoConnection) => string
  inspectAuthority?: (token: ResolvedToken, binding: RepoBinding, signal: AbortSignal) => Promise<RepoConnection>
  /** Optional diagnostics; no credentials or business contents. */
  onCacheReplacement?: (event: { channel: GitOperationChannel; status: 'replaced' | 'failed'; elapsedMs: number; beforeBytes?: number; afterBytes?: number; error?: unknown }) => void
}
interface Entry { path: string; sha: string; type: 'blob' | 'tree' | 'commit'; mode: string; size?: number }
interface Commit { tree: string; parents: string[]; message: string; timestamp: number }
interface ObjectCache {
  channel: GitOperationChannel
  transport: GitObjectBackend; broken?: boolean; trees: Map<string, Entry[]>; commits: Map<string, Commit>; metadata: Set<string>; present: Set<string>
  writtenBlobs: Map<string, string>; fetching: Map<string, Promise<void>>; negotiationTip?: string; dirty: boolean; floorBytes: number; hotBlobs: Map<string, { bytes: number; used: number }>; active: number; retired: boolean
  snapshots: Map<State, WeakRef<GitSnapshot>>; pending: Set<string>; replacing?: Promise<void>; released: boolean
}
interface Preparation { operation: GitCommitOperation; dispatched: boolean }
interface OperationOwner { preparation: Preparation; snapshot: WeakRef<GitSnapshot> }
interface Scope {
  preparations: Map<string, WeakRef<Preparation>>; pendingOperations: Map<string, { operation: GitCommitOperation; preparation?: Preparation }>
  operationTails: Map<string, Promise<void>>
  publicationSequence: number; confirmedBases: Map<string, number>
  key: string; bound: RepoBinding; canonicalPending: boolean; authorization: object; connection: RepoConnection; directory: string; remote: string; fixture: boolean
  signal: AbortSignal; controller: AbortController; channels: Map<GitOperationChannel, ObjectCache>; caches: Set<ObjectCache>
}
interface Session { token?: ResolvedToken; scope: Scope; cache: ObjectCache; signal: AbortSignal; active: boolean; reusable: boolean; pending: Set<Promise<unknown>> }
interface State { observedHead: boolean; publicationSequence: number; scope: Scope; cache: ObjectCache; signal?: AbortSignal; loaded: Set<string>; pathErrors: Map<string, unknown> }
const oid = (value: string) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const changeBytes = (change: GitChange): Buffer | null => {
  if (change.deleteTree !== undefined && (change.deleteTree !== true || change.content !== null)) throw new Error('A directory deletion must explicitly carry null content.')
  if (change.bytes !== undefined) {
    if (!(change.bytes instanceof Uint8Array) || change.content !== undefined) throw new Error('Use either text content or binary bytes for a Git file, not both.')
    return Buffer.from(change.bytes)
  }
  if (change.content === null) return null
  if (typeof change.content !== 'string') throw new Error('A Git file requires text content, binary bytes, or an explicit deletion.')
  return Buffer.from(change.content, 'utf8')
}

/** Dulwich transport, remote branch authority. The in-memory object store is an
 * immutable transport cache, never a local backend or an authoritative mirror.
 * Each snapshot observes the remote ref; reads and predicates stay pinned to H.
 * Each write constructs one commit with parent H and publishes with exact-H CAS.
 */
export class RemoteGitRepository implements GitRepository {
  readonly reportsCommitDispatch = true as const
  readonly resumesUnsentCommits = true as const
  private readonly channels = new AsyncLocalStorage<{ channel: GitOperationChannel; active: boolean }>()
  private readonly readers = new AsyncLocalStorage<Session>()
  private epoch = new AbortController()
  private signal: AbortSignal
  private readonly acquisitions = new Set<Promise<Scope>>()
  private acquisition?: { key: string; fingerprint: string; connect: boolean; signal: AbortSignal; controller: AbortController; waiters: number; promise: Promise<Scope> }
  // Preparation time and dispatch provenance live with snapshots/operations,
  // not in a permanent repository-wide history of every operation id.
  private readonly prepared = new WeakMap<GitSnapshot, Map<string, Preparation>>()
  private readonly operationOwners = new WeakMap<GitCommitOperation, OperationOwner>()
  private readonly preparationFinalizer = new FinalizationRegistry<{ scope: WeakRef<Scope>; id: string; reference: WeakRef<Preparation> }>(held => {
    const scope = held.scope.deref()
    if (scope?.preparations.get(held.id) === held.reference) scope.preparations.delete(held.id)
  })
  private checked?: { key: string; fingerprint: string; scope: Scope }
  private states = new WeakMap<GitSnapshot, State>()
  private readonly conflicts = new WeakMap<GitConflictError, GitSnapshot>()
  private retired: Promise<void>[] = []
  constructor(private readonly binding: () => RepoBinding, private readonly tokens: TokenSource,
    private readonly options: RemoteGitOptions = {}) {
    this.signal = options.signal ? AbortSignal.any([this.epoch.signal, options.signal]) : this.epoch.signal
    if (options.remoteUrl && !options.inspectAuthority) throw new Error('A fixture transport requires an isolated authority provider.')
    if (options.cacheGrowthBytes !== undefined && (!Number.isSafeInteger(options.cacheGrowthBytes) || options.cacheGrowthBytes <= 0)) throw new Error('Git cache growth trigger must be a positive byte count.')
  }
  private channel(): GitOperationChannel {
    const owner = this.channels.getStore()
    return owner?.active ? owner.channel : 'read'
  }
  /** A bounded transport choice, not a new identity or a serialization barrier.
   * Callback-owned context expires so detached timers cannot retain this lane. */
  async withChannel<T>(channel: GitOperationChannel, action: () => Promise<T>): Promise<T> {
    if (!['read', 'write', 'refresh', 'foreground-read', 'foreground-write', 'host-poll', 'host-poll-write'].includes(channel)) throw new Error('Unknown Git operation channel.')
    const owner = { channel, active: true }
    try { return await this.channels.run(owner, action) } finally { owner.active = false }
  }
  private writeChannel(): GitOperationChannel {
    const channel = this.channel()
    return channel === 'host-poll-write' ? channel : channel.startsWith('foreground-') ? 'foreground-write' : 'write'
  }
  withWriteOperation<T>(action: () => Promise<T>): Promise<T> {
    return this.withChannel(this.writeChannel(), action)
  }
  private newCache(channel: GitOperationChannel, transport: GitObjectBackend = new DulwichGitBackend(this.options.dulwich)): ObjectCache {
    return { channel, transport, trees: new Map(), commits: new Map(), metadata: new Set(), present: new Set(), writtenBlobs: new Map(), fetching: new Map(),
      dirty: false, floorBytes: 0, hotBlobs: new Map(), active: 0, retired: false, released: false, snapshots: new Map(), pending: new Set() }
  }
  private retire(work: Promise<void>): void {
    this.retired.push(work)
    void work.then(() => { const index = this.retired.indexOf(work); if (index >= 0) this.retired.splice(index, 1) }, () => {})
  }
  private async releaseScope(scope: Scope): Promise<void> {
    await Promise.allSettled([...scope.operationTails.values()])
    await Promise.allSettled([...scope.caches].flatMap(cache => cache.replacing ? [cache.replacing] : []))
    await Promise.all([...scope.caches].map(cache => cache.transport.release()))
    scope.caches.clear(); scope.channels.clear()
  }
  private sweepCaches(scope: Scope): void {
    for (const cache of scope.caches) {
      for (const [state, reference] of cache.snapshots) if (!reference.deref() || state.signal?.aborted) cache.snapshots.delete(state)
      if (!cache.retired || cache.released || cache.active || cache.replacing || cache.pending.size || cache.snapshots.size) continue
      cache.released = true
      scope.caches.delete(cache)
      this.retire(cache.transport.release())
    }
  }
  private settleOperation(scope: Scope, id: string): void {
    const preparation = scope.preparations.get(id)?.deref()
    if (preparation) preparation.dispatched = true
    scope.pendingOperations.delete(id)
    for (const cache of scope.caches) cache.pending.delete(id)
    this.sweepCaches(scope)
  }
  private maintainCache(scope: Scope, cache: ObjectCache): void {
    this.sweepCaches(scope)
    // Check only after new objects arrived. The configured size trigger starts a
    // background generation replacement, never a timer or a reader barrier.
    if (scope.signal.aborted || scope.channels.get(cache.channel) !== cache || cache.replacing || !cache.dirty || !cache.negotiationTip) return
    cache.dirty = false
    const start = performance.now()
    const replacing = (async () => {
      const beforeBytes = await cache.transport.storageBytes()
      const growth = this.options.cacheGrowthBytes ?? 40 * 1024 * 1024
      if (beforeBytes < Math.max(growth, cache.floorBytes + growth / 2)) return
      this.check(scope)
      const head = cache.negotiationTip!, selected = new Set<string>()
      let hotBytes = 0
      const hotBudget = Math.min(growth / 2, 16 * 1024 * 1024)
      for (const [id, usage] of [...cache.hotBlobs].sort((a, b) => b[1].used - a[1].used)) {
        // Retain the most recently used body even when that one file exceeds
        // the budget; avoid repeatedly downloading the user's active large file.
        if (selected.size && hotBytes + usage.bytes > hotBudget) continue
        selected.add(id); hotBytes += usage.bytes
      }
      const result = await cache.transport.replacement([{ head }], scope.signal, selected)
      try {
        this.check(scope)
        if (scope.channels.get(cache.channel) !== cache) { await result.transport.release(); return }
        const next = this.newCache(cache.channel, result.transport)
        next.negotiationTip = head
        for (const root of result.roots) next.metadata.add(root.head)
        for (const id of selected) if (cache.hotBlobs.has(id)) next.hotBlobs.set(id, cache.hotBlobs.get(id)!)
        next.floorBytes = result.rawBytes
        this.check(scope)
        scope.caches.add(next); scope.channels.set(cache.channel, next); cache.retired = true
        this.options.onCacheReplacement?.({ channel: cache.channel, status: 'replaced', elapsedMs: performance.now() - start, beforeBytes, afterBytes: next.floorBytes })
      } catch (error) { await result.transport.release(); throw error }
    })().catch(error => {
      if (!scope.signal.aborted) this.options.onCacheReplacement?.({ channel: cache.channel, status: 'failed', elapsedMs: performance.now() - start, error })
    }).finally(() => {
      cache.replacing = undefined; this.sweepCaches(scope)
      if (cache.dirty && scope.channels.get(cache.channel) === cache && !scope.signal.aborted) this.maintainCache(scope, cache)
    })
    cache.replacing = replacing
  }
  releaseSnapshot(snapshot: GitSnapshot): void {
    const state = this.states.get(snapshot)
    if (!state) return
    this.states.delete(snapshot); this.prepared.delete(snapshot); state.cache.snapshots.delete(state)
    this.sweepCaches(state.scope)
  }
  private bindingKey(): string {
    const b = this.binding()
    return JSON.stringify([b.ownerRepo, b.repositoryId, b.participantId, b.branch, b.repositoryDirectory])
  }
  cancel(reason?: unknown): void {
    this.epoch.abort(reason)
    const scope = this.checked?.scope
    this.checked = undefined
    this.epoch = new AbortController(); this.signal = this.epoch.signal
    if (scope) this.retire(this.releaseScope(scope))
  }
  async releaseCache(): Promise<void> {
    this.cancel()
    // A canceled waiter can finish before its owned acquisition/cleanup. Drain
    // those tasks too, including superseded acquisitions with no installed scope.
    await Promise.allSettled([...this.acquisitions])
    while (this.retired.length) await Promise.all(this.retired.splice(0))
    this.states = new WeakMap()
  }
  private adoptConnectedBinding(scope: Scope): void {
    if (!scope.canonicalPending || scope.key === this.bindingKey()) return
    const binding = this.binding(), original = scope.bound, connection = scope.connection
    const sameOptional = (before: unknown, next: unknown, verified: unknown) => next === before || before === undefined && next === verified
    let sameRepository = false
    try { sameRepository = repositoryPath(binding.ownerRepo).toLowerCase() === repositoryPath(connection.repository.fullName).toLowerCase() } catch { return }
    if (sameRepository && sameOptional(original.repositoryId, binding.repositoryId, connection.repository.id)
      && sameOptional(original.participantId, binding.participantId, connection.identity.id)
      && sameOptional(original.branch, binding.branch, connection.repository.branch)
      && (binding.repositoryDirectory ?? 'dss-coop') === scope.directory) {
      scope.key = this.bindingKey(); scope.bound = { ...binding }; scope.canonicalPending = false
      if (this.checked?.scope === scope) this.checked.key = scope.key
    }
  }
  private check(scope: Scope): void {
    scope.signal.throwIfAborted()
    this.adoptConnectedBinding(scope)
    if (scope !== this.checked?.scope || scope.key !== this.bindingKey()) throw new GitHubError(409, 'The Git account or repository changed. Read a new snapshot before continuing.')
  }
  private async acquire(token: ResolvedToken, key: string, fingerprint: string, epoch: AbortSignal, signal: AbortSignal, connect: boolean): Promise<Scope> {
    let pending = this.acquisition
    if (!pending || pending.key !== key || pending.fingerprint !== fingerprint || pending.signal !== epoch) {
      pending?.controller.abort(new GitHubError(409, 'The Git account or repository changed during connection.'))
      const controller = new AbortController(), acquisitionSignal = AbortSignal.any([epoch, controller.signal]), binding = { ...this.binding() }
      const promise = (async (): Promise<Scope> => {
        const cache = this.newCache('read')
        try {
        // Configured memory dependencies must be available before account/repo
        // REST inspection. This remains lazy within the owned operation, never
        // plugin activation; a later explicit attempt can retry after install.
        await cache.transport.ready?.(acquisitionSignal)
        acquisitionSignal.throwIfAborted()
        const target = { ...binding, participantId: undefined }
        const connection = this.options.inspectAuthority
          ? await this.options.inspectAuthority(token, target, acquisitionSignal)
          : await new GitHubClient(async () => token, this.options.fetcher, { signal: acquisitionSignal }).session(session => inspectPrivateRepo(session, target))
        acquisitionSignal.throwIfAborted()
        if (key !== this.bindingKey()) throw new GitHubError(409, 'The Git binding changed during connection.')
        if (!connection.repository.private) throw new GitHubError(422, 'This repository is public. Git collaboration requires a private repository.')
        if (binding.repositoryId !== undefined && binding.repositoryId !== connection.repository.id) throw new GitHubError(409, 'The Git account or repository changed. Connect before continuing.')
        const directory = binding.repositoryDirectory ?? 'dss-coop'
        if (directory && (!validCoopPath('dss-coop/' + directory) || directory.startsWith('/'))) throw new Error('Use a directory inside the Git repository.')
        const path = repositoryPath(connection.repository.fullName).slice('/repos/'.length)
        const fixture = !!this.options.remoteUrl, remote = this.options.remoteUrl?.(connection) ?? 'https://github.com/' + path + '.git'
        if (fixture) {
          const url = new URL(remote)
          const allowed = ['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
          if (!allowed) throw new Error('Isolated Git fixtures require a loopback smart HTTP endpoint.')
        }
        const scopeController = new AbortController(), scopeSignal = AbortSignal.any([epoch, scopeController.signal])
        const scope: Scope = { key, bound: binding, canonicalPending: connect, authorization: {}, connection, directory, remote, fixture, signal: scopeSignal, controller: scopeController,
          channels: new Map([['read', cache]]), caches: new Set([cache]), publicationSequence: 0, confirmedBases: new Map(),
          preparations: new Map(), pendingOperations: new Map(), operationTails: new Map() }
        try {
          acquisitionSignal.throwIfAborted()
          if (key !== this.bindingKey()) throw new GitHubError(409, 'The Git binding changed during connection.')
        } catch (error) { await this.releaseScope(scope); throw error }
        const old = this.checked?.scope
        this.checked = { key, fingerprint, scope }
        if (old) {
          old.controller.abort(new GitHubError(409, 'The Git account or repository changed.'))
          this.retire(this.releaseScope(old))
        }
        return scope
        } catch (error) { await cache.transport.release(); throw error }
      })()
      pending = { key, fingerprint, connect, signal: epoch, controller, waiters: 0, promise }
      this.acquisition = pending
      this.acquisitions.add(promise)
      void promise.finally(() => {
        this.acquisitions.delete(promise)
        if (this.acquisition?.promise === promise) this.acquisition = undefined
      }).catch(() => {})
    }
    pending.waiters++
    try {
      return await new Promise<Scope>((resolve, reject) => {
        const abort = (): void => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
        void pending!.promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
      })
    } finally {
      pending.waiters--
      if (!pending.waiters && this.acquisition === pending) pending.controller.abort(signal.aborted ? signal.reason : undefined)
    }
  }
  private async session<T>(action: (session: Session) => Promise<T>, connect = false, ownerSignal?: AbortSignal): Promise<T> {
    const epoch = this.signal, signal = ownerSignal ? AbortSignal.any([epoch, ownerSignal]) : epoch
    signal.throwIfAborted()
    const token = await this.tokens(signal)
    signal.throwIfAborted()
    if (!token?.value) throw new GitHubError(401, GITHUB_CLI_SETUP_REQUIRED)
    if (this.checked) this.adoptConnectedBinding(this.checked.scope)
    const key = this.bindingKey(), fingerprint = sha256(token.value)
    const scope = this.checked?.key === key && this.checked.fingerprint === fingerprint ? this.checked.scope
      : await this.acquire(token, key, fingerprint, epoch, signal, connect)
    signal.throwIfAborted(); this.check(scope)
    if (!connect && this.binding().participantId !== undefined && this.binding().participantId !== scope.connection.identity.id) throw new GitHubError(409, 'The GitHub account changed. Connect this account before continuing.')
    const channel = this.channel()
    let cache = scope.channels.get(channel)
    if (!cache) { cache = this.newCache(channel); scope.channels.set(channel, cache); scope.caches.add(cache) }
    cache.active++
    const session: Session = { token, scope, cache, signal: AbortSignal.any([signal, scope.signal]), active: true, reusable: true, pending: new Set() }
    try { return await action(session) }
    finally { session.active = false; session.token = undefined; cache.active--; this.maintainCache(scope, cache) }
  }
  private readSession<T>(action: (session: Session) => Promise<T>, ownerSignal?: AbortSignal): Promise<T> {
    const owner = this.readers.getStore()
    if (!owner) return this.session(action, false, ownerSignal)
    if (!owner.active) return Promise.reject(new Error('Read operation ownership has ended.'))
    this.check(owner.scope)
    const signal = ownerSignal ? AbortSignal.any([owner.signal, ownerSignal]) : owner.signal
    const result = owner.reusable && owner.cache.channel === this.channel() ? action(ownerSignal ? { ...owner, signal } : owner) : this.session(action, false, signal)
    owner.pending.add(result)
    void result.then(() => owner.pending.delete(result), () => owner.pending.delete(result))
    return result
  }
  async withReadOperation<T>(action: () => Promise<T>): Promise<T> {
    const existing = this.readers.getStore()
    if (existing?.active && existing.reusable && existing.cache.channel === this.channel()) { this.check(existing.scope); return action() }
    const controller = new AbortController()
    return this.session(owner => this.readers.run(owner, async () => {
      let result!: T, failure: unknown, failed = false
      try { result = await action() } catch (error) { failed = true; failure = error }
      owner.active = false
      if (owner.pending.size) {
        failed = true; failure ??= new Error('Read operation callback ended with unawaited requests.')
        controller.abort(failure)
        await Promise.allSettled([...owner.pending])
      }
      if (failed) throw failure
      this.check(owner.scope)
      return result
    }), false, existing?.active ? AbortSignal.any([controller.signal, existing.signal]) : controller.signal)
  }
  private async run(session: Session, command: GitObjectCommand, input?: Uint8Array | string): Promise<Buffer> {
    if (!session.active || !session.token) throw new Error('Read operation ownership has ended.')
    this.check(session.scope); session.signal.throwIfAborted()
    const started = performance.now()
    let success = false, details: FailureDetails | undefined
    const notify = (phase: 'start' | 'end') => {
      try { this.options.onOperation?.({ channel: session.cache.channel, operation: command.op, phase, ...(phase === 'end' ? { elapsedMs: performance.now() - started, success, ...(details ? { failureDetails: details } : {}) } : {}), httpRequests: null, packBytes: null }) } catch { /* Diagnostics cannot change operation semantics. */ }
    }
    notify('start')
    try {
      const output = await session.cache.transport.execute(command, { signal: session.signal, token: session.token.value, input, fixtureTransport: session.scope.fixture })
      this.check(session.scope); session.signal.throwIfAborted()
      success = true
      return output
    } catch (error) {
      details = failureDetails(error)
      if (error instanceof GitBackendError && error.kind === 'fatal') {
        // A failed/cancelled process invalidates only its owning lane and stores.
        // Persisted operation metadata remains available for remote reconciliation.
        const { scope, cache } = session
        for (const candidate of scope.caches) if (candidate.transport.lifetime === cache.transport.lifetime) { candidate.broken = true; candidate.retired = true }
        if (!scope.signal.aborted && scope.channels.get(cache.channel)?.broken) {
          const next = this.newCache(cache.channel); scope.channels.set(cache.channel, next); scope.caches.add(next)
        }
      }
      if (error instanceof GitBackendError && error.kind === 'missing_branch') throw Object.assign(new GitHubError(404, error.message), { cause: error })
      if (error instanceof GitBackendError && error.kind === 'auth') {
        // An actual upstream permission failure invalidates authority. No timer or
        // pre-emptive permission probe is introduced for ordinary reads/writes.
        if (this.checked?.scope === session.scope) this.checked = undefined
        session.scope.controller.abort(error)
        this.retire(this.releaseScope(session.scope))
        throw Object.assign(new GitHubError(403, error.message), { cause: error })
      }
      throw error
    } finally { notify('end') }
  }
  async connect(): Promise<RepoConnection> { return this.session(async session => { session.scope.canonicalPending = true; return session.scope.connection }, true) }
  /** Reuse only actual immutable objects requested in this same cache.
   * Different objects and fresh remote-ref observations do not share a tail. */
  private async fetchObjects<T>(session: Session, keys: readonly string[], action: () => Promise<T>): Promise<T> {
    const { scope, cache } = session, selected = [...new Set(keys)]
    const prior = Promise.all(selected.map(key => cache.fetching.get(key)))
    let unlock!: () => void
    const done = new Promise<void>(resolve => { unlock = resolve }), tail = prior.then(() => done)
    for (const key of selected) cache.fetching.set(key, tail)
    void tail.then(() => {
      for (const key of selected) if (cache.fetching.get(key) === tail) cache.fetching.delete(key)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(session.signal.reason)
        session.signal.addEventListener('abort', abort, { once: true })
        if (session.signal.aborted) abort()
        void prior.then(() => resolve()).finally(() => session.signal.removeEventListener('abort', abort))
      })
      this.check(scope); session.signal.throwIfAborted()
      return await action()
    } finally { unlock() }
  }
  private async head(session: Session): Promise<string> {
      const scope = session.scope, cache = session.cache, ref = 'refs/heads/' + scope.connection.repository.branch
      const head = (await this.run(session, { op: 'fetchHead', remote: scope.remote, ref, tip: cache.negotiationTip })).toString('utf8').trim()
      if (!head) return ''
      if (!oid(head)) throw new Error('Git returned an invalid branch observation.')
      cache.metadata.add(head)
      if (cache.negotiationTip !== head) cache.dirty = true
      cache.negotiationTip = head // Immutable-object negotiation hint only; never a branch authority.
      return head
  }
  private async metadata(session: Session, revision: string): Promise<void> {
    if (!oid(revision)) throw new Error('Invalid Git commit id.')
    // Confirmed immutable metadata does not wait behind an unrelated fetch.
    if (session.cache.metadata.has(revision)) {
      this.check(session.scope); session.signal.throwIfAborted()
      return
    }
    await this.fetchObjects(session, ['commit:' + revision], async () => {
      if (session.cache.metadata.has(revision)) return
      await this.run(session, { op: 'fetchMetadata', remote: session.scope.remote, revision })
      session.cache.metadata.add(revision)
      session.cache.dirty = true
    })
  }
  private async objects(session: Session, ids: readonly string[], kind: 'blob' | 'commit' = 'blob', commitDepth?: number): Promise<void> {
    if (ids.some(id => !oid(id))) throw new Error('Invalid Git object id.')
    // Already-confirmed immutable objects do not wait behind an unrelated fetch.
    if (ids.every(id => session.cache.present.has(id))) return
    await this.fetchObjects(session, ids.map(id => kind + ':' + id), async () => {
      const missing = [...new Set(ids)].filter(id => !session.cache.present.has(id))
      if (missing.length) {
        const output = await this.run(session, { op: 'ensureObjects', remote: session.scope.remote, ids: missing, kind, ...(commitDepth ? { commitDepth } : {}) })
        const supplied = commitDepth ? output.toString('utf8').trim().split('\n') : missing
        if (commitDepth && (supplied.length > commitDepth || supplied[0] !== missing[0] || new Set(supplied).size !== supplied.length || supplied.some(id => !oid(id)))) throw new Error('Git returned invalid commit history identities.')
        session.cache.dirty = true
        for (const id of supplied) session.cache.present.add(id)
      }
    })
  }
  private async commitObject(session: Session, id: string, history = false): Promise<Commit> {
    const known = session.cache.commits.get(id)
    if (known) return known
    if (!session.cache.metadata.has(id) && !session.cache.present.has(id)) await this.objects(session, [id], 'commit', history ? 64 : undefined)
    const bytes = await this.run(session, { op: 'readObject', kind: 'commit', id }), text = bytes.toString('utf8'), split = text.indexOf('\n\n')
    const headers = text.slice(0, split).split('\n'), tree = headers.find(line => line.startsWith('tree '))?.slice(5) ?? ''
    const parents = headers.filter(line => line.startsWith('parent ')).map(line => line.slice(7))
    const timestamp = Number(headers.find(line => line.startsWith('committer '))?.match(/ (\d+) [+-]\d{4}$/)?.[1] ?? 0)
    if (split < 0 || !oid(tree) || parents.some(parent => !oid(parent)) || !Number.isSafeInteger(timestamp)) throw new Error('Invalid Git commit object.')
    const commit = { tree, parents, message: text.slice(split + 2), timestamp }
    session.cache.commits.set(id, commit)
    return commit
  }
  private async tree(session: Session, id: string): Promise<Entry[]> {
    if (!id) return []
    const known = session.cache.trees.get(id)
    if (known) return known
    // Revision acquisition already supplied all tree metadata. Never probe each
    // directory with another Git process before reading its known local tree.
    const result = await this.run(session, { op: 'readTree', id })
    const entries = new TextDecoder('utf-8', { fatal: true }).decode(result).split('\0').filter(Boolean).map(value => {
      const split = value.indexOf('\t'), [mode, type, sha] = value.slice(0, split).split(' '), path = value.slice(split + 1)
      if (split < 0 || !mode || !sha || !oid(sha) || !['blob', 'tree', 'commit'].includes(type!) || path.includes('/') || !path || path === '.' || path === '..'
        || !(type === 'blob' ? ['100644', '100755', '120000'].includes(mode) : type === 'tree' ? mode === '040000' : mode === '160000')) throw new Error('Invalid Git tree object.')
      return { mode, type: type as Entry['type'], sha, path }
    })
    if (new Set(entries.map(entry => entry.path)).size !== entries.length) throw new Error('Duplicate names in Git tree object.')
    session.cache.trees.set(id, entries)
    return entries
  }
  private makeSnapshot(session: Session, head: string, tree: string, signal?: AbortSignal, observedHead = false): GitSnapshot {
    const { scope, cache } = session
    this.check(scope)
    const snapshot: GitSnapshot = { head, tree, files: new Map(), reads: new Map() }
    const state: State = { observedHead, publicationSequence: scope.publicationSequence, scope, cache, signal, loaded: new Set(), pathErrors: new Map() }
    this.states.set(snapshot, state)
    cache.snapshots.set(state, new WeakRef(snapshot))
    return snapshot
  }
  /** An independently cancellable lease of an already observed immutable view.
   * No branch acquisition, credentials, or remote request is added. */
  borrowSnapshot(snapshot: GitSnapshot, signal: AbortSignal): GitSnapshot {
    signal.throwIfAborted()
    const parent = this.state(snapshot)
    const borrowed: GitSnapshot = { head: snapshot.head, tree: snapshot.tree, files: new Map(snapshot.files), reads: new Map(snapshot.reads) }
    const state: State = { ...parent, signal: parent.signal ? AbortSignal.any([parent.signal, signal]) : signal,
      loaded: new Set(parent.loaded), pathErrors: new Map(parent.pathErrors) }
    this.states.set(borrowed, state)
    state.cache.snapshots.set(state, new WeakRef(borrowed))
    return borrowed
  }
  private state(snapshot: GitSnapshot, session?: Session): State {
    if (this.readers.getStore()?.active === false) throw new Error('Read operation ownership has ended.')
    const state = this.states.get(snapshot)
    if (!state) throw new Error('Use a snapshot obtained from this repository.')
    if (state.cache.released || state.cache.broken) throw new Error('Snapshot transport was released or interrupted; obtain a fresh snapshot.')
    state.signal?.throwIfAborted()
    this.check(state.scope)
    if (session && state.scope !== session.scope) throw new GitHubError(409, 'The Git authorization changed. Read a new snapshot before continuing.')
    return state
  }
  private async readSnapshot<T>(snapshot: GitSnapshot, action: (session: Session) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const state = this.state(snapshot), owned = state.signal
    state.cache.active++
    try {
      return await this.readSession(session => action({ ...session, cache: state.cache }), owned && signal ? AbortSignal.any([owned, signal]) : owned ?? signal)
    } finally { state.cache.active--; this.maintainCache(state.scope, state.cache) }
  }
  private physical(scope: Scope, path: string): string {
    if (path === 'dss-coop') return scope.directory
    if (!validCoopPath(path)) throw new Error('Choose a record inside the configured DSS directory.')
    return (scope.directory ? scope.directory + '/' : '') + path.slice('dss-coop/'.length)
  }
  private async entry(session: Session, snapshot: GitSnapshot, path: string): Promise<Entry | undefined> {
    const state = this.state(snapshot, session), physical = this.physical(state.scope, path)
    if (state.pathErrors.has(path)) throw state.pathErrors.get(path)
    if (!snapshot.tree) return
    let id = snapshot.tree
    if (!physical) return { path: '', type: 'tree', mode: '040000', sha: id }
    const parts = physical.split('/')
    for (let index = 0; index < parts.length; index++) {
      const entry = (await this.tree(session, id)).find(entry => entry.path === parts[index])
      if (!entry) return
      if (index === parts.length - 1) return entry
      if (entry.type !== 'tree') return
      id = entry.sha
    }
  }
  /** Transfers an already verified remote observation after a proven conflict.
   * It is not a cached branch hint and cannot be fabricated by callers. */
  takeConflictSnapshot(error: unknown): GitSnapshot | undefined {
    if (!(error instanceof GitConflictError)) return
    const snapshot = this.conflicts.get(error)
    this.conflicts.delete(error)
    if (snapshot) this.state(snapshot)
    return snapshot
  }
  private async conflict(session: Session, head: string): Promise<GitConflictError> {
    const error = new GitConflictError()
    if (head) {
      await this.metadata(session, head)
      this.conflicts.set(error, this.makeSnapshot(session, head, (await this.commitObject(session, head)).tree, session.signal, true))
    }
    return error
  }
  /** Compare only consumed metadata, including absence, type/mode and selected
   * membership. Ancestor tree OIDs are never predicates on unrelated siblings. */
  async dependenciesEqual(base: GitSnapshot, current: GitSnapshot, dependencies: GitReadDependencies): Promise<boolean> {
    const describe = (snapshot: GitSnapshot) => this.readSnapshot(snapshot, async session => {
      const pathEntry = async (path: string): Promise<unknown> => {
        const physical = this.physical(session.scope, path), parts = physical.split('/')
        let tree = snapshot.tree
        for (let index = 0; index < parts.length; index++) {
          const found = (await this.tree(session, tree)).find(row => row.path === parts[index])
          if (!found) return null
          if (index === parts.length - 1 || found.type !== 'tree') return [index, found.type, found.mode, found.sha]
          tree = found.sha
        }
        return null
      }
      const result: unknown[] = []
      for (const path of dependencies.files) result.push([path, await pathEntry(path)])
      for (const query of dependencies.lists) {
        const root = query.prefix.replace(/\/$/, ''), entry = await this.entry(session, snapshot, root)
        const rows: unknown[][] = []
        const visit = async (tree: string, prefix: string): Promise<void> => {
          for (const child of await this.tree(session, tree)) {
            const path = prefix + '/' + child.path
            if (child.type === 'tree' && query.recursive) {
              if (mayContainSelectedFiles(path.slice('dss-coop/'.length), query.selection)) await visit(child.sha, path)
            } else if (child.type === 'blob' && matchesFileSelection(path.slice('dss-coop/'.length), query.selection)) {
              rows.push(query.namesOnly ? [path] : [path, child.type, child.mode, child.sha])
            }
          }
        }
        if (entry?.type === 'tree') await visit(entry.sha, root)
        // A non-directory at the selector root is distinct from an absent root;
        // adding an empty directory has no selected members and is harmless.
        const shape = await pathEntry(root)
        result.push([query, Array.isArray(shape) && shape[1] !== 'tree' ? shape : null, rows.sort((a,b) => String(a[0]).localeCompare(String(b[0])))])
      }
      return result
    })
    this.state(base); this.state(current)
    return isDeepStrictEqual(await describe(base), await describe(current))
  }
  snapshot(_afterWrite = false, plan?: GitReadPlan): Promise<GitSnapshot> {
    plan?.signal?.throwIfAborted()
    return this.readSession(async session => {
      const head = await this.head(session), tree = head ? (await this.commitObject(session, head)).tree : ''
      const snapshot = this.makeSnapshot(session, head, tree, plan?.signal, true)
      if (plan) await this.prefetchInSession(session, snapshot, plan)
      return snapshot
    }, plan?.signal)
  }
  at(revision: string): Promise<GitSnapshot> {
    if (!oid(revision)) return Promise.reject(new Error('Use a Git commit id.'))
    return this.readSession(async session => {
      await this.metadata(session, revision)
      return this.makeSnapshot(session, revision, (await this.commitObject(session, revision)).tree)
    })
  }
  private async prefetchInSession(session: Session, snapshot: GitSnapshot, plan: GitReadPlan): Promise<void> {
    const state = this.state(snapshot, session), directories = new Set(plan.directories ?? []), files = new Set(plan.files ?? [])
    const bodies: Array<{ path: string; sha: string }> = []
    // Tree metadata is acquired with the immutable revision, independently of
    // directory depth. Resolve only requested paths locally and batch their blobs.
    for (const path of new Set([...directories, ...(plan.files ?? [])])) {
      plan.signal?.throwIfAborted()
      try {
        const entry = await this.entry(session, snapshot, path)
        if (entry?.type === 'tree' && directories.has(path)) await this.tree(session, entry.sha)
        else if (entry?.type === 'blob' && files.has(path)) bodies.push({ path, sha: entry.sha })
      } catch (error) { if (!plan.isolatePathErrors || session.signal.aborted || plan.signal?.aborted) throw error; state.pathErrors.set(path, error) }
    }
    if (bodies.length) {
      try { await this.objects(session, bodies.map(body => body.sha)) }
      catch (error) {
        if (!plan.isolatePathErrors || session.signal.aborted || plan.signal?.aborted) throw error
        for (const body of bodies) state.pathErrors.set(body.path, error)
      }
    }
    plan.signal?.throwIfAborted()
  }
  async prefetch(snapshot: GitSnapshot, plan: GitReadPlan): Promise<void> { await this.readSnapshot(snapshot, session => this.prefetchInSession(session, snapshot, plan), plan.signal) }
  /** Discovery metadata only: does not populate snapshot files or reads and
   * must not substitute for exact, tracked business reads by the caller. */
  async directoryIndex(snapshot: GitSnapshot, prefix: string, previous?: GitDirectoryIndex, options?: GitDirectoryIndexOptions): Promise<GitDirectoryIndex> {
    const root = prefix.replace(/\/$/, '')
    return this.readSnapshot(snapshot, async session => {
      const state = this.state(snapshot, session), physical = this.physical(state.scope, root)
      if (state.pathErrors.has(root)) throw state.pathErrors.get(root)
      const index = await rebuildGitDirectoryIndex(snapshot.tree, root, physical, id => this.tree(session, id), previous, options)
      this.state(snapshot, session)
      return index
    })
  }
  async listDirectory(snapshot: GitSnapshot, prefix: string): Promise<Array<{ path: string; sha: string; type: 'blob' | 'tree' | 'commit'; size?: number }>> {
    const root = prefix.replace(/\/$/, '')
    return this.readSnapshot(snapshot, async session => {
      const entry = await this.entry(session, snapshot, root)
      return !entry || entry.type !== 'tree' ? [] : (await this.tree(session, entry.sha)).map(entry => ({ path: root + '/' + entry.path, sha: entry.sha, type: entry.type }))
    })
  }
  async directories(snapshot: GitSnapshot, prefix: string): Promise<string[]> {
    return (await this.listDirectory(snapshot, prefix)).filter(entry => entry.type === 'tree').map(entry => entry.path + '/')
  }
  async list(snapshot: GitSnapshot, prefix: string): Promise<void> {
    const root = prefix.replace(/\/$/, ''), state = this.state(snapshot)
    if (state.loaded.has(root)) return
    await this.readSnapshot(snapshot, async session => {
      const entry = await this.entry(session, snapshot, root), found = new Map<string, string>()
      const visit = async (id: string, path: string): Promise<void> => {
        for (const child of await this.tree(session, id)) {
          if (child.type === 'tree') await visit(child.sha, path + '/' + child.path)
          else if (child.type === 'blob') found.set(path + '/' + child.path, child.sha)
        }
      }
      if (entry?.type === 'tree') await visit(entry.sha, root)
      this.check(state.scope)
      for (const [path, sha] of found) (snapshot.files as Map<string, string>).set(path, sha)
      state.loaded.add(root)
    })
  }
  async readBytes(snapshot: GitSnapshot, path: string): Promise<Uint8Array | undefined> {
    return this.readSnapshot(snapshot, async session => {
      const entry = await this.entry(session, snapshot, path), sha = entry?.type === 'blob' ? entry.sha : undefined
      snapshot.reads?.set(path, sha)
      if (!sha) return
      await this.objects(session, [sha])
      const bytes = await this.run(session, { op: 'readObject', kind: 'blob', id: sha })
      if (createHash(sha.length === 64 ? 'sha256' : 'sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex') !== sha) throw new Error('Git blob integrity mismatch: ' + path)
      session.cache.hotBlobs.set(sha, { bytes: bytes.length, used: performance.now() })
      ;(snapshot.files as Map<string, string>).set(path, sha)
      return bytes
    })
  }
  async read(snapshot: GitSnapshot, path: string): Promise<string | undefined> {
    const bytes = await this.readBytes(snapshot, path)
    return bytes === undefined ? undefined : new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
  async changes(snapshot: GitSnapshot, from: string, _ownInstance?: string): Promise<GitFileChange[]> {
    this.state(snapshot)
    if (snapshot.head === from) return []
    const before = from ? await this.at(from) : undefined
    await this.list(snapshot, 'dss-coop/')
    if (before) await this.list(before, 'dss-coop/')
    return [...new Set([...snapshot.files.keys(), ...(before?.files.keys() ?? [])])].sort().flatMap(path => {
      const old = before?.files.get(path), next = snapshot.files.get(path)
      return old === next ? [] : [{ path, status: !old ? 'A' as const : !next ? 'D' as const : 'M' as const, commit: snapshot.head, parent: from || undefined, before: old, after: next }]
    })
  }
  private writes(changes: readonly GitChange[], captured?: readonly (Buffer | null)[]): GitCommitOperation['writes'] {
    if (changes.some(change => !validCoopPath(change.path))) throw new Error('Commit changes inside the configured DSS directory.')
    if (new Set(changes.map(change => change.path)).size !== changes.length) throw new Error('Duplicate paths in a Git transaction.')
    const paths = changes.map(change => change.path).sort()
    if (paths.some((path, i) => i > 0 && path.startsWith(paths[i - 1]! + '/'))) throw new Error('A Git transaction cannot write both a file and its child.')
    return changes.map((change, index) => { const bytes = captured ? captured[index]! : changeBytes(change); return { path: change.path, sha256: bytes === null ? null : sha256(bytes), ...(change.deleteTree ? { deleteTree: true as const } : {}) } })
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  }
  prepareCommit(base: GitSnapshot, changes: readonly GitChange[], message: string): GitCommitOperation {
    const { scope } = this.state(base), writes = this.writes(changes)
    if (!base.head) throw new Error('Initialize the empty repository with ensureBranch before committing a business transaction.')
    const requestHash = sha256(JSON.stringify({ writes, message }))
    const id = sha256(JSON.stringify([scope.connection.repository.id, scope.connection.repository.branch, scope.directory, scope.connection.identity.id, base.head, requestHash]))
    const preparations = this.prepared.get(base) ?? new Map<string, Preparation>()
    let preparation = preparations.get(id) ?? scope.preparations.get(id)?.deref()
    const operation: GitCommitOperation = { version: 1, id, expectedHead: base.head, repositoryId: scope.connection.repository.id, repository: scope.connection.repository.fullName,
      branch: scope.connection.repository.branch, directory: scope.directory, authorId: scope.connection.identity.id, writes, requestHash, preparedAt: preparation?.operation.preparedAt ?? Math.floor(Date.now() / 1000) }
    if (!preparation) {
      preparation = { operation: structuredClone(operation), dispatched: false }
      const reference = new WeakRef(preparation)
      scope.preparations.set(id, reference)
      this.preparationFinalizer.register(preparation, { scope: new WeakRef(scope), id, reference })
    }
    preparations.set(id, preparation); this.prepared.set(base, preparations)
    this.operationOwners.set(operation, { preparation, snapshot: new WeakRef(base) })
    return operation
  }
  private freshOperation(base: GitSnapshot, operation: GitCommitOperation): boolean {
    const owner = this.operationOwners.get(operation)
    return !!owner && owner.snapshot.deref() === base && this.state(base).observedHead
      && !owner.preparation.dispatched && isDeepStrictEqual(owner.preparation.operation, operation)
  }
  private validateOperation(operation: GitCommitOperation): void {
    if (operation.preparedAt !== undefined && (!Number.isSafeInteger(operation.preparedAt) || operation.preparedAt < 0)
      || operation.version !== 1 || !/^[0-9a-f-]+$/i.test(operation.id) || !oid(operation.expectedHead) || !/^[0-9a-f]{64}$/.test(operation.requestHash)
      || operation.writes.some(write => !validCoopPath(write.path) || write.sha256 !== null && !/^[0-9a-f]{64}$/.test(write.sha256) || write.deleteTree !== undefined && (write.deleteTree !== true || write.sha256 !== null))
      || new Set(operation.writes.map(write => write.path)).size !== operation.writes.length) throw new Error('Invalid persisted Git operation metadata.')
  }
  private matchesScope(scope: Scope, op: GitCommitOperation): boolean {
    return scope.connection.repository.id === op.repositoryId && scope.connection.repository.fullName === op.repository
      && scope.connection.repository.branch === op.branch && scope.directory === op.directory && scope.connection.identity.id === op.authorId
  }
  private async buildTree(session: Session, baseTree: string, writes: readonly { path: string; bytes: Buffer | null; digest?: string; deleteTree?: true }[]): Promise<string> {
    const edit = async (tree: string, updates: readonly { path: string; bytes: Buffer | null; digest?: string; deleteTree?: true }[]): Promise<string> => {
      const entries = new Map((await this.tree(session, tree)).map(entry => [entry.path, { ...entry }]))
      const groups = new Map<string, Array<{ path: string; bytes: Buffer | null; digest?: string; deleteTree?: true }>>()
      for (const update of updates) {
        const slash = update.path.indexOf('/')
        if (slash < 0) {
          const prior = entries.get(update.path)
          if (update.deleteTree) {
            if (prior && prior.type !== 'tree') throw new Error('An explicit directory deletion cannot remove a file or Git submodule.')
            entries.delete(update.path)
            continue
          }
          if (prior?.type === 'tree' || prior?.type === 'commit') throw new Error('A file transaction cannot replace a directory or Git submodule.')
          if (update.bytes === null) entries.delete(update.path)
          else {
            const digest = update.digest ?? sha256(update.bytes)
            let sha = session.cache.writtenBlobs.get(digest)
            if (!sha) {
              sha = (await this.run(session, { op: 'writeBlob' }, update.bytes)).toString('utf8').trim()
              if (oid(sha)) session.cache.writtenBlobs.set(digest, sha)
            }
            if (!oid(sha)) throw new Error('Git returned an invalid blob id.')
            session.cache.present.add(sha)
            session.cache.hotBlobs.set(sha, { bytes: update.bytes.length, used: performance.now() })
            session.cache.dirty = true
            entries.set(update.path, { path: update.path, type: 'blob', mode: prior?.mode === '100755' ? '100755' : '100644', sha })
          }
        } else {
          const name = update.path.slice(0, slash), rest = { path: update.path.slice(slash + 1), bytes: update.bytes, digest: update.digest, ...(update.deleteTree ? { deleteTree: true as const } : {}) }
          const group = groups.get(name) ?? []; group.push(rest); groups.set(name, group)
        }
      }
      for (const [name, updates] of groups) {
        const prior = entries.get(name)
        if (prior && prior.type !== 'tree') throw new Error('A file transaction cannot traverse a file or Git submodule.')
        const sha = await edit(prior?.sha ?? '', updates)
        if (!(await this.tree(session, sha)).length) entries.delete(name)
        else entries.set(name, { path: name, sha, type: 'tree', mode: '040000' })
      }
      const body = Buffer.from([...entries.values()].map(entry => `${entry.mode} ${entry.type} ${entry.sha}\t${entry.path}\0`).join(''), 'utf8')
      const id = (await this.run(session, { op: 'writeTree' }, body)).toString('utf8').trim()
      if (!oid(id)) throw new Error('Git returned an invalid tree id.')
      session.cache.trees.set(id, [...entries.values()])
      return id
    }
    return edit(baseTree, writes)
  }
  private async makeCommit(session: Session, tree: string, parent: string, message: string, preparedAt?: number): Promise<string> {
    // New operations retain their actual preparation time across restarts. The
    // legacy fallback is deterministic for already-persisted receipts lacking it.
    const timestamp = preparedAt ?? (parent ? (await this.commitObject(session, parent)).timestamp + 1 : Math.floor(Date.now() / 1000))
    const identity = 'DSS ' + session.scope.connection.identity.id
    const email = session.scope.connection.identity.id + '@users.noreply.github.com'
    const object = JSON.parse((await this.run(session, { op: 'writeCommit', tree, parent, identity, email, timestamp }, message)).toString('utf8')) as Commit & { id: string }
    const commit = object.id
    if (!oid(commit) || object.tree !== tree || !Array.isArray(object.parents) || object.parents.length !== (parent ? 1 : 0) || parent && object.parents[0] !== parent
      || object.timestamp !== timestamp || object.message !== (message.endsWith('\n') ? message : message + '\n')) throw new Error('Prepared Git commit does not match its exact requested contents and parent.')
    session.cache.present.add(commit)
    session.cache.commits.set(commit, { tree: object.tree, parents: object.parents, message: object.message, timestamp: object.timestamp })
    if (!parent || session.cache.metadata.has(parent)) session.cache.metadata.add(commit)
    return commit
  }
  private async push(session: Session, commit: string, expectedHead: string): Promise<void> {
    const ref = 'refs/heads/' + session.scope.connection.repository.branch
    await this.run(session, { op: 'push', remote: session.scope.remote, ref, commit, expected: expectedHead })
  }
  private async resolve(session: Session, operation: GitCommitOperation, knownHead?: string): Promise<GitCommitResolution> {
    if (!this.matchesScope(session.scope, operation)) return { status: 'unknown', reason: 'Repository, branch or account changed; resolve in the original scope.' }
    const head = knownHead ?? await this.head(session)
    if (head === operation.expectedHead) return { status: 'pending', head }
    let cursor = head
    while (cursor && cursor !== operation.expectedHead) {
      // Only reconciliation walks history. Fetch a bounded commit-only batch when
      // its next parent is missing; ordinary snapshots and writes stay depth one.
      const commit = await this.commitObject(session, cursor, true), lines = commit.message.split('\n')
      if (lines.includes('DSS-Operation: ' + operation.id)) {
        if (commit.parents.length !== 1 || commit.parents[0] !== operation.expectedHead || !lines.includes('DSS-Request-SHA256: ' + operation.requestHash)) return { status: 'unknown', head, reason: 'Operation marker does not match the prepared transaction.' }
        await this.metadata(session, cursor)
        const snapshot = this.makeSnapshot(session, cursor, commit.tree)
        try {
          await this.prefetchInSession(session, snapshot, { files: operation.writes.map(write => write.path) })
          for (const write of operation.writes) {
            const entry = await this.entry(session, snapshot, write.path)
            let hash: string | null = null
            if (entry) {
              if (entry.type !== 'blob') return { status: 'unknown', head, reason: 'Operation content verification found a non-file at a prepared path.' }
              await this.objects(session, [entry.sha])
              const bytes = await this.run(session, { op: 'readObject', kind: 'blob', id: entry.sha })
              if (createHash(entry.sha.length === 64 ? 'sha256' : 'sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex') !== entry.sha) throw new Error('Git blob integrity mismatch.')
              hash = sha256(bytes)
            }
            if (hash !== write.sha256) return { status: 'unknown', head, reason: 'Operation content verification differs from its prepared hashes.' }
          }
          return { status: 'confirmed', commit: cursor, head }
        } finally { this.releaseSnapshot(snapshot) }
      }
      cursor = commit.parents[0] ?? ''
    }
    return cursor === operation.expectedHead ? { status: 'conflict', head } : { status: 'unknown', head, reason: 'Expected base is not on the current first-parent chain; history may have been rewritten.' }
  }
  async resolveCommit(operation: GitCommitOperation): Promise<GitCommitResolution> {
    this.validateOperation(operation)
    operation = { ...operation, writes: operation.writes.map(write => ({ ...write })) }
    try { return await this.session(async session => {
      const pending = session.scope.pendingOperations.get(operation.id)
      if (pending && !isDeepStrictEqual(pending.operation, operation)) return { status: 'unknown', reason: 'Unresolved operation metadata differs from its original dispatch.' }
      const result = await this.resolve(session, operation)
      if (result.status === 'confirmed' || result.status === 'conflict') this.settleOperation(session.scope, operation.id)
      return result
    }) }
    catch (error) { return { status: 'unknown', reason: error instanceof Error ? error.message : String(error), failureDetails: failureDetails(annotateFailure(error, { phase: 'resolution' })) } }
  }
  /** Calls for the same original operation remain ordered. Distinct operations
   * publish with their own exact-ref compare-and-swap and normal conflict handling. */
  async commitPrepared(base: GitSnapshot, changes: readonly GitChange[], message: string, operation: GitCommitOperation, onDispatch?: () => void, isUndispatched?: () => boolean): Promise<GitReceipt> {
    const owner = this.operationOwners.get(operation)
    let reported = false
    const reportDispatch = () => { if (!reported) { onDispatch?.(); reported = true } }
    // Ordinary cloned/recovered inputs retain conservative ownership. A live
    // command may supply its existing session proof instead; it is rechecked
    // inside the same-ID queue before this resumed operation can proceed.
    if (!isUndispatched && (!owner || owner.snapshot.deref() !== base || !this.states.get(base)?.observedHead
      || owner.preparation.dispatched || !isDeepStrictEqual(owner.preparation.operation, operation))) reportDispatch()
    const state = this.state(base), scope = state.scope, head = base.head, tree = base.tree
    this.validateOperation(operation)
    // Capture before queueing. A caller cannot mutate an already submitted
    // operation or its byte buffers while another Git publication finishes.
    const capturedChanges: GitChange[] = changes.map(change => {
      const bytes = changeBytes(change)
      return bytes === null ? { path: change.path, content: null, ...(change.deleteTree ? { deleteTree: true as const } : {}) } : { path: change.path, bytes }
    })
    const captured = { ...operation, writes: operation.writes.map(write => ({ ...write })) }
    if (owner) this.operationOwners.set(captured, owner)
    const channel = this.writeChannel()
    const signal = state.signal ? AbortSignal.any([scope.signal, state.signal]) : scope.signal
    // The same operation may arrive through different writer lanes. Only that id
    // shares a tail; unrelated foreground/background/periodic publications stay separate.
    const prior = Promise.resolve(scope.operationTails.get(operation.id))
    let unlock!: () => void
    const done = new Promise<void>(resolve => { unlock = resolve })
    // A canceled waiter may leave immediately, but its tail still waits for the
    // predecessor. A later call for this same operation cannot pass it.
    const tail = prior.then(() => done)
    scope.operationTails.set(captured.id, tail)
    void tail.then(() => {
      if (scope.operationTails.get(captured.id) === tail) scope.operationTails.delete(captured.id)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
        void prior.then(resolve).finally(() => signal.removeEventListener('abort', abort))
      })
      this.state(base); signal.throwIfAborted()
      if (base.head !== head || base.tree !== tree) throw new Error('Queued Git snapshot was changed.')
      return await this.withChannel(channel, () => this.commitPreparedNow(base, capturedChanges, message, captured, reportDispatch, isUndispatched))
    } catch (error) {
      // Scope handoff may also report UNKNOWN before this invocation's push.
      // Preserve that declared original-operation responsibility unchanged.
      if (error instanceof GitCommitOutcomeUnknownError) reportDispatch()
      throw error
    } finally {
      // Another owner may have dispatched while this call waited for its ID.
      unlock()
      if (owner?.preparation.dispatched) reportDispatch()
    }
  }
  private async commitPreparedNow(base: GitSnapshot, changes: readonly GitChange[], message: string, operation: GitCommitOperation, onDispatch: () => void, isUndispatched?: () => boolean): Promise<GitReceipt> {
    const owner = this.readers.getStore()
    if (owner) owner.reusable = false
    const captured = changes.map(changeBytes), writes = this.writes(changes, captured), state = this.state(base)
    this.validateOperation(operation)
    const preparedHere = operation
    operation = { ...operation, writes: operation.writes.map(write => ({ ...write })) }
    if (operation.expectedHead !== base.head || JSON.stringify(writes) !== JSON.stringify(operation.writes) || sha256(JSON.stringify({ writes, message })) !== operation.requestHash) throw new Error('Prepared Git operation was reused for different input or snapshot.')
    const digests = new Map(writes.map(write => [write.path, write.sha256]))
    const frozen = changes.map((change, index) => ({ path: this.physical(state.scope, change.path), bytes: captured[index]!, digest: digests.get(change.path) ?? undefined, ...(change.deleteTree ? { deleteTree: true as const } : {}) }))
    state.cache.active++
    try { return await this.session(async current => {
      const session = { ...current, signal: state.signal ? AbortSignal.any([current.signal, state.signal]) : current.signal }
      if (!this.matchesScope(session.scope, operation) || session.scope !== state.scope) throw new GitCommitOutcomeUnknownError(operation, { cause: new Error('Repository scope or account changed.') })
      const pending = session.scope.pendingOperations.get(operation.id)
      if (pending && !isDeepStrictEqual(pending.operation, operation)) throw new GitCommitOutcomeUnknownError(pending.operation, { cause: new Error('Unresolved operation metadata differs from its original dispatch.') })
      // Token acquisition can yield. Check shared provenance afterwards, so a
      // concurrent resolution/dispatch cannot restore freshness to this capture.
      // The callback reads existing session ownership, inside the same-ID tail
      // and after token acquisition. Another dispatch cannot pass this operation
      // while its preparation awaits I/O. UNKNOWN never becomes an unsent retry.
      if (isUndispatched && (pending || session.scope.preparations.get(operation.id)?.deref()?.dispatched || !isUndispatched()))
        throw new GitCommitOutcomeUnknownError(operation, { cause: new Error('Original operation is no longer known to be undispatched.') })
      const fresh = this.freshOperation(base, preparedHere)
      if (!fresh && !isUndispatched) onDispatch()
      // Only after the original input and current authority checks: this Host
      // confirmed a publication past H after this snapshot was acquired. This
      // negative hint returns normal conflict; callers still fetch remote HEAD
      // and rebuild. It never supplies an authoritative head or a new parent.
      if (fresh && (session.scope.confirmedBases.get(base.head) ?? 0) > state.publicationSequence) throw new GitConflictError()
      // Only a genuinely fresh in-memory operation can omit preflight. The
      // exact-H lease on push is the atomic authority check, not a prior HEAD.
      // Persisted/previously-dispatched operations still reconcile first.
      if (!fresh) {
        const before = await this.head(session)
        if (before !== operation.expectedHead) {
          const resolution = await this.resolve(session, operation, before)
          if (resolution.status === 'confirmed') { this.settleOperation(session.scope, operation.id); return { commit: resolution.commit, replay: true } }
          if (resolution.status === 'conflict') { this.settleOperation(session.scope, operation.id); throw await this.conflict(session, resolution.head) }
          throw new GitCommitOutcomeUnknownError(operation)
        }
      }
      // Borrowed discovery snapshots keep their immutable authority and lease,
      // but must not donate their read helper to a publication. Import only H's
      // commit/tree metadata into the selected writer when that lane lacks it.
      // This is not another HEAD observation and never downloads unrelated blobs.
      // Failures here precede push; retain ordinary pre-dispatch error semantics.
      if (base.head && !session.cache.metadata.has(base.head)) await this.metadata(session, base.head)
      const tree = await this.buildTree(session, base.tree, frozen)
      const commit = await this.makeCommit(session, tree, base.head, message + '\n\nDSS-Operation: ' + operation.id + '\nDSS-Request-SHA256: ' + operation.requestHash + '\n', operation.preparedAt)
      let failure: unknown
      const preparation = session.scope.preparations.get(operation.id)?.deref()
      const firstDispatch = !!preparation && !preparation.dispatched
      onDispatch()
      if (preparation) preparation.dispatched = true
      // UNKNOWN keeps the original complete metadata and preparation alive until
      // remote reconciliation settles it. It is an intentional live set.
      session.scope.pendingOperations.set(operation.id, { operation, preparation })
      session.cache.pending.add(operation.id)
      try {
        await this.push(session, commit, base.head)
        session.scope.confirmedBases.delete(base.head)
        session.scope.confirmedBases.set(base.head, ++session.scope.publicationSequence)
        // 64 recent bases bound advisory memory. Eviction only restores the
        // ordinary exact-H push/conflict path, never changes correctness.
        if (session.scope.confirmedBases.size > 64) session.scope.confirmedBases.delete(session.scope.confirmedBases.keys().next().value!)
        this.settleOperation(session.scope, operation.id)
        if (session.cache.negotiationTip !== commit) session.cache.dirty = true
        session.cache.negotiationTip = commit
        return { commit, replay: false }
      }
      catch (error) { if (error instanceof GitHubError && [401, 403].includes(error.status)) throw error; failure = error }
      // This first attempt was rejected by send_pack's advertised-ref callback,
      // before its pack could be sent. There is no earlier dispatch to reconcile.
      // Reuse that actual remote head in the normal conflict/dependency path.
      if (fresh && firstDispatch && failure instanceof GitBackendError && failure.kind === 'stale' && failure.advertisedHead) {
        this.settleOperation(session.scope, operation.id)
        throw await this.conflict(session, failure.advertisedHead)
      }
      let resolution: GitCommitResolution | undefined, resolutionFailure: unknown
      try {
        const advertised = failure instanceof GitBackendError ? failure.advertisedHead : undefined
        if (advertised) await this.metadata(session, advertised)
        resolution = await this.resolve(session, operation, advertised)
      } catch (error) { resolutionFailure = error /* Preserve uncertain dispatch. */ }
      if (resolution?.status === 'confirmed') { this.settleOperation(session.scope, operation.id); return { commit: resolution.commit, replay: false } }
      if (resolution?.status === 'conflict') { this.settleOperation(session.scope, operation.id); throw await this.conflict(session, resolution.head) }
      if ((failure instanceof GitBackendError && failure.kind === 'stale') && (resolution?.status === 'pending' || fresh && firstDispatch)) { this.settleOperation(session.scope, operation.id); throw new GitConflictError() }
      if (resolution?.status === 'pending' && (failure instanceof GitBackendError && failure.kind === 'rejected')) { this.settleOperation(session.scope, operation.id); throw failure }
      throw annotateFailure(new GitCommitOutcomeUnknownError(operation, { cause: failure }), {
        phase: 'publication', resolution: { status: resolution?.status ?? 'failed', head: resolution?.head, error: resolutionFailure }
      })
    }) } finally { state.cache.active--; this.maintainCache(state.scope, state.cache) }
  }
  async commit(base: GitSnapshot, changes: readonly GitChange[], message: string): Promise<GitReceipt> {
    return this.commitPrepared(base, changes, message, this.prepareCommit(base, changes, message))
  }
  async ensureBranch(): Promise<GitSnapshot> {
    const owner = this.readers.getStore()
    if (owner) owner.reusable = false
    return this.session(async session => {
      const head = await this.head(session)
      if (head) return this.makeSnapshot(session, head, (await this.commitObject(session, head)).tree, undefined, true)
      const content = '# DSS collaboration\n\nShared conversation, task execution and durable records for DeepSeek Servant.\n'
      const tree = await this.buildTree(session, '', [{ path: this.physical(session.scope, 'dss-coop/README.md'), bytes: Buffer.from(content) }])
      const commit = await this.makeCommit(session, tree, '', 'Initialize DSS collaboration repository\n')
      let failure: unknown
      try { await this.push(session, commit, '') } catch (error) {
        if (error instanceof GitHubError && [401, 403].includes(error.status)) throw error
        failure = error
      }
      const observed = await this.head(session)
      if (!observed) throw failure ?? new Error('Git repository initialization could not be confirmed.')
      return this.makeSnapshot(session, observed, (await this.commitObject(session, observed)).tree, undefined, true)
    })
  }
}
