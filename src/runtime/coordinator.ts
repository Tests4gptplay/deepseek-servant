import { createHash, randomUUID } from 'node:crypto'
import type { AssistantService } from '../application/assistant-service.ts'
import type { TaskService } from '../application/task-service.ts'
import type { KnowledgeService } from '../application/knowledge-service.ts'
import type { CommandReceipt, ExecutionBinding, PendingAction, Task, TaskCommand } from '../contracts/task.ts'
import type { DshSessionReader } from '../adapters/dsh/sessions.ts'
import type { AgentSupervisor } from './agent-supervisor.ts'
import { Scheduler } from './scheduler.ts'

export interface CoordinatorOptions {
  tasks: TaskService
  assistants: AssistantService
  knowledge: KnowledgeService
  supervisor: AgentSupervisor
  sessions: DshSessionReader
  workerSeats?: number
  afterCleanup?(): Promise<void>
  onChanged?(): void
  onError?(error: unknown): void
}

const source = { kind: 'runtime' as const, id: 'deepseek-servant' }
const priority = { stop: 0, deliver: 1, feedback: 2, learn: 3, recover: 4, evaluate: 5, plan: 6, continue: 7, dispatch: 8, help: 9 }

/** Event-driven local action dispatcher. It never invents plans or accepts quality. */
export class RuntimeCoordinator {
  private readonly ownerId = `servant-host-${randomUUID()}`
  private readonly scheduler: Scheduler
  private readonly inflight = new Map<string, Promise<void>>()
  private readonly failed = new Map<string, string>()
  private unsubscribe?: () => void
  private running = false
  private stopping = false
  private dirty = false
  private drainPromise?: Promise<void>
  private error?: string

  constructor(private readonly options: CoordinatorOptions) { this.scheduler = new Scheduler({ workerSeats: options.workerSeats }) }
  status(): { status: 'running' | 'stopping' | 'degraded'; message?: string; workerSeats: number } {
    return { status: this.stopping ? 'stopping' : this.error ? 'degraded' : 'running',
      ...(this.error ? { message: this.error } : {}), workerSeats: this.scheduler.workerSeats }
  }

  setWorkerSeats(value: number): void { this.scheduler.setWorkerSeats(value); this.wake() }
  async capacity() { return this.scheduler.capacity(await this.options.tasks.list(), this.options.supervisor.live()) }

  async start(): Promise<void> {
    if (this.running) return
    this.unsubscribe = this.options.tasks.subscribe(() => this.wake())
    await this.options.tasks.archives.resumeCleanup()
    await this.recover()
    this.running = true
    this.wake()
  }
  wake(): void {
    this.dirty = true
    this.options.onChanged?.()
    if (!this.running || this.stopping || this.drainPromise) return
    this.drainPromise = Promise.resolve().then(async () => {
      while (this.dirty && !this.stopping) { this.dirty = false; await this.drain() }
    }).catch(error => this.reportError(error)).finally(() => {
      this.drainPromise = undefined
      if (this.dirty && !this.stopping) this.wake()
    })
  }
  reportError(error: unknown): void {
    this.error = error instanceof Error ? error.message : String(error)
    this.options.onError?.(error); this.options.onChanged?.()
  }

  private async command(taskId: string, input: TaskCommand): Promise<CommandReceipt> {
    const receipt = await this.options.tasks.execute(taskId, input)
    if (receipt.status === 'rejected' || receipt.status === 'stale'
      || receipt.status === 'duplicate' && (receipt.originalStatus === 'rejected' || receipt.originalStatus === 'stale')) {
      throw new Error(`${input.type}: ${receipt.code}: ${receipt.reason}`)
    }
    return receipt
  }

