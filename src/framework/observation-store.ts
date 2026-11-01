import { createHash } from 'node:crypto'
import type { StoragePort } from '../contracts/ports.js'
import type { ExecutionObservationStore, StoredExecutionObservation } from './execution-observation.js'

/** Native single-record durability is sufficient for one Host's technical observation state. */
export class DurableObservationStore implements ExecutionObservationStore {
  private readonly prefix: string
  constructor(private readonly storage: StoragePort, scope: string) {
    this.prefix = 'framework-observations/' + createHash('sha256').update(scope).digest('hex') + '/'
  }
  private key(workId: string): string { return this.prefix + createHash('sha256').update(workId).digest('hex') }
  get(workId: string): Promise<StoredExecutionObservation | undefined> { return this.storage.get(this.key(workId)) }
  set(workId: string, value: StoredExecutionObservation): Promise<void> { return this.storage.set(this.key(workId), value) }
  async list(): Promise<StoredExecutionObservation[]> {
    return (await this.storage.list<StoredExecutionObservation>(this.prefix)).map(row => row.value)
  }
}
