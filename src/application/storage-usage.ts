import type { StorageUsageStats } from '../contracts/retention.js'
import { jsonBytes } from '../domain/retention.js'

type UsageRows = ReadonlyArray<{ key: string; value: unknown }>
type LongCategory = keyof StorageUsageStats['permanent']
type TaskCategory = keyof StorageUsageStats['temporary']

/** Account for every persisted deepseek_servant JSON value exactly once.
 * Never include DSH Session Persistence logs or workspace artifacts.
 */
export function calculateStorageUsage(rows: UsageRows, recordedAt: string): StorageUsageStats {
  const permanent: StorageUsageStats['permanent'] = {
    chatBytes: 0, assistantBytes: 0, knowledgeBytes: 0,
    originBytes: 0, archiveBytes: 0, historyBytes: 0,
  }
  const temporary: StorageUsageStats['temporary'] = {
    taskBytes: 0, plannerMemoryBytes: 0, plannerNoteBytes: 0,
    workerReplyBytes: 0, executionBytes: 0, recoveryBytes: 0,
  }
  const addPermanent = (category: LongCategory, size: number) => { permanent[category] += size }
  const addTemporary = (category: TaskCategory, size: number) => { temporary[category] += size }

  for (const { key, value } of rows) {
    const size = jsonBytes(value)
    if (key.startsWith('task:')) {
      // Old Tasks contain memory, notes, reports and runtime details inline.
      // Split their serialized field byte sizes without double counting.
      if (isTombstone(value)) addPermanent('historyBytes', size)
      else splitLegacyTask(value, size, addTemporary)
    } else if (key.startsWith('conversations/') || key.startsWith('conversation/')) {
      addPermanent('chatBytes', size)
    } else if (key.startsWith('knowledge/')) {
      addPermanent('knowledgeBytes', size)
    } else if (key.startsWith('task-origin/') || key.startsWith('goal-origin/')) {
      addPermanent('originBytes', size)
    } else if (key.startsWith('records/') || key.startsWith('record-archive/')) {
      addPermanent('archiveBytes', size)
    } else if (key.startsWith('task-history/') || key.startsWith('tombstone/')) {
      addPermanent('historyBytes', size)
    } else if (key.startsWith('planner-memory/') || key.startsWith('memory/planner/')) {
      addTemporary('plannerMemoryBytes', size)
    } else if (key.startsWith('planner-note/')) {
      addTemporary('plannerNoteBytes', size)
    } else if (key.startsWith('worker-reply/') || key.startsWith('memory/worker/')) {
      addTemporary('workerReplyBytes', size)
    } else if (key.startsWith('recovery/') || key.startsWith('incident/') || key.startsWith('wait/')) {
      addTemporary('recoveryBytes', size)
    } else if (key.startsWith('execution/') || key.startsWith('task-runtime/')
      || key.startsWith('handoff/') || key.startsWith('task-turn/')) {
      addTemporary('executionBytes', size)
    } else if (key.startsWith('task-staging/') || key.startsWith('records-staging/')) {
      addTemporary('taskBytes', size)
    } else {
      // Assistant records, retention settings and other domain-level metadata.
      addPermanent('assistantBytes', size)
    }
  }
  const permanentBytes = Object.values(permanent).reduce((sum, value) => sum + value, 0)
  const temporaryBytes = Object.values(temporary).reduce((sum, value) => sum + value, 0)
  const totalBytes = rows.reduce((sum, row) => sum + jsonBytes(row.value), 0)
  if (permanentBytes + temporaryBytes !== totalBytes) throw new Error('Servant storage breakdown does not match total bytes.')
  return { totalBytes, permanentBytes, temporaryBytes, recordedAt, permanent, temporary }
}

function isTombstone(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (value as { kind?: unknown }).kind === 'task-tombstone'
}

function splitLegacyTask(value: unknown, total: number, add: (category: TaskCategory, size: number) => void): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    add('taskBytes', total)
    return
  }
  const object = value as Record<string, unknown>
  const fields: ReadonlyArray<readonly [string, TaskCategory]> = [
    ['decisions', 'plannerMemoryBytes'],
    ['plannerNote', 'plannerNoteBytes'],
    ['reports', 'workerReplyBytes'],
    ['executions', 'executionBytes'],
    ['pendingActions', 'executionBytes'],
    ['receipts', 'executionBytes'],
    ['incidents', 'recoveryBytes'],
    ['waits', 'recoveryBytes'],
  ]
  let remainder = total
  for (const [field, category] of fields) {
    if (!Object.hasOwn(object, field)) continue
    // Remove only the field's exact serialized key+value; root braces and
    // separating commas remain allocated to the parent Task.
    const size = jsonBytes({ [field]: object[field] }) - 2
    if (size > 0 && size <= remainder) { add(category, size); remainder -= size }
  }
  add('taskBytes', remainder)
}
