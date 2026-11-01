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
import { LocalFiles } from '../src/framework/local-files.js'
import { FrameworkTransactions } from '../src/framework/command-transactions.js'
import { captureLocalLegacy, captureGitLegacy, prepareLegacyMigration, applyLegacyMigration } from '../src/framework/legacy-migration.js'
import { withSnapshot } from '../src/framework/transactions.js'
import { readLegacyRecordExport, listLegacyRecordExports, decodeLegacySealedRecords, decodeLegacySealedTask } from '../src/framework/legacy-record-export.js'
import { exportFrameworkDocument, exportFrameworkBytes } from '../src/framework/maintenance.js'

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const unicode = '完整保存🙂e\u0301\n```markdown\n原文\n```\r\n'.repeat(4_000) + 'END 完整原文'
interface OldRecords { storage: StoragePort; body: string; task: Task; characters: number; bytes: number; sha256: string }
// The completed Task, RecordJournal/TaskRecords writes, sealing and cleanup are
// actual 0acd producers; no current implementation or fabricated archive layout.
const source = readBaselineSource('tests/completion-records.test.ts')
const baseline = await loadBaselineModule<{ produce(text: string, cleanup: boolean): Promise<OldRecords>; cancelled(): Promise<OldRecords> }>(
  'tests/completion-records.test.ts', source.slice(0, source.indexOf("\ntest(")) + `
export async function produce(text, cleanup) {
 const f = await accepted(); await finish(f);
 await f.store.journal.append({scope:{kind:'planner-memory',taskId:'one'},commandId:'export-full-unicode',text,source:f.runtime});
 const task=await f.get(), manifest=await f.tasks.archives.seal(task,'ended');
 let body=''; for await(const chunk of f.tasks.archives.chunks(manifest)) body+=chunk;
 if(cleanup) await f.tasks.cleanupCompleted('one');
 return {storage:f.storage,body,task,characters:manifest.characters,bytes:manifest.bytes,sha256:manifest.sha256};
}
export async function cancelled() {
 const f=await fixture(); await f.execute({type:'task.control',intent:'cancel'},{kind:'user',id:'owner'});
 const task=await f.get(); assert.equal(await f.tasks.cleanupCompleted('one'),true);
 const manifest=await f.tasks.archives.manifest('one');let body='';for await(const chunk of f.tasks.archives.chunks(manifest))body+=chunk;
 return {storage:f.storage,body,task,characters:manifest.characters,bytes:manifest.bytes,sha256:manifest.sha256};
}`)
async function target(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'dss-legacy-record-export-')), files = await LocalFiles.open(directory)
  t.after(async () => { await files.close(); await rm(directory, { recursive: true, force: true }) })
  return { files, directory, transactions: new FrameworkTransactions(files, new MemoryStorage(), directory) }
}

test('real baseline released Local history remains discoverable without a live task root', async () => {
  const old = await baseline.produce(unicode, true)
  assert.equal(await old.storage.get('task:one'), undefined, 'actual legacy cleanup removed the live root')
  assert.ok(await old.storage.get('task-history/one'))
  const before = JSON.stringify(await old.storage.list('')), capture = await captureLocalLegacy(old.storage)
  assert.equal(capture.tasks.length, 1)
  assert.equal(capture.tasks[0]!.id, 'one'); assert.equal(capture.tasks[0]!.continuation, 'complete')
  assert.equal(JSON.stringify(await old.storage.list('')), before, 'capture never changes the original archive')
})

test('Local migration materializes only the exact sealed document, not task JSON or newly reordered journals', async () => {
  const old = await baseline.produce(unicode, false), capture = await captureLocalLegacy(old.storage)
  assert.ok(old.body.includes(unicode))
  const body = capture.texts.find(entry => entry.ref === 'records/one/records.md')?.text
  assert.equal(typeof body, 'string')
  assert.equal(sha(body!), old.sha256)
  assert.equal(body, old.body)
})

