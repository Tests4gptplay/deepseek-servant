import { paths, readJson, type TaskMetadata } from './task-files.js'
import type { FilesSnapshot, FilesStore } from './transactions.js'

/** Only explicit, reciprocal O→P/O links confer control over another Task. */
export function linkedChild(parent: TaskMetadata, child: TaskMetadata): boolean {
  return parent.taskId !== child.taskId && parent.route === 'O' && (child.route === 'P' || child.route === 'O') && child.parent?.taskId === parent.taskId
    && child.parent.owner === parent.owner && (parent.children ?? []).some(link => link.taskId === child.taskId
      && link.objectiveId === child.parent!.objectiveId && link.member === child.owner)
}
export async function taskFamily(files: FilesStore, snapshot: FilesSnapshot, taskId: string): Promise<TaskMetadata[]> {
  const parent = await readJson<TaskMetadata>(files, snapshot, paths.task(taskId))
  if (!parent) return []
  if (parent.taskId !== taskId) throw new Error('Task metadata identity is inconsistent: ' + taskId)
  const result = [parent]
  const visited = new Set([taskId])
  // Iterative traversal covers every generation without a depth limit or a
  // repository-wide task scan. All edges remain reciprocal and snapshot-scoped.
  for (let index = 0; index < result.length; index++) {
    const current = result[index]!
    for (const id of new Set((current.route === 'O' ? current.children ?? [] : []).map(link => link.taskId))) {
      const child = await readJson<TaskMetadata>(files, snapshot, paths.task(id))
      if (!child || child.taskId !== id || !linkedChild(current, child)) throw new Error('Task child association is missing or inconsistent: ' + id)
      if (visited.has(id)) throw new Error('Task child association is cyclic: ' + id)
      visited.add(id)
      result.push(child)
    }
  }
  return result
}
