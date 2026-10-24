import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentSetup } from '@deepseek-ai/dsh-agent'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { JobView } from '@deepseek-ai/dsh-jobs'
import type { Role } from '../../contracts/task.js'

/** Model route is supplied by Servant settings or resolved by the native preset. */
export interface DshModelRoute {
  provider?: string
  model?: string
  reasoningEffort?: string
  maxTokens?: number
}

export interface DshAgentRequest {
  sessionId: string
  cwd: string
  role: Role
  model?: DshModelRoute
  resume?: boolean
  presetId?: string
  setup?: AgentSetup
}

/** The holder owns disposal; an idle model can still own live jobs. */
export interface OwnedDshAgent {
  readonly sessionId: string
  readonly actualAgent: Agent
  send(text: string, messageId: string, mode?: 'followup' | 'steer' | 'inject', source?: 'user' | 'deepseek-servant'): Promise<void>
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
  subscribe(listener: () => void): () => void
}

export type ExecutionPermission = (agent: Agent, toolName: string) => boolean | Promise<boolean>
export type AgentScopeSetup = (ctx: Context, agent: Agent) => void | Promise<void>
