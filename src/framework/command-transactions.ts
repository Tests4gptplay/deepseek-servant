import { createHash } from 'node:crypto'
import type { StoragePort } from '../contracts/ports.js'
import { FilesConflictError, FilesOutcomeUnknownError, GitFiles, type FileChange, type FileReceipt, type FilesSnapshot, type FilesStore } from './transactions.js'

interface CommandRecord {
  id: string
  requestHash: string
  expectedRevision: string
  operationId?: string
  receipt?: FileReceipt
  conflicted?: boolean
}
export interface CommandOptions {
  expectedRevision?: string
  snapshot?: FilesSnapshot
  /** Caller explicitly requests a fresh business evaluation after a proven conflict. */
  reevaluate?: boolean
}
export type CommandBuilder = (snapshot: FilesSnapshot) => Promise<readonly FileChange[]>
const hash = (text: string) => createHash('sha256').update(text).digest('hex')

/** Stable command identities join native tool replays to remote operation receipts.
 * Only request hashes and operation metadata are local; no Git business bodies are mirrored.
 */
export class FrameworkTransactions {
  private readonly pending = new Map<string, { hash: string; promise: Promise<FileReceipt> }>()
  private readonly prefix: string
  constructor(readonly files: FilesStore, private readonly records: StoragePort, scope: string) {
    this.prefix = 'framework-commands/' + hash(scope) + '/'
  }
  run(id: string, request: unknown, options: CommandOptions, build: CommandBuilder): Promise<FileReceipt> {
    const requestHash = hash(JSON.stringify(request))
    const active = this.pending.get(id)
    if (active) return active.hash === requestHash ? active.promise : Promise.reject(new Error('A native command identity cannot be reused with different arguments.'))
    const operation = this.execute(id, request, options, build)
    this.pending.set(id, { hash: requestHash, promise: operation })
    void operation.finally(() => { if (this.pending.get(id)?.promise === operation) this.pending.delete(id) }).catch(() => {})
    return operation
  }
  private async execute(id: string, request: unknown, options: CommandOptions, build: CommandBuilder): Promise<FileReceipt> {
    const key = this.prefix + hash(id), requestHash = hash(JSON.stringify(request))
    let record = await this.records.get<CommandRecord>(key)
    if (record && record.requestHash !== requestHash) throw new Error('A native command identity cannot be reused with different arguments.')
    if (record?.receipt) return { ...record.receipt, replay: true }
    if (record?.conflicted && options.reevaluate) record = undefined
    if (record?.operationId && this.files instanceof GitFiles) {
      const resolution = await this.files.resolve(record.operationId)
      if (resolution.status === 'confirmed') {
        const receipt = { revision: resolution.commit, replay: true, operationId: record.operationId }
        await this.records.set(key, { ...record, receipt })
        return receipt
      }
      if (resolution.status === 'unknown') throw new FilesOutcomeUnknownError(record.operationId)
      if (resolution.status === 'conflict') {
        await this.records.set(key, { ...record, conflicted: true })
        if (options.reevaluate) record = undefined
        else throw new FilesConflictError(record.expectedRevision)
      }
    }
    const ownedSnapshot = !options.snapshot || !!record
    const snapshot = record?.operationId && this.files instanceof GitFiles
      ? await this.files.at(record.expectedRevision) : record ? await this.files.snapshot() : options.snapshot ?? await this.files.snapshot()
    try {
      const receiptPath = 'technical/transaction-receipts/' + hash(id) + '.json'
      // A Local process can exit after COMMIT but before saving its local command acknowledgement.
      // This receipt is part of the same authoritative transaction as the business changes.
      const existing = await this.files.read(snapshot, receiptPath)
      if (existing !== undefined) {
        const saved = JSON.parse(existing) as { requestHash: string }
        if (saved.requestHash !== requestHash) throw new Error('Stored command receipt does not match its arguments.')
        const receipt = { revision: snapshot.revision, replay: true }
        await this.records.set(key, { ...(record ?? { id, requestHash, expectedRevision: snapshot.revision }), receipt })
        return receipt
      }
      if ((options.expectedRevision && snapshot.revision !== options.expectedRevision)
        || (record && snapshot.revision !== record.expectedRevision)) throw new FilesConflictError(record?.expectedRevision ?? options.expectedRevision!)
      if (!record) {
        record = { id, requestHash, expectedRevision: snapshot.revision }
        await this.records.set(key, record)
      }
      const changes = await build(snapshot)
      if (!changes.length) {
        const receipt = { revision: snapshot.revision, replay: false }
        await this.records.set(key, { ...record, receipt })
        return receipt
      }
      const combined = this.files instanceof GitFiles ? changes : [...changes, { path: receiptPath, content: JSON.stringify({ requestHash }) + '\n' }]
      const message = 'DSS command ' + hash(id)
      if (this.files instanceof GitFiles && !record.operationId) {
        const prepared = await this.files.prepare(snapshot, combined, message)
        record = { ...record, operationId: prepared.id }
        // Mapping is durable before any network write, even if the process exits here.
        await this.records.set(key, record)
      }
      const receipt = this.files instanceof GitFiles
        ? await this.files.commitPrepared(snapshot, combined, message, record.operationId!)
        : await this.files.commit(snapshot, combined, message)
      await this.records.set(key, { ...record, receipt })
      return receipt
    } catch (error) {
      if (error instanceof FilesConflictError && record) await this.records.set(key, { ...record, conflicted: true })
      throw error
    } finally { if (ownedSnapshot) await snapshot.release() }
  }
}
