import test from 'node:test'
import assert from 'node:assert/strict'
import { ExecutionObservations, type StoredExecutionObservation, type ScheduledObservation } from '../src/framework/execution-observation.js'
import type { OwnedDshAgent } from '../src/adapters/dsh/host-types.js'
import type { DshProgress } from '../src/adapters/dsh/progress.js'
import { createRecoveryWatch, dueRecoveryWatch, consumeRecoveryWatch, type WorkIdentity } from '../src/framework/recovery.js'

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
test('only the reset caller changes its AI clock; Foreground has no daily subscription or record', async () => {
  const f = fixture()
  for (const role of ['Planner', 'Worker', 'Organizer', 'Recorder', 'Helper'] as const) await f.observer.bind({ ...identity(role), role }, handle().native)
  const foreground = handle()
  await f.observer.bind({ ...identity('Foreground'), role: 'Foreground' }, foreground.native)
  assert.equal(foreground.subscribed(), 0); assert.equal(f.rows.has('Foreground'), false)
  f.time(5 * minute); await f.observer.tick()
  await f.observer.reset({ ...identity('Worker'), role: 'Worker' }, 'consumed-probe', 0)
  for (const role of ['Planner', 'Organizer', 'Recorder', 'Helper']) assert.equal(f.rows.get(role)!.observation.stage, 1)
  assert.equal(f.rows.get('Worker')!.observation.stage, 0)
  await assert.rejects(f.observer.reset({ ...identity('Foreground'), role: 'Foreground' }, 'probe', 0), /current active/)
})

test('queued recovery becomes obsolete after real progress or explicit AI reset', async () => {
  const f = fixture(), a = handle(); await f.observer.bind(identity(), a.native)
  f.time(5 * minute); await f.observer.tick()
  const action = f.actions[0]!
  assert.equal(await f.observer.mayApply(action), true)
  a.emit(5 * minute + 1)
  assert.equal(await f.observer.mayApply(action), false, 'pending coalesced progress is already authoritative')
  await f.observer.flush()
  assert.equal(await f.observer.mayApply(action), false)
  await f.observer.reset(identity(), 'consumed-probe', 0)
  f.time(10 * minute); await f.observer.tick()
  assert.equal(f.rows.get('w1')!.observation.stage, 1)
  assert.equal(await f.observer.mayApply(action), false, 'old cycle cannot address a new occurrence of stage one')
})

test('replayed consumed-probe receipt cannot reset a later observation stage', async () => {
  const f = fixture(), a = handle()
  await f.observer.bind(identity(), a.native)
  f.time(5 * minute); await f.observer.tick()
  await f.observer.reset(identity(), 'receipt-1', 0)
  f.time(10 * minute); await f.observer.tick()
  assert.equal(f.rows.get('w1')!.observation.stage, 1)
  const before = structuredClone(f.rows.get('w1'))
  f.time(11 * minute)
  await f.observer.reset(identity(), 'receipt-1', 0)
  assert.deepEqual(f.rows.get('w1'), before)
  await f.observer.reset(identity(), 'receipt-2', 5 * minute)
  assert.equal(f.rows.get('w1')!.observation.stage, 0)
})

test('explicit reset preserves buffered progress and records its receipt with the reset', async () => {
  const f = fixture(), a = handle(); await f.observer.bind(identity(), a.native)
  for (const at of [5, 10, 40]) { f.time(at * minute); await f.observer.tick() }
  f.time(41 * minute); a.emit(41 * minute)
  await f.observer.reset(identity(), 'health-1', 0)
  const saved = f.rows.get('w1')!
  assert.equal(saved.observation.stage, 0)
  assert.equal(saved.observation.lastProgressAt, 41 * minute)
  assert.equal(saved.observation.cycleStartedAt, 41 * minute)
  assert.deepEqual(saved.resetInputs, ['health-1'])
  assert.equal(saved.pending, undefined)
  for (const at of [46, 51, 81]) { f.time(at * minute); await f.observer.tick() }
  await f.observer.reset(identity(), 'health-1', 0)
  assert.equal(f.rows.get('w1')!.observation.stage, 3, 'old assessment retry cannot reset a later full cycle')
})

