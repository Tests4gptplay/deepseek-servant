import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StoragePort } from '../src/contracts/ports.js'
import { LocalFiles } from '../src/framework/local-files.js'
import { FrameworkTransactions } from '../src/framework/command-transactions.js'
import { FilesConflictError, withSnapshot } from '../src/framework/transactions.js'
import { InstanceRegistration, loadOrCreateInstanceUuid, type InstanceConfig } from '../src/framework/instances.js'
const UUID = '00000000-0000-4000-8000-000000000001'
const UUID2 = '00000000-0000-4000-8000-000000000002'
function memory(): StoragePort {
  const rows = new Map<string, unknown>()
  return {
    get: async key => structuredClone(rows.get(key)) as never,
    set: async (key, value) => { rows.set(key, structuredClone(value)) },
    delete: async key => { rows.delete(key) },
    list: async prefix => [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })) as never,
  }
}
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'dss-instances-'))
  const files = await LocalFiles.open(root)
  t.after(async () => { await files.close(); await rm(root, { recursive: true, force: true }) })
  let now = 0
  const config: InstanceConfig = { repositoryId: 'repo-1', repositoryOwner: 'alice', login: 'alice', instanceUUID: UUID, workerSeats: 2 }
  const storage = memory(), transactions = new FrameworkTransactions(files, storage, 'test')
  const create = (patch: Partial<InstanceConfig> = {}, local = storage) => new InstanceRegistration(files, new FrameworkTransactions(files, local, 'test'), local, { ...config, ...patch }, () => now)
  return { files, storage, transactions, config, create, time: (value: number) => { now = value } }
}
test('settings registration writes/readbacks heartbeat, keeps mapping and advances sequence before publication', async t => {
  const f = await fixture(t), first = f.create()
  const registered = await first.register()
  assert.equal(registered.member, 'alice'); assert.equal(registered.primary, true)
  assert.match(registered.path, /alice_Workers2_00000000-0000-4000-8000-000000000001.json$/)
  const body = await withSnapshot(f.files, s => f.files.read(s, registered.path))
  assert.deepEqual(JSON.parse(body!), { sequence: 1, updatedAt: '1970-01-01T00:00:00.000Z', status: 'running' })
  f.time(29_999); assert.equal(await first.tick(), undefined)
  f.time(30_000); await first.tick()
  const resumed = f.create(); const same = await resumed.register()
  assert.equal(same.member, 'alice')
  assert.equal(JSON.parse((await withSnapshot(f.files, s => f.files.read(s, same.path)))!).sequence, 3)
})
test('same login separate instances allocate numbered names without overwriting the primary', async t => {
  const f = await fixture(t)
  const a = await f.create().register()
  const b = await f.create({ instanceUUID: UUID2 }, memory()).register()
  assert.equal(b.member, 'alice1'); assert.equal(b.primary, false)
  const list = await f.create().observe()
  assert.equal(list.length, 2)
  assert.equal(list.filter(row => !row.primary)[0]!.member, 'alice1')
  assert.ok(await withSnapshot(f.files, s => f.files.read(s, a.path)))
})
test('seat rename atomically replaces only this UUID record and keeps member alias', async t => {
  const f = await fixture(t)
  const a = await f.create().register()
  const updated = await f.create({ workerSeats: 4 }).register()
  assert.equal(updated.member, a.member)
  await withSnapshot(f.files, async s => {
    assert.equal(await f.files.read(s, a.path), undefined)
    assert.equal(JSON.parse((await f.files.read(s, updated.path))!).sequence, 2)
  })
})
test('observation uses sequence and local continuity, never remote clock or stale regression', async t => {
  const f = await fixture(t), publisher = f.create(), observer = f.create({ instanceUUID: UUID2 }, memory())
  const entry = await publisher.register()
  assert.equal((await observer.observe())[0]!.availability, 'unknown')
  f.time(30_000); await publisher.tick()
  assert.equal((await observer.observe())[0]!.availability, 'online')
  f.time(209_999); assert.equal((await observer.observe())[0]!.availability, 'online')
  f.time(210_000); assert.equal((await observer.observe())[0]!.availability, 'offline')
  observer.observationInterrupted()
  assert.equal((await observer.observe())[0]!.availability, 'unknown')
  f.time(240_000); await publisher.tick()
  assert.equal((await observer.observe())[0]!.availability, 'online')
  await withSnapshot(f.files, s => f.files.commit(s, [{ path: entry.path, content: JSON.stringify({ sequence: 1, updatedAt: '2099-01-01T00:00:00Z', status: 'stopped' }) }], 'delayed heartbeat'))
  assert.equal((await observer.observe())[0]!.availability, 'online')
})
test('disconnect publishes stopped and prevents subsequent tick; reconnect resumes greater sequence', async t => {
  const f = await fixture(t), publisher = f.create(), observer = f.create({ instanceUUID: UUID2 }, memory())
  await publisher.register(); await observer.observe()
  await publisher.disconnect()
  assert.equal((await observer.observe())[0]!.availability, 'stopped')
  f.time(500_000); assert.equal(await publisher.tick(), undefined)
  await publisher.register()
  assert.equal((await observer.observe())[0]!.availability, 'online')
})
test('publication failure preserves exact pending payload and reserved sequence for a retry', async t => {
  const f = await fixture(t)
  const original = f.transactions.run.bind(f.transactions)
  let fail = true
  f.transactions.run = ((...args: Parameters<typeof original>) => fail ? Promise.reject(new Error('dispatch unavailable')) : original(...args)) as typeof original
  const instance = new InstanceRegistration(f.files, f.transactions, f.storage, f.config, () => 0)
  await assert.rejects(instance.register(), /dispatch unavailable/)
  const state = (await f.storage.list<any>('framework-instance/'))[0]!.value
  assert.equal(state.sequence, 1)
  const payload = structuredClone(state.pending)
  fail = false; const result = await instance.register()
  const body = await withSnapshot(f.files, s => f.files.read(s, result.path))
  assert.deepEqual(JSON.parse(body!), payload.heartbeat)
})
test('registration race returns CAS conflict then rereads allocation on the next explicit attempt', async t => {
  const f = await fixture(t), aStore = memory(), bStore = memory()
  const a = f.create({}, aStore), b = f.create({ instanceUUID: UUID2 }, bStore)
  const results = await Promise.allSettled([a.register(), b.register()])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  const failed = results.findIndex(r => r.status === 'rejected')
  assert.ok((results[failed] as PromiseRejectedResult).reason instanceof FilesConflictError)
  const retry = await (failed === 0 ? a : b).register()
  assert.equal(retry.member, 'alice1')
})
test('UUID persists and per-repository aliases are retained separately', async t => {
  const f = await fixture(t), local = memory()
  assert.equal(await loadOrCreateInstanceUuid(local), await loadOrCreateInstanceUuid(local))
  await f.create().register()
  const numbered = await f.create({ instanceUUID: UUID2 }, local).register()
  assert.equal(numbered.member, 'alice1')
  const second = await LocalFiles.open(join(f.files.directory, 'second'))
  t.after(() => second.close())
  const other = new InstanceRegistration(second, new FrameworkTransactions(second, local, 'other'), local,
    { ...f.config, repositoryId: 'repo-2', repositoryOwner: 'bob', instanceUUID: UUID2 }, () => 0)
  assert.equal((await other.register()).member, 'alice')
  assert.equal((await f.create({ instanceUUID: UUID2 }, local).register()).member, 'alice1')
})
test('a pending old-seat publication is resolved unchanged before saving the new seat setting', async t => {
  const f = await fixture(t)
  const original = f.transactions.run.bind(f.transactions)
  f.transactions.run = (() => Promise.reject(new Error('dispatch unavailable'))) as typeof original
  const before = new InstanceRegistration(f.files, f.transactions, f.storage, f.config, () => 0)
  await assert.rejects(before.register())
  const after = f.create({ workerSeats: 7 })
  const result = await after.register()
  assert.equal(result.workerSeats, 7)
  const rows = await after.observe()
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.heartbeat.sequence, 2)
})
test('observation interruption resets elapsed continuity but retains the highest seen sequence against delayed stopped records', async t => {
  const f = await fixture(t), publisher = f.create(), observer = f.create({ instanceUUID: UUID2 }, memory())
  const entry = await publisher.register()
  await observer.observe()
  f.time(30_000); await publisher.tick()
  assert.equal((await observer.observe())[0]!.availability, 'online')
  observer.observationInterrupted()
  await withSnapshot(f.files, s => f.files.commit(s, [{ path: entry.path, content: JSON.stringify({ sequence: 1, updatedAt: '1970-01-01T00:00:00Z', status: 'stopped' }) }], 'delayed old stopped'))
  f.time(90_000)
  assert.equal((await observer.observe())[0]!.availability, 'unknown')
  f.time(120_000); await publisher.tick()
  assert.equal((await observer.observe())[0]!.availability, 'online')
})
test('another instance damaged heartbeat still reserves its name but cannot block this registration', async t => {
  const f = await fixture(t)
  const first = await f.create().register()
  await withSnapshot(f.files, s => f.files.commit(s, [{ path: first.path, content: '{broken' }], 'simulate damaged record'))
  const second = await f.create({ instanceUUID: UUID2 }, memory()).register()
  assert.equal(second.member, 'alice1')
  assert.equal(await withSnapshot(f.files, s => f.files.read(s, first.path)), '{broken')
})
test('damaged heartbeat remains visible with a diagnostic without discarding other observations', async t => {
  const f = await fixture(t), publisher = f.create(), other = f.create({ instanceUUID: UUID2 }, memory())
  const a = await publisher.register(); await other.register()
  await publisher.observe()
  await withSnapshot(f.files, s => f.files.commit(s, [{ path: a.path, content: '{bad' }], 'invalid heartbeat'))
  const rows = await publisher.observe()
  assert.equal(rows.length, 2)
  const bad = rows.find(row => row.instanceUUID === UUID)!
  assert.equal(bad.availability, 'unknown'); assert.equal(bad.heartbeat, undefined)
  assert.match(bad.error!, /Invalid heartbeat record/)
  assert.equal(rows.find(row => row.instanceUUID === UUID2)!.heartbeat!.sequence, 1)
})
test('concurrent Local/Git setup with one Host storage reserves a single durable UUID', async () => {
  const storage = memory()
  const ids = await Promise.all([loadOrCreateInstanceUuid(storage), loadOrCreateInstanceUuid(storage), loadOrCreateInstanceUuid(storage)])
  assert.equal(new Set(ids).size, 1)
  assert.equal(await storage.get('framework-instance-uuid'), ids[0])
})

