import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { FrameworkService } from '../src/framework/service.js'
import { FrameworkConversation } from '../src/framework/conversation.js'
import { openFrameworkStorage } from '../src/framework/connection.js'
import { LocalFiles } from '../src/framework/local-files.js'
import { FrameworkTransactions } from '../src/framework/command-transactions.js'
import { LocalLocationRegistry, LocalLocationMovedError } from '../src/framework/local-location.js'
import { withSnapshot } from '../src/framework/transactions.js'
import { recordMoveKey, type RecordMovePhysicalStore, type RecordMoveReceipt } from '../src/framework/record-move.js'
import type { StoragePort } from '../src/contracts/ports.js'
import { MemoryStorage } from './support.js'

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000
  while (!check()) { assert.ok(Date.now() < deadline, 'Owned physical copy did not start within the test deadline'); await new Promise(resolve => setImmediate(resolve)) }
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
// Real Local SQLite and physical filesystem copy/locator seam. Native stop and
// background registration are controlled explicitly; no Host/Git simulation claim.
async function fixture(t: test.TestContext, gitEnabled = true) {
  const root = await mkdtemp(join(tmpdir(), 'dss-move-service-')), source = join(root, 'source'), target = join(root, 'target'), localDirectory = join(source, 'deepseek_servant', 'framework')
  await mkdir(join(source, 'deepseek_servant'), { recursive: true })
  await writeFile(join(source, 'deepseek_servant', 'synthetic-native-record.json'), JSON.stringify({ operationId: 'stable-op', sessionId: 'stable-session', original: '技术记录🙂' }))
  const port = new MemoryStorage() as MemoryStorage & RecordMovePhysicalStore
  let activeRoot = source, copies = 0, failReopen = false, unconfirmed = false
  const calls: string[] = [], physicalGate = deferred(); let gateCopy = false
  port.storageView = () => ({ directory: activeRoot })
  port.moveRecords = async (destination, expected, signal, verify) => {
    signal.throwIfAborted(); assert.equal(expected, activeRoot); calls.push('physical-copy'); copies++
    if (gateCopy) await physicalGate.promise
    signal.throwIfAborted()
    await mkdir(destination, { recursive: true }); await cp(join(activeRoot, 'deepseek_servant'), join(destination, 'deepseek_servant'), { recursive: true, force: false, errorOnExist: true })
    await verify?.(destination); activeRoot = destination; return { directory: destination }
  }
  const settings = { name: 'DeepSeek Servant', userName: 'alice', localDirectory, ownerRepo: gitEnabled ? 'synthetic/repo' : '', repositoryDirectory: '', collaborationId: 'team', workerSeats: 1, workspace: root }
  const service = new FrameworkService({ get: () => undefined } as any, port, settings), internal = service as any
  for (const mode of ['local', 'git']) { const saved = { revision: mode + '-original', settings: { ...settings } }; internal.saved.set(mode, saved); await port.set('framework-settings/' + mode, saved); await port.set('framework-participation/' + mode, mode === 'local' || gitEnabled) }
  const access = await openFrameworkStorage({ mode: 'local', directory: localDirectory, login: 'alice', workerSeats: 1 }, { storage: port })
  const conversation = new FrameworkConversation(access.files, access.transactions, { mode: 'local', collaborationId: 'team' })
  internal.accesses.set('local', Promise.resolve({ connection: access, conversation }))
  const originalScope = access.scope
  const runtimes = new Map<string, any>(), allConnections = [access]
  const makeRuntime = (mode: string, generation: number) => {
    const runtime = { generation, settleCalls: 0, disposeCalls: 0, async settleForStorageMove() { calls.push('settle-' + mode + '-' + generation); this.settleCalls++; if (mode === 'local' && unconfirmed) throw new Error('actual stop evidence remains unconfirmed') }, async dispose() { this.disposeCalls++ }, executionViews: () => [] }
    runtimes.set(mode + generation, runtime); return runtime
  }
  const running = (mode: string, connection: any, generation: number) => ({ connection: { ...connection, registration: { member: mode, workerSeats: 1 }, close: async () => { calls.push('background-close-' + mode); await connection.close() } }, runtime: makeRuntime(mode, generation), resources: [] })
  internal.running.set('local', running('local', access, 1))
  if (gitEnabled) {
    const gitFiles = await LocalFiles.open(join(root, 'git-seam'))
    const gitConnection = { files: gitFiles, transactions: new FrameworkTransactions(gitFiles, port, 'git-seam'), scope: 'git-scope', identity: { login: 'alice', owner: 'alice', repositoryId: 'git-seam', instanceUUID: 'git-instance' }, cancelPending() {}, close: async () => { await gitFiles.close() } }
    internal.accesses.set('git', Promise.resolve({ connection: gitConnection, conversation: new FrameworkConversation(gitFiles, gitConnection.transactions, { mode: 'git', collaborationId: 'team' }) }))
    internal.running.set('git', running('git', gitConnection, 1))
  }
  // Actual service move lifecycle calls this registration seam only after publish.
  internal.connect = async (mode: string, signal?: AbortSignal) => {
    signal?.throwIfAborted(); internal.assertOpen(); if (internal.running.has(mode)) return internal.running.get(mode)
    calls.push('reopen-' + mode)
    if (mode === 'git' && failReopen) { failReopen = false; throw new Error('synthetic second-mode reopen failure') }
    const connection = mode === 'local' ? await internal.access('local').then((row: any) => row.connection) : { close: async () => {}, registration: { member: 'git', workerSeats: 1 } }
    if (mode === 'local') allConnections.push(connection)
    const result = running(mode, connection, 2); internal.running.set(mode, result); return result
  }
  const message = { mode: 'local' as const, collaborationId: 'team', storageScope: originalScope, id: 'retained-message', createdAt: '2026-11-01T00:00:00Z', text: 'Original body\n  exact 🙂', recipient: 'human' as const, device: 'test', timezoneOffsetMinutes: 330 }
  await service.send(message)
  await withSnapshot(access.files, s => access.files.commit(s, [{ path: 'technical/synthetic-preserved.json', content: JSON.stringify({ operationId: 'stable-operation', nativeSession: 'original-session' }) }], 'synthetic retained technical record'))
  const request = { mode: 'local' as const, storageScope: originalScope, expectedRevision: 'local-original', commandId: 'move-once', directory: target }
  t.after(async () => { physicalGate.resolve(); await service.dispose(); for (const connection of allConnections) await connection.close(); await rm(root, { recursive: true, force: true }) })
  return { service, internal, port, source, target, localDirectory, originalScope, message, request, calls, runtimes, active: () => activeRoot, copies: () => copies, unknown: (value: boolean) => { unconfirmed = value }, failReopen: () => { failReopen = true }, holdCopy: () => { gateCopy = true }, releaseCopy: physicalGate.resolve }
}

