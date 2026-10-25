import type {
  ActionKind, ActionPayload, ArtifactRef, Child, ChildSpec, CommandReceipt, CommandSource,
  ExecutionBinding, ExecutionReportInput, GoalInput, KernelEnvironment, PendingAction,
  DecisionRecord, PlannerMemoryInput, Task, TaskCommand, Transition, WaitSpec,
} from '../contracts/task.js'
import { applyRetentionCommand } from './retention.js'

class DomainError extends Error {
  constructor(readonly code: string, message: string, readonly status: 'stale' | 'rejected' = 'rejected') { super(message) }
}
function check(condition: unknown, code: string, message: string, status: 'stale' | 'rejected' = 'rejected'): asserts condition {
  if (!condition) throw new DomainError(code, message, status)
}
const own = <T>(record: Record<string, T>, key: string): T | undefined => Object.hasOwn(record, key) ? record[key] : undefined
const values = <T>(record: Record<string, T>): T[] => Object.values(record)
const semanticKinds = new Set<ActionKind>(['plan', 'evaluate'])
const runtimeKinds = new Set<ActionKind>(['dispatch', 'continue', 'stop', 'deliver', 'learn', 'feedback', 'recover'])

/** Pure transition: no host calls, file checks, timers, or semantic quality scores. */
export function applyTaskCommand(current: Task | undefined, command: TaskCommand, env: KernelEnvironment): Transition {
  const taskId = current?.id ?? (command.type === 'task.submit' ? command.taskId : '')
  const receipt = (status: CommandReceipt['status'], reason?: string, code?: string): CommandReceipt => ({
    commandId: command.commandId, taskId, status, revision: current?.revision ?? 0, actionIds: [], ...(reason ? { reason } : {}), ...(code ? { code } : {}),
  })
  if (current?.archive && command.type !== 'task.archive' && command.type !== 'task.purgeArchive') return { task: current, changed: false, receipt: receipt('rejected', 'This Task was archived; retired roles and old commands cannot reopen it.', 'TASK_ARCHIVED') }
  const prior = current && own(current.receipts, command.commandId)
  if (prior) {
    if (prior.fingerprint !== env.fingerprint) return { task: current, changed: false, receipt: receipt('rejected', 'This commandId was already used with different content.', 'COMMAND_ID_REUSED') }
    return { task: current, changed: false, receipt: { ...prior.receipt, status: 'duplicate', originalStatus: prior.receipt.status as 'applied' } }
  }
  try {
    validId(command.commandId, 'commandId')
    validSource(command.source)
    check(current || command.type === 'task.submit', 'TASK_NOT_FOUND', 'Task does not exist.')
    let task: Task
    if (!current && command.type === 'task.submit') {
      requireIntent(command.source)
      validId(command.taskId, 'taskId'); validId(command.assistantId, 'assistantId'); validGoal(command.goal)
      text(command.workspace?.id, 'workspace.id'); text(command.workspace?.directory, 'workspace.directory')
      check(command.priority === undefined || Number.isFinite(command.priority), 'INVALID_PRIORITY', 'Priority must be finite.')
      task = {
        schemaVersion: 1, id: command.taskId, assistantId: command.assistantId, revision: 0,
        workspace: structuredClone(command.workspace), source: structuredClone(command.source),
        ...(command.runtimeProfile ? { runtimeProfile: structuredClone(command.runtimeProfile) } : {}),
        ...(command.foregroundEvaluator ? { foregroundEvaluator: command.foregroundEvaluator } : {}),
        control: 'running', phase: 'planning', goal: { ...structuredClone(command.goal), revision: 1 },
        plan: { revision: 0, goalRevision: 1, strategy: '', childIds: [] }, needsPlanning: true,
        priority: command.priority ?? 0, children: {}, executions: {}, reports: {}, waits: {}, incidents: {}, pendingActions: {}, receipts: {}, decisions: [],
        createdAt: env.now, updatedAt: env.now,
      }
    } else {
      check(command.type !== 'task.submit', 'TASK_EXISTS', 'A task with this identity already exists.')
      task = structuredClone(current!)
    }
    let actionNumber = 0
    const actionIds: string[] = []
    const addAction = (kind: ActionKind, payload: Omit<ActionPayload, 'goalRevision'> & { goalRevision?: number }): PendingAction => {
      const id = `${command.commandId}:a${++actionNumber}`
      check(!own(task.pendingActions, id), 'ACTION_ID_REUSED', 'Action identity collision.')
      const action: PendingAction = { id, kind, status: 'pending', payload: { goalRevision: task.goal.revision, ...payload }, createdAt: env.now, commandId: command.commandId }
      task.pendingActions[id] = action; actionIds.push(id); return action
    }
    const actionExists = (kind: ActionKind, matches: (action: PendingAction) => boolean): boolean => values(task.pendingActions).some(a => a.kind === kind && ['pending', 'running', 'uncertain'].includes(a.status) && matches(a))
    const evaluate = (resultIds: string[], reason: string): void => {
      const unqueued = resultIds.filter(id => !actionExists('evaluate', a => (a.payload.resultIds ?? []).includes(id) && a.payload.goalRevision === task.goal.revision))
      if (unqueued.length) addAction('evaluate', { resultIds: unqueued, planRevision: task.plan.revision, reason })
    }
    const plan = (reason: string): void => {
      if (!actionExists('plan', a => a.payload.goalRevision === task.goal.revision)) addAction('plan', { planRevision: task.plan.revision, reason })
    }
    const stop = (execution: ExecutionBinding, reason: string): void => {
      execution.stopRequested = true
      if (!['stopped', 'lost'].includes(execution.physicalState) && !actionExists('stop', a => a.payload.executionId === execution.executionId)) addAction('stop', { executionId: execution.executionId, childId: execution.childId, reason })
    }
    const continueExecution = (execution: ExecutionBinding, reason: string): void => {
      if (execution.role === 'worker' && task.control === 'running' && !task.needsPlanning && execution.state === 'active' && !execution.stopRequested && !hasWait(task, execution.childId)
        && (!execution.childId || task.children[execution.childId].status === 'running')
        && !values(task.incidents).some(i => i.executionId === execution.executionId && i.state !== 'resolved')
        && !actionExists('continue', a => a.payload.executionId === execution.executionId)) {
        addAction('continue', { executionId: execution.executionId, childId: execution.childId, assignmentVersion: execution.assignmentVersion, reason })
      }
    }
    const dispatchReady = (): void => {
      if (task.control !== 'running' || task.needsPlanning || task.delivery) return
      for (const childId of task.plan.childIds) {
        const child = task.children[childId]
        if (['pending', 'rework'].includes(child.status) && dependenciesAccepted(task, child) && !hasWait(task, child.id)
          && !child.handoff?.reviewRequired
          && !values(task.incidents).some(incident => incident.childId === child.id && incident.state !== 'resolved')
          && !actionExists('dispatch', a => a.payload.childId === child.id && a.payload.assignmentVersion === child.assignmentVersion)) {
          addAction('dispatch', { childId: child.id, assignmentVersion: child.assignmentVersion, planRevision: task.plan.revision,
            ...(child.handoff ? { predecessorExecutionId: child.handoff.predecessorExecutionId,
              ...(child.handoff.recoveryIncidentId ? { recoveryIncidentId: child.handoff.recoveryIncidentId } : {}) } : {}) })
        }
      }
    }
    const stageHandoff = (child: Child): void => {
      if (!child.handoff) return
      child.status = task.control === 'cancelled' ? 'cancelled' : child.handoff.reviewRequired || hasWait(task, child.id) ? 'waiting' : 'pending'
      if (child.handoff.reviewRequired && !task.needsPlanning && task.control !== 'cancelled') {
        evaluate([child.handoff.resultId], 'Periodic review of bounded work before the next Worker generation.')
      }
    }
    const addWait = (spec: WaitSpec, execution?: ExecutionBinding, actionId?: string): void => {
      validWait(spec)
      const previous = own(task.waits, spec.id)
      check(!previous || previous.state === 'resolved', 'WAIT_EXISTS', 'An unresolved wait already has this identity.')
      task.waits[spec.id] = { ...structuredClone(spec), state: 'waiting', createdAt: env.now,
        ...(execution ? { executionId: execution.executionId, childId: execution.childId } : {}), ...(actionId ? { actionId } : {}) }
    }
    const incident = (executionId: string, operation: string, message: string): void => {
      const execution = mustExecution(task, executionId)
      check(execution.role !== 'helper', 'HELPER_RECOVERY_SCOPE', 'A failed Helper must block its original incident; it cannot create a nested recovery goal.')
      text(operation, 'operation'); text(message, 'message')
      let existing = values(task.incidents).find(i => i.executionId === executionId && ['open', 'repairing', 'waiting'].includes(i.state))
      if (!existing) {
        const id = `${command.commandId}:incident`
        const frontier = JSON.stringify([task.goal.revision, execution.configurationVersion, execution.model,
          execution.childId ? task.children[execution.childId].currentResultId : task.plannerNote?.revision,
          execution.childId ? task.children[execution.childId].assignmentVersion
            : task.decisions.filter(entry => ['plan', 'evaluation', 'checkpoint'].includes(entry.kind ?? '')).at(-1)?.commandId])
        existing = { id, executionId, childId: execution.childId, state: 'open', errors: [], frontier }
        task.incidents[id] = existing
        const repeated = values(task.incidents).some(entry => entry.id !== id && entry.state === 'resolved'
          && task.executions[entry.executionId]?.role === execution.role && entry.childId === execution.childId
          && task.executions[entry.executionId]?.assignmentVersion === execution.assignmentVersion
          && (entry.frontier === undefined || entry.frontier === frontier)
          && entry.errors.some(error => error.operation === operation && error.message === message))
        if (repeated) {
          existing.state = 'waiting'
          const waitId = id + ':configuration'
          addWait({ id: waitId, kind: 'configuration', reason: message,
            condition: 'Correct the reported fault or confirm a changed environment before another attempt.',
            resume: 'Continue the same role from the preserved checkpoint after this condition is explicitly resolved.' }, execution)
          task.waits[waitId].incidentId = id
        } else addAction('recover', { incidentId: id, executionId, childId: execution.childId, reason: message })
      }
      if (!existing.errors.some(error => error.operation === operation && error.message === message)) existing.errors.push({ operation, message, at: env.now })
      if (execution.childId && task.children[execution.childId].activeExecutionId === executionId) task.children[execution.childId].status = 'waiting'
      for (const action of values(task.pendingActions)) if (action.kind === 'continue' && action.payload.executionId === executionId && action.status === 'pending') action.status = 'superseded'
    }
    const finishEvaluation = (binding: ExecutionBinding | undefined, action: PendingAction): void => {
      action.status = 'done'; action.finishedAt = env.now
      if (binding) { binding.state = 'closed'; binding.closedAt = env.now }
    }
    const remember = (entry: Pick<DecisionRecord, 'summary'> & Partial<DecisionRecord>, memory?: PlannerMemoryInput): void => {
      const details = persistPlannerMemory(task, memory, command.commandId, env.now)
      task.decisions.push({ commandId: command.commandId, source: structuredClone(command.source), at: env.now, goalRevision: task.goal.revision,
        sequence: task.revision + 1, planRevision: task.plan.revision, ...entry, ...details })
    }
    const duplicate = (reason: string): Transition => ({ task: current, changed: false, receipt: { ...receipt('duplicate', reason), originalStatus: 'applied' } })

    switch (command.type) {
      case 'task.submit': plan('New goal requires a plan.'); break

      case 'planning.commit': {
        const { binding, action } = requireEvaluator(task, command.source, command.actionId)
        check(command.expectedGoalRevision === task.goal.revision, 'GOAL_CHANGED', 'Read the current goal before planning.', 'stale')
        check(command.expectedPlanRevision === task.plan.revision, 'PLAN_CHANGED', 'Read the current plan before replacing it.', 'stale')
        text(command.strategy, 'strategy')
        check(Array.isArray(command.children), 'INVALID_PLAN', 'children must be an array of new assignments.')
        const additions = command.children, updates = command.updates ?? [], cancelled = new Set(command.cancelChildIds ?? [])
        check(Array.isArray(updates), 'INVALID_PLAN', 'updates must be an array.')
        strings(command.cancelChildIds ?? [], 'cancelChildIds')
        const changed = [...additions, ...updates]
        changed.forEach(validChildSpec)
        check(new Set(changed.map(child => child.id)).size === changed.length, 'DUPLICATE_CHILD', 'A Child may appear only once in this change.')
        for (const spec of additions) check(!task.children[spec.id] || task.plan.childIds.includes(spec.id) && sameSpec(task.children[spec.id], spec),
          'EXPLICIT_UPDATE_REQUIRED', 'Use updates to change or restore an existing Child.')
        for (const spec of updates) check(!!task.children[spec.id], 'CHILD_NOT_FOUND', 'An update needs an existing Child.')
        for (const id of cancelled) check(task.plan.childIds.includes(id) && !changed.some(spec => spec.id === id), 'INVALID_CANCEL', 'Cancel an existing Child separately from an update.')
        const merged = new Map(task.plan.childIds.filter(id => !cancelled.has(id)).map(id => [id, childSpec(task.children[id])]))
        for (const spec of changed) merged.set(spec.id, spec)
        const specs = [...merged.values()], ids = [...merged.keys()]
        check(ids.length > 0, 'EMPTY_PLAN', 'A plan needs at least one bounded Child.')
        check(specs.every(spec => spec.dependsOn.every(id => merged.has(id))), 'MISSING_DEPENDENCY', 'Dependencies must exist in the combined plan; update dependents when cancelling a Child.')
        check(!hasCycle(specs), 'DEPENDENCY_CYCLE', 'The combined plan cannot contain dependency cycles.')
        const retain = new Set(command.retainAcceptedChildIds ?? [])
        for (const id of retain) check(ids.includes(id) && task.children[id]?.status === 'accepted', 'INVALID_RETAIN', 'Only a previously accepted Child in this plan can be retained.')
        for (const oldId of cancelled) {
          const old = task.children[oldId]; old.status = 'cancelled'
          supersedeChildActions(task, old.id)
          if (old.activeExecutionId) { const execution = mustExecution(task, old.activeExecutionId); execution.state = 'superseded'; stop(execution, 'Planner explicitly cancelled this Child.'); delete old.activeExecutionId }
          delete old.handoff
        }
        const reviewResults: string[] = []
        for (const spec of specs) {
          const old = own(task.children, spec.id)
          if (!old) {
            task.children[spec.id] = { ...structuredClone(spec), assignmentVersion: 1, goalRevision: task.goal.revision, status: 'pending', progressSegments: 0 }
          } else if (!sameSpec(old, spec)) {
            check(!retain.has(spec.id), 'CHANGED_RETAIN', 'Changed instructions cannot inherit an old accepted result.')
            supersedeChildActions(task, old.id)
            if (old.activeExecutionId) { const execution = mustExecution(task, old.activeExecutionId); execution.state = 'superseded'; stop(execution, 'The work assignment changed.') }
            if (old.currentResultId) task.reports[old.currentResultId].disposition = 'superseded'
            task.children[spec.id] = { ...structuredClone(spec), assignmentVersion: old.assignmentVersion + 1, goalRevision: task.goal.revision, status: 'pending', progressSegments: 0 }
          } else {
            const goalChanged = old.goalRevision !== task.goal.revision
            old.goalRevision = task.goal.revision
            if (old.status === 'cancelled') old.status = 'pending'
            if (old.status === 'waiting' && !old.activeExecutionId && !old.handoff?.reviewRequired && !hasWait(task, old.id)
              && !values(task.incidents).some(i => i.childId === old.id && i.state !== 'resolved')) old.status = 'pending'
            if (goalChanged && old.acceptedResultId) {
              if (retain.has(old.id)) old.acceptedAtGoalRevision = task.goal.revision
              else {
                old.status = 'reported'; old.currentResultId = old.acceptedResultId
                task.reports[old.acceptedResultId].disposition = 'unreviewed'
                reviewResults.push(old.acceptedResultId)
                delete old.acceptedResultId; delete old.acceptedAtGoalRevision
              }
            } else if (old.currentResultId && task.reports[old.currentResultId]?.disposition === 'unreviewed'
              && (['complete', 'failed'].includes(task.reports[old.currentResultId].outcome) || old.handoff?.reviewRequired)) reviewResults.push(old.currentResultId)
          }
        }
        task.plan = { revision: task.plan.revision + 1, goalRevision: task.goal.revision, strategy: command.strategy, childIds: ids }
        task.needsPlanning = false
        remember({ kind: 'plan', summary: command.strategy }, command.memory)
        finishEvaluation(binding, action); evaluate(reviewResults, 'Review retained results against the current goal.'); dispatchReady()
        for (const childId of task.plan.childIds) {
          const executionId = task.children[childId].activeExecutionId
          const retained = executionId ? task.executions[executionId] : undefined
          if (retained?.role === 'worker' && retained.physicalState === 'idle') continueExecution(retained, 'Continue the retained assignment from its saved frontier under the newly committed plan.')
        }
        break
      }

      case 'planning.decide': {
        const { binding, action } = requireEvaluator(task, command.source, command.actionId)
        check(command.expectedGoalRevision === task.goal.revision, 'GOAL_CHANGED', 'Read the current goal before accepting results.', 'stale')
        check(!task.needsPlanning && task.plan.goalRevision === task.goal.revision, 'REPLAN_REQUIRED', 'Current-goal planning must precede acceptance.', 'stale')
        check(Array.isArray(command.decisions), 'INVALID_DECISIONS', 'Decisions must be an array.')
        text(command.summary, 'summary')
        const seen = new Set<string>()
        for (const decision of command.decisions) {
          check(!seen.has(decision.childId), 'DUPLICATE_DECISION', 'A child can have only one decision in a command.'); seen.add(decision.childId)
          const child = mustChild(task, decision.childId)
          check(task.plan.childIds.includes(child.id), 'CHILD_RETIRED', 'This child is no longer in the plan.', 'stale')
          const report = own(task.reports, decision.resultId)
          check(report && report.childId === child.id && report.assignmentVersion === child.assignmentVersion, 'REPORT_CHANGED', 'The result does not match the current assignment.', 'stale')
          check(report.disposition !== 'superseded', 'REPORT_SUPERSEDED', 'This result was superseded.', 'stale')
          text(decision.reason, 'decision.reason')
          if (decision.outcome === 'accept') {
            check(report.outcome === 'complete', 'NOT_COMPLETE', 'Only a completed worker result can be accepted.')
            check(report.artifacts.length > 0 || report.evidence.length > 0, 'MISSING_EVIDENCE', 'Acceptance needs the reported output or evidence.')
            report.disposition = 'accepted'; child.status = 'accepted'; child.acceptedResultId = report.resultId; child.acceptedAtGoalRevision = task.goal.revision
          } else if (decision.outcome === 'rework') {
            report.disposition = 'rework'
            if (child.activeExecutionId) { const execution = mustExecution(task, child.activeExecutionId); execution.state = 'superseded'; stop(execution, decision.reason) }
            supersedeChildActions(task, child.id)
            const spec = decision.revisedChild ?? childSpec(child)
            validChildSpec(spec); check(spec.id === child.id, 'CHILD_ID_CHANGED', 'Rework preserves the logical child identity.')
            check(spec.dependsOn.every(id => task.plan.childIds.includes(id)), 'MISSING_DEPENDENCY', 'Unknown rework dependency.')
            task.children[child.id] = { ...structuredClone(spec), assignmentVersion: child.assignmentVersion + 1, goalRevision: task.goal.revision, status: 'rework', progressSegments: 0 }
          } else if (decision.outcome === 'continue') {
            if (report.outcome === 'handoff' || child.handoff?.resultId === report.resultId) {
              check(child.handoff?.resultId === report.resultId && child.handoff.predecessorExecutionId === report.executionId
                && !child.activeExecutionId, 'HANDOFF_CHANGED', 'Review the current handoff before dispatching its next generation.', 'stale')
              const previous = mustExecution(task, report.executionId)
              check(previous.state !== 'active', 'HANDOFF_NOT_CLOSED', 'The previous Worker must yield its semantic capability.')
              report.disposition = 'accepted'; child.handoff.reviewRequired = false
              stageHandoff(child)
            } else {
              check(report.outcome === 'progress' || report.outcome === 'continue' || report.outcome === 'wait', 'EXECUTION_ENDED', 'A closed execution must use rework/new assignment, not continue.')
              check(!!child.activeExecutionId, 'EXECUTION_ENDED', 'There is no current worker to continue.')
              const execution = mustExecution(task, child.activeExecutionId!)
              check(execution.state === 'active', 'EXECUTION_ENDED', 'The current worker is closed.')
              report.disposition = 'accepted' // This bounded progress was reviewed; the Child itself remains running.
              child.status = hasWait(task, child.id) ? 'waiting' : 'running'
              continueExecution(execution, decision.reason)
            }
          } else throw new DomainError('INVALID_DECISION', 'Unknown planning decision.')
        }
        check(!hasCycle(task.plan.childIds.map(id => task.children[id])), 'DEPENDENCY_CYCLE', 'Rework created a dependency cycle.')
        remember({ kind: 'evaluation', summary: command.summary, childDecisions: command.decisions.map(decision => ({ ...structuredClone(decision), assignmentVersion: task.reports[decision.resultId].assignmentVersion, resultingAssignmentVersion: task.children[decision.childId].assignmentVersion })) }, command.memory)
        if (command.decisions.length) addAction('feedback', { resultIds: [...new Set(command.decisions.map(decision => decision.resultId))], reason: command.summary })
        // One evaluator can accept several concurrently finished children. Retire
        // only queued evaluations whose exact referenced results are now decided;
        // do not mark unrelated actions complete or infer semantic success.
        for (const queued of values(task.pendingActions)) if (queued.id !== action.id && queued.kind === 'evaluate' && queued.status === 'pending'
          && (queued.payload.resultIds?.length ?? 0) > 0 && queued.payload.resultIds!.every(id => task.reports[id]?.disposition !== 'unreviewed'
            || (task.children[task.reports[id]?.childId]?.status === 'accepted' && task.children[task.reports[id]?.childId]?.acceptedAtGoalRevision === task.goal.revision))) {
          queued.status = 'superseded'; queued.evidence = `Referenced results were decided by ${command.commandId}.`
        }
        if (command.deliver) {
          check(task.control !== 'cancelled', 'TASK_CANCELLED', 'A cancelled goal cannot be newly accepted for delivery.')
          check(task.plan.childIds.length > 0 && task.plan.childIds.every(id => task.children[id].status === 'accepted' && task.children[id].acceptedAtGoalRevision === task.goal.revision), 'INCOMPLETE_PLAN', 'All current children require acceptance for this goal.')
          check(!task.plannerNote?.backlog?.some(item => item.required && item.status === 'pending'), 'REQUIRED_BACKLOG', 'Required future work remains in the planning note.')
          check(!hasWait(task), 'UNRESOLVED_WAIT', 'Resolve task waits before final delivery.')
          validId(command.deliver.id, 'delivery.id'); text(command.deliver.summary, 'delivery.summary'); validArtifacts(command.deliver.artifacts)
          check(!task.delivery, 'ALREADY_DELIVERING', 'A delivery already exists.')
          task.delivery = { ...structuredClone(command.deliver), resultIds: task.plan.childIds.map(id => task.children[id].acceptedResultId!), createdAt: env.now, status: 'pending' }
          addAction('deliver', { deliveryId: task.delivery.id, resultIds: task.delivery.resultIds })
        }
        if (command.learn) {
          text(command.learn.reason, 'learn.reason')
          check(command.learn.resultIds.length > 0 && command.learn.resultIds.every(id => ['accepted', 'rework'].includes(task.reports[id]?.disposition)), 'UNVERIFIED_LEARNING', 'Learning candidates must refer to results already evaluated as accepted or requiring rework.')
          if (command.learn.proposals) {
            check(Array.isArray(command.learn.proposals), 'INVALID_LEARNING', 'Learning proposals must be an array.')
            for (const proposal of command.learn.proposals) {
              validId(proposal.skillId, 'skillId'); text(proposal.title, 'skill.title'); text(proposal.description, 'skill.description')
              text(proposal.body, 'skill.body'); text(proposal.applicability, 'skill.applicability'); text(proposal.explanation, 'skill.explanation'); strings(proposal.artifactRefs, 'skill.artifactRefs')
              check(command.learn.resultIds.includes(proposal.resultId), 'UNVERIFIED_LEARNING', 'Each proposal must bind one of the evaluated source results.')
              check(proposal.activate === undefined || typeof proposal.activate === 'boolean', 'INVALID_LEARNING', 'activate must be boolean.')
              check(!proposal.activate || task.reports[proposal.resultId]?.disposition === 'accepted', 'UNVERIFIED_ACTIVATION', 'A failure-derived method remains a candidate until accepted result evidence validates its exact content.')
              check(proposal.expectedVersion === undefined || Number.isInteger(proposal.expectedVersion) && proposal.expectedVersion >= 1, 'INVALID_LEARNING', 'expectedVersion must identify a positive saved skill version.')
            }
          }
          addAction('learn', { resultIds: [...new Set(command.learn.resultIds)], reason: command.learn.reason,
            ...(command.learn.proposals ? { learningProposals: structuredClone(command.learn.proposals) } : {}) })
        }
        finishEvaluation(binding, action); dispatchReady()
        if (!task.delivery && command.decisions.length && task.plan.childIds.every(id => task.children[id].status === 'accepted')) {
          plan('The current Children are accepted. Reconcile the complete user goal and saved future backlog; add the next stage or deliver the fully accepted result.')
        }
        break
      }

      case 'planning.handoff': {
        const { binding, action } = requireEvaluator(task, command.source, command.actionId)
        check(binding?.role === 'planner', 'PLANNER_ONLY', 'Only the bound Planner can hand off its unfinished action.')
        check(command.expectedGoalRevision === task.goal.revision, 'GOAL_CHANGED', 'Read the current goal before handing off.', 'stale')
        text(command.summary, 'summary'); text(command.frontier, 'frontier')
        remember({ kind: 'checkpoint', summary: command.summary, frontier: command.frontier, executionId: binding.executionId }, command.memory)
        binding.state = 'closed'; binding.closedAt = env.now
        action.status = 'pending'; action.payload.predecessorExecutionId = binding.executionId
        action.payload.reason = command.frontier
        delete action.executionId; delete action.ownerId; delete action.startedAt
        break
      }

      case 'planning.checkpoint': {
        requireEvaluator(task, command.source, command.actionId)
        check(command.expectedGoalRevision === task.goal.revision, 'GOAL_CHANGED', 'Read the current user requirements before saving planning progress.', 'stale')
        text(command.summary, 'summary'); text(command.frontier, 'frontier')
        remember({ kind: 'checkpoint', summary: command.summary, frontier: command.frontier }, command.memory)
        // Meaningful planning progress is durable without closing this turn,
        // dispatching unfinished notes, or creating a second task authority.
        break
      }

      case 'task.reviseGoal': {
        requireIntent(command.source, task); requireNotTerminal(task)
        check(command.expectedGoalRevision === task.goal.revision, 'GOAL_CHANGED', 'The goal has changed.', 'stale'); validGoal(command.goal)
        task.goalHistory ??= []
        task.goalHistory.push({ goal: structuredClone(task.goal), replacedAt: env.now, commandId: command.commandId, changeSource: structuredClone(command.source) })
        task.goal = { ...structuredClone(command.goal), revision: task.goal.revision + 1 }; task.needsPlanning = true
        remember({ kind: 'user-change', summary: `The user revised the authoritative goal to revision ${task.goal.revision}.`, evidence: [task.goal.sourceRef] })
        for (const action of values(task.pendingActions)) if (['plan', 'evaluate', 'dispatch', 'continue'].includes(action.kind) && ['pending', 'running', 'uncertain'].includes(action.status)) action.status = 'superseded'
        for (const execution of values(task.executions)) if (execution.role === 'planner' && execution.state === 'active') { execution.state = 'superseded'; stop(execution, 'The user changed the goal.') }
        plan('The user changed the goal; preserve useful work and determine what is affected.')
        break
      }

      case 'task.control': {
        requireIntent(command.source, task)
        if (command.intent === 'pause') { requireNotTerminal(task); task.control = 'paused' }
        else if (command.intent === 'resume') {
          requireNotTerminal(task); task.control = 'running'
          if (task.needsPlanning) plan('Resume current-goal planning.')
          else {
            const results = values(task.reports).filter(r => r.disposition === 'unreviewed' && ['complete', 'failed'].includes(r.outcome) && task.children[r.childId]?.assignmentVersion === r.assignmentVersion).map(r => r.resultId)
            evaluate(results, 'Review completed work after resume.')
            for (const child of values(task.children)) if (task.plan.childIds.includes(child.id)) stageHandoff(child)
            for (const execution of values(task.executions)) if (execution.role === 'worker' && execution.physicalState === 'idle') continueExecution(execution, 'User resumed the task.')
            dispatchReady()
          }
        } else if (command.intent === 'cancel') {
          check(task.phase !== 'completed', 'TASK_TERMINAL', 'The task is already complete.')
          task.control = 'cancelled'
          task.cancelledAt = env.now
          for (const action of values(task.pendingActions)) if (action.kind !== 'stop' && ['pending', 'running', 'uncertain'].includes(action.status)) action.status = 'superseded'
          for (const child of values(task.children)) if (child.status !== 'accepted') child.status = 'cancelled'
          for (const execution of values(task.executions)) stop(execution, 'User cancelled the task.')
        } else if (command.intent === 'stop') {
          check(!!command.executionId, 'MISSING_EXECUTION', 'Stopping execution requires an exact executionId.')
          stop(mustExecution(task, command.executionId!), 'User requested this physical execution to stop.')
        } else throw new DomainError('INVALID_CONTROL', 'Unknown task control intent.')
        break
      }

      case 'task.priority': requireIntent(command.source, task); check(Number.isFinite(command.priority), 'INVALID_PRIORITY', 'Priority must be finite.'); task.priority = command.priority; break

      case 'wait.answer':
      case 'wait.resolve': {
        const wait = own(task.waits, command.waitId); check(wait, 'WAIT_NOT_FOUND', 'The wait does not exist.')
        if (command.type === 'wait.answer') {
          check(command.source.kind === 'user', 'USER_ONLY', 'Only an authenticated user can answer a user question.')
          check(wait.kind === 'user' || wait.kind === 'configuration', 'PHYSICAL_WAIT', 'An answer does not prove that a job or recovery finished.'); text(command.answer, 'answer')
          wait.answer = command.answer
        } else {
          requireRuntime(command.source); check(wait.kind !== 'user', 'USER_ONLY', 'Runtime observations cannot answer a user-only question.'); text(command.evidence, 'evidence'); wait.answer = command.evidence
        }
        if (wait.state === 'resolved') return duplicate('This wait was already resolved.')
        wait.state = 'resolved'; wait.resolvedAt = env.now
        remember({ kind: 'wait-resolution', summary: `Resolved ${wait.kind} dependency ${wait.id}.`, frontier: wait.resume,
          resolvedWait: structuredClone(wait), ...(wait.executionId ? { executionId: wait.executionId } : {}),
          ...(wait.childId ? { childId: wait.childId } : {}), ...(wait.incidentId ? { incidentId: wait.incidentId } : {}) })
        const blockedIncident = wait.incidentId ? task.incidents[wait.incidentId] : undefined
        if (blockedIncident && blockedIncident.state === 'waiting' && task.control !== 'cancelled'
          && !values(task.waits).some(other => other.incidentId === blockedIncident.id && other.state === 'waiting')) {
          blockedIncident.state = 'open'
          if (!actionExists('recover', action => action.payload.incidentId === blockedIncident.id)) addAction('recover', { incidentId: blockedIncident.id, executionId: blockedIncident.executionId, childId: blockedIncident.childId, reason: `The recorded incident dependency was explicitly resolved: ${wait.answer}` })
        }
        if (wait.executionId && !blockedIncident) {
          const execution = mustExecution(task, wait.executionId)
          if (execution.state === 'active') {
            if (execution.childId && !hasWait(task, execution.childId)) task.children[execution.childId].status = 'running'
            continueExecution(execution, 'The recorded wait condition has been resolved.')
          } else if (execution.childId && task.control === 'running') {
            const child = task.children[execution.childId]
            const resultId = child.currentResultId
            if (child.handoff?.predecessorExecutionId === execution.executionId) stageHandoff(child)
            else if (resultId && ['complete', 'failed'].includes(task.reports[resultId].outcome) && !task.needsPlanning) evaluate([resultId], 'Review the result after the user/dependency wait was resolved.')
            else { task.needsPlanning = true; plan('The stopped execution needs a new bounded assignment.') }
          } else if (execution.role === 'planner' && task.control !== 'cancelled'
            && !values(task.incidents).some(entry => entry.executionId === execution.executionId && entry.state !== 'resolved')) {
            const oldAction = mustAction(task, execution.actionId)
            execution.state = 'superseded'; oldAction.status = 'superseded'
            if (oldAction.kind === 'evaluate' && !task.needsPlanning && oldAction.payload.goalRevision === task.goal.revision) evaluate(oldAction.payload.resultIds ?? [], 'The evaluator dependency was resolved. Continue evaluation from the exact saved results and user answer.')
            else { task.needsPlanning = true; plan('The planner dependency was resolved. Continue from current user requirements, the saved frontier, and the recorded answer.') }
          }
        } else if (task.needsPlanning) plan('The recorded planning wait has been resolved.')
        dispatchReady(); break
      }

      case 'execution.bind': {
        requireRuntime(command.source)
        validId(command.executionId, 'executionId'); text(command.agentId, 'agentId'); text(command.sessionId, 'sessionId')
        const action = mustAction(task, command.actionId)
        check(action.status === 'running', 'ACTION_NOT_CLAIMED', 'Persist the action claim before binding execution.')
        check(!own(task.executions, command.executionId), 'EXECUTION_EXISTS', 'Execution identities cannot be reused.')
        check(!action.executionId, 'ACTION_ALREADY_BOUND', 'This action already has an execution binding.')
        check(roleForAction(action.kind) === command.role, 'WRONG_ROLE', 'The role does not match its originating action.')
        assertActionRunnable(task, action, true)
        const child = action.payload.childId ? mustChild(task, action.payload.childId) : undefined
        if (command.role === 'worker') check(child && !child.activeExecutionId && child.assignmentVersion === action.payload.assignmentVersion, 'CHILD_ALREADY_BOUND', 'The current assignment already has an owner.', 'stale')
        if (command.role === 'planner') check(!values(task.executions).some(e => e.role === 'planner' && e.state === 'active'), 'PLANNER_BUSY', 'A task has only one active planner.')
        const binding: ExecutionBinding = {
          executionId: command.executionId, taskId: task.id, role: command.role, agentId: command.agentId, sessionId: command.sessionId,
          actionId: action.id, goalRevision: task.goal.revision, generation: command.generation ?? 1 + Math.max(0, ...values(task.executions).filter(e => e.role === command.role && e.childId === (command.role === 'worker' ? child?.id : undefined)).map(e => e.generation)), state: 'active', physicalState: 'starting', ownedJobIds: [], startedAt: env.now, observedAt: env.now,
          writeScopes: command.role === 'worker' && child ? [...child.writeScopes] : [], resources: command.role === 'worker' && child ? [...child.resources] : [],
          ...(command.role === 'worker' && child ? { childId: child.id, assignmentVersion: child.assignmentVersion } : {}),
          ...(action.payload.recoveryIncidentId ? { incidentId: action.payload.recoveryIncidentId } : {}),
          ...(command.model ? { model: command.model } : {}), ...(command.configurationVersion ? { configurationVersion: command.configurationVersion } : {}),
        }
        check(Number.isInteger(binding.generation) && binding.generation >= 1, 'INVALID_GENERATION', 'Generation must be positive.')
        if (action.payload.predecessorExecutionId) {
          const previous = mustExecution(task, action.payload.predecessorExecutionId)
          check(binding.generation > previous.generation && binding.sessionId !== previous.sessionId && binding.agentId !== previous.agentId,
            'HANDOFF_IDENTITY_REUSED', 'A normal handoff requires a new native Session and a later execution generation.')
        }
        task.executions[binding.executionId] = binding; action.executionId = binding.executionId
        if (command.role === 'worker' && child) { child.activeExecutionId = binding.executionId; child.status = 'running'; delete child.handoff }
        break
      }

      case 'execution.report': {
        validReport(command.report)
        check(command.source.kind === 'agent' && command.source.role === 'worker', 'WORKER_ONLY', 'Only a bound worker can submit execution reports.')
        const previous = own(task.reports, command.report.resultId)
        if (previous) {
          check(previous.executionId === command.source.executionId && task.executions[previous.executionId].agentId === command.source.id && sameReport(previous, command.report), 'RESULT_ID_REUSED', 'This resultId was already used with different content or ownership.')
          return duplicate('This execution result was already recorded.')
        }
        const binding = requireBinding(task, command.source, 'worker')
        const child = mustChild(task, binding.childId!)
        check(child.activeExecutionId === binding.executionId && child.assignmentVersion === command.report.assignmentVersion && binding.assignmentVersion === command.report.assignmentVersion, 'ASSIGNMENT_CHANGED', 'This report does not belong to the current assignment.', 'stale')
        if (command.report.outcome === 'handoff') {
          check(!binding.stopRequested || task.control === 'cancelled', 'EXECUTION_STOP_REQUESTED', 'An explicit stop must settle before a new generation can be requested.')
          check(!actionExists('evaluate', action => (action.payload.resultIds ?? []).some(id => {
            const result = task.reports[id]
            return result?.childId === child.id && result.assignmentVersion === child.assignmentVersion && result.disposition === 'unreviewed'
          })), 'REVIEW_PENDING', 'Finish the current bounded-work review before requesting another generation.')
        }
        const report = { ...structuredClone(command.report), executionId: binding.executionId, childId: child.id, goalRevision: binding.goalRevision, receivedAt: env.now, disposition: 'unreviewed' as const, commandId: command.commandId, sequence: task.revision + 1 }
        task.reports[report.resultId] = report; child.currentResultId = report.resultId
        if (report.outcome === 'complete' || report.outcome === 'failed') {
          binding.state = 'closed'; binding.closedAt = env.now; child.status = 'reported'; delete child.activeExecutionId
          // Semantic completion fences role capability; the physical owner remains
          // represented until the supervisor has observed its jobs and teardown.
          // A business report cannot answer a user question or prove an unrelated
          // job/configuration wait resolved. Preserve those independent records.
          if (!task.needsPlanning && task.control !== 'cancelled') evaluate([report.resultId], report.outcome === 'complete' ? 'Worker completed its assignment.' : 'Worker reported a failed method; choose another approach.')
        } else if (report.outcome === 'handoff') {
          child.progressSegments += 1
          binding.state = 'closed'; binding.closedAt = env.now; delete child.activeExecutionId
          child.handoff = { predecessorExecutionId: binding.executionId, resultId: report.resultId,
            reviewRequired: child.progressSegments % env.reviewEvery === 0 }
          // This yields semantic authority only. The exact physical owner and
          // its jobs must drain before the next dispatch can bind a new Agent.
          for (const queued of values(task.pendingActions)) if (queued.kind === 'continue' && queued.status === 'pending'
            && queued.payload.executionId === binding.executionId) queued.status = 'superseded'
          stageHandoff(child); dispatchReady()
        } else if (report.outcome === 'wait') {
          check(report.wait, 'MISSING_WAIT', 'A wait report requires a concrete condition and resume entry.'); addWait(report.wait!, binding); child.status = 'waiting'
        } else {
          if (report.outcome === 'continue') {
            child.progressSegments += 1
            if (child.progressSegments % env.reviewEvery === 0 && !task.needsPlanning && task.control !== 'cancelled') { child.status = 'waiting'; evaluate([report.resultId], 'Periodic review of bounded work segments.') }
            else continueExecution(binding, 'Continue from the recorded work frontier.')
          }
        }
        break
      }

      case 'execution.requestHelp': {
        const binding = requireBinding(task, command.source)
        if (command.kind === 'mechanical') throw new DomainError('RUNTIME_RECOVERY', 'Fatal execution recovery is driven by native lifecycle evidence.')
        else {
          check(command.wait && command.wait.kind === command.kind, 'MISSING_WAIT', 'A dependency request needs a matching explicit wait.')
          addWait(command.wait!, binding)
          if (binding.childId) task.children[binding.childId].status = 'waiting'
          if (binding.role === 'planner') {
            const action = mustAction(task, binding.actionId)
            check(['plan', 'evaluate'].includes(action.kind) && action.status === 'running', 'INVALID_EVALUATION_ACTION', 'This Planner no longer owns its planning action.', 'stale')
            text(command.operation, 'operation'); text(command.message, 'message')
            remember({ kind: 'checkpoint', summary: command.message, frontier: command.wait!.resume, executionId: binding.executionId,
              evidence: [`wait:${command.wait!.id}`] })
            binding.state = 'closed'; binding.closedAt = env.now
            action.status = 'superseded'; action.finishedAt = env.now; action.evidence = `Planner yielded to dependency ${command.wait!.id}.`
            // The wait keeps the exact originating action/result references.
            // Its answer queues that semantic work again; the supervisor keeps
            // the old physical owner until its jobs and native turn settle.
          }
        }
        break
      }

      case 'execution.observed': {
        requireRuntime(command.source); const binding = mustExecution(task, command.executionId)
        check(['starting', 'running', 'idle', 'stopping', 'stopped', 'lost', 'unknown'].includes(command.physicalState), 'INVALID_PHYSICAL_STATE', 'Unknown physical execution state.')
        binding.physicalState = command.physicalState; binding.observedAt = env.now
        if (command.ownedJobIds) { strings(command.ownedJobIds, 'ownedJobIds'); binding.ownedJobIds = [...new Set(command.ownedJobIds)] }
        if (command.physicalState === 'stopped' && binding.state === 'active') {
          binding.state = 'closed'; binding.closedAt = env.now
          if (binding.childId && task.children[binding.childId].activeExecutionId === binding.executionId) {
            delete task.children[binding.childId].activeExecutionId; task.children[binding.childId].status = 'waiting'
          }
          if (task.control !== 'cancelled') {
            if (binding.role === 'helper' && binding.incidentId) {
              const original = task.incidents[binding.incidentId]
              const helpAction = mustAction(task, binding.actionId); helpAction.status = 'superseded'; helpAction.evidence = 'Historical Helper retired; continue through the original role.'
              if (original && original.state !== 'resolved' && original.state !== 'waiting') {
                original.state = 'open'
                if (!actionExists('recover', action => action.payload.incidentId === original.id))
                  addAction('recover', { incidentId: original.id, executionId: original.executionId, childId: original.childId, reason: 'Historical owner settled; preserve the original work frontier.' })
              }
            } else if (binding.stopRequested) addWait({ id: `${command.commandId}:stopped`, kind: 'user', reason: 'The requested execution has stopped before a final result.', condition: 'The user decides how to continue this work.', resume: 'Replan from the preserved work frontier.', question: 'This execution stopped. Should the remaining work be replanned?' }, binding)
            else if (!values(task.incidents).some(entry => entry.executionId === binding.executionId && entry.state !== 'resolved'))
              incident(binding.executionId, 'execution stopped', 'The physical execution ended without a terminal business report.')
          }
        }
        break
      }

      case 'incident.open': requireRuntime(command.source); incident(command.executionId, command.operation, command.message); break

      case 'execution.abandon': {
        requireRuntime(command.source); text(command.evidence, 'evidence')
        const owner = mustExecution(task, command.executionId)
        check(['stopped', 'lost'].includes(owner.physicalState) && owner.ownedJobIds.length === 0, 'OWNER_NOT_PROVEN_GONE', 'Only a proven stopped/lost exact owner without recorded live jobs can be retired; unknown is not proof.')
        const oldAction = mustAction(task, owner.actionId)
        const wasActive = owner.state === 'active'
        const unfinishedAction = ['pending', 'running', 'uncertain'].includes(oldAction.status)
        owner.state = 'superseded'; owner.closedAt = env.now
        if (['pending', 'running', 'uncertain'].includes(oldAction.status)) { oldAction.status = 'superseded'; oldAction.evidence = command.evidence }
        resolveActionWaits(task, oldAction.id, env.now)
        for (const action of values(task.pendingActions)) if (action.payload.executionId === owner.executionId && action.status === 'pending' && ['continue', 'stop'].includes(action.kind)) { action.status = 'superseded'; action.evidence = command.evidence }
        remember({ kind: 'recovery', summary: `Retired exact execution ${owner.executionId}: ${command.evidence}`, executionId: owner.executionId,
          ...(owner.childId ? { childId: owner.childId } : {}), ...(owner.incidentId ? { incidentId: owner.incidentId } : {}),
          recoveryOutcome: 'retired', physicalDisposition: { state: owner.physicalState, ownedJobIds: [...owner.ownedJobIds] } })
        if (owner.childId && task.children[owner.childId].activeExecutionId === owner.executionId) {
          delete task.children[owner.childId].activeExecutionId; task.children[owner.childId].status = 'waiting'
          if (task.control !== 'cancelled') { task.needsPlanning = true; plan('The old physical owner is proven gone. Inspect preserved results and frontier before issuing new work.') }
        } else if ((wasActive || unfinishedAction) && owner.role === 'planner' && task.control !== 'cancelled') {
          if (oldAction.kind === 'evaluate' && !task.needsPlanning && oldAction.payload.goalRevision === task.goal.revision) evaluate(oldAction.payload.resultIds ?? [], 'Replace the lost evaluator; keep the same saved result evidence.')
          else { task.needsPlanning = true; plan('Replace the lost planner using the current goal and preserved decisions.') }
        } else if ((wasActive || unfinishedAction) && owner.role === 'helper' && owner.incidentId && task.control !== 'cancelled') {
          const original = task.incidents[owner.incidentId]
          if (original && original.state !== 'resolved') {
            original.state = 'open'; delete original.helperExecutionId
            if (!actionExists('recover', a => a.payload.incidentId === original.id)) addAction('recover', { incidentId: original.id, executionId: original.executionId, childId: original.childId, reason: 'Historical recovery owner is retired; continue the original role from saved evidence.' })
          }
        }
        break
      }

      case 'recovery.legacy': {
        requireRuntime(command.source)
        for (const action of values(task.pendingActions)) if (action.kind === 'help' && ['pending', 'running', 'uncertain'].includes(action.status)) {
          action.status = 'superseded'; action.finishedAt = env.now
          action.evidence = 'Preserved historical Helper action; recovery now continues the original role.'
          if (action.executionId) {
            const owner = task.executions[action.executionId]
            if (owner) { owner.state = 'closed'; owner.closedAt ??= env.now }
          }
          const entry = task.incidents[action.payload.incidentId ?? '']
          if (entry && entry.state !== 'resolved' && entry.state !== 'waiting') {
            entry.state = 'open'
            if (!actionExists('recover', pending => pending.payload.incidentId === entry.id))
              addAction('recover', { incidentId: entry.id, executionId: entry.executionId, childId: entry.childId, reason: 'Continue the original interrupted role from saved evidence.' })
          }
        }
        break
      }

      case 'recovery.restart': {
        requireRuntime(command.source); text(command.evidence, 'evidence')
        const entry = task.incidents[command.incidentId]
        check(entry, 'INCIDENT_NOT_FOUND', 'The exact recovery incident is missing.')
        if (entry.state === 'resolved') return duplicate('This incident already has a recovery disposition.')
        check(entry.state !== 'waiting', 'RECOVERY_WAITING', 'Resolve the recorded fault condition before restarting.')
        const owner = mustExecution(task, entry.executionId), oldAction = mustAction(task, owner.actionId)
        check(['worker', 'planner'].includes(owner.role), 'RECOVERY_ROLE', 'Recovery continues a Worker or Planner.')
        check(['stopped', 'lost'].includes(owner.physicalState) && !owner.ownedJobIds.length,
          'OWNER_NOT_PROVEN_GONE', 'Retire the exact previous owner and its native jobs before restarting.')
        check(!entry.helperExecutionId || (['stopped', 'lost'].includes(task.executions[entry.helperExecutionId]?.physicalState)
          && !task.executions[entry.helperExecutionId]?.ownedJobIds.length), 'LEGACY_OWNER_BUSY', 'The historical recovery owner still requires physical reconciliation.')
        owner.state = 'superseded'; owner.closedAt = env.now
        entry.state = 'resolved'; entry.resolution = command.evidence
        for (const action of values(task.pendingActions)) if (action.kind === 'recover' && action.payload.incidentId === entry.id
          && ['pending', 'running', 'uncertain'].includes(action.status)) finishRuntimeAction(task, action, env.now, command.evidence)
        resolveActionWaits(task, oldAction.id, env.now)
        for (const action of values(task.pendingActions)) if (action.payload.executionId === owner.executionId
          && ['continue', 'stop'].includes(action.kind) && ['pending', 'running', 'uncertain'].includes(action.status)) {
          action.status = 'superseded'; action.evidence = command.evidence; resolveActionWaits(task, action.id, env.now)
        }
        remember({ kind: 'recovery', summary: command.evidence, incidentId: entry.id, executionId: owner.executionId,
          ...(owner.childId ? { childId: owner.childId } : {}), recoveryOutcome: 'resolved',
          physicalDisposition: { state: owner.physicalState, ownedJobIds: [] } })
        if (owner.role === 'worker' && owner.childId) {
          oldAction.status = 'superseded'
          const child = mustChild(task, owner.childId)
          if (child.activeExecutionId === owner.executionId) delete child.activeExecutionId
          if (child.assignmentVersion === owner.assignmentVersion && !child.activeExecutionId
            && task.plan.childIds.includes(child.id) && !['accepted', 'cancelled'].includes(child.status) && task.control !== 'cancelled') {
            const report = child.currentResultId ? task.reports[child.currentResultId] : undefined
            if (report?.executionId === owner.executionId && ['complete', 'failed'].includes(report.outcome)) {
              child.status = 'reported'
              if (report.disposition === 'unreviewed') evaluate([report.resultId], 'Restore evaluation of the saved terminal result; do not repeat the completed execution.')
            } else if (report?.executionId === owner.executionId) {
              const pendingReview = values(task.pendingActions)
                .filter(action => action.kind === 'evaluate' && ['pending', 'running', 'uncertain'].includes(action.status))
                .flatMap(action => action.payload.resultIds ?? []).map(id => task.reports[id])
                .filter(result => result?.executionId === owner.executionId && result.disposition === 'unreviewed').at(-1)
              child.handoff = { predecessorExecutionId: owner.executionId, resultId: pendingReview?.resultId ?? report.resultId, recoveryIncidentId: entry.id,
                reviewRequired: child.handoff?.reviewRequired === true || !!pendingReview
                  || report.disposition === 'unreviewed' && report.outcome === 'continue'
                    && child.progressSegments > 0 && child.progressSegments % env.reviewEvery === 0 }
              stageHandoff(child); dispatchReady()
            } else {
              child.status = 'pending'
              if (!actionExists('dispatch', action => action.payload.childId === child.id && action.payload.assignmentVersion === child.assignmentVersion))
                addAction('dispatch', { childId: child.id, assignmentVersion: child.assignmentVersion, planRevision: task.plan.revision,
                  predecessorExecutionId: owner.executionId, recoveryIncidentId: entry.id, reason: 'Continue the same unfinished Child after recorded execution failure.' })
            }
          }
        } else if (owner.role === 'planner' && ['plan', 'evaluate'].includes(oldAction.kind) && task.control !== 'cancelled'
          && ['pending', 'running', 'uncertain'].includes(oldAction.status) && !task.delivery
          && oldAction.payload.goalRevision === task.goal.revision) {
          oldAction.status = 'pending'; delete oldAction.executionId; delete oldAction.ownerId; delete oldAction.startedAt; delete oldAction.finishedAt
          oldAction.payload.predecessorExecutionId = owner.executionId
          oldAction.payload.recoveryIncidentId = entry.id
        } else if (oldAction.status !== 'done') oldAction.status = 'superseded'
        break
      }

      case 'action.claim': {
        requireRuntime(command.source); const action = mustAction(task, command.actionId)
        check(action.status === 'pending', 'ACTION_NOT_PENDING', 'Only a pending action may be claimed.')
        assertActionRunnable(task, action)
        action.status = 'running'; action.ownerId = command.ownerId; action.startedAt = env.now
        break
      }

      case 'action.finish': {
        requireRuntime(command.source); const action = mustAction(task, command.actionId)
        if (action.status === 'done') return duplicate('This action has already been observed complete.')
        check(['running', 'uncertain'].includes(action.status), 'ACTION_NOT_RUNNING', 'Only an admitted action may be acknowledged.')
        check(runtimeKinds.has(action.kind), 'SEMANTIC_ACTION', 'An idle Agent is not a semantic planning/recovery result.')
        finishRuntimeAction(task, action, env.now, command.evidence, command.notificationId)
        if (action.kind === 'dispatch') dispatchReady()
        break
      }

      case 'action.reconcile': {
        requireRuntime(command.source); const action = mustAction(task, command.actionId); text(command.evidence, 'evidence')
        check(['running', 'uncertain'].includes(action.status), 'ACTION_NOT_IN_DOUBT', 'Only an interrupted/in-doubt action needs reconciliation.')
        action.evidence = command.evidence
        if (command.resolution === 'not_started') {
          check(!action.executionId, 'EXECUTION_ALREADY_BOUND', 'A persisted execution needs explicit ownership recovery; do not replay its launch blindly.')
          action.status = 'pending'; delete action.ownerId; delete action.startedAt
          resolveActionWaits(task, action.id, env.now)
        } else if (command.resolution === 'completed') {
          check(runtimeKinds.has(action.kind), 'SEMANTIC_RESULT_REQUIRED', 'Recover the actual semantic report before completing this action.')
          finishRuntimeAction(task, action, env.now, command.evidence, command.notificationId)
          if (action.kind === 'dispatch') dispatchReady()
        } else {
          action.status = 'uncertain'
          const id = `uncertain:${action.id}`
          if (!own(task.waits, id) || task.waits[id].state === 'resolved') {
            const execution = action.executionId ? task.executions[action.executionId] : action.payload.executionId ? task.executions[action.payload.executionId] : undefined
            addWait({ id, kind: 'recovery', reason: command.evidence, condition: 'Reconcile this specific action against session, job, or artifact evidence.', resume: `Reconcile action ${action.id}; do not automatically repeat it.` }, execution, action.id)
          }
        }
        break
      }

      case 'delivery.read': requireIntent(command.source, task); check(task.delivery, 'NO_DELIVERY', 'No delivery exists.'); task.delivery!.readAt = env.now; break
      case 'task.archive':
      case 'task.purgeArchive': {
        const outcome = applyRetentionCommand(task, command, env.now)
        if (!outcome.ok) throw new DomainError(outcome.code, outcome.reason, outcome.code === 'RETENTION_STALE' ? 'stale' : 'rejected')
        if (task.archive) for (const child of values(task.children)) delete child.handoff
        break
      }
      default: throw new DomainError('UNKNOWN_COMMAND', 'Unsupported task command.')
    }
    task.phase = derivePhase(task)
    task.revision += 1; task.updatedAt = env.now
    const applied: CommandReceipt = { commandId: command.commandId, taskId: task.id, status: 'applied', revision: task.revision, actionIds }
    task.receipts[command.commandId] = { fingerprint: env.fingerprint, receipt: applied }
    return { task, receipt: applied, changed: true }
  } catch (error) {
    if (!(error instanceof DomainError)) throw error
    return { task: current, changed: false, receipt: receipt(error.status, error.message, error.code) }
  }
}

