import { createHash } from 'node:crypto'
import type { CommandSource, Task } from '../contracts/task.js'
import type { RecordAppend, RecordEntry, RecordKind } from '../contracts/records.js'
import { canonicalJson, RecordJournal } from './record-journal.js'

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
function values(task: Task | undefined, field: Field): Map<string, unknown> {
  const value = task?.[field]
  if (value === undefined) return new Map()
  if (scalar.has(field)) return new Map([['current', value]])
  if (arrays.has(field)) return new Map((value as Array<{ commandId: string }>).map(entry => [entry.commandId, entry]))
  return new Map(Object.entries(value))
}
function recordKind(field: Field): RecordKind {
  if (field === 'goal' || field === 'goalHistory') return 'task-origin'
  if (field === 'plannerNote') return 'planner-note'
  if (field === 'decisions') return 'planner-memory'
  if (field === 'reports') return 'worker-reply'
  return field === 'waits' || field === 'incidents' ? 'recovery' : 'execution'
}

/** Versioned cold records publish through one small Task root. Pending commits resume before reads. */
export class TaskRecords {
  constructor(readonly journal: RecordJournal) {}

  prepare(task: Task, previous?: Task): PreparedTask {
    const root = JSON.parse(JSON.stringify(task)) as StoredTask
    const storedFields = fields.filter(field => task[field] !== undefined)
    root.recordsLayout = { version: 1, fields: storedFields,
      counts: Object.fromEntries(storedFields.map(field => [field, values(task, field).size])) }
    const writes: RecordAppend[] = []
    for (const field of fields) {
      const before = values(previous, field), after = values(task, field)
      for (const id of new Set([...before.keys(), ...after.keys()])) {
        const old = before.get(id), value = after.get(id)
        if (previous && canonicalJson(old) === canonicalJson(value)) continue
        const text = canonicalJson(value)
        const hash = createHash('sha256').update(text).digest('hex')
        const report = field === 'reports' ? (value ?? old) as Task['reports'][string] : undefined
        const binding = report ? task.executions[report.executionId] : undefined
        const source: CommandSource = binding
          ? { kind: 'agent', id: binding.agentId, executionId: binding.executionId, sessionId: binding.sessionId, role: binding.role }
          : field === 'goal' ? task.source : { kind: 'runtime', id: 'deepseek-servant-records' }
        writes.push({ scope: { kind: recordKind(field), taskId: task.id, ...(report ? { childId: report.childId } : {}) },
          commandId: 'capture:' + task.revision + ':' + field + ':' + id + ':' + hash,
          text, source, createdAt: task.updatedAt,
          metadata: { field, recordKey: id, taskRevision: task.revision, deleted: value === undefined } })
      }
      delete root[field]
    }
    return { schemaVersion: 1, expectedRevision: previous?.revision ?? 0, root, writes }
  }

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
