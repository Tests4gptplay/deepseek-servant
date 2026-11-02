import { createHash } from 'node:crypto'
import { legacyDeclaredArtifacts } from './legacy-artifacts.js'
import type { StoragePort } from '../contracts/ports.js'
import type { SkillRecord, ProjectFact, Preference } from '../contracts/knowledge.js'
import type { Assistant } from '../contracts/assistant.js'
import type { Context } from '@deepseek-ai/cordis'
import { CoopSettingsSchema } from '../experimental/private-git/contracts.js'
import type { Task } from '../contracts/task.js'
import type { RecordEntry } from '../contracts/records.js'
import { RecordJournal } from '../application/record-journal.js'
import { decodeLegacySealedRecords, decodeLegacySealedTask, legacyLocalRecordsReference, LEGACY_BASELINE, legacyMigratedTaskId } from './legacy-record-export.js'
export { LEGACY_BASELINE, legacyMigratedTaskId } from './legacy-record-export.js'
import { TaskRecords, isSeparatedTask, type PreparedTask } from '../application/task-records.js'
import type { RootTask, Join, ParticipantPlan } from '../experimental/private-git/protocol.js'
import type { FrameworkTransactions } from './command-transactions.js'
import { prepareFrameworkSkillIndex, frameworkSkillIndexPath } from './skills.js'
import { FrameworkConversation, type ConversationScope } from './conversation.js'
import { initializeTask, paths, encodeJson, type TaskMetadata } from './task-files.js'
import { workerPaths } from './role-tools.js'
import { GitFiles, filePath, withSnapshot, type FilesStore, type FilesSnapshot, type FileChange } from './transactions.js'

type Continuation = 'running' | 'wait-result' | 'wait-user' | 'paused' | 'cancelled' | 'complete' | 'unresolved'
export interface LegacyNativeExecution {
  executionId: string; sessionId: string; agentId?: string; role: string; generation: number; actionId: string
  ownedJobIds: string[]; originalState?: string; physicalState?: string
  /** Historical physical disposition only; the Host still reconciles actual ownership. */
  recordedSettled: boolean
  original: unknown
}
export interface LegacyTask {
  id: string
  original: unknown
  continuation: Continuation
  request: string
  waits?: Array<{ id: string; memberIdentity: string; question?: string; original: unknown }>
  /** Legacy participant/instance pair, not a guessed current member alias. */
  participants: Array<{ identity: string; nativeExecutions?: LegacyNativeExecution[]; continuation?: Continuation; original: unknown; plan: unknown; children: Array<{ id: string; contract: unknown; reports: unknown[]; executions: unknown[] }> }>
}
export interface LegacyCapture {
  mode: 'local' | 'git'
  revision: string
  baseline: typeof LEGACY_BASELINE
  records: Array<{ key: string; bytes: Uint8Array; reference?: string }>
  texts: Array<{ ref: string; text: string }>
  tasks: LegacyTask[]
  issues: string[]
}
/** 0acd3ba repository-guide, protocol, service, consumer, role-writer and status
 * enumerate these record families. A working root may be the repository root:
 * it is not permission to mirror unrelated project files or configuration. */
const legacyRoots = ['tasks/', 'foreground/', 'participants/', 'instances/', 'assistants/', 'conversations/',
  'intents/', 'inputs/', 'history/', 'records/', 'origins/', 'events/', 'incidents/', 'status/', 'knowledge/', 'inbox/']
