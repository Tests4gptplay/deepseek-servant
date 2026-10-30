import type { ServantView, TaskView } from '../contracts/views.js'
import type { CoopService } from '../experimental/private-git/service.js'
import { readJson, readText } from '../experimental/private-git/journal.js'
import { joinPath, taskPath, actionPath, type Join, type ParticipantPlan, type RoleAction, type RoleOutcome, type RootPlan, type RootTask } from '../experimental/private-git/protocol.js'
import { loadPaths, repositoryUrl, toRepositoryPath } from '../experimental/private-git/repository-paths.js'
import { recordPublished, readOutcome } from '../experimental/private-git/outcome.js'

export const gitTaskId = (id: string) => 'git:' + id
export const originalTaskId = (id: string) => id.slice(4)

/** A display projection only. Git records and the native Coop consumer retain authority. */
export async function gitTaskViews(service: CoopService, base: ServantView): Promise<TaskView[]> {
  const snapshot = service.displaySnapshot()
  if (!snapshot) return []
  const view = await service.view(), repo = service.repository, result: TaskView[] = []
  const participant = String(view.connection!.identity.id)
  const link = (path: string) => repositoryUrl(view.settings.ownerRepo, snapshot.head,
    toRepositoryPath(view.settings.repositoryDirectory, path))
  for (const summary of view.tasks) {
    try {
    const root = taskPath(summary.id)
    const task = await readJson<RootTask>(repo, snapshot, root + '/contract.json')
    const archived = !task
    const activeJoin = task ? await readJson<Join>(repo, snapshot, joinPath(task.id, participant, view.instanceId)) : undefined
    const plan = task ? await readJson<RootPlan>(repo, snapshot, root + '/plan.json') : undefined
    const goal = task ? await readText(repo, snapshot, task.goalPath) : summary.title
    const projected: TaskView = {
      schemaVersion: 1, id: gitTaskId(summary.id), assistantId: base.assistant.id,
      revision: task?.revision ?? 0, workspace: { id: 'git:' + view.instanceId, directory: view.settings.workspace || base.assistant.workspace.directory },
      control: summary.status === 'cancelled' ? 'cancelled' : activeJoin?.state === 'paused' ? 'paused' : 'running',
      phase: summary.status === 'accepted' ? 'completed' : summary.status === 'cancelled' ? 'cancelled' : summary.status === 'waiting' ? 'waiting' : plan?.works.length ? 'executing' : 'planning',
      goal: { revision: task?.goalRevision ?? 1, request: goal, objective: summary.title, constraints: [], deliverables: [], acceptanceCriteria: [], sourceRef: task?.originPath ?? 'dss-coop/records/' + summary.id },
      plan: { revision: plan?.revision ?? 0, goalRevision: task?.goalRevision ?? 1, strategy: goal, childIds: [] },
      needsPlanning: !plan?.works.length, priority: 0, children: {}, executions: {}, reports: {}, waits: {}, incidents: {}, decisions: [],
      createdAt: task?.createdAt ?? '', updatedAt: task?.updatedAt ?? '', pendingActionCount: 0, uncertainActionCount: 0,
      remote: { recordsUrl: link(archived ? 'dss-coop/records/' + summary.id : root), statusUrl: archived ? undefined : link('dss-coop/status/tasks/' + summary.id),
        archived, executions: [], results: [],
        canControl: !!activeJoin && activeJoin.state !== 'left', canRevise: task?.originatingParticipantId === participant,
        canCancel: task?.originatingParticipantId === participant },
    }
    if (task) {
      await loadPaths(repo, snapshot, root + '/participants/')
      await loadPaths(repo, snapshot, root + '/actions/')
      const actions: RoleAction[] = []
      for (const path of snapshot.files.keys()) {
        if (path.startsWith(root + '/actions/') && path.endsWith('.json')) {
          const action = await readJson<RoleAction>(repo, snapshot, path)
          if (action?.binding?.taskId === task.id && action.id === action.binding.actionId && actionPath(action.binding) === path) actions.push(action)
        }
      }
      projected.remote!.executions = actions.map(action => ({
        executionId: action.binding.executionId, actionId: action.id, role: action.binding.role,
        sessionId: action.binding.sessionId, participantId: action.binding.participantId, instanceId: action.binding.instanceId,
        childId: action.binding.childId, childRevision: action.binding.childRevision, assignmentVersion: action.binding.assignmentVersion,
        generation: action.binding.generation, state: action.state, createdAt: action.createdAt,
        recordsUrl: link(actionPath(action.binding)),
      }))
      for (const path of snapshot.files.keys()) {
        if (!path.startsWith(root + '/participants/') || !path.endsWith('/plan.json')) continue
        const localPlan = await readJson<ParticipantPlan>(repo, snapshot, path)
        if (!localPlan) continue
        if (!await recordPublished(repo, snapshot, localPlan.writer)) {
          if (summary.status !== 'cancelled') projected.remote!.projectionUpdating = true
          continue
        }
        for (const child of localPlan.children) {
          const id = localPlan.writer.participantId + '/' + localPlan.writer.instanceId + '/' + child.id
          const owners = actions.filter(action => action.binding.role === 'worker' && action.binding.childId === child.id &&
            action.binding.participantId === localPlan.writer.participantId && action.binding.instanceId === localPlan.writer.instanceId)
          const currentOwners = owners.filter(action => action.binding.childRevision === child.revision &&
            action.binding.assignmentVersion === child.assignmentVersion)
          const latest = child.state === 'accepted'
            ? currentOwners.find(action => action.binding.outputPath === child.result)
            : currentOwners.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.binding.generation - b.binding.generation).at(-1)
          const outcome = latest ? await readOutcome(repo, snapshot, latest.binding) : undefined
          projected.children[id] = { id, title: child.title, objective: child.direction, inputArtifacts: [], acceptanceCriteria: [child.acceptance],
            dependsOn: child.dependencies, writeScopes: [], resources: [], assignmentVersion: child.assignmentVersion,
            goalRevision: task.goalRevision, progressSegments: owners.length,
            status: child.state === 'accepted' ? 'accepted' : outcome ? 'reported' : latest?.state === 'active' ? 'running' : 'pending',
            currentResultId: outcome ? latest!.binding.executionId : undefined }
          if (outcome) {
            const executionId = latest!.binding.executionId
            const summary = await readText(repo, snapshot, outcome.textPath)
            if (child.state === 'accepted') projected.remote!.results!.push({ executionId, childId: id,
              path: outcome.textPath, recordsUrl: link(outcome.textPath) })
            projected.reports[executionId] = { resultId: executionId, executionId, childId: id, assignmentVersion: child.assignmentVersion,
              goalRevision: task.goalRevision, outcome: outcome.resultStatus === 'failed' ? 'failed' : outcome.kind === 'continue' ? 'continue' : 'complete',
              summary, artifacts: [], evidence: [], frontier: '',
              receivedAt: outcome.createdAt, disposition: child.state === 'accepted' ? 'accepted' : 'unreviewed', commandId: outcome.operationId ?? executionId }
          }
        }
      }
      projected.plan.childIds = Object.keys(projected.children)
      const question = actions.filter(a => a.binding.role === 'planner').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
      const outcome: RoleOutcome | undefined = question ? await readOutcome(repo, snapshot, question.binding) : undefined
      if (outcome?.question) projected.waits[question!.id] = { id: question!.id, kind: 'user', reason: outcome.question,
        question: outcome.question, condition: 'Foreground response', resume: 'planner', state: 'waiting', createdAt: outcome.createdAt }
    }
    result.push(projected)
    } catch (error) {
      await service.cache.put('read-error/' + taskPath(summary.id) + '/contract.json', String(error))
    }
  }
  return result
}