test('identified account switch preserves the exact pending heartbeat before any retry or publication', async t => {
  const f = await fixture(t), originalCommit = f.files.commit.bind(f.files)
  let commitCalls = 0
  f.files.commit = async () => { commitCalls++; throw new Error('synthetic unavailable commit') }
  await assert.rejects(f.create({ accountId: 101 }).register(), /synthetic unavailable/)
  const before = structuredClone(await f.storage.list<any>('framework-instance/'))
  assert.equal(before[0]!.value.accountId, '101')
  assert.ok(before[0]!.value.pending)
  await assert.rejects(f.create({ login: 'bob', accountId: 202 }).register(), /account-changed/)
  assert.equal(commitCalls, 1)
  assert.deepEqual(await f.storage.list('framework-instance/'), before)
  f.files.commit = originalCommit
  const recovered = await f.create({ accountId: '101' }).register()
  assert.equal(recovered.member, 'alice')
  assert.equal((await f.storage.list<any>('framework-instance/'))[0]!.value.pending, undefined)
})

test('legacy mapping without account evidence remains unverified rather than adopting alias as authentication', async t => {
  const f = await fixture(t)
  const old = await f.create().register() // Represents pre-account-binding format.
  const before = structuredClone(await f.storage.list('framework-instance/'))
  const snapshot = await f.files.snapshot(), revision = snapshot.revision
  await snapshot.release()
  await assert.rejects(f.create({ accountId: 101 }).register(), /account-unverified/)
  assert.deepEqual(await f.storage.list('framework-instance/'), before)
  await withSnapshot(f.files, async current => {
    assert.equal(current.revision, revision)
    assert.equal(JSON.parse((await f.files.read(current, old.path))!).sequence, 1)
  })
  assert.equal((await f.create({ accountId: 101 }).observe()).length, 1, 'read-only roster inspection remains possible')
})

