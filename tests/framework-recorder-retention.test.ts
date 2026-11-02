import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalFiles } from '../src/framework/local-files.js'
import { withSnapshot } from '../src/framework/transactions.js'
import { prepareRecorderRetention, archivedReference, readArchivedReference } from '../src/framework/recorder-retention.js'
import { paths, type TaskMetadata } from '../src/framework/task-files.js'

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'dss-retention-')), files = await LocalFiles.open(root)
  t.after(async () => { await files.close(); await rm(root, { recursive: true, force: true }) })
  const task: TaskMetadata = { version: 1, taskId: 'task', owner: 'A', members: ['A','B'], route: 'O', status: 'complete', sourcePath: 'tasks/source_O.md', resultPaths: ['task-runs/task/result.bin'] }
  const binary = Uint8Array.from([0,255,128,1])
  await withSnapshot(files, snapshot => files.commit(snapshot, [
    { path: paths.task(task.taskId), content: JSON.stringify(task) }, { path: 'archives/task/records.md', content: 'AI-authored original task-runs/task/result.bin' },
    { path: 'task-runs/task/result.bin', bytes: binary }, { path: 'task-runs/task/dir/a.txt', content: 'A' }, { path: 'task-runs/task/dir/b.txt', content: 'B' },
    { path: 'state/A/task/recovery', content: '' }, { path: 'state/A/task/Cleaner', content: '' }, { path: 'state/A/other/recovery', content: '' },
  ], 'actual synthetic source'))
  return { files, task, binary }
}
test('archive plan enumerates exact retained directory bytes and removes state signals without copying them', async t => {
  const { files, task, binary } = await fixture(t)
  await withSnapshot(files, async snapshot => {
    const plan = await prepareRecorderRetention(files, snapshot, task, { outputs: ['archives/task/records.md'], retainedPaths: ['task-runs/task/dir', 'state/A/task'] })
    assert.equal(archivedReference(plan.retention, 'task-runs/task/dir').length, 2)
    assert.equal(Object.keys(plan.retention.relocatedReferences!).some(path => path.startsWith('state/')), false)
    assert.equal(plan.retention.retainedPaths.some(path => path.startsWith('state/')), false)
    assert.ok(plan.task.resultPaths![0].startsWith('archives/task/retained/'))
    await files.commit(snapshot, plan.changes, 'archive copies before cleanup')
    await withSnapshot(files, async checked => {
      assert.deepEqual(await files.readBytes(checked, plan.task.resultPaths![0]), binary)
      assert.equal(await files.read(checked, 'archives/task/records.md'), 'AI-authored original task-runs/task/result.bin')
      assert.equal(await files.read(checked, 'state/A/other/recovery'), '')
      assert.deepEqual(await files.readBytes(checked, 'task-runs/task/result.bin'), binary, 'planning never deletes original bytes')
    })
  })
})
test('changed source gets a content-addressed archive version while old referenced bytes remain readable', async t => {
  const { files, task, binary } = await fixture(t)
  const first = await withSnapshot(files, async snapshot => {
    const plan = await prepareRecorderRetention(files, snapshot, task, { outputs: ['archives/task/records.md'], retainedPaths: [] })
    await files.commit(snapshot, plan.changes, 'first archive version'); return plan
  })
  await withSnapshot(files, snapshot => files.commit(snapshot, [{ path: task.resultPaths![0], content: 'new result bytes' }], 'later material version'))
  const second = await withSnapshot(files, async snapshot => {
    const plan = await prepareRecorderRetention(files, snapshot, task, { ...first.retention, retainedPaths: [] })
    await files.commit(snapshot, plan.changes, 'new archive version'); return plan
  })
  assert.notEqual(first.task.resultPaths![0], second.task.resultPaths![0])
  await withSnapshot(files, async snapshot => {
    assert.deepEqual(await files.readBytes(snapshot, first.task.resultPaths![0]), binary)
    assert.equal(await files.read(snapshot, second.task.resultPaths![0]), 'new result bytes')
    assert.equal(Object.keys(second.retention.relocatedSources!).length, 2)
  })
})

