import { DshAgentAdmissionClosed, DshAgentCreationCancelled } from '../adapters/dsh/host-types.js'
import { ensureForegroundActivity, type DshForegroundActivityReader } from '../adapters/dsh/foreground-activity.js'
import { captureForegroundTurns } from './foreground-capture.js'
import { GitHubError } from '../experimental/private-git/github.js'
import { nativeRecoveryWakeId, resolveNativeRecoveryInput } from './native-recovery-input.js'
import type { DshSessionInspection } from '../adapters/dsh/sessions.js'
import { FrameworkTaskIndex } from './task-index.js'
import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { StoragePort } from '../contracts/ports.js'
import { DshSessionReader } from '../adapters/dsh/sessions.js'
import { DshAgentGateway } from '../adapters/dsh/agents.js'
import type { DshModelRoute } from '../adapters/dsh/host-types.js'
import { NativeExecutions, pendingNativeStopJobs, type NativeStopEvidence, type StopResult } from './native-executions.js'
import { installFrameworkSkillProvider } from './skills.js'
import type { KnowledgeScope } from '../contracts/knowledge.js'
import { ExecutionControls } from './execution-control.js'
import { DurableObservationStore } from './observation-store.js'
import { ExecutionObservations, type ScheduledObservation } from './execution-observation.js'
import { FrameworkTransactions } from './command-transactions.js'
import type { ObservedInstance } from './instances.js'
import { FrameworkArtifacts } from './artifacts.js'
import { clearCleanupReferenceCache, changedCleanupMaterials, type RetentionManifest, CleanupMaterialsChangedError, FrameworkCleaner, cleanupRecordPath } from './cleaner.js'
import { FrameworkConversation, type ConversationSend } from './conversation.js'
import { FrameworkHostLoop, type RoleWake } from './host-loop.js'
import { installFrameworkRoleTools, parseDirectSignal, signalWorkerId, workerPaths, type FrameworkRoleBinding, type FrameworkRoleServices, type HelperRestoreInput } from './role-tools.js'
import { clearInboxDiscoveryCache, paths, readJson, readMemberStatus, type TaskMetadata, type MemberStatus } from './task-files.js'
import { FilesConflictError, FilesOutcomeUnknownError, withSnapshot, type FilesStore, type FilesSnapshot } from './transactions.js'
import { scanMemberRecovery, memberRecoveryEligible, createRecoveryWatch, dueRecoveryWatch,
  type RecoveryWatch, type MemberRecoveryInput, type WorkIdentity, type RecoveryRole } from './recovery.js'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
interface RoleRecord { identity: WorkIdentity; sessionId: string; generation: number; foregroundMessages?: Record<string, string>; completedRound?: boolean; lastWake?: RoleWake; delivery?: { request: RoleWake; messageId: string; text?: string; confirmed: boolean; sequence?: number }; released?: boolean; stopped?: boolean; stopIntent?: NativeStopEvidence; stopUnknown?: { reason: string; jobs: string[] } }
interface TrackedStop { executionId: string; taskId?: string; promise: Promise<void>; settled: boolean; result?: StopResult; persistedStopped?: boolean; reportedFailure?: string; failure?: unknown; controlCommands?: Set<string> }
interface WakeRecovery {
  targetExecutionId?: string
  explanationText?: string
  confirmedStoppedExecutions?: string[]
  original?: NonNullable<RoleRecord['delivery']>
  /** Original Host wake had no native input yet; the continuation adopts it. */
  replacesUnadmittedWake?: string
}
interface WakeRecord { request: RoleWake; delivered?: boolean; recovery?: WakeRecovery; admission?: { eligibleSince?: number; reportedAt?: number; phase?: 'queued' | 'opening' | 'sending'; executionId?: string } }
interface RoleRestore { commandId: string; createdAt: string; input: HelperRestoreInput; complete: boolean; resolvedTarget?: WorkIdentity; admissionWakeId?: string; continuationId?: string; outcome?: string }
interface ObservationRecord { pending: ScheduledObservation; complete: boolean; stopStarted?: boolean }
interface RecoveryWatchRecord { watch?: RecoveryWatch; consumedReceipts?: string[]; completedHealthyCycles?: string[]; released?: boolean }
export interface RuntimeConfiguration {
  scope: string
  member: string
  primary: boolean
  workspace: string
  presetId?: string
  model?: DshModelRoute
  foreground?: DshModelRoute
  background?: DshModelRoute
  workerSeats: number
  legacySkillScopes?: KnowledgeScope[]
  legacyGitSkillParticipants?: string[]
  mode: 'local' | 'git'
  collaborationId: string
}
export interface RuntimeEnvironment {
  members(): readonly string[]
  resources(): readonly ObservedInstance[]
  heartbeat(): Promise<void>
  cancelPending?(reason?: unknown): void
  observeResources?(snapshot: FilesSnapshot): Promise<void>
  observationInterrupted?(): void
  error(error: unknown): void
  changed?(): void
  restored?(): void
  capacity?(agent: Agent, input: { taskId: string; paths: string[] }): Promise<unknown>
}

