import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalFiles } from '../src/framework/local-files.js'
import { FrameworkTransactions } from '../src/framework/command-transactions.js'
import { FrameworkCleaner, CleanupReleaseError, CleanupMaterialsChangedError, captureCleanupInputs, captureCleanupReferences, cleanupRecordPath, type TaskRelease, type CleanupRecord } from '../src/framework/cleaner.js'
import { paths, readJson, type TaskMetadata } from '../src/framework/task-files.js'
import { withSnapshot, FilesOutcomeUnknownError, FilesConflictError } from '../src/framework/transactions.js'
import type { StoragePort } from '../src/contracts/ports.js'
const id = '00000000-0000-4000-8000-000000000001'
async function fixture(t: test.TestContext, release: TaskRelease = async () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'dss-cleaner-')), files = await LocalFiles.open(root)
  t.after(async () => { await files.close(); await rm(root, { recursive: true, force: true }) })
  const data = new Map<string, unknown>()
  const records: StoragePort = { async get<T>(key: string) { return data.get(key) as T | undefined }, async set(key, value) { data.set(key, value) }, async list<T>(prefix: string) { return [...data].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: value as T })) } }
  const transactions = new FrameworkTransactions(files, records, 'cleaner-test')
  const task: TaskMetadata = { version: 1, taskId: id, route: 'O', owner: 'A', members: ['A', 'B'], status: 'complete', sourcePath: 'tasks/request_O.md', resultPaths: [paths.run(id) + '/result.txt'] }
  const archive = paths.archive(id) + '/records.md', keep = paths.run(id) + '/evidence.txt'
  const seed = {
    [paths.task(id)]: JSON.stringify(task), [task.sourcePath]: 'Task ID: ' + id + '\nOriginal requirement',
    [paths.run(id) + '/A/Planner_Memory.md']: 'old work memory', [paths.run(id) + '/B/Reply.md']: 'old response',
    [keep]: 'evidence', [task.resultPaths![0]]: 'delivered result', [paths.cache(id)]: 'links',
    [paths.state('A', id) + '/Cleaner']: '', [paths.state('B', id) + '/complete']: '', [paths.state('B', id) + '/recovery']: '',
    [archive]: 'Recorder-authored final record', [paths.archive(id) + '/retention.json']: JSON.stringify({ outputs: [archive], retainedPaths: [keep] }),
    ['skills/verified.md']: 'verified method', ['conversations/shared/entry.json']: 'chat',
    ['task-runs/other/Memory.md']: 'other task', ['state/A/other/Planner_Inbox']: '', ['debug/Helper_Memory.md']: 'ongoing diagnostics',
  }
  await withSnapshot(files, snapshot => files.commit(snapshot, Object.entries(seed).map(([path, content]) => ({ path, content })), 'seed controlled recorder outputs'))
  await withSnapshot(files, async snapshot => files.commit(snapshot, [{ path: paths.archive(id) + '/retention.json', content: JSON.stringify({ outputs: [archive], retainedPaths: [keep], inputs: await captureCleanupInputs(files, snapshot, task), verifiedReferences: await captureCleanupReferences(files, snapshot, [archive, keep]) }) }], 'Recorder captures evaluated material versions'))
  return { files, transactions, task, archive, keep, cleaner: new FrameworkCleaner(files, transactions, release) }
}
test('fixed cleanup preserves outputs, retained evidence, Foreground results and unrelated lifecycles', async t => {
  const f = await fixture(t)
  const result = await withSnapshot(f.files, snapshot => f.cleaner.clean(f.task, snapshot))
  assert.equal(result.status, 'released')
  if (result.status === 'released') assert.ok(result.record.preservedPaths.includes(paths.state('B', id) + '/recovery'))
  await withSnapshot(f.files, async snapshot => {
    for (const path of [f.archive, f.keep, f.task.resultPaths![0], paths.task(id), 'skills/verified.md', 'conversations/shared/entry.json', 'task-runs/other/Memory.md', 'debug/Helper_Memory.md', paths.state('B', id) + '/recovery']) assert.notEqual(await f.files.read(snapshot, path), undefined, path)
    for (const path of [f.task.sourcePath, paths.run(id) + '/A/Planner_Memory.md', paths.run(id) + '/B/Reply.md', paths.cache(id), paths.state('A', id) + '/Cleaner', paths.state('B', id) + '/complete']) assert.equal(await f.files.read(snapshot, path), undefined, path)
    assert.equal((await readJson<TaskMetadata>(f.files, snapshot, paths.task(id)))?.status, 'complete')
    assert.equal((await readJson<CleanupRecord>(f.files, snapshot, cleanupRecordPath(id)))?.phase, 'released')
  })
})
test('Host release observes confirmed file cleanup and can resume after callback failure', async t => {
  const f = await fixture(t)
  let calls = 0
  const release: TaskRelease = async (_task, record) => {
    calls++
    assert.equal(record.phase, 'files-cleaned')
    await withSnapshot(f.files, async snapshot => assert.equal(await f.files.read(snapshot, paths.run(id) + '/A/Planner_Memory.md'), undefined))
    if (calls === 1) throw new Error('controlled local release failure')
  }
  const first = new FrameworkCleaner(f.files, f.transactions, release)
  await assert.rejects(withSnapshot(f.files, snapshot => first.clean(f.task, snapshot)), CleanupReleaseError)
  const restarted = new FrameworkCleaner(f.files, f.transactions, release)
  assert.equal((await withSnapshot(f.files, snapshot => restarted.clean(f.task, snapshot))).status, 'released')
  await withSnapshot(f.files, snapshot => restarted.clean(f.task, snapshot))
  assert.equal(calls, 2)
})
test('unconfirmed cleanup does not release Host associations', async t => {
  let released = false
  const f = await fixture(t, async () => { released = true })
  f.files.commit = async () => { throw new FilesOutcomeUnknownError('same-operation') }
  await assert.rejects(withSnapshot(f.files, snapshot => f.cleaner.clean(f.task, snapshot)), FilesOutcomeUnknownError)
  assert.equal(released, false)
  await withSnapshot(f.files, async snapshot => assert.equal(await f.files.read(snapshot, paths.run(id) + '/A/Planner_Memory.md'), 'old work memory'))
})
test('lost acknowledgement after real SQLite COMMIT resumes using durable cleanup record', async t => {
  let releases = 0
  const f = await fixture(t, async () => { releases++ })
  const commit = f.files.commit.bind(f.files)
  let lose = true
  f.files.commit = async (...args) => { const receipt = await commit(...args); if (lose) { lose = false; throw new FilesOutcomeUnknownError('ack-lost', undefined, receipt) } return receipt }
  await assert.rejects(withSnapshot(f.files, snapshot => f.cleaner.clean(f.task, snapshot)), FilesOutcomeUnknownError)
  assert.equal(releases, 0)
  await withSnapshot(f.files, snapshot => f.cleaner.clean(f.task, snapshot))
  assert.equal(releases, 1)
})
test('missing retained output leaves runtime and Cleaner intact', async t => {
  let releases = 0
  const f = await fixture(t, async () => { releases++ })
  await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [{ path: f.keep, content: null }], 'remove controlled evidence'))
  await withSnapshot(f.files, async snapshot => f.files.commit(snapshot, [{ path: paths.archive(id) + '/retention.json', content: JSON.stringify({ outputs: [f.archive], retainedPaths: [f.keep], inputs: await captureCleanupInputs(f.files, snapshot, f.task), verifiedReferences: await captureCleanupReferences(f.files, snapshot, [f.archive, f.keep]) }) }], 'evaluated material still references missing retained artifact'))
  await assert.rejects(withSnapshot(f.files, snapshot => f.cleaner.clean(f.task, snapshot)), (error: unknown) => { assert.ok(error instanceof CleanupMaterialsChangedError); assert.ok(error.paths.includes(f.keep)); return true })
  assert.equal(releases, 0)
  await withSnapshot(f.files, async snapshot => assert.equal(await f.files.read(snapshot, paths.state('A', id) + '/Cleaner'), ''))
})
test('later submission reusing source filename is not deleted with the older Task', async t => {
  const f = await fixture(t)
  await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [{ path: f.task.sourcePath, content: 'A new requirement without the old Task ID' }], 'new submission'))
  await assert.rejects(withSnapshot(f.files, snapshot => f.cleaner.clean(f.task, snapshot)), CleanupMaterialsChangedError)
  await withSnapshot(f.files, async snapshot => f.files.commit(snapshot, [{ path: paths.archive(id) + '/retention.json', content: JSON.stringify({ outputs: [f.archive], retainedPaths: [f.keep], inputs: await captureCleanupInputs(f.files, snapshot, f.task), verifiedReferences: await captureCleanupReferences(f.files, snapshot, [f.archive, f.keep]) }) }], 'Recorder reevaluates old source replacement'))
  await withSnapshot(f.files, snapshot => f.cleaner.clean(f.task, snapshot))
  await withSnapshot(f.files, async snapshot => assert.equal(await f.files.read(snapshot, f.task.sourcePath), 'A new requirement without the old Task ID'))
})
test('absent Cleaner does not authorize cleanup or release', async t => {
  let releases = 0
  const f = await fixture(t, async () => { releases++ })
  await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [{ path: paths.state('A', id) + '/Cleaner', content: null }], 'not requested'))
  assert.deepEqual(await withSnapshot(f.files, snapshot => f.cleaner.clean(f.task, snapshot)), { status: 'not-requested' })
  assert.equal(releases, 0)
})
test('fixed snapshot CAS conflict preserves files and defers release', async t => {
  let releases = 0
  const f = await fixture(t, async () => { releases++ })
  const stale = await f.files.snapshot()
  try {
    await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [{ path: 'unrelated.txt', content: 'concurrent write' }], 'concurrent'))
    await assert.rejects(f.cleaner.clean(f.task, stale), FilesConflictError)
    assert.equal(releases, 0)
  } finally { await stale.release() }
  await withSnapshot(f.files, snapshot => f.cleaner.clean(f.task, snapshot))
  assert.equal(releases, 1)
})
test('cleanup retains actual binary artifacts without interpreting them as UTF8 text', async t => {
  let releases = 0
  const f = await fixture(t, async () => { releases++ })
  const binary = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe])
  const output = paths.archive(id) + '/output.png'
  await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [
    { path: f.keep, bytes: binary }, { path: output, bytes: binary },
    { path: paths.archive(id) + '/retention.json', content: JSON.stringify({ outputs: [f.archive, output], retainedPaths: [f.keep] }) },
  ], 'retain binary output and original evidence'))
  await withSnapshot(f.files, async snapshot => f.files.commit(snapshot, [{ path: paths.archive(id) + '/retention.json', content: JSON.stringify({ outputs: [f.archive, output], retainedPaths: [f.keep], inputs: await captureCleanupInputs(f.files, snapshot, f.task), verifiedReferences: await captureCleanupReferences(f.files, snapshot, [f.archive, output, f.keep]) }) }], 'Recorder evaluates binary evidence'))
  assert.equal((await withSnapshot(f.files, snapshot => f.cleaner.clean(f.task, snapshot))).status, 'released')
  assert.equal(releases, 1)
  await withSnapshot(f.files, async snapshot => {
    assert.deepEqual(await f.files.readBytes(snapshot, f.keep), binary)
    assert.deepEqual(await f.files.readBytes(snapshot, output), binary)
    assert.equal(await f.files.read(snapshot, paths.run(id) + '/A/Planner_Memory.md'), undefined)
  })
})

