import type { StorageUsageStats } from '../contracts/retention.js'
import type { ManualTaskCleanupPreview, ManualCleanupResult } from './manual-cleanup.js'
import type { FrameworkKnowledge, KnowledgeEdit } from './knowledge.js'
export type FrameworkMode = 'local' | 'git'
export type FrameworkClientRole = 'Foreground' | 'Organizer' | 'Planner' | 'Worker' | 'Recorder' | 'Helper'
export interface FrameworkClientModel { provider: string; model: string; reasoningEffort?: string }
export interface FrameworkClientSettings {
  name: string
  userName: string
  localDirectory: string
  ownerRepo: string
  repositoryDirectory: string
  collaborationId: string
  workerSeats: number
  workspace: string
  presetId?: string
  foreground?: FrameworkClientModel
  background?: FrameworkClientModel
  showCornerCharacter?: boolean
  swapPageIllustrations?: boolean
}
export interface FrameworkClientMessage {
  id: string; participantId: string; createdAt: string; role: 'user' | 'assistant' | 'system'; text: string; source?: string
  device?: string; replyTo?: string; recipient?: 'ai' | 'human'; model?: string; modelVersion?: string
}
export interface FrameworkClientExecution {
  workId: string; executionId: string; role: FrameworkClientRole; state: string; member?: string; workerId?: string; detail?: string
}
export interface FrameworkClientTask {
  taskId: string; title: string; route: 'P' | 'O'; owner: string; status: 'running' | 'complete'
  control?: 'running' | 'paused' | 'cancelled'
  members: Array<{ name: string; status: string }>
  executions: FrameworkClientExecution[]
  resultPaths: string[]
}
export interface FrameworkClientResource {
  name: string; status: string; instanceUUID?: string; workerSeats?: number; detail?: string
}
export interface FrameworkLegacyTask {
  migrationId: string; oldTaskId: string; taskId: string
  continuation: 'running' | 'wait-result' | 'wait-user' | 'paused' | 'cancelled' | 'complete' | 'unresolved'
  recordPath?: string; recordsAvailable?: boolean; issues?: string[]
  artifacts?: Array<{ id: string; sourcePath: string; sha256?: string; archivedPath?: string; status: 'archived' | 'pending' | 'unavailable'; detail?: string }>
  waits?: Array<{ id: string; question: string; memberIdentity: string }>
}
export interface FrameworkClientView {
  hasOtherInstanceRecords?: boolean
  foregroundProcessing?: { executionId: string; turnId: string; startedAt: number }
  pendingRecordMove?: { commandId: string; storageScope: string; expectedRevision: string; directory: string }
  revision: string
  activeMode: FrameworkMode
  collaborationId: string
  storageScope?: string
  settings: FrameworkClientSettings
  connection: { participating: boolean; status: string; detail?: string; member?: string; workerSeats?: number }
  messages: FrameworkClientMessage[]
  pageBefore?: string
  pageAfter?: string
  historyDate?: string
  historyWindow?: boolean
  tasks: FrameworkClientTask[]
  legacyTasks: FrameworkLegacyTask[]
  archives: Array<{ path: string; title: string; taskId?: string; files?: string[] }>
  resources: FrameworkClientResource[]
  executions?: FrameworkClientExecution[]
}
export interface FrameworkSendInput {
  mode: FrameworkMode; collaborationId: string; storageScope?: string; id: string; createdAt: string; text: string
  recipient: 'ai' | 'human'; replyTo?: string; device: string; timezoneOffsetMinutes: number
}
export interface FrameworkClientApi {
  maintenanceView(input: { mode: 'local'; storageScope?: string }): Promise<{ localDirectory: string; recordsDirectory?: string; nativeDirectory?: string; usage: StorageUsageStats }>
  openMaintenancePath(input: { mode: 'local'; storageScope?: string; target: 'records' | 'native-logs' }): Promise<{ path: string }>
  exportRecords(input: { mode: 'local'; storageScope?: string; taskId?: string; migrationId?: string; oldTaskId?: string }): Promise<{ path: string; sha256: string; bytes: number }>
  cleanupPreview(input: { mode: 'local'; storageScope?: string }): Promise<ManualTaskCleanupPreview>
  cleanupRecords(input: { mode: 'local'; storageScope?: string; commandId: string } & (
    { action: 'tasks'; preview: ManualTaskCleanupPreview; confirmation: 'clear-ended-task-records' }
    | { action: 'conversation'; confirmation: 'clear-foreground-conversation' }
    | { action: 'planning'; confirmation: 'clear-work-planning-notes' })): Promise<ManualCleanupResult>
  view(input: { mode?: FrameworkMode; includeArchives?: boolean; headerOnly?: boolean; panelsOnly?: boolean }, signal?: AbortSignal): Promise<FrameworkClientView>
  history(input: { mode: FrameworkMode; collaborationId: string; storageScope?: string; beforeId?: string; afterId?: string; date?: string; limit: number }, signal?: AbortSignal): Promise<{ messages: FrameworkClientMessage[]; moreBefore?: string; moreAfter?: string; revision: string; order: string[]; storageScope?: string }>
  send(input: FrameworkSendInput): Promise<{ revision: string; replay?: boolean; storageScope?: string }>
  sentMessage?(input: FrameworkSendInput, signal?: AbortSignal): Promise<{ message?: FrameworkClientMessage; revision: string; order: string[] }>
  configure(input: { mode: FrameworkMode; commandId: string; expectedRevision?: string; settings: FrameworkClientSettings }): Promise<FrameworkClientView>
  foregroundModel(input: { mode: FrameworkMode; storageScope?: string; commandId: string; expectedRevision: string; model?: FrameworkClientModel }): Promise<FrameworkClientView>
  moveRecords(input: { mode: 'local'; storageScope: string; expectedRevision: string; commandId: string; directory: string }): Promise<FrameworkClientView>
  legacyRecords(input: { mode: FrameworkMode; storageScope?: string; migrationId: string; oldTaskId: string }): Promise<{ text: string; revision: string }>
  legacyControl(input: { mode: FrameworkMode; storageScope?: string; commandId: string; migrationId: string; oldTaskId: string; action: 'resume' | 'answer'; waitId?: string; answer?: string }): Promise<FrameworkClientView>
  invite(input: { mode: 'git'; storageScope?: string; username: string }): Promise<{ status: 'pending' | 'accepted' }>
  knowledgeList(input: { mode: FrameworkMode; storageScope?: string }): ReturnType<FrameworkKnowledge['list']>
  knowledgeRead(input: { mode: FrameworkMode; storageScope?: string; path: string }): ReturnType<FrameworkKnowledge['read']>
  knowledgeEdit(input: { mode: FrameworkMode; storageScope?: string; commandId: string } & KnowledgeEdit): ReturnType<FrameworkKnowledge['edit']>
  knowledgeStatus(input: { mode: FrameworkMode; storageScope?: string; commandId: string } & Parameters<FrameworkKnowledge['setStatus']>[1]): ReturnType<FrameworkKnowledge['setStatus']>
  gitMembers(input: { mode: 'git'; storageScope?: string }): Promise<{ invitations: Array<{ id: number; login: string; status: 'pending'; htmlUrl?: string }>; collaborators: Array<{ id: number; login: string; status: 'accepted'; permissions: Record<string, boolean> }> }>
  gitMemberAction(input: { mode: 'git'; storageScope?: string } & ({ action: 'cancelInvitation'; invitationId: number } | { action: 'remove'; username: string })): Promise<void>
  taskControl(input: { mode: FrameworkMode; storageScope?: string; commandId: string; taskId: string; intent: 'running' | 'paused' | 'cancelled' }): Promise<FrameworkClientView>
  stopExecution(input: { mode: FrameworkMode; storageScope?: string; commandId: string; workId: string; executionId: string }): Promise<FrameworkClientView>
  participation(input: { mode: FrameworkMode; enabled: boolean }): Promise<FrameworkClientView>
  selectMode(input: { mode: FrameworkMode; headerOnly?: boolean }): Promise<FrameworkClientView>
  readFile(input: { mode: FrameworkMode; storageScope?: string; path: string }): Promise<{ path: string; text?: string; downloadUrl?: string; binary?: { bytes: number; sha256: string; downloadUrl: string }; revision: string }>
  subscribeChanged(listener: () => void, availability?: (available: boolean) => void): () => void
}
export interface FrameworkDraft { input: FrameworkSendInput; state: 'draft' | 'sending' | 'unknown' | 'confirmed'; error?: string }
export interface FrameworkClientSnapshot { value?: FrameworkClientView; loading: boolean; error?: string; drafts: readonly FrameworkDraft[] }
export const frameworkScopeKey = (mode: FrameworkMode, collaborationId: string, storageScope?: string) => JSON.stringify([mode, collaborationId, storageScope])

