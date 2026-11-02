import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import type { GitChange, GitFileChange, GitReceipt, GitRepository, GitSnapshot, RepoBinding, RepoConnection } from './contracts.js'
import { GitConflictError, GitHubClient, GitHubError, inspectPrivateRepo, repositoryPath, type GitHubSession, type TokenSource } from './github.js'
import { GitRefNotResolvedError, readPlan, type GitReadPlan, type PathDemand, type PlannedEntry } from './read-plan.js'

export function validCoopPath(path: string): boolean {
  return path.startsWith('dss-coop/') && !/[\\\0\r\n]/.test(path)
    && path.split('/').every(part => part.length > 0 && part !== '.' && part !== '..')
}
/** Persist this receipt metadata BEFORE dispatch; it contains no business body or secret. */
export interface GitCommitOperation {
  version: 1
  id: string
  expectedHead: string
  repositoryId: number
  repository: string
  branch: string
  directory: string
  authorId: number
  requestHash: string
  writes: Array<{ path: string; sha256: string | null }>
}
export type GitCommitResolution =
  | { status: 'confirmed'; commit: string; head: string; verifiedWrites?: GitSnapshot }
  // A request can still be in flight. Only the SAME operation at the SAME H may be retried.
  | { status: 'pending'; head: string }
  | { status: 'conflict'; head: string }
  | { status: 'unknown'; head?: string; reason: string }
export class GitCommitOutcomeUnknownError extends Error {
  readonly operationId: string
  readonly expectedHead: string
  constructor(readonly operation: GitCommitOperation, options?: ErrorOptions) {
    super('Git commit result is unknown; retain operation ' + operation.id + ' and resolve it before creating a replacement.', options)
    this.name = 'GitCommitOutcomeUnknownError'
    this.operationId = operation.id
    this.expectedHead = operation.expectedHead
  }
}
interface RemoteScope { connection: RepoConnection; directory: string; path: string; signal: AbortSignal; metadata: ScopeMetadata }
interface TreeEntry { path: string; type: 'blob' | 'tree' | 'commit'; sha: string; size?: number }
interface RemoteCommit { sha: string; tree: { sha: string }; parents: Array<{ sha: string }>; message: string }
interface ScopeMetadata {
  key: string
  authorizationScope: object
  head?: string
  latestTree?: { head: string; tree: string }
  view?: TreeNode
}
interface TreeNode {
  sha: string
  entries?: TreeEntry[]
  /** Only completed immutable entries cross owners; transport belongs to its session. */
  pending?: WeakMap<GitHubSession, Promise<TreeEntry[]>>
  children: Map<string, TreeNode>
  /** Last expanded view of this path, until its replacement is actually read. */
  previous?: TreeNode
}
interface ReadOperation { session?: GitHubSession; scope: RemoteScope; signal: AbortSignal; binding: string; active: boolean; reusable: boolean; pending: Set<Promise<unknown>> }
interface SnapshotState { scope: RemoteScope; head: string; root: TreeNode; nodes: Map<string, TreeNode>; loaded: Set<string>;
  planned: Map<string, (TreeEntry & { node?: TreeNode }) | null>; bodies: Map<string, Uint8Array>;
  verifiedWrites?: ReadonlyArray<Readonly<{ path: string; sha256: string | null }>> }
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
function changeBytes(change: GitChange): Buffer | null {
  if (change.bytes !== undefined) {
    if (!(change.bytes instanceof Uint8Array) || change.content !== undefined) throw new Error('Use either text content or binary bytes for a Git file, not both.')
    return Buffer.from(change.bytes)
  }
  if (change.content === null) return null
  if (typeof change.content !== 'string') throw new Error('A Git file requires text content, binary bytes, or an explicit deletion.')
  return Buffer.from(change.content, 'utf8')
}
const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/')

/** Remote-only authoritative storage. No worktree, bare repository or body mirror.
 * Only immutable tree metadata is shared in memory within an authenticated scope;
 * each snapshot retains separate file/read sets. No business body is cached.
 * expectedHeadOid covers file reads AND empty directory predicates: never reparent
 * a checked transaction. Conflicts return to the caller for business re-evaluation.
 */
