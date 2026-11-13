import { createHash, randomUUID } from 'node:crypto'
import { copyRecordTree, recordTreeFingerprint, type RecordTreeCopyState } from '../../framework/record-tree-copy.js'
import { lstat, mkdir, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable, DomainError } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { StoragePort } from '../../contracts/ports.js'
import type { RecordStorageView } from '../../contracts/views.js'
import { omitAbsentFields } from './json-record.js'
import { RecordFilesBackend, ensureRecordTree, recordFolder, recordFileUsage, configurationCarryRequired, carryCurrentConfigurations, finishConfigurationCarry, retirePreviousConfigurations, readPreviousLocalConfiguration } from './record-files.js'

interface StoredEnvelope { key: string; value: unknown }
const storedEnvelope: z.ZodType<StoredEnvelope> = z.object({ key: z.string().min(1), value: z.json() })
const servantDomain = defineDomain({ name: 'deepseek_servant', version: 1, tables: { records: domainTable<string, StoredEnvelope>(storedEnvelope) } })
const locationDomain = defineDomain({ name: 'deepseek_servant_location', version: 1,
  tables: { settings: domainTable<string, LocationValue>(
    z.object({ directory: z.string().min(1), layout: z.enum(['folders-v1', 'folders-v2']).optional(), move: z.object({ commandId: z.string().min(1), destination: z.string().min(1), copy: z.object({ version: z.literal(1), source: z.string(), destination: z.string(), fingerprint: z.string(), owned: z.record(z.string(), z.object({ dev: z.string(), ino: z.string() })) }).optional() }).optional() })) } })
const DATA_FOLDER = 'deepseek_servant'
const LEGACY_FILE = 'deepseek_servant.json'
interface Records {
  get(key: string): StoredEnvelope | undefined
  entries(): IterableIterator<[string, StoredEnvelope]>
  put(key: string, value: StoredEnvelope): Promise<void>
  delete(key: string): Promise<void>
}
interface OpenRecords { table: Records; files?: RecordFilesBackend; close(): Promise<void> }
type Location = Domain<typeof locationDomain>
type LocationValue = { directory: string; layout?: 'folders-v1' | 'folders-v2'; move?: { commandId: string; destination: string; copy?: RecordTreeCopyState } }

class LocationCommitUncertainError extends Error {
  constructor(readonly destination: string, cause: unknown) {
    super('Record location could not be confirmed. Both record copies are retained: ' + destination, { cause })
    this.name = 'LocationCommitUncertainError'
  }
}

/** Domain.get is an in-memory map. A rejected JSON publish can have renamed the
 * durable file before losing acknowledgement, so only a fresh native open is a
 * readback of the locator rather than its stale in-memory value.
 */
async function selectLocation(ctx: Context, location: Location, value: LocationValue): Promise<
  { location: Location; committed: true } | { location: Location; committed: false; error: unknown }> {
  const previous = location.table('settings').get('active')
  if (isDeepStrictEqual(previous, value)) return { location, committed: true }
  try { await location.table('settings').put('active', value); return { location, committed: true } }
  catch (error) {
    let fresh: Location
    try { await location.close(); fresh = await ctx.storageDomain.open(locationDomain) }
    catch (readback) { throw new LocationCommitUncertainError(value.directory, new AggregateError([error, readback], 'Location write and durable readback failed.')) }
    const selected = fresh.table('settings').get('active')
    if (isDeepStrictEqual(selected, value)) return { location: fresh, committed: true }
    if (isDeepStrictEqual(selected, previous)) return { location: fresh, committed: false, error }
    try { await fresh.close() }
    catch (close) { throw new LocationCommitUncertainError(value.directory, new AggregateError([error, close], 'Unexpected location readback and handle-close failure.')) }
    throw new LocationCommitUncertainError(value.directory, error)
  }
}

interface PendingRelocation {
  destination: string
  sourceTree: string
  targetTree: string
  target: OpenRecords
  verifyPublished?: (directory: string) => Promise<void>
}

