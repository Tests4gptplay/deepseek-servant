import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, open, readFile, readdir, rename, rm, symlink, writeFile, type FileHandle } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalFiles } from '../src/framework/local-files.js'
import { withSnapshot } from '../src/framework/transactions.js'
import { frameworkStorageUsage, exportFrameworkRecords, exportFrameworkDocument, prepareLocalRecordCopy } from '../src/framework/maintenance.js'

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'dss-maintenance-')), files = await LocalFiles.open(join(root, 'data'))
  const workspace = join(root, 'work'); await mkdir(workspace)
  t.after(async () => { await files.close(); await rm(root, { recursive: true, force: true }) })
  return { root, files, workspace }
}
test('explicit statistics account for each logical record once, without reading Local bodies or deleting anything', async t => {
  const { files } = await fixture(t)
  const rows = [
    ['conversations/a/message.txt', '中文🙂'], ['conversation-index/local/main/index.json', '{}'],
    ['assistants/collaborations/local/main/Foreground_List.md', 'list'], ['skills/a.md', 'skill'],
    ['knowledge/preference/a.json', 'fact'], ['archives/t/records.md', 'archive'], ['tasks/request_P.md', 'goal'],
    ['task-runs/t/A/Planner_Memory.md', 'memory'], ['task-runs/t/A/Plan_Note.md', 'note'],
    ['task-runs/t/A/workers/w/notes.md', 'work'], ['tasks/t.json', '{}'], ['state/A/t/Planner_Inbox', ''],
    ['instances/A.json', '{}'], ['technical/legacy-migrations/x/manifest.json', '{}'],
  ] as const
  await withSnapshot(files, snapshot => files.commit(snapshot, rows.map(([path, content]) => ({ path, content })), 'fixture'))
  const before = await files.snapshot(); await before.release()
  const bodyReads = t.mock.method(files, 'readBytes', async () => { throw new Error('Local stats must use exact metadata sizes.') })
  const result = await frameworkStorageUsage(files, new Date('2026-11-01T00:00:00Z'))
  assert.equal(result.totalBytes, rows.reduce((sum, [, text]) => sum + Buffer.byteLength(text), 0))
  assert.equal(result.totalBytes, result.permanentBytes + result.temporaryBytes)
  assert.equal(result.permanent.chatBytes, Buffer.byteLength('中文🙂') + 2)
  assert.equal(result.permanent.planningBytes, 4)
  assert.equal(result.temporary.workerReplyBytes, 4)
  assert.equal(result.recordedAt, '2026-11-01T00:00:00.000Z')
  assert.equal(bodyReads.mock.callCount(), 0)
  await withSnapshot(files, async snapshot => assert.equal(snapshot.revision, before.revision))
})
test('records export preserves the complete Unicode original, source archive and binary artifacts; repeated export reuses exact bytes', async t => {
  const { files, workspace } = await fixture(t)
  const text = '# Records\n中文🙂\n' + 'Long original.\n'.repeat(20000)
  await withSnapshot(files, snapshot => files.commit(snapshot, [
    { path: 'archives/task-one/records.md', content: text },
    { path: 'archives/task-one/artifacts/image.bin', bytes: new Uint8Array([0, 255, 0, 37]) },
  ], 'fixture'))
  const first = await exportFrameworkRecords(files, 'task-one', workspace)
  assert.equal(await readFile(first.path, 'utf8'), text)
  assert.equal(first.bytes, Buffer.byteLength(text))
  assert.deepEqual(await exportFrameworkRecords(files, 'task-one', workspace), first)
  await withSnapshot(files, async snapshot => {
    assert.equal(await files.read(snapshot, 'archives/task-one/records.md'), text)
    assert.deepEqual(await files.readBytes(snapshot, 'archives/task-one/artifacts/image.bin'), new Uint8Array([0, 255, 0, 37]))
  })
})
test('export cannot overwrite another file or use an absent or traversing task archive', async t => {
  const { files, workspace } = await fixture(t)
  await withSnapshot(files, snapshot => files.commit(snapshot, [{ path: 'archives/t/records.md', content: 'source' }], 'fixture'))
  const result = await exportFrameworkRecords(files, 't', workspace)
  await writeFile(result.path, 'external changed content')
  await assert.rejects(exportFrameworkRecords(files, 't', workspace), /different content/)
  assert.equal(await readFile(result.path, 'utf8'), 'external changed content')
  await assert.rejects(exportFrameworkRecords(files, 'missing', workspace), /not been saved/)
  await assert.rejects(exportFrameworkRecords(files, '../t', workspace), /relative file path/)
})

