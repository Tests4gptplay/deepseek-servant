import type { StoragePort } from '../contracts/ports.js'
import type { Task } from '../contracts/task.js'
import type { TaskTombstone } from '../contracts/retention.js'
import { assertTaskRecord } from '../domain/task.js'
import { RecordJournal, canonicalJson } from './record-journal.js'
import { isSeparatedTask, TaskRecords, type PreparedTask } from './task-records.js'

/** No cache: failed writes never become an authoritative in-memory state. */
export class ServantStore {
  readonly journal: RecordJournal
  readonly records: TaskRecords
  readonly problems = new Map<string, string>()
  private readonly queues = new Map<string, Promise<unknown>>()
  constructor(readonly storage: StoragePort) {
    this.journal = new RecordJournal(storage)
    this.records = new TaskRecords(this.journal)
  }

  private serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(action)
    this.queues.set(id, pending)
    return pending.finally(() => { if (this.queues.get(id) === pending) this.queues.delete(id) })
  }

  private stageKey(id: string): string { return 'task-staging/' + encodeURIComponent(id) + '/commit' }

  private async recover(id: string): Promise<void> {
    const stage = await this.storage.get<PreparedTask>(this.stageKey(id))
    if (!stage) return
    if (stage.schemaVersion !== 1 || stage.root.id !== id) throw new Error('Invalid pending Task commit.')
    const current = await this.storage.get<{ revision: number }>(`task:${id}`)
    if (!current || current.revision < stage.root.revision || !isSeparatedTask(current)) {
      if ((current?.revision ?? 0) !== stage.expectedRevision) throw new Error('Pending Task commit has a different base revision.')
      await this.records.write(stage)
      // Migration reads every original field back before retiring the inline copy.
      if (current && !isSeparatedTask(current)) {
        const restored = await this.records.hydrate(stage.root)
        if (canonicalJson(restored) !== canonicalJson(current)) throw new Error('Legacy Task migration readback mismatch.')
      }
      await this.storage.set(`task:${id}`, stage.root)
    }
    await this.storage.delete?.(this.stageKey(id))
  }

  private async load(id: string): Promise<Task | undefined> {
    await this.recover(id)
    let value = await this.storage.get<unknown>(`task:${id}`)
    if (value === undefined) return undefined
    if (isTaskTombstone(value)) { if (value.id !== id) throw new Error('Corrupt task tombstone identity'); return undefined }
    if (!isSeparatedTask(value)) {
      assertTaskRecord(value)
      const stage = this.records.prepare(value)
      stage.expectedRevision = value.revision
      await this.storage.set(this.stageKey(id), stage)
      await this.recover(id)
      value = await this.storage.get<unknown>(`task:${id}`)
    }
    const task = isSeparatedTask(value) ? await this.records.hydrate(value) : value
    assertTaskRecord(task)
    if (task.id !== id) throw new Error(`Corrupt task record: expected ${id}, received ${task.id}`)
    return task
  }

  getTask(id: string): Promise<Task | undefined> { return this.serial(id, () => this.load(id)) }

  putTask(task: Task, previous?: Task): Promise<void> {
    return this.serial(task.id, async () => {
      assertTaskRecord(task)
      const record = JSON.parse(JSON.stringify(task)) as Task
      const current = previous ?? await this.load(task.id)
      const prepared = this.records.prepare(record, current)
      await this.storage.set(this.stageKey(task.id), prepared)
      await this.recover(task.id)
    })
  }

  async listTasks(): Promise<Task[]> {
    const rows = await this.storage.list<unknown>('task:')
    // A newly submitted Task can have only its recoverable stage when the Host stops.
    const stages = await this.storage.list<PreparedTask>('task-staging/')
    const ids = new Set(rows.filter(({ value }) => !isTaskTombstone(value)).map(({ key }) => key.slice(5)))
    for (const { value } of stages) if (value?.schemaVersion === 1 && value.root?.id) ids.add(value.root.id)
    const tasks: Task[] = []
    for (const id of ids) {
      try {
        const task = await this.getTask(id)
        this.problems.delete(id)
        if (task) tasks.push(task)
      } catch (error) {
        const message = id + ': ' + (error instanceof Error ? error.message : String(error))
        if (this.problems.get(id) !== message) console.error('deepseek-servant task', message)
        this.problems.set(id, message)
      }
    }
    return tasks
  }

  async getTombstone(id: string): Promise<TaskTombstone | undefined> {
    const value = await this.storage.get<unknown>(`task:${id}`)
      ?? (await this.storage.get<{ tombstone?: TaskTombstone }>('task-history/' + encodeURIComponent(id)))?.tombstone
    if (!isTaskTombstone(value)) return undefined
    if (value.id !== id) throw new Error('Corrupt task tombstone identity')
    return structuredClone(value)
  }

  /** Same-key replacement: no absent interval in which an old task could be recreated. */
  async putTombstone(value: TaskTombstone): Promise<void> {
    if (!isTaskTombstone(value)) throw new Error('Invalid task tombstone')
    await this.storage.set(`task:${value.id}`, structuredClone(value))
  }
}

export function isTaskTombstone(value: unknown): value is TaskTombstone {
  if (!value || typeof value !== 'object' || !('kind' in value) || value.kind !== 'task-tombstone') return false
  const item = value as TaskTombstone
  if (item.schemaVersion !== 1 || typeof item.id !== 'string' || typeof item.assistantId !== 'string'
    || typeof item.workspaceId !== 'string' || !Number.isInteger(item.revision) || item.revision < 1 || typeof item.retiredAt !== 'string') {
    throw new Error('Corrupt task tombstone')
  }
  return true
}

