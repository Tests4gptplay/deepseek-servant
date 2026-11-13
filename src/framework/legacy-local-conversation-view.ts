import { join } from 'node:path'
import { FrameworkConversation } from './conversation.js'
import type { FrameworkTransactions } from './command-transactions.js'
import { canonicalLocalLocation } from './local-location.js'
import { localRecordPath } from './local-record-files.js'
import { withLegacySqliteSnapshot } from './legacy-sqlite-reader.js'
import type { FilesStore } from './transactions.js'

/** Explicit original-source presentation, independent of physical conversion.
 * This is not the writable Local adapter or an ignored-SQL fallback. No native
 * Agent, source writer, empty replacement index, repair or materialization is
 * started by opening a historical view. It exposes only existing read ports. */
export class LegacyLocalConversationView {
  constructor(private readonly directory: string, private readonly collaborationId: string) {}
  private async read<T>(action: (conversation: FrameworkConversation) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const directory = await canonicalLocalLocation(this.directory, true)
    return withLegacySqliteSnapshot(join(directory, 'dss-files.sqlite'), async source => {
      const snapshot = { revision: 'legacy-sql-original', release: async () => {} }
      const readBytes: FilesStore['readBytes'] = async (_snapshot, path) => {
        signal?.throwIfAborted()
        const value = await source.read(localRecordPath(path))
        if (value?.kind === 'issue') throw new Error(value.issue.message)
        return value?.bytes
      }
      const unavailable = async (): Promise<never> => { throw new Error('An original conversation view cannot write, initialize, or enumerate unrelated records.') }
      const files: FilesStore = { snapshot: async () => snapshot, readBytes,
        read: async (snapshot, path) => { const bytes = await readBytes(snapshot, path); return bytes === undefined ? undefined : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) },
        list: unavailable, listDirectory: unavailable, commit: unavailable }
      const transactions = { run: unavailable } as unknown as FrameworkTransactions
      return action(new FrameworkConversation(files, transactions, { mode: 'local', collaborationId: this.collaborationId }))
    }, { signal })
  }
  page(...args: Parameters<FrameworkConversation['page']>): ReturnType<FrameworkConversation['page']> {
    const [limit, beforeId, query, _borrowed, signal] = args
    return this.read(conversation => conversation.page(limit, beforeId, query, undefined, signal), signal)
  }
  message(id: string, signal?: AbortSignal): ReturnType<FrameworkConversation['read']> { return this.read(conversation => conversation.read(id), signal) }
  search(query: string, cursor = 0, limit = 10, signal?: AbortSignal): ReturnType<FrameworkConversation['search']> { return this.read(conversation => conversation.search(query, cursor, limit), signal) }
  text(ref: string, cursor = 0, limit = 32768, signal?: AbortSignal): ReturnType<FrameworkConversation['readText']> { return this.read(conversation => conversation.readText(ref, cursor, limit), signal) }
  context(signal?: AbortSignal): ReturnType<FrameworkConversation['foregroundContext']> { return this.read(conversation => conversation.foregroundContext(), signal) }
}