function text(value: unknown, label: string): asserts value is string { check(typeof value === 'string' && value.trim().length > 0, 'INVALID_INPUT', `${label} must be a nonempty string.`) }
function validId(value: unknown, label: string): asserts value is string { text(value, label); check(value.length <= 512 && !['__proto__', 'prototype', 'constructor'].includes(value) && !/[\0\r\n]/.test(value), 'INVALID_ID', `${label} is not a valid record identity.`) }
function strings(value: unknown, label: string): asserts value is string[] { check(Array.isArray(value) && value.every(v => typeof v === 'string'), 'INVALID_INPUT', `${label} must be a string array.`) }
function validSource(source: CommandSource): void { check(source && ['user', 'runtime', 'agent'].includes(source.kind), 'INVALID_SOURCE', 'A trusted command source is required.'); text(source.id, 'source.id'); if (source.kind === 'agent') { validId(source.executionId, 'source.executionId'); check(['foreground', 'planner', 'worker', 'helper'].includes(source.role), 'INVALID_ROLE', 'Unknown role.') } }
function requireIntent(source: CommandSource, task?: Task): void { check(source.kind === 'user' || (source.kind === 'agent' && source.role === 'foreground' && (!task || task.foregroundEvaluator === source.id)), 'INTENT_ONLY', 'This operation requires the user or the task-associated foreground.') }
function requireRuntime(source: CommandSource): void { check(source.kind === 'runtime', 'RUNTIME_ONLY', 'This operation requires the trusted runtime.') }
function requireNotTerminal(task: Task): void { check(task.control !== 'cancelled' && task.phase !== 'completed', 'TASK_TERMINAL', 'A terminal task cannot be resumed or revised; submit a new goal.') }
function validGoal(goal: GoalInput): void { check(goal && typeof goal === 'object', 'INVALID_GOAL', 'A goal is required.'); text(goal.request, 'goal.request'); text(goal.objective, 'goal.objective'); text(goal.sourceRef, 'goal.sourceRef'); strings(goal.constraints, 'goal.constraints'); strings(goal.deliverables, 'goal.deliverables'); strings(goal.acceptanceCriteria, 'goal.acceptanceCriteria'); check(goal.acceptanceCriteria.length > 0, 'MISSING_ACCEPTANCE', 'A goal requires acceptance criteria.') }
function validArtifacts(artifacts: ArtifactRef[]): void { check(Array.isArray(artifacts), 'INVALID_ARTIFACTS', 'Artifacts must be an array.'); for (const artifact of artifacts) { validId(artifact.id, 'artifact.id'); text(artifact.path, 'artifact.path'); text(artifact.description, 'artifact.description') } }
function validChildSpec(child: ChildSpec): void { check(child && typeof child === 'object', 'INVALID_CHILD', 'Invalid child.'); validId(child.id, 'child.id'); text(child.title, 'child.title'); text(child.objective, 'child.objective'); validArtifacts(child.inputArtifacts); strings(child.acceptanceCriteria, 'child.acceptanceCriteria'); check(child.acceptanceCriteria.length > 0, 'MISSING_ACCEPTANCE', 'Child requires acceptance criteria.'); strings(child.dependsOn, 'child.dependsOn'); strings(child.writeScopes, 'child.writeScopes'); strings(child.resources, 'child.resources'); child.dependsOn.forEach(id => validId(id, 'dependency')) }
function validWait(wait: WaitSpec): void { validId(wait.id, 'wait.id'); check(['user', 'configuration', 'resource', 'job', 'recovery'].includes(wait.kind), 'INVALID_WAIT_KIND', 'Unknown wait kind.'); text(wait.reason, 'wait.reason'); text(wait.condition, 'wait.condition'); text(wait.resume, 'wait.resume'); if (wait.kind === 'user') text(wait.question, 'wait.question'); if (wait.kind === 'job') text(wait.jobId, 'wait.jobId') }
function validReport(report: ExecutionReportInput, archived = false): void {
  check(report && typeof report === 'object', 'INVALID_REPORT', 'A report is required.'); validId(report.resultId, 'resultId')
  check(Number.isInteger(report.assignmentVersion) && report.assignmentVersion >= 1, 'INVALID_ASSIGNMENT', 'A positive assignmentVersion is required.')
  check(['progress', 'continue', 'handoff', 'complete', 'wait', 'failed'].includes(report.outcome), 'INVALID_OUTCOME', 'Unknown report outcome.')
  text(report.summary, 'report.summary'); text(report.frontier, 'report.frontier'); validArtifacts(report.artifacts); strings(report.evidence, 'report.evidence')
  if (report.checkpoint) {
    const checkpoint = report.checkpoint
    strings(checkpoint.completed, 'checkpoint.completed'); strings(checkpoint.remaining, 'checkpoint.remaining'); strings(checkpoint.nextReads, 'checkpoint.nextReads'); text(checkpoint.nextAction, 'checkpoint.nextAction')
    check(Array.isArray(checkpoint.failedApproaches), 'INVALID_CHECKPOINT', 'Failed approaches must be an array of evidence-bearing observations.')
    for (const failure of checkpoint.failedApproaches) { text(failure.approach, 'failedApproach.approach'); text(failure.outcome, 'failedApproach.outcome'); strings(failure.evidence, 'failedApproach.evidence') }
  }
  if (report.outcome === 'handoff' && !archived) {
    check(report.checkpoint && report.checkpoint.remaining.length > 0, 'MISSING_HANDOFF_CHECKPOINT', 'A normal handoff needs a saved checkpoint with remaining work.')
    report.checkpoint.remaining.forEach(item => text(item, 'checkpoint.remaining'))
  }
}
function persistPlannerMemory(task: Task, memory: PlannerMemoryInput | undefined, commandId: string, now: string): Partial<DecisionRecord> {
  if (!memory) return {}
  check(typeof memory === 'object' && !Array.isArray(memory), 'INVALID_MEMORY', 'Planning memory must be structured input.')
  const result: Partial<DecisionRecord> = {}
  if (memory.frontier !== undefined) { text(memory.frontier, 'memory.frontier'); result.frontier = memory.frontier }
  for (const field of ['evidence', 'failedApproaches', 'changedAssumptions'] as const) if (memory[field] !== undefined) { strings(memory[field], `memory.${field}`); result[field] = [...memory[field]!] }
  const oldRevision = task.plannerNote?.revision ?? 0
  if (memory.noteUse) {
    check(task.plannerNote && memory.noteUse.revision === oldRevision, 'PLAN_NOTE_CHANGED', 'Consult the current planning note before citing it.', 'stale')
    text(memory.noteUse.summary, 'noteUse.summary'); text(memory.noteUse.frontier, 'noteUse.frontier')
    result.planNoteUsage = structuredClone(memory.noteUse)
  }
  if (memory.planNote) {
    const note = memory.planNote
    check(Number.isInteger(note.expectedRevision) && note.expectedRevision === oldRevision, 'PLAN_NOTE_CHANGED', 'The mutable planning note changed; read its current revision.', 'stale')
    text(note.body, 'planNote.body'); text(note.frontier, 'planNote.frontier'); text(note.changeSummary, 'planNote.changeSummary')
    if (note.backlog !== undefined) {
      check(Array.isArray(note.backlog), 'INVALID_BACKLOG', 'Planning backlog must be an array.')
      check(new Set(note.backlog.map(item => item.id)).size === note.backlog.length, 'DUPLICATE_BACKLOG', 'Backlog item ids must be unique.')
      for (const item of note.backlog) {
        validId(item.id, 'backlog.id'); text(item.objective, 'backlog.objective'); text(item.reason, 'backlog.reason'); text(item.trigger, 'backlog.trigger'); strings(item.dependsOn, 'backlog.dependsOn')
        check(typeof item.required === 'boolean' && ['pending', 'done', 'cancelled'].includes(item.status), 'INVALID_BACKLOG', 'Backlog entries need required and status.')
      }
    }
    const backlog = note.backlog ?? task.plannerNote?.backlog
    task.plannerNote = { revision: oldRevision + 1, goalRevision: task.goal.revision, body: note.body, frontier: note.frontier, updatedAt: now, commandId,
      ...(backlog ? { backlog: structuredClone(backlog) } : {}) }
    result.planNoteChange = { fromRevision: oldRevision, toRevision: oldRevision + 1, summary: note.changeSummary, frontier: note.frontier }
  }
  return result
}
function mustChild(task: Task, id: string): Child { const child = own(task.children, id); check(child, 'CHILD_NOT_FOUND', 'Child does not exist.'); return child }
function mustExecution(task: Task, id: string): ExecutionBinding { const binding = own(task.executions, id); check(binding, 'EXECUTION_NOT_FOUND', 'Execution binding does not exist.'); return binding }
function mustAction(task: Task, id: string): PendingAction { const action = own(task.pendingActions, id); check(action, 'ACTION_NOT_FOUND', 'PendingAction does not exist.'); return action }
function requireBinding(task: Task, source: CommandSource, role?: string): ExecutionBinding {
  check(source.kind === 'agent', 'AGENT_ONLY', 'A bound role Agent is required.')
  const binding = mustExecution(task, source.executionId)
  check(binding.state === 'active', 'EXECUTION_CLOSED', 'This execution no longer owns business capability.', 'stale')
  check(binding.agentId === source.id && binding.role === source.role && (!role || binding.role === role) && (!source.sessionId || binding.sessionId === source.sessionId), 'WRONG_OWNER', 'The actual calling Agent does not own this execution.')
  return binding
}
function requireEvaluator(task: Task, source: CommandSource, actionId?: string): { binding?: ExecutionBinding; action: PendingAction } {
  let binding: ExecutionBinding | undefined
  let action: PendingAction
  if (source.kind === 'agent' && source.role === 'foreground' && task.foregroundEvaluator === source.id) {
    check(!!actionId, 'MISSING_ACTION', 'Foreground evaluation requires its exact runtime-assigned action.'); action = mustAction(task, actionId!)
  } else { binding = requireBinding(task, source, 'planner'); action = mustAction(task, binding.actionId) }
  check(['plan', 'evaluate'].includes(action.kind) && action.status === 'running', 'INVALID_EVALUATION_ACTION', 'This evaluation action is no longer active.', 'stale')
  check(action.payload.goalRevision === task.goal.revision, 'GOAL_CHANGED', 'This evaluation belongs to an older goal.', 'stale')
  return { binding, action }
}
function childSpec(child: ChildSpec): ChildSpec { return { id: child.id, title: child.title, objective: child.objective, inputArtifacts: child.inputArtifacts, acceptanceCriteria: child.acceptanceCriteria, dependsOn: child.dependsOn, writeScopes: child.writeScopes, resources: child.resources } }
function sameSpec(left: ChildSpec, right: ChildSpec): boolean { return JSON.stringify(childSpec(left)) === JSON.stringify(childSpec(right)) }
function sameReport(left: ExecutionReportInput, right: ExecutionReportInput): boolean { return JSON.stringify({ resultId: left.resultId, assignmentVersion: left.assignmentVersion, outcome: left.outcome, summary: left.summary, artifacts: left.artifacts, evidence: left.evidence, frontier: left.frontier, wait: left.wait, checkpoint: left.checkpoint }) === JSON.stringify({ resultId: right.resultId, assignmentVersion: right.assignmentVersion, outcome: right.outcome, summary: right.summary, artifacts: right.artifacts, evidence: right.evidence, frontier: right.frontier, wait: right.wait, checkpoint: right.checkpoint }) }
function hasCycle(children: ChildSpec[]): boolean {
  const map = new Map(children.map(child => [child.id, child.dependsOn])); const visiting = new Set<string>(); const visited = new Set<string>()
  const visit = (id: string): boolean => { if (visiting.has(id)) return true; if (visited.has(id)) return false; visiting.add(id); for (const dep of map.get(id) ?? []) if (visit(dep)) return true; visiting.delete(id); visited.add(id); return false }
  return children.some(child => visit(child.id))
}
function dependenciesAccepted(task: Task, child: Child): boolean { return child.dependsOn.every(id => task.children[id]?.status === 'accepted' && task.children[id].acceptedAtGoalRevision === task.goal.revision) }
function hasWait(task: Task, childId?: string): boolean { return values(task.waits).some(w => w.state === 'waiting' && (!childId || !w.childId || w.childId === childId)) }
function supersedeChildActions(task: Task, childId: string): void { for (const action of values(task.pendingActions)) if (action.payload.childId === childId && ['dispatch', 'continue'].includes(action.kind) && ['pending', 'running', 'uncertain'].includes(action.status)) action.status = 'superseded' }
function roleForAction(kind: ActionKind): string | undefined { return kind === 'plan' || kind === 'evaluate' ? 'planner' : kind === 'dispatch' ? 'worker' : undefined }
function assertActionRunnable(task: Task, action: PendingAction, binding = false): void {
  if (action.kind === 'stop') return
  check(task.control !== 'cancelled', 'TASK_CANCELLED', 'Cancelled tasks cannot start more work.')
  check(action.kind !== 'help', 'LEGACY_HELPER', 'Historical Helper actions are retained as evidence; new recovery uses the original role.')
  if (action.kind === 'recover' || action.kind === 'deliver' || action.kind === 'learn' || action.kind === 'feedback') return
  check(task.control === 'running', 'TASK_PAUSED', 'The user has paused further work.')
  check(action.payload.goalRevision === task.goal.revision, 'GOAL_CHANGED', 'This action belongs to an older goal.', 'stale')
  if (action.kind === 'plan' || action.kind === 'evaluate') {
    check(!values(task.waits).some(w => w.state === 'waiting' && !w.childId), 'WAITING', 'A required task-level decision is unresolved.')
    if (action.payload.predecessorExecutionId) {
      const previous = mustExecution(task, action.payload.predecessorExecutionId)
      check(previous.role === 'planner' && previous.actionId === action.id && previous.state !== 'active'
        && ['stopped', 'lost'].includes(previous.physicalState) && previous.ownedJobIds.length === 0,
        'HANDOFF_OWNER_ACTIVE', 'Retire the exact previous Planner and its jobs before continuing the same action.')
    }
    check(!values(task.pendingActions).some(a => a.id !== action.id && ['plan', 'evaluate'].includes(a.kind) && a.status === 'running'), 'PLANNER_BUSY', 'Another planning/evaluation action already owns the task.')
    return
  }
  check(!hasWait(task, action.payload.childId), 'WAITING', 'A required wait is unresolved.')
  check(!task.needsPlanning && task.plan.goalRevision === task.goal.revision, 'REPLAN_REQUIRED', 'Reconcile the changed goal before dispatching work.')
  const child = mustChild(task, action.payload.childId!)
  check(task.plan.childIds.includes(child.id) && child.assignmentVersion === action.payload.assignmentVersion, 'ASSIGNMENT_CHANGED', 'This action belongs to an older assignment.', 'stale')
  check(dependenciesAccepted(task, child), 'DEPENDENCIES_PENDING', 'The input dependencies have not been accepted.')
  if (action.kind === 'dispatch') {
    check(['pending', 'rework'].includes(child.status) && !child.activeExecutionId && !child.handoff?.reviewRequired, 'CHILD_NOT_READY', 'This assignment already has work, a result, or a due review.')
    if (child.handoff || action.payload.predecessorExecutionId) {
      const recovery = action.payload.recoveryIncidentId ? task.incidents[action.payload.recoveryIncidentId] : undefined
      check(recovery ? recovery.state === 'resolved' && recovery.executionId === action.payload.predecessorExecutionId
        : child.handoff && action.payload.predecessorExecutionId === child.handoff.predecessorExecutionId && !child.handoff.reviewRequired,
        'HANDOFF_CHANGED', 'The next generation must use its exact reviewed handoff or recorded recovery.', 'stale')
      const previous = mustExecution(task, action.payload.predecessorExecutionId!)
      check(previous.role === 'worker' && previous.childId === child.id && previous.assignmentVersion === child.assignmentVersion && previous.state !== 'active',
        'HANDOFF_OWNER_CHANGED', 'The handoff must retain the exact previous Worker and unchanged assignment.', 'stale')
      check(['stopped', 'lost'].includes(previous.physicalState) && previous.ownedJobIds.length === 0,
        'HANDOFF_OWNER_ACTIVE', 'The previous Worker and its jobs have not reached a proven stopped boundary.')
    }
  }
  if (action.kind === 'continue') {
    const execution = mustExecution(task, action.payload.executionId!)
    check(execution.state === 'active' && !execution.stopRequested && child.activeExecutionId === execution.executionId, 'EXECUTION_CLOSED', 'This worker cannot continue.', 'stale')
    check(child.status === 'running' && !values(task.incidents).some(i => i.executionId === execution.executionId && i.state !== 'resolved'), 'REVIEW_OR_RECOVERY_PENDING', 'This worker is waiting for evaluation or repair.')
  }
  void binding
}
function finishRuntimeAction(task: Task, action: PendingAction, now: string, evidence?: string, notificationId?: string): void {
  if (action.kind === 'recover') check(task.incidents[action.payload.incidentId ?? '']?.state === 'resolved', 'RECOVERY_NOT_FINISHED', 'Recovery completes only with a saved disposition for its exact incident.')
  if (action.kind === 'dispatch') check(!!action.executionId, 'NO_EXECUTION', 'Dispatch completion requires a persisted execution binding.')
  if (action.kind === 'stop') { const execution = mustExecution(task, action.payload.executionId!); check(['stopped', 'lost'].includes(execution.physicalState) && execution.ownedJobIds.length === 0, 'STILL_RUNNING', 'A stop request is not proof that the exact owner and its jobs have ended.') }
  if (action.kind === 'deliver') {
    check(task.delivery && task.delivery.id === action.payload.deliveryId, 'DELIVERY_CHANGED', 'Delivery identity changed.'); text(notificationId, 'notificationId')
    task.delivery.status = 'delivered'; task.delivery.notificationId = notificationId; task.delivery.deliveredAt = now
    task.completedAt = now
  }
  action.status = 'done'; action.finishedAt = now; if (evidence) action.evidence = evidence
  resolveActionWaits(task, action.id, now)
}
function resolveActionWaits(task: Task, actionId: string, now: string): void { for (const wait of values(task.waits)) if (wait.actionId === actionId && wait.state === 'waiting') { wait.state = 'resolved'; wait.resolvedAt = now } }
function derivePhase(task: Task): Task['phase'] {
  if (task.control === 'cancelled') return 'cancelled'
  if (task.delivery) return task.delivery.status === 'delivered' ? 'completed' : 'delivering'
  if (task.needsPlanning) return hasWait(task) ? 'waiting' : 'planning'
  if (values(task.pendingActions).some(a => a.kind === 'evaluate' && ['pending', 'running'].includes(a.status))) return 'evaluating'
  if (hasWait(task) || values(task.incidents).some(i => i.state !== 'resolved')) return 'waiting'
  return 'executing'
}

