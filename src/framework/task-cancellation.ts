import type { DirectSignalSources } from './physical-direct-delivery.js'
// Reconstructed from the 55fe runtime. Types/imports are reconstructed, not recovered original source.
import { createHash } from 'node:crypto'
import { PhysicalLocalFiles } from './physical-local-files.js'
import { cancelPhysicalTask } from './physical-task-terminal.js'
import type { CommandOptions } from './command-transactions.js'
import { paths, readJson, encodeJson, taskCompletionSignals, taskLifecycle, type TaskMetadata } from './task-files.js'
import { linkedChild, taskFamily } from './task-relations.js'
import { withSnapshot, type FilesStore, type FilesSnapshot, type FileChange, type FileReceipt } from './transactions.js'

export interface TaskCancellationInput { taskId: string; lifecycleId?: string }
export interface TaskCancellationResult { taskId: string; status: 'cancelled'; cancelledTaskIds: string[] }
export interface TaskCancellationAccess {
  files: FilesStore
  member: string
  physicalSignalSources?: DirectSignalSources
  /** Existing exact Host identity; the transaction revalidates the initiating root lifecycle. */
  commandHostKey?: string
  transact(id: string, request: unknown, options: CommandOptions,
    build: (snapshot: FilesSnapshot) => Promise<readonly FileChange[]>): Promise<FileReceipt>
  afterCancel?(taskIds: string[], lifecycles: Record<string, string>): Promise<void>
}


interface ConfirmedCancellation { result: TaskCancellationResult; lifecycles: Record<string, string> }
function cancellationResult(taskId: string, cancelled: readonly Pick<TaskMetadata, 'taskId' | 'lifecycleId'>[]): ConfirmedCancellation {
  return {
    result: { taskId, status: 'cancelled', cancelledTaskIds: cancelled.map(task => task.taskId) },
    lifecycles: Object.fromEntries(cancelled.map(task => [task.taskId, taskLifecycle(task)]))
  }
}

/** Persist only the existing terminal cancellation transaction and receipt. */
export async function submitTaskCancellation(access: TaskCancellationAccess, input: TaskCancellationInput, commandId: string): Promise<ConfirmedCancellation | undefined> {
  if (access.files instanceof PhysicalLocalFiles) return cancellationResult(input.taskId,
    await cancelPhysicalTask(access.files, input, access.member, 'task-cancel:' + commandId, access.physicalSignalSources))
  const request = { taskId: input.taskId, member: access.member, ...(input.lifecycleId ? { lifecycleId: input.lifecycleId } : {}) }
  let built: ConfirmedCancellation | undefined
  const receipt = await access.transact('task-cancel:' + commandId, request, { reevaluate: true, ...(access.commandHostKey ? { taskOwner: { ...input, hostKey: access.commandHostKey } } : {}) }, async snapshot => {
    built = undefined
    const family = await taskFamily(access.files, snapshot, input.taskId), root = family[0]
    if (!root) throw new Error('The selected Task does not exist.')
    if (taskLifecycle(root) !== (input.lifecycleId ?? '')) throw new Error('The selected Task has entered another lifecycle; select its current state before cancelling.')
    if (!(root.members ?? [root.owner]).includes(access.member)) throw new Error('This Host has no registered execution domain in the selected Task.')
    if (root.status === 'complete') throw new Error('A completed Task cannot be cancelled or reopened.')
    if (root.status === 'cancelled') return []
    if (root.status !== 'running') throw new Error('The selected Task status is not recognized.')
    const changes: FileChange[] = []
    for (const task of family) {
      if (!['running', 'complete', 'cancelled'].includes(task.status)) throw new Error('A related Task status is not recognized.')
      if (task.status !== 'running') continue
      changes.push({ path: paths.task(task.taskId), content: encodeJson({ ...task, status: 'cancelled' }) }, ...taskCompletionSignals(task))
    }
    if (root.parent) {
      const parent = await readJson<TaskMetadata>(access.files, snapshot, paths.task(root.parent.taskId))
      if (parent && parent.status === 'running' && linkedChild(parent, root)) changes.push({
        path: paths.state(parent.owner, parent.taskId) + '/Organizer_ChildCancelled_' + createHash('sha256').update(commandId).digest('hex'),
        content: ''
      })
    }
    built = cancellationResult(input.taskId, family.filter(task => task.status === 'running' || task.status === 'cancelled'))
    return changes
  })
  // A receipt found after conflict/UNKNOWN may belong to another builder.
  // Only this callback's final non-replayed commit confirms its own result.
  return receipt.replay ? undefined : built
}

export async function cancelTask(access: TaskCancellationAccess, input: TaskCancellationInput, commandId: string): Promise<TaskCancellationResult> {
  const confirmed = await submitTaskCancellation(access, input, commandId)
  const { result, lifecycles } = confirmed ?? await withSnapshot(access.files, async snapshot => {
    const family = await taskFamily(access.files, snapshot, input.taskId)
    if (!family[0] || taskLifecycle(family[0]) !== (input.lifecycleId ?? '')) throw new Error('Cancellation belongs to an earlier Task lifecycle; the current lifecycle was not changed.')
    return cancellationResult(input.taskId, family.filter(task => task.status === 'cancelled'))
  })
  await access.afterCancel?.(result.cancelledTaskIds, lifecycles)
  return result
}
