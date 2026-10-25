import { createHash } from 'node:crypto'
import type { StoragePort } from '../contracts/ports.js'
import type { ConversationMessage } from '../contracts/assistant.js'
import { RecordJournal } from './record-journal.js'

export interface ConversationEntry extends ConversationMessage {
  assistantId: string; sessionId: string; source: string; at: string; date: string; timeZone: string; ref: string; order: number
}
interface MessageIndex extends Omit<ConversationEntry, 'text'> { order: number }
export interface ConversationPage { messages: ConversationEntry[]; before?: string }
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const part = (value: string) => encodeURIComponent(value)
export class ConversationStore {
  readonly journal: RecordJournal
  constructor(private readonly storage: StoragePort, private readonly timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
    private readonly now: () => string = () => new Date().toISOString()) { this.journal = new RecordJournal(storage, now) }
  private prefix(id: string) { return 'conversation-index/' + part(id) + '/' }
  private key(id: string, sessionId: string, messageId: string) { return this.prefix(id) + hash(sessionId + '\0' + messageId) }
  async append(assistantId: string, sessionId: string, message: ConversationMessage): Promise<ConversationEntry> {
    const key = this.key(assistantId, sessionId, message.id)
    const source = message.source ?? (message.role === 'user' ? 'user' : message.role === 'system' ? 'deepseek-servant' : 'model')
    const prior = await this.storage.get<MessageIndex>(key)
    if (prior) {
      const text = await this.journal.fullText(prior.ref)
      if (text !== message.text || prior.role !== message.role || prior.source !== source) throw new Error('Conversation message identity was reused with different original text.')
      return { ...prior, text }
    }
    const stageKey = key.replace('conversation-index/', 'conversation-staging/')
    const staged = await this.storage.get<{ at: string; date: string; timeZone: string; fingerprint: string }>(stageKey)
    const fingerprint = hash(JSON.stringify([message.role, source, message.text]))
    if (staged && staged.fingerprint !== fingerprint) throw new Error('Conversation identity has different content.')
    const at = staged?.at ?? message.at ?? this.now(), timeZone = staged?.timeZone ?? this.timeZone
    const date = staged?.date ?? new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at))
    if (!staged) await this.storage.set(stageKey, { at, date, timeZone, fingerprint })
    const entry = await this.journal.append({ scope: { kind: 'conversation', assistantId, date },
      commandId: sessionId + ':' + message.id, text: message.text, createdAt: at, source: { kind: 'runtime', id: 'conversation-capture' },
      metadata: { messageId: message.id, role: message.role, source, sessionId, at, timeZone } })
    const value: MessageIndex = { id: message.id, assistantId, sessionId, source, role: message.role, at, date, timeZone, ref: entry.ref, order: entry.sequence }
    await this.storage.set(key, value)
    await this.storage.delete?.(stageKey)
    return { ...value, text: message.text }
  }
  async find(assistantId: string, sessionId: string, messageId: string): Promise<ConversationEntry | undefined> {
    const index = await this.storage.get<MessageIndex>(this.key(assistantId, sessionId, messageId))
    return index ? { ...index, text: await this.journal.fullText(index.ref) } : undefined
  }
  private async index(assistantId: string): Promise<MessageIndex[]> {
    return (await this.storage.list<MessageIndex>(this.prefix(assistantId))).map(item => item.value)
      .sort((a, b) => a.at.localeCompare(b.at) || a.order - b.order || a.ref.localeCompare(b.ref))
  }
  async page(assistantId: string, before?: string, limit = 40, date?: string): Promise<ConversationPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Conversation page size must be between 1 and 100.')
    const all = (await this.index(assistantId)).filter(message => (message.role !== 'system' || message.source === 'deepseek-servant-status') && (date === undefined || message.date === date))
    const end = before === undefined ? all.length : all.findIndex(message => message.ref === before)
    if (end < 0) throw new Error('Conversation cursor no longer exists.')
    const start = Math.max(0, end - limit), selected = all.slice(start, end)
    return { messages: await Promise.all(selected.map(async value => ({ ...value, text: await this.journal.fullText(value.ref) }))),
      ...(start > 0 ? { before: selected[0]!.ref } : {}) }
  }
  async read(assistantId: string, ref: string, cursor = 0, limit = 8192) {
    const manifest = await this.journal.manifest(ref)
    if (manifest.scope.kind !== 'conversation' || manifest.scope.assistantId !== assistantId) throw new Error('Conversation belongs to another assistant.')
    return this.journal.read(ref, cursor, limit)
  }
  async search(assistantId: string, query: string, cursor = 0, limit = 10) {
    if (!query.trim() || !Number.isInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Enter a search phrase and valid page size.')
    const index = await this.index(assistantId), matches: Array<{ message: MessageIndex; excerpt: string }> = []
    let next = cursor
    for (; next < index.length && matches.length < limit; next++) {
      const message = index[next]!, text = await this.journal.fullText(message.ref), found = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
      if (found >= 0) matches.push({ message, excerpt: text.slice(Math.max(0, found - 100), found + query.length + 160) })
    }
    return { matches, ...(next < index.length ? { nextCursor: next } : {}) }
  }
  async complete(assistantId: string, sessionId: string, turn: number, messages: ConversationMessage[], at: string): Promise<void> {
    const originals = await Promise.all(messages.map(message => this.append(assistantId, sessionId, message)))
    if (originals.some(message => message.role === 'system') || !originals.some(message => message.role === 'user') || !originals.some(message => message.role === 'assistant')) return
    const key = 'conversation-exchanges/' + part(assistantId) + '/' + hash(sessionId + ':' + turn)
    if (await this.storage.get(key)) return
    await this.storage.set(key, { sessionId, turn, at, order: originals.at(-1)!.order, refs: originals.filter(message => message.role !== 'system').map(message => message.ref) })
  }
  async seed(assistantId: string): Promise<ConversationMessage[][]> {
    const entries = (await this.storage.list<{ at: string; order: number; sessionId: string; turn: number; refs: string[] }>('conversation-exchanges/' + part(assistantId) + '/'))
      .map(item => item.value).sort((a, b) => a.at.localeCompare(b.at) || a.order - b.order || a.turn - b.turn).slice(-6)
    return Promise.all(entries.map(async entry => Promise.all(entry.refs.map(async ref => {
      const page = await this.journal.manifest(ref)
      return { id: String(page.metadata.messageId), role: page.metadata.role as ConversationMessage['role'],
        source: String(page.metadata.source), text: await this.journal.fullText(ref), at: String(page.metadata.at), ref }
    }))))
  }
}
