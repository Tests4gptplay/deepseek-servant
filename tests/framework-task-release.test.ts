import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { FrameworkRoleRuntime } from '../src/framework/role-runtime.js'
import { ExecutionControls } from '../src/framework/execution-control.js'
import { MemoryStorage } from './support.js'
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
function fixture(storage = new MemoryStorage()) {
  const runtime = Object.create(FrameworkRoleRuntime.prototype) as any
  Object.assign(runtime, { prefix: 'test-release/', records: storage, files: {}, roleRecords: new Map(), roleWrites: new Map(), wakeWrites: new Map(),
    observations: { unbind: async () => {} }, controls: new ExecutionControls(storage, 'release'), environment: {}, closed: false })
  return { runtime, storage }
}
const request = { id: 'old-worker-wake', role: 'Worker', reason: 'notification', taskId: 'T1', workerId: 'W1',
  sources: [{ path: 'state/A/T1/Worker_W1', version: 'v1' }], context: { text: 'PRIVATE_OLD_WORK_BODY' } }

test('released Task retains lightweight identity, not native input/work context, and preserves other Task and pending Foreground', async () => {
  const { runtime, storage } = fixture()
  const identity = { role: 'Worker', taskId: 'T1', member: 'A', workerId: 'W1', workId: 'W1', executionId: 'E1' }
  await runtime.saveRole({ identity, sessionId: 'S1', generation: 1, stopped: true, lastWake: request,
    delivery: { request, messageId: 'native-old-message', text: 'PRIVATE_OLD_WORK_BODY', confirmed: true } })
  await runtime.wake(request)
  const foreground = { id: 'pending-final', role: 'Foreground', taskId: 'T1', reason: 'complete', sources: [], context: { results: 'retained-final' } }
  await runtime.wake(foreground)
  const other = { ...request, id: 'other-task', taskId: 'T2' }
  await runtime.wake(other)
  const otherBefore = await storage.get(runtime.prefix + 'wakes/' + hash(other.id))
  await runtime.releaseTask({ taskId: 'T1', owner: 'A', members: ['A'] })
  const role = await storage.get<any>(runtime.prefix + 'roles/' + hash('W1'))
  assert.equal(role.released, true); assert.equal(role.identity.executionId, 'E1')
  assert.equal(role.delivery, undefined); assert.equal(role.lastWake, undefined)
  const wake = await storage.get<any>(runtime.prefix + 'wakes/' + hash(request.id))
  assert.equal(wake.delivered, true); assert.equal(wake.request.context, undefined); assert.deepEqual(wake.request.sources, [])
  assert.equal(JSON.stringify(wake).includes('PRIVATE_OLD_WORK_BODY'), false)
  assert.deepEqual(await storage.get(runtime.prefix + 'wakes/' + hash(other.id)), otherBefore)
  assert.deepEqual((await storage.get<any>(runtime.prefix + 'wakes/' + hash(foreground.id))).request, foreground)
})

test('cold replay of a released Task recovery wake cannot reopen its old execution responsibility', async () => {
  const { runtime, storage } = fixture()
  await runtime.wake(request)
  await runtime.releaseTask({ taskId: 'T1', owner: 'A', members: ['A'] })
  const restarted = fixture(storage).runtime
  await restarted.wake(request, { targetExecutionId: 'E1', original: { request, messageId: 'old', text: 'OLD', confirmed: false } })
  const wake = await storage.get<any>(runtime.prefix + 'wakes/' + hash(request.id))
  assert.equal(wake.delivered, true)
  assert.equal(wake.recovery, undefined)
  await restarted.wake({ ...request, id: 'new-identifier-old-task' })
  assert.equal(await storage.get(runtime.prefix + 'wakes/' + hash('new-identifier-old-task')), undefined)
})

test('a late wake that began before release cannot restore its payload after the terminal receipt', async () => {
  const { runtime, storage } = fixture()
  let enter!: () => void, resume!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve }), held = new Promise<void>(resolve => { resume = resolve })
  const originalGet = storage.get.bind(storage); let intercepted = false
  storage.get = async <T>(key: string): Promise<T | undefined> => {
    const value = await originalGet<T>(key)
    if (!intercepted && key === runtime.prefix + 'sealed/' + hash('T1')) { intercepted = true; enter(); await held }
    return value
  }
  const pending = runtime.wake(request); await entered
  await runtime.releaseTask({ taskId: 'T1', owner: 'A', members: ['A'] })
  resume(); await pending
  assert.equal(await storage.get(runtime.prefix + 'wakes/' + hash(request.id)), undefined)
})

