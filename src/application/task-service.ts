import { createHash, randomUUID } from 'node:crypto'
import type { Clock } from '../contracts/ports.js'
import type { CommandReceipt, SubmitTaskInput, Task, TaskCommand } from '../contracts/task.js'
import type { ArchiveDeleteResult, TaskTombstone } from '../contracts/retention.js'
import { applyTaskCommand } from '../domain/task.js'
import { jsonBytes, retentionBlockers } from '../domain/retention.js'
import { ServantStore } from './servant-store.js'
import { TaskArchiveStore } from './task-archive-store.js'
import { exportTaskRecords } from './task-record-export.js'

export interface TaskServiceOptions { clock?: Clock; id?: () => string; reviewEvery?: number; onNotificationError?: (error: unknown) => void }
export type TaskListener = (task: Task, receipt: CommandReceipt) => void | Promise<void>

export class TaskService {
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly listeners = new Set<TaskListener>()
  private readonly clock: Clock
  private readonly id: () => string
  private readonly reviewEvery: number
  readonly archives: TaskArchiveStore

  constructor(readonly store: ServantStore, private readonly options: TaskServiceOptions = {}) {
    this.clock = options.clock ?? { now: () => new Date().toISOString() }
    this.id = options.id ?? randomUUID
    this.archives = new TaskArchiveStore(store.storage, () => this.clock.now())
    this.reviewEvery = options.reviewEvery ?? 5
    if (!Number.isInteger(this.reviewEvery) || this.reviewEvery < 1) throw new Error('reviewEvery must be a positive integer')
  }

  async submit(input: SubmitTaskInput): Promise<CommandReceipt> {
    // A stable external message/command produces one deterministic logical task,
    // including after a process restart before the caller received the reply.
    const taskId = input.taskId ?? `task-${createHash('sha256').update(`${input.assistantId}\0${input.commandId}`).digest('hex').slice(0, 32)}`
    return this.execute(taskId, { ...input, type: 'task.submit', taskId })
  }

  async execute(taskId: string, input: TaskCommand): Promise<CommandReceipt> {
    const command = structuredClone(input)
    const fingerprint = createHash('sha256').update(canonical(command)).digest('hex')
    const previous = this.queues.get(taskId) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(async () => {
      const current = await this.store.getTask(taskId)
      const tombstone = !current && await this.store.getTombstone(taskId)
      if (tombstone && command.type === 'delivery.read' && command.source.kind === 'user') {
        await this.archives.markDeliveryRead(taskId)
        const receipt: CommandReceipt = { commandId: command.commandId, taskId, status: 'applied', revision: tombstone.revision, actionIds: [] }
        const task = await this.archives.task(taskId)
        if (task) for (const listener of this.listeners) {
          try { void Promise.resolve(listener(structuredClone(task), receipt)).catch(error => this.options.onNotificationError?.(error)) }
          catch (error) { this.options.onNotificationError?.(error) }
        }
        return receipt
      }
      if (tombstone) return { commandId: command.commandId, taskId, status: 'rejected' as const, revision: tombstone.revision,
        actionIds: [], code: 'TASK_RETIRED', reason: 'This task identity is permanently retired; submit a new goal with a new identity.' }
      if (command.type === 'task.submit' && command.taskId !== taskId) throw new Error('Task command target mismatch')
      if (!current && command.type !== 'task.submit') return { commandId: command.commandId, taskId, status: 'rejected' as const, revision: 0, actionIds: [], code: 'TASK_NOT_FOUND', reason: 'Task does not exist.' }
      const transition = applyTaskCommand(current, command, { now: this.clock.now(), fingerprint, reviewEvery: this.reviewEvery })
      if (transition.changed && transition.task) {
        await this.store.putTask(transition.task, current)
        for (const listener of this.listeners) {
          // Notifications are hints, never part of the storage commit or a reason
          // to roll back an accepted command. Recovery scans durable actions.
          try {
            void Promise.resolve(listener(structuredClone(transition.task), structuredClone(transition.receipt)))
              .catch(error => this.options.onNotificationError?.(error))
          } catch (error) { this.options.onNotificationError?.(error) }
        }
      }
      return transition.receipt
    })
    this.queues.set(taskId, pending)
    try { return await pending } finally { if (this.queues.get(taskId) === pending) this.queues.delete(taskId) }
  }

