import { conversationContextKind, appendConversationContext, emptyConversationContext, parseConversationContext, pruneConversationContext, type ConversationContextIndex, type ConversationContextProvenance, type ConversationResponsePhase } from './conversation-context.js'
import { ConversationAttachments } from './conversation-attachments.js'
import type { ConversationAttachmentReference } from './conversation-attachment-reference.js'
import { createHash } from 'node:crypto'
import type { DshForegroundProcessGroup } from '../adapters/dsh/foreground-process.js'
import { preservePublishedReferences } from './published-references.js'
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
  attachments?: ConversationAttachmentReference[]
  /** Publication metadata only. Never decorate the original text or UI. */
  responsePhase?: ConversationResponsePhase
  conversationContext?: ConversationContextProvenance
  device?: string
  replyTo?: string
  recipient?: 'ai' | 'human'
  mentions?: string[]
  model?: string
  modelVersion?: string
}
export interface ConversationSend extends Omit<ConversationMessage, 'conversationContext'> {
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
interface IndexedMessage { id: string; path: string; createdAt?: string; role?: ConversationMessage['role']; replyTo?: string }
export interface ConversationProcessGroup extends DshForegroundProcessGroup { participantId: string; afterMessageId?: string }
interface ConversationIndex { version: 1; messages: IndexedMessage[]; processGroups?: ConversationProcessGroup[] }
export interface ForegroundMemory { list: string; cache: string }
export interface ConversationExchange { human: ConversationMessage; humans: ConversationMessage[]; assistant: ConversationMessage; assistants: ConversationMessage[] }
export interface ForegroundConversationContext {
  messages: ConversationMessage[]
  rounds: Array<{ messageIds: string[]; finalId: string }>
  current: string[]
  revision: string
  history: 'Older and unclassified originals are available through explicit page, message, search and text reads.'
}
export class ConversationRecordError extends Error {
  constructor(readonly path: string, readonly reason: 'missing' | 'integrity' | 'identity', message: string) { super(message); this.name = 'ConversationRecordError' }
}
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
const segment = (value: string) => { filePath(value); if (value.includes('/')) throw new Error('Identity must be a single path segment.'); return value }
/** Escape only the storage representation, never the logical ID or reply reference.
 * The empty legacy ID was invalid, so the timestamp- directory is a reserved
 * namespace: old literal % escapes cannot collide with newly escaped IDs.
 * Existing indexed paths remain authoritative when replaying legacy messages. */
function messagePathSuffix(id: string): string {
  if (!id) throw new Error('Message identity must not be empty.')
  const encoded = encodeURIComponent(id).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase())
    .replace(/\.+$/, dots => dots.replaceAll('.', '%2E'))
  return encoded === id ? segment(id) : '/escaped/' + encoded
}
const emptyIndex = (): ConversationIndex => ({ version: 1, messages: [] })
const contextPath = (scope: ConversationScope) => 'conversation-context/' + scope.mode + '/' + encodeURIComponent(segment(scope.collaborationId)) + '/index.json'
async function contextAt(files: FilesStore, snapshot: FilesSnapshot, path: string): Promise<ConversationContextIndex> {
  const raw = await files.read(snapshot, path)
  return raw === undefined ? emptyConversationContext() : parseConversationContext(raw)
}
function contextResult(index: ConversationContextIndex, messages: ConversationMessage[], revision: string): ForegroundConversationContext {
  return { messages, rounds: index.recent.map(round => ({ messageIds: round.messages.map(row => row.id), finalId: round.finalId })),
    current: index.current.map(row => row.id), revision,
    history: 'Older and unclassified originals are available through explicit page, message, search and text reads.' }
}
const selectedContext = (index: ConversationContextIndex) => [...index.recent.flatMap(round => round.messages), ...index.current]


function mergeProcessGroups(previous: readonly ConversationProcessGroup[], incoming: readonly DshForegroundProcessGroup[], participantId: string, afterMessageId?: string): ConversationProcessGroup[] {
  const groups = new Map(previous.map(group => [group.id, group]))
  for (const group of incoming) {
    if (!group.closed) throw new Error('Only closed native process groups can enter conversation history.')
    const prior = groups.get(group.id)
    if (prior && (prior.turnId !== group.turnId || prior.startedAt !== group.startedAt || prior.participantId !== participantId))
      throw new Error('Native process group identity belongs to another conversation execution.')
    groups.set(group.id, {
      ...group,
      participantId,
      ...(prior?.afterMessageId ?? afterMessageId ? { afterMessageId: prior?.afterMessageId ?? afterMessageId } : {}),
      ...(group.beforeMessageId ?? prior?.beforeMessageId ? { beforeMessageId: group.beforeMessageId ?? prior?.beforeMessageId } : {}),
    })
  }
  return [...groups.values()]
}

