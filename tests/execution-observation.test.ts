import test from 'node:test'
import assert from 'node:assert/strict'
import { ExecutionObservations, type StoredExecutionObservation, type ScheduledObservation } from '../src/framework/execution-observation.js'
import type { OwnedDshAgent } from '../src/adapters/dsh/host-types.js'
import type { DshProgress } from '../src/adapters/dsh/progress.js'
import { type WorkIdentity } from '../src/framework/recovery.js'

// Coordinator/store contract tests only; real native Host persistence is a separate integration layer.
const minute = 60_000
function fixture() {
  let now = 0
  const rows = new Map<string, StoredExecutionObservation>()
  const arranged: string[] = [], actions: ScheduledObservation[] = []
  const errors: unknown[] = []
  let fail = false
  const observer = new ExecutionObservations({
    get: async key => structuredClone(rows.get(key)),
    set: async (key, value) => { rows.set(key, structuredClone(value)) },
    list: async () => structuredClone([...rows.values()]),
  }, { arrange: async pending => { if (fail) throw new Error('arrangement unavailable'); arranged.push(pending.id); actions.push(pending) } }, error => errors.push(error), () => now)
  return { observer, rows, arranged, actions, errors, time: (value: number) => { now = value }, fail: (value: boolean) => { fail = value } }
}
function handle() {
  let state: 'running' | 'idle' | 'waiting' | 'stopped' = 'running'
  const progress = new Set<(event: DshProgress) => void>(), statuses = new Set<() => void>()
  const captured: Array<(event: DshProgress) => void> = []
  const native = { observe: () => ({ state, jobs: [] }),
    subscribeProgress: (listener: (event: DshProgress) => void) => { progress.add(listener); captured.push(listener); return () => { progress.delete(listener) } },
    subscribe: (listener: () => void) => { statuses.add(listener); return () => { statuses.delete(listener) } },
  } as unknown as OwnedDshAgent
  const event = (observedAt: number): DshProgress => ({ kind: 'model-text', source: 'assistant-stream', observedAt })
  return { native, state: (value: typeof state) => { state = value; for (const listener of statuses) listener() },
    emit: (time: number) => { for (const listener of progress) listener(event(time)) },
    late: (time: number) => { for (const listener of captured) listener(event(time)) },
    subscribed: () => progress.size + statuses.size }
}
const identity = (workId = 'w1', executionId = 'e1', member = 'A'): WorkIdentity => ({ workId, executionId, taskId: 't1', member, role: 'Worker' })

test('idle time does not produce recovery stages, resumed work starts its silence interval', async () => {
  const f = fixture(), a = handle(); a.state('idle')
  await f.observer.bind(identity(), a.native)
  f.time(100 * minute); await f.observer.tick()
  assert.deepEqual(f.arranged, [])
  a.state('running'); await f.observer.flush()
  f.time(104 * minute); await f.observer.tick(); assert.equal(f.arranged.length, 0)
  f.time(105 * minute); await f.observer.tick(); assert.equal(f.arranged.length, 1)
})
test('progress postpones silence without clearing stage and exact execution replacement ignores stale callbacks', async () => {
  const f = fixture(), a = handle(), b = handle()
  await f.observer.bind(identity(), a.native)
  f.time(5 * minute); await f.observer.tick()
  assert.equal(f.rows.get('w1')!.observation.stage, 1)
  f.time(6 * minute); a.emit(6 * minute); await f.observer.flush()
  assert.equal(f.rows.get('w1')!.observation.stage, 1)
  await f.observer.bind(identity('w1', 'e2'), b.native)
  assert.equal(a.subscribed(), 0)
  a.late(99 * minute); await f.observer.flush()
  assert.equal(f.rows.get('w1')!.observation.lastProgressAt, 6 * minute)
  assert.equal(f.rows.get('w1')!.observation.identity.executionId, 'e2')
  b.emit(7 * minute); await f.observer.flush()
  assert.equal(f.rows.get('w1')!.observation.lastProgressAt, 7 * minute)
})
test('unbinding invalidates callbacks before await and stops due scheduling', async () => {
  const f = fixture(), a = handle(); await f.observer.bind(identity(), a.native)
  const stopped = f.observer.unbind('w1', 'e1')
  a.late(30 * minute)
  await stopped; await f.observer.flush()
  f.time(40 * minute); await f.observer.tick()
  assert.equal(f.rows.get('w1')!.executing, false)
  assert.equal(f.rows.get('w1')!.observation.lastProgressAt, 0)
  assert.deepEqual(f.arranged, [])
})
test('failed arrangement retains the same durable pending action rather than advancing twice', async () => {
  const f = fixture(), a = handle(); await f.observer.bind(identity(), a.native)
  f.time(5 * minute); f.fail(true)
  await assert.rejects(f.observer.tick(), error => error instanceof AggregateError && error.errors[0].message === 'arrangement unavailable')
  const pending = f.rows.get('w1')!.pending!
  assert.equal(pending.action.stage, 1)
  f.fail(false); await f.observer.tick()
  assert.deepEqual(f.arranged, [pending.id])
  assert.equal(f.rows.get('w1')!.pending, undefined)
  assert.equal(f.rows.get('w1')!.observation.stage, 1)
})
test('Planner recovery consumption resets only its exact member/task domain', async () => {
  const f = fixture()
  await f.observer.bind(identity('a'), handle().native)
  await f.observer.bind(identity('b', 'e2', 'B'), handle().native)
  f.time(5 * minute); await f.observer.tick()
  assert.equal(f.rows.get('a')!.observation.stage, 1)
  assert.equal(f.rows.get('b')!.observation.stage, 1)
  await assert.rejects(f.observer.recoveryConsumed(identity(), { taskId: 't1', member: 'A' }), /Planner/)
  await f.observer.recoveryConsumed({ ...identity('p'), role: 'Planner' }, { taskId: 't1', member: 'A' })
  assert.equal(f.rows.get('a')!.observation.stage, 0)
  assert.equal(f.rows.get('b')!.observation.stage, 1)
})

