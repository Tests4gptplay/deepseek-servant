import { LocalLocationRegistry, canonicalLocalLocation } from './local-location.js'
import { createHash } from 'node:crypto'
import type { StoragePort } from '../contracts/ports.js'
import { RepositoryDirectorySchema, type RepoBinding, type RepoConnection, type CoopInvitation, type CoopCollaborator } from '../experimental/private-git/contracts.js'
import { CoopCredentials } from '../experimental/private-git/credentials.js'
import { GitHubClient, GitHubMembers, type GitHubFetch } from '../experimental/private-git/github.js'
import { GitHubRepository } from '../experimental/private-git/git-repository.js'
import { FrameworkTransactions } from './command-transactions.js'
import { InstanceRegistration, loadOrCreateInstanceUuid, type ObservedInstance, type RegisteredInstance } from './instances.js'
import { LocalFiles } from './local-files.js'
import { GitFiles, type FilesStore, type FilesSnapshot, type GitOperationRecord, type GitOperationStore } from './transactions.js'

export type FrameworkConnectionSettings =
  | { mode: 'local'; directory: string; login?: string; workerSeats: number }
  | { mode: 'git'; ownerRepo: string; repositoryDirectory: string; workerSeats: number }
export interface FrameworkConnectionDependencies {
  storage: StoragePort
  credentials?: Pick<CoopCredentials, 'resolve'>
  fetch?: GitHubFetch
  now?: () => number
  /** Cancellation owned by this acquisition, not another mode or storage handle. */
  signal?: AbortSignal
}
export interface FrameworkStorage {
  readonly files: FilesStore
  readonly transactions: FrameworkTransactions
  readonly scope: string
  readonly repository?: RepoConnection
  /** Authenticated Git identity, or explicitly local technical identity. Not registration. */
  readonly identity: { login: string; owner: string; instanceUUID: string; repositoryId: string | number }
  /** Explicit write setup only. Reads of an empty Git repository never create a branch.
   * Obtain a fresh snapshot after this call; an empty pre-setup revision is stale. */
  prepareWrite(): Promise<void>
  gitMembers?(): Promise<{ invitations: CoopInvitation[]; collaborators: CoopCollaborator[] }>
  gitMemberAction?(action: { action: 'cancelInvitation'; invitationId: number } | { action: 'remove'; username: string }): Promise<void>
  invite?(username: string): Promise<{ status: 'pending' | 'accepted'; id?: number; login: string }>
  /** Releases resources only: does not publish instance registration or status. */
  cancelPending(reason?: unknown): void
  close(): Promise<void>
}
export interface FrameworkConnection {
  readonly files: FilesStore
  readonly transactions: FrameworkTransactions
  readonly registration: RegisteredInstance
  readonly scope: string
  readonly repository?: RepoConnection
  /** Full registered roster, including unknown/offline/stopped instances. */
  updateWorkerSeats(workerSeats: number): Promise<RegisteredInstance>
  members(snapshot?: FilesSnapshot): Promise<ObservedInstance[]>
  /** Called by the existing Host loop; owns no independent timer. */
  tick(): Promise<void>
  observationInterrupted(): void
  cancelPending(reason?: unknown): void
  close(): Promise<void>
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
function operations(storage: StoragePort, scope: string): GitOperationStore {
  const prefix = 'framework-git-operations/' + digest(scope) + '/'
  return {
    save: record => storage.set(prefix + record.operation.id, record),
    get: id => storage.get<GitOperationRecord>(prefix + id),
    list: async () => (await storage.list<GitOperationRecord>(prefix)).map(row => row.value),
  }
}

/** Authorized storage access is separate from background participation. Opening,
 * reading and releasing this handle never writes instance/heartbeat records.
 * Auth remains the existing credential source and repository permission checks.
 */
export async function openFrameworkStorage(input: FrameworkConnectionSettings,
  dependencies: FrameworkConnectionDependencies): Promise<FrameworkStorage> {
  const { storage } = dependencies
  dependencies.signal?.throwIfAborted()
  const settings: FrameworkConnectionSettings = input.mode === 'git'
    ? { ...input, repositoryDirectory: RepositoryDirectorySchema.parse(input.repositoryDirectory) } : { ...input }
  if (!Number.isSafeInteger(settings.workerSeats) || settings.workerSeats < 0) throw new Error('Worker seats must be a nonnegative integer.')
  const instanceUUID = await loadOrCreateInstanceUuid(storage)
  dependencies.signal?.throwIfAborted()
  let invite: FrameworkStorage['invite'], gitMembers: FrameworkStorage['gitMembers'], gitMemberAction: FrameworkStorage['gitMemberAction']
  let release: (() => Promise<void>) | undefined
  let cancelPending = (_reason?: unknown) => {}
  try {
    let files: FilesStore, scope: string, login: string, owner: string, repositoryId: string | number
    let repository: RepoConnection | undefined
    let initializeWrite: (() => Promise<void>) | undefined
    if (settings.mode === 'local') {
      if (!settings.directory.trim()) throw new Error('Choose the local DSS storage directory.')
      const locations = new LocalLocationRegistry(storage)
      const canonical = await canonicalLocalLocation(settings.directory, true)
      // A moved-away location must not recreate a new empty database and attach
      // the original runtime receipts. Only explicit verified moves bind aliases.
      await locations.resolve(canonical)
      dependencies.signal?.throwIfAborted()
      const local = await LocalFiles.open(settings.directory)
      release = () => local.close()
      files = local
      scope = await locations.resolve(local.directory)
      repositoryId = scope
      // A display label need not be a path segment. Preserve it in settings, but
      // use the stable technical UUID identity when it is not a usable alias.
      // Neither identity is evidence of a Git account or an authentication check.
      const label = settings.login
      login = owner = label && !/[\\/\0\r\n]/.test(label) && label !== '.' && label !== '..'
        ? label : 'local-' + instanceUUID
    } else {
      const credentials = dependencies.credentials ?? new CoopCredentials()
      const client = new GitHubClient(signal => credentials.resolve(signal), dependencies.fetch, { signal: dependencies.signal })
      let binding: RepoBinding = { ownerRepo: settings.ownerRepo, repositoryDirectory: settings.repositoryDirectory }
      const remote = new GitHubRepository(client, () => binding)
      release = () => remote.releaseCache()
      cancelPending = reason => remote.cancel(reason)
      repository = await remote.connect()
      dependencies.signal?.throwIfAborted()
      binding = { ...binding, ownerRepo: repository.repository.fullName, repositoryId: repository.repository.id,
        participantId: repository.identity.id, branch: repository.repository.branch }
      scope = JSON.stringify(['git', repository.repository.id, repository.repository.branch, settings.repositoryDirectory])
      // A prepared publication belongs to one branch/root. It must never be
      // replayed into another working root of the same GitHub repository.
      const members = new GitHubMembers(client, () => binding)
      const expected = { expectedRepositoryId: repository.repository.id, expectedParticipantId: repository.identity.id }
      invite = username => members.invite(username, expected)
      gitMembers = async () => { const [invitations, collaborators] = await Promise.all([members.invitations(expected), members.collaborators(expected)]); return { invitations, collaborators } }
      gitMemberAction = action => action.action === 'cancelInvitation' ? members.cancelInvitation(action.invitationId, expected) : members.remove(action.username, expected)
      repositoryId = scope
      login = repository.identity.login
      owner = repository.repository.fullName.split('/')[0]!
      // Deferred until an explicit write. A read-only empty snapshot remains empty.
      initializeWrite = async () => { await remote.ensureBranch() }
      files = new GitFiles(remote, operations(storage, scope))
    }
    dependencies.signal?.throwIfAborted()
    // This records requested nonsecret settings, not an assertion of successful connection.
    await storage.set('framework-connection-settings/' + digest(scope), settings)
    dependencies.signal?.throwIfAborted()
    const transactions = new FrameworkTransactions(files, storage, scope)
    let closed = false, closing: Promise<void> | undefined, preparing: Promise<void> | undefined
    const assertOpen = () => { if (closed) throw new Error('Framework storage is closed.') }
    return {
      files, transactions, scope, repository, invite, gitMembers, gitMemberAction, cancelPending, identity: { login, owner, instanceUUID, repositoryId },
      prepareWrite: async () => {
        assertOpen()
        if (!preparing) {
          preparing = (async () => { await initializeWrite?.(); assertOpen() })()
          void preparing.catch(() => { preparing = undefined })
        }
        await preparing
      },
      close: () => {
        if (!closing) { closed = true; closing = release!() }
        return closing
      },
    }
  } catch (error) {
    await release?.()
    throw error
  }
}

/** Explicit background participation. Success means registration and heartbeat
 * were actually read back. Frontend storage access must not call this function. */
export async function openFrameworkConnection(settings: FrameworkConnectionSettings,
  dependencies: FrameworkConnectionDependencies): Promise<FrameworkConnection> {
  const access = await openFrameworkStorage(settings, dependencies)
  try {
    dependencies.signal?.throwIfAborted()
    const { files, transactions, scope, repository, identity } = access
    const instances = new InstanceRegistration(files, transactions, dependencies.storage,
      { ...(repository ? { accountId: repository.identity.id } : {}), repositoryId: identity.repositoryId, repositoryOwner: identity.owner, login: identity.login,
        instanceUUID: identity.instanceUUID, workerSeats: settings.workerSeats }, dependencies.now)
    await instances.assertAccountIdentity()
    dependencies.signal?.throwIfAborted()
    await access.prepareWrite()
    dependencies.signal?.throwIfAborted()
    const principal = (value: RegisteredInstance): RegisteredInstance => settings.mode === 'local' ? { ...value, primary: true } : value
    let registration = principal(await instances.register(dependencies.signal))
    dependencies.signal?.throwIfAborted()
    let closed = false, closing: Promise<void> | undefined
    const assertOpen = () => { if (closed) throw new Error('Framework connection is closed.') }
    return {
      files, transactions, cancelPending: reason => access.cancelPending(reason), get registration() { return registration }, scope, repository,
      updateWorkerSeats: async workerSeats => { assertOpen(); registration = principal(await instances.updateWorkerSeats(workerSeats)); return registration },
      members: async snapshot => { assertOpen(); const rows = await instances.observe(snapshot); return settings.mode === 'local'
        ? rows.map(row => ({ ...row, primary: row.instanceUUID === identity.instanceUUID })) : rows },
      tick: async () => {
        assertOpen()
        try { const published = await instances.tick(); if (published) registration = principal(published) } catch (error) { instances.observationInterrupted(); throw error }
      },
      observationInterrupted: () => instances.observationInterrupted(),
      close: () => {
        if (!closing) {
          closed = true
          closing = (async () => { try { await instances.disconnect() } finally { await access.close() } })()
        }
        return closing
      },
    }
  } catch (error) {
    // Preserve failed/unknown registration receipts; releasing storage is not a
    // second registration attempt or an assertion of successful disconnect.
    await access.close()
    throw error
  }
}
