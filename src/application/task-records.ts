import type { Task } from '../contracts/task.js'
import type { RecordAppend, RecordEntry } from '../contracts/records.js'
import { RecordJournal } from './record-journal.js'

const fields = ['goal', 'goalHistory', 'plannerNote', 'plan', 'children', 'reports', 'executions', 'pendingActions', 'receipts', 'waits', 'incidents', 'decisions'] as const
type Field = typeof fields[number]
const scalar = new Set<Field>(['goal', 'plannerNote', 'plan'])
const arrays = new Set<Field>(['goalHistory', 'decisions'])
interface Layout { version: 1; fields: Field[]; counts?: Partial<Record<Field, number>> }
export type StoredTask = Partial<Task> & Pick<Task, 'id' | 'revision'> & { recordsLayout: Layout }
export interface PreparedTask { schemaVersion: 1; expectedRevision: number; root: StoredTask; writes: RecordAppend[] }
export function isSeparatedTask(value: unknown): value is StoredTask {
  return !!value && typeof value === 'object' && (value as StoredTask).recordsLayout?.version === 1
}
/** Retained legacy reader and pending-write replay for separated Task roots. */
export class TaskRecords {
  constructor(readonly journal: RecordJournal) {}

  async write(prepared: PreparedTask): Promise<void> {
    for (const entry of prepared.writes) await this.journal.append(entry)
  }

  async entries(taskId: string, maximumRevision = Number.POSITIVE_INFINITY): Promise<RecordEntry[]> {
    const result: RecordEntry[] = []
    for (const kind of ['task-origin', 'planner-memory', 'planner-note', 'worker-reply', 'execution', 'recovery']) {
      const rows = await this.journal.storage.list<unknown>(kind + '/' + encodeURIComponent(taskId) + '/')
      for (const { value } of rows) {
        const entry = value as RecordEntry
        if (entry?.kind === 'servant-record-entry' && entry.scope.taskId === taskId
          && typeof entry.metadata.taskRevision === 'number' && entry.metadata.taskRevision <= maximumRevision
          && fields.includes(entry.metadata.field as Field)) result.push(entry)
      }
    }
    return result
  }

  async hydrate(root: StoredTask): Promise<Task> {
    const result = structuredClone(root) as unknown as Task & { recordsLayout?: Layout }
    delete result.recordsLayout
    const selected = new Map<string, RecordEntry>()
    for (const entry of await this.entries(root.id, root.revision)) {
      const key = entry.metadata.field + ':' + entry.metadata.recordKey
      const prior = selected.get(key)
      if (!prior || Number(entry.metadata.taskRevision) > Number(prior.metadata.taskRevision)) selected.set(key, entry)
    }
    for (const field of root.recordsLayout.fields) {
      const entries = [...selected.values()].filter(entry => entry.metadata.field === field && !entry.metadata.deleted)
        .sort((a, b) => Number(a.metadata.taskRevision) - Number(b.metadata.taskRevision) || a.sequence - b.sequence)
      const expected = root.recordsLayout.counts?.[field]
      if (expected !== undefined && entries.length !== expected) throw new Error('Task records incomplete: ' + root.id + '/' + field)
      const contents = await Promise.all(entries.map(async entry => [String(entry.metadata.recordKey), JSON.parse(await this.journal.fullText(entry.ref))] as const))
      const value = scalar.has(field) ? contents[0]?.[1] : arrays.has(field) ? contents.map(([, value]) => value) : Object.fromEntries(contents)
      Object.defineProperty(result, field, { value, enumerable: true, writable: true, configurable: true })
    }
    return result
  }
}
