import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FrameworkService } from '../src/framework/service.js'
import { FrameworkRoleRuntime } from '../src/framework/role-runtime.js'
import type { StoragePort } from '../src/contracts/ports.js'
import type { FrameworkClientSettings } from '../src/framework/client-contracts.js'
import { FilesOutcomeUnknownError } from '../src/framework/transactions.js'
import { CoopCredentials } from '../src/experimental/private-git/credentials.js'

async function fixture(t: test.TestContext, ownerRepo = 'Owner/repo') {
  t.mock.method(CoopCredentials.prototype, 'resolve', async () => { throw new Error('Synthetic Git credentials unavailable; no real CLI or network in this fixture') })
  const root = await mkdtemp(join(tmpdir(), 'dss-managed-start-')), values = new Map<string, unknown>()
  const storage: StoragePort = { get: async key => structuredClone(values.get(key)) as never,
    set: async (key, value) => { values.set(key, structuredClone(value)) },
    list: async prefix => [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })) as never }
  const settings: FrameworkClientSettings = { name: 'DSS', userName: 'User', localDirectory: join(root, 'records'), ownerRepo, repositoryDirectory: '', collaborationId: 'team', workerSeats: 1, workspace: root }
  for (const mode of ['local', 'git']) { values.set('framework-settings/' + mode, { revision: mode + '-settings', settings }); values.set('framework-participation/' + mode, true) }
  values.set('framework-git-operations/retained', { operationId: 'retained-migration', expectedHead: 'original-immutable-head', writes: [{ path: 'technical/legacy-record', sha: 'original-sha' }] })
  const service = new FrameworkService({ workspaceRegistry: { create: async (path: string) => ({ id: 'workspace', path }) } } as any, storage, settings), internal = service as any
  t.mock.method(FrameworkRoleRuntime.prototype, 'start', async () => {})
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }) })
  return { service, internal, storage, values }
}

test('registration initialization returns while Git migration remains owned; Local can send and Git view is pure starting state', async t => {
  const { service, internal, values } = await fixture(t), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const originalOpen = internal.open.bind(internal), originalAccess = internal.access.bind(internal)
  let gitAccesses = 0
  internal.access = (mode: string) => { if (mode === 'git') { gitAccesses++; throw new Error('starting view must not acquire Git storage') }; return originalAccess(mode) }
  internal.open = async (mode: string, signal: AbortSignal) => { if (mode !== 'git') return originalOpen(mode, signal); entered.resolve(); await release.promise; throw new FilesOutcomeUnknownError('retained-migration') }
  try {
    await service.initialize(); await entered.promise
    const view = await service.view({ mode: 'git' })
    assert.equal(view.connection.status, 'starting'); assert.equal(view.connection.participating, false); assert.equal(gitAccesses, 0)
    await assert.rejects(service.send({ mode: 'git', collaborationId: 'team', id: 'git-not-saved', createdAt: '2026-11-01T11:00:00Z', text: 'not yet saved', recipient: 'human', device: 'synthetic', timezoneOffsetMinutes: 0 }), /still initializing; this operation has not been applied/)
    assert.equal(gitAccesses, 0, 'unready send must not acquire a conversation or append a message')
    const model = await service.foregroundModel({ mode: 'git', expectedRevision: view.revision, commandId: 'model-while-git-starting', model: { provider: 'p', model: 'm' } })
    assert.deepEqual(model.settings.foreground, { provider: 'p', model: 'm' })
    assert.equal(gitAccesses, 0, 'pure settings remain independent of held Git migration')
    await internal.modeStarting.get('local')
    const local = await service.view({ mode: 'local' })
    await service.send({ mode: 'local', storageScope: local.storageScope, collaborationId: 'team', id: 'local-during-git', createdAt: '2026-11-01T11:00:00Z', text: 'Local remains usable', recipient: 'human', device: 'synthetic', timezoneOffsetMinutes: 0 })
    assert.equal((await service.view({ mode: 'local' })).messages[0].id, 'local-during-git')
    assert.equal(internal.running.has('git'), false)
    release.resolve(); await service.start()
    const failed = await service.view({ mode: 'git' })
    assert.equal(failed.connection.status, 'failed'); assert.match(failed.connection.detail ?? '', /uncertain/); assert.equal(gitAccesses, 0)
    assert.deepEqual(values.get('framework-git-operations/retained'), { operationId: 'retained-migration', expectedHead: 'original-immutable-head', writes: [{ path: 'technical/legacy-record', sha: 'original-sha' }] })
  } finally { release.resolve() }
})

