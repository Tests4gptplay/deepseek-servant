import { createHash } from 'node:crypto'
import { paths, taskLifecycle } from './task-files.js'

/** Supplied by an existing validated Task/execution and its original Host. */
export interface TaskCommandOwner { taskId: string; lifecycleId?: string; hostKey: string }
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export const taskCommandReceiptRoot = (owner: TaskCommandOwner): string => {
  if (!owner.hostKey) throw new Error('Task command requires its original Host identity.')
  return paths.run(owner.taskId) + '/.command-receipts/' + hash(taskLifecycle(owner)) + '/' + hash(owner.hostKey) + '/'
}
export const taskCommandReceiptPath = (owner: TaskCommandOwner, id: string): string => taskCommandReceiptRoot(owner) + hash(id) + '.json'
export function taskCommandReceiptOwner(path: string): { taskId: string; lifecycleHash: string; hostHash: string; commandHash: string } | undefined {
  const match = /^task-runs\/([^/]+)\/\.command-receipts\/([a-f0-9]{64})\/([a-f0-9]{64})\/([a-f0-9]{64})\.json$/.exec(path)
  return match ? { taskId: match[1]!, lifecycleHash: match[2]!, hostHash: match[3]!, commandHash: match[4]! } : undefined
}
/** Existing cleanup inventory can compact ordinary paths immediately. A peer's
 * command deletion proof survives until that exact Host's existing release. */
export function retainPendingTaskCommandProofs(deletedPaths: readonly string[], task: { taskId: string; lifecycleId?: string },
  hosts: Readonly<Record<string, { released?: true }>> | undefined): string[] {
  const released = new Set(Object.entries(hosts ?? {}).filter(([, facts]) => facts && typeof facts === 'object' && !Array.isArray(facts) && facts.released === true).map(([key]) => hash(key)))
  return [...new Set(deletedPaths)].filter(path => {
    const owner = taskCommandReceiptOwner(path)
    return owner?.taskId === task.taskId && owner.lifecycleHash === hash(taskLifecycle(task)) && !released.has(owner.hostHash)
  }).sort()
}
