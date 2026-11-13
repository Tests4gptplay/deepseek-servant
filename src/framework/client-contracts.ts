import type { LocalSourceRetirementAudit } from './local-upgrade-source-audit.js'
import type { LocalUpgradeSpecialStageOwner } from './local-upgrade-completion.js'
import type { ConversationAttachmentReference } from './conversation-attachment-reference.js'
import type { PhysicalWorkspaceReference } from './workspace-paths.js'
import type { DshForegroundProcessGroup } from '../adapters/dsh/foreground-process.js'
import { frameworkErrorText } from './client-error.js'
import type { SafetyPresentation } from './safety-net.js'
import type { StorageUsageStats } from '../contracts/retention.js'
import type { ManualTaskCleanupPreview, ManualFileCleanupPreview, ManualConversationCleanupPreview, ManualCleanupResult } from './manual-cleanup.js'
import type { FrameworkKnowledge, KnowledgeEdit } from './knowledge.js'
export type FrameworkMode = 'local' | 'git'
export interface FrameworkTaskStateCursor { owner: string; generation: number }
export type FrameworkTaskStateUpdate = FrameworkTaskStateCursor & {
  sequence: number
  task: Pick<FrameworkClientTask, 'taskId' | 'lifecycleId' | 'status' | 'control'>
} & ({ gitRevision: string; localRevision?: never } | { localRevision: string; gitRevision?: never })
export interface FrameworkTaskControlSubmission {
  submitted: true
  commandId: string
  taskId: string
  lifecycleId?: string
  intent: 'running' | 'paused' | 'cancelled'
}
export interface FrameworkExecutionStopSubmission {
  submitted: true
  commandId: string
  workId: string
  executionId: string
}
export type FrameworkClientChange = { domain: 'task-state'; mode: FrameworkMode; collaborationId: string; storageScope: string; update: FrameworkTaskStateUpdate } | { domain: 'conversation'; mode: FrameworkMode } | { domain: 'safety'; mode: FrameworkMode; occurrence: number; owner: string }
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
  attachments?: ConversationAttachmentReference[]
  id: string; participantId: string; createdAt: string; role: 'user' | 'assistant' | 'system'; text: string; source?: string
  device?: string; replyTo?: string; recipient?: 'ai' | 'human'; model?: string; modelVersion?: string
}
export interface FrameworkClientProcessGroup extends DshForegroundProcessGroup { participantId?: string; afterMessageId?: string }
export interface FrameworkClientExecution {
  workId: string; executionId: string; sessionId: string; role: FrameworkClientRole; state: string; member?: string; workerId?: string; detail?: string
}
export interface FrameworkClientTask {
  taskId: string; title: string; route: 'P' | 'O'; owner: string; status: 'running' | 'complete' | 'cancelled'; lifecycleId?: string
  control?: 'running' | 'paused' | 'cancelled'
  /** Existing Task relation; used to describe root versus child finalization. */
  parentTaskId?: string
  /** Original identity is visible while its own one-time physical restoration remains unfinished. */
  originalSource?: 'local-sql'
  /** Historical identity has no live execution or control responsibility. */
  archived?: true
  members: Array<{ name: string; status: string }>
  executions: FrameworkClientExecution[]
  resultPaths: string[]
  workspaceResults?: Array<PhysicalWorkspaceReference | string>
}
export interface FrameworkClientResource {
  name: string; status: string; instanceUUID?: string; workerSeats?: number; detail?: string
}
export interface FrameworkLegacyTask {
  migrationId: string; oldTaskId: string; taskId: string
  continuation: 'running' | 'wait-result' | 'wait-user' | 'paused' | 'cancelled' | 'complete' | 'unresolved'
  recordPath?: string; recordsAvailable?: boolean; issues?: string[]
  artifacts?: Array<{ id: string; sourcePath: string; originalAbsolutePath?: string; sha256?: string; archivedPath?: string; status: 'archived' | 'pending' | 'unavailable'; detail?: string }>
  waits?: Array<{ id: string; question: string; memberIdentity: string }>
}
export interface FrameworkLocalUpgradeStatus {
  status: 'running' | 'pending' | 'complete'
  sourcePath?: string
  detail?: string
  pending?: Array<{ path: string; reason: string }>
  conflicts?: Array<{ path: string; operationId: string }>
  keptCurrent?: ReadonlyArray<{ path: string; target: 'absent' | 'different-inode' }>
  retainedStageChoices?: Array<{ path: string; operationId: string; owner?: LocalUpgradeSpecialStageOwner }>
  keptRetainedStages?: ReadonlyArray<{ path: string; selectedAt: string; owner?: LocalUpgradeSpecialStageOwner }>
  sourceDisposition?: 'retained-pending-retirement-review'
  sourceAudit?: LocalSourceRetirementAudit
}
export interface FrameworkClientView {
  localUpgrade?: FrameworkLocalUpgradeStatus
  originalTaskRead?: 'loading' | 'failed'
  taskStateCursor?: FrameworkTaskStateCursor
  faultOccurrence?: number
  faultOwner?: string
  hasOtherInstanceRecords?: boolean
  foregroundProcessing?: { executionId: string; turnId: string; startedAt?: number }
  foregroundProcessGroups?: FrameworkClientProcessGroup[]
  processGroups?: FrameworkClientProcessGroup[]
  pendingRecordMove?: { commandId: string; storageScope: string; expectedRevision: string; directory: string }
  /** This request's response only; a current location is not an old command receipt. */
  recordMoveOutcome?: { status: 'applied' | 'current-location'; commandId: string; requestedDirectory: string; directory: string; retainedSource?: string; sourceCleanup?: { retained: Array<{ directory: string; reason: string }> } }
  revision: string
  activeMode: FrameworkMode
  collaborationId: string
  storageScope?: string
  settings: FrameworkClientSettings
  connection: { participating: boolean; status: string; detail?: string; member?: string; workerSeats?: number; instanceUUID?: string }
  messages: FrameworkClientMessage[]
  missingBodies?: Array<{ id: string; path: string }>
  pageBefore?: string
  pageAfter?: string
  historyDate?: string
  historyWindow?: boolean
  tasks: FrameworkClientTask[]
  legacyTasks: FrameworkLegacyTask[]
  archives: Array<{ path: string; title: string; taskId?: string; originalTaskId?: string; files?: string[]; workspaceResults?: Array<PhysicalWorkspaceReference | string>; missingReferences?: string[]; skillPublication?: { issues: string[]; unmerged: Array<{ path: string; reason: string; proposalPreservedAt: string }> } }>
  resources: FrameworkClientResource[]
  executions?: FrameworkClientExecution[]
}
export interface FrameworkSendInput {
  attachments?: ConversationAttachmentReference[]
  mode: FrameworkMode; collaborationId: string; storageScope?: string; id: string; createdAt: string; text: string
  recipient: 'ai' | 'human'; replyTo?: string; device: string; timezoneOffsetMinutes: number
}
export interface FrameworkClientApi {
  selectLocalAttachment?(input: { mode: 'local'; collaborationId: string; storageScope?: string; selectionId: string; path: string; name: string; mimeType: string }, signal?: AbortSignal): Promise<{ attachment: ConversationAttachmentReference; storageScope: string }>
  openLocalAttachment?(input: { mode: 'local'; collaborationId: string; storageScope?: string; reference: ConversationAttachmentReference }, signal?: AbortSignal): Promise<{ path: string }>
  uploadAttachment?(input: { mode: 'git'; collaborationId: string; storageScope?: string; uploadId: string; name: string; mimeType: string; bytes: number }, file: Blob, signal?: AbortSignal): Promise<{ attachment: ConversationAttachmentReference; storageScope: string }>
  attachment?(input: { mode: FrameworkMode; collaborationId: string; storageScope?: string; reference: ConversationAttachmentReference }, signal?: AbortSignal): Promise<{ downloadUrl: string; mimeType: string; bytes: number }>