test('explicit start still awaits actual completion while initialize never declares Git business ready', async t => {
  const { service, internal } = await fixture(t), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const open = internal.open.bind(internal)
  internal.open = async (mode: string, signal: AbortSignal) => { if (mode !== 'git') return open(mode, signal); entered.resolve(); await release.promise; throw new Error('migration unavailable') }
  let completed = false
  const starting = service.start().then(() => { completed = true })
  try { await entered.promise; await service.initialize(); assert.equal(completed, false); assert.equal(internal.running.has('git'), false) }
  finally { release.resolve(); await starting }
})

test('dispose cancels an owned Git startup and drains its cleanup before returning without late publication', async t => {
  const { service, internal } = await fixture(t), entered = Promise.withResolvers<void>(), aborted = Promise.withResolvers<void>(), cleanup = Promise.withResolvers<void>()
  const open = internal.open.bind(internal)
  internal.open = async (mode: string, signal: AbortSignal) => {
    if (mode !== 'git') return open(mode, signal)
    entered.resolve()
    await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }) })
    aborted.resolve(); await cleanup.promise; throw signal.reason
  }
  await service.initialize(); await entered.promise
  let disposed = false; const disposal = service.dispose().then(() => { disposed = true })
  try { await aborted.promise; assert.equal(disposed, false); assert.equal(internal.running.has('git'), false) }
  finally { cleanup.resolve(); await disposal }
  assert.equal(internal.running.size, 0)
})

test('queued Git startup withdrawn before opening cannot resurrect its prior participation intent', async t => {
  const { service, internal, storage } = await fixture(t), preparation = Promise.withResolvers<void>()
  internal.resumeStartupMove = () => preparation.promise
  const open = internal.open.bind(internal); let gitOpened = 0
  internal.open = (mode: string, signal: AbortSignal) => { if (mode === 'git') { gitOpened++; throw new Error('withdrawn startup opened') }; return open(mode, signal) }
  await service.initialize()
  const withdraw = service.participation({ mode: 'git', enabled: false })
  try { await withdraw; preparation.resolve(); await service.start(); assert.equal(gitOpened, 0); assert.equal(await storage.get('framework-participation/git'), false) }
  finally { preparation.resolve() }
})

test('unconfigured Git never acquires repository access during initialization or its status view', async t => {
  const { service, internal } = await fixture(t, ''), open = internal.open.bind(internal), access = internal.access.bind(internal)
  internal.open = (mode: string, signal: AbortSignal) => { assert.notEqual(mode, 'git'); return open(mode, signal) }
  internal.access = (mode: string) => { assert.notEqual(mode, 'git'); return access(mode) }
  await service.initialize(); await service.start()
  const view = await service.view({ mode: 'git' })
  assert.equal(view.connection.status, 'unconfigured'); assert.equal(view.connection.participating, false)
})

test('failed owned Git startup is visible and explicit retry keeps the existing operation identity', async t => {
  const { service, internal, values } = await fixture(t), open = internal.open.bind(internal), operations: string[] = []
  internal.open = async (mode: string, signal: AbortSignal) => {
    if (mode !== 'git') return open(mode, signal)
    operations.push((values.get('framework-git-operations/retained') as { operationId: string }).operationId)
    throw new FilesOutcomeUnknownError('retained-migration')
  }
  await service.start(); assert.equal((await service.view({ mode: 'git' })).connection.status, 'failed')
  await assert.rejects(service.participation({ mode: 'git', enabled: true }), /uncertain/)
  assert.deepEqual(operations, ['retained-migration', 'retained-migration'])
  assert.equal(internal.running.has('git'), false)
})

test('superseded queued bootstrap cannot erase the newer explicit connection state or reopen its old intent', async t => {
  const { service, internal, storage } = await fixture(t), preparation = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  internal.resumeStartupMove = () => preparation.promise
  const open = internal.open.bind(internal); let attempts = 0
  internal.open = async (mode: string, signal: AbortSignal) => {
    if (mode !== 'git') return open(mode, signal)
    attempts++; entered.resolve(); await release.promise; throw new FilesOutcomeUnknownError('retained-migration')
  }
  await service.initialize()
  const previous = await storage.get<any>('framework-settings/git')
  const configuring = service.configure({ mode: 'git', expectedRevision: previous.revision, commandId: 'explicit-new-owner', settings: { ...previous.settings, name: 'New name' } }).then(() => false, () => true)
  try {
    await entered.promise; preparation.resolve(); await internal.modeStarting.get('git')
    const view = await service.view({ mode: 'git' })
    assert.equal(view.connection.status, 'starting'); assert.equal(attempts, 1)
    release.resolve(); assert.equal(await configuring, true)
    assert.equal((await service.view({ mode: 'git' })).connection.status, 'failed')
  } finally { preparation.resolve(); release.resolve(); await configuring }
})


