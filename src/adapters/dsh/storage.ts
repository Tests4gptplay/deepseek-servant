import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, cp, lstat, mkdir, open, readdir, realpath, rename, rm, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable, DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { z } from 'zod'
import type { StoragePort } from '../../contracts/ports.js'
import type { RecordStorageView } from '../../contracts/views.js'
import { omitAbsentFields } from './json-record.js'
import { RecordFilesBackend, ensureRecordTree, recordFolder, recordFileUsage } from './record-files.js'

interface StoredEnvelope { key: string; value: unknown }
const storedEnvelope: z.ZodType<StoredEnvelope> = z.object({ key: z.string().min(1), value: z.json() })
const servantDomain = defineDomain({ name: 'deepseek_servant', version: 1, tables: { records: domainTable<string, StoredEnvelope>(storedEnvelope) } })
const locationDomain = defineDomain({ name: 'deepseek_servant_location', version: 1,
  tables: { settings: domainTable<string, { directory: string; layout?: 'folders-v1' }>(
    z.object({ directory: z.string().min(1), layout: z.literal('folders-v1').optional() })) } })
const DATA_FOLDER = 'deepseek_servant'
const LEGACY_FILE = 'deepseek_servant.json'
type Records = Domain<typeof servantDomain>
interface OpenRecords { domain: Records; files?: RecordFilesBackend; close(): Promise<void> }
type Location = Domain<typeof locationDomain>
type LocationValue = { directory: string; layout?: 'folders-v1' }

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
  private chain: Promise<unknown> = Promise.resolve()
  private retainedSource?: string
  private closed = false
  private disposal?: Promise<void>
  private pendingRelocation?: PendingRelocation
  private constructor(private readonly ctx: Context, private records: OpenRecords, private directory: string,
    private location: Location) {}

  static async open(ctx: Context): Promise<DshStorageAdapter> {
    let location = await ctx.storageDomain.open(locationDomain)
    let legacy: OpenRecords | undefined
    let records: OpenRecords | undefined
    let createdTree = false
    let stage: string | undefined
    let directory: string | undefined
    try {
      const selected = location.table('settings').get('active')
      if (selected) {
        if (!path.isAbsolute(selected.directory)) throw new Error('记录目录必须是完整路径。')
        await mkdir(selected.directory, { recursive: true })
        directory = await realpath(selected.directory)
        if (!(await stat(directory)).isDirectory()) throw new Error('记录目录不可用：' + directory)
      } else {
        const domain = await ctx.storageDomain.open(servantDomain)
        legacy = { domain, close: () => domain.close() }
        directory = path.dirname(legacyFile(domain))
      }
      const tree = path.join(directory, DATA_FOLDER)
      if (selected?.layout === 'folders-v1' || await exists(tree)) {
        records = await openTree(ctx, tree)
      } else {
        if (!legacy) {
          legacy = await openBackend(ctx, new JsonStorageBackend(directory))
        }
        stage = path.join(directory, '.servant-split-' + randomUUID())
        await createTree(stage)
        records = await openTree(ctx, stage)
        for (const [key, record] of legacy.domain.table('records').entries()) {
          await records.domain.table('records').put(key, record)
        }
        await records.close()
        records = await openTree(ctx, stage)
        assertSameRecords(legacy.domain, records.domain)
        await records.close()
        records = undefined
        const original = path.join(directory, LEGACY_FILE)
        if (await exists(original)) {
          const backup = path.join(stage, 'backups', 'deepseek_servant.before-split.json')
          await copyFile(original, backup, constants.COPYFILE_EXCL)
          await syncFile(backup)
        }
        await rename(stage, tree)
        stage = undefined
        createdTree = true
        records = await openTree(ctx, tree)
      }
      // The complete new tree is already durable before the native locator
      // switches. Missing local folders are recreated at their configured location.
      // We never redirect an unavailable drive to a different default location.
      const selection = await selectLocation(ctx, location, { directory, layout: 'folders-v1' })
      location = selection.location
      if (!selection.committed) throw selection.error
      const adapter = new DshStorageAdapter(ctx, records, directory, location)
      if (legacy) {
        try {
          await legacy.close()
          if (createdTree && await exists(path.join(directory, LEGACY_FILE))) await unlink(path.join(directory, LEGACY_FILE))
        } catch { adapter.retainedSource = directory }
      }
      return adapter
    } catch (error) {
      const closed = await Promise.allSettled([records?.close(), legacy?.close(), location.close()])
      const failures: unknown[] = [error, ...closed.flatMap(result => result.status === 'rejected' ? [result.reason] : [])]
      // A failed close is not proof that its producer released the new copy.
      if (failures.length === 1) {
        try {
          if (stage) await rm(stage, { recursive: true, force: true })
          if (createdTree && directory && !(error instanceof LocationCommitUncertainError)) await rm(path.join(directory, DATA_FOLDER), { recursive: true, force: true })
        } catch (cleanup) { failures.push(cleanup) }
      }
      if (failures.length > 1) throw new AggregateError(failures, 'Opening record storage failed; owned copies are retained where cleanup was not confirmed.')
      throw error
    }
  }

  usageFiles(): Promise<Array<{ key?: string; path: string; bytes: number }>> {
    return this.serial(async () => recordFileUsage(path.join(this.directory, DATA_FOLDER),
      [...this.records.domain.table('records').entries()].map(([key]) => key)))
  }
  recordsDirectory(): string { return this.directory }
  ensureRecordsDirectory(): Promise<string> {
    return this.serial(async () => { await this.prepareRecords(true); return this.directory })
  }
  storageView(): RecordStorageView {
    const nativeRoot = (this.ctx.get('sessionPersistence') as unknown as { root?: unknown } | undefined)?.root
    return { directory: this.directory, issues: this.records.files?.problems(),
      ...(typeof nativeRoot === 'string' && path.isAbsolute(nativeRoot) ? { nativeDirectory: nativeRoot } : {}),
      ...(this.retainedSource ? { retainedSource: this.retainedSource } : {}) }
  }

  /** Move the owned tree, including its legacy backup, without moving other host files. */
  moveRecords(directory: string, expectedDirectory: string, signal: AbortSignal,
    verifyPublished?: (targetRecordsDirectory: string) => Promise<void>): Promise<RecordStorageView> {
    return this.serial(async () => {
      signal.throwIfAborted()
      if (expectedDirectory !== this.directory) throw new Error('记录目录已变化，请刷新后重试。')
      if (!path.isAbsolute(directory)) throw new Error('请输入文件夹的完整绝对路径。')
      await this.refreshRecords()
      await this.prepareRecords(true)
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
      if (await exists(targetTree) || await exists(path.join(destination, LEGACY_FILE))) throw new Error('目标文件夹已有 Servant 记录，请选择其他文件夹；不会覆盖已有记录。')
      const stage = path.join(destination, '.servant-move-' + randomUUID())
      let target: OpenRecords | undefined
      let published = false
      try {
        await cp(sourceTree, stage, { recursive: true, errorOnExist: true, force: false })
        await syncCopiedTree(stage)
        target = await openTree(this.ctx, stage)
        assertSameRecords(this.records.domain, target.domain)
        await target.close()
        target = undefined
        signal.throwIfAborted()
        await rename(stage, targetTree)
        published = true
        target = await openTree(this.ctx, targetTree)
        // The caller may verify an owned framework SQLite store after all its
        // producers have closed. It must not call this adapter's serial methods.
        await verifyPublished?.(destination)
        signal.throwIfAborted()
        const selection = await selectLocation(this.ctx, this.location, { directory: destination, layout: 'folders-v1' })
        this.location = selection.location
        if (!selection.committed) throw selection.error
      } catch (error) {
        if (error instanceof LocationCommitUncertainError && target) {
          this.pendingRelocation = { destination, sourceTree, targetTree, target, verifyPublished }
          throw error
        }
        try { await target?.close() }
        catch (close) { throw new AggregateError([error, close], 'Record relocation and target close failed; both record copies are retained.') }
        try { await rm(published ? targetTree : stage, { recursive: true, force: true }) }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'Record relocation failed and the unselected target could not be removed.') }
        throw error
      }
      await this.finishRelocation({ destination, sourceTree, targetTree, target: target!, verifyPublished })
      return this.storageView()
    })
  }

  get<T>(key: string): Promise<T | undefined> {
    return this.serial(async () => {
      await this.refreshRecords()
      this.records.files?.assertReadable(key)
      const record = this.records.domain.table('records').get(key)
      if (record === undefined) return undefined
      if (record.key !== key) throw new Error('Servant storage key mismatch: ' + key)
      return structuredClone(record.value) as T
    })
  }
  set<T>(key: string, value: T): Promise<void> {
    const record = storedEnvelope.parse({ key, value: omitAbsentFields(structuredClone(value)) })
    return this.serial(async () => { await this.refreshRecords(); this.records.files?.assertReadable(key); await this.prepareRecords(); await this.records.domain.table('records').put(key, record) })
  }
  list<T>(prefix: string): Promise<Array<{ key: string; value: T }>> {
    return this.serial(async () => {
      await this.refreshRecords()
      const records: Array<{ key: string; value: T }> = []
      for (const [key, record] of this.records.domain.table('records').entries()) {
        if (record.key !== key) throw new Error('Servant storage key mismatch: ' + key)
        if (key.startsWith(prefix)) records.push({ key, value: structuredClone(record.value) as T })
      }
      return records
    })
  }
  delete(key: string): Promise<void> { return this.serial(async () => { await this.refreshRecords(); this.records.files?.assertReadable(key); await this.prepareRecords(); await this.records.domain.table('records').delete(key) }) }
  close(): Promise<void> {
    if (this.disposal) return this.disposal
    this.closed = true
    const result = this.chain.then(async () => {
      const outcomes = await Promise.allSettled([this.records.close(), this.location.close(), this.pendingRelocation?.target.close()])
      const failures = outcomes.flatMap(outcome => outcome.status === 'rejected' ? [outcome.reason] : [])
      if (failures.length) throw new AggregateError(failures, 'Record storage close failed.')
    })
    this.chain = result.catch(() => {})
    return this.disposal = result
  }
  private async finishRelocation(move: PendingRelocation): Promise<void> {
    const previous = this.records
    this.records = move.target
    this.directory = move.destination
    this.pendingRelocation = undefined
    this.retainedSource = undefined
    try { await previous.close(); await rm(move.sourceTree, { recursive: true }) }
    catch { this.retainedSource = path.dirname(move.sourceTree) }
  }
  private async reconcileRelocation(): Promise<void> {
    const move = this.pendingRelocation
    if (!move) return
    // No ordinary record write is admitted while its actual durable destination
    // remains unknown. Every attempt reads the native locator from disk anew.
    await this.location.close()
    this.location = await this.ctx.storageDomain.open(locationDomain)
    const selected = this.location.table('settings').get('active')
    if (selected?.directory === move.destination && selected.layout === 'folders-v1') {
      assertSameRecords(this.records.domain, move.target.domain)
      await move.verifyPublished?.(move.destination)
      await this.finishRelocation(move)
    } else if (selected?.directory === this.directory && selected.layout === 'folders-v1') {
      await move.target.close()
      await rm(move.targetTree, { recursive: true })
      this.pendingRelocation = undefined
    } else throw new LocationCommitUncertainError(move.destination, new Error('The durable locator does not match either owned record location.'))
  }
  private async refreshRecords(): Promise<void> {
    if (!await this.records.files?.retryFaults()) return
    const next = await openTree(this.ctx, path.join(this.directory, DATA_FOLDER))
    const previous = this.records
    this.records = next
    await previous.close()
  }
  private async prepareRecords(repairMissingFiles = false): Promise<void> {
    const tree = path.join(this.directory, DATA_FOLDER)
    const recreated = await ensureRecordTree(tree)
    if (recreated || repairMissingFiles) {
      // Only current, known in-memory records can be written back. On restart,
      // missing history is absent; old backups are never silently replayed.
      for (const [key, record] of this.records.domain.table('records').entries()) {
        if (!await exists(path.join(tree, recordFolder(key), 'record.json'))) {
          await this.records.domain.table('records').put(key, record)
        }
      }
    }
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Record storage is closed.'))
    const result = this.chain.then(async () => { await this.reconcileRelocation(); return operation() })
    this.chain = result.catch(() => {})
    return result
  }
}