test('late Worker facts after Recorder readback but before cleanup must not disappear unarchived', async t => {
  let releases = 0
  const f = await fixture(t, async () => { releases++ })
  const notes = paths.run(id) + '/A/workers/child/notes.md'
  const earlier = 'Observed before Recorder summary.\n'
  const late = 'Late Worker fact: exact failure location src/example.ts:42.\n'
  // Real SQLite commits model the ordering of scoped record writes and Recorder
  // publication. No native/model execution or concurrency scheduler is simulated.
  await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [
    { path: notes, content: earlier },
    { path: paths.state('A', id) + '/Cleaner', content: null },
  ], 'Worker notes before Recorder read'))
  const evaluatedInputs = await withSnapshot(f.files, snapshot => captureCleanupInputs(f.files, snapshot, f.task))
  const readByRecorder = await withSnapshot(f.files, snapshot => f.files.read(snapshot, notes))
  assert.equal(readByRecorder, earlier)
  await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [
    { path: f.archive, content: 'Recorder summary of known facts:\n' + readByRecorder },
  ], 'Recorder saves summary'))
  await withSnapshot(f.files, async snapshot => assert.equal(await f.files.read(snapshot, f.archive), 'Recorder summary of known facts:\n' + earlier))
  await withSnapshot(f.files, async snapshot => f.files.commit(snapshot, [
    { path: paths.archive(id) + '/retention.json', content: JSON.stringify({ outputs: [f.archive], retainedPaths: [f.keep], inputs: evaluatedInputs, verifiedReferences: await captureCleanupReferences(f.files, snapshot, [f.archive, f.keep]) }) },
    { path: paths.state('A', id) + '/Cleaner', content: '' },
  ], 'Recorder publishes retention after readback'))
  await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [{ path: notes, content: earlier + late }], 'Already active Worker appends before Host stop'))
  // Stopping business executions now cannot undo the already committed late fact.
  // Cleaner is intentionally given the newest H, not a stale snapshot: its normal
  // CAS check alone cannot detect that Recorder summarized an older version.
  let cleanupError: unknown
  try { await withSnapshot(f.files, snapshot => f.cleaner.clean(f.task, snapshot)) } catch (error) { cleanupError = error }
  assert.ok(cleanupError instanceof CleanupMaterialsChangedError)
  assert.deepEqual(cleanupError.paths, [notes])
  assert.equal(releases, 0)
  await withSnapshot(f.files, async snapshot => {
    const surviving = await f.files.read(snapshot, notes), archived = await f.files.read(snapshot, f.archive)
    assert.ok(surviving?.includes(late) || archived?.includes(late),
      `late durable fact was deleted without archival; releases=${releases}, cleanupError=${String(cleanupError)}`)
  })
})

