import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateStorageUsage } from '../src/application/storage-usage.js'

test('T29-T31: Domain categories count every key once, including legacy fields; empty Domain stays zero', () => {
  const categories = ['conversations/a', 'assistant/a', 'knowledge/a', 'task-origin/a', 'records/a', 'task-history/a', 'foreground-memory/a/Foreground_List', 'foreground-memory/a/Foreground_Cache',
    'planner-memory/a', 'planner-note/a', 'worker-reply/a', 'execution/a', 'recovery/a']
  const rows: Array<{ key: string; value: unknown }> = categories.map(key => ({ key, value: { text: '完整正文 🙂' } }))
  rows.push({ key: 'task:legacy', value: { id: 'legacy', goal: { objective: 'Goal' }, decisions: [{ summary: 'Decision' }],
    plannerNote: { body: 'Full note' }, reports: { result: { summary: 'Full result' } }, executions: {}, pendingActions: {}, receipts: {}, incidents: {}, waits: {} } })
  const stats = calculateStorageUsage(rows, '2026-10-26T00:00:00Z')
  assert.equal(stats.totalBytes, rows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row.value)), 0))
  assert.equal(stats.permanentBytes + stats.temporaryBytes, stats.totalBytes)
  assert.ok(Object.values(stats.permanent).every(size => size > 0))
  assert.ok(Object.values(stats.temporary).every(size => size > 0))
  const legacy = calculateStorageUsage(rows.slice(-1), stats.recordedAt)
  assert.ok(legacy.temporary.plannerMemoryBytes > 0)
  assert.ok(legacy.temporary.plannerNoteBytes > 0)
  assert.ok(legacy.temporary.workerReplyBytes > 0)
  assert.equal(calculateStorageUsage([], stats.recordedAt).totalBytes, 0)
})
