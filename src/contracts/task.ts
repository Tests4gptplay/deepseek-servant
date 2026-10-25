import type { ArchiveTaskCommand, PurgeArchiveCommand, TaskArchive } from './retention.js'

export type Role = 'foreground' | 'planner' | 'worker' | 'helper'
export type ControlIntent = 'running' | 'paused' | 'cancelled'
export type TaskPhase = 'planning' | 'executing' | 'evaluating' | 'waiting' | 'delivering' | 'completed' | 'cancelled'
export type PhysicalState = 'starting' | 'running' | 'idle' | 'stopping' | 'stopped' | 'lost' | 'unknown'

/** Filled by a trusted host entry point. Never taken from model tool arguments. */
export type CommandSource =
  | { kind: 'user'; id: string; sessionId?: string; messageId?: string }
  | { kind: 'runtime'; id: string }
  | { kind: 'agent'; id: string; role: Role; executionId: string; sessionId?: string }

export interface WorkspaceBinding { id: string; directory: string }
export interface ModelRoute { provider?: string; model?: string; reasoningEffort?: string }
export interface RuntimeProfile { version: string; presetId: string; foreground: ModelRoute; background: ModelRoute }
export interface ArtifactRef { id: string; path: string; description: string; version?: string; sha256?: string; resultId?: string }
export interface GoalInput { request: string; objective: string; constraints: string[]; deliverables: string[]; acceptanceCriteria: string[]; sourceRef: string }
export interface GoalContract extends GoalInput { revision: number }
export interface GoalHistoryEntry { goal: GoalContract; replacedAt: string; commandId: string; changeSource: CommandSource }
export interface FailedApproach { approach: string; outcome: string; evidence: string[] }
export interface WorkCheckpoint { completed: string[]; failedApproaches: FailedApproach[]; remaining: string[]; nextAction: string; nextReads: string[] }
export interface PlannerBacklog { id: string; objective: string; reason: string; dependsOn: string[]; trigger: string; required: boolean; status: 'pending' | 'done' | 'cancelled' }
export interface PlannerNote { revision: number; goalRevision: number; body: string; frontier: string; updatedAt: string; commandId: string; backlog?: PlannerBacklog[] }
export interface PlannerMemoryInput {
  frontier?: string
  evidence?: string[]
  failedApproaches?: string[]
  changedAssumptions?: string[]
  planNote?: { expectedRevision: number; body: string; frontier: string; changeSummary: string; backlog?: PlannerBacklog[] }
  noteUse?: { revision: number; summary: string; frontier: string }
}
export interface ChildSpec {
  id: string
  title: string
  objective: string
  inputArtifacts: ArtifactRef[]
  acceptanceCriteria: string[]
  dependsOn: string[]
  writeScopes: string[]
  resources: string[]
}
export type ChildStatus = 'pending' | 'running' | 'waiting' | 'reported' | 'accepted' | 'rework' | 'cancelled'
export interface Child extends ChildSpec {
  assignmentVersion: number
  goalRevision: number
  status: ChildStatus
  progressSegments: number
  activeExecutionId?: string
  /** Normal continuation in a new native owner, preserving this assignment. */
  handoff?: { predecessorExecutionId: string; resultId: string; reviewRequired: boolean; recoveryIncidentId?: string }
  currentResultId?: string
  acceptedResultId?: string
  acceptedAtGoalRevision?: number
}
export interface Plan { revision: number; goalRevision: number; strategy: string; childIds: string[] }
export interface ExecutionBinding {
  executionId: string
  taskId: string
  role: Role
  agentId: string
  sessionId: string
  actionId: string
  childId?: string
  incidentId?: string
  assignmentVersion?: number
  goalRevision: number
  generation: number
  state: 'active' | 'closed' | 'superseded'
  physicalState: PhysicalState
  ownedJobIds: string[]
  /** Immutable claims of this assignment, retained after the Child is revised. */
  writeScopes: string[]
  resources: string[]
  stopRequested?: boolean
  model?: string
  configurationVersion?: string
  startedAt: string
  closedAt?: string
  observedAt: string
}
export type WaitKind = 'user' | 'configuration' | 'resource' | 'job' | 'recovery'
export interface WaitSpec { id: string; kind: WaitKind; reason: string; condition: string; resume: string; jobId?: string; question?: string }
export interface WaitRecord extends WaitSpec {
  executionId?: string
  childId?: string
  actionId?: string
  /** Exact incident this dependency unblocks; never infer global recovery. */
  incidentId?: string
  state: 'waiting' | 'resolved'
  createdAt: string
  resolvedAt?: string
  answer?: string
}
export interface ExecutionReportInput {
  resultId: string
  assignmentVersion: number
  outcome: 'progress' | 'continue' | 'handoff' | 'complete' | 'wait' | 'failed'
  summary: string
  artifacts: ArtifactRef[]
  evidence: string[]
  frontier: string
  wait?: WaitSpec
  checkpoint?: WorkCheckpoint
}
export interface ExecutionReport extends ExecutionReportInput {
  executionId: string
  childId: string
  goalRevision: number
  receivedAt: string
  disposition: 'unreviewed' | 'accepted' | 'rework' | 'superseded'
  commandId: string
  sequence?: number
}
export interface Incident {
  id: string
  executionId: string
  childId?: string
  state: 'open' | 'repairing' | 'resolved' | 'waiting'
  errors: Array<{ operation: string; message: string; at: string }>
  /** Saved work/configuration identity; repeated faults only block an unchanged frontier. */
  frontier?: string
  resolution?: string
  helperExecutionId?: string
}
export type ActionKind = 'plan' | 'evaluate' | 'dispatch' | 'continue' | 'stop' | 'deliver' | 'learn' | 'feedback' | 'recover' | 'help'
export interface LearningProposal {
  skillId: string
  title: string
  description: string
  body: string
  applicability: string
  resultId: string
  explanation: string
  artifactRefs: string[]
  activate?: boolean
  /** Revision is explicit so a delayed proposal cannot overwrite a newer method. */
  expectedVersion?: number
}
export interface ActionPayload {
  goalRevision: number
  planRevision?: number
  childId?: string
  executionId?: string
  /** A normal handoff cannot dispatch until this exact physical owner is gone. */
  predecessorExecutionId?: string
  recoveryIncidentId?: string
  assignmentVersion?: number
  resultIds?: string[]
  incidentId?: string
  deliveryId?: string
  reason?: string
  learningProposals?: LearningProposal[]
}
export interface PendingAction {
  id: string
  kind: ActionKind
  status: 'pending' | 'running' | 'done' | 'uncertain' | 'superseded'
  payload: ActionPayload
  createdAt: string
  commandId: string
  ownerId?: string
  startedAt?: string
  finishedAt?: string
  evidence?: string
  executionId?: string
}
export interface Delivery { id: string; summary: string; artifacts: ArtifactRef[]; resultIds: string[]; createdAt: string; status: 'pending' | 'delivered'; notificationId?: string; deliveredAt?: string; readAt?: string }
export interface DecisionRecord {
  commandId: string; source: CommandSource; at: string; goalRevision: number; summary: string
  sequence?: number
  kind?: 'plan' | 'evaluation' | 'checkpoint' | 'user-change' | 'recovery' | 'wait-resolution'
  planRevision?: number
  childDecisions?: Array<ChildDecision & { assignmentVersion: number; resultingAssignmentVersion: number }>
  frontier?: string
  evidence?: string[]
  failedApproaches?: string[]
  changedAssumptions?: string[]
  planNoteUsage?: { revision: number; summary: string; frontier: string }
  planNoteChange?: { fromRevision: number; toRevision: number; summary: string; frontier: string }
  childId?: string
  executionId?: string
  incidentId?: string
  recoveryOutcome?: 'resolved' | 'wait' | 'failed' | 'retired'
  physicalDisposition?: { state: PhysicalState; ownedJobIds: string[] }
  /** Append-only answer snapshot; the live wait map may later reuse its logical id. */
  resolvedWait?: WaitRecord
}
export interface CommandReceipt {
  commandId: string
  taskId: string
  status: 'applied' | 'duplicate' | 'stale' | 'rejected'
  revision: number
  actionIds: string[]
  reason?: string
  code?: string
  originalStatus?: 'applied' | 'stale' | 'rejected'
}
export interface StoredReceipt { fingerprint: string; receipt: CommandReceipt }
export interface Task {
  schemaVersion: 1
  id: string
  assistantId: string
  revision: number
  workspace: WorkspaceBinding
  runtimeProfile?: RuntimeProfile
  source: CommandSource
  foregroundEvaluator?: string
  control: ControlIntent
  phase: TaskPhase
  goal: GoalContract
  goalHistory?: GoalHistoryEntry[]
  plannerNote?: PlannerNote
  plan: Plan
  needsPlanning: boolean
  priority: number
  children: Record<string, Child>
  executions: Record<string, ExecutionBinding>
  reports: Record<string, ExecutionReport>
  waits: Record<string, WaitRecord>
  incidents: Record<string, Incident>
  pendingActions: Record<string, PendingAction>
  receipts: Record<string, StoredReceipt>
  decisions: DecisionRecord[]
  delivery?: Delivery
  createdAt: string
  updatedAt: string
  completedAt?: string
  cancelledAt?: string
  archive?: TaskArchive
}
export interface CommandBase { commandId: string; source: CommandSource; /** Trusted action correlation for a designated foreground evaluator. */ actionId?: string }
export interface SubmitTaskInput extends CommandBase { taskId?: string; assistantId: string; workspace: WorkspaceBinding; goal: GoalInput; runtimeProfile?: RuntimeProfile; foregroundEvaluator?: string; priority?: number }
export interface ChildDecision { childId: string; resultId: string; outcome: 'accept' | 'rework' | 'continue'; reason: string; revisedChild?: ChildSpec }
export type TaskCommand = CommandBase & (
  | { type: 'task.submit'; taskId: string; assistantId: string; workspace: WorkspaceBinding; goal: GoalInput; runtimeProfile?: RuntimeProfile; foregroundEvaluator?: string; priority?: number }
  | { type: 'planning.commit'; expectedPlanRevision: number; expectedGoalRevision: number; strategy: string; children: ChildSpec[]; updates?: ChildSpec[]; cancelChildIds?: string[]; retainAcceptedChildIds?: string[]; memory?: PlannerMemoryInput }
  | { type: 'planning.decide'; expectedGoalRevision: number; decisions: ChildDecision[]; summary: string; deliver?: { id: string; summary: string; artifacts: ArtifactRef[] }; learn?: { resultIds: string[]; reason: string; proposals?: LearningProposal[] }; memory?: PlannerMemoryInput }
  | { type: 'planning.handoff'; expectedGoalRevision: number; summary: string; frontier: string; memory?: PlannerMemoryInput }
  | { type: 'planning.checkpoint'; expectedGoalRevision: number; summary: string; frontier: string; memory?: PlannerMemoryInput }
  | { type: 'task.reviseGoal'; expectedGoalRevision: number; goal: GoalInput }
  | { type: 'task.control'; intent: 'pause' | 'resume' | 'cancel' | 'stop'; executionId?: string }
  | { type: 'task.priority'; priority: number }
  | { type: 'wait.answer'; waitId: string; answer: string }
  | { type: 'wait.resolve'; waitId: string; evidence: string }
  | { type: 'execution.bind'; actionId: string; executionId: string; agentId: string; sessionId: string; role: Role; model?: string; configurationVersion?: string; generation?: number }
  | { type: 'execution.report'; report: ExecutionReportInput }
  | { type: 'execution.requestHelp'; kind: 'mechanical' | 'user' | 'configuration' | 'resource'; operation: string; message: string; wait?: WaitSpec }
  | { type: 'execution.observed'; executionId: string; physicalState: PhysicalState; ownedJobIds?: string[] }
  | { type: 'execution.abandon'; executionId: string; evidence: string }
  | { type: 'incident.open'; executionId: string; operation: string; message: string }
  | { type: 'recovery.restart'; incidentId: string; evidence: string }
  | { type: 'recovery.legacy' }
  | { type: 'action.claim'; actionId: string; ownerId: string }
  | { type: 'action.finish'; actionId: string; evidence?: string; notificationId?: string }
  | { type: 'action.reconcile'; actionId: string; resolution: 'not_started' | 'completed' | 'unknown'; evidence: string; notificationId?: string }
  | { type: 'delivery.read' }
  | ArchiveTaskCommand
  | PurgeArchiveCommand
)

export interface KernelEnvironment { now: string; fingerprint: string; reviewEvery: number }
export interface Transition { task?: Task; receipt: CommandReceipt; changed: boolean }