test('prepared SQLite copy preserves WAL-committed text, bytes and head without switching or deleting the source', async t => {
  const { files, root } = await fixture(t)
  await withSnapshot(files, snapshot => files.commit(snapshot, [
    { path: 'conversations/a/body.txt', content: '原文🙂' },
    { path: 'archives/t/artifacts/data.bin', bytes: new Uint8Array([0, 17, 255]) },
  ], 'fixture'))
  const before = await files.snapshot(); await before.release()
  const prepared = await prepareLocalRecordCopy(files.directory, join(root, 'moved'))
  t.after(() => prepared.dispose())
  await assert.rejects(readFile(join(root, 'moved/dss-files.sqlite')), { code: 'ENOENT' })
  await prepared.publish(); await prepared.publish()
  const destination = await LocalFiles.open(prepared.destination)
  t.after(() => destination.close())
  await withSnapshot(destination, async snapshot => {
    assert.equal(snapshot.revision, before.revision)
    assert.equal(await destination.read(snapshot, 'conversations/a/body.txt'), '原文🙂')
    assert.deepEqual(await destination.readBytes(snapshot, 'archives/t/artifacts/data.bin'), new Uint8Array([0, 17, 255]))
  })
  await withSnapshot(files, async snapshot => assert.equal(await files.read(snapshot, 'conversations/a/body.txt'), '原文🙂'))
})

test('record copy rejects source changes and never overwrites an existing destination database', async t => {
  const { files, root } = await fixture(t)
  const prepared = await prepareLocalRecordCopy(files.directory, join(root, 'changed'))
  t.after(() => prepared.dispose())
  await withSnapshot(files, snapshot => files.commit(snapshot, [{ path: 'new.md', content: 'new' }], 'new source work'))
  await assert.rejects(prepared.publish(), /Source records changed/)
  await assert.rejects(readFile(join(root, 'changed/dss-files.sqlite')), { code: 'ENOENT' })
  const existing = await LocalFiles.open(join(root, 'existing'))
  await withSnapshot(existing, snapshot => existing.commit(snapshot, [{ path: 'keep.md', content: 'keep' }], 'existing'))
  await existing.close()
  const collision = await prepareLocalRecordCopy(files.directory, join(root, 'existing'))
  t.after(() => collision.dispose())
  await assert.rejects(collision.publish(), { code: 'EEXIST' })
  const retained = await LocalFiles.open(join(root, 'existing'))
  t.after(() => retained.close())
  await withSnapshot(retained, async snapshot => assert.equal(await retained.read(snapshot, 'keep.md'), 'keep'))
})

test('record copy cancellation preserves the original and does not publish a partial destination', async t => {
  const { files, root } = await fixture(t)
  const owner = new AbortController(), reason = new Error('user cancelled relocation')
  const prepared = await prepareLocalRecordCopy(files.directory, join(root, 'cancelled'), owner.signal)
  t.after(() => prepared.dispose())
  owner.abort(reason)
  await assert.rejects(prepared.publish(), error => error === reason)
  await assert.rejects(readFile(join(root, 'cancelled/dss-files.sqlite')), { code: 'ENOENT' })
  await assert.rejects(prepareLocalRecordCopy(files.directory, join(files.directory, 'inside')), /inside/)
  await withSnapshot(files, async snapshot => assert.ok(snapshot.revision))
})

test('record copy never adopts or mutates existing SQLite sidecars', async t => {
  const { files, root } = await fixture(t)
  const destination = join(root, 'sidecars'); await mkdir(destination)
  const wal = join(destination, 'dss-files.sqlite-wal'), shm = join(destination, 'dss-files.sqlite-shm')
  await writeFile(wal, 'another database WAL'); await writeFile(shm, 'another database SHM')
  const prepared = await prepareLocalRecordCopy(files.directory, destination)
  t.after(() => prepared.dispose())
  await assert.rejects(prepared.publish(), { code: 'EEXIST' })
  assert.equal(await readFile(wal, 'utf8'), 'another database WAL')
  assert.equal(await readFile(shm, 'utf8'), 'another database SHM')
  await assert.rejects(readFile(join(destination, 'dss-files.sqlite')), { code: 'ENOENT' })
})

test('export of a manifest-resolved legacy document copies its original bytes, never the Task JSON or a summary', async t => {
  const { files, workspace } = await fixture(t)
  const source = 'technical/legacy-migrations/import/text/resolved-records.md', original = '# Previous complete records\n中文🙂\n'
  await withSnapshot(files, snapshot => files.commit(snapshot, [
    { path: source, content: original }, { path: 'technical/legacy-migrations/import/tasks/t.json', content: '{"not":"the assembled records"}' },
  ], 'legacy fixture'))
  const exported = await exportFrameworkDocument(files, source, 'legacy-task', workspace)
  assert.equal(await readFile(exported.path, 'utf8'), original)
  await assert.rejects(exportFrameworkDocument(files, '../outside', 'legacy-task', workspace), /relative file path/)
})