  private async drain(): Promise<void> {
    const snapshot = await this.options.tasks.list()
    // Stop acknowledgements are observations, never inferred from a kill request.
    for (const task of snapshot) for (const action of Object.values(task.pendingActions)) {
      if (action.kind !== 'stop' || action.status !== 'running') continue
      const execution = task.executions[action.payload.executionId ?? '']
      if (execution && ['stopped', 'lost'].includes(execution.physicalState) && execution.ownedJobIds.length === 0) {
        await this.finish(task.id, action, `Exact owner ${execution.executionId} is ${execution.physicalState} with no owned jobs.`)
      }
    }
    for (const task of snapshot) if (['completed', 'cancelled'].includes(task.phase)) {
      if (await this.options.tasks.cleanupCompleted(task.id)) {
        for (const key of this.failed.keys()) if (key.startsWith(task.id + '/')) this.failed.delete(key)
        await this.options.afterCleanup?.()
        this.options.onChanged?.()
      }
    }
    const candidates = snapshot.flatMap(task => Object.values(task.pendingActions).filter(action => action.status === 'pending').map(action => ({ task, action })))
      .sort((a, b) => priority[a.action.kind] - priority[b.action.kind] || b.task.priority - a.task.priority || a.action.createdAt.localeCompare(b.action.createdAt))
    for (const candidate of candidates) {
      if (this.stopping) return
      const key = `${candidate.task.id}/${candidate.action.id}`
      if (this.inflight.has(key) || this.failed.has(key)) continue
      const all = await this.options.tasks.list()
      const task = all.find(task => task.id === candidate.task.id)
      const action = task?.pendingActions[candidate.action.id]
      if (!task || !action || action.status !== 'pending') continue
      if (!this.scheduler.canRun(task, action, all, this.options.supervisor.live()).allowed) continue
      const attemptId = `${this.ownerId}:${action.id}:${task.revision}`
      const claim = await this.options.tasks.execute(task.id, { type: 'action.claim', commandId: `claim:${attemptId}`,
        source, actionId: action.id, ownerId: this.ownerId })
      if (claim.status !== 'applied') continue
      // Effects are independent; claims and binding commits reserve seats/resources.
      const work = this.run(task.id, action.id, attemptId).catch(error => this.actionFailed(task.id, action.id, error, attemptId).catch(error => this.reportError(error)))
        .finally(() => { this.inflight.delete(key); this.wake() })
      this.inflight.set(key, work)
    }
  }

  private async run(taskId: string, actionId: string, attemptId: string): Promise<void> {
    const task = (await this.options.tasks.get(taskId))!
    const action = task.pendingActions[actionId]!
    const current = await this.options.tasks.list()
    if (!this.scheduler.canRun(task, action, current, this.options.supervisor.live()).allowed) {
      await this.command(task.id, { type: 'action.reconcile', commandId: `defer:${attemptId}`, source,
        actionId, resolution: 'not_started', evidence: 'Admission changed before any native side effect; the action has no execution binding.' })
      return
    }
    switch (action.kind) {
      case 'plan': case 'evaluate': case 'dispatch':
        await this.options.supervisor.start(task, action)
        if (action.kind === 'dispatch') await this.finish(taskId, action, 'The exact native Agent admitted and durably flushed its stable input id.')
        break
      case 'recover': {
        const incident = task.incidents[action.payload.incidentId ?? '']
        const execution = incident && task.executions[incident.executionId]
        if (!incident || !execution) throw new Error('Recovery needs its exact saved incident and original owner.')
        if (this.options.supervisor.get(execution.executionId)) {
          if (!await this.options.supervisor.retireExecution(execution.executionId)) {
            await this.reset(taskId, action, 'The original owner still has native work; no successor was started.')
            return
          }
        } else if (!['stopped', 'lost'].includes(execution.physicalState)) {
          await this.recoverExecution(task, execution)
        }
        const current = (await this.options.tasks.get(taskId))!
        const previous = current.executions[execution.executionId]
        if (!['stopped', 'lost'].includes(previous.physicalState) || previous.ownedJobIds.length) {
          await this.reset(taskId, action, 'The exact owner has not yet settled; preserve this recovery action for native evidence.')
          return
        }
        await this.command(taskId, { type: 'recovery.restart', commandId: 'restart:' + incident.id, source,
          incidentId: incident.id, evidence: `Previous ${execution.role} ${execution.executionId} is ${previous.physicalState} with no owned jobs. Continue its saved work under the same role and assignment.` })
        break
      }
      case 'continue':
        await this.options.supervisor.continue(task, action)
        await this.finish(taskId, action, 'The existing exact owner durably admitted this bounded continuation.')
        break
      case 'stop': {
        const execution = task.executions[action.payload.executionId ?? '']
        if (!execution) throw new Error('Stop action has no exact execution owner')
        if (['stopped', 'lost'].includes(execution.physicalState) && execution.ownedJobIds.length === 0) await this.finish(taskId, action, 'Owner was already proven absent without owned jobs.')
        else await this.options.supervisor.stop(execution.executionId)
        break
      }
      case 'deliver': {
        if (!task.delivery) throw new Error('Delivery action has no saved accepted delivery')
        await this.options.tasks.prepareDelivery(task.id)
        const notificationId = await this.options.assistants.deliver(task.assistantId, task.id, task.delivery)
        await this.finish(taskId, action, 'Accepted delivery is saved and its stable foreground notification is durable.', notificationId)
        break
      }
      case 'learn':
        await this.learn(task, action)
        await this.finish(taskId, action, 'The evaluator’s saved learning proposals and bounded validation were committed.')
        break
      case 'feedback':
        await this.feedback(task, action)
        await this.finish(taskId, action, 'Actual native skill uses were matched to the saved result decisions; no-use results require no feedback.')
        break
    }
  }

