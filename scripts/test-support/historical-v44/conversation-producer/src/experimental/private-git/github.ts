import { createHash } from 'node:crypto'
import type { CoopCollaborator, CoopInvitation, RepoBinding, RepoConnection } from './contracts.js'

export const GITHUB_CLI_SETUP_REQUIRED = 'Configure GitHub CLI: install gh and run gh auth login --hostname github.com.'
export const GITHUB_CLI_ACCESS_REQUIRED = 'Configure GitHub CLI and verify access to this repository.'

export interface ResolvedToken { value: string; source: string }
export type TokenSource = (signal?: AbortSignal) => Promise<ResolvedToken | undefined>
export type GitHubFetch = (input: string, init?: RequestInit) => Promise<Response>
export interface GitHubSession {
  /** Process-local credential identity; never contains an authenticating value. */
  readonly authorizationScope: object
  request<T>(method: string, path: string, body?: unknown): Promise<T>
}

export class GitHubError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfter?: number, readonly retryAt?: number, readonly rateLimit?: object) { super(message); this.name = 'GitHubError' }
}
export class GitConflictError extends Error {
  constructor(message = 'Git HEAD changed. Read the latest snapshot before retrying this transaction.') { super(message); this.name = 'GitConflictError' }
}
export function repositoryPath(ownerRepo: string): string {
  const parts = ownerRepo.trim().replace(/^https:\/\/github\.com\//i, '').replace(/\/$/, '').replace(/\.git$/, '').split('/')
  if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..')) throw new Error('Use a GitHub owner/repo name.')
  return '/repos/' + parts.map(encodeURIComponent).join('/')
}

/** Raw secrets exist only inside one operation; no credential is returned or cached.
 * A one-way, process-local fingerprint detects provider changes without another
 * /user handshake on every observation. Neither it nor its opaque scope is saved.
 */
export class GitHubClient {
  private requests = new AbortController()
  private signal: AbortSignal
  private authorization?: { fingerprint: string; scope: object; limits: Map<string, GitHubError>; secondaryFailure?: { request: string; delay: number } }
  constructor(private readonly tokenSource: TokenSource, private readonly fetcher: GitHubFetch = fetch,
    options?: { signal?: AbortSignal }) {
    // Opening belongs to its caller. After cancellation, a new explicit epoch
    // may finish disconnect bookkeeping without inheriting the closed opener.
    this.signal = options?.signal ? AbortSignal.any([this.requests.signal, options.signal]) : this.requests.signal
  }
  cancel(reason?: unknown): void { this.requests.abort(reason); this.requests = new AbortController(); this.signal = this.requests.signal }
  async session<T>(operation: (session: GitHubSession) => Promise<T>, ownerSignal?: AbortSignal): Promise<T> {
    const signal = ownerSignal ? AbortSignal.any([this.signal, ownerSignal]) : this.signal
    signal.throwIfAborted()
    const token = await this.tokenSource(signal)
    signal.throwIfAborted()
    if (!token?.value) throw new GitHubError(401, GITHUB_CLI_SETUP_REQUIRED)
    const fingerprint = createHash('sha256').update(token.value).digest('hex')
    if (this.authorization?.fingerprint !== fingerprint) this.authorization = { fingerprint, scope: {}, limits: new Map() }
    const authorization = this.authorization
    for (const [key, error] of authorization.limits) if (error.retryAt !== undefined && error.retryAt <= Date.now()) authorization.limits.delete(key)
    const request = async <R>(method: string, path: string, body?: unknown): Promise<R> => {
      signal.throwIfAborted()
      if (!path.startsWith('/') || path.startsWith('//') || path.includes('://')) throw new Error('Invalid GitHub API path.')
      // Current identity/member endpoints consume the REST core bucket.
      // Cooldowns belong to this credential, never to one repository.
      const resource = 'core', requestKey = method + ' ' + path
      const limited = [authorization.limits.get('*'), authorization.limits.get(resource)]
        .filter((error): error is GitHubError => error?.retryAt !== undefined && error.retryAt > Date.now())
        .sort((a, b) => b.retryAt! - a.retryAt!)[0]
      if (limited) throw new GitHubError(limited.status, limited.message, (limited.retryAt! - Date.now()) / 1000, limited.retryAt, limited.rateLimit)
      let response: Response
      try {
        response = await this.fetcher('https://api.github.com' + path, {
          method, signal, headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token.value,
            'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'DeepSeek-Servant-Coop', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      } catch (error) {
        // A later owner abort must not relabel an already independent transport
        // failure. Native fetch preserves its actual signal reason (or cause).
        if (signal.aborted && (error === signal.reason
          || error instanceof Error && error.name === 'AbortError' && error.cause === signal.reason)) throw error
        throw new GitHubError(0, (error instanceof Error ? error.message : 'GitHub network request failed.').split(token.value).join('[redacted]'))
      }
      signal.throwIfAborted()
      const rejection = (status: number, message: string): GitHubError => {
        const now = Date.now(), retry = response.headers.get('retry-after'), reset = response.headers.get('x-ratelimit-reset')
        let retryTime = retry === null ? NaN : /^\d+(?:\.\d+)?$/.test(retry.trim()) ? now + Number(retry) * 1000 : Date.parse(retry)
        const headerReset = response.headers.get('x-ratelimit-remaining') === '0' && reset !== null ? Number(reset) * 1000 : NaN
        const resetTime = Number.isFinite(headerReset) ? headerReset : 0
        if ([403, 429].includes(status) && /\bsecondary rate limit\b/i.test(message)
          && !(retryTime > now) && !(resetTime > now)) {
          // GitHub prescribes at least one minute, then exponential increases.
          // Doubling is this client's engineering choice, not a quoted GitHub factor.
          // Only a new upstream response advances it; no automatic retry or cutoff.
          const delay = authorization.secondaryFailure === undefined ? 60_000 : authorization.secondaryFailure.delay * 2
          authorization.secondaryFailure = { request: requestKey, delay }
          retryTime = now + delay
        }
        const until = Math.max(Number.isFinite(retryTime) ? retryTime : 0, Number.isFinite(resetTime) ? resetTime : 0)
        const retryAt = [403, 429].includes(status) && until > now ? until : undefined
        const hint = token.source === 'GitHub CLI' && [401, 403, 404].includes(status) && retryAt === undefined ? GITHUB_CLI_ACCESS_REQUIRED + ' ' : ''
        const error = new GitHubError(status, hint + 'GitHub ' + status + ': ' + message + ' (' + method + ' ' + path + '; authorization: ' + token.source + ')', retryAt === undefined ? undefined : (retryAt - now) / 1000, retryAt, retryAt === undefined ? undefined : {})
        if (retryAt !== undefined) {
          // https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
          const retain = (key: string, deadline: number) => {
            if (Number.isFinite(deadline) && deadline > now && (authorization.limits.get(key)?.retryAt ?? 0) < deadline) {
              authorization.limits.set(key, new GitHubError(error.status, error.message, (deadline - now) / 1000, deadline, error.rateLimit))
            }
          }
          // A response may declare both limits; retain each actual deadline.
          retain('*', retryTime)
          retain(response.headers.get('x-ratelimit-resource') || resource, resetTime)
        }
        return error
      }
      if (!response.ok) {
        const data = await response.json().catch(error => {
          // Only invalid JSON falls back to the HTTP status. Body transport
          // failures retain their actual cause, even if the owner aborts later.
          if (error instanceof SyntaxError) return {}
          throw error
        }) as { message?: string }
        signal.throwIfAborted()
        const message = String(data.message ?? response.statusText).split(token.value).join('[redacted]')
        throw rejection(response.status, message)
      }
      const result = response.status === 204 ? undefined : await response.json()
      signal.throwIfAborted()
      // Only the previously failing request can reset its secondary backoff.
      if (authorization.secondaryFailure?.request === requestKey) authorization.secondaryFailure = undefined
      signal.throwIfAborted()
      return result as R
    }
    return operation({ authorizationScope: authorization.scope, request })
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
    return this.withRepo((session, path) => this.readInvitations(session, path), expected)
  }
  collaborators(expected?: MemberScope): Promise<CoopCollaborator[]> {
    return this.withRepo((session, path) => this.readCollaborators(session, path), expected)
  }
  /** One member refresh owns one credential resolution and repository inspection.
   * Each endpoint still follows its own pagination; nothing survives this call. */
  list(expected?: MemberScope): Promise<{ invitations: CoopInvitation[]; collaborators: CoopCollaborator[] }> {
    return this.withRepo(async (session, path) => {
      const [invitations, collaborators] = await Promise.all([this.readInvitations(session, path), this.readCollaborators(session, path)])
      return { invitations, collaborators }
    }, expected)
  }
  private async readInvitations(session: GitHubSession, path: string): Promise<CoopInvitation[]> {
    return (await this.pages<{ id: number; invitee: { login: string }; html_url?: string }>(session, path + '/invitations'))
      .map(item => ({ id: item.id, login: item.invitee.login, status: 'pending', htmlUrl: item.html_url }))
  }
  private async readCollaborators(session: GitHubSession, path: string): Promise<CoopCollaborator[]> {
    return (await this.pages<{ id: number; login: string; permissions: Record<string, boolean> }>(session, path + '/collaborators'))
      .map(item => ({ id: item.id, login: item.login, permissions: item.permissions, status: 'accepted' }))
  }
  invite(login: string, expected?: MemberScope): Promise<{ status: 'pending' | 'accepted'; id?: number; login: string }> {
    if (!/^[A-Za-z0-9-]+$/.test(login)) throw new Error('Enter a GitHub username.')
    return this.withRepo(async (session, path, connection) => {
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