async function migrate(t: test.TestContext, options: { previousConsumer?: boolean; cleanup?: boolean } = {}) {
  const old = await baseline.produce(unicode, options.cleanup ?? true), f = await target(t), capture = await captureLocalLegacy(old.storage)
  // Precisely the prior capture output: source JSON/parts and journal fullText
  // were preserved, but history-only tasks and sealed document text were omitted.
  if (options.previousConsumer) {
    capture.tasks = []
    capture.texts = capture.texts.filter(entry => entry.ref !== 'records/one/records.md')
  }
  const plan = await withSnapshot(f.files, snapshot => prepareLegacyMigration(capture, f.files, snapshot,
    { id: 'synthetic-record-upgrade', owner: 'alice', members: { assistant: 'alice' }, nativeOwnershipReconciled: { assistant: Object.values(old.task.executions).map(execution => ({ executionId: execution.executionId, generation: execution.generation, settled: true })) } }))
  await applyLegacyMigration(f.files, f.transactions, plan)
  const input = { manifestPath: plan.manifestPath, oldTaskId: 'one' }
  const read = () => withSnapshot(f.files, snapshot => readLegacyRecordExport(f.files, snapshot, input))
  const put = (path: string, content: string | null) => withSnapshot(f.files, snapshot => f.files.commit(snapshot, [{ path, content }], 'synthetic corruption/control'))
  return { ...f, old, plan, input, read, put }
}

test('actual old producer → migration → logical records path → workspace export preserves every Unicode byte', async t => {
  const f = await migrate(t), result = await f.read()
  assert.equal(result.taskId, f.plan.manifest.tasks[0]!.taskId)
  assert.notEqual(result.path, f.plan.manifest.tasks[0]!.recordPath, 'legacy task.json is not a document')
  assert.equal(result.path, f.plan.manifest.references['records/one/records.md'])
  assert.equal(sha(result.bytes), f.old.sha256); assert.equal(result.bytes.byteLength, f.old.bytes)
  assert.equal(Buffer.from(result.bytes).toString('utf8'), f.old.body)
  const exported = await exportFrameworkDocument(f.files, result.path!, result.taskId, f.directory)
  assert.deepEqual(await readFile(exported.path), Buffer.from(f.old.body, 'utf8'))
  await withSnapshot(f.files, async snapshot => {
    assert.deepEqual(await f.files.list(snapshot, 'tasks/'), [])
    assert.deepEqual(await f.files.list(snapshot, 'state/'), [], 'history discovery does not create wake signals')
    assert.deepEqual(await listLegacyRecordExports(f.files, snapshot, f.input.manifestPath), [{ oldTaskId: 'one', taskId: result.taskId, continuation: 'complete' }])
  })
})

test('already migrated history-only manifest/parts remain discoverable and exportable without a fabricated path or migration rewrite', async t => {
  const f = await migrate(t, { previousConsumer: true })
  assert.deepEqual(f.plan.manifest.tasks, []); assert.equal(f.plan.manifest.references['records/one/records.md'], undefined)
  const head = await withSnapshot(f.files, snapshot => Promise.resolve(snapshot.revision)), result = await f.read()
  assert.equal(result.path, undefined)
  const exported = await exportFrameworkBytes(result.bytes, result.taskId, f.directory)
  assert.deepEqual(await readFile(exported.path), Buffer.from(f.old.body, 'utf8'))
  assert.equal(sha(result.bytes), f.old.sha256); assert.equal(Buffer.from(result.bytes).toString('utf8'), f.old.body)
  const listed = await withSnapshot(f.files, snapshot => listLegacyRecordExports(f.files, snapshot, f.plan.manifestPath))
  assert.deepEqual(listed, [{ oldTaskId: 'one', taskId: result.taskId, continuation: 'complete' }])
  assert.equal(await withSnapshot(f.files, snapshot => Promise.resolve(snapshot.revision)), head)
})

test('preserved current same-id Task wins over old history; no history fallback can turn it terminal', async t => {
  const f = await migrate(t), storage = f.old.storage
  const live = { ...f.old.task, phase: 'planning', control: 'running', goal: { ...f.old.task.goal, request: 'New current responsibility' } }
  await storage.set('task:one', live)
  const capture = await captureLocalLegacy(storage)
  assert.equal(capture.tasks.length, 1); assert.equal(capture.tasks[0]!.continuation, 'running')
  assert.equal(capture.tasks[0]!.request, 'New current responsibility')
  const manifest = structuredClone(f.plan.manifest); manifest.tasks[0]!.continuation = 'running'
  await f.put(f.plan.manifestPath, JSON.stringify(manifest))
  assert.deepEqual(await withSnapshot(f.files, snapshot => listLegacyRecordExports(f.files, snapshot, f.plan.manifestPath)), [])
  await assert.rejects(f.read(), /unavailable/)
})

test('explicit history-cleared and deletion-in-progress identities cannot resurrect via preserved references', async t => {
  const f = await migrate(t, { previousConsumer: true })
  await f.put(f.plan.manifestPath, JSON.stringify({ ...f.plan.manifest, clearedTasks: [{ oldId: 'one', taskId: 'preserved-identity' }] }))
  await assert.rejects(f.read(), /explicitly cleared/)
  assert.deepEqual(await withSnapshot(f.files, snapshot => listLegacyRecordExports(f.files, snapshot, f.plan.manifestPath)), [])
  const source = await f.old.storage.get<any>('task-history/one'); await f.old.storage.set('task-history/one', { ...source, deleting: true })
  const capture = await captureLocalLegacy(f.old.storage)
  assert.deepEqual(capture.tasks, []); assert.equal(capture.texts.some(row => row.ref === 'records/one/records.md'), false)
})