  private async learn(task: Task, action: PendingAction): Promise<void> {
    const scope = { assistantId: task.assistantId, workspaceId: task.workspace.id }
    for (const [index, proposal] of (action.payload.learningProposals ?? []).entries()) {
      const report = task.reports[proposal.resultId]
      if (!report || !['accepted', 'rework'].includes(report.disposition)) throw new Error('Skill proposal needs saved accepted or rejected-result evidence')
      if (proposal.activate && report.disposition !== 'accepted') throw new Error('A failed method may create a candidate, but cannot validate an active skill')
      const commandId = `learn:${task.id}:${action.id}:${index}`
      const input = { commandId, skillId: proposal.skillId, scope,
        title: proposal.title, description: proposal.description, body: proposal.body, applicability: proposal.applicability, sourceResultId: proposal.resultId }
      const receipt = proposal.expectedVersion === undefined ? await this.options.knowledge.proposeSkill(input)
        : await this.options.knowledge.reviseSkill({ ...input, expectedVersion: proposal.expectedVersion })
      if (proposal.activate) {
        const record = await this.options.knowledge.getSkill(proposal.skillId, scope)
        const version = record?.versions.find(version => version.version === receipt.version)
        if (!version) throw new Error('Saved skill proposal disappeared before validation')
        await this.options.knowledge.validateSkill({ commandId: `${commandId}:validate`, skillId: proposal.skillId, scope,
          version: version.version, contentHash: version.contentHash, resultId: proposal.resultId,
          explanation: proposal.explanation, artifactRefs: proposal.artifactRefs })
      }
    }
  }

  private async feedback(task: Task, action: PendingAction): Promise<void> {
    const scope = { assistantId: task.assistantId, workspaceId: task.workspace.id }
    const records = await this.options.knowledge.listSkills(scope)
    for (const resultId of action.payload.resultIds ?? []) {
      const report = task.reports[resultId]
      if (!report || !['accepted', 'rework'].includes(report.disposition)) throw new Error('Feedback needs a saved result disposition')
      for (const record of records) for (const version of record.versions) {
        const use = version.uses.find(use => use.taskId === task.id && use.executionId === report.executionId)
        if (!use) continue
        await this.options.knowledge.feedback({ commandId: `feedback:${task.id}:${resultId}:${record.skillId}:${version.version}`, scope,
          skillId: record.skillId, version: version.version, observationId: use.observationId, resultId,
          outcome: report.disposition === 'accepted' ? 'success' : 'failure', explanation: action.payload.reason ?? report.summary })
      }
    }
  }

  private async finish(taskId: string, action: PendingAction, evidence: string, notificationId?: string): Promise<void> {
    await this.command(taskId, { type: 'action.finish', commandId: `finish:${action.id}:${createHash('sha256').update(evidence).digest('hex').slice(0, 12)}`, source, actionId: action.id, evidence,
      ...(notificationId ? { notificationId } : {}) })
  }

  private async actionFailed(taskId: string, actionId: string, error: unknown, attemptId: string): Promise<void> {
    const key = `${taskId}/${actionId}`
    this.failed.set(key, String(error)); this.reportError(error)
    const task = await this.options.tasks.get(taskId)
    const action = task?.pendingActions[actionId]
    if (!task || !action || !['running', 'uncertain'].includes(action.status)) return
    const execution = action.executionId ? task.executions[action.executionId] : undefined
    await this.command(taskId, { type: 'action.reconcile', commandId: `failure:${attemptId}`, source,
      actionId, resolution: 'unknown', evidence: `Runtime action failed after admission: ${String(error)}. Inspect saved/native evidence before repeating it.` })
    if (execution && execution.role !== 'helper') await this.command(taskId, { type: 'incident.open', commandId: `failure-incident:${attemptId}`, source,
      executionId: execution.executionId, operation: action.kind, message: String(error) })
  }

