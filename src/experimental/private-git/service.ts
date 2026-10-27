import { randomUUID } from 'node:crypto'
import type { ModeEndpoint } from '../../mode-router/mode-router.js'
import { CoopSettingsSchema, type CoopView, type GitChangeNotice, type GitSnapshot, type PendingDraft, type RepoBinding, type UserIntent } from './contracts.js'
import type { CoopStore } from './cache.js'
import { CoopCredentials } from './credentials.js'
import { GitHubClient, GitHubMembers, repositoryPath } from './github.js'
import { GitHubRepository } from './git-repository.js'
import { conversationPage } from './conversation.js'
import { childDirectories, loadPaths } from './repository-paths.js'
import { readIntent } from './intake.js'
import { isProtocolPath, recordPublished } from './outcome.js'
import type { RootTask } from './protocol.js'
import { releaseScopeCaches, type ConsumedInput, type CacheCleanupResult } from './cache-cleanup.js'
import { GitJournal, digest, json, readJson, readText, segment, textChanges } from './journal.js'

export interface GitConsumer { consume(snapshot: GitSnapshot): Promise<void>; notifyChanges?(notice: GitChangeNotice): Promise<void>; hasWork?(): boolean; dispose(): Promise<void>; writer?: { retryDrafts(): Promise<void> }; retryNative?(): Promise<void> }

