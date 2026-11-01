import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadBaselineModule, readBaselineSource } from './legacy-baseline.js'
import { MemoryStorage } from './support.js'
import type { StoragePort } from '../src/contracts/ports.js'
import type { Task } from '../src/contracts/task.js'
import { FrameworkService } from '../src/framework/service.js'
import { FrameworkConversation } from '../src/framework/conversation.js'
import { LocalFiles } from '../src/framework/local-files.js'
import { FrameworkTransactions } from '../src/framework/command-transactions.js'
import { captureLocalLegacy, prepareLegacyMigration, applyLegacyMigration } from '../src/framework/legacy-migration.js'
import { withSnapshot, FilesOutcomeUnknownError } from '../src/framework/transactions.js'
import { FrameworkArtifacts } from '../src/framework/artifacts.js'
import { paths } from '../src/framework/task-files.js'

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const original = '完整 Unicode🙂 e\u0301\r\n```text\n  original spacing  \n```\n'.repeat(2000) + 'END 完整记录'
const source = readBaselineSource('tests/completion-records.test.ts')
const baseline = await loadBaselineModule<{ produce(text: string): Promise<{ storage: StoragePort; task: Task; body: string; sha256: string }> }>('tests/completion-records.test.ts', source.slice(0, source.indexOf('\ntest(')) + `
export async function produce(text) {
 const f=await accepted(); await finish(f);
 await f.store.journal.append({scope:{kind:'planner-memory',taskId:'one'},commandId:'legacy-service-full-record',text,source:f.runtime});
 const task=await f.get(), manifest=await f.tasks.archives.seal(task,'ended');
 let body=''; for await(const chunk of f.tasks.archives.chunks(manifest))body+=chunk;
 await f.tasks.cleanupCompleted('one');
 return {storage:f.storage,task,body,sha256:manifest.sha256};
}`)
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'dss-legacy-record-service-')), files = await LocalFiles.open(join(directory, 'files')), storage = new MemoryStorage()
  const workspaceCalls: string[] = [], accessCalls: string[] = []
  const ctx = { workspaceRegistry: { create: async (path: string) => { workspaceCalls.push(path); assert.equal(path, directory); return { id: 'synthetic-export-workspace', path } } }, get: (name: string) => { throw new Error('Unexpected native service access: ' + name) } }
  const settings = { name: 'DeepSeek Servant', userName: 'alice', localDirectory: files.directory, ownerRepo: '', repositoryDirectory: '', collaborationId: 'legacy-test', workerSeats: 0, workspace: directory }
  const service = new FrameworkService(ctx as any, storage, settings), internal = service as any
  const transactions = new FrameworkTransactions(files, storage, 'legacy-test')
  const connection = { files, transactions, scope: 'legacy-storage', identity: { login: 'alice', owner: 'alice', instanceUUID: '00000000-0000-4000-8000-000000000001', repositoryId: 'legacy-test' }, cancelPending() {}, close: async () => {} }
  internal.saved.set('local', { revision: 'settings-1', settings })
  internal.accesses.set('local', Promise.resolve({ connection, conversation: new FrameworkConversation(files, transactions, { mode: 'local', collaborationId: 'legacy-test' }) }))
  const access = internal.access.bind(internal)
  internal.access = (mode: string) => { accessCalls.push(mode); assert.equal(mode, 'local'); assert.ok(internal.accesses.has(mode), 'No external authentication/storage fallback is allowed'); return access(mode) }
  internal.open = () => { throw new Error('Record history must not start background participation') }
  t.after(async () => { await service.dispose(); await files.close(); await rm(directory, { recursive: true, force: true }) })
  const migrate = async (id: string, previousConsumer = false) => {
    const old = await baseline.produce(original), capture = await captureLocalLegacy(old.storage)
    assert.equal(await old.storage.get('task:one'), undefined, 'actual old cleanup removed the live Task')
    assert.ok(old.body.includes(original))
    if (previousConsumer) { capture.tasks = []; capture.texts = capture.texts.filter(row => row.ref !== 'records/one/records.md') }
    const plan = await withSnapshot(files, snapshot => prepareLegacyMigration(capture, files, snapshot, { id, owner: 'alice', members: { assistant: 'alice' } }))
    await applyLegacyMigration(files, transactions, plan)
    return { old, plan, input: { mode: 'local' as const, storageScope: 'legacy-storage', migrationId: id, oldTaskId: 'one' } }
  }
  const put = (path: string, content: string) => withSnapshot(files, snapshot => files.commit(snapshot, [{ path, content }], 'Explicit synthetic integrity/control state'))
  return { service, files, internal, migrate, put, workspaceCalls, accessCalls }
}

