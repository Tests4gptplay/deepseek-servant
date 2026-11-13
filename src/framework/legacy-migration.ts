import { PhysicalLocalFiles } from './physical-local-files.js'
import { controlPhysicalLegacyTask } from './physical-legacy-publication.js'
import type { DirectSignalSources } from './physical-direct-delivery.js'
import { createHash } from 'node:crypto'
import type { LEGACY_BASELINE } from './legacy-record-export.js'
import type { FrameworkTransactions } from './command-transactions.js'
import { paths, encodeJson, isTerminalTask, type TaskMetadata } from './task-files.js'
import { legacyRoutingSignal } from './legacy-routing.js'
import { workerPaths } from './role-tools.js'
import { filePath, withSnapshot, type FilesStore, type FileChange } from './transactions.js'

type Continuation = 'running' | 'wait-result' | 'wait-user' | 'paused' | 'cancelled' | 'complete' | 'unresolved'
export interface LegacyNativeExecution {
  executionId: string; sessionId: string; agentId?: string; role: string; generation: number; actionId: string
  ownedJobIds: string[]; originalState?: string; physicalState?: string
  /** Historical physical disposition only; the Host still reconciles actual ownership. */
  recordedSettled: boolean
  original: unknown
}
export interface LegacyTask {
  id: string
  original: unknown
  continuation: Continuation
  request: string
  waits?: Array<{ id: string; memberIdentity: string; question?: string; original: unknown }>
  /** Legacy participant/instance pair, not a guessed current member alias. */
  participants: Array<{ identity: string; nativeExecutions?: LegacyNativeExecution[]; continuation?: Continuation; original: unknown; plan: unknown; children: Array<{ id: string; contract: unknown; reports: unknown[]; executions: unknown[] }> }>
}
export interface LegacyCapture {
  mode: 'local' | 'git'
  revision: string
  baseline: typeof LEGACY_BASELINE
  records: Array<{ key: string; bytes: Uint8Array; reference?: string }>
  texts: Array<{ ref: string; text: string }>
  tasks: LegacyTask[]
  issues: string[]
  /** Exact selected source paths and bytes at capture; unrelated files are not inputs. */
  gitDependencies?: { seeds: string[]; files: Record<string, string | null> }
}
export interface MigrationManifest {
  version: 1
  id: string
  baseline: string
  source: { mode: 'local' | 'git'; revision: string }
  owner: string
  members: Record<string, string>
  records: Array<{ key: string; path: string; sha256: string }>
  references: Record<string, string>
  referenceHashes: Record<string, string>
  tasks: Array<{ oldId: string; taskId: string; continuation: Continuation; members: string[]; recordPath: string; continuationPath: string; routePending?: boolean; memberContinuations?: Array<{ member: string; identity: string; continuation: Continuation; waits?: Array<{ id: string; question: string }> }> }>
  issues: string[]
  /** Preservation is distinct from switching the corresponding current consumers. */
  pendingAdapters: string[]
  messages: Array<{ reference: string; id: string; path: string; collaborationId: string }>
}
const hash = (data: string) => createHash('sha256').update(data).digest('hex')