/** One durable Task or skill record remains the atomic commit boundary. */
export class DshStorageAdapter implements StoragePort {
  // Ordinary reads observe accepted writes for their key/prefix. Unrelated
  // records have no shared preparation lane or all-record replay obligation.
  private readonly writes = new Map<string, Promise<void>>()
  private barrier: Promise<void> = Promise.resolve()
  private readonly leases = new Set<Promise<void>>()
  private closed = false
  private disposal?: Promise<void>
  private pendingRelocation?: PendingRelocation
  private readonly oldLocalControls = new Map<string, Promise<unknown | undefined>>()
  private readonly oldLocalConfigurations = new Map<string, Promise<unknown | undefined>>()
  private constructor(private readonly ctx: Context, private records: OpenRecords, private directory: string,
    private location: Location, private readonly configurationIssues: string[] = []) {}

  static async open(ctx: Context): Promise<DshStorageAdapter> {
    let location = await ctx.storageDomain.open(locationDomain)
    let records: OpenRecords | undefined
    try {
      const selected = location.table('settings').get('active')
      // Resolve the existing DSS domain route without opening its old unit.
      // The locator can use a different backend and must not change that default.
      const requested = selected?.directory ?? nativeRecordDirectory(ctx)
      if (!path.isAbsolute(requested)) throw new Error('记录目录必须是完整路径。')
      await mkdir(requested, { recursive: true })
      const directory = await realpath(requested)
      if (!(await stat(directory)).isDirectory()) throw new Error('记录目录不可用：' + directory)
      const tree = path.join(directory, DATA_FOLDER)
      const carry = await configurationCarryRequired(tree, selected?.layout)
      records = await openTree(ctx, tree, carry)
      if (carry) await carryCurrentConfigurations(tree, async (key, value) => {
        await records!.table.put(key, storedEnvelope.parse({ key, value }))
      })
      await finishConfigurationCarry(tree)
      // Missing current folders stay at the configured location; an unavailable
      // drive is never redirected to another root or to preserved old records.
      const selection = await selectLocation(ctx, location, { directory, layout: 'folders-v2' })
      location = selection.location
      if (!selection.committed) throw selection.error
      const configurationIssues = await retirePreviousConfigurations(tree, key => records!.files?.assertReadable(key), carry)
      return new DshStorageAdapter(ctx, records, directory, location, configurationIssues)
    } catch (error) {
      const closed = await Promise.allSettled([records?.close(), location.close()])
      const failures: unknown[] = [error, ...closed.flatMap(result => result.status === 'rejected' ? [result.reason] : [])]
      if (failures.length > 1) throw new AggregateError(failures, 'Opening record storage failed; current records are retained.')
      throw error
    }
  }

  usageFiles(): Promise<Array<{ key?: string; path: string; bytes: number }>> {
    // A whole-tree physical diagnostic retains its no-concurrent-write view;
    // ordinary get/list do not take this exclusive barrier.
    return this.exclusive(async () => recordFileUsage(path.join(this.directory, DATA_FOLDER),
      [...this.records.table.entries()].map(([key]) => key)))
  }
  recordsDirectory(): string { return this.directory }
  ensureRecordsDirectory(): Promise<string> {
    return this.exclusive(async () => {
      await ensureRecordTree(path.join(this.directory, DATA_FOLDER))
      await this.refreshRecords()
      return this.directory
    })
  }
  storageView(): RecordStorageView {
    const nativeRoot = (this.ctx.get('sessionPersistence') as unknown as { root?: unknown } | undefined)?.root
    return { directory: this.directory, issues: [...(this.records.files?.problems() ?? []), ...this.configurationIssues],
      ...(typeof nativeRoot === 'string' && path.isAbsolute(nativeRoot) ? { nativeDirectory: nativeRoot } : {}) }
  }
  /** d19 persisted the whole scoped control in other/, not today's category.
   * Read its one known native JSON unit once; never enumerate or import other/.
   * This is a Host-local compatibility observation, not a new control write. */
  readLegacyLocalControls(scope: string): Promise<unknown | undefined> {
    let pending = this.oldLocalControls.get(scope)
    if (!pending) {
      pending = (async () => {
        if (this.closed) throw new Error('The selected record store is closed.')
        const digest = (value: string) => createHash('sha256').update(value).digest('hex')
        const key = 'framework-user-controls/' + digest(scope)
        const folder = path.join(this.directory, DATA_FOLDER, 'other', digest(scope).slice(0, 32) + '--' + digest(key))
        const kind = await lstat(folder).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
        if (!kind) return undefined
        if (!kind.isDirectory() || kind.isSymbolicLink()) throw new Error('The original Local control folder is not an ordinary directory: ' + folder)
        const file = path.join(folder, 'record.json')
        const body = await lstat(file).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
        if (!body) return undefined
        if (!body.isFile() || body.isSymbolicLink()) throw new Error('The original Local control is not an ordinary file: ' + file)
        const parsed = JSON.parse(await readFile(file, 'utf8')) as { tables?: { records?: Record<string, unknown> } }
        const entries = Object.entries(parsed.tables?.records ?? {})
        if (entries.length !== 1 || entries[0]?.[0] !== key) throw new Error('The original Local control native record identity differs: ' + file)
        const envelope = entries[0][1] as { key?: unknown; value?: unknown } | null
        if (!envelope || envelope.key !== key || !Object.hasOwn(envelope, 'value'))
          throw new Error('The original Local control envelope differs: ' + file)
        return envelope.value
      })()
      this.oldLocalControls.set(scope, pending)
    }
    return pending
  }
  /** Exact accepted relocation evidence only. This does not open a database,
   * scan a tree, or affect ordinary technical reads and writes. */
  recordMoveCopy(commandId: string): RecordTreeCopyState | undefined {
    const move = this.location.table('settings').get('record-move')?.move
    return move?.commandId === commandId && move.copy ? structuredClone(move.copy) : undefined
  }