  clientFault?(input: { mode: FrameworkMode; storageScope?: string; source: string; message: string; code?: string; target?: string; occurrence?: number; displayOwner?: string }): Promise<SafetyPresentation | undefined>
  maintenanceView(input: { mode: 'local'; storageScope?: string }): Promise<{ localDirectory: string; recordsDirectory?: string; nativeDirectory?: string; debugDirectory?: string; usage: StorageUsageStats }>
  openMaintenancePath(input: { mode: 'local'; storageScope?: string; target: 'records' | 'native-logs' | 'debug' }): Promise<{ path: string }>
  keepCurrentLocalUpgradeTarget(input: { mode: 'local'; storageScope: string; operationId: string; path: string;
    stageOwner?: LocalUpgradeSpecialStageOwner;
    confirmation: 'keep-current-with-original-unexported' | 'keep-retained-stage-without-cleanup' }): Promise<{ saved: boolean }>
  exportRecords(input: { mode: 'local'; storageScope?: string; recordPath?: string; taskId?: string; migrationId?: string; oldTaskId?: string }): Promise<{ path: string; sha256: string; bytes: number }>
  cleanupPreview(input: { mode: 'local'; storageScope?: string; action?: 'tasks' | 'conversation' | 'planning' | 'debug' }): Promise<ManualTaskCleanupPreview | ManualFileCleanupPreview | ManualConversationCleanupPreview>
  cleanupRecords(input: { mode: 'local'; storageScope?: string; commandId: string } & (
    { action: 'tasks'; preview: ManualTaskCleanupPreview; confirmation: 'clear-ended-task-records' }
    | { action: 'conversation'; preview: ManualConversationCleanupPreview; confirmation: 'clear-foreground-conversation' }
    | { action: 'planning'; preview?: ManualFileCleanupPreview; confirmation: 'clear-work-planning-notes' }
    | { action: 'debug'; preview: ManualFileCleanupPreview; confirmation: 'clear-debug-records' })): Promise<ManualCleanupResult>
  view(input: { mode?: FrameworkMode; includeArchives?: boolean; headerOnly?: boolean; panelsOnly?: boolean; refreshOriginalTasks?: boolean }, signal?: AbortSignal): Promise<FrameworkClientView>
  history(input: { mode: FrameworkMode; collaborationId: string; storageScope?: string; beforeId?: string; afterId?: string; date?: string; limit: number; live?: boolean }, signal?: AbortSignal): Promise<{ messages: FrameworkClientMessage[]; processGroups?: FrameworkClientProcessGroup[]; moreBefore?: string; moreAfter?: string; revision: string; order: string[]; selectedIds?: string[]; missingBodies?: Array<{ id: string; path: string }>; storageScope?: string; reset?: boolean; day?: string; cursor?: string }>
  send(input: FrameworkSendInput): Promise<{ storageScope: string }>
  /** Settings/native lifecycle receipt only; view/history own their independent display reads. */
  configure(input: { mode: FrameworkMode; commandId: string; settings: FrameworkClientSettings; changedFields?: Array<keyof FrameworkClientSettings> }): Promise<FrameworkClientView>
  foregroundModel(input: { mode: FrameworkMode; storageScope?: string; commandId: string; model?: FrameworkClientModel }): Promise<FrameworkClientView>
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
  taskControl(input: { mode: FrameworkMode; storageScope?: string; commandId: string; taskId: string; lifecycleId?: string; intent: 'running' | 'paused' | 'cancelled' }): Promise<FrameworkTaskControlSubmission>
  stopExecution(input: { mode: FrameworkMode; storageScope?: string; commandId: string; workId: string; executionId: string }): Promise<FrameworkExecutionStopSubmission>
  /** Native participation lifecycle receipt; panel/history refresh is not part of success. */
  participation(input: { mode: FrameworkMode; enabled: boolean }): Promise<FrameworkClientView>
  selectMode(input: { mode: FrameworkMode; headerOnly?: boolean }): Promise<FrameworkClientView>
  readFile(input: { mode: FrameworkMode; storageScope?: string; path: string; reference?: PhysicalWorkspaceReference; originalTaskId?: string }): Promise<{ path: string; nativePath?: string; text?: string; downloadUrl?: string; binary?: { bytes: number; sha256: string; downloadUrl: string }; revision: string }>
  openWorkspaceFile?(input: { mode: FrameworkMode; storageScope?: string; path: string; reference: PhysicalWorkspaceReference }): Promise<{ path: string }>
  subscribeChanged(listener: (change?: FrameworkClientChange) => void, availability?: (available: boolean) => void): () => void
}
type FrameworkMessagePage = Pick<Awaited<ReturnType<FrameworkClientApi['history']>>, 'messages' | 'processGroups' | 'order' | 'selectedIds' | 'missingBodies' | 'storageScope' | 'moreBefore' | 'moreAfter' | 'day'>

export interface FrameworkDraft { input: FrameworkSendInput; state: 'draft' | 'sending' | 'failed' | 'sent'; error?: string }
export interface FrameworkClientSnapshot { value?: FrameworkClientView; loading: boolean; error?: string; drafts: readonly FrameworkDraft[] }
export const frameworkScopeKey = (mode: FrameworkMode, collaborationId: string, storageScope?: string) => JSON.stringify([mode, collaborationId, storageScope])

/** An in-memory client controller keeps original drafts across page/mode changes.
 * It does not persist remote conversation bodies or cancel Host sends on unmount.
 */
