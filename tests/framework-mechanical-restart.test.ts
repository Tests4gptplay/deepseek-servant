import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FrameworkRoleRuntime } from '../src/framework/role-runtime.js'
import { DshSessionReader } from '../src/adapters/dsh/sessions.js'
import { LocalFiles } from '../src/framework/local-files.js'
import { withSnapshot } from '../src/framework/transactions.js'
import { paths, encodeJson } from '../src/framework/task-files.js'

// Actual Runtime/transactions/SQLite composition; native stop and observation eligibility
// are explicit isolation seams, not an actual running Host or wall-clock timing test.
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'dss-mechanical-restart-'))
  const files = await LocalFiles.open(directory)
  t.after(async () => { await files.close(); await rm(directory, { recursive: true, force: true }) })
  const rows = new Map<string, any>(), errors: unknown[] = []
  const storage = {
    get: async <T>(key: string) => structuredClone(rows.get(key)) as T | undefined,
    set: async (key: string, value: unknown) => { rows.set(key, structuredClone(value)) },
    list: async <T>(prefix: string) => [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) as T })),
  }
  const runtime = new FrameworkRoleRuntime({ agents: { get: () => undefined }, jobs: { list: () => [] }, get: () => undefined } as any,
    files, storage, { scope: 'local', member: 'A', primary: true, workspace: directory, workerSeats: 2, mode: 'local', collaborationId: 'shared' },
    { members: () => ['A'], resources: () => [], heartbeat: async () => {}, error: error => errors.push(error) }) as any
  t.mock.method(DshSessionReader.prototype, 'inspect', async () => ({ exists: true, lastTurn: { turn: 1, closed: true } }) as any)
  runtime.observations = { mayApply: async () => true }
  await withSnapshot(files, snapshot => files.commit(snapshot, ['T1', 'T2'].flatMap(taskId => [
    { path: paths.task(taskId), content: encodeJson({ version: 1, taskId, route: 'O', owner: 'A', status: 'running', members: ['A'], sourcePath: 'tasks/' + taskId + '.md' }) },
    { path: paths.inbox(taskId, 'A'), content: 'original ' + taskId },
    { path: paths.memberStatus(taskId, 'A'), content: encodeJson({ state: 'running', deliveryId: 'original' }) },
  ]), 'original work'))
  async function record(role: string, taskId = 'T1') {
    const workId = runtime.roleKey(role, taskId, role === 'Worker' ? 'child' : undefined)
    const request = { id: 'original-' + role + taskId, role, taskId, workerId: role === 'Worker' ? 'child' : undefined, reason: 'notification', sources: [] }
    const value = { identity: { role, taskId: role === 'Organizer' ? undefined : taskId, member: 'A', workId, executionId: role + taskId, workerId: request.workerId }, sessionId: 's-' + role + taskId, generation: 1, lastWake: request }
    await runtime.saveRole(value)
    const pending = { id: 'stage3-' + role + taskId, action: { kind: role === 'Helper' ? 'restore-helper' : 'restore-role', stage: 3, identity: value.identity, elapsedMs: 2400000, silentMs: 2400000 } }
    await runtime.enqueueObservation(pending)
    return { value, pending }
  }
  const settle = async () => { await Promise.all([...runtime.stopOperations?.values() ?? []].map((v: any) => v.promise)); await runtime.errorTail }
  const wakes = () => [...rows.values()].filter(v => v.request)
  const marker = (taskId = 'T1') => withSnapshot(files, snapshot => files.read(snapshot, paths.state('A', taskId) + '/recovery'))
  return { runtime, files, rows, storage, errors, record, settle, wakes, marker }
}

for (const role of ['Organizer', 'Recorder', 'Planner', 'Worker']) test(`${role} stage3 confirms exact stop before stable continuation and its Task recovery marker`, async t => {
  const f = await fixture(t), { value } = await f.record(role)
  let release!: () => void, stops = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  f.runtime.native = { get: () => undefined, stop: async (_work: string, execution: string) => { assert.equal(execution, value.identity.executionId); stops++; await gate; return { status: 'stopped' } } }
  await f.runtime.processObservations()
  assert.equal(stops, 1); assert.equal(await f.marker(), undefined); assert.equal(f.wakes().length, 0)
  release(); await f.settle(); await f.runtime.processObservations(); await f.runtime.processObservations()
  assert.equal(stops, 1)
  // All actual Task-bound restorations now retain interruption evidence, including O/R.
  assert.equal(await f.marker(), '')
  assert.equal(f.wakes().filter(v => v.request.id.startsWith('observation-restart:')).length, 1)
  assert.equal(f.wakes().filter(v => v.request.id.startsWith('observation-planner:')).length, role === 'Worker' ? 1 : 0)
  assert.equal(await f.marker('T2'), undefined)
  await withSnapshot(f.files, async snapshot => assert.equal(await f.files.read(snapshot, paths.inbox('T1', 'A')), 'original T1'))
})

