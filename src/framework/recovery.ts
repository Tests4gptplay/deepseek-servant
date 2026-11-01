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
  kind: 'probe-helper' | 'warn-helper' | 'inspect-role' | 'restore-helper' | 'change-strategy'
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
  if (state.stage === 3) return { state }
  const since = Math.max(state.stageStartedAt, state.lastProgressAt)
  if (now - since < OBSERVATION_INTERVALS_MS[state.stage]) return { state }
  const stage = (state.stage + 1) as 1 | 2 | 3
  const kind = state.identity.role === 'Helper'
    ? stage === 1 ? 'probe-helper' : stage === 2 ? 'warn-helper' : 'restore-helper'
    : stage === 3 ? 'change-strategy' : 'inspect-role'
  // The next interval starts at the actual check, rather than issuing all overdue checks at once.
  return { state: { ...state, stage, stageStartedAt: now }, action: {
    kind, identity: { ...state.identity }, stage, elapsedMs: now - state.cycleStartedAt,
    silentMs: now - state.lastProgressAt,
  } }
}
/** A replacement is still the same work: do not reset the observation stage or cycle.
 * Start timing the new execution after its actual stop/start overhead, not while it was stopped.
 */
export function rebindObservation(state: ObservationState, executionId: string, resumedAt: number): ObservationState {
  return { ...state, identity: { ...state.identity, executionId }, stageStartedAt: Math.max(state.stageStartedAt, resumedAt) }
}
export interface HealthyCycleEvidence { continuouslyNormal: boolean; noNewRecoveryAnomaly: boolean }
export function completeHealthyObservationCycle(state: ObservationState, now: number, evidence: HealthyCycleEvidence): ObservationState {
  if (state.stage !== 3 || now - state.cycleStartedAt < OBSERVATION_CYCLE_MS || !evidence.continuouslyNormal || !evidence.noNewRecoveryAnomaly) return state
  // Only a Helper assessment of a full healthy cycle may reset this object's phase.
  return { ...state, cycleStartedAt: now, stageStartedAt: now, stage: 0 }
}

export interface MemberIdentity { taskId: string; member: string }
export interface RecoveryWatch extends MemberIdentity {
  cycleStartedAt: number
  stageStartedAt: number
  stage: ObservationStage
}
export function createRecoveryWatch(identity: MemberIdentity, now: number): RecoveryWatch {
  return { ...identity, cycleStartedAt: now, stageStartedAt: now, stage: 0 }
}
export function dueRecoveryWatch(state: RecoveryWatch, now: number): { state: RecoveryWatch; action?: { kind: 'recovery-check'; taskId: string; member: string; stage: 1 | 2 | 3; elapsedMs: number } } {
  if (state.stage === 3 || now - state.stageStartedAt < OBSERVATION_INTERVALS_MS[state.stage]) return { state }
  const stage = (state.stage + 1) as 1 | 2 | 3
  return { state: { ...state, stage, stageStartedAt: now }, action: {
    kind: 'recovery-check', taskId: state.taskId, member: state.member, stage, elapsedMs: now - state.cycleStartedAt,
  } }
}
export function completeHealthyRecoveryCycle(state: RecoveryWatch, now: number, evidence: HealthyCycleEvidence): RecoveryWatch {
  return state.stage === 3 && evidence.continuouslyNormal && evidence.noNewRecoveryAnomaly
    ? createRecoveryWatch(state, now) : state
}
export function canConsumeRecovery(actor: Pick<WorkIdentity, 'role' | 'taskId' | 'member'>, marker: MemberIdentity): boolean {
  return actor.role === 'Planner' && actor.taskId === marker.taskId && actor.member === marker.member
}
/** Return undefined only after this exact Planner confirms normal-chain arrival/self-resumption.
 * No all-Workers ACK or business-quality-complete condition is introduced.
 */
export function consumeRecoveryWatch(state: RecoveryWatch, actor: Pick<WorkIdentity, 'role' | 'taskId' | 'member'>, canContinue: boolean): RecoveryWatch | undefined {
  if (!canConsumeRecovery(actor, state)) throw new Error('Only the corresponding member Planner can consume recovery.')
  return canContinue ? undefined : state
}
export type HelperTrigger = 'ai-help' | 'host-error' | 'no-progress-warning' | 'warning'
export function invokesHelper(trigger: HelperTrigger): boolean { return trigger !== 'warning' }

