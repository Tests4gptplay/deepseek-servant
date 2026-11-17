/** Shared Local/Git recovery rules. Storage and native execution remain adapter responsibilities.
 * Pure observation and startup-recovery decisions; no file polling or role execution here.
 */
export type RecoveryRole = 'Foreground' | 'Organizer' | 'Planner' | 'Worker' | 'Recorder' | 'Helper'
export const OBSERVATION_INTERVALS_MS = [5 * 60_000, 5 * 60_000, 30 * 60_000] as const
export const OBSERVATION_CYCLE_MS = OBSERVATION_INTERVALS_MS.reduce((sum, value) => sum + value, 0)
export type ObservationStage = 0 | 1 | 2 | 3
export interface WorkIdentity {
  /** Stable for the same work across a replacement execution. */
  workId: string
  executionId: string
  role: RecoveryRole
  taskId?: string
  lifecycleId?: string
  member?: string
  workerId?: string
}
export interface ObservationState {
  identity: WorkIdentity
  cycleStartedAt: number
  stageStartedAt: number
  lastProgressAt: number
  stage: ObservationStage
}
export type ProgressKind = 'model-text' | 'reasoning' | 'tool-progress' | 'connection-heartbeat'
export interface ObservationAction {
  kind: 'probe-helper' | 'warn-helper' | 'probe-role' | 'warn-role' | 'restore-helper' | 'restart-role'
  identity: WorkIdentity
  stage: 1 | 2 | 3
  elapsedMs: number
  silentMs: number
}
export function createObservation(identity: WorkIdentity, now: number): ObservationState {
  return { identity: { ...identity }, cycleStartedAt: now, stageStartedAt: now, lastProgressAt: now, stage: 0 }
}
export function recordProgress(state: ObservationState, kind: ProgressKind, now: number): ObservationState {
  // Connection keep-alives say nothing about model/tool progress. Late events cannot move time backwards.
  return kind === 'connection-heartbeat' ? state : { ...state, lastProgressAt: Math.max(state.lastProgressAt, now) }
}
export function dueObservation(state: ObservationState, now: number): { state: ObservationState; action?: ObservationAction } {
  if (state.identity.role === 'Foreground' || state.stage === 3) return { state }
  const since = Math.max(state.stageStartedAt, state.lastProgressAt)
  if (now - since < OBSERVATION_INTERVALS_MS[state.stage]) return { state }
  const stage = (state.stage + 1) as 1 | 2 | 3
  const kind = state.identity.role === 'Helper'
    ? stage === 1 ? 'probe-helper' : stage === 2 ? 'warn-helper' : 'restore-helper'
    : stage === 1 ? 'probe-role' : stage === 2 ? 'warn-role' : 'restart-role'
  // The next interval starts at the actual check, rather than issuing all overdue checks at once.
  return { state: { ...state, stage, stageStartedAt: now }, action: {
    kind, identity: { ...state.identity }, stage, elapsedMs: now - state.cycleStartedAt,
    silentMs: now - state.lastProgressAt,
  } }
}
/** A genuinely new execution starts its own mechanical observation cycle.
 * Resuming the same execution preserves its stage and excludes stopped time. */
export function rebindObservation(state: ObservationState, executionId: string, resumedAt: number): ObservationState {
  if (state.identity.executionId !== executionId) return createObservation({ ...state.identity, executionId }, resumedAt)
  return { ...state, stageStartedAt: Math.max(state.stageStartedAt, resumedAt) }
}

export interface MemberIdentity { taskId: string; member: string }
export interface RecoveryWatch extends MemberIdentity {
  cycleStartedAt: number
  stageStartedAt: number
  stage: number
}
export function createRecoveryWatch(identity: MemberIdentity, now: number): RecoveryWatch {
  return { ...identity, cycleStartedAt: now, stageStartedAt: now, stage: 0 }
}
export function dueRecoveryWatch(state: RecoveryWatch, now: number): { state: RecoveryWatch; action?: { kind: 'recovery-check'; taskId: string; member: string; stage: number; elapsedMs: number } } {
  // A positive stage is the already-owned Helper check. Helper explicitly
  // resets its watch after checking; elapsed time must not queue another check
  // while that original responsibility is still running or recovering.
  if (state.stage > 0 || now - state.stageStartedAt < 30 * 60_000) return { state }
  const stage = state.stage + 1
  return { state: { ...state, stage, stageStartedAt: now }, action: {
    kind: 'recovery-check', taskId: state.taskId, member: state.member, stage, elapsedMs: now - state.cycleStartedAt,
  } }
}

export interface WorkerRecoveryInput {
  workerId: string
  executionId: string
  notePath: string
  /** Actual Note body content, not JSON/manifest container size or text significance. */
  noteHasContent: boolean
  executing: boolean
  /** Existing Host responsibility facts, not inferred from retained Note text. */
  ended?: boolean
}
export interface MemberRecoveryInput extends MemberIdentity {
  taskPath: string
  inboxPath: string
  inboxHasContent: boolean
  status: 'running' | 'complete'
  pendingBusiness: boolean
  needsRecovery: boolean
  plannerExecutionId: string
  plannerMemoryPath: string
  plannerExecuting: boolean
  workers: readonly WorkerRecoveryInput[]
  /** Observed, never consumed by this scan. */
  pendingSignals: readonly string[]
}
export interface RecoveryTarget extends MemberIdentity {
  role: 'Planner' | 'Worker'
  executionId: string
  workerId?: string
  taskPath: string
  recordPath: string
  pendingSignals: readonly string[]
}
export function memberRecoveryEligible(member: Pick<MemberRecoveryInput, 'inboxHasContent' | 'status' | 'pendingBusiness'>): boolean {
  return member.inboxHasContent && (member.status === 'running' || member.pendingBusiness)
}
export function recoveryTargetKey(target: Pick<RecoveryTarget, 'taskId' | 'member' | 'role' | 'workerId'>): string {
  return JSON.stringify([target.taskId, target.member, target.role, target.workerId ?? null])
}
/** Pure full scan: all Task/member domains are considered before any recovery is arranged. */
export function scanMemberRecovery(members: readonly MemberRecoveryInput[], scheduled: readonly RecoveryTarget[] = []): RecoveryTarget[] {
  const seen = new Set(scheduled.map(recoveryTargetKey)), targets: RecoveryTarget[] = []
  for (const member of members) {
    if (!memberRecoveryEligible(member) || !member.needsRecovery) continue
    const notes = member.workers.filter(worker => !worker.executing && !worker.ended && worker.noteHasContent)
    const candidates: RecoveryTarget[] = notes.length ? notes.map(worker => ({
      role: 'Worker', taskId: member.taskId, member: member.member, executionId: worker.executionId,
      workerId: worker.workerId, taskPath: member.taskPath, recordPath: worker.notePath, pendingSignals: [...member.pendingSignals],
    })) : member.plannerExecuting || member.workers.some(worker => worker.executing) ? [] : [{
      role: 'Planner', taskId: member.taskId, member: member.member, executionId: member.plannerExecutionId,
      taskPath: member.taskPath, recordPath: member.plannerMemoryPath, pendingSignals: [...member.pendingSignals],
    }]
    for (const target of candidates) {
      const key = recoveryTargetKey(target)
      if (!seen.has(key)) { seen.add(key); targets.push(target) }
    }
  }
  return targets
}
