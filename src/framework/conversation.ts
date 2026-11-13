import type { StoragePort } from '../contracts/ports.js'
import { publishPreparedPhysicalFile } from './physical-publication-evidence.js'
import { physicalConversationEntryPath } from './local-conversation-paths.js'
import { conversationContextKind, appendConversationContext, emptyConversationContext, parseConversationContext, pruneConversationContext, type ConversationContextIndex, type ConversationContextProvenance, type ConversationResponsePhase } from './conversation-context.js'
import { ConversationAttachments } from './conversation-attachments.js'
import type { ConversationAttachmentReference } from './conversation-attachment-reference.js'
import { createHash } from 'node:crypto'
import type { DshForegroundProcessGroup } from '../adapters/dsh/foreground-process.js'
import { preservePublishedReferences, preservePhysicalPublishedReferences } from './published-references.js'
import { PhysicalLocalFiles } from './physical-local-files.js'
import { FrameworkTransactions, type CommandOptions } from './command-transactions.js'
import { filePath, withSnapshot, type FileChange, type FileReceipt, type FilesSnapshot, type FilesStore } from './transactions.js'

export interface ConversationScope { mode: 'local' | 'git'; collaborationId: string }
/** The native Foreground work ID stays stable; only its Local storage row is
 * partitioned with the same collaboration identity as its conversation. */
export function localForegroundRoleRecordPath(scope: string, collaborationId: string): string {
  return 'framework-runtime/' + hash(scope) + '/roles/' + hash(JSON.stringify(['Foreground', null, null, null]))
    + '-scope-' + localForegroundScopeTag(collaborationId)
}
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
interface IndexedMessage { id: string; path: string; notification?: string; createdAt?: string; role?: ConversationMessage['role']; replyTo?: string }
export interface ConversationProcessGroup extends DshForegroundProcessGroup { participantId: string; afterMessageId?: string }
interface ConversationIndex { version: 1; messages: IndexedMessage[]; processGroups?: ConversationProcessGroup[]; publication?: PhysicalConversationPublication }
/** Only a real unfinished body/metadata → context/index → signal handoff.
 * It is removed after publication, not retained as a command receipt. */
interface PhysicalConversationPublication {
  version: 1
  commandId: string
  entry: ConversationEntry
  context?: ConversationContextIndex
  visible?: true
  notification?: { path: string; stage: string; stageVersion?: string }
}
// Coordinate only this conversation's actual shared index/context. Independent
// message bodies are prepared outside it. No store/Task/Git lane is included.
const physicalConversationIndexes = new Map<string, Promise<void>>()
export function withPhysicalConversationIndex<T>(files: PhysicalLocalFiles, indexPath: string, action: () => Promise<T>): Promise<T> {
  const path = files.directory + '/' + indexPath, key = process.platform === 'win32' ? path.toLowerCase() : path
  const result = (physicalConversationIndexes.get(key) ?? Promise.resolve()).then(action)
  const settled = result.then(() => {}, () => {})
  physicalConversationIndexes.set(key, settled)
  void settled.then(() => { if (physicalConversationIndexes.get(key) === settled) physicalConversationIndexes.delete(key) })
  return result
}
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
/** A Local STATE leaf has the same byte budget as its historical 64-hex
 * message suffix: one non-hex version marker, 124 domain bits, 128 message
 * bits. The username and timestamp stay intact. */
export const localForegroundScopeTag = (collaborationId: string): string => hash('local\0' + collaborationId).slice(0, 31)
export const scopedLocalForegroundNotification = (username: string, date: Date, offsetMinutes: number,
  collaborationId: string, messageId: string): string => 'state/' + foregroundNotification(username, date, offsetMinutes)
    + '-g' + localForegroundScopeTag(collaborationId) + hash('local\0' + collaborationId + '\0' + messageId).slice(0, 32)