  async get(taskId: string): Promise<Task | undefined> { return await this.store.getTask(taskId) ?? await this.archives.task(taskId) }
  async history(includeHidden = false): Promise<Task[]> {
    const rows = (await this.archives.list()).filter(row => row.tombstone && (includeHidden || !row.hidden))
    const tasks: Task[] = []
    for (const row of rows) {
      try {
        const task = await this.archives.task(row.taskId)
        this.store.problems.delete(row.taskId)
        if (task) tasks.push(task)
      } catch (error) {
        const message = row.taskId + ': ' + (error instanceof Error ? error.message : String(error))
        if (this.store.problems.get(row.taskId) !== message) this.options.onNotificationError?.(error)
        this.store.problems.set(row.taskId, message)
      }
    }
    return tasks
  }
  async exportRecords(taskId: string): Promise<{ path: string; sha256: string; bytes: number }> {
    const task = await this.get(taskId)
    if (!task) throw new Error('Task does not exist.')
    return exportTaskRecords(this.archives, taskId, task.workspace.directory)
  }
  async prepareDelivery(taskId: string): Promise<void> {
    const task = await this.store.getTask(taskId)
    if (!task?.delivery) throw new Error('Records require the accepted task delivery.')
    await this.archives.seal(task, 'accepted')
  }
  /** Completion cleanup shares the same Task queue as every business write. */
  async cleanupCompleted(taskId: string): Promise<boolean> {
    const previous = this.queues.get(taskId) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(async () => {
      const task = await this.store.getTask(taskId)
      if (!task || retentionBlockers(task).length) return false
      await this.archives.cleanup(task)
      return true
    })
    this.queues.set(taskId, pending)
    try { return await pending } finally { if (this.queues.get(taskId) === pending) this.queues.delete(taskId) }
  }
  list(): Promise<Task[]> { return this.store.listTasks() }
  subscribe(listener: TaskListener): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  async flush(): Promise<void> { await Promise.allSettled([...this.queues.values()]) }
  newId(): string { return this.id() }

  /** Header expiry shares the exact Task command queue and leaves a permanent replay fence. */
  async deleteArchived(taskId: string, expectedRevision: number, purgeId: string, pinnedResultIds: string[]): Promise<ArchiveDeleteResult> {
    const previous = this.queues.get(taskId) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(async (): Promise<ArchiveDeleteResult> => {
      const task = await this.store.getTask(taskId)
      if (!task || task.revision !== expectedRevision) return { status: 'stale', reason: 'Task archive changed.' }
      if (!task.archive || task.archive.purgeId !== purgeId) return { status: 'blocked', reason: 'A matching committed archive is required.' }
      if (retentionBlockers(task).length) return { status: 'blocked', reason: 'Task is no longer quiescent.' }
      if (pinnedResultIds.some(id => Object.hasOwn(task.reports, id))) return { status: 'blocked', reason: 'Knowledge still references result evidence in this archive.' }
      if (task.archive.memoryState !== 'done' || task.archive.sessions.some(session => !['archived', 'absent'].includes(session.state))) {
        return { status: 'blocked', reason: 'Durable cleanup manifest still has unfinished work.' }
      }
      const tombstone: TaskTombstone = {
        schemaVersion: 1, kind: 'task-tombstone', id: task.id, assistantId: task.assistantId, workspaceId: task.workspace.id,
        revision: task.revision + 1, retiredAt: this.clock.now(),
        nativeLogsRetained: task.archive.sessions.filter(session => session.logRetained).length,
        nativeBytesRetained: task.archive.sessions.reduce((sum, session) => sum + (session.logRetained ? session.retainedBytes ?? 0 : 0), 0),
        nativeSizeUnknown: task.archive.sessions.filter(session => session.logRetained && session.retainedBytes === undefined).length,
      }
      await this.store.putTombstone(tombstone)
      const receipt: CommandReceipt = { commandId: `retention-delete:${purgeId}`, taskId, status: 'applied', revision: tombstone.revision, actionIds: [] }
      for (const listener of this.listeners) {
        try { void Promise.resolve(listener(structuredClone(task), receipt)).catch(error => this.options.onNotificationError?.(error)) }
        catch (error) { this.options.onNotificationError?.(error) }
      }
      return { status: 'deleted', reclaimedBytes: Math.max(0, jsonBytes(task) - jsonBytes(tombstone)) }
    })
    this.queues.set(taskId, pending)
    try { return await pending } finally { if (this.queues.get(taskId) === pending) this.queues.delete(taskId) }
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
