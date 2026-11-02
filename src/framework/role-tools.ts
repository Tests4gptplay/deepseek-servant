import { prepareRecorderRetention } from './recorder-retention.js'
import { LocalFiles } from './local-files.js'
import { foregroundMemoryGuide } from '../contracts/foreground-memory.js'
import { captureCleanupInputs, captureCleanupReferences, cleanupRecordPath, type CleanupRecord, type RetentionManifest } from './cleaner.js'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { toolParameters } from '../contracts/schemas.js'
import { prepareFrameworkSkillIndex } from './skills.js'
import { frameworkRolePrompt } from './role-prompts.js'
import type { WorkIdentity, MemberIdentity } from './recovery.js'
import { filePath, withReadOperation, FilesConflictError, type FilesStore, type FilesSnapshot, type FileChange, type FileReceipt } from './transactions.js'
import { paths, readJson, encodeJson, claimSignals, deliverMember, completeMember, type TaskMetadata } from './task-files.js'

export interface FrameworkRoleBinding extends WorkIdentity {
  owner: string
  stateDirectory?: string
  recordPath?: string
  notePath?: string
  replyPath?: string
  generation?: number
  collaborationId?: string
  direct?: { inputPath: string; signalPath: string; resultPath?: string; recipientSignal?: string }
}
export type HelperRestoreInput = { facts: string; hypotheses: string; actionsTaken: string; continuation: string } &
  ({ target: WorkIdentity; wakeId?: never } | { wakeId: string; target?: never })

