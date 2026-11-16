import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { FrameworkClientView } from '../framework/client-contracts.js'

declare module '@deepseek-ai/dsh-api-session-controller/client' { interface SessionReferenceSourceMap { 'deepseek-servant-cancel': unknown } }
/** One explicit user stop targets only the currently displayed Foreground turn. */
export async function cancelForeground(sessions: ISessions, view: FrameworkClientView): Promise<void> {
  const active = view.foregroundProcessing
  const execution = active && view.executions?.find(row => row.role === 'Foreground' && row.executionId === active.executionId)
  if (!execution) return
  const reference = sessions.retain(execution.sessionId as SessionId, { source: 'deepseek-servant-cancel' })
  try {
    const binding = reference.binding
    const result = await binding.session.cancel()
    if (!result.ok) throw new Error(`conversation.cancel failed: ${result.error.code}: ${result.error.message}`)
  } finally { reference.release() }
}
