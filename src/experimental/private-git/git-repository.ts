import type { GitChange, GitReceipt, GitRepository, GitSnapshot, RepoBinding, RepoConnection } from './contracts.js'
import { GitConflictError, GitHubClient, GitHubError, inspectPrivateRepo, repositoryPath, type GitHubSession } from './github.js'

interface TreeEntry { path: string; type: 'blob' | 'tree'; sha: string }
interface TreeResponse { tree: TreeEntry[]; truncated?: boolean }
const schema = JSON.stringify({ protocol: 'dss-coop', version: 1 }, null, 2) + '\n'
export function validCoopPath(path: string): boolean {
  return path.startsWith('dss-coop/') && !path.includes('\\') && !path.includes('\0')
    && path.split('/').every(part => part.length > 0 && part !== '.' && part !== '..')
}

/** Git Data API transactions preserve other paths and never force-update a ref. */
export class GitHubRepository implements GitRepository {
  private readonly blobs = new Map<string, Promise<string>>()
  private confirmed?: { repository: string; snapshot: GitSnapshot }
  constructor(private readonly client: GitHubClient, private readonly binding: () => RepoBinding) {}
  connect(): Promise<RepoConnection> { return this.client.session(session => inspectPrivateRepo(session, { ...this.binding(), participantId: undefined })) }
  private async scope<T>(operation: (session: GitHubSession, path: string, connection: RepoConnection) => Promise<T>): Promise<T> {
    return this.client.session(async session => {
      const connection = await inspectPrivateRepo(session, this.binding())
      return operation(session, repositoryPath(connection.repository.fullName), connection)
    })
  }
  private async snapshotAt(session: GitHubSession, path: string, branch: string): Promise<GitSnapshot> {
    let head: string
    try { head = (await session.request<{ object: { sha: string } }>('GET', path + '/git/ref/heads/' + encodeURIComponent(branch))).object.sha }
    catch (error) {
      if (!(error instanceof GitHubError) || ![404, 409].includes(error.status)) throw error
      let refs: unknown[]
      try { refs = await session.request<unknown[]>('GET', path + '/git/matching-refs/heads/') }
      catch (empty) { if (empty instanceof GitHubError && empty.status === 409) refs = []; else throw empty }
      if (refs.length) throw error
      return { head: '', tree: '', files: new Map() }
    }
    if (this.confirmed?.repository === path && this.confirmed.snapshot.head === head) return this.confirmed.snapshot
    const commit = await session.request<{ tree: { sha: string } }>('GET', path + '/git/commits/' + head)
    const root = await session.request<TreeResponse>('GET', path + '/git/trees/' + commit.tree.sha)
    const subtree = root.tree.find(entry => entry.path === 'dss-coop' && entry.type === 'tree')
    const files = new Map<string, string>()
    const walk = async (sha: string, prefix: string): Promise<void> => {
      const tree = await session.request<TreeResponse>('GET', path + '/git/trees/' + sha)
      for (const entry of tree.tree) {
        if (entry.type === 'blob') files.set(prefix + entry.path, entry.sha)
        else await walk(entry.sha, prefix + entry.path + '/')
      }
    }
    if (subtree) {
      const tree = await session.request<TreeResponse>('GET', path + '/git/trees/' + subtree.sha + '?recursive=1')
      if (tree.truncated) await walk(subtree.sha, 'dss-coop/')
      else for (const entry of tree.tree) if (entry.type === 'blob') files.set('dss-coop/' + entry.path, entry.sha)
    }
    const snapshot = { head, tree: commit.tree.sha, files }
    this.confirmed = { repository: path, snapshot }
    return snapshot
  }
  snapshot(): Promise<GitSnapshot> { return this.scope((session, path, connection) => this.snapshotAt(session, path, connection.repository.branch)) }
  async read(snapshot: GitSnapshot, path: string): Promise<string | undefined> {
    if (!validCoopPath(path)) throw new Error('Read a dss-coop record path.')
    const sha = snapshot.files.get(path)
    if (!sha) return undefined
    let pending = this.blobs.get(sha)
    if (!pending) {
      pending = this.client.session(async session => {
        const blob = await session.request<{ encoding: string; content: string }>('GET', repositoryPath(this.binding().ownerRepo) + '/git/blobs/' + sha)
        if (blob.encoding !== 'base64') throw new Error('Unsupported Git blob encoding: ' + blob.encoding)
        return Buffer.from(blob.content.replace(/\s/g, ''), 'base64').toString('utf8')
      })
      this.blobs.set(sha, pending)
      if (this.blobs.size > 256) this.blobs.delete(this.blobs.keys().next().value!)
      pending.catch(() => { this.blobs.delete(sha) })
    }
    return pending
  }
  commit(base: GitSnapshot, changes: readonly GitChange[], message: string): Promise<GitReceipt> {
    if (!changes.length || changes.some(change => !validCoopPath(change.path))) throw new Error('A commit must contain dss-coop record changes.')
    if (new Set(changes.map(change => change.path)).size !== changes.length) throw new Error('A transaction contains duplicate paths.')
    return this.scope(async (session, path, connection) => {
      let current = await this.snapshotAt(session, path, connection.repository.branch)
      if (current.head !== base.head) throw new GitConflictError()
      if (!current.head) {
        try {
          await session.request('PUT', path + '/contents/dss-coop/schema.json', { message: 'Initialize DSS private collaboration records', branch: connection.repository.branch, content: Buffer.from(schema).toString('base64') })
        } catch (error) {
          if (error instanceof GitHubError && [409, 422].includes(error.status)) throw new GitConflictError()
          throw error
        }
        current = await this.snapshotAt(session, path, connection.repository.branch)
      }
      const tree = await session.request<{ sha: string }>('POST', path + '/git/trees', {
        base_tree: current.tree, tree: changes.map(change => ({ path: change.path, mode: '100644', type: 'blob',
          ...(change.content === null ? { sha: null } : { content: change.content }) })),
      })
      const commit = await session.request<{ sha: string }>('POST', path + '/git/commits', { message, tree: tree.sha, parents: [current.head] })
      try { await session.request('PATCH', path + '/git/refs/heads/' + encodeURIComponent(connection.repository.branch), { sha: commit.sha, force: false }) }
      catch (error) {
        if (error instanceof GitHubError && [409, 422].includes(error.status)) throw new GitConflictError()
        throw error
      }
      return { commit: commit.sha, replay: false }
    })
  }
}