for (const change of ['new', 'modified', 'deleted'] as const) test(`Cleaner defers ${change} material until Recorder reevaluates, without releasing or deleting other facts`, async t => {
  let released = 0
  const f = await fixture(t, async () => { released++ })
  const target = change === 'new' ? paths.run(id) + '/A/new-fact.md' : paths.run(id) + '/A/Planner_Memory.md'
  await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [{ path: target, content: change === 'deleted' ? null : 'Changed durable material' }], 'late material change'))
  await assert.rejects(withSnapshot(f.files, snapshot => f.cleaner.clean(f.task, snapshot)), (error: unknown) => {
    assert.ok(error instanceof CleanupMaterialsChangedError); assert.deepEqual(error.paths, [target]); return true
  })
  assert.equal(released, 0)
  await withSnapshot(f.files, async snapshot => {
    assert.equal(await f.files.read(snapshot, paths.run(id) + '/B/Reply.md'), 'old response')
    assert.equal(await f.files.read(snapshot, cleanupRecordPath(id)), undefined)
    assert.equal(await f.files.read(snapshot, paths.state('A', id) + '/Cleaner'), '')
  })
  await withSnapshot(f.files, async snapshot => {
    const inputs = await captureCleanupInputs(f.files, snapshot, f.task)
    await f.files.commit(snapshot, [
      { path: f.archive, content: 'Recorder reread and assessed changed material: ' + change },
      { path: paths.archive(id) + '/retention.json', content: JSON.stringify({ outputs: [f.archive], retainedPaths: [f.keep], inputs, verifiedReferences: await captureCleanupReferences(f.files, snapshot, [f.archive, f.keep], [{ path: f.archive, content: 'Recorder reread and assessed changed material: ' + change }]) }) },
    ], 'Recorder reevaluated material')
  })
  assert.equal((await withSnapshot(f.files, snapshot => f.cleaner.clean(f.task, snapshot))).status, 'released')
  assert.equal(released, 1)
})

test('heartbeat and inbox observation metadata do not invalidate evaluated original material', async t => {
  const f = await fixture(t)
  await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [
    { path: 'instances/A.json', content: '{"heartbeat":1}' },
    { path: paths.run(id) + '/A/inbox-observation.json', content: '{"observedAt":1}' },
    { path: 'technical/unrelated-observation.json', content: '{"time":2}' },
  ], 'technical lifecycle updates'))
  assert.equal((await withSnapshot(f.files, snapshot => f.cleaner.clean(f.task, snapshot))).status, 'released')
})

test('legacy retention without evaluated inputs preserves original material and requests review', async t => {
  let released = 0
  const f = await fixture(t, async () => { released++ })
  await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [{ path: paths.archive(id) + '/retention.json', content: JSON.stringify({ outputs: [f.archive], retainedPaths: [f.keep] }) }], 'old candidate without input versions'))
  await assert.rejects(withSnapshot(f.files, snapshot => f.cleaner.clean(f.task, snapshot)), CleanupMaterialsChangedError)
  assert.equal(released, 0)
  await withSnapshot(f.files, async snapshot => assert.equal(await f.files.read(snapshot, paths.run(id) + '/A/Planner_Memory.md'), 'old work memory'))
})
