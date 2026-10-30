import type { CoopCollaborator, CoopInvitation, RepoBinding, RepoConnection } from './contracts.js'

export const GITHUB_CLI_SETUP_REQUIRED = 'Configure GitHub CLI: install gh and run gh auth login --hostname github.com.'
export const GITHUB_CLI_ACCESS_REQUIRED = 'Configure GitHub CLI and verify access to this repository.'

export interface ResolvedToken { value: string; source: string }
export type TokenSource = () => Promise<ResolvedToken | undefined>
export type GitHubFetch = (input: string, init?: RequestInit) => Promise<Response>
export interface GitHubSession { request<T>(method: string, path: string, body?: unknown): Promise<T> }

export class GitHubError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfter?: number) { super(message); this.name = 'GitHubError' }
}
export class GitConflictError extends Error {
  constructor(message = 'Git HEAD changed. Read the latest snapshot before retrying this transaction.') { super(message); this.name = 'GitConflictError' }
}
export function repositoryPath(ownerRepo: string): string {
  const parts = ownerRepo.trim().replace(/^https:\/\/github\.com\//i, '').replace(/\/$/, '').replace(/\.git$/, '').split('/')
  if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..')) throw new Error('Use a GitHub owner/repo name.')
  return '/repos/' + parts.map(encodeURIComponent).join('/')
}

/** Secrets exist only inside one operation; no credential is returned or cached. */
export class GitHubClient {
  private requests = new AbortController()
  constructor(private readonly tokenSource: TokenSource, private readonly fetcher: GitHubFetch = fetch,
    private readonly requestTimeoutMs = 60_000) {}
  cancel(): void { this.requests.abort(); this.requests = new AbortController() }
  async session<T>(operation: (session: GitHubSession) => Promise<T>): Promise<T> {
    const signal = this.requests.signal
    const token = await this.tokenSource()
    signal.throwIfAborted()
    if (!token?.value) throw new GitHubError(401, GITHUB_CLI_SETUP_REQUIRED)
    const request = async <R>(method: string, path: string, body?: unknown): Promise<R> => {
      signal.throwIfAborted()
      if (!path.startsWith('/') || path.startsWith('//') || path.includes('://')) throw new Error('Invalid GitHub API path.')
      let response: Response
      try {
        response = await this.fetcher('https://api.github.com' + path, {
          method, signal: AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMs)]), headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token.value,
            'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'DeepSeek-Servant-Coop', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      } catch (error) {
        signal.throwIfAborted()
        throw new GitHubError(0, (error instanceof Error ? error.message : 'GitHub network request failed.').split(token.value).join('[redacted]'))
      }
      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as { message?: string }
        const message = String(data.message ?? response.statusText).split(token.value).join('[redacted]')
        const seconds = Number(response.headers.get('retry-after')) || (response.headers.get('x-ratelimit-remaining') === '0' ? Math.max(1, Number(response.headers.get('x-ratelimit-reset')) - Math.floor(Date.now() / 1000)) : 0)
        const hint = token.source === 'GitHub CLI' && [401, 403, 404].includes(response.status) ? GITHUB_CLI_ACCESS_REQUIRED + ' ' : ''
        throw new GitHubError(response.status, hint + 'GitHub ' + response.status + ': ' + message + ' (' + method + ' ' + path + '; authorization: ' + token.source + ')', seconds > 0 ? seconds : undefined)
      }
      const result = response.status === 204 ? undefined : await response.json()
      signal.throwIfAborted()
      return result as R
    }
    return operation({ request })
  }
}

