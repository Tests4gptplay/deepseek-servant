import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FrameworkRoleRuntime } from '../src/framework/role-runtime.js'
import { LocalFiles } from '../src/framework/local-files.js'
import { FrameworkConversation } from '../src/framework/conversation.js'
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
  if (result.status === 'released') assert.ok(result.record.deletedPaths.includes(paths.state('B', id) + '/recovery'))
  await withSnapshot(f.files, async snapshot => {
    for (const path of [f.archive, paths.task(id), 'skills/verified.md', 'conversations/shared/entry.json', 'task-runs/other/Memory.md', 'debug/Helper_Memory.md']) assert.notEqual(await f.files.read(snapshot, path), undefined, path)
    for (const path of [f.task.sourcePath, paths.run(id) + '/A/Planner_Memory.md', paths.run(id) + '/B/Reply.md', paths.cache(id), paths.state('A', id) + '/Cleaner', paths.state('B', id) + '/complete', paths.state('B', id) + '/recovery']) assert.equal(await f.files.read(snapshot, path), undefined, path)
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
    const retention = await readJson<{ relocatedReferences: Record<string,string> }>(f.files, snapshot, paths.archive(id) + '/retention.json')
    assert.equal(await f.files.readBytes(snapshot, f.keep), undefined)
    assert.deepEqual(await f.files.readBytes(snapshot, retention!.relocatedReferences[f.keep]), binary)
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

for (const role of ['Organizer', 'Recorder']) test(`sealed Task cleanup removes ${role} owner recovery and preserves another Task recovery`, async t => {
  const f = await fixture(t)
  // Organizer/Recorder restoration uses the existing owner/Task recovery marker,
  // not a new role-specific directory. Final cleanup is not ordinary role claim.
  const marker = paths.state(f.task.owner, id) + '/recovery', other = paths.state(f.task.owner, 'other') + '/recovery'
  await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [{ path: marker, content: '' }, { path: other, content: '' }], role + ' restoration marker before final cleanup'))
  const result = await withSnapshot(f.files, snapshot => f.cleaner.clean(f.task, snapshot))
  assert.equal(result.status, 'released')
  await withSnapshot(f.files, async snapshot => {
    assert.equal(await f.files.read(snapshot, marker), undefined)
    assert.equal(await f.files.read(snapshot, paths.state('B', id) + '/recovery'), undefined)
    assert.equal(await f.files.read(snapshot, other), '')
    assert.equal(await f.files.read(snapshot, f.archive), 'Recorder-authored final record')
    const metadata = await readJson<TaskMetadata>(f.files, snapshot, paths.task(id))
    assert.equal(await f.files.read(snapshot, metadata!.resultPaths![0]), 'delivered result')
  })
})

test('legacy explicit retention of recovery does not turn a state signal into a permanent artifact', async t => {
  const f = await fixture(t), marker = paths.state('B', id) + '/recovery'
  await withSnapshot(f.files, async snapshot => f.files.commit(snapshot, [{ path: paths.archive(id) + '/retention.json', content: JSON.stringify({
    outputs: [f.archive], retainedPaths: [f.keep, marker], inputs: await captureCleanupInputs(f.files, snapshot, f.task),
    verifiedReferences: await captureCleanupReferences(f.files, snapshot, [f.archive, f.keep, marker]),
  }) }], 'explicit verified Recorder reference'))
  await withSnapshot(f.files, snapshot => f.cleaner.clean(f.task, snapshot))
  await withSnapshot(f.files, async snapshot => {
    assert.equal(await f.files.read(snapshot, marker), undefined)
    assert.equal((await f.files.list(snapshot, paths.archive(id) + '/retained/')).some(entry => entry.path.endsWith('/recovery')), false)
  })
})

test('final cleanup relocates unique retained work bytes before deleting the complete working namespace', async t => {
  const f = await fixture(t)
  const result = await withSnapshot(f.files, snapshot => f.cleaner.clean(f.task, snapshot))
  assert.equal(result.status, 'released')
  await withSnapshot(f.files, async snapshot => {
    assert.deepEqual(await f.files.list(snapshot, paths.run(id)), [])
    assert.deepEqual(await f.files.list(snapshot, 'Recorder Cache/' + id), [])
    const metadata = await readJson<TaskMetadata>(f.files, snapshot, paths.task(id))
    assert.ok(metadata?.resultPaths?.[0].startsWith(paths.archive(id) + '/'))
    assert.equal(await f.files.read(snapshot, metadata!.resultPaths![0]), 'delivered result')
    const retention = await readJson<{ relocatedReferences: Record<string, string> }>(f.files, snapshot, paths.archive(id) + '/retention.json')
    assert.equal(await f.files.read(snapshot, retention!.relocatedReferences[f.keep]), 'evidence')
    assert.equal(await f.files.read(snapshot, f.archive), 'Recorder-authored final record')
  })
})