for (const previousConsumer of [false, true]) test(`real legacy sealed producer reaches service discovery/full read/export (${previousConsumer ? 'previous tasks-empty consumer' : 'new migration'}) without background startup`, async t => {
  const f = await fixture(t), m = await f.migrate('service-records', previousConsumer)
  if (previousConsumer) { assert.deepEqual(m.plan.manifest.tasks, []); assert.equal(m.plan.manifest.references['records/one/records.md'], undefined) }
  const reads: string[] = [], read = f.files.read.bind(f.files), bytes = f.files.readBytes.bind(f.files)
  f.files.read = async (snapshot, path) => { reads.push(path); return read(snapshot, path) }
  f.files.readBytes = async (snapshot, path) => { reads.push(path); return bytes(snapshot, path) }
  const fullContentPaths = new Set(Object.entries(m.plan.manifest.references).filter(([key]) => key.startsWith('records/one/content/') || key === 'records/one/records.md').map(([, path]) => path))
  await f.service.view({ mode: 'local' })
  assert.equal(reads.some(path => fullContentPaths.has(path)), false, 'Ordinary view must not decode the sealed document')
  const discovered = await f.service.view({ mode: 'local', includeArchives: true })
  assert.equal(discovered.connection.participating, false)
  const item = discovered.legacyTasks.find(row => row.migrationId === m.input.migrationId && row.oldTaskId === 'one')
  assert.ok(item?.recordsAvailable, 'Explicit archives query must expose real sealed records even without manifest.tasks')
  reads.length = 0
  await f.service.view({ mode: 'local' })
  assert.equal(reads.some(path => fullContentPaths.has(path)), false, 'Cached discovery must not turn every ordinary view into a full record read')
  const record = await f.service.legacyRecords(m.input)
  assert.equal(record.text, m.old.body); assert.equal(sha(record.text), m.old.sha256)
  assert.notEqual(record.text, JSON.stringify(m.old.task))
  const exported = await f.service.exportRecords(m.input)
  assert.deepEqual(await readFile(exported.path), Buffer.from(m.old.body, 'utf8'))
  assert.deepEqual(f.workspaceCalls, [f.internal.saved.get('local').settings.workspace])
  assert.equal(f.internal.running.size, 0)
  await withSnapshot(f.files, async snapshot => { assert.deepEqual(await f.files.list(snapshot, 'tasks/'), []); assert.deepEqual(await f.files.list(snapshot, 'state/'), []) })
  await assert.rejects(f.service.legacyRecords({ ...m.input, storageScope: 'other-storage' }), /destination changed/)
})

test('one corrupted actual sealed archive yields a diagnosis while another service archive remains readable/exportable', async t => {
  const f = await fixture(t), good = await f.migrate('good-records', true), broken = await f.migrate('broken-records', true)
  const path = broken.plan.manifest.references['records/one/manifest']!
  await f.put(path, '{invalid original sealed manifest')
  const view = await f.service.view({ mode: 'local', includeArchives: true })
  assert.ok(view.legacyTasks.some(row => row.migrationId === good.input.migrationId && row.recordsAvailable))
  assert.ok(view.connection.detail, 'Corruption must be visible rather than silently omitted')
  assert.equal((await f.service.legacyRecords(good.input)).text, good.old.body)
  assert.deepEqual(await readFile((await f.service.exportRecords(good.input)).path), Buffer.from(good.old.body))
  await assert.rejects(f.service.legacyRecords(broken.input), /corrupt|invalid|JSON|integrity/i)
  assert.equal(f.internal.running.size, 0)
})

test('explicit cleared legacy identity is not available through direct service read or export despite preserved parts', async t => {
  const f = await fixture(t), m = await f.migrate('cleared-records', true)
  assert.equal((await f.service.legacyRecords(m.input)).text, m.old.body)
  // The persisted existing clear marker is a control fixture, not a claim that
  // this test invokes the separate destructive manual-cleanup implementation.
  await f.put(m.plan.manifestPath, JSON.stringify({ ...m.plan.manifest, clearedTasks: [{ oldId: 'one', taskId: 'preserved-cleared-identity' }] }))
  await assert.rejects(f.service.legacyRecords(m.input), /explicitly cleared/)
  await assert.rejects(f.service.exportRecords(m.input), /explicitly cleared/)
  const view = await f.service.view({ mode: 'local', includeArchives: true })
  assert.equal(view.legacyTasks.some(row => row.migrationId === m.input.migrationId && row.recordsAvailable), false)
  assert.equal(f.internal.running.size, 0)
})


