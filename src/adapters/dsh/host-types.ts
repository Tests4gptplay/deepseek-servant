import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentSetup } from '@deepseek-ai/dsh-agent'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { JobView } from '@deepseek-ai/dsh-jobs'
import type { Role } from '../../contracts/task.js'
import type { DshProgress } from './progress.js'

/** Model route is supplied by Servant settings or resolved by the native preset. */
export interface DshModelRoute {
  provider?: string
  model?: string
  reasoningEffort?: string
  maxTokens?: number
}

export type DshAgentRole = Role | 'organizer' | 'recorder' | 'helper'

export interface DshAgentRequest {
  sessionId: string
  /** Cancels only this owned creation/admission; not the running Agent after return. */
  signal?: AbortSignal
  cwd: string
  role: DshAgentRole
  model?: DshModelRoute
  resume?: boolean
  recentExchanges?: import('../../contracts/assistant.js').ConversationMessage[][]
  presetId?: string
  setup?: AgentSetup
}

/** The holder owns disposal; an idle model can still own live jobs. */
export interface OwnedDshAgent {
  readonly sessionId: string
  readonly actualAgent: Agent
  send(text: string, messageId: string, mode?: 'followup' | 'steer' | 'inject', source?: 'user' | 'deepseek-servant', recovery?: { replayInactiveClaim?: boolean }): Promise<void>
  cancel(): Promise<void>
  whenIdle(): Promise<void>
  dispose(): Promise<void>
  observe(): {
    state: 'idle' | 'running' | 'waiting' | 'stopped'
    jobs: readonly JobView[]
    error?: { message: string; turn: number; step: number }
  }
  getMessages(): readonly Message[]
  hasMessage(messageId: string): boolean
  subscribe(listener: () => void, terminalOnly?: boolean): () => void
  subscribeProgress(listener: (event: DshProgress) => void): () => void
}

export type ExecutionPermission = (agent: Agent, toolName: string) => boolean | Promise<boolean>
export type AgentScopeSetup = (ctx: Context, agent: Agent) => void | Promise<void>

/** Explicit admission cancellation, with independently known cleanup evidence. */
export class DshAgentCreationCancelled extends Error {
  constructor(readonly executionStopped: boolean, readonly reason: unknown, readonly cleanupDetail?: string) {
    super(cleanupDetail ?? 'Native creation was cancelled.', { cause: reason })
    this.name = 'DshAgentCreationCancelled'
  }
}

/** This exact owned handle has closed admission; no native input was accepted. */
export class DshAgentAdmissionClosed extends Error {
  constructor(readonly sessionId: string) {
    super('Servant Agent is closing or disposed: ' + sessionId)
    this.name = 'DshAgentAdmissionClosed'
  }
}
