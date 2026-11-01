import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalFiles } from '../src/framework/local-files.js'
import { FrameworkTransactions } from '../src/framework/command-transactions.js'
import { FrameworkCleaner, changedCleanupMaterials, clearCleanupReferenceCache, captureCleanupInputs, captureCleanupReferences, CleanupMaterialsChangedError, cleanupRecordPath } from '../src/framework/cleaner.js'
import { paths, type TaskMetadata } from '../src/framework/task-files.js'
import { withSnapshot } from '../src/framework/transactions.js'
import type { StoragePort } from '../src/contracts/ports.js'

// Real SQLite, transaction coordinator and Cleaner. Explicit storage write ordering
// represents separate actors, not a running native Host or model acceptance test.
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'dss-completion-combinations-'))
  const files = await LocalFiles.open(directory)
  t.after(async () => { await files.close(); await rm(directory, { recursive: true, force: true }) })
  const rows = new Map<string, unknown>()
  const records: StoragePort = {
    get: async <T>(key: string) => structuredClone(rows.get(key)) as T | undefined,
    set: async (key, value) => { rows.set(key, structuredClone(value)) },
    list: async <T>(prefix: string) => [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) as T })),
  }
  const transactions = new FrameworkTransactions(files, records, 'completion-combinations')
  const tasks: TaskMetadata[] = [
    { version: 1, taskId: '11111111-1111-4111-8111-111111111111', owner: 'A', members: ['A', 'B'], route: 'O', status: 'complete', sourcePath: 'tasks/first_O.md' },
    { version: 1, taskId: '22222222-2222-4222-8222-222222222222', owner: 'A', members: ['A', 'B'], route: 'P', status: 'complete', sourcePath: 'tasks/second_P.md' },
  ]
  for (const task of tasks) {
    const fact = 'Original verified evidence for ' + task.taskId
    await withSnapshot(files, snapshot => files.commit(snapshot, [
      { path: paths.task(task.taskId), content: JSON.stringify(task) },
      { path: task.sourcePath, content: 'Task ID: ' + task.taskId + '\nOriginal requirement' },
      { path: paths.member(task.taskId, 'B') + '/Reply.md', content: fact },
      { path: paths.archive(task.taskId) + '/records.md', content: fact },
    ], 'completed task and Recorder output'))
    await withSnapshot(files, async snapshot => {
      assert.equal(await files.read(snapshot, paths.archive(task.taskId) + '/records.md'), fact)
      await files.commit(snapshot, [
        { path: paths.archive(task.taskId) + '/retention.json', content: JSON.stringify({ outputs: [paths.archive(task.taskId) + '/records.md'], retainedPaths: [], recorderCommand: 'recorder-' + task.taskId, inputs: await captureCleanupInputs(files, snapshot, task), verifiedReferences: await captureCleanupReferences(files, snapshot, [paths.archive(task.taskId) + '/records.md']) }) },
        { path: paths.state(task.owner, task.taskId) + '/Cleaner', content: '' },
      ], 'Recorder readback followed by cleanup request')
    })
  }
  const released: string[] = []
  return { files, tasks, released, cleaner: new FrameworkCleaner(files, transactions, async task => { released.push(task.taskId) }) }
}

test('cleaning one completed Task leaves another Task originals, request and archive untouched', async t => {
  const { files, tasks: [first, second], cleaner, released } = await fixture(t)
  await withSnapshot(files, snapshot => cleaner.clean(first!, snapshot))
  assert.deepEqual(released, [first!.taskId])
  await withSnapshot(files, async snapshot => {
    assert.equal(await files.read(snapshot, paths.member(first!.taskId, 'B') + '/Reply.md'), undefined)
    assert.equal(await files.read(snapshot, paths.member(second!.taskId, 'B') + '/Reply.md'), 'Original verified evidence for ' + second!.taskId)
    assert.equal(await files.read(snapshot, paths.state(second!.owner, second!.taskId) + '/Cleaner'), '')
    assert.equal(await files.read(snapshot, cleanupRecordPath(second!.taskId)), undefined)
    for (const task of [first!, second!]) assert.equal(await files.read(snapshot, paths.archive(task.taskId) + '/records.md'), 'Original verified evidence for ' + task.taskId)
  })
})