export class FrameworkClientController {
  private taskStateUpdates?: { key: string; cursor: FrameworkTaskStateCursor; updates: Map<string, FrameworkTaskStateUpdate> }
  private current: FrameworkClientSnapshot = { loading: false, drafts: [] }
  private readonly listeners = new Set<() => void>()
  private initialHeader?: { mode?: FrameworkMode; controller: AbortController; promise: Promise<FrameworkClientView> }
  private viewRead?: { controller: AbortController; mode?: FrameworkMode; revision: string; collaborationId: string; dirty: boolean; includeArchives: boolean; refreshOriginalTasks: boolean; publish: (view: FrameworkClientView) => void; isCurrent: () => boolean; promise: Promise<FrameworkClientView> }
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
  // History and current reception have independent lifetimes in both modes.
  // A slow old page cannot delay current content. Panels never publish messages.
  private readonly messageLanes = new Map<string, Promise<unknown>>()
  private messageReadSequence = 0
  // Local pages carry the full index, not a Git daily shard. Keep only read
  // originals and the latest admitted index so an older page cannot resurrect
  // removals or overwrite a body already received from a later read request.
  private localMessageAuthority?: { key: string; sequence: number; order: readonly string[]; originals: Map<string, FrameworkClientMessage>; missing: Map<string, { id: string; path: string }>; latest?: { sequence: number; page: FrameworkMessagePage } }
  private messageRefresh?: { key: string; dirty: boolean; controller: AbortController; promise: Promise<void> }
  private conversationVisible = false
  private conversationTimer?: ReturnType<typeof setTimeout>
  // The current daily file owns its visible order. History only backfills that
  // day, never replacing live originals or resurrecting rows that it removed.
  private liveMessageView?: { key: string; day: string; order: readonly string[] }
  private readonly historyDayViews = new Set<{ key: string; orders: Map<string, readonly string[]> }>()
  // A live pagination cursor, not a commit clock or a persistent body cache.
  private messageCursor?: { key: string; afterId?: string }
  private readonly messageDays = new WeakMap<FrameworkClientMessage, string>()
  private gitLatestSelection?: { key: string; generation: number }
  /** Only exact unfinished old-day reads already required by an observed rollover.
   * Successful page incorporation or closing this scope releases them; no timer or persisted queue. */
  private readonly liveDayTails = new Map<string, { day: string; afterId: string; page?: FrameworkMessagePage;
    owner: NonNullable<ReturnType<FrameworkClientController['messageOwner']>>; pending?: Promise<void>; controller?: AbortController }>()
  private readonly sends = new Map<string, Promise<void>>()
  // Display ownership is separate from immutable write arguments. A cold
  // header may resolve after the original send has failed or become UNKNOWN.
  private readonly draftOwners = new Map<string, { navigation: number; revision: string; storageScope?: string }>()
  private readonly localMessageReads = new Set<{ key: string; current: () => boolean }>()
  constructor(readonly api: FrameworkClientApi) {}
  /** The visible conversation owns reception, independently of participation and send acknowledgements. */
  setConversationVisible(visible: boolean): void {
    if (this.conversationVisible === visible) return
    this.conversationVisible = visible
    this.clearConversationTimer()
    if (!visible) {
      const read = this.messageRefresh
      this.messageRefresh = undefined
      read?.controller.abort()
      for (const tail of this.liveDayTails.values()) tail.controller?.abort()
    } else if (this.canRefreshConversation()) void this.refreshMessages(false).catch(() => {})
  }
  private canRefreshConversation(): boolean {
    return this.conversationVisible && this.connectionReferences > 0 && !this.navigation && this.current.value?.activeMode === 'git'
  }
  private clearConversationTimer(): void {
    if (this.conversationTimer !== undefined) clearTimeout(this.conversationTimer)
    this.conversationTimer = undefined
  }
  private scheduleConversationRefresh(): void {
    if (!this.canRefreshConversation()) { this.clearConversationTimer(); return }
    if (this.conversationTimer !== undefined || this.messageRefresh) return
    this.conversationTimer = setTimeout(() => {
      this.conversationTimer = undefined
      if (this.canRefreshConversation()) void this.refreshMessages(false).catch(() => {})
    }, 1000)
  }
  retainConnection(): () => void {
    if (this.connectionReferences++ === 0) {
      this.disconnect = this.api.subscribeChanged(change => {
        if (change?.domain === 'safety') return
        if (change?.domain === 'task-state') { this.acceptTaskState(change); return }
        if (change?.domain === 'conversation' && change.mode === 'git' && this.current.value) {
          if (this.current.value.activeMode === 'git') void this.refreshMessages().catch(() => {})
        } else void this.refresh().catch(() => {})
      }, available => {
        this.processingAvailable = available
        if (!available) {
          this.processingEpoch++
          if ((this.current.value?.foregroundProcessing || this.current.value?.foregroundProcessGroups?.length)) this.publish({ value: { ...this.current.value, foregroundProcessing: undefined, foregroundProcessGroups: undefined } })
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
    this.clearConversationTimer()
    this.messageRefresh?.controller.abort()
    this.initialHeader = undefined; this.viewRead = undefined; this.messageRefresh = undefined
    header?.controller.abort(); body?.controller.abort()
    this.historyReads.abort(); this.historyReads = new AbortController()
    this.liveDayTails.clear(); this.gitLatestSelection = undefined
  }
  snapshot = (): FrameworkClientSnapshot => this.current
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(change: Partial<FrameworkClientSnapshot>): void {
    const before = this.current.value, after = change.value
    const resolved = before && after && before.storageScope === undefined && after.storageScope !== undefined
      && before.revision === after.revision && before.activeMode === after.activeMode && before.collaborationId === after.collaborationId
    if (before && after && !resolved && frameworkScopeKey(before.activeMode, before.collaborationId, before.storageScope) !== frameworkScopeKey(after.activeMode, after.collaborationId, after.storageScope)) this.historyGeneration++
    const replaced = before?.storageScope !== undefined && after?.storageScope !== undefined
      && frameworkScopeKey(before.activeMode, before.collaborationId, before.storageScope) !== frameworkScopeKey(after.activeMode, after.collaborationId, after.storageScope)
    if (replaced) { ++this.navigationGeneration; this.historyReads.abort(); this.historyReads = new AbortController(); this.messageRefresh = undefined }
    this.current = { ...this.current, ...change }
    if (after?.storageScope !== undefined && !this.navigation) for (const draft of this.current.drafts) {
      const owner = this.draftOwners.get(draft.input.id)
      if (owner && owner.storageScope === undefined && owner.navigation === this.navigationGeneration
        && owner.revision === after.revision && draft.input.mode === after.activeMode && draft.input.collaborationId === after.collaborationId) owner.storageScope = after.storageScope
    }
    const displayed = after ?? this.current.value
    // The send receipt and an actually displayed authoritative original have
    // both arrived. Retire only that draft, never a failed/UNKNOWN send or an
    // acknowledged Local send whose original has not reached the page yet.
    if (displayed) this.current = { ...this.current, drafts: this.current.drafts.filter(draft => {
      const scope = draft.input.storageScope ?? this.draftOwners.get(draft.input.id)?.storageScope
      const displayedOriginal = draft.state === 'sent' && scope === displayed.storageScope
        && draft.input.mode === displayed.activeMode && draft.input.collaborationId === displayed.collaborationId
        && displayed.messages.some(message => message.id === draft.input.id && message.role === 'user' && message.text === draft.input.text
          && JSON.stringify(message.attachments ?? []) === JSON.stringify(draft.input.attachments ?? []))
      if (displayedOriginal) this.draftOwners.delete(draft.input.id)
      return !displayedOriginal
    }) }
    this.pruneLocalMessageAuthority()
    for (const listener of this.listeners) listener()
    if (replaced && !this.navigation) void this.refreshMessages().catch(() => {})
    this.scheduleConversationRefresh()
  }
  pendingDrafts(): readonly FrameworkDraft[] {
    const view = this.current.value
    if (!view) return []
    return this.current.drafts.filter(draft => {
      if (draft.input.mode !== view.activeMode || draft.input.collaborationId !== view.collaborationId) return false
      const owner = this.draftOwners.get(draft.input.id), scope = draft.input.storageScope ?? owner?.storageScope
      const belongs = scope !== undefined ? scope === view.storageScope
        : view.storageScope === undefined && !!owner && owner.navigation === this.navigationGeneration && owner.revision === view.revision && !this.navigation
      if (draft.input.mode === 'git') return belongs && draft.state !== 'sent'
      return belongs && (draft.state !== 'sent' || (!view.messages.some(message => message.id === draft.input.id && message.role === 'user' && message.text === draft.input.text && JSON.stringify(message.attachments ?? []) === JSON.stringify(draft.input.attachments ?? []))))
    })
  }
  private acceptTaskState(change: Extract<FrameworkClientChange, { domain: 'task-state' }>): void {
    const view = this.current.value, update = change.update
    if ((change.mode === 'git' ? update.gitRevision === undefined : update.localRevision === undefined)
      || !view || this.navigation || view.activeMode !== change.mode || view.collaborationId !== change.collaborationId
      || view.storageScope !== change.storageScope || !view.taskStateCursor || view.taskStateCursor.owner !== update.owner
      || update.generation < view.taskStateCursor.generation) return
    const task = view.tasks.find(task => task.taskId === update.task.taskId)
    if (!task || (task.lifecycleId ?? '') !== (update.task.lifecycleId ?? '')) return
    const key = frameworkScopeKey(view.activeMode, view.collaborationId, view.storageScope)
    let observed = this.taskStateUpdates
    if (!observed || observed.key !== key || observed.cursor.owner !== update.owner || observed.cursor.generation !== update.generation)
      observed = this.taskStateUpdates = { key, cursor: { owner: update.owner, generation: update.generation }, updates: new Map() }
    if ((observed.updates.get(task.taskId)?.sequence ?? -1) >= update.sequence) return
    observed.updates.set(task.taskId, structuredClone(update))
    // This is an already-read Git projection, not button optimism. No loading
    // generation, Host action, history read, view RPC or timer is involved.
    if (task.status === update.task.status && task.control === update.task.control && view.taskStateCursor.generation === update.generation) return
    this.publish({ value: this.applyTaskStates({ ...view, taskStateCursor: observed.cursor }) })
  }
  private applyTaskStates(value: FrameworkClientView): FrameworkClientView {
    const cursor = value.taskStateCursor, key = frameworkScopeKey(value.activeMode, value.collaborationId, value.storageScope)
    if (!cursor) { this.taskStateUpdates = undefined; return value }
    let observed = this.taskStateUpdates
    if (!observed || observed.key !== key || observed.cursor.owner !== cursor.owner || observed.cursor.generation < cursor.generation)
      observed = this.taskStateUpdates = { key, cursor, updates: new Map() }
    const tasks = value.tasks.map(task => {
      const update = observed.updates.get(task.taskId)?.task
      return update && (update.lifecycleId ?? '') === (task.lifecycleId ?? '')
        ? { ...task, status: update.status, control: update.control } : task
    })
    return { ...value, taskStateCursor: observed.cursor, tasks }
  }
  private displayView(value: FrameworkClientView, epoch: number): FrameworkClientView {
    return this.processingAvailable && epoch === this.processingEpoch ? value : { ...value, foregroundProcessing: undefined, foregroundProcessGroups: undefined }
  }
  private publishFailure(error: unknown, settled = false): void {
    // A failed owned read is not current evidence that the native turn is active.
    this.processingEpoch++
    this.publish({ ...(settled ? { loading: false } : {}), error: frameworkErrorText(error),
      ...((this.current.value?.foregroundProcessing || this.current.value?.foregroundProcessGroups?.length) ? { value: { ...this.current.value, foregroundProcessing: undefined, foregroundProcessGroups: undefined } } : {}) })
  }
  private async load(operation: (publishIntermediate: (value: FrameworkClientView) => void, isCurrent: () => boolean) => Promise<FrameworkClientView>, scopedMode?: FrameworkMode, hydrate = false): Promise<void> {
    // An action still belongs to its original scope, but its result must not
    // replace a newer mode/settings navigation. Do not cancel the Host action.
    if (scopedMode && (this.navigation || (this.requestedMode && scopedMode !== this.requestedMode))) { await operation(() => {}, () => false); return }
    const generation = ++this.generation, processingEpoch = this.processingAvailable ? this.processingEpoch : -1
    const project = (value: FrameworkClientView) => this.displayView(this.refreshView(value, true), processingEpoch)
    this.publish({ loading: true, error: undefined })
    try {
      const value = await operation(value => { if (generation === this.generation) this.publish({ value: project(value) }) }, () => generation === this.generation)
      if (generation === this.generation) {
        this.publish({ value: project(value), loading: false })
        // Display follows the receipt independently; refresh owns its own
        // failure and never changes the outcome of this completed action.
        if (hydrate) void this.refresh().catch(() => {})
      }
    }
    catch (error) { if (generation === this.generation) this.publishFailure(error, true); throw error }
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
        this.publishFailure(error, true)
      }
      throw error
    }
  }
  refresh = (includeArchives = false, hydrate = false, refreshOriginalTasks = false): Promise<void> => this.load(async (publishHeader, isCurrent) => {
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
    void this.refreshMessages().catch(() => {})
    const targetMode = mode ?? this.current.value?.activeMode
    let request: Promise<FrameworkClientView>
    let hydration: typeof this.viewRead
    const currentHeader = this.current.value!
    const existing = this.viewRead
    if (existing && existing.mode === targetMode && existing.revision === currentHeader.revision
      && existing.collaborationId === currentHeader.collaborationId) {
      hydration = existing
      hydration.dirty = true; hydration.includeArchives ||= includeArchives; hydration.refreshOriginalTasks ||= refreshOriginalTasks
      hydration.publish = publishHeader; hydration.isCurrent = isCurrent
      request = hydration.promise
    } else {
      existing?.controller.abort()
      const owned = { controller: new AbortController(), mode: targetMode, revision: currentHeader.revision, collaborationId: currentHeader.collaborationId,
        navigation: this.navigationGeneration,
        dirty: false, includeArchives, refreshOriginalTasks, publish: publishHeader, isCurrent, promise: undefined as unknown as Promise<FrameworkClientView> }
      const eligible = () => { const current = this.current.value; return this.viewRead === owned && owned.navigation === this.navigationGeneration && owned.isCurrent()
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
            const refreshOriginalTasks = owned.refreshOriginalTasks; owned.refreshOriginalTasks = false
            result = await this.api.view({ mode: targetMode, includeArchives: owned.includeArchives, panelsOnly: true, ...(refreshOriginalTasks ? { refreshOriginalTasks: true } : {}) }, owned.controller.signal)
            if (!eligible()) return result
            // The still-owned response may contain a newer authoritative
            // settings projection. Advance before publishing so synchronous
            // invalidations join this same responsibility, not a stale header.
            owned.revision = result.revision; owned.collaborationId = result.collaborationId
            result = this.refreshView(result, owned.includeArchives, published)
            owned.publish(result); published = true
            // A still-owned panel response may reveal a changed destination.
            // Keep its queued invalidation, but never re-own an actual UI
            // navigation that replaced this read while publishing.
            if (this.viewRead === owned && owned.isCurrent() && this.current.value?.activeMode === result.activeMode
              && this.current.value.revision === result.revision && this.current.value.collaborationId === result.collaborationId) owned.navigation = this.navigationGeneration
            if (!owned.dirty) return result
          }
          return result
        } catch (error) {
          if (eligible() && this.current.value) owned.publish({ ...this.current.value, foregroundProcessing: undefined, foregroundProcessGroups: undefined })
          throw error
        } finally { if (this.viewRead === owned) this.viewRead = undefined }
      })
      request = owned.promise
    }
    const panels = await request
    return this.refreshView(panels, includeArchives || !!hydration?.includeArchives)
  })
  private refreshView(value: FrameworkClientView, includeArchives: boolean, previousLoaded = true): FrameworkClientView {
    const current = this.current.value, fresh = { ...value, messages: [] as FrameworkClientMessage[], pageBefore: undefined as string | undefined,
      pageAfter: undefined as string | undefined, historyDate: undefined as string | undefined, historyWindow: undefined as boolean | undefined }
    // A failed/unresolved panel read carries settings, not evidence that the
    // conversation destination changed. Keep the message lane's bound scope
    // only while those exact settings still own the panel response.
    if (current?.storageScope !== undefined && fresh.storageScope === undefined && current.revision === fresh.revision
      && current.activeMode === fresh.activeMode && current.collaborationId === fresh.collaborationId) fresh.storageScope = current.storageScope
    if (!current || frameworkScopeKey(current.activeMode, current.collaborationId, current.storageScope)
      !== frameworkScopeKey(fresh.activeMode, fresh.collaborationId, fresh.storageScope)) return this.applyTaskStates(fresh)
    if (previousLoaded && !includeArchives) fresh.archives = current.archives
    return this.applyTaskStates({ ...fresh, messages: current.messages, missingBodies: current.missingBodies, processGroups: current.processGroups, pageBefore: current.pageBefore, pageAfter: current.pageAfter,
      historyDate: current.historyDate, historyWindow: current.historyWindow })
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
  private messageRead<T>(owner: NonNullable<ReturnType<FrameworkClientController['messageOwner']>>, operation: () => Promise<T>, history: boolean | 'latest-selection' = false): Promise<T | undefined> {
    const lane = history ? owner.key + ':' + (history === true ? 'history' : history) : owner.key
    const prior = this.messageLanes.get(lane)
    const pending = Promise.resolve(prior).catch(() => {}).then(async () => {
      if (!owner.current()) return undefined
      if (owner.mode === 'local') this.localMessageReads.add(owner)
      try { return await operation() } catch (error) {
        if (!owner.current()) return undefined
        this.publishFailure(error); throw error
      } finally {
        this.localMessageReads.delete(owner)
        this.pruneLocalMessageAuthority()
      }
    })
    this.messageLanes.set(lane, pending)
    void pending.finally(() => { if (this.messageLanes.get(lane) === pending) this.messageLanes.delete(lane) }).catch(() => {})
    return pending
  }
  private pruneLocalMessageAuthority(): void {
    const authority = this.localMessageAuthority
    if (!authority) return
    // A still-current older read may need a newer original when it returns.
    // Its actual request lifetime owns that protection, not permanent history.
    if ([...this.localMessageReads].some(read => read.key === authority.key && read.current())) return
    const view = this.current.value
    if (!view || view.activeMode !== 'local'
      || this.messageOwner()?.key !== authority.key) {
      this.localMessageAuthority = undefined
      return
    }
    const retained = new Set([...view.messages, ...authority.latest?.page.messages ?? []].map(message => message.id))
    for (const id of authority.originals.keys()) if (!retained.has(id)) authority.originals.delete(id)
    const missing = new Set([...view.missingBodies ?? [], ...authority.latest?.page.missingBodies ?? []].map(row => row.id))
    for (const id of authority.missing.keys()) if (!missing.has(id)) authority.missing.delete(id)
  }
  private applyMessages(owner: NonNullable<ReturnType<FrameworkClientController['messageOwner']>>, page: FrameworkMessagePage,
    intent: 'latest' | 'append' | 'history' | 'older' | 'live-tail', date?: string, settle = false, historyOrders?: ReadonlyMap<string, readonly string[]>, sequence = 0): void {
    if (!owner.current()) return
    const current = this.current.value!, scope = page.storageScope ?? owner.storageScope
    if (current.storageScope !== undefined && scope !== current.storageScope) return
    if (!Array.isArray(page.order) || page.messages.some(message => !page.order.includes(message.id))) throw new Error('Conversation read is missing its authoritative index.')
    let local: typeof this.localMessageAuthority
    if (owner.mode === 'local') {
      local = this.localMessageAuthority?.key === owner.key ? this.localMessageAuthority : undefined
      if (!local || sequence >= local.sequence) {
        local = this.localMessageAuthority = { key: owner.key, sequence, order: [...page.order], originals: new Map(local?.originals), missing: new Map(local?.missing), latest: local?.latest }
        for (const id of local.originals.keys()) if (!local.order.includes(id)) local.originals.delete(id)
        for (const id of local.missing.keys()) if (!local.order.includes(id)) local.missing.delete(id)
        for (const missing of page.missingBodies ?? []) { local.originals.delete(missing.id); local.missing.set(missing.id, missing) }
        for (const message of page.messages) { local.originals.set(message.id, structuredClone(message)); local.missing.delete(message.id) }
      }
      if (intent === 'latest' && sequence >= local.sequence && sequence >= (local.latest?.sequence ?? -1)) local.latest = { sequence, page: structuredClone(page) }
      const stale = sequence < local.sequence
      if (stale && (intent === 'append' || (intent === 'latest' && !settle))) return
      // A manual Latest selection may use an even later latest page already
      // received while a historical window was selected. No extra read is needed.
      if (stale && intent === 'latest' && local.latest && local.latest.sequence > sequence) page = local.latest.page
      for (const message of page.messages) if (local.order.includes(message.id) && !local.originals.has(message.id) && !local.missing.has(message.id)) local.originals.set(message.id, structuredClone(message))
      for (const missing of page.missingBodies ?? []) if (local.order.includes(missing.id) && !local.originals.has(missing.id) && !local.missing.has(missing.id)) local.missing.set(missing.id, missing)
      if (stale) {
        // A newer real read may have found the body missing or replaced. The
        // existing request authority owns both observations until old reads end.
        const selected = page.selectedIds ?? page.messages.map(row => row.id)
        page = { ...page,
          messages: selected.flatMap(id => local!.originals.has(id) ? [local!.originals.get(id)!] : []),
          missingBodies: selected.flatMap(id => local!.missing.has(id) ? [local!.missing.get(id)!] : []) }
      }
    }
    if (owner.mode === 'git' && page.day !== undefined && (intent === 'append' || intent === 'latest')) {
      this.liveMessageView = { key: owner.key, day: page.day, order: page.order }
      for (const history of this.historyDayViews) if (history.key === owner.key) history.orders.set(page.day, page.order)
    }
    const liveOrder = intent === 'older' && page.day !== undefined
      ? historyOrders?.get(page.day) ?? (this.liveMessageView?.key === owner.key && this.liveMessageView.day === page.day ? this.liveMessageView.order : undefined) : undefined
    const order = local?.order ?? liveOrder ?? page.order
    const keep = intent === 'append' || intent === 'live-tail' || intent === 'older' || (intent === 'latest' && (current.historyWindow || this.expandedHistory.has(frameworkScopeKey(current.activeMode, current.collaborationId, current.storageScope))))
    const rows = new Map((keep ? current.messages : []).map(message => [message.id, message]))
    if (!(current.historyWindow && (intent === 'latest' || intent === 'append'))) for (const message of page.messages) {
      if (liveOrder && (!order.includes(message.id) || rows.has(message.id))) continue
      if (owner.mode === 'git' && page.day !== undefined) this.messageDays.set(message, page.day)
      if (local && !order.includes(message.id)) continue
      rows.set(message.id, local?.originals.get(message.id) ?? message)
    }
    for (const missing of page.missingBodies ?? []) rows.delete(missing.id)
    const missingById = new Map((keep ? current.missingBodies ?? [] : []).map(row => [row.id, row]))
    for (const id of page.selectedIds ?? page.messages.map(row => row.id)) missingById.delete(id)
    for (const missing of page.missingBodies ?? []) missingById.set(missing.id, missing)
    const missingBodies = order.flatMap(id => missingById.has(id) ? [missingById.get(id)!] : [])
    // A Git page owns one daily file, including its empty contents. Cached
    // originals from other days remain readable until those files are read.
    const messages = owner.mode === 'git'
      ? [...rows.values()].filter(message => this.messageDays.get(message) !== page.day)
        .concat(order.flatMap(id => { const message = rows.get(id); return message && this.messageDays.get(message) === page.day ? [message] : [] }))
        .sort((left, right) => (this.messageDays.get(left) ?? '').localeCompare(this.messageDays.get(right) ?? ''))
      : order.flatMap(id => rows.has(id) ? [local?.originals.get(id) ?? rows.get(id)!] : [])
    const processes = new Map((keep ? current.processGroups ?? [] : []).map(group => [group.id, group]))
    const newerLocalProcesses = local?.latest && local.latest.sequence >= sequence
      ? new Map((local.latest.page.processGroups ?? []).map(group => [group.id, group])) : undefined
    if (newerLocalProcesses) for (const id of processes.keys()) {
      const currentGroup = newerLocalProcesses.get(id)
      if (currentGroup) processes.set(id, currentGroup); else processes.delete(id)
    }
    if (!(current.historyWindow && (intent === 'latest' || intent === 'append'))) {
      if (owner.mode === 'git' && page.day) {
        for (const [id, group] of processes) if (new Date(group.startedAt).toISOString().slice(0, 10) === page.day) processes.delete(id)
      }
      for (const group of page.processGroups ?? []) {
        if (newerLocalProcesses && !newerLocalProcesses.has(group.id)) continue
        processes.set(group.id, newerLocalProcesses?.get(group.id) ?? (local && sequence < local.sequence ? processes.get(group.id) ?? group : group))
      }
    }
    const retainedCursor = (cursor?: string) => owner.mode === 'git' ? cursor : cursor && order.includes(cursor) ? cursor : undefined
    const beforeDay = current.pageBefore && /^day:(\d{4}-\d{2}-\d{2}):/.exec(current.pageBefore)?.[1]
    const cursors = intent === 'live-tail' ? { pageBefore: page.messages.length && (!current.pageBefore || beforeDay && page.day && beforeDay > page.day)
      ? page.moreBefore : current.pageBefore, pageAfter: current.pageAfter } : intent === 'append' ? { pageBefore: owner.mode === 'git' && !current.messages.length && !current.historyWindow
      ? current.pageBefore ?? page.moreBefore : retainedCursor(current.pageBefore), pageAfter: retainedCursor(current.pageAfter) }
      : intent === 'older' ? { pageBefore: retainedCursor(page.moreBefore), pageAfter: retainedCursor(current.pageAfter) }
      : intent === 'latest' && (current.historyWindow || this.expandedHistory.has(frameworkScopeKey(current.activeMode, current.collaborationId, current.storageScope))) ? { pageBefore: retainedCursor(current.pageBefore),
        pageAfter: retainedCursor(current.pageAfter) }
      : { pageBefore: retainedCursor(page.moreBefore), pageAfter: retainedCursor(page.moreAfter) }
    this.publish({ ...(settle ? { loading: false, error: undefined } : {}), value: { ...current, storageScope: scope, messages, missingBodies, processGroups: [...processes.values()], ...cursors,
      ...(intent === 'history' ? { historyDate: date, historyWindow: true } : {}) } })
  }
  private publishLiveDayTails(): void {
    if (this.current.value?.historyWindow || this.gitLatestSelection) return
    for (const [key, read] of this.liveDayTails) if (read.page && read.owner.current()) {
      try {
        this.applyMessages(read.owner, read.page, 'live-tail')
        this.liveDayTails.delete(key)
      } catch (error) {
        // Failed old-day presentation must not stop today's independent read.
        // Keep its original cursor, not a permanently failed cached page.
        read.page = undefined
        this.publishFailure(error)
      }
    }
  }
  private readLiveDayTails(): void {
    this.publishLiveDayTails()
    for (const [key, read] of this.liveDayTails) {
      if (!read.owner.current()) { read.controller?.abort(); this.liveDayTails.delete(key); continue }
      if (read.pending || read.page) continue
      const controller = read.controller = new AbortController()
      const signal = AbortSignal.any([read.owner.signal, controller.signal])
      const operation = (async () => {
        try {
          const page = await this.api.history({ mode: 'git', collaborationId: read.owner.collaborationId,
            storageScope: read.owner.storageScope, limit: 20, live: true, date: read.day, afterId: read.afterId }, signal)
          if (signal.aborted) return
          if (!read.owner.current() || this.liveDayTails.get(key) !== read) {
            if (this.liveDayTails.get(key) === read) this.liveDayTails.delete(key)
            return
          }
          read.page = page
          this.publishLiveDayTails()
        } catch (error) {
          // Keep this exact unfinished cursor for the existing refresh cadence,
          // while today's independent read remains able to display new content.
          if (read.owner.current()) { if (!controller.signal.aborted) this.publishFailure(error) }
          else this.liveDayTails.delete(key)
        }
      })()
      read.pending = operation
      void operation.finally(() => { if (read.pending === operation) { read.pending = undefined; read.controller = undefined } }).catch(() => {})
    }
  }
  private observeLiveRollover(owner: NonNullable<ReturnType<FrameworkClientController['messageOwner']>>, afterId: string | undefined, day: string | undefined): void {
    const before = afterId && /^day:(\d{4}-\d{2}-\d{2}):/.exec(afterId)?.[1]
    if (!before || !day || before === day) return
    const key = JSON.stringify([owner.key, before])
    if (!this.liveDayTails.has(key)) this.liveDayTails.set(key, { day: before, afterId: afterId!, owner })
    this.readLiveDayTails()
  }
  private refreshMessages(invalidated = true): Promise<void> {
    const scopeOwner = this.messageOwner()
    if (!scopeOwner) return Promise.resolve()
    this.readLiveDayTails()
    this.clearConversationTimer()
    if (this.messageRefresh?.key === scopeOwner.key) { this.messageRefresh.dirty ||= invalidated; return this.messageRefresh.promise }
    const controller = new AbortController()
    const owner = { ...scopeOwner, signal: AbortSignal.any([scopeOwner.signal, controller.signal]), current: () => !controller.signal.aborted && scopeOwner.current() }
    const read = { key: owner.key, dirty: false, controller, promise: undefined as unknown as Promise<void> }
    this.messageRefresh = read
    read.promise = (async () => {
      do {
        read.dirty = false
        await this.messageRead(owner, async () => {
          const sequence = ++this.messageReadSequence, selection = this.historyGeneration
          const selectingLatest = this.gitLatestSelection?.key === owner.key
          const live = owner.mode === 'git', afterId = live && this.messageCursor?.key === owner.key ? this.messageCursor.afterId : undefined
          const page = await this.api.history({ mode: owner.mode, collaborationId: owner.collaborationId, storageScope: owner.storageScope,
            limit: 20, live: true, ...(live && afterId ? { afterId } : {}) }, owner.signal)
          if (live && (selection !== this.historyGeneration || selectingLatest || this.gitLatestSelection?.key === owner.key)) return
          this.applyMessages(owner, page, live ? 'append' : 'latest', undefined, false, undefined, sequence)
          if (live && owner.current()) {
            this.messageCursor = { key: owner.key, afterId: page.cursor }
            this.observeLiveRollover(scopeOwner, afterId, page.day)
          }
        })
      } while (read.dirty && owner.current() && this.messageRefresh === read)
    })().finally(() => { if (this.messageRefresh === read) { this.messageRefresh = undefined; this.scheduleConversationRefresh() } })
    return read.promise
  }
  selectMode = (mode: FrameworkMode): Promise<void> => { this.requestedMode = mode; return this.navigate(() => this.api.selectMode({ mode, headerOnly: true }), mode, true) }
  taskControl = async (input: Parameters<FrameworkClientApi['taskControl']>[0]): Promise<void> => {
    const before = this.current.value, navigation = this.navigationGeneration
    const scope = before && frameworkScopeKey(before.activeMode, before.collaborationId, before.storageScope)
    const ownsScope = () => {
      const current = this.current.value
      return !this.navigation && navigation === this.navigationGeneration && current?.activeMode === input.mode
        && scope === frameworkScopeKey(current.activeMode, current.collaborationId, current.storageScope)
        && (input.storageScope === undefined || input.storageScope === current.storageScope)
    }
    if (ownsScope()) this.publish({ error: undefined })
    try {
      // Submission confirms the write only. The button owns its local busy
      // state; independent reads and Host projections keep their own lifetimes.
      // Never manufacture task state or start a view/history read from receipt.
      await this.api.taskControl(input)
    } catch (error) {
      if (ownsScope()) this.publishFailure(error)
      throw error
    }
  }
  stopExecution = async (input: Parameters<FrameworkClientApi['stopExecution']>[0]): Promise<void> => {
    // Submission may acknowledge an already ended execution without a new write.
    // Periodic Host projections report native state independently of this call.
    await this.api.stopExecution(input)
  }
  legacyControl = (input: Parameters<FrameworkClientApi['legacyControl']>[0]): Promise<void> => this.load(() => this.api.legacyControl(input), input.mode)
  private settingsResult(result: FrameworkClientView): FrameworkClientView {
    const current = this.current.value
    const destination = (value: FrameworkClientView) => JSON.stringify([value.activeMode, value.collaborationId,
      value.activeMode === 'local' ? value.settings.localDirectory : [value.settings.ownerRepo, value.settings.repositoryDirectory]])
    if (!current || destination(current) !== destination(result)
      || (current.storageScope !== undefined && result.storageScope !== undefined && current.storageScope !== result.storageScope)) return result
    // Settings acknowledgements contain no fresh panels or history. Retain the
    // current display only for this same destination until its independent read.
    return { ...current, settings: result.settings, revision: result.revision, connection: result.connection,
      storageScope: result.storageScope ?? current.storageScope, executions: result.executions,
      faultOccurrence: result.faultOccurrence, faultOwner: result.faultOwner,
      foregroundProcessing: undefined, foregroundProcessGroups: undefined }
  }
  participation = (enabled: boolean): Promise<void> => {
    const before = this.current.value, mode = before?.activeMode ?? this.requestedMode ?? 'local'
    const scope = before && frameworkScopeKey(before.activeMode, before.collaborationId, before.storageScope)
    // Withdrawal owns this mode's latest connection intent. Retire a pending
    // configure projection, but never a newer navigation to a different mode.
    if (!enabled && (!this.requestedMode || this.requestedMode === mode)) this.navigation = undefined
    return this.load(async () => {
      const result = await this.api.participation({ mode, enabled }), current = this.current.value
      if (!current) return result
      if (current.activeMode !== mode || scope !== frameworkScopeKey(current.activeMode, current.collaborationId, current.storageScope)) return current
      return this.settingsResult(result)
    }, mode, enabled)
  }
  configure = (input: Parameters<FrameworkClientApi['configure']>[0]): Promise<void> => this.navigate(async () => this.settingsResult(await this.api.configure(input)), input.mode, true)
  foregroundModel = async (input: Parameters<FrameworkClientApi['foregroundModel']>[0]): Promise<void> => {
    const before = this.current.value, navigation = this.navigationGeneration
    const scope = before && frameworkScopeKey(before.activeMode, before.collaborationId, before.storageScope)
    try {
      const saved = await this.api.foregroundModel(input), current = this.current.value
      if (navigation !== this.navigationGeneration || (this.requestedMode && input.mode !== this.requestedMode)) return
      // A model chosen after closing pending settings belongs to that same
      // navigation. Its confirmed selection must outlive the earlier settings
      // projection, without another read or replacing a newer destination.
      const resolvedSameHeader = before && before.storageScope === undefined && current
        && before.activeMode === current.activeMode && before.collaborationId === current.collaborationId
        && saved.storageScope === current.storageScope
      if (current && (current.activeMode !== input.mode
        || (!resolvedSameHeader && scope !== frameworkScopeKey(current.activeMode, current.collaborationId, current.storageScope)))) return
      this.navigation = undefined
      ++this.generation
      // The saved settings/revision include prior same-mode configuration.
      // This receipt is not a new native observation: keep the current panels,
      // connection, executions, faults and processing for the same scope.
      const value = current ? { ...current, settings: saved.settings,
        revision: saved.revision, storageScope: current.storageScope ?? saved.storageScope } : saved
      this.publish({ value, loading: false, error: undefined })
    } catch (error) {
      if (navigation === this.navigationGeneration && this.current.value?.activeMode === input.mode) this.publishFailure(error, true)
      throw error
    }
  }

  async navigateHistory(input: { date?: string; beforeId?: string; afterId?: string; limit: number }): Promise<void> {
    const scopeOwner = this.messageOwner()
    if (!scopeOwner) return
    const generation = ++this.historyGeneration
    const owner = { ...scopeOwner, current: () => scopeOwner.current() && generation === this.historyGeneration }
    this.publish({ loading: true, error: undefined })
    try { await this.messageRead(owner, async () => {
      const sequence = ++this.messageReadSequence
      const page = await this.api.history({ mode: owner.mode, collaborationId: owner.collaborationId, storageScope: owner.storageScope, ...input }, owner.signal)
      if (!owner.current() || generation !== this.historyGeneration) return
      this.expandedHistory.delete(frameworkScopeKey(owner.mode, owner.collaborationId, page.storageScope ?? owner.storageScope))
      this.applyMessages(owner, page, 'history', input.date, true, undefined, sequence)
    }, true) } finally { if (owner.current()) this.publish({ loading: false }) }
  }
  latest = async (): Promise<void> => {
    const scopeOwner = this.messageOwner()
    if (!scopeOwner) return
    const generation = ++this.historyGeneration
    const owner = { ...scopeOwner, current: () => scopeOwner.current() && generation === this.historyGeneration }
    if (owner.mode === 'git') this.gitLatestSelection = { key: owner.key, generation }
    this.readLiveDayTails()
    this.publish({ loading: true, error: undefined })
    try { await this.messageRead(owner, async () => {
      const sequence = ++this.messageReadSequence
      const page = await this.api.history({ mode: owner.mode, collaborationId: owner.collaborationId, storageScope: owner.storageScope, limit: 20 }, owner.signal)
      if (!owner.current() || generation !== this.historyGeneration) return
      this.expandedHistory.delete(frameworkScopeKey(owner.mode, owner.collaborationId, page.storageScope ?? owner.storageScope))
      this.publish({ value: { ...this.current.value!, historyWindow: undefined, historyDate: undefined } })
      this.applyMessages(owner, page, 'latest', undefined, true, undefined, sequence)
      if (owner.mode === 'git') {
        const afterId = this.messageCursor?.key === owner.key ? this.messageCursor.afterId : undefined
        this.observeLiveRollover(scopeOwner, afterId, page.day)
        this.messageCursor = { key: owner.key, afterId: page.cursor }
      }
    }, 'latest-selection') } finally {
      if (this.gitLatestSelection?.key === owner.key && this.gitLatestSelection.generation === generation) this.gitLatestSelection = undefined
      if (owner.current()) { this.publish({ loading: false }); this.readLiveDayTails() }
    }
  }
  older(limit: number): Promise<void> {
    const value = this.current.value, scopeOwner = this.messageOwner()
    if (!value?.pageBefore || !scopeOwner) return Promise.resolve()
    const generation = this.historyGeneration, key = frameworkScopeKey(value.activeMode, value.collaborationId, value.storageScope)
    const owner = { ...scopeOwner, current: () => scopeOwner.current() && generation === this.historyGeneration }
    const requestKey = JSON.stringify([generation, key, value.historyDate, value.pageBefore])
    const existing = this.olderRequests.get(requestKey)
    if (existing) return existing
    this.expandedHistory.add(key)
    const operation = this.messageRead(owner, async () => {
      // Preserve only order metadata observed during this history read. A live
      // rollover must not let its late old-day response undo a published edit.
      const history = { key: owner.key, orders: new Map<string, readonly string[]>() }
      if (owner.mode === 'git') {
        if (this.liveMessageView?.key === owner.key) history.orders.set(this.liveMessageView.day, this.liveMessageView.order)
        this.historyDayViews.add(history)
      }
      try {
        const sequence = ++this.messageReadSequence
        const page = await this.api.history({ mode: owner.mode, collaborationId: owner.collaborationId, storageScope: owner.storageScope,
          date: value.historyDate, beforeId: value.pageBefore, limit }, owner.signal)
        if (generation === this.historyGeneration) this.applyMessages(owner, page, 'older', value.historyDate, false, history.orders, sequence)
      } finally { this.historyDayViews.delete(history) }
    }, true).then(() => {})
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
    this.publish({ drafts: [...this.current.drafts, { input: structuredClone(input), state: 'draft' }] })
  }
  send(input: FrameworkSendInput): Promise<void> {
    this.retain(input)
    const active = this.sends.get(input.id)
    if (active) return active
    const retained = this.current.drafts.find(draft => draft.input.id === input.id)!
    if (retained.state === 'sent') return Promise.resolve()
    const update = (state: FrameworkDraft['state'], error?: string) => this.publish({ drafts: this.current.drafts.map(draft => draft.input.id === input.id ? { ...draft, state, error } : draft) })
    update('sending')
    const operation = this.api.send(retained.input).then(() => {
      update('sent')
      if (input.mode === 'local') {
        const view = this.current.value
        if (view?.activeMode === input.mode && view.collaborationId === input.collaborationId
          && (input.storageScope === undefined || input.storageScope === view.storageScope)) void this.refreshMessages().catch(() => {})
      }
    }, error => { update('failed', frameworkErrorText(error)); throw error })
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

/** Describe the existing cancellation scope without changing admission. */
export function taskCancellationNotice(task: Pick<FrameworkClientTask, 'parentTaskId'>, tr: (cn: string, en: string) => string): string {
  return task.parentTaskId
    ? tr('取消将结束本子任务本轮，不能直接接续。停止相关执行后向父任务交接；不会单独启动 Recorder 或 Cleaner，任务资料保留至总任务整体收尾。', 'Cancellation ends this child task round and cannot be directly resumed. Related executions stop and hand back to the parent. Recorder and Cleaner do not run for this child; task material remains until the whole root task finishes.')
    : tr('取消将结束本轮，不能直接接续。停止相关执行后，由总任务 Recorder 记录现况，再由 Cleaner 统一清理任务资料；必要成果与长期记录保留。', 'Cancellation ends this round and cannot be directly resumed. Related executions stop, the root Recorder records the outcome, then Cleaner removes the task material together. Required results and lasting records are preserved.')
}
