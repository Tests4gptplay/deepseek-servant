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

/** Two conversation pages are reconstructable from Git; keep their local copies bounded. */
export const CONVERSATION_CACHE_LIMIT = 100
const messagePath = (key: string): string | undefined => key.startsWith('message-header/') ? key.slice(15)
  : key.startsWith('message-view/') ? key.slice(13) : undefined
function storedScope(key: string): string | undefined {
  const root = /^(?:unconnected\/|\d+\/\d+\/)/.exec(key)?.[0]
  if (!root) return
  if (!key.slice(root.length).startsWith('directory/')) return root
  const end = key.indexOf('/', root.length + 'directory/'.length)
  return end < 0 ? undefined : key.slice(0, end + 1)
}

/** Bootstrap settings, Git projections, drafts and physical ownership only. */
export class CoopCache implements CoopStore {
  private readonly scopes = new Map<string, Map<string, string>>()
  private readonly messages = new Map<string, Map<string, true>>()
  private cleanupError?: string
  private constructor(private readonly domain: Domain<typeof spec>) {
    // Native storage has already loaded this domain. Index its own keys once,
    // rather than walking all accounts and directories for every prefix read.
    for (const [id, item] of domain.table('cache').entries()) {
      const record = item as { key?: string }
      if (typeof record?.key !== 'string') continue
      const scope = storedScope(record.key)
      if (scope) this.remember(scope, record.key.slice(scope.length), id)
    }
  }
  private remember(scope: string, key: string, id: string): void {
    let index = this.scopes.get(scope)
    if (!index) this.scopes.set(scope, index = new Map())
    index.set(key, id)
    this.touch(scope, key)
  }
  private touch(scope: string, key: string): void {
    const path = messagePath(key)
    if (path === undefined) return
    let order = this.messages.get(scope)
    if (!order) this.messages.set(scope, order = new Map())
    order.delete(path); order.set(path, true)
  }
  private async drop(scope: string, key: string): Promise<void> {
    const index = this.scopes.get(scope), id = index?.get(key)
    if (!id) return
    await this.domain.table('cache').delete(id)
    index!.delete(key)
    const path = messagePath(key)
    if (path !== undefined && !index!.has('message-header/' + path) && !index!.has('message-view/' + path)) this.messages.get(scope)?.delete(path)
    if (!index!.size) { this.scopes.delete(scope); this.messages.delete(scope) }
  }
  private async trim(scope: string): Promise<void> {
    try {
      const order = this.messages.get(scope)
      while (order && order.size > CONVERSATION_CACHE_LIMIT) {
        const oldest = order.keys().next().value!
        await this.drop(scope, 'message-header/' + oldest)
        await this.drop(scope, 'message-view/' + oldest)
      }
      this.cleanupError = undefined
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message !== this.cleanupError) console.error('deepseek-servant conversation cache cleanup', error)
      this.cleanupError = message
    }
  }
  static async open(ctx: Context): Promise<CoopCache> {
    const domain = await ctx.storageDomain.open(spec)
    if (!domain.global.get().instanceId) await domain.global.set({ ...domain.global.get(), instanceId: 'coop-' + randomUUID() })
    const cache = new CoopCache(domain)
    for (const scope of cache.messages.keys()) await cache.trim(scope)
    return cache
  }
  get instanceId(): string { return this.domain.global.get().instanceId }
  get settings(): CoopSettings { return this.domain.global.get().settings }
  async configure(settings: CoopSettings): Promise<void> { await this.domain.global.set({ ...this.domain.global.get(), settings }) }
  private scope(key: string): string {
    if (key === 'connection') return key
    const connection = this.connection()
    const directory = this.settings.repositoryDirectory
    return (connection ? connection.repository.id + '/' + connection.identity.id + '/' : 'unconnected/')
      + (directory === 'dss-coop' ? '' : 'directory/' + encodeURIComponent(directory) + '/') + key
  }
  private recordId(key: string): string { return createHash('sha256').update(this.scope(key)).digest('hex') }
  get<T>(key: string): T | undefined {
    if (key === 'connection') return this.connection() as T | undefined
    const value = (this.domain.table('cache').get(this.recordId(key)) as { value: T } | undefined)?.value
    if (value !== undefined) this.touch(this.scope(''), key)
    return value
  }
  async put(key: string, value: unknown): Promise<void> {
    const clean = JSON.parse(JSON.stringify(value))
    if (key === 'connection') { await this.domain.table('cache').put(key, clean); return }
    const scope = this.scope(''), id = createHash('sha256').update(scope + key).digest('hex')
    await this.domain.table('cache').put(id, { key: scope + key, value: clean })
    this.remember(scope, key, id)
    if (messagePath(key) !== undefined) await this.trim(scope)
  }
  async remove(key: string): Promise<void> {
    if (key === 'connection') { await this.domain.table('cache').delete(key); return }
    await this.drop(this.scope(''), key)
  }
  entries<T>(prefix: string): Array<[string, T]> {
    const result: Array<[string, T]> = []
    for (const [key, id] of this.scopes.get(this.scope('')) ?? []) {
      if (!key.startsWith(prefix)) continue
      const record = this.domain.table('cache').get(id) as { value: T } | undefined
      if (record) result.push([key, record.value])
    }
    return result
  }
  connection(): RepoConnection | undefined { return this.domain.table('cache').get('connection') as RepoConnection | undefined }
  drafts(): PendingDraft[] { return this.entries<PendingDraft>('draft/').map(([, value]) => value) }
  async close(): Promise<void> { await this.domain.close(); this.scopes.clear(); this.messages.clear() }
}
