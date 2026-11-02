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


test('held explicit Git configure cannot block Local send admission or its real saved message', async t => {
  const { service, local } = await fixture(t), internal = service as any
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), open = internal.open.bind(internal)
  internal.open = async (mode: string, signal: AbortSignal) => { if (mode !== 'git') return open(mode, signal); entered.resolve(); await release.promise; throw new Error('held Git fixture released') }
  const configuring = service.configure({ mode: 'git', commandId: 'held-git', expectedRevision: 'git-settings', settings: { ...settings, workspace: '/new-git-workspace' } }).catch(() => {})
  await entered.promise
  let admitted = false; const sendStored = internal.sendStored.bind(internal)
  internal.sendStored = (...args: any[]) => { admitted = true; return sendStored(...args) }
  const sending = service.send({ ...input('local', 'independent-local'), recipient: 'human' })
  try {
    await new Promise(resolve => setImmediate(resolve))
    const admittedWhileHeld = admitted
    if (!admittedWhileHeld) release.resolve() // Let the red baseline unwind without a timeout.
    await sending
    const access = await internal.access('local')
    assert.equal((await access.conversation.page(20)).messages[0].id, 'independent-local')
    assert.equal(admittedWhileHeld, true, 'global configuration queue blocked Local admission')
    const localOwner = internal.running.get('local')
    const updated = await service.foregroundModel({ mode: 'local', storageScope: 'local', commandId: 'local-model-during-git', expectedRevision: 'local-settings', model: { provider: 'p', model: 'local-new' } })
    assert.equal(updated.settings.foreground?.model, 'local-new')
    assert.equal(internal.running.get('local'), localOwner)
    release.resolve(); await configuring
  } finally { release.resolve(); await configuring; await sending }
})

test('Git background withdrawal response performs no access read and leaves prior pure access available', async t => {
  const { service } = await fixture(t), internal = service as any, access = internal.access.bind(internal)
  const prior = await access('git'); let accesses = 0
  internal.access = (mode: string) => { if (mode === 'git') accesses++; return access(mode) }
  const stopped = await service.participation({ mode: 'git', enabled: false })
  assert.equal(stopped.connection.participating, false)
  assert.equal(accesses, 0, 'stop response reopened frontend reads')
  assert.equal(await access('git'), prior)
  await service.send({ ...input('git', 'after-background-stop'), recipient: 'human' })
  assert.equal((await prior.conversation.page(20)).messages[0].id, 'after-background-stop')
})

test('same settings command remains exclusive across modes and method signatures without blocking unrelated mode work', async t => {
  const { service, storage } = await fixture(t), internal = service as any
  const held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), set = storage.set.bind(storage)
  let commandWrites = 0
  storage.set = async (key, value) => { if (key.startsWith('framework-settings-commands/')) { commandWrites++; if (commandWrites === 1) { held.resolve(); await release.promise } }; await set(key, value) }
  const local = service.foregroundModel({ mode: 'local', commandId: 'same-command', expectedRevision: 'local-settings', model: { provider: 'p', model: 'local-choice' } })
  await held.promise
  const conflicting = service.configure({ mode: 'git', commandId: 'same-command', expectedRevision: 'git-settings', settings: { ...settings, name: 'Must not save' } }).then(() => false, error => /identity changed/.test(String(error)))
  try {
    await new Promise(resolve => setImmediate(resolve)); assert.equal(commandWrites, 1)
    release.resolve(); await local; assert.equal(await conflicting, true)
    assert.equal(internal.saved.get('git').revision, 'git-settings')
    assert.equal(commandWrites, 2, 'only original command prepare and confirm may write')
  } finally { release.resolve(); await Promise.allSettled([local, conflicting]) }
})

