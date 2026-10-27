import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { AssistantSettings, ConversationMessage, ConversationQuery } from '../contracts/assistant.js'
import type { GoalInput, ModelRoute } from '../contracts/task.js'
import type { ServantView } from '../contracts/views.js'
import type { RetentionPolicy, RetentionPreview, RetentionSweepResult, StorageUsageStats } from '../contracts/retention.js'

export type RetentionRequest = { action: 'stats' } | { action: 'preview' } | { action: 'sweep'; previewId: string; confirmation: 'clear-ended-task-records' }
  | { action: 'configure'; policy: RetentionPolicy; expectedRevision: number }
  | { action: 'clearConversation'; confirmation: 'clear-foreground-conversation' }

export interface ServantClientApi {
  view(input?: { conversation?: ConversationQuery }): Promise<ServantView>
  send(input: { assistantId: string, messageId: string, text: string, autoModel?: ModelRoute }): Promise<unknown>
  configureRuntime(input: { expectedRevision: number; workerSeats: number }): Promise<unknown>
  configure(input: { assistantId: string, expectedRevision: number, settings: AssistantSettings }): Promise<unknown>
  control(input: { taskId: string, intent: 'pause' | 'resume' | 'cancel' | 'stop', executionId?: string }): Promise<unknown>
  priority(input: { taskId: string, priority: number }): Promise<unknown>
  reconcile(input: { taskId: string, executionId: string, confirmation: 'old-execution-stopped', evidence: string }): Promise<unknown>
  answer(input: { taskId: string, waitId: string, answer: string }): Promise<unknown>
  revise(input: { taskId: string, expectedGoalRevision: number, goal: GoalInput }): Promise<unknown>
  knowledge(input: Record<string, unknown>): Promise<unknown>
  retention(input: RetentionRequest): Promise<unknown>
  moveRecords(input: { directory: string; expectedDirectory: string }): Promise<unknown>
  readDelivery(input: { taskId: string }): Promise<unknown>
  exportRecords(input: { taskId: string }): Promise<{ path: string; sha256: string; bytes: number }>
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
  key: 'sent' | 'settingsSaved' | 'taskUpdated' | 'knowledgeUpdated' | 'retentionUpdated' | 'retentionPolicySaved' | 'recordsMoved' | 'recordsExported' | 'completed' | 'failed'
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
  let scheduled = false
  const publish = (next: ServantSnapshot) => { snapshot = next; for (const listener of listeners) { try { listener() } catch (error) { console.error('deepseek-servant observer', error) } } }

