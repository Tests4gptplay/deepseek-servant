import { isAppendSurfaceEvent, type SessionEvent } from '@deepseek-ai/dsh-session'
import { conversationSnapshot } from '../adapters/dsh/conversation.js'

export interface ForegroundToolEvidence {
  callId: string
  resultMessageId: string
  time: number
}
export interface ForegroundClaimEvidence extends ForegroundToolEvidence { messageIds: string[] }
export interface ForegroundSendEvidence extends ForegroundToolEvidence {
  id: string
  text: string
  intent: 'human' | 'ai'
  replyTo?: string
}
export interface ForegroundTurnCapture {
  turn: number
  completedAt: number
  final?: { id: string; text: string; time: number; at: string; provider: string; model: string }
  readMessageIds: string[]
  claimedMessageIds: string[]
  claims: ForegroundClaimEvidence[]
  sends: ForegroundSendEvidence[]
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** Completed native output and successful conversation-tool evidence, without
 * interpreting wake instructions or inferring message recipients/reply targets.
 */
export function captureForegroundTurns(events: readonly SessionEvent[]): ForegroundTurnCapture[] {
  const snapshot = conversationSnapshot(events)
  const turns = new Map<number, ForegroundTurnCapture>()
  for (const event of events) if (event.type === 'turn/end' && event.data.reason.kind === 'completed') {
    turns.set(event.data.turn, { turn: event.data.turn, completedAt: event.time, readMessageIds: [], claimedMessageIds: [], claims: [], sends: [] })
  }
  const finalMessages = new Map(snapshot.messages.filter(message => message.role === 'assistant' && message.turn !== undefined)
    .map(message => [message.turn!, message]))
  const calls = new Map<number, Map<string, SessionEvent<'tool/call'>['data']>>()
  const successful = new Map<number, Set<string>>()
  for (const event of events) {
    if (event.type === 'assistant/message' && isAppendSurfaceEvent(event)) {
      const turn = turns.get(event.data.turn), selected = finalMessages.get(event.data.turn)
      const source = event.data.message.source
      if (turn && selected?.id === event.data.message.id && source.kind === 'model') {
        turn.final = { id: selected.id, text: selected.text, time: event.time, at: new Date(event.time).toISOString(), provider: source.provider, model: source.model }
      }
    }
    if (event.type === 'tool/call') {
      let entries = calls.get(event.data.turn)
      if (!entries) calls.set(event.data.turn, entries = new Map())
      entries.set(event.data.callId, event.data)
    }
    if (event.type !== 'tool/result' || !isAppendSurfaceEvent(event) || event.data.message.isError) continue
    const turn = turns.get(event.data.turn), callId = event.data.message.toolCallId
    const call = calls.get(event.data.turn)?.get(callId)
    if (!turn || !call || successful.get(event.data.turn)?.has(callId)) continue
    if (call.name !== 'dss_conversation_claim' && call.name !== 'dss_conversation_send' && call.name !== 'dss_conversation_read') continue
    let args: Record<string, unknown> | undefined
    try { args = object(JSON.parse(call.arguments)) } catch { continue }
    if (!args) continue
    const evidence: ForegroundToolEvidence = { callId, resultMessageId: event.data.message.id, time: event.time }
    if (call.name === 'dss_conversation_read') {
      if (args.mode !== 'message' && args.mode !== 'pending' && args.mode !== 'page') continue
      // These tools render their actual result as one JSON text block.
      const content = event.data.message.content
      if (content.length !== 1 || content[0]?.type !== 'text') continue
      let value: Record<string, unknown> | undefined
      try { value = object(JSON.parse(content[0].text)) } catch { continue }
      if (!value) continue
      const messages = args.mode === 'message' ? [value] : value.messages
      if (!Array.isArray(messages)) continue
      for (const candidate of messages) {
        const message = object(candidate)
        if (message?.role === 'user' && typeof message.id === 'string' && typeof message.text === 'string'
          && !turn.readMessageIds.includes(message.id)) turn.readMessageIds.push(message.id)
      }
    } else if (call.name === 'dss_conversation_claim') {
      if (!Array.isArray(args.messageIds) || !args.messageIds.every((id): id is string => typeof id === 'string')) continue
      turn.claims.push({ ...evidence, messageIds: [...args.messageIds] })
      for (const id of args.messageIds) if (!turn.claimedMessageIds.includes(id)) turn.claimedMessageIds.push(id)
    } else {
      if (typeof args.id !== 'string' || typeof args.text !== 'string' || (args.intent !== 'human' && args.intent !== 'ai')
        || (args.replyTo !== undefined && typeof args.replyTo !== 'string')) continue
      turn.sends.push({ ...evidence, id: args.id, text: args.text, intent: args.intent,
        ...(args.replyTo === undefined ? {} : { replyTo: args.replyTo }) })
    }
    let ids = successful.get(event.data.turn)
    if (!ids) successful.set(event.data.turn, ids = new Set())
    ids.add(callId)
  }
  return [...turns.values()]
}
