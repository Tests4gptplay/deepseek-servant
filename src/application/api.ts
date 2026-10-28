import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { AssistantService } from './assistant-service.ts'
import type { TaskService } from './task-service.ts'
import type { KnowledgeService } from './knowledge-service.ts'
import type { QueryService } from './query-service.ts'
import type { RuntimeCoordinator } from '../runtime/coordinator.ts'
import type { RetentionService } from './retention-service.ts'
import { GoalSchema, Id, ModelRouteSchema, SettingsSchema, Text } from '../contracts/schemas.ts'

export interface ServantApiOptions {
  assistants: AssistantService
  tasks: TaskService
  knowledge: KnowledgeService
  query: QueryService
  coordinator: RuntimeCoordinator
  runtimeSettings: import('./runtime-settings.js').RuntimeSettingsService
  retention: RetentionService
  recordsDirectory(): string | Promise<string>
  moveRecords(directory: string, expectedDirectory: string, signal: AbortSignal): Promise<unknown>
  openPath(path: string, signal: AbortSignal): Promise<unknown>
}
const Target = z.strictObject({ taskId: Id, commandId: Id.optional() })
const ScopeTarget = z.strictObject({ assistantId: z.literal('default').default('default') })

/** Authenticated owner transport. Models never receive this general mutation API. */
export class ServantApi {
  constructor(private readonly options: ServantApiOptions) {}
  async call(method: string, raw: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    const source = { kind: 'user' as const, id: 'servant-client-owner' }
    const task = async (id: string) => {
      const value = await this.options.tasks.get(id)
      if (!value || value.assistantId !== 'default') throw new Error('任务不存在或不属于当前助理。')
      return value
    }
    switch (method) {
      case 'view': {
        const input = ScopeTarget.extend({ conversation: z.strictObject({ before: z.string().min(1).optional(),
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).optional() }).parse(raw)
        return this.options.query.view(input.assistantId, input.conversation)
      }
      case 'task': return this.options.query.task(Target.parse(raw).taskId)
      case 'send': {
        const input = ScopeTarget.extend({ messageId: Id, text: Text,
          autoModel: ModelRouteSchema.extend({ provider: z.string().min(1), model: z.string().min(1) }).optional() }).parse(raw)
        return this.options.assistants.sendMessage(input.assistantId, input.messageId, input.text, input.autoModel)
      }
      case 'configureRuntime': {
        const input = z.strictObject({ expectedRevision: z.int().positive(), workerSeats: z.int().positive() }).parse(raw)
        return this.options.runtimeSettings.configure(input.expectedRevision, input.workerSeats)
      }
      case 'configure': {
        const input = ScopeTarget.extend({ expectedRevision: z.int().positive(), settings: SettingsSchema }).parse(raw)
        const updated = await this.options.assistants.configure(input.assistantId, input)
        await this.options.coordinator.recover()
        this.options.coordinator.wake()
        return updated
      }
      case 'control': {
        const input = Target.extend({ intent: z.enum(['pause', 'resume', 'cancel', 'stop']), executionId: Id.optional() }).parse(raw)
        await task(input.taskId)
        const receipt = await this.options.tasks.execute(input.taskId, { type: 'task.control', commandId: input.commandId ?? `ui:${randomUUID()}`, source,
          intent: input.intent, ...(input.executionId ? { executionId: input.executionId } : {}) })
        if (input.intent === 'resume' && receipt.status === 'applied') { await this.options.coordinator.recover(); this.options.coordinator.wake() }
        return receipt
      }
      case 'priority': {
        const input = Target.extend({ priority: z.int() }).parse(raw)
        await task(input.taskId)
        return this.options.tasks.execute(input.taskId, { type: 'task.priority', commandId: input.commandId ?? `ui:${randomUUID()}`,
          source, priority: input.priority })
      }
      case 'answer': {
        const input = Target.extend({ waitId: Id, answer: Text }).parse(raw)
        await task(input.taskId)
        return this.options.tasks.execute(input.taskId, { type: 'wait.answer', commandId: input.commandId ?? `ui:${randomUUID()}`,
          source, waitId: input.waitId, answer: input.answer })
      }
      case 'revise': {
        const input = Target.extend({ expectedGoalRevision: z.int().positive(), goal: GoalSchema }).parse(raw)
        await task(input.taskId)
        const commandId = input.commandId ?? `ui:${randomUUID()}`
        return this.options.tasks.execute(input.taskId, { type: 'task.reviseGoal', commandId, source,
          expectedGoalRevision: input.expectedGoalRevision, goal: { ...input.goal, sourceRef: commandId } })
      }
      case 'exportRecords': {
        const input = Target.parse(raw)
        await task(input.taskId)
        return this.options.tasks.exportRecords(input.taskId)
      }
      case 'records': {
        const input = Target.extend({ cursor: z.int().nonnegative().optional(), limit: z.int().min(1).max(262144).optional() }).parse(raw)
        await task(input.taskId)
        return this.options.tasks.archives.read(input.taskId, input.cursor, input.limit)
      }
      case 'readDelivery': {
        const input = Target.parse(raw)
        await task(input.taskId)
        return this.options.tasks.execute(input.taskId, { type: 'delivery.read', commandId: input.commandId ?? `ui:${randomUUID()}`, source })
      }
      case 'knowledge': return this.knowledge(raw)
      case 'retention': {
        if (raw.action === 'resetTasks') {
          z.strictObject({ action: z.literal('resetTasks'), confirmation: z.literal('force-reset-task-state') }).parse(raw)
          return this.options.coordinator.resetTasks()
        }
        if (raw.action === 'clearPlanningNotes') {
          z.strictObject({ action: z.literal('clearPlanningNotes'), confirmation: z.literal('clear-work-planning-notes') }).parse(raw)
          return this.options.assistants.clearPlanningNotes()
        }
        if (raw.action === 'clearConversation') {
          z.strictObject({ action: z.literal('clearConversation'), confirmation: z.literal('clear-foreground-conversation') }).parse(raw)
          return this.options.assistants.clearConversation()
        }
        const input = z.strictObject({ action: z.enum(['stats', 'preview', 'sweep', 'configure']), previewId: z.string().optional(), confirmation: z.literal('clear-ended-task-records').optional(),
          expectedRevision: z.int().nonnegative().optional(), policy: z.record(z.string(), z.number()).optional() }).parse(raw)
        if (input.action === 'stats') return this.options.retention.stats()
        if (input.action === 'preview') return this.options.retention.preview({ manual: true })
        if (input.action === 'sweep') {
          if (!input.previewId || input.confirmation !== 'clear-ended-task-records') throw new Error('请先查看清理范围并确认删除已结束任务记录。')
          return this.options.retention.sweep({ previewId: input.previewId, manual: true })
        }
        if (!input.policy) throw new Error('清理策略不能为空。')
        // RetentionService validates optional limits and publishes one record.
        return this.options.retention.configure(input.policy as unknown as import('../contracts/retention.ts').RetentionPolicy, input.expectedRevision)
      }
      case 'reconcile': {
        const input = Target.extend({ executionId: Id, confirmation: z.literal('old-execution-stopped'), evidence: Text }).parse(raw)
        const current = await task(input.taskId)
        const execution = current.executions[input.executionId]
        if (!execution || execution.physicalState !== 'unknown') throw new Error('此操作只用于需要人工核对的未知旧执行。')
        const commandId = input.commandId ?? `ui-reconcile:${randomUUID()}`
        return this.options.coordinator.attestStopped(input.taskId, input.executionId, input.evidence, commandId)
      }
      case 'moveRecords': {
        const input = z.strictObject({ directory: z.string().trim().min(1), expectedDirectory: z.string().min(1) }).parse(raw)
        return this.options.moveRecords(input.directory, input.expectedDirectory, signal)
      }
      case 'openRecords': {
        ScopeTarget.parse(raw)
        const target = await realpath(await this.options.recordsDirectory())
        signal.throwIfAborted()
        return this.options.openPath(target, signal)
      }
      case 'openArtifact': {
        const input = z.strictObject({ taskId: Id, artifactId: Id }).parse(raw)
        const current = await task(input.taskId)
        const artifacts = [...(current.delivery?.artifacts ?? []), ...Object.values(current.reports).flatMap(report => report.artifacts)]
        const artifact = artifacts.find(artifact => artifact.id === input.artifactId)
        if (!artifact) throw new Error('该任务没有这个产物引用。')
        const root = await realpath(current.workspace.directory)
        const target = await realpath(path.resolve(root, artifact.path))
        const relative = path.relative(root, target)
        if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('此产物位于任务工作区之外，请按显示的路径自行查看。')
        await stat(target)
        signal.throwIfAborted()
        return this.options.openPath(target, signal)
      }
      default: throw new Error(`Unsupported Servant method: ${method}`)
    }
  }

  private async knowledge(raw: Record<string, unknown>): Promise<unknown> {
    const common = ScopeTarget.extend({ action: z.enum(['revise', 'disable', 'retire']), skillId: Id, commandId: Id.optional() })
    const action = common.passthrough().parse(raw).action
    const assistant = await this.options.assistants.get('default')
    const scope = { assistantId: assistant.id, workspaceId: assistant.workspace.id }
    if (action === 'revise') {
      const input = common.extend({ expectedVersion: z.int().positive(), title: Text, description: Text, body: z.string().min(1),
        applicability: Text, sourceResultId: Id }).parse(raw)
      return this.options.knowledge.reviseSkill({ ...input, scope, commandId: input.commandId ?? `ui:${randomUUID()}` })
    }
    const input = common.extend({ version: z.int().positive(), reason: Text }).parse(raw)
    const request = { ...input, scope, commandId: input.commandId ?? `ui:${randomUUID()}` }
    return action === 'disable' ? this.options.knowledge.disableSkill(request) : this.options.knowledge.retireSkill(request)
  }
}
