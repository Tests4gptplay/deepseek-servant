import { createHash } from 'node:crypto'
import type { StoragePort } from '../contracts/ports.js'
import type { RecordAppend, RecordEntry, RecordKind, RecordPage, RecordRead, RecordScope, RecordSummary } from '../contracts/records.js'

const PART_CHARACTERS = 64 * 1024
const PAGE_CHARACTERS = 32 * 1024
const kinds = new Set<RecordKind>(['planner-memory', 'planner-note', 'worker-reply', 'task-origin', 'recovery', 'execution', 'conversation'])
const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v)).join(',') + '}'
  return JSON.stringify(value) ?? 'null'
}
function component(value: string | undefined): string {
  if (!value || /[\0\r\n]/.test(value)) throw new Error('A stable record scope identity is required.')
  return encodeURIComponent(value)
}
export function recordStream(scope: RecordScope): string {
  if (!kinds.has(scope.kind)) throw new Error('Unknown record family.')
  if (scope.kind === 'conversation') return 'conversations/' + component(scope.assistantId) + '/' + component(scope.date)
  const root = scope.kind + '/' + component(scope.taskId)
  return scope.kind === 'worker-reply' ? root + '/' + component(scope.childId) : root
}
export function taskRecordPrefixes(taskId: string): string[] {
  return ['planner-memory', 'planner-note', 'worker-reply', 'recovery', 'execution', 'task-runtime', 'task-staging']
    .map(prefix => prefix + '/' + component(taskId) + '/')
}
export function archivedRecordKey(key: string): string {
  return 'record-archive/' + key.split('/')[1] + '/entry/' + digest(key)
}
function keyFromRef(ref: string): string {
  if (!ref.startsWith('dss-record://')) throw new Error('Use the exact record reference returned by a record tool.')
  return decodeURIComponent(ref.slice('dss-record://'.length))
}
function summary(entry: RecordEntry): RecordSummary {
  const { parts: _parts, fingerprint: _fingerprint, ...result } = entry
  return structuredClone(result)
}
function isEntry(value: unknown): value is RecordEntry {
  return !!value && typeof value === 'object' && (value as RecordEntry).kind === 'servant-record-entry'
    && (value as RecordEntry).schemaVersion === 1
}
function positiveLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error('Invalid page size.')
  return value
}

/** Full immutable entries in the existing StoragePort. Only a final manifest publishes an entry. */
export class RecordJournal {
  private readonly queues = new Map<string, Promise<unknown>>()
  constructor(readonly storage: StoragePort, private readonly now: () => string = () => new Date().toISOString()) {}

  async append(input: RecordAppend): Promise<RecordSummary> {
    const request = structuredClone(input)
    const stream = recordStream(request.scope)
    if (!request.commandId || typeof request.text !== 'string') throw new Error('A command identity and text are required.')
    const previous = this.queues.get(stream) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(async () => {
      const fingerprint = digest(canonicalJson({ scope: request.scope, text: request.text, source: request.source,
        metadata: request.metadata ?? {}, expectedRevision: request.expectedRevision }))
      const entryId = digest(request.commandId)
      const key = stream + '/entry/' + entryId
      const existing = await this.storage.get<RecordEntry>(key)
      if (existing) {
        if (!isEntry(existing) || existing.fingerprint !== fingerprint) throw new Error('COMMAND_ID_REUSED: Record command has different content.')
        return summary(existing)
      }
      const entries = await this.entries(request.scope)
      const revision = entries.at(-1)?.sequence ?? 0
      if (request.expectedRevision !== undefined && request.expectedRevision !== revision) throw new Error('STALE_RECORD_REVISION: Read the current note before updating it.')
      const parts: RecordEntry['parts'] = []
      let offset = 0
      do {
        let end = Math.min(request.text.length, offset + PART_CHARACTERS)
        const last = request.text.charCodeAt(end - 1)
        if (end < request.text.length && last >= 0xd800 && last <= 0xdbff) end--
        const text = request.text.slice(offset, end)
        const part = { key: stream + '/content/' + entryId + '/' + parts.length,
          characters: text.length, bytes: Buffer.byteLength(text, 'utf8'), sha256: digest(text) }
        await this.storage.set(part.key, { schemaVersion: 1, text })
        parts.push(part)
        offset = end
      } while (offset < request.text.length)
      const entry: RecordEntry = {
        schemaVersion: 1, kind: 'servant-record-entry', ref: 'dss-record://' + encodeURIComponent(key),
        scope: request.scope, sequence: revision + 1, commandId: request.commandId, fingerprint,
        createdAt: request.createdAt ?? this.now(), source: request.source,
        characters: request.text.length, bytes: Buffer.byteLength(request.text, 'utf8'), sha256: digest(request.text),
        parts, metadata: request.metadata ?? {},
      }
      // Every part is awaited before this single-key publication. A failed write can be retried with the same command.
      await this.storage.set(key, entry)
      return summary(entry)
    })
    this.queues.set(stream, pending)
    try { return await pending } finally { if (this.queues.get(stream) === pending) this.queues.delete(stream) }
  }