/** Validate persisted structure before using it; damaged data is never silently reset. */
export function assertTaskRecord(value: unknown): asserts value is Task {
  try {
    check(value && typeof value === 'object', 'CORRUPT', 'Task record is not an object.')
    const task = value as Task
    check(task.schemaVersion === 1, 'CORRUPT', 'Unsupported task schemaVersion.')
    validId(task.id, 'task.id'); validId(task.assistantId, 'assistantId'); validGoal(task.goal)
    check(Number.isInteger(task.revision) && task.revision >= 1, 'CORRUPT', 'Invalid task revision.')
    check(Number.isInteger(task.goal.revision) && task.goal.revision >= 1, 'CORRUPT', 'Invalid goal revision.')
    text(task.workspace?.id, 'workspace.id'); text(task.workspace?.directory, 'workspace.directory'); validSource(task.source)
    check(['running', 'paused', 'cancelled'].includes(task.control), 'CORRUPT', 'Invalid control intent.')
    check(['planning', 'executing', 'evaluating', 'waiting', 'delivering', 'completed', 'cancelled'].includes(task.phase), 'CORRUPT', 'Invalid task phase.')
    for (const key of ['children', 'executions', 'reports', 'waits', 'incidents', 'pendingActions', 'receipts'] as const) check(task[key] && typeof task[key] === 'object' && !Array.isArray(task[key]), 'CORRUPT', `Invalid ${key} map.`)
    check(task.plan && Number.isInteger(task.plan.revision) && task.plan.revision >= 0, 'CORRUPT', 'Invalid plan revision.'); strings(task.plan.childIds, 'plan.childIds')
    check(task.plan.childIds.every(id => !!own(task.children, id)), 'CORRUPT', 'Plan references a missing child.')
    for (const [id, child] of Object.entries(task.children)) {
      check(child.id === id, 'CORRUPT', 'Child identity mismatch.'); validChildSpec(child)
      check(Number.isInteger(child.assignmentVersion) && child.assignmentVersion >= 1 && Number.isInteger(child.goalRevision) && child.goalRevision >= 1, 'CORRUPT', 'Invalid child version.')
      check(['pending', 'running', 'waiting', 'reported', 'accepted', 'rework', 'cancelled'].includes(child.status), 'CORRUPT', 'Invalid child status.')
      if (child.activeExecutionId) { const owner = own(task.executions, child.activeExecutionId); check(owner && owner.childId === id && owner.assignmentVersion === child.assignmentVersion && owner.state === 'active', 'CORRUPT', 'Child execution ownership mismatch.') }
      if (child.handoff) {
        const previous = own(task.executions, child.handoff.predecessorExecutionId)
        const report = own(task.reports, child.handoff.resultId)
        check(!child.activeExecutionId && previous?.role === 'worker' && previous.childId === id && previous.assignmentVersion === child.assignmentVersion && previous.state !== 'active'
          && report && (report.outcome === 'handoff' || (['progress', 'continue', 'wait'].includes(report.outcome)
            && !!child.handoff.recoveryIncidentId && task.incidents[child.handoff.recoveryIncidentId]?.executionId === previous.executionId
            && task.incidents[child.handoff.recoveryIncidentId]?.state === 'resolved'))
          && report.executionId === previous.executionId
          && (child.currentResultId === report.resultId || !!child.handoff.recoveryIncidentId
            && task.reports[child.currentResultId ?? '']?.executionId === previous.executionId)
          && typeof child.handoff.reviewRequired === 'boolean', 'CORRUPT', 'Child handoff lost its exact predecessor or saved work frontier.')
      }
      if (child.currentResultId) check(own(task.reports, child.currentResultId)?.childId === child.id, 'CORRUPT', 'Missing current result.')
      if (child.status === 'accepted') check(child.acceptedResultId && own(task.reports, child.acceptedResultId)?.disposition === 'accepted', 'CORRUPT', 'Accepted child has no accepted result.')
    }
    for (const [id, binding] of Object.entries(task.executions)) {
      check(binding.executionId === id && binding.taskId === task.id, 'CORRUPT', 'Execution identity mismatch.'); validId(id, 'executionId'); text(binding.agentId, 'agentId'); text(binding.sessionId, 'sessionId')
      check(['active', 'closed', 'superseded'].includes(binding.state), 'CORRUPT', 'Invalid binding state.'); check(['starting', 'running', 'idle', 'stopping', 'stopped', 'lost', 'unknown'].includes(binding.physicalState), 'CORRUPT', 'Invalid physical state.')
      strings(binding.writeScopes, 'binding.writeScopes'); strings(binding.resources, 'binding.resources'); strings(binding.ownedJobIds, 'binding.ownedJobIds')
      check(!!own(task.pendingActions, binding.actionId), 'CORRUPT', 'Execution has no originating action.')
      if (binding.childId) check(!!own(task.children, binding.childId), 'CORRUPT', 'Execution references missing child.')
    }
    for (const [id, report] of Object.entries(task.reports)) { check(report.resultId === id && !!own(task.executions, report.executionId) && !!own(task.children, report.childId), 'CORRUPT', 'Report ownership mismatch.'); validReport(report, !!task.archive) }
    for (const [id, action] of Object.entries(task.pendingActions)) { check(action.id === id, 'CORRUPT', 'Action identity mismatch.'); validId(id, 'action.id'); check([...semanticKinds, ...runtimeKinds, 'help'].includes(action.kind), 'CORRUPT', 'Unknown action kind.'); check(['pending', 'running', 'done', 'uncertain', 'superseded'].includes(action.status), 'CORRUPT', 'Invalid action status.'); check(action.payload && Number.isInteger(action.payload.goalRevision), 'CORRUPT', 'Invalid action payload.'); if (action.executionId) check(!!own(task.executions, action.executionId), 'CORRUPT', 'Action points to missing execution.') }
    for (const [id, wait] of Object.entries(task.waits)) { check(wait.id === id, 'CORRUPT', 'Wait identity mismatch.'); validWait(wait); check(['waiting', 'resolved'].includes(wait.state), 'CORRUPT', 'Invalid wait state.') }
    for (const [id, entry] of Object.entries(task.receipts)) check(entry.receipt.commandId === id && entry.receipt.taskId === task.id && typeof entry.fingerprint === 'string', 'CORRUPT', 'Invalid receipt identity.')
    check(Array.isArray(task.decisions), 'CORRUPT', 'Invalid decision records.')
    for (const entry of task.decisions) {
      validId(entry.commandId, 'decision.commandId'); validSource(entry.source); text(entry.summary, 'decision.summary')
      check(Number.isInteger(entry.goalRevision) && entry.goalRevision >= 1 && entry.goalRevision <= task.goal.revision, 'CORRUPT', 'Decision goal version is invalid.')
      if (entry.sequence !== undefined) check(Number.isInteger(entry.sequence) && entry.sequence >= 1 && entry.sequence <= task.revision, 'CORRUPT', 'Decision sequence is invalid.')
      if (entry.frontier !== undefined) text(entry.frontier, 'decision.frontier')
      if (entry.resolvedWait) { validWait(entry.resolvedWait); check(entry.resolvedWait.state === 'resolved', 'CORRUPT', 'Wait memory must preserve an observed resolution.'); text(entry.resolvedWait.answer, 'resolvedWait.answer') }
      for (const field of ['evidence', 'failedApproaches', 'changedAssumptions'] as const) if (entry[field] !== undefined) strings(entry[field], `decision.${field}`)
      if (entry.childDecisions) for (const decision of entry.childDecisions) {
        check(!!own(task.children, decision.childId) && own(task.reports, decision.resultId)?.childId === decision.childId, 'CORRUPT', 'Child feedback lost its exact source result.')
        check(['accept', 'rework', 'continue'].includes(decision.outcome), 'CORRUPT', 'Invalid child feedback outcome.'); text(decision.reason, 'decision.reason')
        check(Number.isInteger(decision.assignmentVersion) && Number.isInteger(decision.resultingAssignmentVersion), 'CORRUPT', 'Invalid feedback assignment versions.')
      }
    }
    if (task.goalHistory) for (const previous of task.goalHistory) { validGoal(previous.goal); validSource(previous.changeSource); check(previous.goal.revision >= 1 && previous.goal.revision < task.goal.revision, 'CORRUPT', 'Historical goal must precede current user requirements.'); text(previous.replacedAt, 'goalHistory.replacedAt') }
    if (task.plannerNote) { check(Number.isInteger(task.plannerNote.revision) && task.plannerNote.revision >= 1 && task.plannerNote.goalRevision <= task.goal.revision, 'CORRUPT', 'Invalid planning note version.'); text(task.plannerNote.body, 'plannerNote.body'); text(task.plannerNote.frontier, 'plannerNote.frontier') }
    if (task.completedAt) text(task.completedAt, 'completedAt')
    if (task.cancelledAt) text(task.cancelledAt, 'cancelledAt')
    check(!hasCycle(task.plan.childIds.map(id => task.children[id])), 'CORRUPT', 'Persisted dependency cycle.')
  } catch (error) { throw new Error(`Corrupt deepseek-servant task record: ${error instanceof Error ? error.message : String(error)}`) }
}
