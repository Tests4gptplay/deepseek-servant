import type { AssistantSettings, ConversationMessage } from './assistant.ts'
import type { Task, WorkspaceBinding } from './task.ts'
import type { KnowledgeRecord } from './knowledge.ts'

/** Read models omit command receipts and scheduler payloads. */
export type TaskView = Omit<Task, 'receipts' | 'pendingActions' | 'source' | 'foregroundEvaluator'> & {
  pendingActionCount: number
  uncertainActionCount: number
}
export interface AssistantView {
  id: string
  revision: number
  sessionId: string
  settings: AssistantSettings
  workspace: WorkspaceBinding
  pendingInputs: Array<{ messageId: string; error?: string }>
}
export interface ServantView {
  assistant: AssistantView
  tasks: TaskView[]
  messages: ConversationMessage[]
  knowledge: KnowledgeRecord[]
  workspaces: Array<WorkspaceBinding & { title: string }>
  runtime: { status: 'running' | 'stopping' | 'degraded'; message?: string; workerSeats: number }
}