export interface FrameworkRoleServices {
  files: FilesStore
  transact(id: string, request: unknown, options: { expectedRevision?: string; snapshot?: FilesSnapshot },
    build: (snapshot: FilesSnapshot) => Promise<readonly FileChange[]>): Promise<FileReceipt>
  notifications(snapshot: FilesSnapshot, binding: FrameworkRoleBinding, taskId?: string): Promise<string[]>
  afterRecoveryConsumed(binding: FrameworkRoleBinding, member: MemberIdentity, receipt: FileReceipt): Promise<void>
  onError(error: unknown): void
  skillsChanged?(): void
  skillResourceAllowed?(binding: FrameworkRoleBinding, path: string): boolean
  conversation?: {
    foregroundRoot: string
    read(input: { mode: 'page' | 'message' | 'recent' | 'pending' | 'memory' | 'search' | 'text'; limit?: number; beforeId?: string; reference?: string; query?: string; cursor?: number }, binding: FrameworkRoleBinding): Promise<unknown>
    send(input: { id: string; text: string; intent: 'human' | 'ai'; replyTo?: string }, binding: FrameworkRoleBinding, commandId: string): Promise<unknown>
    claim(input: { messageIds: string[]; list: string; cache: string; expectedRevision: string }, binding: FrameworkRoleBinding, commandId: string): Promise<unknown>
  }
  artifacts?: { preserve(agent: Agent, input: { sourcePath: string; destinationPath: string; taskId: string }, binding: FrameworkRoleBinding,
    commandId: string, options: { expectedRevision?: string; snapshot?: FilesSnapshot; signal?: AbortSignal }): Promise<unknown> }
  capacity?(agent: Agent, input: { taskId: string; paths: string[] }): Promise<unknown>
  observation?: { reset(binding: FrameworkRoleBinding, input: { probeId: string }, commandId: string, signal: AbortSignal): Promise<unknown> }
  helper?: {
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
export const workerWakeSignal = (childId: string) => 'Worker_' + encodeURIComponent(childId) + '_Planner'
export function signalWorkerId(name: string): string | undefined {
  const match = /^Worker_(.+)_Planner$/.exec(name)
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
export const archiveRecordsPath = (taskId: string) => paths.archive(taskId) + '/records.md'
const outputFiles = z.array(z.object({ path: z.string(), text: z.string() }))
interface View { snapshot: FilesSnapshot; taskId?: string }
interface ViewReference { revision: string; taskId?: string; nonce: string }

/** Installs only scoped tools; native tools and their existing permissions remain intact. */
export function installFrameworkRoleTools(ctx: Context, agent: Agent, binding: FrameworkRoleBinding, services: FrameworkRoleServices): void {
  const views = new Map<string, View>()
  const files = services.files
  const close = async (id: string) => { const view = views.get(id); if (view) { views.delete(id); await view.snapshot.release() } }
  const closeAll = async () => { for (const id of [...views.keys()]) await close(id) }
  const offTurn = ctx.on('session/event', (session, event) => {
    if (session === agent.session && event.type === 'turn/end') void closeAll().catch(services.onError)
  })
  ctx.effect(() => async () => { offTurn(); await closeAll() }, 'servant.framework.role-tools')
  ctx.systemPrompt.section({ name: 'deepseek-servant:framework-role', order: 100, interpolate: false, text: frameworkRolePrompt(binding.role) })
  ctx.systemPrompt.section({ name: 'deepseek-servant:framework-binding', order: 101, interpolate: false,
    text: 'Current role and source locations: ' + JSON.stringify(binding) })
  if (binding.role === 'Foreground' && services.conversation) ctx.systemPrompt.section({
    name: 'deepseek-servant:foreground-memory-guide', order: 102, interpolate: false,
    text: foregroundMemoryGuide(services.conversation.foregroundRoot + '/Foreground_List.md', services.conversation.foregroundRoot + '/Foreground_Cache.md',
      'Use dss_conversation_read mode memory to read both documents before replacing them. Preserve their existing contents and sources in dss_conversation_claim, then read memory back before reporting an update. Never use empty replacement text merely because you have not read the old memory. Use dss_record at a reviewed snapshot for authorized document maintenance.'),
  })
  const register = <T extends z.ZodType>(name: string, description: string, schema: T,
    execute: (input: z.infer<T>, exec: ToolRunContext) => Promise<unknown>) => {
    ctx.tools.register({ name, description, parameters: toolParameters(schema),
      output: { schema: {}, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
      execute: async (raw, exec) => {
        if (exec.agent !== agent) throw new Error('Tool execution does not belong to this scoped Agent.')
        exec.signal.throwIfAborted()
        const result = await execute(schema.parse(raw), exec)
        return result === undefined ? null : JSON.parse(JSON.stringify(result))
      } })
  }
  // Only storage-reading tools open this short authority scope. Native/control
  // tools never acquire Git credentials merely to reset or request recovery.
  const registerRead = <T extends z.ZodType>(name: string, description: string, schema: T,
    execute: (input: z.infer<T>, exec: ToolRunContext) => Promise<unknown>) =>
    register(name, description, schema, (input, exec) => withReadOperation(files, () => execute(input, exec)))
  const view = (id: string): View => { const value = views.get(id); if (!value) throw new Error('Snapshot is released; open and read a current snapshot.'); return value }
  const taskId = (value: View): string => {
    const id = binding.taskId ?? value.taskId
    if (!id) throw new Error('Select the task being processed.')
    return id
  }
  const task = async (value: View): Promise<TaskMetadata> => {
    const current = await readJson<TaskMetadata>(files, value.snapshot, paths.task(taskId(value)))
    if (!current) throw new Error('Task metadata does not exist; use the supplied direct-task paths for a short task.')
    if (files instanceof LocalFiles) {
      const cleanup = await readJson<CleanupRecord & { historyCleared?: boolean }>(files, value.snapshot, cleanupRecordPath(current.taskId))
      if (cleanup?.version === 1 && cleanup.taskId === current.taskId && cleanup.phase === 'released' && cleanup.historyCleared === true)
        throw new Error('This Task history was explicitly cleared; submit a new Task instead of reopening the old business flow.')
    }
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
    // the original immutable snapshot or returns its already-confirmed receipt.
    return { snapshot: { revision: saved.revision, release: async () => {} }, taskId: saved.taskId }
  }
  const command = (exec: ToolRunContext) => String(agent.id) + ':' + String(exec.callId)
  const mutate = async (id: string, request: unknown, exec: ToolRunContext,
    build: (snapshot: FilesSnapshot, value: View) => Promise<readonly FileChange[]>, suffix = '') => {
    const current = mutationView(id), held = views.get(id)
    try {
      return await services.transact(command(exec) + suffix, request, { expectedRevision: current.snapshot.revision, ...(held ? { snapshot: held.snapshot } : {}) }, async snapshot => {
        if (snapshot.revision !== current.snapshot.revision) throw new FilesConflictError(current.snapshot.revision)
        return build(snapshot, { ...current, snapshot })
      })
    } finally { await close(id) }
  }
  const pending = (value: View) => services.notifications(value.snapshot, binding, value.taskId ?? binding.taskId)
  const requireDrained = async (value: View) => { if ((await pending(value)).length) throw new Error('Pending notifications remain; claim and process them before final handoff.') }
  const writableRecord = (path: string, value: View): boolean => {
    filePath(path)
    if ([binding.recordPath, binding.notePath, binding.replyPath].includes(path)) return true
    if (binding.direct) return path === binding.direct.resultPath
    if (binding.role === 'Foreground' && services.conversation) return ['Foreground_List.md', 'Foreground_Cache.md'].some(name => path === services.conversation!.foregroundRoot + '/' + name)
    if (binding.role === 'Helper') return /^debug\/\d{4}-\d{2}-\d{2}\.md$/.test(path)
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
  const record = async (value: View, path: string, text: string, append = true): Promise<FileChange> => {
    if (!writableRecord(path, value)) throw new Error('Choose a record owned by this role and work item.')
    const selectedId = binding.taskId ?? value.taskId
    if (binding.role === 'Organizer' && selectedId && ['Organizer_Note.md', 'Dispatch.md'].some(name => path === paths.run(selectedId) + '/' + name)) {
      const selected = await task(value)
      if (selected.owner !== binding.owner || selected.route !== 'O') throw new Error('Organizer records belong to this principal’s O task.')
    }
    if (!binding.direct && ['Organizer', 'Planner', 'Worker', 'Recorder'].includes(binding.role)) {
      const id = taskId(value)
      const cleanup = path.startsWith(paths.run(id) + '/')
        ? await readJson<CleanupRecord>(files, value.snapshot, cleanupRecordPath(id)) : undefined
      if (cleanup?.phase === 'files-cleaned' || cleanup?.phase === 'released') throw new Error('This Task runtime namespace is already cleaned; the old execution cannot recreate it.')
    }
    return { path, content: append ? (await files.read(value.snapshot, path) ?? '') + text : text }
  }
  const recorderReadable = async (value: View, path: string) => {
    if (binding.role !== 'Recorder') return
    const id = taskId(value)
    if (services.skillResourceAllowed?.(binding, path)) return
    if (path === paths.cache(id) || path.startsWith(paths.archive(id) + '/') || path === paths.run(id) + '/Recorder_Note.md') return
    const links = await readJson<{ links: Array<{ kind: 'file' | 'directory'; path: string }> }>(files, value.snapshot, paths.cache(id))
    if (!links?.links.some(link => link.kind === 'file' ? path === link.path : path.startsWith(link.path))) throw new Error('Read original Recorder material through this Task’s Cache links.')
  }

  registerRead('dss_snapshot', 'Open one fixed storage revision for business reads and conditional writes. Release it after use.', z.object({ taskId: z.string().optional() }), async input => {
    if (binding.taskId && input.taskId && input.taskId !== binding.taskId) throw new Error('This execution is bound to another task.')
    const snapshot = await files.snapshot(), selected = input.taskId ?? binding.taskId
    const id = Buffer.from(JSON.stringify({ revision: snapshot.revision, taskId: selected, nonce: randomUUID() } satisfies ViewReference)).toString('base64url')
    const current = { snapshot, taskId: selected }
    views.set(id, current)
    try { return { snapshotId: id, revision: snapshot.revision, taskId: selected, notifications: await pending(current), binding } }
    catch (error) { await close(id); throw error }
  })
  register('dss_snapshot_release', 'Release a fixed view when no longer needed.', z.object(snapshotInput), async input => { await close(input.snapshotId); return { released: true } })
  registerRead('dss_read', 'Read exact logical file content at the opened revision.', z.object({ ...snapshotInput, path: z.string() }), async input => {
    const current = view(input.snapshotId); await recorderReadable(current, input.path)
    const bytes = await files.readBytes(current.snapshot, input.path)
    if (bytes === undefined) return { path: input.path, revision: current.snapshot.revision, exists: false }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      if (!text.includes('\0')) return { path: input.path, revision: current.snapshot.revision, exists: true, text }
    } catch (error) { if (!(error instanceof TypeError)) throw error }
    return { path: input.path, revision: current.snapshot.revision, exists: true, binary: true, bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'), hint: 'Use the artifact download interface for the original bytes.' }
  })
  registerRead('dss_list', 'List direct file metadata at one directory, without loading business bodies.', z.object({ ...snapshotInput, directory: z.string() }), async input => {
    const current = view(input.snapshotId); await recorderReadable(current, input.directory)
    return { revision: current.snapshot.revision, files: await files.listDirectory(current.snapshot, input.directory) }
  })
  register('dss_record', 'Persist actual progress or results in this role’s record. Append preserves earlier facts.', z.object({ ...snapshotInput, path: z.string(), text: z.string(), append: z.boolean().default(true) }),
    (input, exec) => mutate(input.snapshotId, input, exec, async (_snapshot, current) => [await record(current, input.path, input.text, input.append)]))
  register('dss_claim', 'Atomically write your takeover record and consume selected ordinary notifications. Recovery is not an ordinary notification.',
    z.object({ ...snapshotInput, signals: z.array(z.string()), recordPath: z.string(), text: z.string() }),
    (input, exec) => mutate(input.snapshotId, input, exec, async (snapshot, current) => {
      const available = new Set(await pending(current))
      if (input.signals.some(signal => !available.has(signal))) throw new Error('Select pending notifications addressed to this role.')
      let takeover = binding.recordPath
      if (!binding.direct && binding.role === 'Planner' && binding.member) takeover = paths.member(taskId(current), binding.member) + '/Planner_Memory.md'
      if (!binding.direct && binding.role === 'Worker' && binding.member && binding.workerId) takeover = workerPaths(taskId(current), binding.member, binding.workerId).notes
      if (binding.role === 'Organizer') takeover = paths.run(taskId(current)) + '/Organizer_Note.md'
      if (binding.role === 'Recorder') takeover = paths.run(taskId(current)) + '/Recorder_Note.md'
      if (binding.role === 'Foreground' && services.conversation) takeover ??= services.conversation.foregroundRoot + '/Foreground_Cache.md'
      if (takeover && input.recordPath !== takeover) throw new Error('Takeover belongs in this role’s current continuation record: ' + takeover)
      return claimSignals(files, snapshot, input.signals, [await record(current, input.recordPath, input.text)])
    }))

  if (binding.role === 'Foreground') {
    register('dss_submit_task', 'Submit an original named P/O task. Host assigns its UUID and initializes routing.', z.object({ ...snapshotInput, name: z.string(), route: z.enum(['P', 'O']), text: z.string() }),
      (input, exec) => mutate(input.snapshotId, input, exec, async snapshot => {
        filePath(input.name); if (input.name.includes('/')) throw new Error('Task name occupies one filename segment.')
        const path = 'tasks/' + input.name + '_' + input.route + '.md'
        if (await files.read(snapshot, path) !== undefined) throw new Error('This task filename already exists; select a distinct task name.')
        return [{ path, content: input.text }]
      }))
    register('dss_submit_direct', 'Submit an explicit short Planner/Worker task with its result and recipient references, without creating a full Task tree.',
      z.object({ ...snapshotInput, id: z.string(), member: z.string(), role: z.enum(['Planner', 'Worker']), text: z.string(), resultPath: z.string(), recipientSignal: z.string() }),
      (input, exec) => mutate(input.snapshotId, input, exec, async snapshot => {
        const signalPath = 'state/' + buildDirectSignal(input.role, input.member, input.id)
        const inputPath = 'direct/' + input.id + '.md'
        filePath(input.resultPath); filePath(input.recipientSignal)
        if ([inputPath, signalPath, input.recipientSignal].includes(input.resultPath)) throw new Error('The direct result must not overwrite its original input or notification files.')
        if (input.recipientSignal === signalPath) throw new Error('The result notification must not recreate this same pending direct-task signal.')
        if (!input.recipientSignal.startsWith('state/')) throw new Error('A direct recipient notification belongs in the state directory.')
        if (await files.read(snapshot, inputPath) !== undefined || await files.read(snapshot, signalPath) !== undefined) throw new Error('This direct task identity already exists; preserve it and choose a new identity for new work.')
        const header = { type: 'direct', id: input.id, role: input.role, member: input.member, resultPath: input.resultPath, recipientSignal: input.recipientSignal }
        return [
          { path: inputPath, content: '# Direct task\n\n' + encodeJson(header) + '\n' + input.text },
          { path: signalPath, content: '' },
        ]
      }))
    register('dss_supplement_task', 'Append a supplement to an open Task and notify its acceptance role in the same conditional transaction. A closed Task requires a new Task.',
      z.object({ ...snapshotInput, text: z.string() }),
      (input, exec) => mutate(input.snapshotId, input, exec, async (snapshot, current) => {
        const selected = await task(current)
        if (selected.status === 'complete') throw new Error('The total task is closed; submit a new Task referencing its durable results and this new requirement.')
        const original = await files.read(snapshot, selected.sourcePath)
        if (original === undefined) throw new Error('The original task requirement is missing.')
        const recipient = selected.route === 'P' ? 'Planner' : 'Organizer'
        return [
          { path: selected.sourcePath, content: original + '\n\n' + input.text },
          { path: paths.state(selected.owner, selected.taskId) + '/' + recipient + '_Foreground', content: '' },
        ]
      }))
    if (services.conversation) {
      register('dss_conversation_read', 'Read confirmed shared conversation history in this collaboration scope.', z.object({ mode: z.enum(['page', 'message', 'recent', 'pending', 'memory', 'search', 'text']), limit: z.number().int().positive().optional(), beforeId: z.string().optional(), reference: z.string().optional(), query: z.string().optional(), cursor: z.number().int().nonnegative().optional() }).superRefine((input, ctx) => {
        if (input.mode === 'search' && (!input.query?.trim() || (input.limit !== undefined && input.limit > 50))) ctx.addIssue({ code: 'custom', message: 'Search requires a phrase and at most 50 results per page.' })
        if (input.mode === 'text' && (!input.reference || (input.limit !== undefined && input.limit > 262144))) ctx.addIssue({ code: 'custom', message: 'Text requires a reference and at most 262144 characters per page.' })
      }), input => services.conversation!.read(input, binding))
      register('dss_conversation_send', 'Write a scoped conversation message with explicit human or AI intent, retaining supplied identity and reply references.',
        z.object({ id: z.string(), text: z.string(), intent: z.enum(['human', 'ai']), replyTo: z.string().optional() }),
        (input, exec) => services.conversation!.send(input, binding, command(exec)))
      register('dss_conversation_claim', 'Consume reviewed conversation messages and save Foreground List/Cache at the exact revision returned by pending. Task-result notifications use dss_claim instead.',
        z.object({ expectedRevision: z.string(), messageIds: z.array(z.string()), list: z.string(), cache: z.string() }),
        (input, exec) => services.conversation!.claim(input, binding, command(exec)))
    }
  }
  if (binding.role === 'Organizer') register('dss_member_dispatch', 'Dispatch or return work to the same Task/member Inbox with your recorded decision.',
    z.object({ ...snapshotInput, member: z.string(), plan: z.string(), decision: z.string() }),
    (input, exec) => mutate(input.snapshotId, input, exec, async (snapshot, current) => {
      const selected = await task(current)
      if (selected.owner !== binding.owner || selected.route !== 'O') throw new Error('Organizer dispatch belongs to this principal’s O task.')
      if (selected.status === 'complete') throw new Error('The total task is closed; create a new task with durable result references.')
      return deliverMember(files, snapshot, selected, input.member, input.plan,
        [await record(current, paths.run(selected.taskId) + '/Dispatch.md', input.decision)], command(exec))
    }))
  if (binding.role === 'Planner' && !binding.direct) {
    register('dss_worker_assign', 'Save a child contract and notify its Worker; existing long records are retained.', z.object({ ...snapshotInput, childId: z.string(), contract: z.string(), decision: z.string() }),
      (input, exec) => mutate(input.snapshotId, input, exec, async (snapshot, current) => {
        const selected = await task(current)
        if (selected.status === 'complete') throw new Error('The total task is closed.')
        if (!binding.member) throw new Error('Member ownership is missing from this Planner binding.')
        const worker = workerPaths(selected.taskId, binding.member, input.childId)
        const changes: FileChange[] = [
          { path: worker.contract, content: input.contract },
          await record(current, paths.member(selected.taskId, binding.member) + '/Planner_Memory.md', input.decision),
          { path: paths.state(binding.member, selected.taskId) + '/' + workerWakeSignal(input.childId), content: '' },
        ]
        for (const path of [worker.notes, worker.reply]) if (await files.read(snapshot, path) === undefined) changes.push({ path, content: '' })
        return changes
      }))
  }
  if (binding.role === 'Planner' && binding.taskId && binding.member) {
    register('dss_recovery_consume', 'Confirm normal-chain continuation and consume only your member/Task recovery marker; quality acceptance remains separate.',
      z.object({ ...snapshotInput, continuation: z.string() }), async (input, exec) => {
        const current = mutationView(input.snapshotId), id = taskId(current)
        if (!binding.member) throw new Error('Member ownership is missing from this Planner binding.')
        const member = { taskId: id, member: binding.member }
        const receipt = await mutate(input.snapshotId, input, exec, async (snapshot, checked) => {
          const marker = paths.state(binding.member!, id) + '/recovery'
          if (await files.read(snapshot, marker) === undefined) throw new Error('This member has no pending recovery marker.')
          return [await record(checked, paths.member(id, binding.member!) + '/Planner_Memory.md', input.continuation), { path: marker, content: null }]
        })
        await services.afterRecoveryConsumed(binding, member, receipt)
        return receipt
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
        let skillIssues: string[] = []
        const receipt = await mutate(input.snapshotId, input, exec, async (_snapshot, current) => {
          await requireDrained(current)
          return [{ path: resultPath, content: input.text }, { path: recipientSignal, content: '' }]
        })
        exec.concludeTurn(); return receipt
      })
  }
  if (binding.role === 'Worker' && !binding.direct) register('dss_worker_deliver', 'Atomically append long Reply/report references, notify the Planner, and clear the current-round Worker Note (notes.md) to zero bytes only on committed delivery.',
    z.object({ ...snapshotInput, reply: z.string(), records: outputFiles.default([]), handoff: z.string().optional() }), async (input, exec) => {
      const receipt = await mutate(input.snapshotId, input, exec, async (_snapshot, current) => {
        await requireDrained(current)
        if (!binding.member || !binding.workerId) throw new Error('Worker ownership is missing from the execution binding.')
        if ((await task(current)).status === 'complete') throw new Error('The total task is closed; preserve late work as records rather than reopening its business flow.')
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
        return changes
      })
      exec.concludeTurn(); return receipt
    })
  if ((binding.role === 'Planner' && !binding.direct) || binding.role === 'Organizer') register('dss_complete',
    'Record your actual acceptance and complete the P total, O member portion, or O total after checking your pending notifications at this revision.',
    z.object({ ...snapshotInput, acceptance: z.string(), resultPaths: z.array(z.string()) }), async (input, exec) => {
      const current = mutationView(input.snapshotId), id = taskId(current)
      const consumptionPath = binding.role === 'Planner' && binding.member
        ? 'technical/recovery-consumptions/' + paths.member(id, binding.member).slice('task-runs/'.length) + '/' + createHash('sha256').update(command(exec)).digest('hex') + '.json' : undefined
      const receipt = await mutate(input.snapshotId, input, exec, async (snapshot, current) => {
        await requireDrained(current)
        const selected = await task(current)
        if (selected.status === 'complete') throw new Error('The total task is already closed; use its durable results for a new task.')
        for (const path of input.resultPaths) if (await files.readBytes(snapshot, filePath(path)) === undefined) throw new Error('Result reference is missing: ' + path)
        const acceptancePath = binding.role === 'Organizer' ? paths.run(selected.taskId) + '/Organizer_Note.md'
          : paths.member(selected.taskId, binding.member!) + '/Planner_Memory.md'
        const recoveryChanges: FileChange[] = []
        if (consumptionPath && binding.member) {
          const marker = paths.state(binding.member, selected.taskId) + '/recovery'
          if (await files.read(snapshot, marker) !== undefined) recoveryChanges.push(
            { path: marker, content: null }, { path: consumptionPath, content: encodeJson({ commandId: command(exec) }) })
        }
        const acceptance = await record(current, acceptancePath, input.acceptance + (recoveryChanges.length ? '\nNormal continuation reached this Planner; its member recovery marker was consumed with this accepted handoff.\n' : ''))
        if (binding.role === 'Planner' && selected.route === 'O') {
          if (!binding.member) throw new Error('Member ownership is missing.')
          return completeMember(files, snapshot, selected.taskId, binding.member, [acceptance, ...recoveryChanges,
            await record(current, paths.member(selected.taskId, binding.member) + '/Reply.md', '\n## Delivered result references\n' + encodeJson(input.resultPaths))])
        }
        if (selected.owner !== binding.owner || (binding.role === 'Organizer' ? selected.route !== 'O' : selected.route !== 'P' || binding.member !== selected.owner)) {
          throw new Error('This role is not the total-task acceptance owner.')
        }
        return [acceptance, ...recoveryChanges, { path: paths.task(selected.taskId), content: encodeJson({ ...selected, status: 'complete', resultPaths: input.resultPaths }) }]
      })
      if (consumptionPath && binding.member) {
        const check = await files.snapshot()
        try {
          if (await files.read(check, consumptionPath) !== undefined) await services.afterRecoveryConsumed(binding, { taskId: id, member: binding.member }, receipt)
        } finally { await check.release() }
      }
      exec.concludeTurn(); return receipt
    })
  if (binding.role === 'Recorder') {
    if (services.capacity) register('dss_recorder_capacity', 'Get current session/material estimates and optional window reference; unknown window does not block work.',
      z.object({ ...snapshotInput, paths: z.array(z.string()) }), async input => {
        const current = view(input.snapshotId)
        for (const path of input.paths) await recorderReadable(current, path)
        return services.capacity!(agent, { taskId: taskId(current), paths: input.paths })
      })
    register('dss_recorder_save', 'Save AI-authored archives/validated skills, verify their exact read-back and retained references, then request fixed Cleaner. This tool does not summarize for you.',
      z.object({ ...snapshotInput, outputs: outputFiles.min(1), retainedPaths: z.array(z.string()).default([]) }), async (input, exec) => {
        const original = mutationView(input.snapshotId), id = taskId(original)
        const outputs = input.outputs.map(item => ({ path: filePath(item.path), content: item.text }))
        if (!outputs.some(item => item.path === archiveRecordsPath(id))) throw new Error('Save the AI-authored Task records at ' + archiveRecordsPath(id) + ' before requesting Cleaner.')
        if (outputs.some(item => item.path === paths.archive(id) + '/retention.json')) throw new Error('retention.json is the cleanup reference manifest, not an AI-authored output path.')
        if (outputs.some(item => !item.path.startsWith(paths.archive(id) + '/') && !item.path.startsWith('skills/'))) throw new Error('Recorder outputs belong in this Task archive or long-term skills.')
        let skillIssues: string[] = []
        const receipt = await mutate(input.snapshotId, input, exec, async (_snapshot, current) => {
          const selected = await task(current)
          if (selected.owner !== binding.owner || selected.status !== 'complete') throw new Error('Recorder finalization belongs to the principal’s globally complete task.')
          const index = await prepareFrameworkSkillIndex(files, current.snapshot, outputs)
          skillIssues = index.issues
          const originalRetention: RetentionManifest = { outputs: outputs.map(output => output.path), retainedPaths: input.retainedPaths,
            recorderCommand: command(exec), inputs: await captureCleanupInputs(files, current.snapshot, selected),
            verifiedReferences: await captureCleanupReferences(files, current.snapshot, [...outputs.map(output => output.path), ...input.retainedPaths], outputs) }
          const archival = await prepareRecorderRetention(files, current.snapshot, selected, originalRetention, outputs)
          return [...archival.changes, ...index.changes, { path: paths.archive(id) + '/retention.json', content: encodeJson(archival.retention) },
            { path: paths.state(binding.owner, id) + '/Cleaner', content: null }]
        })
        services.skillsChanged?.()
        const check = await files.snapshot()
        try {
          const cleaner = await services.transact(command(exec) + ':cleaner', { taskId: id, outputs: input.outputs, retainedPaths: input.retainedPaths },
            { expectedRevision: check.revision, snapshot: check }, async snapshot => {
              for (const output of outputs) {
                const saved = await files.readBytes(snapshot, output.path)
                if (saved === undefined || !Buffer.from(saved).equals(Buffer.from(output.content, 'utf8'))) throw new Error('Saved archive read-back differs: ' + output.path)
              }
              const retention = await readJson<RetentionManifest>(files, snapshot, paths.archive(id) + '/retention.json')
              if (retention?.recorderCommand !== command(exec)) throw new Error('Recorder retention belongs to a different save operation; reread the current archive.')
              const references = [...retention.outputs, ...retention.retainedPaths]
              for (const path of references) if (await files.readBytes(snapshot, path) === undefined) throw new Error('Retained reference is not accessible: ' + path)
              const referenceHashes = await captureCleanupReferences(files, snapshot, references)
              for (const path of references) {
                if (!retention.verifiedReferences?.[path] || referenceHashes[path] !== retention.verifiedReferences[path]) throw new Error('Saved retained reference differs from its evaluated bytes: ' + path)
              }
              return [{ path: paths.state(binding.owner, id) + '/Cleaner', content: '' }]

            })
          exec.concludeTurn(); return { archive: receipt, cleaner, ...(skillIssues.length ? { skillIssues } : {}) }
        } finally { await check.release() }
      })
  }
  if (services.artifacts) register('dss_preserve_artifact', 'Preserve an authorized native source artifact byte-for-byte in this Task archive and verify the saved bytes. This does not judge business quality.',
    z.object({ ...snapshotInput, sourcePath: z.string(), destinationPath: z.string() }), async (input, exec) => {
      const current = mutationView(input.snapshotId), id = taskId(current), held = views.get(input.snapshotId)
      filePath(input.destinationPath)
      if (!input.destinationPath.startsWith(paths.archive(id) + '/')) throw new Error('Preserved artifacts belong in this Task archive.')
      try {
        return await services.artifacts!.preserve(agent, { sourcePath: input.sourcePath, destinationPath: input.destinationPath, taskId: id }, binding,
          command(exec), { expectedRevision: current.snapshot.revision, signal: exec.signal, ...(held ? { snapshot: held.snapshot } : {}) })
      } finally { await close(input.snapshotId) }
    })
  if (binding.role !== 'Foreground' && services.observation) register('dss_reset_observation',
    'After actually receiving a native Host probe or warning, reset only this execution’s inactivity cycle using that input’s probeId. This does not consume recovery or send a text reply.',
    z.object({ probeId: z.string() }),
    (input, exec) => services.observation!.reset(binding, input, command(exec), exec.signal))
  if (services.helper) {
    register('dss_help', 'Report an actual fault and ask Helper to inspect preserved facts; this is not an automatic restart.', z.object({ facts: z.string() }),
      (input, exec) => services.helper!.request(binding, input.facts, command(exec)))
    if (binding.role === 'Helper') {
      const identity = z.object({ workId: z.string(), executionId: z.string(), role: z.enum(['Foreground', 'Organizer', 'Planner', 'Worker', 'Recorder', 'Helper']),
        taskId: z.string().optional(), member: z.string().optional(), workerId: z.string().optional() })
      const restoreFacts = { facts: z.string(), hypotheses: z.string(), actionsTaken: z.string(), continuation: z.string() }
      register('dss_restore', 'Request restoration of an exact execution target or a real pending wake after preserving business records. Supply exactly one selector; native admission and stop confirmation remain Host responsibilities.',
        z.object({ ...restoreFacts, target: identity.optional(), wakeId: z.string().min(1).optional() })
          .refine(input => (input.target !== undefined) !== (input.wakeId !== undefined), 'Supply exactly one selector: target or wakeId.'),
        (input, exec) => {
          const { target, wakeId, ...facts } = input
          if (target !== undefined) return services.helper!.restore(binding, { ...facts, target }, command(exec))
          if (wakeId !== undefined) return services.helper!.restore(binding, { ...facts, wakeId }, command(exec))
          throw new Error('Restoration requires an execution target or a pending wake.')
        })
      register('dss_restore_host', 'Request overall restoration after preserving facts: restore Host scheduling/error state, scan Task/member eligibility and notify the relevant managers. This does not stop all Agents.',
        z.object({ facts: z.string(), hypotheses: z.string(), actionsTaken: z.string(), continuation: z.string() }),
        (input, exec) => services.helper!.restoreHost(binding, input, command(exec)))

    }
  }
}