export class GitHubRepository implements GitRepository {
  private readonly readOperations = new AsyncLocalStorage<ReadOperation>()
  private scopes = new AbortController()
  private checked?: { key: string; authorizationScope: object; connection: RepoConnection }
  private metadata?: ScopeMetadata
  private states = new WeakMap<GitSnapshot, SnapshotState>()
  constructor(private readonly client: GitHubClient, private readonly binding: () => RepoBinding,
    _tokens?: TokenSource, _legacyCacheRoot?: string) {}
  cancel(reason?: unknown): void {
    // Snapshots and in-flight HTTP share one cancellation cause, including the
    // default native AbortError. Old snapshots retain only their epoch signal.
    this.scopes.abort(reason)
    this.client.cancel(this.scopes.signal.reason)
    this.scopes = new AbortController()
    this.checked = undefined
    this.metadata = undefined
  }
  async releaseCache(): Promise<void> { this.cancel(); this.states = new WeakMap() }
  private async session<T>(operation: (session: GitHubSession) => Promise<T>, ownerSignal?: AbortSignal): Promise<T> {
    const owner = this.readOperations.getStore()
    if (owner) {
      if (!owner.active) throw new Error('Read operation ownership has ended.')
      // A fresh authority/write operation cuts off reuse of pre-write credentials.
      owner.reusable = false
    }
    try { return await this.client.session(operation, ownerSignal) }
    catch (error) {
      if (error instanceof GitHubError && [401, 403].includes(error.status) && error.retryAt === undefined) { this.checked = undefined; this.metadata = undefined }
      throw error
    }
  }
  /** Reuse an actual authorized session only inside this awaited callback.
   * No token is persisted or cached beyond GitHubClient.session's operation. */
  async withReadOperation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.readOperations.getStore()
    // An explicitly requested new operation starts fresh; an escaped direct
    // read still rejects in readSession/state instead of borrowing this owner.
    if (previous && !previous.active) return this.readOperations.exit(() => this.withReadOperation(operation))
    if (previous?.reusable) { this.checkReadOperation(previous); return operation() }
    const controller = new AbortController()
    return this.session(async session => {
      const scope = await this.scope(session)
      const owner: ReadOperation = { session, scope, signal: controller.signal, binding: this.readBindingKey(), active: true, reusable: true, pending: new Set() }
      return this.readOperations.run(owner, async () => {
        let result!: T, failure: unknown, failed = false
        try { result = await operation() } catch (error) { failure = error; failed = true }
        finally { owner.active = false }
        const outstanding = [...owner.pending]
        if (outstanding.length) {
          if (!failed) { failure = scope.signal.aborted ? scope.signal.reason : new Error('Read operation callback ended with unawaited requests.'); failed = true }
          controller.abort(failure)
        }
        const settled = await Promise.allSettled(outstanding)
        const errors = [...new Set([...(failed ? [failure] : []),
          ...settled.flatMap(value => value.status === 'rejected' ? [value.reason] : [])])]
        owner.pending.clear(); owner.session = undefined
        if (!errors.length) {
          try {
            this.check(scope)
            if (owner.reusable && this.metadata !== scope.metadata) throw new GitHubError(409, 'The GitHub read authority changed. Start a new read operation.')
          } catch (error) { errors.push(error) }
        }
        if (errors.length === 1) throw errors[0]
        if (errors.length) throw new AggregateError(errors, 'Owned read operation failed.')
        return result
      })
    }, controller.signal)
  }
  private readBindingKey(): string {
    const value = this.binding()
    return JSON.stringify([value.ownerRepo, value.repositoryId, value.participantId, value.branch, value.repositoryDirectory])
  }
  private checkReadOperation(owner: ReadOperation): void {
    if (!owner.active) throw new Error('Read operation ownership has ended.')
    this.check(owner.scope)
    if (owner.binding !== this.readBindingKey() || this.metadata !== owner.scope.metadata) {
      throw new GitHubError(409, 'The GitHub read authority changed. Start a new read operation.')
    }
  }
  private async readSession<T>(operation: (session: GitHubSession) => Promise<T>): Promise<T> {
    const owner = this.readOperations.getStore()
    if (!owner) return this.session(operation)
    if (!owner.active) throw new Error('Read operation ownership has ended.')
    if (owner.reusable) this.checkReadOperation(owner)
    const pending = (owner.reusable ? operation(owner.session!) : this.session(operation, owner.signal)).catch(error => {
      if (error instanceof GitHubError && [401, 403].includes(error.status) && error.retryAt === undefined) {
        owner.reusable = false; this.checked = undefined; this.metadata = undefined
      }
      throw error
    })
    owner.pending.add(pending)
    void pending.then(() => owner.pending.delete(pending), () => owner.pending.delete(pending))
    return pending
  }
  async connect(): Promise<RepoConnection> {
    return this.session(async session => (await this.scope(session, true, true)).connection)
  }
  private async scope(session: GitHubSession, recheck = false, connect = false): Promise<RemoteScope> {
    const signal = this.scopes.signal, binding = this.binding()
    const key = JSON.stringify([binding.ownerRepo, binding.repositoryId, binding.participantId, binding.branch, binding.repositoryDirectory])
    let connection = !recheck && this.checked?.key === key && this.checked.authorizationScope === session.authorizationScope ? this.checked.connection : undefined
    // Connection/account changes and writes recheck identity. Ordinary polling uses
    // GitHub authorization on each HEAD request, not a second /user handshake timer.
    if (!connection) {
      connection = await inspectPrivateRepo(session, connect ? { ...binding, participantId: undefined } : binding)
      signal.throwIfAborted()
      this.checked = { key, authorizationScope: session.authorizationScope, connection }
    }
    const directory = binding.repositoryDirectory ?? 'dss-coop'
    if (directory && (!validCoopPath('dss-coop/' + directory) || directory.startsWith('/'))) throw new Error('Use a directory inside the Git repository.')
    const metadataKey = JSON.stringify([key, connection.identity.id, connection.repository.id, connection.repository.fullName, connection.repository.branch, directory])
    if (this.metadata?.key !== metadataKey || this.metadata.authorizationScope !== session.authorizationScope) {
      this.metadata = { key: metadataKey, authorizationScope: session.authorizationScope }
    }
    return { connection, directory, path: repositoryPath(connection.repository.fullName), signal, metadata: this.metadata }
  }
  private check(scope: RemoteScope): void {
    scope.signal.throwIfAborted()
  }
  private physical(scope: RemoteScope, path: string): string {
    if (path === 'dss-coop') return scope.directory
    if (!validCoopPath(path)) throw new Error('Choose a record inside the configured DSS directory.')
    return (scope.directory ? scope.directory + '/' : '') + path.slice('dss-coop/'.length)
  }
  private async head(session: GitHubSession, scope: RemoteScope): Promise<string> {
    try {
      const head = await session.head(scope.path + '/commits/heads/' + encodePath(scope.connection.repository.branch), scope.metadata.head)
      this.check(scope)
      scope.metadata.head = head
      return head
    } catch (error) {
      if (!(error instanceof GitHubError) || ![404, 409].includes(error.status)) throw error
      scope.metadata.head = undefined
      // Do not reinterpret a wrong branch, removed access, or network failure as an
      // empty repository. This successful branch listing establishes the empty case.
      const branches = await session.request<Array<{ name: string }>>('GET', scope.path + '/branches?per_page=1')
      if (branches.length) throw error
      return ''
    }
  }
  private async makeSnapshot(session: GitHubSession, scope: RemoteScope, head: string, knownTree?: string): Promise<GitSnapshot> {
    let tree = knownTree ?? (scope.metadata.latestTree?.head === head ? scope.metadata.latestTree.tree : undefined)
    if (tree === undefined) tree = head ? (await session.request<RemoteCommit>('GET', scope.path + '/git/commits/' + head)).tree.sha : ''
    this.check(scope)
    if (head === scope.metadata.head) scope.metadata.latestTree = { head, tree }
    // Observing a HEAD does not replace directory ownership. Only an actually
    // expanded root publishes a new view; historical snapshots own their roots.
    const view = scope.metadata.view
    const root: TreeNode = view?.sha === tree ? view : { sha: tree, children: new Map(), previous: view }
    const nodes = new Map<string, TreeNode>()
    const index = (node: TreeNode): void => {
      if (nodes.has(node.sha)) return
      nodes.set(node.sha, node)
      for (const child of node.children.values()) index(child)
      if (node.previous) index(node.previous)
    }
    index(root)
    const snapshot: GitSnapshot = { head, tree, files: new Map(), reads: new Map() }
    this.states.set(snapshot, { scope, head, root, nodes, loaded: new Set(), planned: new Map(), bodies: new Map() })
    return snapshot
  }
  snapshot(_afterWrite = false, plan?: GitReadPlan): Promise<GitSnapshot> {
    // Each invocation reads the remote branch; no pre-write request is reused by
    // read-back. Only immutable tree responses may be shared across snapshots.
    return this.readSession(async session => {
      const scope = await this.scope(session)
      if (plan) {
        const demands = this.demands(scope, plan)
        const first = demands.slice(0, 64)
        let result: Awaited<ReturnType<typeof readPlan>>
        try { result = await readPlan(session, scope.connection.repository.fullName, scope.connection.repository.branch, undefined, first) }
        catch (error) {
          // A genuinely unresolved ref still follows the established empty-repo
          // check. Permission, partial and transport failures never switch APIs.
          if (!(error instanceof GitRefNotResolvedError)) throw error
          const snapshot = await this.makeSnapshot(session, scope, await this.head(session, scope))
          if (snapshot.head) await this.prefetchDemands(session, snapshot, demands)
          return snapshot
        }
        this.check(scope)
        const snapshot = await this.makeSnapshot(session, scope, result.head, result.tree)
        this.acceptPlan(snapshot, first, result.entries)
        scope.metadata.head = result.head; scope.metadata.latestTree = { head: result.head, tree: result.tree }
        await this.prefetchDemands(session, snapshot, demands.slice(first.length))
        return snapshot
      }
      return this.makeSnapshot(session, scope, await this.head(session, scope))
    })
  }
  private demands(scope: RemoteScope, plan: GitReadPlan): PathDemand[] {
    const requested = new Map<string, boolean>()
    for (const path of plan.directories ?? []) requested.set(this.physical(scope, path), false)
    for (const path of plan.files ?? []) {
      const physical = this.physical(scope, path)
      if (requested.get(physical) === false) throw new Error('A read plan cannot request the same path as both file and directory.')
      requested.set(physical, true)
    }
    return [...requested].map(([path, body]) => ({ path, body }))
  }
  async prefetch(snapshot: GitSnapshot, plan: GitReadPlan): Promise<void> {
    const state = this.state(snapshot)
    const demands = this.demands(state.scope, plan).filter(demand => {
      const entry = state.planned.get(demand.path)
      return !state.planned.has(demand.path) || !!entry && (demand.body ? entry.type === 'blob' && !state.bodies.has(entry.sha) : entry.type === 'tree' && !entry.node?.entries)
    })
    if (!demands.length || !snapshot.head) return
    await this.readSession(session => this.prefetchDemands(session, snapshot, demands))
  }
  private async prefetchDemands(session: GitHubSession, snapshot: GitSnapshot, demands: readonly PathDemand[]): Promise<void> {
    const state = this.state(snapshot)
    if (session.authorizationScope !== state.scope.metadata.authorizationScope) throw new GitHubError(409, 'The GitHub authorization changed. Read a new snapshot before continuing.')
    // Bound a transport batch, not history or message length. Later batches use
    // the same immutable commit; no extra main/ref resolution is performed.
    for (let start = 0; start < demands.length; start += 64) {
      const batch = demands.slice(start, start + 64)
      const result = await readPlan(session, state.scope.connection.repository.fullName, state.scope.connection.repository.branch, snapshot.head, batch)
      this.check(state.scope)
      this.acceptPlan(snapshot, batch, result.entries)
    }
  }
  private acceptPlan(snapshot: GitSnapshot, demands: readonly PathDemand[], values: readonly (PlannedEntry | null)[]): void {
    const state = this.state(snapshot), updates: Array<() => void> = []
    const gitOid = (value: unknown): value is string => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)
    for (let i = 0; i < demands.length; i++) {
      const demand = demands[i]!, value = values[i]!
      if (value === null) { updates.push(() => state.planned.set(demand.path, null)); continue }
      const entry: TreeEntry & { node?: TreeNode } = { path: demand.path.split('/').at(-1)!, type: value.type, sha: value.oid }
      const object = value.object
      if (demand.body && value.type === 'blob') {
        if (!object || object.oid !== value.oid || !Number.isSafeInteger(object.byteSize) || object.byteSize! < 0
          || typeof object.isTruncated !== 'boolean' || ![true, false, null].includes(object.isBinary as boolean | null)
          || object.text !== null && typeof object.text !== 'string')
          throw new GitHubError(502, 'GitHub returned incomplete blob metadata.')
        entry.size = object.byteSize
        if (object.isBinary === false && !object.isTruncated && typeof object.text === 'string') {
          const bytes = Buffer.from(object.text, 'utf8')
          if (bytes.length !== object.byteSize) throw new GitHubError(502, 'GitHub returned incomplete blob text.')
          updates.push(() => state.bodies.set(value.oid, bytes))
        }
        // Binary, truncated or unavailable text uses the existing byte reader;
        // GraphQL errors never trigger that fallback.
      } else if (!demand.body && value.type === 'tree') {
        if (!object || object.oid !== value.oid || !Array.isArray(object.entries)) throw new GitHubError(502, 'GitHub returned an incomplete directory.')
        const entries: TreeEntry[] = object.entries.map(child => {
          if (!child.name || child.name.includes('/') || ['.', '..'].includes(child.name) || !gitOid(child.oid) || !['blob', 'tree', 'commit'].includes(child.type))
            throw new GitHubError(502, 'GitHub returned an invalid directory entry.')
          return { path: child.name, type: child.type, sha: child.oid, ...(child.object?.byteSize === undefined ? {} : { size: child.object.byteSize }) }
        })
        const node: TreeNode = { sha: value.oid, entries, children: new Map() }
        for (const child of entries) if (child.type === 'tree') node.children.set(child.path, state.nodes.get(child.sha) ?? { sha: child.sha, children: new Map() })
        entry.node = node
        updates.push(() => { state.nodes.set(node.sha, node); for (const child of node.children.values()) state.nodes.set(child.sha, child) })
      }
      updates.push(() => state.planned.set(demand.path, entry))
    }
    this.check(state.scope)
    for (const update of updates) update()
  }
  async at(revision: string): Promise<GitSnapshot> {
    if (!/^[0-9a-f]{40,64}$/.test(revision)) throw new Error('Use a Git commit id.')
    return this.readSession(async session => this.makeSnapshot(session, await this.scope(session), revision))
  }
  private state(snapshot: GitSnapshot): SnapshotState {
    if (this.readOperations.getStore()?.active === false) throw new Error('Read operation ownership has ended.')
    const state = this.states.get(snapshot)
    if (!state) throw new Error('Use a snapshot obtained from this repository.')
    this.check(state.scope)
    return state
  }
  private async tree(session: GitHubSession, state: SnapshotState, node: TreeNode): Promise<TreeEntry[]> {
    let pending = node.pending?.get(session)
    if (!node.entries && !pending) {
      node.pending ??= new WeakMap()
      pending = session.request<{ tree: TreeEntry[]; truncated: boolean }>('GET', state.scope.path + '/git/trees/' + node.sha).then(result => {
        this.check(state.scope)
        // Non-recursive trees avoid the recursive API's 100,000 entry/7 MB cap.
        if (result.truncated) throw new Error('GitHub returned a truncated directory tree: ' + node.sha)
        for (const child of result.tree.filter(entry => entry.type === 'tree')) {
          let next = state.nodes.get(child.sha)
          if (!next) {
            const prior = node.previous?.children.get(child.path)
            // Unexpanded revisions are not history: keep only the last expanded
            // view of a changed path until its real children become known.
            next = { sha: child.sha, children: new Map(), previous: prior?.entries ? prior : prior?.previous }
            state.nodes.set(child.sha, next)
          }
          node.children.set(child.path, next)
        }
        node.entries = result.tree
        node.previous = undefined
        return result.tree
      }).finally(() => { node.pending!.delete(session) })
      node.pending.set(session, pending)
    }
    const entries = node.entries ?? await pending!
    this.check(state.scope)
    // Replacing the root releases deleted/unreachable branches from the active
    // view. Other fixed snapshots alone retain any older graph they still use.
    if (node === state.root && state.head === state.scope.metadata.head) state.scope.metadata.view = node
    return entries
  }
  private async entry(session: GitHubSession, snapshot: GitSnapshot, physical: string): Promise<(TreeEntry & { node?: TreeNode }) | undefined> {
    const state = this.state(snapshot)
    if (session.authorizationScope !== state.scope.metadata.authorizationScope) throw new GitHubError(409, 'The GitHub authorization changed. Read a new snapshot before continuing.')
    if (!snapshot.tree) return
    if (state.planned.has(physical)) return state.planned.get(physical) ?? undefined
    if (!physical) return { path: '', type: 'tree', sha: snapshot.tree, node: state.root }
    let node = state.root
    const parts = physical.split('/')
    for (let i = 0; i < parts.length; i++) {
      const found = (await this.tree(session, state, node)).find(item => item.path === parts[i])
      if (!found) return
      if (i === parts.length - 1) return found.type === 'tree' ? { ...found, node: node.children.get(found.path)! } : found
      if (found.type !== 'tree') return
      node = node.children.get(found.path)!
    }
  }
  /** Direct children only: Host can inspect root signals without watching other
   * participants' subtrees. Paths are logical, with no trailing slash. Resolving
   * ancestors and the directory reads only immutable non-recursive tree metadata.
   * This does not mark a recursive listing complete or populate snapshot.files.
   */
  async listDirectory(snapshot: GitSnapshot, prefix: string): Promise<Array<{ path: string; sha: string; type: 'blob' | 'tree' | 'commit'; size?: number }>> {
    const root = prefix.replace(/\/$/, ''), state = this.state(snapshot)
    return this.readSession(async session => {
      const entry = await this.entry(session, snapshot, this.physical(state.scope, root))
      if (!entry || entry.type !== 'tree') return []
      const children = await this.tree(session, state, entry.node!)
      this.check(state.scope)
      return children.map(child => ({ ...child, path: root + '/' + child.path }))
    })
  }
  async directories(snapshot: GitSnapshot, prefix: string): Promise<string[]> {
    const root = prefix.replace(/\/$/, ''), state = this.state(snapshot)
    return this.readSession(async session => {
      const entry = await this.entry(session, snapshot, this.physical(state.scope, root))
      if (!entry || entry.type !== 'tree') return []
      return (await this.tree(session, state, entry.node!)).filter(item => item.type === 'tree').map(item => root + '/' + item.path + '/')
    })
  }
  async list(snapshot: GitSnapshot, prefix: string): Promise<void> {
    const root = prefix.replace(/\/$/, ''), state = this.state(snapshot)
    if (state.loaded.has(root)) return
    await this.readSession(async session => {
      const entry = await this.entry(session, snapshot, this.physical(state.scope, root)), files = new Map<string, string>()
      const visit = async (node: TreeNode, logical: string): Promise<void> => {
        for (const child of await this.tree(session, state, node)) {
          if (child.type === 'tree') await visit(node.children.get(child.path)!, logical + '/' + child.path)
          else if (child.type === 'blob') files.set(logical + '/' + child.path, child.sha)
        }
      }
      if (entry?.type === 'tree') await visit(entry.node!, root)
      this.check(state.scope)
      // Publish only a successful, complete enumeration; overlapping readers never
      // see a temporarily emptied collection while a remote request is in flight.
      for (const [path, sha] of files) (snapshot.files as Map<string, string>).set(path, sha)
      state.loaded.add(root)
    })
  }
  async read(snapshot: GitSnapshot, path: string): Promise<string | undefined> {
    const bytes = await this.readBytes(snapshot, path)
    return bytes === undefined ? undefined : new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
  async readBytes(snapshot: GitSnapshot, path: string): Promise<Uint8Array | undefined> {
    const state = this.state(snapshot)
    return this.readSession(async session => {
      const entry = await this.entry(session, snapshot, this.physical(state.scope, path))
      const sha = entry?.type === 'blob' ? entry.sha : undefined
      snapshot.reads?.set(path, sha)
      if (!sha) return
      ;(snapshot.files as Map<string, string>).set(path, sha)
      let bytes = state.bodies.get(sha)
      if (!bytes) {
        const blob = await session.request<{ content: string; encoding: string }>('GET', state.scope.path + '/git/blobs/' + sha)
        this.check(state.scope)
        if (blob.encoding !== 'base64') throw new Error('Unsupported GitHub blob encoding: ' + blob.encoding)
        bytes = Buffer.from(blob.content.replace(/\s/g, ''), 'base64')
      }
      // Verify the immutable Git blob rather than cache or trust partial bodies.
      const algorithm = sha.length === 64 ? 'sha256' : 'sha1'
      const actual = createHash(algorithm).update('blob ' + bytes.length + '\0').update(bytes).digest('hex')
      if (actual !== sha) throw new Error('Git blob integrity mismatch: ' + path)
      return Buffer.from(bytes)
    })
  }
  /** Net file difference between two immutable snapshots, including own writes.
   * This is NOT a per-commit event log. Host discovery uses current Inbox/state
   * versions; consumers must not infer transient intermediate events from it.
   * Only tree metadata is read, never the business file bodies.
   */
  async changes(snapshot: GitSnapshot, from: string, _ownInstance?: string): Promise<GitFileChange[]> {
    const state = this.state(snapshot)
    if (snapshot.head === from) return []
    const before = from ? await this.session(session => this.makeSnapshot(session, state.scope, from)) : undefined
    await this.list(snapshot, 'dss-coop/')
    if (before) await this.list(before, 'dss-coop/')
    const paths = new Set([...snapshot.files.keys(), ...(before?.files.keys() ?? [])])
    return [...paths].sort().flatMap(path => {
      const old = before?.files.get(path), next = snapshot.files.get(path)
      return old === next ? [] : [{ path, status: !old ? 'A' as const : !next ? 'D' as const : 'M' as const,
        commit: snapshot.head, parent: from || undefined, before: old, after: next }]
    })
  }
  /** GitHub cannot create a ref in an empty repository. Explicit connection-time
   * bootstrap uses one Contents commit, never splits a business transaction.
   * https://docs.github.com/en/rest/git/refs#create-a-reference
   */
  async ensureBranch(): Promise<GitSnapshot> {
    return this.session(async session => {
      const scope = await this.scope(session, true), head = await this.head(session, scope)
      if (head) return this.makeSnapshot(session, scope, head)
      const path = this.physical(scope, 'dss-coop/README.md')
      const content = '# DSS collaboration\n\nShared conversation, task execution and durable records for DeepSeek Servant.\n'
      try {
        await session.request('PUT', scope.path + '/contents/' + encodePath(path), {
          message: 'Initialize DSS collaboration repository', content: Buffer.from(content).toString('base64'), branch: scope.connection.repository.branch,
        })
      } catch (error) {
        // Concurrent initialization / uncertain write is checked before any retry.
        const observed = await this.head(session, scope).catch(() => '')
        if (!observed) throw error
        return this.makeSnapshot(session, scope, observed)
      }
      const observed = await this.head(session, scope)
      if (!observed) throw new Error('GitHub repository initialization could not be confirmed.')
      const snapshot = await this.makeSnapshot(session, scope, observed)
      if (await this.read(snapshot, 'dss-coop/README.md') !== content) throw new Error('GitHub repository initialization read-back differs; inspect the current branch before continuing.')
      return snapshot
    })
  }
  private writes(changes: readonly GitChange[]): GitCommitOperation['writes'] {
    if (changes.some(change => !validCoopPath(change.path))) throw new Error('Commit changes inside the configured DSS directory.')
    if (new Set(changes.map(change => change.path)).size !== changes.length) throw new Error('Duplicate paths in a Git transaction.')
    return changes.map(change => {
      const bytes = changeBytes(change)
      return { path: change.path, sha256: bytes === null ? null : sha256(bytes) }
    }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  }
  /** Synchronous preparation: callers persist the returned metadata before commitPrepared. */
  prepareCommit(base: GitSnapshot, changes: readonly GitChange[], message: string): GitCommitOperation {
    const { scope } = this.state(base), writes = this.writes(changes)
    if (!base.head) throw new Error('Initialize the empty repository with ensureBranch before committing a business transaction.')
    return { version: 1, id: randomUUID(), expectedHead: base.head, repositoryId: scope.connection.repository.id,
      repository: scope.connection.repository.fullName, branch: scope.connection.repository.branch, directory: scope.directory,
      authorId: scope.connection.identity.id, writes, requestHash: sha256(JSON.stringify({ writes, message })) }
  }
  private matchesScope(scope: RemoteScope, operation: GitCommitOperation): boolean {
    return scope.connection.repository.id === operation.repositoryId && scope.connection.repository.fullName === operation.repository
      && scope.connection.repository.branch === operation.branch && scope.directory === operation.directory
      && scope.connection.identity.id === operation.authorId
  }
  private validateOperation(operation: GitCommitOperation): void {
    if (operation.version !== 1 || !/^[0-9a-f-]+$/i.test(operation.id) || !/^[0-9a-f]{40,64}$/.test(operation.expectedHead)
      || !/^[0-9a-f]{64}$/.test(operation.requestHash)
      || operation.writes.some(write => !validCoopPath(write.path) || write.sha256 !== null && !/^[0-9a-f]{64}$/.test(write.sha256))) {
      throw new Error('Invalid persisted Git operation metadata.')
    }
  }
  private async resolve(session: GitHubSession, scope: RemoteScope, operation: GitCommitOperation, knownHead?: string): Promise<GitCommitResolution> {
    if (!this.matchesScope(scope, operation)) return { status: 'unknown', reason: 'Repository, branch or account changed; resolve in the original scope.' }
    const head = knownHead ?? await this.head(session, scope)
    if (head === operation.expectedHead) return { status: 'pending', head }
    let cursor = head
    while (cursor && cursor !== operation.expectedHead) {
      const commit = await session.request<RemoteCommit>('GET', scope.path + '/git/commits/' + cursor)
      const lines = commit.message.split('\n')
      if (lines.includes('DSS-Operation: ' + operation.id)) {
        if (commit.parents.length !== 1 || commit.parents[0]?.sha !== operation.expectedHead
          || !lines.includes('DSS-Request-SHA256: ' + operation.requestHash)) return { status: 'unknown', head, reason: 'Operation marker does not match the prepared transaction.' }
        const snapshot = await this.makeSnapshot(session, scope, cursor)
        for (const write of operation.writes) {
          const content = await this.readBytes(snapshot, write.path)
          if ((content === undefined ? null : sha256(content)) !== write.sha256) return { status: 'unknown', head, reason: 'Operation content verification differs from its prepared hashes.' }
        }
        this.check(scope)
        // Only a complete byte/hash pass grants this existing snapshot metadata
        // a reusable result. No business bodies or new credential are retained.
        this.state(snapshot).verifiedWrites = Object.freeze(operation.writes.map(write => Object.freeze({ ...write })))
        return { status: 'confirmed', commit: cursor, head, verifiedWrites: snapshot }
      }
      // First-parent ancestry is sufficient for commits appended to this branch by
      // createCommitOnBranch. A rewritten/missing ancestry remains UNKNOWN, never
      // falsely absent; no arbitrary scan count converts missing evidence to success.
      cursor = commit.parents[0]?.sha ?? ''
    }
    return cursor === operation.expectedHead ? { status: 'conflict', head }
      : { status: 'unknown', head, reason: 'Expected base is not on the current first-parent chain; history may have been rewritten.' }
  }
  /** Reuse only a complete verification owned by this repository's current
   * authority epoch. Callers must still obtain a fresh authoritative snapshot. */
  matchesVerifiedWrites(current: GitSnapshot, verified: GitSnapshot | undefined,
    expected: readonly { path: string; sha256: string | null }[]): boolean {
    const now = this.states.get(current), prior = verified && this.states.get(verified)
    if (!now || !prior?.verifiedWrites || now.head !== prior.head
      || now.scope.signal.aborted || prior.scope.signal.aborted
      || now.scope.metadata !== this.metadata || now.scope.metadata !== prior.scope.metadata) return false
    if (expected.length !== prior.verifiedWrites.length) return false
    const actual = new Map(prior.verifiedWrites.map(write => [write.path, write.sha256]))
    const paths = new Set(expected.map(write => write.path))
    return paths.size === expected.length && expected.every(write => actual.has(write.path) && actual.get(write.path) === write.sha256)
  }
  /** Safe after process restart: the receipt metadata alone locates and verifies
   * a successful commit even if other people committed after it. No body mirror.
   */
  async resolveCommit(operation: GitCommitOperation): Promise<GitCommitResolution> {
    this.validateOperation(operation)
    try {
      return await this.session(async session => this.resolve(session, await this.scope(session, true), operation))
    } catch (error) {
      return { status: 'unknown', reason: error instanceof Error ? error.message : String(error) }
    }
  }
  async commitPrepared(base: GitSnapshot, changes: readonly GitChange[], message: string, operation: GitCommitOperation): Promise<GitReceipt & { verifiedWrites?: GitSnapshot }> {
    // Capture mutable byte arrays before any network await. The payload sent must
    // remain the exact one whose hashes were checked against the persisted receipt.
    changes = changes.map(change => {
      const bytes = changeBytes(change)
      return bytes === null ? { path: change.path, content: null } : { path: change.path, bytes }
    })
    this.validateOperation(operation)
    const writes = this.writes(changes), state = this.state(base)
    if (operation.expectedHead !== base.head || JSON.stringify(writes) !== JSON.stringify(operation.writes)
      || sha256(JSON.stringify({ writes, message })) !== operation.requestHash) throw new Error('Prepared Git operation was reused for different input or snapshot.')
    return this.session(async session => {
      const scope = await this.scope(session, true)
      if (!this.matchesScope(scope, operation) || scope.path !== state.scope.path || scope.directory !== state.scope.directory) {
        throw new GitCommitOutcomeUnknownError(operation, { cause: new Error('Repository scope or account changed.') })
      }
      const head = await this.head(session, scope)
      if (head !== base.head) {
        const resolution = await this.resolve(session, scope, operation, head)
        if (resolution.status === 'confirmed') return { commit: resolution.commit, replay: true, ...(resolution.verifiedWrites ? { verifiedWrites: resolution.verifiedWrites } : {}) }
        if (resolution.status === 'conflict') throw new GitConflictError()
        throw new GitCommitOutcomeUnknownError(operation)
      }
      const additions = changes.flatMap(change => {
        const bytes = changeBytes(change)
        return bytes === null ? [] : [{ path: this.physical(scope, change.path), contents: bytes.toString('base64') }]
      })
      const deletions: Array<{ path: string }> = []
      for (const change of changes) if (change.content === null && (await this.entry(session, base, this.physical(scope, change.path)))?.type === 'blob') deletions.push({ path: this.physical(scope, change.path) })
      const input = { branch: { repositoryNameWithOwner: scope.connection.repository.fullName, branchName: scope.connection.repository.branch }, expectedHeadOid: base.head,
        message: { headline: message.split('\n')[0], body: message.split('\n').slice(1).join('\n') + '\n\nDSS-Operation: ' + operation.id + '\nDSS-Request-SHA256: ' + operation.requestHash },
        fileChanges: { additions, deletions }, clientMutationId: operation.id }
      let result: { data?: { createCommitOnBranch?: { commit?: { oid: string; tree?: { oid?: string } | null } } }; errors?: Array<{ message: string; type?: string }> } | undefined
      let failure: unknown
      try {
        result = await session.request('POST', '/graphql', { query: 'mutation DSSCommit($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid tree { oid } } } }', variables: { input } })
      } catch (error) {
        if (error instanceof GitHubError && [401, 403].includes(error.status)) {
          if (error.retryAt === undefined) this.checked = undefined
          // An explicit authorization rejection is not a transport-unknown write.
          // Preserve its exact upstream status so revocation remains visible.
          throw error
        }
        failure = error
      }
      const oid = result?.data?.createCommitOnBranch?.commit?.oid
      if (oid) {
        // Commit.tree is immutable metadata for this exact successful mutation.
        // A later snapshot still fetches branch HEAD and only reuses this tree
        // when that fresh authority equals oid; changed HEAD uses its own commit.
        // Missing/partial/invalid metadata never replaces the normal read path.
        const tree = result?.data?.createCommitOnBranch?.commit?.tree?.oid
        const gitOid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
        if (!result?.errors?.length && gitOid.test(oid) && typeof tree === 'string' && gitOid.test(tree)) {
          scope.metadata.latestTree = { head: oid, tree }
        }
        return { commit: oid, replay: false }
      }
      // Every ambiguous transport/GraphQL response uses the same read-back path.
      // A newer HEAD alone is NOT proof of rejection: our commit may precede it.
      let resolution: GitCommitResolution | undefined
      try { resolution = await this.resolve(session, scope, operation) } catch { /* keep UNKNOWN */ }
      if (resolution?.status === 'confirmed') return { commit: resolution.commit, replay: false, ...(resolution.verifiedWrites ? { verifiedWrites: resolution.verifiedWrites } : {}) }
      if (resolution?.status === 'conflict') throw new GitConflictError()
      // A syntactically valid GraphQL rejection at the unchanged H reports the
      // upstream reason. Missing/partial data and transport failures stay UNKNOWN.
      if (resolution?.status === 'pending' && result?.errors?.length && result.data?.createCommitOnBranch === null) {
        throw new Error('GitHub commit rejected: ' + result.errors.map(error => error.message).join('; '))
      }
      throw new GitCommitOutcomeUnknownError(operation, { cause: failure })
    })
  }
  /** Compatibility entry point. New durable callers use prepare/persist/commitPrepared. */
  async commit(base: GitSnapshot, changes: readonly GitChange[], message: string): Promise<GitReceipt> {
    return this.commitPrepared(base, changes, message, this.prepareCommit(base, changes, message))
  }
}