test('same-execution rebinding retains pending responsibility and stage across restart', async () => {
  const f = fixture(), a = handle(); await f.observer.bind(identity(), a.native)
  f.time(5 * minute); f.fail(true); await assert.rejects(f.observer.tick())
  const pending = f.rows.get('w1')!.pending!
  await f.observer.unbind('w1', 'e1')
  f.time(20 * minute); await f.observer.bind(identity(), handle().native)
  assert.equal(f.rows.get('w1')!.observation.stage, 1)
  assert.equal(f.rows.get('w1')!.pending!.id, pending.id)
  f.fail(false); await f.observer.tick()
  assert.deepEqual(f.arranged, [pending.id])
})

test('repeat binding of the same active execution cannot postpone its observation deadline', async () => {
  const f = fixture(), a = handle(); await f.observer.bind(identity(), a.native)
  f.time(4 * minute); await f.observer.bind(identity(), a.native)
  assert.equal(f.rows.get('w1')!.observation.stageStartedAt, 0)
  f.time(5 * minute); await f.observer.tick()
  assert.equal(f.rows.get('w1')!.observation.stage, 1)
})
test('member recovery reset cannot reset non-member roles even with matching task/member metadata', async () => {
  const f = fixture()
  for (const role of ['Planner', 'Worker', 'Foreground', 'Organizer', 'Recorder', 'Helper'] as const) {
    await f.observer.bind({ ...identity(role), role }, handle().native)
  }
  f.time(5 * minute); await f.observer.tick()
  await f.observer.recoveryConsumed({ ...identity('p'), role: 'Planner' }, { taskId: 't1', member: 'A' })
  for (const role of ['Planner', 'Worker'] as const) assert.equal(f.rows.get(role)!.observation.stage, 0)
  for (const role of ['Foreground', 'Organizer', 'Recorder', 'Helper'] as const) assert.equal(f.rows.get(role)!.observation.stage, 1)
})

test('queued recovery becomes obsolete after real progress or member-cycle reset', async () => {
  const f = fixture(), a = handle(); await f.observer.bind(identity(), a.native)
  f.time(5 * minute); await f.observer.tick()
  const action = f.actions[0]!
  assert.equal(await f.observer.mayApply(action), true)
  a.emit(5 * minute + 1)
  assert.equal(await f.observer.mayApply(action), false, 'pending coalesced progress is already authoritative')
  await f.observer.flush()
  assert.equal(await f.observer.mayApply(action), false)
  await f.observer.recoveryConsumed({ ...identity('p'), role: 'Planner' }, { taskId: 't1', member: 'A' })
  f.time(10 * minute); await f.observer.tick()
  assert.equal(f.rows.get('w1')!.observation.stage, 1)
  assert.equal(await f.observer.mayApply(action), false, 'old cycle cannot address a new occurrence of stage one')
})