test('explicit reset is serialized after an in-flight observation write', async () => {
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
  const reset = observer.reset(identity(), 'serial-health', 0)
  release!(); await Promise.all([tick, reset])
  assert.equal(saved!.observation.stage, 0, 'late tick write must not undo the health reset')
  assert.equal(saved!.observation.lastProgressAt, now)
  assert.deepEqual(saved!.resetInputs, ['serial-health'])
})

test('wrong execution, role, stopped or absent target cannot clear pending responsibility', async () => {
  const f = fixture(), a = handle(); await f.observer.bind(identity(), a.native)
  f.time(5 * minute); f.fail(true); await assert.rejects(f.observer.tick())
  const pending = structuredClone(f.rows.get('w1')!.pending)
  for (const bad of [identity('w1', 'old'), { ...identity(), role: 'Helper' as const }, identity('missing')]) {
    await assert.rejects(f.observer.reset(bad, 'probe', 0), /current active/)
    assert.deepEqual(f.rows.get('w1')!.pending, pending)
  }
  a.state('stopped'); await f.observer.flush()
  await assert.rejects(f.observer.reset(identity(), 'probe', 0), /current active/)
  assert.deepEqual(f.rows.get('w1')!.pending, pending)
})

test('new execution starts a fresh cycle but a late old reset cannot affect it', async () => {
  const f = fixture(); await f.observer.bind(identity(), handle().native)
  for (const at of [5, 10, 40]) { f.time(at * minute); await f.observer.tick() }
  f.time(41 * minute); await f.observer.bind(identity('w1', 'e2'), handle().native)
  assert.equal(f.rows.get('w1')!.observation.stage, 0)
  await assert.rejects(f.observer.reset(identity(), 'old-consumed-probe', 0), /current active/)
  f.time(46 * minute); await f.observer.tick()
  assert.equal(f.actions.at(-1)!.action.kind, 'probe-role')
})

test('queued probe arrangement alone does not reset stage or silence', async () => {
  const f = fixture(); await f.observer.bind(identity(), handle().native)
  f.time(5 * minute); await f.observer.tick()
  assert.equal(f.rows.get('w1')!.observation.stage, 1)
  assert.equal(f.rows.get('w1')!.observation.lastProgressAt, 0)
  f.time(10 * minute); await f.observer.tick()
  assert.equal(f.actions.at(-1)!.action.kind, 'warn-role')
})

test('reset committed then acknowledgement lost is idempotent across observer restart', async () => {
  let now = 0, saved: StoredExecutionObservation | undefined, lose = false
  const store = { get: async () => structuredClone(saved), list: async () => saved ? [saved] : [],
    set: async (_key: string, value: StoredExecutionObservation) => { saved = structuredClone(value); if (lose) { lose = false; throw new Error('lost ack') } } }
  const make = () => new ExecutionObservations(store, { arrange: async () => {} }, error => { throw error }, () => now)
  const observer = make(); await observer.bind(identity(), handle().native)
  now = 5 * minute; await observer.tick(); lose = true
  await assert.rejects(observer.reset(identity(), 'probe-1', 0), /lost ack/)
  const resumed = make(); await resumed.bind(identity(), handle().native)
  now = 10 * minute; await resumed.tick()
  const before = structuredClone(saved)
  now = 11 * minute; await resumed.reset(identity(), 'probe-1', 0)
  assert.deepEqual(saved, before)
})

test('unbind while reset reads metadata prevents the late reset write', async () => {
  let saved: StoredExecutionObservation | undefined, hold = false, release!: () => void, entered!: () => void
  const reached = new Promise<void>(resolve => { entered = resolve })
  const observer = new ExecutionObservations({
    get: async () => { if (hold) { hold = false; entered(); await new Promise<void>(resolve => { release = resolve }) }; return structuredClone(saved) },
    set: async (_key, value) => { saved = structuredClone(value) }, list: async () => [],
  }, { arrange: async () => {} }, error => { throw error }, () => 0)
  await observer.bind(identity(), handle().native); hold = true
  const reset = observer.reset(identity(), 'probe', 0); await reached
  const stopped = observer.unbind('w1', 'e1'); release()
  await assert.rejects(reset, /current active/); await stopped
  assert.equal(saved!.resetInputs, undefined); assert.equal(saved!.executing, false)
})

