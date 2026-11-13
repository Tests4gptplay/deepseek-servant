import { PhysicalLocalFiles } from './physical-local-files.js'
import { GitAuthorityStore } from './git-authority.js'
import type { GitReadDependencies } from '../experimental/private-git/contracts.js'
import { createHash, randomUUID } from 'node:crypto'
import type { StoragePort } from '../contracts/ports.js'
import { FilesConflictError, FilesOutcomeUnknownError, GitFiles, type FilesSnapshot, type FileChange, withSnapshot, withReadOperation, withFileDependencies, withOperationChannel } from './transactions.js'

export const HEARTBEAT_INTERVAL_MS = 30_000
export const HEARTBEAT_OFFLINE_MS = 180_000
export interface InstanceConfig {
  /** Stable collaboration storage scope; Git includes repository id, branch and configured root. */
  repositoryId: string | number
  repositoryOwner: string
  /** Actual authenticated Git account identity; Local leaves this absent. */
  accountId?: string | number
  login: string
  instanceUUID: string
  workerSeats: number
}
export interface RegisteredInstance {
  member: string
  path: string
  instanceUUID: string
  workerSeats: number
  primary: boolean
}
export interface Heartbeat { sequence: number; updatedAt: string; status: 'running' | 'stopped' }
export interface ObservedInstance extends RegisteredInstance {
  heartbeat?: Heartbeat
  error?: string
  availability: 'unknown' | 'online' | 'offline' | 'stopped'
}
export interface OriginalInstanceRegistration { registration: Omit<RegisteredInstance, 'primary'>; heartbeat?: Heartbeat }
interface Prepared {
  id: string
  revision: string
  registration: RegisteredInstance
  heartbeat: Heartbeat
  previousPaths: string[]
}
interface Saved {
  /** Technical account binding, separate from heartbeat body. Git stores it in authority metadata. */
  accountId?: string
  member?: string
  sequence: number
  lastPublishedAt?: number
  pending?: Prepared
  /** Git atomic publication evidence; not an unconfirmed local write-ahead mirror. */
  lastPublication?: Prepared
}
export class InstanceAccountError extends Error {
  constructor(readonly code: 'account-changed' | 'account-unverified') {
    super(code === 'account-changed'
      ? 'account-changed: this Host instance registration belongs to a different Git account; preserve its alias, UUID and pending operations and reconnect with the original account.'
      : 'account-unverified: this existing Host instance has no saved Git account identity; preserve its records for explicit identity reconciliation rather than guessing from its alias.')
    this.name = 'InstanceAccountError'
  }
}
interface Observation { sequence: number; advancedAt: number; confirmed: boolean; status: Heartbeat['status'] }
interface HeartbeatObservation { version: string; heartbeat?: Heartbeat; error?: string }
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const uuidCreations = new WeakMap<StoragePort, Promise<string>>()
export function loadOrCreateInstanceUuid(storage: StoragePort): Promise<string> {
  const existing = uuidCreations.get(storage)
  if (existing) return existing
  const operation = (async () => {
    const key = 'framework-instance-uuid'
    const saved = await storage.get<string>(key)
    if (saved) {
      if (!uuidPattern.test(saved)) throw new Error('Stored instance UUID is invalid.')
      return saved
    }
    const id = randomUUID()
    await storage.set(key, id)
    return id
  })()
  uuidCreations.set(storage, operation)
  void operation.finally(() => { if (uuidCreations.get(storage) === operation) uuidCreations.delete(storage) }).catch(() => {})
  return operation
}
const validMember = (value: string) => value.length > 0 && !/[\\/\0\r\n]/.test(value) && value !== '.' && value !== '..'
export function parseInstancePath(path: string): Omit<RegisteredInstance, 'primary'> | undefined {
  const match = /^instances\/([^/]+)_Workers(\d+)_([0-9a-f-]+)\.json$/i.exec(path)
  if (!match || !validMember(match[1]!) || !uuidPattern.test(match[3]!)) return
  const workerSeats = Number(match[2])
  if (!Number.isSafeInteger(workerSeats) || workerSeats < 0) return
  return { member: match[1]!, workerSeats, instanceUUID: match[3]!, path }
}
function heartbeat(text: string): Heartbeat {
  const value = JSON.parse(text) as Heartbeat
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 0 || !Number.isFinite(Date.parse(value.updatedAt))
    || !['running', 'stopped'].includes(value.status)) throw new Error('Invalid instance heartbeat.')
  return value
}