test('missing local mapping plus a remote same-UUID row does not permit unknown Git ownership adoption', async t => {
  const f = await fixture(t)
  const original = await f.create({ accountId: 101 }).register()
  const freshTechnicalStore = memory() // Isolated fresh process fixture; original metadata is not deleted.
  await assert.rejects(f.create({ accountId: 202, login: 'bob' }, freshTechnicalStore).register(), /account-unverified/)
  assert.deepEqual(await freshTechnicalStore.list('framework-instance/'), [])
  await withSnapshot(f.files, async snapshot => assert.equal(JSON.parse((await f.files.read(snapshot, original.path))!).sequence, 1))
  assert.equal((await f.storage.list<any>('framework-instance/'))[0]!.value.accountId, '101')
})

test('live registration serializes seat updates and heartbeat on the same alias with strictly increasing publication sequences', async t => {
  const f = await fixture(t), instance = f.create({ workerSeats: 4 })
  const initial = await instance.register()
  f.time(30_000)
  const [changed] = await Promise.all([instance.updateWorkerSeats(1), instance.tick()])
  assert.equal(changed.member, initial.member)
  assert.equal(changed.instanceUUID, initial.instanceUUID)
  assert.equal(changed.primary, initial.primary)
  assert.equal(changed.workerSeats, 1)
  await withSnapshot(f.files, async snapshot => {
    assert.equal(await f.files.read(snapshot, initial.path), undefined)
    const entries = await f.files.listDirectory(snapshot, 'instances')
    assert.deepEqual(entries.map(entry => entry.path), [changed.path])
    assert.equal(JSON.parse((await f.files.read(snapshot, changed.path))!).sequence, 2, 'seat publication also resets the ordinary heartbeat clock')
  })
  f.time(60_000); await instance.tick()
  assert.equal(JSON.parse((await withSnapshot(f.files, snapshot => f.files.read(snapshot, changed.path)))!).sequence, 3)
})

