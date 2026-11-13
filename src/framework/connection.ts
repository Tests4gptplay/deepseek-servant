import { GitAuthorityStore, SessionGitOperations } from './git-authority.js'
import { LocalLocationRegistry, canonicalLocalLocation } from './local-location.js'
import { createHash } from 'node:crypto'
import type { StoragePort } from '../contracts/ports.js'
import { RepositoryDirectorySchema, type RepoBinding, type RepoConnection, type CoopInvitation, type CoopCollaborator } from '../experimental/private-git/contracts.js'
import { CoopCredentials } from '../experimental/private-git/credentials.js'
import { GitHubClient, GitHubMembers, type GitHubFetch, type TokenSource } from '../experimental/private-git/github.js'
import { RemoteGitRepository, type RemoteGitOptions } from '../experimental/private-git/remote-git-repository.js'
import { FrameworkTransactions } from './command-transactions.js'
import { InstanceRegistration, loadOrCreateInstanceUuid, type ObservedInstance, type RegisteredInstance } from './instances.js'
import { PhysicalLocalFiles } from './physical-local-files.js'
import { GitFiles, withWriteOperation, type FilesSnapshot, type FrameworkGitRepository } from './transactions.js'
import type { RoleGuideInitialization } from './role-guides.js'
import { FrameworkInitialization } from './initialization-repair.js'
import { readOriginalLocalInstances } from './local-upgrade-instance.js'
import { identifyLocalPhysicalBackend } from './local-backend-acquisition.js'

export type FrameworkConnectionSettings =
  | { mode: 'local'; directory: string; login?: string; workerSeats: number }
  | { mode: 'git'; ownerRepo: string; repositoryDirectory: string; workerSeats: number }
