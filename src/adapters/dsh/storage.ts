import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, open, realpath, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable, DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { z } from 'zod'
import type { StoragePort } from '../../contracts/ports.js'
import type { RecordStorageView } from '../../contracts/views.js'

interface StoredEnvelope { key: string; value: unknown }
const storedEnvelope: z.ZodType<StoredEnvelope> = z.object({ key: z.string().min(1), value: z.json() })
const servantDomain = defineDomain({ name: 'deepseek_servant', version: 1, tables: { records: domainTable<string, StoredEnvelope>(storedEnvelope) } })
// Only the small directory pointer stays in the host's default storage. User
// records continue using the native schema-validated Domain and JSON backend.
const locationDomain = defineDomain({ name: 'deepseek_servant_location', version: 1,
  tables: { settings: domainTable<string, { directory: string }>(z.object({ directory: z.string().min(1) })) } })
type Records = Domain<typeof servantDomain>
interface OpenRecords { domain: Records; close(): Promise<void> }

/** One durable Task record includes its receipts and pending actions. */
export class DshStorageAdapter implements StoragePort {
  private chain: Promise<unknown> = Promise.resolve()
  private retainedSource?: string
  private constructor(private readonly ctx: Context, private records: OpenRecords,
    private readonly location: Domain<typeof locationDomain>) {}

  static async open(ctx: Context): Promise<DshStorageAdapter> {
    const location = await ctx.storageDomain.open(locationDomain)
    try {
      const selected = location.table('settings').get('active')?.directory
      let records: OpenRecords
      if (selected !== undefined) {
        // An unplugged drive must not silently become a fresh, empty assistant.
        const file = path.join(selected, 'deepseek_servant.json')
        if (!(await stat(file)).isFile()) throw new Error('记录存储文件不可用：' + file)
        records = await openAt(ctx, selected)
      } else {
        const domain = await ctx.storageDomain.open(servantDomain)
        records = { domain, close: () => domain.close() }
      }
      return new DshStorageAdapter(ctx, records, location)
    } catch (error) { await location.close(); throw error }
  }

  recordsDirectory(): string { return path.dirname(recordsFile(this.records.domain)) }
  storageView(): RecordStorageView {
    // Native conversation persistence is a separate host service, not this unit.
    const nativeRoot = (this.ctx.get('sessionPersistence') as unknown as { root?: unknown } | undefined)?.root
    return { directory: this.recordsDirectory(),
      ...(typeof nativeRoot === 'string' && path.isAbsolute(nativeRoot) ? { nativeDirectory: nativeRoot } : {}),
      ...(this.retainedSource ? { retainedSource: this.retainedSource } : {}) }
  }

  /** Drain earlier record IO, move one owned file, then release queued IO on the new domain. */
  moveRecords(directory: string, expectedDirectory: string, signal: AbortSignal): Promise<RecordStorageView> {
    return this.serial(async () => {
      signal.throwIfAborted()
      if (expectedDirectory !== this.recordsDirectory()) throw new Error('记录目录已变化，请刷新后重试。')
      if (!path.isAbsolute(directory)) throw new Error('请输入已有文件夹的完整绝对路径。')
      const destination = await realpath(directory)
      if (!(await stat(destination)).isDirectory()) throw new Error('请选择一个文件夹。')
      const sourceFile = recordsFile(this.records.domain)
      if (destination === await realpath(path.dirname(sourceFile))) return this.storageView()
      const targetFile = path.join(destination, 'deepseek_servant.json')
      let target: OpenRecords | undefined
      let copied = false
      try {
        signal.throwIfAborted()
        // The UI normally creates the assistant first. Still materialize an
        // empty native unit if the owner moves storage before its first write.
        try { await stat(sourceFile) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          if ([...this.records.domain.table('records').entries()].length) throw error
          const key = 'storage/empty-migration'
          await this.records.domain.table('records').put(key, { key, value: null })
          await this.records.domain.table('records').delete(key)
        }
        // Exclusive copy refuses an existing assistant instead of merging or
        // replacing it. Unrelated files in the chosen folder are untouched.
        await copyFile(sourceFile, targetFile, constants.COPYFILE_EXCL)
        copied = true
        const file = await open(targetFile, 'r+')
        try { await file.sync() } finally { await file.close() }
        target = await openAt(this.ctx, destination)
        if (!isDeepStrictEqual([...this.records.domain.table('records').entries()], [...target.domain.table('records').entries()])) {
          throw new Error('记录迁移校验失败，原目录保持不变。')
        }
        signal.throwIfAborted()
        // The durable locator is the commit point. No subsequent cancellation
        // or cleanup failure can turn a committed move into a reported refusal.
        await this.location.table('settings').put('active', { directory: destination })
      } catch (error) {
        await target?.close()
        if (copied) await unlink(targetFile)
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('目标文件夹已有 deepseek_servant.json，请选择其他文件夹；不会覆盖已有记录。')
        throw error
      }
      const previous = this.records
      this.records = target!
      this.retainedSource = undefined
      try { await previous.close(); await unlink(sourceFile) }
      catch { this.retainedSource = path.dirname(sourceFile) }
      return this.storageView()
    })
  }

  get<T>(key: string): Promise<T | undefined> {
    return this.serial(async () => {
      const record = this.records.domain.table('records').get(key)
      if (record === undefined) return undefined
      if (record.key !== key) throw new Error('Servant storage key mismatch: ' + key)
      return structuredClone(record.value) as T
    })
  }
  set<T>(key: string, value: T): Promise<void> {
    const record = storedEnvelope.parse({ key, value: structuredClone(value) })
    return this.serial(() => this.records.domain.table('records').put(key, record))
  }
  list<T>(prefix: string): Promise<Array<{ key: string; value: T }>> {
    return this.serial(async () => {
      const records: Array<{ key: string; value: T }> = []
      for (const [key, record] of this.records.domain.table('records').entries()) {
        if (record.key !== key) throw new Error('Servant storage key mismatch: ' + key)
        if (key.startsWith(prefix)) records.push({ key, value: structuredClone(record.value) as T })
      }
      return records
    })
  }
  delete(key: string): Promise<void> { return this.serial(async () => { await this.records.domain.table('records').delete(key) }) }
  close(): Promise<void> { return this.serial(async () => { await this.records.close(); await this.location.close() }) }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation)
    this.chain = result.catch(() => {})
    return result
  }
}

/** Keep the rc.2 JSON unit's physical-path accessor in the host adapter only. */
function recordsFile(domain: Records): string {
  const unit = (domain as unknown as { unit?: { path?: unknown } }).unit
  if (typeof unit?.path !== 'string' || !path.isAbsolute(unit.path)) throw new Error('当前记录存储没有可管理的本地文件夹。')
  return unit.path
}
async function openAt(ctx: Context, directory: string): Promise<OpenRecords> {
  const backend = new JsonStorageBackend(directory)
  const backendName = 'servant_records_' + randomUUID().replaceAll('-', '_')
  const unregister = ctx.storage.backend.register(backendName, backend)
  try {
    const facility = new DomainFacility(ctx, { backend: backendName })
    const domain = await facility.open(servantDomain)
    return { domain, close: async () => { await domain.close(); await backend.close(); unregister() } }
  } catch (error) { await backend.close(); unregister(); throw error }
}
