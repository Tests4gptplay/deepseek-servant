import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { StoragePort } from '../../contracts/ports.js'

interface StoredEnvelope { key: string; value: unknown }
const storedEnvelope: z.ZodType<StoredEnvelope> = z.object({ key: z.string().min(1), value: z.json() })
// Host domain identifiers use /^[a-z][a-z0-9_]*$/; the plugin/package retains deepseek-servant.
const servantDomain = defineDomain({ name: 'deepseek_servant', version: 1, tables: { records: domainTable<string, StoredEnvelope>(storedEnvelope) } })

/** A Task, its receipts, and its pending actions share one durable domain record. */
export class DshStorageAdapter implements StoragePort {
  private constructor(private readonly domain: Domain<typeof servantDomain>) {}

  static async open(ctx: Context): Promise<DshStorageAdapter> {
    return new DshStorageAdapter(await ctx.storageDomain.open(servantDomain))
  }

  /** DSH 0.2.1's JSON unit owns the resolved file path; never infer it from the task workspace. */
  recordsDirectory(): string {
    // The domain API has no public location accessor. Keep this host-specific
    // diagnostic read here; all record IO still goes through domain.table().
    const unit = (this.domain as unknown as { unit?: { path?: unknown } }).unit
    if (typeof unit?.path !== 'string' || !path.isAbsolute(unit.path)) {
      throw new Error('当前记录存储没有可打开的本地文件夹。')
    }
    return path.dirname(unit.path)
  }

  async get<T>(key: string): Promise<T | undefined> {
    const record = this.domain.table('records').get(key)
    if (record === undefined) return undefined
    if (record.key !== key) throw new Error(`Servant storage key mismatch: ${key}`)
    return structuredClone(record.value) as T
  }

  async set<T>(key: string, value: T): Promise<void> {
    // z.json rejects undefined, functions, non-finite numbers, and non-JSON values.
    const record = storedEnvelope.parse({ key, value: structuredClone(value) })
    await this.domain.table('records').put(key, record)
  }

  async list<T>(prefix: string): Promise<Array<{ key: string; value: T }>> {
    const records: Array<{ key: string; value: T }> = []
    for (const [key, record] of this.domain.table('records').entries()) {
      if (record.key !== key) throw new Error(`Servant storage key mismatch: ${key}`)
      if (key.startsWith(prefix)) records.push({ key, value: structuredClone(record.value) as T })
    }
    return records
  }

  async delete(key: string): Promise<void> { await this.domain.table('records').delete(key) }
  close(): Promise<void> { return this.domain.close() }
}
