import path from 'node:path'
import type { Child, ExecutionBinding, PendingAction, PhysicalState, Task } from '../contracts/task.js'

export interface LiveExecutionState {
  state: PhysicalState | 'waiting'
  ownedJobIds?: readonly string[]
}
export interface Admission { allowed: boolean; reason?: string; code?: string }
export interface SchedulerOptions { workerSeats?: number; platform?: 'win32' | 'posix' }
export type LiveExecutions = ReadonlyMap<string, LiveExecutionState>

/** Servant-only admission, not an OS lock and not a new global DSH capacity pool. */
export class Scheduler {
  readonly workerSeats: number
  private readonly platform?: 'win32' | 'posix'

  constructor(options: SchedulerOptions | number = {}) {
    const settings = typeof options === 'number' ? { workerSeats: options } : options
    this.workerSeats = settings.workerSeats ?? 2
    this.platform = settings.platform
    if (!Number.isInteger(this.workerSeats) || this.workerSeats < 1) throw new Error('workerSeats must be a positive integer')
  }

  canRun(task: Task, action: PendingAction, allTasks: readonly Task[], live: LiveExecutions = new Map()): Admission {
    const deny = (code: string, reason: string): Admission => ({ allowed: false, code, reason })
    const stored = Object.hasOwn(task.pendingActions, action.id) ? task.pendingActions[action.id] : undefined
    if (!stored) return deny('ACTION_NOT_OWNED', 'The action does not belong to this task.')
    action = stored
    const tasks = [task, ...allTasks.filter(other => other.id !== task.id)]
    if (!['pending', 'running'].includes(action.status)) return deny('ACTION_NOT_PENDING', 'The action has already completed, been superseded, or needs reconciliation.')
    if (action.kind === 'stop') {
      const execution = task.executions[action.payload.executionId ?? '']
      return execution ? { allowed: true } : deny('EXECUTION_NOT_FOUND', 'The exact owner is missing.')
    }
    if (task.control !== 'running') return deny(task.control === 'paused' ? 'TASK_PAUSED' : 'TASK_CANCELLED', 'User control forbids new work or delivery.')
    if (action.kind === 'learn') {
      return action.payload.resultIds?.length && action.payload.resultIds.every(id => ['accepted', 'rework'].includes(task.reports[id]?.disposition))
        && (action.payload.learningProposals ?? []).every(proposal => !proposal.activate || task.reports[proposal.resultId]?.disposition === 'accepted')
        ? { allowed: true } : deny('LEARNING_EVIDENCE_MISSING', 'A candidate needs evaluated source evidence; activation requires accepted output.')
    }
    if (action.kind === 'feedback') {
      return action.payload.resultIds?.length && action.payload.resultIds.every(id => ['accepted', 'rework'].includes(task.reports[id]?.disposition))
        ? { allowed: true } : deny('FEEDBACK_NOT_DECIDED', 'Feedback must reference saved accepted/rework decisions and observed skill uses.')
    }
    if (action.kind === 'help') {
      const incident = task.incidents[action.payload.incidentId ?? '']
      if (!incident || incident.state === 'resolved') return deny('INCIDENT_NOT_ACTIVE', 'The exact recovery incident is no longer active.')
      if (Object.values(task.executions).some(e => e.role === 'helper' && e.incidentId === incident.id && occupiesPhysicalOwner(e, live))) return deny('HELPER_BUSY', 'This incident still has an exact physical Helper owner or unreconciled jobs.')
      if (Object.values(task.pendingActions).some(a => a.id !== action.id && a.kind === 'help' && a.payload.incidentId === incident.id && a.status === 'running')) return deny('HELPER_RESERVED', 'Another saved Helper action already owns this incident.')
      return { allowed: true }
    }
    if (action.payload.goalRevision !== task.goal.revision) return deny('GOAL_CHANGED', 'The action belongs to an older goal.')
    if (action.kind === 'deliver') {
      const delivery = task.delivery
      return delivery && delivery.id === action.payload.deliveryId && delivery.status === 'pending'
        ? { allowed: true } : deny('DELIVERY_CHANGED', 'Only the current saved pending delivery can be presented.')
    }
    if (Object.values(task.waits).some(w => w.state === 'waiting' && !w.childId)) return deny('TASK_WAITING', 'A required task-level wait remains unresolved.')
    if (action.kind === 'plan' || action.kind === 'evaluate') {
      if (task.delivery || task.phase === 'completed') return deny('TASK_FINISHED', 'The goal already reached delivery; this semantic action is obsolete.')
      if (Object.values(task.executions).some(e => e.role === 'planner' && occupiesPhysicalOwner(e, live))) return deny('PLANNER_BUSY', 'The task still has an exact physical Planner owner or unreconciled jobs.')
      if (Object.values(task.pendingActions).some(a => a.id !== action.id && ['plan', 'evaluate'].includes(a.kind) && a.status === 'running')) return deny('PLANNER_RESERVED', 'Another saved planning/evaluation action already owns the task.')
      if (action.kind === 'evaluate' && (task.needsPlanning || task.plan.goalRevision !== task.goal.revision)) return deny('REPLAN_REQUIRED', 'Reconcile the changed goal before acceptance.')
      return { allowed: true }
    }
    if (task.delivery || task.phase === 'completed') return deny('TASK_FINISHED', 'The task has already reached delivery.')
    if (task.needsPlanning || task.plan.goalRevision !== task.goal.revision) return deny('REPLAN_REQUIRED', 'Reconcile the changed goal before starting work.')
    const child = task.children[action.payload.childId ?? '']
    if (!child || !task.plan.childIds.includes(child.id)) return deny('CHILD_RETIRED', 'The child is not in the current plan.')
    if (child.assignmentVersion !== action.payload.assignmentVersion || child.goalRevision !== task.goal.revision) return deny('ASSIGNMENT_CHANGED', 'This action belongs to an older assignment.')
    if (!child.dependsOn.every(id => task.children[id]?.status === 'accepted' && task.children[id].acceptedAtGoalRevision === task.goal.revision)) return deny('DEPENDENCIES_PENDING', 'Required inputs have not been accepted for the current goal.')
    if (Object.values(task.waits).some(w => w.state === 'waiting' && w.childId === child.id)) return deny('CHILD_WAITING', 'This child has an unresolved wait.')
    if (Object.values(task.incidents).some(i => i.childId === child.id && i.state !== 'resolved')) return deny('RECOVERY_PENDING', 'The child has an unresolved execution fault.')

    let ownExecution: ExecutionBinding | undefined
    if (action.kind === 'dispatch') {
      if (!['pending', 'rework'].includes(child.status) || child.activeExecutionId) return deny('CHILD_ALREADY_OWNED', 'This assignment already has an owner or a result.')
      const predecessorId = action.payload.predecessorExecutionId
      if (child.handoff?.predecessorExecutionId !== predecessorId) return deny('HANDOFF_CHANGED', 'The dispatch does not match this assignment’s saved handoff.')
      if (predecessorId) {
        const predecessor = task.executions[predecessorId]
        if (!predecessor || predecessor.role !== 'worker' || predecessor.childId !== child.id || predecessor.assignmentVersion !== child.assignmentVersion
          || predecessor.state === 'active') return deny('HANDOFF_CHANGED', 'The exact previous Worker must have ended its semantic ownership of this assignment.')
        // A handoff also owns its predecessor when the assignment has no file
        // or resource claims. Never infer retirement from an idle model alone.
        if (live.has(predecessorId) || !['stopped', 'lost'].includes(predecessor.physicalState) || predecessor.ownedJobIds.length) {
          return deny('HANDOFF_OWNER_BUSY', 'The exact previous Worker and its jobs must be retired before a new Session can continue the same assignment.')
        }
      }
    } else if (action.kind === 'continue') {
      ownExecution = task.executions[action.payload.executionId ?? '']
      if (!ownExecution || ownExecution.role !== 'worker' || ownExecution.state !== 'active' || ownExecution.stopRequested
        || ownExecution.assignmentVersion !== child.assignmentVersion || child.activeExecutionId !== ownExecution.executionId || child.status !== 'running') return deny('EXECUTION_CLOSED', 'Only the current valid Worker can continue this assignment.')
      const physical = live.get(ownExecution.executionId)
      if (!physical) return deny('OWNER_NOT_LIVE', 'A persisted id is not a live Agent; reconcile its owner before continuing.')
      if (physical.state !== 'idle') return deny('OWNER_BUSY', 'Continuation is admitted only at the current live Agent’s idle frontier.')
    } else return deny('UNKNOWN_ACTION', 'Unsupported scheduler action.')

    // Idle/waiting Agents release inference capacity but retain their exact
    // physical claims. A still-live job is a resource reservation, not an
    // additional model seat. Unknown execution is conservatively counted.
    let occupied = 0
    for (const ownerTask of tasks) {
      for (const execution of Object.values(ownerTask.executions)) {
        if (execution.role !== 'worker' || execution.executionId === ownExecution?.executionId) continue
        const state = live.get(execution.executionId)?.state ?? execution.physicalState
        if (['starting', 'running', 'stopping', 'unknown'].includes(state)) occupied++
      }
      // Claim-to-binding is also a durable reservation. Exclude this action
      // when it is rechecked after claim and before its binding is committed.
      occupied += Object.values(ownerTask.pendingActions).filter(a => a.kind === 'dispatch' && a.status === 'running' && !a.executionId && !(ownerTask.id === task.id && a.id === action.id)).length
    }
    if (occupied >= this.workerSeats) return deny('WORKER_CAPACITY', `All ${this.workerSeats} configured Servant Worker inference seats are occupied.`)

    const claims = normalizeClaims(task, child.writeScopes, this.platform)
    for (const ownerTask of tasks) for (const execution of Object.values(ownerTask.executions)) {
      if (execution.role !== 'worker' || execution.executionId === ownExecution?.executionId || !occupiesPhysicalOwner(execution, live)) continue
      if (child.resources.some(resource => execution.resources.includes(resource))) return deny('RESOURCE_BUSY', `An exact running owner still reserves a requested resource (${execution.executionId}).`)
      const existing = normalizeClaims(ownerTask, execution.writeScopes, this.platform)
      if (claims.some(claim => existing.some(held => pathsOverlap(claim, held)))) return deny('WRITE_SCOPE_BUSY', `An exact running owner still reserves overlapping files (${execution.executionId}).`)
    }
    // Before a physical binding is saved, a claimed dispatch already reserves
    // its task-scoped writes/resources as well as an inference seat.
    for (const ownerTask of tasks) for (const pending of Object.values(ownerTask.pendingActions)) {
      if ((ownerTask.id === task.id && pending.id === action.id) || pending.kind !== 'dispatch' || pending.status !== 'running' || pending.executionId) continue
      const other = ownerTask.children[pending.payload.childId ?? '']
      if (!other) continue
      if (child.resources.some(resource => other.resources.includes(resource))) return deny('RESOURCE_RESERVED', 'A saved dispatch claim already reserves a requested resource.')
      const existing = normalizeClaims(ownerTask, other.writeScopes, this.platform)
      if (claims.some(claim => existing.some(held => pathsOverlap(claim, held)))) return deny('WRITE_SCOPE_RESERVED', 'A saved dispatch claim already reserves overlapping files.')
    }
    return { allowed: true }
  }
}

