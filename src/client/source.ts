import { lifecycleRequest } from './request-lifecycle.js'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { AssistantSettings, ConversationMessage, ConversationQuery } from '../contracts/assistant.js'
import type { GoalInput, ModelRoute } from '../contracts/task.js'
import type { ServantView } from '../contracts/views.js'
import type { RetentionPolicy, RetentionPreview, RetentionSweepResult, StorageUsageStats } from '../contracts/retention.js'

export type RetentionRequest = { action: 'stats' } | { action: 'preview' } | { action: 'sweep'; previewId: string; confirmation: 'clear-ended-task-records' }
  | { action: 'configure'; policy: RetentionPolicy; expectedRevision: number }
  | { action: 'clearConversation'; confirmation: 'clear-foreground-conversation' }
  | { action: 'clearPlanningNotes'; confirmation: 'clear-work-planning-notes' }
  | { action: 'resetTasks'; confirmation: 'force-reset-task-state' }

export interface ServantClientApi {
  view(input?: { conversation?: ConversationQuery }, signal?: AbortSignal): Promise<ServantView>
  send(input: { assistantId: string, messageId: string, text: string, autoModel?: ModelRoute }, signal?: AbortSignal): Promise<unknown>
  configureRuntime(input: { expectedRevision: number; workerSeats: number }, signal?: AbortSignal): Promise<unknown>
  configure(input: { assistantId: string, expectedRevision: number, settings: AssistantSettings }, signal?: AbortSignal): Promise<unknown>
  control(input: { taskId: string, intent: 'pause' | 'resume' | 'cancel' | 'stop', executionId?: string }, signal?: AbortSignal): Promise<unknown>
  priority(input: { taskId: string, priority: number }, signal?: AbortSignal): Promise<unknown>
  reconcile(input: { taskId: string, executionId: string, confirmation: 'old-execution-stopped', evidence: string }, signal?: AbortSignal): Promise<unknown>
  answer(input: { taskId: string, waitId: string, answer: string }, signal?: AbortSignal): Promise<unknown>
  revise(input: { taskId: string, expectedGoalRevision: number, goal: GoalInput }, signal?: AbortSignal): Promise<unknown>
  knowledge(input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  retention(input: RetentionRequest, signal?: AbortSignal): Promise<unknown>
  moveRecords(input: { directory: string; expectedDirectory: string }, signal?: AbortSignal): Promise<unknown>
  readDelivery(input: { taskId: string }, signal?: AbortSignal): Promise<unknown>
  exportRecords(input: { taskId: string }, signal?: AbortSignal): Promise<{ path: string; sha256: string; bytes: number }>
  subscribeChanged(listener: () => void): () => void
  subscribeReset(listener: () => void): () => void
}

export interface ServantSnapshot {
  status: 'loading' | 'ready' | 'error'
  value?: ServantView
  error?: string
  pending: string[]
  history: ConversationQuery & { canGoNewer: boolean }
  retention?: RetentionPreview
  storageStats?: StorageUsageStats
  storageError?: string
  lastCleanup?: Pick<RetentionSweepResult, 'reclaimedServantBytes' | 'nativeReclaimedBytes' | 'finishedAt' | 'nativeLogsRetained' | 'skipped'>
}

export interface ServantNotice {
  sequence: number
  kind: 'success' | 'error'
  key: 'sent' | 'settingsSaved' | 'taskUpdated' | 'knowledgeUpdated' | 'retentionUpdated' | 'retentionPolicySaved' | 'recordsMoved' | 'recordsExported' | 'completed' | 'failed' | 'interrupted' | 'committedPendingRead'
  detail?: string
}

/** A transient outcome source independent of the main page's mounted lifetime. */
export function createServantNotices() {
  let snapshot: ServantNotice | undefined
  let sequence = 0
  const listeners = new Set<() => void>()
  const publish = (value: ServantNotice | undefined) => { snapshot = value; for (const listener of listeners) listener() }
  return {
    source: { getSnapshot: () => snapshot, subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    } } satisfies HostObservable<ServantNotice | undefined>,
    show: (notice: Omit<ServantNotice, 'sequence'>) => { publish({ ...notice, sequence: ++sequence }) },
    dismiss: () => { publish(undefined) },
  }
}

