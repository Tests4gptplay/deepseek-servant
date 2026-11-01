import test from 'node:test'
import assert from 'node:assert/strict'
import type { StoragePort } from '../src/contracts/ports.js'
import { ExecutionControls } from '../src/framework/execution-control.js'
function fixture() {
  const rows = new Map<string, unknown>(); let fail = false
  const storage: StoragePort = { get: async key => structuredClone(rows.get(key)) as never,
    set: async (key, value) => { if (fail) throw Error('durability failed'); rows.set(key, structuredClone(value)) },
    list: async () => [] }
  return { storage, fail: (value: boolean) => { fail = value } }
}
test('task pause/cancel/resume persist explicit intent without inventing business state or remote signals', async () => {
  const { storage } = fixture(), c = new ExecutionControls(storage, 'A', () => '2026-10-31T00:00:00Z')
  assert.equal(await c.taskHeld('T'), false)
  await c.setTask('pause', 'T', 'paused'); assert.equal(await c.taskHeld('T'), true)
  await c.setTask('cancel', 'T', 'cancelled'); assert.equal(await c.taskHeld('T'), true)
  const reload = new ExecutionControls(storage, 'A')
  assert.equal((await reload.task('T'))!.intent, 'cancelled')
  await reload.setTask('resume', 'T', 'running'); assert.equal(await reload.taskHeld('T'), false)
})
test('single execution stop does not freeze its task or replacement execution', async () => {
  const { storage } = fixture(), c = new ExecutionControls(storage, 'A')
  const request = await c.requestExecutionStop('stop', { workId: 'W', executionId: 'E1', taskId: 'T' })
  assert.equal(request.result, undefined)
  assert.equal(await c.taskHeld('T'), false)
  assert.equal(await c.execution('E2'), undefined)
  assert.equal((await c.pendingStops()).length, 1)
  await c.settleExecution('stop', 'E1', { state: 'unconfirmed', jobs: ['job'] })
  assert.equal((await c.execution('E1'))!.result!.state, 'unconfirmed')
  assert.equal((await c.pendingStops()).length, 0)
})
test('stable replay cannot reapply an old pause after explicit resume or change command arguments', async () => {
  const { storage } = fixture(), c = new ExecutionControls(storage, 'A')
  const original = await c.setTask('one', 'T', 'paused')
  await c.setTask('two', 'T', 'running')
  assert.deepEqual(await c.setTask('one', 'T', 'paused'), original)
  assert.equal(await c.taskHeld('T'), false)
  await assert.rejects(c.setTask('one', 'T', 'cancelled'), /different arguments/)
})
test('late stop result cannot overwrite a newer explicit request and exact replay returns real outcome', async () => {
  const { storage } = fixture(), c = new ExecutionControls(storage, 'A'), target = { workId: 'W', executionId: 'E1' }
  await c.requestExecutionStop('first', target)
  await c.requestExecutionStop('second', target)
  await c.settleExecution('first', 'E1', { state: 'stopped' })
  assert.equal((await c.execution('E1'))!.result, undefined)
  await c.settleExecution('second', 'E1', { state: 'stopped' })
  assert.equal((await c.requestExecutionStop('second', target)).result!.state, 'stopped')
})
test('separate local/remote scopes and Tasks never share control or release associations', async () => {
  const { storage } = fixture(), a = new ExecutionControls(storage, 'A'), b = new ExecutionControls(storage, 'B')
  await a.setTask('pause', 'T', 'paused'); assert.equal(await b.taskHeld('T'), false)
  await a.requestExecutionStop('stop', { workId: 'W', executionId: 'E', taskId: 'T' })
  await a.setTask('other', 'U', 'paused')
  await a.releaseTask('T')
  assert.equal(await a.task('T'), undefined); assert.equal(await a.execution('E'), undefined)
  await a.setTask('pause', 'T', 'paused'); assert.equal(await a.task('T'), undefined)
  assert.equal(await a.taskHeld('U'), true)
})
test('failed durability does not acknowledge a control request and later retry is possible', async () => {
  const f = fixture(), c = new ExecutionControls(f.storage, 'A')
  f.fail(true); await assert.rejects(c.setTask('pause', 'T', 'paused'), /durability failed/)
  f.fail(false); assert.equal(await c.task('T'), undefined)
  await c.setTask('pause', 'T', 'paused'); assert.equal(await c.taskHeld('T'), true)
})
test('cached StoragePort objects cannot be mutated before a failed durable write', async () => {
  let saved: unknown, fail = false
  const storage: StoragePort = { get: async () => saved as never, set: async (_key, value) => { if (fail) throw Error('write failed'); saved = value }, list: async () => [] }
  const c = new ExecutionControls(storage, 'A')
  await c.setTask('pause', 'T', 'paused')
  fail = true
  await assert.rejects(c.setTask('resume', 'T', 'running'), /write failed/)
  assert.equal(await c.taskHeld('T'), true)
})