/** An in-memory client controller keeps original drafts across page/mode changes.
 * It does not persist remote conversation bodies or cancel Host sends on unmount.
 */
export class FrameworkClientController {
  private current: FrameworkClientSnapshot = { loading: false, drafts: [] }
  private readonly listeners = new Set<() => void>()
  private initialHeader?: { mode?: FrameworkMode; controller: AbortController; promise: Promise<FrameworkClientView> }
  private viewRead?: { controller: AbortController; mode?: FrameworkMode; revision: string; collaborationId: string; dirty: boolean; includeArchives: boolean; publish: (view: FrameworkClientView) => void; isCurrent: () => boolean; promise: Promise<FrameworkClientView> }
  private historyReads = new AbortController()
  private navigationRead?: Promise<void>
  private navigationGeneration = 0
  private generation = 0
  private historyGeneration = 0
  private readonly olderRequests = new Map<string, Promise<void>>()
  private requestedMode?: FrameworkMode
  private navigation?: symbol
  private readonly expandedHistory = new Set<string>()
  private connectionReferences = 0
  private disconnect?: () => void
  private processingAvailable = true
  private processingEpoch = 0
  // Message RPCs share one lane per mounted scope. No request-start counter is
  // treated as a remote version. Panels never publish message state.
  private readonly messageLanes = new Map<string, Promise<unknown>>()
  private messageRefresh?: { key: string; dirty: boolean; promise: Promise<void> }
  private readonly sends = new Map<string, Promise<void>>()
  // Display ownership is separate from immutable write arguments. A cold
  // header may resolve after the original send has failed or become UNKNOWN.
  private readonly draftOwners = new Map<string, { navigation: number; revision: string; storageScope?: string }>()
  private readonly acknowledgedDrafts = new Set<string>()
  constructor(readonly api: FrameworkClientApi) {}
  retainConnection(): () => void {
    if (this.connectionReferences++ === 0) {
      this.disconnect = this.api.subscribeChanged(() => { void this.refresh().catch(() => {}) }, available => {
        this.processingAvailable = available
        if (!available) {
          this.processingEpoch++
          if (this.current.value?.foregroundProcessing) this.publish({ value: { ...this.current.value, foregroundProcessing: undefined } })
        }
      })
      void this.refresh().catch(() => {})
    }
    let released = false
    return () => {
      if (released) return
      released = true
      if (--this.connectionReferences === 0) { this.disconnect?.(); this.disconnect = undefined; this.navigation = undefined; ++this.generation; ++this.historyGeneration; this.cancelReads() }
    }
  }
  private cancelReads(): void {
    const header = this.initialHeader, body = this.viewRead
    this.initialHeader = undefined; this.viewRead = undefined; this.messageRefresh = undefined
    header?.controller.abort(); body?.controller.abort()
    this.historyReads.abort(); this.historyReads = new AbortController()
  }
  snapshot = (): FrameworkClientSnapshot => this.current
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(change: Partial<FrameworkClientSnapshot>): void {
    const before = this.current.value, after = change.value
    if (before && after && frameworkScopeKey(before.activeMode, before.collaborationId, before.storageScope) !== frameworkScopeKey(after.activeMode, after.collaborationId, after.storageScope)) this.historyGeneration++
    const replaced = before?.storageScope !== undefined && after?.storageScope !== undefined
      && frameworkScopeKey(before.activeMode, before.collaborationId, before.storageScope) !== frameworkScopeKey(after.activeMode, after.collaborationId, after.storageScope)
    if (replaced) { ++this.navigationGeneration; this.historyReads.abort(); this.historyReads = new AbortController(); this.messageRefresh = undefined }
    this.current = { ...this.current, ...change }
    if (after?.storageScope !== undefined && !this.navigation) for (const draft of this.current.drafts) {
      const owner = this.draftOwners.get(draft.input.id)
      if (owner && owner.storageScope === undefined && owner.navigation === this.navigationGeneration
        && owner.revision === after.revision && draft.input.mode === after.activeMode && draft.input.collaborationId === after.collaborationId) owner.storageScope = after.storageScope
    }
    if (after) for (const draft of this.current.drafts) {
      const scope = draft.input.storageScope ?? this.draftOwners.get(draft.input.id)?.storageScope
      if (draft.state === 'confirmed' && scope === after.storageScope && draft.input.mode === after.activeMode
        && draft.input.collaborationId === after.collaborationId && after.messages.some(message => message.id === draft.input.id && message.role === 'user' && message.text === draft.input.text)) this.acknowledgedDrafts.add(draft.input.id)
    }
    for (const listener of this.listeners) listener()
    if (replaced && !this.navigation) void this.refreshMessages().catch(() => {})
  }
  pendingDrafts(): readonly FrameworkDraft[] {
    const view = this.current.value
    if (!view) return []
    return this.current.drafts.filter(draft => {
      if (draft.input.mode !== view.activeMode || draft.input.collaborationId !== view.collaborationId) return false
      const owner = this.draftOwners.get(draft.input.id), scope = draft.input.storageScope ?? owner?.storageScope
      const belongs = scope !== undefined ? scope === view.storageScope
        : view.storageScope === undefined && !!owner && owner.navigation === this.navigationGeneration && owner.revision === view.revision && !this.navigation
      return belongs && (draft.state !== 'confirmed' || (!this.acknowledgedDrafts.has(draft.input.id) && !view.messages.some(message => message.id === draft.input.id)))
    })
  }
  private displayView(value: FrameworkClientView, epoch: number): FrameworkClientView {
    return this.processingAvailable && epoch === this.processingEpoch ? value : { ...value, foregroundProcessing: undefined }
  }
  private async load(operation: (publishIntermediate: (value: FrameworkClientView) => void, isCurrent: () => boolean) => Promise<FrameworkClientView>, scopedMode?: FrameworkMode, fullView = true): Promise<void> {
    // An action still belongs to its original scope, but its result must not
    // replace a newer mode/settings navigation. Do not cancel the Host action.
    if (scopedMode && (this.navigation || (this.requestedMode && scopedMode !== this.requestedMode))) { await operation(() => {}, () => false); return }
    const generation = ++this.generation, processingEpoch = this.processingAvailable ? this.processingEpoch : -1
    const project = (value: FrameworkClientView) => this.displayView(this.refreshView(value, true), processingEpoch)
    this.publish({ loading: true, error: undefined })
    try { const value = await operation(value => { if (generation === this.generation) this.publish({ value: project(value) }) }, () => generation === this.generation); if (generation === this.generation) this.publish({ value: project(value), loading: false }) }
    catch (error) { if (generation === this.generation) this.publish({ loading: false, error: error instanceof Error ? error.message : String(error) }); throw error }
  }
  private async navigate(operation: () => Promise<FrameworkClientView>, mode: FrameworkMode, hydrate = false): Promise<void> {
    if (this.requestedMode && mode !== this.requestedMode) { await operation(); return }
    this.historyGeneration++; this.navigationGeneration++; this.cancelReads()
    const navigation = this.navigation = Symbol(), processingEpoch = this.processingAvailable ? this.processingEpoch : -1
    ++this.generation
    this.publish({ loading: true, error: undefined })
    try {
      const value = await operation()
      if (this.navigation === navigation) {
        this.navigation = undefined; ++this.generation
        this.publish({ value: this.displayView(this.refreshView(value, true), processingEpoch), loading: hydrate, error: undefined })
        if (hydrate) {
          const reading = this.refresh(false, true)
          this.navigationRead = reading
          const settled = () => { if (this.navigationRead === reading) this.navigationRead = undefined }
          // load owns publication and visible errors; retain and handle this
          // reading responsibility without delaying the saved mode action.
          void reading.then(settled, settled)
        } else {
          void this.refreshMessages().catch(() => {})
        }
      }
    } catch (error) {
      if (this.navigation === navigation) {
        this.navigation = undefined; ++this.generation
        this.publish({ loading: false, error: error instanceof Error ? error.message : String(error) })
      }
      throw error
    }
  }
  refresh = (includeArchives = false, hydrate = false): Promise<void> => this.load(async (publishHeader, isCurrent) => {
    const mode = this.requestedMode ?? this.current.value?.activeMode
    const firstAcquisition = !this.current.value
    if (firstAcquisition) {
      // Only first acquisition needs a local settings header. Concurrent change
      // notifications share that in-flight read, never a persistent cache.
      if (!this.initialHeader || this.initialHeader.mode !== mode) {
        this.initialHeader?.controller.abort()
        const controller = new AbortController()
        const request = { mode, controller, promise: this.api.view({ mode, headerOnly: true }, controller.signal) }
        this.initialHeader = request
        void request.promise.then(() => { if (this.initialHeader === request) this.initialHeader = undefined },
          () => { if (this.initialHeader === request) this.initialHeader = undefined })
      }
      const header = await this.initialHeader.promise
      if (!isCurrent()) return header
      publishHeader(header)
    }
    const messageReading = this.refreshMessages()
    void messageReading.catch(() => {})
    const targetMode = mode ?? this.current.value?.activeMode
    let request: Promise<FrameworkClientView>
    let hydration: typeof this.viewRead
    const currentHeader = this.current.value!
    const existing = this.viewRead
    if (existing && existing.mode === targetMode && existing.revision === currentHeader.revision
      && existing.collaborationId === currentHeader.collaborationId) {
      hydration = existing
      hydration.dirty = true; hydration.includeArchives ||= includeArchives
      hydration.publish = publishHeader; hydration.isCurrent = isCurrent
      request = hydration.promise
    } else {
      existing?.controller.abort()
      const navigation = this.navigationGeneration
      const owned = { controller: new AbortController(), mode: targetMode, revision: currentHeader.revision, collaborationId: currentHeader.collaborationId,
        dirty: false, includeArchives, publish: publishHeader, isCurrent, promise: undefined as unknown as Promise<FrameworkClientView> }
      const eligible = () => { const current = this.current.value; return this.viewRead === owned && navigation === this.navigationGeneration && owned.isCurrent()
        && !!current && current.activeMode === owned.mode && current.revision === owned.revision
        && current.collaborationId === owned.collaborationId }
      // Register ownership before invoking API callbacks. Each completed read is
      // visible immediately; only actual invalidations request another read.
      this.viewRead = owned; hydration = owned
      owned.promise = Promise.resolve().then(async () => {
        let result = currentHeader, published = !firstAcquisition && !hydrate
        try {
          while (eligible()) {
            owned.dirty = false
            result = await this.api.view({ mode: targetMode, includeArchives: owned.includeArchives, panelsOnly: true }, owned.controller.signal)
            if (!eligible()) return result
            // The still-owned response may contain a newer authoritative
            // settings projection. Advance before publishing so synchronous
            // invalidations join this same responsibility, not a stale header.
            owned.revision = result.revision; owned.collaborationId = result.collaborationId
            result = this.refreshView(result, owned.includeArchives, published)
            owned.publish(result); published = true
            if (!owned.dirty) return result
          }
          return result
        } finally { if (this.viewRead === owned) this.viewRead = undefined }
      })
      request = owned.promise
    }
    const panels = await request
    await messageReading
    return this.refreshView(panels, includeArchives || !!hydration?.includeArchives)
  }, undefined, false)
  private refreshView(value: FrameworkClientView, includeArchives: boolean, previousLoaded = true): FrameworkClientView {
    const current = this.current.value, fresh = { ...value, messages: [] as FrameworkClientMessage[], pageBefore: undefined as string | undefined,
      pageAfter: undefined as string | undefined, historyDate: undefined as string | undefined, historyWindow: undefined as boolean | undefined }
    if (!current || frameworkScopeKey(current.activeMode, current.collaborationId, current.storageScope)
      !== frameworkScopeKey(value.activeMode, value.collaborationId, value.storageScope)) return fresh
    if (previousLoaded && !includeArchives) fresh.archives = current.archives
    return { ...fresh, messages: current.messages, pageBefore: current.pageBefore, pageAfter: current.pageAfter,
      historyDate: current.historyDate, historyWindow: current.historyWindow }
  }
  private messageOwner() {
    const view = this.current.value
    if (!view || this.navigation) return undefined
    const navigation = this.navigationGeneration, mode = view.activeMode, collaborationId = view.collaborationId, storageScope = view.storageScope
    const signal = this.historyReads.signal, key = JSON.stringify([navigation, mode, collaborationId])
    const current = () => { const now = this.current.value; return !signal.aborted && !this.navigation && navigation === this.navigationGeneration
      && !!now && (storageScope !== undefined || now.revision === view.revision) && now.activeMode === mode && now.collaborationId === collaborationId
      && (storageScope === undefined || now.storageScope === storageScope) }
    return { key, signal, mode, collaborationId, storageScope, current }
  }
  private messageRead<T>(owner: NonNullable<ReturnType<FrameworkClientController['messageOwner']>>, operation: () => Promise<T>): Promise<T | undefined> {
    const prior = this.messageLanes.get(owner.key)
    const pending = Promise.resolve(prior).catch(() => {}).then(async () => {
      if (!owner.current()) return undefined
      try { return await operation() } catch (error) {
        if (!owner.current()) return undefined
        this.publish({ error: error instanceof Error ? error.message : String(error) }); throw error
      }
    })
    this.messageLanes.set(owner.key, pending)
    void pending.finally(() => { if (this.messageLanes.get(owner.key) === pending) this.messageLanes.delete(owner.key) }).catch(() => {})
    return pending
  }
  private applyMessages(owner: NonNullable<ReturnType<FrameworkClientController['messageOwner']>>, page: {
    messages: FrameworkClientMessage[]; order: string[]; storageScope?: string; moreBefore?: string; moreAfter?: string
  }, intent: 'latest' | 'append' | 'history' | 'older', date?: string): void {
    if (!owner.current()) return
    const current = this.current.value!, scope = page.storageScope ?? owner.storageScope
    if (current.storageScope !== undefined && scope !== current.storageScope) return
    if (!Array.isArray(page.order) || page.messages.some(message => !page.order.includes(message.id))) throw new Error('Conversation read is missing its authoritative index.')
    const keep = intent === 'append' || intent === 'older' || (intent === 'latest' && (current.historyWindow || this.expandedHistory.has(frameworkScopeKey(current.activeMode, current.collaborationId, current.storageScope))))
    const rows = new Map((keep ? current.messages : []).map(message => [message.id, message]))
    // An empty index is just as authoritative as a non-empty one. Never promote
    // retained input into messages, or keep a body whose index entry was removed.
    if (!(intent === 'latest' && current.historyWindow)) for (const message of page.messages) rows.set(message.id, message)
    const messages = page.order.flatMap(id => rows.has(id) ? [rows.get(id)!] : [])
    const cursors = intent === 'append' ? { pageBefore: current.pageBefore && page.order.includes(current.pageBefore) ? current.pageBefore : undefined,
      pageAfter: current.pageAfter && page.order.includes(current.pageAfter) ? current.pageAfter : undefined }
      : intent === 'older' ? { pageBefore: page.moreBefore, pageAfter: current.pageAfter }
      : intent === 'latest' && (current.historyWindow || this.expandedHistory.has(frameworkScopeKey(current.activeMode, current.collaborationId, current.storageScope))) ? { pageBefore: current.pageBefore && page.order.includes(current.pageBefore) ? current.pageBefore : undefined,
        pageAfter: current.pageAfter && page.order.includes(current.pageAfter) ? current.pageAfter : undefined }
      : { pageBefore: page.moreBefore, pageAfter: page.moreAfter }
    this.publish({ value: { ...current, storageScope: scope, messages, ...cursors,
      ...(intent === 'history' ? { historyDate: date, historyWindow: true } : {}) } })
  }
  private refreshMessages(): Promise<void> {
    const owner = this.messageOwner()
    if (!owner) return Promise.resolve()
    if (this.messageRefresh?.key === owner.key) { this.messageRefresh.dirty = true; return this.messageRefresh.promise }
    const read = { key: owner.key, dirty: false, promise: undefined as unknown as Promise<void> }
    this.messageRefresh = read
    read.promise = (async () => {
      do {
        read.dirty = false
        await this.messageRead(owner, async () => {
          const page = await this.api.history({ mode: owner.mode, collaborationId: owner.collaborationId, storageScope: owner.storageScope, limit: 20 }, owner.signal)
          this.applyMessages(owner, page, 'latest')
        })
      } while (read.dirty && owner.current() && this.messageRefresh === read)
    })().finally(() => { if (this.messageRefresh === read) this.messageRefresh = undefined })
    return read.promise
  }
  selectMode = (mode: FrameworkMode): Promise<void> => { this.requestedMode = mode; return this.navigate(() => this.api.selectMode({ mode, headerOnly: true }), mode, true) }
  taskControl = (input: Parameters<FrameworkClientApi['taskControl']>[0]): Promise<void> => this.load(() => this.api.taskControl(input), input.mode)
  stopExecution = (input: Parameters<FrameworkClientApi['stopExecution']>[0]): Promise<void> => this.load(() => this.api.stopExecution(input), input.mode)
  legacyControl = (input: Parameters<FrameworkClientApi['legacyControl']>[0]): Promise<void> => this.load(() => this.api.legacyControl(input), input.mode)
  participation = (enabled: boolean): Promise<void> => {
    const before = this.current.value, mode = before?.activeMode ?? this.requestedMode ?? 'local'
    const scope = before && frameworkScopeKey(before.activeMode, before.collaborationId, before.storageScope)
    return this.load(async () => {
      const result = await this.api.participation({ mode, enabled }), current = this.current.value
      if (enabled || !current) return result
      if (current.activeMode !== mode || scope !== frameworkScopeKey(current.activeMode, current.collaborationId, current.storageScope)) return current
      // A successful stop returns only local settings/connection facts. It must
      // not reacquire Git access or erase the already readable conversation.
      return { ...current, settings: result.settings, revision: result.revision, connection: result.connection, foregroundProcessing: undefined }
    }, mode, enabled)
  }
  configure = (input: Parameters<FrameworkClientApi['configure']>[0]): Promise<void> => this.navigate(() => this.api.configure(input), input.mode)
  foregroundModel = (input: Parameters<FrameworkClientApi['foregroundModel']>[0]): Promise<void> => {
    const before = this.current.value
    const scope = before && frameworkScopeKey(before.activeMode, before.collaborationId, before.storageScope)
    return this.load(async () => {
      const saved = await this.api.foregroundModel(input), current = this.current.value
      // This response is a local settings projection, not a fresh conversation.
      // In particular, no Git access is needed merely to select the next model.
      if (!current) return saved
      if (current.activeMode !== input.mode || scope !== frameworkScopeKey(current.activeMode, current.collaborationId, current.storageScope)) return current
      return { ...current, settings: saved.settings, revision: saved.revision }
    }, input.mode, false)
  }

