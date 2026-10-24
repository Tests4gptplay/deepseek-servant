import type { Task } from '../contracts/task.js'
import type { ArchiveTaskCommand, PurgeArchiveCommand, RetentionBlockReason, TaskArchive } from '../contracts/retention.js'

type ArchivableTask = Task & { archive?: TaskArchive }
export type RetentionTransition = { ok: true } | { ok: false; code: string; reason: string }
const reject = (code: string, reason: string): RetentionTransition => ({ ok: false, code, reason })
export function jsonBytes(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).byteLength }

/** Eligibility is rechecked in the Task command queue, never inferred from an old preview. */
export function retentionBlockers(task: ArchivableTask): RetentionBlockReason[] {
  const reasons = new Set<RetentionBlockReason>()
  if (!['completed', 'cancelled'].includes(task.phase)) reasons.add('active')
  if (task.control === 'paused') reasons.add('paused')
  for (const execution of Object.values(task.executions)) {
    if (execution.state === 'active' || !['stopped', 'lost'].includes(execution.physicalState)) reasons.add('physical-owner')
    if (execution.ownedJobIds.length) reasons.add('live-jobs')
  }
  for (const action of Object.values(task.pendingActions)) {
    if (action.status === 'uncertain') reasons.add('uncertain-effects')
    if (action.status === 'pending' || action.status === 'running') reasons.add('pending-actions')
  }
  // Cancellation ends the request; obsolete questions are not fabricated as
  // answered. Actual owners and uncertain side effects still block cleanup.
  if (task.control !== 'cancelled') {
    if (Object.values(task.waits).some(wait => wait.state === 'waiting')) reasons.add('wait')
    if (Object.values(task.incidents).some(incident => incident.state !== 'resolved')) reasons.add('recovery')
    if (task.delivery?.status !== 'delivered') reasons.add('delivery')
  }
  return [...reasons]
}