  /** Explicitly relocate the owned technical tree. The caller stops affected
   * Local producers; unrelated Git execution is not stopped. The existing
   * adapter barrier drains/queues technical publications during this copy. */
  moveRecords(directory: string, expectedDirectory: string, signal: AbortSignal,
    verifyPublished?: (targetRecordsDirectory: string) => Promise<void>, commandId?: string): Promise<RecordStorageView> {
    return this.exclusive(async () => {
      signal.throwIfAborted()
      if (expectedDirectory !== this.directory) throw new Error('记录目录已变化，请刷新后重试。')
      if (!path.isAbsolute(directory)) throw new Error('请输入文件夹的完整绝对路径。')
      await ensureRecordTree(path.join(this.directory, DATA_FOLDER))
      // The move copies current physical records, never a prior in-memory image
      // of files that the user has since removed.
      await this.reloadRecords()
      await mkdir(directory, { recursive: true })
      const destination = await realpath(directory)
      if (!(await stat(destination)).isDirectory()) throw new Error('请选择一个文件夹。')
      if (destination === await realpath(this.directory)) return this.storageView()
      const sourceTree = path.join(this.directory, DATA_FOLDER)
      const relative = path.relative(sourceTree, destination)
      if (relative === '' || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) {
        throw new Error('不能迁移到当前记录子文件夹内部。')
      }
      const targetTree = path.join(destination, DATA_FOLDER)
      const ancestor = path.relative(targetTree, sourceTree)
      if (ancestor === '' || !path.isAbsolute(ancestor) && ancestor !== '..' && !ancestor.startsWith('..' + path.sep))
        throw new Error('Record move source and destination trees must not overlap.')
      // A locator-domain receipt stays outside the copied tree. Saving it never
      // re-enters this adapter's exclusive queue or changes the source digest.
      const pending = this.location.table('settings').get('record-move')
      const sameMove = pending?.directory === this.directory && pending.move?.destination === destination
        && (commandId === undefined || pending.move.commandId === commandId)
      if (pending?.move && !sameMove && pending.move.destination !== this.directory)
        throw new Error('Resume the original technical record move before choosing another destination.')
      const move = sameMove ? structuredClone(pending!.move!) : { commandId: commandId ?? randomUUID(), destination, copy: undefined as RecordTreeCopyState | undefined }
      if (!sameMove) {
        if (await exists(targetTree) || await exists(path.join(destination, LEGACY_FILE)))
          throw new Error('目标文件夹已有 Servant 记录，请选择其他文件夹；不会覆盖已有记录。')
        await this.location.table('settings').put('record-move', { directory: this.directory, move })
      } else if (await exists(path.join(destination, LEGACY_FILE))) throw new Error('The destination gained legacy records; existing contents are preserved.')
      let target: OpenRecords | undefined
      try {
        move.copy = await copyRecordTree(sourceTree, targetTree, move.copy, async copy => {
          move.copy = copy
          await this.location.table('settings').put('record-move', { directory: this.directory, move: structuredClone(move) })
        }, signal)
        target = await openTree(this.ctx, targetTree)
        assertSameRecords(this.records.table, target.table)
        // Opening the record backend must not silently alter arbitrary copied
        // files. The explicit Local verification covers its own backend too.
        if (await recordTreeFingerprint(targetTree, signal) !== move.copy.fingerprint)
          throw new Error('Opening the copied technical records changed their contents; both copies are preserved.')
        await verifyPublished?.(destination)
        signal.throwIfAborted()
        const selection = await selectLocation(this.ctx, this.location, { directory: destination, layout: 'folders-v2' })
        this.location = selection.location
        if (!selection.committed) throw selection.error
      } catch (error) {
        if (error instanceof LocationCommitUncertainError && target) {
          this.pendingRelocation = { destination, sourceTree, targetTree, target, verifyPublished }
          throw error
        }
        try { await target?.close() }
        catch (close) { throw new AggregateError([error, close], 'Record relocation and target close failed; both record copies are retained.') }
        // The selected source and every accepted target prefix remain intact.
        // A retry needs this same receipt, identities, and unchanged source.
        throw error
      }
      await this.finishRelocation({ destination, sourceTree, targetTree, target: target!, verifyPublished })
      return this.storageView()
    })
  }

