import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RecordFilesBackend, ensureRecordTree, recordFolder } from '../src/adapters/dsh/record-files.js'
import { RuntimeSettingsService } from '../src/application/runtime-settings.js'
import { Scheduler } from '../src/runtime/scheduler.js'
import { Id, SettingsSchema } from '../src/contracts/schemas.js'
import { CoopSettingsSchema } from '../src/experimental/private-git/contracts.js'
import { parseRetentionPolicy } from '../src/contracts/retention.js'
import { MemoryStorage } from './support.js'
import { fixture } from './task-fixture.js'
import { TaskArchiveStore } from '../src/application/task-archive-store.js'
import { GitHubClient } from '../src/experimental/private-git/github.js'
import { ModeClient } from '../src/mode-router/client.js'
import { KnowledgeService } from '../src/application/knowledge-service.js'
import { CoopNativeAgents } from '../src/experimental/private-git/native-agents.js'
import type { Context } from '@deepseek-ai/cordis'
import type { CoopStore } from '../src/experimental/private-git/cache.js'
import type { RoleAction } from '../src/experimental/private-git/protocol.js'
import type { RoleWriter } from '../src/experimental/private-git/role-writer.js'

test('damaged task data is isolated and normal enumeration recovers after repair', async () => {
  const f = await fixture()
  const key = 'task:one', original = await f.storage.get(key)
  await f.storage.set(key, { broken: true })
  assert.deepEqual(await f.store.listTasks(), [])
  assert.equal(f.store.problems.size, 1)
  await f.storage.set(key, original)
  assert.equal((await f.store.listTasks())[0].id, 'one')
  assert.equal(f.store.problems.size, 0)
})

test('a missing cleanup manifest preserves its original data and leaves unrelated cleanup available', async () => {
  const storage = new MemoryStorage(), archives = new TaskArchiveStore(storage)
  await storage.set('task-history/bad', { schemaVersion: 1, taskId: 'bad', tombstone: {} })
  await storage.set('task:bad', { original: 'keep this data' })
  const errors: unknown[] = []
  await archives.resumeCleanup(error => errors.push(error))
  assert.equal(errors.length, 1)
  assert.deepEqual(await storage.get('task:bad'), { original: 'keep this data' })
})

test('a truncated derived layout is backed up and rebuilt without touching record contents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dss-layout-repair-'))
  try {
    await ensureRecordTree(root)
    await writeFile(join(root, 'layout.json'), '{truncated')
    await ensureRecordTree(root)
    assert.equal(JSON.parse(await readFile(join(root, 'layout.json'), 'utf8')).version, 1)
    const backups = await readdir(join(root, 'backups'))
    assert.equal(backups.length, 1)
    assert.equal(await readFile(join(root, 'backups', backups[0]), 'utf8'), '{truncated')
    await writeFile(join(root, 'layout.json'), JSON.stringify({ format: 'deepseek-servant-record-folders', version: 2 }))
    await assert.rejects(ensureRecordTree(root), /不支持/)
    assert.equal(JSON.parse(await readFile(join(root, 'layout.json'), 'utf8')).version, 2)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Git cancellation aborts the owned request and rejects even a late transport response', async () => {
  let release!: (value: Response) => void, arrived!: () => void
  const started = new Promise<void>(resolve => { arrived = resolve })
  let observed!: AbortSignal
  const client = new GitHubClient(async () => ({ value: 'fixture', source: 'fixture' }), async (_url, init) => {
    observed = init!.signal!; arrived()
    return new Promise<Response>(resolve => { release = resolve })
  })
  const request = client.session(session => session.request('GET', '/user'))
  const rejected = assert.rejects(request, { name: 'AbortError' })
  await started; client.cancel()
  assert.equal(observed.aborted, true)
  release(Response.json({ id: 1 }))
  await rejected
})

test('a late mode response and a throwing subscriber do not overwrite a new selection', async () => {
  let release!: (value: unknown) => void, started!: () => void
  const arrival = new Promise<void>(resolve => { started = resolve })
  let first = true, selected = 'PRIVATE_GIT_EXPERIMENTAL'
  const client = new ModeClient(async (method, params) => {
    if (method === 'select') { selected = params.mode as string; return { activeMode: selected } }
    if (method === 'selection' && first) { first = false; started(); return new Promise(resolve => { release = resolve }) }
    if (method === 'selection') return { activeMode: selected }
    return {}
  }, () => () => {})
  const seen: string[] = []
  const stop = client.subscribe(() => { seen.push(client.snapshot().activeMode); throw new Error('broken observer fixture') })
  await arrival
  const changing = client.select('LOCAL')
  release({ activeMode: 'PRIVATE_GIT_EXPERIMENTAL' })
  await changing
  assert.deepEqual(seen, ['LOCAL'])
  stop(); client.dispose()
})

