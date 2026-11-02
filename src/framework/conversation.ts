import { createHash } from 'node:crypto'
import { FrameworkTransactions, type CommandOptions } from './command-transactions.js'
import { filePath, withSnapshot, type FileChange, type FileReceipt, type FilesSnapshot, type FilesStore } from './transactions.js'

export interface ConversationScope { mode: 'local' | 'git'; collaborationId: string }
export interface ConversationMessage {
  id: string
  participantId: string
  createdAt: string
  role: 'user' | 'assistant' | 'system'
  source?: string
  text: string
  device?: string
  replyTo?: string
  recipient?: 'ai' | 'human'
  mentions?: string[]
  model?: string
  modelVersion?: string
}
export interface ConversationSend extends ConversationMessage {
  role: 'user' | 'assistant'
  /** Authenticated account display name, not an authorization assertion. */
  username?: string
  timezoneOffsetMinutes?: number
}
export interface ConversationEntry extends Omit<ConversationMessage, 'text'> {
  collaborationId: string
  textPath: string
  textHash: string
}
interface IndexedMessage { id: string; path: string; createdAt?: string; role?: ConversationMessage['role']; replyTo?: string; notification?: string; consumed?: boolean }
interface ConversationIndex { version: 1; messages: IndexedMessage[] }
export interface ForegroundMemory { list: string; cache: string }
export interface ConversationExchange { human: ConversationMessage; assistant: ConversationMessage; assistants: ConversationMessage[] }
export class ConversationRecordError extends Error {
  constructor(readonly path: string, readonly reason: 'missing' | 'integrity' | 'identity', message: string) { super(message); this.name = 'ConversationRecordError' }
}
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
const segment = (value: string) => { filePath(value); if (value.includes('/')) throw new Error('Identity must be a single path segment.'); return value }
const emptyIndex = (): ConversationIndex => ({ version: 1, messages: [] })

/** Shared timeline ordering follows committed index order, not client clock order.
 * FilesStore enforces actual Local/Git authorization at its external boundary.
 */
