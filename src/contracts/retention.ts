import type { CommandBase, CommandReceipt, Task } from './task.js'
import type { KnowledgeScope, SkillRecord } from './knowledge.js'

/** Omitted fields are unlimited. Only explicitly configured limits trigger maintenance. */
export interface RetentionPolicy {
  taskDetailDays?: number
  archiveDays?: number
  maxArchives?: number
  /** Soft target for Servant-owned records, excluding native Session logs and artifacts. */
  maxServantBytes?: number
  skillHistoryDays?: number
  maxFullSkillVersions?: number
  maxSkillReceipts?: number
}
export const defaultRetentionPolicy: RetentionPolicy = {}
export const retentionPolicyBounds: Record<keyof RetentionPolicy, readonly [number, number]> = {
  taskDetailDays: [0, Number.MAX_SAFE_INTEGER], archiveDays: [0, Number.MAX_SAFE_INTEGER], maxArchives: [0, Number.MAX_SAFE_INTEGER], maxServantBytes: [0, Number.MAX_SAFE_INTEGER],
  skillHistoryDays: [0, Number.MAX_SAFE_INTEGER], maxFullSkillVersions: [0, Number.MAX_SAFE_INTEGER], maxSkillReceipts: [0, Number.MAX_SAFE_INTEGER],
}
export const retentionPolicyKeys = Object.keys(retentionPolicyBounds) as Array<keyof RetentionPolicy>
export function hasRetentionLimits(policy: RetentionPolicy): boolean {
  return retentionPolicyKeys.some(key => policy[key] !== undefined)
}
/** Shared validation for owner API, local editor and portable policy files. */
export function parseRetentionPolicy(value: unknown): RetentionPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid retention policy.')
  const raw = value as Record<string, unknown>
  for (const key of Object.keys(raw)) if (!Object.hasOwn(retentionPolicyBounds, key)) throw new Error('Unknown retention setting: ' + key)
  const policy: RetentionPolicy = {}
  for (const key of retentionPolicyKeys) {
    if (!Object.hasOwn(raw, key)) continue
    const number = raw[key]
    const [minimum, maximum] = retentionPolicyBounds[key]
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < minimum || number > maximum) throw new Error('Invalid retention setting: ' + key)
    policy[key] = number
  }
  return policy
}
export function serializeRetentionPolicy(policy: RetentionPolicy): string {
  return JSON.stringify({ format: 'deepseek-servant-retention-policy', version: 1, policy: parseRetentionPolicy(policy) }, null, 2) + '\n'
}
export function parseRetentionPolicyFile(text: string): RetentionPolicy {
  const data: unknown = JSON.parse(text.replace(/^\uFEFF/, ''))
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid retention policy file.')
  const file = data as Record<string, unknown>
  if (file.format !== 'deepseek-servant-retention-policy' || file.version !== 1
    || Object.keys(file).some(key => !['format', 'version', 'policy'].includes(key))) throw new Error('Unsupported retention policy file.')
  return parseRetentionPolicy(file.policy)
}
export interface RetentionConfiguration { schemaVersion: 1; revision: number; policy: RetentionPolicy; updatedAt: string }

export interface NativeSessionRetirement {
  sessionId: string
  state: 'pending' | 'archived' | 'absent' | 'blocked'
  /** rc.2 retirement archives the catalog entry; it does not erase its native log. */
  logRetained: boolean
  retainedBytes?: number
  reason?: string
  updatedAt?: string
}
export interface TaskArchive {
  schemaVersion: 1
  archivedAt: string
  purgeId: string
  originalBytes: number
  retainedResultIds: string[]
  sessions: NativeSessionRetirement[]
  memoryState: 'pending' | 'done'
  memoryReason?: string
  unresolvedAtCancellation?: { waits: number; incidents: number }
}
export interface ArchiveTaskCommand extends CommandBase {
  type: 'task.archive'
  expectedRevision: number
  purgeId: string
  /** Additional knowledge references; accepted Child results and Delivery results are always kept. */
  retainedResultIds: string[]
}
export interface PurgeArchiveCommand extends CommandBase {
  type: 'task.purgeArchive'
  expectedRevision: number
  purgeId: string
  session?: NativeSessionRetirement
  memoryState?: 'done'
  memoryReason?: string
}

