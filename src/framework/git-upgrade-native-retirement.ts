import type { Context } from '@deepseek-ai/cordis'
import type { OwnedDshAgent } from '../adapters/dsh/host-types.js'
import { retireNativeSession } from '../adapters/dsh/native-cleaner.js'

export type GitUpgradeNativeOwner = Pick<OwnedDshAgent, 'sessionId' | 'dispose'> | { sessionId: string; close: 'closed' }

export interface GitUpgradeNativeRetirement {
  sessionId: string
  retirement: 'fulfilled' | 'pending'
  close: 'closed' | 'failed'
  retirementError?: unknown
  closeError?: unknown
}
/** Invoke only after closing tool admission and draining accepted work. This
 * execution is never resumed for migration; the next wake uses a new session.
 * Business Git conversion is already independently published. Cleaner request fulfillment and actual native close are separate outcomes.
 * The existing void retire API can fulfill for an absent source without a
 * journal entry. Fulfillment is NOT named durable acceptance or physical deletion.
 * A failed request belongs to this exact active Host owner; this function
 * supplies no persistent ownership after that Host releases it. */
export async function handoffGitUpgradeNative(ctx: Context, handle: GitUpgradeNativeOwner, prior?: GitUpgradeNativeRetirement): Promise<GitUpgradeNativeRetirement> {
  if (prior && prior.sessionId !== handle.sessionId) throw new Error('Native close evidence belongs to a different exact session.')
  const [retirement, close] = await Promise.allSettled([
    prior?.retirement === 'fulfilled' ? Promise.resolve() : retireNativeSession(ctx, handle.sessionId),
    // Actual Cleaner wrappers cache disposal, including rejection. Do not
    // represent another call as a fresh native-close recovery attempt.
    prior ? prior.close === 'closed' ? Promise.resolve() : Promise.reject(prior.closeError)
      : 'dispose' in handle ? Promise.resolve().then(() => handle.dispose()) : Promise.resolve(),
  ])
  return {
    sessionId: handle.sessionId,
    retirement: retirement.status === 'fulfilled' ? 'fulfilled' : 'pending',
    close: close.status === 'fulfilled' ? 'closed' : 'failed',
    ...(retirement.status === 'rejected' ? { retirementError: retirement.reason } : {}),
    ...(close.status === 'rejected' ? { closeError: close.reason } : {}),
  }
}
