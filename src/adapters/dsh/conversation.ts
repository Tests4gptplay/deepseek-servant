import type { Message } from '@deepseek-ai/dsh-llm'
import { deriveEventMessage, isAppendSurfaceEvent, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ConversationMessage, ForegroundCapture } from '../../contracts/assistant.js'

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** Read model-authored output, before provider presentation adds diagnostic text. */
export function assistantResultText(message: Message): string {
  if (message.role !== 'assistant' || message.source.kind !== 'model') return ''
  const replay = object(message.source.replayState)
  const response = object(replay?.response ?? replay)
  if (response?.kind === 'codex-app-server' && Array.isArray(response.items)) {
    return response.items.flatMap(value => {
      const item = object(value)
      if (item?.type !== 'message' || item.role !== 'assistant' || !Array.isArray(item.content)) return []
      if (item.phase != null && item.phase !== 'final_answer' && item.phase !== 'final') return []
      if (item.channel != null && item.channel !== 'final') return []
      const text = item.content.flatMap(value => {
        const block = object(value)
        if ((block?.type === 'output_text' || block?.type === 'text') && typeof block.text === 'string') return [block.text]
        if (block?.type === 'refusal' && typeof block.refusal === 'string') return [block.refusal]
        return []
      }).join('')
      return text ? [text] : []
    }).join('\n\n')
  }
  return message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

/** Exact visible originals and their completed native interaction boundaries. */
export function conversationSnapshot(events: readonly SessionEvent[]): ForegroundCapture {
  const completed = new Set<number>()
  for (const event of events) if (event.type === 'turn/end' && event.data.reason.kind === 'completed') completed.add(event.data.turn)
  const results = new Map<number, { event: SessionEvent<'assistant/message'>; text: string }>()
  for (const event of events) {
    if (event.type !== 'assistant/message' || !isAppendSurfaceEvent(event) || !completed.has(event.data.turn) || event.data.interrupted) continue
    results.delete(event.data.turn)
    if (event.data.message.content.some(block => block.type === 'tool-call')) continue
    const text = assistantResultText(event.data.message)
    if (text.trim()) results.set(event.data.turn, { event, text })
  }
  const messages: ConversationMessage[] = [], seen = new Map<string, ConversationMessage>()
  const turns: ForegroundCapture['turns'] = []
  let current: number | undefined, finished = false
  let ended: ForegroundCapture['ended']
  let unassigned: ConversationMessage[] = []
  const assign = (turn: number) => { for (const message of unassigned) message.turn = turn; unassigned = [] }
  const append = (message: Message, text: string, time: number, turn?: number) => {
    if (!text || (message.role !== 'user' && message.role !== 'assistant')) return undefined
    const previous = seen.get(message.id)
    if (previous) {
      if (turn !== undefined) previous.turn = turn
      return previous
    }
    const value: ConversationMessage = { id: message.id,
      role: message.source.kind === 'deepseek-servant' ? 'system' : message.role,
      source: message.source.kind, text, at: new Date(time).toISOString(), ...(turn === undefined ? {} : { turn }) }
    seen.set(message.id, value); messages.push(value)
    return value
  }
  for (const event of events) {
    if (event.type === 'turn/start') { current = event.data.turn; assign(current); finished = false; ended = undefined }
    if (event.type === 'turn/end') {
      assign(event.data.turn)
      finished = event.data.reason.kind === 'completed'
      const reason = event.data.reason
      ended = { reason: reason.kind, at: new Date(event.time).toISOString(),
        ...(reason.kind === 'interrupted' || reason.kind === 'aborted' && ['disposed', 'parent'].includes(reason.reason.kind) ? { interrupted: true } : {}),
        messageIds: messages.filter(message => message.turn === event.data.turn).map(message => message.id),
        ...(event.data.reason.kind === 'error' ? { message: event.data.reason.error.message } : {}) }
      if (finished) turns.push({ turn: event.data.turn, at: new Date(event.time).toISOString(),
        messageIds: messages.filter(message => message.turn === event.data.turn).map(message => message.id) })
      current = undefined
    }
    if (event.type === 'agent/inbox/spliced') {
      for (const message of event.data.inserted) if (message.role === 'user' && ['user', 'deepseek-servant'].includes(message.source.kind))
        append(message, message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'), event.time)
    }
    if (!isAppendSurfaceEvent(event)) continue
    if (event.type === 'assistant/message') {
      assign(event.data.turn)
      const result = results.get(event.data.turn)
      if (result?.event === event) append(event.data.message, result.text, event.time, event.data.turn)
    } else {
      const message = deriveEventMessage(event)
      if (message?.source.kind === 'deepseek-servant-resume') {
        const original = seen.get(message.source.messageId)
        if (original && current !== undefined) original.turn = current
      }
      if (message?.role === 'user' && ['user', 'deepseek-servant'].includes(message.source.kind)) {
        const original = append(message, message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'), event.time, current)
        if (original && current === undefined) unassigned.push(original)
      }
    }
  }
  return { messages, turns, finished, ...(ended ? { ended } : {}) }
}

/** The conversation shows actual user inputs and the completed AI result only. */
export function conversationMessages(events: readonly SessionEvent[]): ConversationMessage[] {
  return conversationSnapshot(events).messages.filter(message => message.role !== 'system')
}
