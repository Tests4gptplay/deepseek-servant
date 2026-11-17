import { readFrameworkSkillCatalog, type FrameworkSkillProvider } from './skills.js'
import type { FilesStore } from './transactions.js'

/** An event-driven, process-local refresh. Writers signal only after successful
 * publication; their original proposals and completion order are not authority.
 * One current metadata snapshot supplies every DSS provider before ONE native
 * registry invalidation. No timer, AI wake, transaction lock or remote broadcast.
 */
export class FrameworkSkillCacheRefresh {
  private requested = 0
  private pending?: Promise<void>
  private closed = false
  private readonly cancellation = new AbortController()
  constructor(private readonly files: FilesStore, private readonly providers: () => Iterable<FrameworkSkillProvider>,
    private readonly onError: (error: unknown) => void) {}

  request(): void {
    if (this.closed) return
    this.requested++
    this.start()
  }
  private live(): Map<FrameworkSkillProvider, number> {
    return new Map([...this.providers()].filter(provider => provider.available())
      .map(provider => [provider, provider.catalogGeneration()]))
  }
  private start(): void {
    if (this.closed || this.pending) return
    let attempted = this.requested
    const operation = Promise.resolve().then(async () => {
      while (!this.closed) {
        attempted = this.requested
        const before = this.live()
        if (!before.size) return // A later provider's initial list reads current storage.
        const entries = await readFrameworkSkillCatalog(this.files, this.cancellation.signal)
        if (this.closed) return
        if (attempted !== this.requested) continue // A new successful commit superseded this read.
        const current = this.live()
        // A selected get, task boundary, mount or unmount may have changed a
        // provider during I/O. Do not overwrite its newer view with this one.
        if (current.size !== before.size || [...current].some(([provider, generation]) => before.get(provider) !== generation)) continue
        // These steps are synchronous: an eager native listener sees all DSS
        // providers patched, not a partially updated set of Agents.
        for (const provider of current.keys()) provider.replaceCatalog(entries)
        for (const provider of current.keys()) if (provider.notifyCatalogChange()) break
        return
      }
    }).catch(error => {
      if (this.closed) return
      // A failed read is not a new catalog. Keep confirmed discovery and
      // selected resources; do not announce an update that did not happen.
      // A later actual publication event may refresh it again.
      this.onError(error)
    }).finally(() => {
      if (this.pending === operation) this.pending = undefined
      // Include an event arriving during completion/error handling, without
      // dropping it just because the preceding single flight was still owned.
      if (!this.closed && attempted !== this.requested) this.start()
    })
    this.pending = operation
  }
  async settled(): Promise<void> { while (this.pending) await this.pending }
  async close(): Promise<void> {
    this.closed = true
    this.cancellation.abort(new DOMException('Skill cache refresh is closed.', 'AbortError'))
    await this.settled()
  }
}