/** Called from the existing Host loop. No timer, business-file scan or online admission gate. */
export class InstanceRegistration {
  private readonly key: string
  private stopped = false
  /** Current-flight retry aid only; restart authority is the Git publication. */
  private pendingPublication?: Saved
  /** Only the unresolved Git transport operation; never a permanent command history. */
  private pendingOperationId?: string
  private pendingOperationRelease?: () => void
  private setPendingOperation(id?: string): void {
    if (id === this.pendingOperationId) return
    const release = id !== undefined && this.files instanceof GitFiles ? this.files.retainOperation(id) : undefined
    this.pendingOperationRelease?.()
    this.pendingOperationId = id; this.pendingOperationRelease = release
  }
  private pendingReads?: GitReadDependencies
  private observations = new Map<string, Observation>()
  // Only parsed heartbeat observations, scoped to this registration. Immutable
  // file versions avoid rereading unchanged signals; elapsed time still advances.
  private heartbeatObservations = new Map<string, HeartbeatObservation>()
  private interrupted = false
  private tail: Promise<void> = Promise.resolve()
  private readonly heartbeatFlights = new Set<AbortController>()
  constructor(private readonly files: PhysicalLocalFiles | GitFiles, private readonly storage: StoragePort, private readonly config: InstanceConfig, private readonly now = Date.now,
    private originalInstances?: () => Promise<OriginalInstanceRegistration[]>) {
    if (!uuidPattern.test(config.instanceUUID) || !validMember(config.login)) throw new Error('Use the actual login and complete instance UUID.')
    if (!Number.isSafeInteger(config.workerSeats) || config.workerSeats < 0) throw new Error('Worker seats must be a nonnegative integer.')
    if (config.accountId !== undefined && (typeof config.accountId === 'number' ? !Number.isSafeInteger(config.accountId) || config.accountId <= 0 : !config.accountId.trim())) throw new Error('Use the actual Git account ID.')
    this.key = 'framework-instance/' + hash(config.repositoryId + ':' + config.instanceUUID)
  }
  private assertAccount(saved: Saved | undefined, remoteOwn = false, ownAliases: readonly string[] = []): void {
    if (this.config.accountId === undefined) return // Local identity semantics are unchanged.
    if (saved?.accountId !== undefined) {
      if (String(saved.accountId) !== String(this.config.accountId)) throw new InstanceAccountError('account-changed')
      const owner = this.config.repositoryOwner.toLowerCase()
      if (this.config.login.toLowerCase() !== owner
        && [saved.member, saved.pending?.registration.member, ...ownAliases].some(member => member?.toLowerCase() === owner)) {
        throw new Error('instance-owner-name-conflict: this authenticated invited instance already occupies the repository owner name; preserve its alias, UUID and pending operations for identity reconciliation.')
      }
    } else if (saved?.member || saved?.pending || (saved?.sequence ?? 0) > 0 || remoteOwn) {
      throw new InstanceAccountError('account-unverified')
    }
  }
  /** Read-only preflight for connection setup: must run BEFORE an empty Git
   * branch can be initialized. Known mismatches require no remote writes or
   * identity guesses; absent local binding may inspect only instance metadata. */
  async assertAccountIdentity(): Promise<void> {
    if (this.config.accountId === undefined) return
    const inspect = async (saved: Saved | undefined, snapshot?: FilesSnapshot) => {
      this.assertAccount(saved)
      if (saved?.accountId !== undefined) return
      const inspectNames = async (current: FilesSnapshot) => {
        const own = (await this.files.listDirectory(current, 'instances/'))
          .some(entry => parseInstancePath(entry.path)?.instanceUUID === this.config.instanceUUID)
        this.assertAccount(saved, own)
      }
      if (snapshot) await inspectNames(snapshot)
      else await withSnapshot(this.files, inspectNames)
    }
    if (this.storage instanceof GitAuthorityStore) {
      const records = this.storage
      await withSnapshot(this.files, async snapshot => inspect(await records.getAt<Saved>(snapshot, this.key), snapshot))
    } else await inspect(await this.storage.get<Saved>(this.key))
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(() => {}, () => {})
    return result
  }
  private registration(member: string): RegisteredInstance {
    const { instanceUUID, workerSeats, repositoryOwner, login } = this.config
    return { member, instanceUUID, workerSeats, path: `instances/${member}_Workers${workerSeats}_${instanceUUID}.json`,
      primary: login.toLowerCase() === repositoryOwner.toLowerCase() && member.toLowerCase() === login.toLowerCase() }
  }
  private async rows(snapshot: FilesSnapshot, signal?: AbortSignal): Promise<Array<{ registration: Omit<RegisteredInstance, 'primary'>; heartbeat?: Heartbeat; error?: string }>> {
    const rows = []
    const current = new Map<string, HeartbeatObservation>()
    const entries = await this.files.listDirectory(snapshot, 'instances/')
    await this.files.prefetch?.(snapshot, { signal, isolatePathErrors: true, files: entries.filter(entry => parseInstancePath(entry.path) && this.heartbeatObservations.get(entry.path)?.version !== entry.version).map(entry => entry.path) })
    for (const entry of entries) {
      const registration = parseInstancePath(entry.path)
      if (!registration) continue
      let observed = this.heartbeatObservations.get(entry.path)
      if (observed?.version !== entry.version) {
        const body = await this.files.read(snapshot, entry.path)
        if (body === undefined) continue
        try { observed = { version: entry.version, heartbeat: heartbeat(body) } }
        catch { observed = { version: entry.version, error: 'Invalid heartbeat record: ' + entry.path } }
      }
      current.set(entry.path, observed)
      rows.push({ registration, ...(observed.heartbeat ? { heartbeat: { ...observed.heartbeat } } : {}),
        ...(observed.error ? { error: observed.error } : {}) })
    }
    // A removed or renamed path must not retain an observation indefinitely.
    this.heartbeatObservations = current
    return rows
  }
  private async publishRunning(signal?: AbortSignal, reevaluateConflict = false): Promise<RegisteredInstance> {
    let result = await this.publish('running', signal, reevaluateConflict)
    if (result.status !== 'running' || result.registration.workerSeats !== this.config.workerSeats) {
      result = await this.publish('running', signal, reevaluateConflict)
    }
    signal?.throwIfAborted()
    return result.registration
  }

