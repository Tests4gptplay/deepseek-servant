import type { CoopView } from '../experimental/private-git/contracts.js'
import type { ServantMode } from './mode-router.js'

export interface ModeSnapshot { ready: boolean; activeMode: ServantMode; view?: CoopView; error?: string }
export type ModeRpc = (method: string, params: Record<string, unknown>) => Promise<unknown>
export class ModeClient {
  private value: ModeSnapshot = { ready: false, activeMode: 'LOCAL' }
  private listeners = new Set<() => void>()
  private refreshing?: Promise<void>
  private dirty = false
  private includeCoop = false
  loadCoop = (): Promise<void> => { this.includeCoop = true; return this.refresh() }
  private generation = 0
  private disposed = false
  private closeEvents?: () => void
  constructor(private readonly rpc: ModeRpc,
    private readonly events: (changed: () => void) => () => void) {}
  snapshot = (): ModeSnapshot => this.value
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (!this.closeEvents) { this.closeEvents = this.events(() => { void this.refresh() }); void this.refresh() }
    return () => {
      this.listeners.delete(listener)
      if (!this.listeners.size) { this.closeEvents?.(); this.closeEvents = undefined }
    }
  }
  private publish(value: ModeSnapshot): void { this.value = value; for (const listener of this.listeners) { try { listener() } catch (error) { console.error('deepseek-servant observer', error) } } }
  refresh = (): Promise<void> => {
    if (this.disposed) return Promise.resolve()
    ++this.generation
    this.dirty = true
    if (this.refreshing) return this.refreshing
    this.refreshing = (async () => {
      while (this.dirty && !this.disposed) {
        this.dirty = false
        const generation = this.generation
        try {
          const { activeMode } = await this.rpc('selection', {}) as { activeMode: ServantMode }
          let view = this.value.view, error: string | undefined
          try { if (this.includeCoop || activeMode === 'PRIVATE_GIT_EXPERIMENTAL') view = await this.call('view', {}) as CoopView }
          catch (reason) { error = reason instanceof Error ? reason.message : String(reason) }
          if (!this.disposed && generation === this.generation) this.publish({ ready: true, activeMode, view, error })
        } catch (error) { if (!this.disposed && generation === this.generation) this.publish({ ...this.value, error: error instanceof Error ? error.message : String(error) }) }
      }
    })().finally(() => { this.refreshing = undefined })
    return this.refreshing
  }
  select = async (mode: ServantMode): Promise<void> => { ++this.generation; await this.rpc('select', { mode }); await this.refresh() }
  call = (method: string, params: Record<string, unknown> = {}): Promise<unknown> =>
    this.rpc('call', { mode: 'PRIVATE_GIT_EXPERIMENTAL', method, params })
  dispose(): void { this.disposed = true; ++this.generation; this.dirty = false; this.closeEvents?.(); this.closeEvents = undefined; this.listeners.clear() }
}
