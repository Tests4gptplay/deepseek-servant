import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FrameworkRoleRuntime } from '../src/framework/role-runtime.js'
import { LocalFiles } from '../src/framework/local-files.js'
import { withSnapshot } from '../src/framework/transactions.js'
import { paths, encodeJson, discoverInbox } from '../src/framework/task-files.js'
import type { StoragePort } from '../src/contracts/ports.js'
import type { RoleWake } from '../src/framework/host-loop.js'

// Real runtime/HostLoop and SQLite persistence; native Agent boundary is isolated.
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const taskId = '11111111-1111-4111-8111-111111111111'
const request = (id = 'wake'): RoleWake => ({ id, role: 'Planner', taskId, reason: 'notification', sources: [] })
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'dss-discovery-admission-'))
  const files = await LocalFiles.open(join(directory, 'business'))
  const records = await LocalFiles.open(join(directory, 'records'))
  let tail: Promise<unknown> = Promise.resolve()
  const path = (key: string) => 'records/' + hash(key) + '.json'
  const storage: StoragePort = {
    get: async <T>(key: string) => withSnapshot(records, async snapshot => {
      const text = await records.read(snapshot, path(key))
      return text === undefined ? undefined : JSON.parse(text).value as T
    }),
    set: <T>(key: string, value: T) => {
      const write = tail.catch(() => {}).then(() => withSnapshot(records, snapshot => records.commit(snapshot,
        [{ path: path(key), content: JSON.stringify({ key, value }) }], 'fixture durable record')))
      tail = write
      return write.then(() => {})
    },
    list: async <T>(prefix: string) => withSnapshot(records, async snapshot => {
      const rows = await Promise.all((await records.listDirectory(snapshot, 'records/')).map(async entry =>
        JSON.parse((await records.read(snapshot, entry.path))!) as { key: string; value: T }))
      return rows.filter(row => row.key.startsWith(prefix))
    }),
  }
  const errors: unknown[] = []
  const runtime = new FrameworkRoleRuntime({ agents: { get: () => undefined }, jobs: { list: () => [] }, get: () => undefined } as any,
    files, storage, { scope: 'discovery-test', member: 'A', primary: true, workspace: directory, workerSeats: 2, mode: 'local', collaborationId: 'test' },
    { members: () => ['A'], resources: () => [], heartbeat: async () => {}, error: error => errors.push(error) }) as any
  t.after(async () => { await runtime.loop.stop(); await tail; await files.close(); await records.close(); await rm(directory, { recursive: true, force: true }) })
  return { runtime, files, storage, errors }
}

test('wake acknowledges only new durable responsibility and deduplicates exact and same-domain notifications', async t => {
  const { runtime, storage } = await fixture(t)
  assert.equal(await runtime.wake(request()), true)
  assert.equal((await storage.list<any>(runtime.prefix + 'wakes/')).length, 1)
  assert.equal(await runtime.wake(request()), false)
  assert.equal(await runtime.wake(request('another-notification')), false)
  assert.equal((await storage.list<any>(runtime.prefix + 'wakes/')).length, 1)
})

test('concurrent identical wake returns one true only after its actual write acknowledgement', async t => {
  const { runtime, storage } = await fixture(t)
  const original = storage.set.bind(storage)
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { entered = resolve })
  storage.set = async (key, value) => { if (key.includes('/wakes/')) { entered(); await gate } await original(key, value) }
  let resolved = 0
  const first = runtime.wake(request()).then((value: boolean) => { resolved++; return value })
  await ready
  const second = runtime.wake(request())
  assert.equal(resolved, 0)
  release()
  assert.deepEqual(await Promise.all([first, second]), [true, false])
})

test('released Task is checked again inside serialized wake write and never reports creation', async t => {
  const { runtime, storage } = await fixture(t)
  const original = storage.get.bind(storage)
  let checks = 0
  storage.get = async <T>(key: string) => {
    if (key.includes('/sealed/') && ++checks === 2) await storage.set(key, { released: true })
    return original<T>(key)
  }
  assert.equal(await runtime.wake(request()), false)
  assert.equal((await storage.list(runtime.prefix + 'wakes/')).length, 0)
  assert.equal(await runtime.wake(request('after-release')), false)
})

test('rejected persistence cannot report a newly admitted wake', async t => {
  const { runtime, storage } = await fixture(t)
  const rejected = new Error('record write rejected')
  storage.set = async () => { throw rejected }
  await assert.rejects(runtime.wake(request()), error => error === rejected)
  assert.equal((await storage.list(runtime.prefix + 'wakes/')).length, 0)
})

