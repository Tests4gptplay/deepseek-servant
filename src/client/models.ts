import { frameworkErrorText } from '../framework/client-error.js'
import type { ModelCatalog, ModelSelection, ModelProviderGroup, ModelCatalogFailure } from '@deepseek-ai/dsh-api-session-controller/types'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
export interface ServantModels {
  current: ModelSelection | null
  groups: readonly ModelProviderGroup[]
  failures: readonly ModelCatalogFailure[]
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  error: string | null
}

const catalogEvents = ['llm/adapters-updated', 'llm/models-updated', 'settings/document-updated', 'credentials/record-updated', 'credentials/reference-updated'] as const
/** Use the same invalidation events as the official model catalog directory. */
export function subscribeServantModelUpdates(subscribe: (event: typeof catalogEvents[number], listener: () => void) => () => void, invalidate: () => void) {
  const disposers = catalogEvents.map(event => subscribe(event, invalidate))
  return () => { for (const dispose of disposers) dispose() }
}

/** DSS Auto resolves the deployment default, never another Session's projected selection. */
export function createServantModels(catalog: () => Promise<ModelCatalog>) {
  let state: ServantModels = { current: null, groups: [], failures: [], status: 'loading', error: null }
  const listeners = new Set<() => void>()
  let generation = 0
  let pending: Promise<void> | undefined
  let dirty = false
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
        if (epoch === generation) publish({ ...state, current: null, status: 'error', error: frameworkErrorText(error) })
      }
    })()
    pending = operation
    void operation.finally(() => {
      if (pending !== operation) return
      pending = undefined
      if (dirty && listeners.size) { dirty = false; void load() }
    })
    return operation
  }
  return {
    source: {
      getSnapshot: () => state,
      subscribe(listener: () => void) {
        listeners.add(listener)
        if (listeners.size === 1) void load()
        return () => { listeners.delete(listener); if (!listeners.size) {
          generation += 1; pending = undefined; dirty = false
        } }
      },
    } satisfies HostObservable<ServantModels>,
    refresh: load,
    invalidate: () => {
      generation += 1
      publish({ ...state, current: null, status: 'loading', error: null })
      if (!listeners.size) return
      if (pending) dirty = true
      else void load()
    },
    reset: () => {
      generation += 1; pending = undefined; dirty = false
      publish({ ...state, current: null, status: 'loading', error: null })
      if (listeners.size) void load()
    },
  }
}
