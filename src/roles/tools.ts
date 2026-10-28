import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { assistantRuntimeProfile } from '../domain/model-route.ts'
import { deriveEventMessage, isAppendSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { z } from 'zod'
import type { AssistantService } from '../application/assistant-service.ts'
import type { TaskService } from '../application/task-service.ts'
import { TaskRecordAccess } from '../application/task-record-access.ts'
import type { KnowledgeService } from '../application/knowledge-service.ts'
import type { CommandReceipt, CommandSource, TaskCommand } from '../contracts/task.ts'
import { ArtifactSchema, BacklogSchema, ChildSchema, DecisionSchema, GoalSchema, Id, MemorySchema, ProposalSchema, ReportSchema, Text, WaitSchema, toolParameters } from '../contracts/schemas.ts'
import type { RoleBinding } from '../runtime/agent-supervisor.ts'
import { assembleRoleInput, memoryRef } from '../runtime/context-assembler.ts'
import type { Task } from '../contracts/task.ts'
import { rolePrompt } from './prompts.ts'
import { ForegroundDocument, foregroundMemoryGuide } from '../contracts/foreground-memory.js'

export interface RoleToolsOptions {
  assistants: AssistantService
  tasks: TaskService
  knowledge: KnowledgeService
  memoryQuery(taskId: string, input: { ref: string; offset?: number; limit?: number }, executionId?: string): Promise<unknown>
}
type BoundCommand<T = TaskCommand> = T extends unknown ? Omit<T, 'source' | 'commandId'> : never

/** Capabilities and sources are bound to the real scoped native Agent. */
export function installRoleTools(ctx: Context, agent: Agent, binding: RoleBinding, options: RoleToolsOptions): void {
  ctx.systemPrompt.section({ name: 'deepseek-servant:role', order: 100, text: rolePrompt(binding.role), interpolate: false })
  ctx.systemPrompt.section({ name: 'deepseek-servant:ownership', order: 102, interpolate: false,
    text: 'Servant owns this Agent lifecycle. Use its task/plan/report tools for goals and continuations. Do not call create_goal, update_goal, subagent, subagent_fork, workflow, schedule_* or cross-Agent messaging: they would create execution outside the saved Servant ownership. Ask the Planner for bounded Children when parallel work is useful.' })
  const records = new TaskRecordAccess(options.tasks, { ...binding, agentId: agent.id })
  const latestUser = () => {
    const events = agent.session.snapshotEvents()
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!
      if (event.type === 'turn/start') break
      if (!isAppendSurfaceEvent(event)) continue
      const admitted = deriveEventMessage(event)
      if (admitted?.role === 'user' && admitted.source.kind === 'user') return admitted
      if (admitted?.source.kind === 'deepseek-servant-resume') {
        const originalId = admitted.source.messageId
        for (let previous = index - 1; previous >= 0; previous--) {
          const originalEvent = events[previous]!
          if (!isAppendSurfaceEvent(originalEvent)) continue
          const original = deriveEventMessage(originalEvent)
          if (original?.id === originalId && original.role === 'user' && original.source.kind === 'user') return original
        }
      }
    }
    return undefined
  }
  if (binding.role === 'foreground') ctx.systemPrompt.section({ name: 'deepseek-servant:source', order: 101, interpolate: false,
    text: `Servant assistantId=${binding.assistantId}. User-intent tools bind their source to the actual user input consumed in this native turn. Omit sourceMessageId; never invent an input identity. Background notifications are facts for delivery, never new user authorization.` })

  const register = <T extends z.ZodType>(name: string, description: string, schema: T,
    run: (input: z.infer<T>, exec: ToolRunContext) => Promise<unknown>) => {
    ctx.tools.register({ name, description, parameters: toolParameters(schema),
      output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (input, exec) => {
        if (exec.agent !== agent) throw new Error('Servant tool called by an unbound Agent')
        exec.signal.throwIfAborted()
        return JSON.parse(JSON.stringify(await run(schema.parse(input), exec)))
      },
    })
  }
  if (binding.role === 'foreground') {
    const prefix = 'foreground-memory/' + encodeURIComponent(binding.assistantId) + '/'
    ctx.systemPrompt.section({ name: 'deepseek-servant:foreground-memory', order: 103, interpolate: false,
      text: foregroundMemoryGuide(prefix + 'Foreground_List', prefix + 'Foreground_Cache',
        'These are storage references; read with foreground_memory action=read. Keep task record references from memory_search for memory_read, and artifact file paths separately. action=replace rewrites the whole document; action=clear removes its current contents.') })
    register('foreground_memory', 'Read or rewrite the Foreground’s important-assignment index or editable conversation scratch space.',
      z.object({ action: z.enum(['read', 'replace', 'clear']), document: ForegroundDocument,
        text: z.string().describe('Required for replace: complete replacement text, preserving existing memories unless the user requested their removal. Use empty text only for a user-requested clear.').optional(),
      }).refine(input => input.action !== 'replace' || input.text !== undefined, { message: 'Replacement text is required for action=replace.', path: ['text'] }), input => options.assistants.foregroundMemory(binding.assistantId, input.document, input.action === 'read' ? undefined : input.action === 'clear' ? '' : input.text))
    register('conversation_search', 'Search dated original conversations; returns excerpts, message identities and exact references.',
      z.strictObject({ query: z.string().min(1), cursor: z.int().nonnegative().optional(), limit: z.int().min(1).max(50).optional() }),
      input => options.assistants.conversations.search(binding.assistantId, input.query, input.cursor, input.limit))
    register('conversation_read', 'Read original conversation text from an exact reference, with a continuation cursor.',
      z.strictObject({ ref: z.string().min(1), cursor: z.int().nonnegative().optional(), limit: z.int().min(1).max(262144).optional() }),
      input => options.assistants.conversations.read(binding.assistantId, input.ref, input.cursor, input.limit))
  }
  const roleSource = (): CommandSource => {
    if (!binding.executionId) throw new Error('This role has no execution authority')
    return { kind: 'agent', id: agent.id, role: binding.role, executionId: binding.executionId, sessionId: binding.sessionId }
  }
  const userSource = (messageId?: string): CommandSource & { kind: 'user'; messageId: string } => {
    const user = latestUser()
    if (!user || (messageId !== undefined && user.id !== messageId)) throw new Error('This native turn has no matching user input for the requested intent')
    return { kind: 'user', id: `servant:${binding.assistantId}`, sessionId: binding.sessionId, messageId: user.id }
  }
  const currentTask = async (taskId = binding.taskId) => {
    if (!taskId) throw new Error('taskId is required')
    if (binding.role !== 'foreground' && taskId !== binding.taskId) throw new Error('This role may only access its bound task')
    const task = await options.tasks.get(taskId)
    if (!task || task.assistantId !== binding.assistantId) throw new Error('Task is not owned by this assistant')
    return task
  }
  const commit = async (exec: ToolRunContext, command: BoundCommand, terminal = true) => {
    const task = await currentTask()
    const receipt = await options.tasks.execute(task.id, { ...command, commandId: `tool:${binding.sessionId}:${exec.callId}`, source: roleSource() } as TaskCommand)
    if (terminal && accepted(receipt)) exec.concludeTurn()
    return receipt
  }

  register('task_query', 'Read a task by taskId, or page this assistant’s task summaries. Follow nextCursor to reach all tasks.', z.strictObject({
    taskId: Id.optional(), cursor: z.int().nonnegative().optional().describe('Task-list cursor; omitted starts at zero.'),
    limit: z.int().min(1).max(100).optional().describe('Tasks per page; default 50.'),
  }), async input => {
    if (binding.role === 'foreground' && !input.taskId) {
      const tasks = (await options.tasks.list()).filter(task => task.assistantId === binding.assistantId)
        .sort((a, b) => Number(['completed', 'cancelled'].includes(a.phase)) - Number(['completed', 'cancelled'].includes(b.phase)) || b.updatedAt.localeCompare(a.updatedAt))
      const start = input.cursor ?? 0, end = Math.min(tasks.length, start + (input.limit ?? 50))
      return { tasks: tasks.slice(start, end).map(taskSummary), total: tasks.length, ...(end < tasks.length ? { nextCursor: end } : {}) }
    }
    const task = await currentTask(input.taskId)
    if (binding.role === 'foreground') return taskSummary(task)
    const execution = task.executions[binding.executionId!]
    if (!execution) throw new Error('Bound execution no longer exists')
    return { ...assembleRoleInput(task, execution, task.pendingActions[execution.actionId]!), directRecords: await records.context(task, execution) }
  })
  register('memory_query', 'Read referenced task history pages. Large pages return JSON text fragments with a continuation cursor.',
    z.strictObject({ taskId: Id.optional(), ref: z.string().min(1), offset: z.int().nonnegative().optional(), limit: z.int().min(1).max(50).optional(), characterOffset: z.int().nonnegative().optional() }),
    async input => options.memoryQuery((await currentTask(input.taskId)).id, input, binding.executionId))
  register('memory_read', 'Read an exact saved record as text pages, including original requirements, decisions and Child replies.',
    z.strictObject({ ref: z.string().min(1).describe('Exact dss-record:// or servant-memory:// reference from a record tool, current context or saved index.'),
      cursor: z.int().nonnegative().optional().describe('Character cursor; omitted starts at zero.'),
      limit: z.int().min(1).max(32768).optional().describe('Characters per page; default 8192.') }),
    async input => records.read(input.ref, input.cursor, input.limit))
  register('memory_search', 'Find full-text records or list their exact read references. Omit query to page the record index.',
    z.strictObject({ taskId: Id.optional(), kind: z.enum(['planner-memory', 'planner-note', 'worker-reply', 'task-origin']),
      childId: Id.optional().describe('Child for worker-reply; Workers default to their own assignment.'),
      query: Text.optional(), cursor: z.int().nonnegative().optional(), limit: z.int().min(1).max(100).optional().describe('Entries per page; default 20.') }),
    async input => {
      const task = await currentTask(input.taskId)
      const childId = input.childId ?? task.executions[binding.executionId!]?.childId
      return records.page({ kind: input.kind, taskId: task.id, ...(input.kind === 'worker-reply' ? { childId } : {}) }, input.query, input.cursor, input.limit)
    })
  register('task_origin_read', 'Page the complete original user requirement and its revision history; each entry includes an exact text reference.',
    z.strictObject({ taskId: Id.optional(), cursor: z.int().nonnegative().optional(), limit: z.int().min(1).max(100).optional() }),
    async input => records.page({ kind: 'task-origin', taskId: (await currentTask(input.taskId)).id }, undefined, input.cursor, input.limit))
  if (binding.role === 'planner' || binding.role === 'foreground') {
    register('planner_note_read', 'Read the current planning note body or its explicit future-work index, including its revision for the next write.',
      z.strictObject({ taskId: Id.optional(), part: z.enum(['body', 'backlog']).optional(),
        cursor: z.int().nonnegative().optional(), limit: z.int().min(1).max(32768).optional().describe('Body: characters, default 8192, max 32768. Backlog: entries, default 20, max 100.') }),
      async input => records.note((await currentTask(input.taskId)).id, input.part, input.cursor, input.limit))
  }
  if (binding.role === 'planner') {
    register('planner_memory_append', 'Append full planning reasoning, evidence, failed approaches or a continuation frontier to this Task.',
      z.strictObject({ text: Text }), async (input, exec) => records.append('planner-memory', input.text, `tool:${binding.sessionId}:${exec.callId}`))
    register('planner_note_write', 'Save the complete current planning note and future-work index, keeping all prior versions.',
      z.strictObject({ expectedRevision: z.int().nonnegative(), body: Text, frontier: Text, changeSummary: Text,
        backlog: z.array(BacklogSchema).describe('All current future stages, including delayed required work, dependencies and triggers. Empty when there is no future work.') }),
      async (input, exec) => commit(exec, { type: 'planning.checkpoint', expectedGoalRevision: (await currentTask()).goal.revision,
        summary: input.changeSummary, frontier: input.frontier, memory: { planNote: input } }, false))
  }
  if (binding.role === 'worker' || binding.role === 'planner' || binding.role === 'foreground') {
    register('child_reply_read', 'Page saved work and full reply references for a Child across its generations.',
      z.strictObject({ taskId: Id.optional(), childId: Id.optional(), cursor: z.int().nonnegative().optional(), limit: z.int().min(1).max(100).optional() }),
      async input => {
        const task = await currentTask(input.taskId)
        return records.page({ kind: 'worker-reply', taskId: task.id, childId: input.childId ?? task.executions[binding.executionId!]?.childId }, undefined, input.cursor, input.limit)
      })
  }
  if (binding.role === 'worker') register('child_reply_append', 'Append complete work details, failures, artifacts or checkpoint notes to your Child. Use execution_report for work-segment status.',
    z.strictObject({ text: Text }), async (input, exec) => records.append('worker-reply', input.text, `tool:${binding.sessionId}:${exec.callId}`))
  register('knowledge_query', 'List evidence-backed scoped facts and skill metadata. Use native skill to load skill bodies.', z.strictObject({}), async () => {
    const assistant = await options.assistants.get(binding.assistantId)
    const task = binding.taskId ? await currentTask() : undefined
    const scope = { assistantId: binding.assistantId, workspaceId: task?.workspace.id ?? assistant.workspace.id }
    const records = await options.knowledge.list(scope)
    return records.map(record => record.kind !== 'skill' ? record : { skillId: record.skillId, kind: 'skill', activeVersion: record.activeVersion,
      versions: record.versions.map(version => ({ version: version.version, title: version.title, status: version.status, description: version.description, applicability: version.applicability })) })
  })

  if (binding.role === 'foreground') {
    register('task_records', 'Read sealed task records or export a Markdown copy into its workspace.',
      z.strictObject({ taskId: Id, action: z.enum(['read', 'export']), cursor: z.int().nonnegative().optional(),
        limit: z.int().min(1).max(262144).optional().describe('Characters per read page; default 32768.') }), async input => {
        const task = await currentTask(input.taskId)
        if (input.action === 'export') { userSource(); return options.tasks.exportRecords(task.id) }
        return options.tasks.archives.read(task.id, input.cursor, input.limit)
      })
    register('task_submit', 'Persist a goal from the current actual user message. A queued task is not a completed result.',
      z.strictObject({ sourceMessageId: Id.optional(), requestKey: Id.optional(), goal: GoalSchema.omit({ request: true, sourceRef: true }) }), async input => {
        const source = userSource(input.sourceMessageId)
        const user = latestUser()!
        const request = user.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
        const assistant = await options.assistants.get(binding.assistantId)
        return options.tasks.submit({ commandId: `submit:${binding.sessionId}:${source.messageId}:${input.requestKey ?? 'main'}`,
          source, assistantId: binding.assistantId, workspace: assistant.workspace,
          runtimeProfile: assistant.inputs[source.messageId]?.runtimeProfile ?? assistantRuntimeProfile(assistant),
          goal: { ...input.goal, request, sourceRef: `${binding.sessionId}/${source.messageId}` } })
      })
    register('task_control', 'Transmit a pause/resume/cancel/stop explicitly requested in the current user message.',
      z.strictObject({ taskId: Id, sourceMessageId: Id.optional(), intent: z.enum(['pause', 'resume', 'cancel', 'stop']), executionId: Id.optional() }), async input => {
        const task = await currentTask(input.taskId)
        const source = userSource(input.sourceMessageId)
        return options.tasks.execute(task.id, { type: 'task.control', commandId: `intent:${binding.sessionId}:${source.messageId}:${input.intent}:${input.executionId ?? task.id}`,
          source, intent: input.intent, ...(input.executionId ? { executionId: input.executionId } : {}) })
      })
    register('task_answer', 'Pass the current user’s reply to a waiting task question and resume its work.',
      z.strictObject({ taskId: Id, waitId: Id, sourceMessageId: Id.optional() }), async input => {
        const source = userSource(input.sourceMessageId)
        const task = await currentTask(input.taskId)
        const answer = latestUser()!.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
        return options.tasks.execute(task.id, { type: 'wait.answer', commandId: `answer:${binding.sessionId}:${source.messageId}:${input.waitId}`,
          source, waitId: input.waitId, answer })
      })
    register('task_priority', 'Set an integer task priority explicitly requested in the current user message. The default is 0; higher values dispatch first without preempting active work.',
      z.strictObject({ taskId: Id, priority: z.int() }), async (input, exec) => {
        const task = await currentTask(input.taskId)
        const source = userSource()
        return options.tasks.execute(task.id, { type: 'task.priority', commandId: `tool:${binding.sessionId}:${exec.callId}`,
          source, priority: input.priority })
      })
    register('task_revise_goal', 'Persist the user’s correction on the existing goal. Preserve accepted work and original requirements.',
      z.strictObject({ taskId: Id, sourceMessageId: Id.optional(), expectedGoalRevision: z.int().positive(), goal: GoalSchema.omit({ request: true, sourceRef: true }) }), async input => {
        const source = userSource(input.sourceMessageId)
        const task = await currentTask(input.taskId)
        const request = latestUser()!.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
        return options.tasks.execute(task.id, { type: 'task.reviseGoal', commandId: `revise:${binding.sessionId}:${source.messageId}`,
          source, expectedGoalRevision: input.expectedGoalRevision, goal: { ...input.goal, request, sourceRef: `${binding.sessionId}/${source.messageId}` } })
      })
    register('knowledge_preference', 'Save an explicit lasting user preference with its actual user-source identity and applicability. For a correction, read knowledge_query and supply the saved expectedRevision.',
      z.strictObject({ sourceMessageId: Id.optional(), id: Id, text: Text, applicability: Text, expectedRevision: z.int().nonnegative().optional() }), async input => {
        const source = userSource(input.sourceMessageId)
        const assistant = await options.assistants.get(binding.assistantId)
        return options.knowledge.putPreference({ id: input.id, scope: { assistantId: assistant.id, workspaceId: assistant.workspace.id }, text: input.text,
          applicability: input.applicability, userSourceRef: `${binding.sessionId}/${source.messageId}`,
          ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }) })
      })
  }

  if (binding.role === 'planner') {
    register('planning_checkpoint', 'Persist a meaningful planning frontier and note-change trace without dispatch or acceptance.',
      z.strictObject({ expectedGoalRevision: z.int().positive(), summary: Text, frontier: Text, memory: MemorySchema.optional() }),
      async (input, exec) => commit(exec, { type: 'planning.checkpoint', ...input }, false))
    register('planning_handoff', 'Save the current frontier and yield this Planner generation. A fresh Planner resumes the same unfinished plan or evaluation action.',
      z.strictObject({ expectedGoalRevision: z.int().positive(), summary: Text, frontier: Text, memory: MemorySchema.optional() }),
      async (input, exec) => commit(exec, { type: 'planning.handoff', ...input }))
    register('planning_commit', 'Apply incremental plan changes and conclude this planning turn. Omitted Children retain their assignments, owners and accepted results.',
      z.strictObject({ expectedPlanRevision: z.int().nonnegative(), expectedGoalRevision: z.int().positive(), strategy: Text,
        children: z.array(ChildSchema).describe('New Children; may reference retained dependencies. Empty when only updating.'),
        updates: z.array(ChildSchema).optional().describe('Explicit replacements of existing Child instructions.'),
        cancelChildIds: z.array(Id).optional().describe('Explicit cancellations; update surviving dependents in the same call.'),
        retainAcceptedChildIds: z.array(Id).optional(), memory: MemorySchema.optional() }),
      async (input, exec) => commit(exec, { type: 'planning.commit', ...input }))
    register('planning_decide', 'Judge actual results against the current goal. Persist acceptance/rework, optional delivery, and bounded evidence-backed learning candidates, then conclude.',
      z.strictObject({ expectedGoalRevision: z.int().positive(), decisions: z.array(DecisionSchema), summary: Text, memory: MemorySchema.optional(),
        deliver: z.strictObject({ id: Id, summary: Text, artifacts: z.array(ArtifactSchema) }).optional(),
        learn: z.strictObject({ resultIds: z.array(Id).min(1), reason: Text, proposals: z.array(ProposalSchema).optional() }).optional() }),
      async (input, exec) => commit(exec, { type: 'planning.decide', ...input }))
  }
  if (binding.role === 'worker') {
    register('execution_report', 'Persist real work and its next frontier. Continue resumes this Worker; handoff saves an unfinished checkpoint for a fresh Worker on the same assignment. Complete requests Planner evaluation, not acceptance. All except progress conclude this turn.',
      ReportSchema, async (input, exec) => {
        const task = await currentTask()
        if (input.wait?.kind === 'job') {
          const owned = agent.ctx.get('jobs')?.list(agent.id).some(job => job.id === input.wait?.jobId && job.owner === agent.id)
          if (!owned) throw new Error('Job wait must refer to this exact live Agent’s native job')
        }
        const resultId = input.resultId.startsWith(`${task.id}:`) ? input.resultId : `${task.id}:${input.resultId}`
        const receipt = await commit(exec, { type: 'execution.report', report: { ...input, resultId,
          artifacts: input.artifacts.map(artifact => ({ ...artifact, resultId })) } }, input.outcome !== 'progress')
        return { ...receipt, resultId }
      })
  }
  if (binding.role === 'worker' || binding.role === 'planner') {
    register('execution_wait', 'Record a user decision, configuration requirement or resource dependency and how to resume the current work.',
      z.strictObject({ kind: z.enum(['user', 'configuration', 'resource']), operation: Text, message: Text, wait: WaitSchema }),
      async (input, exec) => commit(exec, { type: 'execution.requestHelp', ...input }))
  }
}