test('published replacement serves Local send while its cancelled queued bootstrap remains owned for drain', async t => {
  const { service, internal, storage } = await fixture(t), preparation = Promise.withResolvers<void>()
  await storage.set('framework-participation/git', false)
  internal.resumeStartupMove = () => preparation.promise
  const originalOpen = internal.open.bind(internal); let opens = 0
  internal.open = (mode: string, signal: AbortSignal) => { if (mode === 'local') opens++; return originalOpen(mode, signal) }
  await service.initialize()
  const previous = await storage.get<any>('framework-settings/local')
  try {
    const view = await service.configure({ mode: 'local', expectedRevision: previous.revision, commandId: 'replacement-local', settings: { ...previous.settings, name: 'Replacement' } })
    assert.equal(view.connection.participating, true)
    await service.send({ mode: 'local', storageScope: view.storageScope, collaborationId: 'team', id: 'after-replacement', createdAt: '2026-11-01T11:00:00Z', text: 'new owner', recipient: 'human', device: 'synthetic', timezoneOffsetMinutes: 0 })
    assert.equal((await service.view({ mode: 'local' })).messages[0].id, 'after-replacement')
    const active = internal.running.get('local')
    const moving = new Error('unconfirmed physical relocation')
    internal.recordMoving = moving
    await assert.rejects(internal.modeReady('local'), error => error === moving)
    internal.recordMoving = undefined
    preparation.resolve(); await service.start()
    assert.equal(opens, 1); assert.equal(internal.running.get('local'), active)
  } finally { internal.recordMoving = undefined; preparation.resolve(); await service.start() }
})

test('failed replacement is visible immediately and cannot inherit readiness from cancelled startup', async t => {
  const { service, internal, storage } = await fixture(t), preparation = Promise.withResolvers<void>()
  await storage.set('framework-participation/git', false)
  internal.resumeStartupMove = () => preparation.promise
  internal.open = async () => { throw new Error('replacement failed before publication') }
  await service.initialize()
  const previous = await storage.get<any>('framework-settings/local')
  try {
    await assert.rejects(service.configure({ mode: 'local', expectedRevision: previous.revision, commandId: 'failed-replacement', settings: { ...previous.settings, name: 'Replacement' } }), /replacement failed/)
    assert.equal(internal.running.has('local'), false)
    await assert.rejects(internal.modeReady('local'), /replacement failed/)
    const view = await service.view({ mode: 'local' })
    assert.equal(view.connection.status, 'failed'); assert.match(view.connection.detail ?? '', /replacement failed/)
  } finally { preparation.resolve(); await service.start() }
})

test('header-only view publishes actual inactive Git settings while full Git contents wait, allowing Local selection', async t => {
  const { service, internal, storage } = await fixture(t)
  await storage.set('framework-active-mode', 'git'); await storage.set('framework-participation/git', false)
  await service.start()
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), access = internal.access.bind(internal)
  let gitReads = 0
  internal.access = async (mode: string) => { if (mode !== 'git') return access(mode); gitReads++; entered.resolve(); await release.promise; throw new Error('held Git content fixture released') }
  let fullDone = false, headerDone = false
  const full = service.view().then(value => { fullDone = true; return value })
  await entered.promise
  const header = service.view({ headerOnly: true }).then(value => { headerDone = true; return value })
  try {
    await new Promise(resolve => setImmediate(resolve))
    const headerBeforeRelease = headerDone, readsBeforeRelease = gitReads
    if (!headerBeforeRelease) release.resolve() // Original implementation can unwind without a timeout.
    const shell = await header
    assert.equal(shell.activeMode, 'git'); assert.equal(shell.settings.ownerRepo, 'Owner/repo')
    assert.equal(shell.revision, 'git-settings'); assert.equal(shell.connection.participating, false)
    assert.equal(headerBeforeRelease, true, 'header-only request entered the held Git content read')
    assert.equal(shell.connection.status, 'disconnected'); assert.equal(shell.storageScope, undefined)
    assert.equal(readsBeforeRelease, 1, 'header must not create another Git access')
    assert.equal(fullDone, false, 'default full view must retain its actual content wait')
    const local = await service.selectMode({ mode: 'local' })
    assert.equal(local.activeMode, 'local'); assert.equal(local.connection.participating, true)
    const localHeader = await service.view({ mode: 'local', headerOnly: true })
    assert.equal(localHeader.storageScope, internal.running.get('local').connection.scope)
  } finally { release.resolve(); await Promise.allSettled([full, header]) }
})