interface DailyConversation { version: 1; messages: ConversationMessage[]; processGroups?: ConversationProcessGroup[] }
interface DailyPage { messages: ConversationMessage[]; processGroups: ConversationProcessGroup[]; moreBefore?: string; moreAfter?: string; revision: string; order: string[]; reset?: boolean; day?: string; cursor?: string }
const dailyCursor = (day: string, id = '') => 'day:' + day + ':' + encodeURIComponent(id)
function parseDailyCursor(value: string | undefined): { day: string; id: string } | undefined {
  const match = value && /^day:(\d{4}-\d{2}-\d{2}):(.*)$/.exec(value)
  return match ? { day: match[1]!, id: decodeURIComponent(match[2]!) } : undefined
}
/** Git is a browser of complete daily text records. No per-message index,
 * manifest, chunk list, send receipt or commit value selects visible content. */
class GitDailyConversation {
  readonly root: string;
  readonly contextPath: string;
  readonly attachments: ConversationAttachments;
  constructor(private files: FilesStore, private transactions: FrameworkTransactions, private scope: ConversationScope) {
    this.attachments = new ConversationAttachments(files, transactions, scope);
    this.contextPath = contextPath(scope);
    this.root = 'conversations/git/' + encodeURIComponent(segment(scope.collaborationId)) + '/';
  }
  today(): string { return new Date().toISOString().slice(0, 10); }
  path(day: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day))
      throw new Error('Conversation date must use YYYY-MM-DD.');
    return this.root + day + '.json';
  }
  private async dailyRecord(snapshot: FilesSnapshot, day: string): Promise<DailyConversation> {
    const raw = await this.files.read(snapshot, this.path(day));
    if (raw === undefined) return { version: 1, messages: [] };
    const body = JSON.parse(raw) as DailyConversation;
    if (body.version !== 1 || !Array.isArray(body.messages)) throw new Error('Invalid daily conversation file.');
    return body;
  }
  private async daily(snapshot: FilesSnapshot, day: string): Promise<ConversationMessage[]> {
    return (await this.dailyRecord(snapshot, day)).messages;
  }
  saveProcessGroups(command: string, groups: readonly DshForegroundProcessGroup[], participantId: string): Promise<FileReceipt> {
    const days = [...new Set(groups.map(group => new Date(group.startedAt).toISOString().slice(0, 10)))];
    return this.transactions.run(command, { groups, participantId }, { reevaluate: true, readPlan: { files: days.map(day => this.path(day)) } }, async snapshot => {
      const changes: FileChange[] = [];
      for (const day of days) {
        const record = await this.dailyRecord(snapshot, day), messages = record.messages, previous = record.processGroups ?? [];
        const processGroups = mergeProcessGroups(previous, groups.filter(group => new Date(group.startedAt).toISOString().slice(0, 10) === day), participantId, messages.at(-1)?.id);
        if (json(processGroups) !== json(previous)) changes.push({ path: this.path(day), content: json({ version: 1, messages, processGroups }) });
      }
      return changes;
    });
  }
  async importMessages(snapshot: FilesSnapshot, incoming: readonly ConversationMessage[]): Promise<FileChange[]> {
    const days = [...new Set(incoming.map(message => new Date(message.createdAt).toISOString().slice(0, 10)))];
    await this.files.prefetch?.(snapshot, { files: days.map(day => this.path(day)) });
    const changes: FileChange[] = [];
    for (const day of days) {
      const record = await this.dailyRecord(snapshot, day), messages = [...record.messages];
      for (const message of incoming.filter(row => new Date(row.createdAt).toISOString().slice(0, 10) === day)) {
        const previous = messages.find(row => row.id === message.id);
        if (previous && json(canonical(previous)) !== json(canonical(message)))
          throw new ConversationRecordError(this.path(day), 'identity', 'Imported message identity has different content.');
        if (!previous)
          messages.push(message);
      }
      const processGroups = record.processGroups ?? [];
      changes.push({ path: this.path(day), content: json({ version: 1, messages, ...(processGroups.length ? { processGroups } : {}) }) });
    }
    return changes;
  }
  private async days(snapshot: FilesSnapshot): Promise<string[]> {
    return (await this.files.listDirectory(snapshot, this.root)).map(row => row.path.slice(this.root.length))
      .filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).map(name => name.slice(0, -5)).sort();
  }
  send(command: string, message: ConversationSend, options: CommandOptions, commandInput?: unknown, beforeAppend?: (snapshot: FilesSnapshot) => Promise<void>): Promise<FileReceipt> {
    const date = new Date(message.createdAt), day = date.toISOString().slice(0, 10), path = this.path(day);
    const notification = message.role === 'user' && message.recipient === 'ai'
      ? 'state/' + foregroundNotification(message.username ?? message.participantId, date, message.timezoneOffsetMinutes ?? 0) : undefined;
    const usesContext = conversationContextKind(message) !== undefined;
    return this.transactions.run(command, commandInput === undefined ? { scope: this.scope, message } : { scope: this.scope, commandInput }, { ...options, readPlan: { ...options.readPlan, files: [...(options.readPlan?.files ?? []), path, ...(usesContext ? [this.contextPath] : []), ...notification ? [notification] : []] } }, async (snapshot) => {
      const record = await this.dailyRecord(snapshot, day), messages = record.messages;
      const { username: _name, timezoneOffsetMinutes: _offset, conversationContext: _untrusted, ...body } = message as ConversationSend & Pick<ConversationMessage, 'conversationContext'>;
      const previous = messages.find(row => row.id === message.id);
      if (previous) {
        if (!sameMessageContent(previous, body, commandInput !== undefined && message.role === 'assistant'))
          throw new ConversationRecordError(path, 'identity', 'Message identity already has different content.');
        return [];
      }
      await beforeAppend?.(snapshot);
      await this.attachments.validateReferences(snapshot, body.attachments);
      const previousContext = usesContext ? await contextAt(this.files, snapshot, this.contextPath) : emptyConversationContext();
      const context = appendConversationContext(previousContext, body, path);
      const original: ConversationMessage = { ...body, ...(context.provenance ? { conversationContext: context.provenance } : {}) };
      const processGroups = record.processGroups ?? [];
      const changes: FileChange[] = [
        { path, content: json({ version: 1, messages: [...messages, original], ...(processGroups.length ? { processGroups } : {}) }) },
        ...(context.index !== previousContext ? [{ path: this.contextPath, content: json(context.index) }] : []),
        ...(message.role === 'assistant' ? await preservePublishedReferences(this.files, snapshot, message.text) : []),
      ];
      if (notification) {
        let signal = notification;
        if (await this.files.read(snapshot, signal) !== undefined)
          signal += '-' + hash(this.scope.collaborationId + '\0' + message.id);
        changes.push({ path: signal, content: '' });
      }
      return changes;
    });
  }
  async page(limit: number, beforeId: string | undefined, query: {
    afterId?: string;
    date?: string;
    live?: boolean;
  }, borrowed?: FilesSnapshot, signal?: AbortSignal): Promise<DailyPage> {
    const before = parseDailyCursor(beforeId), after = parseDailyCursor(query.afterId);
    const initialDay = query.live ? this.today() : query.date ?? before?.day ?? after?.day ?? this.today();
    const inspect = async (snapshot: FilesSnapshot): Promise<DailyPage> => {
      signal?.throwIfAborted();
      let day = initialDay, record = await this.dailyRecord(snapshot, day), messages = record.messages, reset = !!(query.live && after && after.day !== day);
      let start = 0, end = messages.length;
      const beforeRef = before?.id ?? beforeId, afterRef = reset ? undefined : after?.id ?? query.afterId;
      if (query.live && query.afterId !== undefined) {
        // The daily file is already read in full. Return this entire live delta
        // without reopening the same file through artificial page boundaries.
        const index = !reset && afterRef ? messages.findIndex(row => row.id === afterRef) : -1;
        if (!reset && afterRef && index < 0) reset = true;
        start = index < 0 ? 0 : index + 1;
        end = messages.length;
      } else if (beforeId) {
        end = beforeRef ? messages.findIndex(row => row.id === beforeRef) : 0;
        if (end < 0) {
          reset = true;
          end = messages.length;
        }
        if (end === 0) {
          const older = (await this.days(snapshot)).filter(value => value < day).at(-1);
          if (older) {
            day = older;
            await this.files.prefetch?.(snapshot, { signal, files: [this.path(day)] });
            record = await this.dailyRecord(snapshot, day);
            messages = record.messages;
            end = messages.length;
          }
        }
        start = Math.max(0, end - limit);
      }
      else if (afterRef) {
        const index = messages.findIndex(row => row.id === afterRef);
        if (index < 0) {
          reset = true;
          start = Math.max(0, messages.length - limit);
        }
        else
          start = index + 1;
        end = Math.min(messages.length, start + limit);
        if (!query.live && start === messages.length) {
          const newer = (await this.days(snapshot)).find(value => value > day);
          if (newer) {
            day = newer;
            await this.files.prefetch?.(snapshot, { signal, files: [this.path(day)] });
            record = await this.dailyRecord(snapshot, day);
            messages = record.messages;
            start = 0;
            end = Math.min(messages.length, limit);
          }
        }
      }
      else
        start = Math.max(0, end - limit);
      signal?.throwIfAborted();
      const selected = messages.slice(start, end);
      return {
        messages: selected, processGroups: record.processGroups ?? [], order: messages.map(row => row.id), day, cursor: dailyCursor(day, selected.at(-1)?.id ?? (messages.some(row => row.id === afterRef) ? afterRef : '') ?? ''), revision: snapshot.revision,
        ...(reset ? { reset: true } : {}), ...(selected.length ? { moreBefore: dailyCursor(day, selected[0]!.id) } : !beforeId ? { moreBefore: dailyCursor(day) } : {}),
        ...(selected.length && (end < messages.length || !query.live && day < this.today()) ? { moreAfter: dailyCursor(day, selected.at(-1)!.id) } : {})
      };
    };
    return borrowed ? inspect(borrowed) : withSnapshot(this.files, inspect, { signal, files: [this.path(initialDay)] });
  }
  async all(snapshot: FilesSnapshot): Promise<ConversationMessage[]> {
    const days = await this.days(snapshot);
    await this.files.prefetch?.(snapshot, { files: days.map(day => this.path(day)) });
    return (await Promise.all(days.map(day => this.daily(snapshot, day)))).flat();
  }
  private async find(snapshot: FilesSnapshot, id: string): Promise<ConversationMessage | undefined> {
    const today = await this.daily(snapshot, this.today()), present = today.find(row => row.id === id);
    if (present)
      return present;
    for (const day of (await this.days(snapshot)).reverse()) {
      if (day === this.today())
        continue;
      await this.files.prefetch?.(snapshot, { files: [this.path(day)] });
      const found = (await this.daily(snapshot, day)).find(row => row.id === id);
      if (found)
        return found;
    }
  }
  read(id: string): Promise<ConversationMessage | undefined> {
    return withSnapshot(this.files, snapshot => this.find(snapshot, id), { files: [this.path(this.today())] });
  }
  readText(ref: string, cursor: number, limit: number) {
    return withSnapshot(this.files, async (snapshot) => {
      const message = await this.find(snapshot, ref);
      if (!message)
        throw new ConversationRecordError(this.path(this.today()), 'identity', 'Conversation reference is absent.');
      const { text, ...header } = message;
      if (cursor > text.length)
        throw new Error('Invalid text cursor.');
      const end = Math.min(text.length, cursor + limit);
      return { ref, message: header, text: text.slice(cursor, end), cursor, characters: text.length, revision: snapshot.revision, ...end < text.length ? { nextCursor: end } : {} };
    }, { files: [this.path(this.today())] });
  }
  async context(snapshot: FilesSnapshot): Promise<ForegroundConversationContext> {
    const index = await contextAt(this.files, snapshot, this.contextPath), selected = selectedContext(index);
    const paths = [...new Set(selected.map(row => row.path))];
    if (paths.some(path => !path.startsWith(this.root) || !/^\d{4}-\d{2}-\d{2}\.json$/.test(path.slice(this.root.length))))
      throw new ConversationRecordError(this.contextPath, 'identity', 'Context points outside this conversation.');
    await this.files.prefetch?.(snapshot, { files: paths });
    const daily = new Map(await Promise.all(paths.map(async path => [path, await this.daily(snapshot, path.slice(this.root.length, -5))] as const)));
    const messages = selected.map(ref => {
      const message = daily.get(ref.path)?.find(row => row.id === ref.id);
      if (!message || message.conversationContext?.position !== ref.position)
        throw new ConversationRecordError(ref.path, 'identity', 'Context original is missing or has a different publication identity.');
      return message;
    });
    return contextResult(index, messages, snapshot.revision);
  }

}

