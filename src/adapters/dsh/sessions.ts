import type { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionLogOffset, deriveEventMessage, isAppendSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError, SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import type { InboxState, TurnBoundaryProjection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-workspace'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { AssistantInputEvidence } from '../../contracts/assistant.ts'

export interface ConversationMessage { id: string; role: 'user' | 'assistant'; text: string }
export interface DshSessionCatalogEntry {
  sessionId: string
  createdAt: number
  eventCount?: number
  sizeBytes?: number
  liveAgent: boolean
  liveSession: boolean
  archived: boolean
}
export interface DshSessionInspection {
  exists: boolean
  sessionId: string
  liveAgent: boolean
  liveSession: boolean
  eventCount: number
  sizeBytes?: number
  /** False when the host's native lifecycle projections are unavailable. Never infer an empty inbox. */
  lifecycleKnown: boolean
  queuedInbox: { nextTurn: string[]; nextStep: string[] }
  lastTurn?: { turn: number; closed: boolean; toolCallIds: string[]; reason?: string; error?: string }
  unresolvedToolCallIds: string[]
  /** Durable history hints only. These records never imply surviving OS jobs after restart. */
  jobs: Array<{ id: string; owner: string; kind: string; state: 'registered' | 'completed' | 'killed' | 'failed'; producerReported?: boolean }>
}

/** Read existing Session evidence without creating/resuming an Agent or releasing its inbox. */
export class DshSessionReader {
  constructor(private readonly ctx: Context) {}

  async events(sessionId: string): Promise<readonly SessionEvent[]> {
    const id = SessionId(sessionId)
    const live = this.ctx.sessions.get(id)
    if (live !== undefined) return live.snapshotEvents()
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) throw new Error('Servant requires DSH Session persistence for cold-session reads.')
    if (await persistence.stat(id) === undefined) return []
    const handle = await persistence.open(id, 'read')
    try { return (await handle.read()).events } finally { await handle.close() }
  }

  /** Current inbox and consumed history, with original bodies retained for discarded admissions. */
  async inputs(sessionId: string): Promise<ReadonlyMap<string, AssistantInputEvidence>> {
    const id = SessionId(sessionId)
    const live = this.ctx.sessions.get(id)
    const liveEvents = live?.snapshotEvents()
    if (live !== undefined) await this.ctx.sessions.flush(live)
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) throw new Error('Servant requires native persistence to inspect input admission.')
    if (live === undefined && await persistence.stat(id) === undefined) return new Map()
    const opened = live === undefined ? await persistence.open(id, 'read') : undefined
    try {
      const events = liveEvents ?? (await opened!.read()).events
      const header = live?.header ?? opened!.header
      const inherited = live?.inheritedEventCount ?? opened!.inheritedEventCount
      const projected = this.ctx.get('sessionProjections')?.restore({}, events, SessionLogOffset(0), header, inherited)
      const inbox = projected?.checkpoint.inbox?.val as InboxState | undefined
      return deriveNativeInputs(events, inbox, this.ctx.agents.get(id)?.status === 'running')
    } finally { await opened?.close() }
  }

  async hasMessage(sessionId: string, messageId: string): Promise<boolean> {
    const input = (await this.inputs(sessionId)).get(messageId)
    if (input?.state === 'claimed' && !input.active) throw new Error('Native input was claimed by an interrupted turn; automatic replay is not established.')
    return input?.state === 'queued' || input?.state === 'consumed' || input?.state === 'claimed' && input.active === true
  }

  /** Native projection replay only: no Agent ownership, inbox wake, or model request. */
  async inspect(sessionId: string): Promise<DshSessionInspection> {
    const id = SessionId(sessionId)
    const live = this.ctx.sessions.get(id)
    if (live !== undefined) await this.ctx.sessions.flush(live)
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) throw new Error('Servant requires DSH Session persistence for inspection.')
    const stat = await persistence.stat(id)
    const base: DshSessionInspection = { exists: stat !== undefined || live !== undefined, sessionId,
      liveAgent: this.ctx.agents.get(id) !== undefined, liveSession: live !== undefined, eventCount: 0,
      ...(stat?.sizeBytes === undefined ? {} : { sizeBytes: stat.sizeBytes }),
      lifecycleKnown: false, queuedInbox: { nextTurn: [], nextStep: [] }, unresolvedToolCallIds: [], jobs: [] }
    if (!base.exists) return base
    const opened = live === undefined ? await persistence.open(id, 'read') : undefined
    try {
      const events = live?.snapshotEvents() ?? (await opened!.read()).events
      const header = live?.header ?? opened!.header
      const inherited = live?.inheritedEventCount ?? opened!.inheritedEventCount
      const projected = this.ctx.get('sessionProjections')?.restore({}, events, SessionLogOffset(0), header, inherited)
      const inbox = projected?.checkpoint.inbox?.val as InboxState | undefined
      const boundary = projected?.checkpoint.turnBoundary?.val as TurnBoundaryProjection | undefined
      base.lifecycleKnown = inbox !== undefined && boundary !== undefined
      base.eventCount = events.length
      if (inbox !== undefined) base.queuedInbox = { nextTurn: inbox['next-turn'].map(message => message.id), nextStep: inbox['next-step'].map(message => message.id) }
      const pendingTools = new Set<string>()
      const jobs = new Map<string, DshSessionInspection['jobs'][number]>()
      for (const event of events) {
        if (event.type === 'turn/start') base.lastTurn = { turn: event.data.turn, closed: false, toolCallIds: [] }
        if (event.type === 'turn/end') base.lastTurn = {
          turn: event.data.turn, closed: true, reason: event.data.reason.kind,
          toolCallIds: base.lastTurn?.turn === event.data.turn ? base.lastTurn.toolCallIds : [],
          ...(event.data.reason.kind === 'error' ? { error: event.data.reason.error.message } : {}),
        }
        if (event.type === 'tool/call') {
          pendingTools.add(event.data.callId)
          if (base.lastTurn && !base.lastTurn.closed) base.lastTurn.toolCallIds.push(event.data.callId)
        }
        if (event.type === 'tool/result') pendingTools.delete(event.data.message.toolCallId)
        if (event.type === 'job/registered') jobs.set(event.data.jobId, { id: event.data.jobId, owner: event.data.owner, kind: event.data.kind, state: 'registered' })
        if (event.type === 'job/settled') jobs.set(event.data.jobId, { id: event.data.jobId, owner: event.data.owner, kind: event.data.kind, state: event.data.status, producerReported: event.data.producerReported })
      }
      base.unresolvedToolCallIds = [...pendingTools]
      base.jobs = [...jobs.values()]
      return base
    } finally { await opened?.close() }
  }

  /** Metadata only. Omitted selectors list Servant-namespaced sessions for retention accounting. */
  async catalog(sessionIds?: readonly string[]): Promise<DshSessionCatalogEntry[]> {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) throw new Error('Servant requires DSH Session persistence for catalog reads.')
    const selected = sessionIds === undefined ? undefined : new Set(sessionIds)
    const archived = new Set(this.ctx.get('workspaceRegistry')?.archivedSessionIds ?? [])
    return (await persistence.list()).filter(item => selected === undefined ? item.header.id.startsWith('servant-') : selected.has(item.header.id))
      .map(item => ({ sessionId: item.header.id, createdAt: item.header.createdAt,
        ...(item.eventCount === undefined ? {} : { eventCount: item.eventCount }),
        ...(item.sizeBytes === undefined ? {} : { sizeBytes: item.sizeBytes }),
        liveAgent: this.ctx.agents.get(item.header.id) !== undefined,
        liveSession: this.ctx.sessions.get(item.header.id) !== undefined, archived: archived.has(item.header.id) }))
  }

  /** rc.2 supports archival, not erasing/truncating its append-only Session log. */
  async probeOwnership(sessionId: string): Promise<'absent' | 'exclusive' | 'busy'> {
    const id = SessionId(sessionId)
    if (this.ctx.agents.get(id) !== undefined || this.ctx.sessions.get(id) !== undefined) return 'busy'
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) throw new Error('Servant requires DSH Session persistence for ownership probes.')
    if (await persistence.stat(id) === undefined) return 'absent'
    try {
      const lease = await persistence.open(id, 'write')
      try {
        return this.ctx.agents.get(id) !== undefined || this.ctx.sessions.get(id) !== undefined ? 'busy' : 'exclusive'
      } finally { await lease.close() }
    } catch (error) {
      if (error instanceof SessionAlreadyOwnedError) return 'busy'
      if (error instanceof SessionPersistenceNotFoundError) return 'absent'
      throw error
    }
  }

  /** Archive only after taking native ownership; never erase append-only log bytes. */
  async retire(sessionId: string): Promise<{ sessionId: string; status: 'absent' | 'archived'; logRetained: boolean; reclaimedBytes: 0 }> {
    const id = SessionId(sessionId)
    const assertCold = () => {
      if (this.ctx.agents.get(id) !== undefined || this.ctx.sessions.get(id) !== undefined) throw new Error(`Cannot retire a live DSH Session: ${sessionId}`)
    }
    assertCold()
    const persistence = this.ctx.get('sessionPersistence')
    const workspaces = this.ctx.get('workspaceRegistry')
    if (persistence === undefined || workspaces === undefined) throw new Error('Native DSH Session retirement requires persistence and the workspace registry.')
    if (await persistence.stat(id) === undefined) return { sessionId, status: 'absent', logRetained: false, reclaimedBytes: 0 }
    // Taking the native write lease excludes another process's active owner.
    // Opening storage never creates an Agent and never consumes its queued inbox.
    const lease = await persistence.open(id, 'write')
    try {
      assertCold()
      await workspaces.archiveSession(id)
      return { sessionId, status: 'archived', logRetained: true, reclaimedBytes: 0 }
    } finally { await lease.close() }
  }

  async conversation(sessionId: string): Promise<ConversationMessage[]> {
    const output: ConversationMessage[] = []
    const seen = new Set<string>()
    for (const event of await this.events(sessionId)) {
      // A queued or interrupted user admission is still the user's actual
      // message. Keep it visible even before the model consumes it.
      if (event.type === 'agent/inbox/spliced') for (const message of event.data.inserted) {
        if (message.source.kind !== 'user' || seen.has(message.id)) continue
        const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
        if (!text) continue
        seen.add(message.id)
        output.push({ id: message.id, role: 'user', text })
      }
      if (!isAppendSurfaceEvent(event)) continue
      const message = deriveEventMessage(event)
      if (message === null || seen.has(message.id)) continue
      if (message.role !== 'user' && message.role !== 'assistant') continue
      if (message.role === 'user' && message.source.kind !== 'user') continue
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      if (text.length === 0) continue
      seen.add(message.id)
      output.push({ id: message.id, role: message.role, text })
    }
    return output
  }
}

