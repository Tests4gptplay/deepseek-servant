import { createHash, randomUUID } from 'node:crypto'
import { resolveModelRoute } from '../domain/model-route.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MessageId, freezeMessage } from '@deepseek-ai/dsh-llm'
import type { Assistant } from '../contracts/assistant.ts'
import type { ExecutionBinding, PendingAction, PhysicalState, Role, RuntimeProfile, Task } from '../contracts/task.ts'
import type { TaskService } from '../application/task-service.ts'
import { TaskRecordAccess } from '../application/task-record-access.ts'
import type { KnowledgeService } from '../application/knowledge-service.ts'
import type { DshAgentGateway } from '../adapters/dsh/agents.ts'
import { installExecutionGuard } from '../adapters/dsh/agents.ts'
import type { OwnedDshAgent } from '../adapters/dsh/host-types.ts'
import { installSkillProvider } from '../adapters/dsh/skills.ts'
import { roleInput, type SemanticRole } from '../roles/prompts.ts'
import { assembleRoleInput } from './context-assembler.ts'

export interface RoleBinding {
  assistantId: string
  sessionId: string
  role: SemanticRole
  taskId?: string
  executionId?: string
}
export interface SupervisorOptions {
  gateway: DshAgentGateway
  tasks: TaskService
  knowledge: KnowledgeService
  defaults: RuntimeProfile
  workerCapacity?(): Promise<import('./scheduler.js').WorkerCapacity>
  setupRole(ctx: Context, agent: Agent, binding: RoleBinding): void | Promise<void>
  onChanged?(): void
  onForegroundChanged?(assistantId: string, sessionId: string): void
  recentExchanges?(assistantId: string): Promise<import('../contracts/assistant.js').ConversationMessage[][]>
  onError(error: unknown): void
}
interface OwnedExecution { taskId: string; executionId: string; handle: OwnedDshAgent; unsubscribe: () => void }
function hasPendingInput(handle: OwnedDshAgent): boolean {
  return handle.actualAgent.inbox.nextTurn.length > 0 || handle.actualAgent.inbox.nextStep.length > 0
}
const unsupervisedTools = new Set(['subagent', 'subagent_fork', 'send_message', 'interrupt_agent',
  'workflow', 'schedule_create', 'schedule_list', 'schedule_delete', 'schedule_update', 'create_goal', 'update_goal'])

/** Owns native handles independently of the Client and of each Planner turn. */
export class AgentSupervisor {
  private readonly owners = new Map<string, OwnedExecution>()
  private readonly foreground = new Map<string, OwnedDshAgent>()
  private readonly foregroundRoutes = new Map<string, string>()
  private readonly foregroundOpening = new Map<string, Promise<OwnedDshAgent>>()
  private readonly foregroundSubscriptions = new Map<string, () => void>()
  private readonly observationChains = new Map<string, Promise<void>>()
  private readonly observationAgain = new Set<string>()
  private readonly watches = new Map<string, Promise<void>>()
  private readonly watchAgain = new Set<string>()
  private readonly releases = new Map<string, Promise<boolean>>()
  private stopping = false

  constructor(private readonly options: SupervisorOptions) {}

  live(): ReadonlyMap<string, { state: PhysicalState | 'waiting'; ownedJobIds: string[] }> {
    return new Map([...this.owners].map(([id, owner]) => {
      const observation = owner.handle.observe()
      return [id, { state: observation.state === 'idle' && hasPendingInput(owner.handle) ? 'running' : observation.state, ownedJobIds: observation.jobs.filter(job => job.status === 'running' || job.status === 'stopping').map(job => job.id) }]
    }))
  }
  get(executionId: string): OwnedDshAgent | undefined { return this.owners.get(executionId)?.handle }

  async observeExecution(executionId: string): Promise<void> {
    const owner = this.owners.get(executionId)
    if (owner) await this.observe(owner)
  }

  async ensureForeground(assistant: Assistant): Promise<OwnedDshAgent> {
    if (this.stopping) throw new Error('Servant is stopping')
    const opening = this.foregroundOpening.get(assistant.id)
    if (opening) return opening
    const cached = this.foreground.get(assistant.id)
    const route = JSON.stringify(resolveModelRoute(assistant.settings.foreground, assistant.autoModel))
    if (cached?.sessionId === assistant.sessionId && this.foregroundRoutes.get(assistant.id) === route) return cached
    if (cached) await this.releaseForegroundIfIdle(assistant)
    const work = this.openForeground(assistant).finally(() => this.foregroundOpening.delete(assistant.id))
    this.foregroundOpening.set(assistant.id, work)
    return work
  }