test('record move drains already registered mode work and gates later mode work until its owned boundary completes', async t => {
  const { service } = await fixture(t), internal = service as any
  const gitEntered = Promise.withResolvers<void>(), releaseGit = Promise.withResolvers<void>(), moveEntered = Promise.withResolvers<void>(), releaseMove = Promise.withResolvers<void>()
  const open = internal.open.bind(internal), events: string[] = []
  internal.open = async (mode: string, signal: AbortSignal) => { if (mode !== 'git') return open(mode, signal); gitEntered.resolve(); await releaseGit.promise; events.push('git-settled'); throw new Error('Git declined') }
  const git = service.configure({ mode: 'git', commandId: 'before-move', expectedRevision: 'git-settings', settings: { ...settings, workspace: '/new-git' } }).catch(() => {})
  await gitEntered.promise
  internal.recordMover = { receipt: async () => ({ scope: 'local', settingsBefore: { revision: 'local-settings' }, targetRecords: '/target' }), run: async () => { events.push('move-entered'); moveEntered.resolve(); await releaseMove.promise; events.push('move-settled') } }
  const moving = service.moveRecords({ mode: 'local', storageScope: 'local', expectedRevision: 'local-settings', commandId: 'move', directory: '/target' })
  const sendStored = internal.sendStored.bind(internal)
  internal.sendStored = (...args: any[]) => { events.push('send-entered'); return sendStored(...args) }
  const sending = service.send({ ...input('local', 'after-move'), recipient: 'human' })
  try {
    await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(events, [])
    releaseGit.resolve(); await moveEntered.promise
    assert.deepEqual(events, ['git-settled', 'move-entered'])
    releaseMove.resolve(); await moving; await sending
    assert.deepEqual(events, ['git-settled', 'move-entered', 'move-settled', 'send-entered'])
  } finally { releaseGit.resolve(); releaseMove.resolve(); await Promise.allSettled([git, moving, sending]) }
})

test('dispose cancels Git owner first and drains independent Local operation plus queued work without late admission', async t => {
  const { service } = await fixture(t), internal = service as any
  const gitEntered = Promise.withResolvers<void>(), gitAborted = Promise.withResolvers<void>(), localEntered = Promise.withResolvers<void>(), releaseLocal = Promise.withResolvers<void>()
  const open = internal.open.bind(internal)
  internal.open = async (mode: string, signal: AbortSignal) => {
    if (mode !== 'git') return open(mode, signal)
    gitEntered.resolve(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); gitAborted.resolve(); throw signal.reason
  }
  const git = service.configure({ mode: 'git', commandId: 'disposing-git', expectedRevision: 'git-settings', settings: { ...settings, workspace: '/new-git' } }).catch(() => {})
  await gitEntered.promise
  let admissions = 0
  internal.sendStored = async () => { admissions++; localEntered.resolve(); await releaseLocal.promise; return { id: 'owned-local' } }
  const first = service.send({ ...input('local', 'before-dispose'), recipient: 'human' })
  await localEntered.promise
  const queued = service.send({ ...input('local', 'must-not-start'), recipient: 'human' }).then(() => false, error => /disposed/.test(String(error)))
  let disposed = false; const disposal = service.dispose().then(() => { disposed = true })
  try {
    await gitAborted.promise; assert.equal(disposed, false)
    releaseLocal.resolve(); await first; assert.equal(await queued, true); await disposal; await git
    assert.equal(admissions, 1)
  } finally { releaseLocal.resolve(); await Promise.allSettled([first, queued, git, disposal]) }
})

test('untrusted mode cannot create a third operation lane or reach storage access', async t => {
  const { service } = await fixture(t), internal = service as any
  let reads = 0; internal.access = () => { reads++; throw new Error('invalid mode reached access') }
  for (const mode of ['unknown-mode', '', '__proto__']) {
    await assert.rejects(service.send({ ...input('local', 'invalid'), mode } as any), /Invalid option/)
    await assert.rejects(service.legacyControl({ mode, commandId: 'invalid', migrationId: 'migration', oldTaskId: 'task', action: 'resume' } as any), /Invalid option/)
  }
  assert.equal(reads, 0); assert.equal(internal.modeConfiguration.size, 0); assert.equal(internal.settingsCommands.size, 0)
})