test('service relocation retains original scope, full message retry identity and records while closing/reopening both participants', async t => {
  const f = await fixture(t), result = await f.service.moveRecords(f.request)
  assert.equal(result.storageScope, f.originalScope); assert.equal(f.active(), f.target); assert.equal(f.copies(), 1)
  for (const mode of ['local', 'git']) { assert.equal(f.runtimes.get(mode + '1').settleCalls, 1); assert.equal(f.runtimes.get(mode + '2').settleCalls, 0) }
  assert.ok(f.calls.indexOf('settle-git-1') < f.calls.indexOf('physical-copy'))
  assert.equal(result.settings.localDirectory, join(f.target, 'deepseek_servant', 'framework'))
  assert.equal((await f.service.readFile({ mode: 'local', storageScope: f.originalScope, path: 'technical/synthetic-preserved.json' })).text, JSON.stringify({ operationId: 'stable-operation', nativeSession: 'original-session' }))
  assert.equal(JSON.parse(await readFile(join(f.target, 'deepseek_servant', 'synthetic-native-record.json'), 'utf8')).operationId, 'stable-op')
  await f.service.send(f.message)
  assert.deepEqual((await f.service.history({ mode: 'local', collaborationId: 'team', storageScope: f.originalScope, limit: 20 })).messages.map(m => [m.id, m.text]), [[f.message.id, f.message.text]])
  await assert.rejects(openFrameworkStorage({ mode: 'local', directory: f.localDirectory, login: 'alice', workerSeats: 1 }, { storage: f.port }), LocalLocationMovedError)
  const counts = [...f.calls]; await f.service.moveRecords(f.request); assert.deepEqual(f.calls, counts)
})