export interface FrameworkConnectionDependencies {
  storage: StoragePort
  /** Host activation owns this callback; ordinary storage readers never call it.
   * It starts the existing one-time AI without waiting for its conversion. */
  onStorageOpened?(storage: FrameworkStorage): void
  onInstanceRegistered?(storage: FrameworkStorage, registration: RegisteredInstance): void
  onOriginalInstanceIssue?(error: Error): void
  /** Preserve an exact old guide/catalog while its one-time source is owned. */
  pendingInitializationOriginal?(path: string): Promise<boolean>
  /** Explicit storage injection for controlled tests; ordinary Local uses its
   * physical backend and the owning Host starts the one-time source upgrade. */
  localFilesFactory?: (directory: string, options: { requireExisting: boolean }) => Promise<PhysicalLocalFiles>
  gitRuntime?: Pick<RemoteGitOptions, 'dulwich'>
  credentials?: Pick<CoopCredentials, 'resolve'>
  fetch?: GitHubFetch
  /** Explicit transport injection for isolated tests. Production has no automatic
   * API fallback: everyday content reads/writes use the native Git protocol. */
  repositoryFactory?: (binding: () => RepoBinding, tokens: TokenSource,
    options: { fetcher?: GitHubFetch; signal?: AbortSignal }) => FrameworkGitRepository
  now?: () => number
  /** Cancellation owned by this acquisition, not another mode or storage handle. */
  signal?: AbortSignal
}
export interface FrameworkStorage {
  readonly files: PhysicalLocalFiles | GitFiles
  readonly records: StoragePort
  readonly sharedRecords: StoragePort
  readonly transactions: FrameworkTransactions
  readonly scope: string
  readonly repository?: RepoConnection
  /** Authenticated Git identity, or explicitly local technical identity. Not registration. */
  readonly identity: { login: string; owner: string; instanceUUID: string; repositoryId: string | number }
  /** Read-only preparation may verify an existing branch. Only an explicit write
   * (the default) may initialize an empty Git repository.
   * Obtain a fresh snapshot after this call; an empty pre-setup revision is stale. */
  prepareWrite(options?: { initialize?: boolean }): Promise<void>
  gitMembers?(): Promise<{ invitations: CoopInvitation[]; collaborators: CoopCollaborator[] }>
  gitMemberAction?(action: { action: 'cancelInvitation'; invitationId: number } | { action: 'remove'; username: string }): Promise<void>
  invite?(username: string): Promise<{ status: 'pending' | 'accepted'; id?: number; login: string }>
  /** Releases resources only: does not publish instance registration or status. */
  cancelPending(reason?: unknown): void
  close(): Promise<void>
}
export interface FrameworkConnection {
  readonly identity: FrameworkStorage['identity']
  /** Nonblocking initialization diagnostic, not a role admission or version gate. */
  readonly roleGuideInitializationError?: unknown
  /** Exact-rule migration report. Preserved custom text is never an admission gate. */
  readonly roleGuideInitialization?: RoleGuideInitialization
  readonly initialization: FrameworkInitialization
  readonly files: PhysicalLocalFiles | GitFiles
  readonly records: StoragePort
  readonly sharedRecords: StoragePort
  readonly transactions: FrameworkTransactions
  readonly registration: RegisteredInstance
  readonly scope: string
  readonly repository?: RepoConnection
  /** Full registered roster, including unknown/offline/stopped instances. */
  updateWorkerSeats(workerSeats: number): Promise<RegisteredInstance>
  members(snapshot?: FilesSnapshot): Promise<ObservedInstance[]>
  /** Called by the existing Host loop; owns no independent timer. */
  tick(snapshot?: FilesSnapshot): Promise<void>
  observationInterrupted(): void
  cancelPending(reason?: unknown): void
  close(signal?: AbortSignal): Promise<void>
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

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
  let release: ((commands?: Promise<void>) => Promise<void>) | undefined
  let cancelPending = (_reason?: unknown) => {}
  try {
    let records = storage, sharedRecords = storage
    let files: PhysicalLocalFiles | GitFiles, scope: string, login: string, owner: string, repositoryId: string | number
    let repository: RepoConnection | undefined
    let localBackend: 'physical' | undefined
    let initializeWrite: (() => Promise<void>) | undefined
    let inspectWrite: (() => Promise<boolean>) | undefined
    if (settings.mode === 'local') {
      if (!settings.directory.trim()) throw new Error('Choose the local DSS storage directory.')
      const locations = new LocalLocationRegistry(storage)
      const canonical = await canonicalLocalLocation(settings.directory, true)
      // A moved-away location must not recreate a new empty database and attach
      // the original runtime receipts. Only explicit verified moves bind aliases.
      const savedScope = await locations.resolve(canonical)
      const previous = await storage.get<FrameworkConnectionSettings & { localBackend?: 'physical' }>('framework-connection-settings/' + digest(savedScope))
      dependencies.signal?.throwIfAborted()
      const identified = dependencies.localFilesFactory ? false
        : await identifyLocalPhysicalBackend(canonical, storage, previous, dependencies.signal)
      const local = await (dependencies.localFilesFactory ?? PhysicalLocalFiles.open)(settings.directory, { requireExisting: previous !== undefined })
      release = () => local.close()
      files = local
      if (local instanceof PhysicalLocalFiles && identified) localBackend = 'physical'
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
      const tokens: TokenSource = signal => credentials.resolve(signal)
      const client = new GitHubClient(tokens, dependencies.fetch, { signal: dependencies.signal })
      let binding: RepoBinding = { ownerRepo: settings.ownerRepo, branch: 'main', repositoryDirectory: settings.repositoryDirectory }
      const remote = (dependencies.repositoryFactory ?? ((binding, tokens, options) => new RemoteGitRepository(binding, tokens, { ...options, ...dependencies.gitRuntime })))(
        () => binding, tokens, { fetcher: dependencies.fetch, signal: dependencies.signal })
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
      gitMembers = () => members.list(expected)
      gitMemberAction = action => action.action === 'cancelInvitation' ? members.cancelInvitation(action.invitationId, expected) : members.remove(action.username, expected)
      repositoryId = scope
      login = repository.identity.login
      owner = repository.repository.fullName.split('/')[0]!
      // Deferred until an explicit write. A read-only empty snapshot remains empty.
      initializeWrite = () => withWriteOperation(files, async () => {
        const snapshot = await remote.ensureBranch()
        remote.releaseSnapshot?.(snapshot)
      })
      inspectWrite = async () => {
        const snapshot = await remote.snapshot()
        try { return !!snapshot.head } finally { remote.releaseSnapshot?.(snapshot) }
      }
      const operations = new SessionGitOperations()
      files = new GitFiles(remote, operations)
      const authority = new GitAuthorityStore(files, JSON.stringify(['instance', repository.identity.id, instanceUUID]))
      const shared = new GitAuthorityStore(files, 'shared')
      records = authority; sharedRecords = shared
      release = async (commands) => {
        try {
          // Seal each owner immediately, but retain operation facts until every
          // accepted command and authority write has finished using them.
          const results = await Promise.allSettled([commands, authority.close(), shared.close()])
          const errors = results.filter((item): item is PromiseRejectedResult => item.status === 'rejected').map(item => item.reason)
          if (errors.length === 1) throw errors[0]
          if (errors.length) throw new AggregateError(errors, 'Git connection close failed.')
        } finally { operations.close(); await remote.releaseCache() }
      }
    }
    dependencies.signal?.throwIfAborted()
    // The backend fact is saved only after acquiring the identified root. An
    // unfinished old-source conversion stays unmarked and keeps its own AI
    // responsibility; neither settings nor this fact declare conversion done.
    await storage.set('framework-connection-settings/' + digest(scope), { ...settings, ...(localBackend ? { localBackend } : {}) })
    dependencies.signal?.throwIfAborted()
    const transactions = new FrameworkTransactions(files, records)
    let closed = false, closing: Promise<void> | undefined, prepared = false
    const assertOpen = () => { if (closed) throw new Error('Framework storage is closed.') }
    return {
      files, transactions, records, sharedRecords, scope, repository, invite, gitMembers, gitMemberAction, cancelPending, identity: { login, owner, instanceUUID, repositoryId },
      prepareWrite: async (options) => {
        assertOpen()
        if (prepared) return
        // Reuse completed preparation only. An in-flight read-only warmup or
        // another channel's preparation must not hold this caller's operation.
        const available = options?.initialize !== false ? (await initializeWrite?.(), true) : await inspectWrite?.() ?? true
        assertOpen()
        // A late empty read-only observation cannot undo a completed write setup.
        prepared ||= available
      },
      close: () => {
        if (!closing) {
          closed = true
          if (settings.mode === 'local') closing = release!()
          else {
            const reason = new DOMException('Git connection is closing its owned operations.', 'AbortError')
            const commands = transactions.closeGitSession(reason)
            cancelPending(reason)
            closing = release!(commands)
          }
        }
        return closing
      },
    }
  } catch (error) {
    await release?.()
    throw error
  }
}

