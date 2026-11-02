import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FrameworkRoleRuntime as Runtime } from '../src/framework/role-runtime.js'
import { FrameworkService } from '../src/framework/service.js'
import { ExecutionControls } from '../src/framework/execution-control.js'
import { LocalFiles } from '../src/framework/local-files.js'
import { FrameworkTransactions } from '../src/framework/command-transactions.js'
import { FrameworkConversation } from '../src/framework/conversation.js'
import type { StoragePort } from '../src/contracts/ports.js'
import type { FrameworkClientSettings, FrameworkSendInput } from '../src/framework/client-contracts.js'
const settings: FrameworkClientSettings = { name: 'DSS', userName: 'User', localDirectory: '/fixture', ownerRepo: 'Owner/repo', repositoryDirectory: '', collaborationId: 'team', workerSeats: 1, workspace: '/fixture' }
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'dss-service-')), local = await LocalFiles.open(join(root, 'local')), gitSeam = await LocalFiles.open(join(root, 'git-seam'))
  t.after(async () => { await local.close(); await gitSeam.close(); await rm(root, { recursive: true, force: true }) })
  const data = new Map<string, unknown>()
  const storage: StoragePort = { async get<T>(key: string) { return data.get(key) as T | undefined }, async set(key, value) { data.set(key, value) }, async list<T>(prefix: string) { return [...data].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: value as T })) } }
  // Service methods, transactions and conversation are real. Only native runtime
  // startup/registration are supplied as seams; Git mode here is NOT remote Git.
  const service = new FrameworkService({} as any, storage, settings), internal = service as any
  const lifecycle = { closes: 0, disposes: 0, opens: 0, invalidations: 0 }
  const running = (mode: 'local' | 'git') => {
    const files = mode === 'local' ? local : gitSeam, transactions = new FrameworkTransactions(files, storage, mode)
    const connection = { files, transactions, scope: mode, identity: { login: mode === 'local' ? 'User' : 'Owner', owner: 'Owner', instanceUUID: '00000000-0000-4000-8000-000000000002', repositoryId: mode }, prepareWrite: async () => {}, cancelPending: () => {}, repository: mode === 'git' ? { identity: { login: 'Owner', id: 42 } } : undefined, close: async () => {} }
    const conversation = new FrameworkConversation(files, transactions, { mode, collaborationId: internal.saved.get(mode).settings.collaborationId })
    internal.accesses.set(mode, Promise.resolve({ connection, conversation }))
    const registration = { member: mode === 'local' ? 'User-1' : 'Owner-2', workerSeats: internal.saved.get(mode).settings.workerSeats }
    return { connection: { files, registration, cancelPending: () => {}, updateWorkerSeats: async (seats: number) => { registration.workerSeats = seats; return registration }, members: async () => [{ member: 'Offline-1', availability: 'offline', instanceUUID: 'old-instance', workerSeats: 2 }], repository: mode === 'git' ? { identity: { login: 'Owner', id: 42 } } : undefined, close: async () => { lifecycle.closes++ } },
      runtime: { workerSeats: registration.workerSeats, updateWorkerSeats(seats: number) { this.workerSeats = seats }, model: undefined as unknown, setForegroundModel(model: unknown) { this.model = structuredClone(model) }, invalidateSkills: () => { lifecycle.invalidations++ }, controls: new ExecutionControls(storage, mode), applyUserControls: async () => {}, resumeTask: async () => {}, requestExecutionStop: async () => {}, conversation: new FrameworkConversation(files, transactions, { mode, collaborationId: internal.saved.get(mode).settings.collaborationId }), executionViews: () => [], dispose: async () => { lifecycle.disposes++ } }, resources: [{ member: 'Offline-1', availability: 'offline', instanceUUID: 'old-instance', workerSeats: 2 }] }
  }
  for (const mode of ['local', 'git'] as const) { internal.saved.set(mode, { revision: mode + '-settings', settings: { ...settings } }); internal.running.set(mode, running(mode)) }
  internal.open = async (mode: 'local' | 'git') => { lifecycle.opens++; const active = running(mode); internal.running.set(mode, active); return active }
  const realAccess = internal.access.bind(internal)
  internal.access = (mode: 'local' | 'git') => { if (internal.closed) return realAccess(mode); assert.ok(internal.accesses.has(mode), 'test access must not reach native authentication or external storage'); return realAccess(mode) }
  return { service, local, gitSeam, lifecycle, storage }
}
const input = (mode: 'local' | 'git', id: string): FrameworkSendInput => ({ mode, collaborationId: 'team', storageScope: mode, id, createdAt: '2026-10-31T12:00:00.000Z', text: 'Original service text 😀\n', recipient: 'ai', device: 'test-browser', timezoneOffsetMinutes: 540 })