test('unconfirmed stop keeps the original root and same-command retry rechecks the same old runtime', async t => {
  const f = await fixture(t); f.unknown(true)
  await assert.rejects(f.service.moveRecords(f.request), /unconfirmed/)
  assert.equal(f.active(), f.source); assert.equal(f.copies(), 0); assert.equal(f.runtimes.get('local1').settleCalls, 1)
  assert.equal((await f.port.get<{ receipts: RecordMoveReceipt[] }>(recordMoveKey))!.receipts[0]!.phase, 'prepared')
  f.unknown(false); await f.service.moveRecords(f.request)
  assert.equal(f.runtimes.get('local1').settleCalls, 2, 'Clearing running/access maps cannot discard unconfirmed ownership')
  assert.equal(f.active(), f.target); assert.equal(f.copies(), 1)
})

test('reopening failure replays publication without killing the successfully opened new generation', async t => {
  const f = await fixture(t); f.failReopen()
  await assert.rejects(f.service.moveRecords(f.request), /reopen failure/)
  assert.equal(f.active(), f.target); assert.equal((await f.port.get<{ receipts: RecordMoveReceipt[] }>(recordMoveKey))!.receipts[0]!.phase, 'reopening')
  const local = f.internal.running.get('local')
  await f.service.moveRecords(f.request)
  assert.equal(f.internal.running.get('local'), local); assert.equal(local.runtime.settleCalls, 0); assert.equal(local.runtime.disposeCalls, 0)
  assert.equal(f.copies(), 1); assert.equal(f.runtimes.get('local1').settleCalls, 1)
})

test('record relocation does not start a configured nonparticipating Git background', async t => {
  const f = await fixture(t)
  await f.port.set('framework-participation/git', false)
  await f.service.moveRecords(f.request)
  assert.equal(f.calls.includes('reopen-git'), false); assert.equal(f.internal.running.has('git'), false)
})

test('ordinary access cannot acquire an old scope while the explicit physical move owns it', async t => {
  const f = await fixture(t); f.holdCopy()
  const move = f.service.moveRecords(f.request)
  await until(() => f.calls.includes('physical-copy'))
  await assert.rejects(f.service.readFile({ mode: 'local', storageScope: f.originalScope, path: 'technical/synthetic-preserved.json' }), /record move owns/)
  f.releaseCopy(); await move
  assert.equal((await f.service.view({ mode: 'local' })).storageScope, f.originalScope)
})

test('service startup resumes a published move before reopening only the previously participating modes', async t => {
  const f = await fixture(t); f.failReopen()
  await assert.rejects(f.service.moveRecords(f.request), /reopen failure/)
  // Simulate process lifecycle boundary using the same durable technical store;
  // native owners here are explicit seams, not real cross-process producers.
  await f.service.dispose()
  const saved = (await f.port.get<any>('framework-settings/local'))!
  const restarted = new FrameworkService({ get: () => undefined } as any, f.port, saved.settings), internal = restarted as any
  const opened: string[] = []
  internal.connect = async (mode: string, signal?: AbortSignal) => {
    signal?.throwIfAborted(); internal.assertOpen()
    if (internal.running.has(mode)) return internal.running.get(mode)
    assert.equal(f.active(), f.target, 'Actual root publication precedes any new owner')
    assert.equal(internal.saved.get('local').settings.localDirectory, saved.settings.localDirectory)
    opened.push(mode)
    const active = { runtime: { dispose: async () => {} }, connection: { close: async () => {}, cancelPending() {} } }
    internal.running.set(mode, active); return active
  }
  t.after(() => restarted.dispose())
  await restarted.start()
  assert.deepEqual(opened, ['local', 'git'])
  assert.equal((await f.port.get<{ receipts: RecordMoveReceipt[] }>(recordMoveKey))!.receipts[0]!.phase, 'applied')
  assert.equal(f.copies(), 1)
  assert.equal(f.runtimes.get('local1').settleCalls, 1)
})