test('archive truncated after verified save must not cause deletion of the only remaining original facts', async t => {
  const { files, tasks: [task, other], cleaner, released } = await fixture(t)
  const archive = paths.archive(task!.taskId) + '/records.md', original = paths.member(task!.taskId, 'B') + '/Reply.md'
  const fact = 'Original verified evidence for ' + task!.taskId
  // dss_direct_deliver currently permits this resultPath and empty text; its
  // write plan is result + recipient signal. Run that exact storage plan here,
  // without claiming native tool/schema execution in this dependency-free test.
  await withSnapshot(files, snapshot => files.commit(snapshot, [
    { path: archive, content: '' }, { path: 'state/Foreground_direct-result', content: '' },
  ], 'direct result write changes previously verified output'))
  let cleanupError: unknown
  try { await withSnapshot(files, snapshot => cleaner.clean(task!, snapshot)) } catch (error) { cleanupError = error }
  await withSnapshot(files, async snapshot => {
    assert.ok((await files.read(snapshot, original))?.includes(fact) || (await files.read(snapshot, archive))?.includes(fact),
      `verified output changed; original facts lost: releases=${JSON.stringify(released)}, cleanupError=${String(cleanupError)}`)
    assert.equal(await files.read(snapshot, paths.member(other!.taskId, 'B') + '/Reply.md'), 'Original verified evidence for ' + other!.taskId)
  })
})

for (const fault of ['output-modified', 'output-deleted', 'binary-retained-modified', 'missing-reference-hash'] as const) {
  test(`declared reference integrity: ${fault} preserves originals until Recorder rechecks`, async t => {
    const { files, tasks: [task, other], cleaner, released } = await fixture(t)
    const archive = paths.archive(task!.taskId) + '/records.md', manifestPath = paths.archive(task!.taskId) + '/retention.json'
    const attachment = paths.archive(task!.taskId) + '/proof.bin', binary = Uint8Array.from([0, 255, 254, 128])
    const original = paths.member(task!.taskId, 'B') + '/Reply.md', fact = 'Original verified evidence for ' + task!.taskId
    await withSnapshot(files, async snapshot => {
      const staged = [{ path: attachment, bytes: binary }]
      await files.commit(snapshot, [...staged, { path: manifestPath, content: JSON.stringify({ outputs: [archive], retainedPaths: [attachment],
        inputs: await captureCleanupInputs(files, snapshot, task!), verifiedReferences: await captureCleanupReferences(files, snapshot, [archive, attachment], staged) }) }], 'Recorder verifies retained binary')
    })
    await withSnapshot(files, async snapshot => {
      if (fault === 'missing-reference-hash') {
        const manifest = JSON.parse((await files.read(snapshot, manifestPath))!)
        delete manifest.verifiedReferences[attachment]
        await files.commit(snapshot, [{ path: manifestPath, content: JSON.stringify(manifest) }], 'unverified reference candidate')
      } else await files.commit(snapshot, [fault === 'binary-retained-modified'
        ? { path: attachment, bytes: Uint8Array.from([0, 255, 254, 129]) }
        : { path: archive, content: fault === 'output-deleted' ? null : 'Changed summary without original fact' }], 'declared reference changes')
    })
    await assert.rejects(withSnapshot(files, snapshot => cleaner.clean(task!, snapshot)), (error: unknown) => {
      assert.ok(error instanceof CleanupMaterialsChangedError)
      assert.deepEqual(error.paths, [fault === 'binary-retained-modified' || fault === 'missing-reference-hash' ? attachment : archive])
      return true
    })
    assert.deepEqual(released, [])
    await withSnapshot(files, async snapshot => {
      assert.equal(await files.read(snapshot, original), fact)
      assert.equal(await files.read(snapshot, paths.member(other!.taskId, 'B') + '/Reply.md'), 'Original verified evidence for ' + other!.taskId)
      assert.equal(await files.read(snapshot, cleanupRecordPath(task!.taskId)), undefined)
      const outputs = [{ path: archive, content: fact }, { path: attachment, bytes: binary }]
      await files.commit(snapshot, [...outputs, { path: manifestPath, content: JSON.stringify({ outputs: [archive], retainedPaths: [attachment],
        recorderCommand: 'reevaluated-' + fault, inputs: await captureCleanupInputs(files, snapshot, task!),
        verifiedReferences: await captureCleanupReferences(files, snapshot, [archive, attachment], outputs) }) }], 'Recorder rereads and saves evaluated references')
    })
    // Unrelated Host activity is not a reason to repeat business archival.
    await withSnapshot(files, snapshot => files.commit(snapshot, [{ path: 'instances/other-heartbeat.json', content: '{"sequence":2}' }], 'unrelated heartbeat'))
    assert.equal((await withSnapshot(files, snapshot => cleaner.clean(task!, snapshot))).status, 'released')
    assert.deepEqual(released, [task!.taskId])
    await withSnapshot(files, async snapshot => {
      assert.equal(await files.read(snapshot, archive), fact)
      assert.deepEqual(await files.readBytes(snapshot, attachment), binary)
      assert.equal(await files.read(snapshot, paths.member(other!.taskId, 'B') + '/Reply.md'), 'Original verified evidence for ' + other!.taskId)
    })
  })
}