function legacyFile(domain: Records): string {
  const unit = (domain as unknown as { unit?: { path?: unknown } }).unit
  if (typeof unit?.path !== 'string' || !path.isAbsolute(unit.path)) throw new Error('当前记录存储没有可管理的本地文件夹。')
  return unit.path
}
async function openBackend(ctx: Context, backend: Pick<JsonStorageBackend, 'kv' | 'close'>): Promise<OpenRecords> {
  const backendName = 'servant_records_' + randomUUID().replaceAll('-', '_')
  const unregister = ctx.storage.backend.register(backendName, backend)
  try {
    const facility = new DomainFacility(ctx, { backend: backendName })
    const domain = await facility.open(servantDomain)
    return { domain, close: async () => { await domain.close(); await backend.close(); unregister() } }
  } catch (error) { await backend.close(); unregister(); throw error }
}
async function openTree(ctx: Context, tree: string): Promise<OpenRecords> {
  await ensureRecordTree(tree)
  const files = new RecordFilesBackend(tree)
  return { ...await openBackend(ctx, files), files }
}
async function createTree(tree: string): Promise<void> {
  await mkdir(tree)
  await ensureRecordTree(tree)
}
function assertSameRecords(left: Records, right: Records): void {
  if (!isDeepStrictEqual(new Map(left.table('records').entries()), new Map(right.table('records').entries()))) {
    throw new Error('记录迁移校验失败，原目录保持不变。')
  }
}
async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
async function syncFile(file: string): Promise<void> {
  const handle = await open(file, 'r+')
  try { await handle.sync() } finally { await handle.close() }
}

async function syncCopiedTree(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error('记录迁移不接受符号链接：' + file)
    if (entry.isDirectory()) await syncCopiedTree(file)
    else if (entry.isFile()) await syncFile(file)
  }
}
