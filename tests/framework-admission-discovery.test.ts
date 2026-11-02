import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { FrameworkRoleRuntime } from '../src/framework/role-runtime.js'
import { LocalFiles } from '../src/framework/local-files.js'
import { withSnapshot } from '../src/framework/transactions.js'
import { captureCleanupInputs, captureCleanupReferences, cleanupRecordPath, type CleanupRecord } from '../src/framework/cleaner.js'
import { paths, readJson, type TaskMetadata } from '../src/framework/task-files.js'
import type { StoragePort } from '../src/contracts/ports.js'

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'dss-admission-discovery-')), ctx = new Context(), files = await LocalFiles.open(root)
  const rows = new Map<string, unknown>(), errors: unknown[] = [], cleanup: Array<() => Promise<void> | void> = []
  const storage: StoragePort = { get: async <T>(key: string) => structuredClone(rows.get(key)) as T,
    set: async (key, value) => { rows.set(key, structuredClone(value)) },
    list: async <T>(prefix: string) => [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) as T })) }
  const runtime = new FrameworkRoleRuntime(ctx, files, storage, { scope: root, member: 'A', primary: true, workspace: root, workerSeats: 1, mode: 'local', collaborationId: 'admission' },
    { members: () => ['A'], resources: () => [], heartbeat: async () => {}, error: error => errors.push(error) })
  const internal = runtime as any
  t.after(async () => { for (const action of cleanup) await action(); await runtime.dispose(); await ctx.fiber.dispose(); await files.close(); await rm(root, { recursive: true, force: true }) })
  return { root, ctx, files, runtime, internal, rows, errors, cleanup }
}
const checkpoint = () => new Promise<void>(resolve => setImmediate(resolve))

for (const entry of ['observe', 'post-discovery'] as const) test(`held Foreground admission does not occupy ${entry} discovery or completed Task cleanup`, async t => {
  const f = await fixture(t), { runtime, internal, files } = f
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(); let released = false, sends = 0
  internal.gateway.exists = async () => false
  internal.active = (record: any) => internal.workOperations?.has(record.identity.workId) === true // Native lifecycle is the explicit held send seam in this component test.
  runtime.native.open = async () => ({ send: async () => { sends++; entered.resolve(); await gate.promise } }) as any
  f.cleanup.push(async () => { released = true; gate.resolve(); await internal.pumping; internal.roleRecords.clear() })
  if (entry === 'observe') await runtime.wake({ id: 'held-F', role: 'Foreground', reason: 'notification', sources: [] })
  else await withSnapshot(files, view => files.commit(view, [{ path: 'state/Foreground_user-GMT0-20261101-000000000', content: '' }], 'real notification'))
  let firstDone = false
  const first = runtime.loop.poll().then(() => { firstDone = true })
  await entered.promise; await checkpoint()
  assert.equal(firstDone, true, 'poll confirms admission ownership without joining unrelated native send')
  const task: TaskMetadata = { version: 1, taskId: 'complete-task', owner: 'A', route: 'O', status: 'complete', sourcePath: 'requests/original.md' }
  const archive = paths.archive(task.taskId) + '/records.md'
  await withSnapshot(files, view => files.commit(view, [
    { path: paths.task(task.taskId), content: JSON.stringify(task) }, { path: task.sourcePath, content: 'Original requirement' },
    { path: paths.run(task.taskId) + '/Memory.md', content: 'Original evaluated work' }, { path: archive, content: 'Recorder-authored saved output' },
  ], 'actual independent Recorder saved material fixture'))
  await withSnapshot(files, async view => files.commit(view, [
    { path: paths.archive(task.taskId) + '/retention.json', content: JSON.stringify({ outputs: [archive], retainedPaths: [], inputs: await captureCleanupInputs(files, view, task), verifiedReferences: await captureCleanupReferences(files, view, [archive]) }) },
    { path: paths.state('A', task.taskId) + '/Cleaner', content: '' },
  ], 'verified Recorder fixture and Cleaner notification'))
  await runtime.loop.poll()
  assert.equal(released, false, 'the unrelated Foreground barrier was never opened to allow cleanup')
  assert.equal(sends, 1, 'repeated discovery reuses the same owned admission flight')
  await withSnapshot(files, async view => {
    assert.equal((await readJson<CleanupRecord>(files, view, cleanupRecordPath(task.taskId)))?.phase, 'released')
    assert.equal(await files.read(view, archive), 'Recorder-authored saved output')
    assert.equal(await files.read(view, paths.run(task.taskId) + '/Memory.md'), undefined)
  })
  await first
})

test('closing drains its independently owned pump without admitting a callback registered after close', async t => {
  const f = await fixture(t), { runtime, internal } = f
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>(); let calls = 0, closed = false
  internal.runQueue = async () => { calls++; entered.resolve(); await gate.promise }
  internal.startOwnedPump(); await entered.promise
  const disposing = runtime.dispose().then(() => { closed = true })
  await checkpoint(); assert.equal(closed, false)
  internal.startOwnedPump(); assert.equal(calls, 1)
  gate.resolve(); await disposing
  assert.equal(calls, 1)
})

test('close before an owned pump callback starts prevents its work', async t => {
  const f = await fixture(t); let calls = 0
  f.internal.runQueue = async () => { calls++ }
  f.internal.startOwnedPump()
  await f.runtime.dispose()
  assert.equal(calls, 0)
})

test('a held failed pump reports its original error once and later admission can proceed', async t => {
  const f = await fixture(t), gate = Promise.withResolvers<void>(), failure = new Error('exact native admission failure')
  let calls = 0
  f.internal.runQueue = async () => { calls++; await gate.promise; throw failure }
  for (let i = 0; i < 50; i++) f.internal.startOwnedPump()
  await checkpoint(); assert.equal(calls, 1)
  gate.resolve(); await f.internal.pumping.catch(() => {}); await checkpoint(); await f.internal.errorTail
  assert.equal(f.errors.filter(error => error === failure).length, 1)
  f.internal.runQueue = async () => { calls++ }
  f.internal.startOwnedPump(); await f.internal.pumping
  assert.equal(calls, 2)
})
