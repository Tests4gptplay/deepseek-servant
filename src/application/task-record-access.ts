import type { CommandSource, ExecutionBinding, Role, Task } from '../contracts/task.js'
import type { RecordEntry, RecordScope, RecordSummary } from '../contracts/records.js'
import type { TaskService } from './task-service.js'
import { readTaskMemoryText } from '../runtime/context-assembler.js'

export interface RecordCaller { assistantId: string; role: Role; taskId?: string; executionId?: string; agentId?: string; sessionId?: string }
function summary(entry: RecordEntry): RecordSummary {
  const { parts: _parts, fingerprint: _fingerprint, ...value } = entry
  return value
}
function scopeChildren(task: Task, execution: ExecutionBinding): Set<string> {
  const ids = new Set<string>()
  const add = (id: string) => { if (ids.has(id)) return; ids.add(id); for (const dep of task.children[id]?.dependsOn ?? []) add(dep) }
  if (execution.childId) add(execution.childId)
  return ids
}

/** Role-owned full-text access. Runtime identity comes from the bound native Agent. */
export class TaskRecordAccess {
  constructor(private readonly tasks: TaskService, private readonly caller: RecordCaller) {}
  private get journal() { return this.tasks.store.journal }

  private async task(scope: RecordScope, write = false): Promise<Task> {
    if (!scope.taskId || scope.kind === 'conversation') throw new Error('A task record scope is required.')
    if (this.caller.role !== 'foreground' && scope.taskId !== this.caller.taskId) throw new Error('RECORD_SCOPE: This role is bound to another task.')
    const task = await this.tasks.get(scope.taskId)
    if (!task || task.assistantId !== this.caller.assistantId) throw new Error('RECORD_SCOPE: Task belongs to another assistant.')
    if (this.caller.role === 'foreground') {
      if (write) throw new Error('RECORD_ROLE: Planning and Worker records are written by their bound roles.')
      return task
    }
    const execution = task.executions[this.caller.executionId!]
    if (!execution || execution.role !== this.caller.role || execution.agentId !== this.caller.agentId || execution.sessionId !== this.caller.sessionId) throw new Error('RECORD_OWNER: Execution belongs to another native owner.')
    if (write) {
      if (execution.state !== 'active' || task.archive || task.control === 'cancelled') throw new Error('RECORD_OWNER: Execution has ended.')
      if (scope.kind === 'planner-memory' && execution.role !== 'planner'
        || scope.kind === 'worker-reply' && (execution.role !== 'worker' || scope.childId !== execution.childId)) throw new Error('RECORD_ROLE: The record family belongs to another role.')
      if (execution.role === 'planner' && task.pendingActions[execution.actionId]?.payload.goalRevision !== task.goal.revision) throw new Error('GOAL_CHANGED: Read the current user requirements.')
    }
    if (execution.role === 'worker') {
      if (scope.kind === 'planner-memory' || scope.kind === 'planner-note') throw new Error('RECORD_ROLE: Read the assigned Child and its dependency results.')
      if (scope.kind === 'worker-reply' && !scopeChildren(task, execution).has(scope.childId!)) throw new Error('RECORD_SCOPE: Child is outside this assignment and its dependencies.')
    }
    return task
  }

  private visible(entry: RecordEntry, task: Task): boolean {
    if (typeof entry.metadata.taskRevision === 'number' && entry.metadata.taskRevision > task.revision) return false
    if (this.caller.role !== 'worker' || entry.scope.kind !== 'execution') return true
    const execution = task.executions[this.caller.executionId!]!
    const children = scopeChildren(task, execution), key = String(entry.metadata.recordKey)
    if (entry.metadata.field === 'children') return children.has(key)
    if (entry.metadata.field === 'executions') return children.has(task.executions[key]?.childId ?? '')
    if (entry.metadata.field === 'pendingActions') return children.has(task.pendingActions[key]?.payload.childId ?? '')
    return false
  }

  async read(ref: string, cursor = 0, limit = 8192) {
    const logical = /^servant-memory:\/\/tasks\/([^/]+)\//.exec(ref)
    if (logical) {
      const task = await this.task({ kind: 'execution', taskId: decodeURIComponent(logical[1]!) })
      return readTaskMemoryText(task, this.caller.role === 'foreground' ? undefined : task.executions[this.caller.executionId!], ref, cursor, limit)
    }
    const entry = await this.journal.manifest(ref), task = await this.task(entry.scope)
    if (!this.visible(entry, task)) throw new Error('RECORD_SCOPE: Record is outside this published task context.')
    return this.journal.read(ref, cursor, limit)
  }

