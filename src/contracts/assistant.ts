import type { WorkspaceBinding, ModelRoute, RuntimeProfile, Delivery } from './task.ts'

/** Settings belong to the assistant, independently of the selected ordinary chat. */
export interface AssistantSettings {
  name: string
  workspaceId?: string
  /** An explicit directory for Servant only; never changes the host default. */
  workspaceDirectory?: string
  presetId: string
  foreground: ModelRoute
  background: ModelRoute
}
export interface Assistant {
  schemaVersion: 1
  id: string
  revision: number
  sessionId: string
  /** Previous foreground sessions remain readable after an idle configuration rotation. */
  priorSessionIds: string[]
  sessionWorkspaces: Record<string, WorkspaceBinding>
  settings: AssistantSettings
  /** Last main-composer selection admitted with a user message; used when a route is Auto. */
  autoModel?: ModelRoute
  workspace: WorkspaceBinding
  latestUser?: { id: string; text: string; at: string }
  inputs: Record<string, AssistantInputReceipt>
  deliveries: Record<string, AssistantDeliveryReceipt>
  createdAt: string
  updatedAt: string
}
export interface AssistantInputReceipt {
  /** Execution choices captured with this actual user input, not later UI changes. */
  runtimeProfile?: RuntimeProfile
  text?: string
  fingerprint: string
  sessionId: string
  workspaceId: string
  status: 'pending' | 'sent'
  at: string
  error?: string
}
export interface AssistantInputEvidence {
  state: 'queued' | 'consumed' | 'discarded' | 'claimed'
  /** A claimed input is held by the current live native turn, before its append surface. */
  active?: boolean
  text: string
  source: string
}
export interface AssistantDeliveryReceipt {
  /** Retained only until the first durable native admission. */
  delivery?: Delivery
  taskId: string
  messageId: string
  sessionId: string
  fingerprint: string
  status: 'pending' | 'sent'
  at: string
  error?: string
}
export interface ConversationMessage { id: string; role: 'user' | 'assistant'; text: string; at?: string }
export interface AssistantUserInput { id: string; text: string; sessionId: string; workspaceId: string; at?: string }
export interface AssistantSettingsChange { expectedRevision: number; settings: AssistantSettings }

