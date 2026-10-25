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
export interface RecordStorageView {
  directory: string
  nativeDirectory?: string
  /** The move committed, but the old copy could not be removed. */
  retainedSource?: string
}
export interface ServantView {
  runtimeSettings: import('../application/runtime-settings.js').RuntimeSettings
  recordStorage: RecordStorageView
  assistant: AssistantView
  tasks: TaskView[]
  messages: ConversationMessage[]
  conversationBefore?: string
  knowledge: KnowledgeRecord[]
  workspaces: Array<WorkspaceBinding & { title: string }>
  runtime: { status: 'running' | 'stopping' | 'degraded'; message?: string; workerSeats: number }
}

