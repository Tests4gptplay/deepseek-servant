import type { StoragePort } from '../contracts/ports.js'
import type { Task } from '../contracts/task.js'
import type { TaskTombstone } from '../contracts/retention.js'
import { assertTaskRecord } from '../domain/task.js'

/** No cache: failed writes never become an authoritative in-memory state. */
export class ServantStore {
  constructor(readonly storage: StoragePort) {}

  async getTask(id: string): Promise<Task | undefined> {
    const value = await this.storage.get<unknown>(`task:${id}`)
    if (value === undefined) return undefined
    if (isTaskTombstone(value)) { if (value.id !== id) throw new Error('Corrupt task tombstone identity'); return undefined }
    assertTaskRecord(value)
    if (value.id !== id) throw new Error(`Corrupt task record: expected ${id}, received ${value.id}`)
    return structuredClone(value)
  }

  async putTask(task: Task): Promise<void> {
    assertTaskRecord(task)
    // Optional DTO properties are omitted at the JSON boundary. The host's z.json
    // correctly rejects literal undefined values; they are not JSON storage data.
    const record = JSON.parse(JSON.stringify(task)) as Task
    assertTaskRecord(record)
    await this.storage.set(`task:${task.id}`, record)
  }

  async listTasks(): Promise<Task[]> {
    const rows = await this.storage.list<unknown>('task:')
    return rows.filter(({ value }) => !isTaskTombstone(value)).map(({ key, value }) => {
      assertTaskRecord(value)
      if (key !== `task:${value.id}`) throw new Error(`Corrupt task key: ${key}`)
      return structuredClone(value)
    })
  }

  async getTombstone(id: string): Promise<TaskTombstone | undefined> {
    const value = await this.storage.get<unknown>(`task:${id}`)
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