/** A pre-physical Local signal need not identify one message: after an earlier
 * claim its timestamp name could be reused. Migration routes that original
 * source identity, not a guessed message ID, into the same domain grammar. */
export const scopedLocalForegroundSourceNotification = (sourcePath: string, collaborationId: string): string =>
  'state/Foreground_Conversation-g' + localForegroundScopeTag(collaborationId)
    + hash('local-source\0' + filePath(sourcePath)).slice(0, 32)
const localConversationSignal = /^state\/Foreground_[^/]+-GMT-?\d+(?:m\d{2})?-\d{8}-\d{9}(?:-(?:[a-f0-9]{64}|g[a-f0-9]{63}))?$/
const scopedLocalSignal = /-g([a-f0-9]{31})[a-f0-9]{32}$/
const scopedLocalSourceSignal = /^state\/Foreground_Conversation-g([a-f0-9]{31})[a-f0-9]{32}$/
export const isLocalConversationSignal = (path: string): boolean => localConversationSignal.test(path) || scopedLocalSourceSignal.test(path)
export const localConversationSignalScopeTag = (path: string): string | undefined =>
  scopedLocalSourceSignal.exec(path)?.[1] ?? (localConversationSignal.test(path) ? scopedLocalSignal.exec(path)?.[1] : undefined)
const oldLocalSignalHash = /-([a-f0-9]{64})$/
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
const segment = (value: string) => { filePath(value); if (value.includes('/')) throw new Error('Identity must be a single path segment.'); return value }
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
    return this.transactions.run(command, { groups, participantId }, { reevaluate: true, gitReplay: 'session-only', readPlan: { files: days.map(day => this.path(day)) } }, async snapshot => {
      const changes: FileChange[] = [];
      for (const day of days) {
        const record = await this.dailyRecord(snapshot, day), messages = record.messages, previous = record.processGroups ?? [];
        const processGroups = mergeProcessGroups(previous, groups.filter(group => new Date(group.startedAt).toISOString().slice(0, 10) === day), participantId, messages.at(-1)?.id);
        if (json(processGroups) !== json(previous)) changes.push({ path: this.path(day), content: json({ version: 1, messages, processGroups }) });
      }
      return changes;
    });
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
    const initialDay = query.live ? query.date ?? this.today() : query.date ?? before?.day ?? after?.day ?? this.today();
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

/** A cold storage-only send can observe the same existing Foreground delivery
 * facts as its Host. Read one known role key, never enumerate conversations or
 * manufacture a signal-consumption receipt. */
