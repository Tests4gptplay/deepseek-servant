import type { CoopView } from '../experimental/private-git/contracts.js'
import type { ServantMode } from './mode-router.js'

export interface ModeSnapshot { ready: boolean; activeMode: ServantMode; view?: CoopView; error?: string }
export type ModeRpc = (method: string, params: Record<string, unknown>) => Promise<unknown>
export class ModeClient {
  private value: ModeSnapshot = { ready: false, activeMode: 'LOCAL' }
  private listeners = new Set<() => void>()
  private refreshing?: Promise<void>
  private dirty = false
  private closeEvents?: () => void
  constructor(private readonly rpc: ModeRpc, readonly saveCredential: (ref: string, value: string) => Promise<void>,
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
  private publish(value: ModeSnapshot): void { this.value = value; for (const listener of this.listeners) listener() }
  refresh = (): Promise<void> => {
    this.dirty = true
    if (this.refreshing) return this.refreshing
    this.refreshing = (async () => {
      while (this.dirty) {
        this.dirty = false
        try {
          const { activeMode } = await this.rpc('selection', {}) as { activeMode: ServantMode }
          const view = activeMode === 'PRIVATE_GIT_EXPERIMENTAL' ? await this.call('view', {}) as CoopView : this.value.view
          this.publish({ ready: true, activeMode, view })
        } catch (error) { this.publish({ ...this.value, error: error instanceof Error ? error.message : String(error) }) }
      }
    })().finally(() => { this.refreshing = undefined })
    return this.refreshing
  }
  select = async (mode: ServantMode): Promise<void> => { await this.rpc('select', { mode }); await this.refresh() }
  call = (method: string, params: Record<string, unknown> = {}): Promise<unknown> =>
    this.rpc('call', { mode: 'PRIVATE_GIT_EXPERIMENTAL', method, params })
  dispose(): void { this.closeEvents?.(); this.listeners.clear() }
}