test('pending T1 stop does not block T2 confirmation or overwrite same recovery marker', async t => {
  const f = await fixture(t); await f.record('Worker'); await f.record('Planner', 'T2')
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve })
  f.runtime.native = { get: () => undefined, stop: async (_: string, id: string) => { if (id === 'WorkerT1') await gate; return { status: 'stopped' } } }
  await f.runtime.processObservations()
  await Promise.all([...f.runtime.stopOperations.values()].filter((v: any) => v.executionId === 'PlannerT2').map((v: any) => v.promise))
  await f.runtime.processObservations()
  assert.equal(await f.marker(), undefined); assert.equal(await f.marker('T2'), '')
  release(); await f.settle(); await f.runtime.processObservations()
  const before = await withSnapshot(f.files, s => f.files.listDirectory(s, paths.state('A', 'T1')))
  await f.runtime.processObservations()
  assert.deepEqual(await withSnapshot(f.files, s => f.files.listDirectory(s, paths.state('A', 'T1'))), before)
})

test('unconfirmed stop cannot publish recovery; later confirmation can', async t => {
  const f = await fixture(t); await f.record('Worker'); let confirmed = false
  f.runtime.native = { get: () => undefined, stop: async () => confirmed ? { status: 'stopped' } : { status: 'unconfirmed', reason: 'producer pending', jobs: ['job'] } }
  await f.runtime.processObservations(); await f.settle(); await f.runtime.processObservations(); await f.settle()
  assert.equal(await f.marker(), undefined); assert.equal(f.wakes().filter(v => v.request.role === 'Worker').length, 0)
  confirmed = true; await f.runtime.processObservations(); await f.settle(); await f.runtime.processObservations()
  assert.equal(await f.marker(), '')
})

test('Helper continuation requests overall restoration and old Foreground observation does nothing', async t => {
  const f = await fixture(t); await f.record('Helper'); await f.record('Foreground'); const stopped: string[] = []
  f.runtime.native = { get: () => undefined, stop: async (_: string, id: string) => { stopped.push(id); return { status: 'stopped' } } }
  await f.runtime.processObservations(); await f.settle(); await f.runtime.processObservations()
  assert.deepEqual(stopped, ['HelperT1'])
  const wake = f.wakes().find(v => v.request.id.startsWith('overall-restore:'))
  assert.equal(wake.request.context.overallRestoration, true)
  assert.equal(f.wakes().some(v => v.request.role === 'Foreground'), false)
})

test('paused global Organizer uses current task rather than absent identity task', async t => {
  const f = await fixture(t); await f.record('Organizer'); await f.runtime.controls.setTask('pause', 'T1', 'paused')
  f.runtime.native = { get: () => undefined, stop: async () => { throw new Error('paused Organizer must not stop') } }
  await f.runtime.processObservations(); assert.equal(f.wakes().length, 0)
})

test('replacement execution during old stop cannot receive old restart or marker', async t => {
  const f = await fixture(t), { value } = await f.record('Worker')
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve })
  f.runtime.native = { get: () => undefined, stop: async () => { await gate; return { status: 'stopped' } } }
  await f.runtime.processObservations()
  await f.runtime.saveRole({ ...value, identity: { ...value.identity, executionId: 'new' }, generation: 2, sessionId: 'new-session' })
  release(); await f.settle(); await f.runtime.processObservations()
  assert.equal(await f.marker(), undefined); assert.equal(f.wakes().length, 0)
  assert.equal(f.runtime.roleRecords.get(value.identity.workId).stopped, undefined)
})

test('closed runtime after in-flight stop publishes no continuation', async t => {
  const f = await fixture(t); await f.record('Worker')
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve })
  f.runtime.native = { get: () => undefined, stop: async () => { await gate; return { status: 'stopped' } } }
  await f.runtime.processObservations(); f.runtime.closed = true; release(); await f.settle(); await f.runtime.processObservations()
  assert.equal(await f.marker(), undefined); assert.equal(f.wakes().length, 0)
})

