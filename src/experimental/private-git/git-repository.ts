import { createHash, randomUUID } from 'node:crypto'
import type { GitChange, GitFileChange, GitReceipt, GitRepository, GitSnapshot, RepoBinding, RepoConnection } from './contracts.js'
import { GitConflictError, GitHubClient, GitHubError, inspectPrivateRepo, repositoryPath, type GitHubSession, type TokenSource } from './github.js'

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
  | { status: 'confirmed'; commit: string; head: string }
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
interface RemoteScope { connection: RepoConnection; directory: string; path: string; generation: number }
interface TreeEntry { path: string; type: 'blob' | 'tree' | 'commit'; sha: string; size?: number }
interface RemoteCommit { sha: string; tree: { sha: string }; parents: Array<{ sha: string }>; message: string }
interface SnapshotState { scope: RemoteScope; trees: Map<string, Promise<TreeEntry[]>>; loaded: Set<string> }
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
 * Immutable tree metadata is retained only for the lifetime of a caller's snapshot.
 * expectedHeadOid covers file reads AND empty directory predicates: never reparent
 * a checked transaction. Conflicts return to the caller for business re-evaluation.
 */
export class GitHubRepository implements GitRepository {
  private generation = 0
  private checked?: { key: string; connection: RepoConnection }
  private latestTree?: { scopeKey: string; head: string; tree: string }
  private states = new WeakMap<GitSnapshot, SnapshotState>()
  constructor(private readonly client: GitHubClient, private readonly binding: () => RepoBinding,
    _tokens?: TokenSource, _legacyCacheRoot?: string) {}
  cancel(): void { this.generation++; this.checked = undefined; this.latestTree = undefined; this.client.cancel() }
  async releaseCache(): Promise<void> { this.cancel(); this.states = new WeakMap() }
  private async session<T>(operation: (session: GitHubSession) => Promise<T>): Promise<T> {
    try { return await this.client.session(operation) }
    catch (error) {
      if (error instanceof GitHubError && [401, 403].includes(error.status)) this.checked = undefined
      throw error
    }
  }
  async connect(): Promise<RepoConnection> {
    return this.session(async session => (await this.scope(session, true, true)).connection)
  }
  private async scope(session: GitHubSession, recheck = false, connect = false): Promise<RemoteScope> {
    const generation = this.generation, binding = this.binding()
    const key = JSON.stringify([binding.ownerRepo, binding.repositoryId, binding.participantId, binding.branch, binding.repositoryDirectory])
    let connection = !recheck && this.checked?.key === key ? this.checked.connection : undefined
    // Connection/account changes and writes recheck identity. Ordinary polling uses
    // GitHub authorization on each HEAD request, not a second /user handshake timer.
    if (!connection) {
      connection = await inspectPrivateRepo(session, connect ? { ...binding, participantId: undefined } : binding)
      this.check({ generation } as RemoteScope)
      this.checked = { key, connection }
    }
    const directory = binding.repositoryDirectory ?? 'dss-coop'
    if (directory && (!validCoopPath('dss-coop/' + directory) || directory.startsWith('/'))) throw new Error('Use a directory inside the Git repository.')
    return { connection, directory, path: repositoryPath(connection.repository.fullName), generation }
  }
  private check(scope: RemoteScope): void {
    if (scope.generation !== this.generation) throw new DOMException('Repository operation canceled.', 'AbortError')
  }
  private physical(scope: RemoteScope, path: string): string {
    if (path === 'dss-coop') return scope.directory
    if (!validCoopPath(path)) throw new Error('Choose a record inside the configured DSS directory.')
    return (scope.directory ? scope.directory + '/' : '') + path.slice('dss-coop/'.length)
  }
  private async head(session: GitHubSession, scope: RemoteScope): Promise<string> {
    try {
      return (await session.request<{ object: { sha: string } }>('GET', scope.path + '/git/ref/heads/' + encodePath(scope.connection.repository.branch))).object.sha
    } catch (error) {
      if (!(error instanceof GitHubError) || ![404, 409].includes(error.status)) throw error
      // Do not reinterpret a wrong branch, removed access, or network failure as an
      // empty repository. This successful branch listing establishes the empty case.
      const branches = await session.request<Array<{ name: string }>>('GET', scope.path + '/branches?per_page=1')
      if (branches.length) throw error
      return ''
    }
  }
  private async makeSnapshot(session: GitHubSession, scope: RemoteScope, head: string): Promise<GitSnapshot> {
    const scopeKey = scope.path + '/' + scope.directory
    let tree = this.latestTree?.scopeKey === scopeKey && this.latestTree.head === head ? this.latestTree.tree : undefined
    if (tree === undefined) tree = head ? (await session.request<RemoteCommit>('GET', scope.path + '/git/commits/' + head)).tree.sha : ''
    this.check(scope)
    this.latestTree = { scopeKey, head, tree }
    const snapshot: GitSnapshot = { head, tree, files: new Map(), reads: new Map() }
    this.states.set(snapshot, { scope, trees: new Map(), loaded: new Set() })
    return snapshot
  }
  snapshot(_afterWrite = false): Promise<GitSnapshot> {
    // Each invocation reads the remote branch; no pre-write request is reused by
    // read-back, and immutable snapshots never borrow mutable metadata from others.
    return this.session(async session => {
      const scope = await this.scope(session)
      return this.makeSnapshot(session, scope, await this.head(session, scope))
    })
  }
  async at(revision: string): Promise<GitSnapshot> {
    if (!/^[0-9a-f]{40,64}$/.test(revision)) throw new Error('Use a Git commit id.')
    return this.session(async session => this.makeSnapshot(session, await this.scope(session), revision))
  }
  private state(snapshot: GitSnapshot): SnapshotState {
    const state = this.states.get(snapshot)
    if (!state) throw new Error('Use a snapshot obtained from this repository.')
    this.check(state.scope)
    return state
  }
  private tree(session: GitHubSession, state: SnapshotState, sha: string): Promise<TreeEntry[]> {
    let pending = state.trees.get(sha)
    if (!pending) {
      pending = session.request<{ tree: TreeEntry[]; truncated: boolean }>('GET', state.scope.path + '/git/trees/' + sha).then(result => {
        this.check(state.scope)
        // Non-recursive trees avoid the recursive API's 100,000 entry/7 MB cap.
        // Never silently interpret a truncated response as a complete directory.
        if (result.truncated) throw new Error('GitHub returned a truncated directory tree: ' + sha)
        return result.tree
      }).catch(error => { state.trees.delete(sha); throw error })
      state.trees.set(sha, pending)
    }
    return pending
  }
  private async entry(session: GitHubSession, snapshot: GitSnapshot, physical: string): Promise<TreeEntry | undefined> {
    const state = this.state(snapshot)
    if (!snapshot.tree) return
    if (!physical) return { path: '', type: 'tree', sha: snapshot.tree }
    let sha = snapshot.tree
    const parts = physical.split('/')
    for (let i = 0; i < parts.length; i++) {
      const found = (await this.tree(session, state, sha)).find(item => item.path === parts[i])
      if (!found) return
      if (i === parts.length - 1) return found
      if (found.type !== 'tree') return
      sha = found.sha
    }
  }
  /** Direct children only: Host can inspect root signals without watching other
   * participants' subtrees. Paths are logical, with no trailing slash. Resolving
   * ancestors and the directory reads only immutable non-recursive tree metadata.
   * This does not mark a recursive listing complete or populate snapshot.files.
   */
  async listDirectory(snapshot: GitSnapshot, prefix: string): Promise<Array<{ path: string; sha: string; type: 'blob' | 'tree' | 'commit'; size?: number }>> {
    const root = prefix.replace(/\/$/, ''), state = this.state(snapshot)
    return this.session(async session => {
      const entry = await this.entry(session, snapshot, this.physical(state.scope, root))
      if (!entry || entry.type !== 'tree') return []
      const children = await this.tree(session, state, entry.sha)
      this.check(state.scope)
      return children.map(child => ({ ...child, path: root + '/' + child.path }))
    })
  }
  async directories(snapshot: GitSnapshot, prefix: string): Promise<string[]> {
    const root = prefix.replace(/\/$/, ''), state = this.state(snapshot)
    return this.session(async session => {
      const entry = await this.entry(session, snapshot, this.physical(state.scope, root))
      if (!entry || entry.type !== 'tree') return []
      return (await this.tree(session, state, entry.sha)).filter(item => item.type === 'tree').map(item => root + '/' + item.path + '/')
    })
  }
  async list(snapshot: GitSnapshot, prefix: string): Promise<void> {
    const root = prefix.replace(/\/$/, ''), state = this.state(snapshot)
    if (state.loaded.has(root)) return
    await this.session(async session => {
      const entry = await this.entry(session, snapshot, this.physical(state.scope, root)), files = new Map<string, string>()
      const visit = async (sha: string, logical: string): Promise<void> => {
        for (const child of await this.tree(session, state, sha)) {
          if (child.type === 'tree') await visit(child.sha, logical + '/' + child.path)
          else if (child.type === 'blob') files.set(logical + '/' + child.path, child.sha)
        }
      }
      if (entry?.type === 'tree') await visit(entry.sha, root)
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
    return this.session(async session => {
      const entry = await this.entry(session, snapshot, this.physical(state.scope, path))
      const sha = entry?.type === 'blob' ? entry.sha : undefined
      snapshot.reads?.set(path, sha)
      if (!sha) return
      ;(snapshot.files as Map<string, string>).set(path, sha)
      const blob = await session.request<{ content: string; encoding: string }>('GET', state.scope.path + '/git/blobs/' + sha)
      this.check(state.scope)
      if (blob.encoding !== 'base64') throw new Error('Unsupported GitHub blob encoding: ' + blob.encoding)
      const bytes = Buffer.from(blob.content.replace(/\s/g, ''), 'base64')
      // Verify the immutable Git blob rather than cache or trust partial bodies.
      const algorithm = sha.length === 64 ? 'sha256' : 'sha1'
      const actual = createHash(algorithm).update('blob ' + bytes.length + '\0').update(bytes).digest('hex')
      if (actual !== sha) throw new Error('Git blob integrity mismatch: ' + path)
      return bytes
    })
  }
  /** Net file difference between two immutable snapshots, including own writes.
   * This is NOT a per-commit event log. Host discovery uses current Inbox/state
   * versions; consumers must not infer transient intermediate events from it.
   * Only tree metadata is read, never the business file bodies.
   */
  async changes(snapshot: GitSnapshot, from: string, _ownInstance?: string): Promise<GitFileChange[]> {
    if (snapshot.head === from) return []
    const state = this.state(snapshot)
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
        return { status: 'confirmed', commit: cursor, head }
      }
      // First-parent ancestry is sufficient for commits appended to this branch by
      // createCommitOnBranch. A rewritten/missing ancestry remains UNKNOWN, never
      // falsely absent; no arbitrary scan count converts missing evidence to success.
      cursor = commit.parents[0]?.sha ?? ''
    }
    return cursor === operation.expectedHead ? { status: 'conflict', head }
      : { status: 'unknown', head, reason: 'Expected base is not on the current first-parent chain; history may have been rewritten.' }
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
  async commitPrepared(base: GitSnapshot, changes: readonly GitChange[], message: string, operation: GitCommitOperation): Promise<GitReceipt> {
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
        if (resolution.status === 'confirmed') return { commit: resolution.commit, replay: true }
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
      let result: { data?: { createCommitOnBranch?: { commit?: { oid: string } } }; errors?: Array<{ message: string; type?: string }> } | undefined
      let failure: unknown
      try {
        result = await session.request('POST', '/graphql', { query: 'mutation DSSCommit($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }', variables: { input } })
      } catch (error) {
        if (error instanceof GitHubError && [401, 403].includes(error.status)) {
          this.checked = undefined
          // An explicit authorization rejection is not a transport-unknown write.
          // Preserve its exact upstream status so revocation remains visible.
          throw error
        }
        failure = error
      }
      const oid = result?.data?.createCommitOnBranch?.commit?.oid
      if (oid) return { commit: oid, replay: false }
      // Every ambiguous transport/GraphQL response uses the same read-back path.
      // A newer HEAD alone is NOT proof of rejection: our commit may precede it.
      let resolution: GitCommitResolution | undefined
      try { resolution = await this.resolve(session, scope, operation) } catch { /* keep UNKNOWN */ }
      if (resolution?.status === 'confirmed') return { commit: resolution.commit, replay: false }
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