test('missing/corrupt preserved parts and materialized records fail explicitly, never fall back to task.json', async t => {
  for (const change of ['missing-part', 'changed-part', 'missing-body', 'changed-body', 'missing-manifest'] as const) {
    await t.test(change, async t => {
      const f = await migrate(t), sealed = await f.old.storage.get<any>('records/one/manifest')
      const part = sealed.document.find((segment: any) => segment.parts).parts[0].key
      const path = change.includes('part') ? f.plan.manifest.references[part]!
        : change === 'missing-manifest' ? f.plan.manifestPath : f.plan.manifest.references['records/one/records.md']!
      await f.put(path, change.startsWith('missing') ? null : 'Corrupt changed content')
      await assert.rejects(f.read(), /missing|corrupt/)
      assert.notEqual(await withSnapshot(f.files, snapshot => f.files.read(snapshot, f.plan.manifest.tasks[0]!.recordPath)), undefined)
    })
  }
})

test('sealed decoder validates original order, exact part ownership, characters/bytes and aggregate digest', async () => {
  const old = await baseline.produce(unicode, false), original = await old.storage.get<any>('records/one/manifest')
  for (const mutate of [
    (m: any) => { m.document.reverse() }, (m: any) => { m.characters++ }, (m: any) => { m.bytes++ },
    (m: any) => { m.taskId = 'another' }, (m: any) => { m.document[0].parts = [] },
    (m: any) => { m.document.find((s: any) => s.parts).parts[0].key = 'records/another/content/' + '0'.repeat(64) },
  ]) {
    const sealed = structuredClone(original); mutate(sealed)
    await assert.rejects(decodeLegacySealedRecords(sealed, 'one', key => old.storage.get(key)), /Invalid|integrity/)
  }
  const before = JSON.stringify(await old.storage.list(''))
  const sealed = structuredClone(original); sealed.document.find((s: any) => s.parts).parts[0].bytes++
  await old.storage.set('records/one/manifest', sealed)
  await assert.rejects(captureLocalLegacy(old.storage), /corrupt/)
  await old.storage.set('records/one/manifest', original)
  assert.equal(JSON.stringify(await old.storage.list('')), before)
})

test('invalid or absent migration references are errors, and another corrupt archive does not block the selected valid document', async t => {
  const f = await migrate(t), bad = structuredClone(f.plan.manifest)
  bad.tasks.push({ ...bad.tasks[0]!, oldId: 'broken', taskId: 'broken-mapped' })
  const key = 'records/broken/manifest', path = f.plan.manifestPath.replace('/manifest.json', '/source/' + sha(key) + '.bin')
  const raw = JSON.stringify({ schemaVersion: 1, state: 'broken', taskId: 'broken' })
  bad.records.push({ key, path, sha256: sha(raw) }); bad.references[key] = path; bad.referenceHashes[key] = sha(raw)
  await f.put(path, raw); await f.put(f.plan.manifestPath, JSON.stringify(bad))
  const errors: Array<[unknown, string]> = []
  const listed = await withSnapshot(f.files, snapshot => listLegacyRecordExports(f.files, snapshot, f.plan.manifestPath, (error, id) => { errors.push([error, id]) }))
  assert.equal(listed.length, 1); assert.equal(errors.length, 1); assert.equal(errors[0]![1], 'broken')
  assert.equal(sha((await f.read()).bytes), f.old.sha256)
  bad.references['records/one/manifest'] = 'archives/unrelated/records.md'
  await f.put(f.plan.manifestPath, JSON.stringify(bad))
  await assert.rejects(f.read(), /unambiguously/)
  await assert.rejects(withSnapshot(f.files, snapshot => readLegacyRecordExport(f.files, snapshot, { manifestPath: '../escape', oldTaskId: 'one' })), /relative/)
})