test('service disposal cancels an owned in-flight copy before target publication or replacement runtime admission', async t => {
  const f = await fixture(t); f.holdCopy()
  const moving = f.service.moveRecords(f.request)
  await until(() => f.calls.includes('physical-copy'))
  const outcome = moving.then(() => 'resolved', error => error)
  const closing = f.service.dispose()
  f.releaseCopy()
  const result = await outcome
  assert.notEqual(result, 'resolved')
  await closing
  assert.equal(f.active(), f.source)
  assert.equal(f.calls.some(call => call.startsWith('reopen-')), false)
  assert.equal(f.internal.running.size, 0)
  assert.equal((await f.port.get<{ receipts: RecordMoveReceipt[] }>(recordMoveKey))!.receipts[0]!.phase, 'prepared')
})

test('moving records with both participation intents disabled never starts either background while Local history remains accessible', async t => {
  const f = await fixture(t)
  await f.port.set('framework-participation/local', false); await f.port.set('framework-participation/git', false)
  const result = await f.service.moveRecords(f.request)
  assert.equal(result.connection.participating, false)
  assert.equal(f.calls.some(call => call.startsWith('reopen-')), false)
  assert.equal(f.internal.running.size, 0)
  assert.equal((await f.service.history({ mode: 'local', collaborationId: 'team', storageScope: f.originalScope, limit: 20 })).messages[0]!.text, f.message.text)
  assert.equal(f.internal.running.size, 0)
})

test('failed owned move exposes its durable retry identity even when access cannot expose storageScope', async t => {
  const f = await fixture(t); f.unknown(true)
  await assert.rejects(f.service.moveRecords(f.request), /unconfirmed/)
  const view = await f.service.view({ mode: 'local' })
  assert.equal(view.storageScope, undefined)
  assert.deepEqual(view.pendingRecordMove, { commandId: f.request.commandId, storageScope: f.originalScope, expectedRevision: f.request.expectedRevision, directory: f.target })
  assert.equal(view.connection.participating, false)
  assert.match(view.connection.detail!, /record move owns/)
  assert.equal(f.active(), f.source)
})

test('prepared move failure during startup remains visible and retryable without poisoning future sends', async t => {
  const f = await fixture(t, false); f.unknown(true)
  await assert.rejects(f.service.moveRecords(f.request), /unconfirmed/)
  await f.service.dispose()
  const saved = (await f.port.get<any>('framework-settings/local'))!
  const restarted = new FrameworkService({ get: () => undefined } as any, f.port, saved.settings), internal = restarted as any
  let unknown = true, stopChecks = 0, opens = 0
  // Exact old-runtime evidence seam: the first cold check cannot prove native
  // settlement; the same retained owner becomes verifiable before retry.
  const oldRuntime = { settleForStorageMove: async () => { stopChecks++; if (unknown) throw new Error('native settlement is not yet confirmed') }, dispose: async () => {} }
  internal.relocationOwners.set('local', oldRuntime)
  internal.connect = async (mode: string, signal?: AbortSignal) => {
    signal?.throwIfAborted(); assert.equal(mode, 'local'); assert.equal(f.active(), f.target)
    if (internal.running.has(mode)) return internal.running.get(mode)
    opens++
    const access = await internal.access(mode)
    const active = { connection: { ...access.connection, registration: { member: 'alice', workerSeats: 1 } }, runtime: { executionViews: () => [], dispose: async () => {} }, resources: [] }
    internal.running.set(mode, active); return active
  }
  t.after(() => restarted.dispose())
  await restarted.start()
  assert.equal(stopChecks, 1); assert.equal(opens, 0); assert.equal(f.active(), f.source)
  const pending = await restarted.view({ mode: 'local' })
  assert.equal(pending.storageScope, undefined)
  assert.deepEqual(pending.pendingRecordMove, { commandId: f.request.commandId, storageScope: f.originalScope, expectedRevision: f.request.expectedRevision, directory: f.target })
  unknown = false
  await restarted.moveRecords({ mode: 'local', ...pending.pendingRecordMove! })
  assert.equal(stopChecks, 2); assert.equal(opens, 1); assert.equal(f.active(), f.target)
  assert.equal((await restarted.view({ mode: 'local' })).pendingRecordMove, undefined)
  await restarted.send({ ...f.message, id: 'after-startup-move-retry', text: 'Actual post-retry durable message 🙂' })
  const history = await restarted.history({ mode: 'local', collaborationId: 'team', storageScope: f.originalScope, limit: 20 })
  assert.deepEqual(history.messages.map(message => message.id), ['retained-message', 'after-startup-move-retry'])
  assert.equal(history.messages[1]!.text, 'Actual post-retry durable message 🙂')
})

