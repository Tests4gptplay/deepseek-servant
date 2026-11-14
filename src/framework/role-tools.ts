import { helperReportRecordPath, helperDebugPath, isHelperDatedRecord, isHelperWritableRecord, helperReportSignalPath } from './helper-debug-path.js'
import { publishPhysicalHelperReport } from './physical-helper-report.js'
import { deliverPhysicalDirect, type DirectSignalSources } from './physical-direct-delivery.js'
import type { RoleWake } from './host-loop.js'
import { consumePhysicalRecovery } from './physical-recovery.js'
import { retirePhysicalPublicationsFromEvents } from './physical-publication-retirement.js'
import { supplementPhysicalTask, dispatchPhysicalChild } from './physical-task-dispatch.js'
import { assignPhysicalWorker } from './physical-worker-assignment.js'
import { transferPhysicalWorker } from './physical-worker-transfer.js'
import type { WorkerBusinessTransfer } from './worker-business.js'
import type { TaskCommandOwner } from './task-command-paths.js'
import { ConversationAttachments } from './conversation-attachments.js'
import { validateConversationAttachment, isConversationAttachmentPath } from './conversation-attachment-reference.js'
import { prepareNativeConversationAttachment, prepareNativeLocalAttachment } from '../adapters/dsh/attachments.js'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { routeLegacyTask } from './legacy-routing.js'
import { routePhysicalLegacyTask } from './physical-legacy-publication.js'
import type { SafetyFault } from './safety-net.js'
import { rememberRoleErrorOrigin } from './role-error-origin.js'
import { linkedChild, taskFamily } from './task-relations.js'
import { readTaskReferenceIdentity } from './task-history.js'
import { selectRecorderOutputReferences, prepareRecorderRetention, resolveChildResultReferences, resolveTaskRequirementReference, taskRequirementChain, type RetentionManifest } from './recorder-retention.js'
import { PhysicalLocalFiles } from './physical-local-files.js'
import { publishPhysicalRecorder } from './physical-recorder-publication.js'
import { completePhysicalTask, type PhysicalCompletionPlan } from './physical-task-terminal.js'
import { foregroundMemoryGuide } from '../contracts/foreground-memory.js'
import { readCleanupRecord } from './cleaner.js'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { toolParameters } from '../contracts/schemas.js'
import { isSkillFile, SkillReadBases, mergeSkillProposals, SkillMergeRequired, type SkillMergeBase } from './skill-merge.js'
import type { CommandOptions } from './command-transactions.js'
import { prepareFrameworkSkillIndex } from './skills.js'
import { frameworkRolePrompt } from './role-prompts.js'
import { materialLinksPrompt } from './material-links-prompt.js'
import type { WorkIdentity } from './recovery.js'
import type { TaskWorkspaceLocation } from './task-workspace.js'
import type { TaskControl } from './execution-control.js'
import type { TaskCancellationInput, TaskCancellationResult } from './task-cancellation.js'
import { physicalWorkspaceLink, physicalWorkspaceTitle, isPhysicalWorkspaceReference, sameWorkspaceReference, type PhysicalWorkspaceReference } from './workspace-paths.js'
import { parseTaskReference, referenceTaskId, taskReference } from './published-references.js'
import { GitFiles, filePath, withSnapshot, withOperationChannel, withReadOperation, type FilesStore, type FilesSnapshot, type FileChange, type FileReceipt } from './transactions.js'
import { paths, taskArchiveOwnsPath, readJson, encodeJson, taskCompletionSignals, dispatchPlannerObjective, childCompletionSignal, taskIdentity, taskLifecycle, assertTaskLifecycle, isTerminalTask, type TaskMetadata } from './task-files.js'

export interface FrameworkRoleBinding extends WorkIdentity {
  owner: string
  taskWorkspace?: TaskWorkspaceLocation
  helperNotifications?: RoleWake[]
  claimedNotifications?: Array<{ taskId?: string; signals: string[] }>
  stateDirectory?: string
  recordPath?: string
  notePath?: string
  replyPath?: string
  generation?: number
  collaborationId?: string
  direct?: { inputPath: string; signalPath: string; resultPath?: string; recipientSignal?: string }
}
export interface TaskRecoveryInput { recordPaths: string[]; route: 'P' | 'O'; owner: string; continuation: string }
export type HelperRestoreInput = { facts: string; hypotheses: string; actionsTaken: string; continuation: string; disposition?: 'release'; taskRecovery?: TaskRecoveryInput } &
  ({ target: WorkIdentity; wakeId?: never } | { wakeId: string; target?: never })

export interface HelperRepairAttempt { faultId?: string; actionsTaken: string; outcome: 'repaired' | 'attempted-not-repaired'; result: string }

/** Live Host observation, deliberately separate from a fixed business-file revision. */
export interface PlannerWorkerExecutions {
  taskId: string
  member: string
  observedAt: string
  source: 'current-host-owned-executions'
  workers: Array<{
    childId: string; workId: string; executionId: string; generation: number
    state: 'running' | 'waiting' | 'idle' | 'stopped' | 'stopping' | 'unconfirmed' | 'unknown'
    stopConfirmed: boolean; pendingAdmission: boolean; businessTransferred: boolean; released: boolean
    stopPhase?: 'stopping' | 'disposed'; stopUnconfirmed?: string
    paths: ReturnType<typeof workerPaths>
  }>
  reservedWorkerSeats: number
}

export interface ForegroundTaskControlInput { taskId: string; lifecycleId?: string; intent: 'paused' | 'running' }
export interface FrameworkRoleServices {
  /** Exact already-bound business Task and its original Host, never inferred from request text. */
  taskCommandOwner?(identity: { taskId: string; lifecycleId?: string }): TaskCommandOwner | undefined
  taskControl?: { path?: string; taskPath?(taskId: string): string; write(binding: FrameworkRoleBinding, input: ForegroundTaskControlInput, commandId: string, signal: AbortSignal): Promise<TaskControl> }
  cancelTask?(binding: FrameworkRoleBinding, input: TaskCancellationInput, commandId: string): Promise<TaskCancellationResult>
  restoreTask?(binding: FrameworkRoleBinding, input: TaskRecoveryInput & { taskId: string }, commandId: string): Promise<unknown>
  workspace?: {
    instanceUUID?: string
    locate(taskId: string, snapshot: FilesSnapshot): Promise<TaskWorkspaceLocation | undefined>
    reference(agent: Agent, taskId: string, sourcePath: string, snapshot: FilesSnapshot, signal: AbortSignal): Promise<PhysicalWorkspaceReference & { nativePath: string; bytes: number }>
    validate(reference: PhysicalWorkspaceReference, snapshot: FilesSnapshot): Promise<void>
  }
  files: FilesStore
  physicalSignalSources?: DirectSignalSources
  directDelivered?(binding: FrameworkRoleBinding, commandId: string): Promise<void>
  directDeliverySettled?(binding: FrameworkRoleBinding): Promise<boolean>
  attachmentStore?: ConversationAttachments
  transact(id: string, request: unknown, options: CommandOptions,
    build: (snapshot: FilesSnapshot) => Promise<readonly FileChange[]>): Promise<FileReceipt | void>
  notifications(snapshot: FilesSnapshot, binding: FrameworkRoleBinding, taskId?: string): Promise<string[]>
  plannerWorkerExecutions?(binding: FrameworkRoleBinding): PlannerWorkerExecutions | undefined
  recoveryWatchChanges?(binding: FrameworkRoleBinding, snapshot: FilesSnapshot): Promise<readonly FileChange[]>
  consumeRecovery?(binding: FrameworkRoleBinding, consume: () => Promise<boolean>): Promise<void>
  consumeWake?(binding: FrameworkRoleBinding, snapshot?: FilesSnapshot): Promise<{ signals: string[]; helperNotifications?: RoleWake[]; unchangedRead?: boolean }>
  claimNotifications(binding: FrameworkRoleBinding, commandId: string): Promise<{ signals: string[]; taskId?: string; claimedNotifications?: Array<{taskId?: string; signals: string[]}> }>
  onError(error: unknown): void
  /** Transient display attribution from a selected View, never a write prerequisite. */
  errorTaskSelected?(taskId: string | undefined, call: Pick<ToolRunContext, 'callId' | 'rootCallId'>): void
  workerBusiness?: {
    transferPath?(binding: FrameworkRoleBinding): string
    assertLive?(binding: FrameworkRoleBinding, transferring?: boolean): void
    assert(binding: FrameworkRoleBinding, snapshot: FilesSnapshot): Promise<void>
    transfer(binding: FrameworkRoleBinding, snapshot: FilesSnapshot, successorId: string, successorRole?: 'Worker' | 'Planner'): Promise<readonly FileChange[]>
    committed(binding: FrameworkRoleBinding): Promise<void>
  }
  skillsChanged?(): void
  conversation?: {
    foregroundRoot: string
    /** Only this conversation's exact long-lived memory addresses. */
    prepare?(path: string): Promise<void>
    read(input: { mode: 'context' | 'page' | 'message' | 'recent' | 'memory' | 'search' | 'text'; limit?: number; beforeId?: string; reference?: string; query?: string; cursor?: number }, binding: FrameworkRoleBinding): Promise<unknown>
    send(input: { id: string; text: string; responsePhase: 'interim' | 'final'; intent: 'human' | 'ai'; replyTo?: string }, binding: FrameworkRoleBinding, commandId: string, beforeAttempt?: () => void | Promise<void>): Promise<{ sent: true; messageId: string }>
    claim(input: Record<string, never>, binding: FrameworkRoleBinding, commandId: string): Promise<{ signals: string[] }>
  }
  artifacts?: { preserve(agent: Agent, input: { sourcePath: string; destinationPath: string; taskId: string }, binding: FrameworkRoleBinding,
    commandId: string, options: { signal?: AbortSignal; beforeAttempt?: () => void | Promise<void>; taskOwner?: TaskCommandOwner }): Promise<unknown> }
  capacity?(agent: Agent, input: { taskId: string; paths: string[] }, snapshot?: FilesSnapshot): Promise<unknown>
  observation?: { reset(binding: FrameworkRoleBinding, input: { probeId?: string; recoveryCheckId?: string }, commandId: string, signal: AbortSignal): Promise<unknown> }
  helper?: {
    notifications?(binding: FrameworkRoleBinding): readonly RoleWake[]
    faults?(binding: FrameworkRoleBinding): readonly SafetyFault[]
    recordAttempt?(binding: FrameworkRoleBinding, input: HelperRepairAttempt, commandId: string): Promise<void>
    request(binding: FrameworkRoleBinding, facts: string, commandId: string): Promise<unknown>
    restore(binding: FrameworkRoleBinding, input: HelperRestoreInput, commandId: string): Promise<unknown>
    restoreHost(binding: FrameworkRoleBinding, input: { facts: string; hypotheses: string; actionsTaken: string; continuation: string }, commandId: string): Promise<unknown>
  }
}
export function workerPaths(taskId: string, member: string, childId: string) {
  filePath(childId)
  if (childId.includes('/')) throw new Error('Child identity must occupy one path segment.')
  const root = paths.member(taskId, member) + '/workers/' + childId
  return { root, contract: root + '/contract.md', notes: root + '/notes.md', reply: root + '/reply.md', handoff: root + '/handoff.json', records: root + '/records/' }
}
export const workerWakeSignal = (childId: string) => 'Worker_' + encodeURIComponent(childId).replace(/_/g, '%5F')
export function signalWorkerId(name: string): string | undefined {
  const match = /^Worker_(.+)_Planner$/.exec(name) ?? /^Worker_(.+)$/.exec(name)
  if (!match) return
  try { const child = decodeURIComponent(match[1]!); filePath(child); return child.includes('/') ? undefined : child } catch { return undefined }
}
const signalPart = (value: string) => encodeURIComponent(value).replace(/_/g, '%5F')
export function buildDirectSignal(role: 'Planner' | 'Worker', member: string, id: string): string {
  for (const part of [member, id]) { filePath(part); if (part.includes('/')) throw new Error('Direct identity occupies one path segment.') }
  return role + '_' + signalPart(member) + '_Direct_' + signalPart(id)
}
export function parseDirectSignal(name: string): { role: 'Planner' | 'Worker'; member: string; id: string; inputPath: string; recordPath: string } | undefined {
  const match = /^(Planner|Worker)_([^_]+)_Direct_(.+)$/.exec(name)
  if (!match) return
  try {
    const role = match[1] as 'Planner' | 'Worker', member = decodeURIComponent(match[2]!), id = decodeURIComponent(match[3]!)
    buildDirectSignal(role, member, id)
    return { role, member, id, inputPath: 'direct/' + id + '.md', recordPath: 'direct/' + id + '/takeover.md' }
  } catch { return undefined }
}
export const workerReplySignal = (childId: string, generation: number) => 'Planner_' + encodeURIComponent(childId) + '-Worker-G' + generation
const snapshotInput = { snapshotId: z.string() }
export const archiveRecordsPath = (task: string | Pick<TaskMetadata, 'taskId' | 'archiveFolder' | 'sourcePath'>) => paths.archive(task) + '/records.md'
const outputFiles = z.array(z.object({ path: z.string(), text: z.string() }))
const recorderOutputFiles = z.array(z.object({ path: z.string(), text: z.string(), baseReadId: z.string().optional().describe('For skill files only: exact complete dss_read baseline. Omit to use this Agent’s latest complete read of this path; native skill body projections are not full-file baselines.') }))
interface View { snapshot: FilesSnapshot; taskId?: string; lifecycleId?: string; enforceLifecycle?: boolean }
interface ViewReference { revision: string; taskId?: string; lifecycleId?: string; nonce: string }
/** An ordinary handoff continuation, caught inside the tool boundary. It is
 * neither a storage failure nor a committed empty command. */