  async page(scope: RecordScope, query?: string, cursor = 0, limit = 20) {
    const task = await this.task(scope)
    if (!Number.isInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid record page.')
    const entries = (await this.journal.entries(scope)).filter(entry => this.visible(entry, task))
    const candidates = entries.filter(entry => entry.sequence > cursor), matches: Array<{ entry: RecordSummary; excerpt?: string }> = []
    for (let index = 0; index < candidates.length; index++) {
      const entry = candidates[index]!
      if (query) {
        const body = await this.journal.fullText(entry.ref), position = body.toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
        if (position < 0) continue
        matches.push({ entry: summary(entry), excerpt: body.slice(Math.max(0, position - 100), position + Math.min(query.length, 300) + 160) })
      } else matches.push({ entry: summary(entry) })
      if (matches.length === limit) return { entries: matches, revision: entries.at(-1)?.sequence ?? 0,
        ...(index + 1 < candidates.length ? { nextCursor: entry.sequence } : {}) }
    }
    return { entries: matches, revision: entries.at(-1)?.sequence ?? 0 }
  }

  async append(kind: 'planner-memory' | 'worker-reply', text: string, commandId: string) {
    const current = await this.tasks.get(this.caller.taskId!)
    const owner = current?.executions[this.caller.executionId!]
    const scope: RecordScope = { kind, taskId: this.caller.taskId, ...(kind === 'worker-reply' ? { childId: owner?.childId } : {}) }
    await this.task(scope)
    const source: CommandSource = { kind: 'agent', id: this.caller.agentId!, role: this.caller.role, executionId: this.caller.executionId!, sessionId: this.caller.sessionId }
    const existing = await this.journal.byCommand(scope, commandId)
    if (existing) return this.journal.append({ scope, text, commandId, source, metadata: existing.metadata })
    const task = await this.task(scope, true)
    return this.journal.append({ scope, text, commandId, source, metadata: {
      writer: this.caller.role, actionId: owner!.actionId, goalRevision: task.goal.revision,
      ...(owner!.assignmentVersion ? { assignmentVersion: owner!.assignmentVersion } : {}),
    } })
  }

  async note(taskId = this.caller.taskId, part: 'body' | 'backlog' = 'body', cursor = 0, limit?: number) {
    const task = await this.task({ kind: 'planner-note', taskId })
    const note = task.plannerNote
    if (!note) return { revision: 0, goalRevision: task.goal.revision, body: '', backlog: [], bodyCharacters: 0 }
    const entries = (await this.journal.entries({ kind: 'planner-note', taskId })).filter(entry => this.visible(entry, task))
    const recordRef = entries.at(-1)?.ref
    const pageLimit = limit ?? (part === 'body' ? 8192 : 20)
    if (!Number.isInteger(cursor) || cursor < 0 || !Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > (part === 'body' ? 32768 : 100)) throw new Error('Invalid note page.')
    const total = part === 'body' ? note.body.length : (note.backlog?.length ?? 0)
    const end = Math.min(total, cursor + pageLimit)
    return { revision: note.revision, goalRevision: note.goalRevision, frontier: note.frontier.slice(0, 1200), recordRef,
      bodyCharacters: note.body.length, backlogCount: note.backlog?.length ?? 0,
      requiredPendingCount: note.backlog?.filter(item => item.required && item.status === 'pending').length ?? 0,
      part, cursor, ...(end < total ? { nextCursor: end } : {}),
      ...(part === 'body' ? { body: note.body.slice(cursor, end) } : { backlog: (note.backlog ?? []).slice(cursor, end).map(item => ({
        ...item, objective: item.objective.slice(0, 1200), reason: item.reason.slice(0, 800), trigger: item.trigger.slice(0, 800),
        textExcerpted: item.objective.length > 1200 || item.reason.length > 800 || item.trigger.length > 800,
      })) }),
    }
  }

  async context(task: Task, execution: ExecutionBinding) {
    const scopes: RecordScope[] = [{ kind: 'task-origin', taskId: task.id }]
    if (execution.role === 'planner') scopes.push({ kind: 'planner-memory', taskId: task.id }, { kind: 'planner-note', taskId: task.id })
    if (execution.childId) scopes.push({ kind: 'worker-reply', taskId: task.id, childId: execution.childId })
    const streams = await Promise.all(scopes.map(async scope => {
      const entries = (await this.journal.entries(scope)).filter(entry => this.visible(entry, task))
      const selected = entries.slice(-3)
      return { scope, totalEntries: entries.length, recent: await Promise.all(selected.map(async entry => ({
        ref: entry.ref, sequence: entry.sequence, createdAt: entry.createdAt, characters: entry.characters,
        ...(execution.role === 'worker' && scope.kind === 'task-origin' ? {} : { excerpt: (await this.journal.read(entry.ref, 0, 1000)).text }),
      }))) }
    }))
    const assignments = (execution.childId ? await this.journal.entries({ kind: 'execution', taskId: task.id }) : [])
      .filter(entry => entry.metadata.field === 'children' && entry.metadata.recordKey === execution.childId && this.visible(entry, task))
    return { streams, assignmentRef: assignments.at(-1)?.ref,
      read: 'memory_read(ref, cursor, limit) returns exact text pages; memory_search lists/searches record streams.',
      note: execution.role === 'planner' ? { revision: task.plannerNote?.revision ?? 0, bodyCharacters: task.plannerNote?.body.length ?? 0,
        backlogCount: task.plannerNote?.backlog?.length ?? 0, requiredPendingCount: task.plannerNote?.backlog?.filter(item => item.required && item.status === 'pending').length ?? 0 } : undefined }
  }
}