test('late old role persistence cannot restore released work content', async () => {
  const { runtime, storage } = fixture()
  const old = { identity: { role: 'Recorder', taskId: 'T1', workId: 'R1', executionId: 'E1' }, sessionId: 'S1', generation: 1,
    stopped: true, lastWake: request, delivery: { request, messageId: 'old', text: 'PRIVATE_OLD_WORK_BODY', confirmed: true } }
  await runtime.saveRole(old)
  await runtime.releaseTask({ taskId: 'T1', owner: 'A', members: ['A'] })
  await runtime.saveRole(old)
  const role = await storage.get<any>(runtime.prefix + 'roles/' + hash('R1'))
  assert.equal(role.released, true); assert.equal(role.delivery, undefined); assert.equal(role.lastWake, undefined)
})

test('late role save during control release retains the already retired role projection', async () => {
  const { runtime, storage } = fixture()
  const old = { identity: { role: 'Recorder', taskId: 'T1', workId: 'R1', executionId: 'E1' }, sessionId: 'S1', generation: 1,
    stopped: true, lastWake: request, delivery: { request, messageId: 'old', text: 'PRIVATE_OLD_WORK_BODY', confirmed: true } }
  await runtime.saveRole(old)
  let enter!: () => void, resume!: () => void
  const entered = new Promise<void>(r => { enter = r }), barrier = new Promise<void>(r => { resume = r })
  const set = storage.set.bind(storage)
  storage.set = async (key, value) => { if (key.startsWith('framework-user-controls/')) { enter(); await barrier }; await set(key, value) }
  const releasing = runtime.releaseTask({ taskId: 'T1', owner: 'A', members: ['A'] })
  await entered
  await runtime.saveRole(old)
  const during = await storage.get<any>(runtime.prefix + 'roles/' + hash('R1'))
  resume(); await releasing
  assert.equal(during.released, true)
  assert.equal(during.delivery, undefined)
  assert.equal((await storage.get<any>(runtime.prefix + 'roles/' + hash('R1'))).delivery, undefined)
})

test('released Task retires only its stopped global Organizer execution and rejects late old payload', async () => {
  const { runtime, storage } = fixture()
  const old = { identity: { role: 'Organizer', workId: 'global-O', executionId: 'O1' }, sessionId: 'OS1', generation: 1,
    stopped: true, lastWake: { ...request, role: 'Organizer' }, delivery: { request: { ...request, role: 'Organizer' }, messageId: 'old-O', text: 'OLD_ORGANIZER_BODY', confirmed: true } }
  await runtime.saveRole(old)
  await runtime.releaseTask({ taskId: 'T1', owner: 'A', members: ['A'] })
  await runtime.saveRole(old)
  const saved = await storage.get<any>(runtime.prefix + 'roles/' + hash('global-O'))
  assert.equal(saved.identity.taskId, undefined)
  assert.equal(saved.delivery, undefined); assert.equal(saved.lastWake, undefined)
  const cold = fixture(storage).runtime
  await cold.saveRole(old)
  assert.equal((await storage.get<any>(runtime.prefix + 'roles/' + hash('global-O'))).delivery, undefined)
  const next = { ...old, identity: { ...old.identity, executionId: 'O2' }, generation: 2,
    lastWake: { ...old.lastWake, taskId: 'T2' }, delivery: { ...old.delivery, request: { ...old.delivery.request, taskId: 'T2' }, messageId: 'new-O' } }
  await runtime.saveRole(next)
  await runtime.releaseTask({ taskId: 'T1', owner: 'A', members: ['A'] })
  assert.equal((await storage.get<any>(runtime.prefix + 'roles/' + hash('global-O'))).delivery.request.taskId, 'T2')
})

test('Task Organizer retirement waits for exact native stop and ignores another Task admission', async () => {
  const { runtime, storage } = fixture()
  const value = { identity: { role: 'Organizer', workId: 'global-O', executionId: 'O1' }, sessionId: 'OS1', generation: 1,
    lastWake: { ...request, role: 'Organizer' } }
  await runtime.saveRole(value)
  let finish!: () => void, stops = 0
  const gate = new Promise<void>(r => { finish = r })
  runtime.native = { stop: async (_work: string, execution: string) => { assert.equal(execution, 'O1'); stops++; await gate; return { status: 'stopped' } } }
  assert.equal(await runtime.settleTaskOrganizer('T1'), false)
  assert.equal(stops, 1)
  assert.equal((await storage.get<any>(runtime.prefix + 'roles/' + hash('global-O'))).stopped, undefined)
  finish(); await Promise.all([...runtime.stopOperations.values()].map((s: any) => s.promise))
  assert.equal(await runtime.settleTaskOrganizer('T1'), true)
  await runtime.releaseTask({ taskId: 'T1', owner: 'A', members: ['A'] })
  assert.equal((await storage.get<any>(runtime.prefix + 'roles/' + hash('global-O'))).lastWake, undefined)
  await runtime.saveRole({ ...value, identity: { ...value.identity, executionId: 'O2' }, generation: 2, lastWake: { ...value.lastWake, taskId: 'T2' } })
  runtime.workOperations.set('global-O', new Promise(() => {}))
  assert.equal(await runtime.settleTaskOrganizer('T1'), true)
  assert.equal(stops, 1)
})
