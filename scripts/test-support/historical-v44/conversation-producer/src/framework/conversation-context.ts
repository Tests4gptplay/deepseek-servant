/** Conversation grouping is chronological publication metadata, not a statement
 * that any input was read, answered, acknowledged or had its signal consumed. */
export type ConversationResponsePhase = 'interim' | 'final'
export interface ConversationContextReference {
  id: string
  /** Original Local entry or Git daily record, never a second copy of text. */
  path: string
  kind: 'input' | ConversationResponsePhase
  position: number
}
export interface ConversationContextProvenance {
  version: 1
  position: number
  /** Only an explicit final stores its exact preceding publication references. */
  closes?: ConversationContextReference[]
}
export interface ConversationContextRound { messages: ConversationContextReference[]; finalId: string }
export interface ConversationContextIndex {
  version: 1
  nextPosition: number
  current: ConversationContextReference[]
  recent: ConversationContextRound[]
}
export const emptyConversationContext = (): ConversationContextIndex => ({ version: 1, nextPosition: 0, current: [], recent: [] })
export function parseConversationContext(raw: string): ConversationContextIndex {
  const value = JSON.parse(raw) as ConversationContextIndex
  const reference = (row: ConversationContextReference) => !!row && typeof row.id === 'string' && typeof row.path === 'string'
    && ['input', 'interim', 'final'].includes(row.kind) && Number.isSafeInteger(row.position) && row.position >= 0
  if (value.version !== 1 || !Number.isSafeInteger(value.nextPosition) || value.nextPosition < 0
    || !Array.isArray(value.current) || !value.current.every(reference) || !Array.isArray(value.recent) || value.recent.length > 6
    || !value.recent.every(round => Array.isArray(round.messages) && round.messages.every(reference)
      && round.messages.at(-1)?.id === round.finalId && round.messages.at(-1)?.kind === 'final'
      && round.messages.some(row => row.kind === 'input')))
    throw new Error('Unsupported or invalid conversation context metadata; originals remain available through explicit history reads.')
  return value
}
/** Only classified Foreground inputs and responses participate in grouping. */
export function conversationContextKind(message: { role: string; recipient?: string; responsePhase?: ConversationResponsePhase }) {
  return message.role === 'user' && message.recipient === 'ai' ? 'input' as const
    : message.role === 'assistant' ? message.responsePhase : undefined
}
export function appendConversationContext(previous: ConversationContextIndex, message: { id: string; role: string; recipient?: string; responsePhase?: ConversationResponsePhase }, path: string): {
  index: ConversationContextIndex; provenance?: ConversationContextProvenance
} {
  const kind = conversationContextKind(message)
  // Legacy/unclassified messages and human-to-human discussion remain originals.
  // Neither a replyTo nor elapsed time manufactures a final boundary.
  if (!kind) return { index: previous }
  if (previous.nextPosition >= Number.MAX_SAFE_INTEGER) throw new Error('Conversation context sequence is exhausted.')
  const ref: ConversationContextReference = { id: message.id, path, kind, position: previous.nextPosition }
  const provenance: ConversationContextProvenance = { version: 1, position: ref.position }
  const index: ConversationContextIndex = { ...previous, nextPosition: ref.position + 1 }
  if (kind === 'final') {
    provenance.closes = previous.current
    index.current = []
    if (previous.current.some(row => row.kind === 'input'))
      index.recent = [...previous.recent, { messages: [...previous.current, ref], finalId: ref.id }].slice(-6)
  } else if (kind === 'input' || previous.current.some(row => row.kind === 'input')) {
    index.current = [...previous.current, ref]
  }
  return { index, provenance }
}
/** A cleanup plan removes exact reviewed identities, not later messages. A round
 * whose final or every input was removed is no longer a complete retained group. */
export function pruneConversationContext(index: ConversationContextIndex, ids: ReadonlySet<string>): ConversationContextIndex {
  return { ...index, current: index.current.filter(row => !ids.has(row.id)),
    recent: index.recent.map(round => ({ ...round, messages: round.messages.filter(row => !ids.has(row.id)) }))
      .filter(round => round.messages.at(-1)?.id === round.finalId && round.messages.some(row => row.kind === 'input')) }
}
