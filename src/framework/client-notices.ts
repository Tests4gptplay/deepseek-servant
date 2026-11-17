import { frameworkScopeKey, type FrameworkClientView, type FrameworkMode } from './client-contracts.js'

export interface FrameworkNoticeScope { mode: FrameworkMode; collaborationId: string; storageScope?: string }
export interface FrameworkCompletionNotice {
  readonly id: string
  readonly scopeKey: string
  readonly taskId: string
  readonly title: string
  readonly kind: 'success'
  readonly key: 'completed'
}
export interface FrameworkNoticeSnapshot {
  readonly notice?: FrameworkCompletionNotice
  /** Unread is a transient client display flag, NOT delivery/read acknowledgement. */
  readonly unread: Readonly<Record<string, number>>
}
export interface FrameworkClientNotices {
  subscribe(listener: () => void): () => void
  getSnapshot(): FrameworkNoticeSnapshot
  observe(view: Pick<FrameworkClientView, 'activeMode' | 'collaborationId' | 'storageScope' | 'tasks'>): void
  dismiss(): void
  ackLocal(scope: FrameworkNoticeScope): void
}

/** Temporary presentation switch. Retain the completion implementation and
 * unread badge; change only this flag when top completion toasts are restored. */
export const completionToastEnabled = false

/** Observe authoritative task-completion facts, without creating conversation
 * messages, delivery protocols, Host actions, timers or Recorder dependencies.
 * Lifetime belongs to the client plugin, not the main page's mounted lifetime.
 */
export function createFrameworkClientNotices(options: { completionToast?: boolean } = {}): FrameworkClientNotices {
  const completionToast = options.completionToast ?? true
  const listeners = new Set<() => void>()
  const completed = new Map<string, Set<string>>()
  const unread = new Map<string, Set<string>>()
  const queue: FrameworkCompletionNotice[] = []
  let snapshot: FrameworkNoticeSnapshot = Object.freeze({ unread: Object.freeze({}) })
  const publish = () => {
    snapshot = Object.freeze({ ...(queue[0] ? { notice: queue[0] } : {}),
      unread: Object.freeze(Object.fromEntries([...unread].filter(([, tasks]) => tasks.size).map(([key, tasks]) => [key, tasks.size]))) })
    for (const listener of listeners) listener()
  }
  return {
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    getSnapshot: () => snapshot,
    observe: view => {
      const scopeKey = frameworkScopeKey(view.activeMode, view.collaborationId, view.storageScope)
      const previous = completed.get(scopeKey)
      if (!previous) {
        // Initial history, including after a mode/root change, establishes a
        // baseline. It is not evidence of a new completion seen by this client.
        completed.set(scopeKey, new Set(view.tasks.filter(task => task.status === 'complete').map(task => task.taskId)))
        return
      }
      let changed = false
      for (const task of view.tasks) {
        if (task.status !== 'complete' || previous.has(task.taskId)) continue
        previous.add(task.taskId)
        if (completionToast) queue.push(Object.freeze({ id: JSON.stringify([scopeKey, task.taskId]), scopeKey,
          taskId: task.taskId, title: task.title, kind: 'success', key: 'completed' }))
        const pending = unread.get(scopeKey) ?? new Set<string>()
        pending.add(task.taskId); unread.set(scopeKey, pending)
        changed = true
      }
      if (changed) publish()
    },
    dismiss: () => { if (queue.length) { queue.shift(); publish() } },
    ackLocal: scope => {
      const key = frameworkScopeKey(scope.mode, scope.collaborationId, scope.storageScope)
      if (unread.delete(key)) publish()
    },
  }
}