test('a valid long knowledge identity stays readable', async () => {
  const knowledge = new KnowledgeService({ store: new MemoryStorage(), evidence: { resolveResult: async () => undefined } })
  assert.equal(await knowledge.getSkill('method-' + 'a'.repeat(600), { assistantId: 'a', workspaceId: 'w' }), undefined)
})

test('disposing during native creation releases the late handle before accepting input', async () => {
  let arrived!: () => void, release!: (handle: unknown) => void
  const started = new Promise<void>(resolve => { arrived = resolve })
  let disposed = 0, sent = 0
  const handle = { dispose: async () => { disposed++ }, agent: { followup: () => { sent++ } } }
  const ctx = { get: () => undefined, agents: { get: () => undefined, create: async () => {
    arrived(); return new Promise(resolve => { release = resolve })
  } }, sessions: { flush: async () => {} } } as unknown as Context
  const agents = new CoopNativeAgents(ctx, { settings: { workspace: process.cwd() } } as CoopStore)
  const start = agents.start({ binding: { executionId: 'late', sessionId: 'late' } } as RoleAction, {}, {} as RoleWriter, () => {})
  await started
  await agents.dispose()
  release(handle)
  await start
  assert.equal(disposed, 1)
  assert.equal(sent, 0)
  assert.equal(agents.state('late'), undefined)
})

test('capacity and retention settings preserve positive safe values beyond editor conveniences', async () => {
  const settings = await RuntimeSettingsService.open(new MemoryStorage(), 65)
  assert.equal(settings.get().workerSeats, 65)
  assert.equal(new Scheduler(65).workerSeats, 65)
  assert.equal(CoopSettingsSchema.parse({ workerSeats: 65 }).workerSeats, 65)
  assert.equal(parseRetentionPolicy({ taskDetailDays: 4000, maxFullSkillVersions: 2000, maxServantBytes: 512 }).maxServantBytes, 512)
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => new Scheduler(value))
})

test('native workspace and opaque record identities permit Unicode and long identities', () => {
  const id = '项目 与记录-' + '段'.repeat(600)
  assert.equal(Id.parse(id), id)
  assert.equal(SettingsSchema.parse({ name: 'Servant', workspaceId: id, presetId: 'standard', foreground: {}, background: {} }).workspaceId, id)
  for (const invalid of ['__proto__', 'constructor', 'prototype', 'bad\nkey', ''])
    assert.throws(() => Id.parse(invalid))
})

test('one malformed record stays intact while healthy records load and the repaired record recovers in the same backend', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dss-record-isolation-'))
  const descriptor = { name: 'deepseek_servant', version: 1, tables: ['records'], hasGlobal: false }
  let backend = new RecordFilesBackend(root)
  try {
    await ensureRecordTree(root)
    let unit = await backend.kv.open(descriptor)
    await unit.putRecord('records', 'task:healthy', { key: 'task:healthy', value: { text: 'preserve healthy body' } })
    await unit.putRecord('records', 'task:broken', { key: 'task:broken', value: { text: 'preserve repaired body' } })
    await backend.close()
    const broken = join(root, recordFolder('task:broken'), 'record.json')
    const original = await readFile(broken, 'utf8')
    const corrupt = original.slice(0, -9)
    await writeFile(broken, corrupt)
    backend = new RecordFilesBackend(root)
    unit = await backend.kv.open(descriptor)
    const snapshot = await unit.loadAll()
    assert.equal(Object.keys(snapshot.tables.records).length, 1)
    assert.equal(await readFile(broken, 'utf8'), corrupt)
    await unit.putRecord('records', 'task:healthy', { key: 'task:healthy', value: { text: 'healthy update' } })
    await assert.rejects(unit.putRecord('records', 'task:broken', { key: 'task:broken', value: {} }))
    assert.equal(await readFile(broken, 'utf8'), corrupt, 'unreadable original is never overwritten')
    await writeFile(broken, original)
    const repaired = await unit.loadAll()
    assert.deepEqual((repaired.tables.records['task:broken'] as { value: unknown }).value, { text: 'preserve repaired body' })
    await unit.putRecord('records', 'task:broken', { key: 'task:broken', value: { text: 'normal write after repair' } })
  } finally { await backend.close(); await rm(root, { recursive: true, force: true }) }
})
