import type { CoopService } from './service.js'
import type { CoopConsumer } from './consumer.js'
import { GitHubError } from './github.js'

/** One cancellable HEAD reconciliation timer per instance, independent of Agent count. */
export class CoopSync {
  private timer?: ReturnType<typeof setTimeout>
  private running = false
  private again = false
  private failures = 0
  private stopped = false
  private nextAttempt = 0
  constructor(private readonly service: CoopService, private readonly consumer: CoopConsumer) {}
  request = (): void => {
    if (this.stopped) return
    if (this.running) { this.again = true; return }
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = undefined; void this.run() }, Math.max(0, this.nextAttempt - Date.now()))
    this.timer.unref?.()
  }
  private async run(): Promise<void> {
    if (this.running || this.stopped) return
    this.running = true
    let delay = 15_000
    try { await this.service.sync(); this.failures = 0; this.nextAttempt = 0 }
    catch (error) {
      this.failures++
      delay = error instanceof GitHubError && error.retryAfter ? error.retryAfter * 1000 : Math.min(300_000, 15_000 * 2 ** Math.min(5, this.failures - 1))
      this.nextAttempt = Date.now() + delay
    } finally { this.running = false }
    if (this.stopped) return
    if (this.again && !this.failures) { this.again = false; this.request() }
    else if (this.consumer.hasWork()) {
      this.again = false
      this.timer = setTimeout(() => { this.timer = undefined; void this.run() }, delay)
      this.timer.unref?.()
    }
  }
  dispose(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer) }
}