  /** Cold evidence precedes resume. A stored job id is never treated as a surviving job. */
  async recover(): Promise<void> {
    for (const saved of await this.options.tasks.list()) {
      if (Object.values(saved.pendingActions).some(action => action.kind === 'help' && ['pending', 'running', 'uncertain'].includes(action.status))) {
        await this.command(saved.id, { type: 'recovery.legacy', commandId: 'migrate-helper:' + saved.id, source })
      }
      const task = (await this.options.tasks.get(saved.id))!
      for (const execution of Object.values(task.executions)) {
        if (this.options.supervisor.get(execution.executionId)) continue
        try { await this.recoverExecution(task, execution) } catch (error) { this.reportError(error) }
      }
      const fresh = (await this.options.tasks.get(task.id))!
      for (const action of Object.values(fresh.pendingActions)) {
        if (!['running', 'uncertain'].includes(action.status) || action.executionId) continue
        if (action.kind === 'continue') {
          const execution = fresh.executions[action.payload.executionId ?? '']
          if (execution && await this.options.sessions.hasMessage(execution.sessionId, `servant-action-${action.id}`)) {
            await this.finish(fresh.id, action, 'Cold native Session contains the stable continuation input; it will not be injected twice.')
          }
          // An absent continuation with a live restored idle owner is safe to retry.
          else if (execution && this.options.supervisor.get(execution.executionId)) await this.reset(fresh.id, action, 'Closed native turn and empty inbox prove continuation was not admitted.')
          continue
        }
        if (action.kind === 'stop') continue
        // These adapters are individually idempotent under the action-derived stable id.
        if (['deliver', 'learn', 'feedback'].includes(action.kind)) await this.reset(fresh.id, action, 'Retry the idempotent local commit by its saved stable identity, not business execution.')
        else await this.reset(fresh.id, action, 'A persisted claim has no execution binding. Native creation always follows the binding commit.')
      }
    }
  }

  private async reset(taskId: string, action: PendingAction, evidence: string): Promise<void> {
    const current = await this.options.tasks.get(taskId)
    if (!current || !['running', 'uncertain'].includes(current.pendingActions[action.id]?.status ?? '')) return
    await this.command(taskId, { type: 'action.reconcile', commandId: `reset:${this.ownerId}:${action.id}:${current.revision}`, source, actionId: action.id, resolution: 'not_started', evidence })
    this.failed.delete(`${taskId}/${action.id}`)
  }

  private async recoverExecution(task: Task, execution: ExecutionBinding): Promise<void> {
    const originating = task.pendingActions[execution.actionId]
    const unfinishedSemantic = execution.role !== 'worker' && originating && ['running', 'uncertain'].includes(originating.status)
    const awaitingHandoff = execution.state === 'closed' && execution.childId
      && task.children[execution.childId]?.handoff?.predecessorExecutionId === execution.executionId
    // A pending handoff must reconcile the native predecessor before trusting
    // its saved shutdown state. An explicitly retired (superseded) owner already
    // has recovery evidence and does not replay stale native job registrations.
    if (execution.state !== 'active' && !unfinishedSemantic && !awaitingHandoff
      && ['stopped', 'lost'].includes(execution.physicalState) && execution.ownedJobIds.length === 0) return
    const inspection = await this.options.sessions.inspect(execution.sessionId)
    const ownership = await this.options.sessions.probeOwnership(execution.sessionId)
    if (ownership === 'busy' || inspection.liveAgent) {
      await this.uncertainExecution(task, execution, 'Another native owner or Session lease is still live; Servant will not take over its tools or jobs.')
      return
    }
    const unsettledJobs = inspection.jobs.filter(job => job.owner === execution.agentId && job.state === 'registered')
    const settledJobs = new Set(inspection.jobs.filter(job => job.owner === execution.agentId && job.state !== 'registered').map(job => job.id))
    if (execution.ownedJobIds.some(id => !settledJobs.has(id)) || unsettledJobs.length || inspection.unresolvedToolCallIds.length
      || inspection.exists && !inspection.lifecycleKnown) {
      await this.uncertainExecution(task, execution, 'Restart left unmatched native tools or job identities. The original OS side effects are not proven stopped. Inspect the actual process/artifact state; do not replay the operation.')
      return
    }
    const closedIdle = inspection.exists && inspection.lifecycleKnown && inspection.lastTurn?.closed
      && inspection.lastTurn.reason !== 'error' && !inspection.lastTurn.error
      && inspection.queuedInbox.nextTurn.length === 0 && inspection.queuedInbox.nextStep.length === 0
    const lastReport = Object.values(task.reports).filter(report => report.executionId === execution.executionId).at(-1)
    const latestTurnReported = lastReport && inspection.lastTurn?.toolCallIds.some(callId => lastReport.commandId === `tool:${execution.sessionId}:${callId}`)
    if (execution.state === 'active' && execution.role === 'worker' && closedIdle && !execution.stopRequested
      && lastReport && latestTurnReported && ['continue', 'wait'].includes(lastReport.outcome)) {
      await this.options.supervisor.restoreIdle(task, execution)
      const action = task.pendingActions[execution.actionId]
      if (action && ['running', 'uncertain'].includes(action.status) && action.kind === 'dispatch') await this.finish(task.id, action, 'Cold native report and closed inbox prove the original dispatch completed admission.')
      return
    }
    await this.command(task.id, { type: 'execution.observed', commandId: `recovery-absent:${this.ownerId}:${execution.executionId}`, source,
      executionId: execution.executionId, physicalState: 'lost', ownedJobIds: [] })
    if ((execution.state === 'active' || unfinishedSemantic) && execution.role !== 'helper') {
      await this.command(task.id, { type: 'incident.open', commandId: `cold-incident:${execution.executionId}`, source,
        executionId: execution.executionId, operation: inspection.lastTurn?.error ? 'native Agent error' : 'interrupted execution',
        message: inspection.lastTurn?.error ?? (inspection.exists
          ? 'The previous runtime ended before finishing its semantic action. Native ownership and tool/job history are settled.'
          : 'The execution binding was saved before its native Session was created.') })
    } else {
      const action = task.pendingActions[execution.actionId]
      if (action?.kind === 'dispatch' && ['running', 'uncertain'].includes(action.status) && lastReport) await this.finish(task.id, action, 'A durable terminal worker report proves dispatch occurred; the old owner is now absent.')
    }
  }