function maintenanceBarrier() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
/** The filesystem write runs normally. Only its completed callback is held so
 * replacement and release ordering are explicit, with no timeout or sleep. */
async function holdCompletedMaintenanceWrite(t: test.TestContext, root: string) {
  const probe = await open(join(root, 'maintenance-handle-probe'), 'wx')
  const prototype = Object.getPrototypeOf(probe) as { writeFile: FileHandle['writeFile'] }
  const original = prototype.writeFile
  await probe.close()
  const entered = maintenanceBarrier(), resume = maintenanceBarrier()
  t.mock.method(prototype, 'writeFile', async function (this: FileHandle, ...args: Parameters<FileHandle['writeFile']>) {
    await original.apply(this, args)
    entered.resolve()
    await resume.promise
  })
  return { entered, resume }
}
async function replaceMaintenanceOutput(path: string, text: string) {
  await rename(path, path + '.owned-original')
  const replacement = await open(path, 'wx')
  try { await replacement.write(Buffer.from(text)) } finally { await replacement.close() }
}

test('cancelled copy rollback preserves a pathname replaced by a different writer', async t => {
  const { files, root } = await fixture(t)
  const controller = new AbortController(), cancellation = new Error('explicit copy cancellation')
  const prepared = await prepareLocalRecordCopy(files.directory, join(root, 'replaced-copy'), controller.signal)
  t.after(() => prepared.dispose())
  const hold = await holdCompletedMaintenanceWrite(t, root)
  const outcome = prepared.publish().then(() => undefined, error => error)
  await hold.entered.promise
  const target = join(prepared.destination, 'dss-files.sqlite')
  try {
    await replaceMaintenanceOutput(target, 'replacement database owner')
    controller.abort(cancellation)
  } finally { hold.resume.resolve() }
  assert.equal(await outcome, cancellation)
  assert.equal(await readFile(target, 'utf8'), 'replacement database owner')
})

test('failed records export rollback preserves another writer replacement', async t => {
  const { files, root, workspace } = await fixture(t)
  await withSnapshot(files, s => files.commit(s, [{ path: 'archives/t/records.md', content: 'original archive' }], 'fixture'))
  const hold = await holdCompletedMaintenanceWrite(t, root)
  const outcome = exportFrameworkRecords(files, 't', workspace).then(() => undefined, error => error)
  await hold.entered.promise
  const target = join(workspace, (await readdir(workspace))[0]!)
  try { await replaceMaintenanceOutput(target, 'replacement exported file') } finally { hold.resume.resolve() }
  assert.match(String(await outcome), /differ/)
  assert.equal(await readFile(target, 'utf8'), 'replacement exported file')
})