test('legacy evaluated work directory retention expands exact leaves while state ancestor cannot retain signals', async t => {
  const f = await fixture(t)
  await withSnapshot(f.files, async snapshot => f.files.commit(snapshot, [{ path: paths.archive(id) + '/retention.json', content: JSON.stringify({
    outputs: [f.archive], retainedPaths: [paths.run(id), paths.state('A', id), paths.state('B', id)],
    inputs: await captureCleanupInputs(f.files, snapshot, f.task), verifiedReferences: await captureCleanupReferences(f.files, snapshot, [f.archive]),
  }) }], 'legacy directory references with exact evaluated work versions'))
  await withSnapshot(f.files, snapshot => f.cleaner.clean(f.task, snapshot))
  await withSnapshot(f.files, async snapshot => {
    assert.deepEqual(await f.files.list(snapshot, paths.run(id)), [])
    assert.deepEqual(await f.files.list(snapshot, paths.state('A', id)), [])
    assert.deepEqual(await f.files.list(snapshot, paths.state('B', id)), [])
    const retention = await readJson<{ relocatedReferences: Record<string,string> }>(f.files, snapshot, paths.archive(id) + '/retention.json')
    assert.equal(await f.files.read(snapshot, retention!.relocatedReferences[paths.run(id) + '/A/Planner_Memory.md']), 'old work memory')
    assert.equal(Object.keys(retention!.relocatedReferences).some(path => path.startsWith('state/')), false)
  })
})

test('archive copy corruption on readback prevents workspace deletion and Host release', async t => {
  let released = false
  const f = await fixture(t, async () => { released = true }), originalCommit = f.files.commit.bind(f.files)
  let damaged = false
  f.files.commit = async (...args) => {
    const receipt = await originalCommit(...args)
    const copied = args[1].find(change => change.path.startsWith(paths.archive(id) + '/retained/'))
    if (copied && !damaged) {
      damaged = true
      await withSnapshot(f.files, snapshot => originalCommit(snapshot, [{ path: copied.path, content: 'damaged saved bytes' }], 'controlled postcommit storage corruption'))
    }
    return receipt
  }
  await assert.rejects(withSnapshot(f.files, snapshot => f.cleaner.clean(f.task, snapshot)), CleanupMaterialsChangedError)
  assert.equal(released, false)
  await withSnapshot(f.files, async snapshot => {
    assert.equal(await f.files.read(snapshot, f.keep), 'evidence')
    assert.equal(await f.files.read(snapshot, paths.state('A', id) + '/Cleaner'), '')
    assert.equal(await f.files.read(snapshot, cleanupRecordPath(id)), undefined)
  })
})


function runtimeCleaner(f: Awaited<ReturnType<typeof fixture>>) {
  const runtime = Object.create(FrameworkRoleRuntime.prototype) as any
  Object.assign(runtime, { files: f.files, cleaner: f.cleaner, roleRecords: new Map(), closed: false,
    businessStopped: () => true, wake: async () => {} })
  return runtime
}
test('Host Cleaner immediately reevaluates a proven concurrent HEAD instead of waiting for another poll', async t => {
  const f = await fixture(t), runtime = runtimeCleaner(f), stale = await f.files.snapshot()
  try {
    await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [{ path: 'conversations/concurrent.md', content: 'new actual message' }], 'concurrent final'))
    assert.equal(await runtime.clean(f.task, stale), true)
    await withSnapshot(f.files, async current => assert.equal((await readJson<CleanupRecord>(f.files, current, cleanupRecordPath(id)))?.phase, 'released'))
    assert.equal(await f.files.read(stale, f.archive), 'Recorder-authored final record')
  } finally { await stale.release() }
})

test('Host Cleaner follows consecutive proven new HEAD conflicts with the original command and releases only owned views', async t => {
  const f = await fixture(t), runtime = runtimeCleaner(f), borrowed = await f.files.snapshot()
  const snapshot = f.files.snapshot.bind(f.files), commit = f.files.commit.bind(f.files), views: number[] = [], attempts: string[] = []
  f.files.snapshot = async () => { const view = await snapshot(), release = view.release.bind(view), index = views.push(0) - 1
    view.release = async () => { views[index]++; await release() }; return view }
  let conflicts = 0, currentCommand = '', injecting = false
  const conversation = new FrameworkConversation(f.files, f.transactions, { mode: 'local', collaborationId: 'concurrent-cleaner' })
  const run = f.transactions.run.bind(f.transactions)
  f.transactions.run = async (...args) => { currentCommand = args[0]; return run(...args) }
  f.files.commit = async (...args) => {
    if (!injecting && conflicts < 3) {
      attempts.push(currentCommand); conflicts++; injecting = true
      try { await conversation.send('chat-' + conflicts, { id: 'chat-' + conflicts, participantId: 'A', createdAt: '2026-11-01T00:00:00.000Z', role: 'user', recipient: 'human', text: 'concurrent message ' + conflicts }) }
      finally { injecting = false }
    }
    return commit(...args)
  }
  try {
    assert.equal(await runtime.clean(f.task, borrowed), true)
    assert.equal(conflicts, 3)
    assert.equal((await conversation.page(10)).messages.length, 3, 'all real concurrent conversation commits remain visible')
    assert.equal(new Set(attempts).size, 1, 'proven conflicts retain the same cleanup command identity')
    assert.equal(await f.files.read(borrowed, f.keep), 'evidence', 'borrowed snapshot remains owned by the caller')
    assert.ok(views.length >= 3); assert.ok(views.every(count => count === 1), 'all fresh owned and nested views released exactly once')
  } finally { await borrowed.release() }
})