test('reset write rejected before commit leaves the cycle intact and permits the same input retry', async () => {
  let saved: StoredExecutionObservation | undefined, reject = false, now = 0
  const observer = new ExecutionObservations({ get: async () => structuredClone(saved), list: async () => [],
    set: async (_key, value) => { if (reject) { reject = false; throw new Error('not committed') }; saved = structuredClone(value) },
  }, { arrange: async () => {} }, error => { throw error }, () => now)
  await observer.bind(identity(), handle().native); now = 5 * minute; await observer.tick()
  const before = structuredClone(saved); reject = true
  await assert.rejects(observer.reset(identity(), 'probe-1', 0), /not committed/)
  assert.deepEqual(saved, before)
  await observer.reset(identity(), 'probe-1', 0)
  assert.equal(saved!.observation.stage, 0); assert.deepEqual(saved!.resetInputs, ['probe-1'])
})

test('legacy Foreground observation is retired without scheduling its retained daily action', async () => {
  const f = fixture(), a = handle(); await f.observer.bind(identity(), a.native)
  f.time(5 * minute); f.fail(true); await assert.rejects(f.observer.tick())
  const old = f.rows.get('w1')!
  old.observation.identity.role = 'Foreground'; old.pending!.action.identity.role = 'Foreground'
  f.rows.set('w1', old)
  const foreground = handle(); await f.observer.bind({ ...identity(), role: 'Foreground' }, foreground.native)
  assert.equal(foreground.subscribed(), 0); assert.equal(a.subscribed(), 0)
  assert.equal(f.rows.get('w1')!.executing, false)
  assert.equal(await f.observer.mayApply(old.pending!), false)
  f.fail(false); f.time(100 * minute); await f.observer.tick(); assert.equal(f.arranged.length, 0)
})


test('AI reset and Planner marker consumption never reset the other independent clock', async () => {
  const f = fixture(); await f.observer.bind(identity(), handle().native)
  let watch = createRecoveryWatch({ taskId: 't1', member: 'A' }, 0)
  f.time(5 * minute); await f.observer.tick(); await f.observer.reset(identity(), 'consumed-probe', 0)
  assert.equal(dueRecoveryWatch(watch, 29 * minute).action, undefined)
  watch = dueRecoveryWatch(watch, 30 * minute).state
  assert.equal(watch.stage, 1); assert.equal(watch.cycleStartedAt, 0)
  f.time(10 * minute); await f.observer.tick()
  const before = structuredClone(f.rows.get('w1'))
  assert.equal(consumeRecoveryWatch(watch, { ...identity('planner'), role: 'Planner' }, true), undefined)
  assert.deepEqual(f.rows.get('w1'), before)
})


test('first late reset from an older cycle is rejected atomically while applied replay remains idempotent', async () => {
  const f = fixture(); await f.observer.bind(identity(), handle().native)
  f.time(5 * minute); await f.observer.tick()
  const oldCycle = f.actions[0]!.cycleStartedAt
  f.time(6 * minute)
  // Both native inputs were issued/consumed in the old cycle. Only one may reset it.
  const first = f.observer.reset(identity(), 'probe-first', oldCycle)
  const late = f.observer.reset(identity(), 'warning-late', oldCycle)
  await first; await assert.rejects(late, /cycle/)
  assert.deepEqual(f.rows.get('w1')!.resetInputs, ['probe-first'])
  f.time(11 * minute); await f.observer.tick()
  const before = structuredClone(f.rows.get('w1'))
  await f.observer.reset(identity(), 'probe-first', oldCycle)
  assert.deepEqual(f.rows.get('w1'), before, 'receipt replay precedes obsolete cycle rejection')
  await assert.rejects(f.observer.reset(identity(), 'never-applied-old', oldCycle), /cycle/)
  assert.deepEqual(f.rows.get('w1'), before)
  await f.observer.reset(identity(), 'probe-new', f.actions.at(-1)!.cycleStartedAt)
  assert.equal(f.rows.get('w1')!.observation.stage, 0)
})