// Registration/CAS contract regression over real LocalFiles, using the same
// authenticated accountId configuration supplied by the Git connection layer.
// No Git account lookup or remote identity fields are simulated in heartbeat data.
test('invited numbered aliases cannot occupy the repository owner exact primary name before the owner registers', async t => {
  const f = await fixture(t), ownerUuid = '00000000-0000-4000-8000-000000000003'
  const firstStore = memory(), secondStore = memory(), ownerStore = memory()
  const invited = { repositoryOwner: 'alice1', login: 'alice', accountId: 101 }
  const first = f.create({ ...invited, instanceUUID: UUID }, firstStore)
  const second = f.create({ ...invited, instanceUUID: UUID2 }, secondStore)
  const owner = f.create({ repositoryOwner: 'alice1', login: 'alice1', accountId: 202, instanceUUID: ownerUuid }, ownerStore)
  const a = await first.register(), a2 = await second.register()
  assert.equal(a.member, 'alice')
  assert.notEqual(a2.member, 'alice1', 'an invited account numbered alias must leave the owner primary name available')
  assert.notEqual(a2.member, a.member, 'same account is not the same instance')
  assert.equal(a.primary, false); assert.equal(a2.primary, false)
  const beforeOwner = await first.observe()
  assert.equal(beforeOwner.length, 2)
  assert.ok(beforeOwner.every(row => !row.primary), 'roster must not mistake an invited numbered alias for the actual owner')
  const own = await owner.register()
  assert.equal(own.member, 'alice1')
  assert.equal(own.primary, true)
  assert.equal(own.instanceUUID, ownerUuid)
  for (const observer of [first, second, owner]) {
    const roster = await observer.observe()
    assert.equal(roster.length, 3)
    assert.equal(new Set(roster.map(row => row.member)).size, 3)
    assert.deepEqual(roster.filter(row => row.primary).map(row => row.instanceUUID), [ownerUuid])
    assert.deepEqual(new Set(roster.map(row => row.instanceUUID)), new Set([UUID, UUID2, ownerUuid]))
  }
  assert.equal((await first.register()).member, a.member)
  assert.equal((await second.register()).member, a2.member, 'later owner registration does not merge or silently rename existing instances')
  await withSnapshot(f.files, async snapshot => {
    assert.ok(await f.files.read(snapshot, a.path))
    assert.ok(await f.files.read(snapshot, a2.path))
    assert.ok(await f.files.read(snapshot, own.path))
  })
  assert.equal((await firstStore.list<any>('framework-instance/'))[0]!.value.accountId, '101')
  assert.equal((await secondStore.list<any>('framework-instance/'))[0]!.value.accountId, '101')
  assert.equal((await ownerStore.list<any>('framework-instance/'))[0]!.value.accountId, '202')
})