export async function physicalForegroundSignalSources(records: Pick<StoragePort, 'get'>, scope: string,
  path: string, collaborationId?: string): Promise<readonly { path: string; version: string }[]> {
  if (!path.startsWith('state/Foreground_') || path.slice('state/'.length).includes('/')) return []
  type Source = { path: string; version: string }
  const row = await records.get<{
    delivery?: { request: { sources?: Source[] } }
    lastWake?: { sources?: Source[] }
    notificationClaims?: Record<string, { sources: Source[] }>
  }>(collaborationId === undefined ? 'framework-runtime/' + hash(scope) + '/roles/' + hash(JSON.stringify(['Foreground', null, null, null]))
    : localForegroundRoleRecordPath(scope, collaborationId))
  return [...row?.delivery?.request.sources ?? [], ...row?.lastWake?.sources ?? [],
    ...Object.values(row?.notificationClaims ?? {}).flatMap(claim => claim.sources)].filter(source => source.path === path)
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
  constructor(readonly files: FilesStore, readonly transactions: FrameworkTransactions, readonly scope: ConversationScope,
    private readonly signalSources?: (path: string) => Promise<readonly { path: string; version: string }[]>,
    private readonly restoreOriginals?: () => Promise<void>) {
    this.attachments = new ConversationAttachments(files, transactions, scope)
    const key = encodeURIComponent(segment(scope.collaborationId))
    this.localIndexPath = 'conversation-index/local/' + key + '/index.json'
    this.contextPath = contextPath(scope)
    if (scope.mode === 'git') this.git = new GitDailyConversation(files, transactions, scope)
    this.foregroundRoot = 'assistants/collaborations/' + scope.mode + '/' + key
  }
  private originalPreparation?: Promise<void>
  private oldSignals?: { seen: Set<string>; owned: Set<string>; refresh?: Promise<void> }
  /** STATE is shared by Local collaborations. New conversation signals carry
   * their owner in the unchanged filename budget. An earlier physical signal
   * can be adopted only when this conversation's original index names its
   * exact path and its original message ID proves that historical name. No
   * other conversation is searched and unproven old signals stay intact. */
  async routeForegroundSignals<T extends { path: string }>(sources: readonly T[]): Promise<T[]> {
    if (this.scope.mode !== 'local') return [...sources]
    const tag = localForegroundScopeTag(this.scope.collaborationId)
    const old = sources.filter(source => localConversationSignal.test(source.path)
      && !scopedLocalSignal.test(source.path) && oldLocalSignalHash.test(source.path))
    let owned: Set<string> | undefined
    if (old.length && this.files instanceof PhysicalLocalFiles) {
      const state = this.oldSignals ??= { seen: new Set(), owned: new Set() }
      while (old.some(source => !state.seen.has(source.path))) {
        if (!state.refresh) {
          const unseen = old.filter(source => !state.seen.has(source.path))
          // Physical publication indexes a message before its STATE handoff.
          // This runtime's new sends cannot add an older-style path. Revisit
          // one current index only if a distinct older path actually appears.
          const refresh = withSnapshot(this.files, snapshot => this.index(snapshot)).then(rows => {
            const paths = new Set(rows.messages.filter(row => row.notification
              && row.notification.endsWith('-' + hash('local\0' + this.scope.collaborationId + '\0' + row.id)))
              .map(row => row.notification!))
            for (const source of unseen) {
              state.seen.add(source.path)
              if (paths.has(source.path)) state.owned.add(source.path)
            }
          })
          state.refresh = refresh
          void refresh.finally(() => { if (state.refresh === refresh) state.refresh = undefined }).catch(() => {})
        }
        await state.refresh
      }
      owned = state.owned
    }
    return sources.filter(source => {
      const imported = scopedLocalSourceSignal.exec(source.path)
      if (imported) return imported[1] === tag
      if (!localConversationSignal.test(source.path)) return true
      const scoped = scopedLocalSignal.exec(source.path)
      if (scoped) return scoped[1] === tag
      return !!oldLocalSignalHash.test(source.path) && !!owned?.has(source.path)
    })
  }
  /** One addressed SQL-to-physical conversion, shared by this scope's callers.
   * Successful preparation retires from this handle; failures can resume its
   * existing source operation. It never waits for another conversation or Task. */
  prepare(): Promise<void> {
    if (!(this.files instanceof PhysicalLocalFiles) || !this.restoreOriginals) return Promise.resolve()
    if (!this.originalPreparation) {
      const work = Promise.resolve().then(() => this.restoreOriginals!())
      this.originalPreparation = work
      void work.catch(() => { if (this.originalPreparation === work) this.originalPreparation = undefined })
    }
    return this.originalPreparation
  }
  private async index(snapshot: FilesSnapshot): Promise<ConversationIndex> {
    const value = await this.files.read(snapshot, this.indexPath)
    return value === undefined ? emptyIndex() : JSON.parse(value) as ConversationIndex
  }
  /** Reset selects native group IDs from the same Local index as page(),
   * without opening an unrelated message body that the user may have removed. */
  async processGroupsForForegroundReset(): Promise<ConversationProcessGroup[]> {
    await this.prepare()
    if (!(this.files instanceof PhysicalLocalFiles) || this.scope.mode !== 'local')
      throw new Error('Foreground reset process groups require physical Local records.')
    return withSnapshot(this.files, async snapshot => (await this.index(snapshot)).processGroups ?? [])
  }
  private command(id: string): string { return 'conversation/' + this.scope.mode + '/' + this.scope.collaborationId + '/' + id }
  /** Store only closed native presentation metadata in the existing conversation
   * record. This is not a message, notification, acknowledgment or completion gate. */
  async saveProcessGroups(commandId: string, groups: readonly DshForegroundProcessGroup[], participantId: string): Promise<FileReceipt> {
    await this.prepare()
    const command = this.command('process/' + commandId + '/' + hash(json(groups)))
    if (this.git) return this.git.saveProcessGroups(command, groups, participantId)
    if (this.files instanceof PhysicalLocalFiles) {
      const files = this.files
      return withPhysicalConversationIndex(files, this.indexPath, () => withSnapshot(files, async snapshot => {
        const index = await this.index(snapshot)
        await this.publishPhysical(files, snapshot, index)
        const previous = index.processGroups ?? []
        const processGroups = mergeProcessGroups(previous, groups, participantId, index.messages.at(-1)?.id)
        if (json(previous) !== json(processGroups)) await files.replace(this.indexPath, json({ ...index, processGroups }))
        return { revision: snapshot.revision, replay: json(previous) === json(processGroups) }
      }))
    }
    throw new Error('Original conversation views are read-only.')
  }
  /** The caller retains the original draft/id until the receipt is confirmed.
   * No UI AbortSignal is accepted: closing a view does not revoke a durable send.
   */
  async send(commandId: string, message: ConversationSend, options: CommandOptions = {}, commandInput?: unknown, beforeAppend?: (snapshot: FilesSnapshot) => Promise<void>): Promise<FileReceipt> {
    await this.prepare()
    const date = new Date(message.createdAt)
    if (!Number.isFinite(date.getTime())) return Promise.reject(new Error('Message createdAt must be a valid timestamp.'))
    if (this.git) return this.git.send(this.command(commandId), message, options, commandInput, beforeAppend)
    if (this.files instanceof PhysicalLocalFiles) return this.sendPhysical(this.files, commandId, message, options, commandInput, beforeAppend)
    throw new Error('Original conversation views are read-only.')
  }
  /** Resume only the actual handoff named by this conversation's index. The
   * existing startup path calls this; no directory scan or new worker exists. */
  resumePhysicalPublication(): Promise<void> {
    if (!(this.files instanceof PhysicalLocalFiles)) return Promise.resolve()
    return this.withPhysicalPublication(async () => {})
  }
  /** The actual shared conversation boundary for publication or an explicitly
   * requested cleanup. It settles only this index's known unfinished handoff. */
  async withPhysicalPublication<T>(action: (snapshot: FilesSnapshot) => Promise<T>): Promise<T> {
    await this.prepare()
    if (!(this.files instanceof PhysicalLocalFiles)) throw new Error('Physical conversation publication requires its physical files.')
    const files = this.files
    return withPhysicalConversationIndex(files, this.indexPath, () => withSnapshot(files, async snapshot => {
      await this.publishPhysical(files, snapshot, await this.index(snapshot))
      return action(snapshot)
    }))
  }
  private async sendPhysical(files: PhysicalLocalFiles, commandId: string, message: ConversationSend,
    options: CommandOptions, commandInput: unknown, beforeAppend?: (snapshot: FilesSnapshot) => Promise<void>): Promise<FileReceipt> {
    const { text, username: _name, timezoneOffsetMinutes: _offset, conversationContext: _untrusted, ...fields } = message as ConversationSend & Pick<ConversationMessage, 'conversationContext'>
    const generated = commandInput !== undefined && message.role === 'assistant'
    const key = encodeURIComponent(segment(this.scope.collaborationId)), identity = hash(message.id)
    if (!message.id) throw new Error('Message identity must not be empty.')
    // The original metadata is itself the stable message identity. Keeping its
    // locator independent of Host-generated retry timestamps avoids a receipt or
    // a scan to find an interrupted first attempt. Bodies remain date-organized.
    const path = physicalConversationEntryPath(this.scope.collaborationId, message.id)
    await withSnapshot(files, async snapshot => {
      await options.beforeAttempt?.()
      const prior = (await this.index(snapshot)).messages.find(row => row.id === message.id)
      if (prior) {
        if (!await this.samePhysicalSubmission(snapshot, prior, { ...fields, text }, generated))
          throw new ConversationRecordError(prior.path, 'identity', 'Message identity already has different content.')
        return
      }
      await beforeAppend?.(snapshot)
      await this.attachments.validateReferences(snapshot, message.attachments)
      const date = new Date(message.createdAt).toISOString().slice(0, 10)
      const textPath = 'conversations/local/' + key + '/' + segment(message.participantId) + '/' + date + '/message-' + identity + '.txt'
      const original: ConversationEntry = { ...fields, collaborationId: this.scope.collaborationId, textPath, textHash: hash(text) }
      const createdEntry = await files.createIfAbsent(path, json(original))
      // This call already owns the bytes of a confirmed new file. Only an
      // existing identity needs read-back to reconcile an earlier attempt.
      const entry = createdEntry ? original : await this.headerAt(snapshot, { id: message.id, path })
      if (!createdEntry) {
        const { collaborationId: _scope, textPath: _path, textHash, ...stored } = entry
        if (textHash !== hash(text) || !sameMessageContent({ ...stored, text }, { ...fields, text }, generated))
          throw new ConversationRecordError(path, 'identity', 'Message identity already has different content.')
      }
      const createdBody = await files.createIfAbsent(entry.textPath, text)
      if (!createdBody) await this.readAt(snapshot, { id: message.id, path }, entry)
      if (message.role === 'assistant') await preservePhysicalPublishedReferences(files, snapshot, text)
    })
    return withPhysicalConversationIndex(files, this.indexPath, () => withSnapshot(files, async snapshot => {
      const index = await this.index(snapshot)
      await this.publishPhysical(files, snapshot, index)
      const prior = index.messages.find(row => row.id === message.id)
      if (prior) {
        if (!await this.samePhysicalSubmission(snapshot, prior, { ...fields, text }, generated))
          throw new ConversationRecordError(prior.path, 'identity', 'Message identity already has different content.')
        return { revision: snapshot.revision, replay: true }
      }
      await options.beforeAttempt?.()
      await beforeAppend?.(snapshot)
      const entry = await this.headerAt(snapshot, { id: message.id, path })
      const previous = conversationContextKind(entry) ? await contextAt(files, snapshot, this.contextPath) : emptyConversationContext()
      const context = appendConversationContext(previous, entry, path)
      const publication: PhysicalConversationPublication = { version: 1, commandId: this.command(commandId),
        entry: { ...entry, ...(context.provenance ? { conversationContext: context.provenance } : {}) },
        ...(context.index !== previous ? { context: context.index } : {}) }
      if (entry.role === 'user' && entry.recipient === 'ai') {
        // Independent chat indexes may publish at the same username/millisecond.
        // The existing signal name retains its timestamp plus exact message
        // identity; no shared global name reservation or overwrite is needed.
        const notification = scopedLocalForegroundNotification(message.username ?? entry.participantId,
          new Date(entry.createdAt), message.timezoneOffsetMinutes ?? 0, this.scope.collaborationId, entry.id)
        publication.notification = { path: notification, stage: path + '.notification' }
      }
      index.publication = publication
      await files.replace(this.indexPath, json(index))
      await this.publishPhysical(files, snapshot, index, options.beforeAttempt)
      return { revision: snapshot.revision, replay: false }
    }))
  }
  private async publishPhysical(files: PhysicalLocalFiles, snapshot: FilesSnapshot, index: ConversationIndex,
    beforeAttempt?: () => void | Promise<void>): Promise<void> {
    const pending = index.publication
    if (!pending) return
    if (pending.version !== 1 || pending.entry.collaborationId !== this.scope.collaborationId)
      throw new ConversationRecordError(this.indexPath, 'identity', 'Unfinished publication belongs to another conversation.')
    const expected = pending.entry, path = 'conversations/local/' + encodeURIComponent(segment(this.scope.collaborationId)) + '/messages/message-' + hash(expected.id) + '/entry.json'
    const current = await this.readAt(snapshot, { id: expected.id, path })
    const { collaborationId: _scope, textPath: _textPath, textHash: _hash, ...expectedMessage } = expected
    if (!sameMessageContent(current, { ...expectedMessage, text: current.text }, false))
      throw new ConversationRecordError(path, 'identity', 'Unfinished publication no longer matches its original message.')
    const signal = pending.notification
    if (signal && !signal.stageVersion) {
      await beforeAttempt?.()
      await files.createIfAbsent(signal.stage, '')
      const staged = await files.fileInfo(signal.stage)
      if (!staged) throw new ConversationRecordError(signal.stage, 'missing', 'The prepared notification is unavailable.')
      signal.stageVersion = staged.version
      await files.replace(this.indexPath, json(index))
    }
    if (!pending.visible) {
      await beforeAttempt?.()
      // Provenance describes this exact publication position. Originals are
      // complete before either the context or history index can expose them.
      await files.replace(path, json(expected))
      if (pending.context) await files.replace(this.contextPath, json(pending.context))
      const prior = index.messages.find(row => row.id === expected.id)
      if (prior && prior.path !== path) throw new ConversationRecordError(path, 'identity', 'Message identity is already indexed at another path.')
      if (!prior) index.messages.push({ id: expected.id, path, createdAt: expected.createdAt, role: expected.role, ...(expected.replyTo ? { replyTo: expected.replyTo } : {}), ...(signal ? { notification: signal.path } : {}) })
      pending.visible = true
      await files.replace(this.indexPath, json(index))
    }
    // A missing stage alone says nothing. This exact pending handoff must also
    // have durable body/metadata, its indexed identity and its context position.
    if (!index.messages.some(row => row.id === expected.id && row.path === path))
      throw new ConversationRecordError(this.indexPath, 'identity', 'Published message is absent from its index.')
    if (pending.context && json(await contextAt(files, snapshot, this.contextPath)) !== json(pending.context))
      throw new ConversationRecordError(this.contextPath, 'identity', 'Unfinished publication context changed before its signal handoff.')
    const published = await this.headerAt(snapshot, { id: expected.id, path })
    if (json(published.conversationContext) !== json(expected.conversationContext))
      throw new ConversationRecordError(path, 'identity', 'Published original has a different context identity.')
    if (signal) {
      await beforeAttempt?.()
      // An interrupted rename is proved only by this actual file identity or
      // the receiver's existing accepted source. Absence is not success.
      await publishPreparedPhysicalFile(files, signal.stage, signal.path, signal.stageVersion!,
        this.signalSources ? () => this.signalSources!(signal.path) : undefined)
    }
    delete index.publication
    await files.replace(this.indexPath, json(index))
  }
  private async samePhysicalSubmission(snapshot: FilesSnapshot, indexed: IndexedMessage, incoming: ConversationMessage, generated: boolean): Promise<boolean> {
    const entry = await this.headerAt(snapshot, indexed)
    const { collaborationId: _scope, textPath: _path, textHash, ...original } = entry
    // This identifies the original send, not the current physical document.
    // A later ordinary file edit is never reverted by replaying that send.
    return textHash === hash(incoming.text) && sameMessageContent({ ...original, text: incoming.text }, incoming, generated)
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
    if (!(this.files instanceof PhysicalLocalFiles) && entry.textHash !== undefined && sha256 !== entry.textHash) throw new ConversationRecordError(entry.textPath, 'integrity', 'Message body hash differs from entry.')
    const { collaborationId: _scope, textPath: _path, textHash: _hash, ...body } = entry
    const writer = (entry as ConversationEntry & { writer?: { participantId?: string } }).writer
    return { ...body, ...(body.participantId ? {} : writer?.participantId ? { participantId: writer.participantId } : {}), text }
  }
  async read(messageId: string): Promise<ConversationMessage | undefined> {
    await this.prepare()
    if (this.git) return this.git.read(messageId)
    return withSnapshot(this.files, async snapshot => {
      const entry = (await this.index(snapshot)).messages.find(entry => entry.id === messageId)
      return entry ? this.readAt(snapshot, entry) : undefined
    })
  }
  /** Explicit search over full originals; excerpts and page sizes do not truncate storage. */
  async search(query: string, cursor = 0, limit = 10) {
    await this.prepare()
    if (!query.trim() || !Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1)
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
  async readText(ref: string, cursor = 0, limit = 32768) {
    await this.prepare()
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1)
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
  async page(limit: number, beforeId?: string, query: { afterId?: string; date?: string; live?: boolean; missingBodies?: 'report' } = {}, borrowed?: FilesSnapshot, signal?: AbortSignal): Promise<{ messages: ConversationMessage[]; processGroups: ConversationProcessGroup[]; moreBefore?: string; moreAfter?: string; revision: string; order: string[]; selectedIds?: string[]; missingBodies?: Array<{ id: string; path: string }>; reset?: boolean; day?: string; cursor?: string }> {
    await this.prepare()
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
      let missingBodies: Array<{ id: string; path: string }> = []
      if (this.files.prefetch && selected.length && !(this.files instanceof PhysicalLocalFiles)) {
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
      } else if (query.missingBodies === 'report' && this.files instanceof PhysicalLocalFiles) {
        // UI pages keep the authoritative index/cursors and the other real
        // bodies. A missing Local .txt is reported, never revived from SQL or
        // represented as invented message text. Other read failures stay exact.
        const headers = await Promise.all(selected.map(entry => this.headerAt(snapshot, entry)))
        const rows = await Promise.all(selected.map(async (entry, i) => {
          const header = headers[i]!
          if (!header.textPath.endsWith('.txt')) return { message: await this.readAt(snapshot, entry, header) }
          try { return { message: await this.readAt(snapshot, entry, header) } }
          catch (error) {
            if (error instanceof ConversationRecordError && error.reason === 'missing' && error.path === logicalReference(header.textPath))
              return { missing: { id: entry.id, path: header.textPath } }
            throw error
          }
        }))
        messages = rows.flatMap(row => row.message ? [row.message] : [])
        missingBodies = rows.flatMap(row => row.missing ? [row.missing] : [])
      } else messages = await Promise.all(selected.map(entry => this.readAt(snapshot, entry)))
      return { messages, processGroups: (index.processGroups ?? []).filter(group => !query.date || new Date(group.startedAt).toISOString().slice(0, 10) === query.date), order: allEntries.map(entry => entry.id),
        ...(query.missingBodies === 'report' ? { selectedIds: selected.map(entry => entry.id), missingBodies } : {}),
        ...(start && selected.length ? { moreBefore: selected[0].id } : {}),
        ...(selected.length && end < entries.length ? { moreAfter: selected[selected.length - 1].id } : {}), revision: snapshot.revision }
    }
    // A composite view owns its snapshot until every reader settles. Standalone
    // history/page requests still acquire and release a fresh snapshot here.
    return borrowed ? inspect(borrowed) : withSnapshot(this.files, inspect, { signal, files: [this.indexPath] })
  }
  /** Metadata selects exactly six completed groups and the entire current group.
   * After one-time source preparation, physical Local reads actual requested files;
   * Git/SQLite use their snapshot. No normal write,
   * signal claim, native-history injection or legacy reply-link guessing occurs. */
  async foregroundContext(borrowed?: FilesSnapshot): Promise<ForegroundConversationContext> {
    await this.prepare()
    const inspect = async (snapshot: FilesSnapshot): Promise<ForegroundConversationContext> => {
      if (this.git) return this.git.context(snapshot)
      const index = await contextAt(this.files, snapshot, this.contextPath), selected = selectedContext(index)
      if (selected.some(ref => !ref.path.startsWith('conversations/local/')))
        throw new ConversationRecordError(this.contextPath, 'identity', 'Context points outside Local conversation originals.')
      await this.files.prefetch?.(snapshot, { files: selected.map(ref => ref.path) })
      const headers = await Promise.all(selected.map(ref => this.headerAt(snapshot, ref)))
      const messages = await Promise.all(selected.map(async (ref, i) => {
        // The context index selects this conversation's ordered groups. Local
        // entry provenance is an editable, redundant publication annotation,
        // not a version lock on the addressed original. headerAt still checks
        // the exact message ID and collaboration before reading its body.
        if (!(this.files instanceof PhysicalLocalFiles) && headers[i]!.conversationContext?.position !== ref.position)
          throw new ConversationRecordError(ref.path, 'identity', 'Context original has a different publication identity.')
        return this.readAt(snapshot, ref, headers[i])
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
    await this.prepare()
    const raw = await this.files.read(snapshot, this.contextPath)
    if (raw === undefined) return []
    const previous = parseConversationContext(raw), next = pruneConversationContext(previous, messageIds)
    return json(previous) === json(next) ? [] : [{ path: this.contextPath, content: json(next) }]
  }
  async readForeground(): Promise<ForegroundMemory> {
    await this.prepare()
    return withSnapshot(this.files, async snapshot => ({
      list: await this.files.read(snapshot, this.foregroundRoot + '/Foreground_List.md') ?? '',
      cache: await this.files.read(snapshot, this.foregroundRoot + '/Foreground_Cache.md') ?? '',
    }))
  }
  private memoryChanges(memory: ForegroundMemory): FileChange[] {
    return [{ path: this.foregroundRoot + '/Foreground_List.md', content: memory.list }, { path: this.foregroundRoot + '/Foreground_Cache.md', content: memory.cache }]
  }
  async writeForeground(commandId: string, memory: ForegroundMemory, options: CommandOptions = {}): Promise<FileReceipt> {
    await this.prepare()
    if (this.files instanceof PhysicalLocalFiles) {
      const files = this.files
      return withSnapshot(files, async snapshot => {
        await options.beforeAttempt?.()
        // These are independent ordinary user records, not a paired transaction.
        await Promise.all([files.replace(this.foregroundRoot + '/Foreground_List.md', memory.list),
          files.replace(this.foregroundRoot + '/Foreground_Cache.md', memory.cache)])
        return { revision: snapshot.revision, replay: false }
      })
    }
    return this.transactions.run(this.command(commandId), { scope: this.scope, memory }, options, async () => this.memoryChanges(memory))
  }
  /** Discover Foreground signals without reading conversation content. */
  async notificationPaths(snapshot: FilesSnapshot): Promise<string[]> {
    return (await this.routeForegroundSignals(await this.files.listDirectory(snapshot, 'state/', { namePrefix: 'Foreground_' })))
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
interface CheckedText { text: string; sha256?: string }
async function readText(files: FilesStore, snapshot: FilesSnapshot, path: string, checked?: TextManifest): Promise<CheckedText> {
  path = logicalReference(path)
  if (path.endsWith('.txt')) {
    const bytes = await files.readBytes(snapshot, path)
    if (bytes === undefined) throw new ConversationRecordError(path, 'missing', 'Original message text is missing.')
    // A leading U+FEFF is original message content, not JSON framing. Physical
    // text edits and exact old-body conversion must retain it in every read port.
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    return { text, ...(files instanceof PhysicalLocalFiles ? {} : { sha256: hash(text) }) }
  }
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
