import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { createHash, randomUUID } from 'node:crypto'
import { CoopSettingsSchema, type CoopSettings, type PendingDraft, type RepoConnection } from './contracts.js'

const spec = defineDomain({
  name: 'deepseek_servant_coop', version: 1, layout: 'per-record',
  global: { schema: z.object({ instanceId: z.string(), settings: CoopSettingsSchema }), initial: { instanceId: '', settings: CoopSettingsSchema.parse({}) } },
  tables: { cache: domainTable<string, unknown>(z.unknown()) },
})

export interface CoopStore {
  readonly instanceId: string
  readonly settings: CoopSettings
  configure(settings: CoopSettings): Promise<void>
  get<T>(key: string): T | undefined
  put(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
  entries<T>(prefix: string): Array<[string, T]>
  connection(): RepoConnection | undefined
  drafts(): PendingDraft[]
  close(): Promise<void>
}

/** Bootstrap settings, Git projections, drafts and physical ownership only. */
export class CoopCache implements CoopStore {
  private constructor(private readonly domain: Domain<typeof spec>) {}
  static async open(ctx: Context): Promise<CoopCache> {
    const domain = await ctx.storageDomain.open(spec)
    if (!domain.global.get().instanceId) await domain.global.set({ ...domain.global.get(), instanceId: 'coop-' + randomUUID() })
    return new CoopCache(domain)
  }
  get instanceId(): string { return this.domain.global.get().instanceId }
  get settings(): CoopSettings { return this.domain.global.get().settings }
  async configure(settings: CoopSettings): Promise<void> { await this.domain.global.set({ ...this.domain.global.get(), settings }) }
  private scope(key: string): string {
    if (key === 'connection') return key
    const connection = this.connection()
    return (connection ? connection.repository.id + '/' + connection.identity.id + '/' : 'unconnected/') + key
  }
  private recordId(key: string): string { return createHash('sha256').update(this.scope(key)).digest('hex') }
  get<T>(key: string): T | undefined {
    if (key === 'connection') return this.connection() as T | undefined
    return (this.domain.table('cache').get(this.recordId(key)) as { value: T } | undefined)?.value
  }
  put(key: string, value: unknown): Promise<void> {
    const clean = JSON.parse(JSON.stringify(value))
    return key === 'connection' ? this.domain.table('cache').put(key, clean)
      : this.domain.table('cache').put(this.recordId(key), { key: this.scope(key), value: clean })
  }
  async remove(key: string): Promise<void> { await this.domain.table('cache').delete(key === 'connection' ? key : this.recordId(key)) }
  entries<T>(prefix: string): Array<[string, T]> {
    const scope = this.scope(''), result: Array<[string, T]> = []
    for (const [, item] of this.domain.table('cache').entries()) {
      const record = item as { key?: string; value: T }
      if (record.key?.startsWith(scope + prefix)) result.push([record.key.slice(scope.length), record.value])
    }
    return result
  }
  connection(): RepoConnection | undefined { return this.domain.table('cache').get('connection') as RepoConnection | undefined }
  drafts(): PendingDraft[] { return this.entries<PendingDraft>('draft/').map(([, value]) => value) }
  close(): Promise<void> { return this.domain.close() }
}
