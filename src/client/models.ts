import type { ModelCatalog, ModelSelection, ModelProviderGroup, ModelCatalogFailure } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** Browser-only faces; do not merge the Client sessions service into the Host compilation. */
export interface ModelSessionBinding { readonly sessionId: SessionId }
export interface NativeModelSessions {
  list: HostObservable<{ byId: Readonly<Record<string, { id: SessionId; retainedBy: Readonly<Record<string, number | undefined>> }>> }>
  retainInfo(id: SessionId): HostObservable<{ retainedBy: Readonly<Record<string, number | undefined>> }>
  binding(id: SessionId): ModelSessionBinding | undefined
}
export interface ServantModels {
  current: ModelSelection | null
  groups: readonly ModelProviderGroup[]
  failures: readonly ModelCatalogFailure[]
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  error: string | null
}
/** Only the public read/load face is used; Servant never selects a model on the main conversation. */
export interface NativeModelDirectories {
  directoryFor(sessionId: SessionId): { store: HostObservable<ServantModels>; load(): Promise<unknown> }
}

export function createServantModels(sessions: NativeModelSessions, directories: NativeModelDirectories, catalog: () => Promise<ModelCatalog>) {
  let state: ServantModels = { current: null, groups: [], failures: [], status: 'loading', error: null }
  const listeners = new Set<() => void>()
  let binding: ModelSessionBinding | undefined
  let directory: ReturnType<NativeModelDirectories['directoryFor']> | undefined
  let stopList = () => {}, stopDirectory = () => {}, stopRetain = () => {}
  let generation = 0
  let initialized = false
  const publish = (next: ServantModels) => { state = next; for (const listener of listeners) listener() }
  const read = () => { if (directory) publish(directory.store.getSnapshot()) }
  const load = async () => {
    const epoch = generation
    try {
      if (directory) { await directory.load(); if (epoch === generation) read() }
      else {
        publish({ ...state, status: 'loading', error: null })
        const value = await catalog()
        if (epoch === generation) publish({ current: value.default, groups: value.groups, failures: value.failures, status: 'ready', error: null })
      }
    } catch (error) {
      if (epoch === generation) publish({ ...state, status: 'error', error: error instanceof Error ? error.message : String(error) })
    }
  }
  const sync = () => {
    const candidates = Object.values(sessions.list.getSnapshot().byId)
    const current = binding && (sessions.retainInfo(binding.sessionId).getSnapshot().retainedBy as Record<string, number>).mainView > 0
      ? binding : undefined
    const id = current?.sessionId ?? candidates.find(row => (row.retainedBy as Record<string, number>).mainView > 0)?.id
    const next = id === undefined ? undefined : sessions.binding(id)
    if (initialized && next === binding) return
    initialized = true; generation += 1; stopDirectory(); stopRetain(); binding = next
    directory = next === undefined ? undefined : directories.directoryFor(next.sessionId)
    stopDirectory = directory?.store.subscribe(read) ?? (() => {})
    stopRetain = id === undefined ? () => {} : sessions.retainInfo(id).subscribe(sync)
    publish(directory?.store.getSnapshot() ?? { current: null, groups: [], failures: [], status: 'loading', error: null })
    void load()
  }
  return {
    source: {
      getSnapshot: () => state,
      subscribe(listener: () => void) {
        listeners.add(listener)
        if (listeners.size === 1) { stopList = sessions.list.subscribe(sync); sync() }
        return () => { listeners.delete(listener); if (!listeners.size) {
          generation += 1; stopList(); stopDirectory(); stopRetain(); binding = undefined; directory = undefined; initialized = false
        } }
      },
    } satisfies HostObservable<ServantModels>,
    refresh: load,
  }
}
