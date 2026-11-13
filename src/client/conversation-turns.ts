import type { FrameworkClientMessage } from '../framework/client-contracts.js'

/** Reconstructed from the 55fe runtime; previews never replace original text. */
export interface ConversationTurn { anchorId: string; prompt: string; response: string }
const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
export function conversationTurnPreview(text: string, limit: number): string {
  const result: string[] = []
  for (const { segment } of segments.segment(text.replace(/\s+/gu, ' ').trim())) {
    if (result.length === limit) return result.join('') + '…'
    result.push(segment)
  }
  return result.join('')
}
export function conversationTurns(messages: readonly FrameworkClientMessage[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [], owners = new Map<string, ConversationTurn>()
  const byId = new Map(messages.map(message => [message.id, message]))
  let current: ConversationTurn | undefined
  const linked = (id: string): ConversationTurn | undefined => {
    const seen = new Set<string>()
    while (!seen.has(id)) {
      seen.add(id)
      const owner = owners.get(id)
      if (owner) return owner
      const message = byId.get(id)
      if (!message || message.role === 'system' || !message.replyTo) return undefined
      id = message.replyTo
    }
    return undefined
  }
  for (const message of messages) {
    if (message.role === 'user') {
      current = { anchorId: message.id, prompt: conversationTurnPreview(message.text, 50), response: '' }
      turns.push(current); owners.set(message.id, current)
    } else if (message.role === 'assistant') {
      const owner = message.replyTo ? linked(message.replyTo) : current
      if (!owner) continue
      owners.set(message.id, owner)
      const response = conversationTurnPreview(message.text, 120)
      if (response) owner.response = response
    }
  }
  return turns
}