class PendingRoleNotifications {
  constructor(readonly notifications: string[], readonly taskId?: string) {}
}


/** Prompt references only; no reads, existence checks or business decisions. */
function roleSourceLocations(binding: FrameworkRoleBinding): Record<string, string> {
  if (!binding.taskId || binding.direct) return {}
  const taskId = binding.taskId, member = binding.member
  const locations: Record<string, string> = { taskMetadataPath: paths.task(taskId) }
  if (member && binding.role !== 'Worker') locations.memberInboxPath = paths.inbox(taskId, member)
  if (binding.role === 'Organizer') Object.assign(locations, {
    organizerNotePath: binding.notePath ?? paths.run(taskId) + '/Organizer_Note.md',
    dispatchPath: paths.run(taskId) + '/Dispatch.md',
  })
  if (binding.role === 'Planner' && member) Object.assign(locations, {
    memoryPath: binding.recordPath ?? paths.member(taskId, member) + '/Planner_Memory.md',
    planNotePath: binding.notePath ?? paths.member(taskId, member) + '/Plan_Note.md',
    planPath: paths.member(taskId, member) + '/Plan.md',
    workersDirectory: paths.member(taskId, member) + '/workers',
    replyPath: binding.replyPath ?? paths.member(taskId, member) + '/Reply.md',
    dispatchPath: paths.run(taskId) + '/Dispatch.md',
  })
  if (binding.role === 'Worker' && member && binding.workerId) {
    const worker = workerPaths(taskId, member, binding.workerId)
    Object.assign(locations, { contractPath: worker.contract, notePath: binding.notePath ?? worker.notes,
      replyPath: binding.replyPath ?? worker.reply, handoffPath: worker.handoff })
  }
  if (binding.role === 'Recorder') Object.assign(locations, {
    cachePath: paths.cache(taskId),
    recorderNotePath: binding.notePath ?? paths.run(taskId) + '/Recorder_Note.md',
  })
  return locations
}