const route = { provider: 'fixture', model: 'new-model', reasoningEffort: 'high' }
const change = (revision = 'local-settings', commandId = 'model-choice') => ({ mode: 'local' as const, storageScope: 'local', expectedRevision: revision, commandId, model: route })

test('foreground-only model change preserves active background/native owner, history and other settings', async t => {
  const { service, local, lifecycle } = await fixture(t), internal = service as any
  await service.send({ ...input('local', 'kept-message'), recipient: 'human' })
  const owner = internal.running.get('local'), access = await internal.access('local'), other = internal.running.get('git')
  const before = (await service.view({ mode: 'local' })).settings
  const updated = await service.foregroundModel(change())
  assert.deepEqual(updated.settings, { ...before, foreground: route })
  assert.equal(internal.running.get('local'), owner); assert.equal(internal.running.get('git'), other)
  assert.equal(await internal.access('local'), access); assert.deepEqual(owner.runtime.model, route)
  assert.deepEqual(lifecycle, { closes: 0, disposes: 0, opens: 0, invalidations: 0 })
  assert.equal((await service.view({ mode: 'local' })).messages[0].id, 'kept-message')
  assert.notEqual(updated.revision, 'local-settings')
})

test('confirmed command replay returns current choice without overwriting a later choice', async t => {
  const { service } = await fixture(t)
  const first = await service.foregroundModel(change())
  const later = await service.foregroundModel({ ...change(first.revision, 'second'), model: { provider: 'fixture', model: 'later' } })
  const replay = await service.foregroundModel(change())
  assert.equal(replay.revision, later.revision); assert.equal(replay.settings.foreground?.model, 'later')
  await assert.rejects(service.foregroundModel({ ...change(), model: { provider: 'fixture', model: 'different' } }), /identity changed/)
})

test('Auto clears only foreground and stale revision/scope cannot mutate or stop a running owner', async t => {
  const { service, lifecycle } = await fixture(t)
  const first = await service.foregroundModel(change())
  await assert.rejects(service.foregroundModel(change('local-settings', 'old')), /Settings changed/)
  await assert.rejects(service.foregroundModel({ ...change(first.revision, 'other-scope'), storageScope: 'different' }), /scope/i)
  const auto = await service.foregroundModel({ ...change(first.revision, 'auto'), model: undefined })
  assert.equal(auto.settings.foreground, undefined)
  assert.equal(lifecycle.disposes, 0); assert.equal(lifecycle.opens, 0)
})

for (const afterCommit of [false, true]) test(`settings write failure preserves unknown outcome and same-command recovery: committed=${afterCommit}`, async t => {
  const { service, storage } = await fixture(t), internal = service as any
  const owner = internal.running.get('local'), set = storage.set.bind(storage)
  let fail = true
  storage.set = async (key, value) => {
    if (key === 'framework-settings/local' && fail) {
      fail = false; if (afterCommit) await set(key, value)
      throw new Error('settings acknowledgement unavailable')
    }
    await set(key, value)
  }
  await assert.rejects(service.foregroundModel(change()), /acknowledgement unavailable/)
  assert.equal(owner.runtime.model, undefined)
  assert.equal(internal.saved.get('local').revision, 'local-settings')
  const result = await service.foregroundModel(change())
  assert.deepEqual(result.settings.foreground, route)
  assert.deepEqual(owner.runtime.model, route)
})

