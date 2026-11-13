import { GitFiles, type FileEntry, type FilesSnapshot } from './transactions.js'

interface Indexed<T> { version: string; value: T; groups: readonly string[] }
export interface DiscoveredRecord<T> { path: string; value: T }

/** A Host-local lookup table, rebuilt from the existing Git records when lost.
 * Immutable snapshot discovery adds/removes changed entries. It neither writes
 * membership to Git nor substitutes cached values for selected business reads. */
export class GitRecordIndex<T> {
  private entries?: readonly FileEntry[]
  private rows = new Map<string, Indexed<T>>()
  private groups = new Map<string, Map<string, T>>()
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private readonly files: GitFiles, private readonly prefix: string,
    private readonly parse: (path: string, text: string) => { value: T; groups: readonly string[] } | undefined) {}

  async at(snapshot: FilesSnapshot, group: string): Promise<DiscoveredRecord<T>[]> {
    const entries = await this.files.discoverDirectory(snapshot, this.prefix)
    const selected = () => [...this.groups.get(group) ?? []].map(([path, value]) => ({ path, value: structuredClone(value) }))
    // A revisited tree can have a new array identity. Compare only the already
    // discovered exact paths/object ids with the complete projection; never
    // substitute another snapshot's membership or read additional files.
    const completed = this.entries
    if (entries === completed || completed && entries.length === completed.length
      && entries.every((entry, index) => entry.path === completed[index]!.path && entry.version === completed[index]!.version)) return selected()
    const operation = this.tail.catch(() => {}).then(async () => {
      if (entries !== this.entries) {
        const rows = new Map(this.rows), changed = new Set<string>()
        const present = new Set(entries.map(entry => entry.path))
        for (const path of rows.keys()) if (!present.has(path)) { rows.delete(path); changed.add(path) }
        for (const entry of entries) {
          if (rows.get(entry.path)?.version === entry.version) continue
          const text = await this.files.readDiscovery(snapshot, entry.path)
          if (text === undefined) throw new Error('Discovered Git record is missing from its immutable snapshot.')
          const parsed = this.parse(entry.path, text)
          rows.set(entry.path, { version: entry.version, value: parsed?.value as T, groups: parsed?.groups ?? [] })
          changed.add(entry.path)
        }
        // Publish only a complete successful update. A failed read must leave
        // the preceding index usable for its own view, never mark this H ready.
        for (const path of changed) {
          for (const key of this.rows.get(path)?.groups ?? []) {
            const members = this.groups.get(key)
            members?.delete(path)
            if (!members?.size) this.groups.delete(key)
          }
          const row = rows.get(path)
          for (const key of row?.groups ?? []) {
            let members = this.groups.get(key)
            if (!members) this.groups.set(key, members = new Map())
            members.set(path, row!.value)
          }
        }
        this.rows = rows; this.entries = entries
      }
      return selected()
    })
    this.tail = operation
    return operation
  }
}
