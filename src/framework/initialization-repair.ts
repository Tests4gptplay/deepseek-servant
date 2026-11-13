import type { FrameworkTransactions } from './command-transactions.js'
import { foregroundGuidePath } from './foreground-prompt.js'
import { createRoleGuideInitialization, type RoleGuideInitialization } from './role-guides.js'
import { createFrameworkSkillIndexInitialization, frameworkSkillIndexPath, type FrameworkSkillIndexInitialization } from './skills.js'
import type { FilesStore } from './transactions.js'

type Result = RoleGuideInitialization | FrameworkSkillIndexInitialization
interface PendingInitialization {
  run(signal?: AbortSignal): Promise<Result>
  deferred?: boolean
  preserveOriginal?(): void
  originalReleased?: boolean
  work?: Promise<Result | undefined>
}

/** Own the two initial acquisitions, not a normal existence-repair service.
 * Only unfinished work remains. A Local source event retries a deferred original;
 * the existing Host tick may continue actual failures with their original Git
 * command/transport owner. Successful acquisitions leave no poll obligation. */
export class FrameworkInitialization {
  private readonly pending = new Map<string, PendingInitialization>()
  private originalChange = 0
  constructor(files: FilesStore, transactions: FrameworkTransactions,
    private readonly pendingOriginal?: (path: string) => Promise<boolean>, private readonly signal?: AbortSignal) {
    const guideOptions = { missingOnly: false }
    this.pending.set(foregroundGuidePath, { run: createRoleGuideInitialization(files, transactions, guideOptions),
      preserveOriginal: () => { guideOptions.missingOnly = true } })
    this.pending.set(frameworkSkillIndexPath, { run: createFrameworkSkillIndexInitialization(files, transactions, { missingOnly: true }) })
  }
  hasPending(): boolean { return [...this.pending.values()].some(entry => !entry.deferred) }
  /** A real exporter result, including one arriving during the original check. */
  originalsChanged(): void {
    this.originalChange++
    for (const entry of this.pending.values()) entry.deferred = false
  }
  initializeGuide(): Promise<RoleGuideInitialization | undefined> {
    return this.run(foregroundGuidePath) as Promise<RoleGuideInitialization | undefined>
  }
  async resume(report: (error: unknown) => void, catalogReady: () => void): Promise<void> {
    await Promise.all([...this.pending].filter(([, entry]) => !entry.deferred).map(async ([path]) => {
      try { const result = await this.run(path); if (result && path === frameworkSkillIndexPath) catalogReady() }
      catch (error) { report(error) }
    }))
  }
  private run(path: string): Promise<Result | undefined> {
    const entry = this.pending.get(path)
    if (!entry) return Promise.resolve(undefined)
    if (entry.work) return entry.work
    const work = Promise.resolve().then(async () => {
      if (!entry.originalReleased) {
        for (;;) {
          const observed = this.originalChange
          if (!await this.pendingOriginal?.(path)) { entry.originalReleased = true; break }
          // A deferred old original is not new permission to rewrite it. This
          // matches the former missing-only continuation after connection.
          entry.preserveOriginal?.()
          // This is a received completion notification, not a timer retry.
          if (observed !== this.originalChange) continue
          entry.deferred = true; return undefined
        }
      }
      const result = await entry.run(this.signal)
      this.pending.delete(path)
      return result
    })
    entry.work = work
    void work.finally(() => { if (entry.work === work) entry.work = undefined }).catch(() => {})
    return work
  }
}
