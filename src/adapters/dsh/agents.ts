import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { MessageId, freezeMessage, errorChain } from '@deepseek-ai/dsh-llm'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId, deriveEventMessage, isAppendSurfaceEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-tools'
import type { DshAgentRequest, ExecutionPermission, OwnedDshAgent } from './host-types.js'
import { deriveNativeInputs } from './sessions.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Durable Servant task input; the message id binds the PendingAction. */
    'deepseek-servant': { kind: 'deepseek-servant' }
  }
}

/** Programmatic Agents remain owned by the long-lived Servant Host context. */
export class DshAgentGateway {
  private readonly owned = new Map<string, OwnedDshAgent>()
  private readonly opening = new Map<string, Promise<OwnedDshAgent>>()

  constructor(private readonly ctx: Context) {}

  create(request: DshAgentRequest): Promise<OwnedDshAgent> {
    const current = this.owned.get(request.sessionId)
    if (current !== undefined) return Promise.resolve(current)
    const pending = this.opening.get(request.sessionId)
    if (pending !== undefined) return pending
    const operation = this.createOwned(request).finally(() => this.opening.delete(request.sessionId))
    this.opening.set(request.sessionId, operation)
    return operation
  }

  get(sessionId: string): OwnedDshAgent | undefined { return this.owned.get(sessionId) }

  async exists(sessionId: string): Promise<boolean> {
    const id = SessionId(sessionId)
    if (this.ctx.agents.get(id) !== undefined) return true
    const persistence = this.ctx.get('sessionPersistence')
    return persistence !== undefined && await persistence.stat(id) !== undefined
  }