function accepted(receipt: CommandReceipt): boolean {
  return receipt.status === 'applied' || (receipt.status === 'duplicate' && receipt.originalStatus !== 'rejected' && receipt.originalStatus !== 'stale')
}

function taskSummary(task: Task) {
  return { id: task.id, revision: task.revision, goal: task.goal, control: task.control, phase: task.phase, workspace: task.workspace,
    plan: { revision: task.plan.revision, goalRevision: task.plan.goalRevision, strategy: task.plan.strategy.slice(0, 3000), childCount: task.plan.childIds.length },
    children: task.plan.childIds.slice(0, 30).map(id => { const child = task.children[id]!; return { id, title: child.title, status: child.status, acceptedResultId: child.acceptedResultId, currentResultId: child.currentResultId, historyRef: memoryRef(task.id, 'child', id) } }),
    delivery: task.delivery, waits: Object.values(task.waits).filter(wait => wait.state === 'waiting'),
    executions: Object.values(task.executions).filter(execution => execution.state === 'active' || !['stopped', 'lost'].includes(execution.physicalState)).map(execution => ({ executionId: execution.executionId,
      role: execution.role, physicalState: execution.physicalState, ownedJobIds: execution.ownedJobIds, state: execution.state })),
    memoryRefs: { goal: memoryRef(task.id, 'goal'), origin: memoryRef(task.id, 'origin'), plan: memoryRef(task.id, 'plan'), planner: memoryRef(task.id, 'planner'), children: memoryRef(task.id, 'children') } }
}
