import test from 'node:test'
import assert from 'node:assert/strict'
import { RuntimeSettingsService } from '../src/application/runtime-settings.js'
import { Scheduler } from '../src/runtime/scheduler.js'
import { MemoryStorage } from './support.js'
import { fixture, childSpec } from './task-fixture.js'

test('T38/T43/T44: persisted global seats migrate Host configuration and apply live after successful writes', async () => {
  const store = new MemoryStorage(), scheduler = new Scheduler(7)
  const settings = await RuntimeSettingsService.open(store, 7, value => scheduler.setWorkerSeats(value.workerSeats))
  assert.equal(settings.get().workerSeats, 7)
  for (const seats of [1, 4, 32, 65]) {
    await settings.configure(settings.get().revision, seats)
    assert.equal(scheduler.workerSeats, seats)
    assert.equal((await RuntimeSettingsService.open(store, 2)).get().workerSeats, seats)
  }
  for (const invalid of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(settings.configure(settings.get().revision, invalid))
  await assert.rejects(settings.configure(1, 4), /changed/)
  store.fail = key => key === 'settings/runtime'
  await assert.rejects(settings.configure(settings.get().revision, 4))
  assert.equal(scheduler.workerSeats, 65)
})

test('T39/T40/T42: global capacity includes saved claims, preserves running owners when lowered, ignores idle jobs as inference', async () => {
  const f = await fixture(), planner = await f.bind('plan')
  await f.execute({ type: 'planning.commit', expectedGoalRevision: 1, expectedPlanRevision: 0, strategy: 'Parallel bounded work',
    children: [childSpec('a'), childSpec('b'), childSpec('c'), childSpec('d')] }, planner.source)
  const worker = await f.bind('dispatch', 'a')
  let task = await f.get()
  const reserved = Object.values(task.pendingActions).find(action => action.kind === 'dispatch' && action.payload.childId === 'b')!
  await f.execute({ type: 'action.claim', actionId: reserved.id, ownerId: 'runtime' })
  task = await f.get()
  const scheduler = new Scheduler(4)
  const live = new Map([[worker.execution.executionId, { state: 'running' as const, ownedJobIds: [] }]])
  assert.deepEqual(scheduler.capacity([task], live), { maxWorkerSeats: 4, occupiedWorkerSeats: 2, availableWorkerSeats: 2 })
  const candidate = Object.values(task.pendingActions).find(action => action.kind === 'dispatch' && action.payload.childId === 'c')!
  assert.equal(scheduler.canRun(task, candidate, [task], live).allowed, true)
  scheduler.setWorkerSeats(1)
  assert.deepEqual(scheduler.capacity([task], live), { maxWorkerSeats: 1, occupiedWorkerSeats: 2, availableWorkerSeats: 0 })
  assert.equal(scheduler.canRun(task, candidate, [task], live).code, 'WORKER_CAPACITY')
  assert.equal((await f.get()).executions[worker.execution.executionId].state, 'active')
  const idleJobs = new Map([[worker.execution.executionId, { state: 'idle' as const, ownedJobIds: ['long-job'] }]])
  assert.equal(scheduler.capacity([task], idleJobs).occupiedWorkerSeats, 1)
  const other = structuredClone(task)
  other.id = 'other-task'; other.executions = {}; other.pendingActions = { reservation: { ...reserved, id: 'reservation', status: 'running' } }
  scheduler.setWorkerSeats(4)
  assert.deepEqual(scheduler.capacity([task, other], live), { maxWorkerSeats: 4, occupiedWorkerSeats: 3, availableWorkerSeats: 1 })
})