test('configured but never acquired or participating Git must not trigger authentication for a Local records move', async t => {
  const f = await fixture(t, false)
  const gitSaved = { revision: 'git-configured-only', settings: { ...f.internal.saved.get('git').settings, ownerRepo: 'synthetic/configured-but-never-connected' } }
  f.internal.saved.set('git', gitSaved)
  await f.port.set('framework-settings/git', gitSaved)
  assert.equal(await f.port.get('framework-participation/git'), false)
  assert.equal(f.internal.accesses.has('git'), false)
  assert.equal(f.internal.running.has('git'), false)
  assert.equal((await f.port.list<{ mode: string }>('framework-connection-settings/')).some(row => row.value.mode === 'git'), false)
  const access = f.internal.access.bind(f.internal), acquisitions: string[] = []
  f.internal.access = (mode: string) => {
    acquisitions.push(mode)
    if (mode === 'git') throw new Error('TEST: unrequested Git authentication/network access')
    return access(mode)
  }
  await f.service.moveRecords(f.request)
  assert.equal(acquisitions.includes('git'), false)
  assert.equal(f.active(), f.target)
  assert.equal((await f.service.history({ mode: 'local', collaborationId: 'team', storageScope: f.originalScope, limit: 20 })).messages[0]!.text, f.message.text)
})

for (const sameScope of [true, false]) test(`cold ${sameScope ? 'same configured' : 'different previous'} Git scope with persisted unsettled ownership cannot be silently skipped by Local move`, async t => {
  const f = await fixture(t, false)
  const current = { ...f.internal.saved.get('git'), settings: { ...f.internal.saved.get('git').settings, ownerRepo: 'synthetic/selected', repositoryDirectory: 'selected-root' } }
  f.internal.saved.set('git', current); await f.port.set('framework-settings/git', current)
  const scope = JSON.stringify(['git', 123, 'main', sameScope ? 'selected-root' : 'older-root'])
  const hash = createHash('sha256').update(scope).digest('hex')
  await f.port.set('framework-connection-settings/' + hash, { mode: 'git', ownerRepo: 'synthetic/selected', repositoryDirectory: sameScope ? 'selected-root' : 'older-root' })
  await f.port.set('framework-runtime/' + hash + '/roles/exact-old-work', { identity: { role: 'Worker', workId: 'old-work', executionId: 'old-execution', taskId: 'old-task' }, stopped: false, released: false })
  let gitAcquisitions = 0, oldChecks = 0
  const access = f.internal.access.bind(f.internal)
  const gitFiles = await LocalFiles.open(join(f.source, 'git-ownership-seam'))
  t.after(() => gitFiles.close())
  f.internal.access = async (mode: string) => {
    if (mode !== 'git') return access(mode)
    gitAcquisitions++
    assert.ok(sameScope, 'A different saved scope cannot be reconciled by authenticating the currently selected repository')
    return { connection: { scope, files: gitFiles, identity: { login: 'alice' }, cancelPending() {}, close: () => gitFiles.close() } }
  }
  if (sameScope) f.internal.relocationOwners.set('git', { settleForStorageMove: async () => { oldChecks++; throw new Error('old native Git producer remains unconfirmed') }, dispose: async () => {} })
  await assert.rejects(f.service.moveRecords(f.request), sameScope ? /producer remains unconfirmed/ : /previous Git storage scope.*unresolved/)
  assert.equal(gitAcquisitions, sameScope ? 1 : 0)
  assert.equal(oldChecks, sameScope ? 1 : 0)
  assert.equal(f.copies(), 0); assert.equal(f.active(), f.source)
  assert.equal((await f.port.get<any>('framework-runtime/' + hash + '/roles/exact-old-work'))!.stopped, false)
})

