import { createHash } from 'node:crypto'
import { FrameworkConversation } from './conversation.js'
import { FrameworkTransactions } from './command-transactions.js'
import { LocalFiles } from './local-files.js'
import { cleanupRecordPath, type CleanupRecord } from './cleaner.js'
import { paths, readJson, taskIdentity, type TaskMetadata } from './task-files.js'
import { FilesConflictError, filePath, withSnapshot, type FileChange, type FileEntry, type FileReceipt, type FilesSnapshot, type FilesStore } from './transactions.js'
import type { MigrationManifest } from './legacy-migration.js'
import { listLegacyRecordExports, readLegacyRecordExport } from './legacy-record-export.js'

export interface CancelledTaskCleanupEvidence { commandId: string; signature: string }
export interface ManualCleanupLifecycle {
  /** Own the exact native stop, retire old capture/recovery and persist the new
   * Foreground epoch before action. Same command never resets a later epoch. */
  withForegroundReset<T>(commandId: string, action: (capturedMessageIds?: readonly string[]) => Promise<T>): Promise<T>
  /** Confirm this Task's actual producer settlement, not a stop request.
   * Cancelled Tasks retain their control hold until the file receipt is committed. */
  prepareTaskCleanup(taskId: string): Promise<void>
  /** Pure observation: an explicit current cancellation and exact, already
   * settled native producer ownership. No stop request or control release. */
  cancelledTaskCleanupEvidence?(taskId: string): Promise<CancelledTaskCleanupEvidence | undefined>
}
export interface ManualTaskCleanupPreview {
  id: string
  tasks: Array<{ taskId: string; signature: string; files: number; bytes: number }>
  fileCount: number
  bytes: number
  preservedPaths: string[]
}
export interface ManualCleanupResult {
  cleared: true
  receipt: FileReceipt
  deletedPaths: string[]
  preservedPaths: string[]
}
export interface ManualTaskCleanupRecord extends CleanupRecord {
  historyCleared: true; preservedArtifacts: string[]
  /** Manual retirement evidence, never a claim that Recorder sealed this Task. */
  manualCancellation?: CancelledTaskCleanupEvidence
}
type Kind = 'tasks' | 'conversation' | 'planning'
interface Target { path: string; version: string | null; action: 'delete' | 'empty' | 'index' | 'migration' | 'notification' }
interface LegacySelection { manifestPath: string; oldId: string; taskId: string }
interface Plan {
  version: 1; kind: Kind; scope: string; targets: Target[]; taskIds: string[]; messagePaths: string[]; preservedPaths: string[]
  taskSignatures?: Record<string, string>
  legacySelections?: LegacySelection[]
  cancelledTasks?: Record<string, CancelledTaskCleanupEvidence>
  messageIds?: Record<string, string>
  completed?: true
}
interface Intent { version: 1; kind: Kind; commandId: string; scope: string; confirmation: string; preview?: ManualTaskCleanupPreview; conversation?: Plan }
interface MessageIndex { version: number; messages: Array<{ id: string; path: string; notification?: string }> }
interface Candidate { cancelled?: CancelledTaskCleanupEvidence; legacySelections: LegacySelection[]; taskId: string; targets: Target[]; guards: FileEntry[]; preservedPaths: string[]; bytes: number; signature: string }
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
  private local(): void {
    if (!(this.files instanceof LocalFiles) || this.conversation.scope.mode !== 'local') throw new Error('Manual record cleanup is a Local user action.')
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
    await this.intent({ version: 1, kind: 'tasks', commandId, scope: this.scope, confirmation, preview })
    return this.execute(commandId, 'tasks', { previewId: preview.id }, async snapshot => {
      const candidates = await this.candidates(snapshot), selected: Candidate[] = []
      for (const expected of preview.tasks) {
        const current = candidates.find(item => item.taskId === expected.taskId)
        if (!current || current.signature !== expected.signature) throw new Error('Task cleanup preview changed; review the current records before clearing.')
        selected.push(current)
      }
      // A request to stop is not proof of settlement. No files have been removed.
      for (const item of selected) await this.lifecycle.prepareTaskCleanup(item.taskId)
      for (const item of selected) if (item.cancelled) await this.assertCancellation(item.taskId, item.cancelled)
      return { version: 1, kind: 'tasks', scope: this.scope, targets: mergeTargets(selected.flatMap(item => item.targets)),
        taskIds: selected.map(item => item.taskId), cancelledTasks: Object.fromEntries(selected.filter(item => item.cancelled).map(item => [item.taskId, item.cancelled!])), legacySelections: selected.flatMap(item => item.legacySelections), taskSignatures: Object.fromEntries(selected.map(item => [item.taskId, item.signature])),
        messagePaths: [], preservedPaths: unique(selected.flatMap(item => item.preservedPaths)) }
    })
  }
  async clearConversation(commandId: string, confirmation: 'clear-foreground-conversation'): Promise<ManualCleanupResult> {
    this.local(); this.confirm(commandId, confirmation, 'clear-foreground-conversation')
    const done = await this.completed(commandId, 'conversation')
    if (done) return done
    const intent = await this.intent({ version: 1, kind: 'conversation', commandId, scope: this.scope, confirmation }, snapshot => this.conversationPlan(snapshot))
    // A legacy pending request without its original selection must not infer that
    // newer conversation belongs to an earlier confirmation.
    const original = intent.conversation ?? await withSnapshot(this.files, snapshot => readJson<Plan>(this.files, snapshot, this.planPath(commandId)))
    if (!original) throw new Error('The original confirmed conversation selection is unavailable; preserve its records.')
    return this.lifecycle.withForegroundReset(commandId, capturedMessageIds => this.execute(commandId, 'conversation', {}, async snapshot => {
      if (!capturedMessageIds?.length) return original
      const captured = await this.conversationPlan(snapshot, capturedMessageIds)
      return { ...original, targets: mergeTargets([...original.targets, ...captured.targets]),
        messagePaths: unique([...original.messagePaths, ...captured.messagePaths]), messageIds: { ...original.messageIds, ...captured.messageIds } }
    }))
  }
  async clearPlanning(commandId: string, confirmation: 'clear-work-planning-notes'): Promise<ManualCleanupResult> {
    this.local(); this.confirm(commandId, confirmation, 'clear-work-planning-notes')
    await this.intent({ version: 1, kind: 'planning', commandId, scope: this.scope, confirmation })
    return this.execute(commandId, 'planning', {}, async snapshot => {
      const targets: Target[] = []
      for (const name of ['Foreground_List.md', 'Foreground_Cache.md']) {
        const path = this.conversation.foregroundRoot + '/' + name
        targets.push({ path, version: await this.version(snapshot, path), action: 'empty' })
      }
      return { version: 1, kind: 'planning', scope: this.scope, targets, taskIds: [], messagePaths: [], preservedPaths: [] }
    })
  }
  private confirm(commandId: string, actual: string, expected: string): void {
    if (!commandId || actual !== expected) throw new Error('This cleanup requires its explicit confirmation and stable command identity.')
  }
  private planPath(commandId: string): string { return 'technical/manual-cleanup/commands/' + hash(this.scope + '\0' + commandId) + '.json' }
  private async intent(intent: Intent, conversation?: (snapshot: FilesSnapshot) => Promise<Plan>): Promise<Intent> {
    const id = hash(this.scope + '\0' + intent.commandId)
    const path = 'technical/manual-cleanup/intents/' + id + '.json'
    await this.transactions.run('manual-cleanup:' + id + ':intent', intent, { reevaluate: true }, async snapshot => [
      { path, content: json({ ...intent, ...(conversation ? { conversation: await conversation(snapshot) } : {}) }) },
    ])
    const saved = await withSnapshot(this.files, snapshot => readJson<Intent>(this.files, snapshot, path))
    if (!saved || saved.commandId !== intent.commandId || saved.scope !== this.scope || saved.kind !== intent.kind) throw new Error('Confirmed cleanup intent does not match its original owner.')
    return saved
  }
  /** Service resumes only these actually confirmed operations, before admitting
   * new input or restoring Foreground. No preview is automatically confirmed. */
  async resumePending(onError?: (error: unknown, commandId: string) => void): Promise<ManualCleanupResult[]> {
    this.local()
    const pending = await withSnapshot(this.files, async snapshot => {
      const result: Intent[] = []
      for (const entry of await this.files.listDirectory(snapshot, 'technical/manual-cleanup/intents/')) {
        const intent = await readJson<Intent>(this.files, snapshot, entry.path)
        if (!intent || intent.scope !== this.scope) continue
        if (intent.version !== 1 || entry.path !== 'technical/manual-cleanup/intents/' + hash(this.scope + '\0' + intent.commandId) + '.json') throw new Error('Invalid confirmed cleanup identity.')
        const plan = await readJson<Plan>(this.files, snapshot, this.planPath(intent.commandId))
        if (!plan?.completed) result.push(intent)
      }
      return result
    })
    const results: ManualCleanupResult[] = [], errors: unknown[] = []
    for (const intent of pending) {
      try {
        if (intent.kind === 'conversation') results.push(await this.clearConversation(intent.commandId, intent.confirmation as 'clear-foreground-conversation'))
        else if (intent.kind === 'planning') results.push(await this.clearPlanning(intent.commandId, intent.confirmation as 'clear-work-planning-notes'))
        else if (intent.kind === 'tasks' && intent.preview) results.push(await this.clearTasks(intent.commandId, intent.preview, intent.confirmation as 'clear-ended-task-records'))
        else throw new Error('Invalid confirmed cleanup action.')
      } catch (error) {
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
    return { cleared: true, receipt, deletedPaths: plan.targets.filter(item => item.action === 'delete').map(item => item.path), preservedPaths: plan.preservedPaths }
  }
  private async execute(commandId: string, kind: Kind, selection: unknown, build: (snapshot: FilesSnapshot) => Promise<Plan>): Promise<ManualCleanupResult> {
    const path = this.planPath(commandId), id = 'manual-cleanup:' + hash(this.scope + '\0' + commandId)
    await this.transactions.run(id + ':plan', { scope: this.scope, kind, selection }, { reevaluate: true }, async snapshot => {
      if (await this.files.read(snapshot, path) !== undefined) throw new Error('Cleanup command plan exists without its matching receipt.')
      return [{ path, content: json(await build(snapshot)) }]
    })
    const plan = await withSnapshot(this.files, snapshot => readJson<Plan>(this.files, snapshot, path))
    if (!plan || plan.kind !== kind || plan.scope !== this.scope) throw new Error('Cleanup plan is missing or belongs to another action.')
    if (plan.completed) return this.result(plan, { revision: (await withSnapshot(this.files, async snapshot => snapshot.revision)), replay: true })
    const apply = () => this.transactions.run(id + ':apply', { scope: this.scope, kind, planHash: hash(json(plan)) }, { reevaluate: true }, async snapshot => {
      const changes: FileChange[] = []
      const index = kind === 'conversation' ? await this.conversationIndex(snapshot) : undefined
      if (index) for (const path of plan.messagePaths) {
        const current = index.messages.find(message => message.path === path)
        if (!current || plan.messageIds?.[path] !== undefined && current.id !== plan.messageIds[path]) throw new Error('Confirmed conversation message identity changed: ' + path)
      }
      let current: Candidate[] = []
      if (plan.taskSignatures) {
        current = await this.candidates(snapshot)
        for (const [taskId, signature] of Object.entries(plan.taskSignatures)) if (current.find(task => task.taskId === taskId)?.signature !== signature) throw new Error('Reviewed Task cleanup changed before dispatch: ' + taskId)
      }
      for (const target of plan.targets) {
        if (target.action === 'index') {
          if (!index || target.path !== this.conversation.indexPath) throw new Error('Invalid conversation cleanup index target.')
          changes.push({ path: target.path, content: json({ ...index, messages: index.messages.filter(message => !plan.messagePaths.includes(message.path)) }) })
          continue
        }
        if (target.action === 'notification') {
          // A consumed empty signal may be reused by a later message. Its empty
          // content hash cannot prove which message owns it; use the current index.
          if (index?.messages.some(message => message.notification === target.path && !plan.messagePaths.includes(message.path))) continue
          const version = await this.version(snapshot, target.path)
          if (version === null) continue
          if (version !== target.version) throw new Error('Reviewed cleanup target changed: ' + target.path)
          changes.push({ path: target.path, content: null }); continue
        }
        if (await this.version(snapshot, target.path) !== target.version) throw new Error('Reviewed cleanup target changed: ' + target.path)
        if (target.action === 'migration') {
          const manifest = await readJson<Migrated>(this.files, snapshot, target.path)
          if (!manifest) throw new Error('Migration map disappeared.')
          const removed = new Set(plan.targets.filter(item => item.action === 'delete').map(item => item.path))
          // The fixed plan also names history-only identities omitted by the
          // old migration consumer. Do not fabricate live Task rows or a
          // Cleaner release; this existing receipt records only user disposal.
          const cleared = plan.legacySelections?.filter(item => item.manifestPath === target.path)
            ?? manifest.tasks.filter(task => plan.taskIds.includes(task.taskId)).map(({ oldId, taskId }) => ({ oldId, taskId }))
          manifest.clearedTasks ??= []
          for (const { oldId, taskId } of cleared) {
            if (!plan.taskIds.includes(taskId)) throw new Error('Legacy cleanup identity is outside the fixed selection.')
            const prior = manifest.clearedTasks.find(item => item.oldId === oldId)
            if (prior && prior.taskId !== taskId) throw new Error('Legacy cleanup identity differs from its retained receipt.')
            const preservedArtifacts = plan.preservedPaths.filter(path => path.startsWith(paths.archive(taskId) + '/'))
            if (prior) prior.preservedArtifacts = unique([...(prior.preservedArtifacts ?? []), ...preservedArtifacts])
            else manifest.clearedTasks.push({ oldId, taskId, preservedArtifacts })
          }
          manifest.tasks = manifest.tasks.filter(task => !plan.taskIds.includes(task.taskId))
          manifest.messages = manifest.messages.filter(message => !plan.messagePaths.includes(message.path))
          manifest.records = manifest.records.filter(record => !removed.has(record.path))
          for (const [reference, destination] of Object.entries(manifest.references)) if (removed.has(destination)) { delete manifest.references[reference]; delete manifest.referenceHashes[reference] }
          changes.push({ path: target.path, content: json(manifest) })
        } else changes.push({ path: target.path, content: target.action === 'delete' ? null : '' })
      }
      for (const taskId of plan.taskIds) {
        const cleanup = await readJson<CleanupRecord>(this.files, snapshot, cleanupRecordPath(taskId))
        const cancelled = plan.cancelledTasks?.[taskId]
        if (cancelled) {
          const candidate = current.find(item => item.taskId === taskId)
          if (!candidate?.cancelled || json(candidate.cancelled) !== json(cancelled)) throw new Error('Task cancellation ownership changed before cleanup.')
          if (cleanup && (cleanup.version !== 1 || cleanup.taskId !== taskId)) throw new Error('Task cleanup receipt belongs to another identity.')
          const retired: ManualTaskCleanupRecord = { ...(cleanup ?? {
            version: 1, taskId, retentionHash: 'manual:' + hash(json(plan)),
            deletedPaths: candidate.targets.filter(target => target.action === 'delete').map(target => target.path), preservedPaths: candidate.preservedPaths,
          }), phase: 'released', historyCleared: true, preservedArtifacts: candidate.preservedPaths, manualCancellation: cancelled }
          changes.push({ path: cleanupRecordPath(taskId), content: json(retired) })
        } else if (cleanup) {
          if (cleanup.phase !== 'released' || cleanup.taskId !== taskId) throw new Error('Task cleanup has no confirmed released identity.')
          const task = await readJson<TaskMetadata>(this.files, snapshot, paths.task(taskId))
          changes.push({ path: cleanupRecordPath(taskId), content: json({ ...cleanup, historyCleared: true,
            preservedArtifacts: plan.preservedPaths.filter(path => path.startsWith(paths.archive(taskId) + '/')
              || path.startsWith(paths.run(taskId) + '/') || task?.resultPaths?.includes(path)) } satisfies ManualTaskCleanupRecord) })
        }
      }
      changes.push({ path, content: json({ ...plan, completed: true }) })
      for (const [taskId, evidence] of Object.entries(plan.cancelledTasks ?? {})) await this.assertCancellation(taskId, evidence)
      return changes
    })
    for (;;) {
      try { return this.result(plan, await apply()) }
      catch (error) {
        if (kind !== 'conversation' || !(error instanceof FilesConflictError)
          || await withSnapshot(this.files, async snapshot => snapshot.revision) === error.expectedRevision) throw error
        // Only a proven changed Local authority permits replay of this identical
        // plan. UNKNOWN itself is surfaced; no new targets or command are made.
      }
    }
  }
  private async cancellation(taskId: string): Promise<CancelledTaskCleanupEvidence | undefined> {
    const evidence = await this.lifecycle.cancelledTaskCleanupEvidence?.(taskId)
    if (evidence === undefined) return undefined
    if (!evidence || typeof evidence.commandId !== 'string' || !evidence.commandId || typeof evidence.signature !== 'string' || !evidence.signature)
      throw new Error('Cancelled Task cleanup requires exact cancellation and settled producer evidence.')
    return { commandId: evidence.commandId, signature: evidence.signature }
  }
  private async assertCancellation(taskId: string, expected: CancelledTaskCleanupEvidence): Promise<void> {
    const current = await this.cancellation(taskId)
    if (!current || current.commandId !== expected.commandId || current.signature !== expected.signature)
      throw new Error('Task cancellation or settled producer ownership changed before cleanup: ' + taskId)
  }
  private async version(snapshot: FilesSnapshot, path: string): Promise<string | null> {
    filePath(path)
    return (await this.files.listDirectory(snapshot, path.slice(0, path.lastIndexOf('/') + 1))).find(entry => entry.path === path)?.version ?? null
  }
  private async migrations(snapshot: FilesSnapshot): Promise<Array<{ path: string; manifest: Migrated; version: string }>> {
    const index = await readJson<{ migrations: Array<{ manifestPath: string }> }>(this.files, snapshot, 'technical/legacy-migrations/index.json')
    const result: Array<{ path: string; manifest: Migrated; version: string }> = []
    for (const item of index?.migrations ?? []) {
      if (!/^technical\/legacy-migrations\/[^/]+\/manifest.json$/.test(item.manifestPath)) throw new Error('Invalid migration manifest path.')
      const manifest = await readJson<Migrated>(this.files, snapshot, item.manifestPath), version = await this.version(snapshot, item.manifestPath)
      if (!manifest || !version || manifest.source.mode !== 'local') continue
      result.push({ path: item.manifestPath, manifest, version })
    }
    return result
  }
  private async candidates(snapshot: FilesSnapshot): Promise<Candidate[]> {
    const taskFiles = await this.files.listDirectory(snapshot, 'tasks/'), migrations = await this.migrations(snapshot)
    const currentIds = new Set(taskFiles.filter(entry => /^tasks\/[^/]+\.json$/.test(entry.path)).map(entry => entry.path.slice('tasks/'.length, -'.json'.length)))
    const tasks = new Map<string, TaskMetadata | undefined>(), cancellations = new Map<string, CancelledTaskCleanupEvidence>(), resultReferences: string[] = []
    for (const entry of taskFiles.filter(entry => /^tasks\/[^/]+\.json$/.test(entry.path))) {
      const task = await readJson<TaskMetadata>(this.files, snapshot, entry.path)
      for (const path of task?.resultPaths ?? []) resultReferences.push(filePath(path))
      if (task && entry.path === paths.task(task.taskId)) {
        if (task.status === 'complete') tasks.set(task.taskId, task)
        else if (task.status === 'running') {
          const evidence = await this.cancellation(task.taskId)
          if (evidence) { tasks.set(task.taskId, task); cancellations.set(task.taskId, evidence) }
        }
      }
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
    const artifacts = await this.files.list(snapshot, 'technical/artifacts/manifests/')
    const artifactPaths = new Map<string, string[]>()
    for (const entry of artifacts) {
      const value = await readJson<{ taskId: string; path: string }>(this.files, snapshot, entry.path)
      if (value?.taskId && value.path?.startsWith(paths.archive(value.taskId) + '/')) artifactPaths.set(value.taskId, [...(artifactPaths.get(value.taskId) ?? []), filePath(value.path)])
    }
    const result: Candidate[] = []
    for (const [taskId, task] of tasks) {
      if ((await readJson<ManualTaskCleanupRecord>(this.files, snapshot, cleanupRecordPath(taskId)))?.historyCleared) continue
      // A completed task may still owe Foreground delivery/Recorder preservation.
      // Those existing responsibilities are not silently consumed by manual cleanup.
      const cancelled = cancellations.get(taskId)
      if (task && !cancelled && (await readJson<CleanupRecord>(this.files, snapshot, cleanupRecordPath(taskId)))?.phase !== 'released') continue
      const preservedPaths = unique([...(task?.resultPaths ?? []), ...(artifactPaths.get(taskId) ?? []),
        ...resultReferences.filter(path => path.startsWith(paths.archive(taskId) + '/') || path.startsWith(paths.run(taskId) + '/'))].map(filePath))
      const preserve = (path: string) => preservedPaths.some(keep => path === keep || path.startsWith(keep + '/'))
      const entries = new Map<string, FileEntry>(), targets: Target[] = [], guards: FileEntry[] = [], legacySelections: LegacySelection[] = []
      for (const root of [paths.archive(taskId), paths.run(taskId), 'Recorder Cache/' + taskId]) for (const entry of await this.files.list(snapshot, root)) entries.set(entry.path, entry)
      if (task) {
        for (const path of [paths.task(taskId), cleanupRecordPath(taskId)]) { const version = await this.version(snapshot, path); if (version) guards.push({ path, version }) }
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
        targets.push({ path: migration.path, version: migration.version, action: 'migration' })
      }
      for (const entry of entries.values()) if (!preserve(entry.path)) targets.push({ path: entry.path, version: entry.version, action: 'delete' })
      const all = [...entries.values(), ...guards].sort((a, b) => a.path.localeCompare(b.path))
      const identity: unknown[] = [taskId, all.map(({ path, version }) => [path, version]), mergeTargets(targets), preservedPaths]
      if (cancelled) identity.push({ cancelled })
      const signature = hash(json(identity))
      result.push({ taskId, ...(cancelled ? { cancelled } : {}), legacySelections, targets: mergeTargets(targets), guards, preservedPaths, signature,
        bytes: [...entries.values()].filter(entry => !preserve(entry.path)).reduce((sum, entry) => sum + (entry.bytes ?? 0), 0) })
    }
    return result.sort((a, b) => a.taskId.localeCompare(b.taskId))
  }
  private async conversationIndex(snapshot: FilesSnapshot): Promise<MessageIndex> {
    const index = await readJson<MessageIndex>(this.files, snapshot, this.conversation.indexPath) ?? { version: 1, messages: [] }
    if (index.version !== 1 || !Array.isArray(index.messages)) throw new Error('Invalid conversation index.')
    return index
  }
  private async conversationPlan(snapshot: FilesSnapshot, capturedMessageIds?: readonly string[]): Promise<Plan> {
    const index = await this.conversationIndex(snapshot)
    const targets: Target[] = [], messagePaths: string[] = [], oldAssistants = new Set<string>()
    const selected = capturedMessageIds ? index.messages.filter(item => capturedMessageIds.includes(item.id)) : index.messages
    if (capturedMessageIds?.some(id => !selected.some(item => item.id === id))) throw new Error('Confirmed old Foreground capture is absent from this conversation.')
    const messageIds: Record<string, string> = {}
    for (const item of selected) {
      const entry = await readJson<{ id: string; role: string; collaborationId: string; textPath: string; legacy?: { reference: string } }>(this.files, snapshot, item.path)
      if (!entry || entry.id !== item.id || entry.collaborationId !== this.conversation.scope.collaborationId
        || capturedMessageIds && entry.role !== 'assistant'
        || !/^conversations\/local\/[^/]+\/[^/]+\/[^/]+\/entry.json$/.test(item.path)
        || entry.textPath !== item.path.replace(/entry.json$/, 'text')) throw new Error('Conversation cleanup requires exact owned message references.')
      const root = item.path.slice(0, -'entry.json'.length)
      for (const file of await this.files.list(snapshot, root)) targets.push({ path: file.path, version: file.version, action: 'delete' })
      messagePaths.push(item.path)
      messageIds[item.path] = item.id
      if (entry.legacy?.reference) { const old = /^conversations\/([^/]+)\//.exec(decodeReference(entry.legacy.reference)); if (old) oldAssistants.add(old[1]) }
      if (item.notification) {
        if (!/^state\/Foreground_[^/]+$/.test(item.notification)) throw new Error('Invalid conversation notification path.')
        const version = await this.version(snapshot, item.notification)
        if (version) targets.push({ path: item.notification, version, action: 'notification' })
      }
    }
    for (const migration of await this.migrations(snapshot)) {
      if (!migration.manifest.messages.some(message => messagePaths.includes(message.path))) continue
      const entries = new Map<string, FileEntry>()
      const exclusive = [...oldAssistants].filter(id => !migration.manifest.messages.some(message => !messagePaths.includes(message.path)
        && decodeReference(message.reference).startsWith('conversations/' + id + '/')))
      const owns = (key: string) => exclusive.some(id => ['conversations', 'conversation-index', 'conversation-staging', 'conversation-exchanges'].some(root => key.startsWith(root + '/' + id + '/'))
        || key.startsWith('assistant-history/' + id + '/session/') || key.startsWith('assistant-history/' + id + '/input/'))
      for (const record of migration.manifest.records) if (owns(record.key)) await addMigrationEntry(this.files, snapshot, entries, migration.path, record.path, migration.manifest, owns)
      for (const [reference, path] of Object.entries(migration.manifest.references)) if (owns(decodeReference(reference))) await addMigrationEntry(this.files, snapshot, entries, migration.path, path, migration.manifest, owns)
      for (const file of entries.values()) targets.push({ path: file.path, version: file.version, action: 'delete' })
      targets.push({ path: migration.path, version: migration.version, action: 'migration' })
    }
    targets.push({ path: this.conversation.indexPath, version: null, action: 'index' })
    return { version: 1, kind: 'conversation', scope: this.scope, targets: mergeTargets(targets), taskIds: [], messagePaths, messageIds, preservedPaths: [] }
  }
}
function mergeTargets(targets: readonly Target[]): Target[] {
  const values = new Map<string, Target>()
  for (const target of targets) { const prior = values.get(target.path); if (prior && json(prior) !== json(target)) throw new Error('Cleanup target has conflicting ownership.'); values.set(target.path, target) }
  return [...values.values()].sort((a, b) => a.path.localeCompare(b.path))
}
function decodeReference(ref: string): string { return ref.startsWith('dss-record://') ? decodeURIComponent(ref.slice('dss-record://'.length)) : ref }
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