/** Mutates only a cloned aggregate, only after validating the complete request. */
export function applyRetentionCommand(task: ArchivableTask, command: ArchiveTaskCommand | PurgeArchiveCommand, now: string): RetentionTransition {
  if (command.source.kind !== 'runtime') return reject('RUNTIME_ONLY', 'Retention requires the local runtime owner.')
  if (task.revision !== command.expectedRevision) return reject('RETENTION_STALE', 'Task changed after retention was planned.')
  if (!command.purgeId || typeof command.purgeId !== 'string') return reject('INVALID_PURGE_ID', 'A durable cleanup identity is required.')
  if (command.type === 'task.purgeArchive') {
    const archive = task.archive
    if (!archive || archive.purgeId !== command.purgeId) return reject('ARCHIVE_CHANGED', 'The cleanup manifest no longer matches.')
    if (command.session) {
      const previous = archive.sessions.find(item => item.sessionId === command.session!.sessionId)
      if (!previous) return reject('FOREIGN_SESSION', 'Only a Session recorded by this Task may be retired.')
      if (!['archived', 'absent', 'blocked'].includes(command.session.state)) return reject('INVALID_RETIREMENT', 'A native retirement needs an observed disposition.')
      if (['archived', 'absent'].includes(previous.state) && previous.state !== command.session.state) return reject('RETIREMENT_FINISHED', 'A finished native retirement cannot be reopened.')
      if (command.session.state === 'archived' && !command.session.logRetained) return reject('UNPROVEN_ERASURE', 'Supported native archival retains the Session log.')
      if (command.session.retainedBytes !== undefined && (!Number.isFinite(command.session.retainedBytes) || command.session.retainedBytes < 0)) return reject('INVALID_BYTES', 'Retained byte count must be nonnegative.')
    }
    if (command.memoryState !== undefined && command.memoryState !== 'done') return reject('INVALID_MEMORY_CLEANUP', 'Memory cleanup can only be acknowledged after completion.')
    // Archived tasks reject every business command independently of receipts;
    // retirement retries are state-idempotent and need no growing retry ledger.
    task.receipts = {}
    if (command.session) {
      const index = archive.sessions.findIndex(item => item.sessionId === command.session!.sessionId)
      archive.sessions[index] = { ...structuredClone(command.session), updatedAt: now }
    }
    if (command.memoryState) archive.memoryState = command.memoryState
    if (command.memoryReason) archive.memoryReason = command.memoryReason
    return { ok: true }
  }
  if (task.archive) return reject('TASK_ARCHIVED', 'Task details have already been archived.')
  const reasons = retentionBlockers(task)
  if (reasons.length) return reject('RETENTION_BLOCKED', `Task is not safe to archive: ${reasons.join(', ')}.`)
  if (!Array.isArray(command.retainedResultIds) || command.retainedResultIds.some(id => typeof id !== 'string' || !Object.hasOwn(task.reports, id))) {
    return reject('MISSING_RETAINED_EVIDENCE', 'Every pinned result must exist in this Task before cleanup.')
  }
  const retained = new Set([
    ...command.retainedResultIds,
    ...Object.values(task.children).flatMap(child => child.acceptedResultId ? [child.acceptedResultId] : []),
    ...(task.delivery?.resultIds ?? []),
  ])
  if ([...retained].some(id => !Object.hasOwn(task.reports, id))) return reject('MISSING_DELIVERY_EVIDENCE', 'Delivery evidence is incomplete; no details were removed.')
  const originalBytes = jsonBytes(task)
  const sessions = [...new Set(Object.values(task.executions).filter(execution => execution.role !== 'foreground').map(execution => execution.sessionId))]
    .map(sessionId => ({ sessionId, state: 'pending' as const, logRetained: true }))
  const children = new Set([...retained].map(id => task.reports[id].childId))
  const executions = new Set([...retained].map(id => task.reports[id].executionId))
  const actions = new Set([...executions].map(id => task.executions[id].actionId))
  const unresolvedAtCancellation = task.control === 'cancelled' ? {
    waits: Object.values(task.waits).filter(wait => wait.state === 'waiting').length,
    incidents: Object.values(task.incidents).filter(incident => incident.state !== 'resolved').length,
  } : undefined
  task.reports = Object.fromEntries([...retained].map(id => {
    const report = structuredClone(task.reports[id])
    delete report.wait
    Reflect.deleteProperty(report, 'memory')
    Reflect.deleteProperty(report, 'checkpoint')
    report.frontier = 'Archived terminal result; no execution remains.'
    return [id, report]
  }))
  task.children = Object.fromEntries([...children].map(id => {
    const child = structuredClone(task.children[id])
    delete child.activeExecutionId
    if (child.currentResultId && !retained.has(child.currentResultId)) delete child.currentResultId
    child.dependsOn = child.dependsOn.filter(dependency => children.has(dependency))
    child.resources = []; child.writeScopes = []
    return [id, child]
  }))
  task.executions = Object.fromEntries([...executions].map(id => {
    const execution = structuredClone(task.executions[id])
    execution.resources = []; execution.writeScopes = []
    return [id, execution]
  }))
  task.pendingActions = Object.fromEntries([...actions].map(id => {
    const action = structuredClone(task.pendingActions[id])
    action.payload = { goalRevision: action.payload.goalRevision }
    if (action.executionId && !executions.has(action.executionId)) delete action.executionId
    delete action.evidence
    return [id, action]
  }))
  task.plan = { ...task.plan, strategy: '', childIds: task.plan.childIds.filter(id => children.has(id)) }
  task.needsPlanning = false
  task.waits = {}; task.incidents = {}; task.receipts = {}; task.decisions = []
  for (const field of ['goalHistory', 'plannerMemory', 'planNote', 'plannerNote', 'memory']) Reflect.deleteProperty(task, field)
  task.archive = { schemaVersion: 1, archivedAt: now, purgeId: command.purgeId, originalBytes,
    retainedResultIds: [...retained], sessions, memoryState: 'done',
    ...(unresolvedAtCancellation ? { unresolvedAtCancellation } : {}) }
  return { ok: true }
}