export interface LegacyControlInput { manifestPath: string; oldTaskId: string; member: string }
export interface LegacyAnswerInput extends LegacyControlInput { waitId: string; answer: string }
/** These are existing explicit user actions, not an automatic migration permit. */
export function resumeLegacyTask(files: FilesStore, transactions: FrameworkTransactions, commandId: string, input: LegacyControlInput, sources?: DirectSignalSources) {
  if (files instanceof PhysicalLocalFiles) return controlPhysicalLegacyTask(files, commandId, input, 'resume', sources)
  return controlLegacyTask(files, transactions, commandId, input, 'resume')
}
export function answerLegacyTask(files: FilesStore, transactions: FrameworkTransactions, commandId: string, input: LegacyAnswerInput, sources?: DirectSignalSources) {
  if (files instanceof PhysicalLocalFiles) return controlPhysicalLegacyTask(files, commandId, input, 'answer', sources)
  return controlLegacyTask(files, transactions, commandId, input, 'answer')
}
async function controlLegacyTask(files: FilesStore, transactions: FrameworkTransactions, commandId: string,
  input: LegacyControlInput | LegacyAnswerInput, action: 'resume' | 'answer'): Promise<{ taskId: string; revision: string }> {
  filePath(input.manifestPath)
  const receipt = await transactions.run('legacy-control:' + commandId, { action, input }, {}, async snapshot => {
    const raw = await files.read(snapshot, input.manifestPath)
    if (!raw) throw new Error('Migration manifest is missing.')
    const manifest = JSON.parse(raw) as MigrationManifest
    const mapped = manifest.tasks.find(task => task.oldId === input.oldTaskId)
    if (!mapped) throw new Error('Legacy task is not in this migration.')
    if (mapped.continuation === 'cancelled' || mapped.continuation === 'complete') throw new Error('Ended legacy work cannot be reopened by migration control.')
    const body = await files.read(snapshot, mapped.continuationPath)
    if (!body) throw new Error('Original continuation data is missing.')
    const original = JSON.parse(body) as LegacyTask
    const participant = original.participants.find(participant => manifest.members[participant.identity] === input.member)
    if (!participant) throw new Error('Legacy control belongs to a mapped participating instance.')
    const current = participant.continuation ?? original.continuation
    const summary = mapped.memberContinuations?.find(item => item.member === input.member && item.identity === participant.identity)
    if (action === 'resume' && current !== 'paused') throw new Error('This legacy task is not awaiting resume.')
    if (action === 'answer') {
      const answer = input as LegacyAnswerInput
      if (current !== 'wait-user' || summary?.waits && !summary.waits.some(wait => wait.id === answer.waitId) || !original.waits?.some(wait => wait.id === answer.waitId && wait.memberIdentity === participant.identity && wait.question)) throw new Error('The original user question is not pending for this instance.')
      if (typeof answer.answer !== 'string' || !answer.answer.trim()) throw new Error('Answer the original pending question.')
    }
    const controlPath = input.manifestPath.replace(/manifest.json$/, 'controls/' + hash(input.oldTaskId + '\0' + input.member + (action === 'answer' ? '\0answer\0' + (input as LegacyAnswerInput).waitId : '\0resume')) + '.json')
    if (await files.read(snapshot, controlPath) !== undefined) throw new Error('This migrated continuation has already been resumed.')
    const existing = await files.read(snapshot, paths.task(mapped.taskId))
    if (existing && isTerminalTask(JSON.parse(existing))) throw new Error('The current task is already complete.')
    const technicalAction = { commandId, action, ...input, taskId: mapped.taskId }
    const updateSummary = (): void => {
      mapped.continuation = 'running'
      if (summary) {
        summary.continuation = 'running'
        if (action === 'answer') summary.waits = summary.waits?.filter(wait => wait.id !== (input as LegacyAnswerInput).waitId)
      }
      if (!summary?.waits?.length) manifest.pendingAdapters = manifest.pendingAdapters.filter(item => item !== 'original-control-and-input:' + original.id && item !== 'original-control-and-input:' + original.id + ':' + participant.identity)
    }
    if (existing) {
      const task = JSON.parse(existing) as TaskMetadata, source = await files.read(snapshot, task.sourcePath)
      if (task.taskId !== mapped.taskId || source === undefined) throw new Error('The current Task source cannot be established.')
      updateSummary()
      const recipient = task.route === 'P' ? 'Planner' : 'Organizer'
      // Same R3 append+notification as dss_supplement_task. Never restore stale
      // Planner/Worker files over work already resumed by an earlier answer.
      return [{ path: task.sourcePath, content: source + '\n\n' + encodeJson({ legacyUserAction: technicalAction, originalTask: mapped.recordPath, referenceIndex: input.manifestPath }) },
        { path: paths.state(task.owner, task.taskId) + '/' + recipient + '_Foreground', content: '' },
        { path: controlPath, content: encodeJson(technicalAction) }, { path: input.manifestPath, content: encodeJson(manifest) }]
    }
    // Resume/answer restores the preserved responsibility, not a Host-chosen
    // business route. Foreground will submit the explicit P/O decision using
    // this same mapped Task identity and all original work.
    mapped.routePending = true
    const changes: FileChange[] = [{ path: legacyRoutingSignal(manifest.id, mapped.taskId), content: '' }]
    const context = encodeJson({ originalTask: mapped.recordPath, referenceIndex: input.manifestPath, original: participant,
      waits: original.waits, userAction: { commandId, action, ...input } })
    const memberRoot = paths.member(mapped.taskId, input.member)
    for (const [path, text] of [[paths.inbox(mapped.taskId, input.member), context],
      [memberRoot + '/Planner_Memory.md', context], [memberRoot + '/Plan.md', encodeJson(participant.plan)]] as const) {
      const prior = await files.read(snapshot, path)
      if (prior === undefined) changes.push({ path, content: text })
    }
    changes.push({ path: controlPath, content: encodeJson(technicalAction) })
    for (const child of participant.children) {
      const worker = workerPaths(mapped.taskId, input.member, child.id)
      for (const [path, content] of [[worker.contract, encodeJson(child.contract)], [worker.reply, encodeJson(child.reports)],
        [worker.handoff, encodeJson({ reports: child.reports, legacyExecutions: child.executions })], [worker.notes, '']] as const) {
        if (await files.read(snapshot, path) === undefined) changes.push({ path, content })
      }
    }
    updateSummary()
    changes.push({ path: input.manifestPath, content: encodeJson(manifest) })
    // Keep one write per logical path for this preserved continuation.
    return [...new Map(changes.map(change => [change.path, change])).values()]
  })
  return withSnapshot(files, async snapshot => {
    const manifest = JSON.parse((await files.read(snapshot, input.manifestPath))!) as MigrationManifest
    const mapped = manifest.tasks.find(task => task.oldId === input.oldTaskId)!
    // The durable Foreground responsibility may still be awaiting its AI route.
    return { taskId: mapped.taskId, revision: receipt.revision }
  })
}