test('conflicting cross-mode command waits its exact pending identity before it can cancel a valid Git owner', async t => {
  const { service, storage } = await fixture(t), internal = service as any
  const gitEntered = Promise.withResolvers<void>(), releaseGit = Promise.withResolvers<void>(), localReceiptEntered = Promise.withResolvers<void>(), releaseLocalReceipt = Promise.withResolvers<void>()
  const open = internal.open.bind(internal), set = storage.set.bind(storage)
  let gitSignal: AbortSignal | undefined
  internal.open = async (mode: string, signal: AbortSignal) => {
    if (mode !== 'git') return open(mode, signal)
    gitSignal = signal; gitEntered.resolve(); await releaseGit.promise; signal.throwIfAborted(); return open(mode, signal)
  }
  storage.set = async (key, value) => {
    const command = value as { signature?: string; confirmed?: boolean }
    if (key.startsWith('framework-settings-commands/') && command.signature?.startsWith('["foreground-model","local"') && !command.confirmed) {
      localReceiptEntered.resolve(); await releaseLocalReceipt.promise
    }
    await set(key, value)
  }
  const validGit = service.configure({ mode: 'git', commandId: 'valid-y', expectedRevision: 'git-settings', settings: { ...settings, workspace: '/valid-git' } })
  const validOutcome = validGit.then(() => true, () => false)
  await gitEntered.promise
  const local = service.foregroundModel({ mode: 'local', commandId: 'collision-x', expectedRevision: 'local-settings', model: { provider: 'p', model: 'local-x' } })
  await localReceiptEntered.promise
  const conflicting = service.configure({ mode: 'git', commandId: 'collision-x', settings: { ...settings, workspace: '/invalid-git' } }).then(() => false, error => /identity changed/.test(String(error)))
  try {
    await new Promise(resolve => setImmediate(resolve))
    const cancelledBeforeIdentityWasKnown = gitSignal!.aborted
    releaseLocalReceipt.resolve(); await local
    await new Promise(resolve => setImmediate(resolve))
    const cancelledAfterIdentityWasKnown = gitSignal!.aborted
    releaseGit.resolve()
    assert.equal(await conflicting, true)
    assert.equal(cancelledBeforeIdentityWasKnown, false, 'invalid request cancelled owner before its prior same-command receipt existed')
    assert.equal(cancelledAfterIdentityWasKnown, false)
    assert.equal(await validOutcome, true)
    assert.equal(internal.saved.get('git').settings.workspace, '/valid-git')
  } finally { releaseLocalReceipt.resolve(); releaseGit.resolve(); await Promise.allSettled([validOutcome, local, conflicting]) }
})

test('a valid new command can still cancel held same-mode connection without waiting for it to finish', async t => {
  const { service } = await fixture(t), internal = service as any
  const entered = Promise.withResolvers<void>(), cancelled = Promise.withResolvers<void>(), open = internal.open.bind(internal)
  let attempts = 0
  internal.open = async (mode: string, signal: AbortSignal) => {
    if (mode !== 'git' || ++attempts > 1) return open(mode, signal)
    entered.resolve(); await new Promise<void>(resolve => signal.addEventListener('abort', () => { cancelled.resolve(); resolve() }, { once: true })); throw signal.reason
  }
  const old = service.configure({ mode: 'git', commandId: 'old-command', expectedRevision: 'git-settings', settings: { ...settings, workspace: '/old' } }).then(() => false, error => error instanceof Error && error.name === 'AbortError')
  await entered.promise
  const next = service.configure({ mode: 'git', commandId: 'new-command', expectedRevision: internal.saved.get('git').revision, settings: { ...settings, workspace: '/new' } })
  await cancelled.promise
  assert.equal(await old, true)
  assert.equal((await next).settings.workspace, '/new'); assert.equal(attempts, 2)
})

test('same-command replay behind held own connection does not self-cancel or open another generation', async t => {
  const { service } = await fixture(t), internal = service as any
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), open = internal.open.bind(internal)
  let signal: AbortSignal | undefined, attempts = 0
  internal.open = async (mode: string, owner: AbortSignal) => { if (mode !== 'git') return open(mode, owner); attempts++; signal = owner; entered.resolve(); await release.promise; owner.throwIfAborted(); return open(mode, owner) }
  const request = { mode: 'git' as const, commandId: 'same-owner', expectedRevision: 'git-settings', settings: { ...settings, workspace: '/same-owner' } }
  const first = service.configure(request)
  await entered.promise
  const replay = service.configure(request)
  try {
    await new Promise(resolve => setImmediate(resolve)); assert.equal(signal!.aborted, false)
    release.resolve(); const [a, b] = await Promise.all([first, replay])
    assert.equal(a.revision, b.revision); assert.equal(attempts, 1)
  } finally { release.resolve(); await Promise.allSettled([first, replay]) }
})