export interface WorkerRecoveryInput {
  workerId: string
  executionId: string
  notePath: string
  /** Body bytes, not JSON/manifest container bytes. Zero is the only empty state. */
  noteBodyBytes: number
  executing: boolean
}
export interface MemberRecoveryInput extends MemberIdentity {
  taskPath: string
  inboxPath: string
  inboxBodyBytes: number
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
export function memberRecoveryEligible(member: Pick<MemberRecoveryInput, 'inboxBodyBytes' | 'status' | 'pendingBusiness'>): boolean {
  return member.inboxBodyBytes > 0 && (member.status === 'running' || member.pendingBusiness)
}
export function recoveryTargetKey(target: Pick<RecoveryTarget, 'taskId' | 'member' | 'role' | 'workerId'>): string {
  return JSON.stringify([target.taskId, target.member, target.role, target.workerId ?? null])
}
/** Pure full scan: all Task/member domains are considered before any recovery is arranged. */
export function scanMemberRecovery(members: readonly MemberRecoveryInput[], scheduled: readonly RecoveryTarget[] = []): RecoveryTarget[] {
  const seen = new Set(scheduled.map(recoveryTargetKey)), targets: RecoveryTarget[] = []
  for (const member of members) {
    if (!memberRecoveryEligible(member) || !member.needsRecovery || member.workers.some(worker => worker.executing)) continue
    const notes = member.workers.filter(worker => worker.noteBodyBytes > 0)
    const candidates: RecoveryTarget[] = notes.length ? notes.map(worker => ({
      role: 'Worker', taskId: member.taskId, member: member.member, executionId: worker.executionId,
      workerId: worker.workerId, taskPath: member.taskPath, recordPath: worker.notePath, pendingSignals: [...member.pendingSignals],
    })) : member.plannerExecuting ? [] : [{
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
/** Actual Helper recovery selects all eligible domains, not merely the first failed Task.
 * Call only after diagnosis decides to restore. Warning inspection does not hang markers.
 */
export function helperRecoveryMembers(members: readonly MemberRecoveryInput[]): MemberIdentity[] {
  const found = new Map<string, MemberIdentity>()
  for (const member of members) if (memberRecoveryEligible(member)) found.set(JSON.stringify([member.taskId, member.member]), { taskId: member.taskId, member: member.member })
  return [...found.values()]
}
export function usesMemberRecovery(role: RecoveryRole, member?: MemberIdentity): boolean {
  return member !== undefined && (role === 'Planner' || role === 'Worker')
}

/** Holds the startup boundary only. enqueue() must record scheduling, not await model work.
 * The scheduler rechecks actual execution again when a queued item actually starts.
 */
export class StartupRecoveryBatch {
  phase: 'scanning' | 'arranging' | 'normal' = 'scanning'
  private members: MemberRecoveryInput[] = []
  private targets: RecoveryTarget[] = []
  private next = 0
  collect(member: MemberRecoveryInput): void {
    if (this.phase !== 'scanning') throw new Error('Startup recovery scan already finished.')
    this.members.push(member)
  }
  finishScan(scheduled: readonly RecoveryTarget[] = []): readonly RecoveryTarget[] {
    if (this.phase !== 'scanning') return this.targets
    this.targets = scanMemberRecovery(this.members, scheduled)
    this.phase = 'arranging'
    return this.targets
  }
  async arrange(enqueue: (target: RecoveryTarget) => Promise<void>, alreadyExecutingOrScheduled: (target: RecoveryTarget) => Promise<boolean>): Promise<void> {
    if (this.phase === 'scanning') throw new Error('Finish the full recovery scan before arranging wakeups.')
    while (this.next < this.targets.length) {
      const target = this.targets[this.next]!
      if (!await alreadyExecutingOrScheduled(target)) await enqueue(target)
      this.next++
    }
    this.phase = 'normal'
  }
  get ordinaryWakeupsAllowed(): boolean { return this.phase === 'normal' }
}