  async navigateHistory(input: { date?: string; beforeId?: string; afterId?: string; limit: number }): Promise<void> {
    const owner = this.messageOwner()
    if (!owner) return
    const generation = ++this.historyGeneration
    this.publish({ loading: true, error: undefined })
    await this.messageRead(owner, async () => {
      const page = await this.api.history({ mode: owner.mode, collaborationId: owner.collaborationId, storageScope: owner.storageScope, ...input }, owner.signal)
      if (!owner.current() || generation !== this.historyGeneration) return
      this.expandedHistory.delete(frameworkScopeKey(owner.mode, owner.collaborationId, page.storageScope ?? owner.storageScope))
      this.applyMessages(owner, page, 'history', input.date); this.publish({ loading: false })
    })
  }
  latest = async (): Promise<void> => {
    const owner = this.messageOwner()
    if (!owner) return
    const generation = ++this.historyGeneration
    await this.messageRead(owner, async () => {
      const page = await this.api.history({ mode: owner.mode, collaborationId: owner.collaborationId, storageScope: owner.storageScope, limit: 20 }, owner.signal)
      if (!owner.current() || generation !== this.historyGeneration) return
      this.expandedHistory.delete(frameworkScopeKey(owner.mode, owner.collaborationId, page.storageScope ?? owner.storageScope))
      this.publish({ value: { ...this.current.value!, historyWindow: undefined, historyDate: undefined } })
      this.applyMessages(owner, page, 'latest')
    })
  }
  older(limit: number): Promise<void> {
    const value = this.current.value, owner = this.messageOwner()
    if (!value?.pageBefore || !owner) return Promise.resolve()
    const generation = this.historyGeneration, key = frameworkScopeKey(value.activeMode, value.collaborationId, value.storageScope)
    const requestKey = JSON.stringify([generation, key, value.historyDate, value.pageBefore])
    const existing = this.olderRequests.get(requestKey)
    if (existing) return existing
    this.expandedHistory.add(key)
    const operation = this.messageRead(owner, async () => {
      const page = await this.api.history({ mode: owner.mode, collaborationId: owner.collaborationId, storageScope: owner.storageScope,
        date: value.historyDate, beforeId: value.pageBefore, limit }, owner.signal)
      if (generation === this.historyGeneration) this.applyMessages(owner, page, 'older')
    }).then(() => {})
    this.olderRequests.set(requestKey, operation)
    void operation.finally(() => { if (this.olderRequests.get(requestKey) === operation) this.olderRequests.delete(requestKey) }).catch(() => {})
    return operation
  }
  retain(input: FrameworkSendInput): void {
    const existing = this.current.drafts.find(draft => draft.input.id === input.id)
    if (existing) { if (JSON.stringify(existing.input) !== JSON.stringify(input)) throw new Error('Retained message identity has different content.'); return }
    const view = this.current.value
    if (input.storageScope === undefined && view && !this.navigation && view.activeMode === input.mode && view.collaborationId === input.collaborationId) {
      this.draftOwners.set(input.id, { navigation: this.navigationGeneration, revision: view.revision, storageScope: view.storageScope })
    }
    this.publish({ drafts: [...this.current.drafts, { input: { ...input }, state: 'draft' }] })
  }
  send(input: FrameworkSendInput): Promise<void> {
    this.retain(input)
    const active = this.sends.get(input.id)
    if (active) return active
    const retained = this.current.drafts.find(draft => draft.input.id === input.id)!
    if (retained.state === 'confirmed') return Promise.resolve()
    const beforeSend = this.current.value, sendNavigation = this.navigationGeneration
    const unboundOwner = input.storageScope === undefined && beforeSend?.storageScope === undefined && !this.navigation
      && beforeSend?.activeMode === input.mode && beforeSend.collaborationId === input.collaborationId
    const update = (state: FrameworkDraft['state'], error?: string) => this.publish({ drafts: this.current.drafts.map(draft => draft.input.id === input.id ? { ...draft, state, error } : draft) })
    update('sending')
    const operation = this.api.send(retained.input).then(async receipt => {
      update('confirmed')
      // A cold settings header may not know the storage identity yet. Bind the
      // read to the actual successful destination, never an undefined wildcard.
      const storageScope = input.storageScope ?? receipt.storageScope
      const current = this.current.value
      if (unboundOwner && storageScope !== undefined && current && current.storageScope === undefined
        && sendNavigation === this.navigationGeneration && !this.navigation && current.revision === beforeSend!.revision
        && current.activeMode === input.mode && current.collaborationId === input.collaborationId) {
        // The same still-unbound header can learn its destination from the
        // successful write before unrelated panels finish loading. No draft
        // content is promoted: the message still comes from remote readback.
        this.publish({ value: { ...current, storageScope } })
      }
      const scope = frameworkScopeKey(input.mode, input.collaborationId, storageScope)
      const currentScope = () => { const view = this.current.value; return !!view && frameworkScopeKey(view.activeMode, view.collaborationId, view.storageScope) === scope }
      const delivered = () => this.current.value?.messages.some(message => message.id === input.id && message.role === 'user' && message.text === input.text)
      if (!currentScope() || delivered()) return
      if (this.api.sentMessage) {
        const owner = this.messageOwner()
        if (!owner) return
        await this.messageRead(owner, async () => {
          if (!currentScope() || delivered()) return
          const result = await this.api.sentMessage!({ ...retained.input, storageScope }, owner.signal)
          if (!owner.current() || !currentScope()) return
          const message = result.message
          if (message && (message.id !== input.id || message.role !== 'user' || message.text !== input.text || !result.order.includes(message.id))) throw new Error('Saved message readback differs from the original input.')
          this.acknowledgedDrafts.add(input.id)
          this.applyMessages(owner, { messages: message && !this.current.value?.historyWindow ? [message] : [], order: result.order, storageScope }, 'append')
        })
        return
      }
      await this.refreshMessages()
    }, error => { update('unknown', error instanceof Error ? error.message : String(error)); throw error })
    this.sends.set(input.id, operation)
    void operation.finally(() => { this.sends.delete(input.id) }).catch(() => {})
    return operation
  }
}

const frameworkControllers = new WeakMap<FrameworkClientApi, FrameworkClientController>()
export function getFrameworkClientController(api: FrameworkClientApi): FrameworkClientController {
  let controller = frameworkControllers.get(api)
  if (!controller) { controller = new FrameworkClientController(api); frameworkControllers.set(api, controller) }
  return controller
}