test('real baseline cancelled cleanup remains cancelled history and never creates running signals', async t => {
  const old = await baseline.cancelled(), capture = await captureLocalLegacy(old.storage), f = await target(t)
  assert.equal(await old.storage.get('task:one'), undefined)
  assert.equal(capture.tasks[0]!.continuation, 'cancelled')
  const plan = await withSnapshot(f.files, snapshot => prepareLegacyMigration(capture, f.files, snapshot,
    { id: 'cancelled-record-upgrade', owner: 'alice', members: {} }))
  await applyLegacyMigration(f.files, f.transactions, plan)
  const result = await withSnapshot(f.files, snapshot => readLegacyRecordExport(f.files, snapshot, { manifestPath: plan.manifestPath, oldTaskId: 'one' }))
  assert.equal(sha(result.bytes), old.sha256)
  assert.equal(plan.changes.some(change => change.path.startsWith('tasks/') || change.path.startsWith('state/') || change.path.endsWith('/Inbox.md')), false)
  assert.equal((await withSnapshot(f.files, snapshot => listLegacyRecordExports(f.files, snapshot, plan.manifestPath)))[0]!.continuation, 'cancelled')
})

test('actual old Git finalizer resolves its immutable full-text reference, never the task JSON or records.md convenience copy', async t => {
  const original = readBaselineSource('tests/private-git.test.ts')
  const producer = await loadBaselineModule<{ produce(text: string): Promise<{ rows: Array<[string, string]>; taskId: string; body: string }> }>('tests/private-git.test.ts',
    original.slice(0, original.indexOf('\ntest(')) + `
import {CoopFinalizer} from '../src/experimental/private-git/finalizer.js';
export async function produce(text) {
 const repo=new MemoryRepo(), target=instance(repo), planner=await root(repo,target);
 const snapshot=await repo.snapshot(), task=await readJson(repo,snapshot,taskPath(planner.binding.taskId)+'/contract.json');
 const accepted={...task,status:'accepted'};
 await repo.commit(snapshot,[{path:taskPath(task.id)+'/contract.json',content:json(accepted)},...textChanges(task.originPath,text),
 ...[...snapshot.files.keys()].filter(path=>path.includes('/actions/')).map(path=>({path,content:json({...JSON.parse(repo.blobs.get(snapshot.files.get(path))),state:'closed'})}))]);
 const finalizer=new CoopFinalizer(repo,target.journal,target.cache);
 await finalizer.finalize(await repo.snapshot(),accepted);await finalizer.finalize(await repo.snapshot(),accepted);
 const sealed=await readJson(repo,await repo.snapshot(),'dss-coop/records/'+task.id+'/manifest.json');
 const body=await readText(repo,await repo.snapshot(),sealed.recordsPath);
 return {rows:[...repo.files].map(([path,sha])=>[path,repo.blobs.get(sha)]),taskId:task.id,body};
}`)
  const old = await producer.produce(unicode), source = await target(t), f = await target(t)
  await withSnapshot(source.files, snapshot => source.files.commit(snapshot, old.rows.map(([path, content]) => ({ path: path.replace(/^dss-coop\//, ''), content })), 'exact old Git archive'))
  const capture = await withSnapshot(source.files, snapshot => captureGitLegacy(source.files, snapshot))
  const plan = await withSnapshot(f.files, snapshot => prepareLegacyMigration(capture, f.files, snapshot, { id: 'git-record-upgrade', owner: 'alice', members: {} }))
  await applyLegacyMigration(f.files, f.transactions, plan)
  assert.equal(capture.tasks[0]!.continuation, 'complete')
  const result = await withSnapshot(f.files, snapshot => readLegacyRecordExport(f.files, snapshot, { manifestPath: plan.manifestPath, oldTaskId: old.taskId }))
  assert.equal(Buffer.from(result.bytes).toString('utf8'), old.body); assert.ok(old.body.includes(unicode))
  assert.notEqual(result.path, plan.manifest.tasks[0]!.recordPath)
  assert.notEqual(result.path, plan.manifest.references['records/' + old.taskId + '/records.md'])
  const exported = await exportFrameworkBytes(result.bytes, result.taskId, f.directory)
  assert.deepEqual(await readFile(exported.path), Buffer.from(old.body, 'utf8'))
})


test('legacy snapshot parts cannot read another Task or override a preserved current root during fallback', async t => {
  const f = await migrate(t, { previousConsumer: true, cleanup: false })
  assert.ok(f.plan.manifest.records.some(row => row.key === 'task:one'))
  assert.deepEqual(await withSnapshot(f.files, snapshot => listLegacyRecordExports(f.files, snapshot, f.plan.manifestPath)), [])
  await assert.rejects(f.read(), /unavailable/)
  const sealed = await f.old.storage.get<any>('records/one/manifest')
  sealed.snapshot[0].key = 'records/another/content/' + sealed.snapshot[0].sha256
  await assert.rejects(decodeLegacySealedTask(sealed, 'one', key => f.old.storage.get(key)), /Invalid.*part/)
})