test('record copy canonicalizes same-directory aliases but permits a distinct database at the parent directory', async t => {
  const { files, root } = await fixture(t)
  const alias = join(root, 'same-source-alias')
  await symlink(files.directory, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(prepareLocalRecordCopy(files.directory, alias), /current directory/)
  await withSnapshot(files, s => files.commit(s, [{ path: 'source.md', content: 'source retained' }], 'fixture'))
  const prepared = await prepareLocalRecordCopy(files.directory, root)
  t.after(() => prepared.dispose())
  await prepared.publish()
  const destination = await LocalFiles.open(root)
  t.after(() => destination.close())
  await withSnapshot(destination, async s => assert.equal(await destination.read(s, 'source.md'), 'source retained'))
  await withSnapshot(files, async s => assert.equal(await files.read(s, 'source.md'), 'source retained'))
})

test('copy fingerprints technical operation rows even when business head did not change', async t => {
  const { files, root } = await fixture(t)
  const prepared = await prepareLocalRecordCopy(files.directory, join(root, 'receipt-change'))
  t.after(() => prepared.dispose())
  const db = new DatabaseSync(files.databasePath)
  try { db.prepare('INSERT INTO git_operations(id,value) VALUES (?,?)').run('unknown-op', '{"state":"unknown"}') }
  finally { db.close() }
  await assert.rejects(prepared.publish(), /Source records changed/)
  await assert.rejects(readFile(join(prepared.destination, 'dss-files.sqlite')), { code: 'ENOENT' })
})

test('statistics keep Foreground List and Cache in the existing planning category', async t => {
  const { files } = await fixture(t)
  await withSnapshot(files, s => files.commit(s, [
    { path: 'assistants/collaborations/local/main/Foreground_List.md', content: 'list' },
    { path: 'assistants/collaborations/local/main/Foreground_Cache.md', content: 'cache' },
  ], 'fixture'))
  const usage = await frameworkStorageUsage(files)
  assert.equal(usage.permanent.planningBytes, 9)
  assert.equal(usage.permanent.assistantBytes, 0)
})

test('one publication owns the write; disposal closes admission and resolves only after its publication settles', async t => {
  const { files, root } = await fixture(t)
  const prepared = await prepareLocalRecordCopy(files.directory, join(root, 'release-order'))
  const hold = await holdCompletedMaintenanceWrite(t, root)
  const publication = prepared.publish()
  let publicationSettled = false
  const watched = publication.finally(() => { publicationSettled = true })
  await hold.entered.promise
  const concurrent = prepared.publish()
  // Consume the old implementation's independently failing duplicate as well.
  const concurrentOutcome = concurrent.then(() => undefined, error => error)
  let settledBeforeDispose: boolean | undefined
  const disposal = prepared.dispose().then(() => { settledBeforeDispose = publicationSettled })
  const postReleaseAttempt = prepared.publish().then(() => undefined, error => error)
  hold.resume.resolve()
  await Promise.all([watched, disposal])
  assert.equal(concurrent, publication, 'concurrent callers join the exact owned publication')
  assert.equal(await concurrentOutcome, undefined)
  assert.match(String(await postReleaseAttempt), /released/)
  assert.equal(settledBeforeDispose, true)
  assert.equal((await readdir(prepared.destination)).some(name => name.startsWith('.dss-record-copy-')), false)
})

test('read-only validation never adopts or changes pre-existing WAL and shared-memory files', async t => {
  const { files, root } = await fixture(t)
  const destination = join(root, 'foreign-sidecars'); await mkdir(destination)
  const wal = join(destination, 'dss-files.sqlite-wal'), shm = join(destination, 'dss-files.sqlite-shm')
  const walText = 'existing unrelated WAL ownership', shmText = 'existing unrelated SHM ownership'
  await writeFile(wal, walText); await writeFile(shm, shmText)
  const prepared = await prepareLocalRecordCopy(files.directory, destination)
  t.after(() => prepared.dispose())
  await assert.rejects(prepared.publish(), { code: 'EEXIST' })
  assert.equal(await readFile(wal, 'utf8'), walText)
  assert.equal(await readFile(shm, 'utf8'), shmText)
  await assert.rejects(readFile(join(destination, 'dss-files.sqlite')), { code: 'ENOENT' })
})

for (const kind of ['copy', 'export'] as const) test(`${kind} fstat I/O failure closes its handle, preserves cause and never guesses replacement ownership`, async t => {
  const { files, root, workspace } = await fixture(t)
  await withSnapshot(files, s => files.commit(s, [{ path: 'archives/t/records.md', content: 'original archive' }], 'fixture'))
  const prepared = kind === 'copy' ? await prepareLocalRecordCopy(files.directory, workspace) : undefined
  if (prepared) t.after(() => prepared.dispose())
  const probe = await open(join(root, 'stat-failure-probe'), 'wx')
  const prototype = Object.getPrototypeOf(probe) as { stat: FileHandle['stat'] }
  await probe.close()
  let failedHandle: FileHandle | undefined, replacementPath: string | undefined
  const original = Object.assign(new Error('injected fstat I/O failure'), { code: 'EIO' })
  const mocked = t.mock.method(prototype, 'stat', async function (this: FileHandle) {
    failedHandle = this
    replacementPath = join(workspace, (await readdir(workspace)).find(name => !name.startsWith('.'))!)
    await replaceMaintenanceOutput(replacementPath, 'independent replacement')
    throw original
  })
  const caught = await (prepared ? prepared.publish() : exportFrameworkRecords(files, 't', workspace)).then(() => undefined, error => error)
  mocked.mock.restore()
  assert.ok(failedHandle)
  // Close even the old faulty implementation before leaving this synthetic fixture.
  const wasClosed = failedHandle.fd === -1
  await failedHandle.close()
  assert.equal(wasClosed, true)
  assert.equal(caught?.cause, original)
  assert.ok(String(caught).includes(replacementPath!))
  assert.equal(await readFile(replacementPath!, 'utf8'), 'independent replacement')
})

test('already assembled legacy record bytes use the same exact non-overwriting export path', async t => {
  const { exportFrameworkBytes } = await import('../src/framework/maintenance.js')
  const directory = await mkdtemp(join(tmpdir(), 'dss-legacy-bytes-export-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const original = Buffer.from('# Already sealed records\n\n原文😀\n', 'utf8')
  const exported = await exportFrameworkBytes(original, 'old-task/identity', directory)
  assert.deepEqual(await readFile(exported.path), original)
  assert.deepEqual(await exportFrameworkBytes(original, 'old-task/identity', directory), exported)
})