/** Host composition of durable scheduling, real native Agents and authoritative task files. */
export class FrameworkRoleRuntime {
  readonly controls: ExecutionControls
  readonly transactions: FrameworkTransactions
  readonly conversation: FrameworkConversation
  readonly observations: ExecutionObservations
  readonly native: NativeExecutions
  readonly loop: FrameworkHostLoop
  readonly cleaner: FrameworkCleaner
  private readonly foregroundActivity?: DshForegroundActivityReader
  private foregroundVisibility?: { executionId: string; turnId: string }
  private foregroundFinal?: { executionId: string; turn: number }
  private readonly gateway: DshAgentGateway
  private readonly observationStore: DurableObservationStore
  private readonly prefix: string
  private readonly roleRecords = new Map<string, RoleRecord>()
  private stopOperations?: Map<string, TrackedStop>
  private pumping?: Promise<void>
  private queueing?: Promise<void>
  private admissions?: Map<string, Promise<void>>
  private workerAdmissions?: Set<string>
  private observationOperations?: Map<string, Promise<void>>
  private maintenance?: Map<string, Promise<void>>
  private helperPumping?: Promise<void>
  private restoring?: Promise<void>
  private restoreScanning?: Promise<void>
  private hostRestoring?: Promise<void>
  private restoreOperations?: Map<string, Promise<void>>
  private readonly targetedPumps = new Map<string, Promise<void>>()
  private readonly admissionCancellations = new Map<string, unknown>()
  private readonly wakeWrites = new Map<string, Promise<unknown>>()
  private admissionNow = () => Date.now()
  private closed = false
  private readonly bootId = randomUUID()
  private taskMetadataIndex?: FrameworkTaskIndex
  private readonly skillProviders = new Map<string, ReturnType<typeof installFrameworkSkillProvider>>()
  private workOperations?: Map<string, Promise<unknown>>
  private pendingForegroundResets?: Set<string>
  private roleWrites?: Map<string, Promise<void>>
  private recoveryWatchWrites?: Map<string, Promise<unknown>>
  private errorTail: Promise<void> = Promise.resolve()
  private disposing?: Promise<void>
  private shutdownReason?: DOMException
  private rateLimitDiagnostics?: WeakMap<object, 'pending' | 'recorded'>
  constructor(private readonly ctx: Context, readonly files: FilesStore, private readonly records: StoragePort,
    readonly config: RuntimeConfiguration, private readonly environment: RuntimeEnvironment) {
    this.foregroundActivity = typeof ctx.inject === 'function' ? ensureForegroundActivity(ctx) : undefined
    this.prefix = 'framework-runtime/' + hash(config.scope) + '/'
    this.controls = new ExecutionControls(records, config.scope)
    this.transactions = new FrameworkTransactions(files, records, config.scope)
    this.conversation = new FrameworkConversation(files, this.transactions, { mode: config.mode, collaborationId: config.collaborationId })
    this.gateway = new DshAgentGateway(ctx)
    this.observationStore = new DurableObservationStore(records, config.scope)
    this.observations = new ExecutionObservations(this.observationStore, { arrange: pending => this.enqueueObservation(pending) }, error => this.error(error))
    this.native = new NativeExecutions(ctx, this.gateway, this.observations, { save: async evidence => {
      const record = this.roleRecords.get(evidence.workId)
      if (!record || record.identity.executionId !== evidence.executionId) throw new Error('Stop evidence no longer matches its execution.')
      await this.saveRole({ ...record, stopIntent: evidence }, true)
    } })
    this.cleaner = new FrameworkCleaner(files, this.transactions, task => this.releaseTask(task))
    this.loop = new FrameworkHostLoop(files, this.transactions, records, config, () => environment.members(), {
      wake: request => this.wake(request), admitDiscovered: async () => { this.startOwnedPump() }, executing: (role, task, worker) => this.executing(role, task, worker),
      changed: () => environment.changed?.(), startup: () => this.startup(), observeLocal: async () => { await this.checkWakeAdmissions(); this.startRestoration(); await this.observations.tick(); if (!this.closed) await this.processObservations(false, 'native', false) }, observe: () => this.observe(), discoverTask: (task, snapshot) => this.observeRecoveryMarkers(snapshot, [task]), discoveryInterrupted: () => environment.observationInterrupted?.(), error: error => this.error(error),
      sealBusiness: task => this.sealBusiness(task.taskId), clean: (task, snapshot) => this.clean(task, snapshot), releaseTask: taskId => this.releaseLocalTask(taskId),
    })
  }
  /** An explicitly confirmed Local history operation owns only Foreground.
   * Its fixed prior execution cannot be replaced by a later session on retry. */
  async withForegroundReset<T>(commandId: string, action: (capturedMessageIds?: readonly string[]) => Promise<T>): Promise<T> {
    if (this.config.mode !== 'local' || !commandId) throw new Error('Foreground history reset requires an explicit Local command.')
    const workId = this.roleKey('Foreground'), key = this.prefix + 'foreground-resets/' + hash(commandId)
    type Reset = { commandId: string; phase: 'planned' | 'retired' | 'complete'; target?: RoleRecord;
      wakeKeys: string[]; pendingTasks: RoleWake[]; capturedMessageIds?: string[] }
    return this.serialWork(workId, async () => {
      let reset = await this.records.get<Reset>(key)
      if (!reset) {
        const stored = await this.records.get<RoleRecord>(this.prefix + 'roles/' + hash(workId))
        const target = this.roleRecords.get(workId) ?? (stored?.released ? undefined : stored)
        const wakes = (await this.records.list<WakeRecord>(this.prefix + 'wakes/'))
          .filter(row => this.requestKey(row.value.request) === workId)
        const pendingTasks = new Map<string, RoleWake>()
        for (const row of wakes) if (!row.value.delivered && row.value.request.taskId) pendingTasks.set(row.value.request.taskId, row.value.request)
        const prior = target?.delivery?.request ?? target?.lastWake
        if (prior?.taskId && !target?.completedRound) pendingTasks.set(prior.taskId, prior)
        reset = { commandId, phase: 'planned', ...(target ? { target } : {}), wakeKeys: wakes.map(row => row.key), pendingTasks: [...pendingTasks.values()] }
        await this.records.set(key, reset)
      }
      const pendingResets = this.pendingForegroundResets ??= new Set()
      if (reset.phase !== 'complete') pendingResets.add(commandId)
      else pendingResets.delete(commandId)
      if (reset.phase === 'planned') {
        if (reset.target) {
          const stored = await this.records.get<RoleRecord>(this.prefix + 'roles/' + hash(workId))
          const current = this.roleRecords.get(workId) ?? stored
          if (current && current.identity.executionId !== reset.target.identity.executionId) throw new Error('The Foreground reset target changed before its retirement was confirmed.')
          if (current && !current.released) {
            this.roleRecords.set(workId, current)
            if (!current.stopped) {
              await this.finishForegroundRound(current)
              const result = await this.stopOwnedRecord(this.roleRecords.get(workId) ?? current)
              if (result.status !== 'stopped') throw new Error(result.status === 'unconfirmed' ? result.reason : 'Foreground ownership changed while clearing its history.')
            }
            const stopped = this.roleRecords.get(workId) ?? current
            const capturedMessageIds: string[] = []
            for (const [id, signature] of Object.entries(stopped.foregroundMessages ?? {})) {
              const message = await this.conversation.read(id)
              if (!message) continue
              if (message.role !== 'assistant' || this.foregroundMessageSignature(message) !== signature) throw new Error('An old Foreground output identity no longer matches its saved message.')
              capturedMessageIds.push(id)
            }
            reset = { ...reset, capturedMessageIds }
            await this.records.set(key, reset)
            await this.saveRole({ ...stopped, stopped: true, released: true })
            this.roleRecords.delete(workId)
          }
        }
        for (const wakeKey of reset.wakeKeys) {
          const wake = await this.records.get<WakeRecord>(wakeKey)
          if (wake) await this.updateWake(wakeKey, current => current ? { ...current, delivered: true, admission: undefined } : undefined)
        }
        // A conversation reset does not discharge a completed Task's outstanding
        // delivery. Reintroduce that existing responsibility, not old user text.
        for (const prior of reset.pendingTasks) await this.wake({ id: 'history-reset-delivery:' + hash(commandId + '\0' + prior.taskId),
          role: 'Foreground', taskId: prior.taskId, reason: 'business-complete', sources: [],
          context: { facts: 'Conversation history was explicitly cleared. Inspect this completed Task and deliver its still-pending result in the new conversation.' } })
        reset = { ...reset, phase: 'retired' }
        await this.records.set(key, reset)
      }
      const result = await action(reset.capturedMessageIds ?? [])
      if (reset.phase !== 'complete') await this.records.set(key, { ...reset, phase: 'complete' })
      pendingResets.delete(commandId)
      return result
    })
  }
  private async manuallyCleared(taskId: string | undefined, snapshot?: FilesSnapshot): Promise<boolean> {
    if (!taskId || this.config.mode !== 'local') return false
    const read = async (view: FilesSnapshot) => {
      const value = await readJson<{ version: number; taskId: string; phase: string; historyCleared?: boolean }>(this.files, view, cleanupRecordPath(taskId))
      return value?.version === 1 && value.taskId === taskId && value.phase === 'released' && value.historyCleared === true
    }
    return snapshot ? read(snapshot) : withSnapshot(this.files, read)
  }
  /** Read-only evidence, not a request to stop anything. An intent alone, idle
   * native registry or an unknown producer never establishes safe deletion. */
  async cancelledTaskCleanupEvidence(taskId: string): Promise<{ commandId: string; signature: string } | undefined> {
    if (this.config.mode !== 'local') return undefined
    const intent = await this.controls.task(taskId)
    if (intent?.intent !== 'cancelled') return undefined
    const task = await withSnapshot(this.files, snapshot => readJson<TaskMetadata>(this.files, snapshot, paths.task(taskId)))
    if (!task || task.status !== 'running') return undefined
    const records = new Map((await this.records.list<RoleRecord>(this.prefix + 'roles/')).map(row => [row.value.identity.workId, row.value]))
    for (const [key, value] of this.roleRecords) records.set(key, value)
    const settled: unknown[] = []
    for (const record of [...records.values()].sort((a, b) => a.identity.workId.localeCompare(b.identity.workId))) {
      const related = record.identity.taskId === taskId || (record.identity.role === 'Organizer' && task.route === 'O' && await this.currentTask(record) === taskId)
      if (!related) continue
      if ((!record.stopped && !record.released) || this.active(record)) return undefined
      settled.push([record.identity.workId, record.identity.executionId, record.sessionId, record.generation, !!record.stopped, !!record.released])
    }
    const current = await this.controls.task(taskId)
    if (current?.commandId !== intent.commandId || current.intent !== 'cancelled') return undefined
    return { commandId: intent.commandId, signature: hash(JSON.stringify([taskId, intent.commandId, settled])) }
  }
  /** Manual history deletion follows real task cleanup; it never substitutes a
   * user intent bit for producer settlement or marks running work complete. */
  async prepareTaskCleanup(taskId: string): Promise<void> {
    if (this.config.mode !== 'local') throw new Error('Manual task history cleanup is Local only.')
    const currentTask = await withSnapshot(this.files, async snapshot => {
      const task = await readJson<TaskMetadata>(this.files, snapshot, paths.task(taskId))
      if (!task) return false // The caller validates the retained legacy terminal manifest.
      if (await this.manuallyCleared(taskId, snapshot)) return 'released'
      if (task.status === 'running' && await this.cancelledTaskCleanupEvidence(taskId)) return 'cancelled'
      const cleanup = await readJson<{ version: number; taskId: string; phase: string }>(this.files, snapshot, cleanupRecordPath(taskId))
      if (task.status !== 'complete' || cleanup?.version !== 1 || cleanup.taskId !== taskId || cleanup.phase !== 'released') {
        throw new Error('Task history cleanup requires its actual completed and released task.')
      }
      return true
    })
    if (currentTask === 'cancelled') return // Keep the user hold until the file transaction is confirmed.
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
      }
    }
    // Singleton Organizer may have moved on to another Task. Only detach the
    // stopped execution whose admitted responsibility still belongs to this one.
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
  async start(): Promise<void> {
    if (this.closed) throw new Error('Framework runtime is disposed.')
    for (const row of await this.records.list<RoleRecord>(this.prefix + 'roles/')) if (!row.value.released) this.roleRecords.set(row.value.identity.workId, row.value)
    this.pendingForegroundResets = new Set((await this.records.list<{ commandId: string; phase: string }>(this.prefix + 'foreground-resets/'))
      .filter(row => row.value.phase !== 'complete').map(row => row.value.commandId))
    if (this.closed) throw new Error('Framework runtime is disposed.')
    await this.loop.start()
  }
  private roleKey(role: RecoveryRole, taskId?: string, workerId?: string, directId?: string): string {
    return JSON.stringify([role, role === 'Foreground' || role === 'Organizer' || role === 'Helper' ? null : taskId ?? null, workerId ?? null, directId ?? null])
  }
  private requestKey(request: RoleWake): string {
    const direct = request.sources.map(source => parseDirectSignal(source.path.split('/').at(-1)!)).find(Boolean)
    return this.roleKey(request.role, request.taskId, request.workerId, direct?.id)
  }
  private saveRole(record: RoleRecord, evidenceUpdate = false, deliveryUpdate?: 'prepare' | 'confirm'): Promise<void> {
    this.roleWrites ??= new Map()
    const workId = record.identity.workId
    const operation = (this.roleWrites.get(workId) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const latest = this.roleRecords.get(workId), incomingDelivery = record.delivery
      if (!latest && record.identity.role === 'Organizer') {
        const previous = await this.records.get<RoleRecord>(this.prefix + 'roles/' + hash(workId))
        if (previous?.released && previous.identity.executionId === record.identity.executionId) return
      }
      if (!latest && record.identity.taskId && (await this.records.get<{ released?: boolean }>(this.prefix + 'sealed/' + hash(record.identity.taskId)))?.released) return
      if (evidenceUpdate) {
        if (!latest || latest.identity.executionId !== record.identity.executionId) throw new Error('Stop evidence execution was replaced before persistence.')
        record = { ...latest, stopIntent: record.stopIntent }
      } else if (latest && latest.identity.executionId !== record.identity.executionId) {
        if (record.generation <= latest.generation) throw new Error('A superseded execution cannot overwrite its replacement.');
      } else if (latest) record = { ...record, ...(latest.stopIntent ? { stopIntent: latest.stopIntent } : {}),
        foregroundMessages: { ...latest.foregroundMessages, ...record.foregroundMessages },
        completedRound: record.completedRound || latest.completedRound, stopped: record.stopped || latest.stopped, released: record.released || latest.released, stopUnknown: record.stopUnknown ?? latest.stopUnknown,
        delivery: latest.delivery ?? record.delivery, lastWake: latest.lastWake ?? record.lastWake }
      if (deliveryUpdate && incomingDelivery) {
        if (deliveryUpdate === 'confirm') {
          if (latest?.delivery?.messageId !== incomingDelivery.messageId) throw new Error('A superseded delivery cannot confirm another input.');
          record = { ...record, lastWake: latest.delivery.request, delivery: { ...latest.delivery, confirmed: true } };
        } else record = { ...record, delivery: latest?.delivery?.messageId === incomingDelivery.messageId ? { ...latest.delivery, text: latest.delivery.text ?? incomingDelivery.text } : { ...incomingDelivery, sequence: (latest?.delivery?.sequence ?? 0) + 1 } };
      }
      if (record.stopped) record = { ...record, stopUnknown: undefined }
      if (record.released && (record.identity.taskId || record.identity.role === 'Organizer')) record = { identity: record.identity, sessionId: record.sessionId, generation: record.generation,
        stopped: record.stopped, released: true, ...(record.stopIntent ? { stopIntent: record.stopIntent } : {}) }
      await this.records.set(this.prefix + 'roles/' + hash(workId), record)
      this.roleRecords.set(workId, record)
      const stopping = this.stopOperations?.get(JSON.stringify([workId, record.identity.executionId]))
      if (stopping && record.stopped) {
        stopping.persistedStopped = true
        if (stopping.settled) stopping.result = { status: 'stopped' }
      }
    })
    this.roleWrites.set(workId, operation)
    void operation.finally(() => { if (this.roleWrites?.get(workId) === operation) this.roleWrites.delete(workId) }).catch(() => {})
    return operation
  }
  private active(record: RoleRecord): boolean {
    const owned = this.native.get(record.identity.workId)
    if (owned) { const state = owned.observe().state; return state === 'running' || state === 'waiting' }
    const agent = this.ctx.agents.get(SessionId(record.sessionId))
    return agent?.status === 'running' || (this.ctx.get('jobs')?.list(SessionId(record.sessionId)).some(job => job.owner === record.sessionId && (job.status === 'running' || job.status === 'stopping')) ?? false)
  }
  private workerSeatOccupied(record: RoleRecord): boolean {
    if (record.identity.role !== 'Worker' || record.stopped) return false
    if (this.active(record) || record.stopUnknown) return true
    const intent = record.stopIntent
    return intent?.workId === record.identity.workId && intent.executionId === record.identity.executionId
      && intent.phase === 'stopping'
  }
  private occupiedWorkerSeats(excluding?: string): number {
    const occupied = new Set(this.workerAdmissions ?? [])
    for (const record of this.roleRecords.values()) if (this.workerSeatOccupied(record)) occupied.add(record.identity.workId)
    if (excluding) occupied.delete(excluding)
    return occupied.size
  }
  /** Optional local display evidence, never a shared scheduling or completion signal. */
  async foregroundProcessing(): Promise<{ executionId: string; turnId: string; startedAt: number } | undefined> {
    const record = [...this.roleRecords.values()].find(row => row.identity.role === 'Foreground')
    if (this.closed || !record || record.released || record.stopped || record.stopIntent || record.stopUnknown || record.completedRound) return
    const agent = this.native.get(record.identity.workId)?.actualAgent
    if (!agent) return
    const turn = this.foregroundActivity?.read(agent.session)
    if (!turn || (turn.end && turn.end !== 'completed') || (!turn.end && !this.active(record))) return
    const executionId = record.identity.executionId, turnId = JSON.stringify([record.sessionId, turn.turn, turn.startSeq])
    if (this.foregroundFinal?.executionId === executionId && this.foregroundFinal.turn === turn.turn) return
    if (this.foregroundVisibility?.executionId !== executionId || this.foregroundVisibility.turnId !== turnId) {
      // Ownership is saved before send; it alone is NOT proof of a visible reply.
      // On reattachment verify only this execution's known output identities.
      let visible = false
      for (const [id, signature] of Object.entries(record.foregroundMessages ?? {})) {
        const message = await this.conversation.read(id)
        if (message?.role === 'assistant' && message.recipient === 'human' && message.source !== 'model'
          && this.foregroundMessageSignature(message as ConversationSend) === signature) { visible = true; break }
      }
      if (!visible) return
      this.foregroundVisibility = { executionId, turnId }
    }
    const current = this.roleRecords.get(record.identity.workId), latest = this.foregroundActivity?.read(agent.session)
    if (this.closed || current?.identity.executionId !== executionId || current.completedRound || current.released
      || current.stopped || current.stopIntent || current.stopUnknown || latest?.startSeq !== turn.startSeq
      || (latest.end && latest.end !== 'completed')
      || (this.foregroundFinal?.executionId === executionId && this.foregroundFinal.turn === turn.turn)) return
    return { executionId, turnId, startedAt: turn.startedAt }
  }
  executionViews(taskId?: string): Array<{ workId: string; executionId: string; role: RecoveryRole; state: string; member?: string; workerId?: string; detail?: string }> {
    return [...this.roleRecords.values()].filter(record => !taskId || record.identity.taskId === taskId || record.lastWake?.taskId === taskId)
      .map(record => ({ workId: record.identity.workId, executionId: record.identity.executionId, role: record.identity.role,
        state: record.stopUnknown ? 'unconfirmed' : record.stopped ? 'stopped' : this.active(record) ? 'running' : 'idle',
        member: record.identity.member, workerId: record.identity.workerId, detail: record.stopUnknown?.reason }))
  }
  executing(role: RecoveryRole, taskId?: string, workerId?: string): boolean {
    return [...this.roleRecords.values()].some(record => record.identity.role === role
      && (taskId === undefined || record.identity.taskId === taskId)
      && (workerId === undefined || record.identity.workerId === workerId) && this.active(record))
  }
  async wake(request: RoleWake, recovery?: WakeRecovery): Promise<boolean> {
    if (request.taskId && request.role !== 'Foreground' && (await this.records.get<{ released?: boolean }>(this.prefix + 'sealed/' + hash(request.taskId)))?.released) return false
    const key = this.prefix + 'wakes/' + hash(request.id)
    const saved = await this.records.get<WakeRecord>(key)
    if (saved) {
      if (recovery) await this.updateWake(key, current => current ? { ...current, recovery: current.recovery ?? recovery, delivered: false } : undefined)
      return false
    }
    if (request.reason === 'notification') {
      const existing = (await this.records.list<WakeRecord>(this.prefix + 'wakes/')).some(row => !row.value.delivered
        && row.value.request.reason === 'notification' && row.value.request.taskId === request.taskId
        && this.requestKey(row.value.request) === this.requestKey(request))
      // Receiver tools enumerate current notifications at their checked snapshot.
      // Preserve the original pending native message identity rather than changing its payload.
      if (existing) return false
    }
    let created = false, stored = false
    await this.updateWake(key, current => {
      if (current) return current
      created = true
      return { request, ...(recovery ? { recovery } : {}) }
    }, () => { stored = true })
    return created && stored
  }
  private releasedWake(record: WakeRecord): WakeRecord {
    const { id, role, taskId, workerId, reason } = record.request
    return { request: { id, role, reason, sources: [], ...(taskId ? { taskId } : {}), ...(workerId ? { workerId } : {}) }, delivered: true }
  }
  /** Existing wake receipts also own admission diagnostics; no business marker is added. */
  private updateWake(key: string, update: (current: WakeRecord | undefined) => WakeRecord | undefined, stored?: () => void): Promise<void> {
    const operation = (this.wakeWrites.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const previous = await this.records.get<WakeRecord>(key)
      let next = update(previous)
      if (next?.request.taskId && next.request.role !== 'Foreground'
        && (await this.records.get<{ released?: boolean }>(this.prefix + 'sealed/' + hash(next.request.taskId)))?.released) {
        if (!previous) return
        next = this.releasedWake(next)
      }
      if (next) { await this.records.set(key, next); stored?.() }
    })
    this.wakeWrites.set(key, operation)
    void operation.finally(() => { if (this.wakeWrites.get(key) === operation) this.wakeWrites.delete(key) }).catch(() => {})
    return operation
  }
  private async checkWakeAdmissions(): Promise<void> {
    if (this.closed) return
    const rows = await this.records.list<WakeRecord>(this.prefix + 'wakes/')
    let pendingHelper = rows.some(row => row.value.request.role === 'Helper' && !row.value.delivered)
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
      const wake = row.value, request = wake.request, key = this.requestKey(request)
      if (wake.delivered) continue
      // Control lookup can yield; active execution/admission ownership must be
      // compared again inside the per-wake update, not against this list copy.
      const taskHeld = ['Planner', 'Worker', 'Organizer'].includes(request.role) && await this.controls.taskHeld(request.taskId)
      const now = this.admissionNow()
      let report: WakeRecord['admission'], retained: WakeRecord['admission']
      await this.updateWake(row.key, current => {
        if (this.closed || !current || current.delivered) return
        const record = this.roleRecords.get(key)
        const ownAdmission = record && current.admission?.executionId === record.identity.executionId
        // Only local ownership/control/capacity facts are consulted here. Fresh
        // remote source validation remains in the original admission path.
        const held = (request.role === 'Foreground' && !!this.pendingForegroundResets?.size)
          || taskHeld || firstPending.get(key) !== current.request.id || (!current.recovery && continuationOwners.has(key))
          || (!!record && !ownAdmission && this.active(record))
          || (request.role === 'Worker' && this.occupiedWorkerSeats(ownAdmission ? key : undefined) >= this.config.workerSeats)
        const confirmed = record?.delivery?.request.id === request.id && record.delivery.confirmed
        if (held || confirmed) return current.admission?.eligibleSince !== undefined ? { ...current,
          admission: current.admission.reportedAt === undefined ? undefined : { reportedAt: current.admission.reportedAt } } : undefined
        if (current.admission?.reportedAt !== undefined) retained = current.admission
        const admission = { ...current.admission, eligibleSince: current.admission?.eligibleSince ?? now, phase: current.admission?.phase ?? 'queued' as const }
        if (admission.reportedAt === undefined && now - admission.eligibleSince >= 45_000) {
          report = { ...admission, reportedAt: now }
          return { ...current, admission: report }
        }
        return current.admission?.eligibleSince !== undefined ? undefined : { ...current, admission }
      })
      const diagnostic = report ?? retained
      if (!diagnostic || this.closed) continue
      const target = this.roleRecords.get(key)
      const context = { kind: 'admission-timeout', wakeId: request.id, role: request.role, taskId: request.taskId,
        ...(target && diagnostic.executionId === target.identity.executionId ? { target: { ...target.identity } } : {}),
        workId: key, executionId: diagnostic.executionId, phase: diagnostic.phase ?? 'queued', eligibleSince: diagnostic.eligibleSince,
        facts: 'An eligible Host wake has not completed native admission within 45 seconds. Inspect this exact pending wake; this is not an AI execution time limit.' }
      const error = new Error(context.facts + ' ' + JSON.stringify(context))
      if (report) { this.ctx.logger('deepseek-servant').error(error); this.environment.error(error) }
      // A Helper admission failure is visible but cannot recursively create another Helper.
      if (request.role !== 'Helper') pendingHelper = await this.wake({ id: 'admission-timeout:' + request.id, role: 'Helper', reason: 'helper', sources: [], context }) || pendingHelper
    }
    if (!this.closed && pendingHelper) this.startHelperAdmission()
  }
  private startHelperAdmission(): void {
    if (this.closed || this.helperPumping) return
    const operation = Promise.resolve().then(() => { if (!this.closed) return this.runQueue(true) })
    this.helperPumping = operation
    void operation.catch(error => this.error(error, { role: 'Helper', stage: 'admission' })).finally(() => {
      if (this.helperPumping === operation) this.helperPumping = undefined
    })
  }
  /** Discovery admits one owned native queue without joining unrelated open/send work.
   * The original pump promise remains available to explicit waiting callers and disposal. */
  private startOwnedPump(): void {
    if (this.closed || this.queueing) return
    const operation = this.pump(false)
    // Attach once per owned flight, not once per discovery tick while it is held.
    void operation.catch(error => this.error(error))
  }
  private pump(waitForAdmissions = true): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (!this.queueing) {
      const scan = Promise.resolve().then(() => { if (!this.closed) return this.runQueue(false, undefined, false) })
      this.queueing = scan
      void scan.finally(() => { if (this.queueing === scan) this.queueing = undefined }).catch(() => {})
      const operation = scan.then(() => this.settleOperations([...(this.admissions?.values() ?? [])], 'Native admissions failed'))
      this.pumping = operation
      void operation.finally(() => { if (this.pumping === operation) this.pumping = undefined }).catch(() => {})
    }
    return waitForAdmissions ? this.pumping! : this.queueing
  }
  private async settleOperations(operations: Promise<unknown>[], message: string): Promise<void> {
    const failures = (await Promise.allSettled(operations)).filter((item): item is PromiseRejectedResult => item.status === 'rejected').map(item => item.reason)
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, message)
  }
  private async serialWork<T>(workId: string, operation: () => Promise<T>): Promise<T> {
    const operations = this.workOperations ??= new Map()
    const pending = (operations.get(workId) ?? Promise.resolve()).catch(() => undefined).then(operation)
    operations.set(workId, pending)
    try { return await pending }
    finally { if (operations.get(workId) === pending) operations.delete(workId) }
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
  private async runQueue(helperOnly = false, onlyWakeId?: string, waitForAdmissions = true): Promise<void> {
    const operations: Promise<void>[] = []
    const admissions = this.admissions ??= new Map<string, Promise<void>>()
    const startedWork = new Set<string>()
    const queued = await this.records.list<WakeRecord>(this.prefix + 'wakes/')
    const continuationOwners = new Set(queued.filter(row => !row.value.delivered && row.value.recovery)
      .map(row => this.requestKey(row.value.request)))
    const continuedInputs = new Set(queued.filter(row => !row.value.delivered && row.value.recovery).flatMap(row =>
      [row.value.recovery?.original?.request.id, row.value.recovery?.replacesUnadmittedWake]
        .filter((id): id is string => id !== undefined && id !== row.value.request.id)
        .map(id => JSON.stringify([this.requestKey(row.value.request), id]))))
    for (const row of queued) {
      if ((helperOnly && row.value.request.role !== 'Helper') || (onlyWakeId && row.value.request.id !== onlyWakeId)) continue
      // A pending continuation owns admission of its original input; keep the
      // original receipt until that continuation has reconciled actual input state.
      if (continuedInputs.has(JSON.stringify([this.requestKey(row.value.request), row.value.request.id]))) continue
      if (this.closed) return
      if (row.value.delivered) continue
      const workId = this.requestKey(row.value.request)
      if (!row.value.recovery && continuationOwners.has(workId)) continue
      if (this.workOperations?.has(workId) && !startedWork.has(workId)) continue
      startedWork.add(workId)
      const operation = this.serialWork(workId, async () => {
      if (this.closed) return
      const currentWake = await this.records.get<WakeRecord>(row.key)
      if (this.closed || !currentWake || currentWake.delivered) return
      row.value = currentWake
      // A repair may have claimed this never-admitted wake after the outer
      // queue snapshot. Recheck the actual serial boundary before any native work.
      if ((await this.records.list<WakeRecord>(this.prefix + 'wakes/')).some(item =>
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
      if (request.role === 'Foreground' && this.pendingForegroundResets?.size) return
      if (['Planner', 'Worker', 'Organizer'].includes(request.role) && await this.controls.taskHeld(request.taskId)) return
      let record = this.roleRecords.get(key)
      if (record && this.active(record)) return
      if (record?.identity.role === 'Foreground' && !row.value.recovery) {
        await this.finishForegroundRound(record)
        record = this.roleRecords.get(key)
        if (record?.completedRound && !record.stopped) return
        if (record?.completedRound && record.delivery?.request.id === request.id) {
          await this.updateWake(row.key, current => current ? { ...current, delivered: true, admission: undefined } : undefined)
          return
        }
      }
      const checkSources = request.reason === 'notification' && request.sources.length > 0
      const checkTask = request.taskId && ['Planner', 'Worker', 'Organizer', 'Recorder'].includes(request.role)
      if (checkSources || checkTask) {
        const retired = await withSnapshot(this.files, async snapshot => {
          if (checkSources) {
            const wanted = new Set(request.sources.map(source => source.path))
            const directories = new Set(request.sources.map(source => source.path.slice(0, source.path.lastIndexOf('/') + 1)))
            let present = false
            for (const directory of directories) {
              if ((await this.files.listDirectory(snapshot, directory)).some(entry => wanted.has(entry.path))) { present = true; break }
            }
            if (!present) return true
          }
          if (!checkTask) return false
          if (await this.manuallyCleared(request.taskId, snapshot)) return true
          if (request.role === 'Recorder') return false
          const task = await readJson<TaskMetadata>(this.files, snapshot, paths.task(request.taskId!))
          if (task?.status === 'complete') return true
          if (request.role === 'Organizer') return false
          const member = await readMemberStatus(this.files, snapshot, paths.memberStatus(request.taskId!, this.config.member))
          return member?.state === 'complete'
        })
        if (retired) { await this.updateWake(row.key, current => current ? { ...current, delivered: true, admission: undefined } : undefined); return }
      }
      if (record && !record.stopped && this.stopOperations?.has(JSON.stringify([key, record.identity.executionId]))) {
        if (!this.trackedStop(record)) return
        record = this.roleRecords.get(key)
      }
      if (record && (record.stopIntent || record.stopUnknown) && !record.stopped) {
        const result = await this.stopOwnedRecord(record)
        if (result.status === 'superseded') return
        if (result.status === 'unconfirmed') {
          await this.saveRole({ ...record, stopUnknown: result })
          throw new Error(result.reason)
        }
        await this.saveRole({ ...record, stopped: true })
        record = this.roleRecords.get(key)
      }
      if (row.value.recovery && record && !row.value.recovery.confirmedStoppedExecutions?.includes(record.identity.executionId)) {
        const stopped = record.stopped ? { status: 'stopped' as const } : await this.stopOwnedRecord(record)
        if (stopped.status === 'superseded') return
        if (stopped.status === 'unconfirmed') { await this.saveRole({ ...record, stopUnknown: stopped }); throw new Error(stopped.reason) }
        // This receipt derives from the exact old execution's stop reconciliation,
        // not from an empty registry or the newly resumed Agent being idle.
        row.value.recovery = { ...row.value.recovery,
          confirmedStoppedExecutions: [...(row.value.recovery.confirmedStoppedExecutions ?? []), record.identity.executionId] }
        await this.updateWake(row.key, current => current && !current.delivered ? { ...current, recovery: row.value.recovery } : undefined)
        await this.saveRole({ ...record, stopped: true })
        record = this.roleRecords.get(key)
      }
      // A confirmed native stop is only one part of an admitted observation.
      // Its same-execution marker/continuation must settle before a new input can
      // replace that owner; unrelated work remains independently admissible.
      if (record?.stopped && (await this.records.list<ObservationRecord>(this.prefix + 'observations/')).some(row =>
        !row.value.complete && row.value.stopStarted
        && row.value.pending.action.identity.workId === key
        && row.value.pending.action.identity.executionId === record!.identity.executionId)) return
      if (this.closed) return
      if (request.role === 'Worker') {
        // Reserve synchronously before any durable write or native factory await.
        // The same work owns one seat across opening, sending and active execution.
        if (this.occupiedWorkerSeats(key) >= this.config.workerSeats) return
        ;(this.workerAdmissions ??= new Set()).add(key)
      }
      if (!record || record.stopped) {
        record = { identity: { workId: key, executionId: randomUUID(), role: request.role,
          ...(request.taskId && !['Foreground','Organizer','Helper'].includes(request.role) ? { taskId: request.taskId } : {}),
          ...(request.taskId && (request.role === 'Planner' || request.role === 'Worker') ? { member: this.config.member } : {}),
          ...(request.workerId ? { workerId: request.workerId } : {}) }, sessionId: record?.completedRound ? 'dss-' + randomUUID() : record?.sessionId ?? 'dss-' + randomUUID(), generation: (record?.generation ?? 0) + 1 }
        await this.saveRole(record)
      }
      if (record.stopUnknown) throw new Error('Native producer stop is unconfirmed: ' + record.stopUnknown.reason)
      await this.updateWake(row.key, current => current && !current.delivered ? { ...current,
        admission: { ...current.admission, eligibleSince: current.admission?.eligibleSince ?? this.admissionNow(), phase: 'opening', executionId: record!.identity.executionId } } : undefined)
      const binding = this.binding(record, request)
      const resume = await this.gateway.exists(record.sessionId)
      const recentExchanges = request.role === 'Foreground'
        ? (await this.conversation.recentExchanges()).map(exchange => [exchange.human, ...exchange.assistants].map(message => ({ id: message.id, role: message.role, text: message.text, at: message.createdAt, source: message.participantId }))) : undefined
      if (this.closed) return
      const agent = await this.native.open(record.identity, { sessionId: record.sessionId, cwd: this.config.workspace,
        presetId: this.config.presetId, model: (request.role === 'Foreground' ? this.config.foreground : this.config.background ?? this.config.foreground) ?? this.config.model, resume, ...(recentExchanges ? { recentExchanges } : {}),
        setup: (scope, actual) => {
          if (row.value.recovery) scope.systemPrompt.section({ name: 'deepseek-servant:recovery-input', order: 102, interpolate: false,
            text: 'This owned execution is resuming after interruption. Before continuing, inspect the existing native inputs and saved Task material. Preserve original input identities; do not repeat already completed effects. Recovery facts: ' + JSON.stringify(request.context ?? {}) })
          scope.on('agent/status', event => {
            if (event.agent !== actual) return
            this.environment.changed?.()
            if (request.role === 'Foreground' && actual.status === 'idle' && !this.closed) {
              void this.serialWork(key, async () => {
                if (this.closed) return
                // Disposal emits idle before releasing its live Session. Keep this
                // capture owned, but acquire its evidence only after that exact stop.
                const stop = this.stopOperations?.get(JSON.stringify([key, record!.identity.executionId]))
                if (stop && !stop.settled) await stop.promise
                const current = this.roleRecords.get(key)
                if (!this.closed && current?.identity.executionId === record!.identity.executionId) await this.finishForegroundRound(current)
              }).catch(error => this.error(error, { identity: record!.identity, stage: 'foreground-round-capture' }))
            }
          })
          scope.on('agent/error', event => {
            if (event.agent === actual) this.error(event.error, { identity: record!.identity, turn: event.turn, step: event.step })
          })
          const skills = installFrameworkSkillProvider(scope, actual, this.files, { legacyScopes: this.config.legacySkillScopes, legacyGitParticipants: this.config.legacyGitSkillParticipants })
          this.skillProviders.set(record!.identity.executionId, skills)
          scope.effect(() => async () => { this.skillProviders.delete(record!.identity.executionId); await skills.dispose() }, 'dss.framework.skills')
          return installFrameworkRoleTools(scope, actual, binding, this.services())
        },
      })
      if (this.closed) return
      let recoveryInput: unknown
      if (request.taskId && request.sources.some(source => source.path.split('/').at(-1)?.endsWith('_Helper'))) {
        const path = this.recoveryInputPath(request.taskId, this.config.member, request.role)
        try {
          recoveryInput = await withSnapshot(this.files, snapshot => readJson(this.files, snapshot, path))
          if (recoveryInput === undefined) recoveryInput = { path, unavailable: 'Diagnostic input is absent; inspect the known notification sources and current task facts.' }
        } catch (error) {
          recoveryInput = { path, unavailable: error instanceof Error ? error.message : String(error) }
        }
      }
      const messageId = 'dss-wake-' + hash(request.id)
      const previousDelivery = this.roleRecords.get(key)?.delivery
      const text = row.value.recovery?.explanationText ?? (previousDelivery?.messageId === messageId && previousDelivery.text !== undefined ? previousDelivery.text
        : JSON.stringify({ taskId: request.taskId, reason: request.reason, sources: request.sources,
          context: request.context, ...(recoveryInput ? { recoveryInput } : {}), availableMembers: this.environment.members(), resources: this.environment.resources(), workerSeats: this.config.workerSeats }))
      if (row.value.recovery && row.value.recovery.explanationText === undefined) {
        row.value.recovery = { ...row.value.recovery, explanationText: text }
        await this.updateWake(row.key, current => current && !current.delivered ? { ...current, recovery: row.value.recovery } : undefined)
      }
      // Retrying one native message preserves its original payload even when
      // resources or diagnostics have changed since admission was attempted.
      await this.saveRole({ ...record, delivery: { request, messageId, text, confirmed: false } }, false, 'prepare')
      const recovery = row.value.recovery
      if (recovery?.original && recovery.original.messageId !== messageId) {
        const original = recovery.original
        const evidence = (await new DshSessionReader(this.ctx).inputs(record.sessionId)).get(original.messageId)
        if (!(original.confirmed && evidence === undefined) && evidence?.state !== 'consumed' && evidence?.state !== 'queued' && !(evidence?.state === 'claimed' && evidence.active)) {
          if (!(recovery.targetExecutionId !== undefined && recovery.confirmedStoppedExecutions?.includes(recovery.targetExecutionId))) throw new Error('Original recovery input has no confirmed prior execution stop.')
          const originalText = evidence?.text ?? original.text
          if (originalText === undefined) throw new Error('Original native recovery input body is unavailable; preserve its responsibility for diagnosis.')
          if (evidence && original.text !== undefined && original.text !== evidence.text) throw new Error('Original recovery input body conflicts with its saved identity.')
          await agent.send(originalText, original.messageId, 'followup', 'deepseek-servant')
        }
        const originalKey = this.prefix + 'wakes/' + hash(original.request.id)
        const originalWake = await this.records.get<WakeRecord>(originalKey)
        if (originalWake) await this.updateWake(originalKey, current => current ? { ...current, delivered: true, admission: undefined } : undefined)
      }
      // Native steer places this recovery explanation before queued business input
      // in the resumed turn; ordinary input retains its original delivery mode.
      await this.updateWake(row.key, current => current && !current.delivered ? { ...current,
        admission: { ...current.admission, eligibleSince: current.admission?.eligibleSince ?? this.admissionNow(), phase: 'sending', executionId: record!.identity.executionId } } : undefined)
      if (this.closed) return
      await agent.send(text, messageId, recovery ? 'steer' : 'followup', 'deepseek-servant', recovery ? {
        replayInactiveClaim: (recovery.targetExecutionId !== undefined && recovery.confirmedStoppedExecutions?.includes(recovery.targetExecutionId)) === true,
      } : undefined)
      await this.saveRole({ ...record, lastWake: request, delivery: { request, messageId, confirmed: true } }, false, 'confirm')
      await this.confirmAdoptedWakes(request, recovery)
      await this.updateWake(row.key, current => current ? { ...current, delivered: true, admission: undefined } : undefined)
      } catch (error) {
        const executionId = row.value.admission?.executionId ?? this.roleRecords.get(workId)?.identity.executionId
        const cancellation = executionId && this.admissionCancellations.get(executionId)
        if (cancellation === undefined || (error !== cancellation && !(error instanceof Error && error.name === 'AbortError' && error.cause === cancellation)
          && !(error instanceof DshAgentCreationCancelled && error.executionStopped && error.reason === cancellation)))
          this.error(error, { wakeId: row.value.request.id, role: row.value.request.role })
      } finally { this.workerAdmissions?.delete(workId) }
      })
      admissions.set(workId, operation)
      operations.push(operation)
      void operation.finally(() => { if (admissions.get(workId) === operation) admissions.delete(workId) }).catch(() => {})
      if (!waitForAdmissions) void operation.catch(error => this.error(error, { wakeId: row.value.request.id, role: row.value.request.role }))
    }
    if (waitForAdmissions) await this.settleOperations(operations, 'Native admissions failed')
  }
  /** Persist completed visible originals before retiring their native context.
   * Interrupted turns remain owned by the existing recovery responsibility. */
  private foregroundMessageSignature(message: object): string {
    return hash(JSON.stringify(Object.fromEntries(Object.entries(message).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)))))
  }
  private async ownForegroundMessage(record: RoleRecord, message: ConversationSend): Promise<void> {
    if (record.identity.role !== 'Foreground') return
    const current = this.roleRecords.get(record.identity.workId)
    if (!current || current.identity.executionId !== record.identity.executionId || current.released) throw new Error('Foreground output execution was replaced before saving its message.')
    const signature = this.foregroundMessageSignature(message), previous = current.foregroundMessages?.[message.id]
    if (previous && previous !== signature) throw new Error('Foreground output identity was reused for different content.')
    await this.saveRole({ ...current, foregroundMessages: { ...current.foregroundMessages, [message.id]: signature } })
  }
  private async finishForegroundRound(record: RoleRecord): Promise<void> {
    if (record.identity.role !== 'Foreground' || this.active(record)) return
    const stop = this.stopOperations?.get(JSON.stringify([record.identity.workId, record.identity.executionId]))
    // Discovery never waits for a stopping producer. Its already-owned idle
    // continuation retries capture after settlement, without holding other Tasks.
    if (stop && (!stop.settled || stop.result?.status !== 'stopped')) return
    const current = this.roleRecords.get(record.identity.workId)
    if (current?.identity.executionId !== record.identity.executionId) return
    if (!record.completedRound) {
      const sessions = new DshSessionReader(this.ctx)
      const capture = await sessions.capture(record.sessionId)
      if (!capture.finished) return
      if (record.delivery) {
        const input = (await sessions.inputs(record.sessionId)).get(record.delivery.messageId)
        if (input?.state !== 'consumed') return
      }
      const turns = captureForegroundTurns(await sessions.events(record.sessionId))
      for (const turn of turns) {
        if (!turn.final) continue
        const final = turn.final
        // A successful explicit send is already an authoritative reply. Only an
        // identical final rendering of that same turn is redundant, not a later
        // answer elsewhere in the conversation with coincidentally equal text.
        let alreadySaved = false
        for (const send of turn.sends) {
          if (send.text !== final.text) continue
          const saved = await this.conversation.read(send.id)
          if (saved?.role === 'assistant' && saved.text === final.text) alreadySaved = true
        }
        if (alreadySaved) {
          this.foregroundFinal = { executionId: record.identity.executionId, turn: turn.turn }
          this.environment.changed?.()
          continue
        }
        const sourceIds = turn.claimedMessageIds.length ? turn.claimedMessageIds : turn.readMessageIds
        const replyTo = sourceIds.length === 1 ? sourceIds[0] : undefined
        if (replyTo) {
          const original = await this.conversation.read(replyTo)
          if (original?.role !== 'user') throw new Error('Foreground claimed reply source is not a human message.')
        }
        const id = 'native-' + hash(JSON.stringify([record.sessionId, final.id]))
        const message: ConversationSend = { id, role: 'assistant', participantId: this.config.member,
          createdAt: final.at, text: final.text, source: 'model', recipient: 'human',
          ...(final.model ? { model: final.model } : {}), ...(replyTo ? { replyTo } : {}) }
        await this.ownForegroundMessage(record, message)
        // The native answer and message identity are already fixed. After a
        // proven CAS conflict rebuild only its append against the current index;
        // unknown submissions still reconcile their original operation receipt.
        for (;;) {
          try { await this.conversation.send('native-capture/' + id, message, { reevaluate: true }); break }
          catch (error) {
            if (!(error instanceof FilesConflictError) || this.closed) throw error
            const fresh = await this.files.snapshot()
            let changed: boolean
            try { changed = fresh.revision !== error.expectedRevision }
            finally { await fresh.release() }
            if (!changed || this.closed || this.roleRecords.get(record.identity.workId)?.identity.executionId !== record.identity.executionId) throw error
            // Keep the exact captured native answer and operation. Only its
            // append/index plan is re-evaluated after a proven competing write.
          }
        }
        // Display completion follows verified visible native final, not the later
        // lifecycle receipt write. This is local presentation evidence only.
        this.foregroundFinal = { executionId: record.identity.executionId, turn: turn.turn }
        this.environment.changed?.()
      }
      await this.saveRole({ ...record, completedRound: true })
      record = this.roleRecords.get(record.identity.workId)!
      this.environment.changed?.()
    }
    // Retirement owns the same asynchronous stop responsibility as other roles.
    // An idle turn is not permission to block unrelated Task admission or to
    // replace an execution whose native producer has not confirmed settlement.
    this.trackedStop(record)
  }
  private binding(record: RoleRecord, request: RoleWake): FrameworkRoleBinding {
    const identity = record.identity, base: FrameworkRoleBinding = { ...identity, owner: this.config.member, collaborationId: this.config.collaborationId }
    const direct = request.sources.map(source => ({ source, direct: parseDirectSignal(source.path.split('/').at(-1)!) })).find(value => value.direct)
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
    if (identity.role === 'Helper') base.recordPath = 'debug/' + new Date().toISOString().slice(0,10) + '.md'
    return base
  }
  async notifications(snapshot: FilesSnapshot, binding: FrameworkRoleBinding, selectedTaskId?: string): Promise<string[]> {
    if (binding.direct) return await this.files.read(snapshot, binding.direct.signalPath) === undefined ? [] : [binding.direct.signalPath]
    const taskId = binding.taskId ?? selectedTaskId
    if (binding.role === 'Foreground') {
      const indexed = new Set(await this.conversation.notificationPaths(snapshot))
      return (await this.files.listDirectory(snapshot, 'state/')).filter(entry => entry.path.split('/').at(-1)!.startsWith('Foreground_') && !indexed.has(entry.path)).map(entry => entry.path)
    }
    if (!taskId) return []
    if (binding.role === 'Organizer') {
      const task = await readJson<TaskMetadata>(this.files, snapshot, paths.task(taskId))
      if (!task || task.owner !== this.config.member) return []
      const signals = await this.files.listDirectory(snapshot, paths.state(this.config.member, taskId))
      const result = signals.filter(entry => entry.path.split('/').at(-1)!.startsWith('Organizer_')).map(entry => entry.path)
      for (const member of task.members ?? this.environment.members()) {
        const path = paths.state(member, taskId) + '/complete'
        const memberSignals = member === this.config.member ? signals : await this.files.listDirectory(snapshot, paths.state(member, taskId))
        if (memberSignals.some(entry => entry.path === path)) result.push(path)
      }
      return result
    }
    const entries = await this.files.listDirectory(snapshot, paths.state(this.config.member, taskId))
    return entries.filter(entry => binding.role === 'Worker' ? signalWorkerId(entry.path.split('/').at(-1)!) === binding.workerId
      : entry.path.split('/').at(-1)!.startsWith(binding.role + '_')).map(entry => entry.path)
  }
  private services(): FrameworkRoleServices {
    return {
      files: this.files, transact: async (id, request, options, build) => {
        const receipt = await this.transactions.run(id, request, options, build)
        if (!receipt.replay) this.environment.changed?.()
        return receipt
      },
      skillsChanged: () => this.invalidateSkills(),
      skillResourceAllowed: (binding, path) => this.skillProviders.get(binding.executionId)?.canReadResource(path) ?? false,
      notifications: (snapshot, binding, taskId) => this.notifications(snapshot, binding, taskId), onError: error => this.error(error),
      afterRecoveryConsumed: async (binding, member, receipt) => {
        const receiptId = receipt.operationId ?? receipt.revision
        const doneKey = this.prefix + 'recovery-consumed/' + hash(JSON.stringify([member, receiptId]))
        if (await this.records.get(doneKey)) return
        await this.serialRecoveryWatch(member.taskId, member.member, async key => {
          const prior = await this.records.get<RecoveryWatchRecord>(key)
          if (!prior?.consumedReceipts?.includes(receiptId)) await this.records.set(key, {
            ...prior, watch: undefined, consumedReceipts: [...(prior?.consumedReceipts ?? []), receiptId],
          })
        })
        await this.records.set(doneKey, true)
      },
      conversation: {
        foregroundRoot: this.conversation.foregroundRoot,
        read: async input => {
          if (input.mode === 'search') return this.conversation.search(input.query ?? '', input.cursor, input.limit)
          if (input.mode === 'text') return this.conversation.readText(input.reference ?? '', input.cursor, input.limit)
          if (input.mode === 'message') return this.conversation.read(input.reference ?? '')
          if (input.mode === 'recent') return this.conversation.recentExchanges()
          if (input.mode === 'pending') return this.conversation.pendingForeground()
          if (input.mode === 'memory') return this.conversation.readForeground()
          // A default page holds six complete exchanges plus nearby context; it is not a history limit.
          return this.conversation.page(input.limit ?? 20, input.beforeId)
        },
        send: async (input, binding, commandId) => {
          const key = this.prefix + 'message-source/' + hash(commandId)
          let source = await this.records.get<{ createdAt: string; model?: string }>(key)
          if (!source) {
            const actual = this.native.get(binding.workId)?.actualAgent
            const context = actual?.session.requestContext()
            source = { createdAt: new Date().toISOString(), ...(context?.model ? { model: context.model } : {}) }
            await this.records.set(key, source)
          }
          const message: ConversationSend = { id: input.id, text: input.text, role: 'assistant', participantId: this.config.member,
            ...source, recipient: input.intent, ...(input.replyTo ? { replyTo: input.replyTo } : {}) }
          if (binding.role === 'Foreground') {
            const owner = this.roleRecords.get(binding.workId)
            if (!owner || owner.identity.executionId !== binding.executionId) throw new Error('Foreground message belongs to a replaced execution.')
            await this.ownForegroundMessage(owner, message)
          }
          const receipt = await this.conversation.send(commandId, message)
          if (binding.role === 'Foreground' && message.recipient === 'human') {
            const owner = this.roleRecords.get(binding.workId), agent = this.native.get(binding.workId)?.actualAgent
            const turn = agent && this.foregroundActivity?.read(agent.session)
            if (owner?.identity.executionId === binding.executionId && turn && !turn.end)
              this.foregroundVisibility = { executionId: binding.executionId, turnId: JSON.stringify([owner.sessionId, turn.turn, turn.startSeq]) }
          }
          if (!receipt.replay) this.environment.changed?.()
          return receipt
        },
        claim: (input, _binding, commandId) => this.conversation.claimForeground(commandId, input.messageIds,
          { list: input.list, cache: input.cache }, { expectedRevision: input.expectedRevision }),
      },
      artifacts: { preserve: async (agent, input, _binding, commandId, options) => {
        const cwd = await this.ctx.workingDirectory.ensure(agent, options.signal)
        return new FrameworkArtifacts(this.ctx, this.files, this.transactions, this.config.workspace).preserve(commandId, input, { ...options, cwd })
      } },
      ...(this.environment.capacity ? { capacity: this.environment.capacity } : {}),
      observation: { reset: (binding, input, commandId, signal) => this.resetObservation(binding, input.probeId, commandId, signal) },
      helper: {
        request: async (binding, facts, commandId) => { await this.wake({ id: 'help:' + commandId, role: 'Helper', reason: 'helper', sources: [], context: { target: binding, facts } }); return { arranged: true } },
        restore: async (binding, input, commandId) => {
          const key = this.prefix + 'restores/' + hash(commandId)
          const caller = this.roleRecords.get(binding.workId)
          const diagnostic = caller?.identity.executionId === binding.executionId ? (caller.delivery?.request ?? caller.lastWake)?.context : undefined
          const admissionWakeId = diagnostic?.kind === 'admission-timeout' && typeof diagnostic.wakeId === 'string'
            && (input.wakeId === diagnostic.wakeId || (input.target && input.target.workId === diagnostic.workId && input.target.executionId === diagnostic.executionId)) ? diagnostic.wakeId : undefined
          if (!await this.records.get(key)) await this.records.set(key, { commandId, requester: binding, input, ...(admissionWakeId ? { admissionWakeId } : {}), createdAt: new Date().toISOString(), complete: false })
          return { arranged: true }
        },
        restoreHost: async (binding, input, commandId) => {
          const key = this.prefix + 'host-restores/' + hash(commandId)
          if (!await this.records.get(key)) await this.records.set(key, { commandId, requester: binding, input, createdAt: new Date().toISOString(), complete: false })
          return { arranged: true }
        },

      },
    }
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
    if (!current() || await this.controls.execution(binding.executionId)
      || await this.controls.taskHeld(await this.currentTask(record!)) || !current()) throw new Error('Observation reset belongs to an unavailable execution.')
    const original = (await new DshSessionReader(this.ctx).inputs(record!.sessionId)).get(probeId)
    const issued = await this.records.get<ObservationRecord>(this.prefix + 'observations/' + hash(probeId))
    if (original?.state !== 'consumed' || original.source !== 'deepseek-servant'
      || issued?.pending.id !== probeId || issued.pending.action.identity.workId !== binding.workId
      || issued.pending.action.identity.executionId !== binding.executionId || issued.pending.action.stage === 3)
      throw new Error('Reset requires an actually received Host probe or warning for this execution.')
    const envelope = JSON.parse(original.text) as { kind?: string; probeId?: string }
    if (!['probe-role', 'warn-role', 'probe-helper', 'warn-helper'].includes(envelope.kind ?? ''))
      throw new Error('Native input is not a Host inactivity probe or warning.')
    const prefix = String(agent!.actualAgent.id) + ':'
    if (!commandId.startsWith(prefix)) throw new Error('Reset command does not belong to its native caller.')
    const callId = commandId.slice(prefix.length)
    const call = agent!.getMessages().flatMap(message => message.role === 'assistant' && typeof message.content !== 'string' ? message.content : [])
      .find(block => block.type === 'tool-call' && String(block.id) === callId && block.name === 'dss_reset_observation')
    if (!call || call.type !== 'tool-call' || JSON.parse(call.arguments).probeId !== probeId) throw new Error('Reset differs from its original native tool call.')
    signal.throwIfAborted()
    if (!current() || await this.controls.execution(binding.executionId)
      || await this.controls.taskHeld(await this.currentTask(record!)) || !current()) throw new Error('Execution changed before observation reset.')
    signal.throwIfAborted()
    await this.observations.reset(record!.identity, probeId, issued.pending.cycleStartedAt)
    return { reset: true, probeId }
  }
  /** Applies to the next Foreground admission; never rewrites a running native turn. */
  setForegroundModel(model: DshModelRoute | undefined): void {
    this.config.foreground = model ? { ...model } : undefined
  }
  invalidateSkills(): void { for (const provider of this.skillProviders.values()) provider.invalidate() }
  private watchKey(taskId: string, member: string): string { return this.prefix + 'recovery-watch/' + hash(JSON.stringify([taskId, member])) }
  private async serialRecoveryWatch<T>(taskId: string, member: string, operation: (key: string) => Promise<T>): Promise<T> {
    const key = this.watchKey(taskId, member)
    const writes = this.recoveryWatchWrites ??= new Map()
    const pending = (writes.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => operation(key))
    writes.set(key, pending)
    try { return await pending }
    finally { if (writes.get(key) === pending) writes.delete(key) }
  }
  private async taskMetadata(snapshot: FilesSnapshot): Promise<TaskMetadata[]> {
    this.taskMetadataIndex ??= new FrameworkTaskIndex(this.files, error => this.error(error))
    return this.taskMetadataIndex.list(snapshot)
  }
  private async scanMembers(snapshot: FilesSnapshot): Promise<MemberRecoveryInput[]> {
    const result: MemberRecoveryInput[] = []
    for (const task of await this.taskMetadata(snapshot)) {
      try {
      if (task.status !== 'running' || await this.manuallyCleared(task.taskId, snapshot)) continue
      const member = this.config.member, inbox = paths.inbox(task.taskId, member)
      const entries = await this.files.listDirectory(snapshot, inbox.slice(0, inbox.lastIndexOf('/')))
      const entry = entries.find(item => item.path === inbox)
      if (!entry) continue
      const status = await readMemberStatus(this.files, snapshot, paths.memberStatus(task.taskId, member))
      const eligibility = { inboxBodyBytes: entry.bytes ?? (entry.empty ? 0 : Buffer.byteLength(await this.files.read(snapshot, inbox) ?? '', 'utf8')),
        status: status?.state ?? 'running', pendingBusiness: status?.state !== 'complete' }
      if (!memberRecoveryEligible(eligibility)) continue
      // Startup notes are a recovery-only check, not an activity monitor. An
      // actual Worker can exist without a notes file, so check its owned role first.
      if ([...this.roleRecords.values()].some(record => record.identity.role === 'Worker'
        && record.identity.taskId === task.taskId && this.active(record))) continue
      const planner = this.roleRecords.get(this.roleKey('Planner', task.taskId))
      const workers: MemberRecoveryInput['workers'][number][] = []
      const root = paths.member(task.taskId, member) + '/workers/'
      for (const note of await this.files.list(snapshot, root)) {
        if (!note.path.endsWith('/notes.md')) continue
        const workerId = note.path.slice(root.length).split('/')[0]!
        const record = this.roleRecords.get(this.roleKey('Worker', task.taskId, workerId))
        workers.push({ workerId, executionId: record?.identity.executionId ?? '', notePath: note.path,
          noteBodyBytes: note.bytes ?? (note.empty ? 0 : Buffer.byteLength(await this.files.read(snapshot, note.path) ?? '', 'utf8')),
          executing: record ? this.active(record) : false })
      }
      result.push({ taskId: task.taskId, member, taskPath: task.sourcePath, inboxPath: inbox,
        ...eligibility, needsRecovery: true,
        plannerExecutionId: planner?.identity.executionId ?? '', plannerMemoryPath: paths.member(task.taskId, member) + '/Planner_Memory.md',
        plannerExecuting: planner ? this.active(planner) : false, workers,
        pendingSignals: (await this.files.listDirectory(snapshot, paths.state(member, task.taskId))).map(signal => signal.path) })
      } catch (error) { this.error(error) }
    }
    return result
  }
  private async arrangeNativeContinuation(record: RoleRecord, context: Record<string, unknown>,
    inspection?: DshSessionInspection, explicitId?: string, fallback?: RoleWake, replacement?: RoleWake): Promise<RoleWake | undefined> {
    if (record.released || await this.controls.execution(record.identity.executionId)) return undefined
    if (['Planner', 'Worker', 'Organizer', 'Recorder'].includes(record.identity.role) && await this.manuallyCleared(await this.currentTask(record))) return undefined
    if (!replacement) {
      const pending = (await this.records.list<WakeRecord>(this.prefix + 'wakes/')).find(row => !row.value.delivered
        && row.value.request.id !== record.delivery?.request.id
        && row.value.recovery?.targetExecutionId === record.identity.executionId
        && this.requestKey(row.value.request) === record.identity.workId)
      if (pending) return pending.value.request
    }
    const inputs = record.delivery ? await new DshSessionReader(this.ctx).inputs(record.sessionId) : new Map()
    const resolved = resolveNativeRecoveryInput(record.delivery, record.lastWake ?? fallback, inputs)
    if (!resolved || resolved.active) return undefined
    const prior = await this.records.get<WakeRecord>(this.prefix + 'wakes/' + hash(resolved.request.id))
    if (prior?.recovery && resolved.state === 'unknown') throw new Error('Confirmed recovery input has no available native consumption evidence; preserve it for diagnosis.')
    const reuse = prior?.recovery && resolved.state !== 'consumed' && !replacement
    const request: RoleWake = reuse ? prior.request : { ...(replacement ?? resolved.request),
      id: replacement?.id ?? explicitId ?? nativeRecoveryWakeId(record.sessionId, inspection?.lastTurn?.turn,
        resolved.messageId ?? resolved.request.id), reason: replacement?.reason ?? 'startup-recovery',
      context: { ...context, originalMessageId: resolved.messageId, nativeInputState: resolved.state,
        interruptedTurn: inspection?.lastTurn } }
    const recovery: WakeRecovery = reuse ? { ...prior.recovery!, explanationText: prior.recovery!.explanationText ?? resolved.text } : { targetExecutionId: record.identity.executionId,
      ...(!record.delivery && fallback && resolved.request.id === fallback.id ? { replacesUnadmittedWake: fallback.id } : {}),
      ...(record.delivery ? { original: { ...record.delivery, text: resolved.text } } : {}) }
    await this.wake(request, recovery)
    return request
  }
  private async startup(): Promise<void> {
    try { await this.processObservations(true) } catch (error) { this.error(error) }
    const restoring = new Set((await this.records.list<ObservationRecord>(this.prefix + 'observations/'))
      .filter(row => !row.value.complete && row.value.stopStarted).map(row => row.value.pending.action.identity.executionId))
    const members = await withSnapshot(this.files, snapshot => this.scanMembers(snapshot))
    const targets = scanMemberRecovery(members)
    const continuations: RoleWake[] = []
    const sessions = new DshSessionReader(this.ctx)
    for (const record of this.roleRecords.values()) {
      if (record.identity.role === 'Foreground' && this.pendingForegroundResets?.size) continue
      if (record.completedRound) {
        try { await this.serialWork(record.identity.workId, () => this.finishForegroundRound(record)) }
        catch (error) { this.error(error, { identity: record.identity, stage: 'startup-foreground-retirement' }) }
        continue
      }
      if (restoring.has(record.identity.executionId) || !['Foreground', 'Organizer', 'Recorder', 'Helper'].includes(record.identity.role) || this.active(record) || (!record.lastWake && !record.delivery)) continue
      if (['Organizer', 'Recorder'].includes(record.identity.role) && await this.manuallyCleared(await this.currentTask(record))) continue
      let inspection
      try { inspection = await sessions.inspect(record.sessionId) }
      catch (error) {
        this.error(error, { identity: record.identity, sessionId: record.sessionId, stage: 'startup-session-inspection' })
        continue
      }
      if (!inspection.exists || !inspection.lifecycleKnown) continue
      if (record.identity.role === 'Foreground' && inspection.lastTurn?.reason === 'completed') {
        try { await this.serialWork(record.identity.workId, () => this.finishForegroundRound(record)) }
        catch (error) { this.error(error, { identity: record.identity, stage: 'startup-foreground-capture' }); continue }
        if (this.roleRecords.get(record.identity.workId)?.completedRound) continue
      }
      const hostDisposed = inspection.lastTurn?.reason === 'aborted' && inspection.lastTurn.abortCause === 'disposed'
      if (record.stopped && !hostDisposed) continue
      if (await this.controls.execution(record.identity.executionId)) continue
      const interrupted = inspection.lastTurn && (!inspection.lastTurn.closed || inspection.lastTurn.reason === 'interrupted' || hostDisposed)
      if (!interrupted && !inspection.unresolvedToolCallIds.length && !inspection.queuedInbox.nextTurn.length && !inspection.queuedInbox.nextStep.length) continue
      try {
        const continuation = await this.arrangeNativeContinuation(record, {
          facts: 'Persisted native execution did not finish. Inspect existing inputs and saved work before continuing the original responsibility.' }, inspection)
        if (continuation) continuations.push(continuation)
      } catch (error) { this.error(error, { identity: record.identity, sessionId: record.sessionId, stage: 'startup-input-inspection' }) }
    }
    // Every member target is collected before its recovery wake is arranged.
    for (const target of targets) {
      const request: RoleWake = { id: 'startup:' + this.bootId + ':' + hash(JSON.stringify([target.taskId, target.role, target.workerId, target.executionId])),
        role: target.role, taskId: target.taskId, workerId: target.workerId, reason: 'startup-recovery',
        sources: [{ path: target.recordPath, version: 'startup' }], context: { taskPath: target.taskPath, pendingSignals: target.pendingSignals } }
      const record = this.roleRecords.get(this.roleKey(target.role, target.taskId, target.workerId))
      if (!record) { await this.wake(request); continue }
      try {
        const inspection = await sessions.inspect(record.sessionId)
        // Existing native executions retain their input identity and exact stop
        // evidence even when member notes are the recovery discovery source.
        const continuation = await this.arrangeNativeContinuation(record, {
          ...request.context, recordPath: target.recordPath,
          facts: 'Saved member material requires continuation. Inspect original native inputs and current notes before acting.' },
          inspection, undefined, { ...request, id: 'member-material:' + record.identity.executionId })
        if (continuation) continuations.push(continuation)
      } catch (error) { this.error(error, { identity: record.identity, sessionId: record.sessionId, stage: 'startup-member-input-inspection' }) }
    }
    if (targets.length || continuations.length) await this.wake({ id: 'startup-helper:' + randomUUID(), role: 'Helper', reason: 'startup-recovery', sources: [], context: { targets, continuations } })
    this.startOwnedPump()
  }
  private async currentTask(record: RoleRecord): Promise<string | undefined> {
    if (record.identity.taskId) return record.identity.taskId
    const delivery = record.delivery
    if (!delivery || delivery.confirmed) return (delivery?.request ?? record.lastWake)?.taskId
    // Admission precedes the native durability barrier. Resolve an uncertain
    // delivery by its existing native message identity, not by a prior Task label.
    const owned = this.native.get(record.identity.workId)
    const admitted = owned ? owned.hasMessage(delivery.messageId) : await new DshSessionReader(this.ctx).hasMessage(record.sessionId, delivery.messageId)
    return admitted ? delivery.request.taskId : record.lastWake?.taskId
  }
  async applyUserControls(waitForStops = true, waitTarget?: { taskId?: string; workId?: string; executionId?: string }): Promise<void> {
    let changed = false
    const operations: Promise<void>[] = [], waiting = new Set<TrackedStop>()
    const busyAtEntry = new Set(this.workOperations?.keys() ?? [])
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
        || (waitTarget.taskId !== undefined && waitTarget.taskId === taskId))) waiting.add(stop)
      return undefined
    }
    for (const candidate of [...this.roleRecords.values()]) {
      if (!['Planner', 'Worker', 'Organizer'].includes(candidate.identity.role)) continue
      if (!waitForStops && busyAtEntry.has(candidate.identity.workId)) continue
      operations.push(this.serialWork(candidate.identity.workId, async () => {
        const record = this.roleRecords.get(candidate.identity.workId)
        if (!record || !['Planner', 'Worker', 'Organizer'].includes(record.identity.role) || record.stopped || record.stopUnknown) return
        let taskId: string | undefined
        try { taskId = await this.currentTask(record) } catch (error) { this.error(error, { identity: record.identity, delivery: record.delivery }); return }
        if (!await this.controls.taskHeld(taskId)) return
        changed = true
        requestStop(record, taskId)
      }))
    }
    for (const request of await this.controls.pendingStops()) {
      if (!waitForStops && busyAtEntry.has(request.workId)) continue
      operations.push(this.serialWork(request.workId, async () => {
        changed = true
        const record = this.roleRecords.get(request.workId)
        const result = !record || record.identity.executionId !== request.executionId ? { status: 'superseded' as const }
          : requestStop(record, record.identity.taskId, request.commandId)
        if (!result) return
        await this.controls.settleExecution(request.commandId, request.executionId, { state: result.status,
          ...(result.status === 'unconfirmed' ? { detail: result.reason, jobs: result.jobs } : {}) })
      }))
    }
    const outcomes = await Promise.allSettled(operations)
    if (changed) this.environment.changed?.()
    const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected').map(outcome => outcome.reason)
    if (waitForStops && waiting.size) {
      await Promise.all([...waiting].map(stop => stop.promise))
      failures.push(...[...waiting].filter(stop => stop.failure !== undefined).map(stop => stop.failure))
      // Persist actual exact-request outcomes after confirmation, outside work
      // admission locks. The discovery caller never waits for producer promises.
      if (!failures.length) await this.applyUserControls(false)
    }
    if (failures.length) throw new AggregateError(failures, 'Native execution controls failed')
  }
  async requestExecutionStop(commandId: string, workId: string, executionId: string): Promise<void> {
    const record = this.roleRecords.get(workId)
    if (!record || record.identity.executionId !== executionId) throw new Error('The selected native execution is no longer owned by this Host.')
    await this.controls.requestExecutionStop(commandId, { workId, executionId, taskId: record.identity.taskId })
    await this.applyUserControls(true, { workId, executionId })
  }
  async resumeTask(taskId: string, commandId: string): Promise<void> {
    if (await this.manuallyCleared(taskId)) throw new Error('This Task history was explicitly cleared. Create a new Task.')
    const members = await withSnapshot(this.files, snapshot => this.scanMembers(snapshot))
    for (const target of scanMemberRecovery(members.filter(member => member.taskId === taskId))) {
      const request: RoleWake = { id: 'user-resume:' + commandId + ':' + target.role + ':' + (target.workerId ?? ''), role: target.role, taskId, workerId: target.workerId,
        reason: 'user-resume', sources: [{ path: target.recordPath, version: 'user-resume' }], context: { userRequestedResume: true, taskPath: target.taskPath, recordPath: target.recordPath } }
      await this.serialWork(this.requestKey(request), async () => {
        const record = this.roleRecords.get(this.requestKey(request))
        if (!record) { await this.wake(request); return }
        const inspection = await new DshSessionReader(this.ctx).inspect(record.sessionId)
        await this.arrangeNativeContinuation(record, request.context!, inspection, request.id, request, request)
      })
    }
    await this.serialWork(this.roleKey('Organizer'), async () => {
      const organizer = this.roleRecords.get(this.roleKey('Organizer'))
      if (!organizer?.stopped || await this.currentTask(organizer) !== taskId) return
      // An unadmitted newer input does not change which Task the user resumed.
      const current = organizer.delivery?.request.taskId !== taskId ? { ...organizer, delivery: undefined } : organizer
      const request: RoleWake = { ...(current.delivery?.request ?? current.lastWake!), id: 'user-resume:' + commandId + ':Organizer',
        role: 'Organizer', taskId, reason: 'user-resume', sources: (current.delivery?.request ?? current.lastWake)?.sources ?? [], context: { userRequestedResume: true } }
      const inspection = await new DshSessionReader(this.ctx).inspect(organizer.sessionId)
      await this.arrangeNativeContinuation(current, request.context!, inspection, request.id, request, request)
    })
    await this.pump()
  }
  private startMaintenance(key: string, action: () => Promise<void>): void {
    const maintenance = this.maintenance ??= new Map()
    if (this.closed || maintenance.has(key)) return
    const operation = Promise.resolve().then(() => { if (!this.closed) return action() })
    maintenance.set(key, operation)
    void operation.catch(error => this.error(error)).finally(() => { if (maintenance.get(key) === operation) maintenance.delete(key) })
  }
  private async observe(): Promise<void> {
    if (this.closed) return
    this.startMaintenance('heartbeat', () => this.environment.heartbeat())
    // Own a separate view: discovery's borrowed snapshot must never outlive its poll.
    if (this.environment.observeResources) this.startMaintenance('resources', () => withSnapshot(this.files, async snapshot => {
      if (!this.closed) await this.environment.observeResources!(snapshot)
    }))
    if (this.closed) return
    try { await this.applyUserControls(false) } catch (error) { this.error(error) }
    if (this.closed) return
    try { await this.processObservations(false, 'settle', false) } catch (error) { this.error(error) }
    if (this.closed) return
    this.startRestoration()
    if (this.closed) return
    await this.processSealedBusiness()
    if (this.closed) return
    await this.errorTail
    this.startOwnedPump()
  }
  private async ownerRecoveryChanges(snapshot: FilesSnapshot, taskId: string): Promise<Array<{ path: string; content: string }>> {
    // Final cleanup is a namespace retirement, including a completed Recorder's R.
    if (await readJson(this.files, snapshot, cleanupRecordPath(taskId))) return []
    const task = await readJson<TaskMetadata>(this.files, snapshot, paths.task(taskId))
    return task ? [{ path: paths.state(task.owner, taskId) + '/recovery', content: '' }] : []
  }
  private async publishOwnerRecovery(commandId: string, record: RoleRecord): Promise<void> {
    if (record.identity.role !== 'Organizer' && record.identity.role !== 'Recorder') return
    const taskId = await this.currentTask(record)
    if (!taskId) return
    await this.transactions.run(commandId, { taskId, role: record.identity.role, executionId: record.identity.executionId },
      { reevaluate: true }, snapshot => this.ownerRecoveryChanges(snapshot, taskId))
  }
  private async observeRecoveryMarkers(borrowed?: FilesSnapshot, tasks?: readonly TaskMetadata[]): Promise<void> {
    const inspect = async (snapshot: FilesSnapshot) => {
      for (const task of tasks ?? await this.taskMetadata(snapshot)) {
        if (this.closed) return
        if (await readJson(this.files, snapshot, cleanupRecordPath(task.taskId)) || await this.manuallyCleared(task.taskId, snapshot)) continue
        const marker = paths.state(this.config.member, task.taskId) + '/recovery'
        const entries = await this.files.listDirectory(snapshot, paths.state(this.config.member, task.taskId))
        if (!entries.some(entry => entry.path === marker)) continue
        await this.serialRecoveryWatch(task.taskId, this.config.member, async key => {
          if (this.closed) return
          const record = await this.records.get<RecoveryWatchRecord>(key)
          if (this.closed || record?.released) return
          // Acquire the marker view after prior consumption writes, not from the
          // task enumeration snapshot taken before this key's writer queue.
          await withSnapshot(this.files, async current => {
            const marker = paths.state(this.config.member, task.taskId) + '/recovery'
            if (await this.files.read(current, marker) === undefined) return
            const watch = record?.watch ?? createRecoveryWatch({ taskId: task.taskId, member: this.config.member }, Date.now())
            const due = dueRecoveryWatch(watch, Date.now())
            if (!record?.watch || due.state !== record.watch) await this.records.set(key, { ...record, watch: due.state })
            if (due.action) await this.wake({ id: 'recovery-check:' + hash(JSON.stringify([watch.taskId, watch.member, watch.cycleStartedAt, due.action.stage])),
              role: 'Helper', taskId: task.taskId, reason: 'observation', sources: [{ path: marker, version: current.revision }], context: { observation: due.action } })
          })
        })
      }
    }
    await (borrowed ? inspect(borrowed) : withSnapshot(this.files, inspect))
  }
  private async enqueueObservation(pending: ScheduledObservation): Promise<void> {
    const key = this.prefix + 'observations/' + hash(pending.id)
    if (!await this.records.get(key)) await this.records.set(key, { pending, complete: false })
  }
  private async processObservations(startedOnly = false, lane: 'all' | 'native' | 'settle' = 'all', waitForDelivery = true): Promise<void> {
    // Each durable action owns its delivery, outside tick's metadata queue. A
    // pending accept cannot hold another execution or the next local 5/5/30 tick.
    const owned = this.observationOperations ??= new Map<string, Promise<void>>()
    const operations: Promise<void>[] = []
    for (const row of await this.records.list<ObservationRecord>(this.prefix + 'observations/')) {
      if (this.closed) break
      if (row.value.complete || (startedOnly && !row.value.stopStarted)) continue
      if (lane === 'settle' && (row.value.pending.action.stage !== 3 || !row.value.stopStarted)) continue
      let operation = owned.get(row.key)
      if (!operation) {
        operation = Promise.resolve().then(async () => {
          if (this.closed || await this.arrangeObservation(row.value.pending, lane) === false || this.closed) return
          await this.records.set(row.key, { ...(await this.records.get<ObservationRecord>(row.key) ?? row.value), complete: true })
        })
        owned.set(row.key, operation)
        const tracked = operation
        void operation.finally(() => { if (owned.get(row.key) === tracked) owned.delete(row.key) }).catch(() => {})
        if (!waitForDelivery) void operation.catch(error => this.error(error, { identity: row.value.pending.action.identity, probeId: row.value.pending.id }))
      }
      operations.push(operation)
    }
    if (waitForDelivery) await this.settleOperations(operations, 'Native observation arrangements failed')
  }
  private async arrangeObservation(pending: ScheduledObservation, lane: 'all' | 'native' | 'settle' = 'all'): Promise<boolean | void> {
    const action = pending.action
    // Foreground belongs to the native front-end lifecycle, including old queued observations.
    if (action.identity.role === 'Foreground' || this.closed) return
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
    if (!record || this.closed || await this.controls.execution(action.identity.executionId)
      || await this.controls.taskHeld(await this.currentTask(record)) || this.closed) return
    if (action.stage !== 3) {
      if (record.stopped || record.stopIntent || record.stopUnknown) return
      const agent = this.native.get(workId)
      if (!agent || agent.sessionId !== record.sessionId || this.closed) return
      if (!await this.observations.mayApply(pending)) { await this.observations.deferUnperformed(pending); return }
      const kind = action.identity.role === 'Helper'
        ? action.stage === 1 ? 'probe-helper' : 'warn-helper'
        : action.stage === 1 ? 'probe-role' : 'warn-role'
      try {
        await agent.send(JSON.stringify({ kind, probeId: pending.id, identity: action.identity,
          elapsedMs: action.elapsedMs, silentMs: action.silentMs,
          instruction: 'If you receive this Host inactivity notice, call dss_reset_observation with this probeId, organize your current status in your existing role records, then continue the original work. Queued delivery alone is not a response.' }),
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
      if (!record || await this.controls.execution(action.identity.executionId)
        || await this.controls.taskHeld(await this.currentTask(record)) || this.closed) return
      if (!saved?.stopStarted) {
        if (!await this.observations.mayApply(pending)) { await this.observations.deferUnperformed(pending); return }
        await this.records.set(key, { pending, complete: false, stopStarted: true } satisfies ObservationRecord)
      }
      if (this.closed) return false
      // The stop owns its promise; one unresponsive execution cannot block other targets.
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
      if (await this.controls.execution(action.identity.executionId)
        || await this.controls.taskHeld(await this.currentTask(record)) || this.closed) return
      const context = { facts: 'The Host observed no effective native output/tool progress through the 5/5/30 inactivity sequence and confirmed the old execution stopped. Preserve the original records and inspect the original work before continuing.',
        previousIntervention: action, elapsedMs: action.elapsedMs }
      if (action.identity.role === 'Helper') {
        const request: RoleWake = { id: 'overall-restore:' + pending.id, role: 'Helper', reason: 'observation', sources: [],
          context: { ...context, overallRestoration: true } }
        const inspection = await new DshSessionReader(this.ctx).inspect(record.sessionId)
        if (this.closed) return false
        await this.arrangeNativeContinuation(record, request.context!, inspection, request.id, request, request)
        return
      }
      if (record.identity.taskId && record.identity.member && (record.identity.role === 'Planner' || record.identity.role === 'Worker')) {
        const taskId = record.identity.taskId, member = record.identity.member
        await this.transactions.run('observation-recovery:' + pending.id, { taskId, member, executionId: record.identity.executionId }, { reevaluate: true }, async snapshot => {
          if (await this.manuallyCleared(taskId, snapshot) || await readJson(this.files, snapshot, cleanupRecordPath(taskId))) return []
          const task = await readJson<TaskMetadata>(this.files, snapshot, paths.task(taskId))
          const status = await readMemberStatus(this.files, snapshot, paths.memberStatus(taskId, member))
          const inbox = await this.files.read(snapshot, paths.inbox(taskId, member))
          if (task?.status !== 'running' || status?.state === 'complete' || !inbox?.length) return []
          return [{ path: paths.state(member, taskId) + '/recovery', content: '' }]
        })
        if (this.closed) return false
        if (record.identity.role === 'Worker') await this.wake({ id: 'observation-planner:' + pending.id, role: 'Planner', taskId,
          reason: 'startup-recovery', sources: [], context })
      }
      if (this.closed) return false
      await this.publishOwnerRecovery('observation-owner-recovery:' + pending.id, record)
      if (this.closed) return false
      const inspection = await new DshSessionReader(this.ctx).inspect(record.sessionId)
      if (this.closed) return false
      await this.arrangeNativeContinuation(record, context, inspection, 'observation-restart:' + pending.id)
    })
  }
  private async clean(task: TaskMetadata, snapshot: FilesSnapshot): Promise<boolean> {
    let current = snapshot, owned: FilesSnapshot | undefined
    try {
      for (;;) {
        try { return await this.cleanAt(task, current) }
        catch (error) {
          if (!(error instanceof FilesConflictError) || this.closed) throw error
          const fresh = await this.files.snapshot()
          if (this.closed || fresh.revision === error.expectedRevision) {
            await fresh.release()
            throw error
          }
          const previous = owned
          owned = fresh
          current = fresh
          await previous?.release()
          if (this.closed) throw error
          // A proven new HEAD invalidates only the attempt, not this cleanup
          // responsibility. Recheck originals and ownership at the fresh view.
        }
      }
    } finally { await owned?.release() }
  }
  private async cleanAt(task: TaskMetadata, snapshot: FilesSnapshot): Promise<boolean> {
    const marker = paths.state(task.owner, task.taskId) + '/Cleaner'
    if (await this.files.read(snapshot, marker) === undefined && await this.files.read(snapshot, cleanupRecordPath(task.taskId)) === undefined) return false
    // Stop confirmation protects files being removed, not independent result notifications.
    if (!this.businessStopped(task.taskId) || !await this.settleTaskOrganizer(task.taskId)) return false
    const retentionRaw = await this.files.read(snapshot, paths.archive(task.taskId) + '/retention.json')
    if (retentionRaw !== undefined && [...this.roleRecords.values()].some(record => record.identity.taskId === task.taskId
      && record.identity.role === 'Recorder' && this.active(record))
      && await changedCleanupMaterials(this.files, snapshot, task, JSON.parse(retentionRaw) as RetentionManifest, retentionRaw)) {
      // An already resumed Recorder owns the changed-material review. Its previous
      // Cleaner request cannot cancel that review on the next discovery poll.
      return false
    }
    for (const record of this.roleRecords.values()) if (record.identity.taskId === task.taskId && record.identity.role === 'Recorder' && !record.stopped) {
      if (!this.trackedStop(record)) return false
    }
    try { return (await this.cleaner.clean(task, snapshot)).status === 'released' }
    catch (error) {
      if (!(error instanceof CleanupMaterialsChangedError)) throw error
      await this.wake({ id: 'recorder-materials:' + task.taskId + ':' + error.signature, role: 'Recorder', taskId: task.taskId,
        sources: [], reason: 'business-complete', context: { changedOriginalPaths: error.paths,
          facts: 'Original material changed after the previous archive snapshot, or that snapshot was not recorded. The originals are preserved. Read and review them, then save/read back the archive before requesting cleanup again.' } })
      return false
    }
  }
  private async releaseLocalTask(taskId: string): Promise<void> {
    const task = await withSnapshot(this.files, snapshot => readJson<TaskMetadata>(this.files, snapshot, paths.task(taskId)))
    if (!task) throw new Error('Released task metadata is unavailable: ' + taskId)
    for (const record of this.roleRecords.values()) if (record.identity.taskId === taskId && !record.stopped) {
      const result = await this.stopOwnedRecord(record)
      if (result.status !== 'stopped') throw new Error(result.status === 'unconfirmed' ? result.reason : 'Task execution changed during local release.')
      await this.saveRole({ ...record, stopped: true })
    }
    await this.releaseTask(task)
  }
  private async settleTaskOrganizer(taskId: string, release = false): Promise<boolean> {
    for (const candidate of [...this.roleRecords.values()]) {
      if (candidate.identity.role !== 'Organizer' || candidate.released) continue
      if (![candidate.delivery?.request.taskId, candidate.lastWake?.taskId].includes(taskId)) continue
      const workId = candidate.identity.workId
      // Do not queue a cleanup behind a still-admitting global role. Its existing
      // owner must resolve which Task input it accepted before retirement.
      if (this.workOperations?.has(workId)) return false
      let settled = true
      await this.serialWork(workId, async () => {
        const current = this.roleRecords.get(workId)
        if (!current || current.identity.executionId !== candidate.identity.executionId || current.released) return
        if (await this.currentTask(current) !== taskId) return
        if (this.roleRecords.get(workId) !== current) { settled = false; return }
        const associations = [current.delivery?.request.taskId, current.lastWake?.taskId].filter(id => id !== undefined)
        if (associations.some(id => id !== taskId)) { settled = false; return }
        const stop = this.stopOperations?.get(JSON.stringify([workId, current.identity.executionId]))
        if ((stop && !stop.settled) || !this.trackedStop(current)) { settled = false; return }
        if (release) {
          await this.observations.unbind(workId, current.identity.executionId)
          await this.saveRole({ ...current, stopped: true, released: true })
          this.stopOperations?.delete(JSON.stringify([workId, current.identity.executionId]))
        }
      })
      if (!settled) return false
    }
    return true
  }
  private async releaseTask(task: TaskMetadata): Promise<void> {
    if (!await this.settleTaskOrganizer(task.taskId, true)) throw new Error('Task Organizer ownership has not settled for final release.')
    clearInboxDiscoveryCache(this.files, task.taskId)
    clearCleanupReferenceCache(this.files, task.taskId)
    for (const [workId, stop] of this.stopOperations ?? []) if (stop.taskId === task.taskId && stop.settled) this.stopOperations!.delete(workId)
    for (const record of [...this.roleRecords.values()]) if (record.identity.taskId === task.taskId) {
      await this.observations.unbind(record.identity.workId, record.identity.executionId)
      await this.saveRole({ ...record, stopped: true, released: true })
    }
    await this.controls.releaseTask(task.taskId)
    await this.records.set(this.prefix + 'sealed/' + hash(task.taskId), { taskId: task.taskId, released: true })
    for (const [key, record] of this.roleRecords) if (record.identity.taskId === task.taskId && record.released) this.roleRecords.delete(key)
    // Keep only idempotent wake identities once actual associations are released.
    // Per-key writes recheck this terminal receipt, including a racing late wake.
    for (const row of await this.records.list<WakeRecord>(this.prefix + 'wakes/')) {
      if (row.value.request.taskId === task.taskId && row.value.request.role !== 'Foreground') await this.updateWake(row.key, current => current ? this.releasedWake(current) : undefined)
    }
    for (const member of task.members ?? [task.owner]) await this.serialRecoveryWatch(task.taskId, member, async key => {
      const saved = await this.records.get<RecoveryWatchRecord>(key)
      await this.records.set(key, { ...saved, watch: undefined, released: true })
    })
  }
  private async sealBusiness(taskId: string): Promise<void> {
    const key = this.prefix + 'sealed/' + hash(taskId)
    if ((await this.records.get<{ released?: boolean }>(key))?.released) return
    await this.records.set(key, { taskId })
  }
  private async processSealedBusiness(): Promise<void> {
    for (const row of await this.records.list<{ taskId: string; released?: boolean }>(this.prefix + 'sealed/')) {
      if (row.value.released) continue
      this.businessStopped(row.value.taskId)
    }
  }
  /** A pending producer owns its stop promise, not the discovery loop. Only
   * confirmed, persisted completion for this exact execution permits cleanup. */
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
    const stop: TrackedStop = { executionId, taskId, promise: Promise.resolve(), settled: false,
      persistedStopped: existing?.persistedStopped, reportedFailure: existing?.reportedFailure }
    const report = (error: unknown, signature: string) => {
      if (stop.reportedFailure === signature) return
      stop.reportedFailure = signature
      this.error(error)
    }
    operations.set(stopKey, stop)
    stop.promise = Promise.resolve().then(async () => {
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
    })
    return false
  }
  private businessStopped(taskId: string): boolean {
    let stopped = true
    for (const record of this.roleRecords.values()) if (record.identity.taskId === taskId
      && (record.identity.role === 'Planner' || record.identity.role === 'Worker')) {
      if (!this.trackedStop(record)) stopped = false
    }
    if ([...(this.stopOperations?.values() ?? [])].some(stop => stop.taskId === taskId && (!stop.settled || stop.result?.status !== 'stopped'))) stopped = false
    return stopped
  }
  private async stopOwnedRecord(record: RoleRecord, observation?: ScheduledObservation): Promise<StopResult> {
    const result = await this.native.stop(record.identity.workId, record.identity.executionId, observation)
    if (result.status !== 'superseded') return result
    if (observation && this.native.get(record.identity.workId)) return result
    const current = this.roleRecords.get(record.identity.workId)
    if (current?.identity.executionId !== record.identity.executionId) return { status: 'superseded' }
    const agent = this.ctx.agents.get(SessionId(record.sessionId))
    const jobs = this.ctx.jobs.list(SessionId(record.sessionId)).filter(job => job.owner === record.sessionId && (job.status === 'running' || job.status === 'stopping')).map(job => String(job.id))
    const intent = current.stopIntent
    const known = [...new Set([...jobs, ...(intent?.jobs ?? []), ...(current.stopUnknown?.jobs ?? [])])]
    if (agent) return { status: 'unconfirmed', reason: 'A native Agent survives without its owned stop handle.', jobs: known }
    let events
    try { events = await new DshSessionReader(this.ctx).events(record.sessionId) }
    catch (error) { return { status: 'unconfirmed', reason: 'Native stop history is unavailable: ' + (error instanceof Error ? error.message : String(error)), jobs: known } }
    const pending = pendingNativeStopJobs(intent?.agentId ?? record.sessionId, events, known)
    if (agent || jobs.length || pending.length) return { status: 'unconfirmed',
      reason: current.stopUnknown?.reason ?? 'A native owner or producer still lacks confirmed settlement.', jobs: [...new Set([...jobs, ...pending])] }
    if ((intent?.phase === 'stopping' || current.stopUnknown) && !known.length) return { status: 'unconfirmed',
      reason: 'Stop was not durably confirmed and no producer identity is available to verify; inspect the original session.', jobs: [] }
    // Recorded producer confirmations plus absence of a live owner reconcile a
    // missed stop acknowledgement. An empty registry alone is never this proof.
    if (intent || current.stopUnknown) await this.saveRole({ ...current, stopped: true, stopUnknown: undefined })
    return { status: 'stopped' }
  }
  private recoveryInputPath(taskId: string, member: string, role: RecoveryRole): string {
    return 'technical/recovery-inputs/' + paths.member(taskId, member).slice('task-runs/'.length) + '/' + role + '.json'
  }
  private async processHostRestores(onError?: (error: unknown, context: Record<string, unknown>) => void): Promise<void> {
    type HostRestore = { commandId: string; input: { facts: string; hypotheses: string; actionsTaken: string; continuation: string }; createdAt: string; complete: boolean; targets?: Array<{ identity: WorkIdentity; sessionId: string; complete?: boolean; outcome?: 'superseded' | 'released' | 'user-stopped' | 'arranged' | 'no-continuation' }> }
    for (const row of await this.records.list<HostRestore>(this.prefix + 'host-restores/')) {
      if (this.closed) return
      if (row.value.complete) continue
      const { commandId, input, createdAt } = row.value
      let phase = 'targets'
      let activeTarget: string | undefined
      const report = (error: unknown) => {
        if (!onError) throw error
        onError(error, { hostRestorationCommandId: commandId, phase,
          ...(error instanceof Error ? { errorName: error.name } : {}),
          ...(error instanceof FilesOutcomeUnknownError ? { operationId: error.operationId } : {}),
          ...(activeTarget ? { activeTarget } : {}), targets: structuredClone(row.value.targets ?? []) })
      }
      try {
        if (!row.value.targets) {
          row.value.targets = [...this.roleRecords.values()].filter(record => !record.released && !record.stopped
            && (record.stopUnknown || record.stopIntent)).map(record => ({ identity: record.identity, sessionId: record.sessionId }))
          // Target ownership precedes native stop. Later polls must still arrange
          // continuation after that exact execution has become stopped.
          await this.records.set(row.key, row.value)
        }
        phase = 'publication'
        await this.transactions.run('host-restore:' + commandId, { input, createdAt }, { reevaluate: true }, async snapshot => {
          const writes = new Map<string, string>()
          for (const task of await this.taskMetadata(snapshot)) {
            if (task.status !== 'running' || await this.manuallyCleared(task.taskId, snapshot)) continue
            let relevant = false
            for (const member of (task.members ?? [task.owner]).filter(member => this.config.primary || member === this.config.member)) {
              const status = await readMemberStatus(this.files, snapshot, paths.memberStatus(task.taskId, member))
              const inbox = await this.files.read(snapshot, paths.inbox(task.taskId, member))
              if (status?.state === 'complete' || !inbox?.length) continue
              relevant = true
              writes.set(paths.state(member, task.taskId) + '/recovery', '')
              writes.set(paths.state(member, task.taskId) + '/Planner_Helper', '')
              writes.set(this.recoveryInputPath(task.taskId, member, 'Planner'), JSON.stringify({ ...input, at: createdAt, debugPath: 'debug/' + createdAt.slice(0,10) + '.md' }))
            }
            if (relevant && task.route === 'O' && this.config.primary) {
              writes.set(paths.state(task.owner, task.taskId) + '/Organizer_Helper', '')
              writes.set(this.recoveryInputPath(task.taskId, task.owner, 'Organizer'), JSON.stringify({ ...input, at: createdAt, debugPath: 'debug/' + createdAt.slice(0,10) + '.md' }))
            }
          }
          const debug = 'debug/' + createdAt.slice(0,10) + '.md'
          writes.set(debug, (await this.files.read(snapshot, debug) ?? '') + '\n' + JSON.stringify({ at: createdAt, mode: 'host-restoration', ...input, managers: [...writes.keys()] }) + '\n')
          return [...writes].map(([path,content]) => ({path,content}))
        })
        const unresolved: Array<{ identity: WorkIdentity; sessionId: string; reason: string; jobs: string[] }> = []
        phase = 'continuations'
        let targetFailed = false
        for (const target of row.value.targets) {
          if (this.closed) return
          if (target.complete) continue
          activeTarget = target.identity.executionId
          const pending = (record: RoleRecord | undefined, reason: string) => unresolved.push({ identity: target.identity,
            sessionId: target.sessionId, reason, jobs: record?.stopUnknown?.jobs ?? record?.stopIntent?.jobs ?? [] })
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
                await this.records.set(row.key, row.value)
                return
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
              if (await this.controls.execution(record.identity.executionId)) target.outcome = 'user-stopped'
              else {
                await this.publishOwnerRecovery('host-restore-owner:' + commandId + ':' + target.identity.executionId, record)
                if (this.closed) return
                const continuation = await this.arrangeNativeContinuation(record, { ...input, facts: input.facts }, undefined,
                  'host-restored:' + commandId + ':' + target.identity.executionId)
                target.outcome = continuation ? 'arranged' : 'no-continuation'
              }
              target.complete = true
              await this.records.set(row.key, row.value)
            })
            if (this.closed) return
          } catch (error) {
            targetFailed = true
            report(error)
          }
        }
        phase = 'settlement'
        activeTarget = undefined
        if (unresolved.length) {
          await this.records.set(row.key, { ...row.value, unresolved, complete: false })
          await this.wake({ id: 'host-restoration-unresolved:' + commandId + ':' + hash(JSON.stringify(unresolved)), role: 'Helper', reason: 'helper', sources: [], context: { hostRestoration: 'unconfirmed', unresolved } })
          continue
        }
        if (targetFailed) continue
        // Recovered handles may resume only through the original queued input and
        // its normal current-signal/Task checks. Observation stages are not erased.
        await this.records.set(row.key, { ...row.value, complete: true })
        this.environment.restored?.()
      } catch (error) {
        report(error)
      }
    }
  }
  /** Independent owned recovery settlement, shared with the normal poll. A
   * hung admission must not prevent its Helper's persisted repair from running. */
  private startRestoration(): void {
    if (this.closed || this.restoreScanning) return
    void this.restorePending(false).catch(error => this.error(error))
  }
  private restorePending(waitForSettlement = true): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (!this.restoreScanning) {
      const scan = Promise.resolve().then(async () => {
        if (this.closed) return
        if (!this.hostRestoring) {
          const host = this.processHostRestores((error, context) => this.error(error, context))
          this.hostRestoring = host
          void host.catch(error => this.error(error)).finally(() => { if (this.hostRestoring === host) this.hostRestoring = undefined })
        }
        await this.processRestores(false)
      })
      this.restoreScanning = scan
      void scan.finally(() => { if (this.restoreScanning === scan) this.restoreScanning = undefined }).catch(() => {})
      const settled = scan.then(() => this.settleOperations([
        ...(this.hostRestoring ? [this.hostRestoring] : []), ...(this.restoreOperations?.values() ?? []),
      ], 'Native restorations failed'))
      this.restoring = settled
      void settled.finally(() => { if (this.restoring === settled) this.restoring = undefined }).catch(() => {})
    }
    return waitForSettlement ? this.restoring! : this.restoreScanning
  }
  private startTargetedAdmission(wakeId: string): void {
    if (this.closed || this.targetedPumps.has(wakeId)) return
    const operation = Promise.resolve().then(() => { if (!this.closed) return this.runQueue(false, wakeId) })
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
        await this.records.set(row.key, { ...row.value, complete: true, outcome: 'arranged' })
      } else if (continuation) this.startTargetedAdmission(continuation.request.id)
      return
    }
    if (this.workOperations?.has(workId)) return
    let launch: string | undefined
    await this.serialWork(workId, async () => {
      if (this.closed) return
      const current = await this.records.get<WakeRecord>(this.prefix + 'wakes/' + hash(original.request.id))
      if (!current) throw new Error('The exact pending Host wake is unavailable.')
      if (current.delivered) { await this.records.set(row.key, { ...row.value, complete: true, outcome: 'already-admitted' }); return }
      if (current.admission?.reportedAt === undefined) throw new Error('Wake restoration requires its recorded admission-timeout responsibility.')
      const record = this.roleRecords.get(workId)
      if (record && (!record.stopped || this.active(record))) return
      if (['Planner', 'Worker', 'Organizer'].includes(current.request.role) && await this.controls.taskHeld(current.request.taskId)) return
      if (this.closed) return
      await this.transactions.run('restore-debug:' + commandId, input, { reevaluate: true }, async snapshot => {
        const path = 'debug/' + row.value.createdAt.slice(0, 10) + '.md'
        return [{ path, content: (await this.files.read(snapshot, path) ?? '') + '\n' + JSON.stringify(input) + '\n' }]
      })
      const { taskId, role } = current.request
      if (taskId && ['Planner', 'Worker', 'Organizer', 'Recorder'].includes(role)) {
        await this.transactions.run('restore-wake-marker:' + commandId, { taskId, role }, { reevaluate: true }, async snapshot => {
          if (await this.manuallyCleared(taskId, snapshot) || await readJson(this.files, snapshot, cleanupRecordPath(taskId))) return []
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
      await this.wake({ ...current.request, id: continuationId, reason: 'startup-recovery',
        context: { ...current.request.context, admissionRestoration: input, originalWakeId: current.request.id } },
      { replacesUnadmittedWake: current.request.id })
      await this.records.set(row.key, { ...row.value, continuationId })
      launch = continuationId
    })
    if (launch) this.startTargetedAdmission(launch)
  }
  private async processRestores(waitForSettlement = true): Promise<void> {
    const owned = this.restoreOperations ??= new Map<string, Promise<void>>()
    const operations: Promise<void>[] = []
    for (const row of await this.records.list<RoleRestore>(this.prefix + 'restores/')) {
      if (this.closed) break
      if (row.value.complete) continue
      const target = row.value.resolvedTarget ?? row.value.input.target
      const wakeId = row.value.admissionWakeId ?? row.value.input.wakeId
      const wake = !target && wakeId ? await this.records.get<WakeRecord>(this.prefix + 'wakes/' + hash(wakeId)) : undefined
      const workId = target?.workId ?? (wake && this.requestKey(wake.request)) ?? row.key
      // A recovery has a target owner even while it stops an admission outside
      // serialWork. Later scans do not duplicate that stop or queue behind it.
      if (owned.has(workId)) { if (waitForSettlement) operations.push(owned.get(workId)!); continue }
      const operation = Promise.resolve().then(async () => {
        if (this.closed) return
        const current = await this.records.get<RoleRestore>(row.key)
        if (!current || current.complete || this.closed) return
        try { await this.processRestore({ key: row.key, value: current }) }
        catch (error) { if (!(error instanceof FilesConflictError)) throw error }
      })
      owned.set(workId, operation)
      operations.push(operation)
      void operation.finally(() => { if (owned.get(workId) === operation) owned.delete(workId) }).catch(() => {})
      if (!waitForSettlement) void operation.catch(error => this.error(error, { restoreCommandId: row.value.commandId, workId }))
    }
    if (waitForSettlement) await this.settleOperations(operations, 'Native restorations failed')
  }
  private async processRestore(row: { key: string; value: RoleRestore }): Promise<void> {
      const admissionId = row.value.admissionWakeId ?? row.value.input.wakeId
      if (admissionId && !row.value.continuationId) {
        const original = await this.records.get<WakeRecord>(this.prefix + 'wakes/' + hash(admissionId))
        const owner = original && this.roleRecords.get(this.requestKey(original.request))
        if (original?.delivered || (owner?.delivery?.request.id === admissionId && owner.delivery.confirmed)) {
          if (original && !original.delivered) await this.updateWake(this.prefix + 'wakes/' + hash(admissionId), current => current ? { ...current, delivered: true, admission: undefined } : undefined)
          await this.records.set(row.key, { ...row.value, complete: true, outcome: 'already-admitted' }); return
        }
      }
      if (!row.value.input.target && !row.value.resolvedTarget) {
        const wakeId = row.value.input.wakeId!
        const original = await this.records.get<WakeRecord>(this.prefix + 'wakes/' + hash(wakeId))
        if (!original) throw new Error('The requested Host wake does not exist.')
        if (original.delivered && !row.value.continuationId) {
          await this.records.set(row.key, { ...row.value, complete: true, outcome: 'already-admitted' }); return
        }
        const current = this.roleRecords.get(this.requestKey(original.request))
        if (!row.value.continuationId && current && original.admission?.executionId === current.identity.executionId) {
          row.value.resolvedTarget = { ...current.identity }
          await this.records.set(row.key, row.value)
        } else { await this.restoreUnadmittedWake(row, original); return }
      }
      const input = { ...row.value.input, target: row.value.resolvedTarget ?? row.value.input.target! }
      const busy = this.workOperations?.get(input.target.workId)
      if (busy) {
        const current = this.roleRecords.get(input.target.workId)
        if (!current || current.identity.executionId !== input.target.executionId) return
        const cancellation = new DOMException('Helper is recovering this exact pending native admission.', 'AbortError')
        this.admissionCancellations.set(input.target.executionId, cancellation)
        try {
          const stopped = this.native.get(input.target.workId)
            ? await this.native.stop(input.target.workId, input.target.executionId)
            : await this.native.cancelOpening(input.target.workId, input.target.executionId, cancellation)
          if (stopped.status !== 'stopped') {
            if (stopped.status === 'unconfirmed') {
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
      if (!record || record.identity.executionId !== input.target.executionId) { await this.records.set(row.key, { ...row.value, complete: true }); return }
      if (['Planner', 'Worker', 'Organizer', 'Recorder'].includes(record.identity.role) && await this.manuallyCleared(await this.currentTask(record))) { await this.records.set(row.key, { ...row.value, complete: true }); return }
      const date = row.value.createdAt.slice(0,10)
      await this.transactions.run('restore-debug:' + row.value.commandId, input, { reevaluate: true }, async snapshot => {
        const path = 'debug/' + date + '.md'
        return [{ path, content: (await this.files.read(snapshot, path) ?? '') + '\n' + JSON.stringify(input) + '\n' }]
      })
      record = this.roleRecords.get(input.target.workId)
      if (!record || record.identity.executionId !== input.target.executionId || !this.trackedStop(record)) return
      record = this.roleRecords.get(input.target.workId)
      if (!record || record.identity.executionId !== input.target.executionId || !record.stopped) return
      if (record.identity.taskId && record.identity.member && (record.identity.role === 'Planner' || record.identity.role === 'Worker')) {
        const taskId = record.identity.taskId, member = record.identity.member
        await this.transactions.run('restore-marker:' + row.value.commandId, { taskId, member }, { reevaluate: true }, async checked => {
          if (await this.manuallyCleared(taskId, checked)) return []
          const task = await readJson<TaskMetadata>(this.files, checked, paths.task(taskId))
          const status = await readMemberStatus(this.files, checked, paths.memberStatus(taskId, member))
          const inbox = await this.files.read(checked, paths.inbox(taskId, member))
          if (task?.status !== 'running' || status?.state === 'complete' || !inbox?.length) return []
          return [{ path: paths.state(member, taskId) + '/recovery', content: '' }]
        })
        if (record.identity.role === 'Worker') await this.wake({ id: 'restore-planner:' + row.value.commandId, role: 'Planner', taskId,
          reason: 'startup-recovery', sources: [], context: input })
      }
      const pending = (await this.records.list<WakeRecord>(this.prefix + 'wakes/')).find(wake => !wake.value.delivered
        && this.requestKey(wake.value.request) === record!.identity.workId && !wake.value.recovery)
      const taskId = await this.currentTask(record) ?? pending?.value.request.taskId
      if (taskId && (record.identity.role === 'Organizer' || record.identity.role === 'Recorder')) {
        await this.transactions.run('restore-role-marker:' + row.value.commandId, { taskId, role: record.identity.role }, { reevaluate: true }, async snapshot => {
          return this.ownerRecoveryChanges(snapshot, taskId)
        })
      }
      const neverSent = pending && pending.value.admission?.executionId === record.identity.executionId
        && record.delivery?.request.id !== pending.value.request.id
      const owner = neverSent ? { ...record, delivery: undefined, lastWake: undefined } : record
      const continuation = await this.arrangeNativeContinuation(owner, input, undefined, 'restore-role:' + row.value.commandId, pending?.value.request)
      // A genuine terminal member can supersede a restoration which never had
      // a native delivery. Do not invent a continuation, or leave that finished
      // responsibility permanently pending. Recorder completion is independent.
      const terminal = !continuation && !pending && !record.delivery && !record.lastWake
        && record.identity.taskId && ['Planner', 'Worker'].includes(record.identity.role)
        && await withSnapshot(this.files, async snapshot => {
          const task = await readJson<TaskMetadata>(this.files, snapshot, paths.task(record!.identity.taskId!))
          if (task?.status === 'complete') return true
          const status = record!.identity.member && await readMemberStatus(this.files, snapshot, paths.memberStatus(record!.identity.taskId!, record!.identity.member))
          return !!status && status.state === 'complete'
        })
      if (continuation || terminal) await this.records.set(row.key, { ...row.value, complete: true, outcome: continuation ? 'arranged' : 'terminal' })
      })
  }
  private cancelledByShutdown(error: unknown): boolean {
    return this.shutdownReason !== undefined && (error === this.shutdownReason || (error instanceof Error && error.name === 'AbortError' && error.cause === this.shutdownReason)
      || (error instanceof AggregateError && error.errors.length > 0 && error.errors.every(item => this.cancelledByShutdown(item)))
      || (error instanceof DshAgentCreationCancelled && error.executionStopped && error.reason === this.shutdownReason))
  }
  private error(error: unknown, context?: Record<string, unknown>): void {
    if (this.cancelledByShutdown(error)) return
    this.environment.error(error)
    if (this.closed) return
    const rateLimit = error instanceof GitHubError ? error.rateLimit : undefined
    if (rateLimit) {
      this.rateLimitDiagnostics ??= new WeakMap()
      if (this.rateLimitDiagnostics.has(rateLimit)) return
      this.rateLimitDiagnostics.set(rateLimit, 'pending')
    }
    // A cached server limit is one fact, not a new failure on every discovery
    // tick. Ordinary later errors keep their existing event semantics.
    const facts = error instanceof Error ? error.message : String(error)
    this.errorTail = this.errorTail.then(async () => {
      // A different target progressing is not a new failure of this execution.
      // Keep the complete observed context for inspection, but scope deduplication
      // to the failed target and its own current progress.
      const diagnosticContext = typeof context?.hostRestorationCommandId === 'string' && typeof context.activeTarget === 'string' && Array.isArray(context.targets)
        ? { ...context, targets: context.targets.filter(target => target?.identity?.executionId === context.activeTarget) } : context
      const signature = hash(JSON.stringify([facts, diagnosticContext]))
      if ((context?.identity as WorkIdentity | undefined)?.role === 'Helper' || context?.role === 'Helper') {
        // Preserve the native failure, but an error handler must not recursively
        // assign its own failed diagnostic Agent another identical responsibility.
        // No automatic post-failure restart policy is inferred from agent/error.
        await this.records.set(this.prefix + 'helper-errors/' + signature, { facts, context })
        return
      }
      const pending = (await this.records.list<WakeRecord>(this.prefix + 'wakes/')).some(row => !row.value.delivered && row.value.request.context?.errorSignature === signature)
      const diagnosticId = typeof context?.hostRestorationCommandId === 'string'
        ? 'host-restore-error:' + signature : 'host-error:' + randomUUID()
      if (!pending) await this.wake({ id: diagnosticId, role: 'Helper', reason: 'helper', sources: [],
        context: { errorSignature: signature, facts, ...(context ?? {}) } })
    }).then(() => {
      if (rateLimit) this.rateLimitDiagnostics!.set(rateLimit, 'recorded')
    }).catch(failure => {
      if (rateLimit) this.rateLimitDiagnostics!.delete(rateLimit)
      this.environment.error(failure)
    })
  }
  /** Moving the owned storage is stricter than closing its UI: no producer may
   * still own a write into the directory being copied. Preserve unknown native
   * settlement instead of treating an empty registry as stopped. */
  async settleForStorageMove(): Promise<void> {
    await this.dispose()
    for (const row of await this.records.list<RoleRecord>(this.prefix + 'roles/')) {
      if (row.value.released || row.value.stopped) continue
      const current = this.roleRecords.get(row.value.identity.workId)
      if (current && current.identity.executionId !== row.value.identity.executionId) throw new Error('Storage move encountered a replaced execution identity.')
      this.roleRecords.set(row.value.identity.workId, row.value)
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
    const failures: unknown[] = []
    try {
      const cancellation = this.shutdownReason = new DOMException('Framework runtime is closing its owned requests.', 'AbortError')
      // Cancel a factory before waiting for the poll/Helper admission that owns it.
      // Exact creation cancellation joins rollback; unavailable pre-factory awaits
      // retain their responsibility rather than being silently abandoned.
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
      for (const settled of await Promise.allSettled([...(this.maintenance?.values() ?? [])]))
        if (settled.status === 'rejected' && !this.cancelledByShutdown(settled.reason)) failures.push(settled.reason)
      for (const settled of await Promise.allSettled(openingStops)) {
        if (settled.status === 'rejected') failures.push(settled.reason)
        else if (settled.value.status === 'unconfirmed') failures.push(new Error(settled.value.reason))
      }
      try { await this.restoring } catch (error) { if (!this.cancelledByShutdown(error)) failures.push(error) }
      // A snapshot is insufficient if an already-owned operation installs another
      // stop while settling. Drain ownership before the remaining final checks.
      while ([...(this.stopOperations?.values() ?? [])].some(stop => !stop.settled)) {
        await Promise.all([...this.stopOperations!.values()].filter(stop => !stop.settled).map(stop => stop.promise))
      }
      for (const record of this.roleRecords.values()) {
        if (record.stopped) continue
        try {
          const result = await this.stopOwnedRecord(record)
          if (result.status === 'unconfirmed') {
            failures.push(new Error(result.reason))
            await this.saveRole({ ...record, stopUnknown: result })
          }
        } catch (error) { failures.push(error) }
      }
      try { await this.pumping } catch (error) { if (!this.cancelledByShutdown(error)) failures.push(error) }
      try { await this.helperPumping } catch (error) { if (!this.cancelledByShutdown(error)) failures.push(error) }
      for (const settled of await Promise.allSettled([...this.targetedPumps.values()]))
        if (settled.status === 'rejected' && !this.cancelledByShutdown(settled.reason)) failures.push(settled.reason)
      for (const settled of await Promise.allSettled([...(this.observationOperations?.values() ?? [])]))
        if (settled.status === 'rejected' && !this.cancelledByShutdown(settled.reason)) failures.push(settled.reason)
      try { await this.observations.dispose() } catch (error) { failures.push(error) }
    } catch (error) { failures.push(error) } finally {
      // Native idle notifications can already own capture/retirement work even
      // after the poll has drained. No such storage write may outlive disposal.
      while (this.workOperations?.size) {
        const settled = await Promise.allSettled([...this.workOperations.values()])
        for (const result of settled) if (result.status === 'rejected' && !this.cancelledByShutdown(result.reason)) failures.push(result.reason)
      }
      // Closing rejects new diagnostics, but already admitted facts still own
      // storage work. Persist them before the service closes its storage backend.
      try { await this.errorTail } catch (error) { failures.push(error) }
      try { await this.foregroundActivity?.dispose() } catch (error) { failures.push(error) }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'Runtime disposal and diagnostic persistence failed')
  }
}