function legacySeed(path: string): boolean {
  return /^(participants\/[^/]+\/profile|instances\/[^/]+\/(?:status|watch)|assistants\/[^/]+\/[^/]+\/identity)\.json$/.test(path)
    || /^assistants\/[^/]+\/[^/]+\/Foreground_(List|Cache)\.md$/.test(path)
    || /^conversations\/[^/]+\/[^/]+\/[^/]+\/entry\.json$/.test(path)
    || /^(?:intents|inputs|events)\/[^/]+\/[^/]+\.json$/.test(path)
    || /^history\/[^/]+\.json$/.test(path)
    || /^records\/[^/]+\/(?:manifest\.json|records\.md)$/.test(path)
    || /^inbox\/[^/]+\.md$/.test(path)
    || /^tasks\/[^/]+\/(?:contract|plan|acceptance)\.json$/.test(path)
    || /^tasks\/[^/]+\/initial-plan\/manifest\.json$/.test(path)
    || /^tasks\/[^/]+\/assignments\/[^/]+\.json$/.test(path)
    || /^tasks\/[^/]+\/requests\/[^/]+\/[^/]+\/[^/]+\.json$/.test(path)
    || /^tasks\/[^/]+\/participants\/[^/]+\/instances\/[^/]+\/(?:(?:join|plan)\.json|(?:claims|reports|proposals|reviews)\/[^/]+\.json)$/.test(path)
    || /^(?:tasks\/[^/]+|foreground)\/actions\/[^/]+\/[^/]+\/[^/]+\.json$/.test(path)
    || /^(?:tasks\/[^/]+|foreground)\/executions\/[^/]+\/[^/]+\/(?:(?:binding|outcome|physical-result|incident)\.json|entries\/[^/]+\/(?:operation\.json|(?:[^/]+\/)?(?:manifest|source)\.json))$/.test(path)
    || /^(?:tasks\/[^/]+|foreground)\/executions\/[^/]+\/[^/]+\/(?:transcript|output\/text)\/manifest\.json$/.test(path)
    || /^origins\/[^/]+\/(?:request|goal\/[^/]+)\/manifest\.json$/.test(path)
    || /^knowledge\/[^/]+\/(?:skill|knowledge|preference)\/[^/]+\/(?:manifest|source)\.json$/.test(path)
    || /^incidents\/[^/]+\/[^/]+\/[^/]+\/(?:incident\.json|command\/manifest\.json)$/.test(path)
    || /^status\/(?:tasks\/[^/]+|foreground)\/[^/]+\/[^/]+\/[^/]+\/(?:started|completed|closed|replaced)\.json$/.test(path)
}
export interface MigrationOptions {
  /** Stable host-owned migration identity, persisted before dispatch. */
  id: string
  owner: string
  /** Actual registration mapping: legacy participant/instance -> current member. */
  members: Record<string, string>
  /** Already captured through an authorized filesystem/artifact capability.
   * The migration module never opens an old absolute path itself. */
  artifacts?: Array<{ taskId?: string; artifactId?: string; sourcePath: string; bytes: Uint8Array }>
  nativeOwnershipReconciled?: Record<string, Array<{ executionId: string; generation: number; settled: boolean }>>
  conversations?: Array<{ scope: ConversationScope; assistantId?: string; participantId?: string; entryPaths?: string[];
    foregroundIdentity?: { participantId: string; instanceId: string } }>
}
export interface MigrationManifest {
  version: 1
  id: string
  baseline: string
  source: { mode: 'local' | 'git'; revision: string }
  owner: string
  members: Record<string, string>
  records: Array<{ key: string; path: string; sha256: string }>
  references: Record<string, string>
  referenceHashes: Record<string, string>
  tasks: Array<{ oldId: string; taskId: string; continuation: Continuation; members: string[]; recordPath: string; continuationPath: string; memberContinuations?: Array<{ member: string; identity: string; continuation: Continuation; waits?: Array<{ id: string; question: string }> }> }>
  issues: string[]
  /** Preservation is distinct from switching the corresponding current consumers. */
  pendingAdapters: string[]
  messages: Array<{ reference: string; id: string; path: string; collaborationId: string }>
}
export interface LegacyMigrationPlan {
  expectedRevision: string
  manifestPath: string
  manifest: MigrationManifest
  changes: FileChange[]
}
const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')
const utf8 = (text: string) => Buffer.from(text, 'utf8')
const decode = (data: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(data)
const identity = (value: string) => { filePath(value); if (value.includes('/')) throw new Error('Migration identity must occupy one path segment.'); return value }
function localContinuation(task: Task): Continuation {
  if (task.control === 'cancelled' || task.phase === 'cancelled') return 'cancelled'
  if (task.phase === 'completed') return 'complete'
  if (task.control === 'paused') return 'paused'
  const waits = Object.values(task.waits).filter(wait => wait.state === 'waiting')
  if (waits.some(wait => ['user', 'configuration', 'resource'].includes(wait.kind))) return 'wait-user'
  if (task.phase !== 'waiting') return 'running'
  return waits.length && waits.every(wait => wait.kind === 'job' || wait.kind === 'recovery') ? 'wait-result' : 'unresolved'
}

/** The old API's ScopeTarget is literal('default'); there was no separate
 * selected-assistant setting. Return original profile fields without defaults
 * that could replace its model, workspace or illustration preferences. */
export function legacyLocalProfile(capture: LegacyCapture, assistantId = 'default'): Pick<Assistant, 'settings' | 'workspace' | 'sessionId' | 'priorSessionIds' | 'sessionWorkspaces'> | undefined {
  const record = capture.records.find(record => record.key === 'assistant/' + assistantId)
  if (!record) return undefined
  return legacyProfileFields(JSON.parse(decode(record.bytes)), assistantId)
}

/** Startup configuration lookup does not enumerate or capture historical bodies. */
export async function readLegacyLocalProfile(storage: Pick<StoragePort, 'get'>, assistantId = 'default'): Promise<ReturnType<typeof legacyLocalProfile>> {
  const assistant = await storage.get<Assistant>('assistant/' + assistantId)
  return assistant === undefined ? undefined : legacyProfileFields(structuredClone(assistant), assistantId)
}

function legacyProfileFields(value: unknown, assistantId: string): ReturnType<typeof legacyLocalProfile> {
  const assistant = value as Assistant
  if (assistant.schemaVersion !== 1 || assistant.id !== assistantId || !assistant.settings || !assistant.workspace) throw new Error('Invalid legacy assistant profile.')
  return { settings: assistant.settings, workspace: assistant.workspace, sessionId: assistant.sessionId,
    priorSessionIds: assistant.priorSessionIds ?? [], sessionWorkspaces: assistant.sessionWorkspaces ?? {} }
}

/** Only the original domain's nonsecret global configuration is read. Do not
 * instantiate CoopCache, load its body projections, or generate another UUID. */
export async function readLegacyCoopSettings(ctx: Pick<Context, 'storageDomain'>) {
  const [{ defineDomain, domainTable }, { z }] = await Promise.all([import('@deepseek-ai/dsh-storage-domain'), import('zod')])
  const spec = defineDomain({ name: 'deepseek_servant_coop', version: 1, layout: 'per-record',
    global: { schema: z.object({ instanceId: z.string(), settings: CoopSettingsSchema }), initial: { instanceId: '', settings: CoopSettingsSchema.parse({}) } },
    tables: { cache: domainTable<string, unknown>(z.unknown()) } })
  const domain = await ctx.storageDomain.open(spec)
  try { return structuredClone(domain.global.get()) } finally { await domain.close() }
}

/** Logical families emitted by the fixed baseline StoragePort writers. In
 * particular framework-* records belong to the new implementation and must
 * never change the old source revision during cutover/restart. Physical record
 * file backups are not StoragePort keys and are not claimed as captured here. */
const localLegacyPrefixes = ['task:', 'task-staging/', 'task-runtime/', 'task-origin/',
  'goal-origin/', 'handoff/', 'task-turn/', 'records-staging/', 'conversation/',
  'planner-memory/', 'planner-note/', 'worker-reply/', 'execution/', 'recovery/',
  'records/', 'record-archive/', 'task-history/', 'tombstone/', 'assistant/',
  'assistant-history/', 'foreground-memory/', 'conversations/', 'conversation-index/',
  'conversation-exchanges/', 'conversation-staging/', 'conversation-cleanup/',
  'knowledge/skills/', 'knowledge/facts/', 'knowledge/preferences/', 'retention/', 'settings/']
const isLocalLegacyKey = (key: string) => localLegacyPrefixes.some(prefix => key.startsWith(prefix))

/** The Host stops legacy writes before capture/cutover. StoragePort has no atomic
 * snapshot contract; the second read detects changes, it is NOT a substitute for
 * that lifecycle responsibility. No source mutation or source deletion occurs.
 */
export async function captureLocalLegacy(source: Pick<StoragePort, 'list'>): Promise<LegacyCapture> {
  const rows = (await source.list<unknown>('')).filter(row => isLocalLegacyKey(row.key))
  const serialized = rows.map(row => ({ key: row.key, bytes: utf8(JSON.stringify(row.value)) })).sort((a, b) => a.key.localeCompare(b.key))
  const revisionOf = (items: typeof serialized) => hash(JSON.stringify(items.map(item => [item.key, hash(item.bytes)])))
  const revision = revisionOf(serialized)
  const map = new Map(rows.map(row => [row.key, structuredClone(row.value)]))
  // Recover a previously prepared legacy record transaction only in this private
  // in-memory capture. Never restart its runtime or write to the old store.
  const captured: StoragePort = {
    get: async key => structuredClone(map.get(key)) as never,
    set: async (key, value) => { map.set(key, structuredClone(value)) },
    list: async prefix => [...map].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })) as never,
  }
  const journal = new RecordJournal(captured), records = new TaskRecords(journal)
  // Read-only equivalent of baseline TaskArchiveStore.task/text. Do not import
  // its retired mechanical seal/cleanup/delete implementation into the new Host.
  const archivedTask = async (id: string): Promise<Task | undefined> => {
    const index = await captured.get<{ deleting?: boolean; deliveryReadAt?: string }>('task-history/' + encodeURIComponent(id))
    if (index?.deleting) return undefined
    const manifest = await captured.get<unknown>('records/' + encodeURIComponent(id) + '/manifest')
    if (!manifest) return undefined
    const task = await decodeLegacySealedTask(manifest, id, key => captured.get(key)) as unknown as Task
    if (task.delivery && index?.deliveryReadAt) task.delivery.readAt = index.deliveryReadAt
    return task
  }
  for (const [key, value] of [...map]) if (key.startsWith('task-staging/') && key.endsWith('/commit')) {
    const prepared = value as PreparedTask, root = map.get('task:' + prepared.root?.id) as { revision: number } | undefined
    if (prepared.schemaVersion !== 1 || !prepared.root?.id) throw new Error('Invalid legacy pending task record: ' + key)
    if ((root?.revision ?? 0) < prepared.root.revision) {
      if ((root?.revision ?? 0) !== prepared.expectedRevision) throw new Error('Legacy task staging revision differs: ' + key)
      await records.write(prepared); map.set('task:' + prepared.root.id, prepared.root)
    }
  }
  const texts: LegacyCapture['texts'] = []
  for (const value of map.values()) if ((value as RecordEntry)?.kind === 'servant-record-entry') {
    const entry = value as RecordEntry
    texts.push({ ref: entry.ref, text: await journal.fullText(entry.ref) })
  }
  // Preserve the already sealed document's original segment order. Ordinary
  // RecordJournal entries are not the complete Task records document.
  for (const [key, value] of map) if (/^records\/[^/]+\/manifest$/.test(key)) {
    const id = decodeURIComponent(key.split('/')[1]!)
    if (key !== 'records/' + encodeURIComponent(id) + '/manifest') throw new Error('Invalid legacy records identity: ' + key)
    if ((map.get('task-history/' + encodeURIComponent(id)) as { deleting?: boolean } | undefined)?.deleting) continue
    texts.push({ ref: legacyLocalRecordsReference(id), text: await decodeLegacySealedRecords(value, id, async part => map.get(part)) })
  }
  const tasks: LegacyTask[] = [], issues: string[] = []
  for (const [key, value] of map) if (key.startsWith('task:')) {
    const task = (value as { kind?: string })?.kind === 'task-tombstone'
      ? await archivedTask(key.slice(5)) : isSeparatedTask(value) ? await records.hydrate(value) : value as Task
    if (!task || task.schemaVersion !== 1 || !task.goal || !task.children || !task.executions || !task.reports || !task.waits) {
      issues.push('Task cannot yet be reconstructed: ' + key); continue
    }
    const continuation = localContinuation(task)
    if (continuation === 'unresolved') issues.push('Waiting dependency needs an existing continuation adapter: ' + task.id)
    tasks.push({ id: task.id, original: task, continuation, request: task.goal.request,
      waits: Object.values(task.waits).filter(wait => wait.state === 'waiting').map(wait => ({ id: wait.id, memberIdentity: task.assistantId,
        question: wait.question ?? (['user', 'configuration', 'resource'].includes(wait.kind) ? wait.reason : undefined), original: wait })),
      participants: [{ identity: task.assistantId,
        nativeExecutions: Object.values(task.executions).map(execution => ({ executionId: execution.executionId, sessionId: execution.sessionId, agentId: execution.agentId, role: execution.role,
          generation: execution.generation, actionId: execution.actionId, ownedJobIds: [...execution.ownedJobIds], originalState: execution.state, physicalState: execution.physicalState,
          recordedSettled: execution.physicalState === 'stopped' && execution.ownedJobIds.length === 0, original: execution })), original: { assistantId: task.assistantId, workspace: task.workspace, waits: task.waits }, plan: task.plan,
        children: Object.values(task.children).map(child => ({ id: child.id, contract: child,
          reports: Object.values(task.reports).filter(report => report.childId === child.id),
          executions: Object.values(task.executions).filter(execution => execution.childId === child.id) })) }] })
  }
  // Baseline finishCleanup removes task:<id> but deliberately retains its
  // sealed history. A current root always wins; historical discovery never
  // recreates execution/wake ownership for an already ended Task.
  for (const [key, value] of map) if (key.startsWith('task-history/')) {
    const index = value as { schemaVersion?: number; taskId?: string; deleting?: boolean }
    if (index.deleting) continue
    const id = decodeURIComponent(key.slice('task-history/'.length))
    if (index.schemaVersion !== 1 || index.taskId !== id || key !== 'task-history/' + encodeURIComponent(id)) throw new Error('Invalid legacy task history: ' + key)
    if (map.has('task:' + id)) continue
    const task = await archivedTask(id)
    if (!task || task.id !== id || task.schemaVersion !== 1 || !task.goal || !task.reports) throw new Error('Legacy archived Task is missing or corrupt: ' + id)
    const continuation = localContinuation(task)
    if (continuation !== 'complete' && continuation !== 'cancelled') {
      issues.push('Historical Task has no terminal continuation: ' + id); continue
    }
    tasks.push({ id, original: task, continuation, request: task.goal.request, participants: [] })
  }
  const after = (await source.list<unknown>('')).filter(row => isLocalLegacyKey(row.key)).map(row => ({ key: row.key, bytes: utf8(JSON.stringify(row.value)) })).sort((a, b) => a.key.localeCompare(b.key))
  if (revisionOf(after) !== revision) throw new Error('Legacy Local source changed during capture; no migration was prepared.')
  return { mode: 'local', baseline: LEGACY_BASELINE, revision, records: serialized, texts, tasks, issues }
}

