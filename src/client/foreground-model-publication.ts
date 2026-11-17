import type { Context } from '@deepseek-ai/cordis'
import type { ModelRoute } from '../contracts/task.js'
import type { ServantModels } from './models.js'

/** A saved choice for the next turn, not an in-flight request or Session. */
export interface ForegroundModelSelection { provider: string; model: string; reasoningEffort?: string }
declare module '@deepseek-ai/cordis' {
  interface Events {
    'ui/foreground-model/query'(accept: (value: ForegroundModelSelection | null) => void): void
    'ui/foreground-model/changed'(): void
  }
}

export function selectedForegroundModel(route: ModelRoute | undefined, models: Pick<ServantModels, 'groups'>): ForegroundModelSelection | null {
  if (!route?.provider || !route.model) return null
  const selected = models.groups.find(group => group.id === route.provider)?.models.find(model => model.id === route.model)
  const reasoningEffort = route.reasoningEffort ?? selected?.reasoning?.defaultEffort
  return { provider: route.provider, model: route.model, ...(reasoningEffort ? { reasoningEffort } : {}) }
}

/** One synchronous responder per mounted main-page producer; no consumer dependency. */
export function createForegroundModelPublication(ctx: Pick<Context, 'on' | 'emit'>) {
  let active = false, disposed = false
  let selection: ForegroundModelSelection | null = null
  const off = ctx.on('ui/foreground-model/query', accept => {
    if (active && !disposed) accept(selection ? { ...selection } : null)
  })
  ctx.emit('ui/foreground-model/changed')
  return {
    update(nextActive: boolean, next: ForegroundModelSelection | null) {
      if (disposed) return
      const changed = active !== nextActive || (nextActive && JSON.stringify(selection) !== JSON.stringify(next))
      active = nextActive; selection = next ? { ...next } : null
      if (changed) ctx.emit('ui/foreground-model/changed')
    },
    dispose() {
      if (disposed) return
      disposed = true; active = false; off(); ctx.emit('ui/foreground-model/changed')
    },
  }
}
