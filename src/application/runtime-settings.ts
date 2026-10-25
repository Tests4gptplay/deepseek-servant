import type { StoragePort } from '../contracts/ports.js'

export interface RuntimeSettings { schemaVersion: 1; revision: number; workerSeats: number }
export const RUNTIME_SETTINGS_KEY = 'settings/runtime'
export function validWorkerSeats(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 32) throw new Error('Worker seats must be an integer from 1 to 32.')
}

/** Global DSS settings. A saved UI value takes precedence over the Host migration default. */
export class RuntimeSettingsService {
  private queue: Promise<unknown> = Promise.resolve()
  private constructor(private readonly store: StoragePort, private value: RuntimeSettings,
    private readonly changed: (settings: RuntimeSettings) => void) {}
  static async open(store: StoragePort, hostWorkerSeats = 2, changed: (settings: RuntimeSettings) => void = () => {}): Promise<RuntimeSettingsService> {
    const stored = await store.get<RuntimeSettings>(RUNTIME_SETTINGS_KEY)
    const value = stored ?? { schemaVersion: 1 as const, revision: 1, workerSeats: hostWorkerSeats }
    validWorkerSeats(value.workerSeats)
    if (!stored) await store.set(RUNTIME_SETTINGS_KEY, value)
    return new RuntimeSettingsService(store, value, changed)
  }
  get(): RuntimeSettings { return { ...this.value } }
  async configure(expectedRevision: number, workerSeats: number): Promise<RuntimeSettings> {
    validWorkerSeats(workerSeats)
    const pending = this.queue.catch(() => {}).then(async () => {
      if (expectedRevision !== this.value.revision) throw new Error('Runtime settings changed. Reload the current value before saving.')
      if (workerSeats === this.value.workerSeats) return this.get()
      const value: RuntimeSettings = { ...this.value, revision: this.value.revision + 1, workerSeats }
      await this.store.set(RUNTIME_SETTINGS_KEY, value)
      this.value = value
      this.changed(this.get())
      return this.get()
    })
    this.queue = pending
    return pending
  }
  async flush(): Promise<void> { await this.queue }
}