for (const phase of [1, 2, 3] as const) test(`unperformed phase ${phase} is deferred by progress without resetting the cycle or reusing completed identity`, async () => {
  const f = fixture(), agent = handle(); await f.observer.bind(identity(), agent.native)
  const moments = [5, 10, 40]
  for (const at of moments.slice(0, phase)) { f.time(at * minute); await f.observer.tick() }
  const old = f.actions.at(-1)!, progressAt = old.checkedAt + 1
  f.time(progressAt); agent.emit(progressAt); await f.observer.flush()
  assert.equal(f.rows.get('w1')!.observation.stage, phase, 'ordinary progress does not undo performed actions')
  await f.observer.deferUnperformed(old)
  assert.equal(f.rows.get('w1')!.observation.stage, phase - 1)
  assert.equal(f.rows.get('w1')!.observation.cycleStartedAt, old.cycleStartedAt)
  assert.equal(f.rows.get('w1')!.resetInputs, undefined)
  const delay = (phase === 3 ? 30 : 5) * minute
  f.time(progressAt + delay - 1); await f.observer.tick(); assert.equal(f.actions.length, phase)
  f.time(progressAt + delay); await f.observer.tick()
  const next = f.actions.at(-1)!
  assert.equal(next.action.stage, phase); assert.notEqual(next.id, old.id)
  const before = structuredClone(f.rows.get('w1'))
  await f.observer.deferUnperformed(old)
  assert.deepEqual(f.rows.get('w1'), before, 'late old-action completion cannot defer a newly checked same phase')
})

test('deferral requires newer progress and exact current execution/cycle/pending responsibility', async () => {
  const f = fixture(), agent = handle(); await f.observer.bind(identity(), agent.native)
  f.time(5 * minute); f.fail(true); await assert.rejects(f.observer.tick())
  const old = structuredClone(f.rows.get('w1')!.pending!)
  const before = structuredClone(f.rows.get('w1'))
  await f.observer.deferUnperformed(old); assert.deepEqual(f.rows.get('w1'), before)
  f.time(6 * minute); agent.emit(6 * minute); await f.observer.flush()
  for (const stale of [
    { ...old, cycleStartedAt: -1 },
    { ...old, id: 'different-pending' },
    { ...old, action: { ...old.action, identity: identity('w1', 'older') } },
  ]) {
    const saved = structuredClone(f.rows.get('w1'))
    await f.observer.deferUnperformed(stale); assert.deepEqual(f.rows.get('w1'), saved)
  }
  await f.observer.deferUnperformed(old)
  assert.equal(f.rows.get('w1')!.pending, undefined)
  assert.equal(f.rows.get('w1')!.observation.stage, 0)
})

test('committed deferral lost acknowledgement is idempotent and does not defer a later phase occurrence', async () => {
  let now = 0, saved: StoredExecutionObservation | undefined, lose = false
  const issued: ScheduledObservation[] = []
  const observer = new ExecutionObservations({ get: async () => structuredClone(saved), list: async () => [],
    set: async (_key, value) => { saved = structuredClone(value); if (lose) { lose = false; throw new Error('lost defer ack') } },
  }, { arrange: async pending => { issued.push(pending) } }, error => { throw error }, () => now)
  const agent = handle(); await observer.bind(identity(), agent.native)
  now = 5 * minute; await observer.tick(); const old = issued[0]!
  now++; agent.emit(now); await observer.flush(); lose = true
  await assert.rejects(observer.deferUnperformed(old), /lost defer ack/)
  await observer.deferUnperformed(old); assert.equal(saved!.observation.stage, 0)
  now += 5 * minute; await observer.tick()
  const before = structuredClone(saved)
  await observer.deferUnperformed(old); assert.deepEqual(saved, before)
})

for (const invalidate of [false, true]) test(`deferral reads late native progress but never writes after unbind: ${invalidate}`, async () => {
  let saved: StoredExecutionObservation | undefined, now = 0, reads = 0, hold = false
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), issued: ScheduledObservation[] = []
  const observer = new ExecutionObservations({ get: async () => {
    if (hold && ++reads === 2) { entered.resolve(); await release.promise }
    return structuredClone(saved)
  }, list: async () => [], set: async (_key, value) => { saved = structuredClone(value) } },
  { arrange: async pending => { issued.push(pending) } }, error => { throw error }, () => now)
  const agent = handle(); await observer.bind(identity(), agent.native)
  now = 5 * minute; await observer.tick(); hold = true
  const defer = observer.deferUnperformed(issued[0]!); await entered.promise
  now++; agent.emit(now)
  const stopped = invalidate ? observer.unbind('w1', 'e1') : undefined
  release.resolve(); await defer; await stopped
  assert.equal(saved!.observation.stage, invalidate ? 1 : 0)
  assert.equal(saved!.observation.lastProgressAt, now)
})