/** Explicit background participation. Git confirms registration and heartbeat
 * atomically; Physical Local writes its addressed heartbeat. Frontend access must not call this. */
export async function openFrameworkConnection(settings: FrameworkConnectionSettings,
  dependencies: FrameworkConnectionDependencies): Promise<FrameworkConnection> {
  const access = await openFrameworkStorage(settings, dependencies)
  try {
    dependencies.signal?.throwIfAborted()
    const { files, transactions, scope, repository, identity } = access
    dependencies.onStorageOpened?.(access)
    const instances = new InstanceRegistration(files, access.records,
      { ...(repository ? { accountId: repository.identity.id } : {}), repositoryId: identity.repositoryId, repositoryOwner: identity.owner, login: identity.login,
        instanceUUID: identity.instanceUUID, workerSeats: settings.workerSeats }, dependencies.now,
      files instanceof PhysicalLocalFiles ? () => readOriginalLocalInstances(files.directory, dependencies.storage, identity.instanceUUID, dependencies.signal, dependencies.onOriginalInstanceIssue) : undefined)
    await instances.assertAccountIdentity()
    dependencies.signal?.throwIfAborted()
    await access.prepareWrite()
    dependencies.signal?.throwIfAborted()
    const principal = (value: RegisteredInstance): RegisteredInstance => settings.mode === 'local' ? { ...value, primary: true } : value
    let registration = principal(await instances.register(dependencies.signal))
    dependencies.onInstanceRegistered?.(access, registration)
    dependencies.signal?.throwIfAborted()
    const initialization = new FrameworkInitialization(files, transactions,
      files instanceof PhysicalLocalFiles ? dependencies.pendingInitializationOriginal : undefined, dependencies.signal)
    let roleGuideInitializationError: unknown
    let roleGuideInitialization: RoleGuideInitialization | undefined
    try {
      roleGuideInitialization = await initialization.initializeGuide()
    }
    catch (error) {
      dependencies.signal?.throwIfAborted()
      // A missing reference must not stop independent roles or turn a read-only
      // access into an initializer. Existing role tools report actual read gaps.
      roleGuideInitializationError = error
    }
    let closed = false, closing: Promise<void> | undefined, closeSettled = false
    let disconnectCancellation: AbortController | undefined
    const cancelPending = (reason?: unknown) => {
      // Runtime cancellation before close is not a permanent ban on its final
      // stopped hint. Once close owns that hint, cancellation also seals it.
      disconnectCancellation?.abort(reason)
      const cancellation = disconnectCancellation?.signal.reason ?? reason
      instances.cancelPending(cancellation)
      access.cancelPending(cancellation)
    }
    const assertOpen = () => { if (closed) throw new Error('Framework connection is closed.') }
    return {
      ...(roleGuideInitializationError === undefined ? {} : { roleGuideInitializationError }),
      ...(roleGuideInitialization === undefined ? {} : { roleGuideInitialization }),
      identity, files, transactions, initialization, records: access.records, sharedRecords: access.sharedRecords,
      cancelPending, get registration() { return registration }, scope, repository,
      updateWorkerSeats: async workerSeats => { assertOpen(); registration = principal(await instances.updateWorkerSeats(workerSeats)); return registration },
      members: async snapshot => { assertOpen(); const rows = await instances.observe(snapshot); return settings.mode === 'local'
        ? rows.map(row => ({ ...row, primary: row.instanceUUID === identity.instanceUUID })) : rows },
      tick: async snapshot => {
        assertOpen()
        try { const published = await instances.tick(snapshot); if (published) registration = principal(published) } catch (error) { instances.observationInterrupted(); throw error }
      },
      observationInterrupted: () => instances.observationInterrupted(),
      close: signal => {
        if (settings.mode !== 'git') signal = undefined
        if (closeSettled) return closing!
        disconnectCancellation ??= new AbortController()
        const abort = () => cancelPending(signal!.reason)
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
        if (!closing) {
          closed = true
          closing = (async () => {
            try { await instances.disconnect(settings.mode === 'git' ? disconnectCancellation!.signal : undefined) }
            finally { try { await access.close() } finally { closeSettled = true } }
          })()
        }
        void closing.finally(() => signal?.removeEventListener('abort', abort)).catch(() => {})
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
