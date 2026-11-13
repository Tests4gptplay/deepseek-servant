import { helperDebugRoot, isHelperDebugRecord } from './helper-debug-path.js'
import { PhysicalLocalFiles } from './physical-local-files.js'
import { isHostRecoveryDebugPath } from './recovery-debug-record.js'
import { listTaskHistory, readTaskHistoryIdentity, taskHistoryPath, type TaskHistoryIdentity } from './task-history.js'
import { parseConversationContext, pruneConversationContext } from './conversation-context.js'
import { taskArchiveStatePath } from './task-archive.js'
import { createHash } from 'node:crypto'
import { FrameworkConversation, type ConversationProcessGroup } from './conversation.js'
import { FrameworkTransactions } from './command-transactions.js'
import { readTaskCleanupRecord, type CleanupRecord } from './cleaner.js'
import { paths, taskArchiveOwnsPath, taskArchiveSelection, readJson, taskIdentity, taskLifecycle, isTerminalTask, type TaskMetadata } from './task-files.js'
import { filePath, withSnapshot, type FileEntry, type FileReceipt, type FilesSnapshot, type FilesStore } from './transactions.js'
import type { MigrationManifest } from './legacy-migration.js'
import { listLegacyRecordExports, readLegacyRecordExport } from './legacy-record-export.js'

export interface ManualConversationCleanupPreview {
  kind: 'conversation'; scope: string; messageIds: Array<{ id: string; path: string; notification?: string }>; processGroupIds: string[]
  foreground?: { executionId: string; sessionId: string; generation: number }
  processSessionIds: string[]; wakeKeys: string[]
}

export interface ManualCleanupLifecycle {
  previewForegroundReset(): Promise<Pick<ManualConversationCleanupPreview, 'foreground' | 'processSessionIds' | 'wakeKeys'>>
  /** Own the exact native stop, retire old capture/recovery and persist the new
   * Foreground epoch before action. Same command never resets a later epoch. */
  withForegroundReset<T>(commandId: string, action: (capturedMessageIds?: readonly string[], capturedProcessGroupIds?: readonly string[]) => Promise<T>, selection?: ManualConversationCleanupPreview): Promise<T>
  retireForegroundResetComplete(commandId: string): Promise<void>
  /** Existing Foreground reset completion, not a separate cleanup receipt. */
  isForegroundResetComplete(commandId: string): Promise<boolean>
  /** Confirm this terminal Task's actual producer settlement, not a stop request. */
  prepareTaskCleanup(taskId: string): Promise<void>
  /** Read the Host's existing completion for this lifecycle; never start a poll. */
  taskCleanupComplete(taskId: string, lifecycleId?: string): Promise<boolean>
}
export interface ManualTaskCleanupPreview {
  id: string
  tasks: Array<{ taskId: string; signature: string; files: number; bytes: number }>
  fileCount: number
  bytes: number
  preservedPaths: string[]
}
export interface ManualFileCleanupPreview {
  id: string
  kind: 'planning' | 'debug'
  files: Array<{ path: string; version: string; bytes: number }>
  bytes: number
}
export interface ManualCleanupResult {
  cleared: true
  receipt: FileReceipt
  deletedPaths: string[]
  preservedPaths: string[]
  /** Already missing selected metadata; its old body location is unknown. */
  missingEntries?: string[]
}
type Kind = 'tasks' | 'conversation' | 'planning' | 'debug'
interface MigrationSelection { taskIds: string[]; oldIds: string[]; assistantIds: string[]; messagePaths: string[]; paths: string[]; signature: string }
interface Target { path: string; version: string | null; action: 'delete' | 'empty' | 'index' | 'migration' | 'notification'; selections?: MigrationSelection[] }
interface LegacySelection { manifestPath: string; oldId: string; taskId: string }
interface Plan {
  version: 1; kind: Kind; scope: string; targets: Target[]; taskIds: string[]; messagePaths: string[]; preservedPaths: string[]
  taskSignatures?: Record<string, string>
  legacySelections?: LegacySelection[]
  /** Read only to reject prior unarchived cancellation plans. */
  cancelledTasks?: Record<string, unknown>
  processGroupIds?: string[]
  missingEntries?: string[]
  messageIds?: Record<string, string>
  completed?: true
  /** Exact reviewed archived identities, only while this user action is pending. */
  historyHashes?: Record<string, string>
}
interface Intent { version: 1; kind: Kind; commandId: string; scope: string; confirmation: string; preview?: ManualTaskCleanupPreview; filePreview?: ManualFileCleanupPreview; conversation?: Plan; conversationPreview?: ManualConversationCleanupPreview; completed?: true }
interface MessageIndex { version: number; messages: Array<{ id: string; path: string; notification?: string; role?: string; replyTo?: string }>; processGroups?: ConversationProcessGroup[] }
interface Candidate { legacySelections: LegacySelection[]; taskId: string; targets: Target[]; guards: FileEntry[]; preservedPaths: string[]; bytes: number; signature: string }
type Migrated = MigrationManifest & { clearedTasks?: Array<{ oldId: string; taskId: string; preservedArtifacts?: string[] }> }
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
function segment(value: string): string { filePath(value); if (value.includes('/')) throw new Error('Identity must be one path segment.'); return value }
const unique = (paths: readonly string[]) => [...new Set(paths)].sort()

/** Explicit Local user operations. No automatic retention policy, timer, native
 * log deletion, external filesystem removal or Git history rewriting lives here.
 * Plans store paths/content identities, never another copy of deleted正文. */
