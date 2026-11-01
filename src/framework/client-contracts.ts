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
  waits?: Array<{ id: string; question: string; memberIdentity: string }>
}
export interface FrameworkClientView {
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
  view(input: { mode?: FrameworkMode; includeArchives?: boolean }): Promise<FrameworkClientView>
  history(input: { mode: FrameworkMode; collaborationId: string; storageScope?: string; beforeId?: string; afterId?: string; date?: string; limit: number }): Promise<{ messages: FrameworkClientMessage[]; moreBefore?: string; moreAfter?: string; revision: string }>
  send(input: FrameworkSendInput): Promise<{ revision: string; replay?: boolean }>
  configure(input: { mode: FrameworkMode; commandId: string; expectedRevision?: string; settings: FrameworkClientSettings }): Promise<FrameworkClientView>
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
  selectMode(input: { mode: FrameworkMode }): Promise<FrameworkClientView>
  readFile(input: { mode: FrameworkMode; storageScope?: string; path: string }): Promise<{ path: string; text?: string; downloadUrl?: string; binary?: { bytes: number; sha256: string; downloadUrl: string }; revision: string }>
  subscribeChanged(listener: () => void): () => void
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
  private generation = 0
  private historyGeneration = 0
  private readonly olderRequests = new Map<string, Promise<void>>()
  private requestedMode?: FrameworkMode
  private navigation?: symbol
  private readonly expandedHistory = new Set<string>()
  private connectionReferences = 0
  private disconnect?: () => void
  private readonly sends = new Map<string, Promise<void>>()
  constructor(readonly api: FrameworkClientApi) {}
  retainConnection(): () => void {
    if (this.connectionReferences++ === 0) {
      this.disconnect = this.api.subscribeChanged(() => { void this.refresh().catch(() => {}) })
      void this.refresh().catch(() => {})
    }
    let released = false
    return () => {
      if (released) return
      released = true
      if (--this.connectionReferences === 0) { this.disconnect?.(); this.disconnect = undefined }
    }
  }
  snapshot = (): FrameworkClientSnapshot => this.current
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(change: Partial<FrameworkClientSnapshot>): void {
    const before = this.current.value, after = change.value
    if (before && after && frameworkScopeKey(before.activeMode, before.collaborationId, before.storageScope) !== frameworkScopeKey(after.activeMode, after.collaborationId, after.storageScope)) this.historyGeneration++
    this.current = { ...this.current, ...change }; for (const listener of this.listeners) listener() }
  private async load(operation: () => Promise<FrameworkClientView>, scopedMode?: FrameworkMode): Promise<void> {
    // An action still belongs to its original scope, but its result must not
    // replace a newer mode/settings navigation. Do not cancel the Host action.
    if (scopedMode && (this.navigation || (this.requestedMode && scopedMode !== this.requestedMode))) { await operation(); return }
    const generation = ++this.generation
    this.publish({ loading: true, error: undefined })
    try { const value = await operation(); if (generation === this.generation) this.publish({ value, loading: false }) }
    catch (error) { if (generation === this.generation) this.publish({ loading: false, error: error instanceof Error ? error.message : String(error) }); throw error }
  }
  private async navigate(operation: () => Promise<FrameworkClientView>, mode: FrameworkMode): Promise<void> {
    if (this.requestedMode && mode !== this.requestedMode) { await operation(); return }
    this.historyGeneration++
    const navigation = this.navigation = Symbol()
    ++this.generation
    this.publish({ loading: true, error: undefined })
    try {
      const value = await operation()
      if (this.navigation === navigation) {
        this.navigation = undefined; ++this.generation
        this.publish({ value, loading: false, error: undefined })
      }
    } catch (error) {
      if (this.navigation === navigation) {
        this.navigation = undefined; ++this.generation
        this.publish({ loading: false, error: error instanceof Error ? error.message : String(error) })
      }
      throw error
    }
  }
  refresh = (includeArchives = false): Promise<void> => this.load(async () => {
    const fresh = await this.api.view({ mode: this.requestedMode ?? this.current.value?.activeMode, includeArchives })
    const current = this.current.value, key = frameworkScopeKey(fresh.activeMode, fresh.collaborationId, fresh.storageScope)
    if (!includeArchives && current && frameworkScopeKey(current.activeMode, current.collaborationId, current.storageScope) === key) fresh.archives = current.archives
    if (current?.historyWindow && frameworkScopeKey(current.activeMode, current.collaborationId, current.storageScope) === key) return { ...fresh, messages: current.messages, pageBefore: current.pageBefore, pageAfter: current.pageAfter, historyDate: current.historyDate, historyWindow: true }
    if (!current || frameworkScopeKey(current.activeMode, current.collaborationId, current.storageScope) !== key || !this.expandedHistory.has(key)) return fresh
    const messages = new Map(current.messages.map(message => [message.id, message]))
    for (const message of fresh.messages) messages.set(message.id, message)
    return { ...fresh, messages: [...messages.values()], pageBefore: current.pageBefore }
  })
  selectMode = (mode: FrameworkMode): Promise<void> => { this.requestedMode = mode; return this.navigate(() => this.api.selectMode({ mode }), mode) }
  taskControl = (input: Parameters<FrameworkClientApi['taskControl']>[0]): Promise<void> => this.load(() => this.api.taskControl(input), input.mode)
  stopExecution = (input: Parameters<FrameworkClientApi['stopExecution']>[0]): Promise<void> => this.load(() => this.api.stopExecution(input), input.mode)
  legacyControl = (input: Parameters<FrameworkClientApi['legacyControl']>[0]): Promise<void> => this.load(() => this.api.legacyControl(input), input.mode)
  participation = (enabled: boolean): Promise<void> => { const mode = this.current.value?.activeMode ?? this.requestedMode ?? 'local'; return this.load(() => this.api.participation({ mode, enabled }), mode) }
  configure = (input: Parameters<FrameworkClientApi['configure']>[0]): Promise<void> => this.navigate(() => this.api.configure(input), input.mode)
  async navigateHistory(input: { date?: string; beforeId?: string; afterId?: string; limit: number }): Promise<void> {
    const value = this.current.value
    if (!value || this.navigation) return
    const generation = ++this.historyGeneration
    const key = frameworkScopeKey(value.activeMode, value.collaborationId, value.storageScope)
    const owns = () => generation === this.historyGeneration && !this.navigation && this.current.value !== undefined
      && frameworkScopeKey(this.current.value.activeMode, this.current.value.collaborationId, this.current.value.storageScope) === key
    this.publish({ loading: true, error: undefined })
    try {
      const page = await this.api.history({ mode: value.activeMode, collaborationId: value.collaborationId, storageScope: value.storageScope, ...input })
      if (!owns()) return
      this.expandedHistory.delete(key)
      this.publish({ loading: false, value: { ...this.current.value!, messages: page.messages, pageBefore: page.moreBefore,
        pageAfter: page.moreAfter, historyDate: input.date, historyWindow: true } })
    } catch (error) {
      if (owns()) this.publish({ loading: false, error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }
  latest = (): Promise<void> => {
    const value = this.current.value, mode = this.requestedMode ?? value?.activeMode ?? 'local'
    if (value) this.expandedHistory.delete(frameworkScopeKey(value.activeMode, value.collaborationId, value.storageScope))
    return this.navigate(() => this.api.view({ mode }), mode)
  }
  older(limit: number): Promise<void> {
    const value = this.current.value
    if (!value?.pageBefore || this.navigation) return Promise.resolve()
    const generation = this.historyGeneration, key = frameworkScopeKey(value.activeMode, value.collaborationId, value.storageScope)
    const requestKey = JSON.stringify([generation, key, value.historyDate, value.pageBefore])
    const existing = this.olderRequests.get(requestKey)
    if (existing) return existing
    // Preserve already displayed rows if a live refresh arrives during this read.
    this.expandedHistory.add(key)
    const operation = this.api.history({ mode: value.activeMode, collaborationId: value.collaborationId, storageScope: value.storageScope,
      date: value.historyDate, beforeId: value.pageBefore, limit }).then(page => {
      const current = this.current.value
      if (!current || this.navigation || generation !== this.historyGeneration || frameworkScopeKey(current.activeMode, current.collaborationId, current.storageScope) !== key) return
      const seen = new Set<string>()
      const messages = [...page.messages, ...current.messages].filter(message => !seen.has(message.id) && !!seen.add(message.id))
      this.publish({ value: { ...current, messages, pageBefore: page.moreBefore } })
    })
    this.olderRequests.set(requestKey, operation)
    void operation.finally(() => { if (this.olderRequests.get(requestKey) === operation) this.olderRequests.delete(requestKey) }).catch(() => {})
    return operation
  }
  retain(input: FrameworkSendInput): void {
    const existing = this.current.drafts.find(draft => draft.input.id === input.id)
    if (existing) { if (JSON.stringify(existing.input) !== JSON.stringify(input)) throw new Error('Retained message identity has different content.'); return }
    this.publish({ drafts: [...this.current.drafts, { input: { ...input }, state: 'draft' }] })
  }
  send(input: FrameworkSendInput): Promise<void> {
    this.retain(input)
    const active = this.sends.get(input.id)
    if (active) return active
    const retained = this.current.drafts.find(draft => draft.input.id === input.id)!
    if (retained.state === 'confirmed') return Promise.resolve()
    const update = (state: FrameworkDraft['state'], error?: string) => this.publish({ drafts: this.current.drafts.map(draft => draft.input.id === input.id ? { ...draft, state, error } : draft) })
    update('sending')
    const operation = this.api.send(retained.input).then(() => {
      update('confirmed')
      const view = this.current.value
      if (view && frameworkScopeKey(view.activeMode, view.collaborationId, view.storageScope) === frameworkScopeKey(input.mode, input.collaborationId, input.storageScope)) return this.refresh().catch(() => {})
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