  private async uncertainExecution(task: Task, execution: ExecutionBinding, evidence: string): Promise<void> {
    await this.command(task.id, { type: 'execution.observed', commandId: `recovery-unknown:${this.ownerId}:${execution.executionId}`, source,
      executionId: execution.executionId, physicalState: 'unknown', ownedJobIds: execution.ownedJobIds })
    if (execution.role === 'helper') {
      const incident = task.incidents[execution.incidentId ?? '']
      if (incident && incident.state !== 'resolved') await this.command(task.id, { type: 'incident.open',
        commandId: `legacy-owner-uncertain:${this.ownerId}:${execution.executionId}`, source,
        executionId: incident.executionId, operation: 'historical recovery owner reconciliation',
        message: `${execution.executionId}: ${evidence}` })
      return
    }
    const action = task.pendingActions[execution.actionId]
    if (action && ['running', 'uncertain'].includes(action.status)) await this.command(task.id, { type: 'action.reconcile',
      commandId: `recovery-uncertain:${this.ownerId}:${action.id}`, source, actionId: action.id, resolution: 'unknown', evidence })
    await this.command(task.id, { type: 'incident.open', commandId: `recovery-incident:${execution.executionId}`, source,
      executionId: execution.executionId, operation: 'backend restart ownership reconciliation', message: evidence })
  }

  /** Only the authenticated human API calls this; models cannot manufacture it. */
  async attestStopped(taskId: string, executionId: string, evidence: string, commandId: string): Promise<CommandReceipt> {
    const task = await this.options.tasks.get(taskId)
    const execution = task?.executions[executionId]
    if (!task || !execution || execution.physicalState !== 'unknown') throw new Error('Only an unknown exact old execution needs this attestation')
    if (this.options.supervisor.get(executionId) || await this.options.sessions.probeOwnership(execution.sessionId) === 'busy') {
      throw new Error('An actual native owner or exclusive Session lease is still live; stop it through its owner before reconciling.')
    }
    await this.command(taskId, { type: 'execution.observed', commandId: `${commandId}:observed`, source,
      executionId, physicalState: 'lost', ownedJobIds: [] })
    const current = (await this.options.tasks.get(taskId))!
    const incident = Object.values(current.incidents).find(entry => entry.executionId === executionId && entry.state === 'open')
    const disposition = `The user confirmed this exact execution and its recorded jobs (${execution.ownedJobIds.join(', ') || 'none recorded'}) stopped; its native Session lease was free. Evidence: ${evidence}`
    if (incident && execution.role !== 'helper') return this.command(taskId, { type: 'recovery.restart',
      commandId: `${commandId}:restart`, source, incidentId: incident.id, evidence: disposition })
    return this.command(taskId, { type: 'execution.abandon', commandId: `${commandId}:retire`, source,
      executionId, evidence: disposition })
  }

  async dispose(): Promise<void> {
    this.stopping = true; this.unsubscribe?.(); this.options.onChanged?.()
    await this.drainPromise
    await Promise.allSettled([...this.inflight.values()])
  }
}
