import type { GitRepository, GitSnapshot, RoleBinding } from './contracts.js'
import { readJson } from './journal.js'
import { readOutcome } from './outcome.js'
import { loadPaths } from './repository-paths.js'
import { executionPath, joinPath, planPath, sameBinding, taskPath, type Join, type ParticipantPlan, type RoleAction, type RootPlan } from './protocol.js'

/** Exact published results still awaiting review for this instance's current child revisions.
 * References only: the Planner remains responsible for reading and assessing the evidence.
 */
export async function pendingWorkerResults(repo: GitRepository, snapshot: GitSnapshot, binding: RoleBinding) {
  if (binding.role !== 'planner' || !binding.taskId) return []
  const joined = await readJson<Join>(repo, snapshot, joinPath(binding.taskId, binding.participantId, binding.instanceId))
  if (!joined || joined.state !== 'active' || joined.epoch !== binding.epoch) return []
  const plan = await readJson<ParticipantPlan>(repo, snapshot, planPath(binding.taskId, binding.participantId, binding.instanceId))
  if (!plan) return []
  const root = await readJson<RootPlan>(repo, snapshot, taskPath(binding.taskId) + '/plan.json')
  const prefix = taskPath(binding.taskId) + '/actions/' + binding.participantId + '/' + binding.instanceId + '/'
  await loadPaths(repo, snapshot, prefix)
  const results = []
  for (const path of [...snapshot.files.keys()].filter(path => path.startsWith(prefix) && path.endsWith('.json')).sort()) {
    const action = await readJson<RoleAction>(repo, snapshot, path), b = action?.binding
    if (!b || b.role !== 'worker' || b.taskId !== binding.taskId || b.participantId !== binding.participantId
      || b.instanceId !== binding.instanceId || b.epoch > binding.epoch) continue
    const child = plan.children.find(child => child.id === b.childId)
    if (!child || child.state !== 'pending' || child.revision !== b.childRevision || child.assignmentVersion !== b.assignmentVersion) continue
    const work = root?.works.find(work => work.id === child.workId)
    if (!work || work.version !== b.assignmentVersion || work.participantId !== binding.participantId || work.instanceId !== binding.instanceId) continue
    const outcome = await readOutcome(repo, snapshot, b)
    if (outcome?.kind !== 'result' || !sameBinding(outcome.binding, b)) continue
    results.push({ childId: child.id, childRevision: child.revision, assignmentVersion: child.assignmentVersion,
      resultExecutionId: b.executionId, outcomePath: b.outputPath, textPath: outcome.textPath,
      turn_signal: outcome.turn_signal, resultStatus: outcome.resultStatus,
      ...(b.epoch < binding.epoch ? { priorEpoch: true } : {}) })
  }
  return results
}

/** Interrupted attempts are evidence to inspect, never inferred completion or permission to repeat a side effect. */
export async function priorWorkerExecutions(repo: GitRepository, snapshot: GitSnapshot, binding: RoleBinding) {
  if (binding.role !== 'worker' || !binding.taskId) return []
  const prefix = taskPath(binding.taskId) + '/actions/' + binding.participantId + '/' + binding.instanceId + '/'
  await loadPaths(repo, snapshot, prefix)
  const previous = []
  for (const path of [...snapshot.files.keys()].filter(path => path.startsWith(prefix) && path.endsWith('.json')).sort()) {
    const action = await readJson<RoleAction>(repo, snapshot, path), b = action?.binding
    if (!b || b.role !== 'worker' || b.executionId === binding.executionId || b.taskId !== binding.taskId
      || b.participantId !== binding.participantId || b.instanceId !== binding.instanceId || b.epoch > binding.epoch
      || b.childId !== binding.childId || b.childRevision !== binding.childRevision || b.assignmentVersion !== binding.assignmentVersion) continue
    const outcome = await readOutcome(repo, snapshot, b)
    previous.push({ binding: b, state: action!.state, recordsPrefix: executionPath(b) + '/',
      outcomePublished: !!outcome, ...(outcome ? { outcomePath: b.outputPath, textPath: outcome.textPath } : {}) })
  }
  return previous
}
