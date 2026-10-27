import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GitChange, GitFileChange, GitReceipt, GitRepository, GitSnapshot, RepoBinding, RepoConnection } from './contracts.js'
import { GitConflictError, GitHubClient, inspectPrivateRepo, type TokenSource } from './github.js'
import { GitError, runGit } from './vendor/git-runner.js'

export function validCoopPath(path: string): boolean {
  return path.startsWith('dss-coop/') && !/[\\\0\r\n]/.test(path)
    && path.split('/').every(part => part.length > 0 && part !== '.' && part !== '..')
}
interface GitEnvironment { cwd: string; env: NodeJS.ProcessEnv; connection: RepoConnection; directory: string; signal: AbortSignal }

/** On-demand Git adapter. Only the Host sync owns a timer; this class never schedules work.
 * Reuses dsh-tool-git's MIT runner, without installing its model-tool safety hook.
 * Git objects are a rebuildable partial-clone cache, not a task database.
 */
export class GitHubRepository implements GitRepository {
  private controller = new AbortController()
  private confirmed?: GitSnapshot
  private scope?: string
  private readonly loaded = new WeakMap<GitSnapshot, Set<string>>()
  private readonly environments = new WeakMap<GitSnapshot, GitEnvironment>()
  private readonly directoryCache = new WeakMap<GitSnapshot, Map<string, string[]>>()
  private readonly absent = new WeakMap<GitSnapshot, Set<string>>()
  private checked?: { key: string; tokenHash: string; connection: RepoConnection }
  private prepared?: string
  private readonly blobs = new Map<string, string>()
  private snapshotPending?: Promise<GitSnapshot>
  constructor(private readonly client: GitHubClient, private readonly binding: () => RepoBinding,
    private readonly tokens: TokenSource, private readonly cacheRoot = join(tmpdir(), 'deepseek-servant-git')) {}
  cancel(): void { this.controller.abort(); this.controller = new AbortController(); this.confirmed = undefined; this.blobs.clear(); this.checked = undefined; this.prepared = undefined }
  async releaseCache(): Promise<void> {
    const scope = this.scope
    this.cancel()
    await this.snapshotPending?.catch(() => {})
    if (scope) {
      const ownedDirectory = join(this.cacheRoot, createHash('sha256').update(scope).digest('hex').slice(0, 24))
      await rm(ownedDirectory, { recursive: true, force: true })
    }
    this.scope = undefined
  }
  connect(): Promise<RepoConnection> { return this.client.session(session => inspectPrivateRepo(session, { ...this.binding(), participantId: undefined })) }
  private async environment(forWrite = false): Promise<GitEnvironment> {
    const signal = this.controller.signal, binding = this.binding()
    const token = await this.tokens()
    signal.throwIfAborted()
    if (!token) throw new Error('Sign in with GitHub CLI or configure the existing DSH GitHub credential.')
    const key = JSON.stringify([binding.ownerRepo, binding.repositoryId, binding.participantId, binding.branch])
    const tokenHash = createHash('sha256').update(token.value).digest('hex')
    let connection = !forWrite && this.checked?.key === key && this.checked.tokenHash === tokenHash ? this.checked.connection : undefined
    if (!connection) {
      connection = await this.client.session(session => inspectPrivateRepo(session, binding))
      this.checked = { key, tokenHash, connection }
    }
    const directory = binding.repositoryDirectory ?? 'dss-coop'
    const scope = connection.repository.fullName + '/' + directory + '/' + (binding.instanceId ?? 'default')
    if (this.scope !== scope) { this.scope = scope; this.confirmed = undefined; this.blobs.clear(); this.prepared = undefined }
    const cwd = join(this.cacheRoot, createHash('sha256').update(scope).digest('hex').slice(0, 24))
    if (this.prepared !== scope) await mkdir(cwd, { recursive: true })
    const env: NodeJS.ProcessEnv = {
      // Credentials stay in the subprocess environment, never in URLs, config or disk.
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic ' + Buffer.from('x-access-token:' + token.value).toString('base64'),
      GIT_CONFIG_NOSYSTEM: '0', GIT_DIR: cwd, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined,
    }
    const result = { cwd, env, connection, directory, signal }
    if (this.prepared !== scope) {
      try { await this.git(result, ['rev-parse', '--git-dir']) }
      catch (error) {
        if (!(error instanceof GitError)) throw error
        await this.git(result, ['init', '--bare', '.'])
        await this.git(result, ['config', 'remote.origin.url', 'https://github.com/' + connection.repository.fullName + '.git'])
        await this.git(result, ['config', 'remote.origin.promisor', 'true'])
        await this.git(result, ['config', 'remote.origin.partialclonefilter', 'blob:none'])
        await this.git(result, ['config', 'core.logAllRefUpdates', 'false'])
      }
      this.prepared = scope
    }
    return result
  }
  private async git(e: GitEnvironment, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
    return (await runGit('git', ['--literal-pathspecs', ...args], { cwd: e.cwd, signal: e.signal, env: { ...e.env, ...env } })).stdout
  }
  private physical(e: GitEnvironment, path: string): string {
    if (path === 'dss-coop') return e.directory
    if (!validCoopPath(path)) throw new Error('Choose a record inside the configured DSS-cah directory.')
    return e.directory + '/' + path.slice('dss-coop/'.length)
  }
  private async fetch(e: GitEnvironment): Promise<string> {
    const branch = e.connection.repository.branch
    try {
      await this.git(e, ['fetch', '--no-tags', '--filter=blob:none', 'origin', '+refs/heads/' + branch + ':refs/remotes/origin/' + branch])
    } catch (error) {
      if (!(error instanceof GitError) || !/couldn't find remote ref/.test(error.stderr)) throw error
      // A new empty repository has no branch yet. Do not reinterpret authentication or transport failures as empty.
      if ((await this.git(e, ['ls-remote', '--heads', 'origin'])).trim()) throw error
      return ''
    }
    return (await this.git(e, ['rev-parse', 'refs/remotes/origin/' + branch])).trim()
  }
  private async entries(e: GitEnvironment, head: string, path: string, recursive: boolean): Promise<Map<string, string>> {
    if (!head) return new Map()
    const output = await this.git(e, ['ls-tree', '-z', ...(recursive ? ['-r'] : []), head, '--', path])
    const result = new Map<string, string>()
    for (const line of output.split('\0')) {
      const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/s.exec(line)
      if (match) result.set('dss-coop/' + match[2]!.slice(e.directory.length + 1), match[1]!)
    }
    return result
  }
  snapshot(): Promise<GitSnapshot> {
    this.snapshotPending ??= this.refresh().finally(() => { this.snapshotPending = undefined })
    return this.snapshotPending.then(source => {
      const snapshot = { ...source, reads: new Map<string, string | undefined>() }
      const environment = this.environments.get(source)
      if (environment) this.environments.set(snapshot, environment)
      this.loaded.set(snapshot, this.loaded.get(source)!)
      this.directoryCache.set(snapshot, this.directoryCache.get(source)!)
      this.absent.set(snapshot, this.absent.get(source)!)
      return snapshot
    })
  }
  private async refresh(): Promise<GitSnapshot> {
    const e = await this.environment(), head = await this.fetch(e)
    const previous = this.confirmed
    if (previous?.head === head) { this.environments.set(previous, e); return previous }
    const files = new Map(previous?.files)
    if (previous?.head && previous.head !== head && head) {
      // Git performs transfer incrementally. Only names changed under the configured directory are compared.
      const changed = (await this.git(e, ['diff', '--name-only', '-z', '--no-renames', previous.head, head, '--', e.directory + '/'])).split('\0').filter(Boolean)
      for (const path of changed) {
        const logical = 'dss-coop/' + path.slice(e.directory.length + 1)
        files.delete(logical)
        // Remember only metadata already requested. Newly added inputs are discovered by the next targeted list.
        if (previous.files.has(logical)) for (const [name, sha] of await this.entries(e, head, path, false)) files.set(name, sha)
      }
    }
    if (!head) files.clear()
    const snapshot: GitSnapshot = { head, tree: head ? (await this.git(e, ['rev-parse', head + '^{tree}'])).trim() : '', files, reads: new Map() }
    this.confirmed = snapshot
    this.loaded.set(snapshot, new Set())
    this.directoryCache.set(snapshot, new Map())
    this.absent.set(snapshot, new Set())
    this.environments.set(snapshot, e)
    return snapshot
  }
  async directories(snapshot: GitSnapshot, prefix: string): Promise<string[]> {
    let cached = this.directoryCache.get(snapshot)
    if (!cached) this.directoryCache.set(snapshot, cached = new Map())
    const known = cached.get(prefix)
    if (known) return known
    const e = this.environments.get(snapshot) ?? await this.environment()
    const path = this.physical(e, prefix.replace(/\/$/, ''))
    if (!snapshot.head) return []
    try {
      const output = await this.git(e, ['ls-tree', '-z', '-d', '--name-only', snapshot.head + ':' + path])
      const result = output.split('\0').filter(Boolean).map(name => prefix.replace(/\/$/, '') + '/' + name + '/')
      cached.set(prefix, result)
      return result
    } catch (error) {
      if (error instanceof GitError && /does not exist|Not a valid object name/.test(error.stderr)) { cached.set(prefix, []); return [] }
      throw error
    }
  }
  async list(snapshot: GitSnapshot, prefix: string): Promise<void> {
    const directory = prefix.endsWith('/') ? prefix : prefix + '/'
    let loaded = this.loaded.get(snapshot)
    if (!loaded) this.loaded.set(snapshot, loaded = new Set())
    if (loaded.has(directory)) return
    const e = this.environments.get(snapshot) ?? await this.environment(), physical = this.physical(e, directory.slice(0, -1)) + '/'
    const files = snapshot.files as Map<string, string>
    for (const path of files.keys()) if (path.startsWith(directory)) files.delete(path)
    for (const [path, sha] of await this.entries(e, snapshot.head, physical, true)) files.set(path, sha)
    loaded.add(directory)
  }
  async at(revision: string): Promise<GitSnapshot> {
    if (!/^[0-9a-f]{40,64}$/.test(revision)) throw new Error('Use the commit id from the change notification.')
    const e = await this.environment()
    const tree = (await this.git(e, ['rev-parse', revision + '^{tree}'])).trim()
    const snapshot: GitSnapshot = { head: revision, tree, files: new Map(), reads: new Map() }
    this.environments.set(snapshot, e)
    return snapshot
  }
  async changes(snapshot: GitSnapshot, from: string, ownInstance?: string): Promise<GitFileChange[]> {
    if (!snapshot.head || from === snapshot.head) return []
    const e = this.environments.get(snapshot) ?? await this.environment()
    const changes: GitFileChange[] = []
    if (!from) {
      // Initial discovery reads names and object IDs, never blobs or historical file bodies.
      for (const [path, after] of await this.entries(e, snapshot.head, e.directory + '/', true)) {
        if (/^dss-coop\/(?:instances\/[^/]+\/(?:status|watch)\.json|participants\/[^/]+\/profile\.json|assistants\/[^/]+\/[^/]+\/identity\.json)$/.test(path)) continue
        changes.push({ path, status: 'A', commit: snapshot.head, after })
      }
      return changes
    }
    const commits = await this.git(e, ['log', '--reverse', '--first-parent', '--format=%H%x09%P%x09%(trailers:key=DSS-cah-Instance,valueonly)', from + '..' + snapshot.head, '--', e.directory + '/'])
    for (const line of commits.split('\n').filter(Boolean)) {
      const [commit, parents, instance] = line.split('\t')
      if (!commit || ownInstance && instance?.trim() === ownInstance) continue
      const parent = parents?.split(' ')[0]
      const raw = await this.git(e, ['diff-tree', '--no-commit-id', '--root', '-r', '--raw', '-z', '--no-renames', '--no-abbrev',
        ...(parent ? [parent, commit] : [commit]), '--', e.directory + '/'])
      const fields = raw.split('\0')
      for (let i = 0; i + 1 < fields.length; i += 2) {
        const match = /^:\d+ \d+ ([0-9a-f]+) ([0-9a-f]+) ([A-Z])$/.exec(fields[i]!)
        const path = fields[i + 1]
        if (!match || !path) continue
        const status = match[3] === 'A' ? 'A' : match[3] === 'D' ? 'D' : 'M'
        changes.push({ path: 'dss-coop/' + path.slice(e.directory.length + 1), status, commit, parent,
          before: /^0+$/.test(match[1]!) ? undefined : match[1], after: /^0+$/.test(match[2]!) ? undefined : match[2] })
      }
    }
    return changes
  }
  async read(snapshot: GitSnapshot, path: string): Promise<string | undefined> {
    const e = this.environments.get(snapshot) ?? await this.environment(), physical = this.physical(e, path)
    let sha = snapshot.files.get(path)
    let absent = this.absent.get(snapshot)
    if (!absent) this.absent.set(snapshot, absent = new Set())
    const listed = [...(this.loaded.get(snapshot) ?? [])].some(prefix => path.startsWith(prefix))
    if (!sha && !absent.has(path) && !listed) {
      sha = (await this.entries(e, snapshot.head, physical, false)).get(path)
      if (sha) (snapshot.files as Map<string, string>).set(path, sha)
    }
    snapshot.reads?.set(path, sha)
    if (!sha) { absent.add(path); return }
    const cached = this.blobs.get(sha)
    if (cached !== undefined) return cached
    const content = await this.git(e, ['show', snapshot.head + ':' + physical])
    this.blobs.set(sha, content)
    if (this.blobs.size > 256) this.blobs.delete(this.blobs.keys().next().value!)
    return content
  }
  async commit(base: GitSnapshot, changes: readonly GitChange[], message: string): Promise<GitReceipt> {
    if (!changes.length || changes.some(change => !validCoopPath(change.path))) throw new Error('Commit changes inside the configured DSS-cah directory.')
    if (new Set(changes.map(change => change.path)).size !== changes.length) throw new Error('Duplicate paths in a Git transaction.')
    const e = await this.environment(true), head = await this.fetch(e)
    // Rebase onto unrelated remote commits. Conflicts concern only this operation's reads and writes.
    if (head !== base.head) {
      const paths = new Set([...changes.map(change => change.path), ...(base.reads?.keys() ?? [])])
      for (const path of paths) {
        const now = (await this.entries(e, head, this.physical(e, path), false)).get(path)
        const before = base.reads?.has(path) ? base.reads.get(path) : (await this.entries(e, base.head, this.physical(e, path), false)).get(path)
        if (now !== before) throw new GitConflictError('The affected record changed: ' + path)
      }
    }
    const temp = await mkdtemp(join(e.cwd, 'transaction-')), env = { GIT_INDEX_FILE: join(temp, 'index'), GIT_WORK_TREE: e.cwd }
    try {
      await this.git(e, head ? ['read-tree', head] : ['read-tree', '--empty'], env)
      for (let i = 0; i < changes.length; i++) {
        const change = changes[i]!, path = this.physical(e, change.path)
        if (change.content === null) { await this.git(e, ['update-index', '--force-remove', '--', path], env); continue }
        const file = join(temp, String(i)); await writeFile(file, change.content, 'utf8')
        const sha = (await this.git(e, ['hash-object', '-w', file])).trim()
        await this.git(e, ['update-index', '--add', '--cacheinfo', '100644', sha, path], env)
      }
      const tree = (await this.git(e, ['write-tree'], env)).trim()
      const name = e.connection.identity.login, email = e.connection.identity.id + '+' + name + '@users.noreply.github.com'
      const commit = (await this.git(e, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', message + '\n\nDSS-cah-Instance: ' + (this.binding().instanceId ?? 'default')],
        { ...env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email })).trim()
      try { await this.git(e, ['push', 'origin', commit + ':refs/heads/' + e.connection.repository.branch]) }
      catch (error) {
        if (error instanceof GitError && /\[rejected\].*(fetch first|non-fast-forward)/.test(error.stderr)) throw new GitConflictError('A concurrent commit changed the branch; retry this operation against it.')
        throw error
      }
      return { commit, replay: false }
    } finally {
      // This exact directory was allocated by this operation; no user workspace or shared objects are removed.
      await rm(temp, { recursive: true, force: true })
    }
  }
}