/** Installs only scoped tools; native tools and their existing permissions remain intact. */
export function installFrameworkRoleTools(ctx: Context, agent: Agent, binding: FrameworkRoleBinding, services: FrameworkRoleServices): void {
  const views = new Map<string, View>()
  let viewEpoch = 0, disposed = false
  const files = services.files
  const skillReads = new SkillReadBases()
  const saveBases = new Map<string, Map<string, SkillMergeBase | undefined>>()
  const taskControlPath = (taskId?: string) => taskId && services.taskControl?.taskPath
    ? services.taskControl.taskPath(taskId) : services.taskControl?.path
  const plannerExecutionFacts = () => {
    const facts = binding.role === 'Planner' && binding.taskId && binding.member && !binding.direct
      ? services.plannerWorkerExecutions?.(binding) : undefined
    return facts ? { workerExecutions: facts } : {}
  }
  const close = async (id: string) => { const view = views.get(id); if (view) { views.delete(id); await view.snapshot.release() } }
  const closeAll = async () => {
    viewEpoch++
    const results = await Promise.allSettled([...views.keys()].map(close))
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason)
    if (errors.length) throw new AggregateError(errors, 'Failed to release one or more role read views.')
  }
  const retirementWrites = new Set<Promise<void>>()
  const offTurn = ctx.on('session/event', (session, event) => {
    if (session !== agent.session) return
    if (event.type === 'turn/end') void closeAll().catch(services.onError)
    if (!(files instanceof PhysicalLocalFiles) || event.type !== 'tool/result' || event.data.message.isError) return
    const call = agent.session.snapshotEvents().find(item => item.type === 'tool/call'
      && item.data.callId === event.data.message.toolCallId
      && (['dss_supplement_task', 'dss_planner_dispatch', 'dss_preserve_artifact'].includes(item.data.name)
        || binding.role === 'Helper' && item.data.name === 'dss_record' && (() => {
          try { const input = JSON.parse(item.data.arguments); return !!(input?.notifyForeground || input?.repairAttempt) } catch { return false }
        })()))
    if (!call) return
    const operation = (async () => {
      // A live event is not yet durable result evidence. Preserve the original
      // retry material if the native Session flush fails or is still pending.
      await ctx.sessions.flush(agent.session)
      await retirePhysicalPublicationsFromEvents(files, binding.executionId, [call, event])
    })()
    retirementWrites.add(operation)
    void operation.finally(() => retirementWrites.delete(operation)).catch(services.onError)
  })
  ctx.effect(() => async () => {
    disposed = true; offTurn(); skillReads.clear(); saveBases.clear(); await closeAll()
    await Promise.allSettled([...retirementWrites])
  }, 'servant.framework.role-tools')
  ctx.systemPrompt.section({ name: 'deepseek-servant:framework-role', order: 100, interpolate: false, text: frameworkRolePrompt(binding.role) })
  ctx.systemPrompt.section({ name: 'deepseek-servant:framework-binding', order: 101, interpolate: false,
    text: 'Current role and source locations: ' + JSON.stringify({ ...binding, sourceLocations: { ...roleSourceLocations(binding), ...(binding.role === 'Foreground' && services.taskControl?.path ? { taskControlPath: services.taskControl.path } : {}) } }) })
  ctx.systemPrompt.section({ name: 'deepseek-servant:material-links', order: 103, interpolate: false,
    text: binding.role === 'Foreground' ? 'DSS read/list/record tools use exact logical FilesStore paths, not native filesystem paths. Use the returned logical path unchanged; do not prepend a workspace, localDirectory, repositoryDirectory or checkout path. Tool contracts do not grant additional filesystem permissions.' : materialLinksPrompt })
  if (binding.role === 'Foreground' && services.conversation) ctx.systemPrompt.section({
    name: 'deepseek-servant:foreground-memory-guide', order: 102, interpolate: false,
    text: foregroundMemoryGuide(services.conversation.foregroundRoot + '/Foreground_List.md', services.conversation.foregroundRoot + '/Foreground_Cache.md',
      'Use dss_conversation_read mode memory to read both documents before replacing them. Preserve their existing contents and sources when updating them with dss_record. Never use empty replacement text merely because you have not read the old memory. Use dss_record at a reviewed snapshot for authorized document maintenance.'),
  })
  const register = <T extends z.ZodType>(name: string, description: string, schema: T,
    execute: (input: z.infer<T>, exec: ToolRunContext) => Promise<unknown>, render?: (value: any) => ContentBlock[]) => {
    ctx.tools.register({ name, description, parameters: toolParameters(schema),
      output: { schema: {}, render: (_args, result) => render ? render(result) : [{ type: 'text', text: JSON.stringify(result) }] },
      execute: async (raw, exec) => {
        if (exec.agent !== agent) throw new Error('Tool execution does not belong to this scoped Agent.')
        exec.signal.throwIfAborted()
        // Dispatch may originate from a native event or another role's context.
        // Select the lane on each call, not when this tool set is installed.
        try {
          const result = await withOperationChannel(files, binding.role === 'Foreground' ? 'foreground-read' : 'read',
            () => execute(schema.parse(raw), exec))
          return result === undefined ? null : JSON.parse(JSON.stringify(result))
        } catch (continuation) {
          if (!(continuation instanceof PendingRoleNotifications)) throw continuation
          // No handoff effects or concludeTurn occurred. Keep the signals and
          // this AI's current turn so it can consume and process the new work.
          return { ...(continuation.taskId ? { taskId: continuation.taskId } : {}), notifications: continuation.notifications,
            continuation: 'New notifications arrived. Claim, read and process them, then continue the handoff when ready.' }
        }
      } })
  }
  // Only storage-reading tools open this short authority scope. Native/control
  // tools never acquire Git credentials merely to reset or request recovery.
  const registerRead = <T extends z.ZodType>(name: string, description: string, schema: T,
    execute: (input: z.infer<T>, exec: ToolRunContext) => Promise<unknown>) =>
    register(name, description, schema, (input, exec) => {
      const epoch = viewEpoch
      return withReadOperation(files, async () => {
        const consumed = await services.consumeWake?.(binding)
        assertViewLifetime(epoch)
        const result = await execute(input, exec)
        if (binding.role !== 'Helper' || !consumed?.helperNotifications?.length || !result || typeof result !== 'object') return result
        return { ...result, helperNotifications: [...new Map([
          ...services.helper?.notifications?.(binding) ?? [], ...consumed.helperNotifications,
        ].map(request => [request.id, request])).values()] }
      })
    })
  const assertViewLifetime = (epoch: number) => {
    if (disposed || epoch !== viewEpoch) throw new Error('Snapshot is released; its native turn or role scope ended.')
  }
  const openView = async (selected: string | undefined, epoch = viewEpoch) => {
    assertViewLifetime(epoch)
    const snapshot = await files.snapshot()
    let lifecycleId: string | undefined
    try {
      assertViewLifetime(epoch)
      lifecycleId = binding.taskId ? binding.lifecycleId ?? '' : selected
        ? (['Foreground', 'Helper'].includes(binding.role) ? await readTaskReferenceIdentity(files, snapshot, selected)
          : await readJson<TaskMetadata>(files, snapshot, paths.task(selected)))?.lifecycleId ?? '' : undefined
      assertViewLifetime(epoch)
    } catch (error) { await snapshot.release(); throw error }
    const id = Buffer.from(JSON.stringify({ revision: snapshot.revision, taskId: selected, lifecycleId, nonce: randomUUID() } satisfies ViewReference)).toString('base64url')
    const current = { snapshot, taskId: selected, lifecycleId }
    views.set(id, current)
    return { id, current, epoch }
  }
  const archiveView = async (current: View, selected: string | undefined) => {
    if (!selected || binding.direct) return {}
    const metadata = await readTaskReferenceIdentity(files, current.snapshot, selected)
    if (!metadata) return {}
    if (metadata.taskId !== selected) throw new Error('Task archive metadata identity differs: ' + selected)
    return { archiveDirectory: paths.archive(metadata), archiveRecordsPath: archiveRecordsPath(metadata),
      ...(files instanceof GitFiles ? {} : { archiveStatePath: paths.archive(metadata) + '/state.json' }),
      retentionPath: paths.archive(metadata) + '/retention.json' }
  }
  const workspaceView = async (current: View, selected: string | undefined) => {
    if (!services.workspace) return {}
    const workspaceSource = services.workspace.instanceUUID ? { owner: binding.owner, instanceUUID: services.workspace.instanceUUID,
      linkTitle: physicalWorkspaceTitle({ owner: binding.owner, instanceUUID: services.workspace.instanceUUID }) } : undefined
    if (!selected) return { workspaceSource }
    if (['Planner', 'Worker', 'Organizer', 'Recorder'].includes(binding.role))
      await assertTaskLifecycle(files, current.snapshot, selected, binding)
    const workspace = await services.workspace.locate(selected, current.snapshot)
    return { ...(workspace ? { workspace } : {}), workspaceSource }
  }
  const view = (id: string): View => { const value = views.get(id); if (!value) throw new Error('Snapshot is released; open and read a current snapshot.'); return value }
  const taskId = (value: View): string => {
    const id = binding.taskId ?? value.taskId
    if (!id) throw new Error('Select the task being processed.')
    return id
  }
  const task = async (value: View): Promise<TaskMetadata> => {
    const current = files instanceof PhysicalLocalFiles && value.enforceLifecycle
      ? await assertTaskLifecycle(files, value.snapshot, taskId(value), value)
      : await readJson<TaskMetadata>(files, value.snapshot, paths.task(taskId(value)))
    if (value.enforceLifecycle && !(files instanceof PhysicalLocalFiles))
      await assertTaskLifecycle(files, value.snapshot, taskId(value), value)
    if (!current) throw new Error('Task metadata does not exist; use the supplied direct-task paths for a short task.')
    if (!binding.direct && ['Planner', 'Worker'].includes(binding.role) && current.route !== 'P')
      throw new Error('Planner and Worker business belongs to an independent P Task. Read this O ledger through its Organizer.')
    return current
  }
  const reference = (id: string): ViewReference => {
    const value = JSON.parse(Buffer.from(id, 'base64url').toString('utf8')) as ViewReference
    if (typeof value.revision !== 'string' || typeof value.nonce !== 'string' || (value.taskId !== undefined && typeof value.taskId !== 'string')) throw new Error('Invalid snapshot reference.')
    if (binding.taskId && value.taskId && binding.taskId !== value.taskId) throw new Error('Snapshot belongs to another task.')
    return value
  }
  const mutationView = (id: string): View => {
    const current = views.get(id)
    if (current) return current
    const saved = reference(id)
    // Used only to recover target identity before the transaction service rebuilds
    // the current write snapshot or completes the original write.
    return { snapshot: { revision: saved.revision, release: async () => {} }, taskId: saved.taskId, lifecycleId: saved.lifecycleId }
  }
  const command = (exec: ToolRunContext) => String(agent.id) + ':' + String(exec.callId)
  const physicalPublicationCommand = (exec: ToolRunContext) => binding.executionId + ':' + String(exec.callId)
  const liveAttempt = (exec: ToolRunContext) => {
    const epoch = viewEpoch
    return () => { exec.signal.throwIfAborted(); assertViewLifetime(epoch) }
  }
  const mutate = async (id: string, request: unknown, exec: ToolRunContext,
    build: (snapshot: FilesSnapshot, value: View) => Promise<readonly FileChange[]>, suffix = '', preserveInputs = false, transferring = false,
    deriveChanges?: CommandOptions['deriveChanges']) => {
    const current = mutationView(id)
    const assertLive = liveAttempt(exec)
    const taskOwner = binding.taskId && !binding.direct && ['Planner', 'Worker', 'Organizer', 'Recorder'].includes(binding.role) ? services.taskCommandOwner?.({ taskId: binding.taskId, lifecycleId: binding.lifecycleId }) : undefined
    services.errorTaskSelected?.(binding.taskId ?? current.taskId, exec)
    try {
      return await services.transact(command(exec) + suffix, request, { reevaluate: true, ...(taskOwner ? { taskOwner } : {}), ...(preserveInputs ? { preserveInputs: true } : {}), ...(deriveChanges ? { deriveChanges } : {}), beforeAttempt: () => {
        assertLive()
        if (binding.role === 'Worker' && !binding.direct) services.workerBusiness?.assertLive?.(binding, transferring)
      } }, async snapshot => {
        if (binding.taskId && !binding.direct && ['Planner', 'Worker', 'Organizer', 'Recorder'].includes(binding.role))
          await assertTaskLifecycle(files, snapshot, binding.taskId, binding)
        if (binding.taskId && !binding.direct && ['Planner', 'Worker'].includes(binding.role)) {
          const selected = await readJson<TaskMetadata>(files, snapshot, paths.task(binding.taskId))
          if (selected?.route !== 'P') throw new Error('Planner and Worker mutations require their bound independent P Task.')
        }
        if (binding.role === 'Worker' && !binding.direct) {
          await services.workerBusiness?.assert(binding, snapshot)
        }
        return build(snapshot, { ...current, snapshot, enforceLifecycle: true })
      })
    } catch (error) {
      if (error instanceof PendingRoleNotifications) throw error
      const { workId, executionId, role, taskId, member, workerId } = binding
      rememberRoleErrorOrigin(error, { identity: { workId, executionId, role, taskId, member, workerId }, taskId: taskId ?? current.taskId })
      throw error
    }
  }
  const pending = (value: View) => services.notifications(value.snapshot, binding, value.taskId ?? binding.taskId)
  const requireDrained = async (value: View) => {
    const notifications = await pending(value)
    if (notifications.length) throw new PendingRoleNotifications(notifications, binding.taskId ?? value.taskId)
  }
  const writableRecord = (path: string, value: View): boolean => {
    filePath(path)
    if (binding.role === 'Recorder' && /^archives\/[^/]+\/lifecycles\//.test(path)) return false
    if ([binding.recordPath, binding.notePath, binding.replyPath].includes(path)) return true
    if (binding.direct) return path === binding.direct.resultPath
    if (binding.role === 'Foreground' && services.conversation) return ['Foreground_List.md', 'Foreground_Cache.md'].some(name => path === services.conversation!.foregroundRoot + '/' + name)
    if (binding.role === 'Helper') return isHelperWritableRecord(path)
    const id = taskId(value), run = paths.run(id)
    if (binding.role === 'Organizer') return path === run + '/Organizer_Note.md' || path === run + '/Dispatch.md'
    if (binding.role === 'Planner' && binding.member) return ['Planner_Memory.md', 'Plan_Note.md', 'Plan.md', 'Reply.md'].some(name => path === paths.member(id, binding.member!) + '/' + name)
    if (binding.role === 'Worker' && binding.member && binding.workerId) {
      const worker = workerPaths(id, binding.member, binding.workerId)
      return [worker.notes, worker.reply, worker.handoff].includes(path) || path.startsWith(worker.records)
    }
    if (binding.role === 'Recorder') return path === run + '/Recorder_Note.md'
    return false
  }
  const assertRecord = async (value: View, path: string): Promise<void> => {
    if (!writableRecord(path, value)) throw new Error('Choose a record owned by this role and work item.')
    const selectedId = binding.taskId ?? value.taskId
    if (binding.role === 'Organizer' && selectedId && ['Organizer_Note.md', 'Dispatch.md'].some(name => path === paths.run(selectedId) + '/' + name)) {
      const selected = await task(value)
      if (selected.owner !== binding.owner || selected.route !== 'O') throw new Error('Organizer records belong to this principal’s O task.')
    }
    if (!binding.direct && ['Organizer', 'Planner', 'Worker', 'Recorder'].includes(binding.role)) {
      const id = taskId(value)
      if (!path.startsWith(paths.run(id) + '/')) return
      const current = await task(value)
      // Local runtime metadata is retired by Host after whole-directory cleanup.
      // Its presence/role identity, not a former archive cleanup phase, governs
      // this exact Task write. Git retains its own committed cleanup fact.
      if (files instanceof PhysicalLocalFiles) return
      const cleanup = await readCleanupRecord(files, value.snapshot, current)
      if (cleanup?.phase === 'files-cleaned' || cleanup?.phase === 'released') throw new Error('This Task runtime namespace is already cleaned; the old execution cannot recreate it.')
    }
  }
  const record = async (value: View, path: string, text: string, append = true): Promise<FileChange> => {
    await assertRecord(value, path)
    return { path, content: append ? (await files.read(value.snapshot, path) ?? '') + text : text }
  }

  register('dss_snapshot', 'Open a business read view. Git pins its immutable revision; physical Local reads the current addressed file on each read, without caching or locking its contents. Writes use current target state and do not close this view. Release it when no longer needed; remaining views close at turn end. For a bound Planner, workerExecutions is a fresh Host observation, not part of the fixed file revision.', z.object({ taskId: z.string().optional() }), async (input, exec) => withReadOperation(files, async () => {
    const assertSelectedTask = () => {
      if (binding.taskId && input.taskId && input.taskId !== binding.taskId) throw new Error('This execution is bound to another task.')
    }
    if (binding.role === 'Helper') assertSelectedTask()
    const selected = input.taskId ?? binding.taskId
    const readEpoch = viewEpoch
    let opened = binding.role === 'Helper' ? await openView(selected, readEpoch) : undefined
    try {
      const consumed = await services.consumeWake?.(binding, opened?.current.snapshot)
      assertViewLifetime(readEpoch)
      if (binding.role !== 'Helper') assertSelectedTask()
      // The empty discovery belongs to this fresh view, not a cached prior
      // tool call. Changed Git inputs require their new committed revision.
      if (opened && !consumed?.unchangedRead && files instanceof GitFiles) {
        await close(opened.id); opened = undefined
      }
      opened ??= await openView(selected, readEpoch)
      const { id, current, epoch } = opened
      assertViewLifetime(epoch)
      services.errorTaskSelected?.(selected, exec)
      const notifications = consumed?.unchangedRead ? [] : await pending(current)
      assertViewLifetime(epoch)
      return { snapshotId: id, revision: current.snapshot.revision, consistency: current.snapshot.consistency ?? 'revision-fixed', taskId: selected, notifications, binding, ...(binding.role === 'Foreground' && taskControlPath(selected) ? { taskControlPath: taskControlPath(selected) } : {}), ...await archiveView(current, selected), ...await workspaceView(current, selected), ...plannerExecutionFacts(), ...(binding.role === 'Helper' ? { helperRecordPath: selected ? helperDebugPath(selected, new Date().toISOString().slice(0, 10)) : binding.recordPath ?? helperDebugPath(undefined, new Date().toISOString().slice(0, 10)), safetyFaults: services.helper?.faults?.(binding) ?? [], helperNotifications: [...new Map([
        ...services.helper?.notifications?.(binding) ?? binding.helperNotifications ?? [], ...consumed?.helperNotifications ?? [],
      ].map(request => [request.id, request])).values()] } : {}) }
    } catch (error) { if (opened) await close(opened.id); throw error }
  }))
  register('dss_snapshot_release', 'Release a business read view when no longer needed.', z.object(snapshotInput), async input => { await close(input.snapshotId); return { released: true } })
  if (services.attachmentStore) {
    ctx.systemPrompt.section({ name: 'deepseek-servant:attachments', order: 104, interpolate: false,
      text: 'Local conversation attachments reference the actual selected native file path and read its current contents without copying the original into DSS storage. Git attachments retain their repository references independently. Call dss_attachment_read with a current snapshot and either the actual absolute Local file path or its Local reference; Git requires its repository reference. Local images use the current Agent’s native read_image permission pipeline; other Local files retain their original paths for the Host’s existing read/processing tools. Git images/files retain their independent native ImageBlock/FileBlock delivery. A path or saved handle is not evidence of analysis. Pass the original Local path or Git reference directly to this tool. A missing or refused native image tool does not authorize a bypass; report its actual result and keep the original path. Continue to use the Host’s file tools within their existing permissions; an attachment does not grant parent-directory or adjacent-file access. Do not claim to see image pixels, video frames or audio from a text path.' })
    register('dss_attachment_read', 'Use an actual absolute Local file path or a Local reference. Local images call the current Agent’s native read_image through Host permissions; other files return the original path without reading or checking it, for the Host’s existing tools. Git requires its scoped repository reference and independently supplies byte-verified native ImageBlock/FileBlock content. Delivery is not proof of analysis.',
      z.object({ ...snapshotInput, reference: z.unknown() }), async (input, exec) => {
        const current = view(input.snapshotId), store = services.attachmentStore!
        if (store.scope.mode === 'local') {
          const reference = typeof input.reference === 'string' ? input.reference : validateConversationAttachment(input.reference, store.scope)
          if (typeof reference !== 'string' && reference.mode !== 'local') throw new Error('Local attachment input must use its native path.')
          return prepareNativeLocalAttachment(ctx, reference, exec)
        }
        const reference = validateConversationAttachment(input.reference, store.scope)
        if (reference.mode !== 'git') throw new Error('Git attachment input must use its repository reference.')
        return withReadOperation(files, async () => {
          return prepareNativeConversationAttachment(ctx, store, current.snapshot, reference, exec.signal)
        })
      }, value => value.content)
  }
  // Logical Task references locate their actual original; they are not a Cache admission check.
  type MaterialReadContext = { task?: Promise<TaskMetadata>; chain?: Promise<TaskMetadata[]>; family?: Promise<TaskMetadata[]> }
  const resolveMaterialRead = async (current: View, requestedPath: string, located?: MaterialReadContext,
    resolveChildren = true): Promise<{ path: string; resolvedPath: string }> => {
    if (isConversationAttachmentPath(requestedPath)) throw new Error('Use dss_attachment_read with the complete attachment reference; a text read cannot deliver image pixels or grant attachment access.')
    const explicit = parseTaskReference(requestedPath)
    let requirement: TaskMetadata | undefined
    if ((explicit || /^tasks\/[^/]+_(P|O)\.md$/.test(requestedPath)) && (binding.taskId || current.taskId)) {
      const selected = located ? await (located.task ??= task(current))
        : !binding.taskId && ['Foreground', 'Helper'].includes(binding.role)
          ? await readTaskReferenceIdentity(files, current.snapshot, taskId(current)) : await task(current)
      if (!selected) throw new Error('The selected Task reference is unavailable.')
      let chain: TaskMetadata[]
      try { chain = located ? [...await (located.chain ??= taskRequirementChain(files, current.snapshot, selected))]
        : await taskRequirementChain(files, current.snapshot, selected) } catch (error) {
        const ownSource = explicit ? explicit.taskId === selected.taskId && explicit.original === selected.sourcePath : requestedPath === selected.sourcePath
        if (!ownSource || !(error instanceof Error) || !error.message.startsWith('Task parent association differs:')) throw error
        chain = [selected]
      }
      if (binding.role === 'Recorder' && !chain.some(item => explicit
        ? item.taskId === explicit.taskId && item.sourcePath === explicit.original : item.sourcePath === requestedPath)) {
        const known = new Set(chain.map(item => item.taskId))
        const family = located ? await (located.family ??= taskFamily(files, current.snapshot, selected.taskId))
          : await taskFamily(files, current.snapshot, selected.taskId)
        chain.push(...family.filter(item => !known.has(item.taskId)))
      }
      const matches = chain.filter(item => explicit ? item.taskId === explicit.taskId && item.sourcePath === explicit.original : item.sourcePath === requestedPath)
      if (matches.length > 1) throw new Error('Ambiguous Task requirement link; use an exact task-references path.')
      requirement = matches[0]
    }
    if (!binding.taskId && !current.taskId && (explicit || /^tasks\/[^/]+_(P|O)\.md$/.test(requestedPath))) {
      const id = explicit?.taskId ?? taskIdentity(await files.read(current.snapshot, requestedPath) ?? '')
      const candidate = id ? (['Foreground', 'Helper'].includes(binding.role)
        ? await readTaskReferenceIdentity(files, current.snapshot, id)
        : await readJson<TaskMetadata>(files, current.snapshot, paths.task(id))) : undefined
      if (candidate?.taskId === id && candidate?.sourcePath === (explicit?.original ?? requestedPath)) requirement = candidate
    }
    if (explicit && !requirement) throw new Error('Task reference is outside this Task requirement chain.')
    const originalPath = explicit?.original ?? requestedPath
    const requirementPath = requirement ? await resolveTaskRequirementReference(files, current.snapshot, requirement, originalPath) : undefined
    // An ordinary filename already names its material. Requirement references
    // were handled above. Preserve unresolved task-references handling; only
    // another Task's working filename can need descendant relocation.
    const referencedTask = referenceTaskId(requestedPath)
    const locateChild = binding.role === 'Recorder' && resolveChildren
      && (requestedPath.startsWith('task-references/')
        || referencedTask !== undefined && referencedTask !== (binding.taskId ?? current.taskId))
    const resolvedPath = requirementPath ?? (locateChild ? (await resolveChildResultReferences(files, current.snapshot, await task(current), [requestedPath]))[0]! : requestedPath)
    const path = requirement ? taskReference(requirement.taskId, requirement.sourcePath) : resolvedPath
    return { path, resolvedPath }
  }
  registerRead('dss_read', 'Read exact logical file content: at the opened immutable revision in Git, or from the current addressed physical file in Local. The returned path is a DSS logical reference usable directly in a DSS Markdown material link, not a native filesystem path; do not prepend a storage or repository directory.', z.object({ ...snapshotInput, path: z.string() }), async input => {
    const current = view(input.snapshotId)
    await services.conversation?.prepare?.(input.path)
    const { path, resolvedPath } = await resolveMaterialRead(current, input.path)
    const bytes = await files.readBytes(current.snapshot, resolvedPath)
    if (bytes === undefined) return { path, revision: current.snapshot.revision, exists: false,
      ...(binding.role === 'Recorder' && isSkillFile(resolvedPath) ? { baseReadId: skillReads.remember(resolvedPath, current.snapshot.revision, null).id } : {}) }
    try {
      // A Recorder skill baseline is the complete original UTF-8 text,
      // including a leading BOM. Other role/file reads retain their format.
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: binding.role === 'Recorder' && isSkillFile(resolvedPath) }).decode(bytes)
      if (!text.includes('\0')) return { path, revision: current.snapshot.revision, exists: true, text,
        ...(binding.role === 'Recorder' && isSkillFile(resolvedPath) ? { baseReadId: skillReads.remember(resolvedPath, current.snapshot.revision, text).id } : {}) }
    } catch (error) { if (!(error instanceof TypeError)) throw error }
    return { path, revision: current.snapshot.revision, exists: true, binary: true, bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'), hint: 'Use the artifact download interface for the original bytes.' }
  })
  registerRead('dss_list', binding.role === 'Recorder'
    ? 'List file metadata at one DSS storage directory, such as a Task working directory or archive, without loading bodies. By default only direct files are returned. Set recursive: true to discover descendant file paths, including member and Worker records; an empty direct listing does not mean their evidence is absent. This does not select what to read or retain.'
    : 'List direct file metadata at one directory by default, without loading business bodies or child directories. Set recursive: true to list descendant file paths instead. For Worker records, use the exact task-runs/<taskId>/<member>/workers/<childId> directory from the canonical map; an empty parent listing does not establish that nested records are absent.', z.object({ ...snapshotInput, directory: z.string(), recursive: z.boolean().optional().describe('Explicitly list all descendant file metadata within this permitted directory and read view. Defaults to direct files only; never loads bodies or chooses retention.') }), async input => {
    const current = view(input.snapshotId); if (binding.role !== 'Foreground' && isConversationAttachmentPath(input.directory)) throw new Error('Task roles cannot enumerate conversation attachments; use the exact delegated reference.')
    const rows = input.recursive ? await files.list(current.snapshot, input.directory) : await files.listDirectory(current.snapshot, input.directory)
    return { revision: current.snapshot.revision, files: binding.role === 'Foreground' ? rows : rows.filter(row => !isConversationAttachmentPath(row.path)) }
  })
  register('dss_record', binding.role === 'Worker'
    ? 'Persist actual progress or results in this Worker’s bound Note, Reply or records. Append preserves earlier facts; use relay/delivery tools for the actual handoff.'
    : binding.role === 'Foreground' && services.taskControl
      ? 'Write this Foreground’s bound memory records normally. Only at the taskControlPath returned by dss_snapshot (or the Git binding sourceLocations.taskControlPath), use append:false and strict JSON text {taskId, lifecycleId?, intent: \"paused\" | \"running\"} for an explicit user pause/resume request on the Task selected by snapshotId. This is a validated scoped control request, never replacement file contents. Copy the exact current lifecycleId; omit only for the original lifecycle. No other control fields or technical paths are writable. Keep the original tool call identity and arguments after UNKNOWN. Cancellation uses dss_task_cancel, never this entry.'
    : binding.role === 'Recorder'
      ? 'Persist actual archive progress in this Recorder’s bound Note. Append preserves earlier facts.'
      : 'Persist actual progress or results in this role’s record. Append preserves earlier facts. Helper may optionally report an actual repair attempt with a dated debug write; choose faultId explicitly when multiple current faults are associated. Reporting does not reset or restart anything. Helper may explicitly set notifyForeground to save this report before its Foreground state signal (one Git transaction or the same original Local call continuation); New records belong under debug/helper-debug/tasks/<actual-task-id>/ or debug/helper-debug/host/ when no Task is involved, with dated filenames. Foreground_Helper_Report_<encoded-path>_<command-hash> names that complete retained file; underscores within the path are encoded as %5F. Old accepted dated/named reports keep their original signal. These are permanent diagnostic records, not temporary notification state; only user-directed deletion removes them. No signal body or extra acknowledgement is needed.', z.object({ ...snapshotInput, path: z.string(), text: z.string(), append: z.boolean().default(true), notifyForeground: z.boolean().optional(),
    repairAttempt: z.object({ faultId: z.string().min(1).optional(), actionsTaken: z.string().min(1), outcome: z.enum(['repaired', 'attempted-not-repaired']), result: z.string().min(1) }).optional() }),
    async (input, exec) => {
      const controlPath = services.taskControl?.taskPath ? taskControlPath(mutationView(input.snapshotId).taskId) : services.taskControl?.path
      if (services.taskControl && controlPath && input.path === controlPath) {
        if (binding.role !== 'Foreground' || input.append !== false || input.notifyForeground !== undefined || input.repairAttempt !== undefined)
          throw new Error('Only Foreground may submit a scoped Task pause/resume request with append:false and no report fields.')
        const request = z.object({ taskId: z.string().min(1), lifecycleId: z.string().min(1).optional(), intent: z.enum(['paused', 'running']) }).strict().parse(JSON.parse(input.text))
        const selected = mutationView(input.snapshotId)
        if (selected.taskId !== request.taskId || (selected.lifecycleId ?? '') !== (request.lifecycleId ?? ''))
          throw new Error('Task control must match the selected snapshot Task and current lifecycle.')
        services.errorTaskSelected?.(request.taskId, exec)
        return services.taskControl.write(binding, request, command(exec), exec.signal)
      }
      await services.conversation?.prepare?.(input.path)
      if (input.notifyForeground && (binding.role !== 'Helper' || !isHelperWritableRecord(input.path)))
        throw new Error('Only Helper dated debug records or dedicated Helper reports can notify Foreground.')
      if (input.repairAttempt && (binding.role !== 'Helper' || !isHelperDatedRecord(input.path)))
        throw new Error('Only Helper dated debug records can report a repair attempt.')
      if (input.repairAttempt && !services.helper?.recordAttempt) throw new Error('Helper repair-attempt reporting is unavailable.')
      const foregroundSignal = input.notifyForeground ? helperReportSignalPath(input.path, command(exec)) : undefined
      if (files instanceof PhysicalLocalFiles && (foregroundSignal || input.repairAttempt)) {
        const selected = mutationView(input.snapshotId), assertLive = liveAttempt(exec)
        services.errorTaskSelected?.(binding.taskId ?? selected.taskId, exec)
        const snapshot = await files.snapshot({ signal: exec.signal })
        try {
          assertLive()
          await assertRecord({ ...selected, snapshot }, input.path)
          // This native call is the only cold address for the compound report.
          // Existing DSH input admission flushes do not establish that a later
          // tool/call event is durable. Save this source before accepting effects.
          if (!agent.session.snapshotEvents().some(event => event.type === 'tool/call'
            && event.data.name === 'dss_record' && String(event.data.callId) === String(exec.callId)))
            throw new Error('The original Helper report native call is unavailable; no report publication was accepted.')
          await ctx.sessions.flush(agent.session)
          assertLive()
          await publishPhysicalHelperReport(files, { commandId: physicalPublicationCommand(exec), originalCommandId: command(exec),
            path: input.path, text: input.text, append: input.append, notifyForeground: input.notifyForeground, repairAttempt: input.repairAttempt },
            { signalSources: services.physicalSignalSources,
              recordAttempt: services.helper?.recordAttempt && ((attempt, commandId) => services.helper!.recordAttempt!(binding, attempt, commandId)) }, assertLive)
        } catch (error) {
          const { workId, executionId, role, taskId, member, workerId } = binding
          rememberRoleErrorOrigin(error, { identity: { workId, executionId, role, taskId, member, workerId }, taskId: taskId ?? selected.taskId })
          throw error
        } finally { await snapshot.release() }
        return
      }
      if (files instanceof PhysicalLocalFiles && !foregroundSignal && !input.repairAttempt) {
        const selected = mutationView(input.snapshotId), assertLive = liveAttempt(exec)
        services.errorTaskSelected?.(binding.taskId ?? selected.taskId, exec)
        const snapshot = await files.snapshot({ signal: exec.signal })
        let writeStarted = false
        try {
          assertLive()
          const selectedTask = binding.taskId && !binding.direct && ['Planner', 'Worker', 'Organizer', 'Recorder'].includes(binding.role)
            ? await assertTaskLifecycle(files, snapshot, binding.taskId, binding) : undefined
          if (binding.taskId && !binding.direct && ['Planner', 'Worker'].includes(binding.role)) {
            if (selectedTask?.route !== 'P') throw new Error('Planner and Worker records require their bound independent P Task.')
          }
          if (binding.role === 'Worker' && !binding.direct) {
            services.workerBusiness?.assertLive?.(binding)
            await services.workerBusiness?.assert(binding, snapshot)
          }
          await assertRecord({ ...selected, snapshot, enforceLifecycle: true }, input.path)
          assertLive()
          // A normal record is one ordinary file. Append does not read/rewrite
          // its previous body or enter the old store transaction/journal. Only
          // writers of this same pathname share the physical ordering queue.
          writeStarted = true
          if (input.append) await files.append(input.path, input.text)
          else await files.replace(input.path, input.text)
        } catch (error) {
          const { workId, executionId, role, taskId, member, workerId } = binding
          const reported = writeStarted ? new Error('Physical record write was not confirmed at ' + JSON.stringify(input.path)
            + '. Read the actual file before deciding whether to continue; an interrupted append may have left a partial suffix. This operation was not automatically replayed.', { cause: error }) : error
          rememberRoleErrorOrigin(reported, { identity: { workId, executionId, role, taskId, member, workerId }, taskId: taskId ?? selected.taskId })
          throw reported
        } finally { await snapshot.release() }
      } else await mutate(input.snapshotId, input, exec, async (_snapshot, current) => {
        return [await record(current, input.path, input.text, input.append),
          ...(foregroundSignal ? [{ path: foregroundSignal, content: '' }] : [])]
      })
      if (input.repairAttempt) {
        try { await services.helper!.recordAttempt!(binding, input.repairAttempt, command(exec)) }
        catch (cause) {
          // Only the completed mutation proves these effects; a reporting error
          // may occur either before or after its separate persisted attempt.
          const message = 'Record saved at ' + JSON.stringify(input.path) + '. '
            + (foregroundSignal ? 'Foreground signal saved at ' + JSON.stringify(foregroundSignal) + '. ' : 'No Foreground signal was requested. ')
            + 'Repair-attempt reporting did not complete; its status is unconfirmed. Retry the original dss_record call with the same command identity '
            + JSON.stringify(command(exec)) + ' and unchanged arguments. Cause: ' + String(cause)
          // Retain UNKNOWN subclasses, operation IDs, causes and error-origin
          // identity rather than replacing a storage error with a generic one.
          if (cause instanceof Error) { cause.message = message; throw cause }
          throw new Error(message, { cause })
        }
      }
    })
  if (binding.role !== 'Helper') register('dss_claim', 'Consume the exact ordinary state signals supplied by this wake before reading their task contents. For Foreground, Planner, Worker, and Organizer, another ordinary claim consumes later matching notifications before you read and evaluate their current contents. Foreground adopts current top-level Foreground signals across task, conversation and report sources. Returned signals and claimedNotifications retain accepted context; use a fresh dss_snapshot notifications list to check what remains pending. A bound Planner also receives refreshed workerExecutions facts, separate from the file snapshot.',
    z.object({}).strict(), async (input, exec) => {
      const epoch = viewEpoch
      const consumed = await services.claimNotifications(binding, command(exec))
      const selected = consumed.taskId ?? binding.taskId
      const { id, current } = await openView(selected, epoch)
      assertViewLifetime(epoch)
      return { signals: consumed.signals, ...(binding.role === 'Foreground' ? { helperReports: consumed.signals.flatMap(signal => { const path = helperReportRecordPath(signal); return path ? [{ signal, path }] : [] }) } : {}), snapshotId: id, consistency: current.snapshot.consistency ?? 'revision-fixed', taskId: selected, ...await archiveView(current, selected), ...await workspaceView(current, selected), binding: consumed.claimedNotifications ? {...binding, claimedNotifications: consumed.claimedNotifications} : binding, ...plannerExecutionFacts() }
    })

  if (binding.role === 'Foreground') {
    if (services.restoreTask) register('dss_task_restore', 'After the user explicitly chooses restoration of missing or cancelled work, ask Host to restore the original Task ID in place from actual retained record paths and current facts. A completed Task stays complete; submit a new Task ID for later corrections or new requirements, referencing its existing results. Host resolves its actual retained local execution and reuses the existing restoration flow, reconnects the proven original workspace without copying or overwriting material, and raises the existing recovery signal for Planner inspection. Do not create a separate repair Task merely to reconstruct missing or cancelled original work. Clarify ambiguous targets and explain missing original information before asking for the decision. An arranged response is not restored material or completed work.',
      z.object({ taskId: z.string().min(1), recordPaths: z.array(z.string()).min(1), route: z.enum(['P', 'O']), owner: z.string().min(1), continuation: z.string().min(1) }),
      (input, exec) => services.restoreTask!(binding, input, command(exec)))
    if (services.cancelTask) register('dss_task_cancel', 'Cancel the exact user-selected Task through the same cancellation flow as the task button. This terminal cancellation initiates stopping related business work. A child notifies its linked parent only while that parent is still running, and retains its runtime materials; only whole-tree completion or cancellation starts the root Recorder and subsequent Cleaner. The returned cancelled status does not prove stopping, recording or cleanup has finished. Clarify an ambiguous target before calling; use only for an explicit user cancellation request, not a resumable pause. For a restored Task pass its current lifecycleId from the Task record; omission identifies only the original lifecycle.',
      z.object({ taskId: z.string(), lifecycleId: z.string().optional() }),
      (input, exec) => services.cancelTask!(binding, input, command(exec)))
    register('dss_submit_task', 'Submit an original named task with the route you, the Foreground, choose from the requirements. Do not require the user to label the request O/P or choose a route before submission. Honor an explicit user choice of O or P; otherwise use P for a single objective even when complex, or O for multiple explicit independent parallel objectives. Complexity alone does not select O. Complete suitable short tasks directly unless the user requests delegation. Host assigns its UUID and initializes routing. For preserved legacy work, supply legacyTask with the actual manifestPath and oldTaskId; text records your semantic routing decision. The original requirement, work and mapped Task identity are preserved automatically, without a new Task or a guessed route.', z.object({ ...snapshotInput, name: z.string(), route: z.enum(['P', 'O']), text: z.string(), legacyTask: z.object({ manifestPath: z.string(), oldTaskId: z.string() }).optional() }),
      async (input, exec) => {
        if (files instanceof PhysicalLocalFiles && input.legacyTask) {
          mutationView(input.snapshotId)
          await routePhysicalLegacyTask(files, { ...input.legacyTask, name: input.name, route: input.route, decision: input.text }, liveAttempt(exec), services.physicalSignalSources)
          return
        }
        if (files instanceof PhysicalLocalFiles && !input.legacyTask) {
          mutationView(input.snapshotId)
          const assertLive = liveAttempt(exec)
          assertLive()
          filePath(input.name); if (input.name.includes('/')) throw new Error('Task name occupies one filename segment.')
          const path = 'tasks/' + input.name + '_' + input.route + '.md'
          // This is only the original submission file. The existing Host lane
          // discovers it, assigns the Task ID and owns all initialization.
          if (!await files.createIfAbsent(path, input.text)) throw new Error('This task filename already exists; select a distinct task name.')
          return
        }
        return mutate(input.snapshotId, input, exec, async snapshot => {
          if (input.legacyTask) return routeLegacyTask(files, snapshot, { ...input.legacyTask, name: input.name, route: input.route, decision: input.text })
          filePath(input.name); if (input.name.includes('/')) throw new Error('Task name occupies one filename segment.')
          const path = 'tasks/' + input.name + '_' + input.route + '.md'
          if (await files.read(snapshot, path) !== undefined) throw new Error('This task filename already exists; select a distinct task name.')
          return [{ path, content: input.text }]
        })
      })
    register('dss_supplement_task', 'Append a supplement to an open Task and notify its acceptance role after the original requirement is preserved. Git uses its conditional transaction; physical Local resumes this exact accepted publication. A closed Task requires a new Task.',
      z.object({ ...snapshotInput, text: z.string() }),
      async (input, exec) => {
        if (files instanceof PhysicalLocalFiles) {
          const current = mutationView(input.snapshotId)
          await supplementPhysicalTask(files, { commandId: physicalPublicationCommand(exec), taskId: taskId(current), lifecycleId: current.lifecycleId, text: input.text }, liveAttempt(exec), services.physicalSignalSources)
          return
        }
        return mutate(input.snapshotId, input, exec, async (snapshot, current) => {
          const selected = await task(current)
          if (isTerminalTask(selected)) throw new Error('The total task is closed; submit a new Task referencing its durable results and this new requirement.')
          const original = await files.read(snapshot, selected.sourcePath)
          if (original === undefined) throw new Error('The original task requirement is missing.')
          const recipient = selected.route === 'P' ? 'Planner' : 'Organizer'
          return [
            { path: selected.sourcePath, content: original + '\n\n' + input.text },
            { path: paths.state(selected.owner, selected.taskId) + '/' + recipient + '_Foreground', content: '' },
          ]
        })
      })
    if (services.conversation) {
      register('dss_conversation_read', 'Consume this wake’s exact signals, then read this collaboration. Default context/recent provides exactly the latest six complete publication groups plus all current inputs and interims. Use page/message/search/text only when you explicitly need older or unclassified originals. Call directly; no preceding dss_conversation_claim is needed.', z.object({ mode: z.enum(['context', 'page', 'message', 'recent', 'memory', 'search', 'text']).default('context'), limit: z.number().int().positive().optional(), beforeId: z.string().optional(), reference: z.string().optional(), query: z.string().optional(), cursor: z.number().int().nonnegative().optional() }).superRefine((input, ctx) => {
        if (input.mode === 'search' && !input.query?.trim()) ctx.addIssue({ code: 'custom', message: 'Search requires a phrase.' })
        if (input.mode === 'text' && !input.reference) ctx.addIssue({ code: 'custom', message: 'Text requires a reference.' })
      }), async input => { await services.consumeWake?.(binding); return services.conversation!.read(input, binding) })
      register('dss_conversation_send', 'Set responsePhase to interim for an in-progress response or final for your final reply. This hidden message metadata groups preceding continuous inputs on final publication; it does not claim those inputs were all read or answered and never consumes signals. Publish a scoped conversation message with explicit intent and original identity/reply references. This is the only user-visible reply publication path; native final text is not published. Before a final reply, check current notifications using dss_snapshot; consume, read and process any new work with the existing tools, then recheck. Interim updates do not require interrupting current work. Sending itself never consumes signals or supplies a business acknowledgement. sent:true confirms the original message. On a failed or UNKNOWN result, reconcile that exact command and unchanged content before deciding another action. Already sent text is not withdrawn.',
        z.object({ id: z.string(), text: z.string(), responsePhase: z.enum(['interim', 'final']), intent: z.enum(['human', 'ai']), replyTo: z.string().optional() }),
        (input, exec) => services.conversation!.send(input, binding, command(exec), liveAttempt(exec)))
      register('dss_conversation_claim', 'Optionally consume this wake’s exact signals without reading conversation content. dss_conversation_read already consumes them before reading, so do not call both for that purpose. Returns this wake’s signal paths. Task-result notifications use dss_claim.',
        z.object({}).strict(),
        (input, exec) => services.conversation!.claim(input, binding, command(exec)))
    }
  }
  if (binding.role === 'Organizer') register('dss_planner_dispatch', 'Assign an independent objective as P or an independent-objective bundle as child O to an exact registered member. route defaults to P; members bounds the child resource scope and defaults to the parent scope for O. Same objective identity supplements an open child; completed children require a new identity. Uses real registered members only.',
    z.object({ ...snapshotInput, objectiveId: z.string().min(1), member: z.string().min(1), route: z.enum(['P', 'O']).default('P'), members: z.array(z.string().min(1)).optional(), plan: z.string().min(1), decision: z.string() }),
    async (input, exec) => {
      if (files instanceof PhysicalLocalFiles) {
        const current = mutationView(input.snapshotId)
        await dispatchPhysicalChild(files, { commandId: physicalPublicationCommand(exec), taskId: taskId(current), lifecycleId: binding.lifecycleId ?? current.lifecycleId,
          owner: binding.owner, objectiveId: input.objectiveId, member: input.member, route: input.route, members: input.members,
          plan: input.plan, decision: input.decision }, liveAttempt(exec), services.physicalSignalSources)
        return
      }
      return mutate(input.snapshotId, input, exec, async (snapshot, current) => {
        const selected = await task(current)
        if (selected.owner !== binding.owner || selected.route !== 'O') throw new Error('Independent child dispatch belongs to this instance’s O package.')
        return dispatchPlannerObjective(files, snapshot, selected, input.objectiveId, input.member, input.plan,
          [await record(current, paths.run(selected.taskId) + '/Dispatch.md', input.decision)], input.route, input.members)
      })
    })
  if (binding.role === 'Planner' && !binding.direct) {
    register('dss_worker_assign', 'Decompose the bound Planner objective into Worker work, save a child contract and notify its Worker. Include the relevant total Task goal, assigned work and needed verified material in that contract; do not require the Worker to read Planner working records. Complexity stays with Planner rather than escalating to Organizer. Existing long records are retained. Child artifacts use task-runs/<taskId>/<member>/workers/<childId>/ with literal childId: contract.md, notes.md, reply.md, handoff.json and records/. After consuming the checkpoint notification, read the lowercase child reply.md and handoff.json; member Reply.md is separate.', z.object({ ...snapshotInput, childId: z.string(), contract: z.string(), decision: z.string() }),
      async (input, exec) => {
        if (files instanceof PhysicalLocalFiles) {
          const current = mutationView(input.snapshotId), selected = await task(current)
          if (isTerminalTask(selected)) throw new Error('The total task is closed.')
          if (!binding.member) throw new Error('Member ownership is missing from this Planner binding.')
          const worker = workerPaths(selected.taskId, binding.member, input.childId), assertLive = liveAttempt(exec)
          await assignPhysicalWorker(files, { commandId: command(exec), taskId: selected.taskId,
            lifecycleId: selected.lifecycleId, workerRoot: worker.root, contractPath: worker.contract,
            notePath: worker.notes, replyPath: worker.reply,
            plannerMemoryPath: paths.member(selected.taskId, binding.member) + '/Planner_Memory.md',
            signalPath: paths.state(binding.member, selected.taskId) + '/' + workerWakeSignal(input.childId),
            contract: input.contract, decision: input.decision }, assertLive, async () => {
            assertLive()
            if (isTerminalTask(await task(current))) throw new Error('The Task completed before this Worker notification.')
          }, services.physicalSignalSources)
          return
        }
        return mutate(input.snapshotId, input, exec, async (snapshot, current) => {
        const selected = await task(current)
        if (isTerminalTask(selected)) throw new Error('The total task is closed.')
        if (!binding.member) throw new Error('Member ownership is missing from this Planner binding.')
        const worker = workerPaths(selected.taskId, binding.member, input.childId)
        const changes: FileChange[] = [
          { path: worker.contract, content: input.contract },
          await record(current, paths.member(selected.taskId, binding.member) + '/Planner_Memory.md', input.decision),
          { path: paths.state(binding.member, selected.taskId) + '/' + workerWakeSignal(input.childId), content: '' },
        ]
        for (const path of [worker.notes, worker.reply]) if (await files.read(snapshot, path) === undefined) changes.push({ path, content: '' })
        return changes
      })
    })
  }
  if (binding.role === 'Planner' && binding.taskId && binding.member) {
    register('dss_recovery_consume', 'Consume an actual pending recovery marker for your own member/Task after confirming normal-chain continuation; quality acceptance remains separate. This is not an acknowledgement of ordinary UI pause/resume. If no marker is pending, continue without calling this tool or creating one.',
      z.object({ ...snapshotInput, continuation: z.string() }), async (input, exec) => {
        const current = mutationView(input.snapshotId), id = taskId(current)
        if (!binding.member) throw new Error('Member ownership is missing from this Planner binding.')
        const consume = async () => {
          if (files instanceof PhysicalLocalFiles) {
            await assertRecord(current, paths.member(id, binding.member!) + '/Planner_Memory.md')
            return consumePhysicalRecovery(files, { commandId: command(exec), taskId: id,
              lifecycleId: binding.lifecycleId, member: binding.member!, continuation: input.continuation }, liveAttempt(exec))
          }
          let consumed = false
          await mutate(input.snapshotId, input, exec, async (snapshot, checked) => {
            const marker = paths.state(binding.member!, id) + '/recovery'
            if (await files.read(snapshot, marker) === undefined) throw new Error('This member has no pending recovery marker.')
            consumed = true
            return [await record(checked, paths.member(id, binding.member!) + '/Planner_Memory.md', input.continuation), { path: marker, content: null },
              ...await services.recoveryWatchChanges?.(binding, snapshot) ?? []]
          })
          return consumed
        }
        if (services.consumeRecovery) await services.consumeRecovery(binding, consume)
        else await consume()
        return
      })
  }
  if (binding.direct && (binding.role === 'Worker' || binding.role === 'Planner')) {
    register('dss_direct_deliver', 'Deliver the explicit short-task result and notify its designated recipient without constructing a member tree.',
      z.object({ ...snapshotInput, text: z.string(), resultPath: z.string().optional(), recipientSignal: z.string().optional() }), async (input, exec) => {
        const resultPath = input.resultPath ?? binding.direct!.resultPath, recipientSignal = input.recipientSignal ?? binding.direct!.recipientSignal
        if (!resultPath || !recipientSignal) throw new Error('Supply the result and recipient references from the direct task input.')
        filePath(resultPath); filePath(recipientSignal)
        if ([binding.direct!.inputPath, binding.direct!.signalPath, recipientSignal].includes(resultPath)) throw new Error('The direct result must not overwrite its original input or notification files.')
        if (recipientSignal === binding.direct!.signalPath) throw new Error('The result notification must not recreate this same pending direct-task signal.')
        if (!recipientSignal.startsWith('state/')) throw new Error('A direct recipient notification belongs in the state directory.')
        if (files instanceof PhysicalLocalFiles) {
          const current = mutationView(input.snapshotId)
          await requireDrained(current)
          const publication = await deliverPhysicalDirect(files, { commandId: physicalPublicationCommand(exec), inputPath: binding.direct!.inputPath,
            resultPath, recipientSignal, text: input.text }, liveAttempt(exec), services.physicalSignalSources,
            services.directDeliverySettled && (() => services.directDeliverySettled!(binding)))
          if (publication) await services.directDelivered?.(binding, publication.commandId)
          exec.concludeTurn(); return
        }
        await mutate(input.snapshotId, input, exec, async (_snapshot, current) => {
          await requireDrained(current)
          return [{ path: resultPath, content: input.text }, { path: recipientSignal, content: '' }]
        })
        exec.concludeTurn(); return
      })
  }
  const physicalWorkerTransfer = async (input: { snapshotId: string; reply: string; records: Array<{ path: string; text: string }>; handoff?: string },
    exec: ToolRunContext, successor?: { id: string; contract: string }): Promise<void> => {
    if (!(files instanceof PhysicalLocalFiles) || !binding.taskId || !binding.member || !binding.workerId)
      throw new Error('Physical Worker delivery requires its bound Task and Worker.')
    const business = services.workerBusiness!, markerPath = business.transferPath!(binding), assertLive = liveAttempt(exec)
    const worker = workerPaths(binding.taskId, binding.member, binding.workerId)
    const next = successor && workerPaths(binding.taskId, binding.member, successor.id)
    for (const item of input.records) {
      filePath(item.path)
      if (!item.path.startsWith(worker.records)) throw new Error('Execution records belong under this Worker’s records directory.')
    }
    if (new Set(input.records.map(item => item.path)).size !== input.records.length)
      throw new Error('A Worker delivery cannot write the same output record twice.')
    const signalPath = paths.state(binding.member, binding.taskId) + '/' + (successor
      ? workerWakeSignal(successor.id) : workerReplySignal(binding.workerId, binding.generation ?? 1))
    try {
      await transferPhysicalWorker(files, { commandId: physicalPublicationCommand(exec), markerPath,
        directory: worker.root + '/transfer/' + encodeURIComponent(binding.executionId),
        replyPath: worker.reply, reply: input.reply, notePath: worker.notes, records: input.records,
        ...(input.handoff !== undefined ? { handoff: { path: worker.handoff, text: input.handoff } } : {}),
        ...(successor && next ? { successor: { contractPath: next.contract, contract: successor.contract,
          notePath: next.notes, replyPath: next.reply, initialize: successor.id !== binding.workerId } } : {}), signalPath },
      async () => withSnapshot(files, async snapshot => {
        assertLive(); business.assertLive?.(binding, true)
        await assertTaskLifecycle(files, snapshot, binding.taskId!, binding)
        const current = { ...mutationView(input.snapshotId), snapshot, enforceLifecycle: true }
        await requireDrained(current)
        const selected = await task(current)
        if (selected.route !== 'P' || isTerminalTask(selected)) throw new Error('Worker delivery requires its running independent P Task.')
        await business.assert(binding, snapshot)
        await assertRecord(current, worker.reply)
        const marker = (await business.transfer(binding, snapshot, successor?.id ?? binding.member!, successor ? undefined : 'Planner'))
          .find(change => change.path === markerPath)
        if (!marker || typeof marker.content !== 'string') throw new Error('The actual Worker business transfer is missing.')
        return JSON.parse(marker.content) as WorkerBusinessTransfer
      }), async () => withSnapshot(files, async snapshot => {
        await assertTaskLifecycle(files, snapshot, binding.taskId!, binding)
        if (isTerminalTask((await readJson<TaskMetadata>(files, snapshot, paths.task(binding.taskId!)))!))
          throw new Error('The Task is closed; its Worker transfer cannot publish a new notification.')
      }), () => services.physicalSignalSources?.(signalPath) ?? Promise.resolve([]), () => { assertLive(); business.assertLive?.(binding, true) })
      await business.committed(binding)
    } catch (error) {
      if (error instanceof PendingRoleNotifications) throw error
      rememberRoleErrorOrigin(error, { identity: binding, taskId: binding.taskId })
      throw error
    }
  }
  if (binding.role === 'Worker' && !binding.direct) register('dss_worker_relay',
    'Continue lawful Worker work without a Planner turn at every step. A different successorId alone neither proves nor forbids inheritance; do not connect separately assigned children. Save result and successor contract before the signal; carry the relevant total Task goal, assigned work and needed verified material in the successor contract. Use dss_worker_deliver at a meaningful Planner checkpoint.',
    z.object({ ...snapshotInput, successorId: z.string(), contract: z.string(), reply: z.string(), records: outputFiles.default([]), handoff: z.string().optional() }), async (input, exec) => {
      const business = services.workerBusiness
      if (!business) throw new Error('Worker business ownership service is unavailable.')
      if (files instanceof PhysicalLocalFiles) {
        await physicalWorkerTransfer(input, exec, { id: input.successorId, contract: input.contract })
        exec.concludeTurn(); return
      }
      await mutate(input.snapshotId, input, exec, async (snapshot, current) => {
        await requireDrained(current)
        if (!binding.member || !binding.workerId) throw new Error('Worker ownership is missing from the execution binding.')
        const selected = await task(current)
        if (isTerminalTask(selected)) throw new Error('The total task is closed.')
        const worker = workerPaths(selected.taskId, binding.member, binding.workerId)
        const next = workerPaths(selected.taskId, binding.member, input.successorId)
        const changes: FileChange[] = [await record(current, worker.reply, input.reply),
          { path: worker.notes, content: '' }, { path: next.contract, content: input.contract },
          { path: paths.state(binding.member, selected.taskId) + '/' + workerWakeSignal(input.successorId), content: '' }]
        for (const item of input.records) {
          filePath(item.path)
          if (!item.path.startsWith(worker.records)) throw new Error('Execution records belong under this Worker’s records directory.')
          changes.push({ path: item.path, content: item.text })
        }
        if (input.handoff !== undefined) changes.push({ path: worker.handoff, content: input.handoff })
        if (input.successorId !== binding.workerId) for (const path of [next.notes, next.reply]) {
          if (await files.read(snapshot, path) === undefined) changes.push({ path, content: '' })
        }
        changes.push(...await business.transfer(binding, snapshot, input.successorId))
        return changes
      }, '', false, true)
      await business.committed(binding)
      exec.concludeTurn(); return
    })
  if (binding.role === 'Worker' && !binding.direct) register('dss_worker_deliver', 'At a meaningful acceptance checkpoint in the Planner plan, save long Reply/report references before notifying Planner, and clear the delivered current-round Worker Note. Ordinary steps use dss_worker_relay instead. Git commits the handoff together; Physical Local resumes this execution’s accepted delivery.',
    z.object({ ...snapshotInput, reply: z.string(), records: outputFiles.default([]), handoff: z.string().optional() }), async (input, exec) => {
      const business = services.workerBusiness
      if (!business) throw new Error('Worker business ownership service is unavailable.')
      if (files instanceof PhysicalLocalFiles) {
        await physicalWorkerTransfer(input, exec)
        exec.concludeTurn(); return
      }
      await mutate(input.snapshotId, input, exec, async (snapshot, current) => {
        await requireDrained(current)
        if (!binding.member || !binding.workerId) throw new Error('Worker ownership is missing from the execution binding.')
        if (isTerminalTask(await task(current))) throw new Error('The total task is closed; preserve late work as records rather than reopening its business flow.')
        const worker = workerPaths(taskId(current), binding.member, binding.workerId)
        const changes: FileChange[] = [await record(current, worker.reply, input.reply),
          { path: paths.state(binding.member, taskId(current)) + '/' + workerReplySignal(binding.workerId, binding.generation ?? 1), content: '' },
          { path: worker.notes, content: '' }]
        for (const item of input.records) {
          filePath(item.path)
          if (!item.path.startsWith(worker.records)) throw new Error('Execution records belong under this Worker’s records directory.')
          changes.push({ path: item.path, content: item.text })
        }
        if (input.handoff !== undefined) changes.push({ path: worker.handoff, content: input.handoff })
        // Delivery ends this Worker's round in the same authoritative write as
        // its result and Planner signal, even if shutdown loses the callback.
        changes.push(...await business.transfer(binding, snapshot, binding.member, 'Planner'))
        return changes
      }, '', false, true)
      await business.committed(binding)
      exec.concludeTurn(); return
    })
  if ((binding.role === 'Planner' && !binding.direct) || binding.role === 'Organizer') register('dss_complete',
    'Record your actual acceptance and complete the bound P or O Task after checking your pending notifications at this revision. A child hands its result to its parent without starting Recorder or Cleaner; only the root notifies Foreground and starts the total Recorder.',
    // Keep UUID validation at execution without projecting the provider-rejected pattern keyword.
    z.object({ ...snapshotInput, acceptance: z.string(), resultPaths: z.array(z.string()), workspaceResults: z.array(z.object({ path: z.string(), taskId: z.string().refine(value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value), 'A physical result Task association requires a UUID.'), owner: z.string(), instanceUUID: z.string() }).refine(isPhysicalWorkspaceReference, 'Use the exact physical result object returned by dss_workspace_reference.')).optional() }), async (input, exec) => {
      const current = mutationView(input.snapshotId), id = taskId(current)
      let physicalPlan: PhysicalCompletionPlan | undefined
      let consumedRecovery = false
      let completionNotifications: string[] | undefined
      const build = async (snapshot: FilesSnapshot, current: View, physical = false): Promise<readonly FileChange[]> => {
        if (!physical) await requireDrained(current)
        const selected = await task(current)
        if (isTerminalTask(selected)) throw new Error('The total task is already closed; use its durable results for a new task.')
        const localResults: PhysicalWorkspaceReference[] = []
        for (const reference of input.workspaceResults ?? []) if (!localResults.some(old => sameWorkspaceReference(old, reference))) localResults.push(reference)
        const family = localResults.length ? await taskFamily(files, snapshot, selected.taskId) : []
        for (const reference of localResults) {
          const own = family.find(task => task.taskId === reference.taskId)
          if (!own || ![own.owner, ...own.members ?? []].includes(reference.owner)) throw new Error('Physical result belongs to another task package or producer.')
          if (reference.owner === binding.owner && reference.instanceUUID === services.workspace?.instanceUUID) {
            await services.workspace!.validate(reference, snapshot)
          } else if (!own.workspaceResults?.some(old => sameWorkspaceReference(old, reference))) {
            throw new Error('The producing Host has not delivered this exact physical result. A remote path is not a local file.')
          }
        }
        const resultPaths = await resolveChildResultReferences(files, snapshot, selected, input.resultPaths, false, true)
        for (const path of resultPaths) {
          const target = filePath(path)
          const exists = files instanceof PhysicalLocalFiles ? await files.fileInfo(target) : await files.readBytes(snapshot, target)
          if (exists === undefined) throw new Error('Result reference is missing: ' + path)
        }
        const acceptancePath = binding.role === 'Organizer' ? paths.run(selected.taskId) + '/Organizer_Note.md'
          : paths.member(selected.taskId, binding.member!) + '/Planner_Memory.md'
        const recoveryChanges: FileChange[] = []
        if (binding.role === 'Planner' && binding.member) {
          const marker = paths.state(binding.member, selected.taskId) + '/recovery'
          if (await files.read(snapshot, marker) !== undefined) recoveryChanges.push(
            { path: marker, content: null })
        }
        consumedRecovery = recoveryChanges.length > 0
        await assertRecord(current, acceptancePath)
        if (selected.owner !== binding.owner || (binding.role === 'Organizer' ? selected.route !== 'O' : selected.route !== 'P' || binding.member !== selected.owner)) {
          throw new Error('This role is not the total-task acceptance owner.')
        }
        if (selected.children?.length) for (const link of selected.children) {
          const child = await readJson<TaskMetadata>(files, snapshot, paths.task(link.taskId))
          if (!child || child.taskId !== link.taskId || !linkedChild(selected, child)
            || (child.status !== 'complete' && child.status !== 'cancelled'))
            throw new Error('Each assigned child objective must be complete or cancelled; evaluate remaining requirements before accepting.')
        }
        const parentChanges: FileChange[] = []
        if (selected.parent) {
          const parent = await readJson<TaskMetadata>(files, snapshot, paths.task(selected.parent.taskId))
          if (!parent || parent.taskId !== selected.parent.taskId || !linkedChild(parent, selected) || parent.status !== 'running')
            throw new Error('Child completion requires its actual open parent assignment.')
          parentChanges.push({ path: childCompletionSignal(selected.parent, selected.taskId), content: '' })
        }
        // P total acceptance also accepts that owner's member work. Persist both
        // facts together; the legacy O-member completion signal is not applicable.
        const memberChanges: FileChange[] = selected.route === 'P' ? [{ path: paths.memberStatus(selected.taskId, selected.owner),
          content: encodeJson({ state: 'complete' }) }] : []
        const completed: TaskMetadata = { ...selected, status: 'complete', resultPaths, ...(localResults.length ? { workspaceResults: localResults } : {}) }
        if (physical) {
          const notifications = await pending(current)
          if (notifications.length) { completionNotifications = notifications; return [] }
          const marker = recoveryChanges[0]?.path
          const observed = marker ? (await files.listDirectory(snapshot, paths.state(binding.member!, selected.taskId), { paths: [marker] }))[0] : undefined
          physicalPlan = { task: completed, acceptance: { path: acceptancePath, text: input.acceptance },
            ...(observed ? { recovery: { path: observed.path, version: observed.version } } : {}) }
          return []
        }
        const acceptance = await record(current, acceptancePath, input.acceptance + (recoveryChanges.length ? '\nNormal continuation reached this Planner; its member recovery marker was consumed with this accepted handoff.\n' : ''))
        return [acceptance, ...recoveryChanges, ...(recoveryChanges.length ? await services.recoveryWatchChanges?.(binding, snapshot) ?? [] : []), ...parentChanges, ...memberChanges, ...taskCompletionSignals(selected), { path: paths.task(selected.taskId), content: encodeJson(completed) }]
      }
      if (files instanceof PhysicalLocalFiles) {
        const assertLive = liveAttempt(exec)
        services.errorTaskSelected?.(id, exec)
        try {
          const outcome: { result?: Awaited<ReturnType<typeof completePhysicalTask>> } = {}
          const complete = async () => {
            outcome.result = await completePhysicalTask(files, { taskId: id, lifecycleId: binding.lifecycleId ?? current.lifecycleId }, command(exec), input, async snapshot => {
            await assertTaskLifecycle(files, snapshot, id, binding)
            await build(snapshot, { ...current, snapshot, enforceLifecycle: true }, true)
            return completionNotifications ? { notifications: completionNotifications } : physicalPlan!
          }, assertLive, services.physicalSignalSources)
            return !outcome.result && consumedRecovery
          }
          if (binding.role === 'Planner' && binding.member && services.consumeRecovery) await services.consumeRecovery(binding, complete)
          else await complete()
          const result = outcome.result
          if (result) return { taskId: id, completed: false, notifications: result.notifications,
            continuation: 'New notifications arrived. Claim, read and process them, then continue this Task’s acceptance when ready.' }
        } catch (error) {
          if (error instanceof PendingRoleNotifications) throw error
          const { workId, executionId, role, taskId, member, workerId } = binding
          rememberRoleErrorOrigin(error, { identity: { workId, executionId, role, taskId, member, workerId }, taskId: taskId ?? id })
          throw error
        }
      } else {
        const complete = async () => { await mutate(input.snapshotId, input, exec, build); return consumedRecovery }
        if (binding.role === 'Planner' && binding.member && services.consumeRecovery) await services.consumeRecovery(binding, complete)
        else await complete()
      }
      exec.concludeTurn(); return
    })
  if (binding.role === 'Recorder') {
    if (services.capacity) register('dss_recorder_capacity', 'Get current session/material estimates for individual file paths, not directories, and optional window reference; unknown window does not block work. Use dss_list to find files in the relevant directories.',
      z.object({ ...snapshotInput, paths: z.array(z.string()).describe('Individual logical file paths to estimate, not directory paths. List relevant directories with dss_list and pass the selected files.') }), async input => {
        const current = view(input.snapshotId)
        const selected: string[] = []
        // Only actual Task reference syntax needs location. Ordinary files and
        // skills do not acquire Task metadata or visit an O tree for estimates.
        // Git may reuse identities within this one immutable view; physical
        // Local remains live and resolves each requested reference as read.
        const located: MaterialReadContext | undefined = files instanceof GitFiles ? {} : undefined
        for (const path of input.paths) selected.push(parseTaskReference(path) || /^tasks\/[^/]+_(P|O)\.md$/.test(path) || isConversationAttachmentPath(path)
          ? (await resolveMaterialRead(current, path, located, false)).resolvedPath : path)
        return services.capacity!(agent, { taskId: taskId(current), paths: selected }, current.snapshot)
      })
    register('dss_recorder_save',
      'Save this root Task tree’s AI-authored archives and retained DSS logical originals. Include the returned root archiveRecordsPath in outputs; additional files may use verified descendant archives or exact skill paths. retainedPaths preserves DSS logical originals byte-for-byte, not native workspace files. Read an existing skill’s exact full file with dss_read before editing it. Identical current text needs no definition write; independent line changes merge. ' +
      (files instanceof PhysicalLocalFiles
        ? 'In physical Local, complete this Recorder’s submitted skill definitions and actual conflicts before its archive and own Cleaner handoff. saved:false keeps the original Recorder active. A definite conflict permits a new explicit proposal; an UNKNOWN file operation continues with its original accepted proposal/read base and identity. Already included contributions are not written again. Files and Tasks progress independently. Derived catalog refresh does not hold the final handoff. '
        : 'In Git, this Recorder publishes each submitted skill independently to latest main before its archive and own Cleaner handoff. A real conflict returns saved:false with actual base/proposed/current to this original Recorder; read current content and make a new explicit save after reconciliation. An UNKNOWN transaction keeps its original call identity and inputs until resolved. Files and Tasks progress independently. A confirmed final save replay does not resend definitions. Each definition and its shared catalog entry use the same conditional Git commit; native discovery refresh follows confirmed publication. This tool does not create branches. ') +
      'Finish notes, artifact preservation and pending-notification checks first, and make this the last tool call in its batch. Only a successful final handoff concludes this Recorder turn; do not follow that handoff with Task writes or claims.',
      z.object({ ...snapshotInput, outputs: recorderOutputFiles.min(1).describe('AI-authored files including the root archiveRecordsPath returned by dss_snapshot or dss_claim. Additional files may be saved under any verified descendant Task’s own pinned archive namespace or long-term skills. No per-child records.md is required. Each Task’s retention.json remains program-managed. Current mechanical state is in Task metadata runtimeState for Git and archive state.json for Local; historical state.json and lifecycles/ remain read-only history.'), retainedPaths: z.array(z.string()).default([]).describe('Exact DSS logical file or directory paths to retain, including original texts/binary files read through dss_read and the path field returned by dss_preserve_artifact, not its internal manifestPath by default. Choose originals with independent retention value; do not back up all working material by default. Direct Task-material links explicitly authored in these outputs and the Task’s declared results also select their referenced originals. Selected originals are copied byte-for-byte into this Task archive with relocation references; program-owned state.json and the Task .command-receipts subtree are not retained outputs. In both Local and Git, known missing originals are reported in the saved retention and are not claimed to have been copied. Do not supply native filesystem paths.') }), async (input, exec) => {
        const original = mutationView(input.snapshotId), id = taskId(original)
        const outputs = input.outputs.map(item => ({ path: filePath(item.path), content: item.text }))
        if (new Set(outputs.map(output => output.path)).size !== outputs.length) throw new Error('Recorder outputs must not repeat a path.')
        if (input.outputs.some(output => output.path.startsWith('skills/') && !isSkillFile(output.path))) throw new Error('Choose an exact file under skills/<name>/.')
        const skillProposals = input.outputs.filter(output => isSkillFile(output.path))
        const catalogIssues = new Map<string, string[]>()
        const notifyPublishedSkills = () => {
          try { services.skillsChanged?.() }
          catch (error) { catalogIssues.set('native-cache', ['Skills saved, but native catalog refresh did not complete: ' + (error instanceof Error ? error.message : String(error))]) }
        }
        const saveCommand = command(exec)
        let bases = saveBases.get(saveCommand)
        if (!bases) { bases = new Map(skillProposals.map(output => [output.path, skillReads.resolve(output.path, output.baseReadId)])); saveBases.set(saveCommand, bases) }
        if (files instanceof PhysicalLocalFiles) {
          const assertLive = liveAttempt(exec)
          const result = await publishPhysicalRecorder(files, { commandId: saveCommand, taskId: id, signal: exec.signal,
            lifecycleId: binding.lifecycleId ?? original.lifecycleId, owner: binding.owner, outputs: input.outputs,
            retainedPaths: input.retainedPaths, bases }, assertLive,
          snapshot => requireDrained({ ...original, snapshot }), services.skillsChanged)
          saveBases.delete(saveCommand)
          if (!result.saved) return result
          // This confirmed final handoff ends the Recorder view scope now.
          // Native concludeTurn still drains later calls in its accepted batch;
          // Host resource disposal remains independent of directory cleanup.
          disposed = true
          void closeAll().catch(services.onError)
          exec.concludeTurn(); return result
        }
        const validate = async (current: View) => {
          const selected = await task(current)
          if (selected.parent) throw new Error('Child Tasks retain their runtime materials for the total-task Recorder; they cannot finalize or request Cleaner independently.')
          if (selected.owner !== binding.owner || !isTerminalTask(selected)) throw new Error('Recorder finalization belongs to the principal’s terminal task (complete or cancelled).')
          if (!outputs.some(item => item.path === archiveRecordsPath(selected))) throw new Error('Save the AI-authored Task records at ' + archiveRecordsPath(selected) + ' before requesting Cleaner.')
          const family = await taskFamily(files, current.snapshot, selected.taskId)
          if (outputs.some(item => family.some(member => item.path.startsWith(paths.archive(member) + '/lifecycles/')))) throw new Error('Previous lifecycle archives are read-only historical material.')
          if (outputs.some(item => family.some(member => [paths.archive(member) + '/retention.json', paths.archive(member) + '/state.json'].some(reserved => item.path === reserved || item.path.startsWith(reserved + '/'))))) throw new Error('retention.json and state.json are program-managed records, not AI-authored output paths.')
          if (outputs.some(item => !family.some(member => item.path.startsWith(paths.archive(member) + '/') && taskArchiveOwnsPath(member, item.path)) && !item.path.startsWith('skills/'))) throw new Error('Recorder outputs belong in this actual Task tree’s archives or long-term skills.')
          return { selected, family }
        }
        let missingReferences: string[] | undefined
        let completedSkills: string[] = []
        let receipt: FileReceipt | void
        try {
          receipt = await mutate(input.snapshotId, input, exec, async (_snapshot, current) => {
            const { selected, family } = await validate(current)
            const linked = selectRecorderOutputReferences(family.length ? family : [selected], input.outputs)
            const skillProposals = linked.outputs.filter(output => isSkillFile(output.path))
            if (skillProposals.length) {
              const assertLive = liveAttempt(exec)
              const taskOwner = binding.taskId && !binding.direct
                ? services.taskCommandOwner?.({ taskId: binding.taskId, lifecycleId: binding.lifecycleId }) : undefined
              // The original final command checks its receipt before this builder.
              // Each definition still owns its independent transaction and inputs.
              const outcomes = await Promise.allSettled(skillProposals.map(proposal => services.transact(
                saveCommand + ':skill:' + createHash('sha256').update(proposal.path).digest('hex'),
                { kind: 'original-recorder-skill', proposal, base: bases!.get(proposal.path) },
                { reevaluate: true, gitEmptyResult: 'observation-only', ...(taskOwner ? { taskOwner } : {}), beforeAttempt: assertLive,
                  deriveChanges: async (snapshot, changes) => {
                    // This definition and its shared catalog entry publish in ONE
                    // Git commit. CAS retries merge the current catalog, not the
                    // proposal's earlier whole-index image or another Task's lane.
                    const bytes = changes.length ? undefined : await files.readBytes(snapshot, proposal.path)
                    const current: FileChange = changes[0] ?? (bytes === undefined ? { path: proposal.path, content: null } : { path: proposal.path, bytes })
                    const index = await prepareFrameworkSkillIndex(files, snapshot, [current], { skipUnchanged: true })
                    catalogIssues.set(proposal.path, index.issues)
                    return index.changes
                  } },
                snapshot => mergeSkillProposals(files, snapshot, [proposal], new Map([[proposal.path, bases!.get(proposal.path)]])))))
              completedSkills = skillProposals.filter((_proposal, index) => outcomes[index]!.status === 'fulfilled').map(proposal => proposal.path)
              const failures = outcomes.filter((value): value is PromiseRejectedResult => value.status === 'rejected')
              if (failures.length) {
                const unknown = failures.find(value => !(value.reason instanceof SkillMergeRequired))
                if (unknown) throw unknown.reason
                throw new SkillMergeRequired(failures.flatMap(value => (value.reason as SkillMergeRequired).issues))
              }
            }
            const archiveOutputs = linked.outputs.filter(output => !isSkillFile(output.path))
              .map(output => ({ path: filePath(output.path), content: output.text }))
            const retainedPaths = await resolveChildResultReferences(files, current.snapshot, selected, [...input.retainedPaths, ...linked.retainedPaths], true)
            const originalRetention: RetentionManifest = { outputs: archiveOutputs.map(output => output.path), retainedPaths,
              recorderCommand: saveCommand, ...(selected.lifecycleId ? { lifecycleId: selected.lifecycleId } : {}) }
            const archival = await prepareRecorderRetention(files, current.snapshot, selected, originalRetention, archiveOutputs)
            missingReferences = archival.retention.missingReferences
            return [...archival.changes, ...archival.ancestorChanges,
              { path: paths.archive(selected) + '/retention.json', content: encodeJson(archival.retention) },
              { path: paths.state(binding.owner, id) + '/Cleaner', content: '' }]
          }, '', true)
        } catch (error) {
          // Refresh outside the original transaction's assessed-input capture.
          // Already published siblings remain usable even if this call has a conflict.
          if (completedSkills.length) notifyPublishedSkills()
          if (!(error instanceof SkillMergeRequired)) throw error
          saveBases.delete(saveCommand)
          return { saved: false, recorderCommand: saveCommand, completedSkills, skillIssues: error.issues,
            continuation: 'This Recorder still owns its Task. Read the current conflicting skill, finish the content, then make a new save. Cleaner has not been requested.' }
        }
        saveBases.delete(saveCommand)
        // Publication is confirmed. Notify outside the transaction so the
        // existing non-blocking refresh cannot inherit its earlier snapshot.
        if (skillProposals.length) notifyPublishedSkills()
        exec.concludeTurn()
        return receipt?.replay || skillProposals.length || missingReferences?.length ? { saved: true, recorderCommand: saveCommand,
          ...(receipt?.replay ? { replay: true } : missingReferences?.length ? { missingReferences } : {}),
          ...(skillProposals.length ? { skillPublication: 'This Recorder published each skill and its shared catalog entry in one conditional Git commit, completed its archive and own Cleaner handoff, and requested native discovery refresh.', skillIssues: [...catalogIssues.values()].flat() } : {}) } : undefined
      })
  }
  if (services.workspace) register('dss_workspace_reference', 'Link an existing user deliverable file or directory in this Task workspace without uploading it to Local/Git storage. Use authorized native tools to create the requested deliverable first. Do not register internal plans, Notes, handoffs or archive records as user results. The tool verifies and records the exact absolute native path with its owner and instanceUUID, plus a Task association for record keeping. Use the returned markdown link unchanged: its destination is the real path and its standard title carries the producing Host. Opening uses only that address and Host identity, never Task history or Recorder completion. Recording is not required to open an existing source-bearing physical link and is not acceptance or completion. It is not a Recorder retainedPaths entry. This does not copy, upload or judge the file.',
    z.object({ ...snapshotInput, sourcePath: z.string().min(1) }), async (input, exec) => {
      const current = view(input.snapshotId), id = taskId(current)
      await assertTaskLifecycle(files, current.snapshot, id, binding.taskId ? binding : current)
      const result = await services.workspace!.reference(agent, id, input.sourcePath, current.snapshot, exec.signal)
      const { path, taskId: sourceTaskId, owner, instanceUUID } = result
      const physical = { path, taskId: sourceTaskId, owner, instanceUUID }
      if (files instanceof PhysicalLocalFiles) {
        const assertLive = liveAttempt(exec), snapshot = await files.snapshot({ signal: exec.signal })
        services.errorTaskSelected?.(id, exec)
        try {
          // This port adds one reference to one existing Task record. Coordinate
          // only that file's read/modify/write; unrelated Tasks and Worker bodies
          // neither wait nor acquire an old SQL command transaction.
          await files.updateAsync(paths.task(id), async bytes => {
            assertLive()
            if (!bytes) throw new Error('Task metadata does not exist.')
            const selected = JSON.parse(Buffer.from(bytes).toString('utf8')) as TaskMetadata
            if (selected.taskId !== id) throw new Error('Task workspace metadata identity differs.')
            await assertTaskLifecycle(files, snapshot, id, binding.taskId ? binding : current)
            if (!binding.direct && ['Planner', 'Worker'].includes(binding.role) && selected.route !== 'P')
              throw new Error('Planner and Worker mutations require their bound independent P Task.')
            if (binding.role === 'Worker' && !binding.direct) {
              services.workerBusiness?.assertLive?.(binding)
              await services.workerBusiness?.assert(binding, snapshot)
            }
            await services.workspace!.validate(physical, snapshot)
            assertLive()
            if (selected.workspaceResults?.some(old => sameWorkspaceReference(old, physical))) return { value: undefined }
            return { value: undefined, content: encodeJson({ ...selected, workspaceResults: [...selected.workspaceResults ?? [], physical] }) }
          })
        } catch (error) {
          const { workId, executionId, role, taskId, member, workerId } = binding
          rememberRoleErrorOrigin(error, { identity: { workId, executionId, role, taskId, member, workerId }, taskId: taskId ?? id })
          throw error
        } finally { await snapshot.release() }
      } else await mutate(input.snapshotId, input, exec, async (snapshot, value) => {
        exec.signal.throwIfAborted()
        const selected = await task(value)
        await services.workspace!.validate(physical, snapshot)
        // Keep the location for Recorder, not as an opening lookup or prerequisite.
        if (selected.workspaceResults?.some(old => sameWorkspaceReference(old, physical))) return []
        return [{ path: paths.task(id), content: encodeJson({ ...selected, workspaceResults: [...selected.workspaceResults ?? [], physical] }) }]
      })
      return { ...result, markdown: physicalWorkspaceLink(physical) }
    })
  if (services.artifacts) register('dss_preserve_artifact', 'Import an authorized native filesystem file byte-for-byte into this Task archive. sourcePath is native; destinationPath is DSS logical. The returned path is the deliverable logical reference for material links, resultPaths and retainedPaths. The returned manifestPath is an internal artifact-integrity index, not a deliverable or the Task retention.json; do not present it as a retention manifest or require its read/retention for ordinary delivery or archival. Do not use sourcePath as a DSS Markdown material link. This does not read DSS logical storage. Recorder retains existing DSS logical originals with dss_recorder_save.retainedPaths instead. This does not judge business quality.',
    z.object({ ...snapshotInput, sourcePath: z.string().describe('Actual authorized native filesystem file, absolute or relative to the Agent native working directory. Not a DSS logical reference returned by dss_read/dss_list; do not infer an OS path from it.'), destinationPath: z.string().describe('DSS logical destination under the archiveDirectory returned by dss_snapshot or dss_claim for this actual Task, excluding nested child Task archives; not a native filesystem path. The returned path field can be retained in dss_recorder_save; manifestPath is internal metadata, not a second deliverable.') }), async (input, exec) => {
      const current = mutationView(input.snapshotId), id = taskId(current)
      filePath(input.destinationPath)
      return services.artifacts!.preserve(agent, { sourcePath: input.sourcePath, destinationPath: input.destinationPath, taskId: id }, binding,
        files instanceof PhysicalLocalFiles ? physicalPublicationCommand(exec) : command(exec), { signal: exec.signal, beforeAttempt: liveAttempt(exec), taskOwner: services.taskCommandOwner?.({ taskId: id, lifecycleId: current.lifecycleId ?? binding.lifecycleId }) })
    })
  if (binding.role !== 'Foreground' && services.observation) register('dss_reset_observation',
    'After actually receiving a native Host probe or warning, reset this execution’s inactivity cycle once using one received probeId. Other notices from an already-reset cycle return superseded with reset:false; repeating a handled probe returns already-handled. Helper may instead finish its own inspected member recovery check using recoveryCheckId: the exact id of that original helperNotifications item. This restarts only that check’s 30-minute interval; repeating an older check cannot reset a newer interval. Neither form consumes the recovery marker or sends a text reply.',
    binding.role === 'Helper' ? z.object({ probeId: z.string().optional(), recoveryCheckId: z.string().optional() })
      : z.object({ probeId: z.string() }),
    (input, exec) => services.observation!.reset(binding, input, command(exec), exec.signal))
  if (services.helper) {
    register('dss_help', 'Report an actual fault and ask Helper to inspect preserved facts; this is not an automatic restart.', z.object({ facts: z.string() }),
      (input, exec) => services.helper!.request(binding, input.facts, command(exec)))
    if (binding.role === 'Helper') {
      const identity = z.object({ workId: z.string(), executionId: z.string(), role: z.enum(['Foreground', 'Organizer', 'Planner', 'Worker', 'Recorder', 'Helper']),
        taskId: z.string().optional(), member: z.string().optional(), workerId: z.string().optional(), lifecycleId: z.string().optional() })
      const restoreFacts = { facts: z.string(), hypotheses: z.string(), actionsTaken: z.string(), continuation: z.string() }
      register('dss_restore', 'Request restoration of an exact execution target or a real pending wake after preserving business records. Supply exactly one selector; native admission and stop confirmation remain Host responsibilities. After inspecting records, use disposition release with an exact target only to retire its local internal state when its Task is missing or terminal; this preserves original material and does not restore business work. After the user chooses restoration of unfinished or cancelled work, optional taskRecovery restores missing Task structures and associations in place with the same target taskId from actual retained recordPaths and evidence-based route, owner and continuation. It does not reopen a completed business Task for a correction or new requirement; use a new Task ID and reference its original results. It reconnects the proven original workspace without copying or overwriting material and raises the existing fixed recovery signal for Planner inspection. It never promises exact original instructions or changes prior terminal history.',
        z.object({ ...restoreFacts, disposition: z.literal('release').optional(), taskRecovery: z.object({ recordPaths: z.array(z.string()).min(1), route: z.enum(['P', 'O']), owner: z.string().min(1), continuation: z.string().min(1) }).optional(), target: identity.optional(), wakeId: z.string().min(1).optional() })
          .refine(input => (input.target !== undefined) !== (input.wakeId !== undefined), 'Supply exactly one selector: target or wakeId.')
          .refine(input => input.disposition !== 'release' || input.target !== undefined, 'Release requires an exact execution target.')
          .refine(input => !input.taskRecovery || input.target !== undefined && input.disposition !== 'release', 'Task recovery requires an exact target and cannot also release it.'),
        (input, exec) => {
          const { target, wakeId, ...facts } = input
          if (target !== undefined) return services.helper!.restore(binding, { ...facts, target }, command(exec))
          if (wakeId !== undefined) return services.helper!.restore(binding, { ...facts, wakeId }, command(exec))
          throw new Error('Restoration requires an execution target or a pending wake.')
        })
      register('dss_restore_host', 'Request actual overall restoration after preserving facts: restore Host scheduling/error state, scan Task/member eligibility, write recovery markers and notify the relevant managers. This is not a read-only inspection or an exit check; use existing snapshot/list/read tools for needed facts. This does not stop all Agents.',
        z.object({ facts: z.string(), hypotheses: z.string(), actionsTaken: z.string(), continuation: z.string() }),
        (input, exec) => services.helper!.restoreHost(binding, input, command(exec)))

    }
  }
}