test('lost observation completion acknowledgement replays the same wake and same marker without stopping again', async t => {
  const f = await fixture(t); await f.record('Worker'); let stops = 0
  f.runtime.native = { get: () => undefined, stop: async () => { stops++; return { status: 'stopped' } } }
  await f.runtime.processObservations(); await f.settle()
  const original = f.storage.set; let failed = false
  f.storage.set = async (key: string, value: any) => {
    await original(key, value)
    if (!failed && key.includes('/observations/') && value.complete) { failed = true; throw new Error('receipt acknowledgement lost') }
  }
  await assert.rejects(f.runtime.processObservations(), /receipt acknowledgement lost/)
  const before = f.wakes().map(v => v.request.id)
  await f.runtime.processObservations()
  assert.deepEqual(f.wakes().map(v => v.request.id), before)
  assert.equal(stops, 1); assert.equal(await f.marker(), '')
})

test('native stop result without successful stopped record save cannot authorize a recovery marker', async t => {
  const f = await fixture(t), { value } = await f.record('Worker')
  f.runtime.native = { get: () => undefined, stop: async () => ({ status: 'stopped' }) }
  const original = f.storage.set; let fail = true
  f.storage.set = async (key: string, row: any) => {
    if (fail && row.identity?.executionId === value.identity.executionId && row.stopped) throw new Error('stopped persistence unavailable')
    await original(key, row)
  }
  await f.runtime.processObservations(); await f.settle()
  assert.equal(await f.marker(), undefined)
  assert.equal(f.runtime.roleRecords.get(value.identity.workId).stopped, undefined)
  assert.equal(f.wakes().some(v => v.request.role === 'Worker'), false)
  fail = false; await f.runtime.processObservations(); await f.settle(); await f.runtime.processObservations()
  assert.equal(await f.marker(), '')
})

test('native lane persists confirmed stop but leaves SQLite marker and continuation to settle lane exactly once', async t => {
  const f = await fixture(t), { value, pending } = await f.record('Worker'); let stops = 0
  f.runtime.native = { get: () => undefined, stop: async () => { stops++; return { status: 'stopped' } } }
  await f.runtime.processObservations(false, 'native'); await f.settle()
  for (let i = 0; i < 3; i++) await f.runtime.processObservations(false, 'native')
  assert.equal(stops, 1); assert.equal(f.runtime.roleRecords.get(value.identity.workId).stopped, true)
  const saved = () => [...f.rows.values()].find(v => v.pending?.id === pending.id)
  assert.equal(saved().stopStarted, true); assert.equal(saved().complete, false)
  assert.equal(await f.marker(), undefined); assert.equal(f.wakes().length, 0)
  await f.runtime.processObservations(false, 'settle')
  assert.equal(await f.marker(), ''); assert.equal(saved().complete, true)
  const wakes = f.wakes(), entries = await withSnapshot(f.files, s => f.files.listDirectory(s, paths.state('A', 'T1')))
  await f.runtime.processObservations(false, 'settle'); await f.runtime.processObservations(false, 'native')
  assert.equal(stops, 1); assert.deepEqual(f.wakes(), wakes)
  assert.deepEqual(await withSnapshot(f.files, s => f.files.listDirectory(s, paths.state('A', 'T1'))), entries)
  assert.equal(wakes.filter(v => v.request.role === 'Worker').length, 1)
  assert.equal(wakes.filter(v => v.request.role === 'Planner').length, 1)
})

test('held native stop does not block another role probe; closed settle cannot write recovery', async t => {
  const f = await fixture(t); await f.record('Worker')
  const { value, pending } = await f.record('Planner', 'T2')
  // Replace the queued stage3 record with a real stage1 scheduled observation.
  for (const [key, row] of f.rows) if (row.pending?.id === pending.id) f.rows.delete(key)
  const probe = { ...pending, id: 'probe-T2', action: { ...pending.action, kind: 'probe-role', stage: 1, elapsedMs: 300000, silentMs: 300000 } }
  await f.runtime.enqueueObservation(probe)
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve })
  const sent: any[] = []
  f.runtime.native = {
    get: (workId: string) => workId === value.identity.workId ? { sessionId: value.sessionId, send: async (...args: any[]) => { sent.push(args) } } : undefined,
    stop: async () => { await gate; return { status: 'stopped' } },
  }
  await f.runtime.processObservations(false, 'native')
  assert.equal(sent.length, 1); assert.equal(JSON.parse(sent[0][0]).kind, 'probe-role')
  assert.deepEqual(sent[0].slice(1), ['probe-T2', 'steer', 'deepseek-servant'])
  assert.equal(await f.marker(), undefined)
  f.runtime.closed = true; release(); await f.settle()
  await f.runtime.processObservations(false, 'settle')
  assert.equal(await f.marker(), undefined); assert.equal(f.wakes().length, 0)
  assert.equal([...f.rows.values()].find(v => v.pending?.id === 'stage3-WorkerT1').complete, false)
})

