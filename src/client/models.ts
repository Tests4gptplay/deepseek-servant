import type { ModelCatalog, ModelSelection, ModelProviderGroup, ModelCatalogFailure } from '@deepseek-ai/dsh-api-session-controller/types'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
export interface ServantModels {
  current: ModelSelection | null
  groups: readonly ModelProviderGroup[]
  failures: readonly ModelCatalogFailure[]
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  error: string | null
}

/** DSS Auto resolves the deployment default, never another Session's projected selection. */
export function createServantModels(catalog: () => Promise<ModelCatalog>) {
  let state: ServantModels = { current: null, groups: [], failures: [], status: 'loading', error: null }
  const listeners = new Set<() => void>()
  let generation = 0
  let pending: Promise<void> | undefined
  const publish = (next: ServantModels) => { state = next; for (const listener of listeners) listener() }
  const load = () => {
    if (pending) return pending
    const epoch = generation
    const operation = (async () => {
      try {
        publish({ ...state, status: 'loading', error: null })
        const value = await catalog()
        if (epoch === generation) publish({ current: value.default, groups: value.groups, failures: value.failures, status: 'ready', error: null })
      } catch (error) {
        if (epoch === generation) publish({ ...state, current: null, status: 'error', error: error instanceof Error ? error.message : String(error) })
      }
    })()
    pending = operation
    void operation.finally(() => { if (pending === operation) pending = undefined })
    return operation
  }
  return {
    source: {
      getSnapshot: () => state,
      subscribe(listener: () => void) {
        listeners.add(listener)
        if (listeners.size === 1) void load()
        return () => { listeners.delete(listener); if (!listeners.size) {
          generation += 1; pending = undefined
        } }
      },
    } satisfies HostObservable<ServantModels>,
    refresh: load,
    reset: () => {
      generation += 1; pending = undefined
      publish({ ...state, current: null, status: 'loading', error: null })
      if (listeners.size) void load()
    },
  }
}