  const refresh = async (includeStorage = true): Promise<void> => {
    const request = ++epoch
    const pageIndex = historyIndex
    publish({ ...snapshot, status: 'loading', error: undefined })
    try {
      const [page, usage] = await Promise.all([api.view({ conversation: history[pageIndex] }),
        includeStorage ? api.retention({ action: 'stats' }).then(value => ({ value, error: undefined as string | undefined }),
          error => ({ value: snapshot.storageStats, error: errorMessage(error) })) : { value: snapshot.storageStats, error: snapshot.storageError }])
      if (request === epoch) {
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
      if (request === epoch) publish({ ...snapshot, status: 'error', error: errorMessage(error) })
    }
  }
  const historyPage = async (action: 'older' | 'newer' | 'latest' | 'date', date?: string): Promise<void> => {
    const previous = { history, historyIndex, historyPages }
    if (action === 'older') {
      const before = snapshot.value?.conversationBefore
      if (!before || snapshot.status === 'loading') return
      history = [...history.slice(0, historyIndex + 1), { ...history[historyIndex], before }]; historyIndex++
    } else if (action === 'newer') {
      if (historyIndex === 0 || snapshot.status === 'loading') return
      historyIndex--
    } else { history = [action === 'date' && date ? { date } : {}]; historyIndex = 0; historyPages = [] }
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
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => { scheduled = false; if (listeners.size) void refresh() })
  }
  const mutate = async (key: string, notice: ServantNotice['key'] | undefined, operation: () => Promise<unknown>): Promise<boolean> => {
    if (snapshot.pending.includes(key)) return false
    publish({ ...snapshot, pending: [...snapshot.pending, key] })
    try {
      const result = await operation()
      if (result && typeof result === 'object' && 'status' in result && (result.status === 'stale' || result.status === 'rejected')) {
        throw new Error('reason' in result && typeof result.reason === 'string' ? result.reason : result.status)
      }
      if (notice) notify({ kind: 'success', key: result && typeof result === 'object' && 'status' in result && result.status === 'queued' ? 'sent' : notice })
      await refresh()
      return true
    } catch (error) {
      notify({ kind: 'error', key: 'failed', detail: errorMessage(error) })
      await refresh()
      return false
    } finally {
      publish({ ...snapshot, pending: snapshot.pending.filter(item => item !== key) })
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
          disposers = [api.subscribeChanged(invalidate), api.subscribeReset(invalidate)]
          void refresh()
        }
        return () => {
          listeners.delete(listener)
          if (!listeners.size) { for (const dispose of disposers) dispose(); disposers = []; epoch += 1 }
        }
      },
    } satisfies HostObservable<ServantSnapshot>,
    refresh,
    historyPage,
    exportRecords: (taskId: string) => mutate('task:' + taskId, undefined, async () => {
      const result = await api.exportRecords({ taskId })
      notify({ kind: 'success', key: 'recordsExported', detail: result.path })
      return result
    }),
    readDeliveries: (taskIds: string[]) => Promise.all(taskIds.map(taskId => mutate('read:' + taskId, undefined, () => api.readDelivery({ taskId })))),
    send: (messageId: string, text: string, autoModel?: ModelRoute) => mutate('send', 'sent', () => api.send({ assistantId: assistantId(), messageId, text, autoModel })),
    configureRuntime: (expectedRevision: number, workerSeats: number) => mutate('configureRuntime', 'settingsSaved', () => api.configureRuntime({ expectedRevision, workerSeats })),
    configure: (expectedRevision: number, settings: AssistantSettings) => mutate('configure', 'settingsSaved', () => api.configure({ assistantId: assistantId(), expectedRevision, settings })),
    control: (taskId: string, intent: 'pause' | 'resume' | 'cancel' | 'stop', executionId?: string) => mutate(`task:${taskId}`, 'taskUpdated', () => api.control({ taskId, intent, executionId })),
    priority: (taskId: string, priority: number) => mutate(`task:${taskId}`, 'taskUpdated', () => api.priority({ taskId, priority })),
    reconcile: (taskId: string, executionId: string, evidence: string) => mutate(`task:${taskId}`, 'taskUpdated', () => api.reconcile({ taskId, executionId, confirmation: 'old-execution-stopped', evidence })),
    answer: (taskId: string, waitId: string, answer: string) => mutate(`task:${taskId}`, 'taskUpdated', () => api.answer({ taskId, waitId, answer })),
    revise: (taskId: string, expectedGoalRevision: number, goal: GoalInput) => mutate(`task:${taskId}`, 'taskUpdated', () => api.revise({ taskId, expectedGoalRevision, goal })),
    knowledge: (input: Record<string, unknown>) => mutate(`knowledge:${String(input.skillId ?? input.id)}`, 'knowledgeUpdated', () => api.knowledge({ ...input, assistantId: assistantId() })),
    moveRecords: (directory: string, expectedDirectory: string) => mutate('moveRecords', 'recordsMoved', () => api.moveRecords({ directory, expectedDirectory })),
    retention: (input: RetentionRequest) => mutate('retention', input.action === 'preview' ? undefined : input.action === 'configure' ? 'retentionPolicySaved' : 'retentionUpdated', async () => {
      const result = await api.retention(input)
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
        const preview = input.action === 'configure' ? await api.retention({ action: 'preview' }) : result
        if (!preview || typeof preview !== 'object' || !('previewId' in preview) || !('totals' in preview)) throw new Error('Invalid retention preview.')
        publish({ ...snapshot, retention: preview as RetentionPreview })
      }
      return result
    }),
  }
}

export type ServantSource = ReturnType<typeof createServantSource>

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