  get<T>(key: string): Promise<T | undefined> {
    return this.read(key, false, async () => {
      this.records.files?.assertReadable(key)
      const record = this.records.table.get(key)
      if (record === undefined || await this.records.files?.hasRecord(key) === false) {
        if (key !== 'framework/local-locations' && !/^framework-(?:connection-settings|instance)\/[a-f0-9]{64}$/.test(key)) return undefined
        let original = this.oldLocalConfigurations.get(key)
        if (!original) {
          original = readPreviousLocalConfiguration(path.join(this.directory, DATA_FOLDER), key)
          this.oldLocalConfigurations.set(key, original)
          void original.catch(() => { if (this.oldLocalConfigurations.get(key) === original) this.oldLocalConfigurations.delete(key) })
        }
        const previous = await original
        // A current same-key write may finish while the old native file is
        // being read. It is the newer accepted value, not a fallback miss.
        const latest = this.records.table.get(key)
        if (latest && await this.records.files?.hasRecord(key) !== false) {
          if (latest.key !== key) throw new Error('Servant storage key mismatch: ' + key)
          return structuredClone(latest.value) as T
        }
        return structuredClone(previous) as T | undefined
      }
      if (record.key !== key) throw new Error('Servant storage key mismatch: ' + key)
      return structuredClone(record.value) as T
    })
  }
  set<T>(key: string, value: T): Promise<void> {
    const record = storedEnvelope.parse({ key, value: omitAbsentFields(structuredClone(value)) })
    return this.write(key, async () => { this.records.files?.assertReadable(key); await this.records.table.put(key, record); this.oldLocalConfigurations.delete(key) })
  }
  private async listedRecords<T>(prefix: string): Promise<Array<{ key: string; value: T }>> {
    const records: Array<{ key: string; value: T }> = []
    for (const [key, record] of this.records.table.entries()) {
      if (!key.startsWith(prefix)) continue
      if (record.key !== key) throw new Error('Servant storage key mismatch: ' + key)
      this.records.files?.assertReadable(key)
      if (await this.records.files?.hasRecord(key) === false) continue
      records.push({ key, value: structuredClone(record.value) as T })
    }
    return records
  }
  list<T>(prefix: string): Promise<Array<{ key: string; value: T }>> {
    return this.read(prefix, true, () => this.listedRecords<T>(prefix))
  }
  /** Runtime admission may observe the last committed value of these exact
   * retired wake receipt writes. Ordinary prefix reads retain their full drain. */
  listWithoutRetiredWakeReceiptWait<T>(prefix: string, receiptKeys: ReadonlySet<string>): Promise<Array<{ key: string; value: T }>> {
    if (!/^framework-runtime\/[a-f0-9]{64}\/wakes\/$/.test(prefix)
      || [...receiptKeys].some(key => !key.startsWith(prefix) || !/^[a-f0-9]{64}$/.test(key.slice(prefix.length))))
      return Promise.reject(new Error('Retired wake receipt read requires exact runtime wake keys.'))
    return this.read(prefix, true, () => this.listedRecords<T>(prefix), receiptKeys)
  }
  /** Stopped-role admission may ignore only exact observation writes already
   * owned by other executions. Own/unknown writes and ordinary list retain
   * their original wait; persisted actions remain visible after cold start. */
  listWithoutUnrelatedObservationWriteWait<T>(prefix: string, unrelatedKeys: ReadonlySet<string>): Promise<Array<{ key: string; value: T }>> {
    return this.read(prefix, true, () => this.listedRecords<T>(prefix), unrelatedKeys)
  }
  /** Task retirement may bypass exact writes proven owned by another Task.
   * This preserves the full committed view and the ordinary read contract. */
  listWithoutUnrelatedTaskRetirementWriteWait<T>(prefix: string, unrelatedKeys: ReadonlySet<string>): Promise<Array<{ key: string; value: T }>> {
    return this.read(prefix, true, () => this.listedRecords<T>(prefix), unrelatedKeys)
  }
  delete(key: string): Promise<void> { return this.write(key, async () => { this.records.files?.assertReadable(key); await this.records.table.delete(key); this.oldLocalConfigurations.delete(key) }) }
  close(): Promise<void> {
    if (this.disposal) return this.disposal
    this.closed = true
    const result = this.drain(async () => {
      const outcomes = await Promise.allSettled([this.records.close(), this.location.close(), this.pendingRelocation?.target.close()])
      const failures = outcomes.flatMap(outcome => outcome.status === 'rejected' ? [outcome.reason] : [])
      if (failures.length) throw new AggregateError(failures, 'Record storage close failed.')
    })
    return this.disposal = result
  }
  private async finishRelocation(move: PendingRelocation): Promise<void> {
    const previous = this.records
    this.records = move.target
    this.directory = move.destination
    this.oldLocalControls.clear() // The verified move selected a different exact old-folder path.
    this.oldLocalConfigurations.clear()
    this.pendingRelocation = undefined
    await previous.close()
  }
  private async reconcileRelocation(): Promise<void> {
    const move = this.pendingRelocation
    if (!move) return
    // No ordinary record write is admitted while its actual durable destination
    // remains unknown. Every attempt reads the native locator from disk anew.
    await this.location.close()
    this.location = await this.ctx.storageDomain.open(locationDomain)
    const selected = this.location.table('settings').get('active')
    if (selected?.directory === move.destination && selected.layout === 'folders-v2') {
      assertSameRecords(this.records.table, move.target.table)
      await move.verifyPublished?.(move.destination)
      await this.finishRelocation(move)
    } else if (selected?.directory === this.directory && selected.layout === 'folders-v2') {
      await move.target.close()
      // Unselected copies belong to the retained explicit move, not cleanup.
      this.pendingRelocation = undefined
    } else throw new LocationCommitUncertainError(move.destination, new Error('The durable locator does not match either owned record location.'))
  }
  private async reloadRecords(): Promise<void> {
    const next = await openTree(this.ctx, path.join(this.directory, DATA_FOLDER))
    const previous = this.records
    this.records = next
    this.oldLocalControls.clear() // Explicit reload observes user edits before a record move.
    this.oldLocalConfigurations.clear()
    await previous.close()
  }
  private async refreshRecords(key?: string): Promise<void> {
    if (await this.records.files?.retryFaults(key)) await this.reloadRecords()
  }
  private recover(key?: string): Promise<void> | undefined {
    if (!this.pendingRelocation && !this.records.files?.needsRetry(key)) return
    // Reserve maintenance BEFORE the caller acquires a lease or joins its write
    // lane. Promoting a leased reader/writer would wait on itself (or successors).
    // The exclusive callback rechecks the current generation, not a saved handle.
    return this.exclusive(() => this.refreshRecords(key))
  }
  private read<T>(key: string, prefix: boolean, operation: () => Promise<T>, excludedWriteKeys?: ReadonlySet<string>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Record storage is closed.'))
    const recovery = this.recover(prefix ? undefined : key)
    const writes = prefix ? [...this.writes].filter(([pending]) => pending.startsWith(key) && !excludedWriteKeys?.has(pending)).map(([, write]) => write)
      : [this.writes.get(key) ?? Promise.resolve()]
    // Failed writes leave the record view's previously committed memory
    // intact. Wait for settlement, then read that value rather than poison reads.
    return this.lease(Promise.all([this.barrier, recovery, ...writes]).then(operation))
  }
  private write(key: string, operation: () => Promise<void>): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Record storage is closed.'))
    const recovery = this.recover(key)
    const result = this.lease(Promise.all([this.barrier, recovery, this.writes.get(key)]).then(() => this.startRecordPublication(operation)))
    const settled = result.then(() => {}, () => {})
    this.writes.set(key, settled)
    void settled.then(() => { if (this.writes.get(key) === settled) this.writes.delete(key) })
    return result
  }
  private async startRecordPublication(operation: () => Promise<void>): Promise<void> {
    // The addressed native unit creates its own folder. Recreate only missing
    // layout metadata; never republish unrelated cached record values.
    await ensureRecordTree(path.join(this.directory, DATA_FOLDER), false, false)
    await operation()
  }
  private lease<T>(result: Promise<T>): Promise<T> {
    const settled = result.then(() => {}, () => {})
    this.leases.add(settled)
    void settled.then(() => this.leases.delete(settled))
    return result
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Record storage is closed.'))
    return this.drain(async () => { await this.reconcileRelocation(); return operation() })
  }
  private drain<T>(operation: () => Promise<T>): Promise<T> {
    // Capture only already accepted work. Future calls wait at the new barrier,
    // so they cannot retain an old domain while it is being reopened or closed.
    const result = Promise.allSettled([this.barrier, ...this.leases]).then(operation)
    this.barrier = result.then(() => {}, error => {
      // Calls queued behind an unknown move must fail closed. A subsequent call
      // reserves fresh locator recovery before it can use either owned copy.
      if (this.pendingRelocation) throw error
    })
    void this.barrier.catch(() => {})
    return result
  }
}

