import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-user-questions'

function report(ctx: Context, message: string, error: unknown): void {
  // Diagnostics must not break the original request or projection producer.
  try { ctx.logger('deepseek-servant').warn(message, error) } catch {}
}

/** Observe only the original exact Agent waterfall. Owns no question or answer. */
export function observeNativeQuestionWait(ctx: Context, agent: Agent, changed: () => void): () => boolean {
  let pending = 0
  const notify = () => {
    try { changed() } catch (error) { report(ctx, 'Native question observation failed.', error) }
  }
  ctx.on('user-questions/request', async (request, next) => {
    if (request.agent !== agent || request.signal?.aborted) return next()
    let ended = false
    const end = () => {
      if (ended) return
      ended = true
      request.signal?.removeEventListener('abort', end)
      pending--
      notify()
    }
    pending++
    request.signal?.addEventListener('abort', end, { once: true })
    notify()
    try { return await next() } finally { end() }
  }, { prepend: true })
  return () => pending > 0
}