export class FrameworkConversation {
  readonly indexPath: string
  readonly foregroundRoot: string
  constructor(readonly files: FilesStore, readonly transactions: FrameworkTransactions, readonly scope: ConversationScope) {
    const key = encodeURIComponent(segment(scope.collaborationId))
    this.indexPath = 'conversation-index/' + scope.mode + '/' + key + '/index.json'
    this.foregroundRoot = 'assistants/collaborations/' + scope.mode + '/' + key
  }
  private async index(snapshot: FilesSnapshot): Promise<ConversationIndex> {
    const value = await this.files.read(snapshot, this.indexPath)
    return value === undefined ? emptyIndex() : JSON.parse(value) as ConversationIndex
  }
  private command(id: string): string { return 'conversation/' + this.scope.mode + '/' + this.scope.collaborationId + '/' + id }
  /** The caller retains the original draft/id until the receipt is confirmed.
   * No UI AbortSignal is accepted: closing a view does not revoke a durable send.
   */
  send(commandId: string, message: ConversationSend, options: CommandOptions = {}): Promise<FileReceipt> {
    return this.transactions.run(this.command(commandId), { scope: this.scope, message }, options, async snapshot => {
      const index = await this.index(snapshot)
      const previous = index.messages.find(entry => entry.id === message.id)
      if (previous) {
        const stored = await this.readAt(snapshot, previous)
        const { username: _username, timezoneOffsetMinutes: _offset, ...body } = message
        if (json(stored) !== json(body)) {
          // Compare semantic fields rather than caller object key order.
          if (hash(json(canonical(stored))) !== hash(json(canonical(body)))) throw new ConversationRecordError(previous.path, 'identity', 'Message identity already has different content.')
        }
        return []
      }
      const date = new Date(message.createdAt)
      if (!Number.isFinite(date.getTime())) throw new Error('Message createdAt must be a valid timestamp.')
      const root = 'conversations/' + (this.scope.mode === 'local' ? 'local/' : '') + segment(message.participantId) + '/' + date.toISOString().slice(0, 10) + '/' + message.createdAt.replace(/\D/g, '') + '-' + segment(message.id)
      const textPath = root + '/text', path = root + '/entry.json'
      const { text, username, timezoneOffsetMinutes, ...fields } = message
      if (await this.files.read(snapshot, path) !== undefined) throw new ConversationRecordError(path, 'identity', 'Message path already belongs to another indexed record.')
      const entry: ConversationEntry = { ...fields, collaborationId: this.scope.collaborationId, textPath: this.scope.mode === 'git' ? 'dss-coop/' + textPath : textPath, textHash: hash(text) }
      const changes: FileChange[] = [...textChanges(textPath, text, this.scope.mode === 'git'), { path, content: json(entry) }]
      // The suffix only disambiguates actual same-name notification collisions.
      // Stable message identity preserves timestamp meaning across devices/replays.
      let notification: string | undefined
      if (message.role === 'user' && message.recipient === 'ai') {
        const base = 'state/' + foregroundNotification(username ?? message.participantId, date, timezoneOffsetMinutes ?? 0)
        notification = base
        if (await this.files.read(snapshot, base) !== undefined) notification += '-' + hash(this.scope.mode + '\0' + this.scope.collaborationId + '\0' + message.id)
        changes.push({ path: notification, content: '' })
      }
      index.messages.push({ id: message.id, path, createdAt: message.createdAt, role: message.role,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}), ...(notification ? { notification } : {}) })
      changes.push({ path: this.indexPath, content: json(index) })
      return changes
    })
  }
  private async headerAt(snapshot: FilesSnapshot, indexed: IndexedMessage): Promise<ConversationEntry> {
    const raw = await this.files.read(snapshot, indexed.path)
    if (raw === undefined) throw new ConversationRecordError(indexed.path, 'missing', 'Message entry is missing.')
    const entry = JSON.parse(raw) as ConversationEntry
    if (entry.id !== indexed.id || (entry.collaborationId !== undefined && entry.collaborationId !== this.scope.collaborationId)) throw new ConversationRecordError(indexed.path, 'identity', 'Message reference belongs to a different conversation.')
    return entry
  }
  private async readAt(snapshot: FilesSnapshot, indexed: IndexedMessage, checkedHeader?: ConversationEntry): Promise<ConversationMessage> {
    const entry = checkedHeader ?? await this.headerAt(snapshot, indexed)
    const text = await readText(this.files, snapshot, entry.textPath)
    if (entry.textHash !== undefined && hash(text) !== entry.textHash) throw new ConversationRecordError(entry.textPath, 'integrity', 'Message body hash differs from entry.')
    const { collaborationId: _scope, textPath: _path, textHash: _hash, ...body } = entry
    const writer = (entry as ConversationEntry & { writer?: { participantId?: string } }).writer
    return { ...body, ...(body.participantId ? {} : writer?.participantId ? { participantId: writer.participantId } : {}), text }
  }
  /** One-time migration receives explicitly selected legacy entry paths. It does
   * not infer collaboration membership from the currently authenticated account. */
  indexLegacy(commandId: string, entryPaths: readonly string[], options: CommandOptions = {}): Promise<FileReceipt> {
    return this.transactions.run(this.command(commandId), { scope: this.scope, entryPaths }, options, snapshot => this.planLegacyIndex(snapshot, entryPaths))
  }
  /** Composable migration plan; entry/text files may be read through an overlay. */
  async planLegacyIndex(snapshot: FilesSnapshot, entryPaths: readonly string[]): Promise<FileChange[]> {
    const index = await this.index(snapshot)
    for (const path of entryPaths) {
      filePath(path)
      const logicalPath = logicalReference(path)
      const raw = await this.files.read(snapshot, logicalPath)
      if (raw === undefined) throw new ConversationRecordError(path, 'missing', 'Legacy entry is missing.')
      const entry = JSON.parse(raw) as ConversationEntry
      if (entry.collaborationId !== undefined && entry.collaborationId !== this.scope.collaborationId) throw new ConversationRecordError(path, 'identity', 'Legacy entry belongs to another collaboration.')
      const previous = index.messages.find(item => item.id === entry.id)
      if (previous && previous.path !== logicalPath) throw new ConversationRecordError(path, 'identity', 'Legacy message identity is ambiguous.')
      if (!previous) {
        const indexed = { id: entry.id, path: logicalPath }
        await this.readAt(snapshot, indexed)
        index.messages.push(indexed)
      }
    }
    return [{ path: this.indexPath, content: json(index) }]
  }
  read(messageId: string): Promise<ConversationMessage | undefined> {
    return withSnapshot(this.files, async snapshot => {
      const entry = (await this.index(snapshot)).messages.find(entry => entry.id === messageId)
      return entry ? this.readAt(snapshot, entry) : undefined
    })
  }
  /** Explicit search over full originals; excerpts and page sizes do not truncate storage. */
  search(query: string, cursor = 0, limit = 10) {
    if (!query.trim() || !Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      return Promise.reject(new Error('Enter a search phrase and valid page size.'))
    return withSnapshot(this.files, async snapshot => {
      const entries = (await this.index(snapshot)).messages
      const matches: Array<{ message: Omit<ConversationMessage, 'text'> & { ref: string }; excerpt: string }> = []
      let next = cursor
      for (; next < entries.length && matches.length < limit; next++) {
        const { text, ...header } = await this.readAt(snapshot, entries[next]!)
        const found = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
        if (found >= 0) matches.push({ message: { ...header, ref: header.id }, excerpt: text.slice(Math.max(0, found - 100), found + query.length + 160) })
      }
      return { matches, revision: snapshot.revision, ...(next < entries.length ? { nextCursor: next } : {}) }
    })
  }
  /** Character pagination is opt-in; ordinary message reads still return the full original. */
  readText(ref: string, cursor = 0, limit = 32768) {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 262144)
      return Promise.reject(new Error('Invalid text cursor or page size.'))
    return withSnapshot(this.files, async snapshot => {
      const entry = (await this.index(snapshot)).messages.find(value => value.id === ref)
      if (!entry) throw new ConversationRecordError(this.indexPath, 'identity', 'Conversation reference is absent.')
      const { text, ...header } = await this.readAt(snapshot, entry)
      if (cursor > text.length) throw new Error('Invalid text cursor.')
      const end = Math.min(text.length, cursor + limit)
      return { ref, message: header, text: text.slice(cursor, end), cursor, characters: text.length,
        revision: snapshot.revision, ...(end < text.length ? { nextCursor: end } : {}) }
    })
  }
  /** Caller chooses page size; no product message-length or history limit. */
  page(limit: number, beforeId?: string, query: { afterId?: string; date?: string } = {}): Promise<{ messages: ConversationMessage[]; moreBefore?: string; moreAfter?: string; revision: string }> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Page size must be a positive integer.')
    if (beforeId && query.afterId) throw new Error('Choose one pagination direction.')
    if (query.date && !/^\d{4}-\d{2}-\d{2}$/.test(query.date)) throw new Error('Saved date must use YYYY-MM-DD.')
    return withSnapshot(this.files, async snapshot => {
      const allEntries = (await this.index(snapshot)).messages
      let entries = allEntries
      // Local calendar pages remain day-scoped. Git calendar selection is only
      // the initial inclusive day-end cursor; explicit cursors can cross days.
      if (query.date && (this.scope.mode === 'local' || (!beforeId && !query.afterId))) {
        const matching: IndexedMessage[] = []
        for (const entry of entries) {
          const at = entry.createdAt ?? (await this.headerAt(snapshot, entry)).createdAt
          const day = new Date(at).toISOString().slice(0, 10)
          if (this.scope.mode === 'local' ? day === query.date : day <= query.date) matching.push(entry)
        }
        entries = matching
      }
      let start: number, end: number
      if (query.afterId) {
        const index = entries.findIndex(entry => entry.id === query.afterId)
        if (index < 0) throw new ConversationRecordError(this.indexPath, 'identity', 'Pagination reference is absent.')
        start = index + 1; end = Math.min(entries.length, start + limit)
      } else {
        end = beforeId === undefined ? entries.length : entries.findIndex(entry => entry.id === beforeId)
        if (end < 0) throw new ConversationRecordError(this.indexPath, 'identity', 'Pagination reference is absent.')
        start = Math.max(0, end - limit)
      }
      const selected = entries.slice(start, end)
      return { messages: await Promise.all(selected.map(entry => this.readAt(snapshot, entry))),
        ...(start && selected.length ? { moreBefore: selected[0].id } : {}),
        ...(selected.length && (this.scope.mode === 'git'
          ? allEntries.findIndex(entry => entry.id === selected[selected.length - 1].id) < allEntries.length - 1
          : end < entries.length) ? { moreAfter: selected[selected.length - 1].id } : {}), revision: snapshot.revision }
    })
  }
  /** Only explicit assistant replies complete an exchange; human discussion and
   * unanswered inputs do not consume the six-exchange context budget. */
  recentExchanges(): Promise<ConversationExchange[]> {
    return withSnapshot(this.files, async snapshot => {
      const index = await this.index(snapshot), result: ConversationExchange[] = []
      const selected = new Map<string, ConversationExchange>()
      const byId = new Map(index.messages.map(entry => [entry.id, entry]))
      for (const indexed of [...index.messages].reverse()) {
        // New entries index their immutable provenance. Older indexes remain
        // readable through the original header; unrelated bodies are never read.
        const message = indexed.role ? indexed : await this.headerAt(snapshot, indexed)
        if (message.role !== 'assistant' || !message.replyTo) continue
        const existing = selected.get(message.replyTo)
        if (existing) {
          existing.assistants.unshift(await this.readAt(snapshot, indexed))
          continue
        }
        if (result.length === 6) continue
        const humanIndex = byId.get(message.replyTo)
        if (!humanIndex) continue
        const humanHeader = await this.headerAt(snapshot, humanIndex)
        if (humanHeader.role !== 'user') continue
        const human = await this.readAt(snapshot, humanIndex, humanHeader)
        const assistant = await this.readAt(snapshot, indexed)
        const exchange = { human, assistant, assistants: [assistant] }
        result.unshift(exchange); selected.set(human.id, exchange)
      }
      return result
    })
  }
  readForeground(): Promise<ForegroundMemory> {
    return withSnapshot(this.files, async snapshot => ({
      list: await this.files.read(snapshot, this.foregroundRoot + '/Foreground_List.md') ?? '',
      cache: await this.files.read(snapshot, this.foregroundRoot + '/Foreground_Cache.md') ?? '',
    }))
  }
  private memoryChanges(memory: ForegroundMemory): FileChange[] {
    return [{ path: this.foregroundRoot + '/Foreground_List.md', content: memory.list }, { path: this.foregroundRoot + '/Foreground_Cache.md', content: memory.cache }]
  }
  writeForeground(commandId: string, memory: ForegroundMemory, options: CommandOptions = {}): Promise<FileReceipt> {
    return this.transactions.run(this.command(commandId), { scope: this.scope, memory }, options, async () => this.memoryChanges(memory))
  }
  /** Metadata-only routing prevents generic notification claims from consuming chat. */
  async notificationPaths(snapshot: FilesSnapshot): Promise<string[]> {
    return (await this.index(snapshot)).messages.filter(entry => entry.notification && !entry.consumed).map(entry => entry.notification!)
  }
  pendingForeground(): Promise<{ revision: string; messages: ConversationMessage[] }> {
    return withSnapshot(this.files, async snapshot => ({ revision: snapshot.revision, messages: await Promise.all((await this.index(snapshot)).messages.filter(entry => entry.notification && !entry.consumed).map(entry => this.readAt(snapshot, entry))) }))
  }
  /** Claim only the reviewed revision, persisting the consumed range and memory
   * atomically with removal of its exact empty notification files. */
  claimForeground(commandId: string, messageIds: readonly string[], memory: ForegroundMemory, options: CommandOptions): Promise<FileReceipt> {
    if (!options.expectedRevision && !options.snapshot) return Promise.reject(new Error('Foreground claims require the reviewed snapshot revision.'))
    return this.transactions.run(this.command(commandId), { scope: this.scope, messageIds, memory }, options, async snapshot => {
      const index = await this.index(snapshot), changes = this.memoryChanges(memory)
      for (const id of messageIds) {
        const entry = index.messages.find(entry => entry.id === id)
        if (!entry?.notification) throw new ConversationRecordError(this.indexPath, 'identity', 'Cannot claim a message without a Foreground notification.')
        if (!entry.consumed) { changes.push({ path: entry.notification, content: null }); entry.consumed = true }
      }
      changes.push({ path: this.indexPath, content: json(index) })
      return changes
    })
  }
}
function canonical(value: object): object { return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))) }
export function foregroundNotification(username: string, date: Date, offsetMinutes: number): string {
  if (!Number.isInteger(offsetMinutes)) throw new Error('Timezone offset is expressed in whole minutes.')
  const local = new Date(date.getTime() + offsetMinutes * 60_000).toISOString()
  const hours = Math.floor(Math.abs(offsetMinutes) / 60), minutes = Math.abs(offsetMinutes) % 60
  const zone = 'GMT' + (offsetMinutes < 0 ? '-' : '') + hours + (minutes ? String(minutes).padStart(2, '0').replace(/^/, 'm') : '')
  return 'Foreground_' + segment(username) + '-' + zone + '-' + local.slice(0, 10).replaceAll('-', '') + '-' + local.slice(11, 23).replaceAll(':', '').replace('.', '')
}
function textChanges(path: string, text: string, git: boolean): FileChange[] {
  // Preserve the established UTF-16 chunk length and avoid splitting surrogate pairs.
  const chunks: FileChange[] = []
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 65_536, text.length)
    const last = text.charCodeAt(end - 1)
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--
    chunks.push({ path: path + '/parts/' + chunks.length.toString().padStart(6, '0') + '.txt', content: text.slice(start, end) }); start = end
  }
  return [...chunks, { path: path + '/manifest.json', content: json({ version: 1, sha256: hash(text), characters: text.length, chunks: chunks.map(chunk => git ? 'dss-coop/' + chunk.path : chunk.path) }) }]
}
async function readText(files: FilesStore, snapshot: FilesSnapshot, path: string): Promise<string> {
  path = logicalReference(path)
  filePath(path)
  const raw = await files.read(snapshot, path + '/manifest.json')
  if (raw === undefined) throw new ConversationRecordError(path, 'missing', 'Text manifest is missing.')
  const manifest = JSON.parse(raw) as { version: number; sha256: string; characters: number; chunks: string[] }
  if (manifest.version !== 1 || !Array.isArray(manifest.chunks)) throw new ConversationRecordError(path, 'integrity', 'Unsupported text manifest.')
  const parts: string[] = []
  for (const reference of manifest.chunks) {
    const chunk = logicalReference(reference)
    filePath(chunk)
    if (!chunk.startsWith(path + '/parts/')) throw new ConversationRecordError(chunk, 'integrity', 'Text chunk is outside its referenced record.')
    const part = await files.read(snapshot, chunk)
    if (part === undefined) throw new ConversationRecordError(chunk, 'missing', 'Text chunk is missing.')
    parts.push(part)
  }
  const text = parts.join('')
  if (text.length !== manifest.characters || hash(text) !== manifest.sha256) throw new ConversationRecordError(path, 'integrity', 'Text manifest integrity mismatch.')
  return text
}

function logicalReference(path: string): string { return path.startsWith('dss-coop/') ? path.slice('dss-coop/'.length) : path }