test('exact archived legacy links verify target scope and bytes instead of following a damaged mapping', async t => {
  const { files, task, binary } = await fixture(t)
  const original = task.resultPaths![0]
  const plan = await withSnapshot(files, async snapshot => {
    const plan = await prepareRecorderRetention(files, snapshot, task, { outputs: ['archives/task/records.md'], retainedPaths: [] })
    await files.commit(snapshot, [...plan.changes, { path: 'archives/task/retention.json', content: JSON.stringify(plan.retention) }], 'save source map')
    return plan
  })
  await withSnapshot(files, async snapshot => assert.deepEqual(await readArchivedReference(files, snapshot, task.taskId, original), binary))
  await withSnapshot(files, snapshot => files.commit(snapshot, [{ path: plan.task.resultPaths![0], content: 'tampered' }], 'damaged archive bytes'))
  await withSnapshot(files, snapshot => assert.rejects(readArchivedReference(files, snapshot, task.taskId, original), /integrity/))
  await withSnapshot(files, snapshot => files.commit(snapshot, [{ path: 'archives/task/retention.json', content: JSON.stringify({ ...plan.retention, relocatedReferences: { [original]: 'archives/other/result' } }) }], 'damaged cross Task mapping'))
  await withSnapshot(files, snapshot => assert.rejects(readArchivedReference(files, snapshot, task.taskId, original), /escapes/))
})

test('one preparation reads each immutable exact reference once and never lists a file as a directory', async t => {
  const { files, task } = await fixture(t), lists: string[] = [], reads = new Map<string, number>()
  const list = files.list.bind(files), read = files.readBytes.bind(files)
  files.list = async (snapshot, prefix) => { lists.push(prefix); return list(snapshot, prefix) }
  files.readBytes = async (snapshot, path) => { reads.set(path, (reads.get(path) ?? 0) + 1); return read(snapshot, path) }
  const source = task.resultPaths![0]
  await withSnapshot(files, snapshot => prepareRecorderRetention(files, snapshot, task, {
    outputs: ['archives/task/records.md'], retainedPaths: [source, source, 'archives/task/records.md'],
  }))
  t.diagnostic(JSON.stringify({ subtreeProbes: lists.length, sourceReads: reads.get(source), archiveReads: reads.get('archives/task/records.md') }))
  assert.deepEqual(lists, [], 'known exact files do not require subtree probes')
  assert.equal(reads.get(source), 1, 'retained/result duplicate resolves once in this call')
  assert.equal(reads.get('archives/task/records.md'), 1, 'output/retained/hash share the same immutable source read')
  reads.clear()
  await withSnapshot(files, snapshot => files.commit(snapshot, [{ path: source, content: 'changed at new H' }], 'next snapshot'))
  await withSnapshot(files, async snapshot => {
    const next = await prepareRecorderRetention(files, snapshot, task, { outputs: ['archives/task/records.md'], retainedPaths: [source] })
    const copy = next.changes.find(change => change.path === next.task.resultPaths![0])!
    assert.equal(Buffer.from(copy.bytes!).toString(), 'changed at new H')
  })
  assert.equal(reads.get(source), 1, 'new preparation must really read its own snapshot')
})

test('new relocation map missing its source metadata is damaged rather than legacy provenance', async t => {
  const { files, task } = await fixture(t), original = task.resultPaths![0]
  await withSnapshot(files, async snapshot => {
    const plan = await prepareRecorderRetention(files, snapshot, task, { outputs: ['archives/task/records.md'], retainedPaths: [] })
    const { relocatedSources: _sources, ...damaged } = plan.retention
    await files.commit(snapshot, [...plan.changes, { path: 'archives/task/retention.json', content: JSON.stringify(damaged) }], 'missing provenance metadata')
  })
  await withSnapshot(files, snapshot => assert.rejects(readArchivedReference(files, snapshot, task.taskId, original), /source identity/))
})