test('actual cleanup COMMIT with lost acknowledgement cannot resurrect cached legacy identity; preserved result remains discoverable and downloadable', async t => {
  const f = await fixture(t), m = await f.migrate('lost-cleanup-ack', true)
  const cached = await f.service.view({ mode: 'local', includeArchives: true })
  const identity = cached.legacyTasks.find(row => row.migrationId === m.input.migrationId && row.oldTaskId === 'one')!
  assert.ok(identity?.recordsAvailable)
  const access = await f.internal.accesses.get('local')
  const data = Uint8Array.from([0, 255, 128, 10, 13, 1]), artifactPath = paths.archive(identity.taskId) + '/original-result.bin'
  const artifacts = new FrameworkArtifacts({ fs: {
    resolve: async () => ({ path: 'synthetic-result' }), stat: async () => ({ type: 'file', version: 'same-synthetic-version', size: data.length }),
    readByteRange: async (_file: unknown, options: { offset: number; length: number }) => data.slice(options.offset, options.offset + options.length),
  } } as never, f.files, access.connection.transactions, 'synthetic-workspace')
  await artifacts.preserve('save-retained-result', { taskId: identity.taskId, sourcePath: 'synthetic-result', destinationPath: artifactPath })
  const preview = await f.service.cleanupPreview({ mode: 'local', storageScope: m.input.storageScope })
  const input = { mode: 'local' as const, storageScope: m.input.storageScope, commandId: 'clear-original-history', action: 'tasks' as const,
    preview, confirmation: 'clear-ended-task-records' as const }
  const commit = f.files.commit.bind(f.files); let lost = false
  f.files.commit = async (snapshot, changes, message) => {
    const receipt = await commit(snapshot, changes, message)
    if (!lost && changes.some(change => change.path === m.plan.manifestPath && change.content?.includes('clearedTasks'))) {
      lost = true; throw new FilesOutcomeUnknownError('same-confirmed-cleanup', { cause: new Error('synthetic lost COMMIT acknowledgement') }, receipt)
    }
    return receipt
  }
  await assert.rejects(f.service.cleanupRecords(input), FilesOutcomeUnknownError)
  assert.ok(lost)
  assert.ok(access.legacyExports.get(m.input.migrationId).some((row: any) => row.oldTaskId === 'one'), 'success cache invalidation did not run after UNKNOWN')
  await withSnapshot(f.files, async snapshot => {
    assert.equal(await f.files.read(snapshot, m.plan.manifest.references['records/one/manifest']!), undefined, 'actual record deletion committed')
    const manifest = JSON.parse((await f.files.read(snapshot, m.plan.manifestPath))!)
    assert.deepEqual(manifest.tasks, [])
    assert.deepEqual(manifest.clearedTasks, [{ oldId: 'one', taskId: identity.taskId, preservedArtifacts: [artifactPath] }])
  })
  const ordinary = await f.service.view({ mode: 'local' })
  assert.equal(ordinary.legacyTasks.some(row => row.migrationId === m.input.migrationId && row.oldTaskId === 'one'), false,
    'fresh cleared receipt outranks a previously cached export identity, without waiting for explicit Archives refresh')
  await assert.rejects(f.service.legacyRecords(m.input), /cleared|unavailable/)
  const archives = await f.service.view({ mode: 'local', includeArchives: true })
  assert.ok(archives.archives.some(row => row.taskId === identity.taskId && row.files?.includes(artifactPath)))
  const record = await f.service.readFile({ mode: 'local', storageScope: m.input.storageScope, path: artifactPath })
  assert.equal(record.binary?.sha256, sha(data))
  assert.deepEqual(await f.service.download('local', artifactPath, m.input.storageScope), data)
  assert.equal((await f.service.cleanupRecords(input)).receipt.replay, true, 'same confirmed command resolves its original receipt')
  assert.equal(f.internal.running.size, 0, 'history maintenance never starts native/background participation')
})