test('unconfirmed command cannot overwrite a newer external settings revision', async t => {
  const { service, storage } = await fixture(t), set = storage.set.bind(storage)
  let fail = true
  storage.set = async (key, value) => { if (key === 'framework-settings/local' && fail) { fail = false; throw new Error('before write') }; await set(key, value) }
  await assert.rejects(service.foregroundModel(change()), /before write/)
  await set('framework-settings/local', { revision: 'external', settings: { ...settings, foreground: { provider: 'external', model: 'retain' } } })
  await assert.rejects(service.foregroundModel(change()), /Settings changed/)
  assert.equal((await storage.get<any>('framework-settings/local')).settings.foreground.model, 'retain')
})

test('confirmation acknowledgement loss does not replay a model change over a later successful selection', async t => {
  const { service, storage } = await fixture(t), set = storage.set.bind(storage)
  let fail = true
  storage.set = async (key, value: any) => {
    await set(key, value)
    if (key.startsWith('framework-settings-commands/') && value.confirmed && fail) { fail = false; throw new Error('confirmation ack lost') }
  }
  await assert.rejects(service.foregroundModel(change()), /confirmation ack lost/)
  const current = await service.view({ mode: 'local' })
  const later = await service.foregroundModel({ ...change(current.revision, 'after-ack'), model: undefined })
  const replay = await service.foregroundModel(change())
  assert.equal(replay.revision, later.revision); assert.equal(replay.settings.foreground, undefined)
})

test('queued scope switch wins before model update and rejects stale storageScope without touching its owner', async t => {
  const { service } = await fixture(t), internal = service as any
  const gate = Promise.withResolvers<void>()
  internal.configuration = gate.promise.then(async () => {
    internal.saved.set('local', { revision: 'new-scope', settings: { ...settings, localDirectory: '/different' } })
    const access = await internal.accesses.get('local'); access.connection.scope = 'different'
  })
  const result = service.foregroundModel(change())
  gate.resolve(); await assert.rejects(result, /scope/i)
  assert.equal(internal.saved.get('local').revision, 'new-scope')
})

test('other Git instance flag includes primary and same account, but never Local or this UUID', async t => {
  const { service } = await fixture(t), internal = service as any
  const access = await internal.access('git'), active = internal.running.get('git')
  active.resources = [{ instanceUUID: access.connection.identity.instanceUUID, primary: true, member: 'Owner', availability: 'online', workerSeats: 1 }]
  assert.equal((await service.view({ mode: 'git' })).hasOtherInstanceRecords, false)
  active.resources.push({ ...active.resources[0], instanceUUID: 'same-account-other-instance' })
  assert.equal((await service.view({ mode: 'git' })).hasOtherInstanceRecords, true)
  active.resources[1].member = 'Owner-2'
  assert.equal((await service.view({ mode: 'git' })).hasOtherInstanceRecords, true, 'technical name suffix is not identity')
  assert.equal((await service.view({ mode: 'git' })).resources.length, 0, 'primary-only roster still has another instance despite empty display resources')
  assert.equal((await service.view({ mode: 'local' })).hasOtherInstanceRecords, false)
})

test('in-flight real Local opening adopts the newly saved foreground route before publishing without restarting its owner', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dss-model-opening-')), values = new Map<string, unknown>()
  const port: StoragePort = { get: async key => structuredClone(values.get(key)) as never,
    set: async (key, value) => { values.set(key, structuredClone(value)) },
    list: async prefix => [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })) as never }
  const chosen = { ...settings, localDirectory: root, background: { provider: 'background', model: 'retain' } }
  const service = new FrameworkService({ workspaceRegistry: { create: async (path: string) => ({ id: 'workspace', path }) } } as any, port, chosen), internal = service as any
  internal.saved.set('local', { revision: 'loaded', settings: chosen })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const { FrameworkRoleRuntime } = await import('../src/framework/role-runtime.js')
  let runtime: any, starts = 0
  t.mock.method(FrameworkRoleRuntime.prototype, 'start', async function (this: Runtime) { runtime = this; starts++; entered.resolve(); await release.promise })
  const opening = internal.connect('local')
  try {
    await entered.promise
    const before = await service.view({ mode: 'local' })
    assert.equal(runtime.config.foreground, undefined)
    await service.foregroundModel({ ...change('loaded', 'opening-model'), storageScope: before.storageScope })
    release.resolve(); const owner = await opening
    assert.equal(owner.runtime, runtime); assert.equal(starts, 1)
    assert.deepEqual(runtime.config.foreground, route); assert.deepEqual(runtime.config.background, chosen.background)
  } finally { release.resolve(); await opening.catch(() => {}); await service.dispose(); await rm(root, { recursive: true, force: true }) }
})