export class FrameworkManualCleanup {
  private readonly scope: string
  constructor(readonly files: FilesStore, readonly transactions: FrameworkTransactions,
    readonly conversation: FrameworkConversation, private readonly lifecycle: ManualCleanupLifecycle) {
    this.scope = JSON.stringify(conversation.scope)
  }
  private local(): PhysicalLocalFiles {
    if (!(this.files instanceof PhysicalLocalFiles) || this.conversation.scope.mode !== 'local') throw new Error('Manual record cleanup is a Local user action.')
    return this.files
  }
  async previewTasks(): Promise<ManualTaskCleanupPreview> {
    this.local()
    return withSnapshot(this.files, async snapshot => {
      const candidates = await this.candidates(snapshot)
      const tasks = candidates.map(item => ({ taskId: item.taskId, signature: item.signature, files: item.targets.filter(t => t.action === 'delete').length, bytes: item.bytes }))
      return { id: hash(json([this.scope, tasks])), tasks, fileCount: tasks.reduce((sum, task) => sum + task.files, 0),
        bytes: tasks.reduce((sum, task) => sum + task.bytes, 0), preservedPaths: unique(candidates.flatMap(item => item.preservedPaths)) }
    })
  }
  async clearTasks(commandId: string, preview: ManualTaskCleanupPreview, confirmation: 'clear-ended-task-records'): Promise<ManualCleanupResult> {
    this.local(); this.confirm(commandId, confirmation, 'clear-ended-task-records')
    if (!preview || !Array.isArray(preview.tasks) || preview.id !== hash(json([this.scope, preview.tasks]))
      || new Set(preview.tasks.map(task => task.taskId)).size !== preview.tasks.length) throw new Error('Task cleanup requires its exact reviewed preview.')
    return this.clearPhysicalTasks(this.local(), commandId, preview, confirmation)
  }
  private async clearPhysicalTasks(files: PhysicalLocalFiles, commandId: string, preview: ManualTaskCleanupPreview, confirmation: string): Promise<ManualCleanupResult> {
    const path = this.planPath(commandId), intentPath = 'technical/manual-cleanup/intents/' + hash(this.scope + '\0' + commandId) + '.json'
    const alreadyComplete = await files.update(intentPath, bytes => {
      const intent: Intent = { version: 1, kind: 'tasks', commandId, scope: this.scope, confirmation, preview }
      if (bytes !== undefined) {
        const prior = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Intent
        if (json({ ...prior, completed: undefined }) !== json(intent)) throw new Error('Cleanup command identity belongs to another reviewed selection.')
        return { value: prior.completed === true }
      }
      return { value: false, content: json(intent) }
    })
    const retiredSelection = !alreadyComplete && await withSnapshot(files, async snapshot => {
      if (await files.read(snapshot, path) !== undefined) return false
      let migrations: Array<{ path: string; manifest: Migrated }> | undefined
      for (const selected of preview.tasks) {
        const history = await readTaskHistoryIdentity(files, snapshot, selected.taskId)
        if (history?.historyCleared) continue
        // Old migrated histories already retain their explicit user-disposal
        // identity in the original map. Read only that existing indexed map.
        if (await files.read(snapshot, paths.task(selected.taskId)) !== undefined) return false
        migrations ??= await this.migrations(snapshot)
        if (!migrations.some(item => item.manifest.clearedTasks?.some(task => task.taskId === selected.taskId))) return false
      }
      return true
    })
    if (alreadyComplete || retiredSelection) {
      const plan = await withSnapshot(files, snapshot => readJson<Plan>(files, snapshot, path))
      if (plan && (plan.kind !== 'tasks' || plan.scope !== this.scope)) throw new Error('Cleanup command plan belongs to another action.')
      await files.delete(path); await files.delete(intentPath)
      const receipt = { revision: await withSnapshot(files, async snapshot => snapshot.revision), replay: true }
      return plan ? this.result(plan, receipt) : { cleared: true, receipt, deletedPaths: [], preservedPaths: preview.preservedPaths }
    }
    await files.updateAsync(path, async bytes => {
      if (bytes !== undefined) {
        const plan = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Plan
        if (plan.kind !== 'tasks' || plan.scope !== this.scope || json(plan.taskSignatures) !== json(Object.fromEntries(preview.tasks.map(task => [task.taskId, task.signature]))))
          throw new Error('Cleanup command plan belongs to another reviewed selection.')
        return { value: undefined }
      }
      const plan = await withSnapshot(files, async snapshot => {
        const candidates = await this.candidates(snapshot, false, new Set(preview.tasks.map(task => task.taskId))), selected: Candidate[] = []
        for (const expected of preview.tasks) {
          const current = candidates.find(task => task.taskId === expected.taskId)
          if (!current || current.signature !== expected.signature) throw new Error('Task cleanup preview changed; review the current records before clearing.')
          selected.push(current)
        }
        const historyHashes: Record<string, string> = {}
        for (const task of selected) {
          await this.lifecycle.prepareTaskCleanup(task.taskId)
          const history = await files.read(snapshot, taskHistoryPath(task.taskId))
          if (history !== undefined) historyHashes[task.taskId] = hash(history)
        }
        return { version: 1 as const, kind: 'tasks' as const, scope: this.scope,
          targets: mergeTargets(selected.flatMap(task => task.targets)), taskIds: selected.map(task => task.taskId),
          taskSignatures: Object.fromEntries(preview.tasks.map(task => [task.taskId, task.signature])),
          legacySelections: selected.flatMap(task => task.legacySelections), historyHashes,
          messagePaths: [], preservedPaths: unique(selected.flatMap(task => task.preservedPaths)) }
      })
      return { value: undefined, content: json(plan) }
    })
    const plan = await withSnapshot(files, snapshot => readJson<Plan>(files, snapshot, path))
    if (!plan || plan.kind !== 'tasks' || plan.scope !== this.scope) throw new Error('Confirmed Task history selection is unavailable.')
    for (const taskId of plan.taskIds) await this.lifecycle.prepareTaskCleanup(taskId)
    await withSnapshot(files, async snapshot => {
      for (const [taskId, expected] of Object.entries(plan.historyHashes ?? {})) {
        const text = await files.read(snapshot, taskHistoryPath(taskId))
        const history = text === undefined ? undefined : JSON.parse(text) as TaskHistoryIdentity
        if (!history || history.taskId !== taskId || history.kind !== 'task-history'
          || !history.historyCleared && hash(text!) !== expected) throw new Error('Reviewed archived Task identity changed: ' + taskId)
      }
      for (const target of plan.targets) {
        if (target.action === 'delete') continue
        if (target.action !== 'migration') throw new Error('Unexpected action in confirmed Task history cleanup.')
        const manifest = await readJson<Migrated>(files, snapshot, target.path)
        if (!manifest) throw new Error('Migration map disappeared.')
        const selected = plan.legacySelections?.filter(item => item.manifestPath === target.path) ?? []
        if (selected.length && selected.every(item => manifest.clearedTasks?.some(prior => prior.oldId === item.oldId && prior.taskId === item.taskId))) continue
        for (const selection of target.selections ?? []) if (migrationSignature(manifest, selection) !== selection.signature)
          throw new Error('Reviewed migration cleanup selection changed: ' + target.path)
      }
    })
    for (const target of plan.targets.filter(target => target.action === 'delete')) {
      if (target.version === null) continue
      if (!await files.deleteObserved(target.path, target.version)) {
        const present = await withSnapshot(files, snapshot => this.version(snapshot, target.path))
        if (present !== null) throw new Error('Reviewed cleanup target changed: ' + target.path)
      }
    }
    for (const target of plan.targets.filter(target => target.action === 'migration'))
      await this.applyPhysicalTaskMigration(files, plan, target)
    for (const [taskId, expected] of Object.entries(plan.historyHashes ?? {})) {
      await files.update(taskHistoryPath(taskId), bytes => {
        if (bytes === undefined) throw new Error('Reviewed archived Task identity disappeared: ' + taskId)
        const history = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as TaskHistoryIdentity
        if (history.taskId !== taskId || history.kind !== 'task-history') throw new Error('Reviewed archived Task identity differs: ' + taskId)
        if (history.historyCleared) return { value: undefined }
        if (hash(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) !== expected) throw new Error('Reviewed archived Task identity changed: ' + taskId)
        const results = plan.preservedPaths.filter(path => history.resultPaths?.includes(path) || taskArchiveOwnsPath(history, path))
        return { value: undefined, content: json({ ...history, historyCleared: true, resultPaths: unique([...(history.resultPaths ?? []), ...results]) }) }
      })
    }
    // Completion belongs to this already-accepted intent until both temporary
    // records retire. Discovery remains until last, so interrupted retirement
    // never strands an orphan plan or rebuilds its now-cleared selection.
    await files.update(intentPath, bytes => {
      if (bytes === undefined) throw new Error('Confirmed Task cleanup intent disappeared before completion.')
      const intent = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Intent
      if (intent.kind !== 'tasks' || intent.commandId !== commandId || intent.scope !== this.scope) throw new Error('Cleanup command identity belongs to another action.')
      return { value: undefined, content: json({ ...intent, completed: true }) }
    })
    await files.delete(path)
    await files.delete(intentPath)
    return this.result(plan, { revision: (await withSnapshot(files, async snapshot => snapshot.revision)), replay: false })
  }
  private async applyPhysicalTaskMigration(files: PhysicalLocalFiles, plan: Plan, target: Target): Promise<void> {
    await files.update(target.path, bytes => {
      if (bytes === undefined) throw new Error('Migration map disappeared.')
      const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Migrated
      const cleared = plan.legacySelections?.filter(item => item.manifestPath === target.path) ?? []
      if (cleared.length && cleared.every(item => manifest.clearedTasks?.some(prior => prior.oldId === item.oldId && prior.taskId === item.taskId)))
        return { value: undefined }
      for (const selection of target.selections ?? []) if (migrationSignature(manifest, selection) !== selection.signature)
        throw new Error('Reviewed migration cleanup selection changed: ' + target.path)
      const removed = new Set(plan.targets.filter(item => item.action === 'delete').map(item => item.path))
      manifest.clearedTasks ??= []
      for (const { oldId, taskId } of cleared) {
        const prior = manifest.clearedTasks.find(item => item.oldId === oldId)
        if (prior && prior.taskId !== taskId) throw new Error('Legacy cleanup identity differs from its retained receipt.')
        if (!prior) manifest.clearedTasks.push({ oldId, taskId, preservedArtifacts: plan.preservedPaths.filter(path => path.startsWith(paths.archive(taskId) + '/')) })
      }
      manifest.tasks = manifest.tasks.filter(task => !plan.taskIds.includes(task.taskId))
      manifest.records = manifest.records.filter(record => !removed.has(record.path))
      for (const [reference, destination] of Object.entries(manifest.references)) if (removed.has(destination)) {
        delete manifest.references[reference]; delete manifest.referenceHashes[reference]
      }
      return { value: undefined, content: json(manifest) }
    })
  }
  async previewConversation(): Promise<ManualConversationCleanupPreview> {
    this.local()
    const owner = await this.lifecycle.previewForegroundReset()
    return this.conversation.withPhysicalPublication(async snapshot => {
      const index = await this.conversationIndex(snapshot)
      return { kind: 'conversation', scope: this.scope,
        messageIds: index.messages.map(({ id, path, notification }) => ({ id, path, ...(notification ? { notification } : {}) })),
        processGroupIds: (index.processGroups ?? []).map(group => group.id), ...owner }
    })
  }
  async clearConversation(commandId: string, confirmation: 'clear-foreground-conversation', preview?: ManualConversationCleanupPreview): Promise<ManualCleanupResult> {
    this.local(); this.confirm(commandId, confirmation, 'clear-foreground-conversation')
    if (preview) this.confirmConversationPreview(preview)
    return this.clearPhysicalConversation(this.local(), commandId, confirmation, preview)
  }
  private confirmConversationPreview(preview: ManualConversationCleanupPreview): void {
    if (preview.kind !== 'conversation' || preview.scope !== this.scope || !Array.isArray(preview.messageIds)
      || !Array.isArray(preview.processGroupIds) || !Array.isArray(preview.processSessionIds)
      || !Array.isArray(preview.wakeKeys)
      || new Set(preview.messageIds.map(item => item.path)).size !== preview.messageIds.length
      || preview.messageIds.some(item => !item || !item.id || typeof item.id !== 'string' || typeof item.path !== 'string'
        || !filePath(item.path).startsWith('conversations/local/') || !item.path.endsWith('/entry.json')
        || item.notification !== undefined && (typeof item.notification !== 'string' || !/^state\/Foreground_[^/]+$/.test(item.notification))))
      throw new Error('Conversation cleanup requires its original Local selection.')
  }
  private async clearPhysicalConversation(files: PhysicalLocalFiles, commandId: string, confirmation: string, preview?: ManualConversationCleanupPreview): Promise<ManualCleanupResult> {
    const completed = await this.lifecycle.isForegroundResetComplete(commandId)
    if (completed) {
      const done = await this.completed(commandId, 'conversation')
      await this.retirePhysicalConversation(files, commandId)
      if (preview) await this.lifecycle.retireForegroundResetComplete(commandId)
      return done ?? { cleared: true, receipt: { revision: (await withSnapshot(files, async snapshot => snapshot.revision)), replay: true }, deletedPaths: [], preservedPaths: [] }
    }
    const intentPath = 'technical/manual-cleanup/intents/' + hash(this.scope + '\0' + commandId) + '.json'
    const original = await this.conversation.withPhysicalPublication(async snapshot => {
      let intent = await readJson<Intent>(files, snapshot, intentPath)
      if (!intent) {
        intent = { version: 1, kind: 'conversation', commandId, scope: this.scope, confirmation,
          conversation: await this.physicalConversationPlan(snapshot, undefined, undefined, preview),
          ...(preview ? { conversationPreview: preview } : {}) }
        await files.replace(intentPath, json(intent))
      }
      if (intent.version !== 1 || intent.kind !== 'conversation' || intent.scope !== this.scope || intent.commandId !== commandId || !intent.conversation)
        throw new Error('Confirmed conversation cleanup does not match its original selection.')
      if (intent.conversationPreview && preview && json(intent.conversationPreview) !== json(preview))
        throw new Error('Conversation cleanup belongs to another original selection.')
      return intent
    })
    const result = await this.lifecycle.withForegroundReset(commandId, (capturedMessageIds, capturedProcessGroupIds) => this.conversation.withPhysicalPublication(async snapshot => {
      const path = this.planPath(commandId)
      let plan = await readJson<Plan>(files, snapshot, path)
      if (!plan) {
        const capture = original.conversationPreview
          ? await this.originalForegroundCapture(snapshot, original.conversationPreview, capturedMessageIds ?? [], capturedProcessGroupIds ?? [])
          : { messageIds: capturedMessageIds ?? [], processGroupIds: capturedProcessGroupIds ?? [] }
        const captured = capture.messageIds.length || capture.processGroupIds.length
          ? await this.physicalConversationPlan(snapshot, capture.messageIds, capture.processGroupIds) : undefined
        plan = captured ? { ...original.conversation!, targets: mergeTargets([...original.conversation!.targets, ...captured.targets]),
          messagePaths: unique([...original.conversation!.messagePaths, ...captured.messagePaths]),
          missingEntries: unique([...(original.conversation!.missingEntries ?? []), ...(captured.missingEntries ?? [])]),
          messageIds: { ...original.conversation!.messageIds, ...captured.messageIds },
          processGroupIds: unique([...(original.conversation!.processGroupIds ?? []), ...(captured.processGroupIds ?? [])]) } : original.conversation!
        // The existing user-confirmed plan is also the exact partial-deletion
        // continuation. A restart never selects later conversation messages.
        await files.replace(path, json(plan))
      }
      if (plan.version !== 1 || plan.kind !== 'conversation' || plan.scope !== this.scope) throw new Error('Conversation cleanup plan belongs to another action.')
      if (plan.completed) return this.result(plan, { revision: snapshot.revision, replay: true })
      const index = await this.conversationIndex(snapshot)
      for (const selected of plan.messagePaths) {
        const current = index.messages.find(row => row.path === selected)
        if (current && plan.messageIds?.[selected] !== current.id) throw new Error('Selected conversation entry now belongs to another message.')
      }
      const ids = new Set(Object.values(plan.messageIds ?? {}))
      // Remove visible references before deleting their exact originals. These
      // are ordinary file operations, not a multi-file atomic snapshot.
      await files.update(this.conversation.contextPath, bytes => {
        if (!bytes) return { value: undefined }
        const previous = parseConversationContext(new TextDecoder().decode(bytes)), next = pruneConversationContext(previous, ids)
        return { value: undefined, ...(json(previous) !== json(next) ? { content: json(next) } : {}) }
      })
      await files.replace(this.conversation.indexPath, json({ ...index,
        messages: index.messages.filter(row => !plan!.messagePaths.includes(row.path)),
        ...(index.processGroups ? { processGroups: index.processGroups.filter(group => !(plan!.processGroupIds ?? []).includes(group.id)) } : {}) }))
      for (const target of plan.targets) {
        if (target.action === 'notification') {
          if (target.version) await files.deleteObserved(target.path, target.version)
        } else if (target.action === 'delete') await files.delete(target.path)
      }
      await files.replace(path, json({ ...plan, completed: true }))
      return this.result(plan, { revision: snapshot.revision, replay: false })
    }), original.conversationPreview)
    // Native retirement has now persisted its existing complete phase. An old
    // command can no longer select later input, so its temporary selection retires.
    await this.retirePhysicalConversation(files, commandId)
    if (original.conversationPreview) await this.lifecycle.retireForegroundResetComplete(commandId)
    return result
  }
  private async retirePhysicalConversation(files: PhysicalLocalFiles, commandId: string): Promise<void> {
    const intentPath = 'technical/manual-cleanup/intents/' + hash(this.scope + '\0' + commandId) + '.json'
    const intent = await withSnapshot(files, snapshot => readJson<Intent>(files, snapshot, intentPath))
    if (intent && (intent.version !== 1 || intent.kind !== 'conversation' || intent.scope !== this.scope || intent.commandId !== commandId))
      throw new Error('Cleanup command identity belongs to another action.')
    // Leave discovery until last: if deletion is interrupted, startup finds
    // the same intent and finishes retirement through the completed reset.
    await files.delete(this.planPath(commandId))
    await files.delete(intentPath)
  }
  private async originalForegroundCapture(snapshot: FilesSnapshot, preview: ManualConversationCleanupPreview,
    capturedMessageIds: readonly string[], capturedProcessGroupIds: readonly string[]): Promise<{ messageIds: string[]; processGroupIds: string[] }> {
    const index = await this.conversationIndex(snapshot)
    const reviewed = new Set(preview.messageIds.map(row => row.id))
    const firstLaterUser = index.messages.findIndex(row => row.role === 'user' && !reviewed.has(row.id))
    const selected = capturedMessageIds.filter(id => {
      const at = index.messages.findIndex(row => row.id === id)
      if (at < 0) throw new Error('Confirmed old Foreground capture is absent from this conversation.')
      const row = index.messages[at]!
      return row.role === 'assistant' && (row.replyTo ? reviewed.has(row.replyTo) : firstLaterUser < 0 || at < firstLaterUser)
    })
    const selectedIds = new Set(selected)
    const processGroupIds = (index.processGroups ?? []).filter(group => capturedProcessGroupIds.includes(group.id)
      && (group.beforeMessageId ? selectedIds.has(group.beforeMessageId)
        : !!group.afterMessageId && reviewed.has(group.afterMessageId))).map(group => group.id)
    return { messageIds: selected, processGroupIds }
  }
  private async physicalConversationPlan(snapshot: FilesSnapshot, capturedMessageIds?: readonly string[], capturedProcessGroupIds?: readonly string[], preview?: ManualConversationCleanupPreview): Promise<Plan> {
    const index = await this.conversationIndex(snapshot)
    const selected = preview ? index.messages.filter(row => preview.messageIds.some(item => item.id === row.id && item.path === row.path))
      : capturedMessageIds === undefined ? index.messages : index.messages.filter(row => capturedMessageIds.includes(row.id))
    if (capturedMessageIds?.some(id => !selected.some(row => row.id === id))) throw new Error('Confirmed old Foreground capture is absent from this conversation.')
    if (capturedProcessGroupIds?.some(id => !index.processGroups?.some(group => group.id === id))) throw new Error('Confirmed old Foreground process group is absent from this conversation.')
    const targets: Target[] = [], messagePaths: string[] = [], messageIds: Record<string, string> = {}, missingEntries: string[] = []
    const selectedPaths = new Set(selected.map(row => row.path)), sharedBodies = new Set<string>()
    // Exact index references, not a directory scan, establish whether another
    // still-visible original uses a selected body (including migrated history).
    for (const row of index.messages) if (!selectedPaths.has(row.path)) {
      const entry = await readJson<{ textPath?: string }>(this.files, snapshot, row.path)
      if (entry?.textPath) sharedBodies.add(entry.textPath)
    }
    const preservedPaths: string[] = []
    for (const row of selected) {
      if (!filePath(row.path).startsWith('conversations/local/') || !row.path.endsWith('/entry.json'))
        throw new Error('Conversation cleanup requires exact owned message references.')
      const entry = await readJson<{ id: string; role: string; collaborationId: string; textPath: string }>(this.files, snapshot, row.path)
      targets.push({ path: row.path, version: null, action: 'delete' })
      if (entry === undefined) {
        // The index still selects this exact entry, but its missing metadata
        // cannot authorize deleting any body whose former path is unknown.
        // A captured output also needs the original index's assistant role.
        if (capturedMessageIds !== undefined && row.role !== 'assistant')
          throw new Error('Conversation cleanup requires exact owned message references.')
        missingEntries.push(row.path)
      } else {
        if (!entry || entry.id !== row.id || entry.collaborationId !== this.conversation.scope.collaborationId
          || capturedMessageIds !== undefined && entry.role !== 'assistant'
          || !filePath(entry.textPath).startsWith('conversations/local/')) throw new Error('Conversation cleanup requires exact owned message references.')
        if (sharedBodies.has(entry.textPath)) preservedPaths.push(entry.textPath)
        else if (entry.textPath.endsWith('.txt')) targets.push({ path: entry.textPath, version: null, action: 'delete' })
        else {
          // Explicit old-format references only, for an already indexed original.
          // Never recurse its directory or delete a shared messages directory.
          const manifestPath = entry.textPath + '/manifest.json'
          const manifest = await readJson<{ version: number; chunks: string[] }>(this.files, snapshot, manifestPath)
          if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.chunks)) throw new Error('Selected original text manifest is missing.')
          for (const chunk of manifest.chunks) {
            const path = filePath(chunk)
            if (!path.startsWith(entry.textPath + '/parts/')) throw new Error('Selected original text chunk belongs to another record.')
            targets.push({ path, version: null, action: 'delete' })
          }
          targets.push({ path: manifestPath, version: null, action: 'delete' })
        }
      }
      messagePaths.push(row.path); messageIds[row.path] = row.id
      if (row.notification) {
        if (!/^state\/Foreground_[^/]+$/.test(row.notification)) throw new Error('Invalid conversation notification path.')
        const version = await this.version(snapshot, row.notification)
        if (version) targets.push({ path: row.notification, version, action: 'notification' })
      }
    }
    const processGroupIds = (index.processGroups ?? []).filter(group => preview ? preview.processGroupIds.includes(group.id)
      : capturedMessageIds === undefined || capturedProcessGroupIds?.includes(group.id)
      || group.beforeMessageId !== undefined && capturedMessageIds.includes(group.beforeMessageId)).map(group => group.id)
    return { version: 1, kind: 'conversation', scope: this.scope, targets: mergeTargets(targets), taskIds: [], messagePaths, messageIds, processGroupIds, preservedPaths: unique(preservedPaths), ...(missingEntries.length ? { missingEntries } : {}) }
  }
  async clearPlanning(commandId: string, confirmation: 'clear-work-planning-notes', preview?: ManualFileCleanupPreview, signal?: AbortSignal): Promise<ManualCleanupResult> {
    signal?.throwIfAborted()
    this.local(); this.confirm(commandId, confirmation, 'clear-work-planning-notes')
    await this.conversation.prepare()
    if (!preview) throw new Error('Review the current List and Cache before clearing.')
    return this.clearPhysicalFiles(this.local(), commandId, 'planning', confirmation, preview, signal)
  }
  /** Existing confirmation preview: only the two Foreground files, or permanent Helper
   * records. The explicit user preview walks that directory only, never Task data. */
  async previewFiles(kind: 'planning' | 'debug'): Promise<ManualFileCleanupPreview> {
    this.local()
    if (kind !== 'planning' && kind !== 'debug') throw new Error('Invalid manual file cleanup kind.')
    if (kind === 'planning') await this.conversation.prepare()
    return withSnapshot(this.files, async snapshot => {
      const entries = kind === 'planning'
        ? (await this.files.listDirectory(snapshot, this.conversation.foregroundRoot + '/')).filter(entry => this.ownsFile(kind, entry.path))
        : (await Promise.all([this.files.listDirectory(snapshot, 'debug/'), this.files.listDirectory(snapshot, 'debug/helper-reports/'), this.files.list(snapshot, helperDebugRoot)])).flat().filter(entry => this.ownsFile(kind, entry.path))
      const files = entries.map(({ path, version, bytes }) => ({ path, version, bytes: bytes ?? 0 })).sort((a, b) => a.path.localeCompare(b.path))
      return { id: hash(json([this.scope, kind, files])), kind, files, bytes: files.reduce((sum, file) => sum + file.bytes, 0) }
    })
  }
  private ownsFile(kind: 'planning' | 'debug', path: string): boolean {
    filePath(path)
    return kind === 'planning' ? ['Foreground_List.md', 'Foreground_Cache.md'].some(name => path === this.conversation.foregroundRoot + '/' + name)
      : isHelperDebugRecord(path) || /^debug\/\d{4}-\d{2}-\d{2}\.md$/.test(path) || isHostRecoveryDebugPath(path) || /^debug\/helper-reports\/[^/]+\.md$/.test(path)
  }
  private filePreview(kind: 'planning' | 'debug', preview: ManualFileCleanupPreview): void {
    if (!preview || preview.kind !== kind || !Array.isArray(preview.files)
      || preview.id !== hash(json([this.scope, kind, preview.files])) || new Set(preview.files.map(file => file.path)).size !== preview.files.length
      || preview.files.some(file => !this.ownsFile(kind, file.path) || typeof file.version !== 'string' || !file.version))
      throw new Error('Manual cleanup requires its exact reviewed file selection.')
  }
  async clearDebug(commandId: string, preview: ManualFileCleanupPreview, confirmation: 'clear-debug-records', signal?: AbortSignal): Promise<ManualCleanupResult> {
    signal?.throwIfAborted()
    this.local(); this.confirm(commandId, confirmation, 'clear-debug-records'); this.filePreview('debug', preview)
    return this.clearPhysicalFiles(this.local(), commandId, 'debug', confirmation, preview, signal)
  }
  private async clearPhysicalFiles(files: PhysicalLocalFiles, commandId: string, kind: 'planning' | 'debug', confirmation: string,
    preview: ManualFileCleanupPreview, signal?: AbortSignal): Promise<ManualCleanupResult> {
    signal?.throwIfAborted()
    this.filePreview(kind, preview)
    const intent: Intent = { version: 1, kind, commandId, scope: this.scope, confirmation, filePreview: preview }
    const intentPath = 'technical/manual-cleanup/intents/' + hash(this.scope + '\0' + commandId) + '.json'
    await files.update(intentPath, bytes => {
      if (bytes !== undefined && json(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))) !== json(intent))
        throw new Error('Cleanup command identity belongs to another reviewed selection.')
      return { value: undefined, ...(bytes === undefined ? { content: json(intent) } : {}) }
    })
    const deletedPaths: string[] = [], preservedPaths: string[] = []
    for (const file of preview.files) {
      signal?.throwIfAborted()
      if (kind === 'debug') {
        if (await files.deleteObserved(file.path, file.version)) deletedPaths.push(file.path)
        else if (await withSnapshot(files, snapshot => this.version(snapshot, file.path)) !== null) preservedPaths.push(file.path)
      } else {
        // Only this actual file is coordinated with its ordinary writers. The
        // reviewed observation protects a newer write, including identical text.
        const changed = await files.updateAsync(file.path, async bytes => {
          if (!bytes?.byteLength) return { value: false }
          if (await withSnapshot(files, snapshot => this.version(snapshot, file.path)) !== file.version) return { value: true }
          return { value: false, content: '' }
        })
        if (changed) preservedPaths.push(file.path)
      }
    }
    signal?.throwIfAborted()
    // The caller keeps this exact preview for an uncertain retry. After restart,
    // changed files do not match it. No completed file-cleanup receipt is needed.
    await files.delete(intentPath)
    return { cleared: true, receipt: { revision: await withSnapshot(files, async snapshot => snapshot.revision), replay: false }, deletedPaths, preservedPaths }
  }
  private confirm(commandId: string, actual: string, expected: string): void {
    if (!commandId || actual !== expected) throw new Error('This cleanup requires its explicit confirmation and stable command identity.')
  }
  private planPath(commandId: string): string { return 'technical/manual-cleanup/commands/' + hash(this.scope + '\0' + commandId) + '.json' }
  /** Tasks and native conversation reset retain their startup ordering. The
   * owner may separately run the already-confirmed file selections; they touch
   * only observed files and do not hold unrelated runtime startup. No preview
   * is automatically confirmed. Without that owner, all actions are awaited. */
  async resumePending(onError?: (error: unknown, commandId: string) => void,
    deferFiles?: (resume: (signal: AbortSignal) => Promise<ManualCleanupResult[]>) => void): Promise<ManualCleanupResult[]> {
    this.local()
    const pending = await withSnapshot(this.files, async snapshot => {
      const result: Intent[] = []
      for (const entry of await this.files.listDirectory(snapshot, 'technical/manual-cleanup/intents/')) {
        const intent = await readJson<Intent>(this.files, snapshot, entry.path)
        if (!intent || intent.scope !== this.scope) continue
        if (intent.version !== 1 || entry.path !== 'technical/manual-cleanup/intents/' + hash(this.scope + '\0' + intent.commandId) + '.json') throw new Error('Invalid confirmed cleanup identity.')
        // Completed plans may still precede native reset completion or
        // temporary-record retirement. Resume that actual lifecycle once.
        result.push(intent)
      }
      return result
    })
    if (!deferFiles) return this.resumeIntents(pending, onError)
    const files = pending.filter(intent => intent.kind === 'planning' || intent.kind === 'debug')
    const results = await this.resumeIntents(pending.filter(intent => intent.kind !== 'planning' && intent.kind !== 'debug'), onError)
    if (files.length) deferFiles(signal => this.resumeIntents(files, onError, signal))
    return results
  }
  private async resumeIntents(pending: readonly Intent[], onError?: (error: unknown, commandId: string) => void,
    signal?: AbortSignal): Promise<ManualCleanupResult[]> {
    const results: ManualCleanupResult[] = [], errors: unknown[] = []
    for (const intent of pending) {
      signal?.throwIfAborted()
      try {
        if (intent.kind === 'conversation') results.push(await this.clearConversation(intent.commandId, intent.confirmation as 'clear-foreground-conversation', intent.conversationPreview))
        else if (intent.kind === 'planning') results.push(await this.clearPlanning(intent.commandId, intent.confirmation as 'clear-work-planning-notes', intent.filePreview, signal))
        else if (intent.kind === 'debug' && intent.filePreview) results.push(await this.clearDebug(intent.commandId, intent.filePreview, intent.confirmation as 'clear-debug-records', signal))
        else if (intent.kind === 'tasks' && intent.preview) results.push(await this.clearTasks(intent.commandId, intent.preview, intent.confirmation as 'clear-ended-task-records'))
        else throw new Error('Invalid confirmed cleanup action.')
      } catch (error) {
        if (signal?.aborted && error === signal.reason) throw error
        if (onError) { try { onError(error, intent.commandId) } catch (reportError) { errors.push(error, reportError) } }
        else errors.push(error)
      }
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, 'Some confirmed manual cleanup operations remain incomplete.')
    return results
  }
  private async completed(commandId: string, kind: Kind): Promise<ManualCleanupResult | undefined> {
    return withSnapshot(this.files, async snapshot => {
      const plan = await readJson<Plan>(this.files, snapshot, this.planPath(commandId))
      if (plan && (plan.kind !== kind || plan.scope !== this.scope)) throw new Error('Cleanup command identity belongs to another action.')
      if (plan?.completed) return this.result(plan, { revision: snapshot.revision, replay: true })
    })
  }
  private result(plan: Plan, receipt: FileReceipt): ManualCleanupResult {
    return { cleared: true, receipt, deletedPaths: plan.targets.filter(item => item.action === 'delete').map(item => item.path), preservedPaths: plan.preservedPaths,
      ...(plan.missingEntries?.length ? { missingEntries: plan.missingEntries } : {}) }
  }
  private async version(snapshot: FilesSnapshot, path: string): Promise<string | null> {
    filePath(path)
    return (await this.files.listDirectory(snapshot, path.slice(0, path.lastIndexOf('/') + 1))).find(entry => entry.path === path)?.version ?? null
  }
  private async taskCleanupReady(task: TaskMetadata, cleanup: CleanupRecord | undefined): Promise<boolean> {
    if (this.files instanceof PhysicalLocalFiles && 'kind' in task && task.kind === 'task-history')
      return isTerminalTask(task) && await this.lifecycle.taskCleanupComplete(task.taskId, task.lifecycleId)
    return isTerminalTask(task) && cleanup?.version === 1 && cleanup.taskId === task.taskId
      && taskLifecycle(cleanup) === taskLifecycle(task) && ['files-cleaned', 'released'].includes(cleanup.phase)
      && await this.lifecycle.taskCleanupComplete(task.taskId, task.lifecycleId)
  }
  private async migrations(snapshot: FilesSnapshot): Promise<Array<{ path: string; manifest: Migrated }>> {
    const index = await readJson<{ migrations: Array<{ manifestPath: string }> }>(this.files, snapshot, 'technical/legacy-migrations/index.json')
    const result: Array<{ path: string; manifest: Migrated }> = []
    for (const item of index?.migrations ?? []) {
      if (!/^technical\/legacy-migrations\/[^/]+\/manifest.json$/.test(item.manifestPath)) throw new Error('Invalid migration manifest path.')
      const manifest = await readJson<Migrated>(this.files, snapshot, item.manifestPath)
      if (!manifest || manifest.source.mode !== 'local') continue
      result.push({ path: item.manifestPath, manifest })
    }
    return result
  }
  private async candidates(snapshot: FilesSnapshot, priorPlan = false, selectedTaskIds?: ReadonlySet<string>): Promise<Candidate[]> {
    const taskFiles = await this.files.listDirectory(snapshot, 'tasks/'), migrations = await this.migrations(snapshot)
    const currentIds = new Set(taskFiles.filter(entry => /^tasks\/[^/]+\.json$/.test(entry.path)).map(entry => entry.path.slice('tasks/'.length, -'.json'.length)))
    const tasks = new Map<string, TaskMetadata | undefined>(), resultReferences: string[] = []
    for (const entry of taskFiles.filter(entry => /^tasks\/[^/]+\.json$/.test(entry.path))) {
      const task = await readJson<TaskMetadata>(this.files, snapshot, entry.path)
      for (const path of task?.resultPaths ?? []) resultReferences.push(filePath(path))
      if (task && entry.path === paths.task(task.taskId)) {
        if (isTerminalTask(task)) tasks.set(task.taskId, task)
      }
    }
    if (this.files instanceof PhysicalLocalFiles) for (const task of await listTaskHistory(this.files, snapshot, error => { throw error })) {
      if (currentIds.has(task.taskId)) continue
      currentIds.add(task.taskId)
      for (const path of task.resultPaths ?? []) resultReferences.push(filePath(path))
      if (!task.historyCleared && isTerminalTask(task)) tasks.set(task.taskId, task)
    }
    const legacyIdentities = new Map<string, Array<{ oldId: string; taskId: string; continuation: string }>>()
    for (const migration of migrations) {
      const identities = migration.manifest.tasks.filter(task => !migration.manifest.clearedTasks?.some(cleared => cleared.oldId === task.oldId))
        .map(({ oldId, taskId, continuation }) => ({ oldId, taskId, continuation }))
      // The prior consumer preserved these actual archives but omitted their
      // task mapping. Resolve them read-only; do not backfill scheduling data.
      const missing = new Set(migration.manifest.records.filter(record => record.key.startsWith('task-history/'))
        .map(record => {
          const oldId = decodeURIComponent(record.key.slice('task-history/'.length))
          if (!oldId || record.key !== 'task-history/' + encodeURIComponent(oldId)) throw new Error('Invalid preserved legacy history identity.')
          return oldId
        })
        .filter(oldId => !migration.manifest.tasks.some(task => task.oldId === oldId)))
      if (missing.size) {
        const failures: unknown[] = []
        const found = await listLegacyRecordExports(this.files, snapshot, migration.path, (error, oldId) => {
          // Existing mapped records keep their existing eligibility contract;
          // only the newly discovered archive identities are evaluated here.
          if (missing.has(oldId)) failures.push(error)
        })
        if (failures.length === 1) throw failures[0]
        if (failures.length) throw new AggregateError(failures, 'Preserved legacy histories could not be verified for cleanup.')
        for (const identity of found) if (missing.has(identity.oldTaskId)) {
          await readLegacyRecordExport(this.files, snapshot, { manifestPath: migration.path, oldTaskId: identity.oldTaskId })
          identities.push({ oldId: identity.oldTaskId, taskId: identity.taskId, continuation: identity.continuation })
        }
      }
      legacyIdentities.set(migration.path, identities)
      for (const task of identities) if (['complete', 'cancelled'].includes(task.continuation) && !currentIds.has(task.taskId)) tasks.set(segment(task.taskId), undefined)
    }
    const result: Candidate[] = []
    for (const [taskId, task] of tasks) {
      if (selectedTaskIds && !selectedTaskIds.has(taskId)) continue
      const cleanup = await readTaskCleanupRecord(this.files, snapshot, taskId)
      if (cleanup?.version === 1 && cleanup.taskId === taskId && cleanup.historyCleared === true
        && (!task || taskLifecycle(cleanup) === taskLifecycle(task))) continue
      // File deletion alone does not release this Host's runtime associations.
      if (task && !await this.taskCleanupReady(task, cleanup)) continue
      const preservedPaths = unique([...(task?.resultPaths ?? []),
        ...resultReferences.filter(path => path.startsWith(paths.archive(task ?? taskId) + '/') || path.startsWith(paths.run(taskId) + '/'))].map(filePath))
      const preserve = (path: string) => preservedPaths.some(keep => path === keep || path.startsWith(keep + '/'))
      const entries = new Map<string, FileEntry>(), targets: Target[] = [], guards: FileEntry[] = [], legacySelections: LegacySelection[] = []
      for (const root of [paths.archive(task ?? taskId), paths.run(taskId), 'Recorder Cache/' + taskId])
        for (const entry of await this.files.list(snapshot, root, task && root === paths.archive(task) ? taskArchiveSelection(task) : undefined)) entries.set(entry.path, entry)
      // Current physical results are named in this Task's retained identity.
      // For old imported artifact records, look up the manifest of each actual
      // selected archive file. Never enumerate every Task's manifest catalog.
      for (const entry of entries.values()) if (entry.path.startsWith(paths.archive(task ?? taskId) + '/')) {
        const manifest = await readJson<{ taskId: string; path: string }>(this.files, snapshot,
          'technical/artifacts/manifests/' + hash(entry.path) + '.json')
        if (manifest?.taskId === taskId && manifest.path === entry.path && !preservedPaths.includes(entry.path)) preservedPaths.push(entry.path)
      }
      preservedPaths.sort()
      if (task) {
        for (const path of [paths.task(taskId), taskArchiveStatePath(task), ...(this.files instanceof PhysicalLocalFiles ? [taskHistoryPath(taskId)] : [])]) { const version = await this.version(snapshot, path); if (version) guards.push({ path, version }) }
        const source = await this.files.read(snapshot, task.sourcePath)
        if (/^tasks\/[^/]+_(P|O)\.md$/.test(task.sourcePath) && source !== undefined && taskIdentity(source) === taskId) {
          const entry = taskFiles.find(item => item.path === task.sourcePath); if (entry) entries.set(entry.path, entry)
        }
      }
      for (const migration of migrations) {
        const selected = legacyIdentities.get(migration.path)?.find(item => item.taskId === taskId)
        if (!selected) continue
        legacySelections.push({ manifestPath: migration.path, oldId: selected.oldId, taskId })
        const owns = legacyTaskOwns(selected.oldId)
        for (const record of migration.manifest.records) if (owns(record.key)) await addMigrationEntry(this.files, snapshot, entries, migration.path, record.path, migration.manifest, owns)
        for (const [ref, path] of Object.entries(migration.manifest.references)) if (owns(decodeReference(ref))) await addMigrationEntry(this.files, snapshot, entries, migration.path, path, migration.manifest, owns)
        // Read compatibility for already-confirmed previews/plans only. Their
        // command fingerprint cannot be replaced during an uncertain replay.
        targets.push(priorPlan ? { path: migration.path, version: await this.version(snapshot, migration.path), action: 'migration' }
          : migrationTarget(migration.path, migration.manifest, {
            taskIds: [taskId], oldIds: [selected.oldId], assistantIds: [], messagePaths: [], paths: [...entries.keys()],
          }))
      }
      for (const entry of entries.values()) if ((!task || entry.path !== taskArchiveStatePath(task)) && !preserve(entry.path)) targets.push({ path: entry.path, version: entry.version, action: 'delete' })
      const all = [...entries.values(), ...guards].sort((a, b) => a.path.localeCompare(b.path))
      const identity: unknown[] = [taskId, all.map(({ path, version }) => [path, version]), mergeTargets(targets), preservedPaths]
      const signature = hash(json(identity))
      result.push({ taskId, legacySelections, targets: mergeTargets(targets), guards, preservedPaths, signature,
        bytes: [...entries.values()].filter(entry => (!task || entry.path !== taskArchiveStatePath(task)) && !preserve(entry.path)).reduce((sum, entry) => sum + (entry.bytes ?? 0), 0) })
    }
    return result.sort((a, b) => a.taskId.localeCompare(b.taskId))
  }
  private async conversationIndex(snapshot: FilesSnapshot): Promise<MessageIndex> {
    const index = await readJson<MessageIndex>(this.files, snapshot, this.conversation.indexPath) ?? { version: 1, messages: [] }
    if (index.version !== 1 || !Array.isArray(index.messages)) throw new Error('Invalid conversation index.')
    return index
  }

}
function mergeTargets(targets: readonly Target[]): Target[] {
  const values = new Map<string, Target>()
  for (const target of targets) {
    const prior = values.get(target.path)
    if (prior?.action === 'migration' && target.action === 'migration' && prior.selections && target.selections) {
      const selections = new Map([...prior.selections, ...target.selections].map(selection => [json(selection), selection]))
      values.set(target.path, { ...target, selections: [...selections].sort(([a], [b]) => a.localeCompare(b)).map(([, selection]) => selection) })
    } else if (prior?.action === 'migration' && target.action === 'migration' && (prior.selections || target.selections)) {
      // A prior confirmed conversation can capture its final native output
      // after upgrade. Keep that original whole-version condition, not a new command.
      values.set(target.path, prior.selections ? target : prior)
    } else {
      if (prior && json(prior) !== json(target)) throw new Error('Cleanup target has conflicting ownership.')
      values.set(target.path, target)
    }
  }
  return [...values.values()].sort((a, b) => a.path.localeCompare(b.path))
}
/** Freeze the selected rows and every reference to their actual file targets.
 * A new reference to a deletion target is a real change; an unrelated Task row
 * is not. Only digests, identities and paths enter the durable cleanup plan. */