test('replayed Planner consumption receipt cannot reset a later observation stage', async () => {
  const f = fixture(), a = handle()
  await f.observer.bind(identity(), a.native)
  const planner: WorkIdentity = { ...identity('planner'), role: 'Planner' }
  f.time(5 * minute); await f.observer.tick()
  await f.observer.recoveryConsumed(planner, { taskId: 't1', member: 'A' }, 'receipt-1')
  f.time(10 * minute); await f.observer.tick()
  assert.equal(f.rows.get('w1')!.observation.stage, 1)
  const before = structuredClone(f.rows.get('w1'))
  f.time(11 * minute)
  await f.observer.recoveryConsumed(planner, { taskId: 't1', member: 'A' }, 'receipt-1')
  assert.deepEqual(f.rows.get('w1'), before)
  await f.observer.recoveryConsumed(planner, { taskId: 't1', member: 'A' }, 'receipt-2')
  assert.equal(f.rows.get('w1')!.observation.stage, 0)
})

test('healthy cycle reset preserves buffered progress and records its receipt with the reset', async () => {
  const f = fixture(), a = handle(); await f.observer.bind(identity(), a.native)
  for (const at of [5, 10, 40]) { f.time(at * minute); await f.observer.tick() }
  f.time(41 * minute); a.emit(41 * minute)
  await f.observer.healthyCycle('w1', { continuouslyNormal: true, noNewRecoveryAnomaly: true }, 'health-1')
  const saved = f.rows.get('w1')!
  assert.equal(saved.observation.stage, 0)
  assert.equal(saved.observation.lastProgressAt, 41 * minute)
  assert.equal(saved.observation.cycleStartedAt, 41 * minute)
  assert.deepEqual(saved.completedHealthyCycles, ['health-1'])
  assert.equal(saved.pending, undefined)
  for (const at of [46, 51, 81]) { f.time(at * minute); await f.observer.tick() }
  await f.observer.healthyCycle('w1', { continuouslyNormal: true, noNewRecoveryAnomaly: true }, 'health-1')
  assert.equal(f.rows.get('w1')!.observation.stage, 3, 'old assessment retry cannot reset a later full cycle')
})

test('healthy assessment is serialized after an in-flight observation write', async () => {
  let now = 0, release: (() => void) | undefined, entered: (() => void) | undefined
  const reached = new Promise<void>(resolve => { entered = resolve })
  let saved: StoredExecutionObservation | undefined, delay = false
  const observer = new ExecutionObservations({
    get: async () => structuredClone(saved),
    set: async (_key, value) => {
      if (delay) { delay = false; entered!(); await new Promise<void>(resolve => { release = resolve }) }
      saved = structuredClone(value)
    }, list: async () => saved ? [structuredClone(saved)] : [],
  }, { arrange: async () => {} }, error => { throw error }, () => now)
  const a = handle(); await observer.bind(identity(), a.native)
  for (const at of [5, 10, 40]) { now = at * minute; await observer.tick() }
  now = 41 * minute; a.emit(now); delay = true
  const tick = observer.tick(); await reached
  const reset = observer.healthyCycle('w1', { continuouslyNormal: true, noNewRecoveryAnomaly: true }, 'serial-health')
  release!(); await Promise.all([tick, reset])
  assert.equal(saved!.observation.stage, 0, 'late tick write must not undo the health reset')
  assert.equal(saved!.observation.lastProgressAt, now)
  assert.deepEqual(saved!.completedHealthyCycles, ['serial-health'])
})

test('an early or unhealthy assessment cannot clear pending responsibility or reset stages', async () => {
  const f = fixture(), a = handle(); await f.observer.bind(identity(), a.native)
  f.time(5 * minute); f.fail(true); await assert.rejects(f.observer.tick())
  const pending = structuredClone(f.rows.get('w1')!.pending)
  await f.observer.healthyCycle('w1', { continuouslyNormal: true, noNewRecoveryAnomaly: true }, 'early')
  assert.equal(f.rows.get('w1')!.observation.stage, 1)
  assert.deepEqual(f.rows.get('w1')!.pending, pending)
  await f.observer.healthyCycle('w1', { continuouslyNormal: false, noNewRecoveryAnomaly: false }, 'not-healthy')
  assert.equal(f.rows.get('w1')!.observation.stage, 1)
  assert.deepEqual(f.rows.get('w1')!.pending, pending)
})

test('health assessment of an absent observation reports missing work instead of claiming a reset', async () => {
  const f = fixture()
  await assert.rejects(f.observer.healthyCycle('missing-work', { continuouslyNormal: true, noNewRecoveryAnomaly: true }, 'missing-assessment'), /does not exist/)
  assert.equal(f.rows.size, 0, 'do not invent an execution, a cycle, or a tombstone for an unknown target')
})