/** A small permanent replay fence replaces an unreferenced expired archive header. */
export interface TaskTombstone {
  schemaVersion: 1
  kind: 'task-tombstone'
  id: string
  assistantId: string
  workspaceId: string
  revision: number
  retiredAt: string
  nativeLogsRetained?: number
  nativeBytesRetained?: number
  nativeSizeUnknown?: number
}
export interface ArchiveDeleteResult { status: 'deleted' | 'stale' | 'blocked'; reason?: string; reclaimedBytes?: number }
export interface TaskRetentionPort {
  list(): Promise<Task[]>
  get(id: string): Promise<Task | undefined>
  execute(id: string, command: ArchiveTaskCommand | PurgeArchiveCommand): Promise<CommandReceipt>
  deleteArchived(id: string, expectedRevision: number, purgeId: string, pinnedResultIds: string[]): Promise<ArchiveDeleteResult>
}
export interface NativeSessionRetentionPort {
  catalog(sessionIds: string[]): Promise<Array<{ sessionId: string; sizeBytes?: number; liveAgent: boolean; liveSession: boolean; archived: boolean }>>
  retire(sessionId: string): Promise<{ sessionId: string; status: 'absent' | 'archived'; logRetained: boolean; reclaimedBytes: number }>
}

export interface SkillCompactionRequest {
  skillId: string
  scope: KnowledgeScope
  expectedRevision: number
  pruneVersions: number[]
  /** Retain exact version/hash/evidence attribution while removing obsolete full bodies. */
  retireBodies?: number[]
  /** Actual archived Tasks; there can be no late role loads or unprocessed feedback for them. */
  archivedTaskIds: string[]
  maxReceipts?: number
}
export interface SkillCompactionResult { status: 'applied' | 'unchanged' | 'stale'; reclaimedBytes: number }
/** The shared in-process maintenance lease prevents new cross-record evidence pins while archives prune. */
export interface KnowledgeMaintenanceSession {
  listSkills(): Promise<SkillRecord[]>
  compactSkill(input: SkillCompactionRequest): Promise<SkillCompactionResult>
}
export interface KnowledgeRetentionPort {
  withRetentionLock<T>(work: (session: KnowledgeMaintenanceSession) => Promise<T>): Promise<T>
}

export type RetentionBlockReason = 'active' | 'paused' | 'physical-owner' | 'live-jobs' | 'uncertain-effects' | 'pending-actions' | 'wait' | 'recovery' | 'delivery' | 'knowledge-evidence' | 'native-retirement' | 'memory-cleanup'
export interface RetentionBlockedItem { id: string; kind: 'task' | 'skill' | 'native'; bytes: number; reasons: string[] }
export interface RetentionTaskCandidate { taskId: string; expectedRevision: number; retainResultIds: string[]; estimatedReclaimedBytes: number }
export interface RetentionArchiveCandidate { taskId: string; expectedRevision: number; purgeId: string; estimatedReclaimedBytes: number }
export interface RetentionSkillCandidate extends SkillCompactionRequest { estimatedReclaimedBytes: number }
/** Live usage of deepseek_servant Storage Domain values only; no native DSH Session logs. */
export interface StorageUsageStats {
  totalBytes: number
  permanentBytes: number
  temporaryBytes: number
  recordedAt: string
  permanent: {
    chatBytes: number
    assistantBytes: number
    knowledgeBytes: number
    originBytes: number
    archiveBytes: number
    historyBytes: number
  }
  temporary: {
    taskBytes: number
    plannerMemoryBytes: number
    plannerNoteBytes: number
    workerReplyBytes: number
    executionBytes: number
    recoveryBytes: number
  }
}
export interface RetentionPreview {
  manual?: boolean
  previewId: string
  createdAt: string
  policyRevision: number
  policy: RetentionPolicy
  scope?: KnowledgeScope
  archiveTasks: RetentionTaskCandidate[]
  deleteArchives: RetentionArchiveCandidate[]
  compactSkills: RetentionSkillCandidate[]
  nativeCleanup: Array<{ taskId: string; purgeId: string; sessionId: string }>
  blocked: RetentionBlockedItem[]
  totals: {
    servantBytes: number
    taskBytes: number
    knowledgeBytes: number
    assistantBytes: number
    tombstoneBytes: number
    detailedTasks: number
    archivedTasks: number
    pinnedArchives: number
    nativeSessionBytes: number
    nativeSizeUnknown: number
    /** Includes existing archived native logs; none of these bytes are promised as reclaimed. */
    nativeRetainedSessions: number
    foregroundSessionBytes: number
    foregroundSizeUnknown: number
    estimatedReclaimedBytes: number
    overBudgetBytes: number
  }
}
export interface RetentionSweepResult {
  startedAt: string
  finishedAt: string
  archivedTasks: string[]
  deletedArchives: string[]
  compactedSkills: string[]
  retiredNativeSessions: string[]
  nativeLogsRetained: string[]
  skipped: Array<{ id: string; reason: string }>
  /** Observed net decrease across Servant-owned storage snapshots, including cleanup receipts. */
  reclaimedServantBytes: number
  nativeReclaimedBytes: number
  remaining: RetentionPreview
}
