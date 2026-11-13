import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

export interface NativeSessionRegistration {
  closed(result: { status: 'closed' } | { status: 'failed'; error: unknown }): void
}
export interface NativeSessionCleaner {
  register(agent: Agent): NativeSessionRegistration
  /** Host responsibility has ended permanently, not merely become idle/closed. */
  retire(sessionId: string): Promise<void>
}
declare module '@deepseek-ai/cordis' {
  interface Context { nativeSessionCleaner: NativeSessionCleaner }
}

function report(ctx: Context, operation: string, error: unknown): void {
  ctx.logger?.('deepseek-servant').warn('Native session cleanup ' + operation + ' was not recorded.', error)
}
/** Cleanup bookkeeping cannot reject an unrelated role's ordinary admission.
 * The cleaner owns any actual cleanup error; no business ACK is introduced. */
export function registerNativeSessionCleanup(ctx: Context, agent: Agent): NativeSessionRegistration | undefined {
  try { return ctx.get('nativeSessionCleaner')?.register(agent) }
  catch (error) { report(ctx, 'registration', error); return undefined }
}
export function recordNativeSessionClose(ctx: Context, registration: NativeSessionRegistration | undefined,
  result: { status: 'closed' } | { status: 'failed'; error: unknown }): void {
  try { registration?.closed(result) } catch (error) { report(ctx, 'close result', error) }
}
/** Resolves when the existing native journal has accepted this exact permanent
 * retirement, not when logs/cache are deleted. Callers retain their original
 * responsibility on failure and run this independently of Task directory cleanup. */
export async function retireNativeSession(ctx: Context, sessionId: string): Promise<void> {
  const cleaner = ctx.get('nativeSessionCleaner')
  if (!cleaner) throw new Error('Native session retirement service is unavailable; original Host responsibility is retained.')
  await cleaner.retire(sessionId)
}