/** An explicit one-time scan of the fixed legacy commit, never a Host watcher. */
export async function captureGitLegacy(files: FilesStore, snapshot: FilesSnapshot, history: { at?: (revision: string) => Promise<FilesSnapshot> } = {}): Promise<LegacyCapture> {
  const records: LegacyCapture['records'] = []
  const versions = new Map<string, string>()
  const pending = new Set<string>(), requested = new Set<string>(), selected = new Set<string>(), issues: string[] = []
  for (const prefix of legacyRoots) for (const entry of await files.list(snapshot, prefix)) {
    versions.set(entry.path, entry.version)
    if (legacySeed(entry.path)) { pending.add(entry.path); selected.add(entry.path) }
  }
  const pathFields = new Set(['textPath', 'contextPath', 'originPath', 'goalPath', 'sourcePath', 'memoryPath', 'notePath',
    'replyPath', 'resultPath', 'manifestPath', 'recordsPath', 'outcomePath', 'outputPath', 'inputPath', 'chunks', 'prerequisitePaths', 'refs'])
  const references = (value: unknown, field?: string): void => {
    if (typeof value === 'string' && field && pathFields.has(field) && value.startsWith('dss-coop/')) {
      const path = filePath(value.slice('dss-coop/'.length))
      if (!requested.has(path)) pending.add(path)
    } else if (Array.isArray(value)) value.forEach(item => references(item, field))
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) references(item, key)
  }
  while (pending.size) {
    const path = pending.values().next().value!
    pending.delete(path)
    if (requested.has(path)) continue
    requested.add(path)
    const bytes = await files.readBytes(snapshot, path)
    if (bytes === undefined) {
      if (selected.has(path)) throw new Error('Legacy Git snapshot lost a listed record: ' + path)
      // Text references name a record directory. Read only its exact manifest;
      // never turn an unresolved reference into a recursive project-directory scan.
      if (!path.endsWith('.json') && !path.endsWith('.txt') && !path.endsWith('.md')) {
        const manifest = path + '/manifest.json'
        if (!requested.has(manifest)) pending.add(manifest)
      } else issues.push('Legacy reference requires its historical revision: dss-coop/' + path)
      continue
    }
    records.push({ key: path, bytes })
    if (path.endsWith('.json')) references(JSON.parse(decode(bytes)))
  }
  const map = new Map(records.map(record => [record.key, record.bytes]))
  const read = (path: string) => { const bytes = map.get(path.replace(/^dss-coop\//, '')); return bytes === undefined ? undefined : decode(bytes) }
  const json = <T>(path: string): T | undefined => { const value = read(path); return value === undefined ? undefined : JSON.parse(value) as T }
  const texts: LegacyCapture['texts'] = []
  for (const record of records.filter(record => record.key.endsWith('/manifest.json'))) {
    const manifest = json<{ version: number; chunks?: string[]; characters: number; sha256: string }>(record.key)!
    if (!Array.isArray(manifest.chunks)) continue
    const root = record.key.slice(0, -'/manifest.json'.length)
    const text = manifest.chunks.map(chunk => {
      const path = chunk.replace(/^dss-coop\//, '')
      if (!path.startsWith(root + '/parts/')) throw new Error('Legacy text chunk escapes its record: ' + chunk)
      filePath(path)
      const part = read(path)
      if (part === undefined) throw new Error('Legacy text part is missing: ' + chunk)
      return part
    }).join('')
    if (manifest.version !== 1 || hash(text) !== manifest.sha256 || text.length !== manifest.characters) throw new Error('Legacy text integrity mismatch: ' + root)
    texts.push({ ref: 'dss-coop/' + root, text })
  }
  // Fixed-baseline read-only publication/trigger rules. Do not import the old
  // RoleWriter/consumer (and thereby resurrect its executable scheduling path).
  const same = (a: any, b: any) => !!a && !!b && ['participantId', 'instanceId', 'taskId', 'role', 'actionId', 'executionId', 'sessionId',
    'generation', 'epoch', 'fence', 'assignmentVersion', 'childId', 'childRevision', 'sourceIntentId', 'outputPath'].every(key => a[key] === b[key])
  const actionKey = (b: any) => (b.taskId ? 'tasks/' + b.taskId : 'foreground') + '/actions/' + b.participantId + '/' + b.instanceId + '/' + b.actionId + '.json'
  const outputKey = (b: any) => 'dss-coop/' + (b.taskId ? 'tasks/' + b.taskId : 'foreground') + '/executions/' + b.participantId + '/' + b.executionId + '/outcome.json'
  const status = (b: any, kind: string): any => {
    const value = json<any>('status/' + (b.taskId ? 'tasks/' + b.taskId : 'foreground') + '/' + b.participantId + '/' + b.instanceId + '/' + b.executionId + '/' + kind + '.json')
    return value?.version === 1 && value.kind === kind && same(value.binding, b) ? value : undefined
  }
  const disposition = (role: string, signal: string): string | undefined => role === 'foreground'
    ? ['respond', 'handoff_planner'].includes(signal) ? signal : undefined
    : role === 'worker' ? signal === 'continue' ? 'continue' : ['complete', 'blocked', 'error'].includes(signal) ? 'result' : undefined
    : ['done', 'rework'].includes(signal) ? 'plan_ready' : signal === 'complete' ? 'complete' : signal === 'handoff' ? 'continue'
    : ['wait', 'need_user', 'error'].includes(signal) ? 'wait' : undefined
  const outcomeAt = (path: string): any => {
    const value = json<any>(path), b = value?.binding
    if (!b || b.outputPath !== 'dss-coop/' + path.replace(/^dss-coop\//, '') || b.outputPath !== outputKey(b)) return undefined
    const action = json<any>(actionKey(b))
    if (!same(action?.binding, b)) return undefined
    const completed = action.stateProtocol === 1 ? status(b, 'completed') : undefined
    if (action.stateProtocol === 1 && (!completed?.turn_signal || completed.outcomePath !== b.outputPath || completed.turn_signal !== value.turn_signal)) return undefined
    const legacy = b.role === 'planner' ? ({ plan_ready: 'done', continue: 'handoff', complete: 'complete', wait: value.question ? 'need_user' : 'wait' } as Record<string, string>)[value.kind]
      : b.role === 'foreground' ? value.kind : value.kind === 'continue' || value.resultStatus === 'handoff' ? 'continue' : value.resultStatus === 'failed' ? 'error' : value.kind === 'result' ? 'complete' : undefined
    const signal = completed?.turn_signal ?? value.turn_signal ?? legacy, kind = disposition(b.role, signal)
    return kind ? { ...value, kind, turn_signal: signal, observedTrigger: value.observedTrigger ?? (b.role === 'planner' ? status(b, 'closed')?.observedTrigger : undefined) } : undefined
  }
  const published = (writer: any, taskId: string): boolean => {
    if (!writer) return true
    const action = json<any>(actionKey(writer)), started = status(writer, 'started'), completed = status(writer, 'completed')
    if (!started && action?.stateProtocol !== 1) return true
    if (completed?.turn_signal && completed.outcomePath === writer.outputPath && disposition(writer.role, completed.turn_signal)) return true
    const current = action?.binding
    if (writer.role === 'foreground' && current?.role === 'foreground' && current.generation > writer.generation
      && current.sourceIntentId === writer.sourceIntentId && actionKey(current) === actionKey(writer)) {
      const result = outcomeAt(current.outputPath)
      return result?.kind === 'handoff_planner' && result.taskId === taskId
    }
    return false
  }
  const trigger = (taskId: string, participantId: string): string => {
    const prefix = 'tasks/' + taskId + '/', selected: Array<[string, string]> = []
    for (const [path, version] of versions) {
      if (!path.startsWith(prefix)) continue
      if (path === prefix + 'contract.json' || path === prefix + 'plan.json' || path.endsWith('/join.json')
        || /\/(proposals|reports)\/[^/]+\.json$/.test(path) || path.startsWith(prefix + 'requests/' + participantId + '/') && path.endsWith('.json')) {
        if (published(json<any>(path)?.writer, taskId)) selected.push(['dss-coop/' + path, version])
      } else if (path.startsWith(prefix + 'executions/' + participantId + '/') && path.endsWith('/outcome.json')) {
        const result = outcomeAt(path)
        if (result?.binding.role === 'worker' && result.kind === 'result') selected.push(['dss-coop/' + path, version])
      }
    }
    return hash(encodeJson(selected.sort(([a], [b]) => a.localeCompare(b))))
  }
  const tasks: LegacyTask[] = []
  for (const record of records.filter(record => /^tasks\/[^/]+\/contract.json$/.test(record.key))) {
    const task = json<RootTask>(record.key)!, root = record.key.slice(0, -'/contract.json'.length)
    const joins = records.filter(record => record.key.startsWith(root + '/participants/') && record.key.endsWith('/join.json')).map(record => json<Join>(record.key)!)
    const actions = records.filter(record => record.key.startsWith(root + '/actions/') && record.key.endsWith('.json')).map(record => json<any>(record.key))
    const outcomes = records.filter(record => record.key.startsWith(root + '/executions/') && record.key.endsWith('/outcome.json')).map(record => json<any>(record.key))
    const currentWaits = joins.flatMap(join => {
      const observed = trigger(task.id, join.participantId)
      const outcome = outcomes.map(value => value?.binding?.outputPath && outcomeAt(value.binding.outputPath)).filter(value => value?.binding?.role === 'planner'
        && value.binding.participantId === join.participantId && value.binding.instanceId === join.instanceId && value.kind === 'wait' && value.observedTrigger === observed).at(-1)
      return outcome ? [{ join, outcome }] : []
    })
    let continuation: Continuation = task.status === 'accepted' ? 'complete' : task.status === 'cancelled' ? 'cancelled'
      : joins.length && joins.every(join => join.state === 'paused' || join.state === 'left') ? 'paused'
      : currentWaits.length === joins.length && currentWaits.some(wait => wait.outcome.question) ? 'wait-user'
      : currentWaits.length ? 'wait-result' : task.status === 'waiting' ? 'unresolved' : 'running'
    if (continuation === 'unresolved') issues.push('Current waiting outcome cannot be established: ' + task.id)
    const request = texts.find(text => text.ref === task.originPath)?.text
    if (request === undefined) { issues.push('Task original request is unresolved: ' + task.id); continuation = 'unresolved' }
    tasks.push({ id: task.id, original: task, continuation, request: request ?? '',
      waits: currentWaits.filter(wait => wait.outcome.question).map(({ join, outcome }) => ({ id: outcome.binding.executionId, memberIdentity: join.participantId + '/' + join.instanceId, question: outcome.question, original: outcome })),
      participants: joins.map(join => {
      const base = root + '/participants/' + join.participantId + '/instances/' + join.instanceId
      const plan = json<ParticipantPlan>(base + '/plan.json')
      const bindings = new Map<string, any>()
      for (const record of records.filter(record => record.key.startsWith(root + '/executions/') && record.key.endsWith('/binding.json'))) {
        const binding = json<any>(record.key)
        if (binding) bindings.set(binding.executionId + ':' + binding.generation, binding)
      }
      for (const value of [...actions, ...outcomes]) if (value?.binding) bindings.set(value.binding.executionId + ':' + value.binding.generation, value.binding)
      const nativeExecutions: LegacyNativeExecution[] = [...bindings.values()].filter(binding => binding.participantId === join.participantId && binding.instanceId === join.instanceId).map(binding => {
        const physical = json<any>(outputKey(binding).replace(/outcome.json$/, 'physical-result.json'))
        const action = actions.find(action => same(action?.binding, binding))
        return { executionId: binding.executionId, sessionId: binding.sessionId, role: binding.role, generation: binding.generation, actionId: binding.actionId,
          ownedJobIds: (physical?.jobs ?? []).map((job: any) => job.id), originalState: action?.state, recordedSettled: physical?.settled === true,
          original: { binding, physical, action, closed: status(binding, 'closed'), completed: status(binding, 'completed') } }
      })
      return { identity: join.participantId + '/' + join.instanceId, nativeExecutions,
        continuation: join.state === 'paused' ? 'paused' : join.state === 'left' ? 'cancelled'
          : currentWaits.find(wait => wait.join === join)?.outcome.question ? 'wait-user' : ['complete', 'cancelled', 'unresolved'].includes(continuation) ? continuation : 'running', original: join, plan,
        children: (plan?.children ?? []).map(child => ({ id: child.id, contract: child,
          reports: outcomes.filter(outcome => outcome?.binding?.participantId === join.participantId && outcome?.binding?.instanceId === join.instanceId && outcome?.binding?.childId === child.id),
          executions: records.filter(record => record.key.startsWith(root + '/actions/') && record.key.endsWith('.json'))
            .map(record => json<any>(record.key)).filter(action => action?.binding?.participantId === join.participantId && action?.binding?.instanceId === join.instanceId && action?.binding?.childId === child.id) })) }
    }) })
  }
  for (const record of records.filter(record => /^history\/[^/]+\.json$/.test(record.key))) {
    const entry = json<any>(record.key)
    if (!entry?.id || tasks.some(task => task.id === entry.id)) continue
    const archive = entry.manifestPath && json<any>(entry.manifestPath)
    const assembled = texts.find(text => text.ref === entry.recordsPath)?.text
    if (!archive || !Array.isArray(archive.sources) || !entry.sourceHead || archive.sourceHead !== entry.sourceHead
      || assembled === undefined || hash(assembled) !== archive.recordsSha256) {
      issues.push('Legacy completed archive is unresolved: ' + record.key); continue
    }
    const restored = new Map<string, Uint8Array>()
    if (!history.at) issues.push('Historical source commit reader is unavailable: ' + entry.sourceHead + ':' + entry.id)
    else {
      const historical = await history.at(entry.sourceHead)
      try {
        for (const source of archive.sources as Array<{ path: string; sha256: string }>) {
          const path = filePath(source.path.replace(/^dss-coop\//, ''))
          // The old archive manifests only own this Task and its lifecycle facts,
          // not arbitrary project files named by a damaged manifest.
          if (!path.startsWith('tasks/' + entry.id + '/') && !path.startsWith('status/tasks/' + entry.id + '/')) throw new Error('Archive source escapes its Task: ' + path)
          const bytes = await files.readBytes(historical, path)
          if (bytes === undefined || hash(bytes) !== source.sha256) throw new Error('Historical archive source integrity mismatch: ' + source.path)
          restored.set(path, bytes)
          records.push({ key: 'historical/' + entry.sourceHead + '/' + path, bytes,
            reference: 'dss-coop/' + path + '?revision=' + entry.sourceHead })
          // Preserve legacy unqualified references only if no live record now
          // occupies that identity. Explicit revision references always survive.
          if (!map.has(path)) { records.push({ key: path, bytes }); map.set(path, bytes) }
        }
      } finally { await historical.release() }
    }
    for (const [path, bytes] of restored) if (path.endsWith('/manifest.json')) {
      const manifest = JSON.parse(decode(bytes))
      if (!Array.isArray(manifest.chunks)) continue
      const root = path.slice(0, -'/manifest.json'.length)
      const text = manifest.chunks.map((reference: string) => {
        const chunk = reference.replace(/^dss-coop\//, '')
        if (!chunk.startsWith(root + '/parts/')) throw new Error('Historical text chunk escapes its record.')
        const value = restored.get(chunk)
        if (!value) throw new Error('Historical text part is missing: ' + reference)
        return decode(value)
      }).join('')
      if (manifest.version !== 1 || hash(text) !== manifest.sha256 || text.length !== manifest.characters) throw new Error('Historical text integrity mismatch: ' + root)
      texts.push({ ref: 'dss-coop/' + root + '?revision=' + entry.sourceHead, text })
      if (!texts.some(item => item.ref === 'dss-coop/' + root)) texts.push({ ref: 'dss-coop/' + root, text })
    }
    const contractBytes = restored.get('tasks/' + entry.id + '/contract.json')
    const contract = contractBytes ? JSON.parse(decode(contractBytes)) as RootTask : undefined
    tasks.push({ id: entry.id, original: { history: entry, manifest: archive, contract },
      continuation: entry.status === 'accepted' ? 'complete' : entry.status === 'cancelled' ? 'cancelled' : 'unresolved',
      request: contract ? texts.find(text => text.ref === contract.originPath)?.text ?? assembled : assembled, participants: [] })
  }
  return { mode: 'git', baseline: LEGACY_BASELINE, revision: snapshot.revision, records, texts, tasks, issues }
}

/** Identity/reference maps and exact source copies are committed alongside the new
 * live paths. Paused/cancelled/user-waiting work is retained without a wake signal.
 * Its existing user control/input action can consume the continuation metadata.
 */
export async function prepareLegacyMigration(source: LegacyCapture, files: FilesStore, snapshot: FilesSnapshot,
  options: MigrationOptions, transactions?: FrameworkTransactions): Promise<LegacyMigrationPlan> {
  const root = 'technical/legacy-migrations/' + identity(options.id), changes = new Map<string, FileChange>()
  const add = (change: FileChange) => changes.set(change.path, change)
  const ambiguousArtifactReferences = new Set<string>(), legacySkillBodyPaths = new Set<string>()
  const manifest: MigrationManifest = { version: 1, id: options.id, baseline: source.baseline, source: { mode: source.mode, revision: source.revision }, owner: options.owner, members: { ...options.members },
    records: [], references: {}, referenceHashes: {}, tasks: [], issues: [...source.issues], pendingAdapters: [], messages: [] }
  const declared = new Map<string, ReturnType<typeof legacyDeclaredArtifacts>>()
  if (source.mode === 'local') for (const task of source.tasks) {
    try { declared.set(task.id, legacyDeclaredArtifacts(task.original as Task)) }
    catch (error) { manifest.issues.push(error instanceof Error ? error.message : String(error)); manifest.pendingAdapters.push('artifact-declarations:' + task.id) }
  }
  if (source.records.some(record => /^(conversations?\/|conversation-index\/|conversation:)/.test(record.key))) manifest.pendingAdapters.push('conversation-index')
  if (source.records.some(record => /^(assistants?\/|assistant:|work-planning\/)/.test(record.key))) manifest.pendingAdapters.push('assistant-and-foreground-memory')
  if (source.records.some(record => /^(skills?\/|knowledge\/|settings\/|setting:)/.test(record.key))) manifest.pendingAdapters.push('knowledge-and-settings')
  // Source snapshots and identity maps preserve native execution facts. A caller
  // must establish new native ownership, never resurrect the legacy Agent/Job.
  for (const record of source.records) {
    const path = root + '/source/' + hash(record.key) + '.bin'
    add({ path, bytes: record.bytes.slice() })
    manifest.records.push({ key: record.key, path, sha256: hash(record.bytes) })
    manifest.references[record.key] = path
    manifest.referenceHashes[record.key] = hash(record.bytes)
    if (record.reference) { manifest.references[record.reference] = path; manifest.referenceHashes[record.reference] = hash(record.bytes) }
    if (source.mode === 'git') {
      manifest.references['dss-coop/' + record.key] = path
      manifest.referenceHashes['dss-coop/' + record.key] = hash(record.bytes)
    }
  }
  for (const entry of source.texts) {
    const path = root + '/text/' + hash(entry.ref) + '.md'
    add({ path, content: entry.text }); manifest.references[entry.ref] = path; manifest.referenceHashes[entry.ref] = hash(entry.text)
  }
  if (source.mode === 'local') {
    const entries: Array<{ sourceKey: string; path: string; kind: string; scope: { assistantId: string; workspaceId: string }; revision: number; activeBodyPath?: string }> = []
    for (const record of source.records.filter(record => /^knowledge\/(skills|facts|preferences)\//.test(record.key))) {
      const value = JSON.parse(decode(record.bytes)) as SkillRecord | ProjectFact | Preference
      if (value.schemaVersion !== 1 || !value.scope?.assistantId || !value.scope.workspaceId || !['skill', 'project-fact', 'preference'].includes(value.kind)) {
        manifest.issues.push('Legacy knowledge schema is unresolved: ' + record.key); continue
      }
      const scopePath = encodeURIComponent(value.scope.assistantId) + '/' + encodeURIComponent(value.scope.workspaceId)
      const path = value.kind === 'skill' ? 'skills/' + scopePath + '/' + encodeURIComponent(value.skillId) + '/record.json' : record.key + '.json'
      add({ path, bytes: record.bytes.slice() })
      let activeBodyPath: string | undefined
      if (value.kind === 'skill') {
        // Match the old catalog/getSkillBody predicate exactly; do not promote
        // a candidate or invent a new validation/activation prerequisite.
        const active = value.versions.find(version => version.version === value.activeVersion && version.status === 'active' && !version.bodyRetiredAt)
        if (active) {
          activeBodyPath = path.replace(/record.json$/, 'SKILL.md')
          legacySkillBodyPaths.add(activeBodyPath)
          add({ path: activeBodyPath, content: `# ${active.title}\n\n${active.description}\n\n## 适用范围\n\n${active.applicability}\n\n${active.body}\n` })
        }
      }
      entries.push({ sourceKey: record.key, path, kind: value.kind, scope: value.scope, revision: value.revision, ...(activeBodyPath ? { activeBodyPath } : {}) })
    }
    if (entries.length) {
      // This is provenance/discovery metadata, not native skill registration.
      const indexPath = 'knowledge/legacy-index.json', prior = await files.read(snapshot, indexPath)
      const index = prior ? JSON.parse(prior) as { version: 1; entries: typeof entries } : { version: 1 as const, entries: [] }
      for (const entry of entries) {
        const existing = index.entries.find(item => item.sourceKey === entry.sourceKey)
        if (existing && JSON.stringify(existing) !== JSON.stringify(entry)) throw new Error('Legacy knowledge scope already has different migration metadata.')
        if (!existing) index.entries.push(entry)
      }
      add({ path: indexPath, content: encodeJson(index) })
      manifest.pendingAdapters.push('native-knowledge-provider-registration')
    }
  }
  if (source.mode === 'git') {
    for (const record of source.records.filter(record => /^knowledge\/[^/]+\/(skill|knowledge|preference)\/[^/]+\/source.json$/.test(record.key))) {
      const [, participantId, kind, entryId] = record.key.split('/')
      const sourcePath = 'dss-coop/' + record.key.slice(0, -'/source.json'.length), text = source.texts.find(item => item.ref === sourcePath)?.text
      if (text === undefined) { manifest.issues.push('Legacy Git knowledge body is unresolved: ' + sourcePath); continue }
      const metadata = JSON.parse(decode(record.bytes))
      if (kind === 'skill') {
        // These are the exact fixed-baseline Git provider's identity/description
        // rules, NOT a fabricated Local SkillRecord or a global Markdown skill.
        const path = 'skills/legacy-git/' + participantId + '/' + entryId + '/legacy-git.json'
        add({ path, content: encodeJson({ version: 1, kind: 'legacy-git-skill', participantId,
          name: 'coop-' + hash(sourcePath).slice(0, 16), description: text.split('\n').find(line => line.trim())?.slice(0, 180) || 'Coop skill',
          body: text, source: { path: sourcePath, metadata } }) })
      } else add({ path: 'knowledge/legacy-git/' + participantId + '/' + kind + '/' + entryId + '.json',
        content: encodeJson({ version: 1, kind, participantId, text, source: { path: sourcePath, metadata } }) })
    }
  }
  // Read-through overlay lets the normal task initializer see the not-yet-committed
  // source text. It does not invent a second task template or invoke old agents.
  const overlay: FilesStore = { ...files, snapshot: () => files.snapshot(), list: (s, p) => files.list(s, p),
    listDirectory: (s, p) => files.listDirectory(s, p), commit: (s, c, m) => files.commit(s, c, m),
    read: async (s, path) => { const change = changes.get(path); return change ? change.content ?? (change.bytes ? decode(change.bytes) : undefined) : files.read(s, path) },
    readBytes: async (s, path) => { const change = changes.get(path); return change ? change.bytes ?? (typeof change.content === 'string' ? utf8(change.content) : undefined) : files.readBytes(s, path) } }
  if (options.conversations?.length) {
    if (!transactions) throw new Error('Conversation migration requires the current transaction coordinator for its read-only index planner.')
    const imported = new Set<string>(), local = (key: string) => {
      const record = source.records.find(record => record.key === key)
      return record ? JSON.parse(decode(record.bytes)) : undefined
    }
    const texts = new Map(source.texts.map(text => [text.ref, text.text]))
    const textFiles = (path: string, text: string): void => {
      const chunks: string[] = []
      for (let start = 0; start < text.length;) {
        let end = Math.min(start + 65_536, text.length)
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--
        const chunk = path + '/parts/' + chunks.length.toString().padStart(6, '0') + '.txt'
        chunks.push(chunk); add({ path: chunk, content: text.slice(start, end) }); start = end
      }
      add({ path: path + '/manifest.json', content: encodeJson({ version: 1, characters: text.length, sha256: hash(text), chunks }) })
    }
    for (const selection of options.conversations) {
      const conversation = new FrameworkConversation(overlay, transactions, selection.scope)
      const entries: Array<{ key: string; id: string; participantId: string; role: string; at: string; ref: string; text: string; original: any }> = []
      if (source.mode === 'local') {
        if (!selection.assistantId || !selection.participantId) throw new Error('Map the actual legacy assistant and local participant before importing its conversation.')
        for (const record of source.records.filter(record => record.key.startsWith('conversation-index/' + encodeURIComponent(selection.assistantId!) + '/'))) {
          const value = local(record.key), text = texts.get(value.ref)
          if (text === undefined) throw new Error('Legacy conversation body is unresolved: ' + value.ref)
          entries.push({ key: record.key, id: value.id, participantId: selection.participantId, role: value.role, at: value.at, ref: value.ref, text, original: value })
        }
        entries.sort((a, b) => a.at.localeCompare(b.at) || a.original.order - b.original.order || a.ref.localeCompare(b.ref))
      } else for (const selected of selection.entryPaths ?? []) {
        const key = selected.replace(/^dss-coop\//, ''), value = local(key)
        if (!value || !['user', 'assistant', 'system'].includes(value.role)) throw new Error('Selected legacy conversation entry is missing or invalid: ' + selected)
        const text = texts.get(value.textPath), participantId = value.participantId ?? value.writer?.participantId
        if (text === undefined || !participantId) throw new Error('Legacy message body or participant is unresolved: ' + selected)
        entries.push({ key, id: value.id, participantId, role: value.role, at: value.createdAt, ref: selected, text, original: value })
      }
      const ids = new Map(entries.map(entry => [entry.ref, entries.filter(other => other.id === entry.id).length === 1 ? entry.id : 'legacy-' + hash(entry.ref)]))
      const replies = new Map<string, string>()
      if (selection.assistantId) for (const record of source.records.filter(record => record.key.startsWith('conversation-exchanges/' + encodeURIComponent(selection.assistantId!) + '/'))) {
        const exchange = local(record.key)
        let user: string | undefined
        for (const ref of exchange.refs as string[]) {
          const message = entries.find(entry => entry.ref === ref)
          if (message?.role === 'user') user = ids.get(ref)
          else if (message?.role === 'assistant' && user) replies.set(ref, user)
        }
      }
      const entryPaths: string[] = []
      for (const entry of entries) {
        const id = ids.get(entry.ref)!, date = new Date(entry.at)
        if (!Number.isFinite(date.getTime())) throw new Error('Legacy message timestamp is invalid: ' + entry.ref)
        const path = 'conversations/' + (selection.scope.mode === 'local' ? 'local/' : '') + encodeURIComponent(entry.participantId)
          + '/' + date.toISOString().slice(0, 10) + '/legacy-' + hash(entry.ref) + '/entry.json'
        const textPath = path.replace(/entry.json$/, 'text')
        textFiles(textPath, entry.text)
        const explicitSource = entry.original.replyTo ?? entry.original.writer?.sourceIntentId
        const explicitReply = explicitSource && entries.find(other => other.id === explicitSource && other.role === 'user')
        const replyTo = replies.get(entry.ref) ?? (explicitReply ? ids.get(explicitReply.ref) : undefined)
        add({ path, content: encodeJson({ id, role: entry.role, participantId: entry.participantId, createdAt: entry.at,
          collaborationId: selection.scope.collaborationId, textPath, textHash: hash(entry.text), source: entry.original.source,
          ...(replyTo ? { replyTo } : {}), ...(entry.original.recipient ? { recipient: entry.original.recipient } : {}),
          ...(entry.original.mentions ? { mentions: entry.original.mentions } : {}),
          legacy: { id: entry.id, reference: entry.ref, sessionId: entry.original.sessionId, date: entry.original.date, timeZone: entry.original.timeZone } }) })
        entryPaths.push(path); imported.add(entry.key)
        manifest.messages.push({ reference: entry.ref, id, path, collaborationId: selection.scope.collaborationId })
      }
      for (const change of await conversation.planLegacyIndex(snapshot, entryPaths)) add(change)
      for (const name of ['Foreground_List', 'Foreground_Cache'] as const) {
        const oldKey = source.mode === 'local' ? 'foreground-memory/' + encodeURIComponent(selection.assistantId!) + '/' + name
          : selection.foregroundIdentity ? 'assistants/' + selection.foregroundIdentity.participantId + '/' + selection.foregroundIdentity.instanceId + '/' + name + '.md' : undefined
        const sourceRecord = oldKey && source.records.find(record => record.key === oldKey)
        if (sourceRecord) {
          const text = source.mode === 'local' ? JSON.parse(decode(sourceRecord.bytes)).text : decode(sourceRecord.bytes)
          add({ path: conversation.foregroundRoot + '/' + name + '.md', content: text })
        }
      }
    }
    const allEntries = source.records.filter(record => source.mode === 'local' ? record.key.startsWith('conversation-index/') : /^conversations\/.+\/entry.json$/.test(record.key))
    if (allEntries.every(entry => imported.has(entry.key))) manifest.pendingAdapters = manifest.pendingAdapters.filter(item => item !== 'conversation-index')
  }
  for (const capturedTask of source.tasks) {
    const task = structuredClone(capturedTask)
    for (const participant of task.participants) {
      const pending = (participant.nativeExecutions ?? []).some(execution => !options.nativeOwnershipReconciled?.[participant.identity]?.some(result =>
        result.executionId === execution.executionId && result.generation === execution.generation && result.settled))
      if (pending) {
        manifest.pendingAdapters.push('native-ownership:' + task.id + ':' + participant.identity)
        if (['running', 'wait-result'].includes(participant.continuation ?? task.continuation)) participant.continuation = 'unresolved'
      }
    }
    if (['running', 'wait-result'].includes(task.continuation) && task.participants.length && task.participants.every(participant => participant.continuation === 'unresolved')) task.continuation = 'unresolved'
    const id = legacyMigratedTaskId(options.id, task.id), recordPath = paths.archive(id) + '/legacy/task.json'
    add({ path: recordPath, content: encodeJson(task.original) })
    if (source.mode === 'local') for (const artifact of declared.get(task.id) ?? []) {
      const captured = options.artifacts?.find(item => item.taskId === task.id && item.sourcePath === artifact.path && (item.artifactId === artifact.id
        || item.artifactId === undefined && (declared.get(task.id) ?? []).filter(ref => ref.path === artifact.path).length === 1))
        ?? options.artifacts?.find(item => item.taskId === undefined && item.sourcePath === artifact.path
          && [...declared.values()].flat().filter(ref => ref.path === artifact.path).length === 1)
      if (!captured) { manifest.pendingAdapters.push('artifact-bytes:' + task.id + ':' + artifact.id); continue }
      const bytes = captured.bytes.slice(), digest = hash(bytes)
      if (artifact.sha256 && artifact.sha256 !== digest) throw new Error('Legacy artifact bytes differ from the recorded hash: ' + artifact.id)
      const name = artifact.path.split(/[\\/]/).at(-1) || artifact.id
      const path = paths.archive(id) + '/legacy/artifacts/' + hash(artifact.path) + '/' + encodeURIComponent(name)
      const manifestPath = 'technical/artifacts/manifests/' + hash(path) + '.json'
      add({ path, bytes })
      add({ path: manifestPath, content: encodeJson({ version: 1, taskId: id, path, manifestPath, name, sha256: digest, bytes: bytes.byteLength }) })
      for (const reference of [artifact.path, artifact.id]) {
        const qualified = 'legacy-task/' + task.id + '/' + reference
        manifest.references[qualified] = path; manifest.referenceHashes[qualified] = digest
        if (ambiguousArtifactReferences.has(reference)) continue
        if (manifest.references[reference] && manifest.referenceHashes[reference] !== digest) {
          delete manifest.references[reference]; delete manifest.referenceHashes[reference]
          ambiguousArtifactReferences.add(reference)
          manifest.issues.push('Legacy artifact reference is task-scoped and ambiguous without its Task: ' + reference)
        } else { manifest.references[reference] = path; manifest.referenceHashes[reference] = digest }
      }
    }
    const members = task.participants.map(participant => options.members[participant.identity])
    let continuation = task.continuation
    if (members.some(member => !member)) {
      manifest.issues.push('Registered member mapping is unresolved: ' + task.id); continuation = 'unresolved'
    }
    const mapped = [...new Set(members.filter((member): member is string => !!member))]
    const continuationPath = paths.archive(id) + '/legacy/continuation.json'
    add({ path: continuationPath, content: encodeJson(task) })
    manifest.tasks.push({ oldId: task.id, taskId: id, continuation, members: mapped, recordPath, continuationPath,
      memberContinuations: task.participants.filter(participant => options.members[participant.identity]).map(participant => ({
        member: options.members[participant.identity]!, identity: participant.identity,
        continuation: ['complete', 'cancelled'].includes(continuation) ? continuation : participant.continuation ?? continuation,
        waits: (task.waits ?? []).filter(wait => wait.memberIdentity === participant.identity && typeof wait.question === 'string').map(wait => ({ id: wait.id, question: wait.question! })),
      })) })
    if (continuation !== 'running' && continuation !== 'wait-result') {
      if (continuation !== 'complete') manifest.pendingAdapters.push('original-control-and-input:' + task.id)
      continue
    }
    const route = new Set([options.owner, ...mapped]).size > 1 ? 'O' : 'P', sourcePath = 'tasks/migrated-' + id + '_' + route + '.md'
    add({ path: sourcePath, content: task.request })
    const initialized = await initializeTask(overlay, snapshot, sourcePath, options.owner, mapped, id)
    for (const change of initialized.changes) add(change)
    if (route === 'O') add({ path: paths.run(id) + '/Organizer_Note.md', content: encodeJson({ legacyTask: task.original, participants: task.participants, referenceIndex: root + '/manifest.json' }) })
    for (const participant of task.participants) {
      const member = options.members[participant.identity]!, memberRoot = paths.member(id, member)
      const context = { legacyTaskId: task.id, taskId: id, continuation, originalTask: recordPath, referenceIndex: root + '/manifest.json', participant: participant.original,
        plan: participant.plan, references: manifest.references, children: participant.children }
      const body = encodeJson(context)
      const held = participant.continuation && !['running', 'wait-result'].includes(participant.continuation)
      if (held) {
        add({ path: paths.inbox(id, member), content: '' })
        if (member === options.owner) changes.delete(paths.state(options.owner, id) + '/Organizer_Task')
        manifest.pendingAdapters.push('original-control-and-input:' + task.id + ':' + participant.identity)
      } else add({ path: paths.inbox(id, member), content: body })
      add({ path: memberRoot + '/Planner_Memory.md', content: body })
      add({ path: memberRoot + '/Plan.md', content: encodeJson(participant.plan) })
      add({ path: memberRoot + '/Plan_Note.md', content: source.mode === 'local' ? (task.original as Task).plannerNote?.body ?? '' : '' })
      for (const child of participant.children) {
        const worker = workerPaths(id, member, child.id)
        add({ path: worker.contract, content: encodeJson(child.contract) })
        add({ path: worker.reply, content: encodeJson({ reports: child.reports, references: manifest.references }) })
        add({ path: worker.handoff, content: encodeJson({ legacyExecutions: child.executions, reports: child.reports }) })
        add({ path: worker.notes, content: '' })
      }
    }
  }
  // Publish the final complete cross-task reference map, not an earlier partial
  // map from before a later task's artifacts were processed.
  for (const task of manifest.tasks) add({ path: task.recordPath.replace(/task.json$/, 'references.json'), content: encodeJson(manifest.references) })
  const skillIndex = await prepareFrameworkSkillIndex(files, snapshot, [...changes.values()])
  for (const change of skillIndex.changes) add(change)
  // Legacy SKILL.md deliberately retains its original getSkillBody format.
  // The paired full record.json supplies validated metadata and exact scope;
  // absence of frontmatter in that preserved body is not failed migration.
  manifest.issues.push(...skillIndex.issues.filter(issue => ![...legacySkillBodyPaths].some(path => issue === 'Not a native skill definition: ' + path)))
  const manifestPath = root + '/manifest.json'
  add({ path: manifestPath, content: encodeJson(manifest) })
  const indexPath = 'technical/legacy-migrations/index.json'
  const previousIndex = await files.read(snapshot, indexPath)
  const index = previousIndex ? JSON.parse(previousIndex) as { version: 1; migrations: Array<{ id: string; manifestPath: string; source: MigrationManifest['source'] }> } : { version: 1 as const, migrations: [] }
  const previous = index.migrations.find(item => item.id === options.id)
  if (previous && JSON.stringify(previous.source) !== JSON.stringify(manifest.source)) throw new Error('Migration identity refers to a different legacy source.')
  if (!previous) index.migrations.push({ id: options.id, manifestPath, source: manifest.source })
  add({ path: indexPath, content: encodeJson(index) })
  for (const change of changes.values()) {
    const old = await files.readBytes(snapshot, change.path), bytes = change.bytes ?? utf8(change.content!)
    if (change.path !== indexPath && change.path !== 'knowledge/legacy-index.json' && change.path !== frameworkSkillIndexPath && old !== undefined && hash(old) !== hash(bytes)) throw new Error('Migration destination already contains different data: ' + change.path)
  }
  return { expectedRevision: snapshot.revision, manifestPath, manifest, changes: [...changes.values()] }
}

export async function applyLegacyMigration(files: FilesStore, transactions: FrameworkTransactions, plan: LegacyMigrationPlan): Promise<{ manifest: MigrationManifest; verified: true; complete: boolean }> {
  const changes = plan.changes.map(change => change.bytes === undefined ? { ...change } : { path: change.path, bytes: change.bytes.slice() })
  const evidence = changes.map(change => ({ path: change.path, sha256: hash(change.bytes ?? utf8(change.content!)) }))
  const receipt = await transactions.run('legacy-migration:' + plan.manifest.id, { manifest: structuredClone(plan.manifest), evidence }, { expectedRevision: plan.expectedRevision }, async () => changes)
  await withSnapshot(files, async snapshot => {
    // Complete same-authority byte verification may be handed off by a resumed
    // Git operation. Different HEAD/scope, old receipts or partial results still
    // follow the original full readback below. The fresh snapshot is mandatory.
    if (files instanceof GitFiles && files.matchesVerifiedWrites(snapshot, receipt, evidence)) return
    for (const expected of evidence) {
      const actual = await files.readBytes(snapshot, expected.path)
      if (actual === undefined || hash(actual) !== expected.sha256) throw new Error('Migration read-back differs; retain the original source and same operation: ' + expected.path)
    }
  })
  // Preserving stopped/user-waiting facts is not evidence their UI/action adapter
  // has been switched. Report those continuation obligations explicitly.
  return { manifest: plan.manifest, verified: true,
    complete: plan.manifest.issues.length === 0 && plan.manifest.pendingAdapters.length === 0
      && plan.manifest.tasks.every(task => ['running', 'wait-result', 'complete'].includes(task.continuation)) }
}

/** Explicit migrated-reference lookup; never falls back to the old execution engine. */
export async function readMigratedReference(files: FilesStore, snapshot: FilesSnapshot, manifest: MigrationManifest, reference: string): Promise<Uint8Array> {
  const path = manifest.references[reference], expected = manifest.referenceHashes[reference]
  if (!path || !expected) throw new Error('Legacy reference has not been migrated: ' + reference)
  const bytes = await files.readBytes(snapshot, path)
  if (bytes === undefined || hash(bytes) !== expected) throw new Error('Migrated reference is missing or corrupt: ' + reference)
  return bytes
}

export interface LegacyControlInput { manifestPath: string; oldTaskId: string; member: string }
export interface LegacyAnswerInput extends LegacyControlInput { waitId: string; answer: string }
/** These are existing explicit user actions, not an automatic migration permit. */
export function resumeLegacyTask(files: FilesStore, transactions: FrameworkTransactions, commandId: string, input: LegacyControlInput) {
  return controlLegacyTask(files, transactions, commandId, input, 'resume')
}
export function answerLegacyTask(files: FilesStore, transactions: FrameworkTransactions, commandId: string, input: LegacyAnswerInput) {
  return controlLegacyTask(files, transactions, commandId, input, 'answer')
}
async function controlLegacyTask(files: FilesStore, transactions: FrameworkTransactions, commandId: string,
  input: LegacyControlInput | LegacyAnswerInput, action: 'resume' | 'answer'): Promise<{ taskId: string; revision: string }> {
  filePath(input.manifestPath)
  const receipt = await transactions.run('legacy-control:' + commandId, { action, input }, {}, async snapshot => {
    const raw = await files.read(snapshot, input.manifestPath)
    if (!raw) throw new Error('Migration manifest is missing.')
    const manifest = JSON.parse(raw) as MigrationManifest
    const mapped = manifest.tasks.find(task => task.oldId === input.oldTaskId)
    if (!mapped) throw new Error('Legacy task is not in this migration.')
    if (mapped.continuation === 'cancelled' || mapped.continuation === 'complete') throw new Error('Ended legacy work cannot be reopened by migration control.')
    const body = await files.read(snapshot, mapped.continuationPath)
    if (!body) throw new Error('Original continuation data is missing.')
    const original = JSON.parse(body) as LegacyTask
    const participant = original.participants.find(participant => manifest.members[participant.identity] === input.member)
    if (!participant) throw new Error('Legacy control belongs to a mapped participating instance.')
    const current = participant.continuation ?? original.continuation
    const summary = mapped.memberContinuations?.find(item => item.member === input.member && item.identity === participant.identity)
    if (action === 'resume' && current !== 'paused') throw new Error('This legacy task is not awaiting resume.')
    if (action === 'answer') {
      const answer = input as LegacyAnswerInput
      if (current !== 'wait-user' || summary?.waits && !summary.waits.some(wait => wait.id === answer.waitId) || !original.waits?.some(wait => wait.id === answer.waitId && wait.memberIdentity === participant.identity && wait.question)) throw new Error('The original user question is not pending for this instance.')
      if (typeof answer.answer !== 'string' || !answer.answer.trim()) throw new Error('Answer the original pending question.')
    }
    const controlPath = input.manifestPath.replace(/manifest.json$/, 'controls/' + hash(input.oldTaskId + '\0' + input.member + (action === 'answer' ? '\0answer\0' + (input as LegacyAnswerInput).waitId : '\0resume')) + '.json')
    if (await files.read(snapshot, controlPath) !== undefined) throw new Error('This migrated continuation has already been resumed.')
    const existing = await files.read(snapshot, paths.task(mapped.taskId))
    if (existing && JSON.parse(existing).status === 'complete') throw new Error('The current task is already complete.')
    const technicalAction = { commandId, action, ...input, taskId: mapped.taskId }
    const updateSummary = (): void => {
      mapped.continuation = 'running'
      if (summary) {
        summary.continuation = 'running'
        if (action === 'answer') summary.waits = summary.waits?.filter(wait => wait.id !== (input as LegacyAnswerInput).waitId)
      }
      if (!summary?.waits?.length) manifest.pendingAdapters = manifest.pendingAdapters.filter(item => item !== 'original-control-and-input:' + original.id && item !== 'original-control-and-input:' + original.id + ':' + participant.identity)
    }
    if (existing) {
      const task = JSON.parse(existing) as TaskMetadata, source = await files.read(snapshot, task.sourcePath)
      if (task.taskId !== mapped.taskId || source === undefined) throw new Error('The current Task source cannot be established.')
      updateSummary()
      const recipient = task.route === 'P' ? 'Planner' : 'Organizer'
      // Same R3 append+notification as dss_supplement_task. Never restore stale
      // Planner/Worker files over work already resumed by an earlier answer.
      return [{ path: task.sourcePath, content: source + '\n\n' + encodeJson({ legacyUserAction: technicalAction, originalTask: mapped.recordPath, referenceIndex: input.manifestPath }) },
        { path: paths.state(task.owner, task.taskId) + '/' + recipient + '_Foreground', content: '' },
        { path: controlPath, content: encodeJson(technicalAction) }, { path: input.manifestPath, content: encodeJson(manifest) }]
    }
    const route = new Set([manifest.owner, ...mapped.members]).size > 1 ? 'O' : 'P'
    const sourcePath = 'tasks/migrated-' + mapped.taskId + '_' + route + '.md'
    const changes: FileChange[] = []
    if (await files.read(snapshot, sourcePath) === undefined) changes.push({ path: sourcePath, content: original.request })
    const overlay = Object.create(files) as FilesStore
    overlay.read = (s, path) => path === sourcePath ? Promise.resolve(original.request) : files.read(s, path)
    changes.push(...(await initializeTask(overlay, snapshot, sourcePath, manifest.owner, mapped.members, mapped.taskId)).changes)
    const context = encodeJson({ originalTask: mapped.recordPath, referenceIndex: input.manifestPath, original: participant,
      waits: original.waits, userAction: { commandId, action, ...input } })
    const memberRoot = paths.member(mapped.taskId, input.member)
    changes.push({ path: paths.inbox(mapped.taskId, input.member), content: context },
      { path: memberRoot + '/Planner_Memory.md', content: context }, { path: memberRoot + '/Plan.md', content: encodeJson(participant.plan) },
      { path: controlPath, content: encodeJson({ commandId, action, ...input, taskId: mapped.taskId }) })
    for (const child of participant.children) {
      const worker = workerPaths(mapped.taskId, input.member, child.id)
      for (const [path, content] of [[worker.contract, encodeJson(child.contract)], [worker.reply, encodeJson(child.reports)],
        [worker.handoff, encodeJson({ reports: child.reports, legacyExecutions: child.executions })], [worker.notes, '']] as const) {
        if (await files.read(snapshot, path) === undefined) changes.push({ path, content })
      }
    }
    updateSummary()
    changes.push({ path: input.manifestPath, content: encodeJson(manifest) })
    // initializer templates can share paths with explicit restored content.
    return [...new Map(changes.map(change => [change.path, change])).values()]
  })
  return withSnapshot(files, async snapshot => {
    const manifest = JSON.parse((await files.read(snapshot, input.manifestPath))!) as MigrationManifest
    const mapped = manifest.tasks.find(task => task.oldId === input.oldTaskId)!
    if (await files.read(snapshot, paths.task(mapped.taskId)) === undefined) throw new Error('Restored task identity read-back is missing.')
    return { taskId: mapped.taskId, revision: receipt.revision }
  })
}