export async function inspectPrivateRepo(session: GitHubSession, binding: RepoBinding): Promise<RepoConnection> {
  const [repo, identity] = await Promise.all([
    session.request<{ id: number; full_name: string; default_branch: string; private: boolean; permissions?: Record<string, boolean> }>('GET', repositoryPath(binding.ownerRepo)),
    session.request<{ id: number; login: string }>('GET', '/user'),
  ])
  if (!repo.private) throw new GitHubError(422, 'This repository is public. Git collaboration requires a private repository.')
  if (binding.repositoryId !== undefined && repo.id !== binding.repositoryId) throw new GitHubError(409, 'This is a different GitHub repository. Confirm the repository selection.')
  if (binding.participantId !== undefined && identity.id !== binding.participantId) throw new GitHubError(409, 'The GitHub account changed. Connect this account before continuing.')
  return { identity: { id: identity.id, login: identity.login }, repository: {
    id: repo.id, fullName: repo.full_name, branch: binding.branch ?? repo.default_branch ?? 'main', private: true,
    permissions: { pull: repo.permissions?.pull ?? true, push: repo.permissions?.push ?? false, admin: repo.permissions?.admin ?? false },
  } }
}

/** Member actions are explicit UI operations; invitation acceptance stays on GitHub. */
export interface MemberScope { expectedRepositoryId?: number; expectedParticipantId?: number }
export class GitHubMembers {
  constructor(private readonly client: GitHubClient, private readonly binding: () => RepoBinding) {}
  private async withRepo<T>(action: (session: GitHubSession, path: string, connection: RepoConnection) => Promise<T>, expected: MemberScope = {}): Promise<T> {
    const binding = this.binding()
    if (expected.expectedRepositoryId !== undefined && expected.expectedRepositoryId !== binding.repositoryId
      || expected.expectedParticipantId !== undefined && expected.expectedParticipantId !== binding.participantId) {
      throw new GitHubError(409, 'The GitHub account or repository changed. Refresh members and confirm the action again.')
    }
    return this.client.session(async session => { const connection = await inspectPrivateRepo(session, binding); return action(session, repositoryPath(connection.repository.fullName), connection) })
  }
  private async pages<T>(session: GitHubSession, path: string): Promise<T[]> {
    const result: T[] = []
    for (let page = 1; ; page++) {
      const batch = await session.request<T[]>('GET', path + '?per_page=100&page=' + page)
      result.push(...batch)
      if (batch.length < 100) return result
    }
  }
  invitations(expected?: MemberScope): Promise<CoopInvitation[]> {
    return this.withRepo(async (session, path) => (await this.pages<{ id: number; invitee: { login: string }; html_url?: string }>(session, path + '/invitations'))
      .map(item => ({ id: item.id, login: item.invitee.login, status: 'pending', htmlUrl: item.html_url })), expected)
  }
  collaborators(expected?: MemberScope): Promise<CoopCollaborator[]> {
    return this.withRepo(async (session, path) => (await this.pages<{ id: number; login: string; permissions: Record<string, boolean> }>(session, path + '/collaborators'))
      .map(item => ({ id: item.id, login: item.login, permissions: item.permissions, status: 'accepted' })), expected)
  }
  invite(login: string, expected?: MemberScope): Promise<{ status: 'pending' | 'accepted'; id?: number; login: string }> {
    if (!/^[A-Za-z0-9-]+$/.test(login)) throw new Error('Enter a GitHub username.')
    return this.withRepo(async (session, path, connection) => {
      if (!connection.repository.permissions.admin) throw new GitHubError(403, 'GitHub repository administration permission is required to invite members.')
      const result = await session.request<{ id: number } | undefined>('PUT', path + '/collaborators/' + encodeURIComponent(login), { permission: 'push' })
      return { status: result ? 'pending' : 'accepted', id: result?.id, login }
    }, expected)
  }
  cancelInvitation(id: number, expected?: MemberScope): Promise<void> {
    return this.withRepo(async (session, path) => { await session.request('DELETE', path + '/invitations/' + id) }, expected)
  }
  remove(login: string, expected?: MemberScope): Promise<void> {
    if (!/^[A-Za-z0-9-]+$/.test(login)) throw new Error('Enter a GitHub username.')
    return this.withRepo(async (session, path) => { await session.request('DELETE', path + '/collaborators/' + encodeURIComponent(login)) }, expected)
  }
}