function nativeRecordDirectory(ctx: Context): string {
  // The pinned native facility exposes route metadata at runtime (also used by
  // the native Cleaner adapter), but has no public route-inspection method.
  const config = (ctx.storageDomain as unknown as { config?: { backend?: unknown; routes?: Record<string, unknown> } }).config
  const route = config?.routes?.[servantDomain.name] ?? config?.backend
  if (typeof route !== 'string' || !route) throw new Error('当前 DSS 存储后端路由不可用。')
  const root = (ctx.storage.backend.get(route) as unknown as { root?: unknown }).root
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('当前记录存储没有可管理的本地文件夹。')
  return root
}
async function openTree(ctx: Context, tree: string, pendingConfigurationCarry = false): Promise<OpenRecords> {
  await ensureRecordTree(tree, pendingConfigurationCarry)
  const files = new RecordFilesBackend(tree)
  try {
    const unit = await files.kv.open({ name: servantDomain.name, version: servantDomain.version, tables: ['records'], hasGlobal: false })
    const snapshot = await unit.loadAll()
    // rc.5 Domain serializes all keys together. Reuse the existing per-record
    // native JSON units directly; this adapter already orders same-key writes.
    // This replaces the old Domain's memory, not a second authoritative index.
    const values = new Map<string, StoredEnvelope>(Object.entries(snapshot.tables.records ?? {})
      .map(([key, value]) => {
        try { return [key, storedEnvelope.parse(value)] as [string, StoredEnvelope] }
        catch (cause) { throw new DomainError('invalid-record', `domain '${servantDomain.name}': stored record '${key}' in table 'records' does not match its schema`,
          { detail: { table: 'records', key }, cause }) }
      }))
    const changed = (key: string, value?: StoredEnvelope) => {
      // Preserve the previous post-durability notification. Observer failures
      // cannot turn an already committed write into a failed operation.
      try { ctx.emit('domain/changed', { domain: servantDomain.name, table: 'records', key,
        ...(value === undefined ? { operation: 'deleted' as const } : { operation: 'put' as const, value }) }) }
      catch (error) { ctx.logger.warn('Servant record change listener failed: ' + String(error)) }
    }
    const table: Records = {
      get: key => values.get(key),
      entries: () => [...values.entries()][Symbol.iterator](),
      put: async (key, value) => {
        await unit.putRecord('records', key, value)
        values.set(key, value)
        changed(key, value)
      },
      delete: async key => {
        if (!values.has(key)) return
        await unit.deleteRecord('records', key)
        values.delete(key)
        changed(key)
      },
    }
    return { table, files, close: () => files.close() }
  } catch (error) {
    try { await files.close() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Opening record storage failed.') }
    throw error
  }
}
function assertSameRecords(left: Records, right: Records): void {
  if (!isDeepStrictEqual(new Map(left.entries()), new Map(right.entries()))) {
    throw new Error('记录迁移校验失败，原目录保持不变。')
  }
}
async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