test('concurrent choices with the same revision serialize: second must reread rather than silently replace first', async t => {
  const { service } = await fixture(t)
  const results = await Promise.allSettled([service.foregroundModel(change()), service.foregroundModel({ ...change('local-settings', 'competing'), model: undefined })])
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected')
  assert.deepEqual((await service.view({ mode: 'local' })).settings.foreground, route)
})

test('queued model edit cannot revive after owned service disposal', async t => {
  const { service, storage } = await fixture(t), internal = service as any, gate = Promise.withResolvers<void>()
  internal.configuration = gate.promise
  const result = service.foregroundModel(change()).then(() => false, () => true)
  const disposing = service.dispose()
  gate.resolve(); assert.equal(await result, true); await disposing
  assert.equal(await storage.get('framework-settings/local'), undefined)
})


test('readback mismatch does not acknowledge or update the native route', async t => {
  const { service, storage } = await fixture(t), internal = service as any, get = storage.get.bind(storage)
  let reads = 0
  storage.get = async <T>(key: string) => {
    if (key === 'framework-settings/local' && ++reads === 2) return { revision: 'racing-revision', settings } as T
    return get<T>(key)
  }
  await assert.rejects(service.foregroundModel(change()), /readback/)
  assert.equal(internal.saved.get('local').revision, 'local-settings')
  assert.equal(internal.running.get('local').runtime.model, undefined)
  const replay = await service.foregroundModel(change())
  assert.deepEqual(replay.settings.foreground, route)
})

test('valid superseding configure cancels an older pending model edit without reviving it or stopping unchanged background', async t => {
  const { service, lifecycle } = await fixture(t)
  const saved = service.foregroundModel(change())
  const configured = service.configure({ mode: 'local', commandId: 'stale-full-configuration', expectedRevision: 'local-settings', settings: { ...settings, name: 'New name' } })
  await assert.rejects(saved, error => error instanceof Error && error.name === 'AbortError')
  const result = await configured
  assert.equal(result.settings.name, 'New name'); assert.equal(result.settings.foreground, undefined)
  assert.equal(lifecycle.disposes, 0); assert.equal(lifecycle.opens, 0)
})


test('foreground model setting and its response perform zero repository reads, including unconfigured Git', async t => {
  const { service, gitSeam, storage } = await fixture(t), internal = service as any
  let snapshots = 0
  gitSeam.snapshot = async () => { snapshots++; throw new Error('model setting must not read repository') }
  const access = internal.access.bind(internal)
  internal.access = async (mode: string) => { assert.notEqual(mode, 'git', 'model setting cannot open Git access'); return access(mode) }
  const first = await service.foregroundModel({ mode: 'git', storageScope: 'git', expectedRevision: 'git-settings', commandId: 'known-git-model', model: route })
  assert.deepEqual(first.settings.foreground, route); assert.equal(snapshots, 0)
  internal.running.delete('git'); internal.accesses.delete('git')
  internal.saved.set('git', { revision: 'unconfigured', settings: { ...settings, ownerRepo: '' } })
  await storage.set('framework-settings/git', internal.saved.get('git'))
  const pure = await service.foregroundModel({ mode: 'git', expectedRevision: 'unconfigured', commandId: 'unconfigured-model', model: route })
  assert.deepEqual(pure.settings.foreground, route); assert.equal(snapshots, 0)
})
