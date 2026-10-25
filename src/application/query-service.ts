import type { Task } from '../contracts/task.ts'
import type { ServantView, TaskView } from '../contracts/views.ts'
import type { AssistantService } from './assistant-service.ts'
import type { TaskService } from './task-service.ts'
import type { KnowledgeService } from './knowledge-service.ts'
import type { ExecutionBinding } from '../contracts/task.ts'
import { queryTaskMemory, type TaskMemoryPage, type TaskMemoryQuery } from '../runtime/context-assembler.js'

export interface QueryServiceOptions {
  assistants: AssistantService
  tasks: TaskService
  knowledge: KnowledgeService
  workspaces(): ServantView['workspaces']
  runtime(): ServantView['runtime']
  recordStorage(): ServantView['recordStorage']
}

export class QueryService {
  constructor(private readonly options: QueryServiceOptions) {}
  async view(assistantId = 'default'): Promise<ServantView> {
    const assistant = await this.options.assistants.get(assistantId)
    const [tasks, messages, knowledge] = await Promise.all([
      this.options.tasks.list(), this.options.assistants.conversation(assistantId),
      this.options.knowledge.list({ assistantId, workspaceId: assistant.workspace.id }),
    ])
    return {
      assistant: { id: assistant.id, revision: assistant.revision, sessionId: assistant.sessionId,
        settings: assistant.settings, workspace: assistant.workspace,
        pendingInputs: Object.entries(assistant.inputs).filter(([, input]) => input.status === 'pending' || input.error !== undefined)
          .map(([messageId, input]) => ({ messageId, ...(input.error ? { error: input.error } : {}) })),
      },
      tasks: tasks.filter(task => task.assistantId === assistantId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(taskView),
      messages, knowledge, workspaces: this.options.workspaces(), runtime: this.options.runtime(), recordStorage: this.options.recordStorage(),
    }
  }
  async task(taskId: string): Promise<TaskView | undefined> {
    const task = await this.options.tasks.get(taskId)
    return task && taskView(task)
  }
  /** The role tool boundary supplies its actual binding; clients must verify assistant scope before calling without one. */
  async memory(taskId: string, query: TaskMemoryQuery, execution?: ExecutionBinding): Promise<TaskMemoryPage | undefined> {
    const task = await this.options.tasks.get(taskId)
    return task && queryTaskMemory(task, execution, query)
  }
}

export function taskView(task: Task): TaskView {
  const { receipts: _receipts, pendingActions, source: _source, foregroundEvaluator: _evaluator, ...view } = task
  return { ...view,
    pendingActionCount: Object.values(pendingActions).filter(action => action.status === 'pending' || action.status === 'running').length,
    uncertainActionCount: Object.values(pendingActions).filter(action => action.status === 'uncertain').length,
  }
}