test('reserving the owner login still allows its normal second authenticated instance to receive a separate numbered alias', async t => {
  const f = await fixture(t)
  const owner = { repositoryOwner: 'alice1', login: 'alice1', accountId: 202 }
  const first = await f.create({ ...owner, instanceUUID: UUID }, memory()).register()
  const secondStore = memory(), secondInstance = f.create({ ...owner, instanceUUID: UUID2 }, secondStore)
  const second = await secondInstance.register()
  assert.equal(first.member, 'alice1'); assert.equal(first.primary, true)
  assert.equal(second.member, 'alice11'); assert.equal(second.primary, false)
  assert.equal(second.instanceUUID, UUID2)
  assert.equal((await secondInstance.register()).member, second.member)
  await withSnapshot(f.files, async snapshot => {
    assert.ok(await f.files.read(snapshot, first.path))
    assert.ok(await f.files.read(snapshot, second.path))
  })
})

for (const pending of [false, true]) test('proven old invited owner-name collision preserves ' + (pending ? 'pending publication' : 'registered data') + ' without any write', async t => {
  const f = await fixture(t)
  const first = await f.create({ accountId: 101 }).register()
  const row = (await f.storage.list<any>('framework-instance/'))[0]!
  const oldPath = 'instances/alice1_Workers2_' + UUID + '.json'
  // Seed the exact pre-reservation alias/heartbeat shape; no extra remote account
  // field is invented. Only the original local account binding proves ownership.
  await withSnapshot(f.files, async snapshot => f.files.commit(snapshot, [
    { path: first.path, content: null },
    { path: oldPath, content: (await f.files.read(snapshot, first.path))! },
  ], 'Historical numbered invited alias'))
  const revision = await withSnapshot(f.files, async snapshot => snapshot.revision)
  const saved = { ...row.value, member: 'alice1', ...(pending ? { sequence: 2, pending: {
    id: 'original-pending-publication', revision,
    registration: { ...first, member: 'alice1', path: oldPath, primary: false },
    heartbeat: { sequence: 2, updatedAt: '1970-01-01T00:00:30.000Z', status: 'running' }, previousPaths: [],
  } } : {}) }
  await f.storage.set(row.key, saved)
  const before = structuredClone(await f.storage.list('framework-instance/'))
  let remoteWrites = 0, technicalWrites = 0
  f.files.commit = async () => { remoteWrites++; throw new Error('unexpected write') }
  const set = f.storage.set.bind(f.storage)
  f.storage.set = async (key, value) => { technicalWrites++; await set(key, value) }
  const invited = f.create({ repositoryOwner: 'alice1', login: 'alice', accountId: 101 })
  await assert.rejects(invited.register(), /instance-owner-name-conflict/)
  assert.equal(remoteWrites, 0)
  assert.equal(technicalWrites, 0, 'must not resolve or replace the old prepared operation first')
  assert.deepEqual(await f.storage.list('framework-instance/'), before)
  await withSnapshot(f.files, async snapshot => {
    assert.equal(snapshot.revision, revision)
    assert.ok(await f.files.read(snapshot, oldPath))
  })
})