test('ordinary same-work wake cannot replace pending mechanical recovery and continuation admits first after settle', async t => {
  const f = await fixture(t), { value, pending } = await f.record('Worker')
  const handles = new Map<string, any>(), order: any[] = []
  f.runtime.gateway = { exists: async () => false }
  f.runtime.native = {
    get: (key: string) => handles.get(key),
    stop: async (workId: string, executionId: string) => { order.push({ kind: 'stop', workId, executionId }); handles.delete(workId); return { status: 'stopped' } },
    open: async (identity: any, options: any) => {
      const handle = { sessionId: options.sessionId, state: 'idle', observe() { return { state: this.state } },
        send: async (text: string, id: string, mode: string) => { handle.state = 'running'; order.push({ kind: 'send', role: identity.role, executionId: identity.executionId, text: JSON.parse(text), id, mode }) } }
      order.push({ kind: 'open', role: identity.role, executionId: identity.executionId })
      handles.set(identity.workId, handle); return handle
    },
  }
  await f.runtime.processObservations(false, 'native'); await f.settle()
  await f.runtime.wake({ id: 'ordinary-later-notification', role: 'Worker', taskId: 'T1', workerId: 'child', reason: 'notification', sources: [] })
  await f.runtime.runQueue()
  assert.equal(order.filter(v => v.kind === 'open').length, 0)
  assert.equal(await f.marker(), undefined)
  await f.runtime.processObservations(false, 'settle')
  assert.equal(await f.marker(), '')
  await f.runtime.runQueue()
  const firstWorkerSend = order.find(v => v.kind === 'send' && v.role === 'Worker')
  assert.equal(firstWorkerSend.mode, 'steer', 'existing recovery responsibility precedes a later ordinary notification')
  assert.equal(firstWorkerSend.text.reason, 'startup-recovery')
  handles.get(value.identity.workId).state = 'idle'
  await f.runtime.runQueue()
  assert.equal(new Set(order.filter(v => v.kind === 'open' && v.role === 'Worker').map(v => v.executionId)).size, 1)
  const workerSends = order.filter(v => v.kind === 'send' && v.role === 'Worker')
  assert.deepEqual(workerSends.map(v => v.mode), ['steer', 'followup'])
  assert.deepEqual(workerSends.map(v => v.text.reason), ['startup-recovery', 'notification'])
  assert.equal(workerSends[0].executionId, workerSends[1].executionId)
  assert.deepEqual(order.filter(v => v.kind === 'stop').map(v => v.executionId), [value.identity.executionId])
  assert.equal([...f.rows.values()].find(v => v.pending?.id === pending.id).complete, true)
})

test('stop settling during source discovery cannot bypass pending observation ownership at generation creation', async t => {
  const f = await fixture(t), { value } = await f.record('Worker')
  let releaseStop!: () => void, releaseRead!: () => void, readEntered!: () => void
  const stopGate = new Promise<void>(resolve => { releaseStop = resolve })
  const readGate = new Promise<void>(resolve => { releaseRead = resolve })
  const entered = new Promise<void>(resolve => { readEntered = resolve })
  const opened: any[] = []
  f.runtime.gateway = { exists: async () => false }
  f.runtime.native = { get: () => undefined,
    stop: async () => { await stopGate; return { status: 'stopped' } },
    open: async (identity: any) => { opened.push(identity); return { send: async () => {} } },
  }
  const signal = paths.state('A', 'T1') + '/Worker_child'
  await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [{ path: signal, content: '' }], 'existing ordinary notification'))
  await f.runtime.processObservations(false, 'native')
  const original = f.files.listDirectory.bind(f.files)
  let once = true
  t.mock.method(f.files, 'listDirectory', async (snapshot, path) => {
    const result = await original(snapshot, path)
    if (once && path === paths.state('A', 'T1') + '/') { once = false; readEntered(); await readGate }
    return result
  })
  await f.runtime.wake({ id: 'source-discovery-race', role: 'Worker', taskId: 'T1', workerId: 'child', reason: 'notification', sources: [{ path: signal }] })
  const admission = f.runtime.runQueue()
  await entered
  releaseStop(); await f.settle()
  assert.equal(f.runtime.roleRecords.get(value.identity.workId).stopped, true)
  releaseRead(); await admission
  assert.equal(opened.length, 0, 'fresh stop completion still owns its pending settlement after source discovery awaits')
  assert.equal(await f.marker(), undefined)
  await f.runtime.processObservations(false, 'settle')
  assert.equal(await f.marker(), '')
})