/** The Coop endpoint has no Local application, prompt, Task or Agent imports. */
export class CoopService implements ModeEndpoint {
  readonly repository: GitHubRepository
  readonly members: GitHubMembers
  private journal?: GitJournal
  private consumer?: GitConsumer
  private error?: string
  private cleanupError?: string
  private reportCleanup(result: CacheCleanupResult): void {
    if (!result.failed.length) return
    const message = JSON.stringify({ count: result.failed.length, first: result.failed.slice(0, 5) })
    if (message !== this.cleanupError) console.error('deepseek-servant scope cache cleanup', message)
    this.cleanupError = message
  }
  private syncing?: Promise<void>
  private latestSnapshot?: GitSnapshot
  private consumedHead?: string
  private disposed = false
  private generation = 0
  private configuration: Promise<unknown> = Promise.resolve()
  private serialConfiguration<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.configuration.then(operation)
    this.configuration = result.catch(() => {})
    return result
  }
  private current(generation: number): void {
    if (this.disposed || generation !== this.generation) throw new Error('The Git operation ended because its context changed.')
  }
  private wake: () => void = () => {}
  private stopSync: () => void = () => {}
  setWake(wake: () => void, stop: () => void): void { this.wake = wake; this.stopSync = stop }
  private readonly listeners = new Set<() => void>()
  constructor(readonly cache: CoopStore, readonly credentials: CoopCredentials, private readonly client: GitHubClient, private readonly defaultModel: () => CoopView['defaultModel'] = () => undefined) {
    const binding = (): RepoBinding => {
      const connection = cache.connection()
      return { ownerRepo: cache.settings.ownerRepo, repositoryId: connection?.repository.id, participantId: connection?.identity.id, branch: connection?.repository.branch, repositoryDirectory: cache.settings.repositoryDirectory, instanceId: cache.instanceId }
    }
    this.repository = new GitHubRepository(client, binding, () => credentials.resolve())
    this.members = new GitHubMembers(client, binding)
  }
  attach(consumer: GitConsumer): void { this.consumer = consumer }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  changed(): void { for (const listener of this.listeners) { try { listener() } catch (error) { console.error('deepseek-servant observer', error) } } }
  getJournal(): GitJournal {
    const connection = this.cache.connection()
    if (!connection) throw new Error('Connect a private collaboration repository first.')
    return this.journal ??= new GitJournal(this.repository, String(connection.identity.id))
  }
  async connect(): Promise<unknown> {
    repositoryPath(this.cache.settings.ownerRepo)
    const generation = this.generation
    try {
      const connection = await this.repository.connect()
      await this.serialConfiguration(async () => {
      this.current(generation)
      const previous = this.cache.connection()
      if (previous && previous.identity.id !== connection.identity.id && (this.cache.drafts().length || this.cache.entries('physical/').length || (this.cache.get<number>('pending-tasks') ?? 0) > 0)) throw new Error('Finish or cancel this account’s pending work before connecting another GitHub account.')
      if (previous && (previous.identity.id !== connection.identity.id || previous.repository.id !== connection.repository.id)) {
        this.reportCleanup(await releaseScopeCaches(this.cache))
      }
      await this.cache.put('connection', connection)
      if (connection.repository.fullName !== this.cache.settings.ownerRepo) await this.cache.configure({ ...this.cache.settings, ownerRepo: connection.repository.fullName })
      this.journal = new GitJournal(this.repository, String(connection.identity.id))
      this.error = undefined
      await this.consumer?.retryNative?.()
      })
      await this.sync()
      this.wake()
      return connection
    } catch (error) { if (!this.disposed && generation === this.generation) this.error = error instanceof Error ? error.message : String(error); throw error }
    finally { this.changed() }
  }
  async configure(params: Record<string, unknown>): Promise<unknown> {
    return this.serialConfiguration(async () => {
    const settings = CoopSettingsSchema.parse({ ...this.cache.settings, ...params })
    if (settings.ownerRepo) settings.ownerRepo = repositoryPath(settings.ownerRepo).slice('/repos/'.length)
    const moving = settings.ownerRepo !== this.cache.settings.ownerRepo || settings.repositoryDirectory !== this.cache.settings.repositoryDirectory
    if (moving && (this.cache.drafts().length || this.cache.entries('physical/').length || (this.cache.get<number>('pending-tasks') ?? 0) > 0)) throw new Error('Finish or cancel this repository’s pending work before changing repositories.')
    ++this.generation
    if (moving || settings.tokenRef !== this.cache.settings.tokenRef) { this.client.cancel(); this.repository.cancel?.() }
    if (moving) {
      await this.syncing?.catch(() => {})
      await this.repository.releaseCache?.()
      this.reportCleanup(await releaseScopeCaches(this.cache))
    }
    await this.cache.configure(settings)
    if (moving) {
      await this.cache.remove('connection'); this.journal = undefined; this.latestSnapshot = undefined; this.consumedHead = undefined
    }
    await this.consumer?.retryNative?.()
    this.changed(); this.wake()
    return settings
    })
  }
  sync(): Promise<void> {
    if (this.syncing) return this.syncing
    const generation = this.generation
    const run = async () => {
      try {
        if (!this.cache.connection() || this.disposed) return
        this.current(generation)
        await this.publishSettings()
        this.current(generation)
        await this.retryInputs()
        this.current(generation)
        await this.consumer?.writer?.retryDrafts()
        this.current(generation)
        let snapshot = await this.repository.snapshot()
        if (this.cache.settings.remoteEnabled) {
          let from = this.cache.get<string>('watch-head')
          if (from === undefined) from = (await readJson<{ head: string }>(this.repository, snapshot, 'dss-coop/instances/' + this.cache.instanceId + '/watch.json'))?.head ?? ''
          const changes = (await this.repository.changes(snapshot, from, this.cache.instanceId)).filter(change => !isProtocolPath(change.path))
          if (changes.length) {
            await this.consumer?.notifyChanges?.({ from, to: snapshot.head, changes })
            await this.cache.put('watch-head', snapshot.head)
            snapshot = await this.repository.snapshot()
          } else await this.cache.put('watch-head', snapshot.head)
        }
        this.latestSnapshot = snapshot
        this.current(generation)
        await this.cache.put('confirmed-head', snapshot.head)
        this.error = undefined
        if (this.consumedHead !== snapshot.head || this.consumer?.hasWork?.()) {
          await this.consumer?.consume(snapshot)
          this.consumedHead = snapshot.head
        }
      } catch (error) { if (!this.disposed && generation === this.generation) this.error = error instanceof Error ? error.message : String(error); throw error }
      finally { this.changed() }
    }
    this.syncing = run().finally(() => { this.syncing = undefined })
    return this.syncing
  }
  async send(params: Record<string, unknown>): Promise<unknown> {
    const text = typeof params.text === 'string' ? params.text : ''
    if (!text.trim()) throw new Error('Enter a message.')
    const connection = this.cache.connection()
    if (!connection) throw new Error('Connect a private collaboration repository before sending.')
    const id = typeof params.id === 'string' ? segment(params.id) : randomUUID()
    const snapshot = await this.repository.snapshot()
    const committed = await readIntent(this.repository, snapshot, String(connection.identity.id), id)
    if (committed) {
      if (committed.text !== text) throw new Error('A message identity was reused with different text.')
      this.wake()
      return { id, state: 'CONFIRMED', commit: snapshot.head }
    }
    const existing = this.cache.get<UserIntent>('user-source/' + id)
    if (existing && existing.text !== text) throw new Error('A message identity was reused with different text.')
    const intent: UserIntent = existing ?? { id, participantId: String(connection.identity.id), instanceId: this.cache.instanceId, text, createdAt: new Date().toISOString() }
    await this.cache.put('user-source/' + id, intent)
    const draft: PendingDraft = { id, kind: 'user-input', createdAt: intent.createdAt, state: 'PENDING_UNCOMMITTED', payload: intent }
    await this.cache.put('draft/' + id, draft)
    await this.consumer?.retryNative?.()
    try {
      await this.publishInput(intent)
    } catch (error) {
      await this.cache.put('draft/' + id, { ...draft, error: error instanceof Error ? error.message : String(error) })
      this.changed(); this.wake()
      return { id, state: 'PENDING_UNCOMMITTED', error: error instanceof Error ? error.message : String(error) }
    }
    try {
      await this.sync()
      return { id, state: 'CONFIRMED', commit: this.cache.get<{ confirmedHead: string }>('projection')?.confirmedHead }
    } catch (error) {
      return { id, state: 'COMMITTED_PENDING_READ', commit: this.cache.get<{ commit: string }>('user-confirmed/' + id)?.commit, error: error instanceof Error ? error.message : String(error) }
    }
  }
  private async publishInput(intent: UserIntent): Promise<void> {
    const root = 'dss-coop/conversations/' + intent.participantId + '/' + intent.createdAt.slice(0, 10) + '/' + intent.createdAt.replace(/\D/g, '') + '-' + intent.id
    const entry = { ...intent, text: undefined, role: 'user', textPath: root + '/text', textHash: digest(intent.text) }
    const receipt = await this.getJournal().transact('input-' + intent.id, intent, async snapshot => [
      ...await this.getJournal().immutable(snapshot, root + '/entry.json', json(entry)),
      ...textChanges(root + '/text', intent.text),
      { path: 'dss-coop/intents/' + intent.participantId + '/' + intent.id + '.json', content: json({ ...entry, conversationPath: root + '/entry.json' }) },
      { path: 'dss-coop/participants/' + intent.participantId + '/profile.json', content: json(this.cache.connection()!.identity) },
    ])
    await this.cache.put('user-confirmed/' + intent.id, { commit: receipt.commit, textHash: digest(intent.text), participantId: intent.participantId })
    await this.cache.remove('draft/' + intent.id)
  }
  private async publishSettings(): Promise<void> {
    const connection = this.cache.connection()!
    const settings = this.cache.settings
    const record = { instanceId: this.cache.instanceId, participantId: String(connection.identity.id), workerSeats: settings.workerSeats,
      presetId: settings.presetId, provider: settings.provider || undefined, model: settings.model || undefined, reasoningEffort: settings.reasoningEffort || undefined }
    const hash = digest(json(record))
    if (this.cache.get<string>('settings-confirmed') === hash) return
    const prior = this.cache.get<{ hash: string; id: string }>('settings-write')
    const pending = prior?.hash === hash ? prior : { hash, id: 'settings-' + randomUUID() }
    await this.cache.put('settings-write', pending)
    await this.getJournal().transact(pending.id, record, async () => [
      { path: 'dss-coop/instances/' + this.cache.instanceId + '/status.json', content: json(record) },
      { path: 'dss-coop/participants/' + connection.identity.id + '/profile.json', content: json(connection.identity) },
      { path: 'dss-coop/assistants/' + connection.identity.id + '/' + this.cache.instanceId + '/identity.json',
        content: json({ participantId: String(connection.identity.id), instanceId: this.cache.instanceId, mode: 'PRIVATE_GIT_EXPERIMENTAL' }) },
    ])
    await this.cache.put('settings-confirmed', hash)
    await this.cache.remove('settings-write')
  }
  private async retryInputs(): Promise<void> {
    for (const draft of this.cache.drafts()) if (draft.kind === 'user-input') await this.publishInput(draft.payload as UserIntent)
  }
  private async refreshProjection(): Promise<void> {
    const snapshot = this.latestSnapshot
    if (!snapshot || this.cache.get<{ confirmedHead: string }>('projection')?.confirmedHead === snapshot.head) return
    const participant = String(this.cache.connection()!.identity.id)
    const { messages, moreBefore } = await conversationPage(this.repository, this.cache, snapshot, participant)
    const tasks: CoopView['tasks'] = []
    for (const directory of await childDirectories(this.repository, snapshot, 'dss-coop/tasks/')) {
      const path = directory + 'contract.json'
      try {
        const task = await readJson<RootTask>(this.repository, snapshot, path)
        if (task) tasks.push({ id: task.id, title: task.title, coordinator: task.coordinatorParticipantId,
          status: task.status === 'accepted' && !await recordPublished(this.repository, snapshot, task.writer) ? 'active' : task.status })
        await this.cache.remove('read-error/' + path)
      } catch (error) { await this.cache.put('read-error/' + path, String(error)) }
    }
    await loadPaths(this.repository, snapshot, 'dss-coop/history/')
    for (const path of [...snapshot.files.keys()].filter(path => path.startsWith('dss-coop/history/') && path.endsWith('.json')).sort().reverse().slice(0, 50)) {
      try {
        const task = await readJson<{ id: string; title: string; coordinator: string; status: string }>(this.repository, snapshot, path)
        if (task) tasks.push(task)
      } catch (error) { await this.cache.put('read-error/' + path, String(error)) }
    }
    for (const [key] of this.cache.entries('read-error/')) {
      const path = key.slice('read-error/'.length)
      if (!snapshot.files.has(path)) {
        const parent = path.slice(0, path.lastIndexOf('/') + 1)
        await loadPaths(this.repository, snapshot, parent)
        if (!snapshot.files.has(path)) await this.cache.remove(key)
      }
    }
    await this.cache.put('projection', { confirmedHead: snapshot.head, messages, tasks, moreBefore })
  }
  async view(): Promise<CoopView> {
    // UI rendering explicitly requests display text; the headless watcher never loads it.
    await this.refreshProjection()
    const projection = this.cache.get<Pick<CoopView, 'confirmedHead' | 'messages' | 'tasks' | 'moreBefore'>>('projection')
    return { settings: this.cache.settings, defaultModel: this.defaultModel(), instanceId: this.cache.instanceId, connection: this.cache.connection(),
      credential: await this.credentials.describe(), status: this.error ? 'offline' : this.cache.connection() ? 'connected' : 'unconfigured',
      error: this.error ?? this.cache.get<string>('runtime-error') ?? (this.cache.entries<string>('read-error/').map(([, value]) => value).join('\n') || undefined), pending: this.cache.drafts(), confirmedHead: this.cache.get<string>('confirmed-head') ?? projection?.confirmedHead, messages: projection?.messages ?? [], moreBefore: projection?.moreBefore, tasks: projection?.tasks ?? [] }
  }
  async call(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted()
    switch (method) {
      case 'view': return this.view()
      case 'configure': return this.configure(params)
      case 'connect': return this.connect()
      case 'sync': await this.sync(); return this.view()
      case 'send': return this.send(params)
      case 'history': return conversationPage(this.repository, this.cache, await this.repository.snapshot(), String(this.cache.connection()!.identity.id), typeof params.before === 'string' ? params.before : undefined)
      case 'retryNative': await this.consumer?.retryNative?.(); this.wake(); return this.view()
      case 'invite': return this.members.invite(String(params.login ?? ''))
      case 'invitations': return this.members.invitations()
      case 'collaborators': return this.members.collaborators()
      case 'cancelInvitation': {
        const id = Number(params.id); if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid invitation identity.')
        return this.members.cancelInvitation(id)
      }
      case 'removeCollaborator': return this.members.remove(String(params.login ?? ''))
      default: throw new Error('Unknown Git collaboration operation: ' + method)
    }
  }
  async dispose(): Promise<void> {
    this.disposed = true; ++this.generation; this.stopSync(); this.client.cancel(); this.repository.cancel?.()
    await Promise.all([this.consumer?.dispose(), this.syncing?.catch(() => {}), this.configuration])
    await this.cache.close(); this.listeners.clear()
  }
}