  async byCommand(scope: RecordScope, commandId: string): Promise<RecordEntry | undefined> {
    return this.storage.get<RecordEntry>(recordStream(scope) + '/entry/' + digest(commandId))
  }

  async entries(scope: RecordScope): Promise<RecordEntry[]> {
    const live = await this.storage.list<unknown>(recordStream(scope) + '/entry/')
    const archived = scope.taskId ? (await this.storage.list<unknown>('record-archive/' + component(scope.taskId) + '/entry/'))
      .filter(row => isEntry(row.value) && recordStream(row.value.scope) === recordStream(scope)) : []
    const unique = new Map([...archived, ...live].map(row => [(row.value as RecordEntry).ref, row]))
    return [...unique.values()].map(row => {
      if (!isEntry(row.value) || recordStream(row.value.scope) !== recordStream(scope)) throw new Error('Invalid record manifest: ' + row.key)
      return row.value
    }).sort((a, b) => a.sequence - b.sequence)
  }

  async page(scope: RecordScope, cursor = 0, limit = 20): Promise<RecordPage> {
    if (!Number.isInteger(cursor) || cursor < 0) throw new Error('Invalid record cursor.')
    limit = positiveLimit(limit, 20, 100)
    const all = await this.entries(scope)
    const candidates = all.filter(entry => entry.sequence > cursor)
    const entries = candidates.slice(0, limit)
    return { entries: entries.map(summary), revision: all.at(-1)?.sequence ?? 0,
      ...(candidates.length > entries.length ? { nextCursor: entries.at(-1)!.sequence } : {}) }
  }

  async manifest(ref: string): Promise<RecordEntry> {
    const key = keyFromRef(ref)
    const entry = await this.storage.get<unknown>(archivedRecordKey(key)) ?? await this.storage.get<unknown>(key)
    if (!isEntry(entry) || entry.ref !== ref) throw new Error('Record not found: ' + ref)
    return entry
  }

  async read(ref: string, cursor = 0, limit = PAGE_CHARACTERS): Promise<RecordRead> {
    const entry = await this.manifest(ref)
    if (!Number.isInteger(cursor) || cursor < 0 || cursor > entry.characters) throw new Error('Invalid text cursor.')
    limit = positiveLimit(limit, PAGE_CHARACTERS, 256 * 1024)
    const end = Math.min(entry.characters, cursor + limit)
    let position = 0
    let text = ''
    for (const part of entry.parts) {
      const next = position + part.characters
      if (next > cursor && position < end) {
        const value = await this.storage.get<{ text: string }>(part.key)
        if (!value || digest(value.text) !== part.sha256) throw new Error('Record part is missing or corrupt: ' + part.key)
        text += value.text.slice(Math.max(0, cursor - position), Math.min(part.characters, end - position))
      }
      position = next
    }
    return { entry: summary(entry), text, cursor, ...(end < entry.characters ? { nextCursor: end } : {}) }
  }

  async fullText(ref: string): Promise<string> {
    const entry = await this.manifest(ref)
    const texts: string[] = []
    for (const part of entry.parts) {
      const value = await this.storage.get<{ text: string }>(part.key)
      if (!value || digest(value.text) !== part.sha256) throw new Error('Record part is missing or corrupt: ' + part.key)
      texts.push(value.text)
    }
    const text = texts.join('')
    if (digest(text) !== entry.sha256 || Buffer.byteLength(text, 'utf8') !== entry.bytes) throw new Error('Record content hash mismatch.')
    return text
  }

  async search(scope: RecordScope, query: string, cursor = 0, limit = 20): Promise<{ matches: Array<{ entry: RecordSummary; excerpt: string }>; nextCursor?: number }> {
    if (!query.trim()) throw new Error('Enter a search phrase.')
    limit = positiveLimit(limit, 20, 100)
    const matches: Array<{ entry: RecordSummary; excerpt: string }> = []
    const entries = (await this.entries(scope)).filter(entry => entry.sequence > cursor)
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!
      const text = await this.fullText(entry.ref)
      const found = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
      if (found >= 0) matches.push({ entry: summary(entry), excerpt: text.slice(Math.max(0, found - 100), found + query.length + 160) })
      if (matches.length === limit) return { matches, ...(index + 1 < entries.length ? { nextCursor: entry.sequence } : {}) }
    }
    return { matches }
  }

  async flush(): Promise<void> { await Promise.allSettled([...this.queues.values()]) }
}