/** Shared timeline ordering follows committed index order, not client clock order.
 * FilesStore enforces actual Local/Git authorization at its external boundary.
 */
export class FrameworkConversation {
  private readonly localIndexPath: string
  private readonly git?: GitDailyConversation
  get indexPath(): string { return this.git ? this.git.path(this.git.today()) : this.localIndexPath }
  readonly contextPath: string
  readonly foregroundRoot: string
  readonly attachments: ConversationAttachments
  constructor(readonly files: FilesStore, readonly transactions: FrameworkTransactions, readonly scope: ConversationScope) {
    this.attachments = new ConversationAttachments(files, transactions, scope)
    const key = encodeURIComponent(segment(scope.collaborationId))
    this.localIndexPath = 'conversation-index/local/' + key + '/index.json'
    this.contextPath = contextPath(scope)
    if (scope.mode === 'git') this.git = new GitDailyConversation(files, transactions, scope)
    this.foregroundRoot = 'assistants/collaborations/' + scope.mode + '/' + key
  }
  private async index(snapshot: FilesSnapshot): Promise<ConversationIndex> {
    const value = await this.files.read(snapshot, this.indexPath)
    return value === undefined ? emptyIndex() : JSON.parse(value) as ConversationIndex
  }
  private command(id: string): string { return 'conversation/' + this.scope.mode + '/' + this.scope.collaborationId + '/' + id }
  /** Store only closed native presentation metadata in the existing conversation
   * record. This is not a message, notification, acknowledgment or completion gate. */
  saveProcessGroups(commandId: string, groups: readonly DshForegroundProcessGroup[], participantId: string): Promise<FileReceipt> {
    const command = this.command('process/' + commandId + '/' + hash(json(groups)))
    if (this.git) return this.git.saveProcessGroups(command, groups, participantId)
    return this.transactions.run(command, { groups, participantId }, { reevaluate: true, readPlan: { files: [this.indexPath] } }, async snapshot => {
      const index = await this.index(snapshot), previous = index.processGroups ?? []
      const processGroups = mergeProcessGroups(previous, groups, participantId, index.messages.at(-1)?.id)
      return json(previous) === json(processGroups) ? [] : [{ path: this.indexPath, content: json({ ...index, processGroups }) }]
    })
  }
  /** The caller retains the original draft/id until the receipt is confirmed.
   * No UI AbortSignal is accepted: closing a view does not revoke a durable send.
   */
  send(commandId: string, message: ConversationSend, options: CommandOptions = {}, commandInput?: unknown, beforeAppend?: (snapshot: FilesSnapshot) => Promise<void>): Promise<FileReceipt> {
    const date = new Date(message.createdAt)
    if (!Number.isFinite(date.getTime())) return Promise.reject(new Error('Message createdAt must be a valid timestamp.'))
    if (this.git) return this.git.send(this.command(commandId), message, options, commandInput, beforeAppend)
    const root = 'conversations/local/' + segment(message.participantId) + '/' + date.toISOString().slice(0, 10) + '/' + message.createdAt.replace(/\D/g, '') + '-' + messagePathSuffix(message.id)
    const textPath = root + '/text', path = root + '/entry.json'
    const notificationBase = message.role === 'user' && message.recipient === 'ai'
      ? 'state/' + foregroundNotification(message.username ?? message.participantId, date, message.timezoneOffsetMinutes ?? 0) : undefined
    const usesContext = conversationContextKind(message) !== undefined
    const readPlan = { files: [this.indexPath, ...(usesContext ? [this.contextPath] : []), path, ...(notificationBase ? [notificationBase] : [])] }
    return this.transactions.run(this.command(commandId), commandInput === undefined ? { scope: this.scope, message } : { scope: this.scope, commandInput }, { ...options, readPlan }, async snapshot => {
      const index = await this.index(snapshot)
      const previous = index.messages.find(entry => entry.id === message.id)
      if (previous) {
        const stored = await this.readAt(snapshot, previous)
        const { username: _username, timezoneOffsetMinutes: _offset, conversationContext: _untrusted, ...body } = message as ConversationSend & Pick<ConversationMessage, 'conversationContext'>
        if (json(stored) !== json(body)) {
          // Compare semantic fields rather than caller object key order.
          if (!sameMessageContent(stored, body, commandInput !== undefined && message.role === 'assistant')) throw new ConversationRecordError(previous.path, 'identity', 'Message identity already has different content.')
        }
        return []
      }
      await beforeAppend?.(snapshot)
      await this.attachments.validateReferences(snapshot, message.attachments)
      const { text, username: _username, timezoneOffsetMinutes: _offset, conversationContext: _untrusted, ...fields } = message as ConversationSend & Pick<ConversationMessage, 'conversationContext'>
      const previousContext = usesContext ? await contextAt(this.files, snapshot, this.contextPath) : emptyConversationContext()
      const context = appendConversationContext(previousContext, fields, path)
      if (await this.files.read(snapshot, path) !== undefined) throw new ConversationRecordError(path, 'identity', 'Message path already belongs to another indexed record.')
      const entry: ConversationEntry = { ...fields, ...(context.provenance ? { conversationContext: context.provenance } : {}), collaborationId: this.scope.collaborationId, textPath, textHash: hash(text) }
      const changes: FileChange[] = [
        ...textChanges(textPath, text, entry.textHash), { path, content: json(entry) },
        ...(context.index !== previousContext ? [{ path: this.contextPath, content: json(context.index) }] : []),
        ...(message.role === 'assistant' ? await preservePublishedReferences(this.files, snapshot, text) : []),
      ]
      // The suffix only disambiguates actual same-name notification collisions.
      // Stable message identity preserves timestamp meaning across devices/replays.
      let notification: string | undefined
      if (notificationBase) {
        const base = notificationBase
        notification = base
        if (await this.files.read(snapshot, base) !== undefined) notification += '-' + hash(this.scope.mode + '\0' + this.scope.collaborationId + '\0' + message.id)
        changes.push({ path: notification, content: '' })
      }
      index.messages.push({ id: message.id, path, createdAt: message.createdAt, role: message.role,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}) })
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
  private async readAt(snapshot: FilesSnapshot, indexed: IndexedMessage, checkedHeader?: ConversationEntry, checkedText?: CheckedText): Promise<ConversationMessage> {
    const entry = checkedHeader ?? await this.headerAt(snapshot, indexed)
    const { text, sha256 } = checkedText ?? await readText(this.files, snapshot, entry.textPath)
    if (entry.textHash !== undefined && sha256 !== entry.textHash) throw new ConversationRecordError(entry.textPath, 'integrity', 'Message body hash differs from entry.')
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
    if (this.git) {
      const messages: ConversationMessage[]=[]
      for(const path of entryPaths){const logicalPath=logicalReference(path),raw=await this.files.read(snapshot,logicalPath);if(raw===undefined)throw new ConversationRecordError(path,'missing','Legacy entry is missing.');const entry=JSON.parse(raw) as ConversationEntry;messages.push(await this.readAt(snapshot,{id:entry.id,path:logicalPath}))}
      return this.git.importMessages(snapshot,messages)
    }
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
    if (this.git) return this.git.read(messageId)
    return withSnapshot(this.files, async snapshot => {
      const entry = (await this.index(snapshot)).messages.find(entry => entry.id === messageId)
      return entry ? this.readAt(snapshot, entry) : undefined
    })
  }
  /** Explicit search over full originals; excerpts and page sizes do not truncate storage. */
  search(query: string, cursor = 0, limit = 10) {
    if (!query.trim() || !Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      return Promise.reject(new Error('Enter a search phrase and valid page size.'))
    if (this.git) return withSnapshot(this.files, async snapshot => {
      const rows=await this.git!.all(snapshot),matches:Array<{message:Omit<ConversationMessage,'text'>&{ref:string};excerpt:string}>=[]
      let next=cursor
      for(;next<rows.length&&matches.length<limit;next++){const {text,...header}=rows[next]!,found=text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());if(found>=0)matches.push({message:{...header,ref:header.id},excerpt:text.slice(Math.max(0,found-100),found+query.length+160)})}
      return {matches,revision:snapshot.revision,...next<rows.length?{nextCursor:next}:{}}
    })
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
    if (this.git) return this.git.readText(ref,cursor,limit)
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
  page(limit: number, beforeId?: string, query: { afterId?: string; date?: string; live?: boolean } = {}, borrowed?: FilesSnapshot, signal?: AbortSignal): Promise<{ messages: ConversationMessage[]; processGroups: ConversationProcessGroup[]; moreBefore?: string; moreAfter?: string; revision: string; order: string[]; reset?: boolean; day?: string; cursor?: string }> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Page size must be a positive integer.')
    if (beforeId && query.afterId) throw new Error('Choose one pagination direction.')
    if (query.date && !/^\d{4}-\d{2}-\d{2}$/.test(query.date)) throw new Error('Saved date must use YYYY-MM-DD.')
    if (this.git) return this.git.page(limit,beforeId,query,borrowed,signal)
    const inspect = async (snapshot: FilesSnapshot) => {
      signal?.throwIfAborted()
      const index = await this.index(snapshot), allEntries = index.messages
      signal?.throwIfAborted()
      let entries = allEntries
      // Local calendar pages retain their original day-scoped behavior.
      if (query.date) {
        const matching: IndexedMessage[] = []
        for (const entry of entries) {
          const at = entry.createdAt ?? (await this.headerAt(snapshot, entry)).createdAt
          const day = new Date(at).toISOString().slice(0, 10)
          if (day === query.date) matching.push(entry)
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
      let messages: ConversationMessage[]
      if (this.files.prefetch && selected.length) {
        signal?.throwIfAborted()
        await this.files.prefetch(snapshot, { signal, files: selected.flatMap(entry => [entry.path,
          ...(entry.path.endsWith('/entry.json') ? [entry.path.slice(0, -'entry.json'.length) + 'text/manifest.json'] : [])]) })
        signal?.throwIfAborted()
        const headers = await Promise.all(selected.map(entry => this.headerAt(snapshot, entry)))
        signal?.throwIfAborted()
        await this.files.prefetch(snapshot, { signal, files: headers.map(entry => logicalReference(entry.textPath) + '/manifest.json') })
        signal?.throwIfAborted()
        const manifests = await Promise.all(headers.map(entry => readManifest(this.files, snapshot, entry.textPath)))
        signal?.throwIfAborted()
        await this.files.prefetch(snapshot, { signal, files: manifests.flatMap(manifest => manifest.chunks) })
        signal?.throwIfAborted()
        messages = await Promise.all(selected.map(async (entry, i) => this.readAt(snapshot, entry, headers[i],
          await readText(this.files, snapshot, headers[i]!.textPath, manifests[i]))))
      } else messages = await Promise.all(selected.map(entry => this.readAt(snapshot, entry)))
      return { messages, processGroups: (index.processGroups ?? []).filter(group => !query.date || new Date(group.startedAt).toISOString().slice(0, 10) === query.date), order: allEntries.map(entry => entry.id),
        ...(start && selected.length ? { moreBefore: selected[0].id } : {}),
        ...(selected.length && end < entries.length ? { moreAfter: selected[selected.length - 1].id } : {}), revision: snapshot.revision }
    }
    // A composite view owns its snapshot until every reader settles. Standalone
    // history/page requests still acquire and release a fresh snapshot here.
    return borrowed ? inspect(borrowed) : withSnapshot(this.files, inspect, { signal, files: [this.indexPath] })
  }
  /** Metadata selects exactly six completed groups and the entire current group;
   * every selected original is read from this same immutable snapshot. No write,
   * signal claim, native-history injection or legacy reply-link guessing occurs. */
  foregroundContext(borrowed?: FilesSnapshot): Promise<ForegroundConversationContext> {
    const inspect = async (snapshot: FilesSnapshot): Promise<ForegroundConversationContext> => {
      if (this.git) return this.git.context(snapshot)
      const index = await contextAt(this.files, snapshot, this.contextPath), selected = selectedContext(index)
      if (selected.some(ref => !ref.path.startsWith('conversations/local/')))
        throw new ConversationRecordError(this.contextPath, 'identity', 'Context points outside Local conversation originals.')
      await this.files.prefetch?.(snapshot, { files: selected.map(ref => ref.path) })
      const headers = await Promise.all(selected.map(ref => this.headerAt(snapshot, ref)))
      await this.files.prefetch?.(snapshot, { files: headers.map(header => logicalReference(header.textPath) + '/manifest.json') })
      const manifests = await Promise.all(headers.map(header => readManifest(this.files, snapshot, header.textPath)))
      await this.files.prefetch?.(snapshot, { files: manifests.flatMap(manifest => manifest.chunks) })
      const messages = await Promise.all(selected.map(async (ref, i) => {
        if (headers[i]!.conversationContext?.position !== ref.position)
          throw new ConversationRecordError(ref.path, 'identity', 'Context original has a different publication identity.')
        return this.readAt(snapshot, ref, headers[i], await readText(this.files, snapshot, headers[i]!.textPath, manifests[i]))
      }))
      return contextResult(index, messages, snapshot.revision)
    }
    return borrowed ? inspect(borrowed) : withSnapshot(this.files, inspect, { files: [this.contextPath] })
  }
  /** Compatibility API shape; grouping still requires authoritative explicit finals. */
  async recentExchanges(): Promise<ConversationExchange[]> {
    const context = await this.foregroundContext(), byId = new Map(context.messages.map(message => [message.id, message]))
    return context.rounds.map(round => {
      const messages = round.messageIds.map(id => byId.get(id)!), humans = messages.filter(message => message.role === 'user')
      return { human: humans[0]!, humans, assistant: byId.get(round.finalId)!, assistants: messages.filter(message => message.role === 'assistant') }
    })
  }
  /** Add to the caller's already-authorized cleanup transaction. */
  async pruneContext(snapshot: FilesSnapshot, messageIds: ReadonlySet<string>): Promise<FileChange[]> {
    const raw = await this.files.read(snapshot, this.contextPath)
    if (raw === undefined) return []
    const previous = parseConversationContext(raw), next = pruneConversationContext(previous, messageIds)
    return json(previous) === json(next) ? [] : [{ path: this.contextPath, content: json(next) }]
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
  /** Discover Foreground signals without reading conversation content. */
  async notificationPaths(snapshot: FilesSnapshot): Promise<string[]> {
    return (await this.files.listDirectory(snapshot, 'state/', { namePrefix: 'Foreground_' }))
      .map(row => row.path)
  }
  /** Consume the notified signal paths before reading current conversation content.
   * The storage CAS preserves concurrent changes outside this consumption. */
  claimForegroundSignals(commandId: string, signalPaths: readonly string[], beforeAttempt?: () => void | Promise<void>): Promise<FileReceipt> {
    const signals = [...new Set(signalPaths.map(path => filePath(path)))].sort()
    if (signals.some(path => !path.startsWith('state/Foreground_'))) return Promise.reject(new Error('Foreground claim requires Foreground signal paths.'))
    return this.transactions.run(this.command(commandId), { scope: this.scope, signals },
      { reevaluate: true, readPlan: { files: signals }, beforeAttempt }, async snapshot => {
        const changes: FileChange[] = []
        for (const path of signals) {
          if (await this.files.read(snapshot, path) !== undefined) changes.push({ path, content: null })
        }
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
/** Original Local storage chunk boundaries. Git stores complete daily records. */
function* textChunkRanges(text: string): Generator<{ start: number; end: number; index: number }> {
  let index = 0
  // Preserve the established UTF-16 chunk length and avoid splitting surrogate pairs.
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 65_536, text.length)
    const last = text.charCodeAt(end - 1)
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--
    yield { start, end, index: index++ }; start = end
  }
}
const textChunkPath = (path: string, index: number) => path + '/parts/' + index.toString().padStart(6, '0') + '.txt'
function textChanges(path: string, text: string, textHash: string): FileChange[] {
  const chunks = Array.from(textChunkRanges(text), ({ start, end, index }) => ({ path: textChunkPath(path, index), content: text.slice(start, end) }))
  return [...chunks, { path: path + '/manifest.json', content: json({ version: 1, sha256: textHash, characters: text.length, chunks: chunks.map(chunk => chunk.path) }) }]
}
interface TextManifest { version: number; sha256: string; characters: number; chunks: string[] }
async function readManifest(files: FilesStore, snapshot: FilesSnapshot, path: string): Promise<TextManifest> {
  path = logicalReference(path)
  filePath(path)
  const raw = await files.read(snapshot, path + '/manifest.json')
  if (raw === undefined) throw new ConversationRecordError(path, 'missing', 'Text manifest is missing.')
  const manifest = JSON.parse(raw) as TextManifest
  if (manifest.version !== 1 || !Array.isArray(manifest.chunks)) throw new ConversationRecordError(path, 'integrity', 'Unsupported text manifest.')
  const chunks = manifest.chunks.map(reference => {
    const chunk = logicalReference(reference)
    filePath(chunk)
    if (!chunk.startsWith(path + '/parts/')) throw new ConversationRecordError(chunk, 'integrity', 'Text chunk is outside its referenced record.')
    return chunk
  })
  return { ...manifest, chunks }
}
interface CheckedText { text: string; sha256: string }
async function readText(files: FilesStore, snapshot: FilesSnapshot, path: string, checked?: TextManifest): Promise<CheckedText> {
  path = logicalReference(path)
  const manifest = checked ?? await readManifest(files, snapshot, path)
  const parts: string[] = []
  for (const chunk of manifest.chunks) {
    const part = await files.read(snapshot, chunk)
    if (part === undefined) throw new ConversationRecordError(chunk, 'missing', 'Text chunk is missing.')
    parts.push(part)
  }
  const text = parts.join(''), sha256 = hash(text)
  if (text.length !== manifest.characters || sha256 !== manifest.sha256) throw new ConversationRecordError(path, 'integrity', 'Text manifest integrity mismatch.')
  // Carry only this read's actual digest; entry and manifest remain independent checks.
  return { text, sha256 }
}

function logicalReference(path: string): string { return path.startsWith('dss-coop/') ? path.slice('dss-coop/'.length) : path }

function sameMessageContent(stored: ConversationMessage, incoming: ConversationMessage, generatedAssistantMetadata: boolean): boolean {
  const business = (message: ConversationMessage) => {
    const { conversationContext: _context, ...original } = message
    if (!generatedAssistantMetadata) return canonical(original)
    // AI tools supply identity and content; Host time/model describe the first
    // accepted publication, not a change to that content on a later tool call.
    const { createdAt: _time, model: _model, modelVersion: _version, ...content } = original
    return canonical(content)
  }
  return json(business(stored)) === json(business(incoming))
}
