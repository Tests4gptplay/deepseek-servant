/** Local display labels are presentation, never account or storage identities.
 * Shared Git messages retain their actual participant label.
 */
export function frameworkMessageAuthor(mode: 'local' | 'git', message: { role: 'user' | 'assistant' | 'system'; participantId: string },
  settings: { name: string; userName: string }): string {
  if (mode !== 'local' || message.role === 'system') return message.participantId
  return (message.role === 'user' ? settings.userName : settings.name).trim() || message.participantId
}