  register(signal?: AbortSignal): Promise<RegisteredInstance> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    this.stopped = false
    return this.serial(async () => {
      const registration = await this.publishRunning(signal, true)
      this.originalInstances = undefined
      return registration
    })
  }
  updateWorkerSeats(workerSeats: number): Promise<RegisteredInstance> {
    if (!Number.isSafeInteger(workerSeats) || workerSeats < 0) return Promise.reject(new Error('Worker seats must be a nonnegative integer.'))
    return this.serial(async () => {
      if (this.stopped) throw new Error('Instance registration is stopped.')
      this.config.workerSeats = workerSeats
      return this.publishRunning()
    })
  }
  /** Cancel accepted tick flights across repository I/O epochs. Pending publication
   * identities remain available to disconnect or a later explicit tick. */
  cancelPending(reason?: unknown): void {
    for (const flight of this.heartbeatFlights) flight.abort(reason)
  }
  tick(snapshot?: FilesSnapshot): Promise<RegisteredInstance | undefined> {
    const flight = new AbortController()
    this.heartbeatFlights.add(flight)
    const operation = this.serial(async () => {
      flight.signal.throwIfAborted()
      if (this.stopped) return
      return (await this.publish('running', flight.signal, true, { snapshot, onlyIfDue: true }))?.registration
    })
    void operation.finally(() => this.heartbeatFlights.delete(flight)).catch(() => {})
    return operation
  }
  async disconnect(signal?: AbortSignal): Promise<void> {
    // Stop local publication regardless of remote connectivity. Never wait for another Host.
    this.stopped = true
    this.cancelPending()
    await this.serial(async () => {
      try {
        const result = await this.publish('stopped', signal, 'once', { onlyIfRegistered: true })
        if (result?.resumed) await this.publish('stopped', signal, 'once')
      } catch (error) {
        // Cancellation can precede reconciliation of a previously dispatched
        // heartbeat. Keep that original UNKNOWN instead of reporting it unsent.
        if (signal?.aborted && error === signal.reason && this.files instanceof GitFiles && this.pendingOperationId) {
          const original = await this.files.operations.get(this.pendingOperationId)
          if (original && !this.files.canResumeUnsent(this.pendingOperationId)
            && original.resolution?.status !== 'confirmed' && original.resolution?.status !== 'conflict')
            throw new FilesOutcomeUnknownError(this.pendingOperationId, { cause: error })
        }
        // A proved rejection of this best-effort hint is not a failed business
        // operation. UNKNOWN and other failures retain their original outcome.
        if (!(error instanceof FilesConflictError)) throw error
      }
    })
  }
  private publish(status: Heartbeat['status'], signal?: AbortSignal, reevaluateConflict?: boolean | 'once'): Promise<{ registration: RegisteredInstance; status: Heartbeat['status']; resumed: boolean }>
  private publish(status: Heartbeat['status'], signal: AbortSignal | undefined, reevaluateConflict: boolean | 'once', request: { snapshot?: FilesSnapshot; onlyIfDue?: boolean; onlyIfRegistered?: boolean }): Promise<{ registration: RegisteredInstance; status: Heartbeat['status']; resumed: boolean } | undefined>
  private publish(status: Heartbeat['status'], signal?: AbortSignal, reevaluateConflict: boolean | 'once' = false,
    request: { snapshot?: FilesSnapshot; onlyIfDue?: boolean; onlyIfRegistered?: boolean } = {}): Promise<{ registration: RegisteredInstance; status: Heartbeat['status']; resumed: boolean } | undefined> {
    // Only the existing due tick uses the periodic writer. Registration, seat
    // changes and disconnect remain business writes, including reconciliation.
    return withOperationChannel(this.files, request.onlyIfDue ? 'host-poll-write' : 'write', () => this.publishInChannel(status, signal, reevaluateConflict, request))
  }
  private async publishInChannel(status: Heartbeat['status'], signal: AbortSignal | undefined, reevaluateConflict: boolean | 'once',
    request: { snapshot?: FilesSnapshot; onlyIfDue?: boolean; onlyIfRegistered?: boolean }): Promise<{ registration: RegisteredInstance; status: Heartbeat['status']; resumed: boolean } | undefined> {
    let borrowed = this.storage instanceof GitAuthorityStore ? request.snapshot : undefined
    let checkRequest = true
    let retrySnapshot: FilesSnapshot | undefined
    try {
      for (;;) {
        signal?.throwIfAborted()
        let saved: Saved = { sequence: 0 }
        let resumed = false
        let skipped = false
        let gitPublicationConfirmed = false
        // A canceled final hint may already have an exact Git confirmation.
        // Preserve that result while releasing its local operation references.
        const checkCompletionCancellation = () => { if (status !== 'stopped' || !gitPublicationConfirmed) signal?.throwIfAborted() }
        let publicationConflict: FilesConflictError | undefined
        const publishedBinding = (): Saved => {
          const prepared = saved.pending!
          return { ...(saved.accountId === undefined ? {} : { accountId: saved.accountId }), member: prepared.registration.member,
            sequence: prepared.heartbeat.sequence, lastPublishedAt: Date.parse(prepared.heartbeat.updatedAt), lastPublication: prepared }
        }
        const dispatchPrepared = async (snapshot?: FilesSnapshot) => {
          const prepared = saved.pending!
          signal?.throwIfAborted()
          if (this.files instanceof PhysicalLocalFiles) {
            // This Host's heartbeat is an ordinary physical file. On a seat
            // rename, publish its new name first, then remove only its known old
            // names. The existing saved pending payload resumes that exact work
            // after interruption; unrelated names/Tasks are not dependencies.
            const target = parseInstancePath(prepared.registration.path)
            if (!target || target.instanceUUID !== this.config.instanceUUID) throw new Error('Pending Local heartbeat belongs to another instance.')
            for (const path of prepared.previousPaths) {
              if (parseInstancePath(path)?.instanceUUID !== this.config.instanceUUID) throw new Error('Pending Local heartbeat cleanup belongs to another instance.')
            }
            await this.files.replace(prepared.registration.path, JSON.stringify(prepared.heartbeat) + '\n')
            for (const path of prepared.previousPaths) {
              signal?.throwIfAborted()
              if (path !== prepared.registration.path) await this.files.delete(path)
            }
            return
          }
          const files = this.files
          const changes: FileChange[] = prepared.previousPaths.map(path => ({ path, content: null }))
          changes.push({ path: prepared.registration.path, content: JSON.stringify(prepared.heartbeat) + '\n' })
          // The existing instance binding and heartbeat are the whole publication.
          // An independently replayable command receipt adds no authority here.
          if (this.storage instanceof GitAuthorityStore) changes.push(this.storage.change(this.key, publishedBinding()))
          const message = 'DSS heartbeat ' + prepared.id
          const commit = async (current: FilesSnapshot, operationId?: string) => {
            signal?.throwIfAborted()
            try {
              if (!operationId) this.pendingReads = files.captureReads(current)
              this.setPendingOperation(operationId ?? (await files.prepare(current, changes, message)).id)
              signal?.throwIfAborted()
              await files.commitPrepared(current, changes, message, this.pendingOperationId!, {
                // A final liveness hint is best effort, not a business command.
                // Return a rejected stop to the existing disconnect reconciliation
                // instead of keeping shutdown alive through unrelated reparenting.
                ...(status === 'stopped' ? { reevaluateOnConflict: true } : {}),
                beforeAttempt: () => { signal?.throwIfAborted(); if (status === 'running' && this.stopped) throw new Error('Instance registration is stopped.') },
                onAttempt: operation => { this.setPendingOperation(operation.id) },
              })
              gitPublicationConfirmed = this.storage instanceof GitAuthorityStore
            } catch (error) {
              if (error instanceof FilesConflictError) publicationConflict = error
              throw error
            }
          }
          // UNKNOWN remains attached to its original Git operation. Resolve it
          // before retrying; confirmed means this exact atomic publication succeeded.
          if (this.files instanceof GitFiles && this.pendingOperationId) {
            const resolution = await this.files.resolve(this.pendingOperationId)
            if (resolution.status === 'confirmed') {
              gitPublicationConfirmed = this.storage instanceof GitAuthorityStore
              checkCompletionCancellation()
              return
            }
            if (status === 'stopped' && resolution.status === 'unknown') throw new FilesOutcomeUnknownError(this.pendingOperationId)
            signal?.throwIfAborted()
            if (resolution.status === 'unknown') throw new FilesOutcomeUnknownError(this.pendingOperationId)
            // Disconnect withdraws a running publication that is proved rejected.
            // It still resolves UNKNOWN first and never discards a confirmed beat.
            if (resolution.status === 'conflict' && this.stopped && prepared.heartbeat.status === 'running')
              throw publicationConflict = new FilesConflictError(prepared.revision)
            const operation = await this.files.operations.get(this.pendingOperationId)
            if (!operation || !this.pendingReads) throw new Error('The pending heartbeat lost its original publication inputs.')
            const original = await this.files.at(operation.operation.expectedHead)
            try {
              this.files.restoreReads(original, this.pendingReads)
              await commit(original, operation.operation.id)
            } finally { await original.release() }
            return
          }
          if (snapshot) return commit(snapshot)
          await withSnapshot(this.files, current => commit(current))
        }
        try {
          const evaluateAt = async (snapshot?: FilesSnapshot) => {
            signal?.throwIfAborted()
            const current = this.storage instanceof GitAuthorityStore ? await this.storage.getAt<Saved>(snapshot!, this.key) : await this.storage.get<Saved>(this.key)
            signal?.throwIfAborted()
            this.assertAccount(current)
            saved = (this.storage instanceof GitAuthorityStore ? this.pendingPublication : undefined) ?? current ?? { sequence: 0 }
            this.assertAccount(saved)
            if (checkRequest && (request.onlyIfDue && !saved.pending && saved.lastPublishedAt !== undefined && this.now() - saved.lastPublishedAt < HEARTBEAT_INTERVAL_MS
              || request.onlyIfRegistered && !saved.member && !saved.pending)) {
              skipped = true
              return
            }
            checkRequest = false
            resumed = saved.pending !== undefined
            if (!saved.pending) {
              const prepare = async (snapshot: FilesSnapshot) => {
                signal?.throwIfAborted()
                // Name occupancy is path metadata. An unrelated damaged body must not
                // prevent this Host from saving its own valid registration.
                const entries = this.files.listDirectoryNames
                  ? (await this.files.listDirectoryNames(snapshot, 'instances/', { instanceRegistration: true })).map(path => ({ path, version: '' }))
                  : await this.files.listDirectory(snapshot, 'instances/', { instanceRegistration: true })
                const physicalRegistrations = entries
                  .map(entry => parseInstancePath(entry.path)).filter((entry): entry is Omit<RegisteredInstance, 'primary'> => entry !== undefined)
                const originals = this.files instanceof PhysicalLocalFiles && this.originalInstances ? await this.originalInstances() : []
                // Preserve original aliases/sequence only for initial acquisition.
                // A real physical registration supersedes its same UUID's old row.
                const registrations = [...physicalRegistrations, ...originals.filter(row => !physicalRegistrations.some(current => current.instanceUUID === row.registration.instanceUUID)).map(row => row.registration)]
                this.assertAccount(saved, registrations.some(row => row.instanceUUID === this.config.instanceUUID),
                  registrations.filter(row => row.instanceUUID === this.config.instanceUUID).map(row => row.member))
                const own = []
                const ownPaths = registrations.filter(row => row.instanceUUID === this.config.instanceUUID).map(row => row.path)
                const ownEntries = this.files instanceof PhysicalLocalFiles
                  ? (await Promise.all(ownPaths.map(this.files.fileMetadata.bind(this.files)))).filter(entry => entry !== undefined)
                  : await this.files.listDirectory(snapshot, 'instances/', { paths: ownPaths })
                for (const registration of registrations.filter(row => row.instanceUUID === this.config.instanceUUID)) {
                  const entry = ownEntries.find(entry => entry.path === registration.path)
                  if (!entry) {
                    const original = originals.find(row => row.registration.path === registration.path)
                    if (original?.heartbeat) own.push({ registration, heartbeat: original.heartbeat })
                    continue
                  }
                  const observed = this.heartbeatObservations.get(entry.path)
                  // Reuse only a validated body at this snapshot's exact immutable
                  // version. This does not confirm observation progress or availability.
                  if (observed?.version === entry.version && observed.heartbeat) {
                    own.push({ registration, heartbeat: observed.heartbeat })
                  } else {
                    const body = await this.files.read(snapshot, registration.path)
                    if (body !== undefined) own.push({ registration, heartbeat: heartbeat(body) })
                  }
                }
                const occupied = new Set(registrations.filter(row => row.instanceUUID !== this.config.instanceUUID).map(row => row.member.toLowerCase()))
                let member = saved.member ?? own[0]?.registration.member ?? originals.find(row => row.registration.instanceUUID === this.config.instanceUUID)?.registration.member
                if (member && occupied.has(member.toLowerCase())) throw new Error('The saved instance name belongs to another instance; inspect the registration.')
                if (!member) {
                  member = this.config.login
                  let suffix = 0
                  // Numbered aliases must not consume the real repository owner's exact
                  // login before its principal instance arrives. The owner's own login
                  // remains valid, and another owner instance still receives a suffix.
                  // Existing aliases are deliberately not renamed or adopted here:
                  // heartbeat metadata cannot authenticate an older alias's account.
                  const owner = this.config.repositoryOwner.toLowerCase()
                  const invited = this.config.login.toLowerCase() !== owner
                  while (occupied.has(member.toLowerCase()) || (invited && member.toLowerCase() === owner)) {
                    member = this.config.login + (++suffix)
                  }
                }
                const previous = Math.max(saved.sequence, ...own.map(row => row.heartbeat.sequence))
                if (previous >= Number.MAX_SAFE_INTEGER) throw new Error('Heartbeat sequence exceeds the supported JSON integer range.')
                const registration = this.registration(member)
                saved = { ...saved, ...(this.config.accountId === undefined ? {} : { accountId: String(this.config.accountId) }), sequence: previous + 1, pending: {
                  id: randomUUID(), revision: snapshot.revision, registration,
                  heartbeat: { sequence: previous + 1, updatedAt: new Date(this.now()).toISOString(), status },
                  previousPaths: own.filter(row => row.registration.path !== registration.path).map(row => row.registration.path),
                } }
                // Persist the reserved sequence and exact payload before dispatch. Failures never roll it back.
                signal?.throwIfAborted()
                if (this.storage instanceof GitAuthorityStore) this.pendingPublication = saved
                else await this.storage.set(this.key, saved)
                // Only the newly prepared responsibility borrows this live view. The
                // owner releases it exactly once, including cancellation and UNKNOWN.
                await dispatchPrepared(snapshot)
              }
              if (snapshot) await prepare(snapshot)
              else await withSnapshot(this.files, prepare)
            } else {
              if (this.config.accountId !== undefined && current?.accountId === undefined) {
                const inspectNames = async (currentSnapshot: FilesSnapshot) => {
                  const own = (await this.files.listDirectory(currentSnapshot, 'instances/'))
                    .some(entry => parseInstancePath(entry.path)?.instanceUUID === this.config.instanceUUID)
                  this.assertAccount(current, own)
                }
                if (snapshot) await inspectNames(snapshot)
                else await withSnapshot(this.files, inspectNames)
              }
              // Durable pending work keeps its original resolution/base path.
              await dispatchPrepared()
            }
          }
          const publishAt = async (snapshot?: FilesSnapshot) => {
            return snapshot ? withFileDependencies(this.files, snapshot, () => evaluateAt(snapshot)) : evaluateAt()
          }
          if (this.storage instanceof GitAuthorityStore) {
            if (borrowed) await publishAt(borrowed)
            else if (retrySnapshot) {
              const snapshot = retrySnapshot
              retrySnapshot = undefined
              try { await withReadOperation(this.files, () => publishAt(snapshot)) } finally { await snapshot.release() }
            } else await withSnapshot(this.files, publishAt)
          } else await publishAt()
          if (skipped) {
            signal?.throwIfAborted()
            return
          }
        } catch (error) {
          if (error === publicationConflict && publicationConflict !== undefined) {
            // Only a proven publication CAS conflict releases this rejected payload.
            if (this.files instanceof GitFiles && this.pendingOperationId) await this.files.operations.delete?.(this.pendingOperationId)
            this.setPendingOperation(undefined)
            this.pendingReads = undefined
            const { pending: _pending, ...rest } = saved
            // Git's rejected CAS published neither heartbeat nor pending metadata.
            // Never clear another Host's newly committed authority while retrying.
            if (this.storage instanceof GitAuthorityStore) this.pendingPublication = undefined
            else await this.storage.set(this.key, rest)
            if (reevaluateConflict) {
              signal?.throwIfAborted()
              let current: FilesSnapshot | undefined = (this.files instanceof GitFiles ? this.files.takeConflictSnapshot(publicationConflict) : undefined) ?? await this.files.snapshot()
              try {
                signal?.throwIfAborted()
                // Continue this registration only on actual changed authority. Same-H
                // errors, UNKNOWN, permission and readback failures are not retries.
                if (current.revision !== publicationConflict.expectedRevision) {
                  // Reevaluate at this already acquired authoritative Git view instead
                  // of fetching it only to discard it and immediately fetch again.
                  if (this.storage instanceof GitAuthorityStore) { retrySnapshot = current; current = undefined }
                  // Disconnect still permits only one fresh-head attempt.
                  if (reevaluateConflict === 'once') reevaluateConflict = false
                  borrowed = undefined
                  continue
                }
              } finally { await current?.release() }
            }
          }
          // The original Git publication may have completed before the owning
          // read scope observes this exact close cancellation on its way out.
          if (!(status === 'stopped' && gitPublicationConfirmed && signal?.aborted && error === signal.reason)) throw error
        }
        const prepared = saved.pending!
        checkCompletionCancellation()
        // Git confirmed the binding and heartbeat together. This ends only this
        // publication, not a claim about the latest remote state or peer liveness.
        // Keep existing observation versions until a later real snapshot sees them.
        // Physical Local has finished its addressed writes; clear only its
        // existing technical pending payload below.
        if (!(this.storage instanceof GitAuthorityStore)) await this.storage.set(this.key, { ...(saved.accountId === undefined ? {} : { accountId: saved.accountId }), member: prepared.registration.member, sequence: saved.sequence, lastPublishedAt: this.now() } satisfies Saved)
        checkCompletionCancellation()
        if (this.files instanceof GitFiles && this.pendingOperationId) await this.files.operations.delete?.(this.pendingOperationId)
        this.setPendingOperation(undefined)
        this.pendingReads = undefined
        this.pendingPublication = undefined
        return { registration: prepared.registration, status: prepared.heartbeat.status, resumed }
      }
    } finally { await retrySnapshot?.release() }
  }
  /** Losing observation continuity discards time-based claims, not remote records. */
  observationInterrupted(): void { this.interrupted = true }
  async observe(borrowed?: FilesSnapshot, signal?: AbortSignal): Promise<ObservedInstance[]> {
    try {
      const inspect = async (snapshot: FilesSnapshot) => {
        const rows = await this.rows(snapshot, signal), now = this.now()
        if (this.interrupted) {
          // Reset elapsed continuity, not the highest sequence already established.
          for (const [id, observed] of this.observations) this.observations.set(id, { ...observed, advancedAt: now, confirmed: false })
        }
        this.interrupted = false
        const output: ObservedInstance[] = []
        for (const row of rows) {
          const primary = row.registration.member.toLowerCase() === this.config.repositoryOwner.toLowerCase()
          if (!row.heartbeat) {
            output.push({ ...row.registration, primary, availability: 'unknown', error: row.error })
            continue
          }
          const id = row.registration.instanceUUID, prior = this.observations.get(id), current = row.heartbeat
          let observed = prior
          if (!prior) observed = { sequence: current.sequence, advancedAt: now, confirmed: false, status: current.status }
          else if (current.sequence > prior.sequence) observed = { sequence: current.sequence, advancedAt: now, confirmed: true, status: current.status }
          this.observations.set(id, observed!)
          const availability = observed!.status === 'stopped' ? 'stopped'
            : now - observed!.advancedAt >= HEARTBEAT_OFFLINE_MS ? 'offline' : observed!.confirmed ? 'online' : 'unknown'
          output.push({ ...row.registration, primary: row.registration.member.toLowerCase() === this.config.repositoryOwner.toLowerCase(),
            heartbeat: current, availability })
        }
        return output
      }
      return await (borrowed ? inspect(borrowed) : withSnapshot(this.files, inspect))
    } catch (error) { this.interrupted = true; throw error }
  }
}