/** Audit validated native splice outcomes; the Host projection remains the current inbox authority. */
export function deriveNativeInputs(events: readonly SessionEvent[], inbox: InboxState | undefined, liveRunning: boolean): ReadonlyMap<string, AssistantInputEvidence> {
  const inputs = new Map<string, AssistantInputEvidence>()
  const pendingIds: Record<'next-turn' | 'next-step', string[]> = { 'next-turn': [], 'next-step': [] }
  const claims = new Map<string, number | undefined>()
  let turn: number | undefined
  const remember = (message: UserMessage, state: AssistantInputEvidence['state']) => {
    const source = message.source.kind
    if (source !== 'user' && source !== 'deepseek-servant') return
    const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    const previous = inputs.get(message.id)
    if (previous && (previous.text !== text || previous.source !== source)) throw new Error(`Native input identity has conflicting bodies: ${message.id}`)
    inputs.set(message.id, { state: previous?.state === 'consumed' ? 'consumed' : state, text, source })
  }
  for (const event of events) {
    if (event.type === 'turn/start') turn = event.data.turn
    if (event.type === 'turn/end') turn = undefined
    if (event.type === 'agent/inbox/spliced') {
      const splice = event.data
      const removed = pendingIds[splice.target].splice(splice.start, splice.removedCount ?? 0, ...splice.inserted.map(message => message.id))
      for (const id of removed) {
        const input = inputs.get(id)
        if (!input || input.state === 'consumed') continue
        input.state = splice.outcome === 'canceled' ? 'discarded' : 'claimed'
        if (input.state === 'claimed') claims.set(id, turn)
        else claims.delete(id)
      }
      for (const message of splice.inserted) { remember(message, 'discarded'); claims.delete(message.id) }
    }
    if (isAppendSurfaceEvent(event)) {
      const message = deriveEventMessage(event)
      if (message?.role === 'user') remember(message, 'consumed')
    }
  }
  if (inbox === undefined && [...inputs.values()].some(input => input.state !== 'consumed')) {
    throw new Error('Native inbox projection is unavailable; input consumption cannot be determined.')
  }
  if (inbox) for (const message of [...inbox['next-turn'], ...inbox['next-step']]) remember(message, 'queued')
  for (const [id, input] of inputs) if (input.state === 'claimed') input.active = liveRunning && turn !== undefined && claims.get(id) === turn
  return inputs
}