for (const scenario of ['move', 'external-change', 'invalid-readback']) test(`first-start defaults use native persisted settings for relocation: ${scenario}`, async t => {
  const externalChange = scenario === 'external-change'
  const { Context } = await import('@deepseek-ai/cordis')
  const { default: Storage } = await import('@deepseek-ai/dsh-storage')
  const StorageJson = await import('@deepseek-ai/dsh-storage-json')
  const StorageDomain = await import('@deepseek-ai/dsh-storage-domain')
  const { DshStorageAdapter } = await import('../src/adapters/dsh/storage.js')
  const root = await mkdtemp(join(tmpdir(), 'dss-first-start-move-')), ctx = new Context()
  await ctx.plugin(Storage); await ctx.plugin(StorageJson, { root: join(root, 'native') }); await ctx.plugin(StorageDomain, { backend: 'json' })
  const port = await DshStorageAdapter.open(ctx)
  const localDirectory = join(port.storageView().directory, 'deepseek_servant', 'framework')
  const defaults = { name: 'DSS', userName: 'alice', localDirectory, ownerRepo: '', repositoryDirectory: '', collaborationId: 'team', workerSeats: 1, workspace: root,
    foreground: undefined, background: { provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: undefined } }
  const service = new FrameworkService(ctx, port, defaults), internal = service as any
  let stops = 0
  // Only native execution/registration is a seam. Storage serialization, startup,
  // Local SQLite, physical relocation and settings publication are real.
  internal.connect = async (mode: string) => {
    assert.equal(mode, 'local')
    if (internal.running.has(mode)) return internal.running.get(mode)
    const access = await internal.access(mode)
    const active = { connection: { ...access.connection, registration: { member: 'alice', workerSeats: 1 } }, resources: [],
      runtime: { settleForStorageMove: async () => { stops++ }, dispose: async () => {}, executionViews: () => [] } }
    internal.running.set(mode, active); return active
  }
  t.after(async () => { await service.dispose(); await port.close(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  if (scenario === 'invalid-readback') {
    const get = port.get.bind(port)
    port.get = async <T>(key: string): Promise<T | undefined> => {
      const value = await get<any>(key)
      return key === 'framework-settings/local' && value ? { ...value, settings: { ...value.settings, userName: 'wrong-same-revision-readback' } } : value
    }
    await assert.rejects(service.start(), /settings could not be confirmed/)
    assert.equal(internal.saved.has('local'), false)
    assert.equal((await get<any>('framework-settings/local')).settings.userName, 'alice')
    assert.equal(await get(recordMoveKey), undefined)
    return
  }
  await service.start()
  const view = await service.view({ mode: 'local' }), before = await port.get<any>('framework-settings/local')
  assert.equal(Object.hasOwn(before.settings, 'foreground'), false, 'actual native adapter omits absent optional fields')
  assert.equal(Object.hasOwn(before.settings.background, 'reasoningEffort'), false, 'nested absent fields use the same native storage contract')
  const access = await internal.access('local')
  await withSnapshot(access.connection.files, s => access.connection.files.commit(s, [{ path: 'archives/kept/records.md', content: 'Exact first-profile record 🙂' }], 'retained record'))
  const request = { mode: 'local' as const, storageScope: view.storageScope!, expectedRevision: view.revision, commandId: 'first-profile-move', directory: join(root, 'moved') }
  if (externalChange) {
    await port.set('framework-settings/local', { ...before, revision: 'external-revision', settings: { ...before.settings, userName: 'external-user' } })
    await assert.rejects(service.moveRecords(request), /Local settings changed outside/)
    assert.equal((await port.get<any>('framework-settings/local')).settings.userName, 'external-user')
    assert.equal((await port.get<any>(recordMoveKey)).receipts[0].phase, 'published')
  } else {
    const moved = await service.moveRecords(request)
    assert.equal(moved.storageScope, view.storageScope)
    assert.equal(moved.settings.localDirectory, join(root, 'moved', 'deepseek_servant', 'framework'))
    assert.deepEqual(internal.saved.get('local'), await port.get('framework-settings/local'))
    assert.equal((await service.readFile({ mode: 'local', storageScope: view.storageScope, path: 'archives/kept/records.md' })).text, 'Exact first-profile record 🙂')
    await service.moveRecords(request); assert.equal(stops, 1)
    assert.equal((await port.get<any>(recordMoveKey)).receipts[0].phase, 'applied')
  }
})