function occupiesPhysicalOwner(execution: ExecutionBinding, live: LiveExecutions): boolean {
  const observed = live.get(execution.executionId)
  const state = observed?.state ?? execution.physicalState
  // `lost` is an observed absent owner, not the mere absence of an in-memory
  // handle after restart (which must be `unknown` and separately reconciled).
  return (observed?.ownedJobIds ?? execution.ownedJobIds).length > 0 || state !== 'stopped' && state !== 'lost'
}

export interface NormalizedWriteScope { style: 'win32' | 'posix'; path: string }

export function normalizeClaims(task: Pick<Task, 'workspace'>, scopes: readonly string[], override?: 'win32' | 'posix'): NormalizedWriteScope[] {
  const directory = task.workspace.directory
  const style = override ?? (/^[a-z]:[\\/]/i.test(directory) || directory.startsWith('\\\\') ? 'win32' : 'posix')
  const native = style === 'win32' ? path.win32 : path.posix
  return scopes.map(scope => {
    // Declared globs reserve their static ancestor. This is deliberately
    // conservative coordination, not a second filesystem authorization engine.
    const wildcard = scope.search(/[*?\[\]{}]/)
    let target = scope
    if (wildcard >= 0) {
      const prefix = scope.slice(0, wildcard)
      const sep = Math.max(prefix.lastIndexOf('/'), style === 'win32' ? prefix.lastIndexOf('\\') : -1)
      target = sep < 0 ? '.' : prefix.slice(0, sep + 1)
    }
    let normalized = native.resolve(directory, target || '.')
    if (style === 'win32') normalized = normalized.replaceAll('\\', '/').toLowerCase()
    if (normalized.length > 1) normalized = normalized.replace(/\/+$/, '')
    return { style, path: normalized }
  })
}

export function pathsOverlap(a: NormalizedWriteScope, b: NormalizedWriteScope): boolean {
  if (a.style !== b.style) return false
  return a.path === b.path || a.path.startsWith(b.path.endsWith('/') ? b.path : `${b.path}/`) || b.path.startsWith(a.path.endsWith('/') ? a.path : `${a.path}/`)
}