test('old manifest with no verified reference map preserves original evidence', async t => {
  const { files, tasks: [task], cleaner, released } = await fixture(t)
  await withSnapshot(files, async snapshot => {
    const path = paths.archive(task!.taskId) + '/retention.json', manifest = JSON.parse((await files.read(snapshot, path))!)
    delete manifest.verifiedReferences
    await files.commit(snapshot, [{ path, content: JSON.stringify(manifest) }], 'old manifest without exact reference verification')
  })
  await assert.rejects(withSnapshot(files, snapshot => cleaner.clean(task!, snapshot)), CleanupMaterialsChangedError)
  assert.deepEqual(released, [])
  await withSnapshot(files, async snapshot => assert.equal(await files.read(snapshot, paths.member(task!.taskId, 'B') + '/Reply.md'), 'Original verified evidence for ' + task!.taskId))
})


test('reference polling caches only authoritative content versions and releases Task-scoped digests', async t => {
  const { files, tasks: [task, other] } = await fixture(t)
  const archive = paths.archive(task!.taskId) + '/records.md', binary = paths.archive(task!.taskId) + '/proof.bin'
  await withSnapshot(files, snapshot => files.commit(snapshot, [{ path: binary, bytes: Uint8Array.from([255, 0, 128]) }], 'binary evidence'))
  const manifest = await withSnapshot(files, async snapshot => ({ outputs: [archive], retainedPaths: [binary],
    inputs: await captureCleanupInputs(files, snapshot, task!), verifiedReferences: await captureCleanupReferences(files, snapshot, [archive, binary]) }))
  const readBytes = files.readBytes.bind(files), counts = new Map<string, number>()
  files.readBytes = async (snapshot, path) => { counts.set(path, (counts.get(path) ?? 0) + 1); return readBytes(snapshot, path) }
  const poll = () => withSnapshot(files, snapshot => changedCleanupMaterials(files, snapshot, task!, manifest, JSON.stringify(manifest)))
  assert.equal(await poll(), undefined)
  assert.equal(await poll(), undefined)
  assert.equal(counts.get(archive), 1); assert.equal(counts.get(binary), 1)
  await withSnapshot(files, snapshot => files.commit(snapshot, [{ path: 'technical/heartbeat/A.json', content: 'next heartbeat' }], 'unrelated metadata'))
  assert.equal(await poll(), undefined)
  assert.equal(counts.get(binary), 1)
  // Recorder's explicit save/readback helper must never use the polling cache.
  await withSnapshot(files, snapshot => captureCleanupReferences(files, snapshot, [binary]))
  assert.equal(counts.get(binary), 2)
  clearCleanupReferenceCache(files, other!.taskId)
  assert.equal(await poll(), undefined); assert.equal(counts.get(binary), 2)
  clearCleanupReferenceCache(files, task!.taskId)
  assert.equal(await poll(), undefined); assert.equal(counts.get(binary), 3)
  await withSnapshot(files, snapshot => files.commit(snapshot, [{ path: binary, bytes: Uint8Array.from([255, 0, 129]) }], 'new content version'))
  assert.deepEqual((await poll())?.paths, [binary]); assert.equal(counts.get(binary), 4)
  assert.deepEqual((await poll())?.paths, [binary]); assert.equal(counts.get(binary), 4)
  // Incomplete metadata cannot hit the previously cached version, even if bytes exist.
  const listDirectory = files.listDirectory.bind(files)
  files.listDirectory = async (snapshot, prefix) => (await listDirectory(snapshot, prefix)).map(entry => entry.path === binary ? { ...entry, version: '' } : entry)
  assert.deepEqual((await poll())?.paths, [binary]); assert.equal(counts.get(binary), 4)
  files.listDirectory = listDirectory
  assert.deepEqual((await poll())?.paths, [binary]); assert.equal(counts.get(binary), 5)
})