/** Read-only subscriptions follow the page; mutations always go through the Host services. */
export function createServantSource(api: ServantClientApi, notify: (notice: Omit<ServantNotice, 'sequence'>) => void) {
  let snapshot: ServantSnapshot = { status: 'loading', pending: [], history: { canGoNewer: false } }
  let history: ConversationQuery[] = [{}]
  let historyIndex = 0
  let historyPages: ConversationMessage[][] = []
  const listeners = new Set<() => void>()
  let epoch = 0
  let disposers: Array<() => void> = []
  let stopReset: (() => void) | undefined
  let scheduled = false
  let disposed = false
  let lifecycle = new AbortController()
  const mutations = new Map<string, object>()
  type ReadWork = { controller: AbortController; scope: AbortController; dirty: boolean; storage: boolean; promise: Promise<void> }
  let reading: ReadWork | undefined
  const publish = (next: ServantSnapshot) => { snapshot = next; for (const listener of listeners) { try { listener() } catch (error) { console.error('deepseek-servant observer', error) } } }

  const readPage = async (includeStorage: boolean, work: ReadWork, request: number): Promise<void> => {
    const read = <T>(operation: (signal: AbortSignal) => Promise<T>) => lifecycleRequest([work.scope.signal, work.controller.signal], operation)
    let pageIndex = historyIndex
    publish({ ...snapshot, status: 'loading', error: undefined })
    try {
      let [page, usage] = await Promise.all([read(signal => api.view({ conversation: history[pageIndex] }, signal)),
        includeStorage ? read(signal => api.retention({ action: 'stats' }, signal)).then(value => ({ value, error: undefined as string | undefined }),
          error => ({ value: snapshot.storageStats, error: errorMessage(error) })) : { value: snapshot.storageStats, error: snapshot.storageError }])
      if (request === epoch && !disposed && work.scope === lifecycle && !work.controller.signal.aborted) {
        if (snapshot.value && page.conversationMode !== snapshot.value.conversationMode) {
          const hadQuery = Object.keys(history[pageIndex] ?? {}).length > 0
          history = [{}]; historyIndex = 0; historyPages = []; pageIndex = 0
          if (hadQuery) page = await read(signal => api.view({ conversation: {} }, signal))
          if (request !== epoch) return
          publish({ ...snapshot, history: { canGoNewer: false } })
        }
        historyPages[pageIndex] = page.messages
        const messages = new Map<string, ConversationMessage>()
        for (const batch of historyPages.slice(0, pageIndex + 1).reverse()) {
          for (const message of batch) messages.set(message.ref ?? message.id, message)
        }
        const value = { ...page, messages: [...messages.values()].sort((a, b) => (a.at ?? '').localeCompare(b.at ?? '')) }
        const previous = snapshot.value && new Set(snapshot.value.tasks.filter(task => task.delivery?.status === 'delivered').map(task => task.id + '/' + task.delivery!.id))
        publish({ ...snapshot, status: 'ready', value, storageStats: usage.value as StorageUsageStats, storageError: usage.error, error: undefined })
        if (previous) for (const task of value.tasks) if (task.delivery?.status === 'delivered' && !previous.has(task.id + '/' + task.delivery.id)) {
          notify({ kind: 'success', key: 'completed', detail: task.goal.objective })
        }
      }
    } catch (error) {
      if (request === epoch && !disposed && work.scope === lifecycle && !work.controller.signal.aborted) publish({ ...snapshot, status: 'error', error: errorMessage(error) })
    }
  }
  const stopReads = () => {
    ++epoch
    reading?.controller.abort(new Error('The requested view changed.'))
    reading = undefined
  }
  const refresh = (includeStorage = true): Promise<void> => {
    if (disposed) return Promise.resolve()
    if (reading) {
      reading.dirty = true
      reading.storage ||= includeStorage
      return reading.promise
    }
    ++epoch
    const work: ReadWork = { controller: new AbortController(), scope: lifecycle, dirty: true, storage: includeStorage, promise: Promise.resolve() }
    reading = work
    work.promise = (async () => {
      while (work.dirty && !disposed && work.scope === lifecycle && !work.controller.signal.aborted) {
        work.dirty = false
        const storage = work.storage
        work.storage = false
        await readPage(storage, work, epoch)
      }
    })().finally(() => {
      if (reading !== work) return
      reading = undefined
      // An invalidation may arrive after the loop finishes but before this
      // completion callback. Preserve that last dirty state as well.
      if (work.dirty && !disposed && work.scope === lifecycle && !work.controller.signal.aborted) void refresh(work.storage)
    })
    return work.promise
  }
  const historyPage = async (action: 'older' | 'newer' | 'latest' | 'date', date?: string): Promise<void> => {
    const previous = { history, historyIndex, historyPages }
    if (action === 'older') {
      const before = snapshot.value?.conversationBefore
      if (!before || snapshot.status === 'loading') return
      stopReads()
      history = [...history.slice(0, historyIndex + 1), { ...history[historyIndex], before }]; historyIndex++
    } else if (action === 'newer') {
      if (historyIndex === 0 || snapshot.status === 'loading') return
      stopReads()
      historyIndex--
    } else { stopReads(); history = [action === 'date' && date ? { date } : {}]; historyIndex = 0; historyPages = [] }
    publish({ ...snapshot, history: { ...history[historyIndex], canGoNewer: historyIndex > 0 } })
    const query = history[historyIndex]
    await refresh(false)
    if (snapshot.status === 'error' && history[historyIndex] === query) {
      history = previous.history; historyIndex = previous.historyIndex; historyPages = previous.historyPages
      publish({ ...snapshot, history: { ...history[historyIndex], canGoNewer: historyIndex > 0 } })
    }
  }
  const invalidate = (): void => {
    // One commit can invalidate several projections; a microtask coalesces their reads.
    if (scheduled || disposed) return
    scheduled = true
    queueMicrotask(() => { scheduled = false; if (listeners.size && !disposed) void refresh() })
  }
  const reset = (notice = true) => {
    const pending = mutations.size > 0
    lifecycle.abort(new Error('The client connection lifecycle ended.'))
    lifecycle = new AbortController()
    stopReads()
    mutations.clear()
    publish({ ...snapshot, pending: [] })
    if (pending && notice) notify({ kind: 'error', key: 'interrupted' })
    if (!disposed) invalidate()
  }
  const mutate = async (key: string, notice: ServantNotice['key'] | undefined, operation: (signal: AbortSignal) => Promise<unknown>): Promise<boolean> => {
    if (disposed || mutations.has(key)) return false
    const token = {}, scope = lifecycle
    mutations.set(key, token)
    publish({ ...snapshot, pending: [...snapshot.pending, key] })
    try {
      const result = await lifecycleRequest([scope.signal], operation)
      if (disposed || scope !== lifecycle) return false
      if (result && typeof result === 'object' && 'status' in result && (result.status === 'stale' || result.status === 'rejected')) {
        throw new Error('reason' in result && typeof result.reason === 'string' ? result.reason : result.status)
      }
      if (key === 'send' && result && typeof result === 'object' && 'state' in result) {
        const detail = 'error' in result && typeof result.error === 'string' ? result.error : undefined
        if (result.state === 'PENDING_UNCOMMITTED') throw new Error(detail ?? 'The message is still pending a Git commit.')
        if (result.state === 'COMMITTED_PENDING_READ') {
          notify({ kind: 'error', key: 'committedPendingRead', detail })
          void refresh()
          return false // Keep the exact message identity for explicit read-back/retry.
        }
      }
      if (notice) notify({ kind: 'success', key: result && typeof result === 'object' && 'status' in result && result.status === 'queued' ? 'sent' : notice })
      // A committed mutation receipt is not invalidated by a later read failure.
      void refresh()
      return true
    } catch (error) {
      if (!disposed && scope === lifecycle) {
        notify({ kind: 'error', key: 'failed', detail: errorMessage(error) })
        void refresh()
      }
      return false
    } finally {
      if (mutations.get(key) === token) {
        mutations.delete(key)
        publish({ ...snapshot, pending: snapshot.pending.filter(item => item !== key) })
      }
    }
  }
  const assistantId = () => {
    if (!snapshot.value) throw new Error('Assistant is not loaded.')
    return snapshot.value.assistant.id
  }

  return {
    source: {
      getSnapshot: () => snapshot,
      subscribe(listener: () => void) {
        listeners.add(listener)
        if (listeners.size === 1) {
          disposers = [api.subscribeChanged(invalidate)]
          // A mutation can outlive a mounted view. Keep its reset observer
          // until this source is disposed, without retaining any SSE stream.
          stopReset ??= api.subscribeReset(reset)
          void refresh()
        }
        return () => {
          listeners.delete(listener)
          if (!listeners.size) { for (const dispose of disposers) dispose(); disposers = []; stopReads() }
        }
      },
    } satisfies HostObservable<ServantSnapshot>,
    dispose() {
      if (disposed) return
      disposed = true
      for (const dispose of disposers) dispose()
      disposers = []
      stopReset?.(); stopReset = undefined
      reset(false)
      listeners.clear()
    },
    refresh,
    historyPage,
    exportRecords: (taskId: string) => mutate('task:' + taskId, undefined, async signal => {
      const result = await api.exportRecords({ taskId }, signal)
      signal.throwIfAborted()
      notify({ kind: 'success', key: 'recordsExported', detail: result.path })
      return result
    }),
    readDeliveries: (taskIds: string[]) => Promise.all(taskIds.map(taskId => mutate('read:' + taskId, undefined, signal => api.readDelivery({ taskId }, signal)))),
    send: (messageId: string, text: string, autoModel?: ModelRoute) => mutate('send', 'sent', signal => api.send({ assistantId: assistantId(), messageId, text, autoModel }, signal)),
    configureRuntime: (expectedRevision: number, workerSeats: number) => mutate('configureRuntime', 'settingsSaved', signal => api.configureRuntime({ expectedRevision, workerSeats }, signal)),
    configure: (expectedRevision: number, settings: AssistantSettings) => mutate('configure', 'settingsSaved', signal => api.configure({ assistantId: assistantId(), expectedRevision, settings }, signal)),
    control: (taskId: string, intent: 'pause' | 'resume' | 'cancel' | 'stop', executionId?: string) => mutate(`task:${taskId}`, 'taskUpdated', signal => api.control({ taskId, intent, executionId }, signal)),
    priority: (taskId: string, priority: number) => mutate(`task:${taskId}`, 'taskUpdated', signal => api.priority({ taskId, priority }, signal)),
    reconcile: (taskId: string, executionId: string, evidence: string) => mutate(`task:${taskId}`, 'taskUpdated', signal => api.reconcile({ taskId, executionId, confirmation: 'old-execution-stopped', evidence }, signal)),
    answer: (taskId: string, waitId: string, answer: string) => mutate(`task:${taskId}`, 'taskUpdated', signal => api.answer({ taskId, waitId, answer }, signal)),
    revise: (taskId: string, expectedGoalRevision: number, goal: GoalInput) => mutate(`task:${taskId}`, 'taskUpdated', signal => api.revise({ taskId, expectedGoalRevision, goal }, signal)),
    knowledge: (input: Record<string, unknown>) => mutate(`knowledge:${String(input.skillId ?? input.id)}`, 'knowledgeUpdated', signal => api.knowledge({ ...input, assistantId: assistantId() }, signal)),
    moveRecords: (directory: string, expectedDirectory: string) => mutate('moveRecords', 'recordsMoved', signal => api.moveRecords({ directory, expectedDirectory }, signal)),
    retention: (input: RetentionRequest) => mutate('retention', input.action === 'preview' ? undefined : input.action === 'configure' ? 'retentionPolicySaved' : 'retentionUpdated', async signal => {
      const result = await api.retention(input, signal)
      signal.throwIfAborted()
      if (input.action === 'clearPlanningNotes' || input.action === 'resetTasks') return result
      if (input.action === 'clearConversation') {
        history = [{}]; historyIndex = 0; historyPages = []
        publish({ ...snapshot, history: { canGoNewer: false } })
      } else if (input.action === 'stats') {
        publish({ ...snapshot, storageStats: result as StorageUsageStats })
      } else if (input.action === 'sweep' && result && typeof result === 'object' && 'remaining' in result) {
        const swept = result as RetentionSweepResult
        publish({ ...snapshot, retention: swept.remaining, lastCleanup: { reclaimedServantBytes: swept.reclaimedServantBytes,
          nativeReclaimedBytes: swept.nativeReclaimedBytes, finishedAt: swept.finishedAt, nativeLogsRetained: swept.nativeLogsRetained, skipped: swept.skipped } })
      } else {
        const preview = input.action === 'configure' ? await api.retention({ action: 'preview' }, signal) : result
        signal.throwIfAborted()
        if (!preview || typeof preview !== 'object' || !('previewId' in preview) || !('totals' in preview)) throw new Error('Invalid retention preview.')
        publish({ ...snapshot, retention: preview as RetentionPreview })
      }
      return result
    }),
  }
}

export type ServantSource = ReturnType<typeof createServantSource>

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