  /** Resume a cold foreground input on its original native Session and user identity. */
  async resumeForeground(assistant: Assistant, messageId: string): Promise<void> {
    const cold = !this.foreground.has(assistant.id) && !this.options.gateway.hasLiveOwner(assistant.sessionId)
    const handle = await this.ensureForeground(assistant)
    if (!cold || handle.observe().state !== 'idle' || hasPendingInput(handle)) return
    const agent = handle.actualAgent
    const ended = agent.session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1)
    if (ended?.type !== 'turn/end') return
    const reason = ended.data.reason
    if (reason.kind !== 'interrupted' && !(reason.kind === 'aborted' && ['disposed', 'parent'].includes(reason.reason.kind))) return
    const id = 'servant-resume:' + messageId + ':' + ended.seq
    if (handle.hasMessage(id)) return
    agent.followup(freezeMessage({ id: MessageId(id), role: 'user',
      source: { kind: 'deepseek-servant-resume', messageId },
      content: [{ type: 'text', text: 'The host interrupted this conversation. Continue the original pending input using the saved conversation and Task state. Reconcile any existing task submission before submitting work again, then finish the reply.' }] }))
    await agent.ctx.sessions.flush(agent.session)
  }

  /** Settings cannot silently change the environment of an in-flight turn. */
  async releaseForegroundIfIdle(assistant: Pick<Assistant, 'id'>): Promise<void> {
    await this.foregroundOpening.get(assistant.id)
    const handle = this.foreground.get(assistant.id)
    if (!handle) return
    const state = handle.observe()
    if (state.state === 'running' || state.jobs.some(job => job.status === 'running' || job.status === 'stopping') || hasPendingInput(handle)) {
      throw new Error('前台正在处理消息，请等本轮结束后再更换工作区或前台模型。后台任务保持其创建时的配置。')
    }
    await handle.dispose()
    this.foregroundSubscriptions.get(assistant.id)?.()
    this.foregroundSubscriptions.delete(assistant.id)
    this.foreground.delete(assistant.id)
    this.foregroundRoutes.delete(assistant.id)
  }

  /** Retirement is gated by actual native ownership, not a timeout. */
  async retireForeground(assistant: Assistant): Promise<boolean> {
    await this.foregroundOpening.get(assistant.id)
    const handle = this.foreground.get(assistant.id)
    if (!handle) return !this.options.gateway.hasLiveOwner(assistant.sessionId)
    if (handle.sessionId !== assistant.sessionId) return false
    const state = handle.observe()
    if (state.state === 'running' || state.jobs.some(job => job.status === 'running' || job.status === 'stopping')
      || hasPendingInput(handle)) return false
    await this.releaseForegroundIfIdle(assistant)
    return true
  }

  async cancelForeground(assistant: Assistant): Promise<boolean> {
    await this.foregroundOpening.get(assistant.id)
    const handle = this.foreground.get(assistant.id)
    if (!handle) return !this.options.gateway.hasLiveOwner(assistant.sessionId)
    if (handle.sessionId !== assistant.sessionId) return false
    await handle.cancel()
    await handle.whenIdle()
    const state = handle.observe()
    if (state.state === 'running' || state.jobs.some(job => job.status === 'running' || job.status === 'stopping')) return false
    // The owner explicitly discarded this conversation, including its pending foreground inbox.
    await handle.dispose()
    this.foregroundSubscriptions.get(assistant.id)?.()
    this.foregroundSubscriptions.delete(assistant.id)
    this.foreground.delete(assistant.id); this.foregroundRoutes.delete(assistant.id)
    return true
  }

  private async openForeground(assistant: Assistant): Promise<OwnedDshAgent> {
    const binding: RoleBinding = { assistantId: assistant.id, sessionId: assistant.sessionId, role: 'foreground' }
    const handle = await this.options.gateway.create({
      sessionId: assistant.sessionId, cwd: assistant.workspace.directory, role: 'foreground',
      model: resolveModelRoute(assistant.settings.foreground, assistant.autoModel), presetId: assistant.settings.presetId,
      resume: await this.options.gateway.exists(assistant.sessionId),
      recentExchanges: await this.options.recentExchanges?.(assistant.id),
      setup: async (ctx, agent) => {
        await this.options.setupRole(ctx, agent, binding)
        const visible = ctx.tools.schemas().map(tool => tool.name).filter(name => unsupervisedTools.has(name))
        if (visible.length) ctx.tools.restrict({ deny: visible })
        installSkillProvider(ctx, agent, this.options.knowledge, { assistantId: assistant.id, workspaceId: assistant.workspace.id })
        // Native preset tools retain their Host permissions; managed work stays on the Task path.
        installExecutionGuard(ctx, agent, (_owner, name) => !unsupervisedTools.has(name))
      },
    })
    if (this.stopping) { await handle.dispose(); throw new Error('Servant stopped while opening foreground') }
    this.foreground.set(assistant.id, handle)
    this.foregroundRoutes.set(assistant.id, JSON.stringify(resolveModelRoute(assistant.settings.foreground, assistant.autoModel)))
    this.foregroundSubscriptions.set(assistant.id, handle.subscribe(() => {
      if (!this.stopping) this.options.onForegroundChanged?.(assistant.id, handle.sessionId)
      this.options.onChanged?.()
    }, true))
    return handle
  }

  async start(task: Task, action: PendingAction): Promise<void> {
    if (this.stopping) throw new Error('Servant is stopping')
    if (!['dispatch', 'plan', 'evaluate'].includes(action.kind)) throw new Error('Only Worker and Planner actions create native Agents.')
    const role = action.kind === 'dispatch' ? 'worker' as const : 'planner' as const
    const identity = createHash('sha256').update(`${task.id}\0${action.id}\0${action.payload.predecessorExecutionId ?? ''}`).digest('hex').slice(0, 32)
    const executionId = `servant-exec-${identity}`
    const sessionId = `servant-${role}-${identity}`
    const profile = task.runtimeProfile ?? this.options.defaults
    const bind = await this.options.tasks.execute(task.id, {
      type: 'execution.bind', commandId: `bind:${executionId}`, source: { kind: 'runtime', id: 'deepseek-servant' },
      actionId: action.id, executionId, agentId: sessionId, sessionId, role,
      model: JSON.stringify(profile.background), configurationVersion: profile.version,
    })
    if (bind.status !== 'applied' && bind.status !== 'duplicate') throw new Error(`Execution binding refused: ${bind.reason}`)
    const existing = this.owners.get(executionId)
    if (existing) {
      const current = (await this.options.tasks.get(task.id))!
      // The adapter deduplicates the stable id and rechecks its persistence barrier.
      await this.sendWork(existing, current, action)
      this.requestObservation(existing); this.watch(existing)
      return
    }
    // An existing Session at this point is an interrupted launch, not permission to replay it.
    if (await this.options.gateway.exists(sessionId)) throw new Error(`Execution already has a native Session and needs reconciliation: ${sessionId}`)
    const current = (await this.options.tasks.get(task.id))!
    const owner = await this.openOwner(current, current.executions[executionId]!, false)
    await this.sendWork(owner, current, action)
    await this.observe(owner)
    this.watch(owner)
  }

  private async sendWork(owner: OwnedExecution, task: Task, action: PendingAction): Promise<void> {
    const prompt = await this.prompt(task, action, task.executions[owner.executionId]!)
    const latest = await this.options.tasks.get(task.id)
    if (!latest || latest.control === 'cancelled' || latest.executions[owner.executionId]?.stopRequested) {
      await this.forceStopTasks([task.id])
      return
    }
    await owner.handle.send(prompt, `servant-action-${action.id}`, 'followup', 'deepseek-servant')
  }

  /** Only the recovery classifier may call this after proving a closed native turn and empty inbox. */
  async restoreIdle(task: Task, execution: ExecutionBinding): Promise<void> {
    if (this.owners.has(execution.executionId)) return
    const owner = await this.openOwner(task, execution, true)
    await this.observe(owner)
  }

  private async openOwner(task: Task, execution: ExecutionBinding, resume: boolean): Promise<OwnedExecution> {
    const { executionId, sessionId, role } = execution
    if (role === 'helper') throw new Error('Historical Helper records are retained; recovery opens the original Worker or Planner.')
    const profile = task.runtimeProfile ?? this.options.defaults
    const binding: RoleBinding = { assistantId: task.assistantId, taskId: task.id, executionId, sessionId, role }
    const handle = await this.options.gateway.create({
      sessionId, cwd: task.workspace.directory, role, model: profile.background, presetId: profile.presetId, resume,
      setup: async (ctx, agent) => {
        await this.options.setupRole(ctx, agent, binding)
        const visible = ctx.tools.schemas().map(tool => tool.name).filter(name => unsupervisedTools.has(name))
        if (visible.length) ctx.tools.restrict({ deny: visible })
        installSkillProvider(ctx, agent, this.options.knowledge, {
          assistantId: task.assistantId, workspaceId: task.workspace.id, taskId: task.id, executionId,
        })
        installExecutionGuard(ctx, agent, async (_owner, toolName) => {
          // Delegating outside this supervisor would create untracked owners
          // that survive the parent binding fence. Servant plans its own children.
          if (unsupervisedTools.has(toolName)) return false
          const current = await this.options.tasks.get(task.id)
          const execution = current?.executions[executionId]
          if (!current || !execution || execution.state !== 'active' || execution.stopRequested) return false
          if (current.control === 'cancelled') return toolName === 'execution_report'
          if (current.control === 'paused') return ['execution_report', 'execution_wait', 'task_query', 'memory_query', 'planning_checkpoint', 'planning_decide'].includes(toolName)
          return true
        })
      },
    })
    const owner: OwnedExecution = { taskId: task.id, executionId, handle, unsubscribe: () => undefined }
    this.owners.set(executionId, owner)
    owner.unsubscribe = handle.subscribe(() => this.requestObservation(owner))
    return owner
  }

  async continue(task: Task, action: PendingAction): Promise<void> {
    const id = action.payload.executionId
    const owner = id && this.owners.get(id)
    if (!owner || !id) throw new Error('Cannot continue an execution without its exact live owner')
    await this.sendWork(owner, task, action)
    await this.observe(owner)
    this.watch(owner)
  }

  async stop(executionId: string): Promise<void> {
    const owner = this.owners.get(executionId)
    if (!owner) throw new Error('No live owner is available; stopped state requires recovery evidence')
    await owner.handle.cancel()
    await this.observe(owner)
    this.watch(owner)
  }

  /** Emergency stop uses native cancellation and disposal, not another model turn. */
  async forceStopTasks(taskIds: readonly string[]): Promise<void> {
    const selected = new Set(taskIds)
    const results = await Promise.allSettled([...this.owners.values()].filter(owner => selected.has(owner.taskId)).map(async owner => {
      const releasing = this.releases.get(owner.executionId)
      if (releasing) { await releasing; if (this.owners.get(owner.executionId) !== owner) return }
      const work = (async () => {
        try { await owner.handle.cancel() } finally { await owner.handle.dispose() }
        owner.unsubscribe()
        this.owners.delete(owner.executionId)
        await this.options.tasks.execute(owner.taskId, { type: 'execution.observed', commandId: `reset-stop:${randomUUID()}`,
          source: { kind: 'runtime', id: 'deepseek-servant' }, executionId: owner.executionId, physicalState: 'stopped', ownedJobIds: [] })
        return true
      })().finally(() => this.releases.delete(owner.executionId))
      this.releases.set(owner.executionId, work)
      await work
    }))
    this.options.onChanged?.()
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (errors.length) throw new AggregateError(errors, '部分后台执行未能停止，任务状态已保留，请查看具体错误后重试。')
  }

  /** Release this exact owned runtime once its turn and jobs have settled. */
  async retireExecution(executionId: string): Promise<boolean> {
    const owner = this.owners.get(executionId)
    return owner ? this.release(owner) : false
  }

  private async prompt(task: Task, action: PendingAction, execution: ExecutionBinding): Promise<string> {
    if (execution.role === 'helper') throw new Error('Historical recovery roles have no executable prompt.')
    const knowledge = await this.options.knowledge.list({ assistantId: task.assistantId, workspaceId: task.workspace.id })
    const records = new TaskRecordAccess(this.options.tasks, { assistantId: task.assistantId, taskId: task.id, role: execution.role,
      executionId: execution.executionId, agentId: execution.agentId, sessionId: execution.sessionId })
    return roleInput(execution.role, { ...assembleRoleInput(task, execution, action, knowledge.filter(record => record.kind !== 'skill')),
      directRecords: await records.context(task, execution),
      ...(execution.role === 'planner' && this.options.workerCapacity ? { workerCapacity: await this.options.workerCapacity() } : {}) })
  }

  private requestObservation(owner: OwnedExecution): void {
    if (this.stopping || this.owners.get(owner.executionId) !== owner) return
    const prior = this.observationChains.get(owner.executionId)
    if (prior) { this.observationAgain.add(owner.executionId); return }
    const work = Promise.resolve().then(async () => {
      do {
        this.observationAgain.delete(owner.executionId)
        await this.observe(owner)
      } while (this.observationAgain.has(owner.executionId) && !this.stopping && this.owners.get(owner.executionId) === owner)
    }).catch(error => this.options.onError(error))
      .finally(() => {
        this.observationChains.delete(owner.executionId)
        // Native status, inbox and Job events re-arm completion; no polling.
        if (!this.stopping && this.owners.get(owner.executionId) === owner) this.watch(owner)
      })
    this.observationChains.set(owner.executionId, work)
  }

  private watch(owner: OwnedExecution): void {
    if (this.stopping || this.owners.get(owner.executionId) !== owner) return
    if (this.watches.has(owner.executionId)) { this.watchAgain.add(owner.executionId); return }
    const work = owner.handle.whenIdle().then(async () => {
      if (this.stopping || this.owners.get(owner.executionId) !== owner) return
      await this.observe(owner)
      const task = await this.options.tasks.get(owner.taskId)
      const binding = task?.executions[owner.executionId]
      if (!task || !binding || this.stopping || this.owners.get(owner.executionId) !== owner) return
      const observation = owner.handle.observe()
      if (!['idle', 'stopped'].includes(observation.state) || hasPendingInput(owner.handle)
        || observation.jobs.some(job => job.status === 'running' || job.status === 'stopping')) return
      if (binding.stopRequested || binding.state !== 'active') {
        await this.release(owner)
        return
      }
      if (observation.error) {
        await this.incident(owner, 'native Agent error', observation.error.message)
        return
      }
      const waiting = Object.values(task.waits).some(wait => wait.executionId === binding.executionId && wait.state === 'waiting')
        || Object.values(task.incidents).some(incident => incident.executionId === binding.executionId && incident.state !== 'resolved')
        || Object.values(task.pendingActions).some(action => ['pending', 'running'].includes(action.status)
          && ((action.kind === 'continue' && action.payload.executionId === binding.executionId)
            || (action.kind === 'evaluate' && (action.payload.resultIds ?? []).some(id => task.reports[id]?.executionId === binding.executionId))))
      if (!waiting && task.control === 'running') {
        await this.incident(owner, 'missing execution report', 'The native Agent became idle without its required bounded report. Inspect its actual Session and artifacts, then repair the same work frontier.')
      }
    }).catch(error => this.options.onError(error)).finally(() => {
      this.watches.delete(owner.executionId)
      if (this.watchAgain.delete(owner.executionId) && !this.stopping && this.owners.get(owner.executionId) === owner) this.watch(owner)
    })
    this.watches.set(owner.executionId, work)
  }

  private async observe(owner: OwnedExecution): Promise<void> {
    if (this.stopping || this.owners.get(owner.executionId) !== owner) return
    const task = await this.options.tasks.get(owner.taskId)
    if (this.stopping || this.owners.get(owner.executionId) !== owner) return
    const binding = task?.executions[owner.executionId]
    if (!task || !binding) return
    const observation = owner.handle.observe()
    const jobs = observation.jobs.filter(job => job.status === 'running' || job.status === 'stopping')
    const physicalState: PhysicalState = observation.state === 'waiting' ? 'idle' : observation.state
    const ownedJobIds = jobs.map(job => job.id).sort()
    if (binding.physicalState !== physicalState || JSON.stringify([...binding.ownedJobIds].sort()) !== JSON.stringify(ownedJobIds)) {
      await this.options.tasks.execute(task.id, { type: 'execution.observed', commandId: `observe:${randomUUID()}`,
        source: { kind: 'runtime', id: 'deepseek-servant' }, executionId: binding.executionId, physicalState, ownedJobIds })
    }
    for (const wait of Object.values(task.waits)) {
      if (wait.state !== 'waiting' || wait.kind !== 'job' || wait.executionId !== binding.executionId) continue
      const job = observation.jobs.find(job => job.id === wait.jobId)
      if (job && job.status !== 'running' && job.status !== 'stopping') {
        await this.options.tasks.execute(task.id, { type: 'wait.resolve', commandId: `job-observed:${wait.id}:${job.id}:${job.status}:${task.revision}`,
          source: { kind: 'runtime', id: 'deepseek-servant' }, waitId: wait.id, evidence: `Exact owner ${binding.sessionId} observed job ${job.id} in ${job.status} state.` })
      }
    }
    if (observation.state === 'idle' && jobs.length === 0 && (binding.state !== 'active' || binding.stopRequested)) await this.release(owner)
    this.options.onChanged?.()
  }

  private async incident(owner: OwnedExecution, operation: string, message: string): Promise<void> {
    if (this.stopping) return
    const task = await this.options.tasks.get(owner.taskId)
    const execution = task?.executions[owner.executionId]
    if (!execution || execution.role === 'helper' || this.owners.get(owner.executionId) !== owner) return
    if (Object.values(task!.incidents).some(entry => entry.executionId === owner.executionId && entry.state !== 'resolved'
      && entry.errors.some(error => error.operation === operation && error.message === message))) return
    await this.options.tasks.execute(owner.taskId, { type: 'incident.open', commandId: `incident:${owner.executionId}:${task?.revision}:${createHash('sha256').update(operation + message).digest('hex').slice(0, 16)}`,
      source: { kind: 'runtime', id: 'deepseek-servant' }, executionId: owner.executionId, operation, message })
  }

  private async release(owner: OwnedExecution): Promise<boolean> {
    const currentRelease = this.releases.get(owner.executionId)
    if (currentRelease) return currentRelease
    if (this.owners.get(owner.executionId) !== owner) return true
    // Earlier observation/command writes may have yielded. Recheck the actual
    // handle immediately before disposal so a normal handoff never kills jobs.
    const observation = owner.handle.observe()
    if (!['idle', 'stopped'].includes(observation.state) || hasPendingInput(owner.handle)
      || observation.jobs.some(job => job.status === 'running' || job.status === 'stopping')) return false
    const work = (async () => {
      await owner.handle.dispose()
      owner.unsubscribe()
      this.owners.delete(owner.executionId)
      await this.options.tasks.execute(owner.taskId, { type: 'execution.observed', commandId: `released:${owner.executionId}`,
        source: { kind: 'runtime', id: 'deepseek-servant' }, executionId: owner.executionId, physicalState: 'stopped', ownedJobIds: [] })
      return true
    })().finally(() => this.releases.delete(owner.executionId))
    this.releases.set(owner.executionId, work)
    return work
  }

  async dispose(): Promise<void> {
    this.stopping = true
    await Promise.allSettled([...this.foregroundOpening.values()])
    for (const unsubscribe of this.foregroundSubscriptions.values()) unsubscribe()
    const results = await Promise.allSettled([...this.owners.values()].map(async owner => {
      if (this.releases.has(owner.executionId)) { await this.releases.get(owner.executionId); return }
      try { await owner.handle.cancel() }
      finally { try { await owner.handle.dispose() } finally { owner.unsubscribe() } }
      await this.observationChains.get(owner.executionId)
      await this.watches.get(owner.executionId)
      // Closing the Host interrupts execution; it does not cancel the user's goal.
      await this.options.tasks.execute(owner.taskId, { type: 'execution.observed', commandId: `shutdown:${randomUUID()}`,
        source: { kind: 'runtime', id: 'deepseek-servant' }, executionId: owner.executionId, physicalState: 'lost', ownedJobIds: [] })
    }))
    results.push(...await Promise.allSettled([...this.foreground.values()].map(handle => handle.dispose())))
    results.push(...await Promise.allSettled([...this.observationChains.values(), ...this.watches.values()]))
    this.owners.clear(); this.foreground.clear(); this.foregroundSubscriptions.clear()
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (errors.length) throw new AggregateError(errors, 'Servant owners could not all close cleanly')
  }
}
