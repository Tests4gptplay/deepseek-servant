import type { Context } from '@deepseek-ai/cordis'
import type { Session, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition, ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'

/** Native turn metadata only. This does not assert that a message is visible or an Agent is running. */
export interface DshForegroundActivity {
  readonly turn: number
  readonly startSeq: number
  readonly startedAt: number
  readonly end?: TurnEndReason['kind']
}
export const foregroundActivityProjectionKey = 'deepseek-servant/foreground-activity' as const

export const foregroundActivityProjection: ProjectionDefinition<typeof foregroundActivityProjectionKey, DshForegroundActivity | null> = {
  key: foregroundActivityProjectionKey,
  stateVersion: 1,
  // End reasons are an official merge-extensible sum type; do not freeze its current list here.
  stateSchema: z.object({ turn: z.number().int().nonnegative(), startSeq: z.number().int().nonnegative(),
    startedAt: z.number().finite(), end: z.string().optional() }).nullable() as z.ZodType<DshForegroundActivity | null>,
  init: () => null,
  apply(state, event) {
    if (event.type === 'turn/start') return { turn: event.data.turn, startSeq: event.seq, startedAt: event.time }
    if (event.type === 'turn/end' && state?.turn === event.data.turn) return { ...state, end: event.data.reason.kind }
    return state
  },
}

export interface DshForegroundActivityReader {
  /** Undefined means unavailable/disposed capability; null means no turn has started. */
  read(session: Session): Readonly<DshForegroundActivity> | null | undefined
  available(): boolean
  dispose(): Promise<void>
}

/** Register through an owned injection scope, including late capability arrival.
 * Official registry reference-counts identical key/stateVersion registrations;
 * independent runtimes may dispose without removing another runtime's reader.
 * No private global registry, event-body cache, polling or synthetic business events.
 */
export function ensureForegroundActivity(ctx: Context): DshForegroundActivityReader {
  let handle: ProjectionHandle<DshForegroundActivity | null> | undefined
  let disposed = false
  const fiber = ctx.inject(['sessionProjections'], async scope => {
    const active = await scope.sessionProjections.register(foregroundActivityProjection)
    handle = active
    return () => { if (handle === active) handle = undefined }
  })
  return {
    read: session => disposed ? undefined : handle?.stateOf(session),
    available: () => !disposed && handle !== undefined,
    async dispose() { if (disposed) return; disposed = true; handle = undefined; await fiber.dispose() },
  }
}
