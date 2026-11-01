import { createHash, randomUUID } from 'node:crypto'
import type { StoragePort } from '../contracts/ports.js'
import type { FrameworkTransactions } from './command-transactions.js'
import { FilesConflictError, type FilesStore, type FilesSnapshot, type FileChange, withSnapshot } from './transactions.js'

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
interface Prepared {
  id: string
  revision: string
  registration: RegisteredInstance
  heartbeat: Heartbeat
  previousPaths: string[]
}
interface Saved {
  /** Local technical binding only, never part of remote heartbeat bodies. */
  accountId?: string
  member?: string
  sequence: number
  lastPublishedAt?: number
  pending?: Prepared
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
  private observations = new Map<string, Observation>()
  // Only parsed heartbeat observations, scoped to this registration. Immutable
  // file versions avoid rereading unchanged signals; elapsed time still advances.
  private heartbeatObservations = new Map<string, HeartbeatObservation>()
  private interrupted = false
  private tail: Promise<void> = Promise.resolve()
  constructor(private readonly files: FilesStore, private readonly transactions: FrameworkTransactions,
    private readonly storage: StoragePort, private readonly config: InstanceConfig, private readonly now = Date.now) {
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
    const saved = await this.storage.get<Saved>(this.key)
    this.assertAccount(saved)
    if (saved?.accountId !== undefined) return
    await withSnapshot(this.files, async snapshot => {
      const own = (await this.files.listDirectory(snapshot, 'instances/'))
        .some(entry => parseInstancePath(entry.path)?.instanceUUID === this.config.instanceUUID)
      this.assertAccount(saved, own)
    })
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
  private async rows(snapshot: FilesSnapshot): Promise<Array<{ registration: Omit<RegisteredInstance, 'primary'>; heartbeat?: Heartbeat; error?: string }>> {
    const rows = []
    const current = new Map<string, HeartbeatObservation>()
    for (const entry of await this.files.listDirectory(snapshot, 'instances/')) {
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
  private async publishRunning(): Promise<RegisteredInstance> {
    await this.assertAccountIdentity()
    const prior = await this.storage.get<Saved>(this.key)
    const result = await this.publish('running')
    // Resolve the original uncertain publication before applying a new seat count.
    if (prior?.pending && (prior.pending.heartbeat.status !== 'running'
      || result.workerSeats !== this.config.workerSeats)) return this.publish('running')
    return result
  }
  register(): Promise<RegisteredInstance> {
    this.stopped = false
    return this.serial(() => this.publishRunning())
  }
  updateWorkerSeats(workerSeats: number): Promise<RegisteredInstance> {
    if (!Number.isSafeInteger(workerSeats) || workerSeats < 0) return Promise.reject(new Error('Worker seats must be a nonnegative integer.'))
    return this.serial(async () => {
      if (this.stopped) throw new Error('Instance registration is stopped.')
      this.config.workerSeats = workerSeats
      return this.publishRunning()
    })
  }
  tick(): Promise<RegisteredInstance | undefined> {
    return this.serial(async () => {
      if (this.stopped) return
      const saved = await this.storage.get<Saved>(this.key)
      this.assertAccount(saved)
      if (!saved?.pending && saved?.lastPublishedAt !== undefined && this.now() - saved.lastPublishedAt < HEARTBEAT_INTERVAL_MS) return
      return this.publish('running')
    })
  }
  async disconnect(): Promise<void> {
    // Stop local publication regardless of remote connectivity. Never wait for another Host.
    this.stopped = true
    await this.serial(async () => {
      const saved = await this.storage.get<Saved>(this.key)
      this.assertAccount(saved)
      if (!saved?.member && !saved?.pending) return
      if (saved.pending) await this.publish(saved.pending.heartbeat.status)
      await this.publish('stopped')
    })
  }
  private async publish(status: Heartbeat['status']): Promise<RegisteredInstance> {
    await this.assertAccountIdentity()
    let saved = await this.storage.get<Saved>(this.key) ?? { sequence: 0 }
    this.assertAccount(saved)
    if (!saved.pending) {
      await withSnapshot(this.files, async snapshot => {
        // Name occupancy is path metadata. An unrelated damaged body must not
        // prevent this Host from saving its own valid registration.
        const registrations = (await this.files.listDirectory(snapshot, 'instances/'))
          .map(entry => parseInstancePath(entry.path)).filter((entry): entry is Omit<RegisteredInstance, 'primary'> => entry !== undefined)
        this.assertAccount(saved, registrations.some(row => row.instanceUUID === this.config.instanceUUID),
          registrations.filter(row => row.instanceUUID === this.config.instanceUUID).map(row => row.member))
        const own = []
        for (const registration of registrations.filter(row => row.instanceUUID === this.config.instanceUUID)) {
          const body = await this.files.read(snapshot, registration.path)
          if (body !== undefined) own.push({ registration, heartbeat: heartbeat(body) })
        }
        const occupied = new Set(registrations.filter(row => row.instanceUUID !== this.config.instanceUUID).map(row => row.member.toLowerCase()))
        let member = saved.member ?? own[0]?.registration.member
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
        await this.storage.set(this.key, saved)
      })
    }
    const prepared = saved.pending!
    try {
      await this.transactions.run('heartbeat:' + prepared.id, prepared, { expectedRevision: prepared.revision }, async () => {
        const changes: FileChange[] = prepared.previousPaths.map(path => ({ path, content: null }))
        changes.push({ path: prepared.registration.path, content: JSON.stringify(prepared.heartbeat) + '\n' })
        return changes
      })
    } catch (error) {
      if (error instanceof FilesConflictError) {
        // Proven conflict means no write at H; a later call must reread and choose again.
        const { pending: _pending, ...rest } = saved
        await this.storage.set(this.key, rest)
      }
      throw error
    }
    await withSnapshot(this.files, async snapshot => {
      const body = await this.files.read(snapshot, prepared.registration.path)
      const confirmed = body === undefined ? undefined : heartbeat(body)
      if (confirmed === undefined || JSON.stringify(confirmed) !== JSON.stringify(prepared.heartbeat)) {
        throw new Error('Instance heartbeat read-back differs; preserve the pending publication for inspection.')
      }
      // Hand the already verified readback to this observer. Its next discovery
      // still compares the authoritative entry version before using this value.
      const entry = (await this.files.listDirectory(snapshot, 'instances/')).find(row => row.path === prepared.registration.path)
      if (entry) this.heartbeatObservations.set(entry.path, { version: entry.version, heartbeat: confirmed })
    })
    await this.storage.set(this.key, { ...(saved.accountId === undefined ? {} : { accountId: saved.accountId }), member: prepared.registration.member, sequence: saved.sequence, lastPublishedAt: this.now() } satisfies Saved)
    return prepared.registration
  }
  /** Losing observation continuity discards time-based claims, not remote records. */
  observationInterrupted(): void { this.interrupted = true }
  async observe(borrowed?: FilesSnapshot): Promise<ObservedInstance[]> {
    try {
      const inspect = async (snapshot: FilesSnapshot) => {
        const rows = await this.rows(snapshot), now = this.now()
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