test('header-only state uses loaded settings and owned startup/error/move facts without acquiring storage', async t => {
  const { service, internal, storage } = await fixture(t)
  await assert.rejects(service.view({ headerOnly: true }), /settings are not loaded/)
  await storage.set('framework-participation/git', false)
  await service.start()
  internal.access = () => { throw new Error('header must never acquire storage') }
  internal.startupState.set('git', { status: 'starting', owner: {} })
  assert.equal((await service.view({ mode: 'git', headerOnly: true })).connection.status, 'starting')
  internal.startupState.set('git', { status: 'failed', owner: {} }); internal.errors.set('git', 'actual retained migration error')
  const failed = await service.view({ mode: 'git', headerOnly: true })
  assert.equal(failed.connection.status, 'failed'); assert.equal(failed.connection.detail, 'actual retained migration error'); assert.equal(failed.connection.participating, false)
  internal.pendingRecordMove = { scope: 'retained-original-scope', commandId: 'move', settingsBefore: { revision: 'old-revision' }, targetRecords: '/retained-target' }
  const local = await service.view({ mode: 'local', headerOnly: true })
  assert.deepEqual(local.pendingRecordMove, { storageScope: 'retained-original-scope', commandId: 'move', expectedRevision: 'old-revision', directory: '/retained-target' })
  await service.dispose()
  await assert.rejects(service.view({ headerOnly: true }), /disposed/)
})

test('warm mode navigation publishes Git header before held contents and permits immediate Local navigation', async t => {
  const { service, internal, storage } = await fixture(t)
  await storage.set('framework-participation/git', false); await service.start()
  assert.equal((await service.view({ mode: 'local' })).activeMode, 'local')
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), access = internal.access.bind(internal)
  let gitReads = 0
  internal.access = async (mode: string) => { if (mode !== 'git') return access(mode); gitReads++; entered.resolve(); await release.promise; throw new Error('controlled Git content pause') }
  let selected = false
  const selection = service.selectMode({ mode: 'git', headerOnly: true }).then(value => { selected = true; return value })
  try {
    await new Promise(resolve => setImmediate(resolve)); const beforeRelease = selected
    if (!beforeRelease) release.resolve()
    const header = await selection
    assert.equal(beforeRelease, true, 'warm selection awaited Git content instead of publishing header')
    assert.equal(header.activeMode, 'git'); assert.equal(header.revision, 'git-settings'); assert.equal(gitReads, 1, 'selection starts the requested asynchronous preparation without waiting for it')
    const full = service.view({ mode: 'git' }); await entered.promise
    const local = await service.selectMode({ mode: 'local', headerOnly: true })
    assert.equal(local.activeMode, 'local'); assert.equal(await storage.get('framework-active-mode'), 'local')
    release.resolve(); assert.equal((await full).activeMode, 'git', 'old full response retains its requested mode')
  } finally { release.resolve(); await selection }
})

test('mode selection response retains its captured mode when a later navigation finishes during persistence acknowledgement', async t => {
  const { service, internal, storage } = await fixture(t)
  await storage.set('framework-participation/git', false); await service.start()
  const savedGit = Promise.withResolvers<void>(), releaseAck = Promise.withResolvers<void>(), set = storage.set.bind(storage), access = internal.access.bind(internal)
  storage.set = async (key, value) => { await set(key, value); if (key === 'framework-active-mode' && value === 'git') { savedGit.resolve(); await releaseAck.promise } }
  internal.access = (mode: string) => mode === 'git' ? Promise.reject(new Error('controlled Git unavailable')) : access(mode)
  const older = service.selectMode({ mode: 'git' })
  try {
    await savedGit.promise
    assert.equal((await service.selectMode({ mode: 'local', headerOnly: true })).activeMode, 'local')
    releaseAck.resolve()
    assert.equal((await older).activeMode, 'git', 'later navigation must not rewrite the older response identity')
    assert.equal(await storage.get('framework-active-mode'), 'local')
  } finally { releaseAck.resolve(); await older }
})