function migrationSignature(manifest: Migrated, selection: Omit<MigrationSelection, 'signature'>): string {
  const owns = (key: string) => selection.oldIds.some(id => legacyTaskOwns(id)(key)) || selection.assistantIds.some(id => legacyConversationOwns(id, key))
  const selected = (row: { oldId: string; taskId: string }) => selection.oldIds.includes(row.oldId) || selection.taskIds.includes(row.taskId)
  const references = Object.entries(manifest.references).filter(([ref, path]) => owns(decodeReference(ref)) || selection.paths.includes(path))
    .sort(([a], [b]) => a.localeCompare(b)).map(([ref, path]) => [ref, path, manifest.referenceHashes[ref]])
  const rows = (items: unknown[]) => items.map(json).sort()
  return hash(json({ version: manifest.version, id: manifest.id, baseline: manifest.baseline, source: manifest.source,
    tasks: rows(manifest.tasks.filter(selected)), clearedTasks: rows((manifest.clearedTasks ?? []).filter(selected)),
    messages: rows(manifest.messages.filter(message => selection.messagePaths.includes(message.path)
      || selection.assistantIds.some(id => decodeReference(message.reference).startsWith('conversations/' + id + '/')))),
    records: rows(manifest.records.filter(record => owns(record.key) || selection.paths.includes(record.path))), references }))
}
function migrationTarget(path: string, manifest: Migrated, selection: Omit<MigrationSelection, 'signature'>): Target {
  const selected = { taskIds: unique(selection.taskIds), oldIds: unique(selection.oldIds), assistantIds: unique(selection.assistantIds), messagePaths: unique(selection.messagePaths), paths: unique(selection.paths) }
  return { path, version: null, action: 'migration', selections: [{ ...selected, signature: migrationSignature(manifest, selected) }] }
}
function decodeReference(ref: string): string { return ref.startsWith('dss-record://') ? decodeURIComponent(ref.slice('dss-record://'.length)) : ref }
function legacyConversationOwns(id: string, key: string): boolean {
  return ['conversations', 'conversation-index', 'conversation-staging', 'conversation-exchanges'].some(root => key.startsWith(root + '/' + id + '/'))
    || key.startsWith('assistant-history/' + id + '/session/') || key.startsWith('assistant-history/' + id + '/input/')
}
function legacyTaskOwns(taskId: string): (key: string) => boolean {
  const id = encodeURIComponent(taskId), roots = ['planner-memory', 'planner-note', 'worker-reply', 'recovery', 'execution', 'task-runtime', 'task-staging', 'records', 'record-archive', 'task-origin']
  return key => key === 'task:' + taskId || key === 'task-history/' + id || roots.some(root => key.startsWith(root + '/' + id + '/'))
}
async function addMigrationEntry(files: FilesStore, snapshot: FilesSnapshot, entries: Map<string, FileEntry>, manifestPath: string, path: string,
  manifest: Migrated, owns: (key: string) => boolean): Promise<void> {
  filePath(path)
  const root = manifestPath.slice(0, -'manifest.json'.length)
  if (!path.startsWith(root + 'source/') && !path.startsWith(root + 'text/')) return // actual artifact destinations are not source copies
  // A family prefix is not authority to erase an unknown shared reference.
  if (manifest.records.some(record => record.path === path && !owns(record.key))
    || Object.entries(manifest.references).some(([reference, destination]) => destination === path && !owns(decodeReference(reference)))) return
  const entry = (await files.listDirectory(snapshot, path.slice(0, path.lastIndexOf('/') + 1))).find(entry => entry.path === path)
  if (entry) entries.set(path, entry)
}
