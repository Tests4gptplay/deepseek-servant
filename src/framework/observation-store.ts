import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { GitAuthorityStore } from './git-authority.js'
import type { StoragePort } from '../contracts/ports.js'
import { FilesConflictError, type FilesSnapshot } from './transactions.js'
import type { WorkIdentity } from './recovery.js'
import type { ExecutionObservationStore, StoredExecutionObservation } from './execution-observation.js'

// Multiple runtime/maintenance handles can share one actual Local record.
// Coordinate only that record's mutations, not another work or a whole scope.
const localObservationWrites = new WeakMap<StoragePort, Map<string, Promise<void>>>()
const sameOwner = (left: WorkIdentity | undefined, right: WorkIdentity | undefined): boolean => !left || !right ? left === right
  : (['workId', 'executionId', 'role', 'taskId', 'member', 'workerId'] as const).every(key => left[key] === right[key])
    && (left.lifecycleId ?? '') === (right.lifecycleId ?? '')

/** Native single-record durability is sufficient for one Host's technical observation state. */
export class DurableObservationStore implements ExecutionObservationStore {
  private readonly prefix: string
  constructor(private readonly storage: StoragePort, scope: string,
    readonly released?: (identity: WorkIdentity, snapshot?: FilesSnapshot) => Promise<boolean>) {
    this.prefix = 'framework-observations/' + createHash('sha256').update(scope).digest('hex') + '/'
  }
  private key(workId: string): string { return this.prefix + createHash('sha256').update(workId).digest('hex') }
  private localMutation<T>(key: string, operation: () => Promise<T>): Promise<T> {
    let writes = localObservationWrites.get(this.storage)
    if (!writes) localObservationWrites.set(this.storage, writes = new Map())
    const result = (writes.get(key) ?? Promise.resolve()).then(operation)
    const settled = result.then(() => {}, () => {})
    writes.set(key, settled)
    void settled.then(() => { if (writes!.get(key) === settled) writes!.delete(key) })
    return result
  }
  async get(workId: string): Promise<StoredExecutionObservation | undefined> {
    const key = this.key(workId)
    if (!(this.storage instanceof GitAuthorityStore)) await localObservationWrites.get(this.storage)?.get(key)
    return this.storage.get(key)
  }
  async set(workId: string, value: StoredExecutionObservation, expected: StoredExecutionObservation | undefined): Promise<void> {
    const key = this.key(workId)
    if (this.storage instanceof GitAuthorityStore) return this.storage.updateIndexed<StoredExecutionObservation, void>(key, async (current, snapshot) => {
      if (await this.released?.(value.observation.identity, snapshot)) return { result: undefined, write: false }
      if (JSON.stringify(current) === JSON.stringify(value)) return { result: undefined, write: false }
      if (JSON.stringify(current) !== JSON.stringify(expected)) throw new FilesConflictError(snapshot.revision)
      return { value, result: undefined, write: true }
    })
    await this.localMutation(key, async () => {
      if (await this.released?.(value.observation.identity)) return
      const current = await this.storage.get<StoredExecutionObservation>(key)
      // A superseded runtime must not overwrite the replacement execution's
      // metadata while disposing. This compares ownership, not progress/version.
      if (current && !sameOwner(current.observation.identity, expected?.observation.identity)
        && !sameOwner(current.observation.identity, value.observation.identity))
        throw new Error('Observation execution ownership changed before its metadata write.')
      await this.storage.set(key, value)
    })
  }

  async delete(workId: string, expected: StoredExecutionObservation): Promise<void> {
    if (this.storage instanceof GitAuthorityStore) return this.storage.compareAndDelete(this.key(workId), expected)
    if (!this.storage.delete) throw new Error('Observation storage does not support runtime retirement.')
    const key = this.key(workId)
    await this.localMutation(key, async () => {
      const current = await this.storage.get<StoredExecutionObservation>(key)
      // Retire the actual record observed by this owner. The same execution
      // can acquire newer progress/pending responsibility through another handle.
      if (!current || !isDeepStrictEqual(current, expected)) return
      await this.storage.delete!(key)
    })
  }
  async list(): Promise<StoredExecutionObservation[]> {
    return (await this.storage.list<StoredExecutionObservation>(this.prefix)).map(row => row.value)
  }
}
