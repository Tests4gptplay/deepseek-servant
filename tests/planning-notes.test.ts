import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rename, stat, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { RecordFilesBackend, ensureRecordTree, recordFolder } from '../src/adapters/dsh/record-files.js'
import { AssistantService } from '../src/application/assistant-service.js'
import { calculateStorageUsage } from '../src/application/storage-usage.js'
import { MemoryStorage } from './support.js'

test('planning notes are counted separately and history is included in archives exactly once', () => {
  const rows = ['foreground-memory/default/Foreground_List', 'foreground-memory/default/Foreground_Cache',
    'records/one', 'task-history/one', 'tombstone/one'].map(key => ({ key, value: { text: key } }))
  const size = (prefix: string) => rows.filter(row => row.key.startsWith(prefix)).reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row.value)), 0)
  const stats = calculateStorageUsage(rows, '2026-10-27')
  assert.equal(stats.permanent.planningBytes, size('foreground-memory/'))
  assert.equal(stats.permanent.archiveBytes, size('records/') + size('task-history/') + size('tombstone/'))
  assert.equal(Object.keys(stats.permanent).length, 6)
  assert.equal(stats.permanentBytes, stats.totalBytes)
})

test('explicit planning cleanup removes only the selected assistants two notes', async () => {
  const store = new MemoryStorage()
  const service = new AssistantService({ store, defaults: { name: 'Servant', presetId: 'standard', foreground: {}, background: {} }, runtime: {} as any } as any)
  await service.foregroundMemory('default', 'Foreground_List', 'List')
  await service.foregroundMemory('default', 'Foreground_Cache', 'Notes')
  const retained = ['foreground-memory/another/Foreground_List', 'conversations/default/one', 'knowledge/skills/one', 'records/one']
  for (const key of retained) await store.set(key, { text: 'Keep' })
  await service.clearPlanningNotes()
  assert.equal((await service.foregroundMemory('default', 'Foreground_List') as any).exists, false)
  assert.equal((await service.foregroundMemory('default', 'Foreground_Cache') as any).exists, false)
  for (const key of retained) assert.deepEqual(await store.get(key), { text: 'Keep' })
})

test('old planning and archive folders migrate without losing bodies or resurrecting cleared notes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dss-planning-folders-'))
  const descriptor = { name: 'deepseek_servant', version: 1, tables: ['records'], hasGlobal: false }
  const keys = ['foreground-memory/default/Foreground_List', 'foreground-memory/default/Foreground_Cache', 'records/one', 'task-history/one']
  let backend = new RecordFilesBackend(root)
  try {
    await ensureRecordTree(root)
    let unit = await backend.kv.open(descriptor)
    for (const key of keys) await unit.putRecord('records', key, { key, value: { text: key } })
    await backend.close()
    for (const key of keys) await rename(join(root, recordFolder(key)), join(root, 'other', basename(recordFolder(key))))
    backend = new RecordFilesBackend(root)
    unit = await backend.kv.open(descriptor)
    const snapshot = await unit.loadAll()
    assert.equal(Object.keys(snapshot.tables.records).length, keys.length)
    for (const key of keys) {
      assert.deepEqual(snapshot.tables.records[key], { key, value: { text: key } })
      assert.ok((await stat(join(root, recordFolder(key), 'record.json'))).isFile())
      await assert.rejects(stat(join(root, 'other', basename(recordFolder(key)))), { code: 'ENOENT' })
    }
    await unit.deleteRecord('records', keys[0])
    await backend.close()
    backend = new RecordFilesBackend(root)
    unit = await backend.kv.open(descriptor)
    assert.equal((await unit.loadAll()).tables.records[keys[0]], undefined)
  } finally { await backend.close(); await rm(root, { recursive: true, force: true }) }
})

test('interrupted folder relocation preserves the newer destination record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dss-planning-restart-'))
  const descriptor = { name: 'deepseek_servant', version: 1, tables: ['records'], hasGlobal: false }
  const key = 'foreground-memory/default/Foreground_List'
  let backend = new RecordFilesBackend(root)
  try {
    await ensureRecordTree(root)
    let unit = await backend.kv.open(descriptor)
    await unit.putRecord('records', key, { key, value: { text: 'Old' } })
    await backend.close()
    await cp(join(root, recordFolder(key)), join(root, 'other', basename(recordFolder(key))), { recursive: true })
    backend = new RecordFilesBackend(root)
    unit = await backend.kv.open(descriptor)
    await unit.putRecord('records', key, { key, value: { text: 'New' } })
    await backend.close()
    backend = new RecordFilesBackend(root)
    unit = await backend.kv.open(descriptor)
    assert.deepEqual((await unit.loadAll()).tables.records[key], { key, value: { text: 'New' } })
  } finally { await backend.close(); await rm(root, { recursive: true, force: true }) }
})
