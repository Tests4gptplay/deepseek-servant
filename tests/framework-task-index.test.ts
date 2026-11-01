import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalFiles } from '../src/framework/local-files.js'
import { FrameworkTaskIndex } from '../src/framework/task-index.js'
import { withSnapshot, type FileChange } from '../src/framework/transactions.js'
import type { TaskMetadata } from '../src/framework/task-files.js'
const one = '10000000-0000-4000-8000-000000000001', two = '10000000-0000-4000-8000-000000000002'
const path = (id: string) => 'tasks/' + id + '.json'
const task = (id: string): TaskMetadata => ({ version: 1, taskId: id, route: 'P', status: 'running', owner: 'alice', sourcePath: 'tasks/original_P.md', members: ['alice', '离线成员'] })
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'dss-task-index-')), files = await LocalFiles.open(directory)
  t.after(async () => { await files.close(); await rm(directory, { recursive: true, force: true }) })
  const errors: Error[] = [], reads: string[] = []; let changed = 0
  const read = files.readBytes.bind(files)
  files.readBytes = async (snapshot, path) => { reads.push(path); return read(snapshot, path) }
  const index = new FrameworkTaskIndex(files, error => errors.push(error), () => changed++)
  const write = (changes: FileChange[]) => withSnapshot(files, snapshot => files.commit(snapshot, changes, 'Task index fixture'))
  const list = () => withSnapshot(files, snapshot => index.list(snapshot))
  return { files, index, errors, reads, write, list, changed: () => changed }
}
test('task index: bad JSON and identity/shape records do not hide a valid offline-member Task', async t => {
  const f = await fixture(t)
  await f.write([{ path: path(one), content: '{broken' }, { path: path(two), content: JSON.stringify(task(two)) },
    { path: 'tasks/not-a-task.json', content: JSON.stringify(task(one)) }, { path: 'tasks/nested/private.json', content: 'not a task' }])
  assert.deepEqual(await f.list(), [task(two)])
  assert.equal(f.errors.length, 2)
  assert.ok(f.errors.some(error => error.message.includes(path(one))))
  assert.equal(f.reads.includes('tasks/nested/private.json'), false)
  const reads = f.reads.length
  assert.deepEqual(await f.list(), [task(two)])
  assert.equal(f.reads.length, reads, 'negative parse results and valid bodies are cached by metadata version')
  assert.equal(f.errors.length, 2)
})
test('task index: changed good to bad removes old value; repaired version and deletion update visibility', async t => {
  const f = await fixture(t)
  await f.write([{ path: path(one), content: JSON.stringify(task(one)) }])
  assert.deepEqual(await f.list(), [task(one)])
  await f.write([{ path: path(one), content: JSON.stringify({ ...task(one), owner: '../wrong' }) }])
  assert.deepEqual(await f.list(), [])
  await f.write([{ path: path(one), content: JSON.stringify({ ...task(one), status: 'complete' }) }])
  assert.equal((await f.list())[0]!.status, 'complete')
  await f.write([{ path: path(one), content: null }])
  assert.deepEqual(await f.list(), [])
  assert.equal(f.changed(), 4)
})
test('task index: same-version transient read failure is retried rather than permanently cached', async t => {
  const f = await fixture(t)
  await f.write([{ path: path(one), content: JSON.stringify(task(one)) }, { path: path(two), content: JSON.stringify(task(two)) }])
  const read = f.files.readBytes.bind(f.files); let fail = true
  f.files.readBytes = async (snapshot, key) => { if (key === path(one) && fail) { fail = false; throw new Error('Temporary IO failure') } return read(snapshot, key) }
  await withSnapshot(f.files, async snapshot => {
    const entries = await f.files.listDirectory(snapshot, 'tasks/')
    assert.deepEqual(await f.index.list(snapshot, entries), [task(two)])
    assert.deepEqual(await f.index.list(snapshot, entries), [task(one), task(two)])
  })
  assert.equal(f.errors.length, 1)
  assert.equal((f.errors[0]!.cause as Error).message, 'Temporary IO failure')
})
test('task index: unchanged metadata reads no body and caller mutation cannot corrupt cache', async t => {
  const f = await fixture(t)
  await f.write([{ path: path(one), content: JSON.stringify(task(one)) }])
  const first = await f.list(); first[0]!.owner = 'mutated'; first[0]!.members!.push('invented')
  await f.write([{ path: 'state/alice/heartbeat', content: 'unrelated metadata change' }])
  assert.deepEqual(await f.list(), [task(one)])
  assert.deepEqual(f.reads, [path(one)])
  assert.equal(f.changed(), 1)
})
test('task index: directory IO failure does not evict a valid cache or claim all Tasks deleted', async t => {
  const f = await fixture(t)
  await f.write([{ path: path(one), content: JSON.stringify(task(one)) }]); await f.list()
  const list = f.files.listDirectory.bind(f.files); let fail = true
  f.files.listDirectory = async (snapshot, prefix) => { if (fail) { fail = false; throw new Error('Directory unavailable') } return list(snapshot, prefix) }
  await assert.rejects(f.list(), /Directory unavailable/)
  assert.deepEqual(await f.list(), [task(one)]); assert.equal(f.changed(), 1); assert.equal(f.reads.length, 1)
})

test('task index: existing safe segment identities remain readable without adding UUID admission', async t => {
  const f = await fixture(t), id = '已保存-task'
  await f.write([{ path: path(id), content: JSON.stringify(task(id)) }])
  assert.deepEqual(await f.list(), [task(id)])
  assert.deepEqual(f.errors, [])
})

test('task index: malformed UTF-8 is deterministic corruption, not a permanently retried network failure', async t => {
  const f = await fixture(t)
  await f.write([{ path: path(one), bytes: Uint8Array.from([0xff, 0xfe, 0x7b]) }, { path: path(two), content: JSON.stringify(task(two)) }])
  assert.deepEqual(await f.list(), [task(two)])
  const reads = f.reads.length
  assert.deepEqual(await f.list(), [task(two)])
  assert.equal(f.reads.length, reads)
  assert.equal(f.errors.length, 1)
  assert.ok(f.errors[0]!.message.includes(path(one)))
})