test('write accepted but acknowledgement lost rejects, then durable replay is false rather than a second admission', async t => {
  const { runtime, storage } = await fixture(t)
  const original = storage.set.bind(storage), unknown = new Error('write accepted; acknowledgement unknown')
  storage.set = async (key, value) => { await original(key, value); if (key.includes('/wakes/')) throw unknown }
  await assert.rejects(runtime.wake(request()), error => error === unknown)
  assert.equal((await storage.list(runtime.prefix + 'wakes/')).length, 1)
  storage.set = original
  assert.equal(await runtime.wake(request()), false)
})

async function prepareDiscovery(t: test.TestContext) {
  const fixtureValue = await fixture(t), { runtime, files } = fixtureValue
  // Leave actual discovery, wake, constructor callback, pump and runQueue in place.
  // Exclude unrelated maintenance so one poll has a precise admission assertion.
  runtime.observe = async () => {}
  runtime.discover = async () => {}
  runtime.checkWakeAdmissions = async () => {}
  runtime.restorePending = async () => {}
  runtime.observations.tick = async () => {}
  runtime.processObservations = async () => {}
  const opens: any[] = [], sent: any[] = []
  runtime.gateway = { exists: async () => false }
  runtime.native = { get: () => undefined, open: async (identity: unknown) => {
    opens.push(identity)
    return { send: async (text: string, id: string) => { sent.push({ text: JSON.parse(text), id }) } }
  } }
  const source = paths.state('A', taskId) + '/Planner_Inbox'
  await withSnapshot(files, snapshot => files.commit(snapshot, [
    { path: paths.task(taskId), content: encodeJson({ version: 1, taskId, route: 'P', owner: 'A', sourcePath: 'tasks/synthetic_P.md', status: 'running', members: ['A'] }) },
    { path: paths.memberStatus(taskId, 'A'), content: encodeJson({ state: 'running', deliveryId: '' }) },
    { path: paths.inbox(taskId, 'A'), content: 'Actual persisted synthetic responsibility' },
    { path: source, content: '' },
  ], 'discovery fixture'))
  await withSnapshot(files, async snapshot => {
    const changes = await discoverInbox(files, snapshot, taskId, 'A')
    if (changes.length) await files.commit(snapshot, changes, 'initial Inbox discovery')
  })
  return { ...fixtureValue, opens, sent }
}

test('actual constructor discovery callback opens and sends newly persisted Planner in the same poll', async t => {
  const { runtime, storage, opens, sent, errors } = await prepareDiscovery(t)
  await runtime.loop.poll()
  const admission = runtime.pumping
  assert.ok(admission || (await storage.list<any>(runtime.prefix + 'wakes/')).some(row => row.value.delivered), 'this poll registered admission or already confirmed it')
  await admission
  await Promise.all([...runtime.admissions.values()]) // Owned native accepts, without a second discovery tick or model-turn wait.
  assert.equal(opens.length, 1)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].text.taskId, taskId)
  assert.equal((await storage.list<any>(runtime.prefix + 'wakes/'))[0].value.delivered, true)
  await runtime.loop.poll()
  assert.equal(opens.length, 1)
  assert.equal(sent.length, 1)
  assert.deepEqual(errors, [])
})

test('closed runtime discovery cannot open or send even when new work was found', async t => {
  const { runtime, opens, sent } = await prepareDiscovery(t)
  runtime.closed = true
  await runtime.loop.poll()
  assert.deepEqual(opens, [])
  assert.deepEqual(sent, [])
})

test('empty discovery and existing deduplicated responsibility do not invoke admission pump', async t => {
  const { runtime } = await fixture(t)
  runtime.observe = async () => {}
  runtime.discover = async () => {}
  runtime.checkWakeAdmissions = async () => {}
  runtime.restorePending = async () => {}
  runtime.observations.tick = async () => {}
  runtime.processObservations = async () => {}
  let pumps = 0
  runtime.pump = async () => { pumps++ }
  await runtime.loop.poll()
  assert.equal(pumps, 0)
  const prepared = await prepareDiscovery(t)
  const original = prepared.runtime.wake.bind(prepared.runtime)
  prepared.runtime.wake = async (wake: RoleWake) => { await original(wake); return original(wake) }
  prepared.runtime.pump = async () => { pumps++ }
  await prepared.runtime.loop.poll()
  assert.equal(pumps, 0)
})