  private async createOwned(request: DshAgentRequest): Promise<OwnedDshAgent> {
    const sessionId = SessionId(request.sessionId)
    if (this.ctx.agents.get(sessionId) !== undefined) {
      throw new Error(`Servant cannot acquire an Agent already owned by another runtime: ${sessionId}`)
    }
    const presets = this.ctx.get('agentPresets')
    if (request.presetId !== undefined && presets === undefined) {
      throw new Error('The selected Servant preset requires the DSH agent preset registry.')
    }
    const presetId = presets === undefined ? undefined : (await presets.resolve(request.presetId)).id
    const route = request.model
    const agentOptions: AgentOptions = {
      ...(route?.provider === undefined ? {} : { provider: route.provider }),
      ...(route?.model === undefined ? {} : { model: route.model }),
      ...(route?.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort as ReasoningEffortId }),
      ...(route?.maxTokens === undefined ? {} : { maxTokens: route.maxTokens }),
    }
    let lastError: { message: string; turn: number; step: number } | undefined
    const setup = async (agentCtx: Context, agent: Agent) => {
      agentCtx.on('agent/error', event => {
        if (event.agent === agent) lastError = { message: errorChain(event.error), turn: event.turn, step: event.step }
      })
      if (presets !== undefined && presetId !== undefined) await presets.mount(agentCtx, presetId)
      // DSH rc.2 reuses the last request header after the first request.
      // Keep this owned execution on its captured route, including after resume.
      const provider = route?.provider, model = route?.model
      if (provider && model) agentCtx.on('agent/request', async ({ agent: owner }, next) => {
        const previous = await next()
        if (owner !== agent) return previous
        const config = { ...previous, provider, model }
        if (route.reasoningEffort === undefined) delete config.reasoningEffort
        else config.reasoningEffort = route.reasoningEffort as ReasoningEffortId
        return config
      })
      return await request.setup?.(agentCtx, agent)
    }
    const native: AgentHandle = request.resume
      ? await this.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
      : await this.ctx.agents.create({
          sessionId,
          agentOptions,
          meta: { cwd: request.cwd, ...(presetId === undefined ? {} : { agentPreset: presetId }) },
          setup,
        })
    const agent = native.agent
    let disposed = false
    const jobs = () => agent.ctx.get('jobs')?.list(agent.id).filter(job => job.owner === agent.id) ?? []
    const handle: OwnedDshAgent = {
      sessionId: request.sessionId,
      actualAgent: agent,
      send: async (text, messageId, mode = 'followup', source = request.role === 'foreground' ? 'user' : 'deepseek-servant') => {
        if (disposed) throw new Error(`Servant Agent is disposed: ${request.sessionId}`)
        if (handle.hasMessage(messageId)) {
          // A previous admission may have succeeded while its durability barrier failed.
          // The retry must prove persistence before acknowledging the same stable id.
          await this.ctx.sessions.flush(agent.session)
          return
        }
        lastError = undefined
        const message = freezeMessage({
          id: MessageId(messageId), role: 'user',
          content: [{ type: 'text', text }], source: source === 'user' ? { kind: 'user' as const } : { kind: 'deepseek-servant' as const },
        })
        agent[mode](message)
        await this.ctx.sessions.flush(agent.session)
      },
      cancel: async () => {
        if (disposed) return
        agent.cancel({ kind: 'user' })
        const registry = agent.ctx.get('jobs')
        for (const job of jobs()) {
          if (job.status === 'running' || job.status === 'stopping') registry?.kill(job.id, agent.id, 'Servant execution stop requested')
        }
        await this.ctx.sessions.flush(agent.session)
      },
      whenIdle: () => agent.whenIdle(),
      dispose: async () => {
        if (disposed) return
        await native.dispose()
        disposed = true
        if (this.owned.get(request.sessionId) === handle) this.owned.delete(request.sessionId)
      },
      observe: () => {
        if (disposed) return { state: 'stopped', jobs: [] }
        const ownedJobs = jobs()
        return {
          state: agent.status === 'running' ? 'running' : ownedJobs.some(job => job.status === 'running' || job.status === 'stopping') ? 'waiting' : 'idle',
          jobs: ownedJobs,
          ...(lastError === undefined ? {} : { error: { ...lastError } }),
        }
      },
      getMessages: () => agent.session.deriveMessages(),
      hasMessage: messageId => {
        if (agent.inbox.nextTurn.some(message => message.id === messageId) || agent.inbox.nextStep.some(message => message.id === messageId)) return true
        const events = agent.session.snapshotEvents()
        if (events.some(event => isAppendSurfaceEvent(event) && deriveEventMessage(event)?.id === messageId)) return true
        const input = deriveNativeInputs(events, { 'next-turn': agent.inbox.nextTurn, 'next-step': agent.inbox.nextStep }, agent.status === 'running').get(messageId)
        if (input?.state === 'claimed' && !input.active) throw new Error('Native input belongs to an interrupted claim and requires explicit recovery.')
        return input?.state === 'claimed' && input.active === true
      },
      subscribe: listener => {
        const onEvent = agent.ctx.on('session/event', () => listener())
        const onStatus = agent.ctx.on('agent/status', () => listener())
        const onError = agent.ctx.on('agent/error', () => listener())
        const onJob = agent.ctx.get('jobs')?.events.subscribe({ owner: agent.id }, event => {
          // Native owner filters also include shared jobs; Servant owns only the exact Agent's jobs.
          const owner = event.type === 'output' ? event.owner : event.job.owner
          if (owner === agent.id) listener()
        })
        return () => { onEvent(); onStatus(); onError(); onJob?.() }
      },
    }
    this.owned.set(request.sessionId, handle)
    return handle
  }
}

/** Fence native and Servant tools using the actual scoped Agent before every call. */
export function installExecutionGuard(agentCtx: Context, owner: Agent, allowed: ExecutionPermission): () => void {
  return agentCtx.on('tools/pre-execute', async (exec, next) => {
    if (exec.agent !== owner) return next()
    exec.signal?.throwIfAborted()
    if (!await allowed(owner, exec.name)) {
      return { kind: 'deny', reason: 'This Servant execution no longer owns permission to perform business tools.', info: { name: 'ServantExecutionClosed', code: 'SERVANT_EXECUTION_CLOSED' } }
    }
    return next()
  }, { prepend: true })
}