for (const active of ['git', 'local'] as const) test('saved enabled Git prewarms on every startup without joining or delaying Local: ' + active, async t => {
  const { service, internal, storage } = await fixture(t), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  await storage.set('framework-active-mode', active); await storage.set('framework-git-enabled', true); await storage.set('framework-participation/git', false)
  let probes = 0, closed = 0
  const connection = { scope: 'warm-scope', prepareWrite: async (options: unknown) => { probes++; assert.deepEqual(options, { initialize: false }); entered.resolve(); await release.promise },
    cancelPending: () => release.resolve(), close: async () => { closed++ } }
  const access = internal.access.bind(internal)
  internal.access = (mode: string) => {
    if (mode !== 'git') return access(mode)
    if (!internal.accesses.has(mode)) internal.accesses.set(mode, Promise.resolve({ connection }))
    return internal.accesses.get(mode)
  }
  await service.initialize(); await entered.promise; await service.start()
  const header = await service.view({ mode: 'git', headerOnly: true })
  assert.equal(header.activeMode, 'git'); assert.equal(header.connection.participating, false)
  assert.equal(internal.running.has('git'), false); assert.equal(await storage.get('framework-participation/git'), false)
  await service.selectMode({ mode: 'git', headerOnly: true }); assert.equal(probes, 1, 'selection shares startup preparation')
  const local = await service.selectMode({ mode: 'local', headerOnly: true })
  await service.send({ mode: 'local', storageScope: local.storageScope, collaborationId: 'team', id: 'while-warming', createdAt: '2026-11-01T11:00:00Z', text: 'Local remains writable', recipient: 'human', device: 'test', timezoneOffsetMinutes: 0 })
  assert.equal((await service.view({ mode: 'local' })).messages[0].id, 'while-warming')
  await service.dispose(); assert.equal(closed, 1); assert.equal(internal.running.size, 0)
})

test('opening Git starts read-only preparation immediately while the real header remains usable', async t => {
  const { service, internal, storage } = await fixture(t), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  await storage.set('framework-participation/git', false)
  const access = internal.access.bind(internal); let probes = 0
  const connection = { scope: 'warm-scope', prepareWrite: async () => { probes++; entered.resolve(); await release.promise }, cancelPending: () => release.resolve(), close: async () => {} }
  internal.access = (mode: string) => { if (mode !== 'git') return access(mode); const pending = internal.accesses.get(mode) ?? Promise.resolve({ connection }); internal.accesses.set(mode, pending); return pending }
  await service.start(); assert.equal(probes, 0)
  const header = await service.selectMode({ mode: 'git', headerOnly: true }); await entered.promise
  assert.equal(header.settings.ownerRepo, 'Owner/repo'); assert.equal(header.connection.participating, false)
  assert.equal((await service.selectMode({ mode: 'local', headerOnly: true })).activeMode, 'local')
  await service.dispose()
})

test('preparation failure is visible after acquisition removes itself and never schedules its own retry', async t => {
  const { service, internal, storage } = await fixture(t)
  await storage.set('framework-participation/git', false)
  await service.start()
  const access = internal.access.bind(internal); let attempts = 0
  internal.access = (mode: string) => {
    if (mode !== 'git') return access(mode)
    attempts++
    const pending = Promise.reject(new Error('HTTP 403 Access revoked'))
    internal.accesses.set(mode, pending)
    void pending.catch(() => internal.accesses.delete(mode))
    return pending
  }
  await service.selectMode({ mode: 'git', headerOnly: true }); await Promise.all([...internal.writePreparations])
  assert.match((await service.view({ mode: 'git', headerOnly: true })).connection.detail ?? '', /403 Access revoked/)
  await new Promise(resolve => setImmediate(resolve)); assert.equal(attempts, 1)
})

test('replaced scope cannot publish an old preparation error into the new settings', async t => {
  const { service, internal, storage } = await fixture(t), release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  await storage.set('framework-participation/git', false); await service.start()
  const original = internal.access.bind(internal)
  const oldConnection = { prepareWrite: async () => { entered.resolve(); await release.promise; throw new Error('old scope failure') }, cancelPending: () => release.resolve(), close: async () => {} }
  internal.access = (mode: string) => { if (mode !== 'git') return original(mode); const pending = internal.accesses.get(mode) ?? Promise.resolve({ connection: oldConnection }); internal.accesses.set(mode, pending); return pending }
  await service.selectMode({ mode: 'git', headerOnly: true }); await entered.promise
  const old = internal.saved.get('git')
  await internal.persistSettings('git', { revision: 'replacement', settings: { ...old.settings, repositoryDirectory: 'another-scope' } })
  internal.accesses.delete('git')
  release.resolve(); await Promise.all([...internal.writePreparations])
  assert.equal((await service.view({ mode: 'git', headerOnly: true })).connection.detail, undefined)
})