for (const kind of ['same-head', 'unknown-new-head', 'permission-new-head', 'closed-new-head'] as const) test(`Host Cleaner does not automatically retry ${kind}`, async t => {
  const f = await fixture(t), runtime = runtimeCleaner(f), borrowed = await f.files.snapshot(), commit = f.files.commit.bind(f.files)
  let calls = 0
  const failure = kind === 'unknown-new-head' ? new FilesOutcomeUnknownError('fixed-cleanup-operation')
    : kind === 'permission-new-head' ? new Error('Permission denied') : new FilesConflictError(borrowed.revision)
  f.cleaner.clean = async () => {
    calls++
    if (kind !== 'same-head') await withSnapshot(f.files, current => commit(current, [{ path: 'conversations/independent.md', content: 'new actual input' }], 'independent input'))
    if (kind === 'closed-new-head') runtime.closed = true
    throw failure
  }
  try {
    await assert.rejects(runtime.clean(f.task, borrowed), (error: unknown) => error === failure)
    assert.equal(calls, 1)
    assert.equal(await f.files.read(borrowed, f.keep), 'evidence')
    await withSnapshot(f.files, async current => {
      assert.equal(await f.files.read(current, f.keep), 'evidence')
      assert.equal(await f.files.read(current, cleanupRecordPath(id)), undefined)
    })
  } finally { await borrowed.release() }
})

test('Host Cleaner changed material after a proven conflict requeues Recorder and preserves original bytes', async t => {
  const f = await fixture(t), runtime = runtimeCleaner(f), borrowed = await f.files.snapshot()
  const commit = f.files.commit.bind(f.files), wakes: any[] = []; let changed = false
  runtime.wake = async (request: any) => { wakes.push(request); return true }
  f.files.commit = async (...args) => {
    if (!changed) {
      changed = true
      await withSnapshot(f.files, current => commit(current, [{ path: paths.run(id) + '/A/Planner_Memory.md', content: 'new original work after Recorder snapshot' }], 'actual late work'))
    }
    return commit(...args)
  }
  try {
    assert.equal(await runtime.clean(f.task, borrowed), false)
    assert.equal(wakes.length, 1); assert.equal(wakes[0].role, 'Recorder')
    assert.ok(wakes[0].context.changedOriginalPaths.includes(paths.run(id) + '/A/Planner_Memory.md'))
    await withSnapshot(f.files, async current => {
      assert.equal(await f.files.read(current, paths.run(id) + '/A/Planner_Memory.md'), 'new original work after Recorder snapshot')
      assert.equal(await f.files.read(current, f.keep), 'evidence')
      assert.equal(await f.files.read(current, f.archive), 'Recorder-authored final record')
      assert.equal(await f.files.read(current, cleanupRecordPath(id)), undefined)
    })
  } finally { await borrowed.release() }
})

test('independent close during second conflict owned release does not begin a third cleanup attempt', async t => {
  const f = await fixture(t), runtime = runtimeCleaner(f), borrowed = await f.files.snapshot()
  const snapshot = f.files.snapshot.bind(f.files), commit = f.files.commit.bind(f.files)
  let attempts = 0, viewCount = 0, releases = 0, secondFailure: unknown
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
  f.files.snapshot = async () => {
    const view = await snapshot(), release = view.release.bind(view), index = ++viewCount
    view.release = async () => { if (index === 1) { entered.resolve(); await gate.promise }; releases++; await release() }
    return view
  }
  const clean = f.cleaner.clean.bind(f.cleaner)
  f.cleaner.clean = async (...args) => {
    attempts++
    if (attempts <= 2) {
      const concurrent = await snapshot()
      try { await commit(concurrent, [{path: 'conversations/close-' + attempts, content: 'real new HEAD'}], 'close test ' + attempts) }
      finally { await concurrent.release() }
      const failure = new FilesConflictError(args[1].revision)
      if (attempts === 2) secondFailure = failure
      throw failure
    }
    return clean(...args)
  }
  const result = runtime.clean(f.task, borrowed).then((value: unknown) => ({value}), (error: unknown) => ({error}))
  await entered.promise; runtime.closed = true; gate.resolve()
  const outcome = await result
  try {
    assert.equal(attempts, 2, 'closed during owned release must not begin third cleanup')
    assert.equal((outcome as {error?: unknown}).error, secondFailure)
    assert.equal(releases, 2)
    assert.equal(await f.files.read(borrowed, f.keep), 'evidence')
    await withSnapshot(f.files, async current => assert.equal(await f.files.read(current, cleanupRecordPath(id)), undefined))
  } finally { await borrowed.release() }
})
