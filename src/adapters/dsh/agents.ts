import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { MessageId, freezeMessage, errorChain } from '@deepseek-ai/dsh-llm'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId, deriveEventMessage, isAppendSurfaceEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-tools'
import type { DshAgentRequest, DshModelRoute, ExecutionPermission, OwnedDshAgent } from './host-types.js'
import { deriveNativeInputs } from './sessions.ts'
import { observeDshProgress } from './progress.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Durable Servant task input; the message id binds the PendingAction. */
    'deepseek-servant': { kind: 'deepseek-servant' }
    'deepseek-servant-history': { kind: 'deepseek-servant-history' }
    'deepseek-servant-resume': { kind: 'deepseek-servant-resume'; messageId: string }
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

  hasLiveOwner(sessionId: string): boolean {
    const id = SessionId(sessionId)
    return this.ctx.agents.get(id) !== undefined || (this.ctx.get('jobs')?.list(id)
      .some(job => job.owner === id && (job.status === 'running' || job.status === 'stopping')) ?? false)
  }

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
    // Native prompt variables read Agent.options before the request waterfall.
    // Resolve Auto through the Host's default selection before creating the scope.
    const route: DshModelRoute | undefined = request.model ?? this.ctx.get('agentDefaultModel')?.currentSelection()
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
      // A resumed Auto execution retains its admitted route; a new execution
      // captures the current Host default. Couple prompt and request selection.
      const loggedHeader = request.resume && request.model === undefined
        ? agent.session.requestHeader() : undefined
      const selected = loggedHeader?.config ?? route
      // Adapter defaults are resolved again; only restore an actual effort choice.
      const reasoningEffort = loggedHeader?.adapterDefaults?.reasoningEffort === true
        ? undefined : selected?.reasoningEffort
      const provider = selected?.provider, model = selected?.model
      if (provider && model) agentCtx.effect(() => installModelSelection(agentCtx, {
        current: { provider, model, ...(reasoningEffort === undefined ? {} : {
          reasoningEffort: reasoningEffort as ReasoningEffortId,
        }) }, assembled: undefined,
      }))
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
    if (!request.resume && request.recentExchanges?.length) {
      try {
        agent.inject(freezeMessage({ id: MessageId('servant-history:' + request.sessionId), role: 'user',
        source: { kind: 'deepseek-servant-history' }, content: [{ type: 'text', text:
          'Recent completed conversation exchanges, verbatim and chronological. These are historical originals for context; the next actual user input supplies the current request. Use dss_conversation_read with mode page and beforeId to page through earlier originals, or mode message and reference set to a known message id for one original.\n'
          + JSON.stringify(request.recentExchanges) }] }))
        await this.ctx.sessions.flush(agent.session)
      } catch (error) { await native.dispose(); throw error }
    }
    let disposed = false, closing = false
    let disposal: Promise<void> | undefined
    const admissions = new Set<Promise<void>>()
    const messageAdmissions = new Map<string, Promise<void>>()
    const progressSubscriptions = new Set<() => void>()
    // Only join admitted durability barriers, never a model turn. Once closing
    // begins no new send/cancel may race native teardown's persistence close.
    const admit = (operation: () => Promise<void>): Promise<void> => {
      const pending = Promise.resolve().then(operation)
      admissions.add(pending)
      void pending.then(() => admissions.delete(pending), () => admissions.delete(pending))
      return pending
    }
    const jobs = () => agent.ctx.get('jobs')?.list(agent.id).filter(job => job.owner === agent.id) ?? []
    const handle: OwnedDshAgent = {
      sessionId: request.sessionId,
      actualAgent: agent,
      send: async (text, messageId, mode = 'followup', source = request.role === 'foreground' ? 'user' : 'deepseek-servant', recovery) => {
        if (closing || disposed) throw new Error(`Servant Agent is closing or disposed: ${request.sessionId}`)
        const predecessor = messageAdmissions.get(messageId)
        const operation = admit(async () => {
          await predecessor?.catch(() => undefined)
          if (closing || disposed) throw new Error(`Servant Agent is closing or disposed: ${request.sessionId}`)
          if (recovery) {
            if (source !== 'deepseek-servant' || (mode !== 'followup' && mode !== 'steer')) throw new Error('Recovery delivery must be a waking plugin followup or steer input.')
            const input = deriveNativeInputs(agent.session.snapshotEvents(), {
              'next-turn': agent.inbox.nextTurn, 'next-step': agent.inbox.nextStep,
            }, agent.status === 'running').get(messageId)
            if (input && (input.text !== text || input.source !== source)) throw new Error('Recovery input differs from its persisted native identity.')
            if (input?.state === 'claimed' && !input.active && !recovery.replayInactiveClaim) {
              throw new Error('Inactive claimed recovery input requires confirmed prior execution stop.')
            }
            if (input?.state === 'queued' && agent.status === 'idle') {
              // Only the existing recovery explanation is withdrawn. Business
              // inputs stay in their original inbox positions and retain ids.
              if (!agent.inbox.remove(MessageId(messageId))) throw new Error('Recovery inbox input changed before withdrawal.')
              await this.ctx.sessions.flush(agent.session)
              if (closing || disposed) throw new Error(`Servant Agent closed before recovery readmission: ${request.sessionId}`)
            }
          }

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
        })
        messageAdmissions.set(messageId, operation)
        void operation.finally(() => { if (messageAdmissions.get(messageId) === operation) messageAdmissions.delete(messageId) }).catch(() => undefined)
        return operation
      },
      cancel: async () => {
        if (disposed) return
        if (closing) return handle.dispose()
        return admit(async () => {
          agent.cancel({ kind: 'user' })
          const registry = agent.ctx.get('jobs')
          for (const job of jobs()) {
            if (job.status === 'running' || job.status === 'stopping') registry?.kill(job.id, agent.id, 'Servant execution stop requested')
          }
          await this.ctx.sessions.flush(agent.session)
        })
      },
      whenIdle: () => agent.whenIdle(),
      dispose: async () => {
        if (disposed) return
        if (disposal) return disposal
        closing = true
        for (const unsubscribe of progressSubscriptions) unsubscribe()
        const pending = Promise.resolve().then(async () => {
          // Their callers retain the original failures; a failed admission must
          // not prevent native cleanup from draining/releasing its own resources.
          await Promise.allSettled([...admissions])
          await native.dispose()
          disposed = true
          if (this.owned.get(request.sessionId) === handle) this.owned.delete(request.sessionId)
        })
        disposal = pending
        try { await pending } finally { if (disposal === pending) disposal = undefined }
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
        return input?.state === 'claimed' && input.active === true
      },
      subscribeProgress: listener => {
        if (closing || disposed) return () => {}
        const stop = observeDshProgress(agent, event => { if (!closing && !disposed) listener(event) })
        const unsubscribe = () => { stop(); progressSubscriptions.delete(unsubscribe) }
        progressSubscriptions.add(unsubscribe)
        return unsubscribe
      },
      subscribe: (listener, terminalOnly = false) => {
        const onEvent = agent.ctx.on('session/event', (_session, event) => { if (!terminalOnly || event.type === 'turn/end') listener() })
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
