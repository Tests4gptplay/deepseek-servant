import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, stat, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RecordFilesBackend, ensureRecordTree, recordFolder, recordFileUsage } from '../src/adapters/dsh/record-files.js'
import { calculateStorageUsage } from '../src/application/storage-usage.js'

test('physical storage bytes include JSON wrappers and backups and drop deleted record folders', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dss-byte-accounting-'))
  const backend = new RecordFilesBackend(root)
  const rows = [
    { key: 'task:old', value: { kind: 'task-tombstone', id: 'old', revision: 1 } },
    { key: 'assistant-history/default/delivery/old', value: { taskId: 'old', status: 'sent' } },
    { key: 'settings/runtime', value: { workerSeats: 2 } },
  ]
  try {
    await ensureRecordTree(root)
    const unit = await backend.kv.open({ name: 'deepseek_servant', version: 1, tables: ['records'], hasGlobal: false })
    for (const row of rows) await unit.putRecord('records', row.key, row)
    await writeFile(join(root, 'backups', 'example.json'), '{}\n')
    const files = await recordFileUsage(root, rows.map(row => row.key))
    const usage = calculateStorageUsage(rows, 'now', files)
    assert.equal(usage.totalBytes, files.reduce((sum, file) => sum + file.bytes, 0))
    const archives = await Promise.all(rows.slice(0, 2).map(row => stat(join(root, recordFolder(row.key), 'record.json'))))
    assert.equal(usage.permanent.archiveBytes, archives.reduce((sum, file) => sum + file.size, 0))
    assert.ok(usage.permanent.archiveBytes > rows.slice(0, 2).reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row.value)), 0))
    assert.equal(usage.permanent.otherBytes, 3)
    for (const row of rows.slice(0, 2)) {
      await unit.deleteRecord('records', row.key)
      await assert.rejects(stat(join(root, recordFolder(row.key))), { code: 'ENOENT' })
    }
    const remaining = await recordFileUsage(root, rows.slice(2).map(row => row.key))
    assert.equal(calculateStorageUsage(rows.slice(2), 'now', remaining).permanent.archiveBytes, 0)
  } finally { await backend.close(); await rm(root, { recursive: true, force: true }) }
})

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
