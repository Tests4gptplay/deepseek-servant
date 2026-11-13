import { helperDebugPath } from './helper-debug-path.js'
import { DshStorageAdapter } from '../adapters/dsh/storage.js'
import { prepareLocalConversation } from './local-upgrade-conversation.js'
import { reconstructPhysicalTask, type PhysicalRecoveredTaskPlan } from './physical-task-recovery.js'
import { publishPhysicalRecovery, retirePublishedPhysicalRecovery } from './physical-recovery.js'
import { hostRecoveryDebugPath, hostRecoverySignalPath } from './recovery-debug-record.js'
import { readTaskHistoryIdentity, readTaskReferenceIdentity } from './task-history.js'
import { PhysicalLocalFiles, LocalTaskRecordParentMissing } from './physical-local-files.js'
import { taskArchiveHostKey, taskArchiveStatePath, taskArchiveLifecycle, taskArchiveHostFacts, taskArchiveCleanup, taskMetadataRuntimeState, readTaskArchiveState, updateTaskArchiveState, type TaskArchiveState, type TaskArchiveHostFacts } from './task-archive.js'
import { GitRecordIndex } from './git-record-index.js'
import type { FrameworkInitialization } from './initialization-repair.js'
import { publishTaskResume } from './task-resume.js'
import { annotateFailure, type FailurePhase } from '../diagnostics/failure-details.js'
import { FrameworkTaskStateObservation } from './task-state-observation.js'
import { isAbsolute, join, resolve } from 'node:path'
import { TaskWorkspaces, type TaskWorkspaceLocation } from './task-workspace.js'
import { taskSourceName, taskWorkspaceFolder } from './workspace-paths.js'
import { DshForegroundProcessTracker, type DshForegroundProcessGroup } from '../adapters/dsh/foreground-process.js'
import { cancelTask } from './task-cancellation.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { GitAuthorityStore, listAuthorityInRound, type AuthorityContentFault, type AuthorityDiscoveryKey } from './git-authority.js'
import type { SafetyFault } from './safety-net.js'
import { assertWorkerBusiness, workerTransferPath, workerTransferRoot, type WorkerBusinessTransfer } from './worker-business.js'
import { createRoleErrorTurnContext, roleErrorOrigin, type RoleErrorOrigin, type RoleErrorResolution } from './role-error-origin.js'
import { linkedChild, taskFamily } from './task-relations.js'
import { DshAgentAdmissionClosed, DshAgentCreationCancelled } from '../adapters/dsh/host-types.js'
import { ensureForegroundActivity, type DshForegroundActivityReader } from '../adapters/dsh/foreground-activity.js'
import { GitHubError } from '../experimental/private-git/github.js'
import { nativeRecoveryWakeId, resolveNativeRecoveryInput } from './native-recovery-input.js'
import type { DshSessionInspection } from '../adapters/dsh/sessions.js'
import { FrameworkTaskIndex } from './task-index.js'
import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { StoragePort } from '../contracts/ports.js'
import type { FrameworkClientChange } from './client-contracts.js'
import { DshSessionReader, deriveNativeInputs } from '../adapters/dsh/sessions.js'
import { NativeCommandSuccess, directDeliveryCompleted } from './native-command-success.js'
import type { OwnedDshAgent } from '../adapters/dsh/host-types.js'
import { DshAgentGateway } from '../adapters/dsh/agents.js'
import { retireNativeSession } from '../adapters/dsh/native-cleaner.js'
import { retirePhysicalPublicationsFromEvents } from './physical-publication-retirement.js'
import { resumePhysicalWorkerTransfer, type PhysicalWorkerBusinessTransfer } from './physical-worker-transfer.js'
import { resumePhysicalHelperReportsFromEvents } from './physical-helper-report.js'
import { resumePhysicalDirectDelivery, retirePublishedDirectDelivery } from './physical-direct-delivery.js'
import type { DshModelRoute } from '../adapters/dsh/host-types.js'
import { NativeExecutions, pendingNativeStopJobs, type NativeStopEvidence, type StopResult } from './native-executions.js'
import { installFrameworkSkillProvider } from './skills.js'
import { FrameworkSkillCacheRefresh } from './skill-cache-refresh.js'
import { ExecutionControls, effectiveTaskStates, unreadTaskMetadata, type TaskControl, type ExecutionStopRequest } from './execution-control.js'
import { DurableObservationStore } from './observation-store.js'
import { ExecutionObservations, type ScheduledObservation } from './execution-observation.js'
import { FrameworkTransactions, gitCommandReceiptPath } from './command-transactions.js'
import type { ObservedInstance } from './instances.js'
import { FrameworkArtifacts } from './artifacts.js'
import { type CleanupRecord, FrameworkCleaner, type CleanupObservation, readTaskCleanupRecord } from './cleaner.js'
import { FrameworkConversation, isLocalConversationSignal, localForegroundRoleRecordPath, scopedLocalForegroundSourceNotification, type ConversationSend } from './conversation.js'
import { localUpgradeMappingKey, type LocalUpgradeMapping } from './local-upgrade-mapping.js'
import type { ManualConversationCleanupPreview } from './manual-cleanup.js'
import { FrameworkHostLoop, helperSignalWakeHash, type RoleWake, type TaskRoleNotification, type DirectRoleNotification } from './host-loop.js'
import { installFrameworkRoleTools, parseDirectSignal, signalWorkerId, workerPaths, type FrameworkRoleBinding, type FrameworkRoleServices, type PlannerWorkerExecutions, type HelperRestoreInput, type HelperRepairAttempt } from './role-tools.js'
import { foregroundTaskSignal, parseForegroundTaskSignal, taskArchiveOwnsPath, taskArchiveSelection, paths, readJson, readMemberStatus, taskIdentity, taskLifecycle, taskLifecycleKey, assertTaskLifecycle, isTerminalTask, encodeJson, type TaskMetadata, type MemberStatus } from './task-files.js'
import { FilesConflictError, FilesOutcomeUnknownError, GitFiles, withOperationChannel, withSnapshot, type FileChange, type FilesStore, type FilesSnapshot, type FilesReadRound } from './transactions.js'
import {
  scanMemberRecovery, memberRecoveryEligible, createRecoveryWatch, dueRecoveryWatch,
  type RecoveryWatch, type MemberRecoveryInput, type WorkIdentity, type RecoveryRole
} from './recovery.js'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
// AgentLoop emits runtime-context user messages even when the SessionEvent
// source union was loaded without AgentLoop's separate type augmentation.
const nativeSourceKind = (source: { kind: string } | undefined): string | undefined => source?.kind
interface TaskNotice { version: string; messageId: string; delivered: boolean }
interface TaskNoticeState { consumedAt: number; signals: Map<string, TaskNotice>; consumptions: Map<string, Map<string, { version: string; notices: Set<TaskNotice> }>> }
interface ClaimedNotificationContext { taskId?: string; signals: string[] }
interface NotificationClaim { helperWakes?: RoleWake[]; lifecycleId?: string; claimedNotifications?: ClaimedNotificationContext[]; commandId: string; executionId: string; wakeId: string; taskId?: string; initialSignals: string[]; sources: Array<{ path: string; version: string }> }
interface RoleRecord { foregroundCollaborationId?: string; nativeRetirements?: Array<{ sessionId: string; executionId: string; wakeId?: string; helper?: Pick<RoleRecord, 'delivery' | 'lastWake' | 'notificationClaims'> }>; taskWorkspace?: TaskWorkspaceLocation; notificationClaims?: Record<string, NotificationClaim>; businessTransferred?: boolean; foregroundOutputIds?: string[]; gitSettledWakeId?: string; identity: WorkIdentity; sessionId: string; generation: number; completedRound?: boolean; lastWake?: RoleWake; delivery?: { request: RoleWake; messageId: string; text?: string; confirmed: boolean; sequence?: number }; released?: boolean; stopped?: boolean; stopIntent?: NativeStopEvidence; stopUnknown?: { reason: string; jobs: string[] } }
interface TrackedStop { lifecycleId?: string; executionId: string; taskId?: string; promise: Promise<void>; settled: boolean; result?: StopResult; persistedStopped?: boolean; reportedFailure?: string; failure?: unknown; controlCommands?: Set<string> }
interface WakeRecovery {
  targetExecutionId?: string
  explanationText?: string
  confirmedStoppedExecutions?: string[]
  original?: NonNullable<RoleRecord['delivery']>
  /** Original Host wake had no native input yet; the continuation adopts it. */
  replacesUnadmittedWake?: string
}
interface WakeRecord { signalsConsumed?: boolean; helperSignal?: string; safetyAttempts?: Array<HelperRepairAttempt & { fault: SafetyFault; attemptId: string; displayOwner?: string }>; resolvedSafetyFaultIds?: string[]; safetyParentWakeId?: string; safetyFaults?: SafetyFault[]; request: RoleWake; delivered?: boolean; recovery?: WakeRecovery; admission?: { eligibleSince?: number; reportedAt?: number; diagnosticContext?: Record<string, unknown>; phase?: 'queued' | 'opening' | 'sending' | 'admitting'; executionId?: string } }
interface AdmissionControlPublication { task: TaskMetadata; intent: 'running' | 'paused' | 'cancelled'; records?: readonly TaskControl[]; terminal?: boolean }
interface LocalWakeAdmission { taskFacts?: Map<string, TaskMetadata>; pendingControl?: AdmissionControlPublication; wake: WakeRecord; eligibleSince?: number; reportedAt?: number; diagnosticContext?: Record<string, unknown>; accepted?: boolean; held?: boolean; eligibleKnown?: boolean; controlVersion?: number; ownershipHeld?: boolean; replayPending?: boolean; executionId?: string; phase?: NonNullable<WakeRecord['admission']>['phase'] }
interface SafetyRepairContext { safetyDisplayOwner?: string; safetyFaultIds?: string[]; safetyFaults?: SafetyFault[]; safetyKind?: 'target' | 'host'; safetyAttempt?: { failure: string; terminal: boolean } }
interface RoleRestore extends SafetyRepairContext { debugPath?: string; taskOwner?: { taskId: string; lifecycleId?: string }; commandId: string; createdAt: string; input: HelperRestoreInput; complete: boolean; resolvedTarget?: WorkIdentity; admissionWakeId?: string; continuationId?: string; outcome?: string }
interface HostRestore extends SafetyRepairContext { debugPath?: string; commandId: string; requester?: FrameworkRoleBinding; input: { facts: string; hypotheses: string; actionsTaken: string; continuation: string }; createdAt: string; complete: boolean; managerPublications?: Array<{ taskId: string; lifecycleId?: string; member: string; role: 'Planner' | 'Organizer' }>; targets?: Array<{ identity: WorkIdentity; sessionId: string; complete?: boolean; outcome?: 'superseded' | 'released' | 'user-stopped' | 'arranged' | 'no-continuation' }> }
interface ObservationRecord { pending: ScheduledObservation; complete: boolean; stopStarted?: boolean }
interface StartupRecoveryFacts { restoring: Set<string>; recovered: Set<string> }
interface RecoveryWatchRecord { markerVersion?: string; taskId?: string; lifecycleId?: string; member?: string; watch?: RecoveryWatch; released?: boolean }
export interface RuntimeConfiguration {
  scope: string
  instanceUUID?: string
  member: string
  primary: boolean
  workspace: string
  presetId?: string
  model?: DshModelRoute
  foreground?: DshModelRoute
  background?: DshModelRoute
  workerSeats: number
  mode: 'local' | 'git'
  collaborationId: string
}
export interface RuntimeEnvironment {
  sharedRecords?: StoragePort
  observationRecords?: StoragePort
  members(): readonly string[]
  /** The actual one-time restoration of this Task only; unrelated tasks never join it. */
  beforeTaskDiscovery?(task: TaskMetadata): Promise<boolean>
  beforeTaskUse?(taskId: string, wait?: boolean): Promise<boolean>
  initialization?: FrameworkInitialization
  resources(): readonly ObservedInstance[]
  heartbeat(snapshot?: FilesSnapshot): Promise<void>
  cancelPending?(reason?: unknown): void
  observeResources?(snapshot: FilesSnapshot): Promise<void>
  observationInterrupted?(): void
  /** Report original fault or native user-interaction facts to the owning Service. */
  error(error: unknown, origin?: RoleErrorOrigin, occurrence?: { source: string; occurrence: number }): void
  oldLocalControlRecovered?(taskId?: string): void
  retrySafetyDelivery?(): void
  safetyOccurrence?(): number
  safetyDisplayOwner?(): string
  safetyReplay?(fault: SafetyFault, result: { attemptId?: string; failure?: string; terminal?: boolean; displayOwner?: string }): void
  safetyResolved?(faultId: string): void
  safetyAttempted?(faultId: string, attemptId: string): void
  safetyAttemptFailed?(faultId: string, attemptId: string, error: unknown, terminal?: boolean): void
  changed?(change?: FrameworkClientChange): void
  restored?(): void
  resolved?(target: RoleErrorResolution): void
  capacity?(agent: Agent, input: { taskId: string; paths: string[] }, snapshot?: FilesSnapshot): Promise<unknown>
}

/** Host composition of durable scheduling, real native Agents and authoritative task files. */
export class FrameworkRoleRuntime {
  constructor(private readonly ctx: Context, readonly files: FilesStore, private readonly records: StoragePort,
    readonly config: RuntimeConfiguration, private readonly environment: RuntimeEnvironment) {
    this.taskStateObservation = new FrameworkTaskStateObservation(update => {
      if (!this.closed) environment.changed?.({ domain: 'task-state', mode: config.mode, collaborationId: config.collaborationId, storageScope: config.scope, update })
    }, error => this.error(error, { stage: 'task-state-projection' }), config.mode)
    this.foregroundActivity = typeof ctx.inject === 'function' ? ensureForegroundActivity(ctx) : undefined
    this.safetyBaseOccurrence = environment.safetyOccurrence?.() ?? 0
    this.prefix = 'framework-runtime/' + hash(config.scope) + '/'
    this.controls = new ExecutionControls(environment.sharedRecords ?? records, config.scope, undefined, files, records, config.instanceUUID,
      (error, taskId) => this.error(error, { stage: 'legacy-local-task-control', ...(taskId ? { taskId } : {}) }),
      taskId => environment.oldLocalControlRecovered?.(taskId))
    this.transactions = new FrameworkTransactions(files, records)
    this.conversation = new FrameworkConversation(files, this.transactions, { mode: config.mode, collaborationId: config.collaborationId }, path => this.physicalSignalSources(path),
      () => prepareLocalConversation(files, config.collaborationId, records))
    this.gateway = new DshAgentGateway(ctx)
    this.workspaces = new TaskWorkspaces(files, config.workspace, config.member, config.instanceUUID, this.archiveHostKey());
    this.observationStore = new DurableObservationStore(environment.observationRecords ?? records, config.scope,
      (identity, snapshot) => this.taskRuntimeReleased(identity, snapshot))
    this.observations = new ExecutionObservations(this.observationStore, { arrange: pending => this.enqueueObservation(pending) }, error => this.error(error))
    this.native = new NativeExecutions(ctx, this.gateway, this.observations, {
      save: async (evidence) => {
        const retired = this.retiredWorkers?.get(evidence.executionId)
        if (retired) { await this.saveRetiredWorker({ ...retired, stopIntent: evidence }, true); return }
        let record = this.roleRecords.get(evidence.workId)
        if (!record || record.identity.executionId !== evidence.executionId) throw new Error('Stop evidence no longer matches its execution.')
        if (evidence.phase === 'disposed') {
          const owned = this.native.get(evidence.workId, evidence.executionId)
          if (owned?.sessionId === evidence.sessionId) {
            if (record.delivery && !record.delivery.confirmed && owned.hasMessage(record.delivery.messageId)) {
              await this.saveRole({ ...record, delivery: { ...record.delivery, confirmed: true } }, false, 'confirm')
              record = this.roleRecords.get(evidence.workId);
            }
            await this.retainClosedRound(record!, owned)
            record = this.roleRecords.get(evidence.workId);
          }
        }
        await this.saveRole({ ...record!, stopIntent: evidence }, true)
      }
    });
    this.cleaner = new FrameworkCleaner(files, this.transactions)
    this.loop = new FrameworkHostLoop(files, this.transactions, records, config, () => environment.members(), {
      operation: work => this.safetyWork(work),
      physicalSignalSources: path => this.physicalSignalSources(path),
      workspaceRoot: taskId => this.workspaces.rootFor(taskId),
      restoreWorkspaces: initial => {
        for (const task of initial) this.workspaces.rememberRoot(task.taskId, task.workspace?.root ?? this.config.workspace)
      },
      releaseWorkspace: taskId => this.workspaces.release(taskId),
      initializeWorkspace: async task => {
        const location = await this.workspaces.bind(task.taskId)
        if (location) await this.workspaces.ensurePrepared(location)
      },
      wake: request => this.wake(request),
      routeForegroundSignals: async sources => {
        await this.legacyForegroundMigration
        return this.conversation.routeForegroundSignals(sources)
      },
      notifyForeground: async sources => {
        // Discovery owns the STATE observation, not the native persistence wait.
        // Reuse the single-flight maintenance owner for errors and shutdown drain.
        this.startMaintenance('foreground-notification', () => this.notifyForeground(sources))
      },
      notifyTask: async request => { this.scheduleTaskNotification(request) },
      notifyDirect: request => this.notifyDirect(request),
      admitDiscovered: async () => { this.startOwnedPump() },
      executing: (role, task, worker, direct) => this.executing(role, task, worker, direct),
      changed: () => environment.changed?.(),
      startup: () => this.safetyWork(() => this.startup()),
      observeLocal: round => this.safetyWork(async () => {
        this.retryRetiredWorkers(); this.recheckUnavailableSafetyTargets()
        // Mechanical admission timing never joins remote discovery or publication.
        // Normal discovery refreshes locally observed facts independently.
        this.checkWakeAdmissions()
        this.startMaintenance('wake-admission-observation', () => this.observeWakeAdmissions(round))
        this.continueInitialization()
        this.startRestoration(round)
        await this.observations.tick(false)
        if (!this.closed) this.startMaintenance('native-observation-discovery', () => this.processObservations(false, 'native', false, round))
      }),
      observe: (round, observation) => this.observe(round, observation),
      readRoundStarted: (round: object) => { this.taskNoticeObservations.set(round, this.taskNoticeClock); this.taskStateObservation?.begin(round) },
      ...(this.taskStateObservation ? {
        taskStateEntries: (entries: readonly import('./transactions.js').FileEntry[], snapshot: FilesSnapshot, round: object) => {
          this.taskMetadataIndex?.invalidate(entries)
          // A blob change may only add another Host's workspace. The pending
          // wake retains its already-observed relationship, not an inferred
          // deletion of that relationship while the original reread is pending.
          this.taskStateObservation!.listed(round, snapshot.revision, entries)
        },
        taskStateObserved: async (task: TaskMetadata, snapshot: FilesSnapshot, round: object) => {
          await this.recheckAdmissionControls()
          if (!(this.files instanceof PhysicalLocalFiles)) return this.taskStateObservation!.task(round, snapshot.revision, task)
          // Display owns its own short-lived read. The business Task lane must
          // reach discovery/Cleaner without waiting for a control publication.
          this.observeLocalTaskState(task, snapshot.revision, round)
        },
      } : {}),
      discoverTask: async (task, snapshot) => {
        if (await environment.beforeTaskDiscovery?.(task) === false) return false;
        this.rememberTerminalTask(task);
        this.applyTaskArchiveFacts(task.taskId, task.lifecycleId, await this.taskSealAt(snapshot, task.taskId, task.lifecycleId))
        for (const record of this.roleRecords.values()) if (record.identity.taskId === task.taskId && taskLifecycle(record.identity) !== taskLifecycle(task) && !record.stopped) this.trackedStop(record);
        await this.reconcileWorkerTransfers(false, snapshot, task.taskId)
        await this.observeRecoveryMarkers(snapshot, [task], false)
      },
      discoveryInterrupted: () => environment.observationInterrupted?.(),
      error: (error, role) => this.error(error, role ? { role, stage: 'state-discovery' } : undefined),
      sealBusiness: (task) => {
        this.rememberTerminalTask(task);
        return this.sealBusiness(task.taskId, task.lifecycleId);
      },
      cancelledBusinessStopped: (task) => this.cancelledBusinessStopped(task),
      clean: (task, snapshot, observation) => this.clean(task, snapshot, observation),
      releaseTask: (taskId, lifecycleId, selected) => this.releaseLocalTask(taskId, lifecycleId, selected)
    });
  }
  private readonly taskStateObservation?: FrameworkTaskStateObservation
  taskStateViewBoundary() { return this.taskStateObservation?.viewBoundary() }
  readonly controls: ExecutionControls
  readonly transactions: FrameworkTransactions
  readonly conversation: FrameworkConversation
  readonly observations: ExecutionObservations
  readonly native: NativeExecutions
  readonly loop: FrameworkHostLoop
  readonly cleaner: FrameworkCleaner
  readonly workspaces: TaskWorkspaces;
  private readonly foregroundActivity?: DshForegroundActivityReader
  private readonly foregroundProcesses = new Map<string, DshForegroundProcessTracker>();
  private foregroundProcessWrites?: Map<string, { promise: Promise<void>; retry: () => Promise<void>; signature: string; pending: boolean }>;
  private readonly gateway: DshAgentGateway
  private readonly observationStore: DurableObservationStore
  private readonly prefix: string
  private readonly roleRecords = new Map<string, RoleRecord>()
  private legacyForegroundMigration?: Promise<void>
  private roleBases?: Map<string, RoleRecord>
  private notificationClaimWrites = new Map<string, Promise<unknown>>()
  private notificationContextRetries = new Map<string, { executionId: string; run: () => Promise<void>; retire: (executionId: string) => Promise<void> }>()
  private readonly gitPriorExecutions = new Set<string>()
  private readonly safetyContext = new AsyncLocalStorage<number>()
  private readonly safetyBaseOccurrence: number
  private readonly safetyEpisodes = new Map<string, { fault: SafetyFault; helperWakeId?: string; commands: Set<string>; settled?: boolean }>()
  private readonly safetyReplayed = new Set<string>()
  private readonly safetySettlements = new Map<string, Promise<void>>()
  private readonly restoreWriteOwners = new Map<string, { taskId: string; lifecycleId?: string; write?: Promise<void> }>()
  private readonly safetyRestoreWrites = new Map<string, Promise<void>>()
  private safetyResolutionReady = true
  private safetyResolutionLoad?: Promise<void>
  private skipInitialSealedPass = false
  private readonly resolvedSafetyFaultIds = new Set<string>()
  private readonly unavailableSafetyTargets = new Map<string, SafetyFault>()
  private readonly safetyRequests = new Map<string, Promise<void>>()
  private readonly safetyErrorOccurrences = new WeakMap<object, number>()
  private nativeRetirementOperations?: Map<string, Promise<void>>
  private retiredWorkOperations?: Set<Promise<unknown>>
  private retiredWorkers?: Map<string, RoleRecord>
  private workerDrains?: Map<string, Promise<void>>
  private readonly wakeConsumptions = new Map<string, { wakeId: string; promise: Promise<{ signals: string[] }>; completed: boolean }>()
  private stopOperations?: Map<string, TrackedStop>
  private pumping?: Promise<void>
  private queueing?: Promise<void>
  private admissions?: Map<string, Promise<void>>
  private workerAdmissions?: Set<string>
  private workerAdmissionTasks?: Map<string, string>
  private observationOperations?: Map<string, Promise<void>>
  private maintenance?: Map<string, Promise<void>>
  /** Only original startup responsibilities still awaiting their own import. */
  private startupRecoveryFacts?: StartupRecoveryFacts
  private pendingStartupTasks?: Map<string, StartupRecoveryFacts>
  private completedStartupTasks?: Set<string>
  private restoring?: Promise<void>
  private restoreScanning?: Promise<void>
  private hostRestoring?: Promise<void>
  private restoreOperations?: Map<string, Promise<void>>
  private coldRoleRestoreRetirement = true
  private coldHostRestoreRetirement = true
  private readonly targetedPumps = new Map<string, Promise<void>>()
  private readonly admissionCancellations = new Map<string, unknown>()
  // Read-through view of existing Task Helper WakeRecords; no extra file or poll.
  private readonly taskHelperWakes = new Map<string, WakeRecord>()
  private readonly wakeWriteOwners = new Map<string, RoleWake>()
  private readonly roleWriteOwners = new Map<string, WorkIdentity>()
  private readonly wakeWrites = new Map<string, Promise<unknown>>()
  private admissionNow = () => Date.now()
  private readonly localWakeAdmissions = new Map<string, LocalWakeAdmission>()
  private admissionObservationVersion = 0
  private readonly conversationSendSources = new Map<string, { createdAt: string; model?: string }>()
  private closed = false
  private readonly bootId = randomUUID()
  private readonly ownedAsyncContext = AsyncLocalStorage.snapshot();
  private taskMetadataIndex?: FrameworkTaskIndex
  private readonly knownTaskLifecycles = new Map<string, string>();
  private readonly observedTerminalTasks = new Map<string, 'complete' | 'cancelled'>();
  private readonly skillProviders = new Map<string, ReturnType<typeof installFrameworkSkillProvider>>()
  private skillCacheRefresh?: FrameworkSkillCacheRefresh
  private workOperations?: Map<string, Promise<unknown>>
  private pendingForegroundResets?: Set<string>
  private readonly observationRecordWrites = new Map<string, { identity: WorkIdentity; promise: Promise<ObservationRecord> }>()
  private roleWrites?: Map<string, Promise<void>>
  private recoveryWatchWrites?: Map<string, Promise<unknown>>
  private disposing?: Promise<void>
  private shutdownReason?: DOMException
  async previewForegroundReset(): Promise<Pick<ManualConversationCleanupPreview, 'foreground' | 'processSessionIds' | 'wakeKeys'>> {
    if (this.config.mode !== 'local') throw new Error('Foreground history reset requires Local storage.')
    const workId = this.roleKey('Foreground')
    return this.serialWork(workId, async () => {
      const stored = await this.records.get<RoleRecord>(this.roleRecordPath(workId))
      const target = this.roleRecords.get(workId) ?? (stored?.released ? undefined : stored)
      const wakes = (await this.records.list<WakeRecord>(this.prefix + 'wakes/'))
        .filter(row => this.requestKey(row.value.request) === workId)
      return { ...(target ? { foreground: { executionId: target.identity.executionId,
          sessionId: target.sessionId, generation: target.generation } } : {}),
        processSessionIds: [...new Set([...this.foregroundProcessWrites?.keys() ?? [], ...target ? [target.sessionId] : []])],
        wakeKeys: wakes.map(row => row.key) }
    })
  }
  /** Read the existing native reset lifecycle; manual cleanup does not create a
   * second completed-command history merely to retire its temporary selection. */
  async isForegroundResetComplete(commandId: string): Promise<boolean> {
    if (this.config.mode !== 'local' || !commandId) throw new Error('Foreground history reset requires an explicit Local command.')
    const reset = await this.records.get<{ commandId: string; phase: string }>(this.prefix + 'foreground-resets/' + hash(commandId))
    if (reset && reset.commandId !== commandId) throw new Error('Foreground reset belongs to another command.')
    return reset?.phase === 'complete'
  }
  async withForegroundReset<T>(commandId: string, action: (capturedMessageIds?: readonly string[], capturedProcessGroupIds?: readonly string[]) => Promise<T>, selection?: ManualConversationCleanupPreview): Promise<T> {
    type Reset = {
      processSessionIds?: string[]; capturedProcessGroupIds?: string[]; commandId: string; phase: 'planned' | 'retired' | 'complete'; target?: RoleRecord;
      wakeKeys: string[]; pendingTasks: RoleWake[]; capturedMessageIds?: string[]; requestSelection?: true
    }

    if (this.config.mode !== 'local' || !commandId) throw new Error('Foreground history reset requires an explicit Local command.')
    const workId = this.roleKey('Foreground'), key = this.prefix + 'foreground-resets/' + hash(commandId)
    return this.serialWork(workId, async () => {
      let reset = await this.records.get<Reset>(key)
      if (!reset) {
        const stored = await this.records.get<RoleRecord>(this.roleRecordPath(workId))
        const current = this.roleRecords.get(workId) ?? (stored?.released ? undefined : stored)
        const reviewedSignals = new Set(selection?.messageIds.flatMap(row => row.notification ? [row.notification] : []) ?? [])
        const ownsReviewedInput = current && reviewedSignals.size > 0 && [
          ...current.delivery?.request.sources ?? [], ...current.lastWake?.sources ?? [],
          ...Object.values(current.notificationClaims ?? {}).flatMap(claim => claim.sources)
        ].some(source => reviewedSignals.has(source.path))
        const target = selection ? current && (selection.foreground
          ? current.identity.executionId === selection.foreground.executionId
            && current.sessionId === selection.foreground.sessionId
            && current.generation === selection.foreground.generation
          : ownsReviewedInput) ? current : undefined : current
        const wakes = (await this.records.list<WakeRecord>(this.prefix + 'wakes/'))
          .filter(row => this.requestKey(row.value.request) === workId && (!selection || selection.wakeKeys.includes(row.key))
            && (!selection || !row.value.delivered))
        const pendingTasks = new Map<string, RoleWake>()
        for (const row of wakes) if (!row.value.delivered && row.value.request.taskId) pendingTasks.set(row.value.request.taskId, row.value.request)
        const prior = target?.delivery?.request ?? target?.lastWake
        if (prior?.taskId && !target?.completedRound) pendingTasks.set(prior.taskId, prior)
        reset = {
          commandId,
          phase: 'planned',
          ...(selection ? { requestSelection: true as const } : {}),
          ...(target ? { target } : {}),
          processSessionIds: selection ? [...new Set([...selection.processSessionIds, ...target ? [target.sessionId] : []])]
            : [.../* @__PURE__ */ new Set([...this.foregroundProcessWrites?.keys() ?? [], ...target ? [target.sessionId] : []])],
          wakeKeys: wakes.map(row => row.key),
          pendingTasks: [...pendingTasks.values()]
        };
        await this.records.set(key, reset)
      }
      const pendingResets = this.pendingForegroundResets ??= new Set()
      if (reset.phase !== 'complete') pendingResets.add(commandId)
      else pendingResets.delete(commandId)
      if (reset.phase === 'planned') {
        if (reset.target) {
          const stored = await this.records.get<RoleRecord>(this.roleRecordPath(workId))
          const current = this.roleRecords.get(workId) ?? stored
          if (current && current.identity.executionId !== reset.target.identity.executionId) throw new Error('The Foreground reset target changed before its retirement was confirmed.')
          if (current && !current.released) {
            this.roleRecords.set(workId, current)
            if (current === stored && stored) (this.roleBases ??= new Map()).set(workId, structuredClone(stored))
            if (!current.stopped) {
              await this.finishForegroundRound(current)
              const result = await this.stopOwnedRecord(this.roleRecords.get(workId) ?? current)
              if (result.status !== 'stopped') throw new Error(result.status === 'unconfirmed' ? result.reason : 'Foreground ownership changed while clearing its history.')
            }
            // The exact producer owns confirmed output indexing even when its
            // auxiliary save failed. Capture only after its existing tail settles;
            // the reset record and released-role save below persist this selection.
            await this.roleWrites?.get(workId)?.catch(() => {})
            const stopped = this.roleRecords.get(workId) ?? current
            const capturedMessageIds = stopped.foregroundOutputIds ?? []
            const pendingTasks = new Map(reset.pendingTasks.map(prior => [prior.taskId, prior]))
            if (selection) for (const prior of await this.pendingClaimedForegroundTasks(stopped))
              if (!pendingTasks.has(prior.taskId)) pendingTasks.set(prior.taskId, prior)
            reset = { ...reset, capturedMessageIds, pendingTasks: [...pendingTasks.values()] }
            await this.records.set(key, reset)
            if (selection) await this.republishClaimedLaterConversation(selection, stopped)
            await this.saveRole({ ...stopped, stopped: true, released: true })
            this.roleRecords.delete(workId)
          }
        }
        const processSessions = reset.processSessionIds ?? (reset.target ? [reset.target.sessionId] : []);
        for (const sessionId of processSessions) await this.flushForegroundProcessWrites(sessionId);
        const capturedProcessGroupIds = (await this.conversation.processGroupsForForegroundReset()).filter((group) => {
          try {
            return processSessions.includes(JSON.parse(group.turnId)[0]);
          } catch {
            return false;
          }
        }).map((group) => group.id) ?? [];
        reset = { ...reset, processSessionIds: processSessions, capturedProcessGroupIds };
        await this.records.set(key, reset)
        for (const wakeKey of reset.wakeKeys) {
          const wake = await this.records.get<WakeRecord>(wakeKey)
          if (wake) await this.updateWake(wakeKey, current => current ? { ...current, delivered: true, admission: undefined } : undefined)
        }
        for (const prior of reset.pendingTasks) await this.wake({
          id: 'history-reset-delivery:' + hash(commandId + '\0' + prior.taskId),
          role: 'Foreground', taskId: prior.taskId, ...(prior.lifecycleId ? { lifecycleId: prior.lifecycleId } : {}), reason: 'business-complete', sources: [],
          context: { facts: 'Conversation history was explicitly cleared. Inspect this Task and its retained result; deliver only any result still pending in the new conversation.' }
        })
        if (reset.requestSelection && reset.target?.delivery?.request.id) await this.retireCompletedForegroundWake(reset.target.delivery.request.id)
        reset = { ...reset, phase: 'retired' }
        await this.records.set(key, reset)
      }
      const result = await action(reset.capturedMessageIds ?? [], reset.capturedProcessGroupIds ?? []);
      if (reset.phase !== 'complete') await this.records.set(key, { commandId, phase: 'complete',
        ...(reset.requestSelection ? { requestSelection: true } : {}) })
      pendingResets.delete(commandId)
      return result
    });
  }
  async retireForegroundResetComplete(commandId: string): Promise<void> {
    const key = this.prefix + 'foreground-resets/' + hash(commandId)
    const reset = await this.records.get<{ commandId: string; phase: string; requestSelection?: true }>(key)
    if (!reset || !reset.requestSelection) return
    if (reset.commandId !== commandId || reset.phase !== 'complete') throw new Error('Original Foreground reset is not complete.')
    if (!this.records.delete) throw new Error('Runtime storage cannot retire the completed reset.')
    await this.records.delete(key)
  }
  private async pendingClaimedForegroundTasks(owner: RoleRecord): Promise<RoleWake[]> {
    if (!(this.files instanceof PhysicalLocalFiles)) return []
    const taskIds = new Set<string>()
    for (const claim of Object.values(owner.notificationClaims ?? {})) for (const source of claim.sources) {
      const taskId = parseForegroundTaskSignal(source.path)
      if (!taskId) continue
      if (foregroundTaskSignal(taskId) === source.path) taskIds.add(taskId)
    }
    return withSnapshot(this.files, async snapshot => {
      const requests: RoleWake[] = []
      for (const taskId of taskIds) {
        const task = await readTaskReferenceIdentity(this.files, snapshot, taskId)
        if (!task || task.parent) throw new Error('Claimed Foreground Task result lacks its original root identity: ' + taskId)
        requests.push({ id: 'history-reset-claimed-task:' + taskId, role: 'Foreground', taskId,
          ...(task.lifecycleId ? { lifecycleId: task.lifecycleId } : {}), reason: 'business-complete', sources: [] })
      }
      return requests
    })
  }
  private async republishClaimedLaterConversation(selection: ManualConversationCleanupPreview, owner: RoleRecord): Promise<void> {
    if (!(this.files instanceof PhysicalLocalFiles)) return
    const files = this.files
    const claimed = new Set(Object.values(owner.notificationClaims ?? {}).flatMap(claim => claim.sources.map(source => source.path)))
    if (!claimed.size) return
    const reviewed = new Set(selection.messageIds.map(row => row.id))
    await this.conversation.withPhysicalPublication(async snapshot => {
      const index = await readJson<{ messages: Array<{ id: string; path: string; role?: string; replyTo?: string; notification?: string }> }>(
        this.files, snapshot, this.conversation.indexPath)
      const candidates = (index?.messages ?? []).filter(row => row.role === 'user' && !reviewed.has(row.id)
        && !!row.notification && claimed.has(row.notification))
      if (!candidates.length) return
      const candidateIds = new Set(candidates.map(row => row.id))
      const confirmedOutputIds = new Set(owner.foregroundOutputIds ?? [])
      const finallyReplied = new Set<string>()
      for (const row of index?.messages ?? []) if (row.role === 'assistant' && row.replyTo
        && candidateIds.has(row.replyTo) && confirmedOutputIds.has(row.id)) {
        const entry = await readJson<{ id: string; role: string; replyTo?: string; responsePhase?: string }>(this.files, snapshot, row.path)
        if (entry?.id === row.id && entry.role === 'assistant' && entry.replyTo === row.replyTo && entry.responsePhase === 'final')
          finallyReplied.add(row.replyTo)
      }
      const selected: string[] = []
      for (const row of candidates) {
        if (finallyReplied.has(row.id)) continue
        const entry = await readJson<{ id: string; role: string; recipient?: string }>(this.files, snapshot, row.path)
        if (entry?.id === row.id && entry.role === 'user' && entry.recipient === 'ai'
          && /^state\/Foreground_[^/]+$/.test(row.notification!)) selected.push(row.notification!)
      }
      for (const path of selected) await files.createIfAbsent(path, '')
    })
  }
  private async recoverForegroundResetRows(): Promise<void> {
    const rows = await this.records.list<{ commandId: string; phase: string; requestSelection?: true }>(this.prefix + 'foreground-resets/')
    this.pendingForegroundResets = new Set(rows.filter(row => row.value.phase !== 'complete').map(row => row.value.commandId))
    if (!(this.files instanceof PhysicalLocalFiles)) return
    for (const row of rows) if (row.value.phase === 'complete' && row.value.requestSelection) {
      try {
        const intentPath = 'technical/manual-cleanup/intents/' + hash(JSON.stringify(this.conversation.scope) + '\0' + row.value.commandId) + '.json'
        const pending = await withSnapshot(this.files, snapshot => this.files.read(snapshot, intentPath))
        if (pending === undefined && this.records.delete) await this.records.delete(row.key)
      } catch (error) { this.error(error) }
    }
  }
  private async manuallyCleared(taskId: string | undefined, snapshot?: FilesSnapshot): Promise<boolean> {
    if (!taskId || this.config.mode !== 'local') return false
    const read = async (view: FilesSnapshot) => {
      const value = await readTaskCleanupRecord(this.files, view, taskId)
      if (value?.version !== 1 || value.taskId !== taskId || value.historyCleared !== true) return false;
      const task = await readJson<TaskMetadata>(this.files, view, paths.task(taskId));
      return !task || taskLifecycle(task) === taskLifecycle(value);
    };
    return snapshot ? read(snapshot) : withSnapshot(this.files, read)
  }
  taskCleanupComplete(taskId: string, lifecycleId?: string): Promise<boolean> {
    return this.loop.taskReleased(taskId, lifecycleId)
  }
  async prepareTaskCleanup(taskId: string): Promise<void> {
    if (this.config.mode !== 'local') throw new Error('Manual task history cleanup is Local only.')
    const currentTask = await withSnapshot(this.files, async (snapshot) => {
      const task = await readJson<TaskMetadata>(this.files, snapshot, paths.task(taskId))
      if (!task) return false
      for (const child of (await taskFamily(this.files, snapshot, taskId)).slice(1)) {
        const released = await readTaskCleanupRecord(this.files, snapshot, child.taskId)
        if (!released || released.version !== 1 || released.taskId !== child.taskId || taskLifecycle(released) !== taskLifecycle(child)
          || !await this.taskCleanupComplete(child.taskId, child.lifecycleId)) throw new Error('Associated child Task history must be released before clearing its parent: ' + child.taskId)
      }
      if (await this.manuallyCleared(taskId, snapshot)) return 'released'
      const cleanup = await readTaskCleanupRecord(this.files, snapshot, taskId)
      if (!isTerminalTask(task) || cleanup?.version !== 1 || cleanup.taskId !== taskId || taskLifecycle(cleanup) !== taskLifecycle(task)
        || !await this.taskCleanupComplete(taskId, task.lifecycleId)) {
        throw new Error('Task history cleanup requires its actual completed and released task.')
      }
      return true;
    });
    if (!currentTask) {
      const records = await this.records.list<RoleRecord>(this.prefix + 'roles/')
      if (records.some(row => row.value.identity.taskId === taskId && !row.value.released)
        || [...this.roleRecords.values()].some(record => record.identity.taskId === taskId && !record.released)) {
        throw new Error('Retained legacy history still has an owned execution responsibility.')
      }
      return
    }
    for (const row of await this.records.list<RoleRecord>(this.prefix + 'roles/')) {
      if (row.value.identity.taskId === taskId && !row.value.released && !this.roleRecords.has(row.value.identity.workId)) {
        this.roleRecords.set(row.value.identity.workId, row.value)
          ; (this.roleBases ??= new Map()).set(row.value.identity.workId, structuredClone(row.value))
      }
    }
    for (const record of this.roleRecords.values()) if (currentTask === 'released' && record.identity.role === 'Organizer' && await this.currentTask(record) === taskId) {
      if (!record.stopped || this.active(record)) throw new Error('Organizer producer is not confirmed stopped for this Task.')
      await this.observations.unbind(record.identity.workId, record.identity.executionId)
    }
    await this.releaseLocalTask(taskId)
  }
  updateWorkerSeats(workerSeats: number): void {
    if (!Number.isSafeInteger(workerSeats) || workerSeats < 0) throw new Error('Worker seats must be a nonnegative integer.')
    this.config.workerSeats = workerSeats
  }
  start(): Promise<void> {
    // Startup creates the background Host driver and its timers. A user action
    // that starts it must not donate its Foreground or refresh transport lane.
    return withOperationChannel(this.files, 'read', () => this.startInChannel())
  }
  private async startInChannel(): Promise<void> {
    if (this.closed) throw new Error('Framework runtime is disposed.')
    const roles = await this.discoverRoles('roles/')
    if (this.config.mode === 'local' && this.files instanceof PhysicalLocalFiles) {
      const oldKey = this.prefix + 'roles/' + hash(this.roleKey('Foreground'))
      const currentKey = this.roleRecordPath(this.roleKey('Foreground'))
      const old = roles.find(row => row.key === oldKey && row.value.identity.role === 'Foreground')
      const current = roles.find(row => row.key === currentKey)
      if (old && !old.value.released && (!current || current.value.identity.executionId === old.value.identity.executionId
        && current.value.sessionId === old.value.sessionId)) {
        this.legacyForegroundMigration = this.migrateLegacyForegroundRole(old.value).then(migrated => {
          if (!migrated || current || this.closed) return
          const workId = migrated.identity.workId
          ; (this.roleBases ??= new Map()).set(workId, structuredClone(migrated))
          this.roleRecords.set(workId, migrated)
          this.continueNativeRetirements(migrated)
          this.startRestoration()
          // The boot recovery pass may have finished before this legacy row's
          // Session could identify its original collaboration. Revisit only
          // this accepted execution, in its own Task lane when it has one.
          this.startMaintenance('legacy-foreground-recovery', async () => {
            const taskId = await this.currentTask(migrated)
            if (!await this.beforeTaskUse(taskId) || this.closed) return
            await this.startupRecovery({ taskId, workId, foregroundOnly: true, facts: await this.readStartupRecoveryFacts() })
          }, { role: 'Foreground', stage: 'legacy-foreground-recovery' })
          this.startOwnedPump()
        }).catch(error => this.error(error, { role: 'Foreground', stage: 'legacy-foreground-role-migration' }))
      }
    }
    for (const row of roles) {
      if (this.config.mode === 'local' && row.value.identity.role === 'Foreground'
        && row.key !== this.roleRecordPath(this.roleKey('Foreground'))) continue
      ; (this.roleBases ??= new Map()).set(row.value.identity.workId, structuredClone(row.value))
      this.continueNativeRetirements(row.value)
      if (row.value.released) continue
      if (row.value.taskWorkspace) this.workspaces.remember(row.value.taskWorkspace)
      this.roleRecords.set(row.value.identity.workId, row.value)
      if (this.config.mode === 'git' && !row.value.stopped) this.gitPriorExecutions.add(row.value.identity.executionId)
    }
    await this.recoverForegroundResetRows()
    if (this.closed) throw new Error('Framework runtime is disposed.')
    for (const row of await this.discoverRoles('retired-workers/')) {
      this.retiredWorkers ??= new Map(); this.retiredWorkers.set(row.value.identity.executionId, row.value)
      this.continueNativeRetirements(row.value, true)
    }
    await this.reconcileWorkerTransfers(true)
    this.continueInitialization()
    await this.loop.start()
  }
  /** Only an unresolved pre-scope Foreground row reaches this known native
   * Session. Its original Host binding was written as an uninterpolated system
   * section, before any model text, with this exact execution identity. */
  private async legacyForegroundSessionDomain(record: RoleRecord): Promise<string | undefined> {
    const domains = new Set<string>()
    for (const event of await new DshSessionReader(this.ctx).events(record.sessionId)) {
      if (event.type !== 'system/message') continue
      for (const block of event.data.message.content) {
        if (block.type !== 'text') continue
        for (const match of block.text.matchAll(/Current role and source locations: (\{[^\r\n]+\})/g)) {
          let binding: Record<string, unknown>
          try { binding = JSON.parse(match[1]!) } catch { continue }
          const domain = binding.collaborationId
          if (binding.workId !== record.identity.workId || binding.executionId !== record.identity.executionId
            || binding.role !== 'Foreground' || typeof domain !== 'string'
            || binding.recordPath !== 'assistants/collaborations/local/' + encodeURIComponent(domain) + '/Foreground_Cache.md') continue
          domains.add(domain)
        }
      }
    }
    return domains.size === 1 ? [...domains][0] : undefined
  }
  /** A pre-scope Local row can be continued only from its original addressed
   * conversation facts. Copy the intact native identity, then retire the old
   * row; a crash between writes leaves the scoped copy authoritative and the
   * old source available for an idempotent retirement on the next start. */
  private async migrateLegacyForegroundRole(original: RoleRecord): Promise<RoleRecord | undefined> {
    if (!(this.files instanceof PhysicalLocalFiles) || !this.records.delete) return
    const paths = [...new Set([
      ...original.delivery?.request.sources.map(source => source.path) ?? [],
      ...original.lastWake?.sources.map(source => source.path) ?? [],
      ...Object.values(original.notificationClaims ?? {}).flatMap(claim => [...claim.initialSignals, ...claim.sources.map(source => source.path)])
    ].filter(path => isLocalConversationSignal(path) && !parseForegroundTaskSignal(path)))]
    const sessionDomain = await this.legacyForegroundSessionDomain(original)
    // A pre-fix B execution could itself have accepted A's global signal.
    // The source owner never substitutes for the original native binding.
    if (sessionDomain === undefined) {
      if (!original.completedRound) this.error(new Error('An older Local Foreground execution has no saved collaboration binding. Its Session and original notifications were retained without claiming a collaboration.'),
        { identity: original.identity, sessionId: original.sessionId, stage: 'legacy-foreground-unbound' })
      return
    }
    if (sessionDomain !== this.config.collaborationId) return
    const routed = new Set((await this.conversation.routeForegroundSignals(paths.map(path => ({ path })))).map(source => source.path))
    const redirected = new Map<string, { path: string; version: string }>()
    for (const path of paths) {
      if (routed.has(path)) continue
      const alias = scopedLocalForegroundSourceNotification(path, this.config.collaborationId)
      const mapping = await this.records.get<LocalUpgradeMapping>(localUpgradeMappingKey(this.files.directory, path))
      if (mapping?.kind !== 'dss-once-source-mapping' || mapping.directory !== this.files.directory
        || mapping.sourcePath !== path || mapping.disposition !== 'converted' || !mapping.operationId
        || !mapping.targets.includes(alias)) {
        continue
      }
      const actual = await this.files.fileMetadata(alias)
      if (actual) redirected.set(path, { path: alias, version: actual.version })
    }
    const migrated = structuredClone(original)
    const source = (value: { path: string; version: string }) => redirected.get(value.path) ?? value
    const signal = (value: string) => redirected.get(value)?.path ?? value
    if (migrated.delivery) migrated.delivery.request.sources = migrated.delivery.request.sources.map(source)
    if (migrated.lastWake) migrated.lastWake.sources = migrated.lastWake.sources.map(source)
    for (const claim of Object.values(migrated.notificationClaims ?? {})) {
      claim.sources = claim.sources.map(source)
      claim.initialSignals = claim.initialSignals.map(signal)
      if (claim.claimedNotifications) claim.claimedNotifications = claim.claimedNotifications.map(context =>
        ({ ...context, signals: context.signals.map(signal) }))
    }
    migrated.foregroundCollaborationId = this.config.collaborationId
    const currentKey = this.roleRecordPath(this.roleKey('Foreground'))
    const existing = await this.records.get<RoleRecord>(currentKey)
    if (existing && (existing.identity.executionId !== migrated.identity.executionId || existing.sessionId !== migrated.sessionId)) return
    if (!existing) await this.records.set(currentKey, migrated)
    await this.records.delete(this.prefix + 'roles/' + hash(this.roleKey('Foreground')))
    return existing ?? migrated
  }
  /** Validate only the identity needed to use a persisted native responsibility.
   * This does not admit business, require a Task tree or infer session ownership. */
  private roleRecordProblem(key: string, value: unknown): string | undefined {
    const record = value as RoleRecord | undefined, identity = record?.identity
    const text = (value: unknown): value is string => typeof value === 'string' && !!value && !value.includes('\0')
    if (!identity || !text(identity.workId) || !text(identity.executionId)
      || !['Foreground', 'Organizer', 'Planner', 'Worker', 'Recorder', 'Helper'].includes(identity.role)
      || !text(record?.sessionId) || !Number.isSafeInteger(record?.generation) || record!.generation < 1)
      return 'Native role identity, session or generation is malformed.'
    if (['stopped', 'released', 'businessTransferred'].some(field => {
      const flag = record![field as 'stopped' | 'released' | 'businessTransferred']
      return flag !== undefined && typeof flag !== 'boolean'
    })) return 'Native role stop or release marker is malformed.'
    if (['taskId', 'lifecycleId'].some(field => {
      const item = identity[field as keyof WorkIdentity]
      return item !== undefined && (typeof item !== 'string' || item.includes('\0'))
    })) return 'Native role task identity is malformed.'
    const expected = key.startsWith(this.prefix + 'retired-workers/')
      ? this.prefix + 'retired-workers/' + identity.executionId : this.prefix + 'roles/' + hash(identity.workId)
    const scoped = this.config.mode === 'local' && identity.role === 'Foreground'
      && typeof record?.foregroundCollaborationId === 'string'
      && key === localForegroundRoleRecordPath(this.config.scope, record.foregroundCollaborationId)
    if (key !== expected && !scoped) return 'Native role record path does not match its identity.'
  }
  private roleTaskGroups(value: unknown): string[] {
    const record = value as RoleRecord | undefined, identity = record?.identity
    const taskId = identity?.taskId
    const groups: string[] = []
    if (typeof taskId === 'string' && taskId && !taskId.includes('\0')) {
      const lifecycle = identity!.lifecycleId
      groups.push(lifecycle === undefined || typeof lifecycle === 'string' && !lifecycle.includes('\0')
        ? taskLifecycleKey({ taskId, lifecycleId: lifecycle }) : 'malformed-task:' + taskId)
    }
    return [...new Set(groups)]
  }
  private reportRoleContentFault(fault: AuthorityContentFault): readonly string[] {
    const groups = this.roleTaskGroups(fault.value)
    const record = fault.value as RoleRecord | undefined, identity = record?.identity
    this.error(new Error('Malformed role authority at ' + fault.path + ': ' + fault.reason), {
      stage: 'role-discovery', path: fault.path, ...(fault.key ? { key: fault.key } : {}),
      roleAuthorityContent: fault.contentVersion ?? hash(JSON.stringify(fault.value) ?? 'undefined'),
      taskGroups: groups,
      // These are diagnostic clues, not an executable identity or a stop command.
      nativeReferences: Object.fromEntries(Object.entries({ workId: identity?.workId, executionId: identity?.executionId, sessionId: record?.sessionId })
        .filter(([, value]) => typeof value === 'string')),
    })
    return groups
  }
  private async discoverRoles(lane: 'roles/' | 'retired-workers/'): Promise<Array<{ key: string; value: RoleRecord }>> {
    const prefix = this.prefix + lane
    const rows = this.records instanceof GitAuthorityStore
      ? await this.records.listDiscovery<unknown>(prefix, fault => this.reportRoleContentFault(fault))
      : await this.records.list<unknown>(prefix)
    return rows.filter((row): row is { key: string; value: RoleRecord } => {
      const reason = this.roleRecordProblem(row.key, row.value)
      if (!reason) return true
      this.reportRoleContentFault({ path: this.records instanceof GitAuthorityStore ? this.records.change(row.key, null).path : row.key, key: row.key, value: row.value, reason })
      return false
    })
  }
  private taskCommandOwner(identity: { taskId?: string; lifecycleId?: string } | undefined) {
    return identity?.taskId ? { taskId: identity.taskId, ...(identity.lifecycleId ? { lifecycleId: identity.lifecycleId } : {}), hostKey: this.archiveHostKey() } : undefined
  }
  private async selectedTaskCommandOwner(taskId: string, identity: WorkIdentity) {
    if (identity.taskId === taskId) return this.taskCommandOwner(identity)
    return withSnapshot(this.files, async snapshot => this.taskCommandOwner(await readJson<TaskMetadata>(this.files, snapshot, paths.task(taskId))))
  }
  private archiveHostKey(): string { return taskArchiveHostKey(this.records instanceof GitAuthorityStore ? this.records.root : undefined, this.config.scope, this.config.instanceUUID) }
  private async taskSealAt(snapshot: FilesSnapshot, taskId: string, lifecycleId?: string): Promise<TaskArchiveHostFacts | undefined> {
    const task = await readJson<TaskMetadata>(this.files, snapshot, paths.task(taskId))
    if (!task) return undefined
    return taskArchiveHostFacts(await readTaskArchiveState(this.files, snapshot, task), { lifecycleId }, this.archiveHostKey())
  }
  private async taskRuntimeReleased(identity: { taskId?: string; lifecycleId?: string; role?: RecoveryRole }, snapshot?: FilesSnapshot): Promise<boolean> {
    if (!identity.taskId || identity.role === 'Foreground') return false
    const read = async (view: FilesSnapshot) => {
      if (this.files instanceof PhysicalLocalFiles) {
        // The original Cleaner handoff already owns this exact Task family;
        // no stale role or recovery may recreate its removed working roots.
        if (this.loop?.ownsPhysicalTaskCleanup(identity.taskId!, identity.lifecycleId)) return true
        // A retired current Task cannot admit stale role/wake writes. This is
        // current runtime authority only, never an archived-identity fallback.
        const current = await readJson<TaskMetadata>(this.files, view, paths.task(identity.taskId!))
        if (!current || taskLifecycle(current) !== taskLifecycle(identity)) return true
      }
      return !!(await this.taskSealAt(view, identity.taskId!, identity.lifecycleId))?.runtimeReleased
    }
    return snapshot ? read(snapshot) : withSnapshot(this.files, read)
  }
  private withTaskFacts(state: TaskArchiveState, lifecycleId: string | undefined, facts: TaskArchiveHostFacts): TaskArchiveState {
    const lifecycle = taskArchiveLifecycle(state, { lifecycleId }) ?? {}, hostKey = this.archiveHostKey(), own = taskArchiveHostFacts(state, { lifecycleId }, hostKey) ?? {}
    const resolvedSafetyFaultIds = [...new Set([...(own.resolvedSafetyFaultIds ?? []), ...(facts.resolvedSafetyFaultIds ?? [])])].sort()
    return { ...state, lifecycles: { ...state.lifecycles, [lifecycleId ?? '']: { ...lifecycle, hosts: { ...lifecycle.hosts,
      [hostKey]: { ...own, ...facts, ...(resolvedSafetyFaultIds.length ? { resolvedSafetyFaultIds } : {}) } } } } }
  }
  private async deleteRuntimeRecord(key: string, expected: unknown, ownedGitPaths: readonly string[] = []): Promise<void> {
    if (this.records instanceof GitAuthorityStore) await this.records.compareAndDelete(key, expected, ownedGitPaths)
    else {
      if (!this.records.delete) throw new Error('Runtime storage does not support retirement.')
      await this.records.delete(key)
    }
    if (key.startsWith(this.prefix + 'wakes/')) this.taskHelperWakes?.delete((expected as WakeRecord)?.request?.id)
    this.admissionObservationVersion++; this.forgetAdmissionWake(key)
  }
  private roleKey(role: RecoveryRole, taskId?: string, workerId?: string, directId?: string): string {
    return JSON.stringify([role, role === 'Foreground' || role === 'Helper' ? null : taskId ?? null, workerId ?? null, directId ?? null])
  }
  private roleRecordPath(workId: string): string {
    return this.config.mode === 'local' && workId === this.roleKey('Foreground')
      ? localForegroundRoleRecordPath(this.config.scope, this.config.collaborationId)
      : this.prefix + 'roles/' + hash(workId)
  }
  private physicalDirectInput(record: RoleRecord): string | undefined {
    const request = record.delivery?.request ?? record.lastWake
    for (const source of request?.sources ?? []) {
      const direct = parseDirectSignal(source.path.split('/').at(-1)!)
      if (direct) return direct.inputPath
    }
    return undefined
  }
  private async settlePhysicalDirectDelivery(record: RoleRecord, inputPath: string, commandId: string): Promise<void> {
    if (!(this.files instanceof PhysicalLocalFiles)) return
    const current = this.roleRecords.get(record.identity.workId)
    if (!current || current.identity.executionId !== record.identity.executionId || current.sessionId !== record.sessionId
      || this.physicalDirectInput(current) !== inputPath) throw new Error('The direct delivery source responsibility changed before completion.')
    const request = current.delivery?.request ?? current.lastWake!
    if (current.gitSettledWakeId !== request.id) await this.saveRole({ ...current, gitSettledWakeId: request.id })
    // The existing RoleRecord completion now survives a restart. Retire only
    // this accepted publication, without waiting for native session teardown.
    await retirePublishedDirectDelivery(this.files, inputPath, commandId)
  }
  private async physicalSignalSources(path: string): Promise<readonly { path: string; version: string }[]> {
    if (!(this.files instanceof PhysicalLocalFiles)) return []
    const segments = path.split('/'), name = segments.at(-1)!
    if (segments[0] !== 'state') return []
    let role: RecoveryRole | undefined, taskId: string | undefined, workerId: string | undefined, directId: string | undefined
    if (segments.length === 2) {
      const direct = parseDirectSignal(name)
      if (direct) {
        if (direct.member !== this.config.member) return []
        role = direct.role; directId = direct.id; if (direct.role === 'Worker') workerId = direct.id
      } else if (name.startsWith('Foreground_')) role = 'Foreground'
      else if (name === 'Helper' || name.startsWith('Helper_')) role = 'Helper'
    } else if (segments.length === 4 && segments[1] === this.config.member) {
      taskId = segments[2]
      if (name.startsWith('Planner_')) role = 'Planner'
      else if (name.startsWith('Organizer_')) role = 'Organizer'
      else if (name.startsWith('Worker_')) { role = 'Worker'; workerId = signalWorkerId(name); if (!workerId) return [] }
      else if (name === 'Recorder') role = 'Recorder'
      else if (name === 'Helper' || name.startsWith('Helper_')) role = 'Helper'
    }
    if (!role) return []
    const record = await this.records.get<RoleRecord>(this.roleRecordPath(this.roleKey(role, taskId, workerId, directId)))
    return [...record?.delivery?.request.sources ?? [], ...record?.lastWake?.sources ?? [],
      ...Object.values(record?.notificationClaims ?? {}).flatMap(claim => claim.sources)]
      .filter(source => source.path === path)
  }
  private assertOrganizerBusiness(record: RoleRecord, request?: RoleWake): void {
    if (record.identity.role !== 'Organizer') return
    const taskId = record.identity.taskId
    if (!taskId || request && request.taskId !== taskId
      || record.identity.workId !== this.roleKey('Organizer', taskId))
      throw new Error('Organizer business requires exactly one task-bound O identity.')
  }
  private async queueOrganizerLedger(task: TaskMetadata): Promise<void> {
    if (task.route !== 'O' || task.owner !== this.config.member || task.status !== 'running') return
    const taskId = task.taskId, workId = this.roleKey('Organizer', taskId)
    await this.serialWork(workId, async () => {
      if (this.closed) return
      const eligible = await withSnapshot(this.files, async snapshot => {
        const current = await readJson<TaskMetadata>(this.files, snapshot, paths.task(taskId))
        return current?.route === 'O' && current.owner === this.config.member && current.status === 'running'
          && taskLifecycle(current) === taskLifecycle(task)
          && !await this.manuallyCleared(taskId, snapshot) && !await readTaskCleanupRecord(this.files, snapshot, taskId)
      })
      if (!eligible || await this.controls.taskHeld(taskId, task.lifecycleId) || await this.loop.taskReleased(taskId, task.lifecycleId)) return
      const scoped = this.roleRecords.get(workId)
      if (scoped && taskLifecycle(scoped.identity) === taskLifecycle(task) && !scoped.released
        && (this.active(scoped) || !scoped.stopped && scoped.delivery?.confirmed === false)) return
      await this.wake({
        id: 'organizer-ledger:' + hash(taskLifecycleKey(task)), role: 'Organizer', taskId,
        ...(task.lifecycleId ? { lifecycleId: task.lifecycleId } : {}), reason: 'startup-recovery', sources: [],
        context: {
          taskMetadataPath: paths.task(taskId), sourcePath: task.sourcePath,
          organizerNotePath: paths.run(taskId) + '/Organizer_Note.md', dispatchPath: paths.run(taskId) + '/Dispatch.md',
          facts: 'Continue this O Task from its current text ledger, existing child Tasks, notes and committed results. No old native input is replayed and committed work must not be repeated.'
        }
      })
    })
  }
  private requestKey(request: RoleWake): string {
    const direct = request.sources.map((source) => parseDirectSignal(source.path.split('/').at(-1)!)).find(Boolean);
    return this.roleKey(request.role, request.taskId, request.workerId, direct?.id)
  }
  private saveRole(record: RoleRecord, evidenceUpdate = false, deliveryUpdate?: 'prepare' | 'confirm', retiredRecorderSettled = false, completedNativeCommands?: readonly string[], addedClaim?: { id: string; value: NotificationClaim }): Promise<void> {
    return withOperationChannel(this.files, record.identity.role === 'Foreground' ? 'foreground-read' : record.identity.role === 'Helper' ? 'host-poll-write' : 'read', () => this.saveRoleInChannel(record, evidenceUpdate, deliveryUpdate, retiredRecorderSettled, completedNativeCommands, addedClaim))
  }
  private saveRoleInChannel(record: RoleRecord, evidenceUpdate = false, deliveryUpdate?: 'prepare' | 'confirm', retiredRecorderSettled = false, completedNativeCommands?: readonly string[], addedClaim?: { id: string; value: NotificationClaim }): Promise<void> {
    this.roleWrites ??= new Map()
    const workId = record.identity.workId
    this.roleWriteOwners.set(workId, record.identity)
    const operation = (this.roleWrites.get(workId) ?? Promise.resolve()).catch(() => { }).then(async () => {
      if (this.config.mode === 'local' && record.identity.role === 'Foreground')
        record = { ...record, foregroundCollaborationId: this.config.collaborationId }
      let latest = this.roleRecords.get(workId)
      const incomingDelivery = record.delivery
      if (evidenceUpdate && this.records instanceof GitAuthorityStore) {
        if (!latest || latest.identity.executionId !== record.identity.executionId) throw new Error('Stop evidence execution was replaced before persistence.')
        const base = this.roleBases?.get(workId), evidence = record.stopIntent
        if (!evidence || evidence.workId !== workId || evidence.executionId !== record.identity.executionId || evidence.sessionId !== record.sessionId)
          throw new Error('Stop evidence does not match its owned execution.')
        const roleKey = this.roleRecordPath(workId)
        const retiredKey = this.prefix + 'retired-workers/' + record.identity.executionId
        const route = await this.records.updateRouted([roleKey, retiredKey], workerTransferPath(this.workerBusinessScope(), record.identity.executionId), async (values, raw, snapshot) => {
          const retired = (values.get(retiredKey) as RoleRecord | undefined);
          let target = roleKey, current = (values.get(roleKey) as RoleRecord | undefined);
          if (raw !== undefined) {
            const transfer = (JSON.parse(raw) as WorkerBusinessTransfer<RoleRecord>);
            if (transfer.version !== 1 || !transfer.record || JSON.stringify(transfer.record.identity) !== JSON.stringify(record.identity)
              || transfer.record.sessionId !== record.sessionId || transfer.record.generation !== record.generation)
              throw new Error('Worker transfer authority does not match stop evidence.')
            target = retiredKey;
            current = retired
          } else {
            if (retired) throw new Error('Retired Worker lacks its transfer authority.')
            if (await this.taskRuntimeReleased(record.identity, snapshot)) throw new Error('Stop evidence target is already released.')
          }
          if (!current || JSON.stringify(current.identity) !== JSON.stringify(record.identity) || current.sessionId !== record.sessionId || current.generation !== record.generation)
            throw new Error('Stop evidence execution was replaced before persistence.')
          if (current.released) throw new Error('Stop evidence execution is already released.')
          if ((current.stopped || current.stopIntent?.phase === 'disposed') && evidence.phase === 'stopping')
            throw new Error('A settled stop cannot regress to stopping.')
          const resolvesUnknown = evidence.phase === 'disposed' && evidence.jobs.length === 0 && current.stopIntent?.phase !== 'disposed'
          if (JSON.stringify(current.stopIntent) === JSON.stringify(evidence)) return { target, write: false, value: current, result: { saved: current, retired: target === retiredKey } }
          if (JSON.stringify(current.stopIntent) !== JSON.stringify(evidence) && JSON.stringify(current.stopIntent) !== JSON.stringify(base?.stopIntent))
            throw new Error('Stop evidence changed concurrently; reconcile its original producer.')
          const updated = ({ ...current, stopIntent: evidence, ...(resolvesUnknown ? { stopUnknown: undefined } : {}) })
          return { target, write: true, value: updated, result: { saved: updated, retired: target === retiredKey } }
        });
        const { saved } = route
        if (route.retired) {
          const liveRetired = this.retiredWorkers?.get(record.identity.executionId)
          if (liveRetired && JSON.stringify(liveRetired.identity) === JSON.stringify(record.identity) && liveRetired.sessionId === record.sessionId)
            this.retiredWorkers!.set(record.identity.executionId, saved);
          const stopping = this.stopOperations?.get(JSON.stringify([workId, saved.identity.executionId]))
          if (stopping && saved.stopped) { stopping.persistedStopped = true; if (stopping.settled) stopping.result = { status: 'stopped' } }
          return;
        }
        const live = this.roleRecords.get(workId)
        if (live?.identity.executionId === record.identity.executionId && live.sessionId === record.sessionId) {
          ; (this.roleBases ??= new Map()).set(workId, structuredClone(saved))
          this.roleRecords.set(workId, { ...saved, ...(live.businessTransferred ? { businessTransferred: true } : {}) })
          if (saved.stopped || saved.released) this.wakeConsumptions?.delete(saved.identity.executionId)
          const stopping = this.stopOperations?.get(JSON.stringify([workId, saved.identity.executionId]))
          if (stopping && saved.stopped) { stopping.persistedStopped = true; if (stopping.settled) stopping.result = { status: 'stopped' } }
        }
        return;
      }
      if (!(this.records instanceof GitAuthorityStore) && !latest && record.identity.role === 'Organizer') {
        const previous = await this.records.get<RoleRecord>(this.roleRecordPath(workId))
        if (previous?.released && previous.identity.executionId === record.identity.executionId) return
      }
      const physicalRetirement = this.files instanceof PhysicalLocalFiles && latest
        && latest.identity.executionId === record.identity.executionId && latest.sessionId === record.sessionId
        && (evidenceUpdate || record.stopped || record.released)
      // Directory retirement forbids new business, but exact native close
      // evidence must still reach its existing Host record afterward.
      if (!(this.records instanceof GitAuthorityStore) && !physicalRetirement && await this.taskRuntimeReleased(record.identity)) return;
      if (this.records instanceof GitAuthorityStore && !latest && record.identity.role === 'Organizer') {
        const previous = await this.records.get<RoleRecord>(this.roleRecordPath(workId))
        if (previous) (this.roleBases ??= new Map()).set(workId, structuredClone(previous))
        if (previous?.released && previous.identity.executionId === record.identity.executionId) throw new Error('The role execution is already released.')
        if (previous && !previous.released) {
          if (previous.identity.executionId !== record.identity.executionId) throw new Error('Role authority belongs to another execution; reconcile its ownership.')
          latest = previous
        }
      }
      const createsOwner = !latest || latest.identity.executionId !== record.identity.executionId || latest.released
      if (createsOwner || deliveryUpdate === 'prepare') this.assertOrganizerBusiness(record, incomingDelivery?.request)
      // Admission belongs to the execution's Task, not a notification's source.
      // Shared Foreground/Helper inputs may refer to Tasks they do not own.
      if (evidenceUpdate) {
        if (!latest || latest.identity.executionId !== record.identity.executionId) throw new Error('Stop evidence execution was replaced before persistence.')
        const evidence = record.stopIntent
        if (!evidence || evidence.workId !== workId || evidence.executionId !== latest.identity.executionId || evidence.sessionId !== latest.sessionId)
          throw new Error('Stop evidence does not match its owned execution.')
        record = { ...latest, stopIntent: evidence, ...(evidence.phase === 'disposed' && evidence.jobs.length === 0 && latest.stopIntent?.phase !== 'disposed' ? { stopUnknown: undefined } : {}) }
      } else if (latest && latest.identity.executionId !== record.identity.executionId) {
        if (record.generation <= latest.generation) throw new Error('A superseded execution cannot overwrite its replacement.');
      } else if (latest) record = {
        ...record,
        ...(latest.stopIntent ? { stopIntent: latest.stopIntent } : {}),
        foregroundOutputIds: [...new Set([...(latest.foregroundOutputIds ?? []), ...(record.foregroundOutputIds ?? [])])],
        // Ordinary saves carry a snapshot, not permission to restore retired claims.
        notificationClaims: latest.notificationClaims,
        gitSettledWakeId: record.gitSettledWakeId ?? latest.gitSettledWakeId,
        businessTransferred: record.businessTransferred || latest.businessTransferred,
        completedRound: record.completedRound || latest.completedRound,
        stopped: record.stopped || latest.stopped,
        released: record.released || latest.released,
        stopUnknown: latest.stopIntent?.phase === 'disposed' && latest.stopIntent.jobs.length === 0 && JSON.stringify(record.stopIntent) !== JSON.stringify(latest.stopIntent)
          ? latest.stopUnknown : record.stopUnknown ?? latest.stopUnknown,
        delivery: latest.delivery ?? record.delivery,
        lastWake: latest.lastWake ?? record.lastWake
      };
      if (addedClaim) record = { ...record, notificationClaims: { ...record.notificationClaims, [addedClaim.id]: addedClaim.value } }
      if (deliveryUpdate && incomingDelivery) {
        if (deliveryUpdate === 'confirm') {
          if (latest?.delivery?.messageId !== incomingDelivery.messageId) throw new Error('A superseded delivery cannot confirm another input.');
          record = { ...record, lastWake: latest.delivery.request, delivery: { ...latest.delivery, confirmed: true } };
        } else {
          const delivery = latest?.identity.executionId === record.identity.executionId ? latest.delivery : undefined
          record = {
            ...record, delivery: delivery?.messageId === incomingDelivery.messageId
              ? { ...delivery, text: delivery.text ?? incomingDelivery.text }
              : { ...incomingDelivery, sequence: (delivery?.sequence ?? 0) + 1 }
          }
        }
      }
      if (latest) {
        const retirements = [...latest.nativeRetirements ?? []]
        // P/O continuation replaces an already stopped original row. Its
        // original input/header reads have finished before this replacement save.
        // Preserve an explicitly released historical instance instead of enrolling it.
        if (latest.stopped && !latest.released && ['Planner', 'Organizer'].includes(latest.identity.role)
          && record.identity.role === latest.identity.role
          && record.identity.executionId !== latest.identity.executionId && record.sessionId !== latest.sessionId
          && !retirements.some(item => item.sessionId === latest.sessionId && item.executionId === latest.identity.executionId))
          retirements.push({ sessionId: latest.sessionId, executionId: latest.identity.executionId })
        // A replaced, confirmed-stopped Helper cannot be reused. Keep only its
        // original accepted claims beside the existing exact retirement item;
        // report replay and HostRestore proof finish independently of admission.
        if (latest.identity.role === 'Helper' && latest.stopped && !latest.stopUnknown
          && record.identity.role === 'Helper' && record.identity.executionId !== latest.identity.executionId
          && record.sessionId !== latest.sessionId
          && !retirements.some(item => item.sessionId === latest.sessionId && item.executionId === latest.identity.executionId))
          retirements.push({ sessionId: latest.sessionId, executionId: latest.identity.executionId,
            helper: { delivery: latest.delivery, lastWake: latest.lastWake, notificationClaims: latest.notificationClaims } })
        if (record.identity.role === 'Foreground' && record.completedRound && record.stopped
          && (!latest.completedRound || !latest.stopped)
          && record.identity.executionId === latest.identity.executionId
          && !retirements.some(item => item.sessionId === record.sessionId))
          retirements.push({ sessionId: record.sessionId, executionId: record.identity.executionId,
            ...((record.delivery?.request ?? record.lastWake)?.id ? { wakeId: (record.delivery?.request ?? record.lastWake)!.id } : {}) })
        record = { ...record, nativeRetirements: retirements.length ? retirements : undefined }
      }
      if (record.stopped) record = { ...record, stopUnknown: undefined }
      if (record.released && record.identity.taskId) record = {
        identity: record.identity,
        sessionId: record.sessionId,
        generation: record.generation,
        stopped: record.stopped,
        released: true,
        ...record.taskWorkspace ? { taskWorkspace: record.taskWorkspace } : {},
        ...(record.stopIntent ? { stopIntent: record.stopIntent } : {}),
        ...(record.nativeRetirements?.length ? { nativeRetirements: record.nativeRetirements } : {})
      };
        const rolePath = this.roleRecordPath(workId)
      if (this.records instanceof GitAuthorityStore) {
        const base = this.roleBases?.get(workId)
        const accepted = await this.records.updateWithReads<RoleRecord, boolean>(rolePath, [], async (current, _reads, snapshot) => {
          if (await this.taskRuntimeReleased(record.identity, snapshot)) return { write: false, result: false }
          if (JSON.stringify(current) === JSON.stringify(record)) return { write: false, result: true }
          if (JSON.stringify(current) !== JSON.stringify(base)) throw new Error('Role authority changed since this operation observed it; re-evaluate the owned execution.')
          let changes: FileChange[] = []
          if (completedNativeCommands?.length) {
            try { changes = await this.transactions.completedNativeCommandChanges(snapshot, completedNativeCommands) }
            catch (error) { this.ctx.logger?.('deepseek-servant').warn('Successful command receipt cleanup was skipped; the original role completion continues.', error) }
          }
          return { write: true, value: record, result: true, ...(changes.length ? { changes } : {}) }
        });
        if (!accepted) {
          // The Recorder's late idle marker has no work left after its Task retired.
          // Keep the authority check atomic; all other saves and failures still reject.
          if (retiredRecorderSettled && record.identity.role === 'Recorder') return
          throw new Error('The task is already released.')
        }
          ;
        (this.roleBases ??= new Map()).set(workId, structuredClone(record))
      } else {
        await this.records.set(rolePath, record)
        // A send may confirm while this auxiliary Local save is awaiting storage.
        // Preserve those IDs in RAM for its queued save/reset, only on this owner.
        const current = this.roleRecords.get(workId)
        if (this.config.mode === 'local' && record.identity.role === 'Foreground'
          && current?.identity.executionId === record.identity.executionId
          && current.sessionId === record.sessionId && current.generation === record.generation) record = {
          ...record, foregroundOutputIds: [...new Set([...(record.foregroundOutputIds ?? []), ...(current.foregroundOutputIds ?? [])])]
        }
      }
      this.roleRecords.set(workId, record)
      this.continueNativeRetirements(record)
      if (record.stopped || record.released) this.wakeConsumptions?.delete(record.identity.executionId)
      const stopping = this.stopOperations?.get(JSON.stringify([workId, record.identity.executionId]))
      if (stopping && record.stopped) {
        stopping.persistedStopped = true
        if (stopping.settled) stopping.result = { status: 'stopped' }
      }
    });
    this.roleWrites.set(workId, operation)
    void operation.finally(() => { if (this.roleWrites?.get(workId) === operation) { this.roleWrites.delete(workId); this.roleWriteOwners.delete(workId) } }).catch(() => { })
    return operation
  }
  /** The existing role/retired-Worker record carries exact sessions whose
   * handoff or ordinary wake retirement is still pending. New turns and
   * Task directory deletion never await this independent handoff. */
  private continueNativeRetirements(record: RoleRecord, retiredWorker = false): void {
    if (retiredWorker && !record.stopped) return
    for (const retired of record.nativeRetirements ?? []) {
      const id = record.identity.workId + '\0' + retired.sessionId
      const operations = this.nativeRetirementOperations ??= new Map<string, Promise<void>>()
      if (operations.has(id)) continue
      const operation = Promise.resolve().then(async () => {
        if (retired.helper) {
          if (this.closed) return
          // Reuse shutdown's existing maintenance drain for the accepted
          // publication replay, never for Cleaner acceptance or file deletion.
          const key = 'helper-retirement:' + id
          const maintenance = this.maintenance ??= new Map()
          let finished = false
          const finishing = this.finishRetiredHelper(record.identity.workId, retired).then(value => { finished = value })
          maintenance.set(key, finishing)
          try { await finishing }
          finally { if (maintenance.get(key) === finishing) maintenance.delete(key) }
          if (!finished) return
        }
        if (retired.wakeId) await this.settleOperations([retireNativeSession(this.ctx, retired.sessionId),
          this.retireCompletedForegroundWake(retired.wakeId)], 'Foreground retirement failed')
        else await retireNativeSession(this.ctx, retired.sessionId)
        await this.withRoleWrite(retiredWorker ? 'retired:' + record.identity.executionId : record.identity.workId, async () => {
          const key = retiredWorker ? this.prefix + 'retired-workers/' + record.identity.executionId
            : this.roleRecordPath(record.identity.workId)
          const remove = (current: RoleRecord | undefined) => {
            if (!current?.nativeRetirements?.some(item => item.sessionId === retired.sessionId && item.executionId === retired.executionId)) return current
            const pending = current.nativeRetirements.filter(item => item.sessionId !== retired.sessionId || item.executionId !== retired.executionId)
            const next = { ...current }
            if (pending.length) next.nativeRetirements = pending; else delete next.nativeRetirements
            return next
          }
          let saved: RoleRecord | undefined
          if (this.records instanceof GitAuthorityStore) saved = await this.records.update<RoleRecord, RoleRecord | undefined>(key, current => {
            const next = remove(current)
            return { write: next !== current, ...(next ? { value: next } : {}), result: next }
          })
          else {
            const current = await this.records.get<RoleRecord>(key)
            saved = remove(current)
            if (saved && saved !== current) await this.records.set(key, saved)
          }
          const live = retiredWorker ? this.retiredWorkers?.get(record.identity.executionId) : this.roleRecords.get(record.identity.workId)
          if (saved && live?.identity.executionId === saved.identity.executionId && live.sessionId === saved.sessionId) {
            if (retiredWorker) this.retiredWorkers!.set(saved.identity.executionId, { ...live, nativeRetirements: saved.nativeRetirements })
            else {
              this.roleRecords.set(saved.identity.workId, { ...live, nativeRetirements: saved.nativeRetirements })
              ; (this.roleBases ??= new Map()).set(saved.identity.workId, structuredClone(saved))
            }
          }
        })
      })
      operations.set(id, operation)
      void operation.catch(error => this.error(error, { identity: record.identity, sessionId: retired.sessionId }))
        .finally(() => { if (operations.get(id) === operation) operations.delete(id) })
    }
  }
  /** Only a replaced, stopped Helper reaches this last native-log consumer.
   * Its accepted physical publication may still need original call arguments;
   * HostRestore may still need its persisted result. No Debug retention scan. */
  private async finishRetiredHelper(workId: string, retired: NonNullable<RoleRecord['nativeRetirements']>[number]): Promise<boolean> {
    const current = this.roleRecords.get(workId)
    if (!current || current.identity.executionId === retired.executionId || current.sessionId === retired.sessionId) return false
    const original: RoleRecord = { ...retired.helper, identity: { role: 'Helper', workId, executionId: retired.executionId },
      sessionId: retired.sessionId, generation: 0, stopped: true }
    const events = await new DshSessionReader(this.ctx).events(retired.sessionId)
    const request = original.delivery?.request ?? original.lastWake
    if (this.files instanceof PhysicalLocalFiles && request)
      await resumePhysicalHelperReportsFromEvents(this.files, retired.executionId, events, {
        recordAttempt: (input, commandId) => this.recordSafetyAttempt(this.binding(original, request), input, commandId, original),
        signalSources: path => this.physicalSignalSources(path)
      }, true)
    const calls = new Map(events.flatMap(event => event.type === 'tool/call' && event.data.name === 'dss_restore_host'
      ? [[event.seq, event] as const] : []))
    const successful = new Set<number>()
    for (const event of events) {
      if (event.type !== 'tool/result' || event.surfaceOp !== 'append' || event.data.message.isError) continue
      const call = event.sourceEventSeqs?.map(seq => calls.get(seq)).find(call => call
        && call.data.turn === event.data.turn && call.data.step === event.data.step
        && call.data.callId === event.data.message.toolCallId)
      if (call) successful.add(call.seq)
    }
    let finished = true
    for (const call of calls.values()) {
      const commandId = retired.sessionId + ':' + call.data.callId
      const proof = { workId, executionId: retired.executionId }
      if (successful.has(call.seq)) {
        ;(this.hostRestoreNativeEvidence ??= new Map()).set(commandId, proof)
        await this.retireCompletedHostRestore(commandId, proof)
      }
      // An accepted call without its native success is not invented into a
      // successful result. Keep this exact old session while its row remains.
      const value = await this.records.get<HostRestore>(this.prefix + 'host-restores/' + hash(commandId))
      if (value?.requester?.workId === workId && value.requester.executionId === retired.executionId) finished = false
    }
    return finished
  }
  /** Native completion or confirmed original-conversation clear owns this
   * exact input after later responsibilities are handed off. */
  private async retireCompletedForegroundWake(wakeId: string): Promise<void> {
    const key = this.prefix + 'wakes/' + hash(wakeId)
    const operation = (this.wakeWrites.get(key) ?? Promise.resolve()).then(async () => {
      const wake = await this.records.get<WakeRecord>(key)
      // Native continuation owns its recovery input separately. Git cold
      // continuation uses startup-recovery without a WakeRecovery payload.
      if (!wake || wake.request.role !== 'Foreground' || wake.recovery || wake.request.reason === 'startup-recovery') return
      // The stopped ordinary Foreground no longer replays this initial claim.
      // Retire its exact receipt with the existing wake CAS, without reading or
      // scanning receipts. Recovery and later notification claims keep their owners.
      const receiptPaths: string[] = []
      if (this.records instanceof GitAuthorityStore) {
        const signals = [...new Set(wake.request.sources.filter(source => source.path.startsWith('state/') && source.path.split('/').at(-1) !== 'recovery').map(source => source.path))].sort()
        if (signals.length) {
          const originalWake = typeof wake.request.context?.originalWake === 'string' ? wake.request.context.originalWake : wake.request.id
          const commandId = 'consume-wake/' + hash(JSON.stringify([this.config.member, originalWake, signals]))
          receiptPaths.push(this.conversation.claimForegroundSignalsReceiptPath(commandId))
        }
      }
      await this.deleteRuntimeRecord(key, wake, receiptPaths)
    })
    this.wakeWrites.set(key, operation)
    try { await operation }
    finally { if (this.wakeWrites.get(key) === operation) this.wakeWrites.delete(key) }
  }
  private active(record: RoleRecord): boolean {
    if (record.businessTransferred) return false
    const owned = this.native.get(record.identity.workId)
    if (owned) { const state = owned.observe().state; return state === 'running' || state === 'waiting' }
    const agent = this.ctx.agents.get(SessionId(record.sessionId))
    return agent?.status === 'running' || (this.ctx.get('jobs')?.list(SessionId(record.sessionId)).some(job => job.owner === record.sessionId && (job.status === 'running' || job.status === 'stopping')) ?? false)
  }
  private plannerWorkerExecutions(binding: Pick<FrameworkRoleBinding, 'role' | 'taskId' | 'member' | 'direct' | 'lifecycleId'>): PlannerWorkerExecutions | undefined {
    if (binding.role !== 'Planner' || !binding.taskId || binding.member !== this.config.member || binding.direct) return
    const taskId = binding.taskId, member = binding.member
    const workers: PlannerWorkerExecutions['workers'] = []
    for (const record of this.roleRecords.values()) {
      const identity = record.identity
      if (identity.role !== 'Worker' || identity.taskId !== taskId || identity.member !== member || taskLifecycle(identity) !== taskLifecycle(binding) || !identity.workerId) continue;
      const owned = this.native.get(identity.workId, identity.executionId)
      const observation = owned?.observe(), agent = this.ctx.agents.get(SessionId(record.sessionId))
      const jobs = this.ctx.get('jobs')?.list(SessionId(record.sessionId)).filter(job =>
        job.owner === (owned?.actualAgent?.id ?? record.stopIntent?.agentId ?? record.sessionId)
        && (job.status === 'running' || job.status === 'stopping')) ?? []
      const stopConfirmed = record.stopped === true && !owned && !agent && jobs.length === 0
      const liveState = observation && observation.state !== 'stopped' ? observation.state
        : agent?.status === 'running' ? 'running' : agent ? 'idle' : jobs.length ? 'running' : undefined
      const state = liveState ?? (stopConfirmed ? 'stopped' : record.stopUnknown ? 'unconfirmed' : record.stopIntent ? 'stopping' : 'unknown')
      workers.push({
        childId: identity.workerId, workId: identity.workId, executionId: identity.executionId, generation: record.generation,
        state, stopConfirmed, pendingAdmission: this.workerAdmissions?.has(identity.workId) ?? false,
        businessTransferred: record.businessTransferred === true, released: record.released === true,
        ...(record.stopIntent ? { stopPhase: record.stopIntent.phase } : {}),
        ...(record.stopUnknown ? { stopUnconfirmed: record.stopUnknown.reason } : {}),
        paths: workerPaths(taskId, member, identity.workerId)
      })
    }
    return {
      taskId, member, observedAt: new Date().toISOString(), source: 'current-host-owned-executions',
      workers: workers.sort((a, b) => a.childId.localeCompare(b.childId)),
      reservedWorkerSeats: [...this.workerAdmissions ?? []].filter(workId => this.workerAdmissionTasks?.get(workId) === taskId).length
    }
  }
  private workerSeatOccupied(record: RoleRecord): boolean {
    if (record.identity.role !== 'Worker' || record.stopped || record.businessTransferred) return false
    if (this.active(record) || record.stopUnknown) return true
    const intent = record.stopIntent
    return intent?.workId === record.identity.workId && intent.executionId === record.identity.executionId
      && intent.phase === 'stopping'
  }
  private occupiedWorkerSeats(excluding?: string, taskId?: string, directWorkId?: string): number {
    // A direct Worker is its own short task; normal Workers share only their Task.
    const bucket = taskId ?? directWorkId ?? excluding
    const matches = (workId: string, task?: string) => bucket === undefined || (task ?? workId) === bucket
    const occupied = new Set([...this.workerAdmissions ?? []].filter(workId =>
      matches(workId, this.workerAdmissionTasks?.get(workId))))
    for (const record of this.roleRecords.values()) if (this.workerSeatOccupied(record)
      && matches(record.identity.workId, record.identity.taskId)) occupied.add(record.identity.workId)
    if (excluding) occupied.delete(excluding)
    return occupied.size
  }
  async foregroundProcessing(): Promise<{ executionId: string; turnId: string; startedAt?: number } | undefined> {
    const record = [...this.roleRecords.values()].find(row => row.identity.role === 'Foreground')
    if (this.closed || !record || record.released || record.stopped) return;
    const owned = this.native.get(record.identity.workId, record.identity.executionId);
    if (!owned || owned !== this.native.get(record.identity.workId) || owned.sessionId !== record.sessionId || String(owned.actualAgent.session.id) !== record.sessionId || owned.actualAgent.status !== "running") return;
    const turn = this.foregroundActivity?.read(owned.actualAgent.session);
    return {
      executionId: record.identity.executionId,
      turnId: turn ? JSON.stringify([record.sessionId, turn.turn, turn.startSeq]) : JSON.stringify([record.sessionId, "running"]),
      ...turn && !turn.end ? { startedAt: turn.startedAt } : {}
    };
  }
  foregroundProcessGroups(): readonly DshForegroundProcessGroup[] {
    const record = [...this.roleRecords.values()].find((row) => row.identity.role === "Foreground");
    if (this.closed || !record || record.released || record.stopped) return [];
    const owned = this.native.get(record.identity.workId, record.identity.executionId);
    if (!owned || owned !== this.native.get(record.identity.workId) || owned.sessionId !== record.sessionId || String(owned.actualAgent.session.id) !== record.sessionId) return [];
    const turn = this.foregroundActivity?.read(owned.actualAgent.session);
    const process2 = this.foregroundProcesses?.get(record.identity.executionId);
    if (!turn || process2?.sessionId !== record.sessionId) return [];
    return process2.snapshot().filter((group) => group.turnId === JSON.stringify([record.sessionId, turn.turn]));
  }
  private conversationError(error: unknown, identity: WorkIdentity, stage: string): void {
    try { this.error(error, { identity, stage }) }
    catch (reportingError) {
      // A failing notification/error sink cannot revoke an already durable send.
      this.ctx.logger('deepseek-servant').error(new AggregateError([error, reportingError], 'Conversation metadata error reporting failed'))
    }
  }
  private saveForegroundProcessGroups(record: RoleRecord, tracker: DshForegroundProcessTracker): void {
    if (this.roleRecords.get(record.identity.workId)?.identity.executionId !== record.identity.executionId) return;
    const groups = tracker.durableSnapshot().filter((group) => group.closed);
    if (!groups.length) return;
    const writes = this.foregroundProcessWrites ??= /* @__PURE__ */ new Map(), key = record.sessionId, previous = writes.get(key);
    const signature = JSON.stringify(groups);
    // Each existing event retains its retry opportunity after a failed save,
    // but an identical preceding success needs no second Git read.
    if (previous?.pending && previous.signature === signature) {
      let retried = false;
      const retry = previous.retry;
      const entry = { promise: previous.promise.catch(() => { retried = true; return retry() }), retry, signature, pending: true };
      writes.set(key, entry);
      void entry.promise.then(() => {
        entry.pending = false;
        if (writes.get(key) === entry) writes.delete(key);
        if (retried) this.environment.changed?.({ domain: "conversation", mode: this.config.mode });
      }).catch((error: unknown) => { entry.pending = false; this.conversationError(error, record.identity, 'foreground-process-metadata') });
      return;
    }
    const retry = () => withOperationChannel(this.files, 'foreground-read', async () => {
      if (previous) await previous.promise.catch(() => previous.promise = previous.retry());
      await this.conversation.saveProcessGroups(key, groups, this.config.member);
    });
    const entry = { promise: retry(), retry, signature, pending: true };
    writes.set(key, entry);
    void entry.promise.then(() => {
      entry.pending = false;
      if (writes.get(key) === entry) writes.delete(key);
      this.environment.changed?.({ domain: "conversation", mode: this.config.mode });
    }).catch((error) => { entry.pending = false; this.conversationError(error, record.identity, 'foreground-process-metadata') });
  }
  private async flushForegroundProcessWrites(sessionId: string): Promise<void> {
    for (; ;) {
      const entry = this.foregroundProcessWrites?.get(sessionId);
      if (!entry) return;
      await entry.promise.catch(() => entry.promise = entry.retry());
      if (this.foregroundProcessWrites?.get(sessionId) === entry) {
        this.foregroundProcessWrites.delete(sessionId);
        return;
      }
    }
  }
  executionViews(taskId?: string, lifecycleId?: string): Array<{ workId: string; executionId: string; sessionId: string; role: RecoveryRole; state: string; member?: string; workerId?: string; detail?: string }> {
    return [...this.roleRecords.values()].filter((record) => (!taskId || record.identity.taskId === taskId || record.lastWake?.taskId === taskId) && (lifecycleId === void 0 || taskLifecycle(record.identity.taskId ? record.identity : record.lastWake ?? {}) === lifecycleId)).map(record => ({
      workId: record.identity.workId, executionId: record.identity.executionId, sessionId: record.sessionId, role: record.identity.role,
      state: record.stopUnknown ? 'unconfirmed' : record.stopped ? 'stopped' : this.active(record) ? 'running' : 'idle',
      member: record.identity.member, workerId: record.identity.workerId, detail: record.stopUnknown?.reason
    }));
  }
  executing(role: RecoveryRole, taskId?: string, workerId?: string, directId?: string): boolean {
    if (directId !== undefined) {
      const record = this.roleRecords.get(this.roleKey(role, undefined, workerId, directId))
      return !!record && this.active(record)
    }
    return [...this.roleRecords.values()].some(record => record.identity.role === role
      && (taskId === undefined || record.identity.taskId === taskId)
      && (workerId === undefined || record.identity.workerId === workerId) && this.active(record))
  }
  private organizerWakeWrites = new Map<string, Promise<boolean>>()
  private helperWakeWrites = new Map<string, Promise<boolean>>()
  async wake(request: RoleWake, recovery?: WakeRecovery, safetyFaults?: SafetyFault[], safetyParentWakeId?: string, selected?: (wake: WakeRecord) => void): Promise<boolean> {
    if (request.role === 'Organizer') {
      const key = this.requestKey(request)
      const operation = (this.organizerWakeWrites.get(key) ?? Promise.resolve()).catch(() => false).then(async () => {
        return this.storeWake(request, recovery, safetyFaults, safetyParentWakeId)
      })
      this.organizerWakeWrites.set(key, operation)
      void operation.finally(() => { if (this.organizerWakeWrites.get(key) === operation) this.organizerWakeWrites.delete(key) }).catch(() => {})
      return operation
    }
    if (request.role !== 'Helper') return this.storeWake(request, recovery, safetyFaults, safetyParentWakeId)
    this.helperWakeWrites ??= new Map()
    const source = request.reason === 'notification' ? request.sources.find(source => helperSignalWakeHash(source.path, this.config.member)) : undefined
    const key = source ? helperSignalWakeHash(source.path, this.config.member) : hash(request.id);
    if (source && this.helperWakeWrites.has(key!) && !selected) return false
    const operation = (this.helperWakeWrites.get(key!) ?? Promise.resolve()).catch(() => undefined).then(() =>
      withOperationChannel(this.files, 'host-poll-write', () => this.storeWake(request, recovery, safetyFaults, safetyParentWakeId, wake => {
        selected?.(wake)
        // The existing signal was actually observed and persisted on its exact
        // wake. Merely publishing a marker is not permission to create native.
        if (!selected && source && !wake.delivered && wake.request.sources.some(item => item.path === source.path))
          this.startTargetedAdmission(wake.request.id, true)
      })))
    this.helperWakeWrites.set(key!, operation)
    void operation.finally(() => { if (this.helperWakeWrites.get(key!) === operation) this.helperWakeWrites.delete(key!) }).catch(() => { })
    return operation
  }
  private async storeWake(request: RoleWake, recovery?: WakeRecovery, safetyFaults?: SafetyFault[], safetyParentWakeId?: string, selected?: (wake: WakeRecord) => void): Promise<boolean> {
    if (await this.taskRuntimeReleased(request)) return false;
    let taskFacts: Map<string, TaskMetadata> | undefined
    if (request.taskId && !['Foreground', 'Helper'].includes(request.role) && !this.workspaces.hasBinding(request.taskId))
      await this.workspaces.bind(request.taskId, undefined, task => (taskFacts ??= new Map()).set(task.taskId, task))
    if (!recovery && request.reason === 'business-complete' && request.taskId && ['Foreground', 'Recorder'].includes(request.role)
      && !request.sources.some(source => source.path.startsWith('state/') && source.path.split('/').at(-1) !== 'recovery')) {
      const path = request.role === 'Foreground' ? foregroundTaskSignal(request.taskId) : paths.state(this.config.member, request.taskId) + '/Recorder'
      if (this.files instanceof PhysicalLocalFiles) {
        const files = this.files
        await withSnapshot(files, async snapshot => {
          // Foreground can still owe this result after Cleaner retires runtime
          // metadata. Recorder's existing runtime-release check remains above.
          const task = await readTaskReferenceIdentity(files, snapshot, request.taskId!)
          if (!task || taskLifecycle(task) !== taskLifecycle(request))
            throw new Error('Task notification belongs to a missing or different Task lifecycle.')
          if (task.parent) return
          // A reset keeps this responsibility in its existing planned phase
          // and holds Foreground until retired. Retry preserves the same marker;
          // a retired/complete reset never enters this publication again.
          await files.createIfAbsent(path, '')
        })
      } else await this.transactions.run('task-wake/' + hash(request.id), { path: path }, { reevaluate: true, taskOwner: this.taskCommandOwner(request) }, async (snapshot) => {
        const task = await assertTaskLifecycle(this.files, snapshot, request.taskId!, request);
        if (task?.parent) return [];
        return [{ path, content: '' }];
      });
      return true;
    }
    if (request.role === 'Helper' && typeof request.context?.helperDebugPath !== 'string') {
      const target = request.context?.target as { taskId?: string } | undefined
      const taskId = request.taskId ?? target?.taskId ?? (typeof request.context?.taskId === 'string' ? request.context.taskId : undefined)
      const debugPath = helperDebugPath(taskId, new Date().toISOString().slice(0, 10))
      request = { ...request, context: { ...request.context, helperDebugPath: debugPath,
        helperDebugDirectory: debugPath.slice(0, debugPath.lastIndexOf('/') + 1) } }
    }
    const helperSource = request.role === 'Helper' && request.reason === 'notification'
      ? request.sources.find(source => helperSignalWakeHash(source.path, this.config.member)) : undefined
    let key = this.prefix + 'wakes/' + hash(request.id)
    // Host-generated signal suffix is the exact existing wake key. Normal
    // Helper publication/observation does not enumerate unrelated wakes.
    const helperKey = helperSource && this.prefix + 'wakes/' + helperSignalWakeHash(helperSource.path, this.config.member)
    const exact = helperKey ? await this.records.get<WakeRecord>(helperKey) : undefined
    const helperRows = !helperSource ? [] : exact && !exact.signalsConsumed
      ? [{ key: helperKey!, value: exact }]
      // Role-authored notifications have no generated-wake key; preserve their
      // existing pending source ownership rather than inventing a second index.
      : await this.admissionWakes()
    let owner: { key: string; value: WakeRecord } | undefined
    if (helperSource) for (const row of helperRows) {
      const wake = row.value
      if (wake.request.role !== 'Helper' || wake.signalsConsumed || !(wake.helperSignal === helperSource.path || wake.request.sources.some(source => source.path === helperSource.path))) continue
      // A completed consumption remains authoritative across a crash before
      // its ordinary wake metadata update. Never issue another deletion here.
      const signals = [...new Set(wake.request.sources.filter(source => source.path.startsWith('state/') && source.path.split('/').at(-1) !== 'recovery').map(source => source.path))].sort()
      const originalWake = typeof wake.request.context?.originalWake === 'string' ? wake.request.context.originalWake : wake.request.id
      let consumed = false
      if ((wake.delivered || this.wakeAdmission(wake)?.executionId) && signals.length) {
        if (this.files instanceof PhysicalLocalFiles) {
          // Consumption owns the source observations accepted by this wake,
          // not whatever now occupies their paths. An absent or replaced old
          // observation needs no deletion and cannot consume the new signal.
          const files = this.files
          const sources = wake.request.sources.filter(source => signals.includes(source.path))
          consumed = (await Promise.all(sources.map(async source =>
            (await files.fileInfo(source.path))?.version !== source.version))).every(Boolean)
        } else consumed = !!await this.transactions.committedReceipt('consume-wake/' + hash(JSON.stringify([this.config.member, originalWake, signals])), { signals }, this.taskCommandOwner(wake.request))
      }
      if (consumed) {
        await this.updateWake(row.key, current => current ? { ...current, signalsConsumed: true } : undefined,
          () => this.continueSettledHelperWakeRetirement(wake.request))
        continue
      }
      owner = row; break
    }
    const saved = helperSource ? owner?.value : await this.records.get<WakeRecord>(key)
    if (owner) key = owner.key
    if (saved) {
      if (helperSource && !saved.delivered && !saved.request.sources.some(source => source.path === helperSource.path)) {
        // Attach the published signal once. The wake's fixed source version is
        // part of its input; a newer marker remains for later STATE discovery.
        this.publishedHelperSignals.delete(helperSource.path)
        await this.updateWake(key, current => current && !current.delivered
          && !current.request.sources.some(source => source.path === helperSource.path)
          ? { ...current, request: { ...current.request, sources: [...current.request.sources, helperSource] } } : undefined, selected)
        return true
      }
      if (saved.helperSignal && !saved.delivered && !saved.request.sources.some(source => source.path === saved.helperSignal)) this.scheduleHelperSignal(saved)
      if (recovery) await this.updateWake(key, current => current ? { ...current, recovery: current.recovery ?? recovery, delivered: false } : undefined)
      selected?.(saved)
      return false
    }
    // The original native delivery/claim still owns an already accepted ID
    // after its plain Helper wake metadata retires. This is not new work.
    if (request.role === 'Helper' && !helperSource && !recovery && !safetyFaults?.length) {
      const accepted = this.roleRecords.get(this.requestKey(request))
      if (accepted?.delivery?.confirmed && this.helperResponsibilities(accepted).some(original => original.id === request.id)) return false
    }
    if (helperSource) {
      request = { ...request, id: 'helper-notification:' + randomUUID() }
      key = this.prefix + 'wakes/' + hash(request.id)
    }
    const ledgerWakeId = request.role === 'Organizer' && request.taskId
      ? 'organizer-ledger:' + hash(taskLifecycleKey({ taskId: request.taskId, lifecycleId: request.lifecycleId })) : undefined
    if (request.reason === 'notification' || request.id === ledgerWakeId) {
      const existing = (await this.admissionWakes()).find(row => !row.value.delivered && !this.transferredWorkerWake(row.value)
        && (request.id === ledgerWakeId || row.value.request.reason === 'notification' || request.role === 'Organizer' && row.value.request.id === ledgerWakeId)
        && row.value.request.taskId === request.taskId && taskLifecycle(row.value.request) === taskLifecycle(request)
        && this.requestKey(row.value.request) === this.requestKey(request))
      // Receiver tools enumerate current notifications at their checked snapshot.
      // Preserve the original pending native message identity rather than changing its payload.
      if (existing) { selected?.(existing.value); return false }
    }
    const helperSignal = request.role === 'Helper' && (request.reason !== 'notification' || !request.sources.some(source => source.path.startsWith('state/') && source.path.split('/').at(-1) !== 'recovery'))
      ? 'state/Helper_' + encodeURIComponent(this.config.member).replaceAll('_', '%5F') + '_' + hash(request.id) : undefined
    let created = false, stored = false
    await this.updateWake(key, async (current, snapshot) => {
      created = !current
      if (current) return current
      // Host may finish an older STATE read after the original Helper consumed
      // its source. Do not persist an unowned notification for that absent path.
      if (helperSource && snapshot && this.files instanceof GitFiles
        && !(await this.files.listDirectory(snapshot, 'state/', { paths: [helperSource.path] })).length) return
      return { request, ...(helperSignal ? { helperSignal } : {}), ...(recovery ? { recovery } : {}), ...(safetyFaults?.length ? { safetyFaults, ...(safetyParentWakeId ? { safetyParentWakeId } : {}) } : {}) }
    }, value => {
      stored = true
      const state = this.localWakeAdmissions.get(key)
      if (state && taskFacts) state.taskFacts = taskFacts
      selected?.(value)
    })
    if (created && stored && helperSignal) this.scheduleHelperSignal({ request, helperSignal })
    return created && stored
  }
  private scheduleHelperSignal(wake: WakeRecord): void {
    if (!wake.helperSignal || this.publishedHelperSignals.has(wake.helperSignal)) return
    this.startMaintenance('helper-state:' + wake.request.id, async () => {
      try { await withOperationChannel(this.files, 'host-poll-write', () => this.publishHelperSignal(wake)) }
      catch (error) { this.error(error, { role: 'Helper', stage: 'state-publication', wakeId: wake.request.id }) }
    })
  }
  private readonly publishedHelperSignals = new Set<string>()
  private async publishHelperSignal(wake: WakeRecord): Promise<void> {
    if (!wake.helperSignal || this.publishedHelperSignals.has(wake.helperSignal)) return
    const path = wake.helperSignal, key = helperSignalWakeHash(path, this.config.member)!
    // Publication and attachment of this same Helper signal share its existing
    // admission lane. An old maintenance callback cannot recreate a signal
    // after its original wake has already adopted or consumed it.
    const writes = this.helperWakeWrites ??= new Map()
    const operation = (writes.get(key) ?? Promise.resolve()).catch(() => false).then(async () => {
      const current = await this.records.get<WakeRecord>(this.prefix + 'wakes/' + hash(wake.request.id))
      if (!current || current.delivered || current.signalsConsumed || current.request.sources.some(source => source.path === path)) return false
      const debugPath = typeof current.request.context?.helperDebugPath === 'string' ? current.request.context.helperDebugPath : undefined
      if (this.files instanceof PhysicalLocalFiles) {
        if (debugPath) await this.files.createIfAbsent(debugPath, '')
        await this.files.createIfAbsent(path, '')
      } else await this.transactions.run('helper-signal/' + hash(wake.request.id), { path, wakeId: wake.request.id }, { reevaluate: true, gitReplay: 'session-only' },
        async snapshot => [...debugPath && await this.files.read(snapshot, debugPath) === undefined ? [{ path: debugPath, content: '' }] : [], { path, content: '' }])
      this.publishedHelperSignals.add(path)
      return true
    })
    writes.set(key, operation)
    try { await operation }
    finally { if (writes.get(key) === operation) writes.delete(key) }
  }
  private wakeAdmission(wake: WakeRecord): WakeRecord['admission'] {
    const owner = this.roleRecords?.get(this.requestKey(wake.request))
    if (owner?.delivery?.request.id !== wake.request.id) return wake.admission
    return { ...wake.admission, phase: 'admitting', executionId: owner.identity.executionId }
  }
  private transferredWorkerWake(wake: WakeRecord): boolean {
    if (wake.request.role !== 'Worker') return false
    if (wake.admission?.executionId && this.retiredWorkers?.has(wake.admission.executionId)) return true
    for (const record of this.retiredWorkers?.values() ?? []) if (record.identity.workId === this.requestKey(wake.request)
      && [record.delivery?.request.id, record.lastWake?.id].includes(wake.request.id)) return true
    return false
  }
  private releasedWake(record: WakeRecord): WakeRecord {
    const { id, role, taskId, lifecycleId, workerId, reason } = record.request
    return { request: { id, role, reason, sources: [], ...(taskId ? { taskId } : {}), ...(lifecycleId ? { lifecycleId } : {}), ...(workerId ? { workerId } : {}) }, delivered: true }
  }
  private updateWake(key: string, update: (current: WakeRecord | undefined, snapshot?: FilesSnapshot) => WakeRecord | undefined | Promise<WakeRecord | undefined>, stored?: (value: WakeRecord) => void): Promise<void> {
    const operation = (this.wakeWrites.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      if (this.records instanceof GitAuthorityStore) {
        const authority = this.records
        let confirmed: WakeRecord | undefined
        const accepted = await authority.updateOwned<WakeRecord, boolean>(key, JSON.stringify([key, 'wake']), async (previous, snapshot) => {
          let next = await update(previous, snapshot)
          if (!next) return { write: false, result: false }
          this.wakeWriteOwners.set(key, next.request)
          if (await this.taskRuntimeReleased(next.request, snapshot)) {
            return { write: false, result: false }
          }
          confirmed = next
          return { write: true, value: next, result: true }
        });
        if (accepted) { if (confirmed) { this.admissionObservationVersion++; this.rememberAdmissionWake(key, confirmed); stored?.(confirmed) } }
        return;
      }
      const previous = await this.records.get<WakeRecord>(key)
      let next = await update(previous)
      if (next) this.wakeWriteOwners.set(key, next.request)
      if (next && await this.taskRuntimeReleased(next.request)) {
        return
      }
      if (next) { await this.records.set(key, next); this.admissionObservationVersion++; this.rememberAdmissionWake(key, next); stored?.(next) }
    });
    this.wakeWrites.set(key, operation)
    void operation.finally(() => { if (this.wakeWrites.get(key) === operation) { this.wakeWrites.delete(key); this.wakeWriteOwners.delete(key) } }).catch(() => { })
    return operation
  }
  private continueSettledHelperWakeRetirement(request: RoleWake): void {
    if (!(this.records instanceof GitAuthorityStore)) return
    const record = this.roleRecords.get(this.requestKey(request))
    if (!record?.gitSettledWakeId || record.gitSettledWakeId !== record.delivery?.request.id
      || !this.helperResponsibilities(record).some(wake => wake.id === request.id)) return
    // The exact consumption receipt can repair wake metadata after idle. Revisit
    // that accepted input independently, after this Helper's existing work.
    this.startMaintenance('helper-wake-retirement:' + request.id, () => this.serialWork(record.identity.workId, async () => {
      const current = this.roleRecords.get(record.identity.workId)
      if (current?.identity.executionId !== record.identity.executionId || current.sessionId !== record.sessionId) return
      if (this.helperRetirementChecked === current) this.helperRetirementChecked = undefined
      await this.retrySettledHelperWakeRetirement(current)
    }))
  }
  private readonly reportedAdmissionDiagnostics = new Set<string>()
  private restoringAdmissionWakes?: Set<string>
  /** Only observed committed pending wakes live here. This is an observation,
   * not a second scheduler, durable file or authorization to replace an owner. */
  private rememberAdmissionWake(key: string, wake: WakeRecord): LocalWakeAdmission | undefined {
    if (this.helperTaskOwner(wake.request)) this.taskHelperWakes?.set(wake.request.id, wake)
    if (wake.delivered) { this.forgetAdmissionWake(key); return }
    let state = this.localWakeAdmissions.get(key)
    if (!state) {
      state = { wake, reportedAt: wake.admission?.reportedAt, diagnosticContext: wake.admission?.diagnosticContext, replayPending: wake.admission?.reportedAt !== undefined }
      this.localWakeAdmissions.set(key, state)
    } else {
      state.wake = wake
      state.reportedAt ??= wake.admission?.reportedAt
      state.diagnosticContext ??= wake.admission?.diagnosticContext
    }
    return state
  }
  private forgetAdmissionWake(key: string): void {
    const state = this.localWakeAdmissions.get(key)
    if (state?.reportedAt !== undefined) this.reportedAdmissionDiagnostics.delete(JSON.stringify([state.wake.request.id, state.reportedAt]))
    this.localWakeAdmissions.delete(key)
    this.restoringAdmissionWakes?.delete(key)
  }
  /** Reuse actual observations for this pending wake's own ancestry only.
   * A newer parsed body supersedes its old relation; an unrelated blob change
   * is not a parsed lifecycle/parent change. Released with the original wake. */
  private admissionTask(state: LocalWakeAdmission, taskId: string): TaskMetadata | undefined {
    const owned = this.loop.observedTask(taskId)
    if (owned) return owned
    const startup = this.taskMetadataIndex?.observed(taskId)
    if (startup) (state.taskFacts ??= new Map()).set(taskId, startup)
    return startup ?? state.taskFacts?.get(taskId)
  }
  private admissionParent(state: LocalWakeAdmission, child: TaskMetadata): TaskMetadata | undefined {
    const id = child.parent?.taskId
    if (!id) return undefined
    const owned = this.admissionTask(state, id)
    if (owned && linkedChild(owned, child)) return owned
    // The child's original binding may have read a newer parent after the
    // Host's last completed lane read. Reuse that actual reciprocal link.
    const bound = state.taskFacts?.get(id)
    return bound && (!owned || taskLifecycle(bound) === taskLifecycle(owned)) && linkedChild(bound, child) ? bound : owned
  }
  private rememberAdmissionAncestry(state: LocalWakeAdmission): void {
    let task = state.wake.request.taskId ? this.admissionTask(state, state.wake.request.taskId) : undefined
    const visited = new Set<string>()
    while (task && !visited.has(task.taskId)) {
      visited.add(task.taskId)
      task = this.admissionParent(state, task)
    }
    // An actually observed different parent/lifecycle does not retain the old
    // branch. This is the pending wake's chain, never a Task-tree cache/scan.
    for (const key of state.taskFacts?.keys() ?? []) if (!visited.has(key)) state.taskFacts!.delete(key)
  }
  private admissionControlRelation(state: LocalWakeAdmission, publication: AdmissionControlPublication): boolean | undefined {
    const request = state.wake.request, target = publication.task
    if (request.taskId === target.taskId) return taskLifecycle(request) === taskLifecycle(target)
    let child: TaskMetadata | undefined = request.taskId ? this.admissionTask(state, request.taskId) : undefined
    if (!child) return undefined
    if (taskLifecycle(child) !== taskLifecycle(request)) return false
    const visited = new Set([child.taskId])
    while (child?.parent) {
      const id: string = child.parent.taskId
      const parent: TaskMetadata | undefined = id === target.taskId ? target : this.admissionParent(state, child)
      if (!parent) return undefined
      if (!linkedChild(parent, child)) return id === target.taskId ? false : undefined
      if (visited.has(id)) throw new Error('Task parent association is cyclic: ' + id)
      visited.add(id)
      if (id === target.taskId) return true
      child = parent
    }
    return false
  }
  /** Only the authenticated UI's confirmed control is handed off. Reuse the
   * original CAS's complete Git control document, not a second remote query. */
  async taskControlPublished(task: TaskMetadata, intent: 'running' | 'paused' | 'cancelled', records?: readonly TaskControl[], terminal = false): Promise<void> {
    if (this.closed) return
    const publication: AdmissionControlPublication = { task, intent, records, terminal }
    await Promise.all([...this.localWakeAdmissions].filter(([, state]) => ['Planner', 'Worker', 'Organizer'].includes(state.wake.request.role))
      .map(([key, state]) => this.applyAdmissionControl(key, state, publication, true)))
  }
  private async applyAdmissionControl(key: string, state: LocalWakeAdmission, publication: AdmissionControlPublication, newlyPublished = false): Promise<void> {
    const relation = this.admissionControlRelation(state, publication)
    if (relation === false) {
      if (state.pendingControl === publication) state.pendingControl = undefined
      return
    }
    if (newlyPublished) state.controlVersion = (state.controlVersion ?? 0) + 1
    if (relation === undefined) {
      state.pendingControl = publication; this.clearLocalAdmissionInterval(key, state)
      return // Unknown relationship is not running permission.
    }
    const current = publication.records?.find(record => taskLifecycleKey(record) === taskLifecycleKey(publication.task))
    if (!publication.records || current && current.intent !== 'running') {
      if (publication.records || publication.intent !== 'running') state.held = true
      state.pendingControl = !publication.records && (publication.intent === 'running' || publication.terminal) ? publication : undefined
      this.clearLocalAdmissionInterval(key, state)
      return
    }
    // An old command replay can return its old result while the current CAS
    // document has a later resume. The current document, not input.intent, wins.
    const version = state.controlVersion, request = state.wake.request
    let previous: TaskMetadata | undefined
    const controls = await effectiveTaskStates(publication.records, [{ taskId: request.taskId!, lifecycleId: request.lifecycleId }], async id => {
      const task = id === publication.task.taskId ? publication.task
        : previous?.parent?.taskId === id ? this.admissionParent(state, previous) : this.admissionTask(state, id)
      previous = task
      return task ?? unreadTaskMetadata
    })
    if (this.closed || this.localWakeAdmissions.get(key) !== state || state.controlVersion !== version) return
    if (!controls.has(request.taskId!)) {
      state.pendingControl = publication; this.clearLocalAdmissionInterval(key, state); return
    }
    const control = controls.get(request.taskId!)
    state.held = !!control && control.intent !== 'running'; state.pendingControl = undefined
    if (state.held) this.clearLocalAdmissionInterval(key, state)
    this.checkWakeAdmissions()
  }
  private async recheckAdmissionControls(): Promise<void> {
    await Promise.all([...this.localWakeAdmissions].filter(([, state]) => state.pendingControl)
      .map(([key, state]) => this.applyAdmissionControl(key, state, state.pendingControl!)))
  }
  /** A successful cancellation builder identifies exactly which lifecycles it
   * changed. A replay without that result is not an invented confirmed family. */
  async taskCancellationPublished(task: TaskMetadata, confirmed?: { result: { cancelledTaskIds: string[] }; lifecycles: Record<string, string> }): Promise<void> {
    const targets = confirmed ? confirmed.result.cancelledTaskIds.map(taskId => ({ taskId, lifecycleId: confirmed.lifecycles[taskId] })) : [task]
    const publication: AdmissionControlPublication = { task, intent: 'cancelled', terminal: true }
    if (!confirmed) await this.taskControlPublished(task, 'cancelled', undefined, true)
    for (const [key, state] of this.localWakeAdmissions) if (targets.some(target => target.taskId === state.wake.request.taskId && taskLifecycle(target) === taskLifecycle(state.wake.request))) {
      state.controlVersion = (state.controlVersion ?? 0) + 1
      state.held = true; state.pendingControl = publication; this.clearLocalAdmissionInterval(key, state)
    }
  }
  private localAdmissionRecord(state: LocalWakeAdmission): WakeRecord['admission'] {
    return state.accepted ? undefined : state.eligibleSince !== undefined || state.reportedAt !== undefined ? {
      ...(state.eligibleSince !== undefined ? { eligibleSince: state.eligibleSince } : {}),
      ...(state.reportedAt !== undefined ? { reportedAt: state.reportedAt, diagnosticContext: state.diagnosticContext } : {}),
      ...(state.phase ? { phase: state.phase } : {}), ...(state.executionId ? { executionId: state.executionId } : {})
    } : undefined
  }
  private persistLocalAdmission(key: string, state: LocalWakeAdmission): void {
    this.startMaintenance('wake-admission-publication:' + state.wake.request.id, () =>
      withOperationChannel(this.files, 'host-poll-write', async () => {
        // A successful publication can overlap a local pause or send receipt.
        // Finish that same publication responsibility at its latest state;
        // never append a second queue entry on every observation tick.
        let captured: string | undefined, retained = true
        do {
          await this.updateWake(key, current => {
            if (!current || current.delivered || this.localWakeAdmissions.get(key) !== state) {
              retained = false
              if (this.localWakeAdmissions.get(key) === state) this.forgetAdmissionWake(key)
              return
            }
            const admission = this.localAdmissionRecord(state)
            captured = JSON.stringify(admission)
            if (JSON.stringify(current.admission) === captured) return
            return { ...current, admission }
          })
        } while (retained && !this.closed && this.localWakeAdmissions.get(key) === state && captured !== JSON.stringify(this.localAdmissionRecord(state)))
      }))
  }
  private clearLocalAdmissionInterval(key: string, state: LocalWakeAdmission): void {
    if (state.eligibleSince === undefined) return
    state.eligibleSince = undefined
    this.persistLocalAdmission(key, state)
  }
  private holdAdmissionOwnership(key: string): void {
    const state = this.localWakeAdmissions.get(key)
    if (state) { state.ownershipHeld = true; this.clearLocalAdmissionInterval(key, state) }
  }
  private localAdmissionHeld(state: LocalWakeAdmission): boolean {
    const request = state.wake.request, key = this.requestKey(request), record = this.roleRecords.get(key)
    const ownAdmission = !!record && (record.delivery?.request.id === request.id || state.executionId === record.identity.executionId)
    const task = request.taskId && this.admissionTask(state, request.taskId)
    const invalidTask = !!task && (taskLifecycle(task) !== taskLifecycle(request) || isTerminalTask(task))
    const terminal = request.taskId && this.observedTerminalTasks.get(taskLifecycleKey({ taskId: request.taskId, lifecycleId: request.lifecycleId }))
    return !!state.pendingControl || (['Planner', 'Worker', 'Organizer'].includes(request.role) && (invalidTask || !!terminal))
      || state.held === true || state.ownershipHeld === true || (request.role === 'Foreground' && !!this.pendingForegroundResets?.size)
      || (!!record && !ownAdmission && (this.active(record) || request.role === 'Foreground' && record.completedRound && !record.stopped))
      || (!!record && !record.stopped && this.gitPriorExecutions.has(record.identity.executionId))
      || (!!record && !record.businessTransferred && !record.stopped && !!(record.stopIntent || record.stopUnknown || this.stopOperations?.has(JSON.stringify([key, record.identity.executionId]))))
      || (request.role === 'Worker' && this.occupiedWorkerSeats(ownAdmission ? key : undefined, request.taskId, key) >= this.config.workerSeats)
  }
  /** Called from the existing one-second local Host observation. No Git await. */
  private checkWakeAdmissions(): void {
    if (this.closed) return
    const now = this.admissionNow()
    for (const [key, state] of this.localWakeAdmissions) {
      const request = state.wake.request, record = this.roleRecords.get(this.requestKey(request))
      if (state.accepted || record?.delivery?.request.id === request.id && record.delivery.confirmed) {
        state.accepted = true; this.clearLocalAdmissionInterval(key, state); continue
      }
      if (this.localAdmissionHeld(state)) { this.clearLocalAdmissionInterval(key, state); continue }
      if (state.eligibleSince === undefined) {
        if (!state.eligibleKnown) continue
        state.eligibleSince = now; this.persistLocalAdmission(key, state)
      }
      const progress = this.wakeAdmission(state.wake)
      state.executionId = progress?.executionId ?? state.executionId
      state.phase ??= progress?.phase ?? 'queued'
      if (state.reportedAt === undefined && now - state.eligibleSince >= 45_000) {
        state.reportedAt = now
        state.diagnosticContext = {
          kind: 'admission-timeout', wakeId: request.id, role: request.role, taskId: request.taskId,
          ...(record && state.executionId === record.identity.executionId ? { target: { ...record.identity } } : {}),
          workId: this.requestKey(request), executionId: state.executionId, phase: state.phase, eligibleSince: state.eligibleSince,
          facts: 'An eligible Host wake has not completed native admission within 45 seconds. Inspect this exact pending wake; this is not an AI execution time limit.'
        }
        this.persistLocalAdmission(key, state)
      }
      if (state.reportedAt === undefined || state.replayPending) continue
      const diagnosticId = JSON.stringify([request.id, state.reportedAt])
      if (this.reportedAdmissionDiagnostics.has(diagnosticId)) continue
      const context = state.diagnosticContext ?? { kind: 'admission-timeout', wakeId: request.id, role: request.role, taskId: request.taskId, workId: this.requestKey(request), executionId: state.executionId, phase: state.phase, eligibleSince: state.eligibleSince, facts: 'An eligible Host wake has not completed native admission within 45 seconds. Inspect this exact pending wake; this is not an AI execution time limit.' }
      const error = new Error(context.facts + ' ' + JSON.stringify(context))
      this.ctx.logger('deepseek-servant').error(error)
      this.environment.error(error, { role: request.role, ...(request.taskId ? { taskId: request.taskId } : {}),
        admissionTimeout: { helperWakeId: 'admission-timeout:' + request.id, context } })
      this.reportedAdmissionDiagnostics.add(diagnosticId)
    }
  }
  /** Existing remote wake/control discovery only refreshes facts. A pending
   * request cannot stop the local clock or another wake's observation. */
  private async observeWakeAdmissions(round?: FilesReadRound): Promise<void> {
    if (this.closed) return
    const version = this.admissionObservationVersion
    const previous = new Map([...this.localWakeAdmissions].map(([key, state]) => [key, { state, wake: state.wake }]))
    const rows = await listAuthorityInRound<WakeRecord>(this.records, this.prefix + 'wakes/', round)
    this.replaySafetyWakes(rows.map(row => row.value))
    this.environment.retrySafetyDelivery?.()
    const persistedTimeouts = new Set(rows.flatMap(({ value }) => [
      ...(value.safetyFaults ?? []), ...(value.safetyAttempts ?? []).map(attempt => attempt.fault),
      ...value.request.context?.safetyFault ? [value.request.context.safetyFault as SafetyFault] : []
    ]).flatMap(fault => fault.admissionTimeout ? [fault.admissionTimeout.helperWakeId] : []))
    const continuationOwners = new Set(rows.filter(row => !row.value.delivered && row.value.recovery).map(row => this.requestKey(row.value.request)))
    const adopted = new Set(rows.filter(row => !row.value.delivered && row.value.recovery?.replacesUnadmittedWake)
      .map(row => JSON.stringify([this.requestKey(row.value.request), row.value.recovery!.replacesUnadmittedWake])))
    const firstPending = new Map<string, string>()
    for (const { value } of rows) {
      const key = this.requestKey(value.request)
      if (value.delivered || adopted.has(JSON.stringify([key, value.request.id])) || (!value.recovery && continuationOwners.has(key))) continue
      if (!firstPending.has(key)) firstPending.set(key, value.request.id)
    }
    for (const row of rows) {
      if (this.closed) return
      const current = this.localWakeAdmissions.get(row.key), earlier = previous.get(row.key)
      // Keep confirmed current bodies, and reject an exact owner that ended
      // during the read. Unrelated writes must not discard cold discoveries.
      if (earlier && earlier.state !== current || current?.accepted) continue
      const wake = current && earlier?.wake !== current.wake ? current.wake : row.value
      const refreshUnknown = !current && version !== this.admissionObservationVersion
      const state = this.rememberAdmissionWake(row.key, wake)
      if (!state) continue
      this.startMaintenance('wake-admission-observation:' + wake.request.id, async () => {
        // Only an unknown row read concurrently with confirmed local changes
        // is ambiguous: it may already have completed. Resolve that one original
        // row, within its existing per-wake observation, instead of retaining
        // every completed key behind an indefinitely pending discovery read.
        // The provisional state has no eligibility; normal native admission
        // remains independent and can accept/remove it while this read waits.
        if (refreshUnknown) {
          const captured = state.wake
          let latest: WakeRecord | undefined
          try { latest = await this.records.get<WakeRecord>(row.key) }
          catch (error) {
            // A failed speculative discovery must not retain a deleted wake.
            // A real writer/admission that took this state over still owns it.
            if (this.localWakeAdmissions.get(row.key) === state && state.wake === captured
              && !state.eligibleKnown && !state.accepted) this.forgetAdmissionWake(row.key)
            throw error
          }
          if (this.closed || this.localWakeAdmissions.get(row.key) !== state || state.accepted) return
          // The original signal/wake writer may have confirmed a newer body
          // while this exact read waited, without replacing the observation.
          if (state.wake === captured) {
            if (!latest || latest.delivered) { this.forgetAdmissionWake(row.key); return }
            this.rememberAdmissionWake(row.key, latest)
          }
        }
        const wake = state.wake, request = wake.request, workId = this.requestKey(request)
        if (wake.helperSignal && !request.sources.some(source => source.path === wake.helperSignal)) {
          this.scheduleHelperSignal(wake)
          state.held = true; this.clearLocalAdmissionInterval(row.key, state); return
        }
        if (persistedTimeouts.has('admission-timeout:' + request.id) && state.reportedAt !== undefined) {
          this.reportedAdmissionDiagnostics.add(JSON.stringify([request.id, state.reportedAt]))
          state.replayPending = false
        } else if (state.replayPending) this.startMaintenance('wake-admission-replay:' + request.id, () =>
          withOperationChannel(this.files, 'host-poll-write', async () => {
            const restores = await this.records.list<RoleRestore>(this.prefix + 'restores/')
            if (this.closed || this.localWakeAdmissions.get(row.key) !== state) return
            if (restores.some(row => row.value.safetyFaults?.some(fault => fault.admissionTimeout?.helperWakeId === 'admission-timeout:' + request.id)))
              this.reportedAdmissionDiagnostics.add(JSON.stringify([request.id, state.reportedAt]))
            state.replayPending = false
            this.checkWakeAdmissions()
          }))
        if (firstPending.get(workId) !== request.id || (!wake.recovery && continuationOwners.has(workId))) {
          state.held = true; this.clearLocalAdmissionInterval(row.key, state); return
        }
        if (!await this.beforeTaskUse(request.taskId, false)) {
          state.held = true; this.clearLocalAdmissionInterval(row.key, state)
          ;(this.restoringAdmissionWakes ??= new Set()).add(row.key); return
        }
        if (this.files instanceof PhysicalLocalFiles && await this.taskRuntimeReleased(request)) { this.forgetAdmissionWake(row.key); return }
        const version = state.controlVersion, controlFacts = new Map<string, TaskMetadata>()
        // Local's original qualification already reads this ancestry. Reuse
        // only that successful view; no new metadata request or cold-start graph.
        const taskHeld = ['Planner', 'Worker', 'Organizer'].includes(request.role) && await this.controls.taskHeld(request.taskId, request.lifecycleId, task => controlFacts.set(task.taskId, task))
        if (this.closed || this.localWakeAdmissions.get(row.key) !== state || state.controlVersion !== version) return
        if (!state.pendingControl?.terminal) state.pendingControl = undefined
        const task = request.taskId && controlFacts.get(request.taskId)
        state.held = taskHeld || !!task && (taskLifecycle(task) !== taskLifecycle(request) || isTerminalTask(task)); state.eligibleKnown = true
        if (controlFacts.size) state.taskFacts = controlFacts
        else this.rememberAdmissionAncestry(state)
        const record = this.roleRecords.get(workId), confirmed = state.accepted || record?.delivery?.request.id === request.id && record.delivery.confirmed
        if (confirmed || this.localAdmissionHeld(state)) { this.clearLocalAdmissionInterval(row.key, state); return }
        // A previous process's interval is not evidence of this process's
        // present eligibility; restored and newly released waits start now.
        if (this.restoringAdmissionWakes?.delete(row.key)) state.eligibleSince = undefined
        if (state.eligibleSince === undefined) {
          state.eligibleSince = this.admissionNow(); this.persistLocalAdmission(row.key, state)
        }
        this.checkWakeAdmissions()
      })
    }
  }
  private admissionWakes(round?: FilesReadRound): Promise<Array<{ key: string; value: WakeRecord }>> {
    if (!(this.files instanceof PhysicalLocalFiles) || !(this.records instanceof DshStorageAdapter))
      return listAuthorityInRound<WakeRecord>(this.records, this.prefix + 'wakes/', round)
    const receipts = new Set<string>()
    for (const [key, request] of this.wakeWriteOwners) {
      const receipt = this.admissions?.get('retired-wake:' + key)
      if (!receipt || this.wakeWrites.get(key) !== receipt) continue
      const current = this.roleRecords.get(this.requestKey(request))
      if (!current?.businessTransferred) continue
      const retired = this.retiredWorkers?.get(current.identity.executionId)
      if (!retired || retired.identity.workId !== current.identity.workId
        || retired.sessionId !== current.sessionId || retired.generation !== current.generation
        || ![retired.delivery?.request.id, retired.lastWake?.id].includes(request.id)) continue
      // Only this exact, still-owned retirement receipt may be read at its
      // previously committed value. No pending input or successor write qualifies.
      receipts.add(key)
    }
    return this.records.listWithoutRetiredWakeReceiptWait<WakeRecord>(this.prefix + 'wakes/', receipts)
  }
  private startOwnedPump(round?: FilesReadRound): void {
    if (this.closed || this.queueing) return
    const operation = this.pump(false, round)
    // Attach once per owned flight, not once per discovery tick while it is held.
    void operation.catch(error => this.error(error))
  }
  private pump(waitForAdmissions = true, round?: FilesReadRound): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (!this.queueing) {
      const scan = Promise.resolve().then(() => { if (!this.closed) return this.runQueue(false, undefined, false, round) })
      this.queueing = scan
      void scan.finally(() => { if (this.queueing === scan) this.queueing = undefined }).catch(() => { })
      const operation = scan.then(() => this.settleOperations([...(this.admissions?.values() ?? [])], 'Native admissions failed'))
      this.pumping = operation
      void operation.finally(() => { if (this.pumping === operation) this.pumping = undefined }).catch(() => { })
    }
    return waitForAdmissions ? this.pumping! : this.queueing!;
  }
  private async settleOperations(operations: Promise<unknown>[], message: string): Promise<void> {
    const failures = (await Promise.allSettled(operations)).filter((item): item is PromiseRejectedResult => item.status === 'rejected').map(item => item.reason)
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, message)
  }
  private async serialWork<T>(workId: string, operation: () => Promise<T>): Promise<T> {
    const operations = this.workOperations ??= new Map()
    // Explicit role boundary: event callbacks and admissions can arrive under
    // a refresh or another role's context. Never inherit that caller's lane.
    const pending = (operations.get(workId) ?? Promise.resolve()).catch(() => undefined).then(() =>
      withOperationChannel(this.files, workId === this.roleKey('Foreground') ? 'foreground-read' : workId === this.roleKey('Helper') ? 'host-poll-write' : 'read', operation))
    operations.set(workId, pending)
    try { return await pending }
    finally { if (operations.get(workId) === pending) operations.delete(workId) }
  }
  /** A stopped execution needs its own recovery action, not another execution's
   * in-flight publication. Keep the full committed view for cold-start actions
   * whose execution observation pending receipt has already been cleared. */
  private admissionObservationActions(identity: WorkIdentity): Promise<Array<{ key: string; value: ObservationRecord }>> {
    const prefix = this.prefix + 'observations/'
    if (!(this.files instanceof PhysicalLocalFiles) || !(this.records instanceof DshStorageAdapter))
      return this.records.list<ObservationRecord>(prefix)
    const unrelatedWrites = new Set([...this.observationRecordWrites]
      .filter(([, write]) => write.identity.workId !== identity.workId || write.identity.executionId !== identity.executionId)
      .map(([key]) => key))
    return this.records.listWithoutUnrelatedObservationWriteWait<ObservationRecord>(prefix, unrelatedWrites)
  }
  private async confirmAdoptedWakes(request: RoleWake, recovery?: WakeRecovery): Promise<void> {
    // Confirm only the exact adopted ancestry, and only after real native input
    // acceptance. A failed/unknown child must leave every ancestor pending.
    const adoptedIds = new Set<string>([request.id])
    let adoptedId = recovery?.replacesUnadmittedWake
    while (adoptedId && !adoptedIds.has(adoptedId)) {
      adoptedIds.add(adoptedId)
      let parentId: string | undefined
      await this.updateWake(this.prefix + 'wakes/' + hash(adoptedId), current => {
        if (!current || this.requestKey(current.request) !== this.requestKey(request)) return undefined
        parentId = current.recovery?.replacesUnadmittedWake
        return { ...current, delivered: true, admission: undefined }
      })
      adoptedId = parentId
    }
  }
  private runQueue(helperOnly = false, onlyWakeId?: string, waitForAdmissions = true, round?: FilesReadRound): Promise<void> {
    // Discover the shared queue on the work lane before serialWork selects each
    // admitted role. resumeTask/pump may be called by a Foreground user action.
    return withOperationChannel(this.files, helperOnly ? 'host-poll-write' : 'read', () => this.runQueueInChannel(helperOnly, onlyWakeId, waitForAdmissions, round))
  }
  private async runQueueInChannel(helperOnly = false, onlyWakeId?: string, waitForAdmissions = true, round?: FilesReadRound): Promise<void> {
    const operations: Promise<void>[] = []
    const admissions = this.admissions ??= new Map<string, Promise<void>>()
    const startedWork = new Set<string>()
    const queued = await this.admissionWakes(round)
    this.replaySafetyWakes(queued.map(row => row.value))
    const continuationOwners = new Set(queued.filter(row => !row.value.delivered && row.value.recovery)
      .map(row => this.requestKey(row.value.request)))
    const continuedInputs = new Set(queued.filter(row => !row.value.delivered && row.value.recovery).flatMap(row =>
      [row.value.recovery?.original?.request.id, row.value.recovery?.replacesUnadmittedWake]
        .filter((id): id is string => id !== undefined && id !== row.value.request.id)
        .map(id => JSON.stringify([this.requestKey(row.value.request), id]))))
    for (const row of queued) {
      if (this.waitingSafetyResolution(row.value)) continue
      if (row.value.helperSignal && !row.value.request.sources.some(source => source.path === row.value.helperSignal)) continue
      if ((helperOnly && row.value.request.role !== 'Helper') || (onlyWakeId && row.value.request.id !== onlyWakeId)) continue
      if (continuedInputs.has(JSON.stringify([this.requestKey(row.value.request), row.value.request.id]))) continue
      if (this.closed) return
      if (row.value.delivered) continue
      if (this.transferredWorkerWake(row.value)) {
        if (!(this.files instanceof PhysicalLocalFiles)) {
          await this.updateWake(row.key, current => current ? { ...current, delivered: true, admission: undefined } : undefined)
          continue
        }
        // This retired input owns only its exact receipt, not another Task's
        // native admission or a new Worker round at the same work identity.
        const receiptKey = 'retired-wake:' + row.key
        let receipt = admissions.get(receiptKey)
        if (!receipt) {
          receipt = this.updateWake(row.key, current => current ? { ...current, delivered: true, admission: undefined } : undefined)
          admissions.set(receiptKey, receipt)
          const owned = receipt
          void owned.finally(() => { if (admissions.get(receiptKey) === owned) admissions.delete(receiptKey) }).catch(() => {})
          if (!waitForAdmissions) void owned.catch(error => this.error(error, { wakeId: row.value.request.id, role: row.value.request.role }))
        }
        operations.push(receipt)
        continue
      }
      const workId = this.requestKey(row.value.request)
      if (!row.value.recovery && continuationOwners.has(workId)) continue
      if (this.workOperations?.has(workId) && !startedWork.has(workId)) continue
      startedWork.add(workId)
      const operation: Promise<void> = this.serialWork(workId, async () => {
        if (this.closed) return
        const currentWake = await this.records.get<WakeRecord>(row.key)
        if (this.closed || !currentWake || currentWake.delivered) return
        if (!await this.beforeTaskUse(currentWake.request.taskId) || this.closed) return
        row.value = currentWake
        if (this.requestKey(currentWake.request) !== workId) return
        if ((await this.admissionWakes()).some(item =>
          !item.value.delivered && this.requestKey(item.value.request) === workId
          && item.value.recovery?.replacesUnadmittedWake === currentWake.request.id)) return
        const confirmedInput = this.roleRecords.get(workId)?.delivery
        if (currentWake.recovery && confirmedInput?.confirmed && confirmedInput.request.id === currentWake.request.id) {
          await this.confirmAdoptedWakes(currentWake.request, currentWake.recovery)
          await this.updateWake(row.key, current => current ? { ...current, delivered: true, admission: undefined } : undefined)
          return
        }
        if (currentWake.recovery?.replacesUnadmittedWake) {
          const original = await this.records.get<WakeRecord>(this.prefix + 'wakes/' + hash(currentWake.recovery.replacesUnadmittedWake))
          if (original?.delivered) {
            await this.confirmAdoptedWakes(currentWake.request, currentWake.recovery)
            await this.updateWake(row.key, current => current ? { ...current, delivered: true, admission: undefined } : undefined)
            return
          }
        }
        if (this.closed) return
        try {
          const request = row.value.request, key = this.requestKey(request)
          if (key !== workId) return
          if (request.role === 'Organizer') {
            if (!request.taskId) throw new Error('Organizer admission requires one O Task.')
          }
          if (request.role === 'Foreground' && this.pendingForegroundResets?.size) return
          const admissionBeforeControl = this.localWakeAdmissions.get(row.key)
          const controlVersion = admissionBeforeControl?.controlVersion
          const heldBusiness = ['Planner', 'Worker', 'Organizer'].includes(request.role) && await this.controls.taskHeld(request.taskId, request.lifecycleId);
          const observedAdmission = this.localWakeAdmissions.get(row.key)
          const controlStillCurrent = observedAdmission === admissionBeforeControl && observedAdmission?.controlVersion === controlVersion
          if (observedAdmission && controlStillCurrent) {
            observedAdmission.held = heldBusiness
            if (heldBusiness) this.clearLocalAdmissionInterval(row.key, observedAdmission)
          }
          if (heldBusiness) {
            const current = this.roleRecords.get(key)
            if (current && this.active(current)) return
              ;
            const task = request.taskId && await withSnapshot(this.files, (snapshot) => readJson<TaskMetadata>(this.files, snapshot, paths.task(request.taskId!)));
            if (task && (task.status === "cancelled" || taskLifecycle(task) !== taskLifecycle(request))) {
              if (current && taskLifecycle(current.identity) === taskLifecycle(request) && !current.stopped) this.trackedStop(current);
              await this.updateWake(row.key, current => current ? { ...current, delivered: true, admission: undefined } : undefined)
            }
            return
              ;
          }
          let record = this.roleRecords.get(key)
          if (record) this.assertOrganizerBusiness(record, request)
          if (record && this.active(record)) return
          if (record?.identity.role === 'Foreground' && !row.value.recovery && !record.stopped) {
            await this.finishForegroundRound(record)
            record = this.roleRecords.get(key)
            if (record?.completedRound && !record.stopped) { this.holdAdmissionOwnership(row.key); return }
            if (record?.completedRound && record.delivery?.request.id === request.id) {
              await this.updateWake(row.key, current => current ? { ...current, delivered: true, admission: undefined } : undefined)
              return
            }
          }
          if (request.role === 'Recorder' && request.taskId) {
            const task = await withSnapshot(this.files, (snapshot) => readJson<TaskMetadata>(this.files, snapshot, paths.task(request.taskId!)));
            this.rememberTerminalTask(task);
            if (task?.status === "cancelled" && taskLifecycle(task) === taskLifecycle(request) && !await this.cancelledBusinessStopped(task)) { this.holdAdmissionOwnership(row.key); return }
              ;
          }
          const checkSources = request.reason === 'notification' && request.sources.length > 0
          const checkTask = request.taskId && ['Planner', 'Worker', 'Organizer', 'Recorder'].includes(request.role)
          if (checkSources || checkTask) {
            const retired = await withSnapshot(this.files, async (snapshot) => {
              if (checkSources) {
                const wanted = new Set(request.sources.map(source => source.path))
                let present = false
                if (this.files instanceof PhysicalLocalFiles && wanted.size === 1) {
                  present = !!await this.files.fileMetadata(request.sources[0]!.path)
                } else {
                  const directories = new Set(request.sources.map(source => source.path.slice(0, source.path.lastIndexOf('/') + 1)))
                  for (const directory of directories) {
                    if ((await this.files.listDirectory(snapshot, directory)).some(entry => wanted.has(entry.path))) { present = true; break }
                  }
                }
                if (!present) return true
              }
              if (!checkTask) return false
              if (await this.manuallyCleared(request.taskId, snapshot)) return true
              const task = await readJson<TaskMetadata>(this.files, snapshot, paths.task(request.taskId!));
              if (!task && await readTaskHistoryIdentity(this.files, snapshot, request.taskId!)) return true
              if (task && taskLifecycle(task) !== taskLifecycle(request)) return true;
              if (request.role === 'Recorder') return !!task && (!!task.parent || task.owner !== this.config.member || !isTerminalTask(task));
              if (task && isTerminalTask(task)) return true;
              if (request.role === 'Organizer') return !!task && (task.route !== 'O' || task.owner !== this.config.member)
              if (task?.route !== 'P' && task) {
                if (record && !record.stopped) this.trackedStop(record)
                return true
              }
              const member = await readMemberStatus(this.files, snapshot, paths.memberStatus(request.taskId!, this.config.member));
              return member?.state === 'complete'
            });
            if (retired) {
              await this.updateWake(row.key, current => current ? { ...current, delivered: true, admission: undefined, ...(request.role === 'Helper' ? { signalsConsumed: true } : {}) } : undefined)
              return
            }
          }
          if (record && !record.businessTransferred && !record.stopped && this.stopOperations?.has(JSON.stringify([key, record.identity.executionId]))) {
            if (!this.trackedStop(record)) { this.holdAdmissionOwnership(row.key); return }
            record = this.roleRecords.get(key)
          }
          if (record && !record.businessTransferred && (record.stopIntent || record.stopUnknown) && !record.stopped) {
            this.holdAdmissionOwnership(row.key)
            const result = await this.stopOwnedRecord(record)
            if (result.status === 'superseded') return
            if (result.status === 'unconfirmed') {
              await this.saveRole({ ...record, stopUnknown: result })
              throw new Error(result.reason)
            }
            await this.saveRole({ ...record, stopped: true })
            record = this.roleRecords.get(key)
          }
          if (row.value.recovery && record?.businessTransferred) {
            await this.updateWake(row.key, current => current ? { ...current, delivered: true, admission: undefined } : undefined); return
          }
          if (row.value.recovery && record && !row.value.recovery.confirmedStoppedExecutions?.includes(record.identity.executionId)) {
            this.holdAdmissionOwnership(row.key)
            const stopped = record.stopped ? { status: ("stopped" as const) } : await this.stopOwnedRecord(record);
            if (stopped.status === 'superseded') return
            if (stopped.status === 'unconfirmed') { await this.saveRole({ ...record, stopUnknown: stopped }); throw new Error(stopped.reason) }
            row.value.recovery = {
              ...row.value.recovery,
              confirmedStoppedExecutions: [...(row.value.recovery.confirmedStoppedExecutions ?? []), record.identity.executionId]
            }
            await this.updateWake(row.key, current => current && !current.delivered ? { ...current, recovery: row.value.recovery } : undefined)
            await this.saveRole({ ...record, stopped: true })
            record = this.roleRecords.get(key)
          }
          if (record?.stopped && (await this.admissionObservationActions(record.identity)).some((row) => !row.value.complete && row.value.stopStarted
            && row.value.pending.action.identity.workId === key && row.value.pending.action.identity.executionId === record!.identity.executionId)) { this.holdAdmissionOwnership(row.key); return }
          if (this.closed) return
          if (request.role === 'Worker') {
            // Reserve synchronously before any durable write or native factory await.
            // The same work owns one seat across opening, sending and active execution.
            if (this.occupiedWorkerSeats(key, request.taskId) >= this.config.workerSeats) return
              ; (this.workerAdmissions ??= new Set()).add(key)
              ; (this.workerAdmissionTasks ??= new Map()).set(key, request.taskId ?? key)
          }
          const admission = this.rememberAdmissionWake(row.key, row.value)
          if (admission && !admission.accepted && (admission !== admissionBeforeControl || controlStillCurrent)) {
            admission.held = false; admission.ownershipHeld = false; admission.eligibleKnown = true
            admission.eligibleSince ??= this.admissionNow()
            admission.phase = 'admitting'
          }
          if (request.reason === 'startup-recovery' && request.taskId && ['Planner', 'Worker'].includes(request.role)) {
            const taskId = request.taskId, member = this.config.member
            // This is the existing member recovery marker, published only after
            // admission/stop/capacity checks, never a new signal or role handshake.
            if (this.files instanceof PhysicalLocalFiles) await this.publishPhysicalMemberRecovery('startup-member-recovery:' + request.id, { taskId, member, lifecycleId: request.lifecycleId })
            else await this.transactions.run('startup-member-recovery:' + request.id, { taskId, member }, { reevaluate: true, taskOwner: this.taskCommandOwner(request) }, async snapshot => {
              if (await this.manuallyCleared(taskId, snapshot) || await readTaskCleanupRecord(this.files, snapshot, taskId)) return []
              const task = await readJson<TaskMetadata>(this.files, snapshot, paths.task(taskId))
              const status = await readMemberStatus(this.files, snapshot, paths.memberStatus(taskId, member))
              const inbox = await this.files.read(snapshot, paths.inbox(taskId, member))
              if (task?.status !== 'running' || status?.state === 'complete' || !inbox?.length) return []
              return [{ path: paths.state(member, taskId) + '/recovery', content: '' }]
            })
          }
          // A normal Host close ends its Agent, not an unanswered native question.
          // Resume that exact session only after confirmed stop and absent user stop.
          const questionSession = record?.stopped && (record.identity.role === 'Foreground'
            || !!record.identity.taskId && (record.identity.role === 'Planner' || record.identity.role === 'Worker' || record.identity.role === 'Recorder')) && !record.completedRound
            && !await this.controls.execution(record.identity)
            && (await new DshSessionReader(this.ctx).inspect(record.sessionId)).unansweredQuestionCallIds?.length
            ? record.sessionId : undefined
          const createdForAdmission = !record || record.stopped || record.businessTransferred;
          if (!record || record.stopped || record.businessTransferred) {
            record = {
              ...(request.context?.notificationClaims as Record<string, NotificationClaim> | undefined) || (!record?.completedRound && !record?.businessTransferred && record?.notificationClaims) ? { notificationClaims: { ...(!record?.completedRound && !record?.businessTransferred ? record?.notificationClaims : {}), ...(request.context?.notificationClaims as Record<string, NotificationClaim> | undefined) } } : {}, identity: {
                workId: key,
                executionId: randomUUID(),
                role: request.role,
                ...request.lifecycleId ? { lifecycleId: request.lifecycleId } : {},
                ...(request.taskId && !['Foreground', 'Helper'].includes(request.role) ? { taskId: request.taskId } : {}),
                ...(request.taskId && (request.role === 'Planner' || request.role === 'Worker') ? { member: this.config.member } : {}),
                ...(request.workerId ? { workerId: request.workerId } : {})
              }, sessionId: questionSession ?? 'dss-' + randomUUID(), generation: (record?.generation ?? 0) + 1
            };
          }
          if (record.stopUnknown) throw new Error('Native producer stop is unconfirmed: ' + record.stopUnknown.reason)
          if (this.config.mode === 'git' && this.gitPriorExecutions.has(record.identity.executionId) && !record.stopped)
            throw new Error('Prior Git execution has no confirmed native stop; its accepted responsibility remains pending reconciliation.')
          let recoveryInput: unknown
          if (request.taskId && request.sources.some(source => source.path.split('/').at(-1)?.endsWith('_Helper'))) {
            const path = this.recoveryInputPath(request.taskId, this.config.member, request.role)
            try {
              recoveryInput = await withSnapshot(this.files, snapshot => readJson<TaskMetadata>(this.files, snapshot, path))
              if (recoveryInput === undefined) recoveryInput = { path, unavailable: 'Diagnostic input is absent; inspect the known notification sources and current task facts.' }
            } catch (error) {
              recoveryInput = { path, unavailable: error instanceof Error ? error.message : String(error) }
            }
          }
          const messageId = 'dss-wake-' + hash(request.id)
          const previousRecord = this.roleRecords.get(key)
          const previousDelivery = previousRecord?.identity.executionId === record.identity.executionId ? previousRecord.delivery : undefined
          const text = row.value.recovery?.explanationText ?? (previousDelivery?.messageId === messageId && previousDelivery.text !== undefined ? previousDelivery.text : JSON.stringify({
            taskId: request.taskId,
            reason: request.reason,
            sources: request.sources,
            context: request.context,
            ...(request.taskId ? { taskMetadataPath: paths.task(request.taskId) } : {}),
            ...(request.role === 'Organizer' && request.taskId ? { organizerNotePath: paths.run(request.taskId) + '/Organizer_Note.md', dispatchPath: paths.run(request.taskId) + '/Dispatch.md' } : {}),
            ...request.role === 'Planner' && request.taskId ? { workerExecutions: this.plannerWorkerExecutions({ role: 'Planner', taskId: request.taskId, member: this.config.member, lifecycleId: request.lifecycleId }) } : {},
            ...(recoveryInput ? { recoveryInput } : {}),
            availableMembers: this.environment.members(),
            resources: this.environment.resources(),
            workerSeats: this.config.workerSeats
          }));
          if (row.value.recovery && row.value.recovery.explanationText === undefined) {
            row.value.recovery = { ...row.value.recovery, explanationText: text }
            await this.updateWake(row.key, current => current && !current.delivered ? { ...current, recovery: row.value.recovery } : undefined)
          }
          const taskWorkspace = record.identity.taskId ? await this.workspaces.ensure(record.identity.taskId) : void 0;
          if (taskWorkspace) record = { ...record, taskWorkspace };
          await this.saveRole({ ...record, delivery: { request, messageId, text, confirmed: false } }, false, 'prepare')
          const cancelledAdmission = async (beforeOpen = false) => {
            if (!request.taskId || !['Planner', 'Worker', 'Organizer'].includes(request.role)) return false;
            const task = await withSnapshot(this.files, (snapshot) => readJson<TaskMetadata>(this.files, snapshot, paths.task(request.taskId!)));
            if (task?.status !== "cancelled" && (!task || taskLifecycle(task) === taskLifecycle(request))) return false;
            const current = this.roleRecords.get(key)
            if (current?.identity.executionId === record.identity.executionId) {
              if (beforeOpen && createdForAdmission) await this.saveRole({ ...current, stopped: true });
              else this.trackedStop(current);
            }
            await this.updateWake(row.key, current => current ? { ...current, delivered: true, admission: undefined } : undefined)
            return true;
          };
          const binding = this.binding(record, request)
          if (request.role === 'Helper' && !row.value.helperSignal && binding.recordPath) {
            const path = binding.recordPath
            if (this.files instanceof PhysicalLocalFiles) await this.files.createIfAbsent(path, '')
            else await this.transactions.run('helper-debug/' + hash(request.id), { path }, { reevaluate: true, gitReplay: 'session-only' },
              async snapshot => await this.files.read(snapshot, path) === undefined ? [{ path, content: '' }] : [])
          }
          if (taskWorkspace) binding.taskWorkspace = taskWorkspace;
          const resume = await this.gateway.exists(record.sessionId)
          if (this.closed) return
          if (await cancelledAdmission(true)) return
            ;
          if (admission) { admission.phase = 'opening'; admission.executionId = record.identity.executionId }
          const agent = await this.native.open(record.identity, {
            sessionId: record.sessionId,
            cwd: taskWorkspace?.directory ?? this.config.workspace,
            taskWorkspace: taskWorkspace?.directory,
            presetId: this.config.presetId,
            model: (request.role === 'Foreground' ? this.config.foreground : this.config.background ?? this.config.foreground) ?? this.config.model,
            resume,
            setup: (scope, actual) => {
              const errorTurn = createRoleErrorTurnContext(record.identity);
              let safetyOccurrence = this.environment.safetyOccurrence?.() ?? 0
              const process2 = request.role === 'Foreground' ? new DshForegroundProcessTracker(record.sessionId, actual.session.snapshotEvents()) : void 0;
              if (process2) {
                this.foregroundProcesses.set(record.identity.executionId, process2);
                scope.effect(() => () => {
                  this.foregroundProcesses.delete(record.identity.executionId);
                }, "dss.foreground.process");
                scope.on("agent/assistant-stream", (event) => {
                  const current = this.roleRecords.get(key)
                  if (event.agent !== actual || this.closed || current?.identity.executionId !== record.identity.executionId || current.sessionId !== String(actual.session.id)) return
                    ;
                  if (process2.acceptStream(event.frame)) this.environment.changed?.()
                });
              }
              scope.on("session/event", (session, event) => {
                if (session !== actual.session) return
                const processOwner = this.roleRecords.get(key);
                if (process2 && processOwner?.identity.executionId === record.identity.executionId && processOwner.sessionId === String(actual.session.id) && process2.acceptSession(event)) {
                  this.environment.changed?.()
                  if (event.type === "assistant/message" || event.type === "tool/result" || event.type === "turn/end")
                    this.saveForegroundProcessGroups(processOwner, process2);
                }
                errorTurn.observe(event)
                if (event.type === 'turn/start') safetyOccurrence = this.environment.safetyOccurrence?.() ?? safetyOccurrence
                if (request.role === 'Foreground' && (event.type === 'turn/start' || event.type === "turn/end")) {
                  const current = this.roleRecords.get(key)
                  if (!this.closed && current?.identity.executionId === record.identity.executionId && current.sessionId === String(actual.session.id)) {
                    this.environment.changed?.()
                  }
                }
              });
              if (row.value.recovery) scope.systemPrompt.section({
                name: 'deepseek-servant:recovery-input', order: 102, interpolate: false,
                text: 'Continue the accepted responsibility from the original input below, available native session history and current Task material. The original input is historical context, not permission to repeat already committed effects. Recovery facts: ' + JSON.stringify({ ...request.context, originalInput: request.context?.originalInput ?? row.value.recovery.original?.text, originalWake: request.context?.originalWake ?? row.value.recovery.original?.request.id })
              })
              scope.on("agent/status", (event) => {
                if (event.agent !== actual) return
                if (request.role === 'Foreground') {
                  const current = this.roleRecords.get(key)
                  if (this.closed || current?.identity.executionId !== record.identity.executionId || current.sessionId !== String(actual.session.id)) return
                    ;
                }
                this.environment.changed?.()
                if (request.role !== 'Foreground' && actual.status === 'idle' && !this.closed) {
                  void this.serialWork(key, async () => {
                    const current = this.roleRecords.get(key)
                    if (current?.identity.executionId === record.identity.executionId && !current.stopped && !current.stopIntent) await this.finishGitAuxiliaryRound(current)
                  }).catch(error => this.error(error));
                }
                if (request.role === 'Foreground' && actual.status === 'idle' && !this.closed) {
                  void this.serialWork(key, async () => {
                    if (this.closed) return
                    const stop = this.stopOperations?.get(JSON.stringify([key, record.identity.executionId]));
                    if (stop && !stop.settled) await stop.promise
                    const current = this.roleRecords.get(key)
                    if (!this.closed && current?.identity.executionId === record.identity.executionId) await this.finishForegroundRound(current)
                  }).catch((error) => this.error(error, { identity: record.identity, stage: 'foreground-round-retirement' }));
                }
              });
              scope.on("agent/error", (event) => {
                if (event.agent !== actual) return
                errorTurn.capture(event.error, event.turn)
                this.error(event.error, { identity: record.identity, turn: event.turn, step: event.step, safetyOccurrence });
              });
              const skills = installFrameworkSkillProvider(scope, actual, this.files, {
                channel: binding.role === 'Foreground' ? 'foreground-read' : 'read',
                taskKey: () => {
                  const current = this.roleRecords.get(record.identity.workId);
                  const wake = current?.delivery?.request ?? current?.lastWake ?? request
                  return wake.taskId ?? binding.direct?.inputPath ?? wake.id
                }
              });
              this.skillProviders.set(record.identity.executionId, skills);
              scope.effect(() => async () => {
                this.skillProviders.delete(record.identity.executionId);
                await skills.dispose()
              }, "dss.framework.skills");
              return installFrameworkRoleTools(scope, actual, binding, { ...this.services(), errorTaskSelected: errorTurn.selectTask })
            }
          });
          if (this.closed) return
          const recovery = row.value.recovery
          if (recovery?.original && recovery.original.messageId !== messageId) {
            const original = recovery.original
            const closedPredecessor = recovery.targetExecutionId !== undefined && recovery.confirmedStoppedExecutions?.includes(recovery.targetExecutionId)
              && record.identity.executionId !== recovery.targetExecutionId
            const evidence = closedPredecessor ? undefined : (await new DshSessionReader(this.ctx).inputs(record.sessionId)).get(original.messageId)
            if (!closedPredecessor && !(original.confirmed && evidence === undefined) && evidence?.state !== 'consumed' && evidence?.state !== 'queued' && !(evidence?.state === 'claimed' && evidence.active)) {
              if (!(recovery.targetExecutionId !== undefined && recovery.confirmedStoppedExecutions?.includes(recovery.targetExecutionId))) throw new Error('Original recovery input has no confirmed prior execution stop.')
              const originalText = evidence?.text ?? original.text
              if (originalText === undefined) throw new Error('Original native recovery input body is unavailable; preserve its responsibility for diagnosis.')
              if (evidence && original.text !== undefined && original.text !== evidence.text) throw new Error('Original recovery input body conflicts with its saved identity.')
              if (await cancelledAdmission()) return
                ;
              await agent.send(originalText, original.messageId, 'followup', 'deepseek-servant')
            }
            const originalKey = this.prefix + 'wakes/' + hash(original.request.id)
            const originalWake = await this.records.get<WakeRecord>(originalKey)
            if (originalWake) await this.updateWake(originalKey, current => current ? { ...current, delivered: true, admission: undefined } : undefined)
          }
          if (this.closed) return
          if (await cancelledAdmission()) return
            ;
          if (request.role === 'Foreground' && request.sources.length && !agent.hasMessage(messageId)) {
            const notices = this.foregroundNoticeState(record.identity.executionId)
            for (const source of request.sources) notices.set(source.path, { version: source.version, messageId, delivered: true })
          }
          if (request.taskId && ['Planner', 'Worker', 'Organizer'].includes(request.role) && !agent.hasMessage(messageId)) {
            for (const source of request.sources) this.rememberTaskNotice(agent, source, { version: source.version, messageId, delivered: true })
          }
          if (admission) admission.phase = 'sending'
          await agent.send(text, messageId, recovery ? 'steer' : 'followup', 'deepseek-servant', recovery ? {
            replayInactiveClaim: (recovery.targetExecutionId !== undefined && recovery.confirmedStoppedExecutions?.includes(recovery.targetExecutionId)) === true,
          } : undefined)
          const acceptedAdmission = this.localWakeAdmissions.get(row.key)
          if (acceptedAdmission) { this.admissionObservationVersion++; acceptedAdmission.accepted = true; this.clearLocalAdmissionInterval(row.key, acceptedAdmission) }
          const currentAfterSend = this.roleRecords.get(key)
          if (currentAfterSend?.identity.executionId === record.identity.executionId && !currentAfterSend.businessTransferred)
            await this.saveRole({ ...record, lastWake: request, delivery: { request, messageId, confirmed: true } }, false, 'confirm')
          await this.confirmAdoptedWakes(request, recovery)
          await this.updateWake(row.key, current => current ? { ...current, delivered: true, admission: undefined } : undefined)
        } catch (error) {
          const executionId = row.value.admission?.executionId ?? this.roleRecords.get(workId)?.identity.executionId
          const cancellation = executionId && this.admissionCancellations.get(executionId)
          if (cancellation === undefined || (error !== cancellation && !(error instanceof Error && error.name === 'AbortError' && error.cause === cancellation)
            && !(error instanceof DshAgentCreationCancelled && error.executionStopped && error.reason === cancellation)))
            this.error(error, { wakeId: row.value.request.id, role: row.value.request.role })
        } finally {
          if (admissions.get(workId) === operation) { this.workerAdmissions?.delete(workId); this.workerAdmissionTasks?.delete(workId) }
        }
      });
      admissions.set(workId, operation)
      operations.push(operation)
      void operation.finally(() => { if (admissions.get(workId) === operation) admissions.delete(workId) }).catch(() => { })
      if (!waitForAdmissions) void operation.catch(error => this.error(error, { wakeId: row.value.request.id, role: row.value.request.role }))
    }
    if (waitForAdmissions) await this.settleOperations(operations, 'Native admissions failed')
  }
  // Delivery deduplication only. STATE remains authoritative; consuming or
  // observing a marker absent permits the same path/empty blob to notify again.
  private foregroundNotices?: { executionId: string; signals: Map<string, { version: string; messageId: string; delivered: boolean }> }
  private foregroundNoticeState(executionId: string) {
    if (this.foregroundNotices?.executionId !== executionId)
      this.foregroundNotices = { executionId, signals: new Map() }
    return this.foregroundNotices.signals
  }
  private forgetForegroundNotices(binding: FrameworkRoleBinding, signals: readonly string[]): void {
    if (binding.role !== 'Foreground' || this.foregroundNotices?.executionId !== binding.executionId) return
    for (const path of signals) this.foregroundNotices.signals.delete(path)
  }
  private notifyForeground(sources: RoleWake['sources']): Promise<void> {
    return this.serialWork(this.roleKey('Foreground'), async () => {
      const record = this.roleRecords.get(this.roleKey('Foreground'))
      if (this.closed || !this.config.primary || this.pendingForegroundResets?.size || !record || !this.active(record)
        || record.stopped || record.released || record.completedRound || record.stopIntent || record.stopUnknown) return
      const owned = this.native.get(record.identity.workId, record.identity.executionId)
      if (!owned || owned.sessionId !== record.sessionId) return
      const notices = this.foregroundNoticeState(record.identity.executionId)
      const present = new Set(sources.map(source => source.path))
      for (const path of notices.keys()) if (!present.has(path)) notices.delete(path)
      for (const source of sources) {
        let notice = notices.get(source.path)
        if (!notice || notice.version !== source.version) {
          notice = { version: source.version, messageId: 'dss-foreground-notice-' + randomUUID(), delivered: false }
          notices.set(source.path, notice)
        }
        if (notice.delivered) continue
        // inject uses the native non-waking inbox. It does not cancel a tool,
        // consume a STATE marker, impose a reply gate or choose the next action.
        await owned.send(JSON.stringify({ reason: 'notification', sources: [source], context: {
          notificationOnly: true,
          instructions: 'A Foreground signal is available. This online notice only means there is a message; you may keep your current reading and work rhythm and choose when to consume it with the existing tools. It is not an instruction to interrupt, revise an answer or finish the task.'
        } }), notice.messageId, 'inject', 'deepseek-servant')
        notice.delivered = true
      }
    })
  }
  // Ephemeral delivery deduplication follows the actual native handle. Retired
  // handles cannot hold the replacement's notices or become a permanent index.
  private readonly taskNotices = new WeakMap<OwnedDshAgent, TaskNoticeState>()
  private readonly taskNoticeObservations = new WeakMap<object, number>()
  private taskNoticeClock = 0
  private taskNoticeState(owned: OwnedDshAgent): TaskNoticeState {
    let state = this.taskNotices.get(owned)
    if (!state) { state = { consumedAt: this.taskNoticeClock, signals: new Map(), consumptions: new Map() }; this.taskNotices.set(owned, state) }
    return state
  }
  private rememberTaskNotice(owned: OwnedDshAgent, source: { path: string; version: string }, notice: TaskNotice): void {
    const state = this.taskNoticeState(owned)
    state.signals.set(source.path, notice)
    // The observed deletion may still be waiting for publication while this
    // already-discovered notice arrives. It belongs to that same observation.
    for (const consumed of state.consumptions.values()) {
      const selected = consumed.get(source.path)
      if (selected?.version === source.version) selected.notices.add(notice)
    }
  }
  private taskNotificationOwner(request: TaskRoleNotification | DirectRoleNotification, target: RoleRecord, owned: OwnedDshAgent): boolean {
    const directId = 'directId' in request ? request.directId : undefined
    const taskId = 'taskId' in request ? request.taskId : undefined
    const workId = this.roleKey(request.role, taskId, request.workerId, directId), current = this.roleRecords.get(workId)
    const observedAt = this.taskNoticeObservations.get(request.observation)
    return observedAt !== undefined && this.taskNoticeState(owned).consumedAt <= observedAt
      && !this.closed && !!current && current.identity.executionId === target.identity.executionId
      && current.sessionId === target.sessionId && owned.sessionId === target.sessionId
      && current.identity.role === request.role && current.identity.taskId === taskId
      && current.identity.workerId === request.workerId && (directId !== undefined || taskLifecycle(current.identity) === taskLifecycle('taskId' in request ? request : {}))
      && (directId !== undefined || request.role === 'Organizer' || current.identity.member === this.config.member)
      && !current.stopped && !current.released && !current.completedRound && !current.businessTransferred
      && !current.stopIntent && !current.stopUnknown && this.active(current)
      && this.native.get(workId) === owned && this.native.get(workId, target.identity.executionId) === owned
  }
  /** Only the original signal's completed, current-process claim or a real
   * later persisted claim distinguishes a new delivery from the original. */
  private async notifyDirect(request: DirectRoleNotification): Promise<void> {
    const workId = this.roleKey(request.role, undefined, request.workerId, request.directId)
    const record = this.roleRecords.get(workId), wake = record?.delivery?.request ?? record?.lastWake
    const owned = record && this.native.get(workId, record.identity.executionId)
    if (!record || !wake || !owned) return
    const signals = new Set(wake.sources.filter(source => source.path.startsWith('state/') && source.path.split('/').at(-1) !== 'recovery').map(source => source.path))
    if (!signals.size || !request.sources.some(source => signals.has(source.path))) return
    const first = this.wakeConsumptions.get(record.identity.executionId)
    const consumed = first?.wakeId === wake.id && first.completed
      || Object.values(record.notificationClaims ?? {}).some(claim => claim.wakeId === wake.id)
    if (!consumed || this.roleRecords.get(workId)?.identity.executionId !== record.identity.executionId) return
    this.scheduleTaskNotification(request)
  }
  private scheduleTaskNotification(request: TaskRoleNotification | DirectRoleNotification): void {
    const workId = this.roleKey(request.role, 'taskId' in request ? request.taskId : undefined, request.workerId, 'directId' in request ? request.directId : undefined), target = this.roleRecords.get(workId)
    const owned = target && this.native.get(workId, target.identity.executionId)
    if (!target || !owned || !this.taskNotificationOwner(request, target, owned)) return
    // Worker transfer releases this work lane while its old handle is retiring.
    // An old flush must not occupy the replacement execution's maintenance key.
    this.startMaintenance('task-notification:' + JSON.stringify([workId, target.identity.executionId]),
      () => this.notifyTask(request, target, owned), { identity: target.identity })
  }
  private notifyTask(request: TaskRoleNotification | DirectRoleNotification, target: RoleRecord, owned: OwnedDshAgent): Promise<void> {
    return this.serialWork(target.identity.workId, async () => {
      if (!this.taskNotificationOwner(request, target, owned)) return
      const notices = this.taskNoticeState(owned).signals
      const present = new Set(request.sources.map(source => source.path))
      for (const path of notices.keys()) if (!present.has(path)) notices.delete(path)
      for (const source of request.sources) {
        if (!this.taskNotificationOwner(request, target, owned)) return
        let notice = notices.get(source.path)
        if (!notice || notice.version !== source.version) {
          notice = { version: source.version, messageId: 'dss-task-notice-' + randomUUID(), delivered: false }
          this.rememberTaskNotice(owned, source, notice)
        }
        if (notice.delivered) continue
        await owned.send(JSON.stringify({ reason: 'notification', sources: [source], context: {
          notificationOnly: true,
          instructions: 'directId' in request
            ? 'A signal for this direct item is available. Keep your current work rhythm and consume it with the existing tools before final handoff. This notice does not interrupt work or consume the signal.'
            : 'A signal for this Task role is available. This online notice only means there is a message; keep your current work rhythm and consume it with the existing tools. It does not interrupt work, consume the signal or replace the existing checks before final handoff.'
        } }), notice.messageId, 'inject', 'deepseek-servant')
        // Consumption may already have removed this exact object. Never insert
        // it again, and never update a newer notice or replacement execution.
        notice.delivered = true
      }
    })
  }
  private taskNoticeConsumption(binding: FrameworkRoleBinding, commandId: string) {
    const owned = (binding.direct && ['Planner', 'Worker'].includes(binding.role)
      || binding.taskId && !binding.direct && ['Planner', 'Worker', 'Organizer'].includes(binding.role))
      ? this.native.get(binding.workId, binding.executionId) : undefined
    const state = owned && this.native.get(binding.workId) === owned ? this.taskNoticeState(owned) : undefined
    return {
      observe: (source: { path: string; version: string }) => {
        if (!state) return
        let consumed = state.consumptions.get(commandId)
        if (!consumed) { consumed = new Map(); state.consumptions.set(commandId, consumed) }
        let selected = consumed.get(source.path)
        if (!selected) { selected = { version: source.version, notices: new Set() }; consumed.set(source.path, selected) }
        const notice = state.signals.get(source.path)
        if (notice?.version === selected.version) selected.notices.add(notice)
      },
      finish: (selectedPath?: string) => {
        if (!state) return
        const consumed = state.consumptions.get(commandId)
        if (!consumed) return
        // Only the original deletion attempt records these objects. Replaying
        // an old receipt does not run its builder or erase a later same-path notice.
        let settled = false
        for (const [path, selected] of consumed) {
          if (selectedPath !== undefined && path !== selectedPath) continue
          const notice = state.signals.get(path)
          if (notice && selected.notices.has(notice)) state.signals.delete(path)
          consumed.delete(path); settled = true
        }
        // Host may dispatch its old snapshot only after this consumption has
        // confirmed. Its existing observation token cannot recreate old dedup.
        if (settled) state.consumedAt = ++this.taskNoticeClock
        if (!consumed.size) state.consumptions.delete(commandId)
      }
    }
  }
  private finishForegroundRound(record: RoleRecord): Promise<void> {
    return withOperationChannel(this.files, 'foreground-read', () => this.finishForegroundRoundInChannel(record))
  }
  private async finishForegroundRoundInChannel(record: RoleRecord): Promise<void> {
    if (record.identity.role !== 'Foreground' || this.active(record)) return
    if ((record.stopped || record.stopIntent?.phase === 'disposed') && !record.completedRound) return
    const stop = this.stopOperations?.get(JSON.stringify([record.identity.workId, record.identity.executionId]))
    if (stop && (!stop.settled || stop.result?.status !== 'stopped')) return
    const current = this.roleRecords.get(record.identity.workId)
    if (current?.identity.executionId !== record.identity.executionId) return
    if (!record.completedRound) {
      const sessions = new DshSessionReader(this.ctx)
      const completed = this.records instanceof GitAuthorityStore ? new NativeCommandSuccess(new Set([
        'dss_record', 'dss_submit_task', 'dss_supplement_task', 'dss_workspace_reference',
      ])) : undefined
      const inspection = await sessions.inspect(record.sessionId, completed?.accept)
      if (!inspection.lifecycleKnown || !inspection.lastTurn?.closed || inspection.lastTurn.reason !== 'completed'
        || inspection.unansweredQuestionCallIds?.length || inspection.unresolvedToolCallIds.length || inspection.queuedInbox.nextTurn.length || inspection.queuedInbox.nextStep.length) return
      if (record.delivery && (await sessions.inputs(record.sessionId)).get(record.delivery.messageId)?.state !== 'consumed') return
      if (this.roleRecords.get(record.identity.workId)?.identity.executionId !== record.identity.executionId) return
      if (this.files instanceof PhysicalLocalFiles)
        await retirePhysicalPublicationsFromEvents(this.files, record.identity.executionId, await sessions.events(record.sessionId))
      // Turn completion retires the native execution only. All visible replies
      // already have their own explicit conversation-send transaction/receipt.
      await this.saveRole({ ...record, completedRound: true }, false, undefined, false, completed?.callIds().map(id => record.sessionId + ':' + id))
      const saved = this.roleRecords.get(record.identity.workId)
      if (saved?.identity.executionId !== record.identity.executionId) return
      record = saved
    }
    this.trackedStop(record)
  }
  private helperTaskOwner(request: RoleWake): { taskId: string; lifecycleId?: string } | undefined {
    if (request.role !== 'Helper') return
    const identity = (request.context?.target ?? request.context?.identity) as { taskId?: string; lifecycleId?: string } | undefined
    const taskId = request.taskId ?? identity?.taskId ?? request.context?.taskId
    if (typeof taskId !== 'string') return
    return { taskId, lifecycleId: request.lifecycleId ?? identity?.lifecycleId }
  }
  private helperResponsibilities(record: RoleRecord, currentTaskWakes = true): RoleWake[] {
    if (record.identity.role !== 'Helper') return []
    const initial = record.delivery?.request ?? record.lastWake
    return [...new Map([...(initial ? [initial] : []),
      ...(currentTaskWakes ? [...this.taskHelperWakes?.values() ?? []].filter(wake => wake.delivered && wake.signalsConsumed).map(wake => wake.request) : []),
      ...Object.values(record.notificationClaims ?? {}).flatMap(claim => claim.helperWakes ?? [])]
      .map(request => [request.id, request] as const)).values()]
  }
  private binding(record: RoleRecord, request: RoleWake): FrameworkRoleBinding {
    this.assertOrganizerBusiness(record, request)
    const identity = record.identity, base: FrameworkRoleBinding = {
      ...identity, owner: this.config.member, collaborationId: this.config.collaborationId,
      ...(identity.role === 'Helper' ? { helperNotifications: this.helperResponsibilities(record) } : {}),
      ...(record.notificationClaims ? { claimedNotifications: Object.values(record.notificationClaims).map(claim => ({ taskId: claim.taskId, signals: [...new Set([...claim.initialSignals, ...claim.sources.map(source => source.path)])] })) } : {})
    }
    const direct = request.sources.map((source) => ({ source, direct: parseDirectSignal(source.path.split('/').at(-1)!) })).find(value => value.direct);
    if (direct?.direct) return { ...base, direct: { inputPath: direct.direct.inputPath, signalPath: direct.source.path }, recordPath: direct.direct.recordPath }
    if (identity.taskId && identity.member) {
      base.stateDirectory = paths.state(identity.member, identity.taskId)
      base.recordPath = paths.member(identity.taskId, identity.member) + '/Planner_Memory.md'
      if (identity.role === 'Worker' && identity.workerId) {
        const child = workerPaths(identity.taskId, identity.member, identity.workerId)
        base.recordPath = child.notes; base.notePath = child.notes; base.replyPath = child.reply; base.generation = record.generation
      }
    }
    if (identity.role === 'Foreground') base.recordPath = this.conversation.foregroundRoot + '/Foreground_Cache.md'
    if (identity.role === 'Helper') {
      const target = request.context?.target as { taskId?: string } | undefined
      const taskId = request.taskId ?? target?.taskId ?? (typeof request.context?.taskId === 'string' ? request.context.taskId : undefined)
      base.recordPath = typeof request.context?.helperDebugPath === 'string' ? request.context.helperDebugPath : helperDebugPath(taskId, new Date().toISOString().slice(0, 10))
    }
    return base;
  }
  async notifications(snapshot: FilesSnapshot, binding: FrameworkRoleBinding, selectedTaskId?: string): Promise<string[]> {
    if (binding.direct) return await this.files.read(snapshot, binding.direct.signalPath) === undefined ? [] : [binding.direct.signalPath]
    if (binding.role === 'Organizer' && !binding.taskId) throw new Error('Organizer notifications require one bound O Task.')
    const taskId = binding.taskId ?? selectedTaskId
    if (binding.role === 'Foreground') {
      return (await this.conversation.routeForegroundSignals(
        await this.files.listDirectory(snapshot, 'state/', { namePrefix: 'Foreground_' }))).map(entry => entry.path);
    }
    if (binding.role === 'Helper') {
      const prefix = 'Helper_' + encodeURIComponent(this.config.member).replaceAll('_', '%5F') + '_'
      return (await this.files.listDirectory(snapshot, 'state/', { namePrefix: prefix }))
        .filter(entry => helperSignalWakeHash(entry.path, this.config.member)).map(entry => entry.path)
    }
    if (!taskId) return []
    if (binding.role === 'Organizer') {
      const task = await readJson<TaskMetadata>(this.files, snapshot, paths.task(taskId))
      if (!task || task.owner !== this.config.member) return []
      return (await this.files.listDirectory(snapshot, paths.state(this.config.member, taskId), { namePrefix: 'Organizer_' })).map(entry => entry.path)
    }
    const selection = binding.role === 'Worker'
      ? (binding.workerId === undefined ? undefined : { workerId: binding.workerId })
      : { namePrefix: binding.role + '_', ...(binding.role === 'Recorder' ? { names: ['Recorder'] } : {}) }
    const entries = await this.files.listDirectory(snapshot, paths.state(this.config.member, taskId), selection)
    // Preserve the old unbound Worker grammar; bound Workers carry an exact ID.
    return (binding.role === 'Worker' && binding.workerId === undefined
      ? entries.filter(entry => signalWorkerId(entry.path.split('/').at(-1)!) === undefined) : entries).map(entry => entry.path);
  }
  private addressedSignals(binding: FrameworkRoleBinding): Array<{ path: string; version: string }> {
    const record = this.roleRecords.get(binding.workId)
    if (!record || record.identity.executionId !== binding.executionId) throw new Error('Signal consumption belongs to a replaced execution.')
    const sources = (record.delivery?.request ?? record.lastWake)?.sources.filter(source => source.path.startsWith('state/') && source.path.split('/').at(-1) !== 'recovery') ?? []
    return sources
  }
  private consumeWakeSignals(binding: FrameworkRoleBinding, settledClaims?: Map<string, string>): Promise<{ signals: string[] }> {
    const record = this.roleRecords.get(binding.workId)
    if (!record || record.identity.executionId !== binding.executionId) return Promise.reject(new Error('Signal consumption belongs to a replaced execution.'))
    const wake = record.delivery?.request ?? record.lastWake
    if (!wake) return Promise.reject(new Error('This execution has no accepted wake.'))
    const addressed = this.addressedSignals(binding)
    const identity = binding.executionId, existing = this.wakeConsumptions.get(identity)
    if (existing?.wakeId === wake.id) return existing.promise
    const assertLiveOwner = () => {
      const current = this.roleRecords.get(binding.workId)
      if (current) this.assertOrganizerBusiness(current)
      if (this.closed || binding.role === 'Foreground' && !this.config.primary || !current
        || current.identity.executionId !== binding.executionId || current.stopped || current.released || current.businessTransferred)
        throw new Error('Signal continuation belongs to an ended or replaced execution.')
    }
    const operation = Promise.resolve().then(async () => {
      const sources = binding.role === 'Foreground' ? await this.conversation.routeForegroundSignals(addressed) : addressed
      const signals = [...new Set(sources.map(source => source.path))].sort()
      for (const [id, claim] of Object.entries(record.notificationClaims ?? {})) {
        const signature = settledClaims ? JSON.stringify(claim) : undefined
        await this.settleNotificationClaim(claim, async snapshot => {
          const current = this.records instanceof GitAuthorityStore ? await this.records.getAt<RoleRecord>(snapshot, this.roleRecordPath(binding.workId)) : this.roleRecords.get(binding.workId)
          if (!current || current.identity.executionId !== binding.executionId || current.stopped || current.released || current.businessTransferred)
            throw new Error('Signal continuation belongs to an ended or replaced execution.')
        }, assertLiveOwner, binding)
        if (signature !== undefined) settledClaims!.set(id, signature)
      }
      if (!signals.length) return { signals }
      const originalWake = typeof wake.context?.originalWake === 'string' ? wake.context.originalWake : wake.id
      const commandId = 'consume-wake/' + hash(JSON.stringify([this.config.member, originalWake, signals]))
      const notices = this.taskNoticeConsumption(binding, commandId)
      if (this.files instanceof PhysicalLocalFiles) {
        const files = this.files
        // The accepted wake already owns these exact signal observations. Each
        // file is consumed separately; an interrupted prefix can be retried
        // from that same wake without deleting a newer publication at a path.
        await withSnapshot(files, async snapshot => {
          assertLiveOwner()
          if (binding.taskId ?? wake.taskId) await assertTaskLifecycle(files, snapshot, binding.taskId ?? wake.taskId!, binding)
          for (const source of sources) {
            await files.deleteObserved(source.path, source.version, () => { assertLiveOwner(); notices.observe(source) })
            // A false result means this exact Local observation is already
            // absent or replaced. Release only its own pending notice objects.
            notices.finish(source.path)
          }
        })
        if (binding.role === 'Foreground') this.forgetForegroundNotices(binding, signals)
        if (binding.role === 'Helper') await this.updateWake(this.prefix + 'wakes/' + hash(wake.id), current => current ? { ...current, signalsConsumed: true } : undefined)
        return { signals }
      }
      if (binding.role === 'Foreground') {
        await this.conversation.claimForegroundSignals(commandId, signals, assertLiveOwner)
        this.forgetForegroundNotices(binding, signals)
        return { signals }
      }
      await this.transactions.run(commandId, { signals }, { reevaluate: true, beforeAttempt: assertLiveOwner, taskOwner: this.taskCommandOwner(binding.taskId ? binding : wake) }, async (snapshot) => {
        if (binding.taskId ?? wake.taskId) await assertTaskLifecycle(this.files, snapshot, binding.taskId ?? wake.taskId!, binding);
        const changes: Array<{ path: string; content: null }> = []
        for (const source of sources) {
          const directory = source.path.slice(0, source.path.lastIndexOf('/') + 1)
          const actual = (await this.files.listDirectory(snapshot, directory, { paths: [source.path] })).find(entry => entry.path === source.path)
          if (!actual) continue
          if (actual.version !== source.version) continue
          notices.observe(source)
          changes.push({ path: source.path, content: null })
        }
        return changes
      });
      notices.finish()
      if (binding.role === 'Helper') await this.updateWake(this.prefix + 'wakes/' + hash(wake.id), current => current ? { ...current, signalsConsumed: true } : undefined)
      return { signals }
    });
    const accepted = { wakeId: wake.id, promise: operation, completed: false }
    this.wakeConsumptions.set(identity, accepted)
    void operation.then(() => { if (this.wakeConsumptions.get(identity) === accepted) accepted.completed = true },
      () => { if (this.wakeConsumptions.get(identity) === accepted) this.wakeConsumptions.delete(identity) })
    return operation
  }
  private claimCurrentNotifications(binding: FrameworkRoleBinding, commandId: string): Promise<{ signals: string[]; taskId?: string; claimedNotifications?: ClaimedNotificationContext[]; helperNotifications?: RoleWake[] }> {
    if (this.closed) return Promise.reject(new Error('Role runtime is closed.'))
    if (!["Foreground", "Planner", "Worker", "Organizer", "Helper"].includes(binding.role)) return this.consumeWakeSignals(binding)
    if (binding.role === "Foreground" && !this.config.primary) throw new Error("Only the primary Foreground may adopt shared notifications.");
    const workId = binding.workId
    this.notificationClaimWrites ??= new Map()
    const operation = (this.notificationClaimWrites.get(workId) ?? Promise.resolve()).catch(() => { }).then(async () => {
      const owns = (record: RoleRecord | undefined) => {
        if (binding.role === "Foreground" && (this.closed || !this.config.primary)) throw new Error("Primary Foreground notification ownership is no longer active.");
        if (!record || record.identity.executionId !== binding.executionId || record.stopped || record.released || record.businessTransferred || record.completedRound || record.stopIntent || record.stopUnknown)
          throw new Error('Signal claim belongs to an ended, stopping, or replaced execution.')
        this.assertOrganizerBusiness(record)
        return record
      };
      const assertLiveOwner = () => {
        if (this.closed) throw new Error('Role runtime is closed.')
        owns(this.roleRecords.get(workId))
      }
      const retryContext = this.notificationContextRetries?.get(workId)
      if (retryContext) {
        await (retryContext.executionId === binding.executionId ? retryContext.run() : retryContext.retire(binding.executionId))
        if (this.notificationContextRetries.get(workId) === retryContext) this.notificationContextRetries.delete(workId)
      }
      const key = this.roleRecordPath(workId)
      const assertOwner = async (snapshot: FilesSnapshot) => owns((this.records as GitAuthorityStore) instanceof GitAuthorityStore
        ? await (this.records as GitAuthorityStore).getAt<RoleRecord>(snapshot, key) : this.roleRecords.get(workId))
      const result = (claim: NotificationClaim) => ({        
signals: [...new Set([...claim.initialSignals, ...claim.sources.map(source => source.path)])],
        ...(!binding.taskId && claim.taskId ? { taskId: claim.taskId } : {}), ...(claim.claimedNotifications?.length ? { claimedNotifications: claim.claimedNotifications } : {}), ...(binding.role === 'Helper' ? { helperNotifications: this.helperResponsibilities(record) } : {})      
})
      let record = owns(this.roleRecords.get(workId))
      if ((this.records as GitAuthorityStore) instanceof GitAuthorityStore) {
        await this.withRoleWrite(workId, async () => {
          record = owns(await (this.records as GitAuthorityStore).get<RoleRecord>(key));
          this.roleRecords.set(workId, record)
            ;
          (this.roleBases ??= new Map()).set(workId, structuredClone(record))
        });
      }
      const saved = record.notificationClaims?.[commandId]
      if (saved) { await this.settleNotificationClaim(saved, assertOwner, assertLiveOwner, binding); this.forgetForegroundNotices(binding, saved.sources.map(source => source.path)); return result(saved) }
      const wake = record.delivery?.request ?? record.lastWake
      if (!wake) throw new Error('This execution has no accepted wake.')
      const taskId = binding.role === "Foreground" || binding.role === "Helper" ? void 0 : binding.taskId ?? wake.taskId;
      const alreadyConsumed = (this.wakeConsumptions.get(binding.executionId)?.wakeId === wake.id) || Object.values(record.notificationClaims ?? {}).some(claim => claim.wakeId === wake.id)
      // Reuse only settlements completed in this call; an authoritative reread may add or change a claim.
      const settledClaims = new Map<string, string>()
      const initial = await this.consumeWakeSignals(binding, this.records instanceof GitAuthorityStore && binding.role === "Helper" ? settledClaims : undefined)
      if (!taskId && !binding.direct && binding.role !== "Foreground" && binding.role !== "Helper") return initial
      for (const [id, prior] of Object.entries(record.notificationClaims ?? {})) {
        const signature = JSON.stringify(prior)
        if (settledClaims.get(id) !== signature) {
          await this.settleNotificationClaim(prior, assertOwner, assertLiveOwner, binding)
          settledClaims.set(id, signature)
        }
      }
      const operationId = 'consume-later/' + hash(commandId)
      const select = async (snapshot: FilesSnapshot) => {
        if (taskId) await assertTaskLifecycle(this.files, snapshot, taskId, binding);
        if (binding.role === 'Worker' && !binding.direct) await this.assertWorkerOwnsBusiness(binding, snapshot)
        const selected = alreadyConsumed ? await this.notifications(snapshot, binding, taskId) : []
        const sources: Array<{ path: string; version: string }> = []
        for (const path of [...new Set(selected)].sort()) {
          const source = this.files instanceof PhysicalLocalFiles ? await this.files.fileMetadata(path)
            : (await this.files.listDirectory(snapshot, path.slice(0, path.lastIndexOf('/') + 1), { paths: [path] })).find(item => item.path === path)
          if (source) sources.push({ path: source.path, version: source.version })
        }
        // Earlier inputs retain their original immutable claims; a new claim
        // stores only the Helper notifications selected by this invocation.
        const helperWakes: RoleWake[] = []
        if (binding.role === 'Helper') {
          const candidates = sources.splice(0)
          for (const source of candidates) {
            const suffix = helperSignalWakeHash(source.path, this.config.member)
            if (!suffix) continue
            // Use the same Host notification path for role-authored signals.
            // They need not have a generated wake key before discovery. Its
            // existing owner lookup/notification deduplication supplies the
            // original accepted request; do not invent diagnostic context.
            const resolved: { value?: WakeRecord } = {}
            await this.wake({ id: suffix, role: 'Helper', reason: 'notification', sources: [source] },
              undefined, undefined, undefined, selected => { resolved.value = selected })
            const original = resolved.value
            if (!original || original.request.role !== 'Helper' || original.signalsConsumed || original.delivered
              || original.recovery || this.wakeAdmission(original)?.executionId) continue
            // Native replacement/admission is not an ordinary later claim.
            // Its signal remains for its existing stop/confirmation path.
            const prior = helperWakes.find(item => item.id === original.request.id)
            const accepted = { ...original.request, sources: [...(prior?.sources ?? original.request.sources).filter(item => item.path !== source.path), source] }
            if (prior) helperWakes[helperWakes.indexOf(prior)] = accepted
            else helperWakes.push(accepted)
            sources.push(source)
            this.replaySafetyWake(original)
          }
        }
        const otherTasks = new Map<string | undefined, Set<string>>()
        for (const prior of Object.values(record.notificationClaims ?? {})) if (prior.taskId !== taskId) {
          const paths = otherTasks.get(prior.taskId) ?? new Set<string>()
          for (const path of [...prior.initialSignals, ...prior.sources.map(source => source.path)]) paths.add(path)
          otherTasks.set(prior.taskId, paths)
        }
        const claimedNotifications = [...otherTasks].map(([taskId, paths]) => ({ taskId, signals: [...paths].sort() }))
        return { ...(helperWakes.length ? { helperWakes } : {}), ...(claimedNotifications.length ? { claimedNotifications } : {}), commandId: operationId, lifecycleId: binding.lifecycleId, executionId: binding.executionId, wakeId: wake.id, taskId, initialSignals: binding.role === 'Helper' ? initial.signals : [...new Set([...initial.signals, ...Object.values(record.notificationClaims ?? {}).filter(claim => claim.taskId === taskId).flatMap(claim => [...claim.initialSignals, ...claim.sources.map(source => source.path)])])], sources };
      };
      let selectedClaim: NotificationClaim = await withSnapshot(this.files, select)
      // No later notification was selected. The original wake has already been
      // consumed above; there is no further signal mutation to journal or settle.
      if (!selectedClaim.sources.length) return result(selectedClaim)
      if ((this.records as GitAuthorityStore) instanceof GitAuthorityStore) {
        const authority = (this.records as GitAuthorityStore)
        const persistContext = () => this.withRoleWrite(workId, async () => {
          await authority.updateOwned<RoleRecord, RoleRecord>(key, 'notification-context:' + commandId, current => {
            const owned = owns(current)
            if (owned.notificationClaims?.[commandId]) return { write: false, result: owned }
            if ((owned.delivery?.request ?? owned.lastWake)?.id !== wake.id) throw new Error('Signal claim wake changed before context persistence.')
            const value = ({ ...owned, notificationClaims: { ...owned.notificationClaims, [commandId]: selectedClaim } })
            return { write: true, value, result: value }
          }, JSON.stringify([binding.executionId, wake.id, taskId]), false, true, undefined, assertLiveOwner)
          record = owns(await authority.get<RoleRecord>(key))
          this.roleRecords.set(workId, record)
            ;
          (this.roleBases ??= new Map()).set(workId, structuredClone(record))
          selectedClaim = record.notificationClaims![commandId];
        });
        this.notificationContextRetries ??= new Map()
        const retryContext = {          
executionId: binding.executionId, run: persistContext,
          retire: (executionId: string) => this.withRoleWrite(workId, async () => {
            // Resolve the old non-destructive context write first. A newer
            // authoritative owner makes its old prepared CAS unable to publish.
            await authority.updateOwned<RoleRecord, void>(key, 'notification-context:' + commandId, current => {
              if (!current || current.identity.executionId !== executionId || current.identity.executionId === binding.executionId)
                throw new Error('Signal context replacement is not authoritative.')
              return { write: false, result: undefined }
            }, JSON.stringify([binding.executionId, wake.id, taskId]))
          })        
}
        this.notificationContextRetries.set(workId, retryContext)
        await persistContext()
        if (this.notificationContextRetries.get(workId) === retryContext) this.notificationContextRetries.delete(workId)
      } else {
        const current = owns(this.roleRecords.get(workId))
        if ((current.delivery?.request ?? current.lastWake)?.id !== wake.id) throw new Error('Signal claim wake changed before context persistence.')
        await this.saveRole(current, false, undefined, false, undefined, { id: commandId, value: selectedClaim })
        record = owns(this.roleRecords.get(workId))
      }
      this.wakeConsumptions.delete(binding.executionId)
      for (const [id, claim] of Object.entries(record.notificationClaims ?? {})) {
        if (settledClaims.get(id) !== JSON.stringify(claim)) await this.settleNotificationClaim(claim, assertOwner, assertLiveOwner, binding)
      }
      this.forgetForegroundNotices(binding, selectedClaim.sources.map(source => source.path))
      return result(selectedClaim)
    });
    this.notificationClaimWrites.set(workId, operation)
    void operation.finally(() => { if (this.notificationClaimWrites.get(workId) === operation) this.notificationClaimWrites.delete(workId) }).catch(() => { })
    return operation
  }
  private withRoleWrite<T>(workId: string, action: () => Promise<T>): Promise<T> {
    const writes = this.roleWrites ??= new Map()
    const operation = (writes.get(workId) ?? Promise.resolve()).catch(() => { }).then(action)
    const tail = operation.then(() => { })
    writes.set(workId, tail)
    void tail.finally(() => { if (writes.get(workId) === tail) writes.delete(workId) }).catch(() => { })
    return operation
  }
  private async settleNotificationClaim(claim: NotificationClaim, assertOwner: (snapshot: FilesSnapshot) => Promise<unknown>, beforeAttempt: () => void, binding: FrameworkRoleBinding): Promise<void> {
    // Older Hosts persisted empty later selections. They contain accepted context,
    // not pending signal mutations, and must not require a receipt-only commit.
    if (!claim.sources.length) return
    // A pre-fix Local execution may already have saved another collaboration's
    // global Foreground source. Its historical Session remains its own, but a
    // resumed claim cannot delete that other domain's still-pending file.
    const selectedSources = binding.role === 'Foreground' && this.config.mode === 'local'
      ? await this.conversation.routeForegroundSignals(claim.sources) : claim.sources
    if (!selectedSources.length) return
    const notices = this.taskNoticeConsumption(binding, claim.commandId)
    const settleHelperWakes = async () => {
      for (const request of claim.helperWakes ?? []) {
        const source = request.sources.find(source => selectedSources.some(selected => selected.path === source.path && selected.version === source.version))
        if (!source) continue
        await this.updateWake(this.prefix + 'wakes/' + hash(request.id), current => current?.request.id === request.id && !current.recovery && !this.wakeAdmission(current)?.executionId
          ? { ...current, request: { ...current.request, sources: request.sources }, delivered: true, signalsConsumed: true, admission: undefined } : undefined)
      }
    }
    if (this.files instanceof PhysicalLocalFiles) {
      const files = this.files
      // The original persisted claim is the continuation fact, not a new ACK
      // or command receipt. Missing/already-consumed and newer files are left
      // alone; failure affects only this claim and not other roles or tasks.
      await withSnapshot(files, async snapshot => {
        beforeAttempt()
        await assertOwner(snapshot)
        if (claim.taskId) await assertTaskLifecycle(files, snapshot, claim.taskId, claim)
        for (const source of selectedSources) {
          await files.deleteObserved(source.path, source.version, () => { beforeAttempt(); notices.observe(source) })
          notices.finish(source.path)
        }
      })
      await settleHelperWakes()
      return
    }
    await this.transactions.run(claim.commandId, { claim }, { reevaluate: true, beforeAttempt, taskOwner: this.taskCommandOwner(claim) }, async (snapshot) => {
      await assertOwner(snapshot)
      if (claim.taskId) await assertTaskLifecycle(this.files, snapshot, claim.taskId, claim);
      const changes: FileChange[] = []
      for (const source of selectedSources) {
        const current = (await this.files.listDirectory(snapshot, source.path.slice(0, source.path.lastIndexOf('/') + 1), { paths: [source.path] })).find(item => item.path === source.path)
        if (current?.version === source.version) { notices.observe(source); changes.push({ path: source.path, content: null }) }
      }
      return changes
    });
    notices.finish()
    await settleHelperWakes()
  }
  private assertWorkerBusinessLive(binding: FrameworkRoleBinding, transferring = false): void {
    if (binding.role !== 'Worker') return
    const current = this.roleRecords.get(binding.workId)
    if (!current || current.identity.executionId !== binding.executionId || current.businessTransferred || current.stopped || current.released
      || transferring && (current.identity.role !== 'Worker' || current.stopUnknown || current.stopIntent))
      throw new Error('This Worker execution has transferred or ended its business responsibility.')
  }
  private async assertWorkerOwnsBusiness(binding: FrameworkRoleBinding, snapshot: FilesSnapshot): Promise<void> {
    if (binding.taskId) await assertTaskLifecycle(this.files, snapshot, binding.taskId, binding);
    this.assertWorkerBusinessLive(binding)
    if (binding.role !== 'Worker') return
    await assertWorkerBusiness(this.files, snapshot, this.workerBusinessScope(), binding)
  }
  private async cleanupWorkerTransfers(taskId: string, lifecycleId?: string): Promise<void> {
    const records = [...this.retiredWorkers?.values() ?? []].filter((record) => record.identity.taskId === taskId && taskLifecycle(record.identity) === (lifecycleId ?? ""));
    if (records.some(record => !record.stopped)) throw new Error('Task has a retired Worker whose native producer is not stopped.')
    if (!records.length) return
    const ids = records.map(record => record.identity.executionId).sort()
    await Promise.all(ids.map(id => this.roleWrites?.get('retired:' + id)))
    if (this.files instanceof PhysicalLocalFiles) {
      const files = this.files
      for (const record of records) await this.withRoleWrite('retired:' + record.identity.executionId, async () => {
        await retireNativeSession(this.ctx, record.sessionId)
        await files.delete(workerTransferPath(this.workerBusinessScope(), record.identity.executionId))
        await this.deleteRuntimeRecord(this.prefix + 'retired-workers/' + record.identity.executionId, record)
        this.retiredWorkers!.delete(record.identity.executionId)
      })
      return
    }
    const authority = this.records as GitAuthorityStore
    await Promise.all(records.map(record => retireNativeSession(this.ctx, record.sessionId)))
    await this.transactions.runFinalization('worker-transfer-release:' + taskId + ':' + hash(JSON.stringify(ids)), { taskId, ids }, { reevaluate: true }, async (snapshot) => {
      const changes: Array<{ path: string; content: null }> = []
      for (const id of ids) {
        const path = workerTransferPath(this.workerBusinessScope(), id)
        const key = this.prefix + 'retired-workers/' + id
        const current = await authority.getAt<RoleRecord>(snapshot, key)
        const expected = records.find(record => record.identity.executionId === id);
        if (!current || JSON.stringify(current.identity) !== JSON.stringify(expected!.identity) || current.sessionId !== expected!.sessionId
          || current.generation !== expected!.generation || !current.stopped) throw new Error('Retired Worker stop authority changed before cleanup.')
        changes.push((authority.deleteChange(key) as { path: string; content: null }));
        if (await this.files.read(snapshot, path) !== undefined) changes.push({ path, content: null })
      }
      return changes
    }, async snapshot => {
      for (const id of ids) {
        if (await this.files.read(snapshot, workerTransferPath(this.workerBusinessScope(), id)) !== undefined) return false
        if (await authority.getAt(snapshot, this.prefix + 'retired-workers/' + id) !== undefined) return false
      }
      return true
    });
    for (const record of records) this.retiredWorkers!.delete(record.identity.executionId)
  }
  private workerBusinessScope(): string { return JSON.stringify([this.config.scope, this.config.member]) }
  private saveRetiredWorker(record: RoleRecord, evidenceUpdate = false): Promise<void> {
    return this.withRoleWrite('retired:' + record.identity.executionId, () => this.saveRetiredWorkerInChannel(record, evidenceUpdate))
  }
  private async saveRetiredWorkerInChannel(record: RoleRecord, evidenceUpdate = false): Promise<void> {
    const evidence = record.stopIntent
    if (evidenceUpdate && (!evidence || evidence.workId !== record.identity.workId || evidence.executionId !== record.identity.executionId || evidence.sessionId !== record.sessionId))
      throw new Error('Retired stop evidence does not match its owned execution.')
    const disposedEvidence = evidenceUpdate && evidence?.phase === 'disposed' && evidence.jobs.length === 0
    const base = this.retiredWorkers?.get(record.identity.executionId)
    if (evidenceUpdate) {
      if (!base || JSON.stringify(base.identity) !== JSON.stringify(record.identity) || base.sessionId !== record.sessionId || base.generation !== record.generation)
        throw new Error('Retired stop evidence no longer has its owned execution.')
      record = { ...base, stopIntent: evidence, ...(disposedEvidence && base.stopIntent?.phase !== 'disposed' ? { stopUnknown: undefined } : {}) }
    }
    if (base?.stopped) record = { ...record, stopped: true, nativeRetirements: base.nativeRetirements, ...(!evidenceUpdate ? { stopUnknown: undefined } : {}) }
    if (this.records instanceof GitAuthorityStore) {
      const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
      const updated = await this.records.update<RoleRecord, RoleRecord>(this.prefix + 'retired-workers/' + record.identity.executionId, current => {
        if (!current || !same(current.identity, record.identity) || current.sessionId !== record.sessionId || current.generation !== record.generation)
          throw new Error('Retired Worker authority is absent or its identity changed.')
        const result = ({ ...current })
        if (evidenceUpdate || !same(record.stopIntent, base?.stopIntent)) {
          if (current.stopIntent?.phase === 'disposed' && record.stopIntent?.phase === 'stopping') throw new Error('A settled stop cannot regress to stopping.')
          if (!same(current.stopIntent, base?.stopIntent) && !same(current.stopIntent, record.stopIntent)) throw new Error('Retired Worker stop evidence changed concurrently.')
          result.stopIntent = record.stopIntent
        }
        if (!evidenceUpdate && record.stopped) { result.stopped = true; result.stopUnknown = undefined }
        else if (!evidenceUpdate && !same(record.stopUnknown, base?.stopUnknown) && !current.stopped) {
          if (!same(current.stopUnknown, base?.stopUnknown) && !same(current.stopUnknown, record.stopUnknown)) throw new Error('Retired Worker stop result changed concurrently.')
          result.stopUnknown = record.stopUnknown
        }
        // Persist the successful producer receipt and resolution atomically;
        // a crash before the later stopped acknowledgement must not retain old jobs.
        if (disposedEvidence && current.stopIntent?.phase !== 'disposed') result.stopUnknown = undefined
        return { write: !same(result, current), value: result, result }
      })
      const live = this.retiredWorkers?.get(record.identity.executionId)
      if (live && same(live.identity, record.identity) && live.sessionId === record.sessionId) this.retiredWorkers!.set(record.identity.executionId, updated);
      const stop = this.stopOperations?.get(JSON.stringify([record.identity.workId, record.identity.executionId]))
      if (stop && updated.stopped) { stop.persistedStopped = true; if (stop.settled) stop.result = { status: 'stopped' } }
      this.continueNativeRetirements(updated, true)
      return;
    }
    const physicalRetirement = this.files instanceof PhysicalLocalFiles && base
      && base.identity.executionId === record.identity.executionId && base.sessionId === record.sessionId
      && (evidenceUpdate || record.stopped)
    if (!physicalRetirement && await this.taskRuntimeReleased(record.identity)) return
    await this.records.set(this.prefix + 'retired-workers/' + record.identity.executionId, record)
    this.retiredWorkers ??= new Map()
    this.retiredWorkers.set(record.identity.executionId, record)
    const stop = this.stopOperations?.get(JSON.stringify([record.identity.workId, record.identity.executionId]))
    if (stop && record.stopped) { stop.persistedStopped = true; if (stop.settled) stop.result = { status: 'stopped' } }
    this.continueNativeRetirements(record, true)
  }
  private retireWorkerBusiness(record: RoleRecord): void {
    const id = record.identity.executionId
    this.retiredWorkers ??= new Map()
    if (!this.retiredWorkers.has(id)) this.retiredWorkers.set(id, record)
    const current = this.roleRecords.get(record.identity.workId)
    if (current?.identity.executionId === id && !current.businessTransferred) {
      this.roleRecords.set(record.identity.workId, { ...current, businessTransferred: true })
      this.workerAdmissions?.delete(record.identity.workId)
      this.workerAdmissionTasks?.delete(record.identity.workId)
      for (const operations of [this.workOperations, this.admissions]) {
        const pending = operations?.get(record.identity.workId)
        if (!pending) continue
        operations!.delete(record.identity.workId);
        this.retiredWorkOperations ??= new Set()
        this.retiredWorkOperations.add(pending)
        void pending.finally(() => this.retiredWorkOperations?.delete(pending)).catch(() => { })
      }
    }
    this.native.detach(record.identity.workId, id)
    this.wakeConsumptions?.delete(id)
    this.drainRetiredWorker(id)
  }
  private retryRetiredWorkers(): void {
    if (this.closed) return
    for (const record of this.retiredWorkers?.values() ?? []) {
      if (!record.stopped) this.drainRetiredWorker(record.identity.executionId)
      else this.continueNativeRetirements(record, true)
    }
  }
  private drainRetiredWorker(id: string): void {
    this.workerDrains ??= new Map()
    if (this.workerDrains.has(id) || this.retiredWorkers?.get(id)?.stopped) return
    const operation = Promise.resolve().then(async () => {
      const record = this.retiredWorkers!.get(id);
      const result = await this.stopOwnedRecord(record!)
      if (result.status === 'superseded') return
      await this.saveRetiredWorker({
        ...this.retiredWorkers!.get(id)!, ...(result.status === 'stopped'
          ? { stopped: true, stopUnknown: undefined } : { stopUnknown: result })
      });
      if (result.status === 'unconfirmed') this.error(new Error(result.reason), { identity: record!.identity, stage: 'worker-native-drain' })
    }).catch(error => this.error(error)).finally(() => { if (this.workerDrains?.get(id) === operation) this.workerDrains.delete(id) });
    this.workerDrains.set(id, operation)
  }
  private async recoverRetiredTransfer(transfer: WorkerBusinessTransfer<RoleRecord>): Promise<RoleRecord> {
    if (!(this.records instanceof GitAuthorityStore)) return transfer.record
    const original = transfer.record, id = original.identity.executionId
    const roleKey = this.roleRecordPath(original.identity.workId), retiredKey = this.prefix + 'retired-workers/' + id
    const keys = [roleKey, retiredKey]
    return this.records.updateRouted(keys, workerTransferPath(this.workerBusinessScope(), id), async (values, raw, snapshot) => {
      if (raw === undefined) throw new Error('Worker transfer disappeared before retired recovery.')
      const currentTransfer = (JSON.parse(raw) as WorkerBusinessTransfer<RoleRecord>);
      if (JSON.stringify(currentTransfer) !== JSON.stringify(transfer)) throw new Error('Worker transfer changed before retired recovery.')
      const sealed = await this.taskRuntimeReleased(original.identity, snapshot);
      const retired = (values.get(retiredKey) as RoleRecord | undefined);
      const sameOwner = (value: RoleRecord) => JSON.stringify(value.identity) === JSON.stringify(original.identity) && value.sessionId === original.sessionId && value.generation === original.generation
      if (retired) {
        if (!sameOwner(retired)) throw new Error('Retired Worker identity conflicts with transfer.')
        if (sealed && !retired.stopped) throw new Error('Released task has an unresolved Worker transfer.')
        return { target: retiredKey, value: retired, result: retired, write: false }
      }
      if (sealed) throw new Error('Released task has an unresolved Worker transfer.')
      const role = (values.get(roleKey) as RoleRecord | undefined);
      const recovered = (role && sameOwner(role) ? role : { ...original, stopped: undefined, released: undefined })
      return { target: retiredKey, value: recovered, result: recovered, write: true }
    });
  }
  private async reconcileWorkerTransfers(cold = false, borrowed?: FilesSnapshot, taskId?: string): Promise<void> {
    const candidates = [...new Map([...this.roleRecords.values(), ...(this.files instanceof PhysicalLocalFiles
      ? this.retiredWorkers?.values() ?? [] : [])].map(record => [record.identity.executionId, record])).values()]
      .filter(record => record.identity.role === 'Worker' && (this.files instanceof PhysicalLocalFiles || !record.businessTransferred && !record.stopped)
        && (!taskId || record.identity.taskId === taskId))
    if (!cold && !candidates.length) return
    const inspect = async (snapshot: FilesSnapshot) => {
      const paths = cold ? (await this.files.list(snapshot, workerTransferRoot(this.workerBusinessScope()))).map(entry => entry.path)
        : candidates.map(record => workerTransferPath(this.workerBusinessScope(), record.identity.executionId))
      const result: WorkerBusinessTransfer<RoleRecord>[] = []
      for (const path of paths) {
        // Storage/network errors remain real failures. Only malformed contents
        // are isolated to this object; one damaged record must not block peers.
        const raw = await this.files.read(snapshot, path)
        if (raw === undefined) continue
        let value: WorkerBusinessTransfer<RoleRecord>
        try {
          value = JSON.parse(raw)
          if (value?.version !== 1 || value.record?.identity?.role !== 'Worker' || value.record.identity.member !== this.config.member
            || typeof value.record.identity.executionId !== 'string' || typeof value.record.identity.workId !== 'string'
            || typeof value.record.sessionId !== 'string' || typeof value.successorId !== 'string'
            || (value.successorRole !== undefined && !['Worker', 'Planner'].includes(value.successorRole))
            || path !== workerTransferPath(this.workerBusinessScope(), value.record.identity.executionId)) throw new Error('Invalid transition fields.')
        } catch (cause) {
          this.error(new Error('Invalid Worker business transition: ' + path, { cause }), { path, stage: 'worker-transfer-recovery' })
          continue
        }
        result.push(value)
      }
      return result
    }
    const transfers = borrowed ? await inspect(borrowed) : await withSnapshot(this.files, inspect)
    for (const transfer of transfers) {
      const saved = this.records instanceof GitAuthorityStore ? await this.recoverRetiredTransfer(transfer)
        : cold ? await this.records.get<RoleRecord>(this.prefix + 'retired-workers/' + transfer.record.identity.executionId) : undefined
      if (saved) { this.retiredWorkers ??= new Map(); this.retiredWorkers.set(saved.identity.executionId, saved) }
      this.retireWorkerBusiness(saved ?? transfer.record)
      if (this.files instanceof PhysicalLocalFiles && (transfer as PhysicalWorkerBusinessTransfer<RoleRecord>).physical
        && !(transfer as PhysicalWorkerBusinessTransfer<RoleRecord>).physical?.published) {
        const files = this.files, identity = transfer.record.identity
        // Acceptance already owns the prepared result. Resume this execution's
        // publication independently of its native drain and other Workers.
        this.startMaintenance('physical-worker-transfer:' + identity.executionId, () =>
          resumePhysicalWorkerTransfer(files, workerTransferPath(this.workerBusinessScope(), identity.executionId), async () => {
            if (!identity.taskId) throw new Error('The Worker transfer has no Task identity.')
            await withSnapshot(files, async snapshot => {
              await assertTaskLifecycle(files, snapshot, identity.taskId!, identity)
              const task = await readJson<TaskMetadata>(files, snapshot, paths.task(identity.taskId!))
              if (!task || isTerminalTask(task)) throw new Error('The Task is closed; its Worker transfer cannot publish a new notification.')
            })
          }, value => this.physicalSignalSources((value as PhysicalWorkerBusinessTransfer<RoleRecord>).physical?.signal.path ?? '')),
        { identity, stage: 'worker-transfer-publication' })
      }
    }
  }
  private safetyWork<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.environment.safetyOccurrence) return operation()
    const occurrence = this.environment.safetyOccurrence()
    return this.safetyContext.run(occurrence, () => {
      const remember = (error: unknown) => { if (error && typeof error === 'object' && !this.safetyErrorOccurrences.has(error)) this.safetyErrorOccurrences.set(error, occurrence) }
      try {
        const pending = operation()
        void pending.catch(remember)
        return pending
      } catch (error) { remember(error); throw error }
    })
  }
  async requestSafetyRepair(fault: SafetyFault): Promise<void> {
    if (fault.mode !== this.config.mode || (fault.scope !== undefined && fault.scope !== this.config.scope))
      throw new Error('Safety Net fault belongs to a different storage scope.')
    if (this.closed) throw new Error('Runtime is not available for Safety Net repair.')
    if (!fault.identity && fault.workId) {
      const owner = this.roleRecords.get(fault.workId)
      if (!owner || (fault.executionId !== undefined && owner.identity.executionId !== fault.executionId)) {
        const retired = fault.executionId ? this.retiredWorkers?.get(fault.executionId) : undefined
        if (retired && retired.identity.workId === fault.workId && retired.stopped && fault.source === 'stopExecution' && !fault.operationId) { this.environment.safetyResolved?.(fault.id); return }
        this.unavailableSafetyTargets.set(fault.id, fault)
        throw new Error('Safety Net target execution is unavailable: ' + fault.workId)
      }
      this.unavailableSafetyTargets.delete(fault.id)
      if (owner.stopped && fault.source === 'stopExecution' && !fault.operationId) { this.environment.safetyResolved?.(fault.id); return }
      fault = { ...fault, identity: owner.identity, taskId: fault.taskId ?? owner.identity.taskId }
    }
    const pending = this.safetyRequests.get(fault.id)
    if (pending) return pending
    if (this.safetyEpisodes.has(fault.id)) return
    const operation = withOperationChannel(this.files, 'host-poll-write', () => this.arrangeSafetyRepair(fault))
    this.safetyRequests.set(fault.id, operation)
    try { await operation } finally { if (this.safetyRequests.get(fault.id) === operation) this.safetyRequests.delete(fault.id) }
  }
  private recheckUnavailableSafetyTargets(): void {
    let available = false
    for (const [id, fault] of this.unavailableSafetyTargets ?? []) {
      const owner = fault.workId ? this.roleRecords.get(fault.workId) : undefined
      const retired = fault.executionId ? this.retiredWorkers?.get(fault.executionId) : undefined
      if (retired && retired.identity.workId === fault.workId && retired.stopped && fault.source === 'stopExecution' && !fault.operationId) {
        this.unavailableSafetyTargets.delete(id); this.environment.safetyResolved?.(id)
      } else if (owner && (!fault.executionId || owner.identity.executionId === fault.executionId)) {
        this.unavailableSafetyTargets.delete(id); available = true
      }
    }
    if (available) this.environment.changed?.()
  }
  private async arrangeSafetyRepair(fault: SafetyFault): Promise<void> {
    await Promise.resolve();
    if (this.closed) throw new Error('Runtime closed before Safety Net repair admission.')
    const episode = ({ fault, commands: new Set<string>() } as { fault: SafetyFault; helperWakeId?: string; commands: Set<string>; settled?: boolean });
    this.safetyEpisodes.set(fault.id, episode)
    try {
      const ongoing = (await this.records.list<RoleRestore>(this.prefix + 'restores/')).find(row => !row.value.complete && (
        fault.admissionTimeout ? !!fault.admissionTimeout.context.workId && !!fault.admissionTimeout.context.executionId
          && row.value.input.target?.workId === fault.admissionTimeout.context.workId
          && row.value.input.target.executionId === fault.admissionTimeout.context.executionId
          : fault.identity ? row.value.input.target?.workId === fault.identity.workId && row.value.input.target.executionId === fault.identity.executionId
            : !!fault.taskId && row.value.input.target?.taskId === fault.taskId))
      if (ongoing) {
        const commandId = ongoing.value.commandId
        const associated = await this.updateSafetyRestoreRow<RoleRestore>(ongoing.key, commandId, current => ({
          ...current,
          safetyKind: 'target', safetyFaultIds: [...new Set([...(current.safetyFaultIds ?? []), fault.id])],
          safetyFaults: [...(current.safetyFaults ?? []).filter(value => value.id !== fault.id), fault]
        }))
        episode.commands.add(ongoing.value.commandId)
        if (associated?.complete || associated?.safetyAttempt) {
          episode.settled = associated.complete
          if (associated.outcome === 'superseded' || associated.outcome === 'already-admitted' || associated.outcome === 'terminal') this.environment.safetyResolved?.(fault.id)
          else this.environment.safetyReplay?.(fault, { attemptId: commandId, ...(associated.safetyDisplayOwner ? { displayOwner: associated.safetyDisplayOwner } : {}), ...(!associated.complete ? associated.safetyAttempt : {}) })
        }
        this.startRestoration(); return
      }
      const helperFault = fault.identity?.role === 'Helper' || fault.role === 'Helper'
      const exactDiagnostic = typeof fault.diagnosticContext?.roleAuthorityContent === 'string'
        || typeof fault.diagnosticContext?.hostRestorationCommandId === 'string'
      const matches = (wake: RoleWake) => {
        // An earlier fault input does not silently acquire a distinct new fault.
        // Publish its ordinary Helper signal so a busy Helper can claim it
        // after the current work, or Host can wake the idle Helper normally.
        if ([...this.safetyEpisodes.values()].some(value => value.helperWakeId === wake?.id && value.fault.id !== fault.id)) return false
        const context = wake?.context, identity = ((context?.identity ?? context?.target) as WorkIdentity | undefined);
        if (fault.admissionTimeout) return wake?.role === 'Helper' && wake.id === (helperFault ? fault.admissionTimeout.context.wakeId : fault.admissionTimeout.helperWakeId)
        if (exactDiagnostic)
          return wake?.role === 'Helper' && context?.errorSignature === fault.errorSignature
        return wake?.role === 'Helper' && (fault.identity ? identity?.workId === fault.identity.workId && identity.executionId === fault.identity.executionId
          : fault.taskId ? (context?.taskId === fault.taskId || identity?.taskId === fault.taskId) && context?.facts === fault.message : context?.facts === fault.message)
      };
      const active = [...this.roleRecords.values()].find((record) => record.identity.role === 'Helper' && (helperFault ? (!fault.identity || record.identity.workId === fault.identity.workId && record.identity.executionId === fault.identity.executionId)
        && !!(record.delivery?.request ?? record.lastWake)
        && (!fault.admissionTimeout || (record.delivery?.request ?? record.lastWake)?.id === fault.admissionTimeout.context.wakeId) : this.active(record) && matches(record.delivery?.request ?? record.lastWake!)));
      const waiting = active ? undefined : (await this.records.list<WakeRecord>(this.prefix + 'wakes/')).find(row =>
        (!row.value.delivered || exactDiagnostic) && matches(row.value.request))
      if (helperFault && !active && !waiting) throw new Error('Original Helper is unavailable for diagnostic delivery; preserve its existing recovery responsibility.')
      const priorTimeout = fault.admissionTimeout && !active && !waiting
        ? await this.records.get<WakeRecord>(this.prefix + 'wakes/' + hash(fault.admissionTimeout.helperWakeId)) : undefined
      episode.helperWakeId = (active?.delivery?.request ?? active?.lastWake)?.id ?? waiting?.value.request.id
        ?? (priorTimeout?.delivered ? 'safety-helper:' + fault.id : fault.admissionTimeout?.helperWakeId) ?? 'safety-helper:' + fault.id
      if (!active && !waiting) await this.wake({
        id: episode.helperWakeId, role: 'Helper', reason: 'helper', sources: [],
        context: {
          ...(fault.diagnosticContext ?? {}), ...(fault.errorSignature ? { errorSignature: fault.errorSignature } : {}),
          ...(fault.admissionTimeout?.context ?? {}), safetyFault: fault, failureDetails: fault.failureDetails, ...(fault.admissionTimeout ? {} : { facts: fault.message }), ...(fault.identity ? { target: fault.identity } : {}), ...(fault.taskId ? { taskId: fault.taskId } : {}),
          instruction: 'Outer Safety Net: diagnose this actual fault and choose the appropriate authorized repair or restoration for its exact target and scope. Preserve original responsibility and permissions and let the original work continue. Read the supplied Helper Debug location for prior actual handling. Only a new failure from that original work after its earlier repair is another Safety Net entry; a Helper turn ending or an old failure being reread is not. On an actual repeated fault, decide further handling and whether the user needs a Foreground report through the existing state signal. Verify actual continuation; arranging a tool request is not completed recovery.'
        }
      }, undefined, [fault])
      if (active || waiting || fault.admissionTimeout) {
        const key = this.prefix + 'wakes/' + hash(episode.helperWakeId)
        let retiredInput: RoleWake | undefined
        // Only the missing-body branch needs additional native proof. A saved
        // role alone must not turn an unknown input into a consumed wake.
        if (active?.delivery?.confirmed && active.gitSettledWakeId === active.delivery.request.id
          && active.delivery.request.id === episode.helperWakeId && !await this.records.get<WakeRecord>(key)) {
          const input = (await new DshSessionReader(this.ctx).inputs(active.sessionId)).get(active.delivery.messageId)
          if (input?.state === 'consumed' && input.source === 'deepseek-servant') retiredInput = active.delivery.request
        }
        await this.updateWake(key, current => {
          if (!current) {
            const accepted = active && this.roleRecords.get(active.identity.workId)
            if (!retiredInput || !accepted?.delivery?.confirmed || accepted.identity.executionId !== active?.identity.executionId
              || accepted.gitSettledWakeId !== retiredInput.id || JSON.stringify(accepted.delivery.request) !== JSON.stringify(retiredInput))
              throw new Error('Safety Net Helper wake is unavailable.')
            // Retained actual native input is still the owner. Do not send it
            // again or invent signal consumption when attaching this new fault.
            return { request: retiredInput, delivered: true, safetyFaults: [fault] }
          }
          return { ...current, safetyFaults: [...(current.safetyFaults ?? []).filter(value => value.id !== fault.id), fault] }
        })
      }
    } catch (error) { this.safetyEpisodes.delete(fault.id); throw error }
  }
  private waitingSafetyResolution(row: WakeRecord): boolean {
    const contextual = (row.request.context?.safetyFault as SafetyFault | undefined);
    return this.safetyResolutionReady === false && (row.safetyFaults ?? (contextual ? [contextual] : [])).some(fault => !this.safetyEpisodes.has(fault.id))
  }
  private safetyFaultFromWake(row: WakeRecord, fault: SafetyFault): SafetyFault {
    if (fault.diagnosticContext || fault.errorSignature || fault.source !== 'runtime') return fault
    const context = row.request.context
    if (row.request.role !== 'Helper' || typeof context?.errorSignature !== 'string' || context.facts !== fault.message
      || typeof context.roleAuthorityContent !== 'string' && typeof context.hostRestorationCommandId !== 'string') return fault
    const details = context.failureDetails as { name?: string; code?: string; operationId?: string } | undefined
    const name = typeof context.errorName === 'string' ? context.errorName
      : context.stage === 'role-discovery' && typeof context.roleAuthorityContent === 'string' ? 'Error' : details?.name
    // These are the two typed codes assigned by the existing service report;
    // older Host restore wakes retained their errorName but no failureDetails.
    const code = details?.code ?? (name === 'FilesOutcomeUnknownError' ? 'dss/outcome-unknown'
      : name === 'FilesConflictError' ? 'dss/conflict' : undefined)
    const matches = (candidate: SafetyFault) => candidate.source === 'runtime' && !candidate.identity && !candidate.role
      && !candidate.taskId && !candidate.workId && !candidate.executionId && candidate.message === context.facts
      && candidate.operationId === (context.operationId ?? details?.operationId)
      && (candidate.code ? candidate.code === code
        : name !== undefined && candidate.fingerprint === hash(JSON.stringify([name, context.facts])))
    // One Helper can carry several faults with the same text. Only its unique
    // original typed failure can inherit this wake's diagnostic target.
    const candidates = [...(row.safetyFaults ?? []), ...(row.safetyAttempts ?? []).map(attempt => attempt.fault),
      ...(context.safetyFault ? [context.safetyFault as SafetyFault] : [])]
    const owners = new Set(candidates.filter(matches).map(candidate => candidate.id))
    if (!matches(fault) || owners.size !== 1 || !owners.has(fault.id)) return fault
    // Older runtime diagnostics persisted their original facts on this wake,
    // while the associated SafetyFault carried only presentation ownership.
    const { errorSignature, facts, failureDetails, ...diagnosticContext } = context
    return { ...fault, diagnosticContext, errorSignature }
  }
  private replaySafetyWakes(rows: readonly WakeRecord[]): void {
    if (this.safetyResolutionReady === false) return
    for (const row of rows) for (const id of row.resolvedSafetyFaultIds ?? []) if (!this.resolvedSafetyFaultIds.has(id)) {
      this.resolvedSafetyFaultIds.add(id); this.environment.safetyResolved?.(id)
    }
    for (const row of rows) for (const attempt of row.safetyAttempts ?? []) {
      const fault = this.safetyFaultFromWake(row, attempt.fault)
      if (this.resolvedSafetyFaultIds.has(fault.id)) continue
      const key = 'reported:' + attempt.attemptId + ':' + fault.id
      if (this.safetyReplayed.has(key)) continue
      this.safetyReplayed.add(key)
      const episode = this.safetyEpisodes.get(fault.id) ?? { fault, helperWakeId: row.request.id, commands: new Set<string>() }
      if (!episode.fault.diagnosticContext && fault.diagnosticContext) episode.fault = fault
      if (attempt.outcome === 'attempted-not-repaired' && episode.settled) continue
      if (attempt.outcome === 'repaired' && !attempt.fault.operationId) {
        episode.settled = true
        this.safetyEpisodes.set(attempt.fault.id, episode)
        this.resolvedSafetyFaultIds.add(attempt.fault.id)
        this.environment.safetyResolved?.(attempt.fault.id)
        continue
      }
      Object.assign(episode, { settled: attempt.outcome === 'repaired' })
      this.safetyEpisodes.set(attempt.fault.id, episode)
      this.environment.safetyReplay?.(episode.fault, attempt.outcome === 'repaired' ? {
        attemptId: attempt.attemptId,
        ...(attempt.displayOwner ? { displayOwner: attempt.displayOwner } : {})
      } : {})
      if (attempt.outcome === 'repaired' && attempt.fault.operationId) this.environment.safetyResolved?.(attempt.fault.id)
    }
    for (const row of rows) this.replaySafetyWake(row)
  }
  private replaySafetyWake(row: WakeRecord): void {
    if (this.safetyResolutionReady === false) return
    if (row.request.role !== 'Helper') return
    const contextual = (row.request.context?.safetyFault as SafetyFault | undefined);
    for (const saved of row.safetyFaults ?? (contextual ? [contextual] : [])) {
      const fault = this.safetyFaultFromWake(row, saved)
      if (this.resolvedSafetyFaultIds.has(fault.id)) continue
      if (fault.mode !== this.config.mode || (fault.scope !== undefined && fault.scope !== this.config.scope)) continue
      const existing = this.safetyEpisodes.get(fault.id)
      if (existing) {
        if (!existing.fault.diagnosticContext && fault.diagnosticContext) {
          existing.fault = fault
          this.environment.safetyReplay?.(fault, {})
        }
        if ([row.safetyParentWakeId, row.recovery?.original?.request.id, row.recovery?.replacesUnadmittedWake].some(id => id !== undefined && id === existing.helperWakeId)) existing.helperWakeId = row.request.id
        continue
      }
      this.safetyEpisodes.set(fault.id, { fault, helperWakeId: row.request.id, commands: new Set() })
      this.environment.safetyReplay?.(fault, {})
    }
  }
  private safetyFaultIds(binding: FrameworkRoleBinding): string[] {
    const record = this.roleRecords.get(binding.workId)
    if (record?.identity.executionId !== binding.executionId) return []
    const wakes = new Set(this.helperResponsibilities(record).map(request => request.id))
    return [...this.safetyEpisodes ?? []].filter(([, value]) => !value.settled && value.helperWakeId !== undefined && wakes.has(value.helperWakeId)).map(([id]) => id)
  }
  private async recordSafetyAttempt(binding: FrameworkRoleBinding, input: HelperRepairAttempt, commandId: string, retired?: RoleRecord): Promise<void> {
    if (binding.role !== 'Helper') throw new Error('Only the owning Helper can report its repair attempt.')
    const owner = this.roleRecords.get(binding.workId)
    // Only replay of an already accepted physical publication can supply this
    // exact predecessor. Native tool calls still require the current execution.
    const caller = retired && owner?.nativeRetirements?.some(item => item.helper
      && item.executionId === retired.identity.executionId && item.sessionId === retired.sessionId)
      ? retired : owner
    if (caller?.identity.executionId !== binding.executionId) throw new Error('The Helper execution no longer owns this diagnostic responsibility.')
    const wakes = new Set(this.helperResponsibilities(caller, caller !== retired).map(request => request.id))
    let associated = [...this.safetyEpisodes.values()].filter(value => value.helperWakeId !== undefined && wakes.has(value.helperWakeId))
    if (!associated.length || input.faultId && !associated.some(value => value.fault.id === input.faultId)) {
      // Cold replay of this already-owned report need not wait for unrelated
      // Task archives. Its exact accepted Helper wakes retain the real faults.
      for (const wakeId of wakes) {
        const saved = await this.records.get<WakeRecord>(this.prefix + 'wakes/' + hash(wakeId))
        if (!saved || saved.request.role !== 'Helper') continue
        const contextual = saved.request.context?.safetyFault as SafetyFault | undefined
        for (const stored of saved.safetyFaults ?? (contextual ? [contextual] : [])) {
          const fault = this.safetyFaultFromWake(saved, stored)
          if (fault.mode !== this.config.mode || fault.scope !== undefined && fault.scope !== this.config.scope) continue
          const previous = this.safetyEpisodes.get(fault.id)
          if (previous && previous.helperWakeId !== undefined && !wakes.has(previous.helperWakeId)) continue
          const enriched = previous && !previous.fault.diagnosticContext && fault.diagnosticContext
          if (enriched) previous.fault = fault
          this.safetyEpisodes.set(fault.id, previous ?? { fault, helperWakeId: wakeId, commands: new Set<string>(),
            ...(saved.resolvedSafetyFaultIds?.includes(fault.id) || saved.safetyAttempts?.some(attempt => attempt.fault.id === fault.id && attempt.outcome === 'repaired') ? { settled: true } : {}) })
          if (!previous || enriched) this.environment.safetyReplay?.(fault, {})
        }
      }
      associated = [...this.safetyEpisodes.values()].filter(value => value.helperWakeId !== undefined && wakes.has(value.helperWakeId))
    }
    const selected = input.faultId ? associated.find(value => value.fault.id === input.faultId) : associated.length === 1 ? associated[0] : undefined
    if (!selected) throw new Error('Select an actual fault delivered to this Helper: ' + associated.map(value => value.fault.id + ': ' + value.fault.message).join('; '))
    if (!input.actionsTaken.trim() || !input.result.trim()) throw new Error('Report the actual actions taken and observed result.')
    const displayOwner = this.environment.safetyDisplayOwner?.()
    const report = { ...input, faultId: selected.fault.id, fault: selected.fault, attemptId: commandId, ...(displayOwner ? { displayOwner } : {}) }
    await this.updateWake(this.prefix + 'wakes/' + hash(selected.helperWakeId!), current => {
      if (!current) throw new Error('Original Helper diagnostic wake is unavailable.')
      const previous = current.safetyAttempts?.find(value => value.attemptId === commandId)
      if (previous) {
        if (previous.fault.id !== report.fault.id || previous.actionsTaken !== report.actionsTaken || previous.outcome !== report.outcome || previous.result !== report.result)
          throw new Error('The original repair report command has different facts.')
        return current
      }
      return { ...current, safetyAttempts: [...(current.safetyAttempts ?? []), report],
        ...(input.outcome === 'repaired' && !selected.fault.operationId ? {
          resolvedSafetyFaultIds: [...new Set([...(current.resolvedSafetyFaultIds ?? []), selected.fault.id])]
        } : {}) }
    });
    const key = 'reported:' + commandId + ':' + selected.fault.id
    if (this.safetyReplayed.has(key)) return
    this.safetyReplayed.add(key)
    if (input.outcome === 'repaired') {
      this.environment.safetyAttempted?.(selected.fault.id, commandId)
      selected.settled = true
      if (!selected.fault.operationId) this.resolvedSafetyFaultIds.add(selected.fault.id)
      // Respect the Helper's actual repaired assessment; this does not confirm
      // or discard any still-UNKNOWN external operation, which keeps its owner.
      this.environment.safetyResolved?.(selected.fault.id)
    }
  }
  private safetyCommandFor(identity: WorkIdentity): string | undefined {
    for (const episode of this.safetyEpisodes?.values() ?? []) {
      if (episode.settled || !episode.commands.size) continue
      const fault = episode.fault
      if (fault.identity ? fault.identity.workId === identity.workId && fault.identity.executionId === identity.executionId
        : fault.taskId && fault.taskId === identity.taskId) return episode.commands.values().next().value
    }
  }
  private restoreTaskOwner(value: Partial<RoleRestore>): { taskId: string; lifecycleId?: string } | undefined {
    const target = value.resolvedTarget ?? value.input?.target
    if (target?.taskId && target.role !== 'Foreground') return { taskId: target.taskId, lifecycleId: target.lifecycleId }
    return value.taskOwner
  }
  private restoreCommandReceiptPaths(value: Partial<RoleRestore> & { commandId: string }): string[] {
    const paths = [gitCommandReceiptPath('restore-debug:' + value.commandId)]
    // Task reconstruction keeps its original receipt until this same Task-owned
    // restore responsibility retires; its retained business files are not garbage.
    if (value.input?.taskRecovery && this.restoreTaskOwner(value)) paths.push(gitCommandReceiptPath('restore-task:' + value.commandId))
    return paths
  }
  private async createSafetyRestoreRow<T extends { commandId: string }>(key: string, value: T): Promise<void> {
    const owner = key.startsWith(this.prefix + 'restores/') ? this.restoreTaskOwner(value as Partial<RoleRestore>) : undefined
    const previous = this.safetyRestoreWrites.get(value.commandId)
    const operation = (previous ?? Promise.resolve()).then(async () => {
      if (this.records instanceof GitAuthorityStore) {
        await this.records.updateOwned<T, void>(key, JSON.stringify([key, 'restore-create']), async (current, snapshot) => {
          if (owner && await this.taskRuntimeReleased(owner, snapshot)) throw new Error('The selected Task runtime is already released.')
          return current === undefined ? { write: true, value, result: undefined } : { write: false, result: undefined }
        })
      } else {
        if (owner && await this.taskRuntimeReleased(owner)) throw new Error('The selected Task runtime is already released.')
        if (!await this.records.get(key)) await this.records.set(key, value)
      }
    })
    const writeOwner = owner && { ...owner, write: operation }
    if (writeOwner) this.restoreWriteOwners.set(value.commandId, writeOwner)
    this.safetyRestoreWrites.set(value.commandId, operation)
    try { await operation } finally {
      if (this.safetyRestoreWrites.get(value.commandId) === operation) this.safetyRestoreWrites.delete(value.commandId)
      if (this.restoreWriteOwners.get(value.commandId) === writeOwner) this.restoreWriteOwners.delete(value.commandId)
    }
  }
  private async updateSafetyRestoreRow<T extends SafetyRepairContext & { commandId: string }>(key: string, commandId: string, update: (current: T) => T): Promise<T> {
    const previous = this.safetyRestoreWrites.get(commandId)
    let updated!: T
    let completedHere = false
    const operation = (async () => {
      await previous
      const evaluate = (current: T | undefined): T => {
        if (!current || current.commandId !== commandId) throw new Error('Original restore responsibility is unavailable: ' + commandId)
        const next = update(current)
        completedHere = !(current as Partial<RoleRestore>).complete && !!(next as Partial<RoleRestore>).complete
        return next
      }
      if (this.records instanceof GitAuthorityStore) {
        const result = await this.records.updateIndexed<T, { value: T; retired?: T }>(key, async (current, snapshot) => {
          const value = evaluate(current), restore = value as T & Partial<RoleRestore>, owner = this.restoreTaskOwner(restore)
          // A normal exact Foreground continuation has no Task or Safety Net
          // replay owner. Retire its receipt with this original row, not Debug.
          const foregroundSettled = completedHere && restore.outcome === 'arranged' && restore.input?.target?.role === 'Foreground'
            && !owner && !restore.input.wakeId && !restore.admissionWakeId
            && !restore.input.disposition && !restore.input.taskRecovery
            && !restore.safetyFaultIds?.length && !restore.safetyFaults?.length
          if (key.startsWith(this.prefix + 'restores/') && restore.complete
            && (foregroundSettled || owner && await this.taskRuntimeReleased(owner, snapshot)))
            return { result: { value, retired: current! }, write: false }
          return { value, result: { value }, write: true }
        })
        updated = result.value
        if (result.retired) { await this.deleteRuntimeRecord(key, result.retired, this.restoreCommandReceiptPaths(result.retired)); return }
      } else {
        const current = await this.records.get<T>(key)
        updated = evaluate(current)
        await this.records.set(key, updated)
      }
      const restore = updated as T & Partial<RoleRestore>, owner = this.restoreTaskOwner(restore)
      if (this.files instanceof PhysicalLocalFiles && restore.complete) {
        // The original completion write is durable before exact retirement. A
        // later safety update cannot turn a failed cleanup into a retry loop.
        if (!completedHere || !await this.retirePhysicalRestoreDebug(key, restore)) return
      }
      if (key.startsWith(this.prefix + 'restores/') && restore.complete && owner && await this.taskRuntimeReleased(owner))
        await this.deleteRuntimeRecord(key, updated, this.restoreCommandReceiptPaths(updated))
    })()
    this.safetyRestoreWrites.set(commandId, operation)
    try { await operation; return updated }
    finally { if (this.safetyRestoreWrites.get(commandId) === operation) this.safetyRestoreWrites.delete(commandId) }
  }
  private async completeRestore(row: { key: string; value: RoleRestore }, outcome: 'arranged' | 'terminal' | 'already-admitted' | 'superseded'): Promise<void> {
    if (outcome === 'superseded' || outcome === 'already-admitted' || outcome === 'terminal') {
      for (const id of row.value.safetyFaultIds ?? []) {
        const episode = this.safetyEpisodes.get(id), fault = episode?.fault ?? row.value.safetyFaults?.find(value => value.id === id)
        if (fault?.operationId || !episode?.helperWakeId) continue
        await this.updateWake(this.prefix + 'wakes/' + hash(episode.helperWakeId), current => current ? {
          ...current, resolvedSafetyFaultIds: [...new Set([...(current.resolvedSafetyFaultIds ?? []), id])],
        } : undefined)
      }
    }
    const displayOwner = this.environment.safetyDisplayOwner?.()
    const completed = await this.updateSafetyRestoreRow<RoleRestore>(row.key, row.value.commandId, current => ({ ...current, complete: true, outcome, ...(displayOwner ? { safetyDisplayOwner: displayOwner } : {}) }))
    if (outcome === 'arranged') await this.safetyRestoreSettled(completed)
    else for (const id of completed.safetyFaultIds ?? []) {
      const episode = this.safetyEpisodes.get(id)
      if ((episode?.fault ?? completed.safetyFaults?.find(value => value.id === id))?.operationId) continue
      if (episode) episode.settled = true
      this.environment.safetyResolved?.(id)
    }
  }
  private replaySafetyRestore(row: SafetyRepairContext & { commandId: string; complete: boolean; outcome?: string }): void {
    if (!row.safetyFaults?.length) return
    if (row.complete && (row.outcome === 'superseded' || row.outcome === 'already-admitted' || row.outcome === 'terminal')) {
      for (const fault of row.safetyFaults) if (!fault.operationId) { this.resolvedSafetyFaultIds.add(fault.id); this.environment.safetyResolved?.(fault.id) }
      return
    }
    const restored = row.complete && row.outcome !== 'superseded' && row.outcome !== 'already-admitted' && row.outcome !== 'terminal'
    const replayKey = row.commandId + ':' + (restored ? 'complete' : row.safetyAttempt ? 'failed' : 'pending')
    if (this.safetyReplayed.has(replayKey)) return
    this.safetyReplayed.add(replayKey)
    for (const fault of row.safetyFaults) {
      if (this.resolvedSafetyFaultIds.has(fault.id)) continue
      const episode = this.safetyEpisodes.get(fault.id) ?? { fault, commands: new Set<string>() }
      episode.commands.add(row.commandId)
      if (!restored && episode.settled) continue
      Object.assign(episode, { settled: restored })
      this.safetyEpisodes.set(fault.id, episode)
      this.environment.safetyReplay?.(episode.fault, {
        ...(restored || row.safetyAttempt ? { attemptId: row.commandId, ...(row.safetyDisplayOwner ? { displayOwner: row.safetyDisplayOwner } : {}) } : {}),
        ...(!restored && row.safetyAttempt ? row.safetyAttempt : {}), ...(restored ? {} : {}),
      })
    }
  }
  private safetyRestoreSettled(row: SafetyRepairContext & { commandId: string }, error?: unknown): Promise<void> {
    if (!row.safetyFaultIds?.length) return Promise.resolve()
    const existing = this.safetySettlements.get(row.commandId)
    if (existing) return existing
    const operation = (async () => {
      if (error !== undefined) {
        const key = this.prefix + (row.safetyKind === 'host' ? 'host-restores/' : 'restores/') + hash(row.commandId)
        row = await this.updateSafetyRestoreRow(key, row.commandId, (current) => ({
          ...current,
          ...this.environment.safetyDisplayOwner?.() ? { safetyDisplayOwner: this.environment.safetyDisplayOwner() } : {},
          safetyAttempt: { failure: error instanceof Error ? error.message : String(error), terminal: false }
        }));
      }
      for (const id of row.safetyFaultIds ?? []) {
        const episode = this.safetyEpisodes.get(id)
        if (error === undefined) {
          const recoveredKey = 'restored:' + row.commandId + ':' + id
          if (!this.safetyReplayed.has(recoveredKey)) {
            this.safetyReplayed.add(recoveredKey)
            this.environment.safetyAttempted?.(id, row.commandId)
          }
          if (episode) episode.settled = true
        } else {
          const failureKey = 'restore-failed:' + row.commandId + ':' + id
          if (!this.safetyReplayed.has(failureKey)) {
            this.safetyReplayed.add(failureKey)
            this.environment.safetyAttemptFailed?.(id, row.commandId, error, false)
          }
        }
      }
    })();
    this.safetySettlements.set(row.commandId, operation)
    void operation.finally(() => { if (this.safetySettlements.get(row.commandId) === operation) this.safetySettlements.delete(row.commandId) }).catch(() => { })
    return operation
  }
  private services(): FrameworkRoleServices {
    return {
      taskCommandOwner: identity => this.taskCommandOwner(identity),
      taskControl: {
        ...(this.files instanceof PhysicalLocalFiles
          ? { taskPath: (taskId: string) => this.controls.taskRecordPath(taskId) }
          : { path: this.controls.recordPath }),
        write: async (binding, input, commandId, signal) => {
          const current = () => {
            signal.throwIfAborted()
            const record = this.roleRecords.get(binding.workId)
            if (this.closed || !this.config.primary || binding.role !== 'Foreground' || binding.direct || binding.owner !== this.config.member
              || binding.collaborationId !== this.config.collaborationId || !record || record.identity.role !== 'Foreground'
              || record.identity.executionId !== binding.executionId || record.stopped || record.released || record.stopIntent || record.stopUnknown
              || this.stopOperations?.has(JSON.stringify([binding.workId, binding.executionId])))
              throw new Error('Task control belongs to an unavailable Foreground execution or collaboration scope.')
            return record
          }
          current()
          if (await this.controls.execution(binding)) throw new Error('This Foreground execution has a stop request.')
          current()
          let controlTask: TaskMetadata | undefined
          const validate = async (snapshot: FilesSnapshot) => {
            const record = current()
            if (await this.controls.execution(binding, snapshot)) throw new Error('This Foreground execution has a stop request.')
            if (this.records instanceof GitAuthorityStore) {
              const authoritative = await this.records.getAt<RoleRecord>(snapshot, this.roleRecordPath(binding.workId))
              if (!authoritative || authoritative.identity.executionId !== binding.executionId || authoritative.identity.role !== 'Foreground'
                || authoritative.sessionId !== record.sessionId || authoritative.generation !== record.generation
                || authoritative.stopped || authoritative.released || authoritative.stopIntent || authoritative.stopUnknown)
                throw new Error('Task control Foreground authority changed.')
            }
            const task = await readJson<TaskMetadata>(this.files, snapshot, paths.task(input.taskId))
            if (!task || task.taskId !== input.taskId || task.status !== 'running')
              throw new Error('Only an existing running Task can be paused or resumed; cancellation is terminal.')
            if (taskLifecycle(task) !== (input.lifecycleId ?? '')) throw new Error('Task control belongs to an earlier lifecycle.')
            if (!(task.members ?? [task.owner]).includes(this.config.member)) throw new Error('This Host has no registered execution domain in the selected Task.')
            const cleanup = await readTaskCleanupRecord(this.files, snapshot, input.taskId)
            if (cleanup && taskLifecycle(cleanup) === (input.lifecycleId ?? '') && (cleanup.phase === 'files-cleaned' || cleanup.phase === 'released')) throw new Error('This Task runtime namespace is already cleaned.')
            current()
            controlTask = task
          }
          let controlRecords: readonly TaskControl[] | undefined
          const result = await this.controls.setTask(commandId, input.taskId, input.intent, input.lifecycleId ?? '',
            snapshot => snapshot ? validate(snapshot) : withSnapshot(this.files, validate), () => { current() }, (records, task) => { controlRecords = records; controlTask ??= task }, () => controlTask)
          if (controlTask) await this.taskControlPublished(controlTask, input.intent, controlRecords)
          current()
          if (input.intent === 'running') await publishTaskResume({ files: this.files, controls: this.controls,
            transactions: this.transactions, member: this.config.member, active: true, commandHostKey: this.archiveHostKey(),
            physicalSignalSources: path => this.physicalSignalSources(path) }, input, commandId)
          if (input.intent === 'running') {
            current()
            this.scheduleTaskResume(input.taskId, commandId, input.lifecycleId ?? '')
          }
          return result
        },
      },
      cancelTask: async (_binding, input, commandId) => cancelTask({
        files: this.files,
        physicalSignalSources: path => this.physicalSignalSources(path),
        commandHostKey: this.archiveHostKey(),
        member: this.config.member,
        transact: (id, request, options, build) => this.transactions.run(id, request, options, build),
        afterCancel: (ids, lifecycles) => this.cancelledTasksChanged(ids, lifecycles)
      }, input, commandId),
      restoreTask: async (binding, input, commandId) => {
        const task = await withSnapshot(this.files, (snapshot) => readJson<TaskMetadata>(this.files, snapshot, paths.task(input.taskId)));
        if (task?.status === 'complete') throw new Error('A completed Task cannot resume the same Task ID; submit a new Task for a correction or new requirement.');
        const candidates = (await this.records.list<RoleRecord>(this.prefix + 'roles/')).map((row) => row.value).filter((record) => record.identity.taskId === input.taskId && ["Planner", "Organizer", "Worker"].includes(record.identity.role) && (!record.identity.member || record.identity.member === this.config.member) && (!task || taskLifecycle(task) === taskLifecycle(record.identity)));
        const rank = (record: RoleRecord) => record.identity.role === (input.route === "O" ? "Organizer" : "Planner") ? 0 : record.identity.role === "Worker" ? 2 : 1;
        candidates.sort((a, b) => rank(a) - rank(b));
        if (!candidates.length) throw new Error("No retained local execution identifies this Task. Inspect its original instance and records before recovery.");
        if (candidates[1] && rank(candidates[0]) === rank(candidates[1])) throw new Error("More than one retained execution matches this Task; inspect the exact original execution before recovery.");
        const target = candidates[0].identity;
        return this.services().helper!.restore(binding, {
          target,
          facts: "The user approved in-place recovery of the original TaskID from retained records.",
          hypotheses: "Original instructions may be incomplete; inspect actual current material.",
          actionsTaken: "Host selected the exact retained local execution, without creating another Task.",
          continuation: input.continuation,
          taskRecovery: { recordPaths: input.recordPaths, route: input.route, owner: input.owner, continuation: input.continuation }
        }, commandId);
      },
      plannerWorkerExecutions: binding => this.plannerWorkerExecutions(binding),
      physicalSignalSources: path => this.physicalSignalSources(path),
      directDeliverySettled: async binding => {
        const record = this.roleRecords.get(binding.workId)
        if (!record || record.identity.executionId !== binding.executionId || !binding.direct
          || this.physicalDirectInput(record) !== binding.direct.inputPath)
          throw new Error('The direct delivery belongs to a replaced execution.')
        const request = record.delivery?.request ?? record.lastWake
        return !!request && record.gitSettledWakeId === request.id
      },
      directDelivered: async (binding, commandId) => {
        const record = this.roleRecords.get(binding.workId)
        if (!record || record.identity.executionId !== binding.executionId || !binding.direct)
          throw new Error('The direct delivery belongs to a replaced execution.')
        await this.settlePhysicalDirectDelivery(record, binding.direct.inputPath, commandId)
      },
      workerBusiness: {
        transferPath: binding => workerTransferPath(this.workerBusinessScope(), binding.executionId),
        assertLive: (binding, transferring) => this.assertWorkerBusinessLive(binding, transferring),
        assert: (binding, snapshot) => this.assertWorkerOwnsBusiness(binding, snapshot),
        transfer: async (binding, snapshot, successorId, successorRole) => {
          if (binding.taskId) await assertTaskLifecycle(this.files, snapshot, binding.taskId, binding);
          const record = this.roleRecords.get(binding.workId)
          if (!record || record.identity.executionId !== binding.executionId || record.identity.role !== 'Worker' || record.businessTransferred || record.stopped || record.released || record.stopUnknown || record.stopIntent)
            throw new Error('Worker business ownership changed before its transfer.')
          const markerPath = workerTransferPath(this.workerBusinessScope(), binding.executionId)
          let authoritative = record
          if (this.records instanceof GitAuthorityStore) {
            const actual = await this.records.getAt<RoleRecord>(snapshot, this.roleRecordPath(binding.workId))
            const retiredKey = this.prefix + 'retired-workers/' + binding.executionId
            const retired = await this.records.getAt<RoleRecord>(snapshot, retiredKey)
            const sealed = actual?.identity.taskId ? await this.taskSealAt(snapshot, actual.identity.taskId, actual.identity.lifecycleId) : undefined;
            if (!actual || JSON.stringify(actual.identity) !== JSON.stringify(record.identity) || actual.sessionId !== record.sessionId || actual.generation !== record.generation
              || actual.businessTransferred || actual.stopped || actual.released || actual.stopUnknown || actual.stopIntent || retired || sealed?.runtimeReleased
              || await this.files.read(snapshot, markerPath) !== undefined) throw new Error('Worker authority changed before its transfer.')
            authoritative = actual
          }
          // New committed transfers own this exact pending handoff in their
          // existing record. Native acceptance starts only after producer stop;
          // recovering an older transfer does not manufacture a new pending item.
          authoritative = { ...authoritative, nativeRetirements: [
            ...authoritative.nativeRetirements ?? [], { sessionId: authoritative.sessionId, executionId: binding.executionId }
          ] }
          const transfer: WorkerBusinessTransfer<RoleRecord> = { version: 1, record: authoritative, successorId, ...(successorRole ? { successorRole } : {}) }
          const changes = [{ path: markerPath, content: JSON.stringify(transfer) + '\n' }]
          if (this.records instanceof GitAuthorityStore) changes.push((this.records.change(this.prefix + 'retired-workers/' + binding.executionId, authoritative) as { path: string; content: string }));
          return changes
        },
        committed: async binding => {
          const record = this.records instanceof GitAuthorityStore
            ? await this.records.get<RoleRecord>(this.prefix + 'retired-workers/' + binding.executionId)
            : await withSnapshot(this.files, async snapshot => (await readJson<WorkerBusinessTransfer<RoleRecord>>(this.files, snapshot,
              workerTransferPath(this.workerBusinessScope(), binding.executionId)))?.record)
          if (record?.identity.executionId === binding.executionId) this.retireWorkerBusiness(record)
        }
      },
      files: this.files,
      attachmentStore: this.conversation.attachments,
      transact: async (id, request, options, build) => {
        const receipt = await this.transactions.run(id, request, { ...options, beforeAttempt: async () => {
          if (this.closed) throw new Error('Role runtime is closed.')
          await options.beforeAttempt?.()
          if (this.closed) throw new Error('Role runtime is closed.')
        } }, build)
        this.environment.changed?.()
        return receipt
      },
      skillsChanged: () => this.refreshSkills(),
      notifications: (snapshot, binding, taskId) => this.notifications(snapshot, binding, taskId),
      onError: error => this.error(error),
      recoveryWatchChanges: (binding, snapshot) => this.recoveryWatchChanges(binding, snapshot),
      consumeRecovery: (binding, consume) => this.consumeRecoveryMarker(binding, consume),
      consumeWake: binding => this.consumeWakeSignals(binding),
      claimNotifications: (binding, commandId) => this.claimCurrentNotifications(binding, commandId),
      conversation: {
        foregroundRoot: this.conversation.foregroundRoot,
        prepare: path => ['Foreground_List.md', 'Foreground_Cache.md'].some(name => path === this.conversation.foregroundRoot + '/' + name)
          ? this.conversation.prepare() : Promise.resolve(),
        read: async (input, binding) => {
          if (input.mode === 'search') return this.conversation.search(input.query ?? '', input.cursor, input.limit)
          if (input.mode === 'text') return this.conversation.readText(input.reference ?? '', input.cursor, input.limit)
          if (input.mode === 'message') return this.conversation.read(input.reference ?? '')
          if (input.mode === 'context' || input.mode === 'recent') return this.conversation.foregroundContext()
          if (input.mode === 'memory') return this.conversation.readForeground()
          // Explicit history pagination is separate from the default six-group context.
          return this.conversation.page(input.limit ?? 20, input.beforeId)
        },
        send: async (input, binding, commandId, beforeAttempt) => {
          const actual = this.native.get(binding.workId)?.actualAgent
          const context = actual?.session.requestContext()
          let source = this.conversationSendSources.get(commandId)
          if (!source) {
            const events = actual?.session.snapshotEvents?.() ?? []
            let calledAt: number | undefined
            for (let index = events.length - 1; index >= 0; index--) {
              const event = events[index];
              if (event.type === 'tool/call' && commandId === String(actual!.id) + ":" + String(event.data.callId)) { calledAt = event.time; break }
            }
            source = { createdAt: new Date(calledAt ?? Date.now()).toISOString(), ...(context?.model ? { model: context.model } : {}) }
            this.conversationSendSources.set(commandId, source)
          }
          const message: ConversationSend = {
            id: input.id, text: input.text, responsePhase: input.responsePhase, role: 'assistant', participantId: this.config.member,
            ...source, recipient: input.intent, ...(input.replyTo ? { replyTo: input.replyTo } : {})
          }
          const assertLivePublication = async () => {
            await beforeAttempt?.()
            if (binding.role !== 'Foreground') return
            if (this.closed || !this.config.primary) throw new Error('Only the current primary Foreground may publish its reply.')
            const owner = this.roleRecords.get(binding.workId)
            if (!owner || owner.identity.executionId !== binding.executionId || owner.stopped || owner.released || owner.stopIntent || owner.stopUnknown)
              throw new Error('Reply publication belongs to an ended, stopping, or replaced Foreground.')
          }
          const outputOwner = this.config.mode === 'local' && binding.role === 'Foreground' ? this.roleRecords.get(binding.workId) : undefined
          const publication = this.conversation.send(commandId, message, { reevaluate: true, ...(this.config.mode === 'git' ? { gitReplay: 'session-only' as const } : {}), beforeAttempt: assertLivePublication }, input, async (snapshot) => {
            if (binding.role !== "Foreground") return;
            if (this.closed || !this.config.primary) throw new Error("Only the current primary Foreground may publish its reply.");
            const owner = this.records instanceof GitAuthorityStore ? await this.records.getAt<RoleRecord>(snapshot, this.roleRecordPath(binding.workId)) : this.roleRecords.get(binding.workId);
            if (!owner || owner.identity.executionId !== binding.executionId || owner.stopped || owner.released || owner.stopIntent || owner.stopUnknown)
              throw new Error("Reply publication belongs to an ended, stopping, or replaced Foreground.");
          });
          if (this.config.mode === 'local' && binding.role === 'Foreground') {
            // Confirmed IDs belong to this send immediately, even while a prior
            // auxiliary save is slow. Only stop/reset and later role saves join
            // the existing write tail. Only a successful send is a confirmed output.
            const writes = this.roleWrites ??= new Map(), previous = writes.get(binding.workId)
            const matchesOutputOwner = (owner?: RoleRecord) => owner?.identity.executionId === binding.executionId
              && owner?.sessionId === outputOwner?.sessionId && owner?.generation === outputOwner?.generation
            const confirmed = publication.then(() => {
              const owner = this.roleRecords.get(binding.workId)
              if (owner && matchesOutputOwner(owner)) this.roleRecords.set(binding.workId, {
                ...owner, foregroundOutputIds: [...new Set([...(owner.foregroundOutputIds ?? []), message.id])]
              })
            })
            const outcome = confirmed.then(() => ({ sent: true as const }), error => ({ sent: false as const, error }))
            const drained = (previous ?? Promise.resolve()).catch(() => {}).then(async () => {
              const result = await outcome
              if (!result.sent) throw result.error
            })
            writes.set(binding.workId, drained)
            void drained.finally(() => { if (writes.get(binding.workId) === drained) writes.delete(binding.workId) }).catch(() => {})
            await confirmed
            const owner = this.roleRecords.get(binding.workId)
            if (owner && matchesOutputOwner(owner)) {
              // saveRole already owns this tail. Reset, later same-role writes,
              // and shutdown drain it; auxiliary storage does not delay sent:true.
              void this.saveRole(owner).catch(error => this.conversationError(error, owner.identity, 'foreground-output-metadata'))
            }
          } else await publication
          this.conversationSendSources.delete(commandId)
          // Auxiliary metadata and client notification do not own the sent result.
          // Failed Local indexing remains on the same role for later saves/reset.
          if (binding.role === 'Foreground') {
            try {
              const owner = this.roleRecords.get(binding.workId), process2 = this.foregroundProcesses?.get(binding.executionId);
              if (owner?.identity.executionId === binding.executionId && message.text.trim() && process2?.reply(message.id)) this.saveForegroundProcessGroups(owner, process2);
            } catch (error) { this.conversationError(error, binding, 'foreground-process-metadata') }
          }
          try { this.environment.changed?.({ domain: 'conversation', mode: this.config.mode }) }
          catch (error) { this.conversationError(error, binding, 'conversation-notification') }
          return { sent: true, messageId: input.id };
        },
        claim: (input, binding) => this.consumeWakeSignals(binding)
      },
      workspace: {
        instanceUUID: this.config.instanceUUID,
        locate: (taskId, snapshot) => this.workspaces.locate(taskId, snapshot, true),
        reference: async (agent, taskId, sourcePath, snapshot, signal) => {
          const cwd = await this.ctx.workingDirectory.ensure(agent, signal);
          return this.workspaces.reference(taskId, sourcePath, cwd, snapshot);
        },
        validate: (reference, snapshot) => this.workspaces.validate(reference, snapshot)
      },
      artifacts: {
        preserve: async (agent, input, binding, commandId, options) => {
          const cwd = await this.ctx.workingDirectory.ensure(agent, options.signal)
          const contract = binding.role === 'Worker' && binding.taskId && binding.member && binding.workerId
            ? workerPaths(binding.taskId, binding.member, binding.workerId).contract : undefined
          return new FrameworkArtifacts(this.ctx, this.files, this.transactions, this.config.workspace).preserve(commandId, input, {
            ...options, cwd, beforeAttempt: async () => {
              if (this.closed) throw new Error('Role runtime is closed.')
              await options.beforeAttempt?.()
              options.signal?.throwIfAborted()
              if (this.closed) throw new Error('Role runtime is closed.')
              this.assertWorkerBusinessLive(binding)
            },
            ...(contract ? { readPlan: { files: [contract] } } : {}), beforeWrite: async snapshot => {
              await this.assertWorkerOwnsBusiness(binding, snapshot)
              // Pin the actual assignment consumed by this preservation attempt.
              if (contract) await this.files.read(snapshot, contract)
            }
          })
        }
      },
      ...(this.environment.capacity ? { capacity: this.environment.capacity } : {}),
      observation: { reset: (binding, input, commandId, signal) => {
        if (input.probeId !== undefined) return this.resetObservation(binding, input.probeId, commandId, signal)
        if (input.recoveryCheckId !== undefined) return this.resetRecoveryCheck(binding, input.recoveryCheckId, signal)
        throw new Error('Select the received probeId or the Helper’s actual recoveryCheckId.')
      } },
      helper: {
        notifications: binding => {
          const owner = this.roleRecords.get(binding.workId)
          return owner?.identity.executionId === binding.executionId ? this.helperResponsibilities(owner) : []
        },
        faults: binding => {
          const owner = this.roleRecords.get(binding.workId)
          if (binding.role !== 'Helper' || owner?.identity.executionId !== binding.executionId) return []
          const wakes = new Set(this.helperResponsibilities(owner).map(request => request.id))
          return [...this.safetyEpisodes.values()].filter(value => value.helperWakeId !== undefined && wakes.has(value.helperWakeId) && !this.resolvedSafetyFaultIds.has(value.fault.id))
            .map(value => structuredClone(value.fault))
        },
        recordAttempt: (binding, input, commandId) => this.recordSafetyAttempt(binding, input, commandId),
        request: async (binding, facts, commandId) => { await this.wake({ id: 'help:' + commandId, role: 'Helper', reason: 'helper', sources: [], context: { target: binding, facts } }); return { arranged: true } },
        restore: async (binding, input, commandId) => {
          const key = this.prefix + 'restores/' + hash(commandId)
          const caller = this.roleRecords.get(binding.workId)
          const diagnostic = caller?.identity.executionId === binding.executionId ? this.helperResponsibilities(caller).map(request => request.context)
            .find(context => context?.kind === 'admission-timeout' && (input.wakeId === context.wakeId
              || input.target && input.target.workId === context.workId && input.target.executionId === context.executionId)) : undefined
          const admissionWakeId = diagnostic?.kind === 'admission-timeout' && typeof diagnostic.wakeId === 'string'
            && (input.wakeId === diagnostic.wakeId || (input.target && input.target.workId === diagnostic.workId && input.target.executionId === diagnostic.executionId)) ? diagnostic.wakeId : undefined
          const safetyFaultIds = this.safetyFaultIds(binding).filter((id) => {
            const fault = this.safetyEpisodes.get(id)!.fault;
            if (fault.identity) return input.target?.workId === fault.identity.workId && input.target.executionId === fault.identity.executionId
            if (fault.taskId) return input.target?.taskId === fault.taskId
            return true;
          });
          const target = input.target ?? (input.wakeId ? (await this.records.get<WakeRecord>(this.prefix + 'wakes/' + hash(input.wakeId)))?.request : undefined)
          const taskOwner = target?.taskId && target.role !== 'Foreground' ? { taskId: target.taskId, lifecycleId: target.lifecycleId } : undefined
          const createdAt = new Date().toISOString()
          await this.createSafetyRestoreRow(key, { commandId, requester: binding, input, debugPath: helperDebugPath(taskOwner?.taskId, createdAt.slice(0, 10)), ...(taskOwner ? { taskOwner } : {}), ...safetyFaultIds.length ? { safetyFaultIds, safetyFaults: safetyFaultIds.map((id) => this.safetyEpisodes.get(id)!.fault), safetyKind: 'target' } : {}, ...(admissionWakeId ? { admissionWakeId } : {}), createdAt, complete: false });
          for (const id of safetyFaultIds) this.safetyEpisodes.get(id)!.commands.add(commandId);
          return { arranged: true }
        },
        restoreHost: async (binding, input, commandId) => {
          const key = this.prefix + 'host-restores/' + hash(commandId)
          const safetyFaultIds = this.safetyFaultIds(binding)
          const caller = this.roleRecords.get(binding.workId)
          const diagnosticTasks = safetyFaultIds.length
            ? safetyFaultIds.map(id => { const fault = this.safetyEpisodes.get(id)!.fault; return fault.taskId ?? fault.identity?.taskId })
            : caller?.identity.executionId === binding.executionId
              ? this.helperResponsibilities(caller).map(request => this.helperTaskOwner(request)?.taskId) : []
          const taskId = diagnosticTasks.length && diagnosticTasks[0]
            && diagnosticTasks.every(id => id === diagnosticTasks[0]) ? diagnosticTasks[0] : undefined
          const createdAt = new Date().toISOString()
          await this.createSafetyRestoreRow(key, {
            debugPath: helperDebugPath(taskId, createdAt.slice(0, 10)),
            commandId,
            requester: binding,
            input,
            ...safetyFaultIds.length ? { safetyFaultIds, safetyFaults: safetyFaultIds.map((id) => this.safetyEpisodes.get(id)!.fault), safetyKind: 'host' } : {},
            createdAt,
            complete: false
          });
          for (const id of safetyFaultIds) this.safetyEpisodes.get(id)!.commands.add(commandId);
          return { arranged: true }
        }
      }
    };
  }
  private rememberTerminalTask(task: TaskMetadata | undefined): void {
    if (task) {
      const previous = this.knownTaskLifecycles.get(task.taskId)
      this.knownTaskLifecycles.set(task.taskId, taskLifecycle(task))
      if (this.files instanceof PhysicalLocalFiles && previous !== taskLifecycle(task)) {
        // This is the already discovered Task, not another directory discovery.
        // Only its unfinished first control read remains until maintenance ends.
        this.pendingTaskControlDiscovery.set(task.taskId, { lifecycleId: taskLifecycle(task) })
        this.startTaskControlDiscovery(task.taskId)
      }
    }
    if (task && isTerminalTask(task)) this.observedTerminalTasks.set(taskLifecycleKey(task), task.status as 'complete' | 'cancelled');
  }
  private async observationTaskHeld(record: RoleRecord): Promise<boolean> {
    const taskId = await this.currentTask(record);
    const terminal = taskId && this.observedTerminalTasks.get(taskLifecycleKey({ taskId, lifecycleId: record.identity.lifecycleId }));
    if (terminal && record.identity.role === "Recorder") return false;
    if (terminal === "cancelled" && ["Planner", "Worker", "Organizer"].includes(record.identity.role)) return true;
    return this.controls.taskHeld(taskId, record.identity.lifecycleId);
  }
  private async resetObservation(binding: FrameworkRoleBinding, probeId: string, commandId: string, signal: AbortSignal) {
    if (binding.role === 'Foreground') throw new Error('Foreground does not use the DSS inactivity timer.')
    const record = this.roleRecords.get(binding.workId), agent = this.native.get(binding.workId)
    const current = () => !this.closed && record && agent && this.roleRecords.get(binding.workId) === record
      && record.identity.executionId === binding.executionId && record.identity.role === binding.role
      && !record.stopped && !record.released && !record.stopIntent && !record.stopUnknown
      && !this.stopOperations?.has(JSON.stringify([binding.workId, binding.executionId]))
      && this.native.get(binding.workId) === agent && agent.sessionId === record.sessionId
    signal.throwIfAborted()
    if (!current() || await this.controls.execution(binding) || await this.observationTaskHeld(record!) || !current()) throw new Error('Observation reset belongs to an unavailable execution.')
    const original = (await new DshSessionReader(this.ctx).inputs(record!.sessionId)).get(probeId);
    const issued = await this.records.get<ObservationRecord>(this.prefix + 'observations/' + hash(probeId))
    if (original?.state !== 'consumed' || original.source !== 'deepseek-servant'
      || issued?.pending.id !== probeId || issued.pending.action.identity.workId !== binding.workId
      || issued.pending.action.identity.executionId !== binding.executionId || issued.pending.action.stage === 3)
      throw new Error('Reset requires an actually received Host probe or warning for this execution.')
    const envelope = (JSON.parse(original.text) as { kind?: string; probeId?: string });
    if (envelope.probeId !== probeId || !['probe-role', 'warn-role', 'probe-helper', 'warn-helper'].includes(envelope.kind ?? ''))
      throw new Error('Native input is not a Host inactivity probe or warning.')
    const prefix = String(agent!.actualAgent.id) + ":";
    if (!commandId.startsWith(prefix)) throw new Error('Reset command does not belong to its native caller.')
    const callId = commandId.slice(prefix.length)
    const call = agent!.getMessages().flatMap(message => message.role === 'assistant' && typeof message.content !== 'string' ? message.content : []).find(block => block.type === 'tool-call' && String(block.id) === callId && block.name === 'dss_reset_observation');
    if (!call || call.type !== 'tool-call' || JSON.parse(call.arguments).probeId !== probeId) throw new Error('Reset differs from its original native tool call.')
    signal.throwIfAborted()
    if (!current() || await this.controls.execution(binding) || await this.observationTaskHeld(record!) || !current()) throw new Error('Execution changed before observation reset.')
    signal.throwIfAborted()
    const result = await this.observations.reset(record!.identity, probeId, issued.pending.cycleStartedAt);
    return { ...result, probeId }
  }
  setForegroundModel(model: DshModelRoute | undefined): void {
    this.config.foreground = model ? { ...model } : undefined
  }
  /** Only future native executions read this route; existing Agents keep theirs. */
  async prepareWorkspaceSelection(): Promise<void> {
    await Promise.all(this.workspaces.knownTasks().map(taskId => this.workspaces.bind(taskId)))
  }
  setWorkspace(workspace: string): void {
    this.workspaces.select(workspace)
    this.config.workspace = workspace
  }
  setBackgroundModel(model: DshModelRoute | undefined): void {
    this.config.background = model ? { ...model } : undefined
  }
  /** A successful local write schedules metadata refresh without delaying its
   * caller or waking any Agent. Native invalidation follows cache replacement. */
  refreshSkills(): void {
    if (this.closed) return
    this.skillCacheRefresh ??= new FrameworkSkillCacheRefresh(this.files, () => this.skillProviders.values(), error => {
      // runtime.error/environment.error can schedule Helper. This volatile
      // cache failure is diagnostic only; an existing publication event can retry it.
      this.ctx.logger?.('deepseek-servant').error('Skill catalog cache refresh failed; any existing confirmed catalog is retained, but this refresh did not complete.', error)
    })
    this.skillCacheRefresh.request()
  }
  private watchKey(taskId: string, member: string, lifecycleId?: string): string {
    return this.prefix + 'recovery-watch/' + hash(JSON.stringify([taskLifecycleKey({ taskId, lifecycleId }), member]));
  }
  private async serialRecoveryWatch<T>(taskId: string, member: string, operation: (key: string) => Promise<T>, lifecycleId?: string): Promise<T> {
    const key = this.watchKey(taskId, member, lifecycleId);
    const writes = this.recoveryWatchWrites ??= new Map()
    const pending = (writes.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => operation(key))
    writes.set(key, pending)
    try { return await pending }
    finally { if (writes.get(key) === pending) writes.delete(key) }
  }
  private async recoveryWatchChanges(binding: FrameworkRoleBinding, snapshot: FilesSnapshot): Promise<readonly FileChange[]> {
    if (!(this.records instanceof GitAuthorityStore)) return []
    if (binding.role !== 'Planner' || !binding.taskId || !binding.member) throw new Error('Only the bound member Planner consumes recovery.')
    const key = this.watchKey(binding.taskId, binding.member, binding.lifecycleId)
    const current = await this.records.getAt<RecoveryWatchRecord>(snapshot, key)
    return current?.watch ? [this.records.change(key, { ...current, watch: undefined, markerVersion: undefined })] : []
  }
  private async consumeRecoveryMarker(binding: FrameworkRoleBinding, consume: () => Promise<boolean>): Promise<void> {
    if (binding.role !== 'Planner' || !binding.taskId || !binding.member) throw new Error('Only the bound member Planner consumes recovery.')
    await this.serialRecoveryWatch(binding.taskId, binding.member, async key => {
      if (!await consume()) return
      // Git clears this same watch inside the original marker/Memory CAS.
      // Physical file identity additionally detects deletion/recreation after a
      // process exit before this technical watch save could complete.
      if (this.records instanceof GitAuthorityStore) return
      const current = await this.records.get<RecoveryWatchRecord>(key)
      if (current?.watch) await this.records.set(key, { ...current, watch: undefined, markerVersion: undefined })
    }, binding.lifecycleId)
  }
  private async taskMetadata(snapshot: FilesSnapshot): Promise<TaskMetadata[]> {
    this.taskMetadataIndex ??= new FrameworkTaskIndex(this.files, error => this.error(error))
    const tasks = await this.taskMetadataIndex.list(snapshot);
    for (const task of tasks) this.rememberTerminalTask(task);
    return tasks;
  }
  private async scanMembers(snapshot: FilesSnapshot, selected?: readonly TaskMetadata[]): Promise<MemberRecoveryInput[]> {
    const result: MemberRecoveryInput[] = []
    for (const task of selected ?? await this.taskMetadata(snapshot)) {
      try {
        if (task.route !== 'P' || task.status !== 'running' || await this.manuallyCleared(task.taskId, snapshot)) continue
        const member = this.config.member, inbox = paths.inbox(task.taskId, member)
        const entry = this.files instanceof PhysicalLocalFiles ? await this.files.fileMetadata(inbox)
          : (await this.files.listDirectory(snapshot, inbox.slice(0, inbox.lastIndexOf('/')))).find(item => item.path === inbox)
        if (!entry) continue
        const status = await readMemberStatus(this.files, snapshot, paths.memberStatus(task.taskId, member))
        const eligibility = {
          inboxHasContent: entry.bytes !== undefined ? entry.bytes > 0
            : entry.empty !== undefined ? !entry.empty : (await this.files.read(snapshot, inbox) ?? '').length > 0,
          status: status?.state ?? 'running', pendingBusiness: status?.state !== 'complete'
        }
        if (!memberRecoveryEligible(eligibility)) continue
        const planner = this.roleRecords.get(this.roleKey('Planner', task.taskId))
        const workers: MemberRecoveryInput['workers'][number][] = []
        const root = paths.member(task.taskId, member) + '/workers/'
        for (const note of await this.files.list(snapshot, root)) {
          if (!note.path.endsWith('/notes.md')) continue
          const workerId = note.path.slice(root.length).split('/')[0];
          const record = this.roleRecords.get(this.roleKey('Worker', task.taskId, workerId))
          workers.push({
            workerId, executionId: record?.identity.executionId ?? '', notePath: note.path,
            noteHasContent: note.bytes !== undefined ? note.bytes > 0
              : note.empty !== undefined ? !note.empty : (await this.files.read(snapshot, note.path) ?? '').length > 0,
            executing: record ? this.active(record) : false,
            ended: record ? record.businessTransferred === true || record.released === true || record.completedRound === true
              || !!record.gitSettledWakeId && record.gitSettledWakeId === (record.delivery?.request ?? record.lastWake)?.id : false
          })
        }
        result.push({
          taskId: task.taskId, member, taskPath: task.sourcePath, inboxPath: inbox,
          ...eligibility, needsRecovery: true,
          plannerExecutionId: planner?.identity.executionId ?? '', plannerMemoryPath: paths.member(task.taskId, member) + '/Planner_Memory.md',
          plannerExecuting: planner ? this.active(planner) : false, workers,
          pendingSignals: (await this.files.listDirectory(snapshot, paths.state(member, task.taskId))).map(signal => signal.path)
        })
      } catch (error) { this.error(error) }
    }
    return result
  }
  private async arrangeNativeContinuation(record: RoleRecord, context: Record<string, unknown>,
    inspection?: DshSessionInspection, explicitId?: string, fallback?: RoleWake, replacement?: RoleWake): Promise<RoleWake | undefined> {
    this.assertOrganizerBusiness(record)
    if (!await this.memberContinuationEligible(record)) return undefined
    if (record.released || await this.controls.execution(record.identity)) return undefined
    if (replacement && taskLifecycle(replacement) !== taskLifecycle(record.identity)) return undefined
    const selectedTaskId = await this.currentTask(record) ?? replacement?.taskId ?? fallback?.taskId;
    if (selectedTaskId && ['Planner', 'Worker', 'Organizer', 'Recorder'].includes(record.identity.role))
      await withSnapshot(this.files, (snapshot) => assertTaskLifecycle(this.files, snapshot, selectedTaskId, record.identity));
    if (['Planner', 'Worker', 'Organizer', 'Recorder'].includes(record.identity.role) && await this.manuallyCleared(await this.currentTask(record))) return undefined
    if (!record.stopped && record.stopIntent?.phase === 'disposed') {
      // A producer can publish its exact close receipt before the later stopped
      // acknowledgement. Reconcile that existing owner, never read its erased
      // native history or wait for Task/cleaner completion to recover its input.
      if (this.active(record)) return undefined
      const result = await this.stopOwnedRecord(record)
      const current = this.roleRecords.get(record.identity.workId)
      if (!current || current.identity.executionId !== record.identity.executionId || current.sessionId !== record.sessionId) return undefined
      if (result.status !== 'stopped') {
        if (result.status === 'unconfirmed') {
          await this.saveRole({ ...current, stopUnknown: result })
          throw new Error(result.reason)
        }
        return undefined
      }
      if (!current.stopped) await this.saveRole({ ...current, stopped: true })
      const settled = this.roleRecords.get(record.identity.workId)
      if (!settled || settled.identity.executionId !== record.identity.executionId || settled.sessionId !== record.sessionId) return undefined
      // Reconciliation updates lifecycle facts, not the caller-validated input
      // selection (for example an admitted child O with an unadmitted newer wake).
      record = { ...settled, lastWake: record.lastWake, delivery: record.delivery }
    }
    if (!replacement) {
      const pending = (await this.records.list<WakeRecord>(this.prefix + 'wakes/')).find(row => !row.value.delivered
        && row.value.request.id !== record.delivery?.request.id
        && row.value.recovery?.targetExecutionId === record.identity.executionId
        && this.requestKey(row.value.request) === record.identity.workId)
      if (pending) return pending.value.request
    }
    if (record.stopped) {
      const original = record.delivery?.request ?? record.lastWake ?? fallback
      if (!original) return undefined
      const prior = await this.records.get<WakeRecord>(this.prefix + 'wakes/' + hash(original.id))
      const request: RoleWake = {
        ...(replacement ?? original),
        ...record.identity.lifecycleId ? { lifecycleId: record.identity.lifecycleId } : {},
        id: replacement?.id ?? explicitId ?? 'closed-continuation:' + record.identity.executionId,
        reason: replacement?.reason ?? 'startup-recovery',
        context: {
          ...original.context, ...context,
          ...(record.notificationClaims ? { notificationClaims: record.notificationClaims } : {}),
          originalWake: typeof original.context?.originalWake === 'string' ? original.context.originalWake : prior?.recovery?.original?.request.id ?? original.id,
          originalInput: typeof original.context?.originalInput === 'string' ? original.context.originalInput : prior?.recovery?.original?.text ?? record.delivery?.text,
          continuationInstructions: 'Continue the accepted responsibility from the saved original input and current Task, role memory, notes, replies and handoff records. Original input is context, not permission to repeat committed effects.'
        }
      };
      const recovery: WakeRecovery = {
        targetExecutionId: record.identity.executionId,
        confirmedStoppedExecutions: [record.identity.executionId],
        ...(record.delivery ? { original: record.delivery } : !record.lastWake && fallback ? { replacesUnadmittedWake: fallback.id } : {})
      }
      await this.wake(request, recovery, prior?.safetyFaults, original.id)
      this.replaySafetyWake({ request, recovery, safetyFaults: prior?.safetyFaults, safetyParentWakeId: original.id })
      return request
    }
    const inputs = record.delivery ? await new DshSessionReader(this.ctx).inputs(record.sessionId) : new Map()
    const resolved = resolveNativeRecoveryInput(record.delivery, record.lastWake ?? fallback, inputs)
    if (!resolved || resolved.active) return undefined
    const prior = await this.records.get<WakeRecord>(this.prefix + 'wakes/' + hash(resolved.request.id))
    if (prior?.recovery && resolved.state === 'unknown') throw new Error('Confirmed recovery input has no available native consumption evidence; preserve it for diagnosis.')
    const reuse = prior?.recovery && resolved.state !== 'consumed' && !replacement
    const request: RoleWake = reuse ? prior.request : {
      ...(replacement ?? resolved.request),
      id: replacement?.id ?? explicitId ?? nativeRecoveryWakeId(record.sessionId, inspection?.lastTurn?.turn,
        resolved.messageId ?? resolved.request.id), reason: replacement?.reason ?? 'startup-recovery',
      context: {
        ...resolved.request.context, ...context, ...(record.notificationClaims ? { notificationClaims: record.notificationClaims } : {}),
        originalWake: typeof resolved.request.context?.originalWake === 'string' ? resolved.request.context.originalWake : prior?.recovery?.original?.request.id ?? resolved.request.id,
        originalInput: typeof resolved.request.context?.originalInput === 'string' ? resolved.request.context.originalInput : prior?.recovery?.original?.text ?? resolved.text,
        originalMessageId: resolved.messageId, nativeInputState: resolved.state,
        interruptedTurn: inspection?.lastTurn
      }
    }
    const recovery: WakeRecovery = reuse ? { ...prior.recovery, explanationText: prior.recovery!.explanationText ?? resolved.text } : {
      targetExecutionId: record.identity.executionId,
      ...(!record.delivery && fallback && resolved.request.id === fallback.id ? { replacesUnadmittedWake: fallback.id } : {}),
      ...(record.delivery ? { original: { ...record.delivery, text: resolved.text } } : {})
    };
    await this.wake(request, recovery, prior?.safetyFaults, resolved.request.id)
    this.replaySafetyWake({ request, recovery, safetyFaults: prior?.safetyFaults, safetyParentWakeId: resolved.request.id })
    return request
  }
  private async recoverGitResponsibility(record: RoleRecord): Promise<boolean> {
    this.assertOrganizerBusiness(record)
    if (this.config.mode !== 'git' || record.released || this.active(record)) return false
    if (record.completedRound) return true
    if (record.gitSettledWakeId && record.gitSettledWakeId === (record.delivery?.request ?? record.lastWake)?.id
      && (!(!!record.identity.taskId && (record.identity.role === 'Planner' || record.identity.role === 'Worker' || record.identity.role === 'Recorder'))
        || !(await new DshSessionReader(this.ctx).inspect(record.sessionId)).unansweredQuestionCallIds?.length)) return true
    const original = record.delivery?.request ?? record.lastWake
    if (!original) return false
    if (await this.controls.execution(record.identity)) return true
    if (!record.stopped) {
      // An absent session is not stop evidence. Preserve this Git responsibility
      // for explicit reconciliation rather than silently forgetting or duplicating it.
      return false
    }
    const request: RoleWake = {
      ...original, id: 'git-continuation:' + record.identity.executionId,
      reason: 'startup-recovery', context: {
        ...original.context,
        ...(record.notificationClaims ? { notificationClaims: record.notificationClaims } : {}),
        originalWake: typeof original.context?.originalWake === 'string' ? original.context.originalWake : original.id,
        originalInput: typeof original.context?.originalInput === 'string' ? original.context.originalInput : record.delivery?.text,
        continuationInstructions: 'Resume the accepted Git responsibility from its original input, available native session history, takeover records and committed results. Do not repeat already committed effects.'
      }
    }
    const questionSession = (record.identity.role === 'Foreground' || !!record.identity.taskId && (record.identity.role === 'Planner' || record.identity.role === 'Worker' || record.identity.role === 'Recorder'))
      && (await new DshSessionReader(this.ctx).inspect(record.sessionId)).unansweredQuestionCallIds?.length
      ? record.sessionId : undefined
    const replacement: RoleRecord = {
      ...(record.notificationClaims ? { notificationClaims: record.notificationClaims } : {}), identity: { ...record.identity, executionId: randomUUID() },
      sessionId: questionSession ?? 'dss-' + randomUUID(), generation: record.generation + 1
    }
    const priorWake = record.identity.role === 'Helper' ? await this.records.get<WakeRecord>(this.prefix + 'wakes/' + hash(original.id)) : undefined
    await this.wake(request, undefined, priorWake?.safetyFaults, original.id)
    this.replaySafetyWake({ request, safetyFaults: priorWake?.safetyFaults, safetyParentWakeId: original.id })
    await this.saveRole(replacement)
    return true;
  }
  private async retainClosedRound(record: RoleRecord, owned: OwnedDshAgent): Promise<void> {
    const request = record.delivery?.request ?? record.lastWake
    if (!request || record.completedRound || record.gitSettledWakeId === request.id) return
    const actual = owned.actualAgent, events = actual.session.snapshotEvents()
    if ((record.identity.role === 'Foreground' || !!record.identity.taskId && (record.identity.role === 'Planner' || record.identity.role === 'Worker' || record.identity.role === 'Recorder'))
      && this.ctx.get('sessionProjections')?.stateOf(actual.session, 'userQuestions')?.questions.active.length) return
    const boundary = [...events].reverse().find(event => event.type === 'turn/start' || event.type === 'turn/end')
    if (boundary?.type !== 'turn/end' || boundary.data.reason.kind !== 'completed'
      || actual.inbox.nextTurn.length || actual.inbox.nextStep.length) {
      return;
    }
    const helperCommands = this.records instanceof GitAuthorityStore && record.identity.role === 'Helper'
    let completed = this.records instanceof GitAuthorityStore && record.identity.role === 'Foreground'
      ? new NativeCommandSuccess(new Set(['dss_record', 'dss_submit_task', 'dss_supplement_task', 'dss_workspace_reference'])) : undefined
    const unresolved = new Set<string>()
    for (const event of events) {
      if (event.seq >= actual.session.inheritedEventCount) {
        if (helperCommands && event.type === 'turn/start') completed = new NativeCommandSuccess(new Set(['dss_record']))
        completed?.accept(event)
      }
      if (event.type === 'tool/call') unresolved.add(event.data.callId)
      if (event.type === 'tool/result') unresolved.delete(event.data.message.toolCallId)
    }
    if (unresolved.size) return
    const inputs = deriveNativeInputs(events, { 'next-turn': actual.inbox.nextTurn, 'next-step': actual.inbox.nextStep }, false)
    if (record.delivery && inputs.get(record.delivery.messageId)?.state !== 'consumed') return
    if (request.sources.some((source) => parseDirectSignal(source.path.split('/').at(-1)!))) {
      if (!directDeliveryCompleted(events)) return
    }
    let nativeFlushed = false
    if (this.files instanceof PhysicalLocalFiles && events.some(event => event.type === 'tool/call'
      && ['dss_supplement_task', 'dss_planner_dispatch', 'dss_preserve_artifact'].includes(event.data.name))) {
      await this.ctx.sessions.flush(actual.session)
      nativeFlushed = true
      await retirePhysicalPublicationsFromEvents(this.files, record.identity.executionId, events)
    }
    await this.saveRole({
      ...record,
      ...(record.identity.role === 'Foreground' ? { completedRound: true } : { gitSettledWakeId: request.id })
    }, false, undefined, false, completed?.callIds().map(id => record.sessionId + ':' + id));
    if (record.identity.role === 'Helper') {
      if (!nativeFlushed) await this.ctx.sessions.flush(actual.session)
      this.scheduleCompletedHostRestoreRetirement(record, events)
      await this.retireSettledHelperWakes(record, events)
    }
  }
  private async finishGitAuxiliaryRound(record: RoleRecord): Promise<void> {
    // A delivered Worker is retired by the transfer drain, not by another wake
    // inspection. A queued poll may still hold its pre-transfer RoleRecord.
    if (record.identity.role === 'Worker' && (record.businessTransferred || this.retiredWorkers?.has(record.identity.executionId))) return
    const request = record.delivery?.request ?? record.lastWake
    if (!request) return
    if (record.gitSettledWakeId === request.id) {
      await this.retrySettledHelperWakeRetirement(record)
      return
    }
    if (record.stopped || record.stopIntent || this.active(record)) return
    const direct = (record.delivery?.request ?? record.lastWake)?.sources.some((source) => parseDirectSignal(source.path.split('/').at(-1)!));
    if (record.identity.role === 'Foreground' && !direct) return
    const sessions = new DshSessionReader(this.ctx)
    if (!!record.identity.taskId && (record.identity.role === 'Planner' || record.identity.role === 'Worker' || record.identity.role === 'Recorder')) {
      const live = this.ctx.sessions.get(SessionId(record.sessionId))
      const questions = live
        ? this.ctx.get('sessionProjections')?.stateOf(live, 'userQuestions')?.questions.active.length
        : (await sessions.inspect(record.sessionId)).unansweredQuestionCallIds?.length
      if (questions) return
    }
    if (['Planner', 'Worker'].includes(record.identity.role) && record.identity.taskId) {
      const input = resolveNativeRecoveryInput(record.delivery, record.lastWake, await sessions.inputs(record.sessionId))
      if (input?.state !== 'consumed') return
    }
    // Freeze Helper evidence before capture's existing native durability barrier.
    // A result appended after that barrier cannot retire its wake in this pass.
    const helperEvents = record.identity.role === 'Helper' ? await sessions.events(record.sessionId) : undefined
    let completed: NativeCommandSuccess | undefined
    const reportEvidence = this.records instanceof GitAuthorityStore && record.identity.role === 'Helper'
      ? (event: import('@deepseek-ai/dsh-session').SessionEvent) => {
        if (event.type === 'turn/start') completed = new NativeCommandSuccess(new Set(['dss_record']))
        completed?.accept(event)
      } : undefined
    const capture = await sessions.capture(record.sessionId, reportEvidence)
    if (!capture.finished) return
    const events = helperEvents ?? (this.files instanceof PhysicalLocalFiles || direct || record.identity.role === 'Helper'
      ? await sessions.events(record.sessionId) : [])
    if (this.files instanceof PhysicalLocalFiles) await retirePhysicalPublicationsFromEvents(this.files, record.identity.executionId, events)
    if (direct) {
      if (!directDeliveryCompleted(events)) return
    }
    await this.saveRole({ ...record, gitSettledWakeId: request.id }, false, undefined, record.identity.role === 'Recorder',
      completed?.callIds().map(id => record.sessionId + ':' + id))
    this.scheduleCompletedHostRestoreRetirement(record, events)
    await this.retireSettledHelperWakes(record, events)
  }
  // A single Helper's last checked RoleRecord, not a durable index. New claims
  // or replacement records invalidate it; unchanged idle callbacks cost no I/O.
  private helperRetirementChecked?: RoleRecord
  private async retrySettledHelperWakeRetirement(record: RoleRecord): Promise<void> {
    if (record.identity.role !== 'Helper' || !record.gitSettledWakeId
      || record.gitSettledWakeId !== record.delivery?.request.id || this.helperRetirementChecked === record) return
    const events = await new DshSessionReader(this.ctx).events(record.sessionId)
    const live = this.ctx.sessions.get(SessionId(record.sessionId))
    if (live) await this.ctx.sessions.flush(live)
    this.scheduleCompletedHostRestoreRetirement(record, events)
    await this.retireSettledHelperWakes(record, events)
  }
  private hostRestoreNativeEvidence?: Map<string, { workId: string; executionId: string }>
  private hostRestoreEvidenceCursor?: { sessionId: string; seq: number }
  private considerHostRestoreRetirement(value: HostRestore): void {
    const proof = this.hostRestoreNativeEvidence?.get(value.commandId)
    if (!proof) return
    if (value.requester?.role !== 'Helper' || value.requester.workId !== proof.workId
      || value.requester.executionId !== proof.executionId || value.safetyFaults?.some(fault => fault.operationId)) {
      this.hostRestoreNativeEvidence!.delete(value.commandId)
      return
    }
    if (value.complete && ![...(value.safetyFaultIds ?? []), ...(value.safetyFaults ?? []).map(fault => fault.id)]
      .some(id => !this.resolvedSafetyFaultIds.has(id))) this.scheduleHostRestoreRetirement(value.commandId, proof)
  }
  /** Reuse the original events already covered by the Helper's normal flush.
   * A single current-session cursor prevents old results from recreating proof
   * after its exact Host responsibility has retired. No session log is reread. */
  private scheduleCompletedHostRestoreRetirement(record: RoleRecord,
    events: readonly import('@deepseek-ai/dsh-session').SessionEvent[]): void {
    if (record.identity.role !== 'Helper' || !events.length) return
    const current = this.roleRecords.get(record.identity.workId)
    if (current?.identity.executionId !== record.identity.executionId || current.sessionId !== record.sessionId) return
    const cursor = this.hostRestoreEvidenceCursor
    const after = cursor?.sessionId === record.sessionId ? cursor.seq : undefined
    const lastSequence = events.at(-1)!.seq
    if (after !== undefined && lastSequence <= after) return
    this.hostRestoreEvidenceCursor = { sessionId: record.sessionId, seq: lastSequence }
    const calls = new Map(events.flatMap(event => event.type === 'tool/call' && event.data.name === 'dss_restore_host'
      ? [[event.seq, event] as const] : []))
    for (const event of events) {
      if (event.type !== 'tool/result' || after !== undefined && event.seq <= after
        || event.surfaceOp !== 'append' || event.data.message.isError) continue
      const call = event.sourceEventSeqs?.map(seq => calls.get(seq)).find(call => call
        && call.data.turn === event.data.turn && call.data.step === event.data.step
        && call.data.callId === event.data.message.toolCallId)
      if (!call) continue
      const commandId = record.sessionId + ':' + call.data.callId
      const proof = { workId: record.identity.workId, executionId: record.identity.executionId }
      ;(this.hostRestoreNativeEvidence ??= new Map()).set(commandId, proof)
      this.scheduleHostRestoreRetirement(commandId, proof)
    }
  }
  private scheduleHostRestoreRetirement(commandId: string, proof: { workId: string; executionId: string }): void {
    this.startMaintenance('host-restore-retirement:' + commandId,
      () => this.retireCompletedHostRestore(commandId, proof),
      { hostRestorationCommandId: commandId, phase: 'retirement' })
  }
  private async retireCompletedHostRestore(commandId: string, proof: { workId: string; executionId: string }): Promise<void> {
    const key = this.prefix + 'host-restores/' + hash(commandId)
    const forget = () => { if (this.hostRestoreNativeEvidence?.get(commandId) === proof) this.hostRestoreNativeEvidence.delete(commandId) }
    const previous = this.safetyRestoreWrites.get(commandId)
    const operation = (previous ?? Promise.resolve()).then(async () => {
      const current = await this.records.get<HostRestore>(key)
      if (!current || current.commandId !== commandId || current.requester?.role !== 'Helper'
        || current.requester.workId !== proof.workId || current.requester.executionId !== proof.executionId
        || current.safetyFaults?.some(fault => fault.operationId)) { forget(); return }
      if (!current.complete || [...(current.safetyFaultIds ?? []), ...(current.safetyFaults ?? []).map(fault => fault.id)]
        .some(id => !this.resolvedSafetyFaultIds.has(id))) return
      // Only the original temporary publication retires, never its Debug body.
      if (!await this.retirePhysicalRestoreDebug(key, current)) return
      // The completed Host responsibility owns only this command's Git receipt.
      // Keep it through restoration; retire it atomically with the original row.
      await this.deleteRuntimeRecord(key, current, [gitCommandReceiptPath('host-restore:' + commandId)])
      forget()
      // The original Host row was a real last consumer, not a timer or a
      // Task-completion gate. Retry its exact predecessor after any current read.
      const owner = this.roleRecords.get(proof.workId)
      const retired = owner?.nativeRetirements?.find(item => item.helper && item.executionId === proof.executionId)
      if (owner && retired) {
        const pending = this.nativeRetirementOperations?.get(proof.workId + '\0' + retired.sessionId)
        void Promise.resolve(pending).catch(() => {}).then(() => {
          const latest = this.roleRecords.get(proof.workId)
          if (latest) this.continueNativeRetirements(latest)
        })
      }
    })
    this.safetyRestoreWrites.set(commandId, operation)
    try { await operation }
    finally { if (this.safetyRestoreWrites.get(commandId) === operation) this.safetyRestoreWrites.delete(commandId) }
  }
  /** Retire only plain, actually consumed Helper inputs after the existing
   * settled-role save. Complex restore/fault/ancestry ownership stays intact.
   * No directory scan, permanent receipt, timer, or cross-work wait is added. */
  private async retireSettledHelperWakes(record: RoleRecord,
    events: readonly import('@deepseek-ai/dsh-session').SessionEvent[]): Promise<void> {
    if (record.identity.role !== 'Helper' || !record.delivery?.confirmed) return
    const initial = record.delivery.request
    const owner = () => {
      const current = this.roleRecords.get(record.identity.workId)
      return current?.identity.executionId === record.identity.executionId && current.sessionId === record.sessionId
        && current.delivery?.request.id === initial.id && current.gitSettledWakeId === initial.id
        && !current.stopUnknown && !current.released ? current : undefined
    }
    const checkedOwner = owner()
    if (!checkedOwner) return
    // Scope restore ownership to this actual input, not the entire session.
    // Earlier deliveries may have their own retained restores.
    const start = events.findIndex(event => event.type === 'user/message'
      && event.surfaceOp === 'append' && event.data.id === record.delivery!.messageId)
    if (start < 0) return
    const inputEvents = events.slice(start)
    // A Host restore owns its accepted HostRestore row independently of the
    // caller's plain wake. A targeted restore may still reference that wake.
    if (inputEvents.some(event => event.type === 'tool/call' && event.data.name === 'dss_restore')) return
    const boundary = [...events].reverse().find(event => event.type === 'turn/start' || event.type === 'turn/end')
    if (boundary?.type !== 'turn/end' || boundary.data.reason.kind !== 'completed') return
    const pending = new Set<string>(), calls = new Set<string>(), returned = new Map<string, RoleWake>()
    const claims = Object.values(checkedOwner.notificationClaims ?? {})
    // A current-delivery claim proves that this turn received the complete
    // outstanding Helper context. Reuse each input's original immutable claim;
    // an initial-only delivery still causes no historical wake reads.
    const hasCurrentClaim = claims.some(claim => claim.wakeId === initial.id
      && claim.executionId === record.identity.executionId && claim.helperWakes?.length)
    const accepted = new Map((hasCurrentClaim ? claims : [])
      .flatMap(claim => claim.helperWakes ?? []).map(wake => [wake.id, wake]))
    for (const event of inputEvents) {
      if (event.type === 'tool/call') {
        pending.add(event.data.callId)
        if (['dss_claim', 'dss_snapshot'].includes(event.data.name)) calls.add(event.data.callId)
      }
      if (event.type !== 'tool/result') continue
      pending.delete(event.data.message.toolCallId)
      if (event.data.message.isError || !calls.has(event.data.message.toolCallId)) continue
      for (const block of event.data.message.content) {
        if (block.type !== 'text') continue
        let value: { helperNotifications?: unknown }
        try { value = JSON.parse(block.text) } catch { continue }
        if (!value || !Array.isArray(value.helperNotifications)) continue
        for (const delivered of value.helperNotifications) {
          const original = delivered && typeof delivered === 'object' ? accepted.get(delivered.id) : undefined
          if (original && JSON.stringify(delivered) === JSON.stringify(original)) returned.set(original.id, original)
        }
      }
    }
    if (pending.size) return
    const input = deriveNativeInputs(events, undefined, false).get(record.delivery.messageId)
    if (input?.state !== 'consumed' || input.source !== 'deepseek-servant') return
    returned.set(initial.id, initial)
    let changed = false
    for (const request of returned.values()) {
      // Consuming/ending a native turn does not finish this Task's diagnosis.
      // Its original WakeRecord remains the sole pending business context.
      if (this.helperTaskOwner(request)) continue
      const key = this.prefix + 'wakes/' + hash(request.id)
      // All ordinary mutations of this wake use this exact existing lane.
      const operation = (this.wakeWrites.get(key) ?? Promise.resolve()).then(async () => {
        if (!owner()) return
        const wake = await this.records.get<WakeRecord>(key)
        if (!wake || !owner() || !wake.delivered || JSON.stringify(wake.request) !== JSON.stringify(request)
          || wake.recovery || wake.safetyParentWakeId || wake.safetyFaults?.length || wake.safetyAttempts?.length
          || wake.resolvedSafetyFaultIds?.length || request.reason === 'startup-recovery'
          || request.context?.originalWake || request.context?.notificationClaims || request.context?.safetyFault
          || request.context?.safetyFaults) return
        if ((wake.helperSignal || request.sources.some(source => source.path.startsWith('state/')))
          && !wake.signalsConsumed) return
        // A fault already selected this original owner but has not yet written
        // its wake body. That is live responsibility, not completed metadata.
        if ([...this.safetyEpisodes.values()].some(episode => episode.helperWakeId === request.id)) return
        if (this.records instanceof GitAuthorityStore) {
          try { await this.records.compareAndDelete(key, wake) }
          catch (error) {
            if (!(error instanceof FilesConflictError)) throw error
            changed = true // Retry only these known IDs on the next original entry.
          }
        } else if (this.records.delete) await this.records.delete(key)
      })
      this.wakeWrites.set(key, operation)
      try { await operation }
      finally { if (this.wakeWrites.get(key) === operation) this.wakeWrites.delete(key) }
    }
    // A native child can awaken this same session and claim more work while
    // exact wake I/O is pending. Cache only the record actually inspected.
    if (!changed && owner() === checkedOwner && [...accepted.keys()].every(id => returned.has(id)))
      this.helperRetirementChecked = checkedOwner
  }
  /** Helper explicitly finishes one of its actual checks. The original marker
   * remains Planner-owned; native turn completion does not reset this clock. */
  private async resetRecoveryCheck(binding: FrameworkRoleBinding, recoveryCheckId: string, signal: AbortSignal) {
    const currentCaller = () => {
      signal.throwIfAborted()
      const record = this.roleRecords.get(binding.workId)
      if (this.closed || binding.role !== 'Helper' || record?.identity.executionId !== binding.executionId
        || record.stopped || record.released || record.stopIntent || record.stopUnknown)
        throw new Error('Recovery check reset belongs to the current owning Helper execution.')
      return record
    }
    const request = this.helperResponsibilities(currentCaller()).find(item => item.id === recoveryCheckId)
    const check = request?.context?.observation as { kind?: string; taskId?: string; member?: string; cycleStartedAt?: number } | undefined
    if (!request || check?.kind !== 'recovery-check' || !check.taskId || !check.member || typeof check.cycleStartedAt !== 'number')
      throw new Error('Select an actual member recovery check from this Helper’s original notifications.')
    const didReset = await this.serialRecoveryWatch(check.taskId, check.member, async key => {
      const reset = (current: RecoveryWatchRecord | undefined): RecoveryWatchRecord | undefined => {
        currentCaller()
        if (!current?.watch || current.released || current.watch.cycleStartedAt !== check.cycleStartedAt) return
        return { ...current, watch: createRecoveryWatch({ taskId: check.taskId!, member: check.member! }, Date.now()) }
      }
      if (this.records instanceof GitAuthorityStore) {
        return this.records.updateWithReads<RecoveryWatchRecord, boolean>(key, [], current => {
          const value = reset(current)
          return value ? { value, result: true, write: true } : { result: false, write: false }
        })
      }
      const value = reset(await this.records.get<RecoveryWatchRecord>(key))
      if (!value) return false
      await this.records.set(key, value)
      return true
    }, request.lifecycleId)
    return { reset: didReset, status: didReset ? 'reset' : 'superseded', recoveryCheckId }
  }
  private async beforeTaskUse(taskId: string | undefined, wait = true): Promise<boolean> {
    const ready = !taskId || await this.environment.beforeTaskUse?.(taskId, wait) !== false
    if (!ready) for (const [key, state] of this.localWakeAdmissions) if (state.wake.request.taskId === taskId) {
      state.held = true; this.clearLocalAdmissionInterval(key, state)
      ;(this.restoringAdmissionWakes ??= new Set()).add(key)
    }
    return ready
  }
  private async memberContinuationEligible(record: RoleRecord): Promise<boolean> {
    const selectedTaskId = await this.currentTask(record)
    if (!await this.beforeTaskUse(selectedTaskId) || this.closed) return false
    if (selectedTaskId && ['Planner', 'Worker', 'Organizer', 'Recorder'].includes(record.identity.role)
      && await withSnapshot(this.files, async snapshot => !await readJson<TaskMetadata>(this.files, snapshot, paths.task(selectedTaskId))
        && !!await readTaskHistoryIdentity(this.files, snapshot, selectedTaskId))) return false
    if (!['Planner', 'Worker'].includes(record.identity.role) || !record.identity.taskId) return true
    const { taskId, member } = record.identity
    if (member !== this.config.member || await this.controls.taskHeld(taskId, record.identity.lifecycleId)) return false;
    return withSnapshot(this.files, async (snapshot) => {
      if (await this.manuallyCleared(taskId, snapshot)) return false
      const task = await readJson<TaskMetadata>(this.files, snapshot, paths.task(taskId))
      if (task?.route === 'O') {
        if (!record.stopped) this.trackedStop(record)
        return false
      }
      if (task?.status !== 'running' || taskLifecycle(task) !== taskLifecycle(record.identity) || task.members && !task.members.includes(member)) return false;
      const status = await readMemberStatus(this.files, snapshot, paths.memberStatus(taskId, member))
      return status?.state !== 'complete'
    });
  }
  private async memberNativeRoundSettled(record: RoleRecord, inspection: DshSessionInspection, sessions: DshSessionReader): Promise<boolean> {
    if (!inspection.exists || !inspection.lifecycleKnown || !inspection.lastTurn?.closed
      || inspection.unansweredQuestionCallIds?.length || inspection.unresolvedToolCallIds.length || inspection.queuedInbox.nextTurn.length || inspection.queuedInbox.nextStep.length) return false
    if (inspection.lastTurn.reason === 'completed') return true
    if (record.identity.role !== 'Worker') return false
    const events = await sessions.events(record.sessionId)
    if (this.files instanceof PhysicalLocalFiles) await retirePhysicalPublicationsFromEvents(this.files, record.identity.executionId, events)
    const deliveries = new Set(events.filter((event) => event.type === 'tool/call' && event.data.turn === inspection.lastTurn!.turn && event.data.name === 'dss_worker_deliver').map((event) => (event as Extract<import('@deepseek-ai/dsh-session').SessionEvent, { type: 'tool/call' }>).data.callId));
    return events.some((event) => event.type === 'tool/result' && event.data.turn === inspection.lastTurn!.turn && !event.data.message.isError && deliveries.has(event.data.message.toolCallId));
  }
  private async diagnoseMissingTask(record: RoleRecord): Promise<boolean> {
    if (!["Planner", "Worker", "Organizer", "Recorder"].includes(record.identity.role)) return false;
    const taskId = await this.currentTask(record);
    if (!taskId) return false;
    // An actual import is not a missing-Task fault and must not wake Helper.
    if (!await this.beforeTaskUse(taskId) || this.closed) return true
    const selected = await withSnapshot(this.files, async snapshot => ({
      task: await readJson<TaskMetadata>(this.files, snapshot, paths.task(taskId)),
      history: await readTaskHistoryIdentity(this.files, snapshot, taskId)
    }))
    if (!selected.task && selected.history) return true
    if (selected.task?.parent && !await this.beforeTaskUse(selected.task.parent.taskId)) return true
    const missing = await withSnapshot(this.files, async (snapshot) => {
      const task = await readJson<TaskMetadata>(this.files, snapshot, paths.task(taskId));
      if (!task) return { missingTaskId: taskId };
      if (task.parent && !await readJson<TaskMetadata>(this.files, snapshot, paths.task(task.parent.taskId))
        && !await readTaskHistoryIdentity(this.files, snapshot, task.parent.taskId))
        return { missingTaskId: task.parent.taskId, parent: task.parent };
      return void 0;
    });
    if (!missing) {
      const current = await withSnapshot(this.files, (snapshot) => readJson<TaskMetadata>(this.files, snapshot, paths.task(taskId)));
      if (current && taskLifecycle(current) !== taskLifecycle(record.identity)) {
        if (!record.stopped) this.trackedStop(record);
        return true;
      }
      return false;
    }
    this.error(new Error("A retained execution references missing Task metadata. Inspect its archived records before deciding how to reconcile this instance."), {
      identity: record.identity,
      taskId,
      sessionId: record.sessionId,
      stage: "startup-missing-task",
      ...missing,
      taskMetadataPath: paths.task(taskId),
      missingTaskMetadataPath: paths.task(missing.missingTaskId),
      recordLocations: [.../* @__PURE__ */ new Set([taskId, missing.missingTaskId])].map((id) => ({
        taskId: id,
        taskMetadataPath: paths.task(id),
        cachePath: paths.cache(id)
      })),
      originalWake: record.delivery?.request ?? record.lastWake,
      instructions: "Read the actual records to establish cancellation, completion, relocation or unresolved work. Then use existing repair tools to reconcile only this instance internal state. Missing metadata alone is not permission to clear or restart work. Preserve original files, results and native history; report missing or ambiguous evidence instead of inventing an outcome."
    });
    return true;
  }
  private async startup(): Promise<void> {
    this.safetyResolutionReady = false
    this.skipInitialSealedPass = true
    this.startSafetyResolutionLoad()
    try { await this.processObservations(true, 'all', !this.environment.beforeTaskUse) } catch (error) { this.error(error) }
    if (!this.environment.beforeTaskUse) { await this.startupRecovery(); return }
    // Each original Task owns its own restoration wait. The Host startup and
    // unrelated roles return to discovery without joining these promises.
    const tasks = new Set((await withSnapshot(this.files, snapshot => new FrameworkTaskIndex(this.files, error => this.error(error)).list(snapshot))).map(task => task.taskId))
    for (const record of this.roleRecords.values()) {
      const taskId = await this.currentTask(record)
      if (taskId) tasks.add(taskId)
    }
    const facts = await this.readStartupRecoveryFacts()
    this.pendingStartupTasks = new Map([...tasks].map(taskId => [taskId, facts]))
    this.retryStartupTasks()
    this.startMaintenance('startup-unbound', () => this.startupRecovery({ facts }))
    this.startOwnedPump()
  }
  private retryStartupTasks(): void {
    for (const [taskId, facts] of this.pendingStartupTasks ?? []) this.startMaintenance('startup-task:' + taskId, async () => {
      if (!await this.beforeTaskUse(taskId) || this.closed) return
      await this.startupRecovery({ taskId, facts })
      this.pendingStartupTasks?.delete(taskId)
      ; (this.completedStartupTasks ??= new Set()).add(taskId)
    }, { taskId, stage: 'startup-task-restoration' })
  }
  /** Called only by the actual AI Task conversion completion, including a
   * Task absent from the physical directory and native records at boot. */
  resumeImportedTask(taskId: string): void {
    if (this.closed || !this.environment.beforeTaskUse || this.completedStartupTasks?.has(taskId)) return
    this.startMaintenance('startup-task:' + taskId, async () => {
      if (!await this.beforeTaskUse(taskId) || this.closed) return
      const facts = this.pendingStartupTasks?.get(taskId) ?? await this.readStartupRecoveryFacts()
      await this.startupRecovery({ taskId, facts })
      this.pendingStartupTasks?.delete(taskId)
      ; (this.completedStartupTasks ??= new Set()).add(taskId)
    }, { taskId, stage: 'imported-task-restoration' })
  }
  private async readStartupRecoveryFacts(): Promise<StartupRecoveryFacts> {
    // These are this boot's original responsibilities, not a repeating query of
    // normal runtime work. Late imports reuse the same inventory. A role's new
    // exact pending continuation is checked by arrangeNativeContinuation.
    if (this.startupRecoveryFacts) return this.startupRecoveryFacts
    const restoring = new Set((await this.records.list<ObservationRecord>(this.prefix + 'observations/'))
      .filter(row => !row.value.complete && row.value.stopStarted).map(row => row.value.pending.action.identity.executionId))
    const wakes = await this.records.list<WakeRecord>(this.prefix + 'wakes/')
    // Hydrate once from the original startup inventory. Subsequent changes
    // follow updateWake/deleteRuntimeRecord, not an older in-flight poll.
    for (const { value } of wakes) if (this.helperTaskOwner(value.request) && !this.taskHelperWakes?.has(value.request.id))
      this.taskHelperWakes?.set(value.request.id, value)
    for (const { value } of wakes) if (!value.delivered && value.request.taskId && !['Foreground', 'Helper'].includes(value.request.role))
      this.workspaces.rememberRoot(value.request.taskId)
    const recovered = new Set(wakes
      .filter(row => !row.value.delivered && row.value.request.reason === 'startup-recovery')
      .map(row => this.requestKey(row.value.request)))
    return this.startupRecoveryFacts = { restoring, recovered }
  }
  private async startupRecovery(selected?: { taskId?: string; workId?: string; foregroundOnly?: true; facts: StartupRecoveryFacts }): Promise<void> {
    const { restoring, recovered } = selected?.facts ?? await this.readStartupRecoveryFacts()
    // Only the delayed legacy Foreground retry is narrower than the ordinary
    // startup scan; direct and Helper workId retries keep their old behavior.
    const members = selected?.foregroundOnly ? [] : await withSnapshot(this.files, async snapshot => {
      if (!selected) return this.scanMembers(snapshot)
      const task = selected.taskId ? await readJson<TaskMetadata>(this.files, snapshot, paths.task(selected.taskId)) : undefined
      if (task) this.rememberTerminalTask(task)
      return task ? this.scanMembers(snapshot, [task]) : []
    })
    const targets = scanMemberRecovery(members)
    const continuations: RoleWake[] = []
    const missingTasks = /* @__PURE__ */ new Set();
    const sessions = new DshSessionReader(this.ctx)
    for (let record of [...this.roleRecords.values()]) {
      if (this.closed) return
      if (selected && await this.currentTask(record) !== selected.taskId) continue
      if (selected?.workId && record.identity.workId !== selected.workId) continue
      if (this.files instanceof PhysicalLocalFiles && !selected?.workId && this.physicalDirectInput(record)) {
        // Each original direct role owns its continuation. A slow accepted
        // result must not hold the other unbound Foreground/Helper/direct roles.
        const workId = record.identity.workId
        this.startMaintenance('startup-direct:' + workId, () => this.startupRecovery({
          taskId: selected?.taskId, workId, facts: { restoring, recovered }
        }))
        continue
      }
      if (this.files instanceof PhysicalLocalFiles && !selected?.workId && record.identity.role === 'Helper') {
        const workId = record.identity.workId
        this.startMaintenance('startup-helper:' + workId, () => this.startupRecovery({
          taskId: selected?.taskId, workId, facts: { restoring, recovered }
        }))
        continue
      }
      if (record.identity.role === 'Foreground' && this.pendingForegroundResets?.size) continue
      if (record.businessTransferred || record.released) continue
      try {
        if (await this.diagnoseMissingTask(record)) {
          const taskId = await this.currentTask(record);
          if (taskId) missingTasks.add(taskId);
          continue;
        }
        if (!await this.memberContinuationEligible(record)) continue
      } catch (error) { this.error(error, { identity: record.identity, stage: 'startup-member-eligibility' }); continue }
      if (this.files instanceof PhysicalLocalFiles && !this.active(record)) {
        const inputPath = this.physicalDirectInput(record)
        if (inputPath) {
          try {
            // The known source RoleRecord addresses this one accepted result.
            // No STATE discovery or additional wake is introduced.
            const publication = await resumePhysicalDirectDelivery(this.files, inputPath, path => this.physicalSignalSources(path))
            if (publication) {
              await this.settlePhysicalDirectDelivery(record, inputPath, publication.commandId)
              record = this.roleRecords.get(record.identity.workId)!
            }
            if (record.gitSettledWakeId === (record.delivery?.request ?? record.lastWake)?.id && record.gitSettledWakeId) {
              recovered.add(record.identity.workId); continue
            }
          } catch (error) { this.error(error, { identity: record.identity, stage: 'startup-direct-delivery' }); continue }
        }
      }
      if (this.files instanceof PhysicalLocalFiles && record.identity.role === 'Helper' && !this.active(record)) {
        try {
          const request = record.delivery?.request ?? record.lastWake
          if (request && (await sessions.inspect(record.sessionId)).exists) {
            const events = await sessions.events(record.sessionId)
            await resumePhysicalHelperReportsFromEvents(this.files, record.identity.executionId,
              events, {
                recordAttempt: (input, commandId) => this.recordSafetyAttempt(this.binding(record, request), input, commandId),
                signalSources: path => this.physicalSignalSources(path)
              })
            // Reuse the native events already read for report recovery. An
            // old confirmed stop does not replay its interrupted tool call;
            // only this delivery's persisted result can prove completion.
            if (record.stopped && !record.stopUnknown && record.delivery?.confirmed
              && record.gitSettledWakeId !== record.delivery.request.id) {
              const start = events.findIndex(event => event.type === 'user/message'
                && event.surfaceOp === 'append' && event.data.source?.kind === 'deepseek-servant'
                && event.data.id === record.delivery!.messageId)
              if (start >= 0) {
                const later = events.findIndex((event, index) => index > start
                  && event.type === 'user/message' && event.surfaceOp === 'append'
                  && nativeSourceKind(event.data.source) !== 'runtime-context')
                this.scheduleCompletedHostRestoreRetirement(record, events.slice(start, later < 0 ? undefined : later))
              }
            }
          }
        } catch (error) {
          // Keep the uncertain original publication, but let its owning Helper
          // inspect the actual report and continue its other responsibilities.
          this.error(error, { identity: record.identity, stage: 'startup-helper-report' })
        }
      }
      if (record.identity.role === 'Helper' && record.gitSettledWakeId
        && record.gitSettledWakeId === record.delivery?.request.id
        && !this.active(record) && !restoring.has(record.identity.executionId)) {
        try { await this.serialWork(record.identity.workId, () => this.retrySettledHelperWakeRetirement(record)) }
        catch (error) { this.error(error, { identity: record.identity, stage: 'startup-helper-wake-retirement' }) }
      }
      if (!record.stopped && record.stopIntent?.phase === 'disposed' && !this.active(record)) {
        try {
          const result = await this.stopOwnedRecord(record)
          const current = this.roleRecords.get(record.identity.workId)
          if (!current || current.identity.executionId !== record.identity.executionId) continue
          if (result.status !== 'stopped') {
            if (result.status === 'unconfirmed') {
              await this.saveRole({ ...current, stopUnknown: result })
              this.error(new Error(result.reason), { identity: current.identity, stage: 'startup-disposed-reconciliation' })
            }
            continue
          }
          if (!current.stopped) await this.saveRole({ ...current, stopped: true })
          record = this.roleRecords.get(record.identity.workId)!;
        } catch (error) { this.error(error, { identity: record.identity, stage: 'startup-disposed-reconciliation' }); continue }
      }
      if (record.stopped) {
        try {
          if (this.active(record)) continue
          if (restoring.has(record.identity.executionId)) continue
          if (record.completedRound || record.gitSettledWakeId === (record.delivery?.request ?? record.lastWake)?.id && record.gitSettledWakeId
            && (!(!!record.identity.taskId && (record.identity.role === 'Planner' || record.identity.role === 'Worker' || record.identity.role === 'Recorder'))
              || !(await sessions.inspect(record.sessionId)).unansweredQuestionCallIds?.length)) {
            recovered.add(record.identity.workId); continue
          }
          if (this.config.mode === 'git' && await this.recoverGitResponsibility(record)) { recovered.add(record.identity.workId); continue }
          const continuation = await this.arrangeNativeContinuation(record, {
            facts: 'The previous native execution was confirmed closed. Continue its accepted responsibility from saved inputs and current Task records.'
          })
          if (continuation) { continuations.push(continuation); recovered.add(record.identity.workId) }
        } catch (error) { this.error(error, { identity: record.identity, stage: 'startup-closed-continuation' }) }
        continue;
      }
      let inspection: DshSessionInspection | undefined, memberUnconsumedInput = false
      if (['Planner', 'Worker'].includes(record.identity.role) && record.identity.taskId && (record.lastWake || record.delivery) && !this.active(record)
        && record.gitSettledWakeId !== (record.delivery?.request ?? record.lastWake)?.id) {
        try {
          inspection = await sessions.inspect(record.sessionId)
          const input = inspection.exists ? resolveNativeRecoveryInput(record.delivery, record.lastWake, await sessions.inputs(record.sessionId)) : undefined
          memberUnconsumedInput = !!input && !input.active && ['queued', 'claimed', 'discarded', 'unadmitted'].includes(input.state)
          if (input?.state === 'consumed' && await this.memberNativeRoundSettled(record, inspection, sessions)) {
            if (this.config.mode === 'git') await this.saveRole({ ...record, gitSettledWakeId: (record.delivery?.request ?? record.lastWake)!.id });
            recovered.add(record.identity.workId)
            continue;
          }
        } catch (error) {
          this.error(error, { identity: record.identity, sessionId: record.sessionId, stage: 'startup-member-completion' })
          // Git's recorded exact-stop responsibility remains usable when its
          // disposable native cache is unavailable; Local needs native evidence.
          if (this.config.mode !== 'git') continue
        }
      }
      if (record.completedRound) {
        try { await this.serialWork(record.identity.workId, () => this.finishForegroundRound(record)) }
        catch (error) { this.error(error, { identity: record.identity, stage: 'startup-foreground-retirement' }) }
        continue
      }
      if (this.config.mode === 'git' && await this.recoverGitResponsibility(record)) { recovered.add(record.identity.workId); continue }
      if (restoring.has(record.identity.executionId) || !['Foreground', 'Organizer', 'Recorder', 'Helper', 'Planner', 'Worker'].includes(record.identity.role) || this.active(record) || (!record.lastWake && !record.delivery)) continue
      if (['Organizer', 'Recorder'].includes(record.identity.role) && await this.manuallyCleared(await this.currentTask(record))) continue
      try {
        inspection ??= await sessions.inspect(record.sessionId)
        if (inspection.exists && this.files instanceof PhysicalLocalFiles)
          await retirePhysicalPublicationsFromEvents(this.files, record.identity.executionId, await sessions.events(record.sessionId))
      }
      catch (error) {
        this.error(error, { identity: record.identity, sessionId: record.sessionId, stage: 'startup-session-inspection' })
        continue
      }
      if (!inspection.exists || !inspection.lifecycleKnown) continue
      if (record.identity.role === 'Foreground' && inspection.lastTurn?.reason === 'completed') {
        try { await this.serialWork(record.identity.workId, () => this.finishForegroundRound(record)) }
        catch (error) { this.error(error, { identity: record.identity, stage: 'startup-foreground-retirement' }); continue }
        if (this.roleRecords.get(record.identity.workId)?.completedRound) continue
      }
      const hostDisposed = inspection.lastTurn?.reason === 'aborted' && inspection.lastTurn.abortCause === 'disposed'
      if (record.stopped && !hostDisposed && !memberUnconsumedInput) continue
      if (await this.controls.execution(record.identity)) continue
      const interrupted = inspection.lastTurn && (!inspection.lastTurn.closed || inspection.lastTurn.reason === 'interrupted' || hostDisposed)
      if (!interrupted && !memberUnconsumedInput && !inspection.unresolvedToolCallIds.length && !inspection.queuedInbox.nextTurn.length && !inspection.queuedInbox.nextStep.length) continue
      try {
        const continuation = await this.arrangeNativeContinuation(record, {
          facts: 'Persisted native execution did not finish. Inspect existing inputs and saved work before continuing the original responsibility.'
        }, inspection)
        if (continuation) { continuations.push(continuation); recovered.add(record.identity.workId) }
      } catch (error) { this.error(error, { identity: record.identity, sessionId: record.sessionId, stage: 'startup-input-inspection' }) }
    }
    for (const target of targets) {
      if (missingTasks.has(target.taskId)) continue;
      if (recovered.has(this.roleKey(target.role, target.taskId, target.workerId))) continue
      if (target.role === 'Planner' && [...this.roleRecords.values()].some(record =>
        record.identity.role === 'Worker' && record.identity.taskId === target.taskId
        && recovered.has(record.identity.workId))) continue
      const request: RoleWake = {
        id: 'startup:' + this.bootId + ':' + hash(JSON.stringify([target.taskId, target.role, target.workerId, target.executionId])),
        role: target.role,
        taskId: target.taskId,
        lifecycleId: this.knownTaskLifecycles.get(target.taskId),
        workerId: target.workerId,
        reason: 'startup-recovery',
        sources: [{ path: target.recordPath, version: 'startup' }],
        context: { taskPath: target.taskPath, pendingSignals: target.pendingSignals }
      };
      const record = this.roleRecords.get(this.roleKey(target.role, target.taskId, target.workerId))
      if (!record) { await this.wake(request); continue }
      if (record.lastWake || record.delivery) continue
      try {
        if (record.businessTransferred || record.released || !await this.memberContinuationEligible(record)) continue
        const inspection: DshSessionInspection | undefined = record.stopped ? undefined : await sessions.inspect(record.sessionId)
        // Existing native executions retain their input identity and exact stop
        // evidence even when member notes are the recovery discovery source.
        const continuation = await this.arrangeNativeContinuation(record, {
          ...request.context, recordPath: target.recordPath,
          facts: 'Saved member material requires continuation. Inspect original native inputs and current notes before acting.'
        },
          inspection, undefined, { ...request, id: 'member-material:' + record.identity.executionId })
        if (continuation) continuations.push(continuation)
      } catch (error) { this.error(error, { identity: record.identity, sessionId: record.sessionId, stage: 'startup-member-input-inspection' }) }
    }
    // Existing startup checks follow their actual Task; Host-only checks remain Host scoped.
    const checks = new Map<string | undefined, { targets: typeof targets; continuations: RoleWake[] }>()
    const checkFor = (taskId: string | undefined) => {
      let check = checks.get(taskId)
      if (!check) { check = { targets: [], continuations: [] }; checks.set(taskId, check) }
      return check
    }
    for (const target of targets) checkFor(target.taskId).targets.push(target)
    for (const continuation of continuations) checkFor(['Planner', 'Worker', 'Organizer', 'Recorder'].includes(continuation.role)
      ? continuation.taskId : undefined).continuations.push(continuation)
    for (const [taskId, context] of checks) await this.wake({ id: 'startup-helper:' + randomUUID(), role: 'Helper',
      ...(taskId ? { taskId, lifecycleId: this.knownTaskLifecycles.get(taskId) } : {}),
      reason: 'startup-recovery', sources: [], context })
    this.startOwnedPump()
  }
  private async currentTask(record: RoleRecord): Promise<string | undefined> {
    if (record.identity.taskId || record.identity.role === 'Organizer') return record.identity.taskId
    const delivery = record.delivery
    if (!delivery || delivery.confirmed) return (delivery?.request ?? record.lastWake)?.taskId
    // Admission precedes the native durability barrier. Resolve an uncertain
    // delivery by its existing native message identity, not by a prior Task label.
    if (record.stopped || record.stopIntent?.phase === 'disposed') return record.lastWake?.taskId
    const owned = this.native.get(record.identity.workId)
    const admitted = owned ? owned.hasMessage(delivery.messageId) : await new DshSessionReader(this.ctx).hasMessage(record.sessionId, delivery.messageId)
    return admitted ? delivery.request.taskId : record.lastWake?.taskId
  }
  private pendingTaskStateReads = new Map<string, { task: TaskMetadata; revision: string; round: object }>()
  private observeLocalTaskState(task: TaskMetadata, revision: string, round: object): void {
    if (this.closed) return
    this.pendingTaskStateReads.set(task.taskId, { task: structuredClone(task), revision, round })
    this.startLocalTaskStateRead(task.taskId)
  }
  private startLocalTaskStateRead(taskId: string): void {
    const maintenance = this.maintenance ??= new Map<string, Promise<void>>()
    const key = 'task-state:' + taskId
    if (this.closed || maintenance.has(key)) return
    let attempted: { task: TaskMetadata; revision: string; round: object } | undefined
    const operation = Promise.resolve().then(async () => {
      while (!this.closed) {
        const selected = this.pendingTaskStateReads.get(taskId)
        if (!selected) return
        attempted = selected
        // The caller's physical snapshot may already be released. Reuse only
        // its completed metadata, then own this independent view to completion.
        const control = await withSnapshot(this.files, async snapshot =>
          (await this.controls.taskStates([selected.task], snapshot)).get(taskId))
        if (this.closed) return
        // A later same-Task observation must not be overwritten by an old read
        // completing late. Process that accepted latest input in this flight.
        if (this.pendingTaskStateReads.get(taskId) !== selected) continue
        this.taskStateObservation?.localTask(selected.round, selected.revision, selected.task, control)
        this.pendingTaskStateReads.delete(taskId)
      }
    })
    maintenance.set(key, operation)
    void operation.catch(error => this.error(error, { taskId, stage: 'task-state-observation' })).finally(() => {
      if (maintenance.get(key) !== operation) return
      maintenance.delete(key)
      const pending = this.pendingTaskStateReads.get(taskId)
      // A failed same input waits for the next ordinary observation. Only an
      // already accepted newer input continues after this exact owner releases.
      if (this.closed || pending === attempted) this.pendingTaskStateReads.delete(taskId)
      else if (pending) this.startLocalTaskStateRead(taskId)
    })
  }
  /** Original unfinished control attempts, not a persistent index or cached
   * state projection. Cold discovery and button stop attempts keep their exact IDs
   * here until existing handling or the known Task resource retirement completes. */
  private pendingControlStops: Array<{ workId: string; executionId: string;
    commandId?: string; owner?: { taskId?: string; lifecycleId?: string }; write?: Promise<void>; writing?: boolean; awaitingTaskRetirement?: true }> = []
  private readonly pendingTaskControlDiscovery = new Map<string, { lifecycleId: string }>()
  private startupControlsDiscovered = false
  private startTaskControlDiscovery(taskId: string): void {
    const selected = this.pendingTaskControlDiscovery.get(taskId)
    if (!selected) return
    this.startMaintenance('startup-task-user-control:' + taskId, async () => {
      const requests = await this.controls.pendingTaskStops(taskId)
      if (this.closed) return
      for (const { workId, executionId, taskId: ownerTaskId, lifecycleId } of requests) {
        if (!this.pendingControlStops.some(target => target.workId === workId && target.executionId === executionId))
          this.pendingControlStops.push({ workId, executionId, owner: { taskId: ownerTaskId, lifecycleId } })
      }
      if (this.pendingTaskControlDiscovery.get(taskId) === selected) this.pendingTaskControlDiscovery.delete(taskId)
      this.retryStartupControls(false)
    }, { taskId, stage: 'startup-task-user-control' })
  }
  private retryStartupControls(discover = true): void {
    if (!(this.files instanceof PhysicalLocalFiles) || this.closed) return
    if (discover) for (const taskId of this.pendingTaskControlDiscovery.keys()) this.startTaskControlDiscovery(taskId)
    if (discover && !this.startupControlsDiscovered) this.startMaintenance('startup-user-control-discovery', async () => {
      const requests = await this.controls.pendingStops()
      for (const { workId, executionId, taskId, lifecycleId } of requests) {
        if (!this.pendingControlStops.some(target => target.workId === workId && target.executionId === executionId))
          this.pendingControlStops.push({ workId, executionId, owner: { taskId, lifecycleId } })
      }
      this.startupControlsDiscovered = true
      this.retryStartupControls(false)
    }, { stage: 'startup-user-control-discovery' })
    for (const target of this.pendingControlStops) {
      if (target.writing || target.awaitingTaskRetirement) continue
      this.startMaintenance('user-control:' + JSON.stringify([target.workId, target.executionId]), async () => {
        // A button owns the continuation after its write attempt, without
        // donating its foreground response turn to native stop processing.
        await new Promise<void>(resolve => setImmediate(resolve))
        if (this.closed) return
        let executionMissing = false
        await withOperationChannel(this.files, 'read', () => this.applyUserControls(true, { ...target,
          executionObserved: present => { executionMissing = !present } }))
        if (executionMissing && target.commandId && target.write && target.owner?.taskId) {
          const current = this.roleRecords.get(target.workId)
          const owner = current?.identity.executionId === target.executionId ? current : this.retiredWorkers?.get(target.executionId)
          if (owner?.identity.workId === target.workId && owner.identity.taskId === target.owner.taskId
            && taskLifecycle(owner.identity) === taskLifecycle(target.owner)
            && this.loop.ownsPhysicalTaskCleanup(target.owner.taskId, target.owner.lifecycleId)) {
            // The original current/retired owner still owns this missing row's
            // resource retirement. Retain its outcome once, without polling it.
            target.awaitingTaskRetirement = true
            return
          }
        }
        this.pendingControlStops = this.pendingControlStops.filter(item => item !== target)
      }, { workId: target.workId, executionId: target.executionId, stage: 'pending-execution-user-control' })
    }
  }
  async applyUserControls(waitForStops = true, waitTarget?: { taskId?: string; workId?: string; executionId?: string; lifecycleId?: string; owner?: { taskId?: string; lifecycleId?: string }; executionObserved?: (present: boolean) => void }, round?: FilesReadRound, observation?: object): Promise<void> {
    if (this.files instanceof PhysicalLocalFiles && !waitForStops && !waitTarget) {
      // Observation discovers existing role owners synchronously. Each exact
      // execution owns its control reads, producer confirmation and errors;
      // a pending Task A write cannot withhold Task B discovery or control.
      for (const { identity } of this.roleRecords.values()) {
        const { workId, executionId } = identity
        this.startMaintenance('user-control:' + JSON.stringify([workId, executionId]), () =>
          withOperationChannel(this.files, 'read', () => this.applyUserControls(true, { workId, executionId })),
          { workId, executionId, stage: 'execution-user-control' })
      }
      return
    }
    let changed = false
    const operations: Promise<PromiseSettledResult<void>>[] = [], waiting = new Set<TrackedStop>()
    const track = (operation: Promise<void>, phase: FailurePhase) => {
      operations.push(operation.then((value) => ({ status: "fulfilled", value }), (reason) => ({ status: "rejected", reason: annotateFailure(reason, { phase }) })));
    };
    const waitTasks = waitTarget?.taskId ? new Set((await withSnapshot(this.files, (snapshot) => taskFamily(this.files, snapshot, waitTarget.taskId!))).map(task => task.taskId).concat(waitTarget.taskId)) : void 0;
    const busyAtEntry = new Set(this.workOperations?.keys() ?? [])
    const matchesTarget = (record: RoleRecord | undefined, identity?: { workId: string; executionId: string; taskId?: string; lifecycleId?: string }) => {
      if (!waitTarget) return true
      const target = identity ?? record?.identity
      if (waitTarget.taskId && target?.taskId === waitTarget.taskId && taskLifecycle(target) !== taskLifecycle(waitTarget)) return false;
      if (target && waitTarget.workId === target.workId && waitTarget.executionId === target.executionId) return true
      return !!waitTasks && target?.taskId !== undefined && waitTasks.has(target.taskId)
    };
    const requestStop = (record: RoleRecord, taskId?: string, commandId?: string): StopResult | undefined => {
      if (record.stopped) return { status: 'stopped' }
      const key = JSON.stringify([record.identity.workId, record.identity.executionId])
      const existing = this.stopOperations?.get(key)
      if (existing?.settled && existing.result
        && (existing.result.status === 'stopped' || commandId === undefined || existing.controlCommands?.has(commandId))) return existing.result
      if (this.trackedStop(record)) return { status: 'stopped' }
      const stop = this.stopOperations?.get(key)
      if (stop && commandId !== undefined) (stop.controlCommands ??= new Set()).add(commandId)
      if (stop && (!waitTarget || (waitTarget.workId === record.identity.workId && waitTarget.executionId === record.identity.executionId)
        || (taskId !== undefined && waitTasks?.has(taskId)))) waiting.add(stop)
      return undefined
    }
    const exactTarget = waitTarget?.workId !== undefined && waitTarget.executionId !== undefined && waitTarget.taskId === undefined
    const exactRecord = exactTarget ? this.roleRecords.get(waitTarget.workId!) : undefined
    const candidates = exactTarget ? (exactRecord ? [exactRecord] : []) : [...this.roleRecords.values()]
    for (const candidate of candidates) {
      if (!['Planner', 'Worker', 'Organizer'].includes(candidate.identity.role) || !matchesTarget(candidate)) continue
      if (!waitForStops && busyAtEntry.has(candidate.identity.workId)) continue
      track(this.serialWork(candidate.identity.workId, async () => {
        const record = this.roleRecords.get(candidate.identity.workId)
        if (!record || !['Planner', 'Worker', 'Organizer'].includes(record.identity.role) || record.stopped || record.stopUnknown) return
        let taskId: string | undefined
        try { taskId = await this.currentTask(record) } catch (error) { this.error(error, { identity: record.identity, delivery: record.delivery }); return }
        if (!await this.controls.taskHeld(taskId, record.identity.lifecycleId)) return
        changed = true
        requestStop(record, taskId)
      }), 'controls-held-task');
    }
    let stopReadFailed = false, stopReadFailure;
    try {
      const requests = this.files instanceof PhysicalLocalFiles
        ? (await Promise.all((waitTarget?.executionId
          ? [exactRecord?.identity.executionId === waitTarget.executionId ? exactRecord.identity
            : { workId: waitTarget.workId!, executionId: waitTarget.executionId, ...waitTarget.owner }]
          : candidates.filter(record => matchesTarget(record)).map(record => record.identity))
          .map(identity => this.controls.execution(identity)))).filter(request => {
            waitTarget?.executionObserved?.(request !== undefined)
            return request && request.result === undefined
          })
        : await (round ? round.withSnapshot(snapshot => this.controls.pendingStops(snapshot,
          tasks => this.taskStateObservation?.controls(round, snapshot.revision, tasks))) : this.controls.pendingStops(undefined,
          tasks => { if (observation) this.taskStateObservation?.controls(observation, undefined, tasks) }))
      for (const request of requests) {
        if (!request) continue
        if (!matchesTarget(this.roleRecords.get(request.workId), request)) continue
        if (!waitForStops && busyAtEntry.has(request.workId)) continue
        track(this.serialWork(request.workId, async () => {
          changed = true
          const record = this.roleRecords.get(request.workId)
          const result = !record || record.identity.executionId !== request.executionId ? { status: ("superseded" as const) } : requestStop(record, record.identity.taskId, request.commandId);
          if (!result) return
          try {
            await this.controls.settleExecution(request.commandId, request, {
              state: result.status,
              ...(result.status === 'unconfirmed' ? { detail: result.reason, jobs: result.jobs } : {})
            })
          } catch (error) {
            // The exact native result already exists. If this Task's original
            // Cleaner removed the control directory, its receipt retires with
            // that directory; do not turn absence into native stop success.
            if (!(error instanceof LocalTaskRecordParentMissing) || !request.taskId
              || error.path !== this.controls.taskRecordPath(request.taskId)
              || !this.loop.ownsPhysicalTaskCleanup(request.taskId, request.lifecycleId)) throw error
          }
        }), 'controls-settle-stop');
      }
    } catch (error) {
      stopReadFailed = true;
      stopReadFailure = annotateFailure(error, { phase: 'controls-pending-stops' });
    }
    const outcomes = await Promise.all(operations);
    if (changed) this.environment.changed?.()
    const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected').map(outcome => outcome.reason)
    if (stopReadFailed) failures.unshift(stopReadFailure);
    if (waitForStops && waiting.size) {
      await Promise.all([...waiting].map(stop => stop.promise))
      failures.push(...[...waiting].filter(stop => stop.failure !== undefined).map(stop => annotateFailure(stop.failure, { phase: 'controls-stop-confirmation' })))
      // Persist actual exact-request outcomes after confirmation, outside work
      // admission locks. The discovery caller never waits for producer promises.
      if (!failures.length) await this.applyUserControls(false, waitTarget)
    }
    if (stopReadFailed && failures.length === 1) throw stopReadFailure;
    if (failures.length) throw new AggregateError(failures, 'Native execution controls failed')
  }
  async requestExecutionStop(commandId: string, workId: string, executionId: string, acknowledgeReleased?: (target: ExecutionStopRequest) => Promise<void>): Promise<void> {
    const record = this.roleRecords.get(workId)
    if (!record || record.identity.executionId !== executionId) throw new Error('The selected native execution is no longer owned by this Host.')
    if (this.files instanceof PhysicalLocalFiles) {
      if (record.released && record.stopped) {
        // A stale button needs no new stop row for an already ended owner.
        // A retry of an accepted original write still receives that outcome.
        let original: typeof this.pendingControlStops[number] | undefined
        if (record.identity.taskId) {
          // Preserve the first command identity, but the latest outcome of that
          // identity. An incompatible retry is not a new command owner.
          for (const pending of this.pendingControlStops) if (pending.commandId === commandId && pending.write
            && pending.owner?.taskId === record.identity.taskId && (!original || pending.workId === original.workId
              && pending.executionId === original.executionId && taskLifecycle(pending.owner) === taskLifecycle(original.owner!))) original = pending
        } else original = this.pendingControlStops.filter(target => target.workId === workId
          && target.executionId === executionId && target.commandId === commandId && target.write).at(-1)
        if (original) {
          await original.write
          if (record.identity.taskId && (original.workId !== workId || original.executionId !== executionId
            || taskLifecycle(original.owner!) !== taskLifecycle(record.identity)))
            throw new Error('Control command identity has different arguments.')
        }
        const target = { workId, executionId, taskId: record.identity.taskId, lifecycleId: record.identity.lifecycleId }
        // The existing frontend Access may outlive this Running connection.
        // It verifies the same exact command without reopening a closed store.
        if (record.released && record.stopped && acknowledgeReleased) await acknowledgeReleased(target)
        else await this.controls.acknowledgeLocalReleasedExecutionStop(commandId, target)
        return
      }
      if (this.closed) throw new Error('Framework runtime is disposed.')
      // Remember the existing array boundary without scanning normal requests.
      // A rare missing-parent result may inspect only preceding attempts, even
      // if maintenance has since replaced the live array with its remainder.
      const preceding = this.pendingControlStops, precedingCount = preceding.length
      const target: typeof this.pendingControlStops[number] = { workId, executionId, commandId,
        owner: { taskId: record.identity.taskId, lifecycleId: record.identity.lifecycleId }, writing: true }
      this.pendingControlStops.push(target)
      try {
        target.write = this.controls.requestExecutionStop(commandId, { workId, executionId, ...target.owner }).then(() => {}, async error => {
          if (!(error instanceof LocalTaskRecordParentMissing) || !record.identity.taskId
            || error.path !== this.controls.taskRecordPath(record.identity.taskId)) throw error
          let original: typeof target | undefined
          for (let index = 0; index < precedingCount; index++) {
            const pending = preceding[index]
            if (pending.commandId !== commandId || pending.owner?.taskId !== record.identity.taskId || !pending.write) continue
            if (!original || pending.workId === original.workId && pending.executionId === original.executionId
              && taskLifecycle(pending.owner) === taskLifecycle(original.owner!)) original = pending
          }
          if (original) {
            await original.write
            if (original.workId !== workId || original.executionId !== executionId
              || taskLifecycle(original.owner!) !== taskLifecycle(record.identity))
              throw new Error('Control command identity has different arguments.')
          }
          // Only an initial missing Task parent can be the completed Cleaner's
          // original resource responsibility. Later write failures keep their outcome.
          if (!this.loop.ownsPhysicalTaskCleanup(record.identity.taskId, record.identity.lifecycleId)) throw error
          target.awaitingTaskRetirement = true
          await this.controls.acknowledgeLocalReleasedExecutionStop(commandId, { workId, executionId, ...target.owner })
        })
        await target.write
      } finally {
        // Keep this attempt's original outcome for existing handling or resource release.
        // Release/close also joins its outstanding write before releasing resources.
        target.writing = false
        this.retryStartupControls(false)
      }
      return
    }
    await this.controls.requestExecutionStop(commandId, { workId, executionId, taskId: record.identity.taskId, lifecycleId: record.identity.lifecycleId });
    this.startMaintenance('execution-stop:' + commandId, async () => {
      await new Promise<void>(resolve => setImmediate(resolve))
      if (this.closed) return
      await withOperationChannel(this.files, 'read', () => this.applyUserControls(true, { workId, executionId }))
    }, { workId, executionId, executionStopCommandId: commandId })
  }

  /** Own the continuation after the button's durable writes have returned. The
   * next event-loop turn keeps synchronous native work off the submission path;
   * maintenance still owns errors and is joined during shutdown. */
  scheduleTaskResume(taskId: string, commandId: string, lifecycleId?: string): void {
    this.startMaintenance('task-resume:' + commandId, async () => {
      await new Promise<void>(resolve => setImmediate(resolve))
      if (this.closed) return
      await withOperationChannel(this.files, 'read', () => this.resumeTask(taskId, commandId, lifecycleId, true))
    }, { taskId, taskControlCommandId: commandId, ...(lifecycleId ? { lifecycleId } : {}) })
  }
  async resumeTask(taskId: string, commandId: string, lifecycleId?: string, requireCurrentCommand = false): Promise<void> {
    if (await this.manuallyCleared(taskId)) throw new Error('This Task history was explicitly cleared. Create a new Task.')
    const selected = await withSnapshot<{ family: TaskMetadata[]; members: MemberRecoveryInput[] } | { waiting: TrackedStop[] } | undefined>(this.files, async (snapshot) => {
      const family = await taskFamily(this.files, snapshot, taskId)
      for (const task of family) this.rememberTerminalTask(task);
      if (requireCurrentCommand && (!family[0] || taskLifecycle(family[0]) !== (lifecycleId ?? "") || isTerminalTask(family[0]))) return undefined
      if (family[0] && taskLifecycle(family[0]) !== (lifecycleId ?? "")) throw new Error("Task lifecycle changed before resume.");
      if (!family[0] || isTerminalTask(family[0])) throw new Error("A completed, cancelled or absent Task cannot be resumed; create a new Task.");
      if (requireCurrentCommand) {
        // Reuse this business snapshot, not a post-submit verification read.
        const current = (await this.controls.taskStates([family[0]], snapshot)).get(taskId)
        if (current?.commandId !== commandId || current.intent !== 'running') return undefined
        const waiting: TrackedStop[] = []
        for (const record of this.roleRecords.values()) {
          const stop = this.stopOperations?.get(JSON.stringify([record.identity.workId, record.identity.executionId]))
          if (!stop || stop.settled) continue
          if (family.some(task => taskLifecycle(task) === taskLifecycle(record.identity)
            && record.identity.taskId === task.taskId)) waiting.push(stop)
        }
        if (waiting.length) return { waiting }
      }
      return { family, members: await this.scanMembers(snapshot, family) }
    });
    if (!selected) return
    if ('waiting' in selected) {
      // Wait only for already-owned exact stops, outside any snapshot/work lock.
      // Native settlement changes routing and accepted-input evidence. Re-enter
      // the business snapshot afterwards so a later pause/lifecycle still wins.
      await Promise.all(selected.waiting.map(stop => stop.promise))
      const failures = selected.waiting.filter(stop => stop.failure !== undefined).map(stop => stop.failure)
      if (failures.length === 1) throw failures[0]
      if (failures.length) throw new AggregateError(failures, 'Native execution controls failed')
      if (!this.closed) await this.resumeTask(taskId, commandId, lifecycleId, requireCurrentCommand)
      return
    }
    const { family, members } = selected
    for (const target of scanMemberRecovery(members)) {
      if (await this.controls.taskHeld(target.taskId, this.knownTaskLifecycles.get(target.taskId))) continue;
      const request: RoleWake = {
        id: 'user-resume:' + commandId + ':' + target.taskId + ':' + target.role + ':' + (target.workerId ?? ''), role: target.role, taskId: target.taskId, workerId: target.workerId,
        lifecycleId: this.knownTaskLifecycles.get(target.taskId),
        reason: 'user-resume', sources: [{ path: target.recordPath, version: 'user-resume' }], context: { userRequestedResume: true, taskPath: target.taskPath, recordPath: target.recordPath }
      }
      await this.serialWork(this.requestKey(request), async () => {
        const record = this.roleRecords.get(this.requestKey(request))
        if (!record) { await this.wake(request); return }
        const inspection = record.stopped || record.stopIntent?.phase === 'disposed' ? undefined : await new DshSessionReader(this.ctx).inspect(record.sessionId)
        await this.arrangeNativeContinuation(record, request.context!, inspection, request.id, request, request);
      });
    }
    const familyIds = new Set([taskId, ...family.map(task => task.taskId)])
    const organizers = [...this.roleRecords.values()].filter(record => record.identity.role === 'Organizer'
      && (record.stopped || record.stopIntent?.phase === 'disposed')
      && !!record.identity.taskId && familyIds.has(record.identity.taskId))
    await Promise.all(organizers.map((candidate) => this.serialWork(candidate.identity.workId, async () => {
      const organizer = this.roleRecords.get(candidate.identity.workId)
      if (!organizer || (!organizer.stopped && organizer.stopIntent?.phase !== 'disposed')) return
      const selectedId = await this.currentTask(organizer)
      const selected = family.find(task => task.taskId === selectedId)
      if (!selectedId || (selectedId !== taskId && !selected)
        || (selected && (selected.route !== 'O' || selected.owner !== this.config.member)) || await this.controls.taskHeld(selectedId, this.knownTaskLifecycles.get(selectedId))) return;
      const current = organizer.delivery?.request.taskId !== selectedId ? { ...organizer, delivery: undefined } : organizer
      const request: RoleWake = {
        ...current.delivery?.request ?? current.lastWake,
        id: 'user-resume:' + commandId + ':Organizer:' + selectedId,
        role: 'Organizer',
        taskId: selectedId,
        lifecycleId: selected?.lifecycleId,
        reason: 'user-resume',
        sources: (current.delivery?.request ?? current.lastWake)?.sources ?? [],
        context: { userRequestedResume: true }
      };
      const inspection = organizer.stopped || organizer.stopIntent?.phase === 'disposed' ? undefined : await new DshSessionReader(this.ctx).inspect(organizer.sessionId)
      await this.arrangeNativeContinuation(current, request.context!, inspection, request.id, request, request);
    })));
    for (const task of family) await this.queueOrganizerLedger(task)
    await this.pump()
  }
  /** The existing one-time export owner supplies actual progress, not a poll. */
  resumeInitializationOriginals(): void {
    this.environment.initialization?.originalsChanged()
    this.continueInitialization()
  }
  private continueInitialization(): void {
    const initialization = this.environment.initialization
    if (!initialization?.hasPending()) return
    this.startMaintenance('initialization', () => initialization.resume(error => this.error(error), () => this.refreshSkills()))
  }
  private startMaintenance(key: string, action: () => Promise<void>, context?: Record<string, unknown>): void {
    const maintenance = this.maintenance ??= new Map()
    if (this.closed || maintenance.has(key)) return
    const operation = Promise.resolve().then(() => { if (!this.closed) return action() })
    maintenance.set(key, operation)
    void operation.catch(error => this.error(error, context)).finally(() => { if (maintenance.get(key) === operation) maintenance.delete(key) })
  }
  private async observe(round?: FilesReadRound, observation?: object): Promise<void> {
    if (this.closed) return
    this.retryStartupTasks()
    this.retryStartupControls()
    if (round && this.records instanceof GitAuthorityStore) this.startMaintenance('task-release-index',
      () => round.withSnapshot(snapshot => this.refreshTaskReleaseIndexes(snapshot)))
    this.startMaintenance('heartbeat', () => round ? round.withSnapshot(snapshot => this.environment.heartbeat(snapshot)) : this.environment.heartbeat())
    if (this.environment.observeResources) this.startMaintenance('resources', async () => {
      const read = async (snapshot: FilesSnapshot) => { if (!this.closed) await this.environment.observeResources!(snapshot) }
      if (round) return round.withSnapshot(read)
      // Local has no Git readRound. Only acquisition selects the fixed-poll
      // reader; resource callbacks and any business work keep their own context.
      const snapshot = await withOperationChannel(this.files, 'host-poll', () => this.files.snapshot())
      try { await read(snapshot) } finally { await snapshot.release() }
    });
    if (this.closed) return
    try { await this.applyUserControls(false, undefined, round, observation) } catch (error) { this.error(error) }
    if (this.closed) return
    // Local settlement discovery owns its pending technical read independently
    // of Task discovery, like the existing native observation discovery lane.
    if (this.files instanceof PhysicalLocalFiles)
      this.startMaintenance('observation-settlement-discovery', async () => {
        try { await this.processObservations(false, 'settle', false, round) } catch (error) { this.error(error) }
      })
    else try { await this.processObservations(false, 'settle', false, round) } catch (error) { this.error(error) }
    if (this.closed) return
    this.startRestoration(round)
    if (this.closed) return
    if (this.skipInitialSealedPass) this.skipInitialSealedPass = false
    else if (this.safetyResolutionReady === false) this.startSafetyResolutionLoad(round)
    else await this.processSealedBusiness(round)
    if (this.closed) return
    this.startOwnedPump(round)
  }
  private async publishPhysicalMemberRecovery(commandId: string, identity: { taskId: string; lifecycleId?: string; member: string },
    debug?: { path: string; text: string }, signalPath?: string, debugRecordPath?: string): Promise<string | undefined> {
    if (!(this.files instanceof PhysicalLocalFiles)) throw new Error('Physical recovery requires physical Local files.')
    const files = this.files
    return withSnapshot(files, async snapshot => {
      if (await this.manuallyCleared(identity.taskId, snapshot) || await readTaskCleanupRecord(files, snapshot, identity.taskId)) return
      const task = await readJson<TaskMetadata>(files, snapshot, paths.task(identity.taskId))
      const status = await readMemberStatus(files, snapshot, paths.memberStatus(identity.taskId, identity.member))
      if (!task || task.status !== 'running' || status?.state === 'complete') return
      await assertTaskLifecycle(files, snapshot, identity.taskId, identity)
      const inbox = await files.fileInfo(paths.inbox(identity.taskId, identity.member))
      if (!inbox?.bytes && !debug && !signalPath) return
      const debugPath = debug ? hostRecoveryDebugPath(debug.path, commandId) : debugRecordPath
      const publication = await publishPhysicalRecovery(files, { commandId, taskId: identity.taskId, lifecycleId: task.lifecycleId,
        ...(inbox?.bytes ? { markerPath: paths.state(identity.member, identity.taskId) + '/recovery' } : {}),
        ...(debug ? { debug } : {}), ...(signalPath ? { signalPath } : {}) }, async () => {
        if (this.closed) throw new Error('Role runtime is closed.')
        await assertTaskLifecycle(files, snapshot, identity.taskId, identity)
        if (await readTaskCleanupRecord(files, snapshot, identity.taskId)) throw new Error('The recovery Task runtime was retired.')
      }, path => this.physicalSignalSources(path), debugPath ? {
        ...(debug ? { debugPath } : {}), ...(signalPath ? { signalPath: hostRecoverySignalPath(signalPath, debugPath) } : {})
      } : undefined)
      return publication.debugPath ?? debugRecordPath
    })
  }
  private async retirePhysicalRestoreDebug(key: string, restore: { commandId: string; complete?: boolean }): Promise<boolean> {
    if (!(this.files instanceof PhysicalLocalFiles)) return true
    if (!restore.complete) return false
    const commandId = key.startsWith(this.prefix + 'restores/') ? 'restore-debug:' + restore.commandId
      : key.startsWith(this.prefix + 'host-restores/') ? 'host-restore-debug:' + restore.commandId : undefined
    return commandId ? retirePublishedPhysicalRecovery(this.files, commandId) : false
  }
  private async recordRestoreDebug(row: { key: string; value: RoleRestore }, input: unknown = row.value.input): Promise<string | undefined> {
    const path = row.value.debugPath ?? 'debug/' + row.value.createdAt.slice(0, 10) + '.md'
    if (this.files instanceof PhysicalLocalFiles) {
      if (row.value.complete) return
      // Restore already owns its exact original input. This diagnostic outlives
      // Task retirement and must not recreate a cleaned Task runtime directory.
      const commandId = 'restore-debug:' + row.value.commandId
      const publication = await publishPhysicalRecovery(this.files, { commandId,
        debug: { path, text: '\n' + JSON.stringify(input) + '\n' } }, undefined, undefined,
        { debugPath: hostRecoveryDebugPath(path, commandId) })
      return publication.debugPath
    }
    await this.transactions.run('restore-debug:' + row.value.commandId, input, { reevaluate: true }, async snapshot =>
      [{ path, content: (await this.files.read(snapshot, path) ?? '') + '\n' + JSON.stringify(input) + '\n' }])
    return path
  }
  private async ownerRecoveryChanges(snapshot: FilesSnapshot, taskId: string): Promise<Array<{ path: string; content: string }>> {
    // Final cleanup is a namespace retirement, including a completed Recorder's R.
    if (await readTaskCleanupRecord(this.files, snapshot, taskId)) return []
    const task = await readJson<TaskMetadata>(this.files, snapshot, paths.task(taskId))
    return task ? [{ path: paths.state(task.owner, taskId) + '/recovery', content: '' }] : []
  }
  private async publishPhysicalOwnerRecovery(commandId: string, taskId: string): Promise<void> {
    if (!(this.files instanceof PhysicalLocalFiles)) throw new Error('Physical recovery requires physical Local files.')
    const files = this.files
    await withSnapshot(files, async snapshot => {
      const [marker] = await this.ownerRecoveryChanges(snapshot, taskId)
      if (!marker) return
      const task = await readJson<TaskMetadata>(files, snapshot, paths.task(taskId))
      if (!task) return
      await publishPhysicalRecovery(files, { commandId, taskId, lifecycleId: task.lifecycleId, markerPath: marker.path }, async () => {
        await assertTaskLifecycle(files, snapshot, taskId, task)
        if (await readTaskCleanupRecord(files, snapshot, taskId)) throw new Error('The recovery Task runtime was retired.')
      })
    })
  }
  private async publishOwnerRecovery(commandId: string, record: RoleRecord): Promise<void> {
    if (record.identity.role !== 'Organizer' && record.identity.role !== 'Recorder') return
    const taskId = await this.currentTask(record)
    if (!taskId) return
    if (this.files instanceof PhysicalLocalFiles) return this.publishPhysicalOwnerRecovery(commandId, taskId)
    await this.transactions.run(commandId, { taskId, role: record.identity.role, executionId: record.identity.executionId },
      { reevaluate: true, taskOwner: await this.selectedTaskCommandOwner(taskId, record.identity) }, snapshot => this.ownerRecoveryChanges(snapshot, taskId))
  }
  private async observeRecoveryMarkers(borrowed?: FilesSnapshot, tasks?: readonly TaskMetadata[], waitForPersistence = true): Promise<void> {
    const inspect = async (snapshot: FilesSnapshot) => {
      for (const task of tasks ?? await this.taskMetadata(snapshot)) {
        if (this.closed) return
        if (await readTaskCleanupRecord(this.files, snapshot, this.files instanceof GitFiles ? task : task.taskId) || await this.manuallyCleared(task.taskId, snapshot)) continue
        const marker = paths.state(this.config.member, task.taskId) + '/recovery'
        // This clock belongs to an unfinished Planner/member recovery chain.
        // Organizer/Recorder markers remain for the root's fixed Cleaner; their
        // executions already have the separate mechanical 5/5/30 observation.
        // Use this watch operation's current Task/member facts, not a stale Task
        // listing or the marker itself as evidence of member responsibility.
        const memberRecoveryScope = async (currentSnapshot: FilesSnapshot): Promise<boolean> => {
          const current = await readJson<TaskMetadata>(this.files, currentSnapshot, paths.task(task.taskId))
          if (!current || current.taskId !== task.taskId || taskLifecycle(current) !== taskLifecycle(task)
            || current.route !== 'P' || current.status !== 'running'
            || ![current.owner, ...current.members ?? []].includes(this.config.member)) return false
          return (await readMemberStatus(this.files, currentSnapshot, paths.memberStatus(task.taskId, this.config.member)))?.state !== 'complete'
        }
        const persist = () => this.serialRecoveryWatch(task.taskId, this.config.member, async (key) => {
          if (this.closed) return
          if (this.records instanceof GitAuthorityStore) {
            const now = Date.now()
            const watch = await this.records.updateRouted<RecoveryWatch | undefined>([key], marker, async (values, raw, currentSnapshot) => {
              const current = (values.get(key) as RecoveryWatchRecord | undefined);
              if (current?.released || await this.taskRuntimeReleased(task, currentSnapshot)) return { target: key, value: current, result: undefined, write: false }
              if (raw === undefined || !await memberRecoveryScope(currentSnapshot)) return { target: key, value: { ...current, watch: undefined, markerVersion: undefined }, result: undefined, write: !!current?.watch }
              const prior = current?.watch ?? createRecoveryWatch({ taskId: task.taskId, member: this.config.member }, now)
              const due = dueRecoveryWatch(prior, now)
              return {
                target: key, value: { ...current, taskId: task.taskId, lifecycleId: task.lifecycleId, member: this.config.member, watch: due.state }, result: due.state,
                write: !current?.watch || due.state !== prior
              }
            });
            if (watch && watch.stage > 0 && !this.closed) await withSnapshot(this.files, async (current) => {
              await assertTaskLifecycle(this.files, current, task.taskId, task);
              if (await this.files.read(current, marker) === undefined || !await memberRecoveryScope(current)) return
              const action = {
                kind: ("recovery-check" as const),
                taskId: watch.taskId,
                member: watch.member,
                stage: watch.stage,
                cycleStartedAt: watch.cycleStartedAt,
                elapsedMs: watch.stageStartedAt - watch.cycleStartedAt
              };
              await this.wake({
                id: 'recovery-check:' + hash(JSON.stringify([watch.taskId, watch.member, watch.cycleStartedAt, watch.stage])),
                role: 'Helper',
                taskId: task.taskId,
                lifecycleId: task.lifecycleId,
                reason: 'observation',
                sources: [{ path: marker, version: current.revision }],
                context: { observation: action }
              });
            });
            return;
          }
          const record = await this.records.get<RecoveryWatchRecord>(key)
          if (this.closed || record?.released || await this.taskRuntimeReleased(task)) return
          await withSnapshot(this.files, async (current) => {
            await assertTaskLifecycle(this.files, current, task.taskId, task);
            const marker = paths.state(this.config.member, task.taskId) + '/recovery'
            const actual = this.files instanceof PhysicalLocalFiles ? await this.files.fileInfo(marker) : undefined
            if ((this.files instanceof PhysicalLocalFiles ? !actual : await this.files.read(current, marker) === undefined)
              || !await memberRecoveryScope(current)) {
              // Retire only this clock. Already accepted Helper wakes/claims
              // retain their original responsibility and cannot recreate it.
              if (record?.watch) await this.records.set(key, { ...record, watch: undefined, markerVersion: undefined })
              return
            }
            const changed = actual && record?.markerVersion !== actual.version
            const watch = !changed && record?.watch || createRecoveryWatch({ taskId: task.taskId, member: this.config.member }, Date.now())
            const due = dueRecoveryWatch(watch, Date.now())
            if (!record?.watch || due.state !== record.watch) await this.records.set(key, { ...record, taskId: task.taskId, lifecycleId: task.lifecycleId, member: this.config.member, watch: due.state, ...(actual ? { markerVersion: actual.version } : {}) })
            if (due.state.stage > 0 && !this.closed) {
              const action = {
                kind: ("recovery-check" as const),
                taskId: watch.taskId,
                member: watch.member,
                stage: due.state.stage,
                cycleStartedAt: watch.cycleStartedAt,
                elapsedMs: due.state.stageStartedAt - watch.cycleStartedAt
              };
              await this.wake({
                id: 'recovery-check:' + hash(JSON.stringify([watch.taskId, watch.member, watch.cycleStartedAt, due.state.stage])),
                role: 'Helper',
                taskId: task.taskId,
                lifecycleId: task.lifecycleId,
                reason: 'observation',
                sources: [{ path: marker, version: current.revision }],
                context: { observation: action }
              });
            }
          });
        }, task.lifecycleId);
        if (waitForPersistence) await persist()
        else this.startMaintenance('recovery-marker:' + task.taskId, persist)
      }
    };
    await (borrowed ? inspect(borrowed) : withSnapshot(this.files, inspect))
  }
  private updateObservationRecord(pending: ScheduledObservation, progress: { complete?: true; stopStarted?: true } = {}): Promise<ObservationRecord> {
    const key = this.prefix + 'observations/' + hash(pending.id), identity = pending.action.identity
    const operation = (this.observationRecordWrites.get(key)?.promise ?? Promise.resolve()).catch(() => {}).then(async () => {
      const retired = { pending, complete: true }
      if (this.records instanceof GitAuthorityStore) return this.records.updateWithReads<ObservationRecord, ObservationRecord>(key, [], async (current, _reads, snapshot) => {
        if (await this.taskRuntimeReleased(identity, snapshot)) return { result: retired, write: false }
        if (current && (current.pending.id !== pending.id || current.pending.cycleStartedAt !== pending.cycleStartedAt
          || current.pending.action.identity.executionId !== identity.executionId)) throw new Error('Observation responsibility identity changed.')
        const value: ObservationRecord = { ...(current ?? { pending, complete: false }), ...progress }
        return { value, result: value, write: true }
      })
      if (await this.taskRuntimeReleased(identity)) return retired
      const current = await this.records.get<ObservationRecord>(key)
      const value: ObservationRecord = { ...(current ?? { pending, complete: false }), ...progress }
      if (!current || Object.keys(progress).length) await this.records.set(key, value)
      return value
    })
    this.observationRecordWrites.set(key, { identity, promise: operation })
    void operation.finally(() => { if (this.observationRecordWrites.get(key)?.promise === operation) this.observationRecordWrites.delete(key) }).catch(() => {})
    return operation
  }
  private async enqueueObservation(pending: ScheduledObservation): Promise<void> {
    await this.updateObservationRecord(pending)
  }
  private async processObservations(startedOnly = false, lane: 'all' | 'native' | 'settle' = 'all', waitForDelivery = true, round?: FilesReadRound): Promise<void> {
    // Each durable action owns its delivery, outside tick's metadata queue. A
    // pending accept cannot hold another execution or the next local 5/5/30 tick.
    const owned = this.observationOperations ??= new Map<string, Promise<void>>()
    const operations: Promise<void>[] = []
    for (const row of await listAuthorityInRound<ObservationRecord>(this.records, this.prefix + 'observations/', round)) {
      if (this.closed) break
      if (row.value.complete || (startedOnly && !row.value.stopStarted)) continue
      if (lane === 'settle' && (row.value.pending.action.stage !== 3 || !row.value.stopStarted)) continue
      if (lane === 'native' && row.value.pending.action.stage === 3) {
        const identity = row.value.pending.action.identity, current = this.roleRecords.get(identity.workId)
        if (current?.identity.executionId === identity.executionId && current.stopped) continue
      }
      let operation = owned.get(row.key)
      if (!operation) {
        operation = Promise.resolve().then(async () => {
          if (this.closed || await this.arrangeObservation(row.value.pending, lane) === false || this.closed) return
          await this.updateObservationRecord(row.value.pending, { complete: true })
        })
        owned.set(row.key, operation)
        const tracked = operation
        void operation.finally(() => { if (owned.get(row.key) === tracked) owned.delete(row.key) }).catch(() => { })
        if (!waitForDelivery) void operation.catch(error => this.error(error, { identity: row.value.pending.action.identity, probeId: row.value.pending.id }))
      }
      operations.push(operation)
    }
    if (waitForDelivery) await this.settleOperations(operations, 'Native observation arrangements failed')
  }
  private async arrangeObservation(pending: ScheduledObservation, lane: 'all' | 'native' | 'settle' = 'all'): Promise<boolean | void> {
    const action = pending.action
    if (action.identity.role === 'Foreground' || this.closed) return
    if (!await this.beforeTaskUse(action.identity.taskId) || this.closed) return false
    const key = this.prefix + 'observations/' + hash(pending.id)
    const saved = await this.records.get<ObservationRecord>(key)
    if (saved?.complete) return
    if (!saved?.stopStarted && !await this.observations.mayApply(pending)) {
      await this.observations.deferUnperformed(pending)
      return
    }
    const workId = action.identity.workId
    const current = () => {
      const record = this.roleRecords.get(workId)
      return record?.identity.executionId === action.identity.executionId && !record.released ? record : undefined
    }
    let record = current()
    if (!record || this.closed || await this.controls.execution(action.identity) || await this.observationTaskHeld(record) || this.closed) return;
    if (action.stage !== 3) {
      if (record.stopped || record.stopIntent || record.stopUnknown) return
      const agent = this.native.get(workId)
      if (!agent || agent.sessionId !== record.sessionId || this.closed) return
      if (!await this.observations.mayApply(pending)) { await this.observations.deferUnperformed(pending); return }
      const kind = action.identity.role === 'Helper'
        ? action.stage === 1 ? 'probe-helper' : 'warn-helper'
        : action.stage === 1 ? 'probe-role' : 'warn-role'
      try {
        await agent.send(JSON.stringify({
          kind, probeId: pending.id, identity: action.identity,
          cycleStartedAt: pending.cycleStartedAt, elapsedMs: action.elapsedMs, silentMs: action.silentMs,
          instruction: 'After actually receiving this Host inactivity notice, call dss_reset_observation once per cycleStartedAt using one received probeId. A probe and warning with the same cycleStartedAt share one cycle. After reset or an already-handled/superseded result, do not reset other notices from that cycle. Organize your current status in existing role records and continue the original work. Queued delivery alone is not a response.'
        }),
          pending.id, 'steer', 'deepseek-servant')
      } catch (error) {
        if (!(error instanceof DshAgentAdmissionClosed) || error.sessionId !== record.sessionId) throw error
        // A late unsent probe is superseded only by this exact owner's confirmed
        // stop. Unknown disposal and all unrelated send failures still propagate.
        const stop = this.stopOperations?.get(JSON.stringify([workId, action.identity.executionId]))
        if (stop && !stop.settled) await stop.promise
        if (stop?.result?.status !== 'stopped' && !current()?.stopped) throw error
      }
      return
    }
    if (this.workOperations?.has(workId)) return false
    return this.serialWork(workId, async () => {
      if (this.closed) return false
      record = current()
      if (!record || await this.controls.execution(action.identity) || await this.observationTaskHeld(record) || this.closed) return;
      if (!saved?.stopStarted) {
        if (!await this.observations.mayApply(pending)) { await this.observations.deferUnperformed(pending); return }
        if ((await this.updateObservationRecord(pending, { stopStarted: true })).complete) return
      }
      if (this.closed) return false
      if (lane === 'settle' && !record.stopped) return false
      if (!record.stopped && !record.stopIntent && !record.stopUnknown
        && !this.stopOperations?.has(JSON.stringify([workId, record.identity.executionId]))
        && this.native.get(workId) && !await this.observations.mayApply(pending)) {
        await this.observations.deferUnperformed(pending)
        return
      }
      const priorStop = this.stopOperations?.get(JSON.stringify([workId, record.identity.executionId]))
      if (priorStop?.settled && priorStop.result?.status === 'superseded' && !record.stopIntent && !record.stopUnknown) {
        await this.observations.deferUnperformed(pending)
        return
      }
      if (!this.trackedStop(record, record.stopIntent || record.stopUnknown ? undefined : pending)) return false
      if (lane === 'native') return false
      record = current()
      if (!record || !record.stopped || this.closed) return false
      if (await this.controls.execution(action.identity) || await this.observationTaskHeld(record) || this.closed) return;
      const context = {
        facts: 'The Host observed no effective native output/tool progress through the 5/5/30 inactivity sequence and confirmed the old execution stopped. Preserve the original records and inspect the original work before continuing.',
        previousIntervention: action, elapsedMs: action.elapsedMs
      }
      if (action.identity.role === 'Helper') {
        const request: RoleWake = {
          id: 'overall-restore:' + pending.id, role: 'Helper', reason: 'observation', sources: [],
          context: { ...context, overallRestoration: true }
        }
        const inspection = record.stopped || record.stopIntent?.phase === 'disposed' ? undefined : await new DshSessionReader(this.ctx).inspect(record.sessionId)
        if (this.closed) return false
        await this.arrangeNativeContinuation(record, request.context!, inspection, request.id, request, request);
        return;
      }
      let debugPath: string | undefined
      if (record.identity.taskId && record.identity.member && (record.identity.role === 'Planner' || record.identity.role === 'Worker')) {
        const taskId = record.identity.taskId, member = record.identity.member
        if (this.files instanceof PhysicalLocalFiles) {
          const date = new Date(pending.checkedAt ?? Date.now()).toISOString().slice(0, 10)
          debugPath = await this.publishPhysicalMemberRecovery('observation-recovery:' + pending.id, { taskId, member, lifecycleId: record.identity.lifecycleId },
            record.identity.role === 'Worker' ? { path: helperDebugPath(taskId, date), text: '\n' + JSON.stringify(context) + '\n' } : undefined,
            record.identity.role === 'Worker' ? paths.state(member, taskId) + '/Planner_Recovery_' + date + '_' + hash('observation:' + pending.id) : undefined)
        } else await this.transactions.run('observation-recovery:' + pending.id, { taskId, member, executionId: record.identity.executionId }, { reevaluate: true, taskOwner: this.taskCommandOwner(record.identity) }, async (snapshot) => {
          if (await this.manuallyCleared(taskId, snapshot) || await readTaskCleanupRecord(this.files, snapshot, taskId)) return []
          const task = await readJson<TaskMetadata>(this.files, snapshot, paths.task(taskId))
          const status = await readMemberStatus(this.files, snapshot, paths.memberStatus(taskId, member))
          const inbox = await this.files.read(snapshot, paths.inbox(taskId, member))
          if (task?.status !== 'running' || status?.state === 'complete') return []
          const changes: FileChange[] = inbox?.length ? [{ path: paths.state(member, taskId) + '/recovery', content: '' }] : []
          if (record!.identity.role === 'Worker') {
            // Publish the real interruption facts with an ordinary empty STATE
            // notification. Only subsequent discovery can admit the Planner.
            const date = new Date(pending.checkedAt ?? Date.now()).toISOString().slice(0, 10), debug = helperDebugPath(taskId, date)
            changes.push({ path: debug, content: (await this.files.read(snapshot, debug) ?? '') + '\n' + JSON.stringify(context) + '\n' },
              { path: hostRecoverySignalPath(paths.state(member, taskId) + '/Planner_Recovery_' + date + '_' + hash('observation:' + pending.id), debug), content: '' })
          }
          return changes
        });
        if (this.closed) return false
      }
      if (this.closed) return false
      await this.publishOwnerRecovery('observation-owner-recovery:' + pending.id, record)
      if (this.closed) return false
      const inspection = record.stopped || record.stopIntent?.phase === 'disposed' ? undefined : await new DshSessionReader(this.ctx).inspect(record.sessionId)
      if (this.closed) return false
      await this.arrangeNativeContinuation(record, { ...context, ...(debugPath ? { debugPath } : {}) }, inspection, 'observation-restart:' + pending.id)
    });
  }
  private readonly cleanupResidues = new Map<string, string>()
  private async clean(task: TaskMetadata, snapshot: FilesSnapshot, observation: CleanupObservation): Promise<boolean> {
    try { return await this.cleanAt(task, snapshot, observation) }
    catch (error) {
      // Changed relevant inputs wait for the next normal Host observation. The
      // writer still handles unrelated contention through its atomic protocol.
      if (error instanceof FilesConflictError && !this.closed) return false
      throw error
    }
  }
  private async cleanAt(task: TaskMetadata, snapshot: FilesSnapshot, observation: CleanupObservation): Promise<boolean> {
    if (task.parent) return false
    if (observation.status === 'not-requested' && !observation.error) { this.cleanupResidues.delete(task.taskId); return false }
    // Recorder's total Cleaner handoff is the cleanup request. Host starts
    // native release independently; Cleaner removes fixed roots without waiting
    // for it and does not inspect business state, archives or skills.
    const result = await this.cleaner.clean(task, observation)
    this.cleanupResidues.delete(task.taskId)
    const released = result.status === 'released' || result.status === 'deleted';
    if (released) this.environment.changed?.();
    return released;
  }

  private async releaseLocalTask(taskId: string, lifecycleId?: string, selected?: TaskMetadata): Promise<void> {
    this.cleanupResidues.delete(taskId)
    const task = selected ?? await withSnapshot(this.files, snapshot => readJson<TaskMetadata>(this.files, snapshot, paths.task(taskId)))
    if (!task || task.taskId !== taskId) throw new Error('Released task metadata is unavailable: ' + taskId)
    if (taskLifecycle(task) !== (lifecycleId ?? "")) throw new Error("Task lifecycle changed before local release.");
    for (const initial of this.roleRecords.values()) if (initial.identity.taskId === taskId && taskLifecycle(initial.identity) === taskLifecycle(task) && !initial.stopped) {
      // Native close follows this execution's already-admitted work; the Host
      // starts fixed-root Cleaner independently and does not wait for this.
      await this.serialWork(initial.identity.workId, async () => {
        const record = this.roleRecords.get(initial.identity.workId)
        if (!record || record.identity.executionId !== initial.identity.executionId || record.stopped) return
        const result = await this.stopOwnedRecord(record)
        if (result.status !== 'stopped') throw new Error(result.status === 'unconfirmed' ? result.reason : 'Task execution changed during local release.')
        await this.saveRole({ ...record, stopped: true })
      })
    }
    // Retired Workers still have exact native handles, never inferred old O
    // producers. Finish only this Task's accepted drain before its associations.
    if (this.files instanceof PhysicalLocalFiles) for (const record of [...this.retiredWorkers?.values() ?? []]) {
      if (record.identity.taskId !== taskId || taskLifecycle(record.identity) !== taskLifecycle(task) || record.stopped) continue
      await this.workerDrains?.get(record.identity.executionId)
      const current = this.retiredWorkers?.get(record.identity.executionId)
      if (!current || current.stopped) continue
      const result = await this.stopOwnedRecord(current)
      if (result.status !== 'stopped') throw new Error(result.status === 'unconfirmed' ? result.reason : 'Retired Task execution changed during local release.')
      await this.saveRetiredWorker({ ...current, stopped: true })
    }
    await this.releaseTask(task)
  }
  private async cancelledOrganizerStopped(taskId: string, lifecycleId?: string): Promise<boolean> {
    for (const initial of [...this.roleRecords.values()]) {
      if (initial.identity.role !== 'Organizer' || initial.released || taskLifecycle(initial.identity) !== (lifecycleId ?? "") || initial.identity.taskId !== taskId) continue;
      const candidate = this.roleRecords.get(initial.identity.workId) ?? initial
      if (candidate.identity.taskId !== taskId) continue
      const workId = candidate.identity.workId
      if (this.workOperations?.has(workId)) return false
      let settled = true
      await this.serialWork(workId, async () => {
        const current = this.roleRecords.get(workId)
        if (!current || current.identity.executionId !== candidate.identity.executionId || current.released) return
        if (current.identity.taskId !== taskId) { settled = false; return }
        const stop = this.stopOperations?.get(JSON.stringify([workId, current.identity.executionId]))
        if ((stop && !stop.settled) || !this.trackedStop(current)) { settled = false; return }
      });
      if (!settled) return false
    }
    return true;
  }
  private async releaseTask(task: TaskMetadata): Promise<void> {
    this.cleanupResidues.delete(task.taskId)
    if (!(this.files instanceof PhysicalLocalFiles)) {
      await withSnapshot(this.files, (snapshot) => assertTaskLifecycle(this.files, snapshot, task.taskId, task));
    }
    if ([...this.retiredWorkers?.values() ?? []].some((record) => record.identity.taskId === task.taskId && taskLifecycle(record.identity) === taskLifecycle(task) && !record.stopped))
      throw new Error('Task has a retired Worker whose native producer is not stopped.')
    for (const [workId, stop] of this.stopOperations ?? []) if (stop.taskId === task.taskId && taskLifecycle(stop) === taskLifecycle(task) && stop.settled) this.stopOperations!.delete(workId);
    for (const record of [...this.roleRecords.values()]) if (record.identity.taskId === task.taskId && taskLifecycle(record.identity) === taskLifecycle(task)) {
      if (!record.stopped || this.active(record)) throw new Error('Task execution is not confirmed stopped for final release.')
      await this.observations.unbind(record.identity.workId, record.identity.executionId)
      if (!record.released) await this.saveRole({ ...record, stopped: true, released: true })
    }
    const resolvedSafetyFaultIds = isTerminalTask(task) ? [...this.safetyEpisodes?.values() ?? []]
      .filter(value => !value.fault.operationId && (value.fault.taskId ?? value.fault.identity?.taskId) === task.taskId).map(value => value.fault.id) : [];
    await this.commitTaskSeal(task.taskId, resolvedSafetyFaultIds, task.lifecycleId);
    const releaseRoles = [...new Map([...this.roleBases?.values() ?? [], ...this.roleRecords.values(), ...this.retiredWorkers?.values() ?? []]
      .filter(record => record.identity.role !== 'Foreground' && record.identity.taskId === task.taskId && taskLifecycle(record.identity) === taskLifecycle(task))
      .map(record => [record.identity.executionId, record])).values()]
    if (this.files instanceof PhysicalLocalFiles) {
      // All current owners above are released, so late buttons cannot admit
      // another write. Join only this Task's already accepted original writes;
      // their failures remain outcomes of the original calls, not native proof.
      await Promise.allSettled(this.pendingControlStops.filter(target => target.owner?.taskId === task.taskId
        && taskLifecycle(target.owner) === taskLifecycle(task)).flatMap(target => target.write ? [target.write] : []))
      // The owners above are now confirmed stopped and closed to new writes.
      // Settle their already accepted exact commands before Cleaner removes
      // this Task's control.json; do not turn an original write error into a
      // native success or wait for another Task's controls.
      await this.applyUserControls(true, { taskId: task.taskId, lifecycleId: task.lifecycleId })
    }
    if (!(this.records instanceof GitAuthorityStore)) await this.controls.releaseTask(task.taskId, task.lifecycleId, releaseRoles.map(record => record.identity.executionId));
    for (const id of resolvedSafetyFaultIds) { this.resolvedSafetyFaultIds.add(id); this.environment.safetyResolved?.(id) }
    await this.cleanupWorkerTransfers(task.taskId, task.lifecycleId);
    // Physical business paths have no SQL command receipts to reconcile.
    if (!(this.files instanceof PhysicalLocalFiles)) await this.transactions.releaseTaskCommands(this.taskCommandOwner(task)!)
    await this.retireTaskRuntime(task, releaseRoles)
    if (isTerminalTask(task)) {
      if (!(this.files instanceof PhysicalLocalFiles)) await withSnapshot(this.files, (snapshot) => assertTaskLifecycle(this.files, snapshot, task.taskId, task));
      this.environment.resolved?.({ taskId: task.taskId })
    }
  }
  /** Read committed retirement rows without joining other Tasks' proven
   * original writes. Own, unknown and queued restore updates retain their wait. */
  private localTaskRetirementRows<T>(group: 'observations' | 'restores', task: TaskMetadata): Promise<Array<{ key: string; value: T }>> {
    const prefix = this.prefix + group + '/'
    if (!(this.files instanceof PhysicalLocalFiles) || !(this.records instanceof DshStorageAdapter)) return this.records.list<T>(prefix)
    const unrelated = (owner: { taskId?: string; lifecycleId?: string }) => owner.taskId !== task.taskId || taskLifecycle(owner) !== taskLifecycle(task)
    const keys = group === 'observations'
      ? [...this.observationRecordWrites].filter(([, write]) => unrelated(write.identity)).map(([key]) => key)
      : [...this.restoreWriteOwners].filter(([commandId, owner]) => owner.write !== undefined
        && owner.write === this.safetyRestoreWrites.get(commandId) && unrelated(owner)).map(([commandId]) => prefix + hash(commandId))
    return this.records.listWithoutUnrelatedTaskRetirementWriteWait<T>(prefix, new Set(keys))
  }
  /** Retire bodies after the existing release fact, not instead of native stop.
   * Target selection uses values; hashes only address already-owned records. */
  private async retireTaskRuntime(task: TaskMetadata, capturedRoles: readonly RoleRecord[] = []): Promise<void> {
    const belongs = (identity: { taskId?: string; lifecycleId?: string; role?: RecoveryRole }) => identity.role !== 'Foreground'
      && identity.taskId === task.taskId && taskLifecycle(identity) === taskLifecycle(task)
    const ownedRoles = [...new Map([...capturedRoles, ...this.roleBases?.values() ?? [], ...this.roleRecords.values(), ...this.retiredWorkers?.values() ?? []]
      .filter(record => belongs(record.identity)).map(record => [record.identity.workId, record])).values()]
    const observationWorkIds = [...new Set([...ownedRoles.map(record => record.identity.workId),
      ...[...this.roleWriteOwners.values()].filter(belongs).map(identity => identity.workId)])]
    await this.observations.releaseTask(task.taskId, task.lifecycleId, observationWorkIds)
    await Promise.all([...this.roleWriteOwners].filter(([, identity]) => belongs(identity)).map(([key]) => this.roleWrites?.get(key)))
    await Promise.all([...this.wakeWriteOwners].filter(([, identity]) => belongs(identity)).map(([key]) => this.wakeWrites.get(key)))
    const roleRows = this.records instanceof GitAuthorityStore
      ? (await this.taskReleaseRuntimeRows<RoleRecord>('roles', task)).filter(row => belongs(row.value.identity))
        .map(row => ({ key: row.key, workId: row.value.identity.workId }))
      : observationWorkIds.map(workId => ({ key: this.prefix + 'roles/' + hash(workId), workId }))
    for (const row of roleRows) {
      await this.withRoleWrite(row.workId, async () => {
        const current = await this.records.get<RoleRecord>(row.key)
        if (!current || !belongs(current.identity)) return
        if (!current.stopped) throw new Error('Task execution is not confirmed stopped during runtime retirement.')
        // This original row still owns any displaced P/O sessions whose
        // acceptance failed or is concurrent. Join acceptance, never physical
        // cleanup or the independent pending-clear operation on this same lock.
        await this.settleOperations([...new Set([current.sessionId, ...(current.nativeRetirements ?? []).map(item => item.sessionId)])]
          .map(sessionId => retireNativeSession(this.ctx, sessionId)), 'Task native retirement failed')
        // A closed runtime leaves this exact persisted release for restart.
        // Native journal acceptance does not authorize using a closed connection.
        if (this.closed) throw this.shutdownReason ?? new Error('Framework runtime is disposed.')
        await this.deleteRuntimeRecord(row.key, current)
        const live = this.roleRecords.get(current.identity.workId)
        if (live?.identity.executionId === current.identity.executionId) this.roleRecords.delete(current.identity.workId)
        this.roleBases?.delete(current.identity.workId)
        this.wakeConsumptions.delete(current.identity.executionId)
      })
    }
    for (const row of await this.taskReleaseWakes(task.taskId, task.lifecycleId)) if (belongs(row.value.request)) {
      await this.wakeWrites.get(row.key)?.catch(() => {})
      const current = await this.records.get<WakeRecord>(row.key)
      if (current && belongs(current.request)) await this.deleteRuntimeRecord(row.key, current)
    }
    await Promise.all([...this.observationRecordWrites.values()].filter(write => belongs(write.identity)).map(write => write.promise))
    const observations = this.records instanceof GitAuthorityStore
      ? await this.taskReleaseRuntimeRows<ObservationRecord>('observations', task) : await this.localTaskRetirementRows<ObservationRecord>('observations', task)
    for (const row of observations) if (belongs(row.value.pending.action.identity))
      await this.deleteRuntimeRecord(row.key, row.value)
    await Promise.all([...this.restoreWriteOwners].filter(([, owner]) => belongs(owner)).map(([commandId]) => this.safetyRestoreWrites.get(commandId)))
    const restores = this.records instanceof GitAuthorityStore
      ? await this.taskReleaseRuntimeRows<RoleRestore>('restores', task) : await this.localTaskRetirementRows<RoleRestore>('restores', task)
    let pendingTaskRestore = false
    for (const row of restores) {
      const owner = this.restoreTaskOwner(row.value)
      if (!owner || !belongs(owner)) continue
      await this.safetyRestoreWrites.get(row.value.commandId)
      const current = await this.records.get<RoleRestore>(row.key)
      if (current && !current.complete) pendingTaskRestore = true
      // An unfinished repair still owns its uncertain operation. Completion
      // retires it at the writer above rather than preserving terminal input.
      if (current?.complete && this.restoreTaskOwner(current) && belongs(this.restoreTaskOwner(current)!)) {
        // This exact completed Task restore owns its Debug command receipt, not the Debug body.
        if (await this.retirePhysicalRestoreDebug(row.key, current))
          await this.deleteRuntimeRecord(row.key, current, this.restoreCommandReceiptPaths(current))
      }
    }
    if (isTerminalTask(task) && !pendingTaskRestore) this.startMaintenance('helper-task-claims:' + taskLifecycleKey(task), async () => {
      try { await this.retireReleasedTaskHelperClaims(task) }
      catch (error) { this.ctx.logger?.('deepseek-servant').warn('Finished Task Helper claim cleanup was skipped; Task release continues.', error) }
    })
    for (const member of new Set([...(task.members ?? [task.owner]), this.config.member])) await this.serialRecoveryWatch(task.taskId, member, async key => {
      const current = await this.records.get<RecoveryWatchRecord>(key)
      if (current) await this.deleteRuntimeRecord(key, current)
    }, task.lifecycleId)
    if (this.files instanceof PhysicalLocalFiles) this.pendingControlStops = this.pendingControlStops.filter(target =>
      !target.awaitingTaskRetirement || !target.owner || !belongs(target.owner))
  }
  /** Release finished Task inputs, while other Tasks retain their original
   * WakeRecords. A consumed mixed claim is retired whole with its old receipt;
   * no historical request body is edited or synthetic claim is created. */
  private async retireReleasedTaskHelperClaims(task: TaskMetadata): Promise<void> {
    const workId = this.roleKey('Helper')
    try { await this.notificationClaimWrites?.get(workId) } catch { return }
    await this.withRoleWrite(workId, async () => {
      const selected = this.roleRecords.get(workId)
      if (!selected) return
      const belongs = (wake: RoleWake) => {
        const owner = this.helperTaskOwner(wake)
        return owner?.taskId === task.taskId && taskLifecycle(owner) === taskLifecycle(task)
      }
      const completedInput = (wake: WakeRecord) => {
        const context = wake.request.context
        const faults = [...wake.safetyFaults ?? [], ...wake.safetyAttempts?.map(attempt => attempt.fault) ?? [],
          ...context?.safetyFault ? [context.safetyFault as SafetyFault] : [], ...context?.safetyFaults as SafetyFault[] ?? []]
        return wake.delivered && wake.signalsConsumed && !wake.recovery && !wake.safetyParentWakeId
          && !context?.originalWake && !context?.notificationClaims
          // Helper self-report/idle is insufficient. Task release has already
          // committed its real resolutions; UNKNOWN operations remain unresolved.
          && faults.every(fault => this.resolvedSafetyFaultIds.has(fault.id))
          && (wake.resolvedSafetyFaultIds ?? []).every(id => this.resolvedSafetyFaultIds.has(id))
          && ![...this.safetyEpisodes.values()].some(episode => episode.helperWakeId === wake.request.id
            && !this.resolvedSafetyFaultIds.has(episode.fault.id))
      }
      const finished = [...this.taskHelperWakes?.values() ?? []].filter(wake => belongs(wake.request) && completedInput(wake))
      if (!finished.length) return
      const finishedIds = new Set(finished.map(wake => wake.request.id))
      const ids = Object.entries(selected.notificationClaims ?? {}).filter(([, claim]) =>
        claim.helperWakes?.some(wake => finishedIds.has(wake.id))).map(([id]) => id)
      const requests = new Map([...finished.map(wake => wake.request), ...ids.flatMap(id => selected.notificationClaims![id].helperWakes ?? [])].map(wake => [wake.id, wake]))
      const wakeKeys = [...requests.keys()].map(id => this.prefix + 'wakes/' + hash(id))
      const key = this.roleRecordPath(workId)
      const prune = (current: RoleRecord | undefined, rows: ReadonlyMap<string, unknown>) => {
        if (!current || current.identity.executionId !== selected.identity.executionId) return { current, removed: [] as string[], retired: [] as WakeRecord[] }
        const original = (request: RoleWake) => rows.get(this.prefix + 'wakes/' + hash(request.id)) as WakeRecord | undefined
        const retired = finished.filter(wake => { const value = original(wake.request); return value && completedInput(value) && JSON.stringify(value.request) === JSON.stringify(wake.request) })
        const retiredIds = new Set(retired.map(wake => wake.request.id))
        const removed = ids.filter(id => {
          const claim = current.notificationClaims?.[id]
          return claim && JSON.stringify(claim) === JSON.stringify(selected.notificationClaims![id])
            && claim.helperWakes?.some(wake => retiredIds.has(wake.id))
            && claim.helperWakes.every(wake => { const value = original(wake); return value?.delivered && value.signalsConsumed && JSON.stringify(value.request) === JSON.stringify(wake) })
            && claim.sources.every(source => claim.helperWakes!.some(wake => wake.sources.some(item => item.path === source.path && item.version === source.version)))
        })
        const claims = { ...current.notificationClaims }
        for (const id of removed) delete claims[id]
        const referenced = new Set(Object.values(claims).flatMap(claim => claim.helperWakes?.map(wake => wake.id) ?? []))
        return { current: { ...current, notificationClaims: Object.keys(claims).length ? claims : undefined }, removed,
          retired: retired.filter(wake => !referenced.has(wake.request.id)) }
      }
      let saved: RoleRecord | undefined, retired: WakeRecord[] = []
      if (this.records instanceof GitAuthorityStore) {
        const authority = this.records
        const result = await authority.updateWithReads<RoleRecord, ReturnType<typeof prune>>(key, wakeKeys, (current, rows) => {
          const result = prune(current, rows)
          const changes: FileChange[] = [
            ...result.removed.map(id => ({ path: gitCommandReceiptPath(current!.notificationClaims![id].commandId), content: null })),
            ...result.retired.map(wake => authority.deleteChange(this.prefix + 'wakes/' + hash(wake.request.id)))
          ]
          return { write: !!result.removed.length || !!changes.length, value: result.current, result, changes }
        })
        saved = result.current; retired = result.retired
      } else {
        const rows = new Map(await Promise.all(wakeKeys.map(async key => [key, await this.records.get<WakeRecord>(key)] as const)))
        const current = await this.records.get<RoleRecord>(key), result = prune(current, rows)
        saved = result.current
        if (result.removed.length) await this.records.set(key, saved!)
        for (const wake of result.retired) {
          const wakeKey = this.prefix + 'wakes/' + hash(wake.request.id)
          const operation = (this.wakeWrites.get(wakeKey) ?? Promise.resolve()).then(async () => {
            const current = await this.records.get<WakeRecord>(wakeKey)
            if (JSON.stringify(current) !== JSON.stringify(wake)) return
            await this.deleteRuntimeRecord(wakeKey, wake)
            retired.push(wake)
          })
          this.wakeWrites.set(wakeKey, operation)
          try { await operation }
          finally { if (this.wakeWrites.get(wakeKey) === operation) this.wakeWrites.delete(wakeKey) }
        }
      }
      for (const wake of retired) this.taskHelperWakes?.delete(wake.request.id)
      if (!saved) return
      const live = this.roleRecords.get(workId)
      if (live?.identity.executionId === saved.identity.executionId) {
        this.roleRecords.set(workId, { ...live, notificationClaims: saved.notificationClaims })
        ;(this.roleBases ??= new Map()).set(workId, structuredClone(saved))
      }
    })
  }
  private taskReleaseIndexes?: {
    roles: GitRecordIndex<AuthorityDiscoveryKey>
    retired: GitRecordIndex<AuthorityDiscoveryKey>
    observations: GitRecordIndex<AuthorityDiscoveryKey>
    restores: GitRecordIndex<AuthorityDiscoveryKey>
    transfers: GitRecordIndex<null>
    wakes: GitRecordIndex<{ key: string }>
  }
  private releaseIndexes() {
    if (this.taskReleaseIndexes) return this.taskReleaseIndexes
    if (!(this.records instanceof GitAuthorityStore) || !(this.files instanceof GitFiles)) throw new Error('Git task discovery requires Git authority.')
    const groups = (record: unknown) => this.roleTaskGroups(record)
    const observationGroups = (record: Partial<ObservationRecord> | undefined) => this.roleTaskGroups({ identity: record?.pending?.action?.identity })
    const restoreGroups = (record: Partial<RoleRestore> | undefined) => this.roleTaskGroups({ identity: record && this.restoreTaskOwner(record) })
    const runtimeFault = <T>(group: (record: T | undefined) => readonly string[]) => (fault: AuthorityContentFault) => {
      this.error(new Error('Malformed runtime authority at ' + fault.path + ': ' + fault.reason), {
        stage: 'runtime-retirement-discovery', path: fault.path, ...(fault.key ? { key: fault.key } : {}),
      })
      return group(fault.value as T | undefined)
    }
    return this.taskReleaseIndexes = {
      roles: this.records.index<unknown>(this.prefix + 'roles/', groups, fault => this.reportRoleContentFault(fault)),
      retired: this.records.index<unknown>(this.prefix + 'retired-workers/', groups, fault => this.reportRoleContentFault(fault)),
      observations: this.records.index<ObservationRecord>(this.prefix + 'observations/', observationGroups, runtimeFault(observationGroups)),
      restores: this.records.index<RoleRestore>(this.prefix + 'restores/', restoreGroups, runtimeFault(restoreGroups)),
      wakes: this.records.index<WakeRecord>(this.prefix + 'wakes/', wake => wake?.request?.taskId ? [taskLifecycleKey({ taskId: wake.request.taskId, lifecycleId: wake.request.lifecycleId })] : []),
      transfers: new GitRecordIndex(this.files, workerTransferRoot(this.workerBusinessScope()), (_path, text) => {
        let value: WorkerBusinessTransfer<RoleRecord>
        try { value = JSON.parse(text) } catch { return }
        const taskId = value?.record?.identity?.taskId
        return typeof taskId === 'string' ? { value: null, groups: [taskLifecycleKey({ taskId, lifecycleId: value.record.identity.lifecycleId })] } : undefined
      }),
    }
  }
  private async refreshTaskReleaseIndexes(snapshot: FilesSnapshot): Promise<void> {
    if (!(this.records instanceof GitAuthorityStore)) return
    const indexes = this.releaseIndexes()
    // Use the existing Host poll. An unchanged directory returns its existing
    // entries; no additional timer, Git member list or local authority is added.
    // Observation/restore indexes replace retirement's old lists lazily; do not
    // add those directories to ordinary background discovery.
    await Promise.all([indexes.roles, indexes.retired, indexes.wakes, indexes.transfers].map(index => index.at(snapshot, '')))
  }
  private async taskReleaseRuntimeRows<T>(lane: 'roles' | 'observations' | 'restores', task: Pick<TaskMetadata, 'taskId' | 'lifecycleId'>): Promise<Array<{ key: string; value: T }>> {
    if (!(this.records instanceof GitAuthorityStore)) throw new Error('Grouped runtime retirement requires Git authority.')
    const authority = this.records, index = this.releaseIndexes()[lane]
    // Reconcile the existing discovery index with a current view after this
    // Task's writer drain. An older Host poll is not the final candidate set.
    return withSnapshot(this.files, async snapshot => {
      const owned = await index.at(snapshot, taskLifecycleKey(task))
      const rows: Array<{ key: string; value: T }> = []
      for (const candidate of owned) {
        if (!candidate.value.key) continue
        const value = await authority.getAt<T>(snapshot, candidate.value.key)
        if (value !== undefined) rows.push({ key: candidate.value.key, value })
      }
      return rows
    })
  }
  private async taskReleaseWakes(taskId: string, lifecycleId?: string): Promise<Array<{ key: string; value: WakeRecord }>> {
    if (!(this.records instanceof GitAuthorityStore)) return this.records.list<WakeRecord>(this.prefix + 'wakes/')
    const authority = this.records
    return withSnapshot(this.files, async snapshot => {
      const candidates = await this.releaseIndexes().wakes.at(snapshot, taskLifecycleKey({ taskId, lifecycleId }))
      const result: Array<{ key: string; value: WakeRecord }> = []
      for (const candidate of candidates) {
        const value = await authority.getAt<WakeRecord>(snapshot, candidate.value.key)
        if (value) result.push({ key: candidate.value.key, value })
      }
      return result
    })
  }
  private async taskReleaseCandidates(taskId: string, snapshot: FilesSnapshot, lifecycleId?: string) {
    const indexes = this.releaseIndexes()
    const group = taskLifecycleKey({ taskId, lifecycleId })
    const [roles, retired, transfers] = await Promise.all([
      indexes.roles.at(snapshot, group), indexes.retired.at(snapshot, group), indexes.transfers.at(snapshot, group),
    ])
    const authority = this.records as GitAuthorityStore
    const rows: Array<{ key: string; value: RoleRecord }> = []
    for (const candidate of [...roles, ...retired]) {
      // Discovery already reported unreadable envelopes; their clues are not
      // owned native executions and do not gate this Task's known releases.
      if (!candidate.value.key) continue
      const value = await authority.getAt<RoleRecord>(snapshot, candidate.value.key)
      if (value === undefined) throw new Error('Indexed task authority disappeared from its immutable snapshot.')
      rows.push({ key: candidate.value.key, value })
    }
    const rawRows: Array<{ path: string; body: string }> = []
    for (const candidate of transfers) {
      const body = await this.files.read(snapshot, candidate.path)
      if (body === undefined) throw new Error('Indexed Worker transfer disappeared from its immutable snapshot.')
      rawRows.push({ path: candidate.path, body })
    }
    return { rows, rawRows }
  }
  private async commitTaskSeal(taskId: string, resolvedSafetyFaultIds: string[], lifecycleId?: string): Promise<void> {
    // Physical Host owns this Task's release before directory deletion.
    // Do not recreate program-state files during resource retirement.
    if (this.files instanceof PhysicalLocalFiles) return
    await updateTaskArchiveState(this.files, taskId, async (snapshot, _identity, state) => {
      const { rows, rawRows } = await this.taskReleaseCandidates(taskId, snapshot, lifecycleId)
      await assertTaskLifecycle(this.files, snapshot, taskId, { lifecycleId });
      for (const row of rows) {
        const role = (row.value as RoleRecord);
        const belongs = role?.identity?.taskId === taskId
        if (!belongs || taskLifecycle(role.identity) !== (lifecycleId ?? "")) continue;
        if (!role.stopped || !role.released && !row.key.startsWith(this.prefix + 'retired-workers/'))
          throw new Error('Task ownership changed during final release; re-evaluate the new execution.')
      }
      for (const entry of rawRows) {
        let transfer: WorkerBusinessTransfer<RoleRecord>
        try {
          transfer = (JSON.parse(entry.body) as WorkerBusinessTransfer<RoleRecord>);
        } catch { continue }
        if (transfer?.record?.identity?.taskId !== taskId || taskLifecycle(transfer.record.identity) !== (lifecycleId ?? "")) continue;
        const owner = transfer.record, retiredKey = this.prefix + 'retired-workers/' + owner.identity.executionId
        const retired = (rows.find(row => row.key === retiredKey)?.value as RoleRecord | undefined);
        if (transfer.version !== 1 || entry.path !== workerTransferPath(this.workerBusinessScope(), owner.identity.executionId)
          || !retired || JSON.stringify(retired.identity) !== JSON.stringify(owner.identity) || retired.sessionId !== owner.sessionId
          || retired.generation !== owner.generation || !retired.stopped) throw new Error('Task has an unresolved Worker transfer.')
      }
      const merged = this.withTaskFacts(state, lifecycleId, { sealed: true, runtimeReleased: true, ...(resolvedSafetyFaultIds.length ? { resolvedSafetyFaultIds } : {}) })
      const changes = await this.controls.releaseChangesAt(snapshot, taskId, lifecycleId)
      return { state: merged, changes, result: undefined, write: JSON.stringify(state) !== JSON.stringify(merged) || !!changes.length }
    })
  }
  async cancelledTasksChanged(taskIds: readonly string[], lifecycles?: Readonly<Record<string, string>>): Promise<void> {
    for (const taskId of taskIds) this.observedTerminalTasks.set(taskLifecycleKey({ taskId, lifecycleId: lifecycles?.[taskId] ?? this.knownTaskLifecycles.get(taskId) }), "cancelled");
    for (const taskId of taskIds) {
      const lifecycleId = lifecycles?.[taskId] ?? this.knownTaskLifecycles.get(taskId) ?? "";
      let task;
      task = await updateTaskArchiveState(this.files, taskId, async (snapshot, _identity, state) => {
        const selected = await readJson<TaskMetadata>(this.files, snapshot, paths.task(taskId))
        if (selected?.status !== 'cancelled' || taskLifecycle(selected) !== lifecycleId) return { result: undefined, write: false }
        const next = this.withTaskFacts(state, lifecycleId, { sealed: true })
        return { state: next, result: selected, write: JSON.stringify(next) !== JSON.stringify(state) }
      })
      if (task) await this.cancelledBusinessStopped(task);
    }
    this.environment.changed?.();
  }
  private async cancelledBusinessStopped(task: TaskMetadata): Promise<boolean> {
    this.rememberTerminalTask(task);
    let stopped = this.businessStopped(task.taskId, task.lifecycleId);
    if (!await this.cancelledOrganizerStopped(task.taskId, task.lifecycleId)) stopped = false;
    const relatedKey = (workId: string) => {
      if (this.workerAdmissionTasks?.get(workId) === task.taskId) return true;
      try {
        const key = JSON.parse(workId);
        return ["Planner", "Worker", "Organizer"].includes(key[0]) && key[1] === task.taskId;
      } catch {
        return false;
      }
    };
    if ([...this.admissions?.keys() ?? [], ...this.workerAdmissions ?? []].some(relatedKey)) stopped = false;
    for (const record of this.roleRecords.values()) {
      if (record.identity.role !== "Helper" || record.stopped || record.released) continue;
      const diagnostic = (record.delivery?.request ?? record.lastWake)?.id;
      const faults = [...this.safetyEpisodes.values()].filter((episode) => !episode.settled && episode.helperWakeId === diagnostic).map((episode) => episode.fault);
      if (!faults.length || faults.some((fault) => (fault.taskId ?? fault.identity?.taskId) !== task.taskId || (fault.role ?? fault.identity?.role) === "Recorder")) continue;
      if (!this.trackedStop(record)) stopped = false;
    }
    return stopped;
  }
  private async sealBusiness(taskId: string, lifecycleId?: string): Promise<void> {
    await updateTaskArchiveState(this.files, taskId, async (snapshot, _identity, state) => {
      await assertTaskLifecycle(this.files, snapshot, taskId, { lifecycleId })
      const next = this.withTaskFacts(state, lifecycleId, { sealed: true })
      return { state: next, result: undefined, write: JSON.stringify(next) !== JSON.stringify(state) }
    })
  }
  private startSafetyResolutionLoad(round?: FilesReadRound): void {
    if (this.safetyResolutionLoad || this.closed) return
    const operation = this.processSealedBusiness(round).then(() => { this.safetyResolutionReady = true })
    this.safetyResolutionLoad = operation
    void operation.catch(error => this.error(error, { stage: 'safety-resolution-replay' })).finally(() => {
      if (this.safetyResolutionLoad === operation) this.safetyResolutionLoad = undefined
    })
  }
  private applyTaskArchiveFacts(taskId: string, lifecycleId: string | undefined, facts: TaskArchiveHostFacts | undefined): void {
    if (!facts) return
    if (facts.runtimeReleased) for (const [key, state] of this.localWakeAdmissions) if (state.wake.request.taskId === taskId
      && taskLifecycle(state.wake.request) === (lifecycleId ?? '') && !['Foreground', 'Helper'].includes(state.wake.request.role)) this.forgetAdmissionWake(key)
    for (const id of facts.resolvedSafetyFaultIds ?? []) if (!this.resolvedSafetyFaultIds.has(id)) { this.resolvedSafetyFaultIds.add(id); this.environment.safetyResolved?.(id) }
    if (!facts.runtimeReleased && facts.sealed) this.businessStopped(taskId, lifecycleId)
  }
  private async processSealedBusiness(round?: FilesReadRound): Promise<void> {
    const targets = new Map<string, { taskId: string; lifecycleId?: string }>()
    for (const record of [...this.roleRecords.values(), ...this.retiredWorkers?.values() ?? []])
      if (record.identity.taskId) targets.set(taskLifecycleKey({ taskId: record.identity.taskId, lifecycleId: record.identity.lifecycleId }), { taskId: record.identity.taskId, lifecycleId: record.identity.lifecycleId })
    for (const { fault } of this.safetyEpisodes.values()) {
      const taskId = fault.taskId ?? fault.identity?.taskId
      if (taskId) { const target = { taskId, lifecycleId: fault.identity?.lifecycleId ?? this.knownTaskLifecycles.get(taskId) }; targets.set(taskLifecycleKey(target), target) }
    }
    const read = async (snapshot: FilesSnapshot) => {
      for (const target of targets.values()) this.applyTaskArchiveFacts(target.taskId, target.lifecycleId, await this.taskSealAt(snapshot, target.taskId, target.lifecycleId))
    }
    if (!targets.size) return
    if (round) await round.withSnapshot(read); else await withSnapshot(this.files, read)
  }
  private trackedStop(record: RoleRecord, observation?: ScheduledObservation): boolean {
    if (record.stopped) return true
    const operations = this.stopOperations ??= new Map()
    const { workId, executionId, taskId } = record.identity
    const stopKey = JSON.stringify([workId, executionId])
    const existing = operations.get(stopKey)
    if (existing?.executionId === executionId) {
      if (!existing.settled) return false
      if (existing.result?.status === 'stopped') return true
    }
    const stop: TrackedStop = {
      executionId,
      taskId,
      lifecycleId: record.identity.lifecycleId,
      promise: Promise.resolve(),
      settled: false,
      persistedStopped: existing?.persistedStopped,
      reportedFailure: existing?.reportedFailure
    };
    const report = (error: unknown, signature: string) => {
      if (stop.reportedFailure === signature) return
      stop.reportedFailure = signature
      const restoreCommandId = this.safetyCommandFor(record.identity)
      this.error(error, { identity: record.identity, ...(restoreCommandId ? { restoreCommandId } : {}) })
    }
    operations.set(stopKey, stop)
    stop.promise = this.ownedAsyncContext(() => Promise.resolve().then(async () => {
      try {
        const result = await this.stopOwnedRecord(record, observation)
        const current = this.roleRecords.get(workId)
        if (current?.identity.executionId === executionId) {
          if (result.status === 'stopped') await this.saveRole({ ...current, stopped: true, stopUnknown: undefined })
          else if (result.status === 'unconfirmed') await this.saveRole({ ...current, stopUnknown: result })
        }
        // Another owned stop can persist this execution's confirmation before
        // its replacement is installed; a late superseded result cannot erase it.
        stop.result = stop.persistedStopped ? { status: 'stopped' } : result
        if (stop.result.status === 'unconfirmed') report(new Error(stop.result.reason),
          JSON.stringify(['unconfirmed', stop.result.reason, [...stop.result.jobs].sort()]))
      } catch (error) { stop.failure = error; report(error, JSON.stringify(['failure', error instanceof Error ? error.message : String(error)])) }
      finally {
        if (stop.persistedStopped) stop.result = { status: 'stopped' }
        stop.settled = true
      }
    }));
    return false;
  }
  private businessStopped(taskId: string, lifecycleId?: string): boolean {
    let stopped = true
    for (const record of this.retiredWorkers?.values() ?? []) if (record.identity.taskId === taskId && taskLifecycle(record.identity) === (lifecycleId ?? "") && !record.stopped) { this.drainRetiredWorker(record.identity.executionId); stopped = false }
    for (const record of this.roleRecords.values()) if (record.identity.taskId === taskId && taskLifecycle(record.identity) === (lifecycleId ?? "") && (record.identity.role === 'Planner' || record.identity.role === 'Worker')) {
      if (!record.businessTransferred && !this.trackedStop(record)) stopped = false
    }
    if ([...(this.stopOperations?.values() ?? [])].some((stop) => stop.taskId === taskId && taskLifecycle(stop) === (lifecycleId ?? "") && (!stop.settled || stop.result?.status !== 'stopped'))) stopped = false
    return stopped
  }
  private async stopOwnedRecord(record: RoleRecord, observation?: ScheduledObservation): Promise<StopResult> {
    const result = await this.native.stop(record.identity.workId, record.identity.executionId, observation)
    if (result.status !== 'superseded') return result
    if (observation && this.native.get(record.identity.workId)) return result
    const retired = this.retiredWorkers?.get(record.identity.executionId)
    const current = retired ?? this.roleRecords.get(record.identity.workId)
    if (current?.identity.executionId !== record.identity.executionId || current.sessionId !== record.sessionId) return { status: 'superseded' }
    const agent = this.ctx.agents.get(SessionId(record.sessionId))
    const jobs = this.ctx.jobs.list(SessionId(record.sessionId)).filter(job => job.owner === record.sessionId && (job.status === 'running' || job.status === 'stopping')).map(job => String(job.id))
    const intent = current.stopIntent
    if (intent && (intent.workId !== record.identity.workId || intent.executionId !== record.identity.executionId || intent.sessionId !== record.sessionId))
      return { status: 'unconfirmed', reason: 'Native stop evidence belongs to a different execution or session.', jobs }
    const disposed = intent?.phase === 'disposed'
    const known = [...new Set([...jobs, ...(intent?.jobs ?? []), ...(current.stopUnknown?.jobs ?? [])])]
    if (agent) return { status: 'unconfirmed', reason: 'A native Agent survives without its owned stop handle.', jobs: known }
    // The exact disposed receipt was persisted only after native close and all
    // owned producers settled. Its deleted log is not a second confirmation gate.
    if (disposed && !known.length) {
      await (retired ? this.saveRetiredWorker({ ...current, stopped: true, stopUnknown: undefined })
        : this.saveRole({ ...current, stopped: true, stopUnknown: undefined }))
      return { status: 'stopped' }
    }
    let events
    try { events = await new DshSessionReader(this.ctx).events(record.sessionId) }
    catch (error) { return { status: 'unconfirmed', reason: 'Native stop history is unavailable: ' + (error instanceof Error ? error.message : String(error)), jobs: known } }
    const pending = pendingNativeStopJobs(intent?.agentId ?? record.sessionId, events, known)
    if (agent || jobs.length || pending.length) return {
      status: 'unconfirmed',
      reason: current.stopUnknown?.reason ?? 'A native owner or producer still lacks confirmed settlement.', jobs: [...new Set([...jobs, ...pending])]
    }
    if (!disposed && (intent?.phase === 'stopping' || current.stopUnknown) && !known.length) return {
      status: 'unconfirmed',
      reason: 'Stop was not durably confirmed and no producer identity is available to verify; inspect the original session.', jobs: []
    }
    const latest = retired ? this.retiredWorkers?.get(record.identity.executionId) : this.roleRecords.get(record.identity.workId)
    if (latest?.identity.executionId !== record.identity.executionId || latest.sessionId !== record.sessionId) return { status: 'superseded' }
    // Exact durable dispose completion or producer settlement reconciles a lost
    // acknowledgement. An empty registry alone never establishes a native stop.
    if (intent || current.stopUnknown) await (retired ? this.saveRetiredWorker({ ...current, stopped: true, stopUnknown: undefined }) : this.saveRole({ ...current, stopped: true, stopUnknown: undefined }))
    return { status: 'stopped' }
  }
  private recoveryInputPath(taskId: string, member: string, role: RecoveryRole): string {
    return 'technical/recovery-inputs/' + paths.member(taskId, member).slice('task-runs/'.length) + '/' + role + '.json'
  }
  private async publishPhysicalHostRestoration(row: { key: string; value: HostRestore }): Promise<void> {
    if (!(this.files instanceof PhysicalLocalFiles)) throw new Error('Physical Host restoration requires physical Local files.')
    if (row.value.complete) return
    const files = this.files, { commandId, input, createdAt } = row.value
    if (!row.value.managerPublications) {
      const managers: NonNullable<HostRestore['managerPublications']> = []
      await withSnapshot(files, async snapshot => {
        for (const task of await this.taskMetadata(snapshot)) {
          if (task.status !== 'running' || await this.manuallyCleared(task.taskId, snapshot)) continue
          for (const member of task.route === 'P' ? (task.members ?? [task.owner]).filter(member => this.config.primary || member === this.config.member) : []) {
            const status = await readMemberStatus(files, snapshot, paths.memberStatus(task.taskId, member))
            const inbox = await files.fileInfo(paths.inbox(task.taskId, member))
            if (status?.state !== 'complete' && inbox?.bytes) managers.push({ taskId: task.taskId, lifecycleId: task.lifecycleId, member, role: 'Planner' })
          }
          if (task.route === 'O' && task.owner === this.config.member) managers.push({ taskId: task.taskId, lifecycleId: task.lifecycleId, member: task.owner, role: 'Organizer' })
        }
      })
      const accepted = await this.updateSafetyRestoreRow<HostRestore>(row.key, commandId, current => ({ ...current, managerPublications: current.managerPublications ?? managers }))
      row.value.managerPublications = accepted.managerPublications
    }
    const dailyDebug = row.value.debugPath ?? 'debug/' + createdAt.slice(0, 10) + '.md'
    const managers = row.value.managerPublications ?? []
    const debugCommand = 'host-restore-debug:' + commandId
    const publication = await publishPhysicalRecovery(files, { commandId: debugCommand,
      debug: { path: dailyDebug, text: '\n' + JSON.stringify({ at: createdAt, mode: 'host-restoration', ...input,
        managers: managers.flatMap(item => [paths.state(item.member, item.taskId) + '/recovery',
          paths.state(item.member, item.taskId) + '/' + item.role + '_Helper', this.recoveryInputPath(item.taskId, item.member, item.role)]) }) + '\n' } }, undefined, undefined,
      { debugPath: hostRecoveryDebugPath(dailyDebug, debugCommand) })
    const debug = publication.debugPath!
    for (const manager of managers) await withSnapshot(files, async snapshot => {
      const task = await readJson<TaskMetadata>(files, snapshot, paths.task(manager.taskId))
      if (!task || task.status !== 'running' || taskLifecycle(task) !== taskLifecycle(manager)
        || await this.manuallyCleared(manager.taskId, snapshot) || await readTaskCleanupRecord(files, snapshot, manager.taskId)) return
      if (manager.role === 'Planner') {
        const status = await readMemberStatus(files, snapshot, paths.memberStatus(manager.taskId, manager.member))
        if (status?.state === 'complete' || !(await files.fileInfo(paths.inbox(manager.taskId, manager.member)))?.bytes) return
      }
      await publishPhysicalRecovery(files, { commandId: 'host-restore:' + commandId + ':' + hash(JSON.stringify(manager)),
        taskId: manager.taskId, lifecycleId: manager.lifecycleId,
        markerPath: paths.state(manager.member, manager.taskId) + '/recovery',
        signalPath: paths.state(manager.member, manager.taskId) + '/' + manager.role + '_Helper',
        recoveryInput: { path: this.recoveryInputPath(manager.taskId, manager.member, manager.role), text: JSON.stringify({ ...input, at: createdAt, debugPath: debug }) } }, async () => {
        if (this.closed) throw new Error('Role runtime is closed.')
        await assertTaskLifecycle(files, snapshot, manager.taskId, manager)
        if (await readTaskCleanupRecord(files, snapshot, manager.taskId)) throw new Error('The recovery Task runtime was retired.')
      }, path => this.physicalSignalSources(path))
    })
  }
  private async processHostRestores(onError?: (error: unknown, context: Record<string, unknown>) => void, round?: FilesReadRound): Promise<void> {


    const priorProofs = [...this.hostRestoreNativeEvidence ?? []]
    const rows = await listAuthorityInRound<HostRestore>(this.records, this.prefix + 'host-restores/', round)
    if (priorProofs.length) {
      const present = new Set(rows.map(row => row.value.commandId))
      // A missing inventory entry can be a stale read or an isolated bad record.
      // Check only these known exact keys, independently of normal restoration.
      for (const [commandId, proof] of priorProofs) if (!present.has(commandId)
        && this.hostRestoreNativeEvidence?.get(commandId) === proof) this.scheduleHostRestoreRetirement(commandId, proof)
    }
    const coldRetirement = this.files instanceof PhysicalLocalFiles && this.coldHostRestoreRetirement !== false
    this.coldHostRestoreRetirement = false
    for (const row of rows) {
      if (this.closed) return
      // Reuse this boot's first existing restore inventory. No periodic file
      // probes: a failed exact retirement keeps its owner for a later cold run.
      if (coldRetirement && row.value.complete) try {
        await this.retirePhysicalRestoreDebug(row.key, row.value)
      } catch (error) { this.error(error, { hostRestorationCommandId: row.value.commandId, phase: 'debug-retirement' }) }
      if (this.safetyResolutionReady === false && row.value.safetyFaults?.some(fault => !this.safetyEpisodes.has(fault.id))) continue
      this.replaySafetyRestore(row.value)
      this.considerHostRestoreRetirement(row.value)
      if (row.value.complete) continue
      const { commandId, input, createdAt } = row.value
      let phase = 'targets'
      let activeTarget: string | undefined
      const report = async (error: unknown) => {
        if (phase !== 'targets') await this.safetyRestoreSettled(row.value, error)
        if (!onError) throw error
        onError(error, {
          hostRestorationCommandId: commandId, phase,
          ...(error instanceof Error ? { errorName: error.name } : {}),
          ...(error instanceof FilesOutcomeUnknownError ? { operationId: error.operationId } : {}),
          ...(activeTarget ? { activeTarget } : {}), targets: structuredClone(row.value.targets ?? [])
        })
      }
      try {
        if (!row.value.targets) {
          row.value.targets = [...this.roleRecords.values()].filter(record => !record.released && !record.stopped
            && (record.stopUnknown || record.stopIntent)).map(record => ({ identity: record.identity, sessionId: record.sessionId }))
          // Target ownership precedes native stop. Later polls must still arrange
          // continuation after that exact execution has become stopped.
          await this.updateSafetyRestoreRow<HostRestore>(row.key, commandId, current => ({
            ...current,
            targets: current.targets ?? row.value.targets
          }))
        }
        phase = 'publication'
        if (this.files instanceof PhysicalLocalFiles) await this.publishPhysicalHostRestoration(row)
        else await this.transactions.run('host-restore:' + commandId, { input, createdAt }, { reevaluate: true }, async snapshot => {
          const writes = new Map<string, string>()
          for (const task of await this.taskMetadata(snapshot)) {
            if (task.status !== 'running' || await this.manuallyCleared(task.taskId, snapshot)) continue
            for (const member of task.route === 'P' ? (task.members ?? [task.owner]).filter(member => this.config.primary || member === this.config.member) : []) {
              const status = await readMemberStatus(this.files, snapshot, paths.memberStatus(task.taskId, member))
              const inbox = await this.files.read(snapshot, paths.inbox(task.taskId, member))
              if (status?.state === 'complete' || !inbox?.length) continue
              writes.set(paths.state(member, task.taskId) + '/recovery', '')
              writes.set(paths.state(member, task.taskId) + '/Planner_Helper', '')
              writes.set(this.recoveryInputPath(task.taskId, member, 'Planner'), JSON.stringify({ ...input, at: createdAt, debugPath: row.value.debugPath ?? 'debug/' + createdAt.slice(0, 10) + '.md' }))
            }
            if (task.route === 'O' && task.owner === this.config.member) {
              writes.set(paths.state(task.owner, task.taskId) + '/recovery', '')
              writes.set(paths.state(task.owner, task.taskId) + '/Organizer_Helper', '')
              writes.set(this.recoveryInputPath(task.taskId, task.owner, 'Organizer'), JSON.stringify({ ...input, at: createdAt, debugPath: row.value.debugPath ?? 'debug/' + createdAt.slice(0, 10) + '.md' }))
            }
          }
          const debug = row.value.debugPath ?? 'debug/' + createdAt.slice(0, 10) + '.md'
          writes.set(debug, (await this.files.read(snapshot, debug) ?? '') + '\n' + JSON.stringify({ at: createdAt, mode: 'host-restoration', ...input, managers: [...writes.keys()] }) + '\n')
          return [...writes].map(([path, content]) => ({ path, content }))
        })
        const unresolved: Array<{ identity: WorkIdentity; sessionId: string; reason: string; jobs: string[] }> = []
        phase = 'continuations'
        let targetFailed = false
        for (const target of row.value.targets) {
          if (this.closed) return
          if (target.complete) continue
          activeTarget = target.identity.executionId
          const pending = (record: RoleRecord | undefined, reason: string) => unresolved.push({
            identity: target.identity,
            sessionId: target.sessionId, reason, jobs: record?.stopUnknown?.jobs ?? record?.stopIntent?.jobs ?? []
          })
          if (this.workOperations?.has(target.identity.workId)) {
            pending(this.roleRecords.get(target.identity.workId), 'This execution still owns an in-progress operation.')
            continue
          }
          try {
            await this.serialWork(target.identity.workId, async () => {
              if (this.closed) return
              let record = this.roleRecords.get(target.identity.workId)
              if (!record || record.released || record.identity.executionId !== target.identity.executionId) {
                target.outcome = record?.released ? 'released' : 'superseded'
                target.complete = true
                await this.updateSafetyRestoreRow<HostRestore>(row.key, commandId, (current) => ({
                  ...current,
                  targets: (current.targets ?? row.value.targets)!.map((saved) => saved.complete ? saved : row.value.targets!.find(value => value.identity.executionId === saved.identity.executionId && value.sessionId === saved.sessionId) ?? saved)
                }));
                return;
              }
              if (!this.trackedStop(record)) {
                pending(record, record.stopUnknown?.reason ?? 'Native stop confirmation is pending.')
                return
              }
              record = this.roleRecords.get(target.identity.workId)
              if (!record || record.identity.executionId !== target.identity.executionId || !record.stopped) {
                pending(record, 'The exact stopped execution changed before continuation could be checked.')
                return
              }
              if (await this.controls.execution(record.identity)) target.outcome = 'user-stopped'
              else {
                await this.publishOwnerRecovery('host-restore-owner:' + commandId + ':' + target.identity.executionId, record)
                if (this.closed) return
                const continuation = await this.arrangeNativeContinuation(record, { ...input, facts: input.facts }, undefined,
                  'host-restored:' + commandId + ':' + target.identity.executionId)
                target.outcome = continuation ? 'arranged' : 'no-continuation'
              }
              target.complete = true
              await this.updateSafetyRestoreRow<HostRestore>(row.key, commandId, (current) => ({
                ...current,
                targets: (current.targets ?? row.value.targets)!.map((saved) => saved.complete ? saved : row.value.targets!.find(value => value.identity.executionId === saved.identity.executionId && value.sessionId === saved.sessionId) ?? saved)
              }));
            });
            if (this.closed) return
          } catch (error) {
            targetFailed = true
            await report(error)
          }
        }
        phase = 'settlement'
        activeTarget = undefined
        if (unresolved.length) {
          await this.updateSafetyRestoreRow<HostRestore>(row.key, commandId, current => ({ ...current, unresolved }))
          if (row.value.safetyFaultIds?.length) await this.safetyRestoreSettled(row.value, new Error('Native restoration still has unconfirmed producers.'))
          else await this.wake({ id: 'host-restoration-unresolved:' + commandId + ':' + hash(JSON.stringify(unresolved)), role: 'Helper', reason: 'helper', sources: [], context: { hostRestoration: 'unconfirmed', unresolved } })
          continue
        }
        if (targetFailed) continue
        const completed = await this.updateSafetyRestoreRow<HostRestore>(row.key, row.value.commandId, (current) => ({ ...current, complete: true, ...this.environment.safetyDisplayOwner?.() ? { safetyDisplayOwner: this.environment.safetyDisplayOwner() } : {} }));
        await this.safetyRestoreSettled(completed)
        this.considerHostRestoreRetirement(completed)
        this.environment.resolved?.({ hostRestorationCommandId: commandId })
        this.environment.restored?.()
      } catch (error) {
        await report(error)
      }
    }
  }
  private startRestoration(round?: FilesReadRound): void {
    if (this.closed || this.restoreScanning) return
    void this.restorePending(false, round).catch(error => this.error(error))
  }
  private restorePending(waitForSettlement = true, round?: FilesReadRound): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (!this.restoreScanning) {
      const scan = Promise.resolve().then(async () => {
        if (this.closed) return
        if (!this.hostRestoring) {
          const host = this.processHostRestores((error, context) => this.error(error, context), round)
          this.hostRestoring = host
          void host.catch(error => this.error(error)).finally(() => { if (this.hostRestoring === host) this.hostRestoring = undefined })
        }
        await this.processRestores(false, round)
      })
      this.restoreScanning = scan
      void scan.finally(() => { if (this.restoreScanning === scan) this.restoreScanning = undefined }).catch(() => { })
      const settled = scan.then(() => this.settleOperations([
        ...(this.hostRestoring ? [this.hostRestoring] : []), ...(this.restoreOperations?.values() ?? []),
      ], 'Native restorations failed'))
      this.restoring = settled
      void settled.finally(() => { if (this.restoring === settled) this.restoring = undefined }).catch(() => { })
    }
    return waitForSettlement ? this.restoring! : this.restoreScanning!;
  }
  private startTargetedAdmission(wakeId: string, helperOnly = false): void {
    if (this.closed || this.targetedPumps.has(wakeId)) return
    const operation = Promise.resolve().then(() => { if (!this.closed) return this.runQueue(helperOnly, wakeId) })
    this.targetedPumps.set(wakeId, operation)
    void operation.catch(error => this.error(error)).finally(() => {
      if (this.targetedPumps.get(wakeId) === operation) this.targetedPumps.delete(wakeId)
    })
  }
  private async restoreUnadmittedWake(row: { key: string; value: RoleRestore }, original: WakeRecord): Promise<void> {
    const { input, commandId } = row.value, workId = this.requestKey(original.request)
    if (row.value.continuationId) {
      const continuation = await this.records.get<WakeRecord>(this.prefix + 'wakes/' + hash(row.value.continuationId))
      const current = await this.records.get<WakeRecord>(this.prefix + 'wakes/' + hash(original.request.id))
      if (continuation?.delivered && current?.delivered) {
        await this.completeRestore(row, 'arranged')
      } else if (continuation) this.startTargetedAdmission(continuation.request.id)
      return
    }
    if (this.workOperations?.has(workId)) return
    let launch: string | undefined
    await this.serialWork(workId, async () => {
      if (this.closed) return
      const current = await this.records.get<WakeRecord>(this.prefix + 'wakes/' + hash(original.request.id))
      if (!current) throw new Error('The exact pending Host wake is unavailable.')
      if (current.delivered) { await this.completeRestore(row, 'already-admitted'); return }
      if (current.admission?.reportedAt === undefined) throw new Error('Wake restoration requires its recorded admission-timeout responsibility.')
      const record = this.roleRecords.get(workId)
      if (record && (!record.stopped || this.active(record))) return
      if (['Planner', 'Worker', 'Organizer'].includes(current.request.role) && await this.controls.taskHeld(current.request.taskId, current.request.lifecycleId)) return;
      if (this.closed) return
      const debugPath = await this.recordRestoreDebug(row, input)
      const { taskId, role } = current.request
      if (taskId && ['Planner', 'Worker', 'Organizer', 'Recorder'].includes(role)) {
        if (this.files instanceof PhysicalLocalFiles) {
          if (role === 'Planner' || role === 'Worker') await this.publishPhysicalMemberRecovery('restore-wake-marker:' + commandId,
            { taskId, member: this.config.member, lifecycleId: current.request.lifecycleId })
          else await this.publishPhysicalOwnerRecovery('restore-wake-marker:' + commandId, taskId)
        } else await this.transactions.run('restore-wake-marker:' + commandId, { taskId, role }, { reevaluate: true, taskOwner: this.taskCommandOwner(current.request) }, async snapshot => {
          if (await this.manuallyCleared(taskId, snapshot) || await readTaskCleanupRecord(this.files, snapshot, taskId)) return []
          const task = await readJson<TaskMetadata>(this.files, snapshot, paths.task(taskId))
          if (!task) return []
          const member = role === 'Planner' || role === 'Worker' ? this.config.member : task.owner
          if (role === 'Planner' || role === 'Worker') {
            const status = await readMemberStatus(this.files, snapshot, paths.memberStatus(taskId, member))
            const inbox = await this.files.read(snapshot, paths.inbox(taskId, member))
            if (task.status !== 'running' || status?.state === 'complete' || !inbox?.length) return []
          }
          return [{ path: paths.state(member, taskId) + '/recovery', content: '' }]
        })
      }
      if (this.closed) return
      const continuationId = 'restore-wake:' + commandId
      await this.wake({
        ...current.request, id: continuationId, reason: 'startup-recovery',
        context: { ...current.request.context, admissionRestoration: input, originalWakeId: current.request.id, ...(debugPath ? { debugPath } : {}) }
      },
        { replacesUnadmittedWake: current.request.id })
      await this.updateSafetyRestoreRow<RoleRestore>(row.key, commandId, current => ({ ...current, continuationId }))
      launch = continuationId
    });
    if (launch) this.startTargetedAdmission(launch)
  }
  private async processRestores(waitForSettlement = true, round?: FilesReadRound): Promise<void> {
    const owned = this.restoreOperations ??= new Map<string, Promise<void>>()
    const operations: Promise<void>[] = []
    const rows = await listAuthorityInRound<RoleRestore>(this.records, this.prefix + 'restores/', round)
    const coldRetirement = this.files instanceof PhysicalLocalFiles && this.coldRoleRestoreRetirement !== false
    this.coldRoleRestoreRetirement = false
    for (const row of rows) {
      if (this.closed) break
      if (coldRetirement && row.value.complete) try {
        if (await this.retirePhysicalRestoreDebug(row.key, row.value)) {
          const owner = this.restoreTaskOwner(row.value)
          if (owner && await this.taskRuntimeReleased(owner)) await this.deleteRuntimeRecord(row.key, row.value)
        }
      } catch (error) { this.error(error, { restoreCommandId: row.value.commandId, phase: 'debug-retirement' }) }
      if (this.safetyResolutionReady === false && row.value.safetyFaults?.some(fault => !this.safetyEpisodes.has(fault.id))) continue
      this.replaySafetyRestore(row.value)
      if (row.value.complete) continue
      const target = row.value.resolvedTarget ?? row.value.input.target
      const wakeId = row.value.admissionWakeId ?? row.value.input.wakeId
      const wake = !target && wakeId ? await this.records.get<WakeRecord>(this.prefix + 'wakes/' + hash(wakeId)) : undefined
      const workId = target?.workId ?? (wake && this.requestKey(wake.request)) ?? row.key
      if (owned.has(workId)) {
        if (waitForSettlement) operations.push(owned.get(workId)!);
        continue;
      }
      const operation = Promise.resolve().then(async () => {
        if (this.closed) return
        const current = await this.records.get<RoleRestore>(row.key)
        if (!current || current.complete || this.closed) return
        try {
          await this.processRestore({ key: row.key, value: current })
          if (current.safetyFaultIds?.length) {
            if (current.input.target) {
              const stop = this.stopOperations?.get(JSON.stringify([current.input.target.workId, current.input.target.executionId]))
              if (stop) void stop.promise.then(async () => {
                if (stop.result?.status === 'unconfirmed') await this.safetyRestoreSettled(current, new Error(stop.result.reason))
                else if (stop.failure) await this.safetyRestoreSettled(current, stop.failure)
              }).catch(error => this.environment.error(error))
            }
          }
        } catch (error) { if (!(error instanceof FilesConflictError)) { await this.safetyRestoreSettled(current, error); throw error } }
      })
      owned.set(workId, operation)
      operations.push(operation)
      void operation.finally(() => { if (owned.get(workId) === operation) owned.delete(workId) }).catch(() => { })
      if (!waitForSettlement) void operation.catch(error => this.error(error, { restoreCommandId: row.value.commandId, workId }))
    }
    if (waitForSettlement) await this.settleOperations(operations, 'Native restorations failed')
  }
  private async releaseRestoredExecution(row: { key: string; value: RoleRestore }): Promise<void> {
    const target = row.value.input.target;
    if (!target || row.value.input.wakeId) throw new Error("Internal release requires an exact execution target.");
    if (!["Planner", "Worker", "Organizer", "Recorder"].includes(target.role)) throw new Error("Internal release requires a Task execution.");
    await this.serialWork(target.workId, async () => {
      const matches = (record: RoleRecord | undefined): record is RoleRecord => !!record && (["workId", "executionId", "role", "taskId", "member", "workerId", "lifecycleId"] as const).every((key) => record.identity[key] === target[key]);
      let record = this.roleRecords.get(target.workId);
      if (!matches(record)) {
        await this.completeRestore(row, "superseded");
        return;
      }
      const taskId = await this.currentTask(record);
      if (!taskId) throw new Error("Internal release requires a known Task association.");
      const eligible = () => withSnapshot(this.files, async (snapshot) => {
        const task = await readJson<TaskMetadata>(this.files, snapshot, paths.task(taskId));
        if (task && taskLifecycle(task) === taskLifecycle(target) && !isTerminalTask(task)) throw new Error("A running Task execution cannot be internally released.");
      });
      await eligible();
      await this.recordRestoreDebug(row)
      const result = await this.stopOwnedRecord(record);
      if (result.status !== "stopped") throw new Error(result.status === "unconfirmed" ? result.reason : "Execution ownership changed during internal release.");
      record = this.roleRecords.get(target.workId);
      if (!matches(record)) {
        await this.completeRestore(row, "superseded");
        return;
      }
      await eligible();
      await this.observations.unbind(target.workId, target.executionId);
      const wakeIds = new Set([record.delivery?.request.id, record.lastWake?.id].filter(Boolean));
      for (const wake of await this.records.list<WakeRecord>(this.prefix + "wakes/")) {
        if (wake.value.admission?.executionId !== target.executionId && !wakeIds.has(wake.value.request.id)) continue;
        await this.updateWake(wake.key, (current) => current && (current.admission?.executionId === target.executionId || wakeIds.has(current.request.id)) ? this.releasedWake(current) : current);
      }
      await this.saveRole({ ...record, stopped: true, released: true, stopUnknown: void 0 });
      if (matches(this.roleRecords.get(target.workId))) this.roleRecords.delete(target.workId);
      await this.completeRestore(row, "terminal");
      this.environment.changed?.();
    });
  }
  private async recoverMissingTask(row: { key: string; value: RoleRestore }): Promise<boolean> {
    const recovery = row.value.input.taskRecovery, originalTarget = row.value.input.target;
    if (!recovery || !originalTarget?.taskId || row.value.input.wakeId || row.value.input.disposition)
      throw new Error("Task recovery requires one exact Task execution target and cannot be combined with release.");
    if (!["Planner", "Worker", "Organizer"].includes(originalTarget.role)) throw new Error("Task recovery requires an original business execution.");
    return this.serialWork(originalTarget.workId, async () => {
      const target = row.value.resolvedTarget ?? originalTarget;
      let record = this.roleRecords.get(target.workId) ?? await this.records.get<RoleRecord>(this.prefix + "roles/" + hash(target.workId));
      const matches = (identity: WorkIdentity, expected: WorkIdentity) => (["workId", "executionId", "role", "taskId", "member", "workerId"] as const).every((key) => identity[key] === expected[key]) && taskLifecycle(identity) === taskLifecycle(expected);
      if (!record || !matches(record.identity, target) && !matches(record.identity, originalTarget))
        throw new Error("Task recovery target no longer owns the retained execution; inspect its current owner.");
      if (!this.roleRecords.has(record.identity.workId)) {
        this.roleRecords.set(record.identity.workId, record);
        (this.roleBases ??= /* @__PURE__ */ new Map()).set(record.identity.workId, structuredClone(record));
      }
      if (!this.trackedStop(record)) return false;
      let retainedCwd: string | undefined;
      {
        const live = this.ctx.sessions?.get(SessionId(record.sessionId));
        retainedCwd = live?.header.cwd;
        const persistence = this.ctx.get("sessionPersistence");
        if (!retainedCwd && persistence && await persistence.stat(SessionId(record.sessionId))) {
          const handle = await persistence.open(SessionId(record.sessionId), "read");
          try {
            retainedCwd = handle.header.cwd;
          } finally {
            await handle.close();
          }
        }
      }
      const taskId = originalTarget.taskId!, newLifecycleId = hash("restore-task:" + row.value.commandId).slice(0, 24);
      let physicalPlan: PhysicalRecoveredTaskPlan | undefined
      const buildRecovery = async (snapshot: FilesSnapshot): Promise<FileChange[]> => {
        const roleKey = this.prefix + "roles/" + hash(originalTarget.workId);
        const owner = this.records instanceof GitAuthorityStore ? await this.records.getAt<RoleRecord>(snapshot, roleKey) : await this.records.get<RoleRecord>(roleKey);
        if (!owner || !owner.stopped || !matches(owner.identity, originalTarget)) throw new Error("The retained execution authority changed before Task reconstruction.");
        const previous = await readJson<TaskMetadata>(this.files, snapshot, paths.task(taskId));
        if (previous && taskLifecycle(previous) !== taskLifecycle(originalTarget)) throw new Error("Task already belongs to a different continuation lifecycle.");
        let retainedMetadata: TaskMetadata | undefined;
        for (const path of [...new Set(recovery.recordPaths)]) {
          const text = await this.files.read(snapshot, path);
          if (!text) continue;
          let candidate;
          try {
            candidate = JSON.parse(text);
          } catch {
            continue;
          }
          if (!candidate || candidate.version !== 1 || candidate.taskId !== taskId || !candidate.workspaceFolder || candidate.parent && !candidate.workspaceRootTaskId) continue;
          if (taskLifecycle(candidate) !== taskLifecycle(originalTarget)) continue;
          if (candidate.owner !== recovery.owner || candidate.route !== recovery.route) throw new Error("Retained metadata evidence conflicts with the selected Task owner or route.");
          if (retainedMetadata && (retainedMetadata.workspaceFolder !== candidate.workspaceFolder || retainedMetadata.workspaceRootTaskId !== candidate.workspaceRootTaskId)) throw new Error("Retained metadata names conflicting original workspaces. Inspect and select the applicable original record.");
          retainedMetadata = candidate;
        }
        // Recovery already names exact retained records. Resolve their original
        // archive location before reading terminal facts when metadata is missing.
        const retainedIdentity = previous ?? retainedMetadata;
        if (retainedIdentity?.status === 'complete') throw new Error('A completed Task cannot resume the same Task ID; submit a new Task for a correction or new requirement.');
        // Explicit restoration already read and matched this retained metadata.
        // Keep its original facts when the current Task file is absent; ordinary
        // runtime/Cleaner reads never fall back to long-term material.
        const archiveState = this.files instanceof GitFiles && !previous && retainedMetadata
          ? taskMetadataRuntimeState(retainedMetadata)
          : retainedIdentity ? await readTaskArchiveState(this.files, snapshot, retainedIdentity) : undefined;
        const seal = taskArchiveHostFacts(archiveState, originalTarget, this.archiveHostKey());
        const cleanup = taskArchiveCleanup(archiveState, originalTarget);
        const reopening = !!retainedIdentity && isTerminalTask(retainedIdentity) || !!seal || cleanup !== undefined || owner.released
          || this.loop.hasTerminalTask(taskId, originalTarget.lifecycleId) || this.observedTerminalTasks.has(taskLifecycleKey({ taskId, lifecycleId: originalTarget.lifecycleId }));
        const lifecycleId = reopening ? newLifecycleId : originalTarget.lifecycleId;
        const rootTaskId = retainedMetadata?.workspaceRootTaskId ?? (retainedMetadata ? taskId : void 0) ?? record.taskWorkspace?.rootTaskId ?? previous?.workspaceRootTaskId ?? taskId;
        const workspaceRoot = this.workspaces.rootFor(rootTaskId);
        const sessionNamesRoot = retainedCwd !== void 0 && isAbsolute(retainedCwd) && isAbsolute(workspaceRoot) && resolve(retainedCwd) === resolve(workspaceRoot);
        const sessionLocation = retainedCwd && !sessionNamesRoot ? await this.workspaces.retained(taskId, retainedCwd, rootTaskId) : void 0;
        const recordedLocation = record.taskWorkspace ? await this.workspaces.retained(taskId, record.taskWorkspace.directory, record.taskWorkspace.rootTaskId) : void 0;
        if (retainedCwd && !sessionNamesRoot && !sessionLocation || record.taskWorkspace && !recordedLocation)
          throw new Error("The original native workspace is missing at its retained absolute location. Do not substitute a same-named directory under the current root.");
        if (sessionLocation && recordedLocation && sessionLocation.directory !== recordedLocation.directory)
          throw new Error("Retained absolute execution workspaces conflict. Inspect the original session and role evidence before recovery.");
        let retainedWorkspace = sessionLocation ?? recordedLocation;
        if (retainedWorkspace && retainedMetadata && (retainedWorkspace.folder !== retainedMetadata.workspaceFolder || retainedWorkspace.rootTaskId !== (retainedMetadata.workspaceRootTaskId ?? taskId)))
          throw new Error("Retained metadata conflicts with the original execution absolute workspace.");
        if (!retainedWorkspace && sessionNamesRoot) {
          const priorLocation = !retainedMetadata && !previous?.workspaceRootTaskId && previous?.parent ? await this.workspaces.locate(taskId, snapshot) : void 0;
          const folder = retainedMetadata?.workspaceFolder ?? priorLocation?.folder ?? previous?.workspaceFolder ?? (previous ? taskWorkspaceFolder(taskSourceName(previous.sourcePath), taskId) : void 0);
          if (folder) retainedWorkspace = await this.workspaces.retained(taskId, join(retainedCwd!, folder), priorLocation?.rootTaskId ?? rootTaskId);
        }
        if (!retainedWorkspace) throw new Error("The original native workspace has no verified absolute execution/root evidence. Inspect the original session or retained role location; relative metadata and the current configured root alone are insufficient.");
        const workspaceFolder = retainedWorkspace.folder;
        const materialHandoff = "Continue in the verified original native workspace without copying, initializing over, or overwriting existing material: " + retainedWorkspace.directory + ". Old native processes or unupgraded clients may still have direct filesystem access; lifecycle checks do not revoke that access. Inspect existing results and report conflicts before writing.";
        const sourcePath = "tasks/recovered_" + taskId + (lifecycleId ? "_" + lifecycleId : "") + "_" + recovery.route + ".md";
        if (previous?.status !== "running" && await this.files.read(snapshot, sourcePath) !== void 0) throw new Error("The recovery source path already exists; preserve the conflicting recovery.");
        paths.state(recovery.owner, taskId);
        if (previous && (previous.owner !== recovery.owner || previous.route !== recovery.route)) throw new Error("Recovery route and owner conflict with the retained Task metadata.");
        if (originalTarget.role === "Organizer" && (recovery.route !== "O" || recovery.owner !== this.config.member)) throw new Error("Retained Organizer ownership does not match the recovery.");
        if (!recovery.recordPaths.length || !recovery.continuation.trim()) throw new Error("Task recovery needs actual retained records and an explanation of remaining work.");
        const archiveIdentity: Pick<TaskMetadata, 'taskId' | 'sourcePath' | 'archiveFolder' | 'children'> = previous ?? retainedMetadata ?? { taskId, sourcePath }
        const archivePath = paths.archive(archiveIdentity)
        const references = [...new Set(recovery.recordPaths)];
        for (const path of references) {
          const text = await this.files.read(snapshot, path);
          if (!text?.trim()) throw new Error("Recovery record is missing or empty: " + path);
          if (!path.startsWith(paths.run(taskId) + "/") && !taskArchiveOwnsPath(archiveIdentity, path) && taskIdentity(text) !== taskId)
            throw new Error("Recovery record is not associated with the selected Task: " + path);
        }
        if (previous?.status === "running") {
          const changes = [];
          if (previous.workspaceFolder !== workspaceFolder || (previous.workspaceRootTaskId ?? taskId) !== retainedWorkspace.rootTaskId) changes.push({ path: paths.task(taskId), content: encodeJson({ ...previous, workspaceFolder, ...retainedWorkspace.rootTaskId !== taskId ? { workspaceRootTaskId: retainedWorkspace.rootTaskId } : { workspaceRootTaskId: void 0 } }) });
          const statusPath2 = paths.memberStatus(taskId, this.config.member), inboxPath = paths.inbox(taskId, this.config.member);
          if (await this.files.read(snapshot, statusPath2) === void 0) changes.push({ path: statusPath2, content: encodeJson({ state: "running" }) });
          const handoff = "Recovery from retained current records, not a fabricated original instruction.\n" + recovery.continuation + "\n" + materialHandoff + "\nRetained records:\n" + references.join("\n");
          if (await this.files.read(snapshot, inboxPath) === void 0) changes.push({ path: inboxPath, content: handoff });
          if (await this.files.read(snapshot, previous.sourcePath) === void 0) changes.push({ path: previous.sourcePath, content: "Task ID: " + taskId + "\n" + handoff });
          if (await this.files.read(snapshot, paths.cache(taskId)) === void 0) changes.push({ path: paths.cache(taskId), content: encodeJson({ version: 1, links: [previous.sourcePath, paths.task(taskId), ...references].map((path) => ({ kind: "file", path: path })) }) });
          if (this.files instanceof PhysicalLocalFiles) physicalPlan = {
            task: { ...previous, workspaceFolder, ...retainedWorkspace.rootTaskId !== taskId ? { workspaceRootTaskId: retainedWorkspace.rootTaskId } : { workspaceRootTaskId: undefined } },
            ...(await this.files.fileInfo(statusPath2) ? {} : { memberStatus: { path: statusPath2, text: encodeJson({ state: 'running' }), fillOnly: true } }),
            ...(await this.files.fileInfo(inboxPath) ? {} : { inbox: { path: inboxPath, text: handoff, fillOnly: true } }),
            ...(await this.files.fileInfo(previous.sourcePath) ? {} : { source: { path: previous.sourcePath, text: 'Task ID: ' + taskId + '\n' + handoff, fillOnly: true } }),
            ...(await this.files.fileInfo(paths.cache(taskId)) ? {} : { cache: { path: paths.cache(taskId), text: encodeJson({ version: 1, links: [previous.sourcePath, paths.task(taskId), ...references].map(path => ({ kind: 'file', path })) }), fillOnly: true } }),
          }
          return changes;
        }
        const changes: FileChange[] = [], archived = new Map<string, string>();
        const physicalCopies: Array<{ source: string; target: string }> = []
        const physicalSignals: Array<{ path: string; version: string }> = []
        let physicalHistory: PhysicalRecoveredTaskPlan['history']
        const history = archivePath + "/lifecycles/" + (originalTarget.lifecycleId || "original") + "/" + hash(row.value.commandId).slice(0, 24);
        if (reopening) {
          const pathsToPreserve = /* @__PURE__ */ new Set([paths.task(taskId), paths.cache(taskId), foregroundTaskSignal(taskId), ...references, ...previous ? [previous.sourcePath] : []]);
          if (await this.files.read(snapshot, foregroundTaskSignal(taskId)) !== void 0) changes.push({ path: foregroundTaskSignal(taskId), content: null });
          if (this.files instanceof PhysicalLocalFiles) {
            const original = await this.files.fileInfo(foregroundTaskSignal(taskId))
            if (original) physicalSignals.push({ path: foregroundTaskSignal(taskId), version: original.version })
          }
          for (const root of [paths.run(taskId) + "/", archivePath + "/"]) for (const file of await this.files.list(snapshot, root, root === archivePath + '/' ? taskArchiveSelection(archiveIdentity) : undefined))
            if (file.path !== taskArchiveStatePath(archiveIdentity) && (root !== archivePath + '/' || taskArchiveOwnsPath(archiveIdentity, file.path)) && !file.path.startsWith(archivePath + "/lifecycles/")) pathsToPreserve.add(file.path);
          for (const member of /* @__PURE__ */ new Set([...previous?.members ?? [], recovery.owner, this.config.member, ...originalTarget.member ? [originalTarget.member] : []])) {
            for (const file of await this.files.list(snapshot, paths.state(member, taskId) + "/")) {
              pathsToPreserve.add(file.path);
              changes.push({ path: file.path, content: null });
              if (this.files instanceof PhysicalLocalFiles) physicalSignals.push({ path: file.path, version: file.version })
            }
          }
          const commandRoot = paths.run(taskId) + '/.command-receipts/';
          for (const path of pathsToPreserve) {
            // Program receipts remain their original operation authority, not
            // archived Task material (including nested artifact-result receipts).
            if (path.startsWith(commandRoot) || this.files instanceof PhysicalLocalFiles && path.startsWith(paths.run(taskId) + '/.recovery/')) continue;
            if (this.files instanceof PhysicalLocalFiles) {
              if (!await this.files.fileInfo(path)) continue
              const destination = history + '/files/' + path
              physicalCopies.push({ source: path, target: destination })
              archived.set(path, destination)
              continue
            }
            const bytes = await this.files.readBytes(snapshot, path);
            if (bytes === void 0) continue;
            const destination = history + "/files/" + path, existing = await this.files.readBytes(snapshot, destination);
            if (existing && hash(Buffer.from(existing).toString("base64")) !== hash(Buffer.from(bytes).toString("base64"))) throw new Error("Lifecycle history already differs; preserve the original snapshot.");
            if (!existing) changes.push({ path: destination, bytes });
            archived.set(path, destination);
          }
          changes.push(
            { path: history + "/execution.json", content: encodeJson(owner) },
            { path: history + "/recovery.json", content: encodeJson({ taskId, fromLifecycleId: taskLifecycle(originalTarget), lifecycleId, input: row.value.input, mappings: Object.fromEntries(archived), oldSeal: seal }) }
          );
          if (this.files instanceof PhysicalLocalFiles) physicalHistory = { path: history,
            execution: encodeJson(owner), recovery: encodeJson({ taskId, fromLifecycleId: taskLifecycle(originalTarget), lifecycleId, input: row.value.input, mappings: Object.fromEntries(archived), oldSeal: seal }),
            copies: physicalCopies, signals: physicalSignals }
          // Prior lifecycle facts remain in the same compact program state.
          // The new lifecycle selects its own entry, without deleting peer Hosts.
        }
        const selectedRecords = references.map((path) => archived.get(path) ?? path);
        const members = [.../* @__PURE__ */ new Set([recovery.owner, ...originalTarget.member ? [originalTarget.member] : [], this.config.member])];
        const metadata: TaskMetadata = {
          version: 1,
          taskId,
          ...lifecycleId ? { lifecycleId } : {},
          ...(this.files instanceof GitFiles && archiveState ? { runtimeState: { lifecycles: archiveState.lifecycles } } : {}),
          route: recovery.route,
          owner: recovery.owner,
          status: "running",
          sourcePath,
          archiveFolder: archiveIdentity.archiveFolder ?? archivePath.slice('archives/'.length),
          members,
          workspaceFolder,
          ...retainedWorkspace.rootTaskId !== taskId ? { workspaceRootTaskId: retainedWorkspace.rootTaskId } : {},
          ...previous?.workspaceResults && retainedWorkspace ? { workspaceResults: previous.workspaceResults } : {},
          ...previous?.resultPaths ? { resultPaths: previous.resultPaths.map((path) => archived.get(path) ?? path) } : {}
        };
        const source = "Task ID: " + taskId + "\n\n# Recovery from retained current records\nThis is a reconstruction authorized for continuation, not the original request. Exact original instructions and relationships may be unavailable. Previous Task relationships and native workspace results are historical references, not automatically reactivated assignments. The verified original workspace is reconnected in place; preserve existing native files, inspect their current state and do not overwrite conflicts.\n\n" + recovery.continuation + "\n\nNative material handoff:\n" + materialHandoff + "\n\nRetained records:\n" + selectedRecords.map((path) => "- " + path).join("\n") + "\n" + (reopening ? "\nPrior lifecycle history: " + history + "/recovery.json\n" : "");
        changes.push({ path: paths.task(taskId), content: encodeJson(metadata) }, { path: sourcePath, content: source });
        const inbox = paths.inbox(taskId, this.config.member), priorInbox = await this.files.read(snapshot, inbox);
        if (priorInbox === void 0 || reopening) changes.push({ path: inbox, content: (priorInbox ? priorInbox + "\n\n" : "") + source });
        const statusPath = paths.memberStatus(taskId, this.config.member);
        if (reopening || await this.files.read(snapshot, statusPath) === void 0) changes.push({ path: statusPath, content: encodeJson({ state: "running" }) });
        const cachePath = paths.cache(taskId), cache = await readJson<{ version: number; links: Array<{ kind: string; path: string }> }>(this.files, snapshot, cachePath);
        if (cache && (cache.version !== 1 || !Array.isArray(cache.links))) throw new Error("Existing Recorder Cache is malformed; preserve it for diagnosis.");
        const links = [...cache?.links ?? []];
        for (const path of [sourcePath, paths.task(taskId), ...selectedRecords]) if (!links.some((link) => link.path === path)) links.push({ kind: "file", path: path });
        changes.push({ path: cachePath, content: encodeJson({ ...cache, version: 1, links }) });
        if (this.files instanceof PhysicalLocalFiles) physicalPlan = {
          task: metadata, source: { path: sourcePath, text: source },
          ...(priorInbox === undefined || reopening ? { inbox: { path: inbox, text: (priorInbox ? priorInbox + '\n\n' : '') + source } } : {}),
          ...(reopening || await this.files.fileInfo(statusPath) === undefined ? { memberStatus: { path: statusPath, text: encodeJson({ state: 'running' }) } } : {}),
          cache: { path: cachePath, text: encodeJson({ ...cache, version: 1, links }) },
          ...(physicalHistory ? { history: physicalHistory } : {}),
        }
        return changes;
      }
      if (this.files instanceof PhysicalLocalFiles) {
        await reconstructPhysicalTask(this.files, taskId, row.value.commandId, row.value.input, async snapshot => {
          await buildRecovery(snapshot)
          if (!physicalPlan) throw new Error('Task recovery did not produce its specific reconstruction plan.')
          return physicalPlan
        }, () => {
          const current = this.roleRecords.get(target.workId)
          if (this.closed || !current?.stopped || !matches(current.identity, target) && !matches(current.identity, originalTarget))
            throw new Error('The retained execution no longer owns this stopped Task reconstruction.')
        })
      } else await this.transactions.run('restore-task:' + row.value.commandId, row.value.input,
        { reevaluate: true, preserveInputs: !(this.files instanceof GitFiles) }, buildRecovery)
      const restored = await withSnapshot(this.files, (snapshot) => readJson<TaskMetadata>(this.files, snapshot, paths.task(taskId)));
      if (!restored || restored.status !== "running") throw new Error("Recovered Task is no longer running; inspect its current state.");
      this.rememberTerminalTask(restored);
      if (taskLifecycle(record.identity) !== taskLifecycle(restored)) {
        const rebound = { ...originalTarget, executionId: "recovered-" + hash(row.value.commandId + originalTarget.workId), lifecycleId: restored.lifecycleId };
        row.value.resolvedTarget = rebound;
        await this.updateSafetyRestoreRow(row.key, row.value.commandId, (current) => ({ ...current, resolvedTarget: rebound }));
        const replacement = {
          identity: rebound,
          sessionId: "dss-" + hash(row.value.commandId).slice(0, 32),
          generation: record.generation + 1,
          stopped: true,
          ...record.lastWake ? { lastWake: { ...record.lastWake, lifecycleId: restored.lifecycleId } } : {},
          ...record.delivery ? { delivery: { ...record.delivery, request: { ...record.delivery.request, lifecycleId: restored.lifecycleId } } } : {}
        };
        await this.saveRole(replacement);
      }
      return true;
    });
  }
  private async processRestore(row: { key: string; value: RoleRestore }): Promise<void> {
    if (row.value.input.taskRecovery && !await this.recoverMissingTask(row)) return;
    if (row.value.input.disposition === "release") return this.releaseRestoredExecution(row);
    const admissionId = row.value.admissionWakeId ?? row.value.input.wakeId
    const retainedAdmissionStop = (record: RoleRecord | undefined) => {
      const target = row.value.resolvedTarget ?? row.value.input.target;
      return !!admissionId && !!target && record?.delivery?.request.id === admissionId && record.identity.workId === target.workId && record.identity.executionId === target.executionId && taskLifecycle(record.identity) === taskLifecycle(target) && !!(record.stopped || record.stopIntent || record.stopUnknown);
    };
    const confirmedAdmission = (record: RoleRecord | undefined) => !!admissionId && !row.value.continuationId && record?.delivery?.request.id === admissionId && record.delivery.confirmed && !retainedAdmissionStop(record);
    const completeAdmission = async (delivered = false) => {
      if (!delivered) await this.updateWake(this.prefix + 'wakes/' + hash(admissionId!), current => current ? { ...current, delivered: true, admission: undefined } : undefined)
      await this.completeRestore(row, 'already-admitted');
    };
    if (admissionId && !row.value.continuationId) {
      const original = await this.records.get<WakeRecord>(this.prefix + 'wakes/' + hash(admissionId))
      const owner = original && this.roleRecords.get(this.requestKey(original.request))
      if (original?.delivered && !retainedAdmissionStop(owner) || confirmedAdmission(owner)) {
        await completeAdmission(original?.delivered);
        return;
      }
    }
    if (!row.value.input.target && !row.value.resolvedTarget) {
      const wakeId = row.value.input.wakeId;
      const original = await this.records.get<WakeRecord>(this.prefix + 'wakes/' + hash(wakeId))
      if (!original) throw new Error('The requested Host wake does not exist.')
      if (original.delivered && !row.value.continuationId) {
        await this.completeRestore(row, 'already-admitted'); return
      }
      const current = this.roleRecords.get(this.requestKey(original.request))
      if (!row.value.continuationId && current && this.wakeAdmission(original)?.executionId === current.identity.executionId) {
        row.value.resolvedTarget = { ...current.identity }
        await this.updateSafetyRestoreRow<RoleRestore>(row.key, row.value.commandId, current => ({ ...current, resolvedTarget: row.value.resolvedTarget }))
      } else { await this.restoreUnadmittedWake(row, original); return }
    }
    const input: HelperRestoreInput & { target: WorkIdentity } = { ...row.value.input, target: (row.value.resolvedTarget ?? row.value.input.target)! } as HelperRestoreInput & { target: WorkIdentity };
    const busy = this.workOperations?.get(input.target.workId)
    if (busy) {
      const current = this.roleRecords.get(input.target.workId)
      if (!current || current.identity.executionId !== input.target.executionId) {
        if (row.value.safetyFaultIds?.length) await this.completeRestore(row, 'superseded')
        return
      }
      if (confirmedAdmission(current)) {
        await completeAdmission();
        return;
      }
      const cancellation = new DOMException('Helper is recovering this exact pending native admission.', 'AbortError')
      this.admissionCancellations.set(input.target.executionId, cancellation)
      try {
        const stopped = this.native.get(input.target.workId)
          ? await this.native.stop(input.target.workId, input.target.executionId)
          : await this.native.cancelOpening(input.target.workId, input.target.executionId, cancellation)
        if (stopped.status !== 'stopped') {
          if (stopped.status === 'unconfirmed') {
            await this.safetyRestoreSettled(row.value, new Error(stopped.reason))
            const latest = this.roleRecords.get(input.target.workId)
            if (latest?.identity.executionId === input.target.executionId && latest.stopUnknown?.reason !== stopped.reason) {
              await this.saveRole({ ...latest, stopUnknown: stopped })
              this.error(new Error(stopped.reason), { restoreCommandId: row.value.commandId, identity: latest.identity })
            }
          }
          return
        }
        await busy
        const settled = this.roleRecords.get(input.target.workId)
        if (this.closed) return
        if (settled?.identity.executionId === input.target.executionId) await this.saveRole({ ...settled, stopped: true })
      } finally { this.admissionCancellations.delete(input.target.executionId) }
    }
    if (this.closed) return
    await this.serialWork(input.target.workId, async () => {
      if (this.closed) return
      let record = this.roleRecords.get(input.target.workId)
      if (!record || record.identity.executionId !== input.target.executionId) { await this.completeRestore(row, 'superseded'); return }
      if (confirmedAdmission(record)) {
        await completeAdmission();
        return;
      }
      if (['Planner', 'Worker', 'Organizer', 'Recorder'].includes(record.identity.role) && await this.manuallyCleared(await this.currentTask(record))) { await this.completeRestore(row, 'superseded'); return }
      const date = row.value.createdAt.slice(0, 10)
      const debugPath = await this.recordRestoreDebug(row, input)
      record = this.roleRecords.get(input.target.workId)
      if (confirmedAdmission(record)) {
        await completeAdmission();
        return;
      }
      if (!record || record.identity.executionId !== input.target.executionId || !this.trackedStop(record)) return
      record = this.roleRecords.get(input.target.workId)
      if (!record || record.identity.executionId !== input.target.executionId || !record.stopped) return
      if (record.identity.taskId && record.identity.member && (record.identity.role === 'Planner' || record.identity.role === 'Worker')) {
        const taskId = record.identity.taskId, member = record.identity.member
        if (this.files instanceof PhysicalLocalFiles) await this.publishPhysicalMemberRecovery('restore-marker:' + row.value.commandId,
          { taskId, member, lifecycleId: record.identity.lifecycleId }, undefined,
          record.identity.role === 'Worker' ? paths.state(member, taskId) + '/Planner_Recovery_' + date + '_' + hash('restore:' + row.value.commandId) : undefined, debugPath)
        else await this.transactions.run('restore-marker:' + row.value.commandId, { taskId, member }, { reevaluate: true, taskOwner: this.taskCommandOwner(record.identity) }, async (checked) => {
          if (await this.manuallyCleared(taskId, checked)) return []
          const task = await readJson<TaskMetadata>(this.files, checked, paths.task(taskId))
          const status = await readMemberStatus(this.files, checked, paths.memberStatus(taskId, member))
          const inbox = await this.files.read(checked, paths.inbox(taskId, member))
          if (task?.status !== 'running' || status?.state === 'complete') return []
          return [
            ...(inbox?.length ? [{ path: paths.state(member, taskId) + '/recovery', content: '' }] : []),
            ...record.identity.role === 'Worker' ? [{ path: hostRecoverySignalPath(paths.state(member, taskId) + '/Planner_Recovery_' + date + '_' + hash('restore:' + row.value.commandId), debugPath!), content: '' }] : []
          ];
        });
      }
      const pending = (await this.records.list<WakeRecord>(this.prefix + 'wakes/')).find((wake) => !wake.value.delivered && this.requestKey(wake.value.request) === record.identity.workId && !wake.value.recovery);
      const taskId = await this.currentTask(record) ?? pending?.value.request.taskId
      if (taskId && (record.identity.role === 'Organizer' || record.identity.role === 'Recorder')) {
        if (this.files instanceof PhysicalLocalFiles) await this.publishOwnerRecovery('restore-role-marker:' + row.value.commandId, record)
        else await this.transactions.run('restore-role-marker:' + row.value.commandId, { taskId, role: record.identity.role }, { reevaluate: true, taskOwner: await this.selectedTaskCommandOwner(taskId, record.identity) }, async snapshot => {
          return this.ownerRecoveryChanges(snapshot, taskId)
        })
      }
      const neverSent = pending && pending.value.admission?.executionId === record.identity.executionId
        && record.delivery?.request.id !== pending.value.request.id
      const owner = neverSent ? { ...record, delivery: undefined, lastWake: undefined } : record
      const reconstructedInput: RoleWake | undefined = input.taskRecovery ? {
        id: "recovered-task:" + row.value.commandId,
        role: record.identity.role,
        taskId,
        lifecycleId: record.identity.lifecycleId,
        ...record.identity.workerId ? { workerId: record.identity.workerId } : {},
        reason: "startup-recovery",
        sources: [],
        context: {
          originalInput: "The original input is unavailable. Continue from retained current records, not a claimed reconstruction of the original wording.\n" + input.taskRecovery.continuation,
          taskRecovery: input.taskRecovery
        }
      } : void 0;
      const recoverySource = input.taskRecovery && taskId ? await withSnapshot(this.files, async (snapshot) => {
        const task = await readJson<TaskMetadata>(this.files, snapshot, paths.task(taskId));
        return task ? await this.files.read(snapshot, task.sourcePath) : void 0;
      }) : void 0;
      const continuation = await this.arrangeNativeContinuation(owner, { ...input, ...(debugPath ? { debugPath } : {}), ...recoverySource ? { recoveredTaskSource: recoverySource } : {} }, void 0, 'restore-role:' + row.value.commandId, pending?.value.request ?? reconstructedInput);
      const terminal = !continuation && !pending && !record.delivery && !record.lastWake
        && record.identity.taskId && ['Planner', 'Worker'].includes(record.identity.role) && await withSnapshot(this.files, async (snapshot) => {
          const task = await readJson<TaskMetadata>(this.files, snapshot, paths.task(record.identity.taskId!));
          if (task && isTerminalTask(task)) return true;
          const status = record.identity.member && await readMemberStatus(this.files, snapshot, paths.memberStatus(record.identity.taskId!, record.identity.member));
          return !!status && status.state === 'complete'
        });
      if (continuation || terminal) await this.completeRestore(row, continuation ? 'arranged' : 'terminal')
    });
  }
  private cancelledByShutdown(error: unknown): boolean {
    return this.shutdownReason !== undefined && (error === this.shutdownReason || (error instanceof Error && error.name === 'AbortError' && error.cause === this.shutdownReason)
      || (error instanceof AggregateError && error.errors.length > 0 && error.errors.every(item => this.cancelledByShutdown(item)))
      || (error instanceof DshAgentCreationCancelled && error.executionStopped && error.reason === this.shutdownReason))
  }
  private error(error: unknown, context?: Record<string, unknown>): void {
    if (this.cancelledByShutdown(error)) return
    const toolOrigin = roleErrorOrigin(error)
    const identity = toolOrigin?.identity ?? (context?.identity as WorkIdentity | undefined);
    const taskId = toolOrigin?.taskId ?? identity?.taskId ?? (typeof context?.taskId === 'string' ? context.taskId : undefined)
    const origin: RoleErrorOrigin = {
      ...context?.role === ('Helper' as const) ? { role: ('Helper' as const) } : {},
      ...(identity ? { identity } : {}),
      ...(taskId ? { taskId } : {}),
      ...(typeof context?.hostRestorationCommandId === 'string' ? { hostRestorationCommandId: context.hostRestorationCommandId } : {}),
      ...(typeof context?.restoreCommandId === 'string' ? { restoreCommandId: context.restoreCommandId } : {}),
      ...toolOrigin
    };
    if (toolOrigin) context = { ...context, ...toolOrigin }
    const fact = error instanceof GitHubError ? error.rateLimit ?? error : error
    let occurrence = fact && typeof fact === 'object' ? this.safetyErrorOccurrences?.get(fact) : undefined
    occurrence ??= typeof context?.safetyOccurrence === 'number' ? context.safetyOccurrence : undefined
    occurrence ??= this.safetyContext?.getStore() ?? this.safetyBaseOccurrence ?? 0
    if (fact && typeof fact === 'object') this.safetyErrorOccurrences?.set(fact, occurrence)
    const safetyCommand = context?.restoreCommandId ?? context?.hostRestorationCommandId
    if (typeof safetyCommand === 'string' && [...this.safetyEpisodes?.values() ?? []].some(episode => episode.commands.has(safetyCommand))) {
      this.ctx.logger?.('deepseek-servant').error(error)
      return
    }
    const facts = error instanceof Error ? error.message : String(error)
    const diagnosticContext = typeof context?.hostRestorationCommandId === 'string' && typeof context.activeTarget === 'string' && Array.isArray(context.targets)
      ? { ...context, targets: context.targets.filter(target => target?.identity?.executionId === context.activeTarget) } : context
    const signature = hash(JSON.stringify([facts, diagnosticContext]))
    // Service retains the original fault or native user-interaction responsibility,
    // including reports received before a running runtime is available.
    this.environment.error(error, { ...origin, diagnosticContext: context, errorSignature: signature }, { source: identity ? 'agent' : 'runtime', occurrence })
  }
  async settleForStorageMove(): Promise<void> {
    await this.dispose()
    for (const row of await this.records.list<RoleRecord>(this.prefix + 'roles/')) {
      if (row.value.released || row.value.stopped) continue
      const current = this.roleRecords.get(row.value.identity.workId)
      if (current && current.identity.executionId !== row.value.identity.executionId) throw new Error('Storage move encountered a replaced execution identity.')
      this.roleRecords.set(row.value.identity.workId, row.value)
        ; (this.roleBases ??= new Map()).set(row.value.identity.workId, structuredClone(row.value))
      const result = await this.stopOwnedRecord(row.value)
      if (result.status !== 'stopped') throw new Error(result.status === 'unconfirmed'
        ? 'Storage has an unconfirmed native producer: ' + result.reason : 'Storage execution ownership changed before its move.')
      await this.saveRole({ ...row.value, stopped: true })
    }
  }
  dispose(): Promise<void> {
    return this.disposing ??= this.disposeOwned()
  }
  private async disposeOwned(): Promise<void> {
    this.closed = true
    this.localWakeAdmissions.clear(); this.reportedAdmissionDiagnostics.clear()
    const skillCacheClosed = this.skillCacheRefresh?.close()
    this.cleaner.close(); this.cleanupResidues.clear()
    const failures: unknown[] = []
    try {
      const cancellation = this.shutdownReason = new DOMException('Framework runtime is closing its owned requests.', 'AbortError')
      const openingStops = [...this.roleRecords.values()].map(async record => {
        const result = await this.native.cancelOpening(record.identity.workId, record.identity.executionId, cancellation)
        const current = this.roleRecords.get(record.identity.workId)
        if (result.status === 'stopped' && current?.identity.executionId === record.identity.executionId)
          await this.saveRole({ ...current, stopped: true })
        return result
      })
      const loopStopped = this.loop.stop()
      try { this.environment.cancelPending?.(cancellation) } catch (error) { failures.push(error) }
      try { await loopStopped } catch (error) {
        // Only this shutdown's exact cancellation can complete a cancelled read.
        // Unknown commit wrappers and independent errors remain failures.
        if (!this.cancelledByShutdown(error)) failures.push(error)
      }
      // The caller still owns each command's success/error. Closing only
      // joins writes accepted by this runtime before releasing its storage.
      await Promise.allSettled(this.pendingControlStops.flatMap(target => target.write ? [target.write] : []))
      for (const settled of await Promise.allSettled([...(this.maintenance?.values() ?? []), ...(skillCacheClosed ? [skillCacheClosed] : [])]))
        if (settled.status === 'rejected' && !this.cancelledByShutdown(settled.reason)) failures.push(settled.reason)
      for (const settled of await Promise.allSettled(openingStops)) {
        if (settled.status === 'rejected') failures.push(settled.reason)
        else if (settled.value.status === 'unconfirmed') failures.push(new Error(settled.value.reason))
      }
      try { await this.restoring } catch (error) { if (!this.cancelledByShutdown(error)) failures.push(error) }
      while ([...(this.stopOperations?.values() ?? [])].some(stop => !stop.settled)) {
        await Promise.all([...this.stopOperations!.values()].filter(stop => !stop.settled).map(stop => stop.promise));
      }
      for (const record of this.roleRecords.values()) {
        if (record.stopped || record.businessTransferred) continue
        try {
          // Idle may already own the same capture. Serialize the producer's
          // final publication, rather than racing two readers with native close.
          await this.serialWork(record.identity.workId, async () => {
            const latest = this.roleRecords.get(record.identity.workId)
            if (!latest || latest.identity.executionId !== record.identity.executionId || latest.stopped || latest.stopIntent) return
            if (latest.identity.role === 'Foreground') {
              if (latest.delivery || latest.lastWake) await this.finishForegroundRound(latest)
            } else await this.finishGitAuxiliaryRound(latest)
          })
        } catch (error) { failures.push(error) }
        try {
          const result = await this.stopOwnedRecord(record)
          // Completion capture above can advance a reused role from settled A
          // to settled B. Stop evidence must not restore the old loop snapshot.
          const current = this.roleRecords.get(record.identity.workId)
          if (current?.identity.executionId !== record.identity.executionId || current.sessionId !== record.sessionId) continue
          if (result.status === 'stopped') await this.saveRole({ ...current, stopped: true })
          if (result.status === 'unconfirmed') {
            failures.push(new Error(result.reason))
            await this.saveRole({ ...current, stopUnknown: result })
          }
        } catch (error) { failures.push(error) }
      }
      try { await this.pumping } catch (error) { if (!this.cancelledByShutdown(error)) failures.push(error) }
      for (const settled of await Promise.allSettled([...this.targetedPumps.values()]))
        if (settled.status === 'rejected' && !this.cancelledByShutdown(settled.reason)) failures.push(settled.reason)
      for (const settled of await Promise.allSettled([...(this.observationOperations?.values() ?? [])]))
        if (settled.status === 'rejected' && !this.cancelledByShutdown(settled.reason)) failures.push(settled.reason)
      for (const record of this.retiredWorkers?.values() ?? []) this.drainRetiredWorker(record.identity.executionId)
      await Promise.all(this.workerDrains?.values() ?? [])
      await this.settleOperations([...this.retiredWorkOperations ?? []], 'Retired Worker admission tails failed')
      for (const record of this.retiredWorkers?.values() ?? []) if (!record.stopped) failures.push(new Error('Retired Worker native teardown remains unconfirmed: ' + record.identity.executionId))
      try { await this.foregroundActivity?.dispose() } catch (error) { failures.push(error) }
      try { await this.observations.dispose() } catch (error) { failures.push(error) }
    } catch (error) { failures.push(error) } finally {
      while (this.workOperations?.size) {
        const settled = await Promise.allSettled([...this.workOperations.values()])
        for (const result of settled) if (result.status === 'rejected' && !this.cancelledByShutdown(result.reason)) failures.push(result.reason)
      }
      // A successful reply may have returned while its auxiliary role save ran.
      // Drain that existing owner before storage is released, without a mode gate.
      const foregroundWorkId = this.roleKey('Foreground')
      while (this.roleWrites?.has(foregroundWorkId)) {
        try { await this.roleWrites.get(foregroundWorkId) }
        catch (error) { if (!this.cancelledByShutdown(error)) failures.push(error) }
      }
      for (const key of [...this.foregroundProcessWrites?.keys() ?? []]) {
        try {
          await this.flushForegroundProcessWrites(key);
        } catch (error) { if (!this.cancelledByShutdown(error)) failures.push(error) }
      }
      for (const outcome of await Promise.allSettled([...(this.notificationClaimWrites?.values() ?? [])])) if (outcome.status === 'rejected' && !this.cancelledByShutdown(outcome.reason)) failures.push(outcome.reason)
      for (const result of await Promise.allSettled([...(this.helperWakeWrites?.values() ?? []), ...this.organizerWakeWrites.values()]))
        if (result.status === 'rejected' && !this.cancelledByShutdown(result.reason)) failures.push(result.reason)
      for (const outcome of await Promise.allSettled([...(this.safetyRequests?.values() ?? [])]))
        if (outcome.status === 'rejected') failures.push(outcome.reason)
      for (const outcome of await Promise.allSettled([...(this.safetySettlements?.values() ?? []), ...(this.safetyRestoreWrites?.values() ?? []), ...(this.safetyResolutionLoad ? [this.safetyResolutionLoad] : [])])) if (outcome.status === 'rejected') failures.push(outcome.reason)
      this.wakeConsumptions?.clear()
      this.hostRestoreNativeEvidence?.clear()
      this.hostRestoreEvidenceCursor = undefined
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'Runtime disposal and diagnostic persistence failed')
  }
}
